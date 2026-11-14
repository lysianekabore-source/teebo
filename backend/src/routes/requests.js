import express from 'express';
import { q, tx } from '../db.js';
import { notifyWhatsApp, notifyEmail, TEEBO_WHATSAPP, TEEBO_EMAIL, verifyDocToken } from '../notify.js';
import { getBranding, renderInvoice, moneyFcfa, setDocumentCsp } from '../documents.js';
import { computePricing, buildInvoiceLines, BILLING_CYCLES, LICENCE_CENTS, TRIAL_BILLING_NOTE } from '../pricing.js';

const router = express.Router();

// Pays UEMOA + indicatifs (le front affiche l'indicatif selon le pays choisi)
export const UEMOA = [
  { code: 'BJ', name: 'Bénin',          dial: '+229' },
  { code: 'BF', name: 'Burkina Faso',   dial: '+226' },
  { code: 'CI', name: "Côte d'Ivoire",  dial: '+225' },
  { code: 'GW', name: 'Guinée-Bissau',  dial: '+245' },
  { code: 'ML', name: 'Mali',           dial: '+223' },
  { code: 'NE', name: 'Niger',          dial: '+227' },
  { code: 'SN', name: 'Sénégal',        dial: '+221' },
  { code: 'TG', name: 'Togo',           dial: '+228' }
];
const UEMOA_CODES = UEMOA.map(c => c.code);

router.get('/uemoa-countries', (_req, res) => res.json({ countries: UEMOA }));

// ---------------------------------------------------------------------------
// AUTO-RÉPARATION du schéma requis pour le dépôt d'une demande d'accès.
// Le RCCM / IFU (mentions légales de facturation) et les colonnes de suivi de
// la demande proviennent de migrations successives. Si l'une d'elles n'a pas
// été jouée sur la base de production, l'INSERT échouait et l'API renvoyait
// « server_error » — donc « Une erreur est survenue » côté formulaire, sans
// aucune explication. On sécurise donc ces objets de façon idempotente avant
// d'écrire, exactement comme le fait déjà l'onglet Organisation.
let _requestSchemaEnsured = false;
async function ensureRequestSchema() {
  if (_requestSchemaEnsured) return;
  await q(`
    CREATE TABLE IF NOT EXISTS imf_branding (
      imf_id UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS legal_name          TEXT;
    ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS legal_form          TEXT;
    ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS trade_register_no   TEXT;
    ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS tax_id              TEXT;
    ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS bceao_agreement_no  TEXT;
    ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS share_capital_cents BIGINT;
    ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS legal_address       TEXT;

    CREATE TABLE IF NOT EXISTS access_request (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      imf_id UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE access_request ADD COLUMN IF NOT EXISTS requester_lastname  TEXT;
    ALTER TABLE access_request ADD COLUMN IF NOT EXISTS requester_firstname TEXT;
    ALTER TABLE access_request ADD COLUMN IF NOT EXISTS requester_position  TEXT;
    ALTER TABLE access_request ADD COLUMN IF NOT EXISTS admin_name          TEXT;
    ALTER TABLE access_request ADD COLUMN IF NOT EXISTS billing_cycle       TEXT;
    ALTER TABLE access_request ADD COLUMN IF NOT EXISTS licence_cents       BIGINT;
    ALTER TABLE access_request ADD COLUMN IF NOT EXISTS subscription_cents  BIGINT;
    ALTER TABLE access_request ADD COLUMN IF NOT EXISTS discount_cents      BIGINT DEFAULT 0;
    ALTER TABLE access_request ADD COLUMN IF NOT EXISTS decision            TEXT;
  `);
  _requestSchemaEnsured = true;
}

router.get('/plans', async (_req, res, next) => {
  try {
    const { rows } = await q('SELECT * FROM plan ORDER BY sort_order');
    res.json({ plans: rows });
  } catch (e) { next(e); }
});

function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || ''); }

