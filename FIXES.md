# FuelBunk Pro — All Recommendations Fixed

## 🔴 Critical
- **C-01**: Replaced SHA-256 with bcrypt (cost=12) for all passwords & PINs. Legacy hashes auto-upgraded on first login.
- **C-02**: Default superadmin password now read from `SUPER_ADMIN_INIT_PASS` env var. If not set, random password printed once to logs.

## 🟠 High
- **H-01**: `DELETE /:store` (clear all records) now requires `Owner` role + writes audit log entry with row count.
- **H-02**: `/api/data/compare/summary` rewritten from N+1 (1000 queries for 200 bunks) to 5 aggregated GROUP BY queries.
- **H-03**: Credit payments now atomically deduct `credit_customers.balance` in same transaction as transaction record insert.

## 🟡 Medium
- **M-01**: Auth rate limiter reduced from 200→20 per 5 min. Added `pinVerifyLimiter` (15/5min) on `/api/public/verify-pin`.
- **M-02**: Idempotency key on sales endpoint — network retries return existing sale ID instead of creating duplicate.
- **M-03**: Periodic cleanup every 6 hours for `login_attempts` (24h), `audit_log` (90d), `sessions` (expired).
- **M-04**: Shift history cap raised from 30→180 entries (~6 months of daily shifts).

## 🟢 Low
- **L-01**: HTTPS redirect enforced in production via `x-forwarded-proto` header (Railway sets this automatically).
- **L-02**: Login response includes `loginIp` + `loginAt` so admins can detect unexpected access.
- **L-03**: `/api/health` now runs `SELECT 1` to verify actual DB connectivity (returns 503 if DB is down).
- **L-04**: `statement_timeout: 15000` added to pool config — runaway queries killed after 15 seconds.

## 🚀 Deploy Steps
1. Add env var in Railway: `SUPER_ADMIN_INIT_PASS=<your-secure-password>`
2. Push to GitHub — Railway auto-deploys
3. `npm install` will pull in the new `bcrypt` dependency
4. DB migrations (idempotency_key column + unique index) apply automatically on startup
