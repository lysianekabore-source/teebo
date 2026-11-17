// ===========================================================================
// teebo — MOTEUR DE SCORING ALTERNATIF (secteur informel) — fonctions pures
// ---------------------------------------------------------------------------
// Un emprunteur du secteur informel n'a pas de bulletin de salaire ni de
// compte bancaire classique. Il a : un compte d'épargne tenu par la
// collectrice, un carnet de tontine, des dépôts réguliers par Mobile Money ou
// en espèces, un lieu d'activité relevé au GPS, et parfois un crédit passé.
//
// Ce fichier note ce qu'on VOIT, jamais ce qu'on suppose :
//   • aucune fonction ici ne consulte la base, ne lit un fichier ni une
//     variable d'environnement : tout entre par les agrégats déjà calculés ;
//   • chaque pilier rend des POINTS SUR 100 et la liste des raisons qui les
//     justifient, pour que le comité puisse contredire une note, pas la subir ;
//   • les montants sont des entiers de centimes FCFA (comme le reste du module).
//
// Les 5 piliers (pondérations de la grille, 30 / 25 / 20 / 15 / 10 par défaut) :
//   1. ÉPARGNE & TONTINE     — la capacité à mettre de côté, régulièrement
//   2. FLUX & TAUX D'EFFORT  — ce qui entre chaque mois et ce que la mensualité
//                              pèserait dessus (plafond 35 % du revenu net)
//   3. STABILITÉ DU LIEU     — le lieu d'activité bouge-t-il ? (rayon 50 m)
//   4. HISTORIQUE DE CRÉDIT  — remboursements passés, retards, avis BIC*
//   5. GARANTIES             — couverture de la demande par une garantie réelle
//
// * L'avis de la Centrale des Risques / BIC UEMOA n'est PAS fourni par les
//   IMF : on l'accepte en SAISIE MANUELLE (code couleur A/B/C/D + taux
//   d'impayé). Absent, il ne pénalise pas mais il ne bonifie pas non plus.
// ===========================================================================

/* -------------------------------------------------------------------------
 *  Constantes
 * ---------------------------------------------------------------------- */
export const PILIERS = Object.freeze({
  EPARGNE: 'epargne',
  FLUX: 'flux',
  STABILITE: 'stabilite_gps',
  HISTORIQUE: 'historique',
  GARANTIES: 'garanties'
});

export const LIBELLE_PILIER = Object.freeze({
  epargne: 'Épargne et tontine',
  flux: 'Flux et taux d\'effort',
  stabilite_gps: 'Stabilité du lieu (GPS)',
  historique: 'Historique de crédit',
  garanties: 'Garanties'
});

/** Ordre d'affichage du radar (5 axes, sens horaire). */
export const AXES_RADAR = Object.freeze(['epargne', 'flux', 'stabilite_gps', 'historique', 'garanties']);

export const CLASSES_RISQUE = Object.freeze(['A', 'B', 'C', 'D']);

export const LIBELLE_CLASSE_RISQUE = Object.freeze({
  A: 'A — Risque faible : prêt recommandé',
  B: 'B — Risque modéré : prêt possible avec suivi',
  C: 'C — Risque élevé : montant réduit ou garantie renforcée',
  D: 'D — Risque très élevé : ne pas financer en l\'état'
});

/** Grille par défaut : elle sert aussi de repli si la base ne renvoie rien. */
export const GRILLE_DEFAUT = Object.freeze({
  code: 'SCORING_INFORMEL_STD',
  libelle: 'Score secteur informel (standard)',
  poids_epargne: 30,
  poids_flux: 25,
  poids_stabilite_gps: 20,
  poids_historique: 15,
  poids_garanties: 10,
  seuil_classe_a: 75,
  seuil_classe_b: 60,
  seuil_classe_c: 45,
  taux_effort_max_bp: 3500,
  plafond_epargne_bp: 3000,
  plafond_tontine_bp: 8000,
  plafond_score_bp: 13000,
  plafond_garantie_bp: 10000,
  couverture_min_bp: 5000,
  stabilite_min_m: 50,
  nb_visites_min: 3,
  epargne_min_mois: 3
});

/* -------------------------------------------------------------------------
 *  Petits utilitaires numériques (aucune dépendance)
 * ---------------------------------------------------------------------- */
const nombre = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const borne = (v, min, max) => Math.min(max, Math.max(min, v));
const arrondi2 = (v) => Math.round(nombre(v) * 100) / 100;
// Une base nulle donne 0 % (et non NaN) : le moteur ne doit jamais renvoyer
// un score impossible à afficher.
const pourcent = (a, b) => (nombre(b) > 0 ? (nombre(a) / nombre(b)) * 100 : 0);
const fcfa = (c) => Math.round(nombre(c) / 100).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ') + ' FCFA';

/** Note d'un ratio [0..1] ramenée sur 100, avec plafonnement. */
const noteDeRatio = (ratio) => borne(nombre(ratio) * 100, 0, 100);

/**
 * Interpolation linéaire par palier : rend une note 0..100 pour une valeur
 * située entre deux bornes. `points` = [[valeur, note], …] en ordre croissant.
 */
export function noteParPaliers(valeur, paliers) {
  const v = nombre(valeur);
  if (!Array.isArray(paliers) || !paliers.length) return 0;
  if (v <= paliers[0][0]) return borne(paliers[0][1], 0, 100);
  for (let i = 1; i < paliers.length; i += 1) {
    const [v1, n1] = paliers[i];
    const [v0, n0] = paliers[i - 1];
    if (v <= v1) {
      if (v1 === v0) return borne(n1, 0, 100);
      const t = (v - v0) / (v1 - v0);
      return borne(n0 + t * (n1 - n0), 0, 100);
    }
  }
  return borne(paliers[paliers.length - 1][1], 0, 100);
}

/** Contrôle d'une grille : pondérations, seuils, bornes. Rend la liste des défauts. */
export function verifierGrille(g) {
  const d = [];
  const x = { ...GRILLE_DEFAUT, ...(g || {}) };
  const poids = ['poids_epargne', 'poids_flux', 'poids_stabilite_gps', 'poids_historique', 'poids_garanties']
    .map((k) => nombre(x[k]));
  if (poids.some((p) => p < 0)) d.push('Une pondération ne peut pas être négative.');
  if (poids.some((p) => !Number.isInteger(p))) d.push('Les pondérations doivent être des nombres entiers de pourcentage.');
  if (poids.reduce((s, p) => s + p, 0) !== 100) {
    d.push('La somme des cinq pondérations doit faire exactement 100 % (actuellement '
      + poids.reduce((s, p) => s + p, 0) + ' %).');
  }
  const a = nombre(x.seuil_classe_a); const b = nombre(x.seuil_classe_b); const c = nombre(x.seuil_classe_c);
  if (!(a > b && b > c && c > 0 && a <= 100)) {
    d.push('Les seuils de classe doivent décroître : A > B > C > 0 et A ≤ 100.');
  }
  const effort = nombre(x.taux_effort_max_bp);
  if (effort < 500 || effort > 8000) d.push('Le taux d\'effort maximal doit rester entre 5 % et 80 % du revenu.');
  if (nombre(x.stabilite_min_m) < 10) d.push('Le rayon de stabilité GPS ne peut pas être inférieur à 10 mètres.');
  return d;
}

/* -------------------------------------------------------------------------
 *  PILIER 1 — ÉPARGNE & TONTINE
 * -------------------------------------------------------------------------
 * On ne récompense pas un gros solde déposé la veille : on récompense la
 * RÉGULARITÉ et l'ANCIENNETÉ.
 *   • 40 pts : ancienneté du compte (6 mois = 80, 12 mois = 100)
 *   • 40 pts : mois actifs (dépôts sur 6 mois : 4 mois = 100)
 *   • 20 pts : cycles de tontine terminés sur 6 mois (2 cycles = 100)
 * ---------------------------------------------------------------------- */
export function noterEpargne(e) {
  const x = e || {};
  const anciennete = nombre(x.anciennete_mois);
  const moisActifs = nombre(x.mois_actifs_6m);
  const cycles = nombre(x.cycles_tontine_complets_6m);
  const solde = nombre(x.solde_epargne_cents) + nombre(x.solde_tontine_cents);

  const pAnciennete = noteParPaliers(anciennete, [[0, 0], [3, 40], [6, 80], [12, 100]]);
  const pRegularite = noteParPaliers(moisActifs, [[0, 0], [1, 30], [3, 70], [4, 100]]);
  const pTontine = noteParPaliers(cycles, [[0, 0], [1, 55], [2, 100]]);

  const points = borne(0.40 * pAnciennete + 0.40 * pRegularite + 0.20 * pTontine, 0, 100);

  const facteurs = [];
  facteurs.push(anciennete >= 6
    ? 'Compte d\'épargne ouvert depuis ' + Math.floor(anciennete) + ' mois'
    : 'Compte d\'épargne récent (' + Math.floor(anciennete) + ' mois) : l\'ancienneté pèse peu');
  facteurs.push(moisActifs >= 4
    ? 'Épargne alimentée ' + Math.floor(moisActifs) + ' mois sur les 6 derniers'
    : 'Épargne alimentée seulement ' + Math.floor(moisActifs) + ' mois sur 6 : irrégularité');
  facteurs.push(cycles >= 2
    ? Math.floor(cycles) + ' cycles de tontine menés à leur terme sur 6 mois'
    : (cycles >= 1 ? '1 cycle de tontine terminé sur 6 mois'
      : 'Aucun cycle de tontine terminé sur 6 mois'));

  return {
    pilier: PILIERS.EPARGNE,
    libelle: LIBELLE_PILIER.epargne,
    points: arrondi2(points),
    indicateurs: {
      anciennete_mois: Math.floor(anciennete),
      mois_actifs_6m: Math.floor(moisActifs),
      cycles_tontine_complets_6m: Math.floor(cycles),
      solde_epargne_cents: nombre(x.solde_epargne_cents),
      solde_tontine_cents: nombre(x.solde_tontine_cents),
      epargne_totale_cents: solde,
      sous_notes: {
        anciennete: arrondi2(pAnciennete),
        regularite: arrondi2(pRegularite),
        tontine: arrondi2(pTontine)
      }
    },
    facteurs
  };
}

/* -------------------------------------------------------------------------
 *  PILIER 2 — FLUX & TAUX D'EFFORT
 * -------------------------------------------------------------------------
 * Le revenu n'est pas déclaré : il est OBSERVÉ (moyenne des entrées de
 * collecte des 6 derniers mois, contre-passations exclues côté requête).
 *   • 50 pts : régularité des flux (mois avec entrée sur 6 : 5 = 100)
 *   • 50 pts : taux d'effort = mensualité estimée / revenu net observé
 *              atterrissage à 0 au-delà du plafond de la grille (35 %)
 * On renvoie aussi `taux_effort_bp` pour que la route puisse alerter.
 * ---------------------------------------------------------------------- */
export function noterFlux(f, options) {
  const x = f || {};
  const o = options || {};
  const revenu = Math.max(0, Math.round(nombre(x.revenu_net_cents_mois)));
  const moisAvecFlux = nombre(x.mois_avec_flux_6m);
  const variation = nombre(x.variation_flux_bp); // écart-type / moyenne, en points de base
  const mensualite = Math.max(0, Math.round(nombre(x.mensualite_estimee_cents)));
  const effortMaxBp = nombre(o.taux_effort_max_bp || GRILLE_DEFAUT.taux_effort_max_bp);

  const tauxEffortBp = revenu > 0 ? Math.round((mensualite / revenu) * 10000) : 10000;

  const pRegularite = noteParPaliers(moisAvecFlux, [[0, 0], [2, 35], [4, 70], [5, 100]]);
  // Stabilité : une variation de 0 % = 100 pts, 60 % d'écart = 20 pts.
  const pStabilite = noteParPaliers(variation, [[0, 100], [2500, 80], [4000, 55], [6000, 20]]);
  // Effort : 0 % = 100 pts ; plafond (35 %) = 30 pts ; 2 x plafond = 0 pt.
  const pEffort = noteParPaliers(tauxEffortBp, [
    [0, 100],
    [Math.round(effortMaxBp * 0.5), 85],
    [effortMaxBp, 30],
    [Math.round(effortMaxBp * 2), 0]
  ]);

  const points = borne(0.30 * pRegularite + 0.20 * pStabilite + 0.50 * pEffort, 0, 100);

  const facteurs = [];
  if (revenu <= 0) {
    facteurs.push('Aucune entrée de collecte observée sur 6 mois : revenu non mesurable');
  } else {
    facteurs.push('Revenu net observé : ' + fcfa(revenu) + ' par mois (moyenne 6 mois)');
    facteurs.push('Mensualité estimée : ' + fcfa(mensualite)
      + ' soit ' + (tauxEffortBp / 100).toFixed(1).replace('.', ',') + ' % du revenu');
    if (tauxEffortBp > effortMaxBp) {
      facteurs.push('Taux d\'effort au-delà du plafond de ' + (effortMaxBp / 100) + ' % : la mensualité sera difficile à tenir');
    }
  }
  if (moisAvecFlux < 4) facteurs.push('Flux irréguliers : ' + Math.floor(moisAvecFlux) + ' mois sur 6 seulement');

  return {
    pilier: PILIERS.FLUX,
    libelle: LIBELLE_PILIER.flux,
    points: arrondi2(points),
    indicateurs: {
      revenu_net_cents_mois: revenu,
      mois_avec_flux_6m: Math.floor(moisAvecFlux),
      variation_flux_bp: Math.round(variation),
      mensualite_estimee_cents: mensualite,
      taux_effort_bp: tauxEffortBp,
      taux_effort_max_bp: effortMaxBp,
      sous_notes: {
        regularite: arrondi2(pRegularite),
        stabilite: arrondi2(pStabilite),
        effort: arrondi2(pEffort)
      }
    },
    facteurs
  };
}

/* -------------------------------------------------------------------------
 *  PILIER 3 — STABILITÉ DU LIEU (GPS)
 * -------------------------------------------------------------------------
 * Le téléphone relève la position à chaque visite et à chaque dépôt. Un
 * commerçant stable relève toujours au même endroit ; un dossier « nomade »
 * (lieu qui change, signaux faibles) est plus risqué.
 *   • 45 pts : rayon de dispersion des relevés (< 50 m = 100)
 *   • 25 pts : précision moyenne du GPS (≤ 15 m = 100)
 *   • 15 pts : ancienneté du dernier relevé (≤ 30 jours = 100)
 *   • 15 pts : nombre de visites terrain sur 6 mois (≥ 3 = 100)
 * `confiance` baisse quand les relevés sont peu précis : on ne prétend pas
 * mesurer une stabilité qu'on voit mal.
 * ---------------------------------------------------------------------- */
export function noterStabiliteGps(s, options) {
  const x = s || {};
  const o = options || {};
  const rayon = nombre(x.rayon_m);
  const nb = nombre(x.nb_releves);
  const precision = nombre(x.precision_moy_m);
  const jours = x.jours_dernier_releve == null ? null : nombre(x.jours_dernier_releve);
  const visites = nombre(x.nb_visites_6m);
  const maxM = nombre(o.stabilite_min_m || GRILLE_DEFAUT.stabilite_min_m);
  const visitesMin = nombre(o.nb_visites_min || GRILLE_DEFAUT.nb_visites_min);

  if (nb < 2) {
    return {
      pilier: PILIERS.STABILITE,
      libelle: LIBELLE_PILIER.stabilite_gps,
      points: 0,
      indicateurs: {
        nb_releves: Math.floor(nb), rayon_m: 0, precision_moy_m: Math.round(precision),
        jours_dernier_releve: jours, nb_visites_6m: Math.floor(visites),
        confiance: 0, stabilite_min_m: maxM
      },
      facteurs: ['Aucun relevé GPS exploitable : la stabilité du lieu ne peut pas être mesurée']
    };
  }

  const pRayon = noteParPaliers(rayon, [[0, 100], [Math.round(maxM * 0.5), 90], [maxM, 70], [maxM * 2, 35], [maxM * 4, 0]]);
  const pPrecision = noteParPaliers(precision, [[0, 100], [15, 100], [50, 70], [150, 30], [500, 0]]);
  const pRecence = jours == null ? 40 : noteParPaliers(jours, [[0, 100], [30, 100], [90, 60], [180, 25], [365, 0]]);
  const pVisites = noteParPaliers(visites, [[0, 0], [1, 40], [visitesMin, 100]]);

  let points = 0.45 * pRayon + 0.25 * pPrecision + 0.15 * pRecence + 0.15 * pVisites;
  // Confiance : précision moyenne du GPS (1 à 25 m = pleine confiance).
  const confiance = precision <= 0 ? 1 : borne(25 / Math.max(25, precision), 0.25, 1);
  points = points * confiance;

  const facteurs = [];
  facteurs.push(rayon <= maxM
    ? 'Lieu d\'activité stable : relevés dans un rayon de ' + Math.round(rayon) + ' m'
    : 'Lieu d\'activité dispersé : relevés sur ' + Math.round(rayon) + ' m (au-delà de ' + maxM + ' m)');
  facteurs.push(precision <= 15
    ? 'Position GPS précise (' + Math.round(precision) + ' m)'
    : 'Position GPS peu précise (' + Math.round(precision) + ' m) : confiance réduite');
  if (jours != null && jours > 90) facteurs.push('Dernier relevé il y a ' + Math.round(jours) + ' jours');
  if (visites < visitesMin) facteurs.push(Math.floor(visites) + ' visite(s) terrain sur 6 mois (minimum ' + visitesMin + ')');

  return {
    pilier: PILIERS.STABILITE,
    libelle: LIBELLE_PILIER.stabilite_gps,
    points: arrondi2(borne(points, 0, 100)),
    indicateurs: {
      nb_releves: Math.floor(nb), rayon_m: Math.round(rayon),
      precision_moy_m: Math.round(precision), jours_dernier_releve: jours,
      nb_visites_6m: Math.floor(visites), confiance: arrondi2(confiance),
      stabilite_min_m: maxM,
      sous_notes: {
        rayon: arrondi2(pRayon), precision: arrondi2(pPrecision),
        recence: arrondi2(pRecence), visites: arrondi2(pVisites)
      }
    },
    facteurs
  };
}

/* -------------------------------------------------------------------------
 *  PILIER 4 — HISTORIQUE DE CRÉDIT (+ avis BIC UEMOA saisi à la main)
 * -------------------------------------------------------------------------
 * Un premier crédit n'est pas une faute : on donne une note neutre (55) pour
 * ne pas exclure les nouveaux clients, mais l'absence d'avis BIC empêche
 * d'atteindre le maximum.
 *   • 70 pts : comportement de remboursement observé
 *   • 30 pts : avis BIC (A = 100, B = 70, C = 35, D = 0 ; absent = 55)
 * ---------------------------------------------------------------------- */
export function noterHistorique(h) {
  const x = h || {};
  const nb = nombre(x.nb_credits);
  const clos = nombre(x.nb_credits_clos);
  const retards = nombre(x.nb_retards_graves);
  const joursRetardMoyen = nombre(x.jours_retard_moyen);
  const impayeCents = nombre(x.impaye_cents);
  const avis = x.avis_bic_uemoa ? String(x.avis_bic_uemoa).toUpperCase().slice(0, 1) : null;

  let pComportement;
  if (nb === 0) {
    pComportement = 55; // premier crédit : neutre, ni bonus ni malus
  } else {
    const pClos = noteParPaliers(clos / Math.max(1, nb), [[0, 20], [0.5, 70], [1, 100]]);
    const pRetards = noteParPaliers(retards, [[0, 100], [1, 55], [2, 20], [3, 0]]);
    const pJours = noteParPaliers(joursRetardMoyen, [[0, 100], [15, 80], [45, 50], [90, 20], [180, 0]]);
    const pImpaye = impayeCents > 0 ? 0 : 100;
    pComportement = 0.35 * pClos + 0.30 * pRetards + 0.20 * pJours + 0.15 * pImpaye;
  }

  const tableAvis = { A: 100, B: 70, C: 35, D: 0 };
  const pAvis = avis && Object.prototype.hasOwnProperty.call(tableAvis, avis) ? tableAvis[avis] : 55;

  const points = borne(0.70 * pComportement + 0.30 * pAvis, 0, 100);

  const facteurs = [];
  if (nb === 0) facteurs.push('Premier crédit : aucun historique, note neutre (ni bonus ni malus)');
  else {
    facteurs.push(Math.floor(clos) + ' crédit(s) soldé(s) sur ' + Math.floor(nb));
    if (retards > 0) facteurs.push(Math.floor(retards) + ' retard(s) de plus de 30 jours');
    if (impayeCents > 0) facteurs.push('Impayé en cours : ' + fcfa(impayeCents));
  }
  facteurs.push(avis
    ? 'Avis BIC UEMOA saisi : ' + avis + (avis === 'A' ? ' (dossier sain)' : (avis === 'D' ? ' (défaut avéré)' : ''))
    : 'Avis BIC UEMOA non fourni : la note ne peut pas être bonifiée');

  return {
    pilier: PILIERS.HISTORIQUE,
    libelle: LIBELLE_PILIER.historique,
    points: arrondi2(points),
    indicateurs: {
      nb_credits: Math.floor(nb), nb_credits_clos: Math.floor(clos),
      nb_retards_graves: Math.floor(retards), jours_retard_moyen: Math.round(joursRetardMoyen),
      impaye_cents: impayeCents, avis_bic_uemoa: avis,
      sous_notes: { comportement: arrondi2(pComportement), avis_bic: arrondi2(pAvis) }
    },
    facteurs
  };
}

/* -------------------------------------------------------------------------
 *  PILIER 5 — GARANTIES
 * -------------------------------------------------------------------------
 * On compare la garantie RÉELLEMENT constituée (épargne bloquée, caution
 * validée) au montant demandé. Une garantie seulement « annoncée » ne
 * compte pas.
 * ---------------------------------------------------------------------- */
export function noterGaranties(g) {
  const x = g || {};
  const montant = nombre(x.montant_demande_cents);
  const constituee = nombre(x.garanties_constituees_cents);
  const engagee = nombre(x.garanties_engagees_cents);
  const nb = nombre(x.nb_garanties);
  const couverture = pourcent(constituee, montant);
  const type = x.type_principal ? String(x.type_principal).toUpperCase() : null;

  // Type : l'épargne bloquée est la plus fongible, l'hypothèque la plus lente.
  const tableType = {
    EPARGNE_BLOQUEE: 100, CAUTION_SOLIDAIRE: 85, AVAL: 80, NANTISSEMENT: 75,
    STOCK: 70, GAGE_VEHICULE: 65, HYPOTHEQUE: 55, AUTRE: 40
  };
  const pType = type && Object.prototype.hasOwnProperty.call(tableType, type) ? tableType[type] : 40;

  // Couverture : 30 % = 80 pts, 50 % = 100 pts, 15 % = 40 pts, 0 = 0.
  const pCouverture = noteCouverture(couverture);

  // Aucune garantie déclarée = 0 point, sans note « de forme » : un dossier
  // vide ne doit jamais tirer un avantage de sa nature de garantie par défaut.
  const points = nb > 0
    ? borne(0.60 * pCouverture + 0.25 * pType + 0.15 * noteParPaliers(nb, [[0, 0], [1, 100]]), 0, 100)
    : 0;

  const facteurs = [];
  if (!nb) facteurs.push('Aucune garantie enregistrée sur le dossier');
  else {
    facteurs.push('Garanties constituées : ' + fcfa(constituee)
      + ' soit ' + couverture.toFixed(0) + ' % de la demande');
    if (engagee > constituee) {
      facteurs.push('Garanties annoncées mais non constituées : ' + fcfa(engagee - constituee) + ' en attente');
    }
  }

  return {
    pilier: PILIERS.GARANTIES,
    libelle: LIBELLE_PILIER.garanties,
    points: arrondi2(points),
    indicateurs: {
      montant_demande_cents: montant,
      garanties_constituees_cents: constituee,
      garanties_engagees_cents: engagee,
      nb_garanties: Math.floor(nb),
      type_principal: type,
      couverture_bp: Math.round(couverture * 100),
      sous_notes: { couverture: arrondi2(pCouverture), type: arrondi2(pType) }
    },
    facteurs
  };
}

function noteCouverture(couverturePourcent) {
  return noteParPaliers(nombre(couverturePourcent), [[0, 0], [15, 40], [30, 80], [50, 100], [100, 100]]);
}

/* -------------------------------------------------------------------------
 *  COMPOSITION — score, classe, plafond, alertes
 * ---------------------------------------------------------------------- */

/** Poids effectifs de la grille, dans l'ordre des axes du radar. */
export function poidsGrille(grille) {
  const g = { ...GRILLE_DEFAUT, ...(grille || {}) };
  return {
    epargne: nombre(g.poids_epargne),
    flux: nombre(g.poids_flux),
    stabilite_gps: nombre(g.poids_stabilite_gps),
    historique: nombre(g.poids_historique),
    garanties: nombre(g.poids_garanties)
  };
}

/** Classe de risque à partir du score et des seuils. */
export function classeRisque(score, grille) {
  const g = { ...GRILLE_DEFAUT, ...(grille || {}) };
  const s = nombre(score);
  if (s >= nombre(g.seuil_classe_a)) return 'A';
  if (s >= nombre(g.seuil_classe_b)) return 'B';
  if (s >= nombre(g.seuil_classe_c)) return 'C';
  return 'D';
}

