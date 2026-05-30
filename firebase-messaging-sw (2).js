// ═══════════════════════════════════════════════════════════════════════════
// BAROS FCM SERVICE WORKER — firebase-messaging-sw.js
// Push notifications background / app fermée / écran verrouillé
// Compatible Android 8-16, PWA, Chrome, Samsung Internet
// © 2025 BarOS — Christophe OLOCK BELANG
// ═══════════════════════════════════════════════════════════════════════════

// ── IMPORTANT : Remplacer ces valeurs par vos vraies clés Firebase ──────────
// Récupérez-les dans : console.firebase.google.com → Votre projet → Paramètres
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAELieBHaYW4nWgExPNaOqIbj_-MiDhFsM",           // Paramètres → Général
  authDomain:        "baros-4f726.firebaseapp.com",
  projectId:         "baros-4f726",
  storageBucket:     "baros-4f726.firebasestorage.app",
  messagingSenderId: "504412631235",         // Paramètres → Cloud Messaging
  appId:             "1:504412631235:web:8a88a1c56a4c180fd6f276"
};

// ── Import Firebase compat (obligatoire en SW) ───────────────────────────────
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ── Init Firebase ─────────────────────────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const messaging = firebase.messaging();

// ── Constantes ────────────────────────────────────────────────────────────────
const SW_VERSION    = 'baros-push-v1.0.0';
const APP_URL       = self.location.origin;
const ICON_DEFAULT  = '/icons/icon-192.png';
const BADGE_ICON    = '/icons/icon-72.png';

// ── Mapping icônes & couleurs par type de notification ───────────────────────
const NOTIF_CONFIG = {
  commande:    { icon: '🍽️', color: '#ffb444', vibrate: [200,100,200],         channel: 'commandes'  },
  appel:       { icon: '🔔', color: '#7c6cff', vibrate: [300,100,300,100,300], channel: 'appels'     },
  pret:        { icon: '✅', color: '#4ade80', vibrate: [100,50,100],           channel: 'pret'       },
  addition:    { icon: '💰', color: '#c8f55a', vibrate: [200,100,200,100,200], channel: 'additions'  },
  client:      { icon: '👤', color: '#5ab4ff', vibrate: [100,100,100],          channel: 'clients'    },
  validation:  { icon: '✔️', color: '#4ade80', vibrate: [150],                  channel: 'validation' },
  alerte:      { icon: '🚨', color: '#ff5e5e', vibrate: [500,200,500,200,500], channel: 'securite'   },
  message:     { icon: '💬', color: '#5ab4ff', vibrate: [100,50,100],           channel: 'messages'   },
  pointage:    { icon: '⏰', color: '#ffb444', vibrate: [200],                  channel: 'pointages'  },
  systeme:     { icon: 'ℹ️', color: '#7c6cff', vibrate: [100],                  channel: 'systeme'    },
};

// ── Anti-spam : IDs déjà notifiés (en mémoire SW) ───────────────────────────
const _notifiedIds = new Set();

// ── Utilitaire : logguer proprement ──────────────────────────────────────────
function swLog(msg, data) {
  const prefix = `[BarOS SW ${SW_VERSION}]`;
  if (data !== undefined) console.log(prefix, msg, data);
  else                    console.log(prefix, msg);
}

