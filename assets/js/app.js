window.addEventListener("error", (e)=>{
  const msg = e?.message || String(e);
  const file = e?.filename || "";
  const line = e?.lineno || "";
  const col  = e?.colno || "";

  document.body.innerHTML = `
    <div style="font-family:system-ui;padding:16px;color:#fff;background:#111;min-height:100vh">
      <h2 style="margin:0 0 10px">App crashed ❌</h2>
      <div style="opacity:.8;margin-bottom:10px">Here’s the first error:</div>
      <pre style="white-space:pre-wrap;background:#000;padding:12px;border-radius:12px;border:1px solid #333">${msg}</pre>
      <div style="opacity:.8;margin-top:10px">File: ${file}<br/>Line: ${line} Col: ${col}</div>
    </div>
  `;
});

(function(){
  const required = [
    "LS",
    "KEY_PROFILE","KEY_ROUTINES","KEY_ACTIVE_ROUTINE","KEY_ACTIVE_SCREEN",
    "KEY_BW","KEY_ATT","KEY_PRO","KEY_LIFTS",
    "todayISO","parseISO","localISODate","pad2","sameMonth",
    "uid","normExName","cleanExerciseName","canonicalExerciseName"
  ];

  const missing = required.filter(k => typeof window[k] === "undefined");
  if(missing.length){
    throw new Error("Missing globals (check storage.js/dom.js/utils.js): " + missing.join(", "));
  }
})();

let modalDepth = 0;

function lockBodyScroll(){
  if(modalDepth === 0) document.body.classList.add("modalOpen");
  modalDepth++;
}

function unlockBodyScroll(){
  modalDepth = Math.max(0, modalDepth - 1);
  if(modalDepth === 0) document.body.classList.remove("modalOpen");
}

  /* ---------------------------
   Global State (safe defaults)
---------------------------- */
let profile = defaultProfile();
let routines = [];
let activeRoutineId = null;

let bwLogs = [];
let attendance = new Set();
let proteinMap = {};
let lifts = [];

  /* ---------------------------
   SETTINGS bindings
---------------------------- */
const setName = document.getElementById("setName");
const setProteinGoal = document.getElementById("setProteinGoal");
const setWeekStart = document.getElementById("setWeekStart");
const setHideRest = document.getElementById("setHideRest");
const saveProfileBtn = document.getElementById("saveProfileBtn");

const storageInfo = document.getElementById("storageInfo");
const storageWarn = document.getElementById("storageWarn");
const runRefreshBtn = document.getElementById("runRefreshBtn");

function bytesToNice(n){
  if(!isFinite(n)) return "0 B";
  const u = ["B","KB","MB","GB"];
  let i=0, v=n;
  while(v>=1024 && i<u.length-1){ v/=1024; i++; }
  return `${v.toFixed(i===0?0:1)} ${u[i]}`;
}

function renderStorageInfo(){
  if(!storageInfo) return;

  let totalBytes = 0;
  for(let i=0;i<localStorage.length;i++){
    const k = localStorage.key(i);
    const v = localStorage.getItem(k) || "";
    totalBytes += (k.length + v.length) * 2; // rough UTF-16 bytes
  }

  storageInfo.textContent = `Approx localStorage size: ${bytesToNice(totalBytes)} • Keys: ${localStorage.length}`;

  if(storageWarn){
    storageWarn.style.display = (totalBytes > 3_000_000) ? "block" : "none"; // ~3MB warning
  }
}

function hydrateSettingsUI(){
  if(setName) setName.value = profile.name || "";
  if(setProteinGoal) setProteinGoal.value = String(getProteinGoal());
  if(setWeekStart) setWeekStart.value = profile.weekStart || "mon";
  if(setHideRest) setHideRest.value = profile.hideRestDays ? "1" : "0";
}

saveProfileBtn?.addEventListener("click", ()=>{
  saveProfile({
    name: String(setName?.value || "").trim(),
    proteinGoal: Number(setProteinGoal?.value || 240) || 240,
    weekStart: (setWeekStart?.value === "sun") ? "sun" : "mon",
    hideRestDays: (setHideRest?.value === "0") ? false : true
  });

  // update protein screen title immediately
  const pt = document.getElementById("proteinTitle");
  if(pt) pt.textContent = `Protein Intake (Goal ${getProteinGoal()}g)`;

  hydrateSettingsUI();
  renderStorageInfo();
  alert("Profile saved ✅");
});

runRefreshBtn?.addEventListener("click", ()=>{
  const rRoutine = document.getElementById("rfRoutine")?.value === "1";
  const rLifts   = document.getElementById("rfLifts")?.value === "1";
  const rWeight  = document.getElementById("rfWeight")?.value === "1";
  const rAtt     = document.getElementById("rfAttendance")?.value === "1";
  const rPro     = document.getElementById("rfProtein")?.value === "1";

  if(rWeight) renderBW();
  if(rAtt) renderCal();
  if(rPro) loadProteinDay(pDate.value || todayISO());

  if(rRoutine){
    renderRoutineDropdown();
    renderPPL();
    buildRoutineExerciseSuggestions();
  }
  if(rLifts){
    renderLiftSearchDropdown();
    renderLiftRoutineDropdown();
    applyLiftFiltersFromUI();
    renderLifts();
  }

  refreshHome();
  renderStorageInfo();
  alert("Refreshed ✅");
});

const obName = document.getElementById("obName");
const obUnits = document.getElementById("obUnits");
const obProteinGoal = document.getElementById("obProteinGoal");
const obWeekStart = document.getElementById("obWeekStart");
const obHideRest = document.getElementById("obHideRest");
const obProfileNextBtn = document.getElementById("obProfileNextBtn");

const obRoutineBackBtn = document.getElementById("obRoutineBackBtn");
const obRoutineName = document.getElementById("obRoutineName");
const obRoutineCreateBtn = document.getElementById("obRoutineCreateBtn");
const obRoutineTemplate = document.getElementById("obRoutineTemplate");

// Seed onboarding inputs from existing profile (if any)
function hydrateOnboardingInputs(){
  if(!obName) return;
  obName.value = profile.name || "";
  obProteinGoal.value = String(getProteinGoal());
  obWeekStart.value = profile.weekStart || "mon";
  obHideRest.value = profile.hideRestDays ? "1" : "0";
}

obProfileNextBtn?.addEventListener("click", ()=>{
  const nm = String(obName?.value || "").trim();
  if(!nm){
    alert("Please enter a name to continue.");
    return;
  }

  saveProfile({
    name: nm,
    proteinGoal: Number(obProteinGoal?.value || 240) || 240,
    weekStart: (obWeekStart?.value === "sun") ? "sun" : "mon",
    hideRestDays: (obHideRest?.value === "0") ? false : true
  });

  showScreen("onboard-routine");
});

obRoutineBackBtn?.addEventListener("click", ()=>{
  showScreen("profile");
});

obRoutineCreateBtn?.addEventListener("click", ()=>{
  const name = String(obRoutineName?.value || "").trim() || "My Routine";
  const tpl = String(obRoutineTemplate?.value || "blank");

  let base;

  if(tpl === "upperlower"){
    base = makeUpperLowerTemplate();
  } else if(tpl === "fullbody3"){
    base = makeFullBody3Template();
  } else if(tpl === "bodypart"){
    base = makeBodyPartTemplate();
  } else if(tpl === "ppl"){
    base = defaultRoutine();
  } else {
    base = defaultRoutine();
    base.name = "Routine";
    DAY_KEYS.forEach(k=>{
      base.days[k].exercises = [];
      base.days[k].rest = false;
      base.days[k].label = "";
    });
  }

  base.name = name;
  base.source = "onboarding";
  base.id = uid();

  routines.push(base);
  saveRoutines();

  // mark onboarding complete
  if(!isOnboardingDone()) setOnboardingDone();

  // set as active routine
  setActiveRoutine(base.id);

  // ✅ go to routine screen FIRST (ensures routine screen state is initialized)
  showScreen("routine");

  // ensure dropdown + list are correct right away
  renderRoutineDropdown(base.id);
  activeDayIndex = getTodaySplitIndex();
  renderPPL();
  buildRoutineExerciseSuggestions();

  // ✅ THEN open editor
  openRoutineEditor(base.id);
});

  /* ---------------------------
   Profile (Onboarding base)
---------------------------- */
function defaultProfile(){
  return {
    name: "",
    units: "lbs",        // ✅ lbs only
    proteinGoal: 240,
    weekStart: "mon",    // "mon" | "sun"
    hideRestDays: true
  };
}


function loadProfile(){
  const p = LS.get(KEY_PROFILE, null);
  if(!p || typeof p !== "object"){
    const seeded = defaultProfile();
    LS.set(KEY_PROFILE, seeded);
    return seeded;
  }
  // normalize
  return {
  name: String(p.name || ""),
  units: "lbs", // ✅ force lbs only (no kg supported)
  proteinGoal: Number(p.proteinGoal || 240) || 240,
  weekStart: (p.weekStart === "sun") ? "sun" : "mon",
  hideRestDays: (p.hideRestDays === false) ? false : true
};
}


function saveProfile(next){
  profile = {
    ...profile,
    ...next
  };
  LS.set(KEY_PROFILE, profile);
  renderHeaderSub();
  refreshHome();
  hydrateSettingsUI(); // ✅ add this line
}


function renderHeaderSub(){
  const sub = document.getElementById("headerSub");
  if(!sub) return;

  const restTxt = profile?.hideRestDays ? "Rest days hidden" : "Rest days shown";
  const goal = Number(profile?.proteinGoal || 240) || 240;

  const v = localStorage.getItem(KEY_APP_VERSION) || "";

  sub.textContent =
    `Minimal tracker • Protein goal ${goal}g • ${restTxt}` +
    (v ? ` • v${v}` : "");
}




// Replace PRO_GOAL usage with this
function getProteinGoal(){
  return Number(profile.proteinGoal || 240) || 240;
}

  /* ---------------------------
   Focus helpers (Recovery / Stalled / Weekly countdown)
---------------------------- */
function addDaysISO(iso, delta){
  const d = parseISO(iso);
  d.setDate(d.getDate() + delta);
  return localISODate(d);
}

function getProteinTotalForDate(iso){
  const obj = proteinMap?.[iso] || {morning:0,lunch:0,pre:0,dinner:0,bed:0};
  return (Number(obj.morning)||0)+(Number(obj.lunch)||0)+(Number(obj.pre)||0)+(Number(obj.dinner)||0)+(Number(obj.bed)||0);
}

function routineWeeklyTargetDays(routineObj){
  // counts how many days in the routine are NOT rest days
  let n = 0;
  DAY_KEYS.forEach(k=>{
    const day = routineObj?.days?.[k];
    if(day && !day.rest) n++;
  });
  // fallback so it never becomes 0
  return Math.max(1, n);
}

function isStalledExercise(exName, lookback=3){
  const n = normExName(exName);
  const exLifts = lifts
    .filter(x => (x.exNorm || normExName(x.ex)) === n)
    .sort((a,b)=> b.date.localeCompare(a.date))
    .slice(0, lookback);

  // need at least 3 sessions to call it "stalled"
  if(exLifts.length < lookback) return false;

  const weights = exLifts.map(x=>Number(x.weight)||0);
  const maxW = Math.max(...weights);
  const newest = weights[0];

  // stalled = newest is not the best of the last 3
  return newest < maxW || newest === maxW; // (still stalled if it’s flat)
}

function pickStalledExerciseFromToday(todayExercises){
  for(const ex of (todayExercises || [])){
    if(ex?.name && isStalledExercise(ex.name, 3)){
      return ex.name;
    }
  }
  return "";
}
  
  /* ---------------------------
   HOME screen logic
---------------------------- */
const homeTime = document.getElementById("homeTime");
const homeDate = document.getElementById("homeDate");
const homeName = document.getElementById("homeName");
const homeTodayTitle = document.getElementById("homeTodayTitle");
const homeTodayList = document.getElementById("homeTodayList");
const homeRestNotice = document.getElementById("homeRestNotice");
const homeWeekDots = document.getElementById("homeWeekDots");
const homeWeekCount = document.getElementById("homeWeekCount");
const homeFocus = document.getElementById("homeFocus");
const homeProteinCircle = document.getElementById("homeProteinCircle");
const homeProteinLeft = document.getElementById("homeProteinLeft");


function fmtTimeNow(){
  const d = new Date();
  return d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}
function fmtDateNow(){
  const d = new Date();
  return d.toLocaleDateString([], { weekday:"long", month:"short", day:"numeric" });
}

function dateISOFrom(baseDate, offsetDays){
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  d.setDate(d.getDate() + offsetDays);
  return localISODate(d);
}

