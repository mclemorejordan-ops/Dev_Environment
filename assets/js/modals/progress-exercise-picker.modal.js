/* =========================================================
   progress-exercise-picker.modal.js
   - Feature modal: selects an exercise for Progress page
   - UI only: gathers input, calls callback, persists via ProgressUIEngine (engine)
   - Exports via window.GymDash.modals (no extra globals)
   ========================================================= */
(function(){
  "use strict";

  const root = window;
  const GymDash = root.GymDash = root.GymDash || {};
  GymDash.modals = GymDash.modals || {};

  // Local helpers (UI only)
  function safeStr(x){ return (x == null) ? "" : String(x); }

  function getExerciseName(type, id){
    try{
      const arr = (root.state && root.state.exerciseLibrary && root.state.exerciseLibrary[type]) ? root.state.exerciseLibrary[type] : [];
      const ex = arr.find(x => x && x.id === id);
      return ex ? (ex.name || "Exercise") : "Exercise";
    }catch(_){
      return "Exercise";
    }
  }

  function buildSection(title, items){
    return el("div", {}, [
      el("div", { class:"note", style:"margin-top:10px; font-weight:900;", text:title }),
      el("div", { class:"list", style:"margin-top:8px;" }, items)
    ]);
  }

  function makeRow(ex, isActive, onPick){
    return el("div", {
      class:"item",
      onClick: onPick,
      style: [
        "cursor:pointer",
        isActive ? "background: rgba(124,92,255,.12); border-radius: 14px; padding: 10px;" : "padding: 10px;"
      ].join("")
    }, [
      el("div", { class:"left" }, [
        el("div", { class:"name", text: safeStr(ex?.name || "Exercise") }),
        el("div", { class:"meta", text: safeStr(ex?.equipment || "") })
      ])
    ]);
  }

  // Main modal export
  GymDash.modals.openProgressExercisePicker = function({ type, currentId, onSelect }){
    const t = safeStr(type || "weightlifting");
    const cur = currentId ? safeStr(currentId) : null;

    // Build base lists
    const lib = (state.exerciseLibrary?.[t] || []).slice()
      .sort((a,b) => safeStr(a?.name).localeCompare(safeStr(b?.name)));

    // Logged set for this type (so we can prioritize)
    const loggedSet = new Set();
    try{
      for(const e of (state.logs?.workouts || [])){
        const et = safeStr(e?.type || "");
        const exId = safeStr(e?.exerciseId || "");
        if(et === t && exId) loggedSet.add(exId);
      }
    }catch(_){}

    // Recent from ProgressUIEngine (if present)
    let recentIds = [];
    try{
      if(GymDash.engines && GymDash.engines.ProgressUI && typeof GymDash.engines.ProgressUI.getRecentExerciseIds === "function"){
        recentIds = GymDash.engines.ProgressUI.getRecentExerciseIds(t) || [];
      }
    }catch(_){}

    // Modal state
    let q = "";
    const body = el("div", {});

    const search = el("input", {
      type:"text",
      value:"",
      placeholder:"Search exercises…",
      style: [
        "width:100%",
        "border-radius:16px",
        "padding:12px",
        "border:1px solid rgba(255,255,255,.10)",
        "background: rgba(255,255,255,.06)",
        "color: rgba(255,255,255,.92)",
        "outline:none",
        "font-size:16px" // iOS no-zoom
      ].join(";"),
      onInput: (e) => {
        q = safeStr(e.target.value || "");
        repaint();
      }
    });

    const info = el("div", { class:"note", style:"margin-top:10px;" });
    const listHost = el("div", {});

    body.appendChild(el("div", { class:"note", text:"Select an exercise for your Progress chart." }));
    body.appendChild(el("div", { style:"height:10px" }));
    body.appendChild(search);
    body.appendChild(info);
    body.appendChild(listHost);
    body.appendChild(el("div", { style:"height:12px" }));
    body.appendChild(el("button", { class:"btn ghost", onClick: () => Modal.close() }, ["Close"]));

    function repaint(){
      listHost.innerHTML = "";

      const qn = normName(q);
      const filtered = q ? lib.filter(x => normName(x?.name || "").includes(qn)) : lib;

      info.textContent = q
        ? `${filtered.length} result${filtered.length===1?"":"s"}`
        : `Current: ${getExerciseName(t, cur)}`;

      // Section: Recent
      if(!q && recentIds.length){
        const map = new Map(lib.map(x => [safeStr(x.id), x]));
        const rows = recentIds
          .map(id => map.get(safeStr(id)))
          .filter(Boolean)
          .map(ex => makeRow(ex, safeStr(ex.id) === cur, () => pick(ex)));
        if(rows.length) listHost.appendChild(buildSection("Recent", rows));
      }

      // Section: Logged
      if(!q){
        const logged = lib.filter(ex => loggedSet.has(safeStr(ex.id)));
        if(logged.length){
          const rows = logged.slice(0, 40).map(ex => makeRow(ex, safeStr(ex.id) === cur, () => pick(ex)));
          listHost.appendChild(buildSection("Logged", rows));
        }
      }

      // Section: All / Search results
      const rowsAll = filtered.slice(0, q ? 60 : 40).map(ex => makeRow(ex, safeStr(ex.id) === cur, () => pick(ex)));
      listHost.appendChild(buildSection(q ? "Results" : "All", rowsAll));

      if(!rowsAll.length){
        listHost.appendChild(el("div", { class:"note", text:"No matches. Try another keyword." }));
      }
    }

    function pick(ex){
      const id = safeStr(ex?.id);
      if(!id) return;
      try{
        // Persist selection if engine exists
        if(GymDash.engines && GymDash.engines.ProgressUI && typeof GymDash.engines.ProgressUI.setSelectedExerciseId === "function"){
          GymDash.engines.ProgressUI.setSelectedExerciseId(t, id);
        }
      }catch(_){}
      try{ if(typeof onSelect === "function") onSelect(id); }catch(_){}
      Modal.close();
    }

    Modal.open({
      title: `Pick ${ExerciseLibrary.typeLabel(t)} exercise`,
      bodyNode: body,
      center: true,
      size: "lg"
    });

    repaint();
    // focus search on open (next tick)
    setTimeout(() => { try{ search.focus(); }catch(_){ } }, 0);
  };
})();
