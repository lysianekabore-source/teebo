// teebo — MOTEUR DE RÈGLES « CAPITAL & TITRES » (vague 33)
// ---------------------------------------------------------------------------
// Ce module concentre TOUTES les règles métier de l'actionnariat (SA) et du
// sociétariat (SCOOPS). Il est appelé PAR LES ROUTES du serveur (aucun écran ne
// recalcule une règle de son côté) : la même décision est donc rendue par
// l'API, par les exports et par l'interface.
//
//   SA     1 action = 1 voix ; franchissement d'un seuil (10/20/33/50 %)
//          => mouvement accepté mais NON validé tant que l'autorisation de la
//          tutelle n'est pas téléversée ; une personne morale sans bénéficiaire
//          effectif déclaré ne peut pas être validée (LBC/FT UMOA).
//
//   SCOOP  1 sociétaire = 1 voix quel que soit le nombre de parts ; plafond de
//          parts par membre (statuts) ; retrait bloqué si un crédit est en
//          cours ou si le capital passe sous le minimum réglementaire ;
//          plafond de procurations par sociétaire.
//
// Aucun seuil n'est écrit en dur : tout vient de parametres_capital
// (paramétrable par IMF, donc par pays).
//
// CORRECTIFS DE LA VAGUE 33 (bugs trouvés lors de la relecture) :
//   1. `controlerMouvement` ne comptait que les mouvements déjà enregistrés
//      pour calculer les seuils : un premier apport de 40 % ne franchissait
//      jamais le seuil de 33 %. Le total est désormais projeté AVANT écriture.
//   2. Une cession ne pouvait jamais faire franchir un seuil ni être signalée
//      sur le capital minimum en SA : la baisse est maintenant contrôlée.
//   3. `valeur_nominale_part_cents` est stocké en CENTIMES ; la valeur utilisée
//      pour les retraits était lue en francs (erreur de facteur 100).
//   4. `detenteursInvalides` oubliait le cloisonnement par IMF sur les
//      bénéficiaires effectifs.
//   5. Le cap « bénéficiaire effectif » ne s'appliquait pas aux personnes
//      morales déjà actives au moment de la déclaration : contrôle ajouté.
//   6. Une erreur SQL (table absente juste après migration) renvoyait un 500
//      au lieu du repli sur les paramètres par défaut.
// ---------------------------------------------------------------------------
import { q } from './db.js';

export const FORMES_SCOOP = ['COOPERATIVE', 'SCOOPS', 'SOCIETE_COOPERATIVE', 'COOPERATIVE_SCOOPS'];

/** Défauts appliqués quand l'IMF n'a pas encore enregistré ses paramètres. */
export const PARAM_DEFAUT = {
  valeur_nominale_part_cents: null,
  capital_minimum_reglementaire_cents: null,
  plafond_parts_par_membre: 500,
  plafond_procurations_par_membre: 1,
  seuils_participation_pct: '10,20,33,50',
  quorum_ago_1_pct: 50,
  quorum_ago_2_pct: 25,
  quorum_age_pct: 50,
  bloquer_retrait_credit_en_cours: true,
  bloquer_retrait_sous_capital_min: true
};

/** Forme juridique de l'IMF et bascule SA / SCOOPS. */
export async function formeJuridique(imfId) {
  let forme = 'SA';
  try {
    const { rows } = await q(
      'SELECT forme_juridique FROM institution_gouvernance WHERE imf_id=$1', [imfId]);
    forme = (rows[0] && rows[0].forme_juridique) || 'SA';
  } catch (e) {
    // Fiche de gouvernance pas encore créée : une SA est la valeur par défaut.
    console.warn('[capital] forme juridique indisponible :', short(e));
  }
  return { forme, coop: FORMES_SCOOP.includes(String(forme).toUpperCase()) };
}

const short = (e) => String((e && e.message) || e || '').slice(0, 160);

