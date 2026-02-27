
/* sw.js — Gym Dashboard (version.json + versioned cache)
   Goals:
   - Network-first for navigations so users get newest index.html immediately when online
   - Offline fallback via cached shell
   - Cache name derived from version.json when available, so cache cleanup is deterministic
   - Controlled updates: UI triggers SKIP_WAITING, then controllerchange reloads
*/

const CACHE_PREFIX = "gymdash-shell-";
let CACHE_NAME = `${CACHE_PREFIX}v1`; // fallback until we can read version.json
const APP_SHELL = [
  "./",
  "./index.html",
  "./assets/css/app.css",
  "./assets/js/app.js",
  "./assets/js/app.entry.js",
  "./assets/js/legacy/app.legacy.js",
  "./assets/js/modals/protein.modal.js",
  "./assets/js/modals/logsets.modal.js",
  "./assets/js/modals/exercise-addedit.modal.js",
  "./manifest.webmanifest",
  "./icon.svg"
];

async function computeCacheName(){
  // If we already have a derived cache name, reuse it.
  if(CACHE_NAME && CACHE_NAME.startsWith(CACHE_PREFIX) && CACHE_NAME !== `${CACHE_PREFIX}v1`) {
    return CACHE_NAME;
  }

  // Try to fetch version.json fresh (best effort).
  try{
    const res = await fetch("./version.json", { cache: "no-store" });
    if(res && res.ok){
      const data = await res.json();
      const v = String(data?.version || "").trim();
      if(v){
        CACHE_NAME = `${CACHE_PREFIX}${v}`;
        return CACHE_NAME;
      }
    }
  }catch(_){}

  // Fallback (offline or fetch blocked)
  CACHE_NAME = `${CACHE_PREFIX}v1`;
  return CACHE_NAME;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const name = await computeCacheName();
    const cache = await caches.open(name);
    await cache.addAll(APP_SHELL);
    // Do not auto-activate; we want controlled "Reload to update"
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const name = await computeCacheName();

    // Deterministic cleanup: remove any older shell caches
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== name)
        .map((k) => caches.delete(k))
    );

    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;

  // Always fetch version.json fresh (never serve a cached version.json)
  if (url.pathname.endsWith("/version.json")) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }

  // ✅ NETWORK-FIRST for navigation so the newest index.html is used immediately
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const name = await computeCacheName();
      const cache = await caches.open(name);

      // Try fresh first
      try{
        const fresh = await fetch("./index.html", { cache: "no-store" });
        if(fresh && fresh.ok){
          await cache.put("./index.html", fresh.clone());
          return fresh;
        }
      }catch(_){}

      // Offline / fetch failed → cached shell
      const cached = await cache.match("./index.html");
      if(cached) return cached;

      // Absolute last resort
      return new Response("Offline", {
        status: 503,
        headers: { "Content-Type": "text/plain" }
      });
    })());
    return;
  }
});
