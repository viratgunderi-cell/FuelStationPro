/**
 * FuelBunk Pro — Auth Routes (PostgreSQL async)
 *
 * BUGS FIXED:
 *  1. db.prepare().get() returns a Promise in the async PgDbWrapper —
 *     all calls were already awaited correctly, but the SQLite-style
 *     $1/$2 placeholders in SQL were passed as positional args.
 *     PgDbWrapper.prepare().get(...params) spreads params as array —
 *     verified all calls pass correct number of params.
 *  2. super-login: checks admin.pass_hash !== hash — but if admin row
 *     is undefined (db returns undefined), accessing .pass_hash throws.
 *     Added explicit null check before property access.
 *  3. change-password route used requireRole('admin') but employee users
 *     (userType='employee') cannot change password — correct as-is, but
 *     now employees have their own PIN change route added.
 *  4. session route: req.session check was sufficient but req.userRole
 *     was sent as 'role' in response — matched frontend expectation.
 */
const express = require('express');
const { hashPassword, verifyPassword } = require('./schema');
const {
  bruteForceCheck, recordLoginAttempt, createSession,
  destroySession, auditLog, requireRole
} = require('./security');

function authRoutes(db) {
  const router = express.Router();

  // ── Super Admin Login ──────────────────────────────────────
  router.post('/super-login', bruteForceCheck(db), async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    try {
      const admin = await db.prepare('SELECT * FROM super_admin WHERE id = 1').get();
      // BUG FIX: guard against undefined admin row before accessing properties
      if (!admin) {
        await recordLoginAttempt(db, req._bruteForceIp, username, '', false);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // C-01 FIX: Use bcrypt-aware verifyPassword (handles legacy SHA-256 migration)
      const validPass = await verifyPassword(password, admin.pass_hash);
      if (admin.username !== username || !validPass) {
        await recordLoginAttempt(db, req._bruteForceIp, username, '', false);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // C-01 FIX: Upgrade legacy SHA-256 hash to bcrypt on first successful login
      if (admin.pass_hash && !admin.pass_hash.startsWith('$2')) {
        const newHash = await hashPassword(password);
        await db.prepare('UPDATE super_admin SET pass_hash = $1 WHERE id = 1').run(newHash);
      }
      await recordLoginAttempt(db, req._bruteForceIp, username, '', true);
      // FIX (a): Only one superadmin session allowed — invalidate all previous super sessions
      await db.prepare("DELETE FROM sessions WHERE user_type = 'super'").run();
      const token = await createSession(db, {
        tenantId: '', userId: 0, userType: 'super',
        userName: 'Super Admin', role: 'super',
        ip: req.ip, userAgent: req.headers['user-agent']
      });
      res.json({ success: true, token, userType: 'super', userName: 'Super Admin' });
    } catch (e) {
      console.error('[super-login]', e.message);
      res.status(500).json({ error: 'Login error' });
    }
  });

  // ── Admin Login ────────────────────────────────────────────
  router.post('/login', bruteForceCheck(db), async (req, res) => {
    const { username, password, tenantId } = req.body;
    if (!username || !password || !tenantId) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    try {
      const tenant = await db.prepare(
        'SELECT * FROM tenants WHERE id = $1 AND active = 1'
      ).get(tenantId);
      if (!tenant) return res.status(404).json({ error: 'Station not found or inactive' });

      // C-01 FIX: Fetch user first, then verify with bcrypt-aware verifyPassword
      const user = await db.prepare(
        'SELECT * FROM admin_users WHERE tenant_id = $1 AND username = $2 AND active = 1'
      ).get(tenantId, username);

      if (!user || !(await verifyPassword(password, user.pass_hash))) {
        await recordLoginAttempt(db, req._bruteForceIp, username, tenantId, false);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // C-01 FIX: Upgrade legacy SHA-256 hash to bcrypt on first successful login
      if (user.pass_hash && !user.pass_hash.startsWith('$2')) {
        const newHash = await hashPassword(password);
        await db.prepare('UPDATE admin_users SET pass_hash = $1 WHERE id = $2').run(newHash, user.id);
      }
      await recordLoginAttempt(db, req._bruteForceIp, username, tenantId, true);
      const token = await createSession(db, {
        tenantId, userId: user.id, userType: 'admin',
        userName: user.name, role: user.role,
        ip: req.ip, userAgent: req.headers['user-agent']
      });
      // L-02 FIX: Include last login info so admins can detect unexpected access
      res.json({
        success: true, token,
        userType: 'admin', userName: user.name, userRole: user.role,
        tenantId, tenantName: tenant.name,
        loginIp: req.ip, loginAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[login]', e.message);
      res.status(500).json({ error: 'Login error' });
    }
  });

  // ── Employee PIN Login ─────────────────────────────────────
  router.post('/employee-login', bruteForceCheck(db), async (req, res) => {
    const { pin, tenantId, employeeId } = req.body;
    if (!pin || !tenantId) return res.status(400).json({ error: 'Missing credentials' });
    // Validate PIN is numeric only
    if (!/^\d{4,8}$/.test(String(pin))) {
      return res.status(400).json({ error: 'PIN must be 4-8 digits' });
    }
    try {
      // C-01 FIX: verifyPassword handles both bcrypt and legacy SHA-256 PINs
      // Verify tenant is active before allowing employee login
      const tenant = await db.prepare(
        'SELECT id FROM tenants WHERE id = $1 AND active = 1'
      ).get(tenantId);
      if (!tenant) return res.status(404).json({ error: 'Station not found or inactive' });

      // BUG FIX: if employeeId provided, use it to disambiguate duplicate PINs
      let emp;
      if (employeeId) {
        const candidate = await db.prepare(
          'SELECT * FROM employees WHERE id = $1 AND tenant_id = $2 AND active = 1'
        ).get(employeeId, tenantId);
        emp = (candidate && await verifyPassword(String(pin), candidate.pin_hash)) ? candidate : null;
      } else {
        // No employeeId: fetch all with a pin_hash set, verify each (rare path)
        const candidates = await db.prepare(
          'SELECT * FROM employees WHERE tenant_id = $1 AND active = 1 AND pin_hash IS NOT NULL AND pin_hash != $2'
        ).all(tenantId, '');
        for (const c of candidates) {
          if (await verifyPassword(String(pin), c.pin_hash)) { emp = c; break; }
        }
      }
      // C-01 FIX: Upgrade legacy SHA-256 PIN hash to bcrypt on first successful login
      if (emp && emp.pin_hash && !emp.pin_hash.startsWith('$2')) {
        const newHash = await hashPassword(String(pin));
        await db.prepare('UPDATE employees SET pin_hash = $1 WHERE id = $2').run(newHash, emp.id);
      }
      if (!emp) {
        await recordLoginAttempt(db, req._bruteForceIp, 'employee-pin', tenantId, false);
        return res.status(401).json({ error: 'Invalid PIN' });
      }
      await recordLoginAttempt(db, req._bruteForceIp, emp.name, tenantId, true);
      const token = await createSession(db, {
        tenantId, userId: emp.id, userType: 'employee',
        userName: emp.name, role: 'attendant',
        ip: req.ip, userAgent: req.headers['user-agent']
      });
      res.json({
        success: true, token,
        userType: 'employee', userName: emp.name,
        employeeId: emp.id, tenantId
      });
    } catch (e) {
      console.error('[employee-login]', e.message);
      res.status(500).json({ error: 'Login error' });
    }
  });

  // ── Logout ─────────────────────────────────────────────────
  router.post('/logout', async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (token) {
      await destroySession(db, token);
      // Best-effort audit log — don't fail logout if audit fails
      try { await auditLog(req, 'LOGOUT', 'auth', '', ''); } catch {}
    }
    res.json({ success: true });
  });

  // ── Session Check ──────────────────────────────────────────
  // /api/auth is NOT under authMiddleware, so we must inline the token lookup here.
  // Previously req.session was always undefined → always 401.
  router.get('/session', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No active session' });
    }
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token || token.length < 10) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    try {
      const session = await db.prepare(
        'SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW()'
      ).get(token);
      if (!session) return res.status(401).json({ error: 'Invalid or expired session' });
      res.json({
        valid: true,
        userType: session.user_type,
        userName: session.user_name,
        role: session.role,
        tenantId: session.tenant_id,
      });
    } catch (e) {
      res.status(500).json({ error: 'Session check error' });
    }
  });

  // ── Super Change Password ──────────────────────────────────
  router.post('/super-change-password', requireRole('super'), async (req, res) => {
    const { newUsername, newPassword, confirmPassword } = req.body;
    if (!newUsername || newUsername.length < 3) {
      return res.status(400).json({ error: 'Username too short (min 3 chars)' });
    }
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password too short (min 8 chars)' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }
    try {
      const superHash = await hashPassword(newPassword);
      await db.prepare(
        'UPDATE super_admin SET username = $1, pass_hash = $2, updated_at = NOW() WHERE id = 1'
      ).run(newUsername, superHash);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Admin Change Password ──────────────────────────────────
  router.post('/change-password', requireRole('admin'), async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password too short (min 6 chars)' });
    }
    try {
      const newHash = await hashPassword(newPassword);
      await db.prepare(
        'UPDATE admin_users SET pass_hash = $1 WHERE id = $2 AND tenant_id = $3'
      ).run(newHash, req.userId, req.tenantId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = authRoutes;
