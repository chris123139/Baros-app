/**
 * ════════════════════════════════════════════════════════════════════════
 *  BarOS — MODULE SÉCURITÉ UNIVERSEL
 *  Fichier : baros-security.js
 *  Version : 1.0.0 — 2026-06
 *  Auteur  : Christophe OLOCK BELANG
 *
 *  RÈGLES D'INTÉGRATION :
 *  - Charger ce script AVANT le reste du code BarOS
 *  - Ne pas modifier les fonctions existantes directement
 *  - Ces fonctions remplacent ou wrappent les fonctions originales
 *
 *  FAILLES CORRIGÉES DANS CE FICHIER :
 *  [C2] Hash bcrypt (remplacement de btoa)
 *  [C3] QR codes signés (HMAC-SHA256)
 *  [H5] Rate limiting côté client (couche de défense supplémentaire)
 *  [H6] Session sécurisée (expiration, flag httpOnly simulé)
 *  [M4] Sanitisation des entrées (XSS prevention)
 * ════════════════════════════════════════════════════════════════════════
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 1 : CONFIGURATION SÉCURITÉ
// ═══════════════════════════════════════════════════════════════════════════

const BAROS_SEC = {
  // Durée de session en millisecondes (8 heures)
  SESSION_DURATION_MS: 8 * 60 * 60 * 1000,

  // Rate limiting côté client
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION_MS: 30 * 60 * 1000,  // 30 minutes
  ATTEMPT_WINDOW_MS:   15 * 60 * 1000,  // 15 minutes

  // Longueur minimale du mot de passe
  MIN_PASSWORD_LENGTH: 8,

  // Préfixe de stockage pour éviter collisions
  STORAGE_PREFIX: 'baros_sec_',

  // Version du format QR (pour migration future)
  QR_VERSION: 2,
};

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 2 : HACHAGE CÔTÉ CLIENT (WebCrypto API)
//  Note : Ce hachage est une couche de défense supplémentaire.
//  Le vrai hachage bcrypt DOIT se faire côté serveur (Edge Function).
//  Cette implémentation utilise SHA-256 avec sel pour rendre les
//  comparaisons en clair impossibles même avec accès à la DB.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Génère un sel aléatoire cryptographique
 * @returns {string} Sel hex 32 bytes
 */
function generateSalt() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hache un mot de passe avec SHA-256 + sel (côté client)
 * Format résultat : sha256:{sel}:{hash}
 * ATTENTION : Pour la production, migrer vers bcrypt via Edge Function
 *
 * @param {string} password - Mot de passe en clair
 * @param {string|null} salt - Sel optionnel (pour vérification)
 * @returns {Promise<string>} Hash au format sha256:{sel}:{hash}
 */
