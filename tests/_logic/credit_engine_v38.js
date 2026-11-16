// ===========================================================================
// teebo — VAGUE 38 : MOTEUR DE CRÉDIT (logique pure, sans base de données)
// ---------------------------------------------------------------------------
// Tout est calculé en ENTIERS DE CENTIMES FCFA : jamais de flottant sur de
// l'argent. Les arrondis sont décidés une fois pour toutes (au centime près)
// et le dernier échéancier absorbe l'écart afin que :
//     somme(capital) == montant net financé
//     somme(échéances) == total à payer
//
// Contenu :
//   1. Produits : contrôle des paramètres (méthode, périodicité, différé).
//   2. Échéancier : DEGRESSIF (annuités constantes), LINEAIRE (linéaire
//      constant), IN_FINE ; différé (grâce) en intérêts ou en capital.
//   3. TEG : taux effectif global par actualisation (TRI), conforme à la
//      méthode BCEAO (frais de dossier + assurance intégrés aux flux).
//   4. Imputation d'un remboursement : pénalités -> intérêts -> capital.
//   5. Pénalités de retard, jours de retard, déclassement BCEAO et provision.
//   6. PAR 30 / PAR 90.
// ===========================================================================

/** Durée d'une période exprimée en années (360 jours conventionnels BCEAO). */
export const JOURS_AN = 360;

export const METHODES = Object.freeze(['DEGRESSIF', 'LINEAIRE', 'IN_FINE']);
export const PERIODICITES = Object.freeze({
  HEBDOMADAIRE: { libelle: 'Hebdomadaire', jours: 7, parAn: 52 },
  BIMENSUELLE: { libelle: 'Bimensuelle', jours: 15, parAn: 24 },
  MENSUELLE: { libelle: 'Mensuelle', jours: 30, parAn: 12 },
  TRIMESTRIELLE: { libelle: 'Trimestrielle', jours: 90, parAn: 4 }
});
export const CLASSES_CREANCE = Object.freeze(['SAIN', 'IMMOBILISE', 'DOUTEUX', 'LITIGIEUX']);
export const TYPES_GARANTIE = Object.freeze(['EPARGNE_BLOQUEE', 'CAUTION_SOLIDAIRE',
  'NANTISSEMENT', 'HYPOTHEQUE', 'AVAL', 'GAGE_VEHICULE', 'STOCK', 'AUTRE']);
export const CANAUX_REMBOURSEMENT = Object.freeze(['TERRAIN_CASH', 'GUICHET',
  'ORANGE_MONEY', 'MOOV_MONEY', 'WAVE', 'INTEROP_BCEAO', 'VIREMENT_EPARGNE']);
export const STATUTS_DOSSIER = Object.freeze(['BROUILLON', 'EN_ANALYSE', 'EN_COMITE',
  'APPROUVE', 'REJETE', 'DECAISSE', 'CLOTURE_SOLDE', 'ANNULE']);

/** Erreur métier : code stable + message en français + statut HTTP. */
export class CreditError extends Error {
  constructor(code, message, detail = null, status = 422) {
    super(message);
    this.name = 'CreditError';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

/* ========================================================================
 *  OUTILS NUMÉRIQUES
 * ===================================================================== */
/** Entier de centimes strict : refuse les flottants (jamais d'arrondi muet). */
export function entier(valeur, champ = 'montant') {
  if (valeur === null || valeur === undefined || valeur === '') {
    throw new CreditError('montant_absent', 'Le ' + champ + ' est obligatoire.', { champ }, 400);
  }
  if (typeof valeur === 'number') {
    if (!Number.isFinite(valeur)) {
      throw new CreditError('montant_invalide', 'Le ' + champ + ' est illisible.', { champ }, 400);
    }
    if (!Number.isInteger(valeur)) {
      throw new CreditError('montant_decimal',
        'Le ' + champ + ' doit être un nombre entier de FCFA (pas de centimes).', { champ }, 400);
    }
    return valeur;
  }
  const brut = String(valeur).replace(/[\s\u00a0]/g, '').replace(/,/g, '.');
  if (!/^-?[0-9]+(\.[0-9]{1,2})?$/.test(brut)) {
    throw new CreditError('montant_invalide',
      'Le ' + champ + ' comporte des caractères inattendus.', { champ, valeur: String(valeur) }, 400);
  }
  const [ent0, dec = ''] = brut.split('.');
  const neg = ent0.startsWith('-');
  const e = (neg ? ent0.slice(1) : ent0) || '0';
  const cents = BigInt(e) * 100n + BigInt((dec + '00').slice(0, 2));
  const out = neg ? -cents : cents;
  if (out > 9007199254740991n || out < -9007199254740991n) {
    throw new CreditError('montant_trop_grand', 'Le ' + champ + ' dépasse la limite autorisée.', { champ }, 400);
  }
  return Number(out);
}

/** Montant FCFA (texte ou nombre) -> centimes, en refusant le négatif. */
export function montantEnCentimes(valeur, champ = 'montant') {
  const v = entier(valeur, champ);
  if (v < 0) throw new CreditError('montant_negatif', 'Le ' + champ + ' ne peut pas être négatif.', { champ }, 400);
  return v;
}

/** 12 500 -> « 12 500 FCFA » (centimes -> texte lisible). */
export function fcfa(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' FCFA';
}

/** Arrondi au centime le plus proche (demi vers le haut). */
function arrondi(x) { return Math.round(x); }

/** Ajoute des mois à une date (gère les fins de mois). */
export function ajouterMois(dateIso, mois) {
  const d = new Date(dateIso + 'T00:00:00Z');
  const jour = d.getUTCDate();
  const cible = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + mois, 1));
  const dernier = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate();
  cible.setUTCDate(Math.min(jour, dernier));
  return cible.toISOString().slice(0, 10);
}

/** Ajoute des jours (hebdomadaire / bimensuelle). */
export function ajouterJours(dateIso, jours) {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + jours);
  return d.toISOString().slice(0, 10);
}

/** Nombre de jours entre deux dates ISO (b - a). */
export function joursEntre(a, b) {
  const da = new Date(String(a).slice(0, 10) + 'T00:00:00Z');
  const db = new Date(String(b).slice(0, 10) + 'T00:00:00Z');
  return Math.round((db - da) / 86400000);
}

/* ========================================================================
 *  1. PRODUIT ET PARAMÉTRAGE
 * ===================================================================== */
