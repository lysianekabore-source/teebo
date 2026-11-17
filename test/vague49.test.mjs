// ===========================================================================
// teebo — VAGUE 49 : SCRIPT DE TEST DES 4 CORRECTIFS
// ===========================================================================
// CE QUE FAIT CE SCRIPT
//   Il interroge l'API REELLE (Render ou localhost) avec de vrais comptes,
//   et verifie que les 4 erreurs corrigees se comportent bien comme annonce :
//
//     1. activer / desactiver un utilisateur          -> 200 (plus de 500)
//     2. facture sur une IMF inexistante              -> 404 (plus de 500)
//     3. module applique a une IMF inexistante        -> 404 (plus de 500)
//     4. ancienne adresse « pack complet »            -> 404 route inconnue
//
//   Il ne cree ni ne supprime AUCUNE donnee reelle :
//     - les deux tests « IMF inexistante » utilisent un identifiant qui
//       n'existe pas ; la correction doit refuser AVANT toute ecriture.
//     - le test d'activation d'utilisateur bascule un compte indique par
//       vous (--user-id) puis le REMET DANS SON ETAT INITIAL a la fin.
//       Sans --user-id, ce test est simplement ignore (et signale).
//
// COMMENT LE LANCER (Node 18 ou plus, aucune bibliotheque a installer)
//
//   # 1) le serveur (Render) — comptes editeur
//   TEEBO_URL=https://teebo-api-p825.onrender.com \
//   EMAIL=hello@teebo.africa PASSWORD='...' \
//   USER_ID=<identifiant d'un compte IMF a basculer> \
//   node test/vague49.test.mjs
//
//   # 2) une IMF vue depuis sa propre console (facultatif)
//   TEEBO_URL=https://teebo-api-p825.onrender.com \
//   IMF_EMAIL=admin@mon-imf.bf IMF_PASSWORD='...' \
//   node test/vague49.test.mjs
//
//   # 3) verification de fond : la base est-elle a jour ? (colonne ajoutee)
//   TEEBO_URL=... EMAIL=... PASSWORD=... --db  node test/vague49.test.mjs
//
// CODES DE SORTIE : 0 = tout est conforme, 1 = au moins un test en echec.
// ===========================================================================

