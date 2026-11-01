const crypto = require('node:crypto');

const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('JWT_SECRET not set: using a random one, tokens reset on restart');
const TOKEN_TTL_S = 24 * 3600;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(password, salt, 64));
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

// Standard HS256 JWT, built on node:crypto so there's no jsonwebtoken dependency.
function issueToken(user) {
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: user.id, role: user.role, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S,
  })}`;
  return `${body}.${sign(body)}`;
}

function verifyToken(token) {
  const [h, p, s] = String(token).split('.');
  if (!s) return null;
  const expected = sign(`${h}.${p}`);
  if (s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    return claims.exp > Date.now() / 1000 ? claims : null;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const claims = verifyToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!claims) return res.status(401).json({ error: 'missing or invalid token' });
  req.user = { id: claims.sub, role: claims.role };
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' })));
}

module.exports = { hashPassword, checkPassword, issueToken, requireAuth, requireAdmin };
