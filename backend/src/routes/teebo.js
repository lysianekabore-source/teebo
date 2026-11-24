import express from 'express';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { authenticate, requireRole } from '../auth.js';
import { notifyWhatsApp, notifyEmail, TEEBO_WHATSAPP, TEEBO_EMAIL,
  waLink, mailtoLink, invoicePublicUrl, siteBaseFrom } from '../notify.js';
import { getBranding, renderInvoice, setDocumentCsp, moneyFcfa } from '../documents.js';
import { buildInvoiceLines, LICENCE_CENTS } from '../pricing.js';
import { buildProfilesMatrix } from '../permissions.js';
import * as billing from '../saas_billing.js';
import { TRIAL_BILLING_NOTE } from '../pricing.js';
import { defaultPermissionKeysForRole } from '../permissions.js';
import { envoyerCodeAcces } from '../codes_acces.js';

const router = express.Router();
// CORRECTIF 52 — CAUSE RACINE DES ECRANS DE LA CONSOLE.
// Toutes les routes de ce fichier sont ecrites SANS prefixe (/stats, /imfs,
// /requests, /imf-admins, /profiles-matrix, /me…). Le serveur les montait
// pourtant telles quelles sur /api/v1, alors que le site appelle
// /api/v1/teebo/stats, /api/v1/teebo/imfs, etc. Resultat : 404 sur CHAQUE
// ecran de la console (tableau de bord fige sur « Chargement… », demandes et
// institutions en « Une erreur est survenue »). On pose donc le prefixe ici,
// a un seul endroit, pour que l'adresse publique soit /api/v1/teebo/...
// (et surtout pour qu'aucune de ces routes sensibles ne soit joignable a la
// racine de l'API sans la garde teebo_admin).

/*  VAGUE 49 — REFUS PROPRE QUAND L'IMF N'EXISTE PAS (plus de 500)       */
// La console editeur vise une IMF par son identifiant. Si cet identifiant
// ne correspond a aucune institution, la base refusait l'ecriture (cle
// etrangere) et l'ecran recevait une erreur 500. On verifie donc l'IMF
// AVANT toute ecriture : une seule porte pour tous les ecrans concernes.
function refusImfIntrouvable(res) {
  return res.status(404).json({
    error: 'imf_introuvable', code: 'imf_introuvable',
    message: "Cette institution (IMF) est introuvable : verifiez son identifiant."
  });
}

/** Renvoie false (et repond 404) si l'IMF n'existe pas. */
async function imfExiste(res, id) {
  if (!id) { refusImfIntrouvable(res); return false; }
  try {
    const { rows } = await q('SELECT 1 AS ok FROM imf WHERE id=$1', [id]);
    if (rows.length) return true;
    // Une IMF archivee reste visible par la console pour etre reactivee :
    // elle est donc consideree comme existante (seul l'inexistant est refuse).
  } catch (e) {
    if (String(e && e.code) === '22P02') { refusImfIntrouvable(res); return false; }
    throw e;
  }
  refusImfIntrouvable(res);
  return false;
}


// VAGUE 48f — CAUSE RACINE : requireRole ne renvoie 403 que si une session
// existe ; sans session il repond 401 « not_authenticated » et coupe TOUTE
// requete inconnue de /api/v1 placee apres lui (dont /2fa/enroll/start).
// La garde ne s'exerce donc plus que sur les chemins de la console editeur.
// Le routeur est desormais entierement reserve a l'editeur : plus de liste de
// prefixes a tenir a jour (c'est cette liste incomplete qui laissait passer
// certaines routes et en bloquait d'autres).
router.use((req, res, next) => {
  return authenticate(req, res, (e) => (e ? next(e) : requireRole('teebo_admin')(req, res, next)));
});

// --- Matrice des profils & habilitations par défaut (référentiel partagé) ---
// Même matrice que celle de l'espace IMF : l'administrateur teebo la consulte
// comme standard appliqué à la création des utilisateurs de chaque IMF.
router.get('/profiles-matrix', (_req, res) => {
  res.json(buildProfilesMatrix());
});

// --- Profil de l'administrateur teebo --------------------------------------
router.get('/me', async (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, full_name: req.user.full_name, role: req.user.role } });
});

