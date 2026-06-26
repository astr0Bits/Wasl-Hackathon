const express = require('express');
const { v4: uuidv4 } = require('uuid');
const {
  createAlert, getAlertById, getActiveAlerts, getResolvedAlerts, updateAlertStatus,
  upsertAcknowledgment, getAcknowledgmentsByAlert,
  findRespondersNear, findUserById,
  getAlertStats,
} = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const ws = require('../ws');
const { notifyRespondersOfAlert } = require('../sms');

const router = express.Router();

const RADIUS_KM = parseFloat(process.env.RESPONDER_RADIUS_KM || '50');

// ── Create alert (SOS) ────────────────────────────────────────────────────────

/**
 * POST /api/alerts
 * Body: { lat, lng, accuracy_m?, category, note? }
 * Requires: ROLE_RESIDENT
 *
 * Workflow:
 *  1. Validate + persist alert
 *  2. Find responders within RADIUS_KM
 *  3. Push WS event to all connected responders
 *  4. Fire SMS stub to those responders
 */
router.post('/', requireAuth, requireRole('ROLE_RESIDENT'), async (req, res) => {
  const { lat, lng, accuracy_m, category, note } = req.body;

  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }
  if (!['medical', 'fire', 'vehicle', 'other'].includes(category)) {
    return res.status(400).json({ error: 'category must be medical | fire | vehicle | other' });
  }

  const alert = createAlert({
    id: uuidv4(),
    residentId: req.user.sub,
    category,
    note: note?.trim() || null,
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    accuracyM: accuracy_m ? parseFloat(accuracy_m) : null,
  });

  // Find nearby responders for broadcast
  const nearbyResponders = findRespondersNear(alert.lat, alert.lng, RADIUS_KM);
  const responderIds = nearbyResponders.map(r => r.id);

  // Real-time push to connected responder dashboards
  const wsPayload = {
    type: 'new_alert',
    alert: { ...alert, responder_count: nearbyResponders.length },
  };
  ws.sendToUsers(responderIds, wsPayload);
  // Also broadcast to coordinators
  ws.broadcast(wsPayload, 'ROLE_COORDINATOR');

  // SMS stub — logs to console, sends real SMS if Twilio is configured
  notifyRespondersOfAlert(nearbyResponders, alert).catch(console.error);

  console.log(`[ALERT] ${alert.id} created | category=${category} | ` +
              `lat=${lat},lng=${lng} | responders_notified=${nearbyResponders.length}`);

  res.status(201).json({
    alert,
    responders_notified: nearbyResponders.length,
  });
});

// ── List active alerts ─────────────────────────────────────────────────────────

/**
 * GET /api/alerts
 * Responders and coordinators see all active alerts.
 * Residents see only their own.
 */
router.get('/', requireAuth, (req, res) => {
  let alerts = getActiveAlerts();

  if (req.user.role === 'ROLE_RESIDENT') {
    alerts = alerts.filter(a => a.resident_id === req.user.sub);
  }

  // Attach acknowledgment summary to each alert
  const enriched = alerts.map(a => ({
    ...a,
    acknowledgments: getAcknowledgmentsByAlert(a.id),
  }));

  res.json(enriched);
});

// ── History + stats — MUST be before /:id or Express captures them ────────────

router.get('/history', requireAuth, requireRole('ROLE_RESPONDER', 'ROLE_COORDINATOR'), (req, res) => {
  const alerts = getResolvedAlerts(20);
  const enriched = alerts.map(a => ({
    ...a,
    ack_seconds: a.acknowledged_at
      ? ((new Date(a.acknowledged_at) - new Date(a.created_at)) / 1000).toFixed(1)
      : null,
  }));
  res.json(enriched);
});

router.get('/stats', requireAuth, requireRole('ROLE_RESPONDER', 'ROLE_COORDINATOR'), (req, res) => {
  res.json(getAlertStats());
});

// ── Get single alert ───────────────────────────────────────────────────────────

router.get('/:id', requireAuth, (req, res) => {
  const alert = getAlertById(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });

  // Residents can only view their own alerts
  if (req.user.role === 'ROLE_RESIDENT' && alert.resident_id !== req.user.sub) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({ ...alert, acknowledgments: getAcknowledgmentsByAlert(alert.id) });
});

// ── Acknowledge / update status ────────────────────────────────────────────────

/**
 * POST /api/alerts/:id/acknowledge
 * Body: { status } — one of: acknowledged | en_route | on_scene | stood_down
 * Requires: ROLE_RESPONDER or ROLE_COORDINATOR
 *
 * The alert's top-level status is upgraded if this is the first ack,
 * or if the responder's new status is higher priority.
 */