/** Paramètres du capital (avec repli sur les valeurs par défaut). */
export async function getParametresCapital(imfId) {
  let row = null;
  try {
    const { rows } = await q('SELECT * FROM parametres_capital WHERE imf_id=$1', [imfId]);
    row = rows[0] || null;
  } catch (e) {
    row = null; // table pas encore migrée : on continue avec les défauts
    console.warn('[capital] paramètres indisponibles :', short(e));
  }
  const p = Object.assign({}, PARAM_DEFAUT, row || {});
  p.seuils = String(p.seuils_participation_pct || '10,20,33,50')
    .split(',')
    .map((x) => Number(String(x).trim().replace(',', '.')))
    .filter((x) => Number.isFinite(x) && x > 0 && x <= 100)
    .sort((a, b) => a - b);
  if (!p.seuils.length) p.seuils = [10, 20, 33, 50];
  return p;
}

/** Écrit (ou met à jour) les paramètres du capital d'une IMF. */
export async function saveParametresCapital(imfId, b, userId) {
  const { rows } = await q(
    `INSERT INTO parametres_capital (imf_id, valeur_nominale_part_cents, capital_minimum_reglementaire_cents,
        plafond_parts_par_membre, plafond_procurations_par_membre, seuils_participation_pct,
        quorum_ago_1_pct, quorum_ago_2_pct, quorum_age_pct, bloquer_retrait_credit_en_cours,
        bloquer_retrait_sous_capital_min, observations, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (imf_id) DO UPDATE SET
        valeur_nominale_part_cents=EXCLUDED.valeur_nominale_part_cents,
        capital_minimum_reglementaire_cents=EXCLUDED.capital_minimum_reglementaire_cents,
        plafond_parts_par_membre=EXCLUDED.plafond_parts_par_membre,
        plafond_procurations_par_membre=EXCLUDED.plafond_procurations_par_membre,
        seuils_participation_pct=EXCLUDED.seuils_participation_pct,
        quorum_ago_1_pct=EXCLUDED.quorum_ago_1_pct,
        quorum_ago_2_pct=EXCLUDED.quorum_ago_2_pct,
        quorum_age_pct=EXCLUDED.quorum_age_pct,
        bloquer_retrait_credit_en_cours=EXCLUDED.bloquer_retrait_credit_en_cours,
        bloquer_retrait_sous_capital_min=EXCLUDED.bloquer_retrait_sous_capital_min,
        observations=EXCLUDED.observations, updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING *`,
    [imfId,
      b.valeur_nominale_part_cents === undefined ? null : b.valeur_nominale_part_cents,
      b.capital_minimum_reglementaire_cents === undefined ? null : b.capital_minimum_reglementaire_cents,
      b.plafond_parts_par_membre === undefined ? PARAM_DEFAUT.plafond_parts_par_membre : b.plafond_parts_par_membre,
      b.plafond_procurations_par_membre === undefined ? PARAM_DEFAUT.plafond_procurations_par_membre : b.plafond_procurations_par_membre,
      b.seuils_participation_pct || PARAM_DEFAUT.seuils_participation_pct,
      b.quorum_ago_1_pct === undefined ? PARAM_DEFAUT.quorum_ago_1_pct : b.quorum_ago_1_pct,
      b.quorum_ago_2_pct === undefined ? PARAM_DEFAUT.quorum_ago_2_pct : b.quorum_ago_2_pct,
      b.quorum_age_pct === undefined ? PARAM_DEFAUT.quorum_age_pct : b.quorum_age_pct,
      b.bloquer_retrait_credit_en_cours !== false,
      b.bloquer_retrait_sous_capital_min !== false,
      b.observations || null, userId || null]);
  return rows[0];
}

/**
 * Soldes de titres par détenteur.
 * titres    = titres en circulation (souscriptions - cessions - remboursements)
 * souscrit  = montant souscrit cumulé (hors sorties)
 * libere    = montant effectivement libéré cumulé (hors sorties)
 */