/**
 * Contrôle un produit de crédit avant enregistrement.
 * @returns {object} produit normalisé (valeurs par défaut appliquées)
 */
export function validerProduitCredit(p) {
  if (!p || typeof p !== 'object') {
    throw new CreditError('produit_vide', 'Les paramètres du produit sont obligatoires.', null, 400);
  }
  const code = String(p.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_\-]{3,40}$/.test(code)) {
    throw new CreditError('code_invalide',
      'Le code du produit doit comporter 3 à 40 caractères (lettres, chiffres, tiret, souligné).',
      { champ: 'code' }, 400);
  }
  const libelle = String(p.libelle || '').trim();
  if (libelle.length < 3) {
    throw new CreditError('libelle_invalide', 'Donnez un libellé au produit (3 caractères minimum).', { champ: 'libelle' }, 400);
  }
  const methode = String(p.methode || 'DEGRESSIF').toUpperCase();
  if (!METHODES.includes(methode)) {
    throw new CreditError('methode_inconnue',
      'Méthode de calcul inconnue : ' + methode + '. Choisissez ' + METHODES.join(', ') + '.',
      { methodes: METHODES }, 400);
  }
  const periodicite = String(p.periodicite || 'MENSUELLE').toUpperCase();
  if (!PERIODICITES[periodicite]) {
    throw new CreditError('periodicite_inconnue',
      'Périodicité inconnue : ' + periodicite + '.', { periodicites: Object.keys(PERIODICITES) }, 400);
  }
  const dureeMin = Number.isInteger(p.duree_min_mois) ? p.duree_min_mois : 1;
  const dureeMax = Number.isInteger(p.duree_max_mois) ? p.duree_max_mois : 24;
  if (dureeMin < 1 || dureeMax < dureeMin) {
    throw new CreditError('duree_invalide',
      'La durée maximale doit être supérieure ou égale à la durée minimale (1 mois au moins).',
      { champ: 'duree_max_mois' }, 400);
  }
  const montantMin = Number(p.montant_min_cents || 0);
  const montantMax = Number(p.montant_max_cents || 1000000000);
  if (!Number.isInteger(montantMin) || !Number.isInteger(montantMax) || montantMax <= montantMin) {
    throw new CreditError('plafond_invalide',
      'Le montant maximum doit être supérieur au montant minimum.', { champ: 'montant_max_cents' }, 400);
  }
  const taux = Number.isInteger(p.taux_nominal_bp) ? p.taux_nominal_bp : 1200;
  if (taux < 0 || taux > 60000) {
    throw new CreditError('taux_invalide',
      'Le taux nominal doit être compris entre 0 % et 600 % par an.', { champ: 'taux_nominal_bp' }, 400);
  }
  const differeType = String(p.differe_type || 'AUCUN').toUpperCase();
  if (!['AUCUN', 'INTERETS', 'TOTAL'].includes(differeType)) {
    throw new CreditError('differe_inconnu',
      'Type de différé inconnu : choisissez AUCUN, INTERETS ou TOTAL.', { champ: 'differe_type' }, 400);
  }
  const differeMois = Number.isInteger(p.differe_mois) ? p.differe_mois : 0;
  if (differeMois < 0) {
    throw new CreditError('differe_invalide', 'Le différé ne peut pas être négatif.', { champ: 'differe_mois' }, 400);
  }
  const bp = (v, def = 0) => (Number.isInteger(v) ? v : def);
  return {
    code,
    libelle,
    description: p.description ? String(p.description).trim() : null,
    methode,
    periodicite,
    duree_min_mois: dureeMin,
    duree_max_mois: dureeMax,
    montant_min_cents: montantMin,
    montant_max_cents: montantMax,
    taux_nominal_bp: taux,
    frais_dossier_bp: bp(p.frais_dossier_bp, 100),
    frais_dossier_min_cents: bp(p.frais_dossier_min_cents, 0),
    assurance_bp: bp(p.assurance_bp, 0),
    epargne_obligatoire_bp: bp(p.epargne_obligatoire_bp, 0),
    differe_mois: differeMois,
    differe_type: differeType,
    penalite_retard_bp_jour: bp(p.penalite_retard_bp_jour, 5),
    provision_sain_bp: bp(p.provision_sain_bp, 100),
    provision_immobilise_bp: bp(p.provision_immobilise_bp, 5000),
    provision_douteux_bp: bp(p.provision_douteux_bp, 10000),
    provision_litigieux_bp: bp(p.provision_litigieux_bp, 10000),
    actif: p.actif === false ? false : true
  };
}

/** Frais de dossier (% du montant, avec plancher). */
export function fraisDossier(montantCents, produit) {
  const bp = Number((produit && produit.frais_dossier_bp) || 0);
  const min = Number((produit && produit.frais_dossier_min_cents) || 0);
  if (bp === 0 && min === 0) return 0;
  return Math.max(arrondi((montantCents * bp) / 10000), min);
}

/** Assurance (sur le montant financé). */
export function fraisAssurance(montantCents, produit) {
  const bp = Number((produit && produit.assurance_bp) || 0);
  return bp > 0 ? arrondi((montantCents * bp) / 10000) : 0;
}

/** Épargne obligatoire de garantie (bloquée sur le compte du client). */
export function epargneGarantie(montantCents, produit) {
  const bp = Number((produit && produit.epargne_obligatoire_bp) || 0);
  return bp > 0 ? arrondi((montantCents * bp) / 10000) : 0;
}

/** Nombre d'échéances d'un dossier selon sa durée et sa périodicité. */
export function nombreEcheances(dureeMois, periodicite) {
  const p = PERIODICITES[String(periodicite || 'MENSUELLE').toUpperCase()];
  if (!p) throw new CreditError('periodicite_inconnue', 'Périodicité inconnue.', { periodicite }, 400);
  if (!Number.isInteger(dureeMois) || dureeMois < 1) {
    throw new CreditError('duree_invalide', 'La durée doit être un nombre de mois entier (1 minimum).', { dureeMois }, 400);
  }
  const n = Math.round((dureeMois * p.parAn) / 12);
  return Math.max(n, 1);
}

/**
 * Date de la k-ième échéance à partir de la date de déblocage.
 * Mensuelle/trimestrielle : mois entiers (fins de mois respectées) ;
 * hebdomadaire/bimensuelle : jours réels.
 */
