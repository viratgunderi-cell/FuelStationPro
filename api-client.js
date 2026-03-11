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
    // Friendly messages for common HTTP errors
    if (response.status === 429) throw new Error(err.error || 'Too many requests — please wait a few minutes and try again');
    if (response.status === 503 || response.status === 502) throw new Error('Server is starting up — please wait 10 seconds and retry');
    if (response.status === 404) throw new Error(err.error || 'Not found');
    throw new Error(err.error || err.message || `Server error ${response.status}`);
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

// ═══════════════════════════════════════════════════════════════════════════════
// ── OFFLINE LAYER — Full offline support with mutation queue ─────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const _OFFLINE_CACHE_KEY  = 'fb_api_cache';
const _OFFLINE_QUEUE_KEY  = 'fb_offline_queue';
const _OFFLINE_SNAP_KEY   = 'fb_data_snapshot';

// ── Read/write the localStorage cache (JSON blob keyed by API path) ──────────
function _cacheGet(path) {
  try {
    const store = JSON.parse(localStorage.getItem(_OFFLINE_CACHE_KEY) || '{}');
    return store[path];
  } catch { return undefined; }
}
function _cacheSet(path, value) {
  try {
    const store = JSON.parse(localStorage.getItem(_OFFLINE_CACHE_KEY) || '{}');
    store[path] = value;
    // Keep cache size reasonable — evict entries older than 24 h
    const now = Date.now();
    Object.keys(store).forEach(k => {
      if (store[k]?._cachedAt && now - store[k]._cachedAt > 86400000) delete store[k];
    });
    localStorage.setItem(_OFFLINE_CACHE_KEY, JSON.stringify(store));
  } catch (e) { console.warn('[Offline] cache write failed:', e.message); }
}

// ── Offline write queue ───────────────────────────────────────────────────────
function _queueGet() {
  try { return JSON.parse(localStorage.getItem(_OFFLINE_QUEUE_KEY) || '[]'); }
  catch { return []; }
}
function _queuePush(op) {
  try {
    const q = _queueGet();
    q.push({ ...op, _queuedAt: Date.now() });
    localStorage.setItem(_OFFLINE_QUEUE_KEY, JSON.stringify(q));
    console.log('[Offline] Queued:', op.method, op.path);
  } catch (e) { console.warn('[Offline] queue write failed:', e.message); }
}
function _queueClear() {
  try { localStorage.removeItem(_OFFLINE_QUEUE_KEY); } catch {}
}

// ── Snapshot APP.data for offline reads ──────────────────────────────────────
function saveDataSnapshot(data) {
  try {
    if (!data) return;
    localStorage.setItem(_OFFLINE_SNAP_KEY, JSON.stringify({ data, savedAt: Date.now() }));
  } catch (e) { console.warn('[Offline] snapshot save failed:', e.message); }
}
function loadDataSnapshot() {
  try {
    const raw = localStorage.getItem(_OFFLINE_SNAP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.data || null;
  } catch { return null; }
}
window.saveDataSnapshot = saveDataSnapshot;
window.loadDataSnapshot = loadDataSnapshot;

// ── Offline-aware apiFetch ────────────────────────────────────────────────────
// Wraps the original apiFetch:
//   GET  — try network, cache success, fall back to cache when offline
//   POST/PUT/DELETE — when offline, queue and return fake optimistic response
const _apiFetch_orig = apiFetch;
async function apiFetch(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const online = navigator.onLine;

  if (method === 'GET') {
    if (!online) {
      // Return cached value if we have one
      const cached = _cacheGet(path);
      if (cached !== undefined) {
        console.log('[Offline] Cache hit:', path);
        return cached?.value ?? cached;
      }
      // No cache — throw so caller can handle gracefully
      throw new Error('Offline — no cached data for ' + path);
    }
    // Online: fetch and cache result
    try {
      const result = await _apiFetch_orig(path, options);
      _cacheSet(path, { value: result, _cachedAt: Date.now() });
      return result;
    } catch (e) {
      // Network error even though navigator.onLine — try cache as fallback
      const cached = _cacheGet(path);
      if (cached !== undefined) {
        console.warn('[Offline] Network fail, using cache for:', path);
        return cached?.value ?? cached;
      }
      throw e;
    }
  }

  // Mutation — queue when offline
  if (!online) {
    _queuePush({ method, path, body: options.body || null });
    // Return optimistic fake response so caller doesn't crash
    return { id: 'offline_' + Date.now(), offline: true, queued: true };
  }

  // Online mutation — execute normally
  return _apiFetch_orig(path, options);
}

// ── Flush offline queue when connectivity restores ────────────────────────────
window._offlineFlushing = false;
async function flushOfflineQueue() {
  const queue = _queueGet();
  if (!queue.length || window._offlineFlushing) return;
  window._offlineFlushing = true;

  console.log('[Offline] Flushing', queue.length, 'queued operations');
  if (typeof toast === 'function') toast('⟳ Syncing ' + queue.length + ' offline changes…', 'info');

  let successCount = 0, failCount = 0;
  for (const op of queue) {
    try {
      await _apiFetch_orig(op.path, {
        method: op.method,
        body: op.body || undefined,
        headers: { 'Content-Type': 'application/json' }
      });
      successCount++;
    } catch (e) {
      console.error('[Offline] Flush failed for', op.method, op.path, e.message);
      failCount++;
    }
  }

  _queueClear();
  window._offlineFlushing = false;

  if (successCount > 0 && typeof toast === 'function')
    toast('✅ ' + successCount + ' change' + (successCount > 1 ? 's' : '') + ' synced to server', 'success');
  if (failCount > 0 && typeof toast === 'function')
    toast('⚠️ ' + failCount + ' change(s) failed to sync — please check', 'error');

  // Reload data to ensure UI reflects true server state
  if (typeof loadData === 'function' && typeof APP !== 'undefined' && APP.loggedIn) {
    try { await loadData(); if (typeof renderPage === 'function') renderPage(); } catch {}
  }
}

// Pending queue size helper (for UI badge)
function offlineQueueSize() { return _queueGet().length; }
window.offlineQueueSize    = offlineQueueSize;
window.flushOfflineQueue   = flushOfflineQueue;
window.loadDataSnapshot    = loadDataSnapshot;
window.saveDataSnapshot    = saveDataSnapshot;
window._queueGet           = _queueGet;

console.log('[FuelDB] Offline layer loaded — full read/write offline support');
