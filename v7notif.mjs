// VAGUE 7 — NOTIFICATIONS AUTOMATIQUES D'OBJECTIF
//   Vérifie que les paliers 50 % / 80 % / 100 % sont émis une seule fois,
//   qu'ils remontent sur toute la chaîne, et que le journal est consultable.
const BASE = 'http://127.0.0.1:3000';
let jar = '';
let pass = 0, fail = 0;
const fails = [];
function ok(n, c, d) { if (c) { pass++; console.log('  \u2705 ' + n); } else { fail++; fails.push(n); console.log('  \u274c ' + n + '  -> ' + (d || '')); } }
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
function J(d) { try { return JSON.stringify(d).slice(0, 240); } catch { return String(d); } }
const D = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const rnd = () => crypto.randomUUID();

(async () => {
  console.log('\n====== VAGUE 7 — NOTIFICATIONS AUTOMATIQUES ======\n');

  // --- bootstrap IMF + admin ---
  const req = await api('/api/v1/requests', { method: 'POST', body: {
    lastname: 'NT', firstname: 'Test', position: 'DG', country_code: 'BF', imf_type: 'SA',
    capital_cents: 100000000, bceao_agreement_no: 'BF-NT-001', whatsapp: '+22670009001',
    phone_main: '+22670009002', city: 'Ouagadougou', email: 'direction@imf-notif.bf',
    admin_name: 'Admin Notif', imf_name: 'IMF Notif' } });
  const rid = req.data.request_id;
  await api('/api/v1/requests/' + rid + '/select-plan', { method: 'POST', body: { plan_code: 'business' } });
  await api('/api/v1/requests/' + rid + '/validate-proforma', { method: 'POST', body: {} });
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'hello@teebo.africa', password: 'Teebo#Admin2026' } });
  const ap = await api('/api/v1/teebo/requests/' + rid + '/approve', { method: 'POST', body: {} });
  const code = ap.data.admin_code || ap.data.code_user || ap.data.code;
  await api('/api/v1/auth/activate', { method: 'POST', body: { code, password: 'ImfAdmin#2026' } });
  jar = '';
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'direction@imf-notif.bf', password: 'ImfAdmin#2026' } });

  // --- unités ---
  const u1 = await api('/api/v1/units', { method: 'POST', body: { kind: 'direction', name: 'Dir NT' } });
  const u1id = u1.data.unit.id;
  const u1b = await api('/api/v1/units', { method: 'POST', body: { kind: 'department', name: 'Dep NT', parent_id: u1id } });
  const u1bid = u1b.data.unit.id;
  const u2 = await api('/api/v1/units', { method: 'POST', body: { kind: 'service', name: 'Serv NT', parent_id: u1bid } });
  const u2id = u2.data.unit.id;

  const mk = async (name, email, role, unit) => api('/api/v1/users', { method: 'POST', body: { full_name: name, email, role, org_unit_id: unit, phone: '+22670009000' } });
  const dgU = await mk('DG NT', 'dg.notif@imf-notif.bf', 'dg', u1id);
  const supU = await mk('Sup NT', 'sup.notif@imf-notif.bf', 'supervisor', u2id);
  const c1U = await mk('Collectrice NT', 'c1.notif@imf-notif.bf', 'collectrice', u2id);
  const users = (await api('/api/v1/users')).data.users;
  const idOf = (c) => users.find((u) => u.code_user === c)?.id;
  const dgId = idOf(dgU.data.code_user), supId = idOf(supU.data.code_user), c1 = idOf(c1U.data.code_user);

  await api('/api/v1/users/' + supId, { method: 'PATCH', body: { parent_id: dgId } });
  await api('/api/v1/users/' + c1, { method: 'PATCH', body: { parent_id: supId } });

  // activer les comptes
  for (const [c, p] of [[dgU.data.code_user, 'Dg#2026Test'], [supU.data.code_user, 'Sup#2026Test'], [c1U.data.code_user, 'Co#2026Test']])
    await api('/api/v1/auth/activate', { method: 'POST', body: { code: c, password: p } });

  const START = D(-1), END = D(20);

  // --- DG pose une cible 100 000 au superviseur ---
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'dg.notif@imf-notif.bf', password: 'Dg#2026Test' } });
  const supObj = await api('/api/v1/objectives', { method: 'POST', body: {
    assigned_to_user_id: supId, kpi_type: 'COLLECTION_VOLUME', period: 'MONTHLY',
    target_value: 100000, start_date: START, end_date: END } });
  ok('Cible superviseur créée', supObj.status === 201, 'HTTP ' + supObj.status + ' ' + J(supObj.data));

  // superviseur répartit sur la collectrice
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'sup.notif@imf-notif.bf', password: 'Sup#2026Test' } });
  const alloc = await api('/api/v1/objectives/team-allocations', { method: 'POST', body: {
    kpi_type: 'COLLECTION_VOLUME', period: 'MONTHLY', start_date: START, end_date: END,
    allocations: [{ assigned_to_user_id: c1, target_value: 100000 }] } });
  ok('Répartition collectrice créée', alloc.status === 201, 'HTTP ' + alloc.status + ' ' + J(alloc.data));

  // --- collectes franchissant les paliers (gérés par le DG pour simplifier) ---
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'direction@imf-notif.bf', password: 'ImfAdmin#2026' } });

  // 1) 40 % -> aucun palier
  const r1 = await api('/api/v1/objectives/progress/collection', { method: 'POST', body: { user_id: c1, amount_fcfa: 40000, source_id: rnd() } });
  const ev1 = (r1.data.events || []).find((e) => e.role === 'collectrice');
  ok('40 % -> aucune notification', ev1 && (ev1.notifications || []).length === 0, J(ev1));

  // 2) +15 % = 55 % -> palier 'half'
  const r2 = await api('/api/v1/objectives/progress/collection', { method: 'POST', body: { user_id: c1, amount_fcfa: 15000, source_id: rnd() } });
  const ev2 = (r2.data.events || []).find((e) => e.role === 'collectrice');
  const n2 = (ev2 && ev2.notifications) || [];
  ok('55 % -> palier 50 % émis', n2.some((x) => x.event === 'half'), J(n2));

  // 3) +30 % = 85 % -> palier 'near' (et PAS de re-émission de 'half')
  const r3 = await api('/api/v1/objectives/progress/collection', { method: 'POST', body: { user_id: c1, amount_fcfa: 30000, source_id: rnd() } });
  const ev3 = (r3.data.events || []).find((e) => e.role === 'collectrice');
  const n3 = (ev3 && ev3.notifications) || [];
  ok('85 % -> palier 80 % émis', n3.some((x) => x.event === 'near'), J(n3));
  ok('85 % -> palier 50 % NON re-émis', !n3.some((x) => x.event === 'half'), J(n3));

  // 4) +15 % = 100 % -> palier 'achieved'
  const r4 = await api('/api/v1/objectives/progress/collection', { method: 'POST', body: { user_id: c1, amount_fcfa: 15000, source_id: rnd() } });
  const ev4 = (r4.data.events || []).find((e) => e.role === 'collectrice');
  const n4 = (ev4 && ev4.notifications) || [];
  ok('100 % -> palier objectif atteint', n4.some((x) => x.event === 'achieved'), J(n4));
  ok('Statut cible = ACHIEVED', ev4 && ev4.status === 'ACHIEVED', J(ev4));

  // 5) le superviseur a aussi reçu ses paliers (roll-up de la chaîne)
  const supEv = (r4.data.events || []).find((e) => e.role === 'supervisor');
  ok('Le superviseur reçoit aussi ses paliers', supEv && (supEv.notifications || []).some((x) => x.event === 'achieved'), J(supEv));

  // 6) rejeu du même dépôt -> pas de re-notification
  const sidDup = rnd();
  await api('/api/v1/objectives/progress/collection', { method: 'POST', body: { user_id: c1, amount_fcfa: 1000, source_id: sidDup } });
  const r6 = await api('/api/v1/objectives/progress/collection', { method: 'POST', body: { user_id: c1, amount_fcfa: 1000, source_id: sidDup } });
  const ev6 = (r6.data.events || []).find((e) => e.role === 'collectrice');
  ok('Rejeu -> ignoré (aucune nouvelle notification)', ev6 && ev6.skipped === 'duplicate', J(ev6));

  // --- journal des notifications consultable ---
  const list = await api('/api/v1/objectives/notifications');
  const notifs = (list.data.notifications) || [];
  ok('Journal des notifications accessible', list.ok && Array.isArray(notifs), 'HTTP ' + list.status);
  ok('Journal contient les 3 paliers', ['half', 'near', 'achieved'].every((e) => notifs.some((n) => n.event === e)),
     'events=' + notifs.map((n) => n.event).join(','));

  console.log('\n============ RESULTAT (NOTIFICATIONS) ============');
  console.log('  Reussis : ' + pass);
  console.log('  Echecs  : ' + fail);
  if (fails.length) console.log('  Détail  : ' + fails.join(' | '));
  console.log('=================================================');
  process.exit(fail ? 1 : 0);
})();
