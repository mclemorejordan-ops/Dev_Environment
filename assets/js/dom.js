/* ---------------------------
   DOM helpers
---------------------------- */
const $  = (id)=>document.getElementById(id);
const $$ = (sel, root=document)=>[...root.querySelectorAll(sel)];

/* ---------------------------
   Storage Keys / Constants
   (Aliases to storage.js)
---------------------------- */
const KEY_BW           = window.KEY_BW;
const KEY_ATT          = window.KEY_ATT;
const KEY_PRO          = window.KEY_PRO;
const KEY_LIFTS        = window.KEY_LIFTS;
const KEY_TARGETS      = window.KEY_TARGETS;

const KEY_ROUTINES     = window.KEY_ROUTINES;
const KEY_ACTIVE_ROUTINE = window.KEY_ACTIVE_ROUTINE;
const KEY_PROFILE      = window.KEY_PROFILE;
const KEY_LAST_BACKUP  = window.KEY_LAST_BACKUP;
const KEY_ONBOARD_DONE = window.KEY_ONBOARD_DONE;
const KEY_CUSTOM_EX    = window.KEY_CUSTOM_EX;
const KEY_APP_VERSION  = window.KEY_APP_VERSION;
