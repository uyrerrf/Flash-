'use strict';
/**
 * NexusWS — WebSocket client
 *   - Exponential backoff reconnect (1s → 30s + jitter)
 *   - Binary frame support (HVNC JPEG)
 *   - Operator ping/pong keepalive every 20s
 *   - Page Visibility API — instant reconnect on tab focus
 *   - Connection quality tracker (RTT)
 */
class NexusWS {
  constructor(url, { onOpen, onClose, onMessage, onBinary } = {}) {
    this._url       = url;
    this._onOpen    = onOpen    || (() => {});
    this._onClose   = onClose   || (() => {});
    this._onMessage = onMessage || (() => {});
    this._onBinary  = onBinary  || (() => {});

    this._ws        = null;
    this._delay     = 1000;
    this._timer     = null;
    this._pingTimer = null;
    this._dead      = false;
    this._rtt       = 0;
    this._lastPingSent = 0;

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (!this._ws || this._ws.readyState > 1)) {
        this._resetDelay();
        this.connect();
      }
    });

    // Reconnect on network recovery
    window.addEventListener('online', () => {
      if (!this._ws || this._ws.readyState > 1) {
        this._resetDelay();
        this.connect();
      }
    });

    this.connect();
  }

  connect() {
    if (this._dead) return;
    clearTimeout(this._timer);

    try {
      const ws = new WebSocket(this._url);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      ws.onopen = () => {
        this._resetDelay();
        this._startPing();
        this._onOpen();
      };

      ws.onmessage = e => {
        if (e.data instanceof ArrayBuffer) {
          this._onBinary(e.data);
        } else {
          try {
            const msg = JSON.parse(e.data);
            // Handle pong for RTT calculation
            if (msg.type === 'pong_op' && this._lastPingSent) {
              this._rtt = Date.now() - this._lastPingSent;
              this._lastPingSent = 0;
            }
            this._onMessage(msg);
          } catch {}
        }
      };

      ws.onclose = () => {
        this._stopPing();
        this._onClose();
        this._scheduleReconnect();
      };

      ws.onerror = () => {};

    } catch {
      this._scheduleReconnect();
    }
  }

  sendJson(obj) {
    if (this._ws?.readyState === 1) {
      try { this._ws.send(JSON.stringify(obj)); } catch {}
    }
  }

  get rtt() { return this._rtt; }
  get readyState() { return this._ws?.readyState ?? 3; }

  destroy() {
    this._dead = true;
    clearTimeout(this._timer);
    this._stopPing();
    this._ws?.close();
    this._ws = null;
  }

  _scheduleReconnect() {
    clearTimeout(this._timer);
    const d = this._delay;
    this._delay = Math.min(this._delay * 1.8, 30_000);
    // Add jitter to prevent thundering herd
    this._timer = setTimeout(() => this.connect(), d + Math.random() * 800);
  }

  _resetDelay() { this._delay = 1000; }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === 1) {
        this._lastPingSent = Date.now();
        this._ws.send(JSON.stringify({ type: 'ping_op' }));
      }
    }, 20_000);
  }

  _stopPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }
}
