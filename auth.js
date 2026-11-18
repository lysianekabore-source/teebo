import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { q, tx } from './db.js';
import { defaultPermissionKeysForRole } from './permissions.js';

export const MDP_MAX_DAYS = 60;      // expiration mot de passe
// Inactivité -> déconnexion. CORRECTIF 18/11/2026 : une journée de travail
// entière (8 h) par défaut. Un utilisateur qui travaille n'est plus jamais
// renvoyé à l'écran de connexion au bout de quelques minutes.
// La variable IDLE_MINUTES ne peut plus descendre sous 60 minutes : une valeur
// trop basse laissée dans Render (10, 15…) déconnectait les équipes en pleine
// saisie. Elle est donc ignorée en dessous de 60.
export const IDLE_MINUTES_DEFAUT = 480;
export const IDLE_MINUTES_MIN = 60;
export function idleMinutes() {
  const v = parseInt(process.env.IDLE_MINUTES, 10);
  if (!Number.isFinite(v)) return IDLE_MINUTES_DEFAUT;
  if (v < IDLE_MINUTES_MIN) return IDLE_MINUTES_DEFAUT;
  return Math.min(v, 1440);
}
// Cookie de session : 30 jours, et NON plus 60 minutes figées. Avant, le
// cookie expirait une heure après la connexion même si la personne travaillait
// encore : c'était la deuxième cause des déconnexions surprises.
export const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS
  };
}
export const SESSION_TOKEN_TTL = '60d';

// Matrice des habilitations par ROLE (source unique : permissions.js).
const defautsRole = (role) => defaultPermissionKeysForRole(role);

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function isPasswordExpired(passwordSetAt) {
  if (!passwordSetAt) return true;
  const ageMs = Date.now() - new Date(passwordSetAt).getTime();
  return ageMs > MDP_MAX_DAYS * 24 * 60 * 60 * 1000;
}

/** Crée une session serveur + renvoie le token opaque (cookie httpOnly). */
export async function createSession(user) {
  const token = b64url(crypto.randomBytes(32));
  const tokenHash = hashToken(token);
  const client = await q(
    `INSERT INTO session(user_id, imf_id, token_hash, expires_at)
     VALUES ($1,$2,$3, now() + interval '60 days') RETURNING id`,
    [user.id, user.imf_id, tokenHash]
  );
  return { token, sessionId: client.rows[0].id };
}

/**
 * Middleware d'authentification :
 *  - vérifie le cookie de session (opaque, httpOnly)
 *  - applique la déconnexion après 60 min d'inactivité (toute requête
 *    authentifiée compte comme de l'activité : un utilisateur qui travaille
 *    n'est jamais déconnecté)
 *  - vérifie l'expiration du mot de passe (60 jours) -> force le changement
 *  - expose req.user + req.imf (cloisonnement)
 */
