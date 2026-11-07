/* teebo — service worker (installation de l'app + cache du socle) */
var CACHE = 'teebo-v3';
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
  if (url.origin !== location.origin) return;           // laisser passer l'API distante
  if (url.pathname.indexOf('/api/') === 0) return;      // jamais de cache sur l'API
  e.respondWith(
    fetch(req).then(function (r) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); return r; })
      .catch(function () { return caches.match(req).then(function (m) { return m || caches.match('/index.html'); }); })
  );
});
