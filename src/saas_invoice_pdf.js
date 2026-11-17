// =========================================================================
// teebo — MODÈLE DE FACTURE (document imprimable / PDF)
// =========================================================================
// Une facture présente OBLIGATOIREMENT la ventilation complète :
//   • Licence unique (une seule fois à vie)
//   • Abonnements par module, avec cycle, jours facturés sur jours du mois,
//     taux de remise annuel éventuel, et montant avant / après remise
//   • Ligne de remise pack complet en négatif
//   • Sous-total abonnements, total remises, total à payer, montant réglé
//
// Aucun montant n'est recalculé ici : les valeurs viennent de PostgreSQL
// (NUMERIC, lues en texte). On n'additionne RIEN en flottant.
// =========================================================================
import { q } from './db.js';
import { getBranding, moneyFcfa } from './documents.js';
import { dec, sum, toSql, formatFcfa } from './money.js';

const LABELS_LIGNE = {
  licence: 'Licence unique teebo (à vie)',
  abonnement: 'Abonnement module',
  remise: 'Remise'
};

const STATUTS = {
  facture: 'Payant',
  facture_prorata: 'Au prorata',
  facture_cycle_mixte: 'Bascule mensuel → annuel',
  essai_gratuit: 'Essai gratuit (0 FCFA)',
  deja_payee: 'Déjà réglée',
  remise_pack: 'Remise pack complet'
};

function dateFr(v) {
  if (!v) return '—';
  const s = String(v).slice(0, 10);
  const [a, m, j] = s.split('-');
  return j + '/' + m + '/' + a;
}

/** Charge une facture + ses lignes, en texte décimal (aucun flottant). */
export async function chargerFacture(invoiceId, imfId) {
  const inv = (await q(
    `SELECT i.*, i.fixed_cost_total::text AS fixed_txt,
            i.variable_cost_total::text AS variable_txt,
            i.grand_total::text AS total_txt,
            COALESCE(im.name,'') AS imf_name, COALESCE(im.code_imf,'') AS imf_code
       FROM saas_invoices i LEFT JOIN imf im ON im.id = i.institution_id
      WHERE i.id=$1 AND ($2::uuid IS NULL OR i.institution_id=$2)`, [invoiceId, imfId || null])).rows[0];
  if (!inv) return null;
  const lignes = (await q(
    `SELECT module_key, line_type, label, statut_ligne, billing_cycle,
            days_billed, days_in_month, discount_pct::text AS discount_pct,
            amount_fcfa::text AS amount_txt, amount_before::text AS before_txt,
            period_from, period_to, trial_end_date
       FROM saas_invoice_lines
      WHERE invoice_id=$1
      ORDER BY CASE line_type WHEN 'licence' THEN 0 WHEN 'remise' THEN 9 ELSE 1 END,
               label`, [inv.id])).rows;
  return { invoice: inv, lignes };
}

/** Prépare la ventilation attendue par le gabarit de document. */
export function ventiler({ invoice, lignes }) {
  const lignesPdf = [];
  let abonnementsAvant = dec(0);
  let abonnementsNet = dec(0);
  let licences = dec(0);
  let remises = dec(0);

  for (const l of lignes) {
    const montant = dec(l.amount_txt || 0);
    if (l.line_type === 'licence') {
      licences = licences.plus(montant);
      lignesPdf.push({
        label: LABELS_LIGNE.licence,
        amountCents: toSql(montant)
      });
      continue;
    }
    if (l.line_type === 'remise') {
      remises = remises.plus(montant.abs());
      continue;          // affichée dans le bloc « remises »
    }
    // Abonnement
    const avant = dec(l.before_txt || 0);
    abonnementsAvant = abonnementsAvant.plus(avant);
    abonnementsNet = abonnementsNet.plus(montant);
    const details = [];
    if (l.billing_cycle === 'ANNUEL') details.push('forfait annuel');
    if (l.days_billed != null && l.days_in_month) {
      details.push(l.days_billed + '/' + l.days_in_month + ' jours');
    }
    if (l.discount_pct && dec(l.discount_pct).gt(0)) {
      details.push('−' + toSql(l.discount_pct) + ' %');
    }
    const libelle = (l.label || 'Module')
      + (details.length ? ' (' + details.join(', ') + ')' : '');
    lignesPdf.push({ label: libelle, amountCents: toSql(montant) });
  }

  return {
    lignesPdf,
    licence: toSql(licences),
    abonnements_avant: toSql(abonnementsAvant),
    abonnements_net: toSql(abonnementsNet),
    remises: toSql(remises),
    total: toSql(dec(invoice.total_txt || 0)),
    controle: toSql(sum(licences, abonnementsNet))
  };
}

