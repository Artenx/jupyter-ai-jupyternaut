import { IDisposable } from '@lumino/disposable';
import { PromiseDelegate } from '@lumino/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { URLExt } from '@jupyterlab/coreutils';
import { AiCompleterService as AiService } from './types';
import { Signal, ISignal } from '@lumino/signaling';

const SERVICE_URL = 'api/ai/completion/inline';

type StreamChunk = AiService.InlineCompletionStreamChunk;

type PendingReply = {
  resolve: (value: AiService.InlineCompletionReply) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const CONNECTION_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

export class CompletionWebsocketHandler implements IDisposable {
  /**
   * The server settings used to make API requests.
   */
  readonly serverSettings: ServerConnection.ISettings;

  /**
   * Create a new completion handler.
   */
  constructor(options: AiService.IOptions = {}) {
    this.serverSettings =
      options.serverSettings ?? ServerConnection.makeSettings();
  }

  /**
   * Initializes the WebSocket connection to the completion backend. Promise is
   * resolved when server acknowledges connection and sends the client ID. This
   * must be awaited before calling any other method.
   */
  public async initialize(): Promise<void> {
    await this._initialize();
  }

  /**
   * Sends a message across the WebSocket. Promise resolves to the message ID
   * when the server sends the same message back, acknowledging receipt.
   */
  public sendMessage(
    message: AiService.InlineCompletionRequest
  ): Promise<AiService.InlineCompletionReply> {
    if (this.isDisposed || !this._socket || this._socket.readyState !== 1) {
      return Promise.reject(
        new Error('Inline completion websocket is not connected')
      );
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete this._replyForResolver[message.number];
        reject(new Error('Inline completion request timed out'));
      }, REQUEST_TIMEOUT_MS);
      // Register before sending: a fast backend can reply in the next task turn.
      this._replyForResolver[message.number] = { resolve, reject, timeout };
      try {
        this._socket!.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeout);
        delete this._replyForResolver[message.number];
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Signal emitted when a new chunk of completion is streamed.
   */
  get streamed(): ISignal<CompletionWebsocketHandler, StreamChunk> {
    return this._streamed;
  }

  /**
   * Whether the completion handler is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose the completion handler.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;

    this._rejectPending(new Error('Inline completion websocket was disposed'));
    // Clean up socket.
    const socket = this._socket;
    if (socket) {
      this._socket = null;
      socket.onopen = () => undefined;
      socket.onerror = () => undefined;
      socket.onmessage = () => undefined;
      socket.onclose = () => undefined;
      socket.close();
    }
  }

  private _onMessage(message: AiService.CompleterMessage): void {
    switch (message.type) {
      case 'connection': {
        this._initialized.resolve();
        break;
      }
      case 'stream': {
        this._streamed.emit(message);
        break;
      }
      default: {
        const pending = this._replyForResolver[message.reply_to];
        if (pending) {
          clearTimeout(pending.timeout);
          delete this._replyForResolver[message.reply_to];
          pending.resolve(message);
        } else {
          console.warn('Unhandled inline completion reply', message);
        }
        break;
      }
    }
  }

  /**
   * Dictionary mapping message IDs to Promise resolvers.
   */
  private _replyForResolver: Record<number, PendingReply> = {};

  private _onClose(e: CloseEvent, reject: (reason: unknown) => void) {
    const error = new Error('Inline completion websocket disconnected');
    reject(error);
    this._rejectPending(error);
    if (this._isDisposed) {
      return;
    }
    // Only attempt reconnect after an abnormal close (RFC 6455 code 1006).
    if (e.code === 1006) {
      setTimeout(() => {
        void this._initialize().catch(reason =>
          console.error(
            'Failed to reconnect inline completion websocket.',
            reason
          )
        );
      }, 1000);
    }
  }

  private _rejectPending(error: Error): void {
    for (const request of Object.values(this._replyForResolver)) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this._replyForResolver = {};
  }

  private async _initialize(): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    const promise = new PromiseDelegate<void>();
    this._initialized = promise;
    const { token, WebSocket, wsUrl } = this.serverSettings;
    const url =
      URLExt.join(wsUrl, SERVICE_URL) +
      (token ? `?token=${encodeURIComponent(token)}` : '');

    const socket = (this._socket = new WebSocket(url));
    const timeout = setTimeout(
      () =>
        promise.reject(
          new Error('Inline completion websocket handshake timed out')
        ),
      CONNECTION_TIMEOUT_MS
    );
    socket.onclose = e => this._onClose(e, promise.reject.bind(promise));
    socket.onerror = () =>
      promise.reject(
        new Error('Inline completion websocket connection failed')
      );
    socket.onmessage = msg => {
      if (!msg.data) {
        return;
      }
      try {
        this._onMessage(JSON.parse(msg.data));
      } catch (error) {
        console.error(
          'Invalid message from inline completion websocket.',
          error
        );
      }
    };
    try {
      await promise.promise;
    } finally {
      clearTimeout(timeout);
    }
  }

  private _isDisposed = false;
  private _socket: WebSocket | null = null;
  private _streamed = new Signal<CompletionWebsocketHandler, StreamChunk>(this);
  private _initialized: PromiseDelegate<void> = new PromiseDelegate<void>();
}
