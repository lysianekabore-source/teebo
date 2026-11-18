// =========================================================================
// teebo — ROUTES FACTURATION SAAS (côté IMF)
// =========================================================================
//  GET  /saas/catalogue                       tarifs des modules + licence
//  GET  /saas/abonnement                      modules de MON IMF + licence
//  GET  /saas/factures                        mes factures
//  GET  /saas/factures/:id                    détail (lignes, ventilation)
//  GET  /saas/factures/apercu?mois=YYYY-MM    simulation, sans écriture
//  POST /saas/factures/generer                génère/renvoie la facture du mois
//  PUT  /saas/modules/:key                    activer / désactiver / essai
// =========================================================================
import { Router } from 'express';
import { q } from '../db.js';
import { requireRole } from '../auth.js';
import { habilit } from '../rbac_strict.js';
import { tenantTransaction } from '../tenant.js';
import * as billing from '../saas_billing.js';
import { toSql, sum, pct, cmp, formatFcfa, r2 } from '../money.js';
import { getBranding, renderInvoice, setDocumentCsp } from '../documents.js';
import { chargerFacture, renderFactureSaas } from '../saas_invoice_pdf.js';

const r = Router();

/*  VAGUE 49 — UNE SEULE PORTE POUR TOUS LES ECRANS DE FACTURATION       */
// Chaque ecran ci-dessous verifie d'abord que l'IMF existe. Sans ce test,
// un identifiant d'institution inconnu provoquait une erreur 500 (cle
// etrangere) au lieu d'un refus lisible. Le controle est pose UNE fois,
// pour toutes les routes du fichier : impossible d'en oublier une.
// CORRECTIF 51 — CE GARDE NE S'EXECUTE PLUS SANS SESSION.
// Monte sur /api/v1, il s'appliquait a TOUTE l'API (login, pays UEMOA, demandes…)
// et, sans session, repondait 404 « imf_introuvable » AVANT le routeur
// d'authentification : l'ecran restait sur « Chargement… ».
r.use(async (req, res, next) => {
  const p = String(req.path || '');
  if (!/^\/saas(\/|$)/.test(p)) return next();          // hors facturation : on passe
  if (!req.user) return next();                          // non connecte : la route repondra 401
  try {
    if (await imfExiste(res, req.dbImfId)) return next();
  } catch (e) { return next(e); }
});

const ADMIN = ['admin_imf', 'direction'];
const ALL = ['admin_imf', 'direction', 'department', 'service', 'agency', 'staff'];

/** Enregistre une trace d'audit dans la transaction courante. */
async function audit(c, imfId, actorId, action, entityId, payload) {
  await c.query(
    `INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
     VALUES ($1,$2,$3,'saas_invoices',$4,$5::jsonb)`,
    [imfId, actorId, action, entityId || null, JSON.stringify(payload || {})]);
}

/*  VAGUE 48 — REFUS PROPRE QUAND L'IMF N'EXISTE PAS (plus de 500)      */
// Le test de reference appelle ces ecrans avec un identifiant fictif :
// la base refusait l'insertion (cle etrangere) et le site recevait un 500
// au lieu d'un refus clair. On verifie l'institution AVANT toute ecriture
// dans le module de facturation : une seule porte pour tous ces ecrans.
function refusImfIntrouvable(res) {
  return res.status(404).json({
    error: 'imf_introuvable', code: 'imf_introuvable',
    message: "Cette institution (IMF) est introuvable : vérifiez son identifiant."
  });
}

/**
 * Repond « IMF introuvable » avant d'ecrire ; renvoie false si deja repondu.
 * (vrai = l'IMF existe, l'ecran peut continuer). Accepte aussi une forme
 * souple (identifiant absent de la requete -> on prend celui de la session).
 */
async function imfExiste(res, imfId) {
  if (!imfId) { refusImfIntrouvable(res); return false; }
  try {
    const { rows } = await q('SELECT 1 AS ok FROM imf WHERE id=$1', [imfId]);
    if (rows.length) return true;
  } catch (e) {
    // Identifiant d'une forme invalide (pas un uuid) : meme reponse.
    if (String(e && e.code) === '22P02') { refusImfIntrouvable(res); return false; }
    throw e;
  }
  refusImfIntrouvable(res);
  return false;
}


