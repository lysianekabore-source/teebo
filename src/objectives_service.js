/* ===================================================================
 * teebo — MODULE OBJECTIFS (service layer)
 *
 *   Hiérarchie :  DG / Chef d'agence  ->  Superviseur  ->  Collectrice
 *
 *   Règles métier portées ici :
 *     1. Affectation descendante stricte (qui peut affecter à qui).
 *     2. Contrôle de cohérence : la somme des cibles des collectrices
 *        d'un superviseur doit couvrir la cible globale qui lui est fixée.
 *     3. Roll-up temps réel : tout fait métier (dépôt, ouverture de compte)
 *        incrémente la cible de la collectrice, puis remonte automatiquement
 *        au superviseur et à la direction.
 * =================================================================== */
import { q, tx } from './db.js';
import { notifyObjectiveMilestones, notifyExpiredFailures } from './objective_notifications.js';

/* -------------------------------------------------------------------
 * 1. RÉFÉRENTIEL HIÉRARCHIQUE
 *    Chaque rôle ne voit/agit que dans son périmètre (cloisonnement IMF).
 * ------------------------------------------------------------------- */
export const ROLES = Object.freeze({
  DG: 'dg',
  SUPERVISOR: 'supervisor',
  COLLECTRICE: 'collectrice',
  ADMIN_IMF: 'admin_imf'
});

// Correspondance rôles historiques du socle -> rôles du module Objectifs.
// Permet d'utiliser le module même si les comptes existants portent encore
// les rôles 'direction' / 'agency' / 'staff'.
const ROLE_ALIASES = {
  direction: ROLES.DG,
  agency: ROLES.DG,
  service: ROLES.SUPERVISOR,
  department: ROLES.SUPERVISOR,
  staff: ROLES.COLLECTRICE,
  caissier: ROLES.COLLECTRICE
};

export function canonicalRole(role) {
  return ROLE_ALIASES[role] || role;
}

// Qui a le droit d'assigner à quel type de subordonné.
// DG -> SUPERVISOR ; SUPERVISOR -> COLLECTRICE ; COLLECTRICE -> personne.
// L'admin IMF agit au nom de l'institution : il peut tout affecter dans son IMF.
const ALLOWED_CHILD = Object.freeze({
  [ROLES.DG]: [ROLES.SUPERVISOR],
  [ROLES.SUPERVISOR]: [ROLES.COLLECTRICE],
  [ROLES.COLLECTRICE]: []
});

export const KPI_TYPES = Object.freeze(['COLLECTION_VOLUME', 'NEW_ACCOUNTS', 'RETENTION_RATE']);
export const PERIODS = Object.freeze(['DAILY', 'MONTHLY', 'QUARTERLY', 'YEARLY']);

// Unité d'affichage par défaut selon le KPI.
const KPI_UNIT = {
  COLLECTION_VOLUME: 'FCFA',
  NEW_ACCOUNTS: 'comptes',
  RETENTION_RATE: '%'
};

