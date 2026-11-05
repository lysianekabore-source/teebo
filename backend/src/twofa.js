import crypto from 'crypto';
import { q, tx } from './db.js';
import { generateSecret, verifyTotp, otpauthUri, generateRecoveryCodes, hashRecoveryCode } from './totp.js';
import { hashToken } from './auth.js';

/**
 * Double authentification (2FA / « authenticator ») — TOTP RFC 6238.
 *
 * Politique : la double authentification (TOTP) est OBLIGATOIRE pour TOUS les
 * comptes, quel que soit le rôle (direction, cadres, caissiers, agents de
 * terrain, administrateur éditeur). Une fois activée, la connexion exige le
 * mot de passe PUIS un code à 6 chiffres.
 */

const ISSUER = process.env.TEEBO_2FA_ISSUER || 'teebo';
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const CHALLENGE_TTL_MINUTES = 5;

/** Rôles qui doivent activer la 2FA (obligatoire). */
export const PRIVILEGED_ROLES = ['admin_imf', 'direction', 'department', 'service', 'agency', 'cashier', 'teller', 'staff', 'field_agent', 'teebo_admin'];

export function isPrivileged(role) { return PRIVILEGED_ROLES.includes(role); }

/**
 * La 2FA est requise pour TOUS les comptes, tous rôles confondus.
 * (TEEBO_2FA_OPTIONAL permet uniquement de désactiver l'exigence en
 * environnement de test ; en production elle reste obligatoire.)
 */
export function is2faRequired(role) {
  if (process.env.TEEBO_2FA_OPTIONAL === 'true') return false;
  return true;
}

/** État 2FA d'un utilisateur (jamais le secret en clair hors enrôlement). */
export async function getStatus(userId) {
  const { rows } = await q(
    `SELECT enabled, confirmed_at, created_at, (array_length(recovery_codes,1)) AS recovery_count
       FROM user_2fa WHERE user_id=$1`, [userId]);
  if (!rows.length) return { enabled: false, enrolled: false, recovery_count: 0 };
  const r = rows[0];
  return { enabled: !!r.enabled, enrolled: true, confirmed_at: r.confirmed_at,
    recovery_count: r.recovery_count || 0 };
}

/** Démarre l'enrôlement : génère un secret + URI otpauth (non encore confirmé). */
export async function startEnrollment(user) {
  const secret = generateSecret();
  const uri = otpauthUri({ secret, account: user.email || user.code_user || user.full_name, issuer: ISSUER });
  await q(
    `INSERT INTO user_2fa(user_id, imf_id, secret_base32, enabled)
     VALUES ($1,$2,$3,false)
     ON CONFLICT (user_id) DO UPDATE
        SET secret_base32=EXCLUDED.secret_base32, enabled=false,
            confirmed_at=NULL, recovery_codes='{}', updated_at=now()`,
    [user.id, user.imf_id, secret]);
  return { secret, otpauth_uri: uri, issuer: ISSUER };
}

/**
 * Confirme l'enrôlement avec un premier code, active la 2FA et renvoie les
 * codes de secours (affichés une seule fois).
 */
export async function confirmEnrollment(userId, code) {
  const { rows } = await q('SELECT * FROM user_2fa WHERE user_id=$1', [userId]);
  if (!rows.length) { const e = new Error('Aucun enrôlement en cours.'); e.status = 400; e.code = 'no_enrollment'; throw e; }
  const row = rows[0];
  const v = verifyTotp(row.secret_base32, code);
  if (!v.ok) { const e = new Error('Code invalide. Vérifiez l’heure de votre téléphone et réessayez.'); e.status = 400; e.code = 'invalid_code'; throw e; }
  const clear = generateRecoveryCodes();
  const hashed = clear.map(hashRecoveryCode);
  await q(
    `UPDATE user_2fa SET enabled=true, confirmed_at=now(), last_totp_at=now(),
            recovery_codes=$2, failed_attempts=0, locked_until=NULL, updated_at=now()
      WHERE user_id=$1`, [userId, hashed]);
  return { enabled: true, recovery_codes: clear };
}

/** Désactive la 2FA (nécessite le mot de passe — vérifié dans la route). */
export async function disable(userId) {
  await q(`UPDATE user_2fa SET enabled=false, confirmed_at=NULL, recovery_codes='{}',
                  updated_at=now() WHERE user_id=$1`, [userId]);
  return { enabled: false };
}

