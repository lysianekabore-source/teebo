// teebo — Envoi des e-mails transactionnels (invitation d'un nouvel utilisateur).
// ---------------------------------------------------------------------------
// Deux modes, choisis automatiquement selon les variables d'environnement :
//   • MODE RÉEL  : si SMTP_HOST est défini -> envoi via SMTP (nodemailer).
//   • MODE MOCK  : sinon -> l'e-mail n'est PAS envoyé, son contenu est affiché
//                  dans les logs du serveur. Pratique pour tester sans serveur
//                  d'e-mail (comme le mode MOCK côté paiement).
// La création d'un compte ne doit JAMAIS échouer à cause de l'e-mail : en cas
// d'erreur d'envoi, on journalise et on renvoie { sent:false } sans lever.
// ---------------------------------------------------------------------------

// Variables d'environnement reconnues :
//   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE ('1' pour 465/TLS implicite),
//   SMTP_USER, SMTP_PASS, MAIL_FROM ('teebo <no-reply@teebo.io>'),
//   APP_BASE_URL (URL du site Netlify, ex. https://teebo-habilitations.netlify.app)

const FROM = process.env.MAIL_FROM || 'teebo <no-reply@teebo.io>';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');

// Transport SMTP mis en cache (créé une seule fois, à la demande).
let _transport;
let _transportTried = false;
async function getTransport() {
  if (_transportTried) return _transport;
  _transportTried = true;
  if (!process.env.SMTP_HOST) { _transport = null; return null; }
  try {
    const { default: nodemailer } = await import('nodemailer');
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === '1', // true pour le port 465
      auth: (process.env.SMTP_USER || process.env.SMTP_PASS)
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    });
  } catch (e) {
    console.warn('[mailer] nodemailer indisponible, bascule en mode MOCK :', e.message);
    _transport = null;
  }
  return _transport;
}

// Échappe le texte inséré dans le gabarit HTML (anti-injection).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Construit le lien de connexion (préremplit l'e-mail via ?email=...).
function loginLink(email) {
  if (!APP_BASE_URL) return '(configurez APP_BASE_URL pour inclure le lien)';
  return APP_BASE_URL + '/?email=' + encodeURIComponent(email || '');
}

// Gabarit de l'e-mail d'invitation (texte + HTML).
function buildInvitation({ full_name, imfName, email, password }) {
  const link = loginLink(email);
  const subject = 'Votre accès teebo — ' + (imfName || 'votre IMF');
  const text =
    'Bonjour ' + (full_name || '') + ',\n\n' +
    'Un compte vient d\'être créé pour vous sur la plateforme teebo' +
    (imfName ? ' (' + imfName + ')' : '') + '.\n\n' +
    'Vos identifiants de première connexion :\n' +
    '  • E-mail       : ' + email + '\n' +
    '  • Mot de passe : ' + password + '\n\n' +
    'Connectez-vous ici : ' + link + '\n\n' +
    'Pour votre sécurité, vous devrez CHANGER ce mot de passe dès la première connexion.\n\n' +
    'L\'équipe teebo';
  const html =
    '<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto;color:#0f172a">' +
    '<h2 style="color:#0d9488">Bienvenue sur teebo</h2>' +
    '<p>Bonjour <strong>' + esc(full_name) + '</strong>,</p>' +
    '<p>Un compte vient d\'être créé pour vous' +
    (imfName ? ' sur <strong>' + esc(imfName) + '</strong>' : '') + '.</p>' +
    '<table style="border-collapse:collapse;margin:14px 0">' +
    '<tr><td style="padding:6px 10px;color:#64748b">E-mail</td><td style="padding:6px 10px"><strong>' + esc(email) + '</strong></td></tr>' +
    '<tr><td style="padding:6px 10px;color:#64748b">Mot de passe</td><td style="padding:6px 10px"><strong>' + esc(password) + '</strong></td></tr>' +
    '</table>' +
    (APP_BASE_URL
      ? '<p><a href="' + esc(link) + '" style="display:inline-block;background:#0d9488;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Se connecter</a></p>'
      : '') +
    '<p style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:10px 12px;font-size:14px;color:#7c5a12">' +
    '⚠ Pour votre sécurité, vous devrez <strong>changer ce mot de passe</strong> dès la première connexion.</p>' +
    '<p style="color:#64748b;font-size:13px">L\'équipe teebo</p>' +
    '</div>';
  return { subject, text, html };
}

// Envoie l'e-mail d'invitation. Ne lève jamais : renvoie { sent, mock, error? }.
export async function sendInvitationEmail({ to, full_name, imfName, email, password }) {
  const msg = buildInvitation({ full_name, imfName, email, password });
  const transport = await getTransport();
  if (!transport) {
    // MODE MOCK : on affiche l'e-mail dans les logs, sans l'envoyer.
    console.log('\n[MOCK EMAIL] → ' + to + '\n  Sujet : ' + msg.subject + '\n' +
      msg.text.split('\n').map((l) => '  ' + l).join('\n') + '\n');
    return { sent: false, mock: true };
  }
  try {
    await transport.sendMail({ from: FROM, to, subject: msg.subject, text: msg.text, html: msg.html });
    return { sent: true, mock: false };
  } catch (e) {
    console.warn('[mailer] échec d\'envoi à ' + to + ' :', e.message);
    return { sent: false, mock: false, error: e.message };
  }
}
