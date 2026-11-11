// teebo — Structure organisationnelle fine + matrice RBAC par verbe
// ---------------------------------------------------------------------------
// Source de vérité RUNTIME de l'organisation cible : 8 départements, leurs
// services et leurs rôles métier, plus la matrice d'autorisations par VERBE
// (READ / WRITE / UPDATE / DELETE / VALIDATE) bornée à un périmètre
// (tenant / department / service / self).
//
// Ce fichier DOIT rester synchronisé avec db/schema_v11.sql (tables
// department_catalog / service_catalog / role_catalog / rbac_rule). Le
// cloisonnement multi-tenant par imf_id (= tenant_id) reste garanti côté SQL.
// ---------------------------------------------------------------------------

// --- 8 départements --------------------------------------------------------
export const DEPARTMENTS = Object.freeze([
  { code: 'DG',         label: 'Direction Générale' },
  { code: 'COMPLIANCE', label: 'Conformité (LAB-FT)' },
  { code: 'IT',         label: "Système d'Information & Sécurité" },
  { code: 'CREDIT',     label: 'Crédit' },
  { code: 'OPS',        label: 'Opérations' },
  { code: 'FINANCE',    label: 'Finance' },
  { code: 'AUDIT',      label: 'Audit Interne' },
  { code: 'HR',         label: 'Ressources Humaines & Logistique' }
]);

// --- Services par département ----------------------------------------------
export const SERVICES = Object.freeze([
  { code: 'DG_PILOTAGE',    dept: 'DG',         label: 'Pilotage stratégique' },
  { code: 'COMP_LABFT',     dept: 'COMPLIANCE', label: 'Contrôle de conformité / LAB-FT' },
  { code: 'IT_SYSTEME',     dept: 'IT',         label: 'Administration système' },
  { code: 'IT_SECURITE',    dept: 'IT',         label: 'Ingénierie sécurité' },
  { code: 'CREDIT_OCTROI',  dept: 'CREDIT',     label: 'Octroi & analyse crédit' },
  { code: 'CREDIT_RECOUV',  dept: 'CREDIT',     label: 'Recouvrement' },
  { code: 'OPS_GUICHET',    dept: 'OPS',        label: 'Guichet / Caisse' },
  { code: 'OPS_CLIENTELE',  dept: 'OPS',        label: 'Relation clientèle' },
  { code: 'FIN_TRESORERIE', dept: 'FINANCE',    label: 'Trésorerie' },
  { code: 'FIN_COMPTA',     dept: 'FINANCE',    label: 'Comptabilité' },
  { code: 'AUDIT_INSPECT',  dept: 'AUDIT',      label: 'Audit & inspection' },
  { code: 'HR_RHLOG',       dept: 'HR',         label: 'RH & Logistique' },
  // Services détaillés (nomenclature définitive, schema_v12).
  { code: 'COMP_BCEAO',       dept: 'COMPLIANCE', label: 'Réglementation BCEAO' },
  { code: 'COMP_DATA',        dept: 'COMPLIANCE', label: 'Protection des Données (LBA/FT & KYC)' },
  { code: 'IT_SUPPORT',       dept: 'IT',         label: 'Support & Infrastructures' },
  { code: 'IT_CYBER',         dept: 'IT',         label: 'Cybersécurité & Data IA' },
  { code: 'CREDIT_DIR',       dept: 'CREDIT',     label: 'Direction Crédit' },
  { code: 'CREDIT_ANALYSE',   dept: 'CREDIT',     label: 'Analyse & Octroi' },
  { code: 'CREDIT_RECOUVT',   dept: 'CREDIT',     label: 'Recouvrement & Contentieux' },
  { code: 'OPS_DIR',          dept: 'OPS',        label: 'Direction Opérations' },
  { code: 'OPS_CAISSE',       dept: 'OPS',        label: 'Caisses & Guichets' },
  { code: 'OPS_CLIENT',       dept: 'OPS',        label: 'Client & Canaux Digitaux' },
  { code: 'FIN_DIR',          dept: 'FINANCE',    label: 'Direction Finance' },
  { code: 'FIN_TRESO',        dept: 'FINANCE',    label: 'Trésorerie & Réconciliation' },
  { code: 'FIN_REPORTING',    dept: 'FINANCE',    label: 'Reporting Réglementaire' },
  { code: 'AUDIT_DIR',        dept: 'AUDIT',      label: 'Direction Audit' },
  { code: 'AUDIT_PERMANENT',  dept: 'AUDIT',      label: 'Contrôle Permanent' },
  { code: 'AUDIT_INSPECTION', dept: 'AUDIT',      label: 'Inspection & Anti-Fraude' },
  { code: 'HR_DIR',           dept: 'HR',         label: 'Direction Support' },
  { code: 'HR_PAIE',          dept: 'HR',         label: 'Paie & Administration' },
  { code: 'HR_LOGISTIQUE',    dept: 'HR',         label: 'Logistique & Patrimoine' }
]);