function refreshHome(){
  // time/date/name
  if(homeTime) homeTime.textContent = fmtTimeNow();
  if(homeDate) homeDate.textContent = fmtDateNow();
  if(homeName) homeName.textContent = (profile.name || "—").trim() || "—";

  // today routine
  const ar = getActiveRoutine();
  const todayIdx = getTodaySplitIndex(); // Mon=0..Sun=6
  const dayKey = DAY_KEYS[todayIdx];
  const day = ar.days?.[dayKey] || { label:"", rest:false, exercises:[] };

  const label = (day.label || "").trim();
  if(homeTodayTitle) homeTodayTitle.textContent = `TODAY — ${dayKey}${label ? " • " + label : ""}`;

  if(homeTodayList) homeTodayList.innerHTML = "";
  if(homeRestNotice) homeRestNotice.style.display = "none";

  if(day.rest){
    if(homeRestNotice) homeRestNotice.style.display = "block";
  } else {
    const list = Array.isArray(day.exercises) ? day.exercises : [];
    if(homeTodayList){
      if(list.length === 0){
        homeTodayList.innerHTML = `<li class="muted">No exercises added for today.</li>`;
      } else {
        list.slice(0, 6).forEach(ex=>{
          const li = document.createElement("li");
          li.textContent = `${ex.name} — ${ex.sets || "—"} sets • ${ex.reps || "—"} reps`;
          homeTodayList.appendChild(li);
        });
      }
    }
  }
    // ✅ Protein-left circle (today)
  const td = todayISO();
  const obj = proteinMap?.[td] || {morning:0,lunch:0,pre:0,dinner:0,bed:0};
  const total = (Number(obj.morning)||0)+(Number(obj.lunch)||0)+(Number(obj.pre)||0)+(Number(obj.dinner)||0)+(Number(obj.bed)||0);

  const goal = getProteinGoal();
  const left = Math.max(goal - total, 0);
  const pct = Math.max(0, Math.min(1, goal ? (total/goal) : 0));
  const deg = Math.round(pct * 360);

  if(homeProteinLeft) homeProteinLeft.textContent = String(left);
  if(homeProteinCircle){
    homeProteinCircle.style.setProperty("--deg", `${deg}deg`);
  }
    // ✅ Home "Check In" button state (add this BEFORE week dots section)
  if(homeCheckInBtn){
    const today = todayISO();
    const checked = attendance.has(today);

    homeCheckInBtn.textContent = checked ? "✅ Checked In" : "✅ Check In";
    homeCheckInBtn.classList.toggle("ghost", checked);
  }

  // week dots + count
  const weekStart = weekStartDate(new Date());
  const dots = [];
  for(let i=0;i<7;i++){
    dots.push(dateISOFrom(weekStart, i));
  }

  const attendedCount = dots.filter(d => attendance.has(d)).length;

  if(homeWeekDots){
    homeWeekDots.innerHTML = "";
    dots.forEach(d=>{
      const dot = document.createElement("div");
      dot.className = "wdot " + (attendance.has(d) ? "on" : "off");
      dot.title = d;
      homeWeekDots.appendChild(dot);
    });
  }

  if(homeWeekCount){
    homeWeekCount.textContent = `Workouts this week: ${attendedCount} / 7`;
  }

  // ✅ Focus engine (Recovery warning > Stalled lift > Weekly countdown > Default)
  if(homeFocus){
    // basics
    const todayIso = todayISO();
    const yesterdayIso = addDaysISO(todayIso, -1);

    const todayIsRest = !!day.rest;

    // (1) Recovery warning: trained yesterday + low protein yesterday + today not rest
    const trainedYesterday = attendance.has(yesterdayIso);
    const yProtein = getProteinTotalForDate(yesterdayIso);
    const yLowProtein = yProtein < (getProteinGoal() * 0.75);

    // (5) Weekly goal countdown (target = number of non-rest days in routine)
    const weeklyTarget = routineWeeklyTargetDays(ar);
    const workoutsLeft = Math.max(weeklyTarget - attendedCount, 0);

    // (3) Stalled lift detection (check today's exercises)
    const todayExercises = Array.isArray(day.exercises) ? day.exercises : [];
    const stalledName = pickStalledExerciseFromToday(todayExercises);

    // priority messaging
    if(todayIsRest){
      homeFocus.textContent = "Recovery day: mobility + walk. Keep it easy and show up tomorrow.";
    }
    else if(trainedYesterday && yLowProtein){
      homeFocus.textContent =
        "Focus: go lighter today — recovery may be limiting performance (trained yesterday + low protein).";
    }
    else if(stalledName){
      homeFocus.textContent =
        `Focus: ${stalledName} looks stalled — change stimulus (add reps, slower tempo, or switch variation).`;
    }
    else if(workoutsLeft > 0){
      homeFocus.textContent =
        `Focus: ${workoutsLeft} session${workoutsLeft===1?"":"s"} left to hit your weekly routine goal (${weeklyTarget}).`;
    }
    else {
      // keep your original vibe
      if(label) homeFocus.textContent = `Focus: ${label}`;
      else homeFocus.textContent = "Focus: execute clean sets + progressive overload.";
    }
  }

}
  const homeCheckInBtn = document.getElementById("homeCheckInBtn");

function toggleTodayAttendance(){
  const today = todayISO();

  if(attendance.has(today)){
    attendance.delete(today);
  } else {
    attendance.add(today);
  }

  LS.set(KEY_ATT, [...attendance]);

  // refresh the home UI immediately
  refreshHome();

  // optional: keep calendar UI accurate if you’re already on that screen later
  // (won't error if not visible)
  renderCal();
}

homeCheckInBtn?.addEventListener("click", toggleTodayAttendance);
/* ---------------------------
   Screen Router (Option A) — FIXED
---------------------------- */
const KEY_ACTIVE_SCREEN = "gym_active_screen_v1";

const onEnterScreen = {
  home: () => {
    refreshHome();
  },

  weight: () => {
    renderBW();
  },

  attendance: () => {
    renderCal();
  },

  protein: () => {
  if(pDate) pDate.value = todayISO();
  loadProteinDay(pDate?.value || todayISO());

  const pt = document.getElementById("proteinTitle");
  if (pt) pt.textContent = `Protein Intake (Goal ${getProteinGoal()}g)`;
},
  routine: () => {
    renderRoutineDropdown();
    renderPPL();
    buildRoutineExerciseSuggestions(); // ✅ optional but recommended
  },

  lifts: () => {
    renderLiftSearchDropdown();
    renderLiftRoutineDropdown();
    renderLifts();
  },

  settings: () => {
    hydrateSettingsUI();
    renderStorageInfo();
    renderLastBackup();
  }
};

function showScreen(name){
  // remove active
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));

  // find target
  let el = document.getElementById(`screen-${name}`);

  // ✅ fallback if invalid screen name stored
  if(!el){
    name = "home";
    el = document.getElementById("screen-home")
      || document.getElementById("screen-profile");
  }

  // ✅ absolute safety: if still nothing, stop gracefully
  if(!el){
    console.warn("showScreen: no valid screens found");
    return;
  }

  el.classList.add("active");

  localStorage.setItem(KEY_ACTIVE_SCREEN, name);

  // iOS Safari behaves better scrolling the document element
  (document.scrollingElement || document.documentElement).scrollTo(0, 0);

  onEnterScreen[name]?.();
  setActiveNav(name);
}
  function setActiveNav(name){
  document.querySelectorAll(".navBtn").forEach(b=>{
    b.classList.toggle("active", b.getAttribute("data-nav") === name);
  });
}
  
let navBound = false;

function bindNavigation(){
  if(navBound) return;
  navBound = true;

  document.addEventListener("click", (e)=>{
    const goBtn = e.target.closest("[data-go]");
    if(goBtn){
      showScreen(goBtn.dataset.go);
      return;
    }
    const homeBtn = e.target.closest("[data-home]");
    if(homeBtn){
      showScreen("home");
      return;
    }
  });
}


/* ---------------------------
   LOCAL date utils
---------------------------- */
function weekStartDate(baseDate=new Date()){
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const dow = d.getDay(); // 0 Sun..6 Sat

  if(profile.weekStart === "sun"){
    d.setDate(d.getDate() - dow);
  } else {
    const delta = (dow === 0) ? 6 : (dow - 1);
    d.setDate(d.getDate() - delta);
  }
  return d;
}

const DAY_KEYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
function dateForWeekdayIndex(dayIndex, baseDate=new Date()){
  const start = weekStartDate(baseDate);
  const out = new Date(start);
  out.setDate(start.getDate() + dayIndex);
  return localISODate(out);
}

/* ---------------------------
   Normalization
---------------------------- */
function loadCustomExercises(){
  const arr = LS.get(KEY_CUSTOM_EX, []);
  return Array.isArray(arr) ? arr : [];
}
function saveCustomExercises(arr){
  LS.set(KEY_CUSTOM_EX, arr);
}
function addCustomExercise(name){
  const cleaned = cleanExerciseName(name);
  if(!cleaned) return "";

  const cur = loadCustomExercises();
  const exists = cur.some(x => normExName(x) === normExName(cleaned));
  if(!exists){
    cur.push(cleaned);
    cur.sort((a,b)=>a.localeCompare(b));
    saveCustomExercises(cur);
  }
  return cleaned;
}

/* ---------------------------
   Canonical Exercise Library
---------------------------- */
const EXERCISE_LIBRARY = [
  // Barbell
  "Barbell Bench Press",
  "Incline Barbell Bench Press",
  "Barbell Squat",
  "Front Squat",
  "Barbell Back Squat",
  "Barbell Row",
  "Deadlift (Conventional)",
  "Romanian Deadlift",
  "Barbell Curl",

  // Machines / Cables
  "Leg Press",
  "Hack Squat",
  "Smith Machine Squat",
  "Lat Pulldown",
  "Underhand Lat Pulldown",
  "Seated Cable Row",
  "Cable Chest Flys",
  "Cable Crunch",
  "Chest Fly Machine",
  "Shoulder Press Machine",
  "Leg Extension",
  "Hamstring Curl",
  "Leg Curl Machine",
  "Standing Calf Raise (Machine)",
  "Standing Calf Raise",
  "Seated Calf Raise",
  "Triceps Rope Pushdowns",

  // Dumbbell
  "Dumbbell Bench Press",
  "Incline Dumbbell Press",
  "Dumbbell Shoulder Press",
  "Dumbbell Lateral Raises",
  "Lateral Raises",
  "Dumbbell Front Raises",
  "Dumbbell Chest Fly",
  "Dumbbell Row",
  "One-Arm Dumbbell Row",
  "Dumbbell Shrugs",
  "Dumbbell Bicep Curl",
  "Hammer Curl",
  "Concentration Curl",
  "Dumbbell Tricep Kickback",
  "Overhead Dumbbell Tricep Extension",
  "Goblet Squat",
  "Dumbbell Lunges",
  "Bulgarian Split Squat",
  "Dumbbell Romanian Deadlift",
  "Rear Delt Fly",
  "Dumbbell Alternating Curl",

  // Bodyweight / Misc
  "Chest Dips",
  "Pull-Ups / Assisted Pull-Ups",
  "Hanging Leg Raises",
  "Mobility + stretching",
  "Light walking or stretching",

  // Core
  "Plank",
  "Side Plank",
  "Leg Raises",
  "Bicycle Crunch",
  "Russian Twist",
  "Ab Wheel Rollout",
  "Mountain Climbers",

  // Cardio / Conditioning
  "Treadmill Walk / Run",
  "Incline Treadmill Walk",
  "Stair Climber",
  "Stationary Bike",
  "Elliptical",
  "Rowing Machine",
  "Jump Rope",
  "Battle Ropes",
  "Kettlebell Swings",
  "Sled Push / Pull",
  "Box Jumps",
  "Burpees"
];
/* ---------------------------
   Default Routine Seed
---------------------------- */
function defaultRoutine(){
  return {
    id: uid(),
    name: "PPL",
    source: "default",
    days: {
      Mon: { label:"Push", rest:false, exercises:[
        {name:"Incline Dumbbell Press", sets:4, reps:"8–10", notes:""},
        {name:"Dumbbell Bench Press", sets:4, reps:"8–10", notes:""},
        {name:"Chest Dips", sets:3, reps:"10–12", notes:""},
        {name:"Lateral Raises", sets:3, reps:"12–15", notes:""},
        {name:"Cable Chest Flys", sets:3, reps:"12–15", notes:""},
        {name:"Triceps Rope Pushdowns", sets:3, reps:"12–15", notes:""},
        {name:"Overhead Dumbbell Triceps Extension", sets:3, reps:"12–15", notes:""},
      ]},

      Tue: { label:"Pull", rest:false, exercises:[
        {name:"Underhand Lat Pulldown", sets:4, reps:"8–10", notes:""},
        {name:"Barbell Row", sets:4, reps:"6–8", notes:""},
        {name:"Dumbbell Row", sets:3, reps:"10–12", notes:""},
        {name:"Seated Cable Row", sets:3, reps:"10–12", notes:""},
        {name:"Rear Delt Fly", sets:3, reps:"12–15", notes:""},
        {name:"Barbell Curl", sets:3, reps:"10–12", notes:""},
        {name:"Hammer Curl", sets:3, reps:"12–15", notes:""},
        {name:"Dumbbell Alternating Curl", sets:3, reps:"10–12", notes:""},
        {name:"Hanging Leg Raises", sets:3, reps:"12–15", notes:"Core"},
      ]},

      Wed: { label:"Legs", rest:false, exercises:[
        {name:"Barbell Back Squat", sets:4, reps:"6–8", notes:""},
        {name:"Leg Press", sets:3, reps:"10–12", notes:""},
        {name:"Goblet Squats", sets:3, reps:"12–15 steps", notes:""},
        {name:"Leg Curl Machine", sets:3, reps:"12–15", notes:""},
        {name:"Standing Calf Raise", sets:3, reps:"15–20", notes:""},
        {name:"Leg Extensions", sets:3, reps:"12–15", notes:""},
        {name:"Cable Crunches", sets:3, reps:"20", notes:"Core"},
      ]},

      Thu: { label:"Push", rest:false, exercises:[
        {name:"Incline Dumbbell Press", sets:4, reps:"8–10", notes:""},
        {name:"Dumbbell Bench Press", sets:4, reps:"8–10", notes:""},
        {name:"Chest Dips", sets:3, reps:"10–12", notes:""},
        {name:"Lateral Raises", sets:3, reps:"12–15", notes:""},
        {name:"Cable Chest Flys", sets:3, reps:"12–15", notes:""},
        {name:"Triceps Rope Pushdowns", sets:3, reps:"12–15", notes:""},
        {name:"Overhead Dumbbell Triceps Extension", sets:3, reps:"12–15", notes:""},
      ]},

      Fri: { label:"Pull", rest:false, exercises:[
        {name:"Underhand Lat Pulldown", sets:4, reps:"8–10", notes:""},
        {name:"Barbell Row", sets:4, reps:"6–8", notes:""},
        {name:"Dumbbell Row", sets:3, reps:"10–12", notes:""},
        {name:"Seated Cable Row", sets:3, reps:"10–12", notes:""},
        {name:"Rear Delt Fly", sets:3, reps:"12–15", notes:""},
        {name:"Barbell Curl", sets:3, reps:"10–12", notes:""},
        {name:"Hammer Curl", sets:3, reps:"12–15", notes:""},
        {name:"Dumbbell Alternating Curl", sets:3, reps:"10–12", notes:""},
        {name:"Hanging Leg Raises", sets:3, reps:"12–15", notes:"Core"},
      ]},

      Sat: { label:"Legs", rest:false, exercises:[
        {name:"Barbell Back Squat", sets:4, reps:"6–8", notes:""},
        {name:"Leg Press", sets:3, reps:"10–12", notes:""},
        {name:"Goblet Squats", sets:3, reps:"12–15 steps", notes:""},
        {name:"Leg Curl Machine", sets:3, reps:"12–15", notes:""},
        {name:"Standing Calf Raise", sets:3, reps:"15–20", notes:""},
        {name:"Leg Extensions", sets:3, reps:"12–15", notes:""},
        {name:"Cable Crunches", sets:3, reps:"20", notes:"Core"},
      ]},

      Sun: { label:"Rest", rest:true, exercises:[] }
    }
  };
}

