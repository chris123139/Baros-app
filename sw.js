// ═══════════════════════════════════════════════════════════════════════════
// BAROS PWA SERVICE WORKER — sw.js (version augmentée FCM)
// Ce fichier REMPLACE le sw.js existant.
// Il conserve 100% des capacités offline/cache existantes
// et ajoute la coordination avec firebase-messaging-sw.js
// © 2025 BarOS — Christophe OLOCK BELANG
// ═══════════════════════════════════════════════════════════════════════════

const SW_VERSION      = 'baros-sw-v2.1.0';
const CACHE_STATIC    = 'baros-static-v2';
const CACHE_DYNAMIC   = 'baros-dynamic-v2';
const CACHE_API       = 'baros-api-v2';
const CACHE_FONTS     = 'baros-fonts-v2';

// Ressources à mettre en cache immédiatement (app shell)
const PRECACHE_URLS = [
  '/',
  '/personnel_callsystem_fixed.html',
  '/gestionnaire_fixed_6.html',
  '/baros-push.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500&display=swap',
];

// Domaines qui ne doivent JAMAIS être mis en cache (Supabase realtime / FCM)
const NO_CACHE_PATTERNS = [
  /supabase\.co\/realtime/,
  /fcm\.googleapis\.com/,
  /firebaseinstallations\.googleapis\.com/,
  /identitytoolkit\.googleapis\.com/,
  /chrome-extension:\/\//,
];

// ═══════════════════════════════════════════════════════════════════════════
// INSTALL
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('install', event => {
  swLog('Install', SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => {
        // Précache silencieux — les erreurs n'empêchent pas l'install
        return Promise.allSettled(
          PRECACHE_URLS.map(url =>
            cache.add(url).catch(e => swLog('Précache ignoré:', url, e.message))
          )
        );
      })
      .then(() => {
        swLog('Précache terminé');
        return self.skipWaiting();
      })
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVATE — Nettoyer les anciens caches
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('activate', event => {
  swLog('Activate', SW_VERSION);
  event.waitUntil(
    Promise.all([
      // Supprimer les anciens caches BarOS
      caches.keys().then(keys =>
        Promise.all(
          keys
            .filter(k => k.startsWith('baros-') && ![CACHE_STATIC, CACHE_DYNAMIC, CACHE_API, CACHE_FONTS].includes(k))
            .map(k => { swLog('Suppression ancien cache:', k); return caches.delete(k); })
        )
      ),
      // Prendre le contrôle de tous les clients immédiatement
      clients.claim(),
    ]).then(() => swLog('SW actif et en contrôle ✓'))
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// FETCH — Stratégie de cache par type de ressource
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = req.url;

  // Ignorer les méthodes non-GET
  if (req.method !== 'GET') return;

  // Ignorer les patterns no-cache (Supabase realtime, FCM, etc.)
  if (NO_CACHE_PATTERNS.some(p => p.test(url))) return;

  // Ignorer les requêtes chrome-extension et autres schémas non-http
  if (!url.startsWith('http')) return;

  // ── Fonts Google : Cache First (immutable) ───────────────────────────────
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(req, CACHE_FONTS));
    return;
  }

  // ── CDN JS/CSS : Cache First avec fallback réseau ────────────────────────
  if (url.includes('cdn.jsdelivr.net') || url.includes('cdnjs.cloudflare.com') ||
      url.includes('gstatic.com') && !url.includes('fcm')) {
    event.respondWith(cacheFirst(req, CACHE_STATIC));
    return;
  }

  // ── API Supabase REST : Network First (données fraîches) ─────────────────
  if (url.includes('supabase.co') && !url.includes('/realtime/')) {
    event.respondWith(networkFirst(req, CACHE_API, 4000));
    return;
  }

  // ── Firebase Push / FCM : Network only (jamais cacher) ───────────────────
  if (url.includes('firebase') || url.includes('fcm.')) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }

  // ── Pages HTML BarOS : Network First avec fallback cache ─────────────────
  if (req.destination === 'document' || url.endsWith('.html')) {
    event.respondWith(networkFirst(req, CACHE_STATIC, 5000));
    return;
  }

  // ── Scripts/Styles locaux : Stale While Revalidate ───────────────────────
  if (req.destination === 'script' || req.destination === 'style') {
    event.respondWith(staleWhileRevalidate(req, CACHE_STATIC));
    return;
  }

  // ── Tout le reste : Network First ────────────────────────────────────────
  event.respondWith(networkFirst(req, CACHE_DYNAMIC, 6000));
});

