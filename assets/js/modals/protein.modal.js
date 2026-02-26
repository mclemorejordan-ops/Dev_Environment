function buildProteinTodayModal(dateISO, goal){
  const container = el("div", { class:"grid" });

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

  function fmtPretty(dateISO){
    // ✅ Safari-safe: parse ISO manually and build Date(y, m-1, d)
    const iso = clampISO(dateISO);
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return "—";

    const y  = Number(m[1]);
    const mo = Number(m[2]);
    const d  = Number(m[3]);

    const dt = new Date(y, mo - 1, d);
    if(Number.isNaN(dt.getTime())) return "—";

    return dt.toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" });
  }

  function statusFor(done, goal){
    if(goal <= 0) return "No goal set";
    const pct = done / goal;
    if(pct >= 1) return "Goal Met";
    if(pct >= 0.75) return "Almost There";
    return "Under Goal";
  }

  function reopenFor(newISO){
    const nextISO = clampISO(newISO);
    Modal.close();
    Modal.open({
      title: "Protein",
      bodyNode: buildProteinTodayModal(nextISO, goal)
    });
  }

  // ---- load existing data and auto-convert (map existing meals into the 5 standard slots) ----
  const entry = findProteinEntry(dateISO) || { dateISO, meals: [] };
  const existingMeals = (entry?.meals || []).slice();

  // map by label (case-insensitive)
  function findMealByLabel(label){
    const key = String(label || "").trim().toLowerCase();
    return existingMeals.find(m => String(m?.label || "").trim().toLowerCase() === key) || null;
  }

  const slot = {};     // grams draft
  const slotId = {};   // existing meal IDs for those labels (if found)
  MEAL_LABELS.forEach(lbl => {
    const found = findMealByLabel(lbl);
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

  // ---- UI: Progress card (loading bar concept) ----
  const progressCard = el("div", { class:"card proteinProgressCard" }, []);
  const progTop = el("div", { class:"proteinProgTop" }, []);
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

  // ---- UI: Input rows (single screen, numeric keypad, updates live) ----
  const formCard = el("div", { class:"card" }, [
    el("h2", { text:"Log protein" }),
    el("div", { class:"note", text:"Updates live as you type. Tap Save when done." }),
    el("div", { style:"height:10px" })
  ]);

  const rows = el("div", { style:"display:grid; gap:10px;" }, []);
  const inputs = {}; // keep DOM refs if needed

  function makeRow(label){
    const inp = el("input", {
      type:"number",
      inputmode:"numeric",
      pattern:"[0-9]*",
      min:"0",
      step:"1",
      value: String(Math.max(0, Math.round(Number(slot[label] || 0)))),
      onInput: (e) => {
        const raw = String(e?.target?.value ?? "");
        // allow empty while typing, treat as 0 for calculations
        const n = raw === "" ? 0 : Number(raw);
        slot[label] = (Number.isFinite(n) && n >= 0) ? n : 0;
        repaintProgress(); // live UI update
      }
    });

    inputs[label] = inp;

    return el("div", { class:"proteinRow" }, [
      el("div", { style:"font-weight:820;", text: `${label} (g)` }),
      inp
    ]);
  }

  MEAL_LABELS.forEach(lbl => rows.appendChild(makeRow(lbl)));
  formCard.appendChild(rows);

  // ---- Optional: Legacy / other meals (keep safe access to older custom entries) ----
  const legacy = existingMeals.filter(m => {
    const k = String(m?.label || "").trim().toLowerCase();
    return !MEAL_LABELS.map(x => x.toLowerCase()).includes(k);
  });

  const legacyCard = el("div", { class:"card" }, [
    el("h2", { text:"Other meals" }),
    el("div", { class:"note", text: legacy.length ? "Your older custom meals are kept here." : "No other meals." }),
    el("div", { style:"height:10px" })
  ]);

  if(legacy.length){
    const list = el("div", { class:"list" });
    legacy.forEach(m => {
      list.appendChild(el("div", { class:"item" }, [
        el("div", { class:"left" }, [
          el("div", { class:"name", text: m.label || "Meal" }),
          el("div", { class:"meta", text: `${Number(m.grams)||0}g` })
        ]),
        el("div", { class:"actions" }, [
          el("button", { class:"mini", onClick: () => {
            // reuse your existing editor behavior (same as before)
            const labelInput = el("input", { type:"text", placeholder:"Meal name", value: m?.label || "" });
            const gramsInput = el("input", { type:"number", inputmode:"numeric", pattern:"[0-9]*", placeholder:"Protein grams", min:"0", value: m?.grams ?? "" });
            const err = el("div", { class:"note", style:"display:none; color: rgba(255,92,122,.95);" });

            Modal.open({
              title: "Edit meal",
              size: "sm",
              center: true,
              bodyNode: el("div", {}, [
                el("label", {}, [ el("span", { text:"Label" }), labelInput ]),
                el("label", {}, [ el("span", { text:"Protein (grams)" }), gramsInput ]),
                err,
                el("div", { style:"height:12px" }),
                el("div", { class:"btnrow" }, [
                  el("button", {
                    class:"btn primary",
                    onClick: () => {
                      err.style.display = "none";
                      const label = (labelInput.value || "").trim();
                      const grams = Number(gramsInput.value);
                      if(!label){ err.textContent="Label required."; err.style.display="block"; return; }
                      if(!Number.isFinite(grams) || grams < 0){ err.textContent="Enter valid grams."; err.style.display="block"; return; }
                      upsertMeal(dateISO, m?.id || null, label, grams);
                      Modal.close();
                      // reopen to reflect changes safely
                      reopenFor(dateISO);
                      renderView(); // refresh home ring if visible
                    }
                  }, ["Save"]),
                  el("button", { class:"btn", onClick: () => { Modal.close(); } }, ["Cancel"])
                ])
              ])
            });
          }}, ["Edit"]),
          el("button", { class:"mini danger", onClick: () => {
            deleteMeal(dateISO, m.id);
            reopenFor(dateISO);
            renderView();
          }}, ["Delete"])
        ])
      ]));
    });
    legacyCard.appendChild(list);
  }

  // ---- Footer actions ----
  const saveBtn = el("button", {
    class:"btn primary",
    onClick: () => {
      // persist the 5 standard slots
      MEAL_LABELS.forEach(lbl => {
        const grams = Math.max(0, Math.round(Number(slot[lbl] || 0)));
        // Keep the entry even if 0 (your preference); if you ever want "0 means delete", we can change later.
        const existingId = slotId[lbl] || null;
        upsertMeal(dateISO, existingId, lbl, grams);
      });

      showToast("Saved");
      renderView(); // update ring on Home
      // stay open; user asked to keep Save button + live feel
      reopenFor(dateISO);
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

  const actions = el("div", { class:"btnrow" }, [ saveBtn, historyBtn, closeBtn ]);

  // ---- Progress repaint ----
  function repaintProgress(){
    const done = MEAL_LABELS.reduce((sum, lbl) => sum + (Number(slot[lbl]) || 0), 0);
    const cleanDone = Math.max(0, Math.round(done));
    const cleanGoal = Math.max(0, Math.round(Number(goal) || 0));
    const left = Math.max(0, cleanGoal - cleanDone);

    const pct = (cleanGoal > 0) ? Math.max(0, Math.min(1, cleanDone / cleanGoal)) : 0;
    const fill = progBar.querySelector(".proteinBarFill");
    if(fill) fill.style.width = `${Math.round(pct * 100)}%`;

    progMeta1.textContent = `${cleanDone}g / ${cleanGoal}g`;
    progMeta2.textContent = `Remaining: ${left}g • Status: ${statusFor(cleanDone, cleanGoal)}`;
  }

  // ---- build modal ----
  container.appendChild(dateRow);
  container.appendChild(progressCard);
  container.appendChild(formCard);
  container.appendChild(legacyCard);
  container.appendChild(actions);

  repaintProgress();
  return container;
}