function makeUpperLowerTemplate(){
  const r = defaultRoutine();
  r.name = "Upper / Lower";

  r.days.Mon = { label:"Upper", rest:false, exercises:[
    {name:"Barbell Bench Press", sets:4, reps:"6–8", notes:""},
    {name:"Lat Pulldown", sets:4, reps:"8–10", notes:""},
    {name:"Dumbbell Shoulder Press", sets:3, reps:"8–10", notes:""},
    {name:"Seated Cable Row", sets:3, reps:"10–12", notes:""},
    {name:"Dumbbell Lateral Raises", sets:3, reps:"12–15", notes:""},
    {name:"Dumbbell Bicep Curl", sets:3, reps:"10–12", notes:""},
    {name:"Triceps Rope Pushdowns", sets:3, reps:"10–12", notes:""},
    {name:"Plank", sets:3, reps:"30–60s", notes:"Core"},
  ]};

  r.days.Tue = { label:"Lower", rest:false, exercises:[
    {name:"Barbell Squat", sets:4, reps:"5–8", notes:""},
    {name:"Romanian Deadlift", sets:3, reps:"8–10", notes:""},
    {name:"Leg Press", sets:3, reps:"10–12", notes:""},
    {name:"Dumbbell Lunges", sets:3, reps:"10/leg", notes:""},
    {name:"Hamstring Curl", sets:3, reps:"12–15", notes:""},
    {name:"Standing Calf Raise (Machine)", sets:4, reps:"12–15", notes:""},
  ]};

  r.days.Wed = { label:"Active Recovery", rest:true, exercises:[
    {name:"Incline Treadmill Walk", sets:1, reps:"20–30 min", notes:"Cardio"},
    {name:"Mobility + stretching", sets:1, reps:"—", notes:""},
  ]};

  r.days.Thu = { label:"Upper", rest:false, exercises:[
    {name:"Incline Dumbbell Press", sets:4, reps:"8–10", notes:""},
    {name:"Pull-Ups / Assisted Pull-Ups", sets:4, reps:"6–10", notes:""},
    {name:"Dumbbell Row", sets:3, reps:"8–10", notes:""},
    {name:"Dumbbell Chest Fly", sets:3, reps:"12", notes:""},
    {name:"Hammer Curl", sets:3, reps:"10–12", notes:""},
    {name:"Overhead Dumbbell Tricep Extension", sets:3, reps:"10–12", notes:""},
    {name:"Leg Raises", sets:3, reps:"10–15", notes:"Core"},
  ]};

  r.days.Fri = { label:"Lower", rest:false, exercises:[
    {name:"Deadlift (Conventional)", sets:4, reps:"3–5", notes:""},
    {name:"Hack Squat", sets:3, reps:"8–10", notes:"(or Smith Squat)"},
    {name:"Bulgarian Split Squat", sets:3, reps:"8/leg", notes:""},
    {name:"Leg Extension", sets:3, reps:"12–15", notes:""},
    {name:"Seated Calf Raise", sets:4, reps:"12–15", notes:""},
    {name:"Cable Crunch", sets:3, reps:"12–15", notes:"Core"},
  ]};

  r.days.Sat = { label:"Rest", rest:true, exercises:[
    {name:"Light walking or stretching", sets:1, reps:"—", notes:"Recovery"},
  ]};

  r.days.Sun = { label:"Cardio + Core", rest:false, exercises:[
    {name:"Stair Climber", sets:1, reps:"20–30 min", notes:"(or Stationary Bike)"},
    {name:"Russian Twist", sets:3, reps:"20", notes:"Core"},
    {name:"Plank", sets:3, reps:"45s", notes:"Core"},
  ]};

  return r;
}

function makeFullBody3Template(){
  const r = defaultRoutine();
  r.name = "Full Body (3-Day)";

  r.days.Mon = { label:"Full Body Day 1", rest:false, exercises:[
    {name:"Barbell Squat", sets:4, reps:"6–8", notes:""},
    {name:"Barbell Bench Press", sets:4, reps:"6–8", notes:""},
    {name:"Lat Pulldown", sets:3, reps:"8–10", notes:""},
    {name:"Dumbbell Shoulder Press", sets:3, reps:"8–10", notes:""},
    {name:"Plank", sets:3, reps:"45s", notes:"Core"},
  ]};

  r.days.Tue = { label:"Rest / Cardio", rest:true, exercises:[
    {name:"Incline Treadmill Walk", sets:1, reps:"25–30 min", notes:"(or Stationary Bike)"},
  ]};

  r.days.Wed = { label:"Full Body Day 2", rest:false, exercises:[
    {name:"Deadlift (Conventional)", sets:4, reps:"4–6", notes:""},
    {name:"Incline Dumbbell Press", sets:3, reps:"8–10", notes:""},
    {name:"Seated Cable Row", sets:3, reps:"10", notes:""},
    {name:"Dumbbell Lunges", sets:3, reps:"10/leg", notes:""},
    {name:"Leg Raises", sets:3, reps:"10–15", notes:"Core"},
  ]};

  r.days.Thu = { label:"Rest", rest:true, exercises:[
    {name:"Mobility + stretching", sets:1, reps:"—", notes:"Recovery"},
  ]};

  r.days.Fri = { label:"Full Body Day 3", rest:false, exercises:[
    {name:"Leg Press", sets:4, reps:"10", notes:""},
    {name:"Pull-Ups / Assisted Pull-Ups", sets:3, reps:"AMRAP", notes:""},
    {name:"Dumbbell Chest Fly", sets:3, reps:"12", notes:""},
    {name:"Dumbbell Lateral Raises", sets:3, reps:"15", notes:""},
    {name:"Cable Crunch", sets:3, reps:"15", notes:"Core"},
  ]};

  r.days.Sat = { label:"Optional Conditioning", rest:true, exercises:[
    {name:"Rowing Machine", sets:1, reps:"15–20 min", notes:"(or Battle Ropes)"},
  ]};

  r.days.Sun = { label:"Rest", rest:true, exercises:[] };

  return r;
}

function makeBodyPartTemplate(){
  const r = defaultRoutine();
  r.name = "Body Part Split";

  r.days.Mon = { label:"Chest", rest:false, exercises:[
    {name:"Barbell Bench Press", sets:4, reps:"6–8", notes:""},
    {name:"Incline Dumbbell Press", sets:4, reps:"8–10", notes:""},
    {name:"Dumbbell Chest Fly", sets:3, reps:"12", notes:""},
    {name:"Chest Fly Machine", sets:3, reps:"12–15", notes:""},
  ]};

  r.days.Tue = { label:"Back", rest:false, exercises:[
    {name:"Deadlift (Conventional)", sets:4, reps:"4–6", notes:""},
    {name:"Lat Pulldown", sets:4, reps:"8–10", notes:""},
    {name:"Seated Cable Row", sets:3, reps:"10–12", notes:""},
    {name:"Dumbbell Row", sets:3, reps:"8–10", notes:""},
  ]};

  r.days.Wed = { label:"Shoulders", rest:false, exercises:[
    {name:"Dumbbell Shoulder Press", sets:4, reps:"8–10", notes:""},
    {name:"Dumbbell Lateral Raises", sets:4, reps:"12–15", notes:""},
    {name:"Dumbbell Front Raises", sets:3, reps:"12", notes:""},
    {name:"Dumbbell Shrugs", sets:3, reps:"12", notes:""},
  ]};

  r.days.Thu = { label:"Legs", rest:false, exercises:[
    {name:"Barbell Squat", sets:4, reps:"6–8", notes:""},
    {name:"Leg Press", sets:3, reps:"10–12", notes:""},
    {name:"Romanian Deadlift", sets:3, reps:"8–10", notes:""},
    {name:"Hamstring Curl", sets:3, reps:"12–15", notes:""},
    {name:"Standing Calf Raise (Machine)", sets:4, reps:"15", notes:""},
  ]};

  r.days.Fri = { label:"Arms + Core", rest:false, exercises:[
    {name:"Dumbbell Bicep Curl", sets:3, reps:"10–12", notes:""},
    {name:"Hammer Curl", sets:3, reps:"10–12", notes:""},
    {name:"Triceps Rope Pushdowns", sets:3, reps:"10–12", notes:""},
    {name:"Overhead Dumbbell Tricep Extension", sets:3, reps:"10–12", notes:""},
    {name:"Cable Crunch", sets:3, reps:"15", notes:"Core"},
    {name:"Russian Twist", sets:3, reps:"20", notes:"Core"},
  ]};

  r.days.Sat = { label:"Rest", rest:true, exercises:[] };

  r.days.Sun = { label:"Light Cardio", rest:true, exercises:[
    {name:"Stationary Bike", sets:1, reps:"20–30 min", notes:"(or Walk / Stretch)"},
  ]};

  return r;
  
}
  const ROUTINE_TEMPLATES = [
  { id:"tpl_ppl",          name:"PPL (6-day)",             build: ()=> defaultRoutine() },
  { id:"tpl_upperlower",   name:"Upper / Lower (7-day)",   build: ()=> makeUpperLowerTemplate() },
  { id:"tpl_fullbody3",    name:"Full Body (3-day)",       build: ()=> makeFullBody3Template() },
  { id:"tpl_bodypart",     name:"Body Part Split (7-day)", build: ()=> makeBodyPartTemplate() },
];

/* ---------------------------
   Routines state
---------------------------- */
function loadRoutines(){
  let routines = LS.get(KEY_ROUTINES, null);
  if(!Array.isArray(routines) || routines.length === 0){
    routines = [defaultRoutine()];
    LS.set(KEY_ROUTINES, routines);
  }
  routines.forEach(r=>{
    if(!r.days) r.days = {};
    DAY_KEYS.forEach(k=>{
      if(!r.days[k]) r.days[k] = {label:"", rest:false, exercises:[]};
      if(!Array.isArray(r.days[k].exercises)) r.days[k].exercises = [];
      if(typeof r.days[k].rest !== "boolean") r.days[k].rest = !!r.days[k].rest;
      if(typeof r.days[k].label !== "string") r.days[k].label = String(r.days[k].label||"");
      r.days[k].exercises = r.days[k].exercises.map(e=>({
        name: String(e.name||e.ex||""),
        sets: Number(e.sets)||0,
        reps: String(e.reps||""),
        notes: String(e.notes||"")
      })).filter(e=>e.name);
    });
    if(!r.id) r.id = uid();
    if(!r.name) r.name = "Routine";
    if(!r.source) r.source = "user"; // fallback for legacy routines
  });

  LS.set(KEY_ROUTINES, routines);

  let activeId = LS.get(KEY_ACTIVE_ROUTINE, null);
  if(!activeId || !routines.some(r=>r.id===activeId)){
    activeId = routines[0].id;
    LS.set(KEY_ACTIVE_ROUTINE, activeId);
  }
  return {routines, activeId};
}
({ routines, activeId: activeRoutineId } = loadRoutines());

function saveRoutines(){ LS.set(KEY_ROUTINES, routines); }
function setActiveRoutine(id){
  activeRoutineId = id;
  LS.set(KEY_ACTIVE_ROUTINE, id);
}
function getActiveRoutine(){
  return routines.find(r=>r.id===activeRoutineId) || routines[0];
}

/* ---------------------------
   Weight Tracker  ✅ (COPY/PASTE THIS WHOLE BLOCK)
---------------------------- */
bwLogs = LS.get(KEY_BW, []);
function sortBW(){ bwLogs.sort((a,b)=>a.date.localeCompare(b.date)); }

const bwDate   = document.getElementById("bwDate");
const bwVal    = document.getElementById("bwVal");
const bwAddBtn = document.getElementById("bwAddBtn");
const bwTable  = document.getElementById("bwTable");
const bwLatest = document.getElementById("bwLatest");
const bwDelta  = document.getElementById("bwDelta");
const bwAvg    = document.getElementById("bwAvg");

