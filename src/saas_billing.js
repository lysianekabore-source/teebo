// =========================================================================
// teebo — FACTURATION SAAS PAR MODULE (licence unique + abonnements + cycle)
// =========================================================================
// CE QUE FAIT CE MODULE
//   1. LICENCE UNIQUE 250 000 FCFA : une seule fois à vie.
//   2. ABONNEMENT PAR MODULE : mensuel (prix catalogue) ou annuel
//      (prix catalogue − 15 %), jamais par utilisateur ni par agence.
//   3. ESSAI GRATUIT : un module en essai à la date de facturation coûte
//      STRICTEMENT 0 FCFA ; les jours restants sont reportés au mois suivant.
//   4. PRORATA AU JOUR PRÈS, y compris lors d'une bascule mensuel -> annuel
//      en cours de mois (la réduction de 15 % ne court qu'à partir de la
//      date exacte de signature).
//   5. PACK COMPLET : −5 % sur les abonnements du mois.
//
// RÈGLE D'OR SUR LES MONTANTS
//   • Aucun calcul en flottant : tout passe par money.js (big.js, décimal).
//   • Le calcul OFFICIEL est fait par PostgreSQL (evaluate_imf_month /
//     generate_imf_monthly_invoice_v4) en NUMERIC(12,2).
//   • L'aperçu reproduit exactement les mêmes règles ; un test compare les
//     deux résultats au centime près.
// =========================================================================
import { q } from './db.js';
import { dec, r2, sum, prorata, pct, toSql, cmp, formatFcfa } from './money.js';

/* ------------------------------------------------------------------------- */
/*  Outils de date (UTC purs, aucune arithmétique monétaire)                  */
/* ------------------------------------------------------------------------- */
const jour = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);
const debutMois = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const finMois = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
const jourSuivant = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
const nbJours = (a, b) => Math.round((b - a) / 86400000);   // a exclu, b inclus
// Nombre de jours d'un intervalle INCLUSIF : du jour a (inclus) au jour b (inclus).
// nbJoursInclus(1er, 16) = 16 ; on retire 1 pour obtenir une durée facturée.
const nbJoursInclus = (a, b) => nbJours(a, b) + 1;
const plusTard = (...ds) => ds.filter(Boolean).reduce((a, b) => (b > a ? b : a));

const CYCLE_ANNUEL = 'ANNUEL';
const CYCLE_MENSUEL = 'MENSUEL';

/* ------------------------------------------------------------------------- */
/*  Catalogue et réglages (NUMERIC lus en CHAÎNE, jamais en flottant)         */
/* ------------------------------------------------------------------------- */
/** Tarifs du catalogue. `prix_mensuel` est une CHAÎNE décimale. */
export async function listModulePricing() {
  const { rows } = await q(
    `SELECT p.module_key, p.module_name,
            p.monthly_subscription_price::text AS prix_mensuel,
            p.monthly_subscription_price::text AS monthly_price,
            p.is_available, p.position,
            c.prix_annuel_mensualise_fcfa::text AS prix_annuel_mensualise,
            c.remise_annuelle_pct::text AS remise_annuelle_pct
       FROM saas_modules_pricing p
       LEFT JOIN v_saas_module_cost c ON c.module_key = p.module_key
      ORDER BY p.position, p.module_key`);
  return rows;
}

/** Prix de la licence unique (chaîne décimale). */
export async function getLicensePrice() {
  const { rows } = await q(
    `SELECT setting_value::text AS price FROM saas_global_settings
      WHERE setting_key='UNIQUE_LICENSE_PRICE'`);
  return rows.length ? rows[0].price : '0.00';
}

/** Remise pack complet (%) et remise annuelle (%), en chaîne décimale. */
export async function getFullPackDiscount() {
  const { rows } = await q(
    `SELECT COALESCE((SELECT setting_value::text FROM saas_global_settings
                       WHERE setting_key='FULL_PACK_DISCOUNT_PERCENT'),'0') AS pack,
            COALESCE((SELECT setting_value::text FROM saas_global_settings
                       WHERE setting_key='ANNUAL_DISCOUNT_PERCENT'),'15') AS annuel`);
  return { pack_pct: rows[0].pack, annual_pct: rows[0].annuel };
}

