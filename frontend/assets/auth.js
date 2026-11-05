/* teebo — authentification : connexion, activation (1er accès),
   changement de mot de passe (expiration 60 j). */
(function () {
  'use strict';
  var API = ''; // même origine
  var $ = function (id) { return document.getElementById(id); };

  function show(msg, ok) {
    var a = $('alert');
    a.textContent = msg;
    a.className = 'alert ' + (ok ? 'alert--ok' : 'alert--err');
    a.hidden = false;
  }
  function hide() { $('alert').hidden = true; }
  function post(path, body) {
    return fetch(API + path, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function(){return{};}).then(function (d) { if (!r.ok) throw new Error(d.error || 'error'); return d; }); });
  }
  function msgFr(code) {
    var m = {
      invalid_credentials: 'Identifiant ou mot de passe incorrect.',
      code_not_found: 'Code d’accès introuvable.',
      already_activated: 'Ce code a déjà été activé. Utilisez l’onglet Connexion.',
      weak_password: 'Mot de passe trop faible (10 caractères min., majuscule, minuscule, chiffre).',
      missing_fields: 'Veuillez remplir tous les champs.',
      invalid_current_password: 'Mot de passe actuel incorrect.',
      idle_timeout: 'Session expirée après 30 minutes d’inactivité. Reconnectez-vous.',
      twofa_required: 'Double authentification obligatoire : activez-la dans votre espace. Contactez votre administrateur si besoin.',
      session_expired: 'Votre session a expiré. Reconnectez-vous.',
      password_change_required: 'Vous devez changer votre mot de passe.',
      invalid_code: 'Code invalide. Réessayez.',
      invalid_challenge: 'Session de vérification expirée. Reconnectez-vous.',
      challenge_expired: 'Le délai de saisie du code a expiré. Reconnectez-vous.',
      missing_challenge: 'Vérification impossible. Reconnectez-vous.',
      locked: 'Trop de tentatives. Réessayez dans quelques minutes.',
      user_disabled: 'Ce compte est désactivé.',
      email_not_registered: 'Cet e-mail n’est pas enregistré. Contactez votre administrateur.',
      forbidden: 'Accès non autorisé.'
    };
    return m[code] || 'Une erreur est survenue. Réessayez.';
  }

  // Onglet « Premier accès » : visible au 1er accès seulement.
  // Dès la 2e connexion sur cet appareil, on ne garde que « Connexion ».
  (function () {
    var SEEN = 'teebo_seen';
    var seen = false;
    try { seen = !!localStorage.getItem(SEEN); } catch (e) {}
    var activate = document.querySelector('.tab[data-tab="activate"]');
    if (seen && activate) {
      activate.parentNode.removeChild(activate);
      var f = document.getElementById('form-activate');
      if (f) f.parentNode.removeChild(f);
      var l = document.querySelector('.tab[data-tab="login"]');
      if (l) l.classList.add('active');
    } else {
      try { localStorage.setItem(SEEN, '1'); } catch (e) {}
    }
  })();

  // Onglets
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active'); hide();
      ['form-login','form-activate','form-change','form-2fa'].forEach(function (f) { if ($(f)) $(f).hidden = true; });
      var map = { login: 'form-login', activate: 'form-activate', 'change': 'form-change' };
      var target = $(map[t.dataset.tab]);
      if (target) target.hidden = false;
    });
  });

  // Afficher/masquer mot de passe
  document.querySelectorAll('.toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var inp = $(btn.dataset.toggle);
      var show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Masquer' : 'Afficher';
    });
  });

  function showChangePane() {
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    ['form-login','form-activate','form-2fa'].forEach(function (f) { if ($(f)) $(f).hidden = true; });
    $('form-change').hidden = false;
    show('Vous devez définir un nouveau mot de passe (expiration après 60 jours).', false);
  }

  // --- Double authentification : étape de saisie du code ------------------
  var CHALLENGE = null;
  function showTwofaPane(challenge) {
    CHALLENGE = challenge;
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    ['form-login','form-activate','form-change'].forEach(function (f) { if ($(f)) $(f).hidden = true; });
    $('form-2fa').hidden = false;
    show('Double authentification : saisissez le code à 6 chiffres de votre application.', false);
    try { $('otp').focus(); } catch (e) {}
  }
  function submitTwofa(body, btn, oldLabel) {
    post('/api/v1/auth/2fa/verify', body)
      .then(function () { return routeAfterLogin(); })
      .catch(function (err) {
        if (err && err.challenge) CHALLENGE = err.challenge;
        btn.disabled = false; btn.textContent = oldLabel;
        show(msgFr(err.message) , false);
      });
  }

  function routeAfterLogin() {
    return fetch(API + '/api/v1/auth/me', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var role = d && d.user && d.user.role;
        window.location.assign(role === 'teebo_admin' ? '/teebo.html' : '/app.html');
      })
      .catch(function () { window.location.assign('/app.html'); });
  }

  // --- Connexion ---
  $('form-login').addEventListener('submit', function (e) {
    e.preventDefault(); hide();
    var b = e.target.querySelector('button[type=submit]'); b.disabled = true; var old = b.textContent; b.textContent = 'Connexion…';
    post('/api/v1/auth/login', { identifier: $('identifier').value.trim(), password: $('password').value })
      .then(function (d) {
        if (d.twofa_required) { b.disabled = false; b.textContent = old; showTwofaPane(d.challenge); return; }
        if (d.twofa_enrollment_required) {
          b.disabled = false; b.textContent = old;
          try { sessionStorage.setItem('teebo_2fa_enroll', '1'); } catch (e) {}
          show('La double authentification est obligatoire. Vous allez activer votre compte.', false);
          setTimeout(function () { window.location.assign('/login.html'); }, 400);
          return;
        }
        if (d.password_change_required) { b.disabled = false; b.textContent = old; showChangePane(); return; }
        return routeAfterLogin();
      })
      .catch(function (err) { b.disabled = false; b.textContent = old; show(msgFr(err.message), false); });
  });

  // --- Activation (premier accès) ---
  if ($('form-activate')) $('form-activate').addEventListener('submit', function (e) {
    e.preventDefault(); hide();
    if ($('new_password').value !== $('confirm').value) { show('Les mots de passe ne correspondent pas.', false); return; }
    var b = e.target.querySelector('button[type=submit]'); b.disabled = true; var old = b.textContent; b.textContent = 'Activation…';
    post('/api/v1/auth/activate', { code: $('code').value.trim(), password: $('new_password').value })
      .then(function () { window.location.assign('/app.html'); })
      .catch(function (err) { b.disabled = false; b.textContent = old; show(msgFr(err.message), false); });
  });

  // --- Changement de mot de passe ---
  $('form-change').addEventListener('submit', function (e) {
    e.preventDefault(); hide();
    var b = e.target.querySelector('button[type=submit]'); b.disabled = true; var old = b.textContent; b.textContent = 'Mise à jour…';
    post('/api/v1/auth/change-password', { current: $('cur').value, new_password: $('np').value })
      .then(function () { show('Mot de passe mis à jour.', true); setTimeout(function(){ routeAfterLogin(); }, 700); })
      .catch(function (err) { b.disabled = false; b.textContent = old; show(msgFr(err.message), false); });
  });

  // --- Validation du code 2FA (application d'authentification) ---
  if ($('form-2fa')) {
    $('form-2fa').addEventListener('submit', function (e) {
      e.preventDefault(); hide();
      var code = ($('otp').value || '').replace(/\D/g, '');
      if (code.length !== 6) { show('Le code doit comporter 6 chiffres.', false); return; }
      var b = e.target.querySelector('button[type=submit]'); b.disabled = true; var old = b.textContent; b.textContent = 'Vérification…';
      submitTwofa({ challenge: CHALLENGE, code: code }, b, old);
    });
    var rb = $('btn-recovery');
    if (rb) rb.addEventListener('click', function () { $('recovery-wrap').hidden = !$('recovery-wrap').hidden; });
    var rg = $('btn-recovery-go');
    if (rg) rg.addEventListener('click', function () {
      var rc = ($('recovery').value || '').trim();
      if (!rc) { show('Saisissez un code de secours.', false); return; }
      var b = this; b.disabled = true; var old = b.textContent; b.textContent = 'Vérification…';
      submitTwofa({ challenge: CHALLENGE, recovery_code: rc }, b, old);
    });
  }

})();