export async function soldesTitres(imfId) {
  const { rows } = await q(
    `SELECT detenteur_id,
            SUM(CASE WHEN type_operation IN ('CESSION','REMBOURSEMENT_SORTIE')
                     THEN -nombre_titres ELSE nombre_titres END)::int AS titres,
            SUM(CASE WHEN type_operation IN ('CESSION','REMBOURSEMENT_SORTIE') THEN 0
                     ELSE montant_total END)::numeric AS souscrit,
            SUM(CASE WHEN type_operation IN ('CESSION','REMBOURSEMENT_SORTIE') THEN 0
                     ELSE montant_libere END)::numeric AS libere
       FROM mouvements_titres WHERE imf_id=$1 GROUP BY detenteur_id`, [imfId]);
  const map = {};
  rows.forEach((x) => {
    map[x.detenteur_id] = {
      titres: Number(x.titres || 0),
      souscrit: Number(x.souscrit || 0),
      libere: Number(x.libere || 0)
    };
  });
  return map;
}

/**
 * Chiffres du capital : agrégats de la vue « Répartition du capital » et
 * base de calcul des contrôles de seuils. Une seule requête pour les
 * détenteurs ET leurs soldes (les écrans ne recalculent rien).
 */
export async function syntheseCapital(imfId) {
  const { forme, coop } = await formeJuridique(imfId);
  const p = await getParametresCapital(imfId);
  const { rows: det } = await q(
    `SELECT d.id, d.categorie, d.type_entite, d.statut, d.est_membre_fondateur,
            d.plafond_parts, d.nom_ou_raison_sociale, d.numero_registre,
            COALESCE(s.titres,0) AS titres,
            COALESCE(s.souscrit,0) AS souscrit, COALESCE(s.libere,0) AS libere
       FROM detenteurs_capital d
       LEFT JOIN (SELECT detenteur_id,
                         SUM(CASE WHEN type_operation IN ('CESSION','REMBOURSEMENT_SORTIE')
                                  THEN -nombre_titres ELSE nombre_titres END)::int AS titres,
                         SUM(CASE WHEN type_operation IN ('CESSION','REMBOURSEMENT_SORTIE') THEN 0
                                  ELSE montant_total END)::numeric AS souscrit,
                         SUM(CASE WHEN type_operation IN ('CESSION','REMBOURSEMENT_SORTIE') THEN 0
                                  ELSE montant_libere END)::numeric AS libere
                    FROM mouvements_titres WHERE imf_id=$1 GROUP BY detenteur_id) s
              ON s.detenteur_id=d.id
      WHERE d.imf_id=$1`, [imfId]);
  const actifs = det.filter((x) => x.statut === 'ACTIF');
  const titresTotal = actifs.reduce((a, x) => a + Number(x.titres || 0), 0);
  const souscrit = actifs.reduce((a, x) => a + Number(x.souscrit || 0), 0);
  const libere = actifs.reduce((a, x) => a + Number(x.libere || 0), 0);
  const nonLi = Math.max(0, souscrit - libere);
  const { rows: inst } = await q(
    'SELECT capital_social_cents FROM institution_gouvernance WHERE imf_id=$1', [imfId]);
  const capitalStatutaire = Number((inst[0] && inst[0].capital_social_cents) || 0) / 100;
  const capitalMinReg = p.capital_minimum_reglementaire_cents == null
    ? null : Number(p.capital_minimum_reglementaire_cents) / 100;
  // Concentration : utile pour le seuil d'information des participations.
  const classement = actifs.slice().sort((a, b) => Number(b.titres || 0) - Number(a.titres || 0));
  const partPct = (n) => (titresTotal > 0 ? +((n / titresTotal) * 100).toFixed(2) : null);
  return {
    forme, coop, parametres: p,
    detenteurs: det.map((x) => Object.assign({}, x, { part_pct: partPct(Number(x.titres || 0)) })),
    actifs,
    titres_total: titresTotal,
    capital_souscrit: souscrit,
    capital_libere: libere,
    capital_non_libere: nonLi,
    capital_statutaire: capitalStatutaire,
    capital_minimum_reglementaire: capitalMinReg,
    conforme_minimum: capitalMinReg == null ? null : libere >= capitalMinReg,
    taux_liberation: souscrit > 0 ? +(libere / souscrit * 100).toFixed(2) : null,
    part_premier: classement.length ? partPct(Number(classement[0].titres || 0)) : null,
    part_cinq_premiers: classement.length
      ? partPct(classement.slice(0, 5).reduce((a, x) => a + Number(x.titres || 0), 0)) : null
  };
}

