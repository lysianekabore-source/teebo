// ===========================================================================
// teebo — VAGUE 40 : ROUTES DU SCORING ALTERNATIF
// ---------------------------------------------------------------------------
// Préfixe : /api/v1/credit/scoring/…
//
//   Grilles      GET  /credit/scoring/grilles
//                PUT  /credit/scoring/grilles/:produitId   (produitId = "defaut")
//   Score        POST /credit/dossiers/:id/evaluer-score     (recalcul demandé)
//                GET  /credit/dossiers/:id/score             (dernier score + historique)
//                PATCH /credit/dossiers/:id/avis-bic         (avis BIC UEMOA saisi à la main)
//
// Invariants (mêmes règles que le module crédit) :
//   • imf_id vient TOUJOURS du jeton, jamais du corps de la requête ;
//   • aucune donnée d'une autre IMF ne peut être lue ni modifiée ;
//   • un score n'est jamais écrasé : chaque calcul ajoute une ligne
//     (historique et piste d'audit) ;
//   • le paramétrage des grilles n'est pas donné aux agents qui notent :
//     habilitations distinctes (paramétrer ≠ recalculer ≠ lire).
// ===========================================================================
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { habilit } from '../rbac_strict.js';
import { tenantTransaction } from '../tenant.js';
import { auditEvent } from '../audit.js';
import { estUuid, CreditError } from '../credit_engine.js';
import {
  evaluerScoring, verifierGrille, GRILLE_DEFAUT, poidsGrille,
  LIBELLE_CLASSE_RISQUE, AXES_RADAR, LIBELLE_PILIER
} from '../scoring_engine.js';

const r = Router();

const LECTURE = ['staff', 'agency', 'service', 'department', 'caissier', 'admin_imf', 'direction'];
const ANALYSE = ['staff', 'agency', 'service', 'department', 'admin_imf', 'direction'];
const PILOTAGE = ['admin_imf', 'direction', 'department', 'service'];

function echec(res, e) {
  if (e instanceof CreditError) {
    return res.status(e.status || 422).json({ error: e.code, message: e.message, detail: e.detail || null });
  }
  throw e;
}
const nombre = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/* ========================================================================
 *  A. GRILLES DE SCORING
 * ===================================================================== */

/** Grille applicable : celle du produit, sinon la grille par défaut de l'IMF. */
async function grillePour(c, imfId, produitId) {
  let g = null;
  if (estUuid(produitId)) {
    g = (await c.query(
      `SELECT * FROM grilles_scoring_credit
        WHERE imf_id=$1 AND produit_id=$2 AND actif`, [imfId, produitId])).rows[0] || null;
  }
  if (!g) {
    g = (await c.query(
      `SELECT * FROM grilles_scoring_credit
        WHERE imf_id=$1 AND produit_id IS NULL AND actif`)).rows[0] || null;
  }
  return g || { ...GRILLE_DEFAUT, id: null, imf_id: imfId, produit_id: null, actif: true, version: 1 };
}

/** Mise en forme lisible d'une grille (pour l'écran de paramétrage). */
function grillePublique(g) {
  const poids = poidsGrille(g);
  return {
    id: g.id || null,
    code: g.code || GRILLE_DEFAUT.code,
    libelle: g.libelle || GRILLE_DEFAUT.libelle,
    produit_id: g.produit_id || null,
    poids,
    axes: AXES_RADAR.map((k) => ({ cle: k, libelle: LIBELLE_PILIER[k] || k, poids: poids[k] })),
    seuils: {
      a: nombre(g.seuil_classe_a), b: nombre(g.seuil_classe_b), c: nombre(g.seuil_classe_c)
    },
    taux_effort_max_bp: nombre(g.taux_effort_max_bp),
    couverture_min_bp: nombre(g.couverture_min_bp),
    plafond_epargne_bp: nombre(g.plafond_epargne_bp),
    plafond_tontine_bp: nombre(g.plafond_tontine_bp),
    plafond_score_bp: nombre(g.plafond_score_bp),
    plafond_garantie_bp: nombre(g.plafond_garantie_bp),
    stabilite_min_m: nombre(g.stabilite_min_m),
    nb_visites_min: nombre(g.nb_visites_min),
    epargne_min_mois: nombre(g.epargne_min_mois),
    version: nombre(g.version) || 1,
    actif: g.actif !== false,
    maj_le: g.updated_at || g.created_at || null
  };
}

