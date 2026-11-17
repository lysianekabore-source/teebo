// teebo — MATRICE D'HABILITATION (source de vérité unique)
// -------------------------------------------------------------------------
// Ce fichier centralise les droits par profil. Les routes et le service
// objectifs importent ces groupes au lieu de redéclarer des listes de rôles.
//
// Conventions de nommage des profils (enum user_role) :
//   teebo_admin  : éditeur teebo (console d'approbation des IMF)
//   admin_imf    : administrateur de l'IMF cliente (droits étendus)
//   direction    : Direction générale de l'IMF (vue consolidée)
//   department   : Chef de département (encadrement)
//   service      : Chef de service (encadrement)
//   agency       : Chef d'agence (encadrement)
//   staff        : Agent / collectrice terrain
//   caissier     : Caissier (déclaration/validation des versements)
//
// Profils « module objectifs » (alias modernes) :
//   dg           -> équivaut à direction/agency
//   supervisor   -> équivaut à department/service
//   collectrice  -> équivaut à staff
//
// Règle d'or : le cloisonnement par IMF est assuré côté requête SQL
// (imf_id = req.user.imf_id). Aucun rôle ne franchit cette frontière,
// sauf teebo_admin.

// --- Profils de haut niveau ------------------------------------------------
export const PROFILES = Object.freeze({
  TEEBO_ADMIN: 'teebo_admin',
  ADMIN_IMF: 'admin_imf',
  DIRECTION: 'direction',
  DEPARTMENT: 'department',
  SERVICE: 'service',
  AGENCY: 'agency',
  STAFF: 'staff',
  CAISSIER: 'caissier'
});

// --- Groupes de rôles réutilisables ---------------------------------------

// Console éditeur teebo uniquement.
export const TEEBO_CONSOLE = ['teebo_admin'];

// Administration complète de l'IMF (gestion des comptes + unités).
export const ADMIN = ['admin_imf', 'direction'];

// Encadrement : pose des cibles, valide les opérations sensibles.
export const SUPERVISION = ['admin_imf', 'direction', 'department', 'service', 'agency'];

// Lecture étendue : tout le personnel autorisé à consulter le domaine.
export const READ = ['admin_imf', 'direction', 'department', 'service', 'agency', 'staff', 'caissier'];

// Terrain : agents et collectrices.
export const FIELD = ['staff', 'caissier'];

// Caisse : déclare et valide les versements.
export const CASHIER = ['admin_imf', 'direction', 'caissier'];

// --- Groupes dédiés au MODULE OBJECTIFS -----------------------------------
// Encadrants susceptibles de poser des cibles (rôles socle + rôles module).
export const OBJ_MANAGERS = ['admin_imf', 'direction', 'agency', 'department', 'service', 'dg', 'supervisor'];

// Tous les profils pouvant lire/consulter les objectifs (dont la collectrice).
export const OBJ_READERS = ['admin_imf', 'direction', 'agency', 'department', 'service', 'staff',
                            'caissier', 'dg', 'supervisor', 'collectrice'];

// Vision consolidée de la branche (DG / chef d'agence).
export const OBJ_BRANCH = ['admin_imf', 'direction', 'agency', 'dg'];

// --- Matrice lisible (pour documentation et tests) ------------------------
// Chaque clé = un domaine ; chaque valeur = la liste des profils autorisés.
export const MATRIX = Object.freeze({
  'Console éditeur (approbations IMF)': TEEBO_CONSOLE,
  'Gestion des comptes & unités': ADMIN,
  'Objectifs — créer / répartir / modifier': OBJ_MANAGERS,
  'Objectifs — consulter (les siens)': OBJ_READERS,
  'Objectifs — tableau de bord équipe': OBJ_MANAGERS,
  'Objectifs — vue consolidée branche': OBJ_BRANCH,
  'Objectifs — progression (collecte / compte)': OBJ_READERS,
  'Objectifs — progression (rétention)': OBJ_MANAGERS,
  'Tournée du jour': READ,
  'Enrôlement clients': READ,
  'Déclaration versements': CASHIER,
  'Validation versements': CASHIER,
  'Autorisations fines': ADMIN
});

/**
 * Vérifie qu'un rôle appartient à un groupe donné (tolérant aux alias).
 * @param {string} role    rôle effectif de l'utilisateur
 * @param {string[]} group groupe de rôles autorisés
 * @returns {boolean}
 */
export function inGroup(role, group) {
  return group.includes(role);
}