/**
 * Seuils réglementaires franchis entre deux positions.
 * Renvoie la liste des seuils croisés (ex. [10, 20]).
 */
export function seuilsFranchis(avant, apres, total, seuils) {
  if (!total || total <= 0) return [];
  const pAvant = (avant / total) * 100;
  const pApres = (apres / total) * 100;
  return (seuils || []).filter((s) => pAvant < s && pApres >= s);
}

/**
 * Contrôle d'un mouvement de titres AVANT écriture.
 * Renvoie { ok, bloquant, motifs[], seuils[], statut }.
 *   bloquant = true  => le mouvement doit être refusé (400/409)
 *   statut = 'EN_ATTENTE_AUTORISATION' => accepté mais non validé
 *
 * Le total de titres est projeté AVANT écriture : c'est la situation qui
 * existera après validation qui décide du franchissement de seuil.
 */
export async function controlerMouvement(imfId, det, b) {
  const { forme, coop } = await formeJuridique(imfId);
  const p = await getParametresCapital(imfId);
  const soldes = await soldesTitres(imfId);
  const solde = soldes[det.id] || { titres: 0, souscrit: 0, libere: 0 };
  const op = String(b.type_operation || 'SOUSCRIPTION_INITIALE');
  const n = Number(b.nombre_titres || 0);
  const motifs = [];
  const sortie = op === 'CESSION' || op === 'REMBOURSEMENT_SORTIE';

  // --- 1. Contrôles communs -----------------------------------------------
  if (!Number.isFinite(n) || n <= 0) return { ok: false, bloquant: true, motifs: ['nombre_titres_invalide'] };
  if (sortie && n > solde.titres) {
    return { ok: false, bloquant: true, motifs: ['titres_insuffisants'], disponibles: solde.titres };
  }
  if (det.statut !== 'ACTIF' && !sortie) {
    return { ok: false, bloquant: true, motifs: ['detenteur_non_actif'] };
  }
  // Le montant libéré ne peut jamais dépasser le montant souscrit.
  const mt = Number(b.montant_total != null ? b.montant_total : 0);
  const ml = Number(b.montant_libere != null ? b.montant_libere : 0);
  if (mt > 0 && ml > mt) return { ok: false, bloquant: true, motifs: ['montant_libere_superieur_au_total'] };

  const totaux = Object.values(soldes).reduce((a, x) => a + x.titres, 0);
  const titresDetApres = solde.titres + (sortie ? -n : n);
  const totalApres = Math.max(0, totaux + (sortie ? -n : n));

  // Valeur au nominal (en francs) : parametres_capital est stocké en centimes.
  const vnDuParametre = p.valeur_nominale_part_cents != null
    ? Number(p.valeur_nominale_part_cents) / 100 : 0;
  const vn = Number(b.valeur_nominale_unitaire != null ? b.valeur_nominale_unitaire : vnDuParametre) || 0;

  // --- 2. Règles SCOOP ----------------------------------------------------
  if (coop) {
    // 2.1 Plafond de parts sociales par membre (anti-prise de contrôle).
    const plafond = det.plafond_parts != null ? Number(det.plafond_parts)
      : (p.plafond_parts_par_membre != null ? Number(p.plafond_parts_par_membre) : null);
    if (!sortie && plafond != null && plafond > 0 && titresDetApres > plafond) {
      return {
        ok: false, bloquant: true, motifs: ['plafond_parts_societaire_depasse'],
        detail: { plafond, detenu_apres: titresDetApres }
      };
    }
    // 2.2 Retrait bloqué tant qu'un crédit est en cours.
    let encoursCredit = 0;
    if (det.client_id) {
      const { rows } = await q(
        `SELECT COALESCE(SUM(COALESCE(approved_amount_cents, amount_cents)),0)::bigint AS s
           FROM credit_file
          WHERE imf_id=$1 AND client_id=$2 AND status='decaisse'`,
        [imfId, det.client_id]);
      encoursCredit = Number((rows[0] && rows[0].s) || 0) / 100;
    }
    if (op === 'REMBOURSEMENT_SORTIE' && encoursCredit > 0 && p.bloquer_retrait_credit_en_cours) {
      return {
        ok: false, bloquant: true, motifs: ['retrait_bloque_credit_en_cours'],
        detail: { encours_credit: encoursCredit }
      };
    }
    // 2.3 Retrait bloqué si le capital repasse sous le minimum réglementaire.
    if (op === 'REMBOURSEMENT_SORTIE' && p.bloquer_retrait_sous_capital_min) {
      const syn = await syntheseCapital(imfId);
      const valeurRetrait = Number(b.montant_total != null ? b.montant_total : (vn * n)) || 0;
      const capitalApres = syn.capital_libere - valeurRetrait;
      if (syn.capital_minimum_reglementaire != null && capitalApres < syn.capital_minimum_reglementaire) {
        return {
          ok: false, bloquant: true, motifs: ['capital_sous_minimum_reglementaire'],
          detail: { capital_apres: +capitalApres.toFixed(2), minimum: syn.capital_minimum_reglementaire }
        };
      }
    }
    // En SCOOP, aucun seuil de participation n'est surveillé : 1 membre = 1 voix.
    return {
      ok: true, bloquant: false, motifs: [], seuils: [], statut: 'VALIDE', coop: true,
      titres_detenteur_apres: titresDetApres, titres_total_apres: totalApres
    };
  }

  // --- 3. Règles SA --------------------------------------------------------
  // 3.1 Franchissement de seuil : calculé sur la situation projetée, à la
  //     hausse comme à la baisse (une cession qui repasse sous 33 % est
  //     signalée pour information, elle ne bloque jamais).
  const seuils = seuilsFranchis(solde.titres, titresDetApres, totalApres, p.seuils);
  let statut = 'VALIDE';
  if (seuils.length) {
    motifs.push(sortie ? 'seuil_participation_abaissé' : 'autorisation_bceao_requise');
    // La déclaration de baisse ne bloque pas la validation (elle réduit la
    // position) ; une hausse reste en attente d'autorisation.
    if (!sortie) statut = 'EN_ATTENTE_AUTORISATION';
  }
  // 3.2 Personne morale sans bénéficiaire effectif : validation impossible.
  if (det.type_entite === 'PERSONNE_MORALE' && !sortie) {
    const { rows } = await q(
      `SELECT COUNT(*)::int AS n FROM beneficiaires_effectifs
        WHERE detenteur_id=$1 AND imf_id=$2`, [det.id, imfId]);
    if (!((rows[0] && rows[0].n) > 0)) {
      motifs.push('beneficiaire_effectif_requis');
      statut = 'EN_ATTENTE_AUTORISATION';
    }
  }

  return {
    ok: true, bloquant: false, motifs, seuils, statut, coop: false,
    titres_detenteur_apres: titresDetApres, titres_total_apres: totalApres
  };
}