r.get('/credit/scoring/grilles', requireRole(...LECTURE),
  habilit('credit.scoring.read', 'credit.scoring.parametrer', 'credit.par.read'),
  async (req, res, next) => {
  try {
    const out = await tenantTransaction(req, async (c) => {
      const grilles = (await c.query(
        `SELECT g.*, p.code AS produit_code, p.libelle AS produit_libelle
           FROM grilles_scoring_credit g
           LEFT JOIN produits_credit p ON p.id = g.produit_id
          WHERE g.imf_id=$1
          ORDER BY (g.produit_id IS NULL) DESC, g.code`, [req.dbImfId])).rows;
      const produits = (await c.query(
        `SELECT id, code, libelle FROM produits_credit WHERE imf_id=$1 AND actif
          ORDER BY code`, [req.dbImfId])).rows;
      const defaut = await grillePour(c, req.dbImfId, null);
      return {
        grilles: grilles.map((g) => ({ ...grillePublique(g), produit_code: g.produit_code,
          produit_libelle: g.produit_libelle })),
        grille_defaut: grillePublique(defaut),
        produits,
        libelles: {
          piliers: AXES_RADAR.map((k) => ({ cle: k, libelle: LIBELLE_PILIER[k] || k })),
          classes: LIBELLE_CLASSE_RISQUE
        }
      };
    });
    res.json(out);
  } catch (e) { next(e); }
});

/**
 * Enregistrement d'une grille (création ou mise à jour).
 * Corps : { libelle?, poids_epargne, poids_flux, poids_stabilite_gps,
 *           poids_historique, poids_garanties, seuil_classe_a/b/c,
 *           taux_effort_max_bp?, couverture_min_bp?, … }
 */
