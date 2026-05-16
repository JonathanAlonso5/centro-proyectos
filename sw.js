/**
 * Centro de Proyectos · Service Worker
 *
 * v2 (2026-05-16): cambio a network-first para HTML (/ y /index.html)
 * porque el cache-first anterior dejaba al usuario viendo versiones
 * viejas tras cada deploy. Iconos y manifest siguen cache-first
 * (no cambian con frecuencia). Datos del Drive siguen
 * stale-while-revalidate (mejor UX que esperar 1-2s).
 */
const CACHE_VERSION = 'cdp-v2';
const SHELL_CACHE = CACHE_VERSION + '-shell';
const DATA_CACHE = CACHE_VERSION + '-data';
// Solo assets estáticos que rara vez cambian — el HTML va por network-first.
const STATIC_FILES = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];
const HTML_PATHS = new Set(['/', '/index.html']);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(STATIC_FILES).catch(err => console.warn('Static precache parcial:', err)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Datos de Drive — stale-while-revalidate
  if (url.pathname.endsWith('centro-proyectos-data.json') || url.search.includes('cdp-data')) {
    e.respondWith(staleWhileRevalidate(e.request, DATA_CACHE));
    return;
  }
  // HTML — network-first (siempre intentamos versión fresca; cae a caché solo offline)
  if (HTML_PATHS.has(url.pathname) || e.request.mode === 'navigate') {
    e.respondWith(networkFirst(e.request, SHELL_CACHE));
    return;
  }
  // Assets estáticos (iconos, manifest) — cache-first
  if (STATIC_FILES.includes(url.pathname)) {
    e.respondWith(cacheFirst(e.request, SHELL_CACHE));
    return;
  }
  // Resto — network-first con fallback caché
  e.respondWith(networkFirst(e.request, SHELL_CACHE));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (e) {
    return cached || Response.error();
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(req);
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then(fresh => {
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  }).catch(() => cached);
  return cached || fetchPromise;
}

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
