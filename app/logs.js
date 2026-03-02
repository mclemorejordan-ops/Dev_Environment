/********************
 * Logs helpers (extracted from app.js)
 * Protein CRUD helpers only (no DOM)
 ********************/

export function initLogs({ getState, Storage, uid }){
  if(typeof getState !== "function") throw new Error("initLogs requires getState()");
  if(!Storage) throw new Error("initLogs requires Storage");
  if(typeof uid !== "function") throw new Error("initLogs requires uid()");

  function ensureLogsContainers(){
    const state = getState();
    state.logs = state.logs || { workouts: [], weight: [], protein: [] };
    state.logs.workouts = state.logs.workouts || [];
    state.logs.weight   = state.logs.weight   || [];
    state.logs.protein  = state.logs.protein  || [];
    return state;
  }

  // ✅ Read-only lookup (never creates/saves)
  function findProteinEntry(dateISO){
    const state = ensureLogsContainers();
    return state.logs.protein.find(x => x.dateISO === dateISO) || null;
  }

  // ✅ Write-path helper (creates ONLY when we truly need to save something)
  function ensureProteinEntry(dateISO){
    const state = ensureLogsContainers();
    let entry = state.logs.protein.find(x => x.dateISO === dateISO);
    if(!entry){
      entry = { dateISO, meals: [] }; // meals: [{ id, label, grams }]
      state.logs.protein.push(entry);
      Storage.save(state);
    }
    return entry;
  }

  // ✅ If an entry has no meals, remove the entire day so it doesn't appear in history
  function cleanupProteinEntryIfEmpty(dateISO){
    const state = ensureLogsContainers();
    const idx = state.logs.protein.findIndex(x => x.dateISO === dateISO);
    if(idx < 0) return;

    const entry = state.logs.protein[idx];
    const meals = Array.isArray(entry?.meals) ? entry.meals : [];
    if(meals.length === 0){
      state.logs.protein.splice(idx, 1);
      Storage.save(state);
    }
  }

  // ⚠️ Keep for compatibility (but this DOES create). Use only for write paths.
  function getProteinForDate(dateISO){
    return ensureProteinEntry(dateISO);
  }

  // Save/update a meal:
  // - If grams <= 0 → treat as "no log" and delete meal if it exists
  // - If grams > 0 → create the day entry if missing and save
  //
  // ✅ Backward-compatible overload:
  //   upsertMeal(dateISO, { id, label, grams })
  //   upsertMeal(dateISO, mealId, label, grams)
  function upsertMeal(dateISO, mealIdOrObj, label, grams){
    const state = ensureLogsContainers();

    // Support object signature used by protein-ui.js
    let mealId = mealIdOrObj;
    let mealLabel = label;
    let mealGrams = grams;

    if(mealIdOrObj && typeof mealIdOrObj === "object"){
      mealId = mealIdOrObj.id;
      mealLabel = mealIdOrObj.label;
      mealGrams = mealIdOrObj.grams;
    }

    const cleanGrams = Math.max(0, Math.round(Number(mealGrams) || 0));

    if(cleanGrams <= 0){
      // delete path (do NOT create the day)
      const entry = findProteinEntry(dateISO);
      if(!entry) return;

      entry.meals = Array.isArray(entry.meals) ? entry.meals : [];
      const before = entry.meals.length;

      // If we have an id, delete by id (safe + precise)
      if(mealId != null){
        entry.meals = entry.meals.filter(m => m && m.id !== mealId);
      }

      if(entry.meals.length !== before){
        Storage.save(state);
        cleanupProteinEntryIfEmpty(dateISO);
      }
      return;
    }

    const entry = ensureProteinEntry(dateISO);
    entry.meals = Array.isArray(entry.meals) ? entry.meals : [];

    const id = mealId || uid("meal");
    const idx = entry.meals.findIndex(m => m && m.id === id);

    const next = {
      id,
      label: String(mealLabel || "").trim(),
      grams: cleanGrams
    };

    if(idx >= 0) entry.meals[idx] = { ...entry.meals[idx], ...next };
    else entry.meals.push(next);

    Storage.save(state);
  }

  return {
    protein: {
      findProteinEntry,
      ensureProteinEntry,
      cleanupProteinEntryIfEmpty,
      getProteinForDate,
      upsertMeal
    }
  };
}
