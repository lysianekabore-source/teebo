/* teebo — espace IMF : tableau de bord, hiérarchie, personnel, sécurité. */
(function () {
  'use strict';
  var me = null, units = [], users = [], unitToDelete = null;
  // Catalogue des postes (chargé à la demande depuis /api/v1/positions).
  var positions = [], posDepts = [], posServices = [], posByCode = {};
  var KIND_META = {
    direction: { label: 'Direction', short: 'DIR' },
    department: { label: 'Département', short: 'DEP' },
    service: { label: 'Service', short: 'SRV' },
    agency: { label: 'Agence', short: 'AGC' }
  };
  var KIND_ORDER = { direction: 1, department: 2, service: 3, agency: 4 };
  var ROLE_LABEL = { admin_imf: 'Administrateur IMF', direction: 'Direction', department: 'Département',
    service: 'Service', agency: "Chef d'agence", staff: 'Personnel', superadmin: 'Direction Générale',
    compliance_officer: 'Conformité', it_admin: 'Admin. Système', security_engineer: 'Sécurité SI',
    credit_director: 'Direction Crédit', credit_analyst: 'Crédit', recovery_agent: 'Recouvrement',
    operations_director: 'Direction Opérations', teller: 'Caisse / Guichet', customer_agent: 'Clientèle',
    cfo: 'Direction Financière', treasurer: 'Trésorerie', accountant: 'Comptabilité', auditor: 'Audit',
    hr_logistics_manager: 'RH & Logistique', office_staff: 'Support administratif', collectrice: 'Collecte', pca_admin: "Président du Conseil d'Administration" };

  // Libellé d'un rôle : on retombe d'abord sur le catalogue des postes, puis sur
  // une mise en forme lisible, au lieu d'afficher un code brut « ops_caisse ».
  function roleLabelForCode(code) {
    if (!code) return '—';
    var c = String(code);
    if (ROLE_LABEL[c]) return ROLE_LABEL[c];
    if (posByCode[c] && posByCode[c].label) return posByCode[c].label;
    var p = positions.filter(function (x) { return x.role === c; })[0];
    if (p && p.label) return p.label;
    var t = c.replace(/[_.\-]+/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // Rôle effectif d'un utilisateur : le serveur renvoie « effective_role »
  // (ex. pca_admin pour le Président du Conseil d'Administration).
  function effRole(u) { return (u && (u.effective_role || u.role)) || ''; }

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Site réellement affiché dans le navigateur (https://mon-imf.netlify.app,
  // domaine propre…). Transmis au serveur pour que les messages envoyés
  // (code d'accès, mot de passe oublié) contiennent le BON lien de connexion.
  function siteUrl() {
    try { return (window.location && window.location.origin) || ''; } catch (e) { return ''; }
  }
  function api(path, method, body, onRetry) {
    method = method || 'GET';
    // On ne RE-ESSAIE automatiquement que les lectures (GET) : rejouer un POST
    // ou un DELETE pourrait dupliquer une opération. Les réponses 502/503/504 et
    // les coupures réseau correspondent au réveil du serveur (offre gratuite
    // Render) : on patiente puis on retente, au lieu de laisser tourner sans fin.
    var canRetry = method === 'GET';
    var total = canRetry ? 4 : 0;
    function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
    // Notifie l'appelant à chaque nouvelle tentative (feedback « réveil serveur »)
    // pour éviter l'impression d'un chargement infini.
    function signalRetry(left) {
      if (typeof onRetry === 'function') { try { onRetry(total - left + 1, total); } catch (_) {} }
    }
    function attempt(left) {
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 30000) : null;
      return fetch(path, { method: method, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
          'X-Site-URL': siteUrl() },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) {
          if (timer) clearTimeout(timer);
          if ((r.status === 502 || r.status === 503 || r.status === 504) && canRetry && left > 0) {
            signalRetry(left);
            return wait(1800).then(function () { return attempt(left - 1); });
          }
          return r.json().catch(function () { return {}; }).then(function (d) {
            if (!r.ok) { var er = new Error(d.error || ('http_' + r.status)); er.serverMessage = d.message || null; er.field = d.field || null; throw er; }
            return d;
          });
        }, function (err) {
          if (timer) clearTimeout(timer);
          var net = !!(err && (err.name === 'AbortError' ||
            /Failed to fetch|NetworkError|network|load failed/i.test(err.message || '')));
          if (net && canRetry && left > 0) { signalRetry(left); return wait(1800).then(function () { return attempt(left - 1); }); }
          throw new Error(net ? 'network' : ((err && err.message) || 'error'));
        });
    }
    return attempt(total);
  }
  function notify(msg, type) {
    var a = $('global-alert'); a.textContent = msg; a.className = 'alert alert--' + (type || 'info'); a.hidden = false;
    clearTimeout(notify._t); notify._t = setTimeout(function () { a.hidden = true; }, 5000);
  }
  var MSG = { forbidden: 'Action non autorisée.', bad_hierarchy: 'Ordre hiérarchique invalide (direction → département → service → agence).',
    bad_parent: 'Unité parente invalide.', bad_unit: 'Unité invalide.', missing_fields: 'Champs obligatoires manquants.',
    invalid_kind: 'Type d’unité invalide.', missing_name: 'Le nom de l’unité est requis.', not_found: 'Élément introuvable.',
    weak_password: 'Mot de passe trop faible (10 car., majuscule, minuscule, chiffre).', invalid_current_password: 'Mot de passe actuel incorrect.',
    password_change_required: 'Votre mot de passe doit être changé.', idle_timeout: 'Session expirée (60 min d’inactivité).',
    session_expired: 'Session expirée.', invalid_session: 'Session invalide.', not_authenticated: 'Non connecté.',
    invalid_position: 'Poste invalide.', supervisor_required: 'Un superviseur est requis pour ce poste.',
    invalid_supervisor: 'Le superviseur choisi doit être un Chef d’agence ou un Agent de crédit.',
    bad_supervisor: 'Superviseur invalide.',
    self_supervisor: 'Vous ne pouvez pas désigner votre propre compte comme responsable hiérarchique.',
    self_parent: 'Un agent ne peut pas être son propre responsable hiérarchique.',
    cycle_detected: 'Rattachement impossible : cela créerait une boucle hiérarchique.',
    use_teebo_console: 'Ce compte est l’administrateur teebo (super-admin) et n’a pas d’espace IMF. Connectez-vous avec un compte administrateur de votre IMF.',
    network: 'Connexion au serveur impossible pour le moment. Le serveur se réveille peut-être (quelques secondes sur l’offre gratuite). Patientez puis réessayez.',
    server_error: 'Le serveur a rencontré un problème interne. Patientez quelques instants puis réessayez.',
    http_500: 'Le serveur a rencontré un problème interne. Patientez quelques instants puis réessayez.',
    http_502: 'Le serveur se réveille (offre gratuite). Patientez quelques secondes puis réessayez.',
    http_503: 'Le serveur se réveille (offre gratuite). Patientez quelques secondes puis réessayez.',
    http_504: 'Le serveur met trop de temps à répondre. Patientez quelques secondes puis réessayez.',
    http_404: 'Service momentanément indisponible (route introuvable). Vérifiez que le serveur est bien déployé et à jour, puis réessayez.',
    error: 'Une erreur est survenue. Réessayez dans quelques instants.' };
  function fr(e) { var k = (e && e.message) ? e.message : e; return MSG[k] || 'Une erreur est survenue.'; }
  // Message serveur explicite (validation métier) sinon libellé générique.
  function srv(e) { return (e && e.serverMessage) ? e.serverMessage : fr(e); }

  function guard(err) {
    if (['idle_timeout','session_expired','invalid_session','not_authenticated','session_revoked'].indexOf(err.message) >= 0) {
      window.location.assign('/login.html');
      return true;
    }
    return false;
  }

  // ----- Navigation -----
  var VIEWS = ['dash', 'org', 'users', 'dispatches', 'profiles', 'credits', 'clients', 'caisse', 'coffre', 'compta', 'recouvrement', 'audit', 'settings', 'security'];
  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () {
      switchView(b.dataset.view);
      // L'onglet courant est reflété dans l'adresse, ce qui permet de
      // recharger la page ou de partager un lien (#org, #users, …).
      try { if (location.hash !== '#' + b.dataset.view) history.replaceState(null, '', '#' + b.dataset.view); } catch (e) {}
    });
  });
  window.addEventListener('hashchange', function () {
    var v = String(location.hash || '').replace(/^#/, '');
    if (VIEWS.indexOf(v) >= 0 && me) switchView(v);
  });
  function switchView(v) {
    VIEWS.forEach(function (x) { var n = $('view-' + x); if (n) n.hidden = x !== v; });
    document.querySelectorAll('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.view === v); });
    if (v === 'org') loadUnits();
    if (v === 'users') loadUsers();
    if (v === 'dispatches') loadDispatches();
    if (v === 'profiles') loadAccessMatrix();
    if (v === 'credits') loadCreditsQueue();
    if (v === 'clients') loadClients();
    if (v === 'caisse') loadCaisse();
    if (v === 'coffre') loadVault();
    if (v === 'compta') loadCompta();
    if (v === 'recouvrement') loadArrears();
    if (v === 'audit') loadAudit();
    if (v === 'settings') loadSettings();
    if (v === 'security') renderSession();
  }

  // ----- Modales -----
  function openModal(html) {
    $('modal-root').innerHTML = '<div class="modal-wrap"><div class="modal">' + html + '</div></div>';
    var wrap = $('modal-root').querySelector('.modal-wrap');
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeModal(); });
  }
  function closeModal() { $('modal-root').innerHTML = ''; }

  // ----- Tableau de bord -----
  // Une session invalide ne doit JAMAIS produire un aller-retour en boucle
  // entre la page et la connexion ("la page clignote sans fin").
  function sessionGone(err) {
    var m = (err && err.message) || '';
    return ['not_authenticated', 'invalid_session', 'session_expired', 'idle_timeout',
      'session_revoked', 'missing_token', 'no_session'].indexOf(m) >= 0;
  }
  var SESSION_ENDED = false;
  function endSessionQuietly() {
    if (SESSION_ENDED) return;
    SESSION_ENDED = true;
    var box = $('dash-kpis');
    if (box) dashCardState(box, 'Votre session est terminee. Cliquez sur « Se reconnecter » pour revenir a la page de connexion.', 'Se reconnecter', function () { window.location.assign('/login.html'); });
    notify('Votre session est terminee. Reconnectez-vous pour continuer.', 'info');
  }
  function renderDash() {
    try { renderDashInner(); } catch (e) {
      if (window.console && console.warn) console.warn('dashboard:', e && e.message);
      try { renderDashFallback(); } catch (_) {}
    }
  }
  function kpiSafe(fn, dflt) {
    try { var v = fn(); return (v === undefined || v === null) ? dflt : v; } catch (e) { return dflt; }
  }
  function dashCardState(el, msg, action, onAction) {
    if (!el) return;
    el.innerHTML = '<div class="empty">' + esc(msg) + (action ? '<br><button class="btn btn--ghost btn--sm" type="button" style="margin-top:10px">' + esc(action) + '</button>' : '') + '</div>';
    var b = action ? el.querySelector('button') : null;
    if (b && onAction) b.addEventListener('click', onAction);
  }
  function renderDashFallback() {
    var box = $('dash-kpis');
    if (box && !box.innerHTML) dashCardState(box, 'Chargement des informations…', 'Réessayer', function () { refreshDash(); });
  }
  function renderDashInner() {
    // Profil (/me) pas encore arrivé : valeurs neutres au lieu d'une erreur.
    if (!me || !me.user) me = me || { user: {}, permissions: [] };
    var u0 = me.user || {};
    var chips = $('dash-chips');
    if (chips) {
      var chipsHtml = '<span class="chip">IMF <b>' + esc(me.imf_code || '—') + '</b></span>';
      if (me.trial_active) chipsHtml += '<span class="chip chip--warn">Essai gratuit — <b>' + esc(me.trial_days_left == null ? '—' : me.trial_days_left) + ' j restants</b></span>';
      else if (me.imf_status || me.trial_active === false) chipsHtml += '<span class="chip chip--ok">Accès actif</span>';
      if (u0.role) chipsHtml += '<span class="chip">Rôle <b>' + esc(roleLabelForCode(effRole(u0))) + '</b></span>';
      var pc = u0.position_code || u0.position;
      if (pc) chipsHtml += '<span class="chip">Poste <b>' + esc((posByCode[pc] && posByCode[pc].label) || roleLabelForCode(pc)) + '</b></span>';
      chips.innerHTML = chipsHtml;
    }
    // --- Indicateurs : uniquement des valeurs fiables, jamais NaN/undefined --
    var U = Array.isArray(units) ? units : [];
    var W = Array.isArray(users) ? users : [];
    var unitsOk = U.length > 0;
    var usersOk = Array.isArray(users);
    var kpis = $('dash-kpis');
    if (kpis) {
      kpis.innerHTML = kpi(U.length, 'Unités organisationnelles', true) +
        kpi(U.filter(function (u) { return u && u.kind === 'agency'; }).length, 'Agences') +
        kpi(usersOk ? W.length : '—', 'Utilisateurs') +
        kpi(usersOk ? W.filter(function (u) { return u && u.must_change_password; }).length : '—', 'Mot de passe à créer');
      kpis.classList.toggle('is-loading', !unitsOk && !usersOk);
    }
    // --- Alerte « sans responsable hiérarchique » ---
    var alertBox = $('dash-alert');
    if (alertBox) {
      if (!usersOk) { alertBox.innerHTML = ''; }
      else {
        var noSup = W.filter(function (x) { return x && !x.parent_id; });
        var crit = noSup.filter(function (x) { var p = (kpiSafe(function () { return posOf(x); }, null)) || {}; return Boolean(p.needsSupervisor || p.id === 'collectrice'); });
        alertBox.innerHTML = noSup.length
          ? '<div class="alert ' + (crit.length ? 'alert--err' : 'alert--warn') + '" style="margin-bottom:14px">' +
              '<b>' + noSup.length + ' utilisateur' + (noSup.length > 1 ? 's' : '') + ' sans responsable hiérarchique' +
              (crit.length ? ' (dont ' + crit.length + ' agent' + (crit.length > 1 ? 's' : '') + ' de collecte)' : '') +
              '.</b> <a href="#users" data-goto-users style="font-weight:700">Ouvrir le personnel pour les rattacher →</a></div>'
          : '';
        var gl = alertBox.querySelector('[data-goto-users]');
        if (gl) gl.addEventListener('click', function (ev) { ev.preventDefault(); switchView('users');
          try { history.replaceState(null, '', '#users'); } catch (e) {} });
      }
    }
    // --- Mini-liste des unités ---
    var miniBox = $('dash-units-mini');
    if (miniBox) {
      if (!unitsOk) {
        dashCardState(miniBox, 'Chargement de l’organisation…', 'Réessayer', function () { refreshDash(); });
      } else {
        var KINDS = (typeof KIND_ORDER === 'object' && KIND_ORDER) ? KIND_ORDER : {};
        var mini = U.slice().sort(function (a, b) {
          return ((KINDS[a.kind] || 0) - (KINDS[b.kind] || 0)) || String(a.name || '').localeCompare(String(b.name || ''));
        }).slice(0, 6);
        miniBox.innerHTML = mini.length
          ? '<table class="tbl"><tbody>' + mini.map(function (u) {
              return '<tr><td><b>' + esc(u.name) + '</b><br><small style="color:var(--muted)">' + esc((KIND_META[u.kind] || {}).label || u.kind) + '</small></td><td style="text-align:right" data-code><code>' + esc(displayCode(u.code_unit)) + '</code></td></tr>';
            }).join('') + '</tbody></table>'
          : '<div class="empty">Aucune unité créée pour le moment. Rendez-vous dans « Organisation ».</div>';
      }
    }
  }
  // Rechargement des données du tableau de bord (bouton « Réessayer »).
  var dashBusy = false;
  function refreshDash() {
    if (dashBusy) return Promise.resolve();
    dashBusy = true;
    return Promise.all([loadUnits(true), loadUsers(true)]).then(function () { renderDash(); })
      .catch(function () {}).then(function () { dashBusy = false; });
  }
  function kpiVal(v) {
    if (typeof v === 'number' && isFinite(v)) return String(v);
    if (typeof v === 'string' && v) return esc(v);
    return '—';
  }
  function kpi(v, l, dark) { return '<div class="kpi' + (dark ? ' kpi--dark' : '') + '"><b>' + kpiVal(v) + '</b><span>' + esc(l) + '</span></div>'; }

  // ----- Organisation (arbre) -----
  function loadUnits(silent) {
    var root = silent ? null : $('org-tree');
    // État visible immédiat au premier chargement (arbre encore vide), pour ne
    // pas laisser un « Chargement… » statique donner l'impression d'un blocage.
    if (root && !units.length) root.innerHTML = '<div class="empty">Chargement de l’organisation…</div>';
    function onRetry(n, total) {
      if (root && !units.length) {
        root.innerHTML = '<div class="empty">Connexion au serveur… réveil en cours (tentative ' + n + '/' + total + ').' +
          '<br><small style="color:var(--muted)">L’offre gratuite met le serveur en veille ; cela peut prendre ~30 s.</small></div>';
      }
    }
    return api('/api/v1/units', 'GET', null, onRetry).then(function (d) {
      units = d.units || [];
      renderTree();
      // Le tableau de bord est secondaire : une erreur de rendu ne doit jamais
      // transformer l'ouverture de l'onglet Organisation en « Une erreur est
      // survenue ».
      try { renderDash(); } catch (e) { /* dash non bloquant */ }
    }).catch(function (e) {
      if (guard(e)) return;
      if (silent) throw e;
      renderUnitsError(e); notify(fr(e), 'err');
    });
  }
  // Au lieu de laisser le libellé « Chargement… » tourner indéfiniment lorsque
  // l'appel échoue, on affiche la raison et un bouton « Réessayer ».
  function renderUnitsError(e) {
    var root = $('org-tree'); if (!root) return;
    // Indice technique (code d'erreur brut) pour faciliter le diagnostic en cas
    // de récidive : s'affiche discrètement sous le message lisible.
    var code = (e && e.message) ? String(e.message) : 'error';
    root.innerHTML = '<div class="empty">' + esc(fr(e)) +
      '<br><small style="color:var(--muted)">(code : ' + esc(code) + ')</small>' +
      '<br><button class="btn btn--ghost btn--sm" id="org-retry" type="button" style="margin-top:10px">Réessayer</button></div>';
    var b = $('org-retry');
    if (b) b.addEventListener('click', function () {
      root.innerHTML = '<div class="empty">Chargement…</div>';
      loadUnits();
    });
  }
  // Un code d'unité semé par la structure par défaut se présente sous la forme
  // « OPS_CAISSE::<uuid-imf> » : la partie technique est masquée à l'écran.
  function displayCode(c) {
    var v = String(c == null ? '' : c);
    return v.indexOf('::') >= 0 ? v.split('::')[0] : v;
  }
  // Libellé lisible d'une unité : jamais de code brut « OPS_CAISSE » à l'écran.
  function unitLabel(u) {
    var m = KIND_META[u.kind];
    return (m ? m.label : String(u.kind || 'Unité')) + ' · ' + u.name;
  }

  // ---- Conseil d'Administration (vague 28) -------------------------------
  // L'unité Conseil d'Administration est la seule racine qui ne soit pas une
  // Direction : son étiquette courte est donc « CA ».
  function normCA(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function isCA(u) {
    if (!u) return false;
    if (unitKey(u) === 'CA') return true;
    return normCA(u.name).indexOf('conseil d administration') >= 0;
  }
  function shortKind(u) {
    if (isCA(u)) return 'CA';
    return String((u && u.kind) || '?').slice(0, 3).toUpperCase();
  }
  function caUnit() {
    var list = units.filter(isCA);
    if (!list.length) return null;
    var preferred = list.filter(function (x) { return unitKey(x) === 'CA'; })[0];
    return preferred || list[0];
  }

  var orgQuery = '';
  var orgOpen = {};              // unités dont les sous-unités sont dépliées

  function renderTree() {
    var root = $('org-tree');
    if (!root) return;
    if (!units.length) {
      root.classList.remove('tree--dense');
      root.innerHTML = '<div class="empty">Aucune unité. Créez d’abord le Conseil d’Administration et la Direction Générale, puis les départements, services et agences.' +
        '<br><button class="btn btn--primary btn--sm" id="org-seed" type="button" style="margin-top:10px">Générer la structure de base</button></div>';
      var sb = $('org-seed');
      if (sb) sb.addEventListener('click', seedStructure);
      return;
    }
    // Parcours robuste : une unité dont le parent est introuvable (parent
    // supprimé, donnée importée) est TOUJOURS affichée à la racine — avant,
    // elle disparaissait purement et simplement de l'écran.
    var known = {};
    units.forEach(function (u) { known[u.id] = true; });
    var byParent = {};
    units.forEach(function (u) {
      var k = (u.parent_id && known[u.parent_id]) ? u.parent_id : 'root';
      (byParent[k] = byParent[k] || []).push(u);
    });
    // Anti-cycle : on ne visite jamais deux fois la même unité.
    var seen = {};
    function kidsOf(id) {
      return (byParent[id] || []).slice().sort(function (a, b) {
        return (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.name.localeCompare(b.name);
      });
    }
    function matches(u) {
      if (!orgQuery) return true;
      var hay = (u.name + ' ' + (u.city || '') + ' ' + displayCode(u.code_unit)).toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return hay.indexOf(orgQuery) >= 0;
    }
    // Une unité est visible si elle correspond, ou si un de ses descendants correspond.
    function subtreeMatches(u) {
      if (matches(u)) return true;
      return kidsOf(u.id).some(subtreeMatches);
    }
    function node(u, depth) {
      if (seen[u.id]) return '';
      seen[u.id] = true;
      var kids = kidsOf(u.id);
      var m = KIND_META[u.kind] || { label: u.kind || 'Unite', short: shortKind(u) };
      // La carte « Conseil d'Administration » est repliée par défaut (elle n'a
      // qu'un enfant) pour que la Direction Générale reste visible d'emblée.
      var autoOpen = depth === 0 && !isCA(u);
      var showKids = kids.length && (orgQuery ? true : (autoOpen || orgOpen[u.id]));
      var collapsed = kids.length && !showKids;
      var canAdd = u.kind !== 'agency';
      var sub = m.label + (u.city ? ' · ' + esc(u.city) : '') + ' · ' + esc(displayCode(u.code_unit));
      return '<div class="node" data-unit="' + esc(u.id) + '">' +
        '<div class="node__head">' +
          '<div class="node__title">' +
            '<span class="node__kind">' + esc(m.short) + '</span>' +
            '<div><b>' + esc(u.name) + '</b><small>' + sub + '</small></div>' +
          '</div>' +
          '<div class="node__acts">' +
            (kids.length ? '<button class="btn btn--ghost btn--sm" data-toggle="' + esc(u.id) + '" title="' +
              (collapsed ? 'Déplier' : 'Replier') + '">' + (collapsed ? '▸ ' + kids.length : '▾ ' + kids.length) + '</button>' : '') +
            (canAdd ? '<button class="btn btn--ghost btn--sm" data-add="' + esc(u.id) + '">+ Sous-unité</button>' : '') +
            '<button class="btn btn--ghost btn--sm" data-edit="' + esc(u.id) + '">Modifier</button>' +
            '<button class="btn btn--ghost btn--sm" data-del="' + esc(u.id) + '">Supprimer</button>' +
          '</div>' +
        '</div>' +
        (showKids ? '<div class="children">' + kids.map(function (c) { return node(c, depth + 1); }).join('') + '</div>' : '') +
      '</div>';
    }
    // En recherche, on n'affiche que les branches concernées.
    var tops = kidsOf('root').filter(function (u) { return !orgQuery || subtreeMatches(u); });
    var html = tops.map(function (u) { return node(u, 0); }).join('');
    // Unités orphelines (parent introuvable) déjà remontées à la racine ci-dessus.
    root.classList.toggle('tree--dense', units.length > 18);
    root.innerHTML =
      '<div class="org-bar">' +
        '<span class="tag tag--muted">' + units.length + ' unité' + (units.length > 1 ? 's' : '') + '</span>' +
        (orgQuery ? '<span class="tag">Filtre : ' + esc(orgQuery) + '</span>' : '') +
        '<button class="btn btn--ghost btn--sm" id="org-expand">Tout déplier</button>' +
        '<button class="btn btn--ghost btn--sm" id="org-collapse">Tout replier</button>' +
        '<div class="org-search"><input id="org-filter" type="search" placeholder="Rechercher une unité, une ville…" value="' + esc(orgQuery) + '" autocomplete="off"></div>' +
      '</div>' + caBanner() +
      (html || '<div class="org-nomatch">Aucune unité ne correspond à « ' + esc(orgQuery) + ' ».</div>');

    var f = $('org-filter');
    if (f) f.addEventListener('input', function () {
      orgQuery = this.value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      // On restaure le focus et la position du curseur après re-rendu.
      renderTree();
      var nf = $('org-filter');
      if (nf) { nf.focus(); try { nf.setSelectionRange(nf.value.length, nf.value.length); } catch (_) {} }
    });
    // Boutons d'action de l'arbre : un seul écouteur par bouton, quelle que soit
    // la fréquence de re-rendu (avant : un écouteur ajouté à chaque rendu, d'où
    // des appels API en double).
    ['org-ca-create','org-seed2'].forEach(function (id) {
      var el = $(id); if (!el) return;
      var handler = id === 'org-ca-create' ? createCAUnit : seedStructure;
      el._teeboBound = handler;
      if (!el.dataset.bound) { el.dataset.bound = '1'; el.addEventListener('click', function (ev) { el._teeboBound(ev); }); }
    });
    var ex = $('org-expand'); if (ex) ex.addEventListener('click', function () {
      units.forEach(function (u) { orgOpen[u.id] = true; }); renderTree();
    });
    var co = $('org-collapse'); if (co) co.addEventListener('click', function () {
      orgOpen = {}; renderTree();
    });
    root.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.toggle;
        orgOpen[id] = !orgOpen[id];
        renderTree();
      });
    });
    root.querySelectorAll('[data-add]').forEach(function (b) {
      b.addEventListener('click', function () { unitModal(units.find(function (u) { return u.id === b.dataset.add; })); });
    });
    root.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { editUnitModal(units.find(function (u) { return u.id === b.dataset.edit; })); });
    });
    root.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { var u = units.find(function (x) { return x.id === b.dataset.del; }); if (u) askDeleteUnit(u); });
    });
  }

  // Types d'unité autorisés sous un parent donné (ou à la racine => direction),
  // en respectant la cohérence hiérarchique kind = parent + 1.
  function childKinds(parent) {
    return parent
      ? Object.keys(KIND_META).filter(function (k) { return KIND_ORDER[k] === KIND_ORDER[parent.kind] + 1; })
      : ['direction'];
  }
  // Modal « Nouvelle unité » du bouton principal : l'admin choisit D'ABORD le
  // rattachement (racine ou n'importe quelle unité pouvant avoir un enfant),
  // puis le type est contraint automatiquement pour garantir la cohérence.
  function newUnitModal() {
    var parents = units.filter(function (u) { return u.kind !== 'agency'; })
      .sort(function (a, b) { return (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.name.localeCompare(b.name); });
    openModal(
      '<h3>Nouvelle unité</h3><p class="sub">Choisissez le rattachement puis le type. La cohérence (direction › département › service › agence) est garantie automatiquement.</p>' +
      '<div class="fld"><label for="m-parent">Rattachement</label><select id="m-parent">' +
        '<option value="">— Racine (nouvelle direction) —</option>' +
        parents.map(function (u) { return '<option value="' + u.id + '">' + esc(KIND_META[u.kind].label) + ' · ' + esc(u.name) + '</option>'; }).join('') +
        '</select></div>' +
      '<div class="fld"><label for="m-kind">Type d’unité</label><select id="m-kind"></select></div>' +
      '<div class="fld"><label for="m-name">Nom</label><input id="m-name" placeholder="Ex : Agence de Bobo-Dioulasso"></div>' +
      '<div class="fld"><label for="m-city">Ville (optionnel)</label><input id="m-city"></div>' +
      '<p class="hint">Le code d’identification de l’unité est généré automatiquement.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="m-cancel">Annuler</button><button class="btn btn--primary" id="m-ok">Créer</button></div>'
    );
    function refreshKinds() {
      var pid = $('m-parent').value;
      var parent = pid ? units.find(function (u) { return u.id === pid; }) : null;
      var kinds = childKinds(parent);
      $('m-kind').innerHTML = kinds.map(function (k) { return '<option value="' + k + '">' + KIND_META[k].label + '</option>'; }).join('');
    }
    refreshKinds();
    $('m-parent').addEventListener('change', refreshKinds);
    $('m-cancel').addEventListener('click', closeModal);
    $('m-ok').addEventListener('click', function () {
      var pid = $('m-parent').value;
      var body = { kind: $('m-kind').value, name: $('m-name').value.trim(), city: $('m-city').value.trim(), parent_id: pid || null };
      if (!body.kind) { notify('Sélectionnez un type d’unité.', 'err'); return; }
      if (!body.name) { notify('Le nom est requis.', 'err'); return; }
      var self = this; self.disabled = true;
      api('/api/v1/units', 'POST', body).then(function (d) {
        closeModal(); notify('Unité créée — code ' + d.unit.code_unit, 'ok'); return loadUnits();
      }).catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  // Rappel visible : le PCA se rattache au Conseil d'Administration.
  function caBanner() {
    if (caUnit()) return '';
    return '<div class="org-ca">' +
      '<div><b>Conseil d’Administration</b><br><small>Unité de rattachement du Président du Conseil d’Administration (PCA), au-dessus de la Direction Générale.</small></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn--primary btn--sm" id="org-ca-create" type="button">Créer le Conseil d’Administration</button>' +
        '<button class="btn btn--ghost btn--sm" id="org-seed2" type="button">Générer la structure de base</button>' +
      '</div></div>';
  }
  function seedStructure(ev) {
    var btn = (ev && ev.currentTarget) || null;
    if (!confirm('Créer le Conseil d’Administration, la Direction Générale, les Départements et Services de base ? Vous pourrez tout modifier ensuite.')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Génération...'; }
    api('/api/v1/structure/seed', 'POST', {}).then(function (d) {
      notify((d && d.units ? d.units.length : 0) + ' unités de base créées.', 'ok'); return loadUnits();
    }).catch(function (e) { if (btn) { btn.disabled = false; btn.textContent = 'Générer la structure de base'; } if (!guard(e)) notify(fr(e) || srv(e), 'err'); });
  }
  function createCAUnit(ev) {
    var btn = (ev && ev.currentTarget) || null;
    if (btn) { btn.disabled = true; btn.textContent = 'Création...'; }
    api('/api/v1/units', 'POST', { kind: 'direction', name: 'Conseil d’Administration', parent_id: null })
      .then(function () { notify('Conseil d’Administration créé.', 'ok'); return loadUnits(); })
      .catch(function (e) {
        if (guard(e)) return;
        if (btn) { btn.disabled = false; btn.textContent = 'Creer le Conseil d’Administration'; }
        // Deja presente sous un autre libelle : on recharge, l'encart disparait.
        notify(fr(e) || srv(e), 'err');
        return loadUnits().catch(function () {});
      });
  }

  function unitModal(parent) {
    var kinds = parent
      ? Object.keys(KIND_META).filter(function (k) { return KIND_ORDER[k] === KIND_ORDER[parent.kind] + 1; })
      : ['direction'];
    if (!kinds.length) { notify('Une agence n’a pas de sous-unité.', 'err'); return; }
    openModal(
      '<h3>Nouvelle unité</h3><p class="sub">' + (parent ? 'Rattachée à ' + esc(parent.name) : 'Unité racine de votre institution') + '</p>' +
      '<div class="fld"><label for="m-kind">Type d’unité</label><select id="m-kind">' +
        kinds.map(function (k) { return '<option value="' + k + '">' + KIND_META[k].label + '</option>'; }).join('') + '</select></div>' +
      '<div class="fld"><label for="m-name">Nom</label><input id="m-name" placeholder="Ex : Agence de Bobo-Dioulasso"></div>' +
      '<div class="fld"><label for="m-city">Ville (optionnel)</label><input id="m-city"></div>' +
      '<p class="hint">Le code d’identification de l’unité est généré automatiquement.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="m-cancel">Annuler</button><button class="btn btn--primary" id="m-ok">Créer</button></div>'
    );
    $('m-cancel').addEventListener('click', closeModal);
    $('m-ok').addEventListener('click', function () {
      var body = { kind: $('m-kind').value, name: $('m-name').value.trim(), city: $('m-city').value.trim(), parent_id: parent ? parent.id : null };
      if (!body.name) { notify('Le nom est requis.', 'err'); return; }
      this.disabled = true;
      var self = this;
      api('/api/v1/units', 'POST', body).then(function (d) {
        closeModal(); notify('Unité créée — code ' + d.unit.code_unit, 'ok'); return loadUnits();
      }).catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  // Modifier une unité existante : nom, ville et éventuellement le TYPE, en
  // ne proposant que les types qui préservent la cohérence hiérarchique
  // (= type du parent + 1, et type de chaque enfant − 1).
  function editUnitModal(u) {
    if (!u) return;
    var parent = u.parent_id ? units.find(function (x) { return x.id === u.parent_id; }) : null;
    var children = units.filter(function (x) { return x.parent_id === u.id; });
    var allowed = Object.keys(KIND_META).filter(function (k) {
      if (parent) { if (KIND_ORDER[k] !== KIND_ORDER[parent.kind] + 1) return false; }
      else if (KIND_ORDER[k] !== 1) return false; // racine => direction uniquement
      return children.every(function (ch) { return KIND_ORDER[ch.kind] === KIND_ORDER[k] + 1; });
    });
    if (allowed.indexOf(u.kind) < 0) allowed.unshift(u.kind);
    openModal(
      '<h3>Modifier l’unité</h3><p class="sub">' + esc(u.code_unit) + (parent ? ' · rattachée à ' + esc(parent.name) : ' · unité racine') + '</p>' +
      '<div class="fld"><label for="e-kind">Type d’unité</label><select id="e-kind"' + (allowed.length <= 1 ? ' disabled' : '') + '>' +
        allowed.map(function (k) { return '<option value="' + k + '"' + (k === u.kind ? ' selected' : '') + '>' + KIND_META[k].label + '</option>'; }).join('') + '</select>' +
        (allowed.length <= 1 ? '<small style="color:var(--muted)">Le type ne peut pas changer sans rompre la hiérarchie (parent/sous-unités).</small>' : '') + '</div>' +
      '<div class="fld"><label for="e-name">Nom</label><input id="e-name" value="' + esc(u.name) + '"></div>' +
      '<div class="fld"><label for="e-city">Ville (optionnel)</label><input id="e-city" value="' + esc(u.city || '') + '"></div>' +
      '<p class="hint">Si vous changez le type, un nouveau code d’unité est généré automatiquement.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="e-cancel">Annuler</button><button class="btn btn--primary" id="e-ok">Enregistrer</button></div>'
    );
    $('e-cancel').addEventListener('click', closeModal);
    $('e-ok').addEventListener('click', function () {
      var body = { kind: $('e-kind').value, name: $('e-name').value.trim(), city: $('e-city').value.trim() };
      if (!body.name) { notify('Le nom est requis.', 'err'); return; }
      var self = this; self.disabled = true;
      api('/api/v1/units/' + u.id, 'PATCH', body).then(function (d) {
        closeModal(); notify('Unité modifiée — code ' + d.unit.code_unit, 'ok'); return loadUnits();
      }).catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  function askDeleteUnit(u) {
    unitToDelete = u;
    openModal('<h3>Supprimer l’unité ?</h3><p class="sub">' + esc(u.name) + ' · ' + esc(u.code_unit) + '<br>Les sous-unités seront également supprimées.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="d-cancel">Annuler</button><button class="btn btn--primary" id="d-ok">Supprimer</button></div>');
    $('d-cancel').addEventListener('click', closeModal);
    $('d-ok').addEventListener('click', function () {
      api('/api/v1/units/' + unitToDelete.id, 'DELETE').then(function () { closeModal(); notify('Unité supprimée.', 'ok'); return loadUnits(); })
        .catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  // ----- Personnel -----
  function loadUsers(silent) {
    return api('/api/v1/users').then(function (d) { users = d.users || []; renderUsers(); renderDash(); })
      .catch(function (e) {
        if (guard(e)) return;
        if (silent) throw e;
        notify(fr(e), 'err');
      });
  }
  // Alerte visible : agents qui n'ont aucun responsable hiérarchique.
  // Un agent de collecte SANS responsable est un cas bloquant (sa collecte ne
  // remonte vers personne) : il est signalé en rouge. Les autres postes sont
  // signalés en orange (rattachement hiérarchique incomplet).
  function renderUsersAlert() {
    var box = $('users-alert');
    if (!box) return;
    var missing = users.filter(function (u) { return !u.parent_id; });
    window.__usersNoSup = missing.length;
    if (!missing.length) {
      box.innerHTML = '<div class="alert alert--ok" style="margin:0 0 14px"><b>Aucun agent isolé.</b> ' +
        'Tous les utilisateurs ont un responsable hiérarchique défini.</div>';
      return;
    }
    var critical = missing.filter(function (u) {
      var p = posOf(u) || {};
      return Boolean(p.needsSupervisor || p.id === 'collectrice');
    });
    var isCrit = critical.length > 0;
    var list = missing.map(function (u) {
      var p = posOf(u) || {};
      var must = Boolean(p.needsSupervisor || p.id === 'collectrice');
      return '<li style="margin:2px 0"><b>' + esc(u.full_name) + '</b> — ' + esc(posLabelOf(u)) +
        (must ? ' <span class="tag tag--err">obligatoire</span>' : '') +
        ' <button class="btn btn--ghost btn--sm" data-fixsup="' + u.id + '">Définir</button></li>';
    }).join('');
    box.innerHTML = '<div class="alert ' + (isCrit ? 'alert--err' : 'alert--warn') + '" style="margin:0 0 14px">' +
      '<div style="display:flex;gap:10px;align-items:flex-start">' +
        '<div style="font-size:20px;line-height:1">' + (isCrit ? '⛔' : '⚠️') + '</div>' +
        '<div style="flex:1">' +
          '<b>' + missing.length + ' utilisateur' + (missing.length > 1 ? 's' : '') +
          ' sans responsable hiérarchique.</b>' +
          (isCrit ? ' Dont ' + critical.length + ' agent' + (critical.length > 1 ? 's' : '') +
            ' de collecte (cas bloquant : la collecte ne peut pas être validée).' : '') +
          ' Ouvrez « Responsable » pour les rattacher.' +
          '<ul style="margin:8px 0 0 16px;padding:0">' + list + '</ul>' +
        '</div></div></div>';
    box.querySelectorAll('button[data-fixsup]').forEach(function (b) {
      b.addEventListener('click', function () {
        var u = users.find(function (x) { return x.id === b.dataset.fixsup; });
        if (u) supervisorModal(u);
      });
    });
  }

  function renderUsers() {
    var box = $('users-table');
    renderUsersAlert();
    if (!users.length) { box.innerHTML = '<div class="empty">Aucun utilisateur. Créez le premier accès.</div>'; return; }
    // Colonne « Responsable » ajoutée : elle rend lisible le rattachement
    // hiérarchique et permet de le corriger sans supprimer le compte.
    var byId = {};
    users.forEach(function (u) { byId[u.id] = u; });
    box.innerHTML = '<table class="tbl"><thead><tr><th>Nom</th><th>Code d’accès</th><th>Rôle</th><th>Unité</th>' +
      '<th>Responsable</th><th>Contact</th><th>Mot de passe</th><th>Actions</th></tr></thead><tbody>' +
      users.map(function (u) {
        var pl = posLabelOf(u);
        var sup = u.parent_id ? byId[u.parent_id] : null;
        var supCell;
        if (u.parent_id && !sup) supCell = '<span class="tag tag--warn">Introuvable</span>';
        else if (!sup) supCell = '<button class="tag tag--warn" data-sup="' + u.id + '" title="Définir le responsable">⚠ Non défini</button>';
        else supCell = esc(sup.full_name) + '<br><small style="color:var(--muted)">' + esc(posLabelOf(sup)) + '</small>';
        return '<tr><td><b>' + esc(u.full_name) + '</b>' +
            (pl ? '<br><small style="color:var(--muted)">' + esc(pl) + '</small>' : '') + '</td>' +
          '<td><code>' + esc(u.code_user) + '</code></td><td>' + esc(roleLabelForCode(u.role)) + '</td>' +
          '<td>' + (u.unit_name ? esc(u.unit_name) : '<span class="tag tag--warn">Non affecté</span>') + '</td>' +
          '<td>' + supCell + '</td>' +
          '<td>' + esc(u.email) + (u.phone ? '<br><small style="color:var(--muted)">' + esc(u.phone) + '</small>' : '') + '</td>' +
          '<td>' + (u.must_change_password ? '<span class="tag tag--warn">À créer</span>' : '<span class="tag tag--ok">Actif</span>') + '</td>' +
          '<td style="white-space:nowrap"><button class="btn btn--ghost btn--sm" data-sup="' + u.id + '">Responsable</button> ' +
            '<button class="btn btn--ghost btn--sm" data-resend="' + u.id + '">Renvoyer le code</button></td></tr>';
      }).join('') + '</tbody></table>';
    box.querySelectorAll('button[data-resend]').forEach(function (b) {
      b.addEventListener('click', function () { var u = users.find(function (x) { return x.id === b.dataset.resend; }); if (u) resendCode(u); });
    });
    box.querySelectorAll('button[data-sup]').forEach(function (b) {
      b.addEventListener('click', function () {
        var u = users.find(function (x) { return x.id === b.dataset.sup; });
        if (u) supervisorModal(u);
      });
    });
  }

  // Changement du responsable hiérarchique d'un agent existant.
  // Règles appliquées :
  //  - l'agent ne peut pas être son propre responsable (auto-assignation bloquée) ;
  //  - le responsable doit appartenir à la même institution ;
  //  - un agent de collecte n'accepte qu'un Chef d'agence ou un Agent de crédit ;
  //  - la modification est refusée si elle crée une boucle hiérarchique.
  function supervisorModal(u) {
    loadPositions().then(function () {
      var p = posOf(u) || {};
      p.selfId = u.id;
      var cands = supervisorCandidates(p);
      var opts = cands.map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (u.parent_id === c.id ? ' selected' : '') + '>' +
          esc(c.full_name + ' — ' + posLabelOf(c)) + '</option>';
      }).join('');
      openModal(
        '<h3>Responsable hiérarchique</h3><p class="sub">' + esc(u.full_name) + ' · ' + esc(posLabelOf(u)) + '</p>' +
        '<div class="fld"><label for="sh-sup">Superviseur / Responsable hiérarchique</label>' +
          '<select id="sh-sup"><option value="">— Aucun (pas de responsable) —</option>' + opts + '</select>' +
          '<small style="color:var(--muted)">' + (p.needsSupervisor
            ? 'Obligatoire pour un agent de collecte : Chef d’agence ou Agent de crédit.'
            : 'Facultatif. Un agent ne peut jamais être son propre responsable.') + '</small></div>' +
        '<div class="modal__nav"><button class="btn btn--ghost" id="sh-cancel">Annuler</button>' +
          '<button class="btn btn--primary" id="sh-ok">Enregistrer</button></div>'
      );
      var sel = $('sh-sup');
      if (u.parent_id) sel.value = u.parent_id;
      $('sh-cancel').addEventListener('click', closeModal);
      $('sh-ok').addEventListener('click', function () {
        var val = sel.value || null;
        // BLOCAGE 1 : auto-assignation (l'agent ne se choisit pas lui-même).
        if (val && String(val) === String(u.id)) { notify('Un agent ne peut pas être son propre responsable hiérarchique.', 'err'); return; }
        // BLOCAGE 2 : le responsable choisi ne doit pas être un subordonné de l'agent.
        var cur = users.find(function (x) { return x.id === val; });
        var chain = [], guardN = 0;
        while (cur && guardN < 60) {
          chain.push(cur.id);
          cur = users.find(function (x) { return x.id === cur.parent_id; });
          guardN += 1;
        }
        if (val && chain.indexOf(u.id) >= 0) { notify('Rattachement impossible : cela créerait une boucle hiérarchique.', 'err'); return; }
        // BLOCAGE 3 : agent de collecte = responsable obligatoire et habilité.
        if (p.needsSupervisor) {
          if (!val) { notify('Un agent de collecte doit être rattaché à un superviseur.', 'err'); return; }
          var sup = users.find(function (x) { return x.id === val; });
          if (!sup || !posSupervisesCollectors(posOf(sup))) { notify('Le responsable d’un agent de collecte doit être un Chef d’agence ou un Agent de crédit.', 'err'); return; }
        }
        var self = this; self.disabled = true;
        api('/api/v1/users/' + u.id, 'PATCH', { parent_id: val }).then(function () {
          closeModal(); notify('Responsable hiérarchique mis à jour.', 'ok'); return loadUsers();
        }).catch(function (e) { self.disabled = false; if (!guard(e)) notify(srv(e), 'err'); });
      });
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  function loadPositions() {
    if (positions.length) return Promise.resolve();
    return api('/api/v1/positions').then(function (d) {
      positions = d.positions || []; posDepts = d.departments || []; posServices = d.services || [];
      posByCode = {}; positions.forEach(function (p) { posByCode[p.code] = p; });
    });
  }
  // Options du poste, groupées Département › Service (optgroup imbriqué à plat).
  function positionOptionsHtml() {
    var svcLabel = {}; posServices.forEach(function (s) { svcLabel[s.code] = s.label; });
    return posDepts.map(function (dp) {
      var list = positions.filter(function (p) { return p.dept === dp.code; });
      if (!list.length) return '';
      var byService = {};
      list.forEach(function (p) { (byService[p.service] = byService[p.service] || []).push(p); });
      var inner = Object.keys(byService).map(function (sc) {
        return byService[sc].map(function (p) {
          var svc = svcLabel[sc] || sc;
          return '<option value="' + p.code + '">' + esc(svc + ' — ' + p.label) + '</option>';
        }).join('');
      }).join('');
      return '<optgroup label="' + esc(dp.label) + '">' + inner + '</optgroup>';
    }).join('');
  }
  // ------------------------------------------------------------------
  // Responsable hiérarchique : qui peut être proposé comme supérieur ?
  //
  // Cause des listes réduites à « — Aucun — » + l'administrateur : les postes
  // proviennent de DEUX sources et n'utilisent pas les mêmes clés
  // (supervisesCollectors pour les postes standards, can_supervise_collectors
  // pour les postes personnalisés). On normalise donc chaque poste avant de
  // décider s'il encadre.
  // ------------------------------------------------------------------
  function boolish(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
  function posOf(u) {
    if (!u) return null;
    return posByCode[u.position_code] || posByCode[u.position] || null;
  }
  function posManager(p) { return !!(p && (p.manager === true || boolish(p.manager))); }
  function posLevel(p) { return p ? Number(p.level || 0) : 0; }
  function posSupervisesCollectors(p) {
    return !!(p && (p.supervisesCollectors || p.can_supervise_collectors || p.canSuperviseCollectors));
  }
  // Libellé du poste d'un agent (toujours lisible, jamais un code brut).
  function posLabelOf(u) {
    var p = posOf(u);
    if (p && p.label) return p.label;
    return u.position || roleLabelForCode(u.role);
  }
  // Rôles « encadrants » du socle : utilisés quand l'agent n'a pas de poste
  // enregistré (cas fréquent des comptes créés avant la gestion des postes).
  var MANAGER_ROLES = ['admin_imf', 'direction', 'department', 'service', 'agency',
    'credit_director', 'operations_director', 'cfo', 'auditor', 'hr_logistics_manager',
    'compliance_officer', 'it_admin', 'security_engineer', 'superadmin'];
  // Un agent « encadre » s'il a un poste de manager, ou à défaut un rôle encadrant.
  function canManage(u) {
    var p = posOf(u);
    if (p) return posManager(p) || posSupervisesCollectors(p);
    return MANAGER_ROLES.indexOf(u.role) >= 0;
  }
  // Exclusion : le compte en cours de création et le compte connecté ne peuvent
  // jamais être leur propre responsable (règle anti auto-assignation).
  function currentUserId() { return (me && me.user && me.user.id) ? me.user.id : null; }
  function eligibleSupervisors(p) {
    return users.filter(function (u) {
      if (u.is_active === false) return false;
      if (currentUserId() && u.id === currentUserId()) return false;
      if (p && p.needsSupervisor) return posSupervisesCollectors(posOf(u));
      return true;
    });
  }
  // Clé de rattachement d'une unité : préfixe du code d'unité posé par le
  // séchage de structure (ex. « OPS_CAISSE::<imf> » -> « OPS_CAISSE »).
  function unitKey(u) { return String(u && u.code_unit || '').split('::')[0]; }
  function normLabel(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // Le PCA se rattache au Conseil d'Administration (unite dediee, vague 28).
  function homeUnitForPosition(p) {
    if (!p) return '';
    var lbl = normCA(p.label || '');
    if (p.code === 'POS_PCA' || lbl.indexOf('president du conseil d administration') === 0) {
      var ca = caUnit();
      return ca ? ca.id : '';
    }
    return '';
  }
  function autoUnitForPosition(p) {
    if (!p) return '';
    var home = homeUnitForPosition(p);
    if (home) return home;
    var byKey = function (kind, key) {
      var u = units.find(function (x) { return x.kind === kind && unitKey(x) === key; });
      return u ? u.id : '';
    };
    var id = byKey('service', p.service) || byKey('department', p.dept);
    if (id) return id;
    var svcLabel = {}; posServices.forEach(function (s) { svcLabel[s.code] = s.label; });
    var deptLabel = {}; posDepts.forEach(function (d) { deptLabel[d.code] = d.label; });
    var targets = [normLabel(svcLabel[p.service]), normLabel(deptLabel[p.dept])].filter(Boolean);
    var m = units.find(function (x) { return targets.indexOf(normLabel(x.name)) >= 0; });
    return m ? m.id : '';
  }
  // Candidats, du plus pertinent au moins pertinent :
  //   1. manager du même service       4. tout encadrant de l'IMF
  //   2. manager du même département   5. tout autre agent (dernier recours)
  //   3. manager d'un autre département (ex. Direction Générale)
  // Le tout trié du niveau le plus proche au-dessus du poste choisi.
  function supervisorCandidates(p) {
    p = p || {};
    var base = eligibleSupervisors(p);
    // Un agent ne peut jamais être son propre responsable : le compte en cours
    // de modification est écarté AVANT le classement.
    if (p.selfId) base = base.filter(function (u) { return String(u.id) !== String(p.selfId); });
    var rank = {};
    base.forEach(function (u) {
      var up = posOf(u);
      var r = 5;
      if (canManage(u)) {
        r = 4;
        if (posManager(up)) {
          if (up.service && p.service && up.service === p.service) r = 1;
          else if (up.dept && p.dept && up.dept === p.dept) r = 2;
          else r = 3;
        }
      }
      // Un supérieur doit être d'un niveau au moins égal ; sinon il descend.
      if (posLevel(up) < posLevel(p)) r += 10;
      if (up && up.dept === p.dept) r -= 0.5;   // même département = avantage
      rank[u.id] = r;
    });
    return base.slice().sort(function (a, b) {
      if (rank[a.id] !== rank[b.id]) return rank[a.id] - rank[b.id];
      var la = posLevel(posOf(a)), lb = posLevel(posOf(b));
      if (la !== lb) return la - lb;              // niveau le plus proche d'abord
      return String(a.full_name || '').localeCompare(String(b.full_name || ''));
    });
  }
  function supOption(u) {
    var p = posOf(u);
    var lvl = p && p.level ? ' · niv. ' + p.level : '';
    return '<option value="' + esc(u.id) + '">' + esc(u.full_name + ' — ' + posLabelOf(u) + lvl) + '</option>';
  }
  // Blocage anti auto-assignation : appliqué côté interface ET côté serveur.
  function isSelfSupervisor(supId) {
    var cid = currentUserId();
    return !!(supId && cid && String(supId) === String(cid));
  }
  function userModal() {
    loadPositions().then(function () {
      openModal(
      '<h3>Nouvel utilisateur</h3><p class="sub">Le code d’accès sera envoyé par e-mail et WhatsApp.</p>' +
      '<div class="fld"><label for="u-name">Nom complet</label><input id="u-name"></div>' +
      '<div class="fld"><label for="u-pos">Poste occupé</label><select id="u-pos"><option value="">— Choisir un poste —</option>' +
        positionOptionsHtml() + '</select>' +
        '<small id="u-pos-hint" style="color:var(--muted)">Le poste détermine automatiquement le rôle et les permissions.</small></div>' +
      '<div class="fld" id="u-sup-wrap" hidden><label for="u-sup">Superviseur / Responsable hiérarchique</label>' +
        '<select id="u-sup"></select>' +
        '<small id="u-sup-hint" style="color:var(--muted)">Pré-rempli d’après le poste ; vous pouvez le modifier.</small></div>' +
      '<div class="fld"><label for="u-unit">Unité de rattachement</label><select id="u-unit"><option value="">— Aucune —</option>' +
        units.map(function (u) { return '<option value="' + u.id + '">' + esc(KIND_META[u.kind].label + ' · ' + u.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="form-grid"><div class="fld"><label for="u-email">E-mail</label><input id="u-email" type="email"></div>' +
      '<div class="fld"><label for="u-phone">Téléphone (WhatsApp)</label><input id="u-phone" type="tel" placeholder="+226 00 00 00 00"></div></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="u-cancel">Annuler</button><button class="btn btn--primary" id="u-ok">Créer et envoyer le code</button></div>'
      );
      // À chaque choix de poste : on pré-remplit automatiquement le responsable
      // hiérarchique ET l'unité de rattachement correspondants.
      function syncFromPosition() {
        var p = posByCode[$('u-pos').value];
        var wrap = $('u-sup-wrap'), sel = $('u-sup'), unitSel = $('u-unit');
        if (!p) { wrap.hidden = true; sel.innerHTML = ''; return; }
        var cands = supervisorCandidates(p);
        // Aucun candidat exploitable : on l'explique au lieu de laisser une liste
        // avec pour seul choix l'administrateur connecté (perçu comme « figé »).
        if (!cands.length) {
          sel.innerHTML = p.needsSupervisor
            ? '<option value="">Aucun responsable disponible — créez d’abord un Chef d’agence ou un Agent de crédit</option>'
            : '<option value="">— Aucun collaborateur encadrant disponible —</option>';
          sel.value = '';
          wrap.hidden = false;
          var uid0 = autoUnitForPosition(p);
          if (uid0) unitSel.value = uid0;
          return;
        }
        var opts = cands.map(supOption).join('');
        // Dans les deux cas la liste commence par « — Aucun — » : le champ est
        // donc TOUJOURS modifiable, y compris quand un seul candidat reste.
        sel.innerHTML = '<option value="">— Aucun (pas de responsable) —</option>' + opts;
        // Présélection sur le candidat le plus proche (obligatoire pour un agent
        // de collecte, facultatif pour les autres postes).
        sel.value = cands[0].id;
        var hint = $('u-sup-hint');
        if (hint) hint.textContent = p.needsSupervisor
          ? 'Obligatoire pour ce poste. Choix limité aux Chefs d’agence et Agents de crédit — vous pouvez en changer.'
          : 'Pré-rempli d’après le poste ; vous pouvez choisir un autre agent ou « — Aucun — ».';
        // Le champ reste TOUJOURS visible et modifiable une fois un poste choisi :
        // plus de champ figé/vide sans possibilité de sélection.
        wrap.hidden = false;
        var uid = autoUnitForPosition(p);
        if (uid) unitSel.value = uid;
      }
      $('u-pos').addEventListener('change', syncFromPosition);
      // Garde-fou : si la liste ne contient qu'un seul choix, il reste
      // modifiable (« — Aucun — ») — rien n'est jamais verrouillé.
      $('u-sup').addEventListener('change', function () {
        if (isSelfSupervisor($('u-sup').value)) {
          $('u-sup').value = '';
          notify('Vous ne pouvez pas vous désigner vous-même comme responsable hiérarchique.', 'err');
        }
      });
      $('u-cancel').addEventListener('click', closeModal);
      $('u-ok').addEventListener('click', function () {
        var pos = posByCode[$('u-pos').value];
        var body = { full_name: $('u-name').value.trim(), position_code: $('u-pos').value || null,
          org_unit_id: $('u-unit').value || null, email: $('u-email').value.trim(), phone: $('u-phone').value.trim() };
        var supId = (!$('u-sup-wrap').hidden && $('u-sup').value) ? $('u-sup').value : null;
        // BLOCAGE anti auto-assignation : le nouveau compte est un nouveau
        // collaborateur, il ne peut donc jamais être son propre responsable.
        // On refuse aussi d'enregistrer le compte connecté comme responsable.
        if (supId) body.supervisor_id = supId;
        if (!body.full_name || !body.email || !body.position_code) { notify('Nom, e-mail et poste sont requis.', 'err'); return; }
        if (isSelfSupervisor(supId)) { notify('Vous ne pouvez pas être votre propre responsable hiérarchique.', 'err'); return; }
        if (pos && pos.needsSupervisor && !supId) { notify('Un agent de collecte doit être rattaché à un superviseur (Chef d’agence ou Agent de crédit).', 'err'); return; }
        var self = this; self.disabled = true;
        api('/api/v1/users', 'POST', body).then(function (d) { closeModal(); return loadUsers().then(function () { notify('Utilisateur créé — code ' + d.code_user + '.', 'ok'); showSendCodeModal(d, body.full_name); }); })
          .catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
      });
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  // ----- Sécurité -----
  function renderSession() {
    var rows = [['Nom', me.user.full_name], ['Identifiant', me.user.code_user], ['E-mail', me.user.email],
      ['Rôle', roleLabelForCode(effRole(me.user))], ['Mot de passe défini le', me.password_set_at ? new Date(me.password_set_at).toLocaleString('fr-FR') : '—'],
      ['Expiration du mot de passe', me.password_expires_at ? new Date(me.password_expires_at).toLocaleString('fr-FR') : '—'],
      ['Déconnexion auto', 'après 60 minutes d’inactivité']];
    $('session-info').innerHTML = rows.map(function (r) { return '<div><dt style="font-size:12px;color:var(--muted)">' + r[0] + '</dt><dd style="font-weight:600">' + esc(r[1]) + '</dd></div>'; }).join('');
    render2fa();
  }

  // ----- Double authentification (état + enrôlement + codes de secours) -----
  function render2fa() {
    var host = $('twofa-body'); if (!host) return;
    api('/api/v1/auth/2fa/status').then(function (st) {
      var b = $('twofa-badge');
      if (st.enabled) { b.textContent = 'Activée'; b.style.background = '#e8f7c8'; b.style.color = '#3d5c00'; }
      else { b.textContent = 'Non activée'; b.style.background = '#ffe6e6'; b.style.color = '#a00'; }
      if (st.enabled) {
        host.innerHTML = '<p style="font-size:13.5px;margin-bottom:10px">Votre compte est protégé. Codes de secours restants : <b>' + (st.recovery_count || 0) + '</b>.</p>' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn--dark" id="tfa-regen">Régénérer mes codes de secours</button>' +
          '<button class="btn btn--ghost" id="tfa-restart">Ré-enrôler (nouveau téléphone)</button></div>';
        $('tfa-restart').addEventListener('click', function () { startEnroll(); });
        $('tfa-regen').addEventListener('click', function () { regenCodes(this); });
      } else {
        host.innerHTML = '<button class="btn btn--primary" id="tfa-start">Activer la double authentification</button>';
        $('tfa-start').addEventListener('click', function () { startEnroll(); });
      }
    }).catch(function (e) { host.innerHTML = '<div class="empty">' + esc(fr(e)) + '</div>'; });
  }

  function startEnroll() {
    var host = $('twofa-body');
    host.innerHTML = '<div class="empty">Préparation…</div>';
    api('/api/v1/auth/2fa/enroll/start', 'POST', {}).then(function (d) {
      // QR code généré par le SERVEUR (data URL, 100 % local) : aucune requête
      // vers un service externe, compatible avec la politique de sécurité CSP.
      var qr = d.qr_data_url || '';
      host.innerHTML =
        '<div style="display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start">' +
        '<div style="text-align:center"><img src="' + esc(qr) + '" width="190" height="190" alt="QR d\'enrôlement" style="border:1px solid var(--line);border-radius:12px;background:#fff"></div>' +
        '<div style="flex:1;min-width:240px">' +
        '<p style="font-size:13.5px;margin-bottom:8px">1. Installez <b>Google Authenticator</b>, <b>Authy</b> ou <b>FreeOTP</b> sur votre téléphone.</p>' +
        '<p style="font-size:13.5px;margin-bottom:8px">2. Scannez ce QR code (ou saisissez la clé ci-dessous).</p>' +
        '<p style="font-size:12.5px;color:var(--muted);margin-bottom:14px">Clé manuelle : <code style="background:#f2f2f7;padding:3px 7px;border-radius:6px;font-size:12.5px">' + esc(d.secret) + '</code></p>' +
        '<div class="fld"><label for="tfa-code">3. Saisissez le code à 6 chiffres affiché</label><input id="tfa-code" class="pin" inputmode="numeric" maxlength="6" placeholder="••••••"></div>' +
        '<button class="btn btn--primary" id="tfa-confirm">Confirmer et activer</button>' +
        '</div></div>';
      $('tfa-confirm').addEventListener('click', function () { confirmEnroll(this); });
    }).catch(function (e) { host.innerHTML = '<div class="empty">' + esc(fr(e)) + '</div>'; });
  }

  function confirmEnroll(btn) {
    var code = ($('tfa-code').value || '').replace(/\D/g, '');
    if (code.length !== 6) { notify('Le code doit comporter 6 chiffres.', 'err'); return; }
    btn.disabled = true; btn.textContent = 'Vérification…';
    api('/api/v1/auth/2fa/enroll/confirm', 'POST', { code: code }).then(function (d) {
      var codes = (d.recovery_codes || []).join('   ');
      openModal(
        '<h2>Double authentification activée</h2>' +
        '<p class="sub">Conservez ces <b>codes de secours</b>. Chacun ne peut servir qu’une seule fois, en cas de perte de votre téléphone. Notez-les maintenant : ils ne seront plus affichés.</p>' +
        '<div style="background:#f7f8fb;border:1px dashed var(--line);border-radius:12px;padding:14px;font-family:ui-monospace,Menlo,monospace;font-size:14px;letter-spacing:.5px;text-align:center;line-height:2">' + esc(codes) + '</div>' +
        '<div class="modal__nav"><button class="btn btn--ghost" id="rc-copy">Copier</button><button class="btn btn--primary" id="rc-ok">J’ai noté</button></div>');
      $('rc-copy').addEventListener('click', function () { try { navigator.clipboard.writeText((d.recovery_codes || []).join('\n')); this.textContent = 'Copié ✓'; } catch (e) {} });
      $('rc-ok').addEventListener('click', function () { closeModal(); render2fa(); });
    }).catch(function (e) { btn.disabled = false; btn.textContent = 'Confirmer et activer'; notify(fr(e), 'err'); });
  }

  function regenCodes(btn) {
    btn.disabled = true; btn.textContent = 'Génération…';
    api('/api/v1/auth/2fa/enroll/start', 'POST', {}).then(function () {
      notify('Saisissez un code à 6 chiffres pour valider la régénération.', 'info');
      startEnroll();
    }).catch(function (e) { notify(fr(e), 'err'); });
  }
  $('form-pwd').addEventListener('submit', function (e) {
    e.preventDefault();
    var b = e.target.querySelector('button'); b.disabled = true;
    api('/api/v1/auth/change-password', 'POST', { current: $('pwd-cur').value, new_password: $('pwd-new').value })
      .then(function () { $('pwd-cur').value = ''; $('pwd-new').value = ''; notify('Mot de passe mis à jour. Expiration dans 60 jours.', 'ok'); })
      .catch(function (err) { if (!guard(err)) notify(fr(err), 'err'); })
      .finally(function () { b.disabled = false; });
  });

  // ----- Déconnexion -----
  $('btn-logout').addEventListener('click', function () {
    api('/api/v1/auth/logout', 'POST').finally(function () { window.location.assign('/login.html'); });
  });

  // ----- Boutons -----
  $('btn-new-unit').addEventListener('click', function () { newUnitModal(); });
  $('btn-new-user').addEventListener('click', function () { if (!units.length) { notify('Créez d’abord votre organisation.', 'err'); return; } userModal(); });

  // ----- Paramètres IMF (identité visuelle + mentions légales + TVA) -----
  var settingsCanEdit = false;
  var logoDraft = null;   // data URL en attente d'enregistrement

  function loadSettings() {
    return api('/api/v1/org-settings').then(function (d) {
      var s = d.settings || {};
      settingsCanEdit = !!d.can_edit;
      // Champs texte
      set('s-legal_name', s.legal_name); set('s-legal_form', s.legal_form);
      set('s-trade_register_no', s.trade_register_no); set('s-tax_id', s.tax_id);
      set('s-vat_number', s.vat_number); set('s-bceao_agreement_no', s.bceao_agreement_no);
      set('s-legal_address', s.legal_address); set('s-bank_details', s.bank_details);
      set('s-footer_note', s.footer_note);
      set('s-notify_whatsapp', s.notify_whatsapp); set('s-notify_email', s.notify_email);
      $('s-share_capital').value = s.share_capital_cents != null ? fmtAmount(s.share_capital_cents / 100) : '';
      if ($('s-part-sociale')) $('s-part-sociale').value = s.part_sociale_nominal_cents != null ? fmtAmount(s.part_sociale_nominal_cents / 100) : '';
      // Durées de validité des pièces d'identité (en mois).
      var vmap = s.id_doc_validity_months || {};
      ['cni','passeport','cedeao','consulaire_sejour'].forEach(function (k) {
        var el = $('s-valid-' + k); if (el) el.value = vmap[k] != null ? String(vmap[k]) : '';
      });
      // TVA : points de base -> pourcentage lisible (vide = non applicable)
      $('s-vat').value = d.vat_rate_bp != null ? String(d.vat_rate_bp / 100).replace('.', ',') : '';
      // Prestataire
      var sup = d.supplier || {};
      $('supplier-info').innerHTML =
        row('Prestataire', sup.name) + row('Adresse', [sup.address, sup.address2].filter(Boolean).join(' — ')) +
        row('Téléphone', sup.tel) + row('E-mail', sup.email);
      // Logo actuel
      logoDraft = null;
      renderLogo(s.logo_data_url);
      $('btn-logo-remove').hidden = !s.logo_data_url || !settingsCanEdit;
      $('logo-info').textContent = '';
      // Droits d'édition
      $('settings-badge').className = 'tag ' + (settingsCanEdit ? 'tag--ok' : 'tag--muted');
      $('settings-badge').textContent = settingsCanEdit ? 'Modifiable' : 'Lecture seule';
      $('settings-readonly').hidden = settingsCanEdit;
      ['s-legal_name','s-legal_form','s-trade_register_no','s-tax_id','s-vat_number','s-bceao_agreement_no',
       's-share_capital','s-part-sociale','s-valid-cni','s-valid-passeport','s-valid-cedeao','s-valid-consulaire_sejour','s-legal_address','s-bank_details','s-footer_note','s-vat',
       's-notify_whatsapp','s-notify_email','btn-notify-save',
       'btn-logo-pick','btn-settings-save'].forEach(function (id) {
        var e = $(id); if (e) e.disabled = !settingsCanEdit;
      });
      // Aperçu d'un document (relevé client) si un client existe — lien facultatif.
      var link = $('link-statement-demo');
      if (link) link.hidden = true;
      // Prévisualisation dynamique de la facture (rendu réel côté serveur).
      loadInvoicePreview();
      return d;
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  function row(k, v) { return '<div><span>' + esc(k) + '</span><b>' + esc(v || '—') + '</b></div>'; }
  function set(id, v) { var e = $(id); if (e) e.value = v == null ? '' : v; }
  function fmtAmount(v) { return Number(v || 0).toLocaleString('fr-FR'); }

  function renderLogo(dataUrl) {
    var prev = $('logo-prev');
    if (dataUrl) {
      prev.innerHTML = '';
      var img = document.createElement('img'); img.alt = 'Logo de l’IMF'; img.src = dataUrl;
      prev.appendChild(img);
    } else {
      var ini = ($('s-legal_name').value || (me && me.imf_name) || 'IMF').trim().slice(0, 2).toUpperCase();
      prev.innerHTML = '<span class="logo-prev__ph">' + esc(ini || '—') + '</span>';
    }
  }

  function readLogoFile(file) {
    if (!file) return;
    var ok = ['image/png','image/jpeg','image/jpg','image/webp','image/svg+xml'];
    if (ok.indexOf(file.type) < 0) { notify('Format d’image non autorisé (PNG, JPEG, WEBP ou SVG).', 'err'); return; }
    if (file.size > 400 * 1024) { notify('Le logo dépasse 400 Ko. Réduisez-le puis réessayez.', 'err'); return; }
    var r = new FileReader();
    r.onload = function () {
      logoDraft = String(r.result);
      renderLogo(logoDraft);
      $('logo-info').textContent = file.name + ' — ' + Math.round(file.size / 1024) + ' Ko (à enregistrer)';
      $('btn-logo-remove').hidden = false;
    };
    r.readAsDataURL(file);
  }

  function saveSettings() {
    if (!settingsCanEdit) return;
    var vat = $('s-vat').value.trim();
    var vatBp = null;
    if (vat !== '') {
      var n = Number(vat.replace(',', '.'));
      if (isNaN(n) || n < 0 || n > 100) { notify('Taux de TVA invalide (0 à 100).', 'err'); return; }
      vatBp = Math.round(n * 100);
    }
    var capRaw = $('s-share_capital').value.replace(/[^0-9]/g, '');
    var psEl = $('s-part-sociale');
    var psRaw = psEl ? psEl.value.replace(/[^0-9]/g, '') : '';
    var body = {
      legal_name: $('s-legal_name').value.trim(), legal_form: $('s-legal_form').value,
      trade_register_no: $('s-trade_register_no').value.trim(), tax_id: $('s-tax_id').value.trim(),
      vat_number: $('s-vat_number').value.trim(), bceao_agreement_no: $('s-bceao_agreement_no').value.trim(),
      legal_address: $('s-legal_address').value.trim(), bank_details: $('s-bank_details').value.trim(),
      footer_note: $('s-footer_note').value.trim(),
      notify_whatsapp: $('s-notify_whatsapp').value.trim(),
      notify_email: $('s-notify_email').value.trim(),
      share_capital_cents: capRaw ? Number(capRaw) * 100 : null,
      part_sociale_nominal_cents: psEl ? (psRaw ? Number(psRaw) * 100 : null) : undefined,
      id_doc_validity_months: (function () {
        var o = {};
        ['cni','passeport','cedeao','consulaire_sejour'].forEach(function (k) {
          var el = $('s-valid-' + k); if (!el) return;
          var raw = (el.value || '').replace(/[^0-9]/g, '');
          if (raw) o[k] = Number(raw);
        });
        return o;
      })(),
      vat_rate_bp: vatBp
    };
    if (logoDraft) body.logo_data_url = logoDraft;
    var btn = $('btn-settings-save'); btn.disabled = true; var old = btn.textContent; btn.textContent = 'Enregistrement…';
    api('/api/v1/org-settings', 'POST', body).then(function () {
      btn.disabled = false; btn.textContent = old;
      notify('Paramètres enregistrés. L’identité apparaîtra sur les relevés et factures.', 'ok');
      loadSettings();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = old;
      notify(e.message === 'logo_too_large' ? 'Le logo dépasse 400 Ko.' : fr(e), 'err');
    });
  }

  function saveNotify() {
    if (!settingsCanEdit) return;
    var body = {
      notify_whatsapp: $('s-notify_whatsapp').value.trim(),
      notify_email: $('s-notify_email').value.trim()
    };
    if (body.notify_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.notify_email)) {
      notify('Adresse e-mail expéditeur invalide.', 'err'); return;
    }
    var btn = $('btn-notify-save'); btn.disabled = true; var old = btn.textContent; btn.textContent = 'Enregistrement…';
    api('/api/v1/org-settings', 'POST', body).then(function () {
      btn.disabled = false; btn.textContent = old;
      notify('Canaux d’envoi enregistrés. Les codes d’accès seront transmis depuis ces coordonnées.', 'ok');
      loadSettings();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = old;
      if (!guard(e)) notify(fr(e), 'err');
    });
  }

  // Affiche le code d'accès créé + les liens d'envoi « prêts à cliquer ».
  // Message d'état d'un canal d'envoi, en langage clair.
  function sendStatusHtml(s) {
    function one(mode, canal, reason) {
      if (mode === 'sent') return '<span class="tag tag--ok">✓ ' + canal + ' : envoyé automatiquement à ' +
        esc(canal === 'E-mail' ? (s.to_email || '') : (s.to_phone || '')) + '</span>';
      if (mode === 'sent_simulated') return '<span class="tag tag--warn">' + canal + ' : simulé (mode démonstration) — vérifiez la réception, sinon utilisez le secours ci-dessous</span>';
      if (mode === 'not_configured') return '<span class="tag tag--err">✗ ' + canal +
        ' : envoi automatique indisponible — la passerelle d’envoi n’est pas configurée sur le serveur.</span>';
      if (mode === 'failed') return '<span class="tag tag--err">✗ ' + canal + ' : échec de l’envoi — ' + esc(reason || 'adresse ou passerelle à vérifier') + '</span>';
      if (mode === 'invalid_recipient') return '<span class="tag tag--err">✗ ' + canal + ' : ' + esc(reason || 'adresse manquante') + '</span>';
      if (mode === 'skipped') return '<span class="tag tag--muted">' + canal + ' : non tenté — ' + esc(reason || 'contact manquant') + '</span>';
      return '';
    }
    var st = [];
    if (s.email_status) st.push('<span class="tag ' + (s.email_status.ok ? 'tag--ok' : 'tag--warn') + '">' +
      esc(s.email_status.text || '') + '</span>');
    if (s.email_mode) st.push(one(s.email_mode, 'E-mail', s.email_reason));
    if (s.whatsapp_mode) st.push(one(s.whatsapp_mode, 'WhatsApp', s.whatsapp_reason));
    return st.filter(Boolean).join(' ');
  }

  function showSendCodeModal(d, name) {
    var s = d.send || {};
    var who = name ? esc(name) : 'l’utilisateur';
    var uid = d.id || null;
    var msg = s.message || ('Code d’accès : ' + (d.code_user || ''));
    var subj = s.subject || 'Votre code d’accès';
    var origPhone = s.to_phone || '';
    var origEmail = s.to_email || '';

    function waHref(phone) {
      var dg = String(phone || '').replace(/[^0-9]/g, '');
      return dg ? 'https://wa.me/' + dg + '?text=' + encodeURIComponent(msg) : '';
    }
    function mailHref(mail) {
      var m = String(mail || '').trim();
      return m ? 'mailto:' + encodeURIComponent(m) + '?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(msg) : '';
    }

    var senderLine = [];
    if (s.sender_email) senderLine.push('e-mail : <b>' + esc(s.sender_email) + '</b>');
    if (s.sender_whatsapp) senderLine.push('WhatsApp : <b>' + esc(s.sender_whatsapp) + '</b>');
    var senderHtml = senderLine.length
      ? '<p class="hint">Expéditeur (défini dans Paramètres IMF) — ' + senderLine.join(' · ') + '</p>'
      : '<p class="hint" style="color:var(--danger)">Aucun expéditeur n’est défini. Renseignez « E-mail expéditeur » dans Paramètres IMF : c’est cette adresse qui apparaîtra chez le destinataire.</p>';

    openModal(
      '<h3>Code d’accès prêt à envoyer</h3>' +
      '<p class="sub">Transmettez ce code à ' + who + '. Il devra créer son mot de passe à la première connexion.</p>' +
      '<div class="fld" style="text-align:center"><label>Code d’accès</label>' +
        '<div style="font-size:26px;font-weight:800;letter-spacing:3px"><code>' + esc(d.code_user || '') + '</code></div></div>' +
      '<div id="sc-status" class="hint" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">' + sendStatusHtml(s) + '</div>' +
      senderHtml +
      '<div class="fld"><label for="sc-email">E-mail du destinataire</label>' +
        '<input id="sc-email" type="email" value="' + esc(origEmail) + '" placeholder="prenom.nom@exemple.com" autocomplete="off"></div>' +
      '<div class="fld"><label for="sc-phone">Numéro WhatsApp du destinataire</label>' +
        '<input id="sc-phone" type="tel" value="' + esc(origPhone) + '" placeholder="+226 70 00 00 00" autocomplete="off"></div>' +
      '<div class="modal__nav" style="flex-wrap:wrap;gap:10px">' +
        '<button class="btn btn--primary" id="sc-send-mail">Envoyer par e-mail maintenant</button>' +
        '<button class="btn btn--dark" id="sc-send-all">Envoyer par e-mail + WhatsApp</button>' +
      '</div>' +
      '<div class="modal__nav" style="flex-wrap:wrap;gap:10px;margin-top:10px">' +
        '<a class="btn btn--ghost" id="sc-mail">Ouvrir ma messagerie</a>' +
        '<a class="btn btn--ghost" id="sc-wa" target="_blank" rel="noopener">Ouvrir WhatsApp</a>' +
        '<button class="btn btn--ghost" id="sc-close">Fermer</button></div>' +
      '<p class="hint">« Envoyer par e-mail maintenant » fait partir le message depuis le serveur, avec l’adresse expéditrice de votre IMF : c’est l’utilisateur qui le reçoit, dans sa propre boîte. Les deux boutons du bas ouvrent simplement votre messagerie / WhatsApp avec le message déjà rédigé (secours si l’envoi automatique est indisponible).</p>'
    );

    function toggle(el, href) {
      if (!el) return;
      if (href) { el.href = href; el.style.pointerEvents = ''; el.style.opacity = ''; el.removeAttribute('aria-disabled'); }
      else { el.removeAttribute('href'); el.style.pointerEvents = 'none'; el.style.opacity = '.45'; el.setAttribute('aria-disabled', 'true'); }
    }
    function refresh() {
      toggle($('sc-wa'), waHref($('sc-phone').value));
      toggle($('sc-mail'), mailHref($('sc-email').value));
    }
    refresh();
    var ph = $('sc-phone'), em = $('sc-email');
    if (ph) ph.addEventListener('input', refresh);
    if (em) em.addEventListener('input', refresh);

    // Envoi réel depuis le serveur (le contact saisi est enregistré).
    function sendNow(channel, btn) {
      if (!uid) { notify('Créez d’abord l’utilisateur.', 'err'); return; }
      var email = em ? em.value.trim() : '';
      if ((channel === 'email' || channel === 'both') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        notify('Saisissez une adresse e-mail valide pour le destinataire.', 'err'); return;
      }
      var label = btn.textContent; btn.disabled = true; btn.textContent = 'Envoi en cours…';
      api('/api/v1/users/' + uid + '/resend-code', 'POST', {
        channel: channel, email: email, phone: ph ? ph.value.trim() : ''
      }).then(function (r) {
        var ns = (r && r.send) || {};
        var stEl = $('sc-status');
        if (stEl) stEl.innerHTML = sendStatusHtml(ns);
        btn.disabled = false; btn.textContent = label;
        var okMail = ns.email_mode === 'sent' || ns.email_mode === 'sent_simulated';
        var okWa = ns.whatsapp_mode === 'sent';
        if ((channel === 'email' && okMail) || (channel === 'both' && (okMail || okWa)) || (channel === 'whatsapp' && okWa)) {
          notify('Message envoyé à ' + (ns.to_email || ns.to_phone || '') + '.', 'ok');
        } else {
          notify('Envoi automatique impossible — utilisez les boutons « Ouvrir ma messagerie » / « Ouvrir WhatsApp ».', 'err');
        }
        loadUsers();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = label;
        if (!guard(e)) notify(fr(e), 'err');
      });
    }
    var bm = $('sc-send-mail'); if (bm) bm.addEventListener('click', function () { sendNow('email', bm); });
    var ba = $('sc-send-all'); if (ba) ba.addEventListener('click', function () { sendNow('both', ba); });

    // Enregistrement best-effort du contact corrigé pour les prochains envois.
    function persist() {
      if (!uid) return;
      var body = {};
      var p = ph ? ph.value.trim() : '';
      var e = em ? em.value.trim() : '';
      if (p && p !== origPhone) body.phone = p;
      if (e && e !== origEmail) body.email = e;
      if (!Object.keys(body).length) return;
      api('/api/v1/users/' + uid, 'PATCH', body).then(function () {
        origPhone = p || origPhone; origEmail = e || origEmail;
        loadUsers();
      }).catch(function () { /* enregistrement secondaire : on n’interrompt pas l’envoi */ });
    }
    var wa = $('sc-wa'), ml = $('sc-mail');
    if (wa) wa.addEventListener('click', persist);
    if (ml) ml.addEventListener('click', persist);
    var c = $('sc-close'); if (c) c.addEventListener('click', closeModal);
  }

  function resendCode(u) {
    api('/api/v1/users/' + u.id + '/resend-code', 'POST', {}).then(function (d) {
      showSendCodeModal(d, u.full_name);
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  function removeLogo() {
    if (!settingsCanEdit) return;
    api('/api/v1/org-settings/logo', 'DELETE').then(function () {
      logoDraft = null; renderLogo(null); $('logo-info').textContent = '';
      $('btn-logo-remove').hidden = true; notify('Logo retiré.', 'ok');
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  function initSettingsHandlers() {
    var pick = $('btn-logo-pick'), file = $('logo-file');
    if (!pick || !file) return;
    pick.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () { readLogoFile(file.files && file.files[0]); file.value = ''; });
    $('btn-logo-remove').addEventListener('click', removeLogo);
    $('btn-settings-save').addEventListener('click', saveSettings);
    var bn = $('btn-notify-save'); if (bn) bn.addEventListener('click', saveNotify);
    var bt = $('btn-notify-test'); if (bt) bt.addEventListener('click', testNotify);
    var ln = $('s-legal_name'); if (ln) ln.addEventListener('input', function () { if (!logoDraft) renderLogo(null); });
    // Prévisualisation : boutons pilotés par addEventListener (aucun on* inline).
    var ref = $('btn-preview-refresh'); if (ref) ref.addEventListener('click', function () { loadInvoicePreview(true); });
    var pr = $('btn-preview-print'); if (pr) pr.addEventListener('click', openInvoicePreview);
  }

  /* --- Prévisualisation dynamique de la facture (iframe de même origine) ---
     L'aperçu est un document HTML rendu par le serveur, intégré dans un cadre
     isolé (sandbox). La politique de sécurité de cette réponse autorise son
     style propre et le cadrage de même origine, mais jamais de script. */
  function loadInvoicePreview(userTriggered) {
    var f = $('invoice-preview');
    if (!f) return;

    // jeton propre pour forcer le rechargement (évite le cache du navigateur)
    f.src = '/api/v1/org-settings/preview?_=' + Date.now();
    if (userTriggered) notify('Aperçu actualisé.', 'ok');
  }

  function openInvoicePreview() {
    var w = window.open('/api/v1/org-settings/preview', '_blank', 'noopener');
    if (!w) notify('Autorisez les fenêtres surgissantes pour ouvrir la facture.', 'err');
  }

  // ----- Suivi des envois de codes -----
  function modeBadge(m) {
    var map = { sent: ['Envoyé', 'tag--ok'], manual: ['Lien manuel', 'tag--warn'],
      failed: ['Échec', 'tag--err'], skipped: ['Non tenté', 'tag--muted'],
      not_configured: ['Passerelle absente', 'tag--err'], invalid_recipient: ['Adresse invalide', 'tag--err'],
      dev: ['Lien manuel', 'tag--warn'], manual: ['Lien manuel', 'tag--warn'] };
    var v = map[m] || [m || '—', 'tag--muted'];
    return '<span class="tag ' + v[1] + '">' + esc(v[0]) + '</span>';
  }
  function fmtWhen(s) {
    if (!s) return '—';
    try { return new Date(s).toLocaleString('fr-FR'); } catch (e) { return esc(s); }
  }
  function loadDispatches() {
    return api('/api/v1/code-dispatches').then(function (d) {
      var s = d.stats || {};
      $('dispatch-kpis').innerHTML =
        kpi(s.total || 0, 'Envois au total', true) +
        kpi(s.creation || 0, 'À la création') +
        kpi(s.resend || 0, 'Renvois') +
        kpi(s.whatsapp_sent || 0, 'WhatsApp envoyés') +
        kpi(s.email_sent || 0, 'E-mails envoyés');
      var rows = d.dispatches || [];
      if (!rows.length) { $('dispatches-table').innerHTML = '<div class="empty">Aucun code envoyé pour le moment.</div>'; return; }
      $('dispatches-table').innerHTML =
        '<table class="tbl"><thead><tr><th>Date</th><th>Destinataire</th><th>Code</th><th>Type</th><th>WhatsApp</th><th>E-mail</th><th>Émetteur</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + fmtWhen(r.created_at) + '</td>' +
            '<td><b>' + esc(r.recipient_name || '—') + '</b><br><small style="color:var(--muted)">' +
              esc(r.to_phone || '') + (r.to_phone && r.to_email ? ' · ' : '') + esc(r.to_email || '') + '</small></td>' +
            '<td><code>' + esc(r.code_user || '—') + '</code></td>' +
            '<td>' + (r.channel === 'resend' ? 'Renvoi' : 'Création') + '</td>' +
            '<td>' + modeBadge(r.whatsapp_mode) + '</td>' +
            '<td>' + modeBadge(r.email_mode) + '</td>' +
            '<td>' + esc(r.dispatched_by_name || '—') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  // ----- Gestion des habilitations (éditable) -----
  var accessCatalog = null; // { permissions, positions, position_permissions, final_validator_key }

  function loadAccessMatrix() {
    return api('/api/v1/access/catalog').then(function (m) {
      accessCatalog = m;
      renderAccessMatrix();
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  function kindBadge(k) {
    var map = { lecture: ['R', 'Lecture', '#2563eb'], ecriture: ['É', 'Écriture', '#059669'],
      validation: ['V', 'Validation', '#b45309'] };
    var d = map[k] || map.ecriture;
    return '<span class="tag" title="' + d[1] + '" style="background:' + d[2] +
      ';color:#fff;font-size:10px;padding:0 5px;border-radius:3px">' + d[0] + '</span>';
  }

  function renderAccessMatrix() {
    var m = accessCatalog || {}, perms = m.permissions || [], positions = m.positions || [];
    var byPos = m.position_permissions || {}, finalKey = m.final_validator_key || 'credit.validate_final';
    if (!positions.length) { $('access-matrix').innerHTML = '<div class="empty">Aucun poste.</div>'; return; }
    var head = '<tr><th style="min-width:240px;position:sticky;left:0;background:var(--card)">Poste / profil</th>' +
      perms.map(function (p) {
        var isFinal = p.key === finalKey || p.permission_key === finalKey;
        return '<th style="text-align:center;min-width:92px;vertical-align:bottom">' +
          '<span style="font-size:11px;line-height:1.25;display:inline-block;max-width:120px">' +
          kindBadge(p.access_kind) + ' ' + esc(p.label) + (p.custom ? ' <span class="tag">custom</span>' : '') +
          (isFinal ? ' <span class="tag tag--ok">finale</span>' : '') +
          (p.is_system ? '' : ' <a href="#" data-delperm="' + esc(p.permission_key) + '" style="color:var(--danger,#d33);text-decoration:none" title="Supprimer">\u00d7</a>') +
          '</span></th>';
      }).join('') + '</tr>';
    var body = positions.map(function (pos) {
      var row = byPos[pos.code] || {};
      return '<tr><td style="position:sticky;left:0;background:var(--card)">' +
        '<b>' + esc(pos.label) + '</b>' + (pos.custom ? ' <span class="tag">custom</span>' : '') +
        '<br><span class="hint" style="font-size:11px">' + esc(pos.dept_code || '') +
        (pos.service_code ? ' \u00b7 ' + esc(pos.service_code) : '') + '</span></td>' +
        perms.map(function (p) {
          var key = p.permission_key, on = !!row[key];
          return '<td style="text-align:center"><input type="checkbox" ' + (on ? 'checked' : '') +
            ' data-pos="' + esc(pos.code) + '" data-perm="' + esc(key) + '"></td>';
        }).join('') + '</tr>';
    }).join('');
    $('access-matrix').innerHTML =
      '<p class="hint" style="margin-bottom:12px">Cochez une case pour accorder l\u2019habilitation par d\u00e9faut au poste. ' +
      'Chaque habilitation porte sa nature : ' + kindBadge('lecture') + ' lecture, ' + kindBadge('ecriture') +
      ' \u00e9criture, ' + kindBadge('validation') + ' validation. ' +
      'La case <span class="tag tag--ok">finale</span> r\u00e9affecte l\u2019\u00e9cran de validation finale des cr\u00e9dits. ' +
      'Les modifications s\u2019appliquent \u00e0 votre IMF uniquement.</p>' +
      '<div style="overflow:auto;max-height:70vh"><table class="tbl"><thead>' + head +
      '</thead><tbody>' + body + '</tbody></table></div>';
    // Toggles habilitation par poste.
    $('access-matrix').querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var code = cb.dataset.pos, key = cb.dataset.perm, allowed = cb.checked;
        cb.disabled = true;
        api('/api/v1/access/positions/' + encodeURIComponent(code) + '/permission', 'PATCH',
          { permission_key: key, allowed: allowed })
          .then(function () {
            if (!byPos[code]) byPos[code] = {};
            byPos[code][key] = allowed;
            notify('Habilitation mise \u00e0 jour.', 'ok');
          })
          .catch(function (e) { cb.checked = !allowed; if (!guard(e)) notify(fr(e), 'err'); })
          .then(function () { cb.disabled = false; });
      });
    });
    // Suppression d'une habilitation custom.
    $('access-matrix').querySelectorAll('a[data-delperm]').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        var key = a.dataset.delperm;
        if (!window.confirm('Supprimer d\u00e9finitivement cette habilitation personnalis\u00e9e ?')) return;
        api('/api/v1/access/permissions/' + encodeURIComponent(key), 'DELETE')
          .then(function () { notify('Habilitation supprim\u00e9e.', 'ok'); loadAccessMatrix(); })
          .catch(function (e) { if (!guard(e)) notify(e.message === 'system_permission'
            ? 'Habilitation du socle : suppression impossible.' : fr(e), 'err'); });
      });
    });
  }

  // Modale : créer une habilitation supplémentaire.
  function openNewPermModal() {
    openModal(
      '<h3>Nouvelle habilitation</h3><p class="sub">Habilitation suppl\u00e9mentaire propre \u00e0 votre IMF.</p>' +
      '<div class="fld"><label for="np-label">Libell\u00e9</label><input id="np-label" placeholder="Ex. Export comptable"></div>' +
      '<div class="fld"><label for="np-cat">Cat\u00e9gorie</label><input id="np-cat" placeholder="Habilitations suppl\u00e9mentaires"></div>' +
      '<div class="fld"><label for="np-kind">Nature de l\u2019acc\u00e8s</label><select id="np-kind">' +
      '<option value="lecture">Lecture (R)</option>' +
      '<option value="ecriture" selected>\u00c9criture (\u00c9)</option>' +
      '<option value="validation">Validation (V)</option></select></div>' +
      '<div class="fld"><label for="np-key">Cl\u00e9 technique (optionnel)</label><input id="np-key" placeholder="module.action"></div>' +
      '<p class="hint">La cl\u00e9 est g\u00e9n\u00e9r\u00e9e automatiquement depuis le libell\u00e9 si laiss\u00e9e vide.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="np-cancel" type="button">Annuler</button>' +
      '<button class="btn btn--primary" id="np-save" type="button">Cr\u00e9er</button></div>');
    $('np-cancel').addEventListener('click', closeModal);
    $('np-save').addEventListener('click', function () {
      var label = $('np-label').value.trim();
      if (!label) { notify('Indiquez un libell\u00e9.', 'err'); return; }
      var body = { label: label, category: $('np-cat').value.trim() || undefined,
        access_kind: ($('np-kind') && $('np-kind').value) || 'ecriture',
        permission_key: $('np-key').value.trim() || undefined };
      $('np-save').disabled = true;
      api('/api/v1/access/permissions', 'POST', body)
        .then(function () { closeModal(); notify('Habilitation cr\u00e9\u00e9e.', 'ok'); loadAccessMatrix(); })
        .catch(function (e) { $('np-save').disabled = false;
          if (!guard(e)) notify(e.message === 'duplicate_permission' ? 'Cette habilitation existe d\u00e9j\u00e0.'
            : e.message === 'invalid_key' ? 'Cl\u00e9 invalide (format module.action).' : fr(e), 'err'); });
    });
  }

  // Modale : créer un poste / profil.
  function openNewPositionModal() {
    var perms = (accessCatalog && accessCatalog.permissions) || [];
    var depts = {};
    (accessCatalog && accessCatalog.positions || []).forEach(function (p) { if (p.dept_code) depts[p.dept_code] = true; });
    var deptOpts = Object.keys(depts).sort().map(function (d) {
      return '<option value="' + esc(d) + '">' + esc(d) + '</option>'; }).join('');
    var permChecks = perms.map(function (p) {
      return '<label style="display:flex;align-items:center;gap:8px;padding:4px 0">' +
        '<input type="checkbox" value="' + esc(p.permission_key) + '" class="npos-perm">' +
        '<span>' + esc(p.label) + '</span></label>';
    }).join('');
    openModal(
      '<h3>Nouveau poste / profil</h3><p class="sub">Cr\u00e9ez un poste propre \u00e0 votre IMF et choisissez ses habilitations par d\u00e9faut.</p>' +
      '<div class="fld"><label for="nx-label">Intitul\u00e9 du poste</label><input id="nx-label" placeholder="Ex. Charg\u00e9 de recouvrement senior"></div>' +
      '<div class="fld"><label for="nx-dept">D\u00e9partement</label><select id="nx-dept">' + deptOpts + '</select></div>' +
      '<div class="fld"><label for="nx-service">Service (optionnel)</label><input id="nx-service" placeholder="Code service"></div>' +
      '<div class="fld"><label>Habilitations par d\u00e9faut</label>' +
      '<div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px">' +
      (permChecks || '<span class="hint">Aucune habilitation disponible.</span>') + '</div></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="nx-cancel" type="button">Annuler</button>' +
      '<button class="btn btn--primary" id="nx-save" type="button">Cr\u00e9er le poste</button></div>');
    $('nx-cancel').addEventListener('click', closeModal);
    $('nx-save').addEventListener('click', function () {
      var label = $('nx-label').value.trim(), dept = $('nx-dept').value;
      if (!label) { notify('Indiquez l\u2019intitul\u00e9 du poste.', 'err'); return; }
      if (!dept) { notify('Choisissez un d\u00e9partement.', 'err'); return; }
      var keys = [];
      $('modal-root').querySelectorAll('.npos-perm:checked').forEach(function (cb) { keys.push(cb.value); });
      var body = { label: label, dept_code: dept,
        service_code: $('nx-service').value.trim() || undefined, permission_keys: keys };
      $('nx-save').disabled = true;
      api('/api/v1/access/positions', 'POST', body)
        .then(function () { closeModal(); notify('Poste cr\u00e9\u00e9.', 'ok'); loadAccessMatrix(); })
        .catch(function (e) { $('nx-save').disabled = false;
          if (!guard(e)) notify(e.message === 'invalid_dept' ? 'D\u00e9partement invalide.' : fr(e), 'err'); });
    });
  }

  // ----- Validation finale des crédits -----
  function loadCreditsQueue() {
    return api('/api/v1/credits/final-queue').then(function (d) {
      renderCreditsQueue(d.queue || [], d.labels || {});
    }).catch(function (e) {
      if (guard(e)) return;
      if (e.message === 'forbidden' || e.message === 'missing_permission')
        $('credits-queue').innerHTML = '<div class="empty">Vous n\u2019\u00eates pas habilit\u00e9 \u00e0 la validation finale des cr\u00e9dits.</div>';
      else notify(fr(e), 'err');
    });
  }

  function renderCreditsQueue(queue, labels) {
    if (!queue.length) { $('credits-queue').innerHTML = '<div class="empty">Aucun dossier en attente de validation finale.</div>'; return; }
    var head = '<tr><th>R\u00e9f\u00e9rence</th><th>Client</th><th>Montant demand\u00e9</th><th>Dur\u00e9e</th>' +
      '<th>Origine</th><th>Statut</th><th>Agent</th><th style="text-align:right">Action</th></tr>';
    var body = queue.map(function (c) {
      var amt = c.amount_cents != null ? fmtAmount(c.amount_cents / 100) + ' FCFA' : '\u2014';
      return '<tr><td><b>' + esc(c.reference || '\u2014') + '</b></td>' +
        '<td>' + esc(c.client_name || '\u2014') + '<br><span class="hint" style="font-size:11px">' + esc(c.code_client || '') + '</span></td>' +
        '<td>' + amt + '</td>' +
        '<td>' + (c.duration_months ? esc(c.duration_months) + ' mois' : '\u2014') + '</td>' +
        '<td>' + esc(c.origin || '\u2014') + '</td>' +
        '<td><span class="tag">' + esc(labels[c.status] || c.status) + '</span></td>' +
        '<td>' + esc(c.officer_name || c.collectrice_name || '\u2014') + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
        '<button class="btn btn--sm" data-cv-approve="' + esc(c.id) + '">Octroyer</button> ' +
        '<button class="btn btn--sm btn--ghost" data-cv-reject="' + esc(c.id) + '">Rejeter</button></td></tr>';
    }).join('');
    $('credits-queue').innerHTML =
      '<p class="hint" style="margin-bottom:12px">' + queue.length + ' dossier(s) en attente de d\u00e9cision finale.</p>' +
      '<div style="overflow-x:auto"><table class="tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
    $('credits-queue').querySelectorAll('[data-cv-approve]').forEach(function (b) {
      b.addEventListener('click', function () { openFinalValidateModal(b.dataset.cvApprove, 'approuve'); });
    });
    $('credits-queue').querySelectorAll('[data-cv-reject]').forEach(function (b) {
      b.addEventListener('click', function () { openFinalValidateModal(b.dataset.cvReject, 'rejete'); });
    });
  }

  function openFinalValidateModal(id, decision) {
    var isApprove = decision === 'approuve';
    openModal(
      '<h3>' + (isApprove ? 'Octroi d\u00e9finitif du cr\u00e9dit' : 'Rejet d\u00e9finitif du dossier') + '</h3>' +
      '<p class="sub">D\u00e9cision finale \u2014 suivie en temps r\u00e9el par la Collectrice, le Superviseur et le Client.</p>' +
      (isApprove
        ? '<div class="fld"><label for="fv-amount">Montant accord\u00e9 (FCFA, optionnel)</label><input id="fv-amount" inputmode="numeric" placeholder="Laisser vide = montant demand\u00e9"></div>'
        : '') +
      '<div class="fld"><label for="fv-note">' + (isApprove ? 'Note (optionnel)' : 'Motif du rejet') + '</label>' +
      '<textarea id="fv-note" rows="3" placeholder="' + (isApprove ? 'Observations\u2026' : 'Pr\u00e9cisez le motif\u2026') + '"></textarea></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="fv-cancel" type="button">Annuler</button>' +
      '<button class="btn btn--primary" id="fv-save" type="button">' +
      (isApprove ? 'Confirmer l\u2019octroi' : 'Confirmer le rejet') + '</button></div>');
    $('fv-cancel').addEventListener('click', closeModal);
    $('fv-save').addEventListener('click', function () {
      var body = { decision: decision, note: $('fv-note').value.trim() || undefined };
      if (isApprove) { var raw = ($('fv-amount') ? $('fv-amount').value : '').replace(/[^0-9]/g, '');
        if (raw) body.approved_amount_cents = Number(raw) * 100; }
      else if (!body.note) { notify('Indiquez le motif du rejet.', 'err'); return; }
      $('fv-save').disabled = true;
      api('/api/v1/credits/' + encodeURIComponent(id) + '/final-validate', 'POST', body)
        .then(function () { closeModal();
          notify(isApprove ? 'Cr\u00e9dit octroy\u00e9.' : 'Dossier rejet\u00e9.', 'ok'); loadCreditsQueue(); })
        .catch(function (e) { $('fv-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  // ----- Démarrage -----
  // Objectif : un tableau de bord AFFICHÉ TOUT DE SUITE, puis complété.
  // 1) Rendu immédiat du squelette (plus d'attente devant un écran vide).
  // 2) /me (indispensable) puis unités + utilisateurs EN PARALLÈLE.
  // 3) Modules secondaires (essai) en arrière-plan, jamais bloquants.
  var BOOT = { units: false, users: false };

  function bootProgress() {
    var box = $('dash-kpis');
    if (!box) return;
    var txt = [];
    if (!BOOT.units) txt.push('organisation');
    if (!BOOT.users) txt.push('personnel');
    if (txt.length) box.setAttribute('data-loading', txt.join(' · '));
    else box.removeAttribute('data-loading');
  }

  function setupMe(d) {
    me = d || { user: {}, permissions: [] };
    if (me.password_change_required) { window.location.assign('/login.html'); return false; }
    var u = me.user || {};
    var nU = $('u-name'); if (nU) nU.textContent = u.full_name || '—';
    var nC = $('u-code'); if (nC) nC.textContent = (u.code_user || '—') + (me.imf_code ? ' · ' + me.imf_code : '');
    // Paramètres IMF : accessible à l'admin, à la direction et au PCA.
    var canSee = ['admin_imf', 'direction', 'superadmin', 'pca_admin'].indexOf(effRole(u)) >= 0;
    var navS = $('nav-settings'); if (navS) navS.hidden = !canSee;
    var navD = $('nav-dispatches'); if (navD) navD.hidden = !canSee;
    var navP = $('nav-profiles'); if (navP) navP.hidden = !canSee;
    // Validation finale des crédits : réservée aux postes habilités.
    var canFinal = !!me.can_validate_credit_final || canSee;
    var navC = $('nav-credits'); if (navC) navC.hidden = !canFinal;
    // Menus opérationnels selon les habilitations du poste.
    try { setupBankingNav(); } catch (e) {}
    try { initSettingsHandlers(); } catch (e) {}
    var bnP = $('btn-new-perm'); if (bnP) bnP.addEventListener('click', openNewPermModal);
    var bnPos = $('btn-new-position'); if (bnPos) bnPos.addEventListener('click', openNewPositionModal);
    var bnCr = $('btn-credits-refresh'); if (bnCr) bnCr.addEventListener('click', loadCreditsQueue);
    return true;
  }

  function boot() {
    renderDash();
    bootProgress();
    api('/api/v1/auth/me').then(function (d) {
      if (!setupMe(d)) return null;
      // Catalogue des postes : en tâche de fond, sans retarder l'affichage.
      loadPositions().catch(function () {});
      renderDash();
      // Données du tableau de bord en PARALLÈLE (avant : l'une après l'autre).
      var pUnits = loadUnits(true).then(function () { BOOT.units = true; })
        .catch(function (e) { BOOT.units = true; if (!guard(e)) notify(fr(e), 'err'); });
      var pUsers = loadUsers(true).then(function () { BOOT.users = true; })
        .catch(function (e) { BOOT.users = true; if (!guard(e)) notify(fr(e), 'err'); });
      return Promise.all([pUnits, pUsers]);
    }).then(function () {
      renderDash(); bootProgress(); renderSession();
      // Bandeau d'essai : jamais bloquant pour l'affichage.
      loadTrial();
      var pending = false;
      try { pending = sessionStorage.getItem('teebo_2fa_enroll') === '1'; } catch (e) {}
      if (pending) {
        try { sessionStorage.removeItem('teebo_2fa_enroll'); } catch (e) {}
        switchView('security');
        notify('Activation de la double authentification requise pour continuer.', 'info');
        return;
      }
      var wanted = '';
      try { wanted = String(location.hash || '').replace(/^#/, ''); } catch (e) {}
      switchView(VIEWS.indexOf(wanted) >= 0 ? wanted : 'dash');
    }).catch(function (e) {
      if (guard(e)) return;
      // Session absente ou expiree : message clair + bouton, SANS rechargement
      // automatique (avant : la page se rechargeait en boucle).
      if (sessionGone(e)) { endSessionQuietly(); return; }
      notify(fr(e), 'err');
      var k = $('dash-kpis');
      if (k) dashCardState(k, fr(e), 'Réessayer', function () { boot(); });
    });
  }
  boot();

  // ----- Essai & échéances : bandeau J25 + blocage J31 -----
  function loadTrial() {
    return api('/api/v1/subscription/status').then(function (s) {
      if (s && s.banner) {
        var b = $('trial-banner'); b.className = 'alert alert--warn';
        b.innerHTML = '⏳ ' + esc(s.banner.message) + ' <a href="/essai" style="font-weight:700;text-decoration:underline">Choisir ma formule</a>';
        b.hidden = false;
      }
      if (s && s.locked) showBlocked(s);
    }).catch(function () { /* état d'essai indisponible : on n'empêche pas l'accès */ });
  }
  function showBlocked(s) {
    document.body.innerHTML = '';
    var d = document.createElement('div');
    d.style.cssText = 'min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#0b0c26;color:#fff;text-align:center;font-family:Segoe UI,system-ui,Arial';
    var c = s && s.contact ? s.contact : { whatsapp: '+22650321432', email: 'hello@teebo.africa' };
    d.innerHTML = '<div style="max-width:460px">' +
      '<div style="width:74px;height:74px;border-radius:50%;background:rgba(216,245,0,.15);color:#d8f500;display:flex;align-items:center;justify-content:center;font-size:34px;margin:0 auto 20px">⏳</div>' +
      '<h1 style="font-size:24px;letter-spacing:-.6px;margin-bottom:12px">Votre essai gratuit est terminé</h1>' +
      '<p style="color:#b9bbd4;font-size:15px;margin-bottom:8px">Après 30 jours d\'essai (désactivation au 31ᵉ jour), l\'application est mise en pause.</p>' +
      '<p style="color:#b9bbd4;font-size:15px;margin-bottom:22px">Contactez teebo pour activer votre formule et rétablir immédiatement l\'accès.</p>' +
      '<p style="font-size:13px;color:#9fa2c0;margin-bottom:22px">Vos données sont conservées.</p>' +
      '<a href="https://wa.me/' + String(c.whatsapp).replace(/[^0-9]/g, '') + '" style="display:inline-block;background:#d8f500;color:#0b0c26;font-weight:700;padding:13px 22px;border-radius:11px;text-decoration:none;margin:4px">WhatsApp ' + esc(c.whatsapp) + '</a>' +
      '<a href="mailto:' + esc(c.email) + '" style="display:inline-block;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3);font-weight:700;padding:13px 22px;border-radius:11px;text-decoration:none;margin:4px">' + esc(c.email) + '</a></div>';
    document.body.appendChild(d);
  }

  /* ===== VAGUE 15 : modules opérationnels (clients, caisse, coffre, compta, recouvrement, audit) ===== */
  function has(p) {
    if (!me) return false;
    if (['admin_imf', 'direction', 'superadmin', 'pca_admin'].indexOf(effRole(me.user)) >= 0) return true;
    return Array.isArray(me.permissions) && me.permissions.indexOf(p) >= 0;
  }
  function digits(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, ''); }
  function cents(fcfaStr) { var n = digits(fcfaStr); return n ? Number(n) * 100 : 0; }
  function money(c) { return fmtAmount((Number(c || 0)) / 100) + ' FCFA'; }
  function dt(s) { return s ? new Date(s).toLocaleString('fr-FR') : '\u2014'; }
  function setupBankingNav() {
    var map = {
      'nav-clients': has('clients.manage'),
      'nav-caisse': has('operations.read') || has('cash.approve'),
      'nav-coffre': has('accounts.manage'),
      'nav-compta': has('accounts.manage'),
      'nav-recouvrement': has('credit.recovery'),
      'nav-audit': has('audit.read')
    };
    Object.keys(map).forEach(function (id) { var n = $(id); if (n) n.hidden = !map[id]; });
    var b;
    b = $('btn-clients-refresh'); if (b) b.addEventListener('click', loadClients);
    b = $('btn-client-new'); if (b) b.addEventListener('click', openClientCreate);
    b = $('btn-overrun-new'); if (b) b.addEventListener('click', openOverrunModal);
    b = $('btn-closing-new'); if (b) b.addEventListener('click', openClosingModal);
    b = $('btn-vault-new'); if (b) b.addEventListener('click', openVaultModal);
    b = $('btn-entry-new'); if (b) b.addEventListener('click', openEntryModal);
    b = $('btn-period-close'); if (b) b.addEventListener('click', closePeriod);
    b = $('btn-arrears-refresh'); if (b) b.addEventListener('click', loadArrears);
    b = $('btn-audit-refresh'); if (b) b.addEventListener('click', loadAudit);
    var mp = $('compta-period'); if (mp) { mp.value = new Date().toISOString().slice(0, 7); mp.addEventListener('change', loadCompta); }
  }
  function forbidden(boxId, msg) {
    $(boxId).innerHTML = '<div class="empty">' + esc(msg) + '</div>';
  }

  /* ----- CLIENTS : liste + modifier la fiche ----- */
  function loadClients() {
    return api('/api/v1/clients').then(function (d) { renderClients(d.clients || []); })
      .catch(function (e) { if (guard(e)) return;
        if (e.message === 'forbidden' || e.message === 'missing_permission') forbidden('clients-table', 'Vous n\u2019\u00eates pas habilit\u00e9 \u00e0 la gestion des clients.');
        else notify(fr(e), 'err'); });
  }
  function renderClients(list) {
    if (!list.length) { $('clients-table').innerHTML = '<div class="empty">Aucun client enregistr\u00e9.</div>'; return; }
    var head = '<tr><th>Code</th><th>Nom complet</th><th>T\u00e9l\u00e9phone</th><th>Pi\u00e8ce</th><th>Conformit\u00e9</th><th>Solde</th><th style="text-align:right">Actions</th></tr>';
    var body = list.map(function (c) {
      var isPart = c.client_category === 'particulier';
      var hasAcc = !!c.code_account;
      var confBadge = '\u2014';
      if (isPart) {
        var cs = c.conformity_status || 'en_attente';
        var col = cs === 'conforme' ? '#1a7f37' : (cs === 'non_conforme' ? '#c0392b' : '#8a6d0b');
        var lbl = cs === 'conforme' ? 'Conforme' : (cs === 'non_conforme' ? 'Non conforme' : 'En attente');
        confBadge = '<span style="color:' + col + ';font-weight:600">' + lbl + '</span>';
      }
      var act = '<button class="btn btn--sm" data-cl-edit="' + esc(c.id) + '">Modifier</button>';
      if (isPart) {
        act += ' <button class="btn btn--sm" data-cl-fiche="' + esc(c.id) + '">Fiche PDF</button>'
          + ' <button class="btn btn--sm" data-cl-sign="' + esc(c.id) + '">Signatures</button>'
          + ' <button class="btn btn--sm" data-cl-scan="' + esc(c.id) + '">Scanner &amp; confronter</button>';
      }
      if (hasAcc) {
        act += ' <span class="hint" style="margin-left:6px">Compte : <b>' + esc(c.code_account) + '</b></span>';
      } else {
        act += ' <button class="btn btn--sm btn--primary" data-cl-open="' + esc(c.id) + '">Ouvrir le compte</button>';
      }
      return '<tr><td><b>' + esc(c.code_client || '\u2014') + '</b></td>' +
        '<td>' + esc(c.full_name || '\u2014') + '</td>' +
        '<td>' + esc(c.phone || '\u2014') + '</td>' +
        '<td>' + esc(c.id_number || '\u2014') + '</td>' +
        '<td>' + confBadge + '</td>' +
        '<td>' + (c.balance_cents != null ? money(c.balance_cents) : '\u2014') + '</td>' +
        '<td style="text-align:right">' + act + '</td></tr>';
    }).join('');
    $('clients-table').innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
    var byId = function (id) { return list.find(function (x) { return x.id === id; }); };
    $('clients-table').querySelectorAll('[data-cl-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openClientEdit(byId(b.dataset.clEdit)); });
    });
    $('clients-table').querySelectorAll('[data-cl-fiche]').forEach(function (b) {
      b.addEventListener('click', function () { window.open('/api/v1/clients/' + encodeURIComponent(b.dataset.clFiche) + '/fiche', '_blank'); });
    });
    $('clients-table').querySelectorAll('[data-cl-sign]').forEach(function (b) {
      b.addEventListener('click', function () { openSignatures(byId(b.dataset.clSign)); });
    });
    $('clients-table').querySelectorAll('[data-cl-scan]').forEach(function (b) {
      b.addEventListener('click', function () { openConformity(byId(b.dataset.clScan)); });
    });
    $('clients-table').querySelectorAll('[data-cl-open]').forEach(function (b) {
      b.addEventListener('click', function () { openAccountFor(byId(b.dataset.clOpen)); });
    });
  }
  function openClientEdit(c) {
    if (!c) return;
    openModal(
      '<h3>Modifier la fiche client</h3>' +
      '<p class="sub">' + esc(c.code_client || '') + '</p>' +
      '<div class="fld"><label for="cl-name">Nom complet</label><input id="cl-name" value="' + esc(c.full_name || '') + '"></div>' +
      '<div class="fld"><label for="cl-phone">T\u00e9l\u00e9phone</label><input id="cl-phone" value="' + esc(c.phone || '') + '"></div>' +
      '<div class="fld"><label for="cl-id">N\u00b0 de pi\u00e8ce</label><input id="cl-id" value="' + esc(c.id_number || '') + '"></div>' +
      '<div class="fld"><label for="cl-addr">Adresse</label><input id="cl-addr" value="' + esc(c.address || '') + '"></div>' +
      '<div class="fld"><label for="cl-birth">Date de naissance</label><input id="cl-birth" type="date" value="' + esc(c.birth_date ? String(c.birth_date).slice(0, 10) : '') + '"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="cl-cancel" type="button">Annuler</button>' +
      '<button class="btn btn--primary" id="cl-save" type="button">Enregistrer</button></div>');
    $('cl-cancel').addEventListener('click', closeModal);
    $('cl-save').addEventListener('click', function () {
      var body = { full_name: $('cl-name').value.trim(), phone: $('cl-phone').value.trim(),
        id_number: $('cl-id').value.trim(), address: $('cl-addr').value.trim(),
        birth_date: $('cl-birth').value || null };
      if (!body.full_name) { notify('Le nom complet est obligatoire.', 'err'); return; }
      $('cl-save').disabled = true;
      api('/api/v1/clients/' + encodeURIComponent(c.id), 'PATCH', body)
        .then(function () { closeModal(); notify('Fiche client mise \u00e0 jour.', 'ok'); loadClients(); })
        .catch(function (e) { $('cl-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  /* ----- Ouverture de compte (verrou de conformité côté serveur) ----- */
  function openAccountFor(c) {
    if (!c) return;
    if (!confirm('Ouvrir le compte de ' + (c.full_name || c.code_client) + ' ?')) return;
    api('/api/v1/clients/' + encodeURIComponent(c.id) + '/open-account', 'POST', {})
      .then(function (r) { notify((r && r.note) || 'Compte ouvert.', 'ok'); loadClients(); })
      .catch(function (e) {
        if (guard(e)) return;
        if (e && e.message === 'conformite_requise') {
          notify(e.serverMessage || 'Confrontez d’abord les pièces scannées avant d’ouvrir le compte.', 'err');
          openConformity(c);
          return;
        }
        if (e && e.message === 'account_exists') { notify(e.serverMessage || 'Ce client possède déjà un compte actif.', 'err'); loadClients(); return; }
        notify(e && e.serverMessage ? e.serverMessage : fr(e), 'err');
      });
  }

  /* ----- Scanner une pièce puis confronter à la saisie (conformité) ----- */
  function openConformity(c) {
    if (!c) return;
    openModal('<h3>Scanner &amp; confronter — ' + esc(c.full_name || '') + '</h3><div class="empty">Chargement…</div>');
    api('/api/v1/clients/' + encodeURIComponent(c.id) + '/conformity').then(function (d) {
      var fields = d.fields || [];
      var rows = fields.map(function (f) {
        var last = (d.checks || []).find(function (x) { return x.field_key === f.key; });
        var prev = last ? esc(last.scanned || '') : '';
        return '<tr><td style="padding:4px 6px">' + esc(f.label) + '</td>' +
          '<td style="padding:4px 6px"><b>' + esc(f.expected || '—') + '</b></td>' +
          '<td style="padding:4px 6px"><input data-conf-key="' + esc(f.key) + '" data-conf-kind="' + esc(f.kind) + '" value="' + prev + '" placeholder="valeur lue sur le document" style="width:100%"></td></tr>';
      }).join('');
      openModal(
        '<h3>Scanner &amp; confronter — ' + esc(c.full_name || '') + '</h3>' +
        '<p class="sub">Scannez chaque pièce reçue, reportez les valeurs lues puis lancez la confrontation. Les informations non conformes devront être corrigées avant l’ouverture du compte.</p>' +
        '<div class="fld"><label for="conf-scan">Scan de la pièce (image, facultatif)</label><input id="conf-scan" type="file" accept="image/*"></div>' +
        '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th style="text-align:left">Champ</th><th style="text-align:left">Saisi</th><th style="text-align:left">Lu sur le scan</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div id="conf-result" style="margin-top:10px"></div>' +
        '<div class="modal__nav"><button class="btn btn--ghost" id="conf-cancel" type="button">Fermer</button>' +
        '<button class="btn btn--primary" id="conf-run" type="button">Confronter</button></div>');
      $('conf-cancel').addEventListener('click', function () { closeModal(); loadClients(); });
      $('conf-run').addEventListener('click', function () { runConfrontation(c); });
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  function runConfrontation(c) {
    var scanned = {};
    document.querySelectorAll('[data-conf-key]').forEach(function (el) {
      var v = el.value.trim();
      if (v) scanned[el.dataset.confKey] = v;
    });
    if (!Object.keys(scanned).length) { notify('Renseignez au moins une valeur lue sur le document scanné.', 'err'); return; }
    var fileEl = $('conf-scan');
    var file = fileEl && fileEl.files && fileEl.files[0] ? fileEl.files[0] : null;
    $('conf-run').disabled = true;
    var pre = file ? readFileAsDataUrl(file).then(function (durl) {
      return api('/api/v1/clients/' + encodeURIComponent(c.id) + '/scans', 'POST',
        { image_data_url: durl, doc_type: 'piece_identite', extracted: scanned }).catch(function () { return null; });
    }) : Promise.resolve(null);
    pre.then(function () {
      return api('/api/v1/clients/' + encodeURIComponent(c.id) + '/conformity', 'POST', { scanned: scanned });
    }).then(function (r) {
      $('conf-run').disabled = false;
      var ok = r && r.conformity_status === 'conforme';
      var html = '<div style="padding:8px 10px;border-radius:8px;background:' + (ok ? '#e7f6ec' : '#fdecec') + ';color:' + (ok ? '#1a7f37' : '#c0392b') + '">' + esc(r.note || '') + '</div>';
      $('conf-result').innerHTML = html;
      notify(r.note || 'Confrontation enregistrée.', ok ? 'ok' : 'err');
    }).catch(function (e) { $('conf-run').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr2 = new FileReader();
      fr2.onload = function () { resolve(fr2.result); };
      fr2.onerror = function () { reject(new Error('lecture_fichier')); };
      fr2.readAsDataURL(file);
    });
  }

  /* ----- Signatures numériques : stylet (canvas) OU empreinte (WebAuthn) ----- */
  function openSignatures(c) {
    if (!c) return;
    openModal(
      '<h3>Signatures — ' + esc(c.full_name || '') + '</h3>' +
      '<p class="sub">Faites signer au stylet directement à l’écran, ou validez par empreinte digitale de l’appareil. Une signature est requise pour le client et pour l’agent.</p>' +
      sigPadHtml('client', 'Signature du client') +
      sigPadHtml('user', 'Signature de l’agent') +
      '<div class="modal__nav"><button class="btn btn--ghost" id="sig-cancel" type="button">Fermer</button>' +
      '<button class="btn btn--primary" id="sig-save" type="button">Enregistrer les signatures</button></div>');
    var pads = { client: setupPad('client'), user: setupPad('user') };
    $('sig-cancel').addEventListener('click', closeModal);
    ['client', 'user'].forEach(function (role) {
      var cl = document.querySelector('[data-sig-clear="' + role + '"]');
      if (cl) cl.addEventListener('click', function () { pads[role].clear(); });
      var fp = document.querySelector('[data-sig-fp="' + role + '"]');
      if (fp) fp.addEventListener('click', function () { captureEmpreinte(c, role, pads[role]); });
    });
    $('sig-save').addEventListener('click', function () {
      var items = [];
      ['client', 'user'].forEach(function (role) {
        var p = pads[role];
        if (p.empreinte) items.push({ role: role, method: 'empreinte', attestation: p.empreinte });
        else if (!p.isEmpty()) items.push({ role: role, method: 'stylet', image_data_url: p.toDataURL() });
      });
      if (!items.length) { notify('Aucune signature à enregistrer.', 'err'); return; }
      $('sig-save').disabled = true;
      api('/api/v1/clients/' + encodeURIComponent(c.id) + '/signatures', 'POST', { signatures: items })
        .then(function (r) { closeModal(); notify((r && r.note) || 'Signatures enregistrées.', 'ok'); loadClients(); })
        .catch(function (e) { $('sig-save').disabled = false; if (!guard(e)) notify(e && e.serverMessage ? e.serverMessage : fr(e), 'err'); });
    });
  }

  function sigPadHtml(role, title) {
    return '<div class="fld"><label>' + esc(title) + '</label>' +
      '<canvas data-sig-pad="' + role + '" width="520" height="150" style="width:100%;max-width:520px;height:150px;border:1px solid #c7c9d6;border-radius:8px;touch-action:none;background:#fff"></canvas>' +
      '<div id="sig-state-' + role + '" class="hint" style="margin-top:4px"></div>' +
      '<div style="margin-top:6px"><button class="btn btn--sm btn--ghost" type="button" data-sig-clear="' + role + '">Effacer</button> ' +
      '<button class="btn btn--sm btn--ghost" type="button" data-sig-fp="' + role + '">Valider par empreinte</button></div></div>';
  }

  function setupPad(role) {
    var cv = document.querySelector('[data-sig-pad="' + role + '"]');
    var ctx = cv.getContext('2d');
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#13131a';
    var drawing = false, dirty = false, last = null;
    function pos(e) {
      var r = cv.getBoundingClientRect();
      var t = (e.touches && e.touches[0]) ? e.touches[0] : e;
      return { x: (t.clientX - r.left) * (cv.width / r.width), y: (t.clientY - r.top) * (cv.height / r.height) };
    }
    function start(e) { e.preventDefault(); drawing = true; last = pos(e); }
    function move(e) {
      if (!drawing) return; e.preventDefault();
      var p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; dirty = true; pad.empreinte = null;
    }
    function end() { drawing = false; }
    cv.addEventListener('pointerdown', start); cv.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    var pad = {
      empreinte: null,
      isEmpty: function () { return !dirty; },
      toDataURL: function () { return cv.toDataURL('image/png'); },
      clear: function () { ctx.clearRect(0, 0, cv.width, cv.height); dirty = false; pad.empreinte = null;
        var st = $('sig-state-' + role); if (st) st.textContent = ''; }
    };
    return pad;
  }

  function captureEmpreinte(c, role, pad) {
    var st = $('sig-state-' + role);
    if (!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create)) {
      if (st) st.textContent = 'Empreinte digitale non supportée sur cet appareil — utilisez le stylet.';
      return;
    }
    var chall = new Uint8Array(32); (window.crypto || {}).getRandomValues && window.crypto.getRandomValues(chall);
    var uid = new Uint8Array(16); (window.crypto || {}).getRandomValues && window.crypto.getRandomValues(uid);
    navigator.credentials.create({ publicKey: {
      challenge: chall,
      rp: { name: 'teebo' },
      user: { id: uid, name: (c.code_client || 'client') + '-' + role, displayName: c.full_name || role },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'required' },
      timeout: 60000, attestation: 'none'
    } }).then(function (cred) {
      pad.empreinte = (cred && cred.id ? cred.id : 'empreinte') + ':' + Date.now();
      if (st) st.textContent = '✓ Validé par empreinte digitale.';
    }).catch(function () {
      if (st) st.textContent = 'La validation par empreinte a échoué ou a été annulée — utilisez le stylet.';
    });
  }

  /* ----- CLIENTS : création (nouveau / existant) + typologie en cascade ----- */
  var _docMeta = null, _docValidity = {}, _docProf = null, _docsBuilt = false;
  function openClientCreate() {
    openModal('<h3>Créer un client</h3><div class="empty">Chargement\u2026</div>');
    Promise.all([
      api('/api/v1/client-meta'),
      api('/api/v1/clients')
    ]).then(function (res) {
      renderClientCreate(res[0] || {}, (res[1] && res[1].clients) || []);
    }).catch(function (e) { closeModal(); if (!guard(e)) notify(fr(e), 'err'); });
  }

  function renderClientCreate(meta, existing) {
    var isScoop = !!meta.is_scoop;
    var nominal = meta.part_sociale_nominal_cents;
    var typology = meta.typology || null;
    _docMeta = meta.particulier_docs || null;
    _docValidity = meta.id_doc_validity_months || {};
    _docProf = null; _docsBuilt = false;

    var existOpts = existing.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc((c.code_client || '') + ' \u2014 ' + (c.full_name || '')) + '</option>';
    }).join('');

    var memberBlock = '';
    if (isScoop) {
      memberBlock =
        '<div class="fld"><label>Qualit\u00e9 (IMF coop\u00e9rative)</label>'
        + '<div><label style="font-weight:400;margin-right:16px"><input type="radio" name="cl-member" value="membre" checked> Client membre (souscrit une part sociale)</label>'
        + '<label style="font-weight:400"><input type="radio" name="cl-member" value="usager"> Client usager</label></div></div>'
        + '<div class="fld" id="cl-shares-wrap"><label for="cl-shares">Nombre de parts sociales</label>'
        + '<input id="cl-shares" inputmode="numeric" value="1">'
        + '<p class="hint" id="cl-shares-hint"></p></div>';
    }

    openModal(
      '<h3>Cr\u00e9er un client</h3>'
      + '<div class="fld"><label>Type de saisie</label>'
      + '<div><label style="font-weight:400;margin-right:16px"><input type="radio" name="cl-mode" value="nouveau" checked> Nouveau client</label>'
      + '<label style="font-weight:400"><input type="radio" name="cl-mode" value="existant"> Client existant</label></div></div>'
      + '<div id="cl-existing-wrap" style="display:none"><div class="fld"><label for="cl-existing">Choisir le client</label>'
      + '<select id="cl-existing"><option value="">\u2014 choisir \u2014</option>' + existOpts + '</select></div></div>'
      + '<div id="cl-identity">'
      + '<div class="fld"><label for="cl-c-name">Nom complet / D\u00e9nomination</label><input id="cl-c-name"></div>'
      + '<div class="fld"><label for="cl-c-phone">T\u00e9l\u00e9phone</label><input id="cl-c-phone"></div>'
      + '<div class="fld"><label for="cl-c-id">N\u00b0 de pi\u00e8ce / registre</label><input id="cl-c-id"></div>'
      + '<div class="fld"><label for="cl-c-addr">Adresse</label><input id="cl-c-addr"></div>'
      + '<div class="fld"><label for="cl-c-birth">Date de naissance / cr\u00e9ation</label><input id="cl-c-birth" type="date"></div>'
      + '</div>'
      + memberBlock
      + '<div class="fld"><label>Type de client</label><div id="cl-typo"></div></div>'
      + '<div id="cl-docs"></div>'
      + '<div class="modal__nav"><button class="btn btn--ghost" id="cl-c-cancel" type="button">Annuler</button>'
      + '<button class="btn btn--primary" id="cl-c-save" type="button">Enregistrer</button></div>');

    // Cascade typologie (rendue depuis l'arbre fourni par le serveur).
    if (typology) buildCascade(typology, $('cl-typo'));
    // À chaque changement dans la cascade, (re)construire les pièces requises.
    $('cl-typo').addEventListener('change', function () { refreshDocs(); });

    // Parts sociales : affichage du montant total (parts \u00d7 valeur nominale).
    function refreshShares() {
      if (!isScoop) return;
      var isMember = (document.querySelector('input[name="cl-member"]:checked') || {}).value === 'membre';
      $('cl-shares-wrap').style.display = isMember ? '' : 'none';
      var n = Number(digits($('cl-shares').value)) || 0;
      var hint = $('cl-shares-hint');
      if (nominal == null) { hint.textContent = '\u26a0 Valeur nominale non fix\u00e9e dans les param\u00e8tres de l\u2019IMF.'; hint.style.color = '#c0392b'; }
      else { hint.textContent = 'Valeur nominale : ' + money(nominal) + ' \u00b7 Total \u00e0 lib\u00e9rer : ' + money(n * nominal); hint.style.color = ''; }
    }
    if (isScoop) {
      Array.prototype.forEach.call(document.querySelectorAll('input[name="cl-member"]'), function (el) { el.addEventListener('change', refreshShares); });
      $('cl-shares').addEventListener('input', refreshShares);
      refreshShares();
    }

    // Bascule nouveau / existant + pièces requises (particulier).
    function refreshMode() {
      var mode = (document.querySelector('input[name="cl-mode"]:checked') || {}).value;
      var cat = (collectTypology() || {}).client_category;
      var isPart = cat === 'particulier';
      $('cl-existing-wrap').style.display = mode === 'existant' ? '' : 'none';
      // Pour un particulier, l'identité est saisie dans le bloc « pièces requises ».
      $('cl-identity').style.display = (mode === 'existant' || isPart) ? 'none' : '';
      $('cl-docs').style.display = isPart ? '' : 'none';
    }
    function refreshDocs() { buildDocsForm(); refreshMode(); }
    Array.prototype.forEach.call(document.querySelectorAll('input[name="cl-mode"]'), function (el) { el.addEventListener('change', refreshMode); });
    refreshMode();

    $('cl-c-cancel').addEventListener('click', closeModal);
    $('cl-c-save').addEventListener('click', function () { submitClientCreate(isScoop, nominal); });
  }

  // Construit r\u00e9cursivement les listes d\u00e9roulantes en cascade.
  function buildCascade(node, mount) {
    var wrap = document.createElement('div'); wrap.className = 'fld';
    var lab = document.createElement('label'); lab.textContent = node.label; wrap.appendChild(lab);
    var sel = document.createElement('select'); sel.id = 'cl-f-' + node.field;
    sel.setAttribute('data-field', node.field);
    var html = '<option value="">\u2014 choisir \u2014</option>';
    (node.options || []).forEach(function (o) { html += '<option value="' + esc(o.code) + '">' + esc(o.label) + '</option>'; });
    sel.innerHTML = html; wrap.appendChild(sel);
    mount.appendChild(wrap);
    var childMount = document.createElement('div'); mount.appendChild(childMount);
    sel.addEventListener('change', function () {
      childMount.innerHTML = '';
      var opt = (node.options || []).filter(function (o) { return o.code === sel.value; })[0];
      if (opt && opt.children) opt.children.forEach(function (ch) { buildCascade(ch, childMount); });
    });
  }

  function collectTypology() {
    var vals = {};
    Array.prototype.forEach.call($('cl-typo').querySelectorAll('select[data-field]'), function (sel) {
      if (sel.value) vals[sel.getAttribute('data-field')] = sel.value;
    });
    return vals;
  }

  /* ----- PIÈCES REQUISES (PARTICULIER) ----- */
  // Ajoute N mois à une date ISO (miroir côté serveur de computeExpiry).
  function addMonthsIso(iso, months) {
    if (!iso || months == null) return null;
    var m = Math.trunc(Number(months)); if (!isFinite(m) || m <= 0) return null;
    var d = new Date(iso + 'T00:00:00Z'); if (isNaN(d.getTime())) return null;
    var day = d.getUTCDate();
    var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, 1));
    var last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(day, last));
    return t.toISOString().slice(0, 10);
  }
  function optList(list) {
    return '<option value="">\u2014 choisir \u2014</option>' + (list || []).map(function (o) {
      return '<option value="' + esc(o.code) + '">' + esc(o.label) + '</option>';
    }).join('');
  }
  // (Re)construit le bloc des pièces requises selon la typologie courante.
  function buildDocsForm() {
    var typo = collectTypology();
    if (typo.client_category !== 'particulier' || !_docMeta) return;
    var dm = _docMeta;
    if (!_docsBuilt) {
      $('cl-docs').innerHTML =
        '<h4 style="margin:14px 0 6px">Pi\u00e8ces requises \u2014 Particulier</h4>'
        + '<div class="fld"><label for="cl-doc-idtype">Document officiel d\u2019identit\u00e9 valide</label>'
        + '<select id="cl-doc-idtype">' + optList(dm.id_doc_types) + '</select></div>'
        + '<div class="fld"><label style="font-weight:400"><input type="checkbox" id="cl-doc-idrecu"> Document physique re\u00e7u</label></div>'
        + '<div class="fld"><label for="cl-doc-birthcert">Acte de naissance</label>'
        + '<select id="cl-doc-birthcert">' + optList(dm.birth_cert_statuses) + '</select></div>'
        + '<div class="fld"><label for="cl-doc-last">Nom</label><input id="cl-doc-last"></div>'
        + '<div class="fld"><label for="cl-doc-first">Pr\u00e9nom</label><input id="cl-doc-first"></div>'
        + '<div class="fld"><label for="cl-doc-phone">T\u00e9l\u00e9phone</label><input id="cl-doc-phone"></div>'
        + '<div class="fld"><label for="cl-doc-birth">Date de naissance</label><input id="cl-doc-birth" type="date"></div>'
        + '<div class="fld"><label for="cl-doc-birthplace">Lieu de naissance</label><input id="cl-doc-birthplace"></div>'
        + '<div class="fld"><label for="cl-doc-idnum">N\u00b0 de la pi\u00e8ce d\u2019identit\u00e9</label><input id="cl-doc-idnum"></div>'
        + '<div class="fld"><label for="cl-doc-issue">Date d\u2019\u00e9tablissement</label><input id="cl-doc-issue" type="date"></div>'
        + '<div class="fld"><label for="cl-doc-expiry">Date d\u2019expiration (calcul\u00e9e)</label>'
        + '<input id="cl-doc-expiry" type="date" readonly><p class="hint" id="cl-doc-expiry-hint"></p></div>'
        + '<h4 style="margin:14px 0 6px">Localisation</h4>'
        + '<div class="fld"><label for="cl-doc-homeloc">Plan de localisation du domicile (itin\u00e9raire + rep\u00e8res)</label>'
        + '<textarea id="cl-doc-homeloc" rows="3"></textarea></div>'
        + '<div class="fld"><label for="cl-doc-homestatus">Justificatif de domicile</label>'
        + '<select id="cl-doc-homestatus">' + optList(dm.proof_statuses) + '</select></div>'
        + '<div class="fld" id="cl-doc-hometype-wrap" style="display:none"><label for="cl-doc-hometype">Type de justificatif de domicile</label>'
        + '<select id="cl-doc-hometype">' + optList(dm.home_proof_types) + '</select></div>'
        + '<div class="fld"><label for="cl-doc-actloc">Plan de localisation d\u2019activit\u00e9 (itin\u00e9raire + rep\u00e8res)</label>'
        + '<textarea id="cl-doc-actloc" rows="3"></textarea></div>'
        + '<div class="fld"><label for="cl-doc-actstatus">Justificatif de lieu d\u2019activit\u00e9</label>'
        + '<select id="cl-doc-actstatus">' + optList(dm.proof_statuses) + '</select></div>'
        + '<div class="fld" id="cl-doc-acttype-wrap" style="display:none"><label for="cl-doc-acttype">Type de justificatif de lieu d\u2019activit\u00e9</label>'
        + '<select id="cl-doc-acttype">' + optList(dm.activity_proof_types) + '</select></div>'
        + '<h4 style="margin:14px 0 6px">Ayant droit</h4>'
        + '<p class="hint">Personne \u00e0 pr\u00e9venir / b\u00e9n\u00e9ficiaire d\u00e9sign\u00e9 (facultatif).</p>'
        + '<div class="fld"><label for="cl-doc-ben-last">Nom de l\u2019ayant droit</label><input id="cl-doc-ben-last"></div>'
        + '<div class="fld"><label for="cl-doc-ben-first">Pr\u00e9nom de l\u2019ayant droit</label><input id="cl-doc-ben-first"></div>'
        + '<div class="fld"><label for="cl-doc-ben-rel">Lien avec le client</label>'
        + '<select id="cl-doc-ben-rel"><option value="">\u2014</option>' + optList(dm.beneficiary_relations) + '</select></div>'
        + '<div id="cl-doc-income"></div>';
      _docsBuilt = true; _docProf = null;
      $('cl-doc-idtype').addEventListener('change', recalcExpiry);
      $('cl-doc-issue').addEventListener('change', recalcExpiry);
      $('cl-doc-homestatus').addEventListener('change', function () {
        $('cl-doc-hometype-wrap').style.display = this.value === 'recu' ? '' : 'none';
      });
      $('cl-doc-actstatus').addEventListener('change', function () {
        $('cl-doc-acttype-wrap').style.display = this.value === 'recu' ? '' : 'none';
      });
    }
    if (typo.profession !== _docProf) { buildIncomeSection(typo.profession); _docProf = typo.profession; }
    recalcExpiry();
  }
  function recalcExpiry() {
    if (!$('cl-doc-idtype')) return;
    var type = $('cl-doc-idtype').value;
    var issue = $('cl-doc-issue').value;
    var months = type && _docValidity[type] != null ? _docValidity[type] : null;
    var exp = addMonthsIso(issue, months);
    $('cl-doc-expiry').value = exp || '';
    var hint = $('cl-doc-expiry-hint');
    if (!type || !issue) { hint.textContent = ''; hint.style.color = ''; }
    else if (months == null) { hint.textContent = '\u26a0 Dur\u00e9e de validit\u00e9 non param\u00e9tr\u00e9e pour ce type de pi\u00e8ce (Param\u00e8tres IMF).'; hint.style.color = '#c0392b'; }
    else { hint.textContent = 'Validit\u00e9 : ' + months + ' mois \u00b7 expire le ' + (exp || '\u2014'); hint.style.color = ''; }
  }
  function buildIncomeSection(prof) {
    var mount = $('cl-doc-income'); if (!mount) return;
    var spec = (_docMeta && _docMeta.income_by_profession && prof) ? _docMeta.income_by_profession[prof] : null;
    if (!spec) { mount.innerHTML = ''; return; }
    var html = '<h4 style="margin:14px 0 6px">Activit\u00e9 &amp; revenu</h4>';
    if (spec.kind_label) html += '<p class="hint">Nature : ' + esc(spec.kind_label) + '</p>';
    if (spec.description_required) html += '<div class="fld"><label for="cl-doc-actdesc">' + esc(spec.description_label) + '</label><textarea id="cl-doc-actdesc" rows="3"></textarea></div>';
    if (spec.school_required) html += '<div class="fld"><label for="cl-doc-school">' + esc(spec.school_label) + '</label><input id="cl-doc-school"></div>';
    if (spec.types && spec.types.length) {
      if (spec.proof_required) {
        html += '<div class="fld"><label style="font-weight:400"><input type="checkbox" id="cl-doc-income-recu" checked> ' + esc(spec.proof_label) + '</label></div>';
      } else {
        html += '<div class="fld"><label>' + esc(spec.proof_label || 'Justificatif') + '</label>'
          + '<div><label style="font-weight:400;margin-right:16px"><input type="radio" name="cl-doc-income-status" value="recu" checked> Re\u00e7u</label>'
          + '<label style="font-weight:400"><input type="radio" name="cl-doc-income-status" value="non_recu"> Non re\u00e7u</label></div></div>';
      }
      html += '<div class="fld" id="cl-doc-income-type-wrap"><label for="cl-doc-income-type">Type de justificatif</label>'
        + '<select id="cl-doc-income-type">' + optList(spec.types) + '</select></div>';
    }
    if (prof === 'salarie' || prof === 'retraite') {
      var domLabel = prof === 'retraite' ? 'Domiciliation de la pension chez nous' : 'Domiciliation du salaire chez nous';
      html += '<div class="fld"><label style="font-weight:400"><input type="checkbox" id="cl-doc-salary-dom"> Oui, ' + domLabel + '</label></div>';
    }
    mount.innerHTML = html;
    function syncIncome() {
      var recu = true;
      if ($('cl-doc-income-recu')) recu = $('cl-doc-income-recu').checked;
      else { var r = document.querySelector('input[name="cl-doc-income-status"]:checked'); recu = !r || r.value === 'recu'; }
      var w = $('cl-doc-income-type-wrap'); if (w) w.style.display = recu ? '' : 'none';
    }
    if ($('cl-doc-income-recu')) $('cl-doc-income-recu').addEventListener('change', syncIncome);
    Array.prototype.forEach.call(document.querySelectorAll('input[name="cl-doc-income-status"]'), function (el) { el.addEventListener('change', syncIncome); });
    syncIncome();
  }
  // Rassemble tous les champs de pièces du particulier dans l'objet body.
  function collectDocs(body) {
    var g = function (id) { var e = $(id); return e ? (e.value || '').trim() : ''; };
    body.id_doc_type = g('cl-doc-idtype') || undefined;
    body.id_doc_received = $('cl-doc-idrecu') ? $('cl-doc-idrecu').checked : false;
    body.birth_cert_status = g('cl-doc-birthcert') || undefined;
    body.last_name = g('cl-doc-last') || undefined;
    body.first_name = g('cl-doc-first') || undefined;
    body.phone = g('cl-doc-phone') || undefined;
    body.birth_date = g('cl-doc-birth') || undefined;
    body.birth_place = g('cl-doc-birthplace') || undefined;
    body.id_doc_number = g('cl-doc-idnum') || undefined;
    body.id_doc_issue_date = g('cl-doc-issue') || undefined;
    body.home_location_desc = g('cl-doc-homeloc') || undefined;
    body.home_proof_status = g('cl-doc-homestatus') || undefined;
    if (body.home_proof_status === 'recu') body.home_proof_type = g('cl-doc-hometype') || undefined;
    body.activity_location_desc = g('cl-doc-actloc') || undefined;
    body.activity_proof_status = g('cl-doc-actstatus') || undefined;
    if (body.activity_proof_status === 'recu') body.activity_proof_type = g('cl-doc-acttype') || undefined;
    if ($('cl-doc-actdesc')) body.activity_description = g('cl-doc-actdesc') || undefined;
    if ($('cl-doc-school')) body.school_name = g('cl-doc-school') || undefined;
    // Statut du justificatif de revenu / activité.
    if ($('cl-doc-income-recu')) {
      body.income_proof_status = $('cl-doc-income-recu').checked ? 'recu' : 'non_recu';
    } else {
      var r = document.querySelector('input[name="cl-doc-income-status"]:checked');
      if (r) body.income_proof_status = r.value;
    }
    if (body.income_proof_status === 'recu' && $('cl-doc-income-type')) body.income_proof_type = g('cl-doc-income-type') || undefined;
    // Ayant droit (facultatif).
    if ($('cl-doc-ben-last')) body.beneficiary_last_name = g('cl-doc-ben-last') || undefined;
    if ($('cl-doc-ben-first')) body.beneficiary_first_name = g('cl-doc-ben-first') || undefined;
    if ($('cl-doc-ben-rel')) body.beneficiary_relation = g('cl-doc-ben-rel') || undefined;
    // Domiciliation salaire / pension (salari\u00e9 / retrait\u00e9).
    body.salary_domiciliation = $('cl-doc-salary-dom') ? $('cl-doc-salary-dom').checked : false;
    // Compose le nom complet + le n\u00b0 de pi\u00e8ce pour la fiche / anti-doublon.
    var fn = [body.last_name, body.first_name].filter(Boolean).join(' ').trim();
    if (fn) body.full_name = fn;
    if (body.id_doc_number && !body.id_number) body.id_number = body.id_doc_number;
    return body;
  }

  function submitClientCreate(isScoop, nominal) {
    var mode = (document.querySelector('input[name="cl-mode"]:checked') || {}).value;
    var typo = collectTypology();
    if (!typo.client_category) { notify('Choisissez le type de client (Particulier, Groupe ou Entreprise).', 'err'); return; }
    var body = typo;
    if (isScoop) {
      var isMember = (document.querySelector('input[name="cl-member"]:checked') || {}).value === 'membre';
      body.membership_type = isMember ? 'membre' : 'usager';
      if (isMember) {
        if (nominal == null) { notify('Fixez d\u2019abord la valeur nominale de la part sociale dans les Param\u00e8tres.', 'err'); return; }
        var n = Number(digits($('cl-shares').value)) || 0;
        if (n < 1) { notify('Un client membre doit souscrire au moins une part sociale.', 'err'); return; }
        body.shares_count = n;
      }
    }
    var btn = $('cl-c-save'); btn.disabled = true;
    var done = function () { btn.disabled = false; };
    var isPart = typo.client_category === 'particulier';
    // Pour un particulier, l'identit\u00e9 + toutes les pi\u00e8ces sont saisies dans le
    // bloc d\u00e9di\u00e9 (cl-docs) ; on les ajoute au corps de la requ\u00eate.
    if (isPart) collectDocs(body);

    if (mode === 'existant') {
      var cid = $('cl-existing').value;
      if (!cid) { notify('Choisissez un client existant.', 'err'); done(); return; }
      api('/api/v1/clients/' + encodeURIComponent(cid), 'PATCH', body)
        .then(function (r) { closeModal(); notify((r && r.note) || 'Fiche client mise \u00e0 jour.', 'ok'); loadClients(); })
        .catch(function (e) { done(); if (!guard(e)) notify(srv(e), 'err'); });
      return;
    }
    // Nouveau client.
    if (isPart) {
      if (!body.full_name) { notify('Le nom et le pr\u00e9nom sont obligatoires.', 'err'); done(); return; }
    } else {
      body.full_name = $('cl-c-name').value.trim();
      if (!body.full_name) { notify('Le nom complet / la d\u00e9nomination est obligatoire.', 'err'); done(); return; }
      body.phone = $('cl-c-phone').value.trim() || undefined;
      body.id_number = $('cl-c-id').value.trim() || undefined;
      body.address = $('cl-c-addr').value.trim() || undefined;
      body.birth_date = $('cl-c-birth').value || undefined;
    }
    api('/api/v1/clients', 'POST', body)
      .then(function (r) {
        closeModal();
        var cred = r && r.credentials ? r.credentials : null;
        notify((r && r.note) || 'Client cr\u00e9\u00e9.', 'ok');
        if (cred) showClientCredentials(cred, r);
        loadClients();
      })
      .catch(function (e) {
        done();
        if (e && e.message === 'duplicate_client') { notify('Un client identique existe d\u00e9j\u00e0 \u2014 cr\u00e9ation bloqu\u00e9e.', 'err'); return; }
        if (!guard(e)) notify(srv(e), 'err');
      });
  }

  function showClientCredentials(cred, r) {
    var mem = r && r.client && r.client.membership_type;
    var memLine = mem ? '<p class="sub">Qualit\u00e9 : <b>' + (mem === 'membre' ? 'Client membre' : 'Client usager') + '</b>'
      + (mem === 'membre' ? ' \u00b7 ' + (r.client.shares_count || 0) + ' part(s)' : '') + '</p>' : '';
    openModal('<h3>Client cr\u00e9\u00e9</h3>'
      + memLine
      + '<div class="fld"><label>Code client</label><input readonly value="' + esc(cred.code_client || '') + '"></div>'
      + '<div class="fld"><label>Compte</label><input readonly value="' + esc(cred.code_account || '') + '"></div>'
      + '<div class="fld"><label>Mot de passe temporaire</label><input readonly value="' + esc(cred.temporary_password || '') + '"></div>'
      + '<div class="modal__nav"><button class="btn btn--primary" id="cl-cred-ok" type="button">Fermer</button></div>');
    $('cl-cred-ok').addEventListener('click', closeModal);
  }

/*BANKING_MODULE*/
  /* ----- CAISSE ----- */
  function loadCaisse() { loadOverruns(); loadClosings(); }
  var OV_ST = { en_attente: 'En attente', approuve: 'Approuv\u00e9', rejete: 'Rejet\u00e9' };
  function loadOverruns() {
    return api('/api/v1/cash/overrun-requests').then(function (d) {
      var l = d.requests || [], ca = has('cash.approve');
      if (!l.length) { $('overrun-table').innerHTML = '<div class="empty">Aucune demande.</div>'; return; }
      var body = l.map(function (o) {
        var act = (ca && o.status === 'en_attente') ? '<button class="btn btn--sm" data-ok="' + esc(o.id) + '">Approuver</button> <button class="btn btn--sm btn--ghost" data-no="' + esc(o.id) + '">Rejeter</button>' : '\u2014';
        return '<tr><td>' + esc(o.kind === 'caisse' ? 'Caisse' : 'Client') + '</td><td>' + esc(o.client_name || '\u2014') + '</td><td>' + money(o.amount_cents) + '</td><td>' + (o.cap_cents ? money(o.cap_cents) : '\u2014') + '</td><td>' + esc(o.reason || '\u2014') + '</td><td><span class="tag">' + esc(OV_ST[o.status] || o.status) + '</span></td><td style="text-align:right;white-space:nowrap">' + act + '</td></tr>';
      }).join('');
      $('overrun-table').innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Type</th><th>Client</th><th>Montant</th><th>Plafond</th><th>Motif</th><th>Statut</th><th style="text-align:right">Action</th></tr></thead><tbody>' + body + '</tbody></table></div>';
      $('overrun-table').querySelectorAll('[data-ok]').forEach(function (b) { b.addEventListener('click', function () { decideOverrun(b.dataset.ok, 'approuve'); }); });
      $('overrun-table').querySelectorAll('[data-no]').forEach(function (b) { b.addEventListener('click', function () { decideOverrun(b.dataset.no, 'rejete'); }); });
    }).catch(function (e) { if (guard(e)) return; if (e.message === 'forbidden' || e.message === 'missing_permission') forbidden('overrun-table', 'Acc\u00e8s non habilit\u00e9.'); else notify(fr(e), 'err'); });
  }
  function decideOverrun(id, dec) {
    var note = dec === 'rejete' ? window.prompt('Motif du rejet (optionnel) :', '') : undefined;
    if (note === null) return;
    api('/api/v1/cash/overrun-requests/' + encodeURIComponent(id) + '/decide', 'POST', { decision: dec, note: note || undefined })
      .then(function (r) { notify(r.note || 'D\u00e9cision enregistr\u00e9e.', 'ok'); loadOverruns(); })
      .catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }
  function openOverrunModal() {
    openModal('<h3>Demande de d\u00e9passement de plafond</h3><div class="fld"><label for="ov-kind">Type</label><select id="ov-kind"><option value="client">Client</option><option value="caisse">Caisse</option></select></div><div class="fld"><label for="ov-amount">Montant (FCFA)</label><input id="ov-amount" inputmode="numeric"></div><div class="fld"><label for="ov-cap">Plafond autoris\u00e9 (FCFA, optionnel)</label><input id="ov-cap" inputmode="numeric"></div><div class="fld"><label for="ov-reason">Motif</label><textarea id="ov-reason" rows="3"></textarea></div><div class="modal__nav"><button class="btn btn--ghost" id="ov-cancel" type="button">Annuler</button><button class="btn btn--primary" id="ov-save" type="button">Enregistrer</button></div>');
    $('ov-cancel').addEventListener('click', closeModal);
    $('ov-save').addEventListener('click', function () {
      var amount = cents($('ov-amount').value);
      if (!(amount > 0)) { notify('Montant invalide.', 'err'); return; }
      $('ov-save').disabled = true;
      api('/api/v1/cash/overrun-requests', 'POST', { kind: $('ov-kind').value, amount_cents: amount, cap_cents: cents($('ov-cap').value), reason: $('ov-reason').value.trim() || undefined })
        .then(function (r) { closeModal(); notify(r.note || 'Demande enregistr\u00e9e.', 'ok'); loadOverruns(); })
        .catch(function (e) { $('ov-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  function loadClosings() {
    return api('/api/v1/cash/closings').then(function (d) {
      var l = d.closings || [];
      if (!l.length) { $('closing-table').innerHTML = '<div class="empty">Aucun arr\u00eat\u00e9.</div>'; return; }
      var body = l.map(function (c) { var g = Number(c.gap_cents || 0);
        var regul;
        if (c.status === 'equilibre') { regul = '\u2014'; }
        else if (c.gap_resolved) { regul = '<span class="tag" style="color:#1a7f37">R\u00e9gl\u00e9</span>'; }
        else {
          var due = c.gap_due_at ? dt(c.gap_due_at) : '\u2014';
          regul = '<button class="btn btn--ghost cc-resolve" data-id="' + esc(c.id) + '" data-gap="' + g + '" type="button">R\u00e9gler</button>'
            + '<br><small style="color:' + (c.gap_overdue ? '#c0392b' : 'var(--muted)') + '">\u00e9ch. ' + esc(due) + (c.gap_overdue ? ' (d\u00e9pass\u00e9e)' : '') + '</small>';
        }
        return '<tr><td>' + esc(c.closing_date ? String(c.closing_date).slice(0, 10) : '\u2014') + '</td><td>' + money(c.theoretical_cents) + '</td><td>' + money(c.counted_cents) + '</td><td style="color:' + (g === 0 ? 'inherit' : (g > 0 ? '#1a7f37' : '#c0392b')) + '">' + (g > 0 ? '+' : '') + money(g) + '</td><td><span class="tag">' + (c.status === 'equilibre' ? '\u00c9quilibr\u00e9' : '\u00c9cart') + '</span></td><td>' + regul + '</td><td>' + esc(c.user_name || '\u2014') + '</td></tr>';
      }).join('');
      $('closing-table').innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Date</th><th>Th\u00e9orique</th><th>Compt\u00e9</th><th>\u00c9cart</th><th>Statut</th><th>R\u00e8glement</th><th>Agent</th></tr></thead><tbody>' + body + '</tbody></table></div>';
      $('closing-table').querySelectorAll('.cc-resolve').forEach(function (btn) {
        btn.addEventListener('click', function () { openResolveModal(btn.getAttribute('data-id'), Number(btn.getAttribute('data-gap'))); });
      });
    }).catch(function (e) { if (guard(e)) return; if (e.message === 'forbidden' || e.message === 'missing_permission') forbidden('closing-table', 'Acc\u00e8s non habilit\u00e9.'); else notify(fr(e), 'err'); });
  }
  function openClosingModal() {
    var DENOMS = [10000, 5000, 2000, 1000, 500, 250, 200, 100, 50, 25, 10, 5];
    var today = new Date();
    var todayStr = today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2);
    var rows = DENOMS.map(function (d) {
      return '<tr><td style="white-space:nowrap">' + fmtAmount(d) + ' FCFA</td>'
        + '<td><input class="cc-den" data-face="' + d + '" inputmode="numeric" style="width:90px" value=""></td>'
        + '<td style="text-align:right" id="cc-line-' + d + '">0</td></tr>';
    }).join('');
    openModal('<h3>Arr\u00eat\u00e9 de caisse</h3>'
      + '<div class="fld"><label for="cc-date">Date</label><input id="cc-date" type="date" value="' + todayStr + '"></div>'
      + '<div class="fld"><label>Solde th\u00e9orique (auto)</label><input id="cc-th" value="Calcul\u2026" readonly style="background:#f3f4f6"></div>'
      + '<div class="fld"><label>Billetage \u2014 comptage des esp\u00e8ces (coupures XOF)</label>'
      + '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Coupure</th><th>Quantit\u00e9</th><th style="text-align:right">Montant</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div></div>'
      + '<div class="fld"><label>Esp\u00e8ces compt\u00e9es (billetage)</label><input id="cc-ct" readonly style="background:#f3f4f6;font-weight:700" value="0 FCFA"></div>'
      + '<div class="fld"><label>\u00c9cart (compt\u00e9 \u2212 th\u00e9orique)</label><input id="cc-gap" readonly style="background:#f3f4f6;font-weight:700" value="\u2014"></div>'
      + '<div class="fld" id="cc-just-wrap" style="display:none"><label for="cc-just">Justification de l\u2019\u00e9cart (obligatoire \u2014 \u00e0 r\u00e9gler sous 24h)</label><textarea id="cc-just" rows="2"></textarea></div>'
      + '<div class="fld"><label for="cc-note">Note</label><textarea id="cc-note" rows="2"></textarea></div>'
      + '<div class="modal__nav"><button class="btn btn--ghost" id="cc-cancel" type="button">Annuler</button><button class="btn btn--primary" id="cc-save" type="button">Enregistrer</button></div>');
    var theo = 0, theoReady = false;
    function recompute() {
      var counted = 0;
      DENOMS.forEach(function (d) {
        var inp = $('modal-root').querySelector('.cc-den[data-face="' + d + '"]');
        var qty = Number(digits(inp.value)) || 0;
        var line = d * qty;
        counted += line;
        $('cc-line-' + d).textContent = fmtAmount(line);
      });
      $('cc-ct').value = fmtAmount(counted) + ' FCFA';
      if (theoReady) {
        var gap = counted * 100 - theo;
        var g = gap / 100;
        $('cc-gap').value = (g > 0 ? '+' : '') + fmtAmount(g) + ' FCFA';
        $('cc-gap').style.color = gap === 0 ? 'inherit' : (gap > 0 ? '#1a7f37' : '#c0392b');
        $('cc-just-wrap').style.display = gap === 0 ? 'none' : '';
      }
      return counted;
    }
    $('modal-root').querySelectorAll('.cc-den').forEach(function (inp) {
      inp.addEventListener('input', recompute);
    });
    $('cc-cancel').addEventListener('click', closeModal);
    api('/api/v1/cash/theoretical').then(function (d) {
      theo = Number(d.theoretical_cents || 0); theoReady = true;
      $('cc-th').value = money(theo);
      recompute();
    }).catch(function (e) { if (!guard(e)) $('cc-th').value = '\u2014 (indisponible)'; });
    $('cc-save').addEventListener('click', function () {
      var counted = recompute();
      var denoms = {};
      DENOMS.forEach(function (d) {
        var inp = $('modal-root').querySelector('.cc-den[data-face="' + d + '"]');
        var qty = Number(digits(inp.value)) || 0;
        if (qty > 0) denoms[d] = qty;
      });
      var gap = counted * 100 - theo;
      var just = $('cc-just').value.trim();
      if (theoReady && gap !== 0 && !just) { notify('Un \u00e9cart est constat\u00e9 : la justification est obligatoire.', 'err'); return; }
      $('cc-save').disabled = true;
      api('/api/v1/cash/closings', 'POST', { closing_date: $('cc-date').value || undefined, denominations: denoms, gap_justification: just || undefined, note: $('cc-note').value.trim() || undefined })
        .then(function (r) { closeModal(); notify(r.note || 'Arr\u00eat\u00e9 enregistr\u00e9.', 'ok'); loadClosings(); })
        .catch(function (e) { $('cc-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  function openResolveModal(id, gap) {
    openModal('<h3>R\u00e8glement de l\u2019\u00e9cart</h3><p style="color:var(--muted)">\u00c9cart de <b>' + money(gap) + '</b> \u00e0 r\u00e9gler d\u00e9finitivement.</p>'
      + '<div class="fld"><label for="rs-note">Comment l\u2019\u00e9cart a-t-il \u00e9t\u00e9 r\u00e9gl\u00e9 ?</label><textarea id="rs-note" rows="3"></textarea></div>'
      + '<div class="modal__nav"><button class="btn btn--ghost" id="rs-cancel" type="button">Annuler</button><button class="btn btn--primary" id="rs-save" type="button">Marquer r\u00e9gl\u00e9</button></div>');
    $('rs-cancel').addEventListener('click', closeModal);
    $('rs-save').addEventListener('click', function () {
      var note = $('rs-note').value.trim();
      if (!note) { notify('Pr\u00e9cisez le r\u00e8glement.', 'err'); return; }
      $('rs-save').disabled = true;
      api('/api/v1/cash/closings/' + id + '/resolve', 'POST', { resolution_note: note })
        .then(function (r) { closeModal(); notify(r.note || '\u00c9cart r\u00e9gl\u00e9.', 'ok'); loadClosings(); })
        .catch(function (e) { $('rs-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  /* ----- COFFRE ----- */
  function loadVault() {
    return api('/api/v1/vault/movements').then(function (d) {
      $('vault-kpis').innerHTML = kpi(money(d.balance_cents), 'Solde du coffre', true);
      var l = d.movements || [];
      if (!l.length) { $('vault-table').innerHTML = '<div class="empty">Aucun mouvement.</div>'; return; }
      var body = l.map(function (m) {
        return '<tr><td>' + dt(m.created_at) + '</td><td>' + (m.direction === 'approvisionnement' ? 'Approvisionnement' : 'D\u00e9lestage') + '</td><td>' + money(m.amount_cents) + '</td><td>' + esc(m.counterpart || '\u2014') + '</td><td>' + esc(m.reason || '\u2014') + '</td><td>' + money(m.balance_after_cents) + '</td><td>' + esc(m.created_by_name || '\u2014') + '</td></tr>';
      }).join('');
      $('vault-table').innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Date</th><th>Sens</th><th>Montant</th><th>Contrepartie</th><th>Motif</th><th>Solde apr\u00e8s</th><th>Par</th></tr></thead><tbody>' + body + '</tbody></table></div>';
    }).catch(function (e) { if (guard(e)) return; if (e.message === 'forbidden' || e.message === 'missing_permission') forbidden('vault-table', 'Acc\u00e8s non habilit\u00e9.'); else notify(fr(e), 'err'); });
  }
  function openVaultModal() {
    openModal('<h3>Mouvement de coffre</h3><div class="fld"><label for="vm-dir">Sens</label><select id="vm-dir"><option value="approvisionnement">Approvisionnement</option><option value="delestage">D\u00e9lestage</option></select></div><div class="fld"><label for="vm-amount">Montant (FCFA)</label><input id="vm-amount" inputmode="numeric"></div><div class="fld"><label for="vm-cp">Contrepartie (optionnel)</label><input id="vm-cp"></div><div class="fld"><label for="vm-reason">Motif</label><textarea id="vm-reason" rows="2"></textarea></div><div class="modal__nav"><button class="btn btn--ghost" id="vm-cancel" type="button">Annuler</button><button class="btn btn--primary" id="vm-save" type="button">Valider</button></div>');
    $('vm-cancel').addEventListener('click', closeModal);
    $('vm-save').addEventListener('click', function () {
      var amount = cents($('vm-amount').value);
      if (!(amount > 0)) { notify('Montant invalide.', 'err'); return; }
      $('vm-save').disabled = true;
      api('/api/v1/vault/movements', 'POST', { direction: $('vm-dir').value, amount_cents: amount, counterpart: $('vm-cp').value.trim() || undefined, reason: $('vm-reason').value.trim() || undefined })
        .then(function (r) { closeModal(); notify(r.note || 'Mouvement enregistr\u00e9.', 'ok'); loadVault(); })
        .catch(function (e) { $('vm-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  /* ----- COMPTABILIT\u00c9 ----- */
  var CAT = { charge: 'Charge', taxe: 'Taxe', produit: 'Produit', od: 'OD' };
  function comptaPeriod() { var m = $('compta-period'); return m && m.value ? m.value : new Date().toISOString().slice(0, 7); }
  function loadCompta() {
    var p = comptaPeriod();
    return api('/api/v1/accounting/entries?period=' + encodeURIComponent(p)).then(function (d) {
      api('/api/v1/accounting/statements?period=' + encodeURIComponent(p)).then(function (s) {
        $('compta-kpis').innerHTML = kpi(money(s.produits_cents), 'Produits') + kpi(money(s.charges_cents), 'Charges') + kpi(money(s.taxes_cents), 'Taxes') + kpi(money(s.resultat_net_cents), 'R\u00e9sultat net', true);
      }).catch(function () {});
      var l = d.entries || [], lock = d.period_closed;
      var hdr = '<p class="hint" style="margin-bottom:10px">P\u00e9riode ' + esc(p) + (lock ? ' \u2014 <b>cl\u00f4tur\u00e9e</b>' : '') + '</p>';
      if (!l.length) { $('entries-table').innerHTML = hdr + '<div class="empty">Aucune \u00e9criture.</div>'; return; }
      var body = l.map(function (e2) {
        return '<tr><td>' + esc(e2.entry_date ? String(e2.entry_date).slice(0, 10) : '\u2014') + '</td><td>' + esc(e2.journal || '\u2014') + '</td><td>' + esc(CAT[e2.category] || e2.category) + '</td><td>' + esc(e2.label || '\u2014') + '</td><td>' + money(e2.amount_cents) + '</td></tr>';
      }).join('');
      $('entries-table').innerHTML = hdr + '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Date</th><th>Journal</th><th>Cat\u00e9gorie</th><th>Libell\u00e9</th><th>Montant</th></tr></thead><tbody>' + body + '</tbody></table></div>';
    }).catch(function (e) { if (guard(e)) return; if (e.message === 'forbidden' || e.message === 'missing_permission') forbidden('entries-table', 'Acc\u00e8s non habilit\u00e9.'); else notify(fr(e), 'err'); });
  }
  function openEntryModal() {
    openModal('<h3>Nouvelle \u00e9criture comptable</h3><div class="fld"><label for="en-date">Date</label><input id="en-date" type="date"></div><div class="fld"><label for="en-cat">Cat\u00e9gorie</label><select id="en-cat"><option value="charge">Charge</option><option value="taxe">Taxe</option><option value="produit">Produit</option><option value="od">OD</option></select></div><div class="fld"><label for="en-journal">Journal</label><input id="en-journal" value="OD"></div><div class="fld"><label for="en-label">Libell\u00e9</label><input id="en-label"></div><div class="fld"><label for="en-amount">Montant (FCFA)</label><input id="en-amount" inputmode="numeric"></div><div class="modal__nav"><button class="btn btn--ghost" id="en-cancel" type="button">Annuler</button><button class="btn btn--primary" id="en-save" type="button">Enregistrer</button></div>');
    $('en-cancel').addEventListener('click', closeModal);
    $('en-save').addEventListener('click', function () {
      var label = $('en-label').value.trim(), amount = cents($('en-amount').value);
      if (!label) { notify('Libell\u00e9 requis.', 'err'); return; }
      if (!(amount > 0)) { notify('Montant invalide.', 'err'); return; }
      $('en-save').disabled = true;
      api('/api/v1/accounting/entries', 'POST', { entry_date: $('en-date').value || undefined, category: $('en-cat').value, journal: $('en-journal').value.trim() || 'OD', label: label, amount_cents: amount, period: comptaPeriod() })
        .then(function (r) { closeModal(); notify(r.note || '\u00c9criture enregistr\u00e9e.', 'ok'); loadCompta(); })
        .catch(function (e) { $('en-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  function closePeriod() {
    var p = comptaPeriod();
    if (!window.confirm('Cl\u00f4turer la p\u00e9riode ' + p + ' ? Les \u00e9critures seront verrouill\u00e9es.')) return;
    api('/api/v1/accounting/close-period', 'POST', { period: p })
      .then(function (r) { notify(r.note || 'P\u00e9riode cl\u00f4tur\u00e9e.', 'ok'); loadCompta(); })
      .catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }
  /* ----- IMPAY\u00c9S & RECOUVREMENT ----- */
  var RK = { relance: 'Relance', promesse: 'Promesse', echeancier: '\u00c9ch\u00e9ancier', contentieux: 'Contentieux', encaissement: 'Encaissement' };
  function loadArrears() {
    return api('/api/v1/credits/arrears').then(function (d) {
      $('arrears-kpis').innerHTML = kpi(d.count || 0, 'Dossiers en impay\u00e9') + kpi(money(d.total_overdue_cents), 'Encours impay\u00e9', true);
      var l = d.arrears || [];
      if (!l.length) { $('arrears-table').innerHTML = '<div class="empty">Aucun dossier en impay\u00e9.</div>'; return; }
      var body = l.map(function (c) {
        return '<tr><td><b>' + esc(c.reference || '\u2014') + '</b></td><td>' + esc(c.client_name || '\u2014') + '<br><span class="hint" style="font-size:11px">' + esc(c.client_phone || '') + '</span></td><td>' + money(c.overdue_amount_cents) + '</td><td>' + esc(c.overdue_since ? String(c.overdue_since).slice(0, 10) : '\u2014') + '</td><td>' + esc(c.actions) + '</td><td style="text-align:right"><button class="btn btn--sm" data-ra="' + esc(c.id) + '" data-ref="' + esc(c.reference || '') + '">Action</button></td></tr>';
      }).join('');
      $('arrears-table').innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>R\u00e9f.</th><th>Client</th><th>Impay\u00e9</th><th>Depuis</th><th>Actions</th><th style="text-align:right"></th></tr></thead><tbody>' + body + '</tbody></table></div>';
      $('arrears-table').querySelectorAll('[data-ra]').forEach(function (b) { b.addEventListener('click', function () { openRecoveryModal(b.dataset.ra, b.dataset.ref); }); });
    }).catch(function (e) { if (guard(e)) return; if (e.message === 'forbidden' || e.message === 'missing_permission') forbidden('arrears-table', 'Acc\u00e8s non habilit\u00e9.'); else notify(fr(e), 'err'); });
  }
  function openRecoveryModal(id, ref) {
    openModal('<h3>Action de recouvrement</h3><p class="sub">' + esc(ref) + '</p><div class="fld"><label for="ra-kind">Type</label><select id="ra-kind"><option value="relance">Relance</option><option value="promesse">Promesse</option><option value="echeancier">\u00c9ch\u00e9ancier</option><option value="encaissement">Encaissement</option><option value="contentieux">Contentieux</option></select></div><div class="fld"><label for="ra-amount">Montant (FCFA, encaissement)</label><input id="ra-amount" inputmode="numeric"></div><div class="fld"><label for="ra-note">Note</label><textarea id="ra-note" rows="2"></textarea></div><div class="modal__nav"><button class="btn btn--ghost" id="ra-cancel" type="button">Annuler</button><button class="btn btn--primary" id="ra-save" type="button">Enregistrer</button></div>');
    $('ra-cancel').addEventListener('click', closeModal);
    $('ra-save').addEventListener('click', function () {
      $('ra-save').disabled = true;
      api('/api/v1/credits/' + encodeURIComponent(id) + '/recovery-actions', 'POST', { kind: $('ra-kind').value, amount_cents: cents($('ra-amount').value), note: $('ra-note').value.trim() || undefined })
        .then(function (r) { closeModal(); notify(r.note || 'Action enregistr\u00e9e.', 'ok'); loadArrears(); })
        .catch(function (e) { $('ra-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  /* ----- JOURNAL D'AUDIT ----- */
  function loadAudit() {
    return api('/api/v1/audit-log?limit=200').then(function (d) {
      var l = d.entries || [];
      if (!l.length) { $('audit-table').innerHTML = '<div class="empty">Aucun \u00e9v\u00e9nement.</div>'; return; }
      var body = l.map(function (a) {
        return '<tr><td>' + dt(a.created_at) + '</td><td>' + esc(a.actor_role || '\u2014') + '</td><td>' + esc(a.action || '\u2014') + '</td><td>' + esc(a.entity || '\u2014') + '</td><td><span class="hint" style="font-size:11px">' + esc(a.entity_id || '') + '</span></td></tr>';
      }).join('');
      $('audit-table').innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Date</th><th>R\u00f4le</th><th>Action</th><th>Entit\u00e9</th><th>R\u00e9f.</th></tr></thead><tbody>' + body + '</tbody></table></div>';
    }).catch(function (e) { if (guard(e)) return; if (e.message === 'forbidden' || e.message === 'missing_permission' || e.message === 'insufficient_privilege') forbidden('audit-table', 'Vous n\u2019\u00eates pas habilit\u00e9 \u00e0 consulter le journal d\u2019audit.'); else notify(fr(e), 'err'); });
  }
})();
