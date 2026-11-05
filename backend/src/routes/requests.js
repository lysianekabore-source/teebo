import express from 'express';
import { q, tx } from '../db.js';
import { notifyWhatsApp, notifyEmail, TEEBO_WHATSAPP, TEEBO_EMAIL } from '../notify.js';
import { getBranding, renderInvoice, moneyFcfa, setDocumentCsp } from '../documents.js';

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
    const required = ['lastname','firstname','position','country_code','imf_type',
      'capital_cents','bceao_agreement_no','whatsapp','phone_main','city','email','admin_name','imf_name'];
    for (const f of required) if (b[f] === undefined || b[f] === null || b[f] === '')
      return res.status(422).json({ error: 'missing_field', field: f });
    if (!UEMOA_CODES.includes(b.country_code)) return res.status(422).json({ error: 'country_not_uemoa' });
    if (!['SA','SCOOP'].includes(b.imf_type)) return res.status(422).json({ error: 'invalid_imf_type' });
    if (!validEmail(b.email)) return res.status(422).json({ error: 'invalid_email' });

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
             share_capital_cents, legal_address)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (imf_id) DO UPDATE SET
             legal_name         = COALESCE(imf_branding.legal_name, EXCLUDED.legal_name),
             legal_form         = COALESCE(imf_branding.legal_form, EXCLUDED.legal_form),
             bceao_agreement_no = COALESCE(imf_branding.bceao_agreement_no, EXCLUDED.bceao_agreement_no),
             share_capital_cents= COALESCE(imf_branding.share_capital_cents, EXCLUDED.share_capital_cents),
             legal_address      = COALESCE(imf_branding.legal_address, EXCLUDED.legal_address),
             updated_at         = now()`,
        [imf.id, b.imf_name, b.imf_type, b.bceao_agreement_no, Number(b.capital_cents) || 0,
         [b.city, b.country_code].filter(Boolean).join(', ')]);
      return { imf, requestId: reqRow.id };
    });
    res.json({ ok: true, imf_code: out.imf.code_imf, imf_id: out.imf.id, request_id: out.requestId });
  } catch (e) { next(e); }
});

// --- Étape 2 : choix de la formule -> facture proforma ---------------------
router.post('/:id/select-plan', async (req, res, next) => {
  try {
    const { plan_code } = req.body || {};
    const plan = (await q('SELECT * FROM plan WHERE code=$1', [plan_code])).rows[0];
    if (!plan) return res.status(404).json({ error: 'plan_not_found' });
    const proformaNo = 'PRO-' + new Date().getFullYear() + '-' +
      Math.floor(100000 + Math.random() * 900000);
    const { rows } = await q(
      `UPDATE access_request SET plan_code=$1, proforma_no=$2, proforma_amount_cents=$3,
          proforma_validated=false WHERE id=$4 RETURNING *`,
      [plan.code, proformaNo, plan.price_cents, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'request_not_found' });
    const r = rows[0];
    const imf = (await q('SELECT * FROM imf WHERE id=$1', [r.imf_id])).rows[0];
    res.json({ ok: true, proforma: {
      no: proformaNo, plan: plan.label, plan_code: plan.code,
      amount_cents: plan.price_cents,
      billing_cycle: plan.billing_cycle, trial_days: 30,
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
    const amount = r.proforma_amount_cents || (plan ? plan.price_cents : 0);
    const html = renderInvoice({
      header,
      kind: 'proforma',
      invoiceNo: r.proforma_no,
      issuedAt: r.created_at || new Date(),
      plan: 'Abonnement teeBo — ' + (plan ? plan.label : (r.plan_code || '')),
      subtotalCents: amount,
      totalCents: amount,
      currency: 'XOF',
      status: r.proforma_validated ? 'emise' : null,
      clientName: imf ? imf.name : (header.legal_name || 'IMF'),
      clientCode: header.imf.email || ''
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
