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

/** RBAC : liste de rôles autorisés. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}