r.put('/credit/scoring/grilles/:produitId', requireRole(...PILOTAGE),
  habilit('credit.scoring.parametrer'), async (req, res, next) => {
  try {
    const brut = String(req.params.produitId || '');
    const estDefaut = brut === 'defaut' || brut === 'default';
    if (!estDefaut && !estUuid(brut)) {
      return res.status(400).json({ error: 'produit_invalide',
        message: 'Ce produit de crédit est introuvable ou illisible.' });
    }
    const b = req.body || {};
    const grille = {
      ...GRILLE_DEFAUT,
      poids_epargne: b.poids_epargne != null ? Number(b.poids_epargne) : GRILLE_DEFAUT.poids_epargne,
      poids_flux: b.poids_flux != null ? Number(b.poids_flux) : GRILLE_DEFAUT.poids_flux,
      poids_stabilite_gps: b.poids_stabilite_gps != null ? Number(b.poids_stabilite_gps) : GRILLE_DEFAUT.poids_stabilite_gps,
      poids_historique: b.poids_historique != null ? Number(b.poids_historique) : GRILLE_DEFAUT.poids_historique,
      poids_garanties: b.poids_garanties != null ? Number(b.poids_garanties) : GRILLE_DEFAUT.poids_garanties,
      seuil_classe_a: b.seuil_classe_a != null ? Number(b.seuil_classe_a) : GRILLE_DEFAUT.seuil_classe_a,
      seuil_classe_b: b.seuil_classe_b != null ? Number(b.seuil_classe_b) : GRILLE_DEFAUT.seuil_classe_b,
      seuil_classe_c: b.seuil_classe_c != null ? Number(b.seuil_classe_c) : GRILLE_DEFAUT.seuil_classe_c,
      taux_effort_max_bp: b.taux_effort_max_bp != null ? Number(b.taux_effort_max_bp) : GRILLE_DEFAUT.taux_effort_max_bp,
      couverture_min_bp: b.couverture_min_bp != null ? Number(b.couverture_min_bp) : GRILLE_DEFAUT.couverture_min_bp,
      stabilite_min_m: b.stabilite_min_m != null ? Number(b.stabilite_min_m) : GRILLE_DEFAUT.stabilite_min_m,
      nb_visites_min: b.nb_visites_min != null ? Number(b.nb_visites_min) : GRILLE_DEFAUT.nb_visites_min
    };
    const defauts = verifierGrille(grille);
    if (defauts.length) {
      return res.status(400).json({ error: 'grille_invalide',
        message: defauts[0], details: defauts });
    }

    const out = await tenantTransaction(req, async (c) => {
      const produitId = estDefaut ? null : brut;
      if (produitId) {
        const p = (await c.query(
          `SELECT id FROM produits_credit WHERE id=$1 AND imf_id=$2`, [produitId, req.dbImfId])).rows[0];
        if (!p) throw new CreditError('produit_introuvable',
          'Ce produit de crédit n’existe pas dans votre institution.', null, 404);
      }
      const existante = (await c.query(
        `SELECT * FROM grilles_scoring_credit
          WHERE imf_id=$1 AND ` + (produitId ? 'produit_id=$2' : 'produit_id IS NULL'),
        produitId ? [req.dbImfId, produitId] : [req.dbImfId])).rows[0];

      let ligne;
      if (existante) {
        ligne = (await c.query(
          `UPDATE grilles_scoring_credit
              SET poids_epargne=$2, poids_flux=$3, poids_stabilite_gps=$4,
                  poids_historique=$5, poids_garanties=$6,
                  seuil_classe_a=$7, seuil_classe_b=$8, seuil_classe_c=$9,
                  taux_effort_max_bp=$10, couverture_min_bp=$11,
                  stabilite_min_m=$12, nb_visites_min=$13,
                  libelle=COALESCE(NULLIF($14,''), libelle),
                  version=version+1, actif=true, updated_by=$15, updated_at=now()
            WHERE id=$1 RETURNING *`,
          [existante.id, grille.poids_epargne, grille.poids_flux, grille.poids_stabilite_gps,
            grille.poids_historique, grille.poids_garanties,
            grille.seuil_classe_a, grille.seuil_classe_b, grille.seuil_classe_c,
            grille.taux_effort_max_bp, grille.couverture_min_bp,
            grille.stabilite_min_m, grille.nb_visites_min,
            b.libelle ? String(b.libelle).slice(0, 200) : null, req.user.id])).rows[0];
      } else {
        const code = produitId
          ? ('SCORING_' + String(b.code || 'PRODUIT').toUpperCase().replace(/[^A-Z0-9_]/g, '_')).slice(0, 60)
          : 'SCORING_INFORMEL_STD';
        ligne = (await c.query(
          `INSERT INTO grilles_scoring_credit
             (imf_id, tenant_id, code, libelle, produit_id,
              poids_epargne, poids_flux, poids_stabilite_gps, poids_historique, poids_garanties,
              seuil_classe_a, seuil_classe_b, seuil_classe_c,
              taux_effort_max_bp, couverture_min_bp, stabilite_min_m, nb_visites_min,
              created_by, updated_by)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
           RETURNING *`,
          [req.dbImfId, code,
            (b.libelle ? String(b.libelle) : (estDefaut
              ? 'Score secteur informel (standard)' : 'Score du produit')).slice(0, 200),
            produitId, grille.poids_epargne, grille.poids_flux, grille.poids_stabilite_gps,
            grille.poids_historique, grille.poids_garanties,
            grille.seuil_classe_a, grille.seuil_classe_b, grille.seuil_classe_c,
            grille.taux_effort_max_bp, grille.couverture_min_bp,
            grille.stabilite_min_m, grille.nb_visites_min])).rows[0];
      }
      return ligne;
    });

    await auditEvent(req.user, { action: 'credit.scoring.grille_maj',
      entity: 'grilles_scoring_credit', entityId: out.id,
      payload: { produit_id: out.produit_id, version: out.version } });

    res.json({ grille: grillePublique(out),
      message: 'Grille de scoring enregistrée (version ' + out.version + '). Les dossiers déjà notés gardent leur score d’origine : relancez le calcul pour appliquer la nouvelle grille.' });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/* ========================================================================
 *  B. AGRÉGATS (chaque requête est filtrée par imf_id)
 * ===================================================================== */

/** Rayon de dispersion (m) d'un ensemble de points GPS — formule de haversine. */
function rayonMetres(points) {
  const pts = (points || []).filter((p) => p && p.lat != null && p.lng != null)
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), acc: p.acc == null ? null : Number(p.acc) }));
  if (pts.length < 2) return { rayon_m: pts.length ? 0 : null, precision_moy_m: pts.length && pts[0].acc != null ? pts[0].acc : null };
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dist = (a, b) => {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const centre = {
    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
    lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length
  };
  const rayon = Math.max(...pts.map((p) => dist(centre, p)));
  const accs = pts.map((p) => p.acc).filter((a) => a != null);
  return {
    rayon_m: Math.round(rayon),
    precision_moy_m: accs.length ? Math.round(accs.reduce((s, a) => s + a, 0) / accs.length) : null
  };
}

