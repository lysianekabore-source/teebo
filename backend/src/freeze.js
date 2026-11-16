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

/* ==========================================================================
 * GEL D'URGENCE (LCB-FT) — VAGUE 32, 14/11/2026
 * --------------------------------------------------------------------------
 * Le gel automatique ci-dessus répare un défaut de suivi commercial. Ce BLOC
 * est tout autre chose : c'est une MESURE CONSERVATOIRE immédiate, déclenchée
 * par la conformité, un soupçon de blanchiment, une réquisition judiciaire ou
 * une correspondance sur une liste de sanctions (GAFI / BCEAO / UE / ONU).
 *
 * Caractéristiques :
 *  - effet IMMÉDIAT (aucune attente, aucune confirmation du superviseur) ;
 *  - couvre le client PAR IDENTIFIANT ou PAR LISTE (nom, pièce, téléphone,
 *    numéro de compte) : un appel peut geler plusieurs clients d'un coup ;
 *  - chaque gel produit un événement client_freeze_event de type
 *    'emergency' (immuable, jamais supprimé) + une ligne d'audit ;
 *  - idempotent : re-geler un client déjà gelé ne crée pas de doublon ;
 *  - refuse de geler un client d'une autre IMF (cloisonnement).
 * ========================================================================== */

/** Rôles autorisés à prononcer un gel d'urgence. */
export const EMERGENCY_FREEZE_ROLES = ['admin_imf', 'direction', 'department', 'service', 'teebo_admin'];

/** Normalise un texte pour comparaison aux listes (majuscules, sans accents). */
export function normalizeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Gèle IMMÉDIATEMENT un ou plusieurs clients.
 *
 * @param {object} p
 *   p.imfId            IMF concernée (cloisonnement strict)
 *   p.clientIds        tableau d'identifiants clients (ou p.clientId unique)
 *   p.motif            motif lisible (obligatoire)
 *   p.source           'sanctions' | 'judiciaire' | 'conformite' | 'manuel'
 *   p.reference        référence externe (n° de réquisition, liste…)
 *   p.actorId          auteur de la décision
 *   p.actorRole        rôle de l'auteur
 *   p.freezeListId     ligne de liste de sanctions à l'origine (optionnel)
 * @returns {{geles:Array, dejaGeles:Array, introuvables:Array, total:number}}
 */
export async function freezeClientImmediately(p = {}) {
  const imfId = p.imfId;
  const ids = Array.isArray(p.clientIds) ? p.clientIds.filter(Boolean)
    : (p.clientId ? [p.clientId] : []);

  if (!imfId) {
    const e = new Error('Gel impossible : institution non précisée.');
    e.status = 400; e.code = 'missing_institution';
    throw e;
  }
  if (!ids.length) {
    const e = new Error('Gel impossible : aucun client désigné.');
    e.status = 400; e.code = 'no_client_selected';
    throw e;
  }
  const motif = String(p.motif || '').trim();
  if (motif.length < 5) {
    const e = new Error('Gel impossible : le motif doit être renseigné (5 caractères minimum).');
    e.status = 400; e.code = 'motif_requis'; e.expose = true;
    throw e;
  }

  const source = ['sanctions', 'judiciaire', 'conformite', 'manuel'].includes(p.source)
    ? p.source : 'manuel';

  return tx(async (c) => {
    const geles = [];
    const dejaGeles = [];
    const introuvables = [];

    for (const id of ids) {
      // FOR UPDATE : deux gels simultanés ne se chevauchent pas.
      const cl = (await c.query(
        'SELECT * FROM client WHERE id=$1 AND imf_id=$2 FOR UPDATE',
        [id, imfId])).rows[0];
      if (!cl) { introuvables.push(id); continue; }
      if (isFrozen(cl)) {
        dejaGeles.push({ client_id: cl.id, code_client: cl.code_client, full_name: cl.full_name,
          frozen_at: cl.frozen_at, frozen_reason: cl.frozen_reason });
        continue;
      }

      await c.query(
        `UPDATE client SET frozen_at=now(), frozen_reason=$2, frozen_by=$3,
                frozen_auto=false, is_frozen=true
          WHERE id=$1`,
        [cl.id, motif, p.actorId || null]);

      await c.query(
        `INSERT INTO client_freeze_event(imf_id, client_id, kind, status, acted_by,
                reason, note, resolved_at)
         VALUES ($1,$2,'emergency','clos',$3,$4,$5, now())`,
        [imfId, cl.id, p.actorId || null, motif,
         'Gel d’urgence — source : ' + source +
         (p.reference ? ' — référence : ' + p.reference : '')]);

      // Journal d'audit (append-only) : trace indélébile de la décision.
      await c.query(
        `INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
         VALUES ($1,$2,'client.emergency_freeze','client',$3,$4::jsonb)`,
        [imfId, p.actorId || null, cl.id, JSON.stringify({
          code_client: cl.code_client, full_name: cl.full_name,
          motif, source, reference: p.reference || null,
          actor_role: p.actorRole || null, freeze_list_id: p.freezeListId || null,
          at: new Date().toISOString()
        })]);

      geles.push({ client_id: cl.id, code_client: cl.code_client,
        full_name: cl.full_name, frozen_at: new Date().toISOString() });
    }

    return { geles, dejaGeles, introuvables, total: geles.length };
  });
}

/**
 * GEL PAR LISTE : recherche les clients de l'IMF correspondant à une liste de
 * sanctions (nom, pièce, téléphone, compte) puis applique freezeClientImmediately
 * à chacun. C'est le point d'entrée pour une liste externe (GAFI/BCEAO).
 */
export async function freezeFromSanctionsList({ imfId, entries = [], motif, actorId, actorRole }) {
  if (!Array.isArray(entries) || !entries.length) {
    const e = new Error('Aucune entrée de liste fournie.');
    e.status = 400; e.code = 'empty_list'; e.expose = true;
    throw e;
  }
  const matched = new Set();
  const details = [];
  for (const e of entries) {
    const kind = e.kind || 'nom';
    const raw = String(e.valeur || '').trim();
    if (!raw) continue;

    let rows = [];
    if (kind === 'nom') {
      // Comparaison normalisée (accents/casse) côté SQL via fn_normalise.
      rows = (await q(
        `SELECT id FROM client WHERE imf_id=$1 AND fn_normalise(full_name) LIKE '%'||fn_normalise($2)||'%'`,
        [imfId, raw])).rows;
    } else if (kind === 'piece') {
      rows = (await q('SELECT id FROM client WHERE imf_id=$1 AND id_number=$2', [imfId, raw])).rows;
    } else if (kind === 'telephone') {
      rows = (await q('SELECT id FROM client WHERE imf_id=$1 AND phone=$2', [imfId, raw])).rows;
    } else if (kind === 'compte') {
      rows = (await q(
        'SELECT client_id AS id FROM account WHERE imf_id=$1 AND code_account=$2', [imfId, raw])).rows;
    }
    for (const r of rows) { matched.add(r.id); details.push({ id: r.id, matched_by: kind, valeur: raw }); }
  }

  if (!matched.size) return { geles: [], dejaGeles: [], introuvables: [], total: 0, matched: [] };
  const res = await freezeClientImmediately({
    imfId, clientIds: [...matched], motif: motif || 'Correspondance liste de sanctions',
    source: 'sanctions', actorId, actorRole
  });
  return { ...res, matched: details };
}

export { DAYS_FR };