/** Modules souscrits par une IMF (prix et cycle). */
export async function listInstitutionModules(imfId) {
  const { rows } = await q(
    `SELECT s.module_key, p.module_name,
            p.monthly_subscription_price::text AS prix_mensuel,
            p.monthly_subscription_price::text AS monthly_price,
            s.is_active, s.activated_at, s.is_trial, s.trial_end_date, s.is_full_pack,
            s.billing_cycle, s.annual_signed_at, s.trial_used, s.trial_started_at,
            COALESCE(s.billing_cycle,'MENSUEL') = 'ANNUEL' AS est_annuel,
            (s.is_trial AND s.trial_end_date IS NOT NULL AND s.trial_end_date >= CURRENT_DATE)
              AS essai_en_cours,
            GREATEST(0, COALESCE(s.trial_end_date - CURRENT_DATE, 0)) AS jours_restants
       FROM institution_module_subscriptions s
       JOIN saas_modules_pricing p ON p.module_key = s.module_key
      WHERE s.institution_id = $1
      ORDER BY p.position`, [imfId]);
  return rows;
}

/** Statut de la licence unique. */
export async function getLicenseStatus(imfId) {
  const { rows } = await q(
    'SELECT * FROM institution_license_status WHERE institution_id=$1', [imfId]);
  const price = await getLicensePrice();
  const row = rows[0] || { license_paid: false, paid_at: null };
  const du = row.license_paid ? '0.00' : toSql(price);
  return {
    license_paid: !!row.license_paid,
    paid_at: row.paid_at || null,
    price_once: toSql(price),
    status_label: row.license_paid ? 'DÉJÀ PAYÉE (À VIE)' : 'À RÉGLER (PAIEMENT UNIQUE)',
    montant_du: du,
    montant_du_fcfa: formatFcfa(du)
  };
}

/* ------------------------------------------------------------------------- */
/*  CALCUL DU MOIS (miroir exact de evaluate_imf_month en SQL)                */
/* ------------------------------------------------------------------------- */
/**
 * @param {object} o
 * @param {Array}  o.modules    modules souscrits actifs
 * @param {Array}  o.catalogue  tous les modules proposés (pack complet)
 * @param {string} o.licenceDu  montant de licence dû (chaîne)
 * @param {string} o.mois       'YYYY-MM-DD' (n'importe quel jour du mois visé)
 * @param {string} o.remisePct  remise pack complet (%)
 * @param {string} o.remiseAnnuellePct remise annuelle (%, 15 par défaut)
 * @param {string} o.dateFacturation jour de la facture (essai en cours)
 */
