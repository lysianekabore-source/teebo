/**
 * teebo — Tarification de l'abonnement SaaS (OFFRE UNIQUE)
 * ---------------------------------------------------------------------------
 * teebo propose désormais UNE SEULE offre, transparente, sans palier. Le prix
 * total proposé à l'IMF se compose de DEUX éléments :
 *   1) une LICENCE teeBo, frais UNIQUE d'activation : 250 000 FCFA ;
 *   2) un ABONNEMENT, facturé au choix en cycle MENSUEL ou ANNUEL.
 *
 * Barème unique (fourni par teebo, non arbitraire) :
 *   - Abonnement mensuel de base ........ 75 000 FCFA / mois ;
 *   - Cycle ANNUEL (12 mois d'avance) .... remise de 15 % sur l'abonnement,
 *     soit 63 750 FCFA / mois -> 765 000 FCFA / an (licence au plein tarif) ;
 *   - Essai gratuit de 30 jours : la licence n'est facturée qu'APRÈS l'essai.
 *
 * Pour rester lisible sur la proforma et la facture, l'abonnement annuel est
 * présenté NET (remise de 15 % déjà incluse dans le montant affiché) : il n'y a
 * donc pas de ligne « remise » séparée à soustraire. Toutes les valeurs restent
 * surchargeables par variable d'environnement, sans être figées dans la logique.
 */

// Licence : 250 000 FCFA = 25 000 000 centimes (frais unique d'activation).
export const LICENCE_CENTS = Number(process.env.TEEBO_LICENCE_CENTS || 25000000);
// Abonnement mensuel de base : 75 000 FCFA = 7 500 000 centimes.
export const MONTHLY_BASE_CENTS = Number(process.env.TEEBO_MONTHLY_CENTS || 7500000);
// Remise du cycle annuel : 15 % = 1500 points de base.
export const ANNUAL_DISCOUNT_BP = Number(process.env.TEEBO_ANNUAL_DISCOUNT_BP || 1500);

// Code de l'offre unique standardisée (référence en base : table `plan`).
export const STANDARD_PLAN_CODE = process.env.TEEBO_PLAN_CODE || 'standard';

export const BILLING_CYCLES = ['mensuel', 'annuel'];

// Mention portée sur la proforma et la facture définitive : l'essai gratuit
// de 30 jours fait partie de la période facturée (l'abonnement court à compter
// de l'activation / début d'essai) ; les 30 jours ne sont pas facturés en sus.
export const TRIAL_DAYS_INCLUDED = Number(process.env.TEEBO_TRIAL_DAYS || 30);
export const TRIAL_BILLING_NOTE =
  'Essai gratuit de ' + TRIAL_DAYS_INCLUDED + ' jours inclus dans la période d\'abonnement. ' +
  'La facturation de l\'abonnement court à compter de l\'activation de l\'accès (début de l\'essai) : ' +
  'les ' + TRIAL_DAYS_INCLUDED + ' jours d\'essai font partie de la période facturée et ne donnent lieu à aucun paiement supplémentaire.';

/**
 * Calcule le détail tarifaire d'une demande.
 * @param {number} monthlyCents  prix mensuel de la formule (plan.price_cents)
 * @param {string} billing       'mensuel' | 'annuel'
 * @returns {{billing,licenceCents,subscriptionCents,discountCents,subtotalCents,totalCents,periodLabel,months,lines}}
 */
export function computePricing(monthlyCents, billing) {
  const cycle = BILLING_CYCLES.includes(billing) ? billing : 'mensuel';
  const monthly = Math.round(Number(monthlyCents || MONTHLY_BASE_CENTS));
  const licenceCents = LICENCE_CENTS;

  // `subscriptionCents` est TOUJOURS le montant NET facturé (remise déjà
  // incluse en annuel). `savingsCents` = économie réalisée grâce au cycle
  // annuel, fournie uniquement à titre informatif. `discountCents` reste à 0
  // (plus de ligne « remise » à soustraire : la remise est déjà dans le net).
  let subscriptionCents, grossSubscriptionCents, savingsCents, months, periodLabel;
  if (cycle === 'annuel') {
    months = 12;
    grossSubscriptionCents = monthly * 12;
    savingsCents = Math.round(grossSubscriptionCents * ANNUAL_DISCOUNT_BP / 10000);
    subscriptionCents = grossSubscriptionCents - savingsCents; // net annuel
    periodLabel = '12 mois (annuel, remise \u221215 % incluse)';
  } else {
    months = 1;
    grossSubscriptionCents = monthly;
    savingsCents = 0;
    subscriptionCents = monthly;
    periodLabel = '1 mois (mensuel)';
  }

  const discountCents = 0;                                  // aucune remise à soustraire
  const subtotalCents = licenceCents + subscriptionCents;   // HT (net) = total
  const totalCents = subtotalCents;                          // HT

  return { billing: cycle, licenceCents, subscriptionCents, grossSubscriptionCents,
    savingsCents, discountCents, subtotalCents, totalCents, periodLabel, months };
}

/**
 * Construit les lignes de désignation de la facture / proforma à partir du
 * détail stocké sur la demande d'accès (ou calculé à la volée).
 */
export function buildInvoiceLines({ planLabel, billing, licenceCents, subscriptionCents }) {
  const cycle = BILLING_CYCLES.includes(billing) ? billing : 'mensuel';
  const period = cycle === 'annuel'
    ? '12 mois (annuel, remise \u221215 % incluse)'
    : '1 mois (mensuel)';
  return [
    { label: 'Licence teeBo \u2014 activation (frais unique)', amountCents: Number(licenceCents || 0) },
    { label: 'Abonnement ' + (planLabel || 'teeBo') + ' \u2014 ' + period, amountCents: Number(subscriptionCents || 0) }
  ];
}
