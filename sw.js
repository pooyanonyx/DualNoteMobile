// NoteFlow service worker: makes the app work offline after the first visit.
// Bump CACHE when you change files so devices pick up the new version.
const CACHE = "noteflow-v17";

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const list = await (await fetch("precache.json", { cache: "reload" })).json();
    await cache.addAll(list.map((u) => new Request(u, { cache: "reload" })));         // always the files on the server, never an older browser-cached copy
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  const heavy = url.pathname.includes("/lib/") || url.pathname.includes("/icons/");
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (heavy && hit) return hit;                                   // libraries never change: cache first
    try {                                                           // app files: network first, so updates arrive
      const res = await fetch(req, { cache: "no-cache" });                   // ask the server if the file changed (a stale browser-cached copy is never used)
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (hit) return hit;
      if (req.mode === "navigate") { const idx = (await cache.match("index.html")) || (await cache.match("./")); if (idx) return idx; }
      throw err;
    }
  })());
});
