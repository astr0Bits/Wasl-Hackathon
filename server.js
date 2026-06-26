require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');

const ws = require('./src/ws');
const healthRouter  = require('./src/routes/health');
const authRouter    = require('./src/routes/auth');
const alertsRouter  = require('./src/routes/alerts');

const app = express();
const server = http.createServer(app);

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/alerts', alertsRouter);

// ── 404 catch-all for API routes ───────────────────────────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── SPA fallback: serve index.html for all non-API GET requests ────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── WebSocket ──────────────────────────────────────────────────────────────────
ws.init(server);

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
  ██╗    ██╗ █████╗ ███████╗██╗
  ██║    ██║██╔══██╗██╔════╝██║
  ██║ █╗ ██║███████║███████╗██║
  ██║███╗██║██╔══██║╚════██║██║
  ╚███╔███╔╝██║  ██║███████║███████╗
   ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚══════╝  وصل

  Server running on http://localhost:${PORT}
  Health:  http://localhost:${PORT}/api/health
  Stats:   http://localhost:${PORT}/api/stats
  `);
});

module.exports = { app, server };
