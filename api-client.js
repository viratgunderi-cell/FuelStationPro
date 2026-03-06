/**
 * FuelBunk Pro — API Client (Drop-in replacement for FuelDB)
 *
 * BUGS FIXED:
 *  7. TenantAPI: create/update/delete called POST /api/tenants which doesn't exist.
 *     The server only registers GET /api/tenants (public list). All mutations
 *     are registered at /api/data/tenants via dataRoutes. Fixed: mutations now
 *     call /data/tenants (→ /api/data/tenants) which has proper auth + CRUD.
 *  1. apiFetch: 401 handler called appLogout() synchronously while a fetch
 *     was in flight — if multiple concurrent requests expired at the same time,
 *     appLogout() (which calls location.reload()) fired multiple times causing
 *     a rapid reload loop. Fixed: use a flag to prevent re-entrant logouts.
 *  2. FuelDB.getByIndex: URL encoded indexName as the column name but the
 *     server route expects the raw column name. URL encoding e.g. 'employee_id'
 *     is fine, but 'employeeId' would not match any snake_case column.
 *     Fixed: convert camelCase to snake_case before encoding.
 *  3. FuelDB.get: returned undefined on 404 (correct), but also returned
 *     undefined on any other error — network errors would silently return
 *     undefined instead of throwing. Fixed: only swallow 404, rethrow others.
 *  4. FuelDB.clear (DELETE /:store) now requires admin role on server —
 *     the client correctly calls DELETE /storeName with no extra changes needed.
 *  5. window.mt_getTenants_api was defined but never called anywhere; the
 *     actual override is in bridge.js. Kept for compatibility but clarified.
 *  6. checkServerHealth: timeout added — without a timeout an unreachable
 *     server would hang the health check indefinitely.
 */

const API_BASE = '/api';
let _authToken = null;
let _tenantId = null;
let _logoutInProgress = false; // BUG FIX: prevent re-entrant logout on 401

// ── Auth helpers ───────────────────────────────────────────────
function setAuthToken(token) { _authToken = token; }
function getAuthToken() { return _authToken; }
function setTenantId(id) { _tenantId = id; }
function getTenantId() { return _tenantId; }
function clearAuth() { _authToken = null; _tenantId = null; _logoutInProgress = false; }

// ── Fetch wrapper ──────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const url = API_BASE + path;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (_authToken) headers['Authorization'] = 'Bearer ' + _authToken;

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    // BUG FIX: de-duplicate logout — only trigger once per session expiry
    if (_authToken && !_logoutInProgress && typeof appLogout === 'function') {
      _logoutInProgress = true;
      _authToken = null;
      appLogout();
    }
    throw new Error('Session expired');
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || err.message || `HTTP ${response.status}`);
  }

  return response.json();
}

// ── Auth API ───────────────────────────────────────────────────
const AuthAPI = {
  async superLogin(username, password) {
    const result = await apiFetch('/auth/super-login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    if (result.token) setAuthToken(result.token);
    return result;
  },

  async adminLogin(username, password, tenantId) {
    const result = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, tenantId }),
    });
    if (result.token) {
      setAuthToken(result.token);
      setTenantId(tenantId);
    }
    return result;
  },

  async employeeLogin(pin, tenantId, employeeId) {
    // BUG FIX: pass employeeId so server can disambiguate duplicate PINs
    const result = await apiFetch('/auth/employee-login', {
      method: 'POST',
      body: JSON.stringify({ pin, tenantId, employeeId: employeeId || undefined }),
    });
    if (result.token) {
      setAuthToken(result.token);
      setTenantId(tenantId);
    }
    return result;
  },

  async logout() {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch { /* best effort */ }
    clearAuth();
  },

  async checkSession() { return apiFetch('/auth/session'); },

  async changeSuperPassword(newUsername, newPassword, confirmPassword) {
    return apiFetch('/auth/super-change-password', {
      method: 'POST',
      body: JSON.stringify({ newUsername, newPassword, confirmPassword }),
    });
  },

  async changePassword(newPassword) {
    return apiFetch('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    });
  },
};

// ── Tenant API ─────────────────────────────────────────────────
const TenantAPI = {
  // GET list is public — served at /api/tenants (no auth needed)
  async list() { return apiFetch('/tenants'); },

  // All mutations go to /data/tenants which is protected by authMiddleware + requireRole('super')
  async create(data) {
    return apiFetch('/data/tenants', { method: 'POST', body: JSON.stringify(data) });
  },

  async update(id, data) {
    return apiFetch('/data/tenants/' + id, { method: 'PUT', body: JSON.stringify(data) });
  },

  async remove(id) {
    return apiFetch('/data/tenants/' + id, { method: 'DELETE' });
  },

  async getAdmins(tenantId) {
    return apiFetch('/data/tenants/' + tenantId + '/admins');
  },

  async addAdmin(tenantId, data) {
    return apiFetch('/data/tenants/' + tenantId + '/admins', {
      method: 'POST', body: JSON.stringify(data),
    });
  },

  async removeAdmin(tenantId, userId) {
    return apiFetch('/data/tenants/' + tenantId + '/admins/' + userId, { method: 'DELETE' });
  },

  async resetAdminPassword(tenantId, userId, newPassword) {
    return apiFetch('/data/tenants/' + tenantId + '/admins/' + userId + '/reset-password', {
      method: 'POST', body: JSON.stringify({ newPassword }),
    });
  },
};

