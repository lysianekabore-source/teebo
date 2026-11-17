// ===========================================================================
// teebo — VAGUE 38 : ROUTES DU MODULE CRÉDIT (BCEAO)
// ---------------------------------------------------------------------------
// Préfixe : /api/v1/credit/…
//
//   Référentiels       GET  /credit/referentiels
//   Produits           GET/POST /credit/produits, PATCH /credit/produits/:id
//   Simulateur         POST /credit/simulateur        (TEG + échéancier)
//   Dossiers           GET/POST /credit/dossiers, GET /credit/dossiers/:id
//                      POST /credit/dossiers/:id/soumettre|valider|decaisser|rembourser
//                      POST /credit/dossiers/:id/garanties, POST …/garanties/:gid/bloquer
//                      GET  /credit/dossiers/:id/echeancier|remboursements
//   Comité & plafonds  GET  /credit/plafonds, PUT /credit/plafonds,
//                      GET  /credit/comite/file
//   Recouvrement       GET  /credit/impayes, POST /credit/dossiers/:id/actions,
//                      GET  /credit/dossiers/:id/actions, POST /credit/declasser
//   Tâche quotidienne  POST /credit/taches/quotidien
//   Hors-ligne         POST /credit/sync
//   Pilotage           GET  /credit/par, GET /credit/tableau-bord
//
// Règles invariantes :
//   • imf_id vient TOUJOURS du jeton (req.dbImfId), jamais du corps de requête ;
//   • montants en entiers de centimes FCFA ;
//   • 4 yeux : le validateur n'est jamais l'agent du dossier ;
//   • aucune écriture comptable sans opération : décaissement et remboursement
//     créent une ligne dans operation (statut valide) pour que la caisse et le
//     relevé BCEAO restent justes ;
//   • synchronisation idempotente par uuid_local (le terrain peut renvoyer 10 fois).
// ===========================================================================
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireRole } from '../auth.js';
import { habilit } from '../rbac_strict.js';
import { tenantTransaction } from '../tenant.js';
import { auditEvent } from '../audit.js';
import scoringRouter, { evaluerEtEnregistrer } from './scoring.js';
import {
  METHODES, PERIODICITES, CLASSES_CREANCE, TYPES_GARANTIE, CANAUX_REMBOURSEMENT,
  STATUTS_DOSSIER, CreditError,
  montantEnCentimes, fcfa, estUuid,
  validerProduitCredit, simulerDossierCredit, construireEcheancier, calculerTeg,
  imputerRemboursement, repartirSurEcheances, evaluerImpaye, calculerPenalite,
  classeBceao, tauxProvisionBp, calculerProvision, calculerPar,
  transitionAutorisee, verifierQuatreYeux,
  validerRemboursementHorsLigne, validerActionHorsLigne,
  referenceDossier, referenceRecuRemboursement, joursEntre
} from '../credit_engine.js';

const r = Router();

/* ------------------------------------------------------------------------
 *  PROFILS AUTORISÉS (rôles) — l'habilitation fine est vérifiée en plus.
 * ---------------------------------------------------------------------- */
const AGENT = ['staff', 'agency', 'service', 'department', 'caissier', 'admin_imf', 'direction'];
const CAISSIER = ['caissier', 'admin_imf', 'direction'];
const DIRECTION = ['direction', 'admin_imf', 'department', 'service'];
const ADMIN = ['admin_imf', 'direction'];

/** Réponse d'erreur homogène (même forme que la vague 37). */
function echec(res, e) {
  if (e instanceof CreditError) {
    return res.status(e.status || 422).json({
      error: e.code, message: e.message, detail: e.detail || null
    });
  }
  throw e;
}

function estDoublon(e) {
  return e && (e.code === '23505' || /duplicate key|uq_/i.test(String(e.message || '')));
}

function uuidOuNull(v) {
  return estUuid(v) ? v : null;
}

/** Numérique entier positif à partir d'un corps JSON (refus des flottants). */
function entierOuNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/* ========================================================================
 *  0. RÉFÉRENTIELS
 * ===================================================================== */
r.get('/credit/referentiels', requireRole(...AGENT), async (_req, res) => {
  res.json({
    methodes: METHODES.map((m) => ({
      code: m,
      libelle: {
        DEGRESSIF: 'Dégressif (annuités constantes)',
        LINEAIRE: 'Linéaire (capital constant)',
        IN_FINE: 'In fine (capital en fin de prêt)'
      }[m]
    })),
    periodicites: Object.keys(PERIODICITES).map((p) => ({
      code: p, libelle: PERIODICITES[p].libelle, jours: PERIODICITES[p].jours,
      par_an: PERIODICITES[p].parAn
    })),
    types_garantie: TYPES_GARANTIE.map((t) => ({
      code: t,
      libelle: {
        EPARGNE_BLOQUEE: 'Épargne bloquée', CAUTION_SOLIDAIRE: 'Caution solidaire',
        NANTISSEMENT: 'Nantissement', HYPOTHEQUE: 'Hypothèque', AVAL: 'Aval',
        GAGE_VEHICULE: 'Gage véhicule', STOCK: 'Stock', AUTRE: 'Autre'
      }[t],
      compte_requis: t === 'EPARGNE_BLOQUEE'
    })),
    canaux_remboursement: CANAUX_REMBOURSEMENT.map((c) => ({
      code: c,
      libelle: {
        TERRAIN_CASH: 'Espèces (collecte terrain)', GUICHET: 'Guichet / caisse',
        ORANGE_MONEY: 'Orange Money', MOOV_MONEY: 'Moov Money', WAVE: 'Wave',
        INTEROP_BCEAO: 'Interopérabilité BCEAO', VIREMENT_EPARGNE: 'Virement épargne'
      }[c],
      reference_obligatoire: ['ORANGE_MONEY', 'MOOV_MONEY', 'WAVE', 'INTEROP_BCEAO'].includes(c)
    })),
    statuts_dossier: STATUTS_DOSSIER,
    classes_creance: CLASSES_CREANCE,
    decisions_comite: ['APPROUVE', 'REJETE', 'COMPLEMENT', 'AJOURNE'],
    types_action: ['VISITE', 'APPEL', 'SMS', 'WHATSAPP', 'MISE_EN_DEMEURE',
      'PROMESSE', 'CONTENTIEUX', 'SAISIE'],
    regles: {
      imputation: 'pénalités → intérêts → capital',
      quatre_yeux: 'le validateur ne peut pas être l’agent du dossier',
      classes: { SAIN: '< 30 jours', IMMOBILISE: '30 à 89 jours',
        DOUTEUX: '90 à 179 jours', LITIGIEUX: '180 jours et plus' },
      provision_sain: 'un crédit sain n’est pas provisionné'
    }
  });
});

/* ========================================================================
 *  1. PRODUITS DE CRÉDIT
 * ===================================================================== */
const COLONNES_PRODUIT = `code, libelle, description, methode, periodicite,
  duree_min_mois, duree_max_mois, montant_min_cents, montant_max_cents,
  taux_nominal_bp, frais_dossier_bp, frais_dossier_min_cents, assurance_bp,
  epargne_obligatoire_bp, differe_mois, differe_type, penalite_retard_bp_jour,
  provision_sain_bp, provision_immobilise_bp, provision_douteux_bp,
  provision_litigieux_bp, actif`;

r.get('/credit/produits', requireRole(...AGENT), habilit('credit.par.read', 'credit.products.manage',
  'credit.dossier.monter'), async (req, res, next) => {
  try {
    const liste = await tenantTransaction(req, async (c) => (await c.query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM dossiers_credit d
                     WHERE d.produit_id = p.id
                       AND d.statut IN ('DECAISSE')) AS nb_dossiers_actifs
         FROM produits_credit p
        WHERE p.imf_id = $1
        ORDER BY p.actif DESC, p.libelle`, [req.dbImfId])).rows);
    res.json({ produits: liste, total: liste.length });
  } catch (e) { next(e); }
});

r.post('/credit/produits', requireRole(...ADMIN, 'department', 'service'),
  habilit('credit.products.manage'), async (req, res, next) => {
  try {
    const p = validerProduitCredit(req.body || {});

    // Simulation témoin : garantit qu'un produit incohérent (retenues qui
    // absorbent tout le montant) ne peut pas être enregistré.
    try {
      simulerDossierCredit({
        montant_cents: Math.max(p.montant_min_cents, 100000),
        duree_mois: p.duree_min_mois, produit: p
      });
    } catch (e) {
      if (e instanceof CreditError) throw e;
      throw e;
    }

    const out = await tenantTransaction(req, async (c) => (await c.query(
      `INSERT INTO produits_credit (imf_id, tenant_id, ${COLONNES_PRODUIT}, created_by)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [req.dbImfId, p.code, p.libelle, p.description, p.methode, p.periodicite,
        p.duree_min_mois, p.duree_max_mois, p.montant_min_cents, p.montant_max_cents,
        p.taux_nominal_bp, p.frais_dossier_bp, p.frais_dossier_min_cents, p.assurance_bp,
        p.epargne_obligatoire_bp, p.differe_mois, p.differe_type, p.penalite_retard_bp_jour,
        p.provision_sain_bp, p.provision_immobilise_bp, p.provision_douteux_bp,
        p.provision_litigieux_bp, p.actif, req.user.id])).rows[0]);

    await auditEvent(req.user, { action: 'credit.produit.cree', entity: 'produits_credit',
      entityId: out.id, payload: { code: out.code, taux_nominal_bp: out.taux_nominal_bp } });
    res.status(201).json({ produit: out });
  } catch (e) {
    try { if (estDoublon(e)) {
      return res.status(409).json({ error: 'code_produit_existe',
        message: 'Un produit de crédit porte déjà ce code dans votre institution.' });
    } echec(res, e); } catch (err) { next(err); }
  }
});

/** Modification : le produit change pour les NOUVEAUX dossiers seulement. */
r.patch('/credit/produits/:id', requireRole(...ADMIN, 'department', 'service'),
  habilit('credit.products.manage'), async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide', message: 'Identifiant de produit illisible.' });
    const actuel = await tenantTransaction(req, async (c) => (await c.query(
      'SELECT * FROM produits_credit WHERE id=$1 AND imf_id=$2', [id, req.dbImfId])).rows[0]);
    if (!actuel) return res.status(404).json({ error: 'produit_introuvable',
      message: 'Ce produit de crédit n’existe pas dans votre institution.' });

    const fusion = { ...actuel, ...(req.body || {}) };
    const p = validerProduitCredit(fusion);
    const out = await tenantTransaction(req, async (c) => (await c.query(
      `UPDATE produits_credit SET
         code=$3, libelle=$4, description=$5, methode=$6, periodicite=$7,
         duree_min_mois=$8, duree_max_mois=$9, montant_min_cents=$10, montant_max_cents=$11,
         taux_nominal_bp=$12, frais_dossier_bp=$13, frais_dossier_min_cents=$14,
         assurance_bp=$15, epargne_obligatoire_bp=$16, differe_mois=$17, differe_type=$18,
         penalite_retard_bp_jour=$19, provision_sain_bp=$20, provision_immobilise_bp=$21,
         provision_douteux_bp=$22, provision_litigieux_bp=$23, actif=$24, updated_at=now()
       WHERE id=$1 AND imf_id=$2 RETURNING *`,
      [id, req.dbImfId, p.code, p.libelle, p.description, p.methode, p.periodicite,
        p.duree_min_mois, p.duree_max_mois, p.montant_min_cents, p.montant_max_cents,
        p.taux_nominal_bp, p.frais_dossier_bp, p.frais_dossier_min_cents, p.assurance_bp,
        p.epargne_obligatoire_bp, p.differe_mois, p.differe_type, p.penalite_retard_bp_jour,
        p.provision_sain_bp, p.provision_immobilise_bp, p.provision_douteux_bp,
        p.provision_litigieux_bp, p.actif])).rows[0]);

    await auditEvent(req.user, { action: 'credit.produit.modifie', entity: 'produits_credit',
      entityId: id, payload: { champs: Object.keys(req.body || {}) } });
    res.json({ produit: out, avertissement: 'Les dossiers déjà montés conservent leurs paramètres d’origine.' });
  } catch (e) {
    try { if (estDoublon(e)) {
      return res.status(409).json({ error: 'code_produit_existe',
        message: 'Un autre produit porte déjà ce code.' });
    } echec(res, e); } catch (err) { next(err); }
  }
});

/* ========================================================================
 *  2. SIMULATEUR (TEG affiché au client avant tout engagement)
 * ===================================================================== */