// --- Demandes à approuver (facture proforma validée) -----------------------
router.get('/requests', async (_req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT r.*, i.name AS imf_name, i.code_imf, i.country_code, i.type,
              (SELECT au.code_user FROM app_user au
                 WHERE au.imf_id = r.imf_id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_code,
              (SELECT au.email FROM app_user au
                 WHERE au.imf_id = r.imf_id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_email,
              (SELECT au.id FROM app_user au
                 WHERE au.imf_id = r.imf_id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_user_id,
              (SELECT au.must_change_password FROM app_user au
                 WHERE au.imf_id = r.imf_id AND au.role = 'admin_imf'
                 ORDER BY au.created_at ASC LIMIT 1) AS admin_must_change,
              (SELECT iv.id FROM invoice iv
                 WHERE iv.request_id = r.id AND iv.kind = 'definitive'
                 ORDER BY iv.created_at DESC LIMIT 1) AS definitive_invoice_id,
              (SELECT iv.invoice_no FROM invoice iv
                 WHERE iv.request_id = r.id AND iv.kind = 'definitive'
                 ORDER BY iv.created_at DESC LIMIT 1) AS definitive_invoice_no
         FROM access_request r JOIN imf i ON i.id = r.imf_id
        ORDER BY r.created_at DESC`
    );
    res.json({ requests: rows });
  } catch (e) { next(e); }
});

// --- Approbation : essai gratuit 30 jours + génération du code admin IMF ---
// VAGUE 50 — CHAINE D'ACCES COMPLETE.
// Avant, l'approbation se contentait de reactiver un compte admin_imf suppose
// existant. Or la demande d'acces deposee par le prospect ne cree AUCUN
// compte : le nouveau IMF pouvait donc etre approuve sans que personne puisse
// se connecter. Desormais l'approbation :
//   1) cree (ou retrouve) le compte administrateur de l'IMF ;
//   2) lui attribue son code d'acces (TBO-CC-NNNNNN-U00001) ;
//   3) materialise la structure organisationnelle de depart ;
//   4) lui transmet le code par WhatsApp / e-mail avec le lien de connexion.
const MSG_ADMIN_DEJA_PRESENT =
  'Un compte administrateur existe deja pour cette institution : son code d\'acces '
  + 'reste valable. Utilisez « Renvoyer le code » si le titulaire l\'a perdu.';

router.post('/requests/:id/approve', async (req, res, next) => {
  try {
    const id = req.params.id;
    const out = await tx(async (c) => {
      let rq;
      try {
        rq = (await c.query('SELECT * FROM access_request WHERE id=$1 FOR UPDATE', [id])).rows[0];
      } catch (e) {
        // Identifiant illisible (pas un UUID) : refus propre, jamais un 500.
        if (String(e && e.code) === '22P02') return { err: 404, body: { error: 'not_found' } };
        throw e;
      }
      if (!rq) return { err: 404, body: { error: 'not_found' } };
      if (rq.decision === 'approved') return { err: 409, body: { error: 'already_decided' } };
      const imf = (await c.query('SELECT * FROM imf WHERE id=$1', [rq.imf_id])).rows[0];
      if (!imf) return { err: 404, body: { error: 'imf_introuvable' } };
      await c.query(`UPDATE access_request SET decision='approved', decided_at=now(), decided_by=$2 WHERE id=$1`, [id, req.user.id]);
      await c.query(`UPDATE imf SET status='trial', trial_started_at=now(), trial_ends_at=now() + interval '30 days' WHERE id=$1`, [rq.imf_id]);

      // --- 1. Compte administrateur de l'IMF -------------------------------
      // Email saisi dans le formulaire de demande (stocke sur la fiche IMF).
      const adminEmail = String((imf && imf.email) || '').trim();
      const adminNom = String(rq.admin_name || 'Administrateur IMF').trim().slice(0, 120);
      const adminPhone = String((imf && imf.whatsapp) || (imf && imf.phone_main) || '').trim();
      let admin = null, compteCree = false, codeAdmin = null;

      admin = (await c.query(
        `SELECT id, code_user, full_name, email, phone, must_change_password, is_active
           FROM app_user WHERE imf_id=$1 AND role='admin_imf'
          ORDER BY created_at ASC LIMIT 1`, [rq.imf_id])).rows[0] || null;

      if (!admin && adminEmail) {
        // On reutilise le code d'acces deja attribue par la base (trigger
        // trg_app_user_code_acces, vague 46) : un compte nait toujours avec
        // exactement un code.
        admin = (await c.query(
          `INSERT INTO app_user(imf_id, full_name, email, phone, role, position,
               position_code, must_change_password, is_active)
           VALUES ($1,$2,$3,$4,'admin_imf','Administrateur IMF','POS_DG',true,true)
           RETURNING id, code_user, full_name, email, phone, must_change_password, is_active`,
          [rq.imf_id, adminNom, adminEmail, adminPhone || null])).rows[0];
        compteCree = true;
      }
      if (admin) {
        // Compte reactive et equipé : soit il vient d'etre cree, soit il
        // existait mais etait ferme / sans code.
        const upd = (await c.query(
          `UPDATE app_user
              SET is_active = true,
                  code_user = COALESCE(NULLIF(btrim(code_user), ''), fn_gen_user_code(imf_id)),
                  updated_at = now()
            WHERE id=$1
        RETURNING id, code_user, full_name, email, phone, must_change_password, is_active`,
          [admin.id])).rows[0];
        if (upd) admin = upd;
        codeAdmin = admin.code_user || null;
      }

      // --- 2. Structure organisationnelle de depart ----------------------
      try { await c.query('SELECT fn_seed_org_structure($1)', [rq.imf_id]); }
      catch (e) { /* socle absent : la creation manuelle reste possible */ }

      const first = (await c.query('SELECT * FROM invoice WHERE request_id=$1 AND kind=\'definitive\' ORDER BY created_at DESC LIMIT 1', [id])).rows[0];
      return { imf, rq, first, admin, compteCree, codeAdmin };
    });
    if (out.err) return res.status(out.err).json(out.body);

    // --- 3. Transmission du code d'acces au futur administrateur ---------
    let envoi = null;
    if (out.admin && out.compteCree && out.codeAdmin) {
      try {
        envoi = await envoyerCodeAcces(out.rq.imf_id, {
          id: out.admin.id, full_name: out.admin.full_name,
          email: out.admin.email, phone: out.admin.phone,
          code_user: out.codeAdmin
        }, { channel: 'creation', dispatchedBy: req.user.id, req,
             origin: 'approbation_demande', dispatchedRole: req.user.role });
      } catch (e) {
        envoi = { ok: false, message: 'Envoi differe : ' + (e && e.message) };
      }
    }

    res.json({
      ok: true,
      imf_id: out.rq.imf_id,
      code_imf: out.imf ? out.imf.code_imf : null,
      administrateur: out.admin
        ? { id: out.admin.id, email: out.admin.email, phone: out.admin.phone,
            code_user: out.codeAdmin, compte_cree: out.compteCree,
            mot_de_passe_a_creer: out.admin.must_change_password !== false }
        : null,
      envoi,
      message: out.admin
        ? (out.compteCree
            ? 'Demande approuvee : essai gratuit de 30 jours ouvert. Le code d\'acces de '
              + 'l\'administrateur vient d\'etre transmis (' + out.codeAdmin + ').'
            : MSG_ADMIN_DEJA_PRESENT)
        : 'Demande approuvee : essai gratuit de 30 jours ouvert. Aucun e-mail d\'administrateur '
          + 'n\'a ete fourni dans la demande : creez le compte administrateur depuis la liste des '
          + 'utilisateurs, son code sera genere automatiquement.'
    });
  } catch (e) { next(e); }
});

// --- Facture PDF (proforma / définitive) -----------------------------------
router.get('/invoices/:id.pdf', async (req, res, next) => {
  try {
    const inv = (await q('SELECT * FROM invoice WHERE id=$1', [req.params.id])).rows[0];
    // VAGUE 49 : facture inexistante (ou identifiant illisible) -> refus 404.
    if (!inv) return res.status(404).json({ error: 'facture_introuvable' });
    if (!inv) return res.status(404).json({ error: 'not_found' });
    res.json({ invoice: inv, message: 'Facture disponible au format imprimable.' });
  } catch (e) { next(e); }
});

router.post('/requests/:id/reject', async (req, res, next) => {
  try {
    const r = (await q('SELECT * FROM access_request WHERE id=$1', [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'not_found' });
    if (r.decision) return res.status(409).json({ error: 'already_decided' });
    await q(`UPDATE access_request SET decision='rejected', decided_at=now(), decided_by=$2 WHERE id=$1`, [req.params.id, req.user.id]);
    await q(`UPDATE imf SET status='rejected' WHERE id=$1`, [r.imf_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Liste des IMF ---------------------------------------------------------
router.get('/imfs', async (_req, res, next) => {
  try {
    // CORRECTIF 52 : l'ecran « Institutions » affiche le code d'acces de
    // l'administrateur de chaque IMF. La liste ne le renvoyait pas : la
    // colonne restait vide et les boutons « Renvoyer / Regenerer » n'avaient
    // aucun compte cible.
    const { rows } = await q(
      `SELECT i.*,
              (SELECT u.code_user FROM app_user u
                WHERE u.imf_id = i.id AND u.role = 'admin_imf'
                ORDER BY u.created_at ASC LIMIT 1) AS admin_code,
              (SELECT u.must_change_password FROM app_user u
                WHERE u.imf_id = i.id AND u.role = 'admin_imf'
                ORDER BY u.created_at ASC LIMIT 1) AS admin_must_change,
              (SELECT u.id FROM app_user u
                WHERE u.imf_id = i.id AND u.role = 'admin_imf'
                ORDER BY u.created_at ASC LIMIT 1) AS admin_id
         FROM imf i
        WHERE i.status::text <> 'deleted'
        ORDER BY i.created_at DESC`);
    res.json({ imfs: rows });
  } catch (e) { next(e); }
});

// --- Fiche d'une IMF (identité, statut, volumes) --------------------------
router.get('/imfs/:id', async (req, res, next) => {
  try {
    const imf = (await q(
      `SELECT im.id, im.code_imf, im.name, im.type, im.country_code, im.city,
              im.email, im.phone_main, im.whatsapp, im.status, im.trial_ends_at,
              im.created_at,
              COALESCE(l.license_paid, FALSE) AS license_paid, l.paid_at,
              (SELECT count(*) FROM app_user u WHERE u.imf_id = im.id)::int AS nb_utilisateurs,
              (SELECT count(*) FROM app_user u WHERE u.imf_id = im.id AND u.is_active)::int AS nb_utilisateurs_actifs,
              (SELECT count(*) FROM client c WHERE c.imf_id = im.id)::int AS nb_clients
         FROM imf im
         LEFT JOIN institution_license_status l ON l.institution_id = im.id
        WHERE im.id = $1`, [req.params.id])).rows[0];
    if (!imf) return res.status(404).json({ error: 'imf_introuvable' });
    // CORRECTIF 52 : l'ecran « Detail » lit d.users ; le serveur ne renvoyait
    // que d.imf_admins -> « Aucun utilisateur » s'affichait pour toutes les
    // IMF. On renvoie desormais les deux noms, avec le code d'acces, la 2FA
    // et l'etat de chaque compte.
    const admins = (await q(
      `SELECT id, email, full_name, phone, is_active, created_at, role,
              code_user, twofa_enabled
         FROM app_user WHERE imf_id = $1
        ORDER BY (role = 'admin_imf') DESC, is_active DESC, created_at`, [req.params.id])).rows;
    res.json({ imf, users: admins, imf_admins: admins });
  } catch (e) { next(e); }
});

// --- Administrateurs d'une IMF (créer / réinitialiser l'accès) ------------
router.get('/imf-admins', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT u.id, u.imf_id, i.name AS imf_name, i.code_imf, u.email, u.full_name,
              u.phone, u.is_active, u.created_at, u.code_user
         FROM app_user u LEFT JOIN imf i ON i.id = u.imf_id
        WHERE u.role = 'admin_imf'
          AND ($1::uuid IS NULL OR u.imf_id = $1)
        ORDER BY u.created_at DESC`, [req.query.imf_id || null]);
    res.json({ admins: rows });
  } catch (e) { next(e); }
});

// --- Statut d'une IMF : activer / suspendre / réactiver / essai ----------
router.post('/imfs/:id/status', async (req, res, next) => {
  try {
    const b = req.body || {};
    const STATUTS = { activer: 'active', suspendre: 'suspended',
      reactiver: 'active', essai: 'trial', rejeter: 'rejected' };
    const action = String(b.action || b.status || '').toLowerCase();
    // CORRECTIF 52 : la liste deroulante propose aussi « Approuvee » et
    // « En attente » ; elles etaient refusees (400 statut_invalide).
    const VALIDES = ['pending', 'approved', 'trial', 'active', 'suspended', 'rejected'];
    const statut = STATUTS[action] || (VALIDES.includes(action) ? action : null);
    if (!statut) {
      return res.status(400).json({ error: 'statut_invalide',
        message: 'Statut attendu : activer, suspendre, réactiver, essai ou rejeter.' });
    }
    const { rows } = await q(
      `UPDATE imf SET status = $2,
              trial_ends_at = CASE WHEN $2 = 'trial'
                                   THEN COALESCE($3::timestamptz, now() + interval '30 days')
                                   ELSE trial_ends_at END,
              updated_at = now()
        WHERE id = $1 AND status <> 'deleted'
        RETURNING id, name, code_imf, status, trial_ends_at`,
      [req.params.id, statut, b.trial_ends_at || null]);
    if (!rows[0]) return res.status(404).json({ error: 'imf_introuvable' });
    // Une suspension ferme l'accès des utilisateurs ; une réactivation le rouvre.
    if (statut === 'suspended') {
      await q(`UPDATE app_user SET is_active = FALSE WHERE imf_id = $1 AND role <> 'teebo_admin'`,
        [req.params.id]);
    } else if (statut === 'active') {
      await q(`UPDATE app_user SET is_active = TRUE WHERE imf_id = $1 AND role <> 'teebo_admin'`,
        [req.params.id]);
    }
    await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
             VALUES ($1,$2,'imf.status','imf',$1,$3::jsonb)`,
      [req.params.id, req.user.id, JSON.stringify({ statut, ancien: b.ancien_statut || null })]);
    res.json({ imf: rows[0], message: 'La fiche de l\'IMF a été mise à jour.' });
  } catch (e) { next(e); }
});

// --- Prolonger l'essai gratuit (jours) -----------------------------------
router.post('/imfs/:id/extend-trial', async (req, res, next) => {
  try {
    const jours = Math.max(1, Math.min(180, Number((req.body || {}).days || 30)));
    const { rows } = await q(
      `UPDATE imf SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now())
                            + ($2 || ' days')::interval,
                      status = CASE WHEN status = 'pending' THEN 'trial' ELSE status END,
                      updated_at = now()
        WHERE id = $1 AND status <> 'deleted'
        RETURNING id, name, code_imf, status, trial_ends_at`,
      [req.params.id, jours]);
    if (!rows[0]) return res.status(404).json({ error: 'imf_introuvable' });
    await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
             VALUES ($1,$2,'imf.trial.extend','imf',$1,$3::jsonb)`,
      [req.params.id, req.user.id, JSON.stringify({ jours, fin: rows[0].trial_ends_at })]);
    res.json({ imf: rows[0],
      message: 'L\'essai gratuit a été prolongé de ' + jours + ' jours.' });
  } catch (e) { next(e); }
});

