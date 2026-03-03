/********************
 * State + Schema (Module)
 * - Zero data loss tolerance
 * - All loaded state must pass migrateState(saved)
 ********************/

// ─────────────────────────────
// Storage + Versioning constants
// ─────────────────────────────
export const STORAGE_KEY = "gymdash:v1";

// version.json is the single source of truth for version display + release notes
export const REMOTE_VERSION_URL = "./version.json";

// ─────────────────────────────
// Schema versioning (production hardening)
// ─────────────────────────────
export const SCHEMA_VERSION = 1;

// Version metadata only (does NOT affect user profile/state)
export const VERSION_LATEST_KEY   = "gymdash:latestVersion";     // last fetched version.json value
export const VERSION_APPLIED_KEY  = "gymdash:appliedVersion";    // last version applied on this device
export const VERSION_NOTES_KEY    = "gymdash:latestNotes";       // JSON stringified array of notes
export const VERSION_BUILD_KEY    = "gymdash:latestBuildDate";   // optional build date string

// Default state factory (must be stable; do not rename containers)
export const DefaultState = () => ({
  schemaVersion: 1,
  createdAt: Date.now(),
  profile: null,
  routines: [],
  activeRoutineId: null,
  exerciseLibrary: {
    weightlifting: [],
    cardio: [],
    core: []
  },
  logs: {
    workouts: [],
    weight: [],
    protein: []
  },
  attendance: []
});

// Migrate/repair any saved state into the latest schema safely.
// - Always merges into DefaultState() so new keys are never missing.
// - Ensures critical containers are the right types.
// - Lets you add future migrations without breaking old users.
export function migrateState(saved){
  const base = DefaultState();

  // If it's not a plain object, return defaults
  if(!saved || typeof saved !== "object") return base;

  // Merge onto defaults (so newly-added keys appear automatically)
  const merged = Object.assign(base, saved);

  // Normalize version
  const v = (typeof merged.schemaVersion === "number") ? merged.schemaVersion : 0;

  // Future migrations go here:
  // if(v < 1){ ... set defaults/transform old fields ... }

  // ✅ Hard guards for containers (prevents runtime crashes)
  if(!Array.isArray(merged.routines)) merged.routines = [];
  if(typeof merged.exerciseLibrary !== "object" || !merged.exerciseLibrary) merged.exerciseLibrary = { weightlifting:[], cardio:[], core:[] };
  if(!Array.isArray(merged.exerciseLibrary.weightlifting)) merged.exerciseLibrary.weightlifting = [];
  if(!Array.isArray(merged.exerciseLibrary.cardio)) merged.exerciseLibrary.cardio = [];
  if(!Array.isArray(merged.exerciseLibrary.core)) merged.exerciseLibrary.core = [];
  if(typeof merged.logs !== "object" || !merged.logs) merged.logs = { workouts:[], weight:[], protein:[] };
  if(!Array.isArray(merged.logs.workouts)) merged.logs.workouts = [];
  if(!Array.isArray(merged.logs.weight)) merged.logs.weight = [];
  if(!Array.isArray(merged.logs.protein)) merged.logs.protein = [];
  if(!Array.isArray(merged.attendance)) merged.attendance = [];


      // ✅ Goals (additive + safe)
  if(merged.profile && typeof merged.profile === "object"){
    if(!merged.profile.goals || typeof merged.profile.goals !== "object"){
      merged.profile.goals = {};
    }

    // Weekly sessions target (default 4)
    if(!Number.isFinite(merged.profile.goals.weeklySessionsTarget)){
      merged.profile.goals.weeklySessionsTarget = 4;
    }

    // Target weight (nullable)
    if(merged.profile.goals.targetWeight === undefined){
      merged.profile.goals.targetWeight = null;
    }
    if(merged.profile.goals.targetWeight !== null && !Number.isFinite(Number(merged.profile.goals.targetWeight))){
      merged.profile.goals.targetWeight = null;
    }

    // ✅ Goal items list (new, additive)
    if(!Array.isArray(merged.profile.goals.items)){
      merged.profile.goals.items = [];
    }
  }
  
  
  // Always stamp latest schema
  merged.schemaVersion = SCHEMA_VERSION;

  return merged;
}
