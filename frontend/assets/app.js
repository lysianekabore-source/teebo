/* teebo — espace IMF : tableau de bord, hiérarchie, personnel, sécurité. */
(function () {
  'use strict';
  var me = null, units = [], users = [], unitToDelete = null;
  var KIND_META = {
    direction: { label: 'Direction', short: 'DIR' },
    department: { label: 'Département', short: 'DEP' },
    service: { label: 'Service', short: 'SRV' },
    agency: { label: 'Agence', short: 'AGC' }
  };
  var KIND_ORDER = { direction: 1, department: 2, service: 3, agency: 4 };
  var ROLE_LABEL = { admin_imf: 'Administrateur IMF', direction: 'Direction', department: 'Département',
    service: 'Service', agency: 'Agence', staff: 'Personnel' };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'error'); return d; }); });
  }
  function notify(msg, type) {
    var a = $('global-alert'); a.textContent = msg; a.className = 'alert alert--' + (type || 'info'); a.hidden = false;
    clearTimeout(notify._t); notify._t = setTimeout(function () { a.hidden = true; }, 5000);
  }
  var MSG = { forbidden: 'Action non autorisée.', bad_hierarchy: 'Ordre hiérarchique invalide (direction → département → service → agence).',
    bad_parent: 'Unité parente invalide.', bad_unit: 'Unité invalide.', missing_fields: 'Champs obligatoires manquants.',
    weak_password: 'Mot de passe trop faible (10 car., majuscule, minuscule, chiffre).', invalid_current_password: 'Mot de passe actuel incorrect.',
    password_change_required: 'Votre mot de passe doit être changé.', idle_timeout: 'Session expirée (30 min d’inactivité).',
    session_expired: 'Session expirée.', invalid_session: 'Session invalide.', not_authenticated: 'Non connecté.' };
  function fr(e) { return MSG[e] || 'Une erreur est survenue.'; }

  function guard(err) {
    if (['idle_timeout','session_expired','invalid_session','not_authenticated','session_revoked'].indexOf(err.message) >= 0) {
      window.location.assign('/login.html');
      return true;
    }
    return false;
  }

  // ----- Navigation -----
  var VIEWS = ['dash', 'org', 'users', 'security'];
  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () { switchView(b.dataset.view); });
  });
  function switchView(v) {
    VIEWS.forEach(function (x) { $('view-' + x).hidden = x !== v; });
    document.querySelectorAll('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.view === v); });
    if (v === 'org') loadUnits();
    if (v === 'users') loadUsers();
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
  function renderDash() {
    $('dash-chips').innerHTML =
      '<span class="chip">IMF <b>' + esc(me.imf_code || '—') + '</b></span>' +
      '<span class="chip ' + (me.trial_active ? 'chip--warn' : 'chip--ok') + '">' +
        (me.trial_active ? 'Essai gratuit — <b>' + esc(me.trial_days_left) + ' j restants</b>' : 'Accès actif') + '</span>' +
      '<span class="chip">Rôle <b>' + esc(ROLE_LABEL[me.user.role] || me.user.role) + '</b></span>';
    var tiers = { direction: 0, department: 0, service: 0, agency: 0 };
    units.forEach(function (u) { tiers[u.kind] = (tiers[u.kind] || 0) + 1; });
    $('dash-kpis').innerHTML =
      kpi(units.length, 'Unités organisationnelles', true) +
      kpi(units.filter(function (u) { return u.kind === 'agency'; }).length, 'Agences') +
      kpi(users.length, 'Utilisateurs') +
      kpi(users.filter(function (u) { return u.must_change_password; }).length, 'Mot de passe à créer');
    var mini = units.slice().sort(function (a, b) { return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]; }).slice(0, 6);
    $('dash-units-mini').innerHTML = mini.length
      ? '<table class="tbl"><tbody>' + mini.map(function (u) {
          return '<tr><td><b>' + esc(u.name) + '</b><br><small style="color:var(--muted)">' + esc(KIND_META[u.kind].label) + '</small></td><td style="text-align:right"><code>' + esc(u.code_unit) + '</code></td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">Aucune unité créée pour le moment. Rendez-vous dans « Organisation ».</div>';
  }
  function kpi(v, l, dark) { return '<div class="kpi' + (dark ? ' kpi--dark' : '') + '"><b>' + v + '</b><span>' + l + '</span></div>'; }

  // ----- Organisation (arbre) -----
  function loadUnits() {
    return api('/api/v1/units').then(function (d) {
      units = d.units || [];
      renderTree(); renderDash();
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }
  function renderTree() {
    var root = $('org-tree');
    if (!units.length) { root.innerHTML = '<div class="empty">Aucune unité. Créez d’abord la direction, puis les départements, services et agences.</div>'; return; }
    var byParent = {};
    units.forEach(function (u) { var k = u.parent_id || 'root'; (byParent[k] = byParent[k] || []).push(u); });
    function branch(parentKey) {
      var list = (byParent[parentKey] || []).sort(function (a, b) { return a.name.localeCompare(b.name); });
      return list.map(function (u) {
        var kids = branch(u.id);
        return '<div class="node"><div class="node__head">' +
          '<div class="node__title"><span class="node__kind">' + KIND_META[u.kind].short + '</span>' +
          '<div><b>' + esc(u.name) + '</b><small>' + esc(KIND_META[u.kind].label) + (u.city ? ' · ' + esc(u.city) : '') + ' · ' + esc(u.code_unit) + '</small></div></div>' +
          '<div style="display:flex;gap:8px">' +
            (u.kind !== 'agency' ? '<button class="btn btn--ghost btn--sm" data-add="' + u.id + '">+ Sous-unité</button>' : '') +
            '<button class="btn btn--ghost btn--sm" data-del="' + u.id + '">Supprimer</button>' +
          '</div></div>' + (kids.length ? '<div class="children">' + kids.join('') + '</div>' : '') + '</div>';
      }).join('');
    }
    root.innerHTML = branch('root');
    root.querySelectorAll('[data-add]').forEach(function (b) {
      b.addEventListener('click', function () { unitModal(units.find(function (u) { return u.id === b.dataset.add; })); });
    });
    root.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { var u = units.find(function (x) { return x.id === b.dataset.del; }); if (u) askDeleteUnit(u); });
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
  function loadUsers() {
    return api('/api/v1/users').then(function (d) { users = d.users || []; renderUsers(); renderDash(); })
      .catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }
  function renderUsers() {
    var box = $('users-table');
    if (!users.length) { box.innerHTML = '<div class="empty">Aucun utilisateur. Créez le premier accès.</div>'; return; }
    box.innerHTML = '<table class="tbl"><thead><tr><th>Nom</th><th>Code d’accès</th><th>Rôle</th><th>Unité</th><th>Contact</th><th>Mot de passe</th></tr></thead><tbody>' +
      users.map(function (u) {
        return '<tr><td><b>' + esc(u.full_name) + '</b>' + (u.position ? '<br><small style="color:var(--muted)">' + esc(u.position) + '</small>' : '') + '</td>' +
          '<td><code>' + esc(u.code_user) + '</code></td><td>' + esc(ROLE_LABEL[u.role] || u.role) + '</td>' +
          '<td>' + esc(u.unit_name || '—') + '</td><td>' + esc(u.email) + (u.phone ? '<br><small style="color:var(--muted)">' + esc(u.phone) + '</small>' : '') + '</td>' +
          '<td>' + (u.must_change_password ? '<span class="tag tag--warn">À créer</span>' : '<span class="tag tag--ok">Actif</span>') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function userModal() {
    var roleOpts = ['direction','department','service','agency','staff'];
    openModal(
      '<h3>Nouvel utilisateur</h3><p class="sub">Le code d’accès sera envoyé par e-mail et WhatsApp.</p>' +
      '<div class="fld"><label for="u-name">Nom complet</label><input id="u-name"></div>' +
      '<div class="form-grid"><div class="fld"><label for="u-pos">Poste</label><input id="u-pos"></div>' +
      '<div class="fld"><label for="u-role">Rôle</label><select id="u-role">' + roleOpts.map(function (r) { return '<option value="' + r + '">' + ROLE_LABEL[r] + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="fld"><label for="u-unit">Unité de rattachement</label><select id="u-unit"><option value="">— Aucune —</option>' +
        units.map(function (u) { return '<option value="' + u.id + '">' + esc(KIND_META[u.kind].label + ' · ' + u.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="form-grid"><div class="fld"><label for="u-email">E-mail</label><input id="u-email" type="email"></div>' +
      '<div class="fld"><label for="u-phone">Téléphone (WhatsApp)</label><input id="u-phone" type="tel" placeholder="+226 00 00 00 00"></div></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="u-cancel">Annuler</button><button class="btn btn--primary" id="u-ok">Créer et envoyer le code</button></div>'
    );
    $('u-cancel').addEventListener('click', closeModal);
    $('u-ok').addEventListener('click', function () {
      var body = { full_name: $('u-name').value.trim(), position: $('u-pos').value.trim(), role: $('u-role').value,
        org_unit_id: $('u-unit').value || null, email: $('u-email').value.trim(), phone: $('u-phone').value.trim() };
      if (!body.full_name || !body.email || !body.role) { notify('Nom, e-mail et rôle sont requis.', 'err'); return; }
      var self = this; self.disabled = true;
      api('/api/v1/users', 'POST', body).then(function (d) { closeModal(); notify('Utilisateur créé — code ' + d.code_user + ' envoyé par e-mail et WhatsApp.', 'ok'); return loadUsers(); })
        .catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  // ----- Sécurité -----
  function renderSession() {
    var rows = [['Nom', me.user.full_name], ['Identifiant', me.user.code_user], ['E-mail', me.user.email],
      ['Rôle', ROLE_LABEL[me.user.role] || me.user.role], ['Mot de passe défini le', me.password_set_at ? new Date(me.password_set_at).toLocaleString('fr-FR') : '—'],
      ['Expiration du mot de passe', me.password_expires_at ? new Date(me.password_expires_at).toLocaleString('fr-FR') : '—'],
      ['Déconnexion auto', 'après 30 minutes d’inactivité']];
    $('session-info').innerHTML = rows.map(function (r) { return '<div><dt style="font-size:12px;color:var(--muted)">' + r[0] + '</dt><dd style="font-weight:600">' + esc(r[1]) + '</dd></div>'; }).join('');
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
  $('btn-new-unit').addEventListener('click', function () {
    if (!units.length) unitModal(null); else unitModal(units.filter(function (u) { return u.kind === 'direction'; })[0] || null);
    if (units.length && !units.filter(function (u) { return u.kind === 'direction'; }).length) unitModal(null);
  });
  $('btn-new-user').addEventListener('click', function () { if (!units.length) { notify('Créez d’abord votre organisation.', 'err'); return; } userModal(); });

  // ----- Démarrage -----
  api('/api/v1/auth/me').then(function (d) {
    me = d;
    if (d.password_change_required) { window.location.assign('/login.html'); return; }
    $('u-name').textContent = d.user.full_name;
    $('u-code').textContent = d.user.code_user + ' · ' + (d.imf_code || '');
    return Promise.all([loadUnits(), loadUsers(), loadTrial()]);
  }).then(function () { renderDash(); renderSession(); switchView('dash'); })
    .catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });

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
})();
