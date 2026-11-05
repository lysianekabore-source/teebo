#!/usr/bin/env node
/* ===================================================================
 * teebo — SEED DE DÉMONSTRATION LOCALE
 *
 * Crée automatiquement une IMF complète et prête à tester :
 *   - 1 administrateur IMF
 *   - 1 DG
 *   - 1 superviseur + 3 collectrices (avec rattachement hiérarchique)
 *   - des cibles d'exemple + quelques collectes déjà saisies
 *
 * Usage :  node tools/seed-demo.mjs
 * Prérequis : l'API doit tourner sur http://127.0.0.1:3000
 *
 * Le script est IDEMPOTENT au niveau des comptes : s'il détecte que la
 * démo existe déjà (mêmes e-mails), il s'arrête proprement.
 * =================================================================== */
const BASE = process.env.TEEBO_BASE || 'http://127.0.0.1:3000';
let jar = '';

async function api(p, o = {}) {
  const r = await fetch(BASE + p, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(jar ? { cookie: jar } : {}), ...(o.headers || {}) },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  const sc = r.headers.get('set-cookie'); if (sc) jar = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  let data; if (ct.includes('json')) data = await r.json().catch(() => ({})); else data = await r.text();
  return { status: r.status, ok: r.ok, data };
}
const D = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const rnd = () => crypto.randomUUID();
const PWD = { admin: 'DemoAdmin#2026', dg: 'DemoDg#2026x', sup: 'DemoSup#2026x', col: 'DemoCol#2026x' };

