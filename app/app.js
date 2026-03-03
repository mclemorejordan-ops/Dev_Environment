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


/********************
 * Social (Friends) — Events-only (Phase Social v1)
 * - Uses Supabase (optional) to publish + read compact activity events
 * - Additive only: does NOT change existing state/storage schema
 ********************/
const SOCIAL_CFG_KEY = "pc.social.supabase.v1";
const SOCIAL_OUTBOX_KEY = "pc.social.outbox.v1";

// ─────────────────────────────
// Friends (Option B): baked-in Supabase config
// - Sets defaults only if user has NOT configured anything yet
// - Respects {"disabled":true} to allow a real "Disconnect"
// ─────────────────────────────
const SOCIAL_DEFAULT = {
  // ✅ Replace with YOUR Supabase values (Project Settings → API)
  url: "https://hnzxnimyugjnyurfydna.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuenhuaW15dWdqbnl1cmZ5ZG5hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MDk1OTEsImV4cCI6MjA4ODA4NTU5MX0.JbGkZzBWqIRsDO7DCIGArPs1eJz1fswb09E7N7fTzKg"
};

function ensureSocialDefaultConfig(){
  try{
    const raw = localStorage.getItem(SOCIAL_CFG_KEY);
    if(raw){
      // Respect existing config, including explicit disable
      try{
        const parsed = JSON.parse(raw);
        if(parsed && parsed.disabled) return;
      }catch(_){}
      return;
    }
    if(!SOCIAL_DEFAULT.url || !SOCIAL_DEFAULT.anonKey) return;
    localStorage.setItem(SOCIAL_CFG_KEY, JSON.stringify(SOCIAL_DEFAULT));
  }catch(_){}
}

ensureSocialDefaultConfig();

function readSocialConfig(){
  try{ return JSON.parse(localStorage.getItem(SOCIAL_CFG_KEY) || "null"); }catch(_){ return null; }
}
function writeSocialConfig(cfg){
  try{ localStorage.setItem(SOCIAL_CFG_KEY, JSON.stringify(cfg || null)); }catch(_){}
}

function readOutbox(){
  try{ return JSON.parse(localStorage.getItem(SOCIAL_OUTBOX_KEY) || "[]"); }catch(_){ return []; }
}
function writeOutbox(items){
  try{ localStorage.setItem(SOCIAL_OUTBOX_KEY, JSON.stringify(items || [])); }catch(_){}
}

