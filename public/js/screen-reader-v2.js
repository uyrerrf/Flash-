'use strict';
/**
 * ScreenReaderV2 — Full hierarchy panel with live tree, OCR stream, node inspector & EDITAR V2 mode.
 *
 * Usage (hvnc.js injects this):
 *   const sr = new ScreenReaderV2(deviceId, sendFn);
 *   sr.open();   // mount panel
 *   sr.close();  // unmount panel
 *   sr.destroy();
 *
 * Listens to:  document CustomEvent 'nx:hierarchy' → { detail: { id, data: jsonString } }
 * Sends via sendFn:
 *   { type:'cmd', target:deviceId, cmd:'REQUEST_HIERARCHY',       args:{} }
 *   { type:'cmd', target:deviceId, cmd:'TOGGLE_SCREEN_READER',    args:{ enabled:bool } }
 *   { type:'cmd', target:deviceId, cmd:'PERFORM_NODE_ACTION',     args:{ action, bx, by, bw, bh, text } }
 */

(function (global) {

  // ── CSS ──────────────────────────────────────────────────────────────────────
  const CSS = `
.sr2-overlay {
  position:fixed; inset:0; background:rgba(4,4,14,.97); z-index:9999;
  display:flex; flex-direction:column; font-family:'JetBrains Mono',monospace,sans-serif;
  font-size:12px; color:#c8c8e0; overflow:hidden;
}
.sr2-header {
  display:flex; align-items:center; gap:8px; padding:6px 12px;
  background:#07071a; border-bottom:1px solid #14142a; flex-shrink:0;
}
.sr2-pkg { font-size:11px; color:#555; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sr2-ts  { font-size:10px; color:#333; }
.sr2-badge { font-size:10px; padding:1px 6px; border-radius:3px; font-weight:700; }
.sr2-badge-live { background:#0d2d1a; color:#3dba7a; border:1px solid #1e5c38; }
.sr2-badge-off  { background:#1a1a2e; color:#444;    border:1px solid #2a2a40; }

/* toolbar */
.sr2-toolbar {
  display:flex; align-items:center; gap:6px; padding:5px 12px;
  background:#090920; border-bottom:1px solid #14142a; flex-shrink:0; flex-wrap:wrap;
}
.sr2-btn {
  background:#0e0e22; border:1px solid #1e1e38; color:#7070a0;
  border-radius:4px; padding:3px 10px; font-size:11px; cursor:pointer;
  font-family:inherit; transition:background .1s,color .1s;
}
.sr2-btn:hover { background:#1a1a32; color:#c0c0e0; border-color:#2a2a50; }
.sr2-btn.active { background:#1a1a40; color:#7c6af7; border-color:#4a3af7; }
.sr2-btn.green  { color:#3dba7a; border-color:#1e5c38; }
.sr2-btn.green.active { background:#0d2d1a; }
.sr2-btn.red    { color:#e05050; border-color:#5c1e1e; }
.sr2-sep { width:1px; height:16px; background:#1a1a2e; margin:0 2px; }
.sr2-ocr-perc { font-size:10px; color:#7c6af7; }

/* body */
.sr2-body {
  flex:1; display:flex; overflow:hidden;
}

/* tree pane */
.sr2-tree-pane {
  width:52%; border-right:1px solid #14142a; display:flex; flex-direction:column; overflow:hidden;
}
.sr2-pane-title {
  font-size:10px; color:#333; padding:4px 10px; border-bottom:1px solid #0d0d1a;
  letter-spacing:.08em; text-transform:uppercase; flex-shrink:0;
}
.sr2-tree-scroll {
  flex:1; overflow:auto;
}
.sr2-tree-scroll::-webkit-scrollbar { width:5px; }
.sr2-tree-scroll::-webkit-scrollbar-track { background:#07070f; }
.sr2-tree-scroll::-webkit-scrollbar-thumb { background:#1e1e38; border-radius:3px; }

/* tree nodes */
.sr2-node {
  display:flex; align-items:baseline; padding:1px 0; cursor:pointer;
  border-left:2px solid transparent; transition:background .08s;
  white-space:nowrap; overflow:hidden;
}
.sr2-node:hover { background:#0d0d20; }
.sr2-node.selected { background:#10102a; border-left-color:#7c6af7; }
.sr2-node.editable-mode { border-left-color:#d4a017 !important; background:#12100a !important; }
.sr2-node-indent { display:inline-block; }
.sr2-node-toggle {
  display:inline-block; width:14px; text-align:center; color:#333; flex-shrink:0;
  font-size:10px; cursor:pointer; user-select:none;
}
.sr2-node-class {
  font-size:10px; font-weight:700; padding:0 3px; border-radius:2px; flex-shrink:0;
}
.sr2-node-text {
  color:#888; font-size:10px; overflow:hidden; text-overflow:ellipsis;
  max-width:180px; margin-left:4px; flex-shrink:1;
}
.sr2-node-flags {
  margin-left:4px; font-size:9px; color:#444; flex-shrink:0;
}
.sr2-children { display:block; }
.sr2-children.collapsed { display:none; }

/* class colors */
.sr2-c-edit   { background:#1a280a; color:#8ec050; }
.sr2-c-btn    { background:#1a1025; color:#9a7af0; }
.sr2-c-text   { background:#0a1826; color:#5ba8d8; }
.sr2-c-layout { background:#0d0d0d; color:#444; }
.sr2-c-img    { background:#1a0d1a; color:#b06cb0; }
.sr2-c-scroll { background:#1a1408; color:#c0a050; }
.sr2-c-root   { background:#07070f; color:#333; }
.sr2-c-other  { background:#0d0d1a; color:#556; }

/* inspector pane */
.sr2-inspector {
  flex:1; display:flex; flex-direction:column; overflow:hidden;
}
.sr2-inspector-scroll {
  flex:1; overflow:auto; padding:8px 12px;
}
.sr2-inspector-scroll::-webkit-scrollbar { width:4px; }
.sr2-inspector-scroll::-webkit-scrollbar-thumb { background:#1e1e38; border-radius:3px; }
.sr2-inspector-empty {
  color:#2a2a40; font-size:11px; padding:20px; text-align:center;
}
.sr2-field { margin-bottom:6px; }
.sr2-field-label { color:#444; font-size:9px; text-transform:uppercase; letter-spacing:.07em; }
.sr2-field-val {
  color:#b0b0cc; font-size:11px; word-break:break-all; margin-top:1px;
  background:#0a0a18; padding:2px 6px; border-radius:3px; border:1px solid #1a1a28;
}
.sr2-field-val.highlight { color:#7c6af7; }
.sr2-field-val.green { color:#3dba7a; }
.sr2-field-val.warn  { color:#d4a017; }
.sr2-bounds-bar {
  display:flex; gap:6px; flex-wrap:wrap;
}
.sr2-bounds-pill {
  background:#0a0a1a; border:1px solid #1a1a2e; border-radius:3px;
  padding:1px 5px; font-size:10px; color:#556;
}
.sr2-bounds-pill span { color:#9090c0; }
.sr2-states { display:flex; flex-wrap:wrap; gap:3px; margin-top:2px; }
.sr2-state {
  font-size:9px; padding:1px 5px; border-radius:3px;
  background:#0e0e20; border:1px solid #1e1e30; color:#445;
}
.sr2-state.on { background:#0d1e10; border-color:#1e3e20; color:#3dba7a; }
.sr2-actions { display:flex; flex-wrap:wrap; gap:4px; margin-top:8px; }
.sr2-act-btn {
  background:#0e0e22; border:1px solid #1e1e38; color:#7070a0;
  border-radius:4px; padding:2px 8px; font-size:10px; cursor:pointer;
  font-family:inherit;
}
.sr2-act-btn:hover { background:#1a1a32; color:#c0c0e0; border-color:#3a3a60; }
.sr2-act-btn.primary { border-color:#4a3af7; color:#7c6af7; }
.sr2-act-btn.danger  { border-color:#5c1e1e; color:#e05050; }

/* editar v2 input area */
.sr2-edit-area {
  margin-top:10px; padding:8px; background:#0a0a18;
  border:1px solid #d4a017; border-radius:4px;
}
.sr2-edit-label { font-size:9px; color:#d4a017; text-transform:uppercase; letter-spacing:.07em; margin-bottom:4px; }
.sr2-edit-input {
  width:100%; box-sizing:border-box; background:#07070f; border:1px solid #2a2a40; color:#e0e0f0;
  border-radius:3px; padding:4px 6px; font-size:11px; font-family:inherit; outline:none;
}
.sr2-edit-input:focus { border-color:#7c6af7; }
.sr2-edit-controls { display:flex; gap:4px; margin-top:4px; }

/* OCR pane */
.sr2-ocr-pane {
  flex-shrink:0; height:80px; border-top:1px solid #14142a;
  background:#07070f; display:flex; flex-direction:column; overflow:hidden;
}
.sr2-ocr-title {
  font-size:9px; color:#333; padding:2px 10px; letter-spacing:.08em; text-transform:uppercase;
  flex-shrink:0; border-bottom:1px solid #0d0d1a;
}
.sr2-ocr-content {
  flex:1; overflow:auto; padding:4px 10px; color:#557; font-size:11px;
  white-space:nowrap; cursor:default;
}
.sr2-ocr-content::-webkit-scrollbar { height:4px; }
.sr2-ocr-content::-webkit-scrollbar-thumb { background:#1e1e38; }
.sr2-ocr-token { color:#8888aa; margin-right:6px; cursor:pointer; }
.sr2-ocr-token:hover { color:#c0c0e0; }
.sr2-ocr-token.editable { color:#d4a017; }

/* close btn */
.sr2-close {
  background:none; border:none; color:#333; font-size:16px; cursor:pointer;
  padding:0 4px; line-height:1; flex-shrink:0;
}
.sr2-close:hover { color:#e05050; }
`;

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  function shortClass(full) {
    const parts = String(full || '').split('.');
    return parts[parts.length - 1] || full;
  }

  function classColor(cls) {
    const s = String(cls || '').toLowerCase();
    if (s.includes('edittext') || s.includes('textfield') || s.includes('input')) return 'sr2-c-edit';
    if (s.includes('button') || s.includes('imagebutton') || s.includes('chip')) return 'sr2-c-btn';
    if (s.includes('textview') || s.includes('text')) return 'sr2-c-text';
    if (s.includes('scroll') || s.includes('recycler') || s.includes('listview')) return 'sr2-c-scroll';
    if (s.includes('image') || s.includes('icon')) return 'sr2-c-img';
    if (s.includes('layout') || s.includes('view') || s.includes('container') || s.includes('frame')) return 'sr2-c-layout';
    if (s === 'rootview') return 'sr2-c-root';
    return 'sr2-c-other';
  }

  function extractAllText(node, out) {
    if (!node) return;
    const t = node.text || node.desc || node.hint || '';
    if (t && t.length > 0 && t.length < 200) out.push({ text: t, editable: !!node.editable });
    if (Array.isArray(node.children)) node.children.forEach(c => extractAllText(c, out));
  }

  // Flatten hierarchy → array of { node, path, depth }
  function flattenTree(node, depth, idx, result) {
    if (!node) return;
    const id = result.length;
    result.push({ node, depth, idx, id, collapsed: false });
    if (Array.isArray(node.children)) {
      node.children.forEach((c, i) => flattenTree(c, depth + 1, i, result));
    }
  }

  // ── ScreenReaderV2 ────────────────────────────────────────────────────────────
  class ScreenReaderV2 {
    constructor(deviceId, sendFn) {
      this.deviceId   = deviceId;
      this._send      = sendFn;

      this._hierarchy    = null;      // last parsed hierarchy root
      this._flatNodes    = [];        // flat list for rendering
      this._selected     = null;      // selected flat-node entry
      this._liveEnabled  = false;     // TOGGLE_SCREEN_READER state
      this._editarMode   = false;     // EDITAR V2 mode
      this._collapseSet  = new Set(); // set of node ids that are collapsed

      this._mounted = false;
      this._el      = null;           // overlay root element

      this._ocrTokens = [];

      // event listener ref (for cleanup)
      this._onHierarchy = (e) => {
        if (e.detail && e.detail.id === this.deviceId) {
          this._onHierarchyData(e.detail.data);
        }
      };
      document.addEventListener('nx:hierarchy', this._onHierarchy);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    open() {
      if (this._mounted) return;
      this._injectCSS();
      this._buildDOM();
      document.body.appendChild(this._el);
      this._mounted = true;
      this._requestHierarchy();
    }

    close() {
      if (!this._mounted) return;
      if (this._liveEnabled) {
        this._toggleLive(false);
      }
      document.body.removeChild(this._el);
      this._el = null;
      this._mounted = false;
    }

    destroy() {
      this.close();
      document.removeEventListener('nx:hierarchy', this._onHierarchy);
    }

    // ── CSS inject ────────────────────────────────────────────────────────────
    _injectCSS() {
      if (document.getElementById('sr2-style')) return;
      const s = document.createElement('style');
      s.id = 'sr2-style';
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    // ── DOM build ─────────────────────────────────────────────────────────────
    _buildDOM() {
      const el = document.createElement('div');
      el.className = 'sr2-overlay';
      el.innerHTML = `
        <div class="sr2-header">
          <span class="sr2-badge sr2-badge-off" id="sr2-live-badge">⬤ OFF</span>
          <span class="sr2-pkg" id="sr2-pkg">—</span>
          <span class="sr2-ts" id="sr2-ts"></span>
          <button class="sr2-close" id="sr2-close" title="Close">✕</button>
        </div>

        <div class="sr2-toolbar">
          <button class="sr2-btn green" id="sr2-live-btn">▶ LEITOR</button>
          <button class="sr2-btn" id="sr2-editar-btn">✏ EDITAR V2</button>
          <div class="sr2-sep"></div>
          <button class="sr2-btn" id="sr2-req-btn">↺ Snapshot</button>
          <button class="sr2-btn" id="sr2-collapse-btn">⊟ Collapse All</button>
          <button class="sr2-btn" id="sr2-expand-btn">⊞ Expand All</button>
          <div class="sr2-sep"></div>
          <button class="sr2-btn" id="sr2-copy-ocr">📋 Copy OCR</button>
          <span class="sr2-ocr-perc" id="sr2-ocr-count"></span>
        </div>

        <div class="sr2-body">
          <div class="sr2-tree-pane">
            <div class="sr2-pane-title">Hierarchy Tree</div>
            <div class="sr2-tree-scroll" id="sr2-tree"></div>
          </div>
          <div class="sr2-inspector">
            <div class="sr2-pane-title">Node Inspector</div>
            <div class="sr2-inspector-scroll" id="sr2-inspector">
              <div class="sr2-inspector-empty">Select a node from the tree</div>
            </div>
          </div>
        </div>

        <div class="sr2-ocr-pane">
          <div class="sr2-ocr-title">OCR Text Stream</div>
          <div class="sr2-ocr-content" id="sr2-ocr"></div>
        </div>
      `;
      this._el = el;
      this._bindDOM();
    }

    _bindDOM() {
      const q = (id) => this._el.querySelector('#' + id);

      q('sr2-close').addEventListener('click', () => this.close());

      q('sr2-live-btn').addEventListener('click', () => {
        this._toggleLive(!this._liveEnabled);
      });

      q('sr2-editar-btn').addEventListener('click', () => {
        this._editarMode = !this._editarMode;
        q('sr2-editar-btn').classList.toggle('active', this._editarMode);
        q('sr2-editar-btn').textContent = this._editarMode ? '✏ EDITAR V2 ON' : '✏ EDITAR V2';
        if (this._hierarchy) this._renderTree(this._flatNodes);
      });

      q('sr2-req-btn').addEventListener('click', () => this._requestHierarchy());

      q('sr2-collapse-btn').addEventListener('click', () => {
        this._flatNodes.forEach(entry => {
          if (Array.isArray(entry.node.children) && entry.node.children.length > 0) {
            this._collapseSet.add(entry.id);
          }
        });
        this._renderTree(this._flatNodes);
      });

      q('sr2-expand-btn').addEventListener('click', () => {
        this._collapseSet.clear();
        this._renderTree(this._flatNodes);
      });

      q('sr2-copy-ocr').addEventListener('click', () => {
        const text = this._ocrTokens.map(t => t.text).join(' ');
        navigator.clipboard.writeText(text).catch(() => {});
      });
    }

    // ── Commands ──────────────────────────────────────────────────────────────
    _cmd(cmd, args) {
      this._send({ type: 'cmd', target: this.deviceId, cmd, args: args || {} });
    }

    _requestHierarchy() {
      this._cmd('REQUEST_HIERARCHY', {});
    }

    _toggleLive(enabled) {
      this._liveEnabled = enabled;
      this._cmd('TOGGLE_SCREEN_READER', { enabled });
      const badge = this._el.querySelector('#sr2-live-badge');
      const btn   = this._el.querySelector('#sr2-live-btn');
      if (enabled) {
        badge.className = 'sr2-badge sr2-badge-live';
        badge.textContent = '⬤ LIVE';
        btn.classList.add('active');
        btn.textContent = '⏹ LEITOR';
      } else {
        badge.className = 'sr2-badge sr2-badge-off';
        badge.textContent = '⬤ OFF';
        btn.classList.remove('active');
        btn.textContent = '▶ LEITOR';
      }
    }

    _performNodeAction(action, node, text) {
      const b = node.bounds || {};
      this._cmd('PERFORM_NODE_ACTION', {
        action,
        bx: b.x  || 0,
        by: b.y  || 0,
        bw: b.w  || 1,
        bh: b.h  || 1,
        text: text || ''
      });
    }

    // ── Data ──────────────────────────────────────────────────────────────────
    _onHierarchyData(rawData) {
      let parsed;
      try {
        parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
      } catch (e) { return; }

      this._hierarchy = parsed;

      // Update header
      const pkg = parsed.package || '—';
      const ts  = parsed.timestamp || new Date().toLocaleTimeString();
      const q   = (id) => this._el.querySelector('#' + id);
      q('sr2-pkg').textContent = pkg;
      q('sr2-ts').textContent  = ts;

      // Flatten tree
      const flat = [];
      const hier = parsed.hierarchy;
      if (hier) flattenTree(hier, 0, 0, flat);
      this._flatNodes = flat;

      // OCR extract
      const ocrOut = [];
      if (hier) extractAllText(hier, ocrOut);
      this._ocrTokens = ocrOut;
      this._renderOCR(ocrOut, q('sr2-ocr'), q('sr2-ocr-count'));

      // Render tree
      this._renderTree(flat);

      // Re-render inspector if selection still valid
      if (this._selected !== null) {
        const still = flat.find(e => this._selected && e.node === this._selected.node);
        if (still) this._showInspector(still);
      }
    }

    // ── Tree render ───────────────────────────────────────────────────────────
    _renderTree(flat) {
      const container = this._el.querySelector('#sr2-tree');
      if (!flat || flat.length === 0) {
        container.innerHTML = '<div style="padding:20px;color:#2a2a40;font-size:11px">No hierarchy data</div>';
        return;
      }

      // Determine which ids are under a collapsed parent
      const hiddenIds = new Set();
      const isCollapsed = (id) => this._collapseSet.has(id);

      for (let i = 0; i < flat.length; i++) {
        const entry = flat[i];
        // If any ancestor is collapsed, this is hidden
        let hidden = false;
        for (const cid of this._collapseSet) {
          // find the collapsed entry
          const collapsedEntry = flat[cid];
          if (!collapsedEntry) continue;
          if (entry.depth > collapsedEntry.depth && i > cid) {
            // Check if we're actually under this collapsed node
            // by scanning backwards for the parent at depth collapsedEntry.depth
            let j = i - 1;
            let under = false;
            while (j >= 0 && flat[j].depth >= entry.depth) j--;
            // simple: find nearest ancestor
            let k = i - 1;
            while (k >= cid) {
              if (flat[k].id === collapsedEntry.id) { under = true; break; }
              k--;
            }
            if (under) { hidden = true; break; }
          }
        }
        if (hidden) hiddenIds.add(entry.id);
      }

      const editarMode = this._editarMode;
      const selectedId = this._selected ? this._selected.id : -1;

      const html = flat.map((entry, i) => {
        if (hiddenIds.has(entry.id)) return '';

        const { node, depth, id } = entry;
        const hasChildren = Array.isArray(node.children) && node.children.length > 0;
        const collapsed   = this._collapseSet.has(id);

        const indent   = depth * 14;
        const cls      = shortClass(node.class || '');
        const color    = classColor(node.class || '');
        const text     = node.text || node.desc || node.hint || '';
        const password = node.password ? '●●●' : text;
        const textPreview = password.length > 30 ? password.slice(0, 30) + '…' : password;

        const flags = [
          node.clickable   ? '👆' : '',
          node.editable    ? '✏' : '',
          node.scrollable  ? '↕' : '',
          node.focused     ? '🎯' : '',
          node.checked     ? '☑' : '',
        ].filter(Boolean).join('');

        const isEditable  = !!node.editable;
        const isSelected  = id === selectedId;
        const isEditarHit = editarMode && isEditable;

        const nodeClass = [
          'sr2-node',
          isSelected  ? 'selected' : '',
          isEditarHit ? 'editable-mode' : ''
        ].filter(Boolean).join(' ');

        return `<div class="${nodeClass}" data-nodeid="${id}" style="padding-left:${indent}px">` +
          `<span class="sr2-node-toggle">${hasChildren ? (collapsed ? '▶' : '▼') : ' '}</span>` +
          `<span class="sr2-node-class ${color}">${esc(cls)}</span>` +
          (textPreview ? `<span class="sr2-node-text">${esc(textPreview)}</span>` : '') +
          (flags ? `<span class="sr2-node-flags">${flags}</span>` : '') +
          `</div>`;
      }).join('');

      container.innerHTML = html;

      // Bind click events
      container.querySelectorAll('.sr2-node').forEach(el => {
        const nodeId = parseInt(el.dataset.nodeid, 10);
        const entry  = flat[nodeId];
        if (!entry) return;

        el.addEventListener('click', (e) => {
          const toggleEl = e.target.closest('.sr2-node-toggle');
          if (toggleEl && Array.isArray(entry.node.children) && entry.node.children.length > 0) {
            // Toggle collapse
            if (this._collapseSet.has(nodeId)) {
              this._collapseSet.delete(nodeId);
            } else {
              this._collapseSet.add(nodeId);
            }
            this._renderTree(this._flatNodes);
            return;
          }
          // Select node
          this._selected = entry;
          this._showInspector(entry);
          // Re-render just to update selection highlight
          this._renderTree(this._flatNodes);

          // EDITAR V2: if editable node clicked, focus inspector input
          if (this._editarMode && entry.node.editable) {
            setTimeout(() => {
              const inp = this._el.querySelector('#sr2-edit-input');
              if (inp) inp.focus();
            }, 50);
          }
        });
      });
    }

    // ── Inspector ─────────────────────────────────────────────────────────────
    _showInspector(entry) {
      const node = entry.node;
      const b    = node.bounds || {};
      const insp = this._el.querySelector('#sr2-inspector');

      const stateRow = (label, val) => {
        const on = !!val;
        return `<span class="sr2-state ${on ? 'on' : ''}">${label}${on ? ' ✓' : ''}</span>`;
      };

      const field = (label, val, cls) => val !== undefined && val !== '' && val !== null
        ? `<div class="sr2-field">
            <div class="sr2-field-label">${label}</div>
            <div class="sr2-field-val ${cls || ''}">${esc(String(val))}</div>
           </div>`
        : '';

      const editArea = node.editable ? `
        <div class="sr2-edit-area">
          <div class="sr2-edit-label">✏ EDITAR V2 — Set Text</div>
          <input class="sr2-edit-input" id="sr2-edit-input" type="text"
                 value="${esc(node.text || '')}" placeholder="Type new value…">
          <div class="sr2-edit-controls">
            <button class="sr2-act-btn primary" id="sr2-settext-btn">⬆ SET TEXT</button>
            <button class="sr2-act-btn danger"  id="sr2-cleartext-btn">✕ CLEAR</button>
          </div>
        </div>` : '';

      insp.innerHTML = `
        ${field('Class',    node.class,    'highlight')}
        ${field('Text',     node.text)}
        ${field('Hint',     node.hint,     'warn')}
        ${field('Desc',     node.desc)}
        ${field('ID',       node.id)}
        ${field('Package',  node.windowPackage)}

        <div class="sr2-field">
          <div class="sr2-field-label">Bounds</div>
          <div class="sr2-bounds-bar">
            <span class="sr2-bounds-pill">x <span>${b.x ?? '?'}</span></span>
            <span class="sr2-bounds-pill">y <span>${b.y ?? '?'}</span></span>
            <span class="sr2-bounds-pill">w <span>${b.w ?? '?'}</span></span>
            <span class="sr2-bounds-pill">h <span>${b.h ?? '?'}</span></span>
          </div>
        </div>

        <div class="sr2-field">
          <div class="sr2-field-label">States</div>
          <div class="sr2-states">
            ${stateRow('clickable',    node.clickable)}
            ${stateRow('editable',     node.editable)}
            ${stateRow('scrollable',   node.scrollable)}
            ${stateRow('focused',      node.focused)}
            ${stateRow('checked',      node.checked)}
            ${stateRow('enabled',      node.enabled)}
            ${stateRow('password',     node.password)}
            ${stateRow('longClick',    node.longClickable)}
            ${stateRow('selected',     node.selected)}
          </div>
        </div>

        <div class="sr2-field">
          <div class="sr2-field-label">Actions</div>
          <div class="sr2-actions">
            <button class="sr2-act-btn primary" id="sr2-act-click">👆 CLICK</button>
            ${node.longClickable ? '<button class="sr2-act-btn" id="sr2-act-longclick">⏸ LONG CLICK</button>' : ''}
            ${node.scrollable    ? '<button class="sr2-act-btn" id="sr2-act-scrollup">↑ SCROLL UP</button>'   : ''}
            ${node.scrollable    ? '<button class="sr2-act-btn" id="sr2-act-scrolldown">↓ SCROLL DOWN</button>' : ''}
            <button class="sr2-act-btn" id="sr2-act-focus">🎯 FOCUS</button>
          </div>
        </div>

        ${editArea}
      `;

      // Bind inspector action buttons
      const actBtn = (id, cb) => {
        const el = insp.querySelector('#' + id);
        if (el) el.addEventListener('click', cb);
      };

      actBtn('sr2-act-click',       () => this._performNodeAction('CLICK',         node, ''));
      actBtn('sr2-act-longclick',   () => this._performNodeAction('LONG_CLICK',    node, ''));
      actBtn('sr2-act-scrollup',    () => this._performNodeAction('SCROLL_BACKWARD', node, ''));
      actBtn('sr2-act-scrolldown',  () => this._performNodeAction('SCROLL_FORWARD',  node, ''));
      actBtn('sr2-act-focus',       () => this._performNodeAction('FOCUS',         node, ''));

      if (node.editable) {
        actBtn('sr2-settext-btn', () => {
          const val = insp.querySelector('#sr2-edit-input').value;
          this._performNodeAction('SET_TEXT', node, val);
        });
        actBtn('sr2-cleartext-btn', () => {
          this._performNodeAction('CLEAR_TEXT', node, '');
          const inp = insp.querySelector('#sr2-edit-input');
          if (inp) inp.value = '';
        });

        // Enter key on input → SET_TEXT
        const inp = insp.querySelector('#sr2-edit-input');
        if (inp) {
          inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              this._performNodeAction('SET_TEXT', node, inp.value);
            }
          });
        }
      }
    }

    // ── OCR render ────────────────────────────────────────────────────────────
    _renderOCR(tokens, container, countEl) {
      if (!tokens || tokens.length === 0) {
        container.innerHTML = '<span style="color:#2a2a40">— no text extracted —</span>';
        countEl.textContent = '';
        return;
      }
      container.innerHTML = tokens.map((t, i) =>
        `<span class="sr2-ocr-token ${t.editable ? 'editable' : ''}"
              data-i="${i}" title="${esc(t.text)}">${esc(t.text)}</span>`
      ).join('');
      countEl.textContent = `${tokens.length} token${tokens.length !== 1 ? 's' : ''}`;

      // Click an OCR token → find its node and select it
      container.querySelectorAll('.sr2-ocr-token').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.dataset.i, 10);
          const tok = tokens[idx];
          if (!tok) return;
          // Find node in flat list with matching text
          const match = this._flatNodes.find(e =>
            (e.node.text === tok.text || e.node.desc === tok.text) && !!e.node.editable === tok.editable
          );
          if (match) {
            this._selected = match;
            this._showInspector(match);
            this._renderTree(this._flatNodes);
            // Scroll tree to match
            const nodeEl = this._el.querySelector(`[data-nodeid="${match.id}"]`);
            if (nodeEl) nodeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        });
      });
    }
  }

  // ── Registry: one instance per deviceId ───────────────────────────────────
  const _registry = new Map();

  function getOrCreate(deviceId, sendFn) {
    if (!_registry.has(deviceId)) {
      _registry.set(deviceId, new ScreenReaderV2(deviceId, sendFn));
    }
    return _registry.get(deviceId);
  }

  function toggleForDevice(deviceId, sendFn) {
    const sr = getOrCreate(deviceId, sendFn);
    if (sr._mounted) {
      sr.close();
    } else {
      sr.open();
    }
    return sr;
  }

  function destroyForDevice(deviceId) {
    if (_registry.has(deviceId)) {
      _registry.get(deviceId).destroy();
      _registry.delete(deviceId);
    }
  }

  // Export
  global.ScreenReaderV2 = {
    create:           (deviceId, sendFn) => new ScreenReaderV2(deviceId, sendFn),
    getOrCreate,
    toggleForDevice,
    destroyForDevice,
    _registry,
  };

})(window);
