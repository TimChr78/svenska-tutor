// svenska-tutor service worker: cache the app shell for PWA install.
const CACHE = "svenska-tutor-v1";
const SHELL = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  // never cache API or WS traffic
  if (url.pathname.startsWith("/api/")) return;
  ev.respondWith(
    fetch(ev.request)
      .then((resp) => {
        const copy = resp.clone();
        void caches.open(CACHE).then((c) => c.put(ev.request, copy));
        return resp;
      })
      .catch(() => caches.match(ev.request).then((hit) => hit ?? Response.error())),
  );
});
