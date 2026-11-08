// Offline-only service worker (generated into dist/sw.js by vite.config.ts). It precaches the
// app's own files and serves them when the network is gone. Relay requests (other origins)
// are never touched.

const VERSION = "__VERSION__";
const FILES = __FILES__;
const CACHE = `nectar-phone-${VERSION}`;
const own = () => caches.open(CACHE);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("nectar-phone-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // Network first so a deploy shows up at once; the cached shell when offline.
    event.respondWith(fetch(req).catch(() => own().then((c) => c.match("./", { ignoreSearch: true, ignoreVary: true })).then((r) => r || Response.error())));
    return;
  }
  // Only this version's cache and only this app's path: other Pages sites share the origin (I-149).
  if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  event.respondWith(own().then((c) => c.match(req, { ignoreVary: true })).then((hit) => hit || fetch(req)));
});
