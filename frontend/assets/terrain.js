/* teebo terrain — collectrice : 5 actions + couplage strict appareil */
(function () {
  'use strict';

  /* ---- Identification du terminal (couplage strict) --------------------
   * En production, ces valeurs proviennent du conteneur natif (Android/iOS)
   * via une passerelle sécurisée. Pour la démonstration web, elles sont
   * mémorisées localement après un premier appairage, ou générées de façon
   * stable afin de simuler un terminal donné.
   */
  const LS_DEV = 'teebo.terrain.device';
  function getDevice() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(LS_DEV) || 'null'); } catch (e) { d = null; }
    if (!d) {
      // Terminal simulé : IMEI 15 chiffres + MAC stable.
      const rnd = (n) => crypto.getRandomValues(new Uint8Array(n)).reduce((a, b) => a + (b % 16).toString(16), '');
      d = { imei: (Date.now().toString().slice(-6) + rnd(9)).slice(0, 15).padEnd(15, '0'),
        mac: '02:', mac: '02:' + rnd(2) + ':' + rnd(2) + ':' + rnd(2) + ':' + rnd(2) + ':' + rnd(2) };
      try { localStorage.setItem(LS_DEV, JSON.stringify(d)); } catch (e) {}
    }
    return { imei: d.imei, mac: (d.mac || '').toUpperCase() };
  }
  const DEV = getDevice();
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const xof = (c) => (Number(c || 0) / 100).toLocaleString('fr-FR') + ' XOF';
  const parseAmt = (v) => Math.round(Number(String(v).replace(/[^0-9]/g, '')) * 100) || 0;
  let ME = null;

  async function api(path, opts) {
    const o = Object.assign({ credentials: 'include', headers: { 'Content-Type': 'application/json',
      'X-Device-IMEI': DEV.imei, 'X-Device-MAC': DEV.mac } }, opts || {});
    if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
    const r = await fetch('/api/v1' + path, o);
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { const err = new Error((j && (j.message || j.error)) || ('Erreur ' + r.status)); err.status = r.status; err.data = j; throw err; }
    return j;
  }

  function show(name) {
    ['scr-login', 'scr-blocked', 'scr-app'].forEach((id) => { el(id).hidden = id !== name; });
  }
  function flash(id, kind, msg) { const a = el(id); a.className = 'alert alert--' + kind; a.textContent = msg; a.hidden = false; }

  /* ---- Démarrage : affiche l'identité du terminal ---------------------- */
  el('self-imei').textContent = DEV.imei;
  el('self-mac').textContent = DEV.mac;
  el('blocked-imei').textContent = DEV.imei;
  el('blocked-mac').textContent = DEV.mac;
  el('who-device').textContent = 'Terminal ' + DEV.imei.slice(-4) + ' · ' + DEV.mac;

  /* ---- Connexion par identifiant + PIN -------------------------------- */
  el('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('login-alert').hidden = true;
    const identifier = el('identifier').value.trim();
    const pin = el('pin').value.trim();
    if (!identifier || !/^\d{4,8}$/.test(pin)) { flash('login-alert', 'err', 'Identifiant et PIN numérique (4 à 8 chiffres) requis.'); return; }
    const btn = el('btn-login'); btn.disabled = true; btn.textContent = 'Vérification du terminal…';
    try {
      const r = await api('/field/login', { method: 'POST', body: { identifier, pin } });
      ME = r;
      localStorage.setItem('teebo.terrain.user', JSON.stringify({ user_id: r.user_id, holder_name: r.holder_name, imf_id: r.imf_id }));
      startApp();
    } catch (err) {
      if (err.status === 403 && err.data && err.data.blocked) { show('scr-blocked'); el('blocked-title').textContent = err.data.error === 'device_revoked' ? 'Terminal révoqué' : 'Terminal non reconnu';
        el('blocked-msg').textContent = err.data.message || ''; return; }
      flash('login-alert', 'err', err.message);
    } finally { btn.disabled = false; btn.textContent = 'Se connecter'; }
  });

  el('btn-retry').addEventListener('click', (e) => { e.preventDefault(); show('scr-login'); });
  el('btn-logout').addEventListener('click', () => { ME = null; localStorage.removeItem('teebo.terrain.user'); location.reload(); });

  /* ---- Contrôle périodique du statut du terminal (révocation à distance) */
  async function checkDevice() {
    try {
      const s = await api('/field/device-status');
      if (s.blocked) { show('scr-blocked'); el('blocked-title').textContent = 'Terminal révoqué';
        el('blocked-msg').textContent = 'Votre session a été fermée à distance. Contactez votre superviseur.'; }
    } catch (e) { /* hors-ligne : on continue */ }
  }

  /* ---- Démarrage de l'app terrain -------------------------------------- */
  function startApp() {
    show('scr-app');
    const u = JSON.parse(localStorage.getItem('teebo.terrain.user') || '{}');
    el('who-name').textContent = (ME && ME.holder_name) || u.holder_name || 'Collectrice';
    setInterval(checkDevice, 20000);
    // Vue par défaut à la connexion d'une collectrice : la TOURNÉE DU JOUR.
    loadRound();
    loadOps();
    loadCash();
  }

  /* =================================================================== */
  /*  TOURNÉE DU JOUR + RECHERCHE CLIENT (avec distance Haversine)        */
  /* =================================================================== */

  // Position courante de la collectrice, obtenue via le navigateur.
  let HERE = null; // { lat, lng }

  function locate() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => { HERE = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy }; resolve(HERE); },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      );
    });
  }

  // Formule de Haversine : distance (en mètres) entre deux points GPS.
  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // rayon terrestre en mètres
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function distanceLabel(m) {
    if (m == null || !isFinite(m)) return null;
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km';
  }

  // Distance entre la collectrice et un client (à partir de sa position stockée).
  function clientDistance(row) {
    if (!HERE || row.gps_lat == null || row.gps_lng == null) return null;
    const m = haversineMeters(HERE.lat, HERE.lng, Number(row.gps_lat), Number(row.gps_lng));
    return { m, label: distanceLabel(m) };
  }

  function positionLine() {
    el('round-pos-txt').textContent = HERE
      ? HERE.lat.toFixed(4) + ', ' + HERE.lng.toFixed(4)
      : 'position indisponible (autorisez la localisation)';
  }

  // Libellés des jours de collecte (0 = dimanche … 6 = samedi, côté JS).
  const DAYS_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const FREQ_FR = { hebdomadaire: 'Hebdomadaire', bimensuel: 'Bimensuel (2×/mois)', mensuel: 'Mensuel', libre: 'Libre (à la demande)' };

  // Résumé lisible du programme de collecte d'un client.
  function scheduleLabel(row) {
    const s = row.schedule;
    if (!s || !s.is_active) return 'Programme : aucun jour défini';
    if (s.frequency === 'libre') return 'Programme : libre (le client ne revient que sur recherche)';
    const days = (s.weekdays || []).slice().sort().map((d) => DAYS_FR[d]).join(', ');
    return 'Programme : ' + (FREQ_FR[s.frequency] || s.frequency) + (days ? ' · ' + days : '')
      + (s.frequency === 'mensuel' && s.day_of_month ? ' (le ' + s.day_of_month + ')' : '');
  }

  // Ligne d'un client dans la tournée : identité + badges + actions.
  function clientRow(row, opts) {
    const o = opts || {};
    const d = clientDistance(row);
    const dist = d ? `<span class="tag tag--muted">📍 ${esc(d.label)}</span>` : '';
    const tags = [];
    if (row.is_frozen || o.frozen) tags.push('<span class="tag tag--err">❄️ Gelé</span>');
    if (row.visit_source === 'recherche') tags.push('<span class="tag tag--muted">ajout manuel</span>');
    if (row.from_schedule) tags.push('<span class="tag tag--ok">programme du jour</span>');
    if (row.days_since_visit != null && row.days_since_visit >= 15) tags.push('<span class="tag tag--warn">' + esc(row.days_since_visit) + ' j sans visite</span>');
    const tagLine = tags.length ? `<div class="item__tags">${tags.join(' ')}</div>` : '';
    const sched = `<span class="sched-line">${esc(scheduleLabel(row))}</span>`;
    const frozen = (row.is_frozen || o.frozen);
    const foot = frozen ? '' : `<div class="item__foot">
        <button class="btn btn--validate" data-visit="${esc(row.client_id)}" type="button">✓ Valider la visite</button>
        <button class="btn btn--ghost" data-sched="${esc(row.client_id)}" type="button">🗓️ Programme</button>
        ${o.search ? '' : '<button class="btn btn--danger" data-remove="' + esc(row.client_id) + '" type="button">Retirer</button>'}
      </div>`;
    return `<div class="item${frozen ? ' client-frozen' : ''}"><div class="item__head"><div><b>${esc(row.full_name)}</b>
      <small>${esc(row.code_client || '')} ${row.code_account ? '· ' + esc(row.code_account) : ''}${row.phone ? ' · ' + esc(row.phone) : ''}</small></div>
      <div class="amt">${row.balance_cents != null ? xof(row.balance_cents) : ''}</div></div>
      ${tagLine}${dist}${sched}${o.extra || ''}${foot}</div>`;
  }

  // Branche les actions (valider visite, programme, retirer) des lignes affichées.
  function wireClientActions(scope) {
    (scope || document).querySelectorAll('[data-visit]').forEach((b) => b.addEventListener('click', () => validateVisit(b)));
    (scope || document).querySelectorAll('[data-sched]').forEach((b) => b.addEventListener('click', () => sheetSchedule(b.getAttribute('data-sched'))));
    (scope || document).querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api('/round/today/remove', { method: 'POST', body: { client_id: b.getAttribute('data-remove') } }); loadRound(); }
      catch (e) { b.disabled = false; flash('app-alert', 'err', e.message); }
    }));
  }

  // Validation d'une visite : capture du GPS puis enregistrement côté serveur.
  async function validateVisit(btn) {
    const id = btn.getAttribute('data-visit');
    btn.disabled = true; btn.textContent = 'Localisation…';
    const pos = await locate();
    positionLine();
    try {
      const r = await api('/round/visits/check-in', { method: 'POST', body: {
        client_id: id,
        gps_lat: pos ? pos.lat : null, gps_lng: pos ? pos.lng : null,
        accuracy_m: pos && pos.accuracy_m != null ? pos.accuracy_m : null,
        visit_source: 'terrain'
      } });
      btn.textContent = 'Visite validée ✓';
      flash('app-alert', 'ok', 'Visite validée' + (pos ? ' (GPS capté)' : ' (GPS indisponible)') + '. Le client est retiré de la tournée du jour.');
      // Le client visité disparaît immédiatement de la liste du jour.
      loadRound(); loadOps();
    } catch (e) {
      btn.disabled = false; btn.textContent = '✓ Valider la visite';
      flash('app-alert', 'err', e.message);
    }
  }

  // Charge la tournée du jour (vue par défaut) — géolocalise puis interroge le backend.
  async function loadRound() {
    const list = el('round-list');
    list.innerHTML = '<div class="empty">Chargement de votre tournée…</div>';
    await locate();
    positionLine();
    const pos = HERE ? ('?gps_lat=' + HERE.lat + '&gps_lng=' + HERE.lng) : '';
    try {
      const r = await api('/round/today' + pos);
      const rows = (r.visits && r.visits.length) ? r.visits : (r.suggested || []);
      el('round-count').textContent = rows.length ? '· ' + rows.length + ' client(s)' : '';
      if (!rows.length) { list.innerHTML = '<div class="empty">Aucun client à visiter aujourd\'hui.</div>'; }
      else { list.innerHTML = rows.map((x) => clientRow(x)).join(''); }
      wireClientActions(list);
      applyRoundKpis(r.kpis || {});
      renderFrozen(r.frozen_clients || []);
    } catch (e) {
      list.innerHTML = '<div class="empty">Tournée indisponible.</div>';
    }
  }

  function applyRoundKpis(k) {
    const set = (id, v) => { const e = el(id); if (e) e.textContent = v == null ? '0' : String(v); };
    set('kpi-visits', k.visited_today || 0);
    set('kpi-frozen', k.frozen || 0);
    set('kpi-overdue', k.overdue || 0);
    set('kpi-expl', k.explanation_requested || 0);
  }

  // Liste des clients gelés (visibles par la collectrice, mais non visitables).
  function renderFrozen(rows) {
    const list = el('frozen-list');
    const badge = el('frozen-count');
    if (badge) { badge.textContent = rows.length; badge.hidden = rows.length === 0; }
    if (!list) return;
    if (!rows.length) { list.innerHTML = '<div class="empty">Aucun client gelé.</div>'; return; }
    list.innerHTML = rows.map((x) => clientRow(x, { frozen: true })).join('');
    wireFrozenActions(list);
  }

  // Sur un client gelé, la collectrice peut uniquement répondre à la demande d'explication.
  function wireFrozenActions(scope) {
    scope.querySelectorAll('[data-explain]').forEach((b) => b.addEventListener('click', () => sheetExplain(b.getAttribute('data-explain'))));
  }

  // Recherche d'un client dans TOUTE la base (même hors tournée du jour).
  async function searchClients() {
    const q = el('round-q').value.trim();
    const out = el('round-search-list');
    const hint = el('round-search-hint');
    if (!q) { out.innerHTML = ''; hint.hidden = true; return; }
    out.innerHTML = '<div class="empty">Recherche…</div>';
    await locate();
    positionLine();
    const pos = HERE ? ('&gps_lat=' + HERE.lat + '&gps_lng=' + HERE.lng) : '';
    try {
      const r = await api('/round/search?q=' + encodeURIComponent(q) + pos);
      const rows = r.clients || [];
      hint.hidden = false;
      hint.textContent = rows.length + ' résultat(s) dans toute la base.';
      if (!rows.length) { out.innerHTML = '<div class="empty">Aucun client trouvé.</div>'; return; }
      out.innerHTML = rows.map((x) => clientRow(x, { search: true,
        extra: ' <button class="btn btn--primary" data-add-client="' + esc(x.client_id) + '" type="button" style="margin-top:6px">Ajouter à ma tournée du jour</button>' })
      ).join('');
      out.querySelectorAll('[data-add-client]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Ajout…';
        try { await api('/round/today/add', { method: 'POST', body: { client_id: b.getAttribute('data-add-client') } });
          b.textContent = 'Ajouté ✓'; loadRound(); }
        catch (e) { b.disabled = false; b.textContent = 'Ajouter à ma tournée du jour'; flash('app-alert', 'err', e.message); }
      }));
    } catch (e) { out.innerHTML = '<div class="empty">Recherche indisponible.</div>'; }
  }

  el('round-q-go').addEventListener('click', searchClients);
  el('round-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchClients(); } });

  async function loadOps() {
    try {
      const r = await api('/operations');
      const ops = (r.operations || []).slice(0, 12);
      const list = el('ops-list');
      if (!ops.length) { list.innerHTML = '<div class="empty">Aucune opération pour l\'instant.</div>'; }
      else list.innerHTML = ops.map((o) => {
        const tag = o.status === 'valide' ? 'ok' : o.status === 'en_attente' ? 'warn' : 'muted';
        const label = o.status === 'valide' ? 'Validé' : o.status === 'en_attente' ? 'En attente' : o.status;
        const hist = o.client_id ? `<button class="linkbtn" type='button' data-hist="${esc(o.client_id)}" data-name="${esc(o.client_name || '')}">Historique client</button>` : '';
        return `<div class="item"><div class="item__head"><div><b>${esc(o.client_name || o.code_account)}</b>
          <small>${esc(kindLabel(o.kind))} · ${new Date(o.created_at).toLocaleString('fr-FR')}</small></div>
          <div class="amt">${xof(o.amount_cents)}</div></div>
          <span class="tag tag--${tag}">${label}</span>${o.impacts_agent_cash ? '' : ' <span class="tag tag--muted">caisse inchangée</span>'}${hist}</div>`;
      }).join('');
      list.querySelectorAll('[data-hist]').forEach((bd) => bd.addEventListener('click', () => showClientHistory(bd.getAttribute('data-hist'), bd.getAttribute('data-name'))));
      const pend = ops.filter((o) => o.status === 'en_attente').length;
      el('kpi-depots').textContent = ops.filter((o) => o.kind === 'depot' && o.status === 'valide').length;
      el('kpi-attente').textContent = pend;
      const b = el('badge-cancel'); b.textContent = pend; b.hidden = pend === 0;
      // Solde de caisse : source de vérité côté serveur (plafonds inclus).
      if (!CASH) { loadCash(); }
    } catch (e) { el('ops-list').innerHTML = '<div class="empty">Données indisponibles.</div>'; }
  }

  function kindLabel(k) { return { depot: 'Dépôt', retrait_regul: 'Régularisation guichet', credit_request: 'Demande de crédit' }[k] || k; }

  /* =================================================================== */
  /*  SÉLECTION D'UN CLIENT (recherche + choix) POUR LES OPÉRATIONS        */
  /* =================================================================== */

  // Ouvre une feuille de sélection de client ; renvoie le client choisi via cb.
  function pickClient(title, sub, cb) {
    openSheet(`<h3>${esc(title)}</h3><p class="sub">${esc(sub)}</p>
      <div class="pick"><input id="pq" type="search" placeholder="Nom, code client, téléphone…" autocomplete="off" enterkeyhint="search">
      <button class="btn btn--primary" type="button" id="pqg">Chercher</button></div>
      <div class="pick-results" id="pres"></div>
      <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Fermer</button></div>`);
    $('[data-x]', root).onclick = closeSheet;
    const run = async () => {
      const q = $('#pq', root).value.trim();
      const out = $('#pres', root);
      if (!q) { out.innerHTML = ''; return; }
      out.innerHTML = '<div class="empty">Recherche…</div>';
      try {
        const r = await api('/round/search?q=' + encodeURIComponent(q));
        const rows = r.clients || [];
        if (!rows.length) { out.innerHTML = '<div class="empty">Aucun client trouvé.</div>'; return; }
        out.innerHTML = rows.map((x) => `<button class="pick-item" type="button" data-pick="${esc(x.client_id)}">
            <b>${esc(x.full_name)}${x.is_frozen ? ' ❄️' : ''}</b>
            <small>${esc(x.code_client || '')}${x.code_account ? ' · ' + esc(x.code_account) : ''}${x.phone ? ' · ' + esc(x.phone) : ''}${x.balance_cents != null ? ' · ' + xof(x.balance_cents) : ''}</small></button>`).join('');
        out.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
          const c = rows.find((y) => String(y.client_id) === b.getAttribute('data-pick'));
          cb(c);
        }));
      } catch (e) { out.innerHTML = '<div class="empty">Recherche indisponible.</div>'; }
    };
    $('#pqg', root).onclick = run;
    $('#pq', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  }

  // Bloc « client choisi » affiché dans un formulaire.
  function chosenBlock(c) {
    return `<div class="chosen" id="chosen">Client : ${esc(c.full_name)} · ${esc(c.code_client || '')}${c.code_account ? ' · ' + esc(c.code_account) : ''}${c.is_frozen ? ' ❄️ (gelé)' : ''}
      <button type="button" class="btn btn--ghost" id="rech" style="margin-left:8px;padding:6px 10px;font-size:12px">Changer</button></div>`;
  }

  // Affiche une erreur de formulaire en haut de la feuille.
  function formErr(msg) {
    const e = $('#ferr', root); if (e) { e.textContent = msg; e.hidden = false; }
  }
  function clearErr() { const e = $('#ferr', root); if (e) e.hidden = true; }

  // Vérifie côté client les champs obligatoires : date + montant + client.
  function requireOpsFields() {
    clearErr();
    const c = OPS_CLIENT;
    if (!c) { formErr('Sélectionnez d\'abord un client.'); return false; }
    const d = $('#opdate', root).value;
    const a = parseAmt($('#am', root).value);
    if (!d) { $('#opdate', root).setAttribute('aria-invalid', 'true'); formErr('La date de l\'opération est obligatoire.'); return false; }
    if (!a) { $('#am', root).setAttribute('aria-invalid', 'true'); formErr('Le montant est obligatoire et doit être supérieur à zéro.'); return false; }
    return true;
  }

  // Date du jour au format AAAA-MM-JJ (valeur par défaut des formulaires).
  function todayISO() {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  let OPS_CLIENT = null;

  /* =================================================================== */
  /*  FEUILLES D'ACTION (bottom sheets)                                   */
  /* =================================================================== */
  const root = el('sheet-root');
  function closeSheet() { OPS_CLIENT = null; root.innerHTML = ''; }
  function openSheet(html) { root.innerHTML = `<div class="sheet"><div class="sheet__inner">${html}</div></div>`;
    root.querySelector('.sheet').addEventListener('click', (e) => { if (e.target.classList.contains('sheet')) closeSheet(); }); }

  document.getElementById('actions').addEventListener('click', (e) => {
    const btn = e.target.closest('.action'); if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'deposit') sheetDeposit();
    if (act === 'cancel') sheetCancel();
    if (act === 'guichet') sheetGuichet();
    if (act === 'credit') sheetCredit();
    if (act === 'request') sheetRequest();
    if (act === 'clientspace') sheetClientSpace();
    if (act === 'newclient') sheetNewClient();
    if (act === 'remit') sheetRemit();
    if (act === 'settings') sheetSettings();
  });

  /* ===================================================================
   *  VAGUE 5 — Plafonds, versements, reçus simples, SMS clients
   * =================================================================== */

  // État de caisse courant (solde, plafonds, versement requis ?).
  let CASH = null;

  async function loadCash() {
    try {
      CASH = await api('/collecte/cash');
      renderCash();
    } catch (e) { /* silencieux */ }
  }

  function renderCash() {
    const c = CASH; if (!c) return;
    el('cash-total').textContent = xof(c.balance_cents);
    const cap = c.max_cash_cents;
    const sub = el('cash-sub');
    if (cap != null) {
      sub.textContent = 'Plafond de caisse : ' + xof(cap) + ' · reste ' + xof(c.remaining_cents) +
        ' · versements ' + xof(c.transfers_cents);
    } else {
      sub.textContent = 'Aucun plafond de caisse défini par votre IMF';
    }
    const banner = el('cash-banner');
    if (banner) {
      if (c.transfer_required) {
        banner.hidden = false;
        banner.className = 'alert alert--err';
        banner.innerHTML = '⚠️ <b>Plafond de caisse atteint</b> (' + xof(c.balance_cents) + ' / ' + xof(cap) +
          '). Vous devez faire un <b>versement</b> avant de collecter davantage. ' +
          '<button class="btn btn--primary" type="button" id="cash-banner-remit" style="margin-top:8px">💸 Faire un versement</button>';
        const b = el('cash-banner-remit'); if (b) b.onclick = sheetRemit;
      } else {
        banner.hidden = true;
      }
    }
  }

  // --- Feuille « Faire un versement » (caisse caissière OU Mobile Money) ---
  function sheetRemit() {
    const c = CASH || {};
    openSheet(`<h3>Faire un versement</h3><p class="sub">Remettez les espèces encaissées :
      soit à la <b>caisse</b> (caissière), soit par <b>transfert Mobile Money</b> sur le compte de l'IMF.
      Solde de caisse actuel : <b>${xof(c.balance_cents)}</b>.</p>
      <div class="alert alert--err" hidden id="ferr"></div>
      <form id="f">
        <div class="fld"><label>Montant (FCFA) <span class="req-mark">*</span></label><input id="rm" inputmode="numeric" required placeholder="Ex. 50000"></div>
        <div class="fld"><label>Destination <span class="req-mark">*</span></label>
          <select id="ch">
            <option value="caisse_caissiere">Versement à la caisse (caissière)</option>
            <option value="mobile_money">Transfert Mobile Money (compte IMF)</option>
          </select></div>
        <div id="momo" hidden>
          <div class="fld"><label>Fournisseur</label><select id="mp">
            <option value="orange_money">Orange Money</option><option value="moov_money">Moov Money</option>
            <option value="wave">Wave</option><option value="autre">Autre</option></select></div>
          <div class="fld"><label>Numéro du compte IMF</label><input id="mn" placeholder="${esc(c.momo_deposit_number || '+226…')}"></div>
          <div class="fld"><label>Référence du transfert <span class="req-mark">*</span></label><input id="tr" placeholder="Ex. OM-8891-2026"></div>
          <div class="fld"><label>Date du transfert</label><input id="td" type="date" value="${todayISO()}" max="${todayISO()}"></div>
        </div>
        <div class="fld"><label>Note / preuve (optionnel)</label><input id="pn" placeholder="Bordereau, captures SMS…"></div>
        <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Annuler</button>
          <button class="btn btn--primary" type="submit">Déclarer le versement</button></div>
      </form>`);
    $('[data-x]', root).onclick = closeSheet;
    $('#ch', root).onchange = () => { $('#momo', root).hidden = $('#ch', root).value !== 'mobile_money'; };
    $('#rm', root).value = c.balance_cents ? String(Number(c.balance_cents) / 100) : '';
    $('#mn', root).value = c.momo_deposit_number || '';
    if (c.momo_provider) $('#mp', root).value = c.momo_provider;
    $('#f', root).onsubmit = async (e) => { e.preventDefault(); clearErr();
      const channel = $('#ch', root).value;
      const body = { channel, amount_cents: parseAmt($('#rm', root).value), proof_note: $('#pn', root).value.trim() || null };
      if (channel === 'mobile_money') {
        body.transfer_ref = $('#tr', root).value.trim();
        body.momo_provider = $('#mp', root).value;
        body.momo_number = $('#mn', root).value.trim() || null;
        body.transfer_date = $('#td', root).value || null;
        if (!body.transfer_ref) { formErr('Indiquez la référence du transfert Mobile Money.'); return; }
      }
      try {
        const r = await api('/collecte/cash-deposits', { method: 'POST', body });
        flash('app-alert', 'ok', r.message || 'Versement déclaré. Il sera validé par la caissière.');
        closeSheet(); loadCash(); loadOps();
      } catch (err) { formErr(err.message); }
    };
  }

  // --- Feuille « Paramètres de collecte » (admin IMF / direction) --------
  function sheetSettings() {
    openSheet('<h3>Paramètres de collecte</h3><div class="empty">Chargement…</div>');
    api('/collecte/settings').then((r) => {
      const s = r.settings || {};
      openSheet(`<h3>Paramètres de collecte</h3><p class="sub">Plafonds de la collectrice et SMS automatique au client après chaque dépôt.</p>
        <div class="alert alert--err" hidden id="ferr"></div>
        <form id="f">
          <div class="fld"><label>Plafond de caisse journalier (FCFA) — 0 = illimité</label>
            <input id="mc" inputmode="numeric" value="${s.max_cash_cents != null ? Number(s.max_cash_cents) / 100 : ''}" placeholder="Ex. 500000"></div>
          <div class="fld"><label>Plafond par client / jour (FCFA) — 0 = illimité</label>
            <input id="md" inputmode="numeric" value="${s.max_client_daily_cents != null ? Number(s.max_client_daily_cents) / 100 : ''}" placeholder="Ex. 200000"></div>
          <div class="fld"><label><input type="checkbox" id="se" ${s.sms_enabled ? 'checked' : ''}> Envoyer un SMS au client après chaque dépôt</label></div>
          <div class="fld"><label>Numéro expéditeur SMS (nom court / numéro IMF)</label><input id="sn" value="${esc(s.sms_sender_number || '')}" placeholder="+226… ou TEEBO"></div>
          <div class="fld"><label>Compte Mobile Money de l'IMF (pour les versements)</label><input id="mn" value="${esc(s.momo_deposit_number || '')}" placeholder="+226…"></div>
          <div class="fld"><label>Fournisseur Mobile Money</label><select id="mp">
            <option value="">—</option>
            <option value="orange_money" ${s.momo_provider === 'orange_money' ? 'selected' : ''}>Orange Money</option>
            <option value="moov_money" ${s.momo_provider === 'moov_money' ? 'selected' : ''}>Moov Money</option>
            <option value="wave" ${s.momo_provider === 'wave' ? 'selected' : ''}>Wave</option>
            <option value="autre" ${s.momo_provider === 'autre' ? 'selected' : ''}>Autre</option></select></div>
          <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Annuler</button>
            <button class="btn btn--primary" type="submit">Enregistrer</button></div>
        </form>`);
      $('[data-x]', root).onclick = closeSheet;
      $('#f', root).onsubmit = async (e) => { e.preventDefault(); clearErr();
        const num = (v) => { const a = parseAmt(v); return a > 0 ? a : null; };
        try {
          await api('/collecte/settings', { method: 'POST', body: {
            max_cash_cents: num($('#mc', root).value), max_client_daily_cents: num($('#md', root).value),
            sms_enabled: $('#se', root).checked, sms_sender_number: $('#sn', root).value.trim() || null,
            momo_deposit_number: $('#mn', root).value.trim() || null, momo_provider: $('#mp', root).value || null } });
          flash('app-alert', 'ok', 'Paramètres de collecte enregistrés.'); closeSheet(); loadCash();
        } catch (err) { formErr(err.message); }
      };
    }).catch(() => openSheet('<h3>Paramètres de collecte</h3><div class="empty">Réservé à l\'administrateur de l\'IMF.</div>'));
  }

  // --- Modale REÇU simple : affichée 60 s (ou fermée par la collectrice) --
  let RECEIPT_TIMER = null;
  function showReceipt(rec) {
    if (!rec) return;
    const secs = Number(rec.display_seconds || 60);
    el('receipt-root').innerHTML = `<div class="receipt-modal"><div class="receipt-card">
      <div class="receipt-logo">B</div>
      <div class="receipt-title">Reçu de dépôt</div>
      <div class="receipt-code">${esc(rec.code_receipt)}</div>
      <div class="receipt-rows">
        <div><span>Client</span><b>${esc(rec.client_name || '—')}</b></div>
        <div><span>Montant</span><b>${xof(rec.amount_cents)}</b></div>
        <div><span>Nouveau solde</span><b>${rec.balance_after_cents != null ? xof(rec.balance_after_cents) : '—'}</b></div>
      </div>
      <p class="receipt-hint">Recopiez ce numéro de reçu dans le carnet du client.</p>
      <div class="receipt-bar"><div id="rcpt-progress" style="width:100%"></div></div>
      <p class="receipt-count">Fermeture automatique dans <b id="rcpt-secs">${secs}</b> s</p>
      <button class="btn btn--dark" type="button" id="rcpt-close">Fermer maintenant</button>
    </div></div>`;
    let left = secs;
    clearInterval(RECEIPT_TIMER);
    RECEIPT_TIMER = setInterval(() => {
      left -= 1;
      const sEl = el('rcpt-secs'); const pEl = el('rcpt-progress');
      if (sEl) sEl.textContent = String(Math.max(0, left));
      if (pEl) pEl.style.width = Math.max(0, (left / secs) * 100) + '%';
      if (left <= 0) closeReceipt();
    }, 1000);
    el('rcpt-close').onclick = closeReceipt;
  }
  function closeReceipt() {
    clearInterval(RECEIPT_TIMER); RECEIPT_TIMER = null;
    el('receipt-root').innerHTML = '';
  }

  // --- Historique client : les 5 dernières opérations (trace pour le client) ---
  async function showClientHistory(clientId, name) {
    openSheet('<h3>Dernières opérations</h3><div class="empty">Chargement…</div>');
    try {
      const r = await api('/clients/' + encodeURIComponent(clientId) + '/operations?limit=5');
      const ops = r.operations || [];
      const rows = ops.length ? ops.map((o) => `<div class="item"><div class="item__head"><div>
          <b>${esc(o.label)}</b><small>${new Date(o.date).toLocaleString('fr-FR')}${o.receipt_code ? ' · Reçu ' + esc(o.receipt_code) : ''}</small></div>
          <div class="amt">${xof(o.amount_cents)}</div></div>
          <span class="tag tag--${o.status === 'valide' ? 'ok' : 'warn'}">${esc(o.status)}</span></div>`).join('')
        : '<div class="empty">Aucune opération.</div>';
      openSheet(`<h3>Dernières opérations</h3><p class="sub">${esc(name || (r.client && r.client.full_name) || '')}
        — solde : <b>${r.account ? xof(r.account.balance_cents) : '—'}</b></p>
        <div class="list">${rows}</div>
        <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Fermer</button></div>`);
      $('[data-x]', root).onclick = closeSheet;
    } catch (e) { openSheet('<h3>Dernières opérations</h3><div class="empty">Indisponible.</div>'); }
  }

  function sheetDeposit() {
    OPS_CLIENT = null;
    openSheet(`<h3>Enregistrer un dépôt</h3><p class="sub">Recherchez et sélectionnez le client, puis saisissez le montant.</p>
      <div class="alert alert--err" hidden id="ferr"></div>
      <div id="pick-wrap"><div class="pick"><input id="pq" type="search" placeholder="Rechercher le client (nom, code, téléphone)…" autocomplete="off"><button class="btn btn--primary" type="button" id="pqg">Chercher</button></div><div class="pick-results" id="pres"></div></div>
      <form id="f" hidden><div id="chosen-wrap"></div>
      <div class="fld"><label>Montant (FCFA) <span class="req-mark">*</span></label><input id="am" inputmode="numeric" required placeholder="5000"></div>
      <div class="fld"><label>Référence (optionnel)</label><input id="rf"></div>
      <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Annuler</button><button class="btn btn--primary" type="submit">Valider le dépôt</button></div></form>`);
    $('[data-x]', root).onclick = closeSheet;
    wirePick({
      onPick: async (c) => {
        OPS_CLIENT = c; $('#pick-wrap', root).hidden = true; $('#f', root).hidden = false;
        $('#chosen-wrap', root).innerHTML = chosenBlock(c) +
          `<div class="ctx-box" id="ctx"></div>`;
        $('#rech', root).onclick = () => sheetDeposit();
        // Contexte de plafond par client (montant déjà collecté aujourd'hui).
        try { const cx = await api('/collecte/client-context/' + encodeURIComponent(c.client_id));
          const box = $('#ctx', root);
          if (box && cx.max_client_daily_cents != null) {
            box.innerHTML = 'Déjà collecté aujourd\'hui : <b>' + xof(cx.collected_today_cents) + '</b> sur ' + xof(cx.max_client_daily_cents) +
              ' · reste <b>' + xof(cx.remaining_cents) + '</b>' + (cx.client_limit_reached ? ' — <span style="color:#c0392b">plafond atteint</span>' : '');
          } else if (box) { box.textContent = 'Aucun plafond par client défini.'; }
        } catch (e) {}
      }
    });
    $('#f', root).onsubmit = async (e) => { e.preventDefault(); clearErr();
      const amount = parseAmt($('#am', root).value);
      if (!amount) { formErr('Saisissez un montant supérieur à zéro.'); return; }
      try {
        const r = await api('/operations/deposit', { method: 'POST', body: {
          account_code: OPS_CLIENT.code_account, amount_cents: amount, reference: $('#rf', root).value.trim() } });
        closeSheet();
        loadOps(); loadCash();
        // REÇU simple affiché 60 s pour recopie dans le carnet du client.
        if (r.receipt) showReceipt(r.receipt);
        if (r.sms && r.sms.status === 'envoye') flash('app-alert', 'ok', 'Dépôt validé. SMS envoyé au client.');
      } catch (err) {
        // Plafonds atteints : proposer immédiatement le versement (plafond de caisse).
        if (err.data && err.data.error === 'cash_limit_reached') {
          formErr(err.message);
          if (!el('remit-cta')) {
            const b = document.createElement('button');
            b.className = 'btn btn--primary'; b.id = 'remit-cta'; b.type = 'button';
            b.style.marginTop = '10px'; b.textContent = '💸 Faire un versement maintenant';
            b.onclick = () => { loadCash(); closeSheet(); sheetRemit(); };
            $('#ferr', root).after(b);
          }
        } else { formErr(err.message); }
      }
    };
  }

  function sheetCancel() {
    openSheet(`<h3>Demander une annulation</h3><p class="sub">Le solde n'est ajusté qu'après validation du superviseur.</p>
      <form id="f"><div class="fld"><label>Référence / code de l'opération</label><input id="op" required placeholder="Identifiant de l'opération"></div>
      <div class="fld"><label>Motif</label><textarea id="rs" rows="2" placeholder="Erreur de montant, doublon…"></textarea></div>
      <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Fermer</button><button class="btn btn--primary" type="submit">Envoyer la demande</button></div></form>`);
    $('[data-x]', root).onclick = closeSheet;
    $("#f", root).onsubmit = async (e) => { e.preventDefault();
      try { await api('/operations/' + encodeURIComponent($('#op', root).value.trim()) + '/cancel-request', { method: 'POST', body: { reason: $('#rs', root).value.trim() } });
        alert('Demande envoyée. En attente de validation du superviseur.'); closeSheet(); loadOps();
      } catch (err) { alert(err.message); }
    };
  }

  // Formulaire commun : client choisi + date + montant obligatoires.
  function opsFormBody(extra) {
    return { client_id: OPS_CLIENT.client_id, client_code: OPS_CLIENT.code_client,
      account_code: OPS_CLIENT.code_account, operation_date: $('#opdate', root).value,
      amount_cents: parseAmt($('#am', root).value) };
  }
  function opsFieldsSum(kind) {
    return `<div class="fld"><label>Date de l'opération <span class="req-mark">*</span></label><input id="opdate" type="date" value="${todayISO()}" max="${todayISO()}" required></div>
      <div class="fld"><label>Montant (FCFA) <span class="req-mark">*</span></label><input id="am" inputmode="numeric" required placeholder="5000"></div>
      <input type="hidden" id="kind" value="${esc(kind)}">`;
  }

  function sheetGuichet() {
    OPS_CLIENT = null;
    openSheet(`<h3>Régularisation guichet</h3><p class="sub">Recherchez et sélectionnez le client, puis saisissez la date et le montant (obligatoires). Cette opération impacte le solde du client, jamais la caisse physique de la collectrice.</p>
      <div class="alert alert--err" hidden id="ferr"></div>
      <div id="pick-wrap"><div class="pick"><input id="pq" type="search" placeholder="Rechercher le client (nom, code, téléphone)…" autocomplete="off"><button class="btn btn--primary" type="button" id="pqg">Chercher</button></div><div class="pick-results" id="pres"></div></div>
      <form id="f" hidden><div id="chosen-wrap"></div>
      ${opsFieldsSum('retrait_regul')}
      <div class="fld"><label>Sens</label><select id="dir"><option value="1">Dépôt (+)</option><option value="-1">Retrait (−)</option></select></div>
      <div class="fld"><label>Référence</label><input id="rf" placeholder="Ticket guichet"></div>
      <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Annuler</button><button class="btn btn--primary" type="submit">Enregistrer</button></div></form>`);
    $('[data-x]', root).onclick = closeSheet;
    wirePick({
      onPick: (c) => { OPS_CLIENT = c; $('#pick-wrap', root).hidden = true; $('#f', root).hidden = false;
        $('#chosen-wrap', root).innerHTML = chosenBlock(c); $('#rech', root).onclick = () => sheetGuichet(); }
    });
    $("#f", root).onsubmit = async (e) => { e.preventDefault();
      if (!requireOpsFields()) return;
      try { await api('/operations/guichet-regularization', { method: 'POST', body: Object.assign(opsFormBody(), { direction: Number($('#dir', root).value), reference: $('#rf', root).value.trim() }) });
        alert('Régularisation enregistrée. Caisse collectrice inchangée.'); closeSheet(); loadOps();
      } catch (err) { formErr(err.message); }
    };
  }

  function sheetCredit() {
    OPS_CLIENT = null;
    openSheet(`<h3>Demande de crédit</h3><p class="sub">Recherchez et sélectionnez le client, puis renseignez les informations obligatoires.</p>
      <div class="alert alert--err" hidden id="ferr"></div>
      <div id="pick-wrap"><div class="pick"><input id="pq" type="search" placeholder="Rechercher le client…" autocomplete="off"><button class="btn btn--primary" type="button" id="pqg">Chercher</button></div><div class="pick-results" id="pres"></div></div>
      <form id="f" hidden><div id="chosen-wrap"></div>
      ${opsFieldsSum('credit_request')}
      <div class="fld"><label>Objet du crédit <span class="req-mark">*</span></label><input id="pu" required placeholder="Commerce, agriculture…"></div>
      <div class="fld"><label>Durée (mois) <span class="req-mark">*</span></label><input id="du" inputmode="numeric" required></div>
      <div class="fld"><label>Activité / revenus du client <span class="req-mark">*</span></label><input id="act" required></div>
      <div class="fld"><label>Pièce d'identité vérifiée ?</label><select id="idv"><option value="oui">Oui</option><option value="non">Non</option></select></div>
      <div class="fld"><label>Garantie (optionnel)</label><input id="ga"></div>
      <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Annuler</button><button class="btn btn--primary" type="submit">Transmettre</button></div></form>`);
    $('[data-x]', root).onclick = closeSheet;
    wirePick({ onPick: (c) => { OPS_CLIENT = c; $('#pick-wrap', root).hidden = true; $('#f', root).hidden = false;
      $('#chosen-wrap', root).innerHTML = chosenBlock(c); $('#rech', root).onclick = () => sheetCredit(); } });
    $("#f", root).onsubmit = async (e) => { e.preventDefault();
      if (!requireOpsFields()) return;
      try { await api('/operations/credit-request', { method: 'POST', body: Object.assign(opsFormBody(), { purpose: $('#pu', root).value.trim(), duration_months: Number($('#du', root).value), activity: $('#act', root).value.trim(), id_verified: $('#idv', root).value === 'oui', collateral: $('#ga', root).value.trim() }) });
        alert('Demande de crédit transmise au superviseur.'); closeSheet(); loadOps();
      } catch (err) { formErr(err.message); }
    };
  }

  // Demande libre (type personnalisé) : client + date + montant obligatoires.
  function sheetRequest() {
    OPS_CLIENT = null;
    openSheet(`<h3>Nouvelle demande</h3><p class="sub">Recherchez et sélectionnez le client, puis précisez l'objet, la date et le montant (obligatoires).</p>
      <div class="alert alert--err" hidden id="ferr"></div>
      <div id="pick-wrap"><div class="pick"><input id="pq" type="search" placeholder="Rechercher le client…" autocomplete="off"><button class="btn btn--primary" type="button" id="pqg">Chercher</button></div><div class="pick-results" id="pres"></div></div>
      <form id="f" hidden><div id="chosen-wrap"></div>
      ${opsFieldsSum('demande')}
      <div class="fld"><label>Type de demande</label><select id="rt"><option value="releve">Relevé de compte</option><option value="attestation">Attestation</option><option value="chequier">Chéquier</option><option value="autre">Autre</option></select></div>
      <div class="fld"><label>Objet / motif <span class="req-mark">*</span></label><input id="pu" required placeholder="Décrivez la demande"></div>
      <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Annuler</button><button class="btn btn--primary" type="submit">Envoyer la demande</button></div></form>`);
    $('[data-x]', root).onclick = closeSheet;
    wirePick({ onPick: (c) => { OPS_CLIENT = c; $('#pick-wrap', root).hidden = true; $('#f', root).hidden = false;
      $('#chosen-wrap', root).innerHTML = chosenBlock(c); $('#rech', root).onclick = () => sheetRequest(); } });
    $("#f", root).onsubmit = async (e) => { e.preventDefault();
      if (!requireOpsFields()) return;
      try { await api('/operations/request', { method: 'POST', body: Object.assign(opsFormBody(), { request_type: $('#rt', root).value, purpose: $('#pu', root).value.trim() }) });
        alert('Demande transmise au superviseur.'); closeSheet(); loadOps();
      } catch (err) { formErr(err.message); }
    };
  }

  // Branche la recherche de client intégrée aux feuilles d'opération.
  function wirePick(o) {
    renderPick();
    function renderPick() {
      const run = async () => {
        const q = $('#pq', root).value.trim(); const out = $('#pres', root);
        if (!q) { out.innerHTML = ''; return; }
        out.innerHTML = '<div class="empty">Recherche…</div>';
        try {
          const r = await api('/round/search?q=' + encodeURIComponent(q));
          const rows = r.clients || [];
          if (!rows.length) { out.innerHTML = '<div class="empty">Aucun client trouvé.</div>'; return; }
          out.innerHTML = rows.map((x) => `<button class="pick-item" type="button" data-pick="${esc(x.client_id)}">
              <b>${esc(x.full_name)}${x.is_frozen ? ' ❄️' : ''}</b>
              <small>${esc(x.code_client || '')}${x.code_account ? ' · ' + esc(x.code_account) : ''}${x.phone ? ' · ' + esc(x.phone) : ''}</small></button>`).join('');
          out.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => o.onPick(rows.find((y) => String(y.client_id) === b.getAttribute('data-pick')))));
        } catch (e) { out.innerHTML = '<div class="empty">Recherche indisponible.</div>'; }
      };
      $('#pqg', root).onclick = run;
      $('#pq', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    }
  }

  /* ---- Programme de collecte d'un client ------------------------------ */
  async function sheetSchedule(clientId) {
    openSheet('<h3>Programme de collecte</h3><div class="empty">Chargement…</div>');
    let s = { weekdays: [], frequency: 'hebdomadaire', day_of_month: null, is_active: true };
    try { const r = await api('/clients/' + encodeURIComponent(clientId) + '/schedule'); if (r.schedule) s = r.schedule; } catch (e) {}
    const chips = DAYS_FR.map((d, i) => `<label class="day-chip"><input type="checkbox" value="${i}" ${((s.weekdays || []).indexOf(i) >= 0) ? 'checked' : ''}><span>${d.slice(0, 3)}</span></label>`).join('');
    const freqOpts = Object.keys(FREQ_FR).map((k) => `<option value="${k}" ${s.frequency === k ? 'selected' : ''}>${FREQ_FR[k]}</option>`).join('');
    openSheet(`<h3>Programme de collecte</h3><p class="sub">Définissez les jours de passage de la collectrice chez ce client.</p>
      <div class="alert alert--err" hidden id="ferr"></div>
      <div class="fld"><label>Jours de collecte</label><div class="day-grid" id="days">${chips}</div></div>
      <div class="fld"><label>Fréquence</label><select id="fq">${freqOpts}</select></div>
      <div class="fld" id="dom-wrap" ${s.frequency === 'mensuel' ? '' : 'hidden'}><label>Jour du mois (1–28)</label><input id="dom" inputmode="numeric" min="1" max="28" value="${s.day_of_month || ''}"></div>
      <div class="fld"><label><input type="checkbox" id="act" ${s.is_active ? 'checked' : ''}> Programme actif</label></div>
      <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Annuler</button><button class="btn btn--primary" type="button" id="save">Enregistrer</button></div>`);
    $('[data-x]', root).onclick = closeSheet;
    $('#fq', root).onchange = () => { $('#dom-wrap', root).hidden = $('#fq', root).value !== 'mensuel'; };
    $('#save', root).onclick = async () => {
      clearErr();
      const weekdays = Array.from(root.querySelectorAll('#days input:checked')).map((i) => Number(i.value));
      const frequency = $('#fq', root).value;
      const day_of_month = frequency === 'mensuel' ? (Number($('#dom', root).value) || null) : null;
      if (weekdays.length === 0 && frequency !== 'libre') { formErr('Choisissez au moins un jour de collecte.'); return; }
      try {
        await api('/clients/' + encodeURIComponent(clientId) + '/schedule', { method: 'POST', body: { weekdays, frequency, day_of_month, is_active: $('#act', root).checked } });
        flash('app-alert', 'ok', 'Programme de collecte enregistré.'); closeSheet(); loadRound();
      } catch (e) { formErr(e.message); }
    };
  }

  /* ---- Réponse de la collectrice à une demande d'explication ---------- */
  function sheetExplain(clientId) {
    openSheet(`<h3>Expliquer l'absence de collecte</h3><p class="sub">Votre superviseur a demandé une explication pour ce client gelé. Votre réponse lui sera transmise.</p>
      <div class="alert alert--err" hidden id="ferr"></div>
      <form id="f"><div class="fld"><label>Explication <span class="req-mark">*</span></label><textarea id="ex" rows="3" required placeholder="Ex. client en voyage, activité suspendue…"></textarea></div>
      <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Annuler</button><button class="btn btn--primary" type="submit">Envoyer l'explication</button></div></form>`);
    $('[data-x]', root).onclick = closeSheet;
    $("#f", root).onsubmit = async (e) => { e.preventDefault();
      const txt = $('#ex', root).value.trim();
      if (!txt) { formErr('L\'explication est obligatoire.'); return; }
      try { await api('/clients/' + encodeURIComponent(clientId) + '/freeze-explanation', { method: 'POST', body: { explanation: txt } });
        alert('Explication transmise au superviseur.'); closeSheet(); loadRound();
      } catch (err) { formErr(err.message); }
    };
  }

  // Créer un espace en ligne pour un client EXISTANT : on recherche le
  // client, puis on configure son mode de connexion et son format de relevé.
  function sheetClientSpace() {
    OPS_CLIENT = null;
    openSheet(`<h3>Créer un espace client</h3><p class="sub">Recherchez le client existant : il pourra ensuite consulter son relevé en ligne.</p>
      <div class="alert alert--err" hidden id="ferr"></div>
      <div id="pick-wrap"><div class="pick"><input id="pq" type="search" placeholder="Rechercher le client (nom, code, téléphone)…" autocomplete="off"><button class="btn btn--primary" type="button" id="pqg">Chercher</button></div><div class="pick-results" id="pres"></div></div>
      <form id="f" hidden><div id="chosen-wrap"></div>
      <div class="fld"><label>Mode de connexion client</label><select id="lm"><option value="mot_de_passe">Mot de passe</option><option value="sms_otp">Validation par SMS</option><option value="pin">Code PIN</option></select></div>
      <div class="fld"><label>Format de relevé</label><select id="sf"><option value="pdf">PDF</option><option value="csv">CSV</option><option value="les_deux">Les deux</option></select></div>
      <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Annuler</button><button class="btn btn--primary" type="submit">Créer l'espace</button></div></form>`);
    $('[data-x]', root).onclick = closeSheet;
    wirePick({ onPick: (c) => { OPS_CLIENT = c; $('#pick-wrap', root).hidden = true; $('#f', root).hidden = false;
      $('#chosen-wrap', root).innerHTML = chosenBlock(c); const rb = $('#rech', root); if (rb) rb.onclick = () => sheetClientSpace(); } });
    $("#f", root).onsubmit = async (e) => { e.preventDefault(); clearErr();
      if (!OPS_CLIENT) { formErr('Sélectionnez d\'abord un client.'); return; }
      try { const r = await api('/clients/' + encodeURIComponent(OPS_CLIENT.client_id) + '/portal', { method: 'POST', body: { login_mode: $('#lm', root).value, statement_format: $('#sf', root).value } });
        alert('Espace client créé pour ' + ((r.client && r.client.full_name) || OPS_CLIENT.full_name) + '.\nMot de passe temporaire : ' + ((r.credentials && r.credentials.temporary_password) || '—'));
        closeSheet();
      } catch (err) {
        if (err.data && err.data.error === 'espace_deja_cree') { formErr('Cet espace client existe déjà.'); }
        else { formErr(err.message); }
      }
    };
  }

  // Enregistrer un NOUVEAU client avec son socle d'identité (KYC BCEAO),
  // chez lui : le GPS du lieu de collecte est capté automatiquement.
  function sheetNewClient() {
    openSheet(`<h3>Nouveau client (KYC BCEAO)</h3><p class="sub">À remplir chez le client : le GPS du lieu est enregistré automatiquement. Les champs marqués d'une étoile sont obligatoires.</p>
      <div class="alert alert--err" hidden id="ferr"></div>
      <form id="f">
      <div class="fld"><label>Nom complet <span class="req-mark">*</span></label><input id="nm" required placeholder="Prénom(s) et nom"></div>
      <div class="fld"><label>Date de naissance <span class="req-mark">*</span></label><input id="bd" type="date" max="${todayISO()}" required></div>
      <div class="fld"><label>Lieu de naissance</label><input id="bp" placeholder="Ville / localité"></div>
      <div class="fld"><label>Sexe</label><select id="gd"><option value="">—</option><option value="F">Féminin</option><option value="M">Masculin</option></select></div>
      <div class="fld"><label>Nationalité</label><input id="nat" placeholder="Ex. Ivoirienne"></div>
      <div class="fld"><label>Situation matrimoniale</label><select id="ms"><option value="">—</option><option value="celibataire">Célibataire</option><option value="marie">Marié(e)</option><option value="divorce">Divorcé(e)</option><option value="veuf">Veuf/Veuve</option></select></div>
      <div class="fld"><label>Téléphone</label><input id="ph" inputmode="tel"></div>
      <div class="fld"><label>Adresse / domicile</label><input id="ad" placeholder="Quartier, ville"></div>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0">
      <div class="fld"><label>Type de pièce d'identité</label><select id="idt"><option value="">—</option><option value="CNI">CNI</option><option value="passeport">Passeport</option><option value="permis">Permis de conduire</option><option value="carte_consulaire">Carte consulaire</option><option value="autre">Autre</option></select></div>
      <div class="fld"><label>N° de pièce d'identité <span class="req-mark">*</span></label><input id="idn" required></div>
      <div class="fld"><label>Autorité de délivrance</label><input id="idi" placeholder="Ex. ONECI"></div>
      <div class="fld"><label>Date de délivrance</label><input id="idd" type="date" max="${todayISO()}"></div>
      <div class="fld"><label>Date d'expiration</label><input id="ide" type="date"></div>
      <div class="fld"><label>Identifiant fiscal (NIU/NINA)</label><input id="tax"></div>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0">
      <div class="fld"><label>Profession</label><input id="prof"></div>
      <div class="fld"><label>Employeur</label><input id="emp"></div>
      <div class="fld"><label>Secteur d'activité</label><input id="sec"></div>
      <div class="fld"><label>Origine des fonds</label><input id="fo" placeholder="Ex. commerce, salaire"></div>
      <div class="fld"><label>Objet de la relation d'affaires</label><input id="bpz" placeholder="Ex. épargne, crédit"></div>
      <div class="fld"><label>Bénéficiaire effectif (si différent)</label><input id="bo"></div>
      <div class="fld"><label><input type="checkbox" id="pep"> Personne politiquement exposée (PPE)</label></div>
      <div class="fld" id="pepd-wrap" hidden><label>Précisions PPE</label><input id="pepd"></div>
      <div class="sheet__nav"><button type="button" class="btn btn--ghost" data-x>Annuler</button><button class="btn btn--primary" type="submit">Enregistrer le client</button></div></form>`);
    $('[data-x]', root).onclick = closeSheet;
    $('#pep', root).onchange = () => { $('#pepd-wrap', root).hidden = !$('#pep', root).checked; };
    $("#f", root).onsubmit = async (e) => { e.preventDefault(); clearErr();
      const full_name = $('#nm', root).value.trim();
      const birth_date = $('#bd', root).value;
      const id_number = $('#idn', root).value.trim();
      if (!full_name) { formErr('Le nom complet est obligatoire.'); return; }
      if (!birth_date) { formErr('La date de naissance est obligatoire.'); return; }
      if (!id_number) { formErr('Le numéro de pièce d\'identité est obligatoire.'); return; }
      const btn = $('#f button[type=submit]', root); if (btn) { btn.disabled = true; btn.textContent = 'Localisation…'; }
      const pos = await locate(); positionLine();
      if (!pos) { if (btn) { btn.disabled = false; btn.textContent = 'Enregistrer le client'; }
        formErr('Position GPS indisponible. Autorisez la localisation : le client doit être enregistré chez lui.'); return; }
      const body = {
        full_name, birth_date, id_number,
        birth_place: $('#bp', root).value.trim() || null,
        gender: $('#gd', root).value || null,
        nationality: $('#nat', root).value.trim() || null,
        marital_status: $('#ms', root).value || null,
        phone: $('#ph', root).value.trim() || null,
        address: $('#ad', root).value.trim() || null,
        id_type: $('#idt', root).value || null,
        id_issuer: $('#idi', root).value.trim() || null,
        id_issue_date: $('#idd', root).value || null,
        id_expiry_date: $('#ide', root).value || null,
        tax_id: $('#tax', root).value.trim() || null,
        profession: $('#prof', root).value.trim() || null,
        employer: $('#emp', root).value.trim() || null,
        activity_sector: $('#sec', root).value.trim() || null,
        fund_origin: $('#fo', root).value.trim() || null,
        business_purpose: $('#bpz', root).value.trim() || null,
        beneficial_owner: $('#bo', root).value.trim() || null,
        is_pep: $('#pep', root).checked,
        pep_detail: $('#pep', root).checked ? ($('#pepd', root).value.trim() || null) : null,
        gps_lat: pos.lat, gps_lng: pos.lng, gps_accuracy_m: pos.accuracy_m
      };
      try { const r = await api('/clients/new', { method: 'POST', body });
        alert('Client enregistré : ' + (r.client.full_name) + '\nCode client : ' + r.client.code_client + '\n\n' + (r.note || 'Ouvrez maintenant son compte d\'épargne.'));
        closeSheet(); loadRound();
      } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Enregistrer le client'; }
        if (err.data && err.data.error === 'missing_field') { formErr('Champ obligatoire manquant : ' + (err.data.field || '')); }
        else if (err.data && err.data.error === 'gps_required') { formErr(err.message); }
        else { formErr(err.message); }
      }
    };
  }
})();
