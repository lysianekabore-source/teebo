import express from 'express';
import { q, tx } from '../db.js';
import { authenticate, requireFreshPassword, requireRole } from '../auth.js';
import { getBranding, TEEBO_SUPPLIER, renderInvoice, setDocumentCsp } from '../documents.js';

const router = express.Router();
router.use(authenticate, requireFreshPassword);

/**
 * Paramètres de l'IMF — identité visuelle (logo) + mentions légales obligatoires.
 * ---------------------------------------------------------------------------
 * Ces informations sont saisies/validées par l'administrateur IMF puis
 * automatiquement reprises sur : le relevé de compte, la facture proforma et
 * la facture définitive. Modifiables à tout moment par admin_imf ou direction.
 */

const MIME_OK = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'];
const MAX_LOGO_BYTES = 400 * 1024; // 400 Ko : suffisant pour un logo net, léger en base

// GDPR/périmètre : réservé aux IMF (pas au super-admin teebo).
router.use((req, res, next) => {
  if (req.user.role === 'teebo_admin') return res.status(403).json({ error: 'use_teebo_console' });
  next();
});

/** GET /api/v1/org-settings — identité visuelle + mentions légales + tarif TVA. */
router.get('/org-settings', async (req, res, next) => {
  try {
    const b = await getBranding(req.user.imf_id);
    const notif = await currentNotif(req.user.imf_id);
    res.json({
      settings: {
        logo_data_url: b.logo_data_url,
        legal_name: b.legal_name,
        legal_form: b.legal_form,
        trade_register_no: b.trade_register_no,
        tax_id: b.tax_id,
        vat_number: b.vat_number,
        bceao_agreement_no: b.bceao_agreement_no,
        share_capital_cents: b.share_capital_cents,
        legal_address: b.legal_address,
        bank_details: b.bank_details,
        footer_note: b.footer_note
      },
      imf: {
        code_imf: b.imf.code_imf, name: b.imf.name, type: b.imf.type,
        country_code: b.imf.country_code, city: b.imf.city,
        phone_main: b.imf.phone_main, email: b.imf.email, whatsapp: b.imf.whatsapp
      },
      vat_rate_bp: await currentVatBp(req.user.imf_id),
      // Coordonnées d'envoi des codes/notifications aux utilisateurs de l'IMF.
      notif_whatsapp: notif.notif_whatsapp,
      notif_email: notif.notif_email,
      supplier: TEEBO_SUPPLIER,
      can_edit: canEdit(req.user.role)
    });
  } catch (e) { next(e); }
});

