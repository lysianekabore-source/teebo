// teebo — Contrôle d'accès par verbe (RBAC) + bornage du périmètre
// ---------------------------------------------------------------------------
// Miroir runtime de db/schema_v11.sql (table rbac_rule). Une autorisation =
// (rôle, ressource, verbe) -> périmètre. Le périmètre borne le cloisonnement :
//   tenant      : toute l'IMF (imf_id)
//   department  : le département de l'utilisateur
//   service     : le service de l'utilisateur
//   self        : ses propres enregistrements
// Le cloisonnement multi-tenant (imf_id) reste TOUJOURS appliqué en plus.
// ---------------------------------------------------------------------------
import { RESOURCES, VERBS, deptOfRole, serviceOfRole } from './org_structure.js';

const ADMIN_ROLES = ['superadmin', 'admin_imf', 'teebo_admin', 'direction'];

// Règles scopées : [role, resource, verb, scope]. (DOIT refléter rbac_rule.)
const SCOPED = [
  ['compliance_officer','compliance','READ','service'],['compliance_officer','compliance','WRITE','service'],
  ['compliance_officer','compliance','UPDATE','service'],['compliance_officer','compliance','VALIDATE','service'],
  ['compliance_officer','clients','READ','tenant'],['compliance_officer','operations','READ','tenant'],
  ['compliance_officer','operations','VALIDATE','tenant'],['compliance_officer','audit','READ','tenant'],
  ['compliance_officer','reports','READ','tenant'],
  ['it_admin','it_security','READ','tenant'],['it_admin','it_security','WRITE','tenant'],
  ['it_admin','it_security','UPDATE','tenant'],['it_admin','it_security','DELETE','tenant'],
  ['it_admin','users','READ','tenant'],['it_admin','users','UPDATE','tenant'],
  ['it_admin','settings','READ','tenant'],['it_admin','audit','READ','tenant'],
  ['security_engineer','it_security','READ','service'],['security_engineer','it_security','WRITE','service'],
  ['security_engineer','it_security','UPDATE','service'],['security_engineer','audit','READ','tenant'],
  ['security_engineer','operations','READ','tenant'],
  ['credit_director','credit','READ','department'],['credit_director','credit','WRITE','department'],
  ['credit_director','credit','UPDATE','department'],['credit_director','credit','DELETE','department'],
  ['credit_director','credit','VALIDATE','department'],['credit_director','recovery','READ','department'],
  ['credit_director','recovery','UPDATE','department'],['credit_director','recovery','VALIDATE','department'],
  ['credit_director','clients','READ','department'],['credit_director','reports','READ','department'],
  ['credit_analyst','credit','READ','service'],['credit_analyst','credit','WRITE','service'],
  ['credit_analyst','credit','UPDATE','service'],['credit_analyst','clients','READ','service'],
  ['credit_analyst','reports','READ','service'],
  ['recovery_agent','recovery','READ','service'],['recovery_agent','recovery','WRITE','service'],
  ['recovery_agent','recovery','UPDATE','service'],['recovery_agent','credit','READ','service'],
  ['recovery_agent','clients','READ','service'],
  ['operations_director','operations','READ','department'],['operations_director','operations','WRITE','department'],
  ['operations_director','operations','UPDATE','department'],['operations_director','operations','VALIDATE','department'],
  ['operations_director','clients','READ','department'],['operations_director','clients','WRITE','department'],
  ['operations_director','clients','UPDATE','department'],['operations_director','accounts','READ','department'],
  ['operations_director','accounts','WRITE','department'],['operations_director','accounts','UPDATE','department'],
  ['operations_director','users','READ','department'],['operations_director','reports','READ','department'],
  ['teller','operations','READ','service'],['teller','operations','WRITE','service'],
  ['teller','operations','VALIDATE','service'],['teller','clients','READ','service'],['teller','accounts','READ','service'],
  ['customer_agent','clients','READ','service'],['customer_agent','clients','WRITE','service'],
  ['customer_agent','clients','UPDATE','service'],['customer_agent','accounts','READ','service'],
  ['customer_agent','accounts','WRITE','service'],['customer_agent','operations','READ','service'],
  ['cfo','treasury','READ','department'],['cfo','treasury','WRITE','department'],['cfo','treasury','UPDATE','department'],
  ['cfo','treasury','VALIDATE','department'],['cfo','accounting','READ','department'],['cfo','accounting','UPDATE','department'],
  ['cfo','accounting','VALIDATE','department'],['cfo','reports','READ','tenant'],['cfo','settings','READ','tenant'],
  ['treasurer','treasury','READ','service'],['treasurer','treasury','WRITE','service'],['treasurer','treasury','UPDATE','service'],
  ['treasurer','accounting','READ','service'],['treasurer','reports','READ','department'],
  ['accountant','accounting','READ','service'],['accountant','accounting','WRITE','service'],
  ['accountant','accounting','UPDATE','service'],['accountant','treasury','READ','service'],['accountant','reports','READ','department'],
  ['auditor','audit','READ','tenant'],['auditor','reports','READ','tenant'],['auditor','clients','READ','tenant'],
  ['auditor','operations','READ','tenant'],['auditor','credit','READ','tenant'],['auditor','accounting','READ','tenant'],
  ['auditor','treasury','READ','tenant'],['auditor','compliance','READ','tenant'],
  ['hr_logistics_manager','hr','READ','department'],['hr_logistics_manager','hr','WRITE','department'],
  ['hr_logistics_manager','hr','UPDATE','department'],['hr_logistics_manager','hr','DELETE','department'],
  ['hr_logistics_manager','users','READ','tenant'],['hr_logistics_manager','users','WRITE','tenant'],
  ['hr_logistics_manager','users','UPDATE','tenant'],['hr_logistics_manager','reports','READ','department'],
  // --- Archetype support administratif (schema_v12) --------------------------
  ['office_staff','reports','READ','department'],['office_staff','org','READ','tenant'],
  // --- Archetypes HISTORIQUES (rétrocompatibilité runtime) --------------------
  // Postes du réseau terrain déjà en service : on borne leurs droits sur les
  // nouvelles ressources pour ne jamais élargir le périmètre existant.
  // Chef d'agence : pilote son agence (périmètre service).
  ['agency','operations','READ','service'],['agency','operations','WRITE','service'],
  ['agency','operations','UPDATE','service'],['agency','operations','VALIDATE','service'],
  ['agency','clients','READ','service'],['agency','clients','WRITE','service'],['agency','clients','UPDATE','service'],
  ['agency','accounts','READ','service'],['agency','accounts','WRITE','service'],['agency','accounts','UPDATE','service'],
  ['agency','users','READ','service'],['agency','reports','READ','department'],
  // Caissier historique = équivalent guichetier.
  ['caissier','operations','READ','service'],['caissier','operations','WRITE','service'],
  ['caissier','operations','VALIDATE','service'],['caissier','clients','READ','service'],['caissier','accounts','READ','service'],
  // Agent de collecte (collectrice) : collecte terrain, lecture client.
  ['collectrice','clients','READ','service'],['collectrice','accounts','READ','service'],
  ['collectrice','operations','READ','service'],['collectrice','operations','WRITE','service'],
  // Personnel générique (staff) : lecture opérationnelle minimale.
  ['staff','clients','READ','service'],['staff','operations','READ','service'],
  // Responsables d'unité du module objectifs.
  ['department','reports','READ','department'],['department','clients','READ','department'],
  ['service','reports','READ','service'],['service','clients','READ','service']
];

