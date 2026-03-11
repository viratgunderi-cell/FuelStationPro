/**
 * FuelBunk Pro — API Client (Drop-in replacement for FuelDB)
 */

const API_BASE = '/api';
let _authToken = null;
let _tenantId = null;
let _logoutInProgress = false;

function setAuthToken(token)  { _authToken = token; }
function getAuthToken()       { return _authToken; }
function setTenantId(id)      { _tenantId = id; }
function getTenantId()        { return _tenantId; }
function clearAuth()          { _authToken = null; _tenantId = null; _logoutInProgress = false; }

async function apiFetch(path, options = {}) {
  const url = API_BASE + path;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (_authToken) headers['Authorization'] = 'Bearer ' + _authToken;

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    if (_authToken && !_logoutInProgress && typeof appLogout === 'function') {
      _logoutInProgress = true;
      _authToken = null;
      appLogout();
    }
    throw new Error('Session expired');
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    console.error('[API]', options.method || 'GET', path, '→', response.status, bodyText.slice(0, 200));
    let err;
    try { err = JSON.parse(bodyText); } catch { err = {}; }
    throw new Error(err.error || err.message || `Server error ${response.status} — check Railway logs`);
  }

  return response.json();
}

// ── Auth API ──────────────────────────────────────────────────────────────
const AuthAPI = {
  async superLogin(username, password) {
    const result = await apiFetch('/auth/super-login', {
      method: 'POST', body: JSON.stringify({ username, password })
    });
    if (result.token) setAuthToken(result.token);
    return result;
  },
  async adminLogin(username, password, tenantId) {
    const result = await apiFetch('/auth/login', {
      method: 'POST', body: JSON.stringify({ username, password, tenantId })
    });
    if (result.token) { setAuthToken(result.token); setTenantId(tenantId); }
    return result;
  },
  async employeeLogin(pin, tenantId) {
    const result = await apiFetch('/auth/employee-login', {
      method: 'POST', body: JSON.stringify({ pin, tenantId })
    });
    if (result.token) { setAuthToken(result.token); setTenantId(tenantId); }
    return result;
  },
  async logout() {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch {}
    clearAuth();
  },
  async checkSession() { return apiFetch('/auth/session'); },
  async changeSuperPassword(newUsername, newPassword, confirmPassword) {
    return apiFetch('/auth/super-change-password', {
      method: 'POST', body: JSON.stringify({ newUsername, newPassword, confirmPassword })
    });
  },
  async changePassword(newPassword) {
    return apiFetch('/auth/change-password', {
      method: 'POST', body: JSON.stringify({ newPassword })
    });
  }
};

// ── Tenant API ────────────────────────────────────────────────────────────
// Uses /data/tenants/ path — handled by explicit routes in server.js
const TenantAPI = {
  async list()           { return apiFetch('/data/tenants'); },
  async create(data)     { return apiFetch('/data/tenants', { method:'POST', body:JSON.stringify(data) }); },
  async update(id, data) { return apiFetch('/data/tenants/'+id, { method:'PUT', body:JSON.stringify(data) }); },
  async remove(id)       { return apiFetch('/data/tenants/'+id, { method:'DELETE' }); },
  async getAdmins(tid)   { return apiFetch('/data/tenants/'+tid+'/admins'); },
  async addAdmin(tid, d) { return apiFetch('/data/tenants/'+tid+'/admins', { method:'POST', body:JSON.stringify(d) }); },
  async removeAdmin(tid,uid) { return apiFetch('/data/tenants/'+tid+'/admins/'+uid, { method:'DELETE' }); },
  async resetAdminPassword(tid,uid,pw) {
    return apiFetch('/data/tenants/'+tid+'/admins/'+uid+'/reset-password', {
      method:'POST', body:JSON.stringify({ newPassword: pw })
    });
  }
};

// ── FuelDB — Drop-in REST replacement for IndexedDB FuelDB ───────────────
class FuelDB {
  constructor(dbName) {
    this.db = true;
    this.ready = Promise.resolve();
    this._dbName = dbName;
  }

  async getAll(storeName) {
    try { return await apiFetch('/data/' + storeName); }
    catch (e) { console.warn('[FuelDB] getAll', storeName, e.message); return []; }
  }

  async get(storeName, key) {
    try { return await apiFetch('/data/' + storeName + '/' + encodeURIComponent(key)); }
    catch { return undefined; }
  }

  async put(storeName, data) {
    const result = await apiFetch('/data/' + storeName, {
      method: 'PUT', body: JSON.stringify(data)
    });
    return result.id;
  }

  async add(storeName, data) {
    const result = await apiFetch('/data/' + storeName, {
      method: 'POST', body: JSON.stringify(data)
    });
    return result.id;
  }

  async delete(storeName, key) {
    await apiFetch('/data/' + storeName + '/' + encodeURIComponent(key), { method: 'DELETE' });
  }

  async clear(storeName) {
    await apiFetch('/data/' + storeName, { method: 'DELETE' });
  }

  async count(storeName) {
    const all = await this.getAll(storeName);
    return all.length;
  }

  async getByIndex(storeName, indexName, value) {
    try {
      return await apiFetch(
        '/data/' + storeName + '/by-index/' +
        encodeURIComponent(indexName) + '/' + encodeURIComponent(value)
      );
    } catch { return []; }
  }

  async bulkPut(storeName, items) {
    await apiFetch('/data/' + storeName + '/bulk', {
      method: 'PUT', body: JSON.stringify(items)
    });
  }

  // Settings use /data/settings/key/:key — specific route in data.js
  async getSetting(key, defaultVal = null) {
    try {
      const row = await apiFetch('/data/settings/key/' + encodeURIComponent(key));
      if (!row || row.value === undefined || row.value === null) return defaultVal;
      return row.value;
    } catch {
      return defaultVal;
    }
  }

  async setSetting(key, value) {
    try {
      await apiFetch('/data/settings/key/' + encodeURIComponent(key), {
        method: 'PUT', body: JSON.stringify({ value })
      });
    } catch (e) {
      console.warn('[FuelDB] setSetting failed:', key, e.message);
    }
  }
}

// ── Globals ───────────────────────────────────────────────────────────────
const _origMtGetTenants = typeof mt_getTenants === 'function' ? mt_getTenants : null;
window.mt_getTenants_api = async function() {
  try { return await TenantAPI.list(); }
  catch { return _origMtGetTenants ? _origMtGetTenants() : []; }
};

async function checkServerHealth() {
  try { const r = await apiFetch('/health'); return r.status === 'ok'; }
  catch { return false; }
}

window.AuthAPI = AuthAPI;
window.TenantAPI = TenantAPI;
window.FuelDB = FuelDB;
window.apiFetch = apiFetch;
window.setAuthToken = setAuthToken;
window.getAuthToken = getAuthToken;
window.setTenantId = setTenantId;
window.clearAuth = clearAuth;
window.checkServerHealth = checkServerHealth;

console.log('[FuelDB] API adapter loaded — REST mode');
