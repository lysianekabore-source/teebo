import express from 'express';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { notifyWhatsApp, notifyEmail, TEEBO_WHATSAPP, TEEBO_EMAIL } from '../notify.js';

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
      `SELECT r.*, i.name AS imf_name, i.code_imf, i.country_code, i.type
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
      return { code: user.code_user, imfCode: imf.code_imf, whatsapp: imf.whatsapp, email: imf.email };
    });

    // Notification WhatsApp + e-mail à l'IMF (code d'accès + essai 30 jours)
    const msg = `teebo: votre accès à l'essai gratuit de 30 jours est approuvé. ` +
      `Code d'accès admin (IMF ${out.imfCode}) : ${out.code}. ` +
      `Connectez-vous et créez immédiatement votre mot de passe.`;
    await notifyWhatsApp(out.whatsapp, msg);
    await notifyEmail(out.email, 'Votre accès teebo est approuvé (essai 30 jours)', msg);
    await notifyWhatsApp(TEEBO_WHATSAPP, `Demande ${req.params.id} approuvée. Code admin: ${out.code}`);

    res.json({ ok: true, code_user: out.code, imf_code: out.imfCode });
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

// --- Liste des IMF ----------------------------------------------------------
router.get('/imfs', async (_req, res, next) => {
  try {
    const { rows } = await q('SELECT * FROM imf ORDER BY created_at DESC');
    res.json({ imfs: rows });
  } catch (e) { next(e); }
});

export default router;
