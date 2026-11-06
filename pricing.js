/**
 * teebo — Tarification de l'abonnement SaaS
 * ---------------------------------------------------------------------------
 * Le prix total proposé à l'IMF se compose de DEUX éléments :
 *   1) une LICENCE teeBo, frais UNIQUE d'activation : 250 000 FCFA ;
 *   2) un ABONNEMENT, facturé au choix en cycle MENSUEL ou ANNUEL.
 *
 * Le cycle ANNUEL (12 mois réglés d'avance) bénéficie d'une remise de 15 %,
 * appliquée uniquement sur la part abonnement (la licence reste au plein tarif).
 *
 * Valeurs fournies par le client (non arbitraires). Elles restent surchargeables
 * par variable d'environnement si besoin, sans être figées dans la logique.
 */

// Licence : 250 000 FCFA = 25 000 000 centimes.
export const LICENCE_CENTS = Number(process.env.TEEBO_LICENCE_CENTS || 25000000);
// Remise du cycle annuel : 15 % = 1500 points de base.
export const ANNUAL_DISCOUNT_BP = Number(process.env.TEEBO_ANNUAL_DISCOUNT_BP || 1500);

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
  const monthly = Math.round(Number(monthlyCents || 0));
  const licenceCents = LICENCE_CENTS;

  let subscriptionCents, discountCents, months, periodLabel;
  if (cycle === 'annuel') {
    months = 12;
    subscriptionCents = monthly * 12;
    discountCents = Math.round(subscriptionCents * ANNUAL_DISCOUNT_BP / 10000);
    periodLabel = '12 mois (annuel)';
  } else {
    months = 1;
    subscriptionCents = monthly;
    discountCents = 0;
    periodLabel = '1 mois (mensuel)';
  }

  const subtotalCents = licenceCents + subscriptionCents; // HT avant remise
  const totalCents = subtotalCents - discountCents;        // HT après remise

  return { billing: cycle, licenceCents, subscriptionCents, discountCents,
    subtotalCents, totalCents, periodLabel, months };
}

/**
 * Construit les lignes de désignation de la facture / proforma à partir du
 * détail stocké sur la demande d'accès (ou calculé à la volée).
 */
export function buildInvoiceLines({ planLabel, billing, licenceCents, subscriptionCents }) {
  const cycle = BILLING_CYCLES.includes(billing) ? billing : 'mensuel';
  const period = cycle === 'annuel' ? '12 mois (annuel)' : '1 mois (mensuel)';
  return [
    { label: 'Licence teeBo — activation (frais unique)', amountCents: Number(licenceCents || 0) },
    { label: 'Abonnement ' + (planLabel || 'teeBo') + ' — ' + period, amountCents: Number(subscriptionCents || 0) }
  ];
}