export function computeMonth({
  modules = [], catalogue = [], licenceDu = '0.00', mois,
  remisePct = '0', remiseAnnuellePct = '15', dateFacturation = null
}) {
  const d = mois ? jour(mois) : jour(new Date().toISOString().slice(0, 10));
  const premier = debutMois(d);
  const fin = finMois(d);
  let joursDuMois = fin.getUTCDate();
  const jourFacture = dateFacturation ? jour(dateFacturation) : d;
  const jourFactureBorne = jourFacture > fin ? fin : (jourFacture < premier ? premier : jourFacture);

  const details = [];
  const montantsFactures = [];        // Big, addition exacte

  for (const m of modules) {
    const prix = toSql(m.prix_mensuel || m.monthly_price || '0');
    if (!m.is_active) {
      details.push({ module_key: m.module_key, module_name: m.module_name,
        statut: 'inactif', prix_mensuel_fcfa: prix, montant_fcfa: '0.00', montant: '0.00' });
      continue;
    }

    const finEssai = m.trial_end_date ? jour(m.trial_end_date) : null;

    // ---- ESSAI EN COURS à la date de facturation : 0 FCFA, reporté. ----
    if (m.is_trial && finEssai && finEssai >= jourFactureBorne) {
      const restants = Math.max(0, nbJours(jourFactureBorne, finEssai));
      details.push({
        module_key: m.module_key, module_name: m.module_name,
        statut: 'essai_gratuit', prix_mensuel_fcfa: prix,
        fin_essai: iso(finEssai), jours_essai_restants: restants,
        jours_factures: 0, jours_du_mois: joursDuMois,
        montant_fcfa: '0.00', montant: '0.00',
        explication: 'Essai en cours : 0 FCFA ce mois-ci. '
          + restants + ' jour(s) d\'essai reporté(s) ; la première facturation '
          + 'se fera au prorata le mois suivant.'
      });
      continue;
    }

    // ---- PREMIER JOUR FACTURABLE DU MOIS ----
    let debutFact = premier;
    if (m.activated_at) {
      // Activation en cours de mois : facturation à partir du jour exact,
      // jusqu'à la FIN DU MOIS (pas jusqu'à la date de facturation).
      const a = jour(m.activated_at) > premier ? jour(m.activated_at) : premier;
      if (a > debutFact) debutFact = a;
    }
    if (m.is_trial && finEssai) {
      const lendemain = jourSuivant(finEssai);
      if (lendemain > debutFact) debutFact = lendemain;   // report de l'essai
    }

    if (debutFact > fin) {
      details.push({ module_key: m.module_key, module_name: m.module_name,
        statut: 'essai_gratuit', prix_mensuel_fcfa: prix,
        fin_essai: finEssai ? iso(finEssai) : null,
        jours_factures: 0, jours_du_mois: joursDuMois,
        montant_fcfa: '0.00', montant: '0.00',
        explication: 'Essai gratuit couvrant tout le mois : 0 FCFA.' });
      continue;
    }

    // ---- DÉCOUPAGE MENSUEL / ANNUEL (bascule au jour près) ----
    const annuel = String(m.billing_cycle || CYCLE_MENSUEL).toUpperCase() === CYCLE_ANNUEL;
    const signature = m.annual_signed_at ? jour(m.annual_signed_at) : null;
    let joursPlein = 0;
    let joursReduit = nbJoursInclus(debutFact, fin);
    let statut = 'facture';

    if (annuel && signature && signature >= debutFact && signature <= fin) {
      // Signature CE mois-ci : avant = plein tarif, à partir = −15 %.
      joursPlein = nbJours(debutFact, signature);
      if (joursPlein < 0) joursPlein = 0;
      joursReduit = nbJoursInclus(signature, fin);
      statut = 'facture_cycle_mixte';
    } else if (joursReduit < joursDuMois || debutFact > premier) {
      statut = 'facture_prorata';
    }

    // Montants : arithmétique décimale, arrondi par composante (comme le SQL).
    const mtPlein = joursPlein > 0
      ? prorata(prix, joursPlein, joursDuMois) : dec(0);
    // La remise annuelle ne s'applique qu'aux jours réellement au cycle ANNUEL.
    const mtReduit = joursReduit > 0
      ? prorata(annuel && signature ? pct(prix, dec(100).minus(remiseAnnuellePct)) : prix,
                joursReduit, joursDuMois)
      : dec(0);
    const montant = r2(mtPlein.plus(mtReduit));
    const avant = prorata(prix, joursPlein + joursReduit, joursDuMois);
    montantsFactures.push(montant);

    details.push({
      module_key: m.module_key, module_name: m.module_name,
      statut, cycle: annuel ? CYCLE_ANNUEL : CYCLE_MENSUEL,
      date_signature_annuelle: signature ? iso(signature) : null,
      prix_mensuel_fcfa: prix,
      debut_facturation: iso(debutFact),
      jours_factures: joursPlein + joursReduit, jours_du_mois: joursDuMois,
      jours_plein_tarif: joursPlein, jours_remises: joursReduit,
      remise_annuelle_pct: annuel && joursReduit > 0 ? toSql(remiseAnnuellePct) : '0.00',
      montant_avant_remise_fcfa: toSql(avant),
      montant_fcfa: toSql(montant), montant: toSql(montant),
      ...(statut === 'facture_prorata'
        ? { explication: (joursPlein + joursReduit) + ' jours sur ' + joursDuMois + ' (au prorata)' } : {}),
      ...(statut === 'facture_cycle_mixte'
        ? { explication: joursPlein + ' jour(s) au tarif mensuel puis '
            + joursReduit + ' jour(s) au tarif annuel −' + toSql(remiseAnnuellePct) + ' %'
            + ' (à partir du ' + iso(signature) + ')' } : {})
    });
  }

  // ---- PACK COMPLET ----
  const proposes = catalogue.length
    ? catalogue.filter((c) => c.is_available !== false).map((c) => c.module_key)
    : modules.map((m) => m.module_key);
  const factures = details.filter((x) => Number(x.jours_factures) > 0).map((x) => x.module_key);
  const packComplet = proposes.length > 0
    && factures.length === proposes.length
    && proposes.every((k) => factures.includes(k));

  const brut = r2(sum(...montantsFactures));
  const remise = packComplet && cmp(remisePct, 0) > 0 ? pct(brut, remisePct) : dec(0);
  const net = r2(brut.minus(remise));
  const licence = r2(licenceDu);

  return {
    premiereDate: iso(premier), derniereDate: iso(fin), joursDuMois,
    date_facturation: iso(jourFactureBorne),
    pack_complet: packComplet,
    remise_pct: packComplet ? toSql(remisePct) : '0.00',
    total_licence_fcfa: toSql(licence),
    total_abonnements_brut_fcfa: toSql(brut),
    remise_pack_fcfa: toSql(remise),
    total_abonnements_net_fcfa: toSql(net),
    total_fcfa: toSql(r2(licence.plus(net))),
    // Alias de compatibilité (format court historique)
    licence_fcfa: toSql(licence), brut_fcfa: toSql(brut),
    remise_fcfa: toSql(remise), net_fcfa: toSql(net),
    modules: details
  };
}