export async function authenticate(req, res, next) {
  try {
    const token = req.cookies?.teebo_session;
    if (!token) return res.status(401).json({ error: 'not_authenticated' });
    const tokenHash = hashToken(token);

    const { rows } = await q(
      `SELECT s.id AS session_id, s.last_seen_at, s.expires_at, s.revoked,
              u.id, u.imf_id, u.role, u.email, u.full_name, u.code_user,
              u.position_code,
              u.password_set_at, u.must_change_password, u.is_active
         FROM session s JOIN app_user u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [tokenHash]
    );
    if (!rows.length) return res.status(401).json({ error: 'invalid_session' });
    const row = rows[0];
    if (row.revoked) return res.status(401).json({ error: 'session_revoked' });
    if (new Date(row.expires_at) < new Date()) {
      await q('UPDATE session SET revoked = true WHERE id = $1', [row.session_id]);
      return res.status(401).json({ error: 'session_expired' });
    }
    // Inactivité : 60 min par défaut (IDLE_MINUTES). Le compteur repart à
    // chaque requête authentifiée (voir le marquage d'activité plus bas).
    const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : Date.now();
    const idleMs = Date.now() - lastSeen;
    if (idleMs > idleMinutes() * 60 * 1000) {
      await q('UPDATE session SET revoked = true WHERE id = $1', [row.session_id]);
      return res.status(401).json({ error: 'idle_timeout' });
    }
    if (!row.is_active) return res.status(403).json({ error: 'user_disabled' });

    // ACTIVITÉ : chaque requête authentifiée repousse l'échéance d'inactivité.
    // Les appels de simple maintien de session (balise de l'interface) ne
    // sont écrits qu'une fois par minute maximum, pour ne pas surcharger la
    // base quand plusieurs onglets sont ouverts.
    const isKeepAlive = req.headers['x-teebo-keepalive'] === '1';
    if (!isKeepAlive || idleMs > 60 * 1000) {
      await q('UPDATE session SET last_seen_at = now() WHERE id = $1', [row.session_id]);
    }
    // COOKIE GLISSANT : on repousse l'échéance du cookie à chaque activité
    // (au plus une fois toutes les 10 minutes pour ne pas alourdir la réponse).
    // Sans cela, le navigateur supprimait le cookie au bout de sa durée de vie
    // alors que la session serveur était encore valide.
    if (idleMs > 10 * 60 * 1000) {
      try { res.cookie('teebo_session', token, cookieOptions()); } catch (e) {}
    }

    req.user = {
      id: row.id, imf_id: row.imf_id, role: row.role, email: row.email,
      full_name: row.full_name, code_user: row.code_user,
      position_code: row.position_code || null,
      password_set_at: row.password_set_at,
      must_change_password: row.must_change_password
    };
    req.sessionId = row.session_id;
    req.passwordExpired = isPasswordExpired(row.password_set_at);
    next();
  } catch (e) {
    next(e);
  }
}

/** Bloque l'accès aux routes métier si le mot de passe doit être changé/expiré. */
export function requireFreshPassword(req, res, next) {
  if (req.user.must_change_password || req.passwordExpired) {
    return res.status(403).json({ error: 'password_change_required' });
  }
  next();
}

/**
 * Alias des RÔLES-POSTES (enum riche attribué par le poste, cf. org_structure.js)
 * vers les PROFILS socle utilisés par les listes requireRole héritées.
 * Un poste hérite AU MOINS des profils nécessaires à ses capacités métier,
 * afin que les routes opérationnelles (operations/clients/collecte/credit…)
 * ne bloquent plus les postes dont le rôle n'est pas un profil socle.
 * Le cloisonnement par imf_id reste assuré côté requête SQL : aucun alias
 * ne franchit la frontière de l'IMF.
 */
const ROLE_ALIASES = Object.freeze({
  // Direction générale de l'IMF : administration complète.
  superadmin:           ['admin_imf', 'direction'],
  // Président du Conseil d'Administration (VAGUE 47 — correction du bug des
  // droits identiques) : supervision et gouvernance de l'institution
  // (consultation, validations) mais AUCUNE gestion du personnel ni de la
  // matrice des habilitations, et aucun droit d'opération financière.
  // -> plus d'alias vers 'admin_imf' : le PCA ne partage plus 100 % des
  //    habilitations de l'administrateur de l'IMF.
  pca_admin:            ['direction'],
  // Directions de département : encadrement (lecture + validations).
  operations_director:  ['department', 'service', 'agency'],
  credit_director:      ['department', 'service'],
  cfo:                  ['department', 'service'],
  compliance_officer:   ['department', 'service'],
  it_admin:             ['department', 'service'],
  hr_logistics_manager: ['department', 'service'],
  security_engineer:    ['service'],
  treasurer:            ['service'],
  accountant:           ['service'],
  auditor:              ['service'],
  // Terrain / guichet.
  teller:               ['caissier', 'staff'],
  customer_agent:       ['staff'],
  collectrice:          ['staff'],
  office_staff:         ['staff'],
  credit_analyst:       ['staff', 'service'],
  recovery_agent:       ['staff', 'service'],
});

/**
 * Rôle TECHNIQUE effectif d'un utilisateur.
 * Le poste « Président du Conseil d'Administration » est historiquement
 * enregistré avec le rôle socle 'office_staff' (aucun droit d'opération).
 * Pour que le PCA administre réellement son institution (structure,
 * gouvernance, comptes) sans lui ouvrir la caisse, on lui attribue le rôle
 * technique 'pca_admin' — profil de surveillance (VAGUE 47 : il ne dispose
 * plus de l'accès complet de l'administrateur, voir SUPERFICIE_EXCLUE).
 * Règle : position_code = POS_PCA ET rôle encore 'office_staff' (ou 'superadmin').
 */
export function effectiveRoleOf(user) {
  if (!user) return null;
  const pos = String(user.position_code || '').toUpperCase();
  const role = String(user.role || '');
  if (pos === 'POS_PCA' && (role === 'office_staff' || role === 'superadmin')) return 'pca_admin';
  return role;
}

/** Profils effectifs d'un rôle : le rôle lui-même + ses alias socle. */
export function rolesOf(role) {
  return [role, ...(ROLE_ALIASES[role] || [])];
}

// ---------------------------------------------------------------------------
// VAGUE 47 — BUG « TOUS LES UTILISATEURS ONT LES MÊMES DROITS »
// ---------------------------------------------------------------------------
// Cause racine : l'accès complet était accordé dès qu'un rôle figurait dans
// rolesOf() avec 'admin_imf' ou 'direction'. Or plusieurs postes (PCA,
// directeur général, etc.) sont aliasés sur ces profils : TOUS ces comptes
// recevaient donc l'intégralité du catalogue d'habilitations, exactement comme
// l'administrateur de l'IMF.
//
// Correction : seuls l'éditeur et l'administrateur de l'IMF disposent d'un
// accès complet implicite. La direction et le PCA sont traités comme des
// profils ORDINAIRES : leurs habilitations viennent du POSTE, de la surcharge
// utilisateur et de la matrice de rôle — jamais d'un « tout ouvert ».
// ---------------------------------------------------------------------------

/** Rôles à accès COMPLET implicite sur le catalogue d'habilitations. */
const FULL_ACCESS_ROLES = Object.freeze(['teebo_admin', 'admin_imf']);

/** Vrai si le rôle effectif dispose de l'accès complet implicite. */
export function hasFullAccess(role) {
  return FULL_ACCESS_ROLES.includes(String(role || ''));
}

/**
 * Habilitations qu'un profil ORDINAIRE ne peut jamais exercer, même si la
 * base ou la matrice les propose : gestion du personnel, de la structure, des
 * paramètres de l'IMF et de la matrice des droits. Seuls le compte de
 * l'administrateur de l'IMF et celui de l'éditeur y échappent.
 * CORRECTIF 18/11/2026 : ce plafond ne visait que la direction et le PCA.
 * Un chef d'agence (ou tout autre poste) pouvait donc recevoir, par surcharge,
 * les droits de l'administrateur et retrouver ses menus. Le plafond s'applique
 * désormais à TOUS les profils, sans exception : c'est la règle « un seul
 * administrateur par IMF ».
 */
const SUPERFICIE_EXCLUE = Object.freeze([
  'users.manage', 'access.manage', 'org.manage', 'settings.manage'
]);

/** Habilitations jamais exercees par ce profil (vide pour l'administrateur). */
export function superficieExcluePour(user) {
  const role = user ? (effectiveRoleOf(user) || user.role) : null;
  if (hasFullAccess(role)) return [];
  return SUPERFICIE_EXCLUE.slice();
}

/** Vrai si c'est un profil de surveillance soumis au plafond de superficie. */
export function estProfilSurveillance(user) {
  if (!user) return false;
  const role = effectiveRoleOf(user) || user.role;
  return role === 'pca_admin' || role === 'direction';
}

/** Filtre une liste de clés selon le profil effectif de l'utilisateur. */
export function filtrerHabilitations(user, keys) {
  const list = Array.isArray(keys) ? keys : [];
  const role = user ? (effectiveRoleOf(user) || user.role) : null;
  if (hasFullAccess(role)) return list.slice();
  // Plafond commun à tous les profils ordinaires (voir SUPERFICIE_EXCLUE).
  return list.filter((k) => !SUPERFICIE_EXCLUE.includes(k));
}

/**
 * Profils d'ENCADREMENT autorisés à consulter les données d'AUTRES agents
 * (vue équipe / supervision). Tout rôle hors de cet ensemble est strictement
 * cantonné à SES propres données — règle anti-fraude et de cloisonnement :
 * une collectrice, un caissier ou un chargé de clientèle ne voit JAMAIS le
 * portefeuille d'un autre agent.
 */
const TEAM_VIEW_PROFILES = Object.freeze(['admin_imf', 'direction', 'department', 'service', 'agency']);

/** Vrai si le rôle peut consulter les données d'équipe (sinon : self uniquement). */
export function canViewTeamData(role) {
  return rolesOf(role).some((p) => TEAM_VIEW_PROFILES.includes(p));
}

/** RBAC : liste de profils autorisés (tolérant aux rôles-postes via alias). */
export function requireRole(...roles) {
  return (req, res, next) => {
    // Garde : un routeur peut être traversé sans authentification préalable
    // (chemin non couvert). Sans cette ligne, on levait
    // « Cannot read properties of undefined (reading 'role') » -> 500 opaque.
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    // L'administrateur plateforme (teebo_admin) dispose de l'accès complet,
    // comme dans les helpers d'habilitation : on évite ainsi un 403 incohérent
    // sur l'administration de la structure (ex. ajout/modification d'unité).
    if (req.user.role === 'teebo_admin') return next();
    const mine = rolesOf(req.user.role);
    if (!mine.some((p) => roles.includes(p))) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

/**
 * Habilitation fine : vrai si l'utilisateur dispose de la clé demandée
 * (table user_permission, allowed=true) dans SA propre IMF (cloisonnement).
 * L'administrateur IMF et la direction disposent implicitement de tout.
 */
export async function userHasPermission(user, permissionKey) {
  if (!user) return false;
  const role = effectiveRoleOf(user) || user.role;
  // VAGUE 47 : accès complet réservé à l'éditeur et à l'administrateur de
  // l'IMF. La direction et le PCA passent par le calcul réel (poste +
  // surcharge + matrice de rôle), avec un plafond de superficie.
  if (hasFullAccess(role)) return true;
  // Aucun profil ordinaire n'exerce les droits de l'administrateur, même si
  // une ligne user_permission les lui accordait par erreur.
  if (SUPERFICIE_EXCLUE.includes(permissionKey)) return false;
  // 1) Surcharge explicite par utilisateur (prioritaire si présente).
  const direct = await q(
    `SELECT allowed FROM user_permission
      WHERE user_id=$1 AND imf_id=$2 AND permission_key=$3 LIMIT 1`,
    [user.id, user.imf_id, permissionKey]);
  if (direct.rows.length) return direct.rows[0].allowed === true;
  // 2) Sinon, habilitation par défaut du POSTE (matrice position_default_permission).
  if (user.position_code) {
    const pos = await q(
      `SELECT 1 FROM fn_position_default_perms($1,$2) WHERE permission_key=$3 LIMIT 1`,
      [user.imf_id, user.position_code, permissionKey]);
    if (pos.rows.length) return true;
  }
  // 3) Matrice de rôle (permissions.js) : un profil de supervision conserve
  //    ainsi ses droits de lecture et de validation, sans hériter du « tout
  //    ouvert » de l'administrateur de l'IMF.
  if (defautsRole(role).includes(permissionKey)) return true;
  return false;
}

/**
 * Renvoie l'ensemble des clés d'habilitation EFFECTIVES d'un utilisateur :
 * surcharges user_permission (allowed) ∪ défauts du poste (matrice).
 * Sert à l'affichage des menus côté console (/me.permissions).
 */
export async function effectivePermissionKeys(user) {
  if (!user) return [];
  const role = effectiveRoleOf(user) || user.role;
  if (hasFullAccess(role)) {
    const all = await q(
      `SELECT permission_key FROM permission_catalog
        WHERE imf_id IS NULL OR imf_id=$1`, [user.imf_id]);
    return all.rows.map((r) => r.permission_key);
  }
  const set = new Set();
  // Base : les habilitations du RÔLE (matrice permissions.js). Sans cette
  // ligne, un profil dont le poste n'est pas renseigné n'avait aucun droit.
  defautsRole(role).forEach((k) => set.add(k));
  if (user.position_code) {
    const pos = await q('SELECT permission_key FROM fn_position_default_perms($1,$2)',
      [user.imf_id, user.position_code]);
    pos.rows.forEach((r) => set.add(r.permission_key));
  }
  const over = await q(
    `SELECT permission_key, allowed FROM user_permission WHERE user_id=$1 AND imf_id=$2`,
    [user.id, user.imf_id]);
  over.rows.forEach((r) => { if (r.allowed) set.add(r.permission_key); else set.delete(r.permission_key); });
  // VAGUE 47 : plafond de superficie appliqué à la direction et au PCA.
  return filtrerHabilitations(user, Array.from(set));
}

/**
 * Middleware : bloque la route si l'utilisateur ne possède pas l'habilitation.
 * À placer APRÈS authenticate. Ex. : requirePermission('credit.validate_final').
 */
export function requirePermission(permissionKey) {
  return async (req, res, next) => {
    try {
      if (await userHasPermission(req.user, permissionKey)) return next();
      return res.status(403).json({ error: 'permission_denied', permission: permissionKey });
    } catch (e) { next(e); }
  };
}
