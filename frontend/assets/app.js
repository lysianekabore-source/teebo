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
    hr_logistics_manager: 'RH & Logistique', office_staff: 'Support administratif', collectrice: 'Collecte' };

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
    session_expired: 'Session expirée.', invalid_session: 'Session invalide.', not_authenticated: 'Non connecté.',
    invalid_position: 'Poste invalide.', supervisor_required: 'Un superviseur est requis pour ce poste.',
    invalid_supervisor: 'Le superviseur choisi doit être un Chef d’agence ou un Agent de crédit.',
    bad_supervisor: 'Superviseur invalide.' };
  function fr(e) { return MSG[e] || 'Une erreur est survenue.'; }

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
    b.addEventListener('click', function () { switchView(b.dataset.view); });
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
    box.innerHTML = '<table class="tbl"><thead><tr><th>Nom</th><th>Code d’accès</th><th>Rôle</th><th>Unité</th><th>Contact</th><th>Mot de passe</th><th>Actions</th></tr></thead><tbody>' +
      users.map(function (u) {
        return '<tr><td><b>' + esc(u.full_name) + '</b>' + (u.position ? '<br><small style="color:var(--muted)">' + esc(u.position) + '</small>' : '') + '</td>' +
          '<td><code>' + esc(u.code_user) + '</code></td><td>' + esc(ROLE_LABEL[u.role] || u.role) + '</td>' +
          '<td>' + esc(u.unit_name || '—') + '</td><td>' + esc(u.email) + (u.phone ? '<br><small style="color:var(--muted)">' + esc(u.phone) + '</small>' : '') + '</td>' +
          '<td>' + (u.must_change_password ? '<span class="tag tag--warn">À créer</span>' : '<span class="tag tag--ok">Actif</span>') + '</td>' +
          '<td><button class="btn btn--ghost btn--sm" data-resend="' + u.id + '">Renvoyer le code</button></td></tr>';
      }).join('') + '</tbody></table>';
    box.querySelectorAll('button[data-resend]').forEach(function (b) {
      b.addEventListener('click', function () { var u = users.find(function (x) { return x.id === b.dataset.resend; }); if (u) resendCode(u); });
    });
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
  // Superviseurs éligibles pour un agent de collecte : Chef d'agence OU Agent de crédit.
  function eligibleSupervisors() {
    return users.filter(function (u) {
      var p = posByCode[u.position_code];
      return p && p.supervisesCollectors;
    });
  }
  function userModal() {
    loadPositions().then(function () {
      openModal(
      '<h3>Nouvel utilisateur</h3><p class="sub">Le code d’accès sera envoyé par e-mail et WhatsApp.</p>' +
      '<div class="fld"><label for="u-name">Nom complet</label><input id="u-name"></div>' +
      '<div class="fld"><label for="u-pos">Poste occupé</label><select id="u-pos"><option value="">— Choisir un poste —</option>' +
        positionOptionsHtml() + '</select>' +
        '<small id="u-pos-hint" style="color:var(--muted)">Le poste détermine automatiquement le rôle et les permissions.</small></div>' +
      '<div class="fld" id="u-sup-wrap" hidden><label for="u-sup">Superviseur (Chef d’agence ou Agent de crédit)</label>' +
        '<select id="u-sup"></select></div>' +
      '<div class="fld"><label for="u-unit">Unité de rattachement</label><select id="u-unit"><option value="">— Aucune —</option>' +
        units.map(function (u) { return '<option value="' + u.id + '">' + esc(KIND_META[u.kind].label + ' · ' + u.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="form-grid"><div class="fld"><label for="u-email">E-mail</label><input id="u-email" type="email"></div>' +
      '<div class="fld"><label for="u-phone">Téléphone (WhatsApp)</label><input id="u-phone" type="tel" placeholder="+226 00 00 00 00"></div></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="u-cancel">Annuler</button><button class="btn btn--primary" id="u-ok">Créer et envoyer le code</button></div>'
      );
      // Affiche le champ Superviseur uniquement pour un poste qui l'exige (collecte).
      function syncSupervisor() {
        var p = posByCode[$('u-pos').value];
        var wrap = $('u-sup-wrap'), sel = $('u-sup');
        if (p && p.needsSupervisor) {
          var sup = eligibleSupervisors();
          sel.innerHTML = sup.length
            ? sup.map(function (u) { return '<option value="' + u.id + '">' + esc(u.full_name + ' — ' + (posByCode[u.position_code] ? posByCode[u.position_code].label : u.role)) + '</option>'; }).join('')
            : '<option value="">Aucun superviseur disponible — créez d’abord un Chef d’agence ou un Agent de crédit</option>';
          wrap.hidden = false;
        } else { wrap.hidden = true; sel.innerHTML = ''; }
      }
      $('u-pos').addEventListener('change', syncSupervisor);
      $('u-cancel').addEventListener('click', closeModal);
      $('u-ok').addEventListener('click', function () {
        var pos = posByCode[$('u-pos').value];
        var body = { full_name: $('u-name').value.trim(), position_code: $('u-pos').value || null,
          org_unit_id: $('u-unit').value || null, email: $('u-email').value.trim(), phone: $('u-phone').value.trim() };
        if (pos && pos.needsSupervisor) body.supervisor_id = $('u-sup').value || null;
        if (!body.full_name || !body.email || !body.position_code) { notify('Nom, e-mail et poste sont requis.', 'err'); return; }
        if (pos && pos.needsSupervisor && !body.supervisor_id) { notify('Un agent de collecte doit être rattaché à un superviseur (Chef d’agence ou Agent de crédit).', 'err'); return; }
        var self = this; self.disabled = true;
        api('/api/v1/users', 'POST', body).then(function (d) { closeModal(); return loadUsers().then(function () { notify('Utilisateur créé — code ' + d.code_user + '.', 'ok'); showSendCodeModal(d, body.full_name); }); })
          .catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
      });
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
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
      set('s-notify_whatsapp', s.notify_whatsapp); set('s-notify_email', s.notify_email);
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
    var body = {
      legal_name: $('s-legal_name').value.trim(), legal_form: $('s-legal_form').value,
      trade_register_no: $('s-trade_register_no').value.trim(), tax_id: $('s-tax_id').value.trim(),
      vat_number: $('s-vat_number').value.trim(), bceao_agreement_no: $('s-bceao_agreement_no').value.trim(),
      legal_address: $('s-legal_address').value.trim(), bank_details: $('s-bank_details').value.trim(),
      footer_note: $('s-footer_note').value.trim(),
      notify_whatsapp: $('s-notify_whatsapp').value.trim(),
      notify_email: $('s-notify_email').value.trim(),
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
  function showSendCodeModal(d, name) {
    var s = d.send || {};
    var who = name ? esc(name) : 'l’utilisateur';
    var waBtn = s.wa_link
      ? '<a class="btn btn--primary" href="' + esc(s.wa_link) + '" target="_blank" rel="noopener">Envoyer par WhatsApp</a>'
      : '<span class="hint">Aucun numéro WhatsApp renseigné pour cet utilisateur.</span>';
    var mailBtn = s.mailto_link
      ? '<a class="btn btn--dark" href="' + esc(s.mailto_link) + '">Envoyer par e-mail</a>'
      : '';
    var channels = [];
    if (s.sender_whatsapp) channels.push('WhatsApp : ' + esc(s.sender_whatsapp));
    if (s.sender_email) channels.push('e-mail : ' + esc(s.sender_email));
    openModal(
      '<h3>Code d’accès prêt à envoyer</h3>' +
      '<p class="sub">Transmettez ce code à ' + who + '. Il devra créer son mot de passe à la première connexion.</p>' +
      '<div class="fld" style="text-align:center"><label>Code d’accès</label>' +
        '<div style="font-size:26px;font-weight:800;letter-spacing:3px"><code>' + esc(d.code_user || '') + '</code></div></div>' +
      (channels.length ? '<p class="hint">Expéditeur : ' + channels.join(' · ') + '.</p>' : '') +
      '<p class="hint">Cliquez sur un bouton pour ouvrir le message pré-rempli (WhatsApp ou votre messagerie), puis envoyez-le.</p>' +
      '<div class="modal__nav" style="flex-wrap:wrap;gap:10px">' + waBtn + mailBtn +
        '<button class="btn btn--ghost" id="sc-close">Fermer</button></div>'
    );
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
      failed: ['Échec', 'tag--err'], skipped: ['Non tenté', 'tag--muted'] };
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
  api('/api/v1/auth/me').then(function (d) {
    me = d;
    if (d.password_change_required) { window.location.assign('/login.html'); return; }
    $('u-name').textContent = d.user.full_name;
    $('u-code').textContent = d.user.code_user + ' · ' + (d.imf_code || '');
    // Paramètres IMF : accessible à l'admin et à la direction.
    var canSee = ['admin_imf', 'direction'].indexOf(d.user.role) >= 0;
    var navS = $('nav-settings'); if (navS) navS.hidden = !canSee;
    var navD = $('nav-dispatches'); if (navD) navD.hidden = !canSee;
    var navP = $('nav-profiles'); if (navP) navP.hidden = !canSee;
    // Validation finale des crédits : réservée aux postes habilités.
    var canFinal = !!d.can_validate_credit_final || canSee;
    var navC = $('nav-credits'); if (navC) navC.hidden = !canFinal;
    // VAGUE 15 : menus opérationnels, affichés selon les habilitations du poste.
    setupBankingNav();
    initSettingsHandlers();
    var bnP = $('btn-new-perm'); if (bnP) bnP.addEventListener('click', openNewPermModal);
    var bnPos = $('btn-new-position'); if (bnPos) bnPos.addEventListener('click', openNewPositionModal);
    var bnCr = $('btn-credits-refresh'); if (bnCr) bnCr.addEventListener('click', loadCreditsQueue);
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

  /* ===== VAGUE 15 : modules opérationnels (clients, caisse, coffre, compta, recouvrement, audit) ===== */
  function has(p) {
    if (!me) return false;
    if (['admin_imf', 'direction'].indexOf(me.user.role) >= 0) return true;
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
    var head = '<tr><th>Code</th><th>Nom complet</th><th>T\u00e9l\u00e9phone</th><th>Pi\u00e8ce</th><th>Solde</th><th style="text-align:right">Action</th></tr>';
    var body = list.map(function (c) {
      return '<tr><td><b>' + esc(c.code_client || '\u2014') + '</b></td>' +
        '<td>' + esc(c.full_name || '\u2014') + '</td>' +
        '<td>' + esc(c.phone || '\u2014') + '</td>' +
        '<td>' + esc(c.id_number || '\u2014') + '</td>' +
        '<td>' + (c.balance_cents != null ? money(c.balance_cents) : '\u2014') + '</td>' +
        '<td style="text-align:right"><button class="btn btn--sm" data-cl-edit="' + esc(c.id) + '">Modifier la fiche</button></td></tr>';
    }).join('');
    $('clients-table').innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
    $('clients-table').querySelectorAll('[data-cl-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openClientEdit(list.find(function (x) { return x.id === b.dataset.clEdit; })); });
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
        return '<tr><td>' + esc(c.closing_date ? String(c.closing_date).slice(0, 10) : '\u2014') + '</td><td>' + money(c.theoretical_cents) + '</td><td>' + money(c.counted_cents) + '</td><td style="color:' + (g === 0 ? 'inherit' : (g > 0 ? '#1a7f37' : '#c0392b')) + '">' + (g > 0 ? '+' : '') + money(g) + '</td><td><span class="tag">' + (c.status === 'equilibre' ? '\u00c9quilibr\u00e9' : '\u00c9cart') + '</span></td><td>' + esc(c.user_name || '\u2014') + '</td></tr>';
      }).join('');
      $('closing-table').innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Date</th><th>Th\u00e9orique</th><th>Compt\u00e9</th><th>\u00c9cart</th><th>Statut</th><th>Agent</th></tr></thead><tbody>' + body + '</tbody></table></div>';
    }).catch(function (e) { if (guard(e)) return; if (e.message === 'forbidden' || e.message === 'missing_permission') forbidden('closing-table', 'Acc\u00e8s non habilit\u00e9.'); else notify(fr(e), 'err'); });
  }
  function openClosingModal() {
    openModal('<h3>Arr\u00eat\u00e9 de caisse</h3><div class="fld"><label for="cc-date">Date</label><input id="cc-date" type="date"></div><div class="fld"><label for="cc-th">Solde th\u00e9orique (FCFA)</label><input id="cc-th" inputmode="numeric"></div><div class="fld"><label for="cc-ct">Esp\u00e8ces compt\u00e9es (FCFA)</label><input id="cc-ct" inputmode="numeric"></div><div class="fld"><label for="cc-note">Note</label><textarea id="cc-note" rows="2"></textarea></div><div class="modal__nav"><button class="btn btn--ghost" id="cc-cancel" type="button">Annuler</button><button class="btn btn--primary" id="cc-save" type="button">Enregistrer</button></div>');
    $('cc-cancel').addEventListener('click', closeModal);
    $('cc-save').addEventListener('click', function () {
      $('cc-save').disabled = true;
      api('/api/v1/cash/closings', 'POST', { closing_date: $('cc-date').value || undefined, theoretical_cents: cents($('cc-th').value), counted_cents: cents($('cc-ct').value), note: $('cc-note').value.trim() || undefined })
        .then(function (r) { closeModal(); notify(r.note || 'Arr\u00eat\u00e9 enregistr\u00e9.', 'ok'); loadClosings(); })
        .catch(function (e) { $('cc-save').disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
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
