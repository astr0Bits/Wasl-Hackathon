const express = require('express');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { createUser, findUserByPhone, findUserById } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

// bcrypt cost factor — 12 is strong enough for prod; drops to ~200ms per hash
const BCRYPT_ROUNDS = 12;

/**
 * POST /api/auth/register
 * Body: { name, phone, password, role, home_lat?, home_lng? }
 *
 * role must be one of: ROLE_RESIDENT | ROLE_RESPONDER | ROLE_COORDINATOR
 * Responders and coordinators should supply home_lat/home_lng for radius matching.
 */
router.post('/register', async (req, res) => {
  const { name, phone, password, role, home_lat, home_lng } = req.body;

  if (!name || !phone || !password || !role) {
    return res.status(400).json({ error: 'name, phone, password, role are required' });
  }

  const validRoles = ['ROLE_RESIDENT', 'ROLE_RESPONDER', 'ROLE_COORDINATOR'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  // Sanitize phone to E.164-ish — strip spaces, ensure + prefix
  const normalizedPhone = phone.replace(/\s+/g, '');

  if (findUserByPhone(normalizedPhone)) {
    return res.status(409).json({ error: 'Phone number already registered' });
  }

  // bcrypt hash — deliberately slow to resist brute-force attacks
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = {
    id: uuidv4(),
    name: name.trim(),
    phone: normalizedPhone,
    passwordHash,
    role,
    homeLat: home_lat ?? null,
    homeLng: home_lng ?? null,
  };

  createUser(user);

  const token = signToken(user);

  res.status(201).json({
    token,
    user: { id: user.id, name: user.name, phone: user.phone, role: user.role },
  });
});

/**
 * POST /api/auth/login
 * Body: { phone, password }
 */
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: 'phone and password are required' });
  }

  const user = findUserByPhone(phone.replace(/\s+/g, ''));

  // Use a constant-time comparison even when user not found (timing-safe)
  const dummyHash = '$2b$12$invalidhashusedtopreventidenumeration000000000000000000000';
  const match = user
    ? await bcrypt.compare(password, user.password_hash)
    : await bcrypt.compare(password, dummyHash); // prevent user-enumeration via timing

  if (!user || !match) {
    return res.status(401).json({ error: 'Invalid phone number or password' });
  }

  const token = signToken(user);

  res.json({
    token,
    user: { id: user.id, name: user.name, phone: user.phone, role: user.role },
  });
});

/**
 * GET /api/auth/me
 * Returns the current user's profile. Useful for the frontend to verify a stored token.
 */
router.get('/me', requireAuth, (req, res) => {
  const user = findUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, name: user.name, phone: user.phone, role: user.role });
});

module.exports = router;