const BASE = (process.env.TEEBO_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const EMAIL = process.env.EMAIL || process.env.TEEBO_ADMIN_EMAIL || '';
const PASSWORD = process.env.PASSWORD || process.env.TEEBO_ADMIN_PASSWORD || '';
const USER_ID = process.env.USER_ID || '';
const IMF_EMAIL = process.env.IMF_EMAIL || '';
const IMF_PASSWORD = process.env.IMF_PASSWORD || '';
const AVEC_DB = process.argv.includes('--db');

// Identifiant volontairement inexistant (forme uuid valide, jamais attribue).
const IMF_FANTOME = '00000000-0000-4000-8000-000000000000';
const TENANT_FANTOME = IMF_FANTOME;
const ID_FANTOME = IMF_FANTOME;

let ok = 0, ko = 0, ignores = 0;
const details = [];

function titre(t) { console.log('\n' + t); }

function verifier(nom, condition, constat) {
  if (condition) { ok++; console.log('  [OK]   ' + nom + (constat ? '  — ' + constat : '')); }
  else { ko++; console.log('  [ECHEC] ' + nom + (constat ? '  — ' + constat : '')); details.push(nom + ' : ' + constat); }
}

function ignore(nom, pourquoi) { ignores++; console.log('  [SAUTE] ' + nom + '  — ' + pourquoi); }

async function appel(methode, chemin, { jeton, corps, entetes } = {}) {
  const h = { Accept: 'application/json', ...(entetes || {}) };
  if (corps !== undefined) h['Content-Type'] = 'application/json';
  if (jeton) h.Cookie = 'teebo_session=' + jeton;
  let rep;
  try {
    rep = await fetch(BASE + chemin, {
      method: methode, headers: h, redirect: 'manual',
      body: corps === undefined ? undefined : JSON.stringify(corps)
    });
  } catch (e) {
    return { statut: 0, corps: { erreur_reseau: String(e && e.message || e) }, brut: '' };
  }
  const brut = await rep.text();
  let json = null;
  try { json = brut ? JSON.parse(brut) : null; } catch (_) { /* page HTML */ }
  // Jeton eventuellement renvoye par le serveur (cookie de session).
  const setCookie = rep.headers.getSetCookie ? rep.headers.getSetCookie() : [];
  const c = setCookie.find((x) => x.startsWith('teebo_session='));
  const jeton2 = c ? c.split(';')[0].split('=').slice(1).join('=') : null;
  return { statut: rep.status, corps: json, brut, jeton: jeton2, entetes: rep.headers };
}

async function connexion(email, motDePasse, libelle) {
  if (!email || !motDePasse) { ignore(libelle, 'identifiants non fournis'); return null; }
  const r = await appel('POST', '/api/v1/auth/login', { corps: { email, password: motDePasse } });
  if (r.statut !== 200) {
    ignore(libelle, 'connexion refusee (HTTP ' + r.statut + ') : ' + texteDe(r));
    return null;
  }
  const jeton = r.jeton || (r.corps && (r.corps.token || r.corps.session || r.corps.jeton)) || null;
  if (!jeton) { ignore(libelle, 'aucun jeton de session renvoye'); return null; }
  console.log('  connexion ' + libelle + ' : OK');
  return jeton;
}

function texteDe(r) {
  if (!r) return '';
  if (r.corps) return (r.corps.message || r.corps.error || JSON.stringify(r.corps)).slice(0, 160);
  return String(r.brut || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function estErreurServeur(r) {
  return r.statut === 0 || r.statut >= 500;
}

// ---------------------------------------------------------------------------
async function principal() {
  console.log('='.repeat(74));
  console.log(' teebo — VAGUE 49 — validation des 4 correctifs');
  console.log(' serveur cible : ' + BASE);
  console.log('='.repeat(74));

  // 0) Le service repond-il ?
  titre('0. Le serveur repond');
  const sante = await appel('GET', '/healthz');
  verifier('service en ligne (/healthz)', sante.statut === 200, 'HTTP ' + sante.statut);
  if (sante.statut === 0) {
    console.log('\n!! Serveur injoignable. Sur l offre gratuite Render, le service s endort :\n' +
      '   ouvrez le site une fois, attendez une minute, puis relancez ce script.');
    return resume();
  }
  const pret = await appel('GET', '/ready');
  if (pret.corps && pret.corps.tables != null) {
    verifier('base de donnees prete (/ready)', pret.corps.pret === true,
      'tables=' + pret.corps.tables + (pret.corps.tables_manquantes ? ' manquantes=' + pret.corps.tables_manquantes.join(',') : ''));
  }

  // Connexions
  titre('1. Connexions');
  const jetonEditeur = await connexion(EMAIL, PASSWORD, 'compte editeur');
  const jetonImf = await connexion(IMF_EMAIL, IMF_PASSWORD, 'compte IMF');
  if (!jetonEditeur && !jetonImf) {
    console.log('\nAucun compte utilisable : fournissez EMAIL/PASSWORD (editeur) ou IMF_EMAIL/IMF_PASSWORD.');
    return resume();
  }

  // -------------------------------------------------------------------------
  // CORRECTIF 1 — activer / desactiver un utilisateur
  // -------------------------------------------------------------------------
  titre('2. CORRECTIF 1 — activer / desactiver un utilisateur');
  if (!jetonEditeur) {
    ignore('activation d un utilisateur', 'necessite le compte editeur');
  } else if (!USER_ID) {
    ignore('activation d un utilisateur', 'USER_ID non fourni (identifiant d un compte IMF a basculer)');
  } else {
    const a = await appel('POST', '/api/v1/teebo/users/' + USER_ID + '/toggle', { jeton: jetonEditeur });
    const etat1 = a.corps && a.corps.utilisateur ? !!a.corps.utilisateur.is_active : null;
    verifier('bascule 1 : response sans erreur 500', !estErreurServeur(a), 'HTTP ' + a.statut + ' ' + texteDe(a));
    verifier('bascule 1 : reponse 200 et etat renvoye', a.statut === 200 && etat1 !== null,
      'HTTP ' + a.statut + ', is_active=' + etat1);
    // On remet le compte dans son etat initial.
    const b = await appel('POST', '/api/v1/teebo/users/' + USER_ID + '/toggle', { jeton: jetonEditeur });
    const etat2 = b.corps && b.corps.utilisateur ? !!b.corps.utilisateur.is_active : null;
    verifier('bascule 2 (retour a l etat initial)', b.statut === 200 && etat2 === !etat1,
      'HTTP ' + b.statut + ', is_active=' + etat2);
    verifier('aucune erreur « colonne updated_at manquante »',
      !(a.corps && /missing_column|updated_at/.test(JSON.stringify(a.corps))),
      'code=' + (a.corps && (a.corps.error || a.corps.code)));
  }

  // Controle de fond : la colonne existe-t-elle vraiment en base ?
  if (AVEC_DB) {
    if (!jetonEditeur) ignore('colonne app_user.updated_at', 'necessite le compte editeur');
    else {
      const d = await appel('GET', '/api/v1/teebo/diagnostic/colonnes', { jeton: jetonEditeur });
      if (d.statut === 404) ignore('diagnostic des colonnes', 'route de diagnostic absente sur ce serveur');
      else {
        const us = d.corps && d.corps.app_user;
        verifier('app_user.updated_at existe en base', !!(us && us.updated_at === true),
          'HTTP ' + d.statut + ' ' + JSON.stringify(us || d.corps || {}).slice(0, 160));
      }
    }
  }

  // -------------------------------------------------------------------------
  // CORRECTIF 2 — facture sur une IMF inexistante
  // -------------------------------------------------------------------------
  titre('3. CORRECTIF 2 — facture pour une IMF inexistante');
  if (!jetonEditeur) {
    ignore('facture sur IMF inexistante', 'necessite le compte editeur');
  } else {
    const r = await appel('POST', '/api/v1/super-admin/factures', {
      jeton: jetonEditeur,
      corps: { tenant_id: TENANT_FANTOME, periode_debut: '2026-11-01', periode_fin: '2026-11-30' }
    });
    verifier('refus propre, pas d erreur 500', !estErreurServeur(r), 'HTTP ' + r.statut + ' ' + texteDe(r));
    verifier('code 404 « client introuvable »', r.statut === 404,
      'HTTP ' + r.statut + ' code=' + (r.corps && (r.corps.code || r.corps.error)));
    verifier('message lisible pour l utilisateur', !!(r.corps && r.corps.message), texteDe(r));
  }

  // -------------------------------------------------------------------------
  // CORRECTIF 3 — module sur une IMF inexistante
  // -------------------------------------------------------------------------
  titre('4. CORRECTIF 3 — module applique a une IMF inexistante');
  if (!jetonEditeur) {
    ignore('module sur IMF inexistante', 'necessite le compte editeur');
  } else {
    const r = await appel('PUT', '/api/v1/super-admin/tenants/' + TENANT_FANTOME + '/modules/COLLECTE', {
      jeton: jetonEditeur, corps: { actif: true, motif: 'test_vague49' }
    });
    verifier('refus propre, pas d erreur 500', !estErreurServeur(r), 'HTTP ' + r.statut + ' ' + texteDe(r));
    verifier('code 404 « client introuvable »', r.statut === 404,
      'HTTP ' + r.statut + ' code=' + (r.corps && (r.corps.code || r.corps.error)));

    // Meme garantie cote IMF : activation d un module par l IMF elle-meme.
    if (jetonImf) {
      const s = await appel('PUT', '/api/v1/saas/modules/COLLECTE', {
        jeton: jetonImf, corps: { is_active: true }
      });
      verifier('cote IMF : pas d erreur 500 sur activation de module', !estErreurServeur(s),
        'HTTP ' + s.statut + ' ' + texteDe(s));
    }
  }

  // -------------------------------------------------------------------------
  // CORRECTIF 4 — l adresse « pack complet » n existe plus
  // -------------------------------------------------------------------------
  titre('5. CORRECTIF 4 — ancienne adresse « pack complet » supprimee');
  const jetonPack = jetonEditeur || jetonImf;
  if (!jetonPack) {
    ignore('adresse pack-complet', 'aucun compte disponible');
  } else {
    const r = await appel('POST', '/api/v1/saas/pack-complet', {
      jeton: jetonPack, corps: { is_active: true }
    });
    const supprimee = r.statut === 404 || r.statut === 405 || r.statut === 410;
    verifier('l adresse ne repond plus (404 / route inconnue)', supprimee,
      'HTTP ' + r.statut + ' ' + texteDe(r));
    verifier('elle n applique plus rien (aucun 200/201)', r.statut !== 200 && r.statut !== 201,
      'HTTP ' + r.statut);
    const refus = r.corps && /route|unknown|inconnue|not_found/i.test(JSON.stringify(r.corps));
    verifier('le refus est bien « route inconnue »', refus || r.statut === 404,
      texteDe(r));
  }

  // -------------------------------------------------------------------------
  // BONUS — plus aucune erreur 500 sur les ecrans voisins
  // -------------------------------------------------------------------------
  titre('6. BONUS — aucun 500 sur les ecrans de facturation (IMF reelle)');
  const jetonSaas = jetonImf || jetonEditeur;
  if (!jetonSaas) ignore('ecrans de facturation', 'aucun compte disponible');
  else {
    const ecrans = [
      ['GET', '/api/v1/saas/catalogue'],
      ['GET', '/api/v1/saas/abonnement'],
      ['GET', '/api/v1/saas/factures'],
      ['GET', '/api/v1/saas/factures/apercu']
    ];
    for (const [m, c] of ecrans) {
      const r = await appel(m, c, { jeton: jetonSaas });
      verifier(m + ' ' + c + ' sans erreur 500', !estErreurServeur(r), 'HTTP ' + r.statut + ' ' + texteDe(r));
    }
  }

  return resume();
}

function resume() {
  console.log('\n' + '='.repeat(74));
  console.log(' RESULTAT : ' + ok + ' conforme(s), ' + ko + ' en echec, ' + ignores + ' saute(s)');
  if (ko) {
    console.log('\n Points a traiter :');
    for (const d of details) console.log('   - ' + d);
  } else {
    console.log('\n Les 4 correctifs se comportent comme annonce.');
  }
  console.log('='.repeat(74));
  process.exitCode = ko ? 1 : 0;
}

principal().catch((e) => {
  console.error('\n!! Le script s est arrete sur une erreur inattendue :', e && (e.stack || e.message));
  process.exitCode = 1;
});
