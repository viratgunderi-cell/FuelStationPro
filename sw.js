/**
 * FuelBunk Pro — Service Worker v6.0
 * Strategy:
 *   - App shell (index.html, api-client.js, bridge.js): Cache-first, network fallback
 *   - API /api/public/*: Network-first, cache fallback (employee portal offline support)
 *   - API /api/data/* and /api/auth/*: Network-only (auth + data must be fresh)
 *   - Static assets (manifest, icons): Cache-first, long TTL
 */

const CACHE_NAME    = 'fuelbunk-v7';
const SHELL_CACHE   = 'fuelbunk-shell-v7';
const API_CACHE     = 'fuelbunk-api-v7';

// App shell — cache on install (split bundle: v7)
const SHELL_ASSETS = [
  '/',
  '/multitenant.js',
  '/utils.js',
  '/admin.js',
  '/employee.js',
  '/app.js',
  '/api-client.js',
  '/bridge.js',
  '/manifest.json',
];

// ── INSTALL: pre-cache app shell ────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache =>
      Promise.allSettled(SHELL_ASSETS.map(url =>
        cache.add(url).catch(e => console.warn('[SW] Shell cache miss:', url, e.message))
      ))
    ).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: delete old caches ─────────────────────────────────────────────
self.addEventListener('activate', event => {
  const KEEP = new Set([SHELL_CACHE, API_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !KEEP.has(k)).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH: routing strategy ─────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== location.origin) return;

  const path = url.pathname;

  // ── API routes ──────────────────────────────────────────────────────────
  if (path.startsWith('/api/')) {
    // Auth + data APIs: always network, never cache (must be fresh)
    if (path.startsWith('/api/auth/') || path.startsWith('/api/data/')) {
      return; // let browser handle normally
    }

    // Public employee APIs (/api/public/*): network-first, fall back to cache
    // This lets the employee portal work offline after first load
    if (path.startsWith('/api/public/') && request.method === 'GET') {
      event.respondWith(
        fetch(request.clone())
          .then(res => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(API_CACHE).then(c => c.put(request, clone));
            }
            return res;
          })
          .catch(() => caches.match(request))
      );
      return;
    }

    return; // all other API: network only
  }

  // ── App shell (HTML + JS files): cache-first, network fallback ─────────
  if (request.method === 'GET') {
    event.respondWith(
      caches.match(request).then(cached => {
        const networkFetch = fetch(request.clone()).then(res => {
          if (res.ok && (
            path === '/' ||
            path.endsWith('.js') ||
            path.endsWith('.json') ||
            path.endsWith('.png') ||
            path.endsWith('.svg')
          )) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then(c => c.put(request, clone));
          }
          return res;
        }).catch(() => null);

        // Return cached immediately if available; update in background
        return cached || networkFetch || caches.match('/');
      })
    );
  }
});

// ── BACKGROUND SYNC: retry failed sales when back online ───────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-sales') {
    event.waitUntil(syncPendingSales());
  }
});

async function syncPendingSales() {
  try {
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({ type: 'SYNC_REQUESTED' }));
  } catch (e) {
    console.warn('[SW] Sync failed:', e);
  }
}

// ── PUSH NOTIFICATIONS (future use) ────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'FuelBunk Pro', {
        body: data.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.tag || 'fuelbunk',
        data: data.url ? { url: data.url } : {},
        vibrate: [100, 50, 100],
      })
    );
  } catch (e) {}
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(wcs => {
      const existing = wcs.find(c => c.url === url && 'focus' in c);
      return existing ? existing.focus() : clients.openWindow(url);
    })
  );
});

console.log('[SW] FuelBunk Pro Service Worker v6 loaded');
