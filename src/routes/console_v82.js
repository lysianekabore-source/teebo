// ===========================================================================
// teebo — VAGUE 82 : CONSOLE EDITEUR (tous les onglets du Super-Admin)
// ---------------------------------------------------------------------------
// Une seule garde (teebo_admin), un seul prefixe (/api/v1/teebo/v82).
// Les ecritures sensibles passent par console_engine_v82.js (transactionnel,
// montants decimaux, essai unique, licence, reactivation apres encaissement).
// Souverainete : metadonnees de contrat uniquement (aucun client, solde,
// dossier de credit ni ecriture comptable d'une IMF).
// ===========================================================================
import express from 'express';
import {invoices,totals,legacyPay,invoicePdf} from '../console_invoices_v82.js';
import PDFDocument from 'pdfkit';
import { q, tx } from '../db.js';
import { authenticate, requireFreshPassword, requireRole } from '../auth.js';
import { notifyEmail, notifyWhatsApp, TEEBO_EMAIL, TEEBO_WHATSAPP, mailtoLink, waLink } from '../notify.js';
import { buildProfilesMatrix } from '../permissions.js';
import { invalidate, fail, contract, refresh, activate, issue, pay, money, sql, date } from '../console_engine_v82.js';

const router = express.Router();
const LOGIN_URL = 'https://teebo-imf.netlify.app/login';
const LABELS = { ESSAI_GRATUIT: 'trial', ACTIF: 'active', SUSPENDU_IMPAYE: 'suspended', RESILIE: 'rejected', EN_ATTENTE: 'pending' };
const INVERSES = Object.fromEntries(Object.entries(LABELS).map(([a, b]) => [b, a]));
const STATUT_LABEL = { ESSAI_GRATUIT: 'Essai gratuit', ACTIF: 'Active', SUSPENDU_IMPAYE: 'Suspendue (impayé)', RESILIE: 'Résiliée', EN_ATTENTE: 'En attente' };

router.use(authenticate,requireFreshPassword,(req,res,next)=>{
 if(req.user.role!=='teebo_admin')return res.status(403).json({error:'forbidden'});next();
});
router.use((req,res,next)=>{if(['GET','HEAD','OPTIONS'].includes(req.method))return next();if(!req.is('application/json'))return res.status(415).json({error:'json_required'});if(req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'cross_site_request'});next();});
router.use((req,res,next)=>{const ids=req.path.match(/(?:institutions|factures|factures-historiques|demandes-modules)\/([^/]+)/);if(ids&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\.pdf)?$/i.test(ids[1]))return res.status(404).json({error:'not_found',message:'Élément introuvable.'});next();});