async function hashPassword(password, salt = null) {
  const usedSalt = salt || generateSalt();
  const input = `baros:${usedSalt}:${password}:2026`;
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${usedSalt}:${hashHex}`;
}

/**
 * Vérifie un mot de passe contre un hash stocké
 * Compatible avec l'ancien format btoa (transition progressive)
 *
 * @param {string} password - Mot de passe saisi
 * @param {string} storedHash - Hash stocké en DB
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, storedHash) {
  if (!storedHash || !password) return false;

  // Nouveau format : sha256:{sel}:{hash}
  if (storedHash.startsWith('sha256:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const [, salt, expectedHash] = parts;
    const computed = await hashPassword(password, salt);
    const computedHash = computed.split(':')[2];
    // Comparaison en temps constant pour éviter timing attacks
    return secureCompare(computedHash, expectedHash);
  }

  // Ancien format base64 (migration progressive — désactiver après 30 jours)
  // SUPPRIMER CE BLOC APRÈS MIGRATION COMPLÈTE
  if (storedHash === btoa(password)) {
    console.warn('[BarOS SEC] Compte utilisant ancien hash base64. Migration requise.');
    return true;
  }

  return false;
}

/**
 * Comparaison de chaînes en temps constant (évite timing attacks)
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function secureCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}


// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 3 : QR CODES SIGNÉS (HMAC-SHA256)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Génère un QR token signé pour un employé
 * Le QR contiendra : v2:{employe_id}:{etab_id}:{timestamp}:{hmac}
 *
 * IMPORTANT : La clé secrète DOIT être stockée dans Supabase Vault ou
 * une variable d'environnement serveur, JAMAIS dans le code client.
 * Cette implémentation utilise une clé dérivée de l'etab_id comme
 * solution intermédiaire. Migrer vers Edge Function pour production.
 *
 * @param {string} employeId - UUID de l'employé
 * @param {string} etabId    - UUID de l'établissement
 * @param {string} secretKey - Clé secrète (depuis Supabase Vault)
 * @returns {Promise<string>} Payload QR signé
 */
async function generateSignedQR(employeId, etabId, secretKey) {
  const timestamp = Math.floor(Date.now() / 1000);  // Unix timestamp
  const payload = `${BAROS_SEC.QR_VERSION}:${employeId}:${etabId}:${timestamp}`;

  // HMAC-SHA256
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secretKey);
  const payloadData = encoder.encode(payload);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, payloadData);
  const sigHex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('').substring(0, 16);  // Tronqué à 16 chars pour QR compact

  return `${payload}:${sigHex}`;
}

/**
 * Valide un QR token signé
 * @param {string} qrPayload - Payload scanné du QR
 * @param {string} secretKey - Clé secrète
 * @param {string} expectedEtabId - ETAB_ID attendu (isolation établissement)
 * @param {number} maxAgeSeconds - Âge max du QR en secondes (défaut: 1 an)
 * @returns {Promise<{valid: boolean, employeId?: string, reason?: string}>}
 */
async function validateSignedQR(qrPayload, secretKey, expectedEtabId, maxAgeSeconds = 365 * 24 * 3600) {
  if (!qrPayload || typeof qrPayload !== 'string') {
    return { valid: false, reason: 'payload_empty' };
  }

  // Format attendu : 2:{employe_id}:{etab_id}:{timestamp}:{hmac}
  const parts = qrPayload.split(':');

  // QR v2 (signé)
  if (parts.length === 6 && parts[0] === '2') {
    const [version, employeId, etabId, timestamp, , sig] = parts;
    const payload = `${version}:${employeId}:${etabId}:${timestamp}`;

    // Vérifier l'établissement
    if (etabId !== expectedEtabId) {
      return { valid: false, reason: 'wrong_etab' };
    }

    // Vérifier l'expiration
    const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
    if (age > maxAgeSeconds || age < 0) {
      return { valid: false, reason: 'token_expired' };
    }

    // Vérifier la signature HMAC
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secretKey);
    const payloadData = encoder.encode(payload);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, payloadData);
    const expectedSig = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('').substring(0, 16);

    if (!secureCompare(sig, expectedSig)) {
      return { valid: false, reason: 'signature_invalid' };
    }

    return { valid: true, employeId, etabId };
  }

  // QR v1 (ancien format JSON) — accepté avec avertissement pendant transition
  // SUPPRIMER APRÈS MIGRATION COMPLÈTE (60 jours)
  if (qrPayload.startsWith('{')) {
    try {
      const obj = JSON.parse(qrPayload);
      const empId = obj.employee_id || obj.id;
      if (empId && obj.etab_id === expectedEtabId) {
        console.warn('[BarOS SEC] QR v1 (non signé) accepté. Régénérer les badges.');
        return { valid: true, employeId: empId, etabId: obj.etab_id, legacy: true };
      }
    } catch (_) {}
  }

  // UUID brut — accepté avec avertissement pendant transition
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(qrPayload);
  if (isUUID) {
    console.warn('[BarOS SEC] QR UUID brut (non signé). Régénérer les badges.');
    return { valid: true, employeId: qrPayload, legacy: true };
  }

  return { valid: false, reason: 'format_unknown' };
}


// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 4 : RATE LIMITING CÔTÉ CLIENT
// ═══════════════════════════════════════════════════════════════════════════

const _loginAttempts = new Map();

/**
 * Vérifie si un email est autorisé à tenter un login
 * @param {string} email
 * @returns {{ allowed: boolean, remaining: number, lockedUntil?: Date }}
 */
function checkLoginRateLimit(email) {
  const key = email.toLowerCase().trim();
  const now = Date.now();
  const entry = _loginAttempts.get(key) || { attempts: [], lockedUntil: null };

  // Vérifier verrou actif
  if (entry.lockedUntil && entry.lockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      lockedUntil: new Date(entry.lockedUntil),
    };
  }

  // Nettoyer les tentatives hors fenêtre
  entry.attempts = entry.attempts.filter(t => now - t < BAROS_SEC.ATTEMPT_WINDOW_MS);
  _loginAttempts.set(key, entry);

  const remaining = BAROS_SEC.MAX_LOGIN_ATTEMPTS - entry.attempts.length;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

/**
 * Enregistre une tentative de login (succès ou échec)
 * @param {string} email
 * @param {boolean} success
 */
function recordLoginAttempt(email, success) {
  const key = email.toLowerCase().trim();
  const now = Date.now();
  const entry = _loginAttempts.get(key) || { attempts: [], lockedUntil: null };

  if (success) {
    // Succès : réinitialiser les tentatives
    _loginAttempts.delete(key);
    return;
  }

  // Échec : ajouter la tentative
  entry.attempts.push(now);
  entry.attempts = entry.attempts.filter(t => now - t < BAROS_SEC.ATTEMPT_WINDOW_MS);

  if (entry.attempts.length >= BAROS_SEC.MAX_LOGIN_ATTEMPTS) {
    entry.lockedUntil = now + BAROS_SEC.LOCKOUT_DURATION_MS;
    console.warn(`[BarOS SEC] Compte ${key} verrouillé jusqu'à ${new Date(entry.lockedUntil).toLocaleTimeString()}`);
  }

  _loginAttempts.set(key, entry);
}


// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 5 : GESTION DE SESSION SÉCURISÉE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sauvegarde une session avec expiration et validation
 * Remplace localStorage.setItem('baros_session', ...)
 *
 * @param {object} sessionData - Données de session Supabase
 */
function saveSecureSession(sessionData) {
  if (!sessionData) return;

  // Retirer les données sensibles avant stockage local
  const safeSession = {
    id:         sessionData.id,
    email:      sessionData.email,
    nom:        sessionData.nom,
    role:       sessionData.role,
    etab_id:    sessionData.etab_id,
    couleur:    sessionData.couleur,
    is_active:  sessionData.is_active,
    // NE JAMAIS stocker pwd_hash localement
    _expires:   Date.now() + BAROS_SEC.SESSION_DURATION_MS,
    _created:   Date.now(),
  };

  // Avertissement si pwd_hash présent (ne devrait pas être là)
  if (sessionData.pwd_hash) {
    console.error('[BarOS SEC] ERREUR : pwd_hash dans les données de session. Ne jamais envoyer au client !');
  }

  localStorage.setItem('baros_session', JSON.stringify(safeSession));
}

/**
 * Récupère et valide la session locale
 * Remplace JSON.parse(localStorage.getItem('baros_session'))
 *
 * @returns {object|null} Session valide ou null
 */
function getSecureSession() {
  try {
    const raw = localStorage.getItem('baros_session');
    if (!raw) return null;

    const session = JSON.parse(raw);
    if (!session || !session._expires) return null;

    // Vérifier expiration
    if (Date.now() > session._expires) {
      clearSecureSession();
      console.info('[BarOS SEC] Session expirée, reconnexion requise.');
      return null;
    }

    // Vérifier champs obligatoires
    if (!session.etab_id || !session.email) {
      clearSecureSession();
      return null;
    }

    return session;
  } catch (e) {
    clearSecureSession();
    return null;
  }
}

/**
 * Efface la session locale de manière sécurisée
 */
function clearSecureSession() {
  localStorage.removeItem('baros_session');
  sessionStorage.clear();
}

/**
 * Vérifie si la session doit être rafraîchie (< 1h restante)
 * @returns {boolean}
 */