function initSocial(){
  let _mod = null;
  let _sb = null;
  let _cfg = readSocialConfig();
  let _user = null;
  let _feed = [];       // newest first
  let _follows = [];    // list of followed user ids (strings)
  let _pollTimer = null;
  let _listeners = new Set();

  async function loadSupabaseModule(){
    if(_mod) return _mod;
    // Supabase JS v2 as ESM via jsDelivr (allowed by CSP)
    _mod = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    return _mod;
  }

  async function ensureClient(){
    _cfg = readSocialConfig();
    if(!_cfg?.url || !_cfg?.anonKey){
      _sb = null;
      _user = null;
      return null;
    }
    if(_sb) return _sb;

    const mod = await loadSupabaseModule();
    _sb = mod.createClient(_cfg.url, _cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    // keep cached user current
    try{
      const { data } = await _sb.auth.getUser();
      _user = data?.user || null;
    }catch(_){
      _user = null;
    }

    // react to auth changes
    try{
      _sb.auth.onAuthStateChange((_event, session) => {
        _user = session?.user || null;
        notify();
        if(_user) startFeed();
        else stopFeed();
      });
    }catch(_){}

    return _sb;
  }

  function isConfigured(){
    _cfg = readSocialConfig();
    return !!(_cfg?.url && _cfg?.anonKey);
  }
  function getUser(){ return _user; }
  function getFeed(){ return _feed.slice(); }
  function getFollows(){ return _follows.slice(); }

  function onChange(fn){
    if(typeof fn !== "function") return () => {};
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  }
  function notify(){
    try{ _listeners.forEach(fn => fn()); }catch(_){}
  }

  async function configure({ url, anonKey }){
    const clean = {
      url: (url || "").trim(),
      anonKey: (anonKey || "").trim()
    };
    writeSocialConfig(clean.url && clean.anonKey ? clean : null);
    // reset
    _cfg = readSocialConfig();
    _sb = null;
    _user = null;
    stopFeed();
    notify();
    await ensureClient();
    notify();
  }

  async function signInWithOtp(email){
  const sb = await ensureClient();
  if(!sb) throw new Error("Social not configured");
  const e = (email || "").trim();
  if(!e) throw new Error("Email required");

  // Magic link / OTP email. Works well for PWAs.
  const redirectTo = location.origin + location.pathname;
  const { error } = await sb.auth.signInWithOtp({
    email: e,
    options: { emailRedirectTo: redirectTo }
  });
  if(error) throw error;
}

async function signInWithOAuth(provider){
  const sb = await ensureClient();
  if(!sb) throw new Error("Social not configured");

  const p = (provider || "").trim();
  if(!p) throw new Error("Provider required");

  // OAuth redirect back to this app (hash router friendly)
  const redirectTo = location.origin + location.pathname;

  const { error } = await sb.auth.signInWithOAuth({
    provider: p,
    options: { redirectTo }
  });
  if(error) throw error;
}

  async function signOut(){
    const sb = await ensureClient();
    if(!sb) return;
    try{ await sb.auth.signOut(); }catch(_){}
    _user = null;
    stopFeed();
    notify();
  }

  async function refreshUser(){
    const sb = await ensureClient();
    if(!sb) { _user = null; notify(); return; }
    try{
      const { data } = await sb.auth.getUser();
      _user = data?.user || null;
    }catch(_){
      _user = null;
    }
    notify();
  }

  async function fetchFollows(){
    const sb = await ensureClient();
    if(!sb || !_user) { _follows = []; return []; }
    try{
      const { data, error } = await sb
        .from("follows")
        .select("followee_id")
        .eq("follower_id", _user.id);
      if(error) throw error;
      _follows = (data || []).map(r => String(r.followee_id || "")).filter(Boolean);
      return _follows;
    }catch(_){
      _follows = [];
      return [];
    }
  }

  async function fetchFeed(){
    const sb = await ensureClient();
    if(!sb || !_user) { _feed = []; notify(); return; }

    // Ensure we know who we're following (used by RLS + UI)
    await fetchFollows();

    try{
      const { data, error } = await sb
        .from("activity_events")
        .select("id, actor_id, type, payload, created_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if(error) throw error;

      _feed = (data || []).map(r => ({
        id: r.id,
        actorId: r.actor_id,
        type: r.type,
        payload: r.payload || {},
        createdAt: r.created_at
      }));
    }catch(_){
      // keep last known feed if query fails
    }
    notify();
  }

  function startFeed(){
    stopFeed();
    if(!_user) return;
    fetchFeed();
    _pollTimer = setInterval(fetchFeed, 12000); // 12s: feels live, low cost
  }

  function stopFeed(){
    if(_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; }
  }

  async function follow(userId){
    const sb = await ensureClient();
    if(!sb || !_user) throw new Error("Not signed in");
    const id = (userId || "").trim();
    if(!id) throw new Error("Friend code required");
    if(id === _user.id) throw new Error("You can't follow yourself");

    const { error } = await sb.from("follows").insert({
      follower_id: _user.id,
      followee_id: id
    });
    if(error) throw error;
    await fetchFeed();
  }

  async function unfollow(userId){
    const sb = await ensureClient();
    if(!sb || !_user) return;
    const id = (userId || "").trim();
    if(!id) return;

    const { error } = await sb
      .from("follows")
      .delete()
      .eq("follower_id", _user.id)
      .eq("followee_id", id);
    if(error) throw error;
    await fetchFeed();
  }

  // stateRef is injected later (avoid circular init)
  let stateRef = () => null;
  function bindStateGetter(fn){ stateRef = (typeof fn === "function") ? fn : (() => null); }

  function formatLogEvent(entry){
    const state = stateRef();
    const lib = state?.library;
    const exName = (() => {
      try{
        const ex = (lib?.exercises || []).find(x => String(x.id||"") === String(entry.exerciseId||""));
        return ex?.name || "Exercise";
      }catch(_){ return "Exercise"; }
    })();

    const type = String(entry?.type || "");
    const summary = entry?.summary || {};
    const pr = entry?.pr || {};
    const prCount = ["isPRWeight","isPR1RM","isPRVolume","isPRPace"].filter(k => pr?.[k]).length;

    return {
      eventType: "exercise_logged",
      payload: {
        displayName: state?.profile?.name || null,
        exerciseName: exName,
        workoutType: type,
        dateISO: entry?.dateISO || null,
        routineId: entry?.routineId || null,
        dayId: entry?.dayId || null,
        summary,
        prCount
      }
    };
  }

function formatWorkoutCompletedEvent({ dateISO, routineId, dayId, highlights, details }){
  const state = stateRef();
  return {
    eventType: "workout_completed",
    payload: {
      displayName: state?.profile?.name || null,
      dateISO: dateISO || null,
      routineId: routineId || null,
      dayId: dayId || null,
      highlights: highlights || {},
      details: details || null
    }
  };
}
  

  async function flushOutbox(){
    const sb = await ensureClient();
    if(!sb || !_user) return;

    const items = readOutbox();
    if(!items.length) return;

    const keep = [];
    for(const it of items){
      try{
        const { error } = await sb.from("activity_events").insert(it);
        if(error) throw error;
      }catch(_){
        keep.push(it);
      }
    }
    writeOutbox(keep);
  }

  async function publishLogEvent(entry){
    // Only publish if configured + signed in
    if(!isConfigured()) return;
    await ensureClient();
    if(!_user) return;

    const ev = formatLogEvent(entry);
    const row = {
      actor_id: _user.id,
      type: ev.eventType,
      payload: ev.payload
    };

    // Try immediate insert, else queue
    try{
      const sb = await ensureClient();
      if(!sb) return;
      const { error } = await sb.from("activity_events").insert(row);
      if(error) throw error;
      // refresh quickly
      fetchFeed();
    }catch(_){
      const out = readOutbox();
      out.unshift(row);
      writeOutbox(out.slice(0, 100)); // cap
    }
  }


async function publishWorkoutCompletedEvent({ dateISO, routineId, dayId, highlights, details }){
  // Only publish if configured + signed in
  if(!isConfigured()) return;
  await ensureClient();
  if(!_user) return;

  const ev = formatWorkoutCompletedEvent({ dateISO, routineId, dayId, highlights, details });
  const row = {
    actor_id: _user.id,
    type: ev.eventType,
    payload: ev.payload
  };

  // Try immediate insert, else queue
  try{
    const sb = await ensureClient();
    if(!sb) return;
    const { error } = await sb.from("activity_events").insert(row);
    if(error) throw error;
    fetchFeed();
  }catch(_){
    const out = readOutbox();
    out.unshift(row);
    writeOutbox(out.slice(0, 100));
  }
}
  

  // flush queued events when online
  window.addEventListener("online", () => { try{ flushOutbox(); }catch(_){} });

  return {
    // wiring
    bindStateGetter,

    // config/auth
    isConfigured,
    getConfig: () => readSocialConfig(),
    configure,
    signInWithOtp,
    signInWithOAuth,   // ← ADD THIS LINE
    signOut,
    refreshUser,
    getUser,

    // follows + feed
    follow,
    unfollow,
    getFollows,
    getFeed,
    startFeed,
    stopFeed,
    fetchFeed,

    // publishing
    publishLogEvent,
    flushOutbox,
    publishWorkoutCompletedEvent,

    // UI updates
    onChange
  };
}

const Social = initSocial();
Social.bindStateGetter(() => state);


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

const { LogEngine, removeWorkoutEntryById } = initWorkouts({ getState: () => state, Storage, Social });


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
  open: { "profile": true, "library": false, "backup": false, "data": false, "support": false, "routines": false }
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

      // ✅ Goals (persistent)
      goals: {
        weeklySessionsTarget: 4,
        targetWeight: null,
        items: [] // ✅ new additive goals list
      },

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

// ✅ Goals — v2 (user-added goals + progress)
el("div", { class:"card" }, (() => {
  if(!state.profile){
    return [
      el("h2", { text:"Goals" }),
      el("div", { class:"note", text:"Complete onboarding to add goals." })
    ];
  }

  // Ensure containers exist (migration covers old saves, this keeps UI safe)
  state.profile.goals = (state.profile.goals && typeof state.profile.goals === "object") ? state.profile.goals : {};
  if(!Array.isArray(state.profile.goals.items)) state.profile.goals.items = [];

  const goals = state.profile.goals.items;

  function clamp01(x){ return Math.max(0, Math.min(1, Number(x) || 0)); }

  function pctRatio(cur, target){
    cur = Number(cur) || 0;
    target = Number(target) || 0;
    if(!(target > 0)) return 0;
    return clamp01(cur / target);
  }

  // Strength: top weight since goal creation (bestWeight)
  function bestStrengthSince(exerciseId, sinceTs){
    let best = null;
    const arr = Array.isArray(state?.logs?.workouts) ? state.logs.workouts : [];
    for(const e of arr){
      if(!e) continue;
      if(e.type !== "weightlifting") continue;
      if(e.exerciseId !== exerciseId) continue;
      if((e.createdAt || 0) < sinceTs) continue;

      const bw = Number(e?.summary?.bestWeight);
      if(Number.isFinite(bw)){
        best = (best === null) ? bw : Math.max(best, bw);
      }
    }
    return best;
  }

  // Cardio: best distance since goal creation (totalDistance)
  function bestCardioDistanceSince(exerciseId, sinceTs){
    let best = null;
    const arr = Array.isArray(state?.logs?.workouts) ? state.logs.workouts : [];
    for(const e of arr){
      if(!e) continue;
      if(e.type !== "cardio") continue;
      if(e.exerciseId !== exerciseId) continue;
      if((e.createdAt || 0) < sinceTs) continue;

      const v = Number(e?.summary?.totalDistance);
      if(Number.isFinite(v)){
        best = (best === null) ? v : Math.max(best, v);
      }
    }
    return best;
  }

  // Cardio: best time since goal creation (totalTime)
  function bestCardioTimeSince(exerciseId, sinceTs){
    let best = null;
    const arr = Array.isArray(state?.logs?.workouts) ? state.logs.workouts : [];
    for(const e of arr){
      if(!e) continue;
      if(e.type !== "cardio") continue;
      if(e.exerciseId !== exerciseId) continue;
      if((e.createdAt || 0) < sinceTs) continue;

      const v = Number(e?.summary?.totalTime);
      if(Number.isFinite(v)){
        best = (best === null) ? v : Math.max(best, v);
      }
    }
    return best;
  }

  // Core: best total volume since goal creation (totalVolume)
  function bestCoreVolumeSince(exerciseId, sinceTs){
    let best = null;
    const arr = Array.isArray(state?.logs?.workouts) ? state.logs.workouts : [];
    for(const e of arr){
      if(!e) continue;
      if(e.type !== "core") continue;
      if(e.exerciseId !== exerciseId) continue;
      if((e.createdAt || 0) < sinceTs) continue;

      const v = Number(e?.summary?.totalVolume);
      if(Number.isFinite(v)){
        best = (best === null) ? v : Math.max(best, v);
      }
    }
    return best;
  }

  // Weekly sessions: this week attendance count
  function sessionsThisWeek(){
    return trainedThisWeek.filter(x => x.trained).length;
  }

  function removeGoal(goalId){
    const idx = goals.findIndex(g => g && g.id === goalId);
    if(idx < 0) return;
    goals.splice(idx, 1);
    Storage.save(state);
    showToast("Goal removed");
    renderView();
  }

  function openAddGoalModal(){
    let mode = "strength"; // strength | weekly | weight | cardioDist | cardioTime | coreVol

    const modeSel = el("select", {
      onChange: (e) => { mode = String(e.target.value || "strength"); repaint(); }
    }, [
      el("option", { value:"strength", text:"Strength — Top weight (since creation)" }),
      el("option", { value:"cardioDist", text:"Cardio — Distance (since creation)" }),
      el("option", { value:"cardioTime", text:"Cardio — Time (since creation)" }),
      el("option", { value:"coreVol", text:"Core — Volume (since creation)" }),
      el("option", { value:"weekly", text:"Weekly sessions (Attendance)" }),
      el("option", { value:"weight", text:"Bodyweight" })
    ]);

    const body = el("div", {}, []);

    // Shared inputs
    const targetNum = el("input", { type:"number", inputmode:"decimal", step:"0.1", placeholder:"Target" });
    const weeklyTarget = el("input", { type:"number", inputmode:"numeric", min:"1", step:"1", placeholder:"Target (e.g. 4)" });
    const targetWeight = el("input", { type:"number", inputmode:"decimal", step:"0.1", placeholder:"Target weight (e.g. 185.0)" });

    // Exercise selects
    const strengthSel = el("select", {});
    const cardioSel = el("select", {});
    const coreSel = el("select", {});

    function loadSelect(sel, list){
      sel.innerHTML = "";
      sel.appendChild(el("option", { value:"", text:"Select an exercise…" }));
      (list || []).forEach(x => {
        if(!x || !x.id) return;
        sel.appendChild(el("option", { value:x.id, text: x.name || "Exercise" }));
      });
    }

    const wl = Array.isArray(state?.exerciseLibrary?.weightlifting) ? state.exerciseLibrary.weightlifting.slice() : [];
    wl.sort((a,b) => String(a?.name||"").localeCompare(String(b?.name||"")));
    loadSelect(strengthSel, wl);

    const cd = Array.isArray(state?.exerciseLibrary?.cardio) ? state.exerciseLibrary.cardio.slice() : [];
    cd.sort((a,b) => String(a?.name||"").localeCompare(String(b?.name||"")));
    loadSelect(cardioSel, cd);

    const co = Array.isArray(state?.exerciseLibrary?.core) ? state.exerciseLibrary.core.slice() : [];
    co.sort((a,b) => String(a?.name||"").localeCompare(String(b?.name||"")));
    loadSelect(coreSel, co);

    function save(){
      const now = Date.now();
      const idFn = (typeof uid === "function") ? uid : (p => `${p || "g"}_${Date.now()}`);

      function addGoal(g){
        goals.push(g);
        Storage.save(state);
        showToast("Goal added");
        Modal.close();
        renderView();
      }

      if(mode === "strength"){
        const exerciseId = String(strengthSel.value || "").trim();
        const target = Number(targetNum.value);

        if(!exerciseId){ showToast("Pick an exercise"); return; }
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a valid target"); return; }

        const ex = wl.find(x => x.id === exerciseId);
        const nameSnap = ex?.name || "Strength";

        addGoal({
          id: idFn("g"),
          kind: "strength_top_weight_since",
          title: `${nameSnap} → ${target}`,
          exerciseId,
          exerciseNameSnap: nameSnap,
          targetValue: target,
          createdAt: now
        });
      }

      if(mode === "cardioDist"){
        const exerciseId = String(cardioSel.value || "").trim();
        const target = Number(targetNum.value);

        if(!exerciseId){ showToast("Pick an exercise"); return; }
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a valid distance target"); return; }

        const ex = cd.find(x => x.id === exerciseId);
        const nameSnap = ex?.name || "Cardio";

        addGoal({
          id: idFn("g"),
          kind: "cardio_distance_since",
          title: `${nameSnap} distance → ${target}`,
          exerciseId,
          exerciseNameSnap: nameSnap,
          targetValue: target,
          createdAt: now
        });
      }

      if(mode === "cardioTime"){
        const exerciseId = String(cardioSel.value || "").trim();
        const target = Number(targetNum.value);

        if(!exerciseId){ showToast("Pick an exercise"); return; }
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a valid time target"); return; }

        const ex = cd.find(x => x.id === exerciseId);
        const nameSnap = ex?.name || "Cardio";

        addGoal({
          id: idFn("g"),
          kind: "cardio_time_since",
          title: `${nameSnap} time → ${target}`,
          exerciseId,
          exerciseNameSnap: nameSnap,
          targetValue: target,
          createdAt: now
        });
      }

      if(mode === "coreVol"){
        const exerciseId = String(coreSel.value || "").trim();
        const target = Number(targetNum.value);

        if(!exerciseId){ showToast("Pick an exercise"); return; }
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a valid volume target"); return; }

        const ex = co.find(x => x.id === exerciseId);
        const nameSnap = ex?.name || "Core";

        addGoal({
          id: idFn("g"),
          kind: "core_volume_since",
          title: `${nameSnap} volume → ${target}`,
          exerciseId,
          exerciseNameSnap: nameSnap,
          targetValue: target,
          createdAt: now
        });
      }

      if(mode === "weekly"){
        const target = Number(weeklyTarget.value);
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a weekly target"); return; }

        addGoal({
          id: idFn("g"),
          kind: "weekly_sessions",
          title: `Weekly sessions → ${Math.round(target)}`,
          targetValue: Math.max(1, Math.round(target)),
          createdAt: now
        });
      }

      if(mode === "weight"){
        const target = Number(targetWeight.value);
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a target weight"); return; }

        const latest = WeightEngine.latest();
        const start = latest ? Number(latest.weight) : 0;

        addGoal({
          id: idFn("g"),
          kind: "bodyweight",
          title: `Bodyweight → ${target}`,
          startValue: start,
          targetValue: target,
          createdAt: now
        });
      }
    }

    function repaint(){
      body.innerHTML = "";

      body.appendChild(el("div", { class:"setRow" }, [
        el("div", {}, [
          el("div", { style:"font-weight:820;", text:"Goal type" }),
          el("div", { class:"meta", text:"Choose what you want to track" })
        ]),
        modeSel
      ]));

      if(mode === "strength"){
        targetNum.placeholder = "Target top weight (e.g. 225)";
        targetNum.step = "0.5";
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Exercise" }),
            el("div", { class:"meta", text:"Weightlifting only" })
          ]),
          strengthSel
        ]));
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [ el("div", { style:"font-weight:820;", text:"Target" }), el("div", { class:"meta", text:"Top weight since goal creation" }) ]),
          targetNum
        ]));
      }

      if(mode === "cardioDist"){
        targetNum.placeholder = "Target distance (e.g. 3.0)";
        targetNum.step = "0.1";
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Exercise" }),
            el("div", { class:"meta", text:"Cardio only" })
          ]),
          cardioSel
        ]));
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [ el("div", { style:"font-weight:820;", text:"Target" }), el("div", { class:"meta", text:"Best single-workout distance since creation" }) ]),
          targetNum
        ]));
      }

      if(mode === "cardioTime"){
        targetNum.placeholder = "Target time (minutes, e.g. 30)";
        targetNum.step = "1";
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Exercise" }),
            el("div", { class:"meta", text:"Cardio only" })
          ]),
          cardioSel
        ]));
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [ el("div", { style:"font-weight:820;", text:"Target" }), el("div", { class:"meta", text:"Best single-workout time since creation" }) ]),
          targetNum
        ]));
      }

      if(mode === "coreVol"){
        targetNum.placeholder = "Target volume (e.g. 100)";
        targetNum.step = "1";
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Exercise" }),
            el("div", { class:"meta", text:"Core only" })
          ]),
          coreSel
        ]));
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [ el("div", { style:"font-weight:820;", text:"Target" }), el("div", { class:"meta", text:"Best single-workout volume since creation" }) ]),
          targetNum
        ]));
      }

      if(mode === "weekly"){
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Weekly sessions target" }),
            el("div", { class:"meta", text:"Based on Attendance check-ins" })
          ]),
          weeklyTarget
        ]));
      }

      if(mode === "weight"){
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Target bodyweight" }),
            el("div", { class:"meta", text:"Current vs target" })
          ]),
          targetWeight
        ]));
      }

      body.appendChild(el("div", { style:"height:10px" }));
      body.appendChild(el("div", { class:"btnrow" }, [
        el("button", { class:"btn", onClick: () => Modal.close() }, ["Cancel"]),
        el("button", { class:"btn primary", onClick: save }, ["Add goal"])
      ]));
    }

    repaint();

    Modal.open({ title: "Add goal", bodyNode: body });
  }

  function currentForGoal(g){
    const since = Number(g?.createdAt || 0);

    if(g.kind === "weekly_sessions"){
      return sessionsThisWeek();
    }
    if(g.kind === "bodyweight"){
      const latest = WeightEngine.latest();
      return latest ? Number(latest.weight) : 0;
    }
    if(g.kind === "strength_top_weight_since"){
      const v = bestStrengthSince(g.exerciseId, since);
      return (v == null) ? 0 : Number(v);
    }
    if(g.kind === "cardio_distance_since"){
      const v = bestCardioDistanceSince(g.exerciseId, since);
      return (v == null) ? 0 : Number(v);
    }
    if(g.kind === "cardio_time_since"){
      const v = bestCardioTimeSince(g.exerciseId, since);
      return (v == null) ? 0 : Number(v);
    }
    if(g.kind === "core_volume_since"){
      const v = bestCoreVolumeSince(g.exerciseId, since);
      return (v == null) ? 0 : Number(v);
    }

    return 0;
  }

  function metaForGoal(g, cur){
    const t = Number(g?.targetValue || 0);

    if(g.kind === "weekly_sessions"){
      return `This week: ${cur} / ${t}`;
    }
    if(g.kind === "bodyweight"){
      const s = (g.startValue == null) ? "—" : Number(g.startValue).toFixed(1);
      const c = cur ? Number(cur).toFixed(1) : "—";
      const tt = t ? Number(t).toFixed(1) : "—";
      return `Now: ${c} • Start: ${s} → Target: ${tt}`;
    }
    if(g.kind === "strength_top_weight_since"){
      return `Now: ${cur ? Number(cur).toFixed(1) : "—"} • Target: ${t ? Number(t).toFixed(1) : "—"}`;
    }
    if(g.kind === "cardio_distance_since"){
      return `Now: ${cur ? Number(cur).toFixed(2) : "—"} • Target: ${t ? Number(t).toFixed(2) : "—"}`;
    }
    if(g.kind === "cardio_time_since"){
      return `Now: ${cur ? Number(cur).toFixed(0) : "—"} • Target: ${t ? Number(t).toFixed(0) : "—"}`;
    }
    if(g.kind === "core_volume_since"){
      return `Now: ${cur ? Number(cur).toFixed(0) : "—"} • Target: ${t ? Number(t).toFixed(0) : "—"}`;
    }

    return "";
  }

  const listNode =
    goals.length === 0
      ? el("div", { class:"note", text:"No goals yet. Tap Add goal to create one." })
      : el("div", { style:"display:flex; flex-direction:column; gap:10px; margin-top:10px;" },
          goals.map(g => {
            const cur = currentForGoal(g);
            const pct =
              (g.kind === "bodyweight")
                ? (function(){
                    const start = Number(g.startValue || 0);
                    const target = Number(g.targetValue || 0);
                    if(target === start) return 0;
                    return clamp01((cur - start) / (target - start));
                  })()
                : pctRatio(cur, Number(g.targetValue || 0));

            const pctTxt = `${Math.round(pct * 100)}%`;

            return el("div", {
              style:"border:1px solid rgba(255,255,255,.10); background: rgba(255,255,255,.04); border-radius:16px; padding:12px;"
            }, [
              el("div", { class:"homeRow" }, [
                el("div", {}, [
                  el("div", { style:"font-weight:900; letter-spacing:.2px;", text: g.title || "Goal" }),
                  el("div", { class:"note", text: `${metaForGoal(g, cur)} • ${pctTxt}` })
                ]),
                el("button", { class:"btn danger", onClick: () => removeGoal(g.id) }, ["Remove"])
              ]),

              el("div", { style:"height:10px" }),
              el("div", { class:"proteinBar", style:"height:12px;" }, [
                el("div", { class:"proteinBarFill", style:`width:${Math.round(pct * 100)}%` })
              ])
            ]);
          })
        );

  return [
    el("div", { class:"homeRow" }, [
      el("div", {}, [
        el("h2", { text:"Goals" }),
        el("div", { class:"note", text:"Goals you create. Progress updates automatically from your logs." })
      ]),
      el("button", { class:"btn primary", onClick: openAddGoalModal }, ["+ Add goal"])
    ]),
    listNode
  ];
})()),

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

  function afterSave(savedDateISO, wasComplete=false){
  Modal.close();

  // If the whole day JUST became complete, auto-complete + attendance + publish (Friends feed)
  const nowComplete = isDayComplete(savedDateISO, day);
  if(nowComplete && !wasComplete){
    attendanceAdd(savedDateISO);
    showToast("Day completed ✅");

    // Friends/Social: publish ONE event for the completed workout (not each exercise/set)
    try{
      if(Social && typeof Social.publishWorkoutCompletedEvent === "function"){
        const entries = (state?.logs?.workouts || []).filter(e =>
          String(e?.dateISO || "") === String(savedDateISO || "") &&
          String(e?.routineId || "") === String(routine?.id || "") &&
          String(e?.dayId || "") === String(day?.id || "")
        );

        const exSet = new Set();
        let totalVolume = 0;
        let prCount = 0;

        for(const e of entries){
          if(e?.routineExerciseId) exSet.add(String(e.routineExerciseId));
          if(Number.isFinite(Number(e?.summary?.totalVolume))) totalVolume += Number(e.summary.totalVolume) || 0;

          const pr = e?.pr || {};
          prCount += ["isPRWeight","isPR1RM","isPRVolume","isPRPace"].filter(k => pr?.[k]).length;
        }

        // Build richer "details" so feed items can be tapped for the full breakdown
let details = null;
try{
  // Group by routineExerciseId (one line item per exercise)
  const byRx = new Map();
  for(const e of entries){
    const k = String(e?.routineExerciseId || e?.exerciseId || "");
    if(!k) continue;
    if(!byRx.has(k)) byRx.set(k, e);
  }

  const items = [];
  for(const e of byRx.values()){
    const type = String(e?.type || "");
    const exerciseId = e?.exerciseId || null;

    const exName = (() => {
      try{
        // Prefer the library if possible, else fall back
        const lib = state?.exerciseLibrary?.[type] || [];
        const found = lib.find(x => String(x.id||"") === String(exerciseId||""));
        return found?.name || e?.nameSnap || "Exercise";
      }catch(_){
        return e?.nameSnap || "Exercise";
      }
    })();

    // Top set / rep (or top cardio / core summary)
    let topText = "";
    try{
      if(type === "weightlifting"){
        const sets = Array.isArray(e?.sets) ? e.sets : [];
        let best = null;
        for(const s of sets){
          const w = Number(s?.weight) || 0;
          const r = Number(s?.reps) || 0;
          if(!best || w > best.w) best = { w, r };
        }
        if(best) topText = `${best.w}×${best.r}`;
        else if(Number.isFinite(Number(e?.summary?.bestWeight))) topText = `${Number(e.summary.bestWeight)} (top)`;
      }else if(type === "cardio"){
        const d = e?.summary?.distance;
        const t = e?.summary?.timeSec;
        const p = e?.summary?.paceSecPerUnit;
        const dist = (d == null) ? "" : `Dist ${d}`;
        const time = (t == null) ? "" : `Time ${formatTime(Number(t) || 0)}`;
        const pace = (p == null) ? "" : `Pace ${formatPace(p)}`;
        topText = [dist, time, pace].filter(Boolean).join(" • ");
      }else if(type === "core"){
        // Core varies; show best available summary
        const t = e?.summary?.timeSec;
        const reps = e?.summary?.reps;
        const sets = e?.summary?.sets;
        const w = e?.summary?.weight;
        const parts = [];
        if(Number.isFinite(Number(sets))) parts.push(`${Number(sets)} sets`);
        if(Number.isFinite(Number(reps))) parts.push(`${Number(reps)} reps`);
        if(Number.isFinite(Number(t))) parts.push(`${formatTime(Number(t) || 0)}`);
        if(Number.isFinite(Number(w)) && Number(w) > 0) parts.push(`${Number(w)} lb`);
        topText = parts.join(" • ");
      }
    }catch(_){}

    // PR badges
    const pr = e?.pr || {};
    const prBadges = [];
    if(pr?.isPRWeight) prBadges.push("PR W");
    if(pr?.isPR1RM) prBadges.push("PR 1RM");
    if(pr?.isPRVolume) prBadges.push("PR Vol");
    if(pr?.isPRPace) prBadges.push("PR Pace");

    // Lifetime bests (best-effort: only if engine supports it)
    let lifetime = null;
    try{
      if(LogEngine && typeof LogEngine.lifetimeBests === "function" && exerciseId){
        lifetime = LogEngine.lifetimeBests(type, exerciseId) || null;
      }
    }catch(_){}

    items.push({
      type,
      exerciseId,
      name: exName,
      topText: topText || "",
      prBadges,
      lifetime
    });
  }

  details = {
    dayLabel: day?.label || null,
    dateISO: savedDateISO || null,
    items
  };
}catch(_){}

Social.publishWorkoutCompletedEvent({
  dateISO: savedDateISO,
  routineId: routine?.id || null,
  dayId: day?.id || null,
  highlights: {
    exerciseCount: exSet.size,
    prCount,
    totalVolume: Math.round(totalVolume * 100) / 100
  },
  details
});
      }
    }catch(_){}
  }
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
      const wasComplete = isDayComplete(dateISO, day);

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

      afterSave(dateISO, wasComplete);
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


   Friends(){
  // Events-only friends feed (while app is open)
  const ui = UIState.social || (UIState.social = {});
  ui.friendId = ui.friendId || "";
  ui.email = ui.email || "";

  const root = el("div", { class:"grid" });

  const user = Social.getUser && Social.getUser();
  const configured = Social.isConfigured && Social.isConfigured();

  // ✅ Live Online/Offline pill updates (only re-render on Friends route)
if(!ui.__netSub){
  ui.__netSub = true;

  ui.__netHandler = () => {
    const r = (String(location.hash || "").replace(/^#/, "") || "home");
    if(r === "friends"){
      try{ renderView(); }catch(_){}
    }
  };

  try{
    window.addEventListener("online", ui.__netHandler);
    window.addEventListener("offline", ui.__netHandler);
  }catch(_){}
}
  
  // Header / status
const signedIn = !!user;

root.appendChild(el("div", { class:"card" }, [
  el("div", { class:"rowBetween" }, [
    el("h2", { text:"Friends" }),
    configured ? el("div", {
      class:"pill",
      text: signedIn ? "Signed in" : "Signed out",
      style: signedIn
        ? "opacity:.95;"
        : "opacity:.95; border: 1px solid rgba(255,92,122,.35); color: rgba(255,92,122,.95);"
    }) : null
  ].filter(Boolean)),

  el("div", { style:"height:12px" }),

  !configured
    ? el("div", {
        class:"note",
        style:"color: rgba(255,92,122,.95);",
        text:"Social is not configured yet. Set your Supabase URL + anon key in Settings → Friends (Beta)."
      })
    : null,

  el("div", { style:"height:10px" }),

  // Auth row (Friends header: sign-out + refresh removed)
  configured ? el("div", { class:"btnrow" }, [
    !user ? el("button", {
      class:"btn primary",
      onClick: async () => {
        try{
          await Social.signInWithOAuth("google");
        }catch(e){
          showToast(e?.message || "Google sign-in failed");
        }
      }
    }, ["Continue with Google"]) : null
  ].filter(Boolean)) : null
].filter(Boolean)));


  // Feed
  const feed = Social.getFeed ? Social.getFeed() : [];
  root.appendChild(el("div", { class:"card" }, [
    el("div", { class:"rowBetween" }, [
      el("div", { class:"note", text:"Feed" }),
      el("button", {
        class:"btn sm",
        onClick: async () => {
          try{ await Social.fetchFeed(); showToast("Updated"); }catch(_){}
        }
      }, ["Refresh"])
    ]),
    el("div", { style:"height:10px" }),

    !user ? el("div", { class:"note", text:"Sign in to see your feed." }) : null,
    user && !feed.length ? el("div", { class:"note", text:"No events yet. Your activity (and friends you follow) will show here." }) : null,

    user && feed.length ? el("div", {}, feed.map(ev => {
      const p = ev.payload || {};
      const who = p.displayName || (String(ev.actorId||"").slice(0,8) + "…");
      const when = ev.createdAt ? new Date(ev.createdAt).toLocaleString() : "";
      const title = (ev.type === "exercise_logged")
  ? `${who} logged ${p.exerciseName || "an exercise"}`
  : (ev.type === "workout_completed")
    ? `${who} completed a workout`
    : `${who} posted an event`;

const chips = [];
if(ev.type === "workout_completed"){
  const h = p.highlights || {};
  if(Number.isFinite(h.exerciseCount) && h.exerciseCount > 0) chips.push(`${h.exerciseCount} exercises`);
  if(Number.isFinite(h.prCount) && h.prCount > 0) chips.push(`PRs: ${h.prCount}`);
  if(Number.isFinite(h.totalVolume) && h.totalVolume > 0) chips.push(`Vol ${h.totalVolume}`);
}else{
  if(p.workoutType) chips.push(String(p.workoutType));
  if(Number.isFinite(p.prCount) && p.prCount > 0) chips.push(`PRs: ${p.prCount}`);
}

      function openExerciseHistoryFromFeed(type, exerciseId, exName){
  try{
    if(!exerciseId) return;
    LogEngine.ensure();

    const entries = LogEngine.entriesForExercise(type, exerciseId); // desc (most recent first)

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
          return `Dist: ${d} | Time: ${t} | Pace: ${p}`;
        }
        if(type === "core"){
          const sets = entry.summary?.sets ?? "—";
          const reps = entry.summary?.reps ?? "—";
          const t = entry.summary?.timeSec ? formatTime(entry.summary.timeSec) : "";
          return `Sets: ${sets} | Reps: ${reps}${t ? ` | Time: ${t}` : ""}`;
        }
      }catch(_){}
      return "";
    }

    const list = el("div", { class:"list" });
    if(!entries.length){
      list.appendChild(el("div", { class:"note", text:"No history yet for this exercise." }));
    }else{
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
        el("div", { class:"note", text: `${exName || "Exercise"} • ${type}` }),
        list,
        el("div", { style:"height:10px" }),
        el("button", { class:"btn", onClick: Modal.close }, ["Close"])
      ])
    });
  }catch(_){}
}

function openFeedEventModal(ev, title, who, when){
  try{
    const p = ev.payload || {};
    const d = p.details || null;

    // If details are missing (older events / friend on older build), show a safe fallback.
    const body = el("div", { class:"grid" }, [
      el("div", { class:"note", text: when ? `${who} • ${when}` : who }),

      (ev.type === "workout_completed" && d?.dayLabel)
        ? el("div", { class:"kpi" }, [
            el("div", { class:"big", text: d.dayLabel }),
            el("div", { class:"small", text: d.dateISO || (p.dateISO || "") })
          ])
        : null,

      (ev.type === "workout_completed" && d?.items?.length)
        ? el("div", { class:"list" }, d.items.map(it => {
            const rightBits = [];
            if(it.topText) rightBits.push(it.topText);
            if(Array.isArray(it.prBadges) && it.prBadges.length) rightBits.push(it.prBadges.join(" • "));

            // Lifetime display (best-effort)
            let life = "";
            try{
              const L = it.lifetime || null;
              if(L){
                if(it.type === "weightlifting"){
                  const bw = (L.bestWeight != null) ? `Best W: ${L.bestWeight}` : "";
                  const b1 = (L.best1RM != null) ? `Best 1RM: ${L.best1RM}` : "";
                  const bv = (L.bestVolume != null) ? `Best Vol: ${L.bestVolume}` : "";
                  life = [bw, b1, bv].filter(Boolean).join(" • ");
                }else if(it.type === "cardio"){
                  const bp = (L.bestPace != null) ? `Best Pace: ${formatPace(L.bestPace)}` : "";
                  const bd = (L.bestDistance != null) ? `Best Dist: ${L.bestDistance}` : "";
                  life = [bp, bd].filter(Boolean).join(" • ");
                }else if(it.type === "core"){
                  const br = (L.bestReps != null) ? `Best Reps: ${L.bestReps}` : "";
                  const bt = (L.bestTimeSec != null) ? `Best Time: ${formatTime(L.bestTimeSec)}` : "";
                  life = [br, bt].filter(Boolean).join(" • ");
                }
              }
            }catch(_){}

            return el("div", {
              class:"item",
              style:"cursor:pointer;",
              onClick: () => openExerciseHistoryFromFeed(it.type, it.exerciseId, it.name)
            }, [
              el("div", { class:"left" }, [
                el("div", { class:"name", text: it.name || "Exercise" }),
                life ? el("div", { class:"meta", text: life }) : null
              ].filter(Boolean)),
              el("div", { class:"actions" }, [
                el("div", { class:"meta", text: rightBits.join(" | ") })
              ])
            ]);
          }))
        : (ev.type === "workout_completed"
            ? el("div", { class:"note", text:"Details aren’t available for this event yet (older build). New events will include full workout details." })
            : null),

      el("div", { style:"height:10px" }),
      el("button", { class:"btn", onClick: Modal.close }, ["Close"])
    ].filter(Boolean));

    Modal.open({
      title: (ev.type === "workout_completed") ? "Workout" : "Event",
      bodyNode: body
    });
  }catch(_){}
}

return el("div", {
  class:"card",
  style:"margin: 10px 0; cursor:pointer;",
  onClick: () => openFeedEventModal(ev, title, who, when)
}, [
  el("div", { class:"rowBetween" }, [
    el("div", { style:"font-weight:820;", text: title }),
    el("div", { class:"small", text: when })
  ]),
  chips.length ? el("div", { class:"pillrow", style:"margin-top:8px;" }, chips.map(t => el("div", { class:"pill", text: t }))) : null
].filter(Boolean));
    })) : null
  ].filter(Boolean)));

  // Auto-start polling when entering the view
  try{
    if(configured && user) Social.startFeed();
  }catch(_){}

  return root;
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
  // 1) Name
  el("div", { class:"setRow" }, [
    el("div", {}, [
      el("div", { style:"font-weight:820;", text:"Name" }),
      el("div", { class:"meta", text:"Shown on Home" })
    ]),
    nameInput
  ]),

  // 2) Week starts on
  el("div", { class:"setRow" }, [
    el("div", {}, [
      el("div", { style:"font-weight:820;", text:"Week starts on" }),
      el("div", { class:"meta", text:"Affects Home week view" })
    ]),
    weekSelect
  ]),

  // 3) Daily Protein
  proteinRow,

  // 4) Toggles
  trackProteinRow,

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

