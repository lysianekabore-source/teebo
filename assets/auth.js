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
  // Origine du site (Netlify, domaine propre) : le serveur s'en sert pour
  // écrire le bon lien de connexion dans les messages envoyés.
  function siteUrl() {
    try { return (window.location && window.location.origin) || ''; } catch (e) { return ''; }
  }
  function post(path, body) {
    return fetch(API + path, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Site-URL': siteUrl() }, body: JSON.stringify(body || {}) })
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
      idle_timeout: 'Session expirée après 60 minutes d’inactivité. Reconnectez-vous.',
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
      missing_token: 'Lien de réinitialisation incomplet. Redemandez un lien.',
      invalid_or_expired_token: 'Ce lien de réinitialisation est invalide ou a expiré. Redemandez-en un nouveau.',
      forbidden: 'Accès non autorisé.'
    };
    return m[code] || 'Une erreur est survenue. Réessayez.';
  }

  // Onglet « Premier accès » : TOUJOURS disponible. L'administrateur de l'IMF
  // doit pouvoir activer son compte avec le code reçu de l'éditeur à tout
  // moment (y compris s'il a déjà ouvert la page de connexion auparavant).
  // On ne masque donc plus jamais cet onglet.

  // Onglets
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active'); hide();
      ['form-login','form-activate','form-change','form-2fa','form-forgot','form-reset'].forEach(function (f) { if ($(f)) $(f).hidden = true; });
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
    return fetch(API + '/api/v1/auth/me', { credentials: 'same-origin',
      headers: { 'X-Site-URL': siteUrl() } })
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
          startEnrollment(d.enrollment_token);
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
      .then(function (d) {
        // Premier accès avec 2FA obligatoire : le mot de passe est créé, on
        // enchaîne immédiatement sur l'enrôlement de la double authentification.
        if (d && d.twofa_enrollment_required) {
          b.disabled = false; b.textContent = old;
          startEnrollment(d.enrollment_token);
          return;
        }
        window.location.assign('/app.html');
      })
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

  // --- Enrôlement 2FA obligatoire (premier accès) ------------------------
  // Flux : login -> ticket d'enrôlement -> /2fa/enroll/start (QR + secret)
  // -> saisie d'un premier code -> /2fa/enroll/confirm (active + session +
  // codes de secours). Aucun script inline ; tout passe par addEventListener.
  var ENROLL_TOKEN = null;

  function hideAllPanes() {
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    ['form-login','form-activate','form-change','form-2fa','form-enroll','form-recovery-list']
      .forEach(function (f) { if ($(f)) $(f).hidden = true; });
  }

  function startEnrollment(token) {
    ENROLL_TOKEN = token || null;
    if (!ENROLL_TOKEN) { show(msgFr('missing_challenge'), false); return; }
    post('/api/v1/auth/2fa/enroll/start', { enrollment_token: ENROLL_TOKEN })
      .then(function (d) {
        hideAllPanes();
        if ($('enroll-qr') && d.qr_data_url) $('enroll-qr').src = d.qr_data_url;
        if ($('enroll-secret')) $('enroll-secret').value = d.secret || '';
        if ($('form-enroll')) $('form-enroll').hidden = false;
        show('Scannez le QR puis saisissez le code à 6 chiffres pour activer la double authentification.', false);
        try { $('enroll-otp').focus(); } catch (e) {}
      })
      .catch(function (err) { show(enrollMsg(err.message), false); });
  }

  function enrollMsg(code) {
    var m = {
      missing_enrollment: 'Session d’enrôlement expirée. Reconnectez-vous.',
      invalid_enrollment: 'Session d’enrôlement invalide. Reconnectez-vous.',
      enrollment_used: 'Cet enrôlement a déjà été utilisé. Reconnectez-vous.',
      enrollment_expired: 'Le délai d’enrôlement a expiré. Reconnectez-vous.',
      no_enrollment: 'Aucun enrôlement en cours. Reconnectez-vous.',
      invalid_code: 'Code invalide. Vérifiez l’heure de votre téléphone et réessayez.'
    };
    return m[code] || msgFr(code);
  }

  if ($('form-enroll')) {
    $('form-enroll').addEventListener('submit', function (e) {
      e.preventDefault(); hide();
      var code = ($('enroll-otp').value || '').replace(/\D/g, '');
      if (code.length !== 6) { show('Le code doit comporter 6 chiffres.', false); return; }
      var b = e.target.querySelector('button[type=submit]'); b.disabled = true; var old = b.textContent; b.textContent = 'Activation…';
      post('/api/v1/auth/2fa/enroll/confirm', { enrollment_token: ENROLL_TOKEN, code: code })
        .then(function (d) {
          hideAllPanes();
          var ul = $('recovery-codes');
          if (ul) {
            ul.textContent = '';
            (d.recovery_codes || []).forEach(function (c) {
              var li = document.createElement('li');
              li.textContent = c;
              ul.appendChild(li);
            });
          }
          if ($('form-recovery-list')) $('form-recovery-list').hidden = false;
          show('Double authentification activée. Notez vos codes de secours.', true);
        })
        .catch(function (err) { b.disabled = false; b.textContent = old; show(enrollMsg(err.message), false); });
    });
  }

  if ($('btn-enroll-done')) {
    $('btn-enroll-done').addEventListener('click', function () { routeAfterLogin(); });
  }

  // --- Mot de passe oublié / réinitialisation -----------------------------
  var RESET_TOKEN = null;

  function showOnlyPane(id, keepTabs) {
    if (!keepTabs) document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    ['form-login','form-activate','form-change','form-2fa','form-enroll','form-recovery-list','form-forgot','form-reset']
      .forEach(function (f) { if ($(f)) $(f).hidden = (f !== id); });
  }
  function backToLogin() {
    hide();
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    var lt = document.querySelector('.tab[data-tab="login"]'); if (lt) lt.classList.add('active');
    showOnlyPane('form-login', true);
    // Nettoie l'éventuel paramètre ?reset= de l'URL.
    try { if (window.history && window.history.replaceState) window.history.replaceState(null, '', window.location.pathname); } catch (e) {}
  }

  var lf = $('link-forgot');
  if (lf) lf.addEventListener('click', function (e) {
    e.preventDefault(); hide();
    if ($('forgot-links')) { $('forgot-links').hidden = true; $('forgot-links').textContent = ''; }
    showOnlyPane('form-forgot');
    try { $('forgot-id').focus(); } catch (err) {}
  });
  if ($('btn-forgot-back')) $('btn-forgot-back').addEventListener('click', backToLogin);
  if ($('btn-reset-back')) $('btn-reset-back').addEventListener('click', backToLogin);

  if ($('form-forgot')) $('form-forgot').addEventListener('submit', function (e) {
    e.preventDefault(); hide();
    var id = ($('forgot-id').value || '').trim();
    if (!id) { show('Saisissez votre identifiant ou votre e-mail.', false); return; }
    var b = e.target.querySelector('button[type=submit]'); b.disabled = true; var old = b.textContent; b.textContent = 'Envoi…';
    post('/api/v1/auth/forgot-password', { identifier: id })
      .then(function (d) {
        b.disabled = false; b.textContent = old;
        show((d && d.message) || 'Si un compte correspond, un lien vient d’être envoyé.', true);
        // Mode dégradé (aucune passerelle automatique) : on affiche les liens
        // « prêts à envoyer » pour permettre la réinitialisation manuelle.
        var wrap = $('forgot-links');
        if (wrap && d && d.dev_links && d.dev_links.length) {
          wrap.textContent = '';
          var p = document.createElement('p'); p.className = 'req';
          p.textContent = 'Aucune passerelle automatique n’est configurée. Utilisez le(s) lien(s) ci-dessous pour transmettre la réinitialisation :';
          wrap.appendChild(p);
          d.dev_links.forEach(function (l) {
            var a = document.createElement('a');
            a.href = l.lien; a.textContent = (l.canal === 'whatsapp' ? 'Envoyer par WhatsApp' : 'Envoyer par e-mail');
            a.style.display = 'block'; a.style.marginTop = '6px'; a.target = '_blank'; a.rel = 'noopener';
            wrap.appendChild(a);
          });
          wrap.hidden = false;
        }
      })
      .catch(function (err) { b.disabled = false; b.textContent = old; show(msgFr(err.message), false); });
  });

  if ($('form-reset')) $('form-reset').addEventListener('submit', function (e) {
    e.preventDefault(); hide();
    if ($('reset-new').value !== $('reset-confirm').value) { show('Les mots de passe ne correspondent pas.', false); return; }
    if (!RESET_TOKEN) { show(msgFr('missing_token'), false); return; }
    var b = e.target.querySelector('button[type=submit]'); b.disabled = true; var old = b.textContent; b.textContent = 'Réinitialisation…';
    post('/api/v1/auth/reset-password', { token: RESET_TOKEN, new_password: $('reset-new').value })
      .then(function (d) {
        RESET_TOKEN = null;
        backToLogin();
        show((d && d.message) || 'Mot de passe réinitialisé. Connectez-vous avec votre nouveau mot de passe.', true);
      })
      .catch(function (err) { b.disabled = false; b.textContent = old; show(msgFr(err.message), false); });
  });

  // Arrivée depuis le lien reçu (…/login.html?reset=TOKEN) : on ouvre
  // directement l'écran de choix d'un nouveau mot de passe.
  (function initResetFromUrl() {
    var m = /[?&]reset=([^&]+)/.exec(window.location.search || '');
    if (!m) return;
    try { RESET_TOKEN = decodeURIComponent(m[1]); } catch (e) { RESET_TOKEN = m[1]; }
    if (!RESET_TOKEN) return;
    showOnlyPane('form-reset');
    show('Choisissez votre nouveau mot de passe.', true);
    try { $('reset-new').focus(); } catch (e) {}
  })();

})();
