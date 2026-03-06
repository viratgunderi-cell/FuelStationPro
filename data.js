/**
 * FuelBunk Pro — Data API Routes (PostgreSQL async)
 */
const express = require('express');
const { hashPassword } = require('./schema');
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

// ── Field name mapping: frontend camelCase → DB snake_case column ──────────
// Only entries that DON'T auto-convert via camelToSnake, or need special aliases
const WRITE_ALIAS = {
  current:        'current_level',   // tanks
  lowAlert:       'low_alert',       // tanks
  lastDip:        'last_dip',        // tanks (stored in data_json if no column)
  outstanding:    'balance',         // credit_customers
  limit:          'credit_limit',    // credit_customers
  lastPayment:    'last_payment',    // credit_customers
  desc:           'description',     // expenses
  total:          'amount',          // fuel_purchases (frontend calls it total)
  invoice:        'invoice_no',      // fuel_purchases
  start:          'start_time',      // shifts
  end:            'end_time',        // shifts
  calculated:     'computed_volume', // dip_readings
  recordedBy:     'recorded_by',     // dip_readings
};

// ── Field name mapping: DB column → frontend camelCase ────────────────────
const READ_ALIAS = {
  current_level:   'current',
  low_alert:       'lowAlert',
  fuel_type:       'fuelType',
  tank_id:         'tankId',
  customer_id:     'customerId',
  sale_id:         'saleId',
  employee_id:     'employeeId',
  employee_name:   'employeeName',
  invoice_no:      'invoiceNo',
  paid_to:         'paidTo',
  receipt_ref:     'receiptRef',
  approved_by:     'approvedBy',
  start_time:      'startTime',
  end_time:        'endTime',
  balance:         'outstanding',
  credit_limit:    'limit',
  last_payment:    'lastPayment',
  computed_volume: 'calculated',
  recorded_by:     'recordedBy',
  pin_hash:        null,   // never send to frontend
  pass_hash:       null,   // never send to frontend
  nozzle_readings: 'nozzleReadings',
  nozzle_open:     'nozzleOpen',
  nozzle_fuels:    'nozzleFuels',
  nozzle_labels:   'nozzleLabels',
  open_reading:    'openReading',
  current_reading: 'currentReading',
  color_light:     'colorLight',
  owner_name:      'ownerName',
  station_code:    'stationCode',
  join_date:       'joinDate',
};

// Columns stored as JSON text that need parse on read
const JSON_TEXT_COLS = new Set([
  'nozzle_readings','nozzle_open','nozzle_fuels','nozzle_labels'
]);

function parseRow(r) {
  // Start with extras from data_json (lowest priority)
  let obj = {};
  if (r.data_json) {
    try { obj = JSON.parse(r.data_json); } catch {}
  }
  // Apply DB column values (overwrite data_json with real columns)
  for (const [col, val] of Object.entries(r)) {
    if (col === 'data_json' || col === 'tenant_id') continue;
    const alias = READ_ALIAS[col];
    if (alias === null) continue; // excluded field (pin_hash, pass_hash)
    let v = val;
    // Parse JSON text columns
    if (JSON_TEXT_COLS.has(col) && typeof val === 'string' && val) {
      try { v = JSON.parse(val); } catch {}
    }
    if (alias) {
      obj[alias] = v;  // camelCase for frontend (primary)
      obj[col]   = v;  // snake_case also kept for backward compat
      // Extra shift compatibility
      if (col === 'start_time') obj.start = v;
      if (col === 'end_time')   obj.end   = v;
    } else {
      obj[col] = v;
    }
  }
  return obj;
}

function camelToSnake(s) {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase();
}

// Cache table columns to avoid repeated DB queries
const _colCache = {};

async function getTableCols(pool, table) {
  if (_colCache[table]) return _colCache[table];
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]
  );
  _colCache[table] = r.rows.map(row => row.column_name);
  return _colCache[table];
}