/**
 * Collecte des agrégats d'un dossier, en LECTURE SEULE, cloisonnés par IMF.
 * Les erreurs d'une source optionnelle (table absente sur une base ancienne)
 * ne cassent pas l'évaluation : le pilier est simplement « non mesuré ».
 */
async function collecterAgregats(c, imfId, d) {
  const clientId = d.client_id;
  const dossierId = d.id;

  // --- 1. ÉPARGNE : comptes + dépôts sur 6 mois --------------------------
  let epargne = { anciennete_mois: 0, mois_actifs_6m: 0, solde_epargne_cents: 0 };
  try {
    const e = (await c.query(
      `SELECT COALESCE(SUM(a.balance_cents),0)::bigint AS solde,
              MIN(a.opened_at) AS ouverture
         FROM account a
        WHERE a.imf_id=$1 AND a.client_id=$2`, [imfId, clientId])).rows[0];
    const m = (await c.query(
      `SELECT COUNT(DISTINCT date_trunc('month', o.created_at))::int AS mois
         FROM operation o JOIN account a ON a.id = o.account_id
        WHERE a.imf_id=$1 AND a.client_id=$2
          AND o.status='valide' AND o.contre_passation_de IS NULL
          AND o.created_at >= now() - INTERVAL '6 months'`, [imfId, clientId])).rows[0];
    epargne = {
      solde_epargne_cents: Number(e.solde || 0),
      anciennete_mois: e.ouverture ? Math.floor((Date.now() - new Date(e.ouverture).getTime()) / (30.44 * 86400000)) : 0,
      mois_actifs_6m: Number(m.mois || 0)
    };
  } catch (err) { epargne._erreur = 'epargne_indisponible'; }

  // --- 2. TONTINE : cycles clos sur 6 mois -------------------------------
  let tontine = { cycles_tontine_complets_6m: 0, solde_tontine_cents: 0 };
  try {
    const t = (await c.query(
      `SELECT COUNT(*) FILTER (WHERE statut IN ('CLOTURE','RENOUVELE'))::int AS cycles,
              COALESCE(SUM(total_cotise_cents) FILTER (WHERE statut='EN_COURS'),0)::bigint AS en_cours
         FROM carnets_tontine
        WHERE imf_id=$1 AND client_id=$2
          AND date_debut >= CURRENT_DATE - INTERVAL '6 months'`, [imfId, clientId])).rows[0];
    tontine = { cycles_tontine_complets_6m: Number(t.cycles || 0), solde_tontine_cents: Number(t.en_cours || 0) };
  } catch (err) { tontine._erreur = 'tontine_indisponible'; }

  // --- 3. FLUX : vue_transactions_collecte, annulations exclues ----------
  let flux = { revenu_net_cents_mois: 0, mois_avec_flux_6m: 0, variation_flux_bp: 0 };
  try {
    const f = (await c.query(
      `SELECT date_trunc('month', COALESCE(date_operation_locale, created_at)) AS mois,
              SUM(amount_cents)::bigint AS montant, COUNT(*)::int AS nb
         FROM vue_transactions_collecte
        WHERE imf_id=$1 AND client_id=$2
          AND COALESCE(direction, 1) > 0
          AND statut_sync='SYNCHRONISE' AND contre_passation_de IS NULL
          AND COALESCE(date_operation_locale, created_at) >= now() - INTERVAL '6 months'
        GROUP BY 1 ORDER BY 1`, [imfId, clientId])).rows;
    const montants = f.map((x) => Number(x.montant || 0));
    const total = montants.reduce((s, x) => s + x, 0);
    const moyenne = montants.length ? total / montants.length : 0;
    const variance = montants.length > 1
      ? montants.reduce((s, x) => s + (x - moyenne) ** 2, 0) / montants.length : 0;
    const ecartType = Math.sqrt(variance);
    flux = {
      revenu_net_cents_mois: Math.round(montants.length ? total / 6 : 0),
      mois_avec_flux_6m: montants.length,
      variation_flux_bp: moyenne > 0 ? Math.round((ecartType / moyenne) * 10000) : 0
    };
  } catch (err) { flux._erreur = 'flux_indisponible'; }

  // --- 4. GPS : domicile du client + visites terrain ---------------------
  let stabilite = { nb_releves: 0, rayon_m: 0, precision_moy_m: 0, jours_dernier_releve: null, nb_visites_6m: 0 };
  try {
    const cl = (await c.query(
      `SELECT gps_lat, gps_lng, gps_accuracy_m, gps_captured_at
         FROM client WHERE id=$1 AND imf_id=$2`, [clientId, imfId])).rows[0] || {};
    const visites = (await c.query(
      `SELECT gps_lat, gps_lng, accuracy_m, visit_date
         FROM client_visit_log
        WHERE imf_id=$1 AND client_id=$2
          AND visit_date >= CURRENT_DATE - INTERVAL '6 months'
        ORDER BY visit_date DESC LIMIT 40`, [imfId, clientId])).rows || [];
    const points = [];
    if (cl.gps_lat != null) points.push({ lat: cl.gps_lat, lng: cl.gps_lng, acc: cl.gps_accuracy_m });
    visites.forEach((v) => points.push({ lat: v.gps_lat, lng: v.gps_lng, acc: v.accuracy_m }));
    const disp = rayonMetres(points);
    const dernier = cl.gps_captured_at
      ? Math.floor((Date.now() - new Date(cl.gps_captured_at).getTime()) / 86400000)
      : (visites[0] ? Math.floor((Date.now() - new Date(visites[0].visit_date).getTime()) / 86400000) : null);
    stabilite = {
      nb_releves: points.filter((p) => p.lat != null && p.lng != null).length,
      rayon_m: disp.rayon_m == null ? 0 : disp.rayon_m,
      precision_moy_m: disp.precision_moy_m == null ? 0 : disp.precision_moy_m,
      jours_dernier_releve: dernier,
      nb_visites_6m: visites.length
    };
  } catch (err) { stabilite._erreur = 'gps_indisponible'; }

  // --- 5. HISTORIQUE : crédits passés du client --------------------------
  let historique = { nb_credits: 0, nb_credits_clos: 0, nb_retards_graves: 0,
    jours_retard_moyen: 0, impaye_cents: 0, avis_bic_uemoa: null };
  try {
    const h = (await c.query(
      `SELECT COUNT(*) FILTER (WHERE statut IN ('CLOTURE_SOLDE','DECAISSE'))::int AS nb,
              COUNT(*) FILTER (WHERE statut='CLOTURE_SOLDE')::int AS clos,
              COUNT(*) FILTER (WHERE jours_retard >= 30)::int AS retards,
              COALESCE(AVG(jours_retard),0) AS retard_moyen,
              COALESCE(SUM(montant_impaye_cents) FILTER (WHERE statut='DECAISSE'),0)::bigint AS impaye
         FROM dossiers_credit
        WHERE imf_id=$1 AND client_id=$2 AND id <> $3`, [imfId, clientId, dossierId])).rows[0];
    historique = {
      nb_credits: Number(h.nb || 0), nb_credits_clos: Number(h.clos || 0),
      nb_retards_graves: Number(h.retards || 0),
      jours_retard_moyen: Math.round(Number(h.retard_moyen || 0)),
      impaye_cents: Number(h.impaye || 0),
      avis_bic_uemoa: d.avis_bic_uemoa || null
    };
  } catch (err) { historique._erreur = 'historique_indisponible'; }

  // --- 6. GARANTIES du dossier ------------------------------------------
  let garanties = { nb_garanties: 0, garanties_constituees_cents: 0, garanties_engagees_cents: 0, type_principal: null };
  try {
    const g = (await c.query(
      `SELECT COUNT(*)::int AS nb,
              COALESCE(SUM(CASE WHEN statut='BLOQUEE'
                THEN GREATEST(montant_cents, montant_bloque_cents) ELSE 0 END),0)::bigint AS constituees,
              COALESCE(SUM(montant_cents),0)::bigint AS engagees,
              (SELECT type_garantie FROM garanties_credit
                WHERE dossier_id=$2 AND imf_id=$1 ORDER BY montant_cents DESC LIMIT 1) AS type_principal
         FROM garanties_credit WHERE dossier_id=$2 AND imf_id=$1`, [imfId, dossierId])).rows[0];
    garanties = {
      nb_garanties: Number(g.nb || 0),
      garanties_constituees_cents: Number(g.constituees || 0),
      garanties_engagees_cents: Number(g.engagees || 0),
      type_principal: g.type_principal || null
    };
  } catch (err) { garanties._erreur = 'garanties_indisponible'; }

  return { epargne: { ...epargne, ...tontine }, flux, stabilite, historique, garanties };
}

