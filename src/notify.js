import https from 'https';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Notifications sortantes : WhatsApp (API Cloud) + e-mail (SMTP).
 * Coordonnees teebo de destination :
 *   WhatsApp : +22650321432
 *   E-mail   : hello@teebo.africa
 *
 * En l'absence de configuration (variables d'environnement), le message
 * est journalise au lieu d'etre envoye (mode degrade sur pour dev).
 */

export const TEEBO_WHATSAPP = process.env.TEEBO_WHATSAPP || '+22650321432';
export const TEEBO_EMAIL = process.env.TEEBO_EMAIL || 'hello@teebo.africa';

// URL publique de l'API (backend Render) : sert à construire des liens
// ABSOLUS (facture...) utilisables depuis WhatsApp ou un e-mail.
export const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || process.env.PUBLIC_BASE_URL ||
  'https://teebo-api-p825.onrender.com').replace(/\/+$/, '');
// Site public teebo (page de connexion de l'IMF).
// PUBLIC_SITE_URL ne sert QUE de valeur de secours : c'est le site réellement
// utilisé (déduit de la requête : origine du navigateur, Referer de la page de
// connexion, ou en-tête X-Site-URL) qui prime. Ainsi le lien envoyé dans les
// messages de code d'accès pointe toujours vers LA page de connexion du client
// (ex. https://teebo-imf.netlify.app/login) et jamais vers un domaine générique.
export const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://teebo-imf.netlify.app').replace(/\/+$/, '');

/** Retire le chemin et normalise une origine (https://site.com/ → https://site.com). */
export function cleanOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.origin;
  } catch (_) { return ''; }
}

/**
 * Origine du SITE vue par l'utilisateur, pour construire les liens de connexion.
 * Ordre de priorité :
 *   1. en-tête X-Site-URL (posé par la règle de redirection / le proxy Netlify) ;
 *   2. header Origin (appels XHR/fetch) ;
 *   3. Referer (page d'où part la requête : /app.html, /login…) ;
 *   4. PUBLIC_SITE_URL (réglage explicite de l'exploitant, s'il est défini) ;
 *   5. site teebo par défaut.
 * Un Referer ou une origine « localhost/127.0.0.1 » est ignoré (lien inutilisable
 * pour un destinataire). Le résultat ne contient jamais de double slash final.
 */
export function siteBaseFrom(req) {
  const h = (req && req.headers) || {};
  // Raccourci : un X-Site-URL valide est la source la plus fiable.
  const hinted = cleanOrigin(h['x-site-url']);
  if (hinted && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(hinted)) return hinted;
  const candidates = [h['x-site-url'], h['x-forwarded-host'] && h['x-forwarded-proto']
    ? `${h['x-forwarded-proto']}://${h['x-forwarded-host']}` : '', h.origin, h.referer];
  // Une valeur explicite de l'exploitant (PUBLIC_SITE_URL) est respectée :
  // elle passe avant la dernière origine vue, mais jamais avant les en-têtes
  // réellement transmis par la requête en cours.
  const explicitSite = String(process.env.PUBLIC_SITE_URL || '').trim()
    ? cleanOrigin(process.env.PUBLIC_SITE_URL) : '';
  const ordered = candidates.slice(0, 4).concat(explicitSite ? [explicitSite] : [], candidates.slice(4));
  for (const c of ordered) {
    const o = cleanOrigin(c);
    if (o && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(o)) return o;
  }
  return PUBLIC_SITE_URL;
}

/** URL de la page de connexion (premier accès + mot de passe). */
export function loginUrlFor(req) { return `${siteBaseFrom(req)}/login`; }

/**
 * Lien « click-to-chat » WhatsApp (https://wa.me/<numero>?text=...).
 * Fonctionne SANS compte WhatsApp Business / API Cloud : il ouvre
 * directement WhatsApp (appli ou web) avec le message pré-rempli, prêt
 * à envoyer. C'est le moyen de secours garanti pour l'administrateur teebo.
 */
export function waLink(toPhone, message) {
  const digits = String(toPhone || '').replace(/[^0-9]/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(message || '')}`;
}

/** Lien mailto: pré-rempli (fonctionne sans SMTP, via le client mail de l'admin). */
export function mailtoLink(toEmail, subject, body) {
  return `mailto:${encodeURIComponent(toEmail || '')}` +
    `?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
}

/** Jeton HMAC court pour sécuriser un lien de document public (facture). */
function docSecret() {
  return process.env.DOC_LINK_SECRET || process.env.TEEBO_ADMIN_PASSWORD || 'teebo-doc-link-secret';
}
export function signDocToken(id) {
  return crypto.createHmac('sha256', docSecret()).update(String(id)).digest('hex').slice(0, 24);
}
export function verifyDocToken(id, token) {
  const expected = signDocToken(id);
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** Lien ABSOLU et PUBLIC (tokenisé) vers la facture définitive, ouvrable par l'IMF. */
export function invoicePublicUrl(invoiceId) {
  return `${PUBLIC_API_URL}/api/v1/requests/invoices/${invoiceId}.pdf?t=${signDocToken(invoiceId)}`;
}

/** Indique si une passerelle e-mail (SMTP) est réellement configurée. */
export function emailGatewayReady() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER) return null;
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '') === 'true',
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    return transporter;
  } catch (e) {
    console.warn('[email] nodemailer indisponible :', e.message);
    return null;
  }
}

