/* ═══════════════════════════════════════════════════════════════════
   Wasl (وصل) — Emergency Alert System
   Single-file frontend — no build step required
   ═══════════════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  token: null,
  user: null,
  geoPosition: null,
  geoError: null,
  geoWatchId: null,
  selectedCategory: 'medical',
  activeAlerts: [],
  alertMaps: {},      // alertId → Leaflet map instance
  ws: null,
  wsConnected: false,
};

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Restore session from localStorage
  const savedToken = localStorage.getItem('wasl_token');
  const savedUser  = localStorage.getItem('wasl_user');
  if (savedToken && savedUser) {
    state.token = savedToken;
    state.user  = JSON.parse(savedUser);
    showApp();
  } else {
    showScreen('login');
  }
});

// ── Screen routing ─────────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${name}`);
  if (el) el.classList.add('active');
}

function showApp() {
  updateNavbar();
  connectWs();
  startGeoWatch();

  if (state.user.role === 'ROLE_RESIDENT') {
    showScreen('resident');
    loadMyAlerts();
  } else {
    showScreen('dashboard');
    loadDashboard();
  }
}

// ── Navbar ─────────────────────────────────────────────────────────────────────
function updateNavbar() {
  document.getElementById('navbar').style.display = 'flex';
  document.getElementById('nav-name').textContent = state.user.name;

  const roleLabel = { ROLE_RESIDENT: 'Resident', ROLE_RESPONDER: 'Responder', ROLE_COORDINATOR: 'Coordinator' }[state.user.role] || state.user.role;
  const roleClass = { ROLE_RESIDENT: 'resident', ROLE_RESPONDER: 'responder', ROLE_COORDINATOR: 'coordinator' }[state.user.role] || '';
  const badge = document.getElementById('nav-role');
  badge.textContent = roleLabel;
  badge.className = `badge badge-${roleClass}`;
}

// ── Auth ───────────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('register-fields').style.display  = 'none';
  document.getElementById('login-submit').style.display     = 'block';
  document.getElementById('register-submit').style.display  = 'none';
  document.getElementById('auth-password').setAttribute('autocomplete', 'current-password');
}
function showRegister() {
  document.getElementById('register-fields').style.display  = 'block';
  document.getElementById('login-submit').style.display     = 'none';
  document.getElementById('register-submit').style.display  = 'block';
  document.getElementById('auth-password').setAttribute('autocomplete', 'new-password');
}

async function submitLogin(e) {
  e.preventDefault();
  const phone    = document.getElementById('auth-phone').value.trim();
  const password = document.getElementById('auth-password').value;

  const data = await api('POST', '/api/auth/login', { phone, password });
  if (!data) return;

  saveSession(data.token, data.user);
  showApp();
}

async function submitRegister(e) {
  e.preventDefault();
  const name     = document.getElementById('reg-name').value.trim();
  const phone    = document.getElementById('auth-phone').value.trim();
  const password = document.getElementById('auth-password').value;
  const role     = document.getElementById('reg-role').value;
  const home_lat = parseFloat(document.getElementById('reg-lat').value) || null;
  const home_lng = parseFloat(document.getElementById('reg-lng').value) || null;

  const data = await api('POST', '/api/auth/register', { name, phone, password, role, home_lat, home_lng });
  if (!data) return;

  saveSession(data.token, data.user);
  showApp();
}

function saveSession(token, user) {
  state.token = token;
  state.user  = user;
  localStorage.setItem('wasl_token', token);
  localStorage.setItem('wasl_user', JSON.stringify(user));
}

function logout() {
  state.token = null;
  state.user  = null;
  localStorage.removeItem('wasl_token');
  localStorage.removeItem('wasl_user');
  stopGeoWatch();
  if (state.ws) state.ws.close();
  document.getElementById('navbar').style.display = 'none';
  showScreen('login');
}

// ── Geolocation ───────────────────────────────────────────────────────────────
function startGeoWatch() {
  if (!navigator.geolocation) {
    state.geoError = 'Geolocation not supported';
    updateGeoStatus();
    return;
  }

  updateGeoStatus('acquiring');

  state.geoWatchId = navigator.geolocation.watchPosition(
    pos => {
      state.geoPosition = pos;
      state.geoError    = null;
      updateGeoStatus('acquired');
    },
    err => {
      state.geoError = err.message;
      updateGeoStatus('error');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

function stopGeoWatch() {
  if (state.geoWatchId != null) {
    navigator.geolocation.clearWatch(state.geoWatchId);
    state.geoWatchId = null;
  }
}

function updateGeoStatus(status) {
  const el = document.getElementById('geo-status');
  if (!el) return;
  const dot = el.querySelector('.geo-dot');
  const txt = el.querySelector('.geo-text');
  if (!dot || !txt) return;

  if (status === 'acquiring') {
    dot.className = 'geo-dot acquiring';
    txt.textContent = 'Acquiring GPS…';
  } else if (status === 'acquired' && state.geoPosition) {
    const { latitude: lat, longitude: lng, accuracy } = state.geoPosition.coords;
    dot.className = 'geo-dot acquired';
    txt.textContent = `GPS locked — ${lat.toFixed(5)}, ${lng.toFixed(5)} (±${Math.round(accuracy)}m)`;
  } else if (status === 'error') {
    dot.className = 'geo-dot error';
    txt.textContent = `GPS unavailable: ${state.geoError}`;
  }
}

// ── SOS ───────────────────────────────────────────────────────────────────────
function selectCategory(cat) {
  state.selectedCategory = cat;
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('selected'));
  document.querySelector(`.cat-btn[data-cat="${cat}"]`)?.classList.add('selected');
}

async function sendSOS() {
  const btn = document.getElementById('sos-btn');
  if (btn.classList.contains('sending')) return;

  if (!state.geoPosition) {
    toast('Waiting for GPS lock — try again in a moment', 'error');
    return;
  }

  btn.classList.add('sending');
  btn.querySelector('.sos-label').textContent = '…';
  btn.querySelector('.sos-sub').textContent   = 'Sending';

  const { latitude: lat, longitude: lng, accuracy: accuracy_m } = state.geoPosition.coords;
  const note = document.getElementById('sos-note').value.trim() || null;

  const data = await api('POST', '/api/alerts', {
    lat, lng, accuracy_m, category: state.selectedCategory, note,
  });

  btn.classList.remove('sending');
  btn.querySelector('.sos-label').textContent = 'SOS';
  btn.querySelector('.sos-sub').textContent   = 'Press in emergency';

  if (!data) return;

  document.getElementById('sos-note').value = '';
  toast(`SOS sent! ${data.responders_notified} responder(s) notified.`, 'success');
  showScreen('my-alert');
  renderMyAlert(data.alert);
}

// ── My alert (resident view of their own alert status) ────────────────────────
function renderMyAlert(alert) {
  const container = document.getElementById('my-alert-detail');

  const steps = ['sent', 'acknowledged', 'en_route', 'resolved'];
  const stepIcons = { sent: '📡', acknowledged: '✓', en_route: '🚑', resolved: '✅' };
  const stepLabels = { sent: 'Sent', acknowledged: 'Acknowledged', en_route: 'En Route', resolved: 'Resolved' };
  const currentIdx = steps.indexOf(alert.status);

  const trackHtml = steps.map((s, i) => {
    const cls = i < currentIdx ? 'done' : i === currentIdx ? 'active' : '';
    return `<div class="status-step ${cls}">
      <div class="status-dot">${stepIcons[s]}</div>
      <span>${stepLabels[s]}</span>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div class="alert-card cat-${alert.category}">
      <div class="alert-header">
        <span class="alert-category">${categoryLabel(alert.category)}</span>
        <span class="status-pill pill-${alert.status}">${alert.status.replace('_', ' ')}</span>
        <span class="alert-time">${timeAgo(alert.created_at)}</span>
      </div>
      ${alert.note ? `<p class="alert-note">${escHtml(alert.note)}</p>` : ''}
      <p class="alert-coords">📍 ${alert.lat.toFixed(6)}, ${alert.lng.toFixed(6)}</p>
    </div>

    <div class="status-track mt-2">${trackHtml}</div>

    <div id="my-ack-list" class="responder-acks">
      <em class="text-muted text-sm">Waiting for responder acknowledgment…</em>
    </div>

    <div class="map-container mt-2" id="my-alert-map"></div>

    <div class="mt-2">
      <button class="btn btn-outline" onclick="showScreen('resident')">← Back</button>
    </div>
  `;

  // Render Leaflet map
  setTimeout(() => {
    const map = L.map('my-alert-map').setView([alert.lat, alert.lng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    L.marker([alert.lat, alert.lng])
      .addTo(map)
      .bindPopup('<b>Your location</b>')
      .openPopup();
  }, 100);
}

// ── Load resident's own alerts ─────────────────────────────────────────────────
async function loadMyAlerts() {
  const alerts = await api('GET', '/api/alerts');
  if (!alerts) return;
  const list = document.getElementById('my-alerts-list');
  if (alerts.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📡</div><p>No active alerts</p></div>`;
    return;
  }
  list.innerHTML = alerts.map(a => alertCardHtml(a, false)).join('');
}

// ── Responder / Coordinator dashboard ─────────────────────────────────────────
async function loadDashboard() {
  const [alerts] = await Promise.all([
    api('GET', '/api/alerts'),
    loadStats(),
  ]);
  if (!alerts) return;
  state.activeAlerts = alerts;
  renderDashboard();
}

async function loadStats() {
  const stats = await api('GET', '/api/alerts/stats');
  if (!stats) return;

  const bar = document.getElementById('stats-bar');
  if (bar) bar.style.display = 'grid';

  document.getElementById('stat-total').textContent    = stats.total ?? '—';
  document.getElementById('stat-resolved').textContent = stats.resolved ?? '—';
  document.getElementById('stat-avg').textContent      = stats.avg_ack_seconds != null
    ? formatAckTime(stats.avg_ack_seconds) : '—';
  document.getElementById('stat-median').textContent   = stats.median_ack_seconds != null
    ? formatAckTime(stats.median_ack_seconds) : '—';
}

function formatAckTime(seconds) {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

async function loadHistory() {
  const alerts = await api('GET', '/api/alerts/history');
  if (!alerts) return;

  const list = document.getElementById('history-alerts');
  if (alerts.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><p>No resolved alerts yet</p></div>`;
    return;
  }

  const catIcon = { medical: '🏥', fire: '🔥', vehicle: '🚗', other: '⚠️' };
  list.innerHTML = alerts.map(a => `
    <div class="history-card">
      <div class="cat-icon">${catIcon[a.category] || '⚠️'}</div>
      <div class="hist-body">
        <div class="hist-title">${categoryLabel(a.category)}</div>
        <div class="hist-meta">
          📍 ${a.lat.toFixed(4)}, ${a.lng.toFixed(4)} &nbsp;·&nbsp; ${timeAgo(a.resolved_at)}
          ${a.note ? `<br>${escHtml(a.note).substring(0, 60)}` : ''}
        </div>
      </div>
      ${a.ack_seconds != null
        ? `<div class="ack-time">${formatAckTime(parseFloat(a.ack_seconds))}<span>ack time</span></div>`
        : '<div class="ack-time">—<span>ack time</span></div>'}
    </div>
  `).join('');
}

function switchTab(tab) {
  document.getElementById('tab-panel-active').style.display  = tab === 'active'  ? 'block' : 'none';
  document.getElementById('tab-panel-history').style.display = tab === 'history' ? 'block' : 'none';
  document.getElementById('tab-active').classList.toggle('active',  tab === 'active');
  document.getElementById('tab-history').classList.toggle('active', tab === 'history');
  if (tab === 'history') loadHistory();
}

function renderDashboard() {
  const list  = document.getElementById('dashboard-alerts');
  const count = document.getElementById('dashboard-count');
  count.textContent = state.activeAlerts.length;

  if (state.activeAlerts.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><p>No active alerts — all clear</p></div>`;
    return;
  }

  list.innerHTML = state.activeAlerts.map(a => alertCardHtml(a, true)).join('');

  // Render maps for each alert card
  state.activeAlerts.forEach(a => {
    const mapEl = document.getElementById(`map-${a.id}`);
    if (mapEl && !state.alertMaps[a.id]) {
      setTimeout(() => {
        const map = L.map(`map-${a.id}`).setView([a.lat, a.lng], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap contributors'
        }).addTo(map);
        L.marker([a.lat, a.lng])
          .addTo(map)
          .bindPopup(`<b>${categoryLabel(a.category)}</b><br>${a.note || ''}`)
          .openPopup();
        state.alertMaps[a.id] = map;
      }, 50);
    }
  });
}

function alertCardHtml(alert, showActions) {
  const acks = alert.acknowledgments || [];
  const ackHtml = acks.length > 0
    ? acks.map(ack => `
        <div class="ack-row">
          <span>👤 ${escHtml(ack.responder_name)}</span>
          <span class="status-pill pill-${ack.status}" style="margin-left:auto">${ack.status.replace('_',' ')}</span>
        </div>`).join('')
    : '<span class="text-muted text-sm">No acknowledgments yet</span>';

  const actionButtons = showActions && alert.status !== 'resolved'
    ? `<div class="alert-actions">
        <button class="btn btn-success btn-sm" onclick="acknowledge('${alert.id}','acknowledged')">✓ Acknowledge</button>
        <button class="btn btn-primary btn-sm" onclick="acknowledge('${alert.id}','en_route')">🚑 En Route</button>
        <button class="btn btn-outline btn-sm" onclick="resolveAlert('${alert.id}')">✅ Resolve</button>
       </div>`
    : '';

  return `
    <div class="alert-card cat-${alert.category}" id="card-${alert.id}">
      <div class="alert-header">
        <span class="alert-category">${categoryLabel(alert.category)}</span>
        <span class="status-pill pill-${alert.status}" id="pill-${alert.id}">${alert.status.replace('_',' ')}</span>
        <span class="alert-time">${timeAgo(alert.created_at)}</span>
      </div>
      ${alert.note ? `<p class="alert-note">${escHtml(alert.note)}</p>` : ''}
      <p class="alert-coords">📍 ${alert.lat.toFixed(6)}, ${alert.lng.toFixed(6)} ${alert.accuracy_m ? `(±${Math.round(alert.accuracy_m)}m)` : ''}</p>
      <div class="responder-acks" id="acks-${alert.id}">${ackHtml}</div>
      <div class="map-container" id="map-${alert.id}"></div>
      ${actionButtons}
    </div>`;
}

// ── Responder actions ─────────────────────────────────────────────────────────
async function acknowledge(alertId, status) {
  const data = await api('POST', `/api/alerts/${alertId}/acknowledge`, { status });
  if (!data) return;
  toast(`Status updated: ${status.replace('_', ' ')}`, 'success');
  // WS will push the update; but also refresh in case WS is lagged
  loadDashboard();
}

async function resolveAlert(alertId) {
  if (!confirm('Mark this alert as resolved?')) return;
  const data = await api('POST', `/api/alerts/${alertId}/resolve`);
  if (!data) return;
  toast('Alert resolved', 'success');
  loadDashboard();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${proto}://${location.host}/ws`;

  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    state.wsConnected = true;
    updateConnIndicator();
    // Register this client so server can target it by userId+role
    ws.send(JSON.stringify({ type: 'auth', userId: state.user.id, role: state.user.role }));
  };

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleWsEvent(msg);
  };

  ws.onclose = () => {
    state.wsConnected = false;
    updateConnIndicator();
    // Reconnect after 3 seconds
    setTimeout(() => { if (state.token) connectWs(); }, 3000);
  };

  ws.onerror = () => ws.close();
}

function handleWsEvent(msg) {
  if (msg.type === 'new_alert') {
    if (state.user.role !== 'ROLE_RESIDENT') {
      toast(`New ${categoryLabel(msg.alert.category)} alert received!`, 'info');
      loadDashboard();
    }
  }

  if (msg.type === 'alert_update') {
    // Update status pill and ack list in place if visible
    const pill = document.getElementById(`pill-${msg.alert.id}`);
    if (pill) {
      pill.textContent = msg.alert.status.replace('_', ' ');
      pill.className = `status-pill pill-${msg.alert.status}`;
    }
    const ackList = document.getElementById(`acks-${msg.alert.id}`);
    if (ackList && msg.acknowledgment) {
      const row = document.createElement('div');
      row.className = 'ack-row';
      row.innerHTML = `<span>👤 ${escHtml(msg.acknowledgment.responder_name)}</span>
        <span class="status-pill pill-${msg.acknowledgment.status}" style="margin-left:auto">${msg.acknowledgment.status.replace('_',' ')}</span>`;
      // Replace placeholder if present
      if (ackList.querySelector('em')) ackList.innerHTML = '';
      ackList.appendChild(row);
    }

    // Resident view — update status track
    if (state.user.role === 'ROLE_RESIDENT') {
      const isMyAlert = msg.alert.resident_id === state.user.id;
      if (isMyAlert) {
        toast(`Responder ${msg.acknowledgment?.responder_name || ''} is ${msg.alert.status.replace('_', ' ')}`, 'info');
        renderMyAlert({ ...msg.alert, acknowledgments: [msg.acknowledgment] });
      }
    }
  }

  if (msg.type === 'alert_resolved') {
    toast('Alert resolved — emergency cleared', 'success');
    if (state.user.role !== 'ROLE_RESIDENT') loadDashboard();
  }
}

function updateConnIndicator() {
  const dot = document.getElementById('conn-dot');
  if (!dot) return;
  dot.className = `conn-indicator ${state.wsConnected ? 'connected' : 'disconnected'}`;
  dot.title = state.wsConnected ? 'Live — connected' : 'Reconnecting…';
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (state.token) opts.headers['Authorization'] = `Bearer ${state.token}`;
  if (body) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(path, opts);
    const json = await res.json();
    if (!res.ok) {
      toast(json.error || `Error ${res.status}`, 'error');
      return null;
    }
    return json;
  } catch (err) {
    toast('Network error — check connection', 'error');
    return null;
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function categoryLabel(cat) {
  return { medical: '🏥 Medical', fire: '🔥 Fire', vehicle: '🚗 Vehicle', other: '⚠️ Other' }[cat] || cat;
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)  return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
