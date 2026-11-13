/* teebo — maintien de session : un utilisateur ACTIF n'est jamais deconnecte.
   L'onglet ouvert (et visible) envoie une balise d'activite au serveur toutes
   les 10 minutes, ainsi qu'a chaque retour sur l'onglet ou reprise de la
   connexion. Le serveur repousse alors l'echeance d'inactivite (60 minutes).

   GARDE-FOUS (correctif du 13/11/2026 — « la page clignote sans fin ») :
   - Aucun appel sur les pages publiques : login.html, index.html, essai.html,
     documentation.html, securite.html, autorisations.html, demo.html.
     Avant, login.html appelait keepalive au chargement ; sans session le
     serveur repondait 401 et la page se rechargEAIT vers /login.html?expired=1
     -> boucle de rechargement infinie (clignotement).
   - Un seul rechargement au maximum, jamais sur la page de connexion.
   - Apres 3 refus consecutifs, on arrete les pings (plus de trafic inutile).
*/
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.fetch) return;
  var path = '';
  try { path = String(window.location.pathname || '/').toLowerCase(); } catch (e) { path = '/'; }
  var page = path.split('/').pop();
  // Seules les pages de l'espace connecte declenchent le maintien de session.
  if (!/^(app|terrain|teebo)\.html$/.test(page)) return;
  var INTERVAL_MS = 10 * 60 * 1000;   /* 10 minutes */
  var lastPing = 0;
  var busy = false;
  var fails = 0;
  function siteUrl() { try { return (window.location && window.location.origin) || ''; } catch (e) { return ''; } }
  function ping() {
    if (busy || fails >= 3 || document.visibilityState === 'hidden') return;
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
      if (r.status === 401 || r.status === 403) {
        fails++;
        // Session reellement terminee : on le dit UNE seule fois, et jamais
        // en boucle. La deconnexion est pilotee par l'application elle-meme
        // (app.js) lors de ses propres appels.
        if (fails === 1) { try { window.dispatchEvent(new Event('teebo:session-ended')); } catch (e) {} }
      } else { fails = 0; }
    }).catch(function () { busy = false; fails++; });
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
