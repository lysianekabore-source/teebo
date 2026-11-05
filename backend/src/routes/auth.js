import express from 'express';
import bcrypt from 'bcryptjs';
import { q, tx } from '../db.js';
import { authenticate, createSession, isPasswordExpired, MDP_MAX_DAYS, hashToken } from '../auth.js';
import { getStatus, is2faRequired, createChallenge, consumeChallenge, verifyForUser,
  verifyRecoveryCode, startEnrollment, confirmEnrollment, disable } from '../twofa.js';

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
      'SELECT id, imf_id, password_hash FROM app_user WHERE code_user = $1 AND is_active = true',
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
    const full = (await q('SELECT id, imf_id FROM app_user WHERE id=$1', [u.id])).rows[0];
    const { token } = await createSession(full);
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
    // Si la 2FA est obligatoire pour ce rôle mais pas encore activée : on laisse
    // se connecter, mais on signale qu'un enrôlement est requis.
    const enrollRequired = is2faRequired(u.role) && !st.enabled;

    const { token } = await createSession(u);
    res.cookie('teebo_session', token, COOKIE);
    const expired = isPasswordExpired(u.password_set_at) || u.must_change_password;
    res.json({ ok: true, password_change_required: expired, max_days: MDP_MAX_DAYS,
      twofa_enrollment_required: enrollRequired });
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
router.post('/2fa/enroll/start', authenticate, async (req, res, next) => {
  try {
    const out = await startEnrollment({ id: req.user.id, imf_id: req.user.imf_id,
      email: req.user.email, code_user: req.user.code_user, full_name: req.user.full_name });
    res.json({ ok: true, secret: out.secret, otpauth_uri: out.otpauth_uri, issuer: out.issuer,
      message: 'Scannez le QR ou saisissez la clé dans votre application, puis confirmez avec un code.' });
  } catch (e) { next(e); }
});

// --- Enrôlement 2FA : confirmer (active + renvoie les codes de secours) ----
router.post('/2fa/enroll/confirm', authenticate, async (req, res, next) => {
  try {
    const { code } = req.body || {};
    const out = await confirmEnrollment(req.user.id, code);
    res.json({ ok: true, enabled: out.enabled, recovery_codes: out.recovery_codes,
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

// --- Déconnexion ------------------------------------------------------------
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    await q('UPDATE session SET revoked = true WHERE id=$1', [req.sessionId]);
    res.clearCookie('teebo_session', { path: '/' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Profil courant (avec contexte IMF + essai) -----------------------------
router.get('/me', authenticate, async (req, res) => {
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
    res.json({
      user: {
        id: req.user.id, email: req.user.email, full_name: req.user.full_name,
        role: req.user.role, code_user: req.user.code_user, imf_id: req.user.imf_id
      },
      imf_code: imf.code_imf || null,
      imf_name: imf.imf_name || null,
      imf_status: imf.imf_status || null,
      trial_active: !!trialEnds && trialEnds.getTime() > Date.now(),
      trial_days_left: trialDaysLeft,
      trial_ends_at: imf.trial_ends_at || null,
      password_set_at: req.user.password_set_at || null,
      password_expires_at: pwdExpiresAt,
      password_change_required: req.user.must_change_password || req.passwordExpired
    });
  } catch (e) { next(e); }
});

export default router;
