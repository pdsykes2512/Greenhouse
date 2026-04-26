// Greenhouse PWA service worker
// - App-shell cache for offline use
// - Network-first for /api/* (always try fresh data)
// - Cache-first for static assets
// - Web Push handler for important events

const VERSION = 'v2';
const SHELL_CACHE = `gh-shell-${VERSION}`;

const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/app.js',
    '/manifest.json',
    '/icon-192.svg',
    '/icon-512.svg',
    '/icon-maskable.svg'
];

// ─── Install: precache app shell ──────────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS))
    );
    self.skipWaiting();
});

// ─── Activate: clear old caches and force-reload any controlled pages ───────
// When a new SW version takes over (via skipWaiting + claim), the page that's
// already loaded is still running the OLD code. Tell every controlled client
// to reload so they pick up the fresh assets immediately.
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k)));
        await self.clients.claim();
        const clients = await self.clients.matchAll({ type: 'window' });
        clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
    })());
});

// ─── Fetch: network-first for everything, fall back to cache when offline ─────
// (Cache-first was causing app.js/index.html updates not to take effect even
// after the user reloaded the page. Network-first keeps the PWA "live" while
// still letting the cache serve the app shell when offline.)
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    // SSE stream — never intercept; always pass through to the network.
    if (url.pathname === '/api/events') return;

    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then(resp => {
                if (resp.ok) {
                    const clone = resp.clone();
                    caches.open(SHELL_CACHE).then(c => c.put(event.request, clone));
                }
                return resp;
            })
            .catch(() => caches.match(event.request))
    );
});

// ─── Push: show a notification ────────────────────────────────────────────────
self.addEventListener('push', event => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (_) {
        data = { title: 'Greenhouse', body: event.data?.text() || '' };
    }

    const title = data.title || 'Greenhouse';
    const options = {
        body: data.body || '',
        icon: '/icon-192.svg',
        badge: '/icon-192.svg',
        tag: data.tag || 'greenhouse-event',  // dedup similar notifications
        renotify: data.renotify ?? false,
        requireInteraction: data.requireInteraction ?? false,
        data: { url: data.url || '/' }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

// ─── Notification click: focus or open the app ────────────────────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            for (const c of list) {
                if (c.url.includes(self.location.origin) && 'focus' in c) {
                    c.navigate(url);
                    return c.focus();
                }
            }
            return clients.openWindow(url);
        })
    );
});
