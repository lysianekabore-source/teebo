// ===========================================================================
// teebo — VAGUE 41 : ROUTES DE CONFORMITE (KYC / KYB / VISITES / CRIBLAGE)
// ---------------------------------------------------------------------------
// Préfixe : /api/v1/conformite/…
//
//   Tableau de bord  GET  /conformite/tableau-bord
//   Paramètres       GET  /conformite/parametres
//                    PUT  /conformite/parametres
//   Listes           GET  /conformite/listes
//                    POST /conformite/listes            (import / ajout)
//   Criblage         POST /conformite/criblage          (nom -> correspondances)
//
//   Dossier client   GET  /conformite/clients/:id/fiche360
//                    PUT  /conformite/clients/:id/dossier     (identité + domicile + selfie)
//                    POST /conformite/clients/:id/evaluer     (évaluation KYC historisée)
//                    POST /conformite/clients/:id/ppe         (déclaration PPE)
//                    POST /conformite/clients/:id/approuver   (2e approbation PPE : DG)
//                    GET  /conformite/clients/:id/restrictions
//
//   Entreprises      GET  /conformite/entreprises
//                    POST /conformite/entreprises
//                    GET  /conformite/entreprises/:id
//                    PUT  /conformite/entreprises/:id
//                    POST /conformite/entreprises/:id/beneficiaires
//                    POST /conformite/entreprises/:id/mandataires
//                    POST /conformite/entreprises/:id/evaluer
//
//   Visites          POST /conformite/visites            (synchronisation hors-ligne, idempotente)
//                    GET  /conformite/clients/:id/visites
//
//   Contrôles        POST /conformite/controle-quotidien  (tâche du jour : pièces/revues échues)
//                    POST /conformite/decaissement           (feu vert avant décaissement)
//
// Invariants : imf_id vient TOUJOURS du jeton ; aucune lecture d'une autre
// IMF ; un GET ne modifie rien ; une visite hors-ligne n'est jamais comptée
// deux fois (UUID généré par l'appareil) ; une PPE exige DEUX approbations
// différentes (Responsable Conformité puis Direction Générale).
// ===========================================================================
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { habilit } from '../rbac_strict.js';
import { tenantTransaction } from '../tenant.js';
import { auditEvent } from '../audit.js';
import {
  ConformiteError, PARAMS_DEFAUT, controlerKyc, controlerKyb, controlerVisite,
  controlerDecaissement, criblerNom, syntheseCriblage, dossiersAEcheance,
  syntheseConformite, normaliserNom, ajouterMois, joursEntre, detentionPct,
  intervalleRevueMois, niveauRisqueEffectif
} from '../conformite_engine.js';

const r = Router();

