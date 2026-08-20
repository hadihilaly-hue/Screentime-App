// Minimal PWA service worker: makes the app installable and lets it open
// offline. No build-time manifest, so hashed assets under /assets/ are cached
// as they are first fetched rather than precached.
const CACHE = 'earnedtime-v2'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/'])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Navigations: network first, fall back to the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/').then((r) => r || Response.error())))
    return
  }

  // Static assets: serve from cache when present, otherwise fetch and store so
  // the bundle is available on the next offline load.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        }),
    ),
  )
})