const bwViewTableBtn = document.getElementById("bwViewTableBtn");
const bwViewGraphBtn = document.getElementById("bwViewGraphBtn");
const bwChartWrap    = document.getElementById("bwChartWrap");
const bwTableWrap    = document.getElementById("bwTableWrap");

let bwView = "table"; // "table" | "graph"

function setBWView(next){
  bwView = next;

  if(bwView === "table"){
    if(bwTableWrap) bwTableWrap.style.display = "";
    if(bwChartWrap) bwChartWrap.style.display = "none";
    bwViewTableBtn?.classList.remove("ghost");
    bwViewGraphBtn?.classList.add("ghost");
  } else {
    if(bwTableWrap) bwTableWrap.style.display = "none";
    if(bwChartWrap) bwChartWrap.style.display = "";
    bwViewTableBtn?.classList.add("ghost");
    bwViewGraphBtn?.classList.remove("ghost");
    renderBW(); // ensures chart draws correctly when shown
  }
}

bwViewTableBtn?.addEventListener("click", ()=> setBWView("table"));
bwViewGraphBtn?.addEventListener("click", ()=> setBWView("graph"));

if(bwDate) bwDate.value = todayISO();

/* ✅ ADD weight */
bwAddBtn?.addEventListener("click", ()=>{
  const d = bwDate?.value || todayISO();
  const v = Number(bwVal?.value);

  if(!d || !isFinite(v)) return alert("Please enter date + bodyweight.");

  bwLogs = bwLogs.filter(x=>x.date !== d);
  bwLogs.push({date:d, bw:v});

  sortBW();
  LS.set(KEY_BW, bwLogs);

  if(bwVal) bwVal.value = "";
  renderBW();
});

/* ✅ DELETE weight (ONE-TIME listener — OUTSIDE renderBW) */
bwTable?.addEventListener("click", (e)=>{
  const btn = e.target.closest("button[data-delbw]");
  if(!btn) return;

  const d = btn.getAttribute("data-delbw");
  bwLogs = bwLogs.filter(x=>x.date !== d);
  LS.set(KEY_BW, bwLogs);
  renderBW();
});

function bwStats(){
  sortBW();
  const latest = bwLogs[bwLogs.length-1];
  const prev = bwLogs[bwLogs.length-2];
  const delta = (latest && prev) ? (latest.bw - prev.bw) : null;

  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-6);
  const last7 = bwLogs.filter(x=>parseISO(x.date) >= cutoff);
  const avg = last7.length ? (last7.reduce((s,x)=>s+x.bw,0)/last7.length) : null;

  return {latest, prev, delta, avg, last7};
}

let bwChart;

function renderBW(){
  sortBW();
  const {latest, delta, avg} = bwStats();

  if(bwLatest) bwLatest.textContent = latest ? `${latest.bw.toFixed(1)} lbs (${latest.date})` : "—";

  if(bwDelta){
    if(delta === null) bwDelta.textContent = "—";
    else {
      const sign = delta > 0 ? "+" : "";
      bwDelta.textContent = `${sign}${delta.toFixed(1)} lbs`;
      bwDelta.className = "mono " + (delta>0 ? "bad" : (delta<0 ? "good" : ""));
    }
  }

  if(bwAvg) bwAvg.textContent = avg ? `${avg.toFixed(1)} lbs` : "—";

  /* ---- TABLE ---- */
  if(bwTable){
    bwTable.innerHTML = "";

    for(let i=0; i<bwLogs.length; i++){
      const cur = bwLogs[i];
      const prevBW = bwLogs[i-1]?.bw ?? null;

      const dlt = (prevBW===null) ? null : (cur.bw - prevBW);
      const trend = dlt===null ? "—" : (dlt>0 ? "↑" : (dlt<0 ? "↓" : "—"));
      const dltTxt = dlt===null ? "—" : `${dlt>0?"+":""}${dlt.toFixed(1)}`;
      const cls = dlt===null ? "" : (dlt>0 ? "bad" : (dlt<0 ? "good" : ""));

      const tr = document.createElement("tr");
      tr.classList.add("tap");

      tr.innerHTML = `
        <td class="mono">${cur.date}</td>
        <td class="mono">${cur.bw.toFixed(1)}</td>
        <td class="mono">${prevBW===null ? "—" : prevBW.toFixed(1)}</td>
        <td class="mono ${cls}">${dltTxt} ${trend}</td>
        <td><button data-delbw="${cur.date}">Delete</button></td>
      `;
      bwTable.appendChild(tr);
    }
  }

  /* ---- CHART ---- */
  if(bwView !== "graph") return;            // only draw chart when visible
  const canvas = document.getElementById("bwChart");
  if(!canvas) return;

  const labels = bwLogs.map(x=>x.date);
  const data = bwLogs.map(x=>x.bw);

  if(bwChart) bwChart.destroy();

  bwChart = new Chart(canvas, {
    type:"line",
    data:{ labels, datasets:[{ label:"Bodyweight (lbs)", data, tension:.25, pointRadius:3 }] },
    options:{
      responsive:true,
      plugins:{ legend:{display:false}, tooltip:{mode:"index", intersect:false} },
      scales:{
        x:{ticks:{color:"#9aa0a6"}, grid:{color:"#202124"}},
        y:{ticks:{color:"#9aa0a6"}, grid:{color:"#202124"}}
      }
    }
  });
}
/* ---------------------------
   Attendance Calendar
---------------------------- */
attendance = new Set(LS.get(KEY_ATT, []));

let calY = new Date().getFullYear();
let calM = new Date().getMonth();
const calTitle = document.getElementById("calTitle");
const calGrid = document.getElementById("calGrid");
const calCount = document.getElementById("calCount");

document.getElementById("prevMonthBtn")?.addEventListener("click", ()=>{
  calM--; if(calM<0){calM=11; calY--;}
  renderCal();
});
document.getElementById("nextMonthBtn")?.addEventListener("click", ()=>{
  calM++; if(calM>11){calM=0; calY++;}
  renderCal();
});
document.getElementById("clearMonthBtn")?.addEventListener("click", ()=>{
  const keep = [...attendance].filter(s=>{
    const d=parseISO(s);
    return !sameMonth(d, calY, calM);
  });
  attendance = new Set(keep);
  LS.set(KEY_ATT, [...attendance]);
  renderCal();
});