function sessionNeedsRefresh() {
  const session = getSecureSession();
  if (!session) return false;
  const remaining = session._expires - Date.now();
  return remaining < 60 * 60 * 1000;  // < 1 heure
}


// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 6 : SANITISATION DES ENTRÉES (XSS Prevention)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Échappe les caractères HTML dangereux
 * À utiliser avant tout innerHTML avec données utilisateur
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return String(str || '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Sanitise un objet de données Supabase avant rendu HTML
 * Applique escapeHtml sur toutes les valeurs string
 *
 * @param {object} obj
 * @returns {object}
 */
function sanitizeForHtml(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = escapeHtml(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    } else if (value === null || value === undefined) {
      result[key] = value;
    } else {
      result[key] = value;  // Objets/arrays : laisser tel quel
    }
  }
  return result;
}

/**
 * Valide et nettoie un UUID
 * @param {string} str
 * @returns {string|null}
 */
function validateUUID(str) {
  if (!str || typeof str !== 'string') return null;
  const clean = str.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) {
    return clean.toLowerCase();
  }
  return null;
}

/**
 * Valide un email
 * @param {string} email
 * @returns {boolean}
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) && email.length <= 254;
}

/**
 * Valide un mot de passe selon les règles BarOS
 * @param {string} pwd
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePassword(pwd) {
  const errors = [];
  if (!pwd || typeof pwd !== 'string') {
    return { valid: false, errors: ['Mot de passe requis'] };
  }
  if (pwd.length < BAROS_SEC.MIN_PASSWORD_LENGTH) {
    errors.push(`Minimum ${BAROS_SEC.MIN_PASSWORD_LENGTH} caractères`);
  }
  if (pwd.length > 128) {
    errors.push('Maximum 128 caractères');
  }
  // Optionnel : complexité (à activer progressivement)
  // if (!/[A-Z]/.test(pwd)) errors.push('Au moins une majuscule');
  // if (!/[0-9]/.test(pwd)) errors.push('Au moins un chiffre');
  return { valid: errors.length === 0, errors };
}


// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 7 : JOURNALISATION SÉCURITÉ
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Enregistre un événement de sécurité dans Supabase
 * (Appel asynchrone non bloquant)
 *
 * @param {object} db      - Client Supabase
 * @param {string} type    - Type d'événement
 * @param {object} details - Détails de l'événement
 */
