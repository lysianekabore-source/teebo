// teebo — Catalogue des habilitations (permissions), groupé par module métier.
// 'sensitive' : action sensible (validation humaine obligatoire, jamais d'automatisation IA).
// 'forbidden' : habilitation INTERDITE — verrouillée côté serveur, impossible à activer
//               (garde-fou réglementaire BCEAO/UEMOA : pas de décaissement IA automatique).
export const CATALOG = [
  { module: 'Caisse & guichet', perms: [
    { code: 'cash.view', label: 'Consulter la caisse' },
    { code: 'cash.deposit', label: 'Enregistrer un dépôt' },
    { code: 'cash.withdraw', label: 'Enregistrer un retrait' }
  ] },
  { module: 'Collecte & tournée', perms: [
    { code: 'tour.collect', label: 'Collecter sur le terrain' },
    { code: 'tour.close', label: 'Clôturer une tournée' }
  ] },
  { module: 'Mobile Money', perms: [
    { code: 'momo.collect', label: 'Encaisser via Mobile Money' },
    { code: 'momo.view', label: 'Consulter les transactions Mobile Money' }
  ] },
  { module: 'Supervision & rapports', perms: [
    { code: 'supervisor.validate', label: 'Valider une clôture (superviseur)' },
    { code: 'report.view', label: 'Consulter les rapports de caisse' },
    { code: 'report.export', label: 'Exporter les rapports' }
  ] },
  { module: 'Clients & KYC', perms: [
    { code: 'client.view', label: 'Consulter les clients' },
    { code: 'client.create', label: 'Créer un client' },
    { code: 'client.kyc', label: 'Gérer le KYC / conformité' }
  ] },
  { module: 'Crédit (5C)', perms: [
    { code: 'credit.view', label: 'Consulter les dossiers de crédit' },
    { code: 'credit.analyze', label: 'Analyser un dossier (assisté IA)' },
    { code: 'credit.validate', label: 'Valider un crédit (humain obligatoire)', sensitive: true },
    { code: 'credit.auto_disburse', label: 'Décaissement automatique par IA', forbidden: true }
  ] },
  { module: 'Comptabilité & états BCEAO', perms: [
    { code: 'accounting.view', label: 'Consulter la comptabilité' },
    { code: 'accounting.post', label: 'Passer des écritures comptables' },
    { code: 'report.bceao', label: 'Générer les états BCEAO' }
  ] },
  { module: 'Administration', perms: [
    { code: 'user.manage', label: 'Gérer les utilisateurs' },
    { code: 'rbac.manage', label: 'Gérer les habilitations' }
  ] }
];

// Index plat { code -> {label, sensitive, forbidden, module} } pour validation rapide.
export const BY_CODE = {};
for (const grp of CATALOG) {
  for (const p of grp.perms) BY_CODE[p.code] = { ...p, module: grp.module };
}

export const isForbidden = (code) => !!(BY_CODE[code] && BY_CODE[code].forbidden);
export const exists = (code) => !!BY_CODE[code];
