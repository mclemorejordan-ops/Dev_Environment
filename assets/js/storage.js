/* ===========================
   Global Storage Keys
=========================== */
(function () {
  window.KEY_PROFILE        = "gym_profile_v1";
  window.KEY_ROUTINES       = "gym_routines_v1";
  window.KEY_ACTIVE_ROUTINE = "gym_active_routine_v1";
  window.KEY_ACTIVE_SCREEN  = "gym_active_screen_v1";

  window.KEY_BW    = "gym_bw_v1";
  window.KEY_ATT   = "gym_attendance_v1";
  window.KEY_PRO   = "gym_protein_v1";
  window.KEY_LIFTS = "gym_lifts_v1";

  window.KEY_LAST_BACKUP  = "gym_last_backup_v1";
  window.KEY_ONBOARD_DONE = "gym_onboard_done_v1";

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