/**
 * APERÇU : ce que produirait la facture, SANS RIEN ÉCRIRE.
 * Si un mois déjà facturé est demandé, on renvoie le calcul théorique mais
 * l'objet indique clairement que la facture existante est verrouillée.
 */
export async function previewMonthlyInvoice(imfId, pBillingDate) {
  const date = pBillingDate || new Date().toISOString().slice(0, 10);
  const [lic, mods, remises, catalogue] = await Promise.all([
    getLicenseStatus(imfId), listInstitutionModules(imfId),
    getFullPackDiscount(), listModulePricing()]);

  const calc = computeMonth({
    modules: mods, catalogue, licenceDu: lic.montant_du, mois: date,
    remisePct: remises.pack_pct, remiseAnnuellePct: remises.annual_pct,
    dateFacturation: date
  });

  const lignes = [{
    line_type: 'licence', label: 'Licence unique teebo (a vie)',
    statut_ligne: cmp(calc.total_licence_fcfa, 0) > 0 ? 'facture' : 'deja_payee',
    amount_fcfa: calc.total_licence_fcfa
  }];
  for (const m of calc.modules) {
    if (m.statut === 'inactif') continue;
    lignes.push({
      module_key: m.module_key, line_type: 'abonnement', label: m.module_name,
      statut_ligne: m.statut, jours_factures: m.jours_factures,
      jours_du_mois: m.jours_du_mois, cycle: m.cycle || null,
      amount_fcfa: m.montant_fcfa
    });
  }
  if (cmp(calc.remise_pack_fcfa, 0) > 0) {
    lignes.push({ line_type: 'remise', statut_ligne: 'remise_pack',
      label: 'Remise pack complet (' + calc.remise_pct + ' %)',
      amount_fcfa: '-' + calc.remise_pack_fcfa });
  }

  const dejaFacture = (await q(
    `SELECT invoice_number, is_locked FROM saas_invoices
      WHERE institution_id=$1 AND billing_period_start = date_trunc('month',$2::date)::date
        AND status <> 'CANCELLED' LIMIT 1`, [imfId, date])).rows[0] || null;

  return {
    billing_period: debutMois(jour(date)).toLocaleDateString('fr-FR',
      { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    billing_period_start: calc.premiereDate,
    billing_period_end: calc.derniereDate,
    date_facturation: calc.date_facturation,
    institution_id: imfId,
    one_time_license: { status: lic.status_label, amount_due_fcfa: lic.montant_du,
      amount_due: lic.montant_du_fcfa, paid_at: lic.paid_at },
    pack_complet: calc.pack_complet,
    remise_pack: { pourcentage: calc.remise_pct, montant_fcfa: calc.remise_pack_fcfa,
      appliquee: cmp(calc.remise_pack_fcfa, 0) > 0 },
    modules_billing_details: calc.modules,
    lignes,
    financials: {
      total_license_due_fcfa: calc.total_licence_fcfa,
      total_subscriptions_brut_fcfa: calc.total_abonnements_brut_fcfa,
      remise_pack_fcfa: calc.remise_pack_fcfa,
      total_subscriptions_active_fcfa: calc.total_abonnements_net_fcfa,
      total_due_fcfa: calc.total_fcfa,
      total_due: formatFcfa(calc.total_fcfa)
    },
    facture_existante: dejaFacture,
    facture_verrouillee: !!(dejaFacture && dejaFacture.is_locked),
    status: cmp(calc.total_fcfa, 0) > 0 ? 'UNPAID' : 'NOTHING_DUE',
    simulation: true,
    note: dejaFacture && dejaFacture.is_locked
      ? 'La facture ' + dejaFacture.invoice_number + ' de ce mois est déjà générée : '
        + 'elle est définitive et ne peut plus être modifiée.'
      : null
  };
}

/** Miroir SQL exact du même mois (pour contrôle et tests). */
export async function evaluateMonthSql(imfId, pBillingDate) {
  const date = pBillingDate || new Date().toISOString().slice(0, 10);
  const { rows } = await q(
    `SELECT line_type, module_key, label, statut_ligne, billing_cycle,
            days_billed, days_in_month, period_from, period_to,
            discount_pct::text AS discount_pct,
            amount_before::text AS amount_before,
            amount_fcfa::text AS amount_fcfa
       FROM evaluate_imf_month($1, $2::date) ORDER BY ordre`, [imfId, date]);
  const total = rows.reduce((acc, r) => acc.plus(dec(r.amount_fcfa)), dec(0));
  return { lignes: rows, total_fcfa: toSql(total) };
}

/**
 * GÉNÉRATION RÉELLE du mois : 100 % SQL (NUMERIC), puis verrouillage.
 * Rejouable : la facture déjà émise est renvoyée sans être retouchée.
 */
export async function generateMonthlyInvoice(imfId, pBillingDate) {
  const date = pBillingDate || new Date().toISOString().slice(0, 10);
  await q('SELECT generate_imf_monthly_invoice_v4($1, $2::date) AS total', [imfId, date]);
  const { rows } = await q(
    `SELECT * FROM saas_invoices
      WHERE institution_id=$1 AND billing_period_start = date_trunc('month',$2::date)::date
        AND status <> 'CANCELLED'
      ORDER BY generated_at DESC LIMIT 1`, [imfId, date]);
  if (!rows[0]) return null;
  const lignes = (await q(
    `SELECT *, amount_fcfa::text AS amount_fcfa_text FROM saas_invoice_lines
      WHERE invoice_id=$1 ORDER BY created_at, line_type DESC`, [rows[0].id])).rows;
  return { ...rows[0], lignes };
}

/* ------------------------------------------------------------------------- */
/*  Factures                                                                  */
/* ------------------------------------------------------------------------- */
export async function listInvoices(imfId, { limit = 24, statut = null } = {}) {
  const { rows } = await q(
    `SELECT i.id, i.institution_id, i.invoice_number, i.billing_period_start,
            i.billing_period_end, i.fixed_cost_total::text AS fixed_cost,
            i.variable_cost_total::text AS variable_cost,
            i.grand_total::text AS grand_total_fcfa,
            i.grand_total, i.status, i.generated_at, i.paid_at,
            i.is_locked, i.locked_at,
            im.name AS imf_name, im.code_imf
       FROM saas_invoices i
       LEFT JOIN imf im ON im.id = i.institution_id
      WHERE ($1::uuid IS NULL OR i.institution_id = $1)
        AND ($2::text IS NULL OR i.status = $2)
      ORDER BY i.billing_period_start DESC, i.generated_at DESC
      LIMIT $3`, [imfId || null, statut || null, Math.min(500, Number(limit) || 24)]);
  return rows;
}

/** Encaissement : la seule modification encore autorisée sur une facture. */
export async function markInvoicePaid(invoiceId) {
  const { rows } = await q(
    `UPDATE saas_invoices SET status='PAID', paid_at=now()
      WHERE id=$1 AND status='UNPAID' RETURNING *`, [invoiceId]);
  return rows[0] || null;
}

/** Annulation (définitive) d'une facture : sans effet sur les lignes. */
export async function cancelInvoice(invoiceId) {
  const { rows } = await q(
    `UPDATE saas_invoices SET status='CANCELLED'
      WHERE id=$1 AND status <> 'CANCELLED' RETURNING *`, [invoiceId]);
  return rows[0] || null;
}

/* ------------------------------------------------------------------------- */
/*  Souscriptions                                                             */
/* ------------------------------------------------------------------------- */
/**
 * Activation / désactivation d'un module.
 * Un essai déjà consommé est REFUSÉ par le trigger PostgreSQL (le module
 * repasse automatiquement en payant) ; on l'annonce dans le retour.
 */
export async function setInstitutionModule(imfId, moduleKey, p = {}, actorId = null) {
  const tarif = (await q(
    'SELECT module_key FROM saas_modules_pricing WHERE module_key=$1', [moduleKey])).rows[0];
  if (!tarif) {
    const e = new Error('Module inconnu : ' + moduleKey);
    e.status = 400; e.code = 'module_inconnu'; e.expose = true;
    throw e;
  }
  const isActive = p.is_active !== false;
  const isTrial = isActive && p.is_trial === true;
  const trialEnd = isTrial ? (p.trial_end_date || null) : null;
  if (isTrial && !trialEnd) {
    const e = new Error('Un essai gratuit doit avoir une date de fin.');
    e.status = 400; e.code = 'trial_end_required'; e.expose = true;
    throw e;
  }

  const { rows } = await q(
    `INSERT INTO institution_module_subscriptions
       (institution_id, module_key, is_active, is_trial, trial_end_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (institution_id, module_key) DO UPDATE SET
       is_active = EXCLUDED.is_active,
       is_trial = EXCLUDED.is_trial,
       trial_end_date = EXCLUDED.trial_end_date,
       activated_at = CASE WHEN institution_module_subscriptions.is_active = FALSE
                            THEN CURRENT_DATE ELSE institution_module_subscriptions.activated_at END,
       deactivated_at = CASE WHEN EXCLUDED.is_active THEN NULL ELSE CURRENT_DATE END,
       updated_at = now()
     RETURNING *`,
    [imfId, moduleKey, isActive, isTrial, trialEnd, actorId]);
  const ligne = rows[0];
  await refreshFullPackFlag(imfId);
  return {
    ...ligne,
    essai_refuse: isTrial && ligne.is_trial === false,
    message: isTrial && ligne.is_trial === false
      ? 'Ce module a déjà bénéficié de l\'essai gratuit : il est activé en PAYANT.'
      : null
  };
}

/** Souscrire TOUS les modules en une fois (pack complet −5 %). */
export async function setFullPack(imfId, p = {}, actorId = null) {
  const actif = p.is_active !== false;
  const isTrial = actif && p.is_trial === true;
  const trialEnd = isTrial ? (p.trial_end_date || null) : null;
  if (isTrial && !trialEnd) {
    const e = new Error('Un essai gratuit doit avoir une date de fin.');
    e.status = 400; e.code = 'trial_end_required'; e.expose = true;
    throw e;
  }
  const mods = (await q(
    'SELECT module_key FROM saas_modules_pricing WHERE is_available ORDER BY position')).rows;
  const essaisRefuses = [];
  for (const m of mods) {
    const out = await setInstitutionModule(imfId, m.module_key,
      { is_active: actif, is_trial: isTrial, trial_end_date: trialEnd }, actorId);
    if (out.essai_refuse) essaisRefuses.push(m.module_key);
  }
  const packComplet = await refreshFullPackFlag(imfId);
  await syncFeaturesFromSubscriptions(imfId);
  const remises = await getFullPackDiscount();
  return {
    modules: await listInstitutionModules(imfId),
    pack_complet: packComplet,
    remise_pct: actif && packComplet ? remises.pack_pct : '0.00',
    essais_refuses: essaisRefuses,
    message: essaisRefuses.length
      ? 'Essai gratuit refusé (déjà utilisé) pour : ' + essaisRefuses.join(', ')
        + '. Ces modules sont activés en PAYANT.'
      : null
  };
}

/**
 * BASCULE DE CYCLE (mensuel <-> annuel) au jour près.
 * La réduction annuelle ne court QU'À PARTIR de la date de signature
 * (aujourd'hui par défaut) : aucun effet rétroactif.
 */
export async function setBillingCycle(imfId, moduleKey, cycle, signedAt, actorId = null) {
  const c = String(cycle || '').toUpperCase();
  if (!['MENSUEL', 'ANNUEL'].includes(c)) {
    const e = new Error('Cycle attendu : MENSUEL ou ANNUEL.');
    e.status = 400; e.code = 'cycle_invalide'; e.expose = true;
    throw e;
  }
  const { rows } = await q(
    `UPDATE institution_module_subscriptions
        SET billing_cycle = $3,
            annual_signed_at = CASE WHEN $3 = 'ANNUEL'
                                    THEN COALESCE($4::date, CURRENT_DATE)
                                    ELSE NULL END,
            updated_at = now()
      WHERE institution_id = $1 AND module_key = $2
      RETURNING *`, [imfId, moduleKey, c, signedAt || null]);
  if (!rows[0]) {
    const e = new Error('Ce module n\'est pas souscrit par cette IMF.');
    e.status = 404; e.code = 'abonnement_introuvable'; e.expose = true;
    throw e;
  }
  const remises = await getFullPackDiscount();
  return {
    ...rows[0],
    remise_annuelle_pct: c === 'ANNUEL' ? remises.annual_pct : '0.00',
    message: c === 'ANNUEL'
      ? 'Forfait annuel à partir du ' + iso(jour(rows[0].annual_signed_at))
        + ' : la réduction de ' + remises.annual_pct
        + ' % s\'applique au prorata des jours restants du mois, sans effet rétroactif.'
      : 'Retour au forfait mensuel : plein tarif à partir d\'aujourd\'hui.'
  };
}

/** Recalcule le drapeau « pack complet » d'une IMF. */
export async function refreshFullPackFlag(imfId) {
  const { rows } = await q(
    `UPDATE institution_module_subscriptions s
        SET is_full_pack = (compte.total > 0 AND compte.actifs = compte.total),
            updated_at = now()
       FROM (SELECT
               (SELECT COUNT(*) FROM saas_modules_pricing WHERE is_available) AS total,
               (SELECT COUNT(*) FROM institution_module_subscriptions s2
                  JOIN saas_modules_pricing p2 ON p2.module_key = s2.module_key
                 WHERE s2.institution_id = $1 AND s2.is_active AND p2.is_available) AS actifs
             ) compte
      WHERE s.institution_id = $1
      RETURNING s.is_full_pack`, [imfId]);
  return !!(rows[0] && rows[0].is_full_pack);
}

/* ------------------------------------------------------------------------- */
/*  Tarifs (éditeur)                                                          */
/* ------------------------------------------------------------------------- */
export async function setModulePrice(moduleKey, price) {
  const { rows } = await q(
    `UPDATE saas_modules_pricing SET monthly_subscription_price = $2::numeric,
            updated_at = now()
      WHERE module_key = $1 RETURNING *`, [moduleKey, toSql(price)]);
  return rows[0] || null;
}

export async function setLicensePrice(price) {
  return setSetting('UNIQUE_LICENSE_PRICE', price);
}

export async function setFullPackDiscount(pct) {
  return setSetting('FULL_PACK_DISCOUNT_PERCENT', pct);
}

export async function setAnnualDiscount(pct) {
  return setSetting('ANNUAL_DISCOUNT_PERCENT', pct);
}

async function setSetting(key, value) {
  const { rows } = await q(
    `INSERT INTO saas_global_settings (setting_key, setting_value)
     VALUES ($1, $2::numeric)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value,
       updated_at = now() RETURNING *`, [key, toSql(value)]);
  return rows[0];
}

/** Répercute la souscription sur l'activation technique du module. */
export async function syncFeaturesFromSubscriptions(imfId) {
  await q(
    `UPDATE institution_features f
        SET is_enabled = s.is_active, updated_at = now()
       FROM institution_module_subscriptions s
      WHERE s.institution_id = $1 AND f.imf_id = s.institution_id
        AND f.feature_key = s.module_key`, [imfId]);
  return true;
}

export default {
  listModulePricing, getLicensePrice, getFullPackDiscount, listInstitutionModules,
  getLicenseStatus, computeMonth, previewMonthlyInvoice, evaluateMonthSql,
  generateMonthlyInvoice, listInvoices, markInvoicePaid, cancelInvoice,
  setInstitutionModule, setFullPack, setBillingCycle, refreshFullPackFlag,
  setModulePrice, setLicensePrice, setFullPackDiscount, setAnnualDiscount,
  syncFeaturesFromSubscriptions
};