// --- Ouvrir / fermer l'accès d'un utilisateur ----------------------------
router.post('/users/:id/toggle', async (req, res, next) => {
  try {
    // VAGUE 48 : la colonne app_user.updated_at est creee par schema_v48.sql
    // (elle manquait dans le socle, ce qui faisait echouer cette route en 500).
    const { rows } = await q(
      `UPDATE app_user SET is_active = NOT is_active, updated_at = now()
        WHERE id = $1 AND role <> 'teebo_admin'
        RETURNING id, imf_id, email, full_name, role, is_active`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'utilisateur_introuvable' });
    await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
             VALUES ($1,$2,'user.toggle','app_user',$3,$4::jsonb)`,
      [rows[0].imf_id, req.user.id, rows[0].id, JSON.stringify({ actif: rows[0].is_active })]);
    res.json({ utilisateur: rows[0],
      message: rows[0].is_active ? 'Accès ouvert.' : 'Accès fermé.' });
  } catch (e) { next(e); }
});

// --- Fermer (archiver) une IMF ------------------------------------------
// Aucune donnée n'est effacée : l'IMF est marquée « deleted » et n'apparaît
// plus dans les listes. Une réactivation reste possible par le statut.
router.post('/imfs/:id/delete', async (req, res, next) => {
  try {
    const b = req.body || {};
    const mode = String(b.mode || 'soft') === 'hard' ? 'hard' : 'soft';
    const cible = (await q('SELECT id, name, code_imf FROM imf WHERE id=$1', [req.params.id])).rows[0];
    if (!cible) return res.status(404).json({ error: 'imf_introuvable',
      message: 'Cette institution est introuvable.' });
    if (cible.code_imf === 'TBO-SYS-000000') {
      return res.status(403).json({ error: 'cannot_delete_system_tenant',
        message: 'Le tenant systeme teebo ne peut pas etre supprime.' });
    }
    // Mode « definitif » : purge en cascade, uniquement sur demande explicite
    // (le formulaire exige la saisie du code de l'IMF).
    if (mode === 'hard') {
      await q('DELETE FROM imf WHERE id=$1', [req.params.id]);
      res.json({ ok: true,
        message: "L'IMF a ete supprimee definitivement, avec ses donnees." });
      return;
    }
    // Mode « archiver ». CORRECTIF 52 : la valeur 'deleted' n'existait pas dans
    // le type enum imf_status -> l'archivage renvoyait une erreur 500. Le
    // script de migration v52 ajoute la valeur ; si la base n'a pas encore ete
    // mise a jour, on retombe proprement sur « suspendue ».
    let statut = 'deleted';
    try {
      await q(`UPDATE imf SET status = 'deleted'::imf_status, updated_at = now() WHERE id = $1`,
        [req.params.id]);
    } catch (e) {
      if (String(e && e.code) !== '22P02') throw e;
      await q(`UPDATE imf SET status = 'suspended'::imf_status, updated_at = now() WHERE id = $1`,
        [req.params.id]);
      statut = 'suspended';
    }
    await q(`UPDATE app_user SET is_active = FALSE WHERE imf_id = $1 AND role <> 'teebo_admin'`,
      [req.params.id]);
    await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
             VALUES ($1,$2,'imf.archive','imf',$1,$3::jsonb)`,
      [req.params.id, req.user.id, JSON.stringify({ statut })]);
    res.json({ ok: true, statut,
      message: statut === 'deleted'
        ? "L'IMF a ete archivee : ses donnees sont conservees, l'acces est ferme."
        : "L'IMF a ete suspendue et son acces ferme (mise a jour de la base en cours)." });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// CORRECTIF 52 — RENVOYER / REGENERER LE CODE D'ACCES DEPUIS LES INSTITUTIONS
// ---------------------------------------------------------------------------
// Les boutons de l'ecran « Institutions » appelaient /imfs/:id/resend-code et
// /imfs/:id/regenerate-code : ces deux adresses n'existaient pas (404). Elles
// sont ajoutees ici et s'appuient sur le moteur de codes d'acces (meme envoi,
// memes liens WhatsApp / e-mail, meme journal).
router.post('/imfs/:id/resend-code', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!(await imfExiste(res, id))) return undefined;
    const u = (await q(
      `SELECT u.id, u.full_name, u.email, u.phone, u.code_user, u.imf_id, i.name AS imf_name
         FROM app_user u JOIN imf i ON i.id = u.imf_id
        WHERE u.imf_id = $1 AND u.role = 'admin_imf'
        ORDER BY u.created_at ASC LIMIT 1`, [id])).rows[0];
    if (!u) return res.status(404).json({ error: 'no_admin',
      message: "Aucun administrateur n'est rattache a cette institution." });
    const code = u.code_user || (await import('../codes_acces.js')).verifierEtCompleterCode(u.id);
    const envoi = await envoyerCodeAcces(u.imf_id, {
      id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, code_user: code
    }, { channel: 'both', dispatchedBy: req.user.id, req, origin: 'console_teebo',
         dispatchedRole: req.user.role, notes: req.body && req.body.notes });
    res.json({ ok: true, code_user: code, imf_name: u.imf_name,
      send: Object.assign({ auto_sent: !!envoi.sent_now }, envoi) });
  } catch (e) { next(e); }
});