async function main() {
  console.log('\n=== teebo — initialisation de la démo locale ===\n');

  // 1) demande d'accès + approbation teebo
  const req = await api('/api/v1/requests', { method: 'POST', body: {
    lastname: 'Demo', firstname: 'Local', position: 'DG', country_code: 'BF', imf_type: 'SA',
    capital_cents: 150000000, bceao_agreement_no: 'BF-DEMO-01', whatsapp: '+22670001111',
    phone_main: '+22670002222', city: 'Ouagadougou', email: 'admin@demo-teebo.bf',
    admin_name: 'Admin Démo', imf_name: 'IMF Démo Locale' } });
  if (!req.ok) { console.error('Échec création IMF :', req.data); process.exit(1); }
  const rid = req.data.request_id;
  await api('/api/v1/requests/' + rid + '/select-plan', { method: 'POST', body: { plan_code: 'business' } });
  await api('/api/v1/requests/' + rid + '/validate-proforma', { method: 'POST', body: {} });

  // connexion éditeur teebo pour approuver
  jar = '';
  await api('/api/v1/auth/login', { method: 'POST', body: {
    identifier: process.env.TEEBO_ADMIN_EMAIL || 'hello@teebo.africa',
    password: process.env.TEEBO_ADMIN_PASSWORD || 'Teebo#Admin2026' } });
  const ap = await api('/api/v1/teebo/requests/' + rid + '/approve', { method: 'POST', body: {} });
  const adminCode = ap.data.admin_code || ap.data.code_user || ap.data.code;
  if (!adminCode) { console.error('Approbation échouée :', ap.data); process.exit(1); }

  // activation + connexion admin IMF
  await api('/api/v1/auth/activate', { method: 'POST', body: { code: adminCode, password: PWD.admin } });
  jar = '';
  const li = await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'admin@demo-teebo.bf', password: PWD.admin } });
  if (!li.ok) { console.error('Connexion admin IMF échouée :', li.data); process.exit(1); }

  // 2) arborescence : direction > département > service > agence
  const mkUnit = async (kind, name, parent_id) =>
    (await api('/api/v1/units', { method: 'POST', body: { kind, name, parent_id } })).data.unit.id;
  const uDir = await mkUnit('direction', 'Direction Générale');
  const uDep = await mkUnit('department', 'Département Commercial', uDir);
  const uSer = await mkUnit('service', 'Service Collecte', uDep);
  const uAg = await mkUnit('agency', 'Agence Centrale', uSer);

  // 3) utilisateurs
  const mk = async (name, email, role, unit, phone) =>
    api('/api/v1/users', { method: 'POST', body: { full_name: name, email, role, org_unit_id: unit, phone } });
  const dgU = await mk('Directeur Général', 'dg@demo-teebo.bf', 'dg', uDir, '+22670003333');
  const supU = await mk('Superviseur Terrain', 'sup@demo-teebo.bf', 'supervisor', uSer, '+22670004444');
  const cA = await mk('Collectrice Awa', 'c1@demo-teebo.bf', 'collectrice', uAg, '+22670005551');
  const cB = await mk('Collectrice Binta', 'c2@demo-teebo.bf', 'collectrice', uAg, '+22670005552');
  const cC = await mk('Collectrice Coumba', 'c3@demo-teebo.bf', 'collectrice', uAg, '+22670005553');

  const users = (await api('/api/v1/users')).data.users;
  const idOf = (code) => users.find((u) => u.code_user === code)?.id;
  const dgId = idOf(dgU.data.code_user), supId = idOf(supU.data.code_user);
  const [c1, c2, c3] = [idOf(cA.data.code_user), idOf(cB.data.code_user), idOf(cC.data.code_user)];

  // rattachement hiérarchique
  await api('/api/v1/users/' + supId, { method: 'PATCH', body: { parent_id: dgId } });
  for (const c of [c1, c2, c3]) await api('/api/v1/users/' + c, { method: 'PATCH', body: { parent_id: supId } });

  // activation des comptes
  for (const [code, pwd] of [[dgU.data.code_user, PWD.dg], [supU.data.code_user, PWD.sup],
                              [cA.data.code_user, PWD.col], [cB.data.code_user, PWD.col], [cC.data.code_user, PWD.col]])
    await api('/api/v1/auth/activate', { method: 'POST', body: { code, password: pwd } });

  // 4) cibles : DG -> superviseur (3M), superviseur -> 3 collectrices (1M chacune)
  const START = D(-5), END = D(25);
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'dg@demo-teebo.bf', password: PWD.dg } });
  await api('/api/v1/objectives', { method: 'POST', body: {
    assigned_to_user_id: supId, kpi_type: 'COLLECTION_VOLUME', period: 'MONTHLY',
    target_value: 3000000, unit: 'FCFA', start_date: START, end_date: END } });

  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'sup@demo-teebo.bf', password: PWD.sup } });
  await api('/api/v1/objectives/team-allocations', { method: 'POST', body: {
    kpi_type: 'COLLECTION_VOLUME', period: 'MONTHLY', start_date: START, end_date: END,
    allocations: [
      { assigned_to_user_id: c1, target_value: 1000000 },
      { assigned_to_user_id: c2, target_value: 1000000 },
      { assigned_to_user_id: c3, target_value: 1000000 }
    ] } });

  // cible NEW_ACCOUNTS pour la collectrice 1
  await api('/api/v1/objectives', { method: 'POST', body: {
    assigned_to_user_id: c1, kpi_type: 'NEW_ACCOUNTS', period: 'MONTHLY',
    target_value: 40, unit: 'comptes', start_date: START, end_date: END, draft: true } });

  // 5) quelques collectes pour amorcer les tableaux de bord
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'admin@demo-teebo.bf', password: PWD.admin } });
  for (const [u, amt] of [[c1, 450000], [c1, 300000], [c2, 600000], [c3, 250000]])
    await api('/api/v1/objectives/progress/collection', { method: 'POST', body: { user_id: u, amount_fcfa: amt, source_id: rnd() } });

  console.log('Démo prête ! Connectez-vous avec :\n');
  console.log('  Administrateur IMF : admin@demo-teebo.bf / ' + PWD.admin);
  console.log('  Directeur général  : dg@demo-teebo.bf    / ' + PWD.dg);
  console.log('  Superviseur        : sup@demo-teebo.bf   / ' + PWD.sup);
  console.log('  Collectrices       : c1/c2/c3@demo-teebo.bf / ' + PWD.col);
  console.log('  Console éditeur    : hello@teebo.africa  / Teebo#Admin2026\n');
  console.log('Objectifs : DG 3 000 000 FCFA -> 3 collectrices de 1 000 000 FCFA.');
  console.log('Ouvrez le module Objectifs pour voir les tableaux de bord.\n');
}

main().catch((e) => { console.error('Erreur de seed :', e.message); process.exit(1); });