/**
 * Calcule et enregistre une évaluation. `declencheur` ∈ EN_ANALYSE | MANUEL | COMITE.
 * Rend { evaluation, score } ; lève si le dossier n'est pas de l'IMF.
 */
export async function evaluerEtEnregistrer(req, c, dossier, declencheur) {
  const imfId = req.dbImfId;
  const t0 = Date.now();
  const grille = await grillePour(c, imfId, dossier.produit_id);
  const ag = await collecterAgregats(c, imfId, dossier);
  const resultat = evaluerScoring({
    dossier: {
      montant_demande_cents: Number(dossier.montant_demande_cents || 0),
      duree_mois: Number(dossier.duree_mois || 1),
      periodicite: dossier.periodicite
    },
    epargne: ag.epargne, flux: ag.flux, stabilite: ag.stabilite,
    historique: ag.historique, garanties: ag.garanties,
    grille, avis_bic_uemoa: dossier.avis_bic_uemoa || null
  });

  const ligne = (await c.query(
    `INSERT INTO evaluations_scoring_credit
       (imf_id, tenant_id, dossier_credit_id, grille_id, score_global, classe_risque,
        plafond_montant_suggere_cents, montant_demande_cents, details_indicateurs_json,
        declencheur, calcule_par, duree_ms)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
     RETURNING id, score_global, classe_risque, plafond_montant_suggere_cents,
               montant_demande_cents, declencheur, calcule_le`,
    [imfId, dossier.id, grille.id || null, resultat.score_global, resultat.classe_risque,
      resultat.plafond_montant_suggere_cents, resultat.montant_demande_cents,
      JSON.stringify(resultat.details_indicateurs_json), declencheur,
      req.user ? req.user.id : null, Date.now() - t0])).rows[0];

  return {
    evaluation: ligne,
    score: {
      ...ligne,
      score_global: Number(ligne.score_global),
      plafond_montant_suggere_cents: Number(ligne.plafond_montant_suggere_cents),
      montant_demande_cents: Number(ligne.montant_demande_cents),
      libelle_classe: LIBELLE_CLASSE_RISQUE[ligne.classe_risque],
      synthese: resultat.synthese,
      details_indicateurs_json: resultat.details_indicateurs_json,
      grille: { id: grille.id || null, code: grille.code || GRILLE_DEFAUT.code,
        libelle: grille.libelle || GRILLE_DEFAUT.libelle, version: nombre(grille.version) || 1 }
    }
  };
}

