/**
 * FuelBunk Pro — Data API Routes (PostgreSQL)
 * All routes use pool.query directly to avoid PgDbWrapper/convertSql issues.
 */
const express = require('express');
const { hashPassword } = require('./schema');
const { requireRole, auditLog } = require('./security');
const { pool } = require('./schema');

// ── Store metadata ─────────────────────────────────────────────────────────
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
  lubesProducts:      { table: 'lubes_products',     hasAutoId: false, keyCol: 'id' },
  lubesSales:         { table: 'lubes_sales',        hasAutoId: true },
};

// ── Frontend → DB column mapping (write) ──────────────────────────────────
const WRITE_ALIAS = {
  current:        'current_level',
  lowAlert:       'low_alert',
  outstanding:    'balance',
  limit:          'credit_limit',
  lastPayment:    'last_payment',
  desc:           'description',
  // total → amount mapping removed (no table has 'total' column)
  invoice:        'invoice_no',
  // 'start' and 'end' are legacy shorthand; use startTime/endTime for clarity
  calculated:     'computed_volume',
  recordedBy:     'recorded_by',
  fuelType:       'fuel_type',
  tankId:         'tank_id',
  customerId:     'customer_id',
  employeeId:     'employee_id',
  employeeName:   'employee_name',
  paidTo:         'paid_to',
  receiptRef:     'receipt_ref',
  approvedBy:     'approved_by',
  startTime:      'start_time',
  endTime:        'end_time',
  joinDate:       'join_date',
  colorLight:     'color_light',
  ownerName:      'owner_name',
  stationCode:    'station_code',
  nozzleReadings: 'nozzle_readings',
  nozzleOpen:     'nozzle_open',
  nozzleFuels:    'nozzle_fuels',
  nozzleLabels:   'nozzle_labels',
  openReading:    'open_reading',
  currentReading: 'current_reading',
  pinHash:        'pin_hash',
  passHash:       'pass_hash',
};

// ── DB column → frontend mapping (read) ───────────────────────────────────
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
  pin_hash:        'pinHash',
  pass_hash:       null,
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
  description:     'desc',
  last_dip:        'lastDip',
};

const JSON_TEXT_COLS = new Set([
  'nozzle_readings', 'nozzle_open', 'nozzle_fuels', 'nozzle_labels'
]);

// ── Parse a DB row → frontend object ──────────────────────────────────────
function parseRow(r) {
  let obj = {};
  // Start from data_json extras (lowest priority)
  if (r.data_json) {
    try { obj = JSON.parse(r.data_json); } catch {}
  }
  // Apply real DB columns (higher priority, overwrite data_json)
  for (const [col, val] of Object.entries(r)) {
    if (col === 'data_json' || col === 'tenant_id') continue;
    const alias = READ_ALIAS[col];
    if (alias === null) continue; // excluded (pin_hash, pass_hash)
    let v = val;
    if (JSON_TEXT_COLS.has(col) && typeof val === 'string' && val) {
      try { v = JSON.parse(val); } catch {}
    }
    if (alias) {
      obj[alias] = v;  // camelCase (primary for frontend)
      obj[col]   = v;  // snake_case kept for compatibility
      if (col === 'start_time') { obj.start = v; obj.startTime = v; }
      if (col === 'end_time')   { obj.end   = v; obj.endTime   = v; }
    } else {
      obj[col] = v;
    }
  }
  return obj;
}

function camelToSnake(s) {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase();
}

// Cache table columns
const _colCache = {};
async function getTableCols(table) {
  if (_colCache[table]) return _colCache[table];
  const r = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
    [table]
  );
  _colCache[table] = r.rows.map(row => row.column_name);
  return _colCache[table];
}