router.post('/imfs/:id/regenerate-code', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!(await imfExiste(res, id))) return undefined;
    const u = (await q(
      `SELECT u.id, u.full_name, u.email, u.phone, u.imf_id, i.name AS imf_name
         FROM app_user u JOIN imf i ON i.id = u.imf_id
        WHERE u.imf_id = $1 AND u.role = 'admin_imf'
        ORDER BY u.created_at ASC LIMIT 1`, [id])).rows[0];
    if (!u) return res.status(404).json({ error: 'no_admin',
      message: "Aucun administrateur n'est rattache a cette institution." });
    const moteur = await import('../codes_acces.js');
    const nouveau = await moteur.regenererCodeAcces(u.id,
      (req.body && req.body.motif) || 'Regeneration depuis la console editeur', req.user.id);
    await q('UPDATE app_user SET is_active = TRUE WHERE id = $1', [u.id]);
    const envoi = await envoyerCodeAcces(u.imf_id, {
      id: u.id, full_name: nouveau.full_name || u.full_name,
      email: u.email, phone: u.phone, code_user: nouveau.nouveau_code
    }, { channel: 'both', dispatchedBy: req.user.id, req, origin: 'console_teebo',
         dispatchedRole: req.user.role, previousCode: nouveau.ancien_code,
         notes: 'Regeneration depuis la console editeur' });
    res.json({ ok: true, code_user: nouveau.nouveau_code, imf_name: u.imf_name,
      send: Object.assign({ auto_sent: !!envoi.sent_now }, envoi) });
  } catch (e) { next(e); }
});

