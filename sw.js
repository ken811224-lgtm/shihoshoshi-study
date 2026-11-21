/* 画面の部品を端末にしまう。版を上げたら CACHE も app.js の APP_VERSION と同じ番号にする */
var CACHE = 'sms-v1.1.2';
var FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('sms-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      // 同じ公開先の別アプリの更新で部品が消えても、次に通信できたときにしまい直す
      return fetch(req).then(function (res) {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      }).catch(function () {
        if (req.mode === 'navigate') return c.match('index.html');
        return new Response('', { status: 504 });
      });
    });
  }));
});