// --- Étape 1 : dépôt du formulaire IMF ------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    await ensureRequestSchema();
    const required = ['lastname','firstname','position','country_code','imf_type',
      'capital_cents','bceao_agreement_no','rccm','ifu','whatsapp','phone_main','city','email','admin_name','imf_name'];
    // On renvoie TOUS les champs manquants (et pas seulement le premier) : le
    // formulaire peut ainsi les signaler d'un coup au lieu d'obliger l'utilisateur
    // à renvoyer autant de fois qu'il manque de champs.
    const missing = required.filter(f => b[f] === undefined || b[f] === null || b[f] === '');
    if (missing.length)
      return res.status(422).json({ error: 'missing_field', field: missing[0], missing });
    if (!UEMOA_CODES.includes(b.country_code)) return res.status(422).json({ error: 'country_not_uemoa' });
    if (!['SA','SCOOP'].includes(b.imf_type)) return res.status(422).json({ error: 'invalid_imf_type' });
    if (!validEmail(b.email)) return res.status(422).json({ error: 'invalid_email' });

    // --- Anti-doublon : une seule demande d'accès par IMF -------------------
    // On refuse une 2e demande pour la même IMF, identifiée par son numéro
    // d'agrément BCEAO OU par l'e-mail déjà enregistré. Une demande précédemment
    // REJETÉE n'empêche pas de retenter (decision = 'rejected' exclue).
    const dup = await q(
      `SELECT i.code_imf
         FROM imf i
         JOIN access_request ar ON ar.imf_id = i.id
        WHERE (lower(i.email) = lower($1) OR i.bceao_agreement_no = $2)
          AND (ar.decision IS DISTINCT FROM 'rejected')
        LIMIT 1`,
      [b.email, b.bceao_agreement_no]);
    if (dup.rows.length)
      return res.status(409).json({ error: 'duplicate_request',
        message: 'Une demande d’accès existe déjà pour cette IMF (numéro d’agrément BCEAO ou e-mail déjà enregistré). Contactez teeBo si vous pensez qu’il s’agit d’une erreur.' });

    const out = await tx(async (c) => {
      const code = (await c.query('SELECT fn_gen_imf_code($1) AS c', [b.country_code])).rows[0].c;
      const imf = (await c.query(
        `INSERT INTO imf(code_imf,name,type,country_code,city,capital_cents,
            bceao_agreement_no,phone_main,whatsapp,email,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING id, code_imf`,
        [code, b.imf_name, b.imf_type, b.country_code, b.city, Number(b.capital_cents),
         b.bceao_agreement_no, b.whatsapp, b.phone_main, b.email]
      )).rows[0];
      const reqRow = (await c.query(
        `INSERT INTO access_request(imf_id,requester_lastname,requester_firstname,
            requester_position,admin_name)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [imf.id, b.lastname, b.firstname, b.position, b.admin_name]
      )).rows[0];
      // Répercussion automatique des informations saisies sur les PARAMÈTRES de
      // l'IMF (identité visuelle + mentions légales obligatoires) : elles seront
      // reprises telles quelles sur les factures et le relevé de compte, et
      // resteront modifiables par l'admin de l'IMF une fois son accès ouvert.
      await c.query(
        `INSERT INTO imf_branding(imf_id, legal_name, legal_form, bceao_agreement_no,
             trade_register_no, tax_id,
             share_capital_cents, legal_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (imf_id) DO UPDATE SET
             legal_name         = COALESCE(imf_branding.legal_name, EXCLUDED.legal_name),
             legal_form         = COALESCE(imf_branding.legal_form, EXCLUDED.legal_form),
             bceao_agreement_no = COALESCE(imf_branding.bceao_agreement_no, EXCLUDED.bceao_agreement_no),
             trade_register_no  = COALESCE(imf_branding.trade_register_no, EXCLUDED.trade_register_no),
             tax_id             = COALESCE(imf_branding.tax_id, EXCLUDED.tax_id),
             share_capital_cents= COALESCE(imf_branding.share_capital_cents, EXCLUDED.share_capital_cents),
             legal_address      = COALESCE(imf_branding.legal_address, EXCLUDED.legal_address),
             updated_at         = now()`,
        [imf.id, b.imf_name, b.imf_type, b.bceao_agreement_no,
         String(b.rccm).trim(), String(b.ifu).trim(),
         Number(b.capital_cents) || 0,
         [b.city, b.country_code].filter(Boolean).join(', ')]);
      return { imf, requestId: reqRow.id };
    });
    res.json({ ok: true, imf_code: out.imf.code_imf, imf_id: out.imf.id, request_id: out.requestId });
  } catch (e) {
    // On nomme la vraie cause (code PostgreSQL compréhensible) au lieu de laisser
    // remonter un « server_error » muet que le formulaire traduisait par
    // « Une erreur est survenue ». Aucune donnée sensible n'est exposée.
    const pg = e && e.code ? String(e.code) : '';
    const detail = {
      '23502': 'missing_column_value',   // une colonne NOT NULL non renseignée
      '23503': 'invalid_reference',      // clé étrangère introuvable
      '23505': 'duplicate_code',         // doublon de code IMF
      '23514': 'check_violation',        // contrainte de contrôle
      '22P02': 'invalid_input_syntax',   // valeur mal typée
      '42703': 'missing_column',         // colonne absente du schéma
      '42P01': 'missing_table',          // table absente du schéma
      '42P02': 'missing_type'            // type enum absente
    }[pg];
    if (detail) {
      const diag = { error: detail };
      const msg = {
        missing_column_value: 'Une information obligatoire n’a pas pu être enregistrée. Vérifiez tous les champs du formulaire.',
        invalid_reference: 'Référence interne invalide lors de l’enregistrement. Contactez teeBo.',
        duplicate_code: 'Ce code d’IMF existe déjà. Réessayez dans un instant.',
        check_violation: 'Une valeur saisie ne respecte pas le format attendu. Vérifiez le RCCM, l’IFU et le capital.',
        invalid_input_syntax: 'Le format d’une valeur saisie est invalide. Vérifiez les numéros et le capital.',
        missing_column: 'Le serveur n’est pas à jour (colonne manquante en base). Déployez la version corrigée.',
        missing_table: 'Le serveur n’est pas à jour (table manquante en base). Déployez la version corrigée.',
        missing_type: 'Le serveur n’est pas à jour (type manquant en base). Déployez la version corrigée.'
      }[detail];
      if (msg) diag.message = msg;
      if (pg) diag.pg = pg;
      return res.status(422).json(diag);
    }
    next(e);
  }
});

// --- Étape 2 : choix de la formule -> facture proforma ---------------------
router.post('/:id/select-plan', async (req, res, next) => {
  try {
    const { plan_code, billing_cycle } = req.body || {};
    const billing = BILLING_CYCLES.includes(billing_cycle) ? billing_cycle : 'mensuel';
    const plan = (await q('SELECT * FROM plan WHERE code=$1', [plan_code])).rows[0];
    if (!plan) return res.status(404).json({ error: 'plan_not_found' });
    const pr = computePricing(plan.price_cents, billing);
    const proformaNo = 'PRO-' + new Date().getFullYear() + '-' +
      Math.floor(100000 + Math.random() * 900000);
    const { rows } = await q(
      `UPDATE access_request SET plan_code=$1, billing_cycle=$2, licence_cents=$3,
          subscription_cents=$4, discount_cents=$5, proforma_no=$6,
          proforma_amount_cents=$7, proforma_validated=false
       WHERE id=$8 RETURNING *`,
      [plan.code, pr.billing, pr.licenceCents, pr.subscriptionCents, pr.discountCents,
       proformaNo, pr.totalCents, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'request_not_found' });
    const r = rows[0];
    const imf = (await q('SELECT * FROM imf WHERE id=$1', [r.imf_id])).rows[0];
    res.json({ ok: true, proforma: {
      no: proformaNo, plan: plan.label, plan_code: plan.code,
      billing_cycle: pr.billing, period_label: pr.periodLabel,
      licence_cents: pr.licenceCents,
      subscription_cents: pr.subscriptionCents,
      gross_subscription_cents: pr.grossSubscriptionCents,
      savings_cents: pr.savingsCents,
      discount_cents: pr.discountCents,
      subtotal_cents: pr.subtotalCents,
      amount_cents: pr.totalCents,
      monthly_cents: plan.price_cents,
      trial_days: 30,
      imf_name: imf ? imf.name : null,
      date: new Date().toISOString(),
      url: `/api/v1/requests/${r.id}/proforma.pdf`
    }});
  } catch (e) { next(e); }
});

// --- Facture PROFORMA imprimable (PDF via HTML) ----------------------------
// Numéro de proforma : PRO-AAAA-XXXXXX. Visible par le prospect au moment du
// choix de la formule, puis validée pour transmission à teebo.
router.get('/:id/proforma.pdf', async (req, res, next) => {
  try {
    const r = (await q('SELECT * FROM access_request WHERE id=$1', [req.params.id])).rows[0];
    if (!r || !r.proforma_no) return res.status(404).json({ error: 'proforma_not_found' });
    const imf = (await q('SELECT * FROM imf WHERE id=$1', [r.imf_id])).rows[0];
    const header = await getBranding(r.imf_id);
    const plan = (await q('SELECT * FROM plan WHERE code=$1', [r.plan_code])).rows[0];
    // Reconstitution du détail : licence + abonnement (+ remise si cycle annuel).
    // Coercition NUMÉRIQUE : node-postgres renvoie les BIGINT en CHAÎNES, une
    // addition sans Number() concaténerait les montants.
    const licenceCents = Math.round(Number(r.licence_cents != null ? r.licence_cents : LICENCE_CENTS)) || 0;
    const subscriptionCents = Math.round(Number(r.subscription_cents != null
      ? r.subscription_cents : (plan ? plan.price_cents : 0))) || 0;
    const discountCents = Math.round(Number(r.discount_cents || 0)) || 0;
    const subtotalCents = licenceCents + subscriptionCents;
    const totalCents = r.proforma_amount_cents != null
      ? Math.round(Number(r.proforma_amount_cents)) : (subtotalCents - discountCents);
    const lines = buildInvoiceLines({
      planLabel: plan ? plan.label : (r.plan_code || ''),
      billing: r.billing_cycle, licenceCents, subscriptionCents });
    const html = renderInvoice({
      header,
      kind: 'proforma',
      invoiceNo: r.proforma_no,
      issuedAt: r.created_at || new Date(),
      periodLabel: r.billing_cycle === 'annuel' ? '12 mois (annuel)' : '1 mois (mensuel)',
      lines,
      subtotalCents,
      discountCents,
      totalCents,
      currency: 'XOF',
      status: r.proforma_validated ? 'emise' : null,
      clientName: imf ? imf.name : (header.legal_name || 'IMF'),
      clientCode: header.imf.email || '',
      notes: TRIAL_BILLING_NOTE
    });
    setDocumentCsp(res);
    res.type('html').send(html);
  } catch (e) { next(e); }
});

// --- Facture DÉFINITIVE publique (tokenisée) -------------------------------
// Permet à l'IMF d'ouvrir le lien de facture reçu par WhatsApp / e-mail, sans
// être connecté à la console teebo. L'accès est protégé par un jeton HMAC
// (?t=...) : seul le détenteur du lien transmis par teebo peut l'ouvrir.
router.get('/invoices/:id.pdf', async (req, res, next) => {
  try {
    if (!verifyDocToken(req.params.id, req.query.t))
      return res.status(403).json({ error: 'invalid_token' });
    const inv = (await q('SELECT * FROM invoice WHERE id=$1', [req.params.id])).rows[0];
    if (!inv) return res.status(404).json({ error: 'invoice_not_found' });
    const header = await getBranding(inv.imf_id);
    const imf = (await q('SELECT name, email FROM imf WHERE id=$1', [inv.imf_id])).rows[0] || {};
    const ar = inv.request_id
      ? (await q('SELECT billing_cycle, licence_cents, subscription_cents FROM access_request WHERE id=$1', [inv.request_id])).rows[0]
      : null;
    const planLabel = (inv.plan_label || inv.plan_code || '').replace(/^Abonnement teeBo — /, '');
    const lines = (ar && (ar.licence_cents != null || ar.subscription_cents != null))
      ? buildInvoiceLines({ planLabel, billing: ar.billing_cycle,
          licenceCents: ar.licence_cents, subscriptionCents: ar.subscription_cents })
      : null;
    const html = renderInvoice({
      header, kind: 'definitive', invoiceNo: inv.invoice_no,
      issuedAt: inv.issued_at, dueAt: inv.due_at,
      periodLabel: inv.period_label || (ar && ar.billing_cycle === 'annuel' ? '12 mois (annuel)' : (ar ? '1 mois (mensuel)' : null)),
      plan: inv.plan_label || inv.plan_code, lines,
      subtotalCents: inv.subtotal_cents, discountCents: inv.discount_cents,
      vatRateBp: inv.vat_rate_bp, vatCents: inv.vat_cents,
      totalCents: inv.total_cents, currency: inv.currency,
      status: inv.status, amountPaidCents: inv.amount_paid_cents,
      clientName: imf.name || header.legal_name, clientCode: imf.email || '',
      notes: inv.notes
    });
    setDocumentCsp(res);
    res.type('html').send(html);
  } catch (e) { next(e); }
});

// --- Étape 3 : validation de la facture proforma ---------------------------
router.post('/:id/validate-proforma', async (req, res, next) => {
  try {
    const { rows } = await q(
      `UPDATE access_request SET proforma_validated=true, proforma_validated_at=now()
       WHERE id=$1 AND proforma_no IS NOT NULL RETURNING *`, [req.params.id]
    );
    if (!rows.length) return res.status(409).json({ error: 'no_proforma' });
    const r = rows[0];
    // teebo est notifié de la nouvelle demande à approuver.
    await notifyEmail(TEEBO_EMAIL, 'Nouvelle demande IMF à approuver',
      `Demande ${r.id} — proforma ${r.proforma_no} validée.`);
    await notifyWhatsApp(TEEBO_WHATSAPP, `teebo: nouvelle demande IMF validée (proforma ${r.proforma_no}).`);
    res.json({ ok: true, message: 'Demande transmise à teebo pour approbation.' });
  } catch (e) { next(e); }
});

export default router;
