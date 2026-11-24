// ===========================================================================
// teebo — CODES D'ACCES : generation, regeneration et diffusion
// ---------------------------------------------------------------------------
// VAGUE 46. Regroupe ici ce qui etait eclate entre routes/org.js et
// routes/teebo.js, pour que l'administrateur teebo (console) et
// l'administrateur d'une IMF (espace IMF) utilisent EXACTEMENT le meme
// mecanisme : meme generation, meme message, meme journal, memes liens.
//
//   verifierEtCompleterCode()  un code existe forcement pour le compte
//   regenererCodeAcces()       nouveau code, ancien archive, sessions fermees
//   envoyerCodeAcces()         construit le message + tente les envois
//                              automatiques + renvoie les liens manuels
//
// Regle de securite appliquee partout : l'administrateur n'apprend JAMAIS le
// mot de passe. Il ne diffuse qu'un CODE d'acces ; le titulaire cree ensuite
// son mot de passe (et sa double authentification).
// ===========================================================================
import { q } from './db.js';
import { getBranding } from './documents.js';
import { notifyWhatsApp, notifyEmail, emailGatewayReady,
         loginUrlFor, waLink, mailtoLink } from './notify.js';

/**
 * Le compte peut-il encore acceder a l'application ?
 * Vrai si un code existe ET qu'aucun mot de passe n'a encore ete cree.
 */
export async function etatAcces(userId) {
  const u = (await q(
    `SELECT id, email, phone, code_user, password_hash, must_change_password, is_active
       FROM app_user WHERE id=$1`, [userId])).rows[0];
  if (!u) return null;
  return {
    id: u.id,
    code_user: u.code_user,
    email: u.email,
    phone: u.phone,
    a_creer_mot_de_passe: !u.password_hash,
    doit_changer_mot_de_passe: u.must_change_password === true,
    actif: u.is_active === true
  };
}

/**
 * Garantit qu'un code d'acces existe pour le compte.
 * Le trigger de la vague 46 le fait deja a l'insertion ; cette fonction couvre
 * le cas d'un compte tres ancien (code vide) ou d'un import brut.
 */
export async function verifierEtCompleterCode(userId) {
  const u = (await q(
    `SELECT id, imf_id, code_user FROM app_user WHERE id=$1`, [userId])).rows[0];
  if (!u) return null;
  if (u.code_user && String(u.code_user).trim()) return u.code_user;
  const code = (await q('SELECT fn_gen_user_code($1) AS c', [u.imf_id])).rows[0].c;
  await q('UPDATE app_user SET code_user=$2, updated_at=now() WHERE id=$1', [u.id, code]);
  return code;
}

/**
 * Regenere le code d'acces d'un compte.
 * Cote base : fn_regenerer_code_acces() (vague 46) archive l'ancien code,
 * ferme les sessions et remet le mot de passe a « a creer ».
 * Cote serveur : on refiuse le compte editeur et on rend un message clair.
 */
export async function regenererCodeAcces(userId, motif, actorId) {
  const u = (await q(
    `SELECT id, imf_id, role, full_name, code_user FROM app_user WHERE id=$1`,
    [userId])).rows[0];
  if (!u) { const e = new Error('utilisateur_introuvable'); e.status = 404; throw e; }
  if (u.role === 'teebo_admin') {
    const e = new Error('compte_editeur_non_regenerable'); e.status = 422; throw e;
  }
  let row;
  try {
    row = (await q('SELECT * FROM fn_regenerer_code_acces($1,$2,$3)',
      [userId, motif || null, actorId || null])).rows[0];
  } catch (e) {
    // Base non encore migree : on retombe sur une regeneration applicative
    // (meme resultat, sans l'archivage SQL dans user_code_history).
    const code = (await q('SELECT fn_gen_user_code($1) AS c', [u.imf_id])).rows[0].c;
    await q(`UPDATE app_user SET code_user=$2, password_hash=NULL, password_set_at=NULL,
                    must_change_password=true, is_active=true, updated_at=now()
              WHERE id=$1`, [userId, code]);
    await q('UPDATE session SET revoked=true WHERE user_id=$1 AND revoked=false', [userId]);
    row = { user_id: userId, full_name: u.full_name, ancien_code: u.code_user,
      nouveau_code: code, imf_id: u.imf_id };
  }
  return row;
}

/**
 * Construit le message du code d'acces et tente sa diffusion.
 * ---------------------------------------------------------------------------
 * @param {string} imfId      institution du compte
 * @param {object} user       { id, full_name, email, phone, code_user }
 * @param {object} ctx        { channel: 'both'|'email'|'whatsapp',
 *                              dispatchedBy, dispatchedRole, origin,
 *                              previousCode, notes, req }
 * @returns message, objet, liens wa.me / mailto prets a cliquer, verdicts
 */
