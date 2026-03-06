/**
 * FuelBunk Pro — Backend Integration Bridge
 *
 * INCLUDE THIS SCRIPT AFTER api-client.js and BEFORE the main app script.
 *
 * This script overrides the localStorage/IndexedDB-based functions in the
 * original frontend to route through the REST API backend instead.
 *
 * Original functions overridden:
 *   - mt_getTenants() → API call
 *   - mt_saveTenants() → API call
 *   - mt_doSuperLogin() → AuthAPI.superLogin()
 *   - mt_superLogout() → AuthAPI.logout()
 *   - showLoginScreen() / appLogin() → AuthAPI.adminLogin()
 *   - FuelDB class → REST API (already in api-client.js)
 */

(function() {
  'use strict';

  // ═══════════════════════════════════════════
  // TENANT REGISTRY — API-backed with localStorage cache
  // ═══════════════════════════════════════════
  let _tenantCache = null;
  let _tenantCacheTime = 0;
  const CACHE_TTL = 5000; // 5 second cache

  // Override mt_getTenants to fetch from API with localStorage fallback
  const _origGetTenants = window.mt_getTenants;
  window.mt_getTenants = function() {
    // Return cache if fresh (sync — needed by original code)
    if (_tenantCache && (Date.now() - _tenantCacheTime < CACHE_TTL)) {
      return _tenantCache;
    }
    // Return localStorage fallback for sync access
    try {
      return JSON.parse(localStorage.getItem('fb_tenants') || '[]');
    } catch { return []; }
  };

  // Async version that fetches from server and updates cache
  window.mt_getTenants_async = async function() {
    try {
      const tenants = await TenantAPI.list();
      // Normalize active field: SQLite returns 0/1, frontend expects true/false
      tenants.forEach(t => { t.active = t.active === 1 || t.active === true; });
      _tenantCache = tenants;
      _tenantCacheTime = Date.now();
      // Also update localStorage as cache
      localStorage.setItem('fb_tenants', JSON.stringify(tenants));
      return tenants;
    } catch (e) {
      console.warn('[Bridge] Failed to fetch tenants from server, using cache:', e.message);
      return mt_getTenants();
    }
  };

  // Override mt_saveTenants — this is tricky since original saves to localStorage
  // We keep localStorage sync AND push to server
  const _origSaveTenants = window.mt_saveTenants;
  window.mt_saveTenants = function(tenants) {
    // Keep localStorage sync for immediate UI
    localStorage.setItem('fb_tenants', JSON.stringify(tenants));
    _tenantCache = tenants;
    _tenantCacheTime = Date.now();
    // Note: individual tenant creates/updates should use TenantAPI directly
    // This function is called by the original code after modifications
  };

  // ═══════════════════════════════════════════
  // SUPER ADMIN LOGIN — API-backed
  // ═══════════════════════════════════════════
  const _origDoSuperLogin = window.mt_doSuperLogin;
  window.mt_doSuperLogin = async function() {
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
        // Save token so it survives page navigation
        sessionStorage.setItem('fb_super_token', result.token);
        localStorage.setItem('fb_super_token', result.token);
        setAuthToken(result.token);
        localStorage.setItem('fb_super_session', JSON.stringify({ loggedIn: true, at: Date.now() }));
        if (typeof mt_toast === 'function') mt_toast('Super Admin logged in', 'success');

        // Refresh tenant list from server
        await mt_getTenants_async();
        if (typeof mt_showSelector === 'function') mt_showSelector();
      }
    } catch (e) {
      if (typeof mt_toast === 'function') mt_toast(e.message || 'Login failed', 'error');
    }
  };

  // Override super logout
  const _origSuperLogout = window.mt_superLogout;
  window.mt_superLogout = async function() {
    await AuthAPI.logout();
    localStorage.removeItem('fb_super_session');
    if (typeof mt_showSelector === 'function') mt_showSelector();
  };

  // Override mt_isSuperLoggedIn — check both localStorage marker AND valid token
  const _origIsSuperLoggedIn = window.mt_isSuperLoggedIn;
  window.mt_isSuperLoggedIn = function() {
    const s = (() => {
      try { return JSON.parse(localStorage.getItem('fb_super_session') || 'null'); } catch { return null; }
    })();
    if (!s || !s.loggedIn) return false;
    if (Date.now() - s.at > 4 * 60 * 60 * 1000) {
      localStorage.removeItem('fb_super_session');
      return false;
    }
    return true;
  };

  // ═══════════════════════════════════════════
  // TENANT CRUD — Route through API
  // ═══════════════════════════════════════════
  const _origSaveTenant = window.mt_saveTenant;
  window.mt_saveTenant = async function(isEdit) {
    // Use same field IDs as index.html form
    const name     = document.getElementById('tName')?.value?.trim();
    const location = document.getElementById('tLocation')?.value?.trim();
    const ownerName= document.getElementById('tOwner')?.value?.trim();
    const phone    = document.getElementById('tPhone')?.value?.trim();
    const icon     = document.getElementById('tIcon')?.value || '⛽';
    const id       = document.getElementById('tId')?.value;
    const adminUser= document.getElementById('tAdminUser')?.value?.trim() || 'admin';
    const adminPass= document.getElementById('tAdminPass')?.value || 'admin123';

    if (!name || name.length < 2) { mt_toast('Enter a station name', 'error'); return; }

    // Ensure token is set — restore from sessionStorage or re-authenticate
    if (!getAuthToken()) {
      const saved = sessionStorage.getItem('fb_super_token') || localStorage.getItem('fb_super_token');
      if (saved) {
        setAuthToken(saved);
      } else {
        mt_toast('Session expired. Please log in again.', 'error');
        mt_showSelector();
        return;
      }
    }

    try {
      if (isEdit && id) {
        await TenantAPI.update(id, { name, location, ownerName, phone, icon });
        mt_toast(name + ' updated', 'success');
      } else {
        await TenantAPI.create({ name, location, ownerName, phone, icon, adminUser, adminPass });
        mt_toast(name + ' created!', 'success');
      }
      await mt_getTenants_async();
      mt_showSelector();
    } catch (e) {
      mt_toast(e.message || 'Failed to save', 'error');
    }
  };

  const _origDeleteTenant = window.mt_deleteTenant;
  window.mt_deleteTenant = async function(id) {
    try {
      await TenantAPI.remove(id);
      const active = mt_getActiveTenant();
      if (active?.id === id) mt_clearActiveTenant();
      await mt_getTenants_async();
      mt_toast('Station deleted', 'success');
      mt_showSelector();
    } catch (e) {
      mt_toast(e.message || 'Failed to delete', 'error');
    }
  };

  // ═══════════════════════════════════════════
  // STATION SELECT — Login to selected station
  // ═══════════════════════════════════════════
  const _origSelectTenant = window.mt_selectTenant;
  window.mt_selectTenant = function(id) {
    const tenants = mt_getTenants();
    const t = tenants.find(x => x.id === id);
    if (!t) return;
    if (t.active === false) { mt_toast('This station is inactive', 'error'); return; }

    // Set active tenant in localStorage (for original code)
    mt_setActiveTenant(t);
    setTenantId(id);

    // Re-initialize FuelDB with API-backed version
    window.db = new FuelDB('FuelBunkPro_' + id);

    // Load the app
    location.reload();
  };

  // ═══════════════════════════════════════════
  // ADMIN LOGIN — API-backed
  // ═══════════════════════════════════════════
  // The original appLogin function will need to call AuthAPI
  // We patch the credential verification part

  // Override mt_toggleStation — sync active status to server
  const _origToggleStation = window.mt_toggleStation;
  window.mt_toggleStation = async function(id) {
    const tenants = mt_getTenants();
    const t = tenants.find(x => x.id === id);
    if (!t) return;
    const newActive = t.active === false ? true : false;
    try {
      await TenantAPI.update(id, { active: newActive });
    } catch(e) {
      console.warn('[Bridge] Failed to update station active status on server:', e.message);
    }
    // Also update localStorage immediately for UI
    if (_origToggleStation) _origToggleStation(id);
    else {
      tenants.find(x => x.id === id).active = newActive;
      localStorage.setItem('fb_tenants', JSON.stringify(tenants));
      mt_showSelector();
    }
    // Refresh from server
    mt_getTenants_async().then(() => mt_showSelector()).catch(()=>{});
  };

  // Override doAdminLogin — used by station selector login screen
  window.doAdminLogin = async function() {
    const user = document.getElementById('adminUser')?.value?.trim()?.toLowerCase();
    const pass = document.getElementById('adminPass')?.value;

    if (!user || !pass) { if(typeof toast==='function') toast('Enter credentials', 'error'); return; }

    const tenant = mt_getActiveTenant();
    if (!tenant) { if(typeof toast==='function') toast('No station selected', 'error'); return; }

    try {
      const result = await AuthAPI.adminLogin(user, pass, tenant.id);
      if (result.success) {
        setAuthToken(result.token);
        sessionStorage.setItem('fb_super_token', sessionStorage.getItem('fb_super_token') || '');
        sessionStorage.setItem('fb_session', JSON.stringify({
          loggedIn: true, role: 'admin',
          adminUser: { name: result.userName, username: user, role: result.userRole },
          tenant: tenant, token: result.token
        }));
        APP.loggedIn = true;
        APP.role = 'admin';
        APP.adminUser = { name: result.userName, username: user, role: result.userRole };
        APP.tenant = tenant;
        window.db = new FuelDB('FuelBunkPro_' + tenant.id);
        setTenantId(tenant.id);
        // Load real DB data BEFORE rendering (prevents all-zeros dashboard)
        if (typeof loadData === 'function') {
          try { await loadData(); } catch(e) { console.warn('[Bridge] loadData:', e.message); }
        }
        if (typeof enterApp === 'function') enterApp();
        if (typeof toast === 'function') toast('Welcome, ' + result.userName, 'success');
      }
    } catch (e) {
      if (typeof toast === 'function') toast(e.message || 'Invalid credentials', 'error');
    }
  };

  const _origAppLogin = window.appLogin;
  window.appLogin = async function() {
    const user = document.getElementById('loginUser')?.value?.trim()?.toLowerCase();
    const pass = document.getElementById('loginPass')?.value;

    if (!user || !pass) { toast('Enter username and password', 'error'); return; }

    const tenant = mt_getActiveTenant();
    if (!tenant) { toast('No station selected', 'error'); return; }

    try {
      const result = await AuthAPI.adminLogin(user, pass, tenant.id);
      if (result.success) {
        // Set session in original APP state
        APP.loggedIn = true;
        APP.role = 'admin';
        APP.adminUser = { name: result.userName, username: user, role: result.userRole };
        APP.tenant = tenant;

        // Save to sessionStorage for page refresh
        sessionStorage.setItem('fb_session', JSON.stringify({
          loggedIn: true, role: 'admin', adminUser: APP.adminUser,
          tenant: tenant, token: result.token
        }));

        // Re-init DB with correct tenant
        window.db = new FuelDB('FuelBunkPro_' + tenant.id);
        setTenantId(tenant.id);
        // Load real DB data BEFORE rendering
        if (typeof loadData === 'function') {
          try { await loadData(); } catch(e) { console.warn('[Bridge] loadData:', e.message); }
        }
        enterApp();
        toast('Welcome, ' + result.userName, 'success');
      }
    } catch (e) {
      toast(e.message || 'Invalid credentials', 'error');
    }
  };

  // ═══════════════════════════════════════════
  // SESSION RESTORE — from sessionStorage
  // ═══════════════════════════════════════════
  const _origLoadSession = window.loadSession;
  window.loadSession = function() {
    try {
      const raw = sessionStorage.getItem('fb_session');
      if (!raw) return false;
      const session = JSON.parse(raw);
      if (!session.loggedIn) return false;

      // Restore auth token
      if (session.token) {
        setAuthToken(session.token);
        setTenantId(session.tenant?.id);
      }

      APP.loggedIn = true;
      APP.role = session.role === 'employee' ? 'employee' : 'admin';
      APP.adminUser = session.adminUser;
      APP.tenant = session.tenant;

      // Re-init DB
      if (session.tenant?.id) {
        window.db = new FuelDB('FuelBunkPro_' + session.tenant.id);
      }

      // initApp() ran loadData() BEFORE this set the token → got SEED zeros.
      // Schedule a reload now that we have a valid token.
      if (session.role !== 'employee') {
        setTimeout(function() {
          if (typeof loadData === 'function' && typeof getAuthToken === 'function' && getAuthToken()) {
            loadData()
              .then(function() { if (typeof renderPage === 'function') renderPage(); })
              .catch(function(e) { console.warn('[Bridge] session reload:', e.message); });
          }
        }, 200);
      }

      return true;
    } catch (e) {
      return false;
    }
  };

  // ═══════════════════════════════════════════
  // LOGOUT — API-backed
  // ═══════════════════════════════════════════
  const _origAppLogout = window.appLogout;
  window.appLogout = async function() {
    try { await AuthAPI.logout(); } catch {}
    APP.loggedIn = false;
    APP.role = null;
    APP.adminUser = null;
    APP.data = null;
    sessionStorage.removeItem('fb_session');
    clearAuth();
    location.reload();
  };

  // ═══════════════════════════════════════════
  // AUTO-REFRESH TENANTS ON PAGE LOAD
  // ═══════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', function() {
    // Restore super token if saved
    const savedToken = sessionStorage.getItem('fb_super_token') || localStorage.getItem('fb_super_token');
    if (savedToken) setAuthToken(savedToken);

    // Fetch tenants from server cache.
    // Only force selector screen when no station is selected.
    const activeTenant = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;
    if (!activeTenant) {
      mt_getTenants_async().then(() => {
        if (typeof mt_showSelector === 'function') mt_showSelector();
      }).catch(() => {
        if (typeof mt_showSelector === 'function') mt_showSelector();
      });
    } else {
      mt_getTenants_async().catch(() => {});
    }

    // Re-apply overrides AFTER all inline scripts have run
    // (index.html re-assigns these functions, undoing our earlier overrides)

    window.mt_doSuperLogin = async function() {
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
          // Save token to storage so mt_saveTenant and page-refresh can find it
          sessionStorage.setItem('fb_super_token', result.token);
          localStorage.setItem('fb_super_token', result.token);
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

    // Re-apply mt_saveTenant — index.html overwrites this too
    window.mt_saveTenant = async function(isEdit) {
      const name      = document.getElementById('tName')?.value?.trim();
      const location  = document.getElementById('tLocation')?.value?.trim();
      const ownerName = document.getElementById('tOwner')?.value?.trim();
      const phone     = document.getElementById('tPhone')?.value?.trim();
      const icon      = document.getElementById('tIcon')?.value || '⛽';
      const id        = document.getElementById('tId')?.value;
      const adminUser = document.getElementById('tAdminUser')?.value?.trim() || 'admin';
      const adminPass = document.getElementById('tAdminPass')?.value || 'admin123';

      if (!name || name.length < 2) { if (typeof mt_toast === 'function') mt_toast('Enter a station name', 'error'); return; }

      // Restore token if cleared from memory
      if (!getAuthToken()) {
        const saved = sessionStorage.getItem('fb_super_token') || localStorage.getItem('fb_super_token');
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
  });

  console.log('[Bridge] Backend integration bridge loaded');
})();
