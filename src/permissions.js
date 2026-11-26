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
  ...['read','manage','dg','confidentiel','notes.publish','resolutions.verify'].map(k=>({key:'sec.'+k,label:'Secrétariat — '+k,access_kind:k==='read'?'lecture':'ecriture'})),
  {key:'cms.manage',label:'Communication — studio et publications',access_kind:'ecriture'},
  {key:'cms.leads.read',label:'Communication — rappels attribués',access_kind:'lecture'},
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
  { key: 'reports.read',        label: 'Consultation des relevés & rapports', access_kind: 'lecture' },
  { key: 'credit.validate_final', label: 'Crédit — écran de VALIDATION FINALE (octroi)', access_kind: 'validation' },
  // --- Habilitations socle complémentaires (schema_v14) -----------------
  { key: 'org.read',            label: 'Organisation — consulter l’arborescence', access_kind: 'lecture' },
  { key: 'users.read',          label: 'Personnel — consulter l’annuaire', access_kind: 'lecture' },
  { key: 'access.manage',       label: 'Habilitations — administrer la matrice & les postes', access_kind: 'validation' },
  { key: 'audit.read',          label: 'Audit — consulter la piste d’audit', access_kind: 'lecture' },
  { key: 'clients.read',        label: 'Clients — consulter les dossiers', access_kind: 'lecture' },
  { key: 'clients.manage',      label: 'Clients — modifier les dossiers (KYC)', access_kind: 'ecriture' },
  { key: 'clients.freeze',      label: 'Clients — geler / dégeler un compte', access_kind: 'validation' },
  { key: 'round.manage',        label: 'Collecte — organiser les tournées', access_kind: 'ecriture' },
  { key: 'cash.approve',        label: 'Caisse — approuver les versements/retraits', access_kind: 'validation' },
  { key: 'collecte.assign',     label: 'Collecte — affecter les collectrices', access_kind: 'ecriture' },
  { key: 'collecte.supervise',  label: 'Collecte — superviser les encaissements', access_kind: 'lecture' },
  { key: 'savings.read',        label: 'Épargne — consulter les comptes', access_kind: 'lecture' },
  { key: 'savings.manage',      label: 'Épargne — ouvrir / paramétrer les comptes', access_kind: 'ecriture' },
  { key: 'operations.read',     label: 'Opérations — consulter', access_kind: 'lecture' },
  { key: 'operations.write',    label: 'Opérations — saisir', access_kind: 'ecriture' },
  { key: 'operations.validate', label: 'Opérations — valider / contre-passer', access_kind: 'validation' },
  { key: 'accounts.manage',     label: 'Comptabilité — tenir les comptes & écritures', access_kind: 'ecriture' },
  { key: 'vault.manage',        label: 'Coffre / Trésorerie — mouvements de caisse & coffre', access_kind: 'validation' },
  { key: 'fees.manage',         label: 'Tarification — frais & commissions', access_kind: 'ecriture' },
  { key: 'credit.read',         label: 'Crédit — consulter les dossiers', access_kind: 'lecture' },
  { key: 'credit.initiate',     label: 'Crédit — initier une demande', access_kind: 'ecriture' },
  { key: 'credit.process',      label: 'Crédit — instruire / analyser', access_kind: 'ecriture' },
  { key: 'credit.recovery',     label: 'Crédit — recouvrement & contentieux', access_kind: 'ecriture' },
  { key: 'reports.export',      label: 'Rapports — exporter (PDF / tableur)', access_kind: 'ecriture' },
  { key: 'compliance.read',     label: 'Conformité — consulter les alertes LBC/FT', access_kind: 'lecture' },
  { key: 'compliance.manage',   label: 'Conformité — traiter les déclarations', access_kind: 'validation' },
  { key: 'devices.read',        label: 'Terminaux — consulter le parc', access_kind: 'lecture' },
  { key: 'devices.manage',      label: 'Terminaux — enrôler / révoquer', access_kind: 'ecriture' },
  { key: 'security.read',       label: 'Sécurité — consulter les journaux de connexion', access_kind: 'lecture' }
]);

// Postes désignés par défaut pour l'écran de VALIDATION FINALE du crédit.
// Réaffectable librement par l'administrateur IMF (surcharge en base, voir
// position_default_permission / schema_v13). Référence lisible côté serveur.
export const DEFAULT_CREDIT_FINAL_VALIDATOR_POSITIONS = Object.freeze([
  'POS_DG', 'POS_DGA', 'POS_DIR_CREDIT', 'POS_CHEF_OCTROI'
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

// Profils d'encadrement (département / service) : supervision + consultation de
// la structure, de l'annuaire et du parc de terminaux de leur périmètre. Aucun
// droit de création de comptes ni de paramétrage de l'IMF.
const ENCADREMENT = SUPERVISION.concat(['org.read', 'users.read', 'devices.read', 'security.read']);

// VAGUE 47 — la direction n'est plus « tout ouvert » : elle conserve la
// consultation, l'export et les validations, mais n'hérite plus de la gestion
// du personnel, de la structure, des paramètres ni de la matrice des droits
// (c'est le rôle propre de l'administrateur de l'IMF).
const DIRECTION_KEYS = ALL.filter((k) => ![
  'users.manage', 'access.manage', 'org.manage', 'settings.manage'
].includes(k));
// Profil PCA : la supervision seule (lecture + validations), sans aucune
// habilitation d'écriture financière ni de gestion. Il ne gère ni la caisse,
// ni les clients, ni le personnel, ni les droits.
const PCA_KEYS = ALL.filter((k) => ![
  'users.manage', 'access.manage', 'org.manage', 'settings.manage',
  'clients.enroll', 'clients.manage', 'clients.freeze',
  'round.manage', 'round.view', 'cash.declare', 'cash.validate', 'cash.approve',
  'collecte.assign', 'collecte.supervise', 'savings.manage',
  'operations.write', 'operations.validate', 'accounts.manage',
  'vault.manage', 'fees.manage', 'credit.initiate', 'credit.process',
  'credit.recovery', 'credit.validate_final', 'compliance.manage',
  'devices.manage', 'objectives.set', 'objectives.dashboard'
].includes(k));

export const ROLE_DEFAULTS = Object.freeze({
  admin_imf:  ALL.slice(),
  direction:  DIRECTION_KEYS,
  // Profil technique du poste « Président du Conseil d'Administration ».
  pca_admin:  PCA_KEYS,
  department: ENCADREMENT.slice(),
  service:    ENCADREMENT.slice(),
  // CORRECTIF 18/11/2026 — « le chef d'agence a les mêmes menus que
  // l'administrateur de l'IMF ». Le profil Agence recevait « users.manage »
  // (créer des comptes, renvoyer les codes) : il pouvait donc gérer le
  // personnel, ce qui est le rôle propre de l'administrateur de l'IMF.
  // Désormais l'agence CONSULTE l'organisation et l'annuaire de son périmètre
  // (org.read, users.read) sans jamais créer ni modifier un compte.
  agency:     SUPERVISION.concat(['org.read', 'users.read']),

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