async function upsertRow(db, meta, tenantId, data, isInsert) {
  const table = meta.table;
  const { pool } = require('./schema');
  const cols = await getTableCols(pool, table);

  const known = {};
  const extra = {};

  for (const [k, v] of Object.entries(data)) {
    if (k === 'tenant_id' || k === 'data_json') continue;

    // Step 1: check explicit write alias
    const aliased = WRITE_ALIAS[k];
    // Step 2: try camelToSnake
    const snake = camelToSnake(k);

    // Serialize objects/arrays for storage
    const sv = (v !== null && v !== undefined && typeof v === 'object') ? JSON.stringify(v) : v;

    if (aliased && cols.includes(aliased)) {
      known[aliased] = sv;
    } else if (cols.includes(snake)) {
      known[snake] = sv;
    } else if (cols.includes(k)) {
      known[k] = sv;
    } else {
      // Goes to data_json
      extra[k] = v;
    }
  }

  known.tenant_id = tenantId;
  if (Object.keys(extra).length > 0 && cols.includes('data_json')) {
    known.data_json = JSON.stringify(extra);
  }

  const colNames = Object.keys(known);
  const placeholders = colNames.map((_, i) => `$${i + 1}`).join(',');
  const values = colNames.map(c => known[c]);

  // Tables with composite PK (id, tenant_id)
  const COMPOSITE_PK_TABLES = new Set(['tanks', 'pumps', 'shifts']);

  if (meta.hasAutoId && isInsert) {
    // Auto-increment insert
    delete known.id;
    const colNames2 = Object.keys(known);
    const ph2 = colNames2.map((_, i) => `$${i + 1}`).join(',');
    const vals2 = colNames2.map(c => known[c]);
    const result = await pool.query(
      `INSERT INTO ${table} (${colNames2.join(',')}) VALUES (${ph2}) RETURNING id`,
      vals2
    );
    return { id: result.rows[0]?.id };
  }

  // Determine conflict target
  let conflictTarget;
  if (COMPOSITE_PK_TABLES.has(table)) {
    conflictTarget = '(id, tenant_id)';
  } else if (table === 'settings') {
    conflictTarget = '(key, tenant_id)';
  } else if (meta.keyCol) {
    conflictTarget = `(${meta.keyCol}, tenant_id)`;
  } else {
    conflictTarget = null;
  }

  if (conflictTarget) {
    const skipInUpdate = new Set(['id', 'tenant_id', meta.keyCol, 'key'].filter(Boolean));
    const updateParts = colNames
      .map((c, i) => ({ c, i: i + 1 }))
      .filter(({ c }) => !skipInUpdate.has(c))
      .map(({ c, i }) => `${c}=$${i}`);

    if (updateParts.length === 0) {
      await pool.query(
        `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${placeholders}) ON CONFLICT ${conflictTarget} DO NOTHING`,
        values
      );
    } else {
      await pool.query(
        `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${placeholders}) ON CONFLICT ${conflictTarget} DO UPDATE SET ${updateParts.join(',')}`,
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

function dataRoutes(db) {
  const router = express.Router();

  // ── Tenant routes ──────────────────────────────────────────────────────────
  router.get('/tenants', async (req, res) => {
    try {
      const tenants = await db.prepare('SELECT id, name, location, icon, color, color_light, active, station_code FROM tenants ORDER BY name').all();
      res.json(tenants);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/tenants', requireRole('super'), async (req, res) => {
    const { id, name, location, ownerName, phone, icon, color, colorLight, stationCode, adminUser, adminPass } = req.body;
    if (!name || name.length < 2) return res.status(400).json({ error: 'Station name required' });
    try {
      const tenantId = id || ('stn_' + Date.now());
      const existing = await db.prepare('SELECT id FROM tenants WHERE name = $1').get(name);
      if (existing) return res.status(409).json({ error: 'Station name already exists' });
      await db.prepare(
        'INSERT INTO tenants (id, name, location, owner_name, phone, icon, color, color_light, station_code, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)'
      ).run(tenantId, name, location||'', ownerName||'', phone||'', icon||'⛽', color||'#d4940f', colorLight||'#f0b429', stationCode||'', 1);
      if (adminUser && adminPass) {
        try {
          await db.prepare(
            'INSERT INTO admin_users (tenant_id, name, username, pass_hash, role) VALUES ($1,$2,$3,$4,$5)'
          ).run(tenantId, ownerName||adminUser, adminUser, hashPassword(adminPass), 'Owner');
        } catch (e) { console.warn('[Tenant] Admin user creation failed:', e.message); }
      }
      await auditLog(req, 'CREATE_TENANT', 'tenants', tenantId, name);
      res.json({ success: true, id: tenantId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/tenants/:id', requireRole('super'), async (req, res) => {
    const { name, location, ownerName, phone, icon, active, stationCode } = req.body;
    try {
      await db.prepare(
        'UPDATE tenants SET name=COALESCE($1,name), location=COALESCE($2,location), owner_name=COALESCE($3,owner_name), phone=COALESCE($4,phone), icon=COALESCE($5,icon), active=COALESCE($6,active), station_code=COALESCE($7,station_code), updated_at=NOW() WHERE id=$8'
      ).run(name, location, ownerName, phone, icon, active !== undefined ? (active ? 1 : 0) : null, stationCode, req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/tenants/:id', requireRole('super'), async (req, res) => {
    try {
      await auditLog(req, 'DELETE_TENANT', 'tenants', req.params.id, '');
      await db.prepare('DELETE FROM tenants WHERE id = $1').run(req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/tenants/:id/admins', requireRole('super'), async (req, res) => {
    try {
      const admins = await db.prepare('SELECT id, name, username, role, active, created_at FROM admin_users WHERE tenant_id = $1').all(req.params.id);
      res.json(admins);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/tenants/:id/admins', requireRole('super'), async (req, res) => {
    const { name, username, password, role } = req.body;
    if (!name || !username || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
    try {
      const exists = await db.prepare('SELECT id FROM admin_users WHERE tenant_id = $1 AND username = $2').get(req.params.id, username);
      if (exists) return res.status(409).json({ error: 'Username already exists' });
      const result = await db.prepare('INSERT INTO admin_users (tenant_id, name, username, pass_hash, role) VALUES ($1,$2,$3,$4,$5)').run(req.params.id, name, username, hashPassword(password), role||'Manager');
      res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/tenants/:tid/admins/:uid', requireRole('super'), async (req, res) => {
    try {
      await db.prepare('DELETE FROM admin_users WHERE id = $1 AND tenant_id = $2').run(req.params.uid, req.params.tid);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/tenants/:tid/admins/:uid/reset-password', requireRole('super'), async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
    try {
      await db.prepare('UPDATE admin_users SET pass_hash = $1 WHERE id = $2 AND tenant_id = $3').run(hashPassword(newPassword), req.params.uid, req.params.tid);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Settings routes — MUST be before /:store routes ───────────────────────
  router.get('/settings/key/:key', async (req, res) => {
    try {
      const row = await db.prepare('SELECT value FROM settings WHERE key = $1 AND tenant_id = $2').get(req.params.key, req.tenantId);
      if (!row) return res.json({ value: null });
      try { res.json({ value: JSON.parse(row.value) }); } catch { res.json({ value: row.value }); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/settings/key/:key', async (req, res) => {
    const { value } = req.body;
    const serialized = (value !== null && value !== undefined && typeof value === 'object')
      ? JSON.stringify(value) : String(value ?? '');
    try {
      await db.prepare(
        'INSERT INTO settings (key, tenant_id, value, updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (key, tenant_id) DO UPDATE SET value=$3, updated_at=NOW()'
      ).run(req.params.key, req.tenantId, serialized);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── By-index — MUST be before /:store/:id ─────────────────────────────────
  router.get('/:store/by-index/:indexName/:value', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    const { pool } = require('./schema');
    // Map frontend index name to DB column
    const colMap = { fuelType: 'fuel_type', date: 'date', tankId: 'tank_id', customerId: 'customer_id' };
    const col = colMap[req.params.indexName] || camelToSnake(req.params.indexName);
    // Whitelist check
    const safeCol = col.replace(/[^a-z0-9_]/g, '');
    try {
      const result = await pool.query(
        `SELECT * FROM ${meta.table} WHERE ${safeCol} = $1 AND tenant_id = $2 ORDER BY id DESC`,
        [req.params.value, req.tenantId]
      );
      res.json(result.rows.map(parseRow));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Generic store routes ───────────────────────────────────────────────────
  router.get('/:store', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: `Unknown store: ${req.params.store}` });
    try {
      const { pool } = require('./schema');
      // Composite PK tables don't have sequential id, order by updated_at
      const COMPOSITE = new Set(['tanks', 'pumps', 'shifts']);
      const orderBy = (!meta.hasAutoId || COMPOSITE.has(meta.table)) ? 'updated_at DESC NULLS LAST' : 'id DESC';
      const result = await pool.query(
        `SELECT * FROM ${meta.table} WHERE tenant_id = $1 ORDER BY ${orderBy}`,
        [req.tenantId]
      );
      res.json(result.rows.map(parseRow));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/:store/:id', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    const keyCol = meta.keyCol || 'id';
    try {
      const row = await db.prepare(`SELECT * FROM ${meta.table} WHERE ${keyCol} = $1 AND tenant_id = $2`).get(req.params.id, req.tenantId);
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json(parseRow(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/:store', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    try {
      const result = await upsertRow(db, meta, req.tenantId, req.body, true);
      await auditLog(req, 'CREATE', req.params.store, result.id||'', '');
      res.json({ success: true, id: result.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/:store', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    try {
      const result = await upsertRow(db, meta, req.tenantId, req.body, false);
      await auditLog(req, 'UPDATE', req.params.store, result.id||'', '');
      res.json({ success: true, id: result.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/:store/bulk', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
    try {
      for (const item of req.body) await upsertRow(db, meta, req.tenantId, item, false);
      res.json({ success: true, count: req.body.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/:store/:id', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    const keyCol = meta.keyCol || 'id';
    try {
      await db.prepare(`DELETE FROM ${meta.table} WHERE ${keyCol} = $1 AND tenant_id = $2`).run(req.params.id, req.tenantId);
      await auditLog(req, 'DELETE', req.params.store, req.params.id, '');
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = dataRoutes;
