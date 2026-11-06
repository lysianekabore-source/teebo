import { q } from './db.js';

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
  email: 'hello@teebo.africa'
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
    logo_data_url: b.logo_data_url || null
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

/* ============================== FACTURES ================================= */
export function renderInvoice({ header, kind = 'proforma', invoiceNo, issuedAt, dueAt, periodLabel,
  plan, lines, subtotalCents, discountCents = 0, vatRateBp = 0, vatCents = 0, totalCents,
  currency = 'XOF', status, amountPaidCents, clientName, clientCode, notes, embed = false }) {
  const cur = currency || 'XOF';
  const isFinal = kind === 'definitive';
  const title = isFinal ? 'Facture' : 'Facture proforma';
  const statusBadge = status ? `<span class="badge${status === 'payee' ? '' : ' badge--warn'}">${esc(statusLabel(status))}</span>` : '';

  const vatLine = vatRateBp
    ? `<div><span>TVA (${(Number(vatRateBp) / 100).toLocaleString('fr-FR')} %)</span><b>${esc(moneyFcfa(vatCents, cur))}</b></div>`
    : `<div><span>TVA</span><b>Non applicable</b></div>`;
  const discountLine = discountCents
    ? `<div><span>Remise</span><b>− ${esc(moneyFcfa(discountCents, cur))}</b></div>` : '';
  const paidLine = (isFinal && amountPaidCents)
    ? `<div><span>Montant réglé</span><b>${esc(moneyFcfa(amountPaidCents, cur))}</b></div>
       <div><span>Reste à payer</span><b>${esc(moneyFcfa(Math.max(0, Number(totalCents || 0) - Number(amountPaidCents || 0)), cur))}</b></div>` : '';

  const itemLines = (Array.isArray(lines) && lines.length)
    ? lines
    : [{ label: plan || 'Abonnement teebo', amountCents: subtotalCents }];
  const rowsHtml = itemLines.map((l) =>
    `<tr><td>${esc(l.label || '')}</td><td class="r">${esc(moneyFcfa(l.amountCents || 0, cur))}</td></tr>`).join('');

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
    <div><span>Sous-total HT</span><b>${esc(moneyFcfa(subtotalCents, cur))}</b></div>
    ${discountLine}
    ${vatLine}
    <div class="gt"><span>Total à payer</span><b>${esc(moneyFcfa(totalCents, cur))}</b></div>
    ${paidLine}
  </div>
  ${notes ? `<div class="legal"><h4>Observations</h4>${esc(notes)}</div>` : ''}
  ${docLegalTeebo()}
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