function renderCal(){
  const monthName = new Date(calY,calM,1).toLocaleString(undefined,{month:"long"});
  calTitle.textContent = `${monthName} ${calY}`;

  calGrid.innerHTML = "";
  const heads = ["S","M","T","W","T","F","S"];
  heads.forEach(h=>{
    const el=document.createElement("div");
    el.className="calHead";
    el.textContent=h;
    calGrid.appendChild(el);
  });

  const first = new Date(calY, calM, 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(calY, calM+1, 0).getDate();

  for(let i=0;i<startDay;i++){
    const blank=document.createElement("div");
    blank.className="day off";
    blank.textContent="";
    calGrid.appendChild(blank);
  }

  let count=0;
  for(let d=1; d<=daysInMonth; d++){
    const date = new Date(calY, calM, d);
    const s = localISODate(date);
    const cell=document.createElement("div");
    cell.className="day";
    cell.innerHTML = `<div>${d}</div>`;
    if(attendance.has(s)){
      cell.classList.add("attended");
      cell.innerHTML += `<span class="dot"></span>`;
      count++;
    }
    cell.addEventListener("click", ()=>{
  if(attendance.has(s)) attendance.delete(s);
  else attendance.add(s);
  LS.set(KEY_ATT, [...attendance]);
  renderCal();
  refreshHome(); // ✅ add this
});
    calGrid.appendChild(cell);
  }
  calCount.textContent = String(count);
}

/* ---------------------------
   Protein
---------------------------- */
// goal is dynamic from profile
const pDate = document.getElementById("pDate");
const pMorning = document.getElementById("pMorning");
const pLunch = document.getElementById("pLunch");
const pPre = document.getElementById("pPre");
const pDinner = document.getElementById("pDinner");
const pBed = document.getElementById("pBed");
const pTotal = document.getElementById("pTotal");
const pRemain= document.getElementById("pRemain");
const pStatus= document.getElementById("pStatus");
proteinMap = LS.get(KEY_PRO, {});

pDate.value = todayISO();

const pt = document.getElementById("proteinTitle");
if(pt) pt.textContent = `Protein Intake (Goal ${getProteinGoal()}g)`;

function loadProteinDay(d){
  const obj = proteinMap[d] || {morning:0,lunch:0,pre:0,dinner:0,bed:0};
  pMorning.value = obj.morning;
  pLunch.value = obj.lunch;
  pPre.value = obj.pre;
  pDinner.value = obj.dinner;
  pBed.value = obj.bed;
  renderProteinTotals();
}
function renderProteinTotals(){
  const total = (Number(pMorning.value)||0)+(Number(pLunch.value)||0)+(Number(pPre.value)||0)+(Number(pDinner.value)||0)+(Number(pBed.value)||0);
  pTotal.textContent = String(total);
  const rem = Math.max(getProteinGoal() - total, 0);
pRemain.textContent = String(rem);
  if(total >= getProteinGoal()){
    pStatus.textContent = "Hit goal ✅";
    pStatus.className = "good";
  } else if(total >= getProteinGoal()*0.75){
    pStatus.textContent = "Almost there";
    pStatus.className = "warn";
  } else {
    pStatus.textContent = "Under goal";
    pStatus.className = "muted";
  }
}
  function updateHomeProteinCirclePreview(){
  // only preview for TODAY (so it feels real-time)
  const td = todayISO();

  // read from the protein inputs (what user is typing)
  const total =
    (Number(pMorning?.value)||0) +
    (Number(pLunch?.value)||0) +
    (Number(pPre?.value)||0) +
    (Number(pDinner?.value)||0) +
    (Number(pBed?.value)||0);

  const goal = getProteinGoal();
  const left = Math.max(goal - total, 0);
  const pct = Math.max(0, Math.min(1, goal ? (total / goal) : 0));
  const deg = Math.round(pct * 360);

  // update HOME ring + number (even if Home isn't visible, it's still fine)
  if(homeProteinLeft) homeProteinLeft.textContent = String(left);
  if(homeProteinCircle){
    homeProteinCircle.style.setProperty("--deg", `${deg}deg`);
  }
}
[pMorning,pLunch,pPre,pDinner,pBed].forEach(inp=>{
  inp.addEventListener("input", ()=>{
    renderProteinTotals();
    // live-fill the Home ring while typing (only makes sense for today)
    if((pDate?.value || todayISO()) === todayISO()){
      updateHomeProteinCirclePreview();
    }
  });
});
  
pDate?.addEventListener("change", ()=>{
  loadProteinDay(pDate.value);
  if((pDate.value || todayISO()) === todayISO()){
    updateHomeProteinCirclePreview();
  }
});

document.getElementById("pSaveBtn").addEventListener("click", ()=>{
  const d = pDate.value || todayISO();
  proteinMap[d] = {
    morning:Number(pMorning.value)||0,
    lunch:Number(pLunch.value)||0,
    pre:Number(pPre.value)||0,
    dinner:Number(pDinner.value)||0,
    bed:Number(pBed.value)||0,
  };
  LS.set(KEY_PRO, proteinMap);
refreshHome();
alert("Saved ✅");
});

/* ---------------------------
   Lifts + PR helpers
---------------------------- */
lifts = LS.get(KEY_LIFTS, []);

function ensureLiftCompatibility(){
  lifts = lifts.map(x=>{
    const ex = String(x.ex || x.exercise || "");
    const exNorm = x.exNorm || normExName(ex);
    return {
      ...x,
      ex,
      exNorm,
      routineId: x.routineId || "",
      routineName: x.routineName || "",
      dayKey: x.dayKey || ""
    };
  });
  LS.set(KEY_LIFTS, lifts);
}
ensureLiftCompatibility();
  migrateCanonicalNames();

  function migrateCanonicalNames(){
  // ---- Routines ----
  let routinesChanged = false;

  routines.forEach(r=>{
    DAY_KEYS.forEach(k=>{
      const day = r.days?.[k];
      if(!day || !Array.isArray(day.exercises)) return;

      day.exercises.forEach(ex=>{
        const after = canonicalExerciseName(ex.name);
        if(after && ex.name !== after){
          ex.name = after;
          routinesChanged = true;
        }
      });

      // Remove duplicates caused by merging names
      const seen = new Set();
      day.exercises = day.exercises.filter(ex=>{
        const n = normExName(ex.name);
        if(seen.has(n)) return false;
        seen.add(n);
        return true;
      });
    });
  });

  if(routinesChanged) saveRoutines();

  // ---- Lifts ----
  let liftsChanged = false;

  lifts = lifts.map(x=>{
    const after = canonicalExerciseName(x.ex);
    const afterNorm = normExName(after);
    if(x.ex !== after || x.exNorm !== afterNorm){
      liftsChanged = true;
      return { ...x, ex: after, exNorm: afterNorm };
    }
    return x;
  });

  if(liftsChanged) LS.set(KEY_LIFTS, lifts);
}
migrateCanonicalNames();

function liftStatsForExercise(exName){
  const n = normExName(exName);
  const exLifts = lifts.filter(x=> (x.exNorm || normExName(x.ex)) === n);

  const life = exLifts.length ? Math.max(...exLifts.map(x=>Number(x.weight)||0)) : null;

  const thisWeekStart = new Date(); thisWeekStart.setDate(thisWeekStart.getDate()-7);
  const lastWeekStart = new Date(); lastWeekStart.setDate(lastWeekStart.getDate()-14);

  const thisWeek = exLifts.filter(x=>parseISO(x.date) >= thisWeekStart);
  const lastWeek = exLifts.filter(x=>{
    const d = parseISO(x.date);
    return d >= lastWeekStart && d < thisWeekStart;
  });

  const thisWeekMax = thisWeek.length ? Math.max(...thisWeek.map(x=>Number(x.weight)||0)) : null;
  const lastWeekMax = lastWeek.length ? Math.max(...lastWeek.map(x=>Number(x.weight)||0)) : null;

  return { life, thisWeekMax, lastWeekMax };
}

function getLastLiftForExercise(exName){
  const n = normExName(exName);
  const exLifts = lifts
    .filter(x=> (x.exNorm || normExName(x.ex)) === n)
    .sort((a,b)=>b.date.localeCompare(a.date));
  return exLifts[0] || null;
}

function formatSetsDetail(lift){
  if(!lift) return "—";
  const topSet = (lift.weight && lift.reps) ? `${lift.weight} x ${lift.reps}` : "—";
  const details = Array.isArray(lift.details) && lift.details.length
    ? lift.details.map((s,i)=>`S${i+1}:${s.weight}x${s.reps}`).join("  ")
    : null;
  return `${lift.date} • Top: ${topSet}${details ? " • " + details : ""}`;
}

/* ---------------------------
   Routine UI
---------------------------- */
const routineSelect = document.getElementById("routineSelect");
const activeRoutineMeta = document.getElementById("activeRoutineMeta");
const newRoutineBtn = document.getElementById("newRoutineBtn");
const editRoutineBtn = document.getElementById("editRoutineBtn");
const dupRoutineBtn = document.getElementById("dupRoutineBtn");
const delRoutineBtn = document.getElementById("delRoutineBtn");

let activeDayIndex = 0; // Mon=0..Sun=6

function renderRoutineDropdown(forceId){
  const selected = forceId || activeRoutineId;

  routineSelect.innerHTML = "";

  // --- Created Workouts (your saved routines) ---
  const ogCreated = document.createElement("optgroup");
  ogCreated.label = "Created Workouts";

  routines.forEach(r=>{
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name;
    ogCreated.appendChild(opt);
  });

  routineSelect.appendChild(ogCreated);

  // --- Default / Template Workouts ---
  const ogTemplates = document.createElement("optgroup");
  ogTemplates.label = "Default / Template Workouts";

  ROUTINE_TEMPLATES.forEach(t=>{
    const opt = document.createElement("option");
    opt.value = t.id;      // tpl_*
    opt.textContent = t.name;
    ogTemplates.appendChild(opt);
  });

  routineSelect.appendChild(ogTemplates);

  // --- select active value ---
  const allValues = [...routineSelect.options].map(o=>o.value);

  // if selected is a real routine OR a template id, keep it
  const finalVal = allValues.includes(selected) ? selected : (routines[0]?.id || "");

  routineSelect.value = finalVal;

  // if it's a real routine, update active routine + meta
  if(finalVal && !finalVal.startsWith("tpl_")){
    setActiveRoutine(finalVal);
    const ar = getActiveRoutine();
    activeRoutineMeta.textContent = `${ar.name} • ${DAY_KEYS.length} days`;
  } else {
    // template selected, meta can stay based on current active routine
    const ar = getActiveRoutine();
    activeRoutineMeta.textContent = `${ar.name} • ${DAY_KEYS.length} days`;
  }
}
  
routineSelect.addEventListener("change", ()=>{
  const val = routineSelect.value;

  // If they picked a template -> convert it into a REAL saved routine
  if(val.startsWith("tpl_")){
    const tpl = ROUTINE_TEMPLATES.find(t=>t.id === val);
    if(!tpl) return;

    const built = tpl.build();
    built.id = uid(); // ensure unique
    built.name = tpl.name; // keep template name
    routines.push(built);
    saveRoutines();

    setActiveRoutine(built.id);

    // re-render dropdown and select the newly created routine
    renderRoutineDropdown(built.id);
    renderPPL();
    renderLiftRoutineDropdown();
    buildRoutineExerciseSuggestions();

    return;
  }

  // Normal: user selected a real created routine
  setActiveRoutine(val);
  renderRoutineDropdown(val);
  renderPPL();
  renderLiftRoutineDropdown();
  buildRoutineExerciseSuggestions();
});


newRoutineBtn.addEventListener("click", ()=>{
  const base = defaultRoutine();
  base.name = `New Routine ${routines.length+1}`;
  base.source = "user";
  DAY_KEYS.forEach(k=>{
    base.days[k].exercises = [];
    base.days[k].rest = (k==="Sun");
    if(k==="Sun") base.days[k].label = "Rest";
  });
  routines.push(base);
  saveRoutines();
  
  setActiveRoutine(base.id);
  renderRoutineDropdown();
  openRoutineEditor(base.id);
});

dupRoutineBtn.addEventListener("click", ()=>{
  const ar = getActiveRoutine();
  const copy = JSON.parse(JSON.stringify(ar));
  copy.source = "user";
  copy.id = uid();
  copy.name = `${ar.name} (Copy)`;
  routines.push(copy);
  saveRoutines();
  setActiveRoutine(copy.id);
  renderRoutineDropdown();
  renderPPL();
  renderLiftRoutineDropdown();
});

delRoutineBtn.addEventListener("click", ()=>{
  if(routines.length <= 1){
    alert("You must keep at least one routine.");
    return;
  }
  const ar = getActiveRoutine();
  const ok = confirm(`Delete routine "${ar.name}"? (Logs will NOT be deleted.)`);
  if(!ok) return;
  routines = routines.filter(r=>r.id!==ar.id);
  saveRoutines();
  setActiveRoutine(routines[0].id);
  renderRoutineDropdown();
  renderPPL();
  renderLiftRoutineDropdown();
});

editRoutineBtn.addEventListener("click", ()=>{
  openRoutineEditor(getActiveRoutine().id);
});

function getTodaySplitIndex(){
  const dow = new Date().getDay(); // Sun=0..Sat=6
  if(dow === 0) return 6;
  return dow - 1;
}

/* ---------------------------
   PPL display
---------------------------- */
const pplTabs = document.getElementById("pplTabs");
const pplList = document.getElementById("pplList");

function renderDayTabs(){
  pplTabs.innerHTML = "";
  const ar = getActiveRoutine();

  DAY_KEYS.forEach((k, idx)=>{
    const day = ar.days[k];
    const label = (day.label || "").trim();
    const rest = !!day.rest;

    const b = document.createElement("div");
    b.className = "tab" + (idx===activeDayIndex ? " active" : "");
    b.innerHTML = `
      <span>${k}</span>
      ${label ? `<span class="badge">${label}</span>` : ""}
      ${rest ? `<span class="badge">Rest</span>` : ""}
    `;
    b.addEventListener("click", ()=>{
      activeDayIndex = idx;
      renderPPL();
    });
    pplTabs.appendChild(b);
  });
}

function renderPPL(){
  renderDayTabs();

  const ar = getActiveRoutine();
  const dayKey = DAY_KEYS[activeDayIndex];
  const day = ar.days[dayKey];

  pplList.innerHTML = "";

  if(day.rest){
    const restCard = document.createElement("div");
    restCard.className = "notice";
    restCard.innerHTML = `
      <div><strong>${dayKey}</strong> is marked as a Rest Day.</div>
      <div class="small muted">Exercises are stored but hidden. Toggle rest off in the Routine Editor.</div>
    `;
    pplList.appendChild(restCard);
    renderLiftSearchDropdown();
    return;
  }

  const list = Array.isArray(day.exercises) ? day.exercises : [];

  if(!list.length){
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "No exercises yet for this day. Click Edit to add exercises.";
    pplList.appendChild(empty);
    renderLiftSearchDropdown();
    return;
  }

  list.forEach(item=>{
    const ex = item.name;
    const {life, thisWeekMax, lastWeekMax} = liftStatsForExercise(ex);

    const isPRThisWeek = (life !== null && thisWeekMax !== null && thisWeekMax === life);
    const prBadge = isPRThisWeek ? `<span class="badge">🏆 PR (this week)</span>` : ``;

    const card = document.createElement("div");
    card.className = "exerciseItem";
    card.innerHTML = `
      <div class="left">
        <div class="title">${ex}</div>
        <div class="meta">
          <span>${item.sets || "—"} sets</span>
          <span>•</span>
          <span>${item.reps || "—"} reps</span>
          ${item.notes ? `<span class="badge">${item.notes}</span>` : ""}
        </div>
      </div>
      <div class="right">
        <div class="line2">This week: <span class="mono">${thisWeekMax===null?"—":thisWeekMax}</span> lbs</div>
        <div class="line2">Last week: <span class="mono">${lastWeekMax===null?"—":lastWeekMax}</span> lbs</div>
        <div class="line2">Lifetime max: <span class="mono">${life===null?"—":life}</span> lbs</div>
        <div style="display:flex; gap:8px; align-items:center; justify-content:flex-end; flex-wrap:wrap;">
          ${prBadge}
          <button type="button" data-log="${ex}">Log Sets</button>
        </div>
      </div>
    `;

    const logBtn = card.querySelector('button[data-log]');
    if(logBtn){
      logBtn.addEventListener("click", ()=>{
        openLogModal(ex, Number(item.sets)||3, ar, dayKey, activeDayIndex);
      });
    }

    pplList.appendChild(card);
  });

  renderLiftSearchDropdown();
}

document.getElementById("startTodayBtn").addEventListener("click", ()=>{
  showScreen("routine");
  activeDayIndex = getTodaySplitIndex();
  renderPPL();
  document.getElementById("pplList").scrollIntoView({behavior:"smooth", block:"start"});
});


/* ---------------------------
   Lift Progress Log (Phase 4)
---------------------------- */
const liftTable = document.getElementById("liftTable");
const liftSearch = document.getElementById("liftSearch");
const liftRoutine = document.getElementById("liftRoutine");
const liftFrom = document.getElementById("liftFrom");
const liftTo = document.getElementById("liftTo");
const liftMetric = document.getElementById("liftMetric");
const liftLimit = document.getElementById("liftLimit");

const liftSearchBtn = document.getElementById("liftSearchBtn");
const liftClearBtn = document.getElementById("liftClearBtn");

const liftViewTableBtn = document.getElementById("liftViewTableBtn");
const liftViewGraphBtn = document.getElementById("liftViewGraphBtn");
const liftDownloadBtn = document.getElementById("liftDownloadBtn");

const liftTableWrap = document.getElementById("liftTableWrap");
const liftGraphWrap = document.getElementById("liftGraphWrap");

let liftView = "table"; // "table" | "graph"
let appliedLiftFilters = {
  ex: "",
  routineId: "",
  from: "",
  to: "",
  metric: "top",
  limit: 25
};

function collectAllExerciseNames(){
  const set = new Set();

  // 1️⃣ Canonical library first
  EXERCISE_LIBRARY.forEach(n => set.add(canonicalExerciseName(n)));

  // 1.5️⃣ Custom exercises created by you
loadCustomExercises().forEach(n => set.add(canonicalExerciseName(n)));

  // 2️⃣ Routine exercises
  routines.forEach(r=>{
    DAY_KEYS.forEach(k=>{
      (r.days?.[k]?.exercises || []).forEach(e=>{
    if(e?.name) set.add(canonicalExerciseName(e.name));
      });
    });
  });

  // 3️⃣ Logged lifts
  lifts.forEach(x=>{
    if(x.ex) set.add(canonicalExerciseName(x.ex));
  });

  return [...set].sort((a,b)=>a.localeCompare(b));
}

function renderLiftSearchDropdown(){
  const prev = liftSearch.value || "";
  const items = ["", ...collectAllExerciseNames()];
  liftSearch.innerHTML = "";
  items.forEach(v=>{
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v === "" ? "All exercises" : v;
    liftSearch.appendChild(opt);
  });
  liftSearch.value = items.includes(prev) ? prev : "";
}
/* ---------------------------
   Exercise Picker (Add + Swap)
---------------------------- */
const exPickModal = document.getElementById("exPickModal");
const exPickTitle = document.getElementById("exPickTitle");
const exPickCloseBtn = document.getElementById("exPickCloseBtn");
const exPickCancelBtn = document.getElementById("exPickCancelBtn");
const exPickConfirmBtn = document.getElementById("exPickConfirmBtn");
const exPickSearch = document.getElementById("exPickSearch");
const exPickList = document.getElementById("exPickList");

let exPickSelected = "";                 // single mode selected
let exPickSelectedSet = new Set();       // multi mode selected set
let exPickMulti = false;                 // are we in multi mode?
let exPickOnConfirm = null;

function openExercisePicker({ title="Pick Exercise", initial="", onConfirm, multi=false, initialMulti=[] }){
  exPickTitle.textContent = title;

  exPickMulti = !!multi;
  exPickOnConfirm = onConfirm;

  // reset selections
  exPickSelected = initial || "";
  exPickSelectedSet = new Set(Array.isArray(initialMulti) ? initialMulti : []);

  exPickSearch.value = "";
  renderExercisePickerList();
  lockBodyScroll();                 // ✅ ADD
  exPickModal.style.display = "block";
}


function closeExercisePicker(){
  exPickModal.style.display = "none";
  unlockBodyScroll(); // ✅ ADD THIS
  exPickSelected = "";
  exPickSelectedSet = new Set();
  exPickMulti = false;
  exPickOnConfirm = null;
}


function renderExercisePickerList(){
  const rawQ = String(exPickSearch.value || "").trim();
  const q = normExName(rawQ);

  const all = collectAllExerciseNames();
  const filtered = q ? all.filter(n => normExName(n).includes(q)) : all;

  exPickList.innerHTML = "";

  // ✅ "Create new" option when typing
  if(rawQ){
    const exists = all.some(n => normExName(n) === normExName(rawQ));
    if(!exists){
      const create = document.createElement("div");
      create.className = "exPickItem";
      create.innerHTML = `
        <div class="exPickRow">
          ${exPickMulti ? `<span class="exPickCheck">+</span>` : ``}
          <span>➕ Create "<strong>${rawQ}</strong>"</span>
        </div>
      `;
      create.addEventListener("click", ()=>{
  const created = addCustomExercise(rawQ);
  if(!created) return;

        if(exPickMulti){
          exPickSelectedSet.add(created);
          renderExercisePickerList();
        } else {
          exPickSelected = created;
          [...exPickList.querySelectorAll(".exPickItem")].forEach(x=>x.classList.remove("active"));
          create.classList.add("active");
        }
      });
      exPickList.appendChild(create);
    }
  }

  if(filtered.length === 0){
    if(!rawQ){
      exPickList.innerHTML = `<div class="notice">No matches.</div>`;
    }
    return;
  }

  filtered.forEach(name=>{
    const isActive = exPickMulti ? exPickSelectedSet.has(name) : (name === exPickSelected);

    const div = document.createElement("div");
    div.className = "exPickItem" + (isActive ? " active" : "");

    div.innerHTML = `
      <div class="exPickRow">
        ${exPickMulti ? `<span class="exPickCheck">${isActive ? "✓" : ""}</span>` : ``}
        <span>${name}</span>
      </div>
    `;

    div.addEventListener("click", ()=>{
      if(exPickMulti){
        if(exPickSelectedSet.has(name)) exPickSelectedSet.delete(name);
        else exPickSelectedSet.add(name);
        renderExercisePickerList();
      } else {
        exPickSelected = name;
        [...exPickList.querySelectorAll(".exPickItem")].forEach(x=>x.classList.remove("active"));
        div.classList.add("active");
      }
    });

    exPickList.appendChild(div);
  });
}


exPickSearch.addEventListener("input", renderExercisePickerList);

exPickConfirmBtn.addEventListener("click", ()=>{
  if(exPickMulti){
    const picked = [...exPickSelectedSet];

    if(picked.length === 0){
      alert("Select at least one exercise.");
      return;
    }

    if(typeof exPickOnConfirm === "function"){
      exPickOnConfirm(picked);
    }

    closeExercisePicker();
    return;
  }

  // single mode
if(!exPickSelected){
  const typed = cleanExerciseName(exPickSearch.value);
  if(!typed){
    alert("Pick an exercise first.");
    return;
  }
  exPickSelected = typed;
}

if(typeof exPickOnConfirm === "function"){
  exPickOnConfirm(exPickSelected);
}
closeExercisePicker();
});

  /* ---------------------------
   Batch Add Modal (Multi-add sets/reps)
---------------------------- */
const batchAddModal = document.getElementById("batchAddModal");
const batchAddCloseBtn = document.getElementById("batchAddCloseBtn");
const batchAddCancelBtn = document.getElementById("batchAddCancelBtn");
const batchAddConfirmBtn = document.getElementById("batchAddConfirmBtn");
const batchAddList = document.getElementById("batchAddList");

let batchAddItems = []; // [{name, sets, reps}]

function openBatchAddModal(names){
  // ✅ normalize: accept array OR single string
  const arr = Array.isArray(names)
    ? names
    : (typeof names === "string" && names.trim() ? [names.trim()] : []);

  batchAddItems = arr.map(n=>({
    name: canonicalExerciseName(n),
    sets: "",
    reps: ""
  }));

  renderBatchAddList();
  lockBodyScroll();                 // ✅ ADD
  batchAddModal.style.display = "block";
}


function closeBatchAddModal(){
  batchAddModal.style.display = "none";
  unlockBodyScroll();               // ✅ ADD
  batchAddItems = [];
}

function renderBatchAddList(){
  batchAddList.innerHTML = "";

  batchAddItems.forEach((it, idx)=>{
    const card = document.createElement("div");
    card.className = "card";
    card.style.background = "#0f0f10";
    card.style.padding = "10px";

    card.innerHTML = `
      <div class="row" style="align-items:end;">
        <div style="flex:2 1 220px;">
          <div class="small muted">Exercise</div>
          <div style="font-weight:700; margin-top:4px;">${it.name}</div>
        </div>

        <label style="flex:0 0 120px;">Sets
          <input type="number" min="1" value="${it.sets}" data-bsets="${idx}" placeholder="3" />
        </label>

        <label style="flex:1 1 160px;">Reps
          <input value="${it.reps}" data-breps="${idx}" placeholder="8–10" />
        </label>

        <button type="button" class="miniBtn danger" data-bremove="${idx}">Remove</button>
      </div>
    `;

    batchAddList.appendChild(card);
  });

  // wire inputs
  batchAddList.querySelectorAll("[data-bsets]").forEach(inp=>{
    inp.addEventListener("input", ()=>{
      const i = Number(inp.getAttribute("data-bsets"));
      batchAddItems[i].sets = inp.value;
    });
  });

  batchAddList.querySelectorAll("[data-breps]").forEach(inp=>{
    inp.addEventListener("input", ()=>{
      const i = Number(inp.getAttribute("data-breps"));
      batchAddItems[i].reps = inp.value;
    });
  });

  batchAddList.querySelectorAll("[data-bremove]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const i = Number(btn.getAttribute("data-bremove"));
      batchAddItems.splice(i,1);
      renderBatchAddList();
    });
  });
  // auto-focus first sets input