r.post('/credit/simulateur', requireRole(...AGENT), habilit('credit.dossier.monter',
  'credit.par.read', 'credit.dossier.approuver'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const montant = entierOuNull(b.montant_cents != null ? b.montant_cents
      : montantEnCentimes(b.montant, 'montant'));
    if (!montant || montant <= 0) {
      return res.status(400).json({ error: 'montant_invalide',
        message: 'Indiquez le montant du crédit en FCFA entiers.' });
    }
    const duree = entierOuNull(b.duree_mois);
    if (!duree || duree < 1 || duree > 120) {
      return res.status(400).json({ error: 'duree_invalide',
        message: 'La durée doit être comprise entre 1 et 120 mois.' });
    }

    // Produit : soit son identifiant, soit des paramètres libres (simulation
    // « à blanc » pour un prospect qui n'a pas encore de dossier).
    let produit = { methode: String(b.methode || 'DEGRESSIF').toUpperCase(),
      periodicite: String(b.periodicite || 'MENSUELLE').toUpperCase(),
      taux_nominal_bp: entierOuNull(b.taux_nominal_bp) != null ? entierOuNull(b.taux_nominal_bp) : 1200,
      frais_dossier_bp: 0, frais_dossier_min_cents: 0, assurance_bp: 0,
      epargne_obligatoire_bp: 0, differe_mois: 0, differe_type: 'AUCUN' };
    if (b.produit_id) {
      if (!estUuid(b.produit_id)) return res.status(400).json({ error: 'produit_invalide',
        message: 'Identifiant de produit illisible.' });
      produit = await tenantTransaction(req, async (c) => (await c.query(
        'SELECT * FROM produits_credit WHERE id=$1 AND imf_id=$2 AND actif',
        [b.produit_id, req.dbImfId])).rows[0]) || {};
      if (!produit.id) return res.status(404).json({ error: 'produit_introuvable',
        message: 'Ce produit de crédit n’existe pas ou n’est plus actif.' });
    }
    if (b.taux_nominal_bp != null) {
      const t = entierOuNull(b.taux_nominal_bp);
      if (t == null || t < 0 || t > 60000) return res.status(400).json({ error: 'taux_invalide',
        message: 'Le taux nominal doit être exprimé en points de base (0 à 60000).' });
      produit.taux_nominal_bp = t;
    } else if (!b.produit_id) {
      produit.taux_nominal_bp = 1200;   // 12 %/an par défaut en simulation libre
    }
    if (b.methode) produit.methode = String(b.methode).toUpperCase();
    if (b.periodicite) produit.periodicite = String(b.periodicite).toUpperCase();
    // Paramètres libres d'une simulation : ils priment sur ceux du produit
    // (poste de travail « simulateur » ouvert à un prospect, hors produit).
    if (b.frais_dossier_bp != null) produit.frais_dossier_bp = entierOuNull(b.frais_dossier_bp) || 0;
    if (b.frais_dossier_cents != null) {
      // Frais exprimés en FCFA : convertis en points de base sur le montant.
      const f = entierOuNull(b.frais_dossier_cents) || 0;
      if (f < 0) return res.status(400).json({ error: 'frais_invalides',
        message: 'Les frais de dossier ne peuvent pas être négatifs.' });
      produit.frais_dossier_bp = montant > 0 ? Math.round((f * 10000) / montant) : 0;
      produit.frais_dossier_min_cents = 0;
    }
    if (b.assurance_bp != null) produit.assurance_bp = entierOuNull(b.assurance_bp) || 0;
    if (b.epargne_garantie_bp != null) produit.epargne_obligatoire_bp = entierOuNull(b.epargne_garantie_bp) || 0;
    else if (b.epargne_obligatoire_bp != null) produit.epargne_obligatoire_bp = entierOuNull(b.epargne_obligatoire_bp) || 0;
    if (b.differe_mois != null) produit.differe_mois = entierOuNull(b.differe_mois) || 0;
    if (b.differe_type) produit.differe_type = String(b.differe_type).toUpperCase();
    if (b.methode) {
      const mMet = String(b.methode).toUpperCase();
      if (!METHODES.includes(mMet)) return res.status(400).json({ error: 'methode_inconnue',
        message: 'Méthode d’amortissement inconnue : choisissez ' + METHODES.join(', ') + '.' });
    }
    if (b.periodicite) {
      const pPer = String(b.periodicite).toUpperCase();
      if (!PERIODICITES[pPer]) return res.status(400).json({ error: 'periodicite_inconnue',
        message: 'Périodicité inconnue : choisissez ' + Object.keys(PERIODICITES).join(', ') + '.' });
    }
    if (b.date_debut) produit._date = String(b.date_debut).slice(0, 10);
    let produitId = null;
    // Un produit identifié impose ses plafonds ET sa méthode ; une simulation
    // libre (prospect) ne les impose pas.
    if (b.produit_id) {
      produitId = produit.id;
      produit._modifiable = true;
    } else {
      delete produit.montant_min_cents;
      delete produit.montant_max_cents;
      delete produit.duree_min_mois;
      delete produit.duree_max_mois;
    }

    const sim = simulerDossierCredit({
      montant_cents: montant, duree_mois: duree, produit,
      date_debut: b.date_debut ? String(b.date_debut).slice(0, 10) : undefined
    });

    res.json({
      simulation: sim,
      produit_id: produitId,
      resume_client: {
        montant_credit: fcfa(sim.montant_cents),
        net_verse: fcfa(sim.net_verse_cents),
        echeance: fcfa(sim.lignes.length ? sim.lignes[0].montant_echeance_cents : 0),
        nombre_echeances: sim.nombre_echeances,
        total_a_payer: fcfa(sim.total_a_payer_cents),
        cout_credit: fcfa(sim.cout_credit_cents),
        // Arrondi à l'entier : un TEG s'annonce « 24 % », pas « 24,50 % ».
        teg_pourcent: Math.round(sim.taux_teg_bp / 100).toLocaleString('fr-FR') + ' %'
      },
      avertissement: 'Le TEG intégré est calculé selon la méthode BCEAO (intérêts, frais de dossier et assurance). Il est arrondi en points de base.'
    });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/* ========================================================================
 *  3. DOSSIERS — montage
 * ===================================================================== */
async function chargerDossier(c, id, imfId, verrou) {
  const d = (await c.query(
    `SELECT * FROM dossiers_credit WHERE id=$1 AND imf_id=$2` + (verrou ? ' FOR UPDATE' : ''),
    [id, imfId])).rows[0];
  return d || null;
}

function dossierPublic(d) {
  if (!d) return null;
  return {
    ...d,
    encours_cents: Number(d.solde_capital_cents || 0),
    libelle_statut: {
      BROUILLON: 'Brouillon', EN_ANALYSE: 'En analyse', EN_COMITE: 'En comité',
      APPROUVE: 'Approuvé (à décaisser)', REJETE: 'Rejeté', DECAISSE: 'Décaissé',
      CLOTURE_SOLDE: 'Clôturé (soldé)', ANNULE: 'Annulé'
    }[d.statut] || d.statut
  };
}

r.get('/credit/dossiers', requireRole(...AGENT), habilit('credit.par.read', 'credit.dossier.monter',
  'credit.dossier.approuver', 'credit.rembourser', 'credit.recouvrement'), async (req, res, next) => {
  try {
    const { statut, client_id, produit_id, recherche, du, au } = req.query || {};
    const cond = ['d.imf_id = $1'];
    const p = [req.dbImfId];
    if (statut) {
      const liste = String(statut).split(',').map((s) => s.trim().toUpperCase())
        .filter((s) => STATUTS_DOSSIER.includes(s));
      if (!liste.length) return res.status(400).json({ error: 'statut_inconnu',
        message: 'Statut de dossier inconnu.' });
      p.push(liste); cond.push('d.statut = ANY($' + p.length + ')');
    }
    if (client_id && estUuid(client_id)) { p.push(client_id); cond.push('d.client_id = $' + p.length); }
    if (produit_id && estUuid(produit_id)) { p.push(produit_id); cond.push('d.produit_id = $' + p.length); }
    if (recherche) {
      p.push('%' + String(recherche).toLowerCase() + '%');
      cond.push('(lower(d.reference) LIKE $' + p.length + ' OR lower(cl.full_name) LIKE $' + p.length
        + ' OR lower(cl.code_client) LIKE $' + p.length + ')');
    }
    if (du) { p.push(du); cond.push('d.created_at >= $' + p.length + '::date'); }
    if (au) { p.push(au); cond.push('d.created_at < ($' + p.length + '::date + 1)'); }
    const lim = Math.min(300, Math.max(1, Number(req.query.limite) || 60));
    p.push(lim);

    const rows = await tenantTransaction(req, async (c) => (await c.query(
      `SELECT d.id, d.reference, d.statut, d.montant_demande_cents, d.montant_accorde_cents,
              d.duree_mois, d.periodicite, d.taux_nominal_bp, d.taux_teg_bp,
              d.solde_capital_cents, d.jours_retard, d.classe_creance,
              d.date_decaissement, d.date_premiere_echeance, d.date_derniere_echeance,
              d.created_at, d.objet,
              cl.code_client, cl.full_name, pc.libelle AS produit
         FROM dossiers_credit d
         JOIN client cl ON cl.id = d.client_id
         JOIN produits_credit pc ON pc.id = d.produit_id
        WHERE ${cond.join(' AND ')}
        ORDER BY d.created_at DESC LIMIT $${p.length}`, p)).rows);
    res.json({ dossiers: rows, total: rows.length });
  } catch (e) { next(e); }
});

/** Montage d'un dossier : statut BROUILLON, paramètres figés du produit. */
r.post('/credit/dossiers', requireRole(...AGENT), habilit('credit.dossier.monter'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!estUuid(b.client_id)) return res.status(400).json({ error: 'client_invalide',
      message: 'Choisissez le client bénéficiaire du crédit.' });
    if (!estUuid(b.produit_id)) return res.status(400).json({ error: 'produit_invalide',
      message: 'Choisissez le produit de crédit.' });
    const montant = entierOuNull(b.montant_cents != null ? b.montant_cents
      : montantEnCentimes(b.montant, 'montant'));
    if (!montant || montant <= 0) return res.status(400).json({ error: 'montant_invalide',
      message: 'Indiquez le montant demandé en FCFA entiers.' });
    const duree = entierOuNull(b.duree_mois);
    if (!duree || duree < 1) return res.status(400).json({ error: 'duree_invalide',
      message: 'Indiquez la durée en mois.' });

    const out = await tenantTransaction(req, async (c) => {
      const client = (await c.query(
        'SELECT id, full_name FROM client WHERE id=$1 AND imf_id=$2',
        [b.client_id, req.dbImfId])).rows[0];
      if (!client) throw new CreditError('client_introuvable',
        'Ce client n’existe pas dans votre institution.', null, 404);
      const produit = (await c.query(
        'SELECT * FROM produits_credit WHERE id=$1 AND imf_id=$2 AND actif',
        [b.produit_id, req.dbImfId])).rows[0];
      if (!produit) throw new CreditError('produit_introuvable',
        'Ce produit de crédit n’existe pas ou n’est plus actif.', null, 404);

      const sim = simulerDossierCredit({
        montant_cents: montant, duree_mois: duree, produit,
        methode: b.methode, periodicite: b.periodicite,
        taux_nominal_bp: Number.isInteger(entierOuNull(b.taux_nominal_bp)) ? entierOuNull(b.taux_nominal_bp) : undefined,
        differe_mois: Number.isInteger(entierOuNull(b.differe_mois)) ? entierOuNull(b.differe_mois) : undefined,
        differe_type: b.differe_type
      });

      // Référence séquentielle par IMF et par année.
      const annee = new Date().getFullYear();
      const n = (await c.query(
        `SELECT COUNT(*)::int + 1 AS n FROM dossiers_credit
          WHERE imf_id=$1 AND extract(year FROM created_at)=$2`, [req.dbImfId, annee])).rows[0].n;
      const codeImf = (await c.query('SELECT code_imf FROM imf WHERE id=$1', [req.dbImfId])).rows[0];
      const reference = referenceDossier({ codeImf: codeImf && codeImf.code_imf, annee, numero: n });

      const groupe = estUuid(b.groupe_id) ? b.groupe_id : null;
      if (groupe) {
        const g = (await c.query('SELECT 1 FROM groupes_solidaires WHERE id=$1 AND imf_id=$2 AND statut=$3',
          [groupe, req.dbImfId, 'ACTIF'])).rows[0];
        if (!g) throw new CreditError('groupe_introuvable',
          'Ce groupe solidaire n’existe pas ou n’est plus actif.', null, 404);
      }

      return (await c.query(
        `INSERT INTO dossiers_credit
           (imf_id, tenant_id, reference, produit_id, client_id, groupe_id,
            montant_demande_cents, methode, periodicite, duree_mois,
            taux_nominal_bp, taux_teg_bp, frais_dossier_cents, assurance_cents,
            epargne_garantie_cents, differe_mois, differe_type, objet, activite,
            statut, agent_credit_id, total_interets_cents, solde_capital_cents,
            uuid_local, created_by)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 'BROUILLON',$19,$20,$21,$22,$23)
         RETURNING *`,
        [req.dbImfId, reference, produit.id, client.id, groupe,
          montant, sim.methode, sim.periodicite, duree,
          sim.taux_nominal_bp, sim.taux_teg_bp, sim.frais_dossier_cents,
          sim.assurance_cents, sim.epargne_garantie_cents,
          // différé réellement retenu par le moteur (jamais 0 en dur)
          Number(sim.differe_mois || 0),
          String(produit.differe_type || 'AUCUN'),
          b.objet ? String(b.objet).slice(0, 500) : null,
          b.activite ? String(b.activite).slice(0, 200) : null,
          req.user.id, sim.total_interets_cents,
          // À la naissance du dossier, rien n'a encore été versé : le solde
          // du capital est donc nul tant que le décaissement n'a pas eu lieu.
          0,
          uuidOuNull(b.uuid_local)])).rows[0];
    });

    await auditEvent(req.user, { action: 'credit.dossier.cree', entity: 'dossiers_credit',
      entityId: out.id, payload: { reference: out.reference, montant_cents: out.montant_demande_cents } });

    // Échéancier prévisionnel renvoyé pour l'écran (il n'est enregistré qu'au
    // décaissement : un brouillon peut encore changer).
    const previsionnel = construireEcheancier({
      montant_cents: Number(out.montant_demande_cents),
      taux_nominal_bp: out.taux_nominal_bp, duree_mois: out.duree_mois,
      periodicite: out.periodicite, methode: out.methode,
      differe_mois: out.differe_mois, differe_type: out.differe_type,
      assurance_cents: Number(out.assurance_cents)
    });
    res.status(201).json({ dossier: dossierPublic(out), apercu_echeancier: previsionnel });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

r.get('/credit/dossiers/:id', requireRole(...AGENT), habilit('credit.par.read', 'credit.dossier.monter',
  'credit.dossier.approuver', 'credit.rembourser', 'credit.recouvrement', 'credit.decaisser'),
  async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide', message: 'Identifiant de dossier illisible.' });
    const out = await tenantTransaction(req, async (c) => {
      const d = await chargerDossier(c, id, req.dbImfId, false);
      if (!d) return null;
      const client = (await c.query(
        `SELECT id, code_client, full_name, phone FROM client WHERE id=$1`, [d.client_id])).rows[0];
      const produit = (await c.query(
        `SELECT id, code, libelle, methode, periodicite, penalite_retard_bp_jour,
                provision_sain_bp, provision_immobilise_bp, provision_douteux_bp,
                provision_litigieux_bp
           FROM produits_credit WHERE id=$1`, [d.produit_id])).rows[0];
      const garanties = (await c.query(
        `SELECT g.*, a.balance_cents, a.solde_bloque_cents, a.product_code
           FROM garanties_credit g LEFT JOIN account a ON a.id = g.account_id
          WHERE g.dossier_id=$1 ORDER BY g.created_at`, [id])).rows;
      const validations = (await c.query(
        `SELECT v.id, v.niveau, v.decision, v.montant_valide_cents, v.plafond_cents,
                v.commentaire, v.created_at, u.full_name AS validateur
           FROM validations_credit v LEFT JOIN app_user u ON u.id = v.validateur_id
          WHERE v.dossier_id=$1 ORDER BY v.niveau, v.created_at`, [id])).rows;
      const decaissement = (await c.query(
        'SELECT * FROM decaissements WHERE dossier_id=$1', [id])).rows[0] || null;
      const echeancier = (await c.query(
        `SELECT * FROM echeanciers_credit WHERE dossier_id=$1
          ORDER BY version DESC, numero`, [id])).rows;
      const remboursements = (await c.query(
        `SELECT id, montant_cents, penalite_cents, interet_cents, capital_cents,
                trop_percu_cents, canal, reference_recu, statut_sync, created_at
           FROM remboursements_credit WHERE dossier_id=$1
          ORDER BY created_at DESC LIMIT 60`, [id])).rows;
      const actions = (await c.query(
        `SELECT a.*, u.full_name AS agent FROM actions_recouvrement a
           LEFT JOIN app_user u ON u.id = a.agent_id
          WHERE a.dossier_id=$1 ORDER BY a.created_at DESC LIMIT 40`, [id])).rows;
      // Dernier score + historique court (lecture seule : on n'écrit jamais dans un GET).
      let score = null;
      let historiqueScore = [];
      try {
        const evs = (await c.query(
          `SELECT e.id, e.score_global, e.classe_risque, e.plafond_montant_suggere_cents,
                  e.montant_demande_cents, e.declencheur, e.calcule_le,
                  e.details_indicateurs_json, u.full_name AS calcule_par_nom
             FROM evaluations_scoring_credit e
             LEFT JOIN app_user u ON u.id = e.calcule_par
            WHERE e.imf_id=$1 AND e.dossier_credit_id=$2
            ORDER BY e.calcule_le DESC LIMIT 12`, [req.dbImfId, id])).rows;
        if (evs.length) {
          const ev = evs[0];
          const det = ev.details_indicateurs_json || {};
          score = { ...ev, score_global: Number(ev.score_global),
            plafond_montant_suggere_cents: Number(ev.plafond_montant_suggere_cents),
            montant_demande_cents: Number(ev.montant_demande_cents),
            libelle_classe: det.classe_risque || ev.classe_risque };
          historiqueScore = evs.map((x) => ({ id: x.id, score_global: Number(x.score_global),
            classe_risque: x.classe_risque, plafond_montant_suggere_cents: Number(x.plafond_montant_suggere_cents),
            declencheur: x.declencheur, calcule_le: x.calcule_le, calcule_par_nom: x.calcule_par_nom }));
        }
      } catch (eScore) { score = null; historiqueScore = []; }
      return { dossier: d, client, produit, garanties, validations,
        decaissement, echeancier, remboursements, actions, score,
        historique_score: historiqueScore, avis_bic_uemoa: d.avis_bic_uemoa || null };
    });
    if (!out) return res.status(404).json({ error: 'dossier_introuvable',
      message: 'Ce dossier de crédit n’existe pas dans votre institution.' });

    // Prochaines échéances impayées (utile au guichet et au recouvrement).
    const aujourd = new Date().toISOString().slice(0, 10);
    const du = out.echeancier.filter((e) => Number(e.capital_paye_cents) < Number(e.capital_cents)
      || Number(e.interet_paye_cents) < Number(e.interet_cents));
    const prochaine = du.find((e) => String(e.date_echeance).slice(0, 10) >= aujourd) || du[0] || null;
    const retard = du.filter((e) => String(e.date_echeance).slice(0, 10) < aujourd);
    const anal = evaluerImpaye({
      aujourdhui: aujourd,
      echeances: out.echeancier.map((e) => ({
        ...e, montant_echeance_cents: Number(e.montant_echeance_cents || 0),
        capital_cents: Number(e.capital_cents), interet_cents: Number(e.interet_cents),
        capital_paye_cents: Number(e.capital_paye_cents),
        interet_paye_cents: Number(e.interet_paye_cents),
        penalite_cents: Number(e.penalite_cents),
        penalite_payee_cents: Number(e.penalite_payee_cents)
      })),
      produit: out.produit, classe_actuelle: out.dossier.classe_creance
    });

    res.json({
      ...out,
      dossier: dossierPublic(out.dossier),
      prochaine_echeance: prochaine,
      nb_echeances_en_retard: retard.length,
      situation: {
        jours_retard: anal.jours_retard,
        impaye_cents: anal.montant_impaye_cents,
        penalites_dues_cents: anal.penalites_dues_cents,
        classe: anal.classe_apres,
        provision_cents: anal.provision_cents
      }
    });
  } catch (e) { next(e); }
});

/** Soumission au comité : BROUILLON/REJETE → EN_ANALYSE → EN_COMITE. */
r.post('/credit/dossiers/:id/soumettre', requireRole(...AGENT), habilit('credit.dossier.soumettre'),
  async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide', message: 'Identifiant de dossier illisible.' });
    const out = await tenantTransaction(req, async (c) => {
      const d = await chargerDossier(c, id, req.dbImfId, true);
      if (!d) throw new CreditError('dossier_introuvable',
        'Ce dossier n’existe pas dans votre institution.', null, 404);

      // Une garantie en épargne bloquée doit être constituée avant le comité.
      const g = (await c.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE statut='BLOQUEE')::int AS bloquees
           FROM garanties_credit WHERE dossier_id=$1`, [id])).rows[0];
      if (Number(g.total) > 0 && Number(g.bloquees) === 0) {
        throw new CreditError('garanties_non_constituees',
          'Les garanties sont saisies mais pas encore constituées : bloquez l’épargne ou validez la caution avant de soumettre le dossier.',
          null, 409);
      }

      let de = d.statut;
      if (de === 'BROUILLON' || de === 'REJETE') {
        transitionAutorisee(de, 'EN_ANALYSE');
        await c.query(
          `UPDATE dossiers_credit SET statut='EN_ANALYSE', motif_rejet=NULL, updated_at=now()
            WHERE id=$1`, [id]);
        de = 'EN_ANALYSE';
      }
      transitionAutorisee(de, 'EN_COMITE');
      const maj = (await c.query(
        `UPDATE dossiers_credit SET statut='EN_COMITE', date_soumission=COALESCE(date_soumission, now()),
                updated_at=now() WHERE id=$1 RETURNING *`, [id])).rows[0];
      // Scoring alternatif : calculé AUTOMATIQUEMENT au passage en analyse.
      // Une panne du scoring ne doit jamais bloquer la soumission : on note
      // l'incident, le dossier continue, et l'analyste peut relancer le calcul.
      let scoring = null;
      try {
        scoring = await evaluerEtEnregistrer(req, c, maj, 'EN_ANALYSE');
      } catch (eScoring) {
        scoring = { erreur: String(eScoring && eScoring.message || eScoring).slice(0, 300) };
      }
      return { dossier: maj, scoring };
    });
    await auditEvent(req.user, { action: 'credit.dossier.soumis', entity: 'dossiers_credit',
      entityId: id, payload: { reference: out.dossier.reference,
        score: out.scoring && out.scoring.score ? out.scoring.score.score_global : null } });
    res.json({ dossier: dossierPublic(out.dossier), score: out.scoring && out.scoring.score || null,
      message: 'Dossier transmis au comité de crédit.'
        + (out.scoring && out.scoring.score
          ? ' Score : ' + out.scoring.score.score_global.toFixed(1).replace('.', ',') + '/100 (classe '
            + out.scoring.score.classe_risque + ').'
          : '') });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/* ========================================================================
 *  4. GARANTIES
 * ===================================================================== */
r.post('/credit/dossiers/:id/garanties', requireRole(...AGENT), habilit('credit.garantie.gerer'),
  async (req, res, next) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide', message: 'Identifiant de dossier illisible.' });
    const type = String(b.type_garantie || '').toUpperCase();
    if (!TYPES_GARANTIE.includes(type)) return res.status(400).json({ error: 'type_garantie_inconnu',
      message: 'Type de garantie inconnu.' });
    const montant = entierOuNull(b.montant_cents != null ? b.montant_cents
      : montantEnCentimes(b.montant, 'montant'));
    if (montant == null || montant < 0) return res.status(400).json({ error: 'montant_invalide',
      message: 'Indiquez la valeur de la garantie en FCFA entiers.' });
    if (type === 'EPARGNE_BLOQUEE' && !estUuid(b.account_id)) {
      return res.status(400).json({ error: 'compte_requis',
        message: 'Pour une épargne bloquée, choisissez le compte d’épargne qui sert de garantie.' });
    }

    const g = await tenantTransaction(req, async (c) => {
      const d = await chargerDossier(c, id, req.dbImfId, false);
      if (!d) throw new CreditError('dossier_introuvable',
        'Ce dossier n’existe pas dans votre institution.', null, 404);
      if (!['BROUILLON', 'EN_ANALYSE', 'EN_COMITE'].includes(d.statut)) {
        throw new CreditError('dossier_verrouille',
          'Les garanties ne peuvent plus être modifiées : le dossier est ' + d.statut + '.', null, 409);
      }
      let compteId = null;
      if (estUuid(b.account_id)) {
        const a = (await c.query(
          `SELECT id, balance_cents, solde_bloque_cents FROM account
            WHERE id=$1 AND imf_id=$2`, [b.account_id, req.dbImfId])).rows[0];
        if (!a) throw new CreditError('compte_introuvable',
          'Ce compte d’épargne n’existe pas dans votre institution.', null, 404);
        const libre = Number(a.balance_cents) - Number(a.solde_bloque_cents || 0);
        if (type === 'EPARGNE_BLOQUEE' && montant > libre) {
          throw new CreditError('epargne_insuffisante',
            'Le solde disponible de ce compte (' + fcfa(libre) + ') est inférieur au montant à bloquer ('
            + fcfa(montant) + ').', { disponible_cents: libre }, 409);
        }
        compteId = a.id;
      }
      return (await c.query(
        `INSERT INTO garanties_credit
           (imf_id, tenant_id, dossier_id, type_garantie, libelle, montant_cents,
            account_id, statut, client_garant_id, reference_document)
         VALUES ($1,$1,$2,$3,$4,$5,$6,'EN_ATTENTE',$7,$8) RETURNING *`,
        [req.dbImfId, id, type, b.libelle ? String(b.libelle).slice(0, 200) : null, montant,
          compteId, uuidOuNull(b.client_garant_id),
          b.reference_document ? String(b.reference_document).slice(0, 120) : null])).rows[0];
    });
    await auditEvent(req.user, { action: 'credit.garantie.saisie', entity: 'garanties_credit',
      entityId: g.id, payload: { dossier_id: id, type, montant_cents: montant } });
    res.status(201).json({ garantie: g });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/**
 * Constitution de la garantie.
 *  • EPARGNE_BLOQUEE → bloque le solde (account.solde_bloque_cents) : l'argent
 *    reste au client mais il ne peut plus être retiré.
 *  • Autres types → simple marquage BLOQUEE (vérification physique / notariale).
 */
r.post('/credit/dossiers/:id/garanties/:garantieId/bloquer', requireRole(...AGENT),
  habilit('credit.garantie.gerer'), async (req, res, next) => {
  try {
    const { id, garantieId } = req.params;
    if (!estUuid(id) || !estUuid(garantieId)) return res.status(400).json({ error: 'id_invalide',
      message: 'Identifiant illisible.' });
    const out = await tenantTransaction(req, async (c) => {
      const g = (await c.query(
        `SELECT * FROM garanties_credit WHERE id=$1 AND dossier_id=$2 AND imf_id=$3 FOR UPDATE`,
        [garantieId, id, req.dbImfId])).rows[0];
      if (!g) throw new CreditError('garantie_introuvable',
        'Cette garantie n’existe pas sur ce dossier.', null, 404);
      if (g.statut === 'BLOQUEE') {
        return { garantie: g, deja: true };
      }
      if (g.statut !== 'EN_ATTENTE') throw new CreditError('garantie_non_disponible',
        'Cette garantie est déjà ' + g.statut + ' : elle ne peut plus être bloquée.', null, 409);

      if (g.type_garantie === 'EPARGNE_BLOQUEE') {
        const a = (await c.query(
          `SELECT id, balance_cents, solde_bloque_cents FROM account
            WHERE id=$1 AND imf_id=$2 FOR UPDATE`, [g.account_id, req.dbImfId])).rows[0];
        if (!a) throw new CreditError('compte_introuvable',
          'Le compte d’épargne garant n’existe plus.', null, 404);
        const libre = Number(a.balance_cents) - Number(a.solde_bloque_cents || 0);
        if (Number(g.montant_cents) > libre) throw new CreditError('epargne_insuffisante',
          'Solde disponible insuffisant (' + fcfa(libre) + ') pour bloquer ' + fcfa(g.montant_cents) + '.',
          { disponible_cents: libre }, 409);
        await c.query(
          'UPDATE account SET solde_bloque_cents = solde_bloque_cents + ($1::bigint) WHERE id=$2',
          [Number(g.montant_cents), a.id]);
      }

      const maj = (await c.query(
        `UPDATE garanties_credit SET statut='BLOQUEE', montant_bloque_cents=$2,
                date_blocage=now() WHERE id=$1 RETURNING *`,
        [g.id, Number(g.montant_cents)])).rows[0];
      return { garantie: maj, deja: false };
    });
    await auditEvent(req.user, { action: 'credit.garantie.bloquee', entity: 'garanties_credit',
      entityId: garantieId, payload: { dossier_id: id, montant_cents: out.garantie.montant_cents } });
    res.json(out);
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/* ========================================================================
 *  5. COMITÉ DE CRÉDIT : plafonds + décision (4 yeux)
 * ===================================================================== */
const PLAFONDS_DEFAUT = [
  { niveau: 1, libelle: 'Chef d’agence', plafond_cents: 200000000, position_code: 'POS_CHEF_AGENCE' },
  { niveau: 2, libelle: 'Comité de crédit', plafond_cents: 1000000000, position_code: null }
];

/** Plafonds effectifs : ceux paramétrés, sinon valeurs par défaut prudentes. */
async function plafondsDe(c, imfId) {
  const rows = (await c.query(
    `SELECT niveau, libelle, plafond_cents, position_code FROM plafonds_validation_credit
      WHERE imf_id=$1 AND actif ORDER BY niveau`, [imfId])).rows;
  return rows.length ? rows : PLAFONDS_DEFAUT;
}

r.get('/credit/plafonds', requireRole(...AGENT), habilit('credit.dossier.approuver',
  'credit.products.manage', 'credit.par.read'), async (req, res, next) => {
  try {
    const out = await tenantTransaction(req, async (c) => ({
      plafonds: await plafondsDe(c, req.dbImfId)
    }));
    res.json({ ...out, source: out.plafonds === PLAFONDS_DEFAUT ? 'defaut' : 'parametre' });
  } catch (e) { next(e); }
});

r.put('/credit/plafonds', requireRole(...ADMIN), habilit('credit.products.manage'),
  async (req, res, next) => {
  try {
    const liste = Array.isArray(req.body && req.body.plafonds) ? req.body.plafonds : [];
    if (!liste.length) return res.status(400).json({ error: 'liste_vide',
      message: 'Fournissez la liste des niveaux de validation.' });
    const propres = liste.map((p, i) => {
      const niveau = entierOuNull(p.niveau != null ? p.niveau : i + 1);
      const plafond = entierOuNull(p.plafond_cents);
      if (!niveau || niveau < 1 || niveau > 5) throw new CreditError('niveau_invalide',
        'Le niveau de validation doit être compris entre 1 et 5.', null, 400);
      if (plafond == null || plafond <= 0) throw new CreditError('plafond_invalide',
        'Chaque niveau doit avoir un plafond positif en centimes.', null, 400);
      return { niveau, plafond_cents: plafond,
        libelle: (p.libelle || 'Niveau ' + niveau).toString().slice(0, 80),
        position_code: p.position_code ? String(p.position_code).slice(0, 40) : null };
    });
    // Les niveaux doivent être croissants : sinon la hiérarchie n'a pas de sens.
    const trie = [...propres].sort((a, b) => a.niveau - b.niveau);
    for (let i = 1; i < trie.length; i += 1) {
      if (trie[i].plafond_cents <= trie[i - 1].plafond_cents) throw new CreditError('plafonds_non_croissants',
        'Le plafond du niveau ' + trie[i].niveau + ' doit être supérieur à celui du niveau ' + trie[i - 1].niveau + '.',
        null, 400);
    }

    const out = await tenantTransaction(req, async (c) => {
      for (const p of trie) {
        await c.query(
          `INSERT INTO plafonds_validation_credit
             (imf_id, tenant_id, niveau, libelle, plafond_cents, position_code, actif)
           VALUES ($1,$1,$2,$3,$4,$5,true)
           ON CONFLICT (imf_id, niveau) DO UPDATE
             SET libelle=EXCLUDED.libelle, plafond_cents=EXCLUDED.plafond_cents,
                 position_code=EXCLUDED.position_code, actif=true`,
          [req.dbImfId, p.niveau, p.libelle, p.plafond_cents, p.position_code]);
      }
      return plafondsDe(c, req.dbImfId);
    });
    await auditEvent(req.user, { action: 'credit.plafonds.modifies', entity: 'plafonds_validation_credit',
      payload: { niveaux: trie.map((p) => ({ niveau: p.niveau, plafond_cents: p.plafond_cents })) } });
    res.json({ plafonds: out, message: 'Plafonds de validation enregistrés.' });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/** File du comité : dossiers EN_COMITE, du plus ancien au plus récent. */
r.get('/credit/comite/file', requireRole(...AGENT), habilit('credit.dossier.approuver'),
  async (req, res, next) => {
  try {
    const out = await tenantTransaction(req, async (c) => {
      const plafonds = await plafondsDe(c, req.dbImfId);
      const rows = (await c.query(
        `SELECT d.id, d.reference, d.statut, d.montant_demande_cents, d.duree_mois,
                d.periodicite, d.taux_teg_bp, d.objet, d.date_soumission,
                d.agent_credit_id, cl.code_client, cl.full_name, pc.libelle AS produit,
                u.full_name AS agent
           FROM dossiers_credit d
           JOIN client cl ON cl.id = d.client_id
           JOIN produits_credit pc ON pc.id = d.produit_id
           LEFT JOIN app_user u ON u.id = d.agent_credit_id
          WHERE d.imf_id=$1 AND d.statut='EN_COMITE'
          ORDER BY d.date_soumission ASC NULLS LAST, d.created_at ASC`, [req.dbImfId])).rows;
      // Niveau requis pour chaque montant (premier palier suffisant).
      const enrichis = rows.map((d) => {
        const niveau = plafonds.find((p) => Number(d.montant_demande_cents) <= Number(p.plafond_cents))
          || plafonds[plafonds.length - 1];
        return {
          ...d,
          niveau_requis: niveau.niveau,
          plafond_cents: Number(niveau.plafond_cents),
          depasse_mon_plafond: null,
          je_suis_l_agent: String(d.agent_credit_id) === String(req.user.id)
        };
      });
      return { file: enrichis, plafonds };
    });
    res.json({ ...out, total: out.file.length });
  } catch (e) { next(e); }
});

/**
 * Décision du comité. Corps : { decision, montant_accorde_cents?, commentaire?, uuid_local? }
 * Le 4 yeux et le plafond sont contrôlés AVANT toute écriture.
 */
r.post('/credit/dossiers/:id/valider', requireRole(...AGENT), habilit('credit.dossier.approuver'),
  async (req, res, next) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide', message: 'Identifiant de dossier illisible.' });
    const decision = String(b.decision || '').toUpperCase();
    if (!['APPROUVE', 'REJETE', 'COMPLEMENT', 'AJOURNE'].includes(decision)) {
      return res.status(400).json({ error: 'decision_inconnue',
        message: 'Décision attendue : APPROUVE, REJETE, COMPLEMENT ou AJOURNE.' });
    }

    const out = await tenantTransaction(req, async (c) => {
      const d = await chargerDossier(c, id, req.dbImfId, true);
      if (!d) throw new CreditError('dossier_introuvable',
        'Ce dossier n’existe pas dans votre institution.', null, 404);
      if (d.statut !== 'EN_COMITE') throw new CreditError('dossier_hors_comite',
        'Ce dossier n’est pas en comité (statut actuel : ' + d.statut + ').', null, 409);

      const plafonds = await plafondsDe(c, req.dbImfId);
      const montant = decision === 'APPROUVE'
        ? (entierOuNull(b.montant_accorde_cents) || Number(d.montant_demande_cents))
        : Number(d.montant_demande_cents);
      if (decision === 'APPROUVE' && (montant <= 0 || montant > Number(d.montant_demande_cents))) {
        throw new CreditError('montant_accorde_invalide',
          'Le montant accordé doit être positif et ne pas dépasser le montant demandé (réduire le montant est possible, l’augmenter non).',
          { montant_demande_cents: d.montant_demande_cents }, 400);
      }

      // Niveau requis = premier palier couvrant le montant.
      const niveau = plafonds.find((p) => montant <= Number(p.plafond_cents))
        || plafonds[plafonds.length - 1];
      const plafond = Number(niveau.plafond_cents);

      // 4 yeux + plafond du validateur : contrôlé par le moteur.
      verifierQuatreYeux({
        agent_credit_id: d.agent_credit_id, validateur_id: req.user.id,
        montant_cents: montant, plafond_cents: plafond
      });

      if (decision === 'APPROUVE' && d.epargne_garantie_cents > 0) {
        const g = (await c.query(
          `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE statut='BLOQUEE')::int AS bloquees
             FROM garanties_credit WHERE dossier_id=$1`, [id])).rows[0];
        if (Number(g.total) > 0 && Number(g.bloquees) === 0) {
          throw new CreditError('garanties_non_constituees',
            'La garantie n’est pas constituée : impossible d’approuver le dossier.', null, 409);
        }
      }

      // Une seule validation par niveau : un complément crée le niveau suivant.
      const deja = (await c.query(
        'SELECT COALESCE(MAX(niveau),0)::int AS niveau FROM validations_credit WHERE dossier_id=$1',
        [id])).rows[0].niveau;
      // Si le dossier revient du comité après un complément, on reprend le même
      // niveau tant que la décision précédente n'était pas définitive.
      const dernierCompl = (await c.query(
        `SELECT decision FROM validations_credit WHERE dossier_id=$1
          ORDER BY niveau DESC LIMIT 1`, [id])).rows[0];
      const nouveauNiveau = (!dernierCompl || ['APPROUVE', 'REJETE'].includes(dernierCompl.decision))
        ? deja + 1 : deja;

      await c.query(
        `INSERT INTO validations_credit
           (imf_id, tenant_id, dossier_id, niveau, agent_credit_id, validateur_id,
            decision, montant_valide_cents, plafond_cents, commentaire, uuid_local)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (dossier_id, niveau) DO NOTHING`,
        [req.dbImfId, id, nouveauNiveau, d.agent_credit_id, req.user.id, decision,
          decision === 'APPROUVE' ? montant : 0, plafond,
          b.commentaire ? String(b.commentaire).slice(0, 1000) : null,
          uuidOuNull(b.uuid_local)]);

      let maj;
      if (decision === 'APPROUVE') {
        transitionAutorisee(d.statut, 'APPROUVE');
        maj = (await c.query(
          `UPDATE dossiers_credit SET statut='APPROUVE', montant_accorde_cents=$2,
                  date_approbation=now(), comite_id=$3, updated_at=now()
            WHERE id=$1 RETURNING *`, [id, montant, req.user.id])).rows[0];
      } else if (decision === 'REJETE') {
        transitionAutorisee(d.statut, 'REJETE');
        maj = (await c.query(
          `UPDATE dossiers_credit SET statut='REJETE', motif_rejet=$2, updated_at=now()
            WHERE id=$1 RETURNING *`,
          [id, b.commentaire ? String(b.commentaire).slice(0, 1000) : 'Rejeté par le comité'])).rows[0];
      } else if (decision === 'COMPLEMENT') {
        transitionAutorisee(d.statut, 'EN_ANALYSE');
        maj = (await c.query(
          `UPDATE dossiers_credit SET statut='EN_ANALYSE', updated_at=now()
            WHERE id=$1 RETURNING *`, [id])).rows[0];
      } else {
        maj = d; // AJOURNE : le dossier reste EN_COMITE
      }
      // Trace du score AU MOMENT de la décision : le comité doit pouvoir
      // expliquer plus tard sur quelles données il a jugé (recalcul léger).
      let scoring = null;
      try {
        scoring = await evaluerEtEnregistrer(req, c, maj, 'COMITE');
      } catch (eScoring) {
        scoring = { erreur: String(eScoring && eScoring.message || eScoring).slice(0, 300) };
      }
      return { dossier: maj, niveau: nouveauNiveau, plafond_cents: plafond, decision, scoring };
    });

    await auditEvent(req.user, { action: 'credit.dossier.' + decision.toLowerCase(),
      entity: 'dossiers_credit', entityId: id,
      payload: { niveau: out.niveau, plafond_cents: out.plafond_cents,
        score: out.scoring && out.scoring.score ? out.scoring.score.score_global : null } });
    res.json({ ...out, dossier: dossierPublic(out.dossier),
      score: out.scoring && out.scoring.score || null });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/* ========================================================================
 *  6. DÉCAISSEMENT
 * ===================================================================== */
/**
 * Corps : { mode, compte_cible_id?, canal_mm?, reference_externe_mm?,
 *           date_decaissement?, caisse_session_id?, uuid_local? }
 * Crée : decaissements + échéancier (version 1) + opération de caisse.
 * Net versé = montant accordé − frais de dossier − assurance − épargne garantie.
 */
r.post('/credit/dossiers/:id/decaisser', requireRole(...CAISSIER, 'agency', 'department', 'service'),
  habilit('credit.decaisser'), async (req, res, next) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide', message: 'Identifiant de dossier illisible.' });
    const mode = String(b.mode || 'GUICHET').toUpperCase();
    if (!['GUICHET', 'VIREMENT_EPARGNE', 'MOBILE_MONEY'].includes(mode)) {
      return res.status(400).json({ error: 'mode_inconnu',
        message: 'Mode de décaissement attendu : GUICHET, VIREMENT_EPARGNE ou MOBILE_MONEY.' });
    }
    if (mode === 'MOBILE_MONEY' && !['ORANGE_MONEY', 'MOOV_MONEY', 'WAVE'].includes(String(b.canal_mm || '').toUpperCase())) {
      return res.status(400).json({ error: 'canal_mm_requis',
        message: 'Choisissez l’opérateur Mobile Money (Orange Money, Moov Money ou Wave).' });
    }
    if (mode === 'MOBILE_MONEY' && String(b.reference_externe_mm || '').trim().length < 4) {
      return res.status(400).json({ error: 'reference_mm_manquante',
        message: 'La référence de la transaction Mobile Money est obligatoire.' });
    }
    if (mode === 'VIREMENT_EPARGNE' && !estUuid(b.compte_cible_id)) {
      return res.status(400).json({ error: 'compte_requis',
        message: 'Choisissez le compte d’épargne à créditer.' });
    }

    const out = await tenantTransaction(req, async (c) => {
      const d = await chargerDossier(c, id, req.dbImfId, true);
      if (!d) throw new CreditError('dossier_introuvable',
        'Ce dossier n’existe pas dans votre institution.', null, 404);

      // Idempotence : un décaissement déjà saisi sur ce dossier n'est pas refait.
      const deja = (await c.query(
        'SELECT * FROM decaissements WHERE dossier_id=$1', [id])).rows[0];
      if (deja) {
        return { deja: true, decaissement: deja, dossier: d, echeancier: [] };
      }
      if (d.statut !== 'APPROUVE') throw new CreditError('dossier_non_approuve',
        'Seul un dossier approuvé peut être décaissé (statut actuel : ' + d.statut + ').', null, 409);

      const montant = Number(d.montant_accorde_cents || d.montant_demande_cents);
      const frais = Number(d.frais_dossier_cents || 0);
      const assurance = Number(d.assurance_cents || 0);
      const epargne = Number(d.epargne_garantie_cents || 0);
      if (montant <= 0) throw new CreditError('montant_invalide',
        'Le montant accordé est nul : reprenez la décision du comité.', null, 409);
      const net = montant - frais - assurance - epargne;
      if (net < 0) throw new CreditError('retenues_excessives',
        'Les retenues (' + fcfa(frais + assurance + epargne) + ') dépassent le montant accordé (' + fcfa(montant) + ').',
        null, 409);

      const client = (await c.query(
        'SELECT id, code_client, full_name FROM client WHERE id=$1', [d.client_id])).rows[0];

      // Compte d'épargne du client (versement du net ou dépôt de l'épargne garantie).
      let cible = null;
      if (estUuid(b.compte_cible_id)) {
        cible = (await c.query(
          'SELECT id, balance_cents FROM account WHERE id=$1 AND imf_id=$2 AND client_id=$3',
          [b.compte_cible_id, req.dbImfId, d.client_id])).rows[0];
        if (!cible) throw new CreditError('compte_introuvable',
          'Ce compte d’épargne n’appartient pas au client du dossier.', null, 404);
      }
      if (mode === 'VIREMENT_EPARGNE' && !cible) throw new CreditError('compte_introuvable',
        'Le compte à créditer est introuvable.', null, 404);

      // Session de caisse du caissier (contrôle léger : si elle est ouverte, on
      // la rattache pour que l'arrêté de caisse la retrouve).
      const session = (await c.query(
        `SELECT id FROM sessions_caisse_agent
          WHERE agent_id=$1 AND imf_id=$2 AND statut='OUVERTE'`,
        [req.user.id, req.dbImfId])).rows[0] || null;

      const quand = b.date_decaissement && !isNaN(new Date(b.date_decaissement).getTime())
        ? new Date(b.date_decaissement) : new Date();
      if (quand.getTime() > Date.now() + 15 * 60000) throw new CreditError('horloge_en_avance',
        'La date de décaissement est dans le futur : corrigez la date du poste.', null, 409);

      // 1) Opération de caisse : sortie d'argent (kind='credit', direction=-1).
      const op = (await c.query(
        `INSERT INTO operation
           (imf_id, tenant_id, account_id, client_id, user_id, kind, amount_cents,
            status, impacts_agent_cash, direction, canal, reference_externe_mm,
            date_operation_locale, uuid_local, statut_sync, note)
         VALUES ($1,$1,$2,$3,$4,'credit',$5,'valide',$6,-1,$7,$8,$9,$10,'SYNCHRONISE',$11)
         RETURNING id`,
        [req.dbImfId, cible ? cible.id : null, client.id, req.user.id, net,
          mode === 'GUICHET', mode === 'MOBILE_MONEY' ? String(b.canal_mm).toUpperCase() : mode,
          b.reference_externe_mm ? String(b.reference_externe_mm).trim() : null,
          quand, uuidOuNull(b.uuid_local),
          'Décaissement crédit ' + d.reference + ' (' + fcfa(montant) + ')'])).rows[0];

      // 2) Versement du net sur le compte d'épargne choisi.
      if (cible && net > 0) {
        await c.query(
          'UPDATE account SET balance_cents = balance_cents + ($1::bigint) WHERE id=$2',
          [net, cible.id]);
      }

      // 3) Ligne de décaissement (traçabilité + unicité par dossier).
      const dec = (await c.query(
        `INSERT INTO decaissements
           (imf_id, tenant_id, dossier_id, montant_cents, frais_dossier_cents,
            assurance_cents, epargne_garantie_cents, net_verse_cents, mode,
            canal_mm, reference_externe_mm, account_cible_id, caisse_session_id,
            caissier_id, operation_id, uuid_local, date_decaissement)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [req.dbImfId, id, montant, frais, assurance, epargne, net, mode,
          mode === 'MOBILE_MONEY' ? String(b.canal_mm).toUpperCase() : null,
          b.reference_externe_mm ? String(b.reference_externe_mm).trim() : null,
          cible ? cible.id : null, session ? session.id : null,
          req.user.id, op.id, uuidOuNull(b.uuid_local), quand])).rows[0];

      // 4) Échéancier définitif (version 1) — figé au décaissement.
      const ech = construireEcheancier({
        montant_cents: montant, taux_nominal_bp: Number(d.taux_nominal_bp),
        duree_mois: Number(d.duree_mois), periodicite: d.periodicite, methode: d.methode,
        date_debut: quand.toISOString().slice(0, 10),
        differe_mois: Number(d.differe_mois || 0), differe_type: d.differe_type,
        assurance_cents: assurance
      });
      const lignes = [];
      for (const l of ech.lignes) {
        lignes.push((await c.query(
          `INSERT INTO echeanciers_credit
             (imf_id, tenant_id, dossier_id, numero, date_echeance, montant_echeance_cents,
              capital_cents, interet_cents, assurance_cents, solde_capital_cents,
              statut, version)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,'A_PAYER',1) RETURNING *`,
          [req.dbImfId, id, l.numero, l.date_echeance, l.montant_echeance_cents,
            l.capital_cents, l.interet_cents, l.assurance_cents || 0,
            l.solde_capital_cents])).rows[0]);
      }
      const premiere = ech.lignes.length ? ech.lignes[0].date_echeance : null;
      const derniere = ech.lignes.length ? ech.lignes[ech.lignes.length - 1].date_echeance : null;

      // 5) TEG réellement appliqué (journalisé sur le dossier).
      const teg = calculerTeg({ montant_net_cents: net, lignes: ech.lignes, periodicite: d.periodicite });

      const maj = (await c.query(
        `UPDATE dossiers_credit SET statut='DECAISSE', date_decaissement=$2,
                date_premiere_echeance=$3, date_derniere_echeance=$4,
                taux_teg_bp=$5, total_interets_cents=$6, solde_capital_cents=$7,
                updated_at=now() WHERE id=$1 RETURNING *`,
        [id, quand, premiere, derniere, teg, ech.total_interets_cents, montant])).rows[0];

      return { deja: false, decaissement: dec, dossier: maj, echeancier: lignes,
        operation_id: op.id, net_verse_cents: net, teg_bp: teg };
    });

    await auditEvent(req.user, { action: 'credit.decaissement', entity: 'dossiers_credit',
      entityId: id, payload: { net_verse_cents: out.net_verse_cents, deja: out.deja } });
    if (out.deja) {
      return res.status(200).json({ ...out, dossier: dossierPublic(out.dossier),
        message: 'Ce dossier a déjà été décaissé : aucun second décaissement n’a été créé.' });
    }
    res.status(201).json({ ...out, dossier: dossierPublic(out.dossier),
      message: 'Crédit décaissé. Échéancier de ' + out.echeancier.length + ' échéances enregistré.' });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

