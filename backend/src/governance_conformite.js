// teebo — GOUVERNANCE : CONFORMITÉ PRUDENTIELLE & RÉGLEMENTAIRE (VAGUE 29)
// ---------------------------------------------------------------------------
// Ce fichier étend le module Gouvernance (vague 27) avec trois blocs :
//   A. Conventions réglementées & crédits aux apparentés
//   B. Contrôle interne, risques & plan de continuité (PCA)
//   C. Conformité & reporting réglementaire (échéancier + Pack Inspection)
//
// Règles de construction :
//   - cloisonnement strict par imf_id sur TOUTES les requêtes ;
//   - le module est réservé aux IMF (le super-admin teebo est refusé) ;
//   - AUCUN taux, AUCUN plafond, AUCUN délai n'est écrit en dur : tout vient de
//     la table parametres_prudentiels (paramétrable par pays) ;
//   - cohérence SCOOP / SA : les titres s'appellent PARTS SOCIALES dans une
//     coopérative (1 membre = 1 voix) et ACTIONS dans une société anonyme
//     (les droits de vote suivent le nombre d'actions).
// ---------------------------------------------------------------------------
import crypto from 'crypto';
import { Router } from 'express';
import { q } from './db.js';
import { authenticate, requireFreshPassword, rolesOf } from './auth.js';
import { setDocumentCsp } from './documents.js';

export const gcRouter = Router();
gcRouter.use(authenticate, requireFreshPassword);
function gardeTeebo(req, res, next) {
  if (req.user.role === 'teebo_admin') return res.status(403).json({ error: 'use_teebo_console' });
  next();
}
// Marqueur : ce garde est deja franchi quand la requete vient de
// /governance/overview (voir governanceConformiteOverviewSources).
gardeTeebo.teeboGuard = true;
gcRouter.use(gardeTeebo);

const WRITE_ROLES = ['superadmin', 'pca_admin', 'admin_imf', 'direction'];
const canWrite = (u) => Boolean(u) && rolesOf(u.role).some((x) => WRITE_ROLES.includes(x));
const guardWrite = (req, res, next) => (canWrite(req.user) ? next() : res.status(403).json({ error: 'forbidden' }));

// --- utilitaires -----------------------------------------------------------
const int = (v, d = 0) => { if (v === null || v === undefined || v === '') return d; const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const txt = (v) => { if (v === null || v === undefined) return null; const s = String(v).trim(); return s === '' ? null : s; };
const day = (v) => (txt(v) ? String(v).slice(0, 10) : null);
const bool = (v, d = false) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : d);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / 86400000);
const fmtFr = (d) => (d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('fr-FR') : '—');
const cents = (v) => Math.round(Number(v || 0));
const money = (c) => String(Math.round(Number(c || 0)) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ' ').replace('.', ',') + ' FCFA';
const pct = (v) => (v === null || v === undefined ? '—' : String(Number(v).toFixed(2)).replace('.', ',') + ' %');
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function own(table, id, imfId) {
  const { rows } = await q(`SELECT * FROM ${table} WHERE id=$1 AND imf_id=$2`, [id, imfId]);
  return rows[0] || null;
}

/** Paramètres prudentiels de l'IMF (créés à la volée si absents). */
export async function getParams(imfId) {
  const { rows } = await q('SELECT * FROM parametres_prudentiels WHERE imf_id=$1', [imfId]);
  if (rows[0]) return rows[0];
  const ins = await q(
    `INSERT INTO parametres_prudentiels (imf_id, pays)
     SELECT $1, country_code FROM imf WHERE id=$1
     ON CONFLICT (imf_id) DO NOTHING RETURNING *`, [imfId]);
  if (ins.rows[0]) return ins.rows[0];
  return (await q('SELECT * FROM parametres_prudentiels WHERE imf_id=$1', [imfId])).rows[0];
}

/** Forme juridique + libellé du titre (part sociale ou action). */
export async function getForme(imfId) {
  const { rows } = await q('SELECT forme_juridique FROM institution_gouvernance WHERE imf_id=$1', [imfId]);
  const f = rows[0] ? rows[0].forme_juridique : null;
  const scoop = f === 'COOPERATIVE' || f === 'SCOOPS';
  return {
    forme_juridique: f || 'SA',
    is_scoop: scoop,
    titre_singulier: scoop ? 'part sociale' : 'action',
    titre_pluriel: scoop ? 'parts sociales' : 'actions',
    // En SCOOP la voix ne dépend pas du nombre de parts : 1 membre = 1 voix.
    vote_par_titre: !scoop
  };
}

/** Fonds propres effectifs (FPE) de l'IMF, en centimes.
 *  Priorité : montant saisi par la direction dans les paramètres prudentiels
 *  (fonds propres effectifs arrêtés), sinon capital social de l'IMF. */
export async function getFpe(imfId) {
  const p = await getParams(imfId);
  if (p && p.fpe_cents != null && Number(p.fpe_cents) > 0) return { fpe_cents: Number(p.fpe_cents), source: 'saisie' };
  const { rows } = await q('SELECT capital_cents FROM imf WHERE id=$1', [imfId]);
  const c = rows[0] && rows[0].capital_cents != null ? Number(rows[0].capital_cents) : 0;
  return { fpe_cents: c, source: 'capital' };
}

// ===========================================================================
// A. CONVENTIONS RÉGLEMENTÉES & APPARENTÉS
// ===========================================================================

/** Situation des crédits aux apparentés par rapport aux plafonds. */
async function situationApparentes(imfId) {
  const p = await getParams(imfId);
  const f = await getFpe(imfId);
  const { rows: enc } = await q(
    `SELECT pa.id, pa.nom_complet, pa.type_lien, pa.nature_personne,
            COALESCE(SUM(CASE WHEN cf.status='decaisse' THEN COALESCE(cf.approved_amount_cents, cf.amount_cents) ELSE 0 END), 0)::bigint AS encours_cents,
            COUNT(cf.id)::int AS dossiers
       FROM credit_file cf JOIN client c ON c.id = cf.client_id
       LEFT JOIN personnes_apparentees pa ON pa.client_id = c.id AND pa.imf_id = cf.imf_id AND pa.actif
      WHERE cf.imf_id=$1 AND cf.apparente = true
      GROUP BY pa.id, pa.nom_complet, pa.type_lien, pa.nature_personne`, [imfId]);
  const total = enc.reduce((s, x) => s + Number(x.encours_cents || 0), 0);
  const fpe = f.fpe_cents;
  const plafInd = Number(p.plafond_apparente_individuel_pct);
  const plafGlob = Number(p.plafond_apparentes_global_pct);
  const lignes = enc.map((x) => {
    const r = fpe > 0 ? (Number(x.encours_cents) / fpe) * 100 : null;
    return { ...x, encours_cents: Number(x.encours_cents), ratio_individuel_pct: r === null ? null : Number(r.toFixed(2)),
      plafond_pct: plafInd, depassement: r !== null && r > plafInd };
  });
  const ratioGlobal = fpe > 0 ? Number(((total / fpe) * 100).toFixed(2)) : null;
  return {
    fpe_cents: fpe, fpe_source: f.source,
    plafond_individuel_pct: plafInd, plafond_global_pct: plafGlob,
    encours_total_cents: total, ratio_global_pct: ratioGlobal,
    depassement_global: ratioGlobal !== null && ratioGlobal > plafGlob,
    lignes
  };
}