/**
 * Contrôle final avant validation d'un actionnaire (tableau de bord
 * « actionnaires à risque ») : une personne morale doit avoir au moins un
 * bénéficiaire effectif déclaré.
 */
export async function detenteursInvalides(imfId) {
  const { rows } = await q(
    `SELECT d.id, d.nom_ou_raison_sociale, d.numero_registre
       FROM detenteurs_capital d
      WHERE d.imf_id=$1 AND d.type_entite='PERSONNE_MORALE' AND d.statut='ACTIF'
        AND NOT EXISTS (SELECT 1 FROM beneficiaires_effectifs b
                         WHERE b.detenteur_id=d.id AND b.imf_id=d.imf_id)`,
    [imfId]);
  return rows;
}

/**
 * Voix attribuées à un détenteur.
 *   SCOOP : strictement 1 voix, quel que soit le nombre de parts.
 *   SA    : 1 action = 1 voix.
 */
export function voixAttribuees(categorie, titres, coop) {
  if (coop || categorie === 'MEMBRE_SCOOP') return 1;
  return Math.max(0, Number(titres) || 0);
}

/**
 * Éligibilité d'un membre SCOOP à siéger (CA / comité de crédit).
 * Règles : être ACTIF, avoir au moins une part, ne pas avoir d'impayé de plus
 * de 90 jours, et détenir un compte client dans l'IMF.
 *
 * CORRECTIF : `overdue` / `overdue_since` ne sont pas des colonnes
 * universelles de credit_file — la lecture de ces colonnes faisait échouer la
 * route entière (500). Le retard est désormais calculé sur les échéances
 * réellement impayées, puis, à défaut, sur le statut du dossier ; une erreur
 * de lecture ne bloque plus l'éligibilité (elle est signalée).
 */
