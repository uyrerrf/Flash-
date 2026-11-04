'use strict';
/**
 * LyReader v3 — Red-wire accessibility tree renderer
 *
 * BUG FIX: Android accessibility bounds are ABSOLUTE screen coordinates, not
 * relative to parent. Old v2 nesting caused every child to be offset by its
 * parent's accumulated position. Fix: flat rendering — all nodes appended
 * directly to phone div with left = bounds.x * scale, top = bounds.y * scale.
 * Z-ordering is correct because tree walk is depth-first (children later in DOM).
 *
 * AESTHETIC: dark background, red wireframe lines, red text, monospace font.
 */

class LyReader {
  constructor(container, deviceId, sendFn, screenW = 1080, screenH = 1920) {
    this._container = container;
    this._deviceId  = deviceId;
    this._send      = sendFn;
    this._screenW   = screenW;
    this._screenH   = screenH;
    this._root         = null;
    this._nodes        = [];
    this._focused      = null;
    this._refreshTimer = null;
    this._pollTimer    = null;
    this._polling      = false;
    this._scale        = 1;
    this._ox           = 0;
    this._oy           = 0;
    this._phone        = null;
    this._build();
  }

  _build() {
    this._container.style.cssText = `position:relative;width:100%;height:100%;overflow:hidden;background:#040406;font-family:'Courier New',monospace;cursor:default;user-select:none;`;

    this._placeholder = document.createElement('div');
    this._placeholder.style.cssText = `position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;`;
    this._placeholder.innerHTML = `
      <div style="font-size:28px;margin-bottom:12px;filter:drop-shadow(0 0 10px #880000)">📱</div>
      <div style="color:#550000;letter-spacing:3px;font-size:11px;font-weight:700">LY READER</div>
      <div style="font-size:9px;margin-top:8px;color:#2a0000;letter-spacing:1px">PRESS START — AWAITING HIERARCHY</div>`;
    this._container.appendChild(this._placeholder);

    this._statusBar = document.createElement('div');
    this._statusBar.style.cssText = `position:absolute;top:0;left:0;right:0;height:18px;background:rgba(4,0,0,0.92);border-bottom:1px solid #2a0000;display:flex;align-items:center;padding:0 8px;gap:8px;font-size:9px;z-index:9999;pointer-events:none;`;
    this._statusBar.innerHTML = `<span style="color:#cc0000;letter-spacing:2px;font-weight:700">LY</span><span id="_lyr_pkg" style="color:#880000"></span><span style="flex:1"></span><span id="_lyr_cnt" style="color:#440000">0 nodes</span><span id="_lyr_dim" style="color:#220000;margin-left:6px"></span>`;
    this._container.appendChild(this._statusBar);

    this._layer = document.createElement('div');
    this._layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
    this._container.appendChild(this._layer);

    this._realInput = document.createElement('input');
    this._realInput.type = 'text';
    this._realInput.autocomplete = 'off';
    this._realInput.spellcheck = false;
    this._realInput.style.cssText = `position:absolute;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;`;
    this._container.appendChild(this._realInput);
    this._bindRealInput();
    this._container.tabIndex = 0;
    this._container.addEventListener('keydown', e => this._onKeydown(e));
  }

  update(data) {
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
    const hier = data?.hierarchy || data;
    if (!hier) return;
    this._root = hier;
    const rb = hier.bounds || {};
    if (rb.w > 0) this._screenW = rb.w;
    if (rb.h > 0) this._screenH = rb.h;
    this._placeholder.style.display = 'none';
    this._render(hier);
    this._updateStatus(hier);
  }

  startPolling(ms = 700) {
    if (this._polling) return;
    this._polling = true;
    this._requestHierarchy();
    this._pollTimer = setInterval(() => { if (this._polling) this._requestHierarchy(); }, ms);
  }

  stopPolling() {
    if (!this._polling) return;
    this._polling = false;
    clearInterval(this._pollTimer);
    this._pollTimer = null;
    clearTimeout(this._refreshTimer);
  }

  destroy() { this.stopPolling(); clearTimeout(this._refreshTimer); this._container.innerHTML = ''; }
  onResize() { if (this._root) this._render(this._root); }