// --- paramètres -------------------------------------------------------------
gcRouter.get('/governance/conformite/parametres', async (req, res, next) => {
  try {
    const p = await getParams(req.user.imf_id);
    const f = await getForme(req.user.imf_id);
    const fpe = await getFpe(req.user.imf_id);
    res.json({ parametres: p, forme: f, fpe_cents: fpe.fpe_cents, fpe_source: fpe.source });
  } catch (e) { next(e); }
});

gcRouter.put('/governance/conformite/parametres', guardWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    await getParams(req.user.imf_id);
    const { rows } = await q(
      `UPDATE parametres_prudentiels SET
          plafond_apparente_individuel_pct = COALESCE($2, plafond_apparente_individuel_pct),
          plafond_apparentes_global_pct   = COALESCE($3, plafond_apparentes_global_pct),
          seuil_participation_pct         = COALESCE($4, seuil_participation_pct),
          perimetre_apparentes            = COALESCE($5, perimetre_apparentes),
          revue_pca_jours                 = COALESCE($6, revue_pca_jours),
          alerte_pca_sans_exercice_mois   = COALESCE($7, alerte_pca_sans_exercice_mois),
          seuil_risque_residuel_eleve     = COALESCE($8, seuil_risque_residuel_eleve),
          alertes_jours                   = COALESCE($9, alertes_jours),
          fpe_cents                       = $10,
          observations                    = COALESCE($11, observations),
          updated_at = now(), updated_by = $12
        WHERE imf_id=$1 RETURNING *`,
      [req.user.imf_id, num(b.plafond_apparente_individuel_pct), num(b.plafond_apparentes_global_pct),
       num(b.seuil_participation_pct), txt(b.perimetre_apparentes), num(b.revue_pca_jours),
       num(b.alerte_pca_sans_exercice_mois), num(b.seuil_risque_residuel_eleve), txt(b.alertes_jours),
       b.fpe_cents === null || b.fpe_cents === undefined || b.fpe_cents === '' ? null : cents(b.fpe_cents),
       txt(b.observations), req.user.id]);
    res.json({ parametres: rows[0] });
  } catch (e) { next(e); }
});

// --- personnes apparentées ---------------------------------------------------
gcRouter.get('/governance/apparentes', async (req, res, next) => {
  try {
    const imfId = req.user.imf_id;
    const [pa, membres, situation, forme] = await Promise.all([
      q(`SELECT pa.*, m.nom_complet AS interessé, m.fonction AS interessé_fonction
           FROM personnes_apparentees pa
           LEFT JOIN membres_gouvernance m ON m.id=pa.membre_gouvernance_id AND m.imf_id=pa.imf_id
          WHERE pa.imf_id=$1 AND pa.actif=true ORDER BY pa.nom_complet`, [imfId]),
      q(`SELECT id, nom_complet, fonction FROM membres_gouvernance WHERE imf_id=$1 AND actif=true ORDER BY nom_complet`, [imfId]),
      situationApparentes(imfId),
      getForme(imfId)
    ]);
    res.json({ apparentes: pa.rows, membres: membres.rows, situation, forme });
  } catch (e) { next(e); }
});

