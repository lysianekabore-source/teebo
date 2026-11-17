// ===========================================================================
// teebo — VAGUE 47 : PLAN DE COMPTES D'UNE INSTITUTION DE MICROFINANCE (SFD)
// ---------------------------------------------------------------------------
// Nomenclature minimale de demarrage, classes 1 a 8 (referentiel SFD UMOA).
// Elle est semee UNE fois, a l'ouverture d'une nouvelle IMF, dans la table
// plat_compte_comptable — et jamais ecrasee si le comptable de l'institution
// l'a ensuite adaptee.
//
// ATTENTION : le plan definitif doit etre valide par le service comptable de
// l'IMF (et, le cas echeant, par la BCEAO) avant mise en production.
// ===========================================================================

/** Plan de comptes minimal (numero, intitule, sens normal). */
export const PLAN_COMPTABLE_SFD = Object.freeze([
  // --- Classe 1 : ressources durables ------------------------------------
  { numero: '101', intitule: 'Capital social', sens: 'credit' },
  { numero: '106', intitule: 'Reserves', sens: 'credit' },
  { numero: '110', intitule: 'Report a nouveau', sens: 'credit' },
  { numero: '130', intitule: 'Subventions d investissement', sens: 'credit' },
  { numero: '150', intitule: 'Emprunts et ressources affectees', sens: 'credit' },
  { numero: '160', intitule: 'Depots des membres et clients', sens: 'credit' },
  { numero: '170', intitule: 'Comptes de garantie et cautionnements recus', sens: 'credit' },

  // --- Classe 2 : emplois stables (immobilisations) -----------------------
  { numero: '201', intitule: 'Immobilisations incorporelles', sens: 'debit' },
  { numero: '210', intitule: 'Terrain', sens: 'debit' },
  { numero: '220', intitule: 'Batiments', sens: 'debit' },
  { numero: '230', intitule: 'Materiel et mobilier', sens: 'debit' },
  { numero: '240', intitule: 'Materiel informatique', sens: 'debit' },
  { numero: '250', intitule: 'Materiel roulant', sens: 'debit' },
  { numero: '280', intitule: 'Amortissements', sens: 'credit' },

  // --- Classe 3 : stocks --------------------------------------------------
  { numero: '301', intitule: 'Fournitures et petits equipements', sens: 'debit' },

  // --- Classe 4 : creances et dettes --------------------------------------
  { numero: '401', intitule: 'Credits a court terme', sens: 'debit' },
  { numero: '402', intitule: 'Credits a moyen terme', sens: 'debit' },
  { numero: '403', intitule: 'Credits a long terme', sens: 'debit' },
  { numero: '410', intitule: 'Credits impayes', sens: 'debit' },
  { numero: '411', intitule: 'Credits en contentieux', sens: 'debit' },
  { numero: '420', intitule: 'Provisions sur credits', sens: 'credit' },
  { numero: '450', intitule: 'Debiteurs divers', sens: 'debit' },
  { numero: '470', intitule: 'Crediteurs divers', sens: 'credit' },
  { numero: '475', intitule: 'Commissions et frais a payer', sens: 'credit' },

  // --- Classe 5 : tresorerie ---------------------------------------------
  { numero: '501', intitule: 'Caisse', sens: 'debit' },
  { numero: '502', intitule: 'Caisse des collecteurs', sens: 'debit' },
  { numero: '510', intitule: 'Banque locale', sens: 'debit' },
  { numero: '520', intitule: 'Comptes Mobile Money', sens: 'debit' },
  { numero: '560', intitule: 'Placements a court terme', sens: 'debit' },

  // --- Classe 6 : charges -------------------------------------------------
  { numero: '660', intitule: 'Interets verses aux membres', sens: 'debit' },
  { numero: '670', intitule: 'Charges de personnel', sens: 'debit' },
  { numero: '680', intitule: 'Charges externes', sens: 'debit' },
  { numero: '690', intitule: 'Dotations aux amortissements et provisions', sens: 'debit' },

  // --- Classe 7 : produits ------------------------------------------------
  { numero: '701', intitule: 'Interets et commissions sur credits', sens: 'credit' },
  { numero: '702', intitule: 'Commissions de collecte et de tenue de compte', sens: 'credit' },
  { numero: '710', intitule: 'Produits divers', sens: 'credit' },

  // --- Classe 8 : resultat ------------------------------------------------
  { numero: '890', intitule: 'Resultat de l exercice', sens: 'credit' }
]);

/**
 * Ecrit le plan de comptes d'une institution, sans jamais casser son
 * demarrage : si la table n'est pas encore installee, on ignore.
 * Idempotent : relancer ne cree pas de doublons.
 */
export async function semerPlanComptable(c, imfId) {
  const bilan = [];
  const ignore = [];
  for (const compte of PLAN_COMPTABLE_SFD) {
    try {
      await c.query(
        `INSERT INTO plat_compte_comptable (imf_id, numero, intitule, sens)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [imfId, compte.numero, compte.intitule, compte.sens]);
      bilan.push(compte.numero);
    } catch (e) {
      // Table/colonne differente selon l'anciennete de la base : on tente une
      // variante minimale, puis on passe au compte suivant.
      try {
        await c.query(
          'INSERT INTO plat_compte_comptable (imf_id, numero, intitule) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [imfId, compte.numero, compte.intitule]);
        bilan.push(compte.numero);
      } catch (e2) {
        ignore.push(compte.numero);
      }
    }
  }
  return { crees: bilan.length, ignores: ignore.length };
}

export const PLAN_COMPTABLE_INFO = Object.freeze({
  source: 'Nomenclature SFD UMOA (classe 1 a 8) — plan minimal de demarrage',
  comptes: PLAN_COMPTABLE_SFD.length,
  validation_requise: 'A valider par le service comptable de l IMF (et la BCEAO) avant production.'
});

export default { PLAN_COMPTABLE_SFD, semerPlanComptable, PLAN_COMPTABLE_INFO };
