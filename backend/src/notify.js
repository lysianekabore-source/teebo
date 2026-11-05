import https from 'https';
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
    return { ok: true, mode: 'dev' };
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

export async function notifyEmail(toEmail, subject, text) {
  const t = getTransporter();
  if (!t) {
    console.log(`[email:DEV] -> ${toEmail} | ${subject}\n${text}`);
    return { ok: true, mode: 'dev' };
  }
  const from = process.env.SMTP_FROM || 'teebo <no-reply@teebo.africa>';
  try {
    const info = await t.sendMail({
      from, to: toEmail, subject, text,
      html: `<div style="font-family:system-ui,Segoe UI,Arial;font-size:14px;line-height:1.6;color:#0b0c26">${text.replace(/\n/g, '<br>')}</div>`
    });
    return { ok: true, id: info.messageId };
  } catch (e) {
    console.error('[email] echec envoi :', e.message);
    return { ok: false, error: e.message };
  }
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