const LECTURE = ['staff', 'agency', 'service', 'department', 'caissier', 'admin_imf', 'direction'];
const SAISIE = ['staff', 'agency', 'service', 'department', 'admin_imf', 'direction'];
const VALIDATION = ['admin_imf', 'direction', 'department', 'service'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const estUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const nombre = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const texte = (v) => (v == null ? '' : String(v).trim());

function echec(res, e) {
  if (e instanceof ConformiteError) {
    return res.status(e.status || 422).json({ error: e.code, message: e.message, detail: e.detail || null });
  }
  throw e;
}

/** Paramètres de conformité de l'IMF (avec repli sur le référentiel livré). */
async function parametres(c, imfId) {
  const row = (await c.query(
    'SELECT * FROM conformite_parametres WHERE imf_id=$1', [imfId])).rows[0];
  if (!row) return { ...PARAMS_DEFAUT };
  const out = { ...PARAMS_DEFAUT };
  for (const k of Object.keys(PARAMS_DEFAUT)) {
    if (row[k] != null && k !== 'seuil_decaissement_visite_cents') out[k] = Number(row[k]);
  }
  // Le seuil monétaire est un BIGINT : on le lit tel quel.
  if (row.seuil_decaissement_visite_cents != null) {
    out.seuil_decaissement_visite_cents = Number(row.seuil_decaissement_visite_cents);
  }
  return out;
}

/** Chargement des listes actives (cache court pour ne pas relire à chaque nom). */
async function listesActives(c) {
  return (await c.query(
    `SELECT id, source, type_liste, nom_complet, alias_json, date_naissance, actif
       FROM listes_sanctions_ppe WHERE actif`)).rows;
}

/**
 * Crible un nom et HISTORISE le résultat (client, bénéficiaire ou mandataire).
 * Renvoie les correspondances et la synthèse.
 */
async function criblerEtEnregistrer(c, imfId, sujet, nom, dateN, listes) {
  const correspondances = criblerNom(nom, listes, { date_naissance: dateN });
  const synthese = syntheseCriblage(correspondances);
  for (const cor of correspondances) {
    await c.query(
      `INSERT INTO kyc_criblage_resultats
         (imf_id, tenant_id, client_id, entite_id, sujet_type, sujet_id, sujet_nom,
          liste_id, liste_source, liste_type, score_similarite, verdict)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [imfId, sujet.client_id || null, sujet.entite_id || null, sujet.sujet_type,
       sujet.sujet_id || null, nom, cor.liste_id, cor.source, cor.type_liste,
       cor.score, cor.verdict]);
  }
  return { correspondances, synthese };
}

/* ========================================================================
 * PARAMÈTRES ET TABLEAU DE BORD
 * ===================================================================== */
r.get('/conformite/parametres', requireRole(...LECTURE), habilit('conformite.kyc.read', 'conformite.parametrer'),
  async (req, res, next) => {
    try {
      const out = await tenantTransaction(req, (c) => parametres(c, req.dbImfId));
      res.json({ parametres: out, referentiel: PARAMS_DEFAUT });
    } catch (e) { next(e); }
  });

r.put('/conformite/parametres', requireRole(...VALIDATION), habilit('conformite.parametrer'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const seuil = nombre(b.seuil_decaissement_visite_cents, -1);
      if (seuil < 0) throw new ConformiteError('seuil_invalide', 'Le seuil de décaissement doit être un montant positif (en centimes).');
      if (nombre(b.validite_visite_jours, 30) < 1 || nombre(b.validite_visite_jours, 30) > 180) {
        throw new ConformiteError('validite_invalide', 'La validité d’une visite doit être comprise entre 1 et 180 jours.');
      }
      if (nombre(b.precision_gps_max_m, 30) < 5 || nombre(b.precision_gps_max_m, 30) > 200) {
        throw new ConformiteError('precision_invalide', 'La précision GPS maximale doit être comprise entre 5 et 200 mètres.');
      }
      if (nombre(b.seuil_criblage, 82) < 50 || nombre(b.seuil_criblage, 82) > 100) {
        throw new ConformiteError('criblage_invalide', 'Le seuil de criblage doit être compris entre 50 et 100.');
      }
      if (nombre(b.seuil_detention_be_pct, 25) < 5 || nombre(b.seuil_detention_be_pct, 25) > 50) {
        throw new ConformiteError('detention_invalide', 'Le seuil de détention des bénéficiaires effectifs doit être compris entre 5 et 50 %.');
      }
      const p = {
        seuil_decaissement_visite_cents: Math.round(seuil),
        validite_visite_jours: Math.round(nombre(b.validite_visite_jours, 30)),
        precision_gps_max_m: Math.round(nombre(b.precision_gps_max_m, 30)),
        distance_max_enrolement_m: Math.round(nombre(b.distance_max_enrolement_m, 100)),
        seuil_criblage: nombre(b.seuil_criblage, 82),
        seuil_detention_be_pct: nombre(b.seuil_detention_be_pct, 25),
        revue_risque_eleve_mois: Math.round(nombre(b.revue_risque_eleve_mois, 12)),
        revue_risque_moyen_mois: Math.round(nombre(b.revue_risque_moyen_mois, 36)),
        revue_risque_faible_mois: Math.round(nombre(b.revue_risque_faible_mois, 60))
      };
      if (!(p.revue_risque_eleve_mois <= p.revue_risque_moyen_mois && p.revue_risque_moyen_mois <= p.revue_risque_faible_mois)) {
        throw new ConformiteError('revues_incoherentes', 'Les échéances de révision doivent croître : risque élevé ≤ moyen ≤ faible.');
      }
      const row = await tenantTransaction(req, async (c) => {
        await c.query(
          `INSERT INTO conformite_parametres
             (imf_id, tenant_id, seuil_decaissement_visite_cents, validite_visite_jours,
              precision_gps_max_m, distance_max_enrolement_m, seuil_criblage,
              seuil_detention_be_pct, revue_risque_eleve_mois, revue_risque_moyen_mois,
              revue_risque_faible_mois, maj_par, maj_le)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
           ON CONFLICT (imf_id) DO UPDATE SET
             seuil_decaissement_visite_cents=EXCLUDED.seuil_decaissement_visite_cents,
             validite_visite_jours=EXCLUDED.validite_visite_jours,
             precision_gps_max_m=EXCLUDED.precision_gps_max_m,
             distance_max_enrolement_m=EXCLUDED.distance_max_enrolement_m,
             seuil_criblage=EXCLUDED.seuil_criblage,
             seuil_detention_be_pct=EXCLUDED.seuil_detention_be_pct,
             revue_risque_eleve_mois=EXCLUDED.revue_risque_eleve_mois,
             revue_risque_moyen_mois=EXCLUDED.revue_risque_moyen_mois,
             revue_risque_faible_mois=EXCLUDED.revue_risque_faible_mois,
             maj_par=EXCLUDED.maj_par, maj_le=now()
           RETURNING *`,
          [req.dbImfId, p.seuil_decaissement_visite_cents, p.validite_visite_jours,
           p.precision_gps_max_m, p.distance_max_enrolement_m, p.seuil_criblage,
           p.seuil_detention_be_pct, p.revue_risque_eleve_mois, p.revue_risque_moyen_mois,
           p.revue_risque_faible_mois, req.user.id]);
        await auditEvent(req.user, { action: 'conformite.parametres', entity: 'conformite_parametres', detail: p });
        return (await c.query('SELECT * FROM conformite_parametres WHERE imf_id=$1', [req.dbImfId])).rows[0];
      });
      res.json({ ok: true, parametres: row, note: 'Seuils de conformité enregistrés.' });
    } catch (e) { try { echec(res, e); } catch (x) { next(x); } }
  });

r.get('/conformite/tableau-bord', requireRole(...LECTURE), habilit('conformite.kyc.read'),
  async (req, res, next) => {
    try {
      const out = await tenantTransaction(req, async (c) => {
        const cnt = async (sql, params = []) => nombre((await c.query(sql, params)).rows[0].n, 0);
        const imf = req.dbImfId;
        const compteurs = {
          total_clients: await cnt('SELECT COUNT(*)::int AS n FROM client WHERE imf_id=$1', [imf]),
          clients_conformes: await cnt("SELECT COUNT(*)::int AS n FROM client WHERE imf_id=$1 AND statut_kyc='ACTIF_CONFORME'", [imf]),
          clients_a_completer: await cnt("SELECT COUNT(*)::int AS n FROM client WHERE imf_id=$1 AND statut_kyc='A_COMPLETER'", [imf]),
          clients_a_revoir: await cnt("SELECT COUNT(*)::int AS n FROM client WHERE imf_id=$1 AND statut_kyc='A_REVOIR'", [imf]),
          clients_expires: await cnt("SELECT COUNT(*)::int AS n FROM client WHERE imf_id=$1 AND statut_kyc='EXPIRE'", [imf]),
          clients_ppe: await cnt('SELECT COUNT(*)::int AS n FROM client WHERE imf_id=$1 AND ppe', [imf]),
          entites_kyb: await cnt('SELECT COUNT(*)::int AS n FROM kyb_entites_morales WHERE imf_id=$1', [imf]),
          entites_kyb_conformes: await cnt("SELECT COUNT(*)::int AS n FROM kyb_entites_morales WHERE imf_id=$1 AND statut_kyb='ACTIF_CONFORME'", [imf]),
          visites_30j: await cnt("SELECT COUNT(*)::int AS n FROM visites_terrain_kyc WHERE imf_id=$1 AND visite_le >= now() - interval '30 days'", [imf]),
          visites_non_synchronisees: await cnt('SELECT COUNT(*)::int AS n FROM visites_terrain_kyc WHERE imf_id=$1 AND synchronise_le IS NULL', [imf]),
          restrictions_actives: await cnt('SELECT COUNT(*)::int AS n FROM kyc_restrictions WHERE imf_id=$1 AND levee_le IS NULL', [imf])
        };
        const recentes = (await c.query(
          `SELECT r.id, r.code, r.gravite, r.motif, r.cree_le, c.full_name, c.code_client
             FROM kyc_restrictions r LEFT JOIN client c ON c.id = r.client_id
            WHERE r.imf_id=$1 AND r.levee_le IS NULL
            ORDER BY r.cree_le DESC LIMIT 12`, [imf])).rows;
        const visites = (await c.query(
          `SELECT v.id, v.visite_le, v.statut, v.gps_lat, v.gps_lng, v.distance_m,
                  v.distance_alerte, v.gps_alerte_precision, c.full_name, c.code_client
             FROM visites_terrain_kyc v LEFT JOIN client c ON c.id = v.client_id
            WHERE v.imf_id=$1 ORDER BY v.visite_le DESC LIMIT 200`, [imf])).rows;
        return { ...syntheseConformite(compteurs), restrictions_recentes: recentes, dernieres_visites: visites };
      });
      res.json(out);
    } catch (e) { next(e); }
  });

/* ========================================================================
 * LISTES ET CRIBLAGE
 * ===================================================================== */
r.get('/conformite/listes', requireRole(...LECTURE), habilit('conformite.kyc.read'), async (req, res, next) => {
  try {
    const out = await tenantTransaction(req, async (c) => (await c.query(
      `SELECT id, source, type_liste, reference, nom_complet, date_naissance, pays, fonction, actif, mise_a_jour_le
         FROM listes_sanctions_ppe WHERE actif ORDER BY type_liste, nom_complet LIMIT 500`)).rows);
    const par_type = out.reduce((m, x) => { m[x.type_liste] = (m[x.type_liste] || 0) + 1; return m; }, {});
    res.json({ listes: out, total: out.length, par_type });
  } catch (e) { next(e); }
});

r.post('/conformite/listes', requireRole(...VALIDATION), habilit('conformite.ppe.declarer', 'conformite.parametrer'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const type = b.type_liste === 'PPE' ? 'PPE' : 'SANCTIONS';
      const nom = texte(b.nom_complet);
      if (!nom) throw new ConformiteError('nom_requis', 'Le nom à inscrire sur la liste est obligatoire.');
      if (!texte(b.source)) throw new ConformiteError('source_requise', 'La source de la liste est obligatoire (ONU, UE, BCEAO, PPE nationale…).');
      const row = await tenantTransaction(req, async (c) => {
        const ins = (await c.query(
          `INSERT INTO listes_sanctions_ppe
             (source, reference, type_liste, nom_complet, nom_normalise, alias_json, date_naissance, pays, fonction)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [texte(b.source), texte(b.reference) || null, type, nom, normaliserNom(nom),
           JSON.stringify(Array.isArray(b.alias) ? b.alias : []), b.date_naissance || null,
           texte(b.pays) || null, texte(b.fonction) || null])).rows[0];
        await auditEvent(req.user, { action: 'conformite.liste.ajout', entity: 'listes_sanctions_ppe', entityId: ins.id, detail: { nom, type } });
        return ins;
      });
      res.status(201).json({ ok: true, liste: row, note: 'Entrée ajoutée aux listes de criblage.' });
    } catch (e) { next(e); }
  });

r.post('/conformite/criblage', requireRole(...LECTURE), habilit('conformite.kyc.read', 'conformite.kyc.valider'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const nom = texte(b.nom);
      if (!nom) throw new ConformiteError('nom_requis', 'Indiquez le nom à cribler.');
      const out = await tenantTransaction(req, async (c) => {
        const p = await parametres(c, req.dbImfId);
        const listes = await listesActives(c);
        const correspondances = criblerNom(nom, listes, { date_naissance: b.date_naissance, seuil: p.seuil_criblage });
        return { correspondances, synthese: syntheseCriblage(correspondances), seuil: p.seuil_criblage };
      });
      res.json({ nom, ...out,
        note: out.synthese.verdict === 'CLAIR'
          ? 'Aucune correspondance au-dessus du seuil : dossier clair.'
          : 'Correspondance(s) détectée(s) : à vérifier par le Responsable Conformité avant toute opération.' });
    } catch (e) { next(e); }
  });

