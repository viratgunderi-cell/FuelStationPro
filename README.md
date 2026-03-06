# FuelBunk Pro — Deployment Guide

## Quick Start (Local Development)

```bash
npm install
npm run dev
# Server starts at http://localhost:3000
```

## Railway Deployment (PostgreSQL — Recommended)

1. Push code to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Add a **PostgreSQL** service to your project
4. Railway auto-injects `DATABASE_URL` — no manual config needed
5. Set environment variables (see table below)
6. Deploy — app is live at your `.up.railway.app` URL

> **Note:** No volume/disk needed — PostgreSQL handles all persistence.

## Other Deployment Options

### Render
1. Push to GitHub → render.com → New Web Service
2. Build command: `npm install`
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
  fuelbunk-pro
```

## Environment Variables

| Variable       | Default        | Description                              |
|---------------|----------------|------------------------------------------|
| `DATABASE_URL` | —              | **Required.** Full PostgreSQL URL        |
| `PORT`         | 3000           | Server port                              |
| `CORS_ORIGIN`  | * (all)        | Comma-separated allowed origins          |
| `NODE_ENV`     | development    | Set to `production` in prod              |

## Default Credentials

| Role         | Username     | Password              |
|-------------|-------------|------------------------|
| Super Admin | superadmin  | FuelBunk@Super2026     |

> ⚠️ **Change these immediately after first login** via Super Admin → Change Credentials

## File Structure

```
├── server.js          # Express entry point
├── schema.js          # PostgreSQL schema + PgDbWrapper
├── auth.js            # Authentication routes
├── data.js            # Data CRUD routes
├── security.js        # Auth middleware, brute-force, audit log
├── api-client.js      # Frontend REST adapter (replaces IndexedDB FuelDB)
├── bridge.js          # Frontend integration bridge (overrides localStorage functions)
├── index.html         # Single-file frontend SPA
├── package.json
├── Dockerfile
└── railway.json
```

## API Endpoints

### Auth
- `POST /api/auth/super-login` — Super admin login
- `POST /api/auth/login` — Station admin login
- `POST /api/auth/employee-login` — Employee PIN login
- `POST /api/auth/logout` — Destroy session
- `GET  /api/auth/session` — Check session validity
- `POST /api/auth/super-change-password` — Change super admin credentials
- `POST /api/auth/change-password` — Change admin password

### Tenants (Super admin only)
- `GET    /api/tenants` — List all stations (public)
- `POST   /api/tenants` — Create station
- `PUT    /api/tenants/:id` — Update station
- `DELETE /api/tenants/:id` — Delete station
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
- `PUT    /api/data/:store/bulk` — Bulk upsert
- `DELETE /api/data/:store/:id` — Delete by ID
- `DELETE /api/data/:store` — Clear all (admin only)

### Settings
- `GET /api/data/settings/key/:key` — Get setting
- `PUT /api/data/settings/key/:key` — Set setting

### Stores
`sales`, `tanks`, `pumps`, `dipReadings`, `expenses`, `fuelPurchases`,
`creditCustomers`, `creditTransactions`, `employees`, `shifts`, `settings`, `auditLog`

## Health Check
- `GET /api/health` — Returns `{ status: "ok", database: "postgresql", uptime: N }`