setTimeout(()=>{
  batchAddList.querySelector("input[data-bsets]")?.focus();
}, 0);
}

[batchAddCloseBtn, batchAddCancelBtn].forEach(btn=>{
  btn?.addEventListener("click", closeBatchAddModal);
});
batchAddModal?.addEventListener("click", (e)=>{ if(e.target === batchAddModal) closeBatchAddModal(); });

batchAddConfirmBtn?.addEventListener("click", ()=>{
  // validate
  for(const it of batchAddItems){
    const sets = Number(it.sets);
    const reps = String(it.reps || "").trim();
    if(!sets || sets <= 0){
      alert(`Enter sets for: ${it.name}`);
      return;
    }
    if(!reps){
      alert(`Enter reps for: ${it.name}`);
      return;
    }
  }

  // add to current draft day
  const k = DAY_KEYS[editDayIndex];
  const day = draftRoutine.days[k];

  batchAddItems.forEach(it=>{
    day.exercises.push({
      name: canonicalExerciseName(it.name),
      sets: Number(it.sets),
      reps: String(it.reps).trim(),
      notes: ""
    });
  });

  closeBatchAddModal();
  renderRtDayPanel();
  buildRoutineExerciseSuggestions();
  renderLiftSearchDropdown();
});


[exPickCloseBtn, exPickCancelBtn].forEach(btn=>btn.addEventListener("click", closeExercisePicker));
exPickModal.addEventListener("click", (e)=>{ if(e.target === exPickModal) closeExercisePicker(); });

function renderLiftRoutineDropdown(){
  const prev = liftRoutine.value || "";
  liftRoutine.innerHTML = "";

  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "All routines";
  liftRoutine.appendChild(optAll);

  routines.forEach(r=>{
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name;
    liftRoutine.appendChild(opt);
  });

  liftRoutine.value = (prev && routines.some(r=>r.id===prev)) ? prev : "";
}

function applyLiftFiltersFromUI(){
  appliedLiftFilters = {
    ex: (liftSearch.value || "").trim(),
    routineId: (liftRoutine.value || "").trim(),
    from: (liftFrom.value || "").trim(),
    to: (liftTo.value || "").trim(),
    metric: (liftMetric.value || "top"),
    limit: Number(liftLimit.value || 25)
  };
}

function clearLiftFiltersUI(){
  liftSearch.value = "";
  liftRoutine.value = "";
  liftFrom.value = "";
  liftTo.value = "";
  liftMetric.value = "top";
  liftLimit.value = "25";
}

function getLiftFilteredData(){
  let arr = [...lifts];

  // exercise filter (normalized)
  if(appliedLiftFilters.ex){
    const n = normExName(appliedLiftFilters.ex);
    arr = arr.filter(x => (x.exNorm || normExName(x.ex)) === n);
  }

  // routine filter
  if(appliedLiftFilters.routineId){
    arr = arr.filter(x => String(x.routineId || "") === appliedLiftFilters.routineId);
  }

  // date range filter
  if(appliedLiftFilters.from){
    const f = parseISO(appliedLiftFilters.from);
    arr = arr.filter(x => parseISO(x.date) >= f);
  }
  if(appliedLiftFilters.to){
    const t = parseISO(appliedLiftFilters.to);
    arr = arr.filter(x => parseISO(x.date) <= t);
  }

  // sort newest for table, oldest for graph later
  arr.sort((a,b)=>b.date.localeCompare(a.date));

  // limit (table)
  if(liftView === "table"){
    const lim = Number(appliedLiftFilters.limit || 25);
    if(lim > 0) arr = arr.slice(0, lim);
  }

  return arr;
}

