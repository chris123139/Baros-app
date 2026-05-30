// ═══════════════════════════════════════════════════════════════════════════
// BAROS PUSH NOTIFICATIONS MODULE — baros-push.js
// Module complet : FCM tokens, permissions, foreground, anti-spam, UI premium
// À inclure dans personnel_callsystem_fixed.html ET gestionnaire_fixed_6.html
// © 2025 BarOS — Christophe OLOCK BELANG
// ═══════════════════════════════════════════════════════════════════════════

// ── CONFIGURATION FIREBASE ───────────────────────────────────────────────────
// ⚠️  Remplacer par vos vraies clés (console.firebase.google.com)
const BAROS_FCM_CONFIG = {
  apiKey:            "VOTRE_API_KEY",
  authDomain:        "VOTRE_PROJECT.firebaseapp.com",
  projectId:         "VOTRE_PROJECT_ID",
  storageBucket:     "VOTRE_PROJECT.appspot.com",
  messagingSenderId: "VOTRE_SENDER_ID",
  appId:             "VOTRE_APP_ID",
  // VAPID Key : Paramètres Firebase → Cloud Messaging → Certificats push Web
  vapidKey:          "VOTRE_VAPID_KEY_LONGUE_CLÉ",
};

// ── ÉTAT GLOBAL MODULE ───────────────────────────────────────────────────────
const BarOSPush = {
  initialized:    false,
  fcmToken:       null,
  messaging:      null,
  swRegistration: null,
  employeId:      null,
  etabId:         null,
  role:           null,
  _dedupeSet:     new Set(),
  _lastTokenSave: 0,
  _permModalOpen: false,
};

