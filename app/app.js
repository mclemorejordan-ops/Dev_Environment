/********************
 * 1) State + Storage (imported)
 ********************/
import {
  STORAGE_KEY,
  REMOTE_VERSION_URL,
  SCHEMA_VERSION,
  VERSION_LATEST_KEY,
  VERSION_APPLIED_KEY,
  VERSION_NOTES_KEY,
  VERSION_BUILD_KEY,
  DefaultState,
  migrateState
} from "./state.js";


import {
  BackupVault,
  Storage,
  getLastExportAt,
  setLastExportAt,
  EXPORT_META_KEY,
  handleStorageWriteError
} from "./storage.js";


import {
  $, el, uid, pad2,
  Dates,
  bytesToNice, appStorageBytes,
  showToast,
  lockBodyScroll, unlockBodyScroll,
  Modal, bindModalControls,
  PopoverOpen, PopoverClose,
  confirmModal
} from "./ui.js";

bindModalControls();


import {
  initVersioning,
  bindHeaderPills,
  setHeaderPills,
  checkForUpdates,
  registerServiceWorker,
  openVersionModal,
  applyUpdateNow,
  __hasSwUpdateWaiting
} from "./versioning.js";

import { initRoutinesEngine } from "./routines.js";

import { initLibrary } from "./library.js";

import { initLogs } from "./logs.js";

import { initWorkouts } from "./workouts.js";
import { initProgress } from "./progress.js";

import { initAttendance } from "./attendance.js";

import { initBackup } from "./backup.js";

import { initSettings } from "./settings.js";

import { initProteinUI } from "./protein-ui.js";

import { initAttendanceUI } from "./attendance-ui.js";

import { initRouter } from "./router.js";

import { initBootstrap } from "./bootstrap.js";

// ✅ Load state AFTER Storage exists
let state = Storage.load();


// 1) Init Backup FIRST so we have the functions
const Backup = initBackup({
  getState: () => state,
  setState: (next) => { state = next; },
  Storage,
  BackupVault,
  migrateState
});

const {
  downloadTextFile,
  exportBackupJSON,
  validateImportedState,
  importBackupJSON
} = Backup;

// 2) Init Settings AFTER backup functions exist
const Settings = initSettings({
  getState: () => state,
  Storage,
  Modal,
  el,
  $,
  showToast,
  appStorageBytes,
  bytesToNice,
  exportBackupJSON,
  importBackupJSON,
  downloadTextFile,
  openVersionModal
});

const { renderSettingsView } = Settings;

const Logs = initLogs({ getState: () => state, Storage, uid });

const { LogEngine, removeWorkoutEntryById } = initWorkouts({ getState: () => state, Storage });


const Attendance = initAttendance({
  getState: () => state,
  Storage,
  LogEngine,
  el
});

const {
  attendanceHas,
  attendanceAdd,
  attendanceRemove,
  hasRoutineExerciseLog,
  lifetimeMaxSet,
  setNextNudge,
  ensureFloatNext,
  maybeShowNextNudge,
  bindFloatNext,
  clearNextNudge
} = Attendance;

const {
  round2,
  formatTime,
  formatPace,
  destroyProgressChart,
  downloadCanvasPNG,
  buildSeries,
  renderProgressChart,
  WeightEngine,
  destroyWeightChart,
  renderWeightChart
} = initProgress({ getState: () => state, Storage, uid, Dates, Modal, el });

const {
  findProteinEntry,
  ensureProteinEntry,
  cleanupProteinEntryIfEmpty,
  getProteinForDate,
  upsertMeal
} = Logs.protein;



// Provide live state ref to versioning module so it can flush safely before reload/update
initVersioning({ getStateRef: () => state });

// Phase 2.2: Ensure debounced writes are not lost on iOS/tab close/background
try{
  document.addEventListener("visibilitychange", () => {
    if(document.visibilityState === "hidden"){
      try{ Storage.flush(state); }catch(_){}
    }
  });
  window.addEventListener("pagehide", () => {
    try{ Storage.flush(state); }catch(_){}
  });
  window.addEventListener("beforeunload", () => {
    try{ Storage.flush(state); }catch(_){}
  });
}catch(_){}



const UIState = window.__GymDashUIState || (window.__GymDashUIState = {
  settings: {
    q: "",
    open: { "profile": true, "library": false, "backup": false, "data": false, "debug": false }
  },
  libraryManage: {
    q: "",
    type: "weightlifting",
    equipment: "all"
  },

  // Home-only UI prefs (safe: does not touch app state schema)
  home: {
    // Default collapsed for Today’s workout planned list
    todayWorkoutCollapsed: true
  }
});


    function getTodayWorkout(){
      const routine = Routines.getActive();
      if(!routine || !(routine.days?.length)) return { routine: null, day: null, dayIndex: null };

      const today = new Date();
      const idx = today.getDay(); // 0=Sun..6=Sat
      // Our routine days are stored order 0..6 (Day 1..Day 7)
      const day = routine.days.find(d => d.order === idx) || routine.days[idx] || null;
      return { routine, day, dayIndex: idx };
    }

/********************
 * Attendance Calendar UI (Phase 3.5) — moved to /app/attendance-ui.js
 ********************/
const AttendanceUI = initAttendanceUI({
  getState: () => state,
  Storage,
  pad2
});

const {
  isTrained,
  toggleTrained,
  ymFromISO,
  monthTitle,
  daysInMonth,
  firstDayDow,
  isoForYMD,
  AttendanceEngine
} = AttendanceUI;

// ─────────────────────────────
// Phase 3.2: Exercise Library + Templates extracted to /app/library.js
// ─────────────────────────────
const Library = initLibrary({
  getState: () => state,
  Storage,
  uid
});

const {
  ExerciseLibrary,
  RoutineTemplates,
  createRoutineFromTemplate,
  repairExerciseLinks,
  normName
} = Library;

/********************
 * 4b) Routine Engine (Step 4) — moved to /app/routines.js
 ********************/
const { Routines, resolveExerciseName } = initRoutinesEngine({
  getState: () => state,
  Storage,
  uid,
  ExerciseLibrary,
  RoutineTemplates,
  createRoutineFromTemplate
});


/********************
 * 4c) Protein UI (Step 4) — moved to /app/protein-ui.js
 ********************/


/********************
 * 🔥 Crash Failsafe (prevents blank UI)
 ********************/
function __formatErr(err){
  try{
    if(!err) return "Unknown error";
    if(typeof err === "string") return err;
    if(err instanceof Error) return `${err.name}: ${err.message}\n${err.stack || ""}`.trim();
    return JSON.stringify(err, null, 2);
  }catch(e){
    return "Unrenderable error";
  }
}

function __showFatalOverlay(title, detail){
  try{
    // avoid duplicates
    const existing = document.getElementById("fatalOverlay");
    if(existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "fatalOverlay";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:9999",
      "background:rgba(11,15,23,.94)",
      "backdrop-filter: blur(12px)",
      "color:rgba(255,255,255,.92)",
      "padding:18px",
      "display:flex",
      "align-items:center",
      "justify-content:center"
    ].join(";");

    const card = document.createElement("div");
    card.style.cssText = [
      "width:min(720px, 92vw)",
      "border:1px solid rgba(255,255,255,.14)",
      "background:rgba(255,255,255,.06)",
      "border-radius:18px",
      "box-shadow:0 22px 70px rgba(0,0,0,.65)",
      "padding:16px"
    ].join(";");

    const h = document.createElement("div");
    h.textContent = title || "App error";
    h.style.cssText = "font-weight:900; font-size:16px; letter-spacing:.2px; margin-bottom:10px;";

    const p = document.createElement("div");
    p.textContent = "The app hit an error and stopped rendering. Copy the details below and send it to yourself.";
    p.style.cssText = "color:rgba(255,255,255,.68); font-size:13px; line-height:1.35; margin-bottom:12px;";

    const pre = document.createElement("pre");
    pre.textContent = detail || "No details available";
    pre.style.cssText = [
      "white-space:pre-wrap",
      "word-break:break-word",
      "margin:0",
      "padding:12px",
      "border-radius:14px",
      "border:1px solid rgba(255,255,255,.12)",
      "background:rgba(0,0,0,.22)",
      "color:rgba(255,255,255,.86)",
      "font-size:12px",
      "line-height:1.35",
      "max-height:52vh",
      "overflow:auto"
    ].join(";");

    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:10px; margin-top:12px; flex-wrap:wrap;";

    const btnReload = document.createElement("button");
    btnReload.className = "btn primary";
    btnReload.textContent = "Reload app";
    btnReload.onclick = () => location.reload();

    const btnClose = document.createElement("button");
    btnClose.className = "btn";
    btnClose.textContent = "Dismiss";
    btnClose.onclick = () => overlay.remove();

    row.appendChild(btnReload);
    row.appendChild(btnClose);

    card.appendChild(h);
    card.appendChild(p);
    card.appendChild(pre);
    card.appendChild(row);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }catch(e){
    // last resort: at least log
    console.error("Fatal overlay failed:", e);
  }
}

function __fatal(err, context){
  const detail = `[${context || "runtime"}]\n` + __formatErr(err);
  console.error("FATAL:", detail);
  __showFatalOverlay("Gym Dashboard crashed", detail);
}

// Catch synchronous runtime errors
window.addEventListener("error", (ev) => {
  __fatal(ev?.error || ev?.message || ev, "window.error");
});

// Catch async errors (Promise rejections)
window.addEventListener("unhandledrejection", (ev) => {
  __fatal(ev?.reason || ev, "unhandledrejection");
});

/********************
* 6) Router (extracted to router.js)
********************/