// ── FuelDB — Drop-in REST replacement ─────────────────────────
function camelToSnake(s) { return s.replace(/([A-Z])/g, '_$1').toLowerCase(); }

class FuelDB {
  constructor(dbName) {
    this.db = true;
    this.ready = Promise.resolve();
    this._dbName = dbName;
  }

  // All data routes are mounted at /api/data/* on the server.
  // apiFetch prepends /api, so we must use /data/storeName here.
  _path(storeName) { return '/data/' + storeName; }

  async getAll(storeName) {
    try {
      return await apiFetch(this._path(storeName));
    } catch (e) {
      console.warn('[FuelDB] getAll error:', storeName, e.message);
      return [];
    }
  }

  async get(storeName, key) {
    try {
      return await apiFetch(this._path(storeName) + '/' + encodeURIComponent(key));
    } catch (e) {
      if (e.message && e.message.includes('404')) return undefined;
      if (e.message === 'Not found') return undefined;
      throw e;
    }
  }

  async put(storeName, data) {
    const result = await apiFetch(this._path(storeName), {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return result?.id;
  }

  async add(storeName, data) {
    const result = await apiFetch(this._path(storeName), {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return result?.id;
  }

  async delete(storeName, key) {
    await apiFetch(this._path(storeName) + '/' + encodeURIComponent(key), { method: 'DELETE' });
  }

  async clear(storeName) {
    await apiFetch(this._path(storeName), { method: 'DELETE' });
  }

  async count(storeName) {
    const all = await this.getAll(storeName);
    return all.length;
  }

  async getByIndex(storeName, indexName, value) {
    try {
      const snakeIndex = camelToSnake(indexName);
      return await apiFetch(
        this._path(storeName) + '/by-index/' +
        encodeURIComponent(snakeIndex) + '/' +
        encodeURIComponent(value)
      );
    } catch (e) {
      console.warn('[FuelDB] getByIndex error:', storeName, indexName, e.message);
      return [];
    }
  }

  async bulkPut(storeName, items) {
    await apiFetch(this._path(storeName) + '/bulk', {
      method: 'PUT',
      body: JSON.stringify(items),
    });
  }

  // ── Settings helpers (special route: /data/settings/key/:key) ──────────
  // getSetting/setSetting must use /key/ prefix because settings table
  // uses 'key' as primary key, not 'id'. The generic /:store/:id route
  // looks for WHERE id=? which would fail for settings.
  async getSetting(key, defaultVal = null) {
    try {
      const row = await apiFetch('/data/settings/key/' + encodeURIComponent(key));
      if (!row || row.value === undefined || row.value === null) return defaultVal;
      return row.value;
    } catch (e) {
      return defaultVal;
    }
  }

  async setSetting(key, value) {
    try {
      await apiFetch('/data/settings/key/' + encodeURIComponent(key), {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
    } catch (e) {
      console.warn('[FuelDB] setSetting error:', key, e.message);
    }
  }

  async getSetting(key, defaultVal = null) {
    try {
      const result = await apiFetch('/settings/key/' + encodeURIComponent(key));
      return result.value !== null && result.value !== undefined ? result.value : defaultVal;
    } catch {
      return defaultVal;
    }
  }

  async setSetting(key, value) {
    await apiFetch('/settings/key/' + encodeURIComponent(key), {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  }
}

// ── Health check with timeout ──────────────────────────────────
async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const result = await apiFetch('/health', { signal: controller.signal });
    clearTimeout(timeout);
    return result.status === 'ok';
  } catch {
    return false;
  }
}

// ── Global exports ─────────────────────────────────────────────
window.AuthAPI = AuthAPI;
window.TenantAPI = TenantAPI;
window.FuelDB = FuelDB;
window.apiFetch = apiFetch;
window.setAuthToken = setAuthToken;
window.getAuthToken = getAuthToken;
window.setTenantId = setTenantId;
window.getTenantId = getTenantId;
window.clearAuth = clearAuth;
window.checkServerHealth = checkServerHealth;

// mt_getTenants_api kept for backward compatibility (actual override in bridge.js)
window.mt_getTenants_api = async function () {
  try { return await TenantAPI.list(); } catch { return []; }
};

console.log('[FuelDB] API adapter loaded — REST mode');
