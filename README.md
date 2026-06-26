# Wasl — وصل
**Emergency Alert System for Dispersed Rural Communities**
*Hackathon MVP — Tatweer Challenge 2*

---

## Quick Start

```bash
npm install
npm run dev      # starts server + serves frontend on http://localhost:3000
```

Open http://localhost:3000 in a browser (mobile-first; works on desktop too).

---

## Architecture

```
public/          ← Plain HTML/CSS/JS frontend (no build step)
  index.html     ← SPA shell with all screens
  app.js         ← All frontend logic
  app.css        ← Mobile-first styles
  sw.js          ← Service Worker (PWA installability)
  manifest.json  ← PWA manifest

src/
  db/index.js    ← ALL SQLite access (swap to Postgres here only)
  routes/
    auth.js      ← POST /api/auth/register|login, GET /api/auth/me
    alerts.js    ← POST/GET /api/alerts, POST /api/alerts/:id/acknowledge|resolve
    health.js    ← GET /api/health, /api/stats
  middleware/
    auth.js      ← JWT sign/verify, requireAuth, requireRole middlewares
  sms.js         ← Twilio wrapper with console-log stub fallback
  ws.js          ← WebSocket manager (targeted pushes by userId/role)

server.js        ← Express entry point + WS init
wasl.db          ← SQLite database file (auto-created on first run)
```

**Database**: `node:sqlite` (Node 24 built-in — zero native compilation required).

---

## Roles

| Role | ROLE_ claim | Can do |
|------|-------------|--------|
| Resident | `ROLE_RESIDENT` | Send SOS, track own alerts |
| Responder | `ROLE_RESPONDER` | View all active alerts, acknowledge, update status |
| Coordinator | `ROLE_COORDINATOR` | Everything above + resolve alerts |

---

## API Reference

All protected routes require `Authorization: Bearer <JWT>`.

### Auth
```
POST /api/auth/register   { name, phone, password, role, home_lat?, home_lng? }
POST /api/auth/login      { phone, password }
GET  /api/auth/me
```

### Alerts
```
POST /api/alerts          { lat, lng, accuracy_m?, category, note? }   ROLE_RESIDENT
GET  /api/alerts                                                        any auth
GET  /api/alerts/:id                                                    any auth
POST /api/alerts/:id/acknowledge  { status }                           ROLE_RESPONDER|COORDINATOR
POST /api/alerts/:id/resolve                                           ROLE_COORDINATOR|owner
POST /api/alerts/sms-inbound      (Twilio webhook)                     public
```

### Utility
```
GET /api/health
GET /api/stats    → { total, resolved, acked, avg_ack_seconds, median_ack_seconds }
```

---

## SMS Fallback

**Without Twilio credentials**: SMS is logged to console. App works fully.

**With Twilio**: fill in `.env`:
```
TWILIO_ACCOUNT_SID=ACxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxx
TWILIO_FROM_NUMBER=+1xxxxxxxxxx
```

**Inbound SMS (basic-phone SOS)**:
- Set the Twilio number's SMS webhook to `POST https://<your-domain>/api/alerts/sms-inbound`
- User texts `SOS medical` (or `SOS fire`, `SOS vehicle`, `SOS other`) to the number
- Alert is created flagged "⚠️ NO GPS — call sender for location"
- Coordinator sees it on the dashboard in real time

---

## WebSocket Events

Client connects to `ws://localhost:3000/ws` and sends:
```json
{ "type": "auth", "userId": "<id>", "role": "ROLE_RESPONDER" }
```

Events pushed by server:
| Event | Who receives |
|-------|-------------|
| `new_alert` | All responders + coordinators |
| `alert_update` | Alert's resident + all responders/coordinators |
| `alert_resolved` | Alert's resident + all responders/coordinators |

---

## Security

- Passwords hashed with **bcrypt** (cost 12)
- JWTs signed with **HS256**, verified server-side on every protected route
- Role claims use `ROLE_` prefix consistently in JWT payload and DB
- User enumeration prevented via constant-time dummy hash on missing-user login
- SQL injection: all queries use parameterized prepared statements
- No sensitive data in JWT payload beyond role/name/phone

---

## Demo Flow (for judges)

1. Open http://localhost:3000 — register as a **Resident** (no home_lat/lng needed)
2. In another tab/device — register as a **Responder** with home_lat=24.2075, home_lng=55.7447
3. As Resident: tap SOS → select category → big red button
4. Responder tab updates in real time (WebSocket push)
5. Responder clicks "Acknowledge" → Resident sees status update live
6. Responder clicks "En Route" → status advances
7. Hit `/api/stats` to show timed response data to judges

---

## Environment Variables

See `.env.example`. Copy to `.env` before running.
