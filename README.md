# FuelBunk Pro — Deployment Guide

## Quick Start (Local Development)

```bash
npm install          # installs all deps including web-push
npm run setup        # downloads Chart.js for offline support, creates screenshots/
npm run dev          # server starts at http://localhost:3000
```

## First-Time Setup (Production)

### 1. Install dependencies
```bash
npm install
```

### 2. Download self-hosted assets
```bash
npm run setup
```
This downloads Chart.js 4.4.1 to `src/public/chart.min.js` so it works offline via Service Worker cache. Also creates `src/public/screenshots/` — add PWA screenshot PNGs there (see manifest.json section).

### 3. Generate VAPID keys (for background push notifications)
```bash
npm run generate-vapid
```
Copy the output into your `.env` / deployment environment variables:
```
VAPID_PUBLIC_KEY=BExamplePublicKey...
VAPID_PRIVATE_KEY=ExamplePrivateKey...
VAPID_MAILTO=mailto:admin@yourstation.com
```
Background push is optional — skip this if you only need local (in-app) alerts.

### 4. Deploy
```bash
npm start
```

---

## Railway Deployment (PostgreSQL — Recommended)

1. Push code to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Add a **PostgreSQL** service to your project
4. Railway auto-injects `DATABASE_URL` — no manual config needed
5. Set environment variables (see table below)
6. Set build command: `npm install && npm run setup`
7. Deploy — app is live at your `.up.railway.app` URL

> **Note:** No volume/disk needed — PostgreSQL handles all persistence. `chart.min.js` is downloaded at build time.

## Other Deployment Options

### Render
1. Push to GitHub → render.com → New Web Service
2. Build command: `npm install && npm run setup`
3. Start command: `npm start`
4. Add a **PostgreSQL** database service
5. Copy the `DATABASE_URL` from the DB service into your web service env vars

### Fly.io
```bash
fly launch
fly postgres create --name fuelbunk-db
fly postgres attach fuelbunk-db
fly deploy
```

### Docker (Any VPS)
```bash
docker build -t fuelbunk-pro .
docker run -d -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/dbname \
  -e VAPID_PUBLIC_KEY=BYourKey... \
  -e VAPID_PRIVATE_KEY=YourPrivKey... \
  -e VAPID_MAILTO=mailto:admin@yourstation.com \
  fuelbunk-pro
```

---

## Environment Variables

| Variable            | Default         | Required | Description                                      |
|---------------------|-----------------|----------|--------------------------------------------------|
| `DATABASE_URL`      | —               | ✅ Yes   | Full PostgreSQL connection URL                   |
| `PORT`              | 3000            | No       | Server port                                      |
| `CORS_ORIGIN`       | * (all)         | No       | Comma-separated allowed origins                  |
| `NODE_ENV`          | development     | No       | Set to `production` in prod                      |
| `VAPID_PUBLIC_KEY`  | —               | No       | VAPID public key for background push alerts      |
| `VAPID_PRIVATE_KEY` | —               | No       | VAPID private key for background push alerts     |
| `VAPID_MAILTO`      | —               | No       | Contact email for push service (e.g. mailto:...) |

> Generate VAPID keys with: `npm run generate-vapid`

---

## Default Credentials

| Role         | Username     | Password              |
|-------------|-------------|------------------------|
| Super Admin | superadmin  | FuelBunk@Super2026     |

> ⚠️ **Change these immediately after first login** via Super Admin → Change Credentials

---

## PWA Screenshots (manifest.json)

Add these files to `src/public/screenshots/` for the Android PWA install sheet:

| File                         | Dimensions | Purpose                   |
|------------------------------|-----------|---------------------------|
| `dashboard-mobile.png`       | 390×844px  | Mobile install screenshot |
| `dashboard-tablet.png`       | 1024×768px | Tablet install screenshot |

---

## File Structure

```
├── src/
│   ├── server.js          # Express entry point + push notification endpoints
│   ├── schema.js          # PostgreSQL schema + PgDbWrapper
│   ├── auth.js            # Authentication routes
│   ├── data.js            # Data CRUD routes + day-lock middleware
│   ├── security.js        # Auth middleware, brute-force, audit log
│   └── public/
│       ├── index.html     # Single-file frontend SPA shell
│       ├── app.js         # App init, online/offline, SW messaging
│       ├── admin.js       # Admin UI: dashboard, tanks, sales, settings
│       ├── employee.js    # Employee portal UI
│       ├── api-client.js  # REST adapter, offline queue, data snapshot
│       ├── bridge.js      # Frontend integration bridge
│       ├── utils.js       # Validators, formatters, threshold constants
│       ├── multitenant.js # Multi-tenant config
│       ├── sw.js          # Service Worker (v12): shell cache, push, offline
│       ├── manifest.json  # PWA manifest (icons, screenshots, shortcuts)
│       └── chart.min.js   # Chart.js 4.4.1 (generated by npm run setup)
├── scripts/
│   └── setup.js           # Downloads chart.min.js, creates screenshots/
├── package.json
├── Dockerfile
└── railway.json
```

