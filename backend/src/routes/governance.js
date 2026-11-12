// teebo — Module GOUVERNANCE & CONFORMITÉ (loi-cadre UMOA)
// ---------------------------------------------------------------------------
// Six registres, tous cloisonnés par imf_id : fiche institution, organes,
// membres, mandats, sessions & PV, résolutions. Le module ne crée AUCUNE
// passerelle vers la caisse ou la comptabilité : un administrateur consulte
// et documente, il n'exécute aucune opération financière (séparation stricte
// des tâches).
//
// Principes de saisie (réduction de la ressaisie) :
//   - la fiche institution est pré-remplie depuis la fiche IMF + l'identité
//     légale déjà paramétrée (raison sociale, RCCM, IFU, agrément, capital,
//     siège, téléphone, e-mail) ;
//   - un membre relié à un compte d'accès reprend automatiquement son nom,
//     sa fonction, son téléphone et son e-mail ;
//   - le quorum d'une session se déduit du quorum de l'organe et du nombre de
//     présents ;
//   - le statut d'une résolution passe automatiquement « en retard ».
// ---------------------------------------------------------------------------
import crypto from 'crypto';
import { Router } from 'express';
import { q } from '../db.js';
import { authenticate, requireFreshPassword, requireRole } from '../auth.js';
import { getBranding, setDocumentCsp, fmtDate, moneyFcfa } from '../documents.js';

const r = Router();
r.use(authenticate, requireFreshPassword);

// Le module est réservé aux IMF : le super-admin teebo n'y accède pas (il
// dispose de sa propre console).
r.use((req, res, next) => {
  if (req.user.role === 'teebo_admin') return res.status(403).json({ error: 'use_teebo_console' });
  next();
});

const WRITE_ROLES = ['superadmin', 'admin_imf', 'direction'];
const canWrite = (user) => WRITE_ROLES.includes(user && user.role);

// --- Utilitaires -----------------------------------------------------------
const int = (v, dflt = 0) => {
  if (v === null || v === undefined || v === '') return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const txt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const day = (v) => txt(v) ? String(v).slice(0, 10) : null;
const boolOrNull = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

/** Date du jour au format AAAA-MM-JJ (comparaisons de dates simples). */
const today = () => new Date().toISOString().slice(0, 10);

function guardWrite(req, res, next) {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'forbidden' });
  next();
}

/** Recherche une ligne du tenant ; 404 si elle appartient à une autre IMF. */
async function own(table, id, imfId) {
  const { rows } = await q(`SELECT * FROM ${table} WHERE id=$1 AND imf_id=$2`, [id, imfId]);
  return rows[0] || null;
}

// ===========================================================================
// 1. FICHE INSTITUTION
// ===========================================================================

/** Valeurs proposées automatiquement (calculées à partir de l'existant). */
async function draftInstitution(imfId) {
  const b = await getBranding(imfId);
  const imf = b.imf || {};
  const { rows: boss } = await q(
    `SELECT full_name, position FROM app_user
      WHERE imf_id=$1 AND is_active=true AND position IS NOT NULL
        AND position ~* 'pr[eé]sident|PCA'
      ORDER BY created_at LIMIT 1`, [imfId]);
  const { rows: dg } = await q(
    `SELECT full_name FROM app_user
      WHERE imf_id=$1 AND is_active=true AND position IS NOT NULL
        AND position ~* 'directeur g[eé]n[eé]ral|^DG' AND position !~* 'adjoint'
      ORDER BY created_at LIMIT 1`, [imfId]);
  const { rows: adm } = await q(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE sexe='F')::int AS f
       FROM membres_gouvernance WHERE imf_id=$1 AND actif=true`, [imfId]);
  const typeToForme = { SA: 'SA', SCOOP: 'COOPERATIVE' };
  return {
    raison_sociale: b.legal_name || imf.name || null,
    forme_juridique: typeToForme[b.legal_form] || (b.legal_form ? 'AUTRE' : null),
    rccm: b.trade_register_no || null,
    ifu_nif: b.tax_id || null,
    numero_agrement: b.bceao_agreement_no || imf.bceao_agreement_no || null,
    date_agrement: null,
    capital_social_cents: b.share_capital_cents != null ? Number(b.share_capital_cents) : (imf.capital_cents != null ? Number(imf.capital_cents) : null),
    siege_social: b.legal_address || [imf.city, imf.country_code].filter(Boolean).join(', ') || null,
    pays: imf.country_code || null,
    ville: imf.city || null,
    telephone: imf.phone_main || null,
    email: imf.email || null,
    site_web: null,
    president_ca: boss[0] ? boss[0].full_name : null,
    directeur_general: dg[0] ? dg[0].full_name : null,
    nombre_administrateurs: adm[0] ? adm[0].n : null,
    nombre_femmes_dirigeantes: adm[0] ? adm[0].f : null,
    date_derniere_ag: null,
    date_prochaine_ag: null,
    statut_conformite: 'NON_EVALUEE',
    observations: null
  };
}

r.get('/governance/institution', async (req, res, next) => {
  try {
    const draft = await draftInstitution(req.user.imf_id);
    const { rows } = await q('SELECT * FROM institution_gouvernance WHERE imf_id=$1', [req.user.imf_id]);
    const saved = rows[0] || null;
    // every field: true = la valeur vient d'un autre écran (jamais ressaisie)
    res.json({ institution: { ...draft, ...(saved || {}) }, saved: Boolean(saved), draft });
  } catch (e) { next(e); }
});

r.put('/governance/institution', guardWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const fields = {
      raison_sociale: txt(b.raison_sociale), forme_juridique: txt(b.forme_juridique),
      rccm: txt(b.rccm), ifu_nif: txt(b.ifu_nif), numero_agrement: txt(b.numero_agrement),
      date_agrement: day(b.date_agrement), capital_social_cents: num(b.capital_social_cents),
      siege_social: txt(b.siege_social), pays: txt(b.pays), ville: txt(b.ville),
      telephone: txt(b.telephone), email: txt(b.email), site_web: txt(b.site_web),
      president_ca: txt(b.president_ca), directeur_general: txt(b.directeur_general),
      nombre_administrateurs: num(b.nombre_administrateurs),
      nombre_femmes_dirigeantes: num(b.nombre_femmes_dirigeantes),
      date_derniere_ag: day(b.date_derniere_ag), date_prochaine_ag: day(b.date_prochaine_ag),
      statut_conformite: txt(b.statut_conformite) || 'NON_EVALUEE',
      observations: txt(b.observations)
    };
    if (fields.forme_juridique && !['SA','SAS','SARL','COOPERATIVE','SCOOPS','ASSOCIATION','GIE','AUTRE'].includes(fields.forme_juridique)) {
      fields.forme_juridique = 'AUTRE';
    }
    const cols = Object.keys(fields);
    const vals = cols.map((c) => fields[c]);
    const sets = cols.map((c, i) => `${c}=$${i + 2}`).join(', ');
    const { rows } = await q(
      `INSERT INTO institution_gouvernance (imf_id, ${cols.join(', ')}, updated_by)
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $${cols.length + 2})
       ON CONFLICT (imf_id) DO UPDATE SET ${sets}, updated_at=now(), updated_by=$${cols.length + 2}
       RETURNING *`,
      [req.user.imf_id, ...vals, req.user.id]);
    res.json({ ok: true, institution: rows[0] });
  } catch (e) { next(e); }
});

// ===========================================================================
// 2. ORGANES
// ===========================================================================
const DEFAULT_ORGANES = [
  ['CA', "Conseil d'Administration", 'CONSEIL_ADMINISTRATION', 'TRIMESTRIELLE', true, 3],
  ['CA_AUDIT', "Comité d'Audit", 'COMITE_AUDIT', 'TRIMESTRIELLE', true, 3],
  ['CA_RISQUE', 'Comité des Risques', 'COMITE_RISQUE', 'TRIMESTRIELLE', true, 3],
  ['CA_CREDIT', 'Comité de Crédit', 'COMITE_CREDIT', 'MENSUELLE', true, 3],
  ['CA_ALM', 'Comité ALM (actif/passif)', 'COMITE_ALM', 'TRIMESTRIELLE', false, 3],
  ['AG', 'Assemblée Générale', 'ASSEMBLEE_GENERALE', 'ANNUELLE', true, 0],
  ['DG', 'Direction Générale', 'DIRECTION_GENERALE', 'MENSUELLE', true, 0]
];

r.get('/governance/organes', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT o.*, (SELECT COUNT(*)::int FROM membres_gouvernance m
                     WHERE m.organe_id=o.id AND m.actif=true) AS membres_reels,
              (SELECT MAX(date_session) FROM sessions_et_pv s WHERE s.organe_id=o.id) AS derniere_session
         FROM organes_gouvernance o WHERE o.imf_id=$1 ORDER BY o.obligatoire DESC, o.libelle`,
      [req.user.imf_id]);
    res.json({ organes: rows, defaults: DEFAULT_ORGANES.map(([code, libelle, type, freq, ob, qr]) => ({ code, libelle, type, freq, ob, qr })) });
  } catch (e) { next(e); }
});

