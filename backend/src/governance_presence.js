// teebo — FEUILLE DE PRÉSENCE D'ASSEMBLÉE GÉNÉRALE (vague 33)
// ---------------------------------------------------------------------------
// Deux sorties pour la même donnée :
//   • PDF   : document A4 imprimable (émargements, procurations, quorum),
//             destiné à être signé et classé au dossier de l'AG ;
//   • Excel : registre reprenant les mêmes lignes, pour vérification et
//             archivage par le commissaire aux comptes.
//
// Le quorum affiché est celui du MOTEUR (recalculerQuorum) : il est identique
// à celui de l'écran, donc aucun écart entre le document signé et l'écran.
// ---------------------------------------------------------------------------
import { q } from './db.js';
import { fmtDate, moneyFcfa } from './documents.js';
import {
  syntheseCapital, recalculerQuorum, formeJuridique
} from './capital_engine.js';
import { buildXlsx } from './governance_exports.js';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const F = (d) => (d ? fmtDate(d) : '—');
const M = (c) => (c == null ? '—' : moneyFcfa(Number(c)));
const pc = (v) => (v == null ? '—' : String(Number(v).toFixed(2)).replace('.', ',') + ' %');
const NUM = (v) => Number(v || 0).toLocaleString('fr-FR');

const MODES = {
  PRESENT: 'Présent',
  REPRESENTE_PROCURATION: 'Représenté(e) par procuration',
  VISIOCONFERENCE: 'Visioconférence',
  ABSENT: 'Absent(e)'
};

/** Rassemble tout ce qu'il faut pour éditer la feuille de présence. */
export async function collectFeuillePresence(imfId, sessionId) {
  if (!sessionId) return { error: 'session_required' };
  const { rows: s } = await q(
    `SELECT s.*, o.libelle AS organe_libelle, o.type_organe
       FROM sessions_et_pv s
       LEFT JOIN organes_gouvernance o ON o.id=s.organe_id AND o.imf_id=s.imf_id
      WHERE s.id=$1 AND s.imf_id=$2`, [sessionId, imfId]);
  if (!s.length) return { error: 'session_not_found' };
  const session = s[0];

  const { rows: inst } = await q(
    'SELECT * FROM institution_gouvernance WHERE imf_id=$1', [imfId]);
  const { rows: imf } = await q('SELECT name, code_imf, city, country_code FROM imf WHERE id=$1', [imfId]);

  const { rows: lignes } = await q(
    `SELECT l.mode_participation, l.nombre_titres_retenus, l.nombre_voix_attribuees,
            l.procuration_url, l.emargement_at, l.observation,
            d.nom_ou_raison_sociale, d.numero_registre, d.categorie, d.type_entite,
            md.nom_ou_raison_sociale AS mandataire_nom, md.numero_registre AS mandataire_registre
       FROM feuille_presence_ag l
       JOIN detenteurs_capital d ON d.id=l.detenteur_id AND d.imf_id=l.imf_id
       LEFT JOIN detenteurs_capital md ON md.id=l.mandataire_id AND md.imf_id=l.imf_id
      WHERE l.session_id=$1 AND l.imf_id=$2
      ORDER BY d.nom_ou_raison_sociale`, [sessionId, imfId]);

  // Le quorum est recalculé (et figé dans ag_quorum) au moment de l'édition :
  // le document porte donc la situation exacte à l'impression.
  const quorum = await recalculerQuorum(imfId, sessionId).catch(() => null);
  const syn = await syntheseCapital(imfId).catch(() => null);
  const { coop } = await formeJuridique(imfId).catch(() => ({ coop: false }));

  // Participants non encore émargés : listés en bas pour signature manuscrite.
  const emarges = new Set(lignes.map((l) => l.numero_registre || l.nom_ou_raison_sociale));
  const nonEmarges = (syn ? syn.actifs : []).filter((d) => !emarges.has(d.numero_registre || d.nom_ou_raison_sociale));

  return {
    session, imf: imf[0] || {}, institution: inst[0] || {},
    lignes, quorum, syn, coop,
    non_emarges: nonEmarges.map((d) => ({
      nom_ou_raison_sociale: d.nom_ou_raison_sociale, numero_registre: d.numero_registre,
      categorie: d.categorie, titres: d.titres
    }))
  };
}

