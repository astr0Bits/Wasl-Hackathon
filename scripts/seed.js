/**
 * Demo seed script — run once before the live demo.
 *
 * Usage:  node scripts/seed.js
 *         npm run seed
 *
 * Idempotent: safe to run multiple times (skips existing records).
 * Creates 3 demo users + 3 resolved background alerts so /api/stats
 * shows a meaningful avg ack time before the live demo begins.
 */

require('dotenv').config();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

// Use the shared db module so initSchema runs and tables are created
const { getDb } = require('../src/db');
const db = getDb();

// ── Demo accounts ─────────────────────────────────────────────────────────────
const DEMO_USERS = [
  {
    phone: '+971500000001',
    password: 'demo1234',
    name:  'Maryam Hassan (Resident)',
    role:  'ROLE_RESIDENT',
    home_lat: null,
    home_lng: null,
  },
  {
    phone: '+971500000002',
    password: 'demo1234',
    name:  'Khalid Al-Rashidi (Responder)',
    role:  'ROLE_RESPONDER',
    home_lat: 24.2075,   // Al Ain area
    home_lng: 55.7447,
  },
  {
    phone: '+971500000003',
    password: 'demo1234',
    name:  'Sara Al-Mansoori (Coordinator)',
    role:  'ROLE_COORDINATOR',
    home_lat: 24.2075,
    home_lng: 55.7447,
  },
];

// ── Historical alerts (for /api/stats context) ────────────────────────────────
// Timestamps are backdated so avg ack time looks realistic (~4–6 minutes)
const HISTORY_MINUTES = [4.2, 5.8, 3.1, 6.4, 4.9];

async function seed() {
  console.log('\n🌱  Wasl demo seed\n');

  // ── Users ──────────────────────────────────────────────────────────────────
  const upsert = db.prepare(`
    INSERT INTO users (id, name, phone, password_hash, role, home_lat, home_lng)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO NOTHING
  `);

  const insertedUsers = {};

  for (const u of DEMO_USERS) {
    const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(u.phone);
    if (existing) {
      console.log(`  ↩  ${u.name} already exists — skipping`);
      insertedUsers[u.role] = existing.id;
      continue;
    }
    const hash = await bcrypt.hash(u.password, 12);
    const id = uuidv4();
    upsert.run(id, u.name, u.phone, hash, u.role, u.home_lat, u.home_lng);
    insertedUsers[u.role] = id;
    console.log(`  ✓  Created ${u.name}`);
  }

  const residentId   = insertedUsers['ROLE_RESIDENT'];
  const responderId  = insertedUsers['ROLE_RESPONDER'];

  // ── Historical resolved alerts ─────────────────────────────────────────────
  const categories = ['medical', 'fire', 'vehicle', 'medical', 'other'];
  const coords = [
    { lat: 24.1500, lng: 55.7300 },
    { lat: 24.1750, lng: 55.8100 },
    { lat: 24.0900, lng: 55.6800 },
    { lat: 24.2200, lng: 55.7900 },
    { lat: 24.1300, lng: 55.7600 },
  ];

  let alertsCreated = 0;
  for (let i = 0; i < HISTORY_MINUTES.length; i++) {
    const ackDelayMin = HISTORY_MINUTES[i];
    const createdAt = new Date(Date.now() - (60 + i * 12) * 60_000).toISOString();
    const ackedAt   = new Date(new Date(createdAt).getTime() + ackDelayMin * 60_000).toISOString();
    const resolvedAt = new Date(new Date(ackedAt).getTime() + 15 * 60_000).toISOString();

    const alertId = uuidv4();
    db.prepare(`
      INSERT OR IGNORE INTO alerts
        (id, resident_id, category, note, lat, lng, status, created_at, acknowledged_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, 'resolved', ?, ?, ?)
    `).run(
      alertId, residentId, categories[i],
      'Historical demo alert',
      coords[i].lat, coords[i].lng,
      createdAt, ackedAt, resolvedAt
    );

    db.prepare(`
      INSERT OR IGNORE INTO responder_acknowledgments
        (id, alert_id, responder_id, status, created_at, updated_at)
      VALUES (?, ?, ?, 'acknowledged', ?, ?)
    `).run(uuidv4(), alertId, responderId, ackedAt, ackedAt);

    alertsCreated++;
  }

  if (alertsCreated > 0) {
    console.log(`  ✓  Created ${alertsCreated} historical alerts for stats context`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────────');
  console.log('  Demo credentials (all passwords: demo1234)');
  console.log('─────────────────────────────────────────────');
  for (const u of DEMO_USERS) {
    console.log(`  ${u.role.replace('ROLE_', '').padEnd(12)}  ${u.phone}  /  ${u.password}`);
  }
  console.log('─────────────────────────────────────────────');
  console.log('\n  Run "npm run dev" then open http://localhost:3000\n');
}

seed().catch(err => { console.error(err); process.exit(1); });