// ── Upsert a row using direct pool.query ──────────────────────────────────
async function upsertRow(meta, tenantId, data, isInsert) {
  const table = meta.table;
  const cols = await getTableCols(table);

  const known = {};
  const extra = {};

  for (const [k, v] of Object.entries(data)) {
    if (k === 'tenant_id' || k === 'data_json') continue;
    const sv = (v !== null && v !== undefined && typeof v === 'object') ? JSON.stringify(v) : v;

    // Priority: explicit alias → snake_case → original key
    const aliased = WRITE_ALIAS[k];
    const snake = camelToSnake(k);

    if (aliased && cols.includes(aliased)) {
      known[aliased] = sv;                                    // camelCase → DB column (highest priority)
    } else if (cols.includes(snake) && snake !== 'tenant_id' && snake !== 'data_json') {
      if (!(snake in known)) known[snake] = sv;              // snake_case — only if not already set by alias above
    } else if (cols.includes(k) && k !== 'tenant_id' && k !== 'data_json') {
      if (!(k in known)) known[k] = sv;                     // original key — only if not already set
    } else {
      extra[k] = v;
    }
  }

  known.tenant_id = tenantId;
  if (Object.keys(extra).length > 0 && cols.includes('data_json')) {
    known.data_json = JSON.stringify(extra);
  }

  const COMPOSITE_PK = new Set(['tanks', 'pumps', 'shifts']);

  if (meta.hasAutoId && isInsert) {
    // Auto-ID insert: exclude 'id' from columns, use SERIAL, RETURNING id
    delete known.id;
    const colNames = Object.keys(known);
    const ph = colNames.map((_, i) => `$${i + 1}`).join(',');
    const vals = colNames.map(c => known[c]);
    const result = await pool.query(
      `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${ph}) RETURNING id`,
      vals
    );
    return { id: result.rows[0]?.id };
  }

  // Upsert (non-auto-id or update)
  const colNames = Object.keys(known);
  const ph = colNames.map((_, i) => `$${i + 1}`).join(',');
  const vals = colNames.map(c => known[c]);

  let conflictTarget;
  if (COMPOSITE_PK.has(table)) {
    conflictTarget = '(id, tenant_id)';
  } else if (table === 'settings') {
    conflictTarget = '(key, tenant_id)';
  } else if (meta.keyCol) {
    conflictTarget = `(${meta.keyCol}, tenant_id)`;
  }

  if (conflictTarget) {
    const skipCols = new Set(['id', 'tenant_id', meta.keyCol, 'key'].filter(Boolean));
    const updateParts = colNames
      .map((c, i) => ({ c, i: i + 1 }))
      .filter(({ c }) => !skipCols.has(c))
      .map(({ c, i }) => `${c}=$${i}`);

    // Always touch updated_at if the table has it (ensures freshness)
    if (cols.includes('updated_at') && !colNames.includes('updated_at')) {
      updateParts.push('updated_at=NOW()');
    }

    if (updateParts.length === 0) {
      await pool.query(
        `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${ph}) ON CONFLICT ${conflictTarget} DO NOTHING`,
        vals
      );
    } else {
      await pool.query(
        `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${ph}) ON CONFLICT ${conflictTarget} DO UPDATE SET ${updateParts.join(',')}`,
        vals
      );
    }
  } else {
    // No conflict target — bare insert (handles hasAutoId=true update case)
    // For updates to existing auto-id rows, use id in WHERE
    if (!meta.hasAutoId || !known.id) {
      await pool.query(
        `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${ph})`,
        vals
      );
    } else {
      // Update by id
      const updateCols = colNames.filter(c => c !== 'id' && c !== 'tenant_id');
      if (updateCols.length > 0) {
        const setStr = updateCols.map((c, i) => `${c}=$${i + 1}`).join(',');
        const updateVals = [...updateCols.map(c => known[c]), known.id, tenantId];
        await pool.query(
          `UPDATE ${table} SET ${setStr} WHERE id=$${updateCols.length + 1} AND tenant_id=$${updateCols.length + 2}`,
          updateVals
        );
      }
    }
  }
  return { id: known.id || known.key || null };
}