// IMPORTANT: Protein UI needs navigate(), but Router wiring happens later (after Views exist).
// If we reference `const navigate` before it’s initialized, JS throws a TDZ ReferenceError.
// So we define a safe placeholder here and assign the real Router.navigate in the 7b block.
let navigate = (route) => {
  try{
    // fallback behavior if called extremely early (should be rare)
    const r = String(route || "").replace(/^#/, "");
    if(r) location.hash = `#${r}`;
  }catch(_){}
};

/********************
 * 6b) Protein UI wiring (Phase 3.4)
 ********************/
const ProteinUI = initProteinUI({
  getState: () => state,
  Storage,
  Dates,
  Modal,
  el,
  $,

  // ✅ IMPORTANT: pass a wrapper so ProteinUI always uses the latest `navigate`
  // (the variable is reassigned later to Router.navigate)
  navigate: (route) => navigate(route),

  UIState,
  showToast,

  findProteinEntry,
  cleanupProteinEntryIfEmpty,
  upsertMeal
});

const { buildProteinTodayModal, deleteMeal, totalProtein } = ProteinUI;



/********************
     * 7) Views
********************/
 const Views = {   
    Onboarding(){
  let hideRestDays = true;
  let selectedTpl = "ppl";
  let trackProtein = true; // ✅ NEW: default ON for onboarding toggle

  const errorBox = el("div", { class:"note", style:"display:none; color: rgba(255,92,122,.95);" });

  const switchNode = el("div", { class:"switch on" });
  switchNode.addEventListener("click", () => {
    hideRestDays = !hideRestDays;
    switchNode.classList.toggle("on", hideRestDays);
  });

  // ✅ NEW: Track Protein toggle (default ON)
  const proteinSwitchNode = el("div", { class:"switch on" });

  const tplCardsHost = el("div", { class:"tplGrid" });
  const renderTplCards = () => {
    tplCardsHost.innerHTML = "";
    RoutineTemplates.forEach(t => {
      tplCardsHost.appendChild(el("div", {
        class: "tpl" + (t.key === selectedTpl ? " selected" : ""),
        onClick: () => { selectedTpl = t.key; renderTplCards(); }
      }, [
        el("div", { class:"name", text: t.name }),
        el("div", { class:"desc", text: t.desc })
      ]));
    });
  };
  renderTplCards();

  const nameInput = el("input", { type:"text", placeholder:"Jordan" });
  const proteinInput = el("input", { type:"number", inputmode:"numeric", placeholder:"180", min:"0" });
         
  const weekSelect = el("select", {});
  weekSelect.appendChild(el("option", { value:"mon", text:"Monday" }));
  weekSelect.appendChild(el("option", { value:"sun", text:"Sunday" }));
  weekSelect.value = "mon";

  // ✅ Wrap protein input label so we can show/hide it safely
  const proteinLabel = el("label", {}, [
    el("span", { text:"Protein goal (grams/day)" }),
    proteinInput
  ]);

  proteinSwitchNode.addEventListener("click", () => {
    trackProtein = !trackProtein;
    proteinSwitchNode.classList.toggle("on", trackProtein);

    // Show/hide protein goal input
    proteinLabel.style.display = trackProtein ? "" : "none";

    // If turning off, clear any protein-related error
    if(!trackProtein){
      errorBox.style.display = "none";
      errorBox.textContent = "";
    }
  });

  const finish = () => {
    errorBox.style.display = "none";
    errorBox.textContent = "";

    const cleanName = (nameInput.value || "").trim();
    const cleanProtein = Number(proteinInput.value);
    const weekStartsOn = weekSelect.value === "sun" ? "sun" : "mon";

    if(!cleanName){
      errorBox.textContent = "Please enter your name.";
      errorBox.style.display = "block";
      return;
    }

    // ✅ Only require protein if Track Protein is ON
    if(trackProtein){
      if(!Number.isFinite(cleanProtein) || cleanProtein <= 0){
        errorBox.textContent = "Please enter a valid daily protein goal (grams).";
        errorBox.style.display = "block";
        return;
      }
    }

    const profile = {
      name: cleanName,
      proteinGoal: trackProtein ? Math.round(cleanProtein) : 0, // ✅ NEW behavior
      weekStartsOn,
      hideRestDays: !!hideRestDays,

      // ✅ existing behavior you already added
      show3DPreview: true
    };

    // Seed library FIRST so template exercises can resolve to real exerciseIds
    ExerciseLibrary.ensureSeeded();

    const routineName = RoutineTemplates.find(t => t.key === selectedTpl)?.name || "Routine";
    const routine = createRoutineFromTemplate(selectedTpl, routineName);

    state.profile = profile;
    state.routines = [routine];
    state.activeRoutineId = routine.id;

    // Repair any missing links (older data / edge cases)
    repairExerciseLinks();

    Storage.save(state);
    navigate("home");
    bindHeaderPills();
    setHeaderPills();
    checkForUpdates();
  };

  // Initial visibility (default ON)
  proteinLabel.style.display = trackProtein ? "" : "none";

  return el("div", { class:"grid" }, [
    el("div", { class:"card" }, [
      el("h2", { text:"Welcome" }),
      el("div", { class:"kpi" }, [
        el("div", { class:"big", text:"Let’s set up your dashboard" }),
        el("div", { class:"small", text:"Create your profile and choose a routine template. You can edit everything later." })
      ])
    ]),
    el("div", { class:"card" }, [
      el("h2", { text:"Create profile" }),
      el("div", { class:"form" }, [
        el("div", { class:"row2" }, [
          el("label", {}, [ el("span", { text:"Name" }), nameInput ]),
          proteinLabel
        ]),
        el("div", { class:"row2" }, [
          el("label", {}, [ el("span", { text:"Week starts on" }), weekSelect ]),
          el("div", {}, [
            // ✅ NEW toggle (placed near other preferences)
            el("div", { class:"toggle" }, [
              el("div", { class:"ttext" }, [
                el("div", { class:"a", text:"Track protein" }),
                el("div", { class:"b", text:"Optional — turn off if you don’t want protein goals right now" })
              ]),
              proteinSwitchNode
            ]),
            el("div", { style:"height:10px" }),
            el("div", { class:"toggle" }, [
              el("div", { class:"ttext" }, [
                el("div", { class:"a", text:"Hide rest days" }),
                el("div", { class:"b", text:"Rest days won’t appear on Home (Routine can still show them later)" })
              ]),
              switchNode
            ])
          ])
        ]),
        errorBox
      ])
    ]),
    el("div", { class:"card" }, [
      el("h2", { text:"Choose a routine template" }),
      tplCardsHost,
      el("div", { style:"height:10px" }),
      el("div", { class:"btnrow" }, [
        el("button", { class:"btn primary", onClick: finish }, ["Finish setup"]),
        el("button", {
          class:"btn danger",
          onClick: () => {
            Modal.open({
              title: "Reset local data",
              bodyNode: el("div", {}, [
                el("div", { class:"note", text:"This clears everything saved in this browser for the app." }),
                el("div", { style:"height:12px" }),
                el("div", { class:"btnrow" }, [
                  el("button", {
                    class:"btn danger",
                    onClick: () => {
                      try{ BackupVault.forceSnapshot(state, "pre-reset"); }catch(_){ }
                      Storage.reset();
                      state = Storage.load();
                      Modal.close();
                      navigate("home");
                    }
                  }, ["Reset"]),
                  el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
                ])
              ])
            });
          }
        }, ["Reset"])
      ])
    ])
  ]);
},

        Home(){
        ExerciseLibrary.ensureSeeded();
        WeightEngine.ensure();


        const todayISO = Dates.todayISO();
        const weekStartsOn = state.profile?.weekStartsOn || "mon";
        const weekStartISO = Dates.startOfWeekISO(todayISO, weekStartsOn);

        const { routine, day } = getTodayWorkout();

        const trainedThisWeek = [];
        for(let i=0;i<7;i++){
          const dISO = Dates.addDaysISO(weekStartISO, i);
          trainedThisWeek.push({ dateISO: dISO, trained: isTrained(dISO) });
        }

        // Protein
        const goal = Number(state.profile?.proteinGoal) || 0;
        const done = totalProtein(todayISO);
        const left = Math.max(0, goal - done);
        const pct = goal > 0 ? Math.max(0, Math.min(1, done / goal)) : 0;
        const deg = Math.round(pct * 360);

const openProteinModal = (dateISO = todayISO) => {
  Modal.open({
    title: "Protein",
    bodyNode: buildProteinTodayModal(dateISO, goal)
  });
};


        const openCheckIn = () => {
          toggleTrained(todayISO);
          renderView();
        };

        const workoutTitle = !routine ? "No routine selected"
          : (!day ? "No day found"
          : (day.isRest ? "Rest Day" : day.label));

        const workoutSub = !routine ? "Go to Routine → create/select a routine."
          : (!day ? "Open Routine Editor to fix day mapping."
          : (day.isRest ? "Recovery day. Hydrate + mobility."
          : `${(day.exercises || []).length} exercises planned`));

        const workoutExercises = (day?.isRest || !day) ? []
          : (day.exercises || []).map(rx => resolveExerciseName(rx.type, rx.exerciseId, rx.nameSnap));

        const ring = el("div", {
          class:"ringWrap",
          style: `background: conic-gradient(rgba(124,92,255,.95) 0deg ${deg}deg, rgba(255,255,255,.10) ${deg}deg 360deg);`
        }, [
          el("div", { class:"ringText" }, [
            el("div", { class:"big", text: `${left}g` }),
            el("div", { class:"small", text: "left" }),
            el("div", { class:"small", text: `${done} / ${goal}g` })
          ])
        ]);

        const dots = el("div", { class:"dots" });
        trainedThisWeek.forEach((d, idx) => {
          const dot = el("div", { class:"dotDay" + (d.trained ? " on" : "") });
          dots.appendChild(dot);
        });

        const weekLabel = weekStartsOn === "sun" ? "Week (Sun–Sat)" : "Week (Mon–Sun)";

        const wLatest = WeightEngine.latest();
        const wPrev = WeightEngine.previous();
        const wDelta = (wLatest && wPrev)
          ? (Number(wLatest.weight) - Number(wPrev.weight))
          : null;

        const wDeltaText = (wDelta === null || !Number.isFinite(wDelta))
          ? "—"
          : `${wDelta > 0 ? "+" : ""}${wDelta.toFixed(1)}`;

        return el("div", { class:"grid cols2" }, [
          el("div", { class:"card" }, [
  // Header row with collapse toggle
  el("div", { class:"cardHeadRow" }, [
    el("h2", { text:"Today’s workout" }),

    (() => {
      // Ensure home UI state exists + default collapsed
      UIState.home = UIState.home || {};
      if(typeof UIState.home.todayWorkoutCollapsed !== "boolean"){
        UIState.home.todayWorkoutCollapsed = true;
      }

      const label = UIState.home.todayWorkoutCollapsed ? "Show ▸" : "Hide ▾";

      return el("button", {
        class:"btn sm ghost",
        onClick: () => {
          UIState.home.todayWorkoutCollapsed = !UIState.home.todayWorkoutCollapsed;
          renderView();
        }
      }, [label]);
    })()
  ]),

  // ✅ KPI + action (Edit routine) on the same row
  el("div", { class:"homeRow" }, [
    el("div", { class:"kpi" }, [
      el("div", { class:"big", text: workoutTitle }),
      el("div", { class:"small", text: workoutSub })
    ]),
    el("button", {
      class:"btn",
      onClick: () => navigate("routine")
    }, ["Edit routine"])
  ]),

  // Collapsible body (planned exercises)
  (() => {
    UIState.home = UIState.home || {};
    if(typeof UIState.home.todayWorkoutCollapsed !== "boolean"){
      UIState.home.todayWorkoutCollapsed = true;
    }

    return el("div", {
      class:"collapseBody",
      style: UIState.home.todayWorkoutCollapsed ? "display:none;" : ""
    }, [
      el("div", { style:"height:10px" }),

      /* Planned exercises */
      (workoutExercises.length === 0)
        ? el("div", {
            class:"note",
            text: day?.isRest ? "Rest day is enabled." : "Add exercises in Routine Editor."
          })
        : el("div", { class:"list" }, workoutExercises.slice(0,6).map(n =>
            el("div", { class:"item" }, [
              el("div", { class:"left" }, [ el("div", { class:"name", text: n }) ]),
              el("div", { class:"actions" }, [ el("div", { class:"meta", text:"Planned" }) ])
            ])
          ))
    ]);
  })()
]),

// ✅ Removed from Today's Workout card:
// el("div", { style:"height:10px" }),
// el("div", { class:"btnrow" }, [
//   el("button", { class:"btn primary", onClick: openCheckIn }, [isTrained(todayISO) ? "Undo check-in" : "Check in"]),
//   el("button", { class:"btn", onClick: () => navigate("routine") }, ["Open Routine"])
// ])

// ✅ This Week — combined card (Attendance + Weight + Protein if enabled)
(() => {
  const sessionsThisWeek = trainedThisWeek.filter(x => x.trained).length;

  const sep = () => el("div", {
    style:"height:1px; background: rgba(255,255,255,.10); margin: 12px 0;"
  });

  return el("div", { class:"card" }, [
    el("div", {}, [
      el("h2", { text:"This Week" }),
      el("div", { class:"note", text: weekLabel })
    ]),

    // Attendance section
    el("div", { class:"homeRow" }, [
      el("div", { class:"kpi" }, [
        el("div", { class:"big", text: `${sessionsThisWeek} sessions` }),
        el("div", { class:"small", text:"Tap the dots to view your calendar." })
      ]),
      el("button", {
        class:"btn primary",
        onClick: openCheckIn
      }, [isTrained(todayISO) ? "Undo check-in" : "Check in"])
    ]),

    el("div", { style:"height:10px" }),

    // Dots preview (clickable)
    el("div", {
      onClick: () => navigate("attendance"),
      style:"cursor:pointer;"
    }, [ dots ]),

    el("div", { style:"height:10px" }),

    el("div", { class:"btnrow" }, [
      el("button", { class:"btn", onClick: () => navigate("attendance") }, ["View calendar"])
    ]),

    // Weight section
    sep(),

    el("div", { class:"homeRow" }, [
      el("div", { class:"kpi" }, [
        el("div", { class:"big", text: wLatest ? `${Number(wLatest.weight).toFixed(1)}` : "—" }),
        el("div", { class:"small", text: wLatest ? `Latest • ${wLatest.dateISO}` : "No weight entries yet." }),
        el("div", { class:"small", text: `Delta vs previous: ${wDeltaText}` })
      ]),
      el("button", {
        class:"btn",
        onClick: () => navigate("weight")
      }, ["Log weight"])
    ]),

    // Protein section (only if enabled)
    ...(goal > 0 ? [
      sep(),

      el("div", { class:"homeRow" }, [
        el("div", { class:"kpi" }, [
          el("div", { class:"big", text: `${left}g left` }),
          el("div", { class:"small", text: `${done} / ${goal}g today` }),
          el("div", { class:"small", text:"Tap the ring to log meals." })
        ]),
        el("div", { onClick: openProteinModal, style:"cursor:pointer;" }, [ ring ])
      ]),

      el("div", { style:"height:10px" }),

      el("div", { class:"btnrow" }, [
        el("button", { class:"btn primary", onClick: openProteinModal }, ["Log meals"])
      ])
        ] : [])
  ]);
})(),
    ]);
},
      ProteinHistory(){

        const root = el("div", { class:"grid" });

        // Read-only totals (do NOT call totalProtein() here because it can auto-create entries)
        function proteinTotalForDateRO(dateISO){
          const entry = (state?.logs?.protein || []).find(x => x.dateISO === dateISO);
          if(!entry || !Array.isArray(entry.meals)) return 0;
          return entry.meals.reduce((sum, m) => sum + (Number(m?.grams) || 0), 0);
        }

        function statusFor(total, goal){
          if(goal <= 0) return "No goal set";
          if(total >= goal) return "Goal Met";
          if(total >= (goal * 0.8)) return "Almost There";
          return "Under Goal";
        }

        function fmtDateLabel(dateISO){
          const d = new Date(String(dateISO) + "T00:00:00");
          if(isNaN(d.getTime())) return String(dateISO || "—");
          return d.toLocaleDateString(undefined, { month:"short", day:"numeric" });
        }

        const todayISO = Dates.todayISO();
        const weekStartsOn = state.profile?.weekStartsOn || "mon";
        const goal = Math.max(0, Math.round(Number(state?.profile?.proteinGoal || 0)));

        const startThisWeekISO = Dates.startOfWeekISO(todayISO, weekStartsOn);
        const startLastWeekISO = Dates.addDaysISO(startThisWeekISO, -7);

        // Collect logged days (from actual stored entries)
        const entries = Array.isArray(state?.logs?.protein) ? state.logs.protein.slice() : [];
        // keep only valid ISO-ish dates
        const cleaned = entries
          .filter(e => e && typeof e.dateISO === "string" && e.dateISO.length >= 10)
          .sort((a,b) => String(b.dateISO).localeCompare(String(a.dateISO)));

        // Week stats (this week)
        let weekLoggedDays = 0;
        let weekSum = 0;
        let weekBest = 0;
        let weekGoalMet = 0;

        for(let i=0;i<7;i++){
          const dISO = Dates.addDaysISO(startThisWeekISO, i);
          const total = proteinTotalForDateRO(dISO);
          const hasEntry = total > 0;
          if(hasEntry){
            weekLoggedDays++;
            weekSum += total;
            weekBest = Math.max(weekBest, total);
            if(goal > 0 && total >= goal) weekGoalMet++;
          }
        }

        const weekAvg = (weekLoggedDays > 0) ? Math.round(weekSum / weekLoggedDays) : 0;

        // Sticky in-view header (global header is already fixed)
        const headerRow = el("div", {
          style:[
            "position:sticky",
            "top:0",
            "z-index:5",
            "padding:6px 0 10px",
            "background: rgba(0,0,0,.18)",
            "backdrop-filter: blur(10px)"
          ].join(";")
        }, [
          el("div", { class:"homeRow" }, [
            el("button", { class:"btn", onClick: () => navigate("home") }, ["← Back"]),
            el("div", { style:"font-weight:900; letter-spacing:.2px;" , text:"Protein History" }),
            el("div", { style:"width:72px" }) // spacer to balance
          ])
        ]);

        function progressBar(total, goal){
          const pct = (goal > 0) ? Math.max(0, Math.min(1, total / goal)) : 0;
          return el("div", { class:"proteinBarTrack", style:"height:12px; border-radius:999px; overflow:hidden;" }, [
            el("div", { class:"proteinBarFill", style:`width:${Math.round(pct*100)}%; height:100%;` })
          ]);
        }

        const summaryCard = el("div", { class:"card" }, [
          el("h2", { text:"This Week" }),
          el("div", { class:"note", text:`${weekLoggedDays}/7 days logged • Avg: ${weekAvg}g` }),
          el("div", { class:"note", text:`Best: ${weekBest}g • Goal Met Days: ${weekGoalMet}` })
        ]);

        function dayCard(dateISO){
          const total = proteinTotalForDateRO(dateISO);
          const left = Math.max(0, goal - total);
          const st = statusFor(total, goal);

          const title = Dates.sameISO(dateISO, todayISO)
            ? `${fmtDateLabel(dateISO)} (Today)`
            : fmtDateLabel(dateISO);

          return el("div", { class:"card", style:"cursor:pointer;" , onClick: () => {
            // open the existing protein modal for that date
            UIState.protein = UIState.protein || {};
            UIState.protein.dateISO = dateISO;
            Modal.open({ title:"Protein", bodyNode: buildProteinTodayModal(dateISO, goal) });
          }}, [
            el("div", { class:"homeRow" }, [
              el("div", {}, [
                el("div", { style:"font-weight:900;", text: title }),
                el("div", { class:"note", text: `${left}g remaining • ${st}` })
              ]),
              el("div", { style:"font-weight:900;", text: `${total}g` })
            ]),
            el("div", { style:"height:10px" }),
            progressBar(total, goal)
          ]);
        }

        // Build sections
        const thisWeekDates = [];
        const lastWeekDates = [];

        for(let i=0;i<7;i++){
          thisWeekDates.push(Dates.addDaysISO(startThisWeekISO, i));
          lastWeekDates.push(Dates.addDaysISO(startLastWeekISO, i));
        }

        // Older: anything before last week start
        const olderDates = cleaned
          .map(x => x.dateISO)
          .filter(dISO => dISO < startLastWeekISO);

        function section(title, dateList){
          // show only days that actually have entries (plus today for “This Week” visibility)
          const cards = [];
          for(const dISO of dateList){
            const hasEntry = proteinTotalForDateRO(dISO) > 0;
            if(hasEntry || (title === "This Week" && Dates.sameISO(dISO, todayISO))){
              cards.push(dayCard(dISO));
            }
          }
          if(cards.length === 0) return null;

          return el("div", {}, [
            el("div", { class:"addExSectionLabel", text:title }),
            el("div", { style:"display:grid; gap:10px;" }, cards)
          ]);
        }

        // Compose
        root.appendChild(headerRow);
        root.appendChild(summaryCard);

        const a = section("This Week", thisWeekDates);
        const b = section("Last Week", lastWeekDates);
        const c = section("Older", olderDates);

        if(a) root.appendChild(a);
        if(b) root.appendChild(b);
        if(c) root.appendChild(c);

        // Empty state
        if(!a && !b && !c){
          root.appendChild(el("div", { class:"card" }, [
            el("h2", { text:"Protein History" }),
            el("div", { class:"note", text:"No protein logged yet." }),
            el("div", { style:"height:12px" }),
            el("button", { class:"btn primary", onClick: () => {
              UIState.protein = UIState.protein || {};
              UIState.protein.dateISO = todayISO;
              Modal.open({ title:"Protein", bodyNode: buildProteinTodayModal(todayISO, goal) });
            } }, ["Start today"])
          ]));
        }

        return root;
      },

Routine(){
const root = el("div", { class:"routinePage" });

  let routine = Routines.getActive();
  if(!routine){

    function openRoutineRecovery(){
      const body = el("div", {}, [
        el("div", { class:"note", text:"Choose a template to instantly recreate a routine. If you previously deleted everything, this is the fastest recovery." }),
        el("div", { style:"height:12px" })
      ]);

      const list = el("div", { class:"list" });

      (RoutineTemplates || []).forEach(tpl => {
        list.appendChild(el("div", {
          class:"item",
          onClick: () => {
            try{
              Routines.addFromTemplate(tpl.key, tpl.name); // seeds library + saves + sets active
              Modal.close();
              showToast(`Created: ${tpl.name}`);
              renderView(); // re-render current route (Routine)
            }catch(e){
              Modal.open({
                title:"Could not create routine",
                bodyNode: el("div", {}, [
                  el("div", { class:"note", text: e?.message || "Something went wrong while creating a routine." }),
                  el("div", { style:"height:12px" }),
                  el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
                ])
              });
            }
          }
        }, [
          el("div", { class:"left" }, [
            el("div", { class:"name", text: tpl.name }),
            el("div", { class:"meta", text: tpl.desc || "Template" })
          ]),
          el("div", { class:"actions" }, [
            el("div", { class:"meta", text:"Create" })
          ])
        ]));
      });

      body.appendChild(list);

      body.appendChild(el("div", { style:"height:14px" }));
      body.appendChild(el("div", { class:"btnrow" }, [
        el("button", { class:"btn", onClick: () => { Modal.close(); navigate("settings"); } }, ["Go to Settings"]),
        el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
      ]));

      Modal.open({
        title:"Create a routine",
        center: true,
        bodyNode: body
      });
    }

    root.appendChild(el("div", { class:"card" }, [
      el("h2", { text:"Routine" }),
      el("div", { class:"note", text:"No active routine found. Create one now (you don’t need Settings)." }),
      el("div", { style:"height:12px" }),
      el("div", { class:"btnrow" }, [
        el("button", { class:"btn primary", onClick: openRoutineRecovery }, ["Create routine"]),
        el("button", {
          class:"btn",
          onClick: () => {
            // Helpful shortcut: jump to Backup & Restore section
            UIState.settings = UIState.settings || {};
            UIState.settings.open = UIState.settings.open || {};
            UIState.settings.open.backup = true;
            navigate("settings");
          }
        }, ["Backup & Restore"])
      ])
    ]));

    return root;
  }

  const today = new Date();
  const todayIndex = today.getDay();               // 0=Sun..6=Sat
  const todayISO = Dates.todayISO(); // local date (fixes Feb 14 UTC bug)

  let selectedIndex = todayIndex;

    const weekStartsOn = state.profile?.weekStartsOn || "mon";
  const weekStartISO = Dates.startOfWeekISO(todayISO, weekStartsOn);

  // Map selected weekday index (0=Sun..6=Sat) to an actual calendar date in the current week
  function getSelectedDateISO(index){
    const offset = (weekStartsOn === "sun")
      ? index
      : ((index - 1 + 7) % 7); // Mon=0 ... Sun=6
    return Dates.addDaysISO(weekStartISO, offset);
  }
  // Label date as Today / Tomorrow / "Feb 15"
function prettyDayTag(dateISO){
  // ✅ hard guard
  if(!Dates.isISO(dateISO)) return "—";

  if(dateISO === todayISO) return "Today";
  if(dateISO === Dates.addDaysISO(todayISO, 1)) return "Tomorrow";

  return Dates.formatShort(dateISO); // "Feb 15" (never "Invalid Date")
}

  function getDay(index){
    routine = Routines.getActive(); // ✅ always refresh active routine
    return (routine?.days || []).find(d => d.order === index) || null;
  }
function openRoutinePicker(anchorBtn){
  let all = Routines.getAll() || [];
  const activeId = Routines.getActive()?.id || null;

  // Find an existing routine that was created from a template (preferred),
  // otherwise fall back to name match (for older saved data).
  function findRoutineForTemplate(tpl){
    const byKey = all.find(r => String(r.templateKey || "") === String(tpl.key || ""));
    if(byKey) return byKey;

    const byName = all.find(r => normName(r.name) === normName(tpl.name));
    return byName || null;
  }

// ────────────────────────────
// Visual-only layout upgrade
// Active pinned, rest scrollable
// ────────────────────────────

// Outer shell (column layout)
const shell = el("div", {
  style: "display:flex; flex-direction:column; max-height:70vh;"
});

// Title (fixed)
shell.appendChild(
  el("div", { class:"popTitle", text:"Select routine" })
);

// Identify active routine (visual only)
const activeRoutine = all.find(r => r.id === activeId);

// Fixed Active Section
if(activeRoutine){
  shell.appendChild(
    el("div", { style:"margin-top:8px;" }, [
      el("div", { class:"popItem" }, [
        el("div", { class:"l" }, [
          el("div", { class:"n", text: activeRoutine.name }),
          el("div", { class:"m", text:"Currently active" })
        ]),
        el("div", { class:"popBadge", text:"Active" })
      ])
    ])
  );

  shell.appendChild(el("div", {
    style:"height:1px; background:rgba(255,255,255,.08); margin:12px 0;"
  }));
}

// Scrollable area (existing + templates)
const scrollHost = el("div", {
  style:"overflow:auto; padding-right:4px; display:grid; gap:10px;"
});

// ────────────────────────────
// Existing routines (UNCHANGED LOGIC)
// ────────────────────────────

if(all.length === 0){
  scrollHost.appendChild(
    el("div", { class:"note", text:"No routines yet. Choose a template below to create one." })
  );
}else{
  all.forEach(r => {
    const isActive = (r.id === activeId);

    scrollHost.appendChild(
      el("div", {
        class:"popItem",
        onClick: () => {
          Routines.setActive(r.id);
          routine = Routines.getActive();
          selectedIndex = todayIndex;
          PopoverClose();
          repaint();
        }
      }, [
        el("div", { class:"l" }, [
          el("div", { class:"n", text:r.name }),
          el("div", { class:"m", text: isActive ? "Currently active" : "Tap to activate" })
        ]),
        isActive
          ? el("div", { class:"popBadge", text:"Active" })
          : el("div", { class:"m", text:"" })
      ])
    );
  });
}

// Spacer before templates
scrollHost.appendChild(el("div", { style:"height:12px" }));

// Templates title
scrollHost.appendChild(
  el("div", { class:"popTitle", text:"Default templates" })
);

// ────────────────────────────
// Default templates (UNCHANGED LOGIC)
// ────────────────────────────

(RoutineTemplates || []).forEach(tpl => {

  const existingAtRender = findRoutineForTemplate(tpl);
  const labelRight = existingAtRender ? "Activate" : "Add";

  scrollHost.appendChild(
    el("div", {
      class:"popItem",
      onClick: () => {

        all = Routines.getAll() || [];
        const existingNow = findRoutineForTemplate(tpl);

        if(existingNow){
          Routines.setActive(existingNow.id);
          routine = Routines.getActive();
          selectedIndex = todayIndex;

          PopoverClose();
          repaint();
          showToast(`Active: ${existingNow.name}`);
          return;
        }

        Routines.addFromTemplate(tpl.key, tpl.name);

        routine = Routines.getActive();
        selectedIndex = todayIndex;

        PopoverClose();
        repaint();
        showToast(`Created: ${tpl.name}`);
      }
    }, [
      el("div", { class:"l" }, [
        el("div", { class:"n", text: tpl.name }),
        el("div", { class:"m", text: tpl.desc || "Template" })
      ]),
      el("div", { class:"m", text: labelRight })
    ])
  );
});

// Attach scroll area
shell.appendChild(scrollHost);

// Open popover (same behavior)
PopoverOpen(anchorBtn, shell);
}

  // Phase 3: Per-exercise Workout Execution (logger)
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

function isDayComplete(dateISO, day){
  const ex = (day?.exercises || []);
  if(ex.length === 0) return false;
  return ex.every(rx => hasRoutineExerciseLog(dateISO, rx.id));
}
  function repaint(){
  routine = Routines.getActive();
  root.innerHTML = "";

  // Fixed (top) vs scrollable (below carousel)
  const fixedHost = el("div", { class:"routineFixed" });
  const scrollHost = el("div", { class:"routineScroll" });
  root.appendChild(fixedHost);
  root.appendChild(scrollHost);

  const day = getDay(selectedIndex);
  const selectedDateISO = getSelectedDateISO(selectedIndex);

function openExerciseHistoryModal(type, exerciseId, exNameOverride=null){
  LogEngine.ensure();

  const exName = exNameOverride || resolveExerciseName(type, exerciseId, "Exercise");
  const entries = LogEngine.entriesForExercise(type, exerciseId); // desc (most recent first)

  const head = el("div", { class:"note" }, [
    `${exName} • ${ExerciseLibrary.typeLabel(type)}`
  ]);

  const list = el("div", { class:"list" });

  if(entries.length === 0){
    list.appendChild(el("div", { class:"note", text:"No history yet for this exercise." }));
  }else{
    // Show last entry + recent history (top 12)
    entries.slice(0, 12).forEach(e => {
      list.appendChild(el("div", { class:"item" }, [
        el("div", { class:"left" }, [
          el("div", { class:"name", text: e.dateISO }),
          el("div", { class:"meta", text: formatEntryDetail(type, e) })
        ]),
        el("div", { class:"actions" }, [
          el("div", { class:"meta", text: prBadges(e.pr) })
        ])
      ]));
    });
  }

   Modal.open({
    title: "History",
    center: true,
    bodyNode: el("div", { class:"grid" }, [
      head,
      list,
      el("div", { style:"height:10px" }),
      el("button", { class:"btn", onClick: Modal.close }, ["Close"])
    ])
  });

  function prBadges(pr){
    if(!pr) return "";
    const b = [];
    if(pr.isPRWeight) b.push("PR W");
    if(pr.isPR1RM) b.push("PR 1RM");
    if(pr.isPRVolume) b.push("PR Vol");
    if(pr.isPRPace) b.push("PR Pace");
    return b.join(" • ");
  }

  function formatEntryDetail(type, entry){
    try{
      if(type === "weightlifting"){
        const sets = (entry.sets || []).map(s => `${s.weight || 0}×${s.reps || 0}`).join(" • ");
        const top = entry.summary?.bestWeight ?? "—";
        const vol = entry.summary?.totalVolume ?? "—";
        return `Sets: ${sets || "—"} | Top: ${top} | Vol: ${vol}`;
      }
      if(type === "cardio"){
        const d = entry.summary?.distance ?? "—";
        const t = formatTime(entry.summary?.timeSec ?? 0);
        const p = formatPace(entry.summary?.paceSecPerUnit);
        const inc = (entry.summary?.incline == null) ? "" : ` | Incline: ${entry.summary.incline}`;
        return `Dist: ${d} | Time: ${t} | Pace: ${p}${inc}`;
      }
      // core
      const s0 = (entry.sets || [])[0] || {};
      const vol = entry.summary?.totalVolume ?? "—";
      const repPart = (s0.sets && s0.reps) ? `${s0.sets}×${s0.reps}` : "";
      const timePart = (s0.timeSec && s0.timeSec > 0) ? formatTime(s0.timeSec) : "";
      const wPart = (s0.weight && s0.weight > 0) ? ` @ ${s0.weight}` : "";
      const detail = [repPart, timePart].filter(Boolean).join(" • ");
      return `${detail || "—"}${wPart} | Vol: ${vol}`;
    }catch(e){
      return "—";
    }
  }
}

    // ────────────────────────────
    // Header Card (locked layout)
    // ────────────────────────────
// ✅ NEW: persisted preference (default ON)
const show3DPreview = (state.profile?.show3DPreview !== false);

function setShow3DPreview(v){
  state.profile = state.profile || {};
  state.profile.show3DPreview = !!v;
  Storage.save(state);
  renderView(); // re-render Routine cleanly
}
    fixedHost.appendChild(el("div", { class:"card routineHeaderCard" }, [
  el("h2", { text:"Routine" }),
  el("div", { class:"note", text:`${routine.name} • ${weekStartsOn === "sun" ? "Sun–Sat" : "Mon–Sun"}` }),

  // ✅ Start Today (top-right)
  el("button", {
    class:"btn primary routineStartBtn",
    onClick: () => {
      selectedIndex = todayIndex;
      repaint();
      setTimeout(()=>{
        const first = scrollHost.querySelector("[data-unlogged='true']");
        if(first){
          first.scrollIntoView({ behavior:"smooth", block:"center" });
          first.classList.add("pulse");
          setTimeout(()=>first.classList.remove("pulse"),1200);
        }
      },0);
    }
  }, ["▶ Start Today"]),

  // ✅ 3D Preview toggle (bottom-right)
  el("button", {
    class:"btn mini routine3DToggle",
    onClick: () => setShow3DPreview(!show3DPreview)
  }, [`3D Preview: ${show3DPreview ? "ON" : "OFF"} 👁`]),

  el("div", { style:"height:10px" }),

  // Left-side: routine picker only
  el("div", { class:"rHdrRow" }, [
    el("button", {
      class:"btn ghost",
      onClick: (e) => openRoutinePicker(e.currentTarget)
    }, [`${routine.name} ▼`])
  ]),

  el("div", {
    class:"manageLink",
    onClick: () => navigate("routine_editor")
  }, ["Manage Routine ▾"])
]));


    if(!day){
      scrollHost.appendChild(el("div", { class:"card note" }, ["No day found."]));
      return;
    }

    // ────────────────────────────
    // 3D Card Carousel (visual container)
    // ────────────────────────────
// ✅ Only render the 3D carousel when enabled
if(show3DPreview){
  fixedHost.appendChild(el("div", { class:"card carouselCard" }, [
    (() => {
      let down = false;
      let startX = 0;
      let dx = 0;
      const THRESH = 55;

      function onDown(e){
        down = true;
        startX = e.clientX;
        dx = 0;
        try{ e.currentTarget.setPointerCapture(e.pointerId); }catch(_){}
      }
      function onMove(e){
        if(!down) return;
        dx = e.clientX - startX;
      }
      function onEnd(){
        if(!down) return;
        down = false;

        if(dx <= -THRESH) selectedIndex = (selectedIndex + 1) % 7;
        else if(dx >= THRESH) selectedIndex = (selectedIndex + 6) % 7;

        repaint();
      }

      const names = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

      const c3d = el("div", {
        class:"c3d",
        onPointerDown: onDown,
        onPointerMove: onMove,
        onPointerUp: onEnd,
        onPointerCancel: onEnd,
        onLostPointerCapture: onEnd
      }, []);

      const offsets = [-2,-1,0,1,2];
      offsets.forEach(off => {
        const idx = (selectedIndex + off + 7) % 7;
        const d = getDay(idx) || { label:"Day", isRest:false, exercises:[] };

        const abs = Math.abs(off);
        const scale = (off === 0) ? 1 : (1 - abs * 0.10);
        const x = off * 92;
        const z = -(abs * 95);
        const y = abs * 6;
        const rot = off * -22;
        const op = (off === 0) ? 1 : (abs === 1 ? .65 : .30);

        const chips = [];
        chips.push(el("div", { class:"c3dChip", text: d.isRest ? "Rest Day" : "Training Day" }));
        if(idx === selectedIndex) chips.push(el("div", { class:"c3dChip active", text:"Active" }));

        const card = el("div", {
          class: "c3dCard" + (idx === selectedIndex ? " sel" : ""),
          style: `transform: translateX(${x}px) translateY(${y}px) translateZ(${z}px) rotateY(${rot}deg) scale(${scale}); opacity:${op};`
        }, [
          el("div", {}, [
            el("div", { class:"c3dDay", text: names[idx].toUpperCase() }),
            el("div", { class:"c3dLabel", text: d.label || "Day" }),
            el("div", { class:"c3dMeta", text: d.isRest ? "Rest" : `${(d.exercises||[]).length} exercises` })
          ]),
          el("div", { class:"c3dChips" }, chips)
        ]);

        card.addEventListener("click", () => {
          selectedIndex = idx;
          repaint();
        });

        c3d.appendChild(card);
      });

      return c3d;
    })()
  ]));
}

fixedHost.appendChild(el("div", { class:"routineDayStrip" }, [
  ...(weekStartsOn === "sun" ? [0,1,2,3,4,5,6] : [1,2,3,4,5,6,0]).map(i => {
    const d = getDay(i) || { label:"", isRest:false, exercises:[] };

    // date number for the week (uses your already-defined weekStartISO)
    const dateISO = Dates.addDaysISO(weekStartISO, (i - (weekStartsOn === "sun" ? 0 : 1) + 7) % 7);
    const dayNum = (() => {
      try{ return new Date(dateISO + "T00:00:00").getDate(); }
      catch(_){ return ""; }
    })();

    const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][i].toUpperCase();
    const dayLabel = d.isRest ? "Rest" : (d.label || "Training");

    return el("button", {
      class: "routineDayBtn" + (i === selectedIndex ? " sel" : "") + (d.isRest ? " rest" : ""),
      onClick: () => { selectedIndex = i; repaint(); }
    }, [
      el("div", { class:"dow", text: dow }),
      el("div", { class:"num", text: String(dayNum || "") }),
      ...(show3DPreview 
            ? [] 
            : [el("div", { class:"lbl", text: dayLabel })]
        ),
      el("div", { class:"dot" })
    ]);
  })
]));


    // Rest Day
    if(day.isRest){
scrollHost.appendChild(el("div", { class:"card restCard" }, [
        el("h2", { text:"Rest" }),
        el("div", { class:"note", text:`Rest day scheduled for ${selectedDateISO}.` })
      ]));
      return;
    }
    // Day completion banner
    if(isDayComplete(selectedDateISO, day)){
scrollHost.appendChild(el("div", { class:"card" }, [
        el("h2", { text:"Completed" }),
        el("div", { class:"note", text:`All exercises logged for ${selectedDateISO}.` }),
        el("div", { style:"height:10px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn danger",
            onClick: () => {
              removeWorkoutEntriesForRoutineDay(selectedDateISO, routine.id, day.id);
              attendanceRemove(selectedDateISO);
              setNextNudge(null);
              repaint();
              showToast("Marked incomplete");
            }
          }, ["Mark incomplete"])
        ])
      ]));
    }


// ────────────────────────────
// Exercise Cards (compact)
// ────────────────────────────
(day.exercises || []).forEach(rx => {
  const exName = resolveExerciseName(rx.type, rx.exerciseId, rx.nameSnap);
  const logged = hasRoutineExerciseLog(selectedDateISO, rx.id);

  const max = lifetimeMaxSet(rx.type, rx.exerciseId);
  const maxText = max ? `${max.weight} × ${max.reps}` : "—";

  scrollHost.appendChild(el("div", {
    class:"card rxCard",
    // ✅ DOM selector hardening: namespace ids to this view
    id:`routine_rx_${rx.id}`,
    "data-unlogged": logged ? "false" : "true"
  }, [
    el("div", { class:"rxTop" }, [
      el("div", { class:"rxName", text: exName }),
      el("div", {
        class:"rxChip" + (logged ? " on" : ""),
        text: logged ? "Logged" : "Not logged"
      })
    ]),

    el("div", { class:"rxMeta", text:`🏆 Lifetime Max: ${maxText}` }),

    el("div", { class:"rxActions" }, [
      el("button", {
        class:"btn primary sm",
        onClick: () => openExerciseLogger(rx, day, selectedDateISO)
      }, ["Log Sets"]),

      el("button", {
        class:"btn ghost sm",
        onClick: () => openExerciseHistoryModal(rx.type, rx.exerciseId, exName)
      }, ["History →"])
    ])
  ]));
});

  }

  repaint();
  return root;
},