const PRES_CSS = `
 *{box-sizing:border-box;margin:0;padding:0}
 body{font-family:'Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;color:#0b0c26;background:#eef0f6;padding:22px}
 .sheet{max-width:980px;margin:0 auto 18px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 14px 44px rgba(11,12,38,.14)}
 .band{background:#0b0c26;color:#fff;padding:26px 38px 22px;display:flex;justify-content:space-between;gap:26px;align-items:flex-start}
 .band h1{font-size:18px;line-height:1.3;letter-spacing:-.3px}
 .band .sub{margin-top:9px;font-size:11.5px;line-height:1.7;color:#c9cce0}
 .band .sub b{color:#fff}
 .stamp{border:1px solid #d8f500;color:#d8f500;border-radius:999px;padding:7px 14px;font-size:10.5px;font-weight:800;letter-spacing:.9px;white-space:nowrap;height:fit-content}
 .body{padding:24px 38px 30px}
 .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:6px}
 .kpi{border:1px solid #e3e5ee;border-radius:11px;padding:13px 14px;background:#fbfbfe}
 .kpi span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#61647c;margin-bottom:6px}
 .kpi b{display:block;font-size:17px;letter-spacing:-.3px;line-height:1.25}
 .kpi small{display:block;font-size:10.5px;color:#61647c;margin-top:4px}
 .kpi.is-ok{border-color:#cbe3ad;background:#f8fcf2}.kpi.is-ok b{color:#2f6b00}
 .kpi.is-bad{border-color:#f0b7b1;background:#fdf6f5}.kpi.is-bad b{color:#b3261e}
 h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.9px;margin:24px 0 10px;padding-bottom:6px;border-bottom:2px solid #0b0c26;display:flex;justify-content:space-between;align-items:baseline}
 h2 em{font-style:normal;font-size:10.5px;letter-spacing:.4px;color:#61647c;text-transform:none}
 table{width:100%;border-collapse:collapse;font-size:11px}
 thead th{background:#f0f1f7;color:#3b3e58;font-size:9.5px;letter-spacing:.7px;text-transform:uppercase;padding:8px 9px;text-align:left;border-bottom:1px solid #d9dbe7;font-weight:700}
 td{padding:8px 9px;border-bottom:1px solid #eceef5;vertical-align:top;line-height:1.45}
 tbody tr:nth-child(even){background:#fafbfe}
 td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
 td.sign{height:30px;border-bottom:1px solid #b9bccd}
 .pill{display:inline-block;font-size:9.5px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap}
 .pill.ok{background:#e8f5d8;color:#2f6b00}.pill.bad{background:#fdeceb;color:#b3261e}
 .pill.mid{background:#fff4dc;color:#8a5a00}.pill.grey{background:#eef0f6;color:#525570}
 .empty{border:1px dashed #d9dbe7;border-radius:10px;padding:14px 16px;font-size:11.5px;color:#525570;background:#fbfbfe}
 .empty b{color:#0b0c26}
 .signs{margin-top:26px;display:flex;gap:34px;font-size:11px;color:#525570}
 .signs div{flex:1;border-top:1px solid #b9bccd;padding-top:8px}
 .foot{background:#f0f1f7;color:#61647c;font-size:9.5px;padding:11px 38px;display:flex;justify-content:space-between;gap:16px;line-height:1.5}
 @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0;max-width:none;margin:0}
  .band{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h2{break-after:avoid}tr{break-inside:avoid}@page{size:A4 landscape;margin:10mm}}
`;

