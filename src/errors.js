// teebo — Gestion GLOBALE des erreurs (VAGUE 31)
// ---------------------------------------------------------------------------
// Objectif : une seule porte de sortie pour toutes les erreurs de l'API, qui
//  1. ne fait JAMAIS tomber le service (aucun accès non protégé) ;
//  2. ne fuit JAMAIS d'information technique vers le client en production ;
//  3. renvoie TOUJOURS un format exploitable par le site ({error, message}) ;
//  4. trace l'incident avec un identifiant de requête retrouvable dans Render ;
//  5. traduit les erreurs PostgreSQL en messages métier compréhensibles.
//
// NOTE HISTORIQUE : les correctifs du 13/11 ont réparé « req is not defined »
// dans la signature puis « ReferenceError: habilit is not defined ». Ce module
// remplace la logique en ligne de server.js par une version défensive :
// chaque accès aux objets de la requête est fait sous garde.
// ---------------------------------------------------------------------------
import crypto from 'crypto';

/* Codes PostgreSQL -> (statut HTTP, code API, message utilisateur) ---------- */
const PG_ERRORS = {
  '23502': [422, 'missing_column_value', 'Une information obligatoire n’a pas pu être enregistrée. Vérifiez tous les champs du formulaire.'],
  // VAGUE 49 : une reference inconnue (IMF, client, module) n'est pas une
  // panne du serveur mais une demande qui vise un objet inexistant : on
  // repond desormais 404 avec un code lisible, plus une erreur 500/422.
  '23503': [404, 'reference_introuvable', 'Cet enregistrement fait référence à un élément inexistant (institution, client ou module). Vérifiez votre sélection.'],
  '23505': [409, 'duplicate_value', 'Cet enregistrement existe déjà (valeur en double).'],
  '23514': [422, 'check_violation', 'Une valeur saisie ne respecte pas le format attendu par la réglementation.'],
  '22P02': [400, 'invalid_input_syntax', 'Le format d’une valeur saisie est invalide (nombre ou date).'],
  '22001': [400, 'value_too_long', 'Une valeur saisie est trop longue pour le champ concerné.'],
  '42703': [500, 'missing_column', 'Le serveur n’est pas à jour (colonne manquante en base). Prévenez l’administrateur.'],
  '42P01': [500, 'missing_table', 'Le serveur n’est pas à jour (table manquante en base). Prévenez l’administrateur.'],
  '42P02': [500, 'missing_type', 'Le serveur n’est pas à jour (type manquant en base). Prévenez l’administrateur.'],
  '40001': [503, 'retry_later', 'Trop d’opérations simultanées sur ce compte. Réessayez dans un instant.'],
  '57014': [503, 'query_timeout', 'Le traitement a dépassé le temps imparti. Réessayez dans un instant.']
};

/* Statuts HTTP dont le message est sûr à afficher -------------------------- */
const SAFE_STATUS = new Set([400, 401, 402, 403, 404, 405, 409, 410, 413, 415, 422, 423, 428, 429, 451]);

/* Messages français pour les codes métier les plus fréquents ----------------- */
/* (les routes lèvent souvent Error('compte_bloque') ; ce dictionnaire évite */
/*  d'afficher au client un identifiant technique à la place d'une phrase).  */
const METIER = {
  compte_bloque: 'Ce compte est bloqué : aucune opération n’est possible.',
  compte_introuvable: 'Le compte demandé est introuvable.',
  client_introuvable: 'Le client demandé est introuvable.',
  dossier_introuvable: 'Le dossier demandé est introuvable.',
  not_found: 'L’élément demandé est introuvable.',
  permission_denied: 'Vous ne disposez pas de cette habilitation. Contactez l’administrateur de votre IMF.',
  not_authenticated: 'Votre session a expiré. Reconnectez-vous.',
  savings_product_inconnu: 'Ce type d’épargne est inconnu ou désactivé.',
  savings_product_required: 'Choisissez d’abord un type d’épargne.',
  kyc_incomplet_pour_ce_produit: 'Le dossier KYC du client est incomplet pour ce produit.',
  coffre_insuffisant: 'Le solde du coffre est insuffisant pour cette opération.',
  bad_hierarchy: 'Ce rattachement hiérarchique n’est pas autorisé.',
  bad_supervisor: 'Le superviseur choisi n’est pas valide.',
  already_handled: 'Cette opération a déjà été traitée.',
  sod_self_validation: 'Vous ne pouvez pas valider une opération que vous avez vous-même saisie.',
  insufficient_funds: 'Le solde du compte est insuffisant.',
  frozen: 'Ce client est gelé : l’opération est refusée.',
  duplicate_value: 'Cet enregistrement existe déjà.'
};