Progress(){
  ExerciseLibrary.ensureSeeded();
  LogEngine.ensure();

  // Defaults
  let type = "weightlifting";
  let exerciseId = (state.exerciseLibrary?.weightlifting?.[0]?.id) || null;

  // Filters
  let routineId = ""; // "" = All routines
  const todayISO = Dates.todayISO();

  // ✅ If you logged sets with a manual date override (including future dates),
  // default Progress "To" to the latest logged date so the chart/history populate.
  function latestWorkoutDateISO(){
    const arr = (state.logs?.workouts || []);
    let max = "";
    for(const e of arr){
      const d = String(e?.dateISO || "");
      // ISO YYYY-MM-DD strings compare correctly lexicographically
      if(d && d > max) max = d;
    }
    return max || null;
  }

  const latestISO = latestWorkoutDateISO();
  const defaultToISO = (latestISO && latestISO > todayISO) ? latestISO : todayISO;

  let toISO = defaultToISO;
  let fromISO = Dates.addDaysISO(toISO, -30);


  // Metric default per type
  let metric = defaultMetricForType(type);

  // Search state
  let query = "";

  const root = el("div", { class:"grid" });

  // Header
  root.appendChild(el("div", { class:"card" }, [
    el("h2", { text:"Progress" }),
    el("div", { class:"note", text:"Search an exercise, then view trends + history. Keep the graph front-and-center." })
  ]));

  // ────────────────────────────
  // Compact Controls + Overview (single card)
  // ────────────────────────────
  const topCard = el("div", { class:"card" }, [
    el("h2", { text:"Find exercise" })
  ]);

  // Type segmented
  const typeRow = el("div", { class:"segRow" });
  const typeBtns = {
    weightlifting: el("button", { class:"seg", onClick: () => setType("weightlifting") }, ["Weightlifting"]),
    cardio:        el("button", { class:"seg", onClick: () => setType("cardio") }, ["Cardio"]),
    core:          el("button", { class:"seg", onClick: () => setType("core") }, ["Core"])
  };
  typeRow.appendChild(typeBtns.weightlifting);
  typeRow.appendChild(typeBtns.cardio);
  typeRow.appendChild(typeBtns.core);

  // Search bar + selected pill
  const searchWrap = el("div", { class:"progSearch" }, [
    el("div", { class:"ico", text:"🔎" }),
    el("input", {
      type:"text",
      value:"",
      placeholder:"Search exercise (e.g., Bench, Squat, Treadmill)…",
      onInput: (e) => {
        query = String(e.target.value || "");
        repaint(false);
      }
    })
  ]);

  const selectedRow = el("div", { class:"pillRow" });
  const resultsHost = el("div", { class:"progResults" });

  // Routine select (kept, but compact)
  const routineSelect = el("select", {});
  routineSelect.appendChild(el("option", { value:"", text:"All routines" }));
  routineSelect.addEventListener("change", () => {
    routineId = routineSelect.value || "";
    repaint(true);
  });

  // Date range chips
  const rangeRow = el("div", { class:"segRow" });
  const r7  = el("button", { class:"seg", onClick: () => { setRange(7); } }, ["7D"]);
  const r30 = el("button", { class:"seg", onClick: () => { setRange(30); } }, ["30D"]);
  const r90 = el("button", { class:"seg", onClick: () => { setRange(90); } }, ["90D"]);
  const r1y = el("button", { class:"seg", onClick: () => { setRange(365); } }, ["1Y"]);
  rangeRow.appendChild(r7); rangeRow.appendChild(r30); rangeRow.appendChild(r90); rangeRow.appendChild(r1y);

  // Custom date inputs (still available, compact)
  const fromInput = el("input", { type:"date", value: fromISO });
  const toInput   = el("input", { type:"date", value: toISO });

  fromInput.addEventListener("change", () => {
    fromISO = fromInput.value || fromISO;
    if(fromISO > toISO){
      toISO = fromISO;
      toInput.value = toISO;
    }
    repaint(true);
  });

  toInput.addEventListener("change", () => {
    toISO = toInput.value || toISO;
    if(toISO < fromISO){
      fromISO = toISO;
      fromInput.value = fromISO;
    }
    repaint(true);
  });

  // Metric segmented
  const metricRow = el("div", { class:"segRow" });

  // Overview host (compact KPIs)
const statsHost = el("div", { class:"pillRow", style:"margin-top:8px;" });

  topCard.appendChild(el("div", { class:"note", text:"Type + search to select an exercise." }));
  topCard.appendChild(typeRow);
  topCard.appendChild(el("div", { style:"height:10px" }));
  topCard.appendChild(searchWrap);
  topCard.appendChild(selectedRow);
  topCard.appendChild(resultsHost);

  topCard.appendChild(el("div", { style:"height:10px" }));

// Dates (single-line)
topCard.appendChild(el("div", {
  style:"display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:2px;"
}, [
  el("div", { class:"note", text:"From:" }),
  fromInput,
  el("div", { class:"note", text:"|" }),
  el("div", { class:"note", text:"To:" }),
  toInput
]));

  topCard.appendChild(el("div", { style:"height:8px" }));
  topCard.appendChild(el("div", { class:"note", text:"Metric" }));
  topCard.appendChild(metricRow);

  topCard.appendChild(el("div", { style:"height:10px" }));
  topCard.appendChild(el("div", { class:"note", text:"Overview" }));
  topCard.appendChild(statsHost);

  root.appendChild(topCard);

  // ────────────────────────────
  // Graph (primary focus)
  // ────────────────────────────
  const chartCard = el("div", { class:"card" }, [
    el("h2", { text:"Trend" })
  ]);
  const chartWrap = el("div", { class:"chartWrap" });
  const canvas = el("canvas", {});
  chartWrap.appendChild(canvas);
  const chartNote = el("div", { class:"note", style:"margin-top:10px;" });

  chartCard.appendChild(chartWrap);
  chartCard.appendChild(chartNote);
  root.appendChild(chartCard);

  // ────────────────────────────
  // History (collapsible)
  // ────────────────────────────
  const tableCard = el("div", { class:"card" }, [
    el("div", { class:"accItem" }, [
      el("div", {
        class:"accHead",
        onClick: () => {
          const body = tableCard.querySelector(".accBody");
          const caret = tableCard.querySelector(".accCaret");
          const isOpen = body.style.display === "block";
          body.style.display = isOpen ? "none" : "block";
          caret.textContent = isOpen ? "▾" : "▴";
        }
      }, [
        el("div", { class:"accTitle", text:"History" }),
        el("div", { class:"accCaret", text:"▾" })
      ]),
      el("div", { class:"accBody" }, [
        el("div", { class:"note", text:"Most recent logs for the selected exercise." }),
        el("div", { style:"height:8px" }),
        el("div", { class:"list", id:"progressHistoryHost" })
      ])
    ])
  ]);
  const tableHost = tableCard.querySelector("#progressHistoryHost");
  root.appendChild(tableCard);

  // Populate routine dropdown
  repaintRoutineSelect();

  // Initial paint
  repaint(true);
  return root;

  // ---- helpers ----
  function defaultMetricForType(t){
    if(t === "weightlifting") return "topWeight";
    if(t === "cardio") return "pace";
    return "volume";
  }

  function setType(next){
    type = next;
    query = "";
    searchWrap.querySelector("input").value = "";
    exerciseId = (state.exerciseLibrary?.[type]?.[0]?.id) || null;
    metric = defaultMetricForType(type);
    repaint(true);
  }

  function setRange(days){
    fromISO = Dates.addDaysISO(todayISO, -Math.max(1, Number(days) || 30));
    toISO = todayISO;
    fromInput.value = fromISO;
    toInput.value = toISO;
    repaint(true);
  }

  function repaintRoutineSelect(){
    routineSelect.innerHTML = "";
    routineSelect.appendChild(el("option", { value:"", text:"All routines" }));
    const all = Routines.getAll?.() || [];
    all.forEach(r => routineSelect.appendChild(el("option", { value:r.id, text:r.name })));
    routineSelect.value = routineId || "";
  }

  function setMetric(next){
    metric = next;
    repaint(true);
  }

  function repaintMetricRow(){
    metricRow.innerHTML = "";

    if(type === "weightlifting"){
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("topWeight") }, ["Top Weight"]));
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("est1RM") }, ["Est 1RM"]));
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("volume") }, ["Volume"]));
    } else if(type === "cardio"){
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("pace") }, ["Pace"]));
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("distance") }, ["Distance"]));
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("timeSec") }, ["Time"]));
    } else {
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("volume") }, ["Volume"]));
    }

    // active styles
    [...metricRow.querySelectorAll(".seg")].forEach(btn => {
      const v = (btn.textContent || "").toLowerCase();
      const isActive =
        (metric === "topWeight" && v.includes("top")) ||
        (metric === "est1RM" && v.includes("1rm")) ||
        (metric === "volume" && v.includes("volume")) ||
        (metric === "pace" && v.includes("pace")) ||
        (metric === "distance" && v.includes("distance")) ||
        (metric === "timeSec" && v.includes("time"));
      btn.classList.toggle("active", isActive);
    });
  }

  function repaintTypeRow(){
    Object.entries(typeBtns).forEach(([k,btn]) => btn.classList.toggle("active", k === type));
  }

  function confirmDeleteLog(entry){
    Modal.open({
      title: "Delete log?",
      bodyNode: el("div", { class:"grid" }, [
        el("div", { class:"note", text:`This will permanently delete this log entry:` }),
        el("div", { class:"note", text:`${entry.dateISO} • ${tableLine(entry)}` }),
        el("div", { style:"height:10px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn danger",
            onClick: () => {
              removeWorkoutEntryById(entry.id);
              Modal.close();
              repaint(true);
              showToast("Deleted");
            }
          }, ["Delete"]),
          el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
        ])
      ]),
      size: "sm"
    });
  }

  function repaint(forceChart){
    repaintTypeRow();
    repaintMetricRow();

    // Exercise library for current type
    const lib = (state.exerciseLibrary?.[type] || []).slice()
      .sort((a,b) => (a.name||"").localeCompare(b.name||""));

    // Ensure exerciseId is valid
    if(lib.length === 0){
      exerciseId = null;
    }else{
      if(!exerciseId || !lib.some(x => x.id === exerciseId)) exerciseId = lib[0].id;
    }

    // Search results
    resultsHost.innerHTML = "";
    selectedRow.innerHTML = "";

    const selectedName = exerciseId ? resolveExerciseName(type, exerciseId, "Exercise") : null;

    if(selectedName){
      selectedRow.appendChild(el("div", { class:"pill" }, [
        el("div", { class:"t", text:selectedName }),
        el("button", {
          class:"x",
          onClick: () => {
            exerciseId = null;
            repaint(true);
          }
        }, ["×"])
      ]));
    } else {
      selectedRow.appendChild(el("div", { class:"note", text:"No exercise selected." }));
    }

    const q = normName(query);
    if(query && lib.length){
      const hits = lib.filter(x => normName(x.name).includes(q)).slice(0, 10);
      if(hits.length){
        const list = el("div", { class:"list", style:"margin-top:8px;" }, hits.map(x => {
          return el("div", {
            class:"item",
            onClick: () => {
              exerciseId = x.id;
              query = "";
              searchWrap.querySelector("input").value = "";
              repaint(true);
            }
          }, [
            el("div", { class:"left" }, [
              el("div", { class:"name", text:x.name }),
              el("div", { class:"meta", text: typeLabel(type) })
            ])
          ]);
        }));
        resultsHost.appendChild(list);
      } else {
        resultsHost.appendChild(el("div", { class:"note", text:"No matches. Try a different keyword." }));
      }
    }

    // Stats + chart + table only if exercise selected
    statsHost.innerHTML = "";
    tableHost.innerHTML = "";
    chartNote.textContent = "";

    if(!exerciseId){
      destroyProgressChart();
      chartNote.textContent = "Select an exercise to see your trend.";
      tableHost.appendChild(el("div", { class:"note", text:"Select an exercise to see history." }));
      return;
    }

    // Filter entries for selected exercise
const all = (state.logs?.workouts || []).filter(e =>
  e.type === type &&
  e.exerciseId === exerciseId &&
  (e.dateISO >= fromISO && e.dateISO <= toISO)
);


    // Overview KPIs
    const desc = all.slice().sort((a,b) => (b.dateISO||"").localeCompare(a.dateISO||"") || (b.createdAt||0)-(a.createdAt||0));
    const latest = desc[0] || null;

    const bests = LogEngine.lifetimeBests(type, exerciseId);
    const bestText = bestsText(type, bests);

    // Overview (single pill): { PR: xxx | Last: xxx }
const prVal = formatMetricValue(type, metric, prForMetric(type, metric, bests));
const lastVal = latest ? formatMetricValue(type, metric, metricValue(type, metric, latest)) : "—";

statsHost.appendChild(el("div", { class:"pill" }, [
  el("div", { class:"t", text:`{ PR: ${prVal} | Last: ${lastVal} }` })
]));

    // Chart (ascending for series builder)
    const asc = all.slice().sort((a,b) => (a.dateISO||"").localeCompare(b.dateISO||"") || (a.createdAt||0)-(b.createdAt||0));
    if(asc.length < 2){
      destroyProgressChart();
      chartNote.textContent = `Not enough data in this range (${fromISO} to ${toISO}). Log at least 2 sessions.`;
    }else{
      const series = buildSeries(type, asc);
      renderProgressChart(canvas, type, metric, series);
      chartNote.textContent = `${asc.length} points • ${fromISO} → ${toISO}`;
    }

    // History table
    if(desc.length === 0){
      tableHost.appendChild(el("div", { class:"note", text:"No logs in this range." }));
    }else{
      desc.slice(0, 40).forEach(entry => {
        tableHost.appendChild(el("div", { class:"item" }, [
          el("div", { class:"left" }, [
            el("div", { class:"name", text: entry.dateISO }),
            el("div", { class:"meta", text: tableLine(entry) })
          ]),
          el("div", { class:"actions" }, [
            el("button", { class:"mini danger", onClick: () => confirmDeleteLog(entry) }, ["Delete"])
          ])
        ]));
      });
    }
  }

  function typeLabel(t){
    if(t === "weightlifting") return "Weightlifting";
    if(t === "cardio") return "Cardio";
    return "Core";
  }

  function bestsText(t, bests){
    if(!bests) return "";
    if(t === "weightlifting"){
      const bw = bests.bestWeight != null ? `${Math.round(bests.bestWeight*10)/10} top` : "";
      const brm = bests.best1RM != null ? `${Math.round(bests.best1RM*10)/10} est 1RM` : "";
      const bv = bests.bestVolume != null ? `${Math.round(bests.bestVolume)} vol` : "";
      return [bw, brm, bv].filter(Boolean)[0] || "";
    }
    if(t === "cardio"){
      const bp = bests.bestPace != null ? `${formatTime(Math.round(bests.bestPace))} pace` : "";
      return bp || "";
    }
    const bv = bests.bestVolume != null ? `${Math.round(bests.bestVolume)} vol` : "";
    return bv || "";
  }

  // ✅ helpers must stay INSIDE Progress() (not inside Views object root)
  function metricValue(type, metric, entry){
    try{
      if(!entry) return null;

      if(type === "weightlifting"){
        if(metric === "topWeight") return entry.summary?.bestWeight ?? entry.summary?.topWeight ?? null;
        if(metric === "est1RM")    return entry.summary?.est1RM ?? null;
        if(metric === "volume")    return entry.summary?.totalVolume ?? null;
        return entry.summary?.bestWeight ?? null;
      }

      if(type === "cardio"){
        if(metric === "pace")     return entry.summary?.paceSecPerUnit ?? null;
        if(metric === "distance") return entry.summary?.distance ?? null;
        if(metric === "timeSec")  return entry.summary?.timeSec ?? null;
        return entry.summary?.paceSecPerUnit ?? null;
      }

      // core
      if(metric === "volume") return entry.summary?.totalVolume ?? null;
      return entry.summary?.totalVolume ?? null;
    }catch(e){
      return null;
    }
  }

  function prForMetric(type, metric, bests){
    try{
      if(!bests) return null;

      if(type === "weightlifting"){
        if(metric === "topWeight") return bests.bestWeight ?? null;
        if(metric === "est1RM")    return bests.best1RM ?? null;
        if(metric === "volume")    return bests.bestVolume ?? null;
        return bests.bestWeight ?? null;
      }

      if(type === "cardio"){
        if(metric === "pace")     return bests.bestPace ?? null;
        if(metric === "distance") return bests.bestDistance ?? null;
        if(metric === "timeSec")  return bests.bestTime ?? null;
        return bests.bestPace ?? null;
      }

      // core
      if(metric === "volume") return bests.bestVolume ?? null;
      return bests.bestVolume ?? null;
    }catch(e){
      return null;
    }
  }

  function formatMetricValue(type, metric, v){
    if(v == null) return "—";

    // cardio formatting
    if(type === "cardio" && metric === "pace") return formatPace(v);
    if(type === "cardio" && metric === "timeSec") return formatTime(v);

    // numeric formatting
    if(typeof v === "number"){
      const n = Math.round(v * 10) / 10;
      return String(n);
    }
    return String(v);
  }

  // ✅ FIX: was referenced but missing — caused Progress to crash
  function tableLine(entry){
    try{
      if(!entry) return "—";
      const t = entry.type || type;           // fall back to current Progress tab type
      const s = entry.summary || {};

      if(t === "weightlifting"){
        const bw  = (s.bestWeight != null) ? `${formatMetricValue("weightlifting","topWeight", s.bestWeight)} top` : "";
        const brm = (s.best1RM != null)    ? `${formatMetricValue("weightlifting","est1RM",    s.best1RM)} est1RM` : "";
        const bv  = (s.totalVolume != null)? `${formatMetricValue("weightlifting","volume",   s.totalVolume)} vol` : "";
        return [bw, brm, bv].filter(Boolean).join(" • ") || "—";
      }

      if(t === "cardio"){
        const pace = (s.paceSecPerUnit != null) ? `${formatMetricValue("cardio","pace", s.paceSecPerUnit)} pace` : "";
        const dist = (s.distance != null)       ? `${formatMetricValue("cardio","distance", s.distance)} dist` : "";
        const time = (s.timeSec != null)        ? `${formatMetricValue("cardio","timeSec", s.timeSec)} time` : "";
        return [pace, dist, time].filter(Boolean).join(" • ") || "—";
      }

      // core
      const vol = (s.totalVolume != null) ? `${formatMetricValue("core","volume", s.totalVolume)} vol` : "";
      return vol || "—";
    }catch(_){
      return "—";
    }
  }

},  // ✅ end Progress()
  Weight(){
  WeightEngine.ensure();

  const root = el("div", { class:"grid weightPage" });

  const todayISO = Dates.todayISO();

  // Local UI state
  let rangeDays = 30;      // 7, 30, 90, 365
  let historyOpen = false;

  // ---- UI: Summary (Top) ----
  const summaryCard = el("div", { class:"card" }, [
    el("div", { class:"weightTop" }, [
      el("div", {}, [
        el("h2", { text:"Weight" }),
        el("div", { class:"note", text:"Quick view + trend. Tap History to see past entries." })
      ]),
      el("button", {
        class:"btn primary weightLogBtn",
        onClick: () => openLogModal()
      }, ["+ Log"])
    ])
  ]);

  const summaryKpi = el("div", { class:"kpi weightSummaryKpi" });
  summaryCard.appendChild(summaryKpi);

  // ---- UI: Graph (Middle) ----
  const chartCard = el("div", { class:"card" }, [
    el("div", { class:"weightChartHead" }, [
      el("h2", { text:"Trend" }),
      el("div", { class:"segRow" }, [
        segBtn("7D", 7),
        segBtn("30D", 30),
        segBtn("90D", 90),
        segBtn("1Y", 365)
      ])
    ])
  ]);

  const chartWrap = el("div", { class:"chartWrap weightChartWrap" });
  const canvas = el("canvas", {});
  chartWrap.appendChild(canvas);
  const chartNote = el("div", { class:"note" });

  chartCard.appendChild(chartWrap);
  chartCard.appendChild(el("div", { style:"height:10px" }));
  chartCard.appendChild(chartNote);

  // ---- UI: History (Bottom - collapsible) ----
  const historyCard = el("div", { class:"card" }, [
    el("div", {
      class:"accHeader",
      onClick: () => {
        historyOpen = !historyOpen;
        repaintHistory();
      }
    }, [
      el("h2", { text:"History" }),
      el("div", { class:"accChevron", text:"▾" })
    ])
  ]);

  const historyBody = el("div", { class:"accBody" });
  const tableHost = el("div", { class:"list" });
  historyBody.appendChild(tableHost);
  historyCard.appendChild(historyBody);

  root.appendChild(summaryCard);
  root.appendChild(chartCard);
  root.appendChild(historyCard);

  repaintAll();
  return root;

  // -----------------------------
  // Helpers
  // -----------------------------
  function segBtn(label, days){
    const b = el("button", {
      class:"seg" + (days === rangeDays ? " active" : ""),
      onClick: () => {
        rangeDays = days;
        repaintChart();
        // update active styles
        const all = chartCard.querySelectorAll(".seg");
        all.forEach(x => x.classList.remove("active"));
        b.classList.add("active");
      }
    }, [label]);
    return b;
  }

  function openLogModal(){
    const dateInput = el("input", { type:"date", value: todayISO });
    const weightInput = el("input", { type:"number", inputmode:"decimal", placeholder:"e.g., 185.4", min:"0", step:"0.1" });
    const err = el("div", { class:"note", style:"display:none; color: rgba(255,92,122,.95);" });

    Modal.open({
      title: "Log weight",
      center: true,
      size: "sm",
      bodyNode: el("div", {}, [
        el("label", {}, [ el("span", { text:"Date" }), dateInput ]),
        el("label", {}, [ el("span", { text:"Weight (lb)" }), weightInput ]),
        err,
        el("div", { style:"height:12px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn primary",
            onClick: () => {
              try{
                err.style.display = "none";
                WeightEngine.add(dateInput.value || todayISO, weightInput.value);
                Modal.close();
                repaintAll();
              }catch(e){
                err.textContent = e.message || "Unable to save weight.";
                err.style.display = "block";
              }
            }
          }, ["Save"]),
          el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
        ])
      ])
    });
  }

  function repaintAll(){
    repaintSummary();
    repaintChart();
    repaintHistory(); // keeps collapsed by default
  }

  function repaintSummary(){
    const latest = WeightEngine.latest();
    const avg7 = WeightEngine.avg7(latest?.dateISO || todayISO);

    summaryKpi.innerHTML = "";

    const main = latest ? `${latest.weight}` : "—";
    const sub = latest
      ? ((latest.dateISO === todayISO) ? "Today" : `Latest • ${latest.dateISO}`)
      : "No weight entries yet.";

    // Change vs 7D avg (matches your mock)
    let change7 = null;
    if(latest && avg7 != null) change7 = round2((Number(latest.weight)||0) - (Number(avg7)||0));
    const change7Text = (change7 == null) ? "—" : (change7 > 0 ? `+${change7}` : `${change7}`);

    summaryKpi.appendChild(el("div", { class:"big", text: `${main} lb` }));
    summaryKpi.appendChild(el("div", { class:"small", text: sub }));
    summaryKpi.appendChild(el("div", { class:"small", text: `Change: ${change7Text} lb (7d)` }));
  }

  function repaintChart(){
    const ascAll = WeightEngine.listAsc();
    const asc = ascAll.slice(-rangeDays);

    if(asc.length < 2){
      destroyWeightChart();
      chartNote.textContent = "Add at least 2 entries to see the trend line.";
      return;
    }

    renderWeightChart(canvas, asc);
    chartNote.textContent = `Showing last ${asc.length} entries`;
  }

  function repaintHistory(){
    // collapsed by default
    historyCard.classList.toggle("open", !!historyOpen);
    historyBody.style.display = historyOpen ? "block" : "none";

    const chevron = historyCard.querySelector(".accChevron");
    if(chevron) chevron.textContent = historyOpen ? "▴" : "▾";

    if(!historyOpen) return;

    const desc = WeightEngine.listDesc();
    tableHost.innerHTML = "";

    if(desc.length === 0){
      tableHost.appendChild(el("div", { class:"note", text:"No entries yet. Tap + Log to add your first one." }));
      return;
    }

    desc.slice(0, 60).forEach(row => {
      tableHost.appendChild(el("div", { class:"item" }, [
        el("div", { class:"left" }, [
          el("div", { class:"name", text: row.dateISO }),
          el("div", { class:"meta", text: `${row.weight} lb` })
        ]),
        el("div", { class:"actions" }, [
          el("button", {
            class:"mini danger",
            onClick: () => {
              Modal.open({
                title: "Delete entry?",
                center: true,
                size: "sm",
                bodyNode: el("div", {}, [
                  el("div", { class:"note", text:`Delete ${row.weight} lb on ${row.dateISO}?` }),
                  el("div", { style:"height:12px" }),
                  el("div", { class:"btnrow" }, [
                    el("button", {
                      class:"btn danger",
                      onClick: () => {
                        WeightEngine.remove(row.id);
                        Modal.close();
                        repaintAll();
                      }
                    }, ["Delete"]),
                    el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
                  ])
                ])
              });
            }
          }, ["Delete"])
        ])
      ]));
    });
  }
},
  Attendance(){

        AttendanceEngine.ensure();

        // ✅ keep calendar month stable across re-renders (UI-only; not saved)
        const ui = UIState.attendance || (UIState.attendance = {});

        // default month = current (only if we haven't navigated months yet)
        const today = Dates.todayISO();
        let { y, m } = (ui.y && ui.m) ? { y: ui.y, m: ui.m } : ymFromISO(today);
        if(!ui.y || !ui.m){ ui.y = y; ui.m = m; }

        const weekStartsOn = state.profile?.weekStartsOn || "mon"; // affects calendar header order
        const weekStart = (weekStartsOn === "sun") ? 0 : 1;

        const root = el("div", { class:"grid" });

        const header = el("div", { class:"card" }, [
          el("h2", { text:"Attendance" }),
          el("div", { class:"note", text:"Tap a day to mark it trained. Shows monthly count + clear month." })
        ]);

        const card = el("div", { class:"card" }, [
          el("h2", { text:"Calendar" })
        ]);

        const wrap = el("div", { class:"calWrap" });
        const top = el("div", { class:"calTop" });

        const title = el("div", { class:"calTitle" });
        const monthKpi = el("div", { class:"note" });

        const prevBtn = el("button", { class:"btn", onClick: () => { stepMonth(-1); } }, ["Prev"]);
        const nextBtn = el("button", { class:"btn", onClick: () => { stepMonth(1); } }, ["Next"]);

        const clearBtn = el("button", {
          class:"btn danger",
          onClick: () => {
            Modal.open({
              title: "Clear this month?",
              bodyNode: el("div", {}, [
                el("div", { class:"note", text:`This removes all trained days for ${monthTitle(y,m)}.` }),
                el("div", { style:"height:12px" }),
                el("div", { class:"btnrow" }, [
                  el("button", {
                    class:"btn danger",
                    onClick: () => {
                      AttendanceEngine.clearMonth(y, m);
                      Modal.close();
                      repaint();

                      // ✅ preserve month when Attendance re-renders
                      ui.y = y; ui.m = m;

                      renderView(); // Home dots update too
                    }
                  }, ["Clear month"]),
                  el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
                ])
              ])
            });
          }
        }, ["Clear month"]);

        top.appendChild(el("div", { class:"btnrow" }, [prevBtn, nextBtn]));
        top.appendChild(el("div", { style:"flex:1" }));
        top.appendChild(clearBtn);

        const grid = el("div", { class:"calGrid" });

        wrap.appendChild(top);
        wrap.appendChild(el("div", { style:"height:10px" }));
        wrap.appendChild(title);
        wrap.appendChild(el("div", { style:"height:6px" }));
        wrap.appendChild(monthKpi);
        wrap.appendChild(el("div", { style:"height:12px" }));
        wrap.appendChild(grid);

        card.appendChild(wrap);
        root.appendChild(header);
        root.appendChild(card);

        repaint();
        return root;

        function stepMonth(delta){
          m += delta;
          if(m <= 0){ m = 12; y -= 1; }
          if(m >= 13){ m = 1; y += 1; }

          // ✅ persist selected month
          ui.y = y; ui.m = m;

          repaint();
        }

        function weekdayLabels(){
          const sun = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
          if(weekStart === 0) return sun;
          return ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
        }

        function repaint(){
          AttendanceEngine.ensure();

          // ✅ persist selected month (defensive)
          ui.y = y; ui.m = m;

          title.textContent = monthTitle(y, m);

          const count = AttendanceEngine.monthCount(y, m);
          monthKpi.textContent = `This month: ${count} sessions`;

          grid.innerHTML = "";

          // headers
          weekdayLabels().forEach(lbl => {
            grid.appendChild(el("div", { class:"calCell header", text: lbl }));
          });

          const dim = daysInMonth(y, m);
          const firstDow = firstDayDow(y, m); // 0=Sun..6=Sat

          // convert firstDow to our grid index based on weekStart
          let leading = firstDow - weekStart;
          if(leading < 0) leading += 7;

          for(let i=0;i<leading;i++){
            grid.appendChild(el("div", { class:"calCell blank", text:"" }));
          }

          for(let d=1; d<=dim; d++){
            const dateISO = isoForYMD(y, m, d);
            const on = isTrained(dateISO);

            const cell = el("div", {
              class: "calCell" + (on ? " on" : ""),
              text: String(d),
              onClick: () => {
                toggleTrained(dateISO);
                repaint();

                // ✅ preserve month when Attendance re-renders
                ui.y = y; ui.m = m;

                renderView(); // updates Home dots too
              }
            });

            grid.appendChild(cell);
          }

          // pad to full weeks for cleaner bottom edge (optional)
          const totalCells = 7 + leading + dim; // +7 for header row
          const remainder = totalCells % 7;
          if(remainder !== 0){
            const pads = 7 - remainder;
            for(let i=0;i<pads;i++){
              grid.appendChild(el("div", { class:"calCell blank", text:"" }));
            }
          }
        }
      },
         Settings(){
        // Persist across renders (not saved to Storage)
const ui = UIState.settings || (UIState.settings = {});

// ✅ ensure accordion state exists so taps don’t crash
if(!ui.open || typeof ui.open !== "object") ui.open = {};

// ✅ default: open Profile the first time Settings is visited
if(Object.keys(ui.open).length === 0) ui.open.profile = true;

        const normalize = (s) => (s||"").toString().trim().toLowerCase();

        // Accordion builder
        const makeSection = ({ key, title, subtitle, keywords, bodyNode }) => {
          const q = normalize(ui.q);
          const hay = normalize([title, subtitle, ...(keywords||[])].join(" "));
          const match = !q || hay.includes(q);

          // Auto-open if searching and matched
          const isOpen = !!ui.open?.[key] || (q && match);

          const item = el("div", { class:"accItem", style: match ? "" : "display:none;" });

          const head = el("div", {
            class:"accHead",
          onClick: () => {
  ui.open = ui.open || {};
  ui.open[key] = !ui.open[key];
  renderView();
}
          }, [
            el("div", {}, [
              el("div", { class:"accTitle", text: title }),
              el("div", { class:"accSub", text: subtitle })
            ]),
            el("div", { class:"accCaret", text: isOpen ? "−" : "+" })
          ]);

          const body = el("div", { class:"accBody", style: isOpen ? "" : "display:none;" }, [ bodyNode ]);

          item.appendChild(head);
          item.appendChild(body);
          return item;
        };

        // --- Profile controls ---
        const nameInput = el("input", { type:"text", value: state.profile?.name || "" });
        const proteinInput = el("input", { type:"number", min:"0", step:"1", value: (state.profile?.proteinGoal ?? 150) });

// Protein tracking is "off" when goal is 0
let trackProtein = Number(state.profile?.proteinGoal || 0) > 0;

const trackProteinSwitch = el("div", {
  class: "switch" + (trackProtein ? " on" : "")
});

// Protein goal row (hide/show)
const proteinRow = el("div", { class:"setRow" }, [
  el("div", {}, [
    el("div", { style:"font-weight:820;", text:"Daily protein goal" }),
    el("div", { class:"meta", text:"grams/day" })
  ]),
  proteinInput
]);
proteinRow.style.display = trackProtein ? "" : "none";

// Track protein row
const trackProteinRow = el("div", { class:"setRow" }, [
  el("div", {}, [
    el("div", { style:"font-weight:820;", text:"Track protein" }),
    el("div", { class:"meta", text:"Optional — turn off to disable protein goals" })
  ]),
  trackProteinSwitch
]);

trackProteinSwitch.addEventListener("click", () => {
  trackProtein = !trackProtein;
  trackProteinSwitch.classList.toggle("on", trackProtein);
  proteinRow.style.display = trackProtein ? "" : "none";
});
           
        const weekSelect = el("select", {});
        weekSelect.appendChild(el("option", { value:"sun", text:"Sunday" }));
        weekSelect.appendChild(el("option", { value:"mon", text:"Monday" }));

        // Backward compatible: accept older numeric values (0/1) if they exist
        const ws = state.profile?.weekStartsOn;
        const normalized =
          (ws === 0 || ws === "0" || ws === "sun") ? "sun" :
          (ws === 1 || ws === "1" || ws === "mon") ? "mon" :
          "mon";
        weekSelect.value = normalized;


        let hideRestDays = !!state.profile?.hideRestDays;
        let show3DPreview = (state.profile?.show3DPreview !== false); // default ON


        const hideRestSwitch = el("div", {
          class: "switch" + (hideRestDays ? " on" : ""),
          onClick: () => {
            hideRestDays = !hideRestDays;
            hideRestSwitch.classList.toggle("on", hideRestDays);
          }
        });

           // ✅ NEW: 3D Preview switch (persisted)
        const show3DSwitch = el("div", {
          class: "switch" + (show3DPreview ? " on" : ""),
          onClick: () => {
            show3DPreview = !show3DPreview;
            show3DSwitch.classList.toggle("on", show3DPreview);
          }
        });

        function saveProfile(){
          state.profile = state.profile || {};
          state.profile.name = (nameInput.value || "").trim();

          if(trackProtein){
          state.profile.proteinGoal = Math.max(0, Number(proteinInput.value || 0));
          if(state.profile.proteinGoal <= 0){
            showToast("Enter a protein goal");
            return;
          }
        }else{
          state.profile.proteinGoal = 0;
        }
          
          
          state.profile.weekStartsOn = (weekSelect.value === "sun") ? "sun" : "mon";
          state.profile.hideRestDays = !!hideRestDays;
          state.profile.show3DPreview = !!show3DPreview;
          Storage.save(state);
          showToast("Saved");
          renderView();
        }

        // --- Existing import/export helpers (reuse your current functions) ---
        function openImportPasteModal(){
          const ta = el("textarea", {
            style:"width:100%; min-height: 260px; border-radius: 14px; padding: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: rgba(255,255,255,.92); font-size: 12px; outline:none; resize: vertical;",
            placeholder:"Paste your backup JSON here…"
          });

          const err = el("div", { class:"note", style:"display:none; color: rgba(255,92,122,.95);" });

          Modal.open({
            title: "Import from paste",
            bodyNode: el("div", {}, [
              el("div", { class:"note", text:"This will overwrite your current data in this browser." }),
              el("div", { style:"height:10px" }),
              ta,
              err,
              el("div", { style:"height:12px" }),
              el("div", { class:"btnrow" }, [
                el("button", {
                  class:"btn danger",
                  onClick: () => {
                    err.style.display = "none";
                    try{
                      importBackupJSON(ta.value || "");
                      Modal.close();
                      navigate("home");
                    }catch(e){
                      err.textContent = e.message || "Import failed.";
                      err.style.display = "block";
                    }
                  }
                }, ["Import (overwrite)"]),
                el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
              ])
            ])
          });
        }

        function openImportFileModal(){
          const input = el("input", { type:"file", accept:"application/json,.json" });
          const err = el("div", { class:"note", style:"display:none; color: rgba(255,92,122,.95);" });

          Modal.open({
            title: "Import from file",
            bodyNode: el("div", {}, [
              el("div", { class:"note", text:"Choose a .json backup file. Import overwrites current data." }),
              el("div", { style:"height:10px" }),
              input,
              err,
              el("div", { style:"height:12px" }),
              el("div", { class:"btnrow" }, [
                el("button", {
                  class:"btn danger",
                  onClick: async () => {
                    err.style.display = "none";
                    try{
                      const f = input.files?.[0];
                      if(!f) throw new Error("Select a JSON file first.");
                      const txt = await f.text();
                      importBackupJSON(txt);
                      Modal.close();
                      navigate("home");
                    }catch(e){
                      err.textContent = e.message || "Import failed.";
                      err.style.display = "block";
                    }
                  }
                }, ["Import (overwrite)"]),
                el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
              ])
            ])
          });
        }

        // --- Section bodies ---
        const profileBody = el("div", {}, [
          el("div", { class:"setRow" }, [
            el("div", {}, [
              el("div", { style:"font-weight:820;", text:"Name" }),
              el("div", { class:"meta", text:"Shown on Home" })
            ]),
            nameInput
          ]),
          
          trackProteinRow,
          proteinRow,
          
          el("div", { class:"setRow" }, [
            el("div", {}, [
              el("div", { style:"font-weight:820;", text:"Week starts on" }),
              el("div", { class:"meta", text:"Affects Home week view" })
            ]),
            weekSelect
          ]),
          el("div", { class:"setRow" }, [
            el("div", {}, [
              el("div", { style:"font-weight:820;", text:"Hide rest days" }),
              el("div", { class:"meta", text:"Keep Home focused on training days" })
            ]),
            hideRestSwitch
          ]),
          el("div", { class:"setRow" }, [
            el("div", {}, [
              el("div", { style:"font-weight:820;", text:"3D Preview" }),
              el("div", { class:"meta", text:"Show/hide the 3D routine card preview on the Routine page" })
            ]),
            show3DSwitch
          ]),
          el("div", { style:"height:12px" }),
          el("div", { class:"btnrow" }, [
            el("button", { class:"btn primary", onClick: () => {
              try{ saveProfile(); }
              catch(e){
                Modal.open({
                  title:"Save failed",
                  bodyNode: el("div", {}, [
                    el("div", { class:"note", text: e?.message || "Could not save settings." }),
                    el("div", { style:"height:12px" }),
                    el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
                  ])
                });
              }
            }}, ["Save changes"])
          ])
        ]);

                // ────────────────────────────
        // Routines section (Recovery + Management)
        // ────────────────────────────
        function openCreateRoutineModal(afterCreateRoute=null){
          const body = el("div", {}, [
            el("div", { class:"note", text:"Pick a template to create a routine. This will set it as your active routine." }),
            el("div", { style:"height:12px" })
          ]);

          const list = el("div", { style:"display:grid; gap:10px;" });

          (RoutineTemplates || []).forEach(tpl => {
            list.appendChild(el("div", {
              class:"setLink",
              onClick: () => {
                try{
                  const r = Routines.addFromTemplate(tpl.key, tpl.name);
                  Modal.close();
                  showToast(`Created: ${r.name}`);
                  if(afterCreateRoute) navigate(afterCreateRoute);
                  else renderView();
                }catch(e){
                  Modal.open({
                    title:"Could not create routine",
                    bodyNode: el("div", {}, [
                      el("div", { class:"note", text: e?.message || "Something went wrong while creating a routine." }),
                      el("div", { style:"height:12px" }),
                      el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
                    ])
                  });
                }
              }
            }, [
              el("div", { class:"l" }, [
                el("div", { class:"a", text: tpl.name }),
                el("div", { class:"b", text: tpl.desc || "Template" })
              ]),
              el("div", { style:"opacity:.85", text:"+" })
            ]));
          });

          body.appendChild(list);

          body.appendChild(el("div", { style:"height:14px" }));
          body.appendChild(el("div", { class:"btnrow" }, [
            el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
          ]));

          Modal.open({
            title:"Create routine",
            center:true,
            bodyNode: body
          });
        }

        function openRenameRoutineModal(routine){
          const input = el("input", { type:"text", value: routine?.name || "" });

          Modal.open({
            title:"Rename routine",
            bodyNode: el("div", {}, [
              el("div", { class:"note", text:"Update the routine name." }),
              el("div", { style:"height:10px" }),
              input,
              el("div", { style:"height:12px" }),
              el("div", { class:"btnrow" }, [
                el("button", {
                  class:"btn primary",
                  onClick: () => {
                    try{
                      Routines.rename(routine.id, input.value || "");
                      Modal.close();
                      showToast("Renamed");
                      renderView();
                    }catch(e){
                      showToast(e?.message || "Rename failed");
                    }
                  }
                }, ["Save"]),
                el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
              ])
            ])
          });
        }

        const routinesBody = el("div", {}, [
          el("div", { class:"note", text:"Manage routines here. If you accidentally deleted everything, create a new routine below." }),
          el("div", { style:"height:10px" }),

          el("div", { class:"btnrow" }, [
            el("button", { class:"btn primary", onClick: () => openCreateRoutineModal("routine") }, ["+ Create routine"]),
            el("button", { class:"btn", onClick: () => navigate("routine") }, ["Open Routine"]),
            el("button", { class:"btn", onClick: () => navigate("routine_editor") }, ["Routine Editor"])
          ]),

          el("div", { style:"height:12px" }),

          (() => {
            const all = Routines.getAll() || [];
            const activeId = state.activeRoutineId || null;

            if(all.length === 0){
              return el("div", { class:"note", text:"No routines found. Tap “Create routine” to get started." });
            }

            const list = el("div", { style:"display:grid; gap:10px;" });

            all.forEach(r => {
              const isActive = (r.id === activeId);
              const meta = isActive ? "Active" : "Saved";

              list.appendChild(el("div", { class:"setRow" }, [
                el("div", {}, [
                  el("div", { style:"font-weight:850;", text: r.name || "Routine" }),
                  el("div", { class:"meta", text: meta })
                ]),
                el("div", { class:"btnrow", style:"justify-content:flex-end; flex-wrap:wrap;" }, [

                  el("button", {
                    class:"btn" + (isActive ? " primary" : ""),
                    onClick: () => {
                      try{
                        Routines.setActive(r.id);
                        showToast("Active routine set");
                        renderView();
                      }catch(e){
                        showToast(e?.message || "Could not set active");
                      }
                    }
                  }, [isActive ? "Active" : "Set active"]),

                  el("button", {
                    class:"btn",
                    onClick: () => openRenameRoutineModal(r)
                  }, ["Rename"]),

                  el("button", {
                    class:"btn",
                    onClick: () => {
                      try{
                        Routines.duplicate(r.id);
                        showToast("Routine duplicated");
                        renderView();
                      }catch(e){
                        showToast(e?.message || "Duplicate failed");
                      }
                    }
                  }, ["Duplicate"]),

                  el("button", {
                    class:"btn danger",
                    onClick: () => {
                      confirmModal({
                        title:"Delete routine",
                        note:`Delete “${r.name || "Routine"}”? This cannot be undone.\n\nTip: Auto Backups can restore if needed.`,
                        confirmText:"Delete",
                        danger:true,
                        onConfirm: () => {
                          try{
                            Routines.remove(r.id);
                            showToast("Routine deleted");
                            renderView();
                          }catch(e){
                            showToast(e?.message || "Delete failed");
                          }
                        }
                      });
                    }
                  }, ["Delete"])
                ])
              ]));
            });

            return list;
          })()
        ]);
           
        const libraryBody = el("div", {}, [
          el("div", { class:"setLink", onClick: () => navigate("exercise_library") }, [
            el("div", { class:"l" }, [
              el("div", { class:"a", text:"Open Exercise Library Manager" }),
              el("div", { class:"b", text:"Add, edit, and delete exercises" })
            ]),
            el("div", { style:"opacity:.8", text:"→" })
          ]),
          el("div", { style:"height:10px" }),
          el("div", { class:"note", text:"Tip: Exercises removed from the library will still display in old logs using the saved name snapshot." })
        ]);

        const backupBody = el("div", {}, [
          el("div", { class:"note", text:"Export your full app data as JSON. Import will overwrite your current data in this browser." }),

          // ───────────────
          // Export reminder
          // ───────────────
          el("div", { style:"height:10px" }),
          (() => {
            const last = (typeof getLastExportAt === "function") ? getLastExportAt() : 0;
            const never = !last || !Number.isFinite(last);
            const label = never
              ? "Last file backup: Never exported"
              : `Last file backup: ${new Date(last).toLocaleString()}`;
            const sub = never
              ? "Recommendation: export a file backup occasionally (helps if iOS clears storage / app is deleted)."
              : "Tip: auto backups protect against mistakes/bugs; file backups protect against phone/browser storage being wiped.";
            return el("div", { class:"note", text: `${label}\n${sub}` });
          })(),

          el("div", { style:"height:10px" }),

          // ───────────────
          // Export
          // ───────────────
          el("div", { class:"btnrow" }, [
            el("button", {
              class:"btn primary",
              onClick: () => {
                try{
                  const txt = exportBackupJSON();
                  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
                  downloadTextFile(`gym-dashboard-backup_${stamp}.json`, txt);

                  // ✅ track export for reminder UI (best-effort)
                  try{ if(typeof setLastExportAt === "function") setLastExportAt(Date.now()); }catch(_){}
                  showToast("Backup exported");
                }catch(e){
                  Modal.open({
                    title:"Export failed",
                    bodyNode: el("div", {}, [
                      el("div", { class:"note", text: e.message || "Could not export backup." }),
                      el("div", { style:"height:12px" }),
                      el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
                    ])
                  });
                }
              }
            }, ["Export JSON backup"]),

            el("button", {
              class:"btn",
              onClick: () => {
                Modal.open({
                  title: "Copy backup JSON",
                  bodyNode: el("div", {}, [
                    el("div", { class:"note", text:"Copy/paste this JSON anywhere safe." }),
                    el("div", { style:"height:10px" }),
                    el("textarea", {
                      style:"width:100%; min-height: 260px; border-radius: 14px; padding: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: rgba(255,255,255,.92); font-size: 12px; outline:none; resize: vertical;",
                    }, [exportBackupJSON()]),
                    el("div", { style:"height:12px" }),
                    el("button", { class:"btn primary", onClick: Modal.close }, ["Done"])
                  ])
                });
              }
            }, ["View JSON"])
          ]),

// ───────────────
// Auto backups (rolling snapshots)
// ───────────────
el("div", { style:"height:14px" }),
el("div", {
  class:"note",
  text:"Auto backups (recommended): the app keeps rolling snapshots so you can restore if something breaks."
}),
el("div", { style:"height:8px" }),

el("div", { class:"btnrow" }, [

  // Restore from Auto Backup
  el("button", {
    class:"btn",
    onClick: async () => {
      try{
        if(typeof BackupVault === "undefined" || !BackupVault.list){
          Modal.open({
            title:"Auto backups unavailable",
            bodyNode: el("div", {}, [
              el("div", { class:"note", text:"Auto backups are not enabled in this build." }),
              el("div", { style:"height:12px" }),
              el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
            ])
          });
          return;
        }

        const snapsRaw = await BackupVault.list(BackupVault.KEEP || 20);

        // Safety-net: remove duplicates (same createdAt)
        const seen = new Set();
        const snaps = (snapsRaw || []).filter(s => {
          const key = String(s?.createdAt ?? "");
          if(seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const container = el("div", {
          style:"max-height:70vh; overflow-y:auto; padding-right:6px;"
        });

        // Sticky Banner (always visible)
        container.appendChild(
          el("div", {
            style:[
              "position:sticky",
              "top:0",
              "z-index:5",
              "padding:10px 0",
              "background:rgba(20,20,30,.65)",
              "backdrop-filter:blur(8px)",
              "-webkit-backdrop-filter:blur(8px)",
              "border-bottom:1px solid rgba(255,255,255,.08)"
            ].join(";")
          }, [
            el("div", { style:"display:flex; align-items:center; gap:8px;" }, [
              el("div", { style:"width:8px;height:8px;border-radius:50%;background:#4CAF50;" }),
              el("div", { style:"font-weight:800;", text:"Auto Backups Active" })
            ]),
            el("div", { class:"note", text:`Keeping: ${BackupVault.KEEP || 20} snapshots` })
          ])
        );

        container.appendChild(el("div", { style:"height:12px" }));

        function normalizeReason(r){
          const rr = String(r || "").toLowerCase();
          if(rr.includes("pre-import")) return "Pre-Import";
          if(rr.includes("pre-reset")) return "Pre-Reset";
          if(rr.includes("manual")) return "Manual";
          return "Auto";
        }

        function badgeColor(label){
          const l = String(label || "").toLowerCase();
          if(l.includes("pre-import")) return "#FFC107";
          if(l.includes("pre-reset")) return "#F44336";
          if(l.includes("manual")) return "#2196F3";
          return "#4CAF50";
        }

        if(!snaps.length){
          container.appendChild(
            el("div", { class:"card" }, [
              el("div", { class:"note", text:"No auto backups found yet." })
            ])
          );
        }else{
          snaps.forEach(snap => {
            const dObj = new Date(Number(snap?.createdAt || Date.now()));
            const dt =
              dObj.toLocaleDateString(undefined, { month:"short", day:"numeric" }) +
              " • " +
              dObj.toLocaleTimeString(undefined, { hour:"2-digit", minute:"2-digit" });

            const c = snap?.counts || {};
            const reasonLabel = normalizeReason(snap?.reason);

            const card = el("div", {
              class:"card",
              style:"cursor:pointer;"
            }, [
              el("div", { style:"display:flex; justify-content:space-between; align-items:center;" }, [
                el("div", { style:"font-weight:900;", text: dt }),
                el("div", {
                  style:`
                    padding:4px 10px;
                    border-radius:999px;
                    font-size:11px;
                    font-weight:700;
                    background:${badgeColor(reasonLabel)}22;
                    color:${badgeColor(reasonLabel)};
                    border:1px solid ${badgeColor(reasonLabel)}55;
                  `
                }, [reasonLabel])
              ]),
              el("div", { style:"height:8px" }),
              el("div", { class:"note", text:`${c.routines||0} Routines • ${c.workouts||0} Workouts` }),
              el("div", { class:"note", text:`${c.protein||0} Protein • ${c.attendance||0} Attendance` })
            ]);

            card.onclick = () => {
              confirmModal({
                title:"Restore Snapshot?",
                note:`Restore snapshot from:\n${dt}\n\nThis will overwrite your current data.`,
                confirmText:"Restore",
                danger:true,
                onConfirm: () => {
                  try{
                    state = migrateState(snap.state);
                    Storage.save(state);
                    showToast("Snapshot restored");
                    Modal.close();
                    navigate("home");
                  }catch(err){
                    Modal.open({
                      title:"Restore failed",
                      bodyNode: el("div", {}, [
                        el("div", { class:"note", text: err?.message || "Could not restore snapshot." }),
                        el("div", { style:"height:12px" }),
                        el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
                      ])
                    });
                  }
                }
              });
            };

            container.appendChild(card);
            container.appendChild(el("div", { style:"height:10px" }));
          });
        }

        Modal.open({
          title:"Restore from Auto Backup",
          bodyNode: container
        });

      }catch(e){
        Modal.open({
          title:"Could not load auto backups",
          bodyNode: el("div", {}, [
            el("div", { class:"note", text: e?.message || "Could not read auto backups." }),
            el("div", { style:"height:12px" }),
            el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
          ])
        });
      }
    }
  }, ["Restore from Auto Backup"]),

  // Clear Auto Backups
  el("button", {
    class:"btn danger",
    onClick: () => {
      confirmModal({
        title:"Clear auto backups",
        note:"Deletes ALL auto backup snapshots stored on this device. This cannot be undone.",
        confirmText:"Clear auto backups",
        danger:true,
        onConfirm: async () => {
          try{
            if(typeof BackupVault !== "undefined" && BackupVault.clear){
              await BackupVault.clear();
              showToast("Auto backups cleared");
            }else{
              showToast("Auto backups not available");
            }
          }catch(_){
            showToast("Could not clear auto backups");
          }
        }
      });
    }
  }, ["Clear Auto Backups"])

]),


          // ───────────────
          // Import options
          // ───────────────
          el("div", { style:"height:14px" }),
          el("div", { class:"note", text:"Import options:" }),
          el("div", { style:"height:8px" }),
          el("div", { class:"btnrow" }, [
            el("button", { class:"btn danger", onClick: openImportPasteModal }, ["Import (paste JSON)"]),
            el("button", { class:"btn danger", onClick: openImportFileModal }, ["Import (upload file)"])
          ]),
          el("div", { style:"height:10px" }),
          el("div", { class:"note", text:"Tip: Export a file backup occasionally. Auto backups help you recover from mistakes/bugs, but a file backup is safer if iOS clears storage." })
        ]);
           
        const dataBody = el("div", {}, [
          el("div", { class:"note", text:"Repair tools and targeted clears." }),
          el("div", { style:"height:10px" }),

          el("div", { class:"setLink", onClick: () => {
            confirmModal({
              title: "Repair workout logs",
              note: "Removes duplicate log entries (same date + routine exercise). Keeps the most recent.",
              confirmText: "Repair logs",
              danger: true,
              onConfirm: () => {
                const seen = new Map();
                const cleaned = [];
                (state.logs?.workouts || [])
                  .slice()
                  .sort((a,b)=> (b.createdAt||0) - (a.createdAt||0))
                  .forEach(e => {
                    const key = `${e.dateISO}_${e.routineExerciseId}`;
                    if(!seen.has(key)){
                      seen.set(key,true);
                      cleaned.push(e);
                    }
                  });
                state.logs.workouts = cleaned;
                Storage.save(state);
                showToast("Duplicates removed");
              }
            });
          }}, [
            el("div", { class:"l" }, [
              el("div", { class:"a", text:"Repair workout logs" }),
              el("div", { class:"b", text:"Remove duplicates (keeps most recent)" })
            ]),
            el("div", { style:"opacity:.8", text:"→" })
          ]),

          el("div", { style:"height:10px" }),
          el("div", { class:"note", text:"Clear specific data:" }),
          el("div", { style:"height:8px" }),

          el("div", { class:"btnrow" }, [
            el("button", {
              class:"btn danger",
              onClick: () => confirmModal({
                title: "Clear workout logs",
                note: "Deletes all workout logs. This cannot be undone.",
                confirmText: "Clear workouts",
                danger: true,
                onConfirm: () => { state.logs.workouts = []; Storage.save(state); showToast("Workout logs cleared"); }
              })
            }, ["Clear workouts"]),
            el("button", {
              class:"btn danger",
              onClick: () => confirmModal({
                title: "Clear weight logs",
                note: "Deletes all weigh-ins. This cannot be undone.",
                confirmText: "Clear weight",
                danger: true,
                onConfirm: () => { state.logs.weight = []; Storage.save(state); showToast("Weight logs cleared"); }
              })
            }, ["Clear weight"])
          ]),
          el("div", { style:"height:10px" }),
          el("div", { class:"btnrow" }, [
            el("button", {
              class:"btn danger",
              onClick: () => confirmModal({
                title: "Clear protein logs",
                note: "Deletes all protein entries. This cannot be undone.",
                confirmText: "Clear protein",
                danger: true,
                onConfirm: () => { state.logs.protein = []; Storage.save(state); showToast("Protein logs cleared"); }
              })
            }, ["Clear protein"]),
            el("button", {
              class:"btn danger",
              onClick: () => confirmModal({
                title: "Clear attendance",
                note: "Deletes attendance history. This cannot be undone.",
                confirmText: "Clear attendance",
                danger: true,
                onConfirm: () => { state.attendance = []; Storage.save(state); showToast("Attendance cleared"); }
              })
            }, ["Clear attendance"])
          ])
        ]);

        const debugBody = el("div", {}, [
          el("div", { class:"note", text:`Schema v${state.schemaVersion} • Approx storage: ${bytesToNice(appStorageBytes())}` }),
          el("div", { style:"height:10px" }),
          el("div", { class:"btnrow" }, [
            el("button", {
              class:"btn",
              onClick: () => Modal.open({
                title: "Current State (JSON)",
                bodyNode: el("pre", { style:"white-space:pre-wrap; font-size:12px; color: rgba(255,255,255,.85);" }, [
                  JSON.stringify(state, null, 2)
                ])
              })
            }, ["View state JSON"]),
            el("button", {
              class:"btn danger",
              onClick: () => {
                Modal.open({
                  title: "Reset local data",
                  bodyNode: el("div", {}, [
                    el("div", { class:"note", text:"This clears everything saved in this browser for the app." }),
                    el("div", { style:"height:12px" }),
                    el("div", { class:"btnrow" }, [
                      el("button", {
                        class:"btn danger",
                        onClick: () => {
                          Storage.reset();
                          state = Storage.load();
                          Modal.close();
                          navigate("home");
                        }
                      }, ["Reset"]),
                      el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
                    ])
                  ])
                });
              }
            }, ["Reset local data"])
          ])
        ]);
      // --- Support / Report an issue (Formspree) ---
const supportForm = el("form", {
  action: "https://formspree.io/f/xreakwzg",
  method: "POST"
}, [
  el("label", {}, [
    el("span", { text:"Type" }),
    el("select", { class:"glassSelect", name:"issue_type" }, [
      el("option", { value:"bug", text:"Bug" }),
      el("option", { value:"feature", text:"Feature request" }),
      el("option", { value:"data", text:"Data issue" }),
      el("option", { value:"other", text:"Other" })
    ])
  ]),

  el("div", { style:"height:10px" }),

  el("label", {}, [
    el("span", { text:"Your email (optional)" }),
    el("input", { name:"email", type:"email", placeholder:"name@email.com", autocomplete:"email" })
  ]),

  el("div", { style:"height:10px" }),

  el("label", {}, [
    el("span", { text:"Subject" }),
    el("input", { name:"subject", type:"text", placeholder:"Short summary" })
  ]),

  el("div", { style:"height:10px" }),

  el("label", {}, [
    el("span", { text:"Message" }),
    el("textarea", {
      name:"message",
      placeholder:"What happened? Steps to reproduce? What did you expect?",
      style:"width:100%; min-height:160px; border-radius:14px; padding:12px; border:1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: rgba(255,255,255,.92); font-size:12px; outline:none; resize:vertical;"
    })
  ]),

  el("div", { style:"height:12px" }),

  el("div", { class:"btnrow" }, [
    el("button", { class:"btn primary", type:"submit" }, ["Send report"]),
    el("button", {
      class:"btn",
      type:"button",
      onClick: (ev) => {
        const form = ev.target.closest("form");
        if(form) form.reset();
      }
    }, ["Clear"])
  ])
]);

// ✅ Attach submit handler using the real DOM API (reliable)
supportForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const form = e.currentTarget;
  const fd = new FormData(form);

  // Auto-attach diagnostics (safe + helpful)
  fd.set("app_version_latest", String(__latestVersion || ""));
  fd.set("app_version_applied", String(__appliedVersion || ""));
  fd.set("route", String(getCurrentRoute && getCurrentRoute() || ""));
  fd.set("user_agent", String(navigator.userAgent || ""));
  fd.set("ts", new Date().toISOString());

  try{
    const r = await fetch(form.action, {
      method: "POST",
      body: fd,
      headers: { "Accept": "application/json" }
    });

    if(r.ok){
      form.reset();
      showToast("Sent — thank you!");
    }else{
      let msg = "Could not send.";
      try{
        const j = await r.json();
        if(j?.errors?.[0]?.message) msg = j.errors[0].message;
      }catch(_){}
      showToast(msg);
    }
  }catch(_){
    showToast("Network error — try again.");
  }
});

const supportBody = el("div", {}, [
  el("div", { class:"note", text:"Report a bug or request a feature. This sends a message directly to the developer." }),
  el("div", { style:"height:10px" }),
  supportForm
]);
        // --- Search Bar ---
        const searchInput = el("input", {
          type:"text",
          placeholder:"Search settings…",
          value: ui.q || ""
        });
        searchInput.addEventListener("input", (e) => {
          ui.q = e.target.value || "";
          renderView();
        });

const root = el("div", { class:"settingsWrap" }, [
  el("div", { class:"settingsSearch" }, [
    el("div", { class:"ico", text:"🔎" }),
    searchInput
  ]),
  el("div", { class:"accList" }, [
    makeSection({
      key:"profile",
      title:"Profile & Preferences",
      subtitle:"Name, protein goal, week start, rest days",
      keywords:["name","protein","week","rest","goal"],
      bodyNode: profileBody
    }),
      makeSection({
      key:"routines",
      title:"Routines",
      subtitle:"Create, set active, rename, duplicate, delete",
      keywords:["routine","routines","template","active","edit","duplicate","delete","create"],
      bodyNode: routinesBody
    }),
    makeSection({
      key:"library",
      title:"Exercise Library",
      subtitle:"Manage exercises (add/edit/delete)",
      keywords:["exercise","library","weightlifting","cardio","core"],
      bodyNode: libraryBody
    }),
    makeSection({
      key:"backup",
      title:"Backup & Restore",
      subtitle:"Export/import JSON backups",
      keywords:["backup","import","export","json","restore"],
      bodyNode: backupBody
    }),
    makeSection({
      key:"data",
      title:"Data Tools",
      subtitle:"Repair duplicates + clear specific data",
      keywords:["repair","duplicates","clear","logs","attendance"],
      bodyNode: dataBody
    }),
    makeSection({
      key:"debug",
      title:"Debug / About",
      subtitle:"View raw state + reset local data",
      keywords:["debug","reset","state","storage"],
      bodyNode: debugBody
    }),
    makeSection({
      key:"support",
      title:"Support / Report an issue",
      subtitle:"Send feedback to the developer",
      keywords:["support","issue","bug","feedback","feature","help","report"],
      bodyNode: supportBody
    })
  ])
]);
        return root;
      }
    }; // ✅ end Views object
    Views.ExerciseLibraryManager = function(){
  ExerciseLibrary.ensureSeeded();

  const ui = UIState.libraryManage;
  const root = el("div", { class:"grid" });

  // Header
  root.appendChild(el("div", { class:"card" }, [
    el("div", { class:"kpi" }, [
      el("div", { class:"big", text:"Exercise Library" }),
      el("div", { class:"small", text:"Search, add, edit, or delete exercises." })
    ]),
    el("div", { style:"height:10px" }),
    el("div", { class:"btnrow" }, [
      el("button", { class:"btn", onClick: () => navigate("settings") }, ["← Settings"]),
      el("button", { class:"btn primary", onClick: () => openAddEditModal(null) }, ["+ Add Exercise"])
    ])
  ]));

  // Controls
  const controls = el("div", { class:"card" }, [ el("h2", { text:"Filters" }) ]);

  const typeChips = el("div", { class:"chips" });
  ExerciseLibrary.typeKeys.forEach(t => {
    typeChips.appendChild(el("div", {
      class:"chip" + (ui.type === t ? " on" : ""),
      onClick: () => { ui.type = t; ui.equipment = "all"; renderView(); }
    }, [ExerciseLibrary.typeLabel(t)]));
  });

  const search = el("input", { type:"text", placeholder:"Search exercises…", value: ui.q || "" });
  search.addEventListener("input", (e) => { ui.q = e.target.value || ""; renderList(); });

  const equipSelect = el("select", {});
  equipSelect.appendChild(el("option", { value:"all", text:"All equipment" }));
  const equipSet = new Set();
  ExerciseLibrary.list(ui.type).forEach(x => { if(x.equipment) equipSet.add(x.equipment); });
  Array.from(equipSet).sort().forEach(eq => equipSelect.appendChild(el("option", { value:eq, text:eq })));
  equipSelect.value = ui.equipment || "all";
  equipSelect.addEventListener("change", (e) => { ui.equipment = e.target.value || "all"; renderList(); });

  controls.appendChild(el("div", { class:"note", text:"Type" }));
  controls.appendChild(typeChips);
  controls.appendChild(el("div", { style:"height:10px" }));
  controls.appendChild(el("div", { class:"row2" }, [
    el("label", {}, [ el("span", { text:"Search" }), search ]),
    el("label", {}, [ el("span", { text:"Equipment" }), equipSelect ])
  ]));

  root.appendChild(controls);

  // List
  const listCard = el("div", { class:"card" }, [
    el("h2", { text:"Exercises" }),
    el("div", { class:"note", text:"Tip: Deleting an exercise will not erase old logs (they use the saved name snapshot)." })
  ]);
const listHost = el("div", { style:"display:flex; flex-direction:column; gap:10px; margin-top:10px;" });

function renderList(){
  listHost.innerHTML = "";

  const q = (ui.q || "").trim().toLowerCase();
  const eq = ui.equipment || "all";

  const items = ExerciseLibrary.list(ui.type)
    .filter(x => !q || (x.name || "").toLowerCase().includes(q))
    .filter(x => eq === "all" || (x.equipment || "") === eq)
    .sort((a,b) => (a.name || "").localeCompare(b.name || ""));

  if(items.length === 0){
    listHost.appendChild(el("div", { class:"note", text:"No exercises match your filters." }));
  } else {
    items.forEach(ex => {
      const sub = (() => {
        if(ui.type === "weightlifting"){
          const parts = [];
          if(ex.primaryMuscle) parts.push(ex.primaryMuscle);
          if(ex.equipment) parts.push(ex.equipment);
          if(typeof ex.isCompound === "boolean") parts.push(ex.isCompound ? "compound" : "isolation");
          return parts.join(" • ") || "—";
        }
        if(ui.type === "cardio"){
          const parts = [];
          if(ex.modality) parts.push(ex.modality);
          if(ex.supportsIncline) parts.push("incline");
          return parts.join(" • ") || "—";
        }
        const parts = [];
        if(ex.equipment) parts.push(ex.equipment);
        return parts.join(" • ") || "—";
      })();

      listHost.appendChild(el("div", { class:"item" }, [
        el("div", { style:"font-weight:860; letter-spacing:.1px;", text: ex.name }),
        el("div", { class:"meta", text: sub }),
        el("div", { style:"height:10px" }),
        el("div", { class:"btnrow" }, [
          el("button", { class:"btn", onClick: () => openAddEditModal(ex) }, ["Edit"]),
          el("button", { class:"btn danger", onClick: () => attemptDelete(ex) }, ["Delete"])
        ])
      ]));
    });
  }
}

// ✅ initial paint
renderList();

listCard.appendChild(listHost);
root.appendChild(listCard);

  function countRoutineRefs(type, exerciseId){
    let count = 0;
    (state.routines || []).forEach(r => {
      (r.days || []).forEach(d => {
        (d.exercises || []).forEach(rx => {
          if(rx.type === type && rx.exerciseId === exerciseId) count++;
        });
      });
    });
    return count;
  }

  function attemptDelete(ex){
    const refs = countRoutineRefs(ui.type, ex.id);
    const note = refs
      ? `This exercise is currently used in ${refs} routine slot(s). Deleting it will remove it from those routines.`
      : "Delete this exercise from your library?";

    confirmModal({
      title: "Delete exercise",
      note,
      confirmText: "Delete",
      danger: true,
      onConfirm: () => {
        ExerciseLibrary.remove(ui.type, ex.id);
        Storage.save(state);
        showToast("Deleted");
        renderView();
      }
    });
  }
function openAddEditModal(existing){
  const isEdit = !!existing;

  // Keep old type (important for migrations)
  const oldType = String(existing?.type || ui.type || "weightlifting");

  const name = el("input", {
    type:"text",
    value: existing?.name || "",
    placeholder:"Exercise name"
  });

  const equip = el("input", {
    type:"text",
    value: existing?.equipment || "",
    placeholder:"e.g., Dumbbell, Barbell, Machine"
  });

  // ────────────────────────────
  // Glass dropdown options
  // ────────────────────────────
  const TYPE_OPTS = [
    { v:"weightlifting", t:"Weightlifting" },
    { v:"cardio",        t:"Cardio" },
    { v:"core",          t:"Core" }
  ];

  const PRIMARY_OPTS = [
    "Chest","Shoulders","Arms","Back","Legs","Full Body","Cardio","Core"
  ];

  const SECONDARY_OPTS = [
    "Upper Chest",
    "Lower Chest",
    "Front Delts",
    "Side Delts",
    "Rear Delts",
    "Traps",
    "Biceps",
    "Triceps",
    "Brachialis",
    "Forearms",
    "Lats",
    "Rhomboids",
    "Erector Spinae",
    "Quads",
    "Hamstrings",
    "Glutes",
    "Calves",
    "Adductors",
    "Abductors",
    "Abs",
    "Obliques",
    "Transverse Abdominis",
    "Grip",
    "Hip Flexors"
  ];

  function makeSelect(options, value){
    const sel = el("select", {
      style: [
        "width:100%",
        "border-radius:14px",
        "padding:12px",
        "border:1px solid rgba(255,255,255,12)",
        "background: rgba(255,255,255,06)",
        "color: rgba(255,255,255,92)",
        "outline:none"
      ].join(";")
    });

    options.forEach(opt => {
      if(typeof opt === "string"){
        sel.appendChild(el("option", { value: opt, text: opt }));
      }else{
        sel.appendChild(el("option", { value: opt.v, text: opt.t }));
      }
    });

    if(value != null) sel.value = String(value);
    return sel;
  }

  function makeMultiSelect(options, selectedArr){
    const sel = el("select", {
      multiple: true,
      style: [
        "width:100%",
        "border-radius:14px",
        "padding:12px",
        "border:1px solid rgba(255,255,255,12)",
        "background: rgba(255,255,255,06)",
        "color: rgba(255,255,255,92)",
        "outline:none",
        // multi-select needs height to be usable on phone
        "min-height:140px"
      ].join(";")
    });

    const selected = new Set((selectedArr || []).map(String));
    options.forEach(v => {
      const opt = el("option", { value: v, text: v });
      if(selected.has(String(v))) opt.selected = true;
      sel.appendChild(opt);
    });

    return sel;
  }

  // Type dropdown (NEW)
  const typeSel = makeSelect(TYPE_OPTS, oldType);

  // Primary + Secondary dropdowns (NEW)
  const primarySel = makeSelect(PRIMARY_OPTS, existing?.primaryMuscle || "");
  const secondarySel = makeMultiSelect(SECONDARY_OPTS, existing?.secondaryMuscles || []);

  // If they change Type, auto-suggest Primary for cardio/core (non-destructive)
  typeSel.addEventListener("change", () => {
    const t = String(typeSel.value || "");
    if(t === "cardio" && (!primarySel.value || primarySel.value === "")) primarySel.value = "Cardio";
    if(t === "core" && (!primarySel.value || primarySel.value === "")) primarySel.value = "Core";
  });

  function migrateReferences(exId, fromType, toType){
    if(!exId || fromType === toType) return;

    // Update routine slots
    (state.routines || []).forEach(r => {
      (r.days || []).forEach(d => {
        (d.exercises || []).forEach(rx => {
          if(rx.exerciseId === exId && rx.type === fromType){
            rx.type = toType;
          }
        });
      });
    });

    // Update workout logs
    (state.logs?.workouts || []).forEach(e => {
      if(e.exerciseId === exId && e.type === fromType){
        e.type = toType;
      }
    });
  }

  Modal.open({
    title: isEdit ? "Edit exercise" : "Add exercise",
    bodyNode: el("div", {}, [
      el("label", {}, [ el("span", { text:"Name" }), name ]),
      el("div", { style:"height:10px" }),

      // NEW: Type selector
      el("label", {}, [ el("span", { text:"Type" }), typeSel ]),
      el("div", { style:"height:10px" }),

      el("label", {}, [ el("span", { text:"Equipment" }), equip ]),
      el("div", { style:"height:10px" }),

      // NEW: Primary/Secondary selectors
      el("label", {}, [ el("span", { text:"Primary muscle" }), primarySel ]),
      el("div", { style:"height:10px" }),

      el("label", {}, [
        el("span", { text:"Secondary muscles (multi-select)" }),
        secondarySel
      ]),
      el("div", { class:"note", text:"Tip: iPhone — you can tap multiple options. (This saves to secondaryMuscles[] and won’t break existing logic.)" }),

      el("div", { style:"height:12px" }),
      el("div", { class:"btnrow" }, [
        el("button", {
          class:"btn primary",
          onClick: () => {
            const nm = (name.value || "").trim();
            if(!nm) return showToast("Name is required");

            const newType = String(typeSel.value || ui.type || "weightlifting");
            const exId = existing?.id || uid("ex");

            const selectedSecondary = Array.from(secondarySel.selectedOptions || [])
              .map(o => String(o.value || "").trim())
              .filter(Boolean);

            // Preserve existing fields to avoid wiping cardio/core-specific properties
            const payload = {
              ...(existing || {}),
              id: exId,
              type: newType,
              name: nm,
              equipment: (equip.value || "").trim(),
              primaryMuscle: String(primarySel.value || "").trim(),
              secondaryMuscles: selectedSecondary
            };

            // If editing AND type changes: migrate library bucket + update routine/log refs
            if(isEdit){
              if(oldType !== newType){
                // Move exercise to new library type
                ExerciseLibrary.remove(oldType, exId);
                ExerciseLibrary.add(newType, payload);

                // Keep routines/logs consistent
                migrateReferences(exId, oldType, newType);

                // Keep UI on the new type so the user sees it immediately
                ui.type = newType;
              }else{
                ExerciseLibrary.update(newType, payload);
              }
            }else{
              ExerciseLibrary.add(newType, payload);
              ui.type = newType;
            }

            Storage.save(state);
            Modal.close();
            showToast(isEdit ? "Updated" : "Added");
            renderView();
          }
        }, [isEdit ? "Save" : "Add"]),
        el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
      ])
    ])
  });
}

  return root;
};
Views.RoutineEditor = function(){
  ExerciseLibrary.ensureSeeded();

  const root = el("div", { class:"grid" });
  const active = Routines.getActive();

  if(!active){

    function openRoutineRecovery(){
      const body = el("div", {}, [
        el("div", { class:"note", text:"Choose a template to recreate a routine. This will set it as active and reopen the editor." }),
        el("div", { style:"height:12px" })
      ]);

      const list = el("div", { class:"list" });

      (RoutineTemplates || []).forEach(tpl => {
        list.appendChild(el("div", {
          class:"item",
          onClick: () => {
            try{
              Routines.addFromTemplate(tpl.key, tpl.name);
              Modal.close();
              showToast(`Created: ${tpl.name}`);
              renderView(); // RoutineEditor will re-render with the new active routine
            }catch(e){
              Modal.open({
                title:"Could not create routine",
                bodyNode: el("div", {}, [
                  el("div", { class:"note", text: e?.message || "Something went wrong while creating a routine." }),
                  el("div", { style:"height:12px" }),
                  el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
                ])
              });
            }
          }
        }, [
          el("div", { class:"left" }, [
            el("div", { class:"name", text: tpl.name }),
            el("div", { class:"meta", text: tpl.desc || "Template" })
          ]),
          el("div", { class:"actions" }, [
            el("div", { class:"meta", text:"Create" })
          ])
        ]));
      });

      body.appendChild(list);

      body.appendChild(el("div", { style:"height:14px" }));
      body.appendChild(el("div", { class:"btnrow" }, [
        el("button", { class:"btn", onClick: () => { Modal.close(); navigate("routine"); } }, ["Back to Routine"]),
        el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
      ]));

      Modal.open({
        title:"Create a routine",
        center: true,
        bodyNode: body
      });
    }

    root.appendChild(el("div", { class:"card" }, [
      el("h2", { text:"Routine Editor" }),
      el("div", { class:"note", text:"No active routine found. Create one to continue." }),
      el("div", { style:"height:12px" }),
      el("div", { class:"btnrow" }, [
        el("button", { class:"btn primary", onClick: openRoutineRecovery }, ["Create routine"]),
        el("button", { class:"btn", onClick: () => navigate("routine") }, ["Back to Routine"])
      ])
    ]));

    return root;
  }

  const header = el("div", { class:"card" }, [
    el("h2", { text:"Routine Editor" }),
    el("div", { class:"note", text:`Editing: ${active.name}` }),
    el("div", { style:"height:10px" }),
    el("div", { class:"btnrow" }, [
      el("button", {
        class:"btn",
        onClick: () => navigate("routine")
      }, ["Back to Routine"]),
      el("button", {
        class:"btn",
        onClick: (e) => renameRoutine(e.currentTarget, active.id)
      }, ["Rename"]),
      el("button", {
        class:"btn",
        onClick: () => { Routines.duplicate(active.id); renderView(); }
      }, ["Duplicate"]),
      el("button", {
        class:"btn danger",
        onClick: (e) => confirmDelete(e.currentTarget, active.id)
      }, ["Delete"])
    ])
  ]);
  // ────────────────────────────
  // Templates (same 5 as Onboarding)
  // ────────────────────────────
  const templatesCard = el("div", { class:"card" }, [
    el("h2", { text:"Templates" }),
    el("div", { class:"note", text:"Choose a template to switch your active routine. If it already exists, it will activate (no duplicates)." }),
    el("div", { style:"height:10px" })
  ]);

  const tplList = el("div", { class:"list" });

  function findExistingRoutineForTemplate(tpl){
    const all = Routines.getAll() || [];
    // Prefer templateKey match
    const byKey = all.find(r => String(r.templateKey || "") === String(tpl.key || ""));
    if(byKey) return byKey;
    // Fallback to name match (older saves)
    const byName = all.find(r => normName(r.name) === normName(tpl.name));
    return byName || null;
  }

  (RoutineTemplates || []).forEach(tpl => {
    const existing = findExistingRoutineForTemplate(tpl);

    tplList.appendChild(el("div", {
      class:"item",
      onClick: () => {
        // If it exists, activate it (no recreation)
        const existingNow = findExistingRoutineForTemplate(tpl);
        if(existingNow){
          Routines.setActive(existingNow.id);
          showToast(`Active: ${existingNow.name}`);
          renderView(); // re-render editor on the newly active routine
          return;
        }

        // Otherwise create ONE routine for that template (exact template name)
        Routines.addFromTemplate(tpl.key, tpl.name);
        showToast(`Created: ${tpl.name}`);
        renderView();
      }
    }, [
      el("div", { class:"left" }, [
        el("div", { class:"name", text: tpl.name }),
        el("div", { class:"meta", text: tpl.desc || "Template" })
      ]),
      el("div", { class:"actions" }, [
        el("div", { class:"meta", text: existing ? "Activate" : "Add" })
      ])
    ]));
  });

  templatesCard.appendChild(tplList);

  const daysCard = el("div", { class:"card" }, [
    el("h2", { text:"Days" }),
    el("div", { class:"note", text:"Tap a day to edit label, rest day, or exercises." })
  ]);

  const daysGrid = el("div", { class:"dayGrid" });
  daysCard.appendChild(el("div", { style:"height:10px" }));
  daysCard.appendChild(daysGrid);

  root.appendChild(header);
  root.appendChild(templatesCard);
  root.appendChild(daysCard);

  repaintDays();
  return root;

  function repaintDays(){
    const r = Routines.getActive();
    daysGrid.innerHTML = "";

    (r.days || []).forEach(day => {
      const exCount = (day.exercises || []).length;

      const card = el("div", { class:"dayCard" }, [
        el("div", { class:"dayTop" }, [
          el("div", { class:"dayTitle" }, [
            el("div", { class:"lbl", text: `${["SUN","MON","TUE","WED","THU","FRI","SAT"][day.order]} — ${day.label}` }),
            el("div", { class:"sub", text: day.isRest ? "Rest day" : `${exCount} exercises` })
          ]),
          el("button", {
            class:"mini",
            onClick: () => editDay(day)
          }, ["Edit"])
        ])
      ]);

      const list = el("div", { class:"exList" });

      if(day.isRest){
        list.appendChild(el("div", { class:"note", text:"No exercises on rest days." }));
      }else if(exCount === 0){
        list.appendChild(el("div", { class:"note", text:"No exercises yet. Tap Edit → Add exercise." }));
      }else{
        (day.exercises || []).forEach(rx => {
          const name = resolveExerciseName(rx.type, rx.exerciseId, rx.nameSnap);
          list.appendChild(el("div", { class:"exRow" }, [
            el("div", { class:"n", text:name }),
            el("button", {
              class:"mini danger",
              onClick: () => { Routines.removeExerciseFromDay(r.id, day.id, rx.id); repaintDays(); }
            }, ["Remove"])
          ]));
        });
      }

      card.appendChild(list);
      daysGrid.appendChild(card);
    });
  }

function renameRoutine(anchorEl, routineId){
  const current = Routines.getActive();
  const input = el("input", {
    type:"text",
    value: current?.name || "",
    style:"width:100%;"
  });

  const err = el("div", {
    class:"note",
    style:"display:none; color: rgba(255,92,122,.95); margin-top:8px;"
  });

  const body = el("div", {}, [
    el("div", { class:"popTitle", text:"Rename routine" }),
    el("div", { style:"display:grid; gap:10px;" }, [
      input,
      err,
      el("div", { class:"btnrow" }, [
        el("button", {
          class:"btn primary",
          onClick: () => {
            err.style.display = "none";
            const name = (input.value || "").trim();
            if(!name){
              err.textContent = "Enter a name.";
              err.style.display = "block";
              return;
            }
            Routines.rename(routineId, name);
            PopoverClose();
            renderView();
          }
        }, ["Save"]),
        el("button", { class:"btn", onClick: PopoverClose }, ["Cancel"])
      ])
    ])
  ]);

  PopoverOpen(anchorEl, body);
  setTimeout(() => input.focus(), 0);
}

function confirmDelete(anchorEl, routineId){
  const body = el("div", {}, [
    el("div", { class:"popTitle", text:"Delete routine?" }),
    el("div", { class:"note", text:"This deletes the routine. Logs stay, but the routine schedule will be removed." }),
    el("div", { style:"height:10px" }),
    el("div", { class:"btnrow" }, [
      el("button", {
        class:"btn danger",
        onClick: () => {
          Routines.remove(routineId);
          PopoverClose();
          navigate("routine");
        }
      }, ["Delete"]),
      el("button", { class:"btn", onClick: PopoverClose }, ["Cancel"])
    ])
  ]);

  PopoverOpen(anchorEl, body);
}

  function editDay(day){
    const r = Routines.getActive();

    const labelInput = el("input", { type:"text", value: day.label || "" });

    const restSwitch = el("div", { class:"switch" + (day.isRest ? " on" : "") });
    restSwitch.addEventListener("click", () => {
      const next = !restSwitch.classList.contains("on");
      restSwitch.classList.toggle("on", next);
    });

const addBtn = el("button", {
  class:"btn primary",
  onClick: () => openAddExercise(r.id, day.id, { keepOpen:false })
}, ["Add exercise"]);

const addMultiBtn = el("button", {
  class:"btn",
  onClick: () => openAddExercise(r.id, day.id, { keepOpen:true })
}, ["Add multiple"]);


    Modal.open({
      title: "Edit day",
      bodyNode: el("div", {}, [
        el("label", {}, [ el("span", { text:"Label" }), labelInput ]),
        el("div", { style:"height:10px" }),
        el("div", { class:"toggle" }, [
          el("div", { class:"ttext" }, [
            el("div", { class:"a", text:"Rest day" }),
            el("div", { class:"b", text:"If enabled, exercises are hidden on Routine." })
          ]),
          restSwitch
        ]),
        el("div", { style:"height:12px" }),
        el("div", { class:"btnrow" }, [ addBtn, addMultiBtn ]),
        el("div", { style:"height:12px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn",
            onClick: () => {
              const nextLabel = (labelInput.value || "").trim() || day.label;
              const isRest = restSwitch.classList.contains("on");
              Routines.setDayLabel(r.id, day.id, nextLabel);
              Routines.setRestDay(r.id, day.id, isRest);
              Modal.close();
              repaintDays();
            }
          }, ["Save"]),
          el("button", { class:"btn", onClick: Modal.close }, ["Close"])
        ])
      ])
    });
  }

  function openAddExercise(routineId, dayId, opts={}){
    // Compact, phone-first "Add Exercise" modal
    // - Active day context (top)
    // - Fixed search bar
    // - Scrollable exercise sections grouped by Primary Muscle (tap to expand)
    // - Fixed Add/Done bar (supports multi-add when opts.keepOpen === true)
    ExerciseLibrary.ensureSeeded();

    const routine = (state.routines || []).find(r => r.id === routineId) || Routines.getActive();
    const day = (routine?.days || []).find(d => d.id === dayId) || null;

    const dayIndex = day ? (routine.days || []).findIndex(d => d.id === dayId) : -1;
    const dow = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    const dayTag = (dayIndex >= 0 && dayIndex < 7) ? dow[dayIndex] : "Day";
    const dayLabel = (day?.label || "").trim();
    const dayTitle = dayLabel ? `${dayTag} • ${dayLabel}` : `${dayTag}`;

    // Tracks what the user adds during THIS open session (for live count)
    const addedThisSession = new Set();

    // Persisted exercises already on this day (to prevent duplicates)
    function getExistingSetForDay(){
      const s = new Set();
      (day?.exercises || []).forEach(rx => s.add(`${rx.type}:${rx.exerciseId}`));
      return s;
    }

    // Search state
    let query = "";

    // Collapsed/expanded groups (session only)
    const openGroups = new Set();

    // If day label hints a muscle, open that group by default
    (function seedOpenGroupFromDay(){
      const hint = normName(dayLabel || "");
      const mus = (state.exerciseLibrary?.weightlifting || [])
        .map(x => String(x.primaryMuscle || "").trim())
        .filter(Boolean);

      const match = mus.find(m => hint && hint.includes(normName(m)));
      if(match) openGroups.add(match);
    })();

    // UI nodes
    const ctx = el("div", { class:"addExCtx" }, [
      el("div", { class:"addExCtxA", text:"Add exercises to" }),
      el("div", { class:"addExCtxB", text: dayTitle })
    ]);

    const searchWrap = el("div", { class:"addExSearch" }, [
      el("div", { class:"ico", text:"🔎" }),
      el("input", {
        type:"text",
        value:"",
        placeholder:"Search exercises…",
        onInput: (e) => {
          query = String(e.target.value || "");
          repaint();
        }
      })
    ]);

    const scroller = el("div", { class:"addExScroller" });
    const bottomBar = el("div", { class:"addExBottom" });

    const countPill = el("div", { class:"addExCount", text:"0 added" });
    const doneBtn = el("button", {
      class:"btn primary",
      onClick: () => Modal.close()
    }, [opts.keepOpen ? "Done" : "Close"]);

    function updateCount(){
      countPill.textContent = `${addedThisSession.size} added`;
    }
    // Helper: find the routineExerciseId (rx.id) for a given library exercise on this day
    function findRxIdOnDay(type, exId){
      // Always re-fetch the latest day object (in case state changed while modal is open)
      const latestDay = Routines.getDay(routineId, dayId) || day;
      const rx = (latestDay?.exercises || []).find(e => e.type === type && e.exerciseId === exId);
      return rx?.id || null;
    }

    // Helper: set button/row UI state
    function setRowState({ row, btn, mode }){
      // mode: "add" | "remove"
      if(!row || !btn) return;

      row.classList.remove("selected", "disabledRow");
      btn.classList.remove("added", "disabledBtn", "danger");

      if(mode === "remove"){
        row.classList.add("selected");
        btn.classList.add("danger");
        btn.textContent = "Remove";
        btn.disabled = false;
      }else{
        btn.textContent = "Add";
        btn.disabled = false;
      }
    }

    function addExercise(type, exId, key, rowBtn, rowEl){
      // Toggle behavior:
      // - If already in day: remove
      // - If not: add
      const existingSet = getExistingSetForDay();
      const alreadyInDay = existingSet.has(key);

      if(alreadyInDay){
        const rxId = findRxIdOnDay(type, exId);
        if(rxId){
          Routines.removeExerciseFromDay(routineId, dayId, rxId);
        }

        // If it was added during THIS modal session, reduce the counter
        if(addedThisSession.has(key)) addedThisSession.delete(key);
        updateCount();

        // Refresh Routine + modal list states
        repaintDays();
        repaint();

        // For single-add modal, keep it open on remove (less annoying)
        return;
      }

      // Add path (original behavior preserved)
      Routines.addExerciseToDay(routineId, dayId, type, exId);
      repaintDays();

      if(opts.keepOpen){
        addedThisSession.add(key);
        updateCount();

        // Keep open and flip the row into "Remove" state
        setRowState({ row: rowEl, btn: rowBtn, mode: "remove" });
      }else{
        Modal.close();
      }
    }

    function renderRow(type, x, existingSet){
      const key = `${type}:${x.id}`;
      const alreadyInDay = existingSet.has(key);

      const row = el("div", { class:"item addExRow" });
      const btn = el("button", { class:"mini" }, ["Add"]);

      // Build meta as DOM nodes so we can highlight secondary muscles
      const metaNodes = [];

      // Helpers
      const pushSep = () => metaNodes.length ? metaNodes.push(document.createTextNode(" • ")) : null;
      const pushText = (t) => {
        const s = String(t || "").trim();
        if(!s) return;
        pushSep();
        metaNodes.push(document.createTextNode(s));
      };
      const pushSecondary = (t) => {
        const s = String(t || "").trim();
        if(!s) return;
        pushSep();
        metaNodes.push(el("span", { class:"secMuscle", text: s }));
      };

      if(type === "weightlifting"){
        // Primary muscle (support legacy "Chest / Triceps" formatting)
        const rawPrimary = String(x.primaryMuscle || "").trim();
        const primaryOnly = rawPrimary.includes("/") ? rawPrimary.split("/")[0].trim() : rawPrimary;
        if(primaryOnly) pushText(primaryOnly);

        // Secondary muscles (preferred: array)
        const secs = Array.isArray(x.secondaryMuscles) ? x.secondaryMuscles.filter(Boolean) : [];
        if(secs.length){
          secs.forEach(sm => pushSecondary(sm));
        }else{
          // Fallback: parse legacy "Primary / Secondary" format
          if(rawPrimary.includes("/")){
            const parsed = rawPrimary.split("/").slice(1).join("/").trim();
            if(parsed) pushSecondary(parsed);
          }
        }

        // Equipment
        if(x.equipment) pushText(x.equipment);
      }else{
        // Cardio/Core keep current meta style
        if(x.equipment) pushText(x.equipment);
      }

      // Type label always last
      pushText(ExerciseLibrary.typeLabel(type));

      row.appendChild(
        el("div", { class:"left" }, [
          el("div", { class:"name", text:x.name }),
          el("div", { class:"meta" }, metaNodes.length ? metaNodes : [document.createTextNode("")])
        ])
      );
      row.appendChild(el("div", { class:"actions" }, [ btn ]));

      // ✅ NEW: if it’s already in the day, show a removable state (not disabled)
      if(alreadyInDay){
        setRowState({ row, btn, mode: "remove" });
      }else{
        setRowState({ row, btn, mode: "add" });
      }

      btn.addEventListener("click", () => addExercise(type, x.id, key, btn, row));
      return row;
    }

    function toggleGroup(name){
      if(openGroups.has(name)) openGroups.delete(name);
      else openGroups.add(name);
      repaint();
    }

    function renderGroup(title, items, existingSet){
      const isOpen = openGroups.has(title);

      const head = el("div", {
        class:"addExGroupHead",
        onClick: () => toggleGroup(title)
      }, [
        el("div", { class:"addExGroupLeft" }, [
          el("div", { class:"addExGroupTitle", text:title }),
          el("div", { class:"addExGroupSub", text:`${items.length} exercise${items.length===1?"":"s"}` })
        ]),
        el("div", { class:"addExGroupCaret", text: isOpen ? "▾" : "▸" })
      ]);

      const body = el("div", {
        class:"addExGroupBody",
        style: isOpen ? "" : "display:none;"
      });

      items.forEach(x => body.appendChild(renderRow(x.type, x, existingSet)));

      return el("div", { class:"addExGroup" }, [ head, body ]);
    }

    function repaint(){
      scroller.innerHTML = "";
      const existingSet = getExistingSetForDay();

      // ✅ No segmented control: unify all categories
      const libs = {
        weightlifting: (state.exerciseLibrary?.weightlifting || []).slice(),
        cardio:        (state.exerciseLibrary?.cardio || []).slice(),
        core:          (state.exerciseLibrary?.core || []).slice()
      };

      const all = []
        .concat(libs.weightlifting.map(x => ({...x, type:"weightlifting"})))
        .concat(libs.cardio.map(x => ({...x, type:"cardio"})))
        .concat(libs.core.map(x => ({...x, type:"core"})));

      const q = normName(query || "");

      // Search: flat list (fast + compact)
      if(q){
        const hits = all
          .filter(x => normName(x.name).includes(q))
          .sort((a,b) => (a.name||"").localeCompare(b.name||""))
          .slice(0, 60);

        if(hits.length === 0){
          scroller.appendChild(el("div", { class:"note", text:"No matches. Try a different keyword." }));
          updateCount();
          return;
        }

        scroller.appendChild(el("div", { class:"addExSearchHint", text:`Results (${hits.length})` }));
        const wrap = el("div", { class:"list" });
        hits.forEach(x => wrap.appendChild(renderRow(x.type, x, existingSet)));
        scroller.appendChild(wrap);

        updateCount();
        return;
      }

      // Weightlifting grouped by primaryMuscle (tap to expand)
      const wl = libs.weightlifting
        .map(x => ({...x, type:"weightlifting"}))
        .sort((a,b) => (a.name||"").localeCompare(b.name||""));

      // ✅ Fixed display order (your requirement)
      const MUSCLE_ORDER = ["Chest", "Shoulders", "Arms", "Back", "Legs", "Full Body"];

      // ✅ Normalize messy primaryMuscle labels into our 6 buckets
      function normalizeBucket(primaryMuscle){
        const raw = String(primaryMuscle || "").trim();
        const m = raw.toLowerCase();

        if(!m) return "Other";

        // Full Body
        if(m.includes("full body")) return "Full Body";

        // Chest
        if(m.includes("chest") || m.includes("pec")) return "Chest";

        // Shoulders
        if(m.includes("shoulder") || m.includes("delt")) return "Shoulders";

        // Arms (also catches biceps/triceps/forearms)
        if(m.includes("arm") || m.includes("bicep") || m.includes("tricep") || m.includes("forearm")) return "Arms";

        // Back (also catches lats/traps)
        if(m.includes("back") || m.includes("lat") || m.includes("trap")) return "Back";

        // Legs (also catches quads/hamstrings/glutes/calves)
        if(
          m.includes("leg") || m.includes("quad") || m.includes("hamstring") ||
          m.includes("glute") || m.includes("calf")
        ) return "Legs";

        return "Other";
      }

      const byMuscle = new Map();
      wl.forEach(x => {
        const bucket = normalizeBucket(x.primaryMuscle);
        if(!byMuscle.has(bucket)) byMuscle.set(bucket, []);
        byMuscle.get(bucket).push(x);
      });

      // ✅ Only render buckets that actually have exercises
      const orderedBuckets = MUSCLE_ORDER.filter(k => (byMuscle.get(k) || []).length);

      // Safety bucket (only shows if needed)
      const otherItems = byMuscle.get("Other") || [];
      if(otherItems.length) orderedBuckets.push("Other");

      // Used later for the empty-state check (prevents "muscleNames" crashes)
      const hasWeightliftingGroups = orderedBuckets.length > 0;

      if(hasWeightliftingGroups){
        scroller.appendChild(el("div", { class:"addExSectionLabel", text:"Weightlifting (by muscle)" }));

        orderedBuckets.forEach(name => {
          const items = byMuscle.get(name) || [];
          // Keep alphabetical inside each muscle bucket (clean scanning)
          items.sort((a,b)=>(a.name||"").localeCompare(b.name||""));
          scroller.appendChild(renderGroup(name, items, existingSet));
        });
      }

        // Cardio collapsible group
  const cardioItems = libs.cardio.map(x => ({...x, type:"cardio"}))
    .sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  
  if(cardioItems.length){
    scroller.appendChild(el("div", { style:"height:10px" }));
    scroller.appendChild(el("div", { class:"addExSectionLabel", text:"Cardio" }));
    // Default state: collapsed (do NOT auto-open)
    scroller.appendChild(renderGroup("Cardio", cardioItems, existingSet));
  }



// Core collapsible group
const coreItems = libs.core.map(x => ({...x, type:"core"}))
  .sort((a,b)=>(a.name||"").localeCompare(b.name||""));

if(coreItems.length){
  scroller.appendChild(el("div", { style:"height:10px" }));
  scroller.appendChild(el("div", { class:"addExSectionLabel", text:"Core" }));
  // Default state: collapsed (do NOT auto-open)
  scroller.appendChild(renderGroup("Core", coreItems, existingSet));
}


       if(!hasWeightliftingGroups && !cardioItems.length && !coreItems.length){
        scroller.appendChild(el("div", { class:"note", text:"No exercises yet. Seed the library or add exercises in Settings." }));
      }

      updateCount();
    }

    // Bottom bar content
    bottomBar.appendChild(countPill);
    bottomBar.appendChild(el("div", { style:"flex:1" }));
    bottomBar.appendChild(doneBtn);

    // First paint
    repaint();
    updateCount();

    Modal.open({
      title: "Add exercise",
      size: "lg",
      bodyNode: el("div", { class:"addExModal" }, [
        ctx,
        searchWrap,
        scroller,
        bottomBar
      ])
    });

    // Focus search immediately (fast on phones)
    setTimeout(() => {
      try{
        const inp = searchWrap.querySelector("input");
        inp && inp.focus && inp.focus();
      }catch(e){}
    }, 0);
  }
};   // ✅ closes Views.RoutineEditor function


/********************
 * 7b) Router wiring (Phase 3.3)
 ********************/
const Router = initRouter({
  getState: () => state,
  $,
  el,
  Views,
  destroyProgressChart,
  destroyWeightChart,
  bindHeaderPills,
  setHeaderPills,
  checkForUpdates
});

// Pull router funcs, but DO NOT redeclare `navigate` (we already defined it above).
const { Routes, renderNav, renderView, getCurrentRoute } = Router;
navigate = Router.navigate;


/********************
 * 8) Boot (guarded) — extracted to bootstrap.js (Phase 3.6)
 ********************/
const Bootstrap = initBootstrap({
  getState: () => state,

  ExerciseLibrary,
  LogEngine,

  ensureFloatNext,

  renderNav,
  renderView,

  bindHeaderPills,
  setHeaderPills,

  checkForUpdates,
  registerServiceWorker,

  fatal: __fatal
});

Bootstrap.start();
