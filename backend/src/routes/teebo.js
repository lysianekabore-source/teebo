import express from 'express';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { notifyWhatsApp, notifyEmail, TEEBO_WHATSAPP, TEEBO_EMAIL } from '../notify.js';
import { getBranding, renderInvoice, setDocumentCsp, moneyFcfa } from '../documents.js';
import { buildInvoiceLines, LICENCE_CENTS } from '../pricing.js';
import { msgAdminAccessCode, msgResendCode, msgRegeneratedCode, msgInvoice, APP_URL } from '../messages.js';

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
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_must_change,
              (SELECT iv.id FROM invoice iv
                 WHERE iv.request_id = r.id AND iv.kind = 'definitive'
                 ORDER BY iv.created_at DESC LIMIT 1) AS definitive_invoice_id,
              (SELECT iv.invoice_no FROM invoice iv
                 WHERE iv.request_id = r.id AND iv.kind = 'definitive'
                 ORDER BY iv.created_at DESC LIMIT 1) AS definitive_invoice_no
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
      // et enregistrement de la facture émise au nom de l'IMF. On reprend le
      // détail tarifaire de la demande : licence (frais unique) + abonnement,
      // la remise éventuelle du cycle annuel, puis la TVA du tenant.
      const licenceCents = r.licence_cents != null ? Number(r.licence_cents) : LICENCE_CENTS;
      const subscriptionCents = r.subscription_cents != null
        ? Number(r.subscription_cents) : Number(r.proforma_amount_cents || 0);
      const discountCents = Number(r.discount_cents || 0);
      const subtotalCents = licenceCents + subscriptionCents;       // HT avant remise
      const netCents = Math.max(0, subtotalCents - discountCents);  // HT après remise
      const setRow = (await c.query(
        'SELECT vat_rate_bp FROM imf_document_settings WHERE imf_id=$1', [r.imf_id])).rows[0];
      const vatBp = (setRow && setRow.vat_rate_bp != null) ? setRow.vat_rate_bp : 0;
      const vatCents = vatBp ? Math.round(netCents * vatBp / 10000) : 0;
      const totalCents = netCents + vatCents;
      const invoiceNo = (await c.query('SELECT fn_gen_invoice_no() AS n')).rows[0].n;
      const planRow = (await c.query('SELECT label FROM plan WHERE code=$1', [r.plan_code])).rows[0];
      const inv = (await c.query(
        `INSERT INTO invoice(imf_id, invoice_no, kind, request_id, plan_code, plan_label,
             subtotal_cents, discount_cents, vat_rate_bp, vat_cents, total_cents, currency,
             status, issued_at, proforma_no, created_by)
         VALUES ($1,$2,'definitive',$3,$4,$5,$6,$7,$8,$9,$10,'XOF','emise',now(),$11,$12)
         RETURNING id, invoice_no`,
        [r.imf_id, invoiceNo, r.id, r.plan_code,
         'Abonnement teeBo — ' + (planRow ? planRow.label : (r.plan_code || '')),
         subtotalCents, discountCents, vatBp, vatCents, totalCents, r.proforma_no, req.user.id]
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
    const msg = msgAdminAccessCode({ imfCode: out.imfCode, code: out.code, invoiceNo: out.invoiceNo });
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
    // Reconstitution des lignes (licence + abonnement) depuis la demande liée.
    const ar = inv.request_id
      ? (await q('SELECT billing_cycle, licence_cents, subscription_cents FROM access_request WHERE id=$1', [inv.request_id])).rows[0]
      : null;
    const planLabel = (inv.plan_label || inv.plan_code || '').replace(/^Abonnement teeBo — /, '');
    const lines = (ar && (ar.licence_cents != null || ar.subscription_cents != null))
      ? buildInvoiceLines({ planLabel, billing: ar.billing_cycle,
          licenceCents: ar.licence_cents, subscriptionCents: ar.subscription_cents })
      : null;
    const html = renderInvoice({
      header,
      kind: 'definitive',
      invoiceNo: inv.invoice_no,
      issuedAt: inv.issued_at,
      dueAt: inv.due_at,
      periodLabel: inv.period_label || (ar && ar.billing_cycle === 'annuel' ? '12 mois (annuel)' : (ar ? '1 mois (mensuel)' : null)),
      plan: inv.plan_label || inv.plan_code,
      lines,
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
    setDocumentCsp(res);
    res.type('html').send(html);
  } catch (e) { next(e); }
});

// --- Envoi de la facture PROFORMA au client (WhatsApp + e-mail) ------------
router.post('/requests/:id/send-proforma', async (req, res, next) => {
  try {
    const r = (await q('SELECT * FROM access_request WHERE id=$1', [req.params.id])).rows[0];
    if (!r || !r.proforma_no) return res.status(404).json({ error: 'proforma_not_found' });
    const imf = (await q('SELECT name, whatsapp, phone_main, email FROM imf WHERE id=$1', [r.imf_id])).rows[0] || {};
    const url = `${APP_URL}/api/v1/requests/${r.id}/proforma.pdf`;
    const msg = msgInvoice({ kind: 'proforma', invoiceNo: r.proforma_no, imfName: imf.name, url });
    await notifyWhatsApp(imf.whatsapp || imf.phone_main, msg);
    await notifyEmail(imf.email, `teebo — facture proforma ${r.proforma_no}`, msg);
    res.json({ ok: true, proforma_no: r.proforma_no, sent_to: imf.email, url });
  } catch (e) { next(e); }
});

// --- Envoi de la facture DÉFINITIVE au client (WhatsApp + e-mail) -----------
router.post('/requests/:id/send-invoice', async (req, res, next) => {
  try {
    const r = (await q('SELECT * FROM access_request WHERE id=$1', [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'not_found' });
    const inv = (await q(
      `SELECT * FROM invoice WHERE request_id=$1 AND kind='definitive' ORDER BY created_at DESC LIMIT 1`,
      [r.id])).rows[0];
    if (!inv) return res.status(409).json({ error: 'no_invoice', message: 'Aucune facture définitive : approuvez d’abord la demande.' });
    const imf = (await q('SELECT name, whatsapp, phone_main, email FROM imf WHERE id=$1', [r.imf_id])).rows[0] || {};
    const url = `${APP_URL}/api/v1/requests/invoice/${inv.id}.pdf`;
    const msg = msgInvoice({ kind: 'definitive', invoiceNo: inv.invoice_no, imfName: imf.name, url });
    await notifyWhatsApp(imf.whatsapp || imf.phone_main, msg);
    await notifyEmail(imf.email, `teebo — facture ${inv.invoice_no}`, msg);
    res.json({ ok: true, invoice_no: inv.invoice_no, sent_to: imf.email, url });
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
    const msg = msgRegeneratedCode({ imfCode: out.imfCode, code: out.code });
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
    const msg = msgResendCode({ imfCode: imf.code_imf, code: admin.code_user });
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

// --- Suivi des échéances d'abonnement (annuel / mensuel) -------------------
// Vue dédiée au tableau de bord teebo : pour chaque IMF, cycle de facturation,
// montant d'abonnement, début (1re facture définitive ou fin d'essai) et
// PROCHAINE ÉCHÉANCE calculée selon le cycle. Pendant l'essai, l'échéance est la
// fin d'essai ; ensuite elle avance de 1 mois (mensuel) ou 12 mois (annuel).
router.get('/subscriptions', async (_req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT i.id, i.code_imf, i.name, i.status, i.trial_ends_at, i.created_at,
              ar.billing_cycle, ar.subscription_cents, ar.discount_cents, ar.plan_code,
              inv.issued_at AS invoice_issued_at, inv.total_cents, inv.invoice_no,
              inv.id AS invoice_id
         FROM imf i
         LEFT JOIN LATERAL (
              SELECT billing_cycle, subscription_cents, discount_cents, plan_code
                FROM access_request a
               WHERE a.imf_id = i.id AND a.billing_cycle IS NOT NULL
               ORDER BY a.created_at DESC LIMIT 1) ar ON true
         LEFT JOIN LATERAL (
              SELECT id, issued_at, total_cents, invoice_no
                FROM invoice v
               WHERE v.imf_id = i.id AND v.kind = 'definitive'
               ORDER BY v.created_at DESC LIMIT 1) inv ON true
        WHERE i.code_imf <> 'TBO-SYS-000000'
        ORDER BY i.created_at DESC`
    );
    const now = Date.now();
    const DAY = 86400000;
    const subs = rows.map((r) => {
      const cycle = r.billing_cycle || 'mensuel';
      const months = cycle === 'annuel' ? 12 : 1;
      // Base de départ : date de la 1re facture définitive, sinon fin d'essai.
      const start = r.invoice_issued_at ? new Date(r.invoice_issued_at)
        : (r.trial_ends_at ? new Date(r.trial_ends_at) : new Date(r.created_at));
      let nextDue;
      if (r.status === 'trial' && r.trial_ends_at) {
        nextDue = new Date(r.trial_ends_at);
      } else {
        nextDue = new Date(start.getTime());
        // On avance par pas de `months` jusqu'à dépasser aujourd'hui.
        let guard = 0;
        while (nextDue.getTime() <= now && guard < 600) { nextDue.setMonth(nextDue.getMonth() + months); guard++; }
      }
      const daysLeft = nextDue ? Math.ceil((nextDue.getTime() - now) / DAY) : null;
      return {
        id: r.id, code_imf: r.code_imf, name: r.name, status: r.status,
        billing_cycle: cycle, plan_code: r.plan_code,
        subscription_cents: r.subscription_cents != null ? Number(r.subscription_cents) : null,
        discount_cents: r.discount_cents != null ? Number(r.discount_cents) : 0,
        total_cents: r.total_cents != null ? Number(r.total_cents) : null,
        invoice_no: r.invoice_no || null,
        invoice_id: r.invoice_id || null,
        trial_ends_at: r.trial_ends_at,
        next_due_at: nextDue ? nextDue.toISOString() : null,
        days_left: daysLeft,
        overdue: daysLeft != null && daysLeft < 0
      };
    });
    // Récapitulatif par cycle (pour les cartes de stats).
    const recap = {
      annuel: subs.filter((s) => s.billing_cycle === 'annuel').length,
      mensuel: subs.filter((s) => s.billing_cycle === 'mensuel').length,
      due_30d: subs.filter((s) => s.days_left != null && s.days_left >= 0 && s.days_left <= 30).length,
      overdue: subs.filter((s) => s.overdue).length,
      mrr_cents: subs.filter((s) => s.status === 'active' && s.subscription_cents)
        .reduce((acc, s) => acc + (s.billing_cycle === 'annuel'
          ? Math.round((s.subscription_cents - (s.discount_cents || 0)) / 12)
          : s.subscription_cents), 0)
    };
    res.json({ subscriptions: subs, recap });
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