export async function eligibiliteMembre(imfId, det) {
  const motifs = [];
  const soldes = await soldesTitres(imfId);
  const parts = (soldes[det.id] || { titres: 0 }).titres;
  if (det.statut !== 'ACTIF') motifs.push('statut_non_actif');
  if (!(parts > 0)) motifs.push('aucune_part_sociale');
  if (!det.client_id) motifs.push('aucun_compte_client');
  let encoursCredit = 0;
  let impayes = 0;
  let controleImpayes = 'non_verifie';
  if (det.client_id) {
    try {
      const { rows } = await q(
        `SELECT COALESCE(SUM(COALESCE(approved_amount_cents, amount_cents)),0)::bigint AS encours
           FROM credit_file
          WHERE imf_id=$1 AND client_id=$2 AND status='decaisse'`, [imfId, det.client_id]);
      encoursCredit = Number((rows[0] && rows[0].encours) || 0) / 100;
      controleImpayes = 'encours_seul';
      // Colonnes réellement présentes en base (schema_v15) : aucun JOIN vers
      // une table d'échéances qui n'existe pas dans le schéma livré.
      const { rows: rt } = await q(
        `SELECT COUNT(*)::int AS n FROM credit_file
          WHERE imf_id=$1 AND client_id=$2
            AND (overdue = true OR (overdue_since IS NOT NULL
                 AND overdue_since < (CURRENT_DATE - INTERVAL '90 days')))`, [imfId, det.client_id]);
      impayes = Number((rt[0] && rt[0].n) || 0);
      controleImpayes = 'impayes';
    } catch (e) {
      // Table d'échéances absente : on retombe sur le statut du dossier.
      try {
        const { rows: rt } = await q(
          `SELECT COUNT(*)::int AS n FROM credit_file
            WHERE imf_id=$1 AND client_id=$2 AND status='impaye'`, [imfId, det.client_id]);
        impayes = Number((rt[0] && rt[0].n) || 0);
        controleImpayes = 'statut_dossier';
      } catch (e2) {
        controleImpayes = 'non_verifie';
        console.warn('[capital] impayés non vérifiés :', short(e2));
      }
    }
  }
  if (impayes > 0) motifs.push('impayes_plus_90_jours');
  return {
    eligible: motifs.length === 0,
    motifs,
    parts_sociales: parts,
    encours_credit: encoursCredit,
    impayes_plus_90j: impayes,
    controle_impayes: controleImpayes
  };
}

/**
 * Émargement / procuration : recalcule le quorum d'une session.
 *   SA    : quorum = % des droits de vote (1 action = 1 voix)
 *   SCOOP : quorum = % des membres inscrits (1 membre = 1 voix)
 * Le quorum requis vient de la session (ou du quorum de l'organe), sinon des
 * paramètres (AGO 1re convocation par défaut).
 */