---

## API Endpoints

### Auth
- `POST /api/auth/super-login` — Super admin login
- `POST /api/auth/login` — Station admin login
- `POST /api/auth/employee-login` — Employee PIN login
- `POST /api/auth/logout` — Destroy session
- `GET  /api/auth/session` — Check session validity
- `POST /api/auth/super-change-password` — Change super admin credentials
- `POST /api/auth/change-password` — Change admin password

### Push Notifications (requires auth)
- `GET  /api/push/vapid-public-key` — Fetch VAPID public key for subscription
- `POST /api/push/subscribe` — Save browser push subscription
- `POST /api/push/unsubscribe` — Remove push subscription

### Tenants (Super admin only)
- `GET    /api/tenants` — List all stations
- `POST   /api/tenants` — Create station
- `PUT    /api/tenants/:id` — Update station
- `DELETE /api/tenants/:id` — Delete station + all data
- `GET    /api/tenants/:id/admins` — List station admins
- `POST   /api/tenants/:id/admins` — Add admin user
- `DELETE /api/tenants/:tid/admins/:uid` — Remove admin user
- `POST   /api/tenants/:tid/admins/:uid/reset-password` — Reset admin password

### Data (requires auth, tenant-scoped)
- `GET    /api/data/:store` — Get all records
- `GET    /api/data/:store/:id` — Get by ID
- `GET    /api/data/:store/by-index/:col/:val` — Query by column value
- `POST   /api/data/:store` — Create record
- `PUT    /api/data/:store` — Upsert record
- `PUT    /api/data/:store/bulk` — Bulk upsert (day-lock checked per record)
- `DELETE /api/data/:store/:id` — Delete by ID
- `DELETE /api/data/:store` — Clear all (admin only)

### Day Lock (Owner role only)
- `GET  /api/data/day-lock/:date/status` — Check if date is locked
- `POST /api/data/day-lock/:date/close` — Lock a day's books
- `POST /api/data/day-lock/:date/open` — Unlock a day's books

### Stores
`sales`, `tanks`, `pumps`, `dipReadings`, `expenses`, `fuelPurchases`,
`creditCustomers`, `creditTransactions`, `employees`, `shifts`, `settings`, `auditLog`

### Health Check
- `GET /api/health` — Returns `{ status: "ok", database: "postgresql", uptime: N }`

---

## Changelog

### v1.2.0 (current)
- 🔴 **Critical:** Offline queue no longer silently drops failed mutations (max 3 retries with user feedback)
- 🔴 **Critical:** Background push notifications via VAPID — alerts fire when app is closed
- 🔴 **Critical:** Server-side credit limit hard block (HTTP 422) — previously only a client-side warning
- 🟠 **High:** Tank threshold constants unified across all 4 code locations (was 20%/25% inconsistency)
- 🟠 **High:** Negative fuel volume now blocked in tank edit modal (server + client)
- 🟠 **High:** 24h stale snapshot warning when device is offline for over a day
- 🟠 **High:** manifest.json screenshots fixed (`"/"` → real PNG paths); icon purposes split correctly
- 🟠 **High:** `checkDayLock` is now fail-closed (DB error blocks write instead of allowing it through)
- 🟠 **High:** Bulk upsert now checks day-lock per record (was only checking `body.date`)
- 🟡 **Medium:** Chart.js self-hosted (`npm run setup`) — works offline via SW shell cache
- 🟡 **Medium:** Print iframe Blob URL revokes on `afterprint` event (was 60s fixed timer)
- 🟡 **Medium:** `SYNC_REQUESTED` and `NOTIFICATION_NAVIGATE` SW messages now handled
- 🔵 **Low:** SW version string unified (`v12`) — was `v10` log vs `v11` cache name
- 🔵 **Low:** GSTR-3B CSV export Blob URL now properly revoked
- 🔵 **Low:** Helmet CSP updated: `blob:` + `cdnjs` added for Chart.js offline + print iframe
- 🔵 **Low:** Push subscribe/unsubscribe now creates audit log entries
- 🔵 **Low:** Push notification Settings UI shows live status (Active/Blocked/Enable) + Disable button
- 🔵 **Low:** Background render errors now logged to console instead of silently swallowed
