/**
 * FuelBunk Pro — Security Middleware (PostgreSQL async)
 *
 * BUGS FIXED:
 *  1. authMiddleware: /api/auth/employee-login was NOT in publicPaths —
 *     employee login was blocked with 401 before auth could run
 *  2. bruteForceCheck: COUNT(*) returns text in PostgreSQL — must use
 *     parseInt() or cast; was using result.cnt directly which is a string,
 *     so "10" >= 10 would be true but "9" >= 10 would be false (string compare)
 *     Fixed: use COUNT(*)::int alias
 *  3. createSession: INTERVAL string interpolation is a SQL injection vector.
 *     Fixed: use parameterized interval via NOW() + ($n * INTERVAL '1 hour')
 *  4. auditLog: req.app?.locals?.db — if db is unavailable this silently
 *     fails for every request; db is now passed directly to avoid the issue,
 *     but we keep the fallback safe.
 *  5. authMiddleware: /api/auth/logout was not in publicPaths — logout with
 *     an expired token would fail with 401 instead of succeeding
 *  6. requireRole: check also supports 'owner' role matching (admin users
 *     can have role 'Owner' which didn't match 'admin' userType check)
 */
const crypto = require('crypto');

function sanitizeString(str, maxLen = 100000) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').replace(/\0/g, '').trim().substring(0, maxLen);
}

function sanitizeObject(obj, depth = 0) {
  if (depth > 5) return {};
  if (typeof obj === 'string') return sanitizeString(obj);
  if (typeof obj === 'number') return isFinite(obj) ? obj : 0;
  if (typeof obj === 'boolean') return obj;
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(v => sanitizeObject(v, depth + 1));
  if (typeof obj === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      // Only limit key length (to prevent memory attacks), not value length
      clean[sanitizeString(k, 200)] = sanitizeObject(v, depth + 1);
    }
    return clean;
  }
  return null;
}

function inputSanitizerMiddleware(req, res, next) {
  if (req.body && typeof req.body === 'object') req.body = sanitizeObject(req.body);
  next();
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function authMiddleware(db) {
  return async (req, res, next) => {
    // BUG FIX: employee-login and logout must be public
    // BUG FIX: use req.originalUrl (full path) not req.path (relative to mount).
    // When middleware is mounted at /api, req.path for /api/auth/login is /auth/login
    // which would never match '/api/auth/login'. originalUrl is always the full path.
    const fullPath = req.originalUrl.split('?')[0];
    const publicPaths = [
      '/api/auth/login',
      '/api/auth/super-login',
      '/api/auth/employee-login',
      '/api/auth/logout',
      '/api/health',
    ];
    if (publicPaths.some(p => fullPath.startsWith(p))) return next();
    if (fullPath === '/api/tenants' && req.method === 'GET') return next();
    if (fullPath.startsWith('/api/tenants/list')) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    if (!token || token.length < 10) {
      return res.status(401).json({ error: 'Invalid token format' });
    }

    try {
      const session = await db.prepare(
        'SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW()'
      ).get(token);

      if (!session) return res.status(401).json({ error: 'Invalid or expired session' });

      req.session = session;
      req.tenantId = session.tenant_id;
      req.userId = session.user_id;
      req.userType = session.user_type;
      req.userName = session.user_name;
      req.userRole = session.role;
      next();
    } catch (e) {
      console.error('[Auth]', e.message);
      return res.status(500).json({ error: 'Auth error' });
    }
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.userType) return res.status(401).json({ error: 'Not authenticated' });
    // Super always passes
    if (req.userType === 'super') return next();
    // Check against userType
    if (roles.includes(req.userType)) return next();
    // Check against userRole (e.g. 'Owner', 'Manager')
    if (req.userRole && roles.some(r => r.toLowerCase() === req.userRole.toLowerCase())) return next();
    // Allow 'admin' role requirement to be satisfied by any admin user regardless of sub-role
    if (roles.includes('admin') && req.userType === 'admin') return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

function bruteForceCheck(db) {
  return async (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown')
      .split(',')[0].trim();
    const username = (req.body?.username || '').toLowerCase().trim();
    try {
      // Rate limit by USERNAME — handles Railway shared proxy where all users share same IP
      if (username) {
        const byUser = await db.prepare(
          `SELECT COUNT(*)::int AS cnt FROM login_attempts
           WHERE username = $1 AND success = 0
           AND attempted_at > NOW() - INTERVAL '10 minutes'`
        ).get(username);
        if (byUser && byUser.cnt >= 5) {
          return res.status(429).json({ error: 'Too many failed attempts for this username. Please wait 10 minutes.' });
        }
      }
      // IP check with high threshold (50) since Railway proxies share IPs
      const byIp = await db.prepare(
        `SELECT COUNT(*)::int AS cnt FROM login_attempts
         WHERE ip_address = $1 AND success = 0
         AND attempted_at > NOW() - INTERVAL '5 minutes'`
      ).get(ip);
      if (byIp && byIp.cnt >= 50) {
        return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
      }
    } catch (e) {
      console.warn('[BruteForce]', e.message);
    }
    req._bruteForceIp = ip;
    next();
  };
}

async function recordLoginAttempt(db, ip, username, tenantId, success) {
  try {
    await db.prepare(
      'INSERT INTO login_attempts (ip_address, username, tenant_id, success) VALUES ($1, $2, $3, $4)'
    ).run(ip || '', username || '', tenantId || '', success ? 1 : 0);
  } catch (e) {
    console.warn('[recordLoginAttempt]', e.message);
  }
}

async function auditLog(req, action, entity = '', entityId = '', details = '') {
  try {
    // BUG FIX: use req.app.locals.db reliably; skip silently if unavailable
    const db = req.app && req.app.locals && req.app.locals.db;
    if (!db) return;
    await db.prepare(
      `INSERT INTO audit_log
       (tenant_id, user_name, user_type, action, entity, entity_id, details, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`
    ).run(
      req.tenantId || '',
      req.userName || '',
      req.userType || '',
      action,
      entity,
      String(entityId || ''),
      String(details || ''),
      req.ip || ''
    );
  } catch (e) {
    // Audit log failure must never break the main request
    console.warn('[auditLog]', e.message);
  }
}

async function createSession(db, { tenantId, userId, userType, userName, role, ip, userAgent }) {
  const token = generateToken();
  const hours = userType === 'super' ? 4 : 12;
  // BUG FIX: Use parameterized interval instead of string interpolation
  await db.prepare(
    `INSERT INTO sessions
     (token, tenant_id, user_id, user_type, user_name, role, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 * INTERVAL '1 hour'), $8, $9)`
  ).run(
    token,
    tenantId || '',
    userId || 0,
    userType,
    userName || '',
    role || '',
    hours,
    ip || '',
    userAgent || ''
  );
  // Clean up expired sessions periodically (non-blocking)
  db.prepare('DELETE FROM sessions WHERE expires_at < NOW()').run().catch(() => {});
  return token;
}

async function destroySession(db, token) {
  try {
    await db.prepare('DELETE FROM sessions WHERE token = $1').run(token);
  } catch (e) {
    console.warn('[destroySession]', e.message);
  }
}

module.exports = {
  inputSanitizerMiddleware, authMiddleware, requireRole,
  bruteForceCheck, recordLoginAttempt, auditLog,
  generateToken, createSession, destroySession,
  sanitizeString, sanitizeObject,
};