export async function recalculerQuorum(imfId, sessionId) {
  const { forme, coop } = await formeJuridique(imfId);
  const p = await getParametresCapital(imfId);
  const { rows: s } = await q(
    `SELECT s.id, s.statut, s.quorum_requis, s.type_session, o.quorum_requis AS quorum_organe
       FROM sessions_et_pv s
       LEFT JOIN organes_gouvernance o ON o.id=s.organe_id AND o.imf_id=s.imf_id
      WHERE s.id=$1 AND s.imf_id=$2`, [sessionId, imfId]);
  const session = s[0];
  if (!session) return null;

  const { rows: det } = await q(
    `SELECT d.id, d.categorie, d.type_entite, d.statut, COALESCE(sc.titres,0) AS titres
       FROM detenteurs_capital d
       LEFT JOIN (SELECT detenteur_id,
                         SUM(CASE WHEN type_operation IN ('CESSION','REMBOURSEMENT_SORTIE')
                                  THEN -nombre_titres ELSE nombre_titres END)::int AS titres
                    FROM mouvements_titres WHERE imf_id=$1 GROUP BY detenteur_id) sc
              ON sc.detenteur_id=d.id
      WHERE d.imf_id=$1 AND d.statut='ACTIF'`, [imfId]);
  const { rows: f } = await q(
    `SELECT detenteur_id, mode_participation, nombre_titres_retenus, nombre_voix_attribuees,
            mandataire_id
       FROM feuille_presence_ag WHERE session_id=$1 AND imf_id=$2`, [sessionId, imfId]);

  const voixTotal = det.reduce((a, x) => a + voixAttribuees(x.categorie, x.titres, coop), 0);
  const membresTotal = det.length;

  let voixPresents = 0;
  let voixRepresentees = 0;
  let membresPresents = 0;
  let membresRepresentes = 0;
  let titresPresents = 0;
  let titresRepresentes = 0;
  f.forEach((l) => {
    if (l.mode_participation === 'ABSENT') return;
    const v = Number(l.nombre_voix_attribuees || 0);
    const t = Number(l.nombre_titres_retenus || 0);
    if (l.mode_participation === 'REPRESENTE_PROCURATION') {
      voixRepresentees += v;
      membresRepresentes += 1;
      titresRepresentes += t;
    } else {
      voixPresents += v;
      membresPresents += 1;
      titresPresents += t;
    }
  });

  // Base de calcul : droits de vote en SA, nombre de membres inscrits en SCOOP.
  const base = coop ? membresTotal : voixTotal;
  const exprime = coop ? (membresPresents + membresRepresentes) : (voixPresents + voixRepresentees);
  const pct = base > 0 ? +((exprime / base) * 100).toFixed(2) : null;
  const defaut = session.type_session === 'EXTRAORDINAIRE' ? Number(p.quorum_age_pct)
    : Number(p.quorum_ago_1_pct);
  const duOrgane = Number(session.quorum_organe || 0);
  const deLaSession = Number(session.quorum_requis || 0);
  const requis = deLaSession > 0 ? deLaSession : (duOrgane > 0 ? duOrgane : defaut);
  const atteint = pct == null ? null : pct >= requis;

  // Résultat figé dans ag_quorum (trace) + colonnes historiques de la session.
  try {
    await q(
      `INSERT INTO ag_quorum (imf_id, session_id, est_scoop, base_calcul, voix_total, voix_presentes,
          voix_representees, membres_total, membres_presents, membres_representes, pourcentage,
          quorum_requis_pct, quorum_atteint, calcul_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       ON CONFLICT (session_id) DO UPDATE SET
         voix_total=EXCLUDED.voix_total, voix_presentes=EXCLUDED.voix_presentes,
         voix_representees=EXCLUDED.voix_representees, membres_total=EXCLUDED.membres_total,
         membres_presents=EXCLUDED.membres_presents, membres_representes=EXCLUDED.membres_representes,
         pourcentage=EXCLUDED.pourcentage, quorum_requis_pct=EXCLUDED.quorum_requis_pct,
         quorum_atteint=EXCLUDED.quorum_atteint, calcul_at=now()`,
      [imfId, sessionId, coop, coop ? 'MEMBRES' : 'DROITS_DE_VOTE', voixTotal, voixPresents,
       voixRepresentees, membresTotal, membresPresents, membresRepresentes, pct, requis, atteint]);
  } catch (e) {
    console.warn('[capital] quorum non trace :', short(e));
  }
  await q(
    `UPDATE sessions_et_pv SET nombre_presents=$1, quorum_atteint=$2, updated_at=now()
      WHERE id=$3 AND imf_id=$4 AND statut <> 'SIGNE_VERROUILLE'`,
    [membresPresents + membresRepresentes, atteint, sessionId, imfId]);

  return {
    est_scoop: coop, forme_juridique: forme,
    base_calcul: coop ? 'MEMBRES' : 'DROITS_DE_VOTE',
    voix_total: voixTotal, voix_presents: voixPresents, voix_representees: voixRepresentees,
    membres_total: membresTotal, membres_presents: membresPresents, membres_representes: membresRepresentes,
    titres_presents: titresPresents, titres_representes: titresRepresentes,
    pourcentage: pct, quorum_requis_pct: requis, quorum_atteint: atteint,
    manque: pct == null ? null : +Math.max(0, requis - pct).toFixed(2)
  };
}

