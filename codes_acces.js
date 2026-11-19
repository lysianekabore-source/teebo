// ===========================================================================
// teebo — VAGUE 46 : CODES D'ACCES ENVOYES PAR L'ADMINISTRATEUR teebo
// ---------------------------------------------------------------------------
//  Console de l'editeur (role teebo_admin) :
//    GET  /teebo/acces/a-envoyer            comptes a equiper (sans mot de passe)
//    GET  /teebo/acces/utilisateurs         annuaire des comptes (toutes IMF)
//    GET  /teebo/acces/etat/:userId         etat d'acces d'un compte
//    POST /teebo/acces/regenerer            nouveau code d'acces (+ message pret)
//    POST /teebo/acces/:userId/renvoyer     renvoyer le code existant
//    GET  /teebo/acces/journal              historique des envois
//    POST /teebo/acces/notify-test          test de la passerelle d'envoi
//
//  Espace IMF (admin_imf / direction) — meme mecanique, perimetre de l'IMF :
//    POST /users/:id/regenerate-code        nouveau code d'acces
//  (l'envoi et le renvoi existaient deja : POST /users et /users/:id/resend-code)
//
//  Regle commune : l'administrateur ne connait JAMAIS le mot de passe. Il ne
//  diffuse qu'un code ; le titulaire cree son mot de passe et sa 2FA.
// ===========================================================================
import { Router } from 'express';
import { q } from '../db.js';
import { authenticate, requireRole, requireFreshPassword } from '../auth.js';
import { getBranding } from '../documents.js';
import { emailGatewayReady, notifyEmail } from '../notify.js';
import { envoyerCodeAcces, regenererCodeAcces, verifierEtCompleterCode,
         etatAcces } from '../codes_acces.js';

const r = Router();
const gardien = [authenticate, requireFreshPassword, requireRole('teebo_admin')];

/** Message d'erreur lisible en francais, jamais une trace technique. */
function refus(res, e) {
  const status = (e && e.status) || 400;
  const table = {
    utilisateur_introuvable: 'Ce compte est introuvable.',
    compte_editeur_non_regenerable: "Le compte editeur de la plateforme n'a pas de code regenerable."
  };
  return res.status(status).json({
    error: (e && e.message) || 'erreur',
    message: table[e && e.message] || 'Operation impossible. Reessayez.'
  });
}