r.post('/governance/organes/seed', guardWrite, async (req, res, next) => {
  try {
    for (const [code, libelle, type, freq, ob, qr] of DEFAULT_ORGANES) {
      await q(
        `INSERT INTO organes_gouvernance (imf_id, code_organe, libelle, type_organe, frequence_reunion, obligatoire, quorum_requis, nombre_membres)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0)
         ON CONFLICT (imf_id, code_organe) DO NOTHING`,
        [req.user.imf_id, code, libelle, type, freq, ob, qr]);
    }
    const { rows } = await q('SELECT * FROM organes_gouvernance WHERE imf_id=$1 ORDER BY libelle', [req.user.imf_id]);
    res.json({ ok: true, organes: rows });
  } catch (e) { next(e); }
});

r.post('/governance/organes', guardWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const libelle = txt(b.libelle);
    if (!libelle) return res.status(400).json({ error: 'libelle_required' });
    const code = txt(b.code_organe) || ('ORG_' + crypto.randomBytes(3).toString('hex').toUpperCase());
    const { rows } = await q(
      `INSERT INTO organes_gouvernance (imf_id, code_organe, libelle, type_organe, statut, nombre_membres,
          quorum_requis, frequence_reunion, obligatoire, base_reglementaire, date_creation, observations)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (imf_id, code_organe) DO UPDATE SET libelle=EXCLUDED.libelle
       RETURNING *`,
      [req.user.imf_id, code, libelle, txt(b.type_organe) || 'AUTRE', txt(b.statut) || 'ACTIF',
       int(b.nombre_membres), int(b.quorum_requis), txt(b.frequence_reunion) || 'A_LA_DEMANDE',
       b.obligatoire === false ? false : true, txt(b.base_reglementaire), day(b.date_creation), txt(b.observations)]);
    res.json({ ok: true, organe: rows[0] });
  } catch (e) { next(e); }
});