export function dateEcheance(dateDebut, k, periodicite) {
  const code = String(periodicite || 'MENSUELLE').toUpperCase();
  if (code === 'HEBDOMADAIRE' || code === 'BIMENSUELLE') {
    return ajouterJours(dateDebut, PERIODICITES[code].jours * k);
  }
  return ajouterMois(dateDebut, code === 'TRIMESTRIELLE' ? 3 * k : k);
}

/* ========================================================================
 *  2. ÉCHÉANCIER — TABLEAU D'AMORTISSEMENT LIGNE PAR LIGNE
 * ===================================================================== */
/**
 * Construit le tableau d'amortissement.
 *
 * @param {object} o
 * @param {number} o.montant_cents      capital financé (net des retenues)
 * @param {number} o.taux_nominal_bp    taux nominal annuel en points de base
 * @param {number} o.duree_mois         durée en mois
 * @param {string} o.periodicite        HEBDOMADAIRE|BIMENSUELLE|MENSUELLE|TRIMESTRIELLE
 * @param {string} o.methode             DEGRESSIF|LINEAIRE|IN_FINE
 * @param {string} o.date_debut         date de déblocage (AAAA-MM-JJ)
 * @param {number} [o.differe_mois=0]    nb d'échéances en différé (grâce)
 * @param {string} [o.differe_type]     AUCUN|INTERETS|TOTAL
 * @param {number} [o.assurance_cents=0] assurance totale (répartie sur les échéances)
 *
 * @returns {{ lignes: object[], total_capital_cents: number,
 *             total_interets_cents: number, total_assurance_cents: number,
 *             total_a_payer_cents: number, nombre_echeances: number,
 *             taux_periodique: number }}
 */
