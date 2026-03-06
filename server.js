/**
 * FuelBunk Pro — Express Server (PostgreSQL)
 */
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { initDatabase } = require('./schema');
const { authMiddleware, inputSanitizerMiddleware } = require('./security');
const authRoutes = require('./auth');
const dataRoutes = require('./data');

async function startServer() {
  const db = await initDatabase();
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.locals.db = db;
  app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
  app.use(rateLimit({ windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(inputSanitizerMiddleware);

  // Serve frontend — index.html is in root directory
  const publicDir = require('fs').existsSync(path.join(__dirname, 'public'))
    ? path.join(__dirname, 'public')
    : __dirname;

  app.use(express.static(publicDir, {
    maxAge: 0,
    setHeaders: (res, fp) => {
      if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }));

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', database: 'postgresql', uptime: process.uptime() });
  });

  // ── Pool for public routes (imported here so public routes can use it) ────
  const { pool } = require('./schema');

  // ── PUBLIC: employee names for login screen (no auth required, no PINs) ─
  app.get('/api/public/employees/:tenantId', async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT id, name, role, shift, pin_hash, data_json FROM employees WHERE tenant_id = $1 AND active = 1 AND pin_hash IS NOT NULL AND pin_hash != \'\' ORDER BY name',
        [req.params.tenantId]
      );
      res.json(r.rows.map(e => {
        let permissions = {};
        try { const d = JSON.parse(e.data_json || '{}'); permissions = d.permissions || {}; } catch {}
        return {
          id: e.id, name: e.name, role: e.role, shift: e.shift || '',
          pinHash: e.pin_hash,   // SHA-256 hash — needed for employee login after cache clear
          permissions             // portal permissions (dip, credit, etc.)
        };
      }));
    } catch (e) {
      res.json([]); // fail silently — login screen falls back to cache
    }
  });

  // ── PUBLIC: allocations for employee portal (no auth, no sensitive data) ─
  app.get('/api/public/allocations/:tenantId', async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT value FROM settings WHERE key = 'allocations' AND tenant_id = $1",
        [req.params.tenantId]
      );
      if (!r.rows[0]) return res.json({});
      let val = r.rows[0].value;
      try { val = JSON.parse(val); } catch {}
      res.json(val || {});
    } catch (e) {
      res.json({});
    }
  });

  // ── PUBLIC: pump/nozzle info for employee portal (no sensitive data) ──────
  app.get('/api/public/pumps/:tenantId', async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT id, name, fuel_type, data_json FROM pumps WHERE tenant_id = $1 AND status != $2 ORDER BY id',
        [req.params.tenantId, 'inactive']
      );
      const pumps = r.rows.map(row => {
        let d = {};
        try { d = JSON.parse(row.data_json || '{}'); } catch {}
        // Return nozzleLabels as array AND nozzles as integer count
        // getEmpPumps() in client checks p.nozzleLabels first, then falls back to integer p.nozzles
        const nozzleLabels = d.nozzleLabels || ['A', 'B'];
        const nozzleFuels = d.nozzleFuels || {};
        const nozzleReadings = d.nozzleReadings || {};
        return {
          id: String(row.id),
          name: row.name,
          fuelType: row.fuel_type,
          nozzles: nozzleLabels.length,       // integer count — used by getEmpPumps fallback
          nozzleLabels: nozzleLabels,          // explicit array — used by getEmpPumps primary path
          nozzleFuels: nozzleFuels,
          nozzleReadings: nozzleReadings,
        };
      });
      res.json(pumps);
    } catch (e) {
      res.json([]);
    }
  });

  // ── PUBLIC: fuel prices for employee sales (no sensitive data) ─────────────
  app.get('/api/public/prices/:tenantId', async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT value FROM settings WHERE key = 'prices' AND tenant_id = $1",
        [req.params.tenantId]
      );
      if (!r.rows[0]) return res.json({});
      let val = r.rows[0].value;
      try { val = JSON.parse(val); } catch {}
      res.json(val || {});
    } catch (e) {
      res.json({});
    }
  });

  // ── PUBLIC: credit customers for employee sales (name + limit only) ────────
  app.get('/api/public/creditcustomers/:tenantId', async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT id, name, credit_limit, balance FROM credit_customers WHERE tenant_id = $1 AND active = 1 ORDER BY name',
        [req.params.tenantId]
      );
      res.json(r.rows.map(c => ({ id: c.id, name: c.name, limit: parseFloat(c.credit_limit)||0, outstanding: parseFloat(c.balance)||0 })));
    } catch (e) {
      res.json([]);
    }
  });

  // ── PUBLIC: employee sale submission (no auth — validated by tenantId) ──────
  app.post('/api/public/sale/:tenantId', async (req, res) => {
    try {
      const tenantId = req.params.tenantId;
      const s = req.body;
      if (!s || !s.fuelType || !s.liters || !s.amount) {
        return res.status(400).json({ error: 'Missing required sale fields' });
      }
      await pool.query(
        `INSERT INTO sales
          (tenant_id, date, time, fuel_type, liters, amount, mode, pump, nozzle,
           vehicle, customer, shift, employee_id, employee_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          tenantId,
          s.date || new Date().toISOString().slice(0,10),
          s.time || new Date().toTimeString().slice(0,8),
          s.fuelType, s.liters, s.amount,
          s.mode || 'cash',
          String(s.pump || ''), s.nozzle || 'A',
          s.vehicle || '', s.customer || '',
          s.shift || 'Employee',
          s.employeeId || 0, s.employeeName || (s.employee || '')
        ]
      );
      res.json({ success: true });
    } catch (e) {
      console.error('[public/sale]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── PUBLIC: employee pump reading update (no auth) ──────────────────────
  app.post('/api/public/reading/:tenantId', async (req, res) => {
    try {
      const tenantId = req.params.tenantId;
      const { pumpId, nozzleReadings } = req.body;
      if (!pumpId || !nozzleReadings) return res.status(400).json({ error: 'Missing fields' });
      // Get current pump data_json and merge readings
      const r = await pool.query(
        'SELECT data_json FROM pumps WHERE tenant_id=$1 AND id=$2',
        [tenantId, String(pumpId)]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'Pump not found' });
      let d = {};
      try { d = JSON.parse(r.rows[0].data_json || '{}'); } catch {}
      d.nozzleReadings = { ...(d.nozzleReadings || {}), ...nozzleReadings };
      await pool.query(
        'UPDATE pumps SET data_json=$1 WHERE tenant_id=$2 AND id=$3',
        [JSON.stringify(d), tenantId, String(pumpId)]
      );
      res.json({ success: true });
    } catch (e) {
      console.error('[public/reading]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Public tenant list aliases (supports both legacy and new frontend clients)
  const listTenantsPublic = async (req, res) => {
    try {
      const tenants = await db.prepare(
        'SELECT id, name, location, icon, color, color_light, active, station_code FROM tenants ORDER BY name'
      ).all();
      res.json(tenants);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };

  app.get(['/api/tenants', '/api/tenants/list', '/api/data/tenants', '/api/data/tenants/list'], listTenantsPublic);


  // ── PUBLIC: save employee sale (tenantId auth only — no JWT needed as fallback) ──
  app.post('/api/public/sales/:tenantId', async (req, res) => {
    try {
      const { tenantId } = req.params;
      const sale = req.body;
      if (!tenantId || !sale || !sale.fuelType || !sale.liters || !sale.amount) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      // Verify tenant exists
      const tenantCheck = await pool.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
      if (!tenantCheck.rows.length) return res.status(404).json({ error: 'Tenant not found' });

      // Insert sale into DB
      const r = await pool.query(
        `INSERT INTO sales (tenant_id, date, time, fuel_type, liters, amount, mode, pump, nozzle, vehicle, customer, shift, employee, employee_id, employee_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [tenantId, sale.date||'', sale.time||'', sale.fuelType||'', sale.liters||0, sale.amount||0,
         sale.mode||'cash', sale.pump||'', sale.nozzle||'A', sale.vehicle||'',
         sale.customer||'', sale.shift||'', sale.employee||'', sale.employeeId||0, sale.employeeName||'']
      );
      res.json({ id: r.rows[0].id });
    } catch (e) {
      console.error('[public/sales]', e.message);
      res.status(500).json({ error: 'Failed to save sale' });
    }
  });

  const authLimiter = rateLimit({ windowMs: 300000, max: 30 });
  app.use('/api/auth', authLimiter, authRoutes(db));

  // ── Settings routes (direct pool.query — bypass PgDbWrapper) ────────────
  // Registered BEFORE app.use('/api/data',...) to guarantee priority.
  const { pool: pgPool } = require('./schema');

  app.get('/api/data/settings/key/:key', authMiddleware(db), async (req, res) => {
    try {
      const r = await pgPool.query(
        'SELECT value FROM settings WHERE key = $1 AND tenant_id = $2',
        [req.params.key, req.tenantId || '']
      );
      if (!r.rows[0]) return res.json({ value: null });
      let val = r.rows[0].value;
      try { val = JSON.parse(val); } catch {}
      res.json({ value: val });
    } catch (e) {
      console.error('[Settings GET]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/data/settings/key/:key', authMiddleware(db), async (req, res) => {
    const { value } = req.body;
    const serialized = (value !== null && value !== undefined && typeof value === 'object')
      ? JSON.stringify(value) : String(value ?? '');
    try {
      await pgPool.query(
        'INSERT INTO settings (key, tenant_id, value, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (key, tenant_id) DO UPDATE SET value = $3, updated_at = NOW()',
        [req.params.key, req.tenantId || '', serialized]
      );
      res.json({ success: true });
    } catch (e) {
      console.error('[Settings PUT]', req.params.key, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Explicit tenant CRUD routes (authenticated, requireRole super) ───────
  // These are registered BEFORE the generic dataRoutes mounts to avoid
  // any routing ambiguity from double-mounting.
  const { requireRole: reqRole, auditLog: auLog } = require('./security');
  const { hashPassword: hashPw } = require('./schema');

  // GET tenant admins
  app.get('/api/data/tenants/:id/admins', authMiddleware(db), reqRole('super'), async (req, res) => {
    try {
      const admins = await db.prepare('SELECT id, name, username, role, active, created_at FROM admin_users WHERE tenant_id = $1').all(req.params.id);
      res.json(admins);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST add tenant admin
  app.post('/api/data/tenants/:id/admins', authMiddleware(db), reqRole('super'), async (req, res) => {
    const { name, username, password, role } = req.body;
    if (!name || !username || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
    try {
      const exists = await db.prepare('SELECT id FROM admin_users WHERE tenant_id = $1 AND username = $2').get(req.params.id, username);
      if (exists) return res.status(409).json({ error: 'Username already exists' });
      const result = await db.prepare('INSERT INTO admin_users (tenant_id, name, username, pass_hash, role) VALUES ($1,$2,$3,$4,$5)').run(req.params.id, name, username, hashPw(password), role||'Manager');
      res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE remove tenant admin
  app.delete('/api/data/tenants/:tid/admins/:uid', authMiddleware(db), reqRole('super'), async (req, res) => {
    try {
      await db.prepare('DELETE FROM admin_users WHERE id = $1 AND tenant_id = $2').run(req.params.uid, req.params.tid);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST reset admin password
  app.post('/api/data/tenants/:tid/admins/:uid/reset-password', authMiddleware(db), reqRole('super'), async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
    try {
      await db.prepare('UPDATE admin_users SET pass_hash = $1 WHERE id = $2 AND tenant_id = $3').run(hashPw(newPassword), req.params.uid, req.params.tid);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST create tenant
  app.post('/api/data/tenants', authMiddleware(db), reqRole('super'), async (req, res) => {
    const { id, name, location, ownerName, phone, icon, color, colorLight, stationCode, adminUser, adminPass } = req.body;
    if (!name || name.length < 2) return res.status(400).json({ error: 'Station name required' });
    try {
      const tenantId = id || ('stn_' + Date.now());
      const existing = await db.prepare('SELECT id FROM tenants WHERE name = $1').get(name);
      if (existing) return res.status(409).json({ error: 'Station name already exists' });
      await db.prepare('INSERT INTO tenants (id, name, location, owner_name, phone, icon, color, color_light, station_code, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)')
        .run(tenantId, name, location||'', ownerName||'', phone||'', icon||'⛽', color||'#d4940f', colorLight||'#f0b429', stationCode||'', 1);
      if (adminUser && adminPass) {
        try {
          await db.prepare('INSERT INTO admin_users (tenant_id, name, username, pass_hash, role) VALUES ($1,$2,$3,$4,$5)')
            .run(tenantId, ownerName||adminUser, adminUser, hashPw(adminPass), 'Owner');
        } catch (e2) { console.warn('[Tenant] Admin creation failed:', e2.message); }
      }
      await auLog(req, 'CREATE_TENANT', 'tenants', tenantId, name);
      res.json({ success: true, id: tenantId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT update tenant
  app.put('/api/data/tenants/:id', authMiddleware(db), reqRole('super'), async (req, res) => {
    const { name, location, ownerName, phone, icon, active, stationCode } = req.body;
    try {
      await db.prepare('UPDATE tenants SET name=COALESCE($1,name), location=COALESCE($2,location), owner_name=COALESCE($3,owner_name), phone=COALESCE($4,phone), icon=COALESCE($5,icon), active=COALESCE($6,active), station_code=COALESCE($7,station_code), updated_at=NOW() WHERE id=$8')
        .run(name, location, ownerName, phone, icon, active !== undefined ? (active ? 1 : 0) : null, stationCode, req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE tenant — this is the critical route that was failing
  app.delete('/api/data/tenants/:id', authMiddleware(db), reqRole('super'), async (req, res) => {
    try {
      console.log('[Server] DELETE tenant:', req.params.id, 'by:', req.userName);
      await auLog(req, 'DELETE_TENANT', 'tenants', req.params.id, '');
      await db.prepare('DELETE FROM tenants WHERE id = $1').run(req.params.id);
      res.json({ success: true });
    } catch (e) {
      console.error('[Server] DELETE tenant error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Keep legacy /api/data/* and new /api/* route styles working together.
  app.use('/api/data', authMiddleware(db), dataRoutes(db));
  // NOTE: /api/data is the canonical path — do not add /api/* catch-all to avoid double processing

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((err, req, res, next) => {
    console.error('[Error]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FuelBunk Pro] Running on port ${PORT} with PostgreSQL`);
  });

  process.on('SIGTERM', () => { console.log('[Server] Shutting down...'); process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
}

startServer().catch(e => {
  console.error('[FATAL]', e);
  process.exit(1);
});