function renderLiftsTable(){
  liftTable.innerHTML = "";
  const visible = getLiftFilteredData();

  visible.forEach(x=>{
    const topSet = (x.weight && x.reps) ? `${x.weight} x ${x.reps}` : "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${x.date}</td>
      <td><span class="clickEx" data-hist="${x.ex}">${x.ex}</span></td>
      <td class="mono">${topSet}</td>
      <td class="mono">${x.sets ?? "—"}</td>
      <td>${x.pr ? '<span class="badge">🏆</span>' : ''}</td>
      <td><button data-dellift="${x.id}">Delete</button></td>
    `;
    liftTable.appendChild(tr);
  });

  liftTable.querySelectorAll("button[data-dellift]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-dellift");
      lifts = lifts.filter(x=>x.id!==id);
      LS.set(KEY_LIFTS, lifts);
      renderLiftSearchDropdown();
      renderLifts();   // rerun with applied filters
      renderPPL();
      buildRoutineExerciseSuggestions();
    });
  });

  liftTable.querySelectorAll("[data-hist]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const ex = el.getAttribute("data-hist");
      openHistoryModal(ex);
    });
  });
}

/* ---- Graph helpers ---- */
function estEpley1RM(weight, reps){
  const w = Number(weight)||0;
  const r = Number(reps)||0;
  if(!w || !r) return 0;
  return w * (1 + (r/30));
}
function calcVolume(lift){
  // Prefer details if present
  if(Array.isArray(lift.details) && lift.details.length){
    return lift.details.reduce((sum,s)=>sum + (Number(s.weight)||0)*(Number(s.reps)||0), 0);
  }
  const w = Number(lift.weight)||0;
  const r = Number(lift.reps)||0;
  const sets = Number(lift.sets)||1;
  return w * r * sets;
}
function weekKey(d){
  const ws = weekStartDate(d);
  return `${ws.getFullYear()}-${pad2(ws.getMonth()+1)}-${pad2(ws.getDate())}`;
}

let liftChart; // chart.js instance

const weekSeparatorsPlugin = {
  id: "weekSeparators",
  beforeDraw(chart, args, pluginOptions){
    const cfg = chart?.config?.options?.plugins?.weekSeparators;
    if(!cfg || cfg.enabled !== true) return;

    const {ctx, chartArea} = chart;
    const xScale = chart.scales?.x;
    if(!ctx || !chartArea || !xScale) return;

    const labels = chart.data.labels || [];
    if(labels.length < 2) return;

    // find week boundaries by comparing week keys across consecutive points
    const boundaries = [];
    let prevKey = null;
    for(let i=0;i<labels.length;i++){
      const d = parseISO(labels[i]);
      const key = weekKey(d);
      if(prevKey !== null && key !== prevKey){
        boundaries.push(i);
      }
      prevKey = key;
    }

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(154,160,166,0.22)";

    boundaries.forEach(i=>{
      const x = xScale.getPixelForValue(labels[i]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
    });

    ctx.restore();
  }
};

function renderLiftsGraph(){
  const visible = getLiftFilteredData()
    .slice() // copy
    .sort((a,b)=>a.date.localeCompare(b.date)); // oldest -> newest

  const labels = visible.map(x=>x.date);

  const metric = appliedLiftFilters.metric || "top";
  const data = visible.map(x=>{
    if(metric === "e1rm") return estEpley1RM(x.weight, x.reps);
    if(metric === "vol") return calcVolume(x);
    return Number(x.weight)||0; // top
  });

  const yLabel =
    metric === "e1rm" ? "Est. 1RM (lbs)" :
    metric === "vol" ? "Volume" :
    "Top Weight (lbs)";

  const ctx = document.getElementById("liftChart");
  if(liftChart) liftChart.destroy();

  liftChart = new Chart(ctx, {
    type:"line",
    data:{
      labels,
      datasets:[{
        label: yLabel,
        data,
        tension:.25,
        pointRadius:3,
      }]
    },
    options:{
      responsive:true,
      plugins:{
        legend:{display:false},
        tooltip:{mode:"index", intersect:false},
        weekSeparators:{enabled:true}
      },
      scales:{
        x:{ticks:{color:"#9aa0a6"}, grid:{color:"#202124"}},
        y:{ticks:{color:"#9aa0a6"}, grid:{color:"#202124"}}
      }
    },
    plugins:[weekSeparatorsPlugin]
  });

  // If no data, show a friendly message
  if(labels.length === 0){
    // chart will just be empty; that's fine
  }
}

function setLiftView(next){
  liftView = next;

  if(liftView === "table"){
    liftTableWrap.style.display = "";
    liftGraphWrap.style.display = "none";
    liftViewTableBtn.classList.remove("ghost");
    liftViewGraphBtn.classList.add("ghost");
    liftDownloadBtn.classList.add("ghost");
    renderLiftsTable();
  } else {
    liftTableWrap.style.display = "none";
    liftGraphWrap.style.display = "";
    liftViewTableBtn.classList.add("ghost");
    liftViewGraphBtn.classList.remove("ghost");
    liftDownloadBtn.classList.remove("ghost");
    renderLiftsGraph();
  }
}

function renderLifts(){
  // uses appliedLiftFilters + current liftView
  if(liftView === "table") renderLiftsTable();
  else renderLiftsGraph();
}

liftViewTableBtn.addEventListener("click", ()=> setLiftView("table"));
liftViewGraphBtn.addEventListener("click", ()=> setLiftView("graph"));

liftSearchBtn.addEventListener("click", ()=>{
  applyLiftFiltersFromUI();
  renderLifts();
});

liftClearBtn.addEventListener("click", ()=>{
  clearLiftFiltersUI();
  applyLiftFiltersFromUI();
  setLiftView("table");
  renderLifts();
});

liftDownloadBtn.addEventListener("click", ()=>{
  if(!liftChart){
    alert("Switch to Graph view first.");
    return;
  }
  const url = liftChart.toBase64Image("image/png", 1);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lift-graph-${localISODate(new Date())}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

/* ---------------------------
   Log Sets Modal
---------------------------- */
const logModal = document.getElementById("logModal");
const logModalClose = document.getElementById("logModalClose");
const logModalExercise = document.getElementById("logModalExercise");
const logRoutineLine = document.getElementById("logRoutineLine");
const logModalDate = document.getElementById("logModalDate");
const logModalSets = document.getElementById("logModalSets");
const logAddSetBtn = document.getElementById("logAddSetBtn");
const logSaveBtn = document.getElementById("logSaveBtn");

const logPrevBox = document.getElementById("logPrevBox");
const logPrevText = document.getElementById("logPrevText");
const logCopyLastBtn = document.getElementById("logCopyLastBtn");
const logViewHistoryBtn = document.getElementById("logViewHistoryBtn");

let modalExerciseName = null;
let modalLastLift = null;
let modalRoutine = null;
let modalDayKey = null;
let modalDayIndex = null;

function openLogModal(exName, defaultSets=3, routineObj=null, dayKey="", dayIndex=0){
  modalExerciseName = canonicalExerciseName(exName);
  logModalExercise.textContent = modalExerciseName;
  logRoutineLine.textContent = routineObj ? `${routineObj.name} • ${dayKey}` : "—";
  modalRoutine = routineObj;
  modalDayKey = dayKey;
  modalDayIndex = dayIndex;

  logModalDate.value = dateForWeekdayIndex(dayIndex, new Date()) || todayISO();

  modalLastLift = getLastLiftForExercise(modalExerciseName);
  if(modalLastLift){
    logPrevBox.style.display = "block";
    logPrevText.textContent = formatSetsDetail(modalLastLift);
  } else {
    logPrevBox.style.display = "none";
    logPrevText.textContent = "—";
  }

  logModalSets.innerHTML = "";
  for(let i=0;i<defaultSets;i++) addSetRow();

  lockBodyScroll();
  logModal.style.display = "block";
}

  function closeLogModal(){
  logModal.style.display = "none";
  unlockBodyScroll();               // ✅ ADD
  modalExerciseName = null;
  modalLastLift = null;
  modalRoutine = null;
  modalDayKey = null;
  modalDayIndex = null;
}

function renumberSetPills(){
  [...logModalSets.children].forEach((child, i)=>{
    const pillStrong = child.querySelector(".pill strong");
    if(pillStrong) pillStrong.textContent = String(i+1);
  });
}

function addSetRow(weight="", reps=""){
  const idx = logModalSets.children.length + 1;
  const row = document.createElement("div");
  row.className = "row";
  row.style.alignItems = "end";
  row.innerHTML = `
    <span class="pill"><span class="muted">Set</span> <strong class="mono">${idx}</strong></span>
    <label>Weight (lbs)
      <input type="number" step="0.5" inputmode="decimal" class="setWeight" placeholder="e.g., 75" value="${weight}" />
    </label>
    <label>Reps
      <input type="number" inputmode="numeric" class="setReps" placeholder="e.g., 8" value="${reps}" />
    </label>
    <button type="button" class="removeSetBtn">Remove</button>
  `;
  row.querySelector(".removeSetBtn").addEventListener("click", ()=>{
    row.remove();
    renumberSetPills();
  });
  logModalSets.appendChild(row);
}

logAddSetBtn.addEventListener("click", ()=> addSetRow());
logModalClose.addEventListener("click", closeLogModal);
logModal.addEventListener("click", (e)=>{ if(e.target === logModal) closeLogModal(); });

logCopyLastBtn.addEventListener("click", ()=>{
  if(!modalLastLift) return;
  logModalSets.innerHTML = "";

  if(Array.isArray(modalLastLift.details) && modalLastLift.details.length){
    modalLastLift.details.forEach(s=> addSetRow(String(s.weight ?? ""), String(s.reps ?? "")));
  } else {
    addSetRow(String(modalLastLift.weight ?? ""), String(modalLastLift.reps ?? ""));
  }
  renumberSetPills();
});

logViewHistoryBtn.addEventListener("click", ()=>{
  if(!modalExerciseName) return;
  openHistoryModal(modalExerciseName);
});

logSaveBtn.addEventListener("click", ()=>{
  if(!modalExerciseName) return;

  const date = logModalDate.value || todayISO();
  const setRows = [...logModalSets.querySelectorAll(".row")];

  const setsArr = [];
  for(const r of setRows){
    const w = Number(r.querySelector(".setWeight")?.value);
    const reps = Number(r.querySelector(".setReps")?.value);
    if(isFinite(w) && w > 0 && isFinite(reps) && reps > 0){
      setsArr.push({weight:w, reps:reps});
    }
  }

  if(setsArr.length === 0){
    alert("Enter at least one valid set (weight + reps).");
    return;
  }

  let top = setsArr[0];
  for(const s of setsArr){
    if(s.weight > top.weight) top = s;
  }

  const {life} = liftStatsForExercise(modalExerciseName);
  const isPR = (life === null) ? true : (top.weight > life);

  lifts.push({
    id: uid(),
    date,
    ex: modalExerciseName,
    exNorm: normExName(modalExerciseName),
    sets: setsArr.length,
    reps: top.reps,
    weight: top.weight,
    pr: isPR,
    details: setsArr,
    routineId: modalRoutine?.id || "",
    routineName: modalRoutine?.name || "",
    dayKey: modalDayKey || ""
  });

  lifts.sort((a,b)=>b.date.localeCompare(a.date));
  LS.set(KEY_LIFTS, lifts);

  const prevScroll = window.scrollY;
  closeLogModal();

  renderLiftSearchDropdown();
  renderLifts();      // Phase 4 respects applied filters
  renderPPL();
  window.scrollTo(0, prevScroll);
  buildRoutineExerciseSuggestions();

// ✅ Stay on Routine screen after saving
// showScreen("lifts");
// setTimeout(()=>{
//   document.getElementById("liftTableWrap")?.scrollIntoView({behavior:"smooth", block:"start"});
// }, 0);
}); // ✅ closes logSaveBtn click handler

/* ---------------------------
   History Modal
---------------------------- */
const histModal = document.getElementById("histModal");
const histCloseBtn = document.getElementById("histCloseBtn");
const histExercise = document.getElementById("histExercise");
const histTable = document.getElementById("histTable");

function closeHistoryModal(){
  histModal.style.display = "none";
  unlockBodyScroll();               // ✅ ADD
}
histCloseBtn.addEventListener("click", closeHistoryModal);
histModal.addEventListener("click", (e)=>{ if(e.target === histModal) closeHistoryModal(); });

function openHistoryModal(exName){
  const exCanonical = canonicalExerciseName(exName);
  const n = normExName(exCanonical);

  histExercise.textContent = exCanonical;

  const exLifts = lifts
    .filter(x=> (x.exNorm || normExName(x.ex)) === n)
    .sort((a,b)=>b.date.localeCompare(a.date))
    .slice(0, 12);

  histTable.innerHTML = "";

  exLifts.forEach(x=>{
    const topSet = (x.weight && x.reps) ? `${x.weight} x ${x.reps}` : "—";
    const allSets = Array.isArray(x.details) && x.details.length
      ? x.details.map((s,i)=>`S${i+1}:${s.weight}x${s.reps}`).join("  ")
      : "—";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${x.date}</td>
      <td class="mono">${topSet}</td>
      <td class="mono">${allSets}</td>
      <td>${x.pr ? '<span class="badge">🏆</span>' : ''}</td>
    `;
    histTable.appendChild(tr);
  });

  lockBodyScroll();                 // ✅ required
  histModal.style.display = "block";
}

/* ---------------------------
   Routine Editor (unchanged)
---------------------------- */
const rtModal = document.getElementById("rtModal");
const rtCloseBtn = document.getElementById("rtCloseBtn");
const rtCancelBtn = document.getElementById("rtCancelBtn");
const rtSaveBtn = document.getElementById("rtSaveBtn");

const rtName = document.getElementById("rtName");
const rtDayTabs = document.getElementById("rtDayTabs");
const rtDayLabel = document.getElementById("rtDayLabel");
const rtRestToggle = document.getElementById("rtRestToggle");
const rtDayRestNotice = document.getElementById("rtDayRestNotice");

const rtAddExName = document.getElementById("rtAddExName");
const rtAddExSets = document.getElementById("rtAddExSets");
const rtAddExReps = document.getElementById("rtAddExReps");
const rtAddExBtn = document.getElementById("rtAddExBtn");
const rtExList = document.getElementById("rtExList");
const rtAddMultiBtn = document.getElementById("rtAddMultiBtn");
const rtExSuggestions = document.getElementById("rtExSuggestions");

  function openAddExercisePicker(){
  // ✅ remember where the Routine Editor modal is scrolled
  const modalCard = document.querySelector("#rtModal > div");
  const prevScroll = modalCard ? modalCard.scrollTop : 0;

  // ✅ kill focus so iOS doesn’t scroll the page
  rtAddExName.blur();

  // ✅ open picker
  openExercisePicker({
    title: "Pick exercise to add",
    initial: rtAddExName.value,
    onConfirm: (picked)=>{
      rtAddExName.value = picked;

      // ✅ restore modal scroll after pick
      setTimeout(()=>{
        if(modalCard) modalCard.scrollTop = prevScroll;
      }, 0);
    }
  });

  // ✅ restore immediately too (covers iOS “jump” before picker paints)
  setTimeout(()=>{
    if(modalCard) modalCard.scrollTop = prevScroll;
  }, 0);
}

// open picker on tap/click
rtAddExName.addEventListener("click", (e)=>{
  e.preventDefault();
  openAddExercisePicker();
});

// safety: if iOS still triggers focus somehow
rtAddExName.addEventListener("focus", (e)=>{
  e.preventDefault();
  openAddExercisePicker();
});

  
let editRoutineId = null;
let editDayIndex = 0;
let draftRoutine = null;

function buildRoutineExerciseSuggestions(){
  const list = collectAllExerciseNames();
  rtExSuggestions.innerHTML = "";
  list.forEach(n=>{
    const opt = document.createElement("option");
    opt.value = n;
    rtExSuggestions.appendChild(opt);
  });
}

function openRoutineEditor(routineId){
  const r = routines.find(x=>x.id===routineId);
  if(!r) return;

  setActiveRoutine(routineId);

  editRoutineId = routineId;
  editDayIndex = activeDayIndex;
  draftRoutine = JSON.parse(JSON.stringify(r));

  rtName.value = draftRoutine.name;

  buildRoutineExerciseSuggestions();
  renderRtDayTabs();
  renderRtDayPanel();

  lockBodyScroll();                 // ✅ ADD
  rtModal.style.display = "block";
}

function closeRoutineEditor(){
  rtModal.style.display = "none";
  unlockBodyScroll();               // ✅ ADD
  editRoutineId = null;
  editDayIndex = 0;
  draftRoutine = null;
}

rtCloseBtn.addEventListener("click", closeRoutineEditor);
rtCancelBtn.addEventListener("click", closeRoutineEditor);
rtModal.addEventListener("click", (e)=>{ if(e.target === rtModal) closeRoutineEditor(); });

function renderRtDayTabs(){
  rtDayTabs.innerHTML = "";
  DAY_KEYS.forEach((k, idx)=>{
    const day = draftRoutine.days[k];
    const label = (day.label||"").trim();
    const rest = !!day.rest;

    const b = document.createElement("div");
    b.className = "tab" + (idx===editDayIndex ? " active" : "");
    b.innerHTML = `
      <span>${k}</span>
      ${label ? `<span class="badge">${label}</span>` : ""}
      ${rest ? `<span class="badge">Rest</span>` : ""}
    `;
    b.addEventListener("click", ()=>{
      editDayIndex = idx;
      renderRtDayTabs();
      renderRtDayPanel();
    });
    rtDayTabs.appendChild(b);
  });
}

