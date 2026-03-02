// library.js — Exercise Library + Routine Templates (extracted from app.js)
export function initLibrary({ getState, Storage, uid }){
  const normName = (s) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();

    /********************
     * 3) Routine templates
     ********************/
const RoutineTemplates = [
      // 🔥 PPL (Push / Pull / Legs) — 6 Days + Rest (Sunday)
      { key:"ppl", name:"PPL", desc:"Push / Pull / Legs • 6 days + Sunday rest",
        buildDays(){ return [
          { label:"Push", isRest:false },{ label:"Pull", isRest:false },{ label:"Legs", isRest:false },
          { label:"Push", isRest:false },{ label:"Pull", isRest:false },{ label:"Legs", isRest:false },
          { label:"Rest", isRest:true }
        ];},
        buildExerciseIndexMap(){ return ({
          0: [ // Push (Mon)
            { type:"weightlifting", name:"Barbell Bench Press", plan:{ sets:4, reps:"6–8", restSec:120 } },
            { type:"weightlifting", name:"Incline Dumbbell Press", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Dumbbell Shoulder Press", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Dumbbell Lateral Raise", plan:{ sets:3, reps:"12–15", restSec:60 } },
            { type:"weightlifting", name:"Cable Tricep Pushdown", plan:{ sets:3, reps:"10–12", restSec:60 } },
            { type:"weightlifting", name:"Overhead Tricep Extension", plan:{ sets:3, reps:"10–12", restSec:60 } }
          ],
          1: [ // Pull (Tue)
            { type:"weightlifting", name:"Barbell Deadlift", plan:{ sets:3, reps:"5", restSec:180 } },
            { type:"weightlifting", name:"Lat Pulldown", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Barbell Bent Over Row", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Face Pull", plan:{ sets:3, reps:"12–15", restSec:60 } },
            { type:"weightlifting", name:"Barbell Curl", plan:{ sets:3, reps:"8–10", restSec:60 } },
            { type:"weightlifting", name:"Hammer Curl", plan:{ sets:3, reps:"10–12", restSec:60 } }
          ],
          2: [ // Legs (Wed)
            { type:"weightlifting", name:"Back Squat", plan:{ sets:4, reps:"6–8", restSec:180 } },
            { type:"weightlifting", name:"Leg Press", plan:{ sets:3, reps:"8–10", restSec:120 } },
            { type:"weightlifting", name:"Romanian Deadlift", plan:{ sets:3, reps:"8–10", restSec:120 } },
            { type:"weightlifting", name:"Leg Curl", plan:{ sets:3, reps:"10–12", restSec:90 } },
            { type:"weightlifting", name:"Dumbbell Walking Lunge", plan:{ sets:3, reps:"10 each leg", restSec:90 } },
            { type:"weightlifting", name:"Seated Calf Raise", plan:{ sets:4, reps:"12–15", restSec:60 } }
          ],
          3: [ // Push (Thu) — repeat
            { type:"weightlifting", name:"Barbell Bench Press", plan:{ sets:4, reps:"6–8", restSec:120 } },
            { type:"weightlifting", name:"Incline Dumbbell Press", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Dumbbell Shoulder Press", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Dumbbell Lateral Raise", plan:{ sets:3, reps:"12–15", restSec:60 } },
            { type:"weightlifting", name:"Cable Tricep Pushdown", plan:{ sets:3, reps:"10–12", restSec:60 } },
            { type:"weightlifting", name:"Overhead Tricep Extension", plan:{ sets:3, reps:"10–12", restSec:60 } }
          ],
          4: [ // Pull (Fri) — repeat
            { type:"weightlifting", name:"Barbell Deadlift", plan:{ sets:3, reps:"5", restSec:180 } },
            { type:"weightlifting", name:"Lat Pulldown", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Barbell Bent Over Row", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Face Pull", plan:{ sets:3, reps:"12–15", restSec:60 } },
            { type:"weightlifting", name:"Barbell Curl", plan:{ sets:3, reps:"8–10", restSec:60 } },
            { type:"weightlifting", name:"Hammer Curl", plan:{ sets:3, reps:"10–12", restSec:60 } }
          ],
          5: [ // Legs (Sat) — repeat
            { type:"weightlifting", name:"Back Squat", plan:{ sets:4, reps:"6–8", restSec:180 } },
            { type:"weightlifting", name:"Leg Press", plan:{ sets:3, reps:"8–10", restSec:120 } },
            { type:"weightlifting", name:"Romanian Deadlift", plan:{ sets:3, reps:"8–10", restSec:120 } },
            { type:"weightlifting", name:"Leg Curl", plan:{ sets:3, reps:"10–12", restSec:90 } },
            { type:"weightlifting", name:"Dumbbell Walking Lunge", plan:{ sets:3, reps:"10 each leg", restSec:90 } },
            { type:"weightlifting", name:"Seated Calf Raise", plan:{ sets:4, reps:"12–15", restSec:60 } }
          ]
        });}
      },

      // 💪 Upper / Lower Split (4 Days)
      { key:"upper_lower", name:"Upper / Lower", desc:"4 days • Wed + weekend rest",
        buildDays(){ return [
          { label:"Upper", isRest:false },{ label:"Lower", isRest:false },{ label:"Rest", isRest:true },
          { label:"Upper", isRest:false },{ label:"Lower", isRest:false },{ label:"Rest", isRest:true },
          { label:"Rest", isRest:true }
        ];},
        buildExerciseIndexMap(){ return ({
          0: [ // Upper (Mon)
            { type:"weightlifting", name:"Barbell Bench Press", plan:{ sets:4, reps:"6–8", restSec:120 } },
            { type:"weightlifting", name:"Barbell Bent Over Row", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Dumbbell Shoulder Press", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Lat Pulldown", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Barbell Curl", plan:{ sets:3, reps:"10–12", restSec:60 } },
            { type:"weightlifting", name:"Cable Tricep Pushdown", plan:{ sets:3, reps:"10–12", restSec:60 } }
          ],
          1: [ // Lower (Tue)
            { type:"weightlifting", name:"Back Squat", plan:{ sets:4, reps:"6–8", restSec:180 } },
            { type:"weightlifting", name:"Romanian Deadlift", plan:{ sets:3, reps:"8–10", restSec:120 } },
            { type:"weightlifting", name:"Leg Press", plan:{ sets:3, reps:"10", restSec:120 } },
            { type:"weightlifting", name:"Dumbbell Step-Up", plan:{ sets:3, reps:"10 each leg", restSec:90 } },
            { type:"weightlifting", name:"Seated Calf Raise", plan:{ sets:4, reps:"12–15", restSec:60 } }
          ],
          3: [ // Upper (Thu) — repeat
            { type:"weightlifting", name:"Barbell Bench Press", plan:{ sets:4, reps:"6–8", restSec:120 } },
            { type:"weightlifting", name:"Barbell Bent Over Row", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Dumbbell Shoulder Press", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Lat Pulldown", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Barbell Curl", plan:{ sets:3, reps:"10–12", restSec:60 } },
            { type:"weightlifting", name:"Cable Tricep Pushdown", plan:{ sets:3, reps:"10–12", restSec:60 } }
          ],
          4: [ // Lower (Fri) — repeat
            { type:"weightlifting", name:"Back Squat", plan:{ sets:4, reps:"6–8", restSec:180 } },
            { type:"weightlifting", name:"Romanian Deadlift", plan:{ sets:3, reps:"8–10", restSec:120 } },
            { type:"weightlifting", name:"Leg Press", plan:{ sets:3, reps:"10", restSec:120 } },
            { type:"weightlifting", name:"Dumbbell Step-Up", plan:{ sets:3, reps:"10 each leg", restSec:90 } },
            { type:"weightlifting", name:"Seated Calf Raise", plan:{ sets:4, reps:"12–15", restSec:60 } }
          ]
        });}
      },

      // 🏋️ Full Body (3 Days)
      { key:"full_body_3", name:"Full Body (3-day)", desc:"3 days • A/B/C • Wed + weekend rest",
        buildDays(){ return [
          { label:"Full Body A", isRest:false },{ label:"Rest", isRest:true },
          { label:"Full Body B", isRest:false },{ label:"Rest", isRest:true },
          { label:"Full Body C", isRest:false },{ label:"Rest", isRest:true },{ label:"Rest", isRest:true }
        ];},
        buildExerciseIndexMap(){ return ({
          0: [ // A (Mon)
            { type:"weightlifting", name:"Back Squat", plan:{ sets:4, reps:"5", restSec:180 } },
            { type:"weightlifting", name:"Barbell Bench Press", plan:{ sets:4, reps:"6–8", restSec:120 } },
            { type:"weightlifting", name:"Barbell Bent Over Row", plan:{ sets:3, reps:"8", restSec:90 } },
            { type:"weightlifting", name:"Dumbbell Lateral Raise", plan:{ sets:3, reps:"12–15", restSec:60 } },
            { type:"core", name:"Plank", plan:{ sets:3, reps:"30–45 sec", restSec:45 } }
          ],
          2: [ // B (Wed)
            { type:"weightlifting", name:"Barbell Deadlift", plan:{ sets:3, reps:"5", restSec:180 } },
            { type:"weightlifting", name:"Incline Dumbbell Press", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Lat Pulldown", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Walking Lunge", plan:{ sets:3, reps:"10 each leg", restSec:90 } },
            { type:"core", name:"Hanging Leg Raise", plan:{ sets:3, reps:"12", restSec:45 } }
          ],
          4: [ // C (Fri)
            { type:"weightlifting", name:"Front Squat", plan:{ sets:4, reps:"6", restSec:180 } },
            { type:"weightlifting", name:"Dumbbell Shoulder Press", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Cable Row", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Leg Curl", plan:{ sets:3, reps:"10–12", restSec:90 } },
            { type:"core", name:"Russian Twist", plan:{ sets:3, reps:"20 total", restSec:45 } }
          ]
        });}
      },

      // 🧱 Body Part Split (Classic Bro Split – 5 Days)
      { key:"body_part_split", name:"Body Part Split", desc:"Chest/Back/Legs/Shoulders/Arms • weekend rest",
        buildDays(){ return [
          { label:"Chest", isRest:false },{ label:"Back", isRest:false },{ label:"Legs", isRest:false },
          { label:"Shoulders", isRest:false },{ label:"Arms", isRest:false },
          { label:"Rest", isRest:true },{ label:"Rest", isRest:true }
        ];},
        buildExerciseIndexMap(){ return ({
          0: [ // Chest
            { type:"weightlifting", name:"Barbell Bench Press", plan:{ sets:4, reps:"6–8", restSec:120 } },
            { type:"weightlifting", name:"Incline Dumbbell Press", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Cable Chest Fly", plan:{ sets:3, reps:"12", restSec:60 } },
            { type:"weightlifting", name:"Pec Deck", plan:{ sets:3, reps:"12", restSec:60 } }
          ],
          1: [ // Back
            { type:"weightlifting", name:"Barbell Deadlift", plan:{ sets:3, reps:"5", restSec:180 } },
            { type:"weightlifting", name:"Lat Pulldown", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Barbell Bent Over Row", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Seated Row", plan:{ sets:3, reps:"10", restSec:90 } }
          ],
          2: [ // Legs
            { type:"weightlifting", name:"Back Squat", plan:{ sets:4, reps:"6–8", restSec:180 } },
            { type:"weightlifting", name:"Leg Press", plan:{ sets:3, reps:"10", restSec:120 } },
            { type:"weightlifting", name:"Romanian Deadlift", plan:{ sets:3, reps:"8–10", restSec:120 } },
            { type:"weightlifting", name:"Leg Curl", plan:{ sets:3, reps:"12", restSec:90 } },
            { type:"weightlifting", name:"Seated Calf Raise", plan:{ sets:4, reps:"15", restSec:60 } }
          ],
          3: [ // Shoulders
            { type:"weightlifting", name:"Barbell Overhead Press", plan:{ sets:4, reps:"6–8", restSec:120 } },
            { type:"weightlifting", name:"Arnold Press", plan:{ sets:3, reps:"8–10", restSec:90 } },
            { type:"weightlifting", name:"Dumbbell Lateral Raise", plan:{ sets:3, reps:"15", restSec:60 } },
            { type:"weightlifting", name:"Face Pull", plan:{ sets:3, reps:"15", restSec:60 } }
          ],
          4: [ // Arms
            { type:"weightlifting", name:"Barbell Curl", plan:{ sets:3, reps:"8–10", restSec:60 } },
            { type:"weightlifting", name:"Incline Dumbbell Curl", plan:{ sets:3, reps:"10–12", restSec:60 } },
            { type:"weightlifting", name:"Cable Tricep Pushdown", plan:{ sets:3, reps:"10–12", restSec:60 } },
            { type:"weightlifting", name:"Overhead Tricep Extension", plan:{ sets:3, reps:"10–12", restSec:60 } },
            { type:"weightlifting", name:"Hammer Curl", plan:{ sets:3, reps:"12", restSec:60 } }
          ]
        });}
      },

      { key:"blank", name:"Blank", desc:"Start from scratch (you’ll edit days + exercises)",
        buildDays(){ return [
          { label:"Day 1", isRest:false },{ label:"Day 2", isRest:false },{ label:"Day 3", isRest:false },
          { label:"Day 4", isRest:false },{ label:"Day 5", isRest:false },{ label:"Day 6", isRest:false },
          { label:"Day 7", isRest:false }
        ];}}
    ];

  function createRoutineFromTemplate(templateKey, routineName){
    const tpl = RoutineTemplates.find(t => t.key === templateKey);
    if(!tpl) throw new Error("Invalid template key");

    const state = getState();

    // Ensure library exists so we can resolve IDs by name
    try{ ExerciseLibrary.ensureSeeded(); }catch(e){ /* safe */ }

    const routineId = uid("rt");
    const days = tpl.buildDays().map((d, idx) => ({
      id: uid("day"),
      order: idx,
      label: d.label,
      isRest: !!d.isRest,
      exercises: []
    }));

    // Helper: resolve exercise by name in library (by type)
    function findLibItem(type, name){
      const arr = (state.exerciseLibrary?.[type] || []);
      const n = normName(name);
      return arr.find(x => normName(x.name) === n) || null;
    }

    // Seed exercises if provided by template
    if(typeof tpl.buildExerciseIndexMap === "function"){
      const map = tpl.buildExerciseIndexMap() || {};
      Object.keys(map).forEach(k => {
        const idx = Number(k);
        const day = days[idx];
        if(!day || day.isRest) return;

        const items = map[k] || [];
        day.exercises = items.map(item => {
          const libItem = findLibItem(item.type, item.name);
          return {
            id: uid("rx"),
            exerciseId: libItem?.id || null,
            type: item.type,
            nameSnap: libItem?.name || item.name,
            plan: item.plan || null,        // { sets, reps, restSec }
            notes: item.notes || ""
          };
        });
      });
    }

    return {
      id: routineId,
      name: routineName || tpl.name || "Routine",
      createdAt: Date.now(),
      days
    };
  }

  function repairExerciseLinks(){
    const state = getState();

    if(!state) return false;

    // Ensure structures exist
    state.routines = state.routines || [];
    state.logs = state.logs || { workouts: [], weight: [], protein: [] };
    state.logs.workouts = state.logs.workouts || [];

    let changed = false;

    function findLibByName(type, name){
      const n = normName(name || "");
      if(!n) return null;
      return (state.exerciseLibrary?.[type] || []).find(x => normName(x.name) === n) || null;
    }

    function findRoutineExercise(routineId, routineExerciseId){
      const r = (state.routines || []).find(rr => rr.id === routineId);
      if(!r) return null;
      for(const d of (r.days || [])){
        const rx = (d.exercises || []).find(e => e.id === routineExerciseId);
        if(rx) return rx;
      }
      return null;
    }

    // 1) Repair routine exercises: fill missing exerciseId from library using nameSnap
    for(const r of (state.routines || [])){
      for(const d of (r.days || [])){
        for(const rx of (d.exercises || [])){
          if(rx && !rx.exerciseId){
            const libItem = findLibByName(rx.type, rx.nameSnap);
            if(libItem){
              rx.exerciseId = libItem.id;
              rx.nameSnap = libItem.name; // keep snap aligned
              changed = true;
            }
          }
        }
      }
    }

    // 2) Repair workout logs: fill missing exerciseId by looking up the routineExercise
    for(const e of (state.logs.workouts || [])){
      if(e && !e.exerciseId){
        const rx = findRoutineExercise(e.routineId, e.routineExerciseId);
        if(rx?.exerciseId){
          e.exerciseId = rx.exerciseId;
          changed = true;
        }else if(rx?.nameSnap){
          const libItem = findLibByName(e.type, rx.nameSnap);
          if(libItem){
            e.exerciseId = libItem.id;
            changed = true;
          }
        }
      }
    }

    if(changed) Storage.save(state);
    return changed;
  }

  /********************
   * 4) Exercise Library Module (Step 3)
   ********************/
  const ExerciseLibrary = {
    typeKeys: ["weightlifting","cardio","core"],
    typeLabel(type){
      if(type === "weightlifting") return "Weightlifting";
      if(type === "cardio") return "Cardio";
      return "Core";
    },
    ensureSeeded(){
      const state = getState();
      // Only seed if ALL empty
      const lib = state.exerciseLibrary || (state.exerciseLibrary = { weightlifting:[], cardio:[], core:[] });
      const empty = (lib.weightlifting?.length||0) === 0 && (lib.cardio?.length||0) === 0 && (lib.core?.length||0) === 0;

      if(empty){
        // ===================================================
        // COPY-PASTE JSON LIBS (Weightlifting / Core / Cardio)
        // Format per item:
        // { id, type, name, equipment, primaryMuscle, secondaryMuscles, createdAt }
        // ===================================================

        lib.weightlifting = lib.weightlifting || [];
        lib.cardio = lib.cardio || [];
        lib.core = lib.core || [];

        if(empty){
          // ===================================================
// COPY-PASTE JSON LIBS (Weightlifting / Core / Cardio)
// Format per item:
// { id, type, name, equipment, primaryMuscle, secondaryMuscles, createdAt }
// ===================================================

lib.weightlifting = [
  // --- Barbell ---
  { id: uid("ex"), type:"weightlifting", name:"Barbell Bench Press", equipment:"Barbell", primaryMuscle:"Chest", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Incline Barbell Bench Press", equipment:"Barbell", primaryMuscle:"Chest", secondaryMuscles:["Shoulders"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Decline Barbell Bench Press", equipment:"Barbell", primaryMuscle:"Chest", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Close-Grip Bench Press", equipment:"Barbell", primaryMuscle:"Arms", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Floor Press", equipment:"Barbell", primaryMuscle:"Chest", secondaryMuscles:["Triceps"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Barbell Overhead Press", equipment:"Barbell", primaryMuscle:"Shoulders", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Upright Row", equipment:"Barbell", primaryMuscle:"Shoulders", secondaryMuscles:["Traps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Push Press", equipment:"Barbell", primaryMuscle:"Shoulders", secondaryMuscles:["Legs"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Landmine Press", equipment:"Barbell", primaryMuscle:"Shoulders", secondaryMuscles:["Chest"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Barbell Bent Over Row", equipment:"Barbell", primaryMuscle:"Back", secondaryMuscles:["Lats"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Pendlay Row", equipment:"Barbell", primaryMuscle:"Back", secondaryMuscles:["Lats"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Incline Row", equipment:"Barbell", primaryMuscle:"Back", secondaryMuscles:["Rear Delts"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Landmine Row", equipment:"Barbell", primaryMuscle:"Back", secondaryMuscles:["Lats"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Barbell Deadlift", equipment:"Barbell", primaryMuscle:"Full Body", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Rack Pull", equipment:"Barbell", primaryMuscle:"Back", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Romanian Deadlift", equipment:"Barbell", primaryMuscle:"Legs", secondaryMuscles:["Hamstrings"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Good Morning", equipment:"Barbell", primaryMuscle:"Legs", secondaryMuscles:["Hamstrings"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Sumo Deadlift", equipment:"Barbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Back Squat", equipment:"Barbell", primaryMuscle:"Legs", secondaryMuscles:["Quads"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Front Squat", equipment:"Barbell", primaryMuscle:"Legs", secondaryMuscles:["Quads"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Hack Squat", equipment:"Barbell", primaryMuscle:"Legs", secondaryMuscles:["Quads"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Lunge", equipment:"Barbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Reverse Lunge", equipment:"Barbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Hip Thrust", equipment:"Barbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Glute Bridge", equipment:"Barbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Calf Raise", equipment:"Barbell", primaryMuscle:"Legs", secondaryMuscles:["Calves"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Barbell Curl", equipment:"Barbell", primaryMuscle:"Arms", secondaryMuscles:["Biceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Reverse Curl", equipment:"Barbell", primaryMuscle:"Arms", secondaryMuscles:["Forearms"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Barbell Skull Crusher", equipment:"Barbell", primaryMuscle:"Arms", secondaryMuscles:["Triceps"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Barbell Thruster", equipment:"Barbell", primaryMuscle:"Full Body", secondaryMuscles:["Shoulders"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Power Clean", equipment:"Barbell", primaryMuscle:"Full Body", secondaryMuscles:["Legs"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Hang Clean", equipment:"Barbell", primaryMuscle:"Full Body", secondaryMuscles:["Legs"], createdAt:Date.now() },

  // --- Dumbbell ---
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Bench Press", equipment:"Dumbbell", primaryMuscle:"Chest", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Incline Dumbbell Press", equipment:"Dumbbell", primaryMuscle:"Chest", secondaryMuscles:["Shoulders"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Decline Dumbbell Press", equipment:"Dumbbell", primaryMuscle:"Chest", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Fly", equipment:"Dumbbell", primaryMuscle:"Chest", secondaryMuscles:["Chest"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Pullover", equipment:"Dumbbell", primaryMuscle:"Chest", secondaryMuscles:["Lats"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Floor Press", equipment:"Dumbbell", primaryMuscle:"Chest", secondaryMuscles:["Triceps"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Shoulder Press", equipment:"Dumbbell", primaryMuscle:"Shoulders", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Arnold Press", equipment:"Dumbbell", primaryMuscle:"Shoulders", secondaryMuscles:["Front Delts"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Lateral Raise", equipment:"Dumbbell", primaryMuscle:"Shoulders", secondaryMuscles:["Side Delts"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Front Raise", equipment:"Dumbbell", primaryMuscle:"Shoulders", secondaryMuscles:["Front Delts"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Rear Delt Fly", equipment:"Dumbbell", primaryMuscle:"Shoulders", secondaryMuscles:["Rear Delts"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Incline Lateral Raise", equipment:"Dumbbell", primaryMuscle:"Shoulders", secondaryMuscles:["Side Delts"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Z Press", equipment:"Dumbbell", primaryMuscle:"Shoulders", secondaryMuscles:["Core"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell High Pull", equipment:"Dumbbell", primaryMuscle:"Shoulders", secondaryMuscles:["Traps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Shrug", equipment:"Dumbbell", primaryMuscle:"Shoulders", secondaryMuscles:["Traps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Reverse Fly", equipment:"Dumbbell", primaryMuscle:"Shoulders", secondaryMuscles:["Rear Delts"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Single-Arm Dumbbell Row", equipment:"Dumbbell", primaryMuscle:"Back", secondaryMuscles:["Lats"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Chest Supported Row", equipment:"Dumbbell", primaryMuscle:"Back", secondaryMuscles:["Lats"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Goblet Squat", equipment:"Dumbbell", primaryMuscle:"Legs", secondaryMuscles:["Quads"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Lunge", equipment:"Dumbbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Walking Lunge", equipment:"Dumbbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Bulgarian Split Squat", equipment:"Dumbbell", primaryMuscle:"Legs", secondaryMuscles:["Quads"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Reverse Lunge", equipment:"Dumbbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Step-Up", equipment:"Dumbbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Romanian Deadlift", equipment:"Dumbbell", primaryMuscle:"Legs", secondaryMuscles:["Hamstrings"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Sumo Squat", equipment:"Dumbbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Hip Thrust", equipment:"Dumbbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Glute Bridge", equipment:"Dumbbell", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Calf Raise", equipment:"Dumbbell", primaryMuscle:"Legs", secondaryMuscles:["Calves"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Curl", equipment:"Dumbbell", primaryMuscle:"Arms", secondaryMuscles:["Biceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Incline Dumbbell Curl", equipment:"Dumbbell", primaryMuscle:"Arms", secondaryMuscles:["Biceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Hammer Curl", equipment:"Dumbbell", primaryMuscle:"Arms", secondaryMuscles:["Brachialis"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Concentration Curl", equipment:"Dumbbell", primaryMuscle:"Arms", secondaryMuscles:["Biceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Overhead Tricep Extension", equipment:"Dumbbell", primaryMuscle:"Arms", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Skull Crusher", equipment:"Dumbbell", primaryMuscle:"Arms", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Tricep Kickback", equipment:"Dumbbell", primaryMuscle:"Arms", secondaryMuscles:["Triceps"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Thruster", equipment:"Dumbbell", primaryMuscle:"Full Body", secondaryMuscles:["Shoulders"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Snatch", equipment:"Dumbbell", primaryMuscle:"Full Body", secondaryMuscles:["Shoulders"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Clean and Press", equipment:"Dumbbell", primaryMuscle:"Full Body", secondaryMuscles:["Shoulders"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Swings", equipment:"Dumbbell", primaryMuscle:"Full Body", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Farmers Carry", equipment:"Dumbbell", primaryMuscle:"Full Body", secondaryMuscles:["Forearms"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dumbbell Suitcase Carry", equipment:"Dumbbell", primaryMuscle:"Full Body", secondaryMuscles:["Obliques"], createdAt:Date.now() },

  // --- Machines ---
  { id: uid("ex"), type:"weightlifting", name:"Chest Press", equipment:"Machine", primaryMuscle:"Chest", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Pec Deck", equipment:"Machine", primaryMuscle:"Chest", secondaryMuscles:["Chest"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Machine Chest Fly", equipment:"Machine", primaryMuscle:"Chest", secondaryMuscles:["Chest"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Lat Pulldown", equipment:"Machine", primaryMuscle:"Back", secondaryMuscles:["Lats"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Seated Row", equipment:"Machine", primaryMuscle:"Back", secondaryMuscles:["Lats"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Assisted Pull-Up", equipment:"Machine", primaryMuscle:"Back", secondaryMuscles:["Lats"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Leg Press", equipment:"Machine", primaryMuscle:"Legs", secondaryMuscles:["Quads"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Hack Squat Machine", equipment:"Machine", primaryMuscle:"Legs", secondaryMuscles:["Quads"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Smith Machine Squat", equipment:"Smith Machine", primaryMuscle:"Legs", secondaryMuscles:["Quads"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Leg Extension", equipment:"Machine", primaryMuscle:"Legs", secondaryMuscles:["Quads"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Leg Curl", equipment:"Machine", primaryMuscle:"Legs", secondaryMuscles:["Hamstrings"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Hip Abduction Machine", equipment:"Machine", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Hip Adduction Machine", equipment:"Machine", primaryMuscle:"Legs", secondaryMuscles:["Adductors"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Seated Calf Raise", equipment:"Machine", primaryMuscle:"Legs", secondaryMuscles:["Calves"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Standing Calf Raise Machine", equipment:"Machine", primaryMuscle:"Legs", secondaryMuscles:["Calves"], createdAt:Date.now() },

  { id: uid("ex"), type:"weightlifting", name:"Machine Shoulder Press", equipment:"Machine", primaryMuscle:"Shoulders", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Machine Preacher Curl", equipment:"Machine", primaryMuscle:"Arms", secondaryMuscles:["Biceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Machine Tricep Dip", equipment:"Machine", primaryMuscle:"Arms", secondaryMuscles:["Triceps"], createdAt:Date.now() },

  // --- Cable (Weightlifting) ---
  { id: uid("ex"), type:"weightlifting", name:"Cable Chest Fly", equipment:"Cable", primaryMuscle:"Chest", secondaryMuscles:["Chest"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Cable Crossover", equipment:"Cable", primaryMuscle:"Chest", secondaryMuscles:["Chest"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Cable Row", equipment:"Cable", primaryMuscle:"Back", secondaryMuscles:["Lats"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Face Pull", equipment:"Cable", primaryMuscle:"Shoulders", secondaryMuscles:["Rear Delts"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Cable Lateral Raise", equipment:"Cable", primaryMuscle:"Shoulders", secondaryMuscles:["Side Delts"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Cable Front Raise", equipment:"Cable", primaryMuscle:"Shoulders", secondaryMuscles:["Front Delts"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Cable Reverse Fly", equipment:"Cable", primaryMuscle:"Shoulders", secondaryMuscles:["Rear Delts"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Cable Upright Row", equipment:"Cable", primaryMuscle:"Shoulders", secondaryMuscles:["Traps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Cable Tricep Pushdown", equipment:"Cable", primaryMuscle:"Arms", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Cable Overhead Tricep Extension", equipment:"Cable", primaryMuscle:"Arms", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Cable Bicep Curl", equipment:"Cable", primaryMuscle:"Arms", secondaryMuscles:["Biceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Cable Kickback", equipment:"Cable", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Cable Pull-Through", equipment:"Cable", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },

  // --- Bodyweight ---
  { id: uid("ex"), type:"weightlifting", name:"Push-Up", equipment:"Bodyweight", primaryMuscle:"Chest", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Pull-Up", equipment:"Bodyweight", primaryMuscle:"Back", secondaryMuscles:["Lats"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Chin-Up", equipment:"Bodyweight", primaryMuscle:"Back", secondaryMuscles:["Biceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Dips", equipment:"Bodyweight", primaryMuscle:"Chest", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Pike Push-Up", equipment:"Bodyweight", primaryMuscle:"Shoulders", secondaryMuscles:["Triceps"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Bodyweight Squat", equipment:"Bodyweight", primaryMuscle:"Legs", secondaryMuscles:["Quads"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Nordic Hamstring Curl", equipment:"Bodyweight", primaryMuscle:"Legs", secondaryMuscles:["Hamstrings"], createdAt:Date.now() },
  { id: uid("ex"), type:"weightlifting", name:"Glute Bridge", equipment:"Bodyweight", primaryMuscle:"Legs", secondaryMuscles:["Glutes"], createdAt:Date.now() },
];

lib.cardio = [
  { id: uid("ex"), type:"cardio", name:"Treadmill Run", equipment:"Treadmill", primaryMuscle:"Cardio", secondaryMuscles:["Legs"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Incline Walk", equipment:"Treadmill", primaryMuscle:"Cardio", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Sprint Intervals", equipment:"Track/Treadmill", primaryMuscle:"Cardio", secondaryMuscles:["Legs"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Outdoor Run", equipment:"Outdoor", primaryMuscle:"Cardio", secondaryMuscles:["Legs"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Stairmaster", equipment:"Machine", primaryMuscle:"Cardio", secondaryMuscles:["Glutes"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Stationary Bike", equipment:"Bike", primaryMuscle:"Cardio", secondaryMuscles:["Quads"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Assault Bike", equipment:"Bike", primaryMuscle:"Cardio", secondaryMuscles:["Full Body"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Row Machine", equipment:"Rower", primaryMuscle:"Cardio", secondaryMuscles:["Back"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Row Sprint", equipment:"Rower", primaryMuscle:"Cardio", secondaryMuscles:["Full Body"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Ski Erg", equipment:"Machine", primaryMuscle:"Cardio", secondaryMuscles:["Shoulders"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Elliptical", equipment:"Machine", primaryMuscle:"Cardio", secondaryMuscles:["Legs"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Battle Ropes", equipment:"Ropes", primaryMuscle:"Cardio", secondaryMuscles:["Shoulders"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Sled Push", equipment:"Sled", primaryMuscle:"Cardio", secondaryMuscles:["Legs"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Sled Pull", equipment:"Sled", primaryMuscle:"Cardio", secondaryMuscles:["Back"], createdAt:Date.now() },
  { id: uid("ex"), type:"cardio", name:"Jump Rope", equipment:"Rope", primaryMuscle:"Cardio", secondaryMuscles:["Calves"], createdAt:Date.now() },
];

lib.core = [
  { id: uid("ex"), type:"core", name:"Plank", equipment:"Bodyweight", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Side Plank", equipment:"Bodyweight", primaryMuscle:"Core", secondaryMuscles:["Obliques"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Weighted Sit-Up", equipment:"Plate", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Russian Twist", equipment:"Plate/Dumbbell", primaryMuscle:"Core", secondaryMuscles:["Obliques"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Dumbbell Side Bend", equipment:"Dumbbell", primaryMuscle:"Core", secondaryMuscles:["Obliques"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Renegade Row", equipment:"Dumbbell", primaryMuscle:"Core", secondaryMuscles:["Lats"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Plank Pull-Through", equipment:"Dumbbell", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Hanging Leg Raise", equipment:"Bar", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Hanging Knee Raise", equipment:"Bar", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Weighted Leg Raise", equipment:"Plate", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Bicycle Crunch", equipment:"Bodyweight", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Decline Sit-Up", equipment:"Bench", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Ab Wheel Rollout", equipment:"Ab Wheel", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Stability Ball Crunch", equipment:"Stability Ball", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Stability Ball Rollout", equipment:"Stability Ball", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Barbell Rollout", equipment:"Barbell", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Barbell Overhead Hold", equipment:"Barbell", primaryMuscle:"Core", secondaryMuscles:["Shoulders"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Landmine Rotation", equipment:"Barbell", primaryMuscle:"Core", secondaryMuscles:["Obliques"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"V-Up", equipment:"Bodyweight", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Hollow Body Hold", equipment:"Bodyweight", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Dragon Flag", equipment:"Bench", primaryMuscle:"Core", secondaryMuscles:["Abs"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Medicine Ball Slam", equipment:"Medicine Ball", primaryMuscle:"Core", secondaryMuscles:["Full Body"], createdAt:Date.now() },
  { id: uid("ex"), type:"core", name:"Medicine Ball Russian Twist", equipment:"Medicine Ball", primaryMuscle:"Core", secondaryMuscles:["Obliques"], createdAt:Date.now() },
];

        }

        // Always attempt to repair links (covers older data / edge cases)
        const repaired = repairExerciseLinks();

      // Save if we seeded OR repaired anything
      if(empty || repaired) Storage.save(state);
    },

    list(type){
      const state = getState();
      return (state.exerciseLibrary?.[type] || []);
    },

    get(type, id){
      const state = getState();
      return (state.exerciseLibrary?.[type] || []).find(x => x.id === id) || null;
    },

    // Category-only check (kept for UI filters, but add/update will enforce GLOBAL)
    existsByName(type, name, excludeId=null){
      const n = normName(name);
      return this.list(type).some(x => normName(x.name) === n && x.id !== excludeId);
    },

    add(type, item){
      const state = getState();
      const arr = (state.exerciseLibrary?.[type] || (state.exerciseLibrary[type] = []));
      // Global dedupe across ALL categories
      const n = normName(item?.name);
      const global = this.typeKeys.some(t => (state.exerciseLibrary?.[t]||[]).some(x => normName(x.name) === n));
      if(global) throw new Error("Exercise already exists in your library.");

      arr.push({ ...item, id: item.id || uid("ex"), type, createdAt: item.createdAt || Date.now() });
      Storage.save(state);
      return arr[arr.length - 1];
    },

    update(type, id, patch){
      const state = getState();
      const arr = (state.exerciseLibrary?.[type] || (state.exerciseLibrary[type] = []));
      const idx = arr.findIndex(x => x.id === id);
      if(idx < 0) return null;

      // If name changes, enforce global dedupe
      const nextName = ("name" in (patch||{})) ? patch.name : arr[idx].name;
      const n = normName(nextName);
      const global = this.typeKeys.some(t => (state.exerciseLibrary?.[t]||[]).some(x => normName(x.name) === n && x.id !== id));
      if(global) throw new Error("Exercise already exists in your library.");

      const nextPatch = { ...patch };
      if("name" in nextPatch) nextPatch.name = String(nextPatch.name || "").trim().replace(/\s+/g, " ");

      arr[idx] = { ...arr[idx], ...nextPatch };
      Storage.save(state);
      return arr[idx];
    },

    remove(type, id){
      const state = getState();
      const arr = (state.exerciseLibrary?.[type] || (state.exerciseLibrary[type] = []));
      const idx = arr.findIndex(x => x.id === id);
      if(idx < 0) return;
      arr.splice(idx, 1);
      Storage.save(state);
    }
  };

  return {
    ExerciseLibrary,
    RoutineTemplates,
    createRoutineFromTemplate,
    repairExerciseLinks,
    normName
  };
}
