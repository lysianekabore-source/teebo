import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import { authenticate, createSession, isPasswordExpired, MDP_MAX_DAYS, hashToken, userHasPermission, effectivePermissionKeys } from '../auth.js';
import { notifyEmail, notifyWhatsApp, PUBLIC_SITE_URL } from '../notify.js';
import { isCashierPosition } from '../org_structure.js';
import { getStatus, is2faRequired, createChallenge, consumeChallenge, verifyForUser,
  verifyRecoveryCode, startEnrollment, confirmEnrollment, disable,
  createEnrollmentTicket, resolveEnrollmentTicket, consumeEnrollmentTicket } from '../twofa.js';

const router = express.Router();

const COOKIE = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 30 * 60 * 1000  // cookie glissant aligné sur l'inactivité 30 min
};

// Politique de mot de passe : >= 10 car., maj/min/chiffre.
function weakPassword(p) {
  return !p || p.length < 10 || !/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/[0-9]/.test(p);
}

// --- Activation : première connexion avec le code d'accès + création du mdp ---
router.post('/activate', async (req, res, next) => {
  try {
    const { code, password } = req.body || {};
    if (!code || weakPassword(password)) return res.status(422).json({ error: 'weak_password' });
    const { rows } = await q(
      'SELECT id, imf_id, role, email, code_user, full_name, password_hash FROM app_user WHERE code_user = $1 AND is_active = true',
      [code]
    );
    if (!rows.length) return res.status(404).json({ error: 'code_not_found' });
    const u = rows[0];
    if (u.password_hash) return res.status(409).json({ error: 'already_activated' });
    const hash = await bcrypt.hash(password, 12);
    await q(
      `UPDATE app_user SET password_hash=$1, password_set_at=now(), must_change_password=false
       WHERE id=$2`, [hash, u.id]
    );
    // Le mot de passe est créé. La double authentification étant OBLIGATOIRE
    // pour l'administrateur IMF (comme pour tous les comptes), on n'ouvre PAS
    // de session tout de suite : on impose l'enrôlement 2FA via un ticket court
    // (mêmes routes /2fa/enroll/* qu'au login). La session réelle sera créée
    // après confirmation d'un premier code. Si la 2FA n'est pas requise (mode
    // test TEEBO_2FA_OPTIONAL), on ouvre directement la session.
    const st = await getStatus(u.id);
    if (is2faRequired(u.role) && !st.enabled) {
      const ticket = await createEnrollmentTicket(u);
      return res.json({ ok: true, twofa_enrollment_required: true,
        enrollment_token: ticket.token, expires_in: ticket.expires_in,
        message: 'Mot de passe créé. La double authentification est obligatoire : enrôlez votre application d’authentification pour finaliser votre premier accès.' });
    }
    const { token } = await createSession({ id: u.id, imf_id: u.imf_id });
    res.cookie('teebo_session', token, COOKIE);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Connexion par mot de passe --------------------------------------------
router.post('/login', async (req, res, next) => {
  try {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) return res.status(422).json({ error: 'missing_fields' });
    const { rows } = await q(
      `SELECT id, imf_id, password_hash, password_set_at, must_change_password, is_active
         FROM app_user WHERE (email = $1 OR code_user = $1)`, [identifier]
    );
    if (!rows.length || !rows[0].password_hash || !rows[0].is_active)
      return res.status(401).json({ error: 'invalid_credentials' });
    const u = rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    // --- Double authentification (2FA / authenticator) ---------------------
    // Si la 2FA est active pour ce compte, on ne crée PAS de session tout de
    // suite : on émet un défi que le client devra résoudre par code à 6 chiffres.
    const st = await getStatus(u.id);
    if (st.enabled) {
      const ch = await createChallenge(u);
      return res.json({ ok: false, twofa_required: true, challenge: ch.token,
        expires_in: ch.expires_in,
        message: 'Saisissez le code à 6 chiffres de votre application d’authentification.' });
    }
    // Si la 2FA est obligatoire mais pas encore activée : on impose l'enrôlement
    // immédiatement. On n'ouvre PAS de session applicative ; on émet un ticket
    // d'enrôlement court qui autorise uniquement les routes /2fa/enroll/*. La
    // session réelle sera créée après confirmation d'un premier code.
    if (is2faRequired(u.role) && !st.enabled) {
      const ticket = await createEnrollmentTicket(u);
      return res.json({ ok: false, twofa_enrollment_required: true,
        enrollment_token: ticket.token,
        expires_in: ticket.expires_in,
        message: 'La double authentification est obligatoire. Installez une application d’authentification puis enrôlez ce compte.' });
    }

    const { token } = await createSession(u);
    res.cookie('teebo_session', token, COOKIE);
    const expired = isPasswordExpired(u.password_set_at) || u.must_change_password;
    res.json({ ok: true, password_change_required: expired, max_days: MDP_MAX_DAYS });
  } catch (e) { next(e); }
});

// --- Validation du défi 2FA (code authenticator ou code de secours) --------
router.post('/2fa/verify', async (req, res, next) => {
  try {
    const { challenge, code, recovery_code } = req.body || {};
    if (!challenge) return res.status(422).json({ error: 'missing_challenge' });
    let user = null;
    try { ({ user } = await consumeChallenge(challenge)); }
    catch (e) { return res.status(e.status || 401).json({ error: e.code || 'invalid_challenge', message: e.message }); }
    if (!user || !user.is_active) return res.status(403).json({ error: 'user_disabled' });

    let verdict;
    if (recovery_code) verdict = await verifyRecoveryCode(user.id, recovery_code);
    else verdict = await verifyForUser(user.id, code);

    if (!verdict.ok) {
      // Le défi a déjà été consommé : on en réémet un pour permettre de réessayer.
      const ch = await createChallenge(user);
      return res.status(401).json({ error: verdict.code || 'invalid_code',
        attempts_left: verdict.attempts_left, locked_until: verdict.locked_until || null,
        challenge: ch.token,
        message: verdict.code === 'locked'
          ? 'Trop de tentatives. Réessayez dans quelques minutes.'
          : 'Code invalide. Réessayez.' });
    }

    const { token } = await createSession(user);
    res.cookie('teebo_session', token, COOKIE);
    const expired = isPasswordExpired(user.password_set_at) || user.must_change_password;
    res.json({ ok: true, twofa: 'passed', password_change_required: expired,
      recovery_codes_left: verdict.remaining != null ? verdict.remaining : undefined });
  } catch (e) { next(e); }
});

// --- Enrôlement 2FA : démarrer (renvoie le secret + l'URI otpauth) ---------
// Accessible soit avec une session (ré-enrôlement depuis l'espace), soit avec
// un ticket d'enrôlement émis au login (premier enrôlement obligatoire, avant
// toute session). Dans ce dernier cas, l'utilisateur provient du ticket.
async function authOrEnroll(req, res, next) {
  // 1) Session normale si cookie présent et valide.
  if (req.cookies?.teebo_session) return authenticate(req, res, next);
  // 2) Sinon, ticket d'enrôlement fourni dans le corps de la requête.
  try {
    const { user, challengeId } = await resolveEnrollmentTicket((req.body || {}).enrollment_token);
    req.user = user;
    req.enrollTicketId = challengeId;
    next();
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.code || 'not_authenticated', message: e.message });
  }
}

