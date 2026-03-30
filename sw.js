const CACHE_NAME = "wildu-static-v1";

// ✅ META separata per controllo versione + limiter
const META_CACHE_NAME = "wildu-meta-v1";
const META_KEY = "/__wildu_meta__/state.json";
const VERSION_URL = "/partnerWildu/version.json";

// ⏱️ max 1 check versione ogni 5 minuti
const VERSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ⏱️ dopo cambio versione, per 60s forza i file core a passare da rete
// così non restano appesi a cache HTTP vecchie
const FORCE_RELOAD_WINDOW_MS = 60 * 1000;

// prefisso cache app Wildu, per purge conservativo
const WILDU_CACHE_PREFIX = "wildu-";

// ⚠️ SOLO FILE STATICI SICURI
const STATIC_ASSETS = [
  "/partnerWildu/index.html",
  "/partnerWildu/manifest.json",
  "/partnerWildu/icon-192-white.png",
  "/partnerWildu/icon-512-white.png"
];

// evita check concorrenti multipli nello stesso ciclo di vita del worker
let versionCheckPromise = null;

// =====================================================
// META HELPERS
// =====================================================
async function readMetaState() {
  try {
    const cache = await caches.open(META_CACHE_NAME);
    const res = await cache.match(META_KEY);

    if (!res) {
      return {
        version: null,
        lastCheckAt: 0,
        forceReloadUntil: 0
      };
    }

    const data = await res.json();

    return {
      version: data?.version ?? null,
      lastCheckAt: Number(data?.lastCheckAt || 0),
      forceReloadUntil: Number(data?.forceReloadUntil || 0)
    };
  } catch {
    return {
      version: null,
      lastCheckAt: 0,
      forceReloadUntil: 0
    };
  }
}

async function writeMetaState(state) {
  const cache = await caches.open(META_CACHE_NAME);
  await cache.put(
    META_KEY,
    new Response(JSON.stringify(state), {
      headers: { "Content-Type": "application/json" }
    })
  );
}

function isForceReloadActive(meta) {
  return Number(meta?.forceReloadUntil || 0) > Date.now();
}

async function deleteWilduCaches() {
  const keys = await caches.keys();

  await Promise.all(
    keys.map((key) => {
      if (key.startsWith(WILDU_CACHE_PREFIX)) {
        return caches.delete(key);
      }
    })
  );
}

async function cacheCoreResponse(request, response) {
  const cache = await caches.open(CACHE_NAME);

  await cache.put(request, response.clone());

  // Mantieni anche il fallback canonico dell'index
  if (request.mode === "navigate" || request.destination === "document") {
    await cache.put("/partnerWildu/index.html", response.clone());
  }
}

async function recacheStaticAssetsFresh() {
  const cache = await caches.open(CACHE_NAME);

  for (const assetUrl of STATIC_ASSETS) {
    try {
      const response = await fetch(new Request(assetUrl, { cache: "reload" }));
      if (response && response.ok) {
        await cache.put(assetUrl, response.clone());
      }
    } catch {
      // conservativo: se un asset fallisce, non bloccare tutto
    }
  }
}

