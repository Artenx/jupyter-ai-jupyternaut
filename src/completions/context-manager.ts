import { JupyterFrontEnd } from '@jupyterlab/application';
import { PathExt } from '@jupyterlab/coreutils';
import { KernelMessage } from '@jupyterlab/services';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';

import type { AiCompleterService as AiService } from './types';
type RuntimeVariable = AiService.RuntimeVariable;

export interface IInlineNotebookContext {
  variables: RuntimeVariable[];
  files: string[];
}

/**
 * Caches small, per-notebook runtime summaries for inline completions.
 * Introspection is refreshed after an executed cell returns to idle, never on
 * each keystroke, so completion requests never wait for a busy kernel.
 */
export class JaiCompletionContextManager {
  private _contexts = new Map<string, IInlineNotebookContext>();
  private _initialized = new WeakSet<NotebookPanel>();
  private _dirtyNotebooks = new Set<string>();
  private _initialRefreshPending = new Set<string>();

  constructor(
    private _app: JupyterFrontEnd,
    private _notebookTracker: INotebookTracker
  ) {
    if (this._notebookTracker.currentWidget) {
      void this._initializeNotebook(this._notebookTracker.currentWidget);
    }
    this._notebookTracker.currentChanged.connect(this._onCurrentChanged, this);
  }

  getNotebookContext(notebookId: string): IInlineNotebookContext | undefined {
    const context = this._contexts.get(notebookId);
    if (!context) {
      return undefined;
    }
    return {
      variables: context.variables.map(variable => ({ ...variable })),
      files: [...context.files]
    };
  }

  private _onCurrentChanged(
    _sender: INotebookTracker,
    notebook: NotebookPanel | null
  ): void {
    if (notebook) {
      void this._initializeNotebook(notebook);
    }
  }

  private async _initializeNotebook(notebook: NotebookPanel): Promise<void> {
    if (!this._contexts.has(notebook.id)) {
      this._contexts.set(notebook.id, { variables: [], files: [] });
    }
    void this._refreshFiles(notebook);
    if (this._initialized.has(notebook)) {
      return;
    }
    this._initialized.add(notebook);
    this._initialRefreshPending.add(notebook.id);

    const sessionContext = notebook.context.sessionContext;
    sessionContext.statusChanged.connect((_sender, status) => {
      if (
        status === 'restarting' ||
        status === 'terminating' ||
        status === 'unknown'
      ) {
        this._updateVariables(notebook.id, []);
        this._dirtyNotebooks.delete(notebook.id);
        this._initialRefreshPending.add(notebook.id);
        return;
      }
      if (
        status === 'idle' &&
        (this._dirtyNotebooks.has(notebook.id) ||
          this._initialRefreshPending.has(notebook.id))
      ) {
        // Clear first so the silent introspection request cannot recursively
        // mark the notebook dirty or schedule another refresh.
        this._dirtyNotebooks.delete(notebook.id);
        this._initialRefreshPending.delete(notebook.id);
        void this._refreshVariables(notebook);
        void this._refreshFiles(notebook);
      }
    });

    sessionContext.iopubMessage.connect(
      (_sender, message: KernelMessage.IMessage) => {
        if (message.header.msg_type === 'execute_input') {
          this._dirtyNotebooks.add(notebook.id);
        }
      }
    );

    notebook.disposed.connect(() => {
      this._contexts.delete(notebook.id);
      this._dirtyNotebooks.delete(notebook.id);
      this._initialRefreshPending.delete(notebook.id);
    });

    // On opening a notebook with an existing kernel, capture its initial state
    // once. Later updates are batched until user execution returns to idle.
    try {
      await sessionContext.ready;
      if (sessionContext.session?.kernel?.status === 'idle') {
        this._initialRefreshPending.delete(notebook.id);
        void this._refreshVariables(notebook);
      }
    } catch {
      // No kernel or a restarting kernel leaves the cache empty.
    }
  }

  private _updateVariables(
    notebookId: string,
    variables: RuntimeVariable[]
  ): void {
    const context = this._contexts.get(notebookId) ?? {
      variables: [],
      files: []
    };
    context.variables = variables;
    this._contexts.set(notebookId, context);
  }

