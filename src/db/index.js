/**
 * Data-access module — all SQLite interactions live here.
 * Uses node:sqlite (stable in Node 24, zero native compilation).
 * Swap the constructor + pragma calls to pg/postgres to migrate to Postgres.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'wasl.db');

let _db = null;

function getDb() {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    // WAL mode: better read concurrency; foreign keys enforced at DB level
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      phone         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK(role IN ('ROLE_RESIDENT', 'ROLE_RESPONDER', 'ROLE_COORDINATOR')),
      home_lat      REAL,
      home_lng      REAL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id              TEXT PRIMARY KEY,
      resident_id     TEXT NOT NULL REFERENCES users(id),
      category        TEXT NOT NULL CHECK(category IN ('medical', 'fire', 'vehicle', 'other')),
      note            TEXT,
      lat             REAL NOT NULL,
      lng             REAL NOT NULL,
      accuracy_m      REAL,
      status          TEXT NOT NULL DEFAULT 'sent'
                      CHECK(status IN ('sent', 'acknowledged', 'en_route', 'resolved')),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged_at TEXT,
      resolved_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS responder_acknowledgments (
      id            TEXT PRIMARY KEY,
      alert_id      TEXT NOT NULL REFERENCES alerts(id),
      responder_id  TEXT NOT NULL REFERENCES users(id),
      status        TEXT NOT NULL DEFAULT 'acknowledged'
                    CHECK(status IN ('acknowledged', 'en_route', 'on_scene', 'stood_down')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(alert_id, responder_id)
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_status   ON alerts(status);
    CREATE INDEX IF NOT EXISTS idx_alerts_resident ON alerts(resident_id);
    CREATE INDEX IF NOT EXISTS idx_ack_alert       ON responder_acknowledgments(alert_id);
    CREATE INDEX IF NOT EXISTS idx_users_role      ON users(role);
  `);
}

// ── Users ─────────────────────────────────────────────────────────────────────

function createUser({ id, name, phone, passwordHash, role, homeLat, homeLng }) {
  getDb().prepare(`
    INSERT INTO users (id, name, phone, password_hash, role, home_lat, home_lng)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, phone, passwordHash, role, homeLat ?? null, homeLng ?? null);
}

function findUserByPhone(phone) {
  return getDb().prepare('SELECT * FROM users WHERE phone = ?').get(phone) ?? null;
}

function findUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

/**
 * Return all responders whose home location is within radiusKm of (lat, lng).
 * Haversine is computed in JS because SQLite has no trig functions by default.
 */
function findRespondersNear(lat, lng, radiusKm) {
  const responders = getDb()
    .prepare(`SELECT * FROM users WHERE role = 'ROLE_RESPONDER' AND home_lat IS NOT NULL AND home_lng IS NOT NULL`)
    .all();

  return responders.filter(r => haversineKm(lat, lng, r.home_lat, r.home_lng) <= radiusKm);
}

// ── Alerts ────────────────────────────────────────────────────────────────────

function createAlert({ id, residentId, category, note, lat, lng, accuracyM }) {
  getDb().prepare(`
    INSERT INTO alerts (id, resident_id, category, note, lat, lng, accuracy_m)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, residentId, category, note ?? null, lat, lng, accuracyM ?? null);
  return getDb().prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

function getAlertById(id) {
  return getDb().prepare('SELECT * FROM alerts WHERE id = ?').get(id) ?? null;
}

function getActiveAlerts() {
  return getDb()
    .prepare(`SELECT * FROM alerts WHERE status != 'resolved' ORDER BY created_at DESC`)
    .all();
}

function getResolvedAlerts(limit = 20) {
  return getDb()
    .prepare(`SELECT * FROM alerts WHERE status = 'resolved' ORDER BY resolved_at DESC LIMIT ?`)
    .all(limit);
}

function updateAlertStatus(id, status) {
  const now = new Date().toISOString();
  if (status === 'acknowledged') {
    getDb().prepare(`UPDATE alerts SET status = ?, acknowledged_at = ? WHERE id = ?`).run(status, now, id);
  } else if (status === 'resolved') {
    getDb().prepare(`UPDATE alerts SET status = ?, resolved_at = ? WHERE id = ?`).run(status, now, id);
  } else {
    getDb().prepare('UPDATE alerts SET status = ? WHERE id = ?').run(status, id);
  }
  return getDb().prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

// ── Acknowledgments ───────────────────────────────────────────────────────────

function upsertAcknowledgment({ id, alertId, responderId, status }) {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO responder_acknowledgments (id, alert_id, responder_id, status, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(alert_id, responder_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
  `).run(id, alertId, responderId, status, now);
  return getDb().prepare(
    'SELECT * FROM responder_acknowledgments WHERE alert_id = ? AND responder_id = ?'
  ).get(alertId, responderId);
}

function getAcknowledgmentsByAlert(alertId) {
  return getDb().prepare(`
    SELECT ra.*, u.name as responder_name, u.phone as responder_phone
    FROM responder_acknowledgments ra
    JOIN users u ON u.id = ra.responder_id
    WHERE ra.alert_id = ?
  `).all(alertId);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function getAlertStats() {
  const db = getDb();
  const total    = db.prepare('SELECT COUNT(*) as count FROM alerts').get().count;
  const resolved = db.prepare(`SELECT COUNT(*) as count FROM alerts WHERE status = 'resolved'`).get().count;

  const acked = db.prepare(`
    SELECT (julianday(acknowledged_at) - julianday(created_at)) * 86400 as ack_seconds
    FROM alerts WHERE acknowledged_at IS NOT NULL
  `).all().map(r => r.ack_seconds).filter(s => s > 0);

  const avg = acked.length ? acked.reduce((a, b) => a + b, 0) / acked.length : null;
  const sorted = [...acked].sort((a, b) => a - b);
  const median = sorted.length
    ? sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)]
    : null;

  return {
    total,
    resolved,
    acked: acked.length,
    avg_ack_seconds: avg ? +avg.toFixed(1) : null,
    median_ack_seconds: median ? +median.toFixed(1) : null,
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) { return deg * Math.PI / 180; }

module.exports = {
  getDb,
  createUser, findUserByPhone, findUserById, findRespondersNear,
  createAlert, getAlertById, getActiveAlerts, getResolvedAlerts, updateAlertStatus,
  upsertAcknowledgment, getAcknowledgmentsByAlert,
  getAlertStats,
  haversineKm,
};