// ═══════════════════════════════════════════════════════════════════════════
// INSTALL & ACTIVATE — Cycle de vie Service Worker
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('install', event => {
  swLog('Installation SW push');
  // Activer immédiatement sans attendre la fermeture des anciens clients
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  swLog('Activation SW push');
  event.waitUntil(
    clients.claim().then(() => swLog('SW en contrôle de tous les clients'))
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// RÉCEPTION NOTIFICATION BACKGROUND (app fermée / arrière-plan)
// Firebase gère automatiquement si payload a notification{}
// Ce handler prend le relais pour les data-only payloads et le custom UX
// ═══════════════════════════════════════════════════════════════════════════

messaging.onBackgroundMessage(payload => {
  swLog('Message background reçu', payload);

  const data    = payload.data || {};
  const notifId = data.notif_id || data.commande_id || data.appel_id || String(Date.now());

  // Anti-doublon
  if (_notifiedIds.has(notifId)) {
    swLog('Doublon ignoré', notifId);
    return;
  }
  _notifiedIds.add(notifId);
  // Nettoyer le Set après 60s pour éviter les memory leaks
  setTimeout(() => _notifiedIds.delete(notifId), 60000);

  const type   = data.type || 'systeme';
  const cfg    = NOTIF_CONFIG[type] || NOTIF_CONFIG.systeme;
  const title  = payload.notification?.title || data.titre  || 'BarOS';
  const body   = payload.notification?.body  || data.corps  || '';

  // Construction des actions rapides selon le type
  const actions = buildActions(type, data);

  const options = {
    body,
    icon:              ICON_DEFAULT,
    badge:             BADGE_ICON,
    vibrate:           cfg.vibrate,
    tag:               `baros-${type}-${notifId}`,   // regroupement par type
    renotify:          true,                          // re-vibre même si tag identique
    requireInteraction: ['appel','alerte','addition'].includes(type), // reste jusqu'au clic
    silent:            false,
    data: {
      url:         data.url     || APP_URL,
      type,
      notif_id:    notifId,
      etab_id:     data.etab_id || '',
      employe_id:  data.employe_id || '',
      payload_raw: JSON.stringify(data),
    },
    actions,
    // Android : couleur LED + barre de statut
    ...(data.color ? { } : {}), // Chrome ne supporte pas encore color nativement
  };

  return self.registration.showNotification(title, options);
});

// ═══════════════════════════════════════════════════════════════════════════
// CLIC SUR NOTIFICATION
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('notificationclick', event => {
  swLog('Clic notification', { action: event.action, data: event.notification.data });

  event.notification.close();

  const data      = event.notification.data || {};
  const action    = event.action;
  const targetUrl = resolveClickUrl(data, action);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Chercher un onglet BarOS déjà ouvert
      for (const client of clientList) {
        if (client.url.startsWith(APP_URL) && 'focus' in client) {
          // Envoyer un message à l'app pour qu'elle navigue
          client.postMessage({
            type:       'BAROS_NOTIF_CLICK',
            notifType:  data.type,
            action,
            payload:    data.payload_raw ? JSON.parse(data.payload_raw) : data,
          });
          return client.focus();
        }
      }
      // Aucun onglet ouvert → ouvrir l'app
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// FERMETURE DE NOTIFICATION (swipe)
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('notificationclose', event => {
  swLog('Notification fermée par l\'utilisateur', event.notification.tag);
});

// ═══════════════════════════════════════════════════════════════════════════
// PUSH EVENT (fallback pour payloads non-FCM ou si Firebase rate le payload)
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('push', event => {
  if (!event.data) { swLog('Push vide ignoré'); return; }

  let payload;
  try { payload = event.data.json(); }
  catch(e) { payload = { data: { titre: 'BarOS', corps: event.data.text() } }; }

  // Si Firebase a déjà géré via onBackgroundMessage, ne pas doubler
  if (payload.from && payload.notification) {
    swLog('Payload FCM standard — géré par onBackgroundMessage');
    return;
  }

  swLog('Push non-FCM reçu', payload);
  const data   = payload.data || payload;
  const type   = data.type || 'systeme';
  const cfg    = NOTIF_CONFIG[type] || NOTIF_CONFIG.systeme;
  const title  = data.titre || 'BarOS';
  const body   = data.corps || '';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:    ICON_DEFAULT,
      badge:   BADGE_ICON,
      vibrate: cfg.vibrate,
      tag:     `baros-${type}-${Date.now()}`,
      data:    { url: APP_URL, type, payload_raw: JSON.stringify(data) },
      actions: buildActions(type, data),
    })
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// BACKGROUND SYNC — Synchroniser tokens si hors-ligne au moment de l'enregistrement
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('sync', event => {
  if (event.tag === 'baros-sync-token') {
    swLog('Background sync token');
    event.waitUntil(syncTokenFromCache());
  }
});

async function syncTokenFromCache() {
  try {
    const cache = await caches.open('baros-token-cache');
    const resp  = await cache.match('pending-token');
    if (!resp) return;
    const { token, employe_id, etab_id } = await resp.json();
    // Appel Supabase Edge Function pour sauvegarder le token
    await fetch(`${APP_URL}/api/save-push-token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token, employe_id, etab_id }),
    });
    await cache.delete('pending-token');
    swLog('Token synchronisé depuis cache');
  } catch(e) {
    swLog('Échec sync token', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGES depuis l'app principale (postMessage)
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'BAROS_SW_PING':
      event.source?.postMessage({ type: 'BAROS_SW_PONG', version: SW_VERSION });
      break;

    case 'BAROS_SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'BAROS_SHOW_NOTIF':
      // L'app demande au SW d'afficher une notif locale (foreground amélioré)
      showLocalNotif(msg.payload);
      break;

    case 'BAROS_CLEAR_BADGE':
      // Vider le badge (non supporté partout, graceful)
      if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
      break;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function buildActions(type, data) {
  const actions = [];
  switch (type) {
    case 'commande':
      actions.push({ action: 'voir',      title: '👁 Voir'       });
      actions.push({ action: 'confirmer', title: '✅ Confirmer'  });
      break;
    case 'appel':
      actions.push({ action: 'prendre',   title: '🙋 Prendre en charge' });
      actions.push({ action: 'voir',      title: '👁 Voir'              });
      break;
    case 'addition':
      actions.push({ action: 'imprimer',  title: '🖨️ Imprimer'  });
      actions.push({ action: 'voir',      title: '👁 Voir'       });
      break;
    case 'alerte':
      actions.push({ action: 'accuser',   title: '✔️ Accusé'    });
      break;
    case 'message':
      actions.push({ action: 'repondre',  title: '↩️ Répondre'  });
      break;
    case 'pret':
      actions.push({ action: 'livrer',    title: '🚀 Marquer livré' });
      break;
    default:
      actions.push({ action: 'voir',      title: '👁 Ouvrir'    });
  }
  return actions.slice(0, 2); // Chrome limite à 2 actions
}

function resolveClickUrl(data, action) {
  if (data.url && data.url !== APP_URL) return data.url;
  const base = APP_URL;
  switch (data.type) {
    case 'commande': return `${base}/personnel_callsystem_fixed.html#commandes`;
    case 'appel':    return `${base}/personnel_callsystem_fixed.html#appels`;
    case 'addition': return `${base}/personnel_callsystem_fixed.html#appels`;
    case 'alerte':   return `${base}/gestionnaire_fixed_6.html#alertes`;
    case 'message':  return `${base}/personnel_callsystem_fixed.html#messages`;
    default:         return base;
  }
}

async function showLocalNotif(payload) {
  if (!payload) return;
  const type = payload.type || 'systeme';
  const cfg  = NOTIF_CONFIG[type] || NOTIF_CONFIG.systeme;
  await self.registration.showNotification(payload.titre || 'BarOS', {
    body:    payload.corps || '',
    icon:    ICON_DEFAULT,
    badge:   BADGE_ICON,
    vibrate: cfg.vibrate,
    tag:     `baros-local-${type}-${Date.now()}`,
    data:    { url: APP_URL, type, payload_raw: JSON.stringify(payload) },
    actions: buildActions(type, payload),
  });
}

swLog('Service Worker chargé ✓', SW_VERSION);
