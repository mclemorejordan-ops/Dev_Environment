/********************
 * workouts.js — extracted from app.js (Phase 2.8)
 * - LogEngine (workout log + PRs)
 * - removeWorkoutEntryById helper
 *
 * State safety: does NOT rename containers.
 ********************/

export function initWorkouts({ getState, Storage, Social }){
  function round2(n){
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  const LogEngine = {
    ensure(){
      const state = getState();
      state.logs = state.logs || { workouts: [], weight: [], protein: [] };
      state.logs.workouts = state.logs.workouts || [];
    },

    addEntry(entry){
      const state = getState();
      this.ensure();
      state.logs.workouts.push(entry);
      Storage.save(state);

      // Social (optional): publish a compact activity event
      try{
        Social && typeof Social.publishLogEvent === "function" && Social.publishLogEvent(entry);
      }catch(_){}
    },

    entriesForExercise(type, exerciseId){
      const state = getState();
      this.ensure();
      return state.logs.workouts
        .filter(e => e.type === type && e.exerciseId === exerciseId)
        .sort((a,b) => (b.dateISO || "").localeCompare(a.dateISO || "") || (b.createdAt||0)-(a.createdAt||0));
    },

    lifetimeBests(type, exerciseId){
      const entries = this.entriesForExercise(type, exerciseId);
      const bests = {
        bestWeight: null,
        best1RM: null,
        bestVolume: null,
        bestPace: null
      };

      for(const e of entries){
        if(e?.summary){
          if(type === "weightlifting"){
            if(Number.isFinite(e.summary.bestWeight)) bests.bestWeight = Math.max(bests.bestWeight ?? -Infinity, e.summary.bestWeight);
            if(Number.isFinite(e.summary.best1RM)) bests.best1RM = Math.max(bests.best1RM ?? -Infinity, e.summary.best1RM);
            if(Number.isFinite(e.summary.totalVolume)) bests.bestVolume = Math.max(bests.bestVolume ?? -Infinity, e.summary.totalVolume);
          } else if(type === "cardio"){
            if(Number.isFinite(e.summary.paceSecPerUnit)){
              bests.bestPace = Math.min(bests.bestPace ?? Infinity, e.summary.paceSecPerUnit);
            }
          } else if(type === "core"){
            if(Number.isFinite(e.summary.totalVolume)) bests.bestVolume = Math.max(bests.bestVolume ?? -Infinity, e.summary.totalVolume);
          }
        }
      }

      if(bests.bestWeight === -Infinity) bests.bestWeight = null;
      if(bests.best1RM === -Infinity) bests.best1RM = null;
      if(bests.bestVolume === -Infinity) bests.bestVolume = null;
      if(bests.bestPace === Infinity) bests.bestPace = null;

      return bests;
    },

    computeWeightliftingSummary(sets){
      const cleanSets = (sets || []).map(s => ({
        weight: Number(s.weight) || 0,
        reps: Math.max(0, Math.floor(Number(s.reps) || 0))
      }));

      let totalVolume = 0;
      let bestWeight = 0;
      let best1RM = 0;

      for(const s of cleanSets){
        totalVolume += (s.weight * s.reps);
        bestWeight = Math.max(bestWeight, s.weight);
        const epley = (s.reps > 0) ? (s.weight * (1 + (s.reps / 30))) : 0;
        best1RM = Math.max(best1RM, epley);
      }

      return {
        totalVolume: round2(totalVolume),
        bestWeight: round2(bestWeight),
        best1RM: round2(best1RM)
      };
    },

    computeCardioSummary(sets){
      const clean = (sets || []).map(s => ({
        timeSec: Math.max(0, Math.floor(Number(s.timeSec) || 0)),
        distance: Number(s.distance) || 0,
        incline: Number.isFinite(Number(s.incline)) ? Number(s.incline) : null
      }));

      const s = clean[0] || { timeSec:0, distance:0, incline:null };
      const pace = (s.distance > 0) ? (s.timeSec / s.distance) : null;

      return {
        timeSec: s.timeSec,
        distance: round2(s.distance),
        incline: s.incline,
        paceSecPerUnit: (pace === null) ? null : round2(pace)
      };
    },

    computeCoreSummary(sets){
      const clean = (sets || []).map(s => ({
        sets: Math.max(0, Math.floor(Number(s.sets) || 0)),
        reps: Math.max(0, Math.floor(Number(s.reps) || 0)),
        timeSec: Math.max(0, Math.floor(Number(s.timeSec) || 0)),
        weight: Number(s.weight) || 0
      }));

      let totalVolume = 0;
      for(const s of clean){
        if(s.reps > 0){
          const w = (s.weight > 0) ? s.weight : 1;
          totalVolume += (s.reps * s.sets * w);
        }else{
          totalVolume += s.timeSec;
        }
      }

      return { totalVolume: round2(totalVolume) };
    },

    computePRFlags(type, exerciseId, summary){
      const prev = this.lifetimeBests(type, exerciseId);

      const pr = {
        isPRWeight: false,
        isPR1RM: false,
        isPRVolume: false,
        isPRPace: false
      };

      if(type === "weightlifting"){
        if(Number.isFinite(summary.bestWeight)){
          pr.isPRWeight = (prev.bestWeight === null) ? (summary.bestWeight > 0) : (summary.bestWeight > prev.bestWeight);
        }
        if(Number.isFinite(summary.best1RM)){
          pr.isPR1RM = (prev.best1RM === null) ? (summary.best1RM > 0) : (summary.best1RM > prev.best1RM);
        }
        if(Number.isFinite(summary.totalVolume)){
          pr.isPRVolume = (prev.bestVolume === null) ? (summary.totalVolume > 0) : (summary.totalVolume > prev.bestVolume);
        }
      } else if(type === "cardio"){
        if(summary.paceSecPerUnit !== null && Number.isFinite(summary.paceSecPerUnit)){
          pr.isPRPace = (prev.bestPace === null) ? (summary.paceSecPerUnit > 0) : (summary.paceSecPerUnit < prev.bestPace);
        }
      } else if(type === "core"){
        if(Number.isFinite(summary.totalVolume)){
          pr.isPRVolume = (prev.bestVolume === null) ? (summary.totalVolume > 0) : (summary.totalVolume > prev.bestVolume);
        }
      }

      return pr;
    }
  };

  // used by Progress → History delete button
  function removeWorkoutEntryById(entryId){
    const state = getState();
    LogEngine.ensure();
    const id = String(entryId || "");
    const before = (state.logs.workouts || []).length;

    state.logs.workouts = (state.logs.workouts || []).filter(e => String(e.id || "") !== id);

    Storage.save(state);
    return (state.logs.workouts || []).length !== before;
  }

  return { LogEngine, removeWorkoutEntryById };
}
