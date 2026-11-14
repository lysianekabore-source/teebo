/* ===================================================================
 * teebo — MODULE OBJECTIFS : routes HTTP
 *
 *   POST   /objectives                     créer une cible (affectation descendante)
 *   PATCH  /objectives/:id                 ajuster une cible + revalidation
 *   GET    /objectives/mine                mes cibles (collectrice : lecture seule)
 *   GET    /objectives/dashboard           tableau de bord superviseur (temps réel)
 *   GET    /objectives/branch-dashboard    vue consolidée DG / chef d'agence
 *   GET    /objectives/team/:supervisorId  équipe d'un superviseur
 *   GET    /objectives/kpi-types           référentiels (KPI, périodes, unités)
 *   POST   /objectives/recompute           force le recalcul du roll-up branche
 *
 *   POST   /operations/deposit             (hook) incrémente le réalisé
 *   POST   /clients/new                    (hook) nouveaux comptes
 * =================================================================== */
import { Router } from 'express';
import { habilit } from '../rbac_strict.js';
import { requireRole } from '../auth.js';
import {
  ROLES, canonicalRole, KPI_TYPES, PERIODS, ObjectiveError,
  createObjective, updateObjective, listMyObjectives,
  supervisorDashboard, branchDashboard, listDirectReports,
  recomputeBranchRollup, incrementProgress, allocateTeamTargets, getUser
} from '../objectives_service.js';

import { OBJ_MANAGERS, OBJ_READERS, OBJ_BRANCH } from '../habilitations.js';

const r = Router();

// Groupes de droits centralisés (voir habilitations.js = source de vérité).
const MANAGERS = OBJ_MANAGERS;
const READERS = OBJ_READERS;

/* Erreur métier -> réponse JSON propre et homogène. */
function sendError(res, e) {
  if (e instanceof ObjectiveError) {
    return res.status(e.status).json({
      error: e.code, message: e.message, details: e.details || undefined
    });
  }
  throw e;
}

/* ----------------------------- Référentiels ------------------------------ */

r.get('/objectives/kpi-types', requireRole(...READERS), (_req, res) => {
  res.json({
    kpi_types: KPI_TYPES,
    periods: PERIODS,
    units: { COLLECTION_VOLUME: 'FCFA', NEW_ACCOUNTS: 'comptes', RETENTION_RATE: '%' },
    roles: Object.values(ROLES)
  });
});

/* ------------------------------- Création -------------------------------- */

r.post('/objectives', requireRole(...MANAGERS), habilit('objectives.set'), async (req, res, next) => {
  try {
    const out = await createObjective(req.user, req.body || {});
    res.status(201).json({
      ok: true,
      objective: out.objective,
      consistency: out.consistency
    });
  } catch (e) { try { sendError(res, e); } catch (x) { next(x); } }
});

/* ------------------------------- Mise à jour ----------------------------- */
r.patch('/objectives/:id', requireRole(...MANAGERS), async (req, res, next) => {
  try {
    const out = await updateObjective(req.user, req.params.id, req.body || {});
    res.json({ ok: true, objective: out });
  } catch (e) { try { sendError(res, e); } catch (x) { next(x); } }
});

/* -------------------- Répartition groupée d'équipe (atomique) ------------ */

/**
 * Le superviseur soumet en une fois la répartition de son objectif global
 * entre ses collectrices. La somme est vérifiée avant écriture : si elle ne
 * couvre pas l'objectif global, rien n'est enregistré (tout-ou-rien).
 */
r.post('/objectives/team-allocations', requireRole(...MANAGERS), async (req, res, next) => {
  try {
    const out = await allocateTeamTargets(req.user, req.body || {});
    res.status(201).json({ ok: true, ...out });
  } catch (e) { try { sendError(res, e); } catch (x) { next(x); } }
});

/* --------------------------- Mes cibles (lecture) ------------------------ */

r.get('/objectives/mine', requireRole(...READERS), async (req, res, next) => {
  try {
    res.json({ objectives: await listMyObjectives(req.user.imf_id, req.user.id) });
  } catch (e) { next(e); }
});

/* --------------------------- Tableau de bord ----------------------------- */

/** Tableau de bord du superviseur : sa progression + celle de son équipe. */
r.get('/objectives/dashboard', requireRole(...MANAGERS), async (req, res, next) => {
  try {
    // Un superviseur voit SON tableau ; un DG ou l'admin IMF peut demander
    // celui d'un superviseur précis (dans le périmètre de l'IMF).
    const me = canonicalRole(req.user.role);
    let supervisorId = req.user.id;
    if (req.query.supervisor_id && (me === ROLES.DG || me === ROLES.ADMIN_IMF || req.user.role === 'admin_imf')) {
      // On vérifie que la cible est bien un encadrant de la même IMF.
      const target = await getUser(req.user.imf_id, req.query.supervisor_id);
      if (!target) return res.status(404).json({ error: 'user_not_found' });
      if (canonicalRole(target.role) !== ROLES.SUPERVISOR)
        return res.status(422).json({ error: 'not_a_supervisor' });
      supervisorId = req.query.supervisor_id;
    }
    const dash = await supervisorDashboard(req.user.imf_id, supervisorId);
    res.json({
      generated_at: new Date().toISOString(),
      supervisor_id: supervisorId,
      ...dash
    });
  } catch (e) { next(e); }
});

