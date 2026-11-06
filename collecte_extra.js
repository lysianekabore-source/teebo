/* ===================================================================
 * teebo — VAGUE 6 : anti-doublons, affectations superviseur, relevé BCEAO,
 *          approbation caissière + export Excel (CSV/Excel compatible).
 * =================================================================== */
import { q } from './db.js';

export const ASSIGN_REASONS = [
  { code: 'demission', label: 'Démission de la collectrice', reqDays: true },
  { code: 'conge',     label: 'Congé de la collectrice',     reqDays: true },
  { code: 'absence',   label: 'Absence de la collectrice',   reqDays: true },
  { code: 'deces',     label: 'Décès de la collectrice',     reqDays: false }
];
export const ASSIGN_REASON_CODES = ASSIGN_REASONS.map(r => r.code);
export function reasonRequiresDays(code) { const r = ASSIGN_REASONS.find(x => x.code === code); return !!(r && r.reqDays); }
export function reasonLabel(code) { const r = ASSIGN_REASONS.find(x => x.code === code); return r ? r.label : code; }

/* -------------------------------------------------------------------
 *  27.1 ANTI-DOUBLONS (clients & comptes)
 * ----------------------------------------------------------------- */
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const normIdNo = (s) => String(s || '').replace(/\s+/g, '').toUpperCase() || null;
const normPhone = (s) => { const d = String(s || '').replace(/[^0-9]/g, ''); return d || null; };

export function normalizeClientFields(b = {}) {
  return {
    full_name: String(b.full_name || '').trim(),
    name_norm: normName(b.full_name),
    phone: b.phone ? String(b.phone).trim() : null,
    phone_norm: normPhone(b.phone),
    id_number: b.id_number ? String(b.id_number).trim() : null,
    id_number_norm: normIdNo(b.id_number)
  };
}

/** Cherche un doublon de client (n° de pièce OU nom+téléphone). */
export async function findClientDuplicate(imfId, b = {}) {
  const f = normalizeClientFields(b);
  const out = { duplicate: false, matches: [] };
  if (f.id_number_norm) {
    const r = (await q(
      `SELECT id, code_client, full_name, phone, id_number FROM client
        WHERE imf_id=$1 AND id_number_norm=$2 LIMIT 5`, [imfId, f.id_number_norm])).rows;
    for (const m of r) out.matches.push({ ...m, reason: 'id_number' });
  }
  if (f.phone_norm) {
    const r = (await q(
      `SELECT id, code_client, full_name, phone, id_number FROM client
        WHERE imf_id=$1 AND name_norm=$2 AND phone_norm=$3 LIMIT 5`,
      [imfId, f.name_norm, f.phone_norm])).rows;
    for (const m of r) if (!out.matches.some(x => x.id === m.id)) out.matches.push({ ...m, reason: 'name_phone' });
  }
  out.duplicate = out.matches.length > 0;
  return out;
}

