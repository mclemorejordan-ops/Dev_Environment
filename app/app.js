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

import { initViews } from "./views.js";

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
  navigate,
  UIState,

  findProteinEntry,
  cleanupProteinEntryIfEmpty,
  upsertMeal
});

const { buildProteinTodayModal, deleteMeal, totalProtein } = ProteinUI;



/********************
 * 7) Views (Phase 3.7) — extracted to /app/views.js
 ********************/

// Views previously called Storage.save(state) and BackupVault.forceSnapshot(state,...).
// In Phase 3.7 we inject wrappers so those methods always use the real live getState().
const getState = () => state;
const setState = (next) => { state = next; };

const ViewsStorage = {
  ...Storage,
  save: (_ignored) => Storage.save(getState()),
  flush: (_ignored) => Storage.flush(getState())
};

const ViewsBackupVault = {
  ...BackupVault,
  forceSnapshot: (_ignoredState, label) => BackupVault.forceSnapshot(getState(), label)
};

const Views = initViews({
  getState,
  setState,

  Storage: ViewsStorage,
  BackupVault: ViewsBackupVault,

  // UI helpers
  $,
  el,
  uid,
  pad2,
  Dates,
  bytesToNice,
  appStorageBytes,
  showToast,
  lockBodyScroll,
  unlockBodyScroll,
  Modal,
  PopoverOpen,
  PopoverClose,
  confirmModal,

  // versioning
  bindHeaderPills,
  setHeaderPills,
  checkForUpdates,
  openVersionModal,
  applyUpdateNow,
  __hasSwUpdateWaiting,

  // engines + helpers used by views
  ExerciseLibrary,
  Routines,
  RoutineTemplates,
  createRoutineFromTemplate,
  repairExerciseLinks,
  getTodayWorkout,

  // settings view renderer
  renderSettingsView,

  // backup helpers
  downloadTextFile,
  exportBackupJSON,
  validateImportedState,
  importBackupJSON,

  // workouts / logs / progress / attendance
  LogEngine,
  removeWorkoutEntryById,

  WeightEngine,
  renderWeightChart,
  destroyWeightChart,

  formatTime,
  formatPace,
  destroyProgressChart,
  downloadCanvasPNG,
  buildSeries,
  renderProgressChart,

  attendanceHas,
  attendanceAdd,
  attendanceRemove,
  hasRoutineExerciseLog,
  lifetimeMaxSet,
  setNextNudge,
  ensureFloatNext,
  maybeShowNextNudge,
  bindFloatNext,
  clearNextNudge,

  // attendance-ui helpers + engine
  isTrained,
  toggleTrained,
  ymFromISO,
  monthTitle,
  daysInMonth,
  firstDayDow,
  isoForYMD,
  AttendanceEngine,

  // protein-ui helpers
  buildProteinTodayModal,
  deleteMeal,
  totalProtein,

  // logs.protein helpers (some views reference directly)
  findProteinEntry,
  ensureProteinEntry,
  cleanupProteinEntryIfEmpty,
  getProteinForDate,
  upsertMeal,

  UIState,
  navigate
});



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
