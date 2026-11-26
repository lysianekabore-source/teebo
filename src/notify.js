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
    const debug = String(process.env.SMTP_DEBUG || '') === 'true';
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '') === 'true',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // Un serveur d'envoi injoignable ne doit jamais faire attendre l'ecran
      // plus de quelques secondes : l'administrateur doit voir l'echec.
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 25000,
      logger: debug,
      debug
    });
    if (debug) console.log(`[email] transport ${SMTP_HOST}:${Number(SMTP_PORT || 587)} (secure=${String(process.env.SMTP_SECURE || '') === 'true'})`);
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
 * Politique d'expediteur — la regle qui garantit qu'un message arrive.
 * ---------------------------------------------------------------------------
 * Un serveur d'envoi ne peut pas expédier « au nom » d'une adresse qu'il ne
 * possede pas : les filtres du destinataire rejettent alors le message, ou le
 * classent en indesirable, sans que l'application le sache.
 *
 * Regle appliquee ici :
 *   1. l'adresse TECHNIQUE (SMTP_FROM, a defaut SMTP_USER) est toujours celle
 *      du domaine authentifie (signature DKIM/SPF) — c'est elle qui part ;
 *   2. le NOM AFFICHE porte l'identite de l'IMF (« CODEC-Manga ») : le
 *      destinataire voit donc bien son institution ;
 *   3. les REPONSES sont dirigees vers l'adresse de l'IMF (Reply-To) ;
 *   4. une adresse d'IMF n'est utilisee comme expediteur reel que si son
 *      domaine figure parmi les domaines autorises (meme domaine que
 *      l'adresse technique, ou liste SMTP_ALLOWED_FROM).
 */
function parseFrom(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const m = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>\s]+)>\s*$/);
  if (m) return { name: String(m[1] || '').trim(), address: m[2].trim() };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { name: '', address: raw };
  return null;
}
function domainOf(address) {
  const a = String(address || '').trim().toLowerCase();
  const i = a.lastIndexOf('@');
  return i > 0 ? a.slice(i + 1) : '';
}
export function emailSenderPolicy(opts = {}) {
  const technical = parseFrom(process.env.SMTP_FROM) || parseFrom(process.env.SMTP_USER)
    || { name: 'teebo', address: 'no-reply@teebo.africa' };
  const imf = parseFrom(opts.fromEmail);
  const imfName = String(opts.fromName || '').trim() || (imf ? imf.name : '');
  const allowed = new Set([domainOf(technical.address)]);
  String(process.env.SMTP_ALLOWED_FROM || '').split(',').forEach((d) => {
    const dom = String(d).trim().toLowerCase().replace(/^@/, '');
    if (dom) allowed.add(dom);
  });
  if (imf && domainOf(imf.address) && allowed.has(domainOf(imf.address))) {
    return { from: { name: imfName || imf.address, address: imf.address },
      replyTo: imf.address, technical: technical.address, imf: imf.address, sameDomain: true };
  }
  return { from: { name: imfName || technical.name || 'teebo', address: technical.address },
    replyTo: imf ? imf.address : undefined, technical: technical.address,
    imf: imf ? imf.address : '', sameDomain: false };
}

/** Verifie reellement la passerelle (connexion + authentification SMTP). */
export async function verifyEmailGateway() {
  const t = getTransporter();
  const host = process.env.SMTP_HOST || '';
  const port = Number(process.env.SMTP_PORT || 587);
  if (!t) {
    return { ok: false, configured: false, host, port,
      error: 'Passerelle e-mail non configuree : SMTP_HOST / SMTP_USER / SMTP_PASS manquants.' };
  }
  try {
    await t.verify();
    return { ok: true, configured: true, host, port, from: emailSenderPolicy().technical };
  } catch (e) {
    return { ok: false, configured: true, host, port, error: e.message, code: e.code || null,
      hint: /535|5355|5\.7\.139|auth/i.test(String(e.message))
        ? "Authentification refusee : pour Microsoft 365, cocher « SMTP authentifie » sur la boite, ou utiliser un relais." : null };
  }
}

