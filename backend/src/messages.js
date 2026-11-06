/**
 * teebo — Modèles de messages (WhatsApp + e-mail)
 * ---------------------------------------------------------------------------
 * Tous les libellés d'envoi de codes d'accès et de factures sont centralisés
 * ici afin de rester cohérents partout. Chaque message précise EXPRESSÉMENT que
 * l'utilisateur doit CRÉER SON MOT DE PASSE DÈS LA PREMIÈRE CONNEXION.
 *
 * `APP_URL` : adresse publique de connexion (surchargeable par variable
 * d'environnement selon l'environnement de déploiement).
 */
export const APP_URL = process.env.TEEBO_APP_URL || 'https://teebo-imf.netlify.app';

/** Premier accès admin IMF (approbation d'une demande). */
export function msgAdminAccessCode({ imfCode, code, invoiceNo }) {
  return [
    `teebo : votre accès à l'essai gratuit de 30 jours est approuvé.`,
    `IMF ${imfCode} — code d'accès administrateur : ${code}.`,
    invoiceNo ? `Facture définitive ${invoiceNo} disponible dans votre espace.` : null,
    `À votre PREMIÈRE CONNEXION sur ${APP_URL}, vous devrez CRÉER VOTRE MOT DE PASSE,`,
    `puis activer la double authentification. Ce code d'accès ne remplace pas le mot de passe.`
  ].filter(Boolean).join(' ');
}

/** Renvoi / rappel d'un code d'accès (sans régénération). */
export function msgResendCode({ imfCode, code }) {
  return [
    `teebo : rappel de votre code d'accès administrateur (IMF ${imfCode}) : ${code}.`,
    `Connectez-vous sur ${APP_URL} et, à la première connexion, CRÉEZ VOTRE MOT DE PASSE.`
  ].join(' ');
}

/** Nouveau code d'accès après régénération (ancien mot de passe effacé). */
export function msgRegeneratedCode({ imfCode, code }) {
  return [
    `teebo : votre NOUVEAU code d'accès administrateur (IMF ${imfCode}) : ${code}.`,
    `L'ancien mot de passe a été effacé : connectez-vous sur ${APP_URL} et`,
    `CRÉEZ À NOUVEAU VOTRE MOT DE PASSE dès cette première connexion.`
  ].join(' ');
}

/** Création d'un utilisateur par l'admin IMF. */
export function msgUserAccessCode({ code, fullName }) {
  return [
    fullName ? `teebo : bonjour ${fullName}, votre accès est créé.` : `teebo : votre accès est créé.`,
    `Code d'accès : ${code}.`,
    `Connectez-vous sur ${APP_URL} et, DÈS LA PREMIÈRE CONNEXION, CRÉEZ VOTRE MOT DE PASSE`,
    `(puis activez la double authentification).`
  ].join(' ');
}

/** Renvoi du code d'accès d'un utilisateur par l'admin IMF. */
export function msgUserResendCode({ code, fullName }) {
  return [
    fullName ? `teebo : bonjour ${fullName}, rappel de votre code d'accès : ${code}.` : `teebo : rappel de votre code d'accès : ${code}.`,
    `Connectez-vous sur ${APP_URL} et CRÉEZ VOTRE MOT DE PASSE à la première connexion.`
  ].join(' ');
}

/** Code à usage unique de réinitialisation (mot de passe oublié). */
export function msgResetCode({ code, minutes }) {
  return [
    `teebo : code de réinitialisation de votre mot de passe : ${code}.`,
    `Valable ${minutes} minutes. Saisissez-le sur ${APP_URL} pour CHOISIR UN NOUVEAU MOT DE PASSE.`,
    `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`
  ].join(' ');
}

/** Transmission d'une facture (proforma ou définitive) par l'éditeur teebo. */
export function msgInvoice({ kind, invoiceNo, imfName, url }) {
  const label = kind === 'definitive' ? 'facture définitive' : 'facture proforma';
  return [
    `teebo : votre ${label} ${invoiceNo}${imfName ? ' (' + imfName + ')' : ''} est disponible.`,
    url ? `Consultez-la ici : ${url}` : null
  ].filter(Boolean).join(' ');
}