/**
 * Procurations portées par un mandataire : autorise ou refuse.
 * En SCOOP, le plafond est celui des statuts (1 ou 2 par défaut).
 * En SA, aucune limite statutaire n'est imposée, seule la cohérence est
 * vérifiée (un sociétaire ne peut pas être son propre mandataire).
 */
export async function controlerProcuration(imfId, sessionId, mandataireId, detenteurId) {
  if (!mandataireId || mandataireId === detenteurId) {
    return { ok: false, error: 'mandataire_invalide' };
  }
  const { coop } = await formeJuridique(imfId);
  if (!coop) return { ok: true, portees: null, plafond: null };
  const p = await getParametresCapital(imfId);
  const { rows } = await q(
    `SELECT COUNT(*)::int AS n FROM feuille_presence_ag
      WHERE session_id=$1 AND imf_id=$2 AND mandataire_id=$3 AND mode_participation='REPRESENTE_PROCURATION'
        AND detenteur_id <> $4`, [sessionId, imfId, mandataireId, detenteurId]);
  const portees = Number((rows[0] && rows[0].n) || 0);
  const plafond = Number(p.plafond_procurations_par_membre || 1);
  if (portees >= plafond) {
    return { ok: false, error: 'plafond_procurations_atteint', portees, plafond };
  }
  return { ok: true, portees, plafond };
}

/**
 * Contrôle du retrait d'un sociétaire (démission, exclusion) : récapitule ce
 * qui bloque AVANT d'enregistrer le mouvement de remboursement.
 */
export async function controlerSortieMembre(imfId, det) {
  const { coop } = await formeJuridique(imfId);
  const p = await getParametresCapital(imfId);
  const motifs = [];
  const soldes = await soldesTitres(imfId);
  const parts = (soldes[det.id] || { titres: 0 }).titres;
  let encoursCredit = 0;
  if (det.client_id) {
    const { rows } = await q(
      `SELECT COALESCE(SUM(COALESCE(approved_amount_cents, amount_cents)),0)::bigint AS s
         FROM credit_file WHERE imf_id=$1 AND client_id=$2 AND status='decaisse'`,
      [imfId, det.client_id]);
    encoursCredit = Number((rows[0] && rows[0].s) || 0) / 100;
  }
  if (coop && encoursCredit > 0 && p.bloquer_retrait_credit_en_cours) {
    motifs.push('credit_en_cours');
  }
  const syn = await syntheseCapital(imfId);
  const vn = p.valeur_nominale_part_cents != null ? Number(p.valeur_nominale_part_cents) / 100 : 0;
  const valeurRemboursement = vn * parts;
  const capitalApres = syn.capital_libere - valeurRemboursement;
  if (coop && p.bloquer_retrait_sous_capital_min && syn.capital_minimum_reglementaire != null
      && capitalApres < syn.capital_minimum_reglementaire) {
    motifs.push('capital_sous_minimum');
  }
  return {
    blocage: motifs.length > 0, motifs,
    parts_a_rembourser: parts,
    valeur_remboursement: valeurRemboursement,
    encours_credit: encoursCredit,
    capital_apres_retrait: capitalApres,
    capital_minimum_reglementaire: syn.capital_minimum_reglementaire
  };
}
