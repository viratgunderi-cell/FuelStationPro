/**
 * FuelBunk Pro — Service Worker v12
 * Strategy:
 *   - App shell (index.html, JS files, icons): Cache-first, network fallback
 *   - Chart.js (self-hosted): Pre-cached in shell — FIX F-07 (was CDN-only, failed offline)
 *   - API /api/public/*: Network-first, cache fallback (employee portal offline support)
 *   - API /api/data/compare/*: Network-first, cache fallback (compare page offline)
 *   - API /api/data/* and /api/auth/*: Network-only (auth + data must be fresh)
 *   - Static assets (manifest, icons): Cache-first, long TTL
 *   - Push notifications: Fully wired — requires VAPID subscription from server
 */

const CACHE_VERSION = 'v12';
const CACHE_NAME    = `fuelbunk-${CACHE_VERSION}`;
const SHELL_CACHE   = `fuelbunk-shell-${CACHE_VERSION}`;
const API_CACHE     = `fuelbunk-api-${CACHE_VERSION}`;

// App shell — pre-cached on install
// FIX F-07: Added /chart.min.js (self-hosted Chart.js) so charts work offline
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
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/chart.min.js',
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

  // FIX F-07: Intercept cdnjs Chart.js requests and serve from local cache
  // This means even if the CDN is unreachable, Chart.js works offline.
  if (url.hostname === 'cdnjs.cloudflare.com' && url.pathname.includes('chart')) {
    event.respondWith(
      caches.match('/chart.min.js').then(cached => {
        if (cached) return cached;
        return fetch(request.clone()).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then(c => c.put('/chart.min.js', clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // Only handle same-origin requests for other routes
  if (url.origin !== location.origin) return;

  const path = url.pathname;

  // ── API routes ──────────────────────────────────────────────────────────
  if (path.startsWith('/api/')) {
    // Auth + data APIs: always network, never cache (must be fresh)
    if (path.startsWith('/api/auth/') || path.startsWith('/api/data/')) {
      return; // let browser handle normally
    }

    // Public employee APIs (/api/public/*): network-first, fall back to cache
    // FIX #31: Stamp cache entries with a timestamp header so stale entries (>24h) are
    // not served as fresh data — forces a network refresh after 24 hours offline.
    if (path.startsWith('/api/public/') && request.method === 'GET') {
      event.respondWith(
        fetch(request.clone())
          .then(res => {
            if (res.ok) {
              const clone = res.clone();
              // Add cache timestamp for staleness check
              clone.headers && caches.open(API_CACHE).then(async c => {
                const stamped = new Response(await clone.arrayBuffer(), {
                  status: clone.status,
                  statusText: clone.statusText,
                  headers: { ...Object.fromEntries(clone.headers.entries()), 'x-sw-cached-at': Date.now().toString() },
                });
                c.put(request, stamped);
              });
            }
            return res;
          })
          .catch(async () => {
            const cached = await caches.match(request);
            if (!cached) return new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
            // FIX #31: reject cache entries older than 24 hours
            const cachedAt = parseInt(cached.headers.get('x-sw-cached-at') || '0', 10);
            if (cachedAt && (Date.now() - cachedAt) > 86400000) {
              return new Response('{"error":"offline-stale"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
            }
            return cached;
          })
      );
      return;
    }

    // Compare summary: network-first, cache fallback
    if (path.startsWith('/api/data/compare/') && request.method === 'GET') {
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

  // ── App shell (HTML + JS + assets): cache-first, network fallback ───────
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

// ── PUSH NOTIFICATIONS ──────────────────────────────────────────────────────
// Requires server-side VAPID push subscription (see /api/push/subscribe endpoint).
// Payload format: { title, body, tag, url, urgency }
self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const urgency = data.urgency || 'normal'; // 'critical' | 'high' | 'normal'
    const iconMap = {
      critical: '/icon-512.png',
      high:     '/icon-192.png',
      normal:   '/icon-192.png',
    };
    event.waitUntil(
      self.registration.showNotification(data.title || 'FuelBunk Pro', {
        body:    data.body || '',
        icon:    iconMap[urgency] || '/icon-192.png',
        badge:   '/icon-192.png',
        tag:     data.tag || 'fuelbunk',
        data:    { url: data.url || '/' },
        vibrate: urgency === 'critical' ? [200, 100, 200, 100, 200] : [100, 50, 100],
        requireInteraction: urgency === 'critical',
        actions: urgency === 'critical' ? [
          { action: 'view',    title: '📊 View Dashboard' },
          { action: 'dismiss', title: 'Dismiss' },
        ] : [],
      })
    );
  } catch (e) {
    console.warn('[SW] Push parse error:', e);
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wcs => {
      // Focus existing window if already open
      const existing = wcs.find(c => c.url.startsWith(self.registration.scope) && 'focus' in c);
      if (existing) {
        existing.focus();
        existing.postMessage({ type: 'NOTIFICATION_NAVIGATE', url });
        return;
      }
      return clients.openWindow(url);
    })
  );
});

// ── SW → Client messaging ───────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// FIX F-08: Version string now matches CACHE_VERSION constant
console.log(`[SW] FuelBunk Pro Service Worker ${CACHE_VERSION} loaded`);
