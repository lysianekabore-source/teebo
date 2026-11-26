// ===========================================================================
// teebo — VAGUE 82 : DEMANDES DE MODULES COTE IMF
// ---------------------------------------------------------------------------
//  POST /api/v1/tenant/demandes-modules   une IMF demande l'ouverture de modules
//  GET  /api/v1/tenant/demandes-modules   suivi de SES demandes
//  POST /api/v1/tenant/demandes-modules/:id/annuler
//
// REGLES :
//   - le tenant_id vient TOUJOURS du contrat de la session (jamais du corps
//     de la requete) : une IMF ne peut pas demander pour une autre ;
//   - une seule demande EN ATTENTE par IMF (mise a jour si elle existe) ;
//   - l'editeur recoit un e-mail et un badge dans la console.
// ===========================================================================
import express from 'express';
import {invoices,invoicePdf} from '../console_invoices_v82.js';
import { q,tx } from '../db.js';
import { authenticate, requireFreshPassword, requireRole } from '../auth.js';
import { notifyEmail, notifyWhatsApp, TEEBO_EMAIL, TEEBO_WHATSAPP } from '../notify.js';

const router = express.Router();
const ADMIN = ['admin_imf', 'direction'];

router.use('/tenant',authenticate,requireFreshPassword,(req,res,next)=>{if(!['admin_imf','direction'].includes(req.user.role))return res.status(403).json({error:'forbidden'});if(['GET','HEAD','OPTIONS'].includes(req.method))return next();if(!req.is('application/json'))return res.status(415).json({error:'json_required'});if(req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'cross_site_request'});next();});
function refus(res, code, message, status = 400) {
  return res.status(status).json({ error: code, code, message });
}

async function contratDe(req) {
  const imfId = req.user && req.user.imf_id;
  if (!imfId) return null;
  const t = (await q('SELECT * FROM tenants WHERE imf_id=$1', [imfId])).rows[0];
  return t ? { tenant: t, imfId } : null;
}

async function catalogueActif() {
  return (await q(
    `SELECT code_module AS code, nom, prix_mensuel_xof::text AS prix_mensuel, inclus_essai
       FROM catalogue_modules WHERE COALESCE(est_actif, TRUE) ORDER BY ordre, code_module`)).rows;
}