/* ========================================================================
 * DOSSIER CLIENT — FICHE 360°
 * ===================================================================== */
r.get('/conformite/clients/:id/fiche360', requireRole(...LECTURE), habilit('conformite.kyc.read'),
  async (req, res, next) => {
    try {
      const fiche = await tenantTransaction(req, async (c) => {
        const cl = (await c.query('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
          [req.params.id, req.dbImfId])).rows[0];
        if (!cl) return null;
        const evals = (await c.query(
          'SELECT * FROM kyc_evaluations WHERE client_id=$1 ORDER BY cree_le DESC LIMIT 20', [cl.id])).rows;
        const visites = (await c.query(
          'SELECT * FROM visites_terrain_kyc WHERE client_id=$1 ORDER BY visite_le DESC LIMIT 50', [cl.id])).rows;
        const criblages = (await c.query(
          'SELECT * FROM kyc_criblage_resultats WHERE client_id=$1 ORDER BY crible_le DESC LIMIT 20', [cl.id])).rows;
        const restrictions = (await c.query(
          'SELECT * FROM kyc_restrictions WHERE client_id=$1 ORDER BY cree_le DESC LIMIT 20', [cl.id])).rows;
        const entites = (await c.query(
          'SELECT id, raison_sociale, rccm, statut_kyb, niveau_risque_lbc FROM kyb_entites_morales WHERE client_id=$1', [cl.id])).rows;
        const p = await parametres(c, req.dbImfId);
        const decaissementDerniereVisite = visites.find((v) => v.statut === 'ACTIF_CONFORME') || null;
        return {
          client: {
            id: cl.id, code_client: cl.code_client, full_name: cl.full_name,
            birth_date: cl.birth_date, lieu_naissance: cl.lieu_naissance,
            nationalite: cl.nationalite, profession: cl.profession,
            secteur_activite: cl.secteur_activite, source_revenus: cl.source_revenus,
            revenu_mensuel_cents: cl.revenu_mensuel_cents == null ? null : Number(cl.revenu_mensuel_cents),
            type_piece: cl.type_piece, id_number: cl.id_number,
            piece_expire_le: cl.piece_expire_le,
            justificatif_domicile_type: cl.justificatif_domicile_type,
            justificatif_domicile_ref: cl.justificatif_domicile_ref,
            selfie_present: !!cl.selfie_data_url, selfie_captured_at: cl.selfie_captured_at,
            gps: cl.gps_lat == null ? null : { lat: Number(cl.gps_lat), lng: Number(cl.gps_lng),
              precision_m: cl.gps_accuracy_m == null ? null : Number(cl.gps_accuracy_m),
              capture_le: cl.gps_captured_at },
            niveau_risque_lbc: cl.niveau_risque_lbc, statut_kyc: cl.statut_kyc,
            ppe: cl.ppe, ppe_fonction: cl.ppe_fonction,
            kyc_score: cl.kyc_score, kyc_valide_le: cl.kyc_valide_le,
            prochaine_revue_le: cl.kyc_prochaine_revue_le
          },
          evaluations: evals,
          visite_derniere: decaissementDerniereVisite,
          visites,
          criblages,
          restrictions: restrictions.map((x) => ({ ...x, active: !x.levee_le })),
          entreprises: entites,
          score_lbcft: {
            score: cl.kyc_score == null ? null : Number(cl.kyc_score),
            niveau: cl.niveau_risque_lbc,
            statut: cl.statut_kyc,
            composite: Math.max(0, Math.min(100, Math.round(
              (nombre(cl.kyc_score, 0) * 0.7) + (cl.niveau_risque_lbc === 'FAIBLE' ? 30 : (cl.niveau_risque_lbc === 'MOYEN' ? 18 : 0))
            )))
          },
          parametres: p,
          risques: [
            { code: 'PPE', actif: cl.ppe === true, libelle: 'Personne politiquement exposée' },
            { code: 'SANCTIONS', actif: criblages.some((x) => x.verdict === 'CONFIRME'), libelle: 'Correspondance sanction confirmée' },
            { code: 'KYC_EXPIRE', actif: cl.statut_kyc === 'EXPIRE', libelle: 'Pièce ou revue échue' },
            { code: 'VISITE', actif: !decaissementDerniereVisite, libelle: 'Aucune visite de terrain conforme' }
          ]
        };
      });
      if (!fiche) return res.status(404).json({ error: 'client_introuvable', message: 'Ce client n’existe pas dans votre institution.' });
      res.json(fiche);
    } catch (e) { next(e); }
  });

/* ========================================================================
 * DOSSIER CLIENT — SAISIE
 * ===================================================================== */
const CHAMPS_DOSSIER = {
  lieu_naissance: 'text', pays_naissance: 'text', nationalite: 'text',
  profession: 'text', secteur_activite: 'text', source_revenus: 'text',
  type_piece: 'text', piece_emise_le: 'date', piece_expire_le: 'date',
  justificatif_domicile_type: 'text', justificatif_domicile_ref: 'text',
  selfie_data_url: 'image', ppe_fonction: 'text'
};

r.put('/conformite/clients/:id/dossier', requireRole(...SAISIE), habilit('conformite.kyc.write'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const out = await tenantTransaction(req, async (c) => {
        const cl = (await c.query('SELECT * FROM client WHERE id=$1 AND imf_id=$2 FOR UPDATE',
          [req.params.id, req.dbImfId])).rows[0];
        if (!cl) throw new ConformiteError('client_introuvable', 'Ce client n’existe pas dans votre institution.', 404);
        const sets = [];
        const vals = [];
        let i = 1;
        for (const [champ, genre] of Object.entries(CHAMPS_DOSSIER)) {
          if (!(champ in b)) continue;
          let v = b[champ];
          if (genre === 'image') {
            if (v && !/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(v))) {
              throw new ConformiteError('selfie_invalide', 'Le selfie doit être une image (photographie prise à l’instant).');
            }
            if (v && String(v).length > 3700000) {
              throw new ConformiteError('selfie_trop_lourd', 'Le selfie dépasse la taille maximale autorisée.');
            }
            sets.push(`${champ}=$${i++}`); vals.push(v || null);
            if (v) { sets.push(`selfie_captured_at=now()`); }
            continue;
          }
          if (genre === 'date') { sets.push(`${champ}=$${i++}`); vals.push(texte(v) || null); continue; }
          sets.push(`${champ}=$${i++}`); vals.push(texte(v) || null);
        }
        // Revenu mensuel éventuel (centimes)
        if ('revenu_mensuel_cents' in b) {
          sets.push(`revenu_mensuel_cents=$${i++}`);
          vals.push(b.revenu_mensuel_cents == null ? null : Math.round(nombre(b.revenu_mensuel_cents)));
        }
        // Position GPS d'enrôlement : uniquement issue du capteur.
        if (b.gps_lat != null || b.gps_lng != null) {
          if (texte(b.gps_source) !== 'CAPTEUR') {
            throw new ConformiteError('gps_manuscrit',
              'La position du domicile doit être relevée par le capteur GPS du téléphone : la saisie manuelle est interdite.');
          }
          const lat = Number(b.gps_lat);
          const lng = Number(b.gps_lng);
          if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
            throw new ConformiteError('gps_invalide', 'Coordonnées GPS invalides.');
          }
          sets.push(`gps_lat=$${i++}`, `gps_lng=$${i++}`, `gps_accuracy_m=$${i++}`, `gps_captured_at=now()`);
          vals.push(lat, lng, b.gps_accuracy_m == null ? null : nombre(b.gps_accuracy_m));
        }
        if (!sets.length) throw new ConformiteError('rien_a_enregistrer', 'Aucune information de conformité à enregistrer.');
        vals.push(cl.id);
        const maj = (await c.query(
          `UPDATE client SET ${sets.join(', ')}, statut_kyc = CASE WHEN statut_kyc='EXPIRE' THEN statut_kyc ELSE 'A_COMPLETER' END
            WHERE id=$${i} RETURNING *`, vals)).rows[0];
        await auditEvent(req.user, { action: 'conformite.dossier.maj', entity: 'client', entityId: cl.id,
          detail: Object.keys(b) });
        return maj;
      });
      res.json({ ok: true, client: { id: out.id, statut_kyc: out.statut_kyc },
        note: 'Informations de conformité enregistrées. Lancez l’évaluation pour connaître les pièces manquantes.' });
    } catch (e) { next(e); }
  });

