/* Offline-first service worker: the site, the rule engine and the data stay
   available without a connection, so emergency screening always works. */
const CACHE = "ruralpulse-v3.1.2";
const SHELL = [
  "./", "./index.html", "./manifest.webmanifest", "./assets/css/styles.css",
  "./assets/js/engine.js", "./assets/js/app.js", "./assets/js/scene.js", "./assets/js/geo.js", "./assets/js/where.js",
  "./assets/js/voice.js", "./assets/js/settings.js", "./assets/js/slip.js", "./assets/vendor/leaflet/leaflet.js", "./assets/vendor/leaflet/leaflet.css",
  "./data/i18n.json", "./data/first_aid.json", "./data/prep.json", "./data/doctors.json",
  "./assets/vendor/three.min.js", "./assets/vendor/three-postfx.js", "./assets/img/icon.svg",
  "./data/protocol.json", "./data/facilities.json", "./data/eval/vignettes.json"
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return; // API, map tiles and other sites go straight to the network
  if (url.pathname.endsWith(".json")) { // data: network first, cache fallback
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
    return;
  }
  // stale-while-revalidate: instant from cache, refreshed in the background so updates show on the next load
  e.respondWith(caches.match(e.request).then((hit) => {
    const net = fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