r.get('/credit/dossiers/:id/echeancier', requireRole(...AGENT), habilit('credit.par.read',
  'credit.rembourser', 'credit.recouvrement', 'credit.decaisser'), async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide', message: 'Identifiant de dossier illisible.' });
    const out = await tenantTransaction(req, async (c) => {
      const d = await chargerDossier(c, id, req.dbImfId, false);
      if (!d) return null;
      const echeances = (await c.query(
        `SELECT * FROM echeanciers_credit WHERE dossier_id=$1
          ORDER BY version DESC, numero`, [id])).rows;
      return { dossier: d, echeances };
    });
    if (!out) return res.status(404).json({ error: 'dossier_introuvable',
      message: 'Ce dossier n’existe pas dans votre institution.' });
    res.json(out);
  } catch (e) { next(e); }
});

/* ========================================================================
 *  7. REMBOURSEMENTS (guichet / terrain)
 * ===================================================================== */
/**
 * Cœur commun au guichet et à la synchronisation hors-ligne : impute, met à
 * jour les échéances, écrit le remboursement et ses imputations.
 * @returns {object} résultat pour l'appelant
 */
async function encaisserRemboursement(c, o) {
  const { d, montant, canal, referenceMm, gpsLat, gpsLng, quand, uuidLocal,
    operationIdExistant, encaissePar } = o;
  const aujourd = (quand ? new Date(quand) : new Date()).toISOString().slice(0, 10);

  const echeances = (await c.query(
    `SELECT id, numero, date_echeance, montant_echeance_cents, capital_cents,
            interet_cents, assurance_cents, capital_paye_cents, interet_paye_cents,
            assurance_payee_cents, penalite_cents, penalite_payee_cents, statut, jours_retard
       FROM echeanciers_credit
      WHERE dossier_id=$1 AND version=(
        SELECT MAX(version) FROM echeanciers_credit WHERE dossier_id=$1)
      ORDER BY numero FOR UPDATE`, [d.id])).rows.map((e) => ({
    ...e,
    capital_cents: Number(e.capital_cents), interet_cents: Number(e.interet_cents),
    capital_paye_cents: Number(e.capital_paye_cents), interet_paye_cents: Number(e.interet_paye_cents),
    assurance_cents: Number(e.assurance_cents), assurance_payee_cents: Number(e.assurance_payee_cents),
    penalite_cents: Number(e.penalite_cents), penalite_payee_cents: Number(e.penalite_payee_cents)
  }));
  if (!echeances.length) throw new CreditError('echeancier_absent',
    'Ce dossier n’a pas encore d’échéancier : le crédit n’a pas été décaissé.', null, 409);

  const produit = (await c.query(
    `SELECT penalite_retard_bp_jour, provision_sain_bp, provision_immobilise_bp,
            provision_douteux_bp, provision_litigieux_bp
       FROM produits_credit WHERE id=$1`, [d.produit_id])).rows[0] || {};

  // 1) Situation d'impayé (pénalités recalculées à la date d'encaissement).
  const anal = evaluerImpaye({ aujourdhui: aujourd, echeances, produit,
    classe_actuelle: d.classe_creance });

  const imputation = imputerRemboursement({
    montant_cents: montant,
    penalites_dues_cents: anal.penalites_dues_cents,
    interets_echus_cents: Math.max(0, anal.impaye_interets_cents),
    // L'assurance est due au prêteur comme les intérêts : sans elle, une
    // échéance ne peut jamais être marquée PAYE et le dossier ne se clôture pas.
    assurances_echues_cents: Math.max(0, Number(anal.impaye_assurance_cents || 0)),
    capital_du_cents: Math.max(0, anal.encours_capital_cents)
  });

  const reparti = repartirSurEcheances(echeances, imputation);

  // 2) Écriture du remboursement.
  const annee = new Date().getFullYear();
  const nrecu = (await c.query(
    `SELECT COUNT(*)::int + 1 AS n FROM remboursements_credit
      WHERE imf_id=$1 AND extract(year FROM created_at)=$2`, [req.dbImfId, annee])).rows[0].n;
  const refRecu = referenceRecuRemboursement({ annee, numero: nrecu });

  const remb = (await c.query(
    `INSERT INTO remboursements_credit
       (imf_id, tenant_id, dossier_id, montant_cents, penalite_cents, interet_cents,
        capital_cents, trop_percu_cents, canal, reference_externe_mm, operation_id,
        encaisse_par, gps_lat, gps_lng, date_operation_locale, uuid_local,
        statut_sync, reference_recu)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'SYNCHRONISE',$16)
     RETURNING *`,
    [req.dbImfId, d.id, montant, imputation.penalite_cents, imputation.interet_cents,
      imputation.capital_cents, imputation.trop_percu_cents, canal, referenceMm,
      operationIdExistant || null, encaissePar || req.user.id, gpsLat, gpsLng,
      quand || new Date(), uuidLocal || null, refRecu])).rows[0];

  // 3) Imputations ligne à ligne (traçabilité BCEAO).
  for (const l of reparti.lignes) {
    await c.query(
      `INSERT INTO imputations_remboursement
         (imf_id, tenant_id, remboursement_id, echeance_id, nature, montant_cents)
       VALUES ($1,$1,$2,$3,$4,$5)`,
      [req.dbImfId, remb.id, l.echeance_id, l.nature, l.montant_cents]);
  }

  // 4) Mise à jour des échéances (paiements, pénalités, statut).
  for (const e of reparti.echeances) {
    const penalite = (anal.echeances.find((x) => String(x.echeance_id) === String(e.id)) || {}).penalite_cents || 0;
    await c.query(
      `UPDATE echeanciers_credit SET capital_paye_cents=$2, interet_paye_cents=$3,
              assurance_payee_cents=$4,
              penalite_cents=GREATEST(penalite_cents,$5), penalite_payee_cents=$6,
              statut=$7, jours_retard=$8,
              date_paiement=CASE WHEN $7='PAYE' THEN now() ELSE date_paiement END
        WHERE id=$1`,
      [e.id, e.capital_paye_cents, e.interet_paye_cents,
        Number(e.assurance_payee_cents || 0), penalite,
        e.penalite_payee_cents, e.statut, Number(e.jours_retard || 0)]);
  }

  // 5) Compteurs du dossier (imputation temps réel).
  const nouveauSolde = Math.max(0, Number(d.solde_capital_cents) - imputation.capital_cents);
  const reste = reparti.echeances.some((e) => e.statut !== 'PAYE');
  const statutDossier = !reste && nouveauSolde === 0 ? 'CLOTURE_SOLDE' : 'DECAISSE';
  const jours = anal.jours_retard;
  const classe = jours > 0 ? classeBceao(jours) : 'SAIN';
  const provision = calculerProvision(nouveauSolde, classe, produit);

  const maj = (await c.query(
    `UPDATE dossiers_credit SET
        solde_capital_cents=$2,
        capital_rembourse_cents=capital_rembourse_cents + $3,
        total_interets_cents=GREATEST(0, total_interets_cents - $4),
        total_penalites_cents=total_penalites_cents + $5,
        jours_retard=$6, classe_creance=$7, montant_impaye_cents=$8,
        provision_cents=$9, statut=$10,
        date_cloture=CASE WHEN $10='CLOTURE_SOLDE' THEN now() ELSE date_cloture END,
        updated_at=now()
      WHERE id=$1 RETURNING *`,
    [d.id, nouveauSolde, imputation.capital_cents, imputation.interet_cents,
      imputation.penalite_cents, jours, classe, Math.max(0, anal.montant_impaye_cents - imputation.capital_cents - imputation.interet_cents),
      provision, statutDossier])).rows[0];

  // 6) Déclassement automatique éventuel (traçabilité réglementaire).
  if (classe !== d.classe_creance) {
    await c.query(
      `INSERT INTO declassements_creances
         (imf_id, tenant_id, dossier_id, classe_avant, classe_apres, jours_retard,
          encours_cents, taux_provision_bp, provision_cents, automatique, motif)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,true,$9)`,
      [req.dbImfId, d.id, d.classe_creance, classe, jours, nouveauSolde,
        tauxProvisionBp(classe, produit), provision,
        'Reclassement automatique lors d’un remboursement (méthode BCEAO)']);
  }

  return { remboursement: remb, imputation, dossier: maj, echeances: reparti.echeances,
    solde_capital_cents: nouveauSolde, cloture: statutDossier === 'CLOTURE_SOLDE' };
}

