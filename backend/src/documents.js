import { q } from './db.js';
import {
  ID_DOC_TYPES, BIRTH_CERT_STATUSES, PROOF_STATUSES, HOME_PROOF_TYPES,
  ACTIVITY_PROOF_TYPES, INCOME_BY_PROFESSION, BENEFICIARY_RELATIONS,
} from './client_documents.js';

/**
 * teebo — Documents officiels de l'IMF
 * ---------------------------------------------------------------------------
 * Rend le relevé de compte, la facture proforma et la facture définitive en
 * HTML prêt à imprimer (le navigateur produit le PDF), en respectant :
 *   - l'identité visuelle de l'IMF (logo téléversé + couleurs teebo) ;
 *   - les mentions légales OBLIGATOIRES (raison sociale, forme juridique,
 *     RCCM, IFU/NIF, n° d'agrément BCEAO, capital social, adresse du siège) ;
 *   - le fournisseur de la solution : Teebo Inclusive Finance Africa.
 *
 * Aucune donnée personnalisée n'est figée dans le code : tout provient de la
 * base (imf_branding + imf). La TVA reste CONFIGURABLE par tenant (taux fourni
 * par l'appelant) — aucun taux par défaut n'est imposé.
 */

export const TEEBO_SUPPLIER = {
  name: 'Teebo Inclusive Finance Africa',
  address: 'Secteur 51, Ouaga 2000 — Parcelle 10, Lot 26, Section TY',
  address2: '11 BP 74 Ouagadougou 11 — Burkina Faso',
  tel: '+226 50 32 14 32',
  email: 'hello@teebo.africa',
  // Mentions légales de l'émetteur teebo — à renseigner via variables
  // d'environnement (ne JAMAIS inventer). Affichées « — » tant que vides.
  legal_form: process.env.TEEBO_LEGAL_FORM || '',
  rccm: process.env.TEEBO_RCCM || '',
  ifu: process.env.TEEBO_IFU || '',
  vat: process.env.TEEBO_VAT || '',
  capital: process.env.TEEBO_CAPITAL || ''
};

export const CURRENCY_LABEL = { XOF: 'FCFA', XAF: 'FCFA' };

/**
 * CSP dédiée aux DOCUMENTS imprimables (relevé, factures, aperçu).
 * ---------------------------------------------------------------------------
 * Ces pages sont des documents HTML autonomes : leurs styles sont en ligne
 * (<style> dans le <head>) pour rester imprimables sans dépendance externe.
 * La CSP globale de l'application interdit le style en ligne ; on la relâche
 * donc UNIQUEMENT pour ces réponses (style-src 'unsafe-inline'), sans jamais
 * autoriser de script en ligne (script-src reste 'self'). `allowFrame` permet
 * à l'espace IMF d'intégrer l'aperçu dans une iframe de même origine.
 */
export function setDocumentCsp(res, { allowFrame = false } = {}) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    'frame-ancestors ' + (allowFrame ? "'self'" : "'none'")
  ].join('; '));
  res.setHeader('X-Frame-Options', allowFrame ? 'SAMEORIGIN' : 'DENY');
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Montant en cents XOF -> « 1 234 567 FCFA » (entiers, séparateur français). */
export function moneyFcfa(cents, currency = 'XOF') {
  const v = Math.round(Number(cents || 0)) / 100;
  const label = CURRENCY_LABEL[currency] || currency;
  return v.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' ' + label;
}

