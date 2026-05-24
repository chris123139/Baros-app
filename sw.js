/**
 * BarOS — Service Worker PWA
 * Stratégie : Cache-first pour assets statiques, Network-first pour pages,
 *             Bypass total pour Supabase (realtime + données).
 */

const CACHE_NAME = 'baros-v1';
const CACHE_CDN  = 'baros-cdn-v1';

// ── Pages et assets locaux à mettre en cache dès l'installation ──
const PRECACHE_URLS = [
  './gestionnaire.html',
  './personnel.html',
  './pointage.html',
  './offline.html',
  './table.html',
  './manifest-manager.json',
  './manifest-serveuse.json',
  './manifest-pointage.json',
  './icons/icon-manager.svg',
  './icons/icon-personnel.svg',
  './icons/icon-pointage.svg',
];

// ── CDN externes : mis en cache lors du premier chargement ──
const CDN_ORIGINS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// ── Domaines à NE JAMAIS mettre en cache (Supabase temps réel + données) ──
// On laisse passer directement vers le réseau.
const BYPASS_HOSTNAMES = [
  'supabase.co',      // data API + realtime websocket
  'notchpay.co',      // SMS gateway
];

// ────────────────────────────────────────────────────────────────
// INSTALL : précache des assets locaux
// ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(
        PRECACHE_URLS.map(u => new Request(u, { cache: 'reload' }))
      ))
      .then(() => self.skipWaiting())
      .catch(err => {
        // Certains fichiers peuvent être absents au déploiement initial — pas bloquant
        console.warn('[SW] Precache partiel :', err.message);
        return self.skipWaiting();
      })
  );
});

// ────────────────────────────────────────────────────────────────
// ACTIVATE : nettoyage des anciens caches
// ────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  const VALID_CACHES = [CACHE_NAME, CACHE_CDN];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => !VALID_CACHES.includes(k))
          .map(k => {
            console.log('[SW] Suppression ancien cache :', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())
  );
});

// ────────────────────────────────────────────────────────────────
// FETCH : routage intelligent des requêtes
// ────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. WebSockets → bypass total (Service Worker ne gère pas WS)
  if (req.url.startsWith('ws://') || req.url.startsWith('wss://')) return;

  // 2. Méthodes non-GET → réseau direct (POST, PUT, DELETE…)
  if (req.method !== 'GET') return;

  // 3. Supabase et autres services tiers critiques → réseau direct, jamais mis en cache
  if (BYPASS_HOSTNAMES.some(h => url.hostname.includes(h))) return;

  // 4. Scripts/polices CDN → Cache-first (CDN)
  if (CDN_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(cdnCacheFirst(req));
    return;
  }

  // 5. Pages HTML locales → Network-first avec fallback offline
  if (req.destination === 'document' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(networkFirstWithFallback(req));
    return;
  }

  // 6. Autres assets locaux (SVG, JSON, images…) → Cache-first local
  if (url.origin === self.location.origin) {
    event.respondWith(localCacheFirst(req));
    return;
  }

  // 7. Tout le reste → réseau direct
});

// ────────────────────────────────────────────────────────────────
// STRATÉGIES
// ────────────────────────────────────────────────────────────────

/**
 * Network-first : essaie le réseau, met à jour le cache, retourne le cache si offline.
 * Fallback vers offline.html si rien disponible.
 */
async function networkFirstWithFallback(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const networkResp = await fetch(req);
    if (networkResp.ok) {
      cache.put(req, networkResp.clone()); // mise à jour silencieuse
    }
    return networkResp;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Fallback : page offline
    const offline = await cache.match('./offline.html');
    return offline || new Response(
      '<h1 style="font-family:sans-serif;text-align:center;padding:40px;color:#c8f55a;background:#0a0a0f;min-height:100vh">BarOS — Hors ligne</h1>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}

/**
 * Cache-first local : retourne depuis le cache si présent, sinon réseau + mise en cache.
 */
async function localCacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const networkResp = await fetch(req);
    if (networkResp.ok) cache.put(req, networkResp.clone());
    return networkResp;
  } catch {
    return new Response('', { status: 503 });
  }
}

/**
 * Cache-first CDN : cache long-terme pour scripts externes.
 * Une fois mis en cache, ils ne sont plus rechargés (CDN = immutable).
 */
async function cdnCacheFirst(req) {
  const cache = await caches.open(CACHE_CDN);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const networkResp = await fetch(req);
    if (networkResp.ok) cache.put(req, networkResp.clone());
    return networkResp;
  } catch {
    return new Response('', { status: 503 });
  }
}

// ────────────────────────────────────────────────────────────────
// MESSAGE : forcer la mise à jour du SW depuis l'app
// ────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});
