// =========================================================================
// teebo — Console administrateur : restriction collecte seule (vague 36)
// -------------------------------------------------------------------------
// Page de pilotage REELLE des routes d'administration. Aucun script inline
// (le serveur n'autorise que 'self'), texte injecte en texte, jamais en HTML.
// =========================================================================
(function () {
  'use strict';

  var CLE_API = 'teebo_console_api';
  var CLE_JETON = 'teebo_console_jeton';

  function $(id) { return document.getElementById(id); }

  /** Adresse du serveur : saisie, sinon celle qui a servi la page. */
  function baseApi() {
    var v = ($('api').value || '').trim().replace(/\/+$/, '');
    if (v) return v;
    return location.origin;
  }

  function jeton() {
    try { return localStorage.getItem(CLE_JETON) || ''; } catch (e) { return ''; }
  }

  function message(cible, texte, type) {
    var el = $(cible);
    el.className = 'alerte' + (type ? ' ' + type : '');
    el.textContent = texte;
    el.classList.remove('cache');
  }

  function masquer(cible) { $(cible).classList.add('cache'); }

  function journal(texte) {
    var li = document.createElement('li');
    var d = new Date();
    li.textContent = d.toLocaleString('fr-FR') + ' — ' + texte;
    $('journal').insertBefore(li, $('journal').firstChild);
  }

  /** Appel authentifie ; renvoie { ok, statut, corps }. */
  function appeler(methode, chemin, corps) {
    var entetes = { 'Content-Type': 'application/json' };
    var j = jeton();
    if (j) entetes.Authorization = 'Bearer ' + j;
    return fetch(baseApi() + chemin, {
      method: methode,
      headers: entetes,
      credentials: 'include',
      body: corps ? JSON.stringify(corps) : undefined
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = JSON.parse(txt); } catch (e) { data = { message: txt }; }
        return { ok: r.ok, statut: r.status, corps: data };
      });
    });
  }

  function erreurLisible(rep) {
    var c = rep.corps || {};
    if (rep.statut === 401) return 'Connexion requise ou session expirée.';
    if (rep.statut === 403) return c.message || 'Action réservée à l’administrateur teebo.';
    if (rep.statut === 404) return 'Institution introuvable.';
    if (rep.statut === 409) return c.message || 'Migration à exécuter sur la base.';
    return c.message || c.error || ('Erreur ' + rep.statut);
  }

  function afficherEtat(etat) {
    var tb = $('tab-etat').querySelector('tbody');
    tb.textContent = '';
    var mods = etat.modules || {};
    Object.keys(mods).forEach(function (k) {
      var m = mods[k];
      var tr = document.createElement('tr');
      var t1 = document.createElement('td');
      t1.textContent = m.label || k;
      var t2 = document.createElement('td');
      var e = document.createElement('span');
      e.className = 'etq ' + (m.active ? 'e-vert' : 'e-rouge');
      e.textContent = m.active ? 'Accessible' : 'Coupé (403)';
      t2.appendChild(e);
      var t3 = document.createElement('td');
      t3.className = 'mono';
      t3.textContent = m.active ? (etat.restreinte_collecte_seule && k === 'MODULE_COLLECTE_TONTINE'
        ? 'essai' : '') : 'restriction / non souscrit';
      tr.appendChild(t1); tr.appendChild(t2); tr.appendChild(t3);
      tb.appendChild(tr);
    });
    $('tab-etat').classList.remove('cache');
  }

  /* ------------------------------ Connexion ----------------------------- */
  $('bt-connexion').addEventListener('click', function () {
    var email = ($('email').value || '').trim();
    var mdp = $('mdp').value || '';
    if (!email || !mdp) { message('msg-session', 'Renseignez l’e-mail et le mot de passe.', 'rouge'); return; }
    try { localStorage.setItem(CLE_API, baseApi()); } catch (e) {}
    appeler('POST', '/api/v1/auth/login', { email: email, password: mdp })
      .then(function (rep) {
        if (!rep.ok) { message('msg-session', erreurLisible(rep), 'rouge'); return; }
        var c = rep.corps || {};
        var j = c.token || c.access_token || (c.session && c.session.token) || '';
        if (j) { try { localStorage.setItem(CLE_JETON, j); } catch (e) {} }
        $('etat-session').textContent = 'connecté : ' + (email);
        $('bt-deconnexion').classList.remove('cache');
        message('msg-session', 'Connexion réussie. Vous pouvez agir sur une institution.', 'vert');
        journal('Connexion de ' + email);
      })
      .catch(function () {
        message('msg-session', 'Serveur injoignable : vérifiez l’adresse saisie.', 'rouge');
      });
  });

  $('bt-deconnexion').addEventListener('click', function () {
    try { localStorage.removeItem(CLE_JETON); } catch (e) {}
    $('etat-session').textContent = 'non connecté';
    $('bt-deconnexion').classList.add('cache');
    message('msg-session', 'Déconnecté.', '');
    journal('Déconnexion');
  });

  /* ------------------------------ État ---------------------------------- */
  $('bt-etat').addEventListener('click', function () {
    var id = ($('imf').value || '').trim();
    if (!id) { message('msg-action', 'Indiquez l’identifiant de l’institution.', 'rouge'); return; }
    appeler('GET', '/api/v1/admin/institutions/' + encodeURIComponent(id) + '/access-state')
      .then(function (rep) {
        if (!rep.ok) { message('msg-action', erreurLisible(rep), 'rouge'); return; }
        var c = rep.corps || {};
        afficherEtat({ modules: c.modules, restreinte_collecte_seule: c.restreinte_collecte_seule });
        message('msg-action', c.restreinte_collecte_seule
          ? 'Cette IMF est actuellement restreinte à la collecte.'
          : 'Cette IMF dispose de ses modules souscrits.', 'vert');
        journal('État lu pour ' + id);
      })
      .catch(function () { message('msg-action', 'Serveur injoignable.', 'rouge'); });
  });

  /* --------------------------- Restreindre ------------------------------ */
  $('bt-restreindre').addEventListener('click', function () {
    var id = ($('imf').value || '').trim();
    if (!id) { message('msg-action', 'Indiquez l’identifiant de l’institution.', 'rouge'); return; }
    var confirme = window.confirm('Couper tous les modules sauf la Collecte & tontines pour cette IMF ?');
    if (!confirme) return;
    $('bt-restreindre').disabled = true;
    appeler('POST', '/api/v1/admin/institutions/' + encodeURIComponent(id) + '/restrict-to-collecte',
      { reason: ($('raison').value || '').trim() || null })
      .then(function (rep) {
        $('bt-restreindre').disabled = false;
        if (!rep.ok) { message('msg-action', erreurLisible(rep), 'rouge'); return; }
        var c = rep.corps || {};
        var ctrl = c.controle_middleware || {};
        var txt = 'Restriction appliquée.';
        if (c.modules_coupes != null) txt += ' Modules coupés : ' + c.modules_coupes + '.';
        if (ctrl.refuserait) txt += '\nContrôle : le module Dossiers de crédit est bien refusé (403).';
        message('msg-action', txt, 'vert');
        if (c.configuration_ui) {
          afficherEtat({ modules: c.configuration_ui.modules, restreinte_collecte_seule: true });
        }
        journal('Restriction collecte seule appliquée à ' + id);
      })
      .catch(function () {
        $('bt-restreindre').disabled = false;
        message('msg-action', 'Serveur injoignable.', 'rouge');
      });
  });

  /* ----------------------------- Lever ---------------------------------- */
  $('bt-lever').addEventListener('click', function () {
    var id = ($('imf').value || '').trim();
    if (!id) { message('msg-action', 'Indiquez l’identifiant de l’institution.', 'rouge'); return; }
    if (!window.confirm('Rendre à cette IMF ses modules réellement souscrits ?')) return;
    appeler('POST', '/api/v1/admin/institutions/' + encodeURIComponent(id) + '/lift-restriction',
      { reason: ($('raison').value || '').trim() || null })
      .then(function (rep) {
        if (!rep.ok) { message('msg-action', erreurLisible(rep), 'rouge'); return; }
        message('msg-action', 'Restriction levée : les menus sont recalculés d’après les abonnements.', 'vert');
        var cu = (rep.corps || {}).configuration_ui;
        if (cu) afficherEtat({ modules: cu.modules, restreinte_collecte_seule: false });
        journal('Restriction levée pour ' + id);
      })
      .catch(function () { message('msg-action', 'Serveur injoignable.', 'rouge'); });
  });

  /* ---------------------------- Reprise --------------------------------- */
  try {
    var a = localStorage.getItem(CLE_API);
    if (a) $('api').value = a;
    if (jeton()) {
      $('etat-session').textContent = 'session enregistrée';
      $('bt-deconnexion').classList.remove('cache');
    }
  } catch (e) { /* stockage indisponible : mode saisie simple */ }
})();
