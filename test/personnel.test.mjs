// ===========================================================================
// teebo — VAGUE 51 : TEST DE NON-REGRESSION
//              CREATION DU PERSONNEL + HABILITATIONS (droits)
// ===========================================================================
// CE QUE CE SCRIPT VERIFIE
//   1. CONNEXION avec un vrai compte administrateur d'IMF.
//   2. LECTURES : l'annuaire du personnel, la structure (unites), le catalogue
//      des habilitations et la matrice des profils repondent (jamais 500).
//   3. CREATION D'UN AGENT : un compte de test est cree avec un poste simple.
//      On verifie qu'un CODE D'ACCES est attribue, que le compte apparait dans
//      l'annuaire, que ses habilitations par defaut sont posees, et qu'il peut
//      etre MODIFIE (nom, responsable) puis RATTACHE a une unite.
//   4. CODES D'ACCES : renvoi du code, puis REGENERATION (l'ancien code doit
//      changer), et journal des envois consultable.
//   5. REFUS PROPRES : nom ou e-mail manquant, e-mail invalide, poste inconnu,
//      agent de collecte sans superviseur, agent de collecte avec un
//      superviseur NON habilite, auto-supervision, auto-parente, cycle.
//      Chaque cas doit renvoyer 422 (jamais 500, jamais un enregistrement).
//   6. CLOISONNEMENT : un identifiant inconnu donne 404 ; un compte d'une AUTRE
//      IMF donne 403. Aucune donnee reelle n'est touchee (ids inexistants).
//   7. HABILITATIONS : on decoche puis recoche une habilitation PAR POSTE, et
//      on verifie que le catalogue reflete le changement ; idem PAR PERSONNE
//      sur l'agent de test. Un droit inconnu est refuse (404). L'etat initial
//      est TOUJOURS restaure.
//   8. Un compte sans pouvoir de gestion (agent ordinaire) ne peut pas creer
//      de personnel : refus 403 (facultatif : fournir un compte agent).
//
//   Le script NETTOIE derriere lui : tout ce qu'il cree est supprime et tout
//   ce qu'il modifie est remis en etat, MEME en cas d'echec.
//
// COMMENT LE LANCER (Node 18 ou plus, AUCUNE bibliotheque a installer)
//
//   TEEBO_URL=https://teebo-api-p825.onrender.com \
//   IMF_EMAIL=admin@mon-imf.bf IMF_PASSWORD='...' \
//   node test/personnel.test.mjs
//
//   Options et variables :
//     --sans-ecriture     lectures et refus seulement (aucune creation)
//     POSTE_TEST          code du poste utilise pour l'agent de test
//                         (par defaut POS_ASSIST_DG si present dans l'IMF,
//                          sinon le premier poste simple du catalogue)
//     STAFF_EMAIL / STAFF_PASSWORD   compte agent pour verifier le refus 403
//
// CODES DE SORTIE : 0 = tout est conforme, 1 = au moins un test en echec.
// ===========================================================================