const socialUI = UIState.social || (UIState.social = {});
const socialCfg = Social.getConfig && Social.getConfig();

// local, non-state inputs
socialUI.supabaseUrl = (socialUI.supabaseUrl ?? socialCfg?.url ?? "");
socialUI.supabaseAnon = (socialUI.supabaseAnon ?? socialCfg?.anonKey ?? "");
socialUI.friendId = socialUI.friendId || "";


  // ✅ Auto-populate signed-in state after OAuth redirect
// (Without requiring user to click "Save" in Settings)
const _socialConfigured = Social.isConfigured && Social.isConfigured();
const _socialUserNow = Social.getUser && Social.getUser();

// Only attempt once per app session render path
if(_socialConfigured && !_socialUserNow && !socialUI._autoUserRefreshDone){
  socialUI._autoUserRefreshDone = true;

  setTimeout(async () => {
    try{
      await Social.refreshUser();
      if(Social.getUser && Social.getUser()){
        try{ Social.startFeed && Social.startFeed(); }catch(_){}
      }
      renderView();
    }catch(_){}
  }, 0);
}

// If user is present, allow future auto-refresh attempts after sign-out
if(_socialUserNow){
  socialUI._autoUserRefreshDone = false;
}         
           
  const socialBody = el("div", {}, [
  el("div", { class:"note", text:"Connect a free Supabase project to enable the Friends feed (events-only). This does not sync your full app data — it only posts compact activity events." }),
  el("div", { style:"height:10px" }),

  el("div", { class:"setRow" }, [
    el("div", {}, [
      el("div", { style:"font-weight:820;", text:"Supabase URL" }),
      el("div", { class:"meta", text:"Project URL (https://xxxx.supabase.co)" })
    ]),
    el("input", {
      type:"text",
      value: socialUI.supabaseUrl,
      onInput: (e) => { socialUI.supabaseUrl = e.target.value || ""; }
    })
  ]),

  el("div", { class:"setRow" }, [
    el("div", {}, [
      el("div", { style:"font-weight:820;", text:"Supabase anon key" }),
      el("div", { class:"meta", text:"Settings → API → anon public key" })
    ]),
    el("input", {
      type:"password",
      value: socialUI.supabaseAnon,
      onInput: (e) => { socialUI.supabaseAnon = e.target.value || ""; }
    })
  ]),

  el("div", { style:"height:10px" }),

  el("div", { class:"btnrow" }, [
    el("button", {
      class:"btn primary",
      onClick: async () => {
        try{
          await Social.configure({ url: socialUI.supabaseUrl, anonKey: socialUI.supabaseAnon });
          showToast("Social configured");
          renderView();
        }catch(e){
          showToast(e?.message || "Couldn't save social config");
        }
      }
    }, ["Save"]),

    el("button", {
      class:"btn",
      onClick: async () => {
        try{
          await Social.configure({ url: "", anonKey: "" });
          try{ localStorage.setItem(SOCIAL_CFG_KEY, JSON.stringify({ disabled:true })); }catch(_){}
          showToast("Social disconnected");
          renderView();
        }catch(_){}
      }
    }, ["Disconnect"])
  ]),

  el("div", { style:"height:14px" }),

  el("div", { class:"note", text:"Sign-in" }),
  el("div", { class:"btnrow" }, [
    el("button", {
      class:"btn primary",
      onClick: async () => {
        try{
          await Social.signInWithOAuth("google");
        }catch(e){
          showToast(e?.message || "Google sign-in failed");
        }
      }
    }, ["Continue with Google"]),

    el("button", {
      class:"btn",
      onClick: async () => {
        try{ await Social.signOut(); showToast("Signed out"); renderView(); }catch(_){}
      }
    }, ["Sign out"])
  ]),

  // ─────────────────────────────
  // Friend code + follow controls (moved here)
  // ─────────────────────────────
  el("div", { style:"height:14px" }),

  el("div", { class:"note", text:"Your friend code" }),
  el("div", { class:"kpi" }, [
    el("div", { class:"big", text: (Social.getUser && Social.getUser()) ? Social.getUser().id : "—" }),
    el("div", { class:"small", text:"Share this code with friends so they can follow you." })
  ]),

  el("div", { style:"height:12px" }),

  el("div", { class:"note", text:"Follow a friend" }),
  el("div", { class:"btnrow" }, [
    el("input", {
      type:"text",
      placeholder:"Paste friend code (user id)",
      value: socialUI.friendId,
      onInput: (e) => { socialUI.friendId = e.target.value || ""; }
    }),
    el("button", {
      class:"btn primary",
      onClick: async () => {
        try{
          await Social.follow(socialUI.friendId);
          socialUI.friendId = "";
          showToast("Following");
          renderView();
        }catch(e){
          showToast(e?.message || "Couldn't follow");
        }
      }
    }, ["Follow"])
  ]),

  el("div", { style:"height:14px" }),

  el("div", { class:"note", text:"Following" }),
  el("div", {}, (Social.getFollows() || []).length ? (Social.getFollows() || []).map(fid =>
    el("div", { class:"rowBetween", style:"padding:8px 0; border-bottom: 1px solid rgba(255,255,255,.06);" }, [
      el("div", { class:"small", text: fid }),
      el("button", {
        class:"btn sm",
        onClick: async () => {
          try{ await Social.unfollow(fid); showToast("Unfollowed"); renderView(); }catch(_){}
        }
      }, ["Unfollow"])
    ])
  ) : [ el("div", { class:"note", text:"Not following anyone yet." }) ]),

  el("div", { style:"height:10px" }),

  el("div", { class:"note", text:"Tip: After you click the email link on this device, come back and tap Refresh on the Friends screen." })
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

    // ✅ Always show recommendation directly under the label
    const rec = "Recommendation: export a file backup occasionally (helps if iOS clears storage / app is deleted).";

    return el("div", { class:"note", text: `${label}\n${rec}` });
  })(),

  el("div", { style:"height:10px" }),

  // ───────────────
  // Export + Import (same row)
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

    // ✅ Import button on the right of Export
    el("button", {
      class:"btn danger",
      onClick: openImportFileModal
    }, ["Import (upload file)"])
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

  ])
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
    key:"social",
    title:"Friends (Beta)",
    subtitle:"Connect Supabase + follow friends + feed",
    keywords:["friends","social","supabase","feed","follow","events"],
    bodyNode: socialBody
    }),
    makeSection({
    key:"backup",
    title:"Backup / About",
    subtitle:"Backups, restore, storage info, reset",
    keywords:["backup","import","export","json","restore","about","reset","storage","schema"],
    bodyNode: el("div", {}, [
      backupBody,
      el("div", { style:"height:14px" }),
      debugBody
    ])
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

// ✅ Friends/Social: auto-refresh UI after OAuth redirect (and during feed polling)
// Only re-render on Friends or Settings routes to avoid extra work elsewhere.
try{
  const sUI = UIState.social || (UIState.social = {});
  if(!sUI.__routeSub && Social?.onChange){
    sUI.__routeSub = Social.onChange(() => {
      const r = (typeof getCurrentRoute === "function")
        ? getCurrentRoute()
        : (String(location.hash || "").replace(/^#/, "") || "home");

      if(r === "friends" || r === "settings"){
        try{ renderView(); }catch(_){}
      }
    });
  }
}catch(_){}


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