/* Erreur métier : porte un code stable + un message clair, exploitable côté API. */
export class ObjectiveError extends Error {
  constructor(code, message, status = 422, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/* -------------------------------------------------------------------
 * 2. UTILITAIRES DE PÉRIMÈTRE
 * ------------------------------------------------------------------- */

/** Récupère un utilisateur du même IMF (cloisonnement multi-IMF). */
export async function getUser(imfId, userId) {
  const { rows } = await q(
    `SELECT id, imf_id, full_name, code_user, role, parent_id, is_active
       FROM app_user WHERE id = $1 AND imf_id = $2`,
    [userId, imfId]
  );
  return rows[0] || null;
}

/** Enfants directs d'un agent (son équipe), cloisonné par IMF. */
export async function listDirectReports(imfId, userId) {
  const { rows } = await q(
    `SELECT id, full_name, code_user, role, parent_id
       FROM app_user
      WHERE imf_id = $1 AND parent_id = $2 AND is_active = true
      ORDER BY full_name`,
    [imfId, userId]
  );
  return rows;
}

/**
 * Contrôle d'affectation descendante.
 * Lève une erreur explicite si l'encadrant n'a pas le droit d'assigner
 * une cible au subordonné visé.
 */
export function assertCanAssign(actorRole, targetRole, actor) {
  const a = canonicalRole(actorRole);
  const t = canonicalRole(targetRole);
  // L'administrateur IMF (ou teebo) agit au nom de l'institution : il peut
  // affecter à tout profil de sa hiérarchie, sans restriction de direction.
  if (a === ROLES.ADMIN_IMF || actorRole === 'teebo_admin') return;
  const allowed = ALLOWED_CHILD[a] || [];
  if (!allowed.includes(t)) {
    throw new ObjectiveError(
      'invalid_assignment_direction',
      `Affectation interdite : un profil « ${a} » ne peut cibler que ` +
      `[${allowed.join(', ') || '—'}] ; type reçu « ${t} ».`,
      403,
      { actor_role: a, target_role: t, allowed }
    );
  }
}

/** Vérifie que `target` est bien un subordonné direct de `actor`. */
export async function assertDirectReport(imfId, actor, targetUserId) {
  const target = await getUser(imfId, targetUserId);
  if (!target) throw new ObjectiveError('user_not_found', 'Subordonné introuvable.', 404);
  if (!target.is_active) throw new ObjectiveError('user_inactive', 'Ce compte est désactivé.', 422);
  // L'admin IMF (ou teebo) agit au nom de l'institution : il n'est pas
  // soumis au rattachement parent_id, mais reste borné à sa propre IMF.
  const a = canonicalRole(actor.role);
  if (a === ROLES.ADMIN_IMF || actor.role === 'teebo_admin') return target;
  // Invariant de direction prioritaire : on vérifie d'abord que le PROFIL cible
  // est bien un subordonné autorisé (ex. superviseur -> collectrice). Ainsi une
  // affectation vers un pair (superviseur -> superviseur) est rejetée avec
  // « invalid_assignment_direction » avant le contrôle de rattachement parent_id.
  assertCanAssign(actor.role, target.role, actor);
  // Rattachement hiérarchique : le subordonné doit pointer vers l'encadrant.
  if (target.parent_id !== actor.id) {
    throw new ObjectiveError(
      'not_your_report',
      'Cet agent ne fait pas partie de votre équipe directe.',
      403,
      { target_parent_id: target.parent_id, actor_id: actor.id }
    );
  }
  return target;
}

/* -------------------------------------------------------------------
 * 3. CRÉATION DE CIBLE + CONTRÔLE DE COHÉRENCE
 * ------------------------------------------------------------------- */

function validateObjectiveInput(input) {
  const { kpi_type, target_value, start_date, end_date } = input || {};
  if (!KPI_TYPES.includes(kpi_type))
    throw new ObjectiveError('invalid_kpi_type', `KPI inconnu : « ${kpi_type} ».`, 422, { allowed: KPI_TYPES });
  const tv = Number(target_value);
  if (!Number.isFinite(tv) || tv < 0)
    throw new ObjectiveError('invalid_target_value', 'La valeur cible doit être un nombre positif.', 422);
  if (!start_date || !end_date)
    throw new ObjectiveError('missing_dates', 'Dates de début et de fin obligatoires.', 422);
  if (new Date(end_date) < new Date(start_date))
    throw new ObjectiveError('invalid_dates', 'La date de fin doit suivre la date de début.', 422);
  if (input.period && !PERIODS.includes(input.period))
    throw new ObjectiveError('invalid_period', `Période inconnue : « ${input.period} ».`, 422, { allowed: PERIODS });
}

/**
 * CONTRÔLE DE COHÉRENCE (règle phare du module).
 *
 * Quand un superviseur fixe/ajuste les cibles de ses collectrices, la SOMME
 * des cibles de son équipe (pour un KPI et une période donnés) doit être
 * SUPÉRIEURE OU ÉGALE à la cible globale qui lui a été imposée par le DG.
 *
 * @returns {{ok:true, ...}|never} — lève ObjectiveError('target_below_global').
 */
export async function checkTeamConsistency(client, opts) {
  const { imfId, supervisorId, kpiType, period, startDate, endDate } = opts;

  // 3.1 Cible globale du superviseur (posée par le DG), même KPI + période.
  const globalRes = await client.query(
    `SELECT id, target_value
       FROM objective
      WHERE imf_id = $1 AND assigned_to_user_id = $2
        AND kpi_type = $3 AND period = $4
        AND start_date = $5 AND end_date = $6
      ORDER BY created_at DESC LIMIT 1`,
    [imfId, supervisorId, kpiType, period, startDate, endDate]
  );
  const globalObjective = globalRes.rows[0];
  if (!globalObjective) {
    // Pas d'enveloppe globale posée : rien à comparer, cohérence triviale.
    return { ok: true, global_target: null, team_total: null, enforced: false };
  }

  // 3.2 Somme des cibles de l'équipe (collectrices) sur la même fenêtre.
  const teamRes = await client.query(
    `SELECT COALESCE(SUM(o.target_value), 0)::numeric AS team_total,
            COUNT(*)::int AS team_count
       FROM objective o
       JOIN app_user u ON u.id = o.assigned_to_user_id
      WHERE o.imf_id = $1
        AND u.parent_id = $2
        AND o.kpi_type = $3 AND o.period = $4
        AND o.start_date = $5 AND o.end_date = $6`,
    [imfId, supervisorId, kpiType, period, startDate, endDate]
  );
  const teamTotal = Number(teamRes.rows[0].team_total);
  const globalTarget = Number(globalObjective.target_value);

  // 3.3 Comparaison stricte : la somme doit couvrir l'enveloppe globale.
  if (teamTotal < globalTarget) {
    throw new ObjectiveError(
      'target_below_global',
      `Répartition incohérente : la somme des cibles de vos collectrices ` +
      `(${formatNum(teamTotal)} ${KPI_UNIT[kpiType] || ''}) est inférieure à ` +
      `votre objectif global (${formatNum(globalTarget)} ${KPI_UNIT[kpiType] || ''}). ` +
      `Augmentez les cibles d'équipe d'au moins ${formatNum(globalTarget - teamTotal)}.`,
      422,
      {
        global_target: globalTarget,
        team_total: teamTotal,
        missing: Number((globalTarget - teamTotal).toFixed(2)),
        kpi_type: kpiType,
        period
      }
    );
  }
  return { ok: true, global_target: globalTarget, team_total: teamTotal, enforced: true };
}

/* -------------------------------------------------------------------
 * 3bis. RÉPARTITION GROUPÉE D'ÉQUIPE (validation atomique)
 *   Le superviseur soumet en une fois les cibles de toutes ses collectrices
 *   pour un KPI/période. La somme est vérifiée AVANT toute écriture : si elle
 *   ne couvre pas l'objectif global, RIEN n'est enregistré (tout-ou-rien).
 * ------------------------------------------------------------------- */
export async function allocateTeamTargets(actor, input) {
  const { kpi_type, period = 'MONTHLY', start_date, end_date, allocations } = input || {};
  if (!KPI_TYPES.includes(kpi_type))
    throw new ObjectiveError('invalid_kpi_type', `KPI inconnu : « ${kpi_type} ».`, 422, { allowed: KPI_TYPES });
  if (!Array.isArray(allocations) || !allocations.length)
    throw new ObjectiveError('missing_allocations', 'Fournissez la liste des cibles d\'équipe.', 422);
  if (!start_date || !end_date)
    throw new ObjectiveError('missing_dates', 'Dates de début et de fin obligatoires.', 422);
  if (new Date(end_date) < new Date(start_date))
    throw new ObjectiveError('invalid_dates', 'La date de fin doit suivre la date de début.', 422);

  return tx(async (client) => {
    // 1) Cible globale de référence (posée par le DG sur ce superviseur).
    const gRes = await client.query(
      `SELECT id, target_value FROM objective
        WHERE imf_id=$1 AND assigned_to_user_id=$2 AND kpi_type=$3 AND period=$4
          AND start_date=$5 AND end_date=$6
        ORDER BY created_at DESC LIMIT 1`,
      [actor.imf_id, actor.id, kpi_type, period, start_date, end_date]
    );
    const globalObjective = gRes.rows[0];
    if (!globalObjective)
      throw new ObjectiveError('no_global_target',
        'Aucun objectif global ne vous a été fixé pour ce KPI et cette période.', 409);

    const total = allocations.reduce((s, a) => s + Number(a.target_value || 0), 0);
    const globalTarget = Number(globalObjective.target_value);
    if (total < globalTarget) {
      throw new ObjectiveError('target_below_global',
        `Répartition incohérente : la somme des cibles (${formatNum(total)}) est ` +
        `inférieure à votre objectif global (${formatNum(globalTarget)}). ` +
        `Il manque ${formatNum(globalTarget - total)}.`,
        422,
        { global_target: globalTarget, team_total: total,
          missing: Number((globalTarget - total).toFixed(2)), kpi_type, period });
    }

    // 2) Tout-ou-rien : insertion de chaque cible d'équipe.
    const inserted = [];
    for (const a of allocations) {
      const target = await assertDirectReport(actor.imf_id, actor, a.assigned_to_user_id);
      assertCanAssign(actor.role, target.role, actor);
      const r = await client.query(
        `INSERT INTO objective
           (imf_id, assigned_to_user_id, assigned_by_user_id, parent_objective_id,
            title, kpi_type, period, target_value, unit, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [actor.imf_id, a.assigned_to_user_id, actor.id, globalObjective.id,
         a.title || null, kpi_type, period, Number(a.target_value),
         a.unit || KPI_UNIT[kpi_type] || null, start_date, end_date]
      );
      inserted.push(r.rows[0]);
    }
    return {
      objectives: inserted,
      consistency: { ok: true, enforced: true, global_target: globalTarget, team_total: total }
    };
  });
}

function formatNum(n) {
  return new Intl.NumberFormat('fr-FR').format(Number(n || 0));
}

/**
 * Crée une cible (affectation descendante) avec contrôle de cohérence.
 * Transactionnelle : la cible est insérée puis, si l'auteur est un superviseur,
 * la somme de son équipe est revalidée ; en cas d'incohérence, tout est annulé.
 */
export async function createObjective(actor, input) {
  validateObjectiveInput(input);
  const targetUserId = input.assigned_to_user_id;
  const target = await assertDirectReport(actor.imf_id, actor, targetUserId);
  assertCanAssign(actor.role, target.role, actor);

  const period = input.period || 'MONTHLY';
  const out = await tx(async (client) => {
    const ins = await client.query(
      `INSERT INTO objective
         (imf_id, assigned_to_user_id, assigned_by_user_id, parent_objective_id,
          title, kpi_type, period, target_value, unit, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        actor.imf_id, targetUserId, actor.id, input.parent_objective_id || null,
        input.title || null, input.kpi_type, period, Number(input.target_value),
        input.unit || KPI_UNIT[input.kpi_type] || null,
        input.start_date, input.end_date
      ]
    );
    const created = ins.rows[0];

    // Contrôle de cohérence uniquement à la maille « superviseur d'équipe ».
    // Par défaut la règle est stricte. Le mode `draft` (brouillon) permet de
    // saisir les cibles une à une sans figer la répartition ; la validation
    // finale est alors assurée par allocateTeamTargets() (endpoint groupé).
    if (canonicalRole(actor.role) === ROLES.SUPERVISOR && input.draft !== true && input.draft !== 'true') {
      const check = await checkTeamConsistency(client, {
        imfId: actor.imf_id,
        supervisorId: actor.id,
        kpiType: input.kpi_type,
        period,
        startDate: input.start_date,
        endDate: input.end_date
      });
      return { objective: created, consistency: check };
    }
    return { objective: created, consistency: null };
  });
  return out;
}

/**
 * Met à jour une cible existante (valeur, dates, statut manuel interdit).
 * Revalide la cohérence d'équipe après modification.
 */
export async function updateObjective(actor, objectiveId, patch) {
  // NB : les colonnes DATE sont lues en texte (::text) pour éviter toute
  // dérive de fuseau horaire lors d'un aller-retour par JS (toISOString).
  const objRes = await q(
    `SELECT id, imf_id, assigned_to_user_id, assigned_by_user_id, kpi_type, period,
            target_value, current_realized_value,
            start_date::text AS start_date, end_date::text AS end_date
       FROM objective WHERE id = $1 AND imf_id = $2`,
    [objectiveId, actor.imf_id]
  );
  const obj = objRes.rows[0];
  if (!obj) throw new ObjectiveError('objective_not_found', 'Objectif introuvable.', 404);
  // Un encadrant ne modifie que les cibles qu'il a lui-même posées.
  const actorRole = canonicalRole(actor.role);
  if (obj.assigned_by_user_id !== actor.id && actorRole !== ROLES.DG && actorRole !== ROLES.ADMIN_IMF) {
    throw new ObjectiveError('forbidden', 'Vous ne pouvez modifier que les cibles que vous avez fixées.', 403);
  }
  const targetValue = patch.target_value !== undefined ? Number(patch.target_value) : Number(obj.target_value);
  if (!Number.isFinite(targetValue) || targetValue < 0)
    throw new ObjectiveError('invalid_target_value', 'Valeur cible invalide.', 422);

  return tx(async (client) => {
    const upd = await client.query(
      `UPDATE objective
          SET target_value = $1,
              title = COALESCE($2, title),
              start_date = COALESCE($3, start_date),
              end_date = COALESCE($4, end_date)
        WHERE id = $5 AND imf_id = $6
        RETURNING id, imf_id, assigned_to_user_id, assigned_by_user_id, kpi_type, period,
                  target_value, current_realized_value, status,
                  start_date::text AS start_date, end_date::text AS end_date`,
      [targetValue, patch.title ?? null, patch.start_date ?? null, patch.end_date ?? null, objectiveId, actor.imf_id]
    );
    const updated = upd.rows[0];
    // Revalidation : la baisse d'une cible d'équipe peut casser la couverture.
    // On utilise les dates renvoyées par la base (texte) — aucune conversion.
    if (actorRole === ROLES.SUPERVISOR) {
      await checkTeamConsistency(client, {
        imfId: actor.imf_id,
        supervisorId: actor.id,
        kpiType: updated.kpi_type,
        period: updated.period,
        startDate: updated.start_date,
        endDate: updated.end_date
      });
    }
    return updated;
  });
}

/* Référentiel de dates : on stocke/lit toujours la forme texte AAAA-MM-JJ
 * fournie par l'appelant ou renvoyée par la base, sans conversion JS. */
function isoDate(d) {
  if (!d) return null;
  return String(d).slice(0, 10);
}

/* -------------------------------------------------------------------
 * 4. ROLL-UP TEMPS RÉEL
 *    Un fait métier (dépôt, ouverture de compte, remboursement…) alimente la
 *    cible de la collectrice ; l'incrément remonte automatiquement le long de
 *    la chaîne parent_id (collectrice -> superviseur -> DG).
 * ------------------------------------------------------------------- */

/**
 * Incrémente la progression d'un agent pour un KPI donné.
 *
 * @param client  client pg DANS une transaction (appelé depuis operations/clients)
 * @param opts    { imfId, userId, kpiType, delta, sourceTable, sourceId, note }
 * @returns       { applied:true, events:[...] } — 1 événement par niveau hiérarchique.
 */
export async function incrementProgress(client, opts) {
  const { imfId, userId, kpiType, delta, sourceTable = null, sourceId = null, note = null } = opts;
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) return { applied: false, events: [] };
  if (!KPI_TYPES.includes(kpiType))
    throw new ObjectiveError('invalid_kpi_type', `KPI inconnu : « ${kpiType} ».`, 422);

  // 4.1 Chaîne d'agrégation : l'agent et tous ses ancêtres (via parent_id).
  const chain = await resolveChain(client, imfId, userId);

  const events = [];
  for (const node of chain) {
    // 4.2 Cible ACTIVE de ce niveau pour ce KPI (fenêtre englobant "aujourd'hui").
    //     Si aucune cible n'existe, le niveau est simplement ignoré (pas d'erreur)
    //     : l'agent peut collecter sans cible formellement posée.
    const objRes = await client.query(
      `SELECT id, target_value, current_realized_value, parent_objective_id,
              assigned_to_user_id, kpi_type, unit, start_date::text AS start_date,
              end_date::text AS end_date, status
         FROM objective
        WHERE imf_id = $1 AND assigned_to_user_id = $2 AND kpi_type = $3
          AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE
        ORDER BY created_at DESC LIMIT 1`,
      [imfId, node.id, kpiType]
    );
    const obj = objRes.rows[0];
    if (!obj) continue;

    // 4.3 Idempotence : on journalise l'événement AVANT l'incrément. La
    //     contrainte unique (objective, source_table, source_id) empêche le
    //     double comptage de la même opération métier. On utilise
    //     ON CONFLICT DO NOTHING (et non un catch d'exception) pour NE PAS
    //     avorter la transaction en cours sur doublon (erreur 25P02).
    const ev = await client.query(
      `INSERT INTO objective_progress_event
         (imf_id, objective_id, user_id, kpi_type, delta_value, source_table, source_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (objective_id, source_table, source_id)
         WHERE source_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [imfId, obj.id, node.id, kpiType, d, sourceTable, sourceId, note]
    );
    const inserted = ev.rowCount > 0;
    if (!inserted) { events.push({ level: node.id, user_id: node.id, role: canonicalRole(node.role), objective_id: obj.id, skipped: 'duplicate' }); continue; }

    // 4.4 Incrément (le trigger fn_objective_status recalcule le statut).
    const upd = await client.query(
      `UPDATE objective
          SET current_realized_value = current_realized_value + $1
        WHERE id = $2
        RETURNING id, current_realized_value, target_value, status`,
      [d, obj.id]
    );
    // 4.5 Notifications automatiques de palier (50 % / 80 % / 100 %).
    //     Idempotentes et non bloquantes : une erreur d'envoi ne doit
    //     JAMAIS faire échouer l'opération de collecte métier.
    let notified = [];
    try {
      notified = await notifyObjectiveMilestones(client, {
        imfId, objective: { ...obj, current_realized_value: upd.rows[0].current_realized_value,
          status: upd.rows[0].status }, beforeValue: obj.current_realized_value
      });
    } catch (e) { /* notification best-effort */ }

    events.push({
      level: node.id,
      role: canonicalRole(node.role),
      objective_id: upd.rows[0].id,
      current_realized_value: Number(upd.rows[0].current_realized_value),
      target_value: Number(upd.rows[0].target_value),
      status: upd.rows[0].status,
      notifications: notified
    });
  }
  return { applied: events.some((e) => !e.skipped), events };
}

/**
 * Construit la chaîne d'agrégation ascendante : [agent, parent, grand-parent…].
 * Utilise une CTE récursive bornée (anti-boucle via le chemin visité).
 */
async function resolveChain(client, imfId, userId) {
  const { rows } = await client.query(
    `WITH RECURSIVE chain AS (
        SELECT id, parent_id, role, 0 AS depth, ARRAY[id] AS path
          FROM app_user WHERE id = $1 AND imf_id = $2
        UNION ALL
        SELECT u.id, u.parent_id, u.role, c.depth + 1, c.path || u.id
          FROM app_user u JOIN chain c ON u.id = c.parent_id
         WHERE u.imf_id = $2 AND NOT (u.id = ANY(c.path)) AND c.depth < 8
     )
     SELECT id, role, depth FROM chain ORDER BY depth`,
    [userId, imfId]
  );
  return rows;
}

/**
 * Roll-up TEMPS RÉEL au niveau BRANCHE : recalcule la progression agrégée
 * de toute la lignée d'un superviseur (ou de la branche entière si
 * supervisorId est null). Renvoie les métriques consolidées.
 *
 * Utile pour un rafraîchissement forcé (ex. job de clôture, écran DG).
 */
export async function recomputeBranchRollup(imfId, { supervisorId = null } = {}) {
  return tx(async (client) => {
    // Recalcul du réalisé de chaque nœud encadrant = somme des événements de
    // ses descendants (approche "source de vérité = journal des événements").
    const { rows } = await client.query(
      `WITH RECURSIVE scope AS (
          SELECT id, parent_id, role FROM app_user
           WHERE imf_id = $1 AND ($2::uuid IS NULL OR id = $2)
          UNION ALL
          SELECT u.id, u.parent_id, u.role
            FROM app_user u JOIN scope s ON u.parent_id = s.id
           WHERE u.imf_id = $1
       )
       SELECT DISTINCT s.id, s.role FROM scope s`,
      [imfId, supervisorId]
    );
    const nodes = rows;
    const updated = [];
    for (const node of nodes) {
      const agg = await client.query(
        `WITH RECURSIVE subtree AS (
            SELECT id FROM app_user WHERE id = $1
            UNION ALL
            SELECT u.id FROM app_user u JOIN subtree st ON u.parent_id = st.id
         )
         SELECT ev.objective_id,
                COALESCE(SUM(ev.delta_value), 0)::numeric AS total
           FROM objective_progress_event ev
          WHERE ev.imf_id = $2
            AND ev.user_id IN (SELECT id FROM subtree)
          GROUP BY ev.objective_id`,
        [node.id, imfId]
      );
      for (const row of agg.rows) {
        const r = await client.query(
          `UPDATE objective SET current_realized_value = $1
            WHERE id = $2 RETURNING id, current_realized_value, target_value, status`,
          [row.total, row.objective_id]
        );
        if (r.rows[0]) updated.push(r.rows[0]);
      }
    }
    // Notifications d'échec : cibles échues non atteintes (best-effort).
    let failures = [];
    try { failures = await notifyExpiredFailures(client, imfId); } catch (e) { /* best-effort */ }
    return { updated_nodes: nodes.length, updated_objectives: updated.length, objectives: updated,
      failure_notifications: failures };
  });
}

/* -------------------------------------------------------------------
 * 5. TABLEAUX DE BORD
 * ------------------------------------------------------------------- */

/** Cibles d'un agent + progression (pour la collectrice : lecture seule). */
export async function listMyObjectives(imfId, userId) {
  const { rows } = await q(
    `SELECT o.*, ab.full_name AS assigned_by_name,
            CASE WHEN o.target_value > 0
                 THEN ROUND((o.current_realized_value / o.target_value) * 100, 2)
                 ELSE 0 END AS progress_pct
       FROM objective o
       LEFT JOIN app_user ab ON ab.id = o.assigned_by_user_id
      WHERE o.imf_id = $1 AND o.assigned_to_user_id = $2
      ORDER BY o.start_date DESC, o.created_at DESC`,
    [imfId, userId]
  );
  return rows;
}

/**
 * Tableau de bord d'un SUPERIEUR : sa propre progression + équipe temps réel.
 * Le "temps réel" provient de current_realized_value, tenu à jour par le
 * roll-up à chaque fait métier.
 */
export async function supervisorDashboard(imfId, supervisorId) {
  // Progression personnelle du superviseur (enveloppe reçue du DG).
  const own = await q(
    `SELECT o.id, o.kpi_type, o.period, o.target_value, o.current_realized_value,
            o.status, o.start_date, o.end_date, o.unit,
            CASE WHEN o.target_value > 0
                 THEN ROUND((o.current_realized_value / o.target_value) * 100, 2)
                 ELSE 0 END AS progress_pct
       FROM objective o
      WHERE o.imf_id = $1 AND o.assigned_to_user_id = $2
      ORDER BY o.start_date DESC`,
    [imfId, supervisorId]
  );

  // Progression de chaque collectrice de l'équipe.
  const team = await q(
    `SELECT u.id AS user_id, u.full_name, u.code_user,
            o.id AS objective_id, o.kpi_type, o.period, o.unit,
            o.target_value, o.current_realized_value, o.status,
            o.start_date, o.end_date,
            CASE WHEN COALESCE(o.target_value,0) > 0
                 THEN ROUND((o.current_realized_value / o.target_value) * 100, 2)
                 ELSE 0 END AS progress_pct
       FROM app_user u
       LEFT JOIN objective o
              ON o.assigned_to_user_id = u.id
             AND o.imf_id = $1
             AND o.start_date <= CURRENT_DATE AND o.end_date >= CURRENT_DATE
      WHERE u.imf_id = $1 AND u.parent_id = $2 AND u.is_active = true
      ORDER BY u.full_name, o.kpi_type`,
    [imfId, supervisorId]
  );

  // Consolidation par KPI (somme équipe) pour comparer à l'objectif global.
  const consolidated = await q(
    `SELECT g.kpi_type, g.period, g.start_date, g.end_date,
            g.target_value AS global_target,
            COALESCE(SUM(t.target_value), 0)::numeric AS team_target_sum,
            COALESCE(SUM(t.current_realized_value), 0)::numeric AS team_realized_sum,
            CASE WHEN g.target_value > 0
                 THEN ROUND((COALESCE(SUM(t.current_realized_value), 0) / g.target_value) * 100, 2)
                 ELSE 0 END AS global_progress_pct
       FROM objective g
       LEFT JOIN app_user u ON u.parent_id = g.assigned_to_user_id
       LEFT JOIN objective t
              ON t.assigned_to_user_id = u.id
             AND t.kpi_type = g.kpi_type
             AND t.period = g.period
             AND t.start_date = g.start_date
             AND t.end_date = g.end_date
      WHERE g.imf_id = $1 AND g.assigned_to_user_id = $2
      GROUP BY g.kpi_type, g.period, g.start_date, g.end_date, g.target_value
      ORDER BY g.kpi_type`,
    [imfId, supervisorId]
  );

  return { own: own.rows, team: team.rows, consolidated: consolidated.rows };
}

/** Vue consolidée d'une branche pour le DG / chef d'agence. */
export async function branchDashboard(imfId, dgId) {
  const supervisors = await q(
    `SELECT u.id AS user_id, u.full_name, u.code_user,
            o.kpi_type, o.period, o.unit, o.target_value, o.current_realized_value,
            o.status, o.start_date, o.end_date,
            CASE WHEN COALESCE(o.target_value,0) > 0
                 THEN ROUND((o.current_realized_value / o.target_value) * 100, 2)
                 ELSE 0 END AS progress_pct
       FROM app_user u
       LEFT JOIN objective o
              ON o.assigned_to_user_id = u.id AND o.imf_id = $1
             AND o.start_date <= CURRENT_DATE AND o.end_date >= CURRENT_DATE
      WHERE u.imf_id = $1 AND u.parent_id = $2 AND u.is_active = true
      ORDER BY u.full_name, o.kpi_type`,
    [imfId, dgId]
  );

  // Métriques globales de la branche : somme de TOUTES les réalisations.
  const totals = await q(
    `SELECT ok.kpi_type,
            COALESCE(SUM(ok.target_value), 0)::numeric AS total_target,
            COALESCE(SUM(ok.current_realized_value), 0)::numeric AS total_realized
       FROM objective ok
       JOIN app_user u ON u.id = ok.assigned_to_user_id
      WHERE ok.imf_id = $1 AND u.role IN ('dg','supervisor','collectrice','direction','agency','service','department','staff')
      GROUP BY ok.kpi_type`,
    [imfId]
  );
  return { supervisors: supervisors.rows, branch_totals: totals.rows };
}
