const CACHE = "uc-v1";
const LIB_CDN = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    const items = SHELL.concat(["./jsQR.min.js", LIB_CDN]);
    return Promise.allSettled(items.map(function (u) { return c.add(u); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin && req.url !== LIB_CDN) return; // ne touche pas au script Google
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true, ignoreVary: true }).then(function (hit) {
      const refresh = fetch(req).then(function (resp) {
        if (resp && resp.ok) cache.put(req, resp.clone());
        return resp;
      }).catch(function () { return hit; });
      return hit || refresh;
    });
  }));
});