/* ------------------------------------------------------------------ */
/*  COMPTES A EQUIPER  (code cree mais jamais envoye / mdp a creer)    */
/* ------------------------------------------------------------------ */
// Vue v_acces_a_envoyer (vague 46). Si la base n'est pas encore migree, on
// reconstruit la meme liste en une requete simple : l'ecran ne casse jamais.
r.get('/teebo/acces/a-envoyer', ...gardien, async (req, res, next) => {
  try {
    const limite = Math.min(Number(req.query.limit) || 200, 500);
    let lignes;
    try {
      lignes = (await q(
        `SELECT user_id, imf_id, code_institution, imf_name, imf_status, full_name,
                email, phone, code_user, role, position, mot_de_passe_a_creer,
                must_change_password, is_active, created_at, dernier_envoi,
                dernier_envoi_automatique, nb_envois
           FROM v_acces_a_envoyer
          WHERE mot_de_passe_a_creer = true
          ORDER BY created_at DESC
          LIMIT $1`, [limite])).rows;
    } catch (e) {
      lignes = (await q(
        `SELECT u.id AS user_id, u.imf_id, i.code_imf AS code_institution, i.name AS imf_name,
                i.status::text AS imf_status, u.full_name, u.email, u.phone, u.code_user,
                u.role::text AS role, u.position, (u.password_hash IS NULL) AS mot_de_passe_a_creer,
                u.must_change_password, u.is_active, u.created_at,
                NULL::timestamptz AS dernier_envoi, NULL::timestamptz AS dernier_envoi_automatique,
                0::bigint AS nb_envois
           FROM app_user u JOIN imf i ON i.id = u.imf_id
          WHERE u.role <> 'teebo_admin' AND u.password_hash IS NULL
          ORDER BY u.created_at DESC LIMIT $1`, [limite])).rows;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ total: lignes.length, comptes: lignes });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  ANNUAIRE DES COMPTES (toutes institutions)                         */
/* ------------------------------------------------------------------ */
r.get('/teebo/acces/utilisateurs', ...gardien, async (req, res, next) => {
  try {
    const imf = String(req.query.imf || '').trim();
    const recherche = String(req.query.q || '').trim();
    const limite = Math.min(Number(req.query.limit) || 200, 500);
    const { rows } = await q(
      `SELECT u.id, u.imf_id, i.code_imf AS code_institution, i.name AS imf_name,
              i.status::text AS imf_status, u.full_name, u.email, u.phone, u.code_user,
              u.role::text AS role, u.position, u.is_active,
              (u.password_hash IS NULL) AS mot_de_passe_a_creer,
              u.must_change_password, u.created_at,
              (SELECT max(d.created_at) FROM code_dispatch_log d WHERE d.user_id = u.id) AS dernier_envoi,
              (SELECT count(*) FROM code_dispatch_log d WHERE d.user_id = u.id) AS nb_envois
         FROM app_user u JOIN imf i ON i.id = u.imf_id
        WHERE u.role <> 'teebo_admin'
          AND ($1 = '' OR i.code_imf = $1 OR i.id::text = $1)
          AND ($2 = '' OR u.full_name ILIKE '%' || $2 || '%'
                        OR u.email ILIKE '%' || $2 || '%'
                        OR u.code_user ILIKE '%' || $2 || '%')
        ORDER BY u.created_at DESC
        LIMIT $3`, [imf, recherche, limite]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ total: rows.length, utilisateurs: rows });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  ETAT D'ACCES D'UN COMPTE                                           */
/* ------------------------------------------------------------------ */
r.get('/teebo/acces/etat/:userId', ...gardien, async (req, res, next) => {
  try {
    const code = await verifierEtCompleterCode(req.params.userId);
    const etat = await etatAcces(req.params.userId);
    if (!etat) return res.status(404).json({ error: 'utilisateur_introuvable',
      message: 'Ce compte est introuvable.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...etat, code_user: code || etat.code_user });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  REGENERER PUIS PROPOSER L'ENVOI                                    */
/* ------------------------------------------------------------------ */
// Corps : { user_id, motif, channel: 'both'|'email'|'whatsapp',
//           email, phone, envoyer: true|false, notes }
// Reponse : nouveau code + message pret + liens wa.me / mailto + verdicts.
r.post('/teebo/acces/regenerer', ...gardien, async (req, res, next) => {
  try {
    const b = req.body || {};
    const userId = b.user_id || b.userId;
    if (!userId) return res.status(422).json({ error: 'missing_user_id',
      message: 'Precisez le compte concerne.' });
    const avant = (await q('SELECT email, phone FROM app_user WHERE id=$1', [userId])).rows[0];
    if (!avant) return res.status(404).json({ error: 'utilisateur_introuvable',
      message: 'Ce compte est introuvable.' });

    const nouveau = await regenererCodeAcces(userId, b.motif || b.reason || null, req.user.id);

    // Coordonnees corrigees eventuellement fournies par l'administrateur.
    const email = (typeof b.email === 'string' && b.email.trim()) ? b.email.trim() : avant.email;
    const phone = (typeof b.phone === 'string' && b.phone.trim()) ? b.phone.trim() : avant.phone;
    const emailFinal = email || null;
    const phoneFinal = phone || null;
    if (emailFinal || phoneFinal) {
      // VAGUE 48 : la colonne app_user.updated_at est creee par schema_v48.sql.
      await q(`UPDATE app_user SET email = COALESCE($2, email), phone = COALESCE($3, phone),
                      updated_at = now() WHERE id=$1`,
        [userId, emailFinal, phoneFinal]);
    }

    // Envoi : par defaut on ENVOIE tout de suite. envoyer:false permet a
    // l'administrateur de n'obtenir que le message et les liens.
    const envoiDemande = b.envoyer !== false;
    const canal = ['email', 'whatsapp', 'both'].includes(b.channel) ? b.channel : 'both';
    let envoi = null;
    if (envoiDemande) {
      envoi = await envoyerCodeAcces(nouveau.imf_id, {
        id: nouveau.user_id, full_name: nouveau.full_name,
        email: emailFinal, phone: phoneFinal, code_user: nouveau.nouveau_code
      }, { channel: canal, dispatchedBy: req.user.id, req,
           origin: 'console_teebo', dispatchedRole: req.user.role,
           previousCode: nouveau.ancien_code, notes: b.notes || b.motif || null });
    }

    res.json({
      ok: true,
      user_id: nouveau.user_id,
      full_name: nouveau.full_name,
      ancien_code: nouveau.ancien_code,
      code_user: nouveau.nouveau_code,
      imf_id: nouveau.imf_id,
      mot_de_passe_a_creer: true,
      envoi
    });
  } catch (e) {
    if (e && (e.status === 404 || e.status === 422)) return refus(res, e);
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/*  RENVOYER LE CODE EXISTANT                                          */
/* ------------------------------------------------------------------ */
// Corps : { channel, email, phone, notes }  (aucune regeneration)
r.post('/teebo/acces/:userId/renvoyer', ...gardien, async (req, res, next) => {
  try {
    const b = req.body || {};
    const u = (await q(
      `SELECT u.id, u.imf_id, u.full_name, u.email, u.phone, u.code_user, i.name AS imf_name
         FROM app_user u JOIN imf i ON i.id = u.imf_id
        WHERE u.id = $1`, [req.params.userId])).rows[0];
    if (!u) return res.status(404).json({ error: 'utilisateur_introuvable',
      message: 'Ce compte est introuvable.' });

    const code = u.code_user || await verifierEtCompleterCode(u.id);
    const email = (typeof b.email === 'string' && b.email.trim()) ? b.email.trim() : u.email;
    const phone = (typeof b.phone === 'string' && b.phone.trim()) ? b.phone.trim() : u.phone;
    if (email !== u.email || phone !== u.phone) {
      await q('UPDATE app_user SET email=$2, phone=$3 WHERE id=$1',
        [u.id, email || u.email, phone || null]);
    }
    const canal = ['email', 'whatsapp', 'both'].includes(b.channel) ? b.channel : 'both';
    const envoi = await envoyerCodeAcces(u.imf_id, {
      id: u.id, full_name: u.full_name, email, phone, code_user: code
    }, { channel: canal, dispatchedBy: req.user.id, req, origin: 'console_teebo',
         dispatchedRole: req.user.role, notes: b.notes || null });

    res.json({ ok: true, user_id: u.id, code_user: code, imf_name: u.imf_name, envoi });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  JOURNAL DES ENVOIS DE CODES (toutes institutions)                  */
/* ------------------------------------------------------------------ */
r.get('/teebo/acces/journal', ...gardien, async (req, res, next) => {
  try {
    const imf = String(req.query.imf || '').trim();
    const limite = Math.min(Number(req.query.limit) || 100, 500);
    let rows;
    try {
      rows = (await q(
        `SELECT * FROM v_codes_envoyes
          WHERE ($1 = '' OR code_institution = $1)
          ORDER BY created_at DESC LIMIT $2`, [imf, limite])).rows;
    } catch (e) {
      rows = (await q(
        `SELECT d.id, d.imf_id, i.code_imf AS code_institution, i.name AS imf_name,
                d.user_id, COALESCE(d.recipient_name, u.full_name) AS recipient_name,
                d.code_user, d.to_email, d.to_phone, d.channel,
                NULL::text AS origin, d.whatsapp_mode, d.email_mode,
                NULL::text AS notes, d.created_at, d.dispatched_by,
                COALESCE(a.full_name, 'automatique (systeme)') AS dispatched_by_name,
                NULL::text AS dispatched_role
           FROM code_dispatch_log d
           LEFT JOIN app_user u ON u.id = d.user_id
           LEFT JOIN app_user a ON a.id = d.dispatched_by
           LEFT JOIN imf i ON i.id = d.imf_id
          WHERE ($1 = '' OR i.code_imf = $1)
          ORDER BY d.created_at DESC LIMIT $2`, [imf, limite])).rows;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ total: rows.length, envois: rows });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  TEST DE LA PASSERELLE D'ENVOI                                     */
/* ------------------------------------------------------------------ */
r.post('/teebo/acces/notify-test', ...gardien, async (req, res, next) => {
  try {
    const b = req.body || {};
    const to = String(b.to || req.user.email || '').trim();
    if (!to) return res.status(422).json({ ok: false,
      text: 'Precisez une adresse de destination.' });
    if (!emailGatewayReady()) {
      return res.json({ ok: false, mode: 'not_configured',
        text: "La passerelle d'envoi n'est pas configuree sur le serveur : ajoutez les variables SMTP sur Render, puis redeployez." });
    }
    const r2 = await notifyEmail(to, '[Test] Envoi teebo',
      'Message de test envoye depuis la console teebo. Si vous le lisez, la diffusion des codes fonctionne.',
      { fromName: 'teebo', fromEmail: b.email || undefined });
    res.json({ ok: r2.ok === true, mode: r2.mode || (r2.ok ? 'sent' : 'failed'),
      error: r2.error || null, to,
      text: r2.ok ? `E-mail de test envoye a ${to}.` : `Envoi impossible : ${r2.error || 'erreur inconnue'}.` });
  } catch (e) { next(e); }
});

export default r;
