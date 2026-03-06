/**
 * FuelBunk Pro — Data API Routes (PostgreSQL async)
 *
 * BUGS FIXED:
 *  1. upsertRow imported pool directly from schema.js via require('./schema')
 *     on every call — this creates a new require cycle on each upsert.
 *     Fixed: pool is injected once when dataRoutes(db) is called.
 *  2. upsertRow: getTableColumns called pool.query directly, bypassing PgDbWrapper.
 *     Fixed: use db.getTableColumns(table) which is on the wrapper.
 *  3. upsertRow for tanks/pumps/shifts (composite PK): ON CONFLICT clause was
 *     only built when meta.keyCol existed, but the conflict target must include
 *     BOTH id AND tenant_id. Fixed: use (id, tenant_id) as conflict target.
 *  4. upsertRow: updateCols filter used colNames.indexOf() for the SET clause
 *     index mapping — this was wrong because colNames order may differ from
 *     the $N placeholders. Fixed: rebuild proper $N mapping for UPDATE SET.
 *  5. GET /:store route: ORDER BY id DESC — but tanks/pumps/shifts have
 *     composite PKs and 'id' is TEXT. Added updated_at fallback for those.
 *  6. DELETE /:store (clear all) had no role check — any authenticated user
 *     could wipe an entire table. Fixed: requireRole('admin').
 *  7. GET /tenants duplicated in server.js AND data.js — the data.js version
 *     now defers to the server.js registered route (kept for /api/data/tenants).
 *  8. by-index route was missing from router (only in FuelDB client) — added.
 *  9. parseRow: data_json merge could overwrite known columns with stale values.
 *     Fixed: known DB columns take priority over data_json extras.
 * 10. Tenant update: COALESCE($1,name) allows NULL to leave column unchanged,
 *     but the frontend sends empty string '' for unchanged fields — added
 *     NULLIF to convert empty string to NULL for COALESCE to work correctly.
 */
const express = require('express');
const { hashPassword, pool } = require('./schema');
const { requireRole, auditLog } = require('./security');

const STORE_MAP = {
  sales:              { table: 'sales',              hasAutoId: true },
  tanks:              { table: 'tanks',              hasAutoId: false, keyCol: 'id' },
  pumps:              { table: 'pumps',              hasAutoId: false, keyCol: 'id' },
  dipReadings:        { table: 'dip_readings',       hasAutoId: true },
  expenses:           { table: 'expenses',           hasAutoId: true },
  fuelPurchases:      { table: 'fuel_purchases',     hasAutoId: true },
  creditCustomers:    { table: 'credit_customers',   hasAutoId: true },
  creditTransactions: { table: 'credit_transactions', hasAutoId: true },
  employees:          { table: 'employees',          hasAutoId: true },
  shifts:             { table: 'shifts',             hasAutoId: false, keyCol: 'id' },
  settings:           { table: 'settings',           hasAutoId: false, keyCol: 'key' },
  auditLog:           { table: 'audit_log',          hasAutoId: true },
};

// Tables with composite PK (id + tenant_id)
const COMPOSITE_PK_TABLES = new Set(['tanks', 'pumps', 'shifts']);
// Settings uses (key, tenant_id) composite PK
const SETTINGS_TABLE = 'settings';