/** POST /api/v1/org-settings — enregistre (réservé admin_imf / direction). */
router.post('/org-settings', requireRole('admin_imf', 'direction'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const hasLogo = b.logo_data_url !== undefined;
    let logo = null, mime = null, bytes = null;

    if (hasLogo && b.logo_data_url) {
      const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,/.exec(b.logo_data_url);
      if (!m) return res.status(422).json({ error: 'invalid_logo', message: 'Format d\'image non reconnu (PNG, JPEG, WEBP ou SVG attendu).' });
      mime = m[1].toLowerCase();
      if (!MIME_OK.includes(mime)) return res.status(422).json({ error: 'invalid_logo_type', message: 'Type d\'image non autorisé.' });
      bytes = Math.floor((b.logo_data_url.length - m[0].length) * 3 / 4);
      if (bytes > MAX_LOGO_BYTES) return res.status(413).json({ error: 'logo_too_large', message: 'Le logo dépasse 400 Ko. Réduisez-le puis réessayez.' });
      logo = b.logo_data_url;
    }

    const num = (v) => (v === undefined || v === null || v === '' ? null : Math.round(Number(v)));
    const cap = num(b.share_capital_cents);

    await tx(async (c) => {
      const existing = (await c.query('SELECT imf_id FROM imf_branding WHERE imf_id=$1', [req.user.imf_id])).rows.length;
      if (!existing) {
        await c.query(
          `INSERT INTO imf_branding(imf_id, logo_data_url, logo_mime, logo_bytes, logo_updated_at, logo_updated_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.imf_id, logo, mime, bytes, logo ? new Date() : null, logo ? req.user.id : null]);
      }
      // Mise à jour conditionnelle (le logo n'est remplacé que s'il est fourni).
      await c.query(
        `UPDATE imf_branding SET
            logo_data_url      = CASE WHEN $2::boolean THEN $3 ELSE logo_data_url END,
            logo_mime          = CASE WHEN $2::boolean THEN $4 ELSE logo_mime END,
            logo_bytes         = CASE WHEN $2::boolean THEN $5 ELSE logo_bytes END,
            logo_updated_at    = CASE WHEN $2::boolean THEN now() ELSE logo_updated_at END,
            logo_updated_by    = CASE WHEN $2::boolean THEN $6 ELSE logo_updated_by END,
            legal_name         = COALESCE($7, legal_name),
            legal_form         = COALESCE($8, legal_form),
            trade_register_no  = COALESCE($9, trade_register_no),
            tax_id             = COALESCE($10, tax_id),
            vat_number         = COALESCE($11, vat_number),
            bceao_agreement_no = COALESCE($12, bceao_agreement_no),
            share_capital_cents= COALESCE($13, share_capital_cents),
            legal_address      = COALESCE($14, legal_address),
            bank_details       = COALESCE($15, bank_details),
            footer_note        = COALESCE($16, footer_note),
            updated_at         = now()
          WHERE imf_id = $1`,
        [req.user.imf_id, hasLogo, logo, mime, bytes, req.user.id,
         strOrNull(b.legal_name), strOrNull(b.legal_form), strOrNull(b.trade_register_no),
         strOrNull(b.tax_id), strOrNull(b.vat_number), strOrNull(b.bceao_agreement_no),
         cap, strOrNull(b.legal_address), strOrNull(b.bank_details), strOrNull(b.footer_note)]);

      // Taux de TVA : CONFIGURABLE par tenant (aucun taux par défaut imposé).
      if (b.vat_rate_bp !== undefined) {
        const bp = b.vat_rate_bp === null || b.vat_rate_bp === '' ? null : Math.max(0, Math.min(10000, Math.round(Number(b.vat_rate_bp))));
        await c.query(
          `INSERT INTO imf_document_settings(imf_id, vat_rate_bp) VALUES ($1,$2)
           ON CONFLICT (imf_id) DO UPDATE SET vat_rate_bp=EXCLUDED.vat_rate_bp, updated_at=now()`,
          [req.user.imf_id, bp]);
      }
      // Coordonnées de notification (WhatsApp / e-mail) pour l'envoi des codes
      // d'accès aux utilisateurs de l'IMF. Configurables à tout moment.
      if (b.notif_whatsapp !== undefined || b.notif_email !== undefined) {
        await c.query(
          `INSERT INTO imf_document_settings(imf_id, notif_whatsapp, notif_email) VALUES ($1,$2,$3)
           ON CONFLICT (imf_id) DO UPDATE SET
             notif_whatsapp = CASE WHEN $4::boolean THEN EXCLUDED.notif_whatsapp ELSE imf_document_settings.notif_whatsapp END,
             notif_email    = CASE WHEN $5::boolean THEN EXCLUDED.notif_email ELSE imf_document_settings.notif_email END,
             updated_at = now()`,
          [req.user.imf_id, strOrNull(b.notif_whatsapp), strOrNull(b.notif_email),
           b.notif_whatsapp !== undefined, b.notif_email !== undefined]);
      }
      // Répercussion des mentions légales sur la fiche imf (cohérence).
      if (b.legal_name || b.legal_address) {
        await c.query(
          `UPDATE imf SET name = COALESCE($2, name), updated_at = now() WHERE id=$1`,
          [req.user.imf_id, strOrNull(b.legal_name)]);
      }
    });

    const fresh = await getBranding(req.user.imf_id);
    res.json({ ok: true, message: 'Paramètres enregistrés. La nouvelle identité apparaîtra sur les documents (relevés, factures).',
      settings: { logo_data_url: fresh.logo_data_url, legal_name: fresh.legal_name } });
  } catch (e) { next(e); }
});

/** DELETE /api/v1/org-settings/logo — retire le logo (retour au monogramme). */
router.delete('/org-settings/logo', requireRole('admin_imf', 'direction'), async (req, res, next) => {
  try {
    await q(`UPDATE imf_branding SET logo_data_url=NULL, logo_mime=NULL, logo_bytes=NULL,
                    logo_updated_at=now(), logo_updated_by=$2, updated_at=now()
              WHERE imf_id=$1`, [req.user.imf_id, req.user.id]);
    res.json({ ok: true, message: 'Logo retiré.' });
  } catch (e) { next(e); }
});

/**
 * POST /api/v1/org-settings/preview — PRÉVISUALISATION DYNAMIQUE de facture.
 * -------------------------------------------------------------------------
 * Renvoie le fragment HTML d'une facture proforma rendue avec les paramètres
 * RÉELS de l'IMF (logo + mentions légales enregistrés, TVA configurée). Cette
 * route sert à la vignette d'aperçu de l'onglet « Paramètres IMF » : l'admin
 * voit immédiatement à quoi ressembleront ses factures après enregistrement.
 * Aucune donnée n'est modifiée.
 */
router.get('/org-settings/preview', async (req, res, next) => {
  try {
    const header = await getBranding(req.user.imf_id);
    const vatBp = (await currentVatBp(req.user.imf_id)) || 0;
    const subtotal = 12000000;                                   // plan Business : 120 000 FCFA
    const vatCents = vatBp ? Math.round(subtotal * vatBp / 10000) : 0;
    const total = subtotal + vatCents;
    const html = renderInvoice({
      header,
      kind: 'proforma',
      invoiceNo: 'PRO-' + new Date().getFullYear() + '-000001',
      issuedAt: new Date(),
      plan: 'Abonnement teebo — Business',
      subtotalCents: subtotal,
      vatRateBp: vatBp,
      vatCents,
      totalCents: total,
      currency: 'XOF',
      clientName: header.legal_name || header.imf.name || '',
      clientCode: header.imf.email || '',
      notes: 'Aperçu généré automatiquement à partir de vos paramètres actuels.',
      embed: true
    });
    setDocumentCsp(res, { allowFrame: true });
    res.type('html').send(html);
  } catch (e) { next(e); }
});

/* -------------------------------- helpers -------------------------------- */
function strOrNull(v) { return (v === undefined || v === null || v === '') ? null : String(v).trim(); }
function canEdit(role) { return ['admin_imf', 'direction'].includes(role); }

async function currentVatBp(imfId) {
  const r = (await q('SELECT vat_rate_bp FROM imf_document_settings WHERE imf_id=$1', [imfId])).rows[0];
  return r ? r.vat_rate_bp : null;
}

async function currentNotif(imfId) {
  const r = (await q('SELECT notif_whatsapp, notif_email FROM imf_document_settings WHERE imf_id=$1', [imfId])).rows[0];
  return { notif_whatsapp: r ? r.notif_whatsapp : null, notif_email: r ? r.notif_email : null };
}

export default router;