// Index : MATRIX[role][resource][verb] = scope
const MATRIX = {};
function grant(role, resource, verb, scope) {
  (MATRIX[role] ||= {});
  (MATRIX[role][resource] ||= {});
  MATRIX[role][resource][verb] = scope;
}
for (const role of ADMIN_ROLES)
  for (const res of RESOURCES) for (const v of VERBS) grant(role, res, v, 'tenant');
for (const [role, res, verb, scope] of SCOPED) grant(role, res, verb, scope);

/** Périmètre accordé à un rôle pour (resource, verb), ou null si interdit. */
export function scopeFor(role, resource, verb) {
  return MATRIX[role]?.[resource]?.[verb] || null;
}
/** Vrai si le rôle peut exécuter le verbe sur la ressource. */
export function can(role, resource, verb) {
  return Boolean(scopeFor(role, resource, verb));
}

/**
 * Clause SQL de cloisonnement à injecter (paramétrée) selon le périmètre.
 * Renvoie { clause, params } à concaténer à un WHERE existant. La colonne
 * tenant (imf_id) est TOUJOURS contrainte ; dept/service le sont selon scope.
 * @param {{role,imf_id,dept_code,service_code,id}} user
 * @param {string} scope
 * @param {object} [cols] noms de colonnes de la table ciblée
 */
export function perimeterClause(user, scope, cols = {}) {
  const c = { imf: cols.imf || 'imf_id', dept: cols.dept || 'dept_code',
    service: cols.service || 'service_code', owner: cols.owner || 'created_by' };
  const parts = [`${c.imf} = $IMF`];
  const params = { IMF: user.imf_id };
  if (scope === 'department' && user.dept_code) { parts.push(`${c.dept} = $DEPT`); params.DEPT = user.dept_code; }
  else if (scope === 'service' && user.service_code) { parts.push(`${c.service} = $SVC`); params.SVC = user.service_code; }
  else if (scope === 'self') { parts.push(`${c.owner} = $UID`); params.UID = user.id; }
  return { clause: parts.join(' AND '), params };
}

/**
 * Middleware Express : exige (resource, verb). Pose aussi req.rbacScope.
 * À placer APRÈS authenticate (req.user requis).
 */
export function requirePrivilege(resource, verb) {
  return (req, res, next) => {
    const role = req.user?.role;
    const scope = scopeFor(role, resource, verb);
    if (!scope) return res.status(403).json({ error: 'forbidden', resource, verb });
    req.rbacScope = scope;
    next();
  };
}
