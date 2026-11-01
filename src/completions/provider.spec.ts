jest.mock('@jupyterlab/completer', () => ({
  InlineCompletionTriggerKind: { Automatic: 'automatic', Invoke: 'invoke' }
}));
jest.mock('@jupyterlab/apputils', () => ({
  Notification: { emit: jest.fn() },
  showErrorMessage: jest.fn()
}));
jest.mock('@jupyterlab/notebook', () => ({
  NotebookPanel: class NotebookPanel {}
}));
jest.mock('@jupyterlab/docregistry', () => ({
  DocumentWidget: class DocumentWidget {}
}));
jest.mock('../icons', () => ({
  jupyternautIcon: { bindprops: jest.fn(() => ({})) }
}));

import { InlineCompletionTriggerKind } from '@jupyterlab/completer';
import { NotebookPanel } from '@jupyterlab/notebook';
import { Signal } from '@lumino/signaling';

import { JaiInlineProvider } from './provider';

describe('JaiInlineProvider', () => {
  it('sends bounded code and cached runtime metadata for the active notebook', async () => {
    const sendMessage = jest.fn().mockResolvedValue({
      type: 'inline_completion',
      reply_to: 1,
      list: { items: [] }
    });
    const completionHandler = {
      streamed: new Signal({} as any),
      sendMessage
    } as any;
    const languageRegistry = {
      findByMIME: jest.fn(() => ({ name: 'python', displayName: 'Python' })),
      getLanguages: jest.fn(() => [{ name: 'python', displayName: 'Python' }])
    } as any;
    const runtimeContext = {
      variables: [
        {
          name: 'df_sales',
          type: 'DataFrame',
          shape: [10, 2],
          columns: ['order_id', 'amount'],
          dtypes: { amount: 'float64' }
        }
      ],
      files: ['sales.csv']
    };
    const getNotebookContext = jest.fn(() => runtimeContext);
    const provider = new JaiInlineProvider({
      completionHandler,
      languageRegistry,
      contextManager: { getNotebookContext } as any
    });
    const widget = Object.assign(new NotebookPanel({} as any), {
      id: 'panel-1',
      content: { activeCell: { model: { id: 'cell-1' } } }
    });
    await provider.configure({
      enabled: true,
      triggerKind: 'any',
      maxPrefix: 4,
      maxSuffix: 3,
      disabledLanguages: [],
      debouncerDelay: 250,
      streaming: 'never'
    });

    await provider.fetch(
      { text: 'abcdefghijXYZ', offset: 10, mimeType: 'text/x-python' } as any,
      {
        triggerKind: InlineCompletionTriggerKind.Automatic,
        session: { path: 'notebooks/example.ipynb' },
        widget
      } as any
    );

    expect(sendMessage).toHaveBeenCalledWith({
      mime: 'text/x-python',
      prefix: 'ghij',
      suffix: 'XYZ',
      language: 'python',
      number: 1,
      stream: false,
      variables: runtimeContext.variables,
      files: runtimeContext.files
    });
    expect(getNotebookContext).toHaveBeenCalledWith('panel-1');
  });

  it('does not request a completion while disabled', async () => {
    const sendMessage = jest.fn();
    const completionHandler = {
      streamed: new Signal({} as any),
      sendMessage
    } as any;
    const languageRegistry = {
      findByMIME: jest.fn(() => ({ name: 'python', displayName: 'Python' })),
      getLanguages: jest.fn(() => [{ name: 'python', displayName: 'Python' }])
    } as any;
    const provider = new JaiInlineProvider({
      completionHandler,
      languageRegistry,
      contextManager: { getNotebookContext: jest.fn(() => undefined) } as any
    });

    await provider.configure({
      enabled: false,
      triggerKind: 'any',
      maxPrefix: 100,
      maxSuffix: 100,
      disabledLanguages: [],
      debouncerDelay: 250,
      streaming: 'never'
    });

    const result = await provider.fetch(
      { text: 'x', offset: 1, mimeType: 'text/x-python' } as any,
      { triggerKind: InlineCompletionTriggerKind.Automatic } as any
    );
    expect(result.items).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
