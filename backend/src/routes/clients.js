import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { requireRole } from '../auth.js';
import { getBranding, renderStatement, renderClientFiche, setDocumentCsp } from '../documents.js';
import { findClientDuplicate, logDuplicate, normalizeClientFields, clientHasActiveAccount } from '../collecte_extra.js';
import { CLIENT_TYPOLOGY, validateTypology } from '../client_typology.js';
import { PARTICULIER_DOCS, validateParticulierDocs, DOC_FIELDS,
  CONFORMITY_FIELDS, buildConformityChecks } from '../client_documents.js';

const r = Router();

/**
 * Méta-données nécessaires à l'écran de création d'un client :
 *  - type d'IMF (SA / SCOOP) : une SCOOP distingue CLIENT MEMBRE / CLIENT USAGER
 *    selon la souscription d'au moins une part sociale ;
 *  - valeur nominale d'une part sociale (paramètre IMF) ;
 *  - arbre de typologie (Particulier / Groupe / Entreprise + cascade).
 */
r.get('/client-meta', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const imf = (await q('SELECT type FROM imf WHERE id=$1', [req.user.imf_id])).rows[0];
    const ds = (await q('SELECT part_sociale_nominal_cents, id_doc_validity_months FROM imf_document_settings WHERE imf_id=$1',
      [req.user.imf_id])).rows[0];
    const imfType = imf ? imf.type : 'SA';
    res.json({
      imf_type: imfType,
      is_scoop: imfType === 'SCOOP',
      part_sociale_nominal_cents: ds && ds.part_sociale_nominal_cents != null ? Number(ds.part_sociale_nominal_cents) : null,
      // Durée de validité (en mois) par type de pièce — permet au front de calculer
      // et d'afficher immédiatement la date d'expiration.
      id_doc_validity_months: ds && ds.id_doc_validity_months ? ds.id_doc_validity_months : {},
      typology: CLIENT_TYPOLOGY,
      particulier_docs: PARTICULIER_DOCS,
    });
  } catch (e) { next(e); }
});

/**
 * ÉTAPE 2 DU PARCOURS — Ouverture du compte bancaire d'un client existant.
 * Un client ne peut avoir qu'UN seul compte actif (anti-doublon strict).
 */
r.post('/clients/:id/open-account', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const cl = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_not_found' });
    // VERROU DE CONFORMITÉ (particulier) : le compte ne peut être ouvert que
    // lorsque les pièces scannées ont été confrontées aux informations saisies
    // et jugées conformes (source de vérité côté serveur).
    if (cl.client_category === 'particulier' && cl.conformity_status !== 'conforme') {
      const nc = (await q(
        `SELECT field_label FROM client_conformity_check
           WHERE client_id=$1 AND is_conform=false ORDER BY id`, [cl.id])).rows.map((x) => x.field_label);
      return res.status(409).json({ error: 'conformite_requise', conformity_status: cl.conformity_status,
        non_conform: nc,
        message: cl.conformity_status === 'non_conforme'
          ? ('Des informations ne sont pas conformes au document scanné et doivent être corrigées avant l’ouverture du compte : '
             + (nc.join(', ') || '—') + '.')
          : 'Confrontez d’abord les pièces scannées aux informations saisies (étape de conformité) avant d’ouvrir le compte.' });
    }
    const existing = await clientHasActiveAccount(cl.id);
    if (existing) return res.status(409).json({ error: 'account_exists',
      message: 'Ce client possède déjà un compte actif (' + existing.code_account + ').',
      account: existing });
    const b = req.body || {};
    const acc = await tx(async (c) => {
      const acode = (await c.query('SELECT fn_gen_account_code($1) AS code', [req.user.imf_id])).rows[0].code;
      return (await c.query(
        `INSERT INTO account(imf_id,client_id,code_account,currency,journey_step)
         VALUES ($1,$2,$3,$4,'compte_ouvert') RETURNING *`,
        [req.user.imf_id, cl.id, acode, b.currency || 'XOF'])).rows[0];
    });
    res.status(201).json({ ok: true, account: acc,
      message: 'Compte ouvert (' + acc.code_account + '). Étape suivante : enregistrer le premier dépôt.' });
  } catch (e) { next(e); }
});

/** Liste des clients de l'IMF. */
r.get('/clients', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res) => {
  const { rows } = await q(
    `SELECT c.*, a.code_account, a.balance_cents, a.currency, a.journey_step,
            cp.login_mode, cp.statement_format, cp.is_active AS portal_active
       FROM client c
       LEFT JOIN account a ON a.client_id = c.id AND a.status='active'
       LEFT JOIN client_portal cp ON cp.client_id = c.id
      WHERE c.imf_id=$1 ORDER BY c.created_at DESC LIMIT 200`, [req.user.imf_id]);
  res.json({ clients: rows });
});

/**
 * Création d'un espace client en ligne (relevé consultable).
 * L'IMF choisit le mode de connexion (mot de passe / SMS / PIN) et le format
 * de relevé (PDF / CSV / les deux). Sans ces choix, défauts : mot_de_passe + pdf.
 */
r.post('/clients', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res) => {
  const b = req.body || {};
  if (!b.full_name) return res.status(400).json({ error: 'Nom complet du client requis' });
  const loginMode = ['mot_de_passe', 'sms_otp', 'pin'].includes(b.login_mode) ? b.login_mode : 'mot_de_passe';
  const fmt = ['pdf', 'csv', 'les_deux'].includes(b.statement_format) ? b.statement_format : 'pdf';
  const pwd = b.password || ('Tb' + crypto.randomInt(100000, 999999));
  const pwdHash = await bcrypt.hash(pwd, 10);

  // --- CONTRÔLE ANTI-DOUBLONS STRICT --------------------------------
  // Refus par défaut si un client identique existe déjà (n° pièce OU nom+tél.).
  // L'administrateur peut forcer la création en cochant explicitement
  // « doublon confirmé » — la décision est journalisée.
  const dup = await findClientDuplicate(req.user.imf_id, b);
  if (dup.duplicate && !b.force_duplicate) {
    await logDuplicate({ imfId: req.user.imf_id, entity: 'client',
      matchedId: dup.matches[0].id, reason: dup.matches[0].reason, payload: b, actorId: req.user.id });
    return res.status(409).json({ error: 'duplicate_client',
      message: 'Un client identique existe déjà (' + dup.matches[0].full_name + ' · ' + dup.matches[0].code_client + '). Création bloquée.',
      matches: dup.matches });
  }

  const nf = normalizeClientFields(b);

  // --- TYPOLOGIE (cascade Particulier / Groupe / Entreprise) --------------
  // Validée contre l'arbre : impossible d'enregistrer une combinaison invalide.
  const typo = validateTypology(b);
  if (!typo.ok) {
    return res.status(422).json({ error: typo.error, field: typo.field,
      message: 'La typologie du client est incomplète ou invalide : veuillez compléter le champ « '
        + (typo.field || '') + ' ».' });
  }
  const tv = typo.values;

  // --- QUALITÉ DE MEMBRE (SCOOP) : membre si ≥ 1 part sociale, sinon usager.
  //     Une IMF SA n'a pas de part sociale → simples « clients » (NULL).
  const imfRow = (await q('SELECT type FROM imf WHERE id=$1', [req.user.imf_id])).rows[0];
  const isScoop = imfRow && imfRow.type === 'SCOOP';
  let membershipType = null, sharesCount = 0, sharesPaidCents = 0;
  if (isScoop) {
    const dsRow = (await q('SELECT part_sociale_nominal_cents FROM imf_document_settings WHERE imf_id=$1',
      [req.user.imf_id])).rows[0];
    const nominal = dsRow && dsRow.part_sociale_nominal_cents != null ? Number(dsRow.part_sociale_nominal_cents) : null;
    const askMember = b.membership_type === 'membre';
    sharesCount = Math.max(0, Math.trunc(Number(b.shares_count) || 0));
    if (askMember) {
      if (!nominal || nominal <= 0) {
        return res.status(422).json({ error: 'part_sociale_non_parametree',
          message: 'La valeur nominale de la part sociale n\u2019est pas fixée dans les paramètres de l\u2019IMF. '
            + 'Renseignez-la avant d\u2019enregistrer un client membre.' });
      }
      if (sharesCount < 1) sharesCount = 1;
      membershipType = 'membre';
      sharesPaidCents = sharesCount * nominal;
    } else {
      membershipType = 'usager';
      sharesCount = 0; sharesPaidCents = 0;
    }
  }

  // --- PIÈCES REQUISES (PARTICULIER) ---------------------------------------
  // Un dossier de particulier impose une liste de pièces (identité, localisation,
  // revenu). La date d'expiration de la pièce est recalculée côté serveur à
  // partir de la durée de validité paramétrée par l'IMF (source faisant foi).
  const dv = {};
  for (const f of DOC_FIELDS) dv[f] = null;
  dv.id_doc_received = false;
  if (tv.client_category === 'particulier') {
    const dsDoc = (await q('SELECT id_doc_validity_months FROM imf_document_settings WHERE imf_id=$1',
      [req.user.imf_id])).rows[0];
    const validity = dsDoc && dsDoc.id_doc_validity_months ? dsDoc.id_doc_validity_months : {};
    const docs = validateParticulierDocs(b, { profession: tv.profession, validityMonths: validity });
    if (!docs.ok) return res.status(422).json({ error: docs.error, field: docs.field,
      message: docs.message || 'Pièces requises incomplètes.' });
    Object.assign(dv, docs.values);
  }

  const out = await tx(async (c) => {
    const code = (await c.query('SELECT fn_gen_client_code($1) AS code', [req.user.imf_id])).rows[0].code;
    const cl = (await c.query(
      `INSERT INTO client(imf_id,code_client,full_name,birth_date,phone,id_number,address,
                          name_norm,phone_norm,id_number_norm,collectrice_user_id,created_by_user_id,
                          membership_type,shares_count,shares_paid_cents,
                          client_category,gender,profession,profession_detail,
                          group_type,enterprise_segment,legal_form,
                          first_name,last_name,birth_place,
                          id_doc_type,id_doc_received,id_doc_number,id_doc_issue_date,id_doc_expiry_date,
                          birth_cert_status,home_location_desc,home_proof_status,home_proof_type,
                          activity_location_desc,activity_proof_status,activity_proof_type,
                          activity_description,school_name,income_proof_status,income_proof_type,
                          beneficiary_last_name,beneficiary_first_name,beneficiary_relation,salary_domiciliation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
               $23,$24,$25,$26,$27,$28,$29,$30,
               $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,
               $42,$43,$44,$45) RETURNING *`,
      [req.user.imf_id, code, nf.full_name, b.birth_date || null, nf.phone,
       nf.id_number, b.address || null, nf.name_norm, nf.phone_norm, nf.id_number_norm,
       b.collectrice_user_id || null, req.user.id,
       membershipType, sharesCount, sharesPaidCents,
       tv.client_category, tv.gender, tv.profession, tv.profession_detail,
       tv.group_type, tv.enterprise_segment, tv.legal_form,
       dv.first_name, dv.last_name, dv.birth_place,
       dv.id_doc_type, dv.id_doc_received, dv.id_doc_number, dv.id_doc_issue_date, dv.id_doc_expiry_date,
       dv.birth_cert_status, dv.home_location_desc, dv.home_proof_status, dv.home_proof_type,
       dv.activity_location_desc, dv.activity_proof_status, dv.activity_proof_type,
       dv.activity_description, dv.school_name, dv.income_proof_status, dv.income_proof_type,
       dv.beneficiary_last_name, dv.beneficiary_first_name, dv.beneficiary_relation, dv.salary_domiciliation])).rows[0];
    const acode = (await c.query('SELECT fn_gen_account_code($1) AS code', [req.user.imf_id])).rows[0].code;
    const acc = (await c.query(
      `INSERT INTO account(imf_id,client_id,code_account,currency,journey_step) VALUES ($1,$2,$3,$4,'compte_ouvert') RETURNING *`,
      [req.user.imf_id, cl.id, acode, b.currency || 'XOF'])).rows[0];
    const portal = (await c.query(
      `INSERT INTO client_portal(imf_id,client_id,login_mode,password_hash,statement_format,created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING login_mode, statement_format, is_active, must_change_password`,
      [req.user.imf_id, cl.id, loginMode, pwdHash, fmt, req.user.id])).rows[0];
    return { client: cl, account: acc, portal };
  });
  const memberNote = out.client.membership_type === 'membre'
    ? ' Client MEMBRE — ' + out.client.shares_count + ' part(s) sociale(s) souscrite(s).'
    : (out.client.membership_type === 'usager' ? ' Client USAGER (aucune part sociale).' : '');
  res.status(201).json({ ...out, credentials: { code_client: out.client.code_client,
    code_account: out.account.code_account, temporary_password: pwd },
    note: 'Client créé (' + out.client.code_client + ').' + memberNote });
});