/* ------------------------------- outils ------------------------------- */
const num = (v) => { const n = Number(String(v == null ? 0 : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const fcfa = (v) => num(v);
const txt = (v, max = 400) => { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; };
const day = (v) => { const s = (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10)); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const iso = () => new Date().toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + Math.max(0, n) * 86400000).toISOString().slice(0, 10);
const fr = (v) => { const p = String(day(v) || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : '—'; };
const jours = (v) => { const s = day(v); return s ? Math.round((new Date(s + 'T00:00:00Z') - new Date(iso() + 'T00:00:00Z')) / 86400000) : null; };
const refus = (res, code, message, status = 400) => res.status(status).json({ error: code, code, message });

/** Une lecture secondaire qui echoue ne fait jamais tomber tout le dossier. */
async function safe(fn, fallback = { rows: [] }) {
  try { return await fn(); } catch (e) {
    throw e;
  }
}

/* ------------------------ badges et modules --------------------------- */
function badgeDe(r, ouverts) {
  const st = r.statut_compte || INVERSES[r.status] || r.status;
  if (r.status === 'rejected') return { code: 'RESILIE', label: 'Résiliée', ton: 'danger' };
  if (st === 'SUSPENDU_IMPAYE') return { code: 'SUSPENDU', label: 'Suspendue', ton: 'danger' };
  if (st === 'ESSAI_GRATUIT') {
    const j = jours(r.date_expiration_essai || r.trial_ends_at);
    return { code: 'ESSAI_GRATUIT', label: j != null && j >= 0 ? 'Essai (' + j + ' j)' : 'Essai échu', ton: j != null && j >= 0 ? 'warn' : 'danger' };
  }
  if (st === 'ACTIF') return { code: 'ACTIF', label: ouverts ? 'Active · ' + ouverts + ' module(s)' : 'Active · 0 module', ton: 'ok' };
  return { code: st || 'INCONNU', label: 'En attente', ton: 'muted' };
}

/** Catalogue + etat reel (LEFT JOIN : un module non souscrit reste visible). */
async function modulesDe(imfId) {
  const t = (await q('SELECT id FROM tenants WHERE imf_id=$1', [imfId])).rows[0];
  const cat = (await q(
    `SELECT code_module AS code, nom, description, prix_mensuel_xof::text AS prix_mensuel,
            prix_annuel_xof::text AS prix_annuel, module_historique, inclus_essai, est_actif
       FROM catalogue_modules ORDER BY ordre, code_module`)).rows;
  const acts = t ? (await safe(() => q(
    `SELECT code_module, est_actif, en_essai, expires_at, prix_applique_xof::text AS prix
       FROM tenant_modules_actifs WHERE tenant_id=$1`, [t.id]))).rows : [];
  const leg = (await safe(() => q(
    `SELECT module_key, is_active, is_trial, trial_end_date
       FROM institution_module_subscriptions WHERE institution_id=$1`, [imfId]))).rows;
  const byA = new Map(acts.map((a) => [a.code_module, a]));
  const byL = new Map(leg.map((l) => [l.module_key, l]));
  return cat.map((c) => {
    const a = byA.get(c.code) || null;
    const l = c.module_historique ? byL.get(c.module_historique) : null;
    const souscrit = a ? a.est_actif === true : Boolean(l && l.is_active);
    const essai = a ? Boolean(a.en_essai) : Boolean(l && l.is_trial);
    const fin = a && a.expires_at ? day(a.expires_at)
      : (l && l.trial_end_date ? day(l.trial_end_date) : null);
    const expire = Boolean(essai && fin && fin < iso());
    return {
      code: c.code, nom: c.nom, description: c.description,
      prix_mensuel_fcfa: fcfa(a && a.prix != null ? a.prix : c.prix_mensuel),
      prix_annuel_fcfa: fcfa(c.prix_annuel),
      actif: souscrit && !expire, souscrit, essai, fin_essai: fin, essai_expire: expire,
      jours_restants_essai: essai && fin ? Math.max(0, jours(fin) || 0) : 0,
      disponible: c.est_actif !== false, inclus_essai: !!c.inclus_essai,
      prix_affiche: souscrit && !expire ? fcfa(a && a.prix != null ? a.prix : c.prix_mensuel) : 0
    };
  });
}

/* --------------------------- tableau de bord -------------------------- */
router.get('/tableau-de-bord', async (_req, res, next) => {
  try {
    const k = (await safe(() => q(
      `SELECT (SELECT count(*) FROM imf WHERE status::text <> 'deleted')::int AS institutions,
              (SELECT count(*) FROM imf WHERE status::text='trial')::int AS essais,
              (SELECT count(*) FROM imf WHERE status::text='active')::int AS actives,
              (SELECT count(*) FROM imf WHERE status::text='suspended')::int AS suspendues,
              (SELECT count(*) FROM app_user WHERE role='admin_imf')::int AS admins,
              (SELECT count(*) FROM demandes_modules WHERE statut='EN_ATTENTE')::int AS demandes`), { rows: [{}] })).rows[0] || {};
    const argent = totals(await invoices());
    const mrr = (await safe(() => q(
      `SELECT COALESCE(SUM(COALESCE(m.prix_applique_xof,c.prix_mensuel_xof)),0)::text AS mrr
         FROM tenant_modules_actifs m JOIN catalogue_modules c ON c.code_module=m.code_module
        JOIN tenants t ON t.id=m.tenant_id WHERE m.est_actif AND NOT m.en_essai AND t.statut_compte='ACTIF' AND (m.expires_at IS NULL OR m.expires_at>=CURRENT_DATE)`), { rows: [{}] })).rows[0] || {};
    res.json({ compteurs: k, impaye_fcfa: argent.impaye_fcfa, encaisse_fcfa: argent.encaisse_fcfa, mrr_fcfa: fcfa(mrr.mrr) });
  } catch (e) { next(e); }
});

/* --------------------------- liste des IMF ---------------------------- */
router.get('/institutions', async (req, res, next) => {
  try {
    const s = txt(req.query.q, 80);
    const rows = (await q(
      `SELECT i.id, i.code_imf, i.name, i.type, i.country_code, i.city, i.email, i.phone_main,
              i.status::text AS status, i.trial_ends_at, i.created_at,
              t.id AS tenant_id, t.statut_compte, t.date_expiration_essai, t.periodicite,
              t.valeur_contrat_xof::text AS valeur_contrat,
              (SELECT count(*) FROM app_user u WHERE u.imf_id=i.id)::int AS nb_utilisateurs,
              (SELECT count(*) FROM app_user u WHERE u.imf_id=i.id AND u.is_active)::int AS nb_actifs,
              (SELECT u.code_user FROM app_user u WHERE u.imf_id=i.id AND u.role='admin_imf'
                ORDER BY u.created_at LIMIT 1) AS admin_code,
              (SELECT u.must_change_password FROM app_user u WHERE u.imf_id=i.id AND u.role='admin_imf'
                ORDER BY u.created_at LIMIT 1) AS admin_must_change,
              (SELECT count(*) FROM demandes_modules d WHERE d.imf_id=i.id AND d.statut='EN_ATTENTE')::int AS demandes_ouvertes
         FROM imf i LEFT JOIN tenants t ON t.imf_id=i.id
        WHERE i.status::text <> 'deleted'
          AND ($1::text IS NULL OR i.name ILIKE '%'||$1||'%' OR i.code_imf ILIKE '%'||$1||'%')
        ORDER BY i.name LIMIT 500`, [s])).rows;
    const ids = rows.map((r) => r.id);
    const mods = ids.length ? (await safe(() => q(
      `SELECT t.imf_id, m.est_actif, m.en_essai,m.expires_at FROM tenant_modules_actifs m
         JOIN tenants t ON t.id=m.tenant_id WHERE t.imf_id = ANY($1::uuid[])`, [ids]))).rows : [];
    const dus = await invoices();
    const byImf = {};
    for (const m of mods) (byImf[m.imf_id] = byImf[m.imf_id] || []).push(m);
    const duBy={};for(const f of dus){if(f.statut!=='IMPAYEE')continue;const d=duBy[f.imf_id]||(duBy[f.imf_id]={du:0,n:0});d.du+=f.reste_du_fcfa;d.n++;}
    res.json({ institutions: rows.map((r) => {
      const ms = byImf[r.id] || [];
      const ouverts = ms.filter((m) => m.est_actif&&(!m.expires_at||day(m.expires_at)>=iso())).length;
      return { ...r, badge: badgeDe(r, ouverts), modules_actifs: ouverts,
        modules_essai: ms.filter((m) => m.en_essai).length,
        impaye_fcfa: fcfa(duBy[r.id] ? duBy[r.id].du : 0),
        factures_impayees: duBy[r.id] ? duBy[r.id].n : 0,
        essai_jours: jours(r.date_expiration_essai || r.trial_ends_at) };
    }) });
  } catch (e) { next(e); }
});

/* ------------------------- dossier complet ---------------------------- */
router.get('/institutions/:id', async (req, res, next) => {
  try {
    const imf = (await q(
      `SELECT id, code_imf, name, type, country_code, city, email, phone_main, whatsapp,
              status::text AS status, trial_started_at, trial_ends_at, created_at
         FROM imf WHERE id=$1`, [req.params.id])).rows[0];
    if (!imf) return refus(res, 'imf_introuvable', 'Cette institution est introuvable.', 404);
    const tenant = (await safe(() => q('SELECT * FROM tenants WHERE imf_id=$1', [imf.id]))).rows[0] || null;
    const modules = await modulesDe(imf.id);
    const abonnement = tenant ? (await safe(() => q(
      `SELECT id::text, plan_code, montant_total_periodique_xof::text AS montant, periodicite,
              date_debut, date_fin, prochaine_echeance, statut, remise_pct::text AS remise_pct
         FROM abonnements_tenants WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [tenant.id]))).rows[0] || null : null;
    const licence = (await safe(() => q(
      `SELECT license_paid, paid_at, invoice_ref FROM institution_license_status WHERE institution_id=$1`,
      [imf.id]))).rows[0] || { license_paid: false };
    const admins = (await safe(() => q(
      `SELECT u.id, u.code_user, u.full_name, u.email, u.phone, u.role, u.is_active,
              u.must_change_password, u.created_at, COALESCE(f.enabled,FALSE) AS twofa_enabled
         FROM app_user u LEFT JOIN user_2fa f ON f.user_id=u.id
        WHERE u.imf_id=$1 ORDER BY (u.role='admin_imf') DESC, u.created_at`, [imf.id]))).rows;
    const factures=await invoices(imf.id);
    const paiements=(await q(`SELECT p.id,p.facture_id,p.montant_xof::text AS montant,p.mode,p.reference,p.encaisse_le,'tenant' AS source FROM saas_paiements p JOIN tenants t ON t.id=p.tenant_id WHERE t.imf_id=$1
    UNION ALL SELECT id,facture_id,montant_xof::text,mode,reference,encaisse_le,'imf' FROM saas_paiements_historiques WHERE institution_id=$1 ORDER BY encaisse_le DESC LIMIT 100`,[imf.id])).rows;
    const demandes = (await safe(() => q(
      `SELECT id::text, modules, motif, statut, created_at, decide_le, commentaire
         FROM demandes_modules WHERE imf_id=$1 ORDER BY created_at DESC LIMIT 20`, [imf.id]))).rows;
    const totalDu = factures.filter((f) => f.statut === 'IMPAYEE').reduce((s, f) => s + f.reste_du_fcfa, 0);
    const mrr = modules.filter((m) => m.actif && !m.essai).reduce((s, m) => s + m.prix_mensuel_fcfa, 0);
    res.json({
      imf, tenant, abonnement, licence, admins, users: admins, imf_admins: admins,
      modules, factures, paiements, demandes,
      resume: { statut_saas: (tenant && tenant.statut_compte) || INVERSES[imf.status] || imf.status,
        badge: badgeDe({ ...imf, statut_compte: tenant && tenant.statut_compte,date_expiration_essai:tenant?.date_expiration_essai }, modules.filter((m) => m.actif).length),
        modules_actifs: modules.filter((m) => m.actif).length,
        modules_essai: modules.filter((m) => m.essai).length,
        mrr_fcfa: mrr, total_du_fcfa: totalDu, nb_factures: factures.length },
      login_url: LOGIN_URL,
      perimetre: 'Métadonnées de contrat uniquement : aucun client, solde ni dossier de crédit.'
    });
  } catch (e) { next(e); }
});

function normaliser(f) {
  const st = String(f.statut || '').toUpperCase();
  const payee = ['PAID', 'PAYEE'].includes(st);
  const annulee = ['CANCELLED', 'ANNULEE'].includes(st);
  return { ...f, statut: payee ? 'PAYEE' : (annulee ? 'ANNULEE' : 'IMPAYEE'),
    statut_libelle: payee ? 'Payée' : (annulee ? 'Annulée' : 'Impayée'),
    total_fcfa: fcfa(f.total), total_affiche: fcfa(f.total).toLocaleString('fr-FR') + ' FCFA' };
}

/* ------------------------- statut / essai ----------------------------- */
router.post('/institutions/:id/statut', async (req, res, next) => {
  try {
    const b = req.body || {};
    const st = String(b.statut || '').toUpperCase();
    const ALLOWED=['ESSAI_GRATUIT','ACTIF','SUSPENDU_IMPAYE','RESILIE'];
    if (!ALLOWED.includes(st)) return refus(res, 'statut_invalide', 'Statut attendu : ESSAI_GRATUIT, ACTIF, SUSPENDU_IMPAYE ou RESILIE.');
    const imf = (await q('SELECT * FROM imf WHERE id=$1', [req.params.id])).rows[0];
    if (!imf) return refus(res, 'imf_introuvable', 'Cette institution est introuvable.', 404);
    const j = Number(b.essai_jours);
    const fin = st === 'ESSAI_GRATUIT' ? ((b.fin_essai?date(b.fin_essai):null) || addDays(Number.isFinite(j) && j > 0 ? Math.min(365, Math.round(j)) : 30)) : null;
    const out = await tx(async (c) => {
      const maj = (await c.query(
        `UPDATE imf SET status=$2::imf_status,
                trial_ends_at=CASE WHEN $3::date IS NULL THEN trial_ends_at ELSE $3::date END,
                updated_at=now() WHERE id=$1
          RETURNING id, name, code_imf, status::text AS status, trial_ends_at`,
        [imf.id, LABELS[st], fin])).rows[0];
      const t = await contract(c, imf.id, req.user.id);
      await c.query(`UPDATE tenants SET statut_compte=$2,
                        date_expiration_essai=COALESCE($3::date, date_expiration_essai),
                        date_suspension=CASE WHEN $2='SUSPENDU_IMPAYE' THEN CURRENT_DATE ELSE NULL END,
                        updated_at=now() WHERE id=$1`, [t.id, st, fin]);
      await c.query(`UPDATE abonnements_tenants SET statut=$2,updated_at=now() WHERE tenant_id=$1`,[t.id,st==='RESILIE'?'RESILIE':st==='SUSPENDU_IMPAYE'?'SUSPENDU':'ACTIF']);
      await c.query(`INSERT INTO audit_log(imf_id,actor_id,action,entity,entity_id,payload)
                      VALUES($1,$2,'saas.statut','imf',$1::uuid::text,$3::jsonb)`,
        [imf.id, req.user.id, JSON.stringify({ statut: st, fin_essai: fin })]);
      return { imf: maj, tenant: { id: t.id, statut_compte: st, date_expiration_essai: fin } };
    });
    await invalidate(imf.id);
    res.json({ ...out, message: 'Statut enregistré : ' + STATUT_LABEL[st] + (fin ? ' jusqu’au ' + fr(fin) : '') + '.' });
  } catch (e) { next(e); }
});

/* --------------------- interrupteur d'un module ----------------------- */
router.post('/institutions/:id/modules/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    const imf = (await q('SELECT * FROM imf WHERE id=$1', [req.params.id])).rows[0];
    if (!imf) return refus(res, 'imf_introuvable', 'Cette institution est introuvable.', 404);
    const out = await tx(async (c) => {
      const t = await contract(c, imf.id, req.user.id);
      const r = await activate(c, t, req.user.id, code, req.body || {});
      await refresh(c, t);
      return r;
    });
    await invalidate(imf.id);
    const modules = await modulesDe(imf.id);
    res.json({ module: modules.find((m) => m.code === code) || null, modules,
      message: out.nom + ' : ' + (out.essai ? 'essai gratuit ouvert' : 'mis à jour') + '.' });
  } catch (e) { next(e); }
});

/* --------------------------- abonnement ------------------------------- */
router.post('/institutions/:id/abonnement', async (req, res, next) => {
  try {
    const b = req.body || {};
    const p = String(b.periodicite || 'MENSUEL').toUpperCase();
    if (!['MENSUEL', 'TRIMESTRIEL', 'ANNUEL'].includes(p)) return refus(res, 'periodicite_invalide', 'Périodicité attendue : MENSUEL, TRIMESTRIEL ou ANNUEL.');
    const r = sql(money(b.remise_pct??0));if(Number(r)>100)throw fail('Remise comprise entre 0 et 100 % requise.');
    if (String(b.remise_pct || '').includes('.') && String(b.remise_pct).split('.')[1].length > 2) return refus(res, 'remise_invalide', 'Deux décimales au maximum.');
    const imf = (await q('SELECT * FROM imf WHERE id=$1', [req.params.id])).rows[0];
    if (!imf) return refus(res, 'imf_introuvable', 'Cette institution est introuvable.', 404);
    const out = await tx(async (c) => {
      const t = await contract(c, imf.id, req.user.id);
      const st = ['ACTIF', 'SUSPENDU', 'RESILIE'].includes(String(b.statut || '').toUpperCase()) ? String(b.statut).toUpperCase() : 'ACTIF';
      await c.query(`UPDATE tenants SET periodicite=$2, updated_at=now() WHERE id=$1`, [t.id, p]);
      const a = (await c.query(
        `INSERT INTO abonnements_tenants (tenant_id, plan_code, montant_total_periodique_xof, periodicite,
             date_debut, date_fin, prochaine_echeance, statut, remise_pct, cree_par)
         VALUES ($1,$2,0,$3,CURRENT_DATE,$4,$5,$6,$7,$8)
         RETURNING id::text, periodicite, statut, montant_total_periodique_xof::text AS montant,
                   remise_pct::text AS remise_pct, date_fin, prochaine_echeance`,
        [t.id, txt(b.plan_code, 40) || 'STANDARD', p, (b.date_fin?date(b.date_fin):null),
         (b.prochaine_echeance?date(b.prochaine_echeance):null) || addDays(p === 'ANNUEL' ? 365 : p === 'TRIMESTRIEL' ? 90 : 30),
         st, r, req.user.id])).rows[0];
      const total = await refresh(c, { ...t, periodicite: p });
      return { abonnement: { ...a, montant: total }, total };
    });
    await invalidate(imf.id);
    res.json({ ...out, message: 'Abonnement ' + p.toLowerCase() + ' enregistré · ' + fcfa(out.total).toLocaleString('fr-FR') + ' FCFA.' });
  } catch (e) { next(e); }
});

/* ------------------------ facture du mois ----------------------------- */
router.post('/institutions/:id/facture', async (req, res, next) => {
  try {
    const imf = (await q('SELECT * FROM imf WHERE id=$1', [req.params.id])).rows[0];
    if (!imf) return refus(res, 'imf_introuvable', 'Cette institution est introuvable.', 404);
    const out = await issue(imf.id, req.user.id, req.body || {});
    if (out.deja_emise) return res.json({ ...out, message: 'Une facture existe déjà pour cette période.' });
    res.status(201).json({ facture: normaliser({ ...out.facture,numero:out.facture.numero_facture,debut:day(out.facture.periode_debut),fin:day(out.facture.periode_fin),total:out.facture.montant_ttc_xof,source:'tenant',statut: 'EN_ATTENTE' }),
      message: 'Facture ' + out.facture.numero_facture + ' émise : ' + fcfa(out.facture.montant_ttc_xof).toLocaleString('fr-FR') + ' FCFA TTC.' });
  } catch (e) { next(e); }
});

/* --------------------------- encaissement ----------------------------- */
router.post('/factures/:id/paiement', async (req, res, next) => {
  try {
    const out = await pay(req.params.id, req.user.id, req.body || {});
    res.json({ ...out, message: 'Paiement enregistré' + (out.reprise ? ' — institution réactivée automatiquement.' : '.') });
  } catch (e) { next(e); }
});

/* ---------------------------- facture PDF ---------------------------- */
router.get('/factures/:id.pdf',async(req,res,next)=>{try{await invoicePdf(res,req.params.id,'tenant');}catch(e){next(e);}});
router.get('/factures-historiques/:id.pdf',async(req,res,next)=>{try{await invoicePdf(res,req.params.id,'imf');}catch(e){next(e);}});
router.post('/factures-historiques/:id/paiement',async(req,res,next)=>{try{res.json({...await legacyPay(req.params.id,req.user.id,req.body||{}),message:'Paiement enregistré.'});}catch(e){next(e);}});

/* ------------------------ reinitialisation --------------------------- */
router.post('/institutions/:id/admin/reinit', async (req, res, next) => {
  try {
    const b = req.body || {};
    const imf = (await q('SELECT * FROM imf WHERE id=$1', [req.params.id])).rows[0];
    if (!imf) return refus(res, 'imf_introuvable', 'Cette institution est introuvable.', 404);
    const cible = (await q(
      `SELECT * FROM app_user WHERE imf_id=$1 AND role='admin_imf'
          AND ($2::uuid IS NULL OR id=$2::uuid) ORDER BY created_at LIMIT 1`,
      [imf.id, b.admin_id || null])).rows[0];
    if (!cible) return refus(res, 'admin_absent', 'Aucun administrateur IMF pour cette institution.', 404);
    // L'editeur ne choisit JAMAIS le mot de passe : il force une
    // reinitialisation, l'admin IMF definit le sien (2FA conservee).
    const code=await tx(async c=>{const user=(await c.query("SELECT * FROM app_user WHERE id=$1 AND imf_id=$2 AND role='admin_imf' FOR UPDATE",[cible.id,imf.id])).rows[0];let n=user.code_user;if(b.nouveau_code===true)n=(await c.query('SELECT fn_gen_user_code($1) AS c',[imf.id])).rows[0].c;await c.query(`UPDATE app_user SET password_hash=NULL,password_set_at=NULL,must_change_password=TRUE,code_user=$2,updated_at=now() WHERE id=$1`,[user.id,n]);await c.query('UPDATE session SET revoked=TRUE WHERE user_id=$1',[user.id]);await c.query(`INSERT INTO audit_log(imf_id,actor_id,action,entity,entity_id,payload) VALUES($1,$2,'admin.reinit','app_user',$3,$4::jsonb)`,[imf.id,req.user.id,user.id,JSON.stringify({nouveau_code:b.nouveau_code===true})]);return n;});
    const texte = 'Bonjour ' + (cible.full_name || '') + ',\n\n'
      + 'Le mot de passe de votre compte administrateur a été réinitialisé.\n'
      + 'Code d’accès admin : ' + (code || '—') + '\n'
      + 'Utilisez ce code pour définir un nouveau mot de passe a la premiere connexion :\n'
      + LOGIN_URL + '\n\n' + 'Institution : ' + imf.name + ' (' + imf.code_imf + ')';
    const envoi = await notifyEmail(cible.email, '[teebo] Réinitialisation de votre accès administrateur', texte).catch(()=>({ok:false}));
    await q(`INSERT INTO audit_log(imf_id,actor_id,action,entity,entity_id,payload)
             VALUES($1,$2,'admin.reinit','app_user',$3,$4::jsonb)`,
      [imf.id, req.user.id, cible.id, JSON.stringify({ nouveau_code: b.nouveau_code === true })]).catch(() => {});
    res.json({ admin: { id: cible.id, email: cible.email, full_name: cible.full_name, code_user: code },
      envoye: !!(envoi && envoi.ok),
      send: { auto_sent: !!(envoi && envoi.ok),
        mailto_link: mailtoLink(cible.email, 'Réinitialisation de votre accès teebo', texte),
        wa_link: cible.phone ? waLink(cible.phone, texte) : null },
      message: 'Mot de passe réinitialisé : l’administrateur définit un nouveau mot de passe à la prochaine connexion.' });
  } catch (e) { next(e); }
});

/* ---------------------------- catalogue ------------------------------ */
router.get('/catalogue', async (_req, res, next) => {
  try {
    const modules = (await q(
      `SELECT c.code_module AS code, c.nom, c.description,
              c.prix_mensuel_xof::text AS prix_mensuel, c.prix_annuel_xof::text AS prix_annuel,
              c.module_historique, c.inclus_essai, c.ordre, c.est_actif,
              (SELECT count(*) FROM tenant_modules_actifs m WHERE m.code_module=c.code_module AND m.est_actif)::int AS nb_clients
         FROM catalogue_modules c ORDER BY c.ordre, c.code_module`)).rows;
    const licence = (await safe(() => q(
      `SELECT setting_value::text AS p FROM saas_global_settings WHERE setting_key='UNIQUE_LICENSE_PRICE'`), { rows: [{}] })).rows[0] || {};
    res.json({
      modules: modules.map((m) => ({ ...m,
        prix_mensuel_fcfa: fcfa(m.prix_mensuel), prix_annuel_fcfa: fcfa(m.prix_annuel),
        prix_mensuel_affiche: fcfa(m.prix_mensuel).toLocaleString('fr-FR') + ' FCFA',
        prix_annuel_affiche: fcfa(m.prix_annuel).toLocaleString('fr-FR') + ' FCFA',
        remise_annuelle_pct: fcfa(m.prix_mensuel) > 0
          ? Math.round(100 - (fcfa(m.prix_annuel) / (fcfa(m.prix_mensuel) * 12)) * 100) : 0 })),
      licence_unique_fcfa: fcfa(licence.p), devise: 'FCFA (XOF)',
      regle: 'Abonnement par module, jamais par utilisateur ni par agence.'
    });
  } catch (e) { next(e); }
});

router.put('/catalogue/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    const b = req.body || {};
    const sets = [];
    const vals = [code];
    let i = 2;
    for (const [field, col] of [['prix_mensuel_fcfa', 'prix_mensuel_xof'], ['prix_annuel_fcfa', 'prix_annuel_xof']]) {
      if (b[field] == null) continue;
      const v = sql(money(b[field]));
      if (v < 0) return refus(res, 'prix_invalide', 'Le prix ne peut pas être négatif.');
      if (String(b[field]).includes('.') && String(b[field]).split('.')[1].length > 2) return refus(res, 'prix_invalide', 'Deux décimales au maximum.');
      sets.push(col + '=$' + i++); vals.push(v);
    }
    if (b.est_actif != null) { if(typeof b.est_actif!=='boolean')throw fail('État invalide.');sets.push('est_actif=$' + i++); vals.push(b.est_actif === true); }
    if (!sets.length) return refus(res, 'rien_a_modifier', 'Indiquez un prix ou l’état de l’offre.');
    sets.push('updated_at=now()');
    const row=await tx(async c=>{
      const cat=(await c.query('SELECT * FROM catalogue_modules WHERE code_module=$1 FOR UPDATE',[code])).rows[0];if(!cat)throw fail('Module introuvable.',404);
      const row=(await c.query(`UPDATE catalogue_modules SET ${sets.join(', ')} WHERE code_module=$1 RETURNING code_module AS code,nom,prix_mensuel_xof::text AS prix_mensuel,prix_annuel_xof::text AS prix_annuel,est_actif`,vals)).rows[0];
      if(cat.module_historique)await c.query(`UPDATE saas_modules_pricing SET monthly_subscription_price=$2,is_available=$3 WHERE module_key=$1`,[cat.module_historique,row.prix_mensuel,row.est_actif]);
      await c.query(`INSERT INTO audit_log(imf_id,actor_id,action,entity,payload) VALUES(NULL,$1,'catalogue.maj','catalogue_modules',$2::jsonb)`,[req.user.id,JSON.stringify({code,...b})]);return row;
    });
    res.json({ module: { ...row, prix_mensuel_fcfa: fcfa(row.prix_mensuel), prix_annuel_fcfa: fcfa(row.prix_annuel) },
      message: 'Catalogue mis à jour. Les factures déjà émises ne changent pas.' });
  } catch (e) { next(e); }
});

/* --------------------- demandes de modules --------------------------- */
router.get('/demandes-modules', async (req, res, next) => {
  try {
    const st = txt(req.query.statut, 20);
    const rows = (await q(
      `SELECT d.id::text, d.modules, d.motif, d.statut, d.urgence, d.created_at, d.decide_le,
              d.commentaire, t.nom_imf, t.sigle, t.statut_compte, t.id::text AS tenant_id,
              i.id::text AS imf_id, i.code_imf, i.city
         FROM demandes_modules d JOIN tenants t ON t.id=d.tenant_id LEFT JOIN imf i ON i.id=t.imf_id
        WHERE ($1::text IS NULL OR d.statut=$1)
        ORDER BY (d.statut='EN_ATTENTE') DESC, d.created_at DESC LIMIT 200`, [st])).rows;
    const badge = (await q("SELECT count(*)::int AS n FROM demandes_modules WHERE statut='EN_ATTENTE'")).rows[0].n;
    res.json({ demandes: rows.map((d) => ({ ...d, modules: Array.isArray(d.modules) ? d.modules : [],
      badge: d.statut === 'EN_ATTENTE' ? { label: 'Nouvelle', ton: 'warn' }
        : d.statut === 'APPROUVEE' ? { label: 'Approuvée', ton: 'ok' } : { label: d.statut === 'REFUSEE' ? 'Refusée' : 'Annulée', ton: 'muted' } })),
      attente: badge });
  } catch (e) { next(e); }
});

router.post('/demandes-modules/:id/approuver', async (req, res, next) => {
  try {
    const b = req.body || {};
    const d = (await q('SELECT * FROM demandes_modules WHERE id=$1', [req.params.id])).rows[0];
    if (!d) return refus(res, 'demande_introuvable', 'Demande introuvable.', 404);
    if (d.statut !== 'EN_ATTENTE') return refus(res, 'deja_traitee', 'Cette demande a déjà été traitée.', 409);
    const codes = Array.from(new Set((Array.isArray(d.modules) ? d.modules : [])
      .map((m) => String(m && m.code ? m.code : m).toUpperCase()).filter(Boolean)));
    if (!codes.length) return refus(res, 'demande_vide', 'Cette demande ne contient aucun module.');
    const j = Number(b.essai_jours);
    const jj = Number.isFinite(j) && j >= 0 ? Math.min(365, Math.round(j)) : 30;
    const fin = jj > 0 ? addDays(jj) : null;
    const out = await tx(async (c) => {
      const t = (await c.query('SELECT * FROM tenants WHERE id=$1 FOR UPDATE', [d.tenant_id])).rows[0];
      if (!t) throw fail('Contrat SaaS introuvable.', 409);
      const fresh=(await c.query('SELECT * FROM demandes_modules WHERE id=$1 FOR UPDATE',[d.id])).rows[0];if(fresh.statut!=='EN_ATTENTE')throw fail('Cette demande a déjà été traitée.',409);
      const pris=[];const ignores=[];
      for(const code of [...new Set(fresh.modules)]){const cat=(await c.query('SELECT inclus_essai FROM catalogue_modules WHERE code_module=$1',[code])).rows[0];pris.push(await activate(c,t,req.user.id,code,{actif:true,essai:jj>0&&cat?.inclus_essai===true,fin_essai:fin,motif:'demande_approuvee'}));}
      await refresh(c, t);
      await c.query(`UPDATE demandes_modules SET statut='APPROUVEE', decide_par=$2, decide_le=now(),
              urgence=FALSE, commentaire=$3, updated_at=now() WHERE id=$1`,
        [d.id, req.user.id, txt(b.commentaire, 500)]);
      await c.query(`INSERT INTO audit_log(imf_id,actor_id,action,entity,entity_id,payload)
                      VALUES($1,$2,'demande.modules.approuvee','demandes_modules',$3,$4::jsonb)`,
        [t.imf_id, req.user.id, d.id, JSON.stringify({ modules: pris.map((p) => p.code), essai_jours: jj })]);
      const imf = (await c.query('SELECT * FROM imf WHERE id=$1', [t.imf_id])).rows[0];
      return { pris, ignores, imf };
    });
    await invalidate(out.imf.id);
    const texte = 'Bonjour,\n\nVotre demande d’ouverture de modules a ete approuvee.\n'
      + 'Modules ouverts : ' + out.pris.map((p) => p.nom + (p.essai ? ' (essai gratuit)' : '')).join(', ') + '.\n'
      + (out.pris.some(p=>p.essai) ? 'Fin de l’essai gratuit : ' + fr(fin) + '.\n' : '')
      + 'Connectez-vous ici : ' + LOGIN_URL + '\n\n' + out.imf.name;
    const dest = out.imf.email || null;
    const envoi = await notifyEmail(dest, '[teebo] Vos modules sont ouverts', texte).catch(()=>({ok:false}));
    res.json({ demande_id: d.id, modules: out.pris, ignores: out.ignores, fin_essai: fin,
      envoye: !!(envoi && envoi.ok),
      send: { auto_sent: !!(envoi && envoi.ok), mailto_link: dest ? mailtoLink(dest, 'Vos modules teebo sont ouverts', texte) : null },
      message: out.pris.length + ' module(s) activé(s)' + (out.ignores.length ? ' · ' + out.ignores.length + ' ignoré(s)' : '') + '.' });
  } catch (e) { next(e); }
});

router.post('/demandes-modules/:id/refuser', async (req, res, next) => {
  try {
    const d = (await q('SELECT * FROM demandes_modules WHERE id=$1', [req.params.id])).rows[0];
    if (!d) return refus(res, 'demande_introuvable', 'Demande introuvable.', 404);
    if (d.statut !== 'EN_ATTENTE') return refus(res, 'deja_traitee', 'Cette demande a déjà été traitée.', 409);
    await tx(async c=>{const f=(await c.query(`UPDATE demandes_modules SET statut='REFUSEE',decide_par=$2,decide_le=now(),urgence=FALSE,commentaire=$3,updated_at=now() WHERE id=$1 AND statut='EN_ATTENTE' RETURNING imf_id`,[d.id,req.user.id,txt(req.body?.motif,500)])).rows[0];if(!f)throw fail('Cette demande a déjà été traitée.',409);await c.query(`INSERT INTO audit_log(imf_id,actor_id,action,entity,entity_id,payload) VALUES($1,$2,'demande.modules.refusee','demandes_modules',$3,$4::jsonb)`,[f.imf_id,req.user.id,d.id,JSON.stringify({motif:txt(req.body?.motif,500)})]);});
    res.json({ ok: true, message: 'Demande refusée.' });
  } catch (e) { next(e); }
});

/* -------------------------- habilitations ---------------------------- */
router.get('/matrice', async (_req, res, next) => {
  try {
    const base = buildProfilesMatrix();
    const eff = (await safe(() => q(
      `SELECT role, count(*)::int AS n FROM app_user WHERE role <> 'teebo_admin' GROUP BY role`))).rows;
    const by = Object.fromEntries(eff.map((e) => [e.role, e.n]));
    res.json({ ...base, roles: base.roles.map((r) => ({ ...r, effectif: by[r.key] || 0 })),
      politique_mot_de_passe: { longueur_min: 10, complexite: 'minuscule + majuscule + chiffre',
        verrouillage_echecs: 5, deux_facteurs: 'obligatoire pour teebo_admin et admin_imf',
        regle_editeur: 'L’éditeur ne choisit jamais le mot de passe d’une IMF : il force une réinitialisation.' } });
  } catch (e) { next(e); }
});

router.use((e,req,res,next)=>{if(['42P01','42703','42883'].includes(e.code))return res.status(503).json({error:'service_indisponible',message:'Cette rubrique est temporairement indisponible. Réessayez dans quelques instants.'});next(e);});
/* ---------------------- toutes les factures -------------------------- */
router.get('/factures',async(req,res,next)=>{try{const rows=await invoices();const st=txt(req.query.statut,20);res.json({factures:st?rows.filter(f=>f.statut===st):rows,totaux:totals(rows)});}catch(e){next(e);}});
router.use((e,req,res,next)=>{if(['42P01','42703','42883'].includes(e.code))return res.status(503).json({error:'service_indisponible',message:'Cette rubrique est temporairement indisponible.'});next(e);});

export default router;