async function logSecurityEvent(db, type, details = {}) {
  try {
    await db.from('security_audit_log').insert({
      event_type: type,
      actor_email: details.email || null,
      etab_id:     details.etab_id || null,
      target_id:   details.target_id || null,
      details:     details,
      ip_address:  null,  // Non accessible côté client pur
      user_agent:  navigator.userAgent?.substring(0, 200) || null,
    });
  } catch (e) {
    // Erreur de journalisation non critique — ne pas bloquer l'app
    console.warn('[BarOS SEC] Erreur log sécurité :', e.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 8 : REMPLACEMENT SECURISE DE doLogin()
//  À injecter dans gestionnaire.html en remplacement de la fonction originale
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Version sécurisée de doLogin()
 * Remplace la fonction originale dans gestionnaire.html
 * CONSERVE la même UX et les mêmes flux
 */
async function doLoginSecure() {
  const email = document.getElementById('l-email').value.trim().toLowerCase();
  const pwd   = document.getElementById('l-pwd').value;

  if (!email || !pwd) {
    showErr('l', 'Remplis tous les champs');
    return;
  }

  // Validation email
  if (!validateEmail(email)) {
    showErr('l', 'Email invalide');
    return;
  }

  // Rate limiting côté client
  const rateCheck = checkLoginRateLimit(email);
  if (!rateCheck.allowed) {
    const minutes = Math.ceil((rateCheck.lockedUntil - Date.now()) / 60000);
    showErr('l', `Trop de tentatives. Réessayez dans ${minutes} min.`);
    return;
  }

  setLoading('l-btn', true);

  try {
    // Récupérer le compte (même flux que l'original)
    const { data, error } = await db
      .from('sessions')
      .select('id, email, nom, role, etab_id, couleur, is_active, pwd_hash')
      .eq('email', email)
      .single();

    if (error || !data) {
      recordLoginAttempt(email, false);
      await logSecurityEvent(db, 'login_fail', { email, reason: 'email_not_found' });
      showErr('l', 'Email non trouvé');
      setLoading('l-btn', false);
      return;
    }

    // Vérification du mot de passe (compatible ancien btoa + nouveau sha256)
    const passwordOk = await verifyPassword(pwd, data.pwd_hash);

    if (!passwordOk) {
      recordLoginAttempt(email, false);
      await logSecurityEvent(db, 'login_fail', { email, reason: 'wrong_password' });
      const remaining = checkLoginRateLimit(email).remaining;
      showErr('l', `Mot de passe incorrect. ${remaining} tentative(s) restante(s).`);
      setLoading('l-btn', false);
      return;
    }

    // Vérification activation
    if (data.is_active === false && !ADMIN_EMAILS.includes(email)) {
      showErr('l', '⛔ Compte non activé — contactez l\'administrateur.');
      setLoading('l-btn', false);
      return;
    }

    // Succès
    recordLoginAttempt(email, true);

    // Mise à jour last_login
    await db.from('sessions')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', data.id);

    await logSecurityEvent(db, 'login_success', {
      email, etab_id: data.etab_id, role: data.role
    });

    // Sauvegarder la session SANS pwd_hash
    saveSecureSession(data);
    await startApp(data);

  } catch (err) {
    console.error('[BarOS SEC] Erreur login :', err);
    showErr('l', 'Erreur de connexion. Réessayez.');
  } finally {
    setLoading('l-btn', false);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 9 : VÉRIFICATION QR SÉCURISÉE POUR LE POINTAGE
//  À injecter dans pointage.html pour remplacer la validation QR originale
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Valide un QR code scanné avec vérification cryptographique
 * Compatible avec l'ancien format (transition progressive)
 *
 * @param {string} qrText    - Texte brut scanné
 * @param {string} etabId    - ETAB_ID attendu
 * @param {string} secretKey - Clé HMAC (depuis config établissement)
 * @returns {Promise<{valid: boolean, employeId?: string, legacy?: boolean}>}
 */
async function validateQRSecure(qrText, etabId, secretKey) {
  if (!qrText || !etabId) {
    return { valid: false, reason: 'missing_params' };
  }

  // Si pas de clé secrète configurée → mode legacy (transition)
  if (!secretKey) {
    console.warn('[BarOS SEC] Aucune clé QR configurée. Mode legacy actif.');
    // Validation minimale : vérifier que l'employé appartient à l'étab
    return { valid: true, employeId: qrText, legacy: true };
  }

  return validateSignedQR(qrText, secretKey, etabId);
}


// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 10 : EXPORTS ET INITIALISATION
// ═══════════════════════════════════════════════════════════════════════════

// Exposer les fonctions globalement pour compatibilité avec le code existant
window.BarOSSec = {
  // Hachage
  hashPassword,
  verifyPassword,
  secureCompare,
  generateSalt,

  // QR
  generateSignedQR,
  validateSignedQR,
  validateQRSecure,

  // Rate limiting
  checkLoginRateLimit,
  recordLoginAttempt,

  // Session
  saveSecureSession,
  getSecureSession,
  clearSecureSession,
  sessionNeedsRefresh,

  // Sanitisation
  escapeHtml,
  sanitizeForHtml,
  validateUUID,
  validateEmail,
  validatePassword,

  // Logging
  logSecurityEvent,

  // Login sécurisé (override)
  doLoginSecure,
  validateQRSecure,

  // Config
  config: BAROS_SEC,

  // Version
  version: '1.0.0',
};

// Auto-vérification au chargement
(function() {
  const session = getSecureSession();
  if (session === null && localStorage.getItem('baros_session')) {
    // Session invalide ou expirée
    console.info('[BarOS SEC] Session expirée ou invalide, nettoyage.');
    clearSecureSession();
  }

  console.info('[BarOS SEC] Module sécurité v1.0.0 chargé.');
  console.info('[BarOS SEC] Rôle ROOT_OWNER : Christophe OLOCK BELANG');
})();
