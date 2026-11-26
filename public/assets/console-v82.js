/* teebo — console éditeur v82 : catalogue FCFA, demandes de modules, facturation,
   dossier complet d'une IMF (statut, essai, abonnement, modules, factures,
   encaissements, administrateurs, mot de passe). Aucune donnée d'adhérent. */
(function () {
  'use strict';
  if (!document.getElementById('view-imfs')) return;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fcfa(v) { return (Number(v) || 0).toLocaleString('fr-FR',{maximumFractionDigits:2}) + ' FCFA'; }
  function dfr(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : '—'; }
  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.message || d.error || 'error'); e.code = d.error; e.status = r.status; throw e; } return d; }); });
  }
  function notify(m, t) { var a = $('global-alert'); if (!a) return; a.textContent = m; a.className = 'alert alert--' + (t || 'info'); a.hidden = false;
    clearTimeout(notify._t); notify._t = setTimeout(function () { a.hidden = true; }, 12000); }
  function err(e) { return '<div class="empty">' + esc(e.message || 'Erreur') + '</div>'; }
  var root = $('modal-root');
  function openModal(h) { root.innerHTML = '<div class="modal-wrap v82-modal-wrap"><div class="modal v82-modal">' + h + '</div></div>'; var w = root.querySelector('.modal-wrap'); w.addEventListener('click', function (e) { if (e.target === w) close(); }); }
  function close() { root.innerHTML = ''; }
  var TON = { ok: 'tag--ok', warn: 'tag--warn', danger: 'tag--danger', muted: 'tag--muted' };
  function tag(b) { return b ? '<span class="tag ' + (TON[b.ton] || 'tag--muted') + '">' + esc(b.label) + '</span>' : ''; }

  /* ---------------- onglets ajoutés à la console ---------------- */
  var side = document.querySelector('.side');
  var main = document.querySelector('.main');
  function addNav(view, label, ic) {
    var b = document.createElement('button'); b.className = 'nav-item'; b.setAttribute('data-v82', view);
    b.innerHTML = '<span class="ic">' + ic + '</span> ' + label;
    var anchor = side.querySelector('[data-view="admins"]');
    side.insertBefore(b, anchor);
    var s = document.createElement('section'); s.className = 'view'; s.id = 'v82-' + view; s.hidden = true;
    s.innerHTML = '<div class="topbar"><div><h1></h1><p></p></div><div class="chips" id="v82-' + view + '-chips"></div></div><div id="v82-' + view + '-body"><div class="empty">Chargement…</div></div>';
    main.appendChild(s);
    b.addEventListener('click', function () {
      document.querySelectorAll('.side .nav-item').forEach(function (x) { x.classList.toggle('active', x === b); });
      document.querySelectorAll('.main .view').forEach(function (x) { x.hidden = true; });
      s.hidden = false;
      if (view === 'catalogue') loadCatalogue();
      if (view === 'demandes') loadDemandes();
      if (view === 'factures') loadFactures();
      if (view === 'securite') loadSecurite();
    });
    return { section: s, head: s.querySelector('h1'), sub: s.querySelector('p'), body: $('v82-' + view + '-body'), chips: $('v82-' + view + '-chips') };
  }
  var CAT = addNav('catalogue', 'Catalogue modules', '▤');
  var DEM = addNav('demandes', 'Demandes de modules', '✉');
  var FAC = addNav('factures', 'Facturation', '≡');
  var SEC = addNav('securite', 'Politique d’accès', '⛨');

  /* ------------------------- catalogue FCFA ------------------------- */
  function loadCatalogue() {
    CAT.head.textContent = 'Catalogue des modules';
    CAT.sub.textContent = 'Prix en FCFA, abonnement par module (jamais par utilisateur ni par agence). Un prix modifié s’applique aux prochaines factures.';
    CAT.body.innerHTML = '<div class="empty">Chargement…</div>';
    api('/api/v1/teebo/v82/catalogue').then(function (d) {
      CAT.chips.innerHTML = '<span class="chip">Licence unique <b>' + fcfa(d.licence_unique_fcfa) + '</b></span><span class="chip">Devise <b>' + esc(d.devise) + '</b></span>';
      CAT.body.innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Module</th><th>Prix / mois</th><th>Prix / an</th><th>Remise annuelle</th><th>Clients</th><th>Offre</th><th></th></tr></thead><tbody>' +
        d.modules.map(function (m) {
          return '<tr><td><b>' + esc(m.nom) + '</b><br><small style="color:var(--muted)">' + esc(m.code) + (m.inclus_essai ? ' · essai possible' : '') + '</small></td>' +
            '<td><input data-pm="' + esc(m.code) + '" value="' + m.prix_mensuel_fcfa + '" inputmode="numeric" style="width:110px" aria-label="Prix mensuel ' + esc(m.nom) + '"> FCFA</td>' +
            '<td><input data-pa="' + esc(m.code) + '" value="' + m.prix_annuel_fcfa + '" inputmode="numeric" style="width:120px" aria-label="Prix annuel ' + esc(m.nom) + '"> FCFA</td>' +
            '<td>' + (m.remise_annuelle_pct > 0 ? '<span class="tag tag--ok">−' + m.remise_annuelle_pct + ' %</span>' : '—') + '</td>' +
            '<td>' + m.nb_clients + '</td>' +
            '<td><label><input type="checkbox" data-on="' + esc(m.code) + '"' + (m.est_actif ? ' checked' : '') + '> ' + (m.est_actif ? 'Proposé' : 'Retiré') + '</label></td>' +
            '<td><button class="btn btn--primary btn--sm" data-save="' + esc(m.code) + '">Enregistrer</button></td></tr>';
        }).join('') + '</tbody></table></div>';
      CAT.body.querySelectorAll('[data-save]').forEach(function (b) {
        b.addEventListener('click', function () {
          var code = b.getAttribute('data-save');
          var pm = CAT.body.querySelector('[data-pm="' + code + '"]').value;
          var pa = CAT.body.querySelector('[data-pa="' + code + '"]').value;
          var on = CAT.body.querySelector('[data-on="' + code + '"]').checked;
          b.disabled = true;
          api('/api/v1/teebo/v82/catalogue/' + encodeURIComponent(code), 'PUT', { prix_mensuel_fcfa: pm, prix_annuel_fcfa: pa, est_actif: on })
            .then(function (r) { notify(r.message, 'ok'); loadCatalogue(); })
            .catch(function (e) { b.disabled = false; notify(e.message, 'err'); });
        });
      });
    }).catch(function (e) { CAT.body.innerHTML = err(e); });
  }

  /* --------------------- demandes de modules ---------------------- */
  function loadDemandes() {
    DEM.head.textContent = 'Demandes de modules';
    DEM.sub.textContent = 'Une IMF demande l’ouverture d’un module : l’approbation active les modules en une seule opération et prévient l’IMF.';
    DEM.body.innerHTML = '<div class="empty">Chargement…</div>';
    api('/api/v1/teebo/v82/demandes-modules').then(function (d) {
      DEM.chips.innerHTML = '<span class="chip chip--warn">À traiter <b>' + (d.attente || 0) + '</b></span><span class="chip">Total <b>' + d.demandes.length + '</b></span>';
      if (!d.demandes.length) { DEM.body.innerHTML = '<div class="empty">Aucune demande de module.</div>'; return; }
      DEM.body.innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>IMF</th><th>Modules demandés</th><th>Motif</th><th>Reçue</th><th>Badge</th><th></th></tr></thead><tbody>' +
        d.demandes.map(function (x) {
          var codes = (x.modules || []).map(function (m) { return '<code>' + esc(m.code || m) + '</code>'; }).join(' ');
          var acts = x.statut === 'EN_ATTENTE'
            ? '<button class="btn btn--primary btn--sm" data-ok="' + x.id + '">Approuver</button> <button class="btn btn--ghost btn--sm" data-no="' + x.id + '">Refuser</button>'
            : '<small style="color:var(--muted)">' + dfr(x.decide_le) + '</small>';
          return '<tr><td><b>' + esc(x.nom_imf) + '</b><br><small style="color:var(--muted)">' + esc(x.code_imf || '') + ' · ' + esc(x.city || '') + '</small></td>' +
            '<td>' + codes + '</td><td>' + esc(x.motif || '—') + '</td><td>' + dfr(x.created_at) + '</td><td>' + tag(x.badge) + '</td><td style="white-space:nowrap">' + acts + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      DEM.body.querySelectorAll('[data-ok]').forEach(function (b) { b.addEventListener('click', function () { approuver(b.getAttribute('data-ok')); }); });
      DEM.body.querySelectorAll('[data-no]').forEach(function (b) { b.addEventListener('click', function () { refuser(b.getAttribute('data-no')); }); });
    }).catch(function (e) { DEM.body.innerHTML = err(e); });
  }
  function approuver(id) {
    openModal('<h3>Approuver la demande</h3><p class="sub">Chaque module demandé est activé immédiatement. L’essai gratuit (une seule fois par module) s’applique quand le module le prévoit.</p>' +
      '<div class="fld"><label for="v82-j">Essai gratuit (jours) — 0 pour activer en payant</label><input id="v82-j" type="number" min="0" max="365" value="30"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="v82-c">Annuler</button><button class="btn btn--primary" id="v82-k">Approuver et activer</button></div>');
    $('v82-c').addEventListener('click', close);
    $('v82-k').addEventListener('click', function () {
      var b = this; b.disabled = true;
      api('/api/v1/teebo/v82/demandes-modules/' + id + '/approuver', 'POST', { essai_jours: Number($('v82-j').value) || 0 })
        .then(function (r) { close(); notify(r.message + (r.envoye ? ' IMF prévenue.' : ' Pensez à prévenir l’IMF.'), 'ok'); loadDemandes(); })
        .catch(function (e) { b.disabled = false; notify(e.message, 'err'); });
    });
  }
  function refuser(id) {
    openModal('<h3>Refuser la demande</h3><div class="fld"><label for="v82-m">Motif (facultatif)</label><textarea id="v82-m" rows="3"></textarea></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="v82-c">Annuler</button><button class="btn btn--primary" id="v82-k">Refuser</button></div>');
    $('v82-c').addEventListener('click', close);
    $('v82-k').addEventListener('click', function () {
      var b = this; b.disabled = true;
      api('/api/v1/teebo/v82/demandes-modules/' + id + '/refuser', 'POST', { motif: $('v82-m').value })
        .then(function () { close(); notify('Demande refusée.', 'ok'); loadDemandes(); })
        .catch(function (e) { b.disabled = false; notify(e.message, 'err'); });
    });
  }

  /* --------------------------- facturation -------------------------- */
  function loadFactures() {
    FAC.head.textContent = 'Facturation';
    FAC.sub.textContent = 'Factures émises, encaissements et impayés de toutes les institutions.';
    FAC.body.innerHTML = '<div class="empty">Chargement…</div>';
    api('/api/v1/teebo/v82/factures').then(function (d) {
      FAC.chips.innerHTML = '<span class="chip chip--warn">Impayé <b>' + fcfa(d.totaux.impaye_fcfa) + '</b></span><span class="chip chip--ok">Encaissé <b>' + fcfa(d.totaux.encaisse_fcfa) + '</b></span>';
      if (!d.factures.length) { FAC.body.innerHTML = '<div class="empty">Aucune facture émise.</div>'; return; }
      FAC.body.innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Numéro</th><th>IMF</th><th>Période</th><th>Montant</th><th>Statut</th><th></th></tr></thead><tbody>' +
        d.factures.map(function (f) {
          var base=f.source==='imf'?'/api/v1/teebo/v82/factures-historiques/':'/api/v1/teebo/v82/factures/';
          var btn=(f.statut==='IMPAYEE'?'<button class="btn btn--primary btn--sm" data-pay="'+f.id+'" data-source="'+esc(f.source)+'">Encaisser</button> ':'')+'<a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="'+base+f.id+'.pdf">PDF</a>';
          return '<tr><td><code>' + esc(f.numero || '—') + '</code></td><td>' + esc(f.imf || '') + '</td><td>' + dfr(f.debut) + ' → ' + dfr(f.fin) + '</td>' +
            '<td>' + fcfa(f.total_fcfa) + '</td><td>' + esc(f.statut_libelle || f.statut) + '</td><td style="white-space:nowrap">' + btn + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      FAC.body.querySelectorAll('[data-pay]').forEach(function (b) { b.addEventListener('click', function () { encaisser(b.getAttribute('data-pay'), loadFactures,b.dataset.source); }); });
    }).catch(function (e) { FAC.body.innerHTML = err(e); });
  }
  function encaisser(id, done, source) {
    openModal('<h3>Enregistrer un encaissement</h3><p class="sub">Le paiement est journalisé. Une institution suspendue pour impayé est réactivée dès que son solde est soldé.</p>' +
      '<div class="fld"><label for="v82-mode">Mode</label><select id="v82-mode"><option>VIREMENT</option><option>MOBILE_MONEY</option><option>CHEQUE</option><option>ESPECES</option></select></div>' +
      '<div class="fld"><label for="v82-amount">Montant reçu (FCFA, laisser vide pour solder)</label><input id="v82-amount" type="number" min="0.01" step="0.01"></div>' +
      '<div class="fld"><label for="v82-ref">Référence</label><input id="v82-ref" maxlength="100"></div>' +
      '<div class="modal__nav"><button class="btn btn--ghost" id="v82-c">Annuler</button><button class="btn btn--primary" id="v82-k">Encaisser</button></div>');
    $('v82-c').addEventListener('click', close);
    $('v82-k').addEventListener('click', function () {
      var b = this; b.disabled = true;
      api('/api/v1/teebo/v82/'+(source==='imf'?'factures-historiques/':'factures/') + id + '/paiement', 'POST', { montant:$('v82-amount').value||undefined,mode: $('v82-mode').value, reference: $('v82-ref').value })
        .then(function (r) { close(); notify(r.message, 'ok'); if (done) done(); })
        .catch(function (e) { b.disabled = false; notify(e.message, 'err'); });
    });
  }

  /* ------------------- habilitations & mot de passe ----------------- */
  function loadSecurite() {
    SEC.head.textContent = 'Habilitations & mot de passe';
    SEC.sub.textContent = 'Référentiel appliqué à chaque IMF et politique de mot de passe de la console.';
    SEC.body.innerHTML = '<div class="empty">Chargement…</div>';
    api('/api/v1/teebo/v82/matrice').then(function (m) {
      var p = m.politique_mot_de_passe || {};
      var head = '<tr><th style="min-width:220px">Habilitation</th>' + m.roles.map(function (r) { return '<th style="text-align:center">' + esc(r.label) + '<br><small>' + (r.effectif || 0) + '</small></th>'; }).join('') + '</tr>';
      var body = m.permissions.map(function (perm) {
        return '<tr><td>' + esc(perm.label) + '</td>' + m.roles.map(function (r) {
          return '<td style="text-align:center">' + (m.grid[r.key] && m.grid[r.key][perm.key] ? '<span class="tag tag--ok">✓</span>' : '<span style="color:var(--muted)">—</span>') + '</td>';
        }).join('') + '</tr>';
      }).join('');
      SEC.body.innerHTML = '<div class="card" style="margin-bottom:18px"><p class="hint">Longueur minimale ' + esc(p.longueur_min) + ' · ' + esc(p.complexite) + ' · verrouillage après ' + esc(p.verrouillage_echecs) + ' échecs · 2FA ' + esc(p.deux_facteurs) + '.</p><p class="hint">' + esc(p.regle_editeur) + '</p></div>' +
        '<div style="overflow-x:auto"><table class="tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
    }).catch(function (e) { SEC.body.innerHTML = err(e); });
  }

  /* --------------------- dossier complet d'une IMF ------------------ */
  function detail(id) {
    openModal('<h3>Chargement du dossier…</h3>');
    api('/api/v1/teebo/v82/institutions/' + id).then(function (d) { renderDossier(id, d); })
      .catch(function (e) { openModal('<h3>Dossier indisponible</h3><p class="sub">' + esc(e.message) + '</p><div class="modal__nav"><button class="btn btn--primary" id="v82-c">Fermer</button></div>'); $('v82-c').addEventListener('click', close); });
  }
  function renderDossier(id, d) {
    var i = d.imf, r = d.resume || {}, t = d.tenant || {};
    var mods = d.modules.map(function (m) {
      return '<tr><td><b>' + esc(m.nom) + '</b>' + (m.essai ? ' <span class="tag tag--warn">essai' + (m.fin_essai ? ' → ' + dfr(m.fin_essai) : '') + '</span>' : '') + '</td>' +
        '<td>' + fcfa(m.prix_mensuel_fcfa) + '</td>' +
        '<td>'+(m.inclus_essai?'<button class="btn btn--ghost btn--sm" data-trial="'+esc(m.code)+'">Essai</button> ':'')+'<label><input type="checkbox" data-mod="' + esc(m.code) + '"' + (m.actif ? ' checked' : '') + (m.disponible ? '' : ' disabled') + '> ' + (m.actif ? 'Actif' : 'Inactif') + '</label></td></tr>';
    }).join('');
    var facts = d.factures.length ? d.factures.map(function (f) {
      return '<tr><td><code>' + esc(f.numero || '—') + '</code></td><td>' + dfr(f.debut) + '</td><td>' + fcfa(f.total_fcfa) + '</td><td>' + esc(f.statut_libelle) + '</td>' +
        '<td style="white-space:nowrap">' + (f.statut === 'IMPAYEE' && f.id ? '<button class="btn btn--primary btn--sm" data-pay="' + f.id + '" data-source="'+esc(f.source)+'">Encaisser</button> ' : '') +
        (f.id ? '<a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="/api/v1/teebo/v82/'+(f.source==='imf'?'factures-historiques/':'factures/') + f.id + '.pdf">PDF</a>' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="5" style="color:var(--muted)">Aucune facture.</td></tr>';
    var admins = d.admins.length ? d.admins.map(function (a) {
      return '<tr><td>' + esc(a.full_name) + '<br><small style="color:var(--muted)">' + esc(a.email) + '</small></td>' +
        '<td><code>' + esc(a.code_user || '—') + '</code></td><td>' + esc(a.role) + '</td>' +
        '<td>' + (a.is_active ? '<span class="tag tag--ok">Actif</span>' : '<span class="tag tag--danger">Fermé</span>') + '</td>' +
        '<td>' + (a.twofa_enabled ? '<span class="tag tag--ok">2FA</span>' : '<span class="tag tag--muted">2FA non</span>') + '</td>' +
        '<td style="white-space:nowrap"><button class="btn btn--ghost btn--sm" data-toggle="' + a.id + '">' + (a.is_active ? 'Fermer' : 'Ouvrir') + '</button> ' +
        (a.role==='admin_imf'?'<button class="btn btn--ghost btn--sm" data-reinit="' + a.id + '">Réinitialiser l’accès</button>':'')+'</td></tr>';
    }).join('') : '<tr><td colspan="6">Aucun utilisateur.</td></tr>';
    openModal('<h3>' + esc(i.name) + ' ' + tag(r.badge) + '</h3>' +
      '<p class="sub"><code>' + esc(i.code_imf) + '</code> · ' + esc(i.city || '') + ' · ' + esc(i.country_code) + ' · ' + esc(i.type || '') + '</p>' +
      '<div class="chips" style="margin:8px 0 14px"><span class="chip">MRR <b>' + fcfa(r.mrr_fcfa) + '</b></span><span class="chip chip--warn">Impayé <b>' + fcfa(r.total_du_fcfa) + '</b></span><span class="chip">Modules <b>' + r.modules_actifs + '</b></span>' +
      (t.date_expiration_essai ? '<span class="chip">Essai → <b>' + dfr(t.date_expiration_essai) + '</b></span>' : '') + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">' +
      '<button class="btn btn--ghost btn--sm" data-statut="ESSAI_GRATUIT">Mettre en essai</button>' +
      '<button class="btn btn--ghost btn--sm" data-statut="ACTIF">Activer</button>' +
      '<button class="btn btn--ghost btn--sm" data-statut="SUSPENDU_IMPAYE">Suspendre</button>' +
      '<button class="btn btn--ghost btn--sm" data-statut="RESILIE">Résilier</button>' +
      '<button class="btn btn--primary btn--sm" data-facture="1">Émettre la facture du mois</button></div>' +
      '<p class="sub">Licence unique : '+(d.licence?.license_paid?'réglée':'à régler')+'</p><h4>Modules</h4><div style="max-height:190px;overflow:auto"><table class="tbl"><thead><tr><th>Module</th><th>Prix / mois</th><th>État</th></tr></thead><tbody>' + mods + '</tbody></table></div>' +
      '<h4 style="margin-top:16px">Abonnement</h4><p class="sub">' + (d.abonnement ? esc(d.abonnement.periodicite) + ' · ' + fcfa(d.abonnement.montant) + ' · remise ' + esc(d.abonnement.remise_pct) + ' % · statut ' + esc(d.abonnement.statut) : 'Aucun abonnement enregistré') + '</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 4px"><select id="v82-per"><option>MENSUEL</option><option>TRIMESTRIEL</option><option>ANNUEL</option></select><input id="v82-rem" type="number" min="0" max="100" value="' + (d.abonnement ? Number(d.abonnement.remise_pct) || 0 : 0) + '" style="width:90px" aria-label="Remise %"><button class="btn btn--ghost btn--sm" id="v82-abo">Enregistrer l’abonnement</button></div>' +
      '<h4 style="margin-top:16px">Factures</h4><div style="max-height:220px;overflow:auto"><table class="tbl"><thead><tr><th>Numéro</th><th>Période</th><th>Montant</th><th>Statut</th><th></th></tr></thead><tbody>' + facts + '</tbody></table></div>' +
      '<h4>Encaissements</h4><div class="v82-payments">'+(d.paiements.length?d.paiements.map(function(p){return '<p>'+dfr(p.encaisse_le)+' · '+fcfa(p.montant)+' · '+esc(p.mode)+' · '+esc(p.reference||'—')+'</p>';}).join(''):'Aucun encaissement enregistré.')+'</div>'+
      '<h4 style="margin-top:16px">Administrateurs & accès</h4><div style="max-height:220px;overflow:auto"><table class="tbl"><thead><tr><th>Nom</th><th>Code</th><th>Rôle</th><th>État</th><th>2FA</th><th></th></tr></thead><tbody>' + admins + '</tbody></table></div>' +
      '<p class="hint" style="margin-top:10px">' + esc(d.perimetre || '') + '</p>' +
      '<div class="modal__nav"><button class="btn btn--primary" id="v82-c">Fermer</button></div>');
    $('v82-c').addEventListener('click', function () { close(); if (window.__v82Reload) window.__v82Reload(); });
    root.querySelectorAll('[data-trial]').forEach(function(b){b.addEventListener('click',function(){var fin=window.prompt('Fin de l’essai (AAAA-MM-JJ)',new Date(Date.now()+30*86400000).toISOString().slice(0,10));if(!fin)return;b.disabled=true;api('/api/v1/teebo/v82/institutions/'+id+'/modules/'+encodeURIComponent(b.dataset.trial),'POST',{actif:true,essai:true,fin_essai:fin}).then(function(r){notify(r.message,'ok');detail(id);}).catch(function(e){b.disabled=false;notify(e.message,'err');});});});
    if(d.abonnement)$('v82-per').value=d.abonnement.periodicite;
    root.querySelectorAll('[data-mod]').forEach(function (b) {
      b.addEventListener('change', function () {
        var code = b.getAttribute('data-mod');b.disabled=true;
        api('/api/v1/teebo/v82/institutions/' + id + '/modules/' + encodeURIComponent(code), 'POST', { actif: b.checked })
          .then(function (r) { notify(r.message, 'ok'); detail(id); })
          .catch(function (e) { b.disabled=false;b.checked = !b.checked; notify(e.message, 'err'); });
      });
    });
    root.querySelectorAll('[data-statut]').forEach(function (b) {
      b.addEventListener('click', function () {
        var st = b.getAttribute('data-statut');
        if(!window.confirm('Confirmer le changement de statut ?'))return;b.disabled=true;
        api('/api/v1/teebo/v82/institutions/' + id + '/statut', 'POST', { statut: st, essai_jours: 30 })
          .then(function (r) { notify(r.message, 'ok'); detail(id); })
          .catch(function (e) {b.disabled=false; notify(e.message, 'err'); });
      });
    });
    $('v82-abo').addEventListener('click', function () {
      api('/api/v1/teebo/v82/institutions/' + id + '/abonnement', 'POST', { periodicite: $('v82-per').value, remise_pct: Number($('v82-rem').value) || 0 })
        .then(function (r) { notify(r.message, 'ok'); detail(id); }).catch(function (e) { notify(e.message, 'err'); });
    });
    root.querySelector('[data-facture]').addEventListener('click', function () {
      if(!window.confirm('Émettre une facture définitive pour cette période ?'))return;var b=this;b.disabled=true;
      api('/api/v1/teebo/v82/institutions/' + id + '/facture', 'POST', {})
        .then(function (r) { notify(r.message, 'ok'); detail(id); }).catch(function (e) {b.disabled=false; notify(e.message, 'err'); });
    });
    root.querySelectorAll('[data-pay]').forEach(function (b) { b.addEventListener('click', function () { encaisser(b.getAttribute('data-pay'), function () { detail(id); },b.dataset.source); }); });
    root.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.addEventListener('click', function () { api('/api/v1/teebo/users/' + b.getAttribute('data-toggle') + '/toggle', 'POST').then(function () { detail(id); }).catch(function (e) { notify(e.message, 'err'); }); });
    });
    root.querySelectorAll('[data-reinit]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!window.confirm('Réinitialiser l’accès de cet administrateur ? Il devra définir un nouveau mot de passe à la prochaine connexion.')) return;
        api('/api/v1/teebo/v82/institutions/' + id + '/admin/reinit', 'POST', { admin_id: b.getAttribute('data-reinit'), nouveau_code: true })
          .then(function (r) {
            openModal('<h3>Accès réinitialisé</h3><p class="sub">Nouveau code d’accès :</p><div style="font-size:20px;font-weight:700;margin:10px 0"><code>' + esc(r.admin.code_user) + '</code></div><p class="sub">' + esc(r.message) + '</p>' +
              (r.send && r.send.mailto_link ? '<a class="btn btn--ghost btn--sm" href="' + esc(r.send.mailto_link) + '">Envoyer par e-mail</a> ' : '') +
              '<div class="modal__nav"><button class="btn btn--primary" id="v82-c2">Terminé</button></div>');
            $('v82-c2').addEventListener('click', function () { close(); detail(id); });
          }).catch(function (e) { notify(e.message, 'err'); });
      });
    });
  }
  api('/api/v1/auth/me').then(function(d){if(d.user?.role!=='teebo_admin')return;function badge(){api('/api/v1/teebo/v82/demandes-modules').then(function(d){var b=side.querySelector('[data-v82="demandes"]');b.textContent='✉ Demandes de modules'+(d.attente?' ('+d.attente+')':'');}).catch(function(){});}badge();window.setInterval(badge,60000);}).catch(function(){});
  window.TeeboV82 = { detail: detail, catalogue: loadCatalogue, demandes: loadDemandes, factures: loadFactures, securite: loadSecurite };
})();