r.post('/credit/dossiers/:id/rembourser', requireRole(...AGENT), habilit('credit.rembourser'),
  async (req, res, next) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide', message: 'Identifiant de dossier illisible.' });
    const montant = entierOuNull(b.montant_cents != null ? b.montant_cents
      : montantEnCentimes(b.montant, 'montant'));
    if (!montant || montant <= 0) return res.status(400).json({ error: 'montant_invalide',
      message: 'Indiquez le montant encaissé en FCFA entiers.' });
    const canal = String(b.canal || 'GUICHET').toUpperCase();
    if (!CANAUX_REMBOURSEMENT.includes(canal)) return res.status(400).json({ error: 'canal_inconnu',
      message: 'Canal de remboursement inconnu.', canaux: CANAUX_REMBOURSEMENT });
    const besoinRef = ['ORANGE_MONEY', 'MOOV_MONEY', 'WAVE', 'INTEROP_BCEAO'].includes(canal);
    const referenceMm = b.reference_externe_mm ? String(b.reference_externe_mm).trim() : null;
    if (besoinRef && (!referenceMm || referenceMm.length < 4)) {
      return res.status(422).json({ error: 'reference_mm_manquante',
        message: 'Pour un remboursement ' + canal + ', la référence de la transaction est obligatoire.' });
    }

    const out = await tenantTransaction(req, async (c) => {
      const d = await chargerDossier(c, id, req.dbImfId, true);
      if (!d) throw new CreditError('dossier_introuvable',
        'Ce dossier n’existe pas dans votre institution.', null, 404);
      if (!['DECAISSE', 'CLOTURE_SOLDE'].includes(d.statut)) throw new CreditError('dossier_non_decaisse',
        'Aucun remboursement ne peut être encaissé : le crédit n’est pas décaissé (statut : ' + d.statut + ').', null, 409);
      if (d.statut === 'CLOTURE_SOLDE') throw new CreditError('dossier_deja_solde',
        'Ce crédit est déjà entièrement remboursé.', null, 409);

      // Référence Mobile Money déjà utilisée ? (protection anti-double encaissement)
      if (referenceMm) {
        const dup = (await c.query(
          'SELECT 1 FROM remboursements_credit WHERE imf_id=$1 AND reference_externe_mm=$2',
          [req.dbImfId, referenceMm])).rows[0];
        if (dup) throw new CreditError('reference_deja_utilisee',
          'Cette référence de transaction a déjà servi pour un remboursement : rien n’a été compté en double.',
          { reference_externe_mm: referenceMm }, 409);
      }

      const quand = b.date_encaissement && !isNaN(new Date(b.date_encaissement).getTime())
        ? new Date(b.date_encaissement) : new Date();
      if (quand.getTime() > Date.now() + 15 * 60000) throw new CreditError('horloge_en_avance',
        'La date d’encaissement est dans le futur : corrigez la date du poste.', null, 409);

      const session = (await c.query(
        `SELECT id FROM sessions_caisse_agent
          WHERE agent_id=$1 AND imf_id=$2 AND statut='OUVERTE'`,
        [req.user.id, req.dbImfId])).rows[0] || null;

      // Opération de caisse : entrée d'argent.
      const op = (await c.query(
        `INSERT INTO operation
           (imf_id, tenant_id, client_id, user_id, kind, amount_cents, status,
            impacts_agent_cash, direction, canal, reference_externe_mm,
            date_operation_locale, statut_sync, note)
         VALUES ($1,$1,$2,$3,'remboursement_credit',$4,'valide',$5,1,$6,$7,$8,'SYNCHRONISE',$9)
         RETURNING id`,
        [req.dbImfId, d.client_id, req.user.id, montant,
          ['GUICHET', 'TERRAIN_CASH'].includes(canal), canal, referenceMm,
          quand, 'Remboursement crédit ' + d.reference + (session ? ' (caisse ' + String(session.id).slice(0, 8) + ')' : '')])).rows[0];

      const r = await encaisserRemboursement(c, {
        d, montant, canal, referenceMm, gpsLat: b.gps_lat != null ? Number(b.gps_lat) : null,
        gpsLng: b.gps_lng != null ? Number(b.gps_lng) : null, quand,
        uuidLocal: uuidOuNull(b.uuid_local), operationIdExistant: op.id, encaissePar: req.user.id
      });
      if (session) {
        await c.query(
          'UPDATE remboursements_credit SET session_caisse_id=$2 WHERE id=$1',
          [r.remboursement.id, session.id]);
      }
      return { ...r, operation_id: op.id };
    });

    await auditEvent(req.user, { action: 'credit.remboursement', entity: 'dossiers_credit',
      entityId: id, payload: { montant_cents: montant, canal,
        reference_recu: out.remboursement.reference_recu } });

    res.status(201).json({
      remboursement: out.remboursement,
      imputation: out.imputation,
      dossier: dossierPublic(out.dossier),
      solde_capital_cents: out.solde_capital_cents,
      cloture: out.cloture,
      message: 'Reçu ' + out.remboursement.reference_recu + '. Imputation : '
        + fcfa(out.imputation.penalite_cents) + ' pénalités, '
        + fcfa(out.imputation.interet_cents) + ' intérêts, '
        + fcfa(out.imputation.capital_cents) + ' capital'
        + (out.imputation.trop_percu_cents > 0
          ? ' — trop-perçu ' + fcfa(out.imputation.trop_percu_cents) + ' à restituer au client.' : '.') 
        + (out.cloture ? ' Crédit entièrement soldé : dossier clôturé.' : '')
    });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/* ========================================================================
 *  8. RECOUVREMENT : impayés, actions, déclassement manuel
 * ===================================================================== */
r.get('/credit/impayes', requireRole(...AGENT), habilit('credit.recouvrement', 'credit.par.read'),
  async (req, res, next) => {
  try {
    const seuil = Math.max(1, Number(req.query.jours) || 1);
    const out = await tenantTransaction(req, async (c) => (await c.query(
      `SELECT d.id, d.reference, d.statut, d.jours_retard, d.classe_creance,
              d.solde_capital_cents, d.montant_impaye_cents, d.provision_cents,
              d.date_premiere_echeance,
              cl.code_client, cl.full_name, cl.phone,
              pc.libelle AS produit,
              u.full_name AS agent,
              (SELECT MIN(e.date_echeance) FROM echeanciers_credit e
                WHERE e.dossier_id=d.id AND e.capital_paye_cents < e.capital_cents) AS prochaine_echeance,
              (SELECT COALESCE(SUM(e.interet_cents - e.interet_paye_cents),0)::bigint
                 FROM echeanciers_credit e WHERE e.dossier_id=d.id) AS interets_dus_cents,
              (SELECT COUNT(*)::int FROM actions_recouvrement a
                WHERE a.dossier_id=d.id AND a.created_at > now() - interval '30 days') AS actions_30j
         FROM dossiers_credit d
         JOIN client cl ON cl.id=d.client_id
         JOIN produits_credit pc ON pc.id=d.produit_id
         LEFT JOIN app_user u ON u.id=d.agent_credit_id
        WHERE d.imf_id=$1 AND d.statut='DECAISSE' AND d.jours_retard >= $2
        ORDER BY d.jours_retard DESC, d.solde_capital_cents DESC
        LIMIT 200`, [req.dbImfId, seuil])).rows);
    res.json({ impayes: out, total: out.length, seuil_jours: seuil });
  } catch (e) { next(e); }
});

r.get('/credit/dossiers/:id/actions', requireRole(...AGENT), habilit('credit.recouvrement',
  'credit.par.read'), async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide', message: 'Identifiant illisible.' });
    const rows = await tenantTransaction(req, async (c) => (await c.query(
      `SELECT a.*, u.full_name AS agent FROM actions_recouvrement a
         LEFT JOIN app_user u ON u.id=a.agent_id
        WHERE a.dossier_id=$1 AND a.imf_id=$2
        ORDER BY a.created_at DESC LIMIT 100`, [id, req.dbImfId])).rows);
    res.json({ actions: rows, total: rows.length });
  } catch (e) { next(e); }
});