/* ------------------------------------------------------------------ */
router.post('/tenant/demandes-modules', async (req, res, next) => {
  try {
    const c = await contratDe(req);
    if (!c) return refus(res, 'contrat_absent',
      'Votre institution n’a pas encore de contrat actif. Contactez teebo.', 409);
    const b = req.body || {};
    const demande = Array.isArray(b.modules) ? b.modules : [];
    const cat = await catalogueActif();
    const dispo = new Set(cat.map((m) => m.code));
    const codes = Array.from(new Set(demande
      .map((m) => String(m && m.code ? m.code : m).toUpperCase().trim())
      .filter((m) => m)));
    if (!codes.length) return refus(res, 'modules_vides', 'Choisissez au moins un module.');
    if (codes.length > 8) return refus(res, 'trop_de_modules', 'Huit modules au maximum par demande.');
    const inconnus = codes.filter((m) => !dispo.has(m));
    if (inconnus.length) return refus(res, 'module_inconnu',
      'Module(s) indisponible(s) : ' + inconnus.join(', ') + '.');

    const row=await tx(async db=>{
      await db.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[c.tenant.id]);
      const old=(await db.query(`SELECT id FROM demandes_modules WHERE tenant_id=$1 AND statut='EN_ATTENTE'`,[c.tenant.id])).rows[0];
      if(old)return (await db.query(`UPDATE demandes_modules SET modules=$2::jsonb,motif=$3,contact_email=$4,urgence=TRUE,updated_at=now() WHERE id=$1 RETURNING *`,[old.id,JSON.stringify(codes),String(b.motif||'').slice(0,800)||null,req.user.email||null])).rows[0];
      const row=(await db.query(`INSERT INTO demandes_modules(tenant_id,imf_id,modules,motif,contact_email,urgence) VALUES($1,$2,$3::jsonb,$4,$5,TRUE) RETURNING *`,[c.tenant.id,c.imfId,JSON.stringify(codes),String(b.motif||'').slice(0,800)||null,req.user.email||null])).rows[0];
      await db.query(`INSERT INTO audit_log(imf_id,actor_id,action,entity,entity_id,payload) VALUES($1,$2,'demande.modules.creation','demandes_modules',$3,$4::jsonb)`,[c.imfId,req.user.id,row.id,JSON.stringify({modules:codes})]);
      return row;
    });
    // L'editeur est prevenu (e-mail + WhatsApp) : la demande ne dort pas.
    const noms = cat.filter((m) => codes.includes(m.code)).map((m) => m.nom);
    const texte = 'Nouvelle demande de modules\n'
      + 'IMF : ' + (c.tenant.nom_imf || '') + ' (' + (c.tenant.sigle || '') + ')\n'
      + 'Modules : ' + noms.join(', ') + '\n'
      + 'Motif : ' + (String(b.motif || '').slice(0, 400) || '—') + '\n'
      + 'A traiter dans la console teebo (onglet Demandes de modules).';
    const envoi = await Promise.all([
      notifyEmail(TEEBO_EMAIL, '[teebo] Demande de modules — ' + (c.tenant.nom_imf || ''), texte)
        .catch(() => ({ ok: false })),
      notifyWhatsApp(TEEBO_WHATSAPP, texte).catch(() => ({ ok: false }))
    ]);
    await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
             VALUES ($1,$2,'demande.modules.creation','demandes_modules',$3,$4::jsonb)`,
      [c.imfId, req.user.id, row.id, JSON.stringify({ modules: codes })]).catch(() => {});

    res.status(201).json({
      demande: { id: row.id, modules: codes, noms, statut: row.statut, cree_le: row.created_at },
      
      editeur_prevenu: envoi.some((e) => e && e.ok),
      message: 'Votre demande est enregistrée et visible par l’équipe teebo.'
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
router.get('/tenant/demandes-modules', async (req, res, next) => {
  try {
    const c = await contratDe(req);
    if (!c) return res.json({ demandes: [], contrat: null });
    const rows = (await q(
      `SELECT id::text, modules, motif, statut, created_at, decide_le, commentaire
         FROM demandes_modules WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 24`,
      [c.tenant.id])).rows;
    const cat = await catalogueActif();
    const noms = Object.fromEntries(cat.map((m) => [m.code, m.nom]));
    res.json({
      contrat: {
        statut: c.tenant.statut_compte,
        fin_essai: c.tenant.date_expiration_essai,
        periodicite: c.tenant.periodicite || 'MENSUEL'
      },
      demandes: rows.map((d) => ({
        ...d,
        modules: (Array.isArray(d.modules) ? d.modules : [])
          .map((m) => ({ code: m, nom: noms[m] || m }))
      }))
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
router.post('/tenant/demandes-modules/:id/annuler', async (req, res, next) => {
  try {
    const c = await contratDe(req);
    if (!c) return refus(res, 'contrat_absent', 'Contrat introuvable.', 409);
    const row = (await q(
      `UPDATE demandes_modules SET statut='ANNULEE', urgence=FALSE, updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND statut='EN_ATTENTE'
        RETURNING id`,
      [req.params.id, c.tenant.id])).rows[0];
    if (!row) return refus(res, 'demande_introuvable',
      'Demande introuvable ou déjà traitée.', 404);
    res.json({ ok: true, message: 'Demande annulée.' });
  } catch (e) { next(e); }
});

router.get('/tenant/catalogue',async(req,res,next)=>{try{const c=await contratDe(req);const modules=(await q(`SELECT c.code_module AS code,c.nom,c.prix_mensuel_xof::text AS prix_mensuel,c.prix_annuel_xof::text AS prix_annuel,c.est_actif AS disponible,c.inclus_essai,
 COALESCE(m.est_actif,FALSE) AND (m.expires_at IS NULL OR m.expires_at>=CURRENT_DATE) AS actif,COALESCE(m.en_essai,FALSE) AS essai,m.expires_at AS fin_essai
 FROM catalogue_modules c LEFT JOIN tenant_modules_actifs m ON m.code_module=c.code_module AND m.tenant_id=$1 ORDER BY c.ordre,c.code_module`,[c?.tenant.id||null])).rows;res.json({modules});}catch(e){next(e);}});
router.get('/tenant/factures',async(req,res,next)=>{try{if(!req.user.imf_id)return res.status(403).json({error:'forbidden'});const rows=await invoices(req.user.imf_id);res.json({factures:rows.map(f=>({id:f.id,numero:f.numero,debut:f.debut,fin:f.fin,total_fcfa:f.total_fcfa,reste_du_fcfa:f.reste_du_fcfa,statut:f.statut,statut_libelle:f.statut_libelle,source:f.source}))});}catch(e){next(e);}});
router.get('/tenant/factures/:source/:id.pdf',async(req,res,next)=>{try{if(!req.user.imf_id||!['tenant','imf'].includes(req.params.source)||!/^[-a-f0-9]{36}$/i.test(req.params.id))return res.status(404).json({error:'not_found'});await invoicePdf(res,req.params.id,req.params.source,req.user.imf_id);}catch(e){next(e);}});
export default router;
