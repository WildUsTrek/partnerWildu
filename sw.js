const CACHE_NAME = "wildu-static-v1";

// ⚠️ SOLO FILE STATICI SICURI
const STATIC_ASSETS = [
  "/partnerWildu/index.html",
  "/partnerWildu/manifest.json",
  "/partnerWildu/icon-192-white.png",
  "/partnerWildu/icon-512-white.png"
];

// =====================================================
// INSTALL
// =====================================================
self.addEventListener("install", (event) => {
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

// =====================================================
// ACTIVATE
// =====================================================
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );

  self.clients.claim();
});

// =====================================================
// FETCH (SICURO)
// =====================================================
self.addEventListener("fetch", (event) => {
  const request = event.request;

  // 🔴 NON INTERCETTARE API / TOKEN / FIREBASE
  if (
    request.url.includes("googleapis") ||
    request.url.includes("firebase") ||
    request.url.includes("cloudinary") ||
    request.url.includes("script.google.com") ||
    request.method !== "GET"
  ) {
    return; // lascia passare senza cache
  }

  // 🟢 SOLO FILE STATICI
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request)
        .then((networkResponse) => {
          // NON salvare tutto, solo risorse base
          if (
            request.destination === "document" ||
            request.destination === "script" ||
            request.destination === "style"
          ) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }

          return networkResponse;
        })
        .catch(() => {
          // fallback offline (solo pagina base)
          if (request.destination === "document") {
            return caches.match("/partnerWildu/index.html");
          }
        });
    })
  );
});
