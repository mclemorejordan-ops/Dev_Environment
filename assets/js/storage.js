/* ===========================
   Global Storage Keys
   (Single source of truth)
=========================== */
(function () {
  // Core
  window.KEY_PROFILE        = "gym_profile_v1";
  window.KEY_ROUTINES       = "gym_routines_v1";

  // IMPORTANT: These MUST match what the app is already using
  // (currently defined in dom.js and referenced throughout app.js)
  window.KEY_ACTIVE_ROUTINE = "gym_active_routine_id_v1";
  window.KEY_ACTIVE_SCREEN  = "gym_active_screen_v1";

  // Logs
  window.KEY_BW    = "gym_bw_logs_v1";
  window.KEY_ATT   = "gym_attendance_v1";
  window.KEY_PRO   = "gym_protein_v1";
  window.KEY_LIFTS = "gym_lifts_v1";

  // Targets / custom exercises / version
  window.KEY_TARGETS     = "gym_targets_v1";
  window.KEY_CUSTOM_EX   = "gym_custom_ex_v1";
  window.KEY_APP_VERSION = "gym_app_version_v1";

  // Backups / onboarding
  window.KEY_LAST_BACKUP  = "gym_last_backup_v1";
  window.KEY_ONBOARD_DONE = "gym_onboard_done_v1";

    /* ---------------------------
     Lock KEY_* constants (SAFE MODE)
     - Prevent accidental reassignment later
     - Avoid Safari/window issues by NOT setting configurable:false
  ---------------------------- */
  (function lockKeys(){
    const keysToLock = [
      "KEY_PROFILE",
      "KEY_ROUTINES",
      "KEY_ACTIVE_ROUTINE",
      "KEY_ACTIVE_SCREEN",
      "KEY_BW",
      "KEY_ATT",
      "KEY_PRO",
      "KEY_LIFTS",
      "KEY_TARGETS",
      "KEY_CUSTOM_EX",
      "KEY_APP_VERSION",
      "KEY_LAST_BACKUP",
      "KEY_ONBOARD_DONE"
    ];

    keysToLock.forEach((k)=>{
      try{
        if (!(k in window)) return;

        // Only lock if it's currently writable (avoid redefine issues)
        const d = Object.getOwnPropertyDescriptor(window, k);
        if (d && d.writable === false) return;

        Object.defineProperty(window, k, {
          value: window[k],
          writable: false,
          enumerable: true
          // NOTE: we intentionally do NOT set configurable:false
        });
      }catch(e){
        console.warn("Could not lock key:", k, e);
      }
    });
  })();

  // LocalStorage helper
  window.LS = window.LS || {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    }
  };
})();
