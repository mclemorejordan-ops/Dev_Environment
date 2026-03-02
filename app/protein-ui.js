/********************
 * protein-ui.js — Phase 3.4
 * Protein modal UI + helpers
 *
 * Notes:
 * - Uses injected deps only (no global state reads; state via getState()).
 * - Writes go through Storage / Logs.protein helpers (upsertMeal, cleanup...).
 ********************/

export function initProteinUI({
  getState,
  Storage,
  Dates,
  Modal,
  el,
  $,
  navigate,
  UIState,
  showToast,

  // Logs.protein helpers
  findProteinEntry,
  cleanupProteinEntryIfEmpty,
  upsertMeal
}){
  if(typeof getState !== "function") throw new Error("initProteinUI requires getState()");
  if(!Storage) throw new Error("initProteinUI requires Storage");
  if(!Dates) throw new Error("initProteinUI requires Dates");
  if(!Modal) throw new Error("initProteinUI requires Modal");
  if(typeof el !== "function") throw new Error("initProteinUI requires el()");
  if(typeof $ !== "function") throw new Error("initProteinUI requires $()");
  if(typeof navigate !== "function") throw new Error("initProteinUI requires navigate()");
  if(!UIState) throw new Error("initProteinUI requires UIState");
  if(typeof showToast !== "function") throw new Error("initProteinUI requires showToast()");
  if(typeof findProteinEntry !== "function") throw new Error("initProteinUI requires findProteinEntry()");
  if(typeof cleanupProteinEntryIfEmpty !== "function") throw new Error("initProteinUI requires cleanupProteinEntryIfEmpty()");
  if(typeof upsertMeal !== "function") throw new Error("initProteinUI requires upsertMeal()");

  // ✅ Delete a meal without creating the day.
  // If last meal removed → delete the entire day entry.
  function deleteMeal(dateISO, mealId){
    const p = findProteinEntry(dateISO);
    if(!p) return;

    p.meals = p.meals || [];
    const idx = p.meals.findIndex(m => m.id === mealId);
    if(idx >= 0) p.meals.splice(idx, 1);

    Storage.save(getState());
    cleanupProteinEntryIfEmpty(dateISO);
  }

  // ✅ Read-only total (never creates/saves)
  function totalProtein(dateISO){
    const p = findProteinEntry(dateISO);
    if(!p || !Array.isArray(p.meals)) return 0;
    return p.meals.reduce((sum,m) => sum + (Number(m.grams)||0), 0);
  }

  function buildProteinTodayModal(dateISO, goal){
  const container = el("div", { class:"grid" });

  // ✅ If user disabled protein tracking, don’t allow logging UI
  const trackProtein = (getState()?.profile?.trackProtein !== false);
  if(!trackProtein){
    container.appendChild(el("div", { class:"card" }, [
      el("h2", { text:"Protein" }),
      el("div", { class:"note", text:"Protein tracking is disabled in your profile. Enable it in Settings if you want to track meals." }),
      el("div", { style:"height:12px" }),
      el("div", { class:"btnrow" }, [
        el("button", { class:"btn primary", onClick: () => { Modal.close(); navigate("settings"); } }, ["Go to Settings"]),
        el("button", { class:"btn", onClick: () => Modal.close() }, ["Close"])
      ])
    ]));
    return container;
  }

    // ---- helpers ----
    const MEAL_LABELS = ["Morning", "Lunch", "Pre-Gym", "Dinner", "Bedtime"];
    dateISO = clampISO(dateISO); // ✅ ensures the modal always opens on a real day (defaults to today)

    function clampISO(s){
      // ✅ Accept YYYY-M-D or YYYY-MM-DD and normalize to YYYY-MM-DD
      const v = String(s || "").trim();
      const m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if(!m) return Dates.todayISO();

      const y  = m[1];
      const mo = String(m[2]).padStart(2, "0");
      const d  = String(m[3]).padStart(2, "0");

      const iso = `${y}-${mo}-${d}`;
      return Dates.isISO(iso) ? iso : Dates.todayISO();
    }

    function fmtPretty(iso){
      const d = Dates.fromISO(iso);
      const day = d.toLocaleDateString(undefined, { weekday:"long" });
      const mon = d.toLocaleDateString(undefined, { month:"long" });
      const dd = d.getDate();
      return `${day}, ${mon} ${dd}`;
    }

    function statusFor(done, g){
      if(!g || g <= 0) return "No goal";
      if(done >= g) return "Goal met ✅";
      const left = Math.max(0, g - done);
      return `${left}g to go`;
    }

    function reopenFor(nextISO){
      // Persist last-opened protein date so other screens can deep-link back
      UIState.protein = UIState.protein || {};
      UIState.protein.dateISO = nextISO;
      Modal.close();
      Modal.open({ title:"Protein", bodyNode: buildProteinTodayModal(nextISO, goal) });
    }

    // ---- load existing meals ----
    const p = findProteinEntry(dateISO) || { meals: [] };
    const meals = Array.isArray(p.meals) ? p.meals : [];

    // Map current meals into fixed slots (Morning/Lunch/Pre-Gym/Dinner/Bedtime)
    const slot = {};
    const slotId = {};
    MEAL_LABELS.forEach(lbl => {
      const found = meals.find(m => String(m.label || "").toLowerCase() === String(lbl).toLowerCase());
      slotId[lbl] = found?.id || null;
      slot[lbl] = Number(found?.grams || 0);
      if(!Number.isFinite(slot[lbl]) || slot[lbl] < 0) slot[lbl] = 0;
    });

    // ---- UI: Header / Date row (editable) ----
    const dateRow = el("div", { class:"proteinDateRow" }, []);

    const prevBtn = el("button", {
      class:"btn",
      onClick: () => reopenFor(Dates.addDaysISO(dateISO, -1))
    }, ["←"]);

    const nextBtn = el("button", {
      class:"btn",
      onClick: () => reopenFor(Dates.addDaysISO(dateISO, 1))
    }, ["→"]);

    const dateInput = el("input", {
      type:"date",
      value: dateISO,
      onInput: (e) => {
        const v = clampISO(e?.target?.value);
        // only reopen if user typed a complete valid value
        if(v && v !== dateISO) reopenFor(v);
      }
    });

    const dateMeta = el("div", { class:"note", text: fmtPretty(dateISO) });

    dateRow.appendChild(el("div", { style:"display:flex; gap:10px; align-items:center; justify-content:space-between;" }, [
      prevBtn,
      el("div", { style:"flex:1; display:flex; flex-direction:column; gap:6px; align-items:center;" }, [
        dateInput,
        dateMeta
      ]),
      nextBtn
    ]));

    // ---- UI: Progress card ----
    const progressCard = el("div", { class:"card proteinProgressCard" }, []);
    const progBar = el("div", { class:"proteinBar" }, [
      el("div", { class:"proteinBarFill" })
    ]);
    const progMeta1 = el("div", { class:"note" });
    const progMeta2 = el("div", { class:"note" });

    progressCard.appendChild(el("h2", { text:`Protein Intake (Goal ${goal}g)` }));
    progressCard.appendChild(el("div", { style:"height:8px" }));
    progressCard.appendChild(el("div", { style:"font-weight:850; margin-bottom:6px;", text:"Progress" }));
    progressCard.appendChild(progBar);
    progressCard.appendChild(el("div", { style:"height:8px" }));
    progressCard.appendChild(progMeta1);
    progressCard.appendChild(progMeta2);

    // ---- UI: Input rows ----
    const formCard = el("div", { class:"card" }, []);
    formCard.appendChild(el("div", { style:"font-weight:900; margin-bottom:10px;", text:"Meals" }));

    const rows = {};
    MEAL_LABELS.forEach(lbl => {
      const input = el("input", {
        type:"number",
        inputMode:"numeric",
        min:"0",
        step:"1",
        placeholder:"0",
        value: String(slot[lbl] || 0),
        onInput: () => {
          const v = Number(input.value || 0);
          slot[lbl] = Number.isFinite(v) && v >= 0 ? v : 0;
          repaintProgress();
        }
      });

      const row = el("div", { class:"proteinRow" }, [
        el("div", { class:"proteinLbl", text: lbl }),
        input
      ]);

      rows[lbl] = { row, input };
      formCard.appendChild(row);
    });

    // ---- UI: Legacy entry list (for extra meals if any exist) ----
    const legacyCard = el("div", { class:"card" }, []);
    legacyCard.appendChild(el("div", { style:"font-weight:900; margin-bottom:10px;", text:"Logged meals" }));

    const legacyList = el("div", { class:"proteinLegacyList" }, []);
    legacyCard.appendChild(legacyList);

    function renderLegacy(){
      legacyList.innerHTML = "";

      const p2 = findProteinEntry(dateISO);
      const all = Array.isArray(p2?.meals) ? p2.meals : [];

      // Only show meals that aren't the five standard labels (or duplicates)
      const std = new Set(MEAL_LABELS.map(x => x.toLowerCase()));
      const extras = all.filter(m => !std.has(String(m.label||"").toLowerCase()));

      if(extras.length === 0){
        legacyList.appendChild(el("div", { class:"note", text:"No extra meals logged." }));
        return;
      }

      extras.forEach(m => {
        const line = el("div", { class:"proteinLegacyItem" }, [
          el("div", { style:"font-weight:850;", text: String(m.label || "Meal") }),
          el("div", { class:"note", text: `${Number(m.grams)||0}g` }),
          el("button", {
            class:"btn",
            onClick: () => {
              deleteMeal(dateISO, m.id);
              repaintProgress();
              renderLegacy();
            }
          }, ["Delete"])
        ]);
        legacyList.appendChild(line);
      });
    }

    // ---- actions ----
    const saveBtn = el("button", {
      class:"btn primary",
      onClick: () => {
        // Persist the five standard meal slots using Logs.protein.upsertMeal
            MEAL_LABELS.forEach(lbl => {
              const grams = Math.max(0, Number(slot[lbl] || 0));
            
              // ✅ Use positional signature to match logs.js
              upsertMeal(
                dateISO,
                slotId[lbl] || null,
                lbl,
                grams
              );
            });
            
            UIState.protein = UIState.protein || {};
            UIState.protein.dateISO = dateISO;
            
            repaintProgress();
            renderLegacy();
            
            // ✅ Force Home to re-render so the ring updates behind the modal
            navigate("home");

        // ✅ restore saved prompt
        showToast("Saved");
      }
    }, ["Save"]);

    const closeBtn = el("button", { class:"btn", onClick: () => Modal.close() }, ["Close"]);

    const historyBtn = el("button", {
      class:"btn",
      onClick: () => {
        UIState.protein = UIState.protein || {};
        UIState.protein.dateISO = dateISO;
        Modal.close();
        navigate("protein_history");
      }
    }, ["History"]);

    const actions = el("div", { class:"proteinActions" }, [ saveBtn, historyBtn, closeBtn ]);

    // ---- progress repaint ----
    function repaintProgress(){
      const done = MEAL_LABELS.reduce((sum,lbl) => sum + (Number(slot[lbl])||0), 0);
      const cleanDone = Math.max(0, Math.round(done));
      const cleanGoal = Math.max(0, Number(goal)||0);

      const pct = cleanGoal > 0 ? Math.max(0, Math.min(1, cleanDone / cleanGoal)) : 0;

      const fill = progBar.querySelector(".proteinBarFill");
      if(fill) fill.style.width = `${Math.round(pct * 100)}%`;

      progMeta1.textContent = `${cleanDone}g / ${cleanGoal}g`;
      progMeta2.textContent = `Status: ${statusFor(cleanDone, cleanGoal)}`;
    }

    // ---- build modal ----
    container.appendChild(dateRow);
    container.appendChild(progressCard);
    container.appendChild(formCard);
    container.appendChild(legacyCard);
    container.appendChild(actions);

    repaintProgress();
    renderLegacy();

    return container;
  }

  return { buildProteinTodayModal, deleteMeal, totalProtein };
}
