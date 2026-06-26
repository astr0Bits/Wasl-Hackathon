const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '12h';

/**
 * Sign a JWT for the given user. Claims use ROLE_ prefix so it's
 * explicit in Q&A that this is a role claim, not a scope or resource.
 */
function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      name: user.name,
      phone: user.phone,
      role: user.role,   // e.g. 'ROLE_RESPONDER'
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Middleware: verify JWT from Authorization: Bearer <token> header.
 * Attaches decoded payload to req.user on success.
 */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = header.slice(7);
  try {
    // jwt.verify throws on expired, tampered, or invalid tokens
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Middleware factory: restrict route to specific ROLE_ values.
 * Always chain after requireAuth.
 *
 * Usage: router.post('/foo', requireAuth, requireRole('ROLE_RESPONDER', 'ROLE_COORDINATOR'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden — required role: ${roles.join(' or ')}`,
      });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireRole };
