/**
 * teebo — Tarification de l'abonnement SaaS (ABONNEMENT PAR MODULE)
 * ---------------------------------------------------------------------------
 * MODÈLE COMMERCIAL (corrigé le 16/11/2026) :
 * teebo ne vend plus des « formules » (Starter / Business / Enterprise) mais
 * des MODULES, choisis librement par chaque IMF. Le prix à payer se compose
 * de DEUX éléments :
 *   1) une LICENCE teeBo, frais UNIQUE d'activation : 250 000 FCFA ;
 *   2) un ABONNEMENT PAR MODULE, facturé mensuellement (tarif catalogue) ou
 *      annuellement (tarif catalogue − 15 %).
 * Aucun tarif par utilisateur ni par agence.
 *
 * CATALOGUE (source de vérité : table saas_modules_pricing, lue par
 * saas_billing.js ; les valeurs ci-dessous ne servent que de REPLI si la base
 * n'est pas encore migrée, et d'affichage instantané côté site) :
 *   Collecte & tontines ......... 75 000 FCFA / mois
 *   Dossiers de crédit .......... 100 000 FCFA / mois
 *   Conformité & KYC ............. 25 000 FCFA / mois
 *   Comptabilité avancée ........ 100 000 FCFA / mois
 *   => les 4 modules : 300 000 FCFA / mois
 *
 * RÈGLES DE FACTURATION
 *   - Cycle MENSUEL : somme des modules souscrits au tarif catalogue.
 *   - Cycle ANNUEL  : somme des modules souscrits − 15 %, facturée en une fois
 *     sur 12 mois (la remise ne court qu'à partir de la date exacte de
 *     signature, sans effet rétroactif : voir setBillingCycle / computeMonth).
 *   - PACK COMPLET (les 4 modules ensemble) : remise supplémentaire de 5 %
 *     (réglage FULL_PACK_DISCOUNT_PERCENT en base).
 *   - Essai gratuit : 30 jours par module au maximum, une seule fois par module.
 *
 * MONTANTS
 *   Toutes les valeurs ci-dessous sont exprimées en CENTIMES de FCFA, en
 *   nombres entiers : aucun calcul en virgule flottante, aucun arrondi
 *   surprenant (250 000 FCFA = 25 000 000 centimes).
 *   Chaque montant reste surchargeable par variable d'environnement.
 */

// Licence : 250 000 FCFA = 25 000 000 centimes (frais unique d'activation).
export const LICENCE_CENTS = Number(process.env.TEEBO_LICENCE_CENTS || 25000000);

// Remise du cycle annuel : 15 % = 1500 points de base.
export const ANNUAL_DISCOUNT_BP = Number(process.env.TEEBO_ANNUAL_DISCOUNT_BP || 1500);

// Remise « pack complet » (tous les modules souscrits) : 5 % = 500 points de base.
export const FULL_PACK_DISCOUNT_BP = Number(process.env.TEEBO_FULL_PACK_DISCOUNT_BP || 500);

// Essai gratuit par module.
export const TRIAL_DAYS = Number(process.env.TEEBO_TRIAL_DAYS || 30);

/** Cycles de facturation acceptés. */
export const BILLING_CYCLES = ['mensuel', 'annuel'];

/**
 * Catalogue de REPLI (base non migrée / affichage immédiat).
 * Les clés sont celles de saas_modules_pricing et de institution_features.
 * `monthlyCents` = prix catalogue mensuel en centimes de FCFA.
 */
export const MODULE_CATALOG = Object.freeze([
  { key: 'MODULE_COLLECTE_TONTINE',
    label: 'Collecte & tontines',
    short: 'Collecte',
    description: 'Tournées de collecte, dépôts, versements, reçus et tontines.',
    monthlyCents: 7500000,          // 75 000 FCFA / mois
    position: 10 },
  { key: 'MODULE_DOSSIER_CREDIT',
    label: 'Dossiers de crédit',
    short: 'Crédit',
    description: 'Demandes, analyse 5C, comité, décaissement, échéanciers, PAR 30/90.',
    monthlyCents: 10000000,         // 100 000 FCFA / mois
    position: 20 },
  { key: 'MODULE_COMPLIANCE_KYC',
    label: 'Conformité & KYC (LCB-FT)',
    short: 'Conformité',
    description: 'Validation KYC, PPE, listes de sanctions, gel, certificats de diligence.',
    monthlyCents: 2500000,          // 25 000 FCFA / mois
    position: 30 },
  { key: 'MODULE_COMPTABILITE_AVANCEE',
    label: 'Comptabilité avancée',
    short: 'Comptabilité',
    description: 'Grand livre immuable, journaux, balance et états BCEAO.',
    monthlyCents: 10000000,         // 100 000 FCFA / mois
    position: 40 }
]);

/** Clés connues du catalogue (validation des entrées). */
export const MODULE_KEYS = Object.freeze(MODULE_CATALOG.map((m) => m.key));

/** Retrouve un module du catalogue de repli (ou null). */
export function catalogModule(key) {
  return MODULE_CATALOG.find((m) => m.key === key) || null;
}

/** Libellé court d'un module (pour les lignes de facture). */
export function moduleLabel(key) {
  const m = catalogModule(key);
  return m ? m.label : String(key || 'Module');
}

/** Convertit des points de base en montant arrondi (entier de centimes). */
function applyBp(cents, bp) {
  return Math.round((Number(cents) || 0) * Number(bp) / 10000);
}

/**
 * Normalise une liste de modules souscrits.
 * Accepte les deux conventions utilisées par le serveur :
 *   { key | module_key, monthlyCents | monthly_cents | prix_mensuel | monthly_price }
 * et renvoie une liste propre { key, label, monthlyCents }.
 * @param {Array} modules
 * @returns {Array<{key:string,label:string,monthlyCents:number}>}
 */
export function normalizeModules(modules = []) {
  const out = [];
  for (const raw of Array.isArray(modules) ? modules : []) {
    // Une chaîne (« MODULE_DOSSIER_CREDIT ») est acceptée telle quelle :
    // le tarif est alors celui du catalogue, jamais 0 par oubli.
    const item = (typeof raw === 'string') ? { key: raw } : raw;
    if (!item) continue;
    const key = item.key || item.module_key || item.moduleKey || item.code;
    if (!key) continue;
    let cents = Number(item.monthlyCents != null ? item.monthlyCents
      : item.monthly_cents != null ? item.monthly_cents
      : item.prix_mensuel != null ? item.prix_mensuel
      : item.monthly_price != null ? item.monthly_price
      : item.price_cents != null ? item.price_cents : NaN);
    const ref = catalogModule(key);
    // Repli sur le catalogue si aucun prix n'est fourni : le prix d'un module
    // ne peut pas tomber à 0 parce qu'un appelant a oublié le champ.
    if (!Number.isFinite(cents) || cents <= 0) cents = ref ? ref.monthlyCents : 0;
    out.push({
      key,
      label: item.label || item.module_name || (ref ? ref.label : key),
      monthlyCents: Math.round(cents)
    });
  }
  return out;
}

/**
 * Calcule le détail tarifaire d'un abonnement PAR MODULE.
 *
 * @param {Array}  modules  modules souscrits (voir normalizeModules)
 * @param {string} billing  'mensuel' | 'annuel'
 * @param {object} [opts]   { fullPack?: boolean, fullPackBp?: number, licenceCents?: number }
 * @returns {{
 *   billing, modules, nbModules, licenceCents,
 *   modulesGrossCents, annualDiscountCents, packDiscountCents, discountCents,
 *   subtotalCents, totalCents, monthlyEquivalentCents,
 *   months, periodLabel, lines
 * }}
 */
export function computePricing(modules, billing, opts = {}) {
  const cycle = BILLING_CYCLES.includes(billing) ? billing : 'mensuel';
  const list = normalizeModules(modules);
  const licenceCents = Math.max(0, Math.round(
    Number(opts.licenceCents != null ? opts.licenceCents : LICENCE_CENTS) || 0));

  // 1) Somme des modules au tarif catalogue, au rythme du cycle choisi.
  const monthlyGross = list.reduce((s, m) => s + m.monthlyCents, 0);
  const months = cycle === 'annuel' ? 12 : 1;
  const modulesGrossCents = monthlyGross * months;

  // 2) Remise annuelle (−15 %) : ne porte QUE sur les abonnements, jamais sur
  //    la licence d'activation.
  const annualDiscountCents = cycle === 'annuel'
    ? applyBp(modulesGrossCents, ANNUAL_DISCOUNT_BP) : 0;

  // 3) Remise pack complet (−5 %) : seulement si l'IMF prend TOUS les modules
  //    du catalogue (elle s'ajoute à la remise annuelle, assiette = abonnements
  //    nets de la remise annuelle).
  const packBp = opts.fullPackBp != null ? Number(opts.fullPackBp) : FULL_PACK_DISCOUNT_BP;
  const fullPack = opts.fullPack === true
    && MODULE_CATALOG.every((c) => list.some((m) => m.key === c.key));
  const packDiscountCents = fullPack && packBp > 0
    ? applyBp(modulesGrossCents - annualDiscountCents, packBp) : 0;

  const discountCents = annualDiscountCents + packDiscountCents;
  const subtotalCents = licenceCents + modulesGrossCents;
  const totalCents = Math.max(0, subtotalCents - discountCents);

  const periodLabel = cycle === 'annuel' ? '12 mois (annuel)' : '1 mois (mensuel)';
  const monthlyEquivalentCents = months === 12
    ? Math.round((modulesGrossCents - discountCents) / 12)
    : (modulesGrossCents - discountCents);

  return {
    billing: cycle,
    modules: list,
    nbModules: list.length,
    licenceCents,
    modulesGrossCents,
    annualDiscountCents,
    packDiscountCents,
    fullPack,
    discountCents,
    subtotalCents,
    totalCents,
    monthlyEquivalentCents,
    months,
    periodLabel
  };
}

/**
 * Construit les lignes de désignation d'une proforma / facture.
 * Une ligne par module souscrit (jamais un prix global opaque), la licence
 * d'activation, puis les remises réellement consenties.
 *
 * @param {object} p { modules, billing, licenceCents, modulesGrossCents,
 *                     annualDiscountCents, packDiscountCents }
 * @returns {Array<{label:string, amountCents:number}>}
 */
export function buildInvoiceLines(p) {
  const o = p || {};
  const cycle = BILLING_CYCLES.includes(o.billing) ? o.billing : 'mensuel';
  const list = normalizeModules(o.modules || []);
  const lines = [
    { label: 'Licence teeBo — activation (frais unique)', amountCents: Math.round(Number(o.licenceCents) || 0) }
  ];
  for (const m of list) {
    const amount = cycle === 'annuel' ? m.monthlyCents * 12 : m.monthlyCents;
    lines.push({
      label: 'Module ' + m.label + ' — ' + (cycle === 'annuel' ? '12 mois (annuel)' : '1 mois (mensuel)'),
      amountCents: amount
    });
  }
  // Si l'appelant ne fournit pas le détail par module mais un montant global,
  // on garde au moins une ligne lisible : jamais de facture vide.
  if (!list.length && Number(o.modulesGrossCents) > 0) {
    lines.push({
      label: 'Abonnement modules teeBo — ' + (cycle === 'annuel' ? '12 mois (annuel)' : '1 mois (mensuel)'),
      amountCents: Math.round(Number(o.modulesGrossCents))
    });
  }
  return lines;
}

/**
 * Mention portée sur la proforma et la facture : l'essai de 30 jours par module
 * fait partie de la période facturée (aucun paiement supplémentaire).
 */
export const TRIAL_BILLING_NOTE =
  'Essai gratuit de ' + TRIAL_DAYS + ' jours par module (une seule fois par module). ' +
  'Un module en essai n\'est pas facturé ; la facturation de ce module court à compter du ' +
  'lendemain de la fin de son essai. La licence teeBo est facturée une seule fois.';

/** Alias historique conservé pour la compatibilité des écrans existants. */
export const TRIAL_DAYS_INCLUDED = TRIAL_DAYS;

export default {
  LICENCE_CENTS, ANNUAL_DISCOUNT_BP, FULL_PACK_DISCOUNT_BP, TRIAL_DAYS,
  BILLING_CYCLES, MODULE_CATALOG, MODULE_KEYS, catalogModule, moduleLabel,
  normalizeModules, computePricing, buildInvoiceLines, TRIAL_BILLING_NOTE,
  TRIAL_DAYS_INCLUDED
};
