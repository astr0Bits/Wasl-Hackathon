/**
 * SMS service — thin wrapper around Twilio that degrades gracefully to
 * console logging when credentials are absent. This lets the demo run
 * without a live Twilio account; swap in real credentials via .env to go live.
 */

let twilioClient = null;

function getClient() {
  if (twilioClient) return twilioClient;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (sid && token && sid.startsWith('AC')) {
    try {
      twilioClient = require('twilio')(sid, token);
      console.log('[SMS] Twilio client initialized');
    } catch (err) {
      console.warn('[SMS] Failed to initialize Twilio:', err.message);
    }
  } else {
    console.log('[SMS] No Twilio credentials — SMS will be logged to console only');
  }

  return twilioClient;
}

/**
 * Send a text message. Falls back to console.log if Twilio is unconfigured.
 * @returns {Promise<{sent: boolean, sid?: string}>}
 */
async function sendSms(to, body) {
  const client = getClient();
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!client || !from) {
    console.log(`[SMS STUB] To: ${to}\nBody: ${body}\n`);
    return { sent: false, stub: true };
  }

  try {
    const msg = await client.messages.create({ to, from, body });
    console.log(`[SMS] Sent to ${to}, SID: ${msg.sid}`);
    return { sent: true, sid: msg.sid };
  } catch (err) {
    console.error(`[SMS] Failed to send to ${to}:`, err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Notify a list of responders about a new alert.
 * @param {Array<{phone: string, name: string}>} responders
 * @param {Object} alert - alert row from DB
 */
async function notifyRespondersOfAlert(responders, alert) {
  const mapsLink = `https://maps.google.com/?q=${alert.lat},${alert.lng}`;
  const categoryLabel = { medical: 'MEDICAL', fire: 'FIRE', vehicle: 'VEHICLE', other: 'EMERGENCY' }[alert.category] ?? 'EMERGENCY';

  const promises = responders.map(r =>
    sendSms(
      r.phone,
      `[Wasl Alert] ${categoryLabel} emergency reported near you.\n` +
      `Location: ${mapsLink}\n` +
      (alert.note ? `Note: ${alert.note}\n` : '') +
      `Alert ID: ${alert.id.slice(0, 8)}\n` +
      `Open Wasl app to respond.`
    )
  );

  return Promise.all(promises);
}

/**
 * Inbound SMS webhook handler (for Express route).
 * A basic-phone user texts a keyword to the Twilio number; we parse it
 * and create an alert with the sender's phone number as identifier.
 *
 * Expected format: "SOS medical" or just "SOS"
 * Coordinates will be null (no GPS on basic phones) — coordinator must
 * manually locate the caller.
 */
function parseInboundSms(body, from) {
  const text = (body || '').trim().toUpperCase();
  if (!text.startsWith('SOS')) return null;

  const parts = text.split(/\s+/);
  const categoryRaw = parts[1]?.toLowerCase();
  const validCategories = ['medical', 'fire', 'vehicle', 'other'];
  const category = validCategories.includes(categoryRaw) ? categoryRaw : 'other';

  return { phone: from, category, note: `Inbound SMS from ${from}: "${body}"` };
}

module.exports = { sendSms, notifyRespondersOfAlert, parseInboundSms };