r.post('/credit/dossiers/:id/actions', requireRole(...AGENT), habilit('credit.recouvrement'),
  async (req, res, next) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    if (!estUuid(id)) return res.status(400).json({ error: 'id_invalide', message: 'Identifiant illisible.' });
    const ev = validerActionHorsLigne({ ...b, uuid_local: b.uuid_local || randomUUID(),
      dossier_id: id });

    const out = await tenantTransaction(req, async (c) => {
      const d = await chargerDossier(c, id, req.dbImfId, false);
      if (!d) throw new CreditError('dossier_introuvable',
        'Ce dossier n’existe pas dans votre institution.', null, 404);
      if (ev.uuid_local) {
        const deja = (await c.query(
          'SELECT * FROM actions_recouvrement WHERE imf_id=$1 AND uuid_local=$2',
          [req.dbImfId, ev.uuid_local])).rows[0];
        if (deja) return { action: deja, deja: true };
      }
      const a = (await c.query(
        `INSERT INTO actions_recouvrement
           (imf_id, tenant_id, dossier_id, type_action, resultat, montant_promis_cents,
            date_promesse, observation, agent_id, gps_lat, gps_lng,
            date_action_locale, uuid_local, statut_sync)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'SYNCHRONISE')
         RETURNING *`,
        [req.dbImfId, id, ev.type_action, ev.resultat, ev.montant_promis_cents,
          ev.date_promesse, ev.observation, req.user.id, ev.gps_lat, ev.gps_lng,
          ev.date_action_locale, ev.uuid_local])).rows[0];
      return { action: a, deja: false };
    });
    await auditEvent(req.user, { action: 'credit.action.recouvrement', entity: 'dossiers_credit',
      entityId: id, payload: { type_action: ev.type_action, deja: out.deja } });
    res.status(out.deja ? 200 : 201).json(out);
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/** Déclassement manuel motivé (le déclassement automatique se fait à la tâche quotidienne). */
r.post('/credit/declasser', requireRole(...AGENT), habilit('credit.declasser'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!estUuid(b.dossier_id)) return res.status(400).json({ error: 'dossier_invalide',
      message: 'Choisissez le dossier à déclasser.' });
    const cible = String(b.classe_apres || '').toUpperCase();
    if (!CLASSES_CREANCE.includes(cible)) return res.status(400).json({ error: 'classe_inconnue',
      message: 'Classe de créance attendue : ' + CLASSES_CREANCE.join(', ') + '.' });
    const motif = b.motif ? String(b.motif).trim() : '';
    if (motif.length < 8) return res.status(400).json({ error: 'motif_requis',
      message: 'Un déclassement manuel exige un motif écrit (8 caractères au moins).' });

    const out = await tenantTransaction(req, async (c) => {
      const d = await chargerDossier(c, b.dossier_id, req.dbImfId, true);
      if (!d) throw new CreditError('dossier_introuvable',
        'Ce dossier n’existe pas dans votre institution.', null, 404);
      if (d.classe_creance === cible) throw new CreditError('classe_inchangee',
        'La créance est déjà classée ' + cible + '.', null, 409);
      const produit = (await c.query(
        `SELECT provision_sain_bp, provision_immobilise_bp, provision_douteux_bp,
                provision_litigieux_bp FROM produits_credit WHERE id=$1`, [d.produit_id])).rows[0] || {};
      const encours = Number(d.solde_capital_cents);
      const taux = tauxProvisionBp(cible, produit);
      const provision = calculerProvision(encours, cible, produit);
      await c.query(
        `INSERT INTO declassements_creances
           (imf_id, tenant_id, dossier_id, classe_avant, classe_apres, jours_retard,
            encours_cents, taux_provision_bp, provision_cents, automatique,
            decide_par, motif, date_declassement)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,false,$9,$10,CURRENT_DATE)`,
        [req.dbImfId, d.id, d.classe_creance, cible, d.jours_retard, encours,
          taux, provision, req.user.id, motif]);
      return (await c.query(
        `UPDATE dossiers_credit SET classe_creance=$2, provision_cents=$3,
                date_declassement=CURRENT_DATE, updated_at=now()
          WHERE id=$1 RETURNING *`, [d.id, cible, provision])).rows[0];
    });
    await auditEvent(req.user, { action: 'credit.declassement', entity: 'dossiers_credit',
      entityId: b.dossier_id, payload: { classe_apres: cible, motif } });
    res.json({ dossier: dossierPublic(out), message: 'Créance déclassée en ' + cible + '.' });
  } catch (e) { try { echec(res, e); } catch (err) { next(err); } }
});

