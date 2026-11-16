class MessageHandler {
  #allowedOrigin;
  #stateManager;
  #allowedKeys;

  constructor({ allowedOrigin, stateManager }) {
    this.#allowedOrigin = allowedOrigin;
    this.#stateManager = stateManager;
    
    // Assume stateManager implements snapshot
    this.#allowedKeys = new Set(Object.keys(stateManager.snapshot() || {}));

    // Bind the handler so 'this' remains correct when window triggers the event
    this.handleMessage = this.handleMessage.bind(this);
  }

  /**
   * Starts listening for postMessage events
   */
  connect() {
    window.addEventListener('message', this.handleMessage);
    console.debug(`[PostMessageReceiver] Listening for messages from ${this.#allowedOrigin}`);
  }

  /**
   * Stops listening (critical for avoiding memory leaks)
   */
  disconnect() {
    window.removeEventListener('message', this.handleMessage);
    console.debug('[MessageReceiver] Stopped listening');
  }

  /**
   * Core message handler (JSON-RPC 2.0)
   */
  async handleMessage(event) {
    if (event.origin !== this.#allowedOrigin) return;
    
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;

    const isNotification = msg.id === undefined;

    // Helper functions for RPC responses
    const reply = (result) => {
      if (!isNotification) {
        event.source.postMessage({ jsonrpc: '2.0', id: msg.id, result }, event.origin);
      }
    };

    const replyError = (code, message) => {
      if (!isNotification) {
        event.source.postMessage({ jsonrpc: '2.0', id: msg.id, error: { code, message } }, event.origin);
      }
    };

    try {
      switch (msg.method) {
        case 'ping': {
          reply('pong');
          break;
        }

        case 'getState': {
          const { key } = msg.params || {};
          reply(this.#stateManager.get(key));
          break;
        }

        case 'setState': {
          const { key, value } = msg.params || {};
          if (!this.#isValidKey(key)) {
            return replyError(-32602, `Unknown state key: "${key}"`);
          }
          this.#stateManager.set(key, value);
          reply({ ok: true, key });
          break;
        }

        case 'applyUpdates': {
          this.#stateManager.applyUpdates(msg.params);
          reply({ ok: true });
          break;
        }

        case 'loadBlob': {
          const { key, blob, filename, mimeType } = msg.params || {};
          if (!this.#isValidKey(key)) {
            return replyError(-32602, `Unknown state key: "${key}"`);
          }
          const file = new File([blob], filename, { type: mimeType });
          this.#stateManager.set(key, file);
          reply({ ok: true, key, filename, size: blob.size });
          break;
        }

        default:
          replyError(-32601, `Method not found: "${msg.method}"`);
      }
    } catch (err) {
      replyError(-32603, err.message ?? String(err));
    }
  }

  // Internal validation helper
  #isValidKey(key) {
    // Basic structural validation check
    return this.#allowedKeys.has(key) || this.#allowedKeys.has(key?.split('.')[0]);
  }
}