router.delete('/imfs/:id', (_req, res) => res.status(405).json({ error: 'use_post_delete' }));

// --- Diagnostic technique (lecture seule) : la base est-elle a jour ? ------
// VAGUE 49 : permet de verifier SANS acces a la base si les colonnes ajoutees
// par les derniers scripts de migration sont bien presentes. Sert au script
// de test (test/vague49.test.mjs) et au support. Aucune donnee nominative.
router.get('/diagnostic/colonnes', async (_req, res, next) => {
  try {
    const attendues = {
      app_user: ['updated_at', 'deactivated_at', 'code_user'],
      imf: ['updated_at', 'trial_ends_at'],
      tenants: ['updated_at', 'statut_compte']
    };
    const out = {};
    for (const [table, cols] of Object.entries(attendues)) {
      const r = (await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1`, [table])).rows;
      const presentes = new Set(r.map((x) => x.column_name));
      out[table] = {};
      for (const c of cols) out[table][c] = presentes.has(c);
    }
    res.json({ a_jour: Object.values(out).every((t) => Object.values(t).every(Boolean)), tables: out });
  } catch (e) { next(e); }
});

// --- Journal des actions éditeur (audit) -----------------------------------
router.get('/audit', async (req, res, next) => {
  try {
    const imfId = req.query.imf_id || null;
    const limit = Math.min(300, Number(req.query.limit || 100));
    const { rows } = await q(
      `SELECT a.id, a.imf_id, a.actor_id, a.action, a.entity, a.entity_id, a.payload, a.created_at,
              i.name AS imf_name, i.code_imf, u.email AS actor_email
         FROM audit_log a
         LEFT JOIN imf i ON i.id = a.imf_id
         LEFT JOIN app_user u ON u.id = a.actor_id
        WHERE ($1::uuid IS NULL OR a.imf_id = $1)
        ORDER BY a.created_at DESC LIMIT $2`, [imfId, limit]);
    res.json({ audit: rows });
  } catch (e) { next(e); }
});

// --- Statistiques de la plateforme -----------------------------------------
router.get('/stats', async (_req, res, next) => {
  try {
    const c = (await q(
      `SELECT
        (SELECT count(*) FROM imf) AS imfs,
        (SELECT count(*) FROM imf WHERE status='trial') AS trials,
        (SELECT count(*) FROM imf WHERE status='active') AS actives,
        (SELECT count(*) FROM imf WHERE status='suspended') AS suspended,
        (SELECT count(*) FROM imf WHERE status::text = 'deleted') AS supprimees,
        (SELECT count(*) FROM access_request WHERE decision IS NULL AND proforma_validated) AS pending,
        (SELECT count(*) FROM app_user) AS users,
        (SELECT count(*) FROM app_user WHERE is_active) AS users_actifs,
        (SELECT count(*) FROM institution_license_status WHERE license_paid) AS licences_payees,
        (SELECT COALESCE(SUM(grand_total),0) FROM saas_invoices WHERE status='UNPAID') AS encours_fcfa,
        (SELECT COALESCE(SUM(grand_total),0) FROM saas_invoices WHERE status='PAID') AS encaisse_fcfa`
    )).rows[0];
    res.json({ stats: c });
  } catch (e) { next(e); }
});

// =========================================================================
// FACTURATION SAAS PAR MODULE (vue éditeur teebo)
// =========================================================================

// --- Tarifaire : catalogue des modules + licence unique + remise pack -----
router.get('/saas/catalogue', async (_req, res, next) => {
  try {
    res.json({ modules: await billing.listModulePricing(),
      licence_unique_fcfa: await billing.getLicensePrice(),
      remise_pack_complet_pct: await billing.getFullPackDiscount() });
  } catch (e) { next(e); }
});

// --- Modifier le tarif mensuel d'un module --------------------------------
router.put('/saas/catalogue/:key', async (req, res, next) => {
  try {
    const prix = Number((req.body || {}).monthly_subscription_price);
    if (!(prix >= 0)) {
      return res.status(400).json({ error: 'prix_invalide',
        message: 'Indiquez un tarif mensuel positif (en FCFA).' });
    }
    const row = await billing.setModulePrice(req.params.key, prix);
    await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
             SELECT $1,$2,'saas.pricing.module','saas_modules_pricing',$3,$4::jsonb`,
      [null, req.user.id, row.module_key, JSON.stringify({ tarif: prix })]);
    res.json({ module: row });
  } catch (e) { next(e); }
});

// --- Modifier le prix de la licence unique --------------------------------
router.put('/saas/licence', async (req, res, next) => {
  try {
    const prix = Number((req.body || {}).unique_license_price);
    if (!(prix >= 0)) {
      return res.status(400).json({ error: 'prix_invalide',
        message: 'Indiquez un montant de licence positif (en FCFA).' });
    }
    const row = await billing.setLicensePrice(prix);
    await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
             VALUES (NULL,$1,'saas.pricing.licence','saas_global_settings','UNIQUE_LICENSE_PRICE',$2::jsonb)`,
      [req.user.id, JSON.stringify({ prix })]);
    res.json({ licence_unique: row });
  } catch (e) { next(e); }
});

// --- Modifier la remise pack complet (%) ----------------------------------
router.put('/saas/remise-pack', async (req, res, next) => {
  try {
    const pct = Number((req.body || {}).percent);
    if (!(pct >= 0 && pct <= 50)) {
      return res.status(400).json({ error: 'pourcentage_invalide',
        message: 'Indiquez un pourcentage entre 0 et 50.' });
    }
    const row = await billing.setFullPackDiscount(pct);
    await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
             VALUES (NULL,$1,'saas.pricing.remise_pack','saas_global_settings','FULL_PACK_DISCOUNT_PERCENT',$2::jsonb)`,
      [req.user.id, JSON.stringify({ pourcentage: pct })]);
    res.json({ remise_pack_complet_pct: row.setting_value });
  } catch (e) { next(e); }
});

