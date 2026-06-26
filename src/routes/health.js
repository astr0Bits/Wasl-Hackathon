const express = require('express');
const { getDb, getAlertStats } = require('../db');

const router = express.Router();

router.get('/health', (req, res) => {
  // Ping the DB with a trivial query to confirm connectivity
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: err.message });
  }
});

router.get('/stats', (req, res) => {
  try {
    res.json(getAlertStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
