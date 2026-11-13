/* teebo — service worker (installation de l'app + cache du socle) */
var CACHE = 'teebo-v24';
var CORE = ['/', '/index.html', '/login.html', '/app.html', '/teebo.html', '/assets/app-icon-192.png', '/assets/app-icon-512.png', '/manifest.webmanifest'];
self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(CORE).catch(function () {}); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return k === CACHE ? null : caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;           // laisser passer les ressources distantes
  if (url.pathname.indexOf('/api/') === 0) return;      // jamais de cache sur l'API
  // Le socle HTML/JS est TOUJOURS pris sur le réseau en priorité (mise à jour
  // immédiate après un déploiement) ; le cache ne sert qu'en cas de coupure.
  var NET_FIRST = /\/(app|login|index|teebo|essai)\.html$|\/assets\/.*\.(js|css)$/.test(url.pathname) || url.pathname === '/' ;
  if (NET_FIRST) {
    e.respondWith(fetch(req).then(function (r) {
      var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); return r;
    }).catch(function () { return caches.match(req).then(function (m) { return m || caches.match('/index.html'); }); }));
    return;
  }
  e.respondWith(
    fetch(req).then(function (r) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); return r; })
      .catch(function () { return caches.match(req).then(function (m) { return m || caches.match('/index.html'); }); })
  );
});
