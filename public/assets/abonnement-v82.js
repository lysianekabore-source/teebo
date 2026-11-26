/* teebo — page Abonnement IMF : modules, demande d'ouverture, suivi, factures.
   Les montants viennent du serveur (FCFA décimaux) ; cette page n'en calcule aucun. */
(function () {
  'use strict';
  var $ = function (i) { return document.getElementById(i); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fcfa(v) { return (Number(v) || 0).toLocaleString('fr-FR',{maximumFractionDigits:2}) + ' FCFA'; }
  function dfr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : '—'; }
  var alertBox = $('abo-alert');
  function say(m, t) { alertBox.textContent = m; alertBox.className = 'alert alert--' + (t || 'info'); alertBox.hidden = false; }
  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401) { window.location.assign('/login.html'); throw new Error('session'); }
        if (!r.ok) throw new Error(d.message || d.error || 'error'); return d; }); });
  }
  var DISPO = [];
  function loadAll() {
    api('/api/v1/tenant/demandes-modules').then(function (d) {
      var c = d.contrat;
      $('abo-status').innerHTML = c
        ? '<h2>Votre contrat</h2><p>Statut : <b>' + esc(c.statut) + '</b>' + (c.fin_essai ? ' · essai jusqu’au ' + dfr(c.fin_essai) : '') + ' · périodicité ' + esc(c.periodicite) + '</p>'
        : '<p>Votre institution n’a pas encore de contrat : contactez teebo.</p>';
      var rs = d.demandes || [];
      $('abo-requests').innerHTML = rs.length ? '<table class="tbl"><thead><tr><th>Modules</th><th>Déposée</th><th>Statut</th><th>Réponse</th><th></th></tr></thead><tbody>' + rs.map(function (r) {
        var st = r.statut === 'EN_ATTENTE' ? '<span class="tag tag--warn">En attente</span>' : r.statut === 'APPROUVEE' ? '<span class="tag tag--ok">Approuvée</span>' : r.statut === 'REFUSEE' ? '<span class="tag tag--danger">Refusée</span>' : '<span class="tag tag--muted">Annulée</span>';
        return '<tr><td>' + r.modules.map(function (m) { return esc(m.nom); }).join(', ') + '</td><td>' + dfr(r.created_at) + '</td><td>' + st + '</td><td>' + esc(r.commentaire || '—') + '</td><td>' + (r.statut === 'EN_ATTENTE' ? '<button class="btn btn--ghost btn--sm" data-cancel="' + r.id + '">Annuler</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' : '<p>Aucune demande déposée.</p>';
    }).catch(function (e) { if (e.message !== 'session') say(e.message, 'err'); });
    api('/api/v1/tenant/catalogue').then(function (d) {
      DISPO = (d.modules || []).map(function (m) { return { code: m.code, nom: m.nom, prix: m.prix_mensuel, actif: m.disponible !== false, souscrit:m.actif,essai:m.essai }; });
      $('abo-catalogue').innerHTML = DISPO.map(function (m) {
        return '<div class="card" style="display:block"><b>' + esc(m.nom) + '</b><p style="margin:6px 0">' + fcfa(m.prix) + ' / mois</p><label><input type="checkbox" value="' + esc(m.code) + '" data-abo-mod' + (m.actif&&!m.souscrit ? '' : ' disabled') + '> '+(m.souscrit?(m.essai?'Essai en cours':'Module actif'):'Demander ce module')+'</label></div>';
      }).join('');
    }).catch(function () { $('abo-catalogue').innerHTML = '<p>Catalogue momentanément indisponible.</p>'; });
    api('/api/v1/tenant/factures').then(function (d) {
      var fs = d.factures || [];
      $('abo-invoices').innerHTML = fs.length ? '<table class="tbl"><thead><tr><th>Numéro</th><th>Période</th><th>Total</th><th>Statut</th><th></th></tr></thead><tbody>' + fs.map(function (f) {
        return '<tr><td><code>' + esc(f.numero || '—') + '</code></td><td>' + dfr(f.debut) + ' → ' + dfr(f.fin) + '</td><td>' + fcfa(f.total_fcfa) + '</td><td>' + esc(f.statut_libelle) + '</td><td><a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="/api/v1/tenant/factures/'+esc(f.source)+'/' + esc(f.id) + '.pdf">PDF</a></td></tr>';
      }).join('') + '</tbody></table>' : '<p>Aucune facture.</p>';
    }).catch(function () { $('abo-invoices').textContent = 'Factures momentanément indisponibles.'; });
  }
  $('abo-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var chosen = Array.prototype.slice.call(document.querySelectorAll('[data-abo-mod]:checked')).map(function (x) { return x.value; });
    if (!chosen.length) return say('Choisissez au moins un module.', 'err');
    var b = $('abo-send'); b.disabled = true; $('abo-hint').textContent = 'Envoi…';
    api('/api/v1/tenant/demandes-modules', 'POST', { modules: chosen, motif: $('abo-motif').value })
      .then(function (r) { $('abo-hint').textContent = ''; say(r.message, 'ok'); $('abo-motif').value = ''; document.querySelectorAll('[data-abo-mod]:checked').forEach(function (x) { x.checked = false; }); loadAll(); })
      .catch(function (e) { $('abo-hint').textContent = ''; if (e.message !== 'session') say(e.message, 'err'); })
      .finally(function () { b.disabled = false; });
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cancel]'); if (!b) return;
    b.disabled = true;
    api('/api/v1/tenant/demandes-modules/' + b.getAttribute('data-cancel') + '/annuler', 'POST')
      .then(function (r) { say(r.message, 'ok'); loadAll(); }).catch(function (x) { b.disabled = false; say(x.message, 'err'); });
  });
  api('/api/v1/auth/me').then(function () { loadAll(); }).catch(function () { });
})();
