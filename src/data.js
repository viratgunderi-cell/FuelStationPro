/**
 * FuelBunk Pro — Data API Routes (PostgreSQL)
 * All routes use pool.query directly to avoid PgDbWrapper/convertSql issues.
 */
const express = require('express');
const { hashPassword } = require('./schema');
const { requireRole, auditLog } = require('./security');
const { pool } = require('./schema');

// FIX 27b: IST date helper — use everywhere instead of new Date().toISOString().slice(0,10)
// Prevents off-by-one on dates between midnight IST (18:30 UTC prev day) and midnight UTC
function istDate() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
}

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
  // FIX 38: explicit aliases for tank dip columns — prevents camelToSnake from
  // silently dropping these if column names ever diverge from convention
  lastDip:        'last_dip',
  lastDipSource:  'last_dip_source',
  idempotencyKey: 'idempotency_key',  // FIX 35b: ensure admin sales route stores key
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

// Cache table columns — invalidated after startup delay to pick up any schema migrations
const _colCache = {};
let _colCacheReady = false;
// Allow schema migrations (run on startup) to complete before locking in column cache.
// After 30s the cache is considered stable for the lifetime of the process.
setTimeout(() => { _colCacheReady = true; }, 30000);

async function getTableCols(table) {
  // BUG-F FIX: Don't use stale cache in the first 30s after startup (migration window).
  if (_colCacheReady && _colCache[table]) return _colCache[table];
  const r = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
    [table]
  );
  const cols = r.rows.map(row => row.column_name);
  if (_colCacheReady) _colCache[table] = cols;
  return cols;
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
  // Fix 01A: date-heavy stores accept ?from=YYYY-MM-DD to limit rows returned.
  // Tanks, pumps, employees, shifts etc. are small/static — always returned in full.
  const DATE_FILTERABLE = new Set(['sales', 'expenses', 'dipReadings', 'fuelPurchases', 'creditTransactions']);
  router.get('/:store', async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: `Unknown store: ${req.params.store}` });
    try {
      const COMPOSITE = new Set(['tanks', 'pumps', 'shifts']);
      const orderBy = (!meta.hasAutoId || COMPOSITE.has(meta.table)) ? 'updated_at DESC NULLS LAST' : 'id DESC';
      const fromDate = req.query.from;
      const useFilter = fromDate && DATE_FILTERABLE.has(req.params.store);
      const sql = useFilter
        ? `SELECT * FROM ${meta.table} WHERE tenant_id = $1 AND date >= $2 ORDER BY ${orderBy}`
        : `SELECT * FROM ${meta.table} WHERE tenant_id = $1 ORDER BY ${orderBy}`;
      const params = useFilter ? [req.tenantId, fromDate] : [req.tenantId];
      const r = await pool.query(sql, params);
      // FIX #43: audit log bulk exports so admins can track who exported what data
      if (req.query.export === '1' || req.query.export === 'true') {
        auditLog(req, 'EXPORT', req.params.store, '', `${r.rows.length} rows`).catch(() => {});
      }
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

  // ── Day-Lock helper ───────────────────────────────────────────────────────
  // Stores that should be blocked once a day is closed.
  const DAY_LOCKED_STORES = new Set([
    'sales', 'dipReadings', 'expenses', 'fuelPurchases',
    'creditTransactions', 'lubesSales'
  ]);

  async function checkDayLock(req, res, next) {
    const store = req.params.store;
    if (!DAY_LOCKED_STORES.has(store)) return next();

    // FIX 21: bulk upsert sends body as an array — check every record's date, not just body.date
    const body = req.body;
    const records = Array.isArray(body) ? body : [body];
    const today = istDate();
    const datesToCheck = new Set(
      records.map(r => (r && r.date ? String(r.date).slice(0, 10) : today))
    );

    try {
      for (const recDate of datesToCheck) {
        const r = await pool.query(
          `SELECT value FROM settings WHERE key = $1 AND tenant_id = $2`,
          [`day_lock_${recDate}`, req.tenantId || '']
        );
        if (r.rows[0] && r.rows[0].value === 'true') {
          return res.status(423).json({
            error: `Day ${recDate} is locked. Unlock from Settings → Day-Lock before editing.`,
            locked: true, date: recDate
          });
        }
      }
    } catch (e) {
      // FIX 16: fail-closed — if we cannot confirm the day is UNLOCKED, block the write.
      console.error('[checkDayLock] DB error — blocking write as precaution:', e.message);
      return res.status(503).json({
        error: 'Cannot verify day-lock status due to a database error. Please retry in a few seconds.',
        retryable: true,
      });
    }
    return next();
  }

  // ── Day-Lock admin routes (Owner only) ────────────────────────────────────
  router.post('/day-lock/:date/close', async (req, res) => {
    // Only Owner role can close books
    if (req.userRole !== 'Owner' && req.userRole !== 'super') {
      return res.status(403).json({ error: 'Only Owner can close books' });
    }
    const date = req.params.date; // YYYY-MM-DD
    // FIX #12: regex only checks format; also validate it's a real calendar date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date).getTime()))
      return res.status(400).json({ error: 'Invalid date format' });
    try {
      await pool.query(
        `INSERT INTO settings (key, tenant_id, value, updated_at)
         VALUES ($1, $2, 'true', NOW())
         ON CONFLICT (key, tenant_id) DO UPDATE SET value='true', updated_at=NOW()`,
        [`day_lock_${date}`, req.tenantId || '']
      );
      await auditLog(req, 'DAY_LOCK_CLOSE', 'settings', date, '');
      res.json({ success: true, date, locked: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/day-lock/:date/open', async (req, res) => {
    if (req.userRole !== 'Owner' && req.userRole !== 'super') {
      return res.status(403).json({ error: 'Only Owner can unlock books' });
    }
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ error: 'Invalid date format' });
    try {
      await pool.query(
        `DELETE FROM settings WHERE key = $1 AND tenant_id = $2`,
        [`day_lock_${date}`, req.tenantId || '']
      );
      await auditLog(req, 'DAY_LOCK_OPEN', 'settings', date, '');
      res.json({ success: true, date, locked: false });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/day-lock/:date/status', async (req, res) => {
    const date = req.params.date;
    try {
      const r = await pool.query(
        `SELECT value FROM settings WHERE key = $1 AND tenant_id = $2`,
        [`day_lock_${date}`, req.tenantId || '']
      );
      res.json({ date, locked: !!(r.rows[0] && r.rows[0].value === 'true') });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── H-03 FIX: Credit payment deducts customer balance atomically ────────────
  // The generic upsertRow() only inserts the transaction record — it cannot know
  // to also UPDATE credit_customers.balance. This route intercepts payment records.
  router.post('/creditTransactions', checkDayLock, async (req, res) => {
    const client = await pool.connect();
    try {
      const data = req.body;
      await client.query('BEGIN');

      // FIX F-10: Hard credit limit check — block sale if it would push customer over their limit
      // Previously only a soft client-side warning was shown (checkCreditAlerts at 85%)
      if ((data.type || 'sale').toLowerCase() === 'sale' && data.amount > 0) {
        const custId = data.customerId || data.customer_id;
        if (custId) {
          // FIX #40: Use FOR UPDATE to prevent TOCTOU race — two simultaneous sales
          // could both pass the limit check against the same pre-update balance
          const custRow = await client.query(
            'SELECT balance, credit_limit FROM credit_customers WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
            [custId, req.tenantId]
          );
          if (custRow.rows.length > 0) {
            const { balance, credit_limit } = custRow.rows[0];
            const currentBalance = parseFloat(balance) || 0;
            const limit = parseFloat(credit_limit) || 0;
            const saleAmount = parseFloat(data.amount) || 0;
            if (limit > 0 && (currentBalance + saleAmount) > limit) {
              await client.query('ROLLBACK');
              client.release();
              // FIX #14: standardize on error: field (not message:) for consistent API shape
              return res.status(422).json({
                error: `Credit limit exceeded. Outstanding: ₹${currentBalance.toFixed(2)}, Limit: ₹${limit.toFixed(2)}, This sale: ₹${saleAmount.toFixed(2)}. Remaining credit: ₹${Math.max(0, limit - currentBalance).toFixed(2)}.`,
                outstanding: currentBalance,
                limit,
                saleAmount,
                remainingCredit: Math.max(0, limit - currentBalance),
              });
            }
          }
        }
      }

      // Insert the transaction record
      const r = await client.query(
        `INSERT INTO credit_transactions
           (tenant_id, customer_id, date, type, amount, description, sale_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.tenantId, data.customerId||data.customer_id||0,
         data.date||'', data.type||'sale',
         data.amount||0, data.description||data.desc||'',
         data.saleId||data.sale_id||0]
      );

      // H-03 FIX: If this is a payment, deduct from the customer balance
      if ((data.type||'').toLowerCase() === 'payment' && data.amount > 0) {
        const custId = data.customerId || data.customer_id;
        if (custId) {
          await client.query(
            `UPDATE credit_customers
             SET balance = GREATEST(0, COALESCE(balance,0) - $1),
                 last_payment = $2,
                 updated_at = NOW()
             WHERE id = $3 AND tenant_id = $4`,
            [data.amount, data.date||'', custId, req.tenantId]
          );
        }
      }

      await client.query('COMMIT');
      client.release();
      await auditLog(req, 'CREATE', 'creditTransactions', String(r.rows[0].id), data.type||'');
      res.json({ success: true, id: r.rows[0].id });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
      console.error('[creditTransactions POST]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Generic store POST (create) ───────────────────────────────────────────
  router.post('/:store', checkDayLock, async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    try {
      // FIX 35: idempotency check for sales — prevents duplicate records when
      // the admin client retries after a network drop. The idempotencyKey is
      // generated client-side (Fix 34) and stored in the idempotency_key column.
      if (req.params.store === 'sales') {
        const idemKey = req.body?.idempotencyKey || req.body?.idempotency_key || '';
        if (idemKey) {
          const existing = await pool.query(
            'SELECT id FROM sales WHERE tenant_id = $1 AND idempotency_key = $2',
            [req.tenantId, idemKey]
          );
          if (existing.rows[0]) {
            await auditLog(req, 'CREATE_DEDUP', 'sales', String(existing.rows[0].id), 'idempotent retry');
            return res.json({ success: true, id: existing.rows[0].id, duplicate: true });
          }
        }
      }
      const result = await upsertRow(meta, req.tenantId, req.body, true);
      await auditLog(req, 'CREATE', req.params.store, String(result.id||''), '');
      res.json({ success: true, id: result.id });
    } catch (e) {
      console.error('[POST /:store]', req.params.store, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Bulk PUT — MUST be before PUT /:store (Express matches /:store first otherwise) ──
  router.put('/:store/bulk', checkDayLock, async (req, res) => {
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
  router.put('/:store', checkDayLock, async (req, res) => {
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
  // H-01 FIX: requireRole('Owner') — previously ANY authenticated user could wipe all records.
  // Also added audit log so bulk deletes are always traceable.
  router.delete('/:store', requireRole('Owner'), async (req, res) => {
    const meta = STORE_MAP[req.params.store];
    if (!meta) return res.status(404).json({ error: 'Unknown store' });
    try {
      const result = await pool.query(`DELETE FROM ${meta.table} WHERE tenant_id = $1`, [req.tenantId]);
      await auditLog(req, 'DELETE_ALL', req.params.store, '', `${result.rowCount} rows deleted`);
      res.json({ success: true, deleted: result.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Generic store DELETE by id ────────────────────────────────────────────
  router.delete('/:store/:id', checkDayLock, async (req, res) => {
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
