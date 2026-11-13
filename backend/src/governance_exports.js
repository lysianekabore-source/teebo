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

/** Rapport Spécial CAC — HTML imprimable (PDF via le navigateur). */
export function rapportCacHtml(d) {
  const { p, forme, fpe, inst, organes, membres, conventions, apparentes, creditsApp, risques, pca, incidents, lbc, echeances, effectif } = d;
  const enc = encoursParApparente(d);
  const totalEnc = Object.values(enc).reduce((s, x) => s + x, 0);
  const ratioGlobal = fpe.fpe_cents > 0 ? (totalEnc / fpe.fpe_cents) * 100 : null;
  const formes = new Set(lbc.map((x) => x.app_user_id).filter(Boolean));
  const tauxLbc = effectif ? Math.round((formes.size / effectif) * 100) : 0;
  const retard = echeances.filter((x) => x.statut !== 'RECEPISSE_RECU' && x.statut !== 'SANS_OBJET' && String(x.date_limite_depot || x.date_echeance).slice(0, 10) < new Date().toISOString().slice(0, 10));
  const titre = forme.is_scoop ? 'parts sociales' : 'actions';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Rapport spécial du Commissaire aux Comptes — ${esc(inst.raison_sociale || d.imf.name)}</title>
<style>
 *{box-sizing:border-box;margin:0;padding:0}
 body{font-family:'Segoe UI',system-ui,Arial,sans-serif;color:#0b0c26;background:#eef0f6;padding:24px}
 .sheet{max-width:900px;margin:0 auto;background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(11,12,38,.12);padding:36px 40px}
 .head{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #0b0c26;padding-bottom:16px}
 h1{font-size:19px} .m{font-size:11.5px;color:#61647c;line-height:1.6;margin-top:6px}
 .tag{background:#d8f500;color:#0b0c26;font-weight:800;font-size:11px;padding:6px 12px;border-radius:999px;height:fit-content;white-space:nowrap}
 h2{font-size:13px;text-transform:uppercase;letter-spacing:.6px;margin:22px 0 8px;border-bottom:1px solid #e3e5ee;padding-bottom:5px}
 table{width:100%;border-collapse:collapse} th{background:#0b0c26;color:#fff;font-size:10.5px;text-transform:uppercase;padding:7px 9px;text-align:left}
 td{padding:7px 9px;border-bottom:1px solid #e3e5ee;font-size:12px;vertical-align:top}
 tr:nth-child(even) td{background:#f6f7fb} .bad{color:#b3261e;font-weight:700}.ok{color:#2f6b00;font-weight:700}
 .kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}
 .kpi div{background:#f6f7fb;border:1px solid #e3e5ee;border-radius:9px;padding:11px}
 .kpi b{display:block;font-size:20px} .kpi span{font-size:10.5px;color:#61647c}
 p{font-size:12px;line-height:1.65;margin:8px 0}
 .foot{margin-top:24px;border-top:1px solid #e3e5ee;padding-top:10px;font-size:10.5px;color:#61647c;display:flex;justify-content:space-between}
 @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0;max-width:none;padding:0}@page{size:A4;margin:12mm}}
</style></head><body><div class="sheet">
<div class="head"><div><h1>Rapport spécial sur les conventions réglementées et les crédits aux personnes apparentées</h1>
<div class="m"><b>${esc(inst.raison_sociale || d.imf.name)}</b> · ${esc(inst.forme_juridique || forme.forme_juridique)} · RCCM ${esc(inst.rccm || '—')}<br>
Agrément BCEAO ${esc(inst.numero_agrement || '—')} · ${esc(inst.siege_social || '—')}<br>
Exercice arrêté le ${F(new Date())}</div></div><div class="tag">RAPPORT DU CAC</div></div>

<h2>1. Objet du rapport</h2>
<p>En application des textes régissant les sociétés commerciales et coopératives de l'Union, le Commissaire aux Comptes présente son rapport spécial sur les conventions intervenues entre l'institution et ses administrateurs, dirigeants et personnes qui leur sont liées, ainsi que sur les concours consentis aux personnes apparentées. Dans une société coopérative, les titres détenus sont des <b>${esc(titre)}</b> et chaque membre dispose d'une seule voix à l'assemblée, quel que soit le nombre de parts.</p>

<h2>2. Fonds propres effectifs et plafonds prudentiels</h2>
<div class="kpi"><div><b>${M(fpe.fpe_cents)}</b><span>Fonds propres effectifs (${esc(fpe.source === 'saisie' ? 'saisis' : 'capital social')})</span></div>
<div><b>${M(totalEnc)}</b><span>Encours crédits apparentés</span></div>
<div><b>${pc(ratioGlobal)}</b><span>Ratio global (plafond ${pc(p.plafond_apparentes_global_pct)})</span></div>
<div><b>${pctConforme(ratioGlobal, p.plafond_apparentes_global_pct)}</b><span>Respect du plafond global</span></div></div>
<p>Plafond individuel retenu : <b>${pc(p.plafond_apparente_individuel_pct)}</b> des fonds propres effectifs ; plafond global : <b>${pc(p.plafond_apparentes_global_pct)}</b> ; seuil d'information sur les ${esc(titre)} : <b>${pc(p.seuil_participation_pct)}</b>. Ces paramètres sont ceux retenus par l'institution et doivent être confirmés auprès de la BCEAO.</p>

<h2>3. Personnes apparentées recensées (${apparentes.length})</h2>
<table><tr><th>Nom</th><th>Lien</th><th>Nature</th><th>Vérification</th><th>Encours crédits</th><th>Ratio FPE</th></tr>
${apparentes.map((a) => { const e = enc[a.nom_complet] || 0; const r = fpe.fpe_cents > 0 ? (e / fpe.fpe_cents) * 100 : null; return `<tr><td>${esc(a.nom_complet)}</td><td>${esc(a.type_lien)}</td><td>${esc(a.nature_personne)}</td><td>${esc(a.statut_verification)}</td><td>${M(e)}</td><td class="${r !== null && r > Number(p.plafond_apparente_individuel_pct) ? 'bad' : ''}">${pc(r)}</td></tr>`; }).join('') || '<tr><td colspan="6">Aucun apparenté recensé.</td></tr>'}</table>

<h2>4. Conventions réglementées (${conventions.length})</h2>
<table><tr><th>Réf.</th><th>Date</th><th>Apparenté</th><th>Type</th><th>Montant</th><th>Autorisation</th><th>Vote</th><th>CAC</th></tr>
${conventions.map((c) => `<tr><td>${esc(c.reference)}</td><td>${F(c.date_convention)}</td><td>${esc(c.apparente_nom)}</td><td>${esc(c.type_convention)}</td><td>${M(c.montant_cents)}</td><td>${c.date_autorisation ? esc(c.organe_autorisation || 'Autorisée') + ' le ' + F(c.date_autorisation) : '<span class="bad">Non autorisée</span>'}</td><td>${c.vote_exclu ? 'Exclu' : '—'}</td><td>${c.informe_cac ? 'Oui' : '<span class="bad">Non</span>'}</td></tr>`).join('') || '<tr><td colspan="8">Aucune convention réglementée.</td></tr>'}</table>

<h2>5. Dossiers de crédit aux apparentés (${creditsApp.length})</h2>
<table><tr><th>Référence</th><th>Client</th><th>Apparenté</th><th>Statut</th><th>Montant</th><th>Date</th></tr>
${creditsApp.map((c) => `<tr><td>${esc(c.reference)}</td><td>${esc(c.client)} (${esc(c.code_client)})</td><td>${esc(c.apparente || '—')}</td><td>${esc(c.status)}</td><td>${M(c.approved_amount_cents || c.amount_cents)}</td><td>${F(c.created_at)}</td></tr>`).join('') || '<tr><td colspan="6">Aucun crédit identifié comme apparenté.</td></tr>'}</table>

<h2>6. Gouvernance</h2>
<table><tr><th>Organe</th><th>Type</th><th>Membres</th><th>Sessions</th></tr>
${organes.map((o) => `<tr><td>${esc(o.libelle)}</td><td>${esc(o.type_organe)}</td><td>${o.nombre_membres}</td><td>${o.derniere_session ? F(o.derniere_session) : '—'}</td></tr>`).join('') || '<tr><td colspan="4">Aucun organe enregistré.</td></tr>'}</table>
<p>${membres.filter((m) => m.actif).length} membre(s) actif(s), dont ${membres.filter((m) => m.actif && m.sexe === 'F').length} femme(s). Indemnités et rémunérations des dirigeants : à détailler le cas échéant (informations issues de la comptabilité).</p>

<h2>7. Contrôle interne, risques et continuité d'activité</h2>
<p>${risques.length} risque(s) cartographié(s), dont ${risques.filter((r) => r.probabilite * r.impact >= 12).length} critique(s). ${pca.length} plan(s) de continuité ; ${pca.filter((x) => x.statut === 'REVISION_REQUISE').length} à réviser. ${incidents.filter((i) => i.notification_bceao_requise && !i.notification_bceao).length} incident(s) majeur(s) non notifié(s) à la BCEAO. Personnel formé LBC/FT : ${tauxLbc} % (${formes.size}/${effectif}).</p>

<h2>8. Échéancier réglementaire</h2>
<p>${echeances.length} obligation(s) suivie(s) ; <b class="${retard.length ? 'bad' : 'ok'}">${retard.length} en retard sans récépissé</b>, ${echeances.filter((x) => x.date_recepisse).length} avec récépissé reçu.</p>

<h2>9. Conclusion du Commissaire aux Comptes</h2>
<p>Les conventions et concours ci-dessus ont été examinés au regard de l'intérêt de l'institution. ${conventions.filter((c) => !c.date_autorisation).length ? 'Certaines conventions n\'ont pas fait l\'objet d\'une autorisation préalable : elles doivent être soumises au conseil.' : 'Toutes les conventions soumises ont fait l\'objet d\'une autorisation préalable.'} ${retard.length ? 'Des obligations réglementaires sont en retard de dépôt et doivent être régularisées sans délai.' : 'L\'échéancier réglementaire est tenu à jour.'}</p>

<div class="foot"><span>${esc(inst.raison_sociale || d.imf.name)} — document confidentiel destiné au Conseil d'Administration et au CAC</span><span>Édité avec teeBo — ${new Date().toLocaleString('fr-FR')}</span></div>
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
  const d = await collectDossier(imfId);
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
  const [mandats, sessions, resolutions] = await Promise.all([
    q(`SELECT m.*, mb.nom_complet FROM mandats_instances m JOIN membres_gouvernance mb ON mb.id=m.membre_id AND mb.imf_id=m.imf_id WHERE m.imf_id=$1 ORDER BY m.date_debut DESC`, [imfId]),
    q(`SELECT s.*, o.libelle AS organe FROM sessions_et_pv s LEFT JOIN organes_gouvernance o ON o.id=s.organe_id AND o.imf_id=s.imf_id WHERE s.imf_id=$1 ORDER BY s.date_session DESC`, [imfId]),
    q(`SELECT * FROM resolutions_et_recommandations WHERE imf_id=$1 ORDER BY date_echeance NULLS LAST`, [imfId])
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
  const credits = (await q(`SELECT cf.reference, cf.status, cf.amount_cents, cf.approved_amount_cents, cf.duration_months,
      cf.purpose, cf.created_at, c.full_name AS client, c.code_client
      FROM credit_file cf JOIN client c ON c.id=cf.client_id WHERE cf.imf_id=$1 ORDER BY cf.created_at DESC LIMIT 5000`, [imfId])).rows;
  add('05_CREDITS/LISEZ-MOI.txt', 'Dossier 05 — Portefeuille de crédit (5 000 dossiers les plus récents).');
  add('05_CREDITS/PORTEFEUILLE.csv', csv(enTete('Portefeuille de crédit').concat(
    [['Référence', 'Client', 'Code', 'Statut', 'Montant demandé (FCFA)', 'Montant approuvé (FCFA)', 'Durée (mois)', 'Objet', 'Date']],
    credits.map((c) => [c.reference, c.client, c.code_client, c.status, Number(c.amount_cents) / 100, c.approved_amount_cents == null ? '' : Number(c.approved_amount_cents) / 100, c.duration_months || '', c.purpose || '', String(c.created_at).slice(0, 10)]))));

  // 06 — clients
  const clients = (await q(`SELECT code_client, full_name, phone, city, created_at, status FROM client WHERE imf_id=$1 ORDER BY created_at DESC LIMIT 5000`, [imfId]).rows);
  add('06_CLIENTS/LISEZ-MOI.txt', 'Dossier 06 — Base clients (5 000 plus récents). À anonymiser si la Commission le demande.');
  add('06_CLIENTS/CLIENTS.csv', csv(enTete('Base clients').concat([['Code', 'Nom', 'Téléphone', 'Ville', 'Créé le', 'Statut']],
    clients.map((c) => [c.code_client, c.full_name, c.phone || '', c.city || '', String(c.created_at).slice(0, 10), c.status || '']))));

  // 07 — états financiers / ratios
  const tot = (await q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(balance_cents),0)::bigint AS s FROM account WHERE imf_id=$1`, [imfId])).rows[0];
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
  try {
    await q(`INSERT INTO gouvernance_export_log (imf_id, type_export, details, created_by) VALUES ($1,$2,$3::jsonb,$4)`,
      [imfId, type, JSON.stringify(details || {}), userId]);
  } catch (e) { /* la trace ne doit jamais bloquer l'export */ }
}
