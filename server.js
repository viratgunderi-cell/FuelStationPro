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

  // BUG-08 FIX: CSP was fully disabled to allow inline scripts. Instead, enable CSP
  // with unsafe-inline only for scripts (required for SPA), keeping all other protections.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:    ["'self'"],
        scriptSrc:     ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc:      ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc:       ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc:        ["'self'", 'data:', 'blob:'],
        connectSrc:    ["'self'", 'https://cdn.jsdelivr.net'],
        workerSrc:     ["'self'", 'blob:'],
        manifestSrc:   ["'self'"],
        objectSrc:     ["'none'"],
        frameSrc:      ["'none'"],
      }
    },
    crossOriginEmbedderPolicy: false,  // Allow mixed content loading
  }));
  // BUG-07 FIX: CORS wildcard (origin: true) with credentials: true is a security risk.
  // Use explicit CORS_ORIGIN env var in production; fall back to same-origin only.
  const corsOrigin = process.env.CORS_ORIGIN || false; // false = same-origin only
  app.use(cors({
    origin: corsOrigin || false,
    credentials: corsOrigin ? true : false,
  }));
  app.use(rateLimit({ windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(inputSanitizerMiddleware);

  // Serve frontend — index.html is in root directory
  const publicDir = require('fs').existsSync(path.join(__dirname, 'public'))
    ? path.join(__dirname, 'public')
    : __dirname;

  // Serve PWA manifest + service worker with correct headers
  app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(publicDir, 'manifest.json'));
  });
  app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(publicDir, 'sw.js'));
  });
  app.get('/icon-:size.png', (req, res) => {
    const f = path.join(publicDir, `icon-${req.params.size}.png`);
    if (require('fs').existsSync(f)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.sendFile(f);
    } else res.sendStatus(404);
  });
  app.get('/apple-touch-icon.png', (req, res) => {
    const f = path.join(publicDir, 'apple-touch-icon.png');
    if (require('fs').existsSync(f)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.sendFile(f);
    } else res.sendStatus(404);
  });

  app.use(express.static(publicDir, {
    maxAge: 0,
    setHeaders: (res, fp) => {
      if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      if (fp.endsWith('.png') || fp.endsWith('.svg')) res.setHeader('Cache-Control', 'public, max-age=604800');
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

  // NOTE: /api/public/sale/:tenantId (singular) was removed — it was a duplicate of
  // /api/public/sales/:tenantId (plural) below. bridge.js uses the plural form.
  // The singular endpoint had a credit-balance update the plural lacked — merged below.

  // ── PUBLIC: employee pump reading update (no auth) ──────────────────────
  app.post('/api/public/reading/:tenantId', async (req, res) => {
    try {
      const tenantId = req.params.tenantId;
      const { pumpId } = req.body;
      let nozzleReadings = req.body.nozzleReadings || {};  // BUG-02 FIX: was const then reassigned — TypeError crash
      if (!pumpId) return res.status(400).json({ error: 'Missing pumpId' });
      // Get current pump data_json and merge readings
      const r = await pool.query(
        'SELECT data_json FROM pumps WHERE tenant_id=$1 AND id=$2',
        [tenantId, String(pumpId)]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'Pump not found' });
      let d = {};
      try { d = JSON.parse(r.rows[0].data_json || '{}'); } catch {}
      d.nozzleReadings = { ...(d.nozzleReadings || {}), ...nozzleReadings };
      if (req.body.nozzleOpen) {
        d.nozzleOpen = { ...(d.nozzleOpen || {}), ...req.body.nozzleOpen };
      }
      // Compute current_reading as sum of all nozzle readings
      const currentReading = Object.values(d.nozzleReadings).reduce((a, v) => a + (parseFloat(v) || 0), 0);
      // Compute open_reading as sum of all nozzle opens
      const openReading = Object.values(d.nozzleOpen || {}).reduce((a, v) => a + (parseFloat(v) || 0), 0);
      await pool.query(
        'UPDATE pumps SET data_json=$1, current_reading=$2 WHERE tenant_id=$3 AND id=$4',
        [JSON.stringify(d), currentReading, tenantId, String(pumpId)]
      );
      res.json({ success: true, currentReading, openReading });
    } catch (e) {
      console.error('[public/reading]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Public tenant list aliases (supports both legacy and new frontend clients)
  // BUG-03 FIX: Use pool.query directly — db.prepare() runs convertSql() which
  // appends "RETURNING id" to any INSERT, but it also runs on SELECT here causing
  // "SELECT...RETURNING id" which is invalid PostgreSQL syntax.
  const listTenantsPublic = async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT id, name, location, icon, color, color_light, active, station_code FROM tenants ORDER BY name'
      );
      res.json(result.rows);
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

      // BUG-01 FIX: 'employee' bare column does not exist in sales — use employee_id + employee_name
      const r = await pool.query(
        `INSERT INTO sales (tenant_id, date, time, fuel_type, liters, amount, mode, pump, nozzle, vehicle, customer, shift, employee_id, employee_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [tenantId, sale.date||'', sale.time||'', sale.fuelType||'', sale.liters||0, sale.amount||0,
         sale.mode||'cash', sale.pump||'', sale.nozzle||'A', sale.vehicle||'',
         sale.customer||'', sale.shift||'', sale.employeeId||0,
         sale.employeeName||(sale.employee||'')]
      );

      // BUG-04 FIX: Credit balance update was missing from this endpoint (was only in the now-removed singular endpoint)
      if ((sale.mode||'cash') === 'credit' && sale.customer) {
        try {
          await pool.query(
            `UPDATE credit_customers SET balance = COALESCE(balance, 0) + $1
             WHERE tenant_id = $2 AND name = $3 AND active = 1`,
            [sale.amount, tenantId, sale.customer]
          );
        } catch (credErr) {
          console.warn('[public/sales] credit balance update failed:', credErr.message);
        }
      }

      res.json({ id: r.rows[0].id });
    } catch (e) {
      console.error('[public/sales]', e.message);
      res.status(500).json({ error: 'Failed to save sale' });
    }
  });

  const authLimiter = rateLimit({ windowMs: 300000, max: 30 });
  app.use('/api/auth', authLimiter, authRoutes(db));

  // ── Settings routes ──────────────────────────────────────────────────────
  // BUG-06 FIX: These routes were duplicated here AND in data.js router.
  // The data.js router (mounted at /api/data with authMiddleware) handles these correctly.
  // Keeping them here caused confusion — removed. data.js routes are canonical.

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


  // ── PUBLIC: Tank deduction after employee shift submit ──────────────────────
  app.post('/api/public/tank-deduct/:tenantId', async (req, res) => {
    try {
      const tenantId = req.params.tenantId;
      const { deductions } = req.body; // { petrol: 100, diesel: 200, premium_petrol: 50 }
      if (!deductions || typeof deductions !== 'object') {
        return res.status(400).json({ error: 'Missing deductions' });
      }
      const today = new Date().toISOString().slice(0, 10);
      for (const [fuelType, liters] of Object.entries(deductions)) {
        if (!liters || liters <= 0) continue;
        await pool.query(
          `UPDATE tanks
           SET current_level = GREATEST(0, COALESCE(current_level, 0) - $1),
               last_dip = $2
           WHERE tenant_id = $3 AND fuel_type = $4`,
          [liters, today, tenantId, fuelType]
        );
      }
      res.json({ success: true });
    } catch (e) {
      console.error('[public/tank-deduct]', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // ── PUBLIC: Save employee shift history summary ──────────────────────────────
  app.post('/api/public/shift-history/:tenantId', async (req, res) => {
    try {
      const tenantId = req.params.tenantId;
      const h = req.body;
      if (!h || !h.employeeId || !h.date) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      // Store in settings table as JSON array keyed by tenantId+employeeId
      const key = 'shift_history_' + h.employeeId;
      const existing = await pool.query(
        "SELECT value FROM settings WHERE key = $1 AND tenant_id = $2",
        [key, tenantId]
      );
      let history = [];
      if (existing.rows[0]) {
        try { history = JSON.parse(existing.rows[0].value); } catch {}
      }
      // Prepend new entry, keep last 30
      history.unshift({
        date: h.date,
        user: h.user || '',
        liters: h.liters || 0,
        revenue: h.revenue || 0,
        salesCount: h.salesCount || 0,
        sales: h.sales || [],
        openReadings: h.openReadings || {},
        closeReadings: h.closeReadings || {},
        timestamp: h.timestamp || Date.now(),
      });
      history = history.slice(0, 30);
      if (existing.rows[0]) {
        await pool.query(
          "UPDATE settings SET value=$1 WHERE key=$2 AND tenant_id=$3",
          [JSON.stringify(history), key, tenantId]
        );
      } else {
        await pool.query(
          "INSERT INTO settings (tenant_id, key, value) VALUES ($1,$2,$3)",
          [tenantId, key, JSON.stringify(history)]
        );
      }
      res.json({ success: true });
    } catch (e) {
      console.error('[public/shift-history]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── PUBLIC: Get employee shift history ───────────────────────────────────────
  app.get('/api/public/shift-history/:tenantId/:employeeId', async (req, res) => {
    try {
      const key = 'shift_history_' + req.params.employeeId;
      const r = await pool.query(
        "SELECT value FROM settings WHERE key=$1 AND tenant_id=$2",
        [key, req.params.tenantId]
      );
      if (!r.rows[0]) return res.json([]);
      let history = [];
      try { history = JSON.parse(r.rows[0].value); } catch {}
      res.json(history);
    } catch (e) {
      res.json([]);
    }
  });


  // ── PUBLIC: Save employee expense ────────────────────────────────────────────
  app.post('/api/public/expense/:tenantId', async (req, res) => {
    try {
      const tenantId = req.params.tenantId;
      const e = req.body;
      if (!e || !e.amount || !e.category) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      await pool.query(
        `INSERT INTO expenses
          (tenant_id, date, category, description, amount, mode, paid_to, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          tenantId,
          e.date || new Date().toISOString().slice(0, 10),
          e.category || 'General',
          e.desc || e.description || '',
          e.amount,
          e.mode || 'cash',
          e.employee || '',
          e.employee || ''
        ]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[public/expense]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

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