router.post('/2fa/enroll/start', authOrEnroll, async (req, res, next) => {
  try {
    const out = await startEnrollment({ id: req.user.id, imf_id: req.user.imf_id,
      email: req.user.email, code_user: req.user.code_user, full_name: req.user.full_name });
    res.json({ ok: true, secret: out.secret, otpauth_uri: out.otpauth_uri,
      qr_data_url: out.qr_data_url, issuer: out.issuer,
      message: 'Scannez le QR ou saisissez la clé dans votre application, puis confirmez avec un code.' });
  } catch (e) { next(e); }
});

// --- Enrôlement 2FA : confirmer (active + renvoie les codes de secours) ----
router.post('/2fa/enroll/confirm', authOrEnroll, async (req, res, next) => {
  try {
    const { code } = req.body || {};
    const out = await confirmEnrollment(req.user.id, code);
    // Enrôlement via ticket (premier login) : on consomme le ticket et on ouvre
    // enfin la session applicative, pour que l'utilisateur soit directement
    // connecté après activation de la 2FA.
    let loggedIn = false;
    if (req.enrollTicketId) {
      await consumeEnrollmentTicket(req.enrollTicketId);
      const { token } = await createSession({ id: req.user.id, imf_id: req.user.imf_id });
      res.cookie('teebo_session', token, COOKIE);
      loggedIn = true;
    }
    res.json({ ok: true, enabled: out.enabled, recovery_codes: out.recovery_codes,
      logged_in: loggedIn,
      message: 'Double authentification activée. Conservez vos codes de secours.' });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.code || 'error', message: e.message });
    next(e);
  }
});

