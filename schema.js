/**
 * FuelBunk Pro — PostgreSQL Database Schema & Init
 *
 * BUGS FIXED:
 *  1. Duplicate/dead PgDB class removed (only PgDbWrapper is used)
 *  2. RETURNING * on INSERT INTO sessions → crash (token is TEXT PK, not SERIAL)
 *     Fixed: sessions INSERT uses RETURNING token
 *  3. RETURNING * appended to UPDATE/DELETE statements — wrong, removed
 *  4. No connection pool limits → Railway free tier pool exhaustion
 *  5. No pool error handler → uncaught errors crash process
 *  6. No indexes on hot query paths (sessions, sales, login_attempts)
 *  7. Session/login_attempts tables grow unbounded → added startup cleanup
 */
const { Pool } = require('pg');
const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!dbUrl && !process.env.PGHOST) {
  console.error('[WARN] No DATABASE_URL found — server will start but DB operations will fail.');
  console.error('[WARN] Set DATABASE_URL in Railway Variables tab to connect to PostgreSQL.');
  // Don't exit — let server start so health check passes and Railway can show the app
}

let poolConfig;
if (dbUrl) {
  console.log('[DB] Using DATABASE_URL:', dbUrl.replace(/:([^:@]+)@/, ':****@'));
  const isInternal = dbUrl.includes('railway.internal') ||
                     dbUrl.includes('localhost') ||
                     dbUrl.includes('127.0.0.1');
  poolConfig = {
    connectionString: dbUrl,
    ssl: isInternal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
} else {
  console.log('[DB] Using PG* env vars, host:', process.env.PGHOST);
  poolConfig = {
    host: process.env.PGHOST,
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

const pool = new Pool(poolConfig);
pool.on('error', (err) => {
  console.error('[PG Pool] Unexpected error on idle client:', err.message);
});

// ─────────────────────────────────────────────────────────────
// SQL CONVERTER: SQLite syntax → PostgreSQL
// ─────────────────────────────────────────────────────────────
function convertSql(sql, mode) {
  let i = 0;
  sql = sql.replace(/\?/g, () => `$${++i}`);
  sql = sql.replace(/datetime\('now'\)/gi, 'NOW()');
  sql = sql.replace(/datetime\("now"\)/gi, 'NOW()');
  sql = sql.replace(/INSERT OR REPLACE INTO (\w+)/gi, 'INSERT INTO $1');
  sql = sql.replace(/INSERT OR IGNORE INTO (\w+)/gi, 'INSERT INTO $1');

  // BUG FIX: Only add RETURNING for INSERT statements in 'run' mode.
  // sessions table has TEXT primary key (token) — return token not id.
  if (mode === 'run' &&
      /^\s*INSERT\b/i.test(sql) &&
      !sql.includes('RETURNING')) {
    if (/INTO\s+sessions\b/i.test(sql)) {
      sql = sql + ' RETURNING token';
    } else {
      sql = sql + ' RETURNING id';
    }
  }
  return sql;
}

// ─────────────────────────────────────────────────────────────
// PgDbWrapper — thin async wrapper matching better-sqlite3 API
// ─────────────────────────────────────────────────────────────
class PgDbWrapper {
  constructor(pool) {
    this.pool = pool;
  }

  prepare(sql) {
    const self = this;
    return {
      async run(...params) {
        const pgSql = convertSql(sql, 'run');
        try {
          const result = await self.pool.query(pgSql, params);
          const firstRow = result.rows[0];
          const lastId = firstRow
            ? (firstRow.id ?? firstRow.token ?? Object.values(firstRow)[0] ?? 0)
            : 0;
          return { lastInsertRowid: lastId, changes: result.rowCount };
        } catch (e) {
          console.error('[DB run]', e.message, '\nSQL:', pgSql, '\nParams:', params);
          throw e;
        }
      },
      async get(...params) {
        const pgSql = convertSql(sql, 'get');
        try {
          const result = await self.pool.query(pgSql, params);
          return result.rows[0] || undefined;
        } catch (e) {
          console.error('[DB get]', e.message, '\nSQL:', pgSql, '\nParams:', params);
          return undefined;
        }
      },
      async all(...params) {
        const pgSql = convertSql(sql, 'all');
        try {
          const result = await self.pool.query(pgSql, params);
          return result.rows;
        } catch (e) {
          console.error('[DB all]', e.message, '\nSQL:', pgSql, '\nParams:', params);
          return [];
        }
      }
    };
  }

  async exec(sql) {
    try { await this.pool.query(convertSql(sql, 'exec')); }
    catch (e) { console.warn('[DB exec]', e.message); }
  }

  pragma() {} // no-op

  transaction(fn) {
    // BUG-05 FIX: fn() must receive the transactional client, not use pool directly.
    // Original code called fn(...args) without passing client, so fn's pool.query()
    // calls bypassed the transaction entirely — no atomicity.
    const pool = this.pool;
    return async (...args) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client, ...args);  // Pass client as first arg
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    };
  }

  async getTableColumns(table) {
    const result = await this.pool.query(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_name = $1`,
      [table]
    );
    return result.rows.map(r => r.name);
  }
}

// ─────────────────────────────────────────────────────────────
// INIT DATABASE
// ─────────────────────────────────────────────────────────────
async function initDatabase() {
  console.log('[DB] Connecting to PostgreSQL...');
  try { await pool.query('SELECT 1'); console.log('[DB] Connection OK'); }
  catch (e) { console.error('[DB] Connection failed:', e.message); throw e; }

  const TABLES = [
    `CREATE TABLE IF NOT EXISTS super_admin (
      id INTEGER PRIMARY KEY CHECK(id=1),
      username TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT DEFAULT '',
      owner_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      icon TEXT DEFAULT '⛽',
      color TEXT DEFAULT '#d4940f',
      color_light TEXT DEFAULT '#f0b429',
      station_code TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      username TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      role TEXT DEFAULT 'Manager',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, username)
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      tenant_id TEXT DEFAULT '',
      user_id INTEGER DEFAULT 0,
      user_type TEXT NOT NULL,
      user_name TEXT DEFAULT '',
      role TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      ip_address TEXT DEFAULT '',
      user_agent TEXT DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS tanks (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      fuel_type TEXT DEFAULT '',
      name TEXT DEFAULT '',
      capacity REAL DEFAULT 0,
      current_level REAL DEFAULT 0,
      low_alert REAL DEFAULT 500,
      last_dip TEXT DEFAULT '',
      unit TEXT DEFAULT 'L',
      data_json TEXT DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(id, tenant_id)
    )`,
    `CREATE TABLE IF NOT EXISTS pumps (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      fuel_type TEXT DEFAULT '',
      tank_id TEXT DEFAULT '',
      current_reading REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      data_json TEXT DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(id, tenant_id)
    )`,
    `CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      fuel_type TEXT DEFAULT '',
      liters REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      mode TEXT DEFAULT 'cash',
      pump TEXT DEFAULT '',
      nozzle TEXT DEFAULT '',
      shift TEXT DEFAULT '',
      vehicle TEXT DEFAULT '',
      customer TEXT DEFAULT '',
      employee_id INTEGER DEFAULT 0,
      employee_name TEXT DEFAULT '',
      upi_txn_id TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS dip_readings (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      tank_id TEXT DEFAULT '',
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      reading REAL DEFAULT 0,
      computed_volume REAL DEFAULT 0,
      method TEXT DEFAULT '',
      shift TEXT DEFAULT '',
      recorded_by TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      date TEXT DEFAULT '',
      category TEXT DEFAULT 'General',
      description TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      paid_to TEXT DEFAULT '',
      mode TEXT DEFAULT 'cash',
      receipt_ref TEXT DEFAULT '',
      approved_by TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS fuel_purchases (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      date TEXT DEFAULT '',
      fuel_type TEXT DEFAULT '',
      liters REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      tank_id TEXT DEFAULT '',
      supplier TEXT DEFAULT '',
      invoice_no TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS credit_customers (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      vehicle TEXT DEFAULT '',
      company TEXT DEFAULT '',
      type TEXT DEFAULT 'individual',
      credit_limit REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      last_payment TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS credit_transactions (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      customer_id INTEGER DEFAULT 0,
      date TEXT DEFAULT '',
      type TEXT DEFAULT 'sale',
      amount REAL DEFAULT 0,
      description TEXT DEFAULT '',
      sale_id INTEGER DEFAULT 0,
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      role TEXT DEFAULT 'attendant',
      shift TEXT DEFAULT '',
      pin_hash TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      salary REAL DEFAULT 0,
      join_date TEXT DEFAULT '',
      color TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS shifts (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      start_time TEXT DEFAULT '',
      end_time TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      data_json TEXT DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(id, tenant_id)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(key, tenant_id)
    )`,
    // BUG-10 FIX: Lubes & Products tables — previously stored as JSON blobs in settings
    // which can grow > 5MB. Proper tables prevent settings row bloat.
    // Frontend still uses setSetting/getSetting as primary path (backward-compatible).
    `CREATE TABLE IF NOT EXISTS lubes_products (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      brand TEXT DEFAULT '',
      category TEXT DEFAULT '',
      hsn TEXT DEFAULT '',
      gst_pct REAL DEFAULT 18,
      unit TEXT DEFAULT 'L',
      selling_price REAL DEFAULT 0,
      cost_price REAL DEFAULT 0,
      stock REAL DEFAULT 0,
      min_stock REAL DEFAULT 5,
      expiry_date TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      data_json TEXT DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(id, tenant_id)
    )`,
    `CREATE TABLE IF NOT EXISTS lubes_sales (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      product_id TEXT DEFAULT '',
      product_name TEXT DEFAULT '',
      qty REAL DEFAULT 0,
      unit TEXT DEFAULT '',
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      customer TEXT DEFAULT '',
      mode TEXT DEFAULT 'cash',
      employee TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_lubes_sales_tenant ON lubes_sales(tenant_id, date DESC)`,

    `CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT DEFAULT '',
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      user_name TEXT DEFAULT '',
      user_type TEXT DEFAULT '',
      action TEXT DEFAULT '',
      entity TEXT DEFAULT '',
      entity_id TEXT DEFAULT '',
      details TEXT DEFAULT '',
      ip_address TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS login_attempts (
      id SERIAL PRIMARY KEY,
      ip_address TEXT DEFAULT '',
      username TEXT DEFAULT '',
      tenant_id TEXT DEFAULT '',
      success INTEGER DEFAULT 0,
      attempted_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Performance indexes
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_tenant_date ON sales(tenant_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address, attempted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_credit_tx_customer ON credit_transactions(customer_id, tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_employees_tenant ON employees(tenant_id, active)`,
  ];

  for (const stmt of TABLES) {
    try { await pool.query(stmt); }
    catch (e) { console.warn('[Schema]', e.message.substring(0, 120)); }
  }

  // Seed super admin
  const existing = await pool.query('SELECT id FROM super_admin WHERE id = 1');
  if (existing.rows.length === 0) {
    await pool.query(
      'INSERT INTO super_admin (id, username, pass_hash) VALUES ($1, $2, $3)',
      [1, 'superadmin', hashPassword('FuelBunk@Super2026')]
    );
    console.log('[DB] Super admin seeded — CHANGE PASSWORD IMMEDIATELY');
  }

  // ── Add columns that may be missing from existing deployments ──────────────
  // These ALTER TABLE statements are safe — IF NOT EXISTS means no error if already present
  const MIGRATIONS = [
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS time TEXT DEFAULT ''`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS upi_txn_id TEXT DEFAULT ''`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS nozzle TEXT DEFAULT ''`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS employee_name TEXT DEFAULT ''`,
    `ALTER TABLE credit_customers ADD COLUMN IF NOT EXISTS balance REAL DEFAULT 0`,
    `ALTER TABLE credit_customers ADD COLUMN IF NOT EXISTS credit_limit REAL DEFAULT 0`,
    `ALTER TABLE credit_customers ADD COLUMN IF NOT EXISTS last_payment TEXT DEFAULT ''`,
    `ALTER TABLE credit_customers ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'individual'`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS color TEXT DEFAULT ''`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift TEXT DEFAULT ''`,
    `ALTER TABLE pumps ADD COLUMN IF NOT EXISTS open_reading REAL DEFAULT 0`,
    `ALTER TABLE pumps ADD COLUMN IF NOT EXISTS nozzle_readings TEXT DEFAULT '{}'`,
    `ALTER TABLE pumps ADD COLUMN IF NOT EXISTS nozzle_open TEXT DEFAULT '{}'`,
    `ALTER TABLE pumps ADD COLUMN IF NOT EXISTS nozzle_fuels TEXT DEFAULT '{}'`,
    `ALTER TABLE pumps ADD COLUMN IF NOT EXISTS nozzle_labels TEXT DEFAULT '{}'`,
    `ALTER TABLE pumps ADD COLUMN IF NOT EXISTS nozzles INTEGER DEFAULT 2`,
    // New migrations for field mapping fixes
    `ALTER TABLE tanks ADD COLUMN IF NOT EXISTS last_dip TEXT DEFAULT ''`,
    `ALTER TABLE dip_readings ADD COLUMN IF NOT EXISTS time TEXT DEFAULT ''`,
    `ALTER TABLE dip_readings ADD COLUMN IF NOT EXISTS method TEXT DEFAULT ''`,
    // FA-04: track who last updated tank level (admin dip vs shift close)
    `ALTER TABLE tanks ADD COLUMN IF NOT EXISTS last_dip_source TEXT DEFAULT 'shift_close'`,
    // FA-03: store timestamp when nozzle readings last updated (carry-forward info for employees)
    `ALTER TABLE pumps ADD COLUMN IF NOT EXISTS reading_updated_at TEXT DEFAULT ''`,
  ];
  for (const migration of MIGRATIONS) {
    try { await pool.query(migration); }
    catch (e) { console.warn('[Migration]', e.message.substring(0, 80)); }
  }
  console.log('[DB] Migrations applied');

  // Cleanup on startup
  try {
    const r = await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
    if (r.rowCount > 0) console.log(`[DB] Cleaned ${r.rowCount} expired sessions`);
  } catch {}
  try {
    await pool.query("DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL '24 hours'");
  } catch {}

  console.log('[DB] PostgreSQL ready');
  return new PgDbWrapper(pool);
}

module.exports = { initDatabase, hashPassword, pool };