// ═══════════════════════════════════════════════════════════════════════════
// STRATÉGIES DE CACHE
// ═══════════════════════════════════════════════════════════════════════════

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch(e) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(req, cacheName, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(req, { signal: controller.signal });
    clearTimeout(timer);
    if (resp.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch(e) {
    clearTimeout(timer);
    const cached = await caches.match(req);
    if (cached) return cached;
    // Fallback offline pour les pages HTML
    if (req.destination === 'document') return offlinePage();
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then(resp => {
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  }).catch(() => null);
  return cached || fetchPromise;
}

function offlinePage() {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BarOS — Hors ligne</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'DM Sans',sans-serif;
    background:#0a0a0f;color:#f0eff5;display:flex;flex-direction:column;
    align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
  .icon{font-size:64px;margin-bottom:20px}
  h1{font-size:22px;font-weight:800;margin:0 0 10px}
  p{color:rgba(240,239,245,0.5);font-size:14px;max-width:280px;line-height:1.5}
  button{margin-top:24px;padding:14px 28px;background:#7c6cff;color:#fff;
    border:none;border-radius:12px;font-size:15px;font-weight:700;
    cursor:pointer;font-family:inherit}
</style>
</head>
<body>
  <div class="icon">📡</div>
  <h1>Connexion perdue</h1>
  <p>Vérifiez votre connexion internet. BarOS tentera de se reconnecter automatiquement.</p>
  <button onclick="location.reload()">Réessayer</button>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKGROUND SYNC — Synchronisation tokens hors ligne
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('sync', event => {
  swLog('Sync event:', event.tag);

  if (event.tag === 'baros-sync-token') {
    event.waitUntil(syncPendingToken());
  }

  if (event.tag === 'baros-sync-commandes') {
    event.waitUntil(syncPendingCommandes());
  }
});

async function syncPendingToken() {
  try {
    const cache = await caches.open('baros-token-cache');
    const resp  = await cache.match('pending-token');
    if (!resp) { swLog('Aucun token en attente'); return; }

    const { token, employe_id, etab_id } = await resp.json();
    if (!token || !employe_id) return;

    // Récupérer SB_URL depuis les clients actifs
    const clientList = await clients.matchAll({ includeUncontrolled: true });
    let sbUrl = 'https://qyxdfmulrghlanetfcxy.supabase.co';
    let sbKey  = '';

    // Envoyer une demande aux clients pour avoir les clés
    for (const client of clientList) {
      try {
        // On utilise l'URL connue directement depuis le SW
        break;
      } catch(e) {}
    }

    // Appel REST direct Supabase (sans SDK)
    const res = await fetch(`${sbUrl}/rest/v1/push_tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer':       'resolution=merge-duplicates',
        'apikey':       sbKey,
        'Authorization': `Bearer ${sbKey}`,
      },
      body: JSON.stringify({
        employe_id,
        etablissement_id: etab_id,
        token,
        actif:      true,
        updated_at: new Date().toISOString(),
      }),
    });

    if (res.ok || res.status === 409 || res.status === 201) {
      await cache.delete('pending-token');
      swLog('Token synchronisé en background ✓');
    }
  } catch(e) {
    swLog('Erreur sync token background:', e.message);
    throw e; // Re-throw pour que le navigateur réessaie
  }
}

async function syncPendingCommandes() {
  try {
    const cache   = await caches.open('baros-token-cache');
    const pending = await cache.match('pending-commandes');
    if (!pending) return;
    // Logique de sync commandes hors ligne si nécessaire
    swLog('Sync commandes hors ligne...');
  } catch(e) {
    swLog('Erreur sync commandes:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PUSH EVENT — Fallback si firebase-messaging-sw.js ne capte pas
// (Ce SW ne gère les push QUE si Firebase n'est pas enregistré sur le même scope)
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('push', event => {
  // Si Firebase messaging SW est actif sur '/', il prend la priorité
  // Ce handler ne sera actif que si scope differ
  if (!event.data) return;

  let payload;
  try { payload = event.data.json(); }
  catch(e) { return; }

  // Ignorer les payloads Firebase standard (gérés par firebase-messaging-sw.js)
  if (payload.from || payload.notification) return;

  const data  = payload.data || payload;
  const title = data.titre || 'BarOS';
  const body  = data.corps || '';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:    '/icons/icon-192.png',
      badge:   '/icons/icon-72.png',
      tag:     'baros-sw-push-' + Date.now(),
      vibrate: [200, 100, 200],
      data:    { url: self.location.origin, type: data.type || 'systeme' },
    })
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION CLICK — Depuis ce SW (fallback)
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || self.location.origin;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      for (const c of cs) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGES depuis l'app
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case 'BAROS_SW_PING':
      event.source?.postMessage({ type: 'BAROS_SW_PONG', version: SW_VERSION });
      break;

    case 'BAROS_SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'BAROS_CACHE_URL':
      if (msg.url) {
        caches.open(CACHE_STATIC).then(c => c.add(msg.url)).catch(() => {});
      }
      break;

    case 'BAROS_CLEAR_CACHE':
      Promise.all([CACHE_STATIC, CACHE_DYNAMIC, CACHE_API].map(n => caches.delete(n)))
        .then(() => event.source?.postMessage({ type: 'BAROS_CACHE_CLEARED' }));
      break;

    case 'BAROS_SAVE_SB_KEYS':
      // Stocker les clés Supabase pour le background sync
      if (msg.url && msg.key) {
        caches.open('baros-token-cache').then(cache =>
          cache.put('sb-keys', new Response(JSON.stringify({ url: msg.url, key: msg.key })))
        );
      }
      break;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════════════

function swLog(...args) {
  console.log('[BarOS SW]', ...args);
}

swLog('Chargé ✓', SW_VERSION);
