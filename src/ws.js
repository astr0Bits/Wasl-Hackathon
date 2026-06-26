/**
 * WebSocket manager — tracks connected clients by userId and role so we
 * can push targeted events without a separate pub/sub service.
 */

const WebSocket = require('ws');

let _wss = null;

// Map<userId, WebSocket> — keeps only the most recent connection per user
const clients = new Map();

function init(server) {
  _wss = new WebSocket.Server({ server, path: '/ws' });

  _wss.on('connection', (ws, req) => {
    // Client sends {type:'auth', token:'...'} as the first message to register
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'auth' && msg.userId && msg.role) {
          ws.userId = msg.userId;
          ws.role = msg.role;
          clients.set(msg.userId, ws);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        }
      } catch { /* ignore malformed frames */ }
    });

    ws.on('close', () => {
      if (ws.userId) clients.delete(ws.userId);
    });

    ws.on('error', (err) => {
      console.error('[WS] client error:', err.message);
    });
  });

  console.log('[WS] WebSocket server ready on /ws');
  return _wss;
}

/**
 * Broadcast an event to all connected clients matching an optional role filter.
 */
function broadcast(event, roleFilter = null) {
  const payload = JSON.stringify(event);
  for (const ws of clients.values()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (roleFilter && ws.role !== roleFilter) continue;
    ws.send(payload);
  }
}

/**
 * Send an event to a single user by ID.
 */
function sendToUser(userId, event) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
    return true;
  }
  return false;
}

/**
 * Send to a list of user IDs (e.g. nearby responders).
 */
function sendToUsers(userIds, event) {
  userIds.forEach(id => sendToUser(id, event));
}

module.exports = { init, broadcast, sendToUser, sendToUsers };
