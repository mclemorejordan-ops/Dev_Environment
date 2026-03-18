// bootstrap.js — app boot / startup sequence
// Phase 3.6 extraction: keeps app.js lean while preserving boot order + behavior.

export function initBootstrap({
  getState,
  Social,

  ExerciseLibrary,
  LogEngine,

  ensureFloatNext,

  renderNav,
  renderView,

  bindHeaderPills,
  setHeaderPills,

  checkForUpdates,
  registerServiceWorker,

  syncHistoricalProfileEvents,

  fatal
}){
  async function runShellPathDiagnostic(){
    // Non-blocking production diagnostic:
    // warns if critical deployed shell files are missing or mis-pathed.
    if(!("fetch" in window)) return;

    const critical = [
      "./app/app.js",
      "./app/versioning.js",
      "./app/bootstrap.js",
      "./app/router.js",
      "./assets/styles.css",
      "./version.json"
    ];

    try{
      const results = await Promise.allSettled(
        critical.map(async (url) => {
          const res = await fetch(url, { method: "GET", cache: "no-store" });
          return { url, ok: !!(res && res.ok), status: res?.status || 0 };
        })
      );

      const failed = results
        .map((r, i) => {
          if(r.status === "fulfilled"){
            return r.value.ok ? null : `${critical[i]} (${r.value.status})`;
          }
          return `${critical[i]} (fetch failed)`;
        })
        .filter(Boolean);

      if(failed.length){
        console.warn("[GymDash] Shell path diagnostic warning:", failed);
      }
    }catch(_){
      // silent: diagnostic only
    }
  }

  async function start(){
    const state = getState();

    // If already onboarded and library is empty, seed it (won't overwrite non-empty)
    if(state?.profile) ExerciseLibrary.ensureSeeded();

    // Step 6 safety: ensure logs arrays exist even if older saved state is missing fields
    LogEngine.ensure();

    // Keep an accurate header height for internal fixed/scroll layouts
    function updateLayoutVars(){
      const h = document.querySelector("header");
      if(h) document.documentElement.style.setProperty("--headerH", `${h.offsetHeight}px`);
    }
    updateLayoutVars();
    window.addEventListener("resize", updateLayoutVars);

    ensureFloatNext(); // Phase 3: enable Floating Next → nudge container

    // Render baseline UI first (so user never sees a blank app)
    renderNav();
    renderView();
    bindHeaderPills();
    setHeaderPills();

    // Non-blocking shell/path verification after first paint
    try{
      setTimeout(() => {
        runShellPathDiagnostic().catch(() => {});
      }, 0);
    }catch(_){}

    // ✅ Friends/Social: rehydrate OAuth session after redirect without requiring user to click "Save"
    // Keep this AFTER first render to avoid any perceived blank/slow boot.
    try{
      if(Social && typeof Social.isConfigured === "function" && Social.isConfigured()){
        await Social.refreshUser?.();

        if(Social.getUser?.()){
          try{ await syncHistoricalProfileEvents?.(); }catch(_){}
          try{ Social.startFeed?.(); }catch(_){}
        }
      }
    }catch(_){}

    // ✅ IMPORTANT: fetch version.json FIRST, so SW registers with the correct ?v=
    await checkForUpdates();

    // ✅ Then register SW using the latest version (deterministic updates)
    await registerServiceWorker();
  }

  return {
    start: () => start().catch((e) => {
      try{ fatal && fatal(e, "boot"); }catch(_){}
    })
  };
}
