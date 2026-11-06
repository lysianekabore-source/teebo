/* teebo — console d’administration (éditeur) : approbations, institutions,
   administrateurs IMF, profil éditeur + 2FA. */
(function () {
  'use strict';
  var me = null;
  var VIEWS = ['dashboard', 'requests', 'imfs', 'admins', 'profile'];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(c) { return (Number(c || 0) / 100).toLocaleString('fr-FR') + ' FCFA'; }
  function dfr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : '—'; }
  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'error'); return d; }); });
  }
  function notify(m, t) { var a = $('global-alert'); a.textContent = m; a.className = 'alert alert--' + (t || 'info'); a.hidden = false;
    clearTimeout(notify._t); notify._t = setTimeout(function () { a.hidden = true; }, 12000); }
  var MSG = { proforma_not_validated: 'La facture proforma n’a pas été validée par le prospect.', not_found: 'Élément introuvable.',
    no_admin: 'Aucun administrateur IMF pour cette institution.', no_code: 'Aucun code d’accès à renvoyer.',
    invalid_status: 'Statut invalide.', forbidden: 'Réservé aux administrateurs teebo.', idle_timeout: 'Session expirée (30 min d’inactivité).',
    session_expired: 'Session expirée.', not_authenticated: 'Non connecté.', invalid_session: 'Session invalide.' };
  function fr(e) { return MSG[e] || 'Une erreur est survenue.'; }
  function guard(e) { if (['idle_timeout','session_expired','invalid_session','not_authenticated','session_revoked'].indexOf(e.message) >= 0) { window.location.assign('/login.html'); return true; } return false; }

  // ----- Navigation -----
  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.dataset.view;
      VIEWS.forEach(function (x) { var el = $('view-' + x); if (el) el.hidden = x !== v; });
      document.querySelectorAll('.nav-item').forEach(function (x) { x.classList.toggle('active', x === b); });
      if (v === 'imfs') loadImfs();
      if (v === 'admins') loadAdmins();
      if (v === 'profile') loadProfile();
      if (v === 'requests') loadRequests();
      if (v === 'dashboard') { loadStats(); loadSubscriptions(); }
    });
  });

  function openModal(h) { $('modal-root').innerHTML = '<div class="modal-wrap"><div class="modal">' + h + '</div></div>';
    var w = $('modal-root').querySelector('.modal-wrap'); w.addEventListener('click', function (e) { if (e.target === w) close(); }); }
  function close() { $('modal-root').innerHTML = ''; }
  function copyCode(code) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(code); notify('Code copié : ' + code, 'ok'); return; }
    } catch (e) {}
    var ta = document.createElement('textarea'); ta.value = code; document.body.appendChild(ta);
    ta.select(); try { document.execCommand('copy'); notify('Code copié : ' + code, 'ok'); } catch (e2) { notify('Code : ' + code, 'info'); }
    document.body.removeChild(ta);
  }
  function codeCell(code, mustChange) {
    if (!code) return '<span class="tag tag--muted">—</span>';
    var state = mustChange ? ' <span class="tag tag--warn">À activer</span>' : ' <span class="tag tag--ok">Activé</span>';
    return '<code>' + esc(code) + '</code>' + state +
      ' <button class="btn btn--ghost btn--sm" data-copy="' + esc(code) + '">Copier</button>';
  }

  // ----- Tableau de bord (statistiques plateforme) -----
  function loadStats() {
    return api('/api/v1/teebo/stats').then(function (d) {
      var s = d.stats || {};
      var cards = [
        { k: 'Institutions (IMF)', v: s.imfs, cls: '' },
        { k: 'Essais en cours', v: s.trials, cls: 'warn' },
        { k: 'Abonnements actifs', v: s.actives, cls: 'ok' },
        { k: 'Suspendues', v: s.suspended, cls: 'danger' },
        { k: 'Demandes à traiter', v: s.pending, cls: 'warn' },
        { k: 'Utilisateurs', v: s.users, cls: '' }
      ];
      var color = { '': 'var(--navy)', ok: '#1f9d55', warn: '#8a6d00', danger: '#c0392b' };
      $('stats-cards').innerHTML = cards.map(function (c) {
        return '<div style="background:#fff;border:1px solid var(--line,#e3e5ee);border-radius:14px;padding:20px 22px;box-shadow:0 6px 20px rgba(11,12,38,.05)">' +
          '<div style="font-size:34px;font-weight:800;line-height:1;color:' + (color[c.cls] || color['']) + '">' + esc(String(c.v == null ? 0 : c.v)) + '</div>' +
          '<div style="margin-top:8px;font-size:13px;color:var(--muted,#61647c)">' + esc(c.k) + '</div></div>';
      }).join('');
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  // ----- Échéances d'abonnement (annuel / mensuel) -----
  function loadSubscriptions() {
    return api('/api/v1/teebo/subscriptions').then(function (d) {
      var subs = d.subscriptions || [], r = d.recap || {};
      $('subs-chips').innerHTML =
        '<span class="chip">Annuels <b>' + (r.annuel || 0) + '</b></span>' +
        '<span class="chip">Mensuels <b>' + (r.mensuel || 0) + '</b></span>' +
        '<span class="chip chip--warn">Échéance ≤ 30 j <b>' + (r.due_30d || 0) + '</b></span>' +
        '<span class="chip chip--danger">En retard <b>' + (r.overdue || 0) + '</b></span>' +
        '<span class="chip">MRR <b>' + money(r.mrr_cents) + '</b></span>';
      if (!subs.length) { $('subs-table').innerHTML = '<div class="empty">Aucun abonnement.</div>'; return; }
      $('subs-table').innerHTML = '<table class="tbl"><thead><tr><th>Institution</th><th>Cycle</th><th>Montant</th><th>Statut</th><th>Prochaine échéance</th><th>Délai</th></tr></thead><tbody>' +
        subs.map(function (s) {
          var cyc = s.billing_cycle === 'annuel' ? '<span class="tag tag--ok">Annuel</span>' : '<span class="tag tag--muted">Mensuel</span>';
          var delai = s.days_left == null ? '—'
            : (s.overdue ? '<span class="tag tag--danger">En retard de ' + Math.abs(s.days_left) + ' j</span>'
            : (s.days_left <= 30 ? '<span class="tag tag--warn">Dans ' + s.days_left + ' j</span>'
            : '<span class="tag tag--muted">Dans ' + s.days_left + ' j</span>'));
          return '<tr><td><b>' + esc(s.name) + '</b><br><code>' + esc(s.code_imf) + '</code></td>' +
            '<td>' + cyc + '</td>' +
            '<td>' + (s.subscription_cents != null ? money(s.subscription_cents) : '—') + '</td>' +
            '<td>' + esc(s.status) + '</td>' +
            '<td>' + dfr(s.next_due_at) + '</td>' +
            '<td>' + delai + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }
  function loadRequests() {
    return api('/api/v1/teebo/requests').then(function (d) {
      var rs = d.requests || [];
      var pending = rs.filter(function (r) { return r.proforma_validated && !r.decision; }).length;
      $('req-chips').innerHTML = '<span class="chip chip--warn">À traiter <b>' + pending + '</b></span><span class="chip">Total <b>' + rs.length + '</b></span>';
      if (!rs.length) { $('requests-table').innerHTML = '<div class="empty">Aucune demande pour le moment.</div>'; return; }
      $('requests-table').innerHTML = '<table class="tbl"><thead><tr><th>IMF</th><th>Type</th><th>Responsable</th><th>Formule / Proforma</th><th>Statut</th><th>Code d’accès admin</th><th></th></tr></thead><tbody>' +
        rs.map(function (r) {
          var status = !r.proforma_validated ? '<span class="tag tag--muted">Proforma en attente</span>'
            : (!r.decision ? '<span class="tag tag--warn">À approuver</span>'
            : (r.decision === 'approved' ? '<span class="tag tag--ok">Approuvée</span>' : '<span class="tag tag--danger">Rejetée</span>'));
          var canApprove = r.proforma_validated && !r.decision;
          // Factures téléchargeables par l'éditeur teebo : proforma (dès qu'elle
          // existe) et facture définitive (après approbation). Ouvertes dans un
          // nouvel onglet (HTML imprimable → « Enregistrer en PDF »).
          var docBtns = '';
          if (r.proforma_no) docBtns += '<a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="/api/v1/requests/' + esc(r.id) + '/proforma.pdf">Proforma</a> ';
          if (r.definitive_invoice_id) docBtns += '<a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="/api/v1/teebo/invoices/' + esc(r.definitive_invoice_id) + '.pdf">Facture</a> ';
          // Envoi des factures au prospect/IMF par e-mail et WhatsApp.
          if (r.proforma_no) docBtns += '<button class="btn btn--ghost btn--sm" data-send-proforma="' + r.id + '">Envoyer proforma</button> ';
          if (r.definitive_invoice_id) docBtns += '<button class="btn btn--ghost btn--sm" data-send-invoice="' + r.id + '">Envoyer facture</button> ';
          return '<tr><td><b>' + esc(r.imf_name) + '</b><br><code>' + esc(r.code_imf) + '</code> · ' + esc(r.country_code) + '</td>' +
            '<td>' + esc(r.type) + '</td>' +
            '<td>' + esc((r.requester_firstname || '') + ' ' + (r.requester_lastname || '')) + '<br><small style="color:var(--muted)">' + esc(r.requester_position || '') + '</small></td>' +
            '<td>' + esc(r.plan_code || '—') + (r.proforma_no ? '<br><small style="color:var(--muted)">' + esc(r.proforma_no) + ' · ' + money(r.proforma_amount_cents) + '</small>' : '') + '</td>' +
            '<td>' + status + '</td>' +
            '<td>' + codeCell(r.admin_code, r.admin_must_change) + '</td>' +
            '<td style="text-align:right;white-space:nowrap">' + docBtns + (canApprove ? '<button class="btn btn--primary btn--sm" data-approve="' + r.id + '">Approuver</button> <button class="btn btn--ghost btn--sm" data-reject="' + r.id + '">Rejeter</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
      $('requests-table').querySelectorAll('[data-approve]').forEach(function (b) { b.addEventListener('click', function () { approve(b.dataset.approve); }); });
      $('requests-table').querySelectorAll('[data-reject]').forEach(function (b) { b.addEventListener('click', function () { reject(b.dataset.reject); }); });
      $('requests-table').querySelectorAll('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { copyCode(b.dataset.copy); }); });
      $('requests-table').querySelectorAll('[data-send-proforma]').forEach(function (b) { b.addEventListener('click', function () { sendDoc(b.dataset.sendProforma, 'proforma'); }); });
      $('requests-table').querySelectorAll('[data-send-invoice]').forEach(function (b) { b.addEventListener('click', function () { sendDoc(b.dataset.sendInvoice, 'invoice'); }); });
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  function sendDoc(id, kind) {
    var path = kind === 'invoice' ? '/send-invoice' : '/send-proforma';
    var lbl = kind === 'invoice' ? 'Facture définitive' : 'Facture proforma';
    api('/api/v1/teebo/requests/' + id + path, 'POST')
      .then(function (d) { notify(lbl + ' envoyée' + (d.sent_to ? ' → ' + d.sent_to : '') + '.', 'ok'); })
      .catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  function approve(id) {
    openModal('<h3>Approuver la demande</h3><p class="sub">Un essai gratuit de 30 jours calendaires sera activé. Le code d’accès administrateur sera envoyé à l’IMF par WhatsApp et e-mail — et restera visible ici.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="a-cancel">Annuler</button><button class="btn btn--primary" id="a-ok">Approuver et activer l’essai</button></div>');
    $('a-cancel').addEventListener('click', close);
    $('a-ok').addEventListener('click', function () {
      var self = this; self.disabled = true;
      api('/api/v1/teebo/requests/' + id + '/approve', 'POST').then(function (d) {
        close();
        openModal('<h3>Demande approuvée ✅</h3><p class="sub">Essai gratuit de 30 jours activé. Communiquez ce code d’accès à l’IMF :</p>' +
          '<div style="font-size:22px;font-weight:700;letter-spacing:1px;margin:14px 0"><code>' + esc(d.code_user) + '</code></div>' +
          '<p class="sub">IMF <b>' + esc(d.imf_code) + '</b>. Le code a aussi été envoyé par WhatsApp et e-mail.</p>' +
          '<div class="modal__nav"><button class="btn btn--ghost" id="cp">Copier le code</button><button class="btn btn--primary" id="okm">Terminé</button></div>');
        $('cp').addEventListener('click', function () { copyCode(d.code_user); });
        $('okm').addEventListener('click', close);
        return loadRequests();
      }).catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  function reject(id) {
    openModal('<h3>Rejeter la demande</h3><p class="sub">L’IMF sera marquée comme rejetée. Cette action est journalisée.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="r-cancel">Annuler</button><button class="btn btn--primary" id="r-ok">Confirmer le rejet</button></div>');
    $('r-cancel').addEventListener('click', close);
    $('r-ok').addEventListener('click', function () {
      var self = this; self.disabled = true;
      api('/api/v1/teebo/requests/' + id + '/reject', 'POST').then(function () { close(); notify('Demande rejetée.', 'ok'); return loadRequests(); })
        .catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  // ----- Institutions -----
  var IMFS = [];
  function loadImfs() {
    return api('/api/v1/teebo/imfs').then(function (d) {
      IMFS = d.imfs || [];
      if (!IMFS.length) { $('imfs-table').innerHTML = '<div class="empty">Aucune institution.</div>'; return; }
      var LABEL = { pending: 'En attente', trial: 'Essai', active: 'Active', suspended: 'Suspendue', rejected: 'Rejetée', approved: 'Approuvée' };
      $('imfs-table').innerHTML = '<table class="tbl"><thead><tr><th>Institution</th><th>Code</th><th>Pays</th><th>Type</th><th>Statut</th><th>Fin d’essai</th><th>Code admin</th><th>Actions</th></tr></thead><tbody>' +
        IMFS.map(function (i) {
          var cls = i.status === 'active' ? 'tag--ok' : (i.status === 'rejected' ? 'tag--danger' : (i.status === 'trial' ? 'tag--warn' : 'tag--muted'));
          var acts = '';
          acts += '<button class="btn btn--ghost btn--sm" data-resend="' + i.id + '">Renvoyer le code</button> ';
          acts += '<button class="btn btn--ghost btn--sm" data-regen="' + i.id + '">Régénérer</button> ';
          acts += '<button class="btn btn--ghost btn--sm" data-detail="' + i.id + '">Détail</button> ';
          acts += '<button class="btn btn--ghost btn--sm" data-status="' + i.id + '">Statut</button>';
          return '<tr><td><b>' + esc(i.name) + '</b><br><small style="color:var(--muted)">' + esc(i.city) + '</small></td><td><code>' + esc(i.code_imf) + '</code></td>' +
            '<td>' + esc(i.country_code) + '</td><td>' + esc(i.type) + '</td>' +
            '<td><span class="tag ' + cls + '">' + esc(LABEL[i.status] || i.status) + '</span></td>' +
            '<td>' + dfr(i.trial_ends_at) + '</td>' +
            '<td>' + codeCell(i.admin_code, i.admin_must_change) + '</td>' +
            '<td style="white-space:nowrap">' + acts + '</td></tr>';
        }).join('') + '</tbody></table>';
      $('imfs-table').querySelectorAll('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { copyCode(b.dataset.copy); }); });
      $('imfs-table').querySelectorAll('[data-resend]').forEach(function (b) { b.addEventListener('click', function () { resend(b.dataset.resend); }); });
      $('imfs-table').querySelectorAll('[data-regen]').forEach(function (b) { b.addEventListener('click', function () { regen(b.dataset.regen); }); });
      $('imfs-table').querySelectorAll('[data-detail]').forEach(function (b) { b.addEventListener('click', function () { detail(b.dataset.detail); }); });
      $('imfs-table').querySelectorAll('[data-status]').forEach(function (b) { b.addEventListener('click', function () { changeStatus(b.dataset.status); }); });
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  function resend(id) {
    api('/api/v1/teebo/imfs/' + id + '/resend-code', 'POST')
      .then(function (d) { notify('Code d’accès renvoyé : ' + d.code_user + ' → ' + d.sent_to, 'ok'); })
      .catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }
  function regen(id) {
    openModal('<h3>Régénérer le code d’accès</h3><p class="sub">Un NOUVEAU code sera généré et l’ancien mot de passe sera effacé : l’IMF devra recréer son mot de passe au prochain accès. Le nouveau code est envoyé par WhatsApp et e-mail.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="g-cancel">Annuler</button><button class="btn btn--primary" id="g-ok">Régénérer et envoyer</button></div>');
    $('g-cancel').addEventListener('click', close);
    $('g-ok').addEventListener('click', function () {
      var self = this; self.disabled = true;
      api('/api/v1/teebo/imfs/' + id + '/regenerate-code', 'POST').then(function (d) {
        close();
        openModal('<h3>Nouveau code généré ✅</h3><p class="sub">Code d’accès de l’IMF <b>' + esc(d.code_user) + '</b> :</p>' +
          '<div style="font-size:22px;font-weight:700;letter-spacing:1px;margin:14px 0"><code>' + esc(d.code_user) + '</code></div>' +
          '<p class="sub">Envoyé à ' + esc(d.sent_to || 'l’IMF') + '.</p>' +
          '<div class="modal__nav"><button class="btn btn--ghost" id="cp">Copier</button><button class="btn btn--primary" id="okm">Terminé</button></div>');
        $('cp').addEventListener('click', function () { copyCode(d.code_user); });
        $('okm').addEventListener('click', function () { close(); loadImfs(); });
      }).catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  function detail(id) {
    api('/api/v1/teebo/imfs/' + id).then(function (d) {
      var i = d.imf, us = d.users || [];
      var rows = us.map(function (u) {
        return '<tr><td>' + esc(u.full_name || '—') + '<br><small style="color:var(--muted)">' + esc(u.email || '') + '</small></td>' +
          '<td><code>' + esc(u.code_user || '—') + '</code></td><td>' + esc(u.role) + '</td>' +
          '<td>' + (u.is_active ? '<span class="tag tag--ok">Actif</span>' : '<span class="tag tag--danger">Désactivé</span>') + '</td>' +
          '<td>' + (u.twofa_enabled ? '<span class="tag tag--ok">2FA</span>' : '<span class="tag tag--muted">2FA non</span>') + '</td>' +
          '<td><button class="btn btn--ghost btn--sm" data-toggle="' + u.id + '">' + (u.is_active ? 'Désactiver' : 'Activer') + '</button></td></tr>';
      }).join('');
      openModal('<h3>' + esc(i.name) + '</h3><p class="sub"><code>' + esc(i.code_imf) + '</code> · ' + esc(i.city) + ' · ' + esc(i.country_code) + ' · statut ' + esc(i.status) + (i.trial_ends_at ? ' · essai jusqu’au ' + dfr(i.trial_ends_at) : '') + '</p>' +
        '<div style="max-height:320px;overflow:auto"><table class="tbl"><thead><tr><th>Nom</th><th>Code</th><th>Rôle</th><th>État</th><th>2FA</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="6">Aucun utilisateur.</td></tr>') + '</tbody></table></div>' +
        '<div class="modal__nav"><button class="btn btn--primary" id="d-ok">Fermer</button></div>');
      $('d-ok').addEventListener('click', function () { close(); loadImfs(); });
      $('modal-root').querySelectorAll('[data-toggle]').forEach(function (b) {
        b.addEventListener('click', function () {
          api('/api/v1/teebo/users/' + b.dataset.toggle + '/toggle', 'POST').then(function () { close(); detail(id); })
            .catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
        });
      });
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }
  function changeStatus(id) {
    openModal('<h3>Changer le statut de l’institution</h3><p class="sub">Choisissez la nouvelle situation de cette IMF.</p>' +
      '<div class="fld"><label for="st">Statut</label><select id="st">' +
      '<option value="trial">Essai (trial)</option><option value="active">Active</option><option value="suspended">Suspendue</option><option value="approved">Approuvée</option><option value="pending">En attente</option></select></div>' +
      '<div class="fld"><label for="ext">Prolonger l’essai de (jours) — si statut « Essai »</label><input id="ext" type="number" min="0" max="365" value="0"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="s-cancel">Annuler</button><button class="btn btn--primary" id="s-ok">Enregistrer</button></div>');
    $('s-cancel').addEventListener('click', close);
    $('s-ok').addEventListener('click', function () {
      var self = this; self.disabled = true;
      api('/api/v1/teebo/imfs/' + id + '/status', 'POST', { status: $('st').value, extend_trial_days: parseInt($('ext').value, 10) || 0 })
        .then(function () { close(); notify('Statut mis à jour.', 'ok'); return loadImfs(); })
        .catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }

  // ----- Administrateurs IMF -----
  function loadAdmins() {
    return api('/api/v1/teebo/imf-admins').then(function (d) {
      var as = d.admins || [];
      if (!as.length) { $('admins-table').innerHTML = '<div class="empty">Aucun administrateur IMF.</div>'; return; }
      $('admins-table').innerHTML = '<table class="tbl"><thead><tr><th>Admin</th><th>E-mail</th><th>Code d’accès</th><th>Institution</th><th>Statut IMF</th><th>Créé le</th></tr></thead><tbody>' +
        as.map(function (a) {
          return '<tr><td><b>' + esc(a.full_name || '—') + '</b></td><td>' + esc(a.email || '—') + '</td>' +
            '<td>' + codeCell(a.code_user, a.must_change_password) + '</td>' +
            '<td>' + esc(a.imf_name) + '<br><small style="color:var(--muted)">' + esc(a.code_imf) + '</small></td>' +
            '<td>' + esc(a.imf_status) + '</td><td>' + dfr(a.created_at) + '</td></tr>';
        }).join('') + '</tbody></table>';
      $('admins-table').querySelectorAll('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { copyCode(b.dataset.copy); }); });
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  // ----- Mon profil éditeur + 2FA -----
  function loadProfile() {
    var rows = [['Nom', me.user.full_name], ['E-mail', me.user.email], ['Rôle', 'Éditeur teebo (super-administrateur)'], ['Portée', 'Console d’approbation — hors IMF']];
    $('profile-info').innerHTML = rows.map(function (r) { return '<div style="display:flex;gap:10px"><dt style="min-width:130px;color:var(--muted)">' + esc(r[0]) + '</dt><dd style="margin:0">' + esc(r[1]) + '</dd></div>'; }).join('');
    api('/api/v1/auth/2fa/status').then(function (st) {
      var box = $('twofa-box');
      if (st.enabled) {
        box.innerHTML = '<div class="alert alert--ok" style="display:block">Double authentification <b>activée</b> (' + (st.recovery_count || 0) + ' codes de secours restants).</div>';
      } else {
        box.innerHTML = '<div class="alert alert--warn" style="display:block">Double authentification <b>non activée</b> — obligatoire pour votre profil.</div>' +
          '<button class="btn btn--primary" id="btn-enroll" style="margin-top:12px">Activer la double authentification</button>';
        var be = $('btn-enroll');
        if (be) be.addEventListener('click', startEnroll);
      }
    }).catch(function () {});
  }
  function startEnroll() {
    api('/api/v1/auth/2fa/enroll/start', 'POST').then(function (d) {
      // QR généré LOCALEMENT par le serveur (data URL) : conforme à la CSP
      // stricte (img-src 'self' data:) et sans dépendance réseau externe.
      var qr = d.qr_data_url || '';
      openModal('<h3>Activer la double authentification</h3><p class="sub">Scannez ce QR code avec Google Authenticator, Authy ou FreeOTP, puis saisissez le code à 6 chiffres affiché.</p>' +
        '<div style="text-align:center;margin:10px 0"><img src="' + esc(qr) + '" width="180" height="180" alt="QR" style="border-radius:10px;background:#fff;padding:8px"></div>' +
        '<p class="sub">Clé manuelle : <code>' + esc(d.secret) + '</code></p>' +
        '<div class="fld"><label for="otp">Code à 6 chiffres</label><input id="otp" inputmode="numeric" maxlength="6" placeholder="••••••"></div>' +
        '<div class="modal__nav"><button class="btn btn--ghost" id="e-cancel">Annuler</button><button class="btn btn--primary" id="e-ok">Confirmer et activer</button></div>');
      $('e-cancel').addEventListener('click', close);
      $('e-ok').addEventListener('click', function () {
        var self = this; self.disabled = true;
        api('/api/v1/auth/2fa/enroll/confirm', 'POST', { code: ($('otp').value || '').replace(/\D/g, '') }).then(function (r) {
          close();
          openModal('<h3>2FA activée ✅</h3><p class="sub">Conservez ces codes de secours en lieu sûr (affichés une seule fois) :</p>' +
            '<div style="font-family:monospace;font-size:15px;line-height:1.9;margin:12px 0">' + (r.recovery_codes || []).map(esc).join('<br>') + '</div>' +
            '<div class="modal__nav"><button class="btn btn--primary" id="okm">J’ai conservé mes codes</button></div>');
          $('okm').addEventListener('click', function () { close(); loadProfile(); });
        }).catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
      });
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  $('btn-logout').addEventListener('click', function () { api('/api/v1/auth/logout', 'POST').finally(function () { window.location.assign('/login.html'); }); });

  api('/api/v1/auth/me').then(function (d) {
    me = d;
    if (d.user.role !== 'teebo_admin') { notify('Accès réservé à teebo.', 'err'); setTimeout(function () { window.location.assign('/app.html'); }, 1200); return; }
    $('u-name').textContent = d.user.full_name;
    $('u-email').textContent = d.user.email;
    loadSubscriptions();
    return loadStats();
  }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
})();