export function fmtDate(d) {
  if (!d) return '—';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDateTime(d) {
  if (!d) return '—';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Charge l'identité visuelle + les mentions légales de l'IMF, en complétant
 * avec la fiche `imf` lorsque le branding est encore vide (première utilisation).
 */
export async function getBranding(imfId) {
  const imf = (await q(
    `SELECT id, code_imf, name, type, country_code, city, capital_cents,
            bceao_agreement_no, phone_main, whatsapp, email
       FROM imf WHERE id=$1`, [imfId])).rows[0];
  const b = (await q('SELECT * FROM imf_branding WHERE imf_id=$1', [imfId])).rows[0] || {};
  return {
    imf: imf || {},
    branding: b,
    // Valeurs effectives : branding prioritaire, repli sur la fiche imf.
    legal_name: b.legal_name || (imf && imf.name) || '',
    legal_form: b.legal_form || (imf && imf.type) || '',
    trade_register_no: b.trade_register_no || '',
    tax_id: b.tax_id || '',
    bceao_agreement_no: b.bceao_agreement_no || (imf && imf.bceao_agreement_no) || '',
    vat_number: b.vat_number || '',
    share_capital_cents: (b.share_capital_cents != null ? b.share_capital_cents : (imf ? imf.capital_cents : null)),
    legal_address: b.legal_address || (imf ? [imf.city, imf.country_code].filter(Boolean).join(', ') : ''),
    bank_details: b.bank_details || '',
    footer_note: b.footer_note || '',
    logo_data_url: b.logo_data_url || null,
    // Canaux d'envoi des codes d'accès : branding prioritaire, repli sur la fiche imf.
    notify_whatsapp: b.notify_whatsapp || (imf && imf.whatsapp) || '',
    notify_email: b.notify_email || (imf && imf.email) || ''
  };
}

/** Feuille de style commune aux documents imprimables (imprimable A4). */
function docStyles(embed = false) {
  return `
  :root{--navy:#0b0c26;--neon:#d8f500;--muted:#61647c;--line:#e3e5ee;--soft:#f6f7fb}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;color:#0b0c26;background:${embed ? 'transparent' : '#eef0f6'};padding:${embed ? '0' : '24px'};-webkit-font-smoothing:antialiased}
  .sheet{max-width:820px;margin:0 auto;background:#fff;${embed ? '' : 'border-radius:10px;overflow:hidden;box-shadow:0 12px 40px rgba(11,12,38,.12);'}}
  .doc{padding:${embed ? '30px 34px 24px' : '38px 42px 30px'}}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:20px;border-bottom:3px solid var(--navy)}
  .org{display:flex;gap:14px;align-items:center}
  .logo{width:66px;height:66px;object-fit:contain;border-radius:10px}
  .logo--teebo{width:168px;height:auto;max-height:56px;object-fit:contain;display:block}
  .logo--ph{width:66px;height:66px;border-radius:10px;background:var(--navy);color:var(--neon);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px}
  .org h1{font-size:19px;letter-spacing:-.4px;line-height:1.2}
  .org .meta{font-size:12px;color:var(--muted);margin-top:3px;line-height:1.5}
  .org .meta b{color:#0b0c26}
  .supplier{text-align:right;font-size:11.5px;color:var(--muted);line-height:1.55;max-width:250px}
  .supplier b{color:#0b0c26;font-size:12.5px;display:block;margin-bottom:2px}
  .title{margin:22px 0 6px;font-size:17px;letter-spacing:-.3px;text-transform:uppercase}
  .title small{display:block;font-size:12px;color:var(--muted);text-transform:none;letter-spacing:0;margin-top:4px;font-weight:400}
  .docmeta{display:grid;grid-template-columns:1fr 1fr;gap:6px 30px;font-size:12.5px;margin:14px 0 18px}
  .docmeta div{display:flex;justify-content:space-between;border-bottom:1px dotted var(--line);padding:5px 0}
  .docmeta span{color:var(--muted)}
  .docmeta b{text-align:right}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{background:var(--navy);color:#fff;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;text-align:left;padding:10px 12px}
  th.r,td.r{text-align:right}
  td{padding:10px 12px;border-bottom:1px solid var(--line);font-size:13px}
  tr:nth-child(even) td{background:var(--soft)}
  .totals{margin-top:14px;margin-left:auto;width:min(340px,100%);font-size:13.5px}
  .totals div{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)}
  .totals .gt{border-top:2px solid var(--navy);border-bottom:0;margin-top:6px;padding-top:11px;font-size:16px;font-weight:800}
  .legal{margin-top:26px;padding:14px 16px;background:var(--soft);border:1px solid var(--line);border-radius:9px;font-size:11.5px;color:#3c3f57;line-height:1.65}
  .legal h4{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:6px}
  .legal .grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 22px}
  .legal .pcols{display:grid;grid-template-columns:1fr 1fr;gap:10px 26px}
  .legal .pcols>div>div{padding:3px 0;border-bottom:1px dotted var(--line);display:flex;justify-content:space-between;gap:10px}
  .legal .pcols h4{margin:0 0 6px}
  .sign{margin-top:22px;font-size:12px;color:var(--muted);line-height:1.6}
  .foot{margin-top:24px;padding-top:14px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap}
  .badge{display:inline-block;background:#eef7d6;color:#3d5c00;border:1px solid #d5e9a8;border-radius:999px;font-size:11px;font-weight:700;padding:3px 10px}
  .badge--warn{background:#fff7d6;color:#8a6d00;border-color:#f0e2a0}
  .actions{max-width:820px;margin:0 auto 16px;display:flex;gap:10px;justify-content:flex-end}
  .actions button,.actions a{font-family:inherit;font-size:13.5px;font-weight:700;border-radius:10px;padding:11px 18px;cursor:pointer;border:none;text-decoration:none;display:inline-block}
  .actions .print{background:#0b0c26;color:#fff}
  .actions .close{background:#fff;color:#0b0c26;border:1px solid #d4d6e2}
  @media print{
    body{background:#fff;padding:0}
    .sheet{box-shadow:none;border-radius:0;max-width:none}
    .actions{display:none}
    @page{size:A4;margin:12mm}
  }`;
}

/* Entête réservé aux FACTURES teebo : logo officiel teeBo seul + identité du
   prestataire (émetteur). Aucune coordonnée ni adresse de l'IMF n'y figure :
   la facture est émise PAR teeBo, l'IMF n'apparaît qu'en tant que client. */
function docHeadInvoice() {
  const s = TEEBO_SUPPLIER;
  return `<div class="head">
    <div class="org"><img class="logo--teebo" src="/assets/teebo-logo.png" alt="teeBo"></div>
    <div class="supplier">
      <b>${esc(s.name)}</b>
      ${esc(s.address)}<br>${esc(s.address2)}<br>
      Tél. ${esc(s.tel)} · ${esc(s.email)}
    </div>
  </div>`;
}

/* Mentions légales des DEUX parties sur les factures : le CLIENT (l'IMF) et
   l'ÉMETTEUR (teebo). Toutes les mentions obligatoires OHADA/UEMOA figurent
   côte à côte (raison sociale, forme juridique, RCCM, IFU/NIF, agrément
   BCEAO, capital social, siège). Les identifiants teebo proviennent de
   variables d'environnement — affichés « — » tant qu'ils ne sont pas fournis. */
function docLegalParties(header) {
  const b = header;
  const s = TEEBO_SUPPLIER;
  const client = [
    ['Raison sociale', b.legal_name || b.imf.name || ''],
    ['Forme juridique', b.legal_form || '—'],
    ['RCCM', b.trade_register_no || '—'],
    ['IFU / NIF', b.tax_id || '—'],
    ['N° contribuable / TVA', b.vat_number || '—'],
    ['Agrément BCEAO', b.bceao_agreement_no || '—'],
    ['Capital social', b.share_capital_cents != null ? moneyFcfa(b.share_capital_cents) : '—'],
    ['Siège social', b.legal_address || '—']
  ];
  const supplier = [
    ['Dénomination', s.name],
    ['Forme / régime', s.legal_form || '—'],
    ['RCCM', s.rccm || '—'],
    ['IFU / NIF', s.ifu || '—'],
    ['N° contribuable / TVA', s.vat || '—'],
    ['Capital social', s.capital || '—'],
    ['Siège social', s.address + ' · ' + s.address2],
    ['Contact', s.tel + ' · ' + s.email]
  ];
  const col = (title, rows) =>
    `<div><h4>${esc(title)}</h4>` +
    rows.map((r) => `<div><span>${esc(r[0])}</span><b>${esc(r[1] || '—')}</b></div>`).join('') +
    `</div>`;
  const bank = b.bank_details
    ? `<div style="margin-top:10px"><h4>Coordonnées bancaires de règlement</h4>${esc(b.bank_details)}</div>` : '';
  return `<div class="legal">
    <h4>Mentions légales obligatoires</h4>
    <div class="pcols">
      ${col('Client — l\'IMF', client)}
      ${col('Émetteur — ' + s.name, supplier)}
    </div>
    ${bank}
  </div>`;
}

/* Mentions légales de l'ÉMETTEUR (teeBo) pour les factures : on n'affiche plus
   les mentions de l'IMF (plus aucune adresse IMF sur la facture). */
function docLegalTeebo() {
  const s = TEEBO_SUPPLIER;
  const rows = [
    ['Prestataire', s.name],
    ['Adresse du siège', s.address + ' · ' + s.address2],
    ['Téléphone', s.tel],
    ['E-mail', s.email]
  ];
  return `<div class="legal">
    <h4>Émetteur de la facture</h4>
    <div class="grid">${rows.map((r) => `<div><b>${esc(r[0])} :</b> ${esc(r[1] || '—')}</div>`).join('')}</div>
  </div>`;
}

function docHead(header, logoAlt) {
  const b = header;
  const logo = b.logo_data_url
    ? `<img class="logo" src="${esc(b.logo_data_url)}" alt="${esc(logoAlt)}">`
    : `<div class="logo--ph">${esc((b.legal_name || b.imf.name || 'IMF').slice(0, 2).toUpperCase())}</div>`;
  const lines = [
    b.legal_form ? esc(b.legal_form) : '',
    b.bceao_agreement_no ? 'Agrément BCEAO : ' + esc(b.bceao_agreement_no) : '',
    b.legal_address ? esc(b.legal_address) : ''
  ].filter(Boolean).join(' · ');
  return `<div class="head">
    <div class="org">${logo}<div>
      <h1>${esc(b.legal_name || b.imf.name || '')}</h1>
      <div class="meta">${esc(b.imf.code_imf || '')}${lines ? ' — ' + lines : ''}</div>
      <div class="meta">${b.imf.phone_main ? 'Tél. ' + esc(b.imf.phone_main) : ''}${b.imf.email ? ' · ' + esc(b.imf.email) : ''}</div>
    </div></div>
    <div class="supplier">
      <b>${esc(TEEBO_SUPPLIER.name)}</b>
      ${esc(TEEBO_SUPPLIER.address)}<br>${esc(TEEBO_SUPPLIER.address2)}<br>
      Tél. ${esc(TEEBO_SUPPLIER.tel)} · ${esc(TEEBO_SUPPLIER.email)}
    </div>
  </div>`;
}

/** Bloc des mentions légales obligatoires (documents officiels). */
function docLegal(header) {
  const b = header;
  const rows = [
    ['Raison sociale', b.legal_name || b.imf.name || ''],
    ['Forme juridique', b.legal_form || '—'],
    ['RCCM', b.trade_register_no || '—'],
    ['IFU / NIF', b.tax_id || '—'],
    ['N° contribuable / TVA', b.vat_number || '—'],
    ['Agrément BCEAO', b.bceao_agreement_no || '—'],
    ['Capital social', b.share_capital_cents != null ? moneyFcfa(b.share_capital_cents) : '—'],
    ['Siège social', b.legal_address || '—']
  ];
  const bank = b.bank_details
    ? `<div style="margin-top:8px"><h4>Coordonnées bancaires de règlement</h4>${esc(b.bank_details)}</div>` : '';
  return `<div class="legal">
    <h4>Mentions légales obligatoires</h4>
    <div class="grid">${rows.map((r) => `<div><b>${esc(r[0])} :</b> ${esc(r[1] || '—')}</div>`).join('')}</div>
    ${bank}
  </div>`;
}

function docFoot(header, extra) {
  const b = header;
  return `<div class="foot">
    <div>${esc(b.legal_name || b.imf.name || '')} · ${esc(b.imf.code_imf || '')}</div>
    <div>${esc(b.footer_note || (extra || 'Document généré par teebo'))}</div>
  </div>`;
}

/** Enveloppe HTML complète + bouton d'impression (sans gestionnaire inline). */
function wrap(title, inner, autoPrint = false) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><style>${docStyles()}</style></head><body>
  <div class="actions">
    <button class="print" id="btn-print" type="button">Imprimer / Enregistrer en PDF</button>
    <button class="close" id="btn-close" type="button">Fermer</button>
  </div>
  <div class="sheet"><div class="doc">${inner}</div></div>
  <script src="/assets/doc-print.js"></script>
  </body></html>`;
}

/* Variante destinée à la PRÉVISUALISATION INTÉGRÉE (iframe de l'espace IMF) :
   - aucun bouton : l'aperçu est piloté par la page hôte ;
   - styles adaptés pour s'intégrer sans ombre ni marge externe. */
function wrapEmbed(title, inner) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><style>${docStyles(true)}</style></head><body>
  <div class="sheet"><div class="doc">${inner}</div></div>
  </body></html>`;
}

/* ============================ RELEVÉ DE COMPTE =========================== */
export function renderStatement({ header, client, account, operations, generatedAt, generatedBy }) {
  const cur = (account && account.currency) || 'XOF';
  const rows = (operations || []).map((o) => {
    const dir = (o.direction === 'credit' || Number(o.signed_cents) > 0) ? 'credit' : (o.direction === 'debit' ? 'debit' : null);
    const label = o.label || o.kind || '';
    const amt = o.amount_cents != null ? o.amount_cents : 0;
    const cls = dir === 'credit' ? 'r' : (dir === 'debit' ? 'r' : 'r');
    const sign = dir === 'credit' ? '+' : (dir === 'debit' ? '−' : '');
    return `<tr><td>${esc(fmtDate(o.created_at || o.date))}</td><td>${esc(label)}</td>
      <td>${esc(o.reference || o.code_receipt || '—')}</td>
      <td class="${cls}">${sign}${esc(moneyFcfa(amt, cur))}</td>
      <td>${esc(o.status || '')}</td></tr>`;
  }).join('');

  const body = `
  ${docHead(header, 'Logo ' + (header.legal_name || ''))}
  <div class="title">Relevé de compte
    <small>Édité le ${esc(fmtDateTime(generatedAt))}${generatedBy ? ' par ' + esc(generatedBy) : ''}</small>
  </div>
  <div class="docmeta">
    <div><span>Titulaire</span><b>${esc(client.full_name)}</b></div>
    <div><span>Code client</span><b>${esc(client.code_client)}</b></div>
    <div><span>N° de compte</span><b>${esc((account && account.code_account) || '—')}</b></div>
    <div><span>Devise</span><b>${esc(cur)}</b></div>
    <div><span>Téléphone</span><b>${esc(client.phone || '—')}</b></div>
    <div><span>Solde actuel</span><b>${account ? esc(moneyFcfa(account.balance_cents, cur)) : '—'}</b></div>
  </div>
  <table>
    <thead><tr><th>Date</th><th>Opération</th><th>Référence</th><th class="r">Montant</th><th>Statut</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#61647c">Aucune opération enregistrée sur la période.</td></tr>'}</tbody>
  </table>
  <div class="totals">
    <div><span>Nombre d\'opérations</span><b>${(operations || []).length}</b></div>
    <div class="gt"><span>Solde au ${esc(fmtDate(generatedAt))}</span><b>${account ? esc(moneyFcfa(account.balance_cents, cur)) : '—'}</b></div>
  </div>
  ${docLegal(header)}
  <div class="sign">Ce relevé est délivré pour information et ne vaut pas reconnaissance de dette. Toute contestation doit être présentée dans les 15 jours à compter de la date d\'édition.</div>
  ${docFoot(header, 'Relevé de compte généré par teebo')}`;

  return wrap('Relevé de compte — ' + (client.full_name || ''), body);
}

/* ============================== FICHE CLIENT ============================ */
// Libellé d'un code dans une liste { code, label }.
function lbl(list, code) { const o = (list || []).find((x) => x.code === code); return o ? o.label : (code || '—'); }

const PROFESSION_LABEL = {
  salarie: 'Salarié', retraite: 'Retraité', informel: 'Activité informelle', etudiant: 'Étudiant',
};

/**
 * FICHE CLIENT complète (particulier) imprimable / exportable en PDF, destinée
 * à la signature du client et de l'utilisateur. Incruste les signatures
 * numériques déjà capturées (stylet) ou présente des cadres à signer à la main.
 */
export function renderClientFiche({ header, client, account, signatures, conformity, generatedAt, generatedBy }) {
  const c = client || {};
  const sigOf = (role) => (signatures || []).find((s) => s.role === role) || null;
  const prof = c.profession || null;
  const spec = prof ? INCOME_BY_PROFESSION[prof] : null;
  const incomeTypes = spec && spec.types ? spec.types : [];

  const row = (label, value) => `<div><span>${esc(label)}</span><b>${esc(value == null || value === '' ? '—' : value)}</b></div>`;
  const yn = (v) => (v === true || v === 't' || v === 'true') ? 'Oui' : 'Non';

  const identite = [
    row('Code client', c.code_client),
    row('Nom', c.last_name || c.full_name),
    row('Prénom', c.first_name),
    row('Téléphone', c.phone),
    row('Date de naissance', fmtDate(c.birth_date)),
    row('Lieu de naissance', c.birth_place),
  ].join('');

  const piece = [
    row('Document d’identité', lbl(ID_DOC_TYPES, c.id_doc_type)),
    row('Document physique reçu', yn(c.id_doc_received)),
    row('N° de la pièce', c.id_doc_number),
    row('Date d’établissement', fmtDate(c.id_doc_issue_date)),
    row('Date d’expiration (calculée)', fmtDate(c.id_doc_expiry_date)),
    row('Acte de naissance', lbl(BIRTH_CERT_STATUSES, c.birth_cert_status)),
  ].join('');

  const ayant = [
    row('Nom de l’ayant droit', c.beneficiary_last_name),
    row('Prénom de l’ayant droit', c.beneficiary_first_name),
    row('Lien', lbl(BENEFICIARY_RELATIONS, c.beneficiary_relation)),
  ].join('');

  const loc = [
    row('Plan de localisation — domicile', c.home_location_desc),
    row('Justificatif de domicile', lbl(PROOF_STATUSES, c.home_proof_status)
      + (c.home_proof_type ? ' — ' + lbl(HOME_PROOF_TYPES, c.home_proof_type) : '')),
    row('Plan de localisation — activité', c.activity_location_desc),
    row('Justificatif d’activité', lbl(PROOF_STATUSES, c.activity_proof_status)
      + (c.activity_proof_type ? ' — ' + lbl(ACTIVITY_PROOF_TYPES, c.activity_proof_type) : '')),
  ].join('');

  const revenuRows = [row('Profession', PROFESSION_LABEL[prof] || prof)];
  if (prof === 'salarie' || prof === 'retraite') revenuRows.push(row('Domiciliation du salaire / de la pension', yn(c.salary_domiciliation)));
  if (c.activity_description) revenuRows.push(row('Description de l’activité', c.activity_description));
  if (c.school_name) revenuRows.push(row('École / université', c.school_name));
  if (c.income_proof_status) revenuRows.push(row('Justificatif de revenu',
    lbl(PROOF_STATUSES, c.income_proof_status) + (c.income_proof_type ? ' — ' + lbl(incomeTypes, c.income_proof_type) : '')));
  const revenu = revenuRows.join('');

  const conf = (conformity || []);
  const confLine = conf.length
    ? `<div class="sign">Conformité des pièces : ${esc(c.conformity_status === 'conforme' ? 'CONFORME' : (c.conformity_status === 'non_conforme' ? 'NON CONFORME' : 'EN ATTENTE'))}`
      + (conf.some((x) => x.is_conform === false || x.is_conform === 'f')
         ? ' — à corriger : ' + esc(conf.filter((x) => x.is_conform === false || x.is_conform === 'f').map((x) => x.field_label).join(', '))
         : '') + '</div>'
    : '';

  const sigBox = (role, title) => {
    const s = sigOf(role);
    let inner;
    if (s && s.method === 'stylet' && s.image_data_url) {
      inner = `<img src="${esc(s.image_data_url)}" alt="signature" style="max-height:70px;max-width:100%">`;
    } else if (s && s.method === 'empreinte') {
      inner = `<div class="em">✓ Validé par empreinte digitale<br><small>${esc(fmtDateTime(s.captured_at))}</small></div>`;
    } else {
      inner = '<div class="em" style="color:#9a9db2">Signature manuscrite</div>';
    }
    return `<div class="sigb"><div class="sigt">${esc(title)}</div><div class="sigc">${inner}</div></div>`;
  };

  const body = `
  ${docHead(header, 'Logo ' + (header.legal_name || ''))}
  <div class="title">Fiche client — Particulier
    <small>Éditée le ${esc(fmtDateTime(generatedAt))}${generatedBy ? ' par ' + esc(generatedBy) : ''}</small>
  </div>
  <h4 style="margin:14px 0 4px">Identité</h4><div class="docmeta">${identite}</div>
  <h4 style="margin:14px 0 4px">Pièce d’identité</h4><div class="docmeta">${piece}</div>
  <h4 style="margin:14px 0 4px">Ayant droit</h4><div class="docmeta">${ayant}</div>
  <h4 style="margin:14px 0 4px">Localisation</h4><div class="docmeta">${loc}</div>
  <h4 style="margin:14px 0 4px">Activité &amp; revenu</h4><div class="docmeta">${revenu}</div>
  <h4 style="margin:14px 0 4px">Compte</h4><div class="docmeta">${row('N° de compte', account && account.code_account)}${row('Devise', (account && account.currency) || 'XOF')}</div>
  ${confLine}
  <style>.sigs{display:flex;gap:18px;margin-top:22px}.sigb{flex:1}
  .sigt{font-size:12px;color:#5b6076;margin-bottom:4px}
  .sigc{border:1px solid #c7c9d6;border-radius:8px;height:92px;display:flex;align-items:center;justify-content:center;text-align:center;padding:6px}
  .sigc .em{font-size:12px}</style>
  <div class="sigs">${sigBox('client', 'Signature du client')}${sigBox('user', 'Signature de l’agent')}</div>
  <div class="sign">Je soussigné(e) certifie exactes les informations portées sur la présente fiche et reconnais avoir pris connaissance des conditions d’ouverture de compte.</div>
  ${docLegal(header)}
  ${docFoot(header, 'Fiche client générée par teebo')}`;

  return wrap('Fiche client — ' + (c.full_name || ''), body);
}

/* ============================== FACTURES ================================= */
export function renderInvoice({ header, kind = 'proforma', invoiceNo, issuedAt, dueAt, periodLabel,
  plan, lines, subtotalCents, discountCents = 0, vatRateBp = 0, vatCents = 0, totalCents,
  currency = 'XOF', status, amountPaidCents, clientName, clientCode, notes, embed = false }) {
  const cur = currency || 'XOF';
  const isFinal = kind === 'definitive';
  const title = isFinal ? 'Facture' : 'Facture proforma';
  const statusBadge = status ? `<span class="badge${status === 'payee' ? '' : ' badge--warn'}">${esc(statusLabel(status))}</span>` : '';

  // Coercition NUMÉRIQUE : node-postgres renvoie les colonnes BIGINT sous
  // forme de CHAÎNES. Une addition de chaînes devient une concaténation
  // ("25000000" + "90000000" => "2500000090000000"), ce qui corrompt les
  // totaux. On force donc tout en entier avant le moindre calcul.
  const num = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };
  const discountNum = num(discountCents);
  const vatNum = num(vatCents);
  const paidNum = num(amountPaidCents);

  const itemLines = (Array.isArray(lines) && lines.length)
    ? lines.map((l) => ({ label: l.label || '', amountCents: num(l.amountCents) }))
    : [{ label: plan || 'Abonnement teebo', amountCents: num(subtotalCents) }];
  const rowsHtml = itemLines.map((l) =>
    `<tr><td>${esc(l.label)}</td><td class="r">${esc(moneyFcfa(l.amountCents, cur))}</td></tr>`).join('');

  // Source de vérité : le sous-total HT est la SOMME numérique des lignes ;
  // le total est toujours recoupé (sous-total − remise + TVA). Ce recalcul
  // répare aussi l'affichage des factures dont le total stocké était erroné.
  const subtotalNum = itemLines.reduce((s, l) => s + l.amountCents, 0);
  const totalNum = Math.max(0, subtotalNum - discountNum + vatNum);

  const vatLine = vatRateBp
    ? `<div><span>TVA (${(Number(vatRateBp) / 100).toLocaleString('fr-FR')} %)</span><b>${esc(moneyFcfa(vatNum, cur))}</b></div>`
    : `<div><span>TVA</span><b>Non applicable</b></div>`;
  const discountLine = discountNum
    ? `<div><span>Remise</span><b>− ${esc(moneyFcfa(discountNum, cur))}</b></div>` : '';
  const paidLine = (isFinal && paidNum)
    ? `<div><span>Montant réglé</span><b>${esc(moneyFcfa(paidNum, cur))}</b></div>
       <div><span>Reste à payer</span><b>${esc(moneyFcfa(Math.max(0, totalNum - paidNum), cur))}</b></div>` : '';

  const body = `
  ${docHeadInvoice()}
  <div class="title">${title} n° ${esc(invoiceNo || '—')} ${statusBadge}
    <small>Émise le ${esc(fmtDate(issuedAt))}${dueAt ? ' · échéance le ' + esc(fmtDate(dueAt)) : ''}${periodLabel ? ' · période : ' + esc(periodLabel) : ''}</small>
  </div>
  <div class="docmeta">
    <div><span>Prestataire</span><b>${esc(TEEBO_SUPPLIER.name)}</b></div>
    <div><span>Client</span><b>${esc(clientName || header.legal_name || header.imf.name || '')}</b></div>
    <div><span>Institution (code IMF)</span><b>${esc(header.imf.code_imf || '')}</b></div>
    <div><span>Contact client</span><b>${esc(clientCode || header.imf.email || '')}</b></div>
    <div><span>Devise</span><b>${esc(cur)}</b></div>
    <div><span>Mode de facturation</span><b>${isFinal ? 'Définitive' : 'Proforma (non comptable)'}</b></div>
  </div>
  <table>
    <thead><tr><th>Désignation</th><th class="r">Montant HT</th></tr></thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
  <div class="totals">
    <div><span>Sous-total HT</span><b>${esc(moneyFcfa(subtotalNum, cur))}</b></div>
    ${discountLine}
    ${vatLine}
    <div class="gt"><span>Total à payer</span><b>${esc(moneyFcfa(totalNum, cur))}</b></div>
    ${paidLine}
  </div>
  ${notes ? `<div class="legal"><h4>Observations</h4>${esc(notes)}</div>` : ''}
  ${docLegalParties(header)}
  <div class="sign">
    ${isFinal
      ? `Facture émise par ${esc(TEEBO_SUPPLIER.name)} (prestataire de la solution teebo). Règlement par virement ou Mobile Money selon les coordonnées ci-dessus.`
      : `Document proforma non comptable, valable 30 jours à compter de sa date d\'émission. La facture définitive sera émise après approbation et règlement.`}
  </div>
  ${docFoot(header, (isFinal ? 'Facture définitive' : 'Facture proforma') + ' — teebo')}`;

  return embed ? wrapEmbed(title + ' n° ' + (invoiceNo || ''), body) : wrap(title + ' n° ' + (invoiceNo || ''), body);
}

function statusLabel(s) {
  return { emise: 'Émise', payee: 'Payée', annulee: 'Annulée' }[s] || s;
}