export function construireEcheancier(o) {
  const montant = Number(o && o.montant_cents);
  if (!Number.isInteger(montant) || montant <= 0) {
    throw new CreditError('montant_invalide', 'Le montant financé doit être un entier de centimes positif.',
      { montant_cents: o && o.montant_cents }, 400);
  }
  const tauxBp = Number((o && o.taux_nominal_bp) || 0);
  if (!Number.isInteger(tauxBp) || tauxBp < 0) {
    throw new CreditError('taux_invalide', 'Le taux nominal est invalide.', { taux_nominal_bp: tauxBp }, 400);
  }
  const methode = String((o && o.methode) || 'DEGRESSIF').toUpperCase();
  if (!METHODES.includes(methode)) {
    throw new CreditError('methode_inconnue', 'Méthode de calcul inconnue : ' + methode + '.', { methodes: METHODES }, 400);
  }
  const periodicite = String((o && o.periodicite) || 'MENSUELLE').toUpperCase();
  const n = nombreEcheances(Number(o && o.duree_mois), periodicite);
  const dateDebut = String((o && o.date_debut) || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const differeMois = Math.max(0, Number.isInteger(o && o.differe_mois) ? o.differe_mois : 0);
  const differeType = String((o && o.differe_type) || 'AUCUN').toUpperCase();
  const assurance = Math.max(0, Number((o && o.assurance_cents) || 0));
  if (differeMois >= n) {
    throw new CreditError('differe_trop_long',
      'Le différé (' + differeMois + ' échéances) doit être inférieur à la durée totale du crédit (' + n + ' échéances).',
      { differe_mois: differeMois, nombre_echeances: n }, 400);
  }

  // Taux périodique : taux annuel / nombre de périodes par an (proportionnel,
  // usage BCEAO pour les crédits à moins d'un an).
  const parAn = PERIODICITES[periodicite].parAn;
  const tauxPeriodique = tauxBp / 10000 / parAn;

  const nAmort = n - differeMois;
  const lignes = [];
  let capitalRestant = montant;
  let interetsTotal = 0;

  // Annuité constante (dégressif) — calculée en flottant puis arrondie ligne
  // par ligne ; la dernière ligne solde le capital exactement.
  let annuite = 0;
  if (methode === 'DEGRESSIF') {
    annuite = tauxPeriodique === 0
      ? montant / nAmort
      : (montant * tauxPeriodique) / (1 - Math.pow(1 + tauxPeriodique, -nAmort));
  }
  const capitalLineaire = Math.floor(montant / nAmort);

  for (let k = 1; k <= n; k += 1) {
    const enDiffere = k <= differeMois;
    const interetBrut = arrondi(capitalRestant * tauxPeriodique);
    let capital = 0;
    let interet = interetBrut;

    if (enDiffere && differeType === 'TOTAL') {
      // Grâce complète : ni intérêts ni capital (les intérêts sont capitalisés).
      capital = 0;
      interet = 0;
      capitalRestant = capitalRestant + interetBrut;   // capitalisation
    } else if (enDiffere) {
      // Grâce en intérêts : on paie les intérêts, pas le capital.
      capital = 0;
    } else {
      const rang = k - differeMois;
      if (methode === 'DEGRESSIF') {
        capital = rang === nAmort ? capitalRestant : Math.max(0, Math.min(capitalRestant, arrondi(annuite) - interetBrut));
      } else if (methode === 'LINEAIRE') {
        capital = rang === nAmort ? capitalRestant : Math.min(capitalRestant, capitalLineaire);
      } else {
        // IN_FINE : capital remboursé en une fois à la dernière échéance.
        capital = rang === nAmort ? capitalRestant : 0;
      }
      if (interetBrut > arrondi(annuite) && methode === 'DEGRESSIF' && rang !== nAmort) {
        // Sécurité : une échéance ne peut pas être inférieure aux intérêts.
        capital = 0;
      }
    }

    capitalRestant = Math.max(0, capitalRestant - capital);
    interetsTotal += interet;

    lignes.push({
      numero: k,
      date_echeance: dateEcheance(dateDebut, k, periodicite),
      capital_cents: capital,
      interet_cents: interet,
      assurance_cents: 0,
      montant_echeance_cents: capital + interet,
      solde_capital_cents: capitalRestant,
      en_differe: enDiffere
    });
  }

  // Répartition de l'assurance : à parts égales, le reste sur la 1re ligne.
  let assuranceTotale = 0;
  if (assurance > 0 && n > 0) {
    const part = Math.floor(assurance / n);
    let reste = assurance - part * n;
    for (const l of lignes) {
      const a = part + (reste > 0 ? 1 : 0);
      if (reste > 0) reste -= 1;
      l.assurance_cents = a;
      l.montant_echeance_cents = l.capital_cents + l.interet_cents + a;
      assuranceTotale += a;
    }
  }

  const totalCapital = lignes.reduce((s, l) => s + l.capital_cents, 0);
  const totalInterets = lignes.reduce((s, l) => s + l.interet_cents, 0);
  const totalAPayer = lignes.reduce((s, l) => s + l.montant_echeance_cents, 0);

  // Contrôle d'intégrité : le capital remboursé égale le montant financé.
  if (totalCapital !== montant) {
    // On corrige en pilotant la dernière ligne (jamais de perte au centime).
    const ecart = montant - totalCapital;
    const derniere = lignes[lignes.length - 1];
    if (derniere) {
      derniere.capital_cents += ecart;
      derniere.montant_echeance_cents += ecart;
      derniere.solde_capital_cents = 0;
    }
  }

  return {
    lignes,
    nombre_echeances: n,
    total_capital_cents: lignes.reduce((s, l) => s + l.capital_cents, 0),
    total_interets_cents: lignes.reduce((s, l) => s + l.interet_cents, 0),
    total_assurance_cents: assuranceTotale,
    total_a_payer_cents: lignes.reduce((s, l) => s + l.montant_echeance_cents, 0),
    taux_periodique: tauxPeriodique,
    cout_credit_cents: lignes.reduce((s, l) => s + l.interet_cents + l.assurance_cents, 0),
    interets_calcules: totalInterets
  };
}

/* ========================================================================
 *  3. TEG — TAUX EFFECTIF GLOBAL (méthode BCEAO : actualisation des flux)
 * ===================================================================== */
/**
 * Calcule le TEG (en points de base, arrondi) par TRI des flux réels :
 *   - déblocage : + net versé (montant - frais de dossier - assurance retenus)
 *   - échéances : - montant de l'échéance (capital + intérêts + assurance)
 * Le résultat est annualisé selon la périodicité du crédit.
 *
 * @param {object} o { montant_net_cents, lignes, periodicite, nb_iterations? }
 * @returns {number} TEG en points de base (ex. 2450 = 24,50 %)
 */
export function calculerTeg(o) {
  const net = Number(o && o.montant_net_cents);
  const lignes = (o && Array.isArray(o.lignes)) ? o.lignes : [];
  if (!Number.isFinite(net) || net <= 0) {
    throw new CreditError('montant_invalide', 'Le montant net débloqué est invalide.', null, 400);
  }
  if (!lignes.length) {
    throw new CreditError('echeancier_vide', 'Aucune échéance : impossible de calculer le TEG.', null, 400);
  }
  const codePer = String((o && o.periodicite) || 'MENSUELLE').toUpperCase();
  const parAn = (PERIODICITES[codePer] || PERIODICITES.MENSUELLE).parAn;

  // VAN(i) = net - SOMME flux_k / (1+i)^k  (flux_k = échéance k, entiers de centimes)
  // La VAN est strictement décroissante en i. On l'évalue de façon stable :
  // une seule division finale, numérateur et dénominateur en entiers.
  const flux = lignes.map((l) => Number(l.montant_echeance_cents || 0));
  const van = (i) => {
    let num = net;          // numérateur sur (1+i)^n
    let facteur = 1;
    const n = flux.length;
    for (let k = 0; k < n; k += 1) {
      num = num * (1 + i) - flux[k];
      facteur *= (1 + i);
    }
    return num / facteur;
  };

  if (!(van(0) < 0)) return 0;        // net >= total remboursé : aucun coût
  let bas = 0;                        // van(bas) < 0
  let haut = 1;                       // van(haut) doit être > 0
  while (van(haut) < 0 && haut < 1000) haut *= 2;
  if (van(haut) < 0) {
    throw new CreditError('teg_hors_bornes',
      'Le TEG dépasse les bornes calculables : vérifiez les frais et le taux du produit.', null, 422);
  }
  for (let it = 0; it < 200; it += 1) {
    const milieu = (bas + haut) / 2;
    // On maximise i (pas u) pour que la précision finale porte sur le taux.
    if (van(milieu) < 0) bas = milieu; else haut = milieu;
    if (haut - bas <= 1e-13) break;
  }
  const tauxPeriode = (bas + haut) / 2;
  if (!Number.isFinite(tauxPeriode) || tauxPeriode <= 0) return 0;
  // Annualisation BCEAO : taux périodique x nombre de périodes par an
  // (taux actuariel simple, sans capitalisation), pratique des SFD de la
  // zone UEMOA pour les crédits à court terme.
  const tegAnnuel = tauxPeriode * parAn;
  const tegBp = Math.round(tegAnnuel * 10000);
  return tegBp < 0 ? 0 : tegBp;
}

/**
 * Dossier complet : frais, échéancier et TEG en une seule opération.
 * C'est LA fonction appelée à la création / modification d'un dossier.
 */
export function simulerDossierCredit(entree) {
  const montant = montantEnCentimes(entree && entree.montant_cents, 'montant');
  if (montant <= 0) {
    throw new CreditError('montant_non_positif', 'Le montant du crédit doit être supérieur à zéro.', null, 400);
  }
  const produit = entree && entree.produit ? entree.produit : {};
  const duree = Number(entree && entree.duree_mois);
  const periodicite = String((entree && entree.periodicite) || produit.periodicite || 'MENSUELLE').toUpperCase();
  const methode = String((entree && entree.methode) || produit.methode || 'DEGRESSIF').toUpperCase();
  // Le taux peut venir du dossier (prioritaire) ou du produit. Un taux 0 est une
  // valeur légitime (crédit à taux zéro) : on teste la présence, pas la véracité.
  const tauxSource = entree && entree.taux_nominal_bp != null
    ? entree.taux_nominal_bp : produit.taux_nominal_bp;
  const tauxBp = Number.isFinite(Number(tauxSource)) ? Math.round(Number(tauxSource)) : 0;
  const differeMois = Number.isInteger(entree && entree.differe_mois)
    ? entree.differe_mois : Number(produit.differe_mois || 0);
  const differeType = String((entree && entree.differe_type) || produit.differe_type || 'AUCUN').toUpperCase();
  const dateDebut = String((entree && entree.date_debut) || new Date().toISOString().slice(0, 10)).slice(0, 10);

  // Contrôles produit (plafonds, durée).
  if (produit.montant_min_cents != null && montant < Number(produit.montant_min_cents)) {
    throw new CreditError('montant_sous_plancher',
      'Le montant est inférieur au minimum du produit (' + fcfa(produit.montant_min_cents) + ').',
      { montant_min_cents: produit.montant_min_cents }, 422);
  }
  if (produit.montant_max_cents != null && montant > Number(produit.montant_max_cents)) {
    throw new CreditError('montant_au_dessus_plafond',
      'Le montant dépasse le plafond du produit (' + fcfa(produit.montant_max_cents) + ').',
      { montant_max_cents: produit.montant_max_cents }, 422);
  }
  if (produit.duree_max_mois != null && Number.isInteger(duree) && duree > Number(produit.duree_max_mois)) {
    throw new CreditError('duree_au_dessus_plafond',
      'La durée dépasse le maximum du produit (' + produit.duree_max_mois + ' mois).',
      { duree_max_mois: produit.duree_max_mois }, 422);
  }
  if (produit.duree_min_mois != null && Number.isInteger(duree) && duree < Number(produit.duree_min_mois)) {
    throw new CreditError('duree_sous_plancher',
      'La durée est inférieure au minimum du produit (' + produit.duree_min_mois + ' mois).',
      { duree_min_mois: produit.duree_min_mois }, 422);
  }

  const frais = fraisDossier(montant, produit);
  const assurance = fraisAssurance(montant, produit);
  const epargne = epargneGarantie(montant, produit);
  const netVerse = montant - frais - assurance - epargne;
  if (netVerse <= 0) {
    throw new CreditError('retenues_excessives',
      'Les frais et retenues absorbent tout le montant : ajustez le produit ou le montant demandé.',
      { frais_dossier_cents: frais, assurance_cents: assurance, epargne_cents: epargne }, 422);
  }

  const ech = construireEcheancier({
    montant_cents: montant,
    taux_nominal_bp: tauxBp,
    duree_mois: duree,
    periodicite,
    methode,
    date_debut: dateDebut,
    differe_mois: differeMois,
    differe_type: differeType,
    assurance_cents: assurance
  });

  const teg = calculerTeg({
    montant_net_cents: netVerse,
    lignes: ech.lignes,
    periodicite
  });

  return {
    montant_cents: montant,
    net_verse_cents: netVerse,
    frais_dossier_cents: frais,
    assurance_cents: assurance,
    epargne_garantie_cents: epargne,
    methode,
    periodicite,
    duree_mois: duree,
    taux_nominal_bp: tauxBp,
    taux_teg_bp: teg,
    taux_teg_pourcent: teg / 100,
    nombre_echeances: ech.nombre_echeances,
    total_interets_cents: ech.total_interets_cents,
    total_assurance_cents: ech.total_assurance_cents,
    total_a_payer_cents: ech.total_a_payer_cents,
    cout_credit_cents: ech.cout_credit_cents + frais,
    lignes: ech.lignes
  };
}

/* ========================================================================
 *  4. IMPUTATION D'UN REMBOURSEMENT
 * ===================================================================== */
/**
 * Impute un montant encaissé dans l'ordre réglementaire BCEAO :
 *   1) pénalités de retard  2) intérêts échus  3) capital
 * Le reliquat (trop-perçu) est renvoyé à part : il ne reste jamais bloqué.
 *
 * @param {object} o
 * @param {number} o.montant_cents           encaissé
 * @param {number} o.penalites_dues_cents    pénalités restant à régler
 * @param {number} o.interets_echus_cents    intérêts échus non payés
 * @param {number} o.capital_du_cents        capital restant dû
 * @returns {{penalite_cents, interet_cents, capital_cents, trop_percu_cents,
 *            reste_penalites_cents, reste_interets_cents, reste_capital_cents}}
 */
export function imputerRemboursement(o) {
  const montant = Number(o && o.montant_cents);
  const penalites = Number((o && o.penalites_dues_cents) || 0);
  const interets = Number((o && o.interets_echus_cents) || 0);
  const capital = Number((o && o.capital_du_cents) || 0);
  if (!Number.isInteger(montant) || montant <= 0) {
    throw new CreditError('montant_invalide', 'Le montant encaissé doit être un entier de centimes positif.',
      { montant_cents: o && o.montant_cents }, 400);
  }
  if (penalites < 0 || interets < 0 || capital < 0) {
    throw new CreditError('encours_invalide', 'Les encours du dossier sont incohérents (valeur négative).', null, 409);
  }

  let reste = montant;
  const p = Math.min(reste, penalites); reste -= p;
  const i = Math.min(reste, interets); reste -= i;
  const c = Math.min(reste, capital); reste -= c;

  return {
    montant_cents: montant,
    penalite_cents: p,
    interet_cents: i,
    capital_cents: c,
    trop_percu_cents: reste,
    reste_penalites_cents: penalites - p,
    reste_interets_cents: interets - i,
    reste_capital_cents: capital - c
  };
}

/**
 * Répartit l'imputation sur les échéances, dans l'ordre chronologique.
 * @param {object[]} echeances  [{id, numero, capital_cents, capital_paye_cents,
 *                                interet_cents, interet_paye_cents,
 *                                penalite_cents, penalite_payee_cents, statut}]
 * @param {object} imputation     résultat de imputerRemboursement()
 * @returns {{lignes: object[], echeances: object[]}}
 */
export function repartirSurEcheances(echeances, imputation) {
  const liste = (Array.isArray(echeances) ? echeances : [])
    .map((e) => ({ ...e }))
    .sort((a, b) => a.numero - b.numero);
  const lignes = [];

  const consommer = (nature, total) => {
    let reste = total;
    for (const e of liste) {
      if (reste <= 0) break;
      if (nature === 'PENALITE') {
        const du = Math.max(0, Number(e.penalite_cents || 0) - Number(e.penalite_payee_cents || 0));
        const v = Math.min(reste, du);
        if (v > 0) {
          e.penalite_payee_cents = Number(e.penalite_payee_cents || 0) + v;
          lignes.push({ echeance_id: e.id, nature: 'PENALITE', montant_cents: v });
          reste -= v;
        }
      } else if (nature === 'INTERET') {
        const du = Math.max(0, Number(e.interet_cents || 0) - Number(e.interet_paye_cents || 0));
        const v = Math.min(reste, du);
        if (v > 0) {
          e.interet_paye_cents = Number(e.interet_paye_cents || 0) + v;
          lignes.push({ echeance_id: e.id, nature: 'INTERET', montant_cents: v });
          reste -= v;
        }
      } else {
        const du = Math.max(0, Number(e.capital_cents || 0) - Number(e.capital_paye_cents || 0));
        const v = Math.min(reste, du);
        if (v > 0) {
          e.capital_paye_cents = Number(e.capital_paye_cents || 0) + v;
          lignes.push({ echeance_id: e.id, nature: 'CAPITAL', montant_cents: v });
          reste -= v;
        }
      }
    }
    return reste;
  };

  consommer('PENALITE', Number(imputation.penalite_cents || 0));
  consommer('INTERET', Number(imputation.interet_cents || 0));
  consommer('CAPITAL', Number(imputation.capital_cents || 0));

  if (Number(imputation.trop_percu_cents || 0) > 0) {
    lignes.push({ echeance_id: null, nature: 'TROP_PERCU', montant_cents: Number(imputation.trop_percu_cents) });
  }

  // Recalcul du statut de chaque échéance après imputation.
  for (const e of liste) {
    const paye = Number(e.capital_paye_cents || 0) + Number(e.interet_paye_cents || 0)
      + Number(e.penalite_payee_cents || 0);
    const attendu = Number(e.capital_cents || 0) + Number(e.interet_cents || 0)
      + Number(e.penalite_cents || 0);
    if (paye >= attendu) e.statut = 'PAYE';
    else if (paye > 0) e.statut = Number(e.jours_retard || 0) > 0 ? 'EN_RETARD' : 'PARTIEL';
    else e.statut = Number(e.jours_retard || 0) > 0 ? 'EN_RETARD' : 'A_PAYER';
  }
  return { lignes, echeances: liste };
}

/* ========================================================================
 *  5. PÉNALITÉS, RETARD, DÉCLASSEMENT, PROVISION
 * ===================================================================== */
/**
 * Pénalité de retard d'une échéance : capital échu × taux journalier × jours.
 * @param {object} o { capital_du_cents, jours_retard, taux_bp_jour, plafond_cents? }
 */
export function calculerPenalite(o) {
  const capital = Math.max(0, Number((o && o.capital_du_cents) || 0));
  const jours = Math.max(0, Number((o && o.jours_retard) || 0));
  const taux = Math.max(0, Number((o && o.taux_bp_jour) || 0));
  if (capital === 0 || jours === 0 || taux === 0) return 0;
  const brut = Math.round((capital * taux * jours) / 10000);
  const plafond = o && Number.isFinite(o.plafond_cents) ? Number(o.plafond_cents) : null;
  return plafond != null ? Math.min(brut, plafond) : brut;
}

/**
 * Classe BCEAO d'une créance selon les jours de retard :
 *   SAIN (< 30 j) -> IMMOBILISE (30-89 j) -> DOUTEUX (90-179 j)
 *   -> LITIGIEUX (>= 180 j).
 * Paramétrable via seuils { immobilise: 30, douteux: 90, litigieux: 180 }.
 */
export function classeBceao(joursRetard, seuils = {}) {
  const j = Math.max(0, Number(joursRetard) || 0);
  const s = {
    immobilise: Number.isFinite(seuils.immobilise) ? seuils.immobilise : 30,
    douteux: Number.isFinite(seuils.douteux) ? seuils.douteux : 90,
    litigieux: Number.isFinite(seuils.litigieux) ? seuils.litigieux : 180
  };
  if (j >= s.litigieux) return 'LITIGIEUX';
  if (j >= s.douteux) return 'DOUTEUX';
  if (j >= s.immobilise) return 'IMMOBILISE';
  return 'SAIN';
}

/** Taux de provision (points de base) selon la classe et le produit. */
export function tauxProvisionBp(classe, produit) {
  const p = produit || {};
  switch (String(classe || 'SAIN').toUpperCase()) {
    case 'IMMOBILISE': return Number.isInteger(p.provision_immobilise_bp) ? p.provision_immobilise_bp : 5000;
    case 'DOUTEUX': return Number.isInteger(p.provision_douteux_bp) ? p.provision_douteux_bp : 10000;
    case 'LITIGIEUX': return Number.isInteger(p.provision_litigieux_bp) ? p.provision_litigieux_bp : 10000;
    // Un crédit sain n'est pas provisionné (norme prudentielle BCEAO).
    default: return Number.isInteger(p.provision_sain_bp) ? p.provision_sain_bp : 0;
  }
}

/** Provision BCEAO = encours capital × taux de la classe. */
export function calculerProvision(encoursCents, classe, produit) {
  const encours = Math.max(0, Number(encoursCents) || 0);
  return Math.round((encours * tauxProvisionBp(classe, produit)) / 10000);
}

/**
 * Décision de la tâche quotidienne pour un dossier :
 * jours de retard, nouvelle classe, changement à enregistrer.
 * @param {object} o { echeances: [{date_echeance, statut, capital_cents,
 *                    capital_paye_cents, interet_cents, interet_paye_cents,
 *                    penalite_cents, penalite_payee_cents}],
 *                    classe_actuelle, produit, aujourdhui (ISO) }
 */
export function evaluerImpaye(o) {
  const aujourdhui = String((o && o.aujourdhui) || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const echeances = Array.isArray(o && o.echeances) ? o.echeances : [];
  let pireRetard = 0;
  let impayeCapital = 0;
  let impayeInterets = 0;
  let penalitesDues = 0;
  const detail = [];

  for (const e of echeances) {
    const echu = joursEntre(e.date_echeance, aujourdhui);
    const retard = echu > 0 ? echu : 0;
    const capitalDu = Math.max(0, Number(e.capital_cents || 0) - Number(e.capital_paye_cents || 0));
    const interetDu = Math.max(0, Number(e.interet_cents || 0) - Number(e.interet_paye_cents || 0));
    const penalitePayee = Number(e.penalite_payee_cents || 0);
    let penalite = Number(e.penalite_cents || 0);
    if (retard > 0 && capitalDu > 0) {
      const calculee = calculerPenalite({
        capital_du_cents: capitalDu,
        jours_retard: retard,
        taux_bp_jour: Number((o.produit && o.produit.penalite_retard_bp_jour) || 0)
      });
      penalite = Math.max(penalite, calculee);
    }
    if (retard > 0) {
      pireRetard = Math.max(pireRetard, retard);
      impayeCapital += capitalDu;
      impayeInterets += interetDu;
      penalitesDues += Math.max(0, penalite - penalitePayee);
    }
    detail.push({
      echeance_id: e.id,
      numero: e.numero,
      jours_retard: retard,
      capital_du_cents: capitalDu,
      interet_du_cents: interetDu,
      penalite_cents: penalite,
      penalite_due_cents: Math.max(0, penalite - penalitePayee),
      statut: (retard > 0
        ? ((Number(e.capital_paye_cents || 0) + Number(e.interet_paye_cents || 0)) > 0 ? 'EN_RETARD' : 'EN_RETARD')
        : (Number(e.capital_paye_cents || 0) >= Number(e.capital_cents || 0)
            && Number(e.interet_paye_cents || 0) >= Number(e.interet_cents || 0)
          ? 'PAYE'
          : ((Number(e.capital_paye_cents || 0) + Number(e.interet_paye_cents || 0)) > 0 ? 'PARTIEL' : 'A_PAYER')))
    });
  }

  const classeAvant = String((o && o.classe_actuelle) || 'SAIN').toUpperCase();
  const classeApres = pireRetard > 0 ? classeBceao(pireRetard) : 'SAIN';
  const encours = echeances.reduce((s, e) => s
    + Math.max(0, Number(e.capital_cents || 0) - Number(e.capital_paye_cents || 0)), 0);

  return {
    jours_retard: pireRetard,
    classe_avant: classeAvant,
    classe_apres: classeApres,
    changement_classe: classeApres !== classeAvant,
    encours_capital_cents: encours,
    impaye_capital_cents: impayeCapital,
    impaye_interets_cents: impayeInterets,
    montant_impaye_cents: impayeCapital + impayeInterets,
    penalites_dues_cents: penalitesDues,
    provision_cents: calculerProvision(encours, classeApres, o && o.produit),
    echeances: detail
  };
}

/* ========================================================================
 *  6. PAR 30 / PAR 90 (portefeuille à risque)
 * ===================================================================== */
/**
 * @param {object[]} dossiers [{encours_cents, jours_retard, provision_cents}]
 * @returns {{encours_cents, par30_cents, par90_cents, par30_pourcent,
 *            par90_pourcent, provisions_cents, nb_dossiers,
 *            par_classe: object}}
 */
export function calculerPar(dossiers) {
  const liste = Array.isArray(dossiers) ? dossiers : [];
  const encours = liste.reduce((s, d) => s + Math.max(0, Number(d.encours_cents || 0)), 0);
  const par30 = liste.filter((d) => Number(d.jours_retard || 0) >= 30)
    .reduce((s, d) => s + Math.max(0, Number(d.encours_cents || 0)), 0);
  const par90 = liste.filter((d) => Number(d.jours_retard || 0) >= 90)
    .reduce((s, d) => s + Math.max(0, Number(d.encours_cents || 0)), 0);
  const provisions = liste.reduce((s, d) => s + Math.max(0, Number(d.provision_cents || 0)), 0);
  const pct = (v) => (encours > 0 ? Math.round((v * 10000) / encours) / 100 : 0);
  const parClasse = { SAIN: 0, IMMOBILISE: 0, DOUTEUX: 0, LITIGIEUX: 0 };
  for (const d of liste) {
    const c = String(d.classe_creance || classeBceao(d.jours_retard)).toUpperCase();
    parClasse[parClasse[c] === undefined ? 'SAIN' : c] += Math.max(0, Number(d.encours_cents || 0));
  }
  return {
    nb_dossiers: liste.length,
    encours_cents: encours,
    par30_cents: par30,
    par90_cents: par90,
    par30_pourcent: pct(par30),
    par90_pourcent: pct(par90),
    provisions_cents: provisions,
    taux_couverture_pourcent: encours > 0 ? Math.round((provisions * 10000) / encours) / 100 : 0,
    par_classe: parClasse
  };
}

/* ========================================================================
 *  7. CIRCUIT DE VALIDATION (4 YEUX) — règles pures
 * ===================================================================== */
export const TRANSITIONS = Object.freeze({
  BROUILLON: ['EN_ANALYSE', 'ANNULE'],
  EN_ANALYSE: ['EN_COMITE', 'BROUILLON', 'REJETE', 'ANNULE'],
  EN_COMITE: ['APPROUVE', 'REJETE', 'EN_ANALYSE'],
  APPROUVE: ['DECAISSE', 'ANNULE'],
  REJETE: ['EN_ANALYSE'],
  DECAISSE: ['CLOTURE_SOLDE'],
  CLOTURE_SOLDE: [],
  ANNULE: []
});

/** Vérifie une transition de statut. */
export function transitionAutorisee(avant, apres) {
  const a = String(avant || 'BROUILLON').toUpperCase();
  const b = String(apres || '').toUpperCase();
  const suite = TRANSITIONS[a] || [];
  if (!suite.includes(b)) {
    throw new CreditError('transition_interdite',
      'Le dossier ne peut pas passer de ' + a + ' à ' + b + '. Étapes possibles : '
      + (suite.length ? suite.join(', ') : 'aucune (dossier clos)') + '.',
      { avant: a, apres: b, autorisees: suite }, 409);
  }
  return true;
}

/**
 * Contrôle du principe des 4 yeux : celui qui monte ou instruit le dossier
 * ne peut JAMAIS l'approuver, même s'il a le profil.
 */
export function verifierQuatreYeux({ agent_credit_id, validateur_id, montant_cents, plafond_cents }) {
  if (!validateur_id) {
    throw new CreditError('validateur_manquant', 'Le validateur est introuvable.', null, 400);
  }
  if (agent_credit_id && String(agent_credit_id) === String(validateur_id)) {
    throw new CreditError('quatre_yeux_viole',
      'Principe des 4 yeux : vous ne pouvez pas approuver un dossier que vous avez vous-même monté ou instruit. Faites-le valider par un autre responsable.',
      { agent_credit_id, validateur_id }, 403);
  }
  if (Number.isFinite(plafond_cents) && Number(montant_cents) > Number(plafond_cents)) {
    throw new CreditError('plafond_depasse',
      'Ce montant dépasse votre plafond d\'autorisation (' + fcfa(plafond_cents) + '). '
      + 'Faites remonter le dossier au niveau supérieur du comité.',
      { montant_cents, plafond_cents }, 403);
  }
  return true;
}

/* ========================================================================
 *  8. HORS-LIGNE : validation d'un remboursement / d'une action terrain
 * ===================================================================== */
export function estUuid(v) {
  return typeof v === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * Valide un remboursement saisi hors-ligne (avant toute écriture en base).
 * @returns {object} événement normalisé (montants en centimes)
 */
export function validerRemboursementHorsLigne(ev) {
  if (!ev || typeof ev !== 'object') {
    throw new CreditError('evenement_vide', 'Le remboursement est vide.', null, 400);
  }
  if (!estUuid(ev.uuid_local)) {
    throw new CreditError('uuid_local_invalide',
      'Chaque remboursement doit porter l’identifiant unique généré par le téléphone.',
      { champ: 'uuid_local' }, 400);
  }
  const montant = montantEnCentimes(ev.montant, 'montant');
  if (montant <= 0) {
    throw new CreditError('montant_non_positif', 'Le montant remboursé doit être supérieur à zéro.', null, 400);
  }
  const canal = String(ev.canal || 'TERRAIN_CASH').toUpperCase();
  if (!CANAUX_REMBOURSEMENT.includes(canal)) {
    throw new CreditError('canal_inconnu',
      'Canal de remboursement inconnu : ' + canal + '.', { canaux: CANAUX_REMBOURSEMENT }, 400);
  }
  if (['ORANGE_MONEY', 'MOOV_MONEY', 'WAVE', 'INTEROP_BCEAO'].includes(canal)) {
    const ref = ev.reference_externe_mm ? String(ev.reference_externe_mm).trim() : '';
    if (ref.length < 4) {
      throw new CreditError('reference_mm_manquante',
        'Pour un remboursement ' + canal + ', la référence de la transaction opérateur est obligatoire.',
        { champ: 'reference_externe_mm' }, 422);
    }
  }
  if (ev.gps_lat != null || ev.gps_lng != null) {
    const lat = Number(ev.gps_lat); const lng = Number(ev.gps_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new CreditError('gps_invalide', 'Position GPS illisible : le remboursement ne peut pas être localisé.', null, 422);
    }
  }
  let quand = null;
  if (ev.date_operation_locale) {
    quand = new Date(ev.date_operation_locale);
    if (isNaN(quand.getTime())) {
      throw new CreditError('date_locale_invalide', 'La date enregistrée par le téléphone est illisible.', null, 422);
    }
    if (quand.getTime() > Date.now() + 15 * 60000) {
      throw new CreditError('horloge_en_avance',
        'La date du téléphone est en avance sur le serveur. Réglez la date du téléphone puis relancez la synchronisation.',
        { date_telephone: quand.toISOString(), heure_serveur: new Date().toISOString() }, 409);
    }
  }
  return {
    uuid_local: ev.uuid_local,
    dossier_id: ev.dossier_id || null,
    dossier_reference: ev.dossier_reference ? String(ev.dossier_reference).trim() : null,
    montant_cents: montant,
    canal,
    reference_externe_mm: ev.reference_externe_mm ? String(ev.reference_externe_mm).trim() : null,
    gps_lat: ev.gps_lat != null ? Number(ev.gps_lat) : null,
    gps_lng: ev.gps_lng != null ? Number(ev.gps_lng) : null,
    date_operation_locale: quand,
    seq_local: Number.isFinite(Number(ev.seq_local)) ? Number(ev.seq_local) : null
  };
}

/** Valide une action de recouvrement saisie hors-ligne. */
export function validerActionHorsLigne(ev) {
  if (!ev || typeof ev !== 'object') {
    throw new CreditError('evenement_vide', 'L’action de recouvrement est vide.', null, 400);
  }
  if (!estUuid(ev.uuid_local)) {
    throw new CreditError('uuid_local_invalide',
      'Chaque action doit porter l’identifiant unique généré par le téléphone.', { champ: 'uuid_local' }, 400);
  }
  const type = String(ev.type_action || '').toUpperCase();
  if (!['VISITE', 'APPEL', 'SMS', 'WHATSAPP', 'MISE_EN_DEMEURE', 'PROMESSE', 'CONTENTIEUX', 'SAISIE'].includes(type)) {
    throw new CreditError('type_action_inconnu', 'Type d’action de recouvrement inconnu : ' + (type || '(vide)') + '.', null, 400);
  }
  if (ev.gps_lat != null || ev.gps_lng != null) {
    const lat = Number(ev.gps_lat); const lng = Number(ev.gps_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new CreditError('gps_invalide', 'Position GPS illisible : l’action ne peut pas être localisée.', null, 422);
    }
  }
  return {
    uuid_local: ev.uuid_local,
    dossier_id: ev.dossier_id || null,
    type_action: type,
    resultat: ev.resultat ? String(ev.resultat).trim() : null,
    montant_promis_cents: ev.montant_promis != null ? montantEnCentimes(ev.montant_promis, 'montant_promis') : 0,
    date_promesse: ev.date_promesse ? String(ev.date_promesse).slice(0, 10) : null,
    observation: ev.observation ? String(ev.observation).trim() : null,
    gps_lat: ev.gps_lat != null ? Number(ev.gps_lat) : null,
    gps_lng: ev.gps_lng != null ? Number(ev.gps_lng) : null,
    date_action_locale: ev.date_action_locale ? new Date(ev.date_action_locale) : new Date()
  };
}

/** Référence de dossier lisible : CRD-2026-000123. */
export function referenceDossier({ codeImf, annee, numero }) {
  const code = String(codeImf || 'IMF').replace(/[^A-Z0-9-]/gi, '').slice(0, 12) || 'IMF';
  return 'CRD-' + code + '-' + Number(annee) + '-' + String(Number(numero) || 0).padStart(6, '0');
}

/** Référence de reçu de remboursement : REM-2026-000123. */
export function referenceRecuRemboursement({ annee, numero }) {
  return 'REM-' + Number(annee) + '-' + String(Number(numero) || 0).padStart(6, '0');
}

export default {
  JOURS_AN, METHODES, PERIODICITES, CLASSES_CREANCE, STATUTS_DOSSIER,
  CreditError, entier, montantEnCentimes, fcfa, ajouterMois, ajouterJours, joursEntre,
  validerProduitCredit, fraisDossier, fraisAssurance, epargneGarantie,
  nombreEcheances, dateEcheance, construireEcheancier, calculerTeg, simulerDossierCredit,
  imputerRemboursement, repartirSurEcheances, calculerPenalite, classeBceao,
  tauxProvisionBp, calculerProvision, evaluerImpaye, calculerPar,
  TRANSITIONS, transitionAutorisee, verifierQuatreYeux,
  estUuid, validerRemboursementHorsLigne, validerActionHorsLigne,
  referenceDossier, referenceRecuRemboursement
};