  _render(root) {
    const cw = this._container.clientWidth  || 360;
    const ch = this._container.clientHeight || 720;
    const sw = this._screenW  || 1080;
    const sh = this._screenH  || 1920;
    const scale = Math.min(cw / sw, ch / sh);
    const ox    = Math.round((cw - sw * scale) / 2);
    const oy    = Math.round((ch - sh * scale) / 2);
    this._scale = scale; this._ox = ox; this._oy = oy;
    this._layer.innerHTML = '';
    this._nodes = []; this._focused = null;

    const phone = document.createElement('div');
    phone.style.cssText = `position:absolute;left:${ox}px;top:${oy}px;width:${Math.round(sw*scale)}px;height:${Math.round(sh*scale)}px;background:#050505;border:1px solid #3a0000;`;
    this._layer.appendChild(phone);
    this._phone = phone;

    const scanline = document.createElement('div');
    scanline.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(80,0,0,0.04) 2px,rgba(80,0,0,0.04) 4px);`;
    phone.appendChild(scanline);

    this._walkFlat(root, phone, scale, sw, sh);

    const dim = this._container.querySelector('#_lyr_dim');
    if (dim) dim.textContent = `${sw}×${sh}`;
  }

  /* Flat walk: ALL nodes appended to phone. bounds.x/y = absolute device coords */
  _walkFlat(node, phone, scale, sw, sh) {
    if (!node) return;
    const b = node.bounds;
    if (b && b.w > 0 && b.h > 0 && b.x + b.w > 0 && b.y + b.h > 0 && b.x < sw && b.y < sh) {
      const el = this._buildEl(node, b, scale, sw, sh);
      if (el) { el.style.zIndex = '1'; phone.appendChild(el); }
    }
    for (const c of (node.children || [])) this._walkFlat(c, phone, scale, sw, sh);
  }

  _buildEl(node, b, scale, sw, sh) {
    if (node.isPatternLock && node.patternGrid) return this._buildPatternLock(node, b, scale, sw, sh);
    if (node.isSwipeUnlock && node.swipeHint)   return this._buildSwipeUnlock(node, b, scale, sw, sh);
    if (node.isKeyboardKey || node.isKeyboard)   return this._buildKeyboardKey(node, b, scale, sw, sh);

    const cls        = (node.class || '').toLowerCase();
    const text       = node.text || node.desc || node.hint || '';
    const isEditable  = !!node.editable;
    const isClickable = !!(node.clickable && !isEditable);
    const isPinDigit  = !!node.isPinDigit;
    const enabled     = node.enabled !== false;

    const lx = Math.round(b.x * scale);
    const ly = Math.round(b.y * scale);
    const lw = Math.max(1, Math.round(b.w * scale));
    const lh = Math.max(1, Math.round(b.h * scale));
    const fs = Math.max(7, Math.min(13, lh * 0.44));

    const div = document.createElement('div');
    div.style.cssText = `position:absolute;left:${lx}px;top:${ly}px;width:${lw}px;height:${lh}px;box-sizing:border-box;overflow:hidden;`;

    if (isEditable) {
      div.style.border        = node.focused ? '1.5px solid #ff5555' : '1px solid #bb2222';
      div.style.background    = 'rgba(8,0,0,0.9)';
      div.style.borderRadius  = '2px';
      div.style.cursor        = 'text';
      div.style.display       = 'flex';
      div.style.alignItems    = 'center';
      div.style.padding       = '0 3px';
      const inner = document.createElement('div');
      inner.style.cssText = `width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:${fs}px;color:${text ? '#dd6666' : '#441111'};`;
      let disp = text;
      if (node.focused && !text) disp = '█';
      if (node.password && text)  disp = '●'.repeat(Math.min(text.length, 24));
      inner.textContent = disp;
      div.appendChild(inner);
      div.addEventListener('click', e => { e.stopPropagation(); this._tapNode(node, sw, sh); this._setFocused(node, div, inner); });
      this._nodes.push({ node, el: div, inner });

    } else if (isPinDigit) {
      div.style.cssText += `background:rgba(15,0,0,0.9);border:1px solid #882222;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#cc4444;font-size:${Math.max(9,lh*0.5)}px;font-weight:700;`;
      div.textContent = text;
      this._addTapBehavior(div, node, sw, sh);

    } else if (isClickable) {
      const prim = cls.includes('button') || cls.includes('btn');
      if (text) {
        div.style.border       = `1px solid ${prim ? '#cc2222' : '#660000'}`;
        div.style.background   = prim ? 'rgba(50,0,0,0.3)' : 'transparent';
        div.style.borderRadius = '2px';
        div.style.display      = 'flex';
        div.style.alignItems   = 'center';
        div.style.justifyContent = 'center';
        div.style.cursor       = enabled ? 'pointer' : 'default';
        div.style.opacity      = enabled ? '1' : '0.4';
        const lbl = document.createElement('div');
        lbl.style.cssText = `font-size:${fs}px;color:${prim?'#ee5555':'#aa3333'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 2px;text-align:center;`;
        lbl.textContent = text;
        div.appendChild(lbl);
      } else {
        div.style.background = 'transparent';
        div.style.cursor     = enabled ? 'pointer' : 'default';
      }
      if (enabled) this._addTapBehavior(div, node, sw, sh);

    } else if (text) {
      div.style.display   = 'flex';
      div.style.alignItems = 'center';
      div.style.overflow  = 'hidden';
      div.style.padding   = '0 2px';
      const lbl = document.createElement('div');
      lbl.style.cssText = `font-size:${fs}px;color:#884444;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;`;
      lbl.textContent = text;
      div.appendChild(lbl);

    } else {
      const minSide = Math.round(60 * scale);
      if (lw < minSide && lh < minSide) return null;
      div.style.border     = '1px solid rgba(100,0,0,0.18)';
      div.style.background = 'transparent';
    }

    if (node.scrollable) this._addScrollBehavior(div, node, sw, sh);
    if (node.checked)    div.style.outline = '1px solid rgba(60,180,60,0.4)';
    if (node.focused && !isEditable) div.style.outline = '1.5px solid rgba(255,80,80,0.5)';
    return div;
  }

  _buildKeyboardKey(node, b, scale, sw, sh) {
    const lx = Math.round(b.x * scale), ly = Math.round(b.y * scale);
    const lw = Math.max(1, Math.round(b.w * scale)), lh = Math.max(1, Math.round(b.h * scale));
    const fs = Math.max(7, Math.min(13, lh * 0.52));
    const div = document.createElement('div');
    div.style.cssText = `position:absolute;left:${lx}px;top:${ly}px;width:${lw}px;height:${lh}px;background:rgba(16,0,0,0.8);border:1px solid #661111;border-radius:${Math.max(1,Math.round(lw*0.1))}px;display:flex;align-items:center;justify-content:center;cursor:pointer;box-sizing:border-box;overflow:hidden;z-index:1;`;
    const label = node.text || node.desc || '';
    if (label) {
      const lbl = document.createElement('div');
      lbl.style.cssText = `font-size:${fs}px;color:#aa3333;font-weight:500;text-align:center;pointer-events:none;overflow:hidden;`;
      lbl.textContent = label.length <= 3 ? label : label.slice(0, 3);
      div.appendChild(lbl);
    }
    div.addEventListener('mousedown', () => { div.style.background = 'rgba(60,0,0,0.9)'; div.style.borderColor = '#ff4444'; });
    div.addEventListener('mouseup',   () => { div.style.background = 'rgba(16,0,0,0.8)'; div.style.borderColor = '#661111'; this._tapNode(node, sw, sh); });
    div.addEventListener('mouseleave',() => { div.style.background = 'rgba(16,0,0,0.8)'; div.style.borderColor = '#661111'; });
    return div;
  }

  _buildPatternLock(node, b, scale, sw, sh) {
    const lx = Math.round(b.x * scale), ly = Math.round(b.y * scale);
    const lw = Math.max(1, Math.round(b.w * scale)), lh = Math.max(1, Math.round(b.h * scale));
    const div = document.createElement('div');
    div.style.cssText = `position:absolute;left:${lx}px;top:${ly}px;width:${lw}px;height:${lh}px;cursor:crosshair;z-index:1;`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', lw); svg.setAttribute('height', lh);
    svg.style.cssText = 'position:absolute;inset:0;overflow:visible;';
    const grid = node.patternGrid || [], dotEls = [];
    for (const pt of grid) {
      const cx = (pt.x - b.x) * scale, cy = (pt.y - b.y) * scale, r = Math.max(4, (pt.r||20)*scale);
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', cx); circle.setAttribute('cy', cy); circle.setAttribute('r', r);
      circle.setAttribute('fill', 'rgba(60,0,0,0.4)'); circle.setAttribute('stroke', '#882222'); circle.setAttribute('stroke-width', '1');
      svg.appendChild(circle); dotEls.push({ el: circle, px: pt.x, py: pt.y, cx, cy });
    }
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    pathEl.setAttribute('fill', 'none'); pathEl.setAttribute('stroke', '#ff3333');
    pathEl.setAttribute('stroke-width', '2'); pathEl.setAttribute('stroke-linecap', 'round');
    svg.appendChild(pathEl); div.appendChild(svg);
    let dragging = false, patternPath = [];
    const hitTest = (ex, ey) => {
      const rect = div.getBoundingClientRect(), lx2 = ex-rect.left, ly2 = ey-rect.top;
      for (const d of dotEls) if (Math.hypot(lx2-d.cx,ly2-d.cy)<24 && !patternPath.find(p=>p.x===d.px&&p.y===d.py)) return d;
      return null;
    };
    div.addEventListener('mousedown', e => {
      dragging = true; patternPath = []; pathEl.setAttribute('points','');
      dotEls.forEach(d=>{d.el.setAttribute('fill','rgba(60,0,0,0.4)');d.el.setAttribute('stroke','#882222');});
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) { patternPath.push({x:hit.px,y:hit.py}); hit.el.setAttribute('fill','rgba(180,0,0,0.5)'); hit.el.setAttribute('stroke','#ff3333'); }
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        patternPath.push({x:hit.px,y:hit.py}); hit.el.setAttribute('fill','rgba(180,0,0,0.5)'); hit.el.setAttribute('stroke','#ff3333');
        pathEl.setAttribute('points', patternPath.map(p=>{const d=dotEls.find(dd=>dd.px===p.x&&dd.py===p.y);return d?`${d.cx},${d.cy}`:''}).join(' '));
      }
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return; dragging = false;
      if (patternPath.length >= 2) {
        for (let i=0;i<patternPath.length-1;i++) {
          const p1=patternPath[i],p2=patternPath[i+1];
          setTimeout(()=>{this._send({type:'cmd',target:this._deviceId,cmd:'SWIPE',args:{x1:p1.x/sw,y1:p1.y/sh,x2:p2.x/sw,y2:p2.y/sh,duration:100}});},i*120);
        }
        this._scheduleRefresh(600+patternPath.length*120);
      }
    });
    return div;
  }

  _buildSwipeUnlock(node, b, scale, sw, sh) {
    const lx=Math.round(b.x*scale),ly=Math.round(b.y*scale),lw=Math.max(1,Math.round(b.w*scale)),lh=Math.max(1,Math.round(b.h*scale));
    const div = document.createElement('div');
    div.style.cssText = `position:absolute;left:${lx}px;top:${ly}px;width:${lw}px;height:${lh}px;background:rgba(20,0,0,0.3);border:1px dashed #441111;display:flex;align-items:center;justify-content:center;cursor:ns-resize;z-index:1;`;
    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:9px;color:#663333;pointer-events:none;letter-spacing:1px;';
    lbl.textContent = '↑ SWIPE TO UNLOCK'; div.appendChild(lbl);
    div.addEventListener('click',()=>{const h=node.swipeHint;this._send({type:'cmd',target:this._deviceId,cmd:'SWIPE',args:{x1:h.sx/sw,y1:h.sy/sh,x2:h.ex/sw,y2:h.ey/sh,duration:300}});this._scheduleRefresh(500);});
    return div;
  }

  _addTapBehavior(div, node, sw, sh) {
    div.addEventListener('mousedown',  ()=>{div.style.filter='brightness(1.7)';});
    div.addEventListener('mouseup',    ()=>{div.style.filter='';this._tapNode(node,sw,sh);});
    div.addEventListener('mouseleave', ()=>{div.style.filter='';});
    div.addEventListener('touchstart', e=>{e.preventDefault();div.style.filter='brightness(1.7)';},{passive:false});
    div.addEventListener('touchend',   e=>{e.preventDefault();div.style.filter='';this._tapNode(node,sw,sh);},{passive:false});
  }

  _addScrollBehavior(div, node, sw, sh) {
    div.addEventListener('wheel', e=>{
      e.stopPropagation();
      const bc=node.bounds,cx=(bc.x+bc.w/2)/sw,cy=(bc.y+bc.h/2)/sh,delta=e.deltaY>0?0.25:-0.25;
      this._send({type:'cmd',target:this._deviceId,cmd:'SWIPE',args:{x1:cx,y1:cy,x2:cx,y2:Math.max(0.01,Math.min(0.99,cy-delta)),duration:250}});
      this._scheduleRefresh(400);
    },{passive:true});
  }

  _tapNode(node, sw, sh) {
    const bc=node.bounds,cx=Math.max(0,Math.min(1,(bc.x+bc.w/2)/sw)),cy=Math.max(0,Math.min(1,(bc.y+bc.h/2)/sh));
    this._send({type:'cmd',target:this._deviceId,cmd:'TAP',args:{x:cx,y:cy}});
    this._scheduleRefresh(400);
  }

  _setFocused(node, divEl, innerEl) {
    if (this._focused && this._focused.el !== divEl) this._focused.el.style.border = '1px solid #bb2222';
    this._focused = {node, el:divEl, inner:innerEl};
    divEl.style.border = '1.5px solid #ff5555';
    this._realInput.value = ''; this._realInput.focus();
  }

  _bindRealInput() {
    this._realInput.addEventListener('input',()=>{
      const val=this._realInput.value; if(!val) return; this._realInput.value='';
      if(this._focused){const cur=this._focused.inner.textContent.replace('█','');this._focused.inner.textContent=cur+val;this._focused.inner.style.color='#dd6666';}
      this._send({type:'cmd',target:this._deviceId,cmd:'TYPE',args:{text:val}});this._scheduleRefresh(600);
    });
    this._realInput.addEventListener('keydown',e=>{
      if(e.key==='Backspace'){e.preventDefault();if(this._focused){const c=this._focused.inner.textContent;this._focused.inner.textContent=c.length>0?c.slice(0,-1):'█';}
        this._send({type:'cmd',target:this._deviceId,cmd:'TYPE',args:{text:'\b'}});this._scheduleRefresh(500);}
      if(e.key==='Enter'){e.preventDefault();this._send({type:'cmd',target:this._deviceId,cmd:'TYPE',args:{text:'\n'}});this._scheduleRefresh(500);}
    });
  }

  _onKeydown(e) {
    if(this._focused) return; if(e.ctrlKey||e.metaKey) return;
    if(e.key.length===1){this._send({type:'cmd',target:this._deviceId,cmd:'TYPE',args:{text:e.key}});this._scheduleRefresh(500);}
  }

  _scheduleRefresh(ms=400){clearTimeout(this._refreshTimer);this._refreshTimer=setTimeout(()=>this._requestHierarchy(),ms);}
  _requestHierarchy(){this._send({type:'cmd',target:this._deviceId,cmd:'REQUEST_HIERARCHY',args:{}});}

  _updateStatus(root){
    let n=0; const count=nd=>{if(!nd)return;n++;(nd.children||[]).forEach(count);}; count(root);
    let pkg=''; const fp=nd=>{if(nd?.id?.includes(':id/'))pkg=nd.id.split(':id/')[0];(nd?.children||[]).forEach(fp);}; fp(root);
    const pkgEl=this._container.querySelector('#_lyr_pkg'),cntEl=this._container.querySelector('#_lyr_cnt');
    if(pkgEl)pkgEl.textContent=pkg?pkg.split('.').pop():''; if(cntEl)cntEl.textContent=`${n} nodes`;
  }
}
