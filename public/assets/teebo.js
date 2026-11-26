/* teebo — console d’administration (éditeur) : approbations, institutions,
   administrateurs IMF, profil éditeur + 2FA. */
(function () {
  'use strict';
  var me = null;
  var VIEWS = ['dashboard', 'requests', 'imfs', 'admins', 'profiles', 'profile'];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(c) { return (Number(c || 0) / 100).toLocaleString('fr-FR') + ' FCFA'; }
  function dfr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : '—'; }
  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.message || d.error || 'error'); e.code = d.error; e.status = r.status; e.detail = d.message || ''; throw e; }
        return d; }); });
  }
  function notify(m, t) { var a = $('global-alert'); a.textContent = m; a.className = 'alert alert--' + (t || 'info'); a.hidden = false;
    clearTimeout(notify._t); notify._t = setTimeout(function () { a.hidden = true; }, 12000); }
  var MSG = { proforma_not_validated: 'La facture proforma n’a pas été validée par le prospect.', not_found: 'Élément introuvable.',
    no_admin: 'Aucun administrateur IMF pour cette institution.', no_code: 'Aucun code d’accès à renvoyer.',
    invalid_status: 'Statut invalide.', forbidden: 'Réservé aux administrateurs teebo.', idle_timeout: 'Session expirée (60 min d’inactivité).',
    session_expired: 'Session expirée.', not_authenticated: 'Non connecté.', invalid_session: 'Session invalide.',
    cannot_delete_system_tenant: 'Le tenant système teebo ne peut pas être supprimé.',
    confirm_code_mismatch: 'Le code saisi ne correspond pas au code de l’IMF.' };
  // CORRECTIF 51 : on affiche le message venu du serveur quand il existe
  // (au lieu du vague « Une erreur est survenue. » qui masquait la cause).
  function fr(e) {
    var c = e && e.code;
    return MSG[c] || (e && e.detail) || MSG[e && e.message] ||
      ((e && e.message && e.message !== 'error' && e.message !== 'Failed to fetch') ? e.message : '') ||
      (c === 'tenant_mismatch' ? 'Changement d’institution non autorisé : rechargez la page (Ctrl+Maj+R).' : '')
      || 'Une erreur est survenue. Rechargez la page (Ctrl+Maj+R) puis réessayez.';
  }
  function errBlock(id, e) {
    return '<div class="empty">' + esc(fr(e)) +
      '<div style="margin-top:10px"><button class="btn btn--primary btn--sm" data-retry="' + esc(id) + '">Réessayer</button></div></div>';
  }
  function guard(e) { if (['idle_timeout','session_expired','invalid_session','not_authenticated','session_revoked'].indexOf(e.message) >= 0) { window.location.assign('/login.html'); return true; } return false; }

  // ----- Navigation -----
  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('[id^=v82-].view').forEach(function(x){x.hidden=true;});
      var v = b.dataset.view;
      VIEWS.forEach(function (x) { var el = $('view-' + x); if (el) el.hidden = x !== v; });
      document.querySelectorAll('.nav-item').forEach(function (x) { x.classList.toggle('active', x === b); });
      if (v === 'imfs') loadImfs();
      if (v === 'admins') loadAdmins();
      if (v === 'profile') loadProfile();
      if (v === 'profiles') loadProfilesMatrix();
      if (v === 'requests') loadRequests();
      if (v === 'dashboard') loadStats();
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

  // Bloc « Envoyer » : liens WhatsApp (click-to-chat) + e-mail (mailto) +
  // facture. Garantit l'envoi du code et de la facture même sans API Cloud/SMTP.
  function sendBlock(send) {
    if (!send) return '';
    var parts = [];
    if (send.auto_sent) parts.push('<p class="sub" style="color:#1f9d55">Envoyé automatiquement. Vous pouvez aussi renvoyer manuellement :</p>');
    else parts.push('<p class="sub">Cliquez pour envoyer depuis WhatsApp (+22650321432) ou votre messagerie (hello@teebo.africa) :</p>');
    var btns = [];
    if (send.wa_link) btns.push('<a class="btn btn--primary btn--sm" target="_blank" rel="noopener" href="' + esc(send.wa_link) + '">Envoyer par WhatsApp</a>');
    if (send.mailto_link) btns.push('<a class="btn btn--ghost btn--sm" href="' + esc(send.mailto_link) + '">Envoyer par e-mail</a>');
    if (send.invoice_public_url) btns.push('<a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="' + esc(send.invoice_public_url) + '">Ouvrir la facture</a>');
    parts.push('<div style="display:flex;flex-wrap:wrap;gap:8px;margin:10px 0">' + btns.join('') + '</div>');
    return parts.join('');
  }

  // ----- Tableau de bord (statistiques plateforme) -----
  function loadStats(){
    return api('/api/v1/teebo/v82/tableau-de-bord').then(function(d){var s=d.compteurs||{};var cs=[['Institutions',s.institutions],['Essais',s.essais],['Actives',s.actives],['Suspendues',s.suspendues],['Administrateurs IMF',s.admins],['Demandes de modules',s.demandes],['MRR',Number(d.mrr_fcfa).toLocaleString('fr-FR')+' FCFA'],['Impayés',Number(d.impaye_fcfa).toLocaleString('fr-FR')+' FCFA'],['Encaissé',Number(d.encaisse_fcfa).toLocaleString('fr-FR')+' FCFA']];$('stats-cards').innerHTML=cs.map(function(c){return '<div class="card"><b style="font-size:26px">'+esc(c[1]??0)+'</b><p>'+esc(c[0])+'</p></div>';}).join('');}).catch(function(e){if(!guard(e))$('stats-cards').innerHTML=errBlock('stats',e);});
  }

  // ----- Demandes -----
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
    }).catch(function (e) {
      if (guard(e)) return;
      var el = $('requests-table');
      if (el) { el.innerHTML = errBlock('req', e);
        el.querySelectorAll('[data-retry]').forEach(function (b) { b.addEventListener('click', function () { loadRequests(); }); }); }
      notify(fr(e), 'err');
    });
  }

  function approve(id) {
    openModal('<h3>Approuver la demande</h3><p class="sub">Chaque module choisi par l’IMF démarre son essai gratuit de 30 jours. Le code d’accès administrateur sera envoyé à l’IMF par WhatsApp et e-mail — et restera visible ici.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="a-cancel">Annuler</button><button class="btn btn--primary" id="a-ok">Approuver et activer l’essai</button></div>');
    $('a-cancel').addEventListener('click', close);
    $('a-ok').addEventListener('click', function () {
      var self = this; self.disabled = true;
      api('/api/v1/teebo/requests/' + id + '/approve', 'POST').then(function (d) {
        close();
        openModal('<h3>Demande approuvée ✅</h3><p class="sub">Essai gratuit activé sur les modules choisis (30 jours par module). Communiquez ce code d’accès à l’IMF :</p>' +
          '<div style="font-size:22px;font-weight:700;letter-spacing:1px;margin:14px 0"><code>' + esc(d.code_user) + '</code></div>' +
          '<p class="sub">IMF <b>' + esc(d.imf_code) + '</b>' + (d.invoice_no ? ' · Facture <b>' + esc(d.invoice_no) + '</b>' : '') + '.</p>' +
          sendBlock(d.send) +
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
    return api('/api/v1/teebo/v82/institutions').then(function (d) {
      IMFS = d.institutions || [];
      if (!IMFS.length) { $('imfs-table').innerHTML = '<div class="empty">Aucune institution.</div>'; return; }
      var LABEL = { pending: 'En attente', trial: 'Essai', active: 'Active', suspended: 'Suspendue', rejected: 'Rejetée', approved: 'Approuvée' };
      $('imfs-table').innerHTML = '<table class="tbl"><thead><tr><th>Institution</th><th>Code</th><th>Pays</th><th>Type</th><th>Statut</th><th>Fin d’essai</th><th>Code admin</th><th>Actions</th></tr></thead><tbody>' +
        IMFS.map(function (i) {
          var cls = i.status === 'active' ? 'tag--ok' : (i.status === 'rejected' ? 'tag--danger' : (i.status === 'trial' ? 'tag--warn' : 'tag--muted'));
          var acts = '';
          acts += '<button class="btn btn--ghost btn--sm" data-resend="' + i.id + '">Renvoyer le code</button> ';
          acts += '<button class="btn btn--ghost btn--sm" data-regen="' + i.id + '">Régénérer</button> ';
          acts += '<button class="btn btn--ghost btn--sm" data-detail="' + i.id + '">Détail</button> ';
          acts += '<button class="btn btn--ghost btn--sm" data-status="' + i.id + '">Statut</button> ';
          acts += '<button class="btn btn--danger btn--sm" data-del="' + i.id + '">Supprimer</button>';
          return '<tr><td><b>' + esc(i.name) + '</b><br><small style="color:var(--muted)">' + esc(i.city) + '</small></td><td><code>' + esc(i.code_imf) + '</code></td>' +
            '<td>' + esc(i.country_code) + '</td><td>' + esc(i.type) + '</td>' +
            '<td><span class="tag ' + cls + '">' + esc(i.badge?.label || LABEL[i.status] || i.status) + '</span></td>' +
            '<td>' + dfr(i.trial_ends_at) + '</td>' +
            '<td>' + codeCell(i.admin_code, i.admin_must_change) + '</td>' +
            '<td style="white-space:nowrap">' + acts + '</td></tr>';
        }).join('') + '</tbody></table>';
      $('imfs-table').querySelectorAll('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { copyCode(b.dataset.copy); }); });
      $('imfs-table').querySelectorAll('[data-resend]').forEach(function (b) { b.addEventListener('click', function () { resend(b.dataset.resend); }); });
      $('imfs-table').querySelectorAll('[data-regen]').forEach(function (b) { b.addEventListener('click', function () { regen(b.dataset.regen); }); });
      $('imfs-table').querySelectorAll('[data-detail]').forEach(function (b) { b.addEventListener('click', function () { detail(b.dataset.detail); }); });
      $('imfs-table').querySelectorAll('[data-status]').forEach(function (b) { b.addEventListener('click', function () { changeStatus(b.dataset.status); }); });
      $('imfs-table').querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { delImf(b.dataset.del); }); });
    }).catch(function (e) {
      // CORRECTIF 52 : l'onglet Institutions restait vide (ou fige) quand
      // /teebo/imfs echouait ; l'erreur et un bouton Réessayer s'affichent
      // desormais a la place du tableau.
      if (guard(e)) return;
      $('imfs-table').innerHTML = errBlock('imfs', e);
    });
  }

  function resend(id) {
    api('/api/v1/teebo/imfs/' + id + '/resend-code', 'POST')
      .then(function (d) {
        openModal('<h3>Renvoyer le code d’accès</h3>' +
          '<div style="font-size:22px;font-weight:700;letter-spacing:1px;margin:14px 0"><code>' + esc(d.code_user) + '</code></div>' +
          sendBlock(d.send) +
          '<div class="modal__nav"><button class="btn btn--ghost" id="cp">Copier</button><button class="btn btn--primary" id="okm">Terminé</button></div>');
        $('cp').addEventListener('click', function () { copyCode(d.code_user); });
        $('okm').addEventListener('click', close);
      })
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
          sendBlock(d.send) +
          '<div class="modal__nav"><button class="btn btn--ghost" id="cp">Copier</button><button class="btn btn--primary" id="okm">Terminé</button></div>');
        $('cp').addEventListener('click', function () { copyCode(d.code_user); });
        $('okm').addEventListener('click', function () { close(); loadImfs(); });
      }).catch(function (e) { self.disabled = false; if (!guard(e)) notify(fr(e), 'err'); });
    });
  }
  window.__v82Reload=loadImfs;
  function detail(id) {
    if(window.TeeboV82)return window.TeeboV82.detail(id);
    api('/api/v1/teebo/imfs/' + id).then(function (d) {
      var i = d.imf || {}, us = d.users || d.imf_admins || [];  // CORRECTIF 52 : liste « users » ou « imf_admins »
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
  function changeStatus(id) {detail(id);}

  function delImf(id) {
    var i = null;
    for (var k = 0; k < IMFS.length; k++) { if (String(IMFS[k].id) === String(id)) { i = IMFS[k]; break; } }
    if (!i) { notify('Institution introuvable.', 'err'); return; }
    if (i.code_imf === 'TBO-SYS-000000') { notify('Le tenant système teebo ne peut pas être supprimé.', 'err'); return; }
    openModal('<h3>Supprimer l’institution</h3>' +
      '<p class="sub" style="color:var(--danger,#c0392b)"><b>Action irréversible.</b> La suppression efface en cascade tous les comptes, clients, budgets et données de <b>' + esc(i.name) + '</b> (<code>' + esc(i.code_imf) + '</code>).</p>' +
      '<div class="fld"><label><input type="radio" name="delmode" value="soft" checked> Archiver (soft) — masquer l’IMF sans effacer les données</label></div>' +
      '<div class="fld"><label><input type="radio" name="delmode" value="hard"> Supprimer définitivement (hard) — purge en cascade</label></div>' +
      '<div class="fld"><label for="delc">Pour confirmer, saisissez le code de l’IMF : <code>' + esc(i.code_imf) + '</code></label><input id="delc" type="text" autocomplete="off" placeholder="' + esc(i.code_imf) + '"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="del-cancel">Annuler</button><button class="btn btn--danger" id="del-ok">Supprimer</button></div>');
    $('del-cancel').addEventListener('click', close);
    $('del-ok').addEventListener('click', function () {
      var self = this;
      var code = ($('delc').value || '').trim();
      if (code !== i.code_imf) { notify('Le code saisi ne correspond pas.', 'err'); return; }
      var mode = (document.querySelector('input[name="delmode"]:checked') || {}).value || 'soft';
      self.disabled = true;
      api('/api/v1/teebo/imfs/' + id + '/delete', 'POST', { confirm_code: code, mode: mode })
        .then(function () { close(); notify('Institution ' + (mode === 'hard' ? 'supprimée définitivement' : 'archivée') + '.', 'ok'); return loadImfs(); })
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
    }).catch(function (e) { if (guard(e)) return; $('admins-table').innerHTML = errBlock('admins', e); });
  }

  // ----- Mon profil éditeur + 2FA -----
  function loadProfilesMatrix() {
    api('/api/v1/teebo/profiles-matrix').then(function (m) {
      var roles = m.roles || [], perms = m.permissions || [], grid = m.grid || {};
      var head = '<tr><th style="min-width:220px">Habilitation</th>' +
        roles.map(function (r) { return '<th style="text-align:center">' + esc(r.label) + '</th>'; }).join('') + '</tr>';
      var body = perms.map(function (p) {
        return '<tr><td>' + esc(p.label) + '</td>' +
          roles.map(function (r) {
            var ok = grid[r.key] && grid[r.key][p.key];
            return '<td style="text-align:center">' + (ok
              ? '<span class="tag tag--ok">✓</span>'
              : '<span style="color:var(--muted)">—</span>') + '</td>';
          }).join('') + '</tr>';
      }).join('');
      $('profiles-matrix').innerHTML =
        '<p class="hint" style="margin-bottom:14px">✓ = habilitation accordée par défaut à ce profil, attachée automatiquement à chaque utilisateur IMF créé selon son rôle.</p>' +
        '<div style="overflow-x:auto"><table class="tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
    }).catch(function (e) { if (guard(e)) return; $('profiles-matrix').innerHTML = errBlock('profiles', e); });
  }

  function loadProfile() {
    // CORRECTIF 52 : si la verification de session a echoue, « me » est vide.
    // Sans cette garde, l'onglet restait bloque sur « Chargement… ».
    if (!me || !me.user) {
      $('profile-info').innerHTML = '<div class="empty">Votre session n’a pas pu être vérifiée.' +
        '<div style="margin-top:10px"><button class="btn btn--primary btn--sm" data-retry="profil">Réessayer</button> ' +
        '<a class="btn btn--ghost btn--sm" href="/login.html">Se reconnecter</a></div></div>';
      return;
    }
    var rows = [['Nom', me.user.full_name], ['E-mail', me.user.email], ['Rôle', 'Éditeur teebo (super-administrateur)'], ['Portée', 'Console d’approbation — hors IMF']];
    $('profile-info').innerHTML = rows.map(function (r) { return '<div style="display:flex;gap:10px"><dt style="min-width:130px;color:var(--muted)">' + esc(r[0]) + '</dt><dd style="margin:0">' + esc(r[1]) + '</dd></div>'; }).join('');
    var pw=document.getElementById('editor-password');if(!pw){pw=document.createElement('div');pw.id='editor-password';$('profile-info').after(pw);}pw.innerHTML='<h3>Changer mon mot de passe</h3><form id="editor-password-form"><div class="fld"><label for="pw-current">Mot de passe actuel</label><input id="pw-current" type="password" autocomplete="current-password" required></div><div class="fld"><label for="pw-new">Nouveau mot de passe (10 caractères, minuscule, majuscule et chiffre)</label><input id="pw-new" type="password" autocomplete="new-password" minlength="10" required></div><div class="fld"><label for="pw-confirm">Confirmer</label><input id="pw-confirm" type="password" autocomplete="new-password" required></div><button class="btn btn--primary">Enregistrer mon mot de passe</button></form>';
    $('editor-password-form').addEventListener('submit',function(ev){ev.preventDefault();if($('pw-new').value!==$('pw-confirm').value)return notify('Les mots de passe ne correspondent pas.','err');var b=this.querySelector('button');b.disabled=true;api('/api/v1/auth/change-password','POST',{current:$('pw-current').value,new_password:$('pw-new').value}).then(function(){$('editor-password-form').reset();notify('Mot de passe modifié.','ok');}).catch(function(e){notify(fr(e),'err');}).finally(function(){b.disabled=false;});});
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
    }).catch(function (e) {
      // L'etat 2FA ne doit jamais laisser un cadre vide sans explication.
      $('twofa-box').innerHTML = errBlock('2fa', e);
    });
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
    return loadStats();
  }).catch(function (e) {
    if (guard(e)) return;
    // CORRECTIF 52 : sans cette branche, l'ecran restait sur « Chargement… »
    // quand /auth/me echouait (service endormi, session invalide, 502).
    var box = $('stats-cards');
    if (box) box.innerHTML = errBlock('session', e) +
      '<div style="margin-top:8px"><a class="btn btn--ghost btn--sm" href="/login.html">Se reconnecter</a></div>';
    notify(fr(e), 'err');
  });

  // CORRECTIF 52 : un seul gestionnaire pour TOUS les boutons « Réessayer »
  // affiches dans les differentes zones (tableau de bord, demandes,
  // institutions, administrateurs, profils, 2FA, verification de session).
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var b = (t && t.closest) ? t.closest('[data-retry]') : null;
    if (!b) return;
    var k = b.getAttribute('data-retry');
    if (k === 'imfs') loadImfs();
    else if (k === 'admins') loadAdmins();
    else if (k === 'profiles') loadProfilesMatrix();
    else if (k === 'profil' || k === 'profile' || k === '2fa') loadProfile();
    else if (k === 'requests') loadRequests();
    else if (k === 'session') window.location.reload();
    else loadStats();
  });
})();
