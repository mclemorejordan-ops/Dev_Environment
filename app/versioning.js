/********************
 * Version + Sync Pills (Service Worker powered updates)
 * - vX pill comes ONLY from version.json
 * - Release notes are read from version.json
 * - "Update Available" is TRUE when a new Service Worker is waiting
 * - "Downloading…" shows while the Service Worker is installing
 * - Reload to update activates waiting SW and reloads WITHOUT clearing localStorage
 ********************/

import {
  REMOTE_VERSION_URL,
  VERSION_LATEST_KEY,
  VERSION_APPLIED_KEY,
  VERSION_NOTES_KEY,
  VERSION_BUILD_KEY
} from "./state.js";

import { Storage } from "./storage.js";
import { $, el, Modal, showToast } from "./ui.js";

// ─────────────────────────────
// Internal state (persisted metadata)
// ─────────────────────────────
let __latestVersion  = (localStorage.getItem(VERSION_LATEST_KEY)  || "").trim() || null;
let __appliedVersion = (localStorage.getItem(VERSION_APPLIED_KEY) || "").trim() || null;

let __latestNotes = (() => {
  try { return JSON.parse(localStorage.getItem(VERSION_NOTES_KEY) || "[]"); }
  catch(e){ return []; }
})();

let __latestBuildDate = (localStorage.getItem(VERSION_BUILD_KEY) || "").trim() || null;

// ─────────────────────────────
// Service worker state
// ─────────────────────────────
let __swReg = null;
let __swUrlRegistered = "";
let __swUpdateReady = false;
let __swInstalling = false;

// Let app.js provide a live state reference (so we can flush safely)
let __getStateRef = () => null;
export function initVersioning({ getStateRef } = {}){
  if(typeof getStateRef === "function") __getStateRef = getStateRef;
}

export function __hasSwUpdateWaiting(){
  return !!(__swReg && __swReg.waiting) || __swUpdateReady;
}

export function setHeaderPills(){
  const syncPill = $("#syncPill");
  const verPill  = $("#verPill");
  if(!syncPill || !verPill) return;

  // Version pill comes ONLY from version.json (fallback to applied/offline)
  const shown = __latestVersion || __appliedVersion || "—";
  verPill.textContent = `v${shown}`;

  // Connectivity
  if(!navigator.onLine){
    syncPill.textContent = "Offline";
    syncPill.classList.remove("ok","warn");
    syncPill.classList.add("off");
    return;
  }

  // Downloading/Installing state (SW is fetching the new build)
  if(__swInstalling){
    syncPill.textContent = "Downloading…";
    syncPill.classList.remove("ok","off");
    syncPill.classList.add("warn");
    return;
  }

  // Update ready-to-apply state
  if(__hasSwUpdateWaiting()){
    syncPill.textContent = "Update Available";
    syncPill.classList.remove("ok","off");
    syncPill.classList.add("warn");
  }else{
    syncPill.textContent = "Synced";
    syncPill.classList.remove("warn","off");
    syncPill.classList.add("ok");
  }
}

// ─────────────────────────────
// Phase 2.1: rate-limit update checks
// ─────────────────────────────
const UPDATE_CHECK_COOLDOWN_MS = 30_000; // 30s
let __updateCheckInFlight = null;
let __lastUpdateCheckAt = 0;
let __lastUpdateResult = null;

export async function checkForUpdates(opts = {}){
  const force = !!opts.force;

  // Fetch version.json (single source of truth for version + notes)
  if(!navigator.onLine){
    setHeaderPills();
    __lastUpdateResult = { ok:false, reason:"offline" };
    return __lastUpdateResult;
  }

  // If a check is already in flight, reuse it (prevents duplicate fetches)
  if(__updateCheckInFlight) return __updateCheckInFlight;

  // Cooldown gate (skip repeated checks unless forced)
  const now = Date.now();
  if(!force && __lastUpdateResult && (now - __lastUpdateCheckAt) < UPDATE_CHECK_COOLDOWN_MS){
    setHeaderPills();
    return { ...__lastUpdateResult, throttled:true };
  }

  __lastUpdateCheckAt = now;

  __updateCheckInFlight = (async () => {
    try{
      const url = `${REMOTE_VERSION_URL}?t=${Date.now()}`;
      const res = await fetch(url, { cache: "no-store" });
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const latest = String(data?.version || "").trim() || null;
      const notesRaw = Array.isArray(data?.notes) ? data.notes : [];
      const notes = notesRaw
        .map(x => String(x || "").trim())
        .filter(Boolean)
        .slice(0, 12); // keep it tight in UI

      const buildDate = String(data?.buildDate || data?.build || data?.date || "").trim() || null;

      const prevLatest = __latestVersion;

      if(latest){
        __latestVersion = latest;
        localStorage.setItem(VERSION_LATEST_KEY, latest);

        // First run: initialize applied version so modal has a baseline
        if(!__appliedVersion){
          __appliedVersion = latest;
          localStorage.setItem(VERSION_APPLIED_KEY, latest);
        }
      }

      // ✅ If version.json changed, re-register the SW with the new ?v= URL.
      const versionChanged = !!(__latestVersion && __latestVersion !== prevLatest);

      if(versionChanged){
        try{ await registerServiceWorker(); }catch(_){}
        if(__swReg){
          try{ await __swReg.update(); }catch(_){}
        }
      }

      __latestNotes = notes;
      localStorage.setItem(VERSION_NOTES_KEY, JSON.stringify(notes));

      __latestBuildDate = buildDate;
      if(buildDate) localStorage.setItem(VERSION_BUILD_KEY, buildDate);

      setHeaderPills();

      const result = {
        ok:true,
        latestVersion: __latestVersion,
        appliedVersion: __appliedVersion,
        notes: __latestNotes,
        buildDate: __latestBuildDate,
        swUpdateWaiting: __hasSwUpdateWaiting(),
        swInstalling: __swInstalling
      };

      __lastUpdateResult = result;
      return result;
    }catch(e){
      setHeaderPills();
      __lastUpdateResult = { ok:false, reason:"fetch_failed" };
      return __lastUpdateResult;
    }finally{
      __updateCheckInFlight = null;
    }
  })();

  return __updateCheckInFlight;
}