/** Trace l'etat de la passerelle au demarrage : une ligne suffit a diagnostiquer. */
export async function logEmailGateway() {
  if (!emailGatewayReady()) {
    console.warn('[email] PASSERELLE ABSENTE — SMTP_HOST / SMTP_USER / SMTP_PASS manquants : aucun e-mail ne peut partir.');
    return { ok: false, configured: false };
  }
  const v = await verifyEmailGateway().catch((e) => ({ ok: false, error: e.message }));
  if (v.ok) {
    console.log(`[email] passerelle OK — ${v.host}:${v.port} · expediteur technique ${v.from}`);
  } else {
    console.warn(`[email] PASSERELLE EN ECHEC — ${v.error}${v.hint ? ' · ' + v.hint : ''}`);
  }
  return v;
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
  const policy = emailSenderPolicy(opts);
  const from = policy.from;
  const replyTo = policy.replyTo;
  try {
    const info = await t.sendMail({
      from, to: dest, subject, text, replyTo,
      html: `<div style="font-family:system-ui,Segoe UI,Arial;font-size:14px;line-height:1.6;color:#0b0c26">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`
    });
    const accepted = Array.isArray(info && info.accepted) ? info.accepted.map(String) : [];
    const rejected = Array.isArray(info && info.rejected) ? info.rejected.map(String) : [];
    // Un message « accepte » mais dont TOUS les destinataires sont refuses n'a
    // pas ete remis : on ne doit jamais annoncer un envoi reussi dans ce cas.
    if (accepted.length === 0) {
      console.warn(`[email] refuse pour ${dest} : ${rejected.join(', ') || 'aucun destinataire accepte'}`);
      return { ok: false, mode: 'failed', from: `${from.name} <${from.address}>`,
        replyTo: replyTo || null, accepted, rejected,
        error: 'Le serveur d\u2019envoi a refuse le destinataire (' + (rejected.join(', ') || 'sans motif') + ').',
        link: mailtoLink(dest, subject, text) };
    }
    const smtpResponse = String((info && info.response) || '').replace(/\s+/g, ' ').slice(0, 120);
    console.log(`[email] accepte par ${process.env.SMTP_HOST}:${dest} — ${smtpResponse || 'sans detail'}`);
    return { ok: true, mode: 'sent', id: info && info.messageId,
      accepted, rejected, response: smtpResponse,
      from: `${from.name} <${from.address}>`, replyTo: replyTo || null,
      technical_from: policy.technical, imf_from: policy.imf, same_domain: policy.sameDomain };
  } catch (e) {
    const hint = /535|5\.7\.139|auth/i.test(String(e.message))
      ? "Authentification refusee : pour Microsoft 365, cocher « SMTP authentifie » sur la boite, ou utiliser un relais."
      : (/5\.7\.60|send as|permission/i.test(String(e.message))
        ? "Adresse d'expedition non autorisee par le serveur : l'expediteur doit appartenir au domaine authentifie."
        : null);
    console.error(`[email] echec envoi a ${dest} : ${e.message}${hint ? ' (' + hint + ')' : ''}`);
    return { ok: false, mode: 'failed', error: e.message, code: e.code || null, hint,
      from: `${from.name} <${from.address}>`, replyTo: replyTo || null,
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

// v80: real delivery verdicts; the durable CMS inbox is separate from provider delivery.
async function cmsSms(to,text,id){
 const endpoint=process.env.CMS_SMS_GATEWAY_URL,token=process.env.CMS_SMS_GATEWAY_TOKEN;
 if(!endpoint||!token)return {ok:false,configured:false,channel:'sms',error:'Passerelle SMS non configurée.'};
 if(!to)return {ok:false,configured:true,channel:'sms',error:'Téléphone du client absent.'};
 try{const u=new URL(endpoint);if(u.protocol!=='https:')throw Error('Passerelle HTTPS requise.');
 return await new Promise(resolve=>{const payload=JSON.stringify({to,message:text,reference:id});const req=https.request(u,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),'Idempotency-Key':id},timeout:15000},res=>{let body='';res.on('data',b=>{if(body.length<10000)body+=b;});res.on('end',()=>{let json={};try{json=JSON.parse(body);}catch{}resolve({ok:res.statusCode>=200&&res.statusCode<300&&json.ok===true,configured:true,channel:'sms',status:res.statusCode,error:json.ok===true?null:'Le prestataire n’a pas confirmé la remise.'});});});req.on('timeout',()=>req.destroy(Error('Délai SMS dépassé')));req.on('error',e=>resolve({ok:false,configured:true,channel:'sms',error:e.message}));req.end(payload);});
 }catch(e){return {ok:false,configured:true,channel:'sms',error:e.message};}}
export async function deliverCmsNotification(job,ctx,subscriptions=[]){
 if(job.type==='LEAD_AGENT'){
  if(!ctx.agent_email||!emailGatewayReady())return {ok:false,configured:false,channel:'email',inbox:true,error:'Rappel disponible dans la boîte des agents ; e-mail non configuré ou destinataire absent.'};
  const r=await notifyEmail(ctx.agent_email,'Demande de rappel — '+ctx.nom_imf,ctx.client_name+' souhaite être rappelé à propos de « '+ctx.titre+' ». Téléphone : '+(ctx.phone||'non renseigné')+'. Consultez les Demandes de rappel clients dans Teebo.');
  return {ok:r.ok===true&&r.mode!=='sent_simulated',configured:true,channel:'email',inbox:true,error:r.error||null};
 }
 const text=ctx.nom_imf+' — '+ctx.titre;const outcomes=[];
 if(process.env.CMS_VAPID_PUBLIC_KEY&&process.env.CMS_VAPID_PRIVATE_KEY&&subscriptions.length){
  const push=require('web-push');push.setVapidDetails(process.env.CMS_VAPID_SUBJECT||'mailto:hello@teebo.africa',process.env.CMS_VAPID_PUBLIC_KEY,process.env.CMS_VAPID_PRIVATE_KEY);
  for(const s of subscriptions){try{await push.sendNotification(s,JSON.stringify({title:ctx.nom_imf,body:ctx.titre,url:'/client'}),{TTL:3600,timeout:15000});outcomes.push({ok:true,configured:true,channel:'push'});}catch(e){outcomes.push({ok:false,configured:true,channel:'push',error:String(e.statusCode||e.message)});}}
 }else outcomes.push({ok:false,configured:false,channel:'push',error:'Push non configuré ou client non abonné.'});
 if(!outcomes.some(o=>o.ok))outcomes.push(await cmsSms(ctx.phone,text,job.id));
 return {ok:outcomes.some(o=>o.ok),configured:outcomes.some(o=>o.configured),channels:outcomes};
}
