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
            if (!r.ok) { var er = new Error(d.error || ('http_' + r.status)); er.serverMessage = d.message || null; er.field = d.field || null; er.status = r.status; er.code = d.error || null; throw er; }
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
    var a = $('global-alert');
    if (!a) { try { (type === 'err' ? console.warn : console.log)(msg); } catch (e) {} return; }
    a.textContent = msg; a.className = 'alert alert--' + (type || 'info'); a.hidden = false;
    clearTimeout(notify._t);
    notify._t = setTimeout(function () { a.hidden = true; }, type === 'err' ? 12000 : 6000);
  }
  // Bandeau d'erreur PERSISTANT au-dessus de la modale ouverte : un échec de
  // création ne doit jamais rester invisible (l'alerte globale est masquée
  // par l'écran modal sur certains navigateurs).
  function modalNotice(msg, type) {
    var box = $('modal-notice');
    if (!box) {
      var card = document.querySelector('.modal__card') || document.querySelector('.modal-card') || document.querySelector('.modal');
      if (!card) { notify(msg, type); return; }
      box = document.createElement('div');
      box.id = 'modal-notice';
      box.className = 'modal-notice';
      card.insertBefore(box, card.firstChild);
    }
    box.className = 'modal-notice ' + (type === 'ok' ? 'ok' : 'err');
    box.textContent = msg;
    box.hidden = false;
    try { box.scrollIntoView({ block: 'nearest' }); } catch (_) {}
  }
  function modalNoticeClear() {
    var box = $('modal-notice');
    if (box) { box.hidden = true; box.textContent = ''; }
  }
  // Retour utilisateur garanti : bandeau de la modale + alerte globale.
  function fail(e) {
    var m = srv(e) || 'Une erreur est survenue.';
    try { modalNotice(m, 'err'); } catch (_) {}
    notify(m, 'err');
  }
  var MSG = { forbidden: 'Action non autorisée.', bad_hierarchy: 'Ordre hiérarchique invalide (direction → département → service → agence).',
    bad_parent: 'Unité parente invalide.', bad_unit: 'Unité invalide.', missing_fields: 'Champs obligatoires manquants.',
    invalid_kind: 'Type d’unité invalide.', missing_name: 'Le nom de l’unité est requis.', not_found: 'Élément introuvable.',
    weak_password: 'Mot de passe trop faible (10 car., majuscule, minuscule, chiffre).', invalid_current_password: 'Mot de passe actuel incorrect.',
    password_change_required: 'Votre mot de passe doit être changé.', idle_timeout: 'Session expirée (60 min d’inactivité).',
    session_expired: 'Session expirée.', invalid_session: 'Session invalide.', not_authenticated: 'Non connecté.',
    invalid_position: 'Ce poste n’existe pas dans le catalogue de votre institution. Choisissez un autre poste (page Organisation › Postes si besoin).',
    invalid_role: 'Ce poste ne permet pas de créer un compte (rôle non autorisé).',
    invalid_email: 'Adresse e-mail invalide.',
    timeout: 'Le serveur met trop de temps à répondre. Patientez puis réessayez.', supervisor_required: 'Un superviseur est requis pour ce poste.',
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
  var VIEWS = ['dash', 'org', 'users', 'dispatches', 'profiles', 'credits', 'clients', 'caisse', 'coffre', 'compta', 'recouvrement', 'gouvernance', 'audit', 'settings', 'security'];
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
    if (v === 'gouvernance') loadGouvernance();
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
  // Rendu BLINDÉ : il est appelé au démarrage et après chaque chargement de
  // données. Une donnée manquante (profil, unités, postes) ne doit JAMAIS
  // produire une « erreur » à l'écran ni bloquer le reste de la page.
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
      // Filet de sécurité : on n'affiche pas de trace technique au client.
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
      if (u0.position_code) {
        chipsHtml += '<span class="chip">Poste <b>' + esc((posByCode[u0.position_code] && posByCode[u0.position_code].label) || roleLabelForCode(u0.position_code)) + '</b></span>';
      }
      chips.innerHTML = chipsHtml;
    }
    // --- Indicateurs : on n'affiche QUE des chiffres fiables -----------------
    var unitsOk = Array.isArray(units) && units.length > 0;
    var usersOk = Array.isArray(users);
    var kpis = $('dash-kpis');
    if (kpis) {
      var U = Array.isArray(units) ? units : [];
      var W = Array.isArray(users) ? users : [];
      var html = kpi(U.length, 'Unités organisationnelles', true) +
        kpi(U.filter(function (u) { return u && u.kind === 'agency'; }).length, 'Agences') +
        kpi(usersOk ? W.length : '—', 'Utilisateurs') +
        kpi(usersOk ? W.filter(function (u) { return u && u.must_change_password; }).length : '—', 'Mot de passe à créer');
      kpis.innerHTML = html;
      kpis.classList.toggle('is-loading', !unitsOk && !usersOk);
    }
    // --- Alerte « sans responsable hiérarchique » ---------------------------
    var alertBox = $('dash-alert');
    if (alertBox) {
      if (!usersOk) {
        alertBox.innerHTML = '';
      } else {
        var noSup = users.filter(function (x) { return x && !x.parent_id; });
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
    // --- Mini-liste des unités ---------------------------------------------
    var miniBox = $('dash-units-mini');
    if (miniBox) {
      if (!unitsOk) {
        dashCardState(miniBox, 'Chargement de l’organisation…', 'Réessayer', function () { refreshDash(); });
      } else {
        var KINDS = (typeof KIND_ORDER === 'object' && KIND_ORDER) ? KIND_ORDER : {};
        var mini = units.filter(Boolean).slice().sort(function (a, b) {
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
  // Valeur d'indicateur : nombre compact et jamais « NaN » ni « undefined ».
  function kpiVal(v) {
    if (typeof v === 'number' && isFinite(v)) return String(v);
    if (typeof v === 'string' && v) return esc(v);
    return '—';
  }
  function kpi(v, l, dark) {
    return '<div class="kpi' + (dark ? ' kpi--dark' : '') + '"><b>' + kpiVal(v) + '</b><span>' + esc(l) + '</span></div>';
  }

  // ----- Organisation (arbre) -----
  // silent = true : rechargement de fond depuis le tableau de bord (pas de
  // notification d'erreur en double, pas de blocage de l'onglet Organisation).
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
        (units.length ? '' : '<button class="btn btn--primary btn--sm" id="org-seed">Générer la structure de base</button>') +
        '<button class="btn btn--ghost btn--sm" id="org-expand">Tout déplier</button>' +
        '<button class="btn btn--ghost btn--sm" id="org-collapse">Tout replier</button>' +
        '<div class="org-search"><input id="org-filter" type="search" placeholder="Rechercher une unité, une ville…" value="' + esc(orgQuery) + '" autocomplete="off"></div>' +
      '</div>' + caBanner() +
      (html || '<div class="org-nomatch">Aucune unité ne correspond à « ' + esc(orgQuery) + ' ».</div>');

    // Institution vide : un seul clic crée le Conseil d'Administration, les
    // Directions, Départements et Services du socle (tout reste modifiable).
    var sd = $('org-seed');
    if (sd) sd.addEventListener('click', seedStructure);
    var f = $('org-filter');
    if (f) f.addEventListener('input', function () {
      orgQuery = this.value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      // On restaure le focus et la position du curseur après re-rendu.
      renderTree();
      var nf = $('org-filter');
      if (nf) { nf.focus(); try { nf.setSelectionRange(nf.value.length, nf.value.length); } catch (_) {} }
    });
    // Les boutons de l'encart CA sont câblés UNE SEULE FOIS (au démarrage) :
    // un nouvel écouteur à chaque rendu de l'arbre finissait par exécuter
    // plusieurs fois la même action (double création / double appel API).
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
    return api('/api/v1/users').then(function (d) {
      users = (d && d.users) || [];
      try { renderUsers(); } catch (e) { if (window.console) console.warn('users:', e && e.message); }
      renderDash();
    }).catch(function (e) {
      if (guard(e)) return;
      if (silent) throw e;
      notify(fr(e), 'err');
      var box = $('users-table');
      if (box && !users.length) {
        box.innerHTML = '<div class="empty">' + esc(fr(e)) +
          '<br><button class="btn btn--ghost btn--sm" type="button" style="margin-top:10px" id="users-retry">Réessayer</button></div>';
        var b = $('users-retry'); if (b) b.addEventListener('click', function () { loadUsers(); });
      }
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
        else if (!sup) {
          var expL = expectedParentLabel(posOf(u) || {});
          supCell = '<button class="tag tag--warn" data-sup="' + u.id + '" title="Définir le responsable">⚠ Non défini</button>' +
            (expL ? '<br><small style="color:var(--muted)">à rattacher à : ' + esc(expL) + '</small>' : '');
        }
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
      var expLabel = expectedParentLabel(p);
      // Le responsable prévu est présélectionné s'il est déjà enregistré.
      var who = expLabel ? findByPositionLabel(expLabel) : null;
      var preId = (who && String(who.id) !== String(u.id)) ? String(who.id) : null;
      // Sinon : le meilleur candidat hiérarchique (jamais l'agent lui-même).
      if (!preId && !u.parent_id && expLabel) {
        var best = supervisorCandidates(p).filter(function (x) { return String(x.id) !== String(u.id); });
        if (best.length) preId = String(best[0].id);
      }
      var selId = u.parent_id ? String(u.parent_id) : preId;
      var cands = users.filter(function (x) {
        return x.is_active !== false && String(x.id) !== String(u.id);
      });
      var opts = cands.map(function (c) {
        var blocked = p.needsSupervisor && String(c.id) !== preId && !posSupervisesCollectors(posOf(c));
        return '<option value="' + esc(c.id) + '"' + (blocked ? ' disabled' : '') + '>' +
          esc(c.full_name + ' — ' + posLabelOf(c) + (blocked ? ' (non habilité)' : '')) + '</option>';
      }).join('');
      var pendNote = '';
      if (!u.parent_id && !preId && expLabel) {
        pendNote = '<small style="color:#b45309">Le poste de ' + esc(expLabel) +
          ' n’est pas encore pourvu (ou dépend d’un agent inexistant). Créez-le dans Personnel, puis revenez ici.</small>';
      }
      openModal(
        '<h3>Responsable hiérarchique</h3><p class="sub">' + esc(u.full_name) + ' · ' + esc(posLabelOf(u)) +
          (expLabel ? '<br>Responsable prévu pour ce poste : <b>' + esc(expLabel) + '</b>' : '') + '</p>' +
        '<div class="fld"><label for="sh-sup">Superviseur / Responsable hiérarchique</label>' +
          '<select id="sh-sup"><option value="">— Aucun (pas de responsable) —</option>' + opts + '</select>' +
          '<small style="color:var(--muted)">' + (p.needsSupervisor
            ? 'Obligatoire pour un agent de collecte : Chef d’agence ou Agent de crédit.'
            : 'Facultatif. Un agent ne peut jamais être son propre responsable.') + '</small>' +
          pendNote + '</div>' +
        '<div class="modal__nav"><button class="btn btn--ghost" id="sh-cancel">Annuler</button>' +
          '<button class="btn btn--primary" id="sh-ok">Enregistrer</button></div>'
      );
      var sel = $('sh-sup');
      if (selId) sel.value = selId;
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

  // CORRECTIF 13/11/2026-I — Le poste n'est plus jamais perdu.
  // Cause racine du message « Champ manquant » : la liste des postes venait
  // UNIQUEMENT du serveur. Si l'appel echouait (serveur en veille, reseau
  // lent) ou arrivait apres le clic, la liste etait vide, le poste choisi
  // n'existait plus et l'enregistrement echouait alors que tout etait rempli.
  // Le catalogue (43 postes) est desormais embarque dans le site : la liste
  // s'affiche immediatement, hors ligne comme en ligne. Le serveur reste
  // sollicite pour AJOUTER les postes personnalises de l'institution.
  function applyCatalog(cat) {
    if (!cat || !cat.positions) return;
    var base = cat.positions.filter(function (p) { return p && p.code; });
    var extras = positions.filter(function (p) {
      return p && p.code && !base.some(function (b) { return b.code === p.code; });
    });
    positions = base.concat(extras);
    if (cat.departments && cat.departments.length) posDepts = cat.departments;
    if (cat.services && cat.services.length) posServices = cat.services;
    posByCode = {}; positions.forEach(function (p) { posByCode[p.code] = p; });
  }
  function loadPositions() {
    if (!positions.length && window.TEEBO_CATALOG) { try { applyCatalog(window.TEEBO_CATALOG); } catch (_) {} }
    // Le serveur complete la liste (postes personnalises) ; en cas d'echec on
    // garde le catalogue embarque : l'ecran reste utilisable.
    return api('/api/v1/positions').then(function (d) {
      applyCatalog(d || {});
    }).catch(function () { return null; });
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
  // ------------------------------------------------------------------
  // Resolution ROBUSTE du poste choisi dans la modale « Nouvel utilisateur ».
  // Constat : le champ « Poste occupe » pouvait afficher un libelle correct
  // alors que la valeur envoyee restait vide (liste re-rendue apres un choix).
  // On resout donc le poste par CODE, puis par LIBELLE affiche (compare sans
  // accents / ponctuation), puis par correspondance partielle sur le libelle.
  // ------------------------------------------------------------------
  function resolvePositionByLabel(raw) {
    var n = normLabel(raw);
    if (!n || !positions.length) return null;
    var i, p, np;
    for (i = 0; i < positions.length; i++) {
      if (normLabel(positions[i].label) === n) return positions[i];
    }
    for (i = 0; i < positions.length; i++) {
      p = positions[i];
      if (normLabel(posShortLabel(p)) === n) return p;
    }
    // CORRECTIF 13/11/2026-H — resolution SURE du poste.
    // La liste affiche « Service — Libellé ». L'ancienne version acceptait
    // n'importe quelle inclusion de texte : « Directeur Général (DG) » se
    // retrouvait aussi dans « Directeur Général Adjoint (DGA) », d'où un poste
    // erroné (mauvais rôle, mauvaises habilitations, mauvais responsable).
    // Desormais : on essaie chaque morceau du texte affiche (de droite a
    // gauche), puis l'inclusion n'est retenue que si elle est UNIQUE ou
    // nettement plus longue que les autres. En cas de doute, on ne devine pas.
    var parts = String(raw).split(/\u2014|\u2013|\s-\s/);
    for (i = parts.length - 1; i >= 0; i--) {
      var t = normLabel(parts[i]);
      if (!t) continue;
      for (var j = 0; j < positions.length; j++) {
        if (normLabel(positions[j].label) === t) return positions[j];
      }
    }
    var hits = [];
    for (i = 0; i < positions.length; i++) {
      p = positions[i]; np = normLabel(p.label);
      if (!np) continue;
      if (np.indexOf(n) >= 0 || n.indexOf(np) >= 0) hits.push(p);
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      hits.sort(function (a, b) { return normLabel(b.label).length - normLabel(a.label).length; });
      if (normLabel(hits[0].label).length > normLabel(hits[1].label).length) return hits[0];
    }
    return null;
  }
  // Poste reellement selectionne : par valeur du champ, sinon par libelle.
  function currentPositionChoice() {
    var sel = $('u-new-pos');
    if (!sel) return { code: '', pos: null, label: '' };
    var code = String(sel.value || '');
    var label = '';
    if (sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) {
      label = String(sel.options[sel.selectedIndex].textContent || '');
    }
    var pos = code ? (posByCode[code] || null) : null;
    if (!pos && label) pos = resolvePositionByLabel(label);
    if (pos) code = pos.code;
    // CORRECTIF 13/11/2026-G : si la liste affiche « Service — Libellé », le
    // libellé seul ne correspond pas au texte complet. On essaie donc AUSSI la
    // partie droite (après le tiret) et la partie gauche, pour retrouver le
    // poste même si le préfixe du service diffère du catalogue.
    if (!pos && label) {
      var parts = String(label).split('—');
      if (parts.length > 1) {
        pos = resolvePositionByLabel(parts.pop()) || resolvePositionByLabel(parts.join('—'));
        if (pos) code = pos.code;
      }
    }
    return { code: code, pos: pos, label: label };
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
  // ---- Responsable attendu par APPELLATION (règle metier) ----------------
  // Chaque poste porte l'appellation de son responsable direct :
  //   Directeur General Adjoint -> Directeur General
  //   Chef de Caisse -> Chef d'Agence, Caissier -> Chef de Caisse, etc.
  // Un poste sans appellation (Directeur General) est le sommet : pas de
  // responsable. Une appellation dont la case n'est pas encore pourvue est
  // affichee en ATTENTE, et devient un choix des qu'un agent l'occupe.
  function expectedParentLabel(p) { return (p && p.parentLabel) ? String(p.parentLabel) : null; }
  function posShortLabel(p) {
    return String((p && p.label) || '').replace(/\s*[\/(].*$/, '').trim();
  }
  // Retrouve l'agent dont le poste porte une appellation donnee (ex. le DG).
  function findByPositionLabel(label) {
    if (!label) return null;
    var target = normLabel(label);
    return users.find(function (u) {
      if (u.is_active === false) return false;
      var up = posOf(u);
      if (up && normLabel(up.label) === target) return true;
      return normLabel(posLabelOf(u)) === target;
    }) || null;
  }
  function expectedOption(p) {
    var lab = expectedParentLabel(p);
    if (!lab) return '';
    var who = findByPositionLabel(lab);
    if (who && String(who.id) !== String(p.selfId || '')) {
      return '<option value="' + esc(who.id) + '">' + esc(lab + ' : ' + who.full_name) + '</option>';
    }
    // Appellation prevue mais personne a ce poste (ou soi-meme) : en attente.
    return '<option value="pending:' + esc(lab) + '">' + esc(lab) + ' (poste non pourvu)</option>';
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
      '<div class="fld"><label for="u-new-name">Nom complet</label><input id="u-new-name"></div>' +
      '<div class="fld"><label for="u-new-pos">Poste occupé</label><select id="u-new-pos"><option value="">— Choisir un poste —</option>' +
        positionOptionsHtml() + '</select>' +
        '<small id="u-new-pos-hint" style="color:var(--muted)">Le poste détermine automatiquement le rôle et les permissions.</small></div>' +
      '<div class="fld" id="u-new-sup-wrap" hidden><label for="u-new-sup">Superviseur / Responsable hiérarchique</label>' +
        '<select id="u-new-sup"></select>' +
        '<small id="u-new-sup-hint" style="color:var(--muted)">Pré-rempli d’après le poste ; vous pouvez le modifier.</small></div>' +
      '<div class="fld"><label for="u-new-unit">Unité de rattachement</label><select id="u-new-unit"><option value="">— Aucune —</option>' +
        units.map(function (u) { return '<option value="' + u.id + '">' + esc(KIND_META[u.kind].label + ' · ' + u.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="form-grid"><div class="fld"><label for="u-new-email">E-mail</label><input id="u-new-email" type="email"></div>' +
      '<div class="fld"><label for="u-new-phone">Téléphone (WhatsApp)</label><input id="u-new-phone" type="tel" placeholder="+226 00 00 00 00"></div></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="u-new-cancel">Annuler</button><button class="btn btn--primary" id="u-new-ok">Créer et envoyer le code</button></div>'
      );
      // À chaque choix de poste : on pré-remplit automatiquement le responsable
      // hiérarchique ET l'unité de rattachement correspondants.
      function syncFromPosition() {
        var pick = currentPositionChoice();
        var p = pick.pos;
        var wrap = $('u-new-sup-wrap'), sel = $('u-new-sup'), unitSel = $('u-new-unit');
        if (!p) { if (wrap) wrap.hidden = true; if (sel) sel.innerHTML = ''; return; }
        // Unité de rattachement : on l'affecte tout de suite, même si la liste
        // de responsables est réduite (le champ doit refléter la structure).
        var uidEarly = autoUnitForPosition(p);
        if (uidEarly) unitSel.value = uidEarly;
        // Liste de base : tous les agents de l'institution sauf soi-même.
        var cands = users.filter(function (x) {
          return x.is_active !== false && String(x.id) !== String(p.selfId || '');
        });
        // Sommet de l'organisation (ex. Directeur Général) : aucun responsable.
        if (!expectedParentLabel(p) && !cands.length) {
          sel.innerHTML = '<option value="">— Aucun (sommet de l’organisation) —</option>';
          wrap.hidden = false;
          var hu = $('u-new-sup-hint');
          if (hu) hu.textContent = 'Ce poste est au sommet : il n’a pas de responsable hiérarchique.';
          var uidS = autoUnitForPosition(p); if (uidS) unitSel.value = uidS;
          return;
        }
        // 1. Le responsable réel du poste est présélectionné s'il existe déjà.
        var who = findByPositionLabel(expectedParentLabel(p));
        var preId = null;
        if (who && String(who.id) !== String(p.selfId || '')) preId = who.id;
        // 2. Tous les agents possibles restent proposés : le champ est modifiable.
        var whoNow = who ? String(who.id) : null;
        var opts = cands.map(function (c) {
          var blocked = p.needsSupervisor && String(c.id) !== whoNow && !posSupervisesCollectors(posOf(c));
          return '<option value="' + esc(c.id) + '"' + (blocked ? ' disabled' : '') + '>' +
            esc(c.full_name + ' — ' + posLabelOf(c) + (blocked ? ' (non habilité)' : '')) + '</option>';
        }).join('');
        sel.innerHTML = '<option value="">— Aucun (pas de responsable) —</option>' + opts;
        if (preId) sel.value = preId;
        // 3. Message clair : pré-rempli, ou en attente de création du poste.
        var hint2 = $('u-new-sup-hint');
        if (hint2) hint2.textContent = expectedParentLabel(p)
          ? (preId
              ? 'Pré-rempli avec le ' + expectedParentLabel(p) + ' d’après le poste choisi — modifiable.'
              : 'Ce poste dépend du ' + expectedParentLabel(p) + ', qui n’est pas encore créé. Vous pourrez le rattacher plus tard via le bouton « Responsable » de la page Personnel.')
          : 'Facultatif ; vous pouvez choisir un responsable ou laisser « — Aucun — ».';
        // Le champ reste TOUJOURS visible et modifiable une fois un poste choisi :
        // plus de champ figé/vide sans possibilité de sélection.
        wrap.hidden = false;
        var uid = autoUnitForPosition(p);
        if (uid) unitSel.value = uid;
      }
      $('u-new-pos').addEventListener('change', syncFromPosition);
      // À l'ouverture : un poste est souvent déjà sélectionné (présélection) —
      // on synchronise immédiatement le responsable et l'unité correspondants.
      // Choix par defaut : le premier poste reste « — Choisir un poste — », mais
      // un clic sans selection ne doit jamais echouer en silence (voir plus bas).
      try { syncFromPosition(); } catch (_) {}
      // Si les postes n'étaient pas encore chargés, on rafraîchit la liste dès
      // qu'ils arrivent : plus de liste vide ni de « — Choisir un poste — »
      // bloquant en silence.
      loadPositions().then(function () {
        var sel = $('u-new-pos');
        if (!sel || !positions.length) return;
        // On memorise le choix par CODE et par LIBELLE : si la liste etait vide
        // a l'ouverture, elle est remplie ICI, puis le choix est restaure.
        var keep = currentPositionChoice();
        if (!keep.code && !keep.label) return;
        sel.innerHTML = '<option value="">— Choisir un poste —</option>' + positionOptionsHtml();
        if (keep.code && posByCode[keep.code]) {
          sel.value = keep.code;
        } else if (keep.label) {
          var found = resolvePositionByLabel(keep.label);
          if (found) sel.value = found.code;
        }
        try { syncFromPosition(); } catch (_) {}
      }).catch(function () {});
      // Garde-fou : si la liste ne contient qu'un seul choix, il reste
      // modifiable (« — Aucun — ») — rien n'est jamais verrouillé.
      $('u-new-sup').addEventListener('change', function () {
        if (isSelfSupervisor($('u-new-sup').value)) {
          $('u-new-sup').value = '';
          notify('Vous ne pouvez pas vous désigner vous-même comme responsable hiérarchique.', 'err');
        }
      });
      // Protection : les deux boutons de la modale sont posés explicitement
      // (un champ manquant ne doit jamais casser l'enregistrement du clic).
      var btnCancel = $('u-new-cancel'), btnOk = $('u-new-ok');
      if (btnCancel) btnCancel.addEventListener('click', closeModal);
      if (btnOk) btnOk.addEventListener('click', function () {
        var btn = this;
        modalNoticeClear();
        // CONSERVÉ par prudence : sur certaines versions du moteur JS de
        // navigateur, lire un champ situé après un bloc masqué peut lever une
        // erreur silencieuse qui interrompt le clic AVANT tout appel serveur.
        // On lit donc chaque champ séparément, avec protection.
        function val(id) {
          // CORRECTIF 14/11/2026 : lecture STRICTEMENT limitee a la modale.
          // Les champs sont prefixes u-new-* : plus aucune collision avec la
          // barre laterale (b#detail-u-name) qui renvoyait undefined.
          var root = $('modal-root') || document;
          var el = root.querySelector('#' + id) || $('u-new-' + id) || null;
          if (!el && id === 'u-name') el = root.querySelector('input#u-new-name');
          return el ? String(el.value || '') : '';
        }
        // Resolution robuste : la valeur du champ, sinon le libelle affiche.
        var pick = currentPositionChoice();
        var posCode = pick.code || val('u-new-pos');
        var pos = pick.pos || posByCode[posCode] || null;
        if (pos && pos.code) posCode = pos.code;
        // CORRECTIF 13/11/2026-I — dernier filet : si un poste est AFFICHE
        // mais pas encore resolu (catalogue arrive juste apres le clic), on le
        // resout ici, une derniere fois, sur le libelle exact du select.
        if (!posCode) {
          var selEl = $('u-new-pos');
          if (selEl && selEl.selectedIndex > 0 && selEl.options[selEl.selectedIndex]) {
            var txtSel = String(selEl.options[selEl.selectedIndex].textContent || '');
            var rs = resolvePositionByLabel(txtSel);
            if (rs) { pos = rs; posCode = rs.code; }
          }
        }
        // FILET DE SÉCURITÉ 13/11/2026-G : si la valeur du sélecteur s'est vidée
        // (liste re-rendue) mais qu'un poste était choisi, on le retrouve par
        // son libellé. Le poste n'est donc plus jamais « perdu » à l'envoi.
        if (!posCode && pick.label) {
          var secours = resolvePositionByLabel(pick.label);
          if (secours) { pos = secours; posCode = secours.code; }
        }
        var posLabel = (pos && pos.label) || (pick.label && String(pick.label).split('—').pop().trim()) || null;
        var body = { full_name: val('u-name').trim(), position_code: posCode || null,
          position_label: posLabel,
          org_unit_id: val('u-new-unit') || null, email: val('u-new-email').trim(), phone: val('u-new-phone').trim() };
        var supEl = $('u-new-sup'), supWrap = $('u-new-sup-wrap');
        var supId = (supEl && supWrap && !supWrap.hidden && supEl.value) ? String(supEl.value) : null;
        if (supId && supId.indexOf('pending:') === 0) supId = null;
        if (supId) body.supervisor_id = supId;
        // Rôle de secours : si le poste n'a pas encore été résolu (chargement
        // des postes plus lent que la saisie), on l'envoie explicitement.
        if (pos && pos.role) body.role = pos.role;
        // Filet de securite serveur : si le code manquait, le libelle permet
        // au serveur de retrouver le poste exact au lieu de refuser.
        if (pos && pos.label) body.position_label = pos.label;

        if (!body.full_name || !body.email || !body.position_code) {
          // Le poste est vérifié EN PREMIER : c'est le seul champ que
          // l'application peut perdre seule. Un message qui accuse le nom
          // complet alors qu'il est rempli serait trompeur.
          if (!body.position_code) {
            var mP = (body.full_name ? '' : 'Champ manquant : le nom complet. ') +
              'Le poste occupé n’a pas pu être lu. Choisissez-le de nouveau dans la liste « Poste occupé » puis validez.';
            modalNotice(mP, 'err'); notify(mP, 'err');
            try { var sp = $('u-new-pos'); if (sp) sp.focus(); } catch (_) {}
            return;
          }
          var manque = [];
          if (!body.full_name) manque.push('le nom complet');
          if (!body.email) manque.push('l’adresse e-mail');
          if (!body.position_code) manque.push('le poste (sélectionnez-le dans « Poste occupé »)');
          var mReq = 'Champ manquant : ' + manque.join(', ') + '.';
          modalNotice(mReq, 'err'); notify(mReq, 'err');
          if (!body.position_code) { try { var selPos = $('u-new-pos'); if (selPos) selPos.focus(); } catch (_) {} }
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) { modalNotice('Adresse e-mail invalide : vérifiez la saisie.', 'err'); notify('Adresse e-mail invalide.', 'err'); return; }
        if (isSelfSupervisor(supId)) { modalNotice('Vous ne pouvez pas être votre propre responsable hiérarchique.', 'err'); return; }
        if (pos && pos.needsSupervisor && !supId) {
          var who = expectedParentLabel(pos);
          var m1 = 'Un agent de collecte doit être rattaché à un ' + (who || 'Chef d’agence ou Agent de crédit') +
            '. Si ce poste n’est pas encore pourvu, créez d’abord le ' + (who || 'responsable') + '.';
          modalNotice(m1, 'err'); notify(m1, 'err'); return;
        }
        btn.disabled = true;
        var libelle = btn.textContent;
        btn.textContent = 'Création en cours…';
        // CORRECTIF 13/11/2026-H — Le bouton ne doit JAMAIS rester bloqué sur
        // « Création en cours… ». Si le serveur ne répond pas (visite sur
        // l'offre gratuite Render, coupure, 502), l'écran restait figé et
        // l'on croyait à une erreur de champ. On rend la main au bout de 45 s
        // avec un message clair, quoi qu'il arrive.
        var resetBtn = function () {
          try { btn.disabled = false; btn.textContent = libelle; } catch (_) {}
        };
        var gardeTemps = setTimeout(function () {
          resetBtn();
          var mT = 'Le serveur met trop de temps à répondre (il est peut-être en veille). Patientez 30 secondes puis cliquez de nouveau sur « Créer et envoyer le code ».';
          modalNotice(mT, 'err'); notify(mT, 'err');
        }, 45000);
        // On n'utilise PAS « this » : il est perdu dans la chaîne de promesses.
        api('/api/v1/users', 'POST', body).then(function (d) {
          clearTimeout(gardeTemps);
          modalNoticeClear();
          closeModal();
          var nom = body.full_name;
          return loadUsers().then(function () {
            notify('Utilisateur créé — code ' + ((d && d.code_user) || '').toString() + '.', 'ok');
            showSendCodeModal(d, nom);
          });
        }).catch(function (e) {
          clearTimeout(gardeTemps);
          btn.disabled = false; btn.textContent = libelle;
          if (guard(e)) return;
          // Le compte peut avoir été créé malgré une coupure pendant la réponse.
          // CORRECTIF 13/11/2026-H — Diagnostic lisible au lieu d'un message
          // vague : on indique le code HTTP renvoyé par le serveur et l'action.
          if (e && e.status && e.status >= 500) {
            var m5 = 'Le serveur a renvoyé une erreur ' + e.status +
              ' : la création n\u2019a pas abouti. Rechargez la page (Ctrl+Shift+R) et réessayez ; si cela se répète, le service serveur doit être relancé depuis son hébergement.';
            modalNotice(m5, 'err'); notify(m5, 'err');
            return;
          }
          if (e && (e.message === 'invalid_position' || e.code === 'invalid_position')) {
            var m6 = (e.serverMessage || 'Ce poste n\u2019existe pas dans le catalogue de votre institution.') +
              ' Rechargez la page (Ctrl+Shift+R) puis choisissez de nouveau le poste dans la liste.';
            modalNotice(m6, 'err'); notify(m6, 'err');
            return;
          }
          if (e && (e.message === 'forbidden' || e.status === 403)) {
            var m7 = 'Votre compte n\u2019a pas le droit de créer des utilisateurs (ou le rattachement choisi est hors de votre institution).';
            modalNotice(m7, 'err'); notify(m7, 'err');
            return;
          }
          if (e && e.message === 'network') {
            loadUsers();
            var m2 = 'Création incertaine : le serveur n’a pas répondu. Vérifiez la liste du personnel — si le nom apparaît, le compte est créé (utilisez « Renvoyer le code »). Sinon, réessayez.';
            modalNotice(m2, 'err'); notify(m2, 'err');
            return;
          }
          fail(e);
        });
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
  // 1) /me (indispensable) -> rendu immédiat.
  // 2) Unités + utilisateurs en PARALLÈLE (avant : l'un après l'autre).
  // 3) Modules secondaires (essai, catalogue des postes) en arrière-plan.
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
    var nU = $('detail-u-name'); if (nU) nU.textContent = u.full_name || '—';
    var nC = $('detail-u-code'); if (nC) nC.textContent = (u.code_user || '—') + (me.imf_code ? ' · ' + me.imf_code : '');
    // Paramètres IMF : accessible à l'admin, à la direction et au PCA.
    var canSee = ['admin_imf', 'direction', 'superadmin', 'pca_admin'].indexOf(effRole(u)) >= 0;
    var navS = $('nav-settings'); if (navS) navS.hidden = !canSee;
    var navD = $('nav-dispatches'); if (navD) navD.hidden = !canSee;
    var navP = $('nav-profiles'); if (navP) navP.hidden = !canSee;
    // Validation finale des crédits : réservée aux postes habilités.
    var canFinal = !!me.can_validate_credit_final || canSee;
    var navC = $('nav-credits'); if (navC) navC.hidden = !canFinal;
    return true;
  }

  function boot() {
    // Rendu immédiat du squelette : plus d'écran figé sur « Chargement… ».
    renderDash();
    bootProgress();
    api('/api/v1/auth/me').then(function (d) {
      if (!setupMe(d)) return null;
      // Catalogue des postes : en tâche de fond, sans retarder l'affichage.
      loadPositions().catch(function () {});
      // Modules opérationnels et réglages : une seule fois, non bloquant.
      try { setupBankingNav(); } catch (e) {}
      try { initSettingsHandlers(); } catch (e) {}
      var bnP = $('btn-new-perm'); if (bnP) bnP.addEventListener('click', openNewPermModal);
      var bnPos = $('btn-new-position'); if (bnPos) bnPos.addEventListener('click', openNewPositionModal);
      var bnCr = $('btn-credits-refresh'); if (bnCr) bnCr.addEventListener('click', loadCreditsQueue);
      renderDash();
      // Données en parallèle.
      var pUnits = loadUnits(true).then(function () { BOOT.units = true; })
        .catch(function (e) { BOOT.units = true; if (!guard(e)) notify(fr(e), 'err'); });
      var pUsers = loadUsers(true).then(function () { BOOT.users = true; })
        .catch(function (e) { BOOT.users = true; if (!guard(e)) notify(fr(e), 'err'); });
      return Promise.all([pUnits, pUsers]);
    }).then(function () {
      renderDash(); bootProgress(); renderSession();
      // Bandeau d'essai : jamais bloquant pour l'affichage.
      loadTrial();
      // 2FA obligatoire : on ouvre directement « Mon accès ».
      var pending = false;
      try { pending = sessionStorage.getItem('teebo_2fa_enroll') === '1'; } catch (e) {}
      if (pending) {
        try { sessionStorage.removeItem('teebo_2fa_enroll'); } catch (e) {}
        switchView('security');
        notify('Activation de la double authentification requise pour continuer.', 'info');
        return;
      }
      // Lien direct (ex. « /app#org ») : on ouvre l'onglet demandé.
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
      'nav-gouvernance': true,
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

  /* ===== VAGUE 27 : GOUVERNANCE & CONFORMITÉ ===== */
  var GOUV = { loaded: false, tab: 'institution', inst: null, organes: [], membres: [], users: [], mandats: [], sessions: [], resolutions: [], dash: null };
  var GOUV_READY = false;

  function gouvCanWrite() { return !!me && ['admin_imf', 'direction', 'superadmin', 'pca_admin'].indexOf(effRole(me.user)) >= 0; }
  function gouvDate(d) { return d ? String(d).slice(0, 10) : ''; }
  function gouvDateFr(d) { return d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('fr-FR') : '\u2014'; }
  function gouvMoney(c) { return c == null ? '\u2014' : fmtAmount(Number(c) / 100) + ' FCFA'; }
  function gouvOpts(list, sel, placeholder) {
    return '<option value="">' + esc(placeholder || '\u2014 choisir \u2014') + '</option>' + list.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(sel == null ? '' : sel) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('');
  }
  function gouvBadge(txt, kind) {
    var cls = { ok: 'g-badge g-badge--ok', warn: 'g-badge g-badge--warn', bad: 'g-badge g-badge--bad', info: 'g-badge g-badge--info' }[kind || 'info'];
    return '<span class="' + cls + '">' + esc(txt) + '</span>';
  }

  function setupGouvernance() {
    if (GOUV_READY) return;
    GOUV_READY = true;
    var t = $('gouv-tabs');
    if (!t) return;
    t.querySelectorAll('[data-gtab]').forEach(function (b) {
      b.addEventListener('click', function () {
        GOUV.tab = b.dataset.gtab;
        t.querySelectorAll('[data-gtab]').forEach(function (x) { x.classList.toggle('active', x === b); });
        ['institution', 'organes', 'membres', 'mandats', 'sessions', 'resolutions', 'actionnariat'].forEach(function (k) {
          var p = $('gouv-pane-' + k); if (p) p.hidden = k !== GOUV.tab;
        });
        if (GOUV.tab === 'actionnariat') loadCapital(false);
      });
    });
    var rf = $('btn-gouv-refresh'); if (rf) rf.addEventListener('click', function () { GOUV.loaded = false; G29.loaded = false; loadGouvernance(true); });
    var pdf = $('btn-gouv-pdf'); if (pdf) pdf.addEventListener('click', exportGouvernancePdf);
    setupGouvernance29();
  }

  /* -----------------------------------------------------------------------
     CHARGEMENT GROUPÉ (14/11/2026) — cause des erreurs « 502 Bad Gateway ».
     La page lançait 20 requêtes en même temps (7 gouvernance + 8 conformité
     + 5 actionnariat). Sur le serveur d'hébergement, cette rafale saturait le
     proxy : 502, page bloquée sur « Chargement… », et chaque appel était en
     plus retenté 4 fois — d'où l'effet boule de neige.

     Désormais UN SEUL appel ramène toutes les données. Si ce chargement
     groupé n'est pas disponible (ancien serveur pas encore mis à jour), on
     revient automatiquement aux appels séparés : la page fonctionne dans
     tous les cas.
  ------------------------------------------------------------------------- */
  var GOUV_OVERVIEW = { data: null, at: 0, busy: null };

  function gouvOverview(force) {
    var TTL = 8000;
    if (!force && GOUV_OVERVIEW.data && (Date.now() - GOUV_OVERVIEW.at) < TTL) {
      return Promise.resolve(GOUV_OVERVIEW.data);
    }
    if (GOUV_OVERVIEW.busy) return GOUV_OVERVIEW.busy;
    GOUV_OVERVIEW.busy = api('/api/v1/governance/overview' + (force ? '?refresh=1' : ''))
      .then(function (d) {
        if (!d || !d.sections) { var e = new Error('overview_absente'); e.legacy = true; throw e; }
        GOUV_OVERVIEW.data = d; GOUV_OVERVIEW.at = Date.now();
        GOUV_OVERVIEW.busy = null;
        return d;
      }, function (e) {
        GOUV_OVERVIEW.busy = null;
        if (e && e.status === 404) { var l = new Error('overview_absente'); l.legacy = true; throw l; }
        throw e;
      });
    return GOUV_OVERVIEW.busy;
  }

  /* Une section du chargement groupé est-elle exploitable ? */
  function gouvSection(nom) {
    var d = GOUV_OVERVIEW.data;
    var s = d && d.sections ? d.sections[nom] : null;
    return (s && !s.unavailable && !s.error) ? s : null;
  }

  function loadGouvernance(force) {
    setupGouvernance();
    return gouvOverview(!!force).then(function () {
      appliquerGouvernance();
      renderGouvernance();
    }).catch(function (e) {
      if (e && e.legacy) return loadGouvernanceSepare();
      if (guard(e)) return;
      if (e.message === 'forbidden' || e.message === 'use_teebo_console') return forbidden('gouv-kpis', 'Module réservé aux institutions.');
      notify(fr(e), 'err');
      var k = $('gouv-kpis'); if (k) k.innerHTML = '<div class="empty">Chargement impossible. Réessayez.</div>';
    });
  }

  /* Répartit les sections du chargement groupé dans la mémoire de l'écran. */
  function appliquerGouvernance() {
    var i = gouvSection('institution'); if (i) GOUV.inst = i;
    var o = gouvSection('organes'); if (o) { GOUV.organes = o.organes || []; GOUV.gouvDefaults = o.defaults || []; }
    var m = gouvSection('membres'); if (m) { GOUV.membres = m.membres || []; GOUV.users = m.users || []; }
    var md = gouvSection('mandats'); if (md) { GOUV.mandats = md.mandats || []; GOUV.mandatsMembres = md.membres || []; GOUV.cumul = md.alertesCumul || []; }
    var se = gouvSection('sessions'); if (se) { GOUV.sessions = se.sessions || []; GOUV.sessionsOrganes = se.organes || []; }
    var re = gouvSection('resolutions'); if (re) { GOUV.resolutions = re.resolutions || []; GOUV.resSessions = re.sessions || []; GOUV.resOrganes = re.organes || []; }
    var da = gouvSection('dashboard'); if (da) GOUV.dash = da;
    GOUV.loaded = true;
  }

  /* Repli : anciens appels séparés (si le serveur n'a pas encore la mise à jour). */
  function loadGouvernanceSepare() {
    return Promise.all([
      api('/api/v1/governance/institution'),
      api('/api/v1/governance/organes'),
      api('/api/v1/governance/membres'),
      api('/api/v1/governance/mandats'),
      api('/api/v1/governance/sessions'),
      api('/api/v1/governance/resolutions'),
      api('/api/v1/governance/dashboard')
    ]).then(function (r) {
      GOUV.inst = r[0]; GOUV.organes = r[1].organes || []; GOUV.gouvDefaults = r[1].defaults || [];
      GOUV.membres = r[2].membres || []; GOUV.users = r[2].users || [];
      GOUV.mandats = r[3].mandats || []; GOUV.mandatsMembres = r[3].membres || []; GOUV.cumul = r[3].alertesCumul || [];
      GOUV.sessions = r[4].sessions || []; GOUV.sessionsOrganes = r[4].organes || [];
      GOUV.resolutions = r[5].resolutions || []; GOUV.resSessions = r[5].sessions || []; GOUV.resOrganes = r[5].organes || [];
      GOUV.dash = r[6]; GOUV.loaded = true;
      renderGouvernance();
    }).catch(function (e) {
      if (guard(e)) return;
      if (e.message === 'forbidden' || e.message === 'use_teebo_console') return forbidden('gouv-kpis', 'Module réservé aux institutions.');
      notify(fr(e), 'err');
      var k = $('gouv-kpis'); if (k) k.innerHTML = '<div class="empty">Chargement impossible. Réessayez.</div>';
    });
  }

  function renderGouvernance() {
    var d = GOUV.dash || { kpis: {}, alertes: [] };
    var k = d.kpis || {};
    var score = Number(k.score_conformite || 0);
    var sc = score >= 85 ? 'ok' : (score >= 60 ? 'warn' : 'bad');
    $('gouv-kpis').innerHTML =
      '<div class="kpi kpi--dark"><b>' + score + ' / 100</b><span>Score de conformité</span></div>' +
      kpi(k.organes || 0, 'Organes statutaires') +
      kpi(k.membres || 0, 'Membres actifs') +
      kpi(k.mandats_en_cours || 0, 'Mandats en cours') +
      kpi(k.sessions || 0, 'Sessions tenues') +
      kpi(k.pv_signes || 0, 'PV signés / verrouillés') +
      kpi(k.resolutions_retard || 0, 'Résolutions en retard') +
      kpi(k.taux_execution_resolutions || 0, 'Avancement moyen (%)');
    var al = d.alertes || [];
    $('gouv-alerts').innerHTML = al.length
      ? '<span class="chip chip--warn"><b>' + al.length + '</b> point(s) à corriger</span>' +
        al.slice(0, 12).map(function (a) {
          var cls = a.niveau === 'CRITIQUE' ? 'chip chip--warn' : (a.niveau === 'HAUTE' ? 'chip chip--warn' : 'chip');
          return '<span class="' + cls + '">' + esc(a.texte) + '</span>';
        }).join('')
      : '<span class="chip chip--ok">Aucun écart détecté — gouvernance conforme</span>';
    renderGouvInstitution(); renderGouvOrganes(); renderGouvMembres();
    renderGouvMandats(); renderGouvSessions(); renderGouvResolutions();
    renderGouvActionnariat();
    loadGouvernance29(false);
    void sc;
  }

  /* --- Onglet 1 : fiche institution (pré-remplie) --- */
  function renderGouvInstitution() {
    var i = (GOUV.inst && GOUV.inst.institution) || {};
    var saved = GOUV.inst && GOUV.inst.saved;
    var dis = gouvCanWrite() ? '' : ' disabled';
    function f(id, label, val, hint, type) {
      return '<div class="fld"><label for="gi-' + id + '">' + esc(label) +
        (hint ? ' <span class="hint" style="font-weight:400">' + esc(hint) + '</span>' : '') +
        '</label><input id="gi-' + id + '" type="' + (type || 'text') + '" value="' + esc(val == null ? '' : val) + '"' + dis + '></div>';
    }
    var formes = [['SA', 'Société Anonyme (SA)'], ['SAS', 'SAS'], ['SARL', 'SARL'], ['COOPERATIVE', 'Coopérative'], ['SCOOPS', 'SCOOPS'], ['ASSOCIATION', 'Association'], ['GIE', 'GIE'], ['AUTRE', 'Autre']];
    $('gouv-pane-institution').innerHTML =
      '<div class="chips" style="margin-bottom:16px">' +
        '<span class="chip chip--ok">Pré-remplissage automatique depuis la fiche IMF et les paramètres légaux</span>' +
        (saved ? '<span class="chip">Fiche déjà enregistrée</span>' : '<span class="chip chip--warn">Aucune fiche enregistrée — vérifiez puis validez</span>') +
      '</div>' +
      '<div class="g-grid">' +
        f('raison_sociale', 'Raison sociale', i.raison_sociale, 'reprise du nom de l’IMF') +
        '<div class="fld"><label for="gi-forme">Forme juridique <span class="hint" style="font-weight:400">déduite du type d’IMF</span></label><select id="gi-forme"' + dis + '>' + gouvOpts(formes, i.forme_juridique, '\u2014 choisir \u2014') + '</select></div>' +
        f('rccm', 'RCCM', i.rccm, 'repris des paramètres légaux') +
        f('ifu_nif', 'IFU / NIF', i.ifu_nif, 'repris des paramètres légaux') +
        f('numero_agrement', 'N° d’agrément BCEAO', i.numero_agrement, 'repris de la fiche IMF') +
        f('date_agrement', 'Date d’agrément', gouvDate(i.date_agrement), '', 'date') +
        f('capital', 'Capital social (FCFA)', i.capital_social_cents != null ? Math.round(Number(i.capital_social_cents) / 100) : '', 'repris de la fiche IMF') +
        f('siege_social', 'Siège social', i.siege_social, 'adresse légale déjà connue') +
        f('pays', 'Pays', i.pays) + f('ville', 'Ville', i.ville) +
        f('telephone', 'Téléphone', i.telephone) + f('email', 'E-mail', i.email, '', 'email') +
        f('site_web', 'Site web', i.site_web) +
        f('president_ca', 'Président du Conseil d’Administration', i.president_ca, 'déduit du poste PCA') +
        f('directeur_general', 'Directeur Général', i.directeur_general, 'déduit du poste DG') +
        f('nombre_administrateurs', 'Nombre d’administrateurs', i.nombre_administrateurs, 'compté dans les membres', 'number') +
        f('nombre_femmes_dirigeantes', 'dont femmes', i.nombre_femmes_dirigeantes, 'compté automatiquement', 'number') +
        f('date_derniere_ag', 'Dernière Assemblée Générale', gouvDate(i.date_derniere_ag), '', 'date') +
        f('date_prochaine_ag', 'Prochaine Assemblée Générale', gouvDate(i.date_prochaine_ag), '', 'date') +
      '</div>' +
      '<div class="fld"><label for="gi-obs">Observations</label><textarea id="gi-obs" rows="2"' + dis + '>' + esc(i.observations || '') + '</textarea></div>' +
      (gouvCanWrite() ? '<div class="modal__nav" style="justify-content:flex-start"><button class="btn btn--primary" id="btn-gi-save" type="button">Enregistrer la fiche</button></div>' : '<p class="hint">Consultation seule : votre poste ne permet pas de modifier la fiche.</p>');
    var sv = $('btn-gi-save');
    if (sv) sv.addEventListener('click', function () {
      sv.disabled = true;
      var body = {
        raison_sociale: $('gi-raison_sociale').value.trim(), forme_juridique: $('gi-forme').value || null,
        rccm: $('gi-rccm').value.trim(), ifu_nif: $('gi-ifu_nif').value.trim(),
        numero_agrement: $('gi-numero_agrement').value.trim(), date_agrement: $('gi-date_agrement').value || null,
        capital_social_cents: $('gi-capital').value ? cents($('gi-capital').value) : null,
        siege_social: $('gi-siege_social').value.trim(), pays: $('gi-pays').value.trim(), ville: $('gi-ville').value.trim(),
        telephone: $('gi-telephone').value.trim(), email: $('gi-email').value.trim(), site_web: $('gi-site_web').value.trim(),
        president_ca: $('gi-president_ca').value.trim(), directeur_general: $('gi-directeur_general').value.trim(),
        nombre_administrateurs: $('gi-nombre_administrateurs').value || null,
        nombre_femmes_dirigeantes: $('gi-nombre_femmes_dirigeantes').value || null,
        date_derniere_ag: $('gi-date_derniere_ag').value || null, date_prochaine_ag: $('gi-date_prochaine_ag').value || null,
        observations: $('gi-obs').value.trim()
      };
      api('/api/v1/governance/institution', 'PUT', body)
        .then(function () { notify('Fiche de gouvernance enregistrée.', 'ok'); GOUV.loaded = false; loadGouvernance(true); })
        .catch(function (e) { sv.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  /* --- Onglet 2 : organes --- */
  function renderGouvOrganes() {
    var l = GOUV.organes || [];
    var head = '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">' +
      '<p class="hint" style="margin:0">Les organes obligatoires (Conseil, Comités, Assemblée Générale, Direction) peuvent être créés en un clic.</p>' +
      (gouvCanWrite() ? '<div style="display:flex;gap:8px"><button class="btn btn--ghost" id="btn-gn-seed" type="button">Générer les organes de base</button><button class="btn btn--primary" id="btn-gn-new" type="button">+ Nouvel organe</button></div>' : '') +
      '</div>';
    var body = l.length ? '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Organe</th><th>Type</th><th>Membres</th><th>Quorum</th><th>Fréquence</th><th>Dernière session</th><th>Statut</th><th></th></tr></thead><tbody>' +
      l.map(function (o) {
        return '<tr><td><b>' + esc(o.libelle) + '</b><br><span class="hint" style="font-size:11px">' + esc(o.code_organe) + (o.obligatoire ? ' \u00b7 obligatoire' : '') + '</span></td>' +
          '<td>' + esc(gouvLabelType(o.type_organe)) + '</td>' +
          '<td>' + (o.membres_reels || 0) + ' / ' + (o.nombre_membres || 0) + '</td>' +
          '<td>' + (o.quorum_requis || 0) + '</td>' +
          '<td>' + esc(gouvLabelFreq(o.frequence_reunion)) + '</td>' +
          '<td>' + (o.derniere_session ? gouvDateFr(o.derniere_session) : '\u2014') + '</td>' +
          '<td>' + gouvBadge(o.statut, o.statut === 'ACTIF' ? 'ok' : 'warn') + '</td>' +
          '<td style="text-align:right">' + (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" data-gn-edit="' + esc(o.id) + '" type="button">Modifier</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">Aucun organe enregistré.</div>';
    $('gouv-pane-organes').innerHTML = head + body;
    var sd = $('btn-gn-seed');
    if (sd) sd.addEventListener('click', function () {
      sd.disabled = true;
      api('/api/v1/governance/organes/seed', 'POST', {})
        .then(function () { notify('Organes de base générés.', 'ok'); GOUV.loaded = false; G29.loaded = false; GOUV_OVERVIEW.at = 0; loadGouvernance(true); })
        .catch(function (e) { sd.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
    var nw = $('btn-gn-new'); if (nw) nw.addEventListener('click', function () { openOrganeModal(null); });
    $('gouv-pane-organes').querySelectorAll('[data-gn-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var o = (GOUV.organes || []).filter(function (x) { return x.id === b.dataset.gnEdit; })[0];
        openOrganeModal(o || null);
      });
    });
  }
  function gouvLabelType(t) {
    return { CONSEIL_ADMINISTRATION: 'Conseil d’Administration', COMITE_AUDIT: 'Comité d’Audit', COMITE_RISQUE: 'Comité des Risques', COMITE_CREDIT: 'Comité de Crédit', COMITE_ALM: 'Comité ALM', ASSEMBLEE_GENERALE: 'Assemblée Générale', DIRECTION_GENERALE: 'Direction Générale', AUTRE: 'Autre' }[t] || t || '\u2014';
  }
  function gouvLabelFreq(f) {
    return { MENSUELLE: 'Mensuelle', BIMESTRIELLE: 'Bimestrielle', TRIMESTRIELLE: 'Trimestrielle', SEMESTRIELLE: 'Semestrielle', ANNUELLE: 'Annuelle', A_LA_DEMANDE: 'À la demande' }[f] || f || '\u2014';
  }
  function openOrganeModal(o) {
    var isNew = !o;
    o = o || {};
    var types = [['CONSEIL_ADMINISTRATION', 'Conseil d’Administration'], ['COMITE_AUDIT', 'Comité d’Audit'], ['COMITE_RISQUE', 'Comité des Risques'], ['COMITE_CREDIT', 'Comité de Crédit'], ['COMITE_ALM', 'Comité ALM'], ['ASSEMBLEE_GENERALE', 'Assemblée Générale'], ['DIRECTION_GENERALE', 'Direction Générale'], ['AUTRE', 'Autre']];
    var freqs = [['TRIMESTRIELLE', 'Trimestrielle'], ['MENSUELLE', 'Mensuelle'], ['BIMESTRIELLE', 'Bimestrielle'], ['SEMESTRIELLE', 'Semestrielle'], ['ANNUELLE', 'Annuelle'], ['A_LA_DEMANDE', 'À la demande']];
    openModal('<h3>' + (isNew ? 'Nouvel organe' : 'Modifier l’organe') + '</h3><p class="sub">' + esc(o.libelle || '') + '</p>' +
      '<div class="fld"><label for="go-lib">Libellé</label><input id="go-lib" value="' + esc(o.libelle || '') + '"></div>' +
      '<div class="fld"><label for="go-type">Type</label><select id="go-type">' + gouvOpts(types, o.type_organe, '\u2014 choisir \u2014') + '</select></div>' +
      '<div class="fld"><label for="go-freq">Fréquence des réunions</label><select id="go-freq">' + gouvOpts(freqs, o.frequence_reunion, '\u2014 choisir \u2014') + '</select></div>' +
      '<div class="fld"><label for="go-mem">Nombre de membres</label><input id="go-mem" type="number" value="' + esc(o.nombre_membres || 0) + '"></div>' +
      '<div class="fld"><label for="go-quo">Quorum requis</label><input id="go-quo" type="number" value="' + esc(o.quorum_requis || 0) + '"></div>' +
      '<div class="fld"><label for="go-base">Base réglementaire</label><input id="go-base" value="' + esc(o.base_reglementaire || '') + '"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="go-cancel" type="button">Annuler</button><button class="btn btn--primary" id="go-save" type="button">Enregistrer</button></div>');
    $('go-cancel').addEventListener('click', closeModal);
    $('go-save').addEventListener('click', function () {
      var body = { libelle: $('go-lib').value.trim(), type_organe: $('go-type').value, frequence_reunion: $('go-freq').value,
        nombre_membres: $('go-mem').value, quorum_requis: $('go-quo').value, base_reglementaire: $('go-base').value.trim() };
      if (!body.libelle) { notify('Indiquez le libellé de l’organe.', 'err'); return; }
      $('go-save').disabled = true;
      api(isNew ? '/api/v1/governance/organes' : '/api/v1/governance/organes/' + encodeURIComponent(o.id), isNew ? 'POST' : 'PUT', body)
        .then(function () { closeModal(); notify('Organe enregistré.', 'ok'); GOUV.loaded = false; G29.loaded = false; GOUV_OVERVIEW.at = 0; loadGouvernance(true); })
        .catch(function (e) { $('go-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  /* --- Onglet 3 : membres --- */
  function renderGouvMembres() {
    var l = GOUV.membres || [];
    var head = '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">' +
      '<p class="hint" style="margin:0">Rattachez un membre à son compte d’accès : nom, fonction, téléphone et e-mail sont alors repris automatiquement.</p>' +
      (gouvCanWrite() ? '<button class="btn btn--primary" id="btn-gm-new" type="button">+ Nouveau membre</button>' : '') + '</div>';
    var body = l.length ? '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Nom</th><th>Fonction</th><th>Organe</th><th>Qualité</th><th>Casier judiciaire</th><th>Statut</th><th></th></tr></thead><tbody>' +
      l.map(function (m) {
        return '<tr><td><b>' + esc(m.nom_complet) + '</b><br><span class="hint" style="font-size:11px">' + esc(m.email || '') + (m.telephone ? ' \u00b7 ' + esc(m.telephone) : '') + '</span></td>' +
          '<td>' + esc(m.fonction) + '</td><td>' + esc(m.organe_libelle || '\u2014') + '</td>' +
          '<td>' + esc(m.qualite || '\u2014') + '</td>' +
          '<td>' + (m.casier_a_renouveler ? gouvBadge('à renouveler', 'warn') : gouvBadge('à jour', 'ok')) + '</td>' +
          '<td>' + (m.actif ? gouvBadge('actif', 'ok') : gouvBadge('sorti', 'info')) + '</td>' +
          '<td style="text-align:right">' + (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" data-gm-edit="' + esc(m.id) + '" type="button">Modifier</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">Aucun membre enregistré.</div>';
    $('gouv-pane-membres').innerHTML = head + body;
    var nw = $('btn-gm-new'); if (nw) nw.addEventListener('click', function () { openMembreModal(null); });
    $('gouv-pane-membres').querySelectorAll('[data-gm-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = (GOUV.membres || []).filter(function (x) { return x.id === b.dataset.gmEdit; })[0];
        openMembreModal(m || null);
      });
    });
  }
  function openMembreModal(m) {
    var isNew = !m; m = m || {};
    var types = [['ADMINISTRATEUR', 'Administrateur'], ['DIRECTEUR_GENERAL', 'Directeur Général'], ['DIRECTEUR_GENERAL_ADJOINT', 'Directeur Général Adjoint'], ['MEMBRE_COMITE', 'Membre de comité'], ['COMMISSAIRE_COMPTES', 'Commissaire aux comptes'], ['SECRETAIRE', 'Secrétaire'], ['AUTRE', 'Autre']];
    var quals = [['INTERNE', 'Interne'], ['INDEPENDANT', 'Indépendant'], ['EXTERNE', 'Externe'], ['REPRESENTANT_ETAT', 'Représentant de l’État']];
    var users = (GOUV.users || []).map(function (u) { return [u.id, u.full_name + (u.position ? ' \u2014 ' + u.position : '')]; });
    var organes = (GOUV.organes || []).map(function (o) { return [o.id, o.libelle]; });
    openModal('<h3>' + (isNew ? 'Nouveau membre' : 'Modifier le membre') + '</h3><p class="sub">' + esc(m.nom_complet || '') + '</p>' +
      '<div class="fld"><label for="gm-user">Compte d’accès lié <span class="hint" style="font-weight:400">remplit nom, fonction, tél., e-mail</span></label><select id="gm-user">' + gouvOpts(users, m.app_user_id, '\u2014 aucun \u2014') + '</select></div>' +
      '<div class="fld"><label for="gm-nom">Nom complet</label><input id="gm-nom" value="' + esc(m.nom_complet || '') + '"></div>' +
      '<div class="fld"><label for="gm-fct">Fonction</label><input id="gm-fct" value="' + esc(m.fonction || '') + '"></div>' +
      '<div class="fld"><label for="gm-org">Organe</label><select id="gm-org">' + gouvOpts(organes, m.organe_id, '\u2014 aucun \u2014') + '</select></div>' +
      '<div class="fld"><label for="gm-type">Type de membre</label><select id="gm-type">' + gouvOpts(types, m.type_membre || 'ADMINISTRATEUR') + '</select></div>' +
      '<div class="fld"><label for="gm-qual">Qualité</label><select id="gm-qual">' + gouvOpts(quals, m.qualite, '\u2014 choisir \u2014') + '</select></div>' +
      '<div class="fld"><label for="gm-sexe">Sexe</label><select id="gm-sexe">' + gouvOpts([['F', 'Féminin'], ['M', 'Masculin']], m.sexe, '\u2014 choisir \u2014') + '</select></div>' +
      '<div class="fld"><label for="gm-tel">Téléphone</label><input id="gm-tel" value="' + esc(m.telephone || '') + '"></div>' +
      '<div class="fld"><label for="gm-mail">E-mail</label><input id="gm-mail" type="email" value="' + esc(m.email || '') + '"></div>' +
      '<div class="fld"><label for="gm-casier">Date du casier judiciaire <span class="hint" style="font-weight:400">alerte après 90 jours</span></label><input id="gm-casier" type="date" value="' + esc(gouvDate(m.casier_judiciaire_date)) + '"></div>' +
      '<div class="fld"><label for="gm-entree">Date d’entrée</label><input id="gm-entree" type="date" value="' + esc(gouvDate(m.date_entree)) + '"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="gm-cancel" type="button">Annuler</button><button class="btn btn--primary" id="gm-save" type="button">Enregistrer</button></div>');
    $('gm-cancel').addEventListener('click', closeModal);
    var us = $('gm-user');
    if (us) us.addEventListener('change', function () {
      var u = (GOUV.users || []).filter(function (x) { return x.id === us.value; })[0];
      if (!u) return;
      $('gm-nom').value = u.full_name || ''; $('gm-fct').value = u.position || '';
      $('gm-tel').value = u.phone || ''; $('gm-mail').value = u.email || '';
    });
    $('gm-save').addEventListener('click', function () {
      var body = { app_user_id: $('gm-user').value || null, nom_complet: $('gm-nom').value.trim(), fonction: $('gm-fct').value.trim(),
        organe_id: $('gm-org').value || null, type_membre: $('gm-type').value, qualite: $('gm-qual').value || null,
        sexe: $('gm-sexe').value || null, telephone: $('gm-tel').value.trim(), email: $('gm-mail').value.trim(),
        casier_judiciaire_date: $('gm-casier').value || null, date_entree: $('gm-entree').value || null };
      if (!body.nom_complet) { notify('Indiquez le nom du membre.', 'err'); return; }
      $('gm-save').disabled = true;
      api(isNew ? '/api/v1/governance/membres' : '/api/v1/governance/membres/' + encodeURIComponent(m.id), isNew ? 'POST' : 'PUT', body)
        .then(function () { closeModal(); notify('Membre enregistré.', 'ok'); GOUV.loaded = false; G29.loaded = false; GOUV_OVERVIEW.at = 0; loadGouvernance(true); })
        .catch(function (e) { $('gm-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  /* --- Onglet 4 : mandats --- */
  function renderGouvMandats() {
    var l = GOUV.mandats || [];
    var al = GOUV.cumul || [];
    var head = '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">' +
      '<p class="hint" style="margin:0">Le statut « expiré » et le numéro de renouvellement sont calculés automatiquement. Plafond de 3 mandats d’administrateur.</p>' +
      (gouvCanWrite() ? '<button class="btn btn--primary" id="btn-gt-new" type="button">+ Nouveau mandat</button>' : '') + '</div>' +
      (al.length ? '<div class="chips" style="margin-bottom:12px">' + al.map(function (a) { return '<span class="chip chip--warn">Cumul (' + a.mandats_en_cours + ') : ' + esc(a.nom) + '</span>'; }).join('') + '</div>' : '');
    var body = l.length ? '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Membre</th><th>Fonction</th><th>Organe</th><th>Début</th><th>Fin</th><th>Renouv.</th><th>Statut</th><th></th></tr></thead><tbody>' +
      l.map(function (m) {
        var kind = m.statut === 'EN_COURS' ? 'ok' : (m.statut === 'EXPIRE' ? 'bad' : 'info');
        return '<tr><td><b>' + esc(m.nom_complet) + '</b></td><td>' + esc(m.fonction) + '</td><td>' + esc(m.organe_libelle || '\u2014') + '</td>' +
          '<td>' + gouvDateFr(m.date_debut) + '</td><td>' + gouvDateFr(m.date_fin) + '</td><td>' + (m.numero_renouvellement || 1) + '</td>' +
          '<td>' + gouvBadge(m.statut, kind) + '</td>' +
          '<td style="text-align:right">' + (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" data-gt-edit="' + esc(m.id) + '" type="button">Modifier</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">Aucun mandat enregistré.</div>';
    $('gouv-pane-mandats').innerHTML = head + body;
    var nw = $('btn-gt-new'); if (nw) nw.addEventListener('click', function () { openMandatModal(null); });
    $('gouv-pane-mandats').querySelectorAll('[data-gt-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = (GOUV.mandats || []).filter(function (x) { return x.id === b.dataset.gtEdit; })[0];
        openMandatModal(m || null);
      });
    });
  }
  function openMandatModal(m) {
    var isNew = !m; m = m || {};
    var membres = (GOUV.mandatsMembres || []).map(function (x) { return [x.id, x.nom_complet + ' — ' + (x.fonction || '')]; });
    var organes = (GOUV.organes || []).map(function (o) { return [o.id, o.libelle]; });
    openModal('<h3>' + (isNew ? 'Nouveau mandat' : 'Modifier le mandat') + '</h3><p class="sub">' + esc(m.nom_complet || '') + '</p>' +
      '<div class="fld"><label for="gt-membre">Membre</label><select id="gt-membre">' + gouvOpts(membres, m.membre_id, '\u2014 choisir \u2014') + '</select></div>' +
      '<div class="fld"><label for="gt-fct">Fonction</label><input id="gt-fct" value="' + esc(m.fonction || '') + '"></div>' +
      '<div class="fld"><label for="gt-org">Organe</label><select id="gt-org">' + gouvOpts(organes, m.organe_id, '\u2014 aucun \u2014') + '</select></div>' +
      '<div class="fld"><label for="gt-debut">Début du mandat</label><input id="gt-debut" type="date" value="' + esc(gouvDate(m.date_debut)) + '"></div>' +
      '<div class="fld"><label for="gt-fin">Fin du mandat</label><input id="gt-fin" type="date" value="' + esc(gouvDate(m.date_fin)) + '"></div>' +
      '<div class="fld"><label for="gt-acte">Acte de nomination</label><input id="gt-acte" value="' + esc(m.acte_nomination || '') + '"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="gt-cancel" type="button">Annuler</button><button class="btn btn--primary" id="gt-save" type="button">Enregistrer</button></div>');
    $('gt-cancel').addEventListener('click', closeModal);
    $('gt-save').addEventListener('click', function () {
      var body = { membre_id: $('gt-membre').value, fonction: $('gt-fct').value.trim(), organe_id: $('gt-org').value || null,
        date_debut: $('gt-debut').value || null, date_fin: $('gt-fin').value || null, acte_nomination: $('gt-acte').value.trim() };
      if (!body.membre_id) { notify('Choisissez le membre concerné.', 'err'); return; }
      $('gt-save').disabled = true;
      api(isNew ? '/api/v1/governance/mandats' : '/api/v1/governance/mandats/' + encodeURIComponent(m.id), isNew ? 'POST' : 'PUT', body)
        .then(function () { closeModal(); notify('Mandat enregistré.', 'ok'); GOUV.loaded = false; G29.loaded = false; GOUV_OVERVIEW.at = 0; loadGouvernance(true); })
        .catch(function (e) { $('gt-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  /* --- Onglet 5 : sessions & PV --- */
  function renderGouvSessions() {
    var l = GOUV.sessions || [];
    var head = '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">' +
      '<p class="hint" style="margin:0">Le quorum est calculé automatiquement. La signature scelle le PV par une empreinte numérique et le verrouille.</p>' +
      (gouvCanWrite() ? '<button class="btn btn--primary" id="btn-gs-new" type="button">+ Nouvelle session</button>' : '') + '</div>';
    var body = l.length ? '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Date</th><th>Organe</th><th>Présents / quorum</th><th>PV</th><th>Empreinte</th><th>Statut</th><th></th></tr></thead><tbody>' +
      l.map(function (s) {
        var qk = s.quorum_atteint === false ? gouvBadge('quorum non atteint', 'bad') : (s.quorum_atteint === true ? gouvBadge('quorum atteint', 'ok') : '\u2014');
        var st = { SIGNE_VERROUILLE: 'ok', BROUILLON: 'warn', PLANIFIEE: 'info', ANNULEE: 'bad' }[s.statut] || 'info';
        return '<tr><td>' + gouvDateFr(s.date_session) + '</td><td>' + esc(s.organe_libelle || '\u2014') + '</td>' +
          '<td>' + s.nombre_presents + ' / ' + s.quorum_requis + ' ' + qk + '</td><td>' + esc(s.pv_reference || '\u2014') + '</td>' +
          '<td><span class="hint" style="font-size:11px">' + (s.hash_integrite_pv ? esc(String(s.hash_integrite_pv).slice(0, 12)) + '\u2026' : '\u2014') + '</span></td>' +
          '<td>' + gouvBadge(s.statut.replace('_', ' '), st) + '</td>' +
          '<td style="text-align:right">' + (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" data-gs-edit="' + esc(s.id) + '" type="button">' + (s.statut === 'SIGNE_VERROUILLE' ? 'Consulter' : 'Modifier') + '</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">Aucune session enregistrée.</div>';
    $('gouv-pane-sessions').innerHTML = head + body;
    var nw = $('btn-gs-new'); if (nw) nw.addEventListener('click', function () { openSessionModal(null); });
    $('gouv-pane-sessions').querySelectorAll('[data-gs-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = (GOUV.sessions || []).filter(function (x) { return x.id === b.dataset.gsEdit; })[0];
        openSessionModal(s || null);
      });
    });
  }
  function openSessionModal(s) {
    var isNew = !s; s = s || {};
    var organes = (GOUV.sessionsOrganes || []).map(function (o) { return [o.id, o.libelle + ' (quorum ' + (o.quorum_requis || 0) + ')']; });
    var locked = s.statut === 'SIGNE_VERROUILLE';
    var types = [['ORDINAIRE', 'Ordinaire'], ['EXTRAORDINAIRE', 'Extraordinaire'], ['ASSEMBLEE_GENERALE', 'Assemblée Générale'], ['STATUTAIRE', 'Statutaire']];
    openModal('<h3>' + (isNew ? 'Nouvelle session' : (locked ? 'Session verrouillée' : 'Modifier la session')) + '</h3><p class="sub">' + (locked ? 'PV signé : lecture seule.' : '') + '</p>' +
      '<div class="fld"><label for="gs-org">Organe</label><select id="gs-org"' + (locked ? ' disabled' : '') + '>' + gouvOpts(organes, s.organe_id, '\u2014 choisir \u2014') + '</select></div>' +
      '<div class="fld"><label for="gs-type">Type de session</label><select id="gs-type"' + (locked ? ' disabled' : '') + '>' + gouvOpts(types, s.type_session || 'ORDINAIRE') + '</select></div>' +
      '<div class="fld"><label for="gs-date">Date</label><input id="gs-date" type="date" value="' + esc(gouvDate(s.date_session)) + '"' + (locked ? ' disabled' : '') + '></div>' +
      '<div class="fld"><label for="gs-lieu">Lieu</label><input id="gs-lieu" value="' + esc(s.lieu || '') + '"' + (locked ? ' disabled' : '') + '></div>' +
      '<div class="fld"><label for="gs-presents">Nombre de présents</label><input id="gs-presents" type="number" value="' + esc(s.nombre_presents || 0) + '"' + (locked ? ' disabled' : '') + '></div>' +
      '<div class="fld"><label for="gs-pv">Référence du PV</label><input id="gs-pv" value="' + esc(s.pv_reference || '') + '"' + (locked ? ' disabled' : '') + '></div>' +
      '<div class="fld"><label for="gs-resume">Résumé / décisions</label><textarea id="gs-resume" rows="3"' + (locked ? ' disabled' : '') + '>' + esc(s.pv_resume || '') + '</textarea></div>' +
      '<div class="modal__nav">' + (locked ? '<button class="btn btn--ghost" id="gs-cancel" type="button">Fermer</button>' :
        '<button class="btn btn--ghost" id="gs-cancel" type="button">Annuler</button><button class="btn btn--ghost" id="gs-sign" type="button">Signer &amp; verrouiller</button><button class="btn btn--primary" id="gs-save" type="button">Enregistrer</button>') + '</div>');
    $('gs-cancel').addEventListener('click', closeModal);
    function payload(extra) {
      var b = { organe_id: $('gs-org').value || null, type_session: $('gs-type').value, date_session: $('gs-date').value || null,
        lieu: $('gs-lieu').value.trim(), nombre_presents: $('gs-presents').value || 0,
        pv_reference: $('gs-pv').value.trim(), pv_resume: $('gs-resume').value.trim() };
      if (extra) Object.keys(extra).forEach(function (k) { b[k] = extra[k]; });
      return b;
    }
    function send(b, btn) {
      if (!b.date_session) { notify('Indiquez la date de la session.', 'err'); return; }
      btn.disabled = true;
      api(isNew ? '/api/v1/governance/sessions' : '/api/v1/governance/sessions/' + encodeURIComponent(s.id), isNew ? 'POST' : 'PUT', b)
        .then(function () { closeModal(); notify('Session enregistrée.', 'ok'); GOUV.loaded = false; G29.loaded = false; GOUV_OVERVIEW.at = 0; loadGouvernance(true); })
        .catch(function (e) { btn.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    }
    var sv = $('gs-save'); if (sv) sv.addEventListener('click', function () { send(payload({ statut: 'BROUILLON' }), sv); });
    var sg = $('gs-sign'); if (sg) sg.addEventListener('click', function () {
      if (!confirm('Signer ce procès-verbal ? Il sera scellé par une empreinte numérique et ne pourra plus être modifié.')) return;
      send(payload({ statut: 'SIGNE_VERROUILLE' }), sg);
    });
  }

  /* --- Onglet 6 : résolutions --- */
  function renderGouvResolutions() {
    var l = GOUV.resolutions || [];
    var head = '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">' +
      '<p class="hint" style="margin:0">Une résolution non réalisée dont l’échéance est passée passe automatiquement « en retard ».</p>' +
      (gouvCanWrite() ? '<button class="btn btn--primary" id="btn-gr-new" type="button">+ Nouvelle résolution</button>' : '') + '</div>';
    var body = l.length ? '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Intitulé</th><th>Type</th><th>Responsable</th><th>Échéance</th><th>Avancement</th><th>Priorité</th><th>Statut</th><th></th></tr></thead><tbody>' +
      l.map(function (x) {
        var st = { REALISEE: 'ok', EN_RETARD: 'bad', EN_COURS: 'warn', A_FAIRE: 'info' }[x.statut] || 'info';
        var pr = { CRITIQUE: 'bad', HAUTE: 'warn', NORMALE: 'info', BASSE: 'info' }[x.priorite] || 'info';
        return '<tr><td><b>' + esc(x.intitule) + '</b></td><td>' + esc(x.type_element) + '</td><td>' + esc(x.responsable || '\u2014') + '</td>' +
          '<td>' + gouvDateFr(x.date_echeance) + '</td>' +
          '<td><div style="background:#e9ebf3;border-radius:99px;height:8px;width:88px;overflow:hidden"><div style="height:8px;width:' + Number(x.taux_execution || 0) + '%;background:#0b0c26"></div></div><span class="hint" style="font-size:11px">' + Number(x.taux_execution || 0) + '%</span></td>' +
          '<td>' + gouvBadge(x.priorite, pr) + '</td><td>' + gouvBadge(x.statut.replace('_', ' '), st) + '</td>' +
          '<td style="text-align:right">' + (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" data-gr-edit="' + esc(x.id) + '" type="button">Modifier</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">Aucune résolution enregistrée.</div>';
    $('gouv-pane-resolutions').innerHTML = head + body;
    var nw = $('btn-gr-new'); if (nw) nw.addEventListener('click', function () { openResolutionModal(null); });
    $('gouv-pane-resolutions').querySelectorAll('[data-gr-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var x = (GOUV.resolutions || []).filter(function (y) { return y.id === b.dataset.grEdit; })[0];
        openResolutionModal(x || null);
      });
    });
  }
  function openResolutionModal(x) {
    var isNew = !x; x = x || {};
    var types = [['RESOLUTION', 'Résolution'], ['RECOMMANDATION', 'Recommandation'], ['DECISION', 'Décision'], ['INSTRUCTION', 'Instruction']];
    var domaines = [['GOUVERNANCE', 'Gouvernance'], ['RISQUE', 'Risque'], ['CREDIT', 'Crédit'], ['AUDIT', 'Audit'], ['COMPTABILITE', 'Comptabilité'], ['RESSOURCES_HUMAINES', 'Ressources humaines'], ['SYSTEME_INFORMATION', 'Système d’information'], ['CONFORMITE', 'Conformité'], ['STRATEGIE', 'Stratégie'], ['AUTRE', 'Autre']];
    var prios = [['BASSE', 'Basse'], ['NORMALE', 'Normale'], ['HAUTE', 'Haute'], ['CRITIQUE', 'Critique']];
    var sessions = (GOUV.resSessions || []).map(function (s) { return [s.id, gouvDateFr(s.date_session) + (s.numero_session ? ' \u2014 ' + s.numero_session : '')]; });
    var organes = (GOUV.resOrganes || []).map(function (o) { return [o.id, o.libelle]; });
    openModal('<h3>' + (isNew ? 'Nouvelle résolution' : 'Modifier') + '</h3><p class="sub">' + esc(x.intitule || '') + '</p>' +
      '<div class="fld"><label for="gr-int">Intitulé</label><input id="gr-int" value="' + esc(x.intitule || '') + '"></div>' +
      '<div class="fld"><label for="gr-texte">Texte / détail</label><textarea id="gr-texte" rows="2">' + esc(x.texte || '') + '</textarea></div>' +
      '<div class="fld"><label for="gr-type">Type</label><select id="gr-type">' + gouvOpts(types, x.type_element || 'RESOLUTION') + '</select></div>' +
      '<div class="fld"><label for="gr-dom">Domaine</label><select id="gr-dom">' + gouvOpts(domaines, x.domaine, '\u2014 choisir \u2014') + '</select></div>' +
      '<div class="fld"><label for="gr-sess">Session d’origine</label><select id="gr-sess">' + gouvOpts(sessions, x.session_id, '\u2014 aucune \u2014') + '</select></div>' +
      '<div class="fld"><label for="gr-org">Organe</label><select id="gr-org">' + gouvOpts(organes, x.organe_id, '\u2014 aucun \u2014') + '</select></div>' +
      '<div class="fld"><label for="gr-resp">Responsable</label><input id="gr-resp" value="' + esc(x.responsable || '') + '"></div>' +
      '<div class="fld"><label for="gr-ech">Échéance</label><input id="gr-ech" type="date" value="' + esc(gouvDate(x.date_echeance)) + '"></div>' +
      '<div class="fld"><label for="gr-av">Avancement (%)</label><input id="gr-av" type="number" min="0" max="100" value="' + esc(x.taux_execution || 0) + '"></div>' +
      '<div class="fld"><label for="gr-prio">Priorité</label><select id="gr-prio">' + gouvOpts(prios, x.priorite || 'NORMALE') + '</select></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="gr-cancel" type="button">Annuler</button><button class="btn btn--primary" id="gr-save" type="button">Enregistrer</button></div>');
    $('gr-cancel').addEventListener('click', closeModal);
    $('gr-save').addEventListener('click', function () {
      var b = { intitule: $('gr-int').value.trim(), texte: $('gr-texte').value.trim(), type_element: $('gr-type').value,
        domaine: $('gr-dom').value || null, session_id: $('gr-sess').value || null, organe_id: $('gr-org').value || null,
        responsable: $('gr-resp').value.trim(), date_echeance: $('gr-ech').value || null,
        taux_execution: $('gr-av').value || 0, priorite: $('gr-prio').value };
      if (!b.intitule) { notify('Indiquez l’intitulé.', 'err'); return; }
      if (Number(b.taux_execution) >= 100) b.statut = 'REALISEE';
      $('gr-save').disabled = true;
      api(isNew ? '/api/v1/governance/resolutions' : '/api/v1/governance/resolutions/' + encodeURIComponent(x.id), isNew ? 'POST' : 'PUT', b)
        .then(function () { closeModal(); notify('Résolution enregistrée.', 'ok'); GOUV.loaded = false; G29.loaded = false; GOUV_OVERVIEW.at = 0; loadGouvernance(true); })
        .catch(function (e) { $('gr-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }


  /* ===== VAGUE 29 : CONFORMITÉ PRUDENTIELLE, RISQUES & REPORTING ===== */
  var G29 = { loaded: false, sub: 'apparentes', data: null };

  function g29Money(c) {
    if (c == null || c === '') return '\u2014';
    return fmtAmount(Number(c) / 100) + ' FCFA';
  }
  function g29Pct(v) { return v == null || v === '' ? '\u2014' : String(Number(v).toFixed(2)).replace('.', ',') + ' %'; }
  function g29Pill(txt, kind) { return '<span class="g29-pill ' + (kind || 'info') + '">' + esc(String(txt)) + '</span>'; }
  function g29Head(titre, sous, actions) {
    return '<div class="g29-head"><div><h3>' + esc(titre) + '</h3>' + (sous ? '<p class="hint">' + esc(sous) + '</p>' : '') + '</div>' +
      '<div class="g29-actions">' + (actions || '') + '</div></div>';
  }
  function g29Stat(val, lab, extra) {
    return '<div class="g29-stat"><b>' + val + '</b><span>' + esc(lab) + '</span>' + (extra || '') + '</div>';
  }
  function g29Alertes(list) {
    if (!list || !list.length) return '<div class="g29-alert moy">Aucun écart détecté sur ce bloc.</div>';
    return list.map(function (a) {
      var cls = a.niveau === 'CRITIQUE' ? 'crit' : (a.niveau === 'HAUTE' ? 'haut' : 'moy');
      return '<span class="g29-alert ' + cls + '">' + esc(a.texte) + '</span>';
    }).join('');
  }
  function g29File(url) { window.open(url, '_blank'); }

  function setupGouvernance29() {
    var host = $('g29-host');
    if (!host) return;
    document.querySelectorAll('[data-g29]').forEach(function (b) {
      b.addEventListener('click', function () {
        G29.sub = b.getAttribute('data-g29');
        document.querySelectorAll('[data-g29]').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderG29Pane();
      });
    });
    var b1 = $('btn-g29-cac-pdf'); if (b1) b1.addEventListener('click', function () { g29File('/api/v1/governance/exports/rapport-cac.pdf'); });
    var b2 = $('btn-g29-cac-xls'); if (b2) b2.addEventListener('click', function () { g29File('/api/v1/governance/exports/rapport-cac.xlsx'); });
    var b3 = $('btn-g29-pack'); if (b3) b3.addEventListener('click', function () { g29File('/api/v1/governance/exports/pack-inspection.zip'); });
  }

  /* Après une modification du bloc conformité : on ignore le cache court et on relit. */
  function gouvReloadConformite() {
    G29.loaded = false; GOUV_OVERVIEW.at = 0;
    return loadGouvernance29(true);
  }

  function loadGouvernance29(force) {
    if (G29.loaded && !force) { renderG29Pane(); return; }
    var host = $('g29-host');
    if (host && !(G29.data && G29.data.dash)) host.innerHTML = '<div class="empty">Chargement du bloc conformité...</div>';
    // Même principe que la gouvernance : un seul appel. Les 8 lectures
    // séparées saturaient le serveur (502 Bad Gateway).
    gouvOverview(!!force).then(function () {
      var dash = gouvSection('conformite');
      if (!dash) {
        if (host) host.innerHTML = '<div class="empty">Bloc conformité momentanément indisponible.</div>';
        return;
      }
      G29.data = {
        dash: dash,
        app: gouvSection('apparentes') || {},
        conv: gouvSection('conventions') || {},
        risq: gouvSection('risques') || {},
        pca: gouvSection('pca') || {},
        inc: gouvSection('incidents') || {},
        lbc: gouvSection('lbcft') || {},
        ech: gouvSection('echeancier') || {}
      };
      G29.loaded = true;
      renderG29Kpis();
      renderG29Pane();
    }).catch(function (e) {
      if (e && e.legacy) return loadGouvernance29Separe(force, host);
      if (guard(e)) return;
      if (host) host.innerHTML = '<div class="empty">Bloc conformité indisponible. Réessayez.</div>';
      notify(fr(e), 'err');
    });
  }

  /* Repli : anciens appels séparés du bloc conformité. */
  function loadGouvernance29Separe(force, host) {
    return Promise.all([
      api('/api/v1/governance/conformite/dashboard'),
      api('/api/v1/governance/apparentes'),
      api('/api/v1/governance/conventions'),
      api('/api/v1/governance/risques'),
      api('/api/v1/governance/pca'),
      api('/api/v1/governance/incidents'),
      api('/api/v1/governance/lbcft'),
      api('/api/v1/governance/echeancier')
    ]).then(function (r) {
      G29.data = { dash: r[0], app: r[1], conv: r[2], risq: r[3], pca: r[4], inc: r[5], lbc: r[6], ech: r[7] };
      G29.loaded = true;
      renderG29Kpis();
      renderG29Pane();
    }).catch(function (e) {
      if (guard(e)) return;
      if (host) host.innerHTML = '<div class="empty">Bloc conformité indisponible. Réessayez.</div>';
      notify(fr(e), 'err');
    });
  }

  function renderG29Kpis() {
    var d = (G29.data && G29.data.dash) || {};
    var box = $('g29-kpis');
    if (!box) return;
    var ap = d.apparentes || {};
    var tint = ap.ratio_global_pct == null ? '' : (ap.ratio_global_pct > Number(ap.plafond_global_pct) ? 'bad' : (ap.ratio_global_pct > Number(ap.plafond_global_pct) * 0.8 ? 'warn' : ''));
    box.innerHTML =
      g29Stat(g29Pct(ap.ratio_global_pct), 'Encours apparentés / FPE (plafond ' + g29Pct(ap.plafond_global_pct) + ')',
        '<div class="g29-bar"><i class="' + tint + '" style="width:' + Math.min(100, Math.max(2, Number(ap.ratio_global_pct || 0))) + '%"></i></div>') +
      g29Stat((d.conventions && d.conventions.n) || 0, 'Conventions réglementées') +
      g29Stat((d.pca || []).length, 'Plans de continuité') +
      g29Stat((d.incidents && d.incidents.a_notifier) || 0, 'Incidents à notifier BCEAO') +
      g29Stat(((d.lbcft && d.lbcft.taux) || 0) + ' %', 'Personnel formé LBC/FT') +
      g29Stat((d.echeancier && d.echeancier.en_retard) || 0, 'Échéances en retard') +
      g29Stat((d.echeancier && d.echeancier.proches) || 0, 'Échéances à J-30/J-15/J-5');
    var al = $('g29-alerts');
    if (al) al.innerHTML = g29Alertes((d.alertes || []).slice(0, 8));
  }

  function renderG29Pane() {
    var host = $('g29-host');
    if (!host || !G29.data) return;
    if (G29.sub === 'risques') return renderG29Risques(host);
    if (G29.sub === 'conformite') return renderG29Conformite(host);
    return renderG29Apparentes(host);
  }

  /* --- A. Apparentés & conventions réglementées --- */
  function renderG29Apparentes(host) {
    var a = G29.data.app, c = G29.data.conv;
    var sit = a.situation || {};
    var forme = a.forme || {};
    var titre = forme.titre_pluriel || 'actions';
    var html = g29Head('Crédits aux personnes apparentées et conventions réglementées',
      'Plafonds prudentiels exprimés en pourcentage des fonds propres effectifs (FPE) — paramètres modifiables dans l\u2019onglet Paramètres.',
      (gouvCanWrite() ? '<button class="btn btn--primary" id="btn-g29-new-app" type="button">+ Personne apparentée</button><button class="btn btn--ghost" id="btn-g29-new-conv" type="button">+ Convention</button>' : ''));

    html += '<div class="g29-grid">' +
      g29Stat(g29Money(sit.fpe_cents), 'Fonds propres effectifs (' + (sit.fpe_source === 'saisie' ? 'saisis' : 'capital social') + ')') +
      g29Stat(g29Money(sit.encours_total_cents), 'Encours total apparentés') +
      g29Stat('<span class="' + (sit.depassement_global ? 'g29-pill bad' : 'g29-pill ok') + '">' + g29Pct(sit.ratio_global_pct) + '</span>', 'Ratio global (plafond ' + g29Pct(sit.plafond_global_pct) + ')') +
      g29Stat((sit.lignes || []).filter(function (l) { return l.depassement; }).length, 'Plafonds individuels dépassés') +
      '</div>';

    html += '<div class="g29-alert moy" style="margin-bottom:12px">Dans une ' + (forme.is_scoop ? 'société coopérative, les titres sont des <b>' + esc(titre) + '</b> et chaque membre dispose d\u2019une seule voix' : 'société anonyme, les titres sont des <b>' + esc(titre) + '</b> et les droits de vote suivent le nombre d\u2019actions (seuil d\u2019information ' + g29Pct((G29.data.dash.parametres || {}).seuil_participation_pct) + ')') + '.</div>';

    html += '<h4 style="font-size:13px;margin:14px 0 8px">Personnes apparentées (' + (a.apparentes || []).length + ')</h4>';
    var lines = a.apparentes || [];
    html += lines.length ? '<div class="g29-scroll"><table class="tbl"><thead><tr><th>Nom</th><th>Lien / qualité</th><th>Vérification</th><th>Dossiers</th><th>Encours</th><th>Ratio FPE</th><th></th></tr></thead><tbody>' +
      lines.map(function (p) {
        var l = (sit.lignes || []).filter(function (x) { return x.id === p.id; })[0] || { encours_cents: 0, dossiers: 0, ratio_individuel_pct: null };
        var kind = l.depassement ? 'bad' : (p.statut_verification === 'VERIFIEE' ? 'ok' : 'warn');
        return '<tr><td><b>' + esc(p.nom_complet) + '</b><br><span class="hint" style="font-size:11px">' + esc(p.interessé ? 'lié à ' + p['interessé'] : '—') + '</span></td>' +
          '<td>' + esc(String(p.type_lien).replace(/_/g, ' ')) + '</td>' +
          '<td>' + g29Pill(p.statut_verification === 'VERIFIEE' ? 'Vérifiée' : 'À vérifier', kind) + '</td>' +
          '<td>' + (l.dossiers || 0) + '</td><td>' + g29Money(l.encours_cents) + '</td>' +
          '<td>' + (l.depassement ? g29Pill(g29Pct(l.ratio_individuel_pct), 'bad') : g29Pct(l.ratio_individuel_pct)) + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' + (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" data-g29-pa="' + esc(p.id) + '" type="button">Modifier</button> <button class="btn btn--sm btn--ghost" data-g29-pa-del="' + esc(p.id) + '" type="button">Retirer</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">Aucune personne apparentée recensée. Commencez par les administrateurs et dirigeants.</div>';

    html += '<h4 style="font-size:13px;margin:18px 0 8px">Conventions réglementées (' + (c.conventions || []).length + ')</h4>';
    var cvs = c.conventions || [];
    html += cvs.length ? '<div class="g29-scroll"><table class="tbl"><thead><tr><th>Réf.</th><th>Date</th><th>Apparenté</th><th>Type</th><th>Montant</th><th>Autorisation</th><th>Vote</th><th>CAC</th><th></th></tr></thead><tbody>' +
      cvs.map(function (x) {
        var st = { AUTORISEE: 'ok', EN_COURS: 'ok', CLOTUREE: 'info', PROJET: 'info', EN_ATTENTE_AUTORISATION: 'warn', REFUSEE: 'bad', ANNULEE: 'bad' }[x.statut] || 'info';
        return '<tr><td>' + esc(x.reference) + '</td><td>' + gouvDateFr(x.date_convention) + '</td><td>' + esc(x.apparente_nom) + '</td>' +
          '<td>' + esc(x.type_convention) + '</td><td>' + g29Money(x.montant_cents) + '</td>' +
          '<td>' + (x.date_autorisation ? g29Pill('Autorisée le ' + gouvDateFr(x.date_autorisation), 'ok') : g29Pill(x.autorisation_requise ? 'Non autorisée' : 'Non requise', x.autorisation_requise ? 'bad' : 'info')) + ' ' + g29Pill(String(x.statut).replace(/_/g, ' '), st) + '</td>' +
          '<td>' + (x.vote_exclu ? 'Exclu' : '—') + '</td><td>' + (x.informe_cac ? 'Oui' : g29Pill('Non', 'warn')) + '</td>' +
          '<td style="text-align:right">' + (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" data-g29-cv="' + esc(x.id) + '" type="button">Modifier</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">Aucune convention réglementée. Une convention est créée automatiquement lorsqu\u2019un crédit est accordé à un apparenté.</div>';

    host.innerHTML = html;
    var n1 = $('btn-g29-new-app'); if (n1) n1.addEventListener('click', function () { openG29Apparente(null); });
    var n2 = $('btn-g29-new-conv'); if (n2) n2.addEventListener('click', function () { openG29Convention(null); });
    host.querySelectorAll('[data-g29-pa]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = (a.apparentes || []).filter(function (x) { return x.id === b.dataset.g29Pa; })[0]; openG29Apparente(p || null);
      });
    });
    host.querySelectorAll('[data-g29-pa-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!window.confirm('Retirer cette personne apparentée du registre ?')) return;
        api('/api/v1/governance/apparentes/' + encodeURIComponent(b.dataset.g29PaDel), 'DELETE')
          .then(function () { notify('Personne apparentée retirée.', 'ok'); gouvReloadConformite(); })
          .catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
      });
    });
    host.querySelectorAll('[data-g29-cv]').forEach(function (b) {
      b.addEventListener('click', function () {
        var x = (c.conventions || []).filter(function (y) { return y.id === b.dataset.g29Cv; })[0]; openG29Convention(x || null);
      });
    });
  }

  function openG29Apparente(p) {
    var isNew = !p; p = p || {};
    var liens = [['CONJOINT', 'Conjoint'], ['ENFANT', 'Enfant'], ['ASCENDANT', 'Ascendant'], ['FRATRIE', 'Frère / Sœur'],
      ['BELLE_FAMILLE', 'Belle-famille'], ['SOCIETE_CONTROLEE', 'Société contrôlée'], ['SOCIETE_AFFILIEE', 'Société affiliée'],
      ['REPRESENTANT_LEGAL', 'Représentant légal'], ['AUTRE', 'Autre']];
    var membres = (G29.data.app.membres || []).map(function (m) { return [m.id, m.nom_complet + (m.fonction ? ' — ' + m.fonction : '')]; });
    openModal('<h3>' + (isNew ? 'Nouvelle personne apparentée' : 'Modifier la personne apparentée') + '</h3>' +
      '<div class="fld"><label for="g29a-nom">Nom complet</label><input id="g29a-nom" value="' + esc(p.nom_complet || '') + '"></div>' +
      '<div class="fld"><label for="g29a-lien">Lien de parenté / qualité</label><select id="g29a-lien">' + gouvOpts(liens, p.type_lien || 'CONJOINT') + '</select></div>' +
      '<div class="fld"><label for="g29a-interesse">Rattachée à (administrateur / dirigeant)</label><select id="g29a-interesse">' + gouvOpts(membres, p.membre_gouvernance_id, '\u2014 non rattachée \u2014') + '</select></div>' +
      '<div class="fld"><label for="g29a-nature">Nature</label><select id="g29a-nature">' + gouvOpts([['PHYSIQUE', 'Personne physique'], ['MORALE', 'Personne morale']], p.nature_personne || 'PHYSIQUE') + '</select></div>' +
      '<div class="fld"><label for="g29a-piece">Pièce / RCCM</label><input id="g29a-piece" value="' + esc(p.numero_piece || p.rccm || '') + '"></div>' +
      '<div class="fld"><label for="g29a-tel">Téléphone</label><input id="g29a-tel" value="' + esc(p.telephone || '') + '"></div>' +
      '<div class="fld"><label for="g29a-st">Vérification</label><select id="g29a-st">' + gouvOpts([['A_VERIFIER', 'À vérifier'], ['VERIFIEE', 'Vérifiée'], ['REJETEE', 'Rejetée']], p.statut_verification || 'A_VERIFIER') + '</select></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="g29a-cancel" type="button">Annuler</button><button class="btn btn--primary" id="g29a-save" type="button">Enregistrer</button></div>');
    $('g29a-cancel').addEventListener('click', closeModal);
    $('g29a-save').addEventListener('click', function () {
      var b = { nom_complet: $('g29a-nom').value.trim(), type_lien: $('g29a-lien').value, membre_gouvernance_id: $('g29a-interesse').value || null,
        nature_personne: $('g29a-nature').value, numero_piece: $('g29a-piece').value.trim(), telephone: $('g29a-tel').value.trim(),
        statut_verification: $('g29a-st').value };
      if (!b.nom_complet) { notify('Indiquez le nom.', 'err'); return; }
      $('g29a-save').disabled = true;
      api(isNew ? '/api/v1/governance/apparentes' : '/api/v1/governance/apparentes/' + encodeURIComponent(p.id), isNew ? 'POST' : 'PUT', b)
        .then(function () { closeModal(); notify('Personne apparentée enregistrée.', 'ok'); gouvReloadConformite(); })
        .catch(function (e) { $('g29a-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  function openG29Convention(x) {
    var isNew = !x; x = x || {};
    var pans = (G29.data.app.apparentes || []).map(function (p) { return [p.id, p.nom_complet]; });
    var types = [['CREDIT', 'Crédit'], ['DEPOT', 'Dépôt'], ['ACHAT', 'Achat'], ['VENTE', 'Vente'], ['BAIL', 'Bail'],
      ['PRESTATION', 'Prestation de service'], ['CAUTION', 'Caution'], ['PARTICIPATION', 'Participation'], ['REMUNERATION', 'Rémunération'], ['AUTRE', 'Autre']];
    var statuts = [['PROJET', 'Projet'], ['EN_ATTENTE_AUTORISATION', 'En attente d\u2019autorisation'], ['AUTORISEE', 'Autorisée'], ['REFUSEE', 'Refusée'], ['EN_COURS', 'En cours'], ['CLOTUREE', 'Clôturée'], ['ANNULEE', 'Annulée']];
    var organes = [['CONSEIL', 'Conseil d\u2019administration'], ['AG', 'Assemblée générale'], ['COMITE_AUDIT', 'Comité d\u2019audit'], ['DIRECTION', 'Direction générale']];
    openModal('<h3>' + (isNew ? 'Nouvelle convention réglementée' : 'Convention ' + esc(x.reference || '')) + '</h3>' +
      '<div class="fld"><label for="g29c-pa">Personne apparentée</label><select id="g29c-pa">' + gouvOpts(pans, x.personne_apparentee_id, '\u2014 choisir \u2014') + '</select></div>' +
      '<div class="fld"><label for="g29c-type">Type</label><select id="g29c-type">' + gouvOpts(types, x.type_convention || 'CREDIT') + '</select></div>' +
      '<div class="fld"><label for="g29c-obj">Objet</label><input id="g29c-obj" value="' + esc(x.objet || '') + '"></div>' +
      '<div class="fld"><label for="g29c-date">Date de la convention</label><input id="g29c-date" type="date" value="' + esc(gouvDate(x.date_convention)) + '"></div>' +
      '<div class="fld"><label for="g29c-mont">Montant (FCFA)</label><input id="g29c-mont" type="number" min="0" value="' + esc(x.montant_cents != null ? Number(x.montant_cents) / 100 : '') + '"></div>' +
      '<div class="fld"><label for="g29c-stat">Statut</label><select id="g29c-stat">' + gouvOpts(statuts, x.statut || 'EN_ATTENTE_AUTORISATION') + '</select></div>' +
      '<div class="fld"><label for="g29c-org">Organe qui autorise</label><select id="g29c-org">' + gouvOpts(organes, x.organe_autorisation, '\u2014 non autorisée \u2014') + '</select></div>' +
      '<div class="fld"><label for="g29c-aut">Date d\u2019autorisation</label><input id="g29c-aut" type="date" value="' + esc(gouvDate(x.date_autorisation)) + '"></div>' +
      '<div class="fld"><label>Information du Commissaire aux Comptes</label><label style="display:flex;gap:8px;align-items:center;font-weight:400"><input id="g29c-cac" type="checkbox"' + (x.informe_cac ? ' checked' : '') + '> Convention communiquée au CAC</label></div>' +
      '<p class="hint">L\u2019administrateur intéressé est exclu du vote : la convention est adoptée par les autres membres du conseil.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="g29c-cancel" type="button">Annuler</button><button class="btn btn--primary" id="g29c-save" type="button">Enregistrer</button></div>');
    $('g29c-cancel').addEventListener('click', closeModal);
    $('g29c-save').addEventListener('click', function () {
      var b = { personne_apparentee_id: $('g29c-pa').value || null, type_convention: $('g29c-type').value,
        objet: $('g29c-obj').value.trim(), date_convention: $('g29c-date').value || null,
        montant_cents: Math.round(Number($('g29c-mont').value || 0) * 100), statut: $('g29c-stat').value,
        organe_autorisation: $('g29c-org').value || null, date_autorisation: $('g29c-aut').value || null,
        informe_cac: $('g29c-cac').checked };
      if (!b.personne_apparentee_id) { notify('Choisissez la personne apparentée.', 'err'); return; }
      $('g29c-save').disabled = true;
      api(isNew ? '/api/v1/governance/conventions' : '/api/v1/governance/conventions/' + encodeURIComponent(x.id), isNew ? 'POST' : 'PUT', b)
        .then(function () { closeModal(); notify('Convention enregistrée.', 'ok'); gouvReloadConformite(); })
        .catch(function (e) { $('g29-c-save'); var s = $('g29c-save'); if (s) s.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  /* --- B. Risques, PCA et incidents --- */
  function renderG29Risques(host) {
    var R = G29.data.risq, P = G29.data.pca, I = G29.data.inc;
    var coul = { 1: '#e6f6ee', 2: '#f6f7d9', 3: '#fdeccb', 4: '#f9d5d2' };
    var html = g29Head('Contrôle interne, risques et plan de continuité d\u2019activité',
      'Matrice 4 \u00d7 4 (probabilité \u00d7 impact). Un plan de continuité non révisé depuis le délai paramétré passe automatiquement en « révision requise ».',
      (gouvCanWrite() ? '<button class="btn btn--primary" id="btn-g29-risk" type="button">+ Risque</button><button class="btn btn--ghost" id="btn-g29-pca" type="button">+ Plan PCA</button><button class="btn btn--ghost" id="btn-g29-inc" type="button">+ Incident majeur</button>' : ''));
    html += g29Alertes([].concat(R.alertes || [], P.alertes || [], I.alertes || []));
    html += '<div class="g29-grid">' + g29Stat(R.kpis.total, 'Risques cartographiés') + g29Stat(R.kpis.critiques, 'Risques critiques') +
      g29Stat(R.kpis.eleves_residuels, 'Risques résiduels élevés') + g29Stat(I.kpis.ouverts, 'Incidents ouverts') +
      g29Stat(P.plans.filter(function (x) { return x.statut_calcule === 'REVISION_REQUISE'; }).length, 'Plans à réviser') + '</div>';

    html += '<h4 style="font-size:13px;margin:14px 0 8px">Matrice des risques</h4><div class="g29-scroll"><div class="g29-heat">';
    html += '<div class="hlab">Prob. \\ Impact</div>' + [1, 2, 3, 4].map(function (im) { return '<div class="hlab">Impact ' + im + '</div>'; }).join('');
    (R.matrice || []).forEach(function (row) {
      html += '<div class="hlab">Prob. ' + row[0].probabilite + '</div>';
      row.forEach(function (cell) {
        var bg = cell.score >= 12 ? coul[4] : (cell.score >= 8 ? coul[3] : (cell.score >= 4 ? coul[2] : coul[1]));
        html += '<div class="hcell" style="background:' + bg + '">' + cell.risques.map(function (z) {
          return '<span class="hrisque" data-g29-risk="' + esc(z.id) + '" title="' + esc(z.libelle) + '">' + esc(z.libelle.slice(0, 32)) + '</span>';
        }).join('') + '</div>';
      });
    });
    html += '</div></div>';

    html += '<h4 style="font-size:13px;margin:18px 0 8px">Plans de continuité d\u2019activité (' + P.plans.length + ')</h4>';
    html += P.plans.length ? '<div class="g29-scroll"><table class="tbl"><thead><tr><th>Code</th><th>Libellé</th><th>Dernière revue</th><th>Jours restants</th><th>Dernier exercice</th><th>Statut</th><th></th></tr></thead><tbody>' +
      P.plans.map(function (x) {
        var st = x.statut_calcule === 'REVISION_REQUISE' ? 'bad' : (x.statut_calcule === 'VALIDE' ? 'ok' : 'warn');
        return '<tr><td>' + esc(x.code_plan) + '</td><td>' + esc(x.libelle) + '</td><td>' + gouvDateFr(x.date_derniere_revue || x.date_approbation) + '</td>' +
          '<td>' + (x.jours_restants == null ? '\u2014' : (x.jours_restants < 0 ? g29Pill('dépassé', 'bad') : x.jours_restants + ' j')) + '</td>' +
          '<td>' + gouvDateFr(x.date_dernier_exercice) + (x.mois_sans_exercice == null ? ' ' + g29Pill('aucun', 'warn') : ' (' + x.mois_sans_exercice + ' mois)') + '</td>' +
          '<td>' + g29Pill(String(x.statut_calcule).replace(/_/g, ' '), st) + '</td>' +
          '<td style="text-align:right">' + (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" data-g29-pca-edit="' + esc(x.id) + '" type="button">Modifier</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">Aucun plan de continuité enregistré. Un PCA est obligatoire.</div>';

    html += '<h4 style="font-size:13px;margin:18px 0 8px">Incidents majeurs (' + I.incidents.length + ')</h4>';
    html += I.incidents.length ? '<div class="g29-scroll"><table class="tbl"><thead><tr><th>Réf.</th><th>Date</th><th>Type</th><th>Gravité</th><th>Pertes</th><th>Notification BCEAO</th><th>Statut</th><th></th></tr></thead><tbody>' +
      I.incidents.map(function (x) {
        var notif = x.notification_bceao ? g29Pill('Notifié le ' + gouvDateFr(x.date_notification), 'ok') : (x.notification_bceao_requise ? g29Pill('À notifier', 'bad') : g29Pill('Non requise', 'info'));
        return '<tr><td>' + esc(x.reference) + '</td><td>' + gouvDateFr(x.date_incident) + '</td><td>' + esc(String(x.type_incident).replace(/_/g, ' ')) + '</td>' +
          '<td>' + g29Pill(x.gravite, x.gravite === 'CRITIQUE' ? 'bad' : (x.gravite === 'HAUTE' ? 'warn' : 'info')) + '</td><td>' + g29Money(x.pertes_cents) + '</td>' +
          '<td>' + notif + '</td><td>' + g29Pill(x.statut, x.statut === 'CLOS' || x.statut === 'RESOLU' ? 'ok' : 'warn') + '</td>' +
          '<td style="text-align:right">' + (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" data-g29-inc-edit="' + esc(x.id) + '" type="button">Modifier</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">Aucun incident majeur déclaré.</div>';

    host.innerHTML = html;
    var b1 = $('btn-g29-risk'); if (b1) b1.addEventListener('click', function () { openG29Risque(null); });
    var b2 = $('btn-g29-pca'); if (b2) b2.addEventListener('click', function () { openG29Pca(null); });
    var b3 = $('btn-g29-inc'); if (b3) b3.addEventListener('click', function () { openG29Incident(null); });
    host.querySelectorAll('[data-g29-risk]').forEach(function (b) {
      b.addEventListener('click', function () { var r = R.risques.filter(function (y) { return y.id === b.dataset.g29Risk; })[0]; openG29Risque(r || null); });
    });
    host.querySelectorAll('[data-g29-pca-edit]').forEach(function (b) {
      b.addEventListener('click', function () { var x = P.plans.filter(function (y) { return y.id === b.dataset.g29PcaEdit; })[0]; openG29Pca(x || null); });
    });
    host.querySelectorAll('[data-g29-inc-edit]').forEach(function (b) {
      b.addEventListener('click', function () { var x = I.incidents.filter(function (y) { return y.id === b.dataset.g29IncEdit; })[0]; openG29Incident(x || null); });
    });
  }

  function openG29Risque(x) {
    var isNew = !x; x = x || {};
    var cats = [['CREDIT', 'Crédit'], ['LIQUIDITE', 'Liquidité'], ['MARCHE', 'Marché'], ['OPERATIONNEL', 'Opérationnel'], ['CONFORMITE', 'Conformité'], ['GOUVERNANCE', 'Gouvernance'], ['STRATEGIQUE', 'Stratégique'], ['TIC', 'Système d\u2019information'], ['LBC_FT', 'LBC/FT'], ['AUTRE', 'Autre']];
    var lv = [['1', '1 \u2014 Très faible'], ['2', '2 \u2014 Faible'], ['3', '3 \u2014 Élevé'], ['4', '4 \u2014 Très élevé']];
    openModal('<h3>' + (isNew ? 'Nouveau risque' : 'Modifier le risque') + '</h3>' +
      '<div class="fld"><label for="g29r-lib">Libellé</label><input id="g29r-lib" value="' + esc(x.libelle || '') + '"></div>' +
      '<div class="fld"><label for="g29r-cat">Catégorie</label><select id="g29r-cat">' + gouvOpts(cats, x.categorie || 'OPERATIONNEL') + '</select></div>' +
      '<div class="fld"><label for="g29r-proc">Processus concerné</label><input id="g29r-proc" value="' + esc(x.processus || '') + '"></div>' +
      '<div class="fld"><label for="g29r-prob">Probabilité</label><select id="g29r-prob">' + gouvOpts(lv, String(x.probabilite || 2)) + '</select></div>' +
      '<div class="fld"><label for="g29r-imp">Impact</label><select id="g29r-imp">' + gouvOpts(lv, String(x.impact || 2)) + '</select></div>' +
      '<div class="fld"><label for="g29r-dispo">Mesures de maîtrise</label><textarea id="g29r-dispo" rows="2">' + esc(x.dispositif_maitrise || '') + '</textarea></div>' +
      '<div class="fld"><label for="g29r-resp">Responsable</label><input id="g29r-resp" value="' + esc(x.responsable || '') + '"></div>' +
      '<div class="fld"><label for="g29r-stat">Statut</label><select id="g29r-stat">' + gouvOpts([['ACTIF', 'Actif'], ['MAITRISE', 'Maîtrisé'], ['SURVEILLE', 'Sous surveillance'], ['CLOS', 'Clos']], x.statut || 'ACTIF') + '</select></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="g29r-cancel" type="button">Annuler</button><button class="btn btn--primary" id="g29r-save" type="button">Enregistrer</button></div>');
    $('g29r-cancel').addEventListener('click', closeModal);
    $('g29r-save').addEventListener('click', function () {
      var b = { libelle: $('g29r-lib').value.trim(), categorie: $('g29r-cat').value, processus: $('g29r-proc').value.trim(),
        probabilite: $('g29r-prob').value, impact: $('g29r-imp').value, dispositif_maitrise: $('g29r-dispo').value.trim(),
        responsable: $('g29r-resp').value.trim(), statut: $('g29r-stat').value };
      if (!b.libelle) { notify('Indiquez le libellé du risque.', 'err'); return; }
      $('g29r-save').disabled = true;
      api(isNew ? '/api/v1/governance/risques' : '/api/v1/governance/risques/' + encodeURIComponent(x.id), isNew ? 'POST' : 'PUT', b)
        .then(function () { closeModal(); notify('Risque enregistré.', 'ok'); gouvReloadConformite(); })
        .catch(function (e) { $('g29r-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  function openG29Pca(x) {
    var isNew = !x; x = x || {};
    var types = [['PCA', 'Plan de continuité d\u2019activité'], ['PRA', 'Plan de reprise d\u2019activité'], ['PGI', 'Plan de gestion d\u2019incident'], ['PLAN_SECOURS', 'Plan de secours']];
    var res = [['SATISFAISANT', 'Satisfaisant'], ['PARTIEL', 'Partiel'], ['NON_SATISFAISANT', 'Non satisfaisant']];
    openModal('<h3>' + (isNew ? 'Nouveau plan de continuité' : 'Modifier le plan') + '</h3>' +
      '<div class="fld"><label for="g29p-lib">Libellé</label><input id="g29p-lib" value="' + esc(x.libelle || '') + '"></div>' +
      '<div class="fld"><label for="g29p-type">Type</label><select id="g29p-type">' + gouvOpts(types, x.type_plan || 'PCA') + '</select></div>' +
      '<div class="fld"><label for="g29p-resp">Responsable</label><input id="g29p-resp" value="' + esc(x.responsable || '') + '"></div>' +
      '<div class="fld"><label for="g29p-app">Date d\u2019approbation</label><input id="g29p-app" type="date" value="' + esc(gouvDate(x.date_approbation)) + '"></div>' +
      '<div class="fld"><label for="g29p-rev">Date de dernière revue</label><input id="g29p-rev" type="date" value="' + esc(gouvDate(x.date_derniere_revue)) + '"></div>' +
      '<div class="fld"><label for="g29p-ex">Date du dernier exercice de simulation</label><input id="g29p-ex" type="date" value="' + esc(gouvDate(x.date_dernier_exercice)) + '"></div>' +
      '<div class="fld"><label for="g29p-res">Résultat de l\u2019exercice</label><select id="g29p-res">' + gouvOpts(res, x.resultat_dernier_exercice, '\u2014 non réalisé \u2014') + '</select></div>' +
      '<div class="fld"><label for="g29p-stat">Statut</label><select id="g29p-stat">' + gouvOpts([['BROUILLON', 'Brouillon'], ['VALIDE', 'Validé'], ['REVISION_REQUISE', 'Révision requise'], ['OBSOLETE', 'Obsolète']], x.statut || 'VALIDE') + '</select></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="g29p-cancel" type="button">Annuler</button><button class="btn btn--primary" id="g29p-save" type="button">Enregistrer</button></div>');
    $('g29p-cancel').addEventListener('click', closeModal);
    $('g29p-save').addEventListener('click', function () {
      var b = { libelle: $('g29p-lib').value.trim(), type_plan: $('g29p-type').value, responsable: $('g29p-resp').value.trim(),
        date_approbation: $('g29p-app').value || null, date_derniere_revue: $('g29p-rev').value || null,
        date_dernier_exercice: $('g29p-ex').value || null, resultat_dernier_exercice: $('g29p-res').value || null, statut: $('g29p-stat').value };
      if (!b.libelle) { notify('Indiquez le libellé du plan.', 'err'); return; }
      $('g29p-save').disabled = true;
      api(isNew ? '/api/v1/governance/pca' : '/api/v1/governance/pca/' + encodeURIComponent(x.id), isNew ? 'POST' : 'PUT', b)
        .then(function () { closeModal(); notify('Plan enregistré.', 'ok'); gouvReloadConformite(); })
        .catch(function (e) { $('g29p-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  function openG29Incident(x) {
    var isNew = !x; x = x || {};
    var types = [['FRAUDE', 'Fraude'], ['VOL', 'Vol'], ['INTRUSION_SI', 'Intrusion informatique'], ['PANNE_SI', 'Panne informatique'],
      ['PANNE_ELECTRIQUE', 'Panne électrique'], ['INONDATION', 'Inondation'], ['INCENDIE', 'Incendie'], ['ARRET_ACTIVITE', 'Arrêt d\u2019activité'],
      ['ATTEINTE_DONNEES', 'Atteinte aux données'], ['BLANCHIMENT_SOUPCON', 'Soupçon de blanchiment'], ['AUTRE', 'Autre']];
    openModal('<h3>' + (isNew ? 'Déclarer un incident majeur' : 'Incident ' + esc(x.reference || '')) + '</h3>' +
      '<div class="fld"><label for="g29i-date">Date de l\u2019incident</label><input id="g29i-date" type="date" value="' + esc(gouvDate(x.date_incident) || new Date().toISOString().slice(0, 10)) + '"></div>' +
      '<div class="fld"><label for="g29i-type">Type</label><select id="g29i-type">' + gouvOpts(types, x.type_incident || 'AUTRE') + '</select></div>' +
      '<div class="fld"><label for="g29i-grav">Gravité</label><select id="g29i-grav">' + gouvOpts([['FAIBLE', 'Faible'], ['MOYENNE', 'Moyenne'], ['HAUTE', 'Haute'], ['CRITIQUE', 'Critique']], x.gravite || 'MOYENNE') + '</select></div>' +
      '<div class="fld"><label for="g29i-desc">Description</label><textarea id="g29i-desc" rows="2">' + esc(x.description || '') + '</textarea></div>' +
      '<div class="fld"><label for="g29i-pertes">Pertes estimées (FCFA)</label><input id="g29i-pertes" type="number" min="0" value="' + esc(x.pertes_cents != null ? Number(x.pertes_cents) / 100 : '') + '"></div>' +
      '<div class="fld"><label>Notification BCEAO</label><label style="display:flex;gap:8px;align-items:center;font-weight:400"><input id="g29i-notif" type="checkbox"' + (x.notification_bceao ? ' checked' : '') + '> Incident notifié à la BCEAO</label></div>' +
      '<div class="fld"><label for="g29i-dnotif">Date de notification</label><input id="g29i-dnotif" type="date" value="' + esc(gouvDate(x.date_notification)) + '"></div>' +
      '<div class="fld"><label for="g29i-stat">Statut</label><select id="g29i-stat">' + gouvOpts([['OUVERT', 'Ouvert'], ['EN_COURS', 'En cours de traitement'], ['RESOLU', 'Résolu'], ['CLOS', 'Clos']], x.statut || 'OUVERT') + '</select></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="g29i-cancel" type="button">Annuler</button><button class="btn btn--primary" id="g29i-save" type="button">Enregistrer</button></div>');
    $('g29i-cancel').addEventListener('click', closeModal);
    $('g29i-save').addEventListener('click', function () {
      var b = { date_incident: $('g29i-date').value || null, type_incident: $('g29i-type').value, gravite: $('g29i-grav').value,
        description: $('g29i-desc').value.trim(), pertes_cents: Math.round(Number($('g29i-pertes').value || 0) * 100),
        notification_bceao: $('g29i-notif').checked, date_notification: $('g29i-dnotif').value || null, statut: $('g29i-stat').value };
      $('g29i-save').disabled = true;
      api(isNew ? '/api/v1/governance/incidents' : '/api/v1/governance/incidents/' + encodeURIComponent(x.id), isNew ? 'POST' : 'PUT', b)
        .then(function () { closeModal(); notify('Incident enregistré.', 'ok'); gouvReloadConformite(); })
        .catch(function (e) { $('g29i-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  /* --- C. Conformité & reporting réglementaire --- */
  function renderG29Conformite(host) {
    var E = G29.data.ech, L = G29.data.lbc, d = G29.data.dash;
    var p = d.parametres || {};
    var html = g29Head('Conformité et reporting réglementaire',
      'Échéancier des obligations par autorité (alertes automatiques J-30 / J-15 / J-5), formation LBC/FT du personnel et Pack Inspection.',
      (gouvCanWrite() ? '<button class="btn btn--primary" id="btn-g29-ech" type="button">+ Obligation</button>' : ''));
    html += g29Alertes(E.alertes || []);
    html += '<div class="g29-grid">' + g29Stat(E.kpis.total, 'Obligations suivies') + g29Stat(E.kpis.en_retard, 'En retard sans récépissé') +
      g29Stat(E.kpis.recus, 'Récépissés reçus') + g29Stat(L.taux_couverture + ' %', 'Personnel formé LBC/FT (' + L.formes + '/' + L.effectif + ')',
        '<div class="g29-bar"><i class="' + (L.taux_couverture >= 80 ? '' : (L.taux_couverture >= 50 ? 'warn' : 'bad')) + '" style="width:' + Math.min(100, L.taux_couverture) + '%"></i></div>') + '</div>';

    html += '<div class="g29-scroll"><table class="tbl"><thead><tr><th>Obligation</th><th>Autorité</th><th>Échéance</th><th>Jours</th><th>Récépissé</th><th>Statut</th><th></th></tr></thead><tbody>' +
      (E.echeances || []).map(function (x) {
        var kind = x.statut_calcule === 'EN_RETARD' ? 'bad' : (x.statut_calcule === 'RECEPISSE_RECU' ? 'ok' : (x.alerte ? 'warn' : 'info'));
        return '<tr><td><b>' + esc(x.libelle) + '</b><br><span class="hint" style="font-size:11px">' + esc(x.categorie) + ' \u00b7 ' + esc(x.periodicite) + '</span></td>' +
          '<td>' + esc(x.autorite) + '</td><td>' + gouvDateFr(x.date_limite_depot || x.date_echeance) + '</td>' +
          '<td>' + (x.jours_restants < 0 ? g29Pill('J+' + Math.abs(x.jours_restants), 'bad') : (x.alerte ? g29Pill('J-' + x.jours_restants, 'warn') : x.jours_restants + ' j')) + '</td>' +
          '<td>' + (x.reference_recepisse ? esc(x.reference_recepisse) : '\u2014') + '</td>' +
          '<td>' + g29Pill(String(x.statut_calcule).replace(/_/g, ' '), kind) + '</td>' +
          '<td style="text-align:right">' + (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" data-g29-ech="' + esc(x.id) + '" type="button">Modifier</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    html += '<h4 style="font-size:13px;margin:18px 0 8px">Paramètres prudentiels (par pays)</h4>';
    html += '<p class="hint">Plafond individuel apparenté ' + g29Pct(p.plafond_apparente_individuel_pct) + ' \u00b7 plafond global apparentés ' + g29Pct(p.plafond_apparentes_global_pct) +
      ' \u00b7 seuil d\u2019information des titres ' + g29Pct(p.seuil_participation_pct) + ' \u00b7 revue PCA ' + (p.revue_pca_jours || 365) + ' jours \u00b7 rappels J-' + String(p.alertes_jours || '30,15,5').split(',').join('/J-') + '.</p>' +
      '<p class="hint" style="margin-top:6px">Ces valeurs doivent être confirmées auprès de la BCEAO / de la Commission Bancaire avant production. Elles se modifient via l\u2019API des paramètres (réservée aux profils d\u2019administration).</p>';

    host.innerHTML = html;
    var n = $('btn-g29-ech'); if (n) n.addEventListener('click', function () { openG29Echeance(null); });
    host.querySelectorAll('[data-g29-ech]').forEach(function (b) {
      b.addEventListener('click', function () { var x = (E.echeances || []).filter(function (y) { return y.id === b.dataset.g29Ech; })[0]; openG29Echeance(x || null); });
    });
  }

  function openG29Echeance(x) {
    var isNew = !x; x = x || {};
    var aut = [['BCEAO', 'BCEAO'], ['COMMISSION_BANCAIRE', 'Commission Bancaire'], ['MINISTERE_FINANCES', 'Ministère des Finances'], ['CENTIF', 'CENTIF'], ['CONSEIL_REGIONAL', 'Conseil régional'], ['AUTRE', 'Autre']];
    var cat = [['NORMALE', 'Normale'], ['PRUDENTIELLE', 'Prudentielle'], ['COMPTABLE', 'Comptable'], ['LBC_FT', 'LBC/FT'], ['STATISTIQUE', 'Statistique'], ['FISCALE', 'Fiscale'], ['SOCIALE', 'Sociale']];
    var per = [['HEBDOMADAIRE', 'Hebdomadaire'], ['MENSUELLE', 'Mensuelle'], ['TRIMESTRIELLE', 'Trimestrielle'], ['SEMESTRIELLE', 'Semestrielle'], ['ANNUELLE', 'Annuelle'], ['PONCTUELLE', 'Ponctuelle']];
    var stat = [['A_FAIRE', 'À faire'], ['EN_PREPARATION', 'En préparation'], ['DEPOSE', 'Déposé'], ['RECEPISSE_RECU', 'Récépissé reçu'], ['SANS_OBJET', 'Sans objet']];
    openModal('<h3>' + (isNew ? 'Nouvelle obligation réglementaire' : 'Modifier l\u2019échéance') + '</h3>' +
      '<div class="fld"><label for="g29e-lib">Libellé</label><input id="g29e-lib" value="' + esc(x.libelle || '') + '"></div>' +
      '<div class="fld"><label for="g29e-aut">Autorité</label><select id="g29e-aut">' + gouvOpts(aut, x.autorite || 'BCEAO') + '</select></div>' +
      '<div class="fld"><label for="g29e-cat">Catégorie</label><select id="g29e-cat">' + gouvOpts(cat, x.categorie || 'NORMALE') + '</select></div>' +
      '<div class="fld"><label for="g29e-per">Périodicité</label><select id="g29e-per">' + gouvOpts(per, x.periodicite || 'MENSUELLE') + '</select></div>' +
      '<div class="fld"><label for="g29e-ech">Échéance</label><input id="g29e-ech" type="date" value="' + esc(gouvDate(x.date_echeance)) + '"></div>' +
      '<div class="fld"><label for="g29e-lim">Limite de dépôt</label><input id="g29e-lim" type="date" value="' + esc(gouvDate(x.date_limite_depot)) + '"></div>' +
      '<div class="fld"><label for="g29e-stat">Statut</label><select id="g29e-stat">' + gouvOpts(stat, x.statut || 'A_FAIRE') + '</select></div>' +
      '<div class="fld"><label for="g29e-ref">Référence du récépissé</label><input id="g29e-ref" value="' + esc(x.reference_recepisse || '') + '"></div>' +
      '<div class="fld"><label for="g29e-rec">Date du récépissé</label><input id="g29e-rec" type="date" value="' + esc(gouvDate(x.date_recepisse)) + '"></div>' +
      '<div class="fld"><label for="g29e-resp">Responsable</label><input id="g29e-resp" value="' + esc(x.responsable || '') + '"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="g29e-cancel" type="button">Annuler</button><button class="btn btn--primary" id="g29e-save" type="button">Enregistrer</button></div>');
    $('g29e-cancel').addEventListener('click', closeModal);
    $('g29e-save').addEventListener('click', function () {
      var b = { libelle: $('g29e-lib').value.trim(), autorite: $('g29e-aut').value, categorie: $('g29e-cat').value,
        periodicite: $('g29e-per').value, date_echeance: $('g29e-ech').value || null, date_limite_depot: $('g29e-lim').value || null,
        statut: $('g29e-stat').value, reference_recepisse: $('g29e-ref').value.trim(), date_recepisse: $('g29e-rec').value || null,
        responsable: $('g29e-resp').value.trim() };
      if (!b.libelle) { notify('Indiquez le libellé de l\u2019obligation.', 'err'); return; }
      if (b.date_recepisse && b.statut !== 'RECEPISSE_RECU') b.statut = 'RECEPISSE_RECU';
      $('g29e-save').disabled = true;
      api(isNew ? '/api/v1/governance/echeancier' : '/api/v1/governance/echeancier/' + encodeURIComponent(x.id), isNew ? 'POST' : 'PUT', b)
        .then(function () { closeModal(); notify('Échéance enregistrée.', 'ok'); gouvReloadConformite(); })
        .catch(function (e) { $('g29e-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  /* ===== VAGUE 34 : ACTIONNARIAT / SOCIÉTARIAT =====
     Un seul écran pour le capital : qui détient quoi, les mouvements de titres
     (souscription, libération, cession, sortie), les bénéficiaires effectifs et
     la feuille de présence en assemblée générale (quorum + exports PDF/Excel).
     Toutes les décisions (plafonds, seuils, quorum, éligibilité) sont prises par
     le moteur côté serveur : l'écran affiche, il ne décide pas. */
  var CAP = { loaded: false, syn: null, det: [], mv: [], ben: [], benInvalides: [], param: null,
    clients: [], forme: null, coop: false, sessions: [], sessionId: '', presence: null };

  var CAP_MOTIFS = {
    nombre_titres_invalide: 'Indiquez un nombre de titres supérieur à zéro.',
    titres_insuffisants: 'Le nombre de titres demandé dépasse le solde du détenteur.',
    detenteur_non_actif: 'Ce détenteur n’est plus actif : aucun nouveau mouvement n’est possible.',
    montant_libere_superieur_au_total: 'Le montant libéré ne peut pas dépasser le montant souscrit.',
    plafond_parts_societaire_depasse: 'Le plafond de parts de ce sociétaire serait dépassé.',
    retrait_bloque_credit_en_cours: 'Sortie impossible : le sociétaire a un crédit en cours.',
    capital_sous_minimum_reglementaire: 'Sortie impossible : le capital passerait sous le minimum réglementaire.',
    seuil_information_bceao: 'Seuil de participation franchi : autorisation préalable de la BCEAO requise.',
    seuil_autorisation_bceao: 'Seuil de contrôle franchi : autorisation préalable de la BCEAO requise.',
    plafond_procurations_depasse: 'Nombre maximum de procurations portées par ce mandataire atteint.',
    mandataire_invalide: 'Le mandataire choisi n’est pas un détenteur actif.',
    pv_verrouille: 'Le procès-verbal est signé et verrouillé : la feuille de présence n’est plus modifiable.',
    beneficiaire_reserve_personne_morale: 'Un bénéficiaire effectif se déclare pour une personne morale.',
    beneficiaire_deja_declare: 'Ce bénéficiaire est déjà déclaré pour ce détenteur.',
    numero_registre_deja_utilise: 'Ce numéro de registre est déjà utilisé.',
    personne_morale_non_societaire: 'Dans une coopérative, un sociétaire est une personne physique.',
    session_et_detenteur_requis: 'Choisissez une session et un détenteur.',
    session_required: 'Choisissez une session.',
    session_not_found: 'Cette session est introuvable.',
    not_found: 'Élément introuvable.'
  };

  function capMsg(e) {
    var k = (e && e.message) ? e.message : e;
    if (CAP_MOTIFS[k]) return CAP_MOTIFS[k];
    if (e && e.serverMessage) return e.serverMessage;
    return fr(e);
  }
  function capTitre() { return CAP.coop ? 'parts sociales' : 'actions'; }
  function capTitreUn(n, maj) {
    var s = Number(n) === 1 ? (CAP.coop ? 'part sociale' : 'action') : capTitre();
    return maj ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
  function capFind(id) {
    return (CAP.det || []).filter(function (x) { return x.id === id; })[0] || null;
  }

  /* ---------- Chargement ---------- */
  function loadCapital(force) {
    if (CAP.loaded && !force) { renderCapPane(); return Promise.resolve(); }
    var host = $('gouv-pane-actionnariat');
    if (host && !(CAP.syn && CAP.syn.titres_total != null)) host.innerHTML = '<div class="empty">Chargement de l’actionnariat…</div>';
    return Promise.all([
      api('/api/v1/governance/capital/synthese'),
      api('/api/v1/governance/capital/detenteurs'),
      api('/api/v1/governance/capital/mouvements'),
      api('/api/v1/governance/capital/beneficiaires'),
      api('/api/v1/governance/sessions')
    ]).then(function (r) {
      CAP.syn = r[0] || {};
      CAP.forme = (r[1] && r[1].forme_juridique) || CAP.syn.forme || null;
      CAP.coop = !!((r[1] && r[1].est_scoop) || CAP.syn.coop);
      CAP.det = (r[1] && r[1].detenteurs) || [];
      CAP.clients = (r[1] && r[1].clients) || [];
      CAP.mv = (r[2] && r[2].mouvements) || [];
      CAP.ben = (r[3] && r[3].beneficiaires) || [];
      CAP.benInvalides = (r[3] && r[3].personnes_morales_sans_beneficiaire) || [];
      CAP.param = (r[1] && r[1].parametres) || CAP.syn.parametres || {};
      CAP.sessions = (r[4] && r[4].sessions) || [];
      CAP.loaded = true;
      renderCapPane();
      loadPresence(CAP.sessionId);
    }).catch(function (e) {
      if (guard(e)) return;
      if (e.message === 'forbidden' || e.message === 'missing_permission') {
        if (host) host.innerHTML = '<div class="empty">Module réservé aux institutions.</div>';
        return;
      }
      if (host) {
        host.innerHTML = '<div class="empty">Chargement impossible : ' + esc(capMsg(e)) +
          ' <button class="btn btn--sm btn--ghost" id="cap-retry" type="button">Réessayer</button></div>';
        var rt = $('cap-retry'); if (rt) rt.addEventListener('click', function () { capReload(); });
      }
      notify(capMsg(e), 'err');
    });
  }
  function capReload() { CAP.loaded = false; return loadCapital(true); }

  /* ---------- Vue d'ensemble ---------- */
  function renderCapPane() {
    var host = $('gouv-pane-actionnariat');
    if (!host) return;
    var s = CAP.syn || {};
    var label = CAP.coop ? 'Sociétariat (coopérative)' : 'Actionnariat (société anonyme)';
    var regle = s.regle_voix || (CAP.coop ? '1 sociétaire = 1 voix' : '1 action = 1 voix');
    var lib = capTitre();

    var kpis =
      '<div class="kpi kpi--dark"><b>' + fmtAmount(s.titres_total || 0) + '</b><span>' + esc(capTitreUn(s.titres_total || 0, true)) + ' en circulation</span></div>' +
      kpi(gouvMoney(s.capital_libere), 'Capital libéré') +
      kpi(gouvMoney(s.capital_souscrit), 'Capital souscrit') +
      kpi(gouvMoney(s.capital_non_libere), 'Non libéré (à recevoir)') +
      kpi(s.nombre_actifs || 0, CAP.coop ? 'Sociétaires actifs' : 'Actionnaires actifs') +
      '<div class="kpi"><b>' + (s.conforme_minimum === true ? 'Conforme' : (s.conforme_minimum === false ? 'Sous le minimum' : '—')) +
        '</b><span>Minimum réglementaire' + (s.capital_minimum_reglementaire != null ? ' (' + fmtAmount(s.capital_minimum_reglementaire) + ' FCFA)' : '') + '</span></div>' +
      kpi(s.part_premier == null ? '—' : s.part_premier + ' %', 'Part du 1er détenteur') +
      kpi(s.part_cinq_premiers == null ? '—' : s.part_cinq_premiers + ' %', 'Part des 5 premiers') +
      kpi(s.mouvements_en_attente || 0, 'En attente d’autorisation');

    var alertes = [];
    if (s.conforme_minimum === false) {
      alertes.push('<div class="g29-alert crit">Capital libéré inférieur au minimum réglementaire (' +
        fmtAmount(s.capital_minimum_reglementaire || 0) + ' FCFA). Renforcez les libérations avant tout retrait.</div>');
    }
    if (Number(s.mouvements_en_attente || 0) > 0) {
      alertes.push('<div class="g29-alert haut">' + s.mouvements_en_attente +
        ' mouvement(s) franchissent un seuil de participation : joignez l’autorisation BCEAO pour les valider.</div>');
    }
    (CAP.benInvalides || []).forEach(function (x) {
      alertes.push('<div class="g29-alert haut">LBC/FT : ' + esc(x.nom_ou_raison_sociale || '') +
        ' (personne morale) n’a pas de bénéficiaire effectif déclaré.</div>');
    });

    var head = '<div class="cap-head">' +
      '<div><h3>' + esc(label) + '</h3><p class="hint">Règle de vote appliquée : <b>' + esc(regle) + '</b>' +
      (CAP.forme ? ' · Forme juridique : ' + esc(CAP.forme) : '') +
      '. Les plafonds, seuils et quorums sont contrôlés avant chaque enregistrement.</p></div>' +
      '<div class="cap-actions">' +
      (gouvCanWrite() ? '<button class="btn btn--sm btn--primary" id="cap-new-det" type="button">+ ' + (CAP.coop ? 'Nouveau sociétaire' : 'Nouvel actionnaire') + '</button>' : '') +
      '<button class="btn btn--sm btn--ghost" id="cap-param" type="button">Paramètres du capital</button>' +
      '<button class="btn btn--sm btn--ghost" id="cap-refresh" type="button">Actualiser</button>' +
      '</div></div>';

    var actifs = (CAP.det || []).filter(function (d) { return d.statut === 'ACTIF'; })
      .sort(function (a, b) { return Number(b.titres || 0) - Number(a.titres || 0); });
    var total = Number(s.titres_total || 0) || 1;
    var repart = actifs.length ? actifs.slice(0, 12).map(function (d) {
      var pct = +((Number(d.titres || 0) / total) * 100).toFixed(2);
      return '<div class="cap-row"><span class="cap-name" title="' + esc(d.nom_ou_raison_sociale) + '">' +
        esc(d.nom_ou_raison_sociale) + (d.est_membre_fondateur ? ' <span class="g-badge g-badge--info">fondateur</span>' : '') +
        '</span><span class="cap-bar"><i style="width:' + Math.max(1, Math.min(100, pct)) + '%"></i></span>' +
        '<b class="cap-pct">' + pct + ' %</b><span class="hint cap-tn">' + fmtAmount(d.titres || 0) + ' ' + esc(lib) + '</span></div>';
    }).join('') : '<div class="empty">Aucun détenteur enregistré.</div>';

    host.innerHTML = head + '<div class="kpi-grid">' + kpis + '</div>' +
      (alertes.length ? '<div class="cap-alerts">' + alertes.join('') + '</div>' : '') +
      '<div class="cap-cards">' +
        '<div class="cap-card"><div class="cap-card__head"><h4>Répartition du capital</h4><span class="hint">12 premiers détenteurs</span></div>' + repart + '</div>' +
        '<div class="cap-card"><div class="cap-card__head"><h4>Paramètres en vigueur</h4></div>' + capParamResume() + '</div>' +
      '</div>' +
      '<div class="cap-card" id="cap-host-det"></div>' +
      '<div class="cap-card" id="cap-host-mv"></div>' +
      '<div class="cap-card" id="cap-host-ben"></div>' +
      '<div class="cap-card" id="cap-host-presence"></div>';

    var b1 = $('cap-new-det'); if (b1) b1.addEventListener('click', function () { openDetenteurModal(null); });
    var b2 = $('cap-param'); if (b2) b2.addEventListener('click', openParamCapitalModal);
    var b3 = $('cap-refresh'); if (b3) b3.addEventListener('click', function () { capReload(); });
    renderCapDetenteurs();
    renderCapMouvements();
    renderCapBeneficiaires();
    renderCapPresence();
  }

  function capParamResume() {
    var p = CAP.param || {};
    var vn = p.valeur_nominale_part_cents != null ? fmtAmount(Number(p.valeur_nominale_part_cents) / 100) + ' FCFA' : 'non fixée';
    var mn = p.capital_minimum_reglementaire_cents != null ? fmtAmount(Number(p.capital_minimum_reglementaire_cents) / 100) + ' FCFA' : 'non fixé';
    var rows = [
      ['Valeur nominale d’une ' + capTitreUn(2), vn],
      ['Capital minimum réglementaire', mn],
      ['Plafond par ' + (CAP.coop ? 'sociétaire' : 'actionnaire'), p.plafond_parts_par_membre != null ? fmtAmount(p.plafond_parts_par_membre) + ' ' + capTitre() : '—'],
      ['Procurations par mandataire', p.plafond_procurations_par_membre != null ? String(p.plafond_procurations_par_membre) : '—'],
      ['Seuils de participation surveillés', (p.seuils && p.seuils.length ? p.seuils.join(' · ') + ' %' : (p.seuils_participation_pct ? String(p.seuils_participation_pct) + ' %' : '—'))],
      ['Quorum AGO (1re convocation)', (p.quorum_ago_1_pct != null ? p.quorum_ago_1_pct : '—') + ' %'],
      ['Quorum AGO (2e convocation)', (p.quorum_ago_2_pct != null ? p.quorum_ago_2_pct : '—') + ' %'],
      ['Quorum AGE', (p.quorum_age_pct != null ? p.quorum_age_pct : '—') + ' %']
    ];
    return '<table class="tbl tbl--tight"><tbody>' + rows.map(function (r) {
      return '<tr><td>' + esc(r[0]) + '</td><td style="text-align:right;font-weight:700">' + esc(r[1]) + '</td></tr>';
    }).join('') + '</tbody></table>';
  }

  /* ---------- Registre des détenteurs ---------- */
  function renderCapDetenteurs() {
    var host = $('cap-host-det');
    if (!host) return;
    var l = CAP.det || [];
    var rows = l.length ? l.map(function (d) {
      var st = { ACTIF: 'ok', DEMISSIONNAIRE: 'info', EXCLU: 'bad', DECEDE: 'info' }[d.statut] || 'info';
      var cat = CAP.coop ? 'Sociétaire' : (d.categorie === 'MEMBRE_SCOOP' ? 'Membre' : (d.type_entite === 'PERSONNE_MORALE' ? 'Personne morale' : 'Personne physique'));
      var el = d.eligible_ca === true ? gouvBadge('éligible CA', 'ok') : (d.eligible_ca === false ? gouvBadge('inéligible', 'bad') : '');
      return '<tr><td><b>' + esc(d.nom_ou_raison_sociale) + '</b><br><span class="hint" style="font-size:11px">' +
        esc(d.numero_registre || '—') + (d.client_nom ? ' · client ' + esc(d.client_nom) : '') + '</span></td>' +
        '<td>' + esc(cat) + '</td>' +
        '<td style="text-align:right">' + fmtAmount(d.titres || 0) + '</td>' +
        '<td style="text-align:right">' + (d.part_pct == null ? '—' : d.part_pct + ' %') + '</td>' +
        '<td>' + gouvBadge(String(d.statut || '').replace('_', ' ').toLowerCase(), st) + ' ' + el + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
          '<button class="btn btn--sm btn--ghost" data-cap-mv="' + esc(d.id) + '" type="button">Mouvement</button> ' +
          (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" data-cap-el="' + esc(d.id) + '" type="button">Éligibilité</button> ' +
            '<button class="btn btn--sm btn--ghost" data-cap-edit="' + esc(d.id) + '" type="button">Modifier</button>' : '') +
        '</td></tr>';
    }).join('') : '<tr><td colspan="6"><div class="empty">Aucun détenteur enregistré. Commencez par créer le premier ' +
      (CAP.coop ? 'sociétaire' : 'actionnaire') + '.</div></td></tr>';

    host.innerHTML = '<div class="cap-card__head"><h4>Registre des ' + (CAP.coop ? 'sociétaires' : 'actionnaires') + '</h4>' +
      '<span class="hint">' + l.length + ' inscrit(s)</span></div>' +
      '<div class="g29-scroll"><table class="tbl"><thead><tr><th>Nom / raison sociale</th><th>Qualité</th>' +
      '<th style="text-align:right">' + esc(capTitreUn(2, true)) + '</th><th style="text-align:right">Part</th>' +
      '<th>Statut</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';

    host.querySelectorAll('[data-cap-mv]').forEach(function (b) {
      b.addEventListener('click', function () { openMouvementModal(capFind(b.getAttribute('data-cap-mv'))); });
    });
    host.querySelectorAll('[data-cap-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openDetenteurModal(capFind(b.getAttribute('data-cap-edit'))); });
    });
    host.querySelectorAll('[data-cap-el]').forEach(function (b) {
      b.addEventListener('click', function () { capEligibilite(b.getAttribute('data-cap-el'), b); });
    });
  }

  function capEligibilite(id, btn) {
    btn.disabled = true;
    api('/api/v1/governance/capital/eligibilite/' + encodeURIComponent(id))
      .then(function (r) {
        var m = (r.motifs_libelles && r.motifs_libelles.length) ? r.motifs_libelles.join(' · ') : 'Aucun motif d’inéligibilité.';
        capReload().then(function () {
          notify((r.eligible ? 'Éligible aux instances (CA, comité de crédit). ' : 'Inéligible. ') + m, r.eligible ? 'ok' : 'err');
        });
      })
      .catch(function (e) { btn.disabled = false; if (!guard(e)) notify(capMsg(e), 'err'); });
  }

  function openDetenteurModal(d) {
    var isNew = !d;
    d = d || {};
    var types = [['PERSONNE_PHYSIQUE', 'Personne physique'], ['PERSONNE_MORALE', 'Personne morale']];
    var cats = CAP.coop ? [['MEMBRE_SCOOP', 'Sociétaire (membre)']]
      : [['ACTIONNAIRE_SA', 'Actionnaire'], ['MEMBRE_SCOOP', 'Membre'], ['PORTEUR', 'Porteur de parts']];
    var statuts = [['ACTIF', 'Actif'], ['DEMISSIONNAIRE', 'Démissionnaire'], ['EXCLU', 'Exclu'], ['DECEDE', 'Décédé']];
    var clients = (CAP.clients || []).map(function (c) { return [c.id, (c.code_client || '') + ' — ' + c.full_name]; });
    var disp = isNew ? '' : ' disabled';
    openModal('<h3>' + (isNew ? 'Nouveau ' + (CAP.coop ? 'sociétaire' : 'détenteur de titres') : 'Modifier') + '</h3>' +
      '<p class="sub">' + (isNew ? 'Le numéro de registre est attribué automatiquement s’il n’est pas saisi.' : esc(d.nom_ou_raison_sociale || '')) + '</p>' +
      '<div class="fld"><label for="cd-nom">Nom ou raison sociale</label><input id="cd-nom" value="' + esc(d.nom_ou_raison_sociale || '') + '"></div>' +
      '<div class="fld"><label for="cd-type">Type d’entité</label><select id="cd-type"' + disp + '>' + gouvOpts(types, d.type_entite || 'PERSONNE_PHYSIQUE') + '</select></div>' +
      '<div class="fld"><label for="cd-cat">Qualité</label><select id="cd-cat"' + disp + '>' + gouvOpts(cats, d.categorie || cats[0][0]) + '</select></div>' +
      '<div class="fld"><label for="cd-reg">N° registre des ' + esc(capTitre()) + '</label><input id="cd-reg" value="' + esc(d.numero_registre || '') + '"' + disp + '></div>' +
      '<div class="fld"><label for="cd-tel">Téléphone</label><input id="cd-tel" value="' + esc(d.telephone || '') + '"></div>' +
      '<div class="fld"><label for="cd-mail">E-mail</label><input id="cd-mail" value="' + esc(d.email || '') + '"></div>' +
      '<div class="fld"><label for="cd-pays">Nationalité / pays du siège</label><input id="cd-pays" value="' + esc(d.nationalite_ou_pays_siege || '') + '"></div>' +
      '<div class="fld"><label for="cd-adh">Date d’adhésion</label><input id="cd-adh" type="date" value="' + esc(gouvDate(d.date_adhesion)) + '"></div>' +
      '<div class="fld"><label for="cd-client">Compte client rattaché (facultatif)</label><select id="cd-client">' + gouvOpts(clients, d.client_id, '— aucun —') + '</select></div>' +
      '<div class="fld"><label for="cd-plaf">Plafond individuel de ' + esc(capTitre()) + ' (facultatif)</label><input id="cd-plaf" type="number" min="1" value="' + esc(d.plafond_parts == null ? '' : d.plafond_parts) + '"></div>' +
      (isNew
        ? '<div class="fld"><label><input id="cd-fond" type="checkbox"> ' + (CAP.coop ? 'Sociétaire fondateur' : 'Actionnaire fondateur') + '</label></div>'
        : '<div class="fld"><label for="cd-stat">Statut</label><select id="cd-stat">' + gouvOpts(statuts, d.statut || 'ACTIF') + '</select></div>') +
      '<div class="fld"><label for="cd-obs">Observations</label><textarea id="cd-obs" rows="2">' + esc(d.observations || '') + '</textarea></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="cd-cancel" type="button">Annuler</button>' +
      (isNew ? '' : '<button class="btn btn--ghost" id="cd-sortie" type="button">Sortie du ' + (CAP.coop ? 'sociétaire' : 'détenteur') + '</button>') +
      '<button class="btn btn--primary" id="cd-save" type="button">Enregistrer</button></div>');

    $('cd-cancel').addEventListener('click', closeModal);
    var sv = $('cd-save');
    sv.addEventListener('click', function () {
      var b = {
        nom_ou_raison_sociale: $('cd-nom').value.trim(),
        telephone: $('cd-tel').value.trim(),
        email: $('cd-mail').value.trim(),
        nationalite_ou_pays_siege: $('cd-pays').value.trim(),
        date_adhesion: $('cd-adh').value || null,
        client_id: $('cd-client').value || null,
        plafond_parts: $('cd-plaf').value === '' ? null : $('cd-plaf').value,
        observations: $('cd-obs').value.trim()
      };
      if (!b.nom_ou_raison_sociale) { notify('Indiquez le nom ou la raison sociale.', 'err'); return; }
      if (isNew) {
        b.type_entite = $('cd-type').value;
        b.categorie = $('cd-cat').value;
        b.numero_registre = $('cd-reg').value.trim() || null;
        b.est_membre_fondateur = !!($('cd-fond') && $('cd-fond').checked);
      } else {
        b.statut = $('cd-stat').value;
      }
      sv.disabled = true;
      api(isNew ? '/api/v1/governance/capital/detenteurs' : '/api/v1/governance/capital/detenteurs/' + encodeURIComponent(d.id),
        isNew ? 'POST' : 'PUT', b)
        .then(function () { closeModal(); notify('Enregistré.', 'ok'); capReload(); })
        .catch(function (e) { sv.disabled = false; if (!guard(e)) notify(capMsg(e), 'err'); });
    });

    var so = $('cd-sortie');
    if (so) so.addEventListener('click', function () {
      so.disabled = true;
      api('/api/v1/governance/capital/sortie/' + encodeURIComponent(d.id))
        .then(function (r) {
          so.disabled = false;
          if (!r.ok) {
            notify('Sortie impossible : ' + ((r.motifs_libelles || []).join(' · ') || 'contrôles non satisfaits.'), 'err');
            return;
          }
          if (!window.confirm('Confirmer la sortie ? Le ' + (CAP.coop ? 'sociétaire' : 'détenteur') +
            ' passera « démissionnaire » et restera dans le registre (traçabilité).')) return;
          api('/api/v1/governance/capital/detenteurs/' + encodeURIComponent(d.id), 'PUT', { statut: 'DEMISSIONNAIRE' })
            .then(function () { closeModal(); notify('Sortie enregistrée.', 'ok'); capReload(); })
            .catch(function (e) { if (!guard(e)) notify(capMsg(e), 'err'); });
        })
        .catch(function (e) { so.disabled = false; if (!guard(e)) notify(capMsg(e), 'err'); });
    });
  }

  /* ---------- Mouvements de titres ---------- */
  function renderCapMouvements() {
    var host = $('cap-host-mv');
    if (!host) return;
    var l = (CAP.mv || []).slice(0, 40);
    var ops = { SOUSCRIPTION_INITIALE: 'Souscription', LIBERATION: 'Libération', CESSION: 'Cession',
      REMBOURSEMENT_SORTIE: 'Remboursement (sortie)', AUGMENTATION: 'Augmentation' };
    var rows = l.length ? l.map(function (m) {
      var nom = m.detenteur_nom || m.nom_ou_raison_sociale || '—';
      var st = String(m.statut_validation||'').startsWith('EN_ATTENTE') ? gouvBadge('en attente BCEAO', 'warn') : gouvBadge('validé', 'ok');
      var montant = m.montant_total != null ? Number(m.montant_total) : null;
      return '<tr><td>' + gouvDateFr(m.date_operation) + '</td><td><b>' + esc(nom) + '</b></td>' +
        '<td>' + esc(ops[m.type_operation] || m.type_operation) + '</td>' +
        '<td style="text-align:right">' + fmtAmount(m.nombre_titres || 0) + '</td>' +
        '<td style="text-align:right">' + (montant == null ? '—' : fmtAmount(montant) + ' FCFA') + '</td>' +
        '<td>' + st + (m.seuils_franchis ? '<br><span class="hint" style="font-size:11px">seuils : ' + esc(m.seuils_franchis) + ' %</span>' : '') + '</td>' +
        '<td style="text-align:right">' + (String(m.statut_validation || '').indexOf('EN_ATTENTE') === 0 && gouvCanWrite()
          ? '<button class="btn btn--sm btn--primary" data-cap-auto="' + esc(m.id) + '" type="button">Autorisation BCEAO</button>' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="7"><div class="empty">Aucun mouvement enregistré.</div></td></tr>';

    host.innerHTML = '<div class="cap-card__head"><h4>Mouvements sur ' + esc(capTitre()) + '</h4>' +
      (gouvCanWrite() ? '<button class="btn btn--sm btn--ghost" id="cap-new-mv" type="button">+ Nouveau mouvement</button>' : '') + '</div>' +
      '<div class="g29-scroll"><table class="tbl"><thead><tr><th>Date</th><th>Détenteur</th><th>Opération</th>' +
      '<th style="text-align:right">Titres</th><th style="text-align:right">Montant</th><th>Statut</th><th></th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';
    var nw = $('cap-new-mv');
    if (nw) nw.addEventListener('click', function () { openMouvementModal(null); });
    host.querySelectorAll('[data-cap-auto]').forEach(function (b) {
      b.addEventListener('click', function () { openAutorisationModal(b.getAttribute('data-cap-auto')); });
    });
  }

  function openAutorisationModal(id) {
    openModal('<h3>Autorisation BCEAO</h3><p class="sub">Joignez la référence de l’autorisation préalable : le mouvement sera validé.</p>' +
      '<div class="fld"><label for="ca-ref">Référence de l’autorisation</label><input id="ca-ref"></div>' +
      '<div class="fld"><label for="ca-date">Date</label><input id="ca-date" type="date"></div>' +
      '<div class="fld"><label for="ca-url">Lien du document (facultatif)</label><input id="ca-url"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="ca-cancel" type="button">Annuler</button>' +
      '<button class="btn btn--primary" id="ca-save" type="button">Valider le mouvement</button></div>');
    $('ca-cancel').addEventListener('click', closeModal);
    $('ca-save').addEventListener('click', function () {
      var ref = $('ca-ref').value.trim();
      if (!ref) { notify('Indiquez la référence de l’autorisation.', 'err'); return; }
      $('ca-save').disabled = true;
      api('/api/v1/governance/capital/mouvements/' + encodeURIComponent(id) + '/autorisation', 'POST',
        { autorisation_reference: ref, autorisation_date: $('ca-date').value || null, autorisation_url: $('ca-url').value.trim() })
        .then(function () { closeModal(); notify('Mouvement validé.', 'ok'); capReload(); })
        .catch(function (e) { $('ca-save').disabled = false; if (!guard(e)) notify(capMsg(e), 'err'); });
    });
  }

  function openMouvementModal(d) {
    var actifs = (CAP.det || []).filter(function (x) { return x.statut === 'ACTIF'; });
    if (!actifs.length) { notify('Créez d’abord un ' + (CAP.coop ? 'sociétaire' : 'détenteur') + '.', 'err'); return; }
    var opts = actifs.map(function (x) {
      return [x.id, x.nom_ou_raison_sociale + ' — ' + fmtAmount(x.titres || 0) + ' ' + capTitre()];
    });
    var ops = CAP.coop
      ? [['SOUSCRIPTION_INITIALE', 'Souscription de parts'], ['LIBERATION', 'Libération de parts'],
        ['REMBOURSEMENT_SORTIE', 'Remboursement (sortie)']]
      : [['SOUSCRIPTION_INITIALE', 'Souscription'], ['LIBERATION', 'Libération'],
        ['CESSION', 'Cession'], ['AUGMENTATION', 'Augmentation de capital']];
    var vn = (CAP.param && CAP.param.valeur_nominale_part_cents != null)
      ? Number(CAP.param.valeur_nominale_part_cents) / 100 : '';
    openModal('<h3>Nouveau mouvement sur ' + esc(capTitre()) + '</h3>' +
      '<p class="sub">Contrôles automatiques : plafonds, crédit en cours, capital minimum, seuils de participation.</p>' +
      '<div class="fld"><label for="cm-det">Détenteur</label><select id="cm-det">' + gouvOpts(opts, d ? d.id : null, '— choisir —') + '</select></div>' +
      '<div class="fld"><label for="cm-op">Opération</label><select id="cm-op">' + gouvOpts(ops, 'SOUSCRIPTION_INITIALE') + '</select></div>' +
      '<div class="fld"><label for="cm-n">Nombre de ' + esc(capTitre()) + '</label><input id="cm-n" type="number" min="1" value="1"></div>' +
      '<div class="fld"><label for="cm-vn">Valeur nominale unitaire (FCFA)</label><input id="cm-vn" inputmode="numeric" value="' + esc(vn) + '"></div>' +
      '<div class="fld"><label for="cm-total">Montant total (FCFA)</label><input id="cm-total" inputmode="numeric"></div>' +
      '<div class="fld"><label for="cm-lib">Montant libéré maintenant (FCFA)</label><input id="cm-lib" inputmode="numeric"></div>' +
      '<div class="fld"><label for="cm-date">Date de l’opération</label><input id="cm-date" type="date" value="' + esc(gouvDate(new Date().toISOString())) + '"></div>' +
      '<div class="fld"><label for="cm-pce">Référence de la pièce comptable</label><input id="cm-pce"></div>' +
      '<div class="fld"><label for="cm-obs">Observations</label><textarea id="cm-obs" rows="2"></textarea></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="cm-cancel" type="button">Annuler</button>' +
      '<button class="btn btn--primary" id="cm-save" type="button">Enregistrer le mouvement</button></div>');

    $('cm-cancel').addEventListener('click', closeModal);
    var tot = $('cm-total');
    function majTotal() {
      if (tot.dataset.manual) return;
      var n = Number($('cm-n').value || 0);
      var v = digits($('cm-vn').value);
      if (n > 0 && v) tot.value = fmtAmount(n * Number(v));
    }
    $('cm-n').addEventListener('input', majTotal);
    $('cm-vn').addEventListener('input', majTotal);
    tot.addEventListener('input', function () { tot.dataset.manual = '1'; });

    $('cm-save').addEventListener('click', function () {
      var b = {
        detenteur_id: $('cm-det').value,
        type_operation: $('cm-op').value,
        nombre_titres: $('cm-n').value,
        valeur_nominale_unitaire: digits($('cm-vn').value) || null,
        montant_total: tot.value ? Number(digits(tot.value)) : null,
        montant_libere: $('cm-lib').value ? Number(digits($('cm-lib').value)) : null,
        date_operation: $('cm-date').value || null,
        reference_piece_comptable: $('cm-pce').value.trim(),
        observations: $('cm-obs').value.trim()
      };
      if (!b.detenteur_id) { notify('Choisissez le détenteur.', 'err'); return; }
      if (!(Number(b.nombre_titres) > 0)) { notify('Indiquez le nombre de ' + capTitre() + '.', 'err'); return; }
      var btn = $('cm-save');
      btn.disabled = true;
      api('/api/v1/governance/capital/mouvements', 'POST', b)
        .then(function (r) {
          closeModal();
          var msg = 'Mouvement enregistré.';
          if (r.seuils && r.seuils.length) {
            msg = String(r.statut_validation||'').startsWith('EN_ATTENTE')
              ? 'Seuil(s) ' + r.seuils.join(' %, ') + ' % franchi(s) : mouvement en attente d’autorisation BCEAO.'
              : 'Mouvement enregistré. Seuil(s) franchi(s) : ' + r.seuils.join(' %, ') + ' %.';
          }
          notify(msg, 'ok');
          capReload();
        })
        .catch(function (e) { btn.disabled = false; if (!guard(e)) notify(capMsg(e), 'err'); });
    });
  }

  /* ---------- Bénéficiaires effectifs (LBC/FT) ---------- */
  function renderCapBeneficiaires() {
    var host = $('cap-host-ben');
    if (!host) return;
    var pm = (CAP.det || []).filter(function (d) { return d.type_entite === 'PERSONNE_MORALE' && d.statut === 'ACTIF'; });
    var rows = (CAP.ben || []).length ? CAP.ben.map(function (b) {
      return '<tr><td><b>' + esc(b.nom_prenom) + '</b></td><td>' + esc(b.nom_ou_raison_sociale || '—') + '</td>' +
        '<td style="text-align:right">' + (b.pourcentage_detention_indirecte == null ? '—' : b.pourcentage_detention_indirecte + ' %') + '</td>' +
        '<td>' + esc(b.nature_controle || '—') + '</td><td>' + esc(b.pays_residence || '—') + '</td>' +
        '<td style="text-align:right">' + (gouvCanWrite()
          ? '<button class="btn btn--sm btn--ghost" data-cap-ben-del="' + esc(b.id) + '" type="button">Retirer</button>' : '') +
        '</td></tr>';
    }).join('') : '<tr><td colspan="6"><div class="empty">Aucun bénéficiaire effectif déclaré.</div></td></tr>';
    var missing = (CAP.benInvalides || []).map(function (x) {
      return '<div class="g29-alert haut">' + esc(x.nom_ou_raison_sociale || '') + ' : bénéficiaire effectif manquant.</div>';
    }).join('');

    host.innerHTML = '<div class="cap-card__head"><h4>Bénéficiaires effectifs (LBC/FT)</h4>' +
      (gouvCanWrite() && pm.length ? '<button class="btn btn--sm btn--ghost" id="cap-new-ben" type="button">+ Déclarer</button>' : '') + '</div>' +
      (missing ? '<div style="margin-bottom:10px">' + missing + '</div>' : '') +
      '<div class="g29-scroll"><table class="tbl"><thead><tr><th>Bénéficiaire</th><th>Détenteur (personne morale)</th>' +
      '<th style="text-align:right">Détention indirecte</th><th>Nature du contrôle</th><th>Pays</th><th></th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';

    var nw = $('cap-new-ben');
    if (nw) nw.addEventListener('click', openBeneficiaireModal);
    host.querySelectorAll('[data-cap-ben-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!window.confirm('Retirer ce bénéficiaire effectif ?')) return;
        api('/api/v1/governance/capital/beneficiaires/' + encodeURIComponent(b.getAttribute('data-cap-ben-del')), 'DELETE')
          .then(function () { notify('Retiré.', 'ok'); capReload(); })
          .catch(function (e) { if (!guard(e)) notify(capMsg(e), 'err'); });
      });
    });
  }

  function openBeneficiaireModal() {
    var pm = (CAP.det || []).filter(function (d) { return d.type_entite === 'PERSONNE_MORALE' && d.statut === 'ACTIF'; });
    openModal('<h3>Déclarer un bénéficiaire effectif</h3>' +
      '<p class="sub">Obligation LBC/FT : chaque personne morale détentrice déclare ses bénéficiaires effectifs.</p>' +
      '<div class="fld"><label for="cb-det">Détenteur (personne morale)</label><select id="cb-det">' +
        gouvOpts(pm.map(function (x) { return [x.id, x.nom_ou_raison_sociale]; }), null, '— choisir —') + '</select></div>' +
      '<div class="fld"><label for="cb-nom">Nom et prénom</label><input id="cb-nom"></div>' +
      '<div class="fld"><label for="cb-pct">Détention indirecte (%)</label><input id="cb-pct" type="number" min="0" max="100" step="0.01"></div>' +
      '<div class="fld"><label for="cb-nat">Nature du contrôle</label><select id="cb-nat">' +
        gouvOpts([['DETENTION_CAPITAL', 'Détention du capital'], ['DROITS_VOTE', 'Droits de vote'],
          ['CONTROLE_AUTRE', 'Autre contrôle']], 'DETENTION_CAPITAL') + '</select></div>' +
      '<div class="fld"><label for="cb-pays">Pays de résidence</label><input id="cb-pays"></div>' +
      '<div class="fld"><label for="cb-piece">Pièce d’identité (n°)</label><input id="cb-piece"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="cb-cancel" type="button">Annuler</button>' +
      '<button class="btn btn--primary" id="cb-save" type="button">Déclarer</button></div>');
    $('cb-cancel').addEventListener('click', closeModal);
    $('cb-save').addEventListener('click', function () {
      var b = {
        detenteur_id: $('cb-det').value,
        nom_prenom: $('cb-nom').value.trim(),
        pourcentage_detention_indirecte: $('cb-pct').value || 0,
        nature_controle: $('cb-nat').value,
        pays_residence: $('cb-pays').value.trim(),
        numero_piece: $('cb-piece').value.trim()
      };
      if (!b.detenteur_id || !b.nom_prenom) { notify('Choisissez le détenteur et indiquez le nom.', 'err'); return; }
      $('cb-save').disabled = true;
      api('/api/v1/governance/capital/beneficiaires', 'POST', b)
        .then(function () { closeModal(); notify('Bénéficiaire déclaré.', 'ok'); capReload(); })
        .catch(function (e) { $('cb-save').disabled = false; if (!guard(e)) notify(capMsg(e), 'err'); });
    });
  }

  /* ---------- Feuille de présence en AG ---------- */
  function capSessions() {
    return (CAP.sessions || []).filter(function (s) { return s.statut !== 'ANNULEE'; });
  }

  function loadPresence(sessionId) {
    var list = capSessions();
    if (!list.length) { CAP.presence = null; renderCapPresence(); return Promise.resolve(); }
    var ok = sessionId && list.some(function (s) { return s.id === sessionId; });
    CAP.sessionId = ok ? sessionId : list[0].id;
    return api('/api/v1/governance/capital/presence/' + encodeURIComponent(CAP.sessionId))
      .then(function (d) { CAP.presence = d; renderCapPresence(); })
      .catch(function (e) {
        CAP.presence = null;
        renderCapPresence();
        if (!guard(e)) notify(capMsg(e), 'err');
      });
  }

  function renderCapPresence() {
    var host = $('cap-host-presence');
    if (!host) return;
    var list = capSessions();
    if (!list.length) {
      host.innerHTML = '<div class="cap-card__head"><h4>Feuille de présence en assemblée générale</h4></div>' +
        '<div class="empty">Aucune session enregistrée. Créez une session dans l’onglet « Sessions & PV » : ' +
        'la feuille de présence et le quorum s’y rattachent.</div>';
      return;
    }
    var p = CAP.presence || {};
    var q = p.quorum || {};
    var sess = p.session || (list.filter(function (x) { return x.id === CAP.sessionId; })[0]) || {};
    var opts = list.map(function (s) {
      return [s.id, gouvDateFr(s.date_session) + ' — ' + (s.organe_libelle || s.type_session || 'session') +
        (s.pv_reference ? ' (' + s.pv_reference + ')' : '')];
    });
    var atteint = q.quorum_atteint === true;
    var pct = q.pourcentage != null ? q.pourcentage
      : (q.pct_presents != null ? q.pct_presents : (q.pct_voix != null ? q.pct_voix : null));
    var baseCoop = (q.base_calcul || (CAP.coop ? 'MEMBRES' : 'DROITS_DE_VOTE')) === 'MEMBRES';
    var nbPresents = (Number(q.membres_presents || 0) + Number(q.membres_representes || 0));
    var verrou = sess.statut === 'SIGNE_VERROUILLE';
    var lignes = p.lignes || [];
    var modes = { PRESENT: 'Présent', REPRESENTE_PROCURATION: 'Représenté (procuration)', ABSENT: 'Absent' };
    var rows = lignes.length ? lignes.map(function (l) {
      return '<tr><td><b>' + esc(l.nom_ou_raison_sociale) + '</b><br><span class="hint" style="font-size:11px">' +
        esc(l.numero_registre || '—') + '</span></td>' +
        '<td>' + esc(modes[l.mode_participation] || l.mode_participation || '—') +
        (l.mandataire_nom ? '<br><span class="hint" style="font-size:11px">par ' + esc(l.mandataire_nom) + '</span>' : '') + '</td>' +
        '<td style="text-align:right">' + fmtAmount(l.nombre_titres_retenus || 0) + '</td>' +
        '<td style="text-align:right">' + fmtAmount(l.nombre_voix_attribuees || 0) + '</td>' +
        '<td>' + (l.emargement_at ? gouvBadge('émargé', 'ok') : gouvBadge('non émargé', 'info')) + '</td>' +
        '<td>' + (l.emargement_at ? '<span class="hint" style="font-size:11px">' + dt(l.emargement_at) + '</span>' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="6"><div class="empty">Aucun détenteur émargé pour cette session.</div></td></tr>';

    var bar = '<div class="cap-quorum">' +
      '<div class="cap-quorum__bar"><i class="' + (atteint ? 'ok' : 'ko') + '" style="width:' +
        Math.max(2, Math.min(100, Number(pct || 0))) + '%"></i></div>' +
      '<div class="cap-quorum__lab">' +
        (q.quorum_atteint === true ? gouvBadge('Quorum atteint', 'ok')
          : (q.quorum_atteint === false ? gouvBadge('Quorum non atteint', 'warn') : gouvBadge('Quorum à calculer', 'info'))) +
        ' <span>' + (baseCoop
          ? 'Sociétaires représentés : <b>' + fmtAmount(nbPresents) + '</b> sur <b>' + fmtAmount(q.membres_total || 0) + '</b> inscrits'
          : 'Présents : <b>' + fmtAmount(q.voix_presents != null ? q.voix_presents : 0) + '</b> voix · représentés : <b>' +
            fmtAmount(q.voix_representees != null ? q.voix_representees : 0) + '</b> · total : <b>' +
            fmtAmount(q.voix_total != null ? q.voix_total : 0) + '</b> voix') +
        ' · quorum requis : <b>' + fmtAmount(q.quorum_requis_pct != null ? q.quorum_requis_pct : (q.quorum_requis || 0)) + ' %</b>' +
        (pct != null ? ' · <b>' + pct + ' %</b> atteints' : '') +
        (q.manque != null && q.manque > 0 ? ' · il manque <b>' + q.manque + ' pt</b>' : '') +
        '</span></div></div>';

    host.innerHTML = '<div class="cap-card__head"><h4>Feuille de présence en assemblée générale</h4>' +
      '<div class="cap-actions">' +
      '<button class="btn btn--sm btn--primary" id="cap-fp-pdf" type="button">Feuille de présence (PDF)</button>' +
      '<button class="btn btn--sm btn--ghost" id="cap-fp-xls" type="button">Feuille de présence (Excel)</button>' +
      (gouvCanWrite() && !verrou ? '<button class="btn btn--sm btn--ghost" id="cap-fp-add" type="button">+ Émarger un détenteur</button>' : '') +
      '</div></div>' +
      '<div class="fld cap-sel"><label for="cap-session">Session</label><select id="cap-session">' +
        gouvOpts(opts, CAP.sessionId) + '</select></div>' +
      '<p class="hint">Règle de vote : <b>' + esc(p.regle_voix || (CAP.coop ? '1 sociétaire = 1 voix' : '1 action = 1 voix')) +
      '</b>. La feuille PDF est en A4 paysage, prête à imprimer et signer ; l’export Excel contient la feuille, le récapitulatif de quorum et les absents.</p>' +
      bar +
      '<div class="g29-scroll" style="margin-top:12px"><table class="tbl"><thead><tr><th>Détenteur</th><th>Participation</th>' +
      '<th style="text-align:right">Titres retenus</th><th style="text-align:right">Voix</th><th>Émargement</th><th></th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';

    var sel = $('cap-session');
    if (sel) sel.addEventListener('change', function () { loadPresence(sel.value); });
    var b1 = $('cap-fp-pdf'); if (b1) b1.addEventListener('click', function () { capExport('pdf'); });
    var b2 = $('cap-fp-xls'); if (b2) b2.addEventListener('click', function () { capExport('xlsx'); });
    var b3 = $('cap-fp-add'); if (b3) b3.addEventListener('click', openEmargementModal);
  }

  function capExport(kind) {
    if (!CAP.sessionId) { notify('Choisissez une session.', 'err'); return; }
    window.open('/api/v1/governance/exports/feuille-presence.' + kind + '?session_id=' +
      encodeURIComponent(CAP.sessionId), '_blank');
  }

  function openEmargementModal() {
    var p = CAP.presence || {};
    var actifs = (CAP.det || []).filter(function (x) { return x.statut === 'ACTIF'; });
    var dejaLa = {};
    (p.lignes || []).forEach(function (l) { dejaLa[l.detenteur_id] = l; });
    var opts = actifs.map(function (x) {
      return [x.id, x.nom_ou_raison_sociale + (dejaLa[x.id] ? ' (déjà émargé)' : '') + ' — ' +
        fmtAmount(x.titres || 0) + ' ' + capTitre()];
    });
    openModal('<h3>Émargement à l’assemblée</h3><p class="sub">Le quorum est recalculé après chaque émargement.</p>' +
      '<div class="fld"><label for="ce-det">Détenteur</label><select id="ce-det">' + gouvOpts(opts, null, '— choisir —') + '</select></div>' +
      '<div class="fld"><label for="ce-mode">Participation</label><select id="ce-mode">' +
        gouvOpts([['PRESENT', 'Présent'], ['REPRESENTE_PROCURATION', 'Représenté par procuration']], 'PRESENT') + '</select></div>' +
      '<div class="fld" id="ce-mand-wrap" hidden><label for="ce-mand">Mandataire</label><select id="ce-mand">' +
        gouvOpts(opts, null, '— choisir —') + '</select></div>' +
      '<div class="fld"><label for="ce-titres">Titres retenus (vide = solde)</label><input id="ce-titres" type="number" min="0"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="ce-cancel" type="button">Annuler</button>' +
      '<button class="btn btn--primary" id="ce-save" type="button">Émarger</button></div>');
    $('ce-cancel').addEventListener('click', closeModal);
    $('ce-mode').addEventListener('change', function () {
      $('ce-mand-wrap').hidden = $('ce-mode').value !== 'REPRESENTE_PROCURATION';
    });
    $('ce-save').addEventListener('click', function () {
      var b = {
        session_id: CAP.sessionId,
        detenteur_id: $('ce-det').value,
        mode_participation: $('ce-mode').value,
        mandataire_id: $('ce-mode').value === 'REPRESENTE_PROCURATION' ? $('ce-mand').value : null,
        nombre_titres_retenus: $('ce-titres').value || null
      };
      if (!b.detenteur_id) { notify('Choisissez le détenteur.', 'err'); return; }
      if (b.mode_participation === 'REPRESENTE_PROCURATION' && !b.mandataire_id) { notify('Choisissez le mandataire.', 'err'); return; }
      $('ce-save').disabled = true;
      api('/api/v1/governance/capital/presence', 'POST', b)
        .then(function (r) {
          closeModal();
          notify(r.quorum && r.quorum.quorum_atteint === false
            ? 'Émargement enregistré — quorum encore non atteint.'
            : 'Émargement enregistré. Quorum vérifié.', 'ok');
          capReload();
        })
        .catch(function (e) { $('ce-save').disabled = false; if (!guard(e)) notify(capMsg(e), 'err'); });
    });
  }

  /* ---------- Paramètres du capital ---------- */
  function openParamCapitalModal() {
    var p = CAP.param || {};
    function fc(v) { return v == null ? '' : fmtAmount(Number(v) / 100); }
    function numOr(v) { return v == null ? '' : String(v); }
    openModal('<h3>Paramètres du capital</h3>' +
      '<p class="sub">Ces valeurs pilotent les contrôles automatiques (plafonds, seuils, quorum). Laissez vide un montant non fixé.</p>' +
      '<div class="fld"><label for="cp-vn">Valeur nominale d’une ' + esc(capTitreUn(2)) + ' (FCFA)</label>' +
        '<input id="cp-vn" inputmode="numeric" value="' + esc(fc(p.valeur_nominale_part_cents)) + '"></div>' +
      '<div class="fld"><label for="cp-min">Capital minimum réglementaire (FCFA)</label>' +
        '<input id="cp-min" inputmode="numeric" value="' + esc(fc(p.capital_minimum_reglementaire_cents)) + '"></div>' +
      '<div class="fld"><label for="cp-plaf">Plafond de ' + esc(capTitre()) + ' par ' + (CAP.coop ? 'sociétaire' : 'actionnaire') + '</label>' +
        '<input id="cp-plaf" type="number" min="1" value="' + esc(numOr(p.plafond_parts_par_membre)) + '"></div>' +
      '<div class="fld"><label for="cp-proc">Procurations maximum par mandataire</label>' +
        '<input id="cp-proc" type="number" min="0" value="' + esc(numOr(p.plafond_procurations_par_membre)) + '"></div>' +
      '<div class="fld"><label for="cp-seuils">Seuils de participation surveillés (%) — séparés par une virgule</label>' +
        '<input id="cp-seuils" value="' + esc(p.seuils_participation_pct || '10,20,33,50') + '"></div>' +
      '<div class="fld"><label for="cp-q1">Quorum AGO 1re convocation (%)</label>' +
        '<input id="cp-q1" type="number" min="0" max="100" value="' + esc(numOr(p.quorum_ago_1_pct)) + '"></div>' +
      '<div class="fld"><label for="cp-q2">Quorum AGO 2e convocation (%)</label>' +
        '<input id="cp-q2" type="number" min="0" max="100" value="' + esc(numOr(p.quorum_ago_2_pct)) + '"></div>' +
      '<div class="fld"><label for="cp-q3">Quorum AGE (%)</label>' +
        '<input id="cp-q3" type="number" min="0" max="100" value="' + esc(numOr(p.quorum_age_pct)) + '"></div>' +
      '<div class="fld"><label><input id="cp-credit" type="checkbox"' + (p.bloquer_retrait_credit_en_cours === false ? '' : ' checked') +
        '> Bloquer la sortie d’un membre ayant un crédit en cours</label></div>' +
      '<div class="fld"><label><input id="cp-minblock" type="checkbox"' + (p.bloquer_retrait_sous_capital_min === false ? '' : ' checked') +
        '> Bloquer le retrait qui ferait passer le capital sous le minimum</label></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="cp-cancel" type="button">Annuler</button>' +
      '<button class="btn btn--primary" id="cp-save" type="button">Enregistrer</button></div>');
    $('cp-cancel').addEventListener('click', closeModal);
    $('cp-save').addEventListener('click', function () {
      var b = {
        valeur_nominale_part_fcfa: $('cp-vn').value ? digits($('cp-vn').value) : null,
        capital_minimum_reglementaire_fcfa: $('cp-min').value ? digits($('cp-min').value) : null,
        plafond_parts_par_membre: $('cp-plaf').value || null,
        plafond_procurations_par_membre: $('cp-proc').value || null,
        seuils_participation_pct: $('cp-seuils').value.trim(),
        quorum_ago_1_pct: $('cp-q1').value || null,
        quorum_ago_2_pct: $('cp-q2').value || null,
        quorum_age_pct: $('cp-q3').value || null,
        bloquer_retrait_credit_en_cours: $('cp-credit').checked,
        bloquer_retrait_sous_capital_min: $('cp-minblock').checked
      };
      $('cp-save').disabled = true;
      api('/api/v1/governance/capital/parametres', 'PUT', b)
        .then(function () { closeModal(); notify('Paramètres enregistrés.', 'ok'); capReload(); })
        .catch(function (e) { $('cp-save').disabled = false; if (!guard(e)) notify(capMsg(e), 'err'); });
    });
  }

  /* --- Export PDF / impression du tableau de bord --- */
  function exportGouvernancePdf() {
    window.open('/api/v1/governance/rapport.pdf', '_blank');
  }

})();