/** Feuille de présence — document A4 (imprimable / PDF via le navigateur). */
export function feuillePresenceHtml(d) {
  const { session, imf, institution, lignes, quorum, coop, non_emarges } = d;
  const nom = institution.raison_sociale || imf.name || 'Institution';
  const titre = coop ? 'parts sociales' : 'actions';
  const q = quorum || {};
  const atteint = q.quorum_atteint === true;
  const presents = lignes.filter((l) => l.mode_participation !== 'ABSENT');
  const procurations = lignes.filter((l) => l.mode_participation === 'REPRESENTE_PROCURATION');
  const titresRetenus = presents.reduce((a, l) => a + Number(l.nombre_titres_retenus || 0), 0);
  const totalVoix = Number(q.voix_total || 0);

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feuille de présence — ${esc(nom)} — ${esc(F(session.date_session))}</title>
<style>${PRES_CSS}</style></head><body>
<div class="sheet">
 <div class="band">
  <div>
   <h1>Feuille de présence — ${session.ag_extraordinaire || session.type_session === 'EXTRAORDINAIRE' ? 'Assemblée Générale Extraordinaire' : 'Assemblée Générale Ordinaire'}</h1>
   <div class="sub"><b>${esc(nom)}</b> · ${esc(institution.forme_juridique || (coop ? 'SCOOPS' : 'SA'))}<br>
   ${esc(session.organe_libelle || 'Assemblée Générale')} · ${esc(F(session.date_session))}${session.lieu ? ' · ' + esc(session.lieu) : ''}<br>
   RCCM ${esc(institution.rccm || '—')} · Agrément BCEAO ${esc(institution.numero_agrement || '—')}</div>
  </div>
  <div class="stamp">${coop ? '1 MEMBRE = 1 VOIX' : '1 ACTION = 1 VOIX'}</div>
 </div>
 <div class="body">
  <div class="kpis">
   <div class="kpi"><span>${coop ? 'Membres inscrits' : 'Droits de vote'}</span><b>${NUM(coop ? q.membres_total : totalVoix)}</b><small>${esc(q.base_calcul === 'MEMBRES' ? 'base : membres inscrits' : 'base : droits de vote')}</small></div>
   <div class="kpi"><span>Présents / représentés</span><b>${NUM(q.membres_presents || 0)} + ${NUM(q.membres_representes || 0)}</b><small>${NUM(procurations.length)} procuration(s)</small></div>
   <div class="kpi ${atteint ? 'is-ok' : 'is-bad'}"><span>Quorum atteint</span><b>${pc(q.pourcentage)}</b><small>requis ${pc(q.quorum_requis_pct)}${q.manque ? ' · manque ' + pc(q.manque) : ''}</small></div>
   <div class="kpi"><span>${coop ? 'Parts représentées' : 'Actions représentées'}</span><b>${NUM(titresRetenus)}</b><small>sur ${NUM(d.syn ? d.syn.titres_total : 0)} ${esc(titre)} en circulation</small></div>
  </div>
  <p class="empty" style="margin-top:14px">${atteint
    ? '<b>Quorum atteint.</b> L’assemblée peut valablement délibérer sur les résolutions inscrites à l’ordre du jour.'
    : '<b>Quorum non atteint.</b> L’assemblée ne peut pas délibérer valablement ; une seconde convocation doit être adressée aux ' + (coop ? 'sociétaires' : 'actionnaires') + '.'}</p>

  <h2>Émargement des participants <em>${presents.length} ligne(s)</em></h2>
  ${presents.length ? `<table><thead><tr><th>Nom / raison sociale</th><th>N° registre</th><th>Qualité</th>
   <th>Mode</th><th>Mandataire</th><th style="text-align:right">${coop ? 'Parts' : 'Actions'}</th>
   <th style="text-align:right">Voix</th><th style="width:150px">Signature</th></tr></thead><tbody>
   ${presents.map((l) => `<tr><td><b>${esc(l.nom_ou_raison_sociale)}</b></td><td>${esc(l.numero_registre)}</td>
    <td>${esc(l.type_entite === 'PERSONNE_MORALE' ? 'Personne morale' : (coop ? 'Sociétaire' : 'Actionnaire'))}</td>
    <td>${esc(MODES[l.mode_participation] || l.mode_participation)}</td>
    <td>${esc(l.mandataire_nom || '—')}</td>
    <td class="num">${NUM(l.nombre_titres_retenus)}</td>
    <td class="num">${NUM(l.nombre_voix_attribuees)}</td>
    <td class="sign"></td></tr>`).join('')}
   </tbody></table>` : `<div class="empty"><b>Aucun émargement enregistré.</b><br>La feuille peut être remplie à la main lors de la séance, puis saisie dans <b>Gouvernance › Actionnariat</b>.</div>`}

  ${procurations.length ? `<h2>Procurations <em>${procurations.length}</em></h2>
   <table><thead><tr><th>Mandant</th><th>Mandataire</th><th style="text-align:right">${coop ? 'Parts' : 'Actions'}</th><th style="text-align:right">Voix portées</th><th>Pièce</th></tr></thead><tbody>
   ${procurations.map((l) => `<tr><td><b>${esc(l.nom_ou_raison_sociale)}</b></td><td>${esc(l.mandataire_nom || '—')}</td>
    <td class="num">${NUM(l.nombre_titres_retenus)}</td><td class="num">${NUM(l.nombre_voix_attribuees)}</td>
    <td>${l.procuration_url ? '<span class="pill ok">téléversée</span>' : '<span class="pill mid">à classer</span>'}</td></tr>`).join('')}
   </tbody></table>` : ''}

  ${non_emarges && non_emarges.length ? `<h2>${coop ? 'Sociétaires' : 'Actionnaires'} non encore émargés <em>${non_emarges.length} — signature manuscrite</em></h2>
   <table><thead><tr><th>Nom / raison sociale</th><th>N° registre</th><th style="text-align:right">${coop ? 'Parts' : 'Actions'}</th><th style="width:220px">Signature</th></tr></thead><tbody>
   ${non_emarges.map((x) => `<tr><td>${esc(x.nom_ou_raison_sociale)}</td><td>${esc(x.numero_registre)}</td>
    <td class="num">${NUM(x.titres)}</td><td class="sign"></td></tr>`).join('')}
   </tbody></table>` : ''}

  <div class="signs">
   <div>Le Président de séance<br><span style="font-size:10px">nom, date et signature</span></div>
   <div>Le Secrétaire de séance<br><span style="font-size:10px">nom, date et signature</span></div>
  </div>
 </div>
 <div class="foot"><span>Document confidentiel — ${esc(nom)} · feuille de présence ${esc(session.pv_reference || '')}</span>
  <span>Quorum calculé le ${esc(new Date().toLocaleString('fr-FR'))} · ${esc(q.base_calcul === 'MEMBRES' ? 'base membres' : 'base droits de vote')}</span></div>
</div></body></html>`;
}

/** Feuille de présence — classeur Excel (registre exploitable). */
export function feuillePresenceXlsx(d) {
  const { session, imf, institution, lignes, quorum, coop, non_emarges, syn } = d;
  const nom = institution.raison_sociale || imf.name || 'Institution';
  const q = quorum || {};
  const presents = lignes.filter((l) => l.mode_participation !== 'ABSENT');
  const sheets = [
    {
      name: 'Feuille de présence',
      rows: [
        ['FEUILLE DE PRÉSENCE — ' + (session.ag_extraordinaire || session.type_session === 'EXTRAORDINAIRE' ? 'ASSEMBLÉE GÉNÉRALE EXTRAORDINAIRE' : 'ASSEMBLÉE GÉNÉRALE ORDINAIRE')],
        ['Institution', nom],
        ['Forme juridique', institution.forme_juridique || (coop ? 'SCOOPS' : 'SA')],
        ['Organe', session.organe_libelle || 'Assemblée Générale'],
        ['Date de la séance', String(session.date_session || '').slice(0, 10)],
        ['Lieu', session.lieu || ''],
        ['Référence du PV', session.pv_reference || ''],
        ['Règle de vote', coop ? '1 membre = 1 voix' : '1 action = 1 voix'],
        ['Base du quorum', q.base_calcul === 'MEMBRES' ? 'Membres inscrits' : 'Droits de vote'],
        ['Quorum requis (%)', q.quorum_requis_pct != null ? Number(q.quorum_requis_pct) : ''],
        ['Quorum atteint (%)', q.pourcentage != null ? Number(q.pourcentage) : ''],
        ['Quorum atteint', q.quorum_atteint === true ? 'OUI' : (q.quorum_atteint === false ? 'NON' : '')],
        ['Présents', Number(q.membres_presents || 0)],
        ['Représentés', Number(q.membres_representes || 0)],
        ['Titres représentés', presents.reduce((a, l) => a + Number(l.nombre_titres_retenus || 0), 0)],
        ['Titres en circulation', syn ? Number(syn.titres_total || 0) : ''],
        ['Édité le', new Date().toLocaleString('fr-FR')],
        [],
        ['Nom / raison sociale', 'N° registre', 'Qualité', 'Mode de participation', 'Mandataire',
          coop ? 'Parts sociales' : 'Actions', 'Voix', 'Émargement', 'Signature']
      ].concat(presents.map((l) => [
        l.nom_ou_raison_sociale, l.numero_registre,
        l.type_entite === 'PERSONNE_MORALE' ? 'Personne morale' : (coop ? 'Sociétaire' : 'Actionnaire'),
        MODES[l.mode_participation] || l.mode_participation,
        l.mandataire_nom || '', Number(l.nombre_titres_retenus || 0), Number(l.nombre_voix_attribuees || 0),
        l.emargement_at ? 'émargé' : 'non émargé', ''
      ]))
    },
    {
      name: 'Procurations',
      rows: [['Mandant', 'Mandataire', 'Titres', 'Voix portées', 'Pièce jointe']].concat(
        lignes.filter((l) => l.mode_participation === 'REPRESENTE_PROCURATION').map((l) => [
          l.nom_ou_raison_sociale, l.mandataire_nom || '', Number(l.nombre_titres_retenus || 0),
          Number(l.nombre_voix_attribuees || 0), l.procuration_url ? 'oui' : 'non'
        ]))
    },
    {
      name: 'À émarger',
      rows: [['Nom / raison sociale', 'N° registre', coop ? 'Parts sociales' : 'Actions', 'Signature']]
        .concat((non_emarges || []).map((x) => [x.nom_ou_raison_sociale, x.numero_registre, Number(x.titres || 0), '']))
    }
  ];
  return buildXlsx(sheets);
}
