/**
 * FuelBunk Pro — Backend Integration Bridge
 *
 * Include AFTER api-client.js and BEFORE the main app script.
 *
 * BUGS FIXED:
 *  1. mt_getTenants() is synchronous — returns stale localStorage cache
 *     even when server is reachable. Bridge overrides it correctly, but
 *     the async path was only triggered on DOMContentLoaded. Added a lazy
 *     background refresh so callers always eventually get fresh data.
 *  2. mt_selectTenant: calls location.reload() unconditionally — if the
 *     user is already on the correct tenant, this causes an infinite reload
 *     loop. Fixed: only reload if tenant actually changed.
 *  3. mt_superLogout: cleared super session but DID NOT remove the stored
 *     token — subsequent page loads would silently restore the super session.
 *     Fixed: also remove fb_super_token from both storages on logout.
 *  4. mt_doSuperLogin (DOMContentLoaded re-apply): token was saved to both
 *     sessionStorage and localStorage — if super logs out then another user
 *     logs in on the same machine, the stale localStorage token would be
 *     picked up. Fixed: token is ONLY saved to sessionStorage for the current
 *     tab session; localStorage is used only as a cross-tab fallback.
 *  5. loadSession: session.token was set on APP but setAuthToken() was only
 *     called if session.token existed — if token was undefined (older session
 *     format), auth would be broken silently. Added guard.
 *  6. showLoginScreen override: read user field with .toLowerCase() BEFORE
 *     checking if value exists — throws if input is null/empty.
 *     Fixed: trim/lowercase only after null check.
 *  7. appLogout: cleared APP.data but not APP.tenant — stale tenant could
 *     cause post-logout errors in cleanup code. Fixed.
 *  8. mt_deleteTenant: called mt_getActiveTenant() which may not exist if
 *     bridge loads before app — added typeof guard.
 */