/** Traduit un code métier en phrase lisible (ou renvoie null). */
function messageMetier(code) {
  if (!code || typeof code !== 'string') return null;
  if (METIER[code]) return METIER[code];
  // Un message déjà rédigé (avec espaces ou accents) est affichable tel quel.
  if (/\s/.test(code) || /[àâçéèêëîïôûùüÿœ]/i.test(code)) return code;
  // Un identifiant technique « mot_mot » : on le neutralise.
  if (/^[a-z0-9_.]+$/i.test(code)) return 'Cette demande n’a pas pu être traitée.';
  return code;
}

/** Identifiant court d'incident (retrouvable dans les journaux Render). */
function incidentId() {
  try { return crypto.randomBytes(6).toString('hex'); }
  catch (_) { return String(Date.now()); }
}

/** Extrait une URL lisible sans planter si l'objet manque. */
function safeUrl(req) {
  try { return String((req && (req.originalUrl || req.url)) || '-'); }
  catch (_) { return '-'; }
}

/** Le client attend-il du JSON (API) plutôt que du HTML ? */
function prefersJson(req) {
  try {
    const p = String((req && req.path) || '');
    if (p.startsWith('/api/')) return true;
    if (typeof req.accepts === 'function') return !!req.accepts(['json', 'html']) && req.accepts(['json', 'html']) === 'json';
  } catch (_) { /* on retombe sur JSON */ }
  return true;
}