export async function logDuplicate({ imfId, entity, matchedId, reason, payload, actorId }) {
  await q(
    `INSERT INTO duplicate_check_log(imf_id,entity,matched_id,reason,payload,actor_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [imfId, entity, matchedId || null, reason, payload ? JSON.stringify(payload) : null, actorId || null]);
}

/** Compte actif existant pour ce client ? (empêche le doublon de compte) */
export async function clientHasActiveAccount(clientId) {
  const r = (await q(
    `SELECT id, code_account, status FROM account WHERE client_id=$1 AND status='active' LIMIT 1`,
    [clientId])).rows[0];
  return r || null;
}

/* -------------------------------------------------------------------
 *  27.4 AFFECTATIONS (superviseur -> collectrice)
 * ----------------------------------------------------------------- */
export async function listAssignments(imfId) {
  const { rows } = await q(
    `SELECT a.*, u.full_name AS collectrice_name, u.code_user AS collectrice_code,
            (SELECT COUNT(*) FROM collectrice_assignment_client c WHERE c.assignment_id=a.id) AS clients_count
       FROM collectrice_assignment a
       JOIN app_user u ON u.id = a.collectrice_user_id
      WHERE a.imf_id=$1 AND a.status='active'
      ORDER BY a.created_at DESC`, [imfId]);
  return rows;
}

/** Liste des collectrices de l'IMF (rôles staff/agency). */
export async function listCollectrices(imfId) {
  const { rows } = await q(
    `SELECT u.id, u.full_name, u.code_user, u.role,
            (SELECT COUNT(*) FROM client c WHERE c.collectrice_user_id=u.id) AS clients_affectes
       FROM app_user u
      WHERE u.imf_id=$1 AND u.is_active AND u.role IN ('staff','agency','service')
      ORDER BY u.full_name`, [imfId]);
  return rows;
}

export function computeEndsOn(startsOn, reason, days) {
  if (!reasonRequiresDays(reason) || !days) return null;
  const d = new Date((startsOn || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------
 *  27.6 RELEVÉ BCEAO — structure imposée par les standards
 *     (relevé de compte : en-tête IMF, identification du compte,
 *      solde d'ouverture, mouvements datés, solde de clôture, contrôle)
 * ----------------------------------------------------------------- */
const cfa = (cents) => (Number(cents || 0) / 100).toFixed(0);
const d10 = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

export const BCEAO_STATEMENT_SPEC = {
  reference: 'BCEAO — Instruction relative aux systèmes de paiement / relevé de compte',
  required: ['imf_header', 'account_id', 'period', 'opening_balance', 'movements', 'closing_balance', 'totals_check']
};

/** Construit les données structurées du relevé (utilisable HTML/CSV/Excel). */
export async function buildBceaoStatement(imfId, clientId, { from, to } = {}) {
  const imf = (await q('SELECT id, name, code_imf, country_code, city, bceao_agreement_no FROM imf WHERE id=$1', [imfId])).rows[0];
  const cl = (await q('SELECT * FROM client WHERE id=$1 AND imf_id=$2', [clientId, imfId])).rows[0];
  if (!cl) return null;
  const acc = (await q('SELECT * FROM account WHERE client_id=$1 ORDER BY opened_at LIMIT 1', [cl.id])).rows[0];

  const cond = ['o.account_id = $1'];
  const params = [acc ? acc.id : null];
  if (from) { params.push(from); cond.push(`o.created_at >= $${params.length}::date`); }
  if (to)   { params.push(to);   cond.push(`o.created_at < ($${params.length}::date + INTERVAL '1 day')`); }

  const ops = acc ? (await q(
    `SELECT o.created_at, o.kind, o.amount_cents, o.status, o.direction, o.reference, o.note
       FROM operation o WHERE ${cond.join(' AND ')}
      ORDER BY o.created_at ASC`, params)).rows : [];

  // Solde d'ouverture = solde actuel - somme des mouvements validés de la période.
  let debit = 0, credit = 0;
  const movements = ops.map((o) => {
    const amt = Number(o.amount_cents || 0);
    const isValid = o.status === 'valide';
    const isDebit = o.direction === 'debit' || o.kind === 'retrait_regul';
    if (isValid) { if (isDebit) debit += amt; else credit += amt; }
    return {
      date: d10(o.created_at),
      libelle: o.kind === 'depot' ? 'Versement espèces' : (o.kind === 'retrait_regul' ? 'Retrait guichet' : o.kind),
      reference: o.reference || '',
      debit_fcfa: isDebit ? cfa(amt) : '',
      credit_fcfa: isDebit ? '' : cfa(amt),
      statut: o.status
    };
  });
  const closing = Number(acc ? acc.balance_cents : 0);
  const opening = closing - credit + debit;

  return {
    spec: BCEAO_STATEMENT_SPEC,
    imf: {
      name: imf ? imf.name : '',
      code: imf ? imf.code_imf : '',
      country: imf ? imf.country_code : '',
      city: imf ? imf.city : '',
      agreement: imf ? imf.bceao_agreement_no : ''
    },
    client: { full_name: cl.full_name, code_client: cl.code_client, phone: cl.phone || '' },
    account: acc ? { code_account: acc.code_account, currency: acc.currency, status: acc.status } : null,
    period: { from: from || null, to: to || null },
    opening_balance_fcfa: cfa(opening),
    closing_balance_fcfa: cfa(closing),
    totals: { debit_fcfa: cfa(debit), credit_fcfa: cfa(credit), movements: movements.length },
    movements,
    generated_at: new Date().toISOString()
  };
}

/** Rendu HTML du relevé BCEAO (imprimable). */
export function renderBceaoHtml(st) {
  const rows = st.movements.map((m) => `<tr><td>${m.date}</td><td>${m.libelle}</td><td>${m.reference}</td>
    <td class="r">${m.debit_fcfa ? Number(m.debit_fcfa).toLocaleString('fr-FR') : ''}</td>
    <td class="r">${m.credit_fcfa ? Number(m.credit_fcfa).toLocaleString('fr-FR') : ''}</td></tr>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Relevé de compte — ${st.client.full_name}</title><style>
body{font-family:system-ui,Arial;color:#0b0c26;padding:28px;font-size:13px}
h1{font-size:18px;margin:0 0 2px}.m{color:#5b6076;font-size:12px}
.hd{display:flex;justify-content:space-between;border-bottom:2px solid #0b0c26;padding-bottom:10px;margin-bottom:14px}
.box{border:1px solid #d8dae4;border-radius:8px;padding:10px 12px;margin-bottom:12px}
.box b{display:inline-block;min-width:150px;color:#0b0c26}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{border-bottom:1px solid #e6e6ef;padding:7px;text-align:left}
th{background:#f4f5f9;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}
.r{text-align:right}.tot{font-weight:700;background:#fafbff}
.foot{margin-top:16px;color:#8a8fa4;font-size:11px}
</style></head><body>
<div class="hd"><div><h1>${st.imf.name}</h1>
<div class="m">Code IMF : ${st.imf.code || '—'} · Agrément BCEAO : ${st.imf.agreement || '—'}</div>
<div class="m">${st.imf.city || ''} ${st.imf.country || ''}</div></div>
<div style="text-align:right"><h1>RELEVÉ DE COMPTE</h1>
<div class="m">Du ${st.period.from || '—'} au ${st.period.to || '—'}</div>
<div class="m">Édité le ${new Date(st.generated_at).toLocaleDateString('fr-FR')}</div></div></div>
<div class="box"><b>Titulaire :</b> ${st.client.full_name} (${st.client.code_client})<br>
<b>Compte :</b> ${st.account ? st.account.code_account : '—'} · ${st.account ? st.account.currency : 'XOF'}<br>
<b>Statut :</b> ${st.account ? st.account.status : '—'}</div>
<table><thead><tr><th>Date</th><th>Libellé</th><th>Référence</th><th class="r">Débit</th><th class="r">Crédit</th></tr></thead>
<tbody><tr class="tot"><td colspan="3">SOLDE D'OUVERTURE</td><td class="r"></td><td class="r">${Number(st.opening_balance_fcfa).toLocaleString('fr-FR')}</td></tr>
${rows || '<tr><td colspan="5">Aucun mouvement sur la période.</td></tr>'}
<tr class="tot"><td colspan="3">TOTAUX</td><td class="r">${Number(st.totals.debit_fcfa).toLocaleString('fr-FR')}</td><td class="r">${Number(st.totals.credit_fcfa).toLocaleString('fr-FR')}</td></tr>
<tr class="tot"><td colspan="3">SOLDE DE CLÔTURE</td><td class="r"></td><td class="r">${Number(st.closing_balance_fcfa).toLocaleString('fr-FR')}</td></tr>
</tbody></table>
<p class="foot">Relevé établi conformément aux standards BCEAO (relevé de compte : identification du titulaire et du compte,
 solde d'ouverture, mouvements datés débit/crédit, totaux et solde de clôture). Document généré par teeBo —
 « La finance à visage humain ». Ce relevé ne vaut pas quittance sans le cachet et la signature de l'institution.</p>
</body></html>`;
}

/** Rendu CSV (séparateur point-virgule, ouvrable dans Excel). */
export function renderBceaoCsv(st) {
  const L = [];
  L.push('Releve de compte BCEAO');
  L.push(`Institution;${st.imf.name};Code IMF;${st.imf.code};Agrement;${st.imf.agreement}`);
  L.push(`Titulaire;${st.client.full_name};Code client;${st.client.code_client}`);
  L.push(`Compte;${st.account ? st.account.code_account : ''};Devise;${st.account ? st.account.currency : 'XOF'}`);
  L.push(`Periode du;${st.period.from || ''};au;${st.period.to || ''}`);
  L.push('');
  L.push('Date;Libelle;Reference;Debit (FCFA);Credit (FCFA);Statut');
  L.push(`;SOLDE D'OUVERTURE;;;${st.opening_balance_fcfa};`);
  for (const m of st.movements) L.push(`${m.date};${m.libelle};${m.reference};${m.debit_fcfa};${m.credit_fcfa};${m.statut}`);
  L.push(`;TOTAUX;${st.totals.debit_fcfa};${st.totals.credit_fcfa};`);
  L.push(`;SOLDE DE CLOTURE;;;${st.closing_balance_fcfa};`);
  return '\ufeff' + L.join('\n');
}

/* -------------------------------------------------------------------
 *  EXPORT EXCEL (CSV UTF-8 BOM -> .xls Excel) des dépôts de collecte
 *  à importer dans le logiciel de l'IMF quand l'app et le SIG ne sont
 *  PAS interconnectés.
 * ----------------------------------------------------------------- */
export async function buildCollectionExport(imfId, { collectriceUserId, from, to, onlyApproved } = {}) {
  const cond = ['d.imf_id = $1'];
  const params = [imfId];
  if (collectriceUserId) { params.push(collectriceUserId); cond.push(`d.collectrice_user_id = $${params.length}`); }
  if (from) { params.push(from); cond.push(`d.declared_at >= $${params.length}::date`); }
  if (to)   { params.push(to);   cond.push(`d.declared_at < ($${params.length}::date + INTERVAL '1 day')`); }
  if (onlyApproved) cond.push(`d.status = 'valide'`);

  const { rows } = await q(
    `SELECT d.id, d.declared_at, d.amount_cents, d.channel, d.status, d.momo_provider, d.momo_number,
            d.transfer_ref, d.approved_at,
            u.full_name AS collectrice, u.code_user AS collectrice_code,
            c.full_name AS client_name, c.code_client,
            a.code_account,
            r.code_receipt
       FROM cash_deposit d
       LEFT JOIN app_user u ON u.id = d.collectrice_user_id
       LEFT JOIN client c ON c.id = d.client_id
       LEFT JOIN account a ON a.client_id = c.id AND a.status='active'
       LEFT JOIN receipt r ON r.id = d.receipt_id
      WHERE ${cond.join(' AND ')}
      ORDER BY d.declared_at ASC`, params);
  return rows;
}

/** Excel-compatible : CSV séparé par ';' avec BOM UTF-8. */
export function renderCollectionExcel(rows) {
  const L = [];
  L.push('Export des depots de collecte — a importer dans le logiciel IMF');
  L.push(['Date','Collectrice','Code collectrice','Client','Code client','Compte','Montant FCFA',
    'Canal','Reference transfert','Recu','Statut','Approuve le'].join(';'));
  for (const r of rows) {
    L.push([
      d10(r.declared_at), r.collectrice || '', r.collectrice_code || '', r.client_name || '', r.code_client || '',
      r.code_account || '', cfa(r.amount_cents), r.channel || '', r.transfer_ref || '', r.code_receipt || '',
      r.status || '', d10(r.approved_at)
    ].map((v) => String(v).replace(/;/g, ',')).join(';'));
  }
  return '\ufeff' + L.join('\n');
}