router.post('/:id/acknowledge', requireAuth, requireRole('ROLE_RESPONDER', 'ROLE_COORDINATOR'), (req, res) => {
  const { status = 'acknowledged' } = req.body;
  const validStatuses = ['acknowledged', 'en_route', 'on_scene', 'stood_down'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  const alert = getAlertById(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (alert.status === 'resolved') {
    return res.status(409).json({ error: 'Alert is already resolved' });
  }

  // Upsert this responder's acknowledgment record
  const ack = upsertAcknowledgment({
    id: uuidv4(),
    alertId: alert.id,
    responderId: req.user.sub,
    status,
  });

  // Upgrade alert's top-level status (escalation order)
  const statusOrder = ['sent', 'acknowledged', 'en_route', 'resolved'];
  const alertStatusMap = { acknowledged: 'acknowledged', en_route: 'en_route', on_scene: 'en_route', stood_down: null };
  const newAlertStatus = alertStatusMap[status];

  let updatedAlert = alert;
  if (newAlertStatus) {
    const currentIdx = statusOrder.indexOf(alert.status);
    const newIdx = statusOrder.indexOf(newAlertStatus);
    if (newIdx > currentIdx) {
      updatedAlert = updateAlertStatus(alert.id, newAlertStatus);
    }
  }

  // Push real-time update to the resident who sent the SOS
  const wsPayload = {
    type: 'alert_update',
    alert: updatedAlert,
    acknowledgment: { ...ack, responder_name: req.user.name },
  };
  ws.sendToUser(updatedAlert.resident_id, wsPayload);
  ws.broadcast(wsPayload, 'ROLE_COORDINATOR');
  ws.broadcast(wsPayload, 'ROLE_RESPONDER');

  console.log(`[ACK] alert=${alert.id} | responder=${req.user.name} | status=${status}`);

  res.json({ alert: updatedAlert, acknowledgment: ack });
});

// ── Resolve alert ─────────────────────────────────────────────────────────────

/**
 * POST /api/alerts/:id/resolve
 * Requires: ROLE_COORDINATOR (or the resident who created it)
 */
router.post('/:id/resolve', requireAuth, (req, res) => {
  const alert = getAlertById(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });

  const isCoordinator = req.user.role === 'ROLE_COORDINATOR';
  const isOwner = alert.resident_id === req.user.sub;
  if (!isCoordinator && !isOwner) {
    return res.status(403).json({ error: 'Only the coordinator or original resident can resolve an alert' });
  }

  const resolved = updateAlertStatus(alert.id, 'resolved');

  const wsPayload = { type: 'alert_resolved', alert: resolved };
  ws.sendToUser(alert.resident_id, wsPayload);
  ws.broadcast(wsPayload, 'ROLE_RESPONDER');
  ws.broadcast(wsPayload, 'ROLE_COORDINATOR');

  console.log(`[RESOLVE] alert=${alert.id} | by=${req.user.name}`);

  res.json(resolved);
});

// ── Inbound SMS webhook ───────────────────────────────────────────────────────

/**
 * POST /api/alerts/sms-inbound
 * Called by Twilio when a text arrives at the Twilio number.
 * A basic-phone user texts "SOS medical" to trigger an alert with no GPS.
 * The coordinator sees it flagged as "SMS/no GPS" and calls the sender back.
 */
router.post('/sms-inbound', async (req, res) => {
  const { parseInboundSms } = require('../sms');
  const parsed = parseInboundSms(req.body.Body, req.body.From);

  if (!parsed) {
    // Not an SOS — send back a help message via TwiML
    return res.type('text/xml').send(
      `<?xml version="1.0"?><Response><Message>Text SOS [category] to request help. Categories: medical, fire, vehicle, other.</Message></Response>`
    );
  }

  // We need a resident account to attach this alert to — look up or create one
  const { findUserByPhone, createUser } = require('../db');
  const { v4: uuidv4 } = require('uuid');
  const bcrypt = require('bcrypt');

  let user = findUserByPhone(parsed.phone);
  if (!user) {
    // Auto-register the SMS sender as a resident with a random password
    const dummyHash = await bcrypt.hash(uuidv4(), 10);
    const newUser = {
      id: uuidv4(),
      name: `SMS User ${parsed.phone}`,
      phone: parsed.phone,
      passwordHash: dummyHash,
      role: 'ROLE_RESIDENT',
      homeLat: null,
      homeLng: null,
    };
    createUser(newUser);
    user = findUserByPhone(parsed.phone);
  }

  // No GPS from SMS — use coordinator's configured default location or null
  const alert = createAlert({
    id: uuidv4(),
    residentId: user.id,
    category: parsed.category,
    note: parsed.note + ' ⚠️ NO GPS — call sender for location',
    lat: 24.2075,  // Al Ain default — coordinator must verify
    lng: 55.7447,
    accuracyM: null,
  });

  ws.broadcast({ type: 'new_alert', alert, sms_source: true }, 'ROLE_COORDINATOR');
  ws.broadcast({ type: 'new_alert', alert, sms_source: true }, 'ROLE_RESPONDER');

  console.log(`[SMS-INBOUND] Alert created from SMS | from=${parsed.phone} | category=${parsed.category}`);

  res.type('text/xml').send(
    `<?xml version="1.0"?><Response><Message>Your SOS has been received. Emergency services are being notified. Stay on the line if possible.</Message></Response>`
  );
});

module.exports = router;
