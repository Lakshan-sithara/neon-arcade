/**
 * NeonArcade Offline Service Worker (`sw.js`)
 * Place this file in the root folder of your repository alongside `index.html`.
 * It caches the arcade portal, fonts, icons, and Tailwind CSS so players can
 * open and play all built-in games even with zero internet connection.
 */

const CACHE_NAME = 'neon-arcade-offline-v3.8';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    'https://cdn.tailwindcss.com',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
    'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return Promise.allSettled(
                ASSETS_TO_CACHE.map((url) => cache.add(url))
            );
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Never cache POST/GET calls to the live Cloudflare D1 database API
    if (req.url.includes('/api/db')) {
        return;
    }

    // Network-first for HTML navigation, falling back to cached index.html when offline
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                    return res;
                })
                .catch(() => caches.match('/index.html') || caches.match('/'))
        );
        return;
    }

    // Cache-first with background refresh for scripts, styles, and icons
    event.respondWith(
        caches.match(req).then((cachedResponse) => {
            const fetchPromise = fetch(req)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        const copy = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                    }
                    return networkResponse;
                })
                .catch(() => cachedResponse);

            return cachedResponse || fetchPromise;
        })
    );
});