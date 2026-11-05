import express from 'express';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { notifyWhatsApp, notifyEmail, TEEBO_WHATSAPP, TEEBO_EMAIL } from '../notify.js';
import { getBranding, renderInvoice } from '../documents.js';

const router = express.Router();

router.use(authenticate, requireRole('teebo_admin'));

// --- Profil de l'administrateur teebo --------------------------------------
router.get('/me', async (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, full_name: req.user.full_name, role: req.user.role } });
});

// --- Demandes à approuver (facture proforma validée) -----------------------
router.get('/requests', async (_req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT r.*, i.name AS imf_name, i.code_imf, i.country_code, i.type,
              (SELECT au.code_user FROM app_user au
                 WHERE au.imf_id = r.imf_id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_code,
              (SELECT au.email FROM app_user au
                 WHERE au.imf_id = r.imf_id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_email,
              (SELECT au.id FROM app_user au
                 WHERE au.imf_id = r.imf_id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_user_id,
              (SELECT au.must_change_password FROM app_user au
                 WHERE au.imf_id = r.imf_id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_must_change
         FROM access_request r JOIN imf i ON i.id = r.imf_id
        ORDER BY r.created_at DESC`
    );
    res.json({ requests: rows });
  } catch (e) { next(e); }
});

// --- Approbation : essai gratuit 30 jours + génération du code admin IMF ---
router.post('/requests/:id/approve', async (req, res, next) => {
  try {
    const out = await tx(async (c) => {
      const r = (await c.query('SELECT * FROM access_request WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!r) { const e = new Error('not_found'); e.status = 404; throw e; }
      if (!r.proforma_validated) { const e = new Error('proforma_not_validated'); e.status = 409; throw e; }

      // Essai gratuit : 30 jours calendaires
      await c.query(
        `UPDATE imf SET status='trial', trial_started_at=now(),
             trial_ends_at = now() + interval '30 days' WHERE id=$1`, [r.imf_id]);
      await c.query(
        `UPDATE access_request SET decision='approved', decided_by=$1, decided_at=now() WHERE id=$2`,
        [req.user.id, r.id]);

      // FACTURE DÉFINITIVE : génération du numéro séquentiel (fn_gen_invoice_no)
      // et enregistrement de la facture émise au nom de l'IMF. Le taux de TVA
      // provient du paramétrage du tenant (imf_document_settings.vat_rate_bp) :
      // s'il est NULL, la facture porte la mention « TVA non applicable ».
      const amountCents = r.proforma_amount_cents || 0;
      const setRow = (await c.query(
        'SELECT vat_rate_bp FROM imf_document_settings WHERE imf_id=$1', [r.imf_id])).rows[0];
      const vatBp = (setRow && setRow.vat_rate_bp != null) ? setRow.vat_rate_bp : 0;
      const vatCents = vatBp ? Math.round(amountCents * vatBp / 10000) : 0;
      const totalCents = amountCents + vatCents;
      const invoiceNo = (await c.query('SELECT fn_gen_invoice_no() AS n')).rows[0].n;
      const planRow = (await c.query('SELECT label FROM plan WHERE code=$1', [r.plan_code])).rows[0];
      const inv = (await c.query(
        `INSERT INTO invoice(imf_id, invoice_no, kind, request_id, plan_code, plan_label,
             subtotal_cents, vat_rate_bp, vat_cents, total_cents, currency,
             status, issued_at, proforma_no, created_by)
         VALUES ($1,$2,'definitive',$3,$4,$5,$6,$7,$8,$9,'XOF','emise',now(),$10,$11)
         RETURNING id, invoice_no`,
        [r.imf_id, invoiceNo, r.id, r.plan_code,
         'Abonnement teebo — ' + (planRow ? planRow.label : (r.plan_code || '')),
         amountCents, vatBp, vatCents, totalCents, r.proforma_no, req.user.id]
      )).rows[0];

      // Création de l'accès admin IMF avec un code d'accès (mot de passe à créer)
      const imf = (await c.query('SELECT code_imf, email, whatsapp, phone_main FROM imf WHERE id=$1', [r.imf_id])).rows[0];
      const code = (await c.query('SELECT fn_gen_user_code($1) AS c', [r.imf_id])).rows[0].c;
      const user = (await c.query(
        `INSERT INTO app_user(imf_id, code_user, full_name, position, email, role,
             password_hash, must_change_password)
         VALUES ($1,$2,$3,$4,$5,'admin_imf', NULL, true)
         ON CONFLICT (imf_id,email) DO UPDATE SET code_user=EXCLUDED.code_user
         RETURNING id, code_user`, [r.imf_id, code, r.admin_name, r.requester_position, imf.email]
      )).rows[0];
      return { code: user.code_user, imfCode: imf.code_imf, whatsapp: imf.whatsapp, email: imf.email,
               invoiceId: inv.id, invoiceNo: inv.invoice_no, totalCents };
    });

    // Notification WhatsApp + e-mail à l'IMF (code d'accès + essai 30 jours)
    const msg = `teebo: votre accès à l'essai gratuit de 30 jours est approuvé. ` +
      `Code d'accès admin (IMF ${out.imfCode}) : ${out.code}. ` +
      `Facture définitive ${out.invoiceNo} disponible dans votre espace. ` +
      `Connectez-vous et créez immédiatement votre mot de passe.`;
    await notifyWhatsApp(out.whatsapp, msg);
    await notifyEmail(out.email, 'Votre accès teebo est approuvé (essai 30 jours)', msg);
    await notifyWhatsApp(TEEBO_WHATSAPP, `Demande ${req.params.id} approuvée. Code admin: ${out.code}`);

    res.json({ ok: true, code_user: out.code, imf_code: out.imfCode,
      invoice_no: out.invoiceNo, invoice_url: `/api/v1/teebo/invoices/${out.invoiceId}.pdf` });
  } catch (e) { next(e); }
});

// --- Facture DÉFINITIVE imprimable (PDF via HTML) --------------------------
router.get('/invoices/:id.pdf', async (req, res, next) => {
  try {
    const inv = (await q('SELECT * FROM invoice WHERE id=$1', [req.params.id])).rows[0];
    if (!inv) return res.status(404).json({ error: 'invoice_not_found' });
    const header = await getBranding(inv.imf_id);
    const imf = (await q('SELECT name, email FROM imf WHERE id=$1', [inv.imf_id])).rows[0] || {};
    const html = renderInvoice({
      header,
      kind: 'definitive',
      invoiceNo: inv.invoice_no,
      issuedAt: inv.issued_at,
      dueAt: inv.due_at,
      periodLabel: inv.period_label,
      plan: inv.plan_label || inv.plan_code,
      subtotalCents: inv.subtotal_cents,
      discountCents: inv.discount_cents,
      vatRateBp: inv.vat_rate_bp,
      vatCents: inv.vat_cents,
      totalCents: inv.total_cents,
      currency: inv.currency,
      status: inv.status,
      amountPaidCents: inv.amount_paid_cents,
      clientName: imf.name || header.legal_name,
      clientCode: imf.email || '',
      notes: inv.notes
    });
    res.type('html').send(html);
  } catch (e) { next(e); }
});

// --- Rejet -----------------------------------------------------------------
router.post('/requests/:id/reject', async (req, res, next) => {
  try {
    await q(`UPDATE access_request SET decision='rejected', decided_by=$1, decided_at=now() WHERE id=$2`,
      [req.user.id, req.params.id]);
    await q(`UPDATE imf SET status='rejected' WHERE id=(SELECT imf_id FROM access_request WHERE id=$1)`,
      [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Liste des IMF (avec code d'accès administrateur visible) --------------
router.get('/imfs', async (_req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT i.*,
              (SELECT au.code_user FROM app_user au
                 WHERE au.imf_id = i.id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_code,
              (SELECT au.email FROM app_user au
                 WHERE au.imf_id = i.id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_email,
              (SELECT au.full_name FROM app_user au
                 WHERE au.imf_id = i.id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_name,
              (SELECT au.must_change_password FROM app_user au
                 WHERE au.imf_id = i.id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_must_change,
              (SELECT count(*) FROM app_user au WHERE au.imf_id = i.id) AS users_count
         FROM imf i ORDER BY i.created_at DESC`
    );
    res.json({ imfs: rows });
  } catch (e) { next(e); }
});

// --- Administrateurs IMF (tableau dédié) -----------------------------------
router.get('/imf-admins', async (_req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT au.id, au.code_user, au.email, au.full_name, au.role,
              au.must_change_password, au.created_at, au.is_active,
              i.name AS imf_name, i.code_imf, i.status AS imf_status,
              i.trial_ends_at
         FROM app_user au JOIN imf i ON i.id = au.imf_id
        WHERE au.role = 'admin_imf'
        ORDER BY au.created_at DESC`
    );
    res.json({ admins: rows });
  } catch (e) { next(e); }
});

// --- Détail d'une institution + ses utilisateurs ---------------------------
router.get('/imfs/:id', async (req, res, next) => {
  try {
    const imf = (await q('SELECT * FROM imf WHERE id=$1', [req.params.id])).rows[0];
    if (!imf) return res.status(404).json({ error: 'not_found' });
    const users = (await q(
      `SELECT au.id, au.code_user, au.email, au.full_name, au.role, au.is_active,
              au.must_change_password, au.created_at,
              COALESCE(t.enabled, false) AS twofa_enabled
         FROM app_user au LEFT JOIN user_2fa t ON t.user_id = au.id
        WHERE au.imf_id=$1 ORDER BY au.created_at ASC`, [imf.id]
    )).rows;
    res.json({ imf, users });
  } catch (e) { next(e); }
});

// --- Régénérer le code d'accès d'une institution ---------------------------
router.post('/imfs/:id/regenerate-code', async (req, res, next) => {
  try {
    const out = await tx(async (c) => {
      const imf = (await c.query('SELECT * FROM imf WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!imf) { const e = new Error('not_found'); e.status = 404; throw e; }
      const code = (await c.query('SELECT fn_gen_user_code($1) AS c', [imf.id])).rows[0].c;
      const admins = (await c.query(
        `SELECT id, email FROM app_user WHERE imf_id=$1 AND role='admin_imf' ORDER BY created_at ASC`, [imf.id]
      )).rows;
      if (!admins.length) { const e = new Error('no_admin'); e.status = 409; throw e; }
      const admin = admins[0];
      await c.query(
        `UPDATE app_user SET code_user=$1, password_hash=NULL, must_change_password=true WHERE id=$2`,
        [code, admin.id]);
      return { code, email: admin.email, imfCode: imf.code_imf,
        whatsapp: imf.whatsapp, phone: imf.phone_main };
    });
    const msg = `teebo: votre nouveau code d'accès administrateur (IMF ${out.imfCode}) : ${out.code}. ` +
      `Connectez-vous et créez votre mot de passe via « Premier accès ».`;
    await notifyWhatsApp(out.whatsapp || out.phone, msg);
    await notifyEmail(out.email, 'Votre nouveau code d\'accès teebo', msg);
    res.json({ ok: true, code_user: out.code, sent_to: out.email });
  } catch (e) { next(e); }
});

// --- Renvoyer (sans régénérer) le code d'accès par WhatsApp / e-mail -------
router.post('/imfs/:id/resend-code', async (req, res, next) => {
  try {
    const imf = (await q('SELECT * FROM imf WHERE id=$1', [req.params.id])).rows[0];
    if (!imf) return res.status(404).json({ error: 'not_found' });
    const admin = (await q(
      `SELECT id, code_user, email FROM app_user WHERE imf_id=$1 AND role='admin_imf' ORDER BY created_at ASC LIMIT 1`,
      [imf.id])).rows[0];
    if (!admin || !admin.code_user) return res.status(409).json({ error: 'no_code' });
    const msg = `teebo: rappel de votre code d'accès administrateur (IMF ${imf.code_imf}) : ${admin.code_user}. ` +
      `Connectez-vous sur https://teebo-imf.netlify.app et créez votre mot de passe.`;
    await notifyWhatsApp(imf.whatsapp || imf.phone_main, msg);
    await notifyEmail(admin.email, 'Rappel : votre code d\'accès teebo', msg);
    res.json({ ok: true, code_user: admin.code_user, sent_to: admin.email });
  } catch (e) { next(e); }
});

// --- Changer le statut d'une institution (activer / suspendre / essai) -----
router.post('/imfs/:id/status', async (req, res, next) => {
  try {
    const allowed = ['trial', 'active', 'suspended', 'approved', 'pending', 'rejected'];
    const { status, extend_trial_days } = req.body || {};
    if (!allowed.includes(status)) return res.status(422).json({ error: 'invalid_status' });
    const imf = (await q('SELECT id, status FROM imf WHERE id=$1', [req.params.id])).rows[0];
    if (!imf) return res.status(404).json({ error: 'not_found' });
    await q('UPDATE imf SET status=$1 WHERE id=$2', [status, imf.id]);
    let trialEnds = null;
    if (status === 'trial' && extend_trial_days) {
      const days = Math.max(1, Math.min(365, parseInt(extend_trial_days, 10) || 30));
      trialEnds = (await q(
        `UPDATE imf SET trial_ends_at = COALESCE(trial_ends_at, now()) + ($1 || ' days')::interval
          WHERE id=$2 RETURNING trial_ends_at`, [days, imf.id])).rows[0].trial_ends_at;
    }
    res.json({ ok: true, status, trial_ends_at: trialEnds });
  } catch (e) { next(e); }
});

// --- Prolonger l'essai gratuit (30 jours par défaut) -----------------------
router.post('/imfs/:id/extend-trial', async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt((req.body || {}).days, 10) || 30));
    const row = (await q(
      `UPDATE imf SET status='trial',
             trial_started_at = COALESCE(trial_started_at, now()),
             trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now()) + ($1 || ' days')::interval
        WHERE id=$2 RETURNING id, trial_ends_at`, [days, req.params.id]
    )).rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, trial_ends_at: row.trial_ends_at, days });
  } catch (e) { next(e); }
});

// --- Activer / désactiver l'accès d'un utilisateur IMF ---------------------
router.post('/users/:id/toggle', async (req, res, next) => {
  try {
    const u = (await q('SELECT id, is_active FROM app_user WHERE id=$1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    const next = !u.is_active;
    await q('UPDATE app_user SET is_active=$1 WHERE id=$2', [next, u.id]);
    if (!next) await q('UPDATE session SET revoked=true WHERE user_id=$1', [u.id]);
    res.json({ ok: true, is_active: next });
  } catch (e) { next(e); }
});

// --- Journal des actions éditeur (audit) -----------------------------------
router.get('/audit', async (_req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT ar.id, ar.decision, ar.decided_at, i.name AS imf_name, i.code_imf
         FROM access_request ar JOIN imf i ON i.id = ar.imf_id
        WHERE ar.decision IS NOT NULL
        ORDER BY ar.decided_at DESC LIMIT 100`
    );
    res.json({ audit: rows });
  } catch (e) { next(e); }
});

// --- Statistiques de la plateforme -----------------------------------------
router.get('/stats', async (_req, res, next) => {
  try {
    const c = (await q(
      `SELECT
        (SELECT count(*) FROM imf) AS imfs,
        (SELECT count(*) FROM imf WHERE status='trial') AS trials,
        (SELECT count(*) FROM imf WHERE status='active') AS actives,
        (SELECT count(*) FROM imf WHERE status='suspended') AS suspended,
        (SELECT count(*) FROM access_request WHERE decision IS NULL AND proforma_validated) AS pending,
        (SELECT count(*) FROM app_user) AS users`
    )).rows[0];
    res.json({ stats: c });
  } catch (e) { next(e); }
});

export default router;
