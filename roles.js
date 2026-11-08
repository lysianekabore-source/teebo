// teebo — Modèles d'habilitations par rôle (préremplissage en un clic).
// L'application d'un modèle est toujours INTERSECTÉE avec le périmètre autorisé
// par teebo pour l'IMF, et exclut les habilitations interdites.
export const ROLE_TEMPLATES = {
  collectrice: {
    label: 'Collectrice',
    perms: ['tour.collect', 'momo.collect', 'momo.view', 'client.view']
  },
  superviseur: {
    label: 'Superviseur',
    perms: ['supervisor.validate', 'report.view', 'report.export', 'tour.close', 'momo.view', 'client.view']
  },
  guichet: {
    label: 'Agent de guichet / caissier',
    perms: ['cash.view', 'cash.deposit', 'cash.withdraw', 'client.view', 'client.create']
  },
  comptable: {
    label: 'Comptable',
    perms: ['accounting.view', 'accounting.post', 'report.bceao', 'report.view']
  },
  agent_credit: {
    label: 'Agent de crédit',
    // Analyse assistée, mais PAS la validation (réservée au responsable — humain).
    perms: ['credit.view', 'credit.analyze', 'client.view', 'client.kyc']
  },
  responsable_credit: {
    label: 'Responsable crédit',
    perms: ['credit.view', 'credit.analyze', 'credit.validate', 'client.view']
  },
  admin_imf: {
    label: 'Administrateur IMF',
    perms: ['user.manage', 'rbac.manage', 'report.view', 'report.export', 'client.view', 'accounting.view']
  }
};

export const roleList = () =>
  Object.keys(ROLE_TEMPLATES).map((k) => ({ key: k, label: ROLE_TEMPLATES[k].label, perms: ROLE_TEMPLATES[k].perms }));
