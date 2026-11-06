/* teebo — Logique de gel / dégel des clients (tournée de collecte).
 *
 *  Règles métier :
 *   - Un client qui n’a pas été visité pendant 1 mois (30 jours) est GELÉ
 *     automatiquement. Toute nouvelle opération sur son compte est bloquée.
 *   - Le dégel est prononcé par le SUPERVISEUR, après avoir demandé à la
 *     collectrice d’expliquer (client par client) les raisons du gel ; ou à la
 *     demande motivée de la collectrice.
 */
import { q, tx } from './db.js';

/** Nombre de jours sans visite déclenchant le gel automatique. */
export const FREEZE_AFTER_DAYS = 30;

/** Rôles habilités à dégeler (supervision). */
export const SUP_ROLES = ['admin_imf', 'direction', 'department', 'service'];

/** Vrai si le client est actuellement gelé. */
export function isFrozen(row) {
  return !!(row && (row.frozen_at || row.is_frozen === true));
}

/** Libellé lisible d’un jour de la semaine (0 = dimanche). */
const DAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/**
 * Programme de collecte effectif d’un client, éventuellement filtré sur un jour.
 * Renvoie la ligne de client_schedule active la plus récente.
 */
export async function getSchedule(clientId) {
  const { rows } = await q(
    `SELECT * FROM client_schedule WHERE client_id=$1 AND is_active=true
      ORDER BY updated_at DESC LIMIT 1`, [clientId]);
  return rows[0] || null;
}

/** Vrai si le programme prévoit un passage le jour `dow` (0 = dimanche). */
export function scheduleCoversDay(schedule, dow) {
  if (!schedule) return false;
  if (Array.isArray(schedule.weekdays) && schedule.weekdays.includes(dow)) return true;
  if (schedule.frequency === 'mensuel' && schedule.day_of_month) {
    const dom = new Date().getDate();
    return Number(schedule.day_of_month) === dom;
  }
  if (schedule.frequency === 'libre') return true;
  return false;
}

/**
 * Détecte les clients non visités depuis FREEZE_AFTER_DAYS jours et les gèle.
 * Écrit un événement `auto_freeze` pour chaque client nouvellement gelé.
 * Renvoie la liste des clients gelés lors de cet appel.
 */
export async function runFreezeSweep(imfId) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT c.id, c.full_name, c.code_client,
              COALESCE(c.last_visit_at,
                       (SELECT MAX(visited_at) FROM collection_round_visit v WHERE v.client_id=c.id),
                       c.created_at) AS ref_at
         FROM client c
        WHERE c.imf_id=$1
          AND c.frozen_at IS NULL
          AND c.is_frozen = false
          AND COALESCE(c.last_visit_at,
                       (SELECT MAX(visited_at) FROM collection_round_visit v WHERE v.client_id=c.id),
                       c.created_at) < now() - ($2 || ' days')::interval`,
      [imfId, String(FREEZE_AFTER_DAYS)]);
    const frozen = [];
    for (const cl of rows) {
      const days = Math.floor((Date.now() - new Date(cl.ref_at).getTime()) / 86400000);
      await c.query(
        `UPDATE client SET frozen_at=now(), frozen_reason=$2, frozen_auto=true,
                frozen_since_days=$3, is_frozen=true
          WHERE id=$1`,
        [cl.id, `Aucune visite depuis ${days} jours (gel automatique après ${FREEZE_AFTER_DAYS} j).`, days]);
      await c.query(
        `INSERT INTO client_freeze_event(imf_id, client_id, kind, status, reason, note)
         VALUES ($1,$2,'auto_freeze','clos',$3,$4)`,
        [imfId, cl.id, `Gel automatique : aucune visite depuis ${days} jours.`,
         'En attente d’explication de la collectrice puis décision du superviseur.']);
      frozen.push({ client_id: cl.id, code_client: cl.code_client, full_name: cl.full_name, days });
    }
    return frozen;
  });
}

/**
 * Dégèle un client. Prononcé par un superviseur, ou sur décision après
 * explication de la collectrice. Écrit l’événement correspondant.
 *   actorRole : rôle de celui qui agit (superviseur ou système).
 *   requestOrigin : 'superviseur' | 'collectrice' (demande motivée).
 */
export async function unfreezeClient({ imfId, clientId, actorId, actorRole, reason, explanation, collectriceId }) {
  return tx(async (c) => {
    const cl = (await c.query('SELECT * FROM client WHERE id=$1 AND imf_id=$2 FOR UPDATE',
      [clientId, imfId])).rows[0];
    if (!cl) return { notFound: true };
    if (!isFrozen(cl)) return { alreadyActive: true };

    // Le superviseur peut dégeler ; une demande motivée de la collectrice passe
    // par un événement « unfreeze_request » traité par le superviseur.
    await c.query(
      `UPDATE client SET frozen_at=NULL, frozen_reason=NULL, frozen_by=NULL,
              frozen_auto=false, frozen_since_days=NULL, is_frozen=false
        WHERE id=$1`, [clientId]);
    const ev = (await c.query(
      `INSERT INTO client_freeze_event(imf_id, client_id, kind, status, acted_by, answered_by,
              reason, explanation, resolved_at)
       VALUES ($1,$2,'unfreeze','clos',$3,$4,$5,$6, now()) RETURNING *`,
      [imfId, clientId, actorId || null, collectriceId || null, reason || null, explanation || null])).rows[0];
    return { client: cl, event: ev, actor_role: actorRole || null };
  });
}

/**
 * Filtre de sécurité : lève une erreur métier (…_blocked) si le client est gelé.
 * Utilisé avant toute écriture d’opération/demande.
 */
export async function assertClientNotFrozen(imfId, clientId) {
  if (!clientId) return null;
  const { rows } = await q('SELECT id, is_frozen, frozen_at, frozen_reason FROM client WHERE id=$1 AND imf_id=$2',
    [clientId, imfId]);
  if (!rows.length) return null;
  if (isFrozen(rows[0])) {
    const e = new Error('Client gelé : opérations et demandes bloquées jusqu’au dégel par le superviseur.');
    e.status = 409; e.code = 'client_frozen';
    e.detail = { frozen_reason: rows[0].frozen_reason, frozen_at: rows[0].frozen_at };
    throw e;
  }
  return rows[0];
}

export { DAYS_FR };