// --- État 2FA du compte courant --------------------------------------------
router.get('/2fa/status', authenticate, async (req, res, next) => {
  try {
    const st = await getStatus(req.user.id);
    res.json({ ...st, required: is2faRequired(req.user.role), role: req.user.role });
  } catch (e) { next(e); }
});

// --- Désactiver la 2FA (mot de passe requis) -------------------------------
router.post('/2fa/disable', authenticate, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    const { rows } = await q('SELECT password_hash FROM app_user WHERE id=$1', [req.user.id]);
    const ok = await bcrypt.compare(password || '', rows[0].password_hash || '');
    if (!ok) return res.status(401).json({ error: 'invalid_current_password' });
    if (is2faRequired(req.user.role))
      return res.status(403).json({ error: 'twofa_required', message: 'La double authentification est obligatoire pour votre profil.' });
    await disable(req.user.id);
    res.json({ ok: true, enabled: false });
  } catch (e) { next(e); }
});

// --- Changement de mot de passe (expiration 60j ou forcé) ------------------
router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const { current, new_password } = req.body || {};
    if (weakPassword(new_password)) return res.status(422).json({ error: 'weak_password' });
    const { rows } = await q('SELECT password_hash FROM app_user WHERE id=$1', [req.user.id]);
    const ok = await bcrypt.compare(current || '', rows[0].password_hash || '');
    if (!ok) return res.status(401).json({ error: 'invalid_current_password' });
    const hash = await bcrypt.hash(new_password, 12);
    await q(
      `UPDATE app_user SET password_hash=$1, password_set_at=now(), must_change_password=false
       WHERE id=$2`, [hash, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Mot de passe oublié : demande de réinitialisation ---------------------
// Accessible SANS session (l'utilisateur est justement bloqué dehors). On
// identifie le compte par son identifiant OU son e-mail, on génère un jeton à
// usage unique (haché, valable 30 min) et on envoie un lien par e-mail et
// WhatsApp. Réponse TOUJOURS générique pour ne pas révéler l'existence d'un
// compte (anti-énumération). En mode dégradé (SMTP/WhatsApp non configurés),
// on renvoie les liens « prêts à envoyer », comme ailleurs dans l'application.
const RESET_TTL_MIN = 30;
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { identifier } = req.body || {};
    const generic = {
      ok: true,
      message: 'Si un compte correspond à cet identifiant, un lien de réinitialisation vient d’être envoyé par e-mail et WhatsApp. Le lien est valable ' + RESET_TTL_MIN + ' minutes.'
    };
    if (!identifier || !String(identifier).trim()) return res.json(generic);

    const { rows } = await q(
      `SELECT id, imf_id, email, phone, full_name, is_active, password_hash
         FROM app_user WHERE (email = $1 OR code_user = $1)`, [String(identifier).trim()]
    );
    const u = rows[0];
    // Compte inexistant, désactivé ou jamais activé : on ne crée pas de jeton
    // mais on répond comme si tout s'était bien passé.
    if (!u || !u.is_active || !u.password_hash) return res.json(generic);

    // On invalide les éventuels jetons encore actifs de ce compte.
    await q(`UPDATE password_reset SET used_at = now()
               WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()`, [u.id]);

    const token = b64url(crypto.randomBytes(32));
    await q(
      `INSERT INTO password_reset(user_id, imf_id, token_hash, expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
      [u.id, u.imf_id, hashToken(token), String(RESET_TTL_MIN)]
    );

    const link = `${PUBLIC_SITE_URL}/login.html?reset=${encodeURIComponent(token)}`;
    const prenom = (u.full_name || '').split(' ')[0] || '';
    const subject = 'teebo — Réinitialisation de votre mot de passe';
    const body =
      `Bonjour ${prenom},\n\n` +
      `Vous avez demandé la réinitialisation de votre mot de passe teebo.\n` +
      `Cliquez sur le lien ci-dessous (valable ${RESET_TTL_MIN} minutes) pour choisir un nouveau mot de passe :\n\n` +
      `${link}\n\n` +
      `Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe actuel reste inchangé.\n\n` +
      `— L’équipe teebo`;

    const dev = [];
    try {
      const em = await notifyEmail(u.email, subject, body);
      if (em && em.mode === 'dev' && em.link) dev.push({ canal: 'email', lien: em.link });
    } catch (e) { /* on reste silencieux côté client */ }
    if (u.phone) {
      try {
        const wa = await notifyWhatsApp(u.phone,
          `teebo — Réinitialisez votre mot de passe (valable ${RESET_TTL_MIN} min) : ${link}`);
        if (wa && wa.mode === 'dev' && wa.link) dev.push({ canal: 'whatsapp', lien: wa.link });
      } catch (e) { /* silencieux */ }
    }

    // En mode dégradé uniquement, on expose les liens « prêts à envoyer » afin
    // que la réinitialisation reste possible sans passerelle automatique.
    if (dev.length) return res.json({ ...generic, mode: 'dev', dev_links: dev });
    return res.json(generic);
  } catch (e) { next(e); }
});

// --- Réinitialisation : définir un nouveau mot de passe via le jeton --------
// Ne nécessite pas de session. Le jeton est vérifié par empreinte, à usage
// unique et expiré au-delà de 30 min. La 2FA reste exigée à la connexion
// suivante : réinitialiser le mot de passe ne contourne jamais la double
// authentification. Toutes les sessions existantes du compte sont révoquées.
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, new_password } = req.body || {};
    if (!token) return res.status(422).json({ error: 'missing_token' });
    if (weakPassword(new_password)) return res.status(422).json({ error: 'weak_password' });

    const { rows } = await q(
      `SELECT pr.id, pr.user_id
         FROM password_reset pr
        WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()`,
      [hashToken(token)]
    );
    if (!rows.length) return res.status(400).json({ error: 'invalid_or_expired_token' });
    const pr = rows[0];

    const hash = await bcrypt.hash(new_password, 12);
    await tx(async (c) => {
      await c.query(
        `UPDATE app_user SET password_hash=$1, password_set_at=now(), must_change_password=false
         WHERE id=$2`, [hash, pr.user_id]);
      await c.query('UPDATE password_reset SET used_at = now() WHERE id=$1', [pr.id]);
      // Par sécurité, on révoque toutes les sessions ouvertes de ce compte.
      await c.query('UPDATE session SET revoked = true WHERE user_id = $1', [pr.user_id]);
    });
    res.json({ ok: true, message: 'Mot de passe réinitialisé. Vous pouvez désormais vous connecter.' });
  } catch (e) { next(e); }
});

// --- Déconnexion ------------------------------------------------------------
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    await q('UPDATE session SET revoked = true WHERE id=$1', [req.sessionId]);
    res.clearCookie('teebo_session', { path: '/' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Profil courant (avec contexte IMF + essai) -----------------------------
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT code_imf, name AS imf_name, status AS imf_status, trial_ends_at
         FROM imf WHERE id = $1`, [req.user.imf_id]
    );
    const imf = rows[0] || {};
    const trialEnds = imf.trial_ends_at ? new Date(imf.trial_ends_at) : null;
    const trialDaysLeft = trialEnds
      ? Math.max(0, Math.ceil((trialEnds.getTime() - Date.now()) / 86400000)) : null;
    const pwdSetAt = req.user.password_set_at ? new Date(req.user.password_set_at) : null;
    const pwdExpiresAt = pwdSetAt ? new Date(pwdSetAt.getTime() + MDP_MAX_DAYS * 86400000) : null;
    // Habilitation à l'écran de validation finale des crédits (pour l'affichage du menu).
    const canValidateCreditFinal = await userHasPermission(req.user, 'credit.validate_final');
    const permissionKeys = await effectivePermissionKeys(req.user);
    res.json({
      user: {
        id: req.user.id, email: req.user.email, full_name: req.user.full_name,
        role: req.user.role, code_user: req.user.code_user, imf_id: req.user.imf_id,
        position_code: req.user.position_code || null,
        is_cashier: isCashierPosition(req.user.position_code)
      },
      imf_code: imf.code_imf || null,
      imf_name: imf.imf_name || null,
      imf_status: imf.imf_status || null,
      trial_active: !!trialEnds && trialEnds.getTime() > Date.now(),
      trial_days_left: trialDaysLeft,
      trial_ends_at: imf.trial_ends_at || null,
      password_set_at: req.user.password_set_at || null,
      password_expires_at: pwdExpiresAt,
      password_change_required: req.user.must_change_password || req.passwordExpired,
      can_validate_credit_final: canValidateCreditFinal,
      permissions: permissionKeys
    });
  } catch (e) { next(e); }
});

export default router;