r.put('/governance/organes/:id', guardWrite, async (req, res, next) => {
  try {
    const cur = await own('organes_gouvernance', req.params.id, req.user.imf_id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    const { rows } = await q(
      `UPDATE organes_gouvernance SET libelle=$1, type_organe=$2, statut=$3, nombre_membres=$4,
              quorum_requis=$5, frequence_reunion=$6, obligatoire=$7, base_reglementaire=$8,
              date_creation=$9, observations=$10, updated_at=now()
        WHERE id=$11 AND imf_id=$12 RETURNING *`,
      [txt(b.libelle) || cur.libelle, txt(b.type_organe) || cur.type_organe, txt(b.statut) || cur.statut,
       int(b.nombre_membres, cur.nombre_membres), int(b.quorum_requis, cur.quorum_requis),
       txt(b.frequence_reunion) || cur.frequence_reunion, b.obligatoire === false ? false : true,
       txt(b.base_reglementaire), day(b.date_creation) || cur.date_creation, txt(b.observations),
       cur.id, req.user.imf_id]);
    res.json({ ok: true, organe: rows[0] });
  } catch (e) { next(e); }
});

r.delete('/governance/organes/:id', guardWrite, async (req, res, next) => {
  try {
    const { rowCount } = await q('DELETE FROM organes_gouvernance WHERE id=$1 AND imf_id=$2', [req.params.id, req.user.imf_id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ===========================================================================
// 3. MEMBRES
// ===========================================================================
const CASIER_ALERT_DAYS = 90;

r.get('/governance/membres', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT m.*, o.libelle AS organe_libelle, o.type_organe,
              CASE WHEN m.casier_judiciaire_date IS NULL THEN true
                   ELSE (now()::date - m.casier_judiciaire_date) > $2 END AS casier_a_renouveler
         FROM membres_gouvernance m
         LEFT JOIN organes_gouvernance o ON o.id=m.organe_id AND o.imf_id=m.imf_id
        WHERE m.imf_id=$1 ORDER BY m.actif DESC, m.fonction, m.nom_complet`,
      [req.user.imf_id, CASIER_ALERT_DAYS]);
    // Comptes d'accès proposés pour le rapprochement automatique (anti double saisie)
    const { rows: users } = await q(
      `SELECT id, full_name, position, email, phone FROM app_user
        WHERE imf_id=$1 AND is_active=true ORDER BY full_name`, [req.user.imf_id]);
    res.json({ membres: rows, users, seuilCasierJours: CASIER_ALERT_DAYS });
  } catch (e) { next(e); }
});

/** Reprise automatique des informations du compte d'accès lié. */
async function memberAuto(imfId, appUserId) {
  if (!appUserId) return {};
  const { rows } = await q(
    `SELECT full_name, position, email, phone FROM app_user WHERE id=$1 AND imf_id=$2`,
    [appUserId, imfId]);
  const u = rows[0];
  if (!u) return {};
  return { nom_complet: u.full_name, fonction: u.position, email: u.email, telephone: u.phone };
}

function membrePayload(b, auto) {
  return {
    nom_complet: txt(b.nom_complet) || auto.nom_complet || null,
    fonction: txt(b.fonction) || auto.fonction || null,
    email: txt(b.email) || auto.email || null,
    telephone: txt(b.telephone) || auto.telephone || null
  };
}

r.post('/governance/membres', guardWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const auto = await memberAuto(req.user.imf_id, txt(b.app_user_id));
    const p = membrePayload(b, auto);
    if (!p.nom_complet) return res.status(400).json({ error: 'nom_required' });
    const { rows } = await q(
      `INSERT INTO membres_gouvernance (imf_id, app_user_id, organe_id, nom_complet, fonction, type_membre,
          qualite, sexe, date_naissance, nationalite, profession, telephone, email, adresse,
          diplome_principal, experience_annees, casier_judiciaire_date, casier_judiciaire_ok,
          declaration_interets, date_entree, actif, observations)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [req.user.imf_id, txt(b.app_user_id), txt(b.organe_id), p.nom_complet, p.fonction || 'Membre',
       txt(b.type_membre) || 'ADMINISTRATEUR', txt(b.qualite), txt(b.sexe), day(b.date_naissance),
       txt(b.nationalite), txt(b.profession), p.telephone, p.email, txt(b.adresse),
       txt(b.diplome_principal), num(b.experience_annees), day(b.casier_judiciaire_date),
       boolOrNull(b.casier_judiciaire_ok), b.declaration_interets === true, day(b.date_entree),
       b.actif === false ? false : true, txt(b.observations)]);
    if (rows[0].organe_id) await q(
      `UPDATE organes_gouvernance SET nombre_membres=(SELECT COUNT(*) FROM membres_gouvernance
          WHERE organe_id=$1 AND imf_id=$2 AND actif=true) WHERE id=$1 AND imf_id=$2`,
      [rows[0].organe_id, req.user.imf_id]);
    res.json({ ok: true, membre: rows[0] });
  } catch (e) { next(e); }
});

r.put('/governance/membres/:id', guardWrite, async (req, res, next) => {
  try {
    const cur = await own('membres_gouvernance', req.params.id, req.user.imf_id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    const appUserId = b.app_user_id === undefined ? cur.app_user_id : txt(b.app_user_id);
    const auto = await memberAuto(req.user.imf_id, appUserId);
    const p = membrePayload({ ...cur, ...b }, auto);
    const { rows } = await q(
      `UPDATE membres_gouvernance SET app_user_id=$1, organe_id=$2, nom_complet=$3, fonction=$4,
              type_membre=$5, qualite=$6, sexe=$7, date_naissance=$8, nationalite=$9, profession=$10,
              telephone=$11, email=$12, adresse=$13, diplome_principal=$14, experience_annees=$15,
              casier_judiciaire_date=$16, casier_judiciaire_ok=$17, declaration_interets=$18,
              date_entree=$19, date_sortie=$20, actif=$21, observations=$22, updated_at=now()
        WHERE id=$23 AND imf_id=$24 RETURNING *`,
      [appUserId, txt(b.organe_id), p.nom_complet || cur.nom_complet, p.fonction || cur.fonction,
       txt(b.type_membre) || cur.type_membre, txt(b.qualite), txt(b.sexe),
       day(b.date_naissance) || cur.date_naissance, txt(b.nationalite), txt(b.profession),
       p.telephone, p.email, txt(b.adresse), txt(b.diplome_principal),
       num(b.experience_annees), day(b.casier_judiciaire_date), boolOrNull(b.casier_judiciaire_ok),
       b.declaration_interets === true, day(b.date_entree) || cur.date_entree, day(b.date_sortie),
       b.actif === false ? false : true, txt(b.observations), cur.id, req.user.imf_id]);
    for (const organeId of [cur.organe_id, rows[0].organe_id].filter(Boolean)) {
      await q(
        `UPDATE organes_gouvernance SET nombre_membres=(SELECT COUNT(*) FROM membres_gouvernance
            WHERE organe_id=$1 AND imf_id=$2 AND actif=true) WHERE id=$1 AND imf_id=$2`,
        [organeId, req.user.imf_id]);
    }
    res.json({ ok: true, membre: rows[0] });
  } catch (e) { next(e); }
});

r.delete('/governance/membres/:id', guardWrite, async (req, res, next) => {
  try {
    const { rowCount } = await q('DELETE FROM membres_gouvernance WHERE id=$1 AND imf_id=$2', [req.params.id, req.user.imf_id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ===========================================================================
// 4. MANDATS
// ============================================================================
function mandatStatut(row) {
  if (!row.date_fin) return row.statut;
  if (['REVOQUE', 'RENOUVELE', 'TERMINE'].includes(row.statut)) return row.statut;
  return String(row.date_fin).slice(0, 10) < today() ? 'EXPIRE' : 'EN_COURS';
}

r.get('/governance/mandats', async (req, res, next) => {
  try {
    // 1) Mise à jour automatique des mandats arrivés à échéance.
    await q(
      `UPDATE mandats_instances SET statut='EXPIRE', updated_at=now()
        WHERE imf_id=$1 AND statut='EN_COURS' AND date_fin IS NOT NULL AND date_fin < now()::date`,
      [req.user.imf_id]);
    const { rows } = await q(
      `SELECT m.*, mb.nom_complet, mb.type_membre AS membre_type, o.libelle AS organe_libelle
         FROM mandats_instances m
         JOIN membres_gouvernance mb ON mb.id=m.membre_id AND mb.imf_id=m.imf_id
         LEFT JOIN organes_gouvernance o ON o.id=m.organe_id AND o.imf_id=m.imf_id
        WHERE m.imf_id=$1 ORDER BY m.date_debut DESC`, [req.user.imf_id]);
    // 2) Contrôle du cumul de mandats (loi-cadre UMOA : plafond de 3 mandats).
    const CUMUL_MAX = 3;
    const cumul = {};
    for (const row of rows) {
      if (row.type_mandat !== 'ADMINISTRATEUR') continue;
      cumul[row.membre_id] = cumul[row.membre_id] || { nom: row.nom_complet, nb: 0 };
      if (row.statut === 'EN_COURS' || row.statut === 'RENOUVELE') cumul[row.membre_id].nb += 1;
    }
    const alertes = Object.entries(cumul)
      .filter(([, v]) => v.nb >= CUMUL_MAX)
      .map(([id, v]) => ({ membre_id: id, nom: v.nom, mandats_en_cours: v.nb, plafond: CUMUL_MAX }));
    const { rows: membres } = await q(
      `SELECT id, nom_complet, fonction, organe_id FROM membres_gouvernance
        WHERE imf_id=$1 AND actif=true ORDER BY nom_complet`, [req.user.imf_id]);
    res.json({ mandats: rows.map((x) => ({ ...x, statut: mandatStatut(x) })), membres, plafondCumul: CUMUL_MAX, alertesCumul: alertes });
  } catch (e) { next(e); }
});

r.post('/governance/mandats', guardWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const membre = await own('membres_gouvernance', txt(b.membre_id), req.user.imf_id);
    if (!membre) return res.status(400).json({ error: 'membre_required' });
    // Renouvellement automatique du numéro : nombre de mandats déjà enregistrés
    const { rows: cnt } = await q(
      'SELECT COUNT(*)::int AS n FROM mandats_instances WHERE membre_id=$1 AND imf_id=$2',
      [membre.id, req.user.imf_id]);
    const numRenouv = b.numero_renouvellement != null ? int(b.numero_renouvellement, 1) : cnt[0].n + 1;
    const heure = new Date().toISOString().slice(0, 10);
    const { rows } = await q(
      `INSERT INTO mandats_instances (imf_id, membre_id, organe_id, fonction, type_mandat, date_debut,
          date_fin, duree_mois, numero_renouvellement, acte_nomination, reference_ag, statut, observations)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, $12::date),$7,$8,$9,$10,$11,$13,$14) RETURNING *`,
      [req.user.imf_id, membre.id, txt(b.organe_id) || membre.organe_id, txt(b.fonction) || membre.fonction || 'Administrateur',
       txt(b.type_mandat) || 'ADMINISTRATEUR', day(b.date_debut), day(b.date_fin), num(b.duree_mois),
       numRenouv, txt(b.acte_nomination), txt(b.reference_ag), heure,
       txt(b.statut) || 'EN_COURS', txt(b.observations)]);
    res.json({ ok: true, mandat: { ...rows[0], statut: mandatStatut(rows[0]) } });
  } catch (e) { next(e); }
});

r.put('/governance/mandats/:id', guardWrite, async (req, res, next) => {
  try {
    const cur = await own('mandats_instances', req.params.id, req.user.imf_id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    const { rows } = await q(
      `UPDATE mandats_instances SET fonction=$1, type_mandat=$2, date_debut=$3, date_fin=$4,
              duree_mois=$5, numero_renouvellement=$6, acte_nomination=$7, reference_ag=$8,
              statut=$9, observations=$10, updated_at=now()
        WHERE id=$11 AND imf_id=$12 RETURNING *`,
      [txt(b.fonction) || cur.fonction, txt(b.type_mandat) || cur.type_mandat,
       day(b.date_debut) || cur.date_debut, day(b.date_fin) || cur.date_fin,
       num(b.duree_mois), int(b.numero_renouvellement, cur.numero_renouvellement),
       txt(b.acte_nomination), txt(b.reference_ag), txt(b.statut) || cur.statut,
       txt(b.observations), cur.id, req.user.imf_id]);
    res.json({ ok: true, mandat: { ...rows[0], statut: mandatStatut(rows[0]) } });
  } catch (e) { next(e); }
});

r.delete('/governance/mandats/:id', guardWrite, async (req, res, next) => {
  try {
    const { rowCount } = await q('DELETE FROM mandats_instances WHERE id=$1 AND imf_id=$2', [req.params.id, req.user.imf_id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ===========================================================================
// 5. SESSIONS & PV
// ===========================================================================
const sessionHash = (s) => crypto.createHash('sha256').update(JSON.stringify({
  organe_id: s.organe_id, date_session: String(s.date_session).slice(0, 10), numero: s.numero_session,
  odj: s.ordre_du_jour || '', presents: s.nombre_presents, pv: s.pv_resume || '', ref: s.pv_reference || ''
})).digest('hex');

r.get('/governance/sessions', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT s.*, o.libelle AS organe_libelle, o.quorum_requis AS organe_quorum,
              (SELECT COUNT(*)::int FROM resolutions_et_recommandations x WHERE x.session_id=s.id) AS nb_resolutions
         FROM sessions_et_pv s
         LEFT JOIN organes_gouvernance o ON o.id=s.organe_id AND o.imf_id=s.imf_id
        WHERE s.imf_id=$1 ORDER BY s.date_session DESC`, [req.user.imf_id]);
    const { rows: organes } = await q(
      'SELECT id, libelle, quorum_requis FROM organes_gouvernance WHERE imf_id=$1 AND statut=$2 ORDER BY libelle',
      [req.user.imf_id, 'ACTIF']);
    res.json({ sessions: rows, organes });
  } catch (e) { next(e); }
});

r.post('/governance/sessions', guardWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!day(b.date_session)) return res.status(400).json({ error: 'date_required' });
    const organe = txt(b.organe_id) ? await own('organes_gouvernance', txt(b.organe_id), req.user.imf_id) : null;
    const quorum = b.quorum_requis != null ? int(b.quorum_requis) : (organe ? Number(organe.quorum_requis || 0) : 0);
    const presents = int(b.nombre_presents);
    const { rows } = await q(
      `INSERT INTO sessions_et_pv (imf_id, organe_id, type_session, numero_session, date_session, heure_debut,
          heure_fin, lieu, ordre_du_jour, nombre_presents, nombre_invites, quorum_requis, quorum_atteint,
          president_seance, secretaire_seance, pv_reference, pv_resume, statut)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [req.user.imf_id, organe ? organe.id : null, txt(b.type_session) || 'ORDINAIRE', txt(b.numero_session),
       day(b.date_session), txt(b.heure_debut), txt(b.heure_fin), txt(b.lieu), txt(b.ordre_du_jour),
       presents, int(b.nombre_invites), quorum, quorum > 0 ? presents >= quorum : null,
       txt(b.president_seance), txt(b.secretaire_seance), txt(b.pv_reference), txt(b.pv_resume),
       txt(b.statut) || 'PLANIFIEE']);
    res.json({ ok: true, session: rows[0] });
  } catch (e) { next(e); }
});

r.put('/governance/sessions/:id', guardWrite, async (req, res, next) => {
  try {
    const cur = await own('sessions_et_pv', req.params.id, req.user.imf_id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    // Un PV signé est VERROUILLÉ : plus aucune modification n'est acceptée,
    // sauf pour un profil de direction qui doit d'abord le déverrouiller
    // (traçabilité : on ne modifie jamais un procès-verbal signé).
    if (cur.statut === 'SIGNE_VERROUILLE' && (req.body || {}).deverrouiller !== true) {
      return res.status(409).json({ error: 'pv_verrouille' });
    }
    const b = req.body || {};
    const statut = txt(b.statut) || cur.statut;
    const organeId = b.organe_id === undefined ? cur.organe_id : txt(b.organe_id);
    const organe = organeId ? await own('organes_gouvernance', organeId, req.user.imf_id) : null;
    const quorum = b.quorum_requis != null ? int(b.quorum_requis)
      : (cur.quorum_requis || (organe ? Number(organe.quorum_requis || 0) : 0));
    const presents = b.nombre_presents != null ? int(b.nombre_presents) : cur.nombre_presents;
    const merged = {
      organe_id: organeId, date_session: day(b.date_session) || cur.date_session,
      numero_session: b.numero_session === undefined ? cur.numero_session : txt(b.numero_session),
      ordre_du_jour: b.ordre_du_jour === undefined ? cur.ordre_du_jour : txt(b.ordre_du_jour),
      nombre_presents: presents,
      pv_resume: b.pv_resume === undefined ? cur.pv_resume : txt(b.pv_resume),
      pv_reference: b.pv_reference === undefined ? cur.pv_reference : txt(b.pv_reference)
    };
    // Scellement : l'empreinte n'est calculée qu'au moment de la signature.
    let hash = cur.hash_integrite_pv;
    if (statut === 'SIGNE_VERROUILLE' && !hash) hash = sessionHash(merged);
    if (statut !== 'SIGNE_VERROUILLE') hash = null;
    const { rows } = await q(
      `UPDATE sessions_et_pv SET organe_id=$1, type_session=$2, numero_session=$3, date_session=$4,
              heure_debut=$5, heure_fin=$6, lieu=$7, ordre_du_jour=$8, nombre_presents=$9,
              nombre_invites=$10, quorum_requis=$11, quorum_atteint=$12, president_seance=$13,
              secretaire_seance=$14, pv_reference=$15, pv_resume=$16, pv_url=$17,
              hash_integrite_pv=$18, statut=$19, date_signature=$20, updated_at=now()
        WHERE id=$21 AND imf_id=$22 RETURNING *`,
      [merged.organe_id, txt(b.type_session) || cur.type_session, merged.numero_session,
       merged.date_session, b.heure_debut === undefined ? cur.heure_debut : txt(b.heure_debut),
       b.heure_fin === undefined ? cur.heure_fin : txt(b.heure_fin),
       b.lieu === undefined ? cur.lieu : txt(b.lieu), merged.ordre_du_jour, presents,
       b.nombre_invites != null ? int(b.nombre_invites) : cur.nombre_invites, quorum,
       quorum > 0 ? presents >= quorum : null,
       b.president_seance === undefined ? cur.president_seance : txt(b.president_seance),
       b.secretaire_seance === undefined ? cur.secretaire_seance : txt(b.secretaire_seance),
       merged.pv_reference, merged.pv_resume, txt(b.pv_url), hash, statut,
       statut === 'SIGNE_VERROUILLE' ? (day(b.date_signature) || today()) : null,
       cur.id, req.user.imf_id]);
    res.json({ ok: true, session: rows[0] });
  } catch (e) { next(e); }
});

r.delete('/governance/sessions/:id', guardWrite, async (req, res, next) => {
  try {
    const cur = await own('sessions_et_pv', req.params.id, req.user.imf_id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    if (cur.statut === 'SIGNE_VERROUILLE') return res.status(409).json({ error: 'pv_verrouille' });
    await q('DELETE FROM sessions_et_pv WHERE id=$1 AND imf_id=$2', [cur.id, req.user.imf_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ==========================================================================
// 6. RÉSOLUTIONS & RECOMMANDATIONS
// ===========================================================================
r.get('/governance/resolutions', async (req, res, next) => {
  try {
    // Passage automatique « en retard » : échéance dépassée et non réalisée.
    await q(
      `UPDATE resolutions_et_recommandations SET statut='EN_RETARD', updated_at=now()
        WHERE imf_id=$1 AND statut IN ('A_FAIRE','EN_COURS')
          AND date_echeance IS NOT NULL AND date_echeance < now()::date`, [req.user.imf_id]);
    const { rows } = await q(
      `SELECT x.*, o.libelle AS organe_libelle, s.date_session,
              CASE WHEN x.date_echeance IS NOT NULL AND x.statut <> 'REALISEE'
                   THEN (x.date_echeance - now()::date) END AS jours_restants
         FROM resolutions_et_recommandations x
         LEFT JOIN organes_gouvernance o ON o.id=x.organe_id AND o.imf_id=x.imf_id
         LEFT JOIN sessions_et_pv s ON s.id=x.session_id AND s.imf_id=x.imf_id
        WHERE x.imf_id=$1 ORDER BY
          CASE x.priorite WHEN 'CRITIQUE' THEN 0 WHEN 'HAUTE' THEN 1 WHEN 'NORMALE' THEN 2 ELSE 3 END,
          x.date_echeance NULLS LAST`, [req.user.imf_id]);
    const { rows: sessions } = await q(
      'SELECT id, date_session, numero_session, organe_id FROM sessions_et_pv WHERE imf_id=$1 ORDER BY date_session DESC',
      [req.user.imf_id]);
    const { rows: organes } = await q(
      'SELECT id, libelle FROM organes_gouvernance WHERE imf_id=$1 ORDER BY libelle', [req.user.imf_id]);
    res.json({ resolutions: rows, sessions, organes });
  } catch (e) { next(e); }
});

r.post('/governance/resolutions', guardWrite, async (req, res, next) => {
  try {
    const { rows } = await insertResolution(req, req.body || {});
    res.json({ ok: true, resolution: rows[0] });
  } catch (e) { next(e); }
});

async function insertResolution(req, b) {
  const intitule = txt(b.intitule);
  if (!intitule) throw Object.assign(new Error('intitule_required'), { status: 400 });
  return q(
    `INSERT INTO resolutions_et_recommandations (imf_id, session_id, organe_id, numero, intitule, texte,
        type_element, domaine, responsable, date_adoption, date_echeance, date_realisation, statut,
        taux_execution, priorite, observations)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [req.user.imf_id, txt(b.session_id), txt(b.organe_id), txt(b.numero), intitule, txt(b.texte),
     txt(b.type_element) || 'RESOLUTION', txt(b.domaine), txt(b.responsable), day(b.date_adoption),
     day(b.date_echeance), day(b.date_realisation), txt(b.statut) || 'A_FAIRE',
     Math.max(0, Math.min(100, int(b.taux_execution))), txt(b.priorite) || 'NORMALE', txt(b.observations)]);
}

r.put('/governance/resolutions/:id', guardWrite, async (req, res, next) => {
  try {
    const cur = await own('resolutions_et_recommandations', req.params.id, req.user.imf_id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    const { rows } = await q(
      `UPDATE resolutions_et_recommandations SET session_id=$1, organe_id=$2, numero=$3, intitule=$4,
              texte=$5, type_element=$6, domaine=$7, responsable=$8, date_adoption=$9, date_echeance=$10,
              date_realisation=$11, statut=$12, taux_execution=$13, priorite=$14, observations=$15,
              updated_at=now()
        WHERE id=$16 AND imf_id=$17 RETURNING *`,
      [b.session_id === undefined ? cur.session_id : txt(b.session_id),
       b.organe_id === undefined ? cur.organe_id : txt(b.organe_id),
       b.numero === undefined ? cur.numero : txt(b.numero), txt(b.intitule) || cur.intitule,
       txt(b.texte), txt(b.type_element) || cur.type_element, txt(b.domaine),
       b.responsable === undefined ? cur.responsable : txt(b.responsable),
       day(b.date_adoption) || cur.date_adoption, day(b.date_echeance), day(b.date_realisation),
       txt(b.statut) || cur.statut, Math.max(0, Math.min(100, int(b.taux_execution, cur.taux_execution))),
       txt(b.priorite) || cur.priorite, txt(b.observations), cur.id, req.user.imf_id]);
    res.json({ ok: true, resolution: rows[0] });
  } catch (e) { next(e); }
});

r.delete('/governance/resolutions/:id', guardWrite, async (req, res, next) => {
  try {
    const { rowCount } = await q('DELETE FROM resolutions_et_recommandations WHERE id=$1 AND imf_id=$2', [req.params.id, req.user.imf_id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ==========================================================================
// 7. TABLEAU DE BORD DE CONFORMITÉ (score + alertes)
// ===========================================================================
r.get('/governance/dashboard', async (req, res, next) => {
  try {
    const imfId = req.user.imf_id;
    const organes = (await q('SELECT * FROM organes_gouvernance WHERE imf_id=$1', [imfId])).rows;
    const membres = (await q('SELECT * FROM membres_gouvernance WHERE imf_id=$1', [imfId])).rows;
    const mandats = (await q('SELECT * FROM mandats_instances WHERE imf_id=$1', [imfId])).rows;
    const sessions = (await q('SELECT * FROM sessions_et_pv WHERE imf_id=$1', [imfId])).rows;
    const resolutions = (await q('SELECT * FROM resolutions_et_recommandations WHERE imf_id=$1', [imfId])).rows;
    const inst = (await q('SELECT * FROM institution_gouvernance WHERE imf_id=$1', [imfId])).rows[0] || null;

    const alertes = [];
    // a) Organes obligatoires non créés
    const codes = new Set(organes.map((o) => o.code_organe));
    for (const d of DEFAULT_ORGANES) {
      if (d[4] && !codes.has(d[0])) alertes.push({ niveau: 'HAUTE', code: 'organe_manquant', texte: `Organe obligatoire non créé : ${d[1]}` });
    }
    // b) Quorum non atteint sur les sessions tenues
    for (const s of sessions) {
      if (s.quorum_atteint === false) alertes.push({ niveau: 'CRITIQUE', code: 'quorum', texte: `Quorum non atteint — session du ${fmtDate(s.date_session)}` });
    }
    // c) PV non signés sur sessions passées
    for (const s of sessions) {
      if (String(s.date_session).slice(0, 10) < today() && s.statut !== 'SIGNE_VERROUILLE') {
        alertes.push({ niveau: 'HAUTE', code: 'pv_non_signe', texte: `PV non signé — session du ${fmtDate(s.date_session)}` });
      }
    }
    // d) Casier judiciaire manquant ou de plus de 90 jours
    for (const m of membres.filter((x) => x.actif)) {
      const old = m.casier_judiciaire_date && (Date.now() - new Date(m.casier_judiciaire_date).getTime()) > CASIER_ALERT_DAYS * 86400000;
      if (!m.casier_judiciaire_date || old) {
        alertes.push({ niveau: 'MOYENNE', code: 'casier', texte: `Casier judiciaire à fournir (${CASIER_ALERT_DAYS} j) : ${m.nom_complet}` });
      }
    }
    // e) Mandats expirés non renouvelés
    for (const m of mandats) {
      const st = mandatStatut(m);
      if (st === 'EXPIRE') alertes.push({ niveau: 'HAUTE', code: 'mandat_expire', texte: 'Mandat expiré à renouveler' });
    }
    // f) Cumul de mandats au-delà du plafond
    const parMembre = {};
    for (const m of mandats) if (m.type_mandat === 'ADMINISTRATEUR') {
      const st = mandatStatut(m);
      if (st === 'EN_COURS' || st === 'RENOUVELE') parMembre[m.membre_id] = (parMembre[m.membre_id] || 0) + 1;
    }
    for (const [id, n] of Object.entries(parMembre)) {
      if (n >= 3) {
        const mb = membres.find((x) => x.id === id);
        alertes.push({ niveau: 'MOYENNE', code: 'cumul', texte: `Cumul de mandats (${n}) : ${mb ? mb.nom_complet : ''}` });
      }
    }
    // g) Résolutions en retard
    for (const x of resolutions) {
      if (x.statut === 'EN_RETARD') alertes.push({ niveau: 'HAUTE', code: 'resolution_retard', texte: `Résolution en retard : ${x.intitule}` });
    }
    // h) Fiche institution incomplète
    const champsObligatoires = ['raison_sociale', 'forme_juridique', 'rccm', 'ifu_nif', 'numero_agrement', 'siege_social'];
    const manquants = inst ? champsObligatoires.filter((c) => !inst[c]) : champsObligatoires;
    if (manquants.length) alertes.push({ niveau: 'HAUTE', code: 'fiche', texte: `Fiche institution incomplète (${manquants.length} champ(s))` });

    // Score de conformité : 100 si zéro écart, pénalité par gravité.
    const poids = { CRITIQUE: 10, HAUTE: 6, MOYENNE: 3, BASSE: 1 };
    const penalite = alertes.reduce((s, a) => s + (poids[a.niveau] || 2), 0);
    const score = Math.max(0, Math.min(100, 100 - penalite));

    const actifs = membres.filter((x) => x.actif);
    res.json({
      kpis: {
        score_conformite: score,
        organes: organes.length,
        organes_obligatoires: DEFAULT_ORGANES.filter((d) => d[4]).length,
        membres: actifs.length,
        femmes: actifs.filter((m) => m.sexe === 'F').length,
        mandats_en_cours: mandats.filter((m) => ['EN_COURS', 'RENOUVELE'].includes(mandatStatut(m))).length,
        sessions: sessions.length,
        pv_signes: sessions.filter((s) => s.statut === 'SIGNE_VERROUILLE').length,
        resolutions: resolutions.length,
        resolutions_realisees: resolutions.filter((x) => x.statut === 'REALISEE').length,
        resolutions_retard: resolutions.filter((x) => x.statut === 'EN_RETARD').length,
        alertes: alertes.length,
        taux_execution_resolutions: resolutions.length
          ? Math.round(resolutions.reduce((s, x) => s + Number(x.taux_execution || 0), 0) / resolutions.length) : 0
      },
      alertes: alertes.slice(0, 60),
      institution_complete: manquants.length === 0
    });
  } catch (e) { next(e); }
});

// ==========================================================================
// 8. TABLEAU DE BORD IMPRIMABLE (PDF via le navigateur)
// ============================================================================
r.get('/governance/rapport.pdf', async (req, res, next) => {
  try {
    const imfId = req.user.imf_id;
    const b = await getBranding(imfId);
    const inst = (await q('SELECT * FROM institution_gouvernance WHERE imf_id=$1', [imfId])).rows[0] || {};
    const organes = (await q('SELECT * FROM organes_gouvernance WHERE imf_id=$1 ORDER BY libelle', [imfId])).rows;
    const membres = (await q('SELECT * FROM membres_gouvernance WHERE imf_id=$1 AND actif=true ORDER BY fonction', [imfId])).rows;
    const mandats = (await q(
      `SELECT m.*, mb.nom_complet FROM mandats_instances m JOIN membres_gouvernance mb ON mb.id=m.membre_id
        WHERE m.imf_id=$1 ORDER BY m.date_debut DESC`, [imfId])).rows;
    const sessions = (await q(
      `SELECT s.*, o.libelle AS organe_libelle FROM sessions_et_pv s
         LEFT JOIN organes_gouvernance o ON o.id=s.organe_id
        WHERE s.imf_id=$1 ORDER BY s.date_session DESC LIMIT 12`, [imfId])).rows;
    const resolutions = (await q(
      `SELECT * FROM resolutions_et_recommandations WHERE imf_id=$1
        ORDER BY (statut='EN_RETARD') DESC, date_echeance NULLS LAST LIMIT 15`, [imfId])).rows;

    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const F = (d) => (d ? fmtDate(d) : '—');
    const row = (a, c) => `<tr><td>${esc(a)}</td><td>${esc(c)}</td></tr>`;

    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Rapport de gouvernance — ${esc(b.legal_name)}</title>
<style>
 *{box-sizing:border-box;margin:0;padding:0}
 body{font-family:'Segoe UI',system-ui,Arial,sans-serif;color:#0b0c26;background:#eef0f6;padding:24px}
 .sheet{max-width:840px;margin:0 auto;background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(11,12,38,.12);padding:36px 40px}
 .head{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #0b0c26;padding-bottom:16px}
 .head h1{font-size:20px} .head .m{font-size:11.5px;color:#61647c;line-height:1.6;margin-top:4px}
 .tag{background:#d8f500;color:#0b0c26;font-weight:800;font-size:11px;padding:5px 12px;border-radius:999px;height:fit-content}
 h2{font-size:13px;text-transform:uppercase;letter-spacing:.6px;margin:24px 0 8px;color:#0b0c26}
 h2 span{color:#61647c;font-weight:400;text-transform:none;letter-spacing:0}
 table{width:100%;border-collapse:collapse}
 th{background:#0b0c26;color:#fff;font-size:11px;text-transform:uppercase;padding:8px 10px;text-align:left}
 td{padding:8px 10px;border-bottom:1px solid #e3e5ee;font-size:12.5px}
 tr:nth-child(even) td{background:#f6f7fb}
 .kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px}
 .kpi div{background:#f6f7fb;border:1px solid #e3e5ee;border-radius:9px;padding:12px}
 .kpi b{display:block;font-size:22px} .kpi span{font-size:11px;color:#61647c}
 .ok{color:#2f6b00;font-weight:700}.warn{color:#8a6d00;font-weight:700}.bad{color:#b3261e;font-weight:700}
 .foot{margin-top:24px;border-top:1px solid #e3e5ee;padding-top:12px;font-size:10.5px;color:#61647c;display:flex;justify-content:space-between}
 @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0;max-width:none;padding:0}@page{size:A4;margin:12mm}}
</style></head><body><div class="sheet">
<div class="head"><div><h1>${esc(b.legal_name)}</h1>
<div class="m">${esc(inst.forme_juridique || '')} · RCCM ${esc(inst.rccm || '—')} · IFU/NIF ${esc(inst.ifu_nif || '—')}<br>
Agrément BCEAO ${esc(inst.numero_agrement || '—')} · Capital ${inst.capital_social_cents != null ? moneyFcfa(inst.capital_social_cents) : '—'}<br>
${esc(inst.siege_social || '')}</div></div><div class="tag">RAPPORT DE GOUVERNANCE</div></div>
<h2>Synthèse <span>— édité le ${fmtDate(new Date())}</span></h2>
<div class="kpi">
 <div><b>${organes.length}</b><span>Organes</span></div>
 <div><b>${membres.length}</b><span>Membres actifs</span></div>
 <div><b>${mandats.filter((m) => m.statut !== 'EXPIRE').length}</b><span>Mandats en cours</span></div>
 <div><b>${sessions.length}</b><span>Sessions archivées</span></div>
</div>
<h2>Organes statutaires</h2>
<table><tr><th>Organe</th><th>Type</th><th>Membres</th><th>Quorum</th><th>Fréquence</th><th>Obligatoire</th></tr>
 ${organes.map((o) => `<tr><td>${esc(o.libelle)}</td><td>${esc(o.type_organe)}</td><td>${o.nombre_membres}</td><td>${o.quorum_requis}</td><td>${esc(o.frequence_reunion || '—')}</td><td>${o.obligatoire ? 'Oui' : 'Non'}</td></tr>`).join('')}
</table>
<h2>Membres de gouvernance</h2>
<table><tr><th>Nom</th><th>Fonction</th><th>Qualité</th><th>Entrée</th><th>Casier</th></tr>
 ${membres.map((m) => `<tr><td>${esc(m.nom_complet)}</td><td>${esc(m.fonction)}</td><td>${esc(m.qualite || '—')}</td><td>${F(m.date_entree)}</td><td>${m.casier_judiciaire_ok === true ? 'Oui' : (m.casier_judiciaire_ok === false ? 'À clarifier' : 'Non fourni')}</td></tr>`).join('')}
</table>
<h2>Mandats</h2>
<table><tr><th>Membre</th><th>Fonction</th><th>Début</th><th>Fin</th><th>Renouv.</th><th>Statut</th></tr>
 ${mandats.map((m) => `<tr><td>${esc(m.nom_complet)}</td><td>${esc(m.fonction)}</td><td>${F(m.date_debut)}</td><td>${F(m.date_fin)}</td><td>${m.numero_renouvellement}</td><td>${esc(m.statut)}</td></tr>`).join('')}
</table>
<h2>Sessions & procès-verbaux</h2>
<table><tr><th>Date</th><th>Organe</th><th>Présents / quorum</th><th>PV</th><th>Statut</th></tr>
 ${sessions.map((s) => `<tr><td>${F(s.date_session)}</td><td>${esc(s.organe_libelle || '—')}</td><td>${s.nombre_presents} / ${s.quorum_requis}</td><td>${esc(s.pv_reference || '—')}</td><td>${esc(s.statut)}</td></tr>`).join('')}
</table>
<h2>Résolutions & recommandations</h2>
<table><tr><th>Intitulé</th><th>Responsable</th><th>Échéance</th><th>Avancement</th><th>Statut</th></tr>
 ${resolutions.map((x) => `<tr><td>${esc(x.intitule)}</td><td>${esc(x.responsable || '—')}</td><td>${F(x.date_echeance)}</td><td>${x.taux_execution}%</td><td>${esc(x.statut)}</td></tr>`).join('')}
</table>
<div class="foot"><span>${esc(b.legal_name)} — document interne de gouvernance</span><span>Édité avec teeBo</span></div>
</div></body></html>`;

    setDocumentCsp(res, { allowFrame: true });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { next(e); }
});

export default r;