/**
 * Plafond de crédit soutenable, en centimes, plafonné par trois limites :
 *   • la capacité de remboursement : mensualité max = revenu × taux d'effort,
 *     sur la durée du dossier ;
 *   • la note : score / 100 × 130 % du montant demandé (en plafond) ;
 *   • l'épargne disponible : la garantie éventuelle (3 x l'épargne totale),
 *     et jamais plus de 3 fois l'épargne observée si elle est faible.
 * Le résultat est arrondi à 5 000 FCFA (règle de guichet FCFA).
 */
export function plafondSoutenable(donnees) {
  const x = donnees || {};
  const g = { ...GRILLE_DEFAUT, ...(x.grille || {}) };
  const revenu = Math.max(0, nombre(x.revenu_net_cents_mois));
  const mensualiteMax = Math.round(revenu * nombre(g.taux_effort_max_bp) / 10000);
  const duree = Math.max(1, Math.round(nombre(x.duree_mois) || 1));
  const capacite = mensualiteMax * duree;
  const parNote = Math.round(nombre(x.montant_demande_cents) * nombre(g.plafond_score_bp) / 10000 * nombre(x.score) / 100);
  const demande = Math.max(0, nombre(x.montant_demande_cents));
  const epargne = Math.max(0, nombre(x.epargne_totale_cents));
  const plafondEpargne = epargne > 0 ? epargne * 3 : 0;

  const bornes = [capacite, parNote];
  if (plafondEpargne > 0) bornes.push(plafondEpargne);
  const brut = Math.min(...bornes, demande > 0 ? demande : Number.MAX_SAFE_INTEGER);
  // Arrondi à 5 000 FCFA inférieur (500 000 centimes).
  const palier = 500000;
  const arrondi = Math.floor(Math.max(0, brut) / palier) * palier;

  const limites = {
    capacite_remboursement_cents: capacite,
    selon_note_cents: parNote,
    selon_epargne_cents: plafondEpargne,
    montant_demande_cents: demande
  };
  const facteur = arrondi === capacite ? 'capacite_remboursement'
    : (arrondi === parNote ? 'note'
      : (arrondi === plafondEpargne ? 'epargne'
        : (arrondi === demande ? 'demande' : 'capacite_remboursement')));

  return { plafond_cents: arrondi, mensualite_max_cents: mensualiteMax, limites, facteur_limitant: facteur };
}

/**
 * Alertes métier : phrases courtes, lisibles au comité, chacune avec un
 * niveau (danger / alerte / info). Ce sont des motifs de discussion, pas des
 * interdictions automatiques.
 */
export function alertesMetier(donnees) {
  const x = donnees || {};
  const g = { ...GRILLE_DEFAUT, ...(x.grille || {}) };
  const a = [];
  const flux = x.flux || {};
  const hist = x.historique || {};
  const gps = x.stabilite || {};
  const epargne = x.epargne || {};
  const garanties = x.garanties || {};
  const effortBp = nombre(flux.taux_effort_bp);
  const effortMax = nombre(flux.taux_effort_max_bp || g.taux_effort_max_bp);

  if (effortBp > effortMax) {
    a.push({ niveau: 'danger', code: 'EFFORT_DEPASSE',
      message: 'Taux d\'effort de ' + (effortBp / 100).toFixed(1).replace('.', ',')
        + ' % : au-delà du plafond de ' + (effortMax / 100) + ' % du revenu observé.' });
  }
  if (nombre(flux.revenu_net_cents_mois) <= 0) {
    a.push({ niveau: 'danger', code: 'REVENU_NON_MESURE',
      message: 'Aucune entrée de collecte sur 6 mois : le revenu ne peut pas être vérifié.' });
  }
  if (nombre(hist.impaye_cents) > 0) {
    a.push({ niveau: 'danger', code: 'IMPAYE_EN_COURS',
      message: 'Impayé en cours de ' + fcfa(hist.impaye_cents) + ' : assainir avant tout nouveau crédit.' });
  }
  if (String(hist.avis_bic_uemoa || '').toUpperCase() === 'D') {
    a.push({ niveau: 'danger', code: 'BIC_DEFAUT',
      message: 'Avis BIC UEMOA « D » : défaut avéré dans une autre institution, dossier à écarter.' });
  }
  if (nombre(gps.nb_releves) < 2) {
    a.push({ niveau: 'alerte', code: 'GPS_INSUFFISANT',
      message: 'Moins de deux relevés GPS : le lieu d\'activité n\'a pas pu être vérifié.' });
  } else if (nombre(gps.rayon_m) > nombre(g.stabilite_min_m)) {
    a.push({ niveau: 'alerte', code: 'LIEU_DISPERSÉ',
      message: 'Relevés dispersés sur ' + Math.round(nombre(gps.rayon_m)) + ' m : vérifier le lieu d\'activité sur place.' });
  }
  if (nombre(gps.jours_dernier_releve) > 180) {
    a.push({ niveau: 'alerte', code: 'LIEU_NON_VU',
      message: 'Aucun relevé GPS depuis ' + Math.round(nombre(gps.jours_dernier_releve)) + ' jours : programmer une visite de terrain.' });
  }
  if (nombre(epargne.mois_actifs_6m) < 2) {
    a.push({ niveau: 'alerte', code: 'EPARGNE_FAIBLE',
      message: 'Épargne très peu alimentée : la capacité à s\'auto-discipliner n\'est pas démontrée.' });
  }
  const couverture = nombre(garanties.couverture_bp) / 100;
  if (nombre(garanties.nb_garanties) === 0 || garanties.couverture_bp == null
      || couverture < nombre(g.couverture_min_bp) / 100) {
    a.push({ niveau: 'alerte', code: 'GARANTIE_FAIBLE',
      message: 'Garanties constituées : ' + couverture.toFixed(0) + ' % de la demande (recommandé ≥ '
        + (nombre(g.couverture_min_bp) / 100).toFixed(0) + ' %).' });
  }
  if (!hist.avis_bic_uemoa) {
    a.push({ niveau: 'info', code: 'BIC_NON_FOURNI',
      message: 'Avis BIC UEMOA non saisi : réclamé ou noter « non disponible » dans le dossier.' });
  }
  if (x.plafond && nombre(x.plafond.plafond_cents) < nombre(x.montant_demande_cents)) {
    const nom = {
      capacite_remboursement: 'la capacité de remboursement',
      note: 'le niveau du score',
      epargne: 'l\'épargne constituée',
      demande: 'la demande'
    }[x.plafond.facteur_limitant] || 'la capacité de remboursement';
    a.push({ niveau: 'info', code: 'PLAFOND_REDUIT',
      message: 'Plafond soutenable ' + fcfa(x.plafond.plafond_cents) + ' : limité par ' + nom + '.' });
  }
  return a;
}