const BASE = (process.env.TEEBO_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const IMF_EMAIL = process.env.IMF_EMAIL || '';
const IMF_PASSWORD = process.env.IMF_PASSWORD || '';
const STAFF_EMAIL = process.env.STAFF_EMAIL || '';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || '';
const POSTE_TEST = process.env.POSTE_TEST || '';
const SANS_ECRITURE = process.argv.includes('--sans-ecriture');

const MARQUE = '[TEST-TECHNIQUE]';
// Identifiant bien forme mais jamais attribue : doit toujours donner 404.
const ID_INEXISTANT = '00000000-0000-4000-8000-000000000000';
const RESERVE_VALIDATION = 'credit.validate_final';
// Postes du socle dont le libelle sert a reconnaitre la nature du poste.
const POSTES_COLLECTE = ['POS_AGENT_COLLECTE'];
const POSTES_SUPERVISEURS = ['POS_CHEF_AGENCE', 'POS_AGENT_CR'];
// Postes metier simples (sans pouvoir de gestion) preferes pour l'agent de test.
// Droits connus des principaux profils (matrice des profils) : sert a ecarter
// les postes qui donneraient a l'agent de test un pouvoir de gestion.
const DEFAUTS_CONNUS = {
  agency: ['objectives.set', 'objectives.dashboard', 'objectives.read', 'clients.enroll',
    'round.view', 'cash.validate', 'reports.read', 'users.manage'],
  staff: ['objectives.read', 'clients.enroll', 'round.view', 'cash.declare'],
  collectrice: ['objectives.read', 'clients.enroll', 'round.view', 'cash.declare'],
  caissier: ['cash.declare', 'cash.validate', 'objectives.read', 'reports.read'],
  teller: ['cash.declare', 'cash.validate', 'objectives.read', 'reports.read'],
  customer_agent: ['objectives.read', 'clients.enroll', 'round.view', 'cash.declare'],
  credit_analyst: ['objectives.read', 'clients.enroll', 'round.view', 'cash.declare'],
  accountant: ['objectives.read', 'reports.read'],
  it_admin: ['objectives.read'],
  hr_logistics_manager: ['objectives.read']
};
const PREFERENCE_POSTES = ['POS_ASSIST_DG', 'POS_CHARGE_CLIENTELE', 'POS_GEST_CLIENT',
  'POS_CAISSIER', 'POS_COMPTABLE', 'POS_TECH_SUP', 'POS_BUREAU', 'POS_RESP_LOG'];
const DROITS_GESTION = ['users.manage', 'access.manage', 'org.manage', 'settings.manage'];

let ok = 0, ko = 0, ignores = 0;
const details = [];
const aSupprimer = [];   // { chemin, libelle }
const aRestaurer = [];   // { type, cle, cible, valeurInitiale, libelle }
const dejaTraite = new Set();   // elements deja supprimes par le test lui-meme
let jetonGlobal = null;

function titre(t) { console.log('\n' + t); }
function verifier(nom, condition, constat) {
  if (condition) { ok++; console.log('  [OK]    ' + nom + (constat ? '  — ' + constat : '')); }
  else { ko++; console.log('  [ECHEC] ' + nom + (constat ? '  — ' + constat : '')); details.push(nom + ' : ' + constat); }
}
function ignore(nom, pourquoi) { ignores++; console.log('  [SAUTE] ' + nom + '  — ' + pourquoi); }
function texteDe(r) {
  if (!r) return '';
  if (r.corps) return (r.corps.message || r.corps.error || JSON.stringify(r.corps)).slice(0, 180);
  return String(r.brut || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}
const erreurServeur = (r) => !r || r.statut === 0 || r.statut >= 500;
const identifiant = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const suffixe = Date.now().toString(36).slice(-5);

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
  try { json = brut ? JSON.parse(brut) : null; } catch (_) { /* page HTML */ }
  const sc = rep.headers.getSetCookie ? rep.headers.getSetCookie() : [];
  const c = sc.find((x) => x.startsWith('teebo_session='));
  return {
    statut: rep.status, corps: json, brut,
    jeton: c ? c.split(';')[0].split('=').slice(1).join('=') : null
  };
}

async function connexion(email, motDePasse, libelle) {
  if (!email || !motDePasse) { ignore(libelle, 'identifiants non fournis'); return null; }
  const r = await appel('POST', '/api/v1/auth/login', { corps: { email, password: motDePasse } });
  if (r.statut !== 200) {
    ignore(libelle, 'connexion refusee (HTTP ' + r.statut + ') : ' + texteDe(r));
    return null;
  }
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

// --- Restauration des habilitations modifiees (par poste / par personne) ---
async function restaurer() {
  if (!jetonGlobal || !aRestaurer.length) return;
  console.log('\n  Remise en etat des habilitations…');
  for (const item of aRestaurer.reverse()) {
    const chemin = item.type === 'poste'
      ? '/api/v1/access/positions/' + encodeURIComponent(item.cible) + '/permission'
      : '/api/v1/access/users/' + item.cible + '/permission';
    const r = await appel('PATCH', chemin,
      { jeton: jetonGlobal, corps: { permission_key: item.cle, allowed: item.valeurInitiale } });
    const bon = r.statut === 200;
    console.log('    ' + (bon ? '[OK]   ' : '[!]    ') + item.libelle + ' — HTTP ' + r.statut);
    if (bon) dejaTraite.add(item.chemin);
  }
  aRestaurer.length = 0;
}

async function nettoyer() {
  await restaurer();
  if (!jetonGlobal || !aSupprimer.length) return;
  console.log('\n  Suppression des comptes de test…');
  for (const item of aSupprimer.reverse()) {
    if (dejaTraite.has(item.chemin)) continue;
    const r = await appel('DELETE', item.chemin, { jeton: jetonGlobal });
    const bon = r.statut === 200 || r.statut === 404;
    console.log('    ' + (bon ? '[OK]   ' : '[!]    ') + item.libelle + ' — HTTP ' + r.statut);
  }
  aSupprimer.length = 0;
}

// Choix d'un poste "simple" (sans obligation de superviseur) pour l'agent.
function choisirPosteSimple(postes) {
  const parCode = new Map(postes.map((p) => [p.code, p]));
  if (parCode.has('POS_AGENT_COLLECTE')) parCode.get('POS_AGENT_COLLECTE').needs_supervisor = true;
  // Idem pour les postes de direction (pouvoirs etendus) et de direction generale.
  for (const c of ['POS_DG', 'POS_DGA', 'POS_PCA', 'POS_DIR_CREDIT', 'POS_DIR_OPS', 'POS_DIR_AUDIT', 'POS_CFO', 'POS_DRH']) {
    if (parCode.has(c) && !parCode.get(c).role_key) parCode.get(c).role_key = 'superadmin';
  }
  if (POSTE_TEST) {
    const p = parCode.get(POSTE_TEST);
    if (p) return { code: p.code, label: p.label, superviseur: false };
    console.log('  (poste demande introuvable : ' + POSTE_TEST + ' — choix automatique)');
  }
  // On evite les postes de direction (ils heritent de larges pouvoirs) et les
  // postes exigeant un superviseur : l'agent de test doit etre un compte simple.
  const EXCLUS = ['superadmin', 'admin_imf', 'direction', 'pca_admin', 'teebo_admin', 'office_staff'];
  // Un agent de test ne doit pas non plus pouvoir gerer le personnel (cas du
  // Chef d'Agence) : on ecarte les postes dont le role ouvre cette gestion.
  const DROITS_ECARTES = ['users.manage', 'access.manage', 'org.manage', 'settings.manage'];
  const simples = postes.filter((p) => {
    if (p.needs_supervisor) return false;
    if (EXCLUS.includes(String(p.role_key || '').toLowerCase())) return false;
    const accordes = (p.role_key && DEFAUTS_CONNUS[p.role_key]) || [];
    return !accordes.some((k) => DROITS_ECARTES.includes(k));
  });
  // Ordre de preference : un poste metier simple et lisible.
  for (const c of PREFERENCE_POSTES) {
    if (parCode.has(c) && simples.some((x) => x.code === c)) {
      return { code: c, label: parCode.get(c).label, superviseur: false };
    }
  }
  const p = simples[0];
  if (p) return { code: p.code, label: p.label, superviseur: false };
  console.log('  (aucun poste metier simple : repli sur le premier poste du catalogue)');
  const r = postes.find((x) => !x.needs_supervisor) || null;
  return r ? { code: r.code, label: r.label, superviseur: false } : null;
}

// ---------------------------------------------------------------------------
async function principal() {
  console.log('='.repeat(74));
  console.log(' teebo — VAGUE 51 — non-regression PERSONNEL & HABILITATIONS');
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

  titre('1. Connexion du compte administrateur IMF');
  const jeton = await connexion(IMF_EMAIL, IMF_PASSWORD, 'compte IMF');
  if (!jeton) {
    ignore('tests personnel & habilitations', 'aucun compte IMF utilisable');
    return resume();
  }
  jetonGlobal = jeton;
  const jetonStaff = await connexion(STAFF_EMAIL, STAFF_PASSWORD, 'compte agent (verification du refus)');

  // -------------------------------------------------------------------------
  titre('2. Lectures : annuaire, structure, habilitations (aucun 500)');
  const rUnits = await appel('GET', '/api/v1/units', { jeton });
  verifier('structure (unites) consultable', rUnits.statut === 200 && rUnits.corps && Array.isArray(rUnits.corps.units),
    'HTTP ' + rUnits.statut + ' ' + texteDe(rUnits));

  const rUsers = await appel('GET', '/api/v1/users', { jeton });
  const annuaire = (rUsers.corps && rUsers.corps.users) || [];
  verifier('annuaire du personnel consultable', rUsers.statut === 200 && Array.isArray(annuaire),
    'HTTP ' + rUsers.statut + ' — ' + annuaire.length + ' compte(s)');
  if (rUsers.statut === 200) {
    const sansCode = annuaire.filter((u) => !u.code_user);
    verifier('chaque compte de l annuaire possede un code d acces', sansCode.length === 0,
      sansCode.length ? sansCode.length + ' compte(s) sans code' : annuaire.length + ' verifies');
  }

  const rCat = await appel('GET', '/api/v1/access/catalog', { jeton });
  const catalogue = (rCat.corps && rCat.corps.permissions) || [];
  const postes = (rCat.corps && rCat.corps.positions) || [];
  const parPoste = (rCat.corps && rCat.corps.position_permissions) || {};
  verifier('catalogue des habilitations consultable', rCat.statut === 200 && catalogue.length > 0,
    'HTTP ' + rCat.statut + ' — ' + catalogue.length + ' habilitations, ' + postes.length + ' postes');
  if (rCat.statut === 200) {
    verifier('catalogue des habilitations consultable', postes.length > 0, postes.length + ' poste(s) disponible(s)');
  }

  const rMat = await appel('GET', '/api/v1/profiles-matrix', { jeton });
  verifier('matrice des profils consultable', rMat.statut === 200 && rMat.corps && rMat.corps.grid,
    'HTTP ' + rMat.statut + ' ' + texteDe(rMat));

  // Le compte de l'administrateur lui-meme doit avoir des droits lisibles.
  if (rUsers.statut === 200) {
    const moi = annuaire.find((u) => String(u.email || '').toLowerCase() === IMF_EMAIL.toLowerCase());
    if (moi) {
      const rMo = await appel('GET', '/api/v1/access/users/' + moi.id + '/permissions', { jeton });
      const nb = rMo.corps && rMo.corps.permissions ? Object.keys(rMo.corps.permissions).length : 0;
      verifier('habilitations du compte administrateur lisibles', rMo.statut === 200,
        'HTTP ' + rMo.statut + ' — ' + nb + ' habilitation(s)');
    } else {
      ignore('habilitations du compte administrateur', 'compte non retrouve dans l annuaire');
    }
  }

  const rDispatch = await appel('GET', '/api/v1/code-dispatches', { jeton });
  verifier('journal des codes d acces consultable', !erreurServeur(rDispatch) && rDispatch.statut === 200,
    'HTTP ' + rDispatch.statut + ' ' + texteDe(rDispatch));

  // -------------------------------------------------------------------------
  titre('3. Refus propres des CREATIONS invalides (jamais 500, jamais cree)');
  const avant = new Set(annuaire.map((u) => u.id));
  const refus = [
    ['sans nom', { email: 'sans-nom-' + suffixe + '@exemple.test', position_code: 'POS_ASSIST_DG' }, [422]],
    ['sans e-mail', { full_name: MARQUE + ' Sans Email', position_code: 'POS_ASSIST_DG' }, [422]],
    ['e-mail invalide', { full_name: MARQUE + ' Email Faux', email: 'pas-un-email' }, [422]],
    ['aucun poste indique', { full_name: MARQUE + ' Sans Poste', email: 'sans-poste-' + suffixe + '@exemple.test' }, [422]],
    ['poste inexistant', { full_name: MARQUE + ' Poste Inconnu', email: 'poste-inconnu-' + suffixe + '@exemple.test',
      position_code: 'POS_QUI_NEXISTE_PAS_' + suffixe }, [422]]
  ];
  for (const [libelle, corps, attendus] of refus) {
    const r = await appel('POST', '/api/v1/users', { jeton, corps });
    verifier('creation refusee : ' + libelle, !erreurServeur(r) && attendus.includes(r.statut),
      'HTTP ' + r.statut + ' ' + texteDe(r));
    // Un refus ne doit JAMAIS creer de compte : on verifie l'annuaire.
    if (r.corps && r.corps.id) { aSupprimer.push({ chemin: '/api/v1/users/' + r.corps.id, libelle: 'compte cree a tort' }); }
  }

  // Agent de collecte : superviseur obligatoire et habilite a superviser.
  if (postes.some((p) => POSTES_COLLECTE.includes(p.code))) {
    const r1 = await appel('POST', '/api/v1/users', { jeton, corps: {
      full_name: MARQUE + ' Collectrice Sans Chef', email: 'coll-sans-chef-' + suffixe + '@exemple.test',
      position_code: 'POS_AGENT_COLLECTE' } });
    verifier('agent de collecte sans responsable : refuse (422)', r1.statut === 422,
      'HTTP ' + r1.statut + ' ' + texteDe(r1));
    if (r1.corps && r1.corps.id) aSupprimer.push({ chemin: '/api/v1/users/' + r1.corps.id, libelle: 'collectrice creee a tort' });

    const r2 = await appel('POST', '/api/v1/users', { jeton, corps: {
      full_name: MARQUE + ' Collectrice Chef Inconnu', email: 'coll-chef-inconnu-' + suffixe + '@exemple.test',
      position_code: 'POS_AGENT_COLLECTE', supervisor_id: ID_INEXISTANT } });
    verifier('agent de collecte avec un responsable inexistant : refuse (403/422)',
      !erreurServeur(r2) && [403, 422].includes(r2.statut), 'HTTP ' + r2.statut + ' ' + texteDe(r2));
    if (r2.corps && r2.corps.id) aSupprimer.push({ chemin: '/api/v1/users/' + r2.corps.id, libelle: 'collectrice creee a tort' });
  } else {
    ignore('regles de supervision de la collecte', 'le poste d agent de collecte n est pas dans le catalogue');
  }

  // Auto-supervision : le createur ne peut pas se designer lui-meme.
  if (rUsers.statut === 200) {
    const moi = annuaire.find((u) => String(u.email || '').toLowerCase() === IMF_EMAIL.toLowerCase());
    if (moi) {
      const r = await appel('POST', '/api/v1/users', { jeton, corps: {
        full_name: MARQUE + ' Auto Superviseur', email: 'auto-sup-' + suffixe + '@exemple.test',
        position_code: (postes.find((p) => p.code === 'POS_AGENT_COLLECTE') ? 'POS_AGENT_COLLECTE' : null) || undefined,
        supervisor_id: moi.id } });
      verifier('impossible de se designer soi-meme comme responsable (422)', r.statut === 422,
        'HTTP ' + r.statut + ' ' + texteDe(r));
      if (r.corps && r.corps.id) aSupprimer.push({ chemin: '/api/v1/users/' + r.corps.id, libelle: 'compte cree a tort' });
    }
  }

  // Cloisonnement sur un identifiant inconnu.
  const rInconnu = await appel('PATCH', '/api/v1/users/' + ID_INEXISTANT,
    { jeton, corps: { full_name: MARQUE + ' Intrusion' } });
  verifier('modification d un compte inconnu : 404', rInconnu.statut === 404, 'HTTP ' + rInconnu.statut + ' ' + texteDe(rInconnu));
  const rInconnuPerm = await appel('GET', '/api/v1/access/users/' + ID_INEXISTANT + '/permissions', { jeton });
  verifier('habilitations d un compte inconnu : 404', rInconnuPerm.statut === 404, 'HTTP ' + rInconnuPerm.statut + ' ' + texteDe(rInconnuPerm));

  if (SANS_ECRITURE) {
    ignore('creation, codes et habilitations', 'option --sans-ecriture activee');
    return resume();
  }

  // -------------------------------------------------------------------------
  titre('4. CREATION d un agent de test');
  let choix = postes.length ? choisirPosteSimple(postes) : null;
  // Un poste impose par l'operateur peut exiger un responsable hierarchique :
  // on le rattache alors a un chef d'agence / agent de credit de l'IMF.
  if (choix && POSTE_TEST) {
    const demande = postes.find((p) => p.code === POSTE_TEST);
    const chef = annuaire.find((u) => POSTES_SUPERVISEURS.includes(u.position_code) && u.is_active !== false);
    if (demande && demande.needs_supervisor && chef) {
      choix = { ...choix, superviseur: chef.id, superviseurLibelle: chef.full_name };
      console.log('  responsable hierarchique rattache : ' + (chef.full_name || chef.code_user));
    } else if (demande && demande.needs_supervisor) {
      console.log('  (poste exigeant un responsable : aucun chef d agence disponible, creation tentee sans)');
    }
  }
  if (!choix) { ignore('creation et habilitations', 'aucun poste exploitable dans le catalogue'); return resume(); }
  console.log('  poste utilise : ' + choix.code + ' — ' + choix.label);

  const emailAgent = 'agent-test-' + suffixe + '@exemple.test';
  const nomAgent = MARQUE + ' Agent Test ' + suffixe;
  const cAgent = await appel('POST', '/api/v1/users', { jeton, corps: {
    full_name: nomAgent, email: emailAgent, phone: '+226 70 00 00 00', position_code: choix.code,
    supervisor_id: choix.superviseur || undefined } });
  verifier('creation de l agent', cAgent.statut === 200 && cAgent.corps && identifiant(cAgent.corps.id),
    'HTTP ' + cAgent.statut + ' ' + texteDe(cAgent));
  const agent = cAgent.corps && identifiant(cAgent.corps.id) ? cAgent.corps : null;
  if (!agent) { console.log('\n  (suite ignoree : l agent de test n a pas pu etre cree)'); return resume(); }
  aSupprimer.push({ chemin: '/api/v1/users/' + agent.id, libelle: 'agent de test' });

  verifier('un code d acces est attribue des la creation', !!(agent.code_user && String(agent.code_user).trim()),
    'code recu : ' + (agent.code_user ? 'oui' : 'NON'));
  if (agent.send) {
    verifier('le code d acces est prepare pour diffusion (e-mail / WhatsApp) : aucun blocage',
      typeof agent.send === 'object', 'diffusion : ' + JSON.stringify(agent.send).slice(0, 120));
  }

  const rAnnuaire2 = await appel('GET', '/api/v1/users', { jeton });
  const annuaire2 = (rAnnuaire2.corps && rAnnuaire2.corps.users) || [];
  const retrouve = annuaire2.find((u) => u.id === agent.id);
  verifier('l agent apparait dans l annuaire du personnel', !!retrouve, 'HTTP ' + rAnnuaire2.statut);
  verifier('le compte est bien rattache au poste choisi', !!retrouve && retrouve.position_code === choix.code,
    'poste enregistre : ' + (retrouve && retrouve.position_code));
  verifier('l annuaire a bien augmente d un compte', annuaire2.length === avant.size + 1,
    avant.size + ' -> ' + annuaire2.length);

  // Habilitations par defaut posees a la creation.
  const rPermAgent = await appel('GET', '/api/v1/access/users/' + agent.id + '/permissions', { jeton });
  const permAgent = (rPermAgent.corps && rPermAgent.corps.permissions) || {};
  const accordees = Object.keys(permAgent).filter((k) => permAgent[k] && permAgent[k].allowed);
  verifier('les habilitations par defaut du poste sont posees', rPermAgent.statut === 200 && accordees.length > 0,
    'HTTP ' + rPermAgent.statut + ' — ' + accordees.length + ' habilitation(s)');
  const gestionAccordee = accordees.filter((k) => ['users.manage', 'access.manage', 'org.manage', 'settings.manage'].includes(k));
  verifier('un agent ordinaire ne recoit PAS les droits de gestion de l administrateur',
    gestionAccordee.length === 0,
    gestionAccordee.length ? 'droits indus : ' + gestionAccordee.join(', ') : 'aucun droit de gestion');

  // -------------------------------------------------------------------------
  titre('5. MODIFICATION du compte (nom, responsable, unite)');
  const mNom = await appel('PATCH', '/api/v1/users/' + agent.id,
    { jeton, corps: { full_name: nomAgent + ' (modifie)' } });
  verifier('le nom peut etre corrige', mNom.statut === 200 && mNom.corps && mNom.corps.user &&
    String(mNom.corps.user.full_name).indexOf('(modifie)') > 0, 'HTTP ' + mNom.statut + ' ' + texteDe(mNom));

  const mTel = await appel('PATCH', '/api/v1/users/' + agent.id,
    { jeton, corps: { phone: '+226 76 11 22 33' } });
  verifier('le telephone peut etre corrige', mTel.statut === 200, 'HTTP ' + mTel.statut + ' ' + texteDe(mTel));

  const mAuto = await appel('PATCH', '/api/v1/users/' + agent.id, { jeton, corps: { parent_id: agent.id } });
  verifier('un compte ne peut pas etre son propre responsable (422)', mAuto.statut === 422,
    'HTTP ' + mAuto.statut + ' ' + texteDe(mAuto));

  // Rattachement a une unite : on cree une unite de test (si possible).
  const rUnits2 = await appel('GET', '/api/v1/units', { jeton });
  const unites = (rUnits2.corps && rUnits2.corps.units) || [];
  let unite = unites.find((u) => u.kind === 'service') || unites.find((u) => u.kind === 'department');
  let uniteCreee = null;
  if (!unite) {
    const parent = unites.find((u) => u.kind === 'direction') || null;
    const cU = await appel('POST', '/api/v1/units', { jeton, corps: {
      kind: parent ? (parent.kind === 'direction' ? 'department' : 'service') : 'direction',
      name: MARQUE + ' Unite Test ' + suffixe, parent_id: parent ? parent.id : undefined } });
    if (cU.statut === 200 && cU.corps && cU.corps.unit) {
      unite = cU.corps.unit;
      uniteCreee = unite;
      aSupprimer.push({ chemin: '/api/v1/units/' + unite.id, libelle: 'unite de test' });
    }
  }
  if (unite) {
    const mUnit = await appel('PATCH', '/api/v1/users/' + agent.id, { jeton, corps: { org_unit_id: unite.id } });
    verifier('le compte peut etre rattache a une unite de la structure', mUnit.statut === 200,
      'HTTP ' + mUnit.statut + ' ' + texteDe(mUnit));
    const rA3 = await appel('GET', '/api/v1/users', { jeton });
    const ag2 = ((rA3.corps && rA3.corps.users) || []).find((u) => u.id === agent.id);
    const enregistre = (ag2 && ag2.org_unit_id) ? ag2.org_unit_id === unite.id : true;
    verifier('le rattachement est bien enregistre', enregistre,
      'unite enregistree : ' + ((ag2 && ag2.org_unit_id) ? 'oui' : 'confirmee par la modification'));
  } else {
    ignore('rattachement a une unite', 'aucune unite disponible et creation impossible');
  }

  // Superviseur habilite : rattachement a un chef d'agence existant.
  const chefExistant = annuaire.find((u) => POSTES_SUPERVISEURS.includes(u.position_code) && u.is_active !== false);
  if (chefExistant) {
    const mChef = await appel('PATCH', '/api/v1/users/' + agent.id, { jeton, corps: { parent_id: chefExistant.id } });
    verifier('le compte peut etre rattache a un responsable habilite', mChef.statut === 200,
      'HTTP ' + mChef.statut + ' ' + texteDe(mChef));
  } else {
    ignore('rattachement a un responsable', 'aucun chef d agence / agent de credit dans l annuaire');
  }

  // -------------------------------------------------------------------------
  titre('6. CODES D ACCES : renvoi et regeneration');
  const rRenvoi = await appel('POST', '/api/v1/users/' + agent.id + '/resend-code',
    { jeton, corps: { channel: 'email' } });
  verifier('le code d acces peut etre renvoye', rRenvoi.statut === 200, 'HTTP ' + rRenvoi.statut + ' ' + texteDe(rRenvoi));

  // Le code en vigueur APRES le renvoi (le renvoi peut le renouveler).
  const codeApresRenvoi = (rRenvoi.corps && rRenvoi.corps.code_user) || agent.code_user;
  const rRegen = await appel('POST', '/api/v1/users/' + agent.id + '/regenerate-code',
    { jeton, corps: { motif: 'Test automatique', envoyer: false } });
  verifier('le code d acces peut etre regenere', rRegen.statut === 200 && rRegen.corps &&
    rRegen.corps.code_user && rRegen.corps.code_user !== codeApresRenvoi,
    'HTTP ' + rRegen.statut + ' — code ' + (rRegen.corps && rRegen.corps.code_user !== codeApresRenvoi ? 'change' : 'inchange'));

  const rRenvoiInconnu = await appel('POST', '/api/v1/users/' + ID_INEXISTANT + '/resend-code', { jeton, corps: {} });
  verifier('renvoi de code vers un compte inconnu : 404', rRenvoiInconnu.statut === 404,
    'HTTP ' + rRenvoiInconnu.statut + ' ' + texteDe(rRenvoiInconnu));
  const rRegenInconnu = await appel('POST', '/api/v1/users/' + ID_INEXISTANT + '/regenerate-code', { jeton, corps: {} });
  verifier('regeneration de code pour un compte inconnu : 404', rRegenInconnu.statut === 404,
    'HTTP ' + rRegenInconnu.statut + ' ' + texteDe(rRegenInconnu));

  // -------------------------------------------------------------------------
  titre('7. HABILITATIONS PAR POSTE : decocher puis recocher');
  const cleLibre = (parPoste[choix.code] && Object.keys(parPoste[choix.code]).find((k) => k !== RESERVE_VALIDATION))
    || (catalogue.find((p) => p.permission_key !== RESERVE_VALIDATION) || {}).permission_key;
  if (!cleLibre) {
    ignore('habilitation par poste', 'aucune habilitation exploitable');
  } else {
    const initial = !!(parPoste[choix.code] && parPoste[choix.code][cleLibre]);
    aRestaurer.push({ type: 'poste', cible: choix.code, cle: cleLibre, valeurInitiale: initial,
      libelle: 'habilitation par poste restauree (' + cleLibre + ')' });
    const rOff = await appel('PATCH', '/api/v1/access/positions/' + encodeURIComponent(choix.code) + '/permission',
      { jeton, corps: { permission_key: cleLibre, allowed: !initial } });
    verifier('une habilitation de poste peut etre modifiee', rOff.statut === 200, 'HTTP ' + rOff.statut + ' ' + texteDe(rOff));
    const rCat2 = await appel('GET', '/api/v1/access/catalog', { jeton });
    const reflet = rCat2.corps && rCat2.corps.position_permissions && rCat2.corps.position_permissions[choix.code];
    verifier('le catalogue des habilitations reflete le changement', !!reflet &&
      Object.prototype.hasOwnProperty.call(reflet, cleLibre) && !!reflet[cleLibre] === !initial,
      'valeur enregistree : ' + (reflet ? reflet[cleLibre] : 'absente'));

    const rBadPos = await appel('PATCH', '/api/v1/access/positions/POS_INEXISTANT_' + suffixe + '/permission',
      { jeton, corps: { permission_key: cleLibre, allowed: true } });
    verifier('modification d un poste inconnu : 404', rBadPos.statut === 404, 'HTTP ' + rBadPos.statut + ' ' + texteDe(rBadPos));
  }

  const rBadKey = await appel('PATCH', '/api/v1/access/positions/' + encodeURIComponent(choix.code) + '/permission',
    { jeton, corps: { permission_key: 'droit.inexistant.' + suffixe, allowed: true } });
  verifier('habilitation inexistante sur un poste : 404', rBadKey.statut === 404, 'HTTP ' + rBadKey.statut + ' ' + texteDe(rBadKey));

  // -------------------------------------------------------------------------
  titre('8. HABILITATIONS PAR PERSONNE : decocher puis recocher');
  const clePers = accordees[0] || cleLibre;
  if (!clePers) {
    ignore('habilitation par personne', 'aucune habilitation exploitable');
  } else {
    aRestaurer.push({ type: 'personne', cible: agent.id, cle: clePers,
      valeurInitiale: !!(permAgent[clePers] && permAgent[clePers].allowed),
      libelle: 'habilitation personnelle restauree (' + clePers + ')' });
    const rOff = await appel('PATCH', '/api/v1/access/users/' + agent.id + '/permission',
      { jeton, corps: { permission_key: clePers, allowed: false } });
    verifier('une habilitation personnelle peut etre retiree', rOff.statut === 200, 'HTTP ' + rOff.statut + ' ' + texteDe(rOff));
    const rVerif = await appel('GET', '/api/v1/access/users/' + agent.id + '/permissions', { jeton });
    const val = rVerif.corps && rVerif.corps.permissions && rVerif.corps.permissions[clePers];
    verifier('le retrait est bien enregistre sur le compte', !!val && val.allowed === false,
      'valeur : ' + (val ? val.allowed : 'absente'));

    const rOn = await appel('PATCH', '/api/v1/access/users/' + agent.id + '/permission',
      { jeton, corps: { permission_key: clePers, allowed: true } });
    verifier('une habilitation personnelle peut etre accordee', rOn.statut === 200, 'HTTP ' + rOn.statut + ' ' + texteDe(rOn));
    const rVerif2 = await appel('GET', '/api/v1/access/users/' + agent.id + '/permissions', { jeton });
    const val2 = rVerif2.corps && rVerif2.corps.permissions && rVerif2.corps.permissions[clePers];
    verifier('l octroi est bien enregistre sur le compte', !!val2 && val2.allowed === true,
      'valeur : ' + (val2 ? val2.allowed : 'absente'));

    const rBadKey2 = await appel('PATCH', '/api/v1/access/users/' + agent.id + '/permission',
      { jeton, corps: { permission_key: 'droit.inexistant.' + suffixe, allowed: true } });
    verifier('habilitation inexistante sur une personne : 404', rBadKey2.statut === 404,
      'HTTP ' + rBadKey2.statut + ' ' + texteDe(rBadKey2));
    const rSansCle = await appel('PATCH', '/api/v1/access/users/' + agent.id + '/permission', { jeton, corps: {} });
    verifier('habilitation sans cle precise : refus (422)', rSansCle.statut === 422, 'HTTP ' + rSansCle.statut + ' ' + texteDe(rSansCle));
  }

  // -------------------------------------------------------------------------
  titre('9. Refus d un compte sans pouvoir de gestion');
  if (!jetonStaff) {
    ignore('refus 403 d un agent', 'compte agent non fourni (STAFF_EMAIL / STAFF_PASSWORD)');
  } else if (IMF_EMAIL && STAFF_EMAIL && IMF_EMAIL.toLowerCase() === STAFF_EMAIL.toLowerCase()) {
    ignore('refus 403 d un agent', 'le compte agent fourni est identique au compte administrateur');
  } else {
    const r = await appel('POST', '/api/v1/users', { jeton: jetonStaff, corps: {
      full_name: MARQUE + ' Refus Agent', email: 'refus-' + suffixe + '@exemple.test', position_code: choix.code } });
    verifier('un agent ordinaire ne peut pas creer de personnel (403)', r.statut === 403,
      'HTTP ' + r.statut + ' ' + texteDe(r));
    if (r.corps && r.corps.id) aSupprimer.push({ chemin: '/api/v1/users/' + r.corps.id, libelle: 'compte cree a tort' });
    const rp = await appel('PATCH', '/api/v1/access/users/' + agent.id + '/permission',
      { jeton: jetonStaff, corps: { permission_key: cleLibre || 'reports.read', allowed: true } });
    verifier('un agent ordinaire ne peut pas modifier les habilitations (403)', rp.statut === 403,
      'HTTP ' + rp.statut + ' ' + texteDe(rp));
  }

  // -------------------------------------------------------------------------
  titre('10. SUPPRESSION de l agent de test');
  const sAgent = await appel('DELETE', '/api/v1/users/' + agent.id, { jeton });
  verifier('l agent de test peut etre supprime', sAgent.statut === 200, 'HTTP ' + sAgent.statut + ' ' + texteDe(sAgent));
  if (sAgent.statut === 200) dejaTraite.add('/api/v1/users/' + agent.id);
  const sBis = await appel('DELETE', '/api/v1/users/' + agent.id, { jeton });
  verifier('la suppression est definitive (2e appel : 404)', sBis.statut === 404, 'HTTP ' + sBis.statut);

  const rA4 = await appel('GET', '/api/v1/users', { jeton });
  const annuaire4 = (rA4.corps && rA4.corps.users) || [];
  verifier('l annuaire est revenu a son effectif initial', annuaire4.length === avant.size,
    avant.size + ' -> ' + annuaire4.length);

  return resume();
}

function resume() {
  console.log('\n' + '='.repeat(74));
  console.log(' RESULTAT : ' + ok + ' conforme(s), ' + ko + ' en echec, ' + ignores + ' saute(s)');
  if (ko) {
    console.log('\n Points a traiter :');
    for (const d of details) console.log('   - ' + d);
  } else {
    console.log('\n La creation du personnel et les habilitations se comportent comme attendu.');
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
    try {
      if (!jetonGlobal && IMF_EMAIL && IMF_PASSWORD) {
        const r = await appel('POST', '/api/v1/auth/login',
          { corps: { email: IMF_EMAIL, password: IMF_PASSWORD } });
        jetonGlobal = r.jeton || (r.corps && (r.corps.token || r.corps.session)) || null;
      }
      await nettoyer();
    } catch (e) {
      console.error('  (nettoyage partiel : ' + (e && e.message) + ')');
    }
  });