// --- Vue d'ensemble : chaque IMF, sa licence et ses modules ---------------
router.get('/saas/imfs', async (_req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT im.id, im.name, im.code_imf, im.status, im.trial_ends_at, im.created_at,
              COALESCE(l.license_paid, FALSE) AS license_paid, l.paid_at,
              COALESCE((
                SELECT SUM(p.monthly_subscription_price)
                  FROM institution_module_subscriptions s
                  JOIN saas_modules_pricing p ON p.module_key = s.module_key
                 WHERE s.institution_id = im.id AND s.is_active = TRUE
                   AND NOT (s.is_trial AND s.trial_end_date >= CURRENT_DATE)
              ), 0)::float AS abonnement_mensuel_fcfa,
              COALESCE((
                SELECT COUNT(*) FROM institution_module_subscriptions s
                 WHERE s.institution_id = im.id AND s.is_active
                   AND NOT (s.is_trial AND s.trial_end_date >= CURRENT_DATE)
              ), 0)::int AS nb_modules_factures,
              COALESCE((
                SELECT bool_and(s.is_active) FROM institution_module_subscriptions s
                 WHERE s.institution_id = im.id
                   AND s.module_key IN (SELECT module_key FROM saas_modules_pricing WHERE is_available)
              ), FALSE)
              AND (SELECT COUNT(*) FROM saas_modules_pricing WHERE is_available) > 0
              AND (SELECT COUNT(*) FROM institution_module_subscriptions s
                    WHERE s.institution_id = im.id AND s.is_active) = 
                  (SELECT COUNT(*) FROM saas_modules_pricing WHERE is_available)
                AS pack_complet,
              COALESCE((
                SELECT json_agg(json_build_object(
                          'module_key', s.module_key, 'nom', p.module_name,
                          'prix', p.monthly_subscription_price::float,
                          'essai', s.is_trial AND s.trial_end_date >= CURRENT_DATE,
                          'fin_essai', s.trial_end_date,
                          'depuis', s.activated_at)
                       ORDER BY p.position)
                  FROM institution_module_subscriptions s
                  JOIN saas_modules_pricing p ON p.module_key = s.module_key
                 WHERE s.institution_id = im.id AND s.is_active = TRUE
              ), '[]'::json) AS modules,
              (SELECT MAX(billing_period_start) FROM saas_invoices
                WHERE institution_id = im.id) AS derniere_facture,
              (SELECT COALESCE(SUM(grand_total),0) FROM saas_invoices
                WHERE institution_id = im.id AND status='UNPAID')::float AS impaye_fcfa
         FROM imf im
         LEFT JOIN institution_license_status l ON l.institution_id = im.id
        WHERE im.status <> 'deleted'
        ORDER BY im.name`);
    const remise = await billing.getFullPackDiscount();
    res.json({ imfs: rows, remise_pack_complet_pct: remise,
      licence_unique_fcfa: await billing.getLicensePrice() });
  } catch (e) { next(e); }
});

// --- Dossier complet d'une IMF (tout sur un écran) -----------------------
router.get('/saas/imfs/:id', async (req, res, next) => {
  try {
    const imf = (await q(
      `SELECT id, code_imf, name, type, country_code, city, email, phone_main, whatsapp,
              status, trial_ends_at, created_at FROM imf WHERE id=$1`, [req.params.id])).rows[0];
    if (!imf) return res.status(404).json({ error: 'imf_introuvable' });
    const [licence, modules, factures, apercu] = await Promise.all([
      billing.getLicenseStatus(imf.id),
      billing.listInstitutionModules(imf.id),
      billing.listInvoices(imf.id, { limit: 12 }),
      billing.previewMonthlyInvoice(imf.id, null)]);
    res.json({ imf, licence_unique: licence, modules, factures,
      apercu_mois_en_cours: apercu,
      remise_pack_complet_pct: await billing.getFullPackDiscount() });
  } catch (e) { next(e); }
});

// --- Factures d'une IMF / toutes les factures -----------------------------
router.get('/saas/invoices', async (req, res, next) => {
  try {
    res.json({ factures: await billing.listInvoices(req.query.institution_id || null,
      { limit: Math.min(500, Number(req.query.limit || 100)),
        statut: req.query.statut || null }) });
  } catch (e) { next(e); }
});

// --- Aperçu (simulation) pour une IMF -------------------------------------
router.get('/saas/imfs/:id/apercu', async (req, res, next) => {
  try {
    if (!(await imfExiste(res, req.params.id))) return;
    const mois = req.query.mois ? String(req.query.mois) + '-01' : null;
    res.json(await billing.previewMonthlyInvoice(req.params.id, mois));
  } catch (e) { next(e); }
});

// --- Générer la facture du mois pour une IMF ------------------------------
router.post('/saas/imfs/:id/facturer', async (req, res, next) => {
  try {
    if (!(await imfExiste(res, req.params.id))) return;
    const mois = (req.body || {}).mois ? String((req.body || {}).mois) + '-01' : null;
    const facture = await billing.generateMonthlyInvoice(req.params.id, mois);
    if (!facture) return res.status(500).json({ error: 'facture_non_generee' });
    res.status(201).json({ facture });
  } catch (e) { next(e); }
});

// --- Générer pour TOUTES les IMF (traitement mensuel) ---------------------
router.post('/saas/facturer-toutes', async (req, res, next) => {
  try {
    const mois = (req.body || {}).mois ? String((req.body || {}).mois) + '-01' : null;
    const imfs = (await q("SELECT id FROM imf WHERE status NOT IN ('deleted')")).rows;
    const resultats = [];
    let total = 0;
    for (const im of imfs) {
      try {
        const f = await billing.generateMonthlyInvoice(im.id, mois);
        total += Number((f && f.grand_total) || 0);
        resultats.push({ institution_id: im.id, numero: f && f.invoice_number,
          total: f && Number(f.grand_total), ok: true });
      } catch (e) {
        resultats.push({ institution_id: im.id, ok: false, message: e.message });
      }
    }
    res.status(201).json({ mois: mois || 'mois en cours', nb: resultats.length,
      total_fcfa: Math.round(total * 100) / 100, resultats });
  } catch (e) { next(e); }
});

// --- Marquer une facture payée (licence incluse) --------------------------
router.post('/saas/invoices/:id/payer', async (req, res, next) => {
  try {
    const ok = await billing.markInvoicePaid(req.params.id);
    if (!ok) return res.status(404).json({ error: 'facture_introuvable_ou_deja_payee' });
    const inv = (await q('SELECT * FROM saas_invoices WHERE id=$1', [req.params.id])).rows[0];
    if (inv && inv.institution_id) await billing.refreshFullPackFlag(inv.institution_id);
    res.json({ facture: inv, licence_reglee: true });
  } catch (e) { next(e); }
});

// --- Détail d'une facture (lignes, ventilation, remise) -------------------
router.get('/saas/invoices/:id', async (req, res, next) => {
  try {
    const inv = (await q(
      `SELECT i.*, COALESCE(im.name,'') AS imf_name, COALESCE(im.code_imf,'') AS imf_code
         FROM saas_invoices i LEFT JOIN imf im ON im.id=i.institution_id
        WHERE i.id=$1`, [req.params.id])).rows[0];
    if (!inv) return res.status(404).json({ error: 'facture_introuvable' });
    const lignes = (await q(
      'SELECT * FROM saas_invoice_lines WHERE invoice_id=$1 ORDER BY line_type DESC, amount_fcfa DESC',
      [inv.id])).rows;
    res.json({ facture: inv, lignes });
  } catch (e) { next(e); }
});

// --- Annuler une facture émise par erreur ---------------------------------
router.post('/saas/invoices/:id/annuler', async (req, res, next) => {
  try {
    const inv = (await q(
      `UPDATE saas_invoices SET status='CANCELLED'
        WHERE id=$1 AND status='UNPAID' RETURNING *`, [req.params.id])).rows[0];
    if (!inv) return res.status(409).json({ error: 'annulation_impossible',
      message: 'Seule une facture impayée peut être annulée.' });
    await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
             VALUES ($1,$2,'saas.invoice.cancel','saas_invoices',$3,$4::jsonb)`,
      [inv.institution_id, req.user.id, inv.id,
       JSON.stringify({ numero: inv.invoice_number, total: inv.grand_total })]);
    res.json({ facture: inv });
  } catch (e) { next(e); }
});