/** Relevé de compte du client (format PDF renvoyé en HTML imprimable, ou CSV). */
r.get('/clients/:id/statement', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const fmt = (req.query.format || 'pdf').toLowerCase();
    const cl = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'Client introuvable' });
    const acc = (await q('SELECT * FROM account WHERE client_id=$1', [cl.id])).rows[0];
    const ops = (await q(
      `SELECT o.created_at, o.kind, o.amount_cents, o.status, o.direction,
              o.reference, o.receipt_id, r.code_receipt
         FROM operation o LEFT JOIN receipt r ON r.id = o.receipt_id
        WHERE o.account_id=$1 ORDER BY o.created_at DESC LIMIT 200`,
      [acc ? acc.id : null])).rows
      .map((o) => ({ ...o,
        label: o.kind === 'depot' ? 'Dépôt' : (o.kind === 'retrait_regul' ? 'Retrait (régularisation)' : o.kind),
        reference: o.reference || o.code_receipt || null }));

    if (fmt === 'csv') {
      const lines = ['date;operation;reference;montant_xof;statut'];
      for (const o of ops) lines.push([o.created_at.toISOString(), o.label, o.reference || '',
        (o.amount_cents / 100).toFixed(2), o.status].join(';'));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="releve_${cl.code_client}.csv"`);
      return res.send('\ufeff' + lines.join('\n'));
    }

    // PDF : HTML imprimable avec l'identité visuelle de l'IMF (logo + mentions légales).
    const header = await getBranding(req.user.imf_id);
    const html = renderStatement({
      header, client: cl, account: acc || null, operations: ops,
      generatedAt: new Date(), generatedBy: req.user.full_name
    });
    setDocumentCsp(res);
    res.type('html').send(html);
  } catch (e) { next(e); }
});

/**
 * Historique des DERNIÈRES OPÉRATIONS d’un client (par défaut les 5 dernières).
 * Sert à la fois au terrain (la collectrice montre au client la trace du dépôt)
 * et à l’espace client. Les reçus récents sont joints pour référence.
 */
r.get('/clients/:id/operations', requireRole('admin_imf','direction','department','service','agency','staff','caissier'), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 5), 1), 50);
  const cl = (await q('SELECT id, full_name, code_client, phone FROM client WHERE id=$1 AND imf_id=$2',
    [req.params.id, req.user.imf_id])).rows[0];
  if (!cl) return res.status(404).json({ error: 'Client introuvable' });
  const acc = (await q('SELECT id, code_account, balance_cents, currency FROM account WHERE client_id=$1', [cl.id])).rows[0];
  const ops = (await q(
    `SELECT o.id, o.created_at, o.kind, o.amount_cents, o.status, o.reference, o.note,
            o.receipt_id, r.code_receipt
       FROM operation o LEFT JOIN receipt r ON r.id = o.receipt_id
      WHERE o.account_id = $1
      ORDER BY o.created_at DESC LIMIT $2`,
    [acc ? acc.id : null, limit])).rows;
  res.json({
    client: { id: cl.id, full_name: cl.full_name, code_client: cl.code_client },
    account: acc ? { code_account: acc.code_account, balance_cents: acc.balance_cents, currency: acc.currency } : null,
    operations: ops.map((o) => ({
      id: o.id,
      date: o.created_at,
      kind: o.kind,
      label: o.kind === 'depot' ? 'Dépôt' : (o.kind === 'retrait_regul' ? 'Retrait (régularisation)' : o.kind),
      amount_cents: o.amount_cents,
      amount_fcfa: Number(o.amount_cents) / 100,
      status: o.status,
      receipt_code: o.code_receipt || null,
      reference: o.reference || null,
      note: o.note || null
    }))
  });
});

// Valide une image en data URL (tracé du stylet). ~2,7 Mo max après base64.
function validDataImage(s) {
  if (typeof s !== 'string') return null;
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) return null;
  if (s.length > 3700000) return null;
  return s;
}

/**
 * FICHE CLIENT imprimable / exportable en PDF (pour signature du client et de
 * l'utilisateur). Rendue en HTML imprimable (bouton « Imprimer / Enregistrer en
 * PDF ») avec l'identité visuelle de l'IMF ; les signatures numériques déjà
 * capturées sont incrustées, sinon des cadres de signature manuscrite.
 */
r.get('/clients/:id/fiche', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const cl = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });
    const acc = (await q('SELECT * FROM account WHERE client_id=$1 ORDER BY opened_at LIMIT 1', [cl.id])).rows[0] || null;
    const sigs = (await q('SELECT role, method, image_data_url, captured_at FROM client_signature WHERE client_id=$1', [cl.id])).rows;
    const checks = (await q('SELECT field_label, is_conform FROM client_conformity_check WHERE client_id=$1 ORDER BY id', [cl.id])).rows;
    const header = await getBranding(req.user.imf_id);
    const html = renderClientFiche({ header, client: cl, account: acc, signatures: sigs,
      conformity: checks, generatedAt: new Date(), generatedBy: req.user.full_name });
    setDocumentCsp(res);
    res.type('html').send(html);
  } catch (e) { next(e); }
});

/**
 * Signatures numériques (client + utilisateur).
 * Chaque signature est tracée au stylet à l'écran (image data URL) OU validée
 * par empreinte digitale du capteur de l'appareil (attestation). Enregistrement
 * idempotent par (client, rôle).
 */
r.post('/clients/:id/signatures', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const cl = (await q('SELECT id FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });
    const items = Array.isArray(req.body && req.body.signatures) ? req.body.signatures : [];
    if (!items.length) return res.status(422).json({ error: 'signature_requise',
      message: 'Aucune signature fournie.' });
    const saved = [];
    for (const it of items) {
      const role = it && (it.role === 'client' || it.role === 'user') ? it.role : null;
      const method = it && (it.method === 'stylet' || it.method === 'empreinte') ? it.method : null;
      if (!role || !method) return res.status(422).json({ error: 'signature_invalide', field: 'method',
        message: 'Rôle (client / utilisateur) et mode (stylet / empreinte) requis pour chaque signature.' });
      let img = null, att = null;
      if (method === 'stylet') {
        img = validDataImage(it.image_data_url);
        if (!img) return res.status(422).json({ error: 'signature_trace_invalide', field: role,
          message: 'Le tracé de la signature au stylet est manquant ou invalide (' + role + ').' });
      } else {
        att = it.attestation ? String(it.attestation).slice(0, 2000) : null;
        if (!att) return res.status(422).json({ error: 'empreinte_invalide', field: role,
          message: 'La validation par empreinte digitale a échoué ou n’est pas supportée sur cet appareil (' + role + ').' });
      }
      await q(
        `INSERT INTO client_signature(imf_id,client_id,role,method,image_data_url,attestation,captured_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (client_id, role) DO UPDATE SET method=EXCLUDED.method,
           image_data_url=EXCLUDED.image_data_url, attestation=EXCLUDED.attestation,
           captured_by=EXCLUDED.captured_by, captured_at=now()`,
        [req.user.imf_id, cl.id, role, method, img, att, req.user.id]);
      saved.push(role);
    }
    await q('UPDATE client SET fiche_signed_at=now() WHERE id=$1', [cl.id]);
    res.status(201).json({ ok: true, saved, note: 'Signature(s) enregistrée(s) : ' + saved.join(', ') + '.' });
  } catch (e) { next(e); }
});

/** Liste des modes de connexion client disponibles (documentation in-app). */
r.get('/client-login-modes', (_req, res) => res.json({ modes: [
  { code: 'mot_de_passe', label: 'Mot de passe', description: 'Le client accède avec son code client + mot de passe.' },
  { code: 'sms_otp', label: 'Validation SMS', description: 'Un code à usage unique est envoyé par SMS à chaque connexion.' },
  { code: 'pin', label: 'Code PIN', description: 'Code numérique court, pratique sur téléphone simple.' }
], statement_formats: ['pdf', 'csv', 'les_deux'] }));

/**
 * SCAN d'une pièce reçue : on stocke l'image (data URL) rattachée au client.
 * L'OCR automatique n'est pas embarqué ; les valeurs lues sur le scan sont
 * confrontées à la saisie via POST /conformity ci-dessous.
 */
r.post('/clients/:id/scans', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const cl = (await q('SELECT id FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });
    const b = req.body || {};
    const img = validDataImage(b.image_data_url);
    if (!img) return res.status(422).json({ error: 'scan_invalide',
      message: 'Le scan du document est manquant ou invalide (image attendue).' });
    const row = (await q(
      `INSERT INTO client_document_scan(imf_id,client_id,doc_type,image_data_url,extracted,uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, doc_type, uploaded_at`,
      [req.user.imf_id, cl.id, b.doc_type || null, img,
       b.extracted ? JSON.stringify(b.extracted) : null, req.user.id])).rows[0];
    res.status(201).json({ ok: true, scan: row, note: 'Pièce scannée enregistrée.' });
  } catch (e) { next(e); }
});

/** Champs à confronter + valeurs saisies + dernière confrontation enregistrée. */
r.get('/clients/:id/conformity', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const cl = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });
    const fields = CONFORMITY_FIELDS.map((f) => ({ key: f.key, label: f.label, kind: f.kind,
      expected: cl[f.key] == null ? '' : (f.kind === 'date' ? String(cl[f.key]).slice(0, 10) : String(cl[f.key])) }));
    const last = (await q(
      `SELECT field_key, field_label, expected, scanned, is_conform, reviewed_at
         FROM client_conformity_check WHERE client_id=$1 ORDER BY id`, [cl.id])).rows;
    const scans = (await q('SELECT id, doc_type, uploaded_at FROM client_document_scan WHERE client_id=$1 ORDER BY uploaded_at DESC', [cl.id])).rows;
    res.json({ conformity_status: cl.conformity_status, fields, checks: last, scans });
  } catch (e) { next(e); }
});

/**
 * CONFRONTATION : compare les valeurs lues sur le scan aux informations saisies.
 * Le serveur recalcule lui-même la conformité (source de vérité) et dégage les
 * informations NON CONFORMES à corriger avant l'ouverture du compte.
 */
r.post('/clients/:id/conformity', requireRole('admin_imf','direction','department','service','agency','staff'), async (req, res, next) => {
  try {
    const cl = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client_introuvable' });
    const scanned = (req.body && req.body.scanned && typeof req.body.scanned === 'object') ? req.body.scanned : {};
    const result = buildConformityChecks(cl, scanned);
    if (!result.reviewed_count) return res.status(422).json({ error: 'confrontation_vide',
      message: 'Renseignez au moins un champ lu sur le document scanné pour lancer la confrontation.' });
    const status = result.all_conform ? 'conforme' : 'non_conforme';
    await tx(async (c) => {
      await c.query('DELETE FROM client_conformity_check WHERE client_id=$1', [cl.id]);
      for (const ch of result.checks) {
        await c.query(
          `INSERT INTO client_conformity_check(imf_id,client_id,field_key,field_label,expected,scanned,is_conform,reviewed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [req.user.imf_id, cl.id, ch.field_key, ch.field_label, ch.expected, ch.scanned, ch.is_conform, req.user.id]);
      }
      await c.query('UPDATE client SET conformity_status=$2, conformity_reviewed_at=now() WHERE id=$1', [cl.id, status]);
    });
    res.json({ ok: true, conformity_status: status, checks: result.checks,
      non_conform: result.non_conform,
      note: result.all_conform
        ? 'Toutes les informations sont conformes au document scanné — l’ouverture du compte est débloquée.'
        : (result.non_conform.length + ' information(s) non conforme(s) à corriger avant l’ouverture du compte : '
           + result.non_conform.map((n) => n.field_label).join(', ') + '.') });
  } catch (e) { next(e); }
});

export default r;