export async function notifyWhatsApp(toPhone, message) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) {
    console.log(`[whatsapp:DEV] -> ${toPhone}: ${message}`);
    // Mode dégradé (API Cloud non configurée) : on renvoie un lien
    // « click-to-chat » pour permettre un envoi manuel immédiat.
    return { ok: true, mode: 'dev', link: waLink(toPhone, message) };
  }
  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    to: toPhone.replace(/[^0-9]/g, ''),
    type: 'text',
    text: { body: message }
  });
  return httpPost(`https://graph.facebook.com/v20.0/${phoneId}/messages`, body,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
}

/**
 * Envoi d'e-mail.
 * opts.fromName / opts.fromEmail : expéditeur propre à l'IMF (paramètres IMF).
 *   L'enveloppe technique reste celle du compte SMTP (obligatoire), mais
 *   l'en-tête « De : » et le « Répondre à : » portent l'identité de l'IMF :
 *   le destinataire voit donc l'institution comme expéditeur et ses
 *   réponses reviennent à l'adresse de l'IMF.
 */
export async function notifyEmail(toEmail, subject, text, opts = {}) {
  const dest = String(toEmail || '').trim();
  if (!dest || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dest)) {
    return { ok: false, mode: 'invalid_recipient',
      error: 'Adresse e-mail du destinataire absente ou invalide.' };
  }
  const t = getTransporter();
  if (!t) {
    console.log(`[email:NOT_CONFIGURED] -> ${dest} | ${subject}\n${text}`);
    // Passerelle non configurée : rien n'est envoyé, on renvoie un lien
    // mailto pour un envoi manuel depuis la messagerie de l'admin.
    return { ok: false, mode: 'not_configured',
      error: 'Passerelle e-mail non configurée sur le serveur (SMTP).',
      link: mailtoLink(dest, subject, text) };
  }
  // Mode démonstration volontairement simulé (aucune passerelle réelle) :
  // à utiliser uniquement pour les environnements de test.
  if (String(process.env.EMAIL_SIMULATION || '') === 'true') {
    console.log(`[email:SIMULATED] -> ${dest} | ${subject}`);
    return { ok: true, mode: 'sent_simulated', id: 'simulated' };
  }
  const fallbackFrom = process.env.SMTP_FROM || 'teebo <no-reply@teebo.africa>';
  const senderEmail = String(opts.fromEmail || '').trim();
  const senderName = String(opts.fromName || '').trim();
  const from = senderEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)
    ? { name: senderName || senderEmail, address: senderEmail }
    : fallbackFrom;
  const replyTo = senderEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail) ? senderEmail : undefined;
  try {
    const info = await t.sendMail({
      from, to: dest, subject, text, replyTo,
      html: `<div style="font-family:system-ui,Segoe UI,Arial;font-size:14px;line-height:1.6;color:#0b0c26">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`
    });
    return { ok: true, mode: 'sent', id: info && info.messageId,
      accepted: info && info.accepted ? info.accepted.length : null,
      from: typeof from === 'string' ? from : `${from.name} <${from.address}>` };
  } catch (e) {
    console.error('[email] echec envoi :', e.message);
    return { ok: false, mode: 'failed', error: e.message,
      link: mailtoLink(dest, subject, text) };
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function httpPost(url, body, headers) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    }, (r) => {
      let d = ''; r.on('data', (c) => d += c);
      r.on('end', () => resolve({ ok: r.statusCode < 300, status: r.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body); req.end();
  });
}

/**
 * Alerte de sécurité prioritaire (appareil inconnu, terminal révoqué...).
 * Notifie immédiatement l'équipe teebo (WhatsApp + e-mail) et journalise.
 * Pour un appareil inconnu, la priorité est haute.
 */
export async function notifySecurityAlert(info = {}) {
  const prio = info.kind === 'unknown_device' ? 'PRIORITÉ HAUTE' : 'SÉCURITÉ';
  const lines = [
    `[${prio}] Alerte sécurité teebo`,
    `Type : ${info.kind || 'n/a'}`,
    info.imf_id ? `IMF : ${info.imf_id}` : `IMF : non identifiée (appareil inconnu)`,
    info.identifier ? `Identifiant saisi : ${info.identifier}` : null,
    info.imei ? `IMEI : ${info.imei}` : null,
    info.mac ? `MAC : ${info.mac}` : null,
    `Horodatage : ${new Date().toISOString()}`
  ].filter(Boolean).join('\n');
  console.warn(lines);
  try {
    await notifyWhatsApp(TEEBO_WHATSAPP, lines);
    await notifyEmail(TEEBO_EMAIL, `[teebo] ${prio} — ${info.kind || 'alerte'}`, lines);
  } catch (e) {
    console.warn('[security-alert] notification non envoyée :', e.message);
  }
  return { ok: true };
}