/** Route publique de recalcul (aussi utilisée par les autres routes crédit). */
export async function recalculerScore(req, dossier, declencheur) {
  return tenantTransaction(req, async (c) => {
    const ligne = (await c.query(
      `SELECT * FROM dossiers_credit WHERE id=$1 AND imf_id=$2`,
      [dossier.id, req.dbImfId])).rows[0];
    if (!ligne) throw new CreditError('dossier_introuvable',
      'Ce dossier n’existe pas dans votre institution.', null, 404);
    return evaluerEtEnregistrer(req, c, ligne, declencheur || 'MANUEL');
  });
}

/* ========================================================================
 *  C. ROUTES DU DOSSIER
 * ===================================================================== */

r.post('/credit/dossiers/:id/evaluer-score', requireRole(...ANALYSE),
  habilit('credit.scoring.recalculer', 'credit.dossier.monter'),
  async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide',
      message: 'Identifiant de dossier illisible.' });
    const dossier = (await tenantTransaction(req, async (c) => (await c.query(
      `SELECT * FROM dossiers_credit WHERE id=$1 AND imf_id=$2`, [id, req.dbImfId])).rows[0])) ;
    if (!dossier) return res.status(404).json({ error: 'dossier_introuvable',
      message: 'Ce dossier n’existe pas dans votre institution.' });

    const out = await recalculerScore(req, dossier, 'MANUEL');
    await auditEvent(req.user, { action: 'credit.scoring.recalcul',
      entity: 'evaluations_scoring_credit', entityId: out.evaluation.id,
      payload: { dossier_id: id, score: out.score.score_global, classe: out.score.classe_risque } });
    res.status(201).json({ ...out,
      message: 'Score recalculé : ' + out.score.score_global.toFixed(1).replace('.', ',')
        + '/100, classe ' + out.score.classe_risque + '.' });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

