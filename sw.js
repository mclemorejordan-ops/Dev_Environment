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
  "./assets/styles.css",

  "./app/app.js",
  "./app/state.js",
  "./app/storage.js",
  "./app/ui.js",
  "./app/versioning.js",
  "./app/routines.js",
  "./app/library.js",
  "./app/logs.js",
  "./app/workouts.js",
  "./app/progress.js",
  "./app/attendance.js",
  "./app/backup.js",
  "./app/settings.js",
  "./app/router.js",
  "./app/protein-ui.js",
  "./app/attendance-ui.js",
  "./app/bootstrap.js",

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

async function precacheShell(cache, urls){
  const results = await Promise.allSettled(
    (urls || []).map(async (url) => {
      const req = new Request(url, { cache: "no-store" });
      const res = await fetch(req);

      if(!res || !res.ok){
        throw new Error(`Precache failed: ${url} (${res?.status || "no response"})`);
      }

      await cache.put(req, res.clone());

      // Also cache by raw string key so later cache.match("./index.html") lookups stay reliable.
      try{
        await cache.put(url, res.clone());
      }catch(_){}

      return url;
    })
  );

  const required = new Set([
    "./",
    "./index.html",
    "./app/app.js",
    "./app/state.js",
    "./app/storage.js",
    "./app/ui.js",
    "./app/versioning.js",
    "./app/router.js",
    "./app/bootstrap.js"
  ]);

  const failedRequired = [];

  results.forEach((r, idx) => {
    if(r.status === "rejected"){
      const url = urls[idx];
      if(required.has(url)) failedRequired.push(url);
    }
  });

  if(failedRequired.length){
    throw new Error(`Required shell files failed to precache: ${failedRequired.join(", ")}`);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const name = await computeCacheName();
    const cache = await caches.open(name);
    await precacheShell(cache, APP_SHELL);
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
  if(event?.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin
  if(url.origin !== self.location.origin) return;

  // Always fetch version.json fresh (never from cache)
  if(url.pathname.endsWith("/version.json")) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }

  // ✅ NETWORK-FIRST navigation
  if(req.mode === "navigate") {
    event.respondWith((async () => {
      const name = await computeCacheName();
      const cache = await caches.open(name);

      try{
        const fresh = await fetch("./index.html", { cache: "no-store" });
        if(fresh && fresh.ok){
          await cache.put("./index.html", fresh.clone());
          return fresh;
        }
      }catch(_){}

      const cached = await cache.match("./index.html");
      if(cached) return cached;

      return new Response("Offline", {
        status: 503,
        headers: { "Content-Type": "text/plain" }
      });
    })());
    return;
  }

  // ✅ CACHE-FIRST for same-origin static assets so cold-open offline works
  event.respondWith((async () => {
    const name = await computeCacheName();
    const cache = await caches.open(name);

    const cached = await cache.match(req) || await cache.match(url.pathname) || await cache.match(url.pathname.replace(/^\//, "./"));
    if(cached) return cached;

    try{
      const fresh = await fetch(req);
      if(fresh && fresh.ok){
        await cache.put(req, fresh.clone());
      }
      return fresh;
    }catch(_){
      return new Response("Offline", {
        status: 503,
        headers: { "Content-Type": "text/plain" }
      });
    }
  })());
});
