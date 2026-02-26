function openExerciseLogger(rx, day, defaultDateISO){
  ExerciseLibrary.ensureSeeded();
  LogEngine.ensure();

  const type = rx.type;
  const exerciseId = rx.exerciseId;
  const exName = resolveExerciseName(type, exerciseId, rx.nameSnap);

  const initialDateISO = String(defaultDateISO || Dates.todayISO());

  // Manual override date (defaults to the day you're viewing in the carousel)
  const dateInput = el("input", { type:"date", value: initialDateISO });

  // Existing log for this routine-exercise on the selected date (so inputs persist)
  const existingEntry = (state.logs?.workouts || []).find(e =>
    e.dateISO === initialDateISO && e.routineExerciseId === rx.id
  ) || null;

const headerText = el("div", { class:"note" }, [
  `${exName} • ${ExerciseLibrary.typeLabel(type)} • `,
  dateInput
]);

const hint = el("div", { class:"note", text:"Tip: Change the date above to log for a different day (manual override)." });

// Show plan snapshot (optional)
const plan = rx.plan || null;
const planLine = el("div", { class:"note" }, [
  plan
    ? `Plan: ${String(plan.sets ?? "—")} × ${String(plan.reps ?? "—")}${plan.restSec ? ` • Rest ${plan.restSec}s` : ""}`
    : "Plan: —"
]);

// Show last entry snapshot (optional)
const last = LogEngine.entriesForExercise(type, exerciseId)[0] || null;
const lastLine = el("div", { class:"note" }, [
  last ? `Last: ${formatEntryOneLine(type, last)}` : "Last: —"
]);

const err = el("div", { class:"note", style:"display:none; color: rgba(255,92,122,.95);" });

/* NEW layout shell:
   - header stays fixed (sticky)
   - form area scrolls
*/
const head = el("div", { class:"logsetHead" }, [ headerText, hint, planLine, lastLine, err ]);
const scroll = el("div", { class:"logsetScroll" }, []);
const body = el("div", { class:"logsetShell" }, [ head, scroll ]);



if(type === "weightlifting"){
  scroll.appendChild(buildWeightliftingForm());
}else if(type === "cardio"){
  scroll.appendChild(buildCardioForm());
}else{
  scroll.appendChild(buildCoreForm());
}


  Modal.open({
    title: "Log Sets",
    center: true,
    bodyNode: body
  });

  function showErr(msg){
    err.textContent = msg;
    err.style.display = "block";
  }

  function clearErr(){
    err.style.display = "none";
    err.textContent = "";
  }

  function afterSave(savedDateISO){
    Modal.close();

    // If the whole day is now logged, auto-complete + attendance
    if(isDayComplete(savedDateISO, day)){
      attendanceAdd(savedDateISO);
      showToast("Day completed ✅");
    }

    // Set Next → nudge for next unlogged (same day)
    const list = (day.exercises || []);
    const curIdx = list.findIndex(x => x.id === rx.id);

    // next unlogged AFTER current
    let next = null;
    for(let i = curIdx + 1; i < list.length; i++){
      if(!hasRoutineExerciseLog(savedDateISO, list[i].id)){ next = list[i]; break; }
    }
    // if none after, fallback to first unlogged anywhere
    if(!next){
      next = list.find(x => !hasRoutineExerciseLog(savedDateISO, x.id)) || null;
    }

    setNextNudge(next ? {
      dateISO: savedDateISO,
      dayOrder: day.order,
      nextRoutineExerciseId: next.id
    } : null);

    repaint();
  }

function buildWeightliftingForm(){
  const rowsHost = el("div", { class:"logsetWLCard" }, []);
  const setInputs = [];

  const head = el("div", { class:"logsetGridHead" }, [
    el("div", { text:"Set" }),
    el("div", { text:"Weight" }),
    el("div", { text:"Reps" })
  ]);

  const rows = el("div", {}, []);

  function clearActive(){
    rows.querySelectorAll(".logsetRow.active").forEach(n => n.classList.remove("active"));
  }
  function setActiveRow(rowEl){
    clearActive();
    rowEl.classList.add("active");
  }
  function refreshSetNumbers(){
    const pills = rows.querySelectorAll(".logsetSetPill");
    pills.forEach((p, i) => p.textContent = String(i + 1));
  }

  const addRow = (w="", r="") => {
    const wInput = el("input", { type:"number", inputmode:"decimal", placeholder:"", value: w });
    const rInput = el("input", { type:"number", inputmode:"numeric", placeholder:"", value: r });

    setInputs.push({ wInput, rInput });

    const setPill = el("div", { class:"logsetSetPill", text: String(setInputs.length) });

    const row = el("div", { class:"logsetRow" }, [
      setPill,
      wInput,
      rInput
    ]);

    // Active row highlight when editing (focus/click)
    row.addEventListener("click", () => setActiveRow(row));
    row.addEventListener("focusin", () => setActiveRow(row));

    rows.appendChild(row);
    refreshSetNumbers();
  };

  // ✅ KEEP EXISTING FUNCTIONALITY:
  // planned sets still drive the defaults exactly like before
  const existingSets = (existingEntry?.sets || []);
  const plannedSets = Math.max(1, Math.min(12, Math.floor(Number(rx.plan?.sets) || 0))) || 0;
  const baseRows = plannedSets || 4;
  const rowsToShow = Math.max(baseRows, existingSets.length || 0);

  for(let i=0; i<rowsToShow; i++){
    const s = existingSets[i] || {};
    addRow(
      (s.weight ?? "") === 0 ? "" : String(s.weight ?? ""),
      (s.reps ?? "") === 0 ? "" : String(s.reps ?? "")
    );
  }

  // Buttons
  const addBtn = el("button", { class:"btn", onClick: () => {
    addRow();
    // focus weight input of the new row
    const last = setInputs[setInputs.length - 1];
    if(last?.wInput) last.wInput.focus();
  }}, ["+ Add Set"]);

  const saveBtn = el("button", {
    class:"btn primary",
    onClick: () => {
      clearErr();

      const dateISO = String(dateInput.value || initialDateISO);

      const sets = setInputs.map(s => ({
        weight: Number(s.wInput.value) || 0,
        reps: Math.max(0, Math.floor(Number(s.rInput.value) || 0))
      })).filter(s => s.weight > 0 || s.reps > 0);

      if(sets.length === 0){
        showErr("Enter at least one set.");
        return;
      }

      const summary = LogEngine.computeWeightliftingSummary(sets);
      const pr = LogEngine.computePRFlags(type, exerciseId, summary);

      // Upsert: replace existing entry for this date + routineExerciseId
      LogEngine.ensure();
      state.logs.workouts = (state.logs.workouts || []).filter(e =>
        !(e.dateISO === dateISO && e.routineExerciseId === rx.id)
      );
      Storage.save(state);

      LogEngine.addEntry({
        id: uid("w"),
        createdAt: Date.now(),
        dateISO,
        type,
        exerciseId,
        routineExerciseId: rx.id,
        routineId: routine.id,
        dayId: day.id,
        dayOrder: day.order,
        sets,
        summary,
        pr
      });

      afterSave(dateISO);
    }
  }, ["Save"]);

  // Sticky bar (two buttons only)
  const sticky = el("div", { class:"logsetStickyBar" }, [ addBtn, saveBtn ]);

  rowsHost.appendChild(head);
  rowsHost.appendChild(rows);
  rowsHost.appendChild(sticky);

  // Make the first row “active” by default (if any)
  setTimeout(() => {
    const firstRow = rows.querySelector(".logsetRow");
    if(firstRow) firstRow.classList.add("active");
  }, 0);

  return rowsHost;
}

  function buildCardioForm(){
    const minInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Min", value:"" });
    const secInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Sec", value:"" });
    const distInput = el("input", { type:"number", inputmode:"decimal", placeholder:"Distance", value:"" });
    const inclInput = el("input", { type:"number", inputmode:"decimal", placeholder:"Incline (optional)", value:"" });

    // Prefill if already logged on initial date
    if(existingEntry?.sets?.[0]){
      const s = existingEntry.sets[0];
      const t = Math.max(0, Math.floor(Number(s.timeSec) || 0));
      minInput.value = String(Math.floor(t / 60) || "");
      secInput.value = String((t % 60) || "");
      distInput.value = (s.distance != null && Number(s.distance) !== 0) ? String(s.distance) : "";
      inclInput.value = (s.incline != null && String(s.incline) !== "0") ? String(s.incline) : "";
    }

    const saveBtn = el("button", {
      class:"btn primary",
      onClick: () => {
        clearErr();

        const dateISO = String(dateInput.value || initialDateISO);

        const min = Math.max(0, Math.floor(Number(minInput.value) || 0));
        const sec = Math.max(0, Math.floor(Number(secInput.value) || 0));
        const timeSec = (min * 60) + sec;
        const distance = Number(distInput.value) || 0;
        const incline = (inclInput.value === "") ? null :
          (Number.isFinite(Number(inclInput.value)) ? Number(inclInput.value) : null);

        if(timeSec <= 0 && distance <= 0){
          showErr("Enter time and/or distance.");
          return;
        }

        const sets = [{ timeSec, distance, incline }];
        const summary = LogEngine.computeCardioSummary(sets);
        const pr = LogEngine.computePRFlags(type, exerciseId, summary);

        // Upsert: replace existing entry for this date + routineExerciseId
        LogEngine.ensure();
        state.logs.workouts = (state.logs.workouts || []).filter(e =>
          !(e.dateISO === dateISO && e.routineExerciseId === rx.id)
        );
        Storage.save(state);

        LogEngine.addEntry({
          id: uid("c"),
          createdAt: Date.now(),
          dateISO,
          type,
          exerciseId,
          routineExerciseId: rx.id,
          routineId: routine.id,
          dayId: day.id,
          dayOrder: day.order,
          sets,
          summary,
          pr
        });

        afterSave(dateISO);
      }
    }, ["Save"]);

const cancelBtn = el("button", { class:"btn", onClick: Modal.close }, ["Cancel"]);

const sticky = el("div", { class:"logsetStickyBar" }, [ cancelBtn, saveBtn ]);

return el("div", { class:"card" }, [
  el("h2", { text:"Session" }),
  el("div", { class:"row2" }, [
    el("label", {}, [ el("span", { text:"Minutes" }), minInput ]),
    el("label", {}, [ el("span", { text:"Seconds" }), secInput ])
  ]),
  el("div", { class:"row2" }, [
    el("label", {}, [ el("span", { text:"Distance" }), distInput ]),
    el("label", {}, [ el("span", { text:"Incline" }), inclInput ])
  ]),
  sticky
]);
  }

  function buildCoreForm(){
    const setsInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Sets", value:"" });
    const repsInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Reps", value:"" });
    const timeMinInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Min", value:"" });
    const timeSecInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Sec", value:"" });
    const weightInput = el("input", { type:"number", inputmode:"decimal", placeholder:"Weight (optional)", value:"" });

    // Prefill if already logged on initial date
    if(existingEntry?.sets?.[0]){
      const s = existingEntry.sets[0];
      setsInput.value = (s.sets != null && Number(s.sets) !== 0) ? String(s.sets) : "";
      repsInput.value = (s.reps != null && Number(s.reps) !== 0) ? String(s.reps) : "";
      const t = Math.max(0, Math.floor(Number(s.timeSec) || 0));
      timeMinInput.value = String(Math.floor(t / 60) || "");
      timeSecInput.value = String((t % 60) || "");
      weightInput.value = (s.weight != null && Number(s.weight) !== 0) ? String(s.weight) : "";
    }

    const saveBtn = el("button", {
      class:"btn primary",
      onClick: () => {
        clearErr();

        const dateISO = String(dateInput.value || initialDateISO);

        const setsN = Math.max(0, Math.floor(Number(setsInput.value) || 0));
        const repsN = Math.max(0, Math.floor(Number(repsInput.value) || 0));
        const tmin = Math.max(0, Math.floor(Number(timeMinInput.value) || 0));
        const tsec = Math.max(0, Math.floor(Number(timeSecInput.value) || 0));
        const timeSec = (tmin * 60) + tsec;
        const weight = Number(weightInput.value) || 0;

        if((setsN <= 0 || repsN <= 0) && timeSec <= 0){
          showErr("Enter sets+reps or a time.");
          return;
        }

        const sets = [{ sets: setsN, reps: repsN, timeSec, weight }];
        const summary = LogEngine.computeCoreSummary(sets);
        const pr = LogEngine.computePRFlags(type, exerciseId, summary);

        // Upsert: replace existing entry for this date + routineExerciseId
        LogEngine.ensure();
        state.logs.workouts = (state.logs.workouts || []).filter(e =>
          !(e.dateISO === dateISO && e.routineExerciseId === rx.id)
        );
        Storage.save(state);

        LogEngine.addEntry({
          id: uid("k"),
          createdAt: Date.now(),
          dateISO,
          type,
          exerciseId,
          routineExerciseId: rx.id,
          routineId: routine.id,
          dayId: day.id,
          dayOrder: day.order,
          sets,
          summary,
          pr
        });

        afterSave(dateISO);
      }
    }, ["Save"]);

const cancelBtn = el("button", { class:"btn", onClick: Modal.close }, ["Cancel"]);

const sticky = el("div", { class:"logsetStickyBar" }, [ cancelBtn, saveBtn ]);

return el("div", { class:"card" }, [
  el("h2", { text:"Core" }),
  el("div", { class:"row2" }, [
    el("label", {}, [ el("span", { text:"Sets" }), setsInput ]),
    el("label", {}, [ el("span", { text:"Reps" }), repsInput ])
  ]),
  el("div", { class:"row2" }, [
    el("label", {}, [ el("span", { text:"Time (min)" }), timeMinInput ]),
    el("label", {}, [ el("span", { text:"Time (sec)" }), timeSecInput ])
  ]),
  el("label", {}, [ el("span", { text:"Weight" }), weightInput ]),
  sticky
]);

  }

  function formatEntryOneLine(type, entry){
    try{
      if(type === "weightlifting"){
        const bw = entry?.summary?.bestWeight;
        const vol = entry?.summary?.totalVolume;
        return `Top ${bw ?? "—"} • Vol ${vol ?? "—"}`;
      }
      if(type === "cardio"){
        const d = entry?.summary?.distance;
        const t = entry?.summary?.timeSec;
        const p = entry?.summary?.paceSecPerUnit;
        return `${d ?? "—"} units • ${formatTime(t ?? 0)} • Pace ${formatPace(p)}`;
      }
      const v = entry?.summary?.totalVolume;
      return `Volume ${v ?? "—"}`;
    }catch(e){
      return "—";
    }
  }
}


