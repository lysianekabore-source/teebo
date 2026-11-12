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
r.get('/positions', authenticate, async (req, res, next) => {
  try {
    // Le socle (42 postes) porte l'appellation de son responsable hiérarchique.
    // Les postes personnalisés de l'IMF (position_catalog) sont ajoutés à la
    // suite : ils réutilisent l'appellation du poste de socle de même code.
    const base = POSITIONS.map((p) => ({
      code: p.code, label: p.label, dept: p.dept, service: p.service, role: p.role,
      level: p.level, manager: Boolean(p.manager),
      supervisesCollectors: Boolean(p.supervisesCollectors),
      needsSupervisor: Boolean(p.needsSupervisor),
      parentLabel: p.parentLabel || null, parentCodes: p.parentCodes || []
    }));
    const byCode = new Map(POSITIONS.map((p) => [p.code, p]));
    let custom = [];
    if (req.user && req.user.imf_id) {
      const { rows } = await q(
        `SELECT code,label,dept_code,service_code,role_key,hierarchy_level,is_manager,
                can_supervise_collectors,needs_supervisor,
                parent_expected_label,parent_expected_codes
           FROM position_catalog
          WHERE imf_id=$1 ORDER BY label`, [req.user.imf_id]);
      custom = rows.map((x) => {
        const socle = byCode.get(x.code);
        return {
          code: x.code, label: x.label, dept: x.dept_code, service: x.service_code,
          role: x.role_key, level: Number(x.hierarchy_level || 0),
          manager: Boolean(x.is_manager),
          supervisesCollectors: Boolean(x.can_supervise_collectors),
          needsSupervisor: Boolean(x.needs_supervisor),
          parentLabel: x.parent_expected_label || (socle ? socle.parentLabel : null) || null,
          parentCodes: (x.parent_expected_codes ? String(x.parent_expected_codes).split(',') : (socle ? socle.parentCodes : [])) || [],
          custom: true
        };
      });
    }
    res.json({ departments: DEPARTMENTS, services: SERVICES, positions: base.concat(custom) });
  } catch (e) { next(e); }
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
