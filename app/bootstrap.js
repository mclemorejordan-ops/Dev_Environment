// bootstrap.js — app boot / startup sequence
// Phase 3.6 extraction: keeps app.js lean while preserving boot order + behavior.

export function initBootstrap({
  getState,

  ExerciseLibrary,
  LogEngine,

  ensureFloatNext,

  renderNav,
  renderView,

  bindHeaderPills,
  setHeaderPills,

  checkForUpdates,
  registerServiceWorker,

  fatal
}){
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
