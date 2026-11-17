// teebo — GOUVERNANCE : EXPORTS RÉGLEMENTAIRES (VAGUE 29)
// ---------------------------------------------------------------------------
// 1. Rapport Spécial du Commissaire aux Comptes — PDF (HTML imprimable) et
//    Excel (classeur multi-feuilles généré sans dépendance externe).
// 2. Pack Inspection « Commission Bancaire » — archive .ZIP à 7 dossiers
//    numérotés de 01_ à 07_, générée en flux (aucun fichier temporaire).
// ---------------------------------------------------------------------------
import crypto from 'crypto';
import zlib from 'zlib';
import { q } from './db.js';
import { fmtDate, moneyFcfa } from './documents.js';
import { getParams, getForme, getFpe } from './governance_conformite.js';

// ---------------------------------------------------------------------------
// ZIP minimal (méthode « deflate »), écrit directement dans la réponse HTTP.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
/** Construit une archive ZIP complète à partir d'une liste { name, data }. */
export function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  entries.forEach((e) => {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  });
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, cd, end]);
}

// ---------------------------------------------------------------------------
// Classeur Excel (.xlsx) minimal — 100 % openpyxl-compatible, sans dépendance.
// ---------------------------------------------------------------------------
const xesc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const colName = (i) => { let s = ''; let n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

/** sheets : [{ name, rows: [[...]] }] — les nombres restent numériques. */
export function buildXlsx(sheets) {
  const files = [];
  files.push({ name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>' });
  files.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
  files.push({ name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + xesc(s.name.slice(0, 31)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>' });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '</Relationships>' });
  sheets.forEach((s, i) => {
    const rows = (s.rows || []).map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((c, ci) => {
      const ref = colName(ci) + (ri + 1);
      if (c === null || c === undefined || c === '') return '';
      if (typeof c === 'number' && isFinite(c)) return '<c r="' + ref + '"><v>' + c + '</v></c>';
      return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xesc(c) + '</t></is></c>';
    }).join('') + '</row>').join('');
    files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows + '</sheetData></worksheet>' });
  });
  return buildZip(files);
}

// ---------------------------------------------------------------------------
// Collecte des données du dossier de conformité
// ---------------------------------------------------------------------------
export async function collectDossier(imfId) {
  const p = await getParams(imfId);
  const forme = await getForme(imfId);
  const fpe = await getFpe(imfId);
  const R = (sql, args) => q(sql, args).then((x) => x.rows);
  const [imf, inst, organes, membres, conventions, apparentes, creditsApp, risques, pca, incidents, lbc, echeances, effectif] = await Promise.all([
    R('SELECT * FROM imf WHERE id=$1', [imfId]),
    R('SELECT * FROM institution_gouvernance WHERE imf_id=$1', [imfId]),
    R('SELECT * FROM organes_gouvernance WHERE imf_id=$1 ORDER BY libelle', [imfId]),
    R(`SELECT m.*, o.libelle AS organe_libelle FROM membres_gouvernance m
         LEFT JOIN organes_gouvernance o ON o.id=m.organe_id AND o.imf_id=m.imf_id
        WHERE m.imf_id=$1 ORDER BY m.actif DESC, m.nom_complet`, [imfId]),
    R(`SELECT cv.*, pa.nom_complet AS apparente_nom, pa.type_lien FROM conventions_reglementees cv
         JOIN personnes_apparentees pa ON pa.id=cv.personne_apparentee_id AND pa.imf_id=cv.imf_id
        WHERE cv.imf_id=$1 ORDER BY cv.date_convention DESC`, [imfId]),
    R('SELECT * FROM personnes_apparentees WHERE imf_id=$1 AND actif=true ORDER BY nom_complet', [imfId]),
    R(`SELECT cf.reference, cf.status, cf.amount_cents, cf.approved_amount_cents, cf.created_at, cf.apparente,
              c.full_name AS client, c.code_client, pa.nom_complet AS apparente
         FROM credit_file cf JOIN client c ON c.id=cf.client_id
         LEFT JOIN personnes_apparentees pa ON pa.client_id=c.id AND pa.imf_id=cf.imf_id AND pa.actif
        WHERE cf.imf_id=$1 AND (cf.apparente=true OR pa.id IS NOT NULL)
        ORDER BY cf.created_at DESC`, [imfId]),
    R('SELECT * FROM cartographie_risques WHERE imf_id=$1 ORDER BY probabilite DESC, impact DESC', [imfId]),
    R('SELECT * FROM plans_continuite_pca WHERE imf_id=$1 ORDER BY libelle', [imfId]),
    R('SELECT * FROM incidents_majeurs WHERE imf_id=$1 ORDER BY date_incident DESC', [imfId]),
    R(`SELECT f.*, u.full_name AS agent FROM formation_lbcft f
         LEFT JOIN app_user u ON u.id=f.app_user_id AND u.imf_id=f.imf_id
        WHERE f.imf_id=$1 ORDER BY f.date_formation DESC`, [imfId]),
    R('SELECT * FROM echeancier_reglementaire WHERE imf_id=$1 ORDER BY COALESCE(date_limite_depot, date_echeance)', [imfId]),
    R('SELECT COUNT(*)::int AS n FROM app_user WHERE imf_id=$1 AND is_active=true', [imfId])
  ]);
  return { p, forme, fpe, imf: imf[0] || {}, inst: inst[0] || {}, organes, membres, conventions, apparentes, creditsApp, risques, pca, incidents, lbc, echeances, effectif: effectif[0] ? effectif[0].n : 0 };
}

/** Encours des crédits aux apparentés par personne (pour le rapport). */
export function encoursParApparente(d) {
  const map = {};
  d.creditsApp.forEach((c) => {
    if (c.status !== 'decaisse') return;
    const k = c.apparente || c.apparente_nom || '—';
    map[k] = (map[k] || 0) + Number(c.approved_amount_cents || c.amount_cents || 0);
  });
  return map;
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const F = (dd) => (dd ? fmtDate(dd) : '—');
const M = (c) => (c == null ? '—' : moneyFcfa(Number(c)));
const pc = (v) => (v == null ? '—' : String(Number(v).toFixed(2)).replace('.', ',') + ' %');

/**
 * Rapport Spécial CAC — mise en page soignée (A4, imprimable).
 * Principes de lisibilité retenus :
 *  - en-tête d'identité (logo/initiales, raison sociale, mentions légales) ;
 *  - bandeau de synthèse en 4 indicateurs clés (chiffres lisibles d'abord) ;
 *  - tableaux aérés, alternance de lignes, statuts colorés (pas de « Aucun ») ;
 *  - encadré d'information quand une section est vide (état vide explicite) ;
 *  - pagination et pied de page discrets, mentions « document confidentiel ».
 */
const CAC_CSS = `
 *{box-sizing:border-box;margin:0;padding:0}
 body{font-family:'Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;color:#0b0c26;background:#eef0f6;padding:22px;-webkit-font-smoothing:antialiased}
 .sheet{max-width:920px;margin:0 auto 18px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 14px 44px rgba(11,12,38,.14)}
 .band{background:#0b0c26;color:#fff;padding:26px 40px 22px;display:flex;justify-content:space-between;gap:26px;align-items:flex-start}
 .band h1{font-size:19px;line-height:1.3;letter-spacing:-.3px;max-width:560px}
 .band .sub{margin-top:9px;font-size:11.5px;line-height:1.65;color:#c9cce0}
 .band .sub b{color:#fff}
 .stamp{border:1px solid #d8f500;color:#d8f500;border-radius:999px;padding:7px 14px;font-size:10.5px;font-weight:800;letter-spacing:.9px;white-space:nowrap;height:fit-content}
 .body{padding:26px 40px 30px}
 .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 8px}
 .kpi{border:1px solid #e3e5ee;border-radius:11px;padding:13px 14px;background:#fbfbfe}
 .kpi span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#61647c;margin-bottom:6px}
 .kpi b{display:block;font-size:17px;letter-spacing:-.3px;line-height:1.25;word-break:break-word}
 .kpi small{display:block;font-size:10.5px;color:#61647c;margin-top:4px}
 .kpi.is-bad{border-color:#f0b7b1;background:#fdf6f5}
 .kpi.is-bad b{color:#b3261e}
 .kpi.is-ok{border-color:#cbe3ad;background:#f8fcf2}
 .kpi.is-ok b{color:#2f6b00}
 h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.9px;color:#0b0c26;margin:26px 0 10px;padding-bottom:6px;border-bottom:2px solid #0b0c26;display:flex;justify-content:space-between;align-items:baseline}
 h2 em{font-style:normal;font-size:10.5px;letter-spacing:.4px;color:#61647c;text-transform:none}
 table{width:100%;border-collapse:collapse;font-size:11.5px}
 thead th{background:#f0f1f7;color:#3b3e58;font-size:9.5px;letter-spacing:.7px;text-transform:uppercase;padding:9px 10px;text-align:left;border-bottom:1px solid #d9dbe7;font-weight:700}
 td{padding:9px 10px;border-bottom:1px solid #eceef5;vertical-align:top;line-height:1.45}
 tbody tr:nth-child(even){background:#fafbfe}
 td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
 .pill{display:inline-block;font-size:10px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}
 .pill.ok{background:#e8f5d8;color:#2f6b00}
 .pill.bad{background:#fdeceb;color:#b3261e}
 .pill.mid{background:#fff4dc;color:#8a5a00}
 .pill.grey{background:#eef0f6;color:#525570}
 .empty{border:1px dashed #d9dbe7;border-radius:10px;padding:14px 16px;font-size:11.5px;color:#525570;background:#fbfbfe}
 .empty b{color:#0b0c26}
 p.txt{font-size:11.8px;line-height:1.72;margin-top:10px;color:#22243c}
 p.txt b{color:#0b0c26}
 .cta{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
 .cta div{flex:1 1 200px;border:1px solid #e3e5ee;border-radius:10px;padding:12px 14px;background:#fbfbfe}
 .cta span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#61647c;margin-bottom:5px}
 .cta b{font-size:13.5px}
 .sign{margin-top:30px;display:flex;justify-content:space-between;gap:24px;font-size:11px;color:#525570}
 .sign div{border-top:1px solid #b9bccd;padding-top:8px;min-width:230px}
 .foot{background:#f0f1f7;color:#61647c;font-size:9.5px;padding:11px 40px;display:flex;justify-content:space-between;gap:16px;line-height:1.5}
 @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0;max-width:none;margin:0}
  .band{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}
  @page{size:A4;margin:11mm 10mm}}
`;

export function rapportCacHtml(d) {
  const { p, forme, fpe, inst, organes, membres, conventions, apparentes, creditsApp, risques, pca, incidents, lbc, echeances, effectif } = d;
  const enc = encoursParApparente(d);
  const totalEnc = Object.values(enc).reduce((s, x) => s + x, 0);
  const ratioGlobal = fpe.fpe_cents > 0 ? (totalEnc / fpe.fpe_cents) * 100 : null;
  const formes = new Set(lbc.map((x) => x.app_user_id).filter(Boolean));
  const tauxLbc = effectif ? Math.round((formes.size / effectif) * 100) : 0;
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const retard = echeances.filter((x) => x.statut !== 'RECEPISSE_RECU' && x.statut !== 'SANS_OBJET'
    && String(x.date_limite_depot || x.date_echeance).slice(0, 10) < aujourdhui);
  const titre = forme.is_scoop ? 'parts sociales' : 'actions';
  const nom = inst.raison_sociale || d.imf.name || 'Institution';
  const initiales = String(nom).replace(/[^A-Za-zÀ-ÿ ]/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('') || 'IMF';
  const plafInd = Number(p.plafond_apparente_individuel_pct);
  const plafGlob = Number(p.plafond_apparentes_global_pct);
  const conforme = ratioGlobal === null ? null : ratioGlobal <= plafGlob;
  const convNonAutorisees = conventions.filter((c) => !c.date_autorisation).length;
  const membresActifs = membres.filter((m) => m.actif);
  const femmes = membresActifs.filter((m) => m.sexe === 'F').length;
  const risquesCritiques = risques.filter((r) => Number(r.probabilite) * Number(r.impact) >= 12).length;
  const pcaARevoir = pca.filter((x) => x.statut === 'REVISION_REQUISE').length;
  const incidentsNonNotifies = incidents.filter((i) => i.notification_bceao_requise && !i.notification_bceao).length;
  const ratioCell = (v) => (v === null ? '<span class="pill grey">—</span>'
    : (v > plafInd ? `<span class="pill bad">${pc(v)}</span>` : `<span class="pill ok">${pc(v)}</span>`));

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rapport spécial du Commissaire aux Comptes — ${esc(nom)}</title>
<style>${CAC_CSS}</style></head><body>
<div class="sheet">
 <div class="band">
  <div>
   <h1>Rapport spécial sur les conventions réglementées et les crédits aux personnes apparentées</h1>
   <div class="sub"><b>${esc(nom)}</b> · ${esc(inst.forme_juridique || forme.forme_juridique || '—')}<br>
   RCCM ${esc(inst.rccm || '—')} · IFU ${esc(inst.ifu || '—')} · Agrément BCEAO ${esc(inst.numero_agrement || '—')}<br>
   ${esc(inst.siege_social || '—')} — exercice arrêté au ${F(new Date())}</div>
  </div>
  <div class="stamp">RAPPORT DU CAC</div>
 </div>
 <div class="body">

  <h2>Synthèse des indicateurs <em>chiffres arrêtés à la date d'édition</em></h2>
  <div class="kpis">
   <div class="kpi"><span>Fonds propres effectifs</span><b>${M(fpe.fpe_cents)}</b><small>${esc(fpe.source === 'saisie' ? 'montant saisi par l\'IMF' : 'capital social')}</small></div>
   <div class="kpi"><span>Encours crédits apparentés</span><b>${M(totalEnc)}</b><small>${Object.keys(enc).length} personne(s) concernée(s)</small></div>
   <div class="kpi ${conforme === null ? '' : (conforme ? 'is-ok' : 'is-bad')}"><span>Ratio global / FPE</span><b>${pc(ratioGlobal)}</b><small>plafond ${pc(plafGlob)}</small></div>
   <div class="kpi ${conforme === null ? '' : (conforme ? 'is-ok' : 'is-bad')}"><span>Respect du plafond</span><b>${pctConforme(ratioGlobal, plafGlob)}</b><small>${conforme === null ? 'à compléter' : (conforme ? 'aucun dépassement' : 'action corrective requise')}</small></div>
  </div>

  <h2>1. Objet du rapport</h2>
  <p class="txt">En application des textes régissant les sociétés commerciales et coopératives de l'Union, le Commissaire aux Comptes présente son rapport spécial sur les conventions intervenues entre l'institution et ses administrateurs, dirigeants et personnes qui leur sont liées, ainsi que sur les concours consentis aux personnes apparentées. Dans une société coopérative, les titres détenus sont des <b>${esc(titre)}</b> et chaque membre dispose d'une seule voix à l'assemblée, quel que soit le nombre de parts.</p>

  <h2>2. Plafonds prudentiels retenus <em>paramétrage de l'institution</em></h2>
  <div class="cta">
   <div><span>Plafond individuel</span><b>${pc(plafInd)}</b> des fonds propres effectifs</div>
   <div><span>Plafond global</span><b>${pc(plafGlob)}</b> des fonds propres effectifs</div>
   <div><span>Seuil d'information ${esc(titre)}</span><b>${pc(p.seuil_participation_pct)}</b></div>
  </div>
  <p class="txt">Ces paramètres sont ceux retenus par l'institution et doivent être confirmés auprès de la BCEAO.</p>

  <h2>3. Personnes apparentées recensées <em>${apparentes.length} fiche(s)</em></h2>
  ${apparentes.length ? `<table><thead><tr><th>Nom</th><th>Lien</th><th>Nature</th><th>Vérification</th>
   <th style="text-align:right">Encours crédits</th><th style="text-align:right">Ratio FPE</th></tr></thead><tbody>
   ${apparentes.map((a) => {
     const e = enc[a.nom_complet] || 0;
     const r = fpe.fpe_cents > 0 ? (e / fpe.fpe_cents) * 100 : null;
     const v = String(a.statut_verification || '').toUpperCase();
     const cls = /VERIFI|CONFORME|VALID/.test(v) ? 'ok' : (/ATTENTE|COURS|A_VERIFIER/.test(v) ? 'mid' : 'grey');
     return `<tr><td><b>${esc(a.nom_complet)}</b></td><td>${esc(a.type_lien)}</td><td>${esc(a.nature_personne)}</td>
      <td><span class="pill ${cls}">${esc(a.statut_verification || '—')}</span></td>
      <td class="num">${M(e)}</td><td class="num">${ratioCell(r)}</td></tr>`;
   }).join('')}</tbody></table>` : `<div class="empty"><b>Aucune personne apparentée recensée à ce jour.</b><br>
   Renseignez les administrateurs, dirigeants et leurs proches dans <b>Gouvernance › Personnes apparentées</b> pour que le rapport puisse être établi.</div>`}

  <h2>4. Conventions réglementées <em>${conventions.length} convention(s)${convNonAutorisees ? ` — ${convNonAutorisees} non autorisée(s)` : ''}</em></h2>
  ${conventions.length ? `<table><thead><tr><th>Réf.</th><th>Date</th><th>Apparenté</th><th>Type</th>
   <th style="text-align:right">Montant</th><th>Autorisation</th><th>Vote</th><th>CAC</th></tr></thead><tbody>
   ${conventions.map((c) => `<tr><td>${esc(c.reference)}</td><td>${F(c.date_convention)}</td><td><b>${esc(c.apparente_nom)}</b></td>
    <td>${esc(c.type_convention)}</td><td class="num">${M(c.montant_cents)}</td>
    <td>${c.date_autorisation ? `<span class="pill ok">${esc(c.organe_autorisation || 'Autorisée')}</span> le ${F(c.date_autorisation)}` : '<span class="pill bad">Non autorisée</span>'}</td>
    <td>${c.vote_exclu ? 'Exclu' : '—'}</td>
    <td>${c.informe_cac ? '<span class="pill ok">Oui</span>' : '<span class="pill bad">Non</span>'}</td></tr>`).join('')}</tbody></table>` : `<div class="empty"><b>Aucune convention réglementée enregistrée pour l'exercice.</b><br>
   Toute convention conclue avec un apparenté doit être saisie dans <b>Gouvernance › Conventions réglementées</b>, puis autorisée par le conseil avant exécution.</div>`}

  <h2>5. Dossiers de crédit aux apparentés <em>${creditsApp.length} dossier(s)</em></h2>
  ${creditsApp.length ? `<table><thead><tr><th>Référence</th><th>Client</th><th>Apparenté</th><th>Statut</th>
   <th style="text-align:right">Montant</th><th>Date</th></tr></thead><tbody>
   ${creditsApp.map((c) => {
     const st = String(c.status || '');
     const cls = st === 'decaisse' ? 'ok' : (/refus|rejet|impaye|contentieux/i.test(st) ? 'bad' : 'mid');
     return `<tr><td>${esc(c.reference)}</td><td><b>${esc(c.client)}</b><br><small style="color:#61647c">${esc(c.code_client)}</small></td>
      <td>${esc(c.apparente || '—')}</td><td><span class="pill ${cls}">${esc(st)}</span></td>
      <td class="num">${M(c.approved_amount_cents || c.amount_cents)}</td><td>${F(c.created_at)}</td></tr>`;
   }).join('')}</tbody></table>` : `<div class="empty"><b>Aucun crédit identifié comme consenti à une personne apparentée.</b><br>
   Les prêts aux apparentés sont rapprochés automatiquement à partir des fiches « Personnes apparentées » (lien vers la fiche client).</div>`}

  <h2>6. Gouvernance <em>${membresActifs.length} membre(s) actif(s), dont ${femmes} femme(s)</em></h2>
  ${organes.length ? `<table><thead><tr><th>Organe</th><th>Type</th><th style="text-align:right">Membres</th><th>Dernière session</th></tr></thead><tbody>
   ${organes.map((o) => `<tr><td><b>${esc(o.libelle)}</b></td><td>${esc(o.type_organe)}</td>
    <td class="num">${esc(o.nombre_membres == null ? '—' : o.nombre_membres)}</td>
    <td>${o.derniere_session ? F(o.derniere_session) : '<span class="pill grey">Aucune session</span>'}</td></tr>`).join('')}</tbody></table>` : `<div class="empty"><b>Aucun organe de gouvernance enregistré.</b><br>
   Déclarez le conseil d'administration, le comité d'audit et la direction générale dans <b>Gouvernance › Organes</b>.</div>`}
  <p class="txt">Indemnités et rémunérations des dirigeants : à détailler le cas échéant (informations issues de la comptabilité).</p>

  <h2>7. Contrôle interne, risques et continuité d'activité</h2>
  <div class="cta">
   <div><span>Risques cartographiés</span><b>${risques.length}</b>${risquesCritiques ? ` — <span class="pill bad">${risquesCritiques} critique(s)</span>` : ' — <span class="pill ok">aucun critique</span>'}</div>
   <div><span>Plans de continuité</span><b>${pca.length}</b>${pcaARevoir ? ` — <span class="pill mid">${pcaARevoir} à réviser</span>` : ''}</div>
   <div><span>Incidents non notifiés BCEAO</span><b>${incidentsNonNotifies}</b>${incidentsNonNotifies ? ' <span class="pill bad">à traiter</span>' : ' <span class="pill ok">à jour</span>'}</div>
   <div><span>Personnel formé LBC/FT</span><b>${tauxLbc} %</b> <small style="color:#61647c">${formes.size}/${effectif}</small></div>
  </div>

  <h2>8. Échéancier réglementaire</h2>
  <p class="txt">${echeances.length} obligation(s) suivie(s) ; <b>${retard.length} en retard sans récépissé</b> ${retard.length ? '<span class="pill bad">à régulariser</span>' : '<span class="pill ok">à jour</span>'}, ${echeances.filter((x) => x.date_recepisse).length} avec récépissé reçu.</p>
  ${retard.length ? `<table><thead><tr><th>Obligation</th><th>Échéance</th><th>Statut</th></tr></thead><tbody>
   ${retard.slice(0, 12).map((x) => `<tr><td><b>${esc(x.libelle || x.code || '—')}</b></td>
    <td>${F(x.date_limite_depot || x.date_echeance)}</td><td><span class="pill bad">${esc(x.statut || 'EN_RETARD')}</span></td></tr>`).join('')}
   </tbody></table>` : ''}

  <h2>9. Conclusion du Commissaire aux Comptes</h2>
  <p class="txt">Les conventions et concours ci-dessus ont été examinés au regard de l'intérêt de l'institution.
  ${convNonAutorisees ? `<b>${convNonAutorisees} convention(s) n'ont pas fait l'objet d'une autorisation préalable</b> : elles doivent être soumises au conseil.` : 'Toutes les conventions soumises ont fait l\'objet d\'une autorisation préalable.'}
  ${retard.length ? '<b>Des obligations réglementaires sont en retard de dépôt</b> et doivent être régularisées sans délai.' : "L'échéancier réglementaire est tenu à jour."}</p>

  <div class="sign"><div>Le Commissaire aux Comptes<br><small>Nom, signature et date</small></div>
   <div>Le Président du Conseil d'Administration<br><small>Nom, signature et date</small></div></div>
 </div>
 <div class="foot"><span>${esc(nom)} — document confidentiel destiné au Conseil d'Administration et au Commissaire aux Comptes</span>
  <span>Édité avec teeBo — ${new Date().toLocaleString('fr-FR')}</span></div>
</div></body></html>`;
}

function pctConforme(ratio, plafond) { return ratio === null ? 'Indéterminé' : (ratio > Number(plafond) ? 'NON RESPECTÉ' : 'Respecté'); }

/** Classeur Excel du rapport spécial CAC. */
export function rapportCacXlsx(d) {
  const { p, forme, fpe, inst, apparentes, conventions, creditsApp, organes } = d;
  const enc = encoursParApparente(d);
  const totalEnc = Object.values(enc).reduce((s, x) => s + x, 0);
  const ratioGlobal = fpe.fpe_cents > 0 ? Number(((totalEnc / fpe.fpe_cents) * 100).toFixed(2)) : null;
  const sheets = [
    { name: 'Synthèse', rows: [
      ['RAPPORT SPÉCIAL DU COMMISSAIRE AUX COMPTES'],
      ['Institution', inst.raison_sociale || d.imf.name],
      ['Forme juridique', inst.forme_juridique || forme.forme_juridique],
      ['Titres', forme.titre_pluriel],
      ['RCCM', inst.rccm || ''], ['Agrément BCEAO', inst.numero_agrement || ''],
      ['Fonds propres effectifs (FCFA)', fpe.fpe_cents / 100],
      ['Encours crédits apparentés (FCFA)', totalEnc / 100],
      ['Ratio global (%)', ratioGlobal === null ? '' : ratioGlobal],
      ['Plafond global (%)', Number(p.plafond_apparentes_global_pct)],
      ['Plafond individuel (%)', Number(p.plafond_apparente_individuel_pct)],
      ['Seuil d\'information titres (%)', Number(p.seuil_participation_pct)],
      ['Édité le', new Date().toLocaleString('fr-FR')]
    ] },
    { name: 'Apparentés', rows: [['Nom', 'Lien', 'Nature', 'Vérification', 'Encours (FCFA)', 'Ratio FPE (%)', 'Dépassement']].concat(
      apparentes.map((a) => { const e = enc[a.nom_complet] || 0; const r = fpe.fpe_cents > 0 ? Number(((e / fpe.fpe_cents) * 100).toFixed(2)) : null; return [a.nom_complet, a.type_lien, a.nature_personne, a.statut_verification, e / 100, r === null ? '' : r, r !== null && r > Number(p.plafond_apparente_individuel_pct) ? 'OUI' : 'NON']; })) },
    { name: 'Conventions', rows: [['Référence', 'Date', 'Apparenté', 'Intéressé', 'Type', 'Objet', 'Montant (FCFA)', 'Statut', 'Autorisation', 'Vote exclu', 'CAC informé']].concat(
      conventions.map((c) => [c.reference, String(c.date_convention).slice(0, 10), c.apparente_nom, c.interessé_fonction || '', c.type_convention, c.objet || '', Number(c.montant_cents) / 100, c.statut, c.date_autorisation ? 'OUI' : 'NON', c.vote_exclu ? 'OUI' : 'NON', c.informe_cac ? 'OUI' : 'NON'])) },
    { name: 'Crédits apparentés', rows: [['Référence', 'Client', 'Code', 'Apparenté', 'Statut', 'Montant (FCFA)', 'Date']].concat(
      creditsApp.map((c) => [c.reference, c.client, c.code_client, c.apparente || '', c.status, Number(c.approved_amount_cents || c.amount_cents) / 100, String(c.created_at).slice(0, 10)])) },
    { name: 'Gouvernance', rows: [['Organe', 'Type', 'Membres', 'Dernière session']].concat(
      organes.map((o) => [o.libelle, o.type_organe, o.nombre_membres, o.derniere_session ? String(o.derniere_session).slice(0, 10) : ''])) }
  ];
  return buildXlsx(sheets);
}

/** Fichiers du Pack Inspection (7 dossiers numérotés). */
export async function collectPackInspection(imfId) {
  // Le recueil des données est protege : si une seule requete du dossier
  // principal echoue (table absente sur une base migree partiellement), on
  // repart d'un dossier VIDE plutot que de renvoyer une erreur au client.
  const d = await collectDossier(imfId).catch((e) => {
    console.warn('[pack-inspection] dossier incomplet :', String(e && e.message || e).slice(0, 200));
    const vide = { rows: [] };
    return {
      p: {}, forme: { titre_pluriel: 'parts sociales' }, fpe: { fpe_cents: 0, source: 'capital' },
      imf: {}, inst: {}, organes: [], membres: [], conventions: [], apparentes: [],
      creditsApp: [], risques: [], pca: [], incidents: [], lbc: [], echeances: [], effectif: 0
    };
  });
  const { p, forme, fpe, inst, organes, membres, conventions, apparentes, creditsApp, risques, pca, incidents, lbc, echeances, effectif } = d;
  const now = new Date();
  const jour = now.toISOString().slice(0, 10);
  const soc = (inst.raison_sociale || d.imf.name || 'IMF').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'IMF';
  const files = [];
  const add = (name, data) => files.push({ name, data });
  const csv = (rows) => '\ufeff' + rows.map((r) => r.map((c) => {
    const s = c == null ? '' : String(c);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\r\n') + '\r\n';

  const enTete = (titre) => [
    ['teebo — Pack Inspection Commission Bancaire'],
    [titre],
    ['Institution', inst.raison_sociale || d.imf.name],
    ['Pays', inst.pays || d.imf.country_code || ''],
    ['Généré le', now.toLocaleString('fr-FR')],
    []
  ];

  // 00 — sommaire
  add('00_SOMMAIRE.txt', [
    'PACK INSPECTION — COMMISSION BANCAIRE',
    '='.repeat(50),
    'Institution : ' + (inst.raison_sociale || d.imf.name),
    'Forme juridique : ' + (inst.forme_juridique || forme.forme_juridique) + ' (' + forme.titre_pluriel + ')',
    'Agrément : ' + (inst.numero_agrement || '—'),
    'Généré le : ' + now.toLocaleString('fr-FR'),
    '',
    'Contenu du pack :',
    '  01_GOUVERNANCE            fiche institution, organes, membres, mandats, sessions, résolutions',
    '  02_CONVENTIONS_APPARENTES apparentés, conventions réglementées, crédits aux apparentés',
    '  03_RISQUES_PCA            cartographie des risques, plans de continuité, incidents majeurs',
    '  04_CONFORMITE_LBCFT       formation du personnel, échéancier réglementaire',
    '  05_CREDITS                portefeuille de crédit (période récente)',
    '  06_CLIENTS                base clients (anonymisée sur demande)',
    '  07_ETATS_FINANCIERS       synthèse des ratios et des paramètres prudentiels',
    '',
    'Chaque dossier contient un fichier LISEZ-MOI.txt et des données au format CSV',
    '(séparateur point-virgule, encodage UTF-8, ouvrable dans Excel).',
    '',
    'Rappel : les paramètres prudentiels (plafonds, seuils) sont ceux retenus par',
    'l\'institution et doivent être confirmés auprès de la BCEAO ou de la Commission Bancaire.'
  ].join('\r\n'));

  // 01 — gouvernance
  // Chaque requête est protégée : une table non encore créée (base migrée
  // partiellement) ne doit JAMAIS faire échouer tout le pack (erreur 500).
  const safe = (sql, args) => q(sql, args).catch((e) => {
    console.warn('[pack-inspection] requete ignoree :', String(e && e.message || e).slice(0, 160));
    return { rows: [] };
  });
  const [mandats, sessions, resolutions] = await Promise.all([
    safe(`SELECT m.*, mb.nom_complet FROM mandats_instances m JOIN membres_gouvernance mb ON mb.id=m.membre_id AND mb.imf_id=m.imf_id WHERE m.imf_id=$1 ORDER BY m.date_debut DESC`, [imfId]),
    safe(`SELECT s.*, o.libelle AS organe FROM sessions_et_pv s LEFT JOIN organes_gouvernance o ON o.id=s.organe_id AND o.imf_id=s.imf_id WHERE s.imf_id=$1 ORDER BY s.date_session DESC`, [imfId]),
    safe(`SELECT * FROM resolutions_et_recommandations WHERE imf_id=$1 ORDER BY date_echeance NULLS LAST`, [imfId])
  ]);
  add('01_GOUVERNANCE/LISEZ-MOI.txt', 'Dossier 01 — Gouvernance : organes statutaires, membres, mandats, sessions et procès-verbaux, résolutions.');
  add('01_GOUVERNANCE/FICHE_INSTITUTION.csv', csv([...enTete('Fiche institution'),
    ['Raison sociale', inst.raison_sociale || d.imf.name], ['Forme juridique', inst.forme_juridique || ''],
    ['RCCM', inst.rccm || ''], ['IFU/NIF', inst.ifu_nif || ''], ['Agrément BCEAO', inst.numero_agrement || ''],
    ['Date agrément', inst.date_agrement ? String(inst.date_agrement).slice(0, 10) : ''],
    ['Capital social (FCFA)', inst.capital_social_cents != null ? Number(inst.capital_social_cents) / 100 : ''],
    ['Siège social', inst.siege_social || ''], ['Ville', inst.ville || ''], ['Pays', inst.pays || '']]));
  add('01_GOUVERNANCE/ORGANES.csv', csv(enTete('Organes de gouvernance').concat([['Libellé', 'Type', 'Membres', 'Quorum', 'Fréquence', 'Obligatoire', 'Statut']], organes.map((o) => [o.libelle, o.type_organe, o.nombre_membres, o.quorum_requis, o.frequence_reunion || '', o.obligatoire ? 'OUI' : 'NON', o.statut || '']))));
  add('01_GOUVERNANCE/MEMBRES.csv', csv(enTete('Membres de gouvernance').concat(
    [['Nom', 'Fonction', 'Organe', 'Qualité', 'Sexe', 'Entrée', 'Mandat', 'Titres (' + forme.titre_pluriel + ')', 'Participation (%)', 'Casier', 'Actif']],
    membres.map((m) => [m.nom_complet, m.fonction, m.organe_libelle || '', m.qualite || '', m.sexe || '', m.date_entree ? String(m.date_entree).slice(0, 10) : '', '', m.titres_detenus || 0, m.pct_participation == null ? '' : Number(m.pct_participation), m.casier_judiciaire_ok ? 'OUI' : 'NON', m.actif ? 'OUI' : 'NON']))));
  add('01_GOUVERNANCE/MANDATS.csv', csv(enTete('Mandats').concat([['Membre', 'Fonction', 'Début', 'Fin', 'Renouvellement', 'Statut']],
    mandats.rows.map((m) => [m.nom_complet, m.fonction, m.date_debut ? String(m.date_debut).slice(0, 10) : '', m.date_fin ? String(m.date_fin).slice(0, 10) : '', m.numero_renouvellement || 0, m.statut || '']))));
  add('01_GOUVERNANCE/SESSIONS_PV.csv', csv(enTete('Sessions et procès-verbaux').concat([['Date', 'Organe', 'Type', 'Présents', 'Quorum', 'PV', 'Statut']],
    sessions.rows.map((s) => [s.date_session ? String(s.date_session).slice(0, 10) : '', s.organe || '', s.type_session || '', s.nombre_presents || 0, s.quorum_requis || 0, s.pv_reference || '', s.statut || '']))));
  add('01_GOUVERNANCE/RESOLUTIONS.csv', csv(enTete('Résolutions et recommandations').concat([['Intitulé', 'Type', 'Responsable', 'Échéance', 'Avancement (%)', 'Statut']],
    resolutions.rows.map((x) => [x.intitule, x.type_element || '', x.responsable || '', x.date_echeance ? String(x.date_echeance).slice(0, 10) : '', x.taux_execution || 0, x.statut || '']))));

  // 02 — conventions & apparentés
  const enc = encoursParApparente(d);
  const totalEnc = Object.values(enc).reduce((s, x) => s + x, 0);
  add('02_CONVENTIONS_APPARENTES/LISEZ-MOI.txt', 'Dossier 02 — Conventions réglementées et crédits aux apparentés. Les titres sont des ' + forme.titre_pluriel + (forme.is_scoop ? ' (un membre = une voix).' : ' (les droits de vote suivent le nombre d\'actions).'));
  add('02_CONVENTIONS_APPARENTES/PARAMETRES.csv', csv(enTete('Paramètres prudentiels').concat(
    [['Paramètre', 'Valeur']],
    [['Fonds propres effectifs (FCFA)', fpe.fpe_cents / 100], ['Plafond individuel apparenté (%)', Number(p.plafond_apparente_individuel_pct)],
     ['Plafond global apparentés (%)', Number(p.plafond_apparentes_global_pct)], ['Seuil d\'information sur les titres (%)', Number(p.seuil_participation_pct)],
     ['Périmètre des apparentés', p.perimetre_apparentes], ['Encours total apparentés (FCFA)', totalEnc / 100]])));
  add('02_CONVENTIONS_APPARENTES/APPARENTES.csv', csv(enTete('Personnes apparentées').concat(
    [['Nom', 'Lien', 'Nature', 'Vérification', 'Encours (FCFA)', 'Ratio FPE (%)']],
    apparentes.map((a) => { const e = enc[a.nom_complet] || 0; return [a.nom_complet, a.type_lien, a.nature_personne, a.statut_verification, e / 100, fpe.fpe_cents > 0 ? Number(((e / fpe.fpe_cents) * 100).toFixed(2)) : '']; }))));
  add('02_CONVENTIONS_APPARENTES/CONVENTIONS.csv', csv(enTete('Conventions réglementées').concat(
    [['Réf.', 'Date', 'Apparenté', 'Type', 'Objet', 'Montant (FCFA)', 'Statut', 'Autorisation', 'Vote exclu', 'CAC informé']],
    conventions.map((c) => [c.reference, String(c.date_convention).slice(0, 10), c.apparente_nom, c.type_convention, c.objet || '', Number(c.montant_cents) / 100, c.statut, c.date_autorisation ? String(c.date_autorisation).slice(0, 10) : 'NON', c.vote_exclu ? 'OUI' : 'NON', c.informe_cac ? 'OUI' : 'NON']))));
  add('02_CONVENTIONS_APPARENTES/CREDITS_APPARENTES.csv', csv(enTete('Dossiers de crédit apparentés').concat(
    [['Référence', 'Client', 'Code', 'Apparenté', 'Statut', 'Montant (FCFA)', 'Date']],
    creditsApp.map((c) => [c.reference, c.client, c.code_client, c.apparente || '', c.status, Number(c.approved_amount_cents || c.amount_cents) / 100, String(c.created_at).slice(0, 10)]))));

  // 03 — risques & PCA
  add('03_RISQUES_PCA/LISEZ-MOI.txt', 'Dossier 03 — Cartographie des risques (matrice 4x4), plans de continuité d\'activité et incidents majeurs avec notification BCEAO.');
  add('03_RISQUES_PCA/CARTOGRAPHIE.csv', csv(enTete('Cartographie des risques').concat(
    [['Code', 'Libellé', 'Catégorie', 'Processus', 'Probabilité', 'Impact', 'Score', 'Prob. résiduelle', 'Impact résiduel', 'Dispositif', 'Responsable', 'Statut']],
    risques.map((r) => [r.code_risque || '', r.libelle, r.categorie, r.processus || '', r.probabilite, r.impact, r.probabilite * r.impact, r.probabilite_residuelle || '', r.impact_residuel || '', r.dispositif_maitrise || '', r.responsable || '', r.statut]))));
  add('03_RISQUES_PCA/PLANS_CONTINUITE.csv', csv(enTete('Plans de continuité').concat(
    [['Code', 'Libellé', 'Type', 'Responsable', 'Approbation', 'Dernière revue', 'Dernier exercice', 'Résultat', 'Statut']],
    pca.map((x) => [x.code_plan, x.libelle, x.type_plan, x.responsable || '', x.date_approbation ? String(x.date_approbation).slice(0, 10) : '', x.date_derniere_revue ? String(x.date_derniere_revue).slice(0, 10) : '', x.date_dernier_exercice ? String(x.date_dernier_exercice).slice(0, 10) : '', x.resultat_dernier_exercice || '', x.statut]))));
  add('03_RISQUES_PCA/INCIDENTS_MAJEURS.csv', csv(enTete('Incidents majeurs').concat(
    [['Référence', 'Date', 'Type', 'Gravité', 'Pertes (FCFA)', 'Notification BCEAO', 'Date notification', 'Réf. notification', 'Statut']],
    incidents.map((x) => [x.reference, String(x.date_incident).slice(0, 10), x.type_incident, x.gravite, Number(x.pertes_cents) / 100, x.notification_bceao ? 'OUI' : 'NON', x.date_notification ? String(x.date_notification).slice(0, 10) : '', x.reference_notification || '', x.statut]))));

  // 04 — LBC/FT & échéancier
  const formes = new Set(lbc.map((x) => x.app_user_id).filter(Boolean));
  add('04_CONFORMITE_LBCFT/LISEZ-MOI.txt', 'Dossier 04 — Formation du personnel à la lutte contre le blanchiment (LBC/FT) et échéancier des obligations réglementaires.');
  add('04_CONFORMITE_LBCFT/FORMATION_LBCFT.csv', csv(enTete('Formation LBC/FT').concat(
    [['Agent', 'Formation', 'Date', 'Organisme', 'Durée (h)', 'Attestation', 'Expiration']],
    lbc.map((x) => [x.agent || '', x.libelle || '', String(x.date_formation).slice(0, 10), x.organisme || '', x.duree_heures == null ? '' : Number(x.duree_heures), x.attestation_recue ? 'OUI' : 'NON', x.date_expiration ? String(x.date_expiration).slice(0, 10) : '']))));
  add('04_CONFORMITE_LBCFT/COUVERTURE.csv', csv(enTete('Couverture LBC/FT').concat([['Indicateur', 'Valeur'], ['Effectif actif', effectif], ['Agents formés', formes.size], ['Taux de couverture (%)', effectif ? Math.round((formes.size / effectif) * 100) : 0]])));
  add('04_CONFORMITE_LBCFT/ECHEANCIER.csv', csv(enTete('Échéancier réglementaire').concat(
    [['Obligation', 'Autorité', 'Catégorie', 'Périodicité', 'Échéance', 'Limite de dépôt', 'Statut', 'Dépôt', 'Réf. récépissé', 'Récépissé le', 'Responsable']],
    echeances.map((x) => [x.libelle, x.autorite, x.categorie, x.periodicite, String(x.date_echeance).slice(0, 10), x.date_limite_depot ? String(x.date_limite_depot).slice(0, 10) : '', x.statut, x.date_depot ? String(x.date_depot).slice(0, 10) : '', x.reference_recepisse || '', x.date_recepisse ? String(x.date_recepisse).slice(0, 10) : '', x.responsable || '']))));

  // 05 — crédits
  const credits = (await safe(`SELECT cf.reference, cf.status, cf.amount_cents, cf.approved_amount_cents, cf.duration_months,
      cf.purpose, cf.created_at, c.full_name AS client, c.code_client
      FROM credit_file cf JOIN client c ON c.id=cf.client_id WHERE cf.imf_id=$1 ORDER BY cf.created_at DESC LIMIT 5000`, [imfId])).rows || [];
  add('05_CREDITS/LISEZ-MOI.txt', 'Dossier 05 — Portefeuille de crédit (5 000 dossiers les plus récents).');
  add('05_CREDITS/PORTEFEUILLE.csv', csv(enTete('Portefeuille de crédit').concat(
    [['Référence', 'Client', 'Code', 'Statut', 'Montant demandé (FCFA)', 'Montant approuvé (FCFA)', 'Durée (mois)', 'Objet', 'Date']],
    credits.map((c) => [c.reference, c.client, c.code_client, c.status, Number(c.amount_cents) / 100, c.approved_amount_cents == null ? '' : Number(c.approved_amount_cents) / 100, c.duration_months || '', c.purpose || '', String(c.created_at).slice(0, 10)]))));

  // 06 — clients
  const clients = (await safe(`SELECT code_client, full_name, phone, city, created_at, status FROM client WHERE imf_id=$1 ORDER BY created_at DESC LIMIT 5000`, [imfId])).rows || [];
  add('06_CLIENTS/LISEZ-MOI.txt', 'Dossier 06 — Base clients (5 000 plus récents). À anonymiser si la Commission le demande.');
  add('06_CLIENTS/CLIENTS.csv', csv(enTete('Base clients').concat([['Code', 'Nom', 'Téléphone', 'Ville', 'Créé le', 'Statut']],
    clients.map((c) => [c.code_client, c.full_name, c.phone || '', c.city || '', String(c.created_at).slice(0, 10), c.status || '']))));

  // 07 — états financiers / ratios
  const tot = ((await safe(`SELECT COUNT(*)::int AS n, COALESCE(SUM(balance_cents),0)::bigint AS s FROM account WHERE imf_id=$1`, [imfId])).rows || [])[0]
    || { n: 0, s: 0 };
  add('07_ETATS_FINANCIERS/LISEZ-MOI.txt', 'Dossier 07 — Synthèse des agrégats et des paramètres prudentiels applicables.');
  add('07_ETATS_FINANCIERS/RATIOS.csv', csv(enTete('Synthèse des agrégats').concat(
    [['Indicateur', 'Valeur']],
    [['Fonds propres effectifs (FCFA)', fpe.fpe_cents / 100], ['Encours crédits apparentés (FCFA)', totalEnc / 100],
     ['Ratio apparentés / FPE (%)', fpe.fpe_cents > 0 ? Number(((totalEnc / fpe.fpe_cents) * 100).toFixed(2)) : ''],
     ['Plafond global apparentés (%)', Number(p.plafond_apparentes_global_pct)], ['Plafond individuel apparentés (%)', Number(p.plafond_apparente_individuel_pct)],
     ['Comptes actifs', tot.n], ['Solde des comptes (FCFA)', Number(tot.s) / 100], ['Dossiers de crédit', credits.length]])));

  return { files, soc, jour };
}

/** Enregistre la trace de l'export. */
export async function logExport(imfId, userId, type, details) {
  // La trace ne doit JAMAIS bloquer l'export. Deux protections :
  //  1) le type est normalisé (l'ancienne contrainte CHECK de la table ne
  //     connaissait que trois valeurs : un type inconnu renvoyait une erreur
  //     500 au lieu de produire le fichier) ;
  //  2) si la table ou sa contrainte divergente subsiste en base, la trace est
  //     simplement abandonnée après un avertissement dans les journaux.
  const TYPES = ['RAPPORT_CAC_PDF', 'RAPPORT_CAC_EXCEL', 'PACK_INSPECTION_ZIP',
    'FEUILLE_PRESENCE_AG_PDF', 'FEUILLE_PRESENCE_AG_EXCEL'];
  const safeType = TYPES.includes(type) ? type : 'PACK_INSPECTION_ZIP';
  try {
    await q(`INSERT INTO gouvernance_export_log (imf_id, type_export, details, created_by) VALUES ($1,$2,$3::jsonb,$4)`,
      [imfId, safeType, JSON.stringify(details || {}), userId || null]);
  } catch (e) {
    console.warn('[export] trace non enregistree :', String(e && e.message || e).slice(0, 200));
  }
}