/** Vue consolidée d'une branche (DG / chef d'agence). */
r.get('/objectives/branch-dashboard', requireRole(...OBJ_BRANCH), async (req, res, next) => {
  try {
    const dash = await branchDashboard(req.user.imf_id, req.user.id);
    res.json({ generated_at: new Date().toISOString(), ...dash });
  } catch (e) { next(e); }
});

/** Équipe directe d'un encadrant (liste des subordonnés + cibles courantes). */
r.get('/objectives/team/:supervisorId', requireRole(...MANAGERS), async (req, res, next) => {
  try {
    const su = req.params.supervisorId;
    // Un superviseur ne consulte que sa propre équipe ; le DG / l'admin IMF, n'importe quelle équipe de l'IMF.
    const me = canonicalRole(req.user.role);
    if (me === ROLES.SUPERVISOR && su !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    res.json({ team: await listDirectReports(req.user.imf_id, su) });
  } catch (e) { next(e); }
});

/* --------------------- Recalcul forcé du roll-up branche ----------------- */

r.post('/objectives/recompute', requireRole(...OBJ_BRANCH), async (req, res, next) => {
  try {
    const out = await recomputeBranchRollup(req.user.imf_id, {
      supervisorId: req.body && req.body.supervisor_id ? req.body.supervisor_id : null
    });
    res.json({ ok: true, ...out });
  } catch (e) { next(e); }
});

/* -------------------------------------------------------------------
 * HOOKS DE ROLL-UP TEMPS RÉEL
 *   Ces points d'entrée sont appelés par les modules métier (opérations,
 *   clients). Ils incrémentent la cible de la collectrice et remontent la
 *   progression à toute la lignée. Idempotents via source_id.
 * ------------------------------------------------------------------- */

/** Enregistre une réalisation de collecte (volume FCFA). */
r.post('/objectives/progress/collection', requireRole(...READERS), async (req, res, next) => {
  try {
    const { amount_fcfa, source_id, note, user_id } = req.body || {};
    const amt = Number(amount_fcfa);
    if (!Number.isFinite(amt) || amt <= 0)
      return res.status(422).json({ error: 'invalid_amount', message: 'Montant invalide.' });
    const targetUser = (canonicalRole(req.user.role) === ROLES.COLLECTRICE)
      ? req.user.id
      : (user_id || req.user.id);
    // Transaction : journal + incréments de toute la chaîne.
    const { tx } = await import('../db.js');
    const out = await tx((client) => incrementProgress(client, {
      imfId: req.user.imf_id,
      userId: targetUser,
      kpiType: 'COLLECTION_VOLUME',
      delta: amt,
      sourceTable: 'operation',
      sourceId: source_id || null,
      note: note || null
    }));
    res.json({ ok: true, ...out });
  } catch (e) { try { sendError(res, e); } catch (x) { next(x); } }
});

/** Enregistre l'ouverture d'un nouveau compte (KPI NEW_ACCOUNTS). */
r.post('/objectives/progress/new-account', requireRole(...READERS), async (req, res, next) => {
  try {
    const { source_id, note, user_id } = req.body || {};
    const targetUser = (canonicalRole(req.user.role) === ROLES.COLLECTRICE)
      ? req.user.id
      : (user_id || req.user.id);
    const { tx } = await import('../db.js');
    const out = await tx((client) => incrementProgress(client, {
      imfId: req.user.imf_id,
      userId: targetUser,
      kpiType: 'NEW_ACCOUNTS',
      delta: 1,
      sourceTable: 'account',
      sourceId: source_id || null,
      note: note || null
    }));
    res.json({ ok: true, ...out });
  } catch (e) { try { sendError(res, e); } catch (x) { next(x); } }
});

/** Met à jour un taux de rétention (KPI RETENTION_RATE) — valeur absolue en %. */
r.post('/objectives/progress/retention', requireRole(...MANAGERS), async (req, res, next) => {
  try {
    const { retention_rate, source_id, note, user_id } = req.body || {};
    const rate = Number(retention_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100)
      return res.status(422).json({ error: 'invalid_rate', message: 'Le taux doit être entre 0 et 100.' });
    const { tx } = await import('../db.js');
    const out = await tx((client) => incrementProgress(client, {
      imfId: req.user.imf_id,
      userId: user_id || req.user.id,
      kpiType: 'RETENTION_RATE',
      delta: rate,
      sourceTable: 'retention',
      sourceId: source_id || null,
      note: note || null
    }));
    res.json({ ok: true, ...out });
  } catch (e) { try { sendError(res, e); } catch (x) { next(x); } }
});

/** Liste les notifications d'objectif (les miennes ou tout le périmètre pour un encadrant). */
r.get('/objectives/notifications', requireRole(...READERS), async (req, res, next) => {
  try {
    const { q } = await import('../db.js');
    const isManager = MANAGERS.includes(req.user.role);
    const scopeOwner = isManager && req.query.user_id ? req.query.user_id : req.user.id;
    const { rows } = await q(
      `SELECT n.id, n.objective_id, n.user_id, n.event, n.threshold, n.status,
              n.payload, n.created_at, o.kpi_type, o.unit,
              o.target_value, o.current_realized_value, u.full_name
         FROM objective_notification n
         JOIN objective o ON o.id = n.objective_id
         JOIN app_user u ON u.id = n.user_id
        WHERE n.imf_id = $1 AND ($2::uuid IS NULL OR n.user_id = $2)
        ORDER BY n.created_at DESC LIMIT 200`,
      [req.user.imf_id, isManager && !req.query.user_id ? null : scopeOwner]
    );
    res.json({ ok: true, notifications: rows });
  } catch (e) { next(e); }
});

export default r;