/* ========================================================================
 *  9. TÂCHE QUOTIDIENNE (à lancer par le service crédit, ou par un cron)
 * ===================================================================== */
/**
 * Pour chaque dossier décaissé : recalcule jours de retard, pénalités, classe
 * BCEAO et provision. Écrit les changements de classe dans declassements_creances.
 * Idempotente : deux exécutions le même jour ne changent rien de plus.
 */
r.post('/credit/taches/quotidien', requireRole(...ADMIN, 'department', 'service'),
  habilit('credit.tache.quotidienne'), async (req, res, next) => {
  try {
    const aujourd = (req.body && req.body.aujourdhui) ? String(req.body.aujourdhui).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const out = await tenantTransaction(req, async (c) => {
      const dossiers = (await c.query(
        `SELECT id, reference, produit_id, classe_creance, jours_retard, solde_capital_cents
           FROM dossiers_credit
          WHERE imf_id=$1 AND statut='DECAISSE'
          ORDER BY id FOR UPDATE`, [req.dbImfId])).rows;
      let reclasses = 0; let provisions = 0; let enRetard = 0;
      const detail = [];
      for (const d of dossiers) {
        const echeances = (await c.query(
          `SELECT id, numero, date_echeance, capital_cents, interet_cents,
                  capital_paye_cents, interet_paye_cents, penalite_cents,
                  penalite_payee_cents, statut
             FROM echeanciers_credit
            WHERE dossier_id=$1 AND version=(
              SELECT MAX(version) FROM echeanciers_credit WHERE dossier_id=$1)
            ORDER BY numero`, [d.id])).rows.map((e) => ({ ...e,
          capital_cents: Number(e.capital_cents), interet_cents: Number(e.interet_cents),
          capital_paye_cents: Number(e.capital_paye_cents),
          interet_paye_cents: Number(e.interet_paye_cents),
          penalite_cents: Number(e.penalite_cents),
          penalite_payee_cents: Number(e.penalite_payee_cents) }));
        if (!echeances.length) continue;
        const produit = (await c.query(
          `SELECT penalite_retard_bp_jour, provision_sain_bp, provision_immobilise_bp,
                  provision_douteux_bp, provision_litigieux_bp
             FROM produits_credit WHERE id=$1`, [d.produit_id])).rows[0] || {};
        const anal = evaluerImpaye({ aujourdhui: aujourd, echeances, produit,
          classe_actuelle: d.classe_creance });

        // Pénalités et statuts des échéances.
        for (const x of anal.echeances) {
          await c.query(
            `UPDATE echeanciers_credit
                SET jours_retard=$2, penalite_cents=GREATEST(penalite_cents,$3), statut=$4
              WHERE id=$1`,
            [x.echeance_id, x.jours_retard, x.penalite_cents, x.statut]);
        }
        const encours = Number(anal.encours_capital_cents);
        const provision = calculerProvision(encours, anal.classe_apres, produit);
        provisions += provision;
        if (anal.jours_retard > 0) enRetard += 1;

        await c.query(
          `UPDATE dossiers_credit
              SET jours_retard=$2, montant_impaye_cents=$3, classe_creance=$4,
                  provision_cents=$5, solde_capital_cents=$6,
                  date_declassement=CASE WHEN $4<>$7 THEN CURRENT_DATE ELSE date_declassement END,
                  updated_at=now()
            WHERE id=$1`,
          [d.id, anal.jours_retard, anal.montant_impaye_cents, anal.classe_apres,
            provision, encours, d.classe_creance]);

        if (anal.changement_classe) {
          reclasses += 1;
          await c.query(
            `INSERT INTO declassements_creances
               (imf_id, tenant_id, dossier_id, classe_avant, classe_apres, jours_retard,
                encours_cents, taux_provision_bp, provision_cents, automatique,
                motif, date_declassement)
             VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)`,
            [req.dbImfId, d.id, anal.classe_avant, anal.classe_apres, anal.jours_retard,
              encours, tauxProvisionBp(anal.classe_apres, produit), provision,
              'Tâche quotidienne du ' + aujourd, aujourd]);
          detail.push({ reference: d.reference, de: anal.classe_avant,
            vers: anal.classe_apres, jours_retard: anal.jours_retard });
        }
      }
      return { dossiers: dossiers.length, en_retard: enRetard, reclasses,
        provisions_cents: provisions, detail_reclassements: detail, date: aujourd };
    });
    await auditEvent(req.user, { action: 'credit.tache.quotidienne', entity: 'dossiers_credit',
      payload: out });
    res.json(out);
  } catch (e) { next(e); }
});

