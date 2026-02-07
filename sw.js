/* HH_BUILD: 2025-12-14_01 */

const CACHE_NAME = "hanghordo-v4"; // <-- verziót növeld minden deploynál
const ASSETS = [
  "/",                  
  "/index.html",
  "/style.css",
  "/app.js",
  "/splash.png",
  "/manifest.webmanifest"
  "hh_patch.js"
  "hh_patch.css"
];

self.addEventListener("install", (event) => {
  self.skipWaiting(); // <-- új SW azonnal lépjen életbe
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim(); // <-- azonnal vegye át a kontrollt
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Csak GET-et cache-elünk (POST/PUT stb. maradjon hálózaton)
  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          // Csak sikeres válaszokat tegyünk cache-be
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })
  );
});