/** Vérifie un code TOTP pour un utilisateur (verrouillage anti-bruteforce). */
export async function verifyForUser(userId, code) {
  const { rows } = await q('SELECT * FROM user_2fa WHERE user_id=$1', [userId]);
  if (!rows.length || !rows[0].enabled) return { ok: false, code: 'not_enabled' };
  const row = rows[0];
  if (row.locked_until && new Date(row.locked_until) > new Date())
    return { ok: false, code: 'locked', locked_until: row.locked_until };

  const v = verifyTotp(row.secret_base32, code);
  if (v.ok) {
    // Anti-rejeu : on mémorise le DÉBUT DE PÉRIODE (créneau de 30 s) du code
    // accepté. Un second code tombant dans le MÊME créneau est refusé (il a
    // déjà servi) ; un code du créneau suivant reste accepté normalement.
    const slotMs = (v.counter != null ? v.counter : Math.floor(Date.now() / 30000)) * 30000;
    if (row.last_totp_at && new Date(row.last_totp_at).getTime() === slotMs)
      return { ok: false, code: 'replay' };
    await q('UPDATE user_2fa SET last_totp_at=$2, failed_attempts=0, updated_at=now() WHERE user_id=$1',
      [userId, new Date(slotMs)]);
    return { ok: true };
  }
  // Tentative échouée : incrément + verrouillage éventuel.
  const attempts = Number(row.failed_attempts || 0) + 1;
  const locked = attempts >= MAX_FAILED;
  await q(`UPDATE user_2fa SET failed_attempts=$2, locked_until=$3, updated_at=now() WHERE user_id=$1`,
    [userId, locked ? 0 : attempts, locked ? new Date(Date.now() + LOCK_MINUTES * 60000) : null]);
  return { ok: false, code: locked ? 'locked' : 'invalid_code', attempts_left: locked ? 0 : MAX_FAILED - attempts };
}

/** Vérifie un code de secours (usage unique). */
export async function verifyRecoveryCode(userId, code) {
  const { rows } = await q('SELECT * FROM user_2fa WHERE user_id=$1 AND enabled=true', [userId]);
  if (!rows.length) return { ok: false, code: 'not_enabled' };
  const h = hashRecoveryCode(code);
  const list = rows[0].recovery_codes || [];
  if (!list.includes(h)) return { ok: false, code: 'invalid_code' };
  const rest = list.filter((x) => x !== h);
  await q('UPDATE user_2fa SET recovery_codes=$2, updated_at=now() WHERE user_id=$1', [userId, rest]);
  return { ok: true, remaining: rest.length };
}

/* ------------------- Défi de connexion (après mot de passe) ---------------- */

/** Crée un défi 2FA et renvoie le token opaque à renvoyer au client. */
export async function createChallenge(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q(
    `INSERT INTO login_challenge(user_id, imf_id, token_hash, expires_at)
     VALUES ($1,$2,$3, now() + interval '${CHALLENGE_TTL_MINUTES} minutes')`,
    [user.id, user.imf_id, hashToken(token)]);
  return { token, expires_in: CHALLENGE_TTL_MINUTES * 60 };
}

/** Consomme un défi (une seule fois) et renvoie l'utilisateur associé. */
export async function consumeChallenge(token) {
  const hash = hashToken(token);
  return tx(async (c) => {
    const ch = (await c.query(
      `SELECT lc.*, u.id AS uid, u.imf_id, u.role, u.email, u.full_name, u.code_user,
              u.password_set_at, u.must_change_password, u.is_active
         FROM login_challenge lc JOIN app_user u ON u.id = lc.user_id
        WHERE lc.token_hash=$1 FOR UPDATE`, [hash])).rows[0];
    if (!ch) { const e = new Error('Défi 2FA introuvable.'); e.status = 401; e.code = 'invalid_challenge'; throw e; }
    if (ch.consumed) { const e = new Error('Défi 2FA déjà utilisé.'); e.status = 401; e.code = 'challenge_used'; throw e; }
    if (new Date(ch.expires_at) < new Date()) { const e = new Error('Défi 2FA expiré.'); e.status = 401; e.code = 'challenge_expired'; throw e; }
    await c.query('UPDATE login_challenge SET consumed=true, attempts=attempts+1 WHERE id=$1', [ch.id]);
    return { user: { id: ch.uid, imf_id: ch.imf_id, role: ch.role, email: ch.email,
      full_name: ch.full_name, code_user: ch.code_user, password_set_at: ch.password_set_at,
      must_change_password: ch.must_change_password, is_active: ch.is_active } };
  });
}

/** Nettoie les défis expirés (appelable à l'occasion). */
export async function purgeChallenges(imfId = null) {
  await q(`DELETE FROM login_challenge WHERE expires_at < now() - interval '1 day'
           AND ($1::uuid IS NULL OR imf_id=$1)`, [imfId]);
}
