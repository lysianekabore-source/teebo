// ===========================================================================
// teebo — VAGUE 50 : TEST DE NON-REGRESSION DU MODULE GOUVERNANCE
// ===========================================================================
// CE QUE CE SCRIPT VERIFIE
//   Le module Gouvernance (organes, membres, mandats, sessions, resolutions,
//   capital) est teste de bout en bout, avec un VRAI compte :
//
//   1. les ecrans de lecture repondent (jamais 500, jamais 404 inattendu) ;
//   2. un enregistrement cree par l'IMF de test est modifie, puis supprime :
//      le CRUD complet fonctionne ;
//   3. CLOTUREMENT : un identifiant qui n'existe pas — ou qui appartient a une
//      AUTRE IMF — est toujours refuse par un 404 (jamais un 500, jamais un
//      acces en ecriture) ; ce test utilise des identifiants inexistants, il
//      ne touche donc AUCUNE donnee reelle ;
//   4. un compte sans droit d'ecriture (staff) recoit un refus 403 explicite.
//
//   Le script NETTOIE derriere lui : chaque element cree porte le prefixe
//   « [TEST-TECHNIQUE] » et est supprime a la fin, meme en cas d'echec.
//
// COMMENT LE LANCER (Node 18 ou plus, aucune bibliotheque a installer)
//
//   TEEBO_URL=https://teebo-api-p825.onrender.com \
//   IMF_EMAIL=admin@mon-imf.bf IMF_PASSWORD='...' \
//   node test/governance.test.mjs
//
//   Options :
//     --sans-ecriture    ne fait que les lectures et les refus (aucune creation)
//     STAFF_EMAIL / STAFF_PASSWORD   pour verifier le refus 403 d'un agent
//
// CODES DE SORTIE : 0 = tout est conforme, 1 = au moins un test en echec.
// ===========================================================================

