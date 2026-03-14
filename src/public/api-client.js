/**
 * FuelBunk Pro — API Client (Drop-in replacement for FuelDB)
 */

const API_BASE = '/api';
let _authToken = null;
let _tenantId = null;
let _logoutInProgress = false;
const _TOKEN_KEY = '_fb_auth_token';

function setAuthToken(token)  {
  _authToken = token;
  if (token) sessionStorage.setItem(_TOKEN_KEY, token);
  else sessionStorage.removeItem(_TOKEN_KEY);
}
function getAuthToken() {
  if (!_authToken) _authToken = sessionStorage.getItem(_TOKEN_KEY) || null;
  return _authToken;
}
function setTenantId(id)      { _tenantId = id; }
function getTenantId()        { return _tenantId; }
function clearAuth()          { _authToken = null; _tenantId = null; _logoutInProgress = false; sessionStorage.removeItem(_TOKEN_KEY); }

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

  async getAll(storeName, opts = {}) {
    // Fix 01B: forward optional ?from=date query param for date-filterable stores
    const qs = opts.from ? '?from=' + encodeURIComponent(opts.from) : '';
    try { return await apiFetch('/data/' + storeName + qs); }
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
// FIX F-04: Add stale-data age check — warn if snapshot is older than SNAPSHOT_STALE_MS (24h)
// Previously: savedAt was stored but never read — stale prices shown silently for days.
function loadDataSnapshot() {
  try {
    const raw = localStorage.getItem(_OFFLINE_SNAP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data) return null;
    const staleMs = (typeof SNAPSHOT_STALE_MS !== "undefined") ? SNAPSHOT_STALE_MS : 86400000;
    const ageMs = Date.now() - (parsed.savedAt || 0);
    const ageHours = Math.round(ageMs / 3600000);
    if (ageMs > staleMs) {
      console.warn("[Offline] Snapshot is " + ageHours + "h old — fuel prices and stock levels may be stale.");
      // Set a flag so the app can show a stale-data banner
      window._snapshotIsStale = true;
      window._snapshotAgeHours = ageHours;
    } else {
      window._snapshotIsStale = false;
    }
    return parsed.data;
  } catch { return null; }
}
window.saveDataSnapshot = saveDataSnapshot;
window.loadDataSnapshot = loadDataSnapshot;

// ── Offline-aware apiFetch ────────────────────────────────────────────────────
// Wraps the original apiFetch:
//   GET  — try network, cache success, fall back to cache when offline
//   POST/PUT/DELETE — when offline, queue and return fake optimistic response
//
// ROOT CAUSE FIX: The original code used `async function apiFetch()` (a function DECLARATION).
// JavaScript HOISTS all function declarations to the top of the scope. Since there are
// two `async function apiFetch` declarations in this file, the SECOND wins at hoist time.
// This means `const _apiFetch_orig = apiFetch` captured the SECOND (offline wrapper) itself —
// not the first (real fetch). Calling _apiFetch_orig() called itself → infinite recursion
// → "Maximum call stack size exceeded".
//
// FIX: Use an assignment expression instead of a function declaration.
// Assignments are NOT hoisted, so _apiFetch_orig correctly captures the first apiFetch.
const _apiFetch_orig = apiFetch;
apiFetch = async function apiFetchOffline(path, options = {}) {
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
};
// Update the global window reference so all callers use the offline-aware version
window.apiFetch = apiFetch;

// ── Flush offline queue when connectivity restores ────────────────────────────
window._offlineFlushing = false;
// FIX F-03: Re-queue failed operations instead of silently dropping them.
// Previously: _queueClear() ran after ALL ops regardless of individual failures — lost data.
// Now: only successful ops are removed; failed ops remain in queue for next retry.
async function flushOfflineQueue() {
  const queue = _queueGet();
  if (!queue.length || window._offlineFlushing) return;
  window._offlineFlushing = true;

  console.log('[Offline] Flushing', queue.length, 'queued operations');
  if (typeof toast === 'function') toast('⟳ Syncing ' + queue.length + ' offline changes…', 'info');

  const failedOps = [];
  let successCount = 0;

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
      // FIX: Track retry count to avoid infinite re-queuing
      const retries = (op._retries || 0) + 1;
      if (retries <= 3) {
        failedOps.push({ ...op, _retries: retries, _lastError: e.message });
      } else {
        console.warn('[Offline] Dropping op after 3 retries:', op.method, op.path);
        if (typeof toast === 'function')
          toast(`⚠️ Dropped 1 change after 3 failed attempts (${op.method} ${op.path})`, 'error');
      }
    }
  }

  // Only keep the ops that failed (preserve them for next retry)
  _queueClear();
  if (failedOps.length > 0) {
    try { localStorage.setItem('_fb_offline_queue', JSON.stringify(failedOps)); } catch(e) {}
  }

  window._offlineFlushing = false;

  if (successCount > 0 && typeof toast === 'function')
    toast('✅ ' + successCount + ' change' + (successCount > 1 ? 's' : '') + ' synced to server', 'success');
  if (failedOps.length > 0 && typeof toast === 'function')
    toast('⚠️ ' + failedOps.length + ' change(s) will retry on next sync (attempt ' + (failedOps[0]._retries) + '/3)', 'warning');

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
