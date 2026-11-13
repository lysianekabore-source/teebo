/* teebo — maintien de session : un utilisateur ACTIF n'est jamais deconnecte.
   L'onglet ouvert (et visible) envoie une balise d'activite au serveur toutes
   les 10 minutes, ainsi qu'a chaque retour sur l'onglet ou reprise de la
   connexion. Le serveur repousse alors l'echeance d'inactivite (60 minutes). */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.fetch) return;
  var INTERVAL_MS = 10 * 60 * 1000;   /* 10 minutes */
  var lastPing = 0;
  var busy = false;
  function siteUrl() { try { return (window.location && window.location.origin) || ''; } catch (e) { return ''; } }
  function ping() {
    if (busy || document.visibilityState === 'hidden') return;
    busy = true;
    lastPing = Date.now();
    fetch('/api/v1/auth/keepalive', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
        'X-Site-URL': siteUrl(), 'X-Teebo-Keepalive': '1' },
      body: '{}'
    }).then(function (r) {
      busy = false;
      /* Session reellement terminee cote serveur : on le dit clairement. */
      if (r.status === 401) { window.location.assign('/login.html?expired=1'); }
    }).catch(function () { busy = false; });
  }
  setInterval(ping, INTERVAL_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - lastPing > 60 * 1000) ping();
  });
  window.addEventListener('focus', function () {
    if (Date.now() - lastPing > 60 * 1000) ping();
  });
  var lastInput = 0;
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      if (Date.now() - lastInput < 60 * 1000) return;
      lastInput = Date.now();
      if (Date.now() - lastPing > 4 * 60 * 1000) ping();
    }, { passive: true });
  });
  ping();
})();