function dataRoutes(db) {
  const router = express.Router();

  // Tenant CRUD is handled in server.js with explicit priority routes.
  // Those routes cover all /api/data/tenants/* paths before this router mounts.

    // ── Settings routes — MUST be before /:store ──────────────────────────────
  router.get('/settings/key/:key', async (req, res) => {
    try {
      const r = await pool.query(
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

  router.put('/settings/key/:key', async (req, res) => {
    const { value } = req.body;
    const serialized = (value !== null && value !== undefined && typeof value === 'object')
      ? JSON.stringify(value) : String(value ?? '');
    try {
      await pool.query(
        'INSERT INTO settings (key, tenant_id, value, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (key, tenant_id) DO UPDATE SET value = $3, updated_at = NOW()',
        [req.params.key, req.tenantId || '', serialized]
      );
      res.json({ success: true });
    } catch (e) {
      console.error('[Settings PUT]', req.params.key, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── By-index — MUST be before /:store/:id ─────────────────────────────────
  router.get('/:store/by-index/:indexName/:value', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    const colMap = {
      fuelType: 'fuel_type', date: 'date', tankId: 'tank_id',
      customerId: 'customer_id', employeeId: 'employee_id'
    };
    const col = colMap[req.params.indexName] || camelToSnake(req.params.indexName);
    const safeCol = col.replace(/[^a-z0-9_]/g, '');
    try {
      const cols = await getTableCols(meta.table);
      const orderCol = cols.includes('id') ? 'id DESC' : 'updated_at DESC NULLS LAST';
      const r = await pool.query(
        `SELECT * FROM ${meta.table} WHERE ${safeCol} = $1 AND tenant_id = $2 ORDER BY ${orderCol}`,
        [req.params.value, req.tenantId]
      );
      res.json(r.rows.map(parseRow));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Generic store GET all ──────────────────────────────────────────────────
  router.get('/:store', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: `Unknown store: ${req.params.store}` });
    try {
      const COMPOSITE = new Set(['tanks', 'pumps', 'shifts']);
      const orderBy = (!meta.hasAutoId || COMPOSITE.has(meta.table)) ? 'updated_at DESC NULLS LAST' : 'id DESC';
      const r = await pool.query(
        `SELECT * FROM ${meta.table} WHERE tenant_id = $1 ORDER BY ${orderBy}`,
        [req.tenantId]
      );
      res.json(r.rows.map(parseRow));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Generic store GET by ID ────────────────────────────────────────────────
  router.get('/:store/:id', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    const keyCol = meta.keyCol || 'id';
    try {
      const r = await pool.query(
        `SELECT * FROM ${meta.table} WHERE ${keyCol} = $1 AND tenant_id = $2`,
        [req.params.id, req.tenantId]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
      res.json(parseRow(r.rows[0]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Generic store POST (create) ───────────────────────────────────────────
  router.post('/:store', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    try {
      const result = await upsertRow(meta, req.tenantId, req.body, true);
      await auditLog(req, 'CREATE', req.params.store, String(result.id||''), '');
      res.json({ success: true, id: result.id });
    } catch (e) {
      console.error('[POST /:store]', req.params.store, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Bulk PUT — MUST be before PUT /:store (Express matches /:store first otherwise) ──
  router.put('/:store/bulk', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
    try {
      for (const item of req.body) await upsertRow(meta, req.tenantId, item, false);
      res.json({ success: true, count: req.body.length });
    } catch (e) {
      console.error('[BULK PUT]', req.params.store, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Generic store PUT (upsert) ────────────────────────────────────────────
  router.put('/:store', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    try {
      const result = await upsertRow(meta, req.tenantId, req.body, false);
      await auditLog(req, 'UPDATE', req.params.store, String(result.id||''), '');
      res.json({ success: true, id: result.id });
    } catch (e) {
      console.error('[PUT /:store]', req.params.store, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Generic store DELETE all (clear) ─────────────────────────────────────
  router.delete('/:store', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    try {
      await pool.query(`DELETE FROM ${meta.table} WHERE tenant_id = $1`, [req.tenantId]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Generic store DELETE by id ────────────────────────────────────────────
  router.delete('/:store/:id', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    const keyCol = meta.keyCol || 'id';
    try {
      await pool.query(
        `DELETE FROM ${meta.table} WHERE ${keyCol} = $1 AND tenant_id = $2`,
        [req.params.id, req.tenantId]
      );
      await auditLog(req, 'DELETE', req.params.store, req.params.id, '');
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = dataRoutes;
