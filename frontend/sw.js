/* teebo — service worker (installation de l'app + secours hors ligne)
   Regle d'or depuis le correctif du 13/11/2026 : le service worker ne doit
   JAMAIS renvoyer une page HTML (ou une reponse de l'API) a la place d'un
   fichier demande. C'etait la cause d'une boucle de rechargement infinie :
   une reponse mise en cache renvoyee pour une autre URL declenchait de
   nouvelles demandes, et la page « clignotait sans fin ».
   - appels /api/*           : jamais interceptes
   - pages HTML et scripts   : reseau en priorite, cache uniquement en secours
   - echec hors ligne        : erreur 503 explicite (jamais de page de secours)
*/
var CACHE = 'teebo-v25';
var CORE = ['/index.html', '/login.html', '/app.html', '/assets/app-icon-192.png',
            '/assets/app-icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(CORE.map(function (u) {
      return fetch(u, { cache: 'reload' }).then(function (r) {
        if (r && r.ok) return c.put(u, r.clone());
      }).catch(function () {});
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function offline(req) {
  return new Response(JSON.stringify({ error: 'offline', message: 'Serveur injoignable.' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'X-Teebo-Offline': '1' }
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                       // jamais de POST intercepte
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;        // ressources distantes
  if (url.pathname.indexOf('/api/') === 0) return;        // API : jamais de cache
  if (req.headers && req.headers.get('range')) return;    // medias : laisser passer
  var isDoc = req.mode === 'navigate' || /\/(app|login|index|teebo|terrain|essai|documentation|securite|autorisations|demo|404)\.html$/.test(url.pathname) || url.pathname === '/';
  var isAsset = /\/assets\/.*\.(js|css)$/.test(url.pathname) || /\.(png|ico|svg|webmanifest)$/.test(url.pathname);
  if (!isDoc && !isAsset) {
    e.respondWith(fetch(req).catch(function () { return offline(req); }));
    return;
  }
  // Reseau d'abord : la mise a jour d'un deploiement est visible immediatement.
  e.respondWith(fetch(req, { cache: 'no-store' }).then(function (r) {
    if (r && r.ok) {
      var cp = r.clone();
      caches.open(CACHE).then(function (c) { c.put(url.pathname, cp); }).catch(function () {});
    }
    return r;
  }).catch(function () {
    return caches.match(url.pathname).then(function (m) {
      if (m) return m;
      // On ne substitue JAMAIS une autre page : erreur explicite.
      return offline(req);
    });
  }));
});