// --- Rôles métier (= valeurs user_role) ------------------------------------
export const ROLES = Object.freeze([
  { key: 'superadmin',          label: 'Directeur Général (SuperAdmin)',  dept: 'DG',         service: 'DG_PILOTAGE',    manager: true },
  { key: 'compliance_officer',  label: 'Responsable Conformité',          dept: 'COMPLIANCE', service: 'COMP_LABFT',     manager: true },
  { key: 'it_admin',            label: 'Administrateur Système',          dept: 'IT',         service: 'IT_SYSTEME',     manager: true },
  { key: 'security_engineer',   label: 'Ingénieur Sécurité',             dept: 'IT',         service: 'IT_SECURITE',    manager: false },
  { key: 'credit_director',     label: 'Directeur du Crédit',             dept: 'CREDIT',     service: 'CREDIT_OCTROI',  manager: true },
  { key: 'credit_analyst',      label: 'Analyste Crédit',                 dept: 'CREDIT',     service: 'CREDIT_OCTROI',  manager: false },
  { key: 'recovery_agent',      label: 'Agent de Recouvrement',           dept: 'CREDIT',     service: 'CREDIT_RECOUV',  manager: false },
  { key: 'operations_director', label: 'Directeur des Opérations',        dept: 'OPS',        service: 'OPS_GUICHET',    manager: true },
  { key: 'teller',              label: 'Guichetier / Caissier',           dept: 'OPS',        service: 'OPS_GUICHET',    manager: false },
  { key: 'customer_agent',      label: 'Chargé de Clientèle',            dept: 'OPS',        service: 'OPS_CLIENTELE',  manager: false },
  { key: 'agency',              label: "Chef d'Agence",                    dept: 'OPS',        service: 'OPS_CAISSE',     manager: true },
  { key: 'collectrice',         label: 'Agent de collecte',               dept: 'OPS',        service: 'OPS_CLIENT',     manager: false },
  { key: 'cfo',                 label: 'Directeur Financier (CFO)',       dept: 'FINANCE',    service: 'FIN_TRESORERIE', manager: true },
  { key: 'treasurer',           label: 'Trésorier',                      dept: 'FINANCE',    service: 'FIN_TRESORERIE', manager: false },
  { key: 'accountant',          label: 'Comptable',                       dept: 'FINANCE',    service: 'FIN_COMPTA',     manager: false },
  { key: 'auditor',             label: 'Auditeur Interne',                dept: 'AUDIT',      service: 'AUDIT_INSPECT',  manager: true },
  { key: 'hr_logistics_manager',label: 'Responsable RH & Logistique',     dept: 'HR',         service: 'HR_RHLOG',       manager: true },
  { key: 'office_staff',        label: 'Support administratif',           dept: 'DG',         service: 'DG_PILOTAGE',    manager: false }
]);