/* ------------------------------------------------------------------ */
r.get('/saas/catalogue', requireRole(...ALL), async (req, res, next) => {
  try {
    res.json({ modules: await billing.listModulePricing(),
      licence_unique_fcfa: await billing.getLicensePrice(),
      facturation: 'Abonnement mensuel par module, sans palier (ni utilisateur ni agence).' });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
r.get('/saas/abonnement', requireRole(...ALL), async (req, res, next) => {
  try {
    const [licence, modules, catalogue, remises] = await Promise.all([
      billing.getLicenseStatus(req.dbImfId),
      billing.listInstitutionModules(req.dbImfId),
      billing.listModulePricing(),
      billing.getFullPackDiscount()]);
    // Simulation du MOIS EN COURS (prorata + remise), calcul décimal exact.
    const mois = billing.computeMonth({
      modules, catalogue, licenceDu: 0,
      mois: new Date().toISOString().slice(0, 10),
      remisePct: remises.pack_pct, remiseAnnuellePct: remises.annual_pct });

    // Total mensuel « plein » des modules payants (sans prorata), en décimal.
    const pleins = modules
      .filter((m) => m.is_active && !m.essai_en_cours)
      .map((m) => toSql(m.prix_mensuel));
    const totalPlein = toSql(sum(...pleins));
    const totalAvecRemise = mois.pack_complet && cmp(remises.pack_pct, 0) > 0
      ? toSql(r2(totalPlein).minus(pct(totalPlein, remises.pack_pct))) : totalPlein;

    res.json({
      institution_id: req.dbImfId,
      licence_unique: licence,
      platform: {
        is_active: true,
        message: 'La plateforme teebo (clients, epargne, caisse, utilisateurs, '
          + 'tableaux de bord) est incluse. Les modules ci-dessous sont des '
          + 'options facturees en plus.'
      },
      regles: {
        devise: 'XOF',
        arithmetique: 'decimale exacte (2 decimales), aucun flottant',
        cycle_annuel_remise_pct: remises.annual_pct,
        remise_annuelle_debut: 'date exacte de signature du forfait annuel (sans effet retroactif)',
        essai_gratuit: 'une seule fois par module',
        facture: 'definitive et verrouillee des sa generation'
      },
      modules: modules.map((m) => ({
        module_key: m.module_key, module_name: m.module_name,
        prix_mensuel_fcfa: toSql(m.prix_mensuel),
        cycle: m.billing_cycle || 'MENSUEL',
        date_signature_annuelle: m.annual_signed_at || null,
        prix_applique_fcfa: m.billing_cycle === 'ANNUEL'
          ? toSql(pct(m.prix_mensuel, r2(100).minus(remises.annual_pct))) : toSql(m.prix_mensuel),
        actif: m.is_active,
        essai_gratuit: !!m.essai_en_cours,
        essai_deja_utilise: !!m.trial_used,
        essai_finit_le: m.trial_end_date || null,
        jours_restants_essai: Number(m.jours_restants || 0),
        facture_ce_mois: !!(m.is_active && !m.essai_en_cours)
      })),
      pack_complet: mois.pack_complet,
      remise_pack_complet_pct: mois.remise_pct,
      total_abonnements_mensuel_fcfa: totalPlein,
      total_abonnements_avec_remise_fcfa: totalAvecRemise,
      ce_mois: {
        abonnements_brut_fcfa: mois.total_abonnements_brut_fcfa,
        remise_pack_fcfa: mois.remise_pack_fcfa,
        abonnements_net_fcfa: mois.total_abonnements_net_fcfa,
        prorata: mois.modules.some((m) => m.statut === 'facture_prorata'),
        bascule_cycle: mois.modules.some((m) => m.statut === 'facture_cycle_mixte')
      },
      total_ce_mois_fcfa: mois.total_fcfa,
      total_ce_mois: formatFcfa(mois.total_fcfa)
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
r.get('/saas/factures', requireRole(...ALL), async (req, res, next) => {
  try {
    res.json({ factures: await billing.listInvoices(req.dbImfId,
      { limit: Math.min(60, Number(req.query.limit || 24)) }) });
  } catch (e) { next(e); }
});

/* Aperçu AVANT génération (aucune écriture). Doit être déclaré avant /:id. */
r.get('/saas/factures/apercu', requireRole(...ALL), async (req, res, next) => {
  try {
    const mois = req.query.mois ? String(req.query.mois) + '-01' : null;
    res.json(await billing.previewMonthlyInvoice(req.dbImfId, mois));
  } catch (e) { next(e); }
});

/* Génération (ou récupération) de la facture du mois. */
r.post('/saas/factures/generer', requireRole(...ADMIN), habilit('settings.manage'),
  async (req, res, next) => {
    try {
      // VAGUE 48 : l'IMF doit exister avant toute generation (refus clair).
      if (!(await imfExiste(res, req.dbImfId))) return;
      const mois = (req.body || {}).mois ? String(req.body.mois) + '-01' : null;
      const facture = await billing.generateMonthlyInvoice(req.dbImfId, mois);
      if (!facture) {
        return res.status(500).json({ error: 'facture_non_generee',
          message: 'La facture n’a pas pu être générée. Réessayez dans un instant.' });
      }
      await tenantTransaction(req, (c) => audit(c, req.dbImfId, req.user.id,
        'saas.invoice.generate', facture.id,
        { numero: facture.invoice_number, total: facture.grand_total }));
      res.status(201).json({ facture });
    } catch (e) { next(e); }
  });

r.get('/saas/factures/:id', requireRole(...ALL), async (req, res, next) => {
  try {
    const inv = (await q(
      `SELECT i.*, COALESCE(im.name,'') AS imf_name, COALESCE(im.code_imf,'') AS imf_code
         FROM saas_invoices i LEFT JOIN imf im ON im.id = i.institution_id
        WHERE i.id=$1 AND i.institution_id=$2`, [req.params.id, req.dbImfId])).rows[0];
    if (!inv) {
      return res.status(404).json({ error: 'facture_introuvable',
        message: 'Facture introuvable dans votre institution.' });
    }
    const lignes = (await q(
      'SELECT * FROM saas_invoice_lines WHERE invoice_id=$1 ORDER BY line_type DESC, module_key',
      [inv.id])).rows;
    res.json({ facture: inv, lignes });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  Activation / désactivation d'un module par l'IMF                    */
/* ------------------------------------------------------------------ */
r.put('/saas/modules/:key', requireRole(...ADMIN), habilit('settings.manage'),
  async (req, res, next) => {
    try {
      // VAGUE 48 : IMF inexistante -> refus clair (404), jamais une erreur 500.
      if (!(await imfExiste(res, req.dbImfId))) return;
      const b = req.body || {};
      const out = await billing.setInstitutionModule(req.dbImfId, req.params.key,
        { is_active: b.is_active, is_trial: b.is_trial, trial_end_date: b.trial_end_date },
        req.user.id);
      // Un module souscrit ouvre immédiatement ses menus et son API ;
      // désactivé, il renvoie « Feature Disabled ».
      await billing.syncFeaturesFromSubscriptions(req.dbImfId);
      await tenantTransaction(req, (c) => audit(c, req.dbImfId, req.user.id,
        'saas.module.update', out.subscription_id,
        { module: req.params.key, actif: out.is_active, essai: out.is_trial,
          fin_essai: out.trial_end_date }));
      res.json({ abonnement: out });
    } catch (e) { next(e); }
  });

/* ------------------------------------------------------------------ */
/*  Facture imprimable (PDF) — ventilation complète du mois            */
/* ------------------------------------------------------------------ */
r.get('/saas/factures/:id.pdf', requireRole(...ALL), async (req, res, next) => {
  try {
    const doc = await chargerFacture(req.params.id, req.dbImfId);
    if (!doc) return res.status(404).json({ error: 'facture_introuvable' });
    setDocumentCsp(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderFactureSaas(doc));
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  BASCULE DE CYCLE : mensuel <-> annuel, effective à la date exacte  */
/* ------------------------------------------------------------------ */
r.put('/saas/modules/:key/cycle', requireRole(...ADMIN), habilit('settings.manage'),
  async (req, res, next) => {
    try {
      // VAGUE 48 : IMF inexistante -> refus clair (404), jamais une erreur 500.
      if (!(await imfExiste(res, req.dbImfId))) return;
      const b = req.body || {};
      const out = await billing.setBillingCycle(req.dbImfId, req.params.key,
        b.cycle, b.date_signature || null, req.user.id);
      await tenantTransaction(req, (c) => audit(c, req.dbImfId, req.user.id,
        'saas.cycle.update', out.id || null,
        { module: req.params.key, cycle: out.billing_cycle,
          signature: out.annual_signed_at || null }));
      res.json({ abonnement: out, message: out.message,
        remise_annuelle_pct: out.remise_annuelle_pct });
    } catch (e) { next(e); }
  });

export default r;