async function upsertApparente(imfId, id, b, userId) {
  const nom = txt(b.nom_complet);
  if (!nom) { const e = new Error('nom_required'); e.status = 400; throw e; }
  const v = [txt(b.membre_gouvernance_id), txt(b.app_user_id), nom, txt(b.type_lien) || 'AUTRE',
    txt(b.nature_personne) || 'PHYSIQUE', day(b.date_naissance), txt(b.numero_piece), txt(b.rccm),
    txt(b.ifu_nif), txt(b.telephone), txt(b.email), txt(b.adresse), txt(b.client_id),
    txt(b.statut_verification) || 'A_VERIFIER', day(b.date_verification), txt(b.piece_justificative),
    txt(b.observations)];
  if (id) {
    const { rows } = await q(
      `UPDATE personnes_apparentees SET membre_gouvernance_id=$1, app_user_id=$2, nom_complet=$3, type_lien=$4,
          nature_personne=$5, date_naissance=$6, numero_piece=$7, rccm=$8, ifu_nif=$9, telephone=$10, email=$11,
          adresse=$12, client_id=$13, statut_verification=$14, date_verification=$15, piece_justificative=$16,
          observations=$17, updated_at=now()
        WHERE id=$18 AND imf_id=$19 RETURNING *`, [...v, id, imfId]);
    return rows[0];
  }
  const { rows } = await q(
    `INSERT INTO personnes_apparentees (imf_id, membre_gouvernance_id, app_user_id, nom_complet, type_lien,
        nature_personne, date_naissance, numero_piece, rccm, ifu_nif, telephone, email, adresse, client_id,
        statut_verification, date_verification, piece_justificative, observations, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [imfId, ...v, userId]);
  return rows[0];
}

gcRouter.post('/governance/apparentes', guardWrite, async (req, res, next) => {
  try { res.status(201).json({ apparente: await upsertApparente(req.user.imf_id, null, req.body || {}, req.user.id) }); }
  catch (e) { next(e); }
});
gcRouter.put('/governance/apparentes/:id', guardWrite, async (req, res, next) => {
  try {
    const row = await upsertApparente(req.user.imf_id, req.params.id, req.body || {}, req.user.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ apparente: row });
  } catch (e) { next(e); }
});
gcRouter.delete('/governance/apparentes/:id', guardWrite, async (req, res, next) => {
  try {
    const { rowCount } = await q('UPDATE personnes_apparentees SET actif=false, updated_at=now() WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.user.imf_id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Détection : ce client (ou l'un de ses ayants droit) est-il apparenté ? */
gcRouter.get('/governance/apparentes/detect', async (req, res, next) => {
  try {
    const imfId = req.user.imf_id;
    const clientId = txt(req.query.client_id);
    if (!clientId) return res.status(400).json({ error: 'client_required' });
    const { rows } = await q(
      `SELECT pa.*, m.nom_complet AS interessé
         FROM personnes_apparentees pa
         LEFT JOIN membres_gouvernance m ON m.id=pa.membre_gouvernance_id AND m.imf_id=pa.imf_id
        WHERE pa.imf_id=$1 AND pa.actif=true AND pa.client_id=$2`, [imfId, clientId]);
    const situation = await situationApparentes(imfId);
    res.json({ apparentes: rows, apparente: rows.length > 0, situation });
  } catch (e) { next(e); }
});

// --- conventions --------------------------------------------------------------
const CONV_SELECT = `SELECT cv.*, pa.nom_complet AS apparente_nom, pa.type_lien, pa.nature_personne,
    m.nom_complet AS interessé, m.fonction AS interessé_fonction
  FROM conventions_reglementees cv
  JOIN personnes_apparentees pa ON pa.id=cv.personne_apparentee_id AND pa.imf_id=cv.imf_id
  LEFT JOIN membres_gouvernance m ON m.id=cv.membre_gouvernance_id AND m.imf_id=cv.imf_id`;

gcRouter.get('/governance/conventions', async (req, res, next) => {
  try {
    const imfId = req.user.imf_id;
    const rows = (await q(`${CONV_SELECT} WHERE cv.imf_id=$1 ORDER BY cv.date_convention DESC, cv.created_at DESC`, [imfId])).rows;
    const pa = (await q(`SELECT id, nom_complet, type_lien, membre_gouvernance_id FROM personnes_apparentees
                          WHERE imf_id=$1 AND actif=true ORDER BY nom_complet`, [imfId])).rows;
    const membres = (await q(`SELECT id, nom_complet, fonction FROM membres_gouvernance WHERE imf_id=$1 AND actif=true ORDER BY nom_complet`, [imfId])).rows;
    const situation = await situationApparentes(imfId);
    const forme = await getForme(imfId);
    // part des conventions non autorisées / non communiquées au CAC
    const sansAutorisation = rows.filter((x) => x.autorisation_requise && !x.date_autorisation).length;
    const sansCac = rows.filter((x) => !x.informe_cac).length;
    res.json({ conventions: rows, apparentes: pa, membres, situation, forme,
      kpis: { total: rows.length, sans_autorisation: sansAutorisation, sans_cac: sansCac,
        en_cours: rows.filter((x) => ['AUTORISEE', 'EN_COURS'].includes(x.statut)).length,
        depassements: situation.lignes.filter((l) => l.depassement).length } });
  } catch (e) { next(e); }
});

gcRouter.post('/governance/conventions', guardWrite, async (req, res, next) => {
  try { res.status(201).json({ convention: await saveConvention(req.user.imf_id, null, req.body || {}, req.user.id) }); }
  catch (e) { next(e); }
});
gcRouter.put('/governance/conventions/:id', guardWrite, async (req, res, next) => {
  try {
    const row = await saveConvention(req.user.imf_id, req.params.id, req.body || {}, req.user.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ convention: row });
  } catch (e) { next(e); }
});
gcRouter.delete('/governance/conventions/:id', guardWrite, async (req, res, next) => {
  try {
    const { rowCount } = await q('DELETE FROM conventions_reglementees WHERE id=$1 AND imf_id=$2', [req.params.id, req.user.imf_id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

async function saveConvention(imfId, id, b, userId) {
  const pa = b.personne_apparentee_id ? await own('personnes_apparentees', b.personne_apparentee_id, imfId) : null;
  if (!pa) { const e = new Error('apparente_required'); e.status = 400; throw e; }
  const montant = cents(b.montant_cents);
  // contrôle de plafond individuel sur les crédits
  let depassement = false;
  if (txt(b.type_convention) === 'CREDIT') {
    const sit = await situationApparentes(imfId);
    const ligne = sit.lignes.find((l) => l.id === pa.id);
    const fpe = sit.fpe_cents;
    const encours = (ligne ? ligne.encours_cents : 0) + montant;
    if (fpe > 0 && (encours / fpe) * 100 > sit.plafond_individuel_pct) depassement = true;
  }
  // exclusion du vote : un administrateur intéressé ne participe jamais au vote
  const voteExclu = pa.membre_gouvernance_id ? true : bool(b.vote_exclu, false);
  const statut = txt(b.statut) || 'PROJET';
  const vals = [txt(b.personne_apparentee_id), txt(b.membre_gouvernance_id) || pa.membre_gouvernance_id,
    txt(b.client_id) || pa.client_id || null, txt(b.credit_file_id), txt(b.type_convention) || 'CREDIT',
    txt(b.objet), day(b.date_convention) || today(), montant, num(b.taux_interet_pct), int(b.duree_mois) || null,
    txt(b.conditions), statut, bool(b.autorisation_requise, true), txt(b.organe_autorisation),
    day(b.date_autorisation), txt(b.reference_autorisation), voteExclu, txt(b.vote_exclusion_note),
    bool(b.informe_cac, false), day(b.date_information_cac), depassement, txt(b.commentaire_conformite), txt(b.observations)];
  if (id) {
    const { rows } = await q(
      `UPDATE conventions_reglementees SET personne_apparentee_id=$1, membre_gouvernance_id=$2, client_id=$3,
          credit_file_id=$4, type_convention=$5, objet=$6, date_convention=$7, montant_cents=$8, taux_interet_pct=$9,
          duree_mois=$10, conditions=$11, statut=$12, autorisation_requise=$13, organe_autorisation=$14,
          date_autorisation=$15, reference_autorisation=$16, vote_exclu=$17, vote_exclusion_note=$18,
          informe_cac=$19, date_information_cac=$20, depassement_plafond=$21, commentaire_conformite=$22,
          observations=$23, updated_at=now()
        WHERE id=$24 AND imf_id=$25 RETURNING *`, [...vals, id, imfId]);
    return rows[0];
  }
  const reference = txt(b.reference) || ('CR-' + new Date().getFullYear() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase());
  const { rows } = await q(
    `INSERT INTO conventions_reglementees (imf_id, personne_apparentee_id, membre_gouvernance_id, client_id,
        credit_file_id, type_convention, objet, date_convention, montant_cents, taux_interet_pct, duree_mois,
        conditions, statut, autorisation_requise, organe_autorisation, date_autorisation, reference_autorisation,
        vote_exclu, vote_exclusion_note, informe_cac, date_information_cac, depassement_plafond,
        commentaire_conformite, observations, reference, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     RETURNING *`, [imfId, ...vals, reference, userId]);
  return rows[0];
}

// ===========================================================================
// B. CONTRÔLE INTERNE, RISQUES & PCA
// ===========================================================================

gcRouter.get('/governance/risques', async (req, res, next) => {
  try {
    const imfId = req.user.imf_id;
    const p = await getParams(imfId);
    const risques = (await q('SELECT * FROM cartographie_risques WHERE imf_id=$1 ORDER BY probabilite DESC, impact DESC, libelle', [imfId])).rows;
    // matrice 4 x 4 : probabilité (1..4) x impact (1..4)
    const matrice = [];
    for (let pr = 4; pr >= 1; pr--) {
      const row = [];
      for (let im = 1; im <= 4; im++) row.push({ probabilite: pr, impact: im, score: pr * im, risques: [] });
      matrice.push(row);
    }
    risques.forEach((x) => {
      const cell = matrice.find((r) => r[0].probabilite === x.probabilite);
      if (cell) cell[x.impact - 1].risques.push({ id: x.id, code: x.code_risque, libelle: x.libelle, categorie: x.categorie, statut: x.statut });
    });
    const score = (x) => (x.probabilite_residuelle || x.probabilite) * (x.impact_residuel || x.impact);
    const eleves = risques.filter((x) => score(x) >= Number(p.seuil_risque_residuel_eleve));
    res.json({
      risques, matrice,
      seuil_residuel_eleve: Number(p.seuil_risque_residuel_eleve),
      kpis: { total: risques.length,
        critiques: risques.filter((x) => x.probabilite * x.impact >= 12).length,
        eleves_residuels: eleves.length,
        maitrises: risques.filter((x) => x.statut === 'MAITRISE').length },
      alertes: eleves.map((x) => ({ niveau: 'HAUTE', code: 'risque_eleve', texte: 'Risque résiduel élevé : ' + x.libelle }))
    });
  } catch (e) { next(e); }
});

function risquePayload(b) {
  return [txt(b.code_risque), txt(b.libelle), txt(b.categorie) || 'OPERATIONNEL', txt(b.processus), txt(b.description),
    Math.min(4, Math.max(1, int(b.probabilite, 2))), Math.min(4, Math.max(1, int(b.impact, 2))),
    b.probabilite_residuelle ? Math.min(4, Math.max(1, int(b.probabilite_residuelle))) : null,
    b.impact_residuel ? Math.min(4, Math.max(1, int(b.impact_residuel))) : null,
    txt(b.dispositif_maitrise), txt(b.responsable), day(b.date_revue), day(b.prochaine_revue),
    txt(b.statut) || 'ACTIF', txt(b.observations)];
}

gcRouter.post('/governance/risques', guardWrite, async (req, res, next) => {
  try {
    const v = risquePayload(req.body || {});
    if (!v[1]) return res.status(400).json({ error: 'libelle_required' });
    const { rows } = await q(
      `INSERT INTO cartographie_risques (imf_id, code_risque, libelle, categorie, processus, description,
          probabilite, impact, probabilite_residuelle, impact_residuel, dispositif_maitrise, responsable,
          date_revue, prochaine_revue, statut, observations, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`, [req.user.imf_id, ...v, req.user.id]);
    res.status(201).json({ risque: rows[0] });
  } catch (e) { next(e); }
});

gcRouter.put('/governance/risques/:id', guardWrite, async (req, res, next) => {
  try {
    const v = risquePayload(req.body || {});
    const { rows } = await q(
      `UPDATE cartographie_risques SET code_risque=$2, libelle=$3, categorie=$4, processus=$5, description=$6,
          probabilite=$7, impact=$8, probabilite_residuelle=$9, impact_residuel=$10, dispositif_maitrise=$11,
          responsable=$12, date_revue=$13, prochaine_revue=$14, statut=$15, observations=$16, updated_at=now()
        WHERE id=$17 AND imf_id=$18 RETURNING *`, [...v, req.params.id, req.user.imf_id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ risque: rows[0] });
  } catch (e) { next(e); }
});

gcRouter.delete('/governance/risques/:id', guardWrite, async (req, res, next) => {
  try {
    const { rowCount } = await q('DELETE FROM cartographie_risques WHERE id=$1 AND imf_id=$2', [req.params.id, req.user.imf_id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Statut calculé d'un plan PCA : la revue est due au-delà du délai paramétré. */
function pcaStatut(x, p) {
  const jours = Number(p.revue_pca_jours || 365);
  const ref = x.date_derniere_revue || x.date_approbation;
  let statut = x.statut;
  let joursRestants = null;
  if (ref) {
    joursRestants = jours - daysBetween(today(), String(ref).slice(0, 10));
    if (joursRestants < 0 && statut !== 'BROUILLON' && statut !== 'OBSOLETE') statut = 'REVISION_REQUISE';
  }
  const moisSansExercice = x.date_dernier_exercice
    ? Math.floor(daysBetween(today(), String(x.date_dernier_exercice).slice(0, 10)) / 30.44)
    : null;
  return { statut, jours_restants: joursRestants, mois_sans_exercice: moisSansExercice };
}

async function refreshPcaStatuts(imfId, p) {
  const plans = (await q('SELECT * FROM plans_continuite_pca WHERE imf_id=$1', [imfId])).rows;
  const out = [];
  for (const x of plans) {
    const s = pcaStatut(x, p);
    if (s.statut !== x.statut) {
      await q('UPDATE plans_continuite_pca SET statut=$2, updated_at=now() WHERE id=$1 AND imf_id=$3', [x.id, s.statut, imfId]);
      x.statut = s.statut;
    }
    out.push({ ...x, statut_calcule: s.statut, jours_restants: s.jours_restants, mois_sans_exercice: s.mois_sans_exercice });
  }
  return out;
}

gcRouter.get('/governance/pca', async (req, res, next) => {
  try {
    const imfId = req.user.imf_id;
    const p = await getParams(imfId);
    const plans = await refreshPcaStatuts(imfId, p);
    const alertes = [];
    for (const x of plans) {
      if (x.statut_calcule === 'REVISION_REQUISE') {
        alertes.push({ niveau: 'CRITIQUE', code: 'pca_revision', plan_id: x.id,
          texte: 'Plan de continuité à réviser (revue > ' + p.revue_pca_jours + ' jours) : ' + x.libelle });
      }
      if (x.mois_sans_exercice === null || x.mois_sans_exercice > Number(p.alerte_pca_sans_exercice_mois)) {
        alertes.push({ niveau: 'HAUTE', code: 'pca_sans_exercice', plan_id: x.id,
          texte: 'Aucun exercice de simulation depuis plus de ' + p.alerte_pca_sans_exercice_mois + ' mois : ' + x.libelle });
      }
    }
    res.json({ plans, revue_pca_jours: Number(p.revue_pca_jours), alertes });
  } catch (e) { next(e); }
});

function pcaPayload(b) {
  return [txt(b.libelle), txt(b.libelle) ? (txt(b.code_plan) || 'PCA-' + crypto.randomBytes(2).toString('hex').toUpperCase()) : txt(b.code_plan),
    txt(b.type_plan) || 'PCA', txt(b.perimetre), txt(b.responsable), txt(b.version), day(b.date_approbation),
    day(b.date_derniere_revue), day(b.date_prochaine_revue), day(b.date_dernier_exercice),
    txt(b.resultat_dernier_exercice), txt(b.constats_exercice), txt(b.statut) || 'VALIDE', txt(b.document_reference), txt(b.observations)];
}

gcRouter.post('/governance/pca', guardWrite, async (req, res, next) => {
  try {
    const v = pcaPayload(req.body || {});
    if (!v[0]) return res.status(400).json({ error: 'libelle_required' });
    const { rows } = await q(
      `INSERT INTO plans_continuite_pca (imf_id, libelle, code_plan, type_plan, perimetre, responsable, version,
          date_approbation, date_derniere_revue, date_prochaine_revue, date_dernier_exercice,
          resultat_dernier_exercice, constats_exercice, statut, document_reference, observations, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [req.user.imf_id, ...v, req.user.id]);
    res.status(201).json({ plan: rows[0] });
  } catch (e) { next(e); }
});

gcRouter.put('/governance/pca/:id', guardWrite, async (req, res, next) => {
  try {
    const cur = await own('plans_continuite_pca', req.params.id, req.user.imf_id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const v = pcaPayload(req.body || {});
    const { rows } = await q(
      `UPDATE plans_continuite_pca SET libelle=COALESCE($2, libelle), code_plan=COALESCE($3, code_plan),
          type_plan=$4, perimetre=$5, responsable=$6, version=$7, date_approbation=$8, date_derniere_revue=$9,
          date_prochaine_revue=$10, date_dernier_exercice=$11, resultat_dernier_exercice=$12,
          constats_exercice=$13, statut=$14, document_reference=$15, observations=$16, updated_at=now()
        WHERE id=$17 AND imf_id=$18 RETURNING *`,
      [req.user.imf_id, v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11], v[12], v[13], v[14],
       req.params.id, req.user.imf_id]);
    res.json({ plan: rows[0] });
  } catch (e) { next(e); }
});

gcRouter.delete('/governance/pca/:id', guardWrite, async (req, res, next) => {
  try {
    const { rowCount } = await q('DELETE FROM plans_continuite_pca WHERE id=$1 AND imf_id=$2', [req.params.id, req.user.imf_id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- incidents majeurs --------------------------------------------------------
gcRouter.get('/governance/incidents', async (req, res, next) => {
  try {
    const imfId = req.user.imf_id;
    const rows = (await q('SELECT * FROM incidents_majeurs WHERE imf_id=$1 ORDER BY date_incident DESC, created_at DESC', [imfId])).rows;
    const alertes = [];
    for (const x of rows) {
      if (x.notification_bceao_requise && !x.notification_bceao) {
        const limite = addDays(String(x.date_incident).slice(0, 10), Math.ceil(Number(x.delai_notification_heures || 24) / 24));
        const retard = today() > limite;
        alertes.push({ niveau: retard ? 'CRITIQUE' : 'HAUTE', code: 'notification_bceao', incident_id: x.id,
          texte: (retard ? 'Notification BCEAO EN RETARD' : 'Notification BCEAO à effectuer (limite ' + fmtFr(limite) + ')') + ' : ' + x.reference });
      }
    }
    const notifies = rows.filter((x) => x.notification_bceao).length;
    res.json({ incidents: rows, alertes,
      kpis: { total: rows.length, ouverts: rows.filter((x) => ['OUVERT', 'EN_COURS'].includes(x.statut)).length,
        a_notifier: rows.filter((x) => x.notification_bceao_requise && !x.notification_bceao).length,
        notifies,
        pertes_cents: rows.reduce((s, x) => s + Number(x.pertes_cents || 0), 0) } });
  } catch (e) { next(e); }
});

function incidentPayload(b) {
  return [txt(b.reference) || ('INC-' + new Date().getFullYear() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase()),
    day(b.date_incident) || today(), txt(b.heure_incident), txt(b.type_incident) || 'AUTRE', txt(b.gravite) || 'MOYENNE',
    txt(b.description), txt(b.localisation), cents(b.pertes_cents), txt(b.impact_activite), txt(b.mesures_immediates),
    bool(b.notification_bceao_requise, true), bool(b.notification_bceao, false), day(b.date_notification),
    txt(b.reference_notification), int(b.delai_notification_heures, 24), txt(b.statut) || 'OUVERT',
    day(b.date_resolution), txt(b.plan_action), txt(b.commentaires)];
}

gcRouter.post('/governance/incidents', guardWrite, async (req, res, next) => {
  try {
    const v = incidentPayload(req.body || {});
    const { rows } = await q(
      `INSERT INTO incidents_majeurs (imf_id, reference, date_incident, heure_incident, type_incident, gravite,
          description, localisation, pertes_cents, impact_activite, mesures_immediates, notification_bceao_requise,
          notification_bceao, date_notification, reference_notification, delai_notification_heures, statut,
          date_resolution, plan_action, commentaires, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [req.user.imf_id, ...v, req.user.id]);
    res.status(201).json({ incident: rows[0] });
  } catch (e) { next(e); }
});

gcRouter.put('/governance/incidents/:id', guardWrite, async (req, res, next) => {
  try {
    const v = incidentPayload(req.body || {});
    const { rows } = await q(
      `UPDATE incidents_majeurs SET reference=$2, date_incident=$3, heure_incident=$4, type_incident=$5, gravite=$6,
          description=$7, localisation=$8, pertes_cents=$9, impact_activite=$10, mesures_immediates=$11,
          notification_bceao_requise=$12, notification_bceao=$13, date_notification=$14, reference_notification=$15,
          delai_notification_heures=$16, statut=$17, date_resolution=$18, plan_action=$19, commentaires=$20,
          updated_at=now()
        WHERE id=$21 AND imf_id=$22 RETURNING *`, [...v, req.params.id, req.user.imf_id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ incident: rows[0] });
  } catch (e) { next(e); }
});

gcRouter.delete('/governance/incidents/:id', guardWrite, async (req, res, next) => {
  try {
    const { rowCount } = await q('DELETE FROM incidents_majeurs WHERE id=$1 AND imf_id=$2', [req.params.id, req.user.imf_id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- formation LBC/FT ---------------------------------------------------------
gcRouter.get('/governance/lbcft', async (req, res, next) => {
  try {
    const imfId = req.user.imf_id;
    const formations = (await q(
      `SELECT f.*, u.full_name AS agent_nom, u.position AS agent_poste
         FROM formation_lbcft f LEFT JOIN app_user u ON u.id=f.app_user_id AND u.imf_id=f.imf_id
        WHERE f.imf_id=$1 ORDER BY f.date_formation DESC`, [imfId])).rows;
    const { rows: eff } = await q('SELECT COUNT(*)::int AS n FROM app_user WHERE imf_id=$1 AND is_active=true', [imfId]);
    const formes = new Set(formations.map((x) => x.app_user_id).filter(Boolean));
    const total = eff[0] ? eff[0].n : 0;
    const taux = total ? Math.round((formes.size / total) * 100) : 0;
    res.json({ formations, effectif: total, formes: formes.size, taux_couverture: taux,
      alertes: taux < 80 ? [{ niveau: taux < 50 ? 'HAUTE' : 'MOYENNE', code: 'lbcft', texte: 'Couverture LBC/FT du personnel insuffisante (' + taux + ' %)' }] : [] });
  } catch (e) { next(e); }
});

gcRouter.post('/governance/lbcft', guardWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows } = await q(
      `INSERT INTO formation_lbcft (imf_id, app_user_id, libelle, date_formation, organisme, duree_heures,
          attestation_reference, attestation_recue, date_expiration, observations, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user.imf_id, txt(b.app_user_id), txt(b.libelle), day(b.date_formation) || today(), txt(b.organisme),
       num(b.duree_heures), txt(b.attestation_reference), bool(b.attestation_recue, false), day(b.date_expiration),
       txt(b.observations), req.user.id]);
    res.status(201).json({ formation: rows[0] });
  } catch (e) { next(e); }
});

gcRouter.delete('/governance/lbcft/:id', guardWrite, async (req, res, next) => {
  try {
    const { rowCount } = await q('DELETE FROM formation_lbcft WHERE id=$1 AND imf_id=$2', [req.params.id, req.user.imf_id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ===========================================================================
// C. CONFORMITÉ & REPORTING RÉGLEMENTAIRE
// ===========================================================================

/** Statut et niveau d'alerte d'une échéance (J-30 / J-15 / J-5).
 *  Règle : dépassée sans récépissé => EN_RETARD (alerte rouge) ;
 *  sinon palier de rappel le plus fin atteint. */
function echeanceInfo(x, seuils) {
  const lim = x.date_limite_depot || x.date_echeance;
  const d = String(lim).slice(0, 10);
  const jours = daysBetween(d, today());
  const recu = Boolean(x.date_recepisse) || x.statut === 'RECEPISSE_RECU';
  let statut = x.statut;
  if (!recu && jours < 0 && !['SANS_OBJET'].includes(x.statut)) statut = 'EN_RETARD';
  if (recu && statut !== 'SANS_OBJET') statut = 'RECEPISSE_RECU';
  let alerte = null;
  if (statut === 'EN_RETARD') alerte = 'DEPASSEE';
  else if (!recu) {
    const paliers = seuils.filter((s) => jours <= s).sort((a, b) => a - b);
    if (paliers.length) alerte = 'J-' + paliers[0];
  }
  return { ...x, jours_restants: jours, statut_calcule: statut, alerte };
}

gcRouter.get('/governance/echeancier', async (req, res, next) => {
  try {
    const imfId = req.user.imf_id;
    const p = await getParams(imfId);
    const seuils = String(p.alertes_jours || '30,15,5').split(',').map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0);
    const rows = (await q('SELECT * FROM echeancier_reglementaire WHERE imf_id=$1 ORDER BY COALESCE(date_limite_depot, date_echeance), libelle', [imfId])).rows;
    const liste = rows.map((x) => echeanceInfo(x, seuils));
    const alertes = [];
    for (const x of liste) {
      if (x.alerte === 'DEPASSEE') alertes.push({ niveau: 'CRITIQUE', code: 'echeance_depassee', echeance_id: x.id,
        texte: 'ÉCHÉANCE DÉPASSÉE sans récépissé : ' + x.libelle + ' (' + x.autorite + ')' });
      else if (x.alerte) alertes.push({ niveau: x.alerte === 'J-5' ? 'HAUTE' : 'MOYENNE', code: 'echeance_proche', echeance_id: x.id,
        texte: x.libelle + ' — échéance dans ' + x.jours_restants + ' jour(s) (' + x.autorite + ')' });
    }
    res.json({ echeances: liste, seuils, alertes,
      kpis: { total: liste.length, a_faire: liste.filter((x) => x.statut_calcule !== 'RECEPISSE_RECU' && x.statut_calcule !== 'SANS_OBJET').length,
        en_retard: liste.filter((x) => x.statut_calcule === 'EN_RETARD').length,
        recus: liste.filter((x) => x.statut_calcule === 'RECEPISSE_RECU').length } });
  } catch (e) { next(e); }
});

function echeancePayload(b) {
  return [txt(b.code_obligation), txt(b.libelle), txt(b.autorite) || 'BCEAO', txt(b.categorie) || 'NORMALE',
    txt(b.pays), txt(b.periodicite) || 'MENSUELLE', day(b.date_echeance) || today(), day(b.date_limite_depot),
    txt(b.statut) || 'A_FAIRE', day(b.date_depot), txt(b.reference_recepisse), day(b.date_recepisse),
    txt(b.piece_justificative), txt(b.responsable), txt(b.commentaires)];
}

gcRouter.post('/governance/echeancier', guardWrite, async (req, res, next) => {
  try {
    const v = echeancePayload(req.body || {});
    if (!v[1]) return res.status(400).json({ error: 'libelle_required' });
    const { rows } = await q(
      `INSERT INTO echeancier_reglementaire (imf_id, code_obligation, libelle, autorite, categorie, pays,
          periodicite, date_echeance, date_limite_depot, statut, date_depot, reference_recepisse, date_recepisse,
          piece_justificative, responsable, commentaires, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`, [req.user.imf_id, ...v, req.user.id]);
    res.status(201).json({ echeance: rows[0] });
  } catch (e) { next(e); }
});

gcRouter.put('/governance/echeancier/:id', guardWrite, async (req, res, next) => {
  try {
    const v = echeancePayload(req.body || {});
    const { rows } = await q(
      `UPDATE echeancier_reglementaire SET code_obligation=$2, libelle=COALESCE($3, libelle), autorite=$4, categorie=$5,
          pays=$6, periodicite=$7, date_echeance=$8, date_limite_depot=$9, statut=$10, date_depot=$11,
          reference_recepisse=$12, date_recepisse=$13, piece_justificative=$14, responsable=$15, commentaires=$16,
          updated_at=now()
        WHERE id=$17 AND imf_id=$18 RETURNING *`, [...v, req.params.id, req.user.imf_id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ echeance: rows[0] });
  } catch (e) { next(e); }
});

gcRouter.delete('/governance/echeancier/:id', guardWrite, async (req, res, next) => {
  try {
    const { rowCount } = await q('DELETE FROM echeancier_reglementaire WHERE id=$1 AND imf_id=$2', [req.params.id, req.user.imf_id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// CHARGEMENT GROUPÉ (vague 30) — GET /governance/overview
// ---------------------------------------------------------------------------
// Les routes de lecture du bloc conformité sont rejouées UNE PAR UNE, en
// mémoire : aucune règle métier n'est dupliquée et les gardes du routeur
// s'exécutent dans le MÊME ordre qu'un appel HTTP direct. Les seules gardes
// neutralisées sont celles déjà franchies par la requête groupée
// (authentification, changement de mot de passe, accès teebo_admin).

const GC_ROUTES_LECTURE = {
  conformite: '/governance/conformite/dashboard',
  apparentes: '/governance/apparentes',
  conventions: '/governance/conventions',
  risques: '/governance/risques',
  pca: '/governance/pca',
  incidents: '/governance/incidents',
  lbcft: '/governance/lbcft',
  echeancier: '/governance/echeancier'
};

// Gardes déjà franchies en amont : comparaison par IDENTITÉ de fonction.
const GC_DEJA_FRANCHIES = new Set([authenticate, requireFreshPassword]);

/** Définition d'une route GET déclarée sur le routeur. */
function gcRouteGet(router, chemin) {
  for (const couche of (router && router.stack) || []) {
    if (!couche.route || String(couche.route.path) !== chemin) continue;
    if (!(couche.route.methods || {}).get) continue;
    return couche.route;
  }
  return null;
}

/** Rejoue la chaîne de middlewares d'une route, puis sa couche métier. */
function gcRejouer(route, user, rejeu) {
  return new Promise((resolve, reject) => {
    let statut = 200;
    let fini = false;
    const req = { user, method: 'GET', query: (rejeu && rejeu.query) || {}, params: {}, body: {}, headers: {}, cookies: {}, get: () => undefined };
    const res = {
      statusCode: 200,
      status(code) { statut = code; this.statusCode = code; return this; },
      json(payload) {
        if (fini) return this;
        fini = true;
        if (statut >= 400) {
          const e = new Error((payload && payload.error) || 'http_' + statut);
          e.status = statut;
          return reject(e);
        }
        return resolve(payload);
      },
      send(p) { return this.json(p); },
      setHeader() { return this; }, set() { return this; },
      end() { if (!fini) { fini = true; resolve(null); } return this; }
    };
    const pile = (route.stack || []).map((x) => x.handle).filter((h) => typeof h === 'function');
    const metier = pile.pop();
    const chaine = pile
      .filter((h) => !GC_DEJA_FRANCHIES.has(h) && h.teeboGuard !== true)
      .concat([metier]);
    let i = 0;
    const next = (err) => {
      if (err) { if (!fini) { fini = true; reject(err); } return; }
      const h = chaine[i++];
      if (!h) { if (!fini) { fini = true; resolve(null); } return; }
      try { return h(req, res, next); } catch (e) { if (!fini) { fini = true; reject(e); } }
    };
    next();
    const minuteur = setTimeout(() => {
      if (!fini) { fini = true; const e = new Error('timeout'); e.status = 504; reject(e); }
    }, 20000);
    if (minuteur && minuteur.unref) minuteur.unref();
  });
}

/** Sources du bloc conformité pour l'endpoint groupé. */
export function governanceConformiteOverviewSources(router) {
  return Object.keys(GC_ROUTES_LECTURE).map((nom) => {
    const route = gcRouteGet(router, GC_ROUTES_LECTURE[nom]);
    if (!route) return [nom, (req, res) => res.status(404).json({ error: 'route_absente' })];
    return [nom, (req, res, nxt) => gcRejouer(route, req.user, req).then((d) => res.json(d)).catch(nxt)];
  });
}

// ===========================================================================
// TABLEAU DE BORD CONSOLIDÉ (bloc conformité de la vague 29)
// ===========================================================================
gcRouter.get('/governance/conformite/dashboard', async (req, res, next) => {
  try {
    const imfId = req.user.imf_id;
    const p = await getParams(imfId);
    const seuils = String(p.alertes_jours || '30,15,5').split(',').map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0);
    const [sit, conv, plans, inc, lbc, ech, forme] = await Promise.all([
      situationApparentes(imfId),
      q('SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE autorisation_requise AND date_autorisation IS NULL)::int AS sans_auth, COUNT(*) FILTER (WHERE NOT informe_cac)::int AS sans_cac FROM conventions_reglementees WHERE imf_id=$1', [imfId]),
      refreshPcaStatuts(imfId, p),
      q('SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE notification_bceao_requise AND NOT notification_bceao)::int AS a_notifier FROM incidents_majeurs WHERE imf_id=$1', [imfId]),
      q('SELECT COUNT(DISTINCT app_user_id)::int AS n FROM formation_lbcft WHERE imf_id=$1 AND app_user_id IS NOT NULL', [imfId]),
      q('SELECT * FROM echeancier_reglementaire WHERE imf_id=$1', [imfId]),
      getForme(imfId)
    ]);
    const { rows: eff } = await q('SELECT COUNT(*)::int AS n FROM app_user WHERE imf_id=$1 AND is_active=true', [imfId]);
    const total = eff[0] ? eff[0].n : 0;
    const tauxLbc = total ? Math.round((lbc.rows[0].n / total) * 100) : 0;
    const echeances = ech.rows.map((x) => echeanceInfo(x, seuils));
    const retard = echeances.filter((x) => x.statut_calcule === 'EN_RETARD').length;
    const proches = echeances.filter((x) => x.alerte && x.alerte !== 'DEPASSEE').length;

    const alertes = [];
    sit.lignes.forEach((l) => {
      if (l.depassement) alertes.push({ niveau: 'CRITIQUE', code: 'plafond_individuel',
        texte: 'Plafond individuel apparenté dépassé (' + pct(l.ratio_individuel_pct) + ' > ' + pct(l.plafond_pct) + ') : ' + l.nom_complet });
    });
    if (sit.depassement_global) alertes.push({ niveau: 'CRITIQUE', code: 'plafond_global',
      texte: 'Plafond global des crédits aux apparentés dépassé (' + pct(sit.ratio_global_pct) + ' > ' + pct(sit.plafond_global_pct) + ')' });
    if (conv.rows[0].sans_auth) alertes.push({ niveau: 'HAUTE', code: 'convention_auth',
      texte: conv.rows[0].sans_auth + ' convention(s) réglementée(s) sans autorisation préalable' });
    if (conv.rows[0].sans_cac) alertes.push({ niveau: 'MOYENNE', code: 'convention_cac',
      texte: conv.rows[0].sans_cac + ' convention(s) non communiquée(s) au CAC' });
    plans.forEach((x) => {
      if (x.statut_calcule === 'REVISION_REQUISE') alertes.push({ niveau: 'CRITIQUE', code: 'pca_revision', texte: 'Plan de continuité à réviser : ' + x.libelle });
      if (x.mois_sans_exercice === null || x.mois_sans_exercice > Number(p.alerte_pca_sans_exercice_mois)) alertes.push({ niveau: 'HAUTE', code: 'pca_sans_exercice', texte: 'Aucun exercice PCA depuis plus de ' + p.alerte_pca_sans_exercice_mois + ' mois : ' + x.libelle });
    });
    if (inc.rows[0].a_notifier) alertes.push({ niveau: 'CRITIQUE', code: 'incident_bceao', texte: inc.rows[0].a_notifier + ' incident(s) majeur(s) non notifié(s) à la BCEAO' });
    if (tauxLbc < 80) alertes.push({ niveau: tauxLbc < 50 ? 'HAUTE' : 'MOYENNE', code: 'lbcft', texte: 'Personnel formé LBC/FT : ' + tauxLbc + ' % (objectif 80 %)' });
    if (retard) alertes.push({ niveau: 'CRITIQUE', code: 'echeance_depassee', texte: retard + ' échéance(s) réglementaire(s) DÉPASSÉE(S) sans récépissé' });

    res.json({
      forme,
      parametres: p,
      apparentes: sit,
      conventions: conv.rows[0],
      pca: plans,
      incidents: inc.rows[0],
      lbcft: { formes: lbc.rows[0].n, effectif: total, taux: tauxLbc },
      echeancier: { en_retard: retard, proches, total: echeances.length },
      alertes
    });
  } catch (e) { next(e); }
});

// ===========================================================================
// EXPORTS — Rapport Spécial CAC (PDF / Excel) et Pack Inspection (ZIP)
// ===========================================================================
import {
  collectDossier, rapportCacHtml, rapportCacXlsx, collectPackInspection, buildZip, logExport
} from './governance_exports.js';
import {
  collectFeuillePresence, feuillePresenceHtml, feuillePresenceXlsx
} from './governance_presence.js';

const EXPORT_ROLES = ['superadmin', 'pca_admin', 'admin_imf', 'direction', 'finance', 'audit'];
const guardExport = (req, res, next) => (Boolean(req.user) && rolesOf(req.user.role).some((x) => EXPORT_ROLES.includes(x))
  ? next() : res.status(403).json({ error: 'forbidden' }));

function safeName(s) {
  return String(s || 'IMF').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'IMF';
}

/** Rapport Spécial du Commissaire aux Comptes — PDF (impression navigateur). */
gcRouter.get('/governance/exports/rapport-cac.pdf', guardExport, async (req, res, next) => {
  try {
    const d = await collectDossier(req.user.imf_id);
    const html = rapportCacHtml(d);
    await logExport(req.user.imf_id, req.user.id, 'RAPPORT_CAC_PDF', { institution: d.inst.raison_sociale || d.imf.name });
    // Aperçu HTML autonome (styles + impression dans la page) : la CSP globale
    // de l'application est assouplie pour cette seule réponse, sans script inline.
    setDocumentCsp(res, { allowFrame: true });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="' + safeName(d.institution.raison_sociale || d.imf.name)
      + '_Feuille-presence-AG_' + String(d.session.date_session || today()).slice(0, 10) + '.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (e) { next(e); }
});

/** Rapport Spécial du Commissaire aux Comptes — Excel (.xlsx). */
gcRouter.get('/governance/exports/rapport-cac.xlsx', guardExport, async (req, res, next) => {
  try {
    const d = await collectDossier(req.user.imf_id);
    const buf = rapportCacXlsx(d);
    await logExport(req.user.imf_id, req.user.id, 'RAPPORT_CAC_EXCEL', { institution: d.inst.raison_sociale || d.imf.name });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeName(d.inst.raison_sociale || d.imf.name) + '_Rapport-special-CAC_' + today() + '.xlsx"');
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// FEUILLE DE PRÉSENCE D'AG — PDF (A4 paysage imprimable) et Excel
// Le quorum imprimé est celui du moteur (recalculerQuorum) : même valeur qu'à
// l'écran. Le type d'export est tracé dans gouvernance_export_log (vague 32).
// ---------------------------------------------------------------------------
gcRouter.get('/governance/exports/feuille-presence.pdf', guardExport, async (req, res, next) => {
  try {
    const d = await collectFeuillePresence(req.user.imf_id, txt(req.query.session_id));
    if (d.error) return res.status(404).json({ error: d.error });
    const html = feuillePresenceHtml(d);
    await logExport(req.user.imf_id, req.user.id, 'FEUILLE_PRESENCE_AG_PDF', {
      session: d.session.id,
      date_session: String(d.session.date_session || '').slice(0, 10),
      lignes: d.lignes.length
    });
    setDocumentCsp(res, { allowFrame: true });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="' + safeName(d.institution.raison_sociale || d.imf.name)
      + '_Feuille-presence-AG_' + String(d.session.date_session || today()).slice(0, 10) + '.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (e) { next(e); }
});

gcRouter.get('/governance/exports/feuille-presence.xlsx', guardExport, async (req, res, next) => {
  try {
    const d = await collectFeuillePresence(req.user.imf_id, txt(req.query.session_id));
    if (d.error) return res.status(404).json({ error: d.error });
    const buf = feuillePresenceXlsx(d);
    await logExport(req.user.imf_id, req.user.id, 'FEUILLE_PRESENCE_AG_EXCEL', {
      session: d.session.id,
      date_session: String(d.session.date_session || '').slice(0, 10),
      lignes: d.lignes.length
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeName(d.institution.raison_sociale || d.imf.name)
      + '_Feuille-presence-AG_' + String(d.session.date_session || today()).slice(0, 10) + '.xlsx"');
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  } catch (e) { next(e); }
});

/** Pack Inspection « Commission Bancaire » — archive .ZIP à 7 dossiers normés. */
gcRouter.get('/governance/exports/pack-inspection.zip', guardExport, async (req, res, next) => {
  try {
    const { files, soc, jour } = await collectPackInspection(req.user.imf_id);
    // L'archive est construite AVANT toute autre operation : si la trace
    // d'export echoue, le fichier doit malgre tout etre livre.
    const zip = buildZip(files);
    await logExport(req.user.imf_id, req.user.id, 'PACK_INSPECTION_ZIP', { fichiers: files.length });
    const base = safeName(soc) + '_PACK-INSPECTION-' + jour;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + base + '.zip"');
    res.setHeader('Content-Length', String(zip.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(zip);
  } catch (e) { next(e); }
});

export default gcRouter;