// --- Catalogue des POSTES (≈45) --------------------------------------------
// Chaque poste est rattaché STRICTEMENT à un département + service et mappe
// vers un rôle-archetype RBAC (role) qui fournit les permissions par défaut.
// level       = rang hiérarchique (0..100) ; validation = autorité d'approbation.
// supervisesCollectors = peut être « Superviseur » d'un agent de collecte.
// needsSupervisor      = doit être rattaché à un superviseur (Chef d'agence
//                        OU Agent de crédit).
// DOIT rester synchronisé avec db/schema_v12.sql (position_catalog).
export const POSITIONS = Object.freeze([
  // 1. Direction Générale
  { code:'POS_DG',          label:'Directeur Général (DG)',            dept:'DG',        service:'DG_PILOTAGE',    role:'superadmin',          level:100, validation:100, manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_DGA',         label:'Directeur Général Adjoint (DGA)',   dept:'DG',        service:'DG_PILOTAGE',    role:'superadmin',          level:95,  validation:95,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_ASSIST_DG',   label:'Assistante de Direction',            dept:'DG',        service:'DG_PILOTAGE',    role:'office_staff',        level:20,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  // 2. Conformité & Juridique
  { code:'POS_RESP_CONF',   label:'Responsable Conformité',            dept:'COMPLIANCE',service:'COMP_BCEAO',     role:'compliance_officer',  level:80,  validation:70,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_JURISTE',     label:'Juriste Spécialiste Microfinance',  dept:'COMPLIANCE',service:'COMP_BCEAO',     role:'compliance_officer',  level:60,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_LBAFT',       label:'Analyste LBA/FT',                    dept:'COMPLIANCE',service:'COMP_DATA',      role:'compliance_officer',  level:60,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_DPO',         label:'DPO (Data Protection Officer)',      dept:'COMPLIANCE',service:'COMP_DATA',      role:'compliance_officer',  level:60,  validation:40,  manager:false, supervisesCollectors:false, needsSupervisor:false },
  // 3. SI & Sécurité
  { code:'POS_ADMIN_SYS',   label:'Administrateur Système & Réseau',   dept:'IT',        service:'IT_SUPPORT',     role:'it_admin',            level:80,  validation:60,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_TECH_SUP',    label:'Technicien Support Informatique',    dept:'IT',        service:'IT_SUPPORT',     role:'it_admin',            level:40,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_RSSI',        label:'Responsable Sécurité des SI (RSSI)', dept:'IT',        service:'IT_CYBER',       role:'security_engineer',   level:80,  validation:60,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_DATA_SCI',    label:'Data Scientist',                     dept:'IT',        service:'IT_CYBER',       role:'security_engineer',   level:60,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  // 4. Crédit & Engagement
  { code:'POS_DIR_CREDIT',  label:'Directeur du Crédit',               dept:'CREDIT',    service:'CREDIT_DIR',     role:'credit_director',     level:80,  validation:80,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_CHEF_OCTROI', label:'Chef de Service Octroi',             dept:'CREDIT',    service:'CREDIT_ANALYSE', role:'credit_director',     level:70,  validation:70,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_ANALYSTE_CR', label:'Analyste de Crédit',                dept:'CREDIT',    service:'CREDIT_ANALYSE', role:'credit_analyst',      level:60,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_GEST_PORT',   label:'Gestionnaire de portefeuille',       dept:'CREDIT',    service:'CREDIT_ANALYSE', role:'credit_analyst',      level:55,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_AGENT_CR',    label:'Agent de Crédit',                   dept:'CREDIT',    service:'CREDIT_ANALYSE', role:'credit_analyst',      level:50,  validation:0,   manager:false, supervisesCollectors:true,  needsSupervisor:false },
  { code:'POS_RESP_RECOUV', label:'Responsable Recouvrement',           dept:'CREDIT',    service:'CREDIT_RECOUVT', role:'recovery_agent',      level:70,  validation:60,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_AGENT_RECOUV',label:'Agent de Recouvrement',              dept:'CREDIT',    service:'CREDIT_RECOUVT', role:'recovery_agent',      level:50,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_CONTENTIEUX', label:'Spécialiste Contentieux',           dept:'CREDIT',    service:'CREDIT_RECOUVT', role:'recovery_agent',      level:55,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  // 5. Opérations & Réseau
  { code:'POS_DIR_OPS',     label:'Directeur des Opérations / Réseau', dept:'OPS',       service:'OPS_DIR',        role:'operations_director', level:80,  validation:80,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_CHEF_AGENCE', label:"Chef d'Agence",                      dept:'OPS',       service:'OPS_CAISSE',     role:'agency',              level:70,  validation:60,  manager:true,  supervisesCollectors:true,  needsSupervisor:false },
  { code:'POS_CHEF_CAISSE', label:'Chef de Caisse',                     dept:'OPS',       service:'OPS_CAISSE',     role:'teller',              level:60,  validation:50,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_CAISSIER',    label:'Caissier / Guichetier',              dept:'OPS',       service:'OPS_CAISSE',     role:'teller',              level:40,  validation:10,  manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_GEST_CLIENT', label:'Gestionnaire de Clientèle',          dept:'OPS',       service:'OPS_CLIENT',     role:'customer_agent',      level:50,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_AGENT_DIGITAL',label:'Agent Support Canaux Digitaux',     dept:'OPS',       service:'OPS_CLIENT',     role:'customer_agent',      level:40,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_AGENT_COLLECTE',label:'Agent de collecte',                dept:'OPS',       service:'OPS_CLIENT',     role:'collectrice',         level:30,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:true },
  // 6. Finance, Comptabilité & Trésorerie
  { code:'POS_CFO',         label:'Directeur Financier (CFO)',          dept:'FINANCE',   service:'FIN_DIR',        role:'cfo',                 level:80,  validation:80,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_TRESORIER',   label:'Trésorier',                         dept:'FINANCE',   service:'FIN_TRESO',      role:'treasurer',           level:60,  validation:50,  manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_ANALYSTE_MM', label:'Analyste Flux Mobile Money',         dept:'FINANCE',   service:'FIN_TRESO',      role:'treasurer',           level:55,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_CHEF_COMPTA', label:'Chef Comptable',                     dept:'FINANCE',   service:'FIN_REPORTING',  role:'accountant',          level:65,  validation:60,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_COMPTABLE',   label:'Comptable',                          dept:'FINANCE',   service:'FIN_REPORTING',  role:'accountant',          level:50,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  // 7. Audit, Risques & Contrôle Interne
  { code:'POS_DIR_AUDIT',   label:"Directeur de l'Audit et des Risques",dept:'AUDIT',     service:'AUDIT_DIR',      role:'auditor',             level:80,  validation:80,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_CTRL_PERM',   label:'Contrôleur Permanent',              dept:'AUDIT',     service:'AUDIT_PERMANENT',role:'auditor',             level:60,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_AUDIT_INT',   label:'Auditeur Interne',                   dept:'AUDIT',     service:'AUDIT_PERMANENT',role:'auditor',             level:60,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_INSPECTEUR',  label:'Inspecteur',                         dept:'AUDIT',     service:'AUDIT_INSPECTION',role:'auditor',            level:60,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_FRAUDE',      label:'Analyste Fraude Technologique',      dept:'AUDIT',     service:'AUDIT_INSPECTION',role:'auditor',            level:60,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  // 8. Capital Humain & Moyens Généraux
  { code:'POS_DRH',         label:'Directeur RH & Logistique',          dept:'HR',        service:'HR_DIR',         role:'hr_logistics_manager',level:80,  validation:80,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_RESP_RH',     label:'Responsable RH',                     dept:'HR',        service:'HR_PAIE',        role:'hr_logistics_manager',level:70,  validation:60,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_GEST_PAIE',   label:'Gestionnaire de Paie',               dept:'HR',        service:'HR_PAIE',        role:'hr_logistics_manager',level:50,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_RESP_LOG',    label:'Responsable Logistique',             dept:'HR',        service:'HR_LOGISTIQUE',  role:'hr_logistics_manager',level:70,  validation:50,  manager:true,  supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_GEST_STOCK',  label:'Gestionnaire de Stock',              dept:'HR',        service:'HR_LOGISTIQUE',  role:'hr_logistics_manager',level:45,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false },
  { code:'POS_GEST_FLOTTE', label:'Gestionnaire de la Flotte',          dept:'HR',        service:'HR_LOGISTIQUE',  role:'hr_logistics_manager',level:45,  validation:0,   manager:false, supervisesCollectors:false, needsSupervisor:false }
]);

export const VERBS = Object.freeze(['READ', 'WRITE', 'UPDATE', 'DELETE', 'VALIDATE']);
export const RESOURCES = Object.freeze(['org', 'users', 'settings', 'clients',
  'accounts', 'operations', 'credit', 'recovery', 'treasury', 'accounting',
  'reports', 'compliance', 'it_security', 'hr', 'audit']);

// --- Helpers ---------------------------------------------------------------
const _roleByKey = new Map(ROLES.map((r) => [r.key, r]));
export function roleInfo(roleKey) { return _roleByKey.get(roleKey) || null; }
export function deptOfRole(roleKey) { return _roleByKey.get(roleKey)?.dept || null; }
export function serviceOfRole(roleKey) { return _roleByKey.get(roleKey)?.service || null; }
export function servicesOfDept(deptCode) { return SERVICES.filter((s) => s.dept === deptCode); }

// --- Helpers POSTES --------------------------------------------------------
const _posByCode = new Map(POSITIONS.map((p) => [p.code, p]));
export function positionInfo(code) { return _posByCode.get(code) || null; }
// Vrai si le poste tient une caisse/guichet (mouvements dans les deux sens) :
// service « Caisses & Guichets » (OPS_CAISSE) ou rôle-poste « teller »
// (Caissier, Chef de Caisse, Chef d'Agence). L'agent de collecte
// (POS_AGENT_COLLECTE, rôle « collectrice ») en est EXCLU.
export function isCashierPosition(code) {
  const p = code ? _posByCode.get(code) : null;
  if (!p) return false;
  return p.service === 'OPS_CAISSE' || p.role === 'teller';
}
export function positionsOfDept(deptCode) { return POSITIONS.filter((p) => p.dept === deptCode); }
// Un agent de collecte doit être rattaché à un Chef d'agence OU un Agent de crédit.
export function positionCanSuperviseCollectors(code) { return Boolean(_posByCode.get(code)?.supervisesCollectors); }
export function positionNeedsSupervisor(code) { return Boolean(_posByCode.get(code)?.needsSupervisor); }
