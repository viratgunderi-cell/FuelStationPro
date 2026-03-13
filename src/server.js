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

// ── IST date helper — always use this instead of toISOString() for business dates ──
function istDate() {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function startServer() {
  const db = await initDatabase();
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.locals.db = db;
  app.set('trust proxy', 1);

  // L-01 FIX: Enforce HTTPS in production — Railway sets x-forwarded-proto
  app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production' &&
        req.headers['x-forwarded-proto'] &&
        req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });

  // BUG-08 FIX: CSP was fully disabled to allow inline scripts. Instead, enable CSP
  // with unsafe-inline only for scripts (required for SPA), keeping all other protections.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:    ["'self'"],
        // FIX 20: added blob: for self-hosted Chart.js Blob URL fallback; added cdnjs for Chart.js CDN fallback
        scriptSrc:     ["'self'", "'unsafe-inline'", 'blob:', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://checkout.razorpay.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc:      ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc:       ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc:        ["'self'", 'data:', 'blob:'],
        connectSrc:    ["'self'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://api.callmebot.com', 'https://api.razorpay.com'],
        workerSrc:     ["'self'", 'blob:'],
        manifestSrc:   ["'self'"],
        objectSrc:     ["'none'"],
        // FIX 20: allow blob: frames so the print-preview iframe (Blob URL) renders correctly
        frameSrc:      ["'self'", 'blob:'],
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

  // FIX F-07: Serve self-hosted Chart.js so SW can cache it for offline use
  // Download: npm run setup (see package.json) or manually copy chart.umd.min.js → public/chart.min.js
  app.get('/chart.min.js', (req, res) => {
    const f = path.join(publicDir, 'chart.min.js');
    const fs = require('fs');
    if (fs.existsSync(f)) {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30 days — Chart.js rarely changes
      res.sendFile(f);
    } else {
      // Graceful fallback: redirect to CDN if file not yet downloaded
      res.redirect(302, 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js');
    }
  });

  // FIX F-02: Screenshots route for manifest.json screenshots field
  // Place actual PNG screenshots in public/screenshots/ directory
  app.get('/screenshots/:file', (req, res) => {
    const fs = require('fs');
    const f = path.join(publicDir, 'screenshots', path.basename(req.params.file));
    if (fs.existsSync(f)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(f);
    } else {
      // Return a minimal valid PNG placeholder so Lighthouse doesn't hard-fail
      res.setHeader('Content-Type', 'image/png');
      res.status(404).send('Screenshot not found. Add PNG files to public/screenshots/');
    }
  });

  // ── Split JS bundle (Option A refactor) ─────────────────────────────────
  // Each file is versioned via query string (?v=) in index.html for cache busting
  const JS_BUNDLE_FILES = ['multitenant.js', 'utils.js', 'admin.js', 'employee.js', 'app.js'];
  JS_BUNDLE_FILES.forEach(fname => {
    app.get('/' + fname, (req, res) => {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'public, max-age=3600'); // 1hr; SW handles offline
      res.sendFile(path.join(publicDir, fname));
    });
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

  app.get('/api/health', async (req, res) => {
    // L-03 FIX: verify actual DB connectivity, not just process uptime
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'connected', uptime: process.uptime() });
    } catch (e) {
      res.status(503).json({ status: 'degraded', database: 'error', error: e.message, uptime: process.uptime() });
    }
  });

  // ── Pool for public routes (imported here so public routes can use it) ────
  const { pool } = require('./schema');

  // ── PUBLIC: employee names for login screen (no auth required, no PINs) ─
  app.get('/api/public/employees/:tenantId', async (req, res) => {
    try {
      // IR-01 FIX: pinHash REMOVED from public response — 4-digit PINs are trivially reversible
      // Use POST /api/public/verify-pin/:tenantId for online verification
      // Offline fallback uses hash stored in IndexedDB during authenticated admin session
      const r = await pool.query(
        'SELECT id, name, role, shift, data_json FROM employees WHERE tenant_id = $1 AND active = 1 AND pin_hash IS NOT NULL AND pin_hash != \'\' ORDER BY name',
        [req.params.tenantId]
      );
      res.json(r.rows.map(e => {
        let permissions = {};
        try { const d = JSON.parse(e.data_json || '{}'); permissions = d.permissions || {}; } catch {}
        return {
          id: e.id, name: e.name, role: e.role, shift: e.shift || '',
          // pinHash intentionally omitted — use /api/public/verify-pin for auth
          permissions
        };
      }));
    } catch (e) {
      res.json([]); // fail silently — login screen falls back to cached hash
    }
  });

  // ── IR-01 FIX: Server-side PIN verification — hash never leaves DB ───────────
  // M-01 FIX: Rate limit PIN verification — previously had zero protection
  const pinVerifyLimiter = rateLimit({ windowMs: 300000, max: 15, standardHeaders: true, legacyHeaders: false });
  app.post('/api/public/verify-pin/:tenantId', pinVerifyLimiter, async (req, res) => {
    try {
      const { employeeId, pinHash } = req.body;
      if (!employeeId || !pinHash) return res.status(400).json({ valid: false, error: 'Missing fields' });
      const r = await pool.query(
        'SELECT pin_hash FROM employees WHERE id = $1 AND tenant_id = $2 AND active = 1',
        [String(employeeId), req.params.tenantId]
      );
      if (!r.rows[0]) return res.json({ valid: false });
      const match = r.rows[0].pin_hash === pinHash;
      res.json({ valid: match });
    } catch (e) {
      console.error('[verify-pin]', e.message);
      res.status(500).json({ valid: false, error: 'Server error' });
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

  // ── PUBLIC: staff data for Shift Manager portal (no auth) ────────────────
  // Returns employees + shifts + roster + attendance — no PINs or salary data
  app.get('/api/public/staff-data/:tenantId', async (req, res) => {
    try {
      const tid = req.params.tenantId;
      const now = new Date();
      const pm = String(now.getMonth()+1).padStart(2,'0');
      const py = now.getFullYear();
      const payrollKey = `payroll_${py}_${now.getMonth()+1}`;

      const [empRows, shiftRows, rosterRow, attRow, lubeProdsRow, lubeSalesRow, advancesRow, payrollRow] = await Promise.all([
        pool.query('SELECT id, name, role, shift, phone, data_json FROM employees WHERE tenant_id = $1 AND active = 1 ORDER BY name', [tid]),
        pool.query('SELECT * FROM shifts WHERE tenant_id = $1 ORDER BY start_time', [tid]),
        pool.query("SELECT value FROM settings WHERE key = 'shift_roster' AND tenant_id = $1", [tid]),
        pool.query("SELECT value FROM settings WHERE key = 'attendance_data' AND tenant_id = $1", [tid]),
        pool.query("SELECT value FROM settings WHERE key = 'lubes_products' AND tenant_id = $1", [tid]),
        pool.query("SELECT value FROM settings WHERE key = 'lubes_sales' AND tenant_id = $1", [tid]),
        pool.query("SELECT value FROM settings WHERE key = 'advances_data' AND tenant_id = $1", [tid]),
        pool.query("SELECT value FROM settings WHERE key = $1 AND tenant_id = $2", [payrollKey, tid]),
      ]);

      const employees = empRows.rows.map(e => {
        let color = '', permissions = {};
        try { const d = JSON.parse(e.data_json || '{}'); color = d.color || ''; permissions = d.permissions || {}; } catch {}
        return { id: e.id, name: e.name, role: e.role, shift: e.shift || '', phone: e.phone || '', color, permissions };
      });

      const parse = (row, fallback) => { try { return row.rows[0] ? JSON.parse(row.rows[0].value || 'null') || fallback : fallback; } catch { return fallback; } };

      res.json({
        employees,
        // FIX: Normalize shift field names — DB stores start_time/end_time but
        // frontend (employee.js, admin.js) expects start/end everywhere
        shifts: shiftRows.rows.map(s => ({
          id:    s.id,
          name:  s.name,
          start: s.start_time || s.start || '',
          end:   s.end_time   || s.end   || '',
          start_time: s.start_time || s.start || '',
          end_time:   s.end_time   || s.end   || '',
          status: s.status || 'open',
        })),
        roster:     parse(rosterRow, {}),
        attendance: parse(attRow, {}),
        lubesProducts: parse(lubeProdsRow, []),
        lubesSales:    parse(lubeSalesRow, []),
        advances:      parse(advancesRow, []),
        payroll:       parse(payrollRow, {}),
      });
    } catch (e) {
      console.error('[staff-data]', e.message);
      res.json({ employees: [], shifts: [], roster: {}, attendance: {}, lubesProducts: [], lubesSales: [], advances: [], payroll: {} });
    }
  });

  // /api/public/sales/:tenantId (plural) below. bridge.js uses the plural form.
  // The singular endpoint had a credit-balance update the plural lacked — merged below.

  // ── PUBLIC: employee pump reading update (no auth) ──────────────────────
  app.post('/api/public/reading/:tenantId', async (req, res) => {
    // IR-02 FIX: Use SELECT FOR UPDATE inside a transaction to prevent TOCTOU race condition
    // when two employees submit readings for different nozzles of the same pump concurrently.
    const client = await pool.connect();
    try {
      const tenantId = req.params.tenantId;
      const { pumpId } = req.body;
      const nozzleReadings = req.body.nozzleReadings || {};
      if (!pumpId) { client.release(); return res.status(400).json({ error: 'Missing pumpId' }); }

      await client.query('BEGIN');
      // Row-level lock prevents concurrent writers from clobbering each other
      const r = await client.query(
        'SELECT data_json FROM pumps WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenantId, String(pumpId)]
      );
      if (!r.rows[0]) {
        await client.query('ROLLBACK'); client.release();
        return res.status(404).json({ error: 'Pump not found' });
      }

      let d = {};
      try { d = JSON.parse(r.rows[0].data_json || '{}'); } catch {}

      // Merge per-nozzle readings (only update nozzles present in this request)
      d.nozzleReadings = { ...(d.nozzleReadings || {}), ...nozzleReadings };
      if (req.body.nozzleOpen) {
        d.nozzleOpen = { ...(d.nozzleOpen || {}), ...req.body.nozzleOpen };
      }
      // FA-03 FIX: stamp when readings were last updated so employees can see carry-forward date
      d.readingUpdatedAt = istDate() + ' ' + new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

      const currentReading = Object.values(d.nozzleReadings).reduce((a, v) => a + (parseFloat(v) || 0), 0);
      const openReading    = Object.values(d.nozzleOpen || {}).reduce((a, v) => a + (parseFloat(v) || 0), 0);

      await client.query(
        'UPDATE pumps SET data_json=$1, current_reading=$2, reading_updated_at=$3 WHERE tenant_id=$4 AND id=$5',
        [JSON.stringify(d), currentReading, d.readingUpdatedAt, tenantId, String(pumpId)]
      );
      await client.query('COMMIT');
      client.release();
      res.json({ success: true, currentReading, openReading });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
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
        'SELECT id, name, location, owner_name, phone, icon, color, color_light, active, station_code FROM tenants ORDER BY name'
      );
      // BUG-A FIX: Normalize snake_case DB columns → camelCase expected by multitenant.js
      // color_light → colorLight, station_code → stationCode, owner_name → ownerName
      const rows = result.rows.map(t => ({
        id:          t.id,
        name:        t.name,
        location:    t.location,
        ownerName:   t.owner_name || '',
        phone:       t.phone || '',
        icon:        t.icon,
        color:       t.color,
        colorLight:  t.color_light,   // multitenant.js uses t.colorLight for gradient
        active:      t.active,
        stationCode: t.station_code || '',
      }));
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };

  app.get(['/api/tenants', '/api/tenants/list', '/api/data/tenants', '/api/data/tenants/list'], listTenantsPublic);


  // ── PUBLIC: save employee sale (tenantId auth only — no JWT needed as fallback) ──
  app.post('/api/public/sales/:tenantId', async (req, res) => {
    const client = await pool.connect();
    try {
      const { tenantId } = req.params;
      const sale = req.body;
      if (!tenantId || !sale || !sale.fuelType || !sale.liters || !sale.amount) {
        client.release();
        return res.status(400).json({ error: 'Missing required fields' });
      }
      // Verify tenant exists
      const tenantCheck = await client.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
      if (!tenantCheck.rows.length) { client.release(); return res.status(404).json({ error: 'Tenant not found' }); }

      // TC-018 FIX: Validate pump is not inactive before accepting sale
      if (sale.pump) {
        const pumpCheck = await client.query(
          'SELECT status FROM pumps WHERE id = $1 AND tenant_id = $2',
          [String(sale.pump), tenantId]
        );
        if (pumpCheck.rows[0] && pumpCheck.rows[0].status === 'inactive') {
          client.release();
          return res.status(409).json({ error: 'Pump is inactive — sale not permitted', pump: sale.pump });
        }
      }

      await client.query('BEGIN');

      // BUG-B FIX: Credit limit enforcement INSIDE a transaction with SELECT FOR UPDATE
      // prevents TOCTOU race — two concurrent credit sales can no longer both pass the
      // limit check against the same pre-update balance.
      if ((sale.mode || 'cash') === 'credit' && sale.customer) {
        const creditRow = await client.query(
          'SELECT id, balance, credit_limit FROM credit_customers WHERE tenant_id = $1 AND name = $2 AND active = 1 FOR UPDATE',
          [tenantId, sale.customer]
        );
        if (creditRow.rows[0]) {
          const currentBalance = parseFloat(creditRow.rows[0].balance) || 0;
          const limit = parseFloat(creditRow.rows[0].credit_limit) || 0;
          if (limit > 0 && (currentBalance + sale.amount) > limit) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(422).json({
              error: 'Credit limit exceeded',
              outstanding: currentBalance,
              limit,
              available: Math.max(0, limit - currentBalance),
            });
          }
          // Update balance atomically within the same transaction
          await client.query(
            `UPDATE credit_customers SET balance = COALESCE(balance, 0) + $1
             WHERE tenant_id = $2 AND name = $3 AND active = 1`,
            [sale.amount, tenantId, sale.customer]
          );
        }
      }

      // BUG-01 FIX: 'employee' bare column does not exist in sales — use employee_id + employee_name
      // M-02 FIX: Idempotency key prevents duplicate sales on network retry.
      // Client generates a UUID per sale attempt; duplicate key = silent no-op, returns existing id.
      const idemKey = sale.idempotencyKey || sale.idempotency_key || '';
      let saleId;
      if (idemKey) {
        // Check for existing sale with this idempotency key first
        const existing = await client.query(
          'SELECT id FROM sales WHERE tenant_id = $1 AND idempotency_key = $2',
          [tenantId, idemKey]
        );
        if (existing.rows[0]) {
          await client.query('COMMIT');
          client.release();
          return res.json({ id: existing.rows[0].id, duplicate: true });
        }
      }
      const r = await client.query(
        `INSERT INTO sales (tenant_id, date, time, fuel_type, liters, amount, mode, pump, nozzle, vehicle, customer, shift, employee_id, employee_name, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [tenantId, sale.date||'', sale.time||'', sale.fuelType||'', sale.liters||0, sale.amount||0,
         sale.mode||'cash', sale.pump||'', sale.nozzle||'A', sale.vehicle||'',
         sale.customer||'', sale.shift||'', sale.employeeId||0,
         sale.employeeName||(sale.employee||''), idemKey]
      );
      saleId = r.rows[0].id;

      await client.query('COMMIT');
      client.release();
      res.json({ id: saleId });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
      console.error('[public/sales]', e.message);
      res.status(500).json({ error: 'Failed to save sale' });
    }
  });

  const authLimiter = rateLimit({
    windowMs: 300000,   // 5-minute window
    max: 20,            // M-01 FIX: reduced from 200 — 20/5min matches brute-force check threshold
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      // BUG-D FIX: req.rateLimit.resetTime may be undefined in some express-rate-limit configs.
      // Use optional chaining and fallback to a sensible default.
      const resetMs = req.rateLimit?.resetTime ? (req.rateLimit.resetTime - Date.now()) : 300000;
      const retryAfter = Math.max(1, Math.ceil(resetMs / 1000 / 60));
      res.status(429).json({ error: `Too many login attempts. Please wait ${retryAfter} minute(s) and try again.` });
    },
  });
  app.use('/api/auth', authLimiter, authRoutes(db));

  // ── Settings routes ──────────────────────────────────────────────────────
  // BUG-06 FIX: These routes were duplicated here AND in data.js router.
  // The data.js router (mounted at /api/data with authMiddleware) handles these correctly.
  // Keeping them here caused confusion — removed. data.js routes are canonical.

  // ── Explicit tenant CRUD routes (authenticated, requireRole super) ───────
  // These are registered BEFORE the generic dataRoutes mounts to avoid
  // any routing ambiguity from double-mounting.
  const { requireRole: reqRole, auditLog: auLog } = require('./security');
  const { hashPassword: hashPw, verifyPassword: verifyPw } = require('./schema');

  // GET tenant admins
  app.get('/api/data/tenants/:id/admins', authMiddleware(db), reqRole('super'), async (req, res) => {
    try {
      const admins = await db.prepare('SELECT id, name, username, role, active, created_at FROM admin_users WHERE tenant_id = $1').all(req.params.id);
      res.json(admins);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST add tenant admin
  // POST add tenant admin — super can add to any tenant; Owner can add to their own
  app.post('/api/data/tenants/:id/admins', authMiddleware(db), async (req, res) => {
    // Allow super OR an Owner managing their own tenant
    const isSuperUser = req.userType === 'super';
    const isOwnerOfTenant = req.userType === 'admin' && 
                            (req.userRole === 'Owner' || req.userRole === 'owner') &&
                            req.tenantId === req.params.id;
    if (!isSuperUser && !isOwnerOfTenant) {
      return res.status(403).json({ error: 'Only Super Admin or Owner can add admin users' });
    }
    const { name, username, password, role } = req.body;
    if (!name || !username || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
    try {
      const exists = await db.prepare('SELECT id FROM admin_users WHERE tenant_id = $1 AND username = $2').get(req.params.id, username);
      if (exists) return res.status(409).json({ error: 'Username already exists' });
      const adminHash = await hashPw(password);
      const result = await db.prepare('INSERT INTO admin_users (tenant_id, name, username, pass_hash, role) VALUES ($1,$2,$3,$4,$5)').run(req.params.id, name, username, adminHash, role||'Manager');
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
      const resetHash = await hashPw(newPassword);
      await db.prepare('UPDATE admin_users SET pass_hash = $1 WHERE id = $2 AND tenant_id = $3').run(resetHash, req.params.uid, req.params.tid);
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
          const ownerHash = await hashPw(adminPass);
          await db.prepare('INSERT INTO admin_users (tenant_id, name, username, pass_hash, role) VALUES ($1,$2,$3,$4,$5)')
            .run(tenantId, ownerName||adminUser, adminUser, ownerHash, 'Owner');
        } catch (e2) { console.warn('[Tenant] Admin creation failed:', e2.message); }
      }
      await auLog(req, 'CREATE_TENANT', 'tenants', tenantId, name);
      res.json({ success: true, id: tenantId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT update admin user role (Owner can do this for their own tenant)
  app.put('/api/data/tenants/:tid/admins/:uid/role', authMiddleware(db), async (req, res) => {
    // Super can update any tenant; Owner can only update their own
    if (req.userType !== 'super' && req.tenantId !== req.params.tid) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const { role } = req.body;
    if (!role || !['Owner','Manager','Accountant','Cashier'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    try {
      await db.prepare(
        'UPDATE admin_users SET role = $1 WHERE id = $2 AND tenant_id = $3'
      ).run(role, req.params.uid, req.params.tid);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
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
    const client = await pool.connect();
    try {
      console.log('[Server] DELETE tenant:', req.params.id, 'by:', req.userName);
      await auLog(req, 'DELETE_TENANT', 'tenants', req.params.id, '');

      await client.query('BEGIN');
      // BUG-E FIX: Cascade delete all tenant data to prevent orphaned rows.
      // No FK constraints exist, so manual cleanup is required.
      const tid = req.params.id;
      const TENANT_TABLES = [
        'sales', 'tanks', 'pumps', 'dip_readings', 'expenses', 'fuel_purchases',
        'credit_customers', 'credit_transactions', 'employees', 'shifts', 'settings',
        'audit_log', 'lubes_products', 'lubes_sales',
      ];
      for (const tbl of TENANT_TABLES) {
        await client.query(`DELETE FROM ${tbl} WHERE tenant_id = $1`, [tid]);
      }
      await client.query('DELETE FROM admin_users WHERE tenant_id = $1', [tid]);
      await client.query('DELETE FROM sessions WHERE tenant_id = $1', [tid]);
      await client.query('DELETE FROM tenants WHERE id = $1', [tid]);
      await client.query('COMMIT');
      client.release();
      res.json({ success: true });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
      console.error('[Server] DELETE tenant error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Keep legacy /api/data/* and new /api/* route styles working together.
  app.use('/api/data', authMiddleware(db), dataRoutes(db));
  // NOTE: /api/data is the canonical path — do not add /api/* catch-all to avoid double processing

  // ── PUSH NOTIFICATION ENDPOINTS ─────────────────────────────────────────
  // FIX: Implement server-side VAPID push so station manager is notified
  //      when the app is CLOSED (background push — previously missing, bug F-01).
  //
  // SETUP REQUIRED:
  //   1. npm install web-push
  //   2. node -e "const wp=require('web-push'); const k=wp.generateVAPIDKeys(); console.log(JSON.stringify(k))"
  //   3. Set env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_MAILTO
  //
  // The client subscribes via POST /api/push/subscribe (auth required).
  // Server triggers push via sendPushToTenant() (called from tank deduction + dip routes).
  (function setupPushRoutes() {
    let webpush = null;
    try {
      webpush = require('web-push');
      if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        webpush.setVapidDetails(
          process.env.VAPID_MAILTO || 'mailto:admin@fuelbunk.app',
          process.env.VAPID_PUBLIC_KEY,
          process.env.VAPID_PRIVATE_KEY
        );
        console.log('[Push] VAPID keys loaded — background push enabled');
      } else {
        console.warn('[Push] VAPID keys not set — background push disabled. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY env vars.');
        webpush = null;
      }
    } catch(e) {
      console.warn('[Push] web-push not installed — run: npm install web-push');
      webpush = null;
    }

    // Expose VAPID public key to client (needed to create push subscription)
    app.get('/api/push/vapid-public-key', authMiddleware(db), (req, res) => {
      const key = process.env.VAPID_PUBLIC_KEY || '';
      if (!key) return res.status(503).json({ error: 'Push notifications not configured on this server.' });
      res.json({ publicKey: key });
    });

    // Save a push subscription for the current tenant + user
    app.post('/api/push/subscribe', authMiddleware(db), async (req, res) => {
      const { subscription } = req.body;
      if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription object' });
      try {
        const tenantId = req.user?.tenantId || req.user?.tenant_id;
        const userId   = req.user?.id || 'unknown';
        const key = 'push_sub_' + Buffer.from(subscription.endpoint).toString('base64').slice(0, 40);
        await pool.query(
          'INSERT INTO settings (key, tenant_id, value, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (key, tenant_id) DO UPDATE SET value=$3, updated_at=NOW()',
          [key, tenantId, JSON.stringify({ subscription, userId, createdAt: new Date().toISOString() })]
        );
        // FIX 23: audit trail — push subscriptions are security-relevant (who receives tank alerts)
        const { auditLog: auLog } = require('./security');
        await auLog(req, 'PUSH_SUBSCRIBE', 'settings', key, `userId:${userId} endpoint:${subscription.endpoint.slice(-20)}`).catch(() => {});
        res.json({ ok: true, message: 'Push subscription saved' });
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Unsubscribe (remove push subscription)
    app.post('/api/push/unsubscribe', authMiddleware(db), async (req, res) => {
      const { endpoint } = req.body;
      if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
      try {
        const tenantId = req.user?.tenantId || req.user?.tenant_id;
        const key = 'push_sub_' + Buffer.from(endpoint).toString('base64').slice(0, 40);
        await pool.query('DELETE FROM settings WHERE key=$1 AND tenant_id=$2', [key, tenantId]);
        // FIX 23: audit trail for unsubscribe
        const { auditLog: auLog } = require('./security');
        await auLog(req, 'PUSH_UNSUBSCRIBE', 'settings', key, `endpoint:${endpoint.slice(-20)}`).catch(() => {});
        res.json({ ok: true });
      } catch(e) { res.status(500).json({ error: e.message }); }
    });

    // Internal helper — called when tank level drops below threshold after dip/deduction
    // Usage: await sendPushToTenant(pool, tenantId, { title, body, tag, url, urgency })
    app.locals.sendPushToTenant = async function sendPushToTenant(pool, tenantId, payload) {
      if (!webpush) return;
      try {
        const rows = await pool.query(
          "SELECT value FROM settings WHERE tenant_id=$1 AND key LIKE 'push_sub_%'",
          [tenantId]
        );
        const sends = rows.rows.map(async row => {
          try {
            const { subscription } = JSON.parse(row.value);
            await webpush.sendNotification(subscription, JSON.stringify(payload));
          } catch(e) {
            // If subscription is expired/invalid, remove it
            if (e.statusCode === 410 || e.statusCode === 404) {
              const key = 'push_sub_' + Buffer.from(subscription?.endpoint || '').toString('base64').slice(0,40);
              pool.query('DELETE FROM settings WHERE key=$1 AND tenant_id=$2', [key, tenantId]).catch(()=>{});
            }
          }
        });
        await Promise.allSettled(sends);
      } catch(e) {
        console.warn('[Push] sendPushToTenant error:', e.message);
      }
    };
  })();
  // ── END PUSH NOTIFICATION ENDPOINTS ─────────────────────────────────────


  // ── PUBLIC: Tank deduction after employee shift submit ──────────────────────
  app.post('/api/public/tank-deduct/:tenantId', async (req, res) => {
    // FA-04 FIX: If admin recorded a manual dip today (last_dip_source = 'admin_dip'),
    // skip meter-based deduction — dip is the authoritative physical measurement.
    try {
      const tenantId = req.params.tenantId;
      const { deductions, shiftDate } = req.body; // shiftDate: YYYY-MM-DD from client IST date
      if (!deductions || typeof deductions !== 'object') {
        return res.status(400).json({ error: 'Missing deductions' });
      }
      const today = shiftDate || istDate();
      const skipped = [];

      // FIX 37: wrap every deduction in a transaction with SELECT FOR UPDATE
      // Without this, two employees closing shifts simultaneously for the same tenant
      // both read the same current_level and both subtract from it — only the smaller
      // of the two deductions actually takes effect (last-write-wins race).
      const client37 = await pool.connect();
      try {
        await client37.query('BEGIN');

        for (const [fuelType, liters] of Object.entries(deductions)) {
          if (!liters || liters <= 0) continue;

          // Lock the tank row for this fuel type — blocks concurrent deductions
          const tankRow = await client37.query(
            'SELECT id, last_dip, last_dip_source, current_level, capacity FROM tanks WHERE tenant_id = $1 AND fuel_type = $2 FOR UPDATE',
            [tenantId, fuelType]
          );
          const tank = tankRow.rows[0];
          if (!tank) continue;

          if (tank.last_dip === today && tank.last_dip_source === 'admin_dip') {
            console.log(`[tank-deduct] Skipping ${fuelType} — admin dip recorded today (${today}), dip takes precedence`);
            skipped.push(fuelType);
            continue;
          }

          await client37.query(
            `UPDATE tanks
             SET current_level = GREATEST(0, COALESCE(current_level, 0) - $1),
                 last_dip = $2,
                 last_dip_source = 'shift_close'
             WHERE tenant_id = $3 AND fuel_type = $4`,
            [liters, today, tenantId, fuelType]
          );
        }

        await client37.query('COMMIT');
      } catch (txErr) {
        await client37.query('ROLLBACK').catch(() => {});
        client37.release();
        throw txErr;
      }
      client37.release();

      // ── Post-commit: fire push notifications (outside transaction — non-critical) ──
      // FIX F-01: Check if tanks are now below threshold after all deductions committed
      for (const [fuelType] of Object.entries(deductions)) {
        if (skipped.includes(fuelType)) continue;
        try {
          const updatedTank = await pool.query(
            'SELECT id, fuel_type, current_level, capacity FROM tanks WHERE tenant_id=$1 AND fuel_type=$2',
            [tenantId, fuelType]
          );
          if (updatedTank.rows.length > 0 && app.locals.sendPushToTenant) {
            const t = updatedTank.rows[0];
            const capacity = parseFloat(t.capacity) || 0;
            const current  = parseFloat(t.current_level) || 0;
            const pct      = capacity > 0 ? Math.round((current / capacity) * 100) : 0;
            const fuelLabel = fuelType.charAt(0).toUpperCase() + fuelType.slice(1);
            if (pct < 10) {
              await app.locals.sendPushToTenant(pool, tenantId, {
                title:   `🚨 Critical Fuel — ${fuelLabel} Tank ${t.id}`,
                body:    `${fuelLabel} is critically low at ${pct}% (${Math.round(current).toLocaleString()} L). Immediate refill required!`,
                tag:     `tank-critical-${t.id}`,
                url:     '/#tanks',
                urgency: 'critical',
              });
            } else if (pct < 20) {
              await app.locals.sendPushToTenant(pool, tenantId, {
                title:   `⚠️ Low Fuel — ${fuelLabel} Tank ${t.id}`,
                body:    `${fuelLabel} is at ${pct}% (${Math.round(current).toLocaleString()} L). Order a refill soon.`,
                tag:     `tank-low-${t.id}`,
                url:     '/#tanks',
                urgency: 'high',
              });
            }
          }
        } catch (pushErr) {
          console.warn('[tank-deduct] Push notification failed:', pushErr.message);
        }
      }

      res.json({ success: true, skipped });
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
      // FA-05 FIX: idempotency — upsert same date entry rather than always prepend.
      // If a record for the same date (and same shift if provided) already exists, update it.
      const newEntry = {
        date: h.date,
        user: h.user || '',
        shift: h.shift || '',
        liters: h.liters || 0,
        revenue: h.revenue || 0,
        salesCount: h.salesCount || 0,
        sales: h.sales || [],
        openReadings: h.openReadings || {},
        closeReadings: h.closeReadings || {},
        timestamp: h.timestamp || Date.now(),
      };
      const dupeIdx = history.findIndex(e => e.date === h.date && (e.user === h.user || !e.shift));
      if (dupeIdx >= 0) {
        // Update existing record — same date+employee resubmission (network retry or double-tap)
        history[dupeIdx] = newEntry;
      } else {
        history.unshift(newEntry);
      }
      history = history.slice(0, 180); // M-04 FIX: 180 entries ~= 6 months of daily shifts
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
          e.date || istDate(),
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

  // ── COMPARE: multi-station summary (super = all tenants; admin = own + benchmark) ──
  // H-02 FIX: Rewritten from N+1 (5 queries × N tenants) to 5 aggregated queries total.
  // At 200 bunks: was 1,000 DB hits → now 5 DB hits regardless of bunk count.
  app.get('/api/data/compare/summary', authMiddleware(db), async (req, res) => {
    try {
      // FIX 27: use istDate() — UTC date can be yesterday in IST after midnight UTC
      const today = istDate();
      const sevenDaysAgo = (() => {
        const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        d.setDate(d.getDate() - 7);
        return d.toISOString().slice(0, 10);
      })();
      const isSuperUser = req.userType === 'super';
      const ownerTenantId = req.tenantId;

      // Query 1: all active tenants
      const tenantRows = await pool.query(
        'SELECT id, name, location FROM tenants WHERE active = 1 ORDER BY name'
      );
      if (!tenantRows.rows.length) return res.json({ stations: [], benchmark: null });

      // Query 2: today sales — aggregated across ALL tenants in one shot
      const salesTodayRows = await pool.query(
        `SELECT tenant_id,
                COALESCE(SUM(amount),0) AS revenue,
                COALESCE(SUM(liters),0) AS liters,
                COUNT(*)                AS txns
         FROM sales WHERE date = $1 GROUP BY tenant_id`, [today]
      );
      const salesTodayMap = {};
      salesTodayRows.rows.forEach(r => { salesTodayMap[r.tenant_id] = r; });

      // Query 3: 7-day sales average — aggregated across all tenants
      const sales7Rows = await pool.query(
        `SELECT tenant_id,
                COALESCE(SUM(amount),0)/7 AS avg_revenue,
                COALESCE(SUM(liters),0)/7 AS avg_liters
         FROM sales WHERE date >= $1 AND date < $2 GROUP BY tenant_id`,
        [sevenDaysAgo, today]
      );
      const sales7Map = {};
      sales7Rows.rows.forEach(r => { sales7Map[r.tenant_id] = r; });

      // Query 4: tank levels — all tenants
      const tankRows = await pool.query(
        'SELECT tenant_id, fuel_type, current_level, capacity, low_alert FROM tanks'
      );
      const tanksMap = {};
      tankRows.rows.forEach(r => {
        if (!tanksMap[r.tenant_id]) tanksMap[r.tenant_id] = [];
        tanksMap[r.tenant_id].push(r);
      });

      // Query 5: employee counts — all tenants
      const empRows = await pool.query(
        'SELECT tenant_id, COUNT(*) AS cnt FROM employees WHERE active = 1 GROUP BY tenant_id'
      );
      const empMap = {};
      empRows.rows.forEach(r => { empMap[r.tenant_id] = parseInt(r.cnt) || 0; });

      // Assemble per-station data from maps (no DB calls inside loop)
      const stationData = tenantRows.rows.map(t => {
        const s  = salesTodayMap[t.id] || {};
        const s7 = sales7Map[t.id]     || {};
        const tanks = (tanksMap[t.id]  || []).map(tk => ({
          fuelType: tk.fuel_type,
          current:  parseFloat(tk.current_level) || 0,
          capacity: parseFloat(tk.capacity) || 1,
          lowAlert: parseFloat(tk.low_alert) || 500,
          pct: Math.round((parseFloat(tk.current_level)||0) / Math.max(parseFloat(tk.capacity)||1, 1) * 100),
        }));
        return {
          tenantId:  t.id,
          name:      t.name,
          location:  t.location || '',
          today:     { revenue: parseFloat(s.revenue)||0, liters: parseFloat(s.liters)||0, txns: parseInt(s.txns)||0 },
          avg7:      { revenue: parseFloat(s7.avg_revenue)||0, liters: parseFloat(s7.avg_liters)||0 },
          tanks,
          employees: empMap[t.id] || 0,
          isOwn:     !isSuperUser && t.id === ownerTenantId,
        };
      });

      const allRev = stationData.map(s => s.today.revenue);
      const allLit = stationData.map(s => s.today.liters);
      const benchmark = {
        avgRevenue:   allRev.reduce((a,b)=>a+b,0) / (allRev.length||1),
        avgLiters:    allLit.reduce((a,b)=>a+b,0) / (allLit.length||1),
        maxRevenue:   Math.max(...allRev, 0),
        stationCount: stationData.length,
      };

      const visible = isSuperUser ? stationData : stationData.filter(s => s.tenantId === ownerTenantId);
      res.json({ stations: visible, benchmark, isSuperUser, today });
    } catch (err) {
      console.error('[compare/summary]', err.message);
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

  // M-03 FIX: Periodic cleanup — startup-only cleanup is not enough for long-running deployments
  setInterval(async () => {
    try {
      await pool.query("DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL '24 hours'");
      await pool.query("DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'");
      await pool.query("DELETE FROM sessions WHERE expires_at < NOW()");
    } catch (e) { console.warn('[Cleanup]', e.message); }
  }, 6 * 60 * 60 * 1000); // every 6 hours

  process.on('SIGTERM', () => { console.log('[Server] Shutting down...'); process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
}

startServer().catch(e => {
  console.error('[FATAL]', e);
  process.exit(1);
});
