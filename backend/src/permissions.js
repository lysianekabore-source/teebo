// teebo — Matrice des profils & habilitations par défaut
// ---------------------------------------------------------------------------
// Complète habilitations.js (groupes de rôles côté routes) par une matrice
// LISIBLE et PERSISTABLE : chaque rôle reçoit, à la création d'un utilisateur
// IMF, un jeu d'habilitations par défaut (table user_permission).
//
// Cette matrice est consultable à la fois par l'administrateur IMF (espace IMF)
// et par l'administrateur teebo (console), comme référentiel commun.
//
// Les clés (slugs) sont stables : elles servent de permission_key en base.
// Le cloisonnement par IMF reste garanti côté requête SQL (imf_id).

// --- Domaines d'habilitation (ordre d'affichage) ---------------------------
export const PERMISSIONS = Object.freeze([
  { key: 'org.manage',          label: 'Organisation — créer / supprimer des unités' },
  { key: 'users.manage',        label: 'Personnel — créer des comptes & envoyer les codes' },
  { key: 'settings.manage',     label: 'Paramètres IMF & mentions légales' },
  { key: 'visibility.manage',   label: 'Autorisations fines inter-entités' },
  { key: 'objectives.set',      label: 'Objectifs — créer / répartir' },
  { key: 'objectives.dashboard',label: 'Objectifs — tableau de bord équipe' },
  { key: 'objectives.read',     label: 'Objectifs — consulter' },
  { key: 'clients.enroll',      label: 'Enrôlement des clients' },
  { key: 'round.view',          label: 'Tournée du jour (collecte)' },
  { key: 'cash.declare',        label: 'Déclaration des versements' },
  { key: 'cash.validate',       label: 'Validation des versements' },
  { key: 'reports.read',        label: 'Consultation des relevés & rapports' }
]);

// --- Rôles IMF présentés dans la matrice -----------------------------------
export const MATRIX_ROLES = Object.freeze([
  { key: 'admin_imf',  label: 'Administrateur IMF' },
  { key: 'direction',  label: 'Direction' },
  { key: 'department', label: 'Département' },
  { key: 'service',    label: 'Service' },
  { key: 'agency',     label: 'Agence' },
  { key: 'staff',      label: 'Personnel / collectrice' },
  { key: 'caissier',   label: 'Caissier' }
]);

// --- Habilitations par défaut, par rôle ------------------------------------
// Aligne les groupes de habilitations.js (ADMIN / SUPERVISION / FIELD / CASHIER)
// sur des clés de domaine persistables.
const ALL = PERMISSIONS.map((p) => p.key);
const SUPERVISION = ['objectives.set', 'objectives.dashboard', 'objectives.read',
  'clients.enroll', 'round.view', 'cash.validate', 'reports.read'];

export const ROLE_DEFAULTS = Object.freeze({
  admin_imf:  ALL.slice(),
  direction:  ALL.slice(),
  department: SUPERVISION.slice(),
  service:    SUPERVISION.slice(),
  agency:     SUPERVISION.concat(['users.manage']),
  staff:      ['objectives.read', 'clients.enroll', 'round.view', 'cash.declare'],
  caissier:   ['cash.declare', 'cash.validate', 'objectives.read', 'reports.read'],
  // Alias du module objectifs (tolérance).
  dg:          ALL.slice(),
  supervisor:  SUPERVISION.slice(),
  collectrice: ['objectives.read', 'clients.enroll', 'round.view', 'cash.declare']
});

/** Renvoie la liste des clés d'habilitation accordées par défaut à un rôle. */
export function defaultPermissionKeysForRole(role) {
  return (ROLE_DEFAULTS[role] || []).slice();
}

/**
 * Construit la matrice complète pour l'affichage (rôles × domaines).
 * @returns {{permissions, roles, grid}} grid[roleKey][permKey] = booleen
 */
export function buildProfilesMatrix() {
  const grid = {};
  for (const r of MATRIX_ROLES) {
    const granted = new Set(defaultPermissionKeysForRole(r.key));
    grid[r.key] = {};
    for (const p of PERMISSIONS) grid[r.key][p.key] = granted.has(p.key);
  }
  return { permissions: PERMISSIONS, roles: MATRIX_ROLES, grid };
}
