/* teebo — console d’administration : approbation des demandes IMF. */
(function () {
  'use strict';
  var me = null;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(c) { return (Number(c || 0) / 100).toLocaleString('fr-FR') + ' FCFA'; }
  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'error'); return d; }); });
  }
  function notify(m, t) { var a = $('global-alert'); a.textContent = m; a.className = 'alert alert--' + (t || 'info'); a.hidden = false;
    clearTimeout(notify._t); notify._t = setTimeout(function () { a.hidden = true; }, 6000); }
  var MSG = { proforma_not_validated: 'La facture proforma n’a pas été validée par le prospect.', not_found: 'Demande introuvable.',
    forbidden: 'Réservé aux administrateurs teebo.', idle_timeout: 'Session expirée (30 min d’inactivité).', session_expired: 'Session expirée.',
    not_authenticated: 'Non connecté.', invalid_session: 'Session invalide.' };
  function fr(e) { return MSG[e] || 'Une erreur est survenue.'; }
  function guard(e) { if (['idle_timeout','session_expired','invalid_session','not_authenticated','session_revoked'].indexOf(e.message) >= 0) { window.location.assign('/login.html'); return true; } return false; }

  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () {
      ['requests','imfs'].forEach(function (v) { $('view-' + v).hidden = v !== b.dataset.view; });
      document.querySelectorAll('.nav-item').forEach(function (x) { x.classList.toggle('active', x === b); });
      if (b.dataset.view === 'imfs') loadImfs();
    });
  });

  function openModal(h) { $('modal-root').innerHTML = '<div class="modal-wrap"><div class="modal">' + h + '</div></div>';
    var w = $('modal-root').querySelector('.modal-wrap'); w.addEventListener('click', function (e) { if (e.target === w) close(); }); }
  function close() { $('modal-root').innerHTML = ''; }

  function loadRequests() {
    return api('/api/v1/teebo/requests').then(function (d) {
      var rs = d.requests || [];
      var pending = rs.filter(function (r) { return r.proforma_validated && !r.decision; }).length;
      $('req-chips').innerHTML = '<span class="chip chip--warn">À traiter <b>' + pending + '</b></span><span class="chip">Total <b>' + rs.length + '</b></span>';
      if (!rs.length) { $('requests-table').innerHTML = '<div class="empty">Aucune demande pour le moment.</div>'; return; }
      $('requests-table').innerHTML = '<table class="tbl"><thead><tr><th>IMF</th><th>Type</th><th>Responsable</th><th>Formule / Proforma</th><th>Statut</th><th></th></tr></thead><tbody>' +
        rs.map(function (r) {
          var status = !r.proforma_validated ? '<span class="tag tag--muted">Proforma en attente</span>'
            : (!r.decision ? '<span class="tag tag--warn">À approuver</span>'
            : (r.decision === 'approved' ? '<span class="tag tag--ok">Approuvée</span>' : '<span class="tag tag--danger">Rejetée</span>'));
          var canApprove = r.proforma_validated && !r.decision;
          return '<tr><td><b>' + esc(r.imf_name) + '</b><br><code>' + esc(r.code_imf) + '</code> · ' + esc(r.country_code) + '</td>' +
            '<td>' + esc(r.type) + '</td>' +
            '<td>' + esc(r.requester_firstname + ' ' + r.requester_lastname) + '<br><small style="color:var(--muted)">' + esc(r.requester_position || '') + '</small></td>' +
            '<td>' + esc(r.plan_code || '—') + (r.proforma_no ? '<br><small style="color:var(--muted)">' + esc(r.proforma_no) + ' · ' + money(r.proforma_amount_cents) + '</small>' : '') + '</td>' +
            '<td>' + status + '</td>' +
            '<td style="text-align:right">' + (canApprove ? '<button class="btn btn--primary btn--sm" data-approve="' + r.id + '">Approuver</button> <button class="btn btn--ghost btn--sm" data-reject="' + r.id + '">Rejeter</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
      $('requests-table').querySelectorAll('[data-approve]').forEach(function (b) { b.addEventListener('click', function () { approve(b.dataset.approve); }); });
      $('requests-table').querySelectorAll('[data-reject]').forEach(function (b) { b.addEventListener('click', function () { reject(b.dataset.reject); }); });
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  function approve(id) {
    openModal('<h3>Approuver la demande</h3><p class="sub">Un essai gratuit de 30 jours calendaires sera activé. Le code d’accès administrateur sera envoyé à l’IMF par WhatsApp et e-mail.</p>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="a-cancel">Annuler</button><button class="btn btn--primary" id="a-ok">Approuver et activer l’essai</button></div>');
    $('a-cancel').addEventListener('click', close);
    $('a-ok').addEventListener('click', function () {
      var self = this; self.disabled = true;
      api('/api/v1/teebo/requests/' + id + '/approve', 'POST').then(function (d) {
        close(); notify('Demande approuvée. Code admin IMF : ' + d.code_user + ' (envoyé à l’IMF).', 'ok'); return loadRequests();
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

  function loadImfs() {
    api('/api/v1/teebo/imfs').then(function (d) {
      var imfs = d.imfs || [];
      if (!imfs.length) { $('imfs-table').innerHTML = '<div class="empty">Aucune institution.</div>'; return; }
      var LABEL = { pending: 'En attente', trial: 'Essai', active: 'Active', suspended: 'Suspendue', rejected: 'Rejetée' };
      $('imfs-table').innerHTML = '<table class="tbl"><thead><tr><th>Institution</th><th>Code</th><th>Pays</th><th>Type</th><th>Agrément BCEAO</th><th>Statut</th><th>Fin d’essai</th></tr></thead><tbody>' +
        imfs.map(function (i) {
          var cls = i.status === 'active' ? 'tag--ok' : (i.status === 'rejected' ? 'tag--danger' : (i.status === 'trial' ? 'tag--warn' : 'tag--muted'));
          return '<tr><td><b>' + esc(i.name) + '</b><br><small style="color:var(--muted)">' + esc(i.city) + '</small></td><td><code>' + esc(i.code_imf) + '</code></td>' +
            '<td>' + esc(i.country_code) + '</td><td>' + esc(i.type) + '</td><td>' + esc(i.bceao_agreement_no) + '</td>' +
            '<td><span class="tag ' + cls + '">' + esc(LABEL[i.status] || i.status) + '</span></td>' +
            '<td>' + (i.trial_ends_at ? new Date(i.trial_ends_at).toLocaleDateString('fr-FR') : '—') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
  }

  $('btn-logout').addEventListener('click', function () { api('/api/v1/auth/logout', 'POST').finally(function () { window.location.assign('/login.html'); }); });

  api('/api/v1/auth/me').then(function (d) {
    me = d;
    if (d.user.role !== 'teebo_admin') { notify('Accès réservé à teebo.', 'err'); setTimeout(function () { window.location.assign('/app.html'); }, 1200); return; }
    $('u-name').textContent = d.user.full_name;
    $('u-email').textContent = d.user.email;
    return loadRequests();
  }).catch(function (e) { if (!guard(e)) notify(fr(e), 'err'); });
})();