export async function envoyerCodeAcces(imfId, user, ctx = {}) {
  const loginUrl = loginUrlFor(ctx.req);
  const br = await getBranding(imfId);
  const imfName = br.legal_name || (br.imf && br.imf.name) || 'votre institution';
  const senderWa = br.notify_whatsapp || (br.imf && br.imf.whatsapp) || '';
  const senderEmail = br.notify_email || (br.imf && br.imf.email) || '';
  const greeting = user.full_name ? `Bonjour ${user.full_name},` : 'Bonjour,';
  const subject = `Votre acces ${imfName} — code ${user.code_user}`;
  const lines = [
    greeting,
    '',
    `Votre acces a l'application ${imfName} (via teebo) est cree.`,
    `Code d'acces : ${user.code_user}`,
    `Connexion : ${loginUrl}`,
    `Saisissez ce code, puis creez immediatement votre mot de passe`,
    `et activez la double authentification.`,
    '',
    `-- ${imfName}`,
    senderWa ? `WhatsApp : ${senderWa}` : null,
    senderEmail ? `E-mail : ${senderEmail}` : null
  ].filter((l) => l !== null);
  const message = lines.join('\n');

  const wantWa = ctx.channel !== 'email' && Boolean(user.phone);
  const wantMail = ctx.channel !== 'whatsapp' && Boolean(user.email);

  let waAuto = null, mailAuto = null;
  if (wantWa) {
    try { waAuto = await notifyWhatsApp(user.phone, message); }
    catch (e) { waAuto = { ok: false, error: e.message }; }
  }
  if (wantMail) {
    try {
      mailAuto = await notifyEmail(user.email, subject, message,
        { fromName: imfName, fromEmail: senderEmail });
    } catch (e) { mailAuto = { ok: false, error: e.message }; }
  }

  const modeOf = (r) => {
    if (!r) return 'skipped';
    if (r.mode) return r.mode;
    return r.ok ? 'sent' : 'failed';
  };
  const whatsappMode = modeOf(waAuto);
  const emailMode = modeOf(mailAuto);

  await journaliserEnvoi(imfId, user, {
    channel: ctx.channel || 'both', whatsappMode, emailMode,
    dispatchedBy: ctx.dispatchedBy, dispatchedRole: ctx.dispatchedRole,
    origin: ctx.origin || 'espace_imf', previousCode: ctx.previousCode,
    notes: ctx.notes, message
  });

  const emailReason = emailMode === 'sent' ? null
    : (mailAuto && mailAuto.error) ||
      (wantMail ? 'Envoi impossible.' : 'Aucune adresse e-mail pour ce destinataire.');
  const waReason = whatsappMode === 'sent' ? null
    : (waAuto && waAuto.error) ||
      (wantWa ? 'Envoi impossible.' : 'Aucun numero WhatsApp pour ce destinataire.');

  return {
    message,
    subject,
    imf_name: imfName,
    sender_whatsapp: senderWa || null,
    sender_email: senderEmail || null,
    receiver_resolved: Boolean(senderEmail),
    wa_link: user.phone ? waLink(user.phone, message) : null,
    mailto_link: user.email ? mailtoLink(user.email, subject, message) : null,
    to_phone: user.phone || null,
    to_email: user.email || null,
    whatsapp_mode: whatsappMode,
    email_mode: emailMode,
    email_reason: emailReason,
    whatsapp_reason: waReason,
    email_id: mailAuto && mailAuto.id ? mailAuto.id : null,
    email_from: mailAuto && mailAuto.from ? mailAuto.from : null,
    email_gateway: emailGatewayReady(),
    email_status: emailMode === 'sent'
      ? { ok: true, text: `E-mail envoye a ${user.email} (expediteur : ${senderEmail || 'adresse technique'}).` }
      : { ok: false, text: emailReason || 'E-mail non envoye.' },
    sent_now: whatsappMode === 'sent' || emailMode === 'sent'
  };
}

/**
 * Journal d'envoi (vague 46 enrichie). Best-effort : un journal qui echoue ne
 * doit JAMAIS empecher la diffusion du code.
 * Colonnes ajoutees par la vague 46 inconnues d'une base plus ancienne ?
 * On reessaie alors l'insertion dans le format de la vague 7.
 */
async function journaliserEnvoi(imfId, user, d) {
  try {
    await q(
      `INSERT INTO code_dispatch_log(imf_id, user_id, recipient_name, code_user,
           to_phone, to_email, channel, whatsapp_mode, email_mode, dispatched_by,
           origin, dispatched_role, receiver, previous_code, message, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [imfId, user.id || null, user.full_name || null, user.code_user || null,
       user.phone || null, user.email || null,
       d.channel === 'email' || d.channel === 'whatsapp' ? 'resend' : 'creation',
       d.whatsappMode, d.emailMode, d.dispatchedBy || null,
       d.origin || 'espace_imf', d.dispatchedRole || null,
       user.email || user.phone || null, d.previousCode || null,
       d.message || null, d.notes || null]);
    return;
  } catch (e) { /* colonnes absentes : on tente le format historique */ }
  try {
    await q(
      `INSERT INTO code_dispatch_log(imf_id, user_id, recipient_name, code_user,
           to_phone, to_email, channel, whatsapp_mode, email_mode, dispatched_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [imfId, user.id || null, user.full_name || null, user.code_user || null,
       user.phone || null, user.email || null,
       d.channel === 'email' || d.channel === 'whatsapp' ? 'resend' : 'creation',
       d.whatsappMode, d.emailMode, d.dispatchedBy || null]);
  } catch (e) { /* le journal est secondaire */ }
}