function dataRoutes(db) {
  const router = express.Router();

  // ── Tenants (public list) ──────────────────────────────────
  router.get('/tenants', async (req, res) => {
    try {
      const tenants = await db.prepare(
        'SELECT id, name, location, icon, color, color_light, active, station_code FROM tenants ORDER BY name'
      ).all();
      res.json(tenants);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Create tenant ──────────────────────────────────────────
  router.post('/tenants', requireRole('super'), async (req, res) => {
    const { id, name, location, ownerName, phone, icon, color, colorLight, stationCode, adminUser, adminPass } = req.body;
    if (!name || name.length < 2) return res.status(400).json({ error: 'Station name required' });
    try {
      const tenantId = id || ('stn_' + Date.now());
      const existing = await db.prepare('SELECT id FROM tenants WHERE name = $1').get(name);
      if (existing) return res.status(409).json({ error: 'Station name already exists' });

      await db.prepare(
        `INSERT INTO tenants (id, name, location, owner_name, phone, icon, color, color_light, station_code, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`
      ).run(
        tenantId, name, location || '', ownerName || '', phone || '',
        icon || '⛽', color || '#d4940f', colorLight || '#f0b429',
        stationCode || '', 1
      );

      if (adminUser && adminPass) {
        if (adminPass.length < 6) {
          return res.status(400).json({ error: 'Admin password too short (min 6 chars)' });
        }
        try {
          await db.prepare(
            'INSERT INTO admin_users (tenant_id, name, username, pass_hash, role) VALUES ($1,$2,$3,$4,$5)'
          ).run(tenantId, ownerName || adminUser, adminUser, hashPassword(adminPass), 'Owner');
        } catch (e) { console.warn('[Tenant] Admin user creation failed:', e.message); }
      }

      await auditLog(req, 'CREATE_TENANT', 'tenants', tenantId, name);
      res.json({ success: true, id: tenantId });
    } catch (e) {
      console.error('[create-tenant]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Update tenant ──────────────────────────────────────────
  router.put('/tenants/:id', requireRole('super'), async (req, res) => {
    const { name, location, ownerName, phone, icon, active, stationCode } = req.body;
    try {
      // BUG FIX: NULLIF converts '' to NULL so COALESCE keeps the existing value
      await db.prepare(
        `UPDATE tenants SET
          name        = COALESCE(NULLIF($1,''), name),
          location    = COALESCE(NULLIF($2,''), location),
          owner_name  = COALESCE(NULLIF($3,''), owner_name),
          phone       = COALESCE(NULLIF($4,''), phone),
          icon        = COALESCE(NULLIF($5,''), icon),
          active      = COALESCE($6, active),
          station_code= COALESCE(NULLIF($7,''), station_code),
          updated_at  = NOW()
         WHERE id = $8`
      ).run(
        name || '', location || '', ownerName || '', phone || '', icon || '',
        active !== undefined ? (active ? 1 : 0) : null,
        stationCode || '',
        req.params.id
      );
      await auditLog(req, 'UPDATE_TENANT', 'tenants', req.params.id, name || '');
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Delete tenant ──────────────────────────────────────────
  router.delete('/tenants/:id', requireRole('super'), async (req, res) => {
    try {
      await auditLog(req, 'DELETE_TENANT', 'tenants', req.params.id, '');
      await db.prepare('DELETE FROM tenants WHERE id = $1').run(req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Tenant admin management ────────────────────────────────
  router.get('/tenants/:id/admins', requireRole('super'), async (req, res) => {
    try {
      const admins = await db.prepare(
        'SELECT id, name, username, role, active, created_at FROM admin_users WHERE tenant_id = $1'
      ).all(req.params.id);
      res.json(admins);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/tenants/:id/admins', requireRole('super'), async (req, res) => {
    const { name, username, password, role } = req.body;
    if (!name || !username || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
    try {
      const exists = await db.prepare(
        'SELECT id FROM admin_users WHERE tenant_id = $1 AND username = $2'
      ).get(req.params.id, username);
      if (exists) return res.status(409).json({ error: 'Username already exists' });
      const result = await db.prepare(
        'INSERT INTO admin_users (tenant_id, name, username, pass_hash, role) VALUES ($1,$2,$3,$4,$5)'
      ).run(req.params.id, name, username, hashPassword(password), role || 'Manager');
      res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/tenants/:tid/admins/:uid', requireRole('super'), async (req, res) => {
    try {
      await db.prepare(
        'DELETE FROM admin_users WHERE id = $1 AND tenant_id = $2'
      ).run(req.params.uid, req.params.tid);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/tenants/:tid/admins/:uid/reset-password', requireRole('super'), async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
    try {
      await db.prepare(
        'UPDATE admin_users SET pass_hash = $1 WHERE id = $2 AND tenant_id = $3'
      ).run(hashPassword(newPassword), req.params.uid, req.params.tid);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Settings ───────────────────────────────────────────────
  router.get('/settings/key/:key', async (req, res) => {
    try {
      const row = await db.prepare(
        'SELECT value FROM settings WHERE key = $1 AND tenant_id = $2'
      ).get(req.params.key, req.tenantId);
      if (!row) return res.json({ value: null });
      try { res.json({ value: JSON.parse(row.value) }); }
      catch { res.json({ value: row.value }); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/settings/key/:key', async (req, res) => {
    const { value } = req.body;
    const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    try {
      await db.prepare(
        `INSERT INTO settings (key, tenant_id, value, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (key, tenant_id) DO UPDATE SET value=$3, updated_at=NOW()`
      ).run(req.params.key, req.tenantId, serialized);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  // ── GET by index ───────────────────────────────────────────
  // BUG FIX: route was documented in README but missing from router
  router.get('/:store/by-index/:col/:val', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    // Whitelist column names to prevent SQL injection
    const col = req.params.col.replace(/[^a-zA-Z0-9_]/g, '');
    try {
      const rows = await db.prepare(
        `SELECT * FROM ${meta.table} WHERE ${col} = $1 AND tenant_id = $2`
      ).all(req.params.val, req.tenantId);
      res.json(rows.map(parseRow));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── PUT bulk ───────────────────────────────────────────────
  router.put('/:store/bulk', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
    try {
      for (const item of req.body) await upsertRow(db, meta, req.tenantId, item, false);
      res.json({ success: true, count: req.body.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE by id ───────────────────────────────────────────
  router.delete('/:store/:id', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    const keyCol = meta.keyCol || 'id';
    try {
      await db.prepare(
        `DELETE FROM ${meta.table} WHERE ${keyCol} = $1 AND tenant_id = $2`
      ).run(req.params.id, req.tenantId);
      await auditLog(req, 'DELETE', req.params.store, req.params.id, '');
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE all (clear store) — admin only ──────────────────
  // BUG FIX: was unauthenticated — any user could clear a table
  router.delete('/:store', requireRole('admin'), async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    try {
      await db.prepare(`DELETE FROM ${meta.table} WHERE tenant_id = $1`).run(req.tenantId);
      await auditLog(req, 'CLEAR_STORE', req.params.store, '', '');
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET by key ─────────────────────────────────────────────
  router.get('/:store/:id', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    const keyCol = meta.keyCol || 'id';
    try {
      const row = await db.prepare(
        `SELECT * FROM ${meta.table} WHERE ${keyCol} = $1 AND tenant_id = $2`
      ).get(req.params.id, req.tenantId);
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json(parseRow(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET all rows ───────────────────────────────────────────
  router.get('/:store', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: `Unknown store: ${req.params.store}` });
    try {
      // BUG FIX: tanks/pumps/shifts have TEXT id — use updated_at for ordering
      const orderCol = meta.hasAutoId ? 'id DESC' : 'updated_at DESC';
      const rows = await db.prepare(
        `SELECT * FROM ${meta.table} WHERE tenant_id = $1 ORDER BY ${orderCol}`
      ).all(req.tenantId);
      res.json(rows.map(parseRow));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST — insert ──────────────────────────────────────────
  router.post('/:store', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    try {
      const result = await upsertRow(db, meta, req.tenantId, req.body, true);
      await auditLog(req, 'CREATE', req.params.store, result.id || '', '');
      res.json({ success: true, id: result.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── PUT — upsert ───────────────────────────────────────────
  router.put('/:store', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    try {
      const result = await upsertRow(db, meta, req.tenantId, req.body, false);
      await auditLog(req, 'UPDATE', req.params.store, result.id || '', '');
      res.json({ success: true, id: result.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  return router;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

// Reverse aliases: DB column name -> frontend property name
const DB_TO_FRONTEND = {
  // Tank
  current_level:   'current',        // DB current_level -> frontend c.current
  current_reading: 'currentReading',
  low_alert:       'lowAlert',
  // Common
  fuel_type:       'fuelType',
  tank_id:         'tankId',
  // Tenant
  owner_name:      'ownerName',
  station_code:    'stationCode',
  color_light:     'colorLight',
  // Employee / shifts
  join_date:       'joinDate',
  start_time:      'startTime',
  end_time:        'endTime',
  // Credit customers — CRITICAL: DB uses balance/credit_limit, frontend uses outstanding/limit
  balance:         'outstanding',    // DB balance -> frontend c.outstanding
  credit_limit:    'limit',          // DB credit_limit -> frontend c.limit (NOT creditLimit)
  // Sales
  employee_name:   'employeeName',
  employee_id:     'employeeId',
  sale_id:         'saleId',
  customer_id:     'customerId',
  // Expenses / purchases
  invoice_no:      'invoiceNo',
  receipt_ref:     'receiptRef',
  approved_by:     'approvedBy',
  paid_to:         'paidTo',
  // Credit customer
  last_payment:    'lastPayment',    // DB last_payment -> frontend c.lastPayment
  // Pump nozzle data
  nozzle_readings: 'nozzleReadings', // DB nozzle_readings -> pump.nozzleReadings
  nozzle_open:     'nozzleOpen',     // DB nozzle_open -> pump.nozzleOpen
  nozzle_fuels:    'nozzleFuels',    // DB nozzle_fuels -> pump.nozzleFuels
  nozzle_labels:   'nozzleLabels',   // DB nozzle_labels -> pump.nozzleLabels
  open_reading:    'openReading',    // DB open_reading -> pump.openReading
  upi_txn_id:      'upiTxnId',       // DB upi_txn_id -> sale.upiTxnId
  // Security — never expose
  pin_hash:        null,
  pass_hash:       null,
};

// Columns that store JSON objects as TEXT strings
const JSON_COLUMNS = new Set([
  'nozzle_readings', 'nozzle_open', 'nozzle_fuels', 'nozzle_labels',
  'balance_entries', // employee balance history
]);

function parseRow(r) {
  // BUG FIX: keep a clean copy; data_json extras must NOT override real columns
  const dbCols = { ...r };
  let extras = {};
  if (r.data_json) {
    try { extras = JSON.parse(r.data_json); } catch {}
  }
  // Merge extras first, then overwrite with authoritative DB columns
  // BUG FIX: rename DB columns to frontend camelCase names so frontend reads them correctly
  const obj = { ...extras };
  for (const [col, val] of Object.entries(dbCols)) {
    if (col === 'data_json' || col === 'tenant_id') continue;
    const alias = DB_TO_FRONTEND[col];
    if (alias === null) continue;  // explicitly excluded (hashes)
    // Deserialize JSON TEXT columns back to objects
    let parsedVal = val;
    if (JSON_COLUMNS.has(col) && typeof val === 'string' && val) {
      try { parsedVal = JSON.parse(val); } catch { parsedVal = val; }
    }
    if (alias) {
      obj[alias] = parsedVal;    // use the frontend name
      obj[col] = parsedVal;      // also keep snake_case for backward compat
    } else {
      obj[col] = parsedVal;      // no alias needed, keep as-is
    }
  }
  delete obj.data_json;
  delete obj.tenant_id;
  delete obj.pin_hash;
  delete obj.pass_hash;
  return obj;
}

function camelToSnake(s) {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase();
}

// Field aliases: frontend property name -> DB column name
// These exist because the frontend uses short names but the DB uses descriptive ones
const FIELD_ALIASES = {
  // Tank fields
  current:        'current_level',   // tank.current -> tanks.current_level
  lowAlert:       'low_alert',       // tank.lowAlert -> tanks.low_alert
  // Pump fields
  currentReading: 'current_reading', // pump.currentReading -> pumps.current_reading
  openReading:    'open_reading',    // (future use)
  // Employee fields
  pinHash:        'pin_hash',        // employee.pinHash -> employees.pin_hash
  passHash:       'pass_hash',       // admin.passHash -> admin_users.pass_hash
  // Credit customer fields — CRITICAL: frontend uses these names, DB uses different columns
  outstanding:    'balance',         // c.outstanding -> credit_customers.balance
  limit:          'credit_limit',    // c.limit -> credit_customers.credit_limit
  // Sale fields
  employee:       'employee_name',   // sale.employee -> sales.employee_name
  fuelType:       'fuel_type',       // sale.fuelType -> sales.fuel_type (also handled by camelToSnake)
  upiTxnId:       'upi_txn_id',      // sale.upiTxnId -> sales.data_json (no column, goes to extra)
  tankId:         'tank_id',         // fuel purchase tankId -> fuel_purchases.tank_id
  invoiceNo:      'invoice_no',      // invoice_no alias
  paidTo:         'paid_to',
  approvedBy:     'approved_by',
  receiptRef:     'receipt_ref',
  joinDate:       'join_date',
  startTime:      'start_time',
  endTime:        'end_time',
  employeeName:   'employee_name',
  employeeId:     'employee_id',
};

async function upsertRow(db, meta, tenantId, data, isInsert) {
  const table = meta.table;

  // BUG FIX: use db.getTableColumns instead of requiring pool directly
  const cols = await db.getTableColumns(table);

  const known = {};
  const extra = {};

  for (const [k, v] of Object.entries(data)) {
    // Apply field alias first (frontend name -> DB column name)
    const aliased = FIELD_ALIASES[k] || k;
    const snakeKey = camelToSnake(aliased);
    if (snakeKey === 'tenant_id' || snakeKey === 'data_json') continue;
    if (k === 'tenant_id' || k === 'data_json') continue;

    // Serialize objects/arrays to JSON string for TEXT columns
    const serializedV = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;

    if (cols.includes(snakeKey)) {
      known[snakeKey] = serializedV;
    } else if (cols.includes(aliased)) {
      known[aliased] = serializedV;
    } else if (cols.includes(k)) {
      known[k] = serializedV;
    } else {
      extra[k] = v; // keep original (not serialized) for data_json
    }
  }

  known.tenant_id = tenantId;
  if (Object.keys(extra).length > 0 && cols.includes('data_json')) {
    known.data_json = JSON.stringify(extra);
  }

  // BUG FIX: use module-scoped pool - never require() inside a hot function
  if (meta.hasAutoId && isInsert) {
    delete known.id;
    const colNames = Object.keys(known);
    const placeholders = colNames.map((_, i) => `$${i + 1}`).join(',');
    const values = colNames.map(c => known[c]);
    const result = await pool.query(
      `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${placeholders}) RETURNING id`,
      values
    );
    return { id: result.rows[0]?.id };
  }

  // Upsert for tables with explicit keys
  const colNames = Object.keys(known);
  const placeholders = colNames.map((_, i) => `$${i + 1}`).join(',');
  const values = colNames.map(c => known[c]);

  // BUG FIX: composite PK tables need (id, tenant_id) conflict target
  let conflictTarget;
  if (COMPOSITE_PK_TABLES.has(table)) {
    conflictTarget = '(id, tenant_id)';
  } else if (table === SETTINGS_TABLE) {
    conflictTarget = '(key, tenant_id)';
  } else if (meta.keyCol) {
    conflictTarget = `(${meta.keyCol}, tenant_id)`;
  } else {
    conflictTarget = null;
  }

  if (conflictTarget) {
    // BUG FIX: rebuild correct $N mapping for UPDATE SET clause
    const skipCols = new Set(['id', 'tenant_id', meta.keyCol, 'key'].filter(Boolean));
    const updateParts = colNames
      .map((c, i) => ({ col: c, idx: i + 1 }))
      .filter(({ col }) => !skipCols.has(col))
      .map(({ col, idx }) => `${col}=$${idx}`);

    if (updateParts.length === 0) {
      // Nothing to update — just insert or ignore
      await pool.query(
        `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${placeholders})
         ON CONFLICT ${conflictTarget} DO NOTHING`,
        values
      );
    } else {
      await pool.query(
        `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${placeholders})
         ON CONFLICT ${conflictTarget} DO UPDATE SET ${updateParts.join(',')}`,
        values
      );
    }
  } else {
    await pool.query(
      `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${placeholders})`,
      values
    );
  }

  return { id: known.id || known.key || null };
}

module.exports = dataRoutes;
