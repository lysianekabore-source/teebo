// teebo — Routes : structure organisationnelle, matrice RBAC, piste d'audit
// ---------------------------------------------------------------------------
// Expose le référentiel (8 départements / services / rôles) et la matrice
// d'autorisations par verbe, permet à un administrateur d'IMF de matérialiser
// la structure dans son arbre org_unit, et de consulter le journal d'audit
// immuable. Tout est cloisonné par imf_id (= tenant).
// ---------------------------------------------------------------------------
import { Router } from 'express';
import { q } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { DEPARTMENTS, SERVICES, ROLES, VERBS, RESOURCES, POSITIONS } from '../org_structure.js';
import { scopeFor, requirePrivilege } from '../rbac.js';

const r = Router();

// --- Référentiel complet (lecture authentifiée) ----------------------------
r.get('/structure', authenticate, (_req, res) => {
  res.json({ departments: DEPARTMENTS, services: SERVICES, roles: ROLES });
});

// --- Catalogue des POSTES (regroupé département › service) -------------------
// Sert à peupler la liste déroulante « Poste occupé » côté interface.
r.get('/positions', authenticate, (_req, res) => {
  res.json({ departments: DEPARTMENTS, services: SERVICES, positions: POSITIONS });
});

// --- Matrice RBAC (rôles × ressources × verbes -> périmètre) ----------------
r.get('/structure/rbac', authenticate, (_req, res) => {
  const grid = {};
  for (const role of ROLES) {
    grid[role.key] = {};
    for (const resource of RESOURCES) {
      grid[role.key][resource] = {};
      for (const verb of VERBS) grid[role.key][resource][verb] = scopeFor(role.key, resource, verb);
    }
  }
  res.json({ verbs: VERBS, resources: RESOURCES, roles: ROLES.map((x) => x.key), grid });
});

// --- Matérialisation de la structure dans l'arbre org_unit du tenant --------
r.post('/structure/seed', authenticate, requireRole('superadmin', 'admin_imf', 'direction', 'teebo_admin'),
  async (req, res, next) => {
    try {
      await q('SELECT fn_seed_org_structure($1)', [req.user.imf_id]);
      const { rows } = await q(
        `SELECT kind, code_unit, name FROM org_unit
           WHERE imf_id = $1 AND kind IN ('direction','department','service')
           ORDER BY kind, name`, [req.user.imf_id]);
      res.json({ ok: true, units: rows });
    } catch (e) { next(e); }
  });

// --- Journal d'audit immuable (anti-fraude) --------------------------------
// Lecture réservée aux profils habilités sur la ressource 'audit'.
r.get('/audit-log', authenticate, requirePrivilege('audit', 'READ'), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { rows } = await q(
      `SELECT id, actor_id, actor_role, department, service, action,
              entity, entity_id, created_at
         FROM audit_log
        WHERE imf_id = $1
        ORDER BY created_at DESC
        LIMIT $2`, [req.user.imf_id, limit]);
    res.json({ entries: rows });
  } catch (e) { next(e); }
});

export default r;
