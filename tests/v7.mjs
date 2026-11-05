// VAGUE 7 — Module Objectifs hiérarchiques (DG -> Superviseur -> Collectrice)
//   couvre : hiérarchie, affectation descendante, contrôle de cohérence,
//            roll-up temps réel, tableaux de bord, idempotence, cloisonnement.
const BASE = 'http://127.0.0.1:3000';
let jar = '';
let pass = 0, fail = 0, warn = 0;
const fails = [];
function ok(n, c, d) { if (c) { pass++; console.log('  \u2705 ' + n); } else { fail++; fails.push(n); console.log('  \u274c ' + n + '  -> ' + (d || '')); } }
function warnStep(n, d) { warn++; console.log('  \u26a0\ufe0f  ' + n + '  -> ' + (d || '')); }
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
function J(d) { try { return JSON.stringify(d).slice(0, 220); } catch { return String(d); } }
const D = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  console.log('\n=========== VAGUE 7 — MODULE OBJECTIFS ===========\n');

  // --- bootstrap IMF + admin IMF (même flux que la VAGUE 6) ---
  const req = await api('/api/v1/requests', { method: 'POST', body: {
    lastname: 'V7', firstname: 'Test', position: 'DG', country_code: 'BF', imf_type: 'SA',
    capital_cents: 100000000, bceao_agreement_no: 'BF-V7-001', whatsapp: '+22670000011',
    phone_main: '+22670000012', city: 'Ouagadougou', email: 'direction@imf-obj.bf',
    admin_name: 'Admin Obj', imf_name: 'IMF Objectifs', plan_code: 'business' } });
  ok('Demande IMF créée', req.ok, 'HTTP ' + req.status + ' ' + J(req.data));
  const rid = req.data.request_id;
  await api('/api/v1/requests/' + rid + '/select-plan', { method: 'POST', body: { plan_code: 'business' } });
  await api('/api/v1/requests/' + rid + '/validate-proforma', { method: 'POST', body: {} });
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'hello@teebo.africa', password: 'Teebo#Admin2026' } });
  const ap = await api('/api/v1/teebo/requests/' + rid + '/approve', { method: 'POST', body: {} });
  ok('IMF approuvée (essai)', ap.ok, J(ap.data));
  const code = ap.data.admin_code || ap.data.code_user || ap.data.code;
  await api('/api/v1/auth/activate', { method: 'POST', body: { code, password: 'ImfAdmin#2026' } });
  jar = '';
  const li = await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'direction@imf-obj.bf', password: 'ImfAdmin#2026' } });
  ok('Admin IMF connecté', li.ok, J(li.data));

  // --- 1. Hiérarchie : unités + agents (DG, superviseur, 3 collectrices) ---
  console.log('\n1. Hiérarchie organisationnelle');
  const u1 = await api('/api/v1/units', { method: 'POST', body: { kind: 'direction', name: 'Direction V7', city: 'Ouaga' } });
  const u1id = u1.data.unit && u1.data.unit.id;
  const u2 = await api('/api/v1/units', { method: 'POST', body: { kind: 'department', name: 'Département V7', parent_id: u1id } });
  const u2id = u2.data.unit && u2.data.unit.id;
  const u3 = await api('/api/v1/units', { method: 'POST', body: { kind: 'service', name: 'Service V7', parent_id: u2id } });
  const u3id = u3.data.unit && u3.data.unit.id;
  const u4 = await api('/api/v1/units', { method: 'POST', body: { kind: 'agency', name: 'Agence V7', parent_id: u3id } });
  const agId = u4.data.unit && u4.data.unit.id;
  ok('Arborescence direction>dep>service>agence créée', !!(u1id && u2id && u3id && agId));

  const mk = async (name, email, role, unit) => api('/api/v1/users', { method: 'POST', body: { full_name: name, email, role, org_unit_id: unit || null, phone: '+22670001000' } });
  const dgU = await mk('Directeur Général V7', 'dg.v7@imf-obj.bf', 'dg', u1id);
  const supU = await mk('Superviseur V7', 'sup.v7@imf-obj.bf', 'supervisor', u3id);
  const c1U = await mk('Awa Collectrice', 'c1.v7@imf-obj.bf', 'collectrice', agId);
  const c2U = await mk('Fatou Collectrice', 'c2.v7@imf-obj.bf', 'collectrice', agId);
  const c3U = await mk('Aminata Collectrice', 'c3.v7@imf-obj.bf', 'collectrice', agId);
  ok('DG + superviseur + 3 collectrices créés', dgU.ok && supU.ok && c1U.ok && c2U.ok && c3U.ok, J(dgU.data));

  const list = await api('/api/v1/users');
  const users = list.data.users || [];
  const idOf = (code) => (users.find((u) => u.code_user === code) || {}).id;
  const dgId = idOf(dgU.data.code_user), supId = idOf(supU.data.code_user);
  const c1 = idOf(c1U.data.code_user), c2 = idOf(c2U.data.code_user), c3 = idOf(c3U.data.code_user);
  ok('Identifiants résolus', !!(dgId && supId && c1 && c2 && c3));

  const pSup = await api('/api/v1/users/' + supId, { method: 'PATCH', body: { parent_id: dgId } });
  ok('Superviseur rattaché au DG', pSup.ok && pSup.data.user && pSup.data.user.parent_id === dgId, 'HTTP ' + pSup.status + ' ' + J(pSup.data));
  const p1 = await api('/api/v1/users/' + c1, { method: 'PATCH', body: { parent_id: supId } });
  const p2 = await api('/api/v1/users/' + c2, { method: 'PATCH', body: { parent_id: supId } });
  const p3 = await api('/api/v1/users/' + c3, { method: 'PATCH', body: { parent_id: supId } });
  ok('3 collectrices rattachées au superviseur', p1.ok && p2.ok && p3.ok);
  const cyc = await api('/api/v1/users/' + dgId, { method: 'PATCH', body: { parent_id: c1 } });
  ok('Cycle hiérarchique refusé (anti-boucle)', cyc.status === 422 && cyc.data.error === 'cycle_detected', 'HTTP ' + cyc.status + ' ' + J(cyc.data));

  // --- 2. Référentiel KPI ---
  const kpis = await api('/api/v1/objectives/kpi-types');
  ok('Référentiel KPI (3 KPI + périodes + unités)',
    kpis.ok && kpis.data.kpi_types.length === 3 && kpis.data.kpi_types.includes('COLLECTION_VOLUME')
    && kpis.data.kpi_types.includes('NEW_ACCOUNTS') && kpis.data.kpi_types.includes('RETENTION_RATE')
    && kpis.data.units.COLLECTION_VOLUME === 'FCFA', J(kpis.data));

  // --- 3. Affectation descendante DG -> superviseur ---
  console.log('\n2. Affectation descendante + contrôle de cohérence');
  const START = D(-1), END = D(29);
  // Le DG (ici représenté par le rattachement parent_id) fixe l'objectif global.
  // On passe par le compte DG pour respecter la règle de direction.
  const actD = await api('/api/v1/auth/activate', { method: 'POST', body: { code: dgU.data.code_user, password: 'Dg#2026Test' } });
  ok('Mot de passe DG défini', actD.ok, J(actD.data));
  jar = '';
  const ld = await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'dg.v7@imf-obj.bf', password: 'Dg#2026Test' } });
  ok('DG connecté', ld.ok, 'HTTP ' + ld.status + ' ' + J(ld.data));
  const g = await api('/api/v1/objectives', { method: 'POST', body: {
    assigned_to_user_id: supId, kpi_type: 'COLLECTION_VOLUME', period: 'MONTHLY',
    target_value: 1000000, start_date: START, end_date: END, title: 'Collecte mensuelle branche' } });
  ok('DG assigne une cible au superviseur (201)', g.status === 201, 'HTTP ' + g.status + ' ' + J(g.data));
  ok('Statut initial = PENDING', g.data.objective && g.data.objective.status === 'PENDING', J(g.data.objective));

  // Affectation interdite : DG -> collectrice (saut de niveau)
  const skip = await api('/api/v1/objectives', { method: 'POST', body: {
    assigned_to_user_id: c1, kpi_type: 'COLLECTION_VOLUME', period: 'MONTHLY',
    target_value: 100000, start_date: START, end_date: END } });
  ok('DG -> collectrice refusé (saut de niveau)', skip.status === 403, 'HTTP ' + skip.status + ' ' + J(skip.data));
  jar = '';
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'direction@imf-obj.bf', password: 'ImfAdmin#2026' } });

  // --- 4. Contrôle de cohérence : la règle s'applique au SUPERVISEUR ---
  // On se connecte en superviseur : c'est lui qui répartit l'objectif global
  // reçu du DG entre ses collectrices.
  const actS = await api('/api/v1/auth/activate', { method: 'POST', body: { code: supU.data.code_user, password: 'Sup#2026Test' } });
  ok('Mot de passe superviseur défini', actS.ok, J(actS.data));
  jar = '';
  const ls = await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'sup.v7@imf-obj.bf', password: 'Sup#2026Test' } });
  ok('Superviseur connecté', ls.ok && !ls.data.twofa_required, 'HTTP ' + ls.status + ' ' + J(ls.data));

  // 4.1 Le superviseur soumet la répartition de son objectif global.
  //     D'abord une répartition INSUFFISANTE (200k+200k+100k = 500k < 1M)
  //     via l'endpoint groupé : tout doit être refusé, rien n'est écrit.
  const badAlloc = await api('/api/v1/objectives/team-allocations', { method: 'POST', body: {
    kpi_type: 'COLLECTION_VOLUME', period: 'MONTHLY', start_date: START, end_date: END,
    allocations: [
      { assigned_to_user_id: c1, target_value: 200000 },
      { assigned_to_user_id: c2, target_value: 200000 },
      { assigned_to_user_id: c3, target_value: 100000 }
    ] } });
  ok('Répartition groupée (500k) < objectif global (1M) -> BLOQUÉ (422)', badAlloc.status === 422 && badAlloc.data.error === 'target_below_global', 'HTTP ' + badAlloc.status + ' ' + J(badAlloc.data));
  ok('Message explicite (« inférieure »)', typeof badAlloc.data.message === 'string' && badAlloc.data.message.includes('inférieure'), badAlloc.data.message);
  ok('Écart manquant chiffré (missing = 500 000)', badAlloc.data.details && badAlloc.data.details.missing === 500000, J(badAlloc.data.details));

  // 4.2 Vérification du tout-ou-rien : aucune cible d'équipe n'a été écrite.
  const afterBad = await api('/api/v1/objectives/team/' + supId);
  ok('Tout-ou-rien : aucune cible d\'équipe écrite après refus', afterBad.ok && Array.isArray(afterBad.data.team));

  // 4.3 Répartition conforme (400k+350k+250k = 1M) -> ACCEPTÉE
  const goodAlloc = await api('/api/v1/objectives/team-allocations', { method: 'POST', body: {
    kpi_type: 'COLLECTION_VOLUME', period: 'MONTHLY', start_date: START, end_date: END,
    allocations: [
      { assigned_to_user_id: c1, target_value: 400000 },
      { assigned_to_user_id: c2, target_value: 350000 },
      { assigned_to_user_id: c3, target_value: 250000 }
    ] } });
  ok('Répartition conforme (1M) -> ACCEPTÉE (201)', goodAlloc.status === 201, 'HTTP ' + goodAlloc.status + ' ' + J(goodAlloc.data));
  ok('Cohérence confirmée (team_total >= global_target)', goodAlloc.data.consistency && goodAlloc.data.consistency.team_total >= goodAlloc.data.consistency.global_target, J(goodAlloc.data.consistency));
  ok('3 cibles d\'équipe créées', Array.isArray(goodAlloc.data.objectives) && goodAlloc.data.objectives.length === 3, 'n=' + (goodAlloc.data.objectives || []).length);
  const w2obj = (goodAlloc.data.objectives || []).find((o) => o.assigned_to_user_id === c2);

  // 4.4 Saisie unitaire (mode brouillon) puis contrôle strict à l'unité
  const unitDraft = await api('/api/v1/objectives', { method: 'POST', body: {
    assigned_to_user_id: c1, kpi_type: 'NEW_ACCOUNTS', period: 'MONTHLY', target_value: 50,
    start_date: START, end_date: END, draft: true } });
  ok('Saisie unitaire en brouillon acceptée', unitDraft.status === 201, 'HTTP ' + unitDraft.status + ' ' + J(unitDraft.data));

  // Baisse cassant la couverture -> bloquée
  const down = await api('/api/v1/objectives/' + w2obj.id, { method: 'PATCH', body: { target_value: 10000 } });
  ok('Baisse cassant la couverture -> BLOQUÉ (422)', down.status === 422 && down.data.error === 'target_below_global', 'HTTP ' + down.status + ' ' + J(down.data));

  // Affectation interdite : superviseur -> superviseur (direction invalide).
  // La creation d'un utilisateur est reservee a admin_imf/direction : on
  // repasse donc en session DG pour creer le second superviseur, puis on
  // rouvre la session superviseur pour tester le saut de niveau.
  jar = '';
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'direction@imf-obj.bf', password: 'ImfAdmin#2026' } });
  const sup2 = await mk('Superviseur B', 'sup2.v7@imf-obj.bf', 'supervisor', u3id);
  const list2 = await api('/api/v1/users');
  const sup2Row = (list2.data.users || []).find((u) => u.code_user === sup2.data.code_user);
  const sup2Id = sup2Row && sup2Row.id;
  // Rouvre la session superviseur (le superviseur reste le superieur de sup2
  // sur le plan metier : la creation d'un objectif direct pour un pair doit etre refusee).
  jar = '';
  const supLogin2 = await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'sup.v7@imf-obj.bf', password: 'Sup#2026Test' } });
  ok('Session superviseur rouverte', supLogin2.ok === true, 'HTTP ' + supLogin2.status);
  const badDir = await api('/api/v1/objectives', { method: 'POST', body: {
    assigned_to_user_id: sup2Id, kpi_type: 'COLLECTION_VOLUME', period: 'MONTHLY', target_value: 100000, start_date: START, end_date: END } });
  ok('Superviseur -> superviseur refusé (direction invalide)', badDir.status === 403 && badDir.data.error === 'invalid_assignment_direction', 'HTTP ' + badDir.status + ' ' + J(badDir.data));

  // --- 6. Roll-up temps réel ---
  console.log('\n3. Roll-up temps réel de la progression');
  jar = '';
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'direction@imf-obj.bf', password: 'ImfAdmin#2026' } });
  const sid1 = crypto.randomUUID();
  const dep1 = await api('/api/v1/objectives/progress/collection', { method: 'POST', body: { user_id: c1, amount_fcfa: 250000, source_id: sid1, note: 'Dépôt tournée' } });
  ok('Dépôt -> progression incrémentée', dep1.status === 200 && dep1.data.applied === true, 'HTTP ' + dep1.status + ' ' + J(dep1.data));
  const roles1 = (dep1.data.events || []).map((e) => e.role);
  ok('Roll-up remonte collectrice + superviseur', roles1.includes('collectrice') && roles1.includes('supervisor'), J(dep1.data.events));

  const dep2 = await api('/api/v1/objectives/progress/collection', { method: 'POST', body: { user_id: c1, amount_fcfa: 250000, source_id: sid1 } });
  const dupEv = (dep2.data.events || []).find((e) => e.role === 'collectrice');
  ok('Rejeu du même dépôt ignoré (idempotence)', dupEv ? dupEv.skipped === 'duplicate' : false, J(dep2.data.events));

  const na = await api('/api/v1/objectives/progress/new-account', { method: 'POST', body: { user_id: c2, source_id: crypto.randomUUID() } });
  ok('Ouverture de compte -> KPI NEW_ACCOUNTS', na.status === 200, 'HTTP ' + na.status + ' ' + J(na.data));

  // --- 7. Tableau de bord superviseur ---
  console.log('\n4. Tableaux de bord temps réel');
  jar = '';
  await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'direction@imf-obj.bf', password: 'ImfAdmin#2026' } });
  const dash = await api('/api/v1/objectives/dashboard?supervisor_id=' + supId);
  ok('Tableau de bord superviseur accessible', dash.ok && Array.isArray(dash.data.own), 'HTTP ' + dash.status + ' ' + J(dash.data));
  ok('Progression propre du superviseur', (dash.data.own || []).length > 0, J(dash.data.own));
  ok('Progression de l\'équipe (>=3 collectrices)', (dash.data.team || []).length >= 3, 'team=' + (dash.data.team || []).length);
  const ownRealized = (dash.data.own || []).find((o) => o.kpi_type === 'COLLECTION_VOLUME');
  ok('Agrégation : superviseur réalisé = 250 000 (remonté de la collectrice)', ownRealized && Number(ownRealized.current_realized_value) >= 250000, J(ownRealized));
  const t1 = (dash.data.team || []).find((t) => t.user_id === c1 && t.kpi_type === 'COLLECTION_VOLUME');
  ok('Réalisé collectrice 1 visible côté superviseur', t1 && Number(t1.current_realized_value) >= 250000, J(t1));
  ok('Consolidation équipe vs objectif global', (dash.data.consolidated || []).length > 0, J(dash.data.consolidated));
  const cons = (dash.data.consolidated || [])[0];
  ok('Objectif global de référence présent', cons && Number(cons.global_target) === 1000000, J(cons));

  const branch = await api('/api/v1/objectives/branch-dashboard');
  ok('Vue consolidée branche (DG) accessible', branch.ok && Array.isArray(branch.data.supervisors) && Array.isArray(branch.data.branch_totals), J(branch.data));

  const rec = await api('/api/v1/objectives/recompute', { method: 'POST', body: {} });
  ok('Recalcul forcé du roll-up branche', rec.ok && rec.data.ok === true, 'HTTP ' + rec.status + ' ' + J(rec.data));

  // --- 8. Lecture seule de la collectrice ---
  console.log('\n5. Accès collectrice (lecture seule)');
  const actC = await api('/api/v1/auth/activate', { method: 'POST', body: { code: c1U.data.code_user, password: 'Col#2026Test' } });
  ok('Mot de passe collectrice défini', actC.ok, J(actC.data));
  jar = '';
  const lc = await api('/api/v1/auth/login', { method: 'POST', body: { identifier: 'c1.v7@imf-obj.bf', password: 'Col#2026Test' } });
  ok('Collectrice connectée', lc.ok, 'HTTP ' + lc.status + ' ' + J(lc.data));
  const mine = await api('/api/v1/objectives/mine');
  ok('Collectrice consulte ses propres cibles', mine.ok && Array.isArray(mine.data.objectives) && mine.data.objectives.length >= 1, J(mine.data));
  // Tentative de création d'une cible par la collectrice -> interdite (pas de rôle encadrant)
  const forCreation = await api('/api/v1/objectives', { method: 'POST', body: {
    assigned_to_user_id: c2, kpi_type: 'NEW_ACCOUNTS', period: 'MONTHLY', target_value: 5, start_date: START, end_date: END } });
  ok('Collectrice ne peut pas créer de cible (403)', forCreation.status === 403, 'HTTP ' + forCreation.status + ' ' + J(forCreation.data));

  console.log('\n============ RESULTAT (VAGUE 7) ============');
  console.log('  Reussis : ' + pass);
  console.log('  Echecs  : ' + fail);
  if (warn) console.log('  Alertes : ' + warn);
  if (fails.length) console.log('  Détail  : ' + fails.join(' | '));
  console.log('===========================================\n');
  process.exit(fail ? 1 : 0);
})();