/* ========================================================================
 * ÉVALUATION KYC (historisée, jamais écrasée)
 * ===================================================================== */
r.post('/conformite/clients/:id/evaluer', requireRole(...SAISIE), habilit('conformite.kyc.write', 'conformite.kyc.valider'),
  async (req, res, next) => {
    try {
      const out = await tenantTransaction(req, async (c) => {
        const danalyse = req.body && req.body.decision === 'VALIDER';
        const cl = (await c.query('SELECT * FROM client WHERE id=$1 AND imf_id=$2 FOR UPDATE',
          [req.params.id, req.dbImfId])).rows[0];
        if (!cl) throw new ConformiteError('client_introuvable', 'Ce client n’existe pas dans votre institution.', 404);
        const p = await parametres(c, req.dbImfId);
        const listes = await listesActives(c);
        const criblage = await criblerEtEnregistrer(c, req.dbImfId,
          { client_id: cl.id, sujet_type: 'CLIENT' }, cl.full_name, cl.birth_date, listes);
        const visiteConforme = (await c.query(
          `SELECT 1 FROM visites_terrain_kyc WHERE client_id=$1 AND statut='ACTIF_CONFORME'
             AND visite_le >= now() - ($2 || ' days')::interval LIMIT 1`,
          [cl.id, String(p.validite_visite_jours)])).rows.length > 0;
        const controle = controlerKyc({
          full_name: cl.full_name, birth_date: cl.birth_date,
          lieu_naissance: cl.lieu_naissance, nationalite: cl.nationalite,
          type_piece: cl.type_piece, id_number: cl.id_number,
          piece_expire_le: cl.piece_expire_le, profession: cl.profession,
          source_revenus: cl.source_revenus,
          justificatif_domicile_type: cl.justificatif_domicile_type,
          visite_gps_conforme: visiteConforme,
          selfie_data_url: cl.selfie_data_url, selfie_captured_at: cl.selfie_captured_at,
          gps_lat: cl.gps_lat, gps_lng: cl.gps_lng, gps_accuracy_m: cl.gps_accuracy_m,
          niveau_risque_lbc: cl.niveau_risque_lbc, ppe: cl.ppe, ppe_fonction: cl.ppe_fonction,
          revenu_mensuel_cents: cl.revenu_mensuel_cents == null ? 0 : Number(cl.revenu_mensuel_cents),
          double_approbation: !!cl.ppe_valide_par
        }, { params: p, criblage: criblage.correspondances, criblage_effectue: true });

        // Statut retenu : une validation volontaire ne remplace pas un manque.
        const statut = controle.complet ? 'ACTIF_CONFORME' : controle.statut;
        const evalRow = (await c.query(
          `INSERT INTO kyc_evaluations
             (imf_id, tenant_id, client_id, score_kyc, niveau_risque_lbc, statut, controle_json,
              revue_intervalle_mois, prochaine_revue_le, decide_par, valide_par, valide_le, commentaire)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [req.dbImfId, cl.id, controle.score_kyc, controle.niveau_risque_lbc, statut,
           JSON.stringify({ bloquants: controle.bloquants, alertes: controle.alertes,
             criblage: controle.criblage, visite_gps_conforme: visiteConforme }),
           controle.revue_intervalle_mois, controle.prochaine_revue_le,
           danalyse ? 'AGENT' : 'SYSTEME',
           danalyse && controle.complet ? req.user.id : null,
           danalyse && controle.complet ? new Date() : null,
           texte(req.body && req.body.commentaire) || null])).rows[0];

        await c.query(
          `UPDATE client SET statut_kyc=$2, niveau_risque_lbc=$3, kyc_score=$4,
                  kyc_prochaine_revue_le=$5, kyc_valide_le=$6
            WHERE id=$1`,
          [cl.id, statut, controle.niveau_risque_lbc, controle.score_kyc,
           controle.prochaine_revue_le, danalyse && controle.complet ? new Date() : null]);

        // Restrictions : pièce expirée / revue échue => ALERTE_KYC_EXPIRE.
        for (const d of dossiersAEcheance([{ id: cl.id, piece_expire_le: cl.piece_expire_le,
          kyc_prochaine_revue_le: controle.prochaine_revue_le }])) {
          await c.query(
            `INSERT INTO kyc_restrictions (imf_id, tenant_id, client_id, code, gravite, motif, detail_json)
             VALUES ($1,$1,$2,$3,$4,$5,$6)
             ON CONFLICT DO NOTHING`,
            [req.dbImfId, cl.id, d.code, d.gravite, d.motif, JSON.stringify({ source: 'evaluation' })]);
        }
        if (controle.ppe && !cl.ppe_valide_par && !cl.ppe) {
          await c.query(
            `INSERT INTO kyc_restrictions (imf_id, tenant_id, client_id, code, gravite, motif, detail_json)
             VALUES ($1,$1,$2,$3,'ALERTE',$4,$5) ON CONFLICT DO NOTHING`,
            [req.dbImfId, cl.id, 'ALERTE_PPE_A_VALIDER',
             'Correspondance PPE détectée : la qualité de PPE doit être établie et approuvée par la Direction Générale.',
             JSON.stringify({ score: controle.criblage.meilleur_score })]);
        }
        await auditEvent(req.user, { action: 'conformite.kyc.evaluer', entity: 'client', entityId: cl.id,
          detail: { score: controle.score_kyc, statut, niveau: controle.niveau_risque_lbc } });
        return { evaluation: evalRow, controle };
      });
      res.json({
        ok: true,
        evaluation: out.evaluation,
        score_kyc: out.controle.score_kyc,
        niveau_risque_lbc: out.controle.niveau_risque_lbc,
        statut: out.evaluation.statut,
        prochaine_revue_le: out.controle.prochaine_revue_le,
        bloquants: out.controle.bloquants,
        alertes: out.controle.alertes,
        note: out.controle.complet
          ? (out.controle.ppe
            ? 'Dossier complet. Client PPE : la mise en service attend la double approbation (Conformité puis Direction Générale).'
            : 'Dossier complet et à jour.')
          : out.controle.bloquants.length + ' point(s) bloquant(s) à corriger : ' +
            out.controle.bloquants.map((x) => x.message).join(' ')
      });
    } catch (e) { next(e); }
  });

/* ========================================================================
 * PPE : DÉCLARATION ET DOUBLE APPROBATION
 * ===================================================================== */
r.post('/conformite/clients/:id/ppe', requireRole(...VALIDATION), habilit('conformite.ppe.declarer'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const fonction = texte(b.fonction);
      if (!fonction) throw new ConformiteError('fonction_requise', 'Indiquez la fonction qui rend le client politiquement exposé.');
      const row = await tenantTransaction(req, async (c) => {
        const cl = (await c.query('SELECT id FROM client WHERE id=$1 AND imf_id=$2', [req.params.id, req.dbImfId])).rows[0];
        if (!cl) throw new ConformiteError('client_introuvable', 'Ce client n’existe pas dans votre institution.', 404);
        const maj = (await c.query(
          `UPDATE client SET ppe=true, ppe_fonction=$2, niveau_risque_lbc='ELEVE',
                  kyc_prochaine_revue_le = $3
            WHERE id=$1 RETURNING id, ppe, ppe_fonction, niveau_risque_lbc, kyc_prochaine_revue_le`,
          [cl.id, fonction, ajouterMois(new Date(), 12)])).rows[0];
        await c.query('DELETE FROM kyc_restrictions WHERE client_id=$1 AND code=$2 AND levee_le IS NULL AND levee_par IS NULL',
          [cl.id, 'ALERTE_PPE_A_VALIDER']);
        await auditEvent(req.user, { action: 'conformite.ppe.declarer', entity: 'client', entityId: cl.id, detail: { fonction } });
        return maj;
      });
      res.json({ ok: true, client: row,
        note: 'PPE déclarée : risque ÉLEVÉ, révision annuelle, double approbation obligatoire (Responsable Conformité puis Direction Générale).' });
    } catch (e) { next(e); }
  });

r.post('/conformite/clients/:id/approuver', requireRole(...VALIDATION), habilit('conformite.ppe.declarer', 'conformite.kyc.valider'),
  async (req, res, next) => {
    try {
      const out = await tenantTransaction(req, async (c) => {
        const cl = (await c.query('SELECT * FROM client WHERE id=$1 AND imf_id=$2 FOR UPDATE',
          [req.params.id, req.dbImfId])).rows[0];
        if (!cl) throw new ConformiteError('client_introuvable', 'Ce client n’existe pas dans votre institution.', 404);
        if (!cl.ppe) throw new ConformiteError('pas_ppe', 'Ce client n’est pas déclaré comme PPE : aucune double approbation n’est nécessaire.');
        const etape = texte(req.body && req.body.etape || (cl.ppe_valide_par ? 'DG' : 'CONFORMITE')).toUpperCase();
        if (etape === 'CONFORMITE') {
          if (cl.ppe_valide_par) throw new ConformiteError('deja_approuve', 'La première approbation (Responsable Conformité) est déjà enregistrée.', 409);
          const maj = (await c.query(
            'UPDATE client SET ppe_valide_par=$2, ppe_valide_le=now() WHERE id=$1 RETURNING id, ppe_valide_par, ppe_valide_le',
            [cl.id, req.user.id])).rows[0];
          await auditEvent(req.user, { action: 'conformite.ppe.approuver.conformite', entity: 'client', entityId: cl.id });
          return { etape: 'CONFORMITE', client: maj, reste: 'Direction Générale',
            note: 'Première approbation enregistrée. La Direction Générale doit encore approuver.' };
        }
        if (!cl.ppe_valide_par) {
          throw new ConformiteError('ordre_approbation', 'La Direction Générale ne peut approuver qu’après le Responsable Conformité.');
        }
        if (String(cl.ppe_valide_par) === String(req.user.id)) {
          throw new ConformiteError('auto_approbation',
            'Séparation des tâches : une même personne ne peut pas signer les deux approbations.', 403);
        }
        if (cl.ppe_approuve_dg_par) {
          throw new ConformiteError('deja_approuve', 'La double approbation est déjà complète.', 409);
        }
        const maj = (await c.query(
          `UPDATE client SET ppe_approuve_dg_par=$2, ppe_approuve_dg_le=now(),
                  statut_kyc = CASE WHEN statut_kyc='A_COMPLETER' THEN statut_kyc ELSE 'ACTIF_CONFORME' END
            WHERE id=$1 RETURNING id, statut_kyc`,
          [cl.id, req.user.id])).rows[0];
        await c.query(`UPDATE kyc_restrictions SET levee_le=now(), levee_par=$2, motif_levee=$3
                        WHERE client_id=$1 AND code=$4 AND levee_le IS NULL`,
          [cl.id, req.user.id, 'Double approbation PPE complète', 'ALERTE_PPE_A_VALIDER']);
        await auditEvent(req.user, { action: 'conformite.ppe.approuver.dg', entity: 'client', entityId: cl.id });
        return { etape: 'DG', client: maj, reste: null, note: 'Double approbation complète : la mise en service est autorisée.' };
      });
      res.json({ ok: true, ...out });
    } catch (e) { next(e); }
  });

r.get('/conformite/clients/:id/restrictions', requireRole(...LECTURE), habilit('conformite.kyc.read'),
  async (req, res, next) => {
    try {
      const out = await tenantTransaction(req, async (c) => {
        const cl = (await c.query('SELECT id FROM client WHERE id=$1 AND imf_id=$2', [req.params.id, req.dbImfId])).rows[0];
        if (!cl) throw new ConformiteError('client_introuvable', 'Ce client n’existe pas dans votre institution.', 404);
        return (await c.query(
          'SELECT * FROM kyc_restrictions WHERE client_id=$1 ORDER BY cree_le DESC', [cl.id])).rows;
      });
      res.json({ restrictions: out, actives: out.filter((x) => !x.levee_le) });
    } catch (e) { next(e); }
  });

/* ========================================================================
 * ENTREPRISES (KYB)
 * ===================================================================== */
function entitePublique(e) {
  return {
    id: e.id, raison_sociale: e.raison_sociale, forme_juridique: e.forme_juridique,
    rccm: e.rccm, compte_contribuable: e.compte_contribuable, client_id: e.client_id,
    siege_adresse: e.siege_adresse,
    siege_gps: e.siege_gps_lat == null ? null : { lat: Number(e.siege_gps_lat), lng: Number(e.siege_gps_lng),
      precision_m: e.siege_gps_precision_m == null ? null : Number(e.siege_gps_precision_m) },
    activite_principale: e.activite_principale,
    statut_kyb: e.statut_kyb, niveau_risque_lbc: e.niveau_risque_lbc,
    score_kyb: Number(e.score_kyb || 0), prochaine_revue_le: e.prochaine_revue_le,
    cree_le: e.cree_le, valide_le: e.valide_le
  };
}

r.get('/conformite/entreprises', requireRole(...LECTURE), habilit('conformite.kyc.read'),
  async (req, res, next) => {
    try {
      const out = await tenantTransaction(req, async (c) => (await c.query(
        `SELECT e.*, (SELECT COUNT(*)::int FROM kyb_beneficiaires_effectifs b WHERE b.entite_id=e.id) AS nb_be,
                (SELECT COUNT(*)::int FROM kyb_mandataires_signataires m WHERE m.entite_id=e.id) AS nb_mandataires
           FROM kyb_entites_morales e WHERE e.imf_id=$1 ORDER BY e.raison_sociale`, [req.dbImfId])).rows);
      res.json({ entreprises: out.map((e) => ({ ...entitePublique(e), nb_be: e.nb_be, nb_mandataires: e.nb_mandataires })) });
    } catch (e) { next(e); }
  });

r.post('/conformite/entreprises', requireRole(...SAISIE), habilit('conformite.kyc.write'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!texte(b.raison_sociale)) throw new ConformiteError('raison_sociale_requise', 'La raison sociale est obligatoire.');
      if (b.siege_gps_lat != null && texte(b.gps_source) !== 'CAPTEUR') {
        throw new ConformiteError('gps_manuscrit', 'Les coordonnées du siège doivent venir du capteur GPS : saisie manuelle interdite.');
      }
      const row = await tenantTransaction(req, async (c) => {
        if (b.client_id) {
          const cl = (await c.query('SELECT id FROM client WHERE id=$1 AND imf_id=$2', [b.client_id, req.dbImfId])).rows[0];
          if (!cl) throw new ConformiteError('client_introuvable', 'Le client entreprise indiqué n’existe pas dans votre institution.', 404);
        }
        const ins = (await c.query(
          `INSERT INTO kyb_entites_morales
             (imf_id, tenant_id, client_id, raison_sociale, forme_juridique, rccm, compte_contribuable,
              date_immatriculation, pays_immatriculation, siege_adresse, siege_gps_lat, siege_gps_lng,
              siege_gps_precision_m, siege_gps_le, activite_principale, capital_social_cents,
              chiffre_affaires_cents, pays_operation, cree_par)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7,COALESCE($8,'CI'),$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17,'CI'),$18)
           RETURNING *`,
          [req.dbImfId, b.client_id || null, texte(b.raison_sociale), texte(b.forme_juridique) || null,
           texte(b.rccm) || null, texte(b.compte_contribuable) || null, b.date_immatriculation || null,
           texte(b.pays_immatriculation) || null, texte(b.siege_adresse) || null,
           b.siege_gps_lat == null ? null : Number(b.siege_gps_lat),
           b.siege_gps_lng == null ? null : Number(b.siege_gps_lng),
           b.siege_gps_precision_m == null ? null : nombre(b.siege_gps_precision_m),
           b.siege_gps_lat == null ? null : new Date(),
           texte(b.activite_principale) || null,
           b.capital_social_cents == null ? null : Math.round(nombre(b.capital_social_cents)),
           b.chiffre_affaires_cents == null ? null : Math.round(nombre(b.chiffre_affaires_cents)),
           texte(b.pays_operation) || null, req.user.id])).rows[0];
        await auditEvent(req.user, { action: 'conformite.kyb.creer', entity: 'kyb_entites_morales', entityId: ins.id });
        return ins;
      });
      res.status(201).json({ ok: true, entreprise: entitePublique(row),
        note: 'Entreprise enregistrée. Ajoutez les bénéficiaires effectifs (> 25 %) et les mandataires signataires, puis lancez l’évaluation.' });
    } catch (e) { next(e); }
  });

r.get('/conformite/entreprises/:id', requireRole(...LECTURE), habilit('conformite.kyc.read'),
  async (req, res, next) => {
    try {
      const out = await tenantTransaction(req, async (c) => {
        const e = (await c.query('SELECT * FROM kyb_entites_morales WHERE id=$1 AND imf_id=$2',
          [req.params.id, req.dbImfId])).rows[0];
        if (!e) return null;
        const bes = (await c.query(
          'SELECT * FROM kyb_beneficiaires_effectifs WHERE entite_id=$1 ORDER BY detention_pct DESC', [e.id])).rows;
        const mands = (await c.query(
          'SELECT * FROM kyb_mandataires_signataires WHERE entite_id=$1 ORDER BY cree_le', [e.id])).rows;
        const visites = (await c.query(
          'SELECT * FROM visites_terrain_kyc WHERE entite_id=$1 ORDER BY visite_le DESC LIMIT 30', [e.id])).rows;
        const p = await parametres(c, req.dbImfId);
        return { ...entitePublique(e), beneficiaires: bes, mandataires: mands, visites, parametres: p,
          organigramme: {
            racine: { id: e.id, nom: e.raison_sociale, type: 'ENTREPRISE' },
            enfants: bes.filter((b) => detentionPct(b.detention_pct) > p.seuil_detention_be_pct)
              .map((b) => ({ id: b.id, nom: b.nom_complet, type: 'BENEFICIAIRE_EFFECTIF',
                pct: detentionPct(b.detention_pct), ppe: b.est_ppe, pieces: b.piece_valide })),
            mandataires: mands.map((m) => ({ id: m.id, nom: m.nom_complet, type: 'MANDATAIRE',
              fonction: m.fonction, ppe: m.est_ppe, pieces: m.piece_valide }))
          } };
      });
      if (!out) return res.status(404).json({ error: 'entreprise_introuvable', message: 'Cette entreprise n’existe pas dans votre institution.' });
      res.json(out);
    } catch (e) { next(e); }
  });

r.put('/conformite/entreprises/:id', requireRole(...SAISIE), habilit('conformite.kyc.write'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const row = await tenantTransaction(req, async (c) => {
        const e = (await c.query('SELECT * FROM kyb_entites_morales WHERE id=$1 AND imf_id=$2 FOR UPDATE',
          [req.params.id, req.dbImfId])).rows[0];
        if (!e) throw new ConformiteError('entreprise_introuvable', 'Cette entreprise n’existe pas dans votre institution.', 404);
        if (b.siege_gps_lat != null && texte(b.gps_source) !== 'CAPTEUR') {
          throw new ConformiteError('gps_manuscrit', 'Les coordonnées du siège doivent venir du capteur GPS : saisie manuelle interdite.');
        }
        const maj = (await c.query(
          `UPDATE kyb_entites_morales SET
             raison_sociale=COALESCE($3, raison_sociale), forme_juridique=COALESCE($4, forme_juridique),
             rccm=COALESCE($5, rccm), compte_contribuable=COALESCE($6, compte_contribuable),
             siege_adresse=COALESCE($7, siege_adresse),
             siege_gps_lat=COALESCE($8, siege_gps_lat), siege_gps_lng=COALESCE($9, siege_gps_lng),
             activite_principale=COALESCE($10, activite_principale),
             capital_social_cents=COALESCE($11, capital_social_cents),
             chiffre_affaires_cents=COALESCE($12, chiffre_affaires_cents),
             maj_le=now()
           WHERE id=$1 AND imf_id=$2 RETURNING *`,
          [e.id, req.dbImfId, texte(b.raison_sociale) || null, texte(b.forme_juridique) || null,
           texte(b.rccm) || null, texte(b.compte_contribuable) || null, texte(b.siege_adresse) || null,
           b.siege_gps_lat == null ? null : Number(b.siege_gps_lat),
           b.siege_gps_lng == null ? null : Number(b.siege_gps_lng),
           texte(b.activite_principale) || null,
           b.capital_social_cents == null ? null : Math.round(nombre(b.capital_social_cents)),
           b.chiffre_affaires_cents == null ? null : Math.round(nombre(b.chiffre_affaires_cents))])).rows[0];
        await auditEvent(req.user, { action: 'conformite.kyb.maj', entity: 'kyb_entites_morales', entityId: e.id });
        return maj;
      });
      res.json({ ok: true, entreprise: entitePublique(row), note: 'Entreprise mise à jour.' });
    } catch (e) { next(e); }
  });

/** Ajout d'un bénéficiaire effectif, avec criblage immédiat. */
r.post('/conformite/entreprises/:id/beneficiaires', requireRole(...SAISIE), habilit('conformite.kyc.write'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!texte(b.nom_complet)) throw new ConformiteError('nom_requis', 'Le nom du bénéficiaire effectif est obligatoire.');
      const pctRenseigne = detentionPct(b.detention_pct);
      const out = await tenantTransaction(req, async (c) => {
        const e = (await c.query('SELECT * FROM kyb_entites_morales WHERE id=$1 AND imf_id=$2',
          [req.params.id, req.dbImfId])).rows[0];
        if (!e) throw new ConformiteError('entreprise_introuvable', 'Cette entreprise n’existe pas dans votre institution.', 404);
        const p = await parametres(c, req.dbImfId);
        const listes = await listesActives(c);
        const criblage = await criblerEtEnregistrer(c, req.dbImfId,
          { entite_id: e.id, sujet_type: 'BENEFICIAIRE_EFFECTIF' }, b.nom_complet, b.date_naissance, listes);
        const valide = !!texte(b.numero_piece) && !!texte(b.type_piece) && !!b.piece_expire_le &&
          (joursEntre(b.piece_expire_le, new Date()) || 0) >= 0;
        const ins = (await c.query(
          `INSERT INTO kyb_beneficiaires_effectifs
             (imf_id, tenant_id, entite_id, nom_complet, date_naissance, lieu_naissance, nationalite,
              pays_residence, adresse, type_piece, numero_piece, piece_expire_le, detention_pct,
              nature_controle, est_ppe, criblage_statut, criblage_score, criblage_le, piece_valide)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),$17)
           RETURNING *`,
          [req.dbImfId, e.id, texte(b.nom_complet), b.date_naissance || null, texte(b.lieu_naissance) || null,
           texte(b.nationalite) || null, texte(b.pays_residence) || null, texte(b.adresse) || null,
           texte(b.type_piece) || null, texte(b.numero_piece) || null, b.piece_expire_le || null,
           pctRenseigne, texte(b.nature_controle) || 'CAPITAL',
           b.est_ppe === true || criblage.synthese.ppe_potentielle,
           criblage.synthese.verdict, criblage.synthese.meilleur_score, valide])).rows[0];
        await auditEvent(req.user, { action: 'conformite.kyb.be.ajouter', entity: 'kyb_beneficiaires_effectifs', entityId: ins.id });
        return { ins, criblage: criblage.synthese, seuil: p.seuil_detention_be_pct };
      });
      res.status(201).json({ ok: true, beneficiaire: out.ins, criblage: out.criblage,
        significatif: detentionPct(out.ins.detention_pct) > out.seuil,
        note: 'Bénéficiaire effectif enregistré et criblé.' });
    } catch (e) { next(e); }
  });

/** Ajout d'un mandataire signataire, avec criblage immédiat. */
r.post('/conformite/entreprises/:id/mandataires', requireRole(...SAISIE), habilit('conformite.kyc.write'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!texte(b.nom_complet)) throw new ConformiteError('nom_requis', 'Le nom du mandataire signataire est obligatoire.');
      const out = await tenantTransaction(req, async (c) => {
        const e = (await c.query('SELECT * FROM kyb_entites_morales WHERE id=$1 AND imf_id=$2',
          [req.params.id, req.dbImfId])).rows[0];
        if (!e) throw new ConformiteError('entreprise_introuvable', 'Cette entreprise n’existe pas dans votre institution.', 404);
        const listes = await listesActives(c);
        const criblage = await criblerEtEnregistrer(c, req.dbImfId,
          { entite_id: e.id, sujet_type: 'MANDATAIRE' }, b.nom_complet, b.date_naissance, listes);
        const valide = !!texte(b.numero_piece) && !!texte(b.type_piece) && !!b.piece_expire_le &&
          (joursEntre(b.piece_expire_le, new Date()) || 0) >= 0;
        const ins = (await c.query(
          `INSERT INTO kyb_mandataires_signataires
             (imf_id, tenant_id, entite_id, nom_complet, fonction, date_naissance, lieu_naissance,
              nationalite, type_piece, numero_piece, piece_expire_le, pouvoir_ref, pouvoir_expire_le,
              plafond_signature_cents, est_ppe, criblage_statut, criblage_score, criblage_le, piece_valide, actif)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),$17,$18)
           RETURNING *`,
          [req.dbImfId, e.id, texte(b.nom_complet), texte(b.fonction) || null, b.date_naissance || null,
           texte(b.lieu_naissance) || null, texte(b.nationalite) || null, texte(b.type_piece) || null,
           texte(b.numero_piece) || null, b.piece_expire_le || null, texte(b.pouvoir_ref) || null,
           b.pouvoir_expire_le || null,
           b.plafond_signature_cents == null ? null : Math.round(nombre(b.plafond_signature_cents)),
           b.est_ppe === true || criblage.synthese.ppe_potentielle,
           criblage.synthese.verdict, criblage.synthese.meilleur_score, valide,
           b.actif !== false])).rows[0];
        await auditEvent(req.user, { action: 'conformite.kyb.mandataire.ajouter', entity: 'kyb_mandataires_signataires', entityId: ins.id });
        return { ins, criblage: criblage.synthese };
      });
      res.status(201).json({ ok: true, mandataire: out.ins, criblage: out.criblage,
        note: 'Mandataire signataire enregistré et criblé.' });
    } catch (e) { next(e); }
  });

/** Évaluation KYB : blocage sans bénéficiaire effectif > 25 % avec pièce valide. */
r.post('/conformite/entreprises/:id/evaluer', requireRole(...SAISIE), habilit('conformite.kyc.write', 'conformite.kyc.valider'),
  async (req, res, next) => {
    try {
      const out = await tenantTransaction(req, async (c) => {
        const e = (await c.query('SELECT * FROM kyb_entites_morales WHERE id=$1 AND imf_id=$2 FOR UPDATE',
          [req.params.id, req.dbImfId])).rows[0];
        if (!e) throw new ConformiteError('entreprise_introuvable', 'Cette entreprise n’existe pas dans votre institution.', 404);
        const p = await parametres(c, req.dbImfId);
        const bes = (await c.query('SELECT * FROM kyb_beneficiaires_effectifs WHERE entite_id=$1', [e.id])).rows;
        const mands = (await c.query('SELECT * FROM kyb_mandataires_signataires WHERE entite_id=$1', [e.id])).rows;
        // Les criblages déjà enregistrés sont rechargés pour chaque personne.
        for (const b of bes) {
          b.criblage = (await c.query(
            `SELECT type_liste, score_similarite AS score, verdict FROM kyc_criblage_resultats
              WHERE entite_id=$1 AND sujet_type='BENEFICIAIRE_EFFECTIF' AND sujet_nom=$2
              ORDER BY crible_le DESC LIMIT 10`, [e.id, b.nom_complet])).rows;
          b.criblage_effectue = b.criblage_statut !== 'A_FAIRE';
        }
        for (const m of mands) {
          m.criblage = (await c.query(
            `SELECT type_liste, score_similarite AS score, verdict FROM kyc_criblage_resultats
              WHERE entite_id=$1 AND sujet_type='MANDATAIRE' AND sujet_nom=$2
              ORDER BY crible_le DESC LIMIT 10`, [e.id, m.nom_complet])).rows;
          m.criblage_effectue = m.criblage_statut !== 'A_FAIRE';
        }
        const controle = controlerKyb(e, bes, mands, { params: p });
        await c.query(
          `UPDATE kyb_entites_morales SET statut_kyb=$2, niveau_risque_lbc=$3, score_kyb=$4,
                  prochaine_revue_le=$5, maj_le=now()
            WHERE id=$1`,
          [e.id, controle.statut, controle.niveau_risque_lbc, controle.score_kyb, controle.prochaine_revue_le]);
        await auditEvent(req.user, { action: 'conformite.kyb.evaluer', entity: 'kyb_entites_morales', entityId: e.id,
          detail: { statut: controle.statut, score: controle.score_kyb } });
        return controle;
      });
      res.json({ ok: true, ...out,
        note: out.complet
          ? 'Dossier KYB complet : la relation d’affaires peut être nouée.'
          : 'Relation d’affaires BLOQUÉE : ' + out.bloquants.map((x) => x.message).join(' ') });
    } catch (e) { next(e); }
  });

/* ========================================================================
 * VISITES DE TERRAIN (synchronisation hors-ligne, idempotente)
 * ===================================================================== */
r.post('/conformite/visites', requireRole(...SAISIE), habilit('conformite.visite', 'conformite.kyc.write'),
  async (req, res, next) => {
    try {
      const lot = Array.isArray(req.body && req.body.visites) ? req.body.visites :
        (req.body && req.body.id ? [req.body] : []);
      if (!lot.length) throw new ConformiteError('lot_vide', 'Aucune visite à synchroniser.');
      if (lot.length > 200) throw new ConformiteError('lot_trop_grand', 'Synchronisez au plus 200 visites à la fois.');
      const out = await tenantTransaction(req, async (c) => {
        const p = await parametres(c, req.dbImfId);
        const resultats = [];
        for (const v of lot) {
          const cible = v && (v.client_id || v.entite_id) ?
            (v.client_id ? { client_id: v.client_id } : { entite_id: v.entite_id }) : null;
          let ref = null;
          if (cible && cible.client_id) {
            ref = (await c.query('SELECT id, gps_lat, gps_lng FROM client WHERE id=$1 AND imf_id=$2',
              [cible.client_id, req.dbImfId])).rows[0];
          } else if (cible && cible.entite_id) {
            ref = (await c.query(`SELECT id, siege_gps_lat AS gps_lat, siege_gps_lng AS gps_lng
                                    FROM kyb_entites_morales WHERE id=$1 AND imf_id=$2`,
              [cible.entite_id, req.dbImfId])).rows[0];
          }
          if (!ref) {
            resultats.push({ id: v && v.id, statut: 'REJETE', motif: 'Client ou entreprise hors de votre institution.' });
            continue;
          }
          const ctrl = controlerVisite({ ...v, ...cible }, {
            params: p,
            point_reference_lat: ref.gps_lat == null ? null : Number(ref.gps_lat),
            point_reference_lng: ref.gps_lng == null ? null : Number(ref.gps_lng)
          });
          if (!ctrl.valide) {
            resultats.push({ id: v && v.id, statut: 'REJETE', bloquants: ctrl.bloquants });
            continue;
          }
          const deja = (await c.query('SELECT id FROM visites_terrain_kyc WHERE id=$1', [v.id])).rows[0];
          if (deja) {
            resultats.push({ id: v.id, statut: 'DEJA_SYNCHRONISEE' });
            continue;
          }
          const ins = (await c.query(
            `INSERT INTO visites_terrain_kyc
               (id, imf_id, tenant_id, client_id, entite_id, agent_id, appareil_id, objet, statut,
                gps_lat, gps_lng, gps_precision_m, gps_capture_le, gps_source, gps_alerte_precision,
                point_reference_lat, point_reference_lng, distance_m, distance_alerte,
                reperes_visuels, present, activite_constatee, observations, photos_json,
                visite_le, capture_le, synchronise_le, hors_ligne)
             VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CAPTEUR',$13,$14,$15,$16,$17,
                     $18,$19,$20,$21,$22,$23,now(),now(),$24)
             RETURNING id, statut, distance_m, distance_alerte, gps_alerte_precision`,
            [v.id, req.dbImfId, cible.client_id || null, cible.entite_id || null, req.user.id,
             texte(v.appareil_id) || null, texte(v.objet) || 'VERIFICATION_DOMICILE', ctrl.statut,
             Number(v.gps_lat), Number(v.gps_lng), nombre(v.gps_precision_m), v.gps_capture_le,
             ctrl.gps_alerte_precision,
             ref.gps_lat == null ? null : Number(ref.gps_lat),
             ref.gps_lng == null ? null : Number(ref.gps_lng),
             ctrl.distance_m, ctrl.distance_alerte, texte(v.reperes_visuels) || null,
             v.present == null ? null : v.present === true,
             texte(v.activite_constatee) || null, texte(v.observations) || null,
             JSON.stringify(Array.isArray(v.photos) ? v.photos : (Array.isArray(v.photos_json) ? v.photos_json : [])),
             v.visite_le || new Date(), v.capture_le || new Date(), v.hors_ligne !== false])).rows[0];
          // Le client garde la trace de sa dernière visite de terrain.
          if (cible.client_id) {
            await c.query(
              `UPDATE client SET kyc_derniere_visite_le = GREATEST(COALESCE(kyc_derniere_visite_le, $2), $2)
                WHERE id=$1`, [cible.client_id, v.visite_le || new Date()]);
          }
          resultats.push({ id: ins.id, statut: ins.statut, distance_m: ins.distance_m == null ? null : Number(ins.distance_m),
            distance_alerte: ins.distance_alerte, gps_alerte_precision: ins.gps_alerte_precision, alertes: ctrl.alertes });
        }
        return resultats;
      });
      const ok = out.filter((x) => x.statut === 'ACTIF_CONFORME' || x.statut === 'NON_CONFORME' || x.statut === 'DEJA_SYNCHRONISEE').length;
      res.json({ ok: true, synchronisees: ok, rejetees: out.length - ok, resultats: out,
        note: ok + ' visite(s) synchronisée(s) sur ' + out.length + '.' });
    } catch (e) { next(e); }
  });

r.get('/conformite/clients/:id/visites', requireRole(...LECTURE), habilit('conformite.kyc.read'),
  async (req, res, next) => {
    try {
      const out = await tenantTransaction(req, async (c) => {
        const cl = (await c.query('SELECT id FROM client WHERE id=$1 AND imf_id=$2', [req.params.id, req.dbImfId])).rows[0];
        if (!cl) throw new ConformiteError('client_introuvable', 'Ce client n’existe pas dans votre institution.', 404);
        const p = await parametres(c, req.dbImfId);
        const visites = (await c.query(
          `SELECT v.*, COALESCE(u.full_name, 'Agent') AS agent_nom
             FROM visites_terrain_kyc v LEFT JOIN app_user u ON u.id = v.agent_id
            WHERE v.client_id=$1 ORDER BY v.visite_le DESC`, [cl.id])).rows;
        return { visites, validite_jours: p.validite_visite_jours,
          visite_exploitable: visites.find((v) => v.statut === 'ACTIF_CONFORME' &&
            (joursEntre(v.visite_le, new Date()) || 999) <= p.validite_visite_jours) || null };
      });
      res.json(out);
    } catch (e) { next(e); }
  });

/* ========================================================================
 * CONTRÔLE QUOTIDIEN (pièces expirées / revues échues)
 * ===================================================================== */
r.post('/conformite/controle-quotidien', requireRole(...VALIDATION), habilit('conformite.kyc.valider', 'conformite.parametrer'),
  async (req, res, next) => {
    try {
      const out = await tenantTransaction(req, async (c) => {
        const p = await parametres(c, req.dbImfId);
        const clients = (await c.query(
          `SELECT id, full_name, piece_expire_le, kyc_prochaine_revue_le
             FROM client WHERE imf_id=$1 AND statut_kyc <> 'EXPIRE'
               AND ((piece_expire_le IS NOT NULL AND piece_expire_le < CURRENT_DATE)
                 OR (kyc_prochaine_revue_le IS NOT NULL AND kyc_prochaine_revue_le < CURRENT_DATE))`,
          [req.dbImfId])).rows;
        const entites = (await c.query(
          `SELECT id, raison_sociale AS full_name, NULL::date AS piece_expire_le, prochaine_revue_le AS kyc_prochaine_revue_le
             FROM kyb_entites_morales WHERE imf_id=$1 AND statut_kyb <> 'EXPIRE'
               AND prochaine_revue_le IS NOT NULL AND prochaine_revue_le < CURRENT_DATE`,
          [req.dbImfId])).rows;
        let posees = 0;
        for (const d of dossiersAEcheance(clients)) {
          const r1 = await c.query(
            `INSERT INTO kyc_restrictions (imf_id, tenant_id, client_id, code, gravite, motif, detail_json)
             VALUES ($1,$1,$2,$3,'BLOQUANT',$4,$5) ON CONFLICT DO NOTHING`,
            [req.dbImfId, d.client_id, d.code, d.motif, JSON.stringify({ tache: 'quotidienne' })]);
          posees += r1.rowCount;
          await c.query("UPDATE client SET statut_kyc='EXPIRE' WHERE id=$1", [d.client_id]);
        }
        for (const d of dossiersAEcheance(entites.map((e) => ({ ...e, entite_id: e.id, id: e.id })))) {
          const r2 = await c.query(
            `INSERT INTO kyc_restrictions (imf_id, tenant_id, entite_id, code, gravite, motif, detail_json)
             VALUES ($1,$1,$2,$3,'BLOQUANT',$4,$5) ON CONFLICT DO NOTHING`,
            [req.dbImfId, d.entite_id, d.code, d.motif, JSON.stringify({ tache: 'quotidienne' })]);
          posees += r2.rowCount;
          await c.query("UPDATE kyb_entites_morales SET statut_kyb='EXPIRE' WHERE id=$1", [d.entite_id]);
        }
        // Levée automatique des restrictions qui ne sont plus justifiées.
        const levees = await c.query(
          `UPDATE kyc_restrictions r SET levee_le=now(), motif_levee='Contrôle quotidien : échéance régularisée'
            WHERE r.imf_id=$1 AND r.code='ALERTE_KYC_EXPIRE' AND r.levee_le IS NULL
              AND r.client_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM client c WHERE c.id=r.client_id
                            AND (c.piece_expire_le IS NULL OR c.piece_expire_le >= CURRENT_DATE)
                            AND (c.kyc_prochaine_revue_le IS NULL OR c.kyc_prochaine_revue_le >= CURRENT_DATE))`,
          [req.dbImfId]);
        await auditEvent(req.user, { action: 'conformite.controle.quotidien', entity: 'kyc_restrictions',
          detail: { clients: clients.length, entites: entites.length, restrictions_posees: posees,
            restrictions_levees: levees.rowCount } });
        return { clients_analyses: clients.length, entites_analysees: entites.length,
          restrictions_posees: posees, restrictions_levees: levees.rowCount,
          echeance_clients: dossiersAEcheance(clients).map((x) => ({ client_id: x.client_id, motif: x.motif })) };
      });
      res.json({ ok: true, ...out,
        note: out.restrictions_posees === 0
          ? 'Aucune nouvelle pièce expirée ni revue échue : rien à signaler.'
          : out.restrictions_posees + ' dossier(s) restreint(s) — code ALERTE_KYC_EXPIRE.' });
    } catch (e) { next(e); }
  });

/* ========================================================================
 * FEU VERT AVANT DÉCAISSEMENT
 * ===================================================================== */
r.post('/conformite/decaissement', requireRole(...LECTURE), habilit('conformite.kyc.read', 'credit.process'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!estUuid(b.client_id)) throw new ConformiteError('client_requis', 'Indiquez le client concerné par le décaissement.');
      const montant = Math.round(nombre(b.montant_cents, 0));
      if (montant <= 0) throw new ConformiteError('montant_invalide', 'Le montant du décaissement est obligatoire.');
      const out = await tenantTransaction(req, async (c) => {
        const cl = (await c.query('SELECT * FROM client WHERE id=$1 AND imf_id=$2', [b.client_id, req.dbImfId])).rows[0];
        if (!cl) throw new ConformiteError('client_introuvable', 'Ce client n’existe pas dans votre institution.', 404);
        const p = await parametres(c, req.dbImfId);
        const visites = (await c.query(
          'SELECT * FROM visites_terrain_kyc WHERE client_id=$1 ORDER BY visite_le DESC LIMIT 20', [cl.id])).rows;
        const restrictions = (await c.query(
          'SELECT * FROM kyc_restrictions WHERE client_id=$1 AND levee_le IS NULL', [cl.id])).rows;
        const decision = controlerDecaissement({
          montant_cents: montant, statut_kyc: cl.statut_kyc, visites, restrictions
        }, { params: p });
        return { ...decision, statut_kyc: cl.statut_kyc, niveau_risque_lbc: cl.niveau_risque_lbc,
          ppe: cl.ppe, double_approbation_complete: !cl.ppe || !!cl.ppe_approuve_dg_par };
      });
      res.json({ ok: out.autorise, ...out,
        note: out.autorise
          ? 'Conformité satisfaite : le décaissement peut être engagé.'
          : 'Décaissement refusé par la conformité : ' + out.motifs.join(' ') });
    } catch (e) { next(e); }
  });

export default r;
