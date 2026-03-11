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
  let routeStack = ["home"];
  let __swipeBackBound = false;

  function getCurrentRoute(){ return currentRoute; }

  function canGoBack(){
    return routeStack.length > 1;
  }

  function getPreviousRoute(){
    return canGoBack() ? routeStack[routeStack.length - 2] : null;
  }

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

    function navigate(routeKey, opts = {}){
    try{ destroyProgressChart && destroyProgressChart(); }catch(_){}
    try{ destroyWeightChart && destroyWeightChart(); }catch(_){}

    const safeRoute = Routes?.[routeKey] ? routeKey : "home";

    const replace = !!opts.replace;
    const fromBack = !!opts.fromBack;
    const skipRender = !!opts.skipRender;

    if(fromBack){
      currentRoute = safeRoute;
    }else if(replace){
      currentRoute = safeRoute;
      routeStack[routeStack.length - 1] = safeRoute;
    }else{
      currentRoute = safeRoute;

      const last = routeStack[routeStack.length - 1];
      if(last !== safeRoute){
        routeStack.push(safeRoute);
      }
    }

    if(skipRender) return;

    renderNav();
    renderView();

    bindHeaderPills && bindHeaderPills();
    setHeaderPills && setHeaderPills();
    checkForUpdates && checkForUpdates();

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

    function goBack(){
    if(!canGoBack()) return false;

    routeStack.pop();
    const prev = routeStack[routeStack.length - 1] || "home";

    navigate(prev, { fromBack:true });
    return true;
  }

    function isInteractiveTarget(node){
    const elNode = node instanceof Element ? node : null;
    if(!elNode) return false;

    return !!elNode.closest(
      'input, textarea, select, option, button, a, label, [contenteditable="true"], [data-no-swipe-back]'
    );
  }

  function hasOpenModalOrPopover(){
    const modalHost = document.getElementById("modalHost");
    const popHost = document.getElementById("popHost");

    const modalOpen = !!(modalHost && modalHost.classList.contains("show"));
    const popOpen = !!(popHost && popHost.classList.contains("show"));

    return modalOpen || popOpen;
  }

  function findHorizontalScroller(node){
    let cur = node instanceof Element ? node : null;

    while(cur && cur !== document.body){
      try{
        const style = window.getComputedStyle(cur);
        const overflowX = style?.overflowX || "";
        const canScrollX = cur.scrollWidth > cur.clientWidth + 2;

        if(canScrollX && (overflowX === "auto" || overflowX === "scroll")){
          return cur;
        }
      }catch(_){}
      cur = cur.parentElement;
    }

    return null;
  }

  function bindSwipeBack(){
    if(__swipeBackBound) return;
    __swipeBackBound = true;

    const EDGE_PX = 28;
    const TRIGGER_PX = 72;
    const MAX_VERTICAL_DRIFT = 36;

    let tracking = false;
    let blocked = false;
    let startX = 0;
    let startY = 0;
    let scroller = null;

    document.addEventListener("touchstart", (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      if(!t) return;

      tracking = false;
      blocked = false;
      scroller = null;
      startX = t.clientX;
      startY = t.clientY;

      if(startX > EDGE_PX) return;
      if(hasOpenModalOrPopover()) return;
      if(isInteractiveTarget(e.target)) return;
      if(!canGoBack()) return;

      scroller = findHorizontalScroller(e.target);
      if(scroller && scroller.scrollLeft > 0){
        return;
      }

      tracking = true;
    }, { passive:true });

    document.addEventListener("touchmove", (e) => {
      if(!tracking || blocked) return;

      const t = e.changedTouches && e.changedTouches[0];
      if(!t) return;

      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if(Math.abs(dy) > MAX_VERTICAL_DRIFT && Math.abs(dy) > Math.abs(dx)){
        blocked = true;
        return;
      }

      if(scroller){
        try{
          if(scroller.scrollLeft > 0){
            blocked = true;
          }
        }catch(_){}
      }
    }, { passive:true });

    document.addEventListener("touchend", (e) => {
      if(!tracking || blocked) {
        tracking = false;
        blocked = false;
        scroller = null;
        return;
      }

      const t = e.changedTouches && e.changedTouches[0];
      if(!t){
        tracking = false;
        blocked = false;
        scroller = null;
        return;
      }

      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      tracking = false;
      blocked = false;
      scroller = null;

      if(dx >= TRIGGER_PX && Math.abs(dy) <= MAX_VERTICAL_DRIFT){
        goBack();
      }
    }, { passive:true });

    document.addEventListener("touchcancel", () => {
      tracking = false;
      blocked = false;
      scroller = null;
    }, { passive:true });
  }

    return {
    Routes,
    NAV_KEYS,
    renderNav,
    renderView,
    navigate,
    goBack,
    canGoBack,
    getPreviousRoute,
    bindSwipeBack,
    getCurrentRoute
  };
}