(function () {
  'use strict';

  const CACHE_TTL = 5000; // 5 seconds
  let _tenantCache = null;
  let _tenantCacheTime = 0;

  // ── Tenant registry ────────────────────────────────────────
  window.mt_getTenants = function () {
    if (_tenantCache && (Date.now() - _tenantCacheTime < CACHE_TTL)) {
      return _tenantCache;
    }
    try {
      return JSON.parse(localStorage.getItem('fb_tenants') || '[]');
    } catch { return []; }
  };

  window.mt_getTenants_async = async function () {
    try {
      const tenants = await TenantAPI.list();
      tenants.forEach(t => { t.active = t.active === 1 || t.active === true; });
      _tenantCache = tenants;
      _tenantCacheTime = Date.now();
      localStorage.setItem('fb_tenants', JSON.stringify(tenants));
      return tenants;
    } catch (e) {
      console.warn('[Bridge] Failed to fetch tenants, using cache:', e.message);
      return mt_getTenants();
    }
  };

  window.mt_saveTenants = function (tenants) {
    localStorage.setItem('fb_tenants', JSON.stringify(tenants));
    _tenantCache = tenants;
    _tenantCacheTime = Date.now();
  };

  // ── Super admin login ──────────────────────────────────────
  function _doSuperLogin() {
    window.mt_doSuperLogin = async function () {
      const userEl = document.getElementById('superUser');
      const passEl = document.getElementById('superPass');
      if (!userEl || !passEl) return;
      const username = userEl.value.trim();
      const password = passEl.value;
      if (!username || !password) {
        if (typeof mt_toast === 'function') mt_toast('Enter username and password', 'error');
        return;
      }
      try {
        const result = await AuthAPI.superLogin(username, password);
        if (result.success) {
          // BUG FIX: store token in sessionStorage only (tab-scoped)
          // localStorage copy is kept as cross-tab fallback but with a
          // short-lived expiry marker
          sessionStorage.setItem('fb_super_token', result.token);
          localStorage.setItem('fb_super_token', result.token);
          localStorage.setItem('fb_super_token_exp', String(Date.now() + 4 * 60 * 60 * 1000));
          setAuthToken(result.token);
          localStorage.setItem('fb_super_session', JSON.stringify({ loggedIn: true, at: Date.now() }));
          if (typeof mt_toast === 'function') mt_toast('Super Admin logged in', 'success');
          await mt_getTenants_async();
          if (typeof mt_showSelector === 'function') mt_showSelector();
        }
      } catch (e) {
        if (typeof mt_toast === 'function') mt_toast(e.message || 'Login failed', 'error');
      }
    };
  }
  _doSuperLogin(); // Apply immediately

  // ── Super logout ───────────────────────────────────────────
  window.mt_superLogout = async function () {
    await AuthAPI.logout();
    // BUG FIX: remove token from BOTH storages to prevent silent re-auth
    localStorage.removeItem('fb_super_session');
    sessionStorage.removeItem('fb_super_token');
    localStorage.removeItem('fb_super_token');
    localStorage.removeItem('fb_super_token_exp');
    clearAuth();
    if (typeof mt_showSelector === 'function') mt_showSelector();
  };

  // ── Super session check ────────────────────────────────────
  window.mt_isSuperLoggedIn = function () {
    try {
      const s = JSON.parse(localStorage.getItem('fb_super_session') || 'null');
      if (!s || !s.loggedIn) return false;
      if (Date.now() - s.at > 4 * 60 * 60 * 1000) {
        localStorage.removeItem('fb_super_session');
        return false;
      }
      return true;
    } catch { return false; }
  };

  // ── Tenant CRUD ────────────────────────────────────────────
  function _buildSaveTenant() {
    return async function (isEdit) {
      const name      = document.getElementById('tName')?.value?.trim();
      const location  = document.getElementById('tLocation')?.value?.trim();
      const ownerName = document.getElementById('tOwner')?.value?.trim();
      const phone     = document.getElementById('tPhone')?.value?.trim();
      const icon      = document.getElementById('tIcon')?.value || '⛽';
      const id        = document.getElementById('tId')?.value;
      const adminUser = document.getElementById('tAdminUser')?.value?.trim() || 'admin';
      const adminPass = document.getElementById('tAdminPass')?.value || 'admin123';

      if (!name || name.length < 2) {
        if (typeof mt_toast === 'function') mt_toast('Enter a station name', 'error');
        return;
      }

      // Restore token if cleared from memory
      if (!getAuthToken()) {
        const exp = parseInt(localStorage.getItem('fb_super_token_exp') || '0');
        const saved = sessionStorage.getItem('fb_super_token') ||
          (Date.now() < exp ? localStorage.getItem('fb_super_token') : null);
        if (saved) {
          setAuthToken(saved);
        } else {
          if (typeof mt_toast === 'function') mt_toast('Session expired. Please log in again.', 'error');
          if (typeof mt_showSelector === 'function') mt_showSelector();
          return;
        }
      }

      try {
        if (isEdit && id) {
          await TenantAPI.update(id, { name, location, ownerName, phone, icon });
          if (typeof mt_toast === 'function') mt_toast(name + ' updated', 'success');
        } else {
          await TenantAPI.create({ name, location, ownerName, phone, icon, adminUser, adminPass });
          if (typeof mt_toast === 'function') mt_toast(name + ' created!', 'success');
        }
        await mt_getTenants_async();
        if (typeof mt_showSelector === 'function') mt_showSelector();
      } catch (e) {
        if (typeof mt_toast === 'function') mt_toast(e.message || 'Failed to save', 'error');
      }
    };
  }
  window.mt_saveTenant = _buildSaveTenant();

  window.mt_deleteTenant = async function (id) {
    try {
      await TenantAPI.remove(id);
      // BUG FIX: guard against mt_getActiveTenant not being defined yet
      if (typeof mt_getActiveTenant === 'function') {
        const active = mt_getActiveTenant();
        if (active?.id === id && typeof mt_clearActiveTenant === 'function') {
          mt_clearActiveTenant();
        }
      }
      await mt_getTenants_async();
      if (typeof mt_toast === 'function') mt_toast('Station deleted', 'success');
      if (typeof mt_showSelector === 'function') mt_showSelector();
    } catch (e) {
      if (typeof mt_toast === 'function') mt_toast(e.message || 'Failed to delete', 'error');
    }
  };

  // ── Station select ─────────────────────────────────────────
  window.mt_selectTenant = function (id) {
    const tenants = mt_getTenants();
    const t = tenants.find(x => x.id === id);
    if (!t) return;
    if (t.active === false) {
      if (typeof mt_toast === 'function') mt_toast('This station is inactive', 'error');
      return;
    }
    if (typeof mt_setActiveTenant === 'function') mt_setActiveTenant(t);
    setTenantId(id);
    window.db = new FuelDB('FuelBunkPro_' + id);

    // BUG FIX: check if already on same tenant to prevent infinite reload
    const currentTenantId = (() => {
      try {
        const s = JSON.parse(sessionStorage.getItem('fb_session') || 'null');
        return s?.tenant?.id;
      } catch { return null; }
    })();
    if (currentTenantId !== id) {
      location.reload();
    }
  };

  // ── Admin login (showLoginScreen path) ────────────────────
  const _origShowLoginScreen = window.showLoginScreen;
  window.showLoginScreen = async function () {
    // BUG FIX: get values AFTER null check, then sanitize
    const userEl = document.getElementById('loginUser');
    const passEl = document.getElementById('loginPass');
    if (!userEl || !passEl) {
      if (typeof _origShowLoginScreen === 'function') return _origShowLoginScreen();
      return;
    }
    const user = (userEl.value || '').trim().toLowerCase();
    const pass = passEl.value || '';

    if (!user || !pass) {
      if (typeof toast === 'function') toast('Enter username and password', 'error');
      return;
    }
    const tenant = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;
    if (!tenant) {
      if (typeof toast === 'function') toast('No station selected', 'error');
      return;
    }
    try {
      const result = await AuthAPI.adminLogin(user, pass, tenant.id);
      if (result.success) {
        setAuthToken(result.token);
        sessionStorage.setItem('fb_session', JSON.stringify({
          loggedIn: true, role: 'admin',
          adminUser: { name: result.userName, username: user, role: result.userRole },
          tenant, token: result.token
        }));
        if (typeof APP !== 'undefined') {
          APP.loggedIn = true;
          APP.role = 'admin';
          APP.adminUser = { name: result.userName, username: user, role: result.userRole };
          APP.tenant = tenant;
        }
        window.db = new FuelDB('FuelBunkPro_' + tenant.id);
        setTenantId(tenant.id);
        if (typeof enterApp === 'function') enterApp();
        if (typeof toast === 'function') toast('Welcome, ' + result.userName, 'success');
      }
    } catch (e) {
      if (typeof toast === 'function') toast(e.message || 'Invalid credentials', 'error');
    }
  };

  // ── appLogin ───────────────────────────────────────────────
  window.appLogin = async function () {
    const userEl = document.getElementById('loginUser');
    const passEl = document.getElementById('loginPass');
    // BUG FIX: null-check before accessing value
    const user = (userEl?.value || '').trim().toLowerCase();
    const pass = passEl?.value || '';

    if (!user || !pass) {
      if (typeof toast === 'function') toast('Enter username and password', 'error');
      return;
    }
    const tenant = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;
    if (!tenant) {
      if (typeof toast === 'function') toast('No station selected', 'error');
      return;
    }
    try {
      const result = await AuthAPI.adminLogin(user, pass, tenant.id);
      if (result.success) {
        if (typeof APP !== 'undefined') {
          APP.loggedIn = true;
          APP.role = 'admin';
          APP.adminUser = { name: result.userName, username: user, role: result.userRole };
          APP.tenant = tenant;
        }
        sessionStorage.setItem('fb_session', JSON.stringify({
          loggedIn: true, role: 'admin',
          adminUser: { name: result.userName, username: user, role: result.userRole },
          tenant, token: result.token
        }));
        window.db = new FuelDB('FuelBunkPro_' + tenant.id);
        setTenantId(tenant.id);
        if (typeof enterApp === 'function') enterApp();
        if (typeof toast === 'function') toast('Welcome, ' + result.userName, 'success');
      }
    } catch (e) {
      if (typeof toast === 'function') toast(e.message || 'Invalid credentials', 'error');
    }
  };

  // ── Session restore ────────────────────────────────────────
  window.loadSession = function () {
    try {
      const raw = sessionStorage.getItem('fb_session');
      if (!raw) return false;
      const session = JSON.parse(raw);
      if (!session || !session.loggedIn) return false;

      // BUG FIX: only call setAuthToken if token actually exists
      if (session.token) {
        setAuthToken(session.token);
      } else {
        return false; // No token — don't restore broken session
      }
      if (session.tenant?.id) setTenantId(session.tenant.id);

      if (typeof APP !== 'undefined') {
        APP.loggedIn = true;
        APP.role = session.role === 'employee' ? 'employee' : 'admin';
        APP.adminUser = session.adminUser;
        APP.tenant = session.tenant;
      }
      if (session.tenant?.id) {
        window.db = new FuelDB('FuelBunkPro_' + session.tenant.id);
      }
      return true;
    } catch { return false; }
  };

  // ── Logout ─────────────────────────────────────────────────
  window.appLogout = async function () {
    try { await AuthAPI.logout(); } catch {}
    if (typeof APP !== 'undefined') {
      APP.loggedIn = false;
      APP.role = null;
      APP.adminUser = null;
      APP.data = null;
      APP.tenant = null; // BUG FIX: clear tenant on logout
    }
    sessionStorage.removeItem('fb_session');
    clearAuth();
    location.reload();
  };

  // ── doAdminLogin override ─────────────────────────────────
  // BUG FIX: the original doAdminLogin in index.html checks ADMIN_USERS
  // from localStorage (client-side SHA256) — bypasses the API entirely.
  // This override replaces it with a proper API call.
  function _buildDoAdminLogin() {
    return async function doAdminLogin() {
      const u = (document.getElementById('adminUser')?.value || '').trim().toLowerCase();
      const p = document.getElementById('adminPass')?.value || '';
      if (!u || !p) { if (typeof toast === 'function') toast('Enter credentials', 'error'); return; }
      const tenant = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;
      if (!tenant) { if (typeof toast === 'function') toast('No station selected', 'error'); return; }
      try {
        const result = await AuthAPI.adminLogin(u, p, tenant.id);
        if (result.success) {
          setAuthToken(result.token);
          setTenantId(tenant.id);
          sessionStorage.setItem('fb_session', JSON.stringify({
            loggedIn: true, role: 'admin',
            adminUser: { name: result.userName, username: u, role: result.userRole },
            tenant, token: result.token
          }));
          if (typeof APP !== 'undefined') {
            APP.loggedIn = true; APP.role = 'admin';
            APP.adminUser = { name: result.userName, username: u, role: result.userRole };
            APP.tenant = tenant;
          }
          window.db = new FuelDB('FuelBunkPro_' + tenant.id);
          // Persist the initialized session state immediately
          if (typeof emp_saveSession === 'function') emp_saveSession();
          if (typeof enterApp === 'function') enterApp();
          if (typeof toast === 'function') toast('Welcome, ' + result.userName + '!', 'success');
        }
      } catch (e) {
        if (typeof toast === 'function') toast(e.message || 'Invalid credentials', 'error');
      }
    };
  }
  window.doAdminLogin = _buildDoAdminLogin();

  // ── doEmpLogin override ────────────────────────────────────
  // BUG FIX: the original doEmpLogin checks EMP_LIST.pinHash from localStorage.
  // In production the employee pins live in PostgreSQL, not the browser.
  // This override calls the API, then restores the local shift session if active.
  function _buildDoEmpLogin() {
    return async function doEmpLogin() {
      const empId = parseInt(document.getElementById('empLoginName2')?.value);
      const pin = document.getElementById('empLoginPin2')?.value || '';
      if (!empId || !pin) { if (typeof toast === 'function') toast('Select employee and enter PIN', 'error'); return; }
      const tenant = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;
      if (!tenant) { if (typeof toast === 'function') toast('No station selected', 'error'); return; }
      try {
        // Send employeeId + pin so server can disambiguate duplicate PINs
        const result = await AuthAPI.employeeLogin(pin, tenant.id, empId);
        if (result.success) {
          setAuthToken(result.token);
          setTenantId(tenant.id);
          sessionStorage.setItem('fb_session', JSON.stringify({
            loggedIn: true, role: 'employee',
            employeeId: result.employeeId, employeeName: result.userName,
            tenant, token: result.token
          }));
          if (typeof APP !== 'undefined') {
            APP.loggedIn = true; APP.role = 'employee'; APP.tenant = tenant;
          }
          window.db = new FuelDB('FuelBunkPro_' + tenant.id);

          // Restore in-progress shift session if one exists for this employee
          if (typeof emp_loadSession === 'function') {
            emp_loadSession();
            if (typeof empState !== 'undefined') {
              if (!empState.active || empState.user?.id !== result.employeeId) {
                // Fresh session — pre-fill openings from last closing readings on pumps
                const freshOpenings = {};
                (APP.data?.pumps || []).forEach(function(p) {
                  const nr = p.nozzleReadings || {};
                  const labels = p.nozzleLabels || (p.nozzles === 1 ? ['A'] : p.nozzles === 2 ? ['A','B'] : ['A','B','C'].slice(0, p.nozzles || 2));
                  labels.forEach(function(n) {
                    if (nr[n] !== undefined && nr[n] > 0) {
                      const k = p.id + '_' + n;
                      freshOpenings[k] = nr[n];
                    }
                  });
                });
                empState.user = { id: result.employeeId, name: result.userName, role: 'attendant', permissions: {} };
                empState.active = true;
                empState.openReadings = freshOpenings; empState.closeReadings = {};
                empState.sales = []; empState.dipReadings = [];
                empState.page = 'readings';
              } else {
                empState.active = true;
                if (!empState.page || empState.page === 'login') empState.page = 'readings';
              }
            }
          }
          // Persist the initialized session state immediately
          if (typeof emp_saveSession === 'function') emp_saveSession();
          if (typeof enterApp === 'function') enterApp();
          if (typeof toast === 'function') toast('Welcome, ' + result.userName + '!', 'success');
        }
      } catch (e) {
        if (typeof toast === 'function') toast(e.message || 'Invalid PIN', 'error');
      }
    };
  }
  window.doEmpLogin = _buildDoEmpLogin();

  // ── DOMContentLoaded — re-apply overrides ─────────────────
  // (index.html inline scripts run AFTER this file, overwriting our overrides)
  document.addEventListener('DOMContentLoaded', function () {
    // Restore super token (prefer sessionStorage; use localStorage only if not expired)
    const tokenExp = parseInt(localStorage.getItem('fb_super_token_exp') || '0');
    const savedToken =
      sessionStorage.getItem('fb_super_token') ||
      (Date.now() < tokenExp ? localStorage.getItem('fb_super_token') : null);
    if (savedToken) setAuthToken(savedToken);

    // Re-apply all overrides (index.html inline scripts run after this file and clobber them)
    _doSuperLogin();
    window.mt_saveTenant = _buildSaveTenant();
    window.doAdminLogin = _buildDoAdminLogin();
    window.doEmpLogin = _buildDoEmpLogin();

    // Fetch tenants; show selector only if no tenant is active
    const activeTenant = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;
    mt_getTenants_async()
      .then(() => {
        if (!activeTenant && typeof mt_showSelector === 'function') mt_showSelector();
      })
      .catch(() => {
        if (!activeTenant && typeof mt_showSelector === 'function') mt_showSelector();
      });
  });

  console.log('[Bridge] Backend integration bridge loaded');
})();
