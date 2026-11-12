import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { q, tx } from './db.js';

export const MDP_MAX_DAYS = 60;      // expiration mot de passe
const IDLE_MINUTES = 30;              // inactivité -> déconnexion
export const SESSION_TOKEN_TTL = '60d';

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
 *  - applique la déconnexion après 30 min d'inactivité
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
    // Inactivité 30 min
    const idleMs = Date.now() - new Date(row.last_seen_at).getTime();
    if (idleMs > IDLE_MINUTES * 60 * 1000) {
      await q('UPDATE session SET revoked = true WHERE id = $1', [row.session_id]);
      return res.status(401).json({ error: 'idle_timeout' });
    }
    if (!row.is_active) return res.status(403).json({ error: 'user_disabled' });

    await q('UPDATE session SET last_seen_at = now() WHERE id = $1', [row.session_id]);

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

/** Profils effectifs d'un rôle : le rôle lui-même + ses alias socle. */
export function rolesOf(role) {
  return [role, ...(ROLE_ALIASES[role] || [])];
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
  // Court-circuit : administration complète de l'IMF. On s'appuie sur rolesOf()
  // afin que les RÔLES-POSTES alias d'admin_imf/direction (ex. 'superadmin' =
  // Directeur Général / DGA) bénéficient AUSSI de l'accès complet, et ne soient
  // plus bloqués sur les modules protégés par requirePermission (cause racine).
  if (user.role === 'teebo_admin') return true;
  if (rolesOf(user.role).some((p) => p === 'admin_imf' || p === 'direction')) return true;
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
  return false;
}

/**
 * Renvoie l'ensemble des clés d'habilitation EFFECTIVES d'un utilisateur :
 * surcharges user_permission (allowed) ∪ défauts du poste (matrice).
 * Sert à l'affichage des menus côté console (/me.permissions).
 */
export async function effectivePermissionKeys(user) {
  if (!user) return [];
  if (user.role === 'teebo_admin' ||
      rolesOf(user.role).some((p) => p === 'admin_imf' || p === 'direction')) {
    const all = await q(
      `SELECT permission_key FROM permission_catalog
        WHERE imf_id IS NULL OR imf_id=$1`, [user.imf_id]);
    return all.rows.map((r) => r.permission_key);
  }
  const set = new Set();
  if (user.position_code) {
    const pos = await q('SELECT permission_key FROM fn_position_default_perms($1,$2)',
      [user.imf_id, user.position_code]);
    pos.rows.forEach((r) => set.add(r.permission_key));
  }
  const over = await q(
    `SELECT permission_key, allowed FROM user_permission WHERE user_id=$1 AND imf_id=$2`,
    [user.id, user.imf_id]);
  over.rows.forEach((r) => { if (r.allowed) set.add(r.permission_key); else set.delete(r.permission_key); });
  return Array.from(set);
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