async function originalCacheFirst(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);

    if (
      request.destination === "document" ||
      request.destination === "script" ||
      request.destination === "style"
    ) {
      await cacheCoreResponse(request, networkResponse);
    }

    return networkResponse;
  } catch (err) {
    if (request.destination === "document" || request.mode === "navigate") {
      const fallback = await caches.match("/partnerWildu/index.html");
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function forceNetworkReload(request) {
  try {
    const freshResponse = await fetch(new Request(request, { cache: "reload" }));

    if (
      request.destination === "document" ||
      request.destination === "script" ||
      request.destination === "style"
    ) {
      await cacheCoreResponse(request, freshResponse);
    }

    return freshResponse;
  } catch (err) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;

    if (request.destination === "document" || request.mode === "navigate") {
      const fallback = await caches.match("/partnerWildu/index.html");
      if (fallback) return fallback;
    }

    throw err;
  }
}

// =====================================================
// BINARIO VERSIONE SEPARATO
// =====================================================
async function maybeCheckForNewVersion(force = false) {
  if (versionCheckPromise) return versionCheckPromise;

  versionCheckPromise = (async () => {
    const now = Date.now();
    const meta = await readMetaState();

    // limiter persistente: max 1 check ogni 5 minuti
    if (!force && meta.lastCheckAt && (now - meta.lastCheckAt) < VERSION_CHECK_INTERVAL_MS) {
      return {
        checked: false,
        updated: false,
        meta
      };
    }

    try {
      // no-store = check leggero, niente cache HTTP
      const res = await fetch(VERSION_URL, { cache: "no-store" });

      if (!res.ok) {
        const nextMeta = {
          version: meta.version,
          lastCheckAt: now,
          forceReloadUntil: isForceReloadActive(meta) ? meta.forceReloadUntil : 0
        };

        await writeMetaState(nextMeta);

        return {
          checked: true,
          updated: false,
          meta: nextMeta
        };
      }

      const data = await res.json();
      const newVersion = String(data?.version || "").trim() || null;
      const oldVersion = meta.version;

      // prima memorizzazione: nessun purge
      if (!oldVersion) {
        const nextMeta = {
          version: newVersion,
          lastCheckAt: now,
          forceReloadUntil: 0
        };

        await writeMetaState(nextMeta);

        return {
          checked: true,
          updated: false,
          meta: nextMeta
        };
      }

      // ✅ Se cambia versione -> purge totale cache Wildu + finestra forced reload
      if (newVersion && oldVersion !== newVersion) {
        await deleteWilduCaches();
        await recacheStaticAssetsFresh();

        const nextMeta = {
          version: newVersion,
          lastCheckAt: now,
          forceReloadUntil: now + FORCE_RELOAD_WINDOW_MS
        };

        await writeMetaState(nextMeta);

        return {
          checked: true,
          updated: true,
          previousVersion: oldVersion,
          meta: nextMeta
        };
      }

      // nessun aggiornamento
      const nextMeta = {
        version: oldVersion,
        lastCheckAt: now,
        forceReloadUntil: isForceReloadActive(meta) ? meta.forceReloadUntil : 0
      };

      await writeMetaState(nextMeta);

      return {
        checked: true,
        updated: false,
        meta: nextMeta
      };
    } catch {
      const nextMeta = {
        version: meta.version,
        lastCheckAt: now,
        forceReloadUntil: isForceReloadActive(meta) ? meta.forceReloadUntil : 0
      };

      await writeMetaState(nextMeta);

      return {
        checked: true,
        updated: false,
        meta: nextMeta
      };
    }
  })();

  try {
    return await versionCheckPromise;
  } finally {
    versionCheckPromise = null;
  }
}

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
          // conserva il comportamento originale, ma tieni anche la meta cache
          if (key !== CACHE_NAME && key !== META_CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );

  self.clients.claim();
});

// =====================================================
// FETCH (SICURO + DOPPIO BINARIO VERSIONE)
// =====================================================
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 🔴 NON INTERCETTARE API / TOKEN / FIREBASE
  // 🔴 NON INTERCETTARE version.json
  if (
    request.url.includes("googleapis") ||
    request.url.includes("firebase") ||
    request.url.includes("cloudinary") ||
    request.url.includes("script.google.com") ||
    url.pathname === VERSION_URL ||
    request.method !== "GET"
  ) {
    return; // lascia passare senza cache
  }

  const isDocumentRequest =
    request.mode === "navigate" || request.destination === "document";

  const isCoreAsset =
    request.destination === "script" || request.destination === "style";

  // =====================================================
  // BINARIO 1: SOLO HTML / AVVIO / REFRESH VOLONTARIO
  // Check versione separato, con limiter
  // =====================================================
  if (isDocumentRequest) {
    event.respondWith((async () => {
      const versionResult = await maybeCheckForNewVersion(false);
      const meta = versionResult.meta || await readMetaState();

      // se versione cambiata OR siamo nella finestra di forced reload
      // prendi HTML fresco dal server
      if (versionResult.updated || isForceReloadActive(meta)) {
        return forceNetworkReload(request);
      }

      // comportamento originale: CACHE FIRST
      return originalCacheFirst(request);
    })());

    return;
  }

  // =====================================================
  // BINARIO 2: comportamento originale invariato
  // eccetto breve finestra forced reload dopo cambio versione
  // =====================================================
  if (isCoreAsset) {
    event.respondWith((async () => {
      const meta = await readMetaState();

      if (isForceReloadActive(meta)) {
        return forceNetworkReload(request);
      }

      return originalCacheFirst(request);
    })());

    return;
  }

  // =====================================================
  // RESTO INVARIATO: CACHE FIRST
  // =====================================================
  event.respondWith(originalCacheFirst(request));
});