  private _updateFiles(notebookId: string, files: string[]): void {
    const context = this._contexts.get(notebookId) ?? {
      variables: [],
      files: []
    };
    context.files = files;
    this._contexts.set(notebookId, context);
  }

  private async _refreshFiles(notebook: NotebookPanel): Promise<void> {
    const directory = PathExt.dirname(notebook.context.path);
    try {
      const contents = await this._app.serviceManager.contents.get(directory);
      if (contents.type !== 'directory') {
        this._updateFiles(notebook.id, []);
        return;
      }
      const content = contents.content as Array<{ name: string }>;
      const files = content
        .filter((item: { name: string }) => {
          const extension = item.name.split('.').pop()?.toLowerCase();
          return ['csv', 'xlsx', 'xls', 'xlsm'].includes(extension ?? '');
        })
        .slice(0, 30)
        .map((item: { name: string }) => item.name.slice(0, 160));
      this._updateFiles(notebook.id, files);
    } catch {
      this._updateFiles(notebook.id, []);
    }
  }

  private async _refreshVariables(notebook: NotebookPanel): Promise<void> {
    const kernel = notebook.context.sessionContext.session?.kernel;
    if (!kernel) {
      this._updateVariables(notebook.id, []);
      return;
    }
    const future = kernel.requestExecute({
      code: RUNTIME_CONTEXT_SCRIPT,
      silent: true,
      store_history: false
    });
    let output = '';
    future.onIOPub = (message: KernelMessage.IMessage) => {
      if (
        KernelMessage.isStreamMsg(message) &&
        message.content.name === 'stdout'
      ) {
        output += message.content.text;
      }
    };
    try {
      await future.done;
      const variables = JSON.parse(output.trim()) as RuntimeVariable[];
      this._updateVariables(
        notebook.id,
        Array.isArray(variables) ? variables : []
      );
    } catch {
      // Introspection is best-effort; it must never block editing/completion.
      this._updateVariables(notebook.id, []);
    }
  }
}

/**
 * Return only names, types and DataFrame schemas. No row values or reprs are
 * collected; pandas is inspected only if it is already loaded in the kernel.
 */
const RUNTIME_CONTEXT_SCRIPT = `
import json as _json
import sys as _sys

_context = []
_pandas = _sys.modules.get("pandas")
_dataframe_type = getattr(_pandas, "DataFrame", None) if _pandas else None
for _name, _value in list(globals().items()):
    if not isinstance(_name, str) or _name.startswith("_") or _name in ("In", "Out", "get_ipython"):
        continue
    if callable(_value) or isinstance(_value, type) or type(_value).__name__ == "module":
        continue
    _module = type(_value).__module__
    _kind = type(_value).__name__
    if _dataframe_type and isinstance(_value, _dataframe_type):
        _columns = [str(_column)[:80] for _column in _value.columns[:15]]
        _dtypes = {}
        for _column in _value.columns[:15]:
            try:
                _dtypes[str(_column)[:80]] = str(_value[_column].dtype)[:40]
            except Exception:
                pass
        _context.append({"name": _name[:100], "type": "DataFrame", "shape": [int(x) for x in _value.shape], "columns": _columns, "dtypes": _dtypes})
    elif _module.startswith("polars") and hasattr(_value, "columns"):
        _columns = [str(_column)[:80] for _column in _value.columns[:15]]
        _schema = getattr(_value, "schema", {})
        _dtypes = {str(k)[:80]: str(v)[:40] for k, v in list(_schema.items())[:15]} if hasattr(_schema, "items") else {}
        _shape = getattr(_value, "shape", None)
        _context.append({"name": _name[:100], "type": "DataFrame", "shape": [int(x) for x in _shape] if _shape else [], "columns": _columns, "dtypes": _dtypes})
    else:
        _context.append({"name": _name[:100], "type": _kind[:100]})
    if len(_context) >= 40:
        break
_payload = _json.dumps(_context, ensure_ascii=False)
while len(_payload) > 8000 and _context:
    _context.pop()
    _payload = _json.dumps(_context, ensure_ascii=False)
print(_payload)
`;