/* ========================================================================
 *  10. SYNCHRONISATION HORS-LIGNE (idempotente par uuid_local)
 * ===================================================================== */
/**
 * Corps : { remboursements: [...], actions: [...] }
 * Chaque événement porte un uuid_local : le renvoyer 100 fois ne crée qu'une
 * seule écriture. Réponse 207 si certains événements sont refusés.
 */
r.post('/credit/sync', requireRole(...AGENT), habilit('credit.rembourser', 'credit.recouvrement'),
  async (req, res, next) => {
  try {
    const b = req.body || {};
    const rembs = Array.isArray(b.remboursements) ? b.remboursements.slice(0, 200) : [];
    const actions = Array.isArray(b.actions) ? b.actions.slice(0, 200) : [];
    if (!rembs.length && !actions.length) return res.status(400).json({ error: 'lot_vide',
      message: 'Aucun remboursement ni action à synchroniser.' });

    const resultats = [];

    // ---- Remboursements -------------------------------------------------
    for (const brut of rembs) {
      try {
        const ev = validerRemboursementHorsLigne(brut);
        const res1 = await tenantTransaction(req, async (c) => {
          const deja = (await c.query(
            `SELECT id, reference_recu, capital_cents FROM remboursements_credit
              WHERE imf_id=$1 AND uuid_local=$2`, [req.dbImfId, ev.uuid_local])).rows[0];
          if (deja) return { statut: 'REJETE_DOUBLON', id: deja.id,
            message: 'Déjà synchronisé (reçu ' + deja.reference_recu + ') : rien de compté en double.' };

          // Dossier : par identifiant, sinon par référence lisible.
          let d = null;
          if (ev.dossier_id && estUuid(ev.dossier_id)) {
            d = await chargerDossier(c, ev.dossier_id, req.dbImfId, true);
          } else if (ev.dossier_reference) {
            d = (await c.query(
              'SELECT * FROM dossiers_credit WHERE imf_id=$1 AND reference=$2 FOR UPDATE',
              [req.dbImfId, ev.dossier_reference])).rows[0] || null;
          }
          if (!d) return { statut: 'REJETE', code: 'dossier_introuvable',
            message: 'Ce dossier de crédit n’existe pas dans votre institution.' };
          if (!['DECAISSE'].includes(d.statut)) return { statut: 'REJETE', code: 'dossier_non_decaisse',
            message: 'Le crédit de ce dossier n’est pas décaissé (statut ' + d.statut + ').' };

          if (ev.reference_externe_mm) {
            const dup = (await c.query(
              'SELECT 1 FROM remboursements_credit WHERE imf_id=$1 AND reference_externe_mm=$2',
              [req.dbImfId, ev.reference_externe_mm])).rows[0];
            if (dup) return { statut: 'REJETE_DOUBLON', code: 'reference_deja_utilisee',
              message: 'Cette référence ' + ev.reference_externe_mm + ' a déjà servi : rien de compté en double.' };
          }

          const op = (await c.query(
            `INSERT INTO operation
               (imf_id, tenant_id, client_id, user_id, kind, amount_cents, status,
                impacts_agent_cash, direction, canal, reference_externe_mm, gps_lat,
                gps_lng, date_operation_locale, uuid_local, statut_sync, note)
             VALUES ($1,$1,$2,$3,'remboursement_credit',$4,'valide',$5,1,$6,$7,$8,$9,$10,$11,'SYNCHRONISE',$12)
             RETURNING id`,
            [req.dbImfId, d.client_id, req.user.id, ev.montant_cents,
              ['GUICHET', 'TERRAIN_CASH'].includes(ev.canal), ev.canal,
              ev.reference_externe_mm, ev.gps_lat, ev.gps_lng,
              ev.date_operation_locale, ev.uuid_local,
              'Remboursement terrain ' + d.reference])).rows[0];

          const r = await encaisserRemboursement(c, {
            d, montant: ev.montant_cents, canal: ev.canal,
            referenceMm: ev.reference_externe_mm, gpsLat: ev.gps_lat, gpsLng: ev.gps_lng,
            quand: ev.date_operation_locale, uuidLocal: ev.uuid_local,
            operationIdExistant: op.id, encaissePar: req.user.id
          });
          return { statut: 'SYNCHRONISE', id: r.remboursement.id,
            reference_recu: r.remboursement.reference_recu,
            dossier_reference: d.reference, solde_capital_cents: r.solde_capital_cents,
            imputation: r.imputation, cloture: r.cloture,
            message: 'Encaissé et imputé (pénalités → intérêts → capital).' };
        });
        resultats.push({ type: 'remboursement', uuid_local: ev.uuid_local, ...res1 });
      } catch (e) {
        if (e instanceof CreditError) {
          resultats.push({ type: 'remboursement', uuid_local: brut && brut.uuid_local,
            statut: 'REJETE', code: e.code, message: e.message });
        } else if (estDoublon(e)) {
          resultats.push({ type: 'remboursement', uuid_local: brut && brut.uuid_local,
            statut: 'REJETE_DOUBLON', message: 'Déjà synchronisé : rien de compté en double.' });
        } else { throw e; }
      }
    }

    // ---- Actions de recouvrement ---------------------------------------
    for (const brut of actions) {
      try {
        const ev = validerActionHorsLigne(brut);
        const res2 = await tenantTransaction(req, async (c) => {
          const deja = (await c.query(
            'SELECT id FROM actions_recouvrement WHERE imf_id=$1 AND uuid_local=$2',
            [req.dbImfId, ev.uuid_local])).rows[0];
          if (deja) return { statut: 'REJETE_DOUBLON', id: deja.id,
            message: 'Action déjà synchronisée.' };
          let d = null;
          if (ev.dossier_id && estUuid(ev.dossier_id)) {
            d = await chargerDossier(c, ev.dossier_id, req.dbImfId, false);
          }
          if (!d) return { statut: 'REJETE', code: 'dossier_introuvable',
            message: 'Ce dossier n’existe pas dans votre institution.' };
          const a = (await c.query(
            `INSERT INTO actions_recouvrement
               (imf_id, tenant_id, dossier_id, type_action, resultat, montant_promis_cents,
                date_promesse, observation, agent_id, gps_lat, gps_lng,
                date_action_locale, uuid_local, statut_sync)
             VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'SYNCHRONISE')
             RETURNING id`,
            [req.dbImfId, d.id, ev.type_action, ev.resultat, ev.montant_promis_cents,
              ev.date_promesse, ev.observation, req.user.id, ev.gps_lat, ev.gps_lng,
              ev.date_action_locale, ev.uuid_local])).rows[0];
          return { statut: 'SYNCHRONISE', id: a.id, message: 'Action enregistrée.' };
        });
        resultats.push({ type: 'action', uuid_local: ev.uuid_local, ...res2 });
      } catch (e) {
        if (e instanceof CreditError) {
          resultats.push({ type: 'action', uuid_local: brut && brut.uuid_local,
            statut: 'REJETE', code: e.code, message: e.message });
        } else if (estDoublon(e)) {
          resultats.push({ type: 'action', uuid_local: brut && brut.uuid_local,
            statut: 'REJETE_DOUBLON', message: 'Action déjà synchronisée.' });
        } else { throw e; }
      }
    }

    const rejetes = resultats.filter((x) => x.statut === 'REJETE').length;
    res.status(rejetes ? 207 : 200).json({
      resultats,
      resume: {
        total: resultats.length,
        synchronises: resultats.filter((x) => x.statut === 'SYNCHRONISE').length,
        doublons: resultats.filter((x) => x.statut === 'REJETE_DOUBLON').length,
        rejetes
      }
    });
  } catch (e) { next(e); }
});