/** Page HTML d'erreur (exports, pages ouvertes au navigateur). */
function htmlPage(status, title, body) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — teebo</title>
<style>body{font-family:'Segoe UI',system-ui,Arial,sans-serif;background:#eef0f6;color:#0b0c26;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
 .card{background:#fff;border-radius:12px;box-shadow:0 14px 44px rgba(11,12,38,.14);max-width:560px;padding:32px 34px}
 h1{font-size:19px;margin:0 0 10px}p{font-size:13.5px;line-height:1.7;color:#3c3f57;margin:0 0 10px}
 ul{font-size:13px;line-height:1.8;color:#3c3f57;padding-left:20px;margin:8px 0 14px}
 .tag{display:inline-block;background:#fdeceb;color:#b3261e;font-weight:700;font-size:11px;padding:5px 11px;border-radius:999px;margin-bottom:14px}
 a{display:inline-block;background:#0b0c26;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:11px 18px;border-radius:9px}</style>
</head><body><div class="card"><div class="tag">${status}</div>
<h1>${title}</h1>${body}
<a href="/app">Retour à l'application</a></div></body></html>`;
}

export function pageMonteeErreur() {
  return htmlPage(503, 'Service momentanément indisponible',
    '<p>Le service se prépare (mise à jour de la base de données). Réessayez dans une minute.</p>');
}

/**
 * Middleware de gestion globale des erreurs (à monter EN DERNIER).
 * @param {{expose?: boolean}} options expose=true en développement seulement
 */
export function gestionnaireErreurs(options = {}) {
  const isProd = process.env.NODE_ENV === 'production';
  const expose = options.expose !== undefined ? !!options.expose : !isProd;

  // eslint-disable-next-line no-unused-vars
  return function erreurHandler(err, req, res, next) {
    const id = incidentId();
    const url = safeUrl(req);
    const method = (req && req.method) || '-';
    const imf = (req && req.user && req.user.imf_id) || null;

    // 1) Réponse déjà engagée (téléchargement interrompu, flux) : on ne peut
    //    plus écrire d'en-tête. On signale à Express de couper la connexion.
    if (res && res.headersSent) {
      console.error(`[${id}] ${method} ${url} — erreur après envoi des en-têtes :`, err && (err.stack || err.message || err));
      try { if (typeof res.end === 'function') return res.end(); } catch (_) { /* ignoré */ }
      return undefined;
    }

    // 2) Analyse de l'erreur : corps JSON invalide, taille dépassée, pg…
    let status = 500;
    let code = 'server_error';
    let message = 'Une erreur est survenue sur le serveur. Réessayez dans un instant.';

    if (err) {
      // Corps JSON mal formé (express.json) -> 400 et non 500.
      if (err.type === 'entity.parse.failed') {
        status = 400; code = 'invalid_json';
        message = 'Les données envoyées sont illisibles (JSON invalide).';
      } else if (err.type === 'entity.too.large') {
        status = 413; code = 'payload_too_large';
        message = 'Le fichier envoyé est trop volumineux (limite 12 Mo).';
      } else if (err.code && PG_ERRORS[String(err.code)]) {
        // Erreur PostgreSQL connue : message métier clair.
        const [st, cd, msg] = PG_ERRORS[String(err.code)];
        status = err.status || st; code = cd; message = msg;
      } else if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        status = 401; code = 'session_invalide';
        message = 'Votre session a expiré. Reconnectez-vous.';
      } else if (err.status || err.statusCode) {
        // Erreur métier levée avec un statut (403, 404, 409, 422…) : on garde
        // le CODE technique (utile au site) mais on affiche une phrase claire.
        status = Number(err.status || err.statusCode) || 500;
        const brut = err.code || (typeof err.message === 'string' ? err.message : null) || 'error';
        code = brut;
        message = messageMetier(brut) || message;
      } else if (err.expose && typeof err.message === 'string') {
        code = err.message; message = err.message;
      }
    }

    // 3) En production, un 5xx ne doit jamais livrer le détail technique.
    if (status >= 500) {
      code = err && err.code && PG_ERRORS[String(err.code)] ? code : 'server_error';
      message = (status === 503 && code === 'query_timeout')
        ? 'Le traitement a dépassé le temps imparti. Réessayez dans un instant.'
        : 'Une erreur est survenue sur le serveur. Réessayez dans un instant.';
    }
    // Un 4xx hors liste sûre ne divulgue pas son message brut.
    if (status >= 400 && status < 500 && !SAFE_STATUS.has(status)) {
      message = 'La demande n’a pas pu être traitée.';
    }

    // 4) Journal : lisible, horodaté, avec l'identifiant d'incident.
    const niveau = status >= 500 ? 'ERREUR' : 'REFUS';
    console.error(
      `[${id}] ${niveau} ${method} ${url} -> ${status} ${code}` +
      (imf ? ` (imf=${imf})` : '')
    );
    if (status >= 500) {
      console.error(`[${id}] cause :`, (err && (err.stack || err.message)) || err);
      if (err && err.pg) console.error(`[${id}] pg :`, err.pg);
    }

    res.setHeader('X-Error-Id', id);
    res.setHeader('Cache-Control', 'no-store');

    // 5) Un export (PDF/Excel) demandé au navigateur : page lisible.
    const wantsFile = /\/exports\//.test(url);
    if (wantsFile && !prefersJson(req)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(status).send(htmlPage(status, 'Le fichier n’a pas pu être généré',
        `<p>L’export a rencontré une erreur et n’a produit aucun fichier.</p>
<ul><li>Rechargez la page et relancez l’export.</li>
<li>Si le message persiste, la base est peut-être en cours de mise à jour : réessayez dans une minute.</li>
<li>Les rapports restent accessibles depuis <b>Gouvernance › Conformité</b>.</li></ul>
<p style="font-size:11.5px;color:#8a8da3">Référence technique : ${id}</p>`));
    }

    // 6) Réponse JSON unique et prévisible pour le site.
    const payload = { error: code, message };
    if (status >= 500) payload.ref = id;
    if (expose && status >= 500 && err) payload.detail = String(err.message || err);
    if (err && err.required) payload.required = err.required;
    if (err && err.permission) payload.permission = err.permission;
    if (err && err.details) payload.details = err.details;
    return res.status(status).json(payload);
  };
}

/**
 * Enveloppe une route asynchrone pour que toute exception/rejet soit
 * effectivement transmis à la gestion globale d'erreurs.
 *
 * POURQUOI C'EST NÉCESSAIRE : Express 4 n'attend pas les promesses. Un
 * « async (req, res) » qui lève (ou dont un await échoue) sans try/catch
 * produit un rejet non géré : la requête RESTE SANS RÉPONSE (le navigateur
 * tourne dans le vide jusqu'au délai d'attente) et, selon la version de Node,
 * le service peut même s'arrêter. 276 gestionnaires async existent dans
 * l'API ; 185 utilisent déjà next(e), les autres sont exposés.
 *
 * Usage :  r.get('/x', asyncRoute(async (req, res) => { ... }))
 * Compatible Express 4 ET 5.
 */
export function asyncRoute(fn) {
  return function routeEnveloppee(req, res, next) {
    let out;
    try { out = fn(req, res, next); }
    catch (e) { return typeof next === 'function' ? next(e) : undefined; }
    if (out && typeof out.then === 'function') {
      Promise.resolve(out).catch((e) => {
        if (typeof next === 'function') next(e);
        else console.error('Rejet non transmis :', e);
      });
    }
    return out;
  };
}
export function routeInconnue() {
  // eslint-disable-next-line no-unused-vars
  return function notFound(req, res, next) {
    if (res && res.headersSent) return undefined;
    const url = safeUrl(req);
    if (/^\/api\//.test(url)) {
      return res.status(404).json({
        error: 'route_inconnue',
        message: 'Cette adresse de l’API n’existe pas ou a changé de version.',
        method: (req && req.method) || '-',
        path: url.split('?')[0]
      });
    }
    return typeof next === 'function' ? next() : undefined;
  };
}

export default { gestionnaireErreurs, routeInconnue, pageMonteeErreur, asyncRoute };
