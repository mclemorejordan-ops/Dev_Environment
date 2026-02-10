/* ===========================
   Global Storage Keys + LS Helper
   (Fail-open bootstrap)
=========================== */

(function () {
  "use strict";

  // 1) ALWAYS define LS first (so the app can boot even if later code fails)
  if (!window.LS) {
    window.LS = {
      get(key, fallback) {
        try {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : fallback;
        } catch {
          return fallback;
        }
      },
      set(key, value) {
        try {
          localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
          console.warn("LS.set failed:", key, e);
        }
      },
      setIfChanged(key, value) {
        this.set(key, value);
      }
    };
  }

  try {
    // 2) Keys (single source of truth)
    window.KEY_PROFILE        = "gym_profile_v1";
    window.KEY_ROUTINES       = "gym_routines_v1";

    window.KEY_ACTIVE_ROUTINE = "gym_active_routine_id_v1";
    window.KEY_ACTIVE_SCREEN  = "gym_active_screen_v1";

    window.KEY_BW    = "gym_bw_logs_v1";
    window.KEY_ATT   = "gym_attendance_v1";
    window.KEY_PRO   = "gym_protein_v1";
    window.KEY_LIFTS = "gym_lifts_v1";

    window.KEY_TARGETS     = "gym_targets_v1";
    window.KEY_CUSTOM_EX   = "gym_custom_ex_v1";
    window.KEY_APP_VERSION = "gym_app_version_v1";

    window.KEY_LAST_BACKUP  = "gym_last_backup_v1";
    window.KEY_ONBOARD_DONE = "gym_onboard_done_v1";

    // 3) Upgrade LS.set to "write only if changed" (safe)
    const baseSet = window.LS.set.bind(window.LS);
    window.LS.set = function (key, value) {
      try {
        const next = JSON.stringify(value);
        const prev = localStorage.getItem(key);
        if (prev === next) return;
        localStorage.setItem(key, next);
      } catch (e) {
        // fallback to basic set (still safe)
        baseSet(key, value);
      }
    };
    window.LS.setIfChanged = function (key, value) {
      window.LS.set(key, value);
    };

    // 4) Lock keys (SAFE MODE — cannot crash)
    (function lockKeys() {
      try {
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

        keysToLock.forEach((k) => {
          try {
            if (!(k in window)) return;
            const d = Object.getOwnPropertyDescriptor(window, k);
            if (d && d.writable === false) return;

            Object.defineProperty(window, k, {
              value: window[k],
              writable: false,
              enumerable: true
              // intentionally NOT configurable:false (Safari-safe)
            });
          } catch (e) {
            console.warn("Could not lock key:", k, e);
          }
        });
      } catch (e) {
        console.warn("lockKeys skipped:", e);
      }
    })();

  } catch (e) {
    // If anything above fails, the app still boots because LS exists
    console.error("storage.js bootstrap error:", e);
  }
})();
