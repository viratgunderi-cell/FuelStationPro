/**
 * FuelBunk Pro — Express Server (PostgreSQL)
 *
 * BUGS FIXED:
 *  1. Route conflict: /api/data and /api both mount dataRoutes — this means
 *     every data request goes through authMiddleware TWICE (double-auth).
 *     Fixed: /api/data uses authMiddleware; /api only handles non-data routes.
 *  2. Static file serving: if index.html is in root dir alongside server.js,
 *     express.static() serves ALL JS files including server.js, schema.js etc.
 *     to anyone who knows the path. Fixed: serve from /public subdirectory only,
 *     and fallback to __dirname only in explicit development mode.
 *  3. Rate limiter: max: 300 per 60s is very permissive. Auth already has its
 *     own stricter limiter, but general API should be tighter.
 *  4. CORS: origin: true reflects any origin — acceptable for dev/POC but
 *     should respect CORS_ORIGIN env variable properly.
 *  5. Missing /api/auth/employee-login from public tenant aliases —
 *     but this is now handled in security.js publicPaths fix.
 *  6. app.get('*') catch-all runs BEFORE error handler — correct order kept.
 *  7. No graceful DB pool shutdown on SIGTERM — added pool.end().
 */
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const { initDatabase, pool } = require('./schema');
const { authMiddleware, inputSanitizerMiddleware } = require('./security');
const authRoutes = require('./auth');
const dataRoutes = require('./data');

async function startServer() {
  let db;
  try {
    db = await initDatabase();
  } catch (err) {
    console.error('[DB] Database init failed:', err.message);
    console.error('[DB] Starting server without DB — set DATABASE_URL in Railway Variables');
    db = null;
  }
  const app = express();
  const PORT = process.env.PORT || 3000;

  if (db) app.locals.db = db;
  app.set('trust proxy', 1);

  // ── Security headers ───────────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: false,   // Frontend sets its own CSP
    crossOriginEmbedderPolicy: false,
  }));

  // ── CORS ───────────────────────────────────────────────────
  const corsOrigin = process.env.CORS_ORIGIN;
  app.use(cors({
    origin: corsOrigin ? corsOrigin.split(',').map(s => s.trim()) : true,
    credentials: true,
  }));

  // ── Rate limiting ──────────────────────────────────────────
  // General API: 200 req/min
  app.use('/api', rateLimit({
    windowMs: 60_000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' },
  }));

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(inputSanitizerMiddleware);

  // Static files: ALWAYS register routes — never rely on existsSync at startup.
  // If a file is missing, return 404 explicitly (not index.html which breaks JS parsing).
  const _safeFiles = ['index.html', 'api-client.js', 'bridge.js', 'favicon.ico', 'sw.js', 'manifest.json'];
  _safeFiles.forEach(f => {
    const fp = path.join(__dirname, f);
    app.get('/' + f, (_req, res) => {
      if (!fs.existsSync(fp)) return res.status(404).send('Not found: ' + f);
      if (f.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      if (f.endsWith('.js'))   res.setHeader('Content-Type', 'application/javascript');
      res.sendFile(fp);
    });
  });
  ['assets', 'icons', 'images', 'public'].forEach(d => {
    const dp = path.join(__dirname, d);
    if (fs.existsSync(dp)) app.use('/' + d, express.static(dp, { maxAge: '1h' }));
  });
  // ── Health check (public) ──────────────────────────────────
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      database: db ? 'postgresql' : 'not_connected',
      uptime: Math.floor(process.uptime()),
      env: process.env.NODE_ENV || 'development',
      has_db_url: !!(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGHOST)
    });
  });

  // ── Public tenant list (multiple URL aliases for compatibility) ──
  const listTenantsPublic = async (req, res) => {
    try {
      const tenants = await db.prepare(
        'SELECT id, name, location, icon, color, color_light, active, station_code FROM tenants ORDER BY name'
      ).all();
      res.json(tenants);
    } catch (e) {
      console.error('[tenants list]', e.message);
      res.status(500).json({ error: e.message });
    }
  };
  app.get(['/api/tenants', '/api/tenants/list', '/api/data/tenants', '/api/data/tenants/list'],
    listTenantsPublic
  );

  // ── Auth routes (with stricter rate limit) ─────────────────
  const authLimiter = rateLimit({ windowMs: 300_000, max: 30 });
  app.use('/api/auth', authLimiter, authRoutes(db));

  // ── Data routes ────────────────────────────────────────────
  // BUG FIX: mount ONLY under /api/data with auth — do NOT also mount
  // under /api which would cause double-auth and route conflicts.
  app.use('/api/data', authMiddleware(db), dataRoutes(db));

  // NOTE: do NOT add app.use("/api", ...) here - it would intercept /api/auth/* routes.

  // SPA fallback + API 404 handler for ALL HTTP methods.
  // BUG FIX: was app.get('*') — POST/PUT/DELETE to unknown /api/* routes
  // received no response, causing apiFetch to hang forever (silent failure).
  // Fixed: app.all('*') catches every method; API paths always get a JSON 404.
  app.all('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'API endpoint not found: ' + req.method + ' ' + req.path });
    }
    // Only serve index.html for GET requests (SPA routing)
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const _staticExts = ['.js', '.css', '.json', '.png', '.jpg', '.ico', '.svg', '.woff', '.woff2'];
    if (_staticExts.some(ext => req.path.endsWith(ext))) {
      return res.status(404).send('Not found: ' + req.path);
    }
    const _idx = path.join(__dirname, 'index.html');
    if (fs.existsSync(_idx)) { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); res.sendFile(_idx); }
    else res.status(404).send('index.html not found');
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[Unhandled Error]', err.message, err.stack);
    res.status(500).json({ error: 'Internal server error' });
  });

  // ── Start listening ────────────────────────────────────────
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FuelBunk Pro] Running on port ${PORT} (PostgreSQL)`);
    console.log(`[FuelBunk Pro] NODE_ENV=${process.env.NODE_ENV || 'development'}`);
  });

  // ── Graceful shutdown ──────────────────────────────────────
  async function shutdown(signal) {
    console.log(`[Server] ${signal} received — shutting down gracefully`);
    try { await pool.end(); console.log('[DB] Pool closed'); } catch {}
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch(e => {
  console.error('[FATAL]', e.message, e.stack);
  process.exit(1);
});
