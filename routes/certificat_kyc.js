// ===========================================================================
// teebo — VAGUE 42 : CERTIFICAT DE DILIGENCE KYC/KYB & VISITE TERRAIN
// ---------------------------------------------------------------------------
// Préfixe : /api/v1/conformite/certificats/…
//
//   Disponibilité  GET  /conformite/certificats/clients/:id/disponibilite
//   Génération     GET  /conformite/certificats/clients/:id/pdf
//   Historique     GET  /conformite/certificats/clients/:id/historique
//   Annulation     POST /conformite/certificats/:certId/annuler
//
//   Vérification   GET  /verify-certificat/:empreinte   (PUBLIQUE, hors /api)
//
// Invariants :
//   * imf_id vient TOUJOURS du jeton (jamais d'une autre IMF) ;
//   * un certificat n'est émis que sur une visite de terrain GÉOLOCALISÉE,
//     CONFORME et SYNCHRONISÉE — sinon la réponse dit précisément pourquoi ;
//   * générer un certificat ÉCRIT une ligne au journal d'audit (EXPORT_DATA)
//     et une ligne dans le registre certificats_kyc (référence + empreinte) ;
//   * un certificat émis est immuable : on l'annule ou on le remplace, jamais
//     on ne le réécrit (trigger d'immuabilité côté base) ;
//   * la page publique de vérification ne divulgue AUCUNE donnée personnelle.
// ===========================================================================
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { habilit } from '../rbac_strict.js';
import { tenantTransaction } from '../tenant.js';
import { q } from '../db.js';
import { auditEvent } from '../audit.js';
import { getBranding, setDocumentCsp } from '../documents.js';
import {
  esc, aff, empreinteCertificat, chaineEmpreinte, horodatage, coord,
  formaterReference, disponibilite, photosDe, tuileDataUrl, qrDataUrl,
  rendreCertificat, rendrePageVerification, joursDepuis
} from '../certificat_kyc.js';

const r = Router();