export async function registerServiceWorker(){
  if(!("serviceWorker" in navigator)) return;

  try{
    // ✅ Version the SW script URL so a version.json bump forces a new SW install
    const v = (__latestVersion || __appliedVersion || "").trim();
    const swUrl = v ? `./sw.js?v=${encodeURIComponent(v)}` : "./sw.js";

    // If we already registered this exact URL, don't re-register.
    if(__swReg && __swUrlRegistered === swUrl) return;
    __swUrlRegistered = swUrl;

    __swReg = await navigator.serviceWorker.register(swUrl);

    // If an update is already waiting
    if(__swReg.waiting){
      __swUpdateReady = true;
      __swInstalling = false;
      setHeaderPills();
    }

    __swReg.addEventListener("updatefound", () => {
      const installing = __swReg.installing;
      if(!installing) return;

      __swInstalling = true;
      setHeaderPills();

      installing.addEventListener("statechange", () => {
        // installed + existing controller => update is ready and waiting
        if(installing.state === "installed" && navigator.serviceWorker.controller){
          __swInstalling = false;
          __swUpdateReady = true;
          setHeaderPills();
        }

        // If it becomes redundant/failed, stop showing "Downloading…"
        if(installing.state === "redundant"){
          __swInstalling = false;
          setHeaderPills();
        }
      });
    });

    // When new SW takes control, mark applied version (metadata only) and reload once
    let reloaded = false;
    if(versionChanged){
  try{ await registerServiceWorker(); }catch(_){}
  if(__swReg){
    try{ await __swReg.update(); }catch(_){}
  }
}

  }catch(e){
    console.warn("Service worker registration failed:", e);
  }
}

export function applyUpdateNow(){
  // ✅ Prevent losing changes that are still pending in debounce
  try{
    const s = __getStateRef();
    if(s) Storage.flush(s);
  }catch(_){}

  // If an update is waiting, activate it (skip waiting). Otherwise, just reload.
  try{
    if(__swReg && __swReg.waiting){
      __swReg.waiting.postMessage({ type:"SKIP_WAITING" });
      return;
    }
  }catch(_){}

  location.reload();
}

export function openVersionModal(){
  const status = !navigator.onLine
    ? "You’re offline. Updates can’t be checked right now."
    : (__swInstalling
        ? "Downloading the update in the background…"
        : (__hasSwUpdateWaiting()
            ? "A newer version is ready. Reload to apply the update."
            : "You’re up to date."));

  const notesNode = (__latestNotes && __latestNotes.length)
    ? el("div", {}, [
        el("div", { class:"note", text:"What’s new" }),
        el("div", { style:"height:8px" }),
        el("ul", {
          style:"margin:0; padding-left:18px; color: rgba(255,255,255,.78); font-size: 13px; line-height: 1.35;"
        }, __latestNotes.map(n => el("li", { text: n }))),
        el("div", { style:"height:10px" })
      ])
    : el("div", { style:"height:0" });

  Modal.open({
    title: "About",
    bodyNode: el("div", { class:"grid" }, [
      el("div", { class:"note", text:`Version (version.json): ${__latestVersion ? "v"+__latestVersion : "—"}` }),
      el("div", { class:"note", text:`Applied on device: ${__appliedVersion ? "v"+__appliedVersion : "—"}` }),
      (__latestBuildDate ? el("div", { class:"note", text:`Build: ${__latestBuildDate}` }) : el("div", { style:"display:none" })),
      el("div", { style:"height:10px" }),
      el("div", { class:"note", text: status }),
      el("div", { style:"height:12px" }),
      notesNode,
      el("div", { class:"btnrow" }, [
        el("button", {
          class:"btn",
          onClick: async () => {
            const r = await checkForUpdates({ force:true });
            showToast(r.ok ? "Checked version.json" : "Couldn’t check updates");
          }
        }, ["Check for updates"]),
        el("button", {
          class:"btn primary",
          onClick: () => applyUpdateNow()
        }, [__hasSwUpdateWaiting() ? "Reload to update" : "Reload"])
      ])
    ])
  });
}

let __headerPillsBound = false;
export function bindHeaderPills(){
  if(__headerPillsBound) return;
  __headerPillsBound = true;

  const syncPill = $("#syncPill");
  const verPill  = $("#verPill");

  if(syncPill){
    syncPill.addEventListener("click", async () => {
      await checkForUpdates({ force:true });
      openVersionModal();
    });
  }

  if(verPill){
    verPill.addEventListener("click", () => openVersionModal());
  }

  window.addEventListener("online",  () => { setHeaderPills(); checkForUpdates(); });
  window.addEventListener("offline", () => { setHeaderPills(); });
}