// --- Modules d'une IMF : activer / désactiver / essai ---------------------
router.put('/saas/imfs/:id/modules/:key', async (req, res, next) => {
  try {
    if (!(await imfExiste(res, req.params.id))) return;
    const b = req.body || {};
    const out = await billing.setInstitutionModule(req.params.id, req.params.key,
      { is_active: b.is_active, is_trial: b.is_trial, trial_end_date: b.trial_end_date },
      req.user.id);
    await billing.syncFeaturesFromSubscriptions(req.params.id);
    await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
             VALUES ($1,$2,'saas.module.update','institution_module_subscriptions',$3,$4::jsonb)`,
      [req.params.id, req.user.id, out.subscription_id,
       JSON.stringify({ module: req.params.key, actif: out.is_active, essai: out.is_trial })]);
    res.json({ abonnement: out });
  } catch (e) { next(e); }
});

// --- Licence : marquer réglée / la remettre en attente -------------------
router.post('/saas/imfs/:id/licence', async (req, res, next) => {
  try {
    if (!(await imfExiste(res, req.params.id))) return;
    const paye = (req.body || {}).paid === true;
    const row = (await q(
      `INSERT INTO institution_license_status (institution_id, license_paid, paid_at)
       VALUES ($1,$2,CASE WHEN $2 THEN now() ELSE NULL END)
       ON CONFLICT (institution_id) DO UPDATE SET
         license_paid = EXCLUDED.license_paid,
         paid_at = CASE WHEN EXCLUDED.license_paid THEN now() ELSE NULL END,
         updated_at = now()
       RETURNING *`, [req.params.id, paye])).rows[0];
    await q(`INSERT INTO audit_log(imf_id, actor_id, action, entity, entity_id, payload)
             VALUES ($1,$2,'saas.licence.update','institution_license_status',$1,$3::jsonb)`,
      [req.params.id, req.user.id, JSON.stringify({ payee: paye })]);
    res.json({ licence_unique: row });
  } catch (e) { next(e); }
});

// Prefixe unique et definitif : /api/v1/teebo/... (voir l'en-tete du fichier).
const app = express.Router();
app.use('/teebo', router);
export default app;