const LECTURE = ['staff', 'agency', 'service', 'department', 'caissier', 'admin_imf', 'direction'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const estUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const nombre = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** Paramètres de conformité de l'IMF (repli sur le référentiel livré). */
async function parametres(c, imfId) {
  const row = (await c.query('SELECT * FROM conformite_parametres WHERE imf_id=$1', [imfId])).rows[0];
  return {
    validite_visite_jours: row && row.validite_visite_jours != null ? Number(row.validite_visite_jours) : 365,
    precision_gps_max_m: row && row.precision_gps_max_m != null ? Number(row.precision_gps_max_m) : 30
  };
}

/**
 * Charge, sous contexte tenant, TOUT ce que le certificat doit montrer.
 * Renvoie null si le client n'appartient pas à l'IMF de l'utilisateur.
 */
async function chargerDossier(req) {
  return tenantTransaction(req, async (c) => {
    const cl = (await c.query('SELECT * FROM client WHERE id=$1 AND imf_id=$2',
      [req.params.id, req.dbImfId])).rows[0];
    if (!cl) return null;
    const p = await parametres(c, req.dbImfId);

    // Dernière visite conforme la plus récente (celle qui fonde le certificat).
    const visites = (await c.query(
      'SELECT * FROM visites_terrain_kyc WHERE client_id=$1 AND imf_id=$2 ORDER BY visite_le DESC LIMIT 20',
      [cl.id, req.dbImfId])).rows;
    const visite = visites.find((v) => v.statut === 'ACTIF_CONFORME') || visites[0] || null;

    const evaluation = (await c.query(
      'SELECT * FROM kyc_evaluations WHERE client_id=$1 AND imf_id=$2 ORDER BY cree_le DESC LIMIT 1',
      [cl.id, req.dbImfId])).rows[0] || null;
    const criblage = (await c.query(
      `SELECT verdict, score_similarite, crible_le, decision
         FROM kyc_criblage_resultats WHERE client_id=$1 AND imf_id=$2 ORDER BY crible_le DESC LIMIT 1`,
      [cl.id, req.dbImfId])).rows[0] || null;
    const entite = (await c.query(
      'SELECT * FROM kyb_entites_morales WHERE client_id=$1 AND imf_id=$2 ORDER BY cree_le DESC LIMIT 1',
      [cl.id, req.dbImfId])).rows[0] || null;
    let beneficiaires = [];
    let mandataires = [];
    if (entite) {
      // Filtre imf_id maintenu en plus de entite_id : defense en profondeur.
      beneficiaires = (await c.query(
        'SELECT * FROM kyb_beneficiaires_effectifs WHERE entite_id=$1 AND imf_id=$2 ORDER BY detention_pct DESC',
        [entite.id, req.dbImfId])).rows;
      mandataires = (await c.query(
        'SELECT * FROM kyb_mandataires_signataires WHERE entite_id=$1 AND imf_id=$2 ORDER BY cree_le',
        [entite.id, req.dbImfId])).rows;
    }
    const agent = visite && visite.agent_id
      ? (await c.query('SELECT full_name FROM app_user WHERE id=$1', [visite.agent_id])).rows[0]
      : null;
    return { client: cl, visite, visites, evaluation, criblage, entite, beneficiaires, mandataires,
      agent: agent ? agent.full_name : null, parametres: p };
  });
}

/** Construit la réponse de disponibilité (identique pour l'écran et pour le PDF). */
function etatDisponibilite(fiche) {
  if (!fiche) return { disponible: false, motif: 'CLIENT_INTROUVABLE', message: 'Client introuvable dans votre institution.' };
  const d = disponibilite({ visite: fiche.visite, parametres: fiche.parametres });
  const v = fiche.visite;
  return {
    ...d,
    visite: v ? {
      id: v.id, visite_le: v.visite_le, statut: v.statut,
      gps_lat: v.gps_lat == null ? null : Number(v.gps_lat),
      gps_lng: v.gps_lng == null ? null : Number(v.gps_lng),
      gps_precision_m: v.gps_precision_m == null ? null : Number(v.gps_precision_m),
      distance_m: v.distance_m == null ? null : Number(v.distance_m),
      synchronise_le: v.synchronise_le,
      photos: photosDe(v.photos_json).length
    } : null
  };
}

/* ========================================================================
 * DISPONIBILITÉ — pilote l'état (actif / désactivé + explication) du bouton
 * ===================================================================== */
r.get('/conformite/certificats/clients/:id/disponibilite',
  requireRole(...LECTURE), habilit('conformite.kyc.read', 'conformite.certificat.read'),
  async (req, res, next) => {
    try {
      if (!estUuid(req.params.id)) {
        return res.status(400).json({ error: 'client_id_invalide', message: 'Identifiant de client invalide.' });
      }
      const fiche = await chargerDossier(req);
      if (!fiche) return res.status(404).json({ error: 'client_introuvable', message: 'Ce client n’existe pas dans votre institution.' });
      const d = etatDisponibilite(fiche);
      res.json({
        ...d,
        url: d.disponible ? '/api/v1/conformite/certificats/clients/' + fiche.client.id + '/pdf' : null,
        parametres: fiche.parametres,
        libelle_bouton: 'Télécharger Certificat KYC/KYB (PDF)'
      });
    } catch (e) { next(e); }
  });

/* ========================================================================
 * HISTORIQUE DES CERTIFICATS ÉMIS
 * ===================================================================== */
r.get('/conformite/certificats/clients/:id/historique',
  requireRole(...LECTURE), habilit('conformite.kyc.read', 'conformite.certificat.read'),
  async (req, res, next) => {
    try {
      if (!estUuid(req.params.id)) {
        return res.status(400).json({ error: 'client_id_invalide', message: 'Identifiant de client invalide.' });
      }
      const rows = await tenantTransaction(req, async (c) => (await c.query(
        `SELECT id, reference, empreinte, statut, genere_le, genere_par_nom, visite_le, valide_le
           FROM certificats_kyc WHERE client_id=$1 AND imf_id=$2 ORDER BY genere_le DESC LIMIT 50`,
        [req.params.id, req.dbImfId])).rows);
      res.json({ certificats: rows, total: rows.length });
    } catch (e) { next(e); }
  });

/* ========================================================================
 * GÉNÉRATION DU CERTIFICAT (PDF imprimable + QR + empreinte + audit)
 * ===================================================================== */
r.get('/conformite/certificats/clients/:id/pdf',
  requireRole(...LECTURE), habilit('conformite.certificat.emettre', 'conformite.kyc.read'),
  async (req, res, next) => {
    try {
      if (!estUuid(req.params.id)) {
        return res.status(400).json({ error: 'client_id_invalide', message: 'Identifiant de client invalide.' });
      }
      const fiche = await chargerDossier(req);
      if (!fiche) {
        return res.status(404).json({ error: 'client_introuvable', message: 'Ce client n’existe pas dans votre institution.' });
      }
      const dispo = etatDisponibilite(fiche);
      if (!dispo.disponible) {
        // 409 : la demande est valide mais l'état du dossier l'empêche.
        return res.status(409).json({
          error: dispo.motif, message: dispo.message, visite: dispo.visite,
          note: 'Aucun certificat n’a été émis : la preuve de terrain est indispensable.'
        });
      }

      const v = fiche.visite;
      const cl = fiche.client;
      // Horodatage de validation : celui de la visite (moment où l'agent a
      // constaté les faits), à défaut celui de la synchronisation.
      const valideLe = v.visite_le || v.synchronise_le || new Date();

      const empreinte = empreinteCertificat({
        client_id: cl.id, lat: v.gps_lat, lng: v.gps_lng, visite_id: v.id, valide_le: valideLe
      });
      const chaine = chaineEmpreinte({
        client_id: cl.id, lat: v.gps_lat, lng: v.gps_lng, visite_id: v.id, valide_le: valideLe
      });

      // Numérotation officielle : séquence par IMF et par année (§B du schéma).
      const annee = new Date().getFullYear();
      const num = await tenantTransaction(req, async (c) => {
        const row = (await c.query(
          `INSERT INTO certificats_kyc_compteurs (imf_id, annee, dernier)
           VALUES ($1,$2,1)
           ON CONFLICT (imf_id, annee) DO UPDATE SET dernier = certificats_kyc_compteurs.dernier + 1, maj_le = now()
           RETURNING dernier`, [req.dbImfId, annee])).rows[0];
        return row.dernier;
      });
      let reference = formaterReference(annee, num);

      // Une empreinte déjà enregistrée ne se duplique pas : on réutilise la
      // référence existante (même visite, même dossier => même certificat).
      const deja = await tenantTransaction(req, async (c) => (await c.query(
        'SELECT reference FROM certificats_kyc WHERE empreinte=$1 LIMIT 1', [empreinte])).rows[0]);
      if (deja) reference = deja.reference;

      const branding = await getBranding(req.dbImfId);
      const base = (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || 'https://teebo-imf.netlify.app').replace(/\/$/, '');
      const urlVerification = base + '/verify-certificat/' + empreinte;

      // Preuves visuelles : QR code + fond de plan (téléchargés et embarqués).
      const [qr, tuile] = await Promise.all([
        qrDataUrl(urlVerification, { taille: 360 }).catch(() => null),
        tuileDataUrl(v.gps_lat, v.gps_lng, 15).catch(() => null)
      ]);

      const html = rendreCertificat({
        reference,
        genere_le: new Date(),
        imf: {
          name: branding.imf && branding.imf.name,
          legal_name: branding.legal_name,
          legal_form: branding.legal_form,
          trade_register_no: branding.trade_register_no,
          tax_id: branding.tax_id,
          bceao_agreement_no: branding.bceao_agreement_no,
          legal_address: branding.legal_address,
          phone_main: branding.imf && branding.imf.phone_main,
          email: branding.imf && branding.imf.email,
          logo_data_url: branding.logo_data_url
        },
        client: cl,
        evaluation: fiche.evaluation,
        criblage: fiche.criblage ? {
          verdict: fiche.criblage.decision && fiche.criblage.decision !== 'AUCUNE' ? fiche.criblage.decision : fiche.criblage.verdict,
          meilleur_score: fiche.criblage.score_similarite == null ? null : Number(fiche.criblage.score_similarite),
          date: fiche.criblage.crible_le
        } : null,
        entite: fiche.entite,
        beneficiaires: fiche.beneficiaires,
        mandataires: fiche.mandataires,
        visite: { ...v, photos: photosDe(v.photos_json) },
        agent: fiche.agent,
        validateur: req.user && req.user.full_name,
        empreinte,
        urlVerification,
        qr,
        tuile,
        footer_note: branding.footer_note,
        scriptUrl: '/certificat-kyc.js'
      });

      // ── Registre + audit (l'émission est un EXPORT_DATA) ──────────────────
      let certId = null;
      try {
        const ins = await tenantTransaction(req, async (c) => (await c.query(
          `INSERT INTO certificats_kyc
             (imf_id, tenant_id, client_id, entite_id, visite_id, annee, sequence, reference,
              empreinte, chaine_empreinte, gps_lat, gps_lng, gps_precision_m, distance_m,
              visite_le, valide_le, genere_par, genere_par_nom)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (empreinte) DO NOTHING
           RETURNING id`,
          [req.dbImfId, cl.id, fiche.entite ? fiche.entite.id : null, v.id, annee, num, reference,
            empreinte, chaine, v.gps_lat, v.gps_lng, v.gps_precision_m, v.distance_m,
            v.visite_le, valideLe, req.user.id, req.user.full_name || null])).rows[0]);
        certId = ins ? ins.id : null;
      } catch (e) {
        // Un échec d'enregistrement ne doit pas priver l'agent du document :
        // on le trace et on sert quand même le certificat.
        console.error('certificat_kyc : registre non enregistré :', e && e.message);
      }

      try {
        await auditEvent(req.user, {
          action: 'EXPORT_DATA', entity: 'certificat_kyc', entityId: certId || cl.id,
          payload: {
            reference, empreinte, client_id: cl.id, visite_id: v.id, entite_id: fiche.entite ? fiche.entite.id : null,
            document: 'CERTIFICAT_DILIGENCE_KYC_KYB', gps: { lat: coord(v.gps_lat), lng: coord(v.gps_lng) },
            valide_le: horodatage(valideLe), format: 'PDF_A4'
          }
        });
      } catch (e) {
        console.error('certificat_kyc : audit non journalisé :', e && e.message);
      }

      setDocumentCsp(res);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Certificat-Reference', reference);
      res.setHeader('X-Certificat-Empreinte', empreinte);
      res.type('html').send(html);
    } catch (e) { next(e); }
  });

/* ========================================================================
 * ANNULATION D'UN CERTIFICAT (on n'efface jamais : on annule et on motive)
 * ===================================================================== */
r.post('/conformite/certificats/:certId/annuler',
  requireRole('admin_imf', 'direction', 'department', 'service'),
  habilit('conformite.certificat.emettre', 'conformite.kyc.valider'),
  async (req, res, next) => {
    try {
      const motif = String((req.body && req.body.motif) || '').trim();
      if (motif.length < 5) {
        return res.status(422).json({ error: 'motif_requis', message: 'Indiquez le motif de l’annulation (5 caractères minimum).' });
      }
      if (!estUuid(req.params.certId)) {
        return res.status(400).json({ error: 'certificat_id_invalide', message: 'Identifiant de certificat invalide.' });
      }
      const row = await tenantTransaction(req, async (c) => {
        const cert = (await c.query('SELECT * FROM certificats_kyc WHERE id=$1 AND imf_id=$2',
          [req.params.certId, req.dbImfId])).rows[0];
        if (!cert) return null;
        if (cert.statut !== 'EMIS') return { deja: true, statut: cert.statut };
        const maj = (await c.query(
          `UPDATE certificats_kyc SET statut='ANNULE', annule_le=now(), annule_par=$2, annulation_motif=$3
            WHERE id=$1 RETURNING id, reference, statut, annule_le`,
          [cert.id, req.user.id, motif])).rows[0];
        return { certificat: maj };
      });
      if (!row) return res.status(404).json({ error: 'certificat_introuvable', message: 'Ce certificat n’existe pas dans votre institution.' });
      if (row.deja) {
        return res.status(409).json({ error: 'certificat_non_emis', message: 'Ce certificat est déjà « ' + row.statut + ' » : il ne peut plus être annulé.' });
      }
      await auditEvent(req.user, {
        action: 'certificat_kyc.annuler', entity: 'certificat_kyc', entityId: row.certificat.id,
        payload: { reference: row.certificat.reference, motif }
      }).catch(() => {});
      res.json({ ok: true, certificat: row.certificat,
        note: 'Certificat annulé : le QR code de ce document répondra désormais « annulé ».' });
    } catch (e) { next(e); }
  });

/* ========================================================================
 * PAGE PUBLIQUE DE VÉRIFICATION — /verify-certificat/:empreinte
 * ------------------------------------------------------------------------
 * Montée ICI mais hors du préfixe /api : elle ne demande aucun jeton. Elle
 * répond uniquement « authentique / annulé / inconnu » + la référence, le nom
 * de l'institution et les deux dates. Aucune donnée personnelle.
 * ===================================================================== */
r.get('/verify-certificat/:empreinte', async (req, res) => {
  try {
    const emp = String(req.params.empreinte || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(emp)) {
      setDocumentCsp(res);
      res.setHeader('Cache-Control', 'no-store');
      return res.type('html').send(rendrePageVerification({ trouve: false, certificat: {}, imfNom: null, empreinte: emp }));
    }
    // Lecture volontairement HORS contexte tenant : l'empreinte sert d'identifiant
    // public et ne permet de lire que les colonnes listées ci-dessous.
    const row = (await q(
      `SELECT c.reference, c.statut, c.genere_le, c.visite_le, c.empreinte, i.name AS imf_nom
         FROM certificats_kyc c JOIN imf i ON i.id = c.imf_id
        WHERE c.empreinte = $1 LIMIT 1`, [emp])).rows[0];
    if (!row || row.statut === 'ANNULE') {
      setDocumentCsp(res);
      res.setHeader('Cache-Control', 'no-store');
      return res.type('html').send(rendrePageVerification({
        trouve: false, certificat: row || {}, imfNom: row ? row.imf_nom : null, empreinte: emp,
        annule: !!(row && row.statut === 'ANNULE')
      }));
    }
    setDocumentCsp(res);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(rendrePageVerification({
      trouve: true, certificat: row, imfNom: row.imf_nom, empreinte: row.empreinte
    }));
  } catch (e) {
    // Une base momentanément indisponible ne doit pas afficher « faux ».
    console.error('verify-certificat :', e && e.message);
    setDocumentCsp(res);
    res.status(503).type('html').send(rendrePageVerification({
      trouve: false, certificat: {}, imfNom: null, empreinte: String(req.params.empreinte || ''),
      indisponible: true
    }));
  }
});

export default r;