/**
 * ÉVALUATION COMPLÈTE — fonction pure.
 * @param {object} entree { dossier:{duree_mois, montant_demande_cents, periodicite},
 *                          epargne, flux, stabilite, historique, garanties,
 *                          grille, avis_bic_uemoa }
 * @returns {object} score_global, classe_risque, plafond_montant_suggere_cents,
 *                   details_indicateurs_json + synthèse lisible.
 */
export function evaluerScoring(entree) {
  const x = entree || {};
  const dossier = x.dossier || {};
  const grille = { ...GRILLE_DEFAUT, ...(x.grille || {}) };
  const poids = poidsGrille(grille);

  const montant = Math.max(0, nombre(dossier.montant_demande_cents));
  const duree = Math.max(1, Math.round(nombre(dossier.duree_mois) || 1));
  const parAn = 12; // mensualité estimée : on ramène la durée en mois
  const mensualite = duree > 0 ? Math.round(montant / duree) : 0;

  const epargne = noterEpargne(x.epargne || {});
  const flux = noterFlux({
    ...(x.flux || {}),
    mensualite_estimee_cents: (x.flux && x.flux.mensualite_estimee_cents != null)
      ? x.flux.mensualite_estimee_cents : mensualite
  }, { taux_effort_max_bp: grille.taux_effort_max_bp });
  const stabilite = noterStabiliteGps(x.stabilite || {}, {
    stabilite_min_m: grille.stabilite_min_m,
    nb_visites_min: grille.nb_visites_min
  });
  const historique = noterHistorique({
    ...(x.historique || {}),
    avis_bic_uemoa: (x.historique && x.historique.avis_bic_uemoa) || x.avis_bic_uemoa || null
  });
  const garanties = noterGaranties({
    ...(x.garanties || {}),
    montant_demande_cents: montant
  });

  const piliers = [epargne, flux, stabilite, historique, garanties];
  const parPilier = {
    epargne: epargne.points, flux: flux.points, stabilite_gps: stabilite.points,
    historique: historique.points, garanties: garanties.points
  };

  let score = 0;
  AXES_RADAR.forEach((k) => { score += (parPilier[k] * poids[k]) / 100; });
  score = arrondi2(borne(score, 0, 100));

  const classe = classeRisque(score, grille);
  const plafond = plafondSoutenable({
    revenu_net_cents_mois: flux.indicateurs.revenu_net_cents_mois,
    duree_mois: duree, montant_demande_cents: montant, score,
    epargne_totale_cents: epargne.indicateurs.epargne_totale_cents, grille
  });
  const alertes = alertesMetier({
    flux: flux.indicateurs, historique: historique.indicateurs,
    stabilite: stabilite.indicateurs, epargne: epargne.indicateurs,
    garanties: garanties.indicateurs, grille, montant_demande_cents: montant, plafond
  });
  // Une classe A ou B ne se donne jamais sur des garanties insuffisantes.
  let classeFinale = classe;
  const couvertureBp = nombre(garanties.indicateurs.couverture_bp);
  if ((classe === 'A' || classe === 'B') && couvertureBp < nombre(grille.couverture_min_bp)) {
    classeFinale = 'C';
  }

  const facteurs = [];
  piliers.forEach((p) => {
    p.facteurs.forEach((f) => {
      facteurs.push({ pilier: p.pilier, poids: poids[p.pilier], note_pilier: p.points, texte: f });
    });
  });

  const pointsFaibles = AXES_RADAR
    .map((k) => ({ pilier: k, libelle: LIBELLE_PILIER[k], points: parPilier[k], poids: poids[k] }))
    .sort((a, b) => a.points - b.points)
    .slice(0, 2);

  const details = {
    version_moteur: 1,
    grille: {
      code: grille.code, libelle: grille.libelle,
      poids, seuils: { a: nombre(grille.seuil_classe_a), b: nombre(grille.seuil_classe_b), c: nombre(grille.seuil_classe_c) },
      taux_effort_max_bp: nombre(grille.taux_effort_max_bp),
      couverture_min_bp: nombre(grille.couverture_min_bp)
    },
    piliers: piliers.map((p) => ({
      cle: p.pilier, libelle: p.libelle, poids: poids[p.pilier],
      points: p.points, points_ponderes: arrondi2((p.points * poids[p.pilier]) / 100),
      indicateurs: p.indicateurs
    })),
    par_pilier: parPilier,
    facteurs,
    points_faibles: pointsFaibles,
    plafond,
    alertes,
    classe_calculee: classe,
    classe_risque: classeFinale,
    ajustement: classeFinale !== classe
      ? 'Classe ramenée à C : garanties constituées inférieures au minimum exigé.' : null,
    mensualite_estimee_cents: mensualite,
    duree_mois: duree,
    par_an: parAn
  };

  return {
    score_global: score,
    classe_risque: classeFinale,
    libelle_classe: LIBELLE_CLASSE_RISQUE[classeFinale],
    plafond_montant_suggere_cents: plafond.plafond_cents,
    montant_demande_cents: montant,
    details_indicateurs_json: details,
    synthese: syntheseScore({ score, classe: classeFinale, plafond: plafond.plafond_cents,
      montant, pointsFaibles, alertes })
  };
}