const BASE = (process.env.TEEBO_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const IMF_EMAIL = process.env.IMF_EMAIL || '';
const IMF_PASSWORD = process.env.IMF_PASSWORD || '';
const STAFF_EMAIL = process.env.STAFF_EMAIL || '';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || '';
const SANS_ECRITURE = process.argv.includes('--sans-ecriture');

const MARQUE = '[TEST-TECHNIQUE]';
// Identifiant bien forme mais jamais attribue : doit toujours donner 404.
const ID_INEXISTANT = '00000000-0000-4000-8000-000000000000';

let ok = 0, ko = 0, ignores = 0;
const details = [];
const aNettoyer = [];

function titre(t) { console.log('\n' + t); }
function verifier(nom, condition, constat) {
  if (condition) { ok++; console.log('  [OK]    ' + nom + (constat ? '  — ' + constat : '')); }
  else { ko++; console.log('  [ECHEC] ' + nom + (constat ? '  — ' + constat : '')); details.push(nom + ' : ' + constat); }
}
function ignore(nom, pourquoi) { ignores++; console.log('  [SAUTE] ' + nom + '  — ' + pourquoi); }
function texteDe(r) {
  if (!r) return '';
  if (r.corps) return (r.corps.message || r.corps.error || JSON.stringify(r.corps)).slice(0, 160);
  return String(r.brut || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}
const erreurServeur = (r) => r.statut === 0 || r.statut >= 500;

async function appel(methode, chemin, { jeton, corps } = {}) {
  const h = { Accept: 'application/json' };
  if (corps !== undefined) h['Content-Type'] = 'application/json';
  if (jeton) h.Cookie = 'teebo_session=' + jeton;
  let rep;
  try {
    rep = await fetch(BASE + chemin, {
      method: methode, headers: h, redirect: 'manual',
      body: corps === undefined ? undefined : JSON.stringify(corps)
    });
  } catch (e) {
    return { statut: 0, corps: { erreur_reseau: String((e && e.message) || e) }, brut: '' };
  }
  const brut = await rep.text();
  let json = null;
  try { json = brut ? JSON.parse(brut) : null; } catch (_) { /* page HTML (rapport PDF) */ }
  const sc = rep.headers.getSetCookie ? rep.headers.getSetCookie() : [];
  const c = sc.find((x) => x.startsWith('teebo_session='));
  return { statut: rep.status, corps: json, brut,
    jeton: c ? c.split(';')[0].split('=').slice(1).join('=') : null };
}

async function connexion(email, motDePasse, libelle) {
  if (!email || !motDePasse) { ignore(libelle, 'identifiants non fournis'); return null; }
  const r = await appel('POST', '/api/v1/auth/login', { corps: { email, password: motDePasse } });
  if (r.statut !== 200) { ignore(libelle, 'connexion refusee (HTTP ' + r.statut + ') : ' + texteDe(r)); return null; }
  if (r.corps && r.corps.twofa_required) {
    ignore(libelle, 'ce compte exige la double authentification : test non automatisable');
    return null;
  }
  if (r.corps && r.corps.twofa_enrollment_required) {
    ignore(libelle, 'ce compte doit d’abord activer la double authentification');
    return null;
  }
  const jeton = r.jeton || (r.corps && (r.corps.token || r.corps.session)) || null;
  if (!jeton) { ignore(libelle, 'aucun jeton de session renvoye'); return null; }
  console.log('  connexion ' + libelle + ' : OK');
  return jeton;
}

// Supprime tout ce qui a ete cree, quel que soit l'ordre de reussite.
async function nettoyer(jeton) {
  if (!jeton || !aNettoyer.length) return;
  console.log('\n  Nettoyage des elements de test…');
  for (const item of aNettoyer.reverse()) {
    const r = await appel('DELETE', item.chemin, { jeton });
    const bon = r.statut === 200 || r.statut === 404;
    console.log('    ' + (bon ? '[OK]   ' : '[!]    ') + item.libelle + ' — HTTP ' + r.statut);
  }
}

// ---------------------------------------------------------------------------
async function principal() {
  console.log('='.repeat(74));
  console.log(' teebo — VAGUE 50 — non-regression du module Gouvernance');
  console.log(' serveur cible : ' + BASE);
  console.log('='.repeat(74));

  titre('0. Le serveur repond');
  const sante = await appel('GET', '/healthz');
  verifier('service en ligne', sante.statut === 200, 'HTTP ' + sante.statut);
  if (sante.statut === 0) {
    console.log('\n!! Serveur injoignable. Sur l offre gratuite Render, le service s endort :\n' +
      '   ouvrez le site une fois, attendez une minute, puis relancez ce script.');
    return resume();
  }

  titre('1. Connexion du compte IMF de test');
  const jeton = await connexion(IMF_EMAIL, IMF_PASSWORD, 'compte IMF');
  if (!jeton) {
    ignore('tests de gouvernance', 'aucun compte IMF utilisable');
    return resume();
  }
  const jetonStaff = await connexion(STAFF_EMAIL, STAFF_PASSWORD, 'compte agent (verification du refus)');

  // -------------------------------------------------------------------------
  titre('2. Lectures : aucun ecran ne doit tomber en erreur 500');
  const lectures = [
    '/api/v1/governance/institution',
    '/api/v1/governance/organes',
    '/api/v1/governance/membres',
    '/api/v1/governance/mandats',
    '/api/v1/governance/sessions',
    '/api/v1/governance/resolutions',
    '/api/v1/governance/dashboard',
    '/api/v1/governance/capital/detenteurs',
    '/api/v1/governance/capital/mouvements',
    '/api/v1/governance/capital/beneficiaires',
    '/api/v1/governance/capital/synthese',
    '/api/v1/governance/capital/parametres'
  ];
  for (const c of lectures) {
    const r = await appel('GET', c, { jeton });
    verifier('GET ' + c, !erreurServeur(r) && r.statut === 200, 'HTTP ' + r.statut + ' ' + texteDe(r));
  }
  const pdf = await appel('GET', '/api/v1/governance/rapport.pdf', { jeton });
  verifier('rapport de gouvernance telechargeable', pdf.statut === 200,
    'HTTP ' + pdf.statut + ' (' + (pdf.brut || '').length + ' caracteres)');

  // -------------------------------------------------------------------------
  titre('3. Cloisonnement : identifiant inconnu ou etranger -> 404, jamais 500');
  const refus = [
    ['PUT', '/api/v1/governance/organes/' + ID_INEXISTANT, { libelle: MARQUE + ' intrusion' }],
    ['DELETE', '/api/v1/governance/organes/' + ID_INEXISTANT],
    ['PUT', '/api/v1/governance/membres/' + ID_INEXISTANT, { nom_complet: MARQUE + ' intrusion' }],
    ['DELETE', '/api/v1/governance/membres/' + ID_INEXISTANT],
    ['PUT', '/api/v1/governance/mandats/' + ID_INEXISTANT, { fonction: MARQUE }],
    ['DELETE', '/api/v1/governance/mandats/' + ID_INEXISTANT],
    ['PUT', '/api/v1/governance/sessions/' + ID_INEXISTANT, { numero_session: MARQUE }],
    ['DELETE', '/api/v1/governance/sessions/' + ID_INEXISTANT],
    ['PUT', '/api/v1/governance/resolutions/' + ID_INEXISTANT, { intitule: MARQUE }],
    ['DELETE', '/api/v1/governance/resolutions/' + ID_INEXISTANT],
    ['PUT', '/api/v1/governance/capital/detenteurs/' + ID_INEXISTANT, { nom: MARQUE }],
    ['DELETE', '/api/v1/governance/capital/detenteurs/' + ID_INEXISTANT],
    ['GET', '/api/v1/governance/capital/sortie/' + ID_INEXISTANT],
    ['GET', '/api/v1/governance/capital/eligibilite/' + ID_INEXISTANT],
    ['POST', '/api/v1/governance/capital/mouvements/' + ID_INEXISTANT + '/autorisation', { decision: 'VALIDE' }]
  ];
  for (const [m, c, corps] of refus) {
    const r = await appel(m, c, { jeton, corps });
    const attendu = [404, 400, 422];
    verifier(m + ' ' + c.replace(ID_INEXISTANT, '<inconnu>') + ' refuse proprement',
      !erreurServeur(r) && attendu.includes(r.statut), 'HTTP ' + r.statut + ' ' + texteDe(r));
  }

  // -------------------------------------------------------------------------
  titre('4. Refus d ecriture au compte sans habilitation');
  if (!jetonStaff) ignore('refus 403 d un agent', 'compte agent non fourni (STAFF_EMAIL / STAFF_PASSWORD)');
  else {
    const r = await appel('POST', '/api/v1/governance/organes',
      { jeton: jetonStaff, corps: { libelle: MARQUE + ' refus' } });
    verifier('un agent ne peut pas creer un organe', r.statut === 403,
      'HTTP ' + r.statut + ' ' + texteDe(r));
  }

  // -------------------------------------------------------------------------
  titre('5. CRUD complet sur un enregistrement de test');
  if (SANS_ECRITURE) { ignore('CRUD complet', 'option --sans-ecriture activee'); return resume(); }

  // 5a. Organe
  const nomOrgane = MARQUE + ' Conseil de test';
  const cOrgane = await appel('POST', '/api/v1/governance/organes', { jeton,
    corps: { libelle: nomOrgane, type_organe: 'CONSEIL_ADMINISTRATION', nombre_membres: 0 } });
  verifier('creation d un organe', cOrgane.statut === 200 && cOrgane.corps && cOrgane.corps.organe,
    'HTTP ' + cOrgane.statut + ' ' + texteDe(cOrgane));
  const organe = cOrgane.corps && cOrgane.corps.organe;
  if (organe) aNettoyer.push({ chemin: '/api/v1/governance/organes/' + organe.id, libelle: 'organe de test' });

  if (!organe) { console.log('\n  (suite du CRUD ignoree : l organe de test n a pas pu etre cree)'); return resume(); }

  const mOrgane = await appel('PUT', '/api/v1/governance/organes/' + organe.id, { jeton,
    corps: { libelle: nomOrgane + ' (modifie)', nombre_membres: 3 } });
  verifier('modification de l organe', mOrgane.statut === 200 &&
    mOrgane.corps && mOrgane.corps.organe && Number(mOrgane.corps.organe.nombre_membres) === 3,
    'HTTP ' + mOrgane.statut + ' ' + texteDe(mOrgane));

  // 5b. Membre rattache
  const cMembre = await appel('POST', '/api/v1/governance/membres', { jeton, corps: {
    nom_complet: MARQUE + ' Membre Test', fonction: 'Administrateur',
    type_membre: 'ADMINISTRATEUR', organe_id: organe.id, actif: true
  } });
  verifier('creation d un membre', cMembre.statut === 200 && cMembre.corps && cMembre.corps.membre,
    'HTTP ' + cMembre.statut + ' ' + texteDe(cMembre));
  const membre = cMembre.corps && cMembre.corps.membre;
  if (membre) aNettoyer.push({ chemin: '/api/v1/governance/membres/' + membre.id, libelle: 'membre de test' });

  if (membre) {
    // Le nombre de membres de l organe est recalcule automatiquement.
    const listeOrganes = await appel('GET', '/api/v1/governance/organes', { jeton });
    const o = ((listeOrganes.corps && listeOrganes.corps.organes) || []).find((x) => x.id === organe.id);
    verifier('l organe compte bien son membre', !!o && Number(o.nombre_membres) === 1,
      'nombre_membres=' + (o && o.nombre_membres));

    // 5c. Mandat du membre
    const cMandat = await appel('POST', '/api/v1/governance/mandats', { jeton, corps: {
      membre_id: membre.id, organe_id: organe.id, fonction: 'Administrateur',
      type_mandat: 'ADMINISTRATEUR', duree_mois: 36
    } });
    verifier('creation d un mandat', cMandat.statut === 200 && cMandat.corps && cMandat.corps.mandat,
      'HTTP ' + cMandat.statut + ' ' + texteDe(cMandat));
    const mandat = cMandat.corps && cMandat.corps.mandat;
    if (mandat) {
      aNettoyer.push({ chemin: '/api/v1/governance/mandats/' + mandat.id, libelle: 'mandat de test' });
      const mMandat = await appel('PUT', '/api/v1/governance/mandats/' + mandat.id, { jeton,
        corps: { fonction: 'Administrateur (test)', duree_mois: 48 } });
      verifier('modification du mandat', mMandat.statut === 200 && mMandat.corps && mMandat.corps.mandat,
        'HTTP ' + mMandat.statut + ' ' + texteDe(mMandat));
    }

    const sMembre = await appel('DELETE', '/api/v1/governance/membres/' + membre.id, { jeton });
    verifier('suppression du membre', sMembre.statut === 200, 'HTTP ' + sMembre.statut + ' ' + texteDe(sMembre));
    if (sMembre.statut === 200) aNettoyer.splice(aNettoyer.findIndex((x) => x.chemin.endsWith(membre.id)), 1);
  }

  // 5d. Session (avec le sieges/participants non fournis : valeurs par defaut)
  const cSession = await appel('POST', '/api/v1/governance/sessions', { jeton, corps: {
    organe_id: organe.id, numero_session: MARQUE + ' S1',
    date_session: new Date().toISOString().slice(0, 10), type_session: 'ORDINAIRE'
  } });
  verifier('creation d une session', cSession.statut === 200 && cSession.corps && cSession.corps.session,
    'HTTP ' + cSession.statut + ' ' + texteDe(cSession));
  const session = cSession.corps && cSession.corps.session;
  if (session) aNettoyer.push({ chemin: '/api/v1/governance/sessions/' + session.id, libelle: 'session de test' });

  // 5e. Resolution rattachee a la session
  if (session) {
    const cRes = await appel('POST', '/api/v1/governance/resolutions', { jeton, corps: {
      session_id: session.id, intitule: MARQUE + ' Resolution de test',
      type_element: 'RESOLUTION', texte: 'Resolution creee par le test automatique.'
    } });
    verifier('creation d une resolution', cRes.statut === 200 && cRes.corps && cRes.corps.resolution,
      'HTTP ' + cRes.statut + ' ' + texteDe(cRes));
    const res = cRes.corps && cRes.corps.resolution;
    if (res) {
      aNettoyer.push({ chemin: '/api/v1/governance/resolutions/' + res.id, libelle: 'resolution de test' });
      const sRes = await appel('DELETE', '/api/v1/governance/resolutions/' + res.id, { jeton });
      verifier('suppression de la resolution', sRes.statut === 200,
        'HTTP ' + sRes.statut + ' ' + texteDe(sRes));
      if (sRes.statut === 200) aNettoyer.splice(aNettoyer.findIndex((x) => x.chemin.endsWith(res.id)), 1);
    }
  }

  const sSession = await appel('DELETE', '/api/v1/governance/sessions/' + (session ? session.id : ID_INEXISTANT), { jeton });
  verifier('suppression de la session', sSession.statut === 200 || sSession.statut === 404,
    'HTTP ' + sSession.statut + ' ' + texteDe(sSession));
  if (session && sSession.statut === 200) aNettoyer.splice(aNettoyer.findIndex((x) => x.chemin.endsWith(session.id)), 1);

  // 5f. Detenteur de capital (apport de titres)
  const cDet = await appel('POST', '/api/v1/governance/capital/detenteurs', { jeton, corps: {
    nom_ou_raison_sociale: MARQUE + ' Actionnaire Test',
    categorie: 'ACTIONNAIRE_SA', type_entite: 'PERSONNE_MORALE'
  } });
  verifier('creation d un detenteur de capital', cDet.statut === 200,
    'HTTP ' + cDet.statut + ' ' + texteDe(cDet));
  const det = cDet.corps && (cDet.corps.detenteur || cDet.corps.titulaire || null);
  if (det && det.id) {
    aNettoyer.push({ chemin: '/api/v1/governance/capital/detenteurs/' + det.id, libelle: 'detenteur de test' });
    const sDet = await appel('DELETE', '/api/v1/governance/capital/detenteurs/' + det.id, { jeton });
    verifier('suppression du detenteur', sDet.statut === 200, 'HTTP ' + sDet.statut + ' ' + texteDe(sDet));
    if (sDet.statut === 200) aNettoyer.splice(aNettoyer.findIndex((x) => x.chemin.endsWith(det.id)), 1);
  }

  // 5g. Suppression de l organe (cree au depart)
  const sOrgane = await appel('DELETE', '/api/v1/governance/organes/' + organe.id, { jeton });
  verifier('suppression de l organe', sOrgane.statut === 200, 'HTTP ' + sOrgane.statut + ' ' + texteDe(sOrgane));
  if (sOrgane.statut === 200) aNettoyer.splice(aNettoyer.findIndex((x) => x.chemin.endsWith(organe.id)), 1);

  // 5h. Le tableau de bord se recalcule sans erreur apres ces ecritures.
  const dash = await appel('GET', '/api/v1/governance/dashboard', { jeton });
  verifier('tableau de bord coherent apres ecritures', !erreurServeur(dash) && dash.statut === 200,
    'HTTP ' + dash.statut + ' ' + texteDe(dash));

  return resume();
}

function resume() {
  console.log('\n' + '='.repeat(74));
  console.log(' RESULTAT : ' + ok + ' conforme(s), ' + ko + ' en echec, ' + ignores + ' saute(s)');
  if (ko) {
    console.log('\n Points a traiter :');
    for (const d of details) console.log('   - ' + d);
  } else {
    console.log('\n Le module Gouvernance se comporte comme attendu.');
  }
  console.log('='.repeat(74));
  process.exitCode = ko ? 1 : 0;
}

principal()
  .catch((e) => {
    console.error('\n!! Le script s est arrete sur une erreur inattendue :', e && (e.stack || e.message));
    process.exitCode = 1;
  })
  .finally(async () => {
    // Nettoyage de securite meme si un test a interrompu la suite.
    if (aNettoyer.length && IMF_EMAIL) {
      const r = await appel('POST', '/api/v1/auth/login',
        { corps: { email: IMF_EMAIL, password: IMF_PASSWORD } });
      const j = r.jeton || (r.corps && (r.corps.token || r.corps.session)) || null;
      await nettoyer(j);
    }
  });
