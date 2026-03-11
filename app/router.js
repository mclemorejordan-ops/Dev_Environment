/********************
 * router.js — Phase 3.3
 * - SPA routing + bottom nav rendering
 * - No global state access (uses injected getState)
 ********************/

export function initRouter({
  getState,
  $,
  el,
  Views,

  // optional lifecycle hooks
  destroyProgressChart,
  destroyWeightChart,

  // versioning pills (from versioning.js)
  bindHeaderPills,
  setHeaderPills,
  checkForUpdates
}){
  if(typeof getState !== "function") throw new Error("initRouter requires getState()");
  if(typeof $ !== "function") throw new Error("initRouter requires $()");
  if(typeof el !== "function") throw new Error("initRouter requires el()");
  if(!Views) throw new Error("initRouter requires Views");

  const Routes = {
    // Bottom nav (mobile-first)
    home: { label: "Home", nav:true },
    routine: { label: "Routine", nav:true },
    progress: { label: "Progress", nav:true },
    friends: { label: "Friends", nav:true },
    settings: { label: "Settings", nav:true },

    // Non-nav routes (opened via buttons/links)
    weight: { label: "Weight", nav:false },
    attendance: { label: "Attendance", nav:false },
    routine_editor: { label: "Routine Editor", nav:false },
    exercise_library: { label: "Exercise Library", nav:false },
    protein_history: { label: "Protein History", nav:false }
  };

  const NAV_KEYS = Object.entries(Routes)
    .filter(([,v]) => v.nav)
    .map(([k]) => k);

  let currentRoute = "home";

  function getCurrentRoute(){ return currentRoute; }

  function setChip(){
    const chip = $("#chipStatus");
    if(!chip) return;

    const state = getState();
    if(state.profile?.name) chip.textContent = `Hi, ${state.profile.name}`;
    else chip.textContent = "Not set up";
  }

  function renderNav(){
    const nav = $("#navbar");
    nav.innerHTML = "";

    const state = getState();
    const disabled = !state.profile;

    NAV_KEYS.forEach((key) => {
      const r = Routes[key];
      nav.appendChild(el("button", {
        class: "navbtn" + (key === currentRoute ? " active" : ""),
        onClick: () => {
          if(disabled){ navigate("home"); return; }
          navigate(key);
        }
      }, [
        el("div", { class:"dot" }),
        el("div", { text: r.label })
      ]));
    });
  }

  function renderView(){
    setChip();
    setHeaderPills && setHeaderPills();

    const root = $("#viewRoot");
    root.innerHTML = "";

    const state = getState();

    if(!state.profile){
      root.appendChild(Views.Onboarding());
      return;
    }

    if(currentRoute === "home") root.appendChild(Views.Home());
    else if(currentRoute === "routine") root.appendChild(Views.Routine());
    else if(currentRoute === "progress") root.appendChild(Views.Progress());
    else if(currentRoute === "friends") root.appendChild(Views.Friends());
    else if(currentRoute === "settings") root.appendChild(Views.Settings());
    else if(currentRoute === "weight") root.appendChild(Views.Weight());
    else if(currentRoute === "attendance") root.appendChild(Views.Attendance());
    else if(currentRoute === "routine_editor") root.appendChild(Views.RoutineEditor());
    else if(currentRoute === "exercise_library") root.appendChild(Views.ExerciseLibraryManager());
    else if(currentRoute === "protein_history") root.appendChild(Views.ProteinHistory());
    else root.appendChild(el("div", { class:"card" }, [
      el("h2", { text:"Not found" }),
      el("div", { class:"note", text:`Unknown route: ${currentRoute}` })
    ]));
  }

  function navigate(routeKey){
    try{ destroyProgressChart && destroyProgressChart(); }catch(_){}
    try{ destroyWeightChart && destroyWeightChart(); }catch(_){}

    // ✅ Route-name contract hardening:
    // If someone calls navigate("typo_route"), never break rendering.
    const safeRoute = Routes?.[routeKey] ? routeKey : "home";
    currentRoute = safeRoute;

    renderNav();
    renderView();

    // Versioning pills: bind once, then keep the UI current
    bindHeaderPills && bindHeaderPills();
    setHeaderPills && setHeaderPills();

    // Keep throttled background check, but don't spam
    checkForUpdates && checkForUpdates();

    // ─────────────────────────────
    // GA4: SPA route tracking (page_view)
    // ─────────────────────────────
    try{
      if(typeof gtag === "function"){
        const label = (Routes?.[safeRoute]?.label) || safeRoute || "unknown";
        const pagePath = "/" + String(safeRoute || "unknown");

        gtag("event", "page_view", {
          page_title: label,
          page_path: pagePath,
          page_location: (location?.origin || "") + pagePath
        });
      }
    }catch(e){
      // never let analytics break navigation
    }
  }

  return {
    Routes,
    NAV_KEYS,
    renderNav,
    renderView,
    navigate,
    getCurrentRoute
  };
}