/** Phrase de synthèse pour le comité (une seule, sans jargon). */
export function syntheseScore(p) {
  const x = p || {};
  const s = nombre(x.score);
  const classe = x.classe || 'D';
  const faibles = (x.pointsFaibles || []).map((f) => f.libelle.toLowerCase());
  let phrase;
  if (classe === 'A') phrase = 'Profil solide : le dossier est finançable en l\'état.';
  else if (classe === 'B') phrase = 'Profil correct : financement possible, suivi de proximité conseillé.';
  else if (classe === 'C') phrase = 'Profil fragile : réduire le montant ou renforcer la garantie avant de financer.';
  else phrase = 'Profil trop risqué au vu des données disponibles : ne pas financer en l\'état.';
  const pctPlafond = nombre(x.montant) > 0 ? Math.round(nombre(x.plafond) / nombre(x.montant) * 100) : 0;
  return phrase + ' Score ' + s.toFixed(1).replace('.', ',') + '/100, classe ' + classe
    + ', plafond recommandé ' + fcfa(x.plafond) + (pctPlafond ? ' (' + pctPlafond + ' % de la demande)' : '')
    + (faibles.length ? '. Points faibles : ' + faibles.join(', ') + '.' : '.')
    + ((x.alertes || []).some((a) => a.niveau === 'danger')
      ? ' ' + (x.alertes || []).filter((a) => a.niveau === 'danger').length + ' alerte(s) bloquante(s) à traiter.' : '');
}

/* -------------------------------------------------------------------------
 *  REQUÊTES D'AGRÉGATION (référence, à exécuter par la route)
 * -------------------------------------------------------------------------
 * Elles ne sont pas exécutées ici (le moteur reste pur). Elles sont exposées
 * pour la revue de code et l'audit : chaque requête est filtrée par imf_id.
 * 1) ÉPARGNE — account (balance_cents) + ancienneté + dépôts mensuels actifs :
 *      SELECT a.client_id, SUM(a.balance_cents),
 *             MIN(a.opened_at), COUNT(DISTINCT date_trunc('month', o.created_at))
 *        FROM account a LEFT JOIN operation o ON o.account_id=a.id
 *       WHERE a.imf_id=$1 AND a.client_id=$2
 *       GROUP BY a.client_id;
 * 2) TONTINE — cycles clos sur 6 mois et cotisations :
 *      SELECT COUNT(*) FILTER (WHERE c.statut IN ('CLOTURE','RENOUVELE')) ...
 *        FROM carnets_tontine c WHERE c.imf_id=$1 AND c.client_id=$2
 *         AND c.date_debut >= current_date - INTERVAL '6 months';
 * 3) FLUX — vue_transactions_collecte (socle operation), hors annulées :
 *      SELECT date_trunc('month', COALESCE(date_operation_locale, created_at)), SUM(amount_cents)
 *        FROM vue_transactions_collecte
 *       WHERE imf_id=$1 AND client_id=$2 AND direction=1 AND statut_sync='SYNCHRONISE'
 *         AND contre_passation_de IS NULL
 *         AND COALESCE(date_operation_locale, created_at) >= now() - INTERVAL '6 months'
 *       GROUP BY 1;
 * 4) GPS — client (domicile) + client_visit_log (visites) : calcul du rayon
 *    (haversine) et de la précision moyenne, au plus proche des relevés récents.
 * 5) HISTORIQUE — dossiers_credit (jours_retard, classe_creance, impayé) et
 *    echeanciers_credit non soldés ; avis BIC saisi manuellement.
 * 6) GARANTIES — garanties_credit du dossier, statut BLOQUEE = constituée.
 * ---------------------------------------------------------------------- */
