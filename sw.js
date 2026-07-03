const CACHE_NAME = "vocabroguelike-v59-red-brick-no-numbers";
const STATIC_HINTS = [
  "./",
  "./index.html",
  "./styles.css",
  "./game.js",
  "./assets/config/heroes.json",
  "./assets/config/monsters.json",
  "./assets/config/bosses.json",
  "./assets/config/items.json",
  "./assets/config/levels.json",
  "./assets/config/words.json"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_HINTS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.searchParams.has("dev") || url.searchParams.has("nocache")) return;

  if (req.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    event.respondWith(fetch(req).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
      return resp;
    }).catch(() => caches.match(req).then(cached => cached || caches.match("./index.html"))));
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return resp;
      });
    })
  );
});
