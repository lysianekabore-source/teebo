import { q } from './db.js';

/**
 * Cycle de vie de l'abonnement IMF (essai 30 jours) :
 *  - Essai : J1 -> J30. À partir de J25, un bandeau compte les jours restants
 *    et invite l'IMF à contacter teebo.
 *  - J31 (essai échu, non activé) : l'application se désactive ; tous les
 *    utilisateurs ET l'admin IMF sont bloqués sur un écran informatif.
 *  - Une fois le mode choisi activé par teebo, l'accès est permanent.
 */
export const TRIAL_DAYS = 30;
export const BANNER_FROM_DAY = 25;

export async function getSubscription(imfId) {
  const { rows } = await q('SELECT * FROM subscription WHERE imf_id = $1', [imfId]);
  return rows[0] || null;
}

/** S'assure qu'une ligne d'abonnement existe (idempotent) à partir de l'IMF. */
export async function ensureSubscription(imfId) {
  const { rows } = await q('SELECT * FROM subscription WHERE imf_id = $1', [imfId]);
  if (rows.length) return rows[0];
  const imf = (await q('SELECT trial_started_at, trial_ends_at, status FROM imf WHERE id=$1', [imfId])).rows[0];
  const status = imf && imf.status === 'active' ? 'active' : 'trial';
  const ins = await q(
    `INSERT INTO subscription(imf_id, status, trial_started_at, trial_ends_at)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [imfId, status, imf ? imf.trial_started_at : null, imf ? imf.trial_ends_at : null]
  );
  return ins.rows[0];
}

/** Calcule l'état d'accès (bloqué ou non) et le bandeau éventuel. */
export function computeState(sub) {
  const out = { locked: false, reason: null, banner: null, days_left: null,
    status: sub ? sub.status : 'trial' };
  if (!sub) return out;
  if (sub.status === 'active') return out;
  if (sub.status === 'disabled') { out.locked = true; out.reason = 'trial_expired'; return out; }

  const ends = sub.trial_ends_at ? new Date(sub.trial_ends_at) : null;
  if (!ends) return out;
  const msLeft = ends.getTime() - Date.now();
  const daysLeft = Math.max(0, Math.ceil(msLeft / 86400000));
  out.days_left = daysLeft;

  if (msLeft <= 0) {
    // Essai échu : application désactivée (J31).
    out.locked = true;
    out.reason = 'trial_expired';
    out.status = 'disabled';
    return out;
  }
  const elapsed = TRIAL_DAYS - daysLeft; // jour courant de l'essai (1 -> 30)
  if (elapsed >= BANNER_FROM_DAY) {
    out.banner = {
      days_left: daysLeft,
      message: `Il vous reste ${daysLeft} jour${daysLeft > 1 ? 's' : ''} d’essai gratuit. ` +
        `Contactez teebo pour activer votre formule et éviter la désactivation de l’application.`,
      contact: { whatsapp: '+22650321432', email: 'hello@teebo.africa' }
    };
  }
  return out;
}

/**
 * Middleware : applique le blocage J31 et attache l'état d'essai à req.trial.
 * À monter après `authenticate`, avant les routes métier IMF.
 */
export async function enforceSubscription(req, res, next) {
  try {
    if (!req.user || req.user.role === 'teebo_admin') { req.trial = { locked: false }; return next(); }
    const sub = await ensureSubscription(req.user.imf_id);
    const state = computeState(sub);
    req.trial = state;
    if (state.locked) {
      return res.status(402).json({ error: 'trial_expired', locked: true,
        message: 'Votre essai gratuit de 30 jours est terminé. L’application est désactivée. Contactez teebo pour activer votre formule.',
        contact: { whatsapp: '+22650321432', email: 'hello@teebo.africa' } });
    }
    next();
  } catch (e) { next(e); }
}