/** Rend la facture au format document (A4 imprimable). */
export function renderFactureSaas(doc) {
  const { invoice } = doc;
  const v = ventiler(doc);
  const header = doc.header || null;

  const lignesDetail = doc.lignes.map((l) => ({
    libelle: (l.label || '') + (l.module_key ? '' : ''),
    cycle: l.billing_cycle || '',
    jours: l.days_billed != null ? l.days_billed + ' / ' + (l.days_in_month || '—') : '',
    remise: l.discount_pct && dec(l.discount_pct).gt(0) ? toSql(l.discount_pct) + ' %' : '',
    avant: toSql(l.before_txt || 0),
    montant: toSql(l.amount_txt || 0),
    statut: STATUTS[l.statut_ligne] || l.statut_ligne || ''
  }));

  return renderFactureHtml({
    header, invoice, ventilation: v, lignesDetail,
    moneyFcfa, dateFr
  });
}

/** Gabarit HTML autonome (aucune ressource externe). */
function renderFactureHtml({ header, invoice, ventilation, lignesDetail, dateFr }) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const f = (v) => esc(formatFcfa(v));

  const rows = lignesDetail.map((l) => `
      <tr>
        <td class="d">${esc(l.libelle)}</td>
        <td class="c">${esc(l.cycle)}</td>
        <td class="c">${esc(l.jours)}</td>
        <td class="c">${esc(l.remise)}</td>
        <td class="r">${f(l.avant)}</td>
        <td class="r b">${f(l.montant)}</td>
        <td class="c s">${esc(l.statut)}</td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<title>Facture ${esc(invoice.invoice_number)} — teebo</title>
<style>
  :root{--navy:#0b0c26;--neon:#d8f500;--line:#e3e5ee;--muted:#61647c}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,-apple-system,Roboto,Arial,sans-serif;
       color:#0b0c26;background:#eef0f6;padding:24px;-webkit-font-smoothing:antialiased}
  .sheet{max-width:900px;margin:0 auto;background:#fff;border-radius:10px;
         box-shadow:0 12px 40px rgba(11,12,38,.12);overflow:hidden}
  .doc{padding:38px 42px 30px}
  .head{display:flex;justify-content:space-between;gap:24px;padding-bottom:18px;
        border-bottom:3px solid var(--navy)}
  .head h1{font-size:20px;letter-spacing:-.4px}
  .head .sub{color:var(--muted);font-size:12px;margin-top:4px}
  .num{text-align:right}
  .num b{font-size:22px;display:block}
  .badge{display:inline-block;margin-top:6px;padding:3px 10px;border-radius:99px;
         font-size:11px;font-weight:700;background:var(--navy);color:var(--neon)}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;margin:18px 0 6px;
        font-size:12px}
  .meta div{display:flex;justify-content:space-between;border-bottom:1px dotted var(--line);
            padding:5px 0}
  .meta span{color:var(--muted)}
  table{width:100%;border-collapse:collapse;margin-top:16px;font-size:12px}
  th{background:var(--navy);color:#fff;font-size:10.5px;letter-spacing:.4px;
     text-transform:uppercase;padding:8px 6px;text-align:left}
  th.r{text-align:right}
  td{padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
  td.r{text-align:right;white-space:nowrap}
  td.c{text-align:center;color:var(--muted)}
  td.b{font-weight:700}
  td.s{font-size:10.5px}
  tr.gratuit td{color:#9aa0b4}
  .tot{margin-top:18px;display:flex;justify-content:flex-end}
  .tot table{width:380px}
  .tot td{border:none;padding:6px 4px;font-size:12.5px}
  .tot .sep td{border-top:1px solid var(--line)}
  .tot .gt td{font-size:16px;font-weight:800;border-top:2px solid var(--navy);padding-top:10px}
  .neg{color:#c0392b}
  .legal{margin-top:22px;font-size:10.5px;color:var(--muted);line-height:1.55;
         border-top:1px solid var(--line);padding-top:12px}
  .warn{margin-top:14px;font-size:11px;background:#fff8e1;border-left:3px solid #f0b400;
        padding:8px 12px}
  @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0}}
</style></head>
<body><div class="sheet"><div class="doc">
  <div class="head">
    <div>
      <h1>${esc(header && header.legal_name ? header.legal_name : 'teebo')}</h1>
      <div class="sub">Plateforme de gestion pour institutions de microfinance — teebo</div>
    </div>
    <div class="num">
      <div class="sub">FACTURE</div>
      <b>${esc(invoice.invoice_number)}</b>
      <span class="badge">${esc(invoice.status === 'PAID' ? 'PAYÉE'
        : invoice.status === 'CANCELLED' ? 'ANNULÉE' : 'À PAYER')}</span>
      ${invoice.is_locked ? '<span class="badge" style="background:#d8f500;color:#0b0c26">DÉFINITIVE</span>' : ''}
    </div>
  </div>

  <div class="meta">
    <div><span>Institution</span><b>${esc(invoice.imf_name)}</b></div>
    <div><span>Code IMF</span><b>${esc(invoice.imf_code)}</b></div>
    <div><span>Période</span><b>du ${dateFr(invoice.billing_period_start)} au ${dateFr(invoice.billing_period_end)}</b></div>
    <div><span>Émise le</span><b>${dateFr(invoice.generated_at || invoice.created_at)}</b></div>
    <div><span>Devise</span><b>XOF (FCFA)</b></div>
    <div><span>Référence</span><b>${esc(String(invoice.id).slice(0, 8))}</b></div>
  </div>

  <table>
    <thead><tr>
      <th>Désignation</th><th class="c">Cycle</th><th class="c">Jours</th>
      <th class="c">Remise</th><th class="r">Prix plein</th>
      <th class="r">Montant facturé</th><th class="c">Statut</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="tot"><table>
    <tr><td>Licence unique (à vie)</td><td class="r">${f(ventilation.licence)}</td></tr>
    <tr class="sep"><td>Abonnements (prix plein)</td><td class="r">${f(ventilation.abonnements_avant)}</td></tr>
    <tr><td>Abonnements après remise annuelle</td><td class="r">${f(ventilation.abonnements_net)}</td></tr>
    <tr><td>Remises appliquées</td><td class="r neg">− ${f(ventilation.remises)}</td></tr>
    <tr class="gt"><td>Total à payer</td><td class="r">${f(ventilation.total)}</td></tr>
  </table></div>

  <div class="legal">
    <b>Règles de facturation appliquées.</b><br>
    • Licence unique : 250 000 FCFA, réglée une seule fois pour toute la durée du contrat.<br>
    • Abonnements : mensuels par module. Un module utilisé une partie du mois est facturé au prorata exact des jours (colonne « Jours »).<br>
    • Forfait annuel : la réduction de 15 % ne s applique qu à partir de la date exacte de signature ; le mois de la bascule est découpé jour par jour (colonne « Bascule mensuel → annuel »).<br>
    • Essai gratuit : 0 FCFA lorsque le module est encore en essai à la date de facturation ; les jours restants sont reportés au mois suivant.<br>
    • Pack complet : remise de 5 % sur les abonnements du mois lorsqu tous les modules sont souscrits, affichée en négatif.<br>
    • Montants exprimés en FCFA, calculés en décimaux exacts (NUMERIC 12,2) — aucun arrondi flottant.
  </div>

  ${invoice.is_locked ? '<div class="warn"><b>Document définitif.</b> Cette facture est verrouillée en base : ses lignes et ses montants ne peuvent plus être modifiés. Seul l encaissement peut être enregistré.</div>' : ''}

  <div class="legal" style="border-top:none;margin-top:10px">
    Facture générée par teebo — document imprimable (Ctrl+P ou « Imprimer » du navigateur pour l enregistrer en PDF).
  </div>
</div></div></body></html>`;
}

export default { chargerFacture, ventiler, renderFactureSaas };