function renderRtDayPanel(){
  const k = DAY_KEYS[editDayIndex];
  const day = draftRoutine.days[k];

  rtDayLabel.value = day.label || "";
  rtRestToggle.value = day.rest ? "1" : "0";
  rtDayRestNotice.style.display = day.rest ? "block" : "none";

  rtExList.innerHTML = "";
  const list = day.exercises || [];

  if(!list.length){
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "No exercises for this day yet.";
    rtExList.appendChild(empty);
    return;
  }

  list.forEach((ex, idx)=>{
    const wrap = document.createElement("div");
    wrap.className = "rtExCard";

    wrap.innerHTML = `
      <div class="rtExTop">
        <div class="rtExName">${ex.name || "Exercise"}</div>
        <span class="badge">${(ex.sets || "—")} sets • ${(ex.reps || "—")} reps</span>
      </div>

      <div class="row" style="margin-top:10px; align-items:end;">
        <label style="flex:2 1 240px;">Name
          <input data-field="name" value="${ex.name || ""}" />
        </label>

        <label style="flex:0 0 120px;">Sets
          <input data-field="sets" type="number" min="1" value="${ex.sets || ""}" />
        </label>

        <label style="flex:1 1 160px;">Reps
          <input data-field="reps" value="${ex.reps || ""}" />
        </label>
      </div>

      <div class="row" style="margin-top:8px;">
        <label style="flex:1 1 100%;">Notes
          <textarea data-field="notes" placeholder="optional">${ex.notes || ""}</textarea>
        </label>
      </div>

      <div class="rtActions">
        <button type="button" class="miniBtn" data-up="${idx}">↑ Up</button>
        <button type="button" class="miniBtn" data-down="${idx}">↓ Down</button>
        <button type="button" class="miniBtn" data-swap="${idx}">Swap</button>
        <button type="button" class="miniBtn danger" data-remove="${idx}">Remove</button>
      </div>
    `;

    // keep the rest of your event listeners EXACTLY as-is below

    wrap.querySelectorAll("[data-field]").forEach(inp=>{
      inp.addEventListener("input", ()=>{
        const field = inp.getAttribute("data-field");
        if(field === "sets"){
          day.exercises[idx][field] = Number(inp.value)||0;
        }else{
          day.exercises[idx][field] = inp.value;
        }
      });
    });

    wrap.querySelector("[data-up]")?.addEventListener("click", ()=>{
      if(idx<=0) return;
      const tmp = day.exercises[idx-1];
      day.exercises[idx-1] = day.exercises[idx];
      day.exercises[idx] = tmp;
      renderRtDayPanel();
    });

    wrap.querySelector("[data-down]")?.addEventListener("click", ()=>{
      if(idx>=day.exercises.length-1) return;
      const tmp = day.exercises[idx+1];
      day.exercises[idx+1] = day.exercises[idx];
      day.exercises[idx] = tmp;
      renderRtDayPanel();
    });

    wrap.querySelector("[data-remove]")?.addEventListener("click", ()=>{
      day.exercises.splice(idx,1);
      renderRtDayPanel();
    });

    wrap.querySelector("[data-swap]")?.addEventListener("click", ()=>{
  const cur = day.exercises[idx]?.name || "";
  openExercisePicker({
    title: "Swap exercise",
    initial: cur,
    onConfirm: (picked)=>{
    day.exercises[idx].name = canonicalExerciseName(picked);
      renderRtDayPanel();
    }
  });
});

    rtExList.appendChild(wrap);
  });
}

rtDayLabel.addEventListener("input", ()=>{
  const k = DAY_KEYS[editDayIndex];
  draftRoutine.days[k].label = rtDayLabel.value;
  renderRtDayTabs();
});
rtRestToggle.addEventListener("change", ()=>{
  const k = DAY_KEYS[editDayIndex];
  draftRoutine.days[k].rest = (rtRestToggle.value === "1");
  if(draftRoutine.days[k].rest && !draftRoutine.days[k].label){
    draftRoutine.days[k].label = "Rest";
    rtDayLabel.value = "Rest";
  }
  rtDayRestNotice.style.display = draftRoutine.days[k].rest ? "block" : "none";
  renderRtDayTabs();
});

rtAddExBtn.addEventListener("click", ()=>{
  const k = DAY_KEYS[editDayIndex];
  const day = draftRoutine.days[k];

  const name = canonicalExerciseName(String(rtAddExName.value||"").trim());
  const sets = Number(rtAddExSets.value)||0;
  const reps = String(rtAddExReps.value||"").trim();

  if(!name) return alert("Enter an exercise name.");
  if(!sets || sets <= 0) return alert("Enter sets (number).");
  if(!reps) return alert("Enter reps (e.g., 8–10).");

  day.exercises.push({name, sets, reps, notes:""});
  rtAddExName.value = "";
  rtAddExSets.value = "";
  rtAddExReps.value = "";

  renderRtDayPanel();
  buildRoutineExerciseSuggestions();
  renderLiftSearchDropdown();
});

  rtAddMultiBtn?.addEventListener("click", ()=>{
  openExercisePicker({
    title: "Pick multiple exercises",
    multi: true,
    initialMulti: [],
    onConfirm: (pickedNames)=>{
      // pickedNames is an array when multi=true
      openBatchAddModal(pickedNames);
    }
  });
});


rtSaveBtn.addEventListener("click", ()=>{
  if(!draftRoutine) return;

  const name = String(rtName.value||"").trim();
  if(!name) return alert("Routine needs a name.");
  draftRoutine.name = name;

  const idx = routines.findIndex(r=>r.id===editRoutineId);
  if(idx < 0) return;

  routines[idx] = draftRoutine;
  saveRoutines();

  setActiveRoutine(draftRoutine.id);

  closeRoutineEditor();
  renderRoutineDropdown();
  renderPPL();
  renderLiftRoutineDropdown();
  buildRoutineExerciseSuggestions();

  // If onboarding is not done yet, finish it and send to Home
if(!isOnboardingDone()){
  setOnboardingDone();
  refreshHome();
  showScreen("home");
}
});

  function renderLastBackup(){
  const el = document.getElementById("lastBackupText");
  if(!el) return;

  const iso = localStorage.getItem(KEY_LAST_BACKUP);
  if(!iso){
    el.textContent = "—";
    return;
  }
  const d = new Date(iso);
  el.textContent = d.toLocaleString();
}

/* ---------------------------
   Export / Import / Reset
---------------------------- */
const importBtn = document.getElementById("settingsImportBtn");
const importFile = document.getElementById("settingsImportFile");
const backupNowBtn = document.getElementById("backupNowBtn");

function buildExportPayload(){
  return {
    v: 3,
    exportedAt: new Date().toISOString(),
    profile: LS.get(KEY_PROFILE, defaultProfile()),
    lastBackup: localStorage.getItem(KEY_LAST_BACKUP) || null,
    activeScreen: localStorage.getItem(KEY_ACTIVE_SCREEN) || "home",

    bwLogs: LS.get(KEY_BW, []),
    attendance: LS.get(KEY_ATT, []),
    proteinMap: LS.get(KEY_PRO, {}),
    lifts: LS.get(KEY_LIFTS, []),
    routines: LS.get(KEY_ROUTINES, []),
    activeRoutineId: LS.get(KEY_ACTIVE_ROUTINE, null)
  };
}
function downloadJSON(filename, obj){
  const blob = new Blob([JSON.stringify(obj, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
backupNowBtn.addEventListener("click", ()=>{
  const payload = buildExportPayload();
  const stamp = localISODate(new Date());
  downloadJSON(`gym-dashboard-${stamp}.json`, payload);

  // also save last backup time
  localStorage.setItem(KEY_LAST_BACKUP, new Date().toISOString());
  renderLastBackup();
});
importBtn.addEventListener("click", ()=>{
  importFile.value = "";
  importFile.click();
});
importFile.addEventListener("change", async ()=>{
  const file = importFile.files?.[0];
  if(!file) return;

  try{
    const text = await file.text();
    const data = JSON.parse(text);

    const bw = Array.isArray(data.bwLogs) ? data.bwLogs : null;
    const att = Array.isArray(data.attendance) ? data.attendance : null;
    const pro = (data.proteinMap && typeof data.proteinMap === "object") ? data.proteinMap : null;
    const lf = Array.isArray(data.lifts) ? data.lifts : null;
    const rts = Array.isArray(data.routines) ? data.routines : null;
    const arId = (typeof data.activeRoutineId === "string" || data.activeRoutineId === null) ? data.activeRoutineId : null;

    if(!bw || !att || !pro || !lf || !rts){
      alert("That file doesn’t look like a valid export from this dashboard.");
      return;
    }

    const ok = confirm("Import will overwrite your current saved data on this browser. Continue?");
    if(!ok) return;

    LS.set(KEY_BW, bw);
    LS.set(KEY_ATT, att);
    LS.set(KEY_PRO, pro);
    LS.set(KEY_LIFTS, lf);
    LS.set(KEY_ROUTINES, rts);
    LS.set(KEY_ACTIVE_ROUTINE, arId);

    bwLogs = LS.get(KEY_BW, []);
    attendance = new Set(LS.get(KEY_ATT, []));
    proteinMap = LS.get(KEY_PRO, {});
    lifts = LS.get(KEY_LIFTS, []);
    ensureLiftCompatibility();

    ({routines, activeId: activeRoutineId} = loadRoutines());

    // ✅ init data + state first
renderCal();
loadProteinDay(todayISO());
renderLastBackup();

renderRoutineDropdown();
activeDayIndex = getTodaySplitIndex();
renderPPL();

renderLiftSearchDropdown();
renderLiftRoutineDropdown();
applyLiftFiltersFromUI();
setLiftView("table"); // sets UI state, table is fine hidden

buildRoutineExerciseSuggestions();

// ✅ restore last visited screen (or home) LAST
hydrateOnboardingInputs();
    
  // 3) Normal app restore (validate)
  const last = localStorage.getItem(KEY_ACTIVE_SCREEN) || "home";
  const exists = !!document.getElementById(`screen-${last}`);
  showScreen(exists ? last : "home");


    alert("Imported ✅");
  }catch(e){
    alert("Import failed. Make sure you selected a valid JSON export file.");
  }
});

document.getElementById("settingsResetBtn").addEventListener("click", ()=>{
  const ok = confirm("Reset ALL saved gym data on this device/browser?");
  if(!ok) return;
  localStorage.removeItem(KEY_BW);
  localStorage.removeItem(KEY_ATT);
  localStorage.removeItem(KEY_PRO);
  localStorage.removeItem(KEY_LIFTS);
  localStorage.removeItem(KEY_TARGETS);
  localStorage.removeItem(KEY_ROUTINES);
  localStorage.removeItem(KEY_ACTIVE_ROUTINE);
  localStorage.removeItem(KEY_ACTIVE_SCREEN);

   // ✅ STEP 5 — reset onboarding state
  localStorage.removeItem(KEY_ONBOARD_DONE);
  
  location.reload();
});

function isOnboardingDone(){
  return localStorage.getItem(KEY_ONBOARD_DONE) === "1";
}

function setOnboardingDone(){
  localStorage.setItem(KEY_ONBOARD_DONE, "1");
}

function hasProfileCompleted(){
  const p = LS.get(KEY_PROFILE, null);
  if(!p || typeof p !== "object") return false;
  return String(p.name || "").trim().length > 0; // you can relax this if name is optional
}

function hasAtLeastOneRoutine(){
  const rts = LS.get(KEY_ROUTINES, []);
  return Array.isArray(rts) && rts.length > 0;
}

function routeInitialScreen(){
  hydrateOnboardingInputs();

  // 1) If profile isn’t completed → Profile screen
  if(!hasProfileCompleted()){
    showScreen("profile");
    return;
  }

  // 2) If profile is done but onboarding not finished → Routine screen
  if(!isOnboardingDone()){
    showScreen("onboard-routine");
    return;
  }

  // 3) Normal app restore
  showScreen(localStorage.getItem(KEY_ACTIVE_SCREEN) || "home");
}

  /* ---------------------------
   App Version + Update Banner
   - bump APP_VERSION on each deploy
---------------------------- */
function showUpdateBanner(){
  const b = document.getElementById("updateBanner");
  if(b) b.style.display = "block";
}

function hideUpdateBanner(){
  const b = document.getElementById("updateBanner");
  if(b) b.style.display = "none";
}

async function checkForUpdate(){
  try{
    const url = "./version.json?ts=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });

    if(!res.ok){
      console.log("version.json fetch failed:", res.status, url);
      return;
    }

    const data = await res.json();
    const latest = String(data.version || "").trim();
    if(!latest){
      console.log("version.json missing 'version' field:", data);
      return;
    }

    const last = localStorage.getItem(KEY_APP_VERSION);

    console.log("Version check:", { last, latest });

    if(!last){
      localStorage.setItem(KEY_APP_VERSION, latest);
      renderHeaderSub();
      return;
    }

    if(last !== latest){
      showUpdateBanner();
      localStorage.setItem(KEY_APP_VERSION, latest);
      renderHeaderSub();
      return;
    }

    renderHeaderSub();
  }catch(e){
    console.log("checkForUpdate error:", e);
  }
}


document.addEventListener("click", (e)=>{
  const btn = e.target.closest("#updateRefreshBtn");
  if(!btn) return;

  // force a reload (browser will fetch latest files)
  location.reload();
});
  
/* ---------------------------
   Init (single pass)
---------------------------- */
function init(){
  // Load core state
  profile = loadProfile();

  ({routines, activeId: activeRoutineId} = loadRoutines());

  bwLogs = LS.get(KEY_BW, []);
  attendance = new Set(LS.get(KEY_ATT, []));
  proteinMap = LS.get(KEY_PRO, {});
  lifts = LS.get(KEY_LIFTS, []);
  ensureLiftCompatibility();
  migrateCanonicalNames();

  // Bind once
  bindNavigation();

  // Static UI (not screen-specific)
  hydrateSettingsUI();
  hydrateOnboardingInputs();
  renderHeaderSub();
  renderStorageInfo();
  renderLastBackup();

  // Default view settings
  setBWView("table");
  setLiftView("table");
  applyLiftFiltersFromUI();

  checkForUpdate();        // ✅ ADD THIS LINE


  // Route LAST (this calls showScreen which renders what’s needed)
  routeInitialScreen();
}

window.addEventListener("DOMContentLoaded", init);