// ── MAPPING NOTIFICATIONS ─────────────────────────────────────────────────────
const PUSH_TYPES = {
  commande:   { emoji:'🍽️', label:'Nouvelle commande',    color:'#ffb444', sound:true  },
  appel:      { emoji:'🔔', label:'Appel serveuse',        color:'#7c6cff', sound:true  },
  pret:       { emoji:'✅', label:'Commande prête',        color:'#4ade80', sound:true  },
  addition:   { emoji:'💰', label:'Demande d\'addition',   color:'#c8f55a', sound:true  },
  client:     { emoji:'👤', label:'Nouveau client',        color:'#5ab4ff', sound:false },
  validation: { emoji:'✔️', label:'Validation manager',   color:'#4ade80', sound:false },
  alerte:     { emoji:'🚨', label:'Alerte sécurité',       color:'#ff5e5e', sound:true  },
  message:    { emoji:'💬', label:'Message interne',       color:'#5ab4ff', sound:false },
  pointage:   { emoji:'⏰', label:'Pointage oublié',       color:'#ffb444', sound:false },
  systeme:    { emoji:'ℹ️', label:'Notification système',  color:'#7c6cff', sound:false },
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. INITIALISATION PRINCIPALE
// ═══════════════════════════════════════════════════════════════════════════

async function barosPushInit(employeId, etabId, role) {
  if (BarOSPush.initialized) return;
  BarOSPush.employeId = employeId;
  BarOSPush.etabId    = etabId;
  BarOSPush.role      = role || 'serveuse';

  pushLog('Init push module', { employeId, etabId, role });

  // Vérifier support navigateur
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    pushLog('Push non supporté sur ce navigateur');
    return;
  }

  try {
    // Charger Firebase dynamiquement (évite les conflits si déjà chargé)
    await barosLoadFirebase();

    // Enregistrer le SW de messaging (distinct du SW PWA existant)
    BarOSPush.swRegistration = await barosRegisterMessagingSW();
    if (!BarOSPush.swRegistration) return;

    // Initialiser Firebase Messaging
    BarOSPush.messaging = firebase.messaging();
    BarOSPush.initialized = true;

    // Écouter messages du SW (clics depuis background)
    navigator.serviceWorker.addEventListener('message', barosHandleSWMessage);

    // Vérifier permission existante
    const perm = Notification.permission;
    if (perm === 'granted') {
      await barosGetAndSaveToken();
      barosSetupForeground();
    } else if (perm === 'default') {
      // Afficher UI de demande avec délai (UX : laisser l'app se charger)
      setTimeout(() => barosShowPermissionModal(), 2500);
    } else {
      pushLog('Permission refusée — notifications désactivées');
      barosShowPermDeniedBadge();
    }

    // Rafraîchir le token périodiquement
    setInterval(barosRefreshToken, 12 * 60 * 60 * 1000); // toutes les 12h

    pushLog('Module push initialisé ✓');
  } catch(e) {
    pushLog('Erreur init push', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. CHARGEMENT FIREBASE (lazy, évite le double import)
// ═══════════════════════════════════════════════════════════════════════════

async function barosLoadFirebase() {
  if (typeof firebase !== 'undefined' && firebase.messaging) {
    pushLog('Firebase déjà chargé');
    return;
  }

  // Charger firebase-app + firebase-messaging via CDN
  await Promise.all([
    barosLoadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js'),
    barosLoadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js'),
  ]);

  // Éviter double initApp
  if (!firebase.apps?.length) {
    firebase.initializeApp(BAROS_FCM_CONFIG);
  }
  pushLog('Firebase chargé et initialisé');
}

function barosLoadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s    = document.createElement('script');
    s.src      = src;
    s.onload   = resolve;
    s.onerror  = reject;
    document.head.appendChild(s);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. ENREGISTREMENT SERVICE WORKER MESSAGING
// ═══════════════════════════════════════════════════════════════════════════

async function barosRegisterMessagingSW() {
  try {
    // Chercher si firebase-messaging-sw.js est déjà enregistré
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) {
      if (reg.scope.includes(location.origin) &&
          (reg.active?.scriptURL?.includes('firebase-messaging-sw') ||
           reg.installing?.scriptURL?.includes('firebase-messaging-sw') ||
           reg.waiting?.scriptURL?.includes('firebase-messaging-sw'))) {
        pushLog('SW messaging déjà enregistré', reg.scope);
        return reg;
      }
    }
    // Enregistrer le SW FCM (fichier à la racine du site)
    const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
      scope: '/',
    });
    pushLog('SW messaging enregistré', reg.scope);
    return reg;
  } catch(e) {
    pushLog('Erreur enregistrement SW messaging', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. OBTENIR ET SAUVEGARDER LE TOKEN FCM
// ═══════════════════════════════════════════════════════════════════════════

async function barosGetAndSaveToken() {
  try {
    if (!BarOSPush.messaging) return;

    const token = await firebase.messaging().getToken({
      vapidKey:            BAROS_FCM_CONFIG.vapidKey,
      serviceWorkerRegistration: BarOSPush.swRegistration,
    });

    if (!token) { pushLog('Token FCM vide'); return; }

    // Éviter des saves inutiles si token identique
    if (token === BarOSPush.fcmToken && Date.now() - BarOSPush._lastTokenSave < 3600000) {
      pushLog('Token identique, pas de re-save');
      return;
    }

    BarOSPush.fcmToken    = token;
    BarOSPush._lastTokenSave = Date.now();
    pushLog('Token FCM obtenu', token.slice(0, 20) + '...');

    await barosSaveTokenToSupabase(token);

  } catch(e) {
    pushLog('Erreur obtention token', e.message);
    // Si token révoqué, demander à nouveau
    if (e.code === 'messaging/token-unsubscribe-failed' ||
        e.message?.includes('registration')) {
      BarOSPush.fcmToken = null;
      setTimeout(barosGetAndSaveToken, 5000);
    }
  }
}

async function barosSaveTokenToSupabase(token) {
  if (!BarOSPush.employeId || !BarOSPush.etabId) return;
  if (typeof db === 'undefined') return;

  const deviceInfo = barosGetDeviceInfo();

  try {
    // Upsert : met à jour si token existe déjà pour cet employé+appareil
    const { error } = await db.from('push_tokens').upsert({
      employe_id:       BarOSPush.employeId,
      etablissement_id: BarOSPush.etabId,
      token,
      plateforme:       deviceInfo.plateforme,
      appareil:         deviceInfo.appareil,
      role:             BarOSPush.role,
      actif:            true,
      updated_at:       new Date().toISOString(),
    }, {
      onConflict: 'employe_id,token',
    });

    if (error) {
      // Si la colonne onConflict ne marche pas, essayer insert/update séparé
      pushLog('Upsert token — tentative fallback', error.message);
      await barosSaveTokenFallback(token, deviceInfo);
    } else {
      pushLog('Token sauvegardé dans Supabase ✓');
      localStorage.setItem('baros_push_token', token);
    }
  } catch(e) {
    pushLog('Erreur save token Supabase', e.message);
    // Mettre en cache pour Background Sync
    await barosCacheTokenForSync(token);
  }
}

async function barosSaveTokenFallback(token, deviceInfo) {
  // Chercher token existant
  const { data: existing } = await db.from('push_tokens')
    .select('id')
    .eq('employe_id', BarOSPush.employeId)
    .eq('token', token)
    .maybeSingle();

  if (existing) {
    await db.from('push_tokens').update({
      actif:      true,
      updated_at: new Date().toISOString(),
      role:       BarOSPush.role,
    }).eq('id', existing.id);
  } else {
    await db.from('push_tokens').insert({
      employe_id:       BarOSPush.employeId,
      etablissement_id: BarOSPush.etabId,
      token,
      plateforme:       deviceInfo.plateforme,
      appareil:         deviceInfo.appareil,
      role:             BarOSPush.role,
      actif:            true,
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    });
  }
  localStorage.setItem('baros_push_token', token);
  pushLog('Token sauvegardé via fallback ✓');
}

async function barosCacheTokenForSync(token) {
  try {
    const cache = await caches.open('baros-token-cache');
    await cache.put('pending-token', new Response(JSON.stringify({
      token,
      employe_id: BarOSPush.employeId,
      etab_id:    BarOSPush.etabId,
    })));
    // Déclencher Background Sync
    if (BarOSPush.swRegistration?.sync) {
      await BarOSPush.swRegistration.sync.register('baros-sync-token');
    }
    pushLog('Token mis en cache pour sync ultérieure');
  } catch(e) {
    pushLog('Erreur cache token', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. RAFRAÎCHISSEMENT TOKEN (rotation FCM)
// ═══════════════════════════════════════════════════════════════════════════

async function barosRefreshToken() {
  if (Notification.permission !== 'granted') return;
  pushLog('Rafraîchissement token...');
  await barosGetAndSaveToken();
}

// Écouter le changement de token côté Firebase (rotation automatique)
function barosWatchTokenRefresh() {
  if (!BarOSPush.messaging) return;
  // onTokenRefresh est déprécié en v9+, on utilise getToken périodiquement
  // Déjà géré par setInterval dans barosPushInit
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. RÉCEPTION FOREGROUND (app ouverte)
// ═══════════════════════════════════════════════════════════════════════════

function barosSetupForeground() {
  if (!BarOSPush.messaging) return;

  firebase.messaging().onMessage(payload => {
    pushLog('Message foreground reçu', payload);

    const data    = payload.data || {};
    const notifId = data.notif_id || data.commande_id || String(Date.now());

    // Anti-spam : ignorer les doublons
    if (BarOSPush._dedupeSet.has(notifId)) return;
    BarOSPush._dedupeSet.add(notifId);
    setTimeout(() => BarOSPush._dedupeSet.delete(notifId), 30000);

    const type  = data.type || 'systeme';
    const cfg   = PUSH_TYPES[type] || PUSH_TYPES.systeme;
    const titre = payload.notification?.title || data.titre || 'BarOS';
    const corps = payload.notification?.body  || data.corps || '';

    // 1. Toast BarOS premium (toujours affiché)
    barosShowPushToast(titre, corps, type, cfg);

    // 2. Son natif si actif
    if (cfg.sound) barosPushSound(type);

    // 3. Vibration
    barosVibrate(type);

    // 4. Badge app
    barosUpdateBadge(type);

    // 5. Notification système via SW (même en foreground, pour la persistance)
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type:    'BAROS_SHOW_NOTIF',
        payload: { type, titre, corps, ...data },
      });
    }

    // 6. Déclencher refresh UI si pertinent
    barosTriggerUIRefresh(type, data);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. MESSAGES DU SERVICE WORKER (clics depuis background)
// ═══════════════════════════════════════════════════════════════════════════

function barosHandleSWMessage(event) {
  const msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'BAROS_NOTIF_CLICK':
      pushLog('Clic notification background', msg);
      barosTriggerUIRefresh(msg.notifType, msg.payload);
      // Naviguer vers le bon onglet selon le type
      barosNavigateToType(msg.notifType);
      break;

    case 'BAROS_SW_PONG':
      pushLog('SW actif, version', msg.version);
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. TOAST PUSH PREMIUM (affiché dans l'app)
// ═══════════════════════════════════════════════════════════════════════════

function barosShowPushToast(titre, corps, type, cfg) {
  // Supprimer un toast existant du même type
  const existing = document.getElementById('baros-push-toast-' + type);
  if (existing) existing.remove();

  const el      = document.createElement('div');
  el.id         = 'baros-push-toast-' + type;
  el.className  = 'baros-push-toast';
  el.setAttribute('role', 'alert');
  el.innerHTML  = `
    <div class="bpt-accent" style="background:${cfg.color}"></div>
    <div class="bpt-icon">${cfg.emoji}</div>
    <div class="bpt-content">
      <div class="bpt-titre">${barosEscape(titre)}</div>
      ${corps ? `<div class="bpt-corps">${barosEscape(corps)}</div>` : ''}
    </div>
    <button class="bpt-close" onclick="this.parentElement.remove()">✕</button>
  `;

  // Clic sur le toast → naviguer
  el.addEventListener('click', (e) => {
    if (e.target.classList.contains('bpt-close')) return;
    barosNavigateToType(type);
    el.remove();
  });

  document.body.appendChild(el);

  // Animation entrée
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('bpt-show'));
  });

  // Auto-disparition
  const duration = ['alerte', 'appel', 'addition'].includes(type) ? 8000 : 5000;
  setTimeout(() => {
    el.classList.remove('bpt-show');
    setTimeout(() => el.remove(), 400);
  }, duration);
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. SONS (Web Audio API — sans fichier externe)
// ═══════════════════════════════════════════════════════════════════════════

const _audioCtxCache = {};

function barosPushSound(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();

    const patterns = {
      commande: [[880,0],[1100,0.2],[880,0.4]],
      appel:    [[1200,0],[900,0.25],[1200,0.5],[900,0.75]],
      pret:     [[660,0],[880,0.2],[1100,0.4]],
      addition: [[800,0],[1000,0.2],[800,0.35]],
      alerte:   [[1400,0],[1400,0.2],[1400,0.4],[1400,0.6]],
      message:  [[880,0],[1100,0.18]],
      default:  [[880,0],[1100,0.2]],
    };

    const pattern = patterns[type] || patterns.default;

    pattern.forEach(([freq, t]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = type === 'alerte' ? 'square' : 'sine';
      gain.gain.setValueAtTime(0, ctx.currentTime + t);
      gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + t + 0.03);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + t + 0.18);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.22);
    });

    setTimeout(() => ctx.close(), 3000);
  } catch(e) {
    pushLog('Son push non disponible', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. VIBRATION
// ═══════════════════════════════════════════════════════════════════════════

function barosVibrate(type) {
  if (!navigator.vibrate) return;
  const patterns = {
    commande: [200,100,200],
    appel:    [300,100,300,100,300],
    pret:     [100,50,100],
    addition: [200,100,200,100,200],
    alerte:   [500,200,500,200,500],
    message:  [100,50,100],
    default:  [200],
  };
  navigator.vibrate(patterns[type] || patterns.default);
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. BADGE APPLICATIF
// ═══════════════════════════════════════════════════════════════════════════

let _badgeCount = 0;

function barosUpdateBadge(type) {
  _badgeCount++;
  if ('setAppBadge' in navigator) {
    navigator.setAppBadge(_badgeCount).catch(() => {});
  }
  // Mettre à jour les badges internes BarOS si la fonction existe
  if (typeof updateBadges === 'function') updateBadges();
}

function barosClearBadge() {
  _badgeCount = 0;
  if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'BAROS_CLEAR_BADGE' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. NAVIGATION SELON TYPE
// ═══════════════════════════════════════════════════════════════════════════

function barosNavigateToType(type) {
  switch (type) {
    case 'commande':
    case 'pret':
      // Personnel → onglet commande
      if (typeof showTab === 'function') showTab('commande');
      break;
    case 'appel':
    case 'addition':
    case 'message':
      if (typeof showTab === 'function') showTab('appels');
      break;
    case 'alerte':
      // Gestionnaire → alertes
      if (typeof loadAlertesPage === 'function') loadAlertesPage();
      if (typeof navTo === 'function') navTo('pg-alertes');
      break;
    case 'pointage':
      if (typeof navTo === 'function') navTo('pg-pointages');
      break;
    default:
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 13. REFRESH UI SELON TYPE
// ═══════════════════════════════════════════════════════════════════════════

function barosTriggerUIRefresh(type, data) {
  switch (type) {
    case 'commande':
      if (typeof loadCommandes === 'function')     loadCommandes();
      if (typeof refreshCA === 'function')          refreshCA();
      if (typeof renderDash === 'function')         renderDash();
      break;
    case 'appel':
    case 'addition':
      if (typeof loadAppels === 'function')         loadAppels();
      if (typeof updateAppelsBadge === 'function')  updateAppelsBadge();
      if (typeof loadAppelsMgr === 'function')      loadAppelsMgr();
      break;
    case 'pret':
      if (typeof loadCommandes === 'function')      loadCommandes();
      break;
    case 'alerte':
      if (typeof updateBadges === 'function')       updateBadges();
      if (typeof renderDash === 'function')         renderDash();
      break;
    case 'pointage':
      if (typeof loadPointages === 'function')      loadPointages();
      break;
    default:
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 14. MODAL DEMANDE PERMISSION (UI premium)
// ═══════════════════════════════════════════════════════════════════════════

function barosShowPermissionModal() {
  if (BarOSPush._permModalOpen) return;
  if (Notification.permission === 'granted') return;
  if (document.getElementById('baros-perm-modal')) return;

  BarOSPush._permModalOpen = true;

  const modal = document.createElement('div');
  modal.id    = 'baros-perm-modal';
  modal.innerHTML = `
    <div class="bpm-overlay" id="bpm-overlay">
      <div class="bpm-card" id="bpm-card" role="dialog" aria-modal="true" aria-label="Activer les notifications">
        <div class="bpm-header">
          <div class="bpm-bell-wrap">
            <div class="bpm-bell-ring" id="bpm-bell-ring">🔔</div>
          </div>
          <div class="bpm-logo">BarOS</div>
        </div>
        <div class="bpm-body">
          <h2 class="bpm-title">Restez informé en temps réel</h2>
          <p class="bpm-sub">Recevez les notifications même quand l'application est fermée.</p>
          <div class="bpm-features">
            <div class="bpm-feat"><span class="bpm-feat-ic">🍽️</span><span>Nouvelles commandes instantanément</span></div>
            <div class="bpm-feat"><span class="bpm-feat-ic">🔔</span><span>Appels tables en temps réel</span></div>
            <div class="bpm-feat"><span class="bpm-feat-ic">✅</span><span>Commandes prêtes à livrer</span></div>
            <div class="bpm-feat"><span class="bpm-feat-ic">🚨</span><span>Alertes sécurité prioritaires</span></div>
          </div>
        </div>
        <div class="bpm-actions">
          <button class="bpm-btn-yes" id="bpm-btn-yes" onclick="barosRequestPermission()">
            <span class="bpm-btn-ic">🔔</span> Activer les notifications
          </button>
          <button class="bpm-btn-no" onclick="barosDismissPermModal('later')">
            Pas maintenant
          </button>
        </div>
        <div class="bpm-footer">Vous pouvez désactiver à tout moment dans vos paramètres</div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Animation entrée
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const card = document.getElementById('bpm-card');
      if (card) card.classList.add('bpm-card-in');
    });
  });

  // Démarrer animation cloche
  barosAnimateBell();
}

async function barosRequestPermission() {
  const btn = document.getElementById('bpm-btn-yes');
  if (btn) { btn.textContent = '⏳ En cours...'; btn.disabled = true; }

  try {
    const perm = await Notification.requestPermission();
    pushLog('Permission', perm);

    if (perm === 'granted') {
      barosDismissPermModal('granted');
      await barosGetAndSaveToken();
      barosSetupForeground();
      barosShowPermGrantedFeedback();
    } else {
      barosDismissPermModal('denied');
      barosShowPermDeniedBadge();
    }
  } catch(e) {
    pushLog('Erreur demande permission', e.message);
    barosDismissPermModal('error');
  }
}

function barosDismissPermModal(reason) {
  BarOSPush._permModalOpen = false;
  const modal = document.getElementById('baros-perm-modal');
  if (!modal) return;

  const card = document.getElementById('bpm-card');
  if (card) card.classList.add('bpm-card-out');

  setTimeout(() => modal.remove(), 350);

  // Si refusé, stocker pour ne plus demander pendant 7 jours
  if (reason === 'denied' || reason === 'later') {
    localStorage.setItem('baros_push_perm_ask', String(Date.now()));
  }

  pushLog('Modal permission fermée', reason);
}

function barosAnimateBell() {
  const bell = document.getElementById('bpm-bell-ring');
  if (!bell) return;
  let count = 0;
  const iv  = setInterval(() => {
    count++;
    bell.style.animation = 'none';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { bell.style.animation = ''; });
    });
    if (count > 5 || !document.getElementById('bpm-bell-ring')) clearInterval(iv);
  }, 1200);
}

function barosShowPermGrantedFeedback() {
  // Toast de confirmation
  barosShowPushToast(
    '🎉 Notifications activées !',
    'Vous recevrez désormais les alertes BarOS en temps réel.',
    'systeme',
    PUSH_TYPES.systeme
  );
}

function barosShowPermDeniedBadge() {
  // Petit badge discret pour permettre de réactiver
  const existing = document.getElementById('baros-notif-badge');
  if (existing) return;

  const badge = document.createElement('div');
  badge.id    = 'baros-notif-badge';
  badge.title = 'Activer les notifications';
  badge.innerHTML = '🔕';
  badge.onclick   = () => {
    badge.remove();
    // Tenter de ré-ouvrir les paramètres (non possible programmatiquement)
    barosShowPushToast(
      'Notifications bloquées',
      'Pour les activer : Paramètres Chrome → Paramètres du site → Notifications → Autoriser',
      'systeme',
      PUSH_TYPES.systeme
    );
  };
  document.body.appendChild(badge);
}

// ═══════════════════════════════════════════════════════════════════════════
// 15. NETTOYAGE TOKENS INACTIFS (appelé à la connexion manager)
// ═══════════════════════════════════════════════════════════════════════════

async function barosCleanOldTokens() {
  if (typeof db === 'undefined') return;
  try {
    // Désactiver les tokens pas mis à jour depuis 30 jours
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { error } = await db.from('push_tokens')
      .update({ actif: false })
      .lt('updated_at', cutoff)
      .eq('actif', true);

    if (!error) pushLog('Anciens tokens nettoyés');
  } catch(e) {
    pushLog('Erreur nettoyage tokens', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 16. ENVOI NOTIFICATION DEPUIS L'APP (helper pour le gestionnaire)
// ═══════════════════════════════════════════════════════════════════════════

async function barosSendNotification(options) {
  // options = { type, titre, corps, role, employe_id, etab_id, data }
  if (typeof db === 'undefined') return;
  try {
    const { error } = await db.from('push_notifications_queue').insert({
      etab_id:    options.etab_id || BarOSPush.etabId,
      type:       options.type || 'systeme',
      titre:      options.titre || 'BarOS',
      corps:      options.corps || '',
      role:       options.role || null,
      employe_id: options.employe_id || null,
      payload:    options.data || {},
      created_at: new Date().toISOString(),
      sent:       false,
    });
    if (error) pushLog('Erreur queue notification', error.message);
    else       pushLog('Notification mise en queue ✓');
  } catch(e) {
    pushLog('Erreur envoi notification', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 17. INFORMATIONS APPAREIL
// ═══════════════════════════════════════════════════════════════════════════

function barosGetDeviceInfo() {
  const ua  = navigator.userAgent;
  let plateforme = 'web';
  let appareil   = 'Inconnu';

  if (/android/i.test(ua))      plateforme = 'android';
  else if (/iphone|ipad/i.test(ua)) plateforme = 'ios';

  // Marque approximative
  if (/samsung/i.test(ua))       appareil = 'Samsung';
  else if (/pixel/i.test(ua))    appareil = 'Google Pixel';
  else if (/huawei/i.test(ua))   appareil = 'Huawei';
  else if (/xiaomi/i.test(ua))   appareil = 'Xiaomi';
  else if (/oppo/i.test(ua))     appareil = 'OPPO';
  else if (/tecno/i.test(ua))    appareil = 'TECNO';
  else if (/infinix/i.test(ua))  appareil = 'Infinix';
  else if (/windows/i.test(ua))  appareil = 'Windows';
  else if (/mac/i.test(ua))      appareil = 'Mac';

  return { plateforme, appareil };
}

// ═══════════════════════════════════════════════════════════════════════════
// 18. UTILITAIRES
// ═══════════════════════════════════════════════════════════════════════════

function pushLog(msg, data) {
  const prefix = '[BarOS Push]';
  if (data !== undefined) console.log(prefix, msg, data);
  else                    console.log(prefix, msg);
}

function barosEscape(str) {
  return String(str || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════════════════════════════════
// 19. TEST NOTIFICATION (panel de test pour le gestionnaire)
// ═══════════════════════════════════════════════════════════════════════════

async function barosTestNotification(type) {
  type = type || 'commande';
  const cfg = PUSH_TYPES[type] || PUSH_TYPES.systeme;

  // Afficher en foreground
  barosShowPushToast(
    `${cfg.emoji} Test — ${cfg.label}`,
    `Simulation notification "${type}" — BarOS Push System`,
    type,
    cfg
  );
  barosPushSound(type);
  barosVibrate(type);
  barosUpdateBadge(type);

  // Si permission accordée, aussi via le système
  if (Notification.permission === 'granted' && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type:    'BAROS_SHOW_NOTIF',
      payload: {
        type,
        titre: `${cfg.emoji} Test BarOS — ${cfg.label}`,
        corps: 'Notification de test. Votre système fonctionne parfaitement ! ✓',
      },
    });
  }

  pushLog('Test notification envoyé', type);
}

// ═══════════════════════════════════════════════════════════════════════════
// 20. STYLES CSS — Injectés dynamiquement (aucun conflit avec l'existant)
// ═══════════════════════════════════════════════════════════════════════════

(function barosInjectStyles() {
  if (document.getElementById('baros-push-styles')) return;
  const style = document.createElement('style');
  style.id    = 'baros-push-styles';
  style.textContent = `

/* ══════════════════════════════════════════════
   BAROS PUSH TOAST — Toast notification premium
══════════════════════════════════════════════ */
.baros-push-toast {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%) translateY(-120px);
  z-index: 99999;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: #1a1a26;
  border: 1px solid rgba(255,255,255,0.13);
  border-radius: 16px;
  padding: 14px 16px 14px 12px;
  min-width: min(340px, 92vw);
  max-width: min(400px, 96vw);
  box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3);
  cursor: pointer;
  transition: transform 0.35s cubic-bezier(0.34,1.56,0.64,1), opacity 0.35s ease;
  opacity: 0;
  overflow: hidden;
}
.baros-push-toast.bpt-show {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}
.bpt-accent {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
  border-radius: 3px 0 0 3px;
}
.bpt-icon {
  font-size: 22px;
  flex-shrink: 0;
  line-height: 1;
  margin-top: 1px;
}
.bpt-content {
  flex: 1;
  min-width: 0;
}
.bpt-titre {
  font-size: 13px;
  font-weight: 700;
  color: #f0eff5;
  line-height: 1.3;
  margin-bottom: 3px;
}
.bpt-corps {
  font-size: 11px;
  color: rgba(240,239,245,0.55);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bpt-close {
  background: none;
  border: none;
  color: rgba(240,239,245,0.3);
  font-size: 13px;
  cursor: pointer;
  padding: 0 0 0 6px;
  flex-shrink: 0;
  line-height: 1;
  margin-top: 1px;
}
.bpt-close:hover { color: rgba(240,239,245,0.7); }

/* ══════════════════════════════════════════════
   MODAL PERMISSION PUSH — Design premium BarOS
══════════════════════════════════════════════ */
.bpm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.75);
  z-index: 99998;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0 0 env(safe-area-inset-bottom, 0);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.bpm-card {
  background: #12121a;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 28px 28px 0 0;
  width: 100%;
  max-width: 480px;
  padding: 24px 24px 36px;
  transform: translateY(100%);
  transition: transform 0.4s cubic-bezier(0.34,1.2,0.64,1);
  box-shadow: 0 -8px 40px rgba(0,0,0,0.5);
}
.bpm-card.bpm-card-in  { transform: translateY(0); }
.bpm-card.bpm-card-out { transform: translateY(110%); transition-timing-function: ease-in; }

.bpm-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 20px;
}
.bpm-bell-wrap {
  width: 72px; height: 72px;
  background: rgba(124,108,255,0.15);
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 12px;
  position: relative;
}
.bpm-bell-wrap::before {
  content: '';
  position: absolute; inset: -4px;
  border-radius: 50%;
  border: 1.5px solid rgba(124,108,255,0.3);
  animation: bpmPulse 2s ease-in-out infinite;
}
@keyframes bpmPulse {
  0%,100% { opacity:1; transform: scale(1); }
  50%      { opacity:0.4; transform: scale(1.1); }
}
.bpm-bell-ring {
  font-size: 32px;
  animation: bpmBell 1.2s ease-in-out infinite;
  transform-origin: 50% 0%;
}
@keyframes bpmBell {
  0%,100% { transform: rotate(0); }
  15%     { transform: rotate(14deg); }
  30%     { transform: rotate(-12deg); }
  45%     { transform: rotate(10deg); }
  60%     { transform: rotate(-8deg); }
  75%     { transform: rotate(5deg); }
  85%     { transform: rotate(-4deg); }
}
.bpm-logo {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 2px;
  color: rgba(240,239,245,0.3);
  text-transform: uppercase;
}
.bpm-title {
  font-size: 20px;
  font-weight: 800;
  color: #f0eff5;
  text-align: center;
  margin-bottom: 8px;
  line-height: 1.2;
}
.bpm-sub {
  font-size: 13px;
  color: rgba(240,239,245,0.5);
  text-align: center;
  line-height: 1.5;
  margin-bottom: 20px;
}
.bpm-features {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 24px;
  padding: 16px;
  background: rgba(255,255,255,0.04);
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.06);
}
.bpm-feat {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: rgba(240,239,245,0.75);
}
.bpm-feat-ic {
  font-size: 18px;
  width: 28px;
  text-align: center;
  flex-shrink: 0;
}
.bpm-actions { display: flex; flex-direction: column; gap: 10px; }
.bpm-btn-yes {
  width: 100%;
  background: #7c6cff;
  color: #fff;
  border: none;
  border-radius: 14px;
  padding: 16px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 0.15s, transform 0.1s;
  font-family: inherit;
}
.bpm-btn-yes:active { transform: scale(0.97); background: #6a5ce0; }
.bpm-btn-no {
  width: 100%;
  background: none;
  border: none;
  color: rgba(240,239,245,0.4);
  font-size: 13px;
  cursor: pointer;
  padding: 10px;
  font-family: inherit;
  transition: color 0.15s;
}
.bpm-btn-no:hover { color: rgba(240,239,245,0.65); }
.bpm-footer {
  text-align: center;
  font-size: 10px;
  color: rgba(240,239,245,0.2);
  margin-top: 12px;
}

/* Badge notifications désactivées */
#baros-notif-badge {
  position: fixed;
  bottom: 80px;
  right: 16px;
  background: rgba(255,94,94,0.2);
  border: 1px solid rgba(255,94,94,0.35);
  border-radius: 50%;
  width: 40px; height: 40px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px;
  cursor: pointer;
  z-index: 9000;
  transition: transform 0.15s;
}
#baros-notif-badge:hover { transform: scale(1.1); }

/* Panel de test (gestionnaire) */
.baros-push-test-panel {
  background: rgba(124,108,255,0.06);
  border: 1px solid rgba(124,108,255,0.18);
  border-radius: 14px;
  padding: 16px;
  margin: 14px 0;
}
.baros-push-test-title {
  font-size: 12px;
  font-weight: 700;
  color: #7c6cff;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.baros-push-test-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 7px;
}
.baros-push-test-btn {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  padding: 9px 8px;
  font-size: 11px;
  cursor: pointer;
  color: rgba(240,239,245,0.75);
  text-align: center;
  transition: all 0.15s;
  font-family: inherit;
}
.baros-push-test-btn:hover {
  background: rgba(124,108,255,0.15);
  border-color: rgba(124,108,255,0.3);
  color: #f0eff5;
}
.baros-push-test-btn:active { transform: scale(0.95); }

/* Indicateur statut push dans header */
.baros-push-status-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background 0.3s;
}
.baros-push-status-dot.on   { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
.baros-push-status-dot.off  { background: rgba(255,255,255,0.2); }
.baros-push-status-dot.warn { background: #ffb444; }

  `;
  document.head.appendChild(style);
  pushLog('Styles push injectés ✓');
})();

// ── Export des fonctions publiques ────────────────────────────────────────────
window.barosPushInit           = barosPushInit;
window.barosRequestPermission  = barosRequestPermission;
window.barosDismissPermModal   = barosDismissPermModal;
window.barosTestNotification   = barosTestNotification;
window.barosSendNotification   = barosSendNotification;
window.barosCleanOldTokens     = barosCleanOldTokens;
window.barosClearBadge         = barosClearBadge;

pushLog('Module baros-push.js chargé ✓');
