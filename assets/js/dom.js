/* ---------------------------
   DOM helpers
---------------------------- */
const $  = (id)=>document.getElementById(id);
const $$ = (sel, root=document)=>[...root.querySelectorAll(sel)];

/* ---------------------------
   Storage Keys / Constants
---------------------------- */
const KEY_BW = "gym_bw_logs_v1";
const KEY_ATT = "gym_attendance_v1";
const KEY_PRO = "gym_protein_v1";
const KEY_LIFTS = "gym_lifts_v1";
const KEY_TARGETS = "gym_targets_v1";

const KEY_ROUTINES = "gym_routines_v1";
const KEY_ACTIVE_ROUTINE = "gym_active_routine_id_v1";
const KEY_PROFILE = "gym_profile_v1";
const KEY_LAST_BACKUP = "gym_last_backup_v1";
const KEY_ONBOARD_DONE = "gym_onboard_done_v1";
const KEY_CUSTOM_EX = "gym_custom_ex_v1";
const KEY_APP_VERSION = "gym_app_version_v1";