r.get('/credit/dossiers/:id/score', requireRole(...LECTURE),
  habilit('credit.scoring.read', 'credit.par.read', 'credit.dossier.monter',
    'credit.dossier.approuver'),
  async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide',
      message: 'Identifiant de dossier illisible.' });
    const out = await tenantTransaction(req, async (c) => {
      const dossier = (await c.query(
        `SELECT * FROM dossiers_credit WHERE id=$1 AND imf_id=$2`, [id, req.dbImfId])).rows[0];
      if (!dossier) return null;
      const evals = (await c.query(
        `SELECT e.*, u.full_name AS calcule_par_nom
           FROM evaluations_scoring_credit e
           LEFT JOIN app_user u ON u.id = e.calcule_par
          WHERE e.imf_id=$1 AND e.dossier_credit_id=$2
          ORDER BY e.calcule_le DESC LIMIT 12`, [req.dbImfId, id])).rows;
      const grille = await grillePour(c, req.dbImfId, dossier.produit_id);
      return { dossier, evals, grille: grillePublique(grille) };
    });
    if (!out) return res.status(404).json({ error: 'dossier_introuvable',
      message: 'Ce dossier n’existe pas dans votre institution.' });

    const derniere = out.evals[0] || null;
    const score = derniere ? {
      ...derniere,
      score_global: Number(derniere.score_global),
      plafond_montant_suggere_cents: Number(derniere.plafond_montant_suggere_cents),
      montant_demande_cents: Number(derniere.montant_demande_cents),
      libelle_classe: LIBELLE_CLASSE_RISQUE[derniere.classe_risque]
    } : null;
    res.json({
      score,
      historique: out.evals.map((e) => ({
        id: e.id, score_global: Number(e.score_global), classe_risque: e.classe_risque,
        plafond_montant_suggere_cents: Number(e.plafond_montant_suggere_cents),
        declencheur: e.declencheur, calcule_le: e.calcule_le, calcule_par_nom: e.calcule_par_nom
      })),
      grille: out.grille
    });
  } catch (e) { next(e); }
});

/** Avis BIC UEMOA saisi à la main (aucune interconnexion à la Centrale des Risques). */
r.patch('/credit/dossiers/:id/avis-bic', requireRole(...ANALYSE),
  habilit('credit.scoring.recalculer', 'credit.dossier.monter'),
  async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide',
      message: 'Identifiant de dossier illisible.' });
    const avis = req.body && req.body.avis_bic_uemoa
      ? String(req.body.avis_bic_uemoa).toUpperCase().slice(0, 1) : null;
    if (avis !== null && ['A', 'B', 'C', 'D'].indexOf(avis) < 0) {
      return res.status(400).json({ error: 'avis_invalide',
        message: 'L’avis BIC doit être A, B, C ou D (ou laissé vide si non disponible).' });
    }
    const dossier = (await tenantTransaction(req, async (c) => (await c.query(
      `SELECT * FROM dossiers_credit WHERE id=$1 AND imf_id=$2`, [id, req.dbImfId])).rows[0]));
    if (!dossier) return res.status(404).json({ error: 'dossier_introuvable',
      message: 'Ce dossier n’existe pas dans votre institution.' });

    // L'avis est d'abord persisté sur le dossier, puis le score est recalculé
    // depuis la valeur enregistrée (jamais depuis le corps de la requête seule).
    await tenantTransaction(req, async (c) => c.query(
      `UPDATE dossiers_credit SET avis_bic_uemoa=$2, updated_at=now()
        WHERE id=$1 AND imf_id=$3`, [id, avis, req.dbImfId]));

    const out = await recalculerScore(req, dossier, 'MANUEL');
    await auditEvent(req.user, { action: 'credit.scoring.avis_bic',
      entity: 'dossiers_credit', entityId: id, payload: { avis_bic_uemoa: avis } });
    res.json({ avis_bic_uemoa: avis, ...out,
      message: 'Avis BIC enregistré' + (avis ? ' (classe ' + avis + ')' : ' (non disponible)')
        + ' et score recalculé.' });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

export default r;
