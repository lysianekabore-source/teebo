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
  var VIEWS = ['dash', 'org', 'users', 'settings', 'security'];
  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () { switchView(b.dataset.view); });
  });
  function switchView(v) {
    VIEWS.forEach(function (x) { var n = $('view-' + x); if (n) n.hidden = x !== v; });
    document.querySelectorAll('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.view === v); });
    if (v === 'org') loadUnits();
    if (v === 'users') loadUsers();
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
    var canManage = ['admin_imf', 'direction'].indexOf(me.user.role) >= 0;
    box.innerHTML = '<table class="tbl"><thead><tr><th>Nom</th><th>Code d’accès</th><th>Rôle</th><th>Unité</th><th>Contact</th><th>Mot de passe</th>' + (canManage ? '<th>Code d’accès</th>' : '') + '</tr></thead><tbody>' +
      users.map(function (u) {
        var acts = '';
        if (canManage && u.role !== 'admin_imf') {
          acts = '<td style="white-space:nowrap">' +
            '<button class="btn btn--ghost btn--sm" data-uresend="' + esc(u.id) + '">Renvoyer</button> ' +
            '<button class="btn btn--ghost btn--sm" data-uregen="' + esc(u.id) + '">Régénérer</button></td>';
        } else if (canManage) { acts = '<td><small style="color:var(--muted)">—</small></td>'; }
        return '<tr><td><b>' + esc(u.full_name) + '</b>' + (u.position ? '<br><small style="color:var(--muted)">' + esc(u.position) + '</small>' : '') + '</td>' +
          '<td><code>' + esc(u.code_user) + '</code></td><td>' + esc(ROLE_LABEL[u.role] || u.role) + '</td>' +
          '<td>' + esc(u.unit_name || '—') + '</td><td>' + esc(u.email) + (u.phone ? '<br><small style="color:var(--muted)">' + esc(u.phone) + '</small>' : '') + '</td>' +
          '<td>' + (u.must_change_password ? '<span class="tag tag--warn">À créer</span>' : '<span class="tag tag--ok">Actif</span>') + '</td>' + acts + '</tr>';
      }).join('') + '</tbody></table>';
    if (canManage) {
      box.querySelectorAll('[data-uresend]').forEach(function (b) { b.addEventListener('click', function () { userResend(b.dataset.uresend); }); });
      box.querySelectorAll('[data-uregen]').forEach(function (b) { b.addEventListener('click', function () { userRegen(b.dataset.uregen); }); });
    }
  }

  // ----- Renvoi / régénération du code d'accès d'un utilisateur de l'IMF -----
  function userResend(id) {
    api('/api/v1/users/' + id + '/resend-code', 'POST')
      .then(function (d) { notify('Code d’accès renvoyé : ' + d.code_user + ' → ' + d.sent_to, 'ok'); })
      .catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }
  function userRegen(id) {
    openModal('<h3>Régénérer le code d’accès</h3><p class="sub">Un NOUVEAU code sera généré et l’ancien mot de passe effacé : l’utilisateur devra créer son mot de passe après sa 1re connexion. Le code est envoyé par WhatsApp et e-mail.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="ug-cancel">Annuler</button><button class="btn btn--primary" id="ug-ok">Régénérer et envoyer</button></div>');
    $('ug-cancel').addEventListener('click', closeModal);
    $('ug-ok').addEventListener('click', function () {
      var self = this; self.disabled = true;
      api('/api/v1/users/' + id + '/regenerate-code', 'POST').then(function (d) {
        closeModal(); notify('Nouveau code généré : ' + d.code_user + ' → ' + d.sent_to, 'ok'); return loadUsers();
      }).catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
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
  $('btn-new-unit').addEventListener('click', function () {
    if (!units.length) unitModal(null); else unitModal(units.filter(function (u) { return u.kind === 'direction'; })[0] || null);
    if (units.length && !units.filter(function (u) { return u.kind === 'direction'; }).length) unitModal(null);
  });
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
      // Coordonnées d'envoi des codes/notifications aux utilisateurs de l'IMF.
      set('s-notif_whatsapp', d.notif_whatsapp); set('s-notif_email', d.notif_email);
      $('s-share_capital').value = s.share_capital_cents != null ? fmtAmount(s.share_capital_cents / 100) : '';
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
       's-share_capital','s-legal_address','s-bank_details','s-footer_note','s-vat',
       's-notif_whatsapp','s-notif_email',
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
    var body = {
      legal_name: $('s-legal_name').value.trim(), legal_form: $('s-legal_form').value,
      trade_register_no: $('s-trade_register_no').value.trim(), tax_id: $('s-tax_id').value.trim(),
      vat_number: $('s-vat_number').value.trim(), bceao_agreement_no: $('s-bceao_agreement_no').value.trim(),
      legal_address: $('s-legal_address').value.trim(), bank_details: $('s-bank_details').value.trim(),
      footer_note: $('s-footer_note').value.trim(),
      notif_whatsapp: $('s-notif_whatsapp') ? $('s-notif_whatsapp').value.trim() : undefined,
      notif_email: $('s-notif_email') ? $('s-notif_email').value.trim() : undefined,
      share_capital_cents: capRaw ? Number(capRaw) * 100 : null,
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

  // ----- Démarrage -----
  api('/api/v1/auth/me').then(function (d) {
    me = d;
    if (d.password_change_required) { window.location.assign('/login.html'); return; }
    $('u-name').textContent = d.user.full_name;
    $('u-code').textContent = d.user.code_user + ' · ' + (d.imf_code || '');
    // Paramètres IMF : accessible à l'admin et à la direction.
    var canSee = ['admin_imf', 'direction'].indexOf(d.user.role) >= 0;
    var navS = $('nav-settings'); if (navS) navS.hidden = !canSee;
    initSettingsHandlers();
    return Promise.all([loadUnits(), loadUsers(), loadTrial()]);
  }).then(function () {
    renderDash(); renderSession();
    // 2FA obligatoire : si l'enrôlement est signalé comme requis, on ouvre
    // directement « Mon accès » et on invite l'utilisateur à l'activer.
    var pending = false;
    try { pending = sessionStorage.getItem('teebo_2fa_enroll') === '1'; } catch (e) {}
    if (pending) { try { sessionStorage.removeItem('teebo_2fa_enroll'); } catch (e) {}
      switchView('security');
      notify('Activation de la double authentification requise pour continuer.', 'info');
      return;
    }
    switchView('dash');
  })
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