/* ========================================================================
 *  11. PILOTAGE : PAR 30/90 et tableau de bord crédit
 * ===================================================================== */
r.get('/credit/par', requireRole(...AGENT), habilit('credit.par.read'), async (req, res, next) => {
  try {
    const out = await tenantTransaction(req, async (c) => {
      const rows = (await c.query(
        `SELECT d.id, d.reference, d.classe_creance, d.jours_retard,
                d.solde_capital_cents AS encours_cents, d.provision_cents,
                cl.full_name, cl.code_client, pc.libelle AS produit
           FROM dossiers_credit d
           JOIN client cl ON cl.id=d.client_id
           JOIN produits_credit pc ON pc.id=d.produit_id
          WHERE d.imf_id=$1 AND d.statut IN ('DECAISSE','CLOTURE_SOLDE')`,
        [req.dbImfId])).rows.map((x) => ({ ...x,
          encours_cents: Number(x.encours_cents), provision_cents: Number(x.provision_cents) }));
      const enCours = rows.filter((x) => Number(x.encours_cents) > 0);
      const global = calculerPar(enCours);
      const parProduit = {};
      for (const x of enCours) {
        const k = x.produit || '—';
        parProduit[k] = parProduit[k] || { encours_cents: 0, par30_cents: 0, par90_cents: 0 };
        parProduit[k].encours_cents += x.encours_cents;
        if (Number(x.jours_retard) >= 30) parProduit[k].par30_cents += x.encours_cents;
        if (Number(x.jours_retard) >= 90) parProduit[k].par90_cents += x.encours_cents;
      }
      return { global, par_produit: parProduit,
        top_impayes: enCours.filter((x) => Number(x.jours_retard) > 0)
          .sort((a, b) => b.jours_retard - a.jours_retard).slice(0, 10) };
    });
    res.json({ ...out, definitions: {
      par30: 'part de l’encours dont une échéance a plus de 30 jours de retard',
      par90: 'part de l’encours dont une échéance a plus de 90 jours de retard',
      encours: 'capital restant dû (hors intérêts et pénalités)'
    } });
  } catch (e) { next(e); }
});

r.get('/credit/tableau-bord', requireRole(...AGENT), habilit('credit.par.read', 'credit.dossier.monter'),
  async (req, res, next) => {
  try {
    const out = await tenantTransaction(req, async (c) => {
      const s = (await c.query(
        `SELECT
           COUNT(*) FILTER (WHERE statut='EN_COMITE')::int AS en_comite,
           COUNT(*) FILTER (WHERE statut='APPROUVE')::int AS a_decaisser,
           COUNT(*) FILTER (WHERE statut='DECAISSE')::int AS decaisses,
           COUNT(*) FILTER (WHERE statut='DECAISSE' AND jours_retard > 0)::int AS en_retard,
           COALESCE(SUM(solde_capital_cents) FILTER (WHERE statut='DECAISSE'),0)::bigint AS encours_cents,
           COALESCE(SUM(provision_cents) FILTER (WHERE statut='DECAISSE'),0)::bigint AS provisions_cents
         FROM dossiers_credit WHERE imf_id=$1`, [req.dbImfId])).rows[0];
      const mois = (await c.query(
        `SELECT COALESCE(SUM(montant_cents),0)::bigint AS decaisse_cents,
                COUNT(*)::int AS nb
           FROM decaissements
          WHERE imf_id=$1 AND date_decaissement >= date_trunc('month', now())`,
        [req.dbImfId])).rows[0];
      const encaisse = (await c.query(
        `SELECT COALESCE(SUM(montant_cents),0)::bigint AS encaisse_cents,
                COALESCE(SUM(capital_cents),0)::bigint AS capital_cents
           FROM remboursements_credit
          WHERE imf_id=$1 AND created_at >= date_trunc('month', now())`,
        [req.dbImfId])).rows[0];
      const echeancesSemaine = (await c.query(
        `SELECT COUNT(*)::int AS nb, COALESCE(SUM(montant_echeance_cents),0)::bigint AS montant_cents
           FROM echeanciers_credit
          WHERE imf_id=$1 AND statut IN ('A_PAYER','PARTIEL','EN_RETARD')
            AND date_echeance BETWEEN CURRENT_DATE AND CURRENT_DATE + 7`,
        [req.dbImfId])).rows[0];
      return { dossiers: s, mois_en_cours: { ...mois, ...encaisse }, a_encaisser_7_jours: echeancesSemaine };
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ========================================================================
 *  12. SCORING ALTERNATIF (vague 40)
 * ---------------------------------------------------------------------
 * Monté ici pour rester sous /api/v1/credit/… : grilles, recalcul, avis BIC.
 * Le calcul est aussi déclenché par la soumission au comité (voir §3) et
 * par la décision du comité (voir §5), sans jamais bloquer la transition :
 * une erreur de scoring est signalée mais n'empêche pas l'agent d'avancer.
 * ===================================================================== */
r.use(scoringRouter);

export default r;
