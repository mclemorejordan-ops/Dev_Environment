/********************
 * 1) State + Storage (imported)
 ********************/
import {
  STORAGE_KEY,
  REMOTE_VERSION_URL,
  SCHEMA_VERSION,
  VERSION_LATEST_KEY,
  VERSION_APPLIED_KEY,
  VERSION_NOTES_KEY,
  VERSION_BUILD_KEY,
  DefaultState,
  migrateState
} from "./state.js";


import {
  BackupVault,
  Storage,
  getLastExportAt,
  setLastExportAt,
  EXPORT_META_KEY,
  handleStorageWriteError
} from "./storage.js";


import {
  $, el, uid, pad2,
  Dates,
  bytesToNice, appStorageBytes,
  showToast,
  lockBodyScroll, unlockBodyScroll,
  Modal, bindModalControls,
  PopoverOpen, PopoverClose,
  confirmModal
} from "./ui.js";

bindModalControls();


import {
  initVersioning,
  bindHeaderPills,
  setHeaderPills,
  checkForUpdates,
  registerServiceWorker,
  openVersionModal,
  applyUpdateNow,
  __hasSwUpdateWaiting
} from "./versioning.js";

import { initRoutinesEngine } from "./routines.js";

import { initLibrary } from "./library.js";

import { initLogs } from "./logs.js";

import { initWorkouts } from "./workouts.js";
import { initProgress } from "./progress.js";

import { initAttendance } from "./attendance.js";

import { initBackup } from "./backup.js";

import { initSettings } from "./settings.js";

import { initProteinUI } from "./protein-ui.js";

import { initAttendanceUI } from "./attendance-ui.js";

import { initRouter } from "./router.js";

import { initBootstrap } from "./bootstrap.js";

// ✅ Load state AFTER Storage exists
let state = Storage.load();


/********************
 * Social (Friends) — Events-only (Phase Social v1)
 * - Uses Supabase (optional) to publish + read compact activity events
 * - Additive only: does NOT change existing state/storage schema
 ********************/
const SOCIAL_CFG_KEY = "pc.social.supabase.v1";
const SOCIAL_OUTBOX_KEY = "pc.social.outbox.v1";
const SOCIAL_PENDING_WORKOUT_SHARE_KEY = "pc.social.pendingWorkoutShare.v1";
let __pendingWorkoutShareReplayBusy = false;

const SOCIAL_WORKOUT_HISTORY_SYNC_KEY = "pc.social.workoutHistorySync.v1";

function readWorkoutHistorySyncStamp(){
  try{
    return JSON.parse(localStorage.getItem(SOCIAL_WORKOUT_HISTORY_SYNC_KEY) || "{}");
  }catch(_){
    return {};
  }
}

function writeWorkoutHistorySyncStamp(next){
  try{
    localStorage.setItem(SOCIAL_WORKOUT_HISTORY_SYNC_KEY, JSON.stringify(next || {}));
  }catch(_){}
}
// ─────────────────────────────
// Friends (Option B): baked-in Supabase config
// - Sets defaults only if user has NOT configured anything yet
// - Respects {"disabled":true} to allow a real "Disconnect"
// ─────────────────────────────
const SOCIAL_DEFAULT = {
  // ✅ Replace with YOUR Supabase values (Project Settings → API)
  url: "https://hnzxnimyugjnyurfydna.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuenhuaW15dWdqbnl1cmZ5ZG5hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MDk1OTEsImV4cCI6MjA4ODA4NTU5MX0.JbGkZzBWqIRsDO7DCIGArPs1eJz1fswb09E7N7fTzKg"
};

function ensureSocialDefaultConfig(){
  try{
    const raw = localStorage.getItem(SOCIAL_CFG_KEY);
    if(raw){
      // Respect existing config, including explicit disable
      try{
        const parsed = JSON.parse(raw);
        if(parsed && parsed.disabled) return;
      }catch(_){}
      return;
    }
    if(!SOCIAL_DEFAULT.url || !SOCIAL_DEFAULT.anonKey) return;
    localStorage.setItem(SOCIAL_CFG_KEY, JSON.stringify(SOCIAL_DEFAULT));
  }catch(_){}
}

ensureSocialDefaultConfig();

function readSocialConfig(){
  try{ return JSON.parse(localStorage.getItem(SOCIAL_CFG_KEY) || "null"); }catch(_){ return null; }
}
function writeSocialConfig(cfg){
  try{ localStorage.setItem(SOCIAL_CFG_KEY, JSON.stringify(cfg || null)); }catch(_){}
}

function readOutbox(){
  try{ return JSON.parse(localStorage.getItem(SOCIAL_OUTBOX_KEY) || "[]"); }catch(_){ return []; }
}
function writeOutbox(items){
  try{ localStorage.setItem(SOCIAL_OUTBOX_KEY, JSON.stringify(items || [])); }catch(_){}
}

function normalizeUsername(v){
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\s+/g, "");
}

function usernameToHandle(v){
  const u = normalizeUsername(v);
  return u ? `@${u}` : "";
}

function isValidUsername(v){
  return /^[a-z0-9_]{3,20}$/.test(normalizeUsername(v));
}

async function getUsernameOwnerId(username){
  const u = normalizeUsername(username);
  if(!u) return null;

  try{
    const cfg = readSocialConfig();
    if(!cfg?.url || !cfg?.anonKey) return null;

    const mod = await loadSupabaseModule();
    const sb = mod.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    const { data, error } = await sb
      .from("profiles")
      .select("id")
      .eq("username", u)
      .maybeSingle();

    if(error) throw error;
    return String(data?.id || "") || null;
  }catch(_){
    return null;
  }
}

function looksLikeUuid(v){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || "").trim());
}

function initSocial(){
  let _mod = null;
  let _sb = null;
  let _cfg = readSocialConfig();
  let _user = null;
  let _feed = [];       // newest first


// ─────────────────────────────
// Feed Likes (DB-backed)
// ─────────────────────────────
let _likeCounts = {};       // eventId -> number
let _likedByMe = new Set(); // eventIds I liked (strings)

// ✅ prevents double-tap / double-fire on iPhone
let _likeBusy = new Set();  // eventIds currently toggling (strings)

function getLikeCount(eventId){
  const k = String(eventId ?? "");
  return Number(_likeCounts[k] || 0) || 0;
}
function didILike(eventId){
  const k = String(eventId ?? "");
  return _likedByMe.has(k);
}

// Fetch counts + my likes for a list of feed event ids
async function fetchFeedLikes(eventIds){
  const sb = await ensureClient();
  if(!sb || !_user) { _likeCounts = {}; _likedByMe = new Set(); return; }

  const ids = (eventIds || []).map(x => {
    // activity_events.id is BIGINT in your DB, but it arrives as number/string in JS
    // keep as-is for .in() and normalize keys to string for maps
    return (typeof x === "number") ? x : (String(x || "").trim());
  }).filter(x => (x !== "" && x != null));

  if(!ids.length){
    _likeCounts = {};
    _likedByMe = new Set();
    return;
  }

  try{
    // 1) Counts (from view)
    const { data: cData, error: cErr } = await sb
      .from("feed_like_counts")
      .select("event_id, like_count")
      .in("event_id", ids);

    if(cErr) throw cErr;

    // ✅ MERGE counts (do not wipe other posts)
    const nextCounts = { ..._likeCounts };

    // default requested ids to 0 unless returned by the view
    ids.forEach(id => { nextCounts[String(id)] = 0; });

    (cData || []).forEach(r => {
      const k = String(r.event_id ?? "");
      nextCounts[k] = Number(r.like_count || 0) || 0;
    });

    _likeCounts = nextCounts;

    // 2) My likes (from table)
    const { data: mData, error: mErr } = await sb
      .from("feed_likes")
      .select("event_id")
      .eq("user_id", _user.id)
      .in("event_id", ids);

    if(mErr) throw mErr;

    // ✅ MERGE liked-by-me (only update requested ids)
    const nextMine = new Set(_likedByMe);

    // first clear liked status for the requested ids…
    ids.forEach(id => { nextMine.delete(String(id)); });

    // …then re-add from DB results
    (mData || []).forEach(r => {
      const k = String(r.event_id ?? "");
      if(k) nextMine.add(k);
    });

    _likedByMe = nextMine;

  }catch(_){
    // keep last known values if query fails
  }
}
  // Fetch users who liked a single event (for Likes modal)
async function fetchFeedLikers(eventId){
  const sb = await ensureClient();
  if(!sb || !_user) return [];

  try{
    const { data, error } = await sb
      .from("feed_likes")
      .select("user_id, created_at")
      .eq("event_id", (typeof eventId === "number") ? eventId : eventId)
      .order("created_at", { ascending: false });

    if(error) throw error;

    return (data || []).map(r => ({
      userId: r.user_id,
      createdAt: r.created_at
    }));
  }catch(_){
    return [];
  }
}

// ✅ Single-event reconcile (prevents flicker caused by view lag)
async function reconcileLikeForEvent(eventId){
  const sb = await ensureClient();
  if(!sb || !_user) return;

  const k = String(eventId ?? "");
  if(!k) return;

  // Use the base table for authoritative count (view can lag right after insert/delete)
  try{
    const { count, error } = await sb
      .from("feed_likes")
      .select("id", { count: "exact", head: true })
      .eq("event_id", (typeof eventId === "number") ? eventId : eventId);

    if(error) throw error;
    _likeCounts[k] = Number(count || 0) || 0;
  }catch(_){
    // if this fails, keep optimistic count
  }

  // Refresh "did I like it" from the base table
  try{
    const { data, error } = await sb
      .from("feed_likes")
      .select("event_id")
      .eq("event_id", (typeof eventId === "number") ? eventId : eventId)
      .eq("user_id", _user.id)
      .limit(1);

    if(error) throw error;

    const nextMine = new Set(_likedByMe);
    if((data || []).length) nextMine.add(k);
    else nextMine.delete(k);
    _likedByMe = nextMine;
  }catch(_){
    // if this fails, keep optimistic liked state
  }
}

// Toggle like for an event (insert/delete)
async function toggleFeedLike(eventId){
  const sb = await ensureClient();
  if(!sb || !_user) throw new Error("Not signed in");

  const k = String(eventId ?? "");
  if(!k) return;

  // ✅ Guard: prevent double-fire (iOS taps / fast repeat clicks)
  if(_likeBusy.has(k)) return;
  _likeBusy.add(k);

  try{
    const wasLiked = _likedByMe.has(k);

    // optimistic UI
    if(wasLiked){
      _likedByMe.delete(k);
      _likeCounts[k] = Math.max(0, (Number(_likeCounts[k] || 0) || 0) - 1);
    }else{
      _likedByMe.add(k);
      _likeCounts[k] = (Number(_likeCounts[k] || 0) || 0) + 1;
    }
    notify();

    try{
      if(wasLiked){
        const { error } = await sb
          .from("feed_likes")
          .delete()
          .eq("event_id", (typeof eventId === "number") ? eventId : eventId)
          .eq("user_id", _user.id);
        if(error) throw error;
      }else{
        const { error } = await sb
          .from("feed_likes")
          .insert({ event_id: eventId, user_id: _user.id });
        if(error){
          // ignore duplicate like race
          if(String(error.code) !== "23505") throw error;
        }
      }

      // ✅ reconcile from base table (prevents stale view flicker)
      await reconcileLikeForEvent(eventId);
      notify();
        }catch(e){
      // keep your existing behavior intent: get back to a consistent server-truth UI
      try{
        // fetchFeed() already rebuilds _feed and hydrates names/likes/comment counts
        await fetchFeed();
      }catch(_){
        // If feed fetch fails, at least try to re-hydrate likes for whatever feed we have
        try{
          await fetchFeedLikes((_feed || []).map(x => x.id));
        }catch(__){}
      }
      throw e;
    }
  } finally {
    // ✅ always release lock
    _likeBusy.delete(k);
  }
}

  // ─────────────────────────────
// Feed Comments (DB-backed threads)
// ─────────────────────────────
let _commentCounts = {}; // eventId -> number

function getCommentCount(eventId){
  const k = String(eventId ?? "");
  return Number(_commentCounts[k] || 0) || 0;
}

// Fetch comment counts for a list of feed event ids (via view)
async function fetchFeedCommentCounts(eventIds){
  const sb = await ensureClient();
  if(!sb || !_user) { _commentCounts = {}; return; }

  const ids = (eventIds || []).map(x => (
    (typeof x === "number") ? x : String(x || "").trim()
  )).filter(x => (x !== "" && x != null));

  if(!ids.length){ _commentCounts = {}; return; }

  try{
    const { data, error } = await sb
      .from("feed_comment_counts")
      .select("event_id, comment_count")
      .in("event_id", ids);

    if(error) throw error;

    const next = {};
    (data || []).forEach(r => {
      const k = String(r.event_id ?? "");
      next[k] = Number(r.comment_count || 0) || 0;
    });
    _commentCounts = next;
  }catch(_){
    // keep last known values if query fails
  }
}

// Fetch comments for one event (includes threading via parent_id)
async function fetchFeedComments(eventId){
  const sb = await ensureClient();
  if(!sb || !_user) return [];

  try{
    const { data, error } = await sb
      .from("feed_comments")
      .select("id, event_id, user_id, parent_id, body, created_at")
      .eq("event_id", (typeof eventId === "number") ? eventId : eventId)
      .order("created_at", { ascending: true });

    if(error) throw error;
    return (data || []).map(r => ({
      id: r.id,
      eventId: r.event_id,
      userId: r.user_id,
      parentId: r.parent_id,
      body: r.body || "",
      createdAt: r.created_at
    }));
  }catch(_){
    return [];
  }
}

async function addFeedComment({ eventId, body, parentId }){
  const sb = await ensureClient();
  if(!sb || !_user) throw new Error("Not signed in");

  const text = String(body || "").trim();
  if(!text) throw new Error("Comment is empty");

  const row = {
    event_id: eventId,
    user_id: _user.id,
    body: text
  };
  if(parentId) row.parent_id = parentId;

  const { error } = await sb.from("feed_comments").insert(row);
  if(error) throw error;

  // Refresh counts for this event
  await fetchFeedCommentCounts([eventId]);
  notify();
}

async function deleteFeedComment(commentId, eventId){
  const sb = await ensureClient();
  if(!sb || !_user) throw new Error("Not signed in");
  if(!commentId) return;

  const { error } = await sb
    .from("feed_comments")
    .delete()
    .eq("id", commentId);

  if(error) throw error;

  await fetchFeedCommentCounts([eventId]);
  notify();
}
  
  let _follows = [];    // list of followed user ids (strings)
  let _followers = [];  // list of follower user ids (strings)
  let _notifications = []; // like/comment/follow notifications (newest first)
  let _names = {};      // id -> display_name (from profiles)
  let _usernames = {};  // id -> username (normalized, no @)
  let _usernameConflictWarned = false;
  let _pollTimer = null;
  let _listeners = new Set();

  // Prevent route re-renders from interrupting OAuth launch
  let _authInFlight = false;

  async function loadSupabaseModule(){
    if(_mod) return _mod;
    // Supabase JS v2 as ESM via jsDelivr (allowed by CSP)
    _mod = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    return _mod;
  }

  async function ensureClient(){
    _cfg = readSocialConfig();
    if(!_cfg?.url || !_cfg?.anonKey){
      _sb = null;
      _user = null;
      return null;
    }
    if(_sb) return _sb;

    const mod = await loadSupabaseModule();
    _sb = mod.createClient(_cfg.url, _cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    // keep cached user current
    try{
      const { data } = await _sb.auth.getUser();
      _user = data?.user || null;
    }catch(_){
      _user = null;
    }

    // Keep profiles table updated with my display name
if(_user){
  try{ await upsertMyProfile(); }catch(_){}
}

    // react to auth changes
        try{
      _sb.auth.onAuthStateChange((_event, session) => {
        _user = session?.user || null;

        // OAuth handoff is complete once auth state changes
        _authInFlight = false;

        if(_user){
          try{ upsertMyProfile(); }catch(_){}
          startFeed();

          setTimeout(() => {
            try{ consumePendingWorkoutShareAfterAuth(); }catch(_){}
          }, 0);
        }else{
          stopFeed();
        }

        notify();
      });
    }catch(_){}

    return _sb;
  }

  function isConfigured(){
    _cfg = readSocialConfig();
    return !!(_cfg?.url && _cfg?.anonKey);
  }

  
  function getUser(){ return _user; }
function getFeed(){ return _feed.slice(); }
function getFollows(){ return _follows.slice(); }
function getFollowers(){ return _followers.slice(); }
  
  function getNotifications(){ return _notifications.slice(); }

async function fetchNotifications(){
  const sb = await ensureClient();
  if(!sb || !_user){
    _notifications = [];
    notify();
    return [];
  }

  // Notify about activity on MY posts.
  const myIds = (_feed || [])
    .filter(ev => String(ev?.actorId || "") === String(_user.id || ""))
    .map(ev => ev?.id)
    .filter(x => (x !== null && x !== undefined));

  const ids = myIds.slice(0, 50);

  try{
    // 1) FOLLOWS: who followed me
    let followRows = [];
    try{
      const { data, error } = await sb
        .from("follows")
        .select("follower_id, created_at")
        .eq("followee_id", _user.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if(!error) followRows = data || [];
    }catch(_){}

    // 2) LIKES on my events
    let likeRows = [];
    if(ids.length){
      try{
        const { data, error } = await sb
          .from("feed_likes")
          .select("event_id, user_id, created_at")
          .in("event_id", ids)
          .neq("user_id", _user.id)
          .order("created_at", { ascending: false })
          .limit(50);
        if(!error) likeRows = data || [];
      }catch(_){}
    }

    // 3) COMMENTS on my events
    let commentRows = [];
    if(ids.length){
      try{
        const { data, error } = await sb
          .from("feed_comments")
          .select("event_id, user_id, body, created_at")
          .in("event_id", ids)
          .neq("user_id", _user.id)
          .order("created_at", { ascending: false })
          .limit(50);
        if(!error) commentRows = data || [];
      }catch(_){}
    }

    // Best-effort name hydration
    const actorIds = []
      .concat(followRows.map(r => r?.follower_id))
      .concat(likeRows.map(r => r?.user_id))
      .concat(commentRows.map(r => r?.user_id))
      .map(x => String(x || ""))
      .filter(Boolean);

    try{ await fetchNames(actorIds); }catch(_){}

    const notifs = [];

    (followRows || []).forEach(r => {
      const actorId = String(r?.follower_id || "");
      if(!actorId) return;
      notifs.push({
        type: "follow",
        actorId,
        eventId: null,
        body: "",
        createdAt: r?.created_at || null
      });
    });

    (likeRows || []).forEach(r => {
      const actorId = String(r?.user_id || "");
      const eventId = r?.event_id;
      if(!actorId || eventId === null || eventId === undefined) return;
      notifs.push({
        type: "like",
        actorId,
        eventId,
        body: "",
        createdAt: r?.created_at || null
      });
    });

    (commentRows || []).forEach(r => {
      const actorId = String(r?.user_id || "");
      const eventId = r?.event_id;
      if(!actorId || eventId === null || eventId === undefined) return;
      notifs.push({
        type: "comment",
        actorId,
        eventId,
        body: String(r?.body || ""),
        createdAt: r?.created_at || null
      });
    });

    // newest first, cap
    notifs.sort((a,b) => {
      const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return (tb - ta);
    });

    _notifications = notifs.slice(0, 60);
  }catch(_){
    // keep last known
  }

  notify();
  return _notifications;
}

  function onChange(fn){
    if(typeof fn !== "function") return () => {};
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  }
  function notify(){
    try{ _listeners.forEach(fn => fn()); }catch(_){}
  }

    function nameFor(id){
    const k = String(id || "");
    return _names[k] || null;
  }

  function usernameFor(id){
    const k = String(id || "");
    return _usernames[k] || null;
  }

  function identityFor(id, fallbackName="User"){
    const k = String(id || "");
    return {
      displayName: _names[k] || fallbackName || "User",
      username: _usernames[k] || null
    };
  }

  async function fetchNames(ids){
    const sb = await ensureClient();
    if(!sb || !_user) return { names:_names, usernames:_usernames };

    const uniq = Array.from(new Set((ids || [])
      .map(x => String(x || ""))
      .filter(Boolean)
    ));

    const missing = uniq.filter(id =>
      !Object.prototype.hasOwnProperty.call(_names, String(id)) ||
      !Object.prototype.hasOwnProperty.call(_usernames, String(id))
    );

    if(!missing.length) return { names:_names, usernames:_usernames };

    try{
      const { data, error } = await sb
        .from("profiles")
        .select("id, display_name, username")
        .in("id", missing);

      if(error) throw error;

      (data || []).forEach(r => {
        const id = String(r.id || "");
        if(!id) return;

        const dn = String(r.display_name || "").trim();
        const un = normalizeUsername(r.username || "");

        _names[id] = dn || "User";
        _usernames[id] = un || "";
      });

      missing.forEach(id => {
        const k = String(id || "");
        if(!Object.prototype.hasOwnProperty.call(_names, k)) _names[k] = "User";
        if(!Object.prototype.hasOwnProperty.call(_usernames, k)) _usernames[k] = "";
      });
    }catch(_){}

    return { names:_names, usernames:_usernames };
  }

    async function fetchNames(ids){
    const sb = await ensureClient();
    if(!sb || !_user) return { names:_names, usernames:_usernames };

    const uniq = Array.from(new Set((ids || [])
      .map(x => String(x || ""))
      .filter(Boolean)
    ));

    const missing = uniq.filter(id =>
      !Object.prototype.hasOwnProperty.call(_names, String(id)) ||
      !Object.prototype.hasOwnProperty.call(_usernames, String(id))
    );

    if(!missing.length) return { names:_names, usernames:_usernames };

    try{
      const { data, error } = await sb
        .from("profiles")
        .select("id, display_name, username")
        .in("id", missing);

      if(error) throw error;

      (data || []).forEach(r => {
        const id = String(r.id || "");
        if(!id) return;

        const dn = String(r.display_name || "").trim();
        const un = normalizeUsername(r.username || "");

        _names[id] = dn || "User";
        _usernames[id] = un || "";
      });

      missing.forEach(id => {
        const k = String(id || "");
        if(!Object.prototype.hasOwnProperty.call(_names, k)) _names[k] = "User";
        if(!Object.prototype.hasOwnProperty.call(_usernames, k)) _usernames[k] = "";
      });
    }catch(_){}

    return { names:_names, usernames:_usernames };
  }

  async function searchProfilesByUsername(query, opts={}){
    const sb = await ensureClient();
    if(!sb || !_user) return [];

    const raw = String(query || "").trim();
    const q = normalizeUsername(raw);
    if(!q) return [];

    const limit = Math.max(1, Math.min(20, Number(opts?.limit || 8) || 8));

    try{
      const { data, error } = await sb
        .from("profiles")
        .select("id, display_name, username")
        .ilike("username", `${q}%`)
        .limit(limit);

      if(error) throw error;

      const rows = (data || []).map(r => {
        const id = String(r?.id || "");
        const dn = String(r?.display_name || "").trim() || "User";
        const un = normalizeUsername(r?.username || "");

        if(id){
          _names[id] = dn;
          _usernames[id] = un || "";
        }

        return {
          id,
          displayName: dn,
          username: un
        };
      }).filter(r => r.id && r.username);

      rows.sort((a,b) => {
        const au = String(a?.username || "");
        const bu = String(b?.username || "");
        const aExact = au === q;
        const bExact = bu === q;
        if(aExact !== bExact) return aExact ? -1 : 1;
        const aStarts = au.startsWith(q);
        const bStarts = bu.startsWith(q);
        if(aStarts !== bStarts) return aStarts ? -1 : 1;
        return au.localeCompare(bu);
      });

      return rows;
    }catch(_){
      return [];
    }
  }

async function upsertMyProfile(){
  const sb = await ensureClient();
  if(!sb || !_user) return;

  const state = stateRef ? stateRef() : null;
  const fromState = String(state?.profile?.name || "").trim();
  const fromEmail = String(_user?.email || "").split("@")[0] || "";
  const displayName = (fromState || fromEmail || "User").slice(0, 40);

  const localUsername = normalizeUsername(state?.profile?.username || "");
  const emailUsername = normalizeUsername(fromEmail);
  const fallbackUsername = normalizeUsername(`user_${String(_user.id || "").slice(0, 8)}`);
  const username = isValidUsername(localUsername)
    ? localUsername
    : isValidUsername(emailUsername)
      ? emailUsername
      : fallbackUsername;

  try{
    const { error } = await sb.from("profiles").upsert({
      id: _user.id,
      display_name: displayName,
      username,
      updated_at: new Date().toISOString()
    });

    if(error) throw error;

    _names[_user.id] = displayName;
    _usernames[_user.id] = username;
    _usernameConflictWarned = false;
  }catch(e){
    if(String(e?.code || "") === "23505" && !_usernameConflictWarned){
      _usernameConflictWarned = true;
      try{ showToast("Username is already taken in Friends. Change it in Settings."); }catch(_){}
    }
  }
}

  async function configure({ url, anonKey }){
    const clean = {
      url: (url || "").trim(),
      anonKey: (anonKey || "").trim()
    };
    writeSocialConfig(clean.url && clean.anonKey ? clean : null);
    // reset
    _cfg = readSocialConfig();
    _sb = null;
    _user = null;
    stopFeed();
    notify();
    await ensureClient();
    notify();
  }

  async function signInWithOtp(email){
  const sb = await ensureClient();
  if(!sb) throw new Error("Social not configured");
  const e = (email || "").trim();
  if(!e) throw new Error("Email required");

  // Magic link / OTP email. Works well for PWAs.
  const redirectTo = location.origin + location.pathname;
  const { error } = await sb.auth.signInWithOtp({
    email: e,
    options: { emailRedirectTo: redirectTo }
  });
  if(error) throw error;
}

async function signInWithOAuth(provider){
  const sb = await ensureClient();
  if(!sb) throw new Error("Social not configured");

  const p = (provider || "").trim();
  if(!p) throw new Error("Provider required");

  // OAuth redirect back to this app (hash router friendly)
  const redirectTo = location.origin + location.pathname;

  _authInFlight = true;

  try{
    const { error } = await sb.auth.signInWithOAuth({
      provider: p,
      options: { redirectTo }
    });
    if(error) throw error;
  }catch(e){
    _authInFlight = false;
    throw e;
  }
}

  async function signOut(){
    const sb = await ensureClient();
    if(!sb) return;
    try{ await sb.auth.signOut(); }catch(_){}
    _user = null;
    stopFeed();
    notify();
  }

    async function refreshUser(){
    const sb = await ensureClient();
    if(!sb) {
      _user = null;
      _authInFlight = false;
      stopFeed();
      notify();
      return;
    }

    try{
      const { data } = await sb.auth.getUser();
      _user = data?.user || null;
    }catch(_){
      _user = null;
    }

    // OAuth handoff is complete once we've refreshed user state
    _authInFlight = false;

        if(_user){
      try{ await upsertMyProfile(); }catch(_){}
      try{ await backfillWorkoutHistoryFromLocalLogs(); }catch(_){}
    }

    // ✅ Important: if we are already signed in on cold-open,
    // start polling so followers/following counts update live.
    if(_user) startFeed();
    else stopFeed();

    if(_user){
      try{ await consumePendingWorkoutShareAfterAuth(); }catch(_){}
    }

    notify();
  }

  async function fetchFollows(){
    const sb = await ensureClient();
    if(!sb || !_user) { _follows = []; return []; }
    try{
      const { data, error } = await sb
        .from("follows")
        .select("followee_id")
        .eq("follower_id", _user.id);
      if(error) throw error;
      _follows = (data || []).map(r => String(r.followee_id || "")).filter(Boolean);
      return _follows;
    }catch(_){
      _follows = [];
      return [];
    }
  }
  
    async function fetchFollowers(){
  const sb = await ensureClient();
  if(!sb || !_user) { _followers = []; return []; }
  try{
    const { data, error } = await sb
      .from("follows")
      .select("follower_id")
      .eq("followee_id", _user.id);
    if(error) throw error;
    _followers = (data || []).map(r => String(r.follower_id || "")).filter(Boolean);
    return _followers;
  }catch(_){
    _followers = [];
    return [];
  }
}


        let _myProfileRoutineEnabled = false;
    let _routineSharesInbox = [];

  function buildPublicRoutineSnapshot(routine){
    const s = stateRef ? stateRef() : null;
    if(!routine) return null;

    const days = (routine.days || [])
      .slice()
      .sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0))
      .map((day, idx) => ({
        id: day?.id || null,
        order: Number(day?.order ?? idx) || 0,
        label: day?.label || `Day ${idx + 1}`,
        isRest: !!day?.isRest,
        exercises: (day?.exercises || []).map((rx, exIdx) => {
          let resolvedName = rx?.nameSnap || "Exercise";
          try{
            const lib = s?.exerciseLibrary?.[String(rx?.type || "")] || [];
            const found = lib.find(x => String(x?.id || "") === String(rx?.exerciseId || ""));
            if(found?.name) resolvedName = String(found.name);
          }catch(_){}
          return {
            id: rx?.id || null,
            order: exIdx,
            type: String(rx?.type || ""),
            exerciseId: rx?.exerciseId || null,
            name: resolvedName,
            plan: rx?.plan || null,
            notes: String(rx?.notes || "")
          };
        })
      }));

    return {
      routineId: routine?.id || null,
      name: routine?.name || "Routine",
      days
    };
  }

  function getRoutineSharesInbox(){
    return (_routineSharesInbox || []).slice();
  }

  async function shareRoutineWithUser(recipientId, routine){
    const sb = await ensureClient();
    if(!sb || !_user) throw new Error("Not signed in");

    const targetId = String(recipientId || "").trim();
    if(!targetId) throw new Error("Recipient is required");
    if(targetId === String(_user.id || "")) throw new Error("You can't send a routine to yourself");
    if(!routine) throw new Error("Routine not found");

    const snap = buildPublicRoutineSnapshot(routine);
    if(!snap) throw new Error("Routine couldn't be shared");

    const row = {
      sender_id: _user.id,
      recipient_id: targetId,
      routine_name: snap.name || routine?.name || "Routine",
      routine_payload: snap,
      status: "pending"
    };

    const { error } = await sb.from("routine_shares").insert(row);
    if(error) throw error;

    return row;
  }

  async function shareRoutineWithUsername(username, routine){
    const targetId = await resolveFollowTarget(username);
    return await shareRoutineWithUser(targetId, routine);
  }

  async function fetchRoutineSharesInbox(){
    const sb = await ensureClient();
    if(!sb || !_user){
      _routineSharesInbox = [];
      notify();
      return [];
    }

    try{
      const { data, error } = await sb
        .from("routine_shares")
        .select("id, sender_id, recipient_id, routine_name, routine_payload, created_at, status")
        .eq("recipient_id", _user.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(25);

      if(error) throw error;

      const rows = (data || []).map(r => ({
        id: r.id,
        senderId: String(r.sender_id || ""),
        recipientId: String(r.recipient_id || ""),
        routineName: String(r.routine_name || r?.routine_payload?.name || "Routine"),
        routinePayload: r.routine_payload || null,
        createdAt: r.created_at || null,
        status: String(r.status || "pending")
      }));

      try{
        const senderIds = rows.map(r => r.senderId).filter(Boolean);
        if(senderIds.length && fetchNames) await fetchNames(senderIds);
      }catch(_){}

      _routineSharesInbox = rows;
    }catch(_){
      // keep last known values if query fails
    }

    notify();
    return getRoutineSharesInbox();
  }

  async function dismissRoutineShare(shareId){
    const sb = await ensureClient();
    if(!sb || !_user) throw new Error("Not signed in");

    const id = shareId;
    if(id == null) return;

    const { error } = await sb
      .from("routine_shares")
      .update({
        status: "dismissed",
        dismissed_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("recipient_id", _user.id);

    if(error) throw error;

    _routineSharesInbox = (_routineSharesInbox || []).filter(x => String(x?.id) !== String(id));
    notify();
  }

  async function markRoutineShareSaved(shareId){
    const sb = await ensureClient();
    if(!sb || !_user) throw new Error("Not signed in");

    const id = shareId;
    if(id == null) return;

    const { error } = await sb
      .from("routine_shares")
      .update({
        status: "saved",
        saved_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("recipient_id", _user.id);

    if(error) throw error;

    _routineSharesInbox = (_routineSharesInbox || []).filter(x => String(x?.id) !== String(id));
    notify();
  }
  

  async function fetchMyProfileRoutineSetting(){
    const sb = await ensureClient();
    if(!sb || !_user) return false;

    try{
      const { data, error } = await sb
        .from("profile_routines")
        .select("enabled")
        .eq("user_id", _user.id)
        .maybeSingle();

      if(error) throw error;
      _myProfileRoutineEnabled = !!data?.enabled;
      return _myProfileRoutineEnabled;
    }catch(_){
      _myProfileRoutineEnabled = false;
      return false;
    }
  }

  function isProfileRoutineEnabled(){
    return !!_myProfileRoutineEnabled;
  }

  async function setPublicRoutineEnabled(enabled, routine=null){
    const sb = await ensureClient();
    if(!sb || !_user) throw new Error("Not signed in");

    const on = !!enabled;
    _myProfileRoutineEnabled = on;

    const row = {
      user_id: _user.id,
      enabled: on,
      updated_at: new Date().toISOString()
    };

    if(on && routine){
      const snap = buildPublicRoutineSnapshot(routine);
      row.routine_name = snap?.name || routine?.name || "Routine";
      row.routine_payload = snap;
    }

    if(!on){
      row.routine_name = null;
      row.routine_payload = null;
    }

    const { error } = await sb.from("profile_routines").upsert(row);
    if(error) throw error;

    return row;
  }

  async function publishProfileRoutine(routine){
    const sb = await ensureClient();
    if(!sb || !_user) return null;
    if(!routine) return null;

    const snap = buildPublicRoutineSnapshot(routine);
    if(!snap) return null;

    const row = {
      user_id: _user.id,
      enabled: true,
      routine_name: snap.name || routine?.name || "Routine",
      routine_payload: snap,
      updated_at: new Date().toISOString()
    };

    const { error } = await sb.from("profile_routines").upsert(row);
    if(error) throw error;

    _myProfileRoutineEnabled = true;
    return row;
  }

  async function fetchProfileRoutine(userId){
    const sb = await ensureClient();
    const id = String(userId || "").trim();
    if(!sb || !_user || !id) return null;

    try{
      const { data, error } = await sb
        .from("profile_routines")
        .select("user_id, enabled, routine_name, routine_payload, updated_at")
        .eq("user_id", id)
        .maybeSingle();

      if(error) throw error;

      if(String(id) === String(_user?.id || "")){
        _myProfileRoutineEnabled = !!data?.enabled;
      }

      if(!data){
        return {
          userId: id,
          enabled: false,
          routineName: null,
          routinePayload: null,
          updatedAt: null
        };
      }

      return {
        userId: String(data.user_id || id),
        enabled: !!data.enabled,
        routineName: data.routine_name || data?.routine_payload?.name || null,
        routinePayload: data.routine_payload || null,
        updatedAt: data.updated_at || null
      };
    }catch(_){
      return null;
    }
  }

  async function fetchProfileFollowCounts(userId){
  const sb = await ensureClient();
  const id = String(userId || "").trim();
  if(!sb || !_user || !id) return { following:0, followers:0 };

  try{
    const [{ count: followingCount }, { count: followerCount }] = await Promise.all([
      sb.from("follows").select("followee_id", { count:"exact", head:true }).eq("follower_id", id),
      sb.from("follows").select("follower_id", { count:"exact", head:true }).eq("followee_id", id)
    ]);

    return {
      following: Number(followingCount || 0) || 0,
      followers: Number(followerCount || 0) || 0
    };
  }catch(_){
    return { following:0, followers:0 };
  }
}

  async function fetchProfileWorkoutHighlights(userId){
    const sb = await ensureClient();
    const id = String(userId || "").trim();
    if(!sb || !_user || !id) return [];

    try{
      const { data, error } = await sb
        .from("activity_events")
        .select("id, actor_id, type, payload, created_at")
        .eq("actor_id", id)
        .eq("type", "workout_completed")
        .order("created_at", { ascending: false })
        .limit(200);

      if(error) throw error;

      try{ await fetchNames([id]); }catch(_){}

      return (data || []).map(r => ({
        id: r.id,
        actorId: r.actor_id,
        type: r.type,
        payload: r.payload || {},
        createdAt: r.created_at
      }));
    }catch(_){
      return [];
    }
  }

  async function fetchWorkoutHistoryDates(userId){
  const sb = await ensureClient();
  const id = String(userId || "").trim();
  if(!sb || !_user || !id) return [];

  try{
    const { data, error } = await sb
      .from("workout_history")
      .select("date_iso")
      .eq("user_id", id)
      .order("date_iso", { ascending: false });

    if(error) throw error;

    return Array.from(new Set(
      (data || [])
        .map(r => String(r?.date_iso || "").trim())
        .filter(Boolean)
    ));
  }catch(_){
    return [];
  }
}

  async function fetchFeed(){
  const sb = await ensureClient();

  // 🛡 Guard: never attempt feed queries without a configured Supabase client
  if(!sb || !_user || !isConfigured()){
    _feed = [];
    notify();
    return;
  }

      // Ensure we know who we're following + who follows us (UI header counts)
  await fetchFollows();
  await fetchFollowers();

    try{
      const { data, error } = await sb
        .from("activity_events")
        .select("id, actor_id, type, payload, created_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if(error) throw error;

      _feed = (data || []).map(r => ({
        id: r.id,
        actorId: r.actor_id,
        type: r.type,
        payload: r.payload || {},
        createdAt: r.created_at
      }));
      try{
  const ids = (_feed || []).map(x => x.id);
  const actors = (_feed || []).map(x => x.actorId);

  // ✅ Batch hydration (parallel): faster feed paint, same results
  await Promise.all([
    fetchNames(actors),
    fetchFeedLikes(ids),
    fetchFeedCommentCounts(ids)
  ]);
}catch(_){}
      
    }catch(_){
      // keep last known feed if query fails
    }
    notify();
  }

  function startFeed(){
    stopFeed();
    if(!_user) return;
    fetchFeed();
    _pollTimer = setInterval(fetchFeed, 12000); // 12s: feels live, low cost
  }

  function stopFeed(){
    if(_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; }
  }

    async function resolveFollowTarget(target){
    const raw = String(target || "").trim();
    if(!raw) throw new Error("Enter a username");

    if(looksLikeUuid(raw)) return raw;

    const uname = normalizeUsername(raw);
    if(!isValidUsername(uname)) throw new Error("Enter a valid @username");

    const sb = await ensureClient();
    if(!sb || !_user) throw new Error("Not signed in");

    const { data, error } = await sb
      .from("profiles")
      .select("id, display_name, username")
      .eq("username", uname)
      .maybeSingle();

    if(error) throw error;
    if(!data?.id) throw new Error("Username not found");

    const foundId = String(data.id || "");
    if(foundId){
      _names[foundId] = String(data.display_name || "").trim() || "User";
      _usernames[foundId] = normalizeUsername(data.username || uname);
    }

    return foundId;
  }

  async function follow(userIdOrUsername){
    const sb = await ensureClient();
    if(!sb || !_user) throw new Error("Not signed in");

    const id = await resolveFollowTarget(userIdOrUsername);
    if(!id) throw new Error("Username not found");
    if(id === _user.id) throw new Error("You can't follow yourself");

    const { error } = await sb.from("follows").insert({
      follower_id: _user.id,
      followee_id: id
    });
    if(error) throw error;
    await fetchFeed();
  }

  async function unfollow(userId){
    const sb = await ensureClient();
    if(!sb || !_user) return;
    const id = (userId || "").trim();
    if(!id) return;

    const { error } = await sb
      .from("follows")
      .delete()
      .eq("follower_id", _user.id)
      .eq("followee_id", id);
    if(error) throw error;
    await fetchFeed();
  }
  
  async function removeFollower(followerId){
  const sb = await ensureClient();
  if(!sb || !_user) return;
  const id = (followerId || "").trim();
  if(!id) return;

  // Remove the row where THEY follow YOU
  const { error } = await sb
    .from("follows")
    .delete()
    .eq("follower_id", id)
    .eq("followee_id", _user.id);

  if(error) throw error;
  await fetchFeed();
}

  // stateRef is injected later (avoid circular init)
  let stateRef = () => null;
  function bindStateGetter(fn){ stateRef = (typeof fn === "function") ? fn : (() => null); }

    function formatLogEvent(entry){
    const state = stateRef();
    const lib = state?.library;
    const exName = (() => {
      try{
        const ex = (lib?.exercises || []).find(x => String(x.id||"") === String(entry.exerciseId||""));
        return ex?.name || "Exercise";
      }catch(_){ return "Exercise"; }
    })();

    const type = String(entry?.type || "");
    const summary = entry?.summary || {};
    const pr = entry?.pr || {};
    const prCount = ["isPRWeight","isPR1RM","isPRVolume","isPRPace"].filter(k => pr?.[k]).length;

    return {
      eventType: "exercise_logged",
      payload: {
        displayName: state?.profile?.name || null,
        username: normalizeUsername(state?.profile?.username || "") || null,
        exerciseName: exName,
        workoutType: type,
        dateISO: entry?.dateISO || null,
        routineId: entry?.routineId || null,
        dayId: entry?.dayId || null,
        summary,
        prCount
      }
    };
  }

  function formatWorkoutCompletedEvent({ dateISO, routineId, dayId, highlights, details }){
    const state = stateRef();
    return {
      eventType: "workout_completed",
      payload: {
        displayName: state?.profile?.name || null,
        username: normalizeUsername(state?.profile?.username || "") || null,
        dateISO: dateISO || null,
        routineId: routineId || null,
        dayId: dayId || null,
        highlights: highlights || {},
        details: details || null
      }
    };
  }
  

  async function flushOutbox(){
    const sb = await ensureClient();
    if(!sb || !_user) return;

    const items = readOutbox();
    if(!items.length) return;

    const keep = [];
    for(const it of items){
      try{
        const { error } = await sb.from("activity_events").insert(it);
        if(error) throw error;
      }catch(_){
        keep.push(it);
      }
    }
    writeOutbox(keep);
  }

    async function publishLogEvent(entry){
    // Only publish if configured + signed in
    if(!isConfigured()) return;
    await ensureClient();
    if(!_user) return;

    const ev = formatLogEvent(entry);

    // ✅ Same Calendar Day only (prevents post-dated feed events)
    const todayISO = Dates.todayISO();
    const evDateISO = String(ev?.payload?.dateISO || "");
    if(evDateISO !== String(todayISO)) return;

    const row = {
      actor_id: _user.id,
      type: ev.eventType,
      payload: ev.payload
    };

    // Try immediate insert, else queue
    try{
      const sb = await ensureClient();
      if(!sb) return;
      const { error } = await sb.from("activity_events").insert(row);
      if(error) throw error;
      // refresh quickly
      fetchFeed();
    }catch(_){
      const out = readOutbox();
      out.unshift(row);
      writeOutbox(out.slice(0, 100)); // cap
    }
  }


function __sameWorkoutPayload(payload, { dateISO, routineId, dayId }){
  return (
    String(payload?.dateISO || "") === String(dateISO || "") &&
    String(payload?.routineId || "") === String(routineId || "") &&
    String(payload?.dayId || "") === String(dayId || "")
  );
}

async function findExistingWorkoutCompletedEvent({ dateISO, routineId, dayId }){
  const sb = await ensureClient();
  if(!sb || !_user) return null;

  try{
    const { data, error } = await sb
      .from("activity_events")
      .select("id, payload, created_at")
      .eq("actor_id", _user.id)
      .eq("type", "workout_completed")
      .order("created_at", { ascending: false })
      .limit(200);

    if(error) throw error;

    return (data || []).find(row =>
      __sameWorkoutPayload(row?.payload, { dateISO, routineId, dayId })
    ) || null;
  }catch(_){
    return null;
  }
}

function queueSocialOp(op){
  const out = readOutbox();
  out.unshift(op);
  writeOutbox(out.slice(0, 100));
}

  async function syncWorkoutHistoryDate(dateISO){
  const sb = await ensureClient();
  if(!sb || !_user) return;

  const iso = String(dateISO || "").trim();
  if(!iso) return;

  try{
    const { error } = await sb
      .from("workout_history")
      .upsert(
        { user_id: _user.id, date_iso: iso },
        { onConflict: "user_id,date_iso" }
      );

    if(error) throw error;
  }catch(_){}
}

    async function backfillWorkoutHistoryFromLocalLogs(){
    const sb = await ensureClient();
    if(!sb || !_user) return;

    const s = stateRef ? stateRef() : null;
    const logs = Array.isArray(s?.logs?.workouts) ? s.logs.workouts : [];
    if(!logs.length) return;

    const completedDates = Array.from(new Set(
      logs
        .filter(entry =>
          !entry?.skipped &&
          String(entry?.dateISO || "").trim() &&
          String(entry?.routineId || "").trim() &&
          String(entry?.dayId || "").trim()
        )
        .map(entry => String(entry.dateISO || "").trim())
        .filter(Boolean)
    )).sort();

    if(!completedDates.length) return;

    const latestDateISO = completedDates[completedDates.length - 1] || "";
    const nextStamp = `${completedDates.length}|${latestDateISO}`;
    const stampCache = readWorkoutHistorySyncStamp();

    if(String(stampCache?.[_user.id] || "") === nextStamp) return;

    try{
      const rows = completedDates.map(dateISO => ({
        user_id: _user.id,
        date_iso: dateISO
      }));

      const { error } = await sb
        .from("workout_history")
        .upsert(rows, { onConflict: "user_id,date_iso" });

      if(error) throw error;

      const nextCache = { ...(stampCache || {}) };
      nextCache[_user.id] = nextStamp;
      writeWorkoutHistorySyncStamp(nextCache);
    }catch(_){}
  }
  
async function upsertWorkoutCompletedEvent({ dateISO, routineId, dayId, highlights, details }){
  if(!isConfigured()) return;
  await ensureClient();
  if(!_user) return;

  const ev = formatWorkoutCompletedEvent({ dateISO, routineId, dayId, highlights, details });
  const row = {
    actor_id: _user.id,
    type: ev.eventType,
    payload: ev.payload
  };

  const todayISO = Dates.todayISO();

  try{
    const sb = await ensureClient();
    if(!sb) return;

    const existing = await findExistingWorkoutCompletedEvent({ dateISO, routineId, dayId });

          if(existing?.id != null){
        const { error } = await sb
          .from("activity_events")
          .update({ payload: row.payload })
          .eq("id", existing.id)
          .eq("actor_id", _user.id);

        if(error) throw error;
        await syncWorkoutHistoryDate(dateISO);
        fetchFeed();
        return;
      }

    // Only create a brand-new workout feed event for the current calendar day.
    if(String(dateISO || "") !== String(todayISO)) return;

        const { error } = await sb.from("activity_events").insert(row);
    if(error) throw error;
    await syncWorkoutHistoryDate(dateISO);
    fetchFeed();
  }catch(_){
    queueSocialOp({
      op: "upsert_workout_completed",
      actor_id: _user.id,
      type: row.type,
      payload: row.payload
    });
  }
}

async function deleteWorkoutCompletedEvent({ dateISO, routineId, dayId }){
  if(!isConfigured()) return;
  await ensureClient();
  if(!_user) return;

  try{
    const sb = await ensureClient();
    if(!sb) return;

    const existing = await findExistingWorkoutCompletedEvent({ dateISO, routineId, dayId });
    if(!existing?.id) return;

    const { error } = await sb
      .from("activity_events")
      .delete()
      .eq("id", existing.id)
      .eq("actor_id", _user.id);

    if(error) throw error;
    fetchFeed();
  }catch(_){
    queueSocialOp({
      op: "delete_workout_completed",
      actor_id: _user.id,
      payload: {
        dateISO: dateISO || null,
        routineId: routineId || null,
        dayId: dayId || null
      }
    });
  }
}

async function publishWorkoutCompletedEvent({ dateISO, routineId, dayId, highlights, details }){
  await upsertWorkoutCompletedEvent({ dateISO, routineId, dayId, highlights, details });
}

  // flush queued events when online
  window.addEventListener("online", () => { try{ flushOutbox(); }catch(_){} });

  return {
    // wiring
    bindStateGetter,

    // config/auth
    isConfigured,
    getConfig: () => readSocialConfig(),
    configure,
    signInWithOtp,
    signInWithOAuth,   // ← ADD THIS LINE
    signOut,
    refreshUser,
    getUser,
    isSignedIn: () => !!_user,

    // follows + followers + feed
    follow,
    unfollow,
    removeFollower,
    getFollows,
    getFollowers,
    getNotifications,
    fetchNotifications,

    // UI-only helpers (no storage)
    __setNotifications: (arr) => { _notifications = Array.isArray(arr) ? arr : []; notify(); },
    __clearNotifications: () => { _notifications = []; notify(); },
    fetchNames,
    searchProfilesByUsername,
    nameFor,
    usernameFor,
    identityFor,
    fetchFollows,
    fetchFollowers,

    // routine sharing
    getRoutineSharesInbox,
    fetchRoutineSharesInbox,
    shareRoutineWithUser,
    shareRoutineWithUsername,
    dismissRoutineShare,
    markRoutineShareSaved,

    // profile routine
    fetchMyProfileRoutineSetting,
    isProfileRoutineEnabled,
    setPublicRoutineEnabled,
    publishProfileRoutine,
    fetchProfileRoutine,
    fetchProfileFollowCounts,
    fetchProfileWorkoutHighlights,
    fetchWorkoutHistoryDates,
    
    // feed
    getFeed,
    startFeed,
    stopFeed,
    fetchFeed,

    // publishing
    publishLogEvent,
    flushOutbox,
    publishWorkoutCompletedEvent,
    upsertWorkoutCompletedEvent,
    deleteWorkoutCompletedEvent,

    // likes
    getLikeCount,
    didILike,
    fetchFeedLikes,
    fetchFeedLikers,
    toggleFeedLike,

    // comments
    getCommentCount,
    fetchFeedCommentCounts,
    fetchFeedComments,
    addFeedComment,
    deleteFeedComment,

    // UI updates
    onChange,
    __isAuthInFlight: () => !!_authInFlight  
  };
}

const Social = initSocial();
Social.bindStateGetter(() => state);

function getRoutineExerciseEntries(dateISO, routineExerciseId){
  return (state.logs?.workouts || []).filter(e =>
    String(e?.dateISO || "") === String(dateISO || "") &&
    String(e?.routineExerciseId || "") === String(routineExerciseId || "")
  );
}

function hasRoutineExerciseSkipped(dateISO, routineExerciseId){
  return getRoutineExerciseEntries(dateISO, routineExerciseId).some(e => !!e?.skipped);
}

function hasRoutineExerciseLogged(dateISO, routineExerciseId){
  return getRoutineExerciseEntries(dateISO, routineExerciseId).some(e => !e?.skipped);
}

function isRoutineExerciseDone(dateISO, routineExerciseId){
  return hasRoutineExerciseLogged(dateISO, routineExerciseId) ||
         hasRoutineExerciseSkipped(dateISO, routineExerciseId);
}

function clearSkippedRoutineExercise(dateISO, routineExerciseId){
  const before = (state.logs?.workouts || []).length;

  state.logs.workouts = (state.logs.workouts || []).filter(e =>
    !(
      String(e?.dateISO || "") === String(dateISO || "") &&
      String(e?.routineExerciseId || "") === String(routineExerciseId || "") &&
      !!e?.skipped
    )
  );

  if((state.logs.workouts || []).length !== before){
    Storage.save(state);
    return true;
  }

  return false;
}

function markRoutineExerciseSkipped({ dateISO, routineId, day, rx }){
  if(!dateISO || !routineId || !day?.id || !rx?.id) return false;

  if(hasRoutineExerciseLogged(dateISO, rx.id)) return false;

  LogEngine.ensure();

  state.logs.workouts = (state.logs.workouts || []).filter(e =>
    !(
      String(e?.dateISO || "") === String(dateISO || "") &&
      String(e?.routineExerciseId || "") === String(rx.id || "")
    )
  );

  state.logs.workouts.push({
    id: uid("skip"),
    createdAt: Date.now(),
    dateISO,
    type: rx.type,
    exerciseId: rx.exerciseId,
    routineExerciseId: rx.id,
    routineId,
    dayId: day.id,
    dayOrder: day.order,
    nameSnap: rx.nameSnap || resolveExerciseName(rx.type, rx.exerciseId, rx.nameSnap),
    sets: [],
    summary: {},
    pr: {},
    skipped: true
  });

  Storage.save(state);
  return true;
}

function isDayComplete(dateISO, day){
  const ex = (day?.exercises || []);
  if(ex.length === 0) return false;
  return ex.every(rx => isRoutineExerciseDone(dateISO, rx.id));
}

function buildWorkoutEventData(dateISO, routineId, day){
  const entries = (state?.logs?.workouts || []).filter(e =>
    String(e?.dateISO || "") === String(dateISO || "") &&
    String(e?.routineId || "") === String(routineId || "") &&
    String(e?.dayId || "") === String(day?.id || "") &&
    !e?.skipped
  );

  const exSet = new Set();
  let totalVolume = 0;
  let prCount = 0;

  function hasAnyPR(pr){
    try{
      return !!(
        pr?.isPRWeight ||
        pr?.isPR1RM ||
        pr?.isPRVolume ||
        pr?.isPRPace
      );
    }catch(_){
      return false;
    }
  }

  function num(v){
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function bestWeightFromEntry(e){
    try{
      const sets = Array.isArray(e?.sets) ? e.sets : [];
      let best = 0;
      for(const s of sets){
        const w = num(s?.weight);
        if(w > best) best = w;
      }
      if(best > 0) return best;
      return num(e?.summary?.bestWeight);
    }catch(_){
      return 0;
    }
  }

  function bestRepsAtBestWeightFromEntry(e){
    try{
      const sets = Array.isArray(e?.sets) ? e.sets : [];
      let bestWeight = -1;
      let bestReps = 0;

      for(const s of sets){
        const w = num(s?.weight);
        const r = num(s?.reps);
        if(w > bestWeight){
          bestWeight = w;
          bestReps = r;
        }else if(w === bestWeight && r > bestReps){
          bestReps = r;
        }
      }

      return bestReps;
    }catch(_){
      return 0;
    }
  }

  function cardioScore(entry){
    try{
      const s = entry?.summary || {};
      const distance = num(s?.distance);
      const timeSec = num(s?.timeSec);
      const pace = num(s?.paceSecPerUnit);

      return {
        hasPR: hasAnyPR(entry?.pr),
        paceScore: (pace > 0) ? (999999 - pace) : 0,
        distance,
        timeSec
      };
    }catch(_){
      return { hasPR:false, paceScore:0, distance:0, timeSec:0 };
    }
  }

  function coreScore(entry){
    try{
      const s = entry?.summary || {};
      return {
        hasPR: hasAnyPR(entry?.pr),
        totalVolume: num(s?.totalVolume),
        timeSec: num(s?.timeSec),
        reps: num(s?.reps),
        weight: num(s?.weight)
      };
    }catch(_){
      return { hasPR:false, totalVolume:0, timeSec:0, reps:0, weight:0 };
    }
  }

  function compareEntries(a, b){
    const typeA = String(a?.type || "");
    const typeB = String(b?.type || "");

    const aPR = hasAnyPR(a?.pr);
    const bPR = hasAnyPR(b?.pr);
    if(aPR !== bPR) return aPR ? -1 : 1;

    if(typeA === "weightlifting" && typeB === "weightlifting"){
      const aW = bestWeightFromEntry(a);
      const bW = bestWeightFromEntry(b);
      if(bW !== aW) return bW - aW;

      const aR = bestRepsAtBestWeightFromEntry(a);
      const bR = bestRepsAtBestWeightFromEntry(b);
      if(bR !== aR) return bR - aR;

      const aVol = num(a?.summary?.totalVolume);
      const bVol = num(b?.summary?.totalVolume);
      if(bVol !== aVol) return bVol - aVol;

      return 0;
    }

    if(typeA === "cardio" && typeB === "cardio"){
      const A = cardioScore(a);
      const B = cardioScore(b);

      if(B.paceScore !== A.paceScore) return B.paceScore - A.paceScore;
      if(B.distance !== A.distance) return B.distance - A.distance;
      if(B.timeSec !== A.timeSec) return B.timeSec - A.timeSec;

      return 0;
    }

    if(typeA === "core" && typeB === "core"){
      const A = coreScore(a);
      const B = coreScore(b);

      if(B.totalVolume !== A.totalVolume) return B.totalVolume - A.totalVolume;
      if(B.reps !== A.reps) return B.reps - A.reps;
      if(B.timeSec !== A.timeSec) return B.timeSec - A.timeSec;
      if(B.weight !== A.weight) return B.weight - A.weight;

      return 0;
    }

    const aVol = num(a?.summary?.totalVolume);
    const bVol = num(b?.summary?.totalVolume);
    if(bVol !== aVol) return bVol - aVol;

    return 0;
  }

  function buildTopTextFromEntry(e){
    try{
      const type = String(e?.type || "");

      if(type === "weightlifting"){
        const sets = Array.isArray(e?.sets) ? e.sets : [];
        let best = null;

        for(const s of sets){
          const w = num(s?.weight);
          const r = num(s?.reps);
          if(!best || w > best.w || (w === best.w && r > best.r)){
            best = { w, r };
          }
        }

        if(best && best.w > 0) return `${best.w}×${best.r}`;
        if(num(e?.summary?.bestWeight) > 0) return `${num(e.summary.bestWeight)} (top)`;
        return "";
      }

      if(type === "cardio"){
        const d = e?.summary?.distance;
        const t = e?.summary?.timeSec;
        const p = e?.summary?.paceSecPerUnit;
        const dist = (d == null) ? "" : `Dist ${d}`;
        const time = (t == null) ? "" : `Time ${formatTime(num(t) || 0)}`;
        const pace = (p == null) ? "" : `Pace ${formatPace(p)}`;
        return [dist, time, pace].filter(Boolean).join(" • ");
      }

      if(type === "core"){
        const t = e?.summary?.timeSec;
        const reps = e?.summary?.reps;
        const sets = e?.summary?.sets;
        const w = e?.summary?.weight;
        const parts = [];
        if(Number.isFinite(Number(sets))) parts.push(`${Number(sets)} sets`);
        if(Number.isFinite(Number(reps))) parts.push(`${Number(reps)} reps`);
        if(Number.isFinite(Number(t))) parts.push(`${formatTime(Number(t) || 0)}`);
        if(Number.isFinite(Number(w)) && Number(w) > 0) parts.push(`${Number(w)} lb`);
        return parts.join(" • ");
      }

      return "";
    }catch(_){
      return "";
    }
  }

  const byRx = new Map();

  for(const e of entries){
    const key = String(e?.routineExerciseId || e?.exerciseId || "");
    if(!key) continue;

    exSet.add(key);

    if(Number.isFinite(Number(e?.summary?.totalVolume))){
      totalVolume += Number(e.summary.totalVolume) || 0;
    }

    if(!byRx.has(key)) byRx.set(key, []);
    byRx.get(key).push(e);
  }

  let details = null;

  try{
    const items = [];

    for(const [, group] of byRx.entries()){
      const sorted = group.slice().sort(compareEntries);
      const bestEntry = sorted[0] || group[0];
      if(!bestEntry) continue;

      const type = String(bestEntry?.type || "");
      const exerciseId = bestEntry?.exerciseId || null;

      const exName = (() => {
        try{
          const lib = state?.exerciseLibrary?.[type] || [];
          const found = lib.find(x => String(x.id || "") === String(exerciseId || ""));
          return found?.name || bestEntry?.nameSnap || "Exercise";
        }catch(_){
          return bestEntry?.nameSnap || "Exercise";
        }
      })();

      const mergedPRBadges = [];
      try{
        const anyWeight = group.some(x => x?.pr?.isPRWeight);
        const any1RM = group.some(x => x?.pr?.isPR1RM);
        const anyVol = group.some(x => x?.pr?.isPRVolume);
        const anyPace = group.some(x => x?.pr?.isPRPace);

        if(anyWeight) mergedPRBadges.push("PR W");
        if(any1RM) mergedPRBadges.push("PR 1RM");
        if(anyVol) mergedPRBadges.push("PR Vol");
        if(anyPace) mergedPRBadges.push("PR Pace");
      }catch(_){}

      if(mergedPRBadges.length) prCount += 1;

      let lifetime = null;
      try{
        if(LogEngine && typeof LogEngine.lifetimeBests === "function" && exerciseId){
          lifetime = LogEngine.lifetimeBests(type, exerciseId) || null;
        }
      }catch(_){}

      items.push({
        type,
        exerciseId,
        name: exName,
        topText: buildTopTextFromEntry(bestEntry),
        prBadges: mergedPRBadges,
        lifetime
      });
    }

    details = {
      routineName: ((state.routines || []).find(r => String(r.id || "") === String(routineId || ""))?.name || null),
      dayLabel: day?.label || null,
      dateISO: dateISO || null,
      items
    };
  }catch(_){
    details = null;
  }

  return {
    highlights: {
      exerciseCount: exSet.size,
      prCount,
      totalVolume: Math.round(totalVolume * 100) / 100
    },
    details
  };
}

function readPendingWorkoutShareIntent(){
  try{
    return JSON.parse(localStorage.getItem(SOCIAL_PENDING_WORKOUT_SHARE_KEY) || "null");
  }catch(_){
    return null;
  }
}

function writePendingWorkoutShareIntent(payload){
  try{
    if(!payload){
      localStorage.removeItem(SOCIAL_PENDING_WORKOUT_SHARE_KEY);
      return;
    }
    localStorage.setItem(SOCIAL_PENDING_WORKOUT_SHARE_KEY, JSON.stringify(payload));
  }catch(_){}
}

function clearPendingWorkoutShareIntent(){
  try{
    localStorage.removeItem(SOCIAL_PENDING_WORKOUT_SHARE_KEY);
  }catch(_){}
}

function resolveRoutineAndDayForPendingShare(routineId, dayId){
  try{
    const routines = Array.isArray(state?.routines) ? state.routines : [];
    const routine = routines.find(r => String(r?.id || "") === String(routineId || ""));
    if(!routine) return { routine:null, day:null };

    const day = (routine.days || []).find(d => String(d?.id || "") === String(dayId || ""));
    return {
      routine: routine || null,
      day: day || null
    };
  }catch(_){
    return { routine:null, day:null };
  }
}

async function consumePendingWorkoutShareAfterAuth(){
  try{
    if(__pendingWorkoutShareReplayBusy) return false;
    if(!Social || typeof Social.getUser !== "function" || !Social.getUser()) return false;

    const pending = readPendingWorkoutShareIntent();
    if(!pending) return false;

    const createdAt = Number(pending?.createdAt || 0) || 0;
    const ageMs = Date.now() - createdAt;
    const maxAgeMs = 15 * 60 * 1000;

    if(!createdAt || ageMs < 0 || ageMs > maxAgeMs){
      clearPendingWorkoutShareIntent();
      return false;
    }

    const dateISO = String(pending?.dateISO || "");
    const routineId = String(pending?.routineId || "");
    const dayId = String(pending?.dayId || "");

    if(!dateISO || !routineId || !dayId){
      clearPendingWorkoutShareIntent();
      return false;
    }

    if(dateISO !== String(Dates.todayISO())){
      clearPendingWorkoutShareIntent();
      return false;
    }

    const resolved = resolveRoutineAndDayForPendingShare(routineId, dayId);
    const day = resolved?.day || null;

    if(!day){
      clearPendingWorkoutShareIntent();
      return false;
    }

    if(!isDayComplete(dateISO, day)){
      clearPendingWorkoutShareIntent();
      return false;
    }

    __pendingWorkoutShareReplayBusy = true;

    const posted = await syncWorkoutCompletedEventForDay(dateISO, routineId, day);
    if(!posted) return false;

    clearPendingWorkoutShareIntent();

    try{ showToast("Workout shared to feed"); }catch(_){}
    return true;
  }catch(_){
    return false;
  }finally{
    __pendingWorkoutShareReplayBusy = false;
  }
}

async function maybePromptWorkoutFeedShare(dateISO, routineId, day){
  try{
    if(!Social) return;
    if(!Social.isConfigured?.()) return;
    if(Social.getUser?.()) return;
    if(!isDayComplete(dateISO, day)) return;
    if(String(dateISO || "") !== String(Dates.todayISO())) return;

    const routineName = (() => {
      try{
        return ((state.routines || []).find(r =>
          String(r?.id || "") === String(routineId || "")
        )?.name || "this workout");
      }catch(_){
        return "this workout";
      }
    })();

    Modal.open({
      title: "Share to Feed?",
      size: "sm",
      bodyNode: el("div", { class:"grid" }, [
        el("div", {
          style:"font-weight:900; font-size:14px;",
          text:"Would you like to share it to the feed?"
        }),
        el("div", {
          class:"note",
          text:`You’ll go to Friends to sign in first, then we’ll share ${routineName}.`
        }),
        el("div", { style:"height:8px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn primary",
            onClick: () => {
              writePendingWorkoutShareIntent({
                source: "workout_complete_prompt",
                dateISO: String(dateISO || ""),
                routineId: String(routineId || ""),
                dayId: String(day?.id || ""),
                createdAt: Date.now()
              });

              Modal.close();
              navigate("friends");

              try{
                showToast("Continue with Google to share your workout");
              }catch(_){}
            }
          }, ["Yes"]),
          el("button", {
            class:"btn",
            onClick: () => Modal.close()
          }, ["No"])
        ])
      ])
    });
  }catch(_){}
}

async function syncWorkoutCompletedEventForDay(dateISO, routineId, day){
  try{
    if(!Social) return false;

    const safeDayId = day?.id || null;
    if(!dateISO || !routineId || !safeDayId) return false;

    if(!isDayComplete(dateISO, day)){
      if(typeof Social.deleteWorkoutCompletedEvent === "function"){
        await Social.deleteWorkoutCompletedEvent({
          dateISO,
          routineId,
          dayId: safeDayId
        });
      }

      try{ await Social.fetchFeed?.(); }catch(_){}
      return true;
    }

    if(typeof Social.upsertWorkoutCompletedEvent !== "function") return false;

    const data = buildWorkoutEventData(dateISO, routineId, day);

    await Social.upsertWorkoutCompletedEvent({
      dateISO,
      routineId,
      dayId: safeDayId,
      highlights: data?.highlights || {},
      details: data?.details || null
    });

    try{ await Social.fetchFeed?.(); }catch(_){}
    return true;
  }catch(_){
    return false;
  }
}


// 1) Init Backup FIRST so we have the functions
const Backup = initBackup({
  getState: () => state,
  setState: (next) => { state = next; },
  Storage,
  BackupVault,
  migrateState
});

const {
  downloadTextFile,
  exportBackupJSON,
  validateImportedState,
  importBackupJSON
} = Backup;

// 2) Init Settings AFTER backup functions exist
const Settings = initSettings({
  getState: () => state,
  Storage,
  Modal,
  el,
  $,
  showToast,
  appStorageBytes,
  bytesToNice,
  exportBackupJSON,
  importBackupJSON,
  downloadTextFile,
  openVersionModal
});

const { renderSettingsView } = Settings;

const Logs = initLogs({ getState: () => state, Storage, uid });

const { LogEngine, removeWorkoutEntryById } = initWorkouts({ getState: () => state, Storage, Social });


const Attendance = initAttendance({
  getState: () => state,
  Storage,
  LogEngine,
  el
});

const {
  attendanceHas,
  attendanceAdd,
  attendanceRemove,
  hasRoutineExerciseLog,
  lifetimeMaxSet,
  setNextNudge,
  ensureFloatNext,
  maybeShowNextNudge,
  bindFloatNext,
  clearNextNudge
} = Attendance;

const {
  round2,
  formatTime,
  formatPace,
  destroyProgressChart,
  downloadCanvasPNG,
  buildSeries,
  renderProgressChart,
  WeightEngine,
  destroyWeightChart,
  renderWeightChart
} = initProgress({ getState: () => state, Storage, uid, Dates, Modal, el });

const {
  findProteinEntry,
  ensureProteinEntry,
  cleanupProteinEntryIfEmpty,
  getProteinForDate,
  upsertMeal
} = Logs.protein;



// Provide live state ref to versioning module so it can flush safely before reload/update
initVersioning({ getStateRef: () => state });

// Phase 2.2: Ensure debounced writes are not lost on iOS/tab close/background
try{
  document.addEventListener("visibilitychange", () => {
    if(document.visibilityState === "hidden"){
      try{ Storage.flush(state); }catch(_){}
    }
  });
  window.addEventListener("pagehide", () => {
    try{ Storage.flush(state); }catch(_){}
  });
  window.addEventListener("beforeunload", () => {
    try{ Storage.flush(state); }catch(_){}
  });
}catch(_){}



const UIState = window.__GymDashUIState || (window.__GymDashUIState = {
  settings: {
  q: "",
  open: { "profile": true, "library": false, "backup": false, "data": false, "support": false, "routines": false }
},
  libraryManage: {
    q: "",
    type: "weightlifting",
    equipment: "all"
  },

  // Home-only UI prefs (safe: does not touch app state schema)
  home: {
    // Default collapsed for Today’s workout planned list
    todayWorkoutCollapsed: true
  }
});


    function getTodayWorkout(){
      const routine = Routines.getActive();
      if(!routine || !(routine.days?.length)) return { routine: null, day: null, dayIndex: null };

      const today = new Date();
      const idx = today.getDay(); // 0=Sun..6=Sat
      // Our routine days are stored order 0..6 (Day 1..Day 7)
      const day = routine.days.find(d => d.order === idx) || routine.days[idx] || null;
      return { routine, day, dayIndex: idx };
    }

/********************
 * Attendance Calendar UI (Phase 3.5) — moved to /app/attendance-ui.js
 ********************/
const AttendanceUI = initAttendanceUI({
  getState: () => state,
  Storage,
  pad2
});

const {
  isTrained,
  toggleTrained,
  ymFromISO,
  monthTitle,
  daysInMonth,
  firstDayDow,
  isoForYMD,
  AttendanceEngine
} = AttendanceUI;

// ─────────────────────────────
// Phase 3.2: Exercise Library + Templates extracted to /app/library.js
// ─────────────────────────────
const Library = initLibrary({
  getState: () => state,
  Storage,
  uid
});

const {
  ExerciseLibrary,
  RoutineTemplates,
  createRoutineFromTemplate,
  repairExerciseLinks,
  normName
} = Library;

/********************
 * 4b) Routine Engine (Step 4) — moved to /app/routines.js
 ********************/
const { Routines, resolveExerciseName } = initRoutinesEngine({
  getState: () => state,
  Storage,
  uid,
  ExerciseLibrary,
  RoutineTemplates,
  createRoutineFromTemplate
});

async function syncPublicRoutineAfterActiveChange(){
  try{
    if(!(Social && Social.isConfigured && Social.isConfigured())) return;
    if(!(Social && Social.getUser && Social.getUser())) return;

    const enabled = (Social.isProfileRoutineEnabled && Social.isProfileRoutineEnabled())
      ? true
      : await (Social.fetchMyProfileRoutineSetting ? Social.fetchMyProfileRoutineSetting() : Promise.resolve(false));

    if(!enabled) return;

    const active = (Routines && typeof Routines.getActive === "function")
      ? Routines.getActive()
      : null;

    if(!active) return;

    await Social.publishProfileRoutine?.(active);
  }catch(_){}
}

async function setActiveRoutineAndSync(routineId){
  Routines.setActive(routineId);
  await syncPublicRoutineAfterActiveChange();
  return Routines.getActive();
}

async function addRoutineFromTemplateAndSync(templateKey, nameOverride){
  const routine = Routines.addFromTemplate(templateKey, nameOverride);
  await syncPublicRoutineAfterActiveChange();
  return routine;
}

function buildRoutineSnapshotMeta(snapshot){
  const days = Array.isArray(snapshot?.days) ? snapshot.days : [];
  let exerciseCount = 0;

  days.forEach(day => {
    exerciseCount += Array.isArray(day?.exercises) ? day.exercises.length : 0;
  });

  return {
    dayCount: days.length,
    exerciseCount
  };
}

function getUniqueSharedRoutineName(baseName){
  const rawBase = String(baseName || "Routine").trim() || "Routine";
  const all = Array.isArray(state?.routines) ? state.routines : [];
  const used = new Set(
    all.map(r => String(r?.name || "").trim().toLowerCase()).filter(Boolean)
  );

  if(!used.has(rawBase.toLowerCase())) return rawBase;

  const firstAlt = `${rawBase} (Shared)`;
  if(!used.has(firstAlt.toLowerCase())) return firstAlt;

  let i = 2;
  while(used.has(`${rawBase} (Shared ${i})`.toLowerCase())) i++;
  return `${rawBase} (Shared ${i})`;
}

function importSharedRoutinePayload(sharedPayload, opts = {}){
  const snapshot = sharedPayload?.routinePayload
    ? sharedPayload.routinePayload
    : sharedPayload;

  if(!snapshot || typeof snapshot !== "object"){
    throw new Error("Shared routine is invalid.");
  }

  if(!Array.isArray(snapshot.days) || snapshot.days.length === 0){
    throw new Error("Shared routine has no days.");
  }

  state.routines = Array.isArray(state.routines) ? state.routines : [];

  const sortedDays = snapshot.days
    .slice()
    .sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0));

  const routineId = uid("rt");
  const now = Date.now();

  const nextRoutine = {
    id: routineId,
    name: getUniqueSharedRoutineName(snapshot.name || "Routine"),
    createdAt: now,
    templateKey: null,
    days: sortedDays.map((day, dayIdx) => ({
      id: uid("day"),
      order: Number.isFinite(Number(day?.order)) ? Number(day.order) : dayIdx,
      label: String(day?.label || `Day ${dayIdx + 1}`),
      isRest: !!day?.isRest,
      exercises: (Array.isArray(day?.exercises) ? day.exercises : []).map((rx, exIdx) => ({
        id: uid("rx"),
        exerciseId: rx?.exerciseId || null,
        type: String(rx?.type || ""),
        nameSnap: String(rx?.name || rx?.nameSnap || "Exercise"),
        plan: rx?.plan || null,
        notes: String(rx?.notes || ""),
        createdAt: now + exIdx
      }))
    }))
  };

  state.routines.push(nextRoutine);

  if(opts && opts.setActive){
    state.activeRoutineId = nextRoutine.id;
  }

  Storage.save(state);
  return nextRoutine;
}

/********************
 * 4c) Protein UI (Step 4) — moved to /app/protein-ui.js
 ********************/


/********************
 * 🔥 Crash Failsafe (prevents blank UI)
 ********************/
function __formatErr(err){
  try{
    if(!err) return "Unknown error";
    if(typeof err === "string") return err;
    if(err instanceof Error) return `${err.name}: ${err.message}\n${err.stack || ""}`.trim();
    return JSON.stringify(err, null, 2);
  }catch(e){
    return "Unrenderable error";
  }
}

function __showFatalOverlay(title, detail){
  try{
    // avoid duplicates
    const existing = document.getElementById("fatalOverlay");
    if(existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "fatalOverlay";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:9999",
      "background:rgba(11,15,23,.94)",
      "backdrop-filter: blur(12px)",
      "color:rgba(255,255,255,.92)",
      "padding:18px",
      "display:flex",
      "align-items:center",
      "justify-content:center"
    ].join(";");

    const card = document.createElement("div");
    card.style.cssText = [
      "width:min(720px, 92vw)",
      "border:1px solid rgba(255,255,255,.14)",
      "background:rgba(255,255,255,.06)",
      "border-radius:18px",
      "box-shadow:0 22px 70px rgba(0,0,0,.65)",
      "padding:16px"
    ].join(";");

    const h = document.createElement("div");
    h.textContent = title || "App error";
    h.style.cssText = "font-weight:900; font-size:16px; letter-spacing:.2px; margin-bottom:10px;";

    const p = document.createElement("div");
    p.textContent = "The app hit an error and stopped rendering. Copy the details below and send it to yourself.";
    p.style.cssText = "color:rgba(255,255,255,.68); font-size:13px; line-height:1.35; margin-bottom:12px;";

    const pre = document.createElement("pre");
    pre.textContent = detail || "No details available";
    pre.style.cssText = [
      "white-space:pre-wrap",
      "word-break:break-word",
      "margin:0",
      "padding:12px",
      "border-radius:14px",
      "border:1px solid rgba(255,255,255,.12)",
      "background:rgba(0,0,0,.22)",
      "color:rgba(255,255,255,.86)",
      "font-size:12px",
      "line-height:1.35",
      "max-height:52vh",
      "overflow:auto"
    ].join(";");

    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:10px; margin-top:12px; flex-wrap:wrap;";

    const btnReload = document.createElement("button");
    btnReload.className = "btn primary";
    btnReload.textContent = "Reload app";
    btnReload.onclick = () => location.reload();

    const btnClose = document.createElement("button");
    btnClose.className = "btn";
    btnClose.textContent = "Dismiss";
    btnClose.onclick = () => overlay.remove();

    row.appendChild(btnReload);
    row.appendChild(btnClose);

    card.appendChild(h);
    card.appendChild(p);
    card.appendChild(pre);
    card.appendChild(row);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }catch(e){
    // last resort: at least log
    console.error("Fatal overlay failed:", e);
  }
}

function __fatal(err, context){
  const detail = `[${context || "runtime"}]\n` + __formatErr(err);
  console.error("FATAL:", detail);
  __showFatalOverlay("Gym Dashboard crashed", detail);
}

// Catch synchronous runtime errors
window.addEventListener("error", (ev) => {
  __fatal(ev?.error || ev?.message || ev, "window.error");
});

// Catch async errors (Promise rejections)
window.addEventListener("unhandledrejection", (ev) => {
  __fatal(ev?.reason || ev, "unhandledrejection");
});

/********************
* 6) Router (extracted to router.js)
********************/

// IMPORTANT: Protein UI needs navigate(), but Router wiring happens later (after Views exist).
// If we reference `const navigate` before it’s initialized, JS throws a TDZ ReferenceError.
// So we define a safe placeholder here and assign the real Router.navigate in the 7b block.
let navigate = (route) => {
  try{
    // fallback behavior if called extremely early (should be rare)
    const r = String(route || "").replace(/^#/, "");
    if(r) location.hash = `#${r}`;
  }catch(_){}
};

/********************
 * 6b) Protein UI wiring (Phase 3.4)
 ********************/
const ProteinUI = initProteinUI({
  getState: () => state,
  Storage,
  Dates,
  Modal,
  el,
  $,

  // ✅ IMPORTANT: pass a wrapper so ProteinUI always uses the latest `navigate`
  // (the variable is reassigned later to Router.navigate)
  navigate: (route) => navigate(route),

  UIState,
  showToast,

  findProteinEntry,
  cleanupProteinEntryIfEmpty,
  upsertMeal
});

const { buildProteinTodayModal, deleteMeal, totalProtein } = ProteinUI;


/********************
     * 7) Views
********************/
let openExerciseLoggerRef = null;
 
const Views = {   
   Onboarding(){
  let hideRestDays = true;
  let selectedTpl = "ppl";
  let trackProtein = true;

  const errorBox = el("div", { class:"note", style:"display:none; color: rgba(255,92,122,.95);" });

  const switchNode = el("div", { class:"switch on" });
  switchNode.addEventListener("click", () => {
    hideRestDays = !hideRestDays;
    switchNode.classList.toggle("on", hideRestDays);
  });

  const proteinSwitchNode = el("div", { class:"switch on" });

  const tplCardsHost = el("div", { class:"tplGrid" });
  const renderTplCards = () => {
    tplCardsHost.innerHTML = "";
    RoutineTemplates.forEach(t => {
      tplCardsHost.appendChild(el("div", {
        class: "tpl" + (t.key === selectedTpl ? " selected" : ""),
        onClick: () => { selectedTpl = t.key; renderTplCards(); }
      }, [
        el("div", { class:"name", text: t.name }),
        el("div", { class:"desc", text: t.desc })
      ]));
    });
  };
  renderTplCards();

  const nameInput = el("input", { type:"text", placeholder:"Jordan" });

  const usernameInput = el("input", {
    type:"text",
    placeholder:"jordand",
    autocapitalize:"off",
    autocorrect:"off",
    spellcheck:"false"
  });

  usernameInput.addEventListener("input", () => {
    usernameInput.value = normalizeUsername(usernameInput.value);
  });

  let onboardingUsernameCheckSeq = 0;
  let onboardingUsernameCheckTimer = null;
  let onboardingLastUsernameChecked = "";
  let onboardingUsernameStatus = "idle"; // idle | checking | available | taken | invalid
  let onboardingUsernameOwnerId = null;

  const onboardingUsernameStatusNode = el("div", {
    class:"meta",
    style:"margin-top:6px; min-height:18px;"
  });

  function paintOnboardingUsernameStatus(){
    const current = normalizeUsername(usernameInput.value);
    const mine = String(Social.getUser?.()?.id || "");

    if(!current){
      onboardingUsernameStatusNode.textContent = "3–20 letters, numbers, or underscores.";
      onboardingUsernameStatusNode.style.color = "";
      return;
    }

    if(onboardingUsernameStatus === "invalid"){
      onboardingUsernameStatusNode.textContent = "Use 3–20 lowercase letters, numbers, or underscores.";
      onboardingUsernameStatusNode.style.color = "rgba(255,92,122,.95)";
      return;
    }

    if(onboardingUsernameStatus === "checking"){
      onboardingUsernameStatusNode.textContent = "Checking availability…";
      onboardingUsernameStatusNode.style.color = "";
      return;
    }

    if(onboardingUsernameStatus === "taken"){
      onboardingUsernameStatusNode.textContent = "Username is already taken.";
      onboardingUsernameStatusNode.style.color = "rgba(255,92,122,.95)";
      return;
    }

    if(onboardingUsernameStatus === "available"){
      if(onboardingUsernameOwnerId && mine && onboardingUsernameOwnerId === mine){
        onboardingUsernameStatusNode.textContent = "This is your current username.";
        onboardingUsernameStatusNode.style.color = "";
        return;
      }
      onboardingUsernameStatusNode.textContent = "Username is available.";
      onboardingUsernameStatusNode.style.color = "rgba(46,204,113,.95)";
      return;
    }

    onboardingUsernameStatusNode.textContent = "Shown in Friends as @username.";
    onboardingUsernameStatusNode.style.color = "";
  }

  async function checkOnboardingUsernameAvailabilityLive(opts = {}){
    const force = !!opts.force;
    const mine = String(Social.getUser?.()?.id || "");
    const current = normalizeUsername(usernameInput.value);

    if(!force && current === onboardingLastUsernameChecked) return;
    onboardingLastUsernameChecked = current;

    const seq = ++onboardingUsernameCheckSeq;

    if(!current){
      onboardingUsernameStatus = "idle";
      onboardingUsernameOwnerId = null;
      paintOnboardingUsernameStatus();
      return;
    }

    if(!isValidUsername(current)){
      onboardingUsernameStatus = "invalid";
      onboardingUsernameOwnerId = null;
      paintOnboardingUsernameStatus();
      return;
    }

    onboardingUsernameStatus = "checking";
    onboardingUsernameOwnerId = null;
    paintOnboardingUsernameStatus();

    const ownerId = await getUsernameOwnerId(current);
    if(seq !== onboardingUsernameCheckSeq) return;

    onboardingUsernameOwnerId = ownerId;
    if(ownerId && (!mine || ownerId !== mine)){
      onboardingUsernameStatus = "taken";
    }else{
      onboardingUsernameStatus = "available";
    }

    paintOnboardingUsernameStatus();
  }

  function queueOnboardingUsernameAvailabilityCheck(){
    if(onboardingUsernameCheckTimer) clearTimeout(onboardingUsernameCheckTimer);
    onboardingUsernameCheckTimer = setTimeout(() => {
      checkOnboardingUsernameAvailabilityLive().catch(() => {});
    }, 250);
  }

  usernameInput.addEventListener("input", () => {
    queueOnboardingUsernameAvailabilityCheck();
  });

  paintOnboardingUsernameStatus();

  const proteinInput = el("input", { type:"number", inputmode:"numeric", placeholder:"180", min:"0" });

  const weekSelect = el("select", {});
  weekSelect.appendChild(el("option", { value:"mon", text:"Monday" }));
  weekSelect.appendChild(el("option", { value:"sun", text:"Sunday" }));
  weekSelect.value = "mon";

  const proteinLabel = el("label", {}, [
    el("span", { text:"Protein goal (grams/day)" }),
    proteinInput
  ]);

  proteinSwitchNode.addEventListener("click", () => {
    trackProtein = !trackProtein;
    proteinSwitchNode.classList.toggle("on", trackProtein);
    proteinLabel.style.display = trackProtein ? "" : "none";

    if(!trackProtein){
      errorBox.style.display = "none";
      errorBox.textContent = "";
    }
  });

  async function finish(){
    errorBox.style.display = "none";
    errorBox.textContent = "";

    const cleanName = (nameInput.value || "").trim();
    const cleanUsername = normalizeUsername(usernameInput.value);
    const cleanProtein = Number(proteinInput.value);
    const weekStartsOn = weekSelect.value === "sun" ? "sun" : "mon";

    if(!cleanName){
      errorBox.textContent = "Please enter your name.";
      errorBox.style.display = "block";
      return;
    }

    if(!isValidUsername(cleanUsername)){
      onboardingUsernameStatus = "invalid";
      onboardingUsernameOwnerId = null;
      paintOnboardingUsernameStatus();

      errorBox.textContent = "Choose a username with 3–20 letters, numbers, or underscores.";
      errorBox.style.display = "block";
      return;
    }

    if(onboardingUsernameCheckTimer){
      clearTimeout(onboardingUsernameCheckTimer);
      onboardingUsernameCheckTimer = null;
    }

    await checkOnboardingUsernameAvailabilityLive({ force:true });

    if(onboardingUsernameStatus === "taken"){
      errorBox.textContent = "That username is already taken.";
      errorBox.style.display = "block";
      return;
    }

    const ownerId = await getUsernameOwnerId(cleanUsername);
    const mine = String(Social.getUser?.()?.id || "");
    if(ownerId && (!mine || ownerId !== mine)){
      onboardingUsernameStatus = "taken";
      onboardingUsernameOwnerId = ownerId;
      paintOnboardingUsernameStatus();

      errorBox.textContent = "That username is already taken.";
      errorBox.style.display = "block";
      return;
    }

    if(trackProtein){
      if(!Number.isFinite(cleanProtein) || cleanProtein <= 0){
        errorBox.textContent = "Please enter a valid daily protein goal (grams).";
        errorBox.style.display = "block";
        return;
      }
    }

    const profile = {
      name: cleanName,
      username: cleanUsername,
      proteinGoal: trackProtein ? Math.round(cleanProtein) : 0,
      weekStartsOn,
      hideRestDays: !!hideRestDays,
      goals: {
        weeklySessionsTarget: 4,
        targetWeight: null,
        items: []
      },
      show3DPreview: true
    };

    ExerciseLibrary.ensureSeeded();

    const routineName = RoutineTemplates.find(t => t.key === selectedTpl)?.name || "Routine";
    const routine = createRoutineFromTemplate(selectedTpl, routineName);

    state.profile = profile;
    state.routines = [routine];
    state.activeRoutineId = routine.id;

    repairExerciseLinks();

    Storage.save(state);
    navigate("home");
    bindHeaderPills();
    setHeaderPills();
    checkForUpdates();
  }

  proteinLabel.style.display = trackProtein ? "" : "none";

  return el("div", { class:"grid" }, [
    el("div", { class:"card" }, [
      el("h2", { text:"Welcome" }),
      el("div", { class:"kpi" }, [
        el("div", { class:"big", text:"Let’s set up your dashboard" }),
        el("div", { class:"small", text:"Create your profile and choose a routine template. You can edit everything later." })
      ])
    ]),

    el("div", { class:"card" }, [
      el("h2", { text:"Create profile" }),
      el("div", { class:"form" }, [
        el("div", { class:"row2" }, [
          el("label", {}, [
            el("span", { text:"Name" }),
            nameInput
          ]),
          el("label", {}, [
            el("span", { text:"Username" }),
            usernameInput,
            onboardingUsernameStatusNode
          ])
        ]),
        el("div", { class:"row2" }, [
          proteinLabel,
          el("label", {}, [ el("span", { text:"Week starts on" }), weekSelect ])
        ]),
        el("div", {}, [
          el("div", { class:"toggle" }, [
            el("div", { class:"ttext" }, [
              el("div", { class:"a", text:"Track protein" }),
              el("div", { class:"b", text:"Optional — turn off if you don’t want protein goals right now" })
            ]),
            proteinSwitchNode
          ]),
          el("div", { style:"height:10px" }),
          el("div", { class:"toggle" }, [
            el("div", { class:"ttext" }, [
              el("div", { class:"a", text:"Hide rest days" }),
              el("div", { class:"b", text:"Rest days won’t appear on Home (Routine can still show them later)" })
            ]),
            switchNode
          ])
        ]),
        errorBox
      ])
    ]),

    el("div", { class:"card" }, [
      el("h2", { text:"Choose a routine template" }),
      tplCardsHost,
      el("div", { style:"height:10px" }),
      el("div", { class:"btnrow" }, [
        el("button", {
          class:"btn primary",
          onClick: () => {
            finish().catch((e) => {
              errorBox.textContent = String(e?.message || "Could not finish setup.");
              errorBox.style.display = "block";
            });
          }
        }, ["Finish setup"]),
        el("button", {
          class:"btn danger",
          onClick: () => {
            Modal.open({
              title: "Reset local data",
              bodyNode: el("div", {}, [
                el("div", { class:"note", text:"This clears everything saved in this browser for the app." }),
                el("div", { style:"height:12px" }),
                el("div", { class:"btnrow" }, [
                  el("button", {
                    class:"btn danger",
                    onClick: () => {
                      try{ BackupVault.forceSnapshot(state, "pre-reset"); }catch(_){}
                      Storage.reset();
                      state = Storage.load();
                      Modal.close();
                      navigate("home");
                    }
                  }, ["Reset"]),
                  el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
                ])
              ])
            });
          }
        }, ["Reset"])
      ])
    ])
  ]);
},

        Home(){
        ExerciseLibrary.ensureSeeded();
        WeightEngine.ensure();


        const todayISO = Dates.todayISO();
        const weekStartsOn = state.profile?.weekStartsOn || "mon";
        const weekStartISO = Dates.startOfWeekISO(todayISO, weekStartsOn);

        const { routine, day } = getTodayWorkout();

        const trainedThisWeek = [];
        for(let i=0;i<7;i++){
          const dISO = Dates.addDaysISO(weekStartISO, i);
          trainedThisWeek.push({ dateISO: dISO, trained: isTrained(dISO) });
        }

        // Protein
        const goal = Number(state.profile?.proteinGoal) || 0;
        const done = totalProtein(todayISO);
        const left = Math.max(0, goal - done);
        const pct = goal > 0 ? Math.max(0, Math.min(1, done / goal)) : 0;
        const deg = Math.round(pct * 360);

const openProteinModal = (dateISO = todayISO) => {
  Modal.open({
    title: "Protein",
    bodyNode: buildProteinTodayModal(dateISO, goal)
  });
};


        const openCheckIn = () => {
          toggleTrained(todayISO);
          renderView();
        };

        const workoutTitle = !routine ? "No routine selected"
          : (!day ? "No day found"
          : (day.isRest ? "Rest Day" : day.label));

        const workoutSub = !routine ? "Go to Routine → create/select a routine."
          : (!day ? "Open Routine Editor to fix day mapping."
          : (day.isRest ? "Recovery day. Hydrate + mobility."
          : `${(day.exercises || []).length} exercises planned`));

        const workoutExercises = (day?.isRest || !day) ? []
      : (day.exercises || []).slice(0, 6).map(rx => ({
          rx,
          exName: resolveExerciseName(rx.type, rx.exerciseId, rx.nameSnap),
          logged: hasRoutineExerciseLog(todayISO, rx.id)
        }));

        const ring = el("div", {
          class:"ringWrap",
          style: `background: conic-gradient(rgba(124,92,255,.95) 0deg ${deg}deg, rgba(255,255,255,.10) ${deg}deg 360deg);`
        }, [
          el("div", { class:"ringText" }, [
            el("div", { class:"big", text: `${left}g` }),
            el("div", { class:"small", text: "left" }),
            el("div", { class:"small", text: `${done} / ${goal}g` })
          ])
        ]);

        const dots = el("div", { class:"dots" });
        trainedThisWeek.forEach((d, idx) => {
          const dot = el("div", { class:"dotDay" + (d.trained ? " on" : "") });
          dots.appendChild(dot);
        });

        // Build week date range label (ex: Mar 1st – Mar 7th)
        function ordinal(n){
          const s = ["th","st","nd","rd"];
          const v = n % 100;
          return n + (s[(v-20)%10] || s[v] || s[0]);
        }
        
        function formatWeekRange(startISO){
          const start = new Date(startISO);
          const end = new Date(startISO);
          end.setDate(end.getDate() + 6);
        
          const monthFmt = { month:"short" };
        
          const startMonth = start.toLocaleString(undefined, monthFmt);
          const endMonth = end.toLocaleString(undefined, monthFmt);
        
          const startDay = ordinal(start.getDate());
          const endDay = ordinal(end.getDate());
        
          if(startMonth === endMonth){
            return `${startMonth} ${startDay} – ${endDay}`;
          }
        
          return `${startMonth} ${startDay} – ${endMonth} ${endDay}`;
        }
        
        const weekRangeLabel = formatWeekRange(weekStartISO);

        const wLatest = WeightEngine.latest();
        const wPrev = WeightEngine.previous();
        const wDelta = (wLatest && wPrev)
          ? (Number(wLatest.weight) - Number(wPrev.weight))
          : null;

        const wDeltaText = (wDelta === null || !Number.isFinite(wDelta))
          ? "—"
          : `${wDelta > 0 ? "+" : ""}${wDelta.toFixed(1)}`;

        return el("div", { class:"grid cols2" }, [
          el("div", { class:"card" }, [
  // Header row with collapse toggle
  el("div", { class:"cardHeadRow" }, [
    el("h2", { text:"Today’s workout" }),

    (() => {
      // Ensure home UI state exists + default collapsed
      UIState.home = UIState.home || {};
      if(typeof UIState.home.todayWorkoutCollapsed !== "boolean"){
        UIState.home.todayWorkoutCollapsed = true;
      }

      const label = UIState.home.todayWorkoutCollapsed ? "Show ▸" : "Hide ▾";

      return el("button", {
        class:"btn sm ghost",
        onClick: () => {
          UIState.home.todayWorkoutCollapsed = !UIState.home.todayWorkoutCollapsed;
          renderView();
        }
      }, [label]);
    })()
  ]),

  // ✅ KPI + action (Edit routine) on the same row
  el("div", { class:"homeRow" }, [
    el("div", { class:"kpi" }, [
      el("div", { class:"big", text: workoutTitle }),
      el("div", { class:"small", text: workoutSub })
    ]),
    el("button", {
      class:"btn",
      onClick: () => navigate("routine")
    }, ["Edit routine"])
  ]),

  // Collapsible body (planned exercises)
  (() => {
    UIState.home = UIState.home || {};
    if(typeof UIState.home.todayWorkoutCollapsed !== "boolean"){
      UIState.home.todayWorkoutCollapsed = true;
    }

    return el("div", {
      class:"collapseBody",
      style: UIState.home.todayWorkoutCollapsed ? "display:none;" : ""
    }, [
      el("div", { style:"height:10px" }),

      /* Planned exercises */
(workoutExercises.length === 0)
  ? el("div", {
      class:"note",
      text: day?.isRest ? "Rest day is enabled." : "Add exercises in Routine Editor."
    })
  : el("div", { class:"list" }, workoutExercises.map(({ rx, exName, logged }) =>
      el("button", {
        type:"button",
        class:"item",

        onClick: () => {
  if(typeof openExerciseLoggerRef === "function"){
    openExerciseLoggerRef(rx, day, todayISO);
    return;
  }
  navigate("routine");
},
        style:[
        "width:100%",
        "display:flex",
        "align-items:center",
        "justify-content:space-between",
        "gap:12px",
        "text-align:left",
        "background:rgba(255,255,255,.03)",
        "border:1px solid rgba(255,255,255,.08)",
        "cursor:pointer",
        "color:#fff"
      ].join(";")
      }, [
        el("div", { class:"left" }, [
          el("div", { class:"name", text: exName }),
          el("div", { class:"meta", text:"Tap to log sets" })
        ]),
        el("div", { class:"actions" }, [
          el("div", {
            style: [
              "display:inline-flex",
              "align-items:center",
              "justify-content:center",
              "min-width:84px",
              "padding:6px 10px",
              "border-radius:999px",
              "font-size:12px",
              "font-weight:800",
              logged
                ? "background:rgba(46,204,113,.14); border:1px solid rgba(46,204,113,.28); color:rgba(46,204,113,.98);"
                : "background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.10); color:rgba(255,255,255,.72);"
            ].join(";"),
            text: logged ? "✓ Logged" : "Planned"
          })
        ])
      ])
    ))
    ]);
  })()
]),

// ✅ Removed from Today's Workout card:
// el("div", { style:"height:10px" }),
// el("div", { class:"btnrow" }, [
//   el("button", { class:"btn primary", onClick: openCheckIn }, [isTrained(todayISO) ? "Undo check-in" : "Check in"]),
//   el("button", { class:"btn", onClick: () => navigate("routine") }, ["Open Routine"])
// ])

// ✅ This Week — combined card (Attendance + Weight + Protein if enabled)
(() => {
  const sessionsThisWeek = trainedThisWeek.filter(x => x.trained).length;

  const sep = () => el("div", {
    style:"height:1px; background: rgba(255,255,255,.10); margin: 12px 0;"
  });

  return el("div", { class:"card" }, [
    el("div", {
  style:"display:flex; align-items:baseline; justify-content:space-between; gap:10px;"
}, [
  el("div", {
    style:"display:flex; align-items:center; gap:10px;"
  }, [
    el("h2", { text:"This Week" }),
    el("h2", { class:"note", text:`| ${weekRangeLabel}` })
  ])
]),

    // Attendance section
    el("div", { class:"homeRow" }, [
      el("div", { class:"kpi" }, [
        el("div", { class:"big", text: `${sessionsThisWeek} sessions` }),
        el("div", { class:"small", text:"Tap the dots to view your calendar." })
      ]),
      el("button", {
        class:"btn primary",
        onClick: openCheckIn
      }, [isTrained(todayISO) ? "Undo check-in" : "Check in"])
    ]),

        el("div", { style:"height:10px" }),

    // Week labels + dots aligned perfectly
el("div", { style:"display:flex; flex-direction:column; gap:4px;" }, [

  (() => {
    // Keep labels aligned with trainedThisWeek ordering (same as dots)
    const dayLabels = (weekStartsOn === "sun")
      ? ["S","M","T","W","T","F","S"]
      : ["M","T","W","T","F","S","S"];

    const todayIdx = Math.max(0, trainedThisWeek.findIndex(x => x?.dateISO === todayISO));
    const todayColor = "rgba(46,204,113,.95)"; // accent highlight (UI-only)

    // Labels (use SAME 7-col grid as dots)
    return el("div", {
      style:[
        "display:grid",
        "grid-template-columns:repeat(7, 1fr)",
        "gap:6px",
        "opacity:.72",
        "font-size:11px",
        "font-weight:900",
        "user-select:none",
        "padding:0 2px",
        "justify-items:center",
        "align-items:center"
      ].join(";")
    }, dayLabels.map((ch, i) => {
      const isToday = (i === todayIdx);

      return el("div", {
        style:[
          "display:flex",
          "flex-direction:column",
          "align-items:center",
          "justify-content:center",
          "line-height:1"
        ].join(";")
      }, [
        el("div", {
          text: ch,
          style:[
            "text-align:center",
            "line-height:1",
            isToday ? `color:${todayColor}; opacity:1;` : ""
          ].join(";")
        }),
        // underline bar (reserve space so layout doesn't jump)
        el("div", {
          style:[
            "height:2px",
            "width:14px",
            "border-radius:999px",
            "margin-top:3px",
            isToday ? `background:${todayColor};` : "background:transparent;"
          ].join(";")
        })
      ]);
    }));
  })(),

  // Dots row (force dots node into SAME 7-col grid)
  el("div", {
    onClick: () => navigate("attendance"),
    style:"cursor:pointer;"
  }, [
    (() => {
      // ✅ override .dots CSS so it aligns with labels
      // (safe: UI-only; does not change dot logic)
      dots.style.display = "grid";
      dots.style.gridTemplateColumns = "repeat(7, 1fr)";
      dots.style.gap = "6px";
      dots.style.padding = "0 2px";
      dots.style.justifyItems = "center";
      dots.style.alignItems = "center";
      return dots;
    })()
  ])

]),

    el("div", { style:"height:10px" }),

    el("div", { class:"btnrow" }, [
      el("button", { class:"btn", onClick: () => navigate("attendance") }, ["View calendar"])
    ]),

    // Weight section
    sep(),

    el("div", { class:"homeRow" }, [
      el("div", { class:"kpi" }, [
        el("div", { class:"big", text: wLatest ? `${Number(wLatest.weight).toFixed(1)}` : "—" }),
        el("div", { class:"small", text: wLatest ? `Latest • ${wLatest.dateISO}` : "No weight entries yet." }),
        el("div", { class:"small", text: `Delta vs previous: ${wDeltaText}` })
      ]),
      el("button", {
        class:"btn",
        onClick: () => navigate("weight")
      }, ["Log weight"])
    ]),

    // Protein section (only if enabled)
    ...(goal > 0 ? [
      sep(),

      el("div", { class:"homeRow" }, [
        el("div", { class:"kpi" }, [
          el("div", { class:"big", text: `${left}g left` }),
          el("div", { class:"small", text: `${done} / ${goal}g today` }),
          el("div", { class:"small", text:"Tap the ring to log meals." })
        ]),
        el("div", { onClick: openProteinModal, style:"cursor:pointer;" }, [ ring ])
      ]),

      el("div", { style:"height:10px" }),

      el("div", { class:"btnrow" }, [
        el("button", { class:"btn primary", onClick: openProteinModal }, ["Log meals"])
      ])
        ] : [])
    ]);
})(),

// ✅ Goals — v2 (user-added goals + progress)
el("div", { class:"card" }, (() => {
  if(!state.profile){
    return [
      el("h2", { text:"Goals" }),
      el("div", { class:"note", text:"Complete onboarding to add goals." })
    ];
  }

  // Ensure containers exist (migration covers old saves, this keeps UI safe)
  state.profile.goals = (state.profile.goals && typeof state.profile.goals === "object") ? state.profile.goals : {};
  if(!Array.isArray(state.profile.goals.items)) state.profile.goals.items = [];

  const goals = state.profile.goals.items;

  function clamp01(x){ return Math.max(0, Math.min(1, Number(x) || 0)); }

  function pctRatio(cur, target){
    cur = Number(cur) || 0;
    target = Number(target) || 0;
    if(!(target > 0)) return 0;
    return clamp01(cur / target);
  }

  // Strength: top weight since goal creation (bestWeight)
  function bestStrengthSince(exerciseId, sinceTs){
    let best = null;
    const arr = Array.isArray(state?.logs?.workouts) ? state.logs.workouts : [];
    for(const e of arr){
      if(!e) continue;
      if(e.type !== "weightlifting") continue;
      if(e.exerciseId !== exerciseId) continue;
      if((e.createdAt || 0) < sinceTs) continue;

      const bw = Number(e?.summary?.bestWeight);
      if(Number.isFinite(bw)){
        best = (best === null) ? bw : Math.max(best, bw);
      }
    }
    return best;
  }

  // Cardio: best distance since goal creation (totalDistance)
  function bestCardioDistanceSince(exerciseId, sinceTs){
    let best = null;
    const arr = Array.isArray(state?.logs?.workouts) ? state.logs.workouts : [];
    for(const e of arr){
      if(!e) continue;
      if(e.type !== "cardio") continue;
      if(e.exerciseId !== exerciseId) continue;
      if((e.createdAt || 0) < sinceTs) continue;

      const v = Number(e?.summary?.totalDistance);
      if(Number.isFinite(v)){
        best = (best === null) ? v : Math.max(best, v);
      }
    }
    return best;
  }

  // Cardio: best time since goal creation (totalTime)
  function bestCardioTimeSince(exerciseId, sinceTs){
    let best = null;
    const arr = Array.isArray(state?.logs?.workouts) ? state.logs.workouts : [];
    for(const e of arr){
      if(!e) continue;
      if(e.type !== "cardio") continue;
      if(e.exerciseId !== exerciseId) continue;
      if((e.createdAt || 0) < sinceTs) continue;

      const v = Number(e?.summary?.totalTime);
      if(Number.isFinite(v)){
        best = (best === null) ? v : Math.max(best, v);
      }
    }
    return best;
  }

  // Core: best total volume since goal creation (totalVolume)
  function bestCoreVolumeSince(exerciseId, sinceTs){
    let best = null;
    const arr = Array.isArray(state?.logs?.workouts) ? state.logs.workouts : [];
    for(const e of arr){
      if(!e) continue;
      if(e.type !== "core") continue;
      if(e.exerciseId !== exerciseId) continue;
      if((e.createdAt || 0) < sinceTs) continue;

      const v = Number(e?.summary?.totalVolume);
      if(Number.isFinite(v)){
        best = (best === null) ? v : Math.max(best, v);
      }
    }
    return best;
  }

  // Weekly sessions: this week attendance count
  function sessionsThisWeek(){
    return trainedThisWeek.filter(x => x.trained).length;
  }

  function removeGoal(goalId){
    const idx = goals.findIndex(g => g && g.id === goalId);
    if(idx < 0) return;
    goals.splice(idx, 1);
    Storage.save(state);
    showToast("Goal removed");
    renderView();
  }

  function openAddGoalModal(){
    let mode = "strength"; // strength | weekly | weight | cardioDist | cardioTime | coreVol

    const modeSel = el("select", {
      onChange: (e) => { mode = String(e.target.value || "strength"); repaint(); }
    }, [
      el("option", { value:"strength", text:"Strength — Top weight (since creation)" }),
      el("option", { value:"cardioDist", text:"Cardio — Distance (since creation)" }),
      el("option", { value:"cardioTime", text:"Cardio — Time (since creation)" }),
      el("option", { value:"coreVol", text:"Core — Volume (since creation)" }),
      el("option", { value:"weekly", text:"Weekly sessions (Attendance)" }),
      el("option", { value:"weight", text:"Bodyweight" })
    ]);

    const body = el("div", {}, []);

    // Shared inputs
    const targetNum = el("input", { type:"number", inputmode:"decimal", step:"0.1", placeholder:"Target" });
    const weeklyTarget = el("input", { type:"number", inputmode:"numeric", min:"1", step:"1", placeholder:"Target (e.g. 4)" });
    const targetWeight = el("input", { type:"number", inputmode:"decimal", step:"0.1", placeholder:"Target weight (e.g. 185.0)" });

    // Exercise selects
    const strengthSel = el("select", {});
    const cardioSel = el("select", {});
    const coreSel = el("select", {});

    function loadSelect(sel, list){
      sel.innerHTML = "";
      sel.appendChild(el("option", { value:"", text:"Select an exercise…" }));
      (list || []).forEach(x => {
        if(!x || !x.id) return;
        sel.appendChild(el("option", { value:x.id, text: x.name || "Exercise" }));
      });
    }

    const wl = Array.isArray(state?.exerciseLibrary?.weightlifting) ? state.exerciseLibrary.weightlifting.slice() : [];
    wl.sort((a,b) => String(a?.name||"").localeCompare(String(b?.name||"")));
    loadSelect(strengthSel, wl);

    const cd = Array.isArray(state?.exerciseLibrary?.cardio) ? state.exerciseLibrary.cardio.slice() : [];
    cd.sort((a,b) => String(a?.name||"").localeCompare(String(b?.name||"")));
    loadSelect(cardioSel, cd);

    const co = Array.isArray(state?.exerciseLibrary?.core) ? state.exerciseLibrary.core.slice() : [];
    co.sort((a,b) => String(a?.name||"").localeCompare(String(b?.name||"")));
    loadSelect(coreSel, co);

    function save(){
      const now = Date.now();
      const idFn = (typeof uid === "function") ? uid : (p => `${p || "g"}_${Date.now()}`);

      function addGoal(g){
        goals.push(g);
        Storage.save(state);
        showToast("Goal added");
        Modal.close();
        renderView();
      }

      if(mode === "strength"){
        const exerciseId = String(strengthSel.value || "").trim();
        const target = Number(targetNum.value);

        if(!exerciseId){ showToast("Pick an exercise"); return; }
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a valid target"); return; }

        const ex = wl.find(x => x.id === exerciseId);
        const nameSnap = ex?.name || "Strength";

        addGoal({
          id: idFn("g"),
          kind: "strength_top_weight_since",
          title: `${nameSnap} → ${target}`,
          exerciseId,
          exerciseNameSnap: nameSnap,
          targetValue: target,
          createdAt: now
        });
      }

      if(mode === "cardioDist"){
        const exerciseId = String(cardioSel.value || "").trim();
        const target = Number(targetNum.value);

        if(!exerciseId){ showToast("Pick an exercise"); return; }
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a valid distance target"); return; }

        const ex = cd.find(x => x.id === exerciseId);
        const nameSnap = ex?.name || "Cardio";

        addGoal({
          id: idFn("g"),
          kind: "cardio_distance_since",
          title: `${nameSnap} distance → ${target}`,
          exerciseId,
          exerciseNameSnap: nameSnap,
          targetValue: target,
          createdAt: now
        });
      }

      if(mode === "cardioTime"){
        const exerciseId = String(cardioSel.value || "").trim();
        const target = Number(targetNum.value);

        if(!exerciseId){ showToast("Pick an exercise"); return; }
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a valid time target"); return; }

        const ex = cd.find(x => x.id === exerciseId);
        const nameSnap = ex?.name || "Cardio";

        addGoal({
          id: idFn("g"),
          kind: "cardio_time_since",
          title: `${nameSnap} time → ${target}`,
          exerciseId,
          exerciseNameSnap: nameSnap,
          targetValue: target,
          createdAt: now
        });
      }

      if(mode === "coreVol"){
        const exerciseId = String(coreSel.value || "").trim();
        const target = Number(targetNum.value);

        if(!exerciseId){ showToast("Pick an exercise"); return; }
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a valid volume target"); return; }

        const ex = co.find(x => x.id === exerciseId);
        const nameSnap = ex?.name || "Core";

        addGoal({
          id: idFn("g"),
          kind: "core_volume_since",
          title: `${nameSnap} volume → ${target}`,
          exerciseId,
          exerciseNameSnap: nameSnap,
          targetValue: target,
          createdAt: now
        });
      }

      if(mode === "weekly"){
        const target = Number(weeklyTarget.value);
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a weekly target"); return; }

        addGoal({
          id: idFn("g"),
          kind: "weekly_sessions",
          title: `Weekly sessions → ${Math.round(target)}`,
          targetValue: Math.max(1, Math.round(target)),
          createdAt: now
        });
      }

      if(mode === "weight"){
        const target = Number(targetWeight.value);
        if(!Number.isFinite(target) || target <= 0){ showToast("Enter a target weight"); return; }

        const latest = WeightEngine.latest();
        const start = latest ? Number(latest.weight) : 0;

        addGoal({
          id: idFn("g"),
          kind: "bodyweight",
          title: `Bodyweight → ${target}`,
          startValue: start,
          targetValue: target,
          createdAt: now
        });
      }
    }

    function repaint(){
      body.innerHTML = "";

      body.appendChild(el("div", { class:"setRow" }, [
        el("div", {}, [
          el("div", { style:"font-weight:820;", text:"Goal type" }),
          el("div", { class:"meta", text:"Choose what you want to track" })
        ]),
        modeSel
      ]));

      if(mode === "strength"){
        targetNum.placeholder = "Target top weight (e.g. 225)";
        targetNum.step = "0.5";
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Exercise" }),
            el("div", { class:"meta", text:"Weightlifting only" })
          ]),
          strengthSel
        ]));
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [ el("div", { style:"font-weight:820;", text:"Target" }), el("div", { class:"meta", text:"Top weight since goal creation" }) ]),
          targetNum
        ]));
      }

      if(mode === "cardioDist"){
        targetNum.placeholder = "Target distance (e.g. 3.0)";
        targetNum.step = "0.1";
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Exercise" }),
            el("div", { class:"meta", text:"Cardio only" })
          ]),
          cardioSel
        ]));
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [ el("div", { style:"font-weight:820;", text:"Target" }), el("div", { class:"meta", text:"Best single-workout distance since creation" }) ]),
          targetNum
        ]));
      }

      if(mode === "cardioTime"){
        targetNum.placeholder = "Target time (minutes, e.g. 30)";
        targetNum.step = "1";
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Exercise" }),
            el("div", { class:"meta", text:"Cardio only" })
          ]),
          cardioSel
        ]));
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [ el("div", { style:"font-weight:820;", text:"Target" }), el("div", { class:"meta", text:"Best single-workout time since creation" }) ]),
          targetNum
        ]));
      }

      if(mode === "coreVol"){
        targetNum.placeholder = "Target volume (e.g. 100)";
        targetNum.step = "1";
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Exercise" }),
            el("div", { class:"meta", text:"Core only" })
          ]),
          coreSel
        ]));
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [ el("div", { style:"font-weight:820;", text:"Target" }), el("div", { class:"meta", text:"Best single-workout volume since creation" }) ]),
          targetNum
        ]));
      }

      if(mode === "weekly"){
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Weekly sessions target" }),
            el("div", { class:"meta", text:"Based on Attendance check-ins" })
          ]),
          weeklyTarget
        ]));
      }

      if(mode === "weight"){
        body.appendChild(el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text:"Target bodyweight" }),
            el("div", { class:"meta", text:"Current vs target" })
          ]),
          targetWeight
        ]));
      }

      body.appendChild(el("div", { style:"height:10px" }));
      body.appendChild(el("div", { class:"btnrow" }, [
        el("button", { class:"btn", onClick: () => Modal.close() }, ["Cancel"]),
        el("button", { class:"btn primary", onClick: save }, ["Add goal"])
      ]));
    }

    repaint();

    Modal.open({ title: "Add goal", bodyNode: body });
  }

  function currentForGoal(g){
    const since = Number(g?.createdAt || 0);

    if(g.kind === "weekly_sessions"){
      return sessionsThisWeek();
    }
    if(g.kind === "bodyweight"){
      const latest = WeightEngine.latest();
      return latest ? Number(latest.weight) : 0;
    }
    if(g.kind === "strength_top_weight_since"){
      const v = bestStrengthSince(g.exerciseId, since);
      return (v == null) ? 0 : Number(v);
    }
    if(g.kind === "cardio_distance_since"){
      const v = bestCardioDistanceSince(g.exerciseId, since);
      return (v == null) ? 0 : Number(v);
    }
    if(g.kind === "cardio_time_since"){
      const v = bestCardioTimeSince(g.exerciseId, since);
      return (v == null) ? 0 : Number(v);
    }
    if(g.kind === "core_volume_since"){
      const v = bestCoreVolumeSince(g.exerciseId, since);
      return (v == null) ? 0 : Number(v);
    }

    return 0;
  }

  function metaForGoal(g, cur){
    const t = Number(g?.targetValue || 0);

    if(g.kind === "weekly_sessions"){
      return `This week: ${cur} / ${t}`;
    }
    if(g.kind === "bodyweight"){
      const s = (g.startValue == null) ? "—" : Number(g.startValue).toFixed(1);
      const c = cur ? Number(cur).toFixed(1) : "—";
      const tt = t ? Number(t).toFixed(1) : "—";
      return `Now: ${c} • Start: ${s} → Target: ${tt}`;
    }
    if(g.kind === "strength_top_weight_since"){
      return `Now: ${cur ? Number(cur).toFixed(1) : "—"} • Target: ${t ? Number(t).toFixed(1) : "—"}`;
    }
    if(g.kind === "cardio_distance_since"){
      return `Now: ${cur ? Number(cur).toFixed(2) : "—"} • Target: ${t ? Number(t).toFixed(2) : "—"}`;
    }
    if(g.kind === "cardio_time_since"){
      return `Now: ${cur ? Number(cur).toFixed(0) : "—"} • Target: ${t ? Number(t).toFixed(0) : "—"}`;
    }
    if(g.kind === "core_volume_since"){
      return `Now: ${cur ? Number(cur).toFixed(0) : "—"} • Target: ${t ? Number(t).toFixed(0) : "—"}`;
    }

    return "";
  }

  const listNode =
    goals.length === 0
      ? el("div", { class:"note", text:"No goals yet. Tap Add goal to create one." })
      : el("div", { style:"display:flex; flex-direction:column; gap:10px; margin-top:10px;" },
          goals.map(g => {
            const cur = currentForGoal(g);
            const pct =
              (g.kind === "bodyweight")
                ? (function(){
                    const start = Number(g.startValue || 0);
                    const target = Number(g.targetValue || 0);
                    if(target === start) return 0;
                    return clamp01((cur - start) / (target - start));
                  })()
                : pctRatio(cur, Number(g.targetValue || 0));

            const pctTxt = `${Math.round(pct * 100)}%`;

            return el("div", {
              style:"border:1px solid rgba(255,255,255,.10); background: rgba(255,255,255,.04); border-radius:16px; padding:12px;"
            }, [
              el("div", { class:"homeRow" }, [
                el("div", {}, [
                  el("div", { style:"font-weight:900; letter-spacing:.2px;", text: g.title || "Goal" }),
                  el("div", { class:"note", text: `${metaForGoal(g, cur)} • ${pctTxt}` })
                ]),
                el("button", { class:"btn danger", onClick: () => removeGoal(g.id) }, ["Remove"])
              ]),

              el("div", { style:"height:10px" }),
              el("div", { class:"proteinBar", style:"height:12px;" }, [
                el("div", { class:"proteinBarFill", style:`width:${Math.round(pct * 100)}%` })
              ])
            ]);
          })
        );

  return [
    el("div", { class:"homeRow" }, [
      el("div", {}, [
        el("h2", { text:"Goals" }),
        el("div", { class:"note", text:"Goals you create. Progress updates automatically from your logs." })
      ]),
      el("button", { class:"btn primary", onClick: openAddGoalModal }, ["+ Add goal"])
    ]),
    listNode
  ];
})()),

    ]);
},
      ProteinHistory(){

        const root = el("div", { class:"grid" });

        // Read-only totals (do NOT call totalProtein() here because it can auto-create entries)
        function proteinTotalForDateRO(dateISO){
          const entry = (state?.logs?.protein || []).find(x => x.dateISO === dateISO);
          if(!entry || !Array.isArray(entry.meals)) return 0;
          return entry.meals.reduce((sum, m) => sum + (Number(m?.grams) || 0), 0);
        }

        function statusFor(total, goal){
          if(goal <= 0) return "No goal set";
          if(total >= goal) return "Goal Met";
          if(total >= (goal * 0.8)) return "Almost There";
          return "Under Goal";
        }

        function fmtDateLabel(dateISO){
          const d = new Date(String(dateISO) + "T00:00:00");
          if(isNaN(d.getTime())) return String(dateISO || "—");
          return d.toLocaleDateString(undefined, { month:"short", day:"numeric" });
        }

        const todayISO = Dates.todayISO();
        const weekStartsOn = state.profile?.weekStartsOn || "mon";
        const goal = Math.max(0, Math.round(Number(state?.profile?.proteinGoal || 0)));

        const startThisWeekISO = Dates.startOfWeekISO(todayISO, weekStartsOn);
        const startLastWeekISO = Dates.addDaysISO(startThisWeekISO, -7);

        // Collect logged days (from actual stored entries)
        const entries = Array.isArray(state?.logs?.protein) ? state.logs.protein.slice() : [];
        // keep only valid ISO-ish dates
        const cleaned = entries
          .filter(e => e && typeof e.dateISO === "string" && e.dateISO.length >= 10)
          .sort((a,b) => String(b.dateISO).localeCompare(String(a.dateISO)));

        // Week stats (this week)
        let weekLoggedDays = 0;
        let weekSum = 0;
        let weekBest = 0;
        let weekGoalMet = 0;

        for(let i=0;i<7;i++){
          const dISO = Dates.addDaysISO(startThisWeekISO, i);
          const total = proteinTotalForDateRO(dISO);
          const hasEntry = total > 0;
          if(hasEntry){
            weekLoggedDays++;
            weekSum += total;
            weekBest = Math.max(weekBest, total);
            if(goal > 0 && total >= goal) weekGoalMet++;
          }
        }

        const weekAvg = (weekLoggedDays > 0) ? Math.round(weekSum / weekLoggedDays) : 0;

        // Sticky in-view header (global header is already fixed)
        const headerRow = el("div", {
          style:[
            "position:sticky",
            "top:0",
            "z-index:5",
            "padding:6px 0 10px",
            "background: rgba(0,0,0,.18)",
            "backdrop-filter: blur(10px)"
          ].join(";")
        }, [
          el("div", { class:"homeRow" }, [
            el("button", { class:"btn", onClick: () => navigate("home") }, ["← Back"]),
            el("div", { style:"font-weight:900; letter-spacing:.2px;" , text:"Protein History" }),
            el("div", { style:"width:72px" }) // spacer to balance
          ])
        ]);

        function progressBar(total, goal){
          const pct = (goal > 0) ? Math.max(0, Math.min(1, total / goal)) : 0;
          return el("div", { class:"proteinBarTrack", style:"height:12px; border-radius:999px; overflow:hidden;" }, [
            el("div", { class:"proteinBarFill", style:`width:${Math.round(pct*100)}%; height:100%;` })
          ]);
        }

        const summaryCard = el("div", { class:"card" }, [
          el("h2", { text:"This Week" }),
          el("div", { class:"note", text:`${weekLoggedDays}/7 days logged • Avg: ${weekAvg}g` }),
          el("div", { class:"note", text:`Best: ${weekBest}g • Goal Met Days: ${weekGoalMet}` })
        ]);

        function dayCard(dateISO){
          const total = proteinTotalForDateRO(dateISO);
          const left = Math.max(0, goal - total);
          const st = statusFor(total, goal);

          const title = Dates.sameISO(dateISO, todayISO)
            ? `${fmtDateLabel(dateISO)} (Today)`
            : fmtDateLabel(dateISO);

          return el("div", { class:"card", style:"cursor:pointer;" , onClick: () => {
            // open the existing protein modal for that date
            UIState.protein = UIState.protein || {};
            UIState.protein.dateISO = dateISO;
            Modal.open({ title:"Protein", bodyNode: buildProteinTodayModal(dateISO, goal) });
          }}, [
            el("div", { class:"homeRow" }, [
              el("div", {}, [
                el("div", { style:"font-weight:900;", text: title }),
                el("div", { class:"note", text: `${left}g remaining • ${st}` })
              ]),
              el("div", { style:"font-weight:900;", text: `${total}g` })
            ]),
            el("div", { style:"height:10px" }),
            progressBar(total, goal)
          ]);
        }

        // Build sections
        const thisWeekDates = [];
        const lastWeekDates = [];

        for(let i=0;i<7;i++){
          thisWeekDates.push(Dates.addDaysISO(startThisWeekISO, i));
          lastWeekDates.push(Dates.addDaysISO(startLastWeekISO, i));
        }

        // Older: anything before last week start
        const olderDates = cleaned
          .map(x => x.dateISO)
          .filter(dISO => dISO < startLastWeekISO);

        function section(title, dateList){
          // show only days that actually have entries (plus today for “This Week” visibility)
          const cards = [];
          for(const dISO of dateList){
            const hasEntry = proteinTotalForDateRO(dISO) > 0;
            if(hasEntry || (title === "This Week" && Dates.sameISO(dISO, todayISO))){
              cards.push(dayCard(dISO));
            }
          }
          if(cards.length === 0) return null;

          return el("div", {}, [
            el("div", { class:"addExSectionLabel", text:title }),
            el("div", { style:"display:grid; gap:10px;" }, cards)
          ]);
        }

        // Compose
        root.appendChild(headerRow);
        root.appendChild(summaryCard);

        const a = section("This Week", thisWeekDates);
        const b = section("Last Week", lastWeekDates);
        const c = section("Older", olderDates);

        if(a) root.appendChild(a);
        if(b) root.appendChild(b);
        if(c) root.appendChild(c);

        // Empty state
        if(!a && !b && !c){
          root.appendChild(el("div", { class:"card" }, [
            el("h2", { text:"Protein History" }),
            el("div", { class:"note", text:"No protein logged yet." }),
            el("div", { style:"height:12px" }),
            el("button", { class:"btn primary", onClick: () => {
              UIState.protein = UIState.protein || {};
              UIState.protein.dateISO = todayISO;
              Modal.open({ title:"Protein", bodyNode: buildProteinTodayModal(todayISO, goal) });
            } }, ["Start today"])
          ]));
        }

        return root;
      },

Routine(){
const root = el("div", { class:"routinePage" });

  let routine = Routines.getActive();
  if(!routine){

    function openRoutineRecovery(){
      const body = el("div", {}, [
        el("div", { class:"note", text:"Choose a template to instantly recreate a routine. If you previously deleted everything, this is the fastest recovery." }),
        el("div", { style:"height:12px" })
      ]);

      const list = el("div", { class:"list" });

      (RoutineTemplates || []).forEach(tpl => {
        list.appendChild(el("div", {
          class:"item",
          onClick: async () => {
            try{
              await addRoutineFromTemplateAndSync(tpl.key, tpl.name);              Modal.close();
              showToast(`Created: ${tpl.name}`);
              renderView(); // re-render current route (Routine)
            }catch(e){
              Modal.open({
                title:"Could not create routine",
                bodyNode: el("div", {}, [
                  el("div", { class:"note", text: e?.message || "Something went wrong while creating a routine." }),
                  el("div", { style:"height:12px" }),
                  el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
                ])
              });
            }
          }
        }, [
          el("div", { class:"left" }, [
            el("div", { class:"name", text: tpl.name }),
            el("div", { class:"meta", text: tpl.desc || "Template" })
          ]),
          el("div", { class:"actions" }, [
            el("div", { class:"meta", text:"Create" })
          ])
        ]));
      });

      body.appendChild(list);

      body.appendChild(el("div", { style:"height:14px" }));
      body.appendChild(el("div", { class:"btnrow" }, [
        el("button", { class:"btn", onClick: () => { Modal.close(); navigate("settings"); } }, ["Go to Settings"]),
        el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
      ]));

      Modal.open({
        title:"Create a routine",
        center: true,
        bodyNode: body
      });
    }

    root.appendChild(el("div", { class:"card" }, [
      el("h2", { text:"Routine" }),
      el("div", { class:"note", text:"No active routine found. Create one now (you don’t need Settings)." }),
      el("div", { style:"height:12px" }),
      el("div", { class:"btnrow" }, [
        el("button", { class:"btn primary", onClick: openRoutineRecovery }, ["Create routine"]),
        el("button", {
          class:"btn",
          onClick: () => {
            // Helpful shortcut: jump to Backup & Restore section
            UIState.settings = UIState.settings || {};
            UIState.settings.open = UIState.settings.open || {};
            UIState.settings.open.backup = true;
            navigate("settings");
          }
        }, ["Backup & Restore"])
      ])
    ]));

    return root;
  }

  const today = new Date();
  const todayIndex = today.getDay();               // 0=Sun..6=Sat
  const todayISO = Dates.todayISO(); // local date (fixes Feb 14 UTC bug)

  let selectedIndex = todayIndex;

    const weekStartsOn = state.profile?.weekStartsOn || "mon";
  const weekStartISO = Dates.startOfWeekISO(todayISO, weekStartsOn);

  // Map selected weekday index (0=Sun..6=Sat) to an actual calendar date in the current week
  function getSelectedDateISO(index){
    const offset = (weekStartsOn === "sun")
      ? index
      : ((index - 1 + 7) % 7); // Mon=0 ... Sun=6
    return Dates.addDaysISO(weekStartISO, offset);
  }
  // Label date as Today / Tomorrow / "Feb 15"
function prettyDayTag(dateISO){
  // ✅ hard guard
  if(!Dates.isISO(dateISO)) return "—";

  if(dateISO === todayISO) return "Today";
  if(dateISO === Dates.addDaysISO(todayISO, 1)) return "Tomorrow";

  return Dates.formatShort(dateISO); // "Feb 15" (never "Invalid Date")
}

  function getDay(index){
    routine = Routines.getActive(); // ✅ always refresh active routine
    return (routine?.days || []).find(d => d.order === index) || null;
  }


  function openRoutinePicker(anchorBtn){
  let all = Routines.getAll() || [];
  const activeId = Routines.getActive()?.id || null;

  function getRoutineDayCount(r){
    return Array.isArray(r?.days) ? r.days.filter(d => !d?.isRest).length : 0;
  }

  function getRoutineExerciseCount(r){
    return (Array.isArray(r?.days) ? r.days : []).reduce((sum, day) => {
      if(day?.isRest) return sum;
      return sum + (Array.isArray(day?.exercises) ? day.exercises.length : 0);
    }, 0);
  }

  function getRoutineFocusText(r){
    const labels = (Array.isArray(r?.days) ? r.days : [])
      .filter(day => !day?.isRest)
      .map(day => String(day?.label || "").trim())
      .filter(Boolean);

    const seen = new Set();
    const uniq = [];
    labels.forEach(label => {
      const k = normName(label);
      if(!k || seen.has(k)) return;
      seen.add(k);
      uniq.push(label);
    });

    return uniq.length ? uniq.slice(0, 3).join(" • ") : "Custom routine";
  }

  function getTemplateMetaText(tpl){
    const preview = createRoutineFromTemplate(tpl.key, tpl.name || "Routine");
    const days = getRoutineDayCount(preview);
    const exercises = getRoutineExerciseCount(preview);
    return `${days} Day${days === 1 ? "" : "s"} • ${tpl?.desc || `${exercises} Exercises`}`;
  }

  function findRoutineForTemplate(tpl){
    // Blank should always create a new routine, never resolve to an existing saved one
    if(String(tpl?.key || "") === "blank") return null;

    const byKey = all.find(r => String(r?.templateKey || "") === String(tpl?.key || ""));
    if(byKey) return byKey;

    const byName = all.find(r => normName(r?.name || "") === normName(tpl?.name || ""));
    return byName || null;
  }

  async function activateRoutine(routineId){
    await setActiveRoutineAndSync(routineId);
    routine = Routines.getActive();
    selectedIndex = todayIndex;
    PopoverClose();
    repaint();
  }

  async function createBlankRoutine(){
    const r = await addRoutineFromTemplateAndSync("blank", "New Routine");
    routine = Routines.getActive();
    selectedIndex = todayIndex;
    PopoverClose();
    repaint();
    showToast(`Created: ${r?.name || "New Routine"}`);
  }

  function buildSectionHeader({ title, count, expanded, onToggle }){
    const chevron = el("div", {
      style:[
        "font-size:16px",
        "font-weight:1000",
        "line-height:1",
        "opacity:.88",
        "transition:transform .18s ease",
        `transform:${expanded ? "rotate(90deg)" : "rotate(0deg)"}`,
        "flex:0 0 auto"
      ].join(";")
    }, ["›"]);

    return el("button", {
      type:"button",
      onClick: onToggle,
      style:[
        "display:flex",
        "align-items:center",
        "justify-content:space-between",
        "gap:12px",
        "width:100%",
        "padding:12px 14px",
        "border-radius:16px",
        "border:1px solid rgba(255,255,255,.10)",
        "background:rgba(255,255,255,.05)",
        "color:inherit",
        "font:inherit",
        "text-align:left",
        "cursor:pointer",
        "appearance:none",
        "-webkit-appearance:none"
      ].join(";")
    }, [
      el("div", {
        style:"display:flex; align-items:center; gap:10px; min-width:0;"
      }, [
        chevron,
        el("div", {
          style:"font-size:14px; font-weight:900; min-width:0;"
        }, [`${title} (${count})`])
      ]),
      el("div", {
        class:"note",
        style:"margin:0; white-space:nowrap;"
      }, [expanded ? "Hide" : "Show"])
    ]);
  }

  function buildRoutineRow(r, opts={}){
    const isActive = !!opts.isActive;
    const dayCount = getRoutineDayCount(r);
    const exerciseCount = getRoutineExerciseCount(r);
    const focus = getRoutineFocusText(r);

    return el("div", {
      class:"popItem",
      onClick: async () => {
        try{
          await activateRoutine(r.id);
          if(!isActive) showToast(`Active: ${r.name || "Routine"}`);
        }catch(e){
          showToast(e?.message || "Could not set active");
        }
      }
    }, [
      el("div", { class:"l" }, [
        el("div", { class:"n", text: r.name || "Routine" }),
        el("div", { class:"m", text: focus }),
        el("div", { class:"m", text: `${dayCount} Days • ${exerciseCount} Exercises` })
      ]),
      isActive
        ? el("div", { class:"popBadge", text:"Active" })
        : el("div", { class:"m", text:"Activate" })
    ]);
  }

  function buildTemplateRow(tpl){
    const isBlank = String(tpl?.key || "") === "blank";
    const existingAtRender = isBlank ? null : findRoutineForTemplate(tpl);
    const labelRight = isBlank ? "New" : (existingAtRender ? "Activate" : "Add");

    return el("div", {
      class:"popItem",
      onClick: async () => {
        try{
          if(isBlank){
            await createBlankRoutine();
            return;
          }

          all = Routines.getAll() || [];
          const existingNow = findRoutineForTemplate(tpl);

          if(existingNow){
            await activateRoutine(existingNow.id);
            showToast(`Active: ${existingNow.name || tpl.name}`);
            return;
          }

          await addRoutineFromTemplateAndSync(tpl.key, tpl.name);
          routine = Routines.getActive();
          selectedIndex = todayIndex;
          PopoverClose();
          repaint();
          showToast(`Created: ${tpl.name}`);
        }catch(e){
          showToast(e?.message || "Could not create routine");
        }
      }
    }, [
      el("div", { class:"l" }, [
        el("div", { class:"n", text: isBlank ? "Blank Routine" : (tpl.name || "Template") }),
        el("div", {
          class:"m",
          text: isBlank ? "Create your own routine" : getTemplateMetaText(tpl)
        })
      ]),
      el("div", { class:"m", text: labelRight })
    ]);
  }

  const activeRoutine = all.find(r => r.id === activeId) || null;
  const savedRoutines = all.filter(r => r && r.id !== activeId);
  const templates = (RoutineTemplates || [])
  .filter(tpl => String(tpl?.key || "") !== "blank");


    
  let showSaved = false;
  let showTemplates = false;

  const shell = el("div", {
  style:"display:flex; flex-direction:column; gap:10px; max-height:70vh;"
});

  shell.appendChild(el("div", { class:"popTitle", text:"Select routine" }));
  shell.appendChild(el("div", {
    class:"note",
    style:"margin:0;"
  }, ["Choose your active program"]));

  if(activeRoutine){
    shell.appendChild(el("div", {
      style:"display:grid; gap:8px;"
    }, [
      el("div", {
        class:"note",
        style:"margin:2px 0 0 2px; font-size:11px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; opacity:.72;"
      }, ["Active Routine"]),
      buildRoutineRow(activeRoutine, { isActive:true })
    ]));
  }

  const savedSection = el("div", { style:"display:grid; gap:8px;" });
  const savedList = el("div", {
    style:`display:${showSaved ? "grid" : "none"}; gap:8px;`
  });

  if(savedRoutines.length){
    savedRoutines.forEach(r => savedList.appendChild(buildRoutineRow(r)));
  }else{
    savedList.appendChild(el("div", {
      class:"note",
      style:"margin:0; padding:2px 2px 0;"
    }, ["No saved routines yet."]));
  }

  const savedHeader = buildSectionHeader({
    title:"Your Routines",
    count:savedRoutines.length,
    expanded:showSaved,
    onToggle: () => {
      showSaved = !showSaved;
      savedHeader.firstChild.firstChild.style.transform = showSaved ? "rotate(90deg)" : "rotate(0deg)";
      savedHeader.lastChild.textContent = showSaved ? "Hide" : "Show";
      savedList.style.display = showSaved ? "grid" : "none";
    }
  });

  savedSection.appendChild(savedHeader);
  savedSection.appendChild(savedList);
  shell.appendChild(savedSection);

  const templateSection = el("div", { style:"display:grid; gap:8px;" });
  const templateList = el("div", {
    style:`display:${showTemplates ? "grid" : "none"}; gap:8px;`
  });

  templates.forEach(tpl => templateList.appendChild(buildTemplateRow(tpl)));

  const templateHeader = buildSectionHeader({
    title:"Default Templates",
    count:templates.length,
    expanded:showTemplates,
    onToggle: () => {
      showTemplates = !showTemplates;
      templateHeader.firstChild.firstChild.style.transform = showTemplates ? "rotate(90deg)" : "rotate(0deg)";
      templateHeader.lastChild.textContent = showTemplates ? "Hide" : "Show";
      templateList.style.display = showTemplates ? "grid" : "none";
    }
  });

  templateSection.appendChild(templateHeader);
  templateSection.appendChild(templateList);
  shell.appendChild(templateSection);

  shell.appendChild(el("div",{style:"height:6px"}));

shell.appendChild(
  el("div",{
    class:"popItem",
    onClick: async ()=>{
      try{
        const r = await addRoutineFromTemplateAndSync("blank","New Routine");
        PopoverClose();
        showToast(`Created: ${r?.name || "New Routine"}`);
        navigate("routine_editor");
      }catch(e){
        showToast(e?.message || "Could not create routine");
      }
    }
  },[
    el("div",{class:"l"},[
      el("div",{class:"n",text:"+ Create Routine"}),
      el("div",{class:"m",text:"Create a new workout program"})
    ]),
    el("div",{class:"m",text:"+"})
  ])
);

  PopoverOpen(anchorBtn, shell);
}
  
  
  // Phase 3: Per-exercise Workout Execution (logger)
function openExerciseLogger(rx, day, defaultDateISO){
    openExerciseLoggerRef = openExerciseLogger;
  ExerciseLibrary.ensureSeeded();
  LogEngine.ensure();

  const type = rx.type;
  const exerciseId = rx.exerciseId;
  const exName = resolveExerciseName(type, exerciseId, rx.nameSnap);

  const initialDateISO = String(defaultDateISO || Dates.todayISO());

// Manual override date (defaults to the day you're viewing in the carousel)
const dateInput = el("input", { type:"date", value: initialDateISO });

  // Existing log for this routine-exercise on the selected date (so inputs persist)
    const existingEntry = (state.logs?.workouts || []).find(e =>
    e.dateISO === initialDateISO &&
    e.routineExerciseId === rx.id &&
    !e?.skipped
  ) || null;

    const routineId = String(
    existingEntry?.routineId ||
    ((state.routines || []).find(r =>
      (r.days || []).some(d => String(d?.id || "") === String(day?.id || ""))
    )?.id || "") ||
    state.activeRoutineId ||
    ""
  );

const headerText = el("div", { class:"note" }, [
  `${exName} • ${ExerciseLibrary.typeLabel(type)} • `,
  dateInput
]);

const hint = el("div", { class:"note", text:"Tip: Change the date above to log for a different day (manual override)." });

// Show plan snapshot (optional)
const plan = rx.plan || null;
const planLine = el("div", { class:"note" }, [
  plan
    ? `Plan: ${String(plan.sets ?? "—")} × ${String(plan.reps ?? "—")}${plan.restSec ? ` • Rest ${plan.restSec}s` : ""}`
    : "Plan: —"
]);

// Show last entry snapshot (optional)
const last = LogEngine.entriesForExercise(type, exerciseId)[0] || null;
const lastLine = el("div", { class:"note" }, [
  last ? `Last: ${formatEntryOneLine(type, last)}` : "Last: —"
]);

const err = el("div", { class:"note", style:"display:none; color: rgba(255,92,122,.95);" });

/* NEW layout shell:
   - header stays fixed (sticky)
   - form area scrolls
*/
const head = el("div", { class:"logsetHead" }, [ headerText, hint, planLine, lastLine, err ]);
const scroll = el("div", { class:"logsetScroll" }, []);
const body = el("div", { class:"logsetShell" }, [ head, scroll ]);



if(type === "weightlifting"){
  scroll.appendChild(buildWeightliftingForm());
}else if(type === "cardio"){
  scroll.appendChild(buildCardioForm());
}else{
  scroll.appendChild(buildCoreForm());
}


  Modal.open({
    title: "Log Sets",
    center: true,
    bodyNode: body
  });

  function showErr(msg){
    err.textContent = msg;
    err.style.display = "block";
  }

  function clearErr(){
    err.style.display = "none";
    err.textContent = "";
  }

        async function afterSave(savedDateISO, wasComplete=false){
    Modal.close();

    const currentRoute = (typeof getCurrentRoute === "function")
      ? getCurrentRoute()
      : "";

    if(currentRoute === "home"){
      renderView();
    }else{
      repaint();
    }

    const nowComplete = isDayComplete(savedDateISO, day);

    if(nowComplete){
      attendanceAdd(savedDateISO);

      if(!wasComplete){
        showToast("Day completed ✅");
      }

      await syncWorkoutCompletedEventForDay(savedDateISO, routineId || null, day);

      if(!wasComplete){
        await maybePromptWorkoutFeedShare(savedDateISO, routineId || null, day);
      }
    }
  }

function buildWorkoutEventData(dateISO, routineId, day){
  const entries = (state?.logs?.workouts || []).filter(e =>
    String(e?.dateISO || "") === String(dateISO || "") &&
    String(e?.routineId || "") === String(routineId || "") &&
    String(e?.dayId || "") === String(day?.id || "") &&
    !e?.skipped
  );

  const exSet = new Set();
  let totalVolume = 0;
  let prCount = 0;

  function hasAnyPR(pr){
    try{
      return !!(
        pr?.isPRWeight ||
        pr?.isPR1RM ||
        pr?.isPRVolume ||
        pr?.isPRPace
      );
    }catch(_){
      return false;
    }
  }

  function num(v){
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function bestWeightFromEntry(e){
    try{
      const sets = Array.isArray(e?.sets) ? e.sets : [];
      let best = 0;
      for(const s of sets){
        const w = num(s?.weight);
        if(w > best) best = w;
      }
      if(best > 0) return best;
      return num(e?.summary?.bestWeight);
    }catch(_){
      return 0;
    }
  }

  function bestRepsAtBestWeightFromEntry(e){
    try{
      const sets = Array.isArray(e?.sets) ? e.sets : [];
      let bestWeight = -1;
      let bestReps = 0;

      for(const s of sets){
        const w = num(s?.weight);
        const r = num(s?.reps);
        if(w > bestWeight){
          bestWeight = w;
          bestReps = r;
        }else if(w === bestWeight && r > bestReps){
          bestReps = r;
        }
      }

      return bestReps;
    }catch(_){
      return 0;
    }
  }

  function cardioScore(entry){
    try{
      const s = entry?.summary || {};
      const distance = num(s?.distance);
      const timeSec = num(s?.timeSec);
      const pace = num(s?.paceSecPerUnit);

      return {
        hasPR: hasAnyPR(entry?.pr),
        paceScore: (pace > 0) ? (999999 - pace) : 0,
        distance,
        timeSec
      };
    }catch(_){
      return { hasPR:false, paceScore:0, distance:0, timeSec:0 };
    }
  }

  function coreScore(entry){
    try{
      const s = entry?.summary || {};
      return {
        hasPR: hasAnyPR(entry?.pr),
        totalVolume: num(s?.totalVolume),
        timeSec: num(s?.timeSec),
        reps: num(s?.reps),
        weight: num(s?.weight)
      };
    }catch(_){
      return { hasPR:false, totalVolume:0, timeSec:0, reps:0, weight:0 };
    }
  }

  function compareEntries(a, b){
    const typeA = String(a?.type || "");
    const typeB = String(b?.type || "");

    const aPR = hasAnyPR(a?.pr);
    const bPR = hasAnyPR(b?.pr);
    if(aPR !== bPR) return aPR ? -1 : 1;

    if(typeA === "weightlifting" && typeB === "weightlifting"){
      const aW = bestWeightFromEntry(a);
      const bW = bestWeightFromEntry(b);
      if(bW !== aW) return bW - aW;

      const aR = bestRepsAtBestWeightFromEntry(a);
      const bR = bestRepsAtBestWeightFromEntry(b);
      if(bR !== aR) return bR - aR;

      const aVol = num(a?.summary?.totalVolume);
      const bVol = num(b?.summary?.totalVolume);
      if(bVol !== aVol) return bVol - aVol;

      return 0;
    }

    if(typeA === "cardio" && typeB === "cardio"){
      const A = cardioScore(a);
      const B = cardioScore(b);

      if(B.paceScore !== A.paceScore) return B.paceScore - A.paceScore;
      if(B.distance !== A.distance) return B.distance - A.distance;
      if(B.timeSec !== A.timeSec) return B.timeSec - A.timeSec;

      return 0;
    }

    if(typeA === "core" && typeB === "core"){
      const A = coreScore(a);
      const B = coreScore(b);

      if(B.totalVolume !== A.totalVolume) return B.totalVolume - A.totalVolume;
      if(B.reps !== A.reps) return B.reps - A.reps;
      if(B.timeSec !== A.timeSec) return B.timeSec - A.timeSec;
      if(B.weight !== A.weight) return B.weight - A.weight;

      return 0;
    }

    const aVol = num(a?.summary?.totalVolume);
    const bVol = num(b?.summary?.totalVolume);
    if(bVol !== aVol) return bVol - aVol;

    return 0;
  }

  function buildTopTextFromEntry(e){
    try{
      const type = String(e?.type || "");

      if(type === "weightlifting"){
        const sets = Array.isArray(e?.sets) ? e.sets : [];
        let best = null;

        for(const s of sets){
          const w = num(s?.weight);
          const r = num(s?.reps);
          if(!best || w > best.w || (w === best.w && r > best.r)){
            best = { w, r };
          }
        }

        if(best && best.w > 0) return `${best.w}×${best.r}`;
        if(num(e?.summary?.bestWeight) > 0) return `${num(e.summary.bestWeight)} (top)`;
        return "";
      }

      if(type === "cardio"){
        const d = e?.summary?.distance;
        const t = e?.summary?.timeSec;
        const p = e?.summary?.paceSecPerUnit;
        const dist = (d == null) ? "" : `Dist ${d}`;
        const time = (t == null) ? "" : `Time ${formatTime(num(t) || 0)}`;
        const pace = (p == null) ? "" : `Pace ${formatPace(p)}`;
        return [dist, time, pace].filter(Boolean).join(" • ");
      }

      if(type === "core"){
        const t = e?.summary?.timeSec;
        const reps = e?.summary?.reps;
        const sets = e?.summary?.sets;
        const w = e?.summary?.weight;
        const parts = [];
        if(Number.isFinite(Number(sets))) parts.push(`${Number(sets)} sets`);
        if(Number.isFinite(Number(reps))) parts.push(`${Number(reps)} reps`);
        if(Number.isFinite(Number(t))) parts.push(`${formatTime(Number(t) || 0)}`);
        if(Number.isFinite(Number(w)) && Number(w) > 0) parts.push(`${Number(w)} lb`);
        return parts.join(" • ");
      }

      return "";
    }catch(_){
      return "";
    }
  }

  const byRx = new Map();

  for(const e of entries){
    const key = String(e?.routineExerciseId || e?.exerciseId || "");
    if(!key) continue;

    exSet.add(key);

    if(Number.isFinite(Number(e?.summary?.totalVolume))){
      totalVolume += Number(e.summary.totalVolume) || 0;
    }

    if(!byRx.has(key)) byRx.set(key, []);
    byRx.get(key).push(e);
  }

  let details = null;

  try{
    const items = [];

    for(const [, group] of byRx.entries()){
      const sorted = group.slice().sort(compareEntries);
      const bestEntry = sorted[0] || group[0];
      if(!bestEntry) continue;

      const type = String(bestEntry?.type || "");
      const exerciseId = bestEntry?.exerciseId || null;

      const exName = (() => {
        try{
          const lib = state?.exerciseLibrary?.[type] || [];
          const found = lib.find(x => String(x.id || "") === String(exerciseId || ""));
          return found?.name || bestEntry?.nameSnap || "Exercise";
        }catch(_){
          return bestEntry?.nameSnap || "Exercise";
        }
      })();

      const mergedPRBadges = [];
      try{
        const anyWeight = group.some(x => x?.pr?.isPRWeight);
        const any1RM = group.some(x => x?.pr?.isPR1RM);
        const anyVol = group.some(x => x?.pr?.isPRVolume);
        const anyPace = group.some(x => x?.pr?.isPRPace);

        if(anyWeight) mergedPRBadges.push("PR W");
        if(any1RM) mergedPRBadges.push("PR 1RM");
        if(anyVol) mergedPRBadges.push("PR Vol");
        if(anyPace) mergedPRBadges.push("PR Pace");
      }catch(_){}

      if(mergedPRBadges.length) prCount += 1;

      let lifetime = null;
      try{
        if(LogEngine && typeof LogEngine.lifetimeBests === "function" && exerciseId){
          lifetime = LogEngine.lifetimeBests(type, exerciseId) || null;
        }
      }catch(_){}

      items.push({
        type,
        exerciseId,
        name: exName,
        topText: buildTopTextFromEntry(bestEntry),
        prBadges: mergedPRBadges,
        lifetime
      });
    }

    details = {
  routineName: ((state.routines || []).find(r => String(r.id || "") === String(routineId || ""))?.name || null),
  dayLabel: day?.label || null,
  dateISO: dateISO || null,
  items
};
  }catch(_){
    details = null;
  }

  return {
    highlights: {
      exerciseCount: exSet.size,
      prCount,
      totalVolume: Math.round(totalVolume * 100) / 100
    },
    details
  };
}

function readPendingWorkoutShareIntent(){
  try{
    return JSON.parse(localStorage.getItem(SOCIAL_PENDING_WORKOUT_SHARE_KEY) || "null");
  }catch(_){
    return null;
  }
}

function writePendingWorkoutShareIntent(payload){
  try{
    if(!payload){
      localStorage.removeItem(SOCIAL_PENDING_WORKOUT_SHARE_KEY);
      return;
    }
    localStorage.setItem(SOCIAL_PENDING_WORKOUT_SHARE_KEY, JSON.stringify(payload));
  }catch(_){}
}

function clearPendingWorkoutShareIntent(){
  try{
    localStorage.removeItem(SOCIAL_PENDING_WORKOUT_SHARE_KEY);
  }catch(_){}
}

function resolveRoutineAndDayForPendingShare(routineId, dayId){
  try{
    const routines = Array.isArray(state?.routines) ? state.routines : [];
    const routine = routines.find(r => String(r?.id || "") === String(routineId || ""));
    if(!routine) return { routine:null, day:null };

    const day = (routine.days || []).find(d => String(d?.id || "") === String(dayId || ""));
    return {
      routine: routine || null,
      day: day || null
    };
  }catch(_){
    return { routine:null, day:null };
  }
}

async function consumePendingWorkoutShareAfterAuth(){
  try{
    if(__pendingWorkoutShareReplayBusy) return false;
    if(!Social || !Social.getUser?.()) return false;

    const pending = readPendingWorkoutShareIntent();
    if(!pending) return false;

    const createdAt = Number(pending?.createdAt || 0) || 0;
    const ageMs = Date.now() - createdAt;
    const maxAgeMs = 15 * 60 * 1000;

    if(!createdAt || ageMs < 0 || ageMs > maxAgeMs){
      clearPendingWorkoutShareIntent();
      return false;
    }

    const dateISO = String(pending?.dateISO || "");
    const routineId = String(pending?.routineId || "");
    const dayId = String(pending?.dayId || "");

    if(!dateISO || !routineId || !dayId){
      clearPendingWorkoutShareIntent();
      return false;
    }

    // Keep behavior aligned with current feed-posting expectations:
    // only replay for today's completed workout.
    if(dateISO !== String(Dates.todayISO())){
      clearPendingWorkoutShareIntent();
      return false;
    }

    const resolved = resolveRoutineAndDayForPendingShare(routineId, dayId);
    const day = resolved?.day || null;

    if(!day){
      clearPendingWorkoutShareIntent();
      return false;
    }

    if(!isDayComplete(dateISO, day)){
      clearPendingWorkoutShareIntent();
      return false;
    }

    __pendingWorkoutShareReplayBusy = true;

    await syncWorkoutCompletedEventForDay(dateISO, routineId, day);
    clearPendingWorkoutShareIntent();

    try{
      showToast("Workout shared to feed");
    }catch(_){}

    return true;
  }catch(_){
    return false;
  }finally{
    __pendingWorkoutShareReplayBusy = false;
  }
}

async function maybePromptWorkoutFeedShare(dateISO, routineId, day){
  try{
    if(!Social) return;
    if(!Social.isConfigured?.()) return;
    if(Social.getUser?.()) return;
    if(!isDayComplete(dateISO, day)) return;

    // Match current workout-complete post behavior:
    // only offer replay for today's workout.
    if(String(dateISO || "") !== String(Dates.todayISO())) return;

    const routineName = (() => {
      try{
        return ((state.routines || []).find(r =>
          String(r?.id || "") === String(routineId || "")
        )?.name || "this workout");
      }catch(_){
        return "this workout";
      }
    })();

    Modal.open({
      title: "Share to Feed?",
      size: "sm",
      bodyNode: el("div", { class:"grid" }, [
        el("div", {
          style:"font-weight:900; font-size:14px;",
          text:"Would you like to share it to the feed?"
        }),
        el("div", {
          class:"note",
          text:`You’ll go to Friends to sign in first, then we’ll share ${routineName}.`
        }),
        el("div", { style:"height:8px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn",
            onClick: () => Modal.close()
          }, ["No"]),
          el("button", {
            class:"btn primary",
            onClick: () => {
              writePendingWorkoutShareIntent({
                source: "workout_complete_prompt",
                dateISO: String(dateISO || ""),
                routineId: String(routineId || ""),
                dayId: String(day?.id || ""),
                createdAt: Date.now()
              });

              Modal.close();
              navigate("friends");

              try{
                showToast("Continue with Google to share your workout");
              }catch(_){}
            }
          }, ["Yes"])
        ])
      ])
    });
  }catch(_){}
}
  
async function syncWorkoutCompletedEventForDay(dateISO, routineId, day){
  try{
    if(!Social) return;

    const safeDayId = day?.id || null;
    if(!dateISO || !routineId || !safeDayId) return;

    if(!isDayComplete(dateISO, day)){
      if(typeof Social.deleteWorkoutCompletedEvent === "function"){
        await Social.deleteWorkoutCompletedEvent({ dateISO, routineId, dayId: safeDayId });
      }
      return;
    }

    if(typeof Social.upsertWorkoutCompletedEvent === "function"){
      const data = buildWorkoutEventData(dateISO, routineId, day);
      await Social.upsertWorkoutCompletedEvent({
        dateISO,
        routineId,
        dayId: safeDayId,
        highlights: data.highlights,
        details: data.details
      });
    }
  }catch(_){}
}
  

function buildWeightliftingForm(){
  const rowsHost = el("div", { class:"logsetWLCard" }, []);
  const setInputs = [];

  const head = el("div", { class:"logsetGridHead" }, [
    el("div", { text:"Set" }),
    el("div", { text:"Weight" }),
    el("div", { text:"Reps" })
  ]);

  const rows = el("div", {}, []);

  function clearActive(){
    rows.querySelectorAll(".logsetRow.active").forEach(n => n.classList.remove("active"));
  }
  function setActiveRow(rowEl){
    clearActive();
    rowEl.classList.add("active");
  }
  function refreshSetNumbers(){
    const pills = rows.querySelectorAll(".logsetSetPill");
    pills.forEach((p, i) => p.textContent = String(i + 1));
  }

  const addRow = (w="", r="") => {
    const wInput = el("input", { type:"number", inputmode:"decimal", placeholder:"", value: w });
    const rInput = el("input", { type:"number", inputmode:"numeric", placeholder:"", value: r });

    setInputs.push({ wInput, rInput });

    const setPill = el("div", { class:"logsetSetPill", text: String(setInputs.length) });

    const row = el("div", { class:"logsetRow" }, [
      setPill,
      wInput,
      rInput
    ]);

    // Active row highlight when editing (focus/click)
    row.addEventListener("click", () => setActiveRow(row));
    row.addEventListener("focusin", () => setActiveRow(row));

    rows.appendChild(row);
    refreshSetNumbers();
  };

  // ✅ KEEP EXISTING FUNCTIONALITY:
  // planned sets still drive the defaults exactly like before
  const existingSets = (existingEntry?.sets || []);
  const plannedSets = Math.max(1, Math.min(12, Math.floor(Number(rx.plan?.sets) || 0))) || 0;
  const baseRows = plannedSets || 4;
  const rowsToShow = Math.max(baseRows, existingSets.length || 0);

  for(let i=0; i<rowsToShow; i++){
    const s = existingSets[i] || {};
    addRow(
      (s.weight ?? "") === 0 ? "" : String(s.weight ?? ""),
      (s.reps ?? "") === 0 ? "" : String(s.reps ?? "")
    );
  }

  // Buttons
  const addBtn = el("button", { class:"btn", onClick: () => {
    addRow();
    // focus weight input of the new row
    const last = setInputs[setInputs.length - 1];
    if(last?.wInput) last.wInput.focus();
  }}, ["+ Add Set"]);

      const saveBtn = el("button", {
    class:"btn primary",
    onClick: () => {
      clearErr();

      const dateISO = String(dateInput.value || initialDateISO);
      const wasComplete = isDayComplete(dateISO, day);

      const sets = setInputs.map(s => ({
        weight: Number(s.wInput.value) || 0,
        reps: Math.max(0, Math.floor(Number(s.rInput.value) || 0))
      })).filter(s => s.weight > 0 || s.reps > 0);

      if(sets.length === 0){
        showErr("Enter at least one set.");
        return;
      }

      const summary = LogEngine.computeWeightliftingSummary(sets);
      const pr = LogEngine.computePRFlags(type, exerciseId, summary);

      // Upsert: replace existing entry for this date + routineExerciseId
      LogEngine.ensure();
      state.logs.workouts = (state.logs.workouts || []).filter(e =>
        !(e.dateISO === dateISO && e.routineExerciseId === rx.id)
      );
      Storage.save(state);

      LogEngine.addEntry({
        id: uid("w"),
        createdAt: Date.now(),
        dateISO,
        type,
        exerciseId,
        routineExerciseId: rx.id,
        routineId: routineId || null,
        dayId: day.id,
        dayOrder: day.order,
        sets,
        summary,
        pr
      });

      afterSave(dateISO, wasComplete);
    }
  }, ["Save"]);

  // Sticky bar (two buttons only)
  const sticky = el("div", { class:"logsetStickyBar" }, [ addBtn, saveBtn ]);

  rowsHost.appendChild(head);
  rowsHost.appendChild(rows);
  rowsHost.appendChild(sticky);

  // Make the first row “active” by default (if any)
  setTimeout(() => {
    const firstRow = rows.querySelector(".logsetRow");
    if(firstRow) firstRow.classList.add("active");
  }, 0);

  return rowsHost;
}

  function buildCardioForm(){
    const minInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Min", value:"" });
    const secInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Sec", value:"" });
    const distInput = el("input", { type:"number", inputmode:"decimal", placeholder:"Distance", value:"" });
    const inclInput = el("input", { type:"number", inputmode:"decimal", placeholder:"Incline (optional)", value:"" });

    // Prefill if already logged on initial date
    if(existingEntry?.sets?.[0]){
      const s = existingEntry.sets[0];
      const t = Math.max(0, Math.floor(Number(s.timeSec) || 0));
      minInput.value = String(Math.floor(t / 60) || "");
      secInput.value = String((t % 60) || "");
      distInput.value = (s.distance != null && Number(s.distance) !== 0) ? String(s.distance) : "";
      inclInput.value = (s.incline != null && String(s.incline) !== "0") ? String(s.incline) : "";
    }

            const saveBtn = el("button", {
      class:"btn primary",
      onClick: () => {
        clearErr();

        const dateISO = String(dateInput.value || initialDateISO);
        const wasComplete = isDayComplete(dateISO, day);

        const min = Math.max(0, Math.floor(Number(minInput.value) || 0));
        const sec = Math.max(0, Math.floor(Number(secInput.value) || 0));
        const timeSec = (min * 60) + sec;
        const distance = Number(distInput.value) || 0;
        const incline = (inclInput.value === "") ? null :
          (Number.isFinite(Number(inclInput.value)) ? Number(inclInput.value) : null);

        if(timeSec <= 0 && distance <= 0){
          showErr("Enter time and/or distance.");
          return;
        }

        const sets = [{ timeSec, distance, incline }];
        const summary = LogEngine.computeCardioSummary(sets);
        const pr = LogEngine.computePRFlags(type, exerciseId, summary);

        // Upsert: replace existing entry for this date + routineExerciseId
        LogEngine.ensure();
        state.logs.workouts = (state.logs.workouts || []).filter(e =>
          !(e.dateISO === dateISO && e.routineExerciseId === rx.id)
        );
        Storage.save(state);

        LogEngine.addEntry({
          id: uid("c"),
          createdAt: Date.now(),
          dateISO,
          type,
          exerciseId,
          routineExerciseId: rx.id,
          routineId: routineId || null,
          dayId: day.id,
          dayOrder: day.order,
          sets,
          summary,
          pr
        });

        afterSave(dateISO, wasComplete);
      }
    }, ["Save"]);

const cancelBtn = el("button", { class:"btn", onClick: Modal.close }, ["Cancel"]);

const sticky = el("div", { class:"logsetStickyBar" }, [ cancelBtn, saveBtn ]);

return el("div", { class:"card" }, [
  el("h2", { text:"Session" }),
  el("div", { class:"row2" }, [
    el("label", {}, [ el("span", { text:"Minutes" }), minInput ]),
    el("label", {}, [ el("span", { text:"Seconds" }), secInput ])
  ]),
  el("div", { class:"row2" }, [
    el("label", {}, [ el("span", { text:"Distance" }), distInput ]),
    el("label", {}, [ el("span", { text:"Incline" }), inclInput ])
  ]),
  sticky
]);
  }

  function buildCoreForm(){
    const setsInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Sets", value:"" });
    const repsInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Reps", value:"" });
    const timeMinInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Min", value:"" });
    const timeSecInput = el("input", { type:"number", inputmode:"numeric", placeholder:"Sec", value:"" });
    const weightInput = el("input", { type:"number", inputmode:"decimal", placeholder:"Weight (optional)", value:"" });

    // Prefill if already logged on initial date
    if(existingEntry?.sets?.[0]){
      const s = existingEntry.sets[0];
      setsInput.value = (s.sets != null && Number(s.sets) !== 0) ? String(s.sets) : "";
      repsInput.value = (s.reps != null && Number(s.reps) !== 0) ? String(s.reps) : "";
      const t = Math.max(0, Math.floor(Number(s.timeSec) || 0));
      timeMinInput.value = String(Math.floor(t / 60) || "");
      timeSecInput.value = String((t % 60) || "");
      weightInput.value = (s.weight != null && Number(s.weight) !== 0) ? String(s.weight) : "";
    }

           const saveBtn = el("button", {
      class:"btn primary",
      onClick: () => {
        clearErr();

        const dateISO = String(dateInput.value || initialDateISO);
        const wasComplete = isDayComplete(dateISO, day);

        const setsN = Math.max(0, Math.floor(Number(setsInput.value) || 0));
        const repsN = Math.max(0, Math.floor(Number(repsInput.value) || 0));
        const tmin = Math.max(0, Math.floor(Number(timeMinInput.value) || 0));
        const tsec = Math.max(0, Math.floor(Number(timeSecInput.value) || 0));
        const timeSec = (tmin * 60) + tsec;
        const weight = Number(weightInput.value) || 0;

        if((setsN <= 0 || repsN <= 0) && timeSec <= 0){
          showErr("Enter sets+reps or a time.");
          return;
        }

        const sets = [{ sets: setsN, reps: repsN, timeSec, weight }];
        const summary = LogEngine.computeCoreSummary(sets);
        const pr = LogEngine.computePRFlags(type, exerciseId, summary);

        // Upsert: replace existing entry for this date + routineExerciseId
        LogEngine.ensure();
        state.logs.workouts = (state.logs.workouts || []).filter(e =>
          !(e.dateISO === dateISO && e.routineExerciseId === rx.id)
        );
        Storage.save(state);

        LogEngine.addEntry({
          id: uid("k"),
          createdAt: Date.now(),
          dateISO,
          type,
          exerciseId,
          routineExerciseId: rx.id,
          routineId: routineId || null,
          dayId: day.id,
          dayOrder: day.order,
          sets,
          summary,
          pr
        });

        afterSave(dateISO, wasComplete);
      }
    }, ["Save"]);

const cancelBtn = el("button", { class:"btn", onClick: Modal.close }, ["Cancel"]);

const sticky = el("div", { class:"logsetStickyBar" }, [ cancelBtn, saveBtn ]);

return el("div", { class:"card" }, [
  el("h2", { text:"Core" }),
  el("div", { class:"row2" }, [
    el("label", {}, [ el("span", { text:"Sets" }), setsInput ]),
    el("label", {}, [ el("span", { text:"Reps" }), repsInput ])
  ]),
  el("div", { class:"row2" }, [
    el("label", {}, [ el("span", { text:"Time (min)" }), timeMinInput ]),
    el("label", {}, [ el("span", { text:"Time (sec)" }), timeSecInput ])
  ]),
  el("label", {}, [ el("span", { text:"Weight" }), weightInput ]),
  sticky
]);

  }

  function formatEntryOneLine(type, entry){
    try{
      if(type === "weightlifting"){
        const bw = entry?.summary?.bestWeight;
        const vol = entry?.summary?.totalVolume;
        return `Top ${bw ?? "—"} • Vol ${vol ?? "—"}`;
      }
      if(type === "cardio"){
        const d = entry?.summary?.distance;
        const t = entry?.summary?.timeSec;
        const p = entry?.summary?.paceSecPerUnit;
        return `${d ?? "—"} units • ${formatTime(t ?? 0)} • Pace ${formatPace(p)}`;
      }
      const v = entry?.summary?.totalVolume;
      return `Volume ${v ?? "—"}`;
    }catch(e){
      return "—";
    }
  }
}

function getRoutineExerciseEntries(dateISO, routineExerciseId){
  return (state.logs?.workouts || []).filter(e =>
    String(e?.dateISO || "") === String(dateISO || "") &&
    String(e?.routineExerciseId || "") === String(routineExerciseId || "")
  );
}

function hasRoutineExerciseSkipped(dateISO, routineExerciseId){
  return getRoutineExerciseEntries(dateISO, routineExerciseId).some(e => !!e?.skipped);
}

function hasRoutineExerciseLogged(dateISO, routineExerciseId){
  return getRoutineExerciseEntries(dateISO, routineExerciseId).some(e => !e?.skipped);
}

function isRoutineExerciseDone(dateISO, routineExerciseId){
  return hasRoutineExerciseLogged(dateISO, routineExerciseId) ||
         hasRoutineExerciseSkipped(dateISO, routineExerciseId);
}

function clearSkippedRoutineExercise(dateISO, routineExerciseId){
  const before = (state.logs?.workouts || []).length;

  state.logs.workouts = (state.logs.workouts || []).filter(e =>
    !(
      String(e?.dateISO || "") === String(dateISO || "") &&
      String(e?.routineExerciseId || "") === String(routineExerciseId || "") &&
      !!e?.skipped
    )
  );

  if((state.logs.workouts || []).length !== before){
    Storage.save(state);
    return true;
  }

  return false;
}

function markRoutineExerciseSkipped({ dateISO, routineId, day, rx }){
  if(!dateISO || !routineId || !day?.id || !rx?.id) return false;

  // Do not overwrite a real logged exercise with skip.
  if(hasRoutineExerciseLogged(dateISO, rx.id)) return false;

  LogEngine.ensure();

  state.logs.workouts = (state.logs.workouts || []).filter(e =>
    !(
      String(e?.dateISO || "") === String(dateISO || "") &&
      String(e?.routineExerciseId || "") === String(rx.id || "")
    )
  );

  state.logs.workouts.push({
    id: uid("skip"),
    createdAt: Date.now(),
    dateISO,
    type: rx.type,
    exerciseId: rx.exerciseId,
    routineExerciseId: rx.id,
    routineId,
    dayId: day.id,
    dayOrder: day.order,
    nameSnap: rx.nameSnap || resolveExerciseName(rx.type, rx.exerciseId, rx.nameSnap),
    sets: [],
    summary: {},
    pr: {},
    skipped: true
  });

  Storage.save(state);
  return true;
}

function isDayComplete(dateISO, day){
  const ex = (day?.exercises || []);
  if(ex.length === 0) return false;
  return ex.every(rx => isRoutineExerciseDone(dateISO, rx.id));
}
  
  function removeWorkoutEntriesForRoutineDay(dateISO, routineId, dayId){
  // Remove all workout log entries for a specific routine day (date + routine + day)
  LogEngine.ensure();

  const d  = String(dateISO || "");
  const r  = String(routineId || "");
  const dy = String(dayId || "");

  const before = (state.logs?.workouts || []).length;

  state.logs.workouts = (state.logs.workouts || []).filter(e =>
    !(
      String(e?.dateISO || "") === d &&
      String(e?.routineId || "") === r &&
      String(e?.dayId || "") === dy
    )
  );

  // Save only if something actually changed
  if((state.logs.workouts || []).length !== before){
    Storage.save(state);
  }
}
  
  function repaint(){
  routine = Routines.getActive();
  root.innerHTML = "";

  // Fixed (top) vs scrollable (below carousel)
  const fixedHost = el("div", { class:"routineFixed" });
  const scrollHost = el("div", { class:"routineScroll" });
  root.appendChild(fixedHost);
  root.appendChild(scrollHost);

  const day = getDay(selectedIndex);
  const selectedDateISO = getSelectedDateISO(selectedIndex);

function openExerciseHistoryModal(type, exerciseId, exNameOverride=null){
  LogEngine.ensure();

  const exName = exNameOverride || resolveExerciseName(type, exerciseId, "Exercise");
  const entries = LogEngine.entriesForExercise(type, exerciseId); // desc (most recent first)

  const head = el("div", { class:"note" }, [
    `${exName} • ${ExerciseLibrary.typeLabel(type)}`
  ]);

  const list = el("div", { class:"list" });

  if(entries.length === 0){
    list.appendChild(el("div", { class:"note", text:"No history yet for this exercise." }));
  }else{
    // Show last entry + recent history (top 12)
    entries.slice(0, 12).forEach(e => {
      list.appendChild(el("div", { class:"item" }, [
        el("div", { class:"left" }, [
          el("div", { class:"name", text: e.dateISO }),
          el("div", { class:"meta", text: formatEntryDetail(type, e) })
        ]),
        el("div", { class:"actions" }, [
          el("div", { class:"meta", text: prBadges(e.pr) })
        ])
      ]));
    });
  }

   Modal.open({
    title: "History",
    center: true,
    bodyNode: el("div", { class:"grid" }, [
      head,
      list,
      el("div", { style:"height:10px" }),
      el("button", { class:"btn", onClick: Modal.close }, ["Close"])
    ])
  });

  function prBadges(pr){
    if(!pr) return "";
    const b = [];
    if(pr.isPRWeight) b.push("PR W");
    if(pr.isPR1RM) b.push("PR 1RM");
    if(pr.isPRVolume) b.push("PR Vol");
    if(pr.isPRPace) b.push("PR Pace");
    return b.join(" • ");
  }

  function formatEntryDetail(type, entry){
    try{
      if(type === "weightlifting"){
        const sets = (entry.sets || []).map(s => `${s.weight || 0}×${s.reps || 0}`).join(" • ");
        const top = entry.summary?.bestWeight ?? "—";
        const vol = entry.summary?.totalVolume ?? "—";
        return `Sets: ${sets || "—"} | Top: ${top} | Vol: ${vol}`;
      }
      if(type === "cardio"){
        const d = entry.summary?.distance ?? "—";
        const t = formatTime(entry.summary?.timeSec ?? 0);
        const p = formatPace(entry.summary?.paceSecPerUnit);
        const inc = (entry.summary?.incline == null) ? "" : ` | Incline: ${entry.summary.incline}`;
        return `Dist: ${d} | Time: ${t} | Pace: ${p}${inc}`;
      }
      // core
      const s0 = (entry.sets || [])[0] || {};
      const vol = entry.summary?.totalVolume ?? "—";
      const repPart = (s0.sets && s0.reps) ? `${s0.sets}×${s0.reps}` : "";
      const timePart = (s0.timeSec && s0.timeSec > 0) ? formatTime(s0.timeSec) : "";
      const wPart = (s0.weight && s0.weight > 0) ? ` @ ${s0.weight}` : "";
      const detail = [repPart, timePart].filter(Boolean).join(" • ");
      return `${detail || "—"}${wPart} | Vol: ${vol}`;
    }catch(e){
      return "—";
    }
  }
}

    // ────────────────────────────
    // Header Card (locked layout)
    // ────────────────────────────
// ✅ NEW: persisted preference (default ON)
const show3DPreview = (state.profile?.show3DPreview !== false);

function setShow3DPreview(v){
  state.profile = state.profile || {};
  state.profile.show3DPreview = !!v;
  Storage.save(state);
  renderView(); // re-render Routine cleanly
}
    fixedHost.appendChild(el("div", { class:"card routineHeaderCard" }, [
  el("h2", { text:"Routine" }),
  el("div", { class:"note", text:`${routine.name} • ${weekStartsOn === "sun" ? "Sun–Sat" : "Mon–Sun"}` }),

  // ✅ Start Today (top-right)
  el("button", {
    class:"btn primary routineStartBtn",
    onClick: () => {
      selectedIndex = todayIndex;
      repaint();
      setTimeout(()=>{
        const first = scrollHost.querySelector("[data-unlogged='true']");
        if(first){
          first.scrollIntoView({ behavior:"smooth", block:"center" });
          first.classList.add("pulse");
          setTimeout(()=>first.classList.remove("pulse"),1200);
        }
      },0);
    }
  }, ["▶ Start Today"]),

  // ✅ 3D Preview toggle (bottom-right)
  el("button", {
    class:"btn mini routine3DToggle",
    onClick: () => setShow3DPreview(!show3DPreview)
  }, [`3D Preview: ${show3DPreview ? "ON" : "OFF"} 👁`]),

  el("div", { style:"height:10px" }),

  // Left-side: routine picker only
  el("div", { class:"rHdrRow" }, [
    el("button", {
      class:"btn ghost",
      onClick: (e) => openRoutinePicker(e.currentTarget)
    }, [`${routine.name} ▼`])
  ]),

  el("div", {
    class:"manageLink",
    onClick: () => navigate("routine_editor")
  }, ["Manage Routine ▾"])
]));


    if(!day){
      scrollHost.appendChild(el("div", { class:"card note" }, ["No day found."]));
      return;
    }

    // ────────────────────────────
    // 3D Card Carousel (visual container)
    // ────────────────────────────
// ✅ Only render the 3D carousel when enabled
if(show3DPreview){
  fixedHost.appendChild(el("div", { class:"card carouselCard" }, [
    (() => {
      let down = false;
      let startX = 0;
      let dx = 0;
      const THRESH = 55;

      function onDown(e){
        down = true;
        startX = e.clientX;
        dx = 0;
        try{ e.currentTarget.setPointerCapture(e.pointerId); }catch(_){}
      }
      function onMove(e){
        if(!down) return;
        dx = e.clientX - startX;
      }
      function onEnd(){
        if(!down) return;
        down = false;

        if(dx <= -THRESH) selectedIndex = (selectedIndex + 1) % 7;
        else if(dx >= THRESH) selectedIndex = (selectedIndex + 6) % 7;

        repaint();
      }

      const names = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

      const c3d = el("div", {
        class:"c3d",
        onPointerDown: onDown,
        onPointerMove: onMove,
        onPointerUp: onEnd,
        onPointerCancel: onEnd,
        onLostPointerCapture: onEnd
      }, []);

      const offsets = [-2,-1,0,1,2];
      offsets.forEach(off => {
        const idx = (selectedIndex + off + 7) % 7;
        const d = getDay(idx) || { label:"Day", isRest:false, exercises:[] };

        const abs = Math.abs(off);
        const scale = (off === 0) ? 1 : (1 - abs * 0.10);
        const x = off * 92;
        const z = -(abs * 95);
        const y = abs * 6;
        const rot = off * -22;
        const op = (off === 0) ? 1 : (abs === 1 ? .65 : .30);

        const chips = [];
        chips.push(el("div", { class:"c3dChip", text: d.isRest ? "Rest Day" : "Training Day" }));
        if(idx === selectedIndex) chips.push(el("div", { class:"c3dChip active", text:"Active" }));

        const card = el("div", {
          class: "c3dCard" + (idx === selectedIndex ? " sel" : ""),
          style: `transform: translateX(${x}px) translateY(${y}px) translateZ(${z}px) rotateY(${rot}deg) scale(${scale}); opacity:${op};`
        }, [
          el("div", {}, [
            el("div", { class:"c3dDay", text: names[idx].toUpperCase() }),
            el("div", { class:"c3dLabel", text: d.label || "Day" }),
            el("div", { class:"c3dMeta", text: d.isRest ? "Rest" : `${(d.exercises||[]).length} exercises` })
          ]),
          el("div", { class:"c3dChips" }, chips)
        ]);

        card.addEventListener("click", () => {
          selectedIndex = idx;
          repaint();
        });

        c3d.appendChild(card);
      });

      return c3d;
    })()
  ]));
}

fixedHost.appendChild(el("div", { class:"routineDayStrip" }, [
  ...(weekStartsOn === "sun" ? [0,1,2,3,4,5,6] : [1,2,3,4,5,6,0]).map(i => {
    const d = getDay(i) || { label:"", isRest:false, exercises:[] };

    // date number for the week (uses your already-defined weekStartISO)
    const dateISO = Dates.addDaysISO(weekStartISO, (i - (weekStartsOn === "sun" ? 0 : 1) + 7) % 7);
    const dayNum = (() => {
      try{ return new Date(dateISO + "T00:00:00").getDate(); }
      catch(_){ return ""; }
    })();

    const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][i].toUpperCase();
    const dayLabel = d.isRest ? "Rest" : (d.label || "Training");

    return el("button", {
      class: "routineDayBtn" + (i === selectedIndex ? " sel" : "") + (d.isRest ? " rest" : ""),
      onClick: () => { selectedIndex = i; repaint(); }
    }, [
      el("div", { class:"dow", text: dow }),
      el("div", { class:"num", text: String(dayNum || "") }),
      ...(show3DPreview 
            ? [] 
            : [el("div", { class:"lbl", text: dayLabel })]
        ),
      el("div", { class:"dot" })
    ]);
  })
]));


    // Rest Day
    if(day.isRest){
scrollHost.appendChild(el("div", { class:"card restCard" }, [
        el("h2", { text:"Rest" }),
        el("div", { class:"note", text:`Rest day scheduled for ${selectedDateISO}.` })
      ]));
      return;
    }
    // Day completion banner
    if(isDayComplete(selectedDateISO, day)){
scrollHost.appendChild(el("div", { class:"card" }, [
        el("h2", { text:"Completed" }),
        el("div", { class:"note", text:`All exercises logged or skipped for ${selectedDateISO}.` }),
        el("div", { style:"height:10px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn danger",
                onClick: async () => {
              removeWorkoutEntriesForRoutineDay(selectedDateISO, routine.id, day.id);
              attendanceRemove(selectedDateISO);

              try{
                if(Social && typeof Social.deleteWorkoutCompletedEvent === "function"){
                  await Social.deleteWorkoutCompletedEvent({
                    dateISO: selectedDateISO,
                    routineId: routine.id,
                    dayId: day.id
                  });
                }
              }catch(_){}

              setNextNudge(null);
              repaint();
              showToast("Marked incomplete");
            }
          }, ["Mark incomplete"])
        ])
      ]));
    }


// ────────────────────────────
// Exercise Cards (compact)
// ────────────────────────────
(day.exercises || []).forEach(rx => {
  const exName = resolveExerciseName(rx.type, rx.exerciseId, rx.nameSnap);
  const skipped = hasRoutineExerciseSkipped(selectedDateISO, rx.id);
  const logged = hasRoutineExerciseLogged(selectedDateISO, rx.id);
  const done = logged || skipped;

  const chipClass = "rxChip" + (logged ? " on" : "");
  const chipStyle = skipped
    ? "background:rgba(255,179,71,.18); color:#ffb347; border-color:rgba(255,179,71,.35);"
    : "";

  const max = lifetimeMaxSet(rx.type, rx.exerciseId);
  const maxText = max ? `${max.weight} × ${max.reps}` : "—";

  const actionChildren = [
    el("button", {
      class:"btn primary sm",
      onClick: () => openExerciseLogger(rx, day, selectedDateISO)
    }, [logged ? "Edit Log" : "Log Sets"])
  ];

  if(skipped){
    actionChildren.push(
      el("button", {
        class:"btn sm",
        onClick: async () => {
          const wasComplete = isDayComplete(selectedDateISO, day);

          clearSkippedRoutineExercise(selectedDateISO, rx.id);
          setNextNudge(null);

          const currentRoute = (typeof getCurrentRoute === "function")
            ? getCurrentRoute()
            : "";

          if(currentRoute === "home"){
            renderView();
          }else{
            repaint();
          }

          const nowComplete = isDayComplete(selectedDateISO, day);

          if(wasComplete && !nowComplete){
            attendanceRemove(selectedDateISO);
            await syncWorkoutCompletedEventForDay(selectedDateISO, routine.id, day);
            showToast("Marked incomplete");
            return;
          }

          await syncWorkoutCompletedEventForDay(selectedDateISO, routine.id, day);
          showToast("Skip removed");
        }
      }, ["Undo Skip"])
    );
  }else if(!logged){
    actionChildren.push(
      el("button", {
        class:"btn sm",
        onClick: () => confirmModal({
          title: "Skip exercise?",
          note: "This will count the exercise as skipped for this workout. It will still allow workout completion, but it will not affect PRs or feed highlights.",
          confirmText: "Skip exercise",
          onConfirm: async () => {
            const wasComplete = isDayComplete(selectedDateISO, day);

            const changed = markRoutineExerciseSkipped({
              dateISO: selectedDateISO,
              routineId: routine.id,
              day,
              rx
            });

            if(!changed){
              showToast("Could not skip exercise");
              return;
            }

            const currentRoute = (typeof getCurrentRoute === "function")
              ? getCurrentRoute()
              : "";

            if(currentRoute === "home"){
              renderView();
            }else{
              repaint();
            }

            const nowComplete = isDayComplete(selectedDateISO, day);

            if(nowComplete){
              attendanceAdd(selectedDateISO);

              if(!wasComplete){
                showToast("Day completed ✅");
              }else{
                showToast("Exercise skipped");
              }

              await syncWorkoutCompletedEventForDay(selectedDateISO, routine.id, day);

              if(!wasComplete){
                await maybePromptWorkoutFeedShare(selectedDateISO, routine.id, day);
              }
            }else{
              showToast("Exercise skipped");
            }
          }
        })
      }, ["Skip Exercise"])
    );
  }

  actionChildren.push(
    el("button", {
      class:"btn ghost sm",
      onClick: () => openExerciseHistoryModal(rx.type, rx.exerciseId, exName)
    }, ["History →"])
  );

  scrollHost.appendChild(el("div", {
    class:"card rxCard",
    id:`routine_rx_${rx.id}`,
    "data-unlogged": done ? "false" : "true"
  }, [
    el("div", { class:"rxTop" }, [
      el("div", { class:"rxName", text: exName }),
      el("div", {
        class: chipClass,
        style: chipStyle,
        text: logged ? "Logged" : (skipped ? "Skipped" : "Not logged")
      })
    ]),

    el("div", { class:"rxMeta", text:`🏆 Lifetime Max: ${maxText}` }),

    el("div", { class:"rxActions" }, actionChildren)
  ]));
});

  }

  repaint();
  return root;
},

Progress(){
  ExerciseLibrary.ensureSeeded();
  LogEngine.ensure();

  // Defaults
  let type = "weightlifting";
  let exerciseId = (state.exerciseLibrary?.weightlifting?.[0]?.id) || null;

  // Filters
  let routineId = ""; // "" = All routines
  const todayISO = Dates.todayISO();

  // ✅ If you logged sets with a manual date override (including future dates),
  // default Progress "To" to the latest logged date so the chart/history populate.
  function latestWorkoutDateISO(){
    const arr = (state.logs?.workouts || []);
    let max = "";
    for(const e of arr){
      const d = String(e?.dateISO || "");
      // ISO YYYY-MM-DD strings compare correctly lexicographically
      if(d && d > max) max = d;
    }
    return max || null;
  }

  const latestISO = latestWorkoutDateISO();
  const defaultToISO = (latestISO && latestISO > todayISO) ? latestISO : todayISO;

  let toISO = defaultToISO;
  let fromISO = Dates.addDaysISO(toISO, -30);


  // Metric default per type
  let metric = defaultMetricForType(type);

  // Search state
  let query = "";

  const root = el("div", { class:"grid" });

  // Header
  root.appendChild(el("div", { class:"card" }, [
    el("h2", { text:"Progress" }),
    el("div", { class:"note", text:"Search an exercise, then view trends + history. Keep the graph front-and-center." })
  ]));

  // ────────────────────────────
  // Compact Controls + Overview (single card)
  // ────────────────────────────
  const topCard = el("div", { class:"card" }, [
    el("h2", { text:"Find exercise" })
  ]);

  // Type segmented
  const typeRow = el("div", { class:"segRow" });
  const typeBtns = {
    weightlifting: el("button", { class:"seg", onClick: () => setType("weightlifting") }, ["Weightlifting"]),
    cardio:        el("button", { class:"seg", onClick: () => setType("cardio") }, ["Cardio"]),
    core:          el("button", { class:"seg", onClick: () => setType("core") }, ["Core"])
  };
  typeRow.appendChild(typeBtns.weightlifting);
  typeRow.appendChild(typeBtns.cardio);
  typeRow.appendChild(typeBtns.core);

  // Search bar + selected pill
  const searchWrap = el("div", { class:"progSearch" }, [
    el("div", { class:"ico", text:"🔎" }),
    el("input", {
      type:"text",
      value:"",
      placeholder:"Search exercise (e.g., Bench, Squat, Treadmill)…",
      onInput: (e) => {
        query = String(e.target.value || "");
        repaint(false);
      }
    })
  ]);

  const selectedRow = el("div", { class:"pillRow" });
  const resultsHost = el("div", { class:"progResults" });

  // Routine select (kept, but compact)
  const routineSelect = el("select", {});
  routineSelect.appendChild(el("option", { value:"", text:"All routines" }));
  routineSelect.addEventListener("change", () => {
    routineId = routineSelect.value || "";
    repaint(true);
  });

  // Date range chips
  const rangeRow = el("div", { class:"segRow" });
  const r7  = el("button", { class:"seg", onClick: () => { setRange(7); } }, ["7D"]);
  const r30 = el("button", { class:"seg", onClick: () => { setRange(30); } }, ["30D"]);
  const r90 = el("button", { class:"seg", onClick: () => { setRange(90); } }, ["90D"]);
  const r1y = el("button", { class:"seg", onClick: () => { setRange(365); } }, ["1Y"]);
  rangeRow.appendChild(r7); rangeRow.appendChild(r30); rangeRow.appendChild(r90); rangeRow.appendChild(r1y);

  // Custom date inputs (still available, compact)
  const fromInput = el("input", { type:"date", value: fromISO });
  const toInput   = el("input", { type:"date", value: toISO });

  fromInput.addEventListener("change", () => {
    fromISO = fromInput.value || fromISO;
    if(fromISO > toISO){
      toISO = fromISO;
      toInput.value = toISO;
    }
    repaint(true);
  });

  toInput.addEventListener("change", () => {
    toISO = toInput.value || toISO;
    if(toISO < fromISO){
      fromISO = toISO;
      fromInput.value = fromISO;
    }
    repaint(true);
  });

  // Metric segmented
  const metricRow = el("div", { class:"segRow" });

  // Overview host (compact KPIs)
const statsHost = el("div", { class:"pillRow", style:"margin-top:8px;" });

  topCard.appendChild(el("div", { class:"note", text:"Type + search to select an exercise." }));
  topCard.appendChild(typeRow);
  topCard.appendChild(el("div", { style:"height:10px" }));
  topCard.appendChild(searchWrap);
  topCard.appendChild(selectedRow);
  topCard.appendChild(resultsHost);

  topCard.appendChild(el("div", { style:"height:10px" }));

// Dates (single-line)
topCard.appendChild(el("div", {
  style:"display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:2px;"
}, [
  el("div", { class:"note", text:"From:" }),
  fromInput,
  el("div", { class:"note", text:"|" }),
  el("div", { class:"note", text:"To:" }),
  toInput
]));

  topCard.appendChild(el("div", { style:"height:8px" }));
  topCard.appendChild(el("div", { class:"note", text:"Metric" }));
  topCard.appendChild(metricRow);

  topCard.appendChild(el("div", { style:"height:10px" }));
  topCard.appendChild(el("div", { class:"note", text:"Overview" }));
  topCard.appendChild(statsHost);

  root.appendChild(topCard);

  // ────────────────────────────
  // Graph (primary focus)
  // ────────────────────────────
  const chartCard = el("div", { class:"card" }, [
    el("h2", { text:"Trend" })
  ]);
  const chartWrap = el("div", { class:"chartWrap" });
  const canvas = el("canvas", {});
  chartWrap.appendChild(canvas);
  const chartNote = el("div", { class:"note", style:"margin-top:10px;" });

  chartCard.appendChild(chartWrap);
  chartCard.appendChild(chartNote);
  root.appendChild(chartCard);

  // ────────────────────────────
  // History (collapsible)
  // ────────────────────────────
  const tableCard = el("div", { class:"card" }, [
    el("div", { class:"accItem" }, [
      el("div", {
        class:"accHead",
        onClick: () => {
          const body = tableCard.querySelector(".accBody");
          const caret = tableCard.querySelector(".accCaret");
          const isOpen = body.style.display === "block";
          body.style.display = isOpen ? "none" : "block";
          caret.textContent = isOpen ? "▾" : "▴";
        }
      }, [
        el("div", { class:"accTitle", text:"History" }),
        el("div", { class:"accCaret", text:"▾" })
      ]),
      el("div", { class:"accBody" }, [
        el("div", { class:"note", text:"Most recent logs for the selected exercise." }),
        el("div", { style:"height:8px" }),
        el("div", { class:"list", id:"progressHistoryHost" })
      ])
    ])
  ]);
  const tableHost = tableCard.querySelector("#progressHistoryHost");
  root.appendChild(tableCard);

  // Populate routine dropdown
  repaintRoutineSelect();

  // Initial paint
  repaint(true);
  return root;

  // ---- helpers ----
  function defaultMetricForType(t){
    if(t === "weightlifting") return "topWeight";
    if(t === "cardio") return "pace";
    return "volume";
  }

  function setType(next){
    type = next;
    query = "";
    searchWrap.querySelector("input").value = "";
    exerciseId = (state.exerciseLibrary?.[type]?.[0]?.id) || null;
    metric = defaultMetricForType(type);
    repaint(true);
  }

  function setRange(days){
    fromISO = Dates.addDaysISO(todayISO, -Math.max(1, Number(days) || 30));
    toISO = todayISO;
    fromInput.value = fromISO;
    toInput.value = toISO;
    repaint(true);
  }

  function repaintRoutineSelect(){
    routineSelect.innerHTML = "";
    routineSelect.appendChild(el("option", { value:"", text:"All routines" }));
    const all = Routines.getAll?.() || [];
    all.forEach(r => routineSelect.appendChild(el("option", { value:r.id, text:r.name })));
    routineSelect.value = routineId || "";
  }

  function setMetric(next){
    metric = next;
    repaint(true);
  }

  function repaintMetricRow(){
    metricRow.innerHTML = "";

    if(type === "weightlifting"){
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("topWeight") }, ["Top Weight"]));
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("est1RM") }, ["Est 1RM"]));
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("volume") }, ["Volume"]));
    } else if(type === "cardio"){
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("pace") }, ["Pace"]));
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("distance") }, ["Distance"]));
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("timeSec") }, ["Time"]));
    } else {
      metricRow.appendChild(el("button", { class:"seg", onClick: () => setMetric("volume") }, ["Volume"]));
    }

    // active styles
    [...metricRow.querySelectorAll(".seg")].forEach(btn => {
      const v = (btn.textContent || "").toLowerCase();
      const isActive =
        (metric === "topWeight" && v.includes("top")) ||
        (metric === "est1RM" && v.includes("1rm")) ||
        (metric === "volume" && v.includes("volume")) ||
        (metric === "pace" && v.includes("pace")) ||
        (metric === "distance" && v.includes("distance")) ||
        (metric === "timeSec" && v.includes("time"));
      btn.classList.toggle("active", isActive);
    });
  }

  function repaintTypeRow(){
    Object.entries(typeBtns).forEach(([k,btn]) => btn.classList.toggle("active", k === type));
  }

  function confirmDeleteLog(entry){
    Modal.open({
      title: "Delete log?",
      bodyNode: el("div", { class:"grid" }, [
        el("div", { class:"note", text:`This will permanently delete this log entry:` }),
        el("div", { class:"note", text:`${entry.dateISO} • ${tableLine(entry)}` }),
        el("div", { style:"height:10px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn danger",
                        onClick: async () => {
              removeWorkoutEntryById(entry.id);

              try{
                const routineId = entry?.routineId || null;
                const dayId = entry?.dayId || null;
                const dateISO = entry?.dateISO || null;
                const day = (routineId && dayId) ? Routines.getDay(routineId, dayId) : null;

                if(day && dateISO){
                  await syncWorkoutCompletedEventForDay(dateISO, routineId, day);
                }else if(Social && typeof Social.deleteWorkoutCompletedEvent === "function"){
                  await Social.deleteWorkoutCompletedEvent({ dateISO, routineId, dayId });
                }
              }catch(_){}

              Modal.close();
              repaint(true);
              showToast("Deleted");
            }
          }, ["Delete"]),
          el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
        ])
      ]),
      size: "sm"
    });
  }

  function repaint(forceChart){
    repaintTypeRow();
    repaintMetricRow();

    // Exercise library for current type
    const lib = (state.exerciseLibrary?.[type] || []).slice()
      .sort((a,b) => (a.name||"").localeCompare(b.name||""));

    // Ensure exerciseId is valid
    if(lib.length === 0){
      exerciseId = null;
    }else{
      if(!exerciseId || !lib.some(x => x.id === exerciseId)) exerciseId = lib[0].id;
    }

    // Search results
    resultsHost.innerHTML = "";
    selectedRow.innerHTML = "";

    const selectedName = exerciseId ? resolveExerciseName(type, exerciseId, "Exercise") : null;

    if(selectedName){
      selectedRow.appendChild(el("div", { class:"pill" }, [
        el("div", { class:"t", text:selectedName }),
        el("button", {
          class:"x",
          onClick: () => {
            exerciseId = null;
            repaint(true);
          }
        }, ["×"])
      ]));
    } else {
      selectedRow.appendChild(el("div", { class:"note", text:"No exercise selected." }));
    }

    const q = normName(query);
    if(query && lib.length){
      const hits = lib.filter(x => normName(x.name).includes(q)).slice(0, 10);
      if(hits.length){
        const list = el("div", { class:"list", style:"margin-top:8px;" }, hits.map(x => {
          return el("div", {
            class:"item",
            onClick: () => {
              exerciseId = x.id;
              query = "";
              searchWrap.querySelector("input").value = "";
              repaint(true);
            }
          }, [
            el("div", { class:"left" }, [
              el("div", { class:"name", text:x.name }),
              el("div", { class:"meta", text: typeLabel(type) })
            ])
          ]);
        }));
        resultsHost.appendChild(list);
      } else {
        resultsHost.appendChild(el("div", { class:"note", text:"No matches. Try a different keyword." }));
      }
    }

    // Stats + chart + table only if exercise selected
    statsHost.innerHTML = "";
    tableHost.innerHTML = "";
    chartNote.textContent = "";

    if(!exerciseId){
      destroyProgressChart();
      chartNote.textContent = "Select an exercise to see your trend.";
      tableHost.appendChild(el("div", { class:"note", text:"Select an exercise to see history." }));
      return;
    }

    // Filter entries for selected exercise
const all = (state.logs?.workouts || []).filter(e =>
  e.type === type &&
  e.exerciseId === exerciseId &&
  (e.dateISO >= fromISO && e.dateISO <= toISO)
);


    // Overview KPIs
    const desc = all.slice().sort((a,b) => (b.dateISO||"").localeCompare(a.dateISO||"") || (b.createdAt||0)-(a.createdAt||0));
    const latest = desc[0] || null;

    const bests = LogEngine.lifetimeBests(type, exerciseId);
    const bestText = bestsText(type, bests);

    // Overview (single pill): { PR: xxx | Last: xxx }
const prVal = formatMetricValue(type, metric, prForMetric(type, metric, bests));
const lastVal = latest ? formatMetricValue(type, metric, metricValue(type, metric, latest)) : "—";

statsHost.appendChild(el("div", { class:"pill" }, [
  el("div", { class:"t", text:`{ PR: ${prVal} | Last: ${lastVal} }` })
]));

    // Chart (ascending for series builder)
    const asc = all.slice().sort((a,b) => (a.dateISO||"").localeCompare(b.dateISO||"") || (a.createdAt||0)-(b.createdAt||0));
    if(asc.length < 2){
      destroyProgressChart();
      chartNote.textContent = `Not enough data in this range (${fromISO} to ${toISO}). Log at least 2 sessions.`;
    }else{
      const series = buildSeries(type, asc);
      renderProgressChart(canvas, type, metric, series);
      chartNote.textContent = `${asc.length} points • ${fromISO} → ${toISO}`;
    }

    // History table
    if(desc.length === 0){
      tableHost.appendChild(el("div", { class:"note", text:"No logs in this range." }));
    }else{
      desc.slice(0, 40).forEach(entry => {
        tableHost.appendChild(el("div", { class:"item" }, [
          el("div", { class:"left" }, [
            el("div", { class:"name", text: entry.dateISO }),
            el("div", { class:"meta", text: tableLine(entry) })
          ]),
          el("div", { class:"actions" }, [
            el("button", { class:"mini danger", onClick: () => confirmDeleteLog(entry) }, ["Delete"])
          ])
        ]));
      });
    }
  }

  function typeLabel(t){
    if(t === "weightlifting") return "Weightlifting";
    if(t === "cardio") return "Cardio";
    return "Core";
  }

  function bestsText(t, bests){
    if(!bests) return "";
    if(t === "weightlifting"){
      const bw = bests.bestWeight != null ? `${Math.round(bests.bestWeight*10)/10} top` : "";
      const brm = bests.best1RM != null ? `${Math.round(bests.best1RM*10)/10} est 1RM` : "";
      const bv = bests.bestVolume != null ? `${Math.round(bests.bestVolume)} vol` : "";
      return [bw, brm, bv].filter(Boolean)[0] || "";
    }
    if(t === "cardio"){
      const bp = bests.bestPace != null ? `${formatTime(Math.round(bests.bestPace))} pace` : "";
      return bp || "";
    }
    const bv = bests.bestVolume != null ? `${Math.round(bests.bestVolume)} vol` : "";
    return bv || "";
  }

  // ✅ helpers must stay INSIDE Progress() (not inside Views object root)
  function metricValue(type, metric, entry){
    try{
      if(!entry) return null;

      if(type === "weightlifting"){
        if(metric === "topWeight") return entry.summary?.bestWeight ?? entry.summary?.topWeight ?? null;
        if(metric === "est1RM")    return entry.summary?.est1RM ?? null;
        if(metric === "volume")    return entry.summary?.totalVolume ?? null;
        return entry.summary?.bestWeight ?? null;
      }

      if(type === "cardio"){
        if(metric === "pace")     return entry.summary?.paceSecPerUnit ?? null;
        if(metric === "distance") return entry.summary?.distance ?? null;
        if(metric === "timeSec")  return entry.summary?.timeSec ?? null;
        return entry.summary?.paceSecPerUnit ?? null;
      }

      // core
      if(metric === "volume") return entry.summary?.totalVolume ?? null;
      return entry.summary?.totalVolume ?? null;
    }catch(e){
      return null;
    }
  }

  function prForMetric(type, metric, bests){
    try{
      if(!bests) return null;

      if(type === "weightlifting"){
        if(metric === "topWeight") return bests.bestWeight ?? null;
        if(metric === "est1RM")    return bests.best1RM ?? null;
        if(metric === "volume")    return bests.bestVolume ?? null;
        return bests.bestWeight ?? null;
      }

      if(type === "cardio"){
        if(metric === "pace")     return bests.bestPace ?? null;
        if(metric === "distance") return bests.bestDistance ?? null;
        if(metric === "timeSec")  return bests.bestTime ?? null;
        return bests.bestPace ?? null;
      }

      // core
      if(metric === "volume") return bests.bestVolume ?? null;
      return bests.bestVolume ?? null;
    }catch(e){
      return null;
    }
  }

  function formatMetricValue(type, metric, v){
    if(v == null) return "—";

    // cardio formatting
    if(type === "cardio" && metric === "pace") return formatPace(v);
    if(type === "cardio" && metric === "timeSec") return formatTime(v);

    // numeric formatting
    if(typeof v === "number"){
      const n = Math.round(v * 10) / 10;
      return String(n);
    }
    return String(v);
  }

  // ✅ FIX: was referenced but missing — caused Progress to crash
  function tableLine(entry){
    try{
      if(!entry) return "—";
      const t = entry.type || type;           // fall back to current Progress tab type
      const s = entry.summary || {};

      if(t === "weightlifting"){
        const bw  = (s.bestWeight != null) ? `${formatMetricValue("weightlifting","topWeight", s.bestWeight)} top` : "";
        const brm = (s.best1RM != null)    ? `${formatMetricValue("weightlifting","est1RM",    s.best1RM)} est1RM` : "";
        const bv  = (s.totalVolume != null)? `${formatMetricValue("weightlifting","volume",   s.totalVolume)} vol` : "";
        return [bw, brm, bv].filter(Boolean).join(" • ") || "—";
      }

      if(t === "cardio"){
        const pace = (s.paceSecPerUnit != null) ? `${formatMetricValue("cardio","pace", s.paceSecPerUnit)} pace` : "";
        const dist = (s.distance != null)       ? `${formatMetricValue("cardio","distance", s.distance)} dist` : "";
        const time = (s.timeSec != null)        ? `${formatMetricValue("cardio","timeSec", s.timeSec)} time` : "";
        return [pace, dist, time].filter(Boolean).join(" • ") || "—";
      }

      // core
      const vol = (s.totalVolume != null) ? `${formatMetricValue("core","volume", s.totalVolume)} vol` : "";
      return vol || "—";
    }catch(_){
      return "—";
    }
  }

},  // ✅ end Progress()
  Weight(){
  WeightEngine.ensure();

  const root = el("div", { class:"grid weightPage" });

  const todayISO = Dates.todayISO();

  // Local UI state
  let rangeDays = 30;      // 7, 30, 90, 365
  let historyOpen = false;

  // ---- UI: Summary (Top) ----
  const summaryCard = el("div", { class:"card" }, [
    el("div", { class:"weightTop" }, [
      el("div", {}, [
        el("h2", { text:"Weight" }),
        el("div", { class:"note", text:"Quick view + trend. Tap History to see past entries." })
      ]),
      el("button", {
        class:"btn primary weightLogBtn",
        onClick: () => openLogModal()
      }, ["+ Log"])
    ])
  ]);

  const summaryKpi = el("div", { class:"kpi weightSummaryKpi" });
  summaryCard.appendChild(summaryKpi);

  // ---- UI: Graph (Middle) ----
  const chartCard = el("div", { class:"card" }, [
    el("div", { class:"weightChartHead" }, [
      el("h2", { text:"Trend" }),
      el("div", { class:"segRow" }, [
        segBtn("7D", 7),
        segBtn("30D", 30),
        segBtn("90D", 90),
        segBtn("1Y", 365)
      ])
    ])
  ]);

  const chartWrap = el("div", { class:"chartWrap weightChartWrap" });
  const canvas = el("canvas", {});
  chartWrap.appendChild(canvas);
  const chartNote = el("div", { class:"note" });

  chartCard.appendChild(chartWrap);
  chartCard.appendChild(el("div", { style:"height:10px" }));
  chartCard.appendChild(chartNote);

  // ---- UI: History (Bottom - collapsible) ----
  const historyCard = el("div", { class:"card" }, [
    el("div", {
      class:"accHeader",
      onClick: () => {
        historyOpen = !historyOpen;
        repaintHistory();
      }
    }, [
      el("h2", { text:"History" }),
      el("div", { class:"accChevron", text:"▾" })
    ])
  ]);

  const historyBody = el("div", { class:"accBody" });
  const tableHost = el("div", { class:"list" });
  historyBody.appendChild(tableHost);
  historyCard.appendChild(historyBody);

  root.appendChild(summaryCard);
  root.appendChild(chartCard);
  root.appendChild(historyCard);

  repaintAll();
  return root;

  // -----------------------------
  // Helpers
  // -----------------------------
  function segBtn(label, days){
    const b = el("button", {
      class:"seg" + (days === rangeDays ? " active" : ""),
      onClick: () => {
        rangeDays = days;
        repaintChart();
        // update active styles
        const all = chartCard.querySelectorAll(".seg");
        all.forEach(x => x.classList.remove("active"));
        b.classList.add("active");
      }
    }, [label]);
    return b;
  }

  function openLogModal(){
    const dateInput = el("input", { type:"date", value: todayISO });
    const weightInput = el("input", { type:"number", inputmode:"decimal", placeholder:"e.g., 185.4", min:"0", step:"0.1" });
    const err = el("div", { class:"note", style:"display:none; color: rgba(255,92,122,.95);" });

    Modal.open({
      title: "Log weight",
      center: true,
      size: "sm",
      bodyNode: el("div", {}, [
        el("label", {}, [ el("span", { text:"Date" }), dateInput ]),
        el("label", {}, [ el("span", { text:"Weight (lb)" }), weightInput ]),
        err,
        el("div", { style:"height:12px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn primary",
            onClick: () => {
              try{
                err.style.display = "none";
                WeightEngine.add(dateInput.value || todayISO, weightInput.value);
                Modal.close();
                repaintAll();
              }catch(e){
                err.textContent = e.message || "Unable to save weight.";
                err.style.display = "block";
              }
            }
          }, ["Save"]),
          el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
        ])
      ])
    });
  }

  function repaintAll(){
    repaintSummary();
    repaintChart();
    repaintHistory(); // keeps collapsed by default
  }

  function repaintSummary(){
    const latest = WeightEngine.latest();
    const avg7 = WeightEngine.avg7(latest?.dateISO || todayISO);

    summaryKpi.innerHTML = "";

    const main = latest ? `${latest.weight}` : "—";
    const sub = latest
      ? ((latest.dateISO === todayISO) ? "Today" : `Latest • ${latest.dateISO}`)
      : "No weight entries yet.";

    // Change vs 7D avg (matches your mock)
    let change7 = null;
    if(latest && avg7 != null) change7 = round2((Number(latest.weight)||0) - (Number(avg7)||0));
    const change7Text = (change7 == null) ? "—" : (change7 > 0 ? `+${change7}` : `${change7}`);

    summaryKpi.appendChild(el("div", { class:"big", text: `${main} lb` }));
    summaryKpi.appendChild(el("div", { class:"small", text: sub }));
    summaryKpi.appendChild(el("div", { class:"small", text: `Change: ${change7Text} lb (7d)` }));
  }

  function repaintChart(){
    const ascAll = WeightEngine.listAsc();
    const asc = ascAll.slice(-rangeDays);

    if(asc.length < 2){
      destroyWeightChart();
      chartNote.textContent = "Add at least 2 entries to see the trend line.";
      return;
    }

    renderWeightChart(canvas, asc);
    chartNote.textContent = `Showing last ${asc.length} entries`;
  }

  function repaintHistory(){
    // collapsed by default
    historyCard.classList.toggle("open", !!historyOpen);
    historyBody.style.display = historyOpen ? "block" : "none";

    const chevron = historyCard.querySelector(".accChevron");
    if(chevron) chevron.textContent = historyOpen ? "▴" : "▾";

    if(!historyOpen) return;

    const desc = WeightEngine.listDesc();
    tableHost.innerHTML = "";

    if(desc.length === 0){
      tableHost.appendChild(el("div", { class:"note", text:"No entries yet. Tap + Log to add your first one." }));
      return;
    }

    desc.slice(0, 60).forEach(row => {
      tableHost.appendChild(el("div", { class:"item" }, [
        el("div", { class:"left" }, [
          el("div", { class:"name", text: row.dateISO }),
          el("div", { class:"meta", text: `${row.weight} lb` })
        ]),
        el("div", { class:"actions" }, [
          el("button", {
            class:"mini danger",
            onClick: () => {
              Modal.open({
                title: "Delete entry?",
                center: true,
                size: "sm",
                bodyNode: el("div", {}, [
                  el("div", { class:"note", text:`Delete ${row.weight} lb on ${row.dateISO}?` }),
                  el("div", { style:"height:12px" }),
                  el("div", { class:"btnrow" }, [
                    el("button", {
                      class:"btn danger",
                      onClick: () => {
                        WeightEngine.remove(row.id);
                        Modal.close();
                        repaintAll();
                      }
                    }, ["Delete"]),
                    el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
                  ])
                ])
              });
            }
          }, ["Delete"])
        ])
      ]));
    });
  }
},
  Attendance(){

        AttendanceEngine.ensure();

        // ✅ keep calendar month stable across re-renders (UI-only; not saved)
        const ui = UIState.attendance || (UIState.attendance = {});

        // default month = current (only if we haven't navigated months yet)
        const today = Dates.todayISO();
        let { y, m } = (ui.y && ui.m) ? { y: ui.y, m: ui.m } : ymFromISO(today);
        if(!ui.y || !ui.m){ ui.y = y; ui.m = m; }

        const weekStartsOn = state.profile?.weekStartsOn || "mon"; // affects calendar header order
        const weekStart = (weekStartsOn === "sun") ? 0 : 1;

        const root = el("div", { class:"grid" });

        const header = el("div", { class:"card" }, [
          el("h2", { text:"Attendance" }),
          el("div", { class:"note", text:"Tap a day to mark it trained. Shows monthly count + clear month." })
        ]);

        const card = el("div", { class:"card" }, [
          el("h2", { text:"Calendar" })
        ]);

        const wrap = el("div", { class:"calWrap" });
        const top = el("div", { class:"calTop" });

        const title = el("div", { class:"calTitle" });
        const monthKpi = el("div", { class:"note" });

        const prevBtn = el("button", { class:"btn", onClick: () => { stepMonth(-1); } }, ["Prev"]);
        const nextBtn = el("button", { class:"btn", onClick: () => { stepMonth(1); } }, ["Next"]);

        const clearBtn = el("button", {
          class:"btn danger",
          onClick: () => {
            Modal.open({
              title: "Clear this month?",
              bodyNode: el("div", {}, [
                el("div", { class:"note", text:`This removes all trained days for ${monthTitle(y,m)}.` }),
                el("div", { style:"height:12px" }),
                el("div", { class:"btnrow" }, [
                  el("button", {
                    class:"btn danger",
                    onClick: () => {
                      AttendanceEngine.clearMonth(y, m);
                      Modal.close();
                      repaint();

                      // ✅ preserve month when Attendance re-renders
                      ui.y = y; ui.m = m;

                      renderView(); // Home dots update too
                    }
                  }, ["Clear month"]),
                  el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
                ])
              ])
            });
          }
        }, ["Clear month"]);

        top.appendChild(el("div", { class:"btnrow" }, [prevBtn, nextBtn]));
        top.appendChild(el("div", { style:"flex:1" }));
        top.appendChild(clearBtn);

        const grid = el("div", { class:"calGrid" });

        wrap.appendChild(top);
        wrap.appendChild(el("div", { style:"height:10px" }));
        wrap.appendChild(title);
        wrap.appendChild(el("div", { style:"height:6px" }));
        wrap.appendChild(monthKpi);
        wrap.appendChild(el("div", { style:"height:12px" }));
        wrap.appendChild(grid);

        card.appendChild(wrap);
        root.appendChild(header);
        root.appendChild(card);

        repaint();
        return root;

        function stepMonth(delta){
          m += delta;
          if(m <= 0){ m = 12; y -= 1; }
          if(m >= 13){ m = 1; y += 1; }

          // ✅ persist selected month
          ui.y = y; ui.m = m;

          repaint();
        }

        function weekdayLabels(){
          const sun = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
          if(weekStart === 0) return sun;
          return ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
        }

        function repaint(){
          AttendanceEngine.ensure();

          // ✅ persist selected month (defensive)
          ui.y = y; ui.m = m;

          title.textContent = monthTitle(y, m);

          const count = AttendanceEngine.monthCount(y, m);
          monthKpi.textContent = `This month: ${count} sessions`;

          grid.innerHTML = "";

          // headers
          weekdayLabels().forEach(lbl => {
            grid.appendChild(el("div", { class:"calCell header", text: lbl }));
          });

          const dim = daysInMonth(y, m);
          const firstDow = firstDayDow(y, m); // 0=Sun..6=Sat

          // convert firstDow to our grid index based on weekStart
          let leading = firstDow - weekStart;
          if(leading < 0) leading += 7;

          for(let i=0;i<leading;i++){
            grid.appendChild(el("div", { class:"calCell blank", text:"" }));
          }

          for(let d=1; d<=dim; d++){
            const dateISO = isoForYMD(y, m, d);
            const on = isTrained(dateISO);

            const cell = el("div", {
              class: "calCell" + (on ? " on" : ""),
              text: String(d),
              onClick: () => {
                toggleTrained(dateISO);
                repaint();

                // ✅ preserve month when Attendance re-renders
                ui.y = y; ui.m = m;

                renderView(); // updates Home dots too
              }
            });

            grid.appendChild(cell);
          }

          // pad to full weeks for cleaner bottom edge (optional)
          const totalCells = 7 + leading + dim; // +7 for header row
          const remainder = totalCells % 7;
          if(remainder !== 0){
            const pads = 7 - remainder;
            for(let i=0;i<pads;i++){
              grid.appendChild(el("div", { class:"calCell blank", text:"" }));
            }
          }
        }
      },


   Friends(){
  // Events-only friends feed (while app is open)
  const ui = UIState.social || (UIState.social = {});
  ui.friendId = ui.friendId || "";
  ui.email = ui.email || "";
  ui.view = ui.view || "feed"; // "feed" | "profile" (UI-only)
  ui.profileCountsById = ui.profileCountsById || {};
  ui.profileSharedById = ui.profileSharedById || {};
  ui.profileRoutineById = ui.profileRoutineById || {};
  ui.profileLoadById = ui.profileLoadById || {};

  const root = el("div", { class:"grid" });

  const user = Social.getUser && Social.getUser();
  const configured = Social.isConfigured && Social.isConfigured();

  // ✅ Live Online/Offline pill updates (only re-render on Friends route)
if(!ui.__netSub){
  ui.__netSub = true;

  ui.__netHandler = () => {
    const r = (String(location.hash || "").replace(/^#/, "") || "home");
    if(r === "friends"){
      try{ renderView(); }catch(_){}
    }
  };

  try{
    window.addEventListener("online", ui.__netHandler);
    window.addEventListener("offline", ui.__netHandler);
  }catch(_){}
}
  
// Header / status + Following/Followers (Instagram-style)
const followsNow = Social.getFollows ? Social.getFollows() : [];
const followersNow = Social.getFollowers ? Social.getFollowers() : [];

// Followers notifications pill (replaces Followers card)
// - Detects NEW follower IDs by diffing previous followers snapshot vs current
// - Works for: first-time follows AND unfollow→refollow (your test case)
// - UI-only (no storage/state schema changes)
(function trackNewFollowers(){
  if(!user) return;

  ui._followerNotifs = ui._followerNotifs || [];

  // Build current follower set
  const curSet = {};
  (followersNow || []).forEach(id => {
    const fid = String(id || "");
    if(fid) curSet[fid] = true;
  });

  // First time in this session: baseline only (no notifications)
  if(!ui._prevFollowersSet){
    ui._prevFollowersSet = curSet;
    return;
  }

  // Diff: additions = current - previous
  const prevSet = ui._prevFollowersSet || {};
  const newIds = [];
  Object.keys(curSet).forEach(fid => {
    if(!prevSet[fid]){
      ui._followerNotifs.unshift({ id: fid, at: Date.now() });
      newIds.push(fid);
    }
  });

  // Update snapshot every render so unfollow→refollow can trigger later
  ui._prevFollowersSet = curSet;

  // cap
  ui._followerNotifs = (ui._followerNotifs || []).slice(0, 25);

  // Best-effort fetch display names, then re-render Friends so the pill shows names
  if(newIds.length){
    try{
      setTimeout(() => {
        try{
          if(Social.fetchNames){
            Social.fetchNames(newIds)
              .then(() => { try{ renderView(); }catch(_){} })
              .catch(() => {});
          }
        }catch(_){}
      }, 0);
    }catch(_){}
  }
})();

function openFollowerNotifsModal(){
  if(!user){
    showToast("Sign in to view notifications");
    return;
  }

  // Back-compat: bell button currently calls openNotificationsModal()
  function openNotificationsModal(){
  return openFollowerNotifsModal();
}

  // Instagram-style shell
  const topRow = el("div", { class:"igNotifTop" }, []);
  const title = el("div", { class:"igNotifTitle", text:"Notifications" });

  const clearBtn = el("button", {
    class:"igNotifLinkBtn",
    onClick: () => {
      try{ Social.__clearNotifications && Social.__clearNotifications(); }catch(_){}
      showToast("Cleared");
      repaint();
    }
  }, ["Clear all"]);

  topRow.appendChild(title);
  topRow.appendChild(clearBtn);

  const listHost = el("div", { class:"igNotifList" });

  const body = el("div", { class:"igNotif" }, [
    topRow,
    listHost
  ]);

  function relTimeISO(iso){
    try{
      if(!iso) return "";
      const t = new Date(iso).getTime();
      if(!t || Number.isNaN(t)) return "";
      const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
      if(s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if(m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      if(h < 24) return `${h}h`;
      const d = Math.floor(h / 24);
      return `${d}d`;
    }catch(_){ return ""; }
  }

  function avatarLetter(name){
    const s = String(name || "").trim();
    return (s && s[0]) ? s[0].toUpperCase() : "•";
  }

  function bucketLabel(createdAt){
    try{
      const t = createdAt ? new Date(createdAt).getTime() : 0;
      if(!t || Number.isNaN(t)) return "Earlier";
      const now = new Date();
      const dt = new Date(t);
      const sameDay = now.toDateString() === dt.toDateString();
      if(sameDay) return "Today";
      const diffDays = Math.floor((now.getTime() - t) / (1000*60*60*24));
      if(diffDays <= 7) return "This week";
      return "Earlier";
    }catch(_){ return "Earlier"; }
  }

  function openFromNotif(n){
    const type = String(n?.type || "");
    const eventId = n?.eventId;

    // Likes/comments → open the related workout/event modal (best-effort)
    if((type === "like" || type === "comment") && (eventId !== null && eventId !== undefined)){
      try{
        const feed = Social.getFeed ? Social.getFeed() : [];
        const ev = (feed || []).find(x => String(x?.id || "") === String(eventId));
        if(ev){
          const who = (Social.nameFor && Social.nameFor(ev.actorId)) || "User";
          const when = ev.createdAt ? new Date(ev.createdAt).toLocaleString() : "";
          const title = (ev.payload?.details?.dayLabel) || (ev.type === "workout_completed" ? "Workout" : "Event");
          openFeedEventModal(ev, title, who, when);
          return;
        }
      }catch(_){}
      showToast("Workout not found (refresh feed)");
      return;
    }

    // Follow → open Connections modal on Followers tab
    if(type === "follow"){
      try{ openConnectionsModal("followers"); }catch(_){}
      return;
    }
  }

  function rowForNotif(n, follows){
    const type = String(n?.type || "");
    const actorId = String(n?.actorId || "");
    const dn = (Social.nameFor && Social.nameFor(actorId)) || "User";
    const alreadyFollowing = actorId ? follows.includes(actorId) : false;

    const timeTxt = relTimeISO(n?.createdAt);
    const avatar = el("div", { class:"igNotifAvatar", text: avatarLetter(dn) });

    const verb = (type === "like") ? " liked your workout"
      : (type === "comment") ? " commented on your workout"
      : " followed you";

    const textBlock = el("div", { class:"igNotifText" }, [
      el("div", { class:"igNotifLine" }, [
        el("span", { class:"igNotifName", text: dn }),
        el("span", { class:"igNotifMsg", text: verb }),
        timeTxt ? el("span", { class:"igNotifTime", text:` • ${timeTxt}` }) : null
      ].filter(Boolean)),
      (type === "comment" && n?.body)
        ? el("div", { class:"igNotifSub", text: String(n.body).slice(0, 90) })
        : null
    ].filter(Boolean));

    const actions = el("div", { class:"igNotifActions" }, [
      type === "follow"
        ? (alreadyFollowing
            ? el("button", {
                class:"btn danger sm",
                onClick: async (e) => {
                  e?.stopPropagation?.();
                  try{
                    await Social.unfollow(actorId);
                    showToast("Unfollowed");
                    renderView();
                    repaint();
                  }catch(err){
                    showToast(err?.message || "Couldn't unfollow");
                  }
                }
              }, ["Unfollow"])
            : el("button", {
                class:"btn primary sm",
                onClick: async (e) => {
                  e?.stopPropagation?.();
                  try{
                    await Social.follow(actorId);
                    showToast("Following");
                    renderView();
                    repaint();
                  }catch(err){
                    showToast(err?.message || "Follow failed");
                  }
                }
              }, ["Follow back"]))
        : el("button", { class:"btn sm", disabled:true, style:"opacity:.65; cursor:default;" }, ["View"]),

      // Dismiss (UI-only)
      el("button", {
        class:"igNotifX",
        title:"Dismiss",
        onClick: (e) => {
          e?.stopPropagation?.();
          try{
            const all = Social.getNotifications ? Social.getNotifications() : [];
            const next = (all || []).filter(x => x !== n);
            if(Social.__setNotifications) Social.__setNotifications(next);
          }catch(_){}
          showToast("Dismissed");
          repaint();
        }
      }, ["✕"])
    ]);

    return el("div", {
      class:"igNotifRow",
      onClick: () => openFromNotif(n)
    }, [
      avatar,
      textBlock,
      actions
    ]);
  }

  function repaint(){
    const follows = Social.getFollows ? Social.getFollows() : [];
    const notifs = Social.getNotifications ? Social.getNotifications() : [];

    listHost.innerHTML = "";

    if(!notifs.length){
      listHost.appendChild(el("div", { class:"note", text:"No new notifications." }));
      return;
    }

    // Group by time bucket (Today / This week / Earlier)
    const buckets = {};
    (notifs || []).forEach(n => {
      const k = bucketLabel(n?.createdAt);
      (buckets[k] = buckets[k] || []).push(n);
    });

    ["Today","This week","Earlier"].forEach(k => {
      const items = buckets[k] || [];
      if(!items.length) return;

      listHost.appendChild(el("div", { class:"igNotifSection", text:k }));

      // Within a bucket, group by type (Instagram-ish)
      const order = ["follow","like","comment"];
      order.forEach(t => {
        const rows = items.filter(n => String(n?.type||"") === t);
        if(!rows.length) return;

        const head = (t === "follow") ? "New followers"
          : (t === "like") ? "Likes"
          : "Comments";

        listHost.appendChild(el("div", { class:"igNotifGroup", text: head }));

        rows.forEach(n => {
          listHost.appendChild(rowForNotif(n, follows));
        });
      });
    });
  }

  Modal.open({
    title: "Notifications",
    bodyNode: body
  });

  repaint();
}

function openAddFriendModal(){
  let searchSeq = 0;
  let searchDebounce = null;

  const friendCodeInput = el("input", {
    class:"connCodeInput",
    type:"text",
    placeholder:"@username",
    value: ui.connAddCode || "",
    autocapitalize:"off",
    autocorrect:"off",
    spellcheck:"false"
  });

  const searchStatus = el("div", {
    class:"note",
    style:"display:none; margin-top:8px;"
  }, ["Searching…"]);

  const suggestionsHost = el("div", {
    style:"display:none; margin-top:10px;"
  });

  function avatarLetter(name){
    const s = String(name || "").trim();
    return (s && s[0]) ? s[0].toUpperCase() : "•";
  }

  function clearSuggestions(){
    suggestionsHost.innerHTML = "";
    suggestionsHost.style.display = "none";
  }

  async function doAdd(explicitUsername){
    if(!user){
      showToast("Sign in to add friends");
      return;
    }

    const raw = String(explicitUsername || ui.connAddCode || "").trim();
    const uname = normalizeUsername(raw);

    if(!uname){
      showToast("Enter a username");
      return;
    }

    try{
      await Social.follow(uname);
      showToast("Friend added");
      ui.connAddCode = "";
      clearSuggestions();
      Modal.close();
      renderView();
    }catch(e){
      showToast(e?.message || "Couldn't add friend");
    }
  }

  function buildSuggestionRow(row){
    const id = String(row?.id || "");
    const dn = String(row?.displayName || "User").trim() || "User";
    const un = normalizeUsername(row?.username || "");
    const handle = usernameToHandle(un);

    return el("button", {
      type:"button",
      class:"connRow",
      style:[
        "width:100%",
        "margin:0",
        "background:transparent",
        "border:0",
        "padding:10px 0",
        "text-align:left",
        "cursor:pointer",
        "display:flex",
        "align-items:center",
        "gap:10px"
      ].join(";"),
      onClick: async () => {
        ui.connAddCode = un;
        friendCodeInput.value = handle || un;
        await doAdd(un);
      }
    }, [
      el("div", { class:"connAvatar", text: avatarLetter(dn) }),
      el("div", { style:"min-width:0; flex:1;" }, [
       el("div", {
          style:"font-weight:800; line-height:1.15; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#fff;"
        }, [dn]),
        el("div", {
          class:"note",
          style:"margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#fff;"
        }, [handle || "@unknown"])
      ])
    ]);
  }

  async function repaintSuggestions(){
    const seq = ++searchSeq;
    const q = normalizeUsername(friendCodeInput.value || "");

    ui.connAddCode = friendCodeInput.value || "";

    if(!user){
      clearSuggestions();
      return;
    }

    if(!q){
      clearSuggestions();
      return;
    }

    if(!Social.searchProfilesByUsername){
      clearSuggestions();
      return;
    }

    searchStatus.style.display = "block";

    let results = [];
    try{
      results = await Social.searchProfilesByUsername(q, { limit: 6 });
    }catch(_){
      results = [];
    }finally{
      if(seq === searchSeq){
        searchStatus.style.display = "none";
      }
    }

    if(seq !== searchSeq) return;

    const myId = String(user?.id || "");
    const followsSet = new Set(
      (Social.getFollows ? Social.getFollows() : [])
        .map(x => String(x || ""))
        .filter(Boolean)
    );

    const filtered = (results || [])
      .filter(row => String(row?.id || ""))
      .filter(row => String(row.id) !== myId)
      .filter(row => !followsSet.has(String(row.id)));

    suggestionsHost.innerHTML = "";

    if(!filtered.length){
      suggestionsHost.style.display = "none";
      return;
    }

    suggestionsHost.style.display = "block";
    suggestionsHost.appendChild(el("div", {
      style:"font-size:12px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; opacity:.72; margin:0 0 8px;"
    }, ["Suggested users"]));

    filtered.forEach((row, idx) => {
      suggestionsHost.appendChild(buildSuggestionRow(row));
      if(idx !== filtered.length - 1){
        suggestionsHost.appendChild(el("div", { class:"hr" }));
      }
    });
  }

  friendCodeInput.addEventListener("input", () => {
    ui.connAddCode = friendCodeInput.value || "";

    try{
      if(searchDebounce) clearTimeout(searchDebounce);
    }catch(_){}

    searchDebounce = setTimeout(() => {
      repaintSuggestions();
    }, 150);
  });

  friendCodeInput.addEventListener("keydown", async (e) => {
    if(e.key === "Enter"){
      try{ e.preventDefault(); }catch(_){}
      await doAdd();
    }
  });

  Modal.open({
    title: "Add Friend",
    bodyNode: el("div", { class:"connAddFriendModal" }, [
      el("div", { class:"setRow" }, [
        el("div", {}, [
          el("div", { style:"font-weight:820;", text:"Friend username" }),
          el("div", { class:"meta", text:"Type @username to search and add" })
        ]),

        el("div", { class:"connCodeRight" }, [
          friendCodeInput,
          el("button", {
            class:"btn primary sm",
            onClick: () => doAdd()
          }, ["Add"])
        ])
      ]),
      searchStatus,
      suggestionsHost
    ])
  });

  setTimeout(() => {
    try{
      friendCodeInput.focus();
      friendCodeInput.setSelectionRange(friendCodeInput.value.length, friendCodeInput.value.length);
    }catch(_){}
  }, 0);

  repaintSuggestions();
}

const addFriendBtn = el("button", {
  class:"btn primary",
  onClick: () => openAddFriendModal()
}, ["Add Friend"]);
     
  function openConnectionsModal(initialTab){
  ui.connTab = initialTab || ui.connTab || "following";
  ui.connSearch = ui.connSearch || "";
  ui.connAddCode = ui.connAddCode || "";

  const statsRow = el("div", { class:"connStats" });

  const searchInput = el("input", {
    type:"text",
    placeholder:"Search connections…",
    value: ui.connSearch
  });

  const searchWrap = el("div", { class:"connSearch" }, [
    el("div", { class:"ico", text:"🔎" }),
    searchInput
  ]);

  const searchStatus = el("div", {
    class:"note",
    style:"display:none; margin-top:6px;"
  }, ["Searching…"]);

    const bodyHost = el("div", { class:"connScroll" });
  let repaintSeq = 0;
  let searchDebounce = null;

  searchInput.addEventListener("input", () => {
    ui.connSearch = searchInput.value || "";

    try{
      if(searchDebounce) clearTimeout(searchDebounce);
    }catch(_){}

    searchDebounce = setTimeout(() => {
      repaintModal();
    }, 150);
  });

  async function refreshLists(){
    try{
      if(Social.fetchFollows) await Social.fetchFollows();
      if(Social.fetchFollowers) await Social.fetchFollowers();
    }catch(_){}
  }

  function avatarLetter(name){
    const s = String(name || "").trim();
    return (s && s[0]) ? s[0].toUpperCase() : "•";
  }

  function openFriendProfile(friendId){
    const id = String(friendId || "").trim();
    if(!id) return;

    ui.friendId = id;
    ui.view = "profile";

    try{ Modal.close(); }catch(_){}
    renderView();
  }

  function statPill({ tab, label, value }){
    return el("button", {
      type:"button",
      class:"connPill" + (ui.connTab === tab ? " on" : ""),
      onClick: () => {
        ui.connTab = tab;
        repaintModal();
      }
    }, [
      el("span", { text: label }),
      el("span", { class:"v", text: String(value) })
    ]);
  }

  function badge(label, kind){
    return el("span", { class:"connBadge" + (kind ? (" " + kind) : ""), text: label });
  }

  function matchesConnectionSearch(id, q){
    if(!q) return true;
    const dn = ((Social.nameFor && Social.nameFor(id)) || "User").toLowerCase();
    const un = ((Social.usernameFor && Social.usernameFor(id)) || "").toLowerCase();
    const handle = un ? `@${un}` : "";
    return dn.includes(q) || un.includes(q) || handle.includes(q);
  }

  function connectionSortValue(id, q){
    const dn = ((Social.nameFor && Social.nameFor(id)) || "User").toLowerCase();
    const un = ((Social.usernameFor && Social.usernameFor(id)) || "").toLowerCase();
    const handle = un ? `@${un}` : "";

    const exactUser = !!q && (un === q || handle === q);
    const startsUser = !!q && !exactUser && (un.startsWith(q) || handle.startsWith(q));
    const startsName = !!q && dn.startsWith(q);

    return {
      dn,
      un,
      exactUser,
      startsUser,
      startsName
    };
  }

  function sortConnectionIds(ids, q){
    return (ids || []).slice().sort((a,b) => {
      const aa = connectionSortValue(a, q);
      const bb = connectionSortValue(b, q);
      if(aa.exactUser !== bb.exactUser) return aa.exactUser ? -1 : 1;
      if(aa.startsUser !== bb.startsUser) return aa.startsUser ? -1 : 1;
      if(aa.startsName !== bb.startsName) return aa.startsName ? -1 : 1;
      const userCmp = aa.un.localeCompare(bb.un);
      if(userCmp !== 0) return userCmp;
      return aa.dn.localeCompare(bb.dn);
    });
  }

  function sectionTitle(text){
    return el("div", {
      style:"font-size:12px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; opacity:.72; margin:2px 0 10px;"
    }, [text]);
  }

  function appendRows(ids, mode, followsSet, followersSet){
    (ids || []).forEach((id, idx) => {
      bodyHost.appendChild(connectionRow({ id, mode, followsSet, followersSet }));
      if(idx !== ids.length - 1){
        bodyHost.appendChild(el("div", { class:"hr" }));
      }
    });
  }

  function connectionRow({ id, mode, followsSet, followersSet }){
    const dn = (Social.nameFor && Social.nameFor(id)) || "User";
    const un = (Social.usernameFor && Social.usernameFor(id)) || "";
    const handle = usernameToHandle(un);
    const mutual = followsSet.has(id) && followersSet.has(id);

    let metaText = "";
    if(mutual) metaText = "You follow each other";
    else if(mode === "following") metaText = "You follow them";
    else metaText = "Follower";

    const badges = [];
    if(mutual) badges.push(badge("Mutual", "mutual"));
    else if(mode === "following") badges.push(badge("Following"));
    else badges.push(badge("Follows you"));

    const actions = [];

    if(mode === "following"){
      actions.push(el("button", {
        class:"btn danger sm",
        onClick: async (e) => {
          try{ e?.stopPropagation?.(); }catch(_){}
          try{
            await Social.unfollow(id);
            showToast("Unfollowed");
            await refreshLists();
            repaintModal();
            renderView();
          }catch(e2){
            showToast(e2?.message || "Couldn't unfollow");
          }
        }
      }, ["Unfollow"]));
    }else{
      if(followsSet.has(id)){
        actions.push(el("button", {
          class:"btn danger sm",
          onClick: async (e) => {
            try{ e?.stopPropagation?.(); }catch(_){}
            try{
              await Social.unfollow(id);
              showToast("Unfollowed");
              await refreshLists();
              repaintModal();
              renderView();
            }catch(e2){
              showToast(e2?.message || "Couldn't unfollow");
            }
          }
        }, ["Unfollow"]));
      }else{
        actions.push(el("button", {
          class:"btn primary sm",
          onClick: async (e) => {
            try{ e?.stopPropagation?.(); }catch(_){}
            try{
              await Social.follow(id);
              showToast("Following");
              await refreshLists();
              repaintModal();
              renderView();
            }catch(e2){
              showToast(e2?.message || "Follow failed");
            }
          }
        }, ["Follow back"]));
      }
    }

    return el("div", { class:"connRow" }, [
      el("div", {
        class:"av",
        style:"cursor:pointer;",
        onClick: () => openFriendProfile(id)
      }, [
        el("div", { class:"ltr", text: avatarLetter(dn) })
      ]),

      el("div", {
        style:"min-width:0; flex:1; cursor:pointer;",
        onClick: () => openFriendProfile(id)
      }, [
        el("div", { style:"font-weight:900; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;", text: dn }),
        handle ? el("div", {
          class:"note",
          style:"margin:2px 0 0 0; font-size:12px; opacity:.82; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
          text: handle
        }) : null,
        el("div", { class:"note", style:"margin:4px 0 0 0;" }, [metaText]),
        badges.length ? el("div", { style:"display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;" }, badges) : null
      ].filter(Boolean)),

      el("div", { style:"display:flex; gap:8px; align-items:center; flex:0 0 auto;" }, actions)
    ]);
  }

  function searchResultRow({ id, followsSet, followersSet }){
    const dn = (Social.nameFor && Social.nameFor(id)) || "User";
    const un = (Social.usernameFor && Social.usernameFor(id)) || "";
    const handle = usernameToHandle(un);
    const iFollow = followsSet.has(id);
    const followsMe = followersSet.has(id);
    const mutual = iFollow && followsMe;

    let metaText = "Suggested user";
    if(mutual) metaText = "You follow each other";
    else if(iFollow) metaText = "You follow them";
    else if(followsMe) metaText = "Follows you";

    const badges = [];
    if(mutual) badges.push(badge("Mutual", "mutual"));
    else if(iFollow) badges.push(badge("Following"));
    else if(followsMe) badges.push(badge("Follows you"));
    else badges.push(badge("Suggested"));

    const action = iFollow
      ? el("button", {
          class:"btn danger sm",
          onClick: async (e) => {
            try{ e?.stopPropagation?.(); }catch(_){}
            try{
              await Social.unfollow(id);
              showToast("Unfollowed");
              await refreshLists();
              repaintModal();
              renderView();
            }catch(e2){
              showToast(e2?.message || "Couldn't unfollow");
            }
          }
        }, ["Unfollow"])
      : el("button", {
          class:"btn primary sm",
          onClick: async (e) => {
            try{ e?.stopPropagation?.(); }catch(_){}
            try{
              await Social.follow(id);
              showToast(followsMe ? "Followed back" : "Following");
              await refreshLists();
              repaintModal();
              renderView();
            }catch(e2){
              showToast(e2?.message || "Follow failed");
            }
          }
        }, [followsMe ? "Follow back" : "Add"]);

    return el("div", { class:"connRow" }, [
      el("div", {
        class:"av",
        style:"cursor:pointer;",
        onClick: () => openFriendProfile(id)
      }, [
        el("div", { class:"ltr", text: avatarLetter(dn) })
      ]),

      el("div", {
        style:"min-width:0; flex:1; cursor:pointer;",
        onClick: () => openFriendProfile(id)
      }, [
        el("div", { style:"font-weight:900; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;", text: dn }),
        handle ? el("div", {
          class:"note",
          style:"margin:2px 0 0 0; font-size:12px; opacity:.82; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
          text: handle
        }) : null,
        el("div", { class:"note", style:"margin:4px 0 0 0;" }, [metaText]),
        badges.length ? el("div", { style:"display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;" }, badges) : null
      ].filter(Boolean)),

      el("div", { style:"display:flex; gap:8px; align-items:center; flex:0 0 auto;" }, [action])
    ]);
  }

  async function repaintModal(){
    const paintSeq = ++repaintSeq;
    const follows = Social.getFollows ? Social.getFollows() : [];
    const followers = Social.getFollowers ? Social.getFollowers() : [];

    const followsSet = new Set((follows || []).map(String));
    const followersSet = new Set((followers || []).map(String));
    const mutualIds = Array.from(followersSet).filter(id => followsSet.has(id));
    const mutualCount = mutualIds.length;

    statsRow.innerHTML = "";
    statsRow.appendChild(statPill({ tab:"following", label:"Following", value: follows.length }));
    statsRow.appendChild(statPill({ tab:"followers", label:"Followers", value: followers.length }));
    statsRow.appendChild(statPill({ tab:"mutual", label:"Mutual", value: mutualCount }));

    const q = normalizeUsername(ui.connSearch || "");
    const allConnectionIds = Array.from(
      new Set([].concat(follows || [], followers || []).map(x => String(x || "")).filter(Boolean))
    );
    const currentTabIds = ((ui.connTab === "following") ? follows
      : (ui.connTab === "followers") ? followers
      : mutualIds).map(x => String(x || "")).filter(Boolean);

    try{
      const idsToHydrate = q ? allConnectionIds : currentTabIds;
      if(idsToHydrate.length && Social.fetchNames) await Social.fetchNames(idsToHydrate);
    }catch(_){}

    if(paintSeq !== repaintSeq) return;

    bodyHost.innerHTML = "";
    searchStatus.style.display = "none";

    if(!user){
      bodyHost.appendChild(el("div", { class:"note", text:"Sign in to manage connections." }));
      return;
    }

    if(!q){
      if(!currentTabIds.length){
        bodyHost.appendChild(el("div", {
          class:"note",
          text:
            (ui.connTab === "following") ? "Not following anyone yet."
            : (ui.connTab === "followers") ? "No followers yet."
            : "No mutual connections yet."
        }));
        return;
      }

      const items = sortConnectionIds(currentTabIds, "");
      const mode = (ui.connTab === "following") ? "following" : "followers";
      appendRows(items, mode, followsSet, followersSet);
      return;
    }

    const localMatches = sortConnectionIds(
      allConnectionIds.filter(id => matchesConnectionSearch(id, q)),
      q
    );

    let remoteResults = [];
    searchStatus.style.display = "block";
    try{
      if(Social.searchProfilesByUsername) remoteResults = await Social.searchProfilesByUsername(q, { limit: 8 });
    }catch(_){}
    finally{
      if(paintSeq === repaintSeq){
        searchStatus.style.display = "none";
      }
    }

    if(paintSeq !== repaintSeq) return;

    const remoteIds = (remoteResults || [])
      .map(row => String(row?.id || ""))
      .filter(Boolean)
      .filter(id => String(id) !== String(user?.id || ""))
      .filter(id => !allConnectionIds.includes(id));

    let wroteSection = false;

    if(localMatches.length){
      wroteSection = true;
      bodyHost.appendChild(sectionTitle("Your connections"));
      appendRows(localMatches, "followers", followsSet, followersSet);
    }

    if(remoteIds.length){
      if(wroteSection) bodyHost.appendChild(el("div", { style:"height:12px" }));
      wroteSection = true;
      bodyHost.appendChild(sectionTitle("Suggested users"));
      remoteIds.forEach((id, idx) => {
        bodyHost.appendChild(searchResultRow({ id, followsSet, followersSet }));
        if(idx !== remoteIds.length - 1){
          bodyHost.appendChild(el("div", { class:"hr" }));
        }
      });
    }

    if(!wroteSection){
      bodyHost.appendChild(el("div", {
        class:"note",
        text:"No matches. Try a full @username."
      }));
    }
  }

  Modal.open({
    title: "Connections",
    bodyNode: el("div", { class:"connModal" }, [
      el("div", { class:"note", text:"Search, follow back, unfollow, or remove followers." }),
      el("div", { style:"height:10px" }),
      statsRow,
      el("div", { style:"height:10px" }),
      searchWrap,
      searchStatus,
      el("div", { style:"height:10px" }),
      bodyHost,
      el("div", { style:"height:10px" }),

      el("div", { class:"btnrow connFooterRow" }, [
        addFriendBtn,
        el("button", {
          class:"btn",
          style:"margin-left:auto;",
          onClick: () => Modal.close()
        }, ["Done"])
      ])
    ])
  });

  refreshLists().then(repaintModal);
}
     
     
root.appendChild(el("div", { class:"card" }, [
  // Enhanced IG-style header (UI-only)
  (() => {
    const isSignedIn = (typeof Social.isSignedIn === "function") ? !!Social.isSignedIn() : !!user;

        const profileTargetId = String(
      (ui.view === "profile")
        ? (ui.friendId || (user?.id || ""))
        : (user?.id || "")
    );

    const isOwnHeaderProfile = !!user && String(profileTargetId || "") === String(user?.id || "");

    // Best-effort display name (UI only)
    const dn = (() => {
      try{
        if(isOwnHeaderProfile){
          const u = user || null;
          const meta = u?.user_metadata || {};
          return String(meta.full_name || meta.name || u?.email || "You");
        }
        return String((Social.nameFor && Social.nameFor(profileTargetId)) || "User");
      }catch(_){
        return "User";
      }
    })();

    const initials = (() => {
      try{
        const parts = String(dn || "").trim().split(/\s+/).filter(Boolean);
        const a = (parts[0] || "")[0] || "";
        const b = (parts.length > 1 ? (parts[parts.length - 1] || "")[0] : "") || "";
        const s = (a + b).toUpperCase();
        return s || "•";
      }catch(_){
        return "•";
      }
    })();

    const myFollows = (Social.getFollows ? Social.getFollows() : followsNow) || [];
    const myFollowers = (Social.getFollowers ? Social.getFollowers() : followersNow) || [];
    const cachedOtherCounts = (!isOwnHeaderProfile && ui.profileCountsById)
      ? (ui.profileCountsById[String(profileTargetId || "")] || null)
      : null;
    const followingCount = isOwnHeaderProfile ? myFollows.length : Number(cachedOtherCounts?.following || 0);
    const followerCount = isOwnHeaderProfile ? myFollowers.length : Number(cachedOtherCounts?.followers || 0);
    const isFollowingTarget = !isOwnHeaderProfile && myFollows.includes(String(profileTargetId || ""));

    // Posts count (UI-only; no new storage keys)
    const postCount = (Social.getFeed ? Social.getFeed() : []).filter(ev =>
      String(ev?.actorId || "") === String(profileTargetId || "") &&
      String(ev?.type || "") === "workout_completed"
    ).length;

    const notifCount = (Social.getNotifications ? Social.getNotifications().length : 0);

    const openConn = async (tab) => {
      if(!configured){
        showToast("Set up Friends in Settings first");
        return;
      }
      try{
        if(Social.fetchFollows) { try{ await Social.fetchFollows(); }catch(_){} }
        if(Social.fetchFollowers) { try{ await Social.fetchFollowers(); }catch(_){} }
      }catch(_){}
      openConnectionsModal(tab);
    };

    // Top row (avatar ring + title/subtitle + bell icon)
    const topRow = el("div", {
      style:"display:flex; align-items:center; justify-content:space-between; gap:12px;"
    }, [
      el("div", { style:"display:flex; align-items:center; gap:12px; min-width:0;" }, [
        // IG ring avatar
        el("div", {
          style:[
            "width:50px",
            "height:50px",
            "border-radius:999px",
            "padding:2px",
            "background: conic-gradient(from 20deg, rgba(56,210,111,.95), rgba(120,140,255,.75), rgba(255,120,170,.55), rgba(56,210,111,.95))",
            "box-shadow: 0 10px 18px rgba(0,0,0,.25)",
            "position:relative",
            "flex:0 0 auto"
          ].join(";")
        }, [
          el("div", {
            style:[
              "width:100%",
              "height:100%",
              "border-radius:999px",
              "border:1px solid rgba(255,255,255,.14)",
              "background: radial-gradient(18px 18px at 30% 30%, rgba(255,255,255,.35), transparent 55%), linear-gradient(135deg, rgba(120,140,255,.28), rgba(56,210,111,.18))",
              "display:flex",
              "align-items:center",
              "justify-content:center",
              "font-weight:1100",
              "letter-spacing:.6px"
            ].join(";"),
            text: initials
          }),
          // Online dot (only when signed in)
          isSignedIn ? el("div", {
            style:[
              "position:absolute",
              "right:-1px",
              "bottom:-1px",
              "width:14px",
              "height:14px",
              "border-radius:999px",
              "background: rgba(56,210,111,.95)",
              "border:2px solid rgba(10,14,20,1)",
              "box-shadow: 0 0 0 3px rgba(56,210,111,.12)"
            ].join(";")
          }) : null
        ].filter(Boolean)),

        // Title + subtitle
        el("div", { style:"display:flex; flex-direction:column; gap:3px; min-width:0;" }, [
          el("h2", { text:"Friends", style:"margin:0;" }),
          el("div", {
            class:"meta",
            style:[
              "font-size:12px",
              "font-weight:850",
              "opacity:.72",
              "overflow:hidden",
              "text-overflow:ellipsis",
              "white-space:nowrap",
              "max-width:260px"
            ].join(";"),
            text: (dn && dn !== "You") ? dn : (isSignedIn ? "Signed in" : "Signed out")
          })
        ])
      ]),

      // Bell icon button + overlay badge (signed-in only)
      (user)
        ? el("button", {
            type:"button",
            style:[
              "width:44px",
              "height:44px",
              "border-radius:14px",
              "border:1px solid rgba(255,255,255,.14)",
              "background: rgba(255,255,255,.06)",
              "display:flex",
              "align-items:center",
              "justify-content:center",
              "cursor:pointer",
              "position:relative",
              "-webkit-tap-highlight-color: transparent"
            ].join(";"),
            onClick: async () => {
              try{
                if(Social.fetchNotifications) await Social.fetchNotifications();
                // ✅ correct in-scope modal opener
                openFollowerNotifsModal();
              }catch(_){}
            }
          }, [
            el("div", { style:"font-size:18px;", text:"🔔" }),
            el("div", {
              style:[
                "position:absolute",
                "top:-6px",
                "right:-6px",
                "width:22px",
                "height:22px",
                "border-radius:999px",
                "background: rgba(56,210,111,.95)",
                "border:2px solid rgba(10,14,20,1)",
                "display:flex",
                "align-items:center",
                "justify-content:center",
                "font-size:12px",
                "font-weight:1100"
              ].join(";"),
              text: String(notifCount || 0)
            })
          ])
        : null
    ].filter(Boolean));

        // Stats bar (following/followers/mutual)
    const statsBar = configured ? el("div", {
      style:[
        "display:flex",
        "gap:0",
        "border:1px solid rgba(255,255,255,.10)",
        "background: rgba(255,255,255,.04)",
        "border-radius:14px",
        "overflow:hidden"
      ].join(";")
    }, [
      // Following
      ((label, value, onClick) => el("button", {
        type:"button",
        style:[
          "flex:1",
          "border:none",
          "background:transparent",
          "color: rgba(255,255,255,.92)",
          "padding: 12px 6px",
          "cursor:pointer",
          "display:flex",
          "flex-direction:column",
          "align-items:center",
          "gap:4px",
          "-webkit-tap-highlight-color: transparent"
        ].join(";"),
        onClick
      }, [
        el("div", { style:"font-size:18px; font-weight:1100;", text: String(value || 0) }),
        el("div", { style:"font-size:12px; opacity:.68; font-weight:950;", text: label })
      ]))("Following", followingCount, isOwnHeaderProfile ? (() => openConn("following")) : null),

      // divider
      el("div", { style:"width:1px; background: rgba(255,255,255,.10);" }),

      // Followers
      ((label, value, onClick) => el("button", {
        type:"button",
        style:[
          "flex:1",
          "border:none",
          "background:transparent",
          "color: rgba(255,255,255,.92)",
          "padding: 12px 6px",
          "cursor:pointer",
          "display:flex",
          "flex-direction:column",
          "align-items:center",
          "gap:4px",
          "-webkit-tap-highlight-color: transparent"
        ].join(";"),
        onClick
      }, [
        el("div", { style:"font-size:18px; font-weight:1100;", text: String(value || 0) }),
        el("div", { style:"font-size:12px; opacity:.68; font-weight:950;", text: label })
      ]))("Followers", followerCount, isOwnHeaderProfile ? (() => openConn("followers")) : null),

      // divider
      el("div", { style:"width:1px; background: rgba(255,255,255,.10);" }),

      // Mutual
      ((label, value, onClick) => el("button", {
        type:"button",
        style:[
          "flex:1",
          "border:none",
          "background:transparent",
          "color: rgba(255,255,255,.92)",
          "padding: 12px 6px",
          "cursor:pointer",
          "display:flex",
          "flex-direction:column",
          "align-items:center",
          "gap:4px",
          "-webkit-tap-highlight-color: transparent"
        ].join(";"),
        onClick
      }, [
        el("div", { style:"font-size:18px; font-weight:1100;", text: String(value || 0) }),
        el("div", { style:"font-size:12px; opacity:.68; font-weight:950;", text: label })
            ]))("Posts", postCount, null)
    ]) : null;

                    // View toggle (UI-only): Feed vs My Profile (own activity)
    const view = ui.view || "feed";
    const tabBtn = (key, label) => el("button", {
      class:"pill",
      style:[
        "flex:0 0 auto",
        "min-width:0",
        "text-align:center",
        "white-space:nowrap",
        "padding:10px 12px",
        "border-radius:999px",
        (view === key) ? "background: rgba(255,255,255,.12)" : "background: rgba(255,255,255,.06)",
        "border: 1px solid rgba(255,255,255,.10)",
        "font-weight:900",
        "letter-spacing:.2px",
        (view === key) ? "color: rgba(255,255,255,.95)" : "color: rgba(255,255,255,.78)",
        "cursor:pointer"
      ].join(";"),
      onClick: () => {
        if(ui.view === key) return;
        if(key === "profile") ui.friendId = "";
        ui.view = key;
        try{ renderView(); }catch(_){}
      }
    }, [label]);

    const viewToggle = el("div", { class:"pillRow", style:"gap:8px;" }, [
      tabBtn("feed", "Feed"),
      tabBtn("profile", isOwnHeaderProfile ? "My Profile" : "Profile")
    ]);

    const otherProfileActions = (!isOwnHeaderProfile && configured && user)
      ? el("div", {
          style:"display:flex; align-items:center; justify-content:space-between; gap:10px;"
        }, [
          el("button", {
            class:"btn",
            type:"button",
            onClick: () => {
              ui.friendId = "";
              ui.view = "profile";
              try{ renderView(); }catch(_){}
            }
          }, ["← Back to My Profile"]),
          el("button", {
            class:isFollowingTarget ? "btn danger" : "btn primary",
            type:"button",
            onClick: async () => {
              try{
                if(isFollowingTarget){
                  await Social.unfollow(profileTargetId);
                  if(ui.profileCountsById[String(profileTargetId || "")]){
                    const prev = ui.profileCountsById[String(profileTargetId || "")];
                    ui.profileCountsById[String(profileTargetId || "")] = {
                      following: Number(prev?.following || 0) || 0,
                      followers: Math.max(0, (Number(prev?.followers || 0) || 0) - 1)
                    };
                  }
                  showToast("Unfollowed");
                }else{
                  await Social.follow(profileTargetId);
                  if(ui.profileCountsById[String(profileTargetId || "")]){
                    const prev = ui.profileCountsById[String(profileTargetId || "")];
                    ui.profileCountsById[String(profileTargetId || "")] = {
                      following: Number(prev?.following || 0) || 0,
                      followers: (Number(prev?.followers || 0) || 0) + 1
                    };
                  }
                  showToast("Following");
                }
                try{ if(Social.fetchFollows) await Social.fetchFollows(); }catch(_){}
                try{ if(Social.fetchFollowers) await Social.fetchFollowers(); }catch(_){}
                try{ renderView(); }catch(_){}
              }catch(e){
                showToast(e?.message || (isFollowingTarget ? "Couldn't unfollow" : "Follow failed"));
              }
            }
          }, [isFollowingTarget ? "Unfollow" : "Follow"])
        ])
      : null;

    const actionsRow = configured
      ? (isOwnHeaderProfile
          ? el("div", {
              style:"display:flex; align-items:center; justify-content:space-between; gap:10px;"
            }, [
              viewToggle,
              el("div", {
                style:[
                  "display:inline-flex",
                  "align-items:center",
                  "gap:10px",
                  "padding:8px 10px",
                  "border-radius:999px",
                  "border:1px solid rgba(255,255,255,.14)",
                  "background:rgba(255,255,255,.06)",
                  "color:rgba(255,255,255,.92)",
                  "font-weight:1000",
                  "font-size:12px",
                  "white-space:nowrap",
                  "flex:0 0 auto"
                ].join(";")
              }, [
                el("span", {
                  style:[
                    "width:10px",
                    "height:10px",
                    "border-radius:999px",
                    "background:rgba(56,210,111,.95)",
                    "box-shadow:0 0 0 3px rgba(56,210,111,.14)"
                  ].join(";")
                }),
                el("span", { text: isSignedIn ? "Signed in" : "Signed out" })
              ])
            ])
          : otherProfileActions)
      : null;
    
    // Auth CTA row (unchanged behavior)
    const authRow = configured ? el("div", { class:"btnrow" }, [
      !user ? el("button", {
        class:"btn primary",
        style:"width:100%;",
        onClick: async () => {
          try{
            await Social.signInWithOAuth("google");
          }catch(e){
            showToast(e?.message || "Google sign-in failed");
          }
        }
      }, ["Continue with Google"]) : null
    ].filter(Boolean)) : null;

    return el("div", {}, [
      topRow,

      el("div", { style:"height:12px" }),

      !configured
        ? el("div", {
            class:"note",
            style:"color: rgba(255,92,122,.95);",
            text:"Social is not configured yet. Set Supabase URL + anon key in Settings → Friends (Beta)."
          })
        : null,

      configured ? el("div", { style:"height:12px" }) : null,
      statsBar,

      configured ? el("div", { style:"height:12px" }) : null,
      actionsRow,
    ].filter(Boolean));
  })()
].filter(Boolean)));
   
       // Feed / My Profile (same cards; body list switches)
  const feedAll = Social.getFeed ? Social.getFeed() : [];
  const viewBody = ui.view || "feed";
  const myId = user ? String(user.id || "") : "";
  const profileUserId = (viewBody === "profile")
    ? String(ui.friendId || myId || "")
    : myId;
  const isOwnProfile = !!myId && String(profileUserId || "") === String(myId || "");

    const feedList = (viewBody === "profile" && profileUserId)
    ? (feedAll || []).filter(ev => String(ev?.actorId || "") === String(profileUserId || ""))
    : (feedAll || []);

      if(configured && user && isOwnProfile && !ui._routineSharesLoading &&
    (!ui._routineSharesLoadedAt || (Date.now() - ui._routineSharesLoadedAt) > 15000)){
    ui._routineSharesLoading = true;

    setTimeout(async () => {
      try{
        await Social.fetchRoutineSharesInbox?.();
      }catch(_){
        // keep UI resilient
      }finally{
        ui._routineSharesLoadedAt = Date.now();
        ui._routineSharesLoading = false;
        try{ renderView(); }catch(_){}
      }
    }, 0);
  }

  function openRoutineSharePreview(share){
    const snap = share?.routinePayload || null;
    const days = Array.isArray(snap?.days) ? snap.days.slice().sort((a,b) => Number(a?.order||0) - Number(b?.order||0)) : [];
    const senderName = (Social.nameFor && Social.nameFor(share?.senderId)) || "User";

    const list = el("div", { class:"list" });

    days.forEach(day => {
      const exCount = Array.isArray(day?.exercises) ? day.exercises.length : 0;
      list.appendChild(el("div", { class:"item" }, [
        el("div", { class:"left" }, [
          el("div", { class:"name", text: String(day?.label || "Day") }),
          el("div", { class:"meta", text: day?.isRest ? "Rest day" : `${exCount} exercises` })
        ])
      ]));
    });

    Modal.open({
      title:"Shared Routine",
      bodyNode: el("div", {}, [
        el("div", { class:"note", text:`From ${senderName}` }),
        el("div", { style:"height:6px" }),
        el("div", { style:"font-weight:900;", text: share?.routineName || snap?.name || "Routine" }),
        el("div", { style:"height:12px" }),
        days.length ? list : el("div", { class:"note", text:"No preview available." })
      ])
    });
  }

  const routineSharesInbox = (Social.getRoutineSharesInbox ? Social.getRoutineSharesInbox() : []).filter(Boolean);

    if(configured && user && isOwnProfile && routineSharesInbox.length){
    root.appendChild(el("div", { class:"card" }, [
      el("div", { class:"homeRow" }, [
        el("div", {}, [
          el("h2", { text:"Routine Shares" }),
          el("div", {
            class:"note",
            text: ui._routineSharesLoading
              ? "Checking for new routine shares..."
              : (routineSharesInbox.length
                  ? `${routineSharesInbox.length} pending`
                  : "No pending routine shares")
          })
        ]),
        el("button", {
          class:"btn",
          onClick: async () => {
            try{
              ui._routineSharesLoading = true;
              renderView();
              await Social.fetchRoutineSharesInbox?.();
            }catch(_){
            }finally{
              ui._routineSharesLoading = false;
              ui._routineSharesLoadedAt = Date.now();
              renderView();
            }
          }
        }, ["Refresh"])
      ]),

      el("div", { style:"height:10px" }),

      routineSharesInbox.length
        ? el("div", { style:"display:grid; gap:10px;" }, routineSharesInbox.map(share => {
            const snap = share?.routinePayload || {};
            const meta = buildRoutineSnapshotMeta(snap);
            const senderName = (Social.nameFor && Social.nameFor(share?.senderId)) || "User";
            const senderHandle = usernameToHandle((Social.usernameFor && Social.usernameFor(share?.senderId)) || "");

            return el("div", {
              style:"border:1px solid rgba(255,255,255,.10); background: rgba(255,255,255,.04); border-radius:16px; padding:12px;"
            }, [
              el("div", { style:"font-weight:900;", text: share?.routineName || snap?.name || "Routine" }),
              el("div", {
                class:"note",
                text:`From ${senderName}${senderHandle ? ` • ${senderHandle}` : ""}`
              }),
              el("div", {
                class:"note",
                text:`${meta.dayCount} days • ${meta.exerciseCount} exercises`
              }),
              el("div", { style:"height:10px" }),
              el("div", { class:"btnrow" }, [
                el("button", {
                  class:"btn",
                  onClick: () => openRoutineSharePreview(share)
                }, ["Preview"]),
                el("button", {
                  class:"btn primary",
                  onClick: async () => {
                    try{
                      importSharedRoutinePayload(share?.routinePayload);
                      await Social.markRoutineShareSaved?.(share?.id);
                      showToast("Saved to Your Routines");
                      renderView();
                    }catch(e){
                      showToast(e?.message || "Couldn't save shared routine");
                    }
                  }
                }, ["Save"]),
                el("button", {
                  class:"btn danger",
                  onClick: async () => {
                    try{
                      await Social.dismissRoutineShare?.(share?.id);
                      showToast("Dismissed");
                      renderView();
                    }catch(e){
                      showToast(e?.message || "Couldn't dismiss");
                    }
                  }
                }, ["Dismiss"])
              ])
            ]);
          }))
        : el("div", { class:"note", text:"No one has shared a routine with you yet." })
    ]));
  }

    if(viewBody === "profile" && profileUserId && !isOwnProfile && configured && user){
    const cacheId = String(profileUserId || "");
    const hasCounts = !!ui.profileCountsById?.[cacheId];
    const hasShared = Array.isArray(ui.profileSharedById?.[cacheId]);
    const hasRoutine = Object.prototype.hasOwnProperty.call(ui.profileRoutineById || {}, cacheId);

    if(!ui.profileLoadById?.[cacheId] && (!hasCounts || !hasShared || !hasRoutine)){
      ui.profileLoadById[cacheId] = true;
      Promise.all([
        Social.fetchProfileFollowCounts ? Social.fetchProfileFollowCounts(cacheId) : Promise.resolve({ following:0, followers:0 }),
        Social.fetchProfileWorkoutHighlights ? Social.fetchProfileWorkoutHighlights(cacheId) : Promise.resolve([]),
        Social.fetchProfileRoutine ? Social.fetchProfileRoutine(cacheId) : Promise.resolve(null),
        Social.fetchNames ? Social.fetchNames([cacheId]) : Promise.resolve(null),
        Social.fetchWorkoutHistoryDates ? Social.fetchWorkoutHistoryDates(cacheId) : Promise.resolve([])
      ]).then(([counts, shared, routine, _names, workoutHistoryDates]) => {
        ui.profileCountsById[cacheId] = counts || { following:0, followers:0 };
        ui.profileSharedById[cacheId] = Array.isArray(shared) ? shared : [];
        ui.profileRoutineById[cacheId] = routine || {
          userId: cacheId,
          enabled: false,
          routineName: null,
          routinePayload: null,
          updatedAt: null
        };

        ui.profileWorkoutHistoryById = ui.profileWorkoutHistoryById || {};
        ui.profileWorkoutHistoryById[cacheId] = Array.isArray(workoutHistoryDates) ? workoutHistoryDates : [];
      }).catch(() => {
        ui.profileCountsById[cacheId] = ui.profileCountsById[cacheId] || { following:0, followers:0 };
        ui.profileSharedById[cacheId] = ui.profileSharedById[cacheId] || [];
        ui.profileRoutineById[cacheId] = ui.profileRoutineById[cacheId] || {
          userId: cacheId,
          enabled: false,
          routineName: null,
          routinePayload: null,
          updatedAt: null
        };

        ui.profileWorkoutHistoryById = ui.profileWorkoutHistoryById || {};
        ui.profileWorkoutHistoryById[cacheId] = ui.profileWorkoutHistoryById[cacheId] || [];
      }).finally(() => {
        ui.profileLoadById[cacheId] = false;
        try{
          if(String(ui.friendId || "") === cacheId && String(ui.view || "") === "profile") renderView();
        }catch(_){}
      });
    }
  }
  const profileDisplayName = (() => {
    if(viewBody !== "profile") return "";
    if(!profileUserId) return "User";

    if(isOwnProfile){
      try{
        const meta = user?.user_metadata || {};
        return String(meta.full_name || meta.name || user?.email || Social.nameFor?.(profileUserId) || "You");
      }catch(_){
        return "You";
      }
    }

    return (Social.nameFor && Social.nameFor(profileUserId)) || "User";
  })();

  const bodyTitle = (viewBody === "profile")
    ? (isOwnProfile ? "My Activity" : `${profileDisplayName}'s Activity`)
    : "Feed";

  const emptyMsg = (viewBody === "profile")
    ? (isOwnProfile
        ? "No posts yet. Log a workout and it will appear here."
        : "No posts yet.")
    : "No events yet. Your activity (and friends you follow) will show here.";

    // Better empty states (UI-only)
  const emptyStateNode = (() => {
    // If not signed in
    if(!user){
      return el("div", {
        style:[
          "margin-top:6px",
          "padding:12px",
          "border-radius:14px",
          "border:1px solid rgba(255,255,255,.10)",
          "background:rgba(255,255,255,.05)"
        ].join(";")
      }, [
        el("div", { style:"font-weight:950; font-size:14px;", text:"Sign in to use Friends" }),
        el("div", { style:"height:6px" }),
        el("div", { class:"note", style:"margin:0; opacity:.86;", text:"See your activity and the workouts of people you follow." }),
        el("div", { style:"height:10px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn primary",
            style:"width:100%;",
            onClick: async () => {
              try{
                await Social.signInWithOAuth("google");
              }catch(e){
                showToast(e?.message || "Google sign-in failed");
              }
            }
          }, ["Continue with Google"])
        ])
      ]);
    }

    // Signed in but list is empty
    if(!feedList.length){
      const follows = (Social.getFollows ? Social.getFollows() : followsNow) || [];
      const hasNoFollows = (viewBody === "feed") && (follows.length === 0);
      const myCode = (typeof getMyCode === "function") ? (getMyCode() || "") : "";

      // My Activity empty
      if(viewBody === "profile"){
        return el("div", {
          style:[
            "margin-top:6px",
            "padding:12px",
            "border-radius:14px",
            "border:1px solid rgba(255,255,255,.10)",
            "background:rgba(255,255,255,.05)"
          ].join(";")
        }, [
          el("div", { style:"font-weight:950; font-size:14px;", text:"No posts yet" }),
          el("div", { style:"height:6px" }),
          el("div", { class:"note", style:"margin:0; opacity:.86;", text:"Log a workout and it will appear here." })
        ]);
      }

      // Feed empty because they follow nobody
      if(hasNoFollows){
        return el("div", {
          style:[
            "margin-top:6px",
            "padding:12px",
            "border-radius:14px",
            "border:1px solid rgba(255,255,255,.10)",
            "background:rgba(255,255,255,.05)"
          ].join(";")
        }, [
          el("div", { style:"font-weight:950; font-size:14px;", text:"Your feed is empty" }),
          el("div", { style:"height:6px" }),
          el("div", { class:"note", style:"margin:0; opacity:.86;", text:"Add a friend to see their workouts here." }),
          el("div", { style:"height:10px" }),

          el("div", { class:"btnrow" }, [
            el("button", {
              class:"btn primary",
              style:"width:100%;",
              onClick: () => openAddFriendModal()
            }, ["Add Friend"])
          ]),

          myCode ? el("div", { style:"height:10px" }) : null,
          myCode ? el("div", {
            style:[
              "display:flex",
              "align-items:center",
              "justify-content:space-between",
              "gap:10px",
              "padding:10px",
              "border-radius:12px",
              "border:1px solid rgba(255,255,255,.10)",
              "background:rgba(0,0,0,.12)"
            ].join(";")
          }, [
            el("div", {}, [
              el("div", { style:"font-weight:900; font-size:12px; opacity:.9;", text:"Your friend code" }),
              el("div", { style:"font-weight:1000; letter-spacing:.2px;", text: myCode })
            ]),
            el("button", {
              class:"btn sm",
              onClick: async () => {
                try{
                  await copyTextSafe(myCode);
                  showToast("Copied");
                }catch(_){
                  showToast("Couldn't copy");
                }
              }
            }, ["Copy"])
          ]) : null
        ].filter(Boolean));
      }

      // Feed empty but they do follow someone (or feed just has no events yet)
      return el("div", {
        style:[
          "margin-top:6px",
          "padding:12px",
          "border-radius:14px",
          "border:1px solid rgba(255,255,255,.10)",
          "background:rgba(255,255,255,.05)"
        ].join(";")
      }, [
        el("div", { style:"font-weight:950; font-size:14px;", text:"No events yet" }),
        el("div", { style:"height:6px" }),
        el("div", { class:"note", style:"margin:0; opacity:.86;", text:"Your activity (and friends you follow) will show here." })
      ]);
    }

    return null;
  })();

            const profileHeaderCard = (viewBody === "profile" && user) ? (() => {
    const fmtNum = (n) => {
      const x = Number(n);
      if(!Number.isFinite(x)) return "—";
      const rounded = Math.round(x * 10) / 10;
      return String(rounded);
    };

    const fmtPaceSafe = (sec) => {
      const s = Number(sec);
      if(!Number.isFinite(s) || s <= 0) return "—";
      const whole = Math.floor(s);
      const m = Math.floor(whole / 60);
      const r = whole % 60;
      return `${m}:${String(r).padStart(2, "0")} / unit`;
    };

    const fmtTimeSafe = (sec) => {
      const s = Number(sec);
      if(!Number.isFinite(s) || s <= 0) return "—";
      const whole = Math.floor(s);
      const h = Math.floor(whole / 3600);
      const m = Math.floor((whole % 3600) / 60);
      const r = whole % 60;
      if(h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
      return `${m}:${String(r).padStart(2, "0")}`;
    };

    const getExerciseNameFromLog = (entry, fallback) => {
      try{
        const type = String(entry?.type || "");
        const exId = entry?.exerciseId || null;
        const lib = state?.exerciseLibrary?.[type];
        if(Array.isArray(lib) && exId != null){
          const found = lib.find(x => String(x?.id || "") === String(exId || ""));
          if(found?.name) return String(found.name);
        }
      }catch(_){}
      return String(entry?.nameSnap || fallback || "Exercise");
    };

    const sharedEvents = !isOwnProfile
      ? (Array.isArray(ui.profileSharedById?.[String(profileUserId || "")])
          ? ui.profileSharedById[String(profileUserId || "")]
          : [])
      : [];
    const sharedLoading = !isOwnProfile && !!ui.profileLoadById?.[String(profileUserId || "")];

    const ownWorkoutLogs = Array.isArray(state?.logs?.workouts) ? state.logs.workouts : [];

    const ownStrengthBest = (() => {
      let best = null;
      ownWorkoutLogs.forEach(entry => {
        if(String(entry?.type || "") !== "weightlifting") return;
        const summary = entry?.summary || {};
        const pr = entry?.pr || {};
        const bestWeight = Number(summary?.bestWeight);
        if(!Number.isFinite(bestWeight) || bestWeight <= 0) return;
        const sets = Array.isArray(entry?.sets) ? entry.sets : [];
        let bestSet = null;
        sets.forEach(s => {
          const w = Number(s?.weight);
          const r = Number(s?.reps);
          if(!Number.isFinite(w) || w <= 0) return;
          if(!Number.isFinite(r) || r < 0) return;
          if(!bestSet || w > bestSet.weight || (w === bestSet.weight && r > bestSet.reps)){
            bestSet = { weight: w, reps: r };
          }
        });
        const tsRaw = entry?.createdAt || entry?.updatedAt || entry?.dateISO || null;
        const ts = tsRaw ? (new Date(tsRaw).getTime() || 0) : 0;
        const candidate = {
          weight: bestSet?.weight ?? bestWeight,
          reps: bestSet?.reps ?? 0,
          name: getExerciseNameFromLog(entry, "Strength"),
          ts,
          prRank: (pr?.isPRWeight ? 4 : 0) + (pr?.isPR1RM ? 2 : 0) + (pr?.isPRVolume ? 1 : 0)
        };
        if(
          !best ||
          candidate.weight > best.weight ||
          (candidate.weight === best.weight && candidate.reps > best.reps) ||
          (candidate.weight === best.weight && candidate.reps === best.reps && candidate.prRank > best.prRank) ||
          (candidate.weight === best.weight && candidate.reps === best.reps && candidate.prRank === best.prRank && candidate.ts > best.ts)
        ){
          best = candidate;
        }
      });
      return best;
    })();

    const ownCardioBest = (() => {
      let bestPace = null;
      let bestDistance = null;
      let bestTime = null;
      ownWorkoutLogs.forEach(entry => {
        if(String(entry?.type || "") !== "cardio") return;
        const summary = entry?.summary || {};
        const pace = Number(summary?.paceSecPerUnit);
        const distance = Number(summary?.distance);
        const timeSec = Number(summary?.timeSec);
        const name = getExerciseNameFromLog(entry, "Cardio");
        const tsRaw = entry?.createdAt || entry?.updatedAt || entry?.dateISO || null;
        const ts = tsRaw ? (new Date(tsRaw).getTime() || 0) : 0;

        if(Number.isFinite(pace) && pace > 0){
          if(!bestPace || pace < bestPace.pace || (pace === bestPace.pace && ts > bestPace.ts)){
            bestPace = { pace, name, ts };
          }
        }
        if(Number.isFinite(distance) && distance > 0){
          if(!bestDistance || distance > bestDistance.distance || (distance === bestDistance.distance && ts > bestDistance.ts)){
            bestDistance = { distance, name, ts };
          }
        }
        if(Number.isFinite(timeSec) && timeSec > 0){
          if(!bestTime || timeSec > bestTime.timeSec || (timeSec === bestTime.timeSec && ts > bestTime.ts)){
            bestTime = { timeSec, name, ts };
          }
        }
      });

      if(bestPace) return { value: fmtPaceSafe(bestPace.pace), meta: bestPace.name };
      if(bestDistance) return { value: `${fmtNum(bestDistance.distance)} units`, meta: bestDistance.name };
      if(bestTime) return { value: fmtTimeSafe(bestTime.timeSec), meta: bestTime.name };
      return null;
    })();

    const ownTotalPRs = ownWorkoutLogs.reduce((sum, entry) => {
  const pr = entry?.pr || {};
  return sum + (pr?.isPRWeight ? 1 : 0);
}, 0);

    const parseWeightSet = (text) => {
      const s = String(text || "");
      const m = s.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
      if(m) return { weight: Number(m[1]) || 0, reps: Number(m[2]) || 0 };
      const single = s.match(/(\d+(?:\.\d+)?)/);
      return single ? { weight: Number(single[1]) || 0, reps: 0 } : null;
    };

    const parsePace = (text) => {
      const s = String(text || "");
      const m = s.match(/Pace\s+(\d+):(\d{2})/i);
      return m ? ((Number(m[1]) || 0) * 60 + (Number(m[2]) || 0)) : null;
    };

    const parseDistance = (text) => {
      const s = String(text || "");
      const m = s.match(/Dist\s+(\d+(?:\.\d+)?)/i);
      return m ? (Number(m[1]) || 0) : null;
    };

    const parseTimeSec = (text) => {
      const s = String(text || "");
      const m = s.match(/Time\s+(\d+):(\d{2})(?::(\d{2}))?/i);
      if(!m) return null;
      const a = Number(m[1]) || 0;
      const b = Number(m[2]) || 0;
      const c = Number(m[3] || 0) || 0;
      return m[3] != null ? (a * 3600 + b * 60 + c) : (a * 60 + b);
    };

    const sharedStrengthBest = (() => {
      let best = null;
      sharedEvents.forEach(ev => {
        const p = ev?.payload || {};
        const items = Array.isArray(p?.details?.items) ? p.details.items : [];
        const ts = ev?.createdAt ? (new Date(ev.createdAt).getTime() || 0) : 0;

        items.forEach(item => {
          if(String(item?.type || "") !== "weightlifting") return;
          const parsed = parseWeightSet(item?.topText || "");
          if(!parsed || !Number.isFinite(parsed.weight) || parsed.weight <= 0) return;

          const prBadges = Array.isArray(item?.prBadges) ? item.prBadges : [];
          const candidate = {
            weight: parsed.weight,
            reps: parsed.reps,
            name: String(item?.name || "Strength"),
            ts,
            prRank: prBadges.length
          };

          if(
            !best ||
            candidate.weight > best.weight ||
            (candidate.weight === best.weight && candidate.reps > best.reps) ||
            (candidate.weight === best.weight && candidate.reps === best.reps && candidate.prRank > best.prRank) ||
            (candidate.weight === best.weight && candidate.reps === best.reps && candidate.prRank === best.prRank && candidate.ts > best.ts)
          ){
            best = candidate;
          }
        });
      });
      return best;
    })();

    const sharedCardioBest = (() => {
      let bestPace = null;
      let bestDistance = null;
      let bestTime = null;

      sharedEvents.forEach(ev => {
        const p = ev?.payload || {};
        const items = Array.isArray(p?.details?.items) ? p.details.items : [];
        const ts = ev?.createdAt ? (new Date(ev.createdAt).getTime() || 0) : 0;

        items.forEach(item => {
          if(String(item?.type || "") !== "cardio") return;

          const topText = String(item?.topText || "");
          const pace = parsePace(topText);
          const distance = parseDistance(topText);
          const timeSec = parseTimeSec(topText);
          const name = String(item?.name || "Cardio");

          if(Number.isFinite(pace) && pace > 0){
            if(!bestPace || pace < bestPace.pace || (pace === bestPace.pace && ts > bestPace.ts)){
              bestPace = { pace, name, ts };
            }
          }
          if(Number.isFinite(distance) && distance > 0){
            if(!bestDistance || distance > bestDistance.distance || (distance === bestDistance.distance && ts > bestDistance.ts)){
              bestDistance = { distance, name, ts };
            }
          }
          if(Number.isFinite(timeSec) && timeSec > 0){
            if(!bestTime || timeSec > bestTime.timeSec || (timeSec === bestTime.timeSec && ts > bestTime.ts)){
              bestTime = { timeSec, name, ts };
            }
          }
        });
      });

      if(bestPace) return { value: fmtPaceSafe(bestPace.pace), meta: bestPace.name };
      if(bestDistance) return { value: `${fmtNum(bestDistance.distance)} units`, meta: bestDistance.name };
      if(bestTime) return { value: fmtTimeSafe(bestTime.timeSec), meta: bestTime.name };
      return null;
    })();

    const sharedTotalPRs = sharedEvents.reduce((sum, ev) => {
  const items = Array.isArray(ev?.payload?.details?.items) ? ev.payload.details.items : [];

  const weightPrCount = items.reduce((itemSum, item) => {
    const prBadges = Array.isArray(item?.prBadges) ? item.prBadges : [];
    return itemSum + (prBadges.includes("PR W") ? 1 : 0);
  }, 0);

  return sum + weightPrCount;
}, 0);

        const strengthBest = isOwnProfile ? ownStrengthBest : sharedStrengthBest;
    const cardioBest = isOwnProfile ? ownCardioBest : sharedCardioBest;

        const activeRoutine = isOwnProfile && Routines && typeof Routines.getActive === "function"
      ? Routines.getActive()
      : null;

    const sharedRoutine = !isOwnProfile
      ? (ui.profileRoutineById?.[String(profileUserId || "")] || null)
      : null;

    const sharedRoutineSnapshot = (!isOwnProfile && sharedRoutine?.enabled && sharedRoutine?.routinePayload)
      ? sharedRoutine.routinePayload
      : null;

    function toOwnRoutineSnapshot(routine){
  if(!routine) return null;
  return {
    routineId: routine?.id || null,
    name: routine?.name || "Routine",
    days: (routine.days || [])
      .slice()
      .sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0))
      .map((day, idx) => ({
        id: day?.id || null,
        order: Number(day?.order ?? idx) || 0,
        label: day?.label || `Day ${idx + 1}`,
        isRest: !!day?.isRest,
        exercises: (day?.exercises || []).map((rx, exIdx) => ({
          id: rx?.id || null,
          order: exIdx,
          type: String(rx?.type || ""),
          exerciseId: rx?.exerciseId || null,
          name: resolveExerciseName(rx?.type, rx?.exerciseId, rx?.nameSnap || "Exercise"),
          plan: rx?.plan || null,
          notes: String(rx?.notes || "")
        }))
      }))
  };
}

    function currentConsistencyMetric(snapshot, completedDateISOs, opts = {}){
  const fallbackValue = opts?.loading ? "Loading…" : "—";
  const fallbackMeta = opts?.loading
    ? "Loading consistency…"
    : (opts?.noRoutineMeta || "No routine available");

  const completedList = Array.from(new Set(
    (completedDateISOs || [])
      .map(v => String(v || "").trim())
      .filter(Boolean)
  )).sort();

  if(!completedList.length){
    return { value: fallbackValue, meta: fallbackMeta };
  }

  const latestCompletedISO = completedList[completedList.length - 1];
  const days = Array.isArray(snapshot?.days) ? snapshot.days : [];
  const completed = new Set(completedList);

  function dateFromISO(iso){
    const parts = String(iso || "").split("-").map(Number);
    if(parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
    const dt = new Date(parts[0], parts[1] - 1, parts[2]);
    dt.setHours(12, 0, 0, 0);
    return dt;
  }

  if(!days.length){
    let streak = 0;
    let cursor = dateFromISO(latestCompletedISO);
    if(!cursor) return { value: fallbackValue, meta: fallbackMeta };

    for(let i = 0; i < 366; i++){
      const iso = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`;
      if(completed.has(iso)){
        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
        continue;
      }
      break;
    }

    return {
      value: String(streak),
      meta: streak === 1 ? "Current workout day streak" : "Current workout days streak"
    };
  }

  const trainingOrders = new Set(
    days
      .filter(day => !day?.isRest)
      .map(day => Number(day?.order))
      .filter(Number.isFinite)
  );

  if(!trainingOrders.size){
    return { value: "—", meta: "Routine has only rest days" };
  }

  let streak = 0;
  let cursor = dateFromISO(latestCompletedISO);
  if(!cursor) return { value: fallbackValue, meta: fallbackMeta };

  for(let i = 0; i < 366; i++){
    const iso = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`;
    const order = cursor.getDay(); // 0=Sun..6=Sat

    if(!trainingOrders.has(order)){
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }

    if(completed.has(iso)){
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }

    break;
  }

  return {
    value: String(streak),
    meta: streak === 1 ? "Current training day streak" : "Current training days streak"
  };
}

    const ownRoutineSnapshot = isOwnProfile ? toOwnRoutineSnapshot(activeRoutine) : null;

    const ownCompletedWorkoutDateISOs = Array.from(new Set(
      ownWorkoutLogs
        .filter(entry => !entry?.skipped)
        .map(entry => String(entry?.dateISO || "").trim())
        .filter(Boolean)
    ));

        const sharedCompletedWorkoutDateISOs = Array.isArray(ui.profileWorkoutHistoryById?.[String(profileUserId || "")])
      ? ui.profileWorkoutHistoryById[String(profileUserId || "")]
      : [];

        const consistencyMetric = isOwnProfile
      ? currentConsistencyMetric(ownRoutineSnapshot, ownCompletedWorkoutDateISOs, {
          loading: false,
          noRoutineMeta: "Create or set a routine"
        })
      : currentConsistencyMetric(sharedRoutineSnapshot, sharedCompletedWorkoutDateISOs, {
          loading: sharedLoading,
          noRoutineMeta: "Routine not shared"
        });

    function toOwnRoutineSnapshot(routine){
  if(!routine) return null;
  return {
    routineId: routine?.id || null,
    name: routine?.name || "Routine",
    days: (routine.days || [])
      .slice()
      .sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0))
      .map((day, idx) => ({
        id: day?.id || null,
        order: Number(day?.order ?? idx) || 0,
        label: day?.label || `Day ${idx + 1}`,
        isRest: !!day?.isRest,
        exercises: (day?.exercises || []).map((rx, exIdx) => ({
          id: rx?.id || null,
          order: exIdx,
          type: String(rx?.type || ""),
          exerciseId: rx?.exerciseId || null,
          name: resolveExerciseName(rx?.type, rx?.exerciseId, rx?.nameSnap || "Exercise"),
          plan: rx?.plan || null,
          notes: String(rx?.notes || "")
        }))
      }))
  };
}

function mondayFirstTodayOrder(){
  const dow = new Date().getDay(); // 0=Sun..6=Sat
  return (dow + 6) % 7;            // 0=Mon..6=Sun
}

function dayNameFromOrder(order){
  // App routine day order is Sunday-first:
  // 0=Sunday, 1=Monday, ... 6=Saturday
  const names = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const idx = Number(order);
  return names[idx] || `Day ${Number.isFinite(idx) ? (idx + 1) : ""}`.trim();
}

function inferRoutineFocus(snapshot){
  const labels = (snapshot?.days || [])
    .filter(day => !day?.isRest)
    .map(day => String(day?.label || "").trim())
    .filter(Boolean);

  if(!labels.length) return "Custom Routine";

  const seen = new Set();
  const uniq = [];
  labels.forEach(label => {
    const k = normName(label);
    if(!k || seen.has(k)) return;
    seen.add(k);
    uniq.push(label);
  });

  return uniq.slice(0, 3).join(" • ");
}

function nextSavedRoutineName(baseName){
  const cleanBase = String(baseName || "Routine").trim() || "Routine";
  const existing = (Routines.getAll ? Routines.getAll() : (state.routines || [])) || [];
  const used = new Set(existing.map(r => String(r?.name || "").trim().toLowerCase()).filter(Boolean));

  if(!used.has(cleanBase.toLowerCase())) return cleanBase;

  let n = 2;
  while(used.has(`${cleanBase} (${n})`.toLowerCase())){
    n++;
  }
  return `${cleanBase} (${n})`;
}

function resolveLibraryExerciseIdFromSnapshot(rx){
  ExerciseLibrary.ensureSeeded();

  const type = String(rx?.type || "weightlifting");
  const name = String(rx?.name || rx?.nameSnap || "Exercise").trim() || "Exercise";

  state.exerciseLibrary = state.exerciseLibrary || { weightlifting: [], cardio: [], core: [] };
  state.exerciseLibrary[type] = Array.isArray(state.exerciseLibrary[type]) ? state.exerciseLibrary[type] : [];

  const lib = state.exerciseLibrary[type];

  const byId = lib.find(x => String(x?.id || "") === String(rx?.exerciseId || ""));
  if(byId) return byId.id;

  const byName = lib.find(x => normName(x?.name || "") === normName(name));
  if(byName) return byName.id;

  const created = {
    id: uid("ex"),
    type,
    name,
    equipment: "",
    primaryMuscle: "",
    secondaryMuscles: [],
    createdAt: Date.now()
  };

  lib.push(created);
  return created.id;
}

function saveRoutineSnapshotToMyRoutines(snapshot){
  if(!snapshot) throw new Error("No routine available to save.");

  ExerciseLibrary.ensureSeeded();

  state.routines = Array.isArray(state.routines) ? state.routines : [];

  const nextRoutine = {
    id: uid("rt"),
    name: nextSavedRoutineName(snapshot?.name || "Routine"),
    createdAt: Date.now(),
    days: (Array.isArray(snapshot?.days) ? snapshot.days : [])
      .slice()
      .sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0))
      .map((day, idx) => ({
        id: uid("day"),
        order: Number(day?.order ?? idx) || 0,
        label: String(day?.label || `Day ${idx + 1}`),
        isRest: !!day?.isRest,
        exercises: (Array.isArray(day?.exercises) ? day.exercises : []).map((rx, exIdx) => ({
          id: uid("rx"),
          exerciseId: resolveLibraryExerciseIdFromSnapshot(rx),
          type: String(rx?.type || "weightlifting"),
          nameSnap: String(rx?.name || "Exercise"),
          createdAt: Date.now() + exIdx,
          plan: rx?.plan ? { ...rx.plan } : null,
          notes: String(rx?.notes || "")
        }))
      }))
  };

  state.routines.push(nextRoutine);
  Storage.save(state);

  return nextRoutine;
}

function buildRoutineModalBodyFromSnapshot(snapshot, noteText, opts = {}){
  const days = (Array.isArray(snapshot?.days) ? snapshot.days : [])
    .slice()
    .sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0));

  const ownerName = String(opts?.ownerName || "Routine").trim() || "Routine";
  const canSave = !!opts?.canSave;
  const saveButtonText = String(opts?.saveButtonText || "Save This Routine");

  const nonRestDays = days.filter(day => !day?.isRest);
  const totalExercises = nonRestDays.reduce((sum, day) => {
    return sum + ((Array.isArray(day?.exercises) ? day.exercises.length : 0) || 0);
  }, 0);

  const focusText = inferRoutineFocus(snapshot);
  const todayOrder = mondayFirstTodayOrder();

  const root = el("div", {
    style:"display:flex; flex-direction:column; gap:10px;"
  });

  root.appendChild(el("div", {
    style:[
      "padding:14px",
      "border-radius:16px",
      "border:1px solid rgba(255,255,255,.10)",
      "background:rgba(255,255,255,.05)"
    ].join(";")
  }, [
    el("div", {
      style:"font-size:18px; font-weight:1000; line-height:1.15;"
    }, [`${ownerName}`]),
    el("div", {
      style:"margin-top:4px; font-size:14px; font-weight:900; opacity:.92;"
    }, [String(snapshot?.name || "Routine")]),
    el("div", { style:"height:10px" }),
    el("div", {
      style:"display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px;"
    }, [
      el("div", {
        style:"padding:10px 12px; border-radius:12px; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.06);"
      }, [
        el("div", {
          style:"font-size:11px; font-weight:900; opacity:.7; text-transform:uppercase;"
        }, ["Days / Week"]),
        el("div", {
          style:"margin-top:4px; font-size:16px; font-weight:1000;"
        }, [`${nonRestDays.length}`])
      ]),
      el("div", {
        style:"padding:10px 12px; border-radius:12px; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.06);"
      }, [
        el("div", {
          style:"font-size:11px; font-weight:900; opacity:.7; text-transform:uppercase;"
        }, ["Exercises"]),
        el("div", {
          style:"margin-top:4px; font-size:16px; font-weight:1000;"
        }, [`${totalExercises}`])
      ])
    ]),
    el("div", { style:"height:8px" }),
    el("div", {
      class:"note",
      style:"margin:0; opacity:.9;"
    }, [focusText || "Custom Routine"])
  ]));

  if(noteText){
    root.appendChild(el("div", {
      class:"note",
      style:"margin:0;"
    }, [noteText]));
  }

  if(!days.length){
    root.appendChild(el("div", {
      class:"note",
      style:"margin:0;"
    }, ["No days found in this routine."]));
    return root;
  }

  const list = el("div", {
    style:"display:flex; flex-direction:column; gap:8px;"
  });

  days.forEach((day, idx) => {
    const key = String(day?.id || `routine_day_${idx}`);
    const isRest = !!day?.isRest;
    const exercises = Array.isArray(day?.exercises) ? day.exercises : [];
    const isActiveToday = !isRest && Number(day?.order ?? -1) === todayOrder;
    const dayTitle = `${dayNameFromOrder(day?.order)} — ${String(day?.label || `Day ${idx + 1}`)}`;

    const card = el("div", {
      style:[
        "padding:12px",
        "border-radius:16px",
        "border:1px solid rgba(255,255,255,.10)",
        "background:rgba(255,255,255,.05)"
      ].join(";")
    });

    const chevron = el("div", {
      style:[
        "font-size:18px",
        "font-weight:1000",
        "line-height:1",
        "opacity:.88",
        "transition:transform .18s ease",
        "transform:rotate(0deg)",
        "flex:0 0 auto"
      ].join(";")
    }, ["›"]);

    const headerBtn = el("button", {
      type:"button",
      style:[
        "display:flex",
        "align-items:flex-start",
        "justify-content:space-between",
        "gap:10px",
        "width:100%",
        "padding:0",
        "margin:0",
        "border:0",
        "background:transparent",
        "color:inherit",
        "font:inherit",
        "text-align:left",
        isRest ? "cursor:default" : "cursor:pointer",
        "appearance:none",
        "-webkit-appearance:none"
      ].join(";")
    });

    const left = el("div", {
      style:"min-width:0; display:flex; align-items:flex-start; gap:10px; flex:1;"
    }, [
      isRest
        ? el("div", {
            style:"width:18px; height:18px; flex:0 0 18px;"
          })
        : chevron,
      el("div", {
        style:"min-width:0; display:flex; flex-direction:column; gap:4px; flex:1;"
      }, [
        el("div", {
          style:"font-weight:1000; font-size:14px; line-height:1.15;"
        }, [dayTitle]),
        el("div", {
          class:"note",
          style:"margin:0; opacity:.82;"
        }, [
          isRest
            ? "Rest day"
            : (exercises.length === 1 ? "1 Exercise" : `${exercises.length} Exercises`)
        ])
      ])
    ]);

    const right = el("div", {
      style:"display:flex; align-items:center; gap:8px; flex:0 0 auto; margin-left:8px;"
    });

    if(isActiveToday){
      right.appendChild(el("div", {
        style:[
          "display:inline-flex",
          "align-items:center",
          "gap:6px",
          "padding:6px 10px",
          "border-radius:999px",
          "border:1px solid rgba(46,204,113,.35)",
          "background:rgba(46,204,113,.12)",
          "font-size:11px",
          "font-weight:900",
          "color:rgba(180,255,205,.96)",
          "white-space:nowrap"
        ].join(";")
      }, ["● Active Today"]));
    }else if(isRest){
      right.appendChild(el("div", {
        style:[
          "padding:6px 10px",
          "border-radius:999px",
          "border:1px solid rgba(255,255,255,.10)",
          "background:rgba(255,255,255,.06)",
          "font-size:11px",
          "font-weight:900",
          "opacity:.86"
        ].join(";")
      }, ["Rest"]));
    }

    headerBtn.appendChild(left);
    headerBtn.appendChild(right);
    card.appendChild(headerBtn);

    const body = el("div", {
      style:[
        "overflow:hidden",
        "max-height:0px",
        "opacity:0",
        "margin-top:0px",
        "transition:max-height .22s ease, opacity .18s ease, margin-top .18s ease"
      ].join(";")
    });

    const bodyInner = el("div", {
      style:"display:flex; flex-direction:column; gap:6px;"
    });

    if(!isRest){
      if(exercises.length){
        exercises.forEach((rx, exIdx) => {
          const planBits = [];
          if(Number.isFinite(Number(rx?.plan?.sets))) planBits.push(`${Number(rx.plan.sets)} sets`);
          if(String(rx?.plan?.reps || "").trim()) planBits.push(String(rx.plan.reps));
          if(Number.isFinite(Number(rx?.plan?.restSec))) planBits.push(`${Number(rx.plan.restSec)}s rest`);
          if(Number.isFinite(Number(rx?.plan?.targetWeight))) planBits.push(`${Number(rx.plan.targetWeight)} lb`);

          bodyInner.appendChild(el("div", {
            style:[
              "display:flex",
              "align-items:center",
              "justify-content:space-between",
              "gap:10px",
              "padding:10px 12px",
              "border-radius:12px",
              "background:rgba(255,255,255,.04)",
              "border:1px solid rgba(255,255,255,.06)"
            ].join(";")
          }, [
            el("div", {
              style:"min-width:0; display:flex; flex-direction:column; gap:3px; flex:1;"
            }, [
              el("div", {
                style:[
                  "font-weight:900",
                  "font-size:13px",
                  "overflow:hidden",
                  "text-overflow:ellipsis",
                  "white-space:nowrap"
                ].join(";")
              }, [String(rx?.name || "Exercise")]),
              el("div", {
                class:"note",
                style:"margin:0; text-transform:capitalize;"
              }, [
                [planBits.join(" • "), String(rx?.notes || "").trim()]
                  .filter(Boolean)
                  .join(" • ") || "No plan details"
              ])
            ]),
            el("div", {
              style:"font-size:11px; font-weight:900; opacity:.7; flex:0 0 auto;"
            }, [`#${exIdx + 1}`])
          ]));
        });
      }else{
        bodyInner.appendChild(el("div", {
          class:"note",
          style:"margin:0; opacity:.86;"
        }, ["No exercises added"]));
      }
    }

    body.appendChild(bodyInner);
    card.appendChild(body);
    list.appendChild(card);

    if(!isRest){
      const setExpanded = (open) => {
        chevron.style.transform = open ? "rotate(90deg)" : "rotate(0deg)";
        body.style.opacity = open ? "1" : "0";
        body.style.marginTop = open ? "10px" : "0px";
        body.style.maxHeight = open ? `${bodyInner.scrollHeight + 8}px` : "0px";
      };

      headerBtn.addEventListener("click", () => {
        const isOpen = body.style.maxHeight && body.style.maxHeight !== "0px";
        setExpanded(!isOpen);
      });

      requestAnimationFrame(() => {
  setExpanded(false);
});
    }
  });

  root.appendChild(list);

  if(canSave){
    root.appendChild(el("div", { style:"height:4px" }));
    root.appendChild(el("div", { class:"btnrow" }, [
      el("button", {
        class:"btn primary",
        onClick: () => {
          try{
            const saved = saveRoutineSnapshotToMyRoutines(snapshot);
            Modal.close();
            showToast(`Saved to Routines: ${saved.name}`);
          }catch(e){
            showToast(e?.message || "Could not save routine");
          }
        }
      }, [saveButtonText])
    ]));
  }

  return root;
}


function getOwnAllStrengthAndCorePRs(){
  const workouts = Array.isArray(state?.logs?.workouts) ? state.logs.workouts : [];
  const byExercise = new Map();

  workouts.forEach(entry => {
    if(!entry || entry.skipped) return;

    const type = String(entry.type || "");
    if(type !== "weightlifting" && type !== "core") return;

    const exerciseId = String(entry.exerciseId || "");
    if(!exerciseId) return;

    const name = resolveExerciseName(type, entry.exerciseId, entry.nameSnap || "Exercise");

    if(type === "weightlifting"){
      const sets = Array.isArray(entry.sets) ? entry.sets : [];
      let bestWeight = 0;
      let bestRepsAtBestWeight = 0;

      sets.forEach(s => {
        const w = Number(s?.weight) || 0;
        const r = Number(s?.reps) || 0;
        if(w > bestWeight || (w === bestWeight && r > bestRepsAtBestWeight)){
          bestWeight = w;
          bestRepsAtBestWeight = r;
        }
      });

      if(bestWeight <= 0) return;

      const prev = byExercise.get(exerciseId);
      if(!prev || bestWeight > prev.weight || (bestWeight === prev.weight && bestRepsAtBestWeight > prev.reps)){
        byExercise.set(exerciseId, {
          type,
          exerciseId,
          name,
          weight: bestWeight,
          reps: bestRepsAtBestWeight
        });
      }
      return;
    }

    // core
    const summary = entry.summary || {};
    const totalVolume = Number(summary.totalVolume) || 0;
    const reps = Number(summary.reps) || 0;
    const timeSec = Number(summary.timeSec) || 0;
    const weight = Number(summary.weight) || 0;

    const prev = byExercise.get(exerciseId);
    const score = totalVolume || reps || timeSec || weight;
    if(score <= 0) return;

    if(!prev || score > prev.score){
      byExercise.set(exerciseId, {
        type,
        exerciseId,
        name,
        score,
        reps,
        timeSec,
        weight,
        totalVolume
      });
    }
  });

  return Array.from(byExercise.values())
    .sort((a, b) => {
      const aKey = Number(a.weight || a.score || 0);
      const bKey = Number(b.weight || b.score || 0);
      return bKey - aKey || String(a.name || "").localeCompare(String(b.name || ""));
    });
}

function getOwnAllCardioPRs(){
  const workouts = Array.isArray(state?.logs?.workouts) ? state.logs.workouts : [];
  const byExercise = new Map();

  workouts.forEach(entry => {
    if(!entry || entry.skipped || String(entry.type || "") !== "cardio") return;

    const exerciseId = String(entry.exerciseId || "");
    if(!exerciseId) return;

    const name = resolveExerciseName("cardio", entry.exerciseId, entry.nameSnap || "Exercise");
    const summary = entry.summary || {};

    const pace = Number(summary.paceSecPerUnit);
    const distance = Number(summary.distance) || 0;
    const timeSec = Number(summary.timeSec) || 0;

    const prev = byExercise.get(exerciseId);

    if(Number.isFinite(pace) && pace > 0){
      if(!prev || !Number.isFinite(prev.pace) || pace < prev.pace){
        byExercise.set(exerciseId, { exerciseId, name, pace, distance, timeSec });
      }
      return;
    }

    if(distance > 0){
      if(!prev || distance > (Number(prev.distance) || 0)){
        byExercise.set(exerciseId, { exerciseId, name, pace:null, distance, timeSec });
      }
      return;
    }

    if(timeSec > 0){
      if(!prev || timeSec > (Number(prev.timeSec) || 0)){
        byExercise.set(exerciseId, { exerciseId, name, pace:null, distance, timeSec });
      }
    }
  });

  return Array.from(byExercise.values())
    .sort((a, b) => {
      const aP = Number.isFinite(a?.pace) ? a.pace : Infinity;
      const bP = Number.isFinite(b?.pace) ? b.pace : Infinity;
      if(aP !== bP) return aP - bP;

      const aD = Number(a?.distance || 0);
      const bD = Number(b?.distance || 0);
      if(bD !== aD) return bD - aD;

      const aT = Number(a?.timeSec || 0);
      const bT = Number(b?.timeSec || 0);
      return bT - aT;
    });
}

function getSharedStrengthAndCorePRsFromEvents(sharedEvents){
  const byName = new Map();

  (sharedEvents || []).forEach(ev => {
    const items = Array.isArray(ev?.payload?.details?.items) ? ev.payload.details.items : [];
    items.forEach(item => {
      const type = String(item?.type || "");
      if(type !== "weightlifting" && type !== "core") return;

      const name = String(item?.name || "").trim();
      if(!name) return;

      const topText = String(item?.topText || "");
      const m = topText.match(/(\d+(?:\.\d+)?)\s*×\s*(\d+)/);

      if(type === "weightlifting" && m){
        const weight = Number(m[1]) || 0;
        const reps = Number(m[2]) || 0;
        if(weight <= 0) return;

        const prev = byName.get(name);
        if(!prev || weight > prev.weight || (weight === prev.weight && reps > prev.reps)){
          byName.set(name, { type, name, weight, reps });
        }
        return;
      }

      if(type === "core"){
        const badges = Array.isArray(item?.prBadges) ? item.prBadges : [];
        const score =
          Number(item?.lifetime?.bestVolume) ||
          (badges.length ? 1 : 0);

        if(score <= 0) return;

        const prev = byName.get(name);
        if(!prev || score > (Number(prev.score) || 0)){
          byName.set(name, { type, name, score });
        }
      }
    });
  });

  return Array.from(byName.values()).sort((a, b) => {
    const aKey = Number(a.weight || a.score || 0);
    const bKey = Number(b.weight || b.score || 0);
    return bKey - aKey || String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function getSharedCardioPRsFromEvents(sharedEvents){
  const byName = new Map();

  (sharedEvents || []).forEach(ev => {
    const items = Array.isArray(ev?.payload?.details?.items) ? ev.payload.details.items : [];
    items.forEach(item => {
      if(String(item?.type || "") !== "cardio") return;

      const name = String(item?.name || "").trim();
      if(!name) return;

      const topText = String(item?.topText || "");
      const paceMatch = topText.match(/Pace\s+(\d+):(\d+)/i);
      const distMatch = topText.match(/Dist\s+(\d+(?:\.\d+)?)/i);
      const timeMatch = topText.match(/Time\s+(\d+):(\d+)/i);

      const pace = paceMatch ? ((Number(paceMatch[1]) * 60) + Number(paceMatch[2])) : null;
      const distance = distMatch ? (Number(distMatch[1]) || 0) : 0;
      const timeSec = timeMatch ? ((Number(timeMatch[1]) * 60) + Number(timeMatch[2])) : 0;

      const prev = byName.get(name);

      if(Number.isFinite(pace) && pace > 0){
        if(!prev || !Number.isFinite(prev.pace) || pace < prev.pace){
          byName.set(name, { name, pace, distance, timeSec });
        }
        return;
      }

      if(distance > 0){
        if(!prev || distance > (Number(prev.distance) || 0)){
          byName.set(name, { name, pace:null, distance, timeSec });
        }
        return;
      }

      if(timeSec > 0){
        if(!prev || timeSec > (Number(prev.timeSec) || 0)){
          byName.set(name, { name, pace:null, distance, timeSec });
        }
      }
    });
  });

  return Array.from(byName.values()).sort((a, b) => {
    const aP = Number.isFinite(a?.pace) ? a.pace : Infinity;
    const bP = Number.isFinite(b?.pace) ? b.pace : Infinity;
    if(aP !== bP) return aP - bP;

    const aD = Number(a?.distance || 0);
    const bD = Number(b?.distance || 0);
    if(bD !== aD) return bD - aD;

    const aT = Number(a?.timeSec || 0);
    const bT = Number(b?.timeSec || 0);
    return bT - aT;
  });
}

function buildPRListRows(items, kind){
  const rows = el("div", { class:"list" }, []);

  if(!Array.isArray(items) || !items.length){
    rows.appendChild(el("div", { class:"note", text:`No ${kind} PRs available yet.` }));
    return rows;
  }

  items.forEach(item => {
    let valueText = "—";

    if(kind === "strength"){
      if(item?.type === "weightlifting"){
        valueText = `${fmtNum(item.weight)} × ${item.reps}`;
      }else{
        valueText =
          item?.totalVolume ? `${fmtNum(item.totalVolume)} volume` :
          item?.reps ? `${fmtNum(item.reps)} reps` :
          item?.timeSec ? fmtTimeSafe(item.timeSec) :
          item?.weight ? `${fmtNum(item.weight)} lb` :
          "PR";
      }
    }else{
      valueText =
        Number.isFinite(item?.pace) ? fmtPaceSafe(item.pace) :
        (Number(item?.distance || 0) > 0 ? `${fmtNum(item.distance)} units` :
        (Number(item?.timeSec || 0) > 0 ? fmtTimeSafe(item.timeSec) : "PR"));
    }

    rows.appendChild(el("div", { class:"item" }, [
      el("div", { class:"left" }, [
        el("div", { class:"name", text: item?.name || "Exercise" }),
        el("div", { class:"meta", text: item?.type === "core" ? "Core PR" : (kind === "cardio" ? "Cardio PR" : "Strength PR") })
      ]),
      el("div", { class:"right" }, [
        el("div", {
          style:"font-weight:1000; font-size:14px; white-space:nowrap;"
        }, [valueText])
      ])
    ]));
  });

  return rows;
}

function openCompareProfilePRModal(opts = {}){
  const baseUserId = String(opts?.baseUserId || "");
  const baseDisplayName = String(opts?.baseDisplayName || "User");

  let searchTimer = null;

  const queryInput = el("input", {
    type:"text",
    placeholder:"Search @username",
    autocapitalize:"off",
    autocorrect:"off",
    spellcheck:"false"
  });

  const resultsHost = el("div", { class:"list" });
  const compareBody = el("div", { class:"grid" }, [
    el("div", { class:"note", text:`Compare ${baseDisplayName}'s PRs with another user.` }),
    queryInput,
    resultsHost
  ]);

  function normalizeCompareName(v){
    return normName ? normName(v) : String(v || "").trim().toLowerCase();
  }

  function buildCompareValue(item, kind){
    if(!item) return "—";

    if(kind === "strength"){
      const weight = Number(item?.weight || 0);
      const reps = Number(item?.reps || 0);
      if(weight > 0 && reps > 0) return `${fmtNum(weight)} × ${reps}`;
      if(weight > 0) return `${fmtNum(weight)} lb`;
      return "—";
    }

    if(Number.isFinite(item?.pace) && item.pace > 0){
      return fmtPaceSafe(item.pace);
    }

    const distance = Number(item?.distance || 0);
    if(distance > 0) return `${fmtNum(distance)} mi`;

    const timeSec = Number(item?.timeSec || 0);
    if(timeSec > 0) return fmtTimeSafe(timeSec);

    return "—";
  }

  function buildCompareMeta(item, kind){
    if(!item) return "No result";

    if(kind === "strength"){
      const weight = Number(item?.weight || 0);
      const reps = Number(item?.reps || 0);
      if(weight > 0 && reps > 0) return `Top weight • ${fmtNum(weight)} × ${reps}`;
      if(weight > 0) return `Top weight • ${fmtNum(weight)} lb`;
      return "No result";
    }

    const distance = Number(item?.distance || 0);
    const timeSec = Number(item?.timeSec || 0);
    const paceText = (Number.isFinite(item?.pace) && item.pace > 0) ? fmtPaceSafe(item.pace) : "";

    if(paceText && distance > 0 && timeSec > 0){
      return `${fmtNum(distance)} mi • ${fmtTimeSafe(timeSec)}`;
    }
    if(paceText && distance > 0) return `${fmtNum(distance)} mi`;
    if(distance > 0 && timeSec > 0) return `${fmtNum(distance)} mi • ${fmtTimeSafe(timeSec)}`;
    if(distance > 0) return `${fmtNum(distance)} mi`;
    if(timeSec > 0) return fmtTimeSafe(timeSec);

    return paceText || "No result";
  }

  function buildCompareRows(leftItems, rightItems, kind){
    const leftMap = new Map();
    const rightMap = new Map();

    (Array.isArray(leftItems) ? leftItems : []).forEach(item => {
      const key = normalizeCompareName(item?.name || "");
      if(key) leftMap.set(key, item);
    });

    (Array.isArray(rightItems) ? rightItems : []).forEach(item => {
      const key = normalizeCompareName(item?.name || "");
      if(key) rightMap.set(key, item);
    });

    const allKeys = Array.from(new Set([
      ...leftMap.keys(),
      ...rightMap.keys()
    ])).sort((a, b) => a.localeCompare(b));

    return allKeys.map(key => ({
      key,
      name: leftMap.get(key)?.name || rightMap.get(key)?.name || "Exercise",
      left: leftMap.get(key) || null,
      right: rightMap.get(key) || null,
      kind
    }));
  }

  function openSplitCompareModal(row, compareStrength, compareCardio){
  const leftStrength = Array.isArray(opts?.baseStrengthItems) ? opts.baseStrengthItems : [];
  const leftCardio = Array.isArray(opts?.baseCardioItems) ? opts.baseCardioItems : [];
  const rightStrength = Array.isArray(compareStrength) ? compareStrength : [];
  const rightCardio = Array.isArray(compareCardio) ? compareCardio : [];

  const mergedRows = [
    ...buildCompareRows(leftStrength, rightStrength, "strength"),
    ...buildCompareRows(leftCardio, rightCardio, "cardio")
  ].sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));

  const listHost = el("div", { class:"grid" });

  function compareMetricScore(item, kind){
    if(!item) return null;

    if(kind === "strength"){
      const weight = Number(item?.weight || 0);
      const reps = Number(item?.reps || 0);
      if(weight <= 0) return null;
      return { value: weight, tie: reps, lowerIsBetter: false };
    }

    if(Number.isFinite(item?.pace) && item.pace > 0){
      return { value: Number(item.pace), tie: 0, lowerIsBetter: true };
    }

    const distance = Number(item?.distance || 0);
    if(distance > 0){
      return { value: distance, tie: Number(item?.timeSec || 0), lowerIsBetter: false };
    }

    const timeSec = Number(item?.timeSec || 0);
    if(timeSec > 0){
      return { value: timeSec, tie: 0, lowerIsBetter: false };
    }

    return null;
  }

  function getCompareOutcome(leftItem, rightItem, kind){
    const leftScore = compareMetricScore(leftItem, kind);
    const rightScore = compareMetricScore(rightItem, kind);

    if(!leftScore && !rightScore){
      return { left:"", right:"", winner:"none" };
    }
    if(leftScore && !rightScore){
      return { left:"Lead", right:"Trail", winner:"left" };
    }
    if(!leftScore && rightScore){
      return { left:"Trail", right:"Lead", winner:"right" };
    }

    if(leftScore.lowerIsBetter || rightScore.lowerIsBetter){
      if(leftScore.value < rightScore.value) return { left:"Lead", right:"Trail", winner:"left" };
      if(leftScore.value > rightScore.value) return { left:"Trail", right:"Lead", winner:"right" };
      return { left:"Tied", right:"Tied", winner:"tie" };
    }

    if(leftScore.value > rightScore.value) return { left:"Lead", right:"Trail", winner:"left" };
    if(leftScore.value < rightScore.value) return { left:"Trail", right:"Lead", winner:"right" };

    if((leftScore.tie || 0) > (rightScore.tie || 0)) return { left:"Lead", right:"Trail", winner:"left" };
    if((leftScore.tie || 0) < (rightScore.tie || 0)) return { left:"Trail", right:"Lead", winner:"right" };

    return { left:"Tied", right:"Tied", winner:"tie" };
  }

  function buildSideCard(nameText, valueText, metaText, statusText, isWinner){
    return el("div", {
      class:"card",
      style:[
        "padding:12px",
        isWinner
          ? "border:1px solid rgba(46,204,113,.28)"
          : "border:1px solid rgba(255,255,255,.10)",
        isWinner
          ? "background:linear-gradient(180deg, rgba(46,204,113,.12), rgba(255,255,255,.05))"
          : "background:rgba(255,255,255,.05)",
        "border-radius:16px",
        "min-height:116px"
      ].join(";")
    }, [
      el("div", {
        style:[
          "font-size:11px",
          "font-weight:900",
          "letter-spacing:.22px",
          "opacity:.68",
          "text-transform:uppercase"
        ].join(";")
      }, [nameText]),
      el("div", {
        style:[
          "margin-top:10px",
          "font-size:18px",
          "font-weight:1000",
          "line-height:1.1",
          "overflow:hidden",
          "text-overflow:ellipsis",
          "white-space:nowrap"
        ].join(";")
      }, [valueText]),
      el("div", {
        class:"note",
        style:[
          "margin-top:6px",
          "overflow:hidden",
          "text-overflow:ellipsis",
          "white-space:nowrap"
        ].join(";")
      }, [metaText]),
      el("div", {
        style:[
          "margin-top:10px",
          "display:inline-flex",
          "align-items:center",
          "justify-content:center",
          "padding:4px 8px",
          "border-radius:999px",
          statusText === "Lead"
            ? "background:rgba(46,204,113,.14); border:1px solid rgba(46,204,113,.24); color:rgba(46,204,113,.98);"
            : statusText === "Trail"
              ? "background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.10); color:rgba(255,255,255,.78);"
              : statusText === "Tied"
                ? "background:rgba(124,92,255,.14); border:1px solid rgba(124,92,255,.24); color:rgba(214,204,255,.96);"
                : "background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.08); color:rgba(255,255,255,.62);",
          "font-size:11px",
          "font-weight:900",
          "letter-spacing:.2px",
          "text-transform:uppercase"
        ].join(";")
      }, [statusText || "—"])
    ]);
  }

  function repaintCompare(filterText){
    const q = normalizeCompareName(filterText || "");
    listHost.innerHTML = "";

    const filtered = mergedRows.filter(rowItem =>
      !q || normalizeCompareName(rowItem?.name || "").includes(q)
    );

    if(!filtered.length){
      listHost.appendChild(el("div", {
        class:"note",
        text:"No matching exercises found."
      }));
      return;
    }

    filtered.forEach(rowItem => {
      const leftValue = buildCompareValue(rowItem.left, rowItem.kind);
      const rightValue = buildCompareValue(rowItem.right, rowItem.kind);
      const leftMeta = buildCompareMeta(rowItem.left, rowItem.kind);
      const rightMeta = buildCompareMeta(rowItem.right, rowItem.kind);
      const outcome = getCompareOutcome(rowItem.left, rowItem.right, rowItem.kind);

      listHost.appendChild(el("div", {
        class:"card",
        style:[
          "padding:12px",
          "border:1px solid rgba(255,255,255,.10)",
          "background:rgba(255,255,255,.04)",
          "border-radius:18px"
        ].join(";")
      }, [
        el("div", {
          style:[
            "margin-bottom:10px",
            "font-size:13px",
            "font-weight:1000",
            "line-height:1.15",
            "overflow:hidden",
            "text-overflow:ellipsis",
            "white-space:nowrap"
          ].join(";")
        }, [rowItem.name || "Exercise"]),
        el("div", {
          style:[
            "display:grid",
            "grid-template-columns:minmax(0,1fr) 1px minmax(0,1fr)",
            "gap:12px",
            "align-items:stretch"
          ].join(";")
        }, [
          buildSideCard(
            baseDisplayName,
            leftValue,
            leftMeta,
            outcome.left,
            outcome.winner === "left"
          ),
          el("div", {
            style:"background:rgba(255,255,255,.10); border-radius:999px;"
          }),
          buildSideCard(
            row.displayName || "User",
            rightValue,
            rightMeta,
            outcome.right,
            outcome.winner === "right"
          )
        ])
      ]));
    });
  }

  const compareSearchWrap = el("div", { class:"addExSearch" }, [
    el("div", { class:"ico", text:"🔎" }),
    el("input", {
      type:"text",
      value:"",
      placeholder:"Search compared exercises…",
      onInput: (e) => repaintCompare(e?.target?.value || "")
    })
  ]);

  const compareHeader = el("div", {
    class:"card",
    style:[
      "padding:12px",
      "border:1px solid rgba(255,255,255,.10)",
      "background:rgba(255,255,255,.04)"
    ].join(";")
  }, [
    el("div", {
      style:"display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; align-items:center;"
    }, [
      el("div", {
        style:"font-weight:1000; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
      }, [baseDisplayName]),
      el("div", {
        style:"font-weight:1000; font-size:14px; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
      }, [row.displayName || "User"])
    ])
  ]);

  Modal.open({
    title: `Compare • ${baseDisplayName} vs ${row.displayName}`,
    bodyNode: el("div", { class:"grid" }, [
      compareHeader,
      compareSearchWrap,
      listHost
    ])
  });

  repaintCompare("");
}

  async function runSearch(){
    const q = normalizeUsername(queryInput.value);
    resultsHost.innerHTML = "";

    if(!q){
      resultsHost.appendChild(el("div", { class:"note", text:"Start typing a username." }));
      return;
    }

    const rows = await Social.searchProfilesByUsername(q, { limit: 8 });
    const filtered = rows.filter(r => String(r?.id || "") !== baseUserId);

    if(!filtered.length){
      resultsHost.appendChild(el("div", { class:"note", text:"No users found." }));
      return;
    }

    filtered.forEach(row => {
      resultsHost.appendChild(el("button", {
        type:"button",
        class:"item",
        style:"width:100%; text-align:left; color:inherit;",
        onClick: async () => {
          Modal.close();

          const compareEvents = await Social.fetchProfileWorkoutHighlights(row.id);
          const compareStrength = getSharedStrengthAndCorePRsFromEvents(compareEvents);
          const compareCardio = getSharedCardioPRsFromEvents(compareEvents);

          openSplitCompareModal(row, compareStrength, compareCardio);
        }
      }, [
        el("div", { class:"left" }, [
          el("div", { class:"name", text: row.displayName || "User" }),
          el("div", { class:"meta", text: `@${row.username}` })
        ])
      ]));
    });
  }

  queryInput.addEventListener("input", () => {
    if(searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { runSearch().catch(() => {}); }, 180);
  });

  Modal.open({
    title: "Compare PRs",
    bodyNode: compareBody
  });
}

function openProfileStrengthPRModal(opts = {}){
  const profileUserId = String(opts?.profileUserId || "");
  const profileDisplayName = String(opts?.profileDisplayName || "User");
  const isOwnProfile = !!opts?.isOwnProfile;
  const sharedEvents = Array.isArray(opts?.sharedEvents) ? opts.sharedEvents : [];

  const items = isOwnProfile
    ? getOwnAllStrengthAndCorePRs()
    : getSharedStrengthAndCorePRsFromEvents(sharedEvents);

  const noteText = isOwnProfile
    ? "Browse your weightlifting PRs by top weight or estimated 1RM."
    : `Browse ${profileDisplayName}'s shared weightlifting PRs by top weight or estimated 1RM.`;

  function getStrengthRows(mode){
    return (Array.isArray(items) ? items : [])
      .map(item => {
        const weight = Number(item?.weight || 0);
        const reps = Number(item?.reps || 0);
        const est1RM = (weight > 0 && reps > 0)
          ? Math.round(weight * (1 + (reps / 30)))
          : 0;

        return {
          ...item,
          weight,
          reps,
          est1RM
        };
      })
      .filter(item => item.weight > 0)
      .sort((a, b) => {
        if(mode === "1rm"){
          if(b.est1RM !== a.est1RM) return b.est1RM - a.est1RM;
          if(b.weight !== a.weight) return b.weight - a.weight;
          if(b.reps !== a.reps) return b.reps - a.reps;
          return String(a.name || "").localeCompare(String(b.name || ""));
        }

        if(b.weight !== a.weight) return b.weight - a.weight;
        if(b.reps !== a.reps) return b.reps - a.reps;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
  }

  function getStrengthValueText(item, mode){
    if(mode === "1rm"){
      return item.est1RM > 0 ? `${fmtNum(item.est1RM)} lb` : "—";
    }
    return item.weight > 0 ? `${fmtNum(item.weight)} lb` : "—";
  }

  function getStrengthMetaText(item, mode){
    if(mode === "1rm"){
      return `${item.name || "Exercise"} • from ${fmtNum(item.weight)} × ${item.reps}`;
    }
    return item.reps > 0
      ? `${fmtNum(item.weight)} × ${item.reps}`
      : `${fmtNum(item.weight)} lb`;
  }

  function getStrengthDeltaText(rows, idx, mode){
    if(idx === 0) return "Top result";
    const prev = rows[idx - 1];
    if(!prev) return "";

    if(mode === "1rm"){
      const delta = Number(prev.est1RM || 0) - Number(rows[idx].est1RM || 0);
      return delta > 0 ? `${fmtNum(delta)} lb behind #${idx}` : "";
    }

    const delta = Number(prev.weight || 0) - Number(rows[idx].weight || 0);
    return delta > 0 ? `${fmtNum(delta)} lb behind #${idx}` : "";
  }

  function openStrengthFullListModal(mode){
    const rows = getStrengthRows(mode);
    const titleText = mode === "1rm" ? "All Strength • 1RM" : "All Strength • Weight";

    const list = el("div", { class:"grid" });

    const searchWrap = el("div", { class:"addExSearch" }, [
  el("div", { class:"ico", text:"🔎" }),
  el("input", {
    type:"text",
    placeholder:"Search exercises…",
    onInput: (e) => {
      const q = normName(e.target.value || "");
      list.querySelectorAll("[data-pr-name]").forEach(node => {
        node.style.display = !q || normName(node.dataset.prName || "").includes(q) ? "" : "none";
      });
    }
  })
]);

    if(!rows.length){
      list.appendChild(el("div", {
        class:"note",
        text: isOwnProfile
          ? "No weightlifting PRs from your logs yet."
          : `No shared weightlifting PRs from ${profileDisplayName} yet.`
      }));
    }else{
      rows.forEach((item, idx) => {
        list.appendChild(el("div", {
  class:"card",
  "data-pr-name": item.name || "Exercise",
  style:[
            "padding:12px",
            "border:1px solid rgba(255,255,255,.10)",
            "background:rgba(255,255,255,.05)",
            "border-radius:14px"
          ].join(";")
        }, [
          el("div", {
            style:"display:flex; align-items:flex-start; justify-content:space-between; gap:10px;"
          }, [
            el("div", { style:"min-width:0;" }, [
              el("div", {
                style:"font-size:11px; font-weight:900; opacity:.7; text-transform:uppercase; letter-spacing:.25px;"
              }, [`#${idx + 1}`]),
              el("div", {
                style:"font-size:16px; font-weight:1000; line-height:1.15; margin-top:4px;"
              }, [item.name || "Exercise"]),
              el("div", {
                class:"note",
                style:"margin-top:4px;"
              }, [getStrengthMetaText(item, mode)])
            ]),
            el("div", {
              style:"text-align:right; flex:0 0 auto;"
            }, [
              el("div", {
                style:"font-size:18px; font-weight:1000; line-height:1.1; white-space:nowrap;"
              }, [getStrengthValueText(item, mode)]),
              el("div", {
                style:"margin-top:6px; font-size:11px; opacity:.72; white-space:nowrap;"
              }, [getStrengthDeltaText(rows, idx, mode) || ""])
            ])
          ])
        ]));
      });
    }

    Modal.open({
  title: titleText,
  bodyNode: el("div", { class:"grid" }, [
    el("div", { class:"note", text: noteText }),
    searchWrap,
    list
  ])
});
  }

  const tabs = el("div", {
    style:"display:flex; gap:8px; margin:0 0 10px 0;"
  });

  const content = el("div");

  const weightBtn = el("button", {
    class:"btn",
    style:"flex:1;",
    onClick: () => {
      weightBtn.classList.add("primary");
      rmBtn.classList.remove("primary");
      renderTab("weight");
    }
  }, ["Weight"]);

  const rmBtn = el("button", {
    class:"btn",
    style:"flex:1;",
    onClick: () => {
      rmBtn.classList.add("primary");
      weightBtn.classList.remove("primary");
      renderTab("1rm");
    }
  }, ["1RM"]);

  weightBtn.classList.add("primary");
  tabs.appendChild(weightBtn);
  tabs.appendChild(rmBtn);

  function renderTab(mode){
    const rows = getStrengthRows(mode);
    const top4 = rows.slice(0, 4);

    content.innerHTML = "";

    const summaryCard = el("div", {
      class:"card",
      style:[
        "padding:12px",
        "border:1px solid rgba(255,255,255,.10)",
        "background:rgba(255,255,255,.04)"
      ].join(";")
    });

    if(rows.length){
      const leader = rows[0];
      const leaderValue = getStrengthValueText(leader, mode);
      const exercisesTracked = rows.length;
      const nextGap = rows[1]
        ? (mode === "1rm"
            ? Math.max(0, Number(leader.est1RM || 0) - Number(rows[1].est1RM || 0))
            : Math.max(0, Number(leader.weight || 0) - Number(rows[1].weight || 0)))
        : 0;

      summaryCard.appendChild(el("div", {
        style:"display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px;"
      }, [
        el("div", {}, [
          el("div", { style:"font-size:11px; font-weight:900; opacity:.68; text-transform:uppercase;" }, ["Top Record"]),
          el("div", { style:"font-size:14px; font-weight:1000; line-height:1.15; margin-top:4px;" }, [leader.name || "Exercise"]),
          el("div", { class:"note", style:"margin-top:4px;" }, [leaderValue])
        ]),
        el("div", {}, [
          el("div", { style:"font-size:11px; font-weight:900; opacity:.68; text-transform:uppercase;" }, ["Tracked"]),
          el("div", { style:"font-size:14px; font-weight:1000; line-height:1.15; margin-top:4px;" }, [`${exercisesTracked}`]),
          el("div", { class:"note", style:"margin-top:4px;" }, ["Exercises"])
        ]),
        el("div", {}, [
          el("div", { style:"font-size:11px; font-weight:900; opacity:.68; text-transform:uppercase;" }, ["Lead"]),
          el("div", { style:"font-size:14px; font-weight:1000; line-height:1.15; margin-top:4px;" }, [
            nextGap > 0 ? `${fmtNum(nextGap)} lb` : "—"
          ]),
          el("div", { class:"note", style:"margin-top:4px;" }, [rows[1] ? "Ahead of #2" : "Only record"])
        ])
      ]));
    }else{
      summaryCard.appendChild(el("div", {
        class:"note",
        text: isOwnProfile
          ? "No weightlifting PRs from your logs yet."
          : `No shared weightlifting PRs from ${profileDisplayName} yet.`
      }));
    }

    content.appendChild(summaryCard);

    if(top4.length){
      const cardsWrap = el("div", {
        style:"display:grid; gap:10px; margin-top:10px;"
      });

      top4.forEach((item, idx) => {
        cardsWrap.appendChild(el("div", {
          class:"card",
          style:[
            "padding:12px",
            "border-radius:16px",
            idx === 0
              ? "background:linear-gradient(180deg, rgba(124,92,255,.18), rgba(255,255,255,.05))"
              : "background:rgba(255,255,255,.05)",
            "border:1px solid rgba(255,255,255,.10)"
          ].join(";")
        }, [
          el("div", {
            style:"display:flex; align-items:flex-start; justify-content:space-between; gap:10px;"
          }, [
            el("div", { style:"min-width:0;" }, [
              el("div", {
                style:"display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:999px; background:rgba(255,255,255,.08); font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.25px;"
              }, [idx === 0 ? "🏆 #1" : `#${idx + 1}`]),
              el("div", {
                style:"font-size:16px; font-weight:1000; line-height:1.15; margin-top:10px;"
              }, [item.name || "Exercise"]),
              el("div", {
                class:"note",
                style:"margin-top:5px;"
              }, [getStrengthMetaText(item, mode)]),
              el("div", {
                style:"margin-top:8px; font-size:11px; opacity:.74;"
              }, [getStrengthDeltaText(top4, idx, mode) || ""])
            ]),
            el("div", {
              style:"text-align:right; flex:0 0 auto;"
            }, [
              el("div", {
                style:"font-size:22px; font-weight:1000; line-height:1.05; white-space:nowrap;"
              }, [getStrengthValueText(item, mode)]),
              el("div", {
                style:"margin-top:8px; font-size:11px; opacity:.74; white-space:nowrap;"
              }, [mode === "1rm" ? "Estimated 1RM" : "Top weight"])
            ])
          ])
        ]));
      });

      content.appendChild(cardsWrap);
    }

    if(rows.length > 4){
      content.appendChild(el("div", {
        style:"margin-top:10px;"
      }, [
        el("button", {
          class:"btn",
          style:"width:100%;",
          onClick: () => openStrengthFullListModal(mode)
        }, [`View All (${rows.length})`])
      ]));
    }
  }

  Modal.open({
    title: "Best Strength",
    bodyNode: el("div", { class:"grid" }, [
      el("div", { class:"note", text: noteText }),
      tabs,
      content,
      el("div", { class:"btnrow" }, [
        el("button", {
          class:"btn",
          onClick: () => openCompareProfilePRModal({
            baseUserId: profileUserId,
            baseDisplayName: profileDisplayName,
            baseStrengthItems: items,
            baseCardioItems: isOwnProfile ? getOwnAllCardioPRs() : getSharedCardioPRsFromEvents(sharedEvents)
          })
        }, ["Compare"])
      ])
    ])
  });

  renderTab("weight");
}

function openProfileCardioPRModal(opts = {}){
  const profileUserId = String(opts?.profileUserId || "");
  const profileDisplayName = String(opts?.profileDisplayName || "User");
  const isOwnProfile = !!opts?.isOwnProfile;
  const sharedEvents = Array.isArray(opts?.sharedEvents) ? opts.sharedEvents : [];

  const items = isOwnProfile
    ? getOwnAllCardioPRs()
    : getSharedCardioPRsFromEvents(sharedEvents);

  const noteText = isOwnProfile
    ? "Your cardio bests by pace, distance, and time."
    : `Best known cardio results from ${profileDisplayName}'s shared history.`;

  const tabs = el("div", { class:"seg tabs" }, [
    el("button", {
      type:"button",
      class:"chip active",
      dataset:{ tab:"pace" }
    }, ["Pace"]),
    el("button", {
      type:"button",
      class:"chip",
      dataset:{ tab:"distance" }
    }, ["Distance"]),
    el("button", {
      type:"button",
      class:"chip",
      dataset:{ tab:"time" }
    }, ["Time"])
  ]);

  const tabContent = el("div");

  function getCardioRows(mode){
    return (Array.isArray(items) ? items : [])
      .filter(item => {
        if(mode === "pace") return Number.isFinite(item?.pace) && item.pace > 0;
        if(mode === "distance") return (Number(item?.distance) || 0) > 0;
        if(mode === "time") return (Number(item?.timeSec) || 0) > 0;
        return false;
      })
      .sort((a, b) => {
        if(mode === "pace"){
          const av = Number.isFinite(a?.pace) ? a.pace : Infinity;
          const bv = Number.isFinite(b?.pace) ? b.pace : Infinity;
          if(av !== bv) return av - bv;
          return String(a?.name || "").localeCompare(String(b?.name || ""));
        }
        if(mode === "distance"){
          const av = Number(a?.distance || 0);
          const bv = Number(b?.distance || 0);
          if(bv !== av) return bv - av;
          return String(a?.name || "").localeCompare(String(b?.name || ""));
        }
        const av = Number(a?.timeSec || 0);
        const bv = Number(b?.timeSec || 0);
        if(bv !== av) return bv - av;
        return String(a?.name || "").localeCompare(String(b?.name || ""));
      });
  }

  function getCardioValueText(item, mode){
    if(mode === "pace"){
      return Number.isFinite(item?.pace) && item.pace > 0
        ? fmtPaceSafe(item.pace)
        : "—";
    }
    if(mode === "distance"){
      const distance = Number(item?.distance) || 0;
      return distance > 0 ? `${fmtNum(distance)} mi` : "—";
    }
    const timeSec = Number(item?.timeSec) || 0;
    return timeSec > 0 ? fmtTimeSafe(timeSec) : "—";
  }

  function getCardioMetaText(item, mode){
    const distance = Number(item?.distance) || 0;
    const timeSec = Number(item?.timeSec) || 0;
    const paceText = Number.isFinite(item?.pace) && item.pace > 0 ? fmtPaceSafe(item.pace) : null;

    if(mode === "pace"){
      if(distance > 0 && timeSec > 0) return `${fmtNum(distance)} mi • ${fmtTimeSafe(timeSec)}`;
      if(distance > 0) return `${fmtNum(distance)} mi`;
      if(timeSec > 0) return fmtTimeSafe(timeSec);
      return item?.name || "Cardio";
    }

    if(mode === "distance"){
      if(paceText && timeSec > 0) return `${paceText} • ${fmtTimeSafe(timeSec)}`;
      if(paceText) return paceText;
      if(timeSec > 0) return fmtTimeSafe(timeSec);
      return item?.name || "Cardio";
    }

    if(distance > 0 && paceText) return `${fmtNum(distance)} mi • ${paceText}`;
    if(distance > 0) return `${fmtNum(distance)} mi`;
    if(paceText) return paceText;
    return item?.name || "Cardio";
  }

  function getCardioDeltaText(rows, idx, mode){
    if(idx === 0) return "Top result";
    const prev = rows[idx - 1];
    if(!prev) return "";

    if(mode === "pace"){
      const delta = (Number(rows[idx].pace || 0) > 0 && Number(prev.pace || 0) > 0)
        ? Number(rows[idx].pace || 0) - Number(prev.pace || 0)
        : 0;
      return delta > 0 ? `${fmtPaceSafe(delta)} slower than #${idx}` : "";
    }

    if(mode === "distance"){
      const delta = Number(prev.distance || 0) - Number(rows[idx].distance || 0);
      return delta > 0 ? `${fmtNum(delta)} mi behind #${idx}` : "";
    }

    const delta = Number(prev.timeSec || 0) - Number(rows[idx].timeSec || 0);
    return delta > 0 ? `${fmtTimeSafe(delta)} behind #${idx}` : "";
  }

  function openCardioFullListModal(mode){
    const rows = getCardioRows(mode);
    const titleText =
      mode === "pace" ? "All Cardio • Pace" :
      mode === "distance" ? "All Cardio • Distance" :
      "All Cardio • Time";

    const list = el("div", { class:"grid" });

    const searchWrap = el("div", { class:"addExSearch" }, [
  el("div", { class:"ico", text:"🔎" }),
  el("input", {
    type:"text",
    placeholder:"Search exercises…",
    onInput: (e) => {
      const q = normName(e.target.value || "");
      list.querySelectorAll("[data-pr-name]").forEach(node => {
        node.style.display = !q || normName(node.dataset.prName || "").includes(q) ? "" : "none";
      });
    }
  })
]);

    if(!rows.length){
      const emptyLabel =
        mode === "pace" ? "pace" :
        mode === "distance" ? "distance" :
        "time";

      list.appendChild(el("div", {
        class:"note",
        text:`No cardio ${emptyLabel} results available yet.`
      }));
    }else{
      rows.forEach((item, idx) => {
        list.appendChild(el("div", {
  class:"card",
  "data-pr-name": item.name || "Exercise",
  style:[
            "padding:12px",
            "border:1px solid rgba(255,255,255,.10)",
            "background:rgba(255,255,255,.05)",
            "border-radius:14px"
          ].join(";")
        }, [
          el("div", {
            style:"display:flex; align-items:flex-start; justify-content:space-between; gap:10px;"
          }, [
            el("div", { style:"min-width:0;" }, [
              el("div", {
                style:"font-size:11px; font-weight:900; opacity:.7; text-transform:uppercase; letter-spacing:.25px;"
              }, [`#${idx + 1}`]),
              el("div", {
                style:"font-size:16px; font-weight:1000; line-height:1.15; margin-top:4px;"
              }, [item?.name || "Exercise"]),
              el("div", {
                class:"note",
                style:"margin-top:4px;"
              }, [getCardioMetaText(item, mode)])
            ]),
            el("div", {
              style:"text-align:right; flex:0 0 auto;"
            }, [
              el("div", {
                style:"font-size:18px; font-weight:1000; line-height:1.1; white-space:nowrap;"
              }, [getCardioValueText(item, mode)]),
              el("div", {
                style:"margin-top:6px; font-size:11px; opacity:.72; white-space:nowrap;"
              }, [getCardioDeltaText(rows, idx, mode) || ""])
            ])
          ])
        ]));
      });
    }

    Modal.open({
  title: titleText,
  bodyNode: el("div", { class:"grid" }, [
    el("div", { class:"note", text: noteText }),
    searchWrap,
    list
  ])
});
  }

  function renderCardioTab(mode){
    const rows = getCardioRows(mode);
    const top4 = rows.slice(0, 4);

    tabContent.innerHTML = "";

    const summaryCard = el("div", {
      class:"card",
      style:[
        "padding:12px",
        "border:1px solid rgba(255,255,255,.10)",
        "background:rgba(255,255,255,.04)"
      ].join(";")
    });

    if(rows.length){
      const leader = rows[0];
      let leadValue = "—";
      let leadGap = "—";
      let leadLabel = "Ahead of #2";

      if(mode === "pace"){
        leadValue = getCardioValueText(leader, mode);
        if(rows[1] && Number(rows[1].pace || 0) > 0 && Number(leader.pace || 0) > 0){
          leadGap = fmtPaceSafe(Number(rows[1].pace || 0) - Number(leader.pace || 0));
        }else{
          leadGap = "—";
          leadLabel = "Only record";
        }
      }else if(mode === "distance"){
        leadValue = getCardioValueText(leader, mode);
        if(rows[1]){
          const gap = Number(leader.distance || 0) - Number(rows[1].distance || 0);
          leadGap = gap > 0 ? `${fmtNum(gap)} mi` : "—";
          if(!(gap > 0)) leadLabel = "Only record";
        }else{
          leadLabel = "Only record";
        }
      }else{
        leadValue = getCardioValueText(leader, mode);
        if(rows[1]){
          const gap = Number(leader.timeSec || 0) - Number(rows[1].timeSec || 0);
          leadGap = gap > 0 ? fmtTimeSafe(gap) : "—";
          if(!(gap > 0)) leadLabel = "Only record";
        }else{
          leadLabel = "Only record";
        }
      }

      summaryCard.appendChild(el("div", {
        style:"display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px;"
      }, [
        el("div", {}, [
          el("div", { style:"font-size:11px; font-weight:900; opacity:.68; text-transform:uppercase;" }, ["Top Record"]),
          el("div", { style:"font-size:14px; font-weight:1000; line-height:1.15; margin-top:4px;" }, [leader?.name || "Exercise"]),
          el("div", { class:"note", style:"margin-top:4px;" }, [leadValue])
        ]),
        el("div", {}, [
          el("div", { style:"font-size:11px; font-weight:900; opacity:.68; text-transform:uppercase;" }, ["Tracked"]),
          el("div", { style:"font-size:14px; font-weight:1000; line-height:1.15; margin-top:4px;" }, [`${rows.length}`]),
          el("div", { class:"note", style:"margin-top:4px;" }, ["Exercises"])
        ]),
        el("div", {}, [
          el("div", { style:"font-size:11px; font-weight:900; opacity:.68; text-transform:uppercase;" }, ["Lead"]),
          el("div", { style:"font-size:14px; font-weight:1000; line-height:1.15; margin-top:4px;" }, [leadGap]),
          el("div", { class:"note", style:"margin-top:4px;" }, [leadLabel])
        ])
      ]));
    }else{
      const emptyLabel =
        mode === "pace" ? "pace" :
        mode === "distance" ? "distance" :
        "time";

      summaryCard.appendChild(el("div", {
        class:"note",
        text:`No cardio ${emptyLabel} results available yet.`
      }));
    }

    tabContent.appendChild(summaryCard);

    if(top4.length){
      const cardsWrap = el("div", {
        style:"display:grid; gap:10px; margin-top:10px;"
      });

      top4.forEach((item, idx) => {
        cardsWrap.appendChild(el("div", {
          class:"card",
          style:[
            "padding:12px",
            "border-radius:16px",
            idx === 0
              ? "background:linear-gradient(180deg, rgba(55,214,122,.16), rgba(255,255,255,.05))"
              : "background:rgba(255,255,255,.05)",
            "border:1px solid rgba(255,255,255,.10)"
          ].join(";")
        }, [
          el("div", {
            style:"display:flex; align-items:flex-start; justify-content:space-between; gap:10px;"
          }, [
            el("div", { style:"min-width:0;" }, [
              el("div", {
                style:"display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:999px; background:rgba(255,255,255,.08); font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.25px;"
              }, [idx === 0 ? "🏆 #1" : `#${idx + 1}`]),
              el("div", {
                style:"font-size:16px; font-weight:1000; line-height:1.15; margin-top:10px;"
              }, [item?.name || "Exercise"]),
              el("div", {
                class:"note",
                style:"margin-top:5px;"
              }, [getCardioMetaText(item, mode)]),
              el("div", {
                style:"margin-top:8px; font-size:11px; opacity:.74;"
              }, [getCardioDeltaText(top4, idx, mode) || ""])
            ]),
            el("div", {
              style:"text-align:right; flex:0 0 auto;"
            }, [
              el("div", {
                style:"font-size:22px; font-weight:1000; line-height:1.05; white-space:nowrap;"
              }, [getCardioValueText(item, mode)]),
              el("div", {
                style:"margin-top:8px; font-size:11px; opacity:.74; white-space:nowrap;"
              }, [
                mode === "pace" ? "Best pace" :
                mode === "distance" ? "Longest distance" :
                "Longest time"
              ])
            ])
          ])
        ]));
      });

      tabContent.appendChild(cardsWrap);
    }

    if(rows.length > 4){
      tabContent.appendChild(el("div", {
        style:"margin-top:10px;"
      }, [
        el("button", {
          class:"btn",
          style:"width:100%;",
          onClick: () => openCardioFullListModal(mode)
        }, [`View All (${rows.length})`])
      ]));
    }
  }

  tabs.querySelectorAll("[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      tabs.querySelectorAll("[data-tab]").forEach(node => node.classList.remove("active"));
      btn.classList.add("active");
      renderCardioTab(String(btn.dataset.tab || "pace"));
    });
  });

  Modal.open({
    title: "Best Cardio PRs",
    bodyNode: el("div", { class:"grid" }, [
      el("div", { class:"note", text:noteText }),
      tabs,
      tabContent,
      el("div", { class:"btnrow" }, [
        el("button", {
          class:"btn",
          onClick: () => openCompareProfilePRModal({
            baseUserId: profileUserId,
            baseDisplayName: profileDisplayName,
            baseStrengthItems: isOwnProfile ? getOwnAllStrengthAndCorePRs() : getSharedStrengthAndCorePRsFromEvents(sharedEvents),
            baseCardioItems: items
          })
        }, ["Compare"])
      ])
    ])
  });

  renderCardioTab("pace");
}
              
function openProfileRoutineModal(snapshot, noteText, opts = {}){
  if(!snapshot){
    showToast("No routine available");
    return;
  }

  Modal.open({
    title: snapshot?.name || "Workout Routine",
    bodyNode: buildRoutineModalBodyFromSnapshot(snapshot, noteText, opts)
  });
}

    const metricCard = (label, value, meta, opts={}) => {
      const clickable = typeof opts?.onClick === "function";
      const tag = clickable ? "button" : "div";

      return el(tag, {
        ...(clickable ? { onClick: opts.onClick, type:"button" } : {}),
        style:[
          "display:flex",
          "flex-direction:column",
          "gap:4px",
          "padding:12px",
          "border-radius:14px",
          "border:1px solid rgba(255,255,255,.10)",
          "background:rgba(255,255,255,.05)",
          "min-width:0",
          clickable ? "cursor:pointer" : "",
          clickable ? "text-align:left" : "",
          clickable ? "appearance:none" : "",
          clickable ? "-webkit-appearance:none" : "",
          clickable ? "width:100%" : "",
          clickable ? "color:inherit" : "",
          clickable ? "font:inherit" : "",
          clickable ? "outline:none" : ""
        ].filter(Boolean).join(";")
      }, [
        el("div", {
          style:"font-size:11px; font-weight:900; letter-spacing:.2px; opacity:.72; text-transform:uppercase;"
        }, [label]),
        el("div", {
          style:[
            "font-size:18px",
            "font-weight:1000",
            "line-height:1.1",
            "overflow:hidden",
            "text-overflow:ellipsis",
            "white-space:nowrap"
          ].join(";")
        }, [value]),
        el("div", {
          class:"note",
          style:[
            "margin:0",
            "opacity:.82",
            "overflow:hidden",
            "text-overflow:ellipsis",
            "white-space:nowrap"
          ].join(";")
        }, [meta])
      ]);
    };

        const cards = [
  metricCard(
    "Best Strength PR",
    strengthBest ? `${fmtNum(strengthBest.weight)} × ${strengthBest.reps}` : (sharedLoading ? "Loading…" : "—"),
    strengthBest ? strengthBest.name : (isOwnProfile ? "No weightlifting logs yet" : "No shared strength PR yet"),
    {
      onClick: () => openProfileStrengthPRModal({
        profileUserId,
        profileDisplayName: isOwnProfile ? (state?.profile?.name || "You") : (profileDisplayName || "User"),
        isOwnProfile,
        sharedEvents
      })
    }
  ),
  metricCard(
    "Best Cardio PR",
    cardioBest ? cardioBest.value : (sharedLoading ? "Loading…" : "—"),
    cardioBest ? cardioBest.meta : (isOwnProfile ? "No cardio logs yet" : "No shared cardio PR yet"),
    {
      onClick: () => openProfileCardioPRModal({
        profileUserId,
        profileDisplayName: isOwnProfile ? (state?.profile?.name || "You") : (profileDisplayName || "User"),
        isOwnProfile,
        sharedEvents
      })
    }
  ),
      metricCard(
  "Workout Routine",
  isOwnProfile
    ? (activeRoutine?.name || "No active routine")
    : (sharedRoutineSnapshot?.name || (sharedLoading ? "Loading…" : "Private")),
  isOwnProfile
    ? (activeRoutine ? "Tap to view routine" : "Create or set a routine")
    : (sharedRoutineSnapshot ? "Tap to view public routine" : "Routine not shared"),
  ((isOwnProfile && activeRoutine) || (!isOwnProfile && sharedRoutineSnapshot))
    ? {
        onClick: () => openProfileRoutineModal(
          isOwnProfile ? toOwnRoutineSnapshot(activeRoutine) : sharedRoutineSnapshot,
          isOwnProfile
            ? "Read-only view of your current active routine."
            : "Public routine shared on this profile.",
          {
            ownerName: `${String(isOwnProfile ? (state?.profile?.name || "Your") : (profileDisplayName || "User")).trim() || "User"}'s Routine`,
            canSave: !isOwnProfile,
            saveButtonText: "Save This Routine"
          }
        )
      }
    : {}
)
    ];

            cards.push(metricCard(
      "Consistency",
      consistencyMetric.value,
      consistencyMetric.meta
    ));

    return el("div", { class:"card" }, [
      el("div", {
        style:"display:flex; align-items:center; justify-content:space-between; gap:10px;"
      }, [
        el("div", {}, [
          el("div", { style:"font-size:18px; font-weight:1000; line-height:1.15;" }, ["Highlights"]),
          el("div", {
            class:"note",
            style:"margin:4px 0 0 0; opacity:.82;"
          }, [
            isOwnProfile
              ? "Pulled from all logged workouts and your active routine."
              : "Pulled from shared workout activity on this profile."
          ])
        ])
      ]),
      el("div", { style:"height:12px" }),
      el("div", {
        style:"display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:8px;"
      }, cards)
    ]);
  })() : null;
     
    if(profileHeaderCard){
      root.appendChild(profileHeaderCard);
    }

    root.appendChild(el("div", { class:"card" }, [
  el("div", {
  style:"display:flex; align-items:center; gap:8px;"
}, [
  el("div", { class:"note", text: bodyTitle }),

  el("div", { style:"opacity:.5;" }, ["|"]),

  el("div", {
    class:"note",
    style:"opacity:.75;"
  }, [
    "Last Updated ",
    new Date().toLocaleTimeString([], { hour:"numeric", minute:"2-digit" })
  ])
]),    el("div", { style:"height:10px" }),

    emptyStateNode,

    user && feedList.length ? (() => {
      const timeline = el("div", {
        style:"position:relative; display:flex; flex-direction:column; gap:10px;"
      });

      // Subtle vertical line (timeline feel)
      timeline.appendChild(el("div", {
        style:[
          "position:absolute",
          "left:18px",
          "top:42px",
          "bottom:10px",
          "width:2px",
          "background: rgba(255,255,255,.08)",
          "border-radius: 99px",
          "pointer-events:none"
        ].join(";")
      }));

         // Feed rows

      // Compact timestamp: "Today • 5:14 PM" / "Mon • 6:31 AM"
      function formatFeedWhen(createdAt){
        try{
          if(!createdAt) return { label:"", full:"" };
          const dt = new Date(createdAt);
          if(Number.isNaN(dt.getTime())) return { label:"", full:"" };

          const now = new Date();
          const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
          const diffDays = Math.round((startOf(now) - startOf(dt)) / 86400000);

          const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][dt.getDay()];
          const dayLabel = (diffDays === 0) ? "Today"
            : (diffDays === 1) ? "Yesterday"
            : dow;

          const timeLabel = dt.toLocaleTimeString([], { hour:"numeric", minute:"2-digit" });
          return {
            label: `${dayLabel} • ${timeLabel}`,
            full: dt.toLocaleString()
          };
        }catch(_){
          return { label:"", full:"" };
        }
      }

      function comma(n){
        try{
          const x = Number(n);
          if(!Number.isFinite(x)) return "";
          return x.toLocaleString();
        }catch(_){
          return String(n || "");
        }
      }

      // Builds the second line like:
      // "Pull Day • 5 exercises • PRs: 2 • Vol 12,400"
      // "Incline walk • 30:00 • 2.1 units • Pace 14:17 / unit"
      function buildFeedSummary(ev){
        try{
          const p = ev.payload || {};
          const bits = [];

          if(ev.type === "workout_completed"){
            const d = p.details || null;
            const h = p.highlights || {};

            if(d?.dayLabel) bits.push(String(d.dayLabel));
            else bits.push("Workout");

            if(Number.isFinite(h.exerciseCount) && h.exerciseCount > 0) bits.push(`${h.exerciseCount} exercises`);
            if(Number.isFinite(h.prCount) && h.prCount > 0) bits.push(`PRs: ${h.prCount}`);
            if(Number.isFinite(h.totalVolume) && h.totalVolume > 0) bits.push(`Vol ${comma(h.totalVolume)}`);

            return bits.filter(Boolean).join(" • ");
          }

          if(ev.type === "exercise_logged"){
            const name = p.exerciseName || "Exercise";
            bits.push(String(name));

            const type = String(p.workoutType || "");
            const s = p.summary || {};

            if(type === "cardio"){
              if(Number.isFinite(s.timeSec) && s.timeSec > 0) bits.push(formatTime(s.timeSec));
              if(Number.isFinite(s.distance) && s.distance > 0) bits.push(`${s.distance} units`);
              if(Number.isFinite(s.paceSecPerUnit) && s.paceSecPerUnit > 0) bits.push(`Pace ${formatPace(s.paceSecPerUnit)} / unit`);
              if(Number.isFinite(p.prCount) && p.prCount > 0) bits.push(`PRs: ${p.prCount}`);
              return bits.filter(Boolean).join(" • ");
            }

            // weightlifting / core: keep it compact and useful
            if(Number.isFinite(s.bestWeight) && s.bestWeight > 0) bits.push(`Top ${s.bestWeight}`);
            if(Number.isFinite(s.totalVolume) && s.totalVolume > 0) bits.push(`Vol ${comma(s.totalVolume)}`);
            if(Number.isFinite(p.prCount) && p.prCount > 0) bits.push(`PRs: ${p.prCount}`);

            return bits.filter(Boolean).join(" • ");
          }

          // Fallback for any other event types
          return "";
        }catch(_){
          return "";
        }
      }

      function buildFeedBadges(ev){
  try{
    const p = ev.payload || {};
    const badges = [];

    if(ev.type === "workout_completed"){
      const d = p.details || {};
      const items = Array.isArray(d.items) ? d.items : [];

      const exercisePrBadges = Array.from(new Set(
        items
          .filter(it => {
            const prBadges = Array.isArray(it?.prBadges) ? it.prBadges : [];
            return prBadges.length > 0;
          })
          .map(it => {
            const name = String(it?.name || it?.exerciseName || "").trim();
            return name ? `🏅 ${name} PR` : "";
          })
          .filter(Boolean)
      ));

      if(exercisePrBadges.length){
        badges.push(...exercisePrBadges);
      }else{
        const prCount = Number(p.prCount || p.highlights?.prCount || 0);
        if(Number.isFinite(prCount) && prCount > 0){
          badges.push(`🏅 ${prCount} PR${prCount === 1 ? "" : "s"}`);
        }
      }
    }else{
      const prCount = Number(p.prCount || p.highlights?.prCount || 0);
      if(Number.isFinite(prCount) && prCount > 0){
        badges.push(`🏅 ${prCount} PR${prCount === 1 ? "" : "s"}`);
      }
    }

    if(Array.isArray(p.badges)){
      p.badges.forEach(b => {
        const t = String(b || "").trim();
        if(t) badges.push(t);
      });
    }

    return Array.from(new Set(badges)).slice(0, 6);
  }catch(_){
    return [];
  }
}


function buildWorkoutCardTitle(ev){
  try{
    if(ev?.type !== "workout_completed") return "";

    const p = ev.payload || {};
    const d = p.details || {};

    const routineName = String(
      d?.routineName ||
      p?.routineName ||
      ""
    ).trim();

    const dayLabel = String(
      d?.dayLabel ||
      p?.dayLabel ||
      ""
    ).trim();

    if(routineName && dayLabel) return `${routineName} | ${dayLabel}`;
    if(routineName) return routineName;
    if(dayLabel) return dayLabel;
    return "Workout";
  }catch(_){
    return "Workout";
  }
}

function buildWorkoutHighlightPills(ev){
  try{
    if(ev?.type !== "workout_completed") return [];

    const p = ev.payload || {};
    const d = p.details || {};
    const items = Array.isArray(d?.items) ? d.items : [];
    if(!items.length) return [];

    function cleanNum(v){
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    function fmtWeight(v){
      const n = cleanNum(v);
      if(n === null || n <= 0) return "";
      return (Math.round(n * 10) % 10 === 0) ? `${Math.round(n)} LB` : `${n.toFixed(1)} LB`;
    }

    function fmtDistance(v){
      const n = cleanNum(v);
      if(n === null || n <= 0) return "";
      return String(n);
    }

    function fmtTime(sec){
      const n = cleanNum(sec);
      if(n === null || n <= 0) return "";
      return formatTime(n);
    }

    function fmtPace(sec){
      const n = cleanNum(sec);
      if(n === null || n <= 0) return "";
      const raw = formatPace(n);
      return String(raw || "").replace(/\s*\/\s*unit/i, "/mi");
    }

    function topScore(it){
      try{
        const s = it?.summary || {};
        const type = String(it?.type || "");
        if(type === "weightlifting") return cleanNum(s.bestWeight) || 0;
        if(type === "cardio") return cleanNum(s.distance) || cleanNum(s.timeSec) || 0;
        if(type === "core") return cleanNum(s.totalVolume) || cleanNum(s.timeSec) || cleanNum(s.reps) || 0;
        return cleanNum(s.bestWeight) || cleanNum(s.totalVolume) || cleanNum(s.distance) || 0;
      }catch(_){
        return 0;
      }
    }

   function buildLine(it){
  try{
    const name = String(
      it?.name ||
      it?.exerciseName ||
      it?.nameSnap ||
      "Exercise"
    ).trim();

    const type = String(it?.type || "");
    const s = it?.summary || {};
    const topText = String(it?.topText || "").trim();

    if(type === "weightlifting"){
      // workout_completed items currently persist topText, not summary.bestWeight
      if(topText) return [name, topText].filter(Boolean).join(" - ");

      const weight = fmtWeight(
        s?.bestWeight ??
        it?.bestWeight ??
        it?.weight ??
        it?.topWeight
      );

      return [name, weight].filter(Boolean).join(" - ");
    }

    if(type === "cardio"){
      // prefer the already-built event text first
      if(topText){
        const cleaned = topText
          .replace(/^Dist\s+/i, "")
          .replace(/\s*•\s*Time\s+/i, " - ")
          .replace(/\s*•\s*Pace\s+/i, " - ")
          .trim();

        return [name, cleaned].filter(Boolean).join(" - ");
      }

      const dist = fmtDistance(
        s?.distance ??
        it?.distance
      );

      const time = fmtTime(
        s?.timeSec ??
        it?.timeSec
      );

      const pace = fmtPace(
        s?.paceSecPerUnit ??
        it?.paceSecPerUnit
      );

      return [name, dist, time, pace].filter(Boolean).join(" - ");
    }

    // core / other groups
    if(topText) return [name, topText].filter(Boolean).join(" - ");
    return name;
  }catch(_){
    return "";
  }
}

    const groups = new Map();
    items.forEach(it => {
      const key = String(it?.type || "other");
      if(!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    });

    const groupEntries = Array.from(groups.entries()).map(([type, arr]) => ({
      type,
      items: [...arr].sort((a, b) => topScore(b) - topScore(a))
    }));

    let chosen = [];

    if(groupEntries.length <= 1){
      chosen = (groupEntries[0]?.items || []).slice(0, 2);
    }else if(groupEntries.length === 2){
      chosen = groupEntries.map(g => g.items[0]).filter(Boolean);
    }else{
      chosen = groupEntries.map(g => g.items[0]).filter(Boolean);
    }

    return chosen
      .map(buildLine)
      .filter(Boolean);
  }catch(_){
    return [];
  }
}
      

      function fmtShareInt(n){
        const x = Number(n);
        if(!Number.isFinite(x)) return "0";
        return String(Math.round(x));
      }

      function fmtShareWeight(n){
        const x = Number(n);
        if(!Number.isFinite(x) || x <= 0) return "";
        return (Math.round(x * 10) % 10 === 0) ? String(Math.round(x)) : x.toFixed(1);
      }

      function fmtShareDistance(n){
        const x = Number(n);
        if(!Number.isFinite(x) || x <= 0) return "";
        return x.toFixed(x >= 10 ? 1 : 2);
      }

      function fmtSharePace(sec){
        const x = Number(sec);
        if(!Number.isFinite(x) || x <= 0) return "";
        const whole = Math.floor(x);
        const m = Math.floor(whole / 60);
        const s = whole % 60;
        return `${m}:${String(s).padStart(2, "0")} /MI`;
      }

      function getDayCountLabel(dateISO){
        try{
          const arr = Array.isArray(state?.attendance) ? state.attendance.slice() : [];
          const target = String(dateISO || "").trim();
          if(!target) return "DAY 1";
          const uniq = Array.from(new Set(arr.map(x => String(x || "").trim()).filter(Boolean))).sort();
          const idx = uniq.indexOf(target);
          return `DAY ${idx >= 0 ? (idx + 1) : Math.max(1, uniq.length || 1)}`;
        }catch(_){
          return "DAY 1";
        }
      }

      function getWorkoutItemsFromEvent(ev){
        try{
          const items = ev?.payload?.details?.items;
          return Array.isArray(items) ? items.slice() : [];
        }catch(_){
          return [];
        }
      }

                        function pickWeightliftingPRs(items){
        try{
          return (items || [])
            .filter(it => String(it?.type || "") === "weightlifting")
            .filter(it => Array.isArray(it?.prBadges) && it.prBadges.length)
            .map(it => {
              const topText = String(it?.topText || "").trim();
              const topWeightMatch = topText.match(/(\d+(\.\d+)?)/);
              const topWeight = topWeightMatch ? Number(topWeightMatch[1]) : null;

              let deltaText = "";
              try{
                const badges = Array.isArray(it?.prBadges) ? it.prBadges : [];
                const joined = badges.join(" • ");
                const m = joined.match(/\+?\d+(\.\d+)?/);
                if(m) deltaText = `+${String(m[0]).replace(/^\+/, "")} LB`;
                else if(badges.length) deltaText = String(badges[0] || "").trim().toUpperCase();
              }catch(_){}

              return {
                name: String(it?.name || "TOP LIFT").trim().toUpperCase(),
                weight: topWeight,
                deltaText,
                sourceItem: it
              };
            })
            .filter(pr => pr.name || pr.weight || pr.deltaText)
            .sort((a, b) => {
              const aw = Number(a?.weight || 0);
              const bw = Number(b?.weight || 0);
              if(bw !== aw) return bw - aw;
              return String(a?.name || "").localeCompare(String(b?.name || ""));
            });
        }catch(_){
          return [];
        }
      }

                       function formatSharePrInline(pr, index=null){
        const prefix = Number.isFinite(Number(index)) ? `${Number(index) + 1}. ` : "";
        const name = String(pr?.name || "TOP LIFT").trim().toUpperCase();
        const weight = pr?.weight ? `${fmtShareWeight(pr.weight)} LB` : "";

        let delta = String(pr?.deltaText || "").trim().toUpperCase();
        if(delta){
          const m = delta.match(/^\+?(\d+(\.\d+)?)\s*LB$/i);
          if(m){
            delta = `+${m[1]}LBs`;
          }
        }

        const tail = [weight, delta].filter(Boolean).join(" ");
        return `${prefix}${name}${tail ? ` - ${tail}` : ""}`;
      }

      function pickWeightliftingPR(items){
        const prs = pickWeightliftingPRs(items);
        return prs.length ? prs[0] : null;
      }

            function pickTop3Lifts(items){
        try{
          const wl = (items || [])
            .filter(it => String(it?.type || "") === "weightlifting")
            .map(it => {
              const topText = String(it?.topText || "").trim();
              const m = topText.match(/(\d+(\.\d+)?)/);
              return {
                name: String(it?.name || "LIFT").trim().toUpperCase(),
                weight: m ? Number(m[1]) : 0,
                sourceItem: it
              };
            })
            .filter(it => it.weight > 0)
            .sort((a,b) => b.weight - a.weight)
            .slice(0, 3);

          return wl;
        }catch(_){
          return [];
        }
      }

            function pickCardioMetrics(items){
        try{
          const cardio = (items || []).find(it => String(it?.type || "") === "cardio");
          const s = cardio?.summary || cardio || {};
          const pace = Number(s?.paceSecPerUnit);
          const distance = Number(s?.distance);
          const timeSec = Number(s?.timeSec);

          return {
            pace: Number.isFinite(pace) && pace > 0 ? pace : null,
            distance: Number.isFinite(distance) && distance > 0 ? distance : null,
            timeSec: Number.isFinite(timeSec) && timeSec > 0 ? timeSec : null
          };
        }catch(_){
          return { pace:null, distance:null, timeSec:null };
        }
      }

      function pickPrimaryWorkoutHighlightItem(items, kindOverride=null){
        try{
          const list = Array.isArray(items) ? items : [];
          if(!list.length) return null;

          const hasW = list.some(it => String(it?.type || "") === "weightlifting");
          const hasC = list.some(it => String(it?.type || "") === "cardio");
          const kind = String(
            kindOverride ||
            (hasW && hasC ? "mixed" : (hasC ? "cardio" : "weightlifting"))
          );

          if(kind === "cardio"){
            return list.find(it => String(it?.type || "") === "cardio") || list[0] || null;
          }

          if(kind === "mixed"){
            const pr = pickWeightliftingPR(list);
            if(pr?.sourceItem) return pr.sourceItem;

            const cardio = list.find(it => String(it?.type || "") === "cardio");
            if(cardio) return cardio;

            const topLift = pickTop3Lifts(list)[0];
            if(topLift?.sourceItem) return topLift.sourceItem;

            return list[0] || null;
          }

          const pr = pickWeightliftingPR(list);
          if(pr?.sourceItem) return pr.sourceItem;

          const topLift = pickTop3Lifts(list)[0];
          if(topLift?.sourceItem) return topLift.sourceItem;

          return list[0] || null;
        }catch(_){
          return Array.isArray(items) ? (items[0] || null) : null;
        }
      }

      function classifyShareCard(ev){
        try{
          const items = getWorkoutItemsFromEvent(ev);
          const hasW = items.some(it => String(it?.type || "") === "weightlifting");
          const hasC = items.some(it => String(it?.type || "") === "cardio");

          if(hasW && hasC) return "mixed";
          if(hasC) return "cardio";
          return "weightlifting";
        }catch(_){
          return "weightlifting";
        }
      }

      function buildShareCardLines(ev){
        const p = ev?.payload || {};
        const d = p?.details || {};
        const h = p?.highlights || {};
        const items = getWorkoutItemsFromEvent(ev);
        const kind = classifyShareCard(ev);
        const dayCount = getDayCountLabel(p?.dateISO || d?.dateISO || "");
        const routineName = String(d?.routineName || d?.routine || "").trim().toUpperCase();
        const dayLabel = String(d?.dayLabel || "WORKOUT").trim().toUpperCase();
        const exerciseCount = Number(h?.exerciseCount || 0) || items.length || 0;

        if(kind === "cardio"){
          const c = pickCardioMetrics(items);
          if(!c.distance && !c.pace && !c.timeSec) return null;

          return {
            kind,
            lines: [
              "CARDIO SESSION",
              routineName || "",
              "──────────────",
              "DISTANCE",
              c.distance ? `${fmtShareDistance(c.distance)} MI` : "—",
              "",
              "PACE",
              c.pace ? fmtSharePace(c.pace) : "—",
              "",
              "TIME",
              c.timeSec ? formatTime(c.timeSec) : "—",
              "──────────────",
              `🔥 FASTEST PACE PR | ${dayCount}`
            ].filter(x => x !== null && x !== undefined)
          };
        }

                if(kind === "mixed"){
          const pr = pickWeightliftingPR(items);
          const c = pickCardioMetrics(items);
          if(!pr && !c.distance && !c.pace && !c.timeSec) return null;

          return {
            kind,
            lines: [
              "WORKOUT OVERVIEW",
              routineName || "ROUTINE",
              "──────────────",
              `🔥 ${(pr?.name || "TOP LIFT").toUpperCase()}`,
              pr?.weight ? `${fmtShareWeight(pr.weight)} LB` : "",
              pr?.deltaText || "",
              "",
              "DISTANCE",
              c.distance ? `${fmtShareDistance(c.distance)} MI` : "—",
              "",
              "PACE",
              c.pace ? fmtSharePace(c.pace) : "—",
              "",
              "TIME",
              c.timeSec ? formatTime(c.timeSec) : "—",
              "──────────────",
              `${fmtShareInt(exerciseCount)} ${Number(exerciseCount) === 1 ? "EXERCISE" : "EXERCISES"} | ${dayCount}`
            ].filter(x => x !== null && x !== undefined)
          };
        }

            const prs = pickWeightliftingPRs(items);
        if(prs.length){
          return {
            kind,
            lines: [
              dayLabel || "WORKOUT",
              routineName || "ROUTINE",
              "──────────────",
              prs.length === 1 ? "🔥 NEW PR" : "🔥 NEW PRs",
              ...prs.map((pr, idx) => formatSharePrInline(pr, idx)),
              "──────────────",
              `${fmtShareInt(exerciseCount)} ${Number(exerciseCount) === 1 ? "EXERCISE" : "EXERCISES"} | ${dayCount}`
            ].filter(x => x !== null && x !== undefined && x !== "")
          };
        }

        const top3 = pickTop3Lifts(items);
        if(top3.length){
          const topLiftLabel =
            top3.length === 1 ? "TOP LIFT" :
            top3.length === 2 ? "TOP 2 LIFTS" :
            "TOP 3 LIFTS";

          return {
            kind,
            lines: [
              dayLabel || "WORKOUT",
              routineName || "ROUTINE",
              "──────────────",
              topLiftLabel,
              ...top3.map((it, idx) => `${idx + 1}. ${it.name} - ${fmtShareWeight(it.weight)} LB`),
              "──────────────",
              `${fmtShareInt(exerciseCount)} ${Number(exerciseCount) === 1 ? "EXERCISE" : "EXERCISES"} | ${dayCount}`
            ]
          };
        }

        return null;
      }

      function buildShareCaption(ev, meta={}){
        try{
          const p = ev?.payload || {};
          const d = p?.details || {};
          const h = p?.highlights || {};
          const items = getWorkoutItemsFromEvent(ev);
          const kind = classifyShareCard(ev);
          const dayCount = getDayCountLabel(p?.dateISO || d?.dateISO || "");
          const routineName = String(d?.routineName || d?.routine || "").trim() || "Routine";
          const dayLabel = String(d?.dayLabel || "Workout").trim();
          const exerciseCount = Number(h?.exerciseCount || 0) || items.length || 0;

          if(kind === "cardio"){
            const c = pickCardioMetrics(items);
            return [
              `${dayLabel || "Cardio Session"} • ${routineName}`,
              c.distance ? `Distance: ${fmtShareDistance(c.distance)} mi` : "",
              c.pace ? `Pace: ${fmtSharePace(c.pace)}` : "",
              c.timeSec ? `Time: ${formatTime(c.timeSec)}` : "",
              `${dayCount}`
            ].filter(Boolean).join("\n");
          }

          if(kind === "mixed"){
            const pr = pickWeightliftingPR(items);
            const c = pickCardioMetrics(items);
            return [
              `${dayLabel} • ${routineName}`,
              pr?.name ? `${pr.name}: ${pr.weight ? `${fmtShareWeight(pr.weight)} lb` : ""} ${pr.deltaText || ""}`.trim() : "",
              c.distance ? `Distance: ${fmtShareDistance(c.distance)} mi` : "",
              c.pace ? `Pace: ${fmtSharePace(c.pace)}` : "",
              c.timeSec ? `Time: ${formatTime(c.timeSec)}` : "",
              `${exerciseCount} exercises • ${dayCount}`
            ].filter(Boolean).join("\n");
          }

          const prs = pickWeightliftingPRs(items);
const top3 = pickTop3Lifts(items);

if(prs.length){
  return [
    `${dayLabel} • ${routineName}`,
    prs.length === 1 ? "🔥 NEW PR" : "🔥 NEW PRs",
    ...prs.map((pr, idx) => formatSharePrInline(pr, idx)),
    `${exerciseCount} ${Number(exerciseCount) === 1 ? "exercise" : "exercises"} • ${dayCount}`
  ].filter(Boolean).join("\n");
}

                    const topLiftLabel =
            top3.length === 1 ? "TOP LIFT" :
            top3.length === 2 ? "TOP 2 LIFTS" :
            "TOP 3 LIFTS";

          return [
            `${dayLabel} • ${routineName}`,
            topLiftLabel,
            ...top3.map((it, idx) => `${idx + 1}. ${String(it.name || "").trim().toUpperCase()} - ${fmtShareWeight(it.weight)} LB`),
            `${exerciseCount} ${Number(exerciseCount) === 1 ? "exercise" : "exercises"} • ${dayCount}`
          ].filter(Boolean).join("\n");
        }catch(_){
          return meta?.title || "Workout shared";
        }
      }

      function renderShareCardNode(lines){

  const root = el("div", {
    style: [
      "width:1080px",
      "min-height:1080px",
      "padding:120px 90px",
      "background:transparent",
      "color:#ffffff",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "text-align:center",
      "font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    ].join(";")
  });

  const col = el("div", {
    style:[
      "width:100%",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center"
    ].join(";")
  });

  (lines || []).forEach((line, idx) => {

    const txt = String(line || "");
    const isDivider = txt.includes("────────");
    const isBlank = txt === "";

    const style = [];

    /* blank spacing rows */
    if(isBlank){
      style.push("height:26px");
    }

    /* HEADER (PUSH DAY / CARDIO SESSION) */
    else if(idx === 0){
      style.push(
        "font-size:54px",
        "font-weight:900",
        "letter-spacing:.12em",
        "text-transform:uppercase",
        "line-height:1.05"
      );
    }

    /* ROUTINE NAME */
    else if(idx === 1){
      style.push(
        "font-size:30px",
        "font-weight:800",
        "letter-spacing:.08em",
        "text-transform:uppercase",
        "line-height:1.15",
        "margin-top:14px"
      );
    }

    /* DIVIDER */
    else if(isDivider){
      style.push(
        "font-size:42px",
        "color:rgba(255,255,255,.75)",
        "letter-spacing:.04em",
        "margin:34px 0"
      );
    }

    /* HERO VALUES (205 LB / 3.10 MI / 8:32 /MI) */
    else if(
      /^\d+(\.\d+)? LB$/i.test(txt) ||
      /^\d+(\.\d+)? MI$/i.test(txt) ||
      /^\d+:\d{2} \/MI$/i.test(txt) ||
      /^\d+:\d{2}$/.test(txt)
    ){
      style.push(
        "font-size:110px",
        "font-weight:900",
        "letter-spacing:.02em",
        "line-height:1.05"
      );
    }

    /* LABELS */
    else if(
      /^TOP 3 LIFTS$/i.test(txt) ||
      /^DISTANCE$/i.test(txt) ||
      /^PACE$/i.test(txt) ||
      /^TIME$/i.test(txt) ||
      /^🔥 NEW PRS?$/i.test(txt)
    ){
      style.push(
        "font-size:36px",
        "font-weight:800",
        "letter-spacing:.06em",
        "text-transform:uppercase",
        "line-height:1.2"
      );
    }

    /* PR DELTA */
    else if(/^\+\d+(\.\d+)? LB$/i.test(txt)){
      style.push(
        "font-size:46px",
        "font-weight:800",
        "letter-spacing:.04em",
        "margin-top:6px"
      );
    }

    /* FOOTER */
    else if(/\| DAY \d+$/i.test(txt) || /FASTEST PACE PR/i.test(txt)){
      style.push(
        "font-size:28px",
        "font-weight:800",
        "letter-spacing:.06em",
        "text-transform:uppercase",
        "margin-top:8px"
      );
    }

    /* DEFAULT TEXT */
        else{
      if(/^\d+\.\s/.test(txt)){
        style.push(
          "font-size:30px",
          "font-weight:850",
          "letter-spacing:.03em",
          "text-transform:uppercase",
          "white-space:nowrap",
          "line-height:1.1"
        );
      }else{
        style.push(
          "font-size:34px",
          "font-weight:800",
          "letter-spacing:.04em",
          "text-transform:uppercase"
        );
      }
    }

    col.appendChild(
  el("div", {
    style: style.join(";"),
    text: txt,
    "data-share-line": "1"
  })
);

  });

  root.appendChild(col);

  return root;
}

      async function exportNodeToTransparentPng(node){
        const width = 1080;
        const height = Math.max(1080, Math.ceil(node.scrollHeight || 1080));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if(!ctx) throw new Error("Canvas unavailable");

        ctx.clearRect(0, 0, width, height);

        const host = el("div", {
          style:[
            "position:fixed",
            "left:-99999px",
            "top:0",
            "pointer-events:none",
            "opacity:1",
            "z-index:-1"
          ].join(";")
        }, [node]);

        document.body.appendChild(host);

        try{
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

          const blocks = Array.from(node.querySelectorAll('[data-share-line="1"]'));
          blocks.forEach((n) => {
            const text = String(n.textContent || "");
            if(!text) return;

            const cs = getComputedStyle(n);
            const rect = n.getBoundingClientRect();
            const rootRect = node.getBoundingClientRect();

            const x = rect.left - rootRect.left;
            const y = rect.top - rootRect.top;
            const w = rect.width;
            const h = rect.height;

            const fontSize = Number.parseFloat(cs.fontSize || "16") || 16;
            const fontWeight = cs.fontWeight || "800";
            const lineHeight = Number.parseFloat(cs.lineHeight || String(fontSize * 1.15)) || (fontSize * 1.15);

            ctx.save();
            ctx.fillStyle = "#FFFFFF";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = `${fontWeight} ${fontSize}px Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`;

            const centerX = x + (w / 2);
            const centerY = y + (h / 2);

            if(text.includes("────────")){
              ctx.fillText(text, centerX, centerY);
            }else{
              const parts = text.split("\n");
              parts.forEach((part, i) => {
                ctx.fillText(part, centerX, centerY + ((i - ((parts.length - 1) / 2)) * lineHeight));
              });
            }
            ctx.restore();
          });

          return await new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
              if(blob) resolve(blob);
              else reject(new Error("PNG export failed"));
            }, "image/png");
          });
        } finally {
          try{ host.remove(); }catch(_){}
        }
      }

      async function copyTextSafe(text){
        const value = String(text || "");
        if(!value) throw new Error("Nothing to copy");
        if(navigator.clipboard?.writeText){
          await navigator.clipboard.writeText(value);
          return;
        }
        const ta = el("textarea", {
          style:"position:fixed; left:-99999px; top:0; opacity:0;"
        }, [value]);
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }

      async function sharePngBlob(blob, filename, fallbackText){
        const file = new File([blob], filename || "workout-share.png", { type:"image/png" });

        if(navigator.share && navigator.canShare && navigator.canShare({ files:[file] })){
          await navigator.share({
            files: [file],
            title: "Workout Share",
            text: fallbackText || ""
          });
          return "shared";
        }

        const url = URL.createObjectURL(blob);
        try{
          const a = document.createElement("a");
          a.href = url;
          a.download = filename || "workout-share.png";
          document.body.appendChild(a);
          a.click();
          a.remove();
          return "downloaded";
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 500);
        }
      }

      async function openShareModal(ev, meta={}){
  try{

    // 🔒 Prevent sharing other users' events
    try{
      const currentUserId = Social?.getUser?.()?.id || null;
      if(!ev || !currentUserId || String(ev.actorId) !== String(currentUserId)){
        showToast("You can only share your own workouts.");
        return;
      }
    }catch(_){
      return;
    }

    const card = buildShareCardLines(ev);
    const caption = buildShareCaption(ev, meta);

          const preview = card
            ? renderShareCardNode(card.lines)
            : el("div", { class:"note", text:"This event is from an older build and doesn’t have enough detail for an image card yet." });

          const previewWrap = el("div", {
            style:[
              "display:flex",
              "justify-content:center",
              "align-items:center",
              "padding:16px 0 10px"
            ].join(";")
          }, [
            card
              ? el("div", {
                  style:[
                    "width:220px",
                    "min-height:220px",
                    "border-radius:18px",
                    "border:1px solid rgba(255,255,255,.10)",
                    "background:rgba(255,255,255,.03)",
                    "display:flex",
                    "align-items:center",
                    "justify-content:center",
                    "overflow:hidden"
                  ].join(";")
                }, [
                  (() => {
                    const mini = renderShareCardNode(card.lines);
                    mini.style.width = "520px";
                    mini.style.minHeight = "520px";
                    mini.style.transform = "scale(.38)";
                    mini.style.transformOrigin = "center center";
                    return mini;
                  })()
                ])
              : preview
          ]);

          const body = el("div", {}, [
            previewWrap,
            el("div", { class:"note", text:"Transparent PNG • white lettering • corrected labels" }),
            el("div", { style:"height:12px" }),
            el("div", { class:"btnrow" }, [
              el("button", {
                class:"btn primary",
                onClick: async () => {
                  try{
                    if(!card) throw new Error("This event can only be copied as text");
                    const blob = await exportNodeToTransparentPng(renderShareCardNode(card.lines));
                    const status = await sharePngBlob(blob, "performance-coach-share.png", caption);
                    showToast(status === "shared" ? "Shared" : "PNG downloaded");
                  }catch(e){
                    showToast(e?.message || "Share failed");
                  }
                }
              }, ["Share PNG"]),
              el("button", {
                class:"btn",
                onClick: async () => {
                  try{
                    await copyTextSafe(caption);
                    showToast("Caption copied");
                  }catch(_){
                    showToast("Couldn't copy");
                  }
                }
              }, ["Copy Caption"])
            ])
          ]);

          Modal.open({
            title: "Share Workout",
            bodyNode: body
          });
        }catch(e){
          showToast(e?.message || "Couldn't open share");
        }
      }

      

      (feedList || []).forEach(ev => {
                const p = ev.payload || {};
        const identity = (Social.identityFor && Social.identityFor(
          ev.actorId,
          p.displayName || (String(ev.actorId||"").slice(0,8) + "…")
        )) || {
          displayName: p.displayName || (String(ev.actorId||"").slice(0,8) + "…"),
          username: normalizeUsername(p.username || "")
        };

        const who = identity.displayName;
        const whoHandle = usernameToHandle(identity.username || p.username || "");

        const whenObj = formatFeedWhen(ev.createdAt);
        const when = whenObj.full;
        const whenLine = whenObj.label;

        const title = (ev.type === "exercise_logged")
  ? `${who} logged ${p.exerciseName || "an exercise"}`
  : (ev.type === "workout_completed")
    ? buildWorkoutCardTitle(ev)
    : `${who} posted an event`;

        const summaryLine = buildFeedSummary(ev);
        const badges = buildFeedBadges(ev);
        const highlightPills = buildWorkoutHighlightPills(ev);
        
        function openExerciseHistoryFromFeed(type, exerciseId, exName, onBack){
  try{
    if(!exerciseId) return;
    LogEngine.ensure();

    const entries = LogEngine.entriesForExercise(type, exerciseId); // desc (most recent first)

    function prBadges(pr){
      if(!pr) return "";
      const b = [];
      if(pr.isPRWeight) b.push("PR W");
      if(pr.isPR1RM) b.push("PR 1RM");
      if(pr.isPRVolume) b.push("PR Vol");
      if(pr.isPRPace) b.push("PR Pace");
      return b.join(" • ");
    }

    function formatEntryDetail(type, entry){
      try{
        if(type === "weightlifting"){
          const sets = (entry.sets || []).map(s => `${s.weight || 0}×${s.reps || 0}`).join(" • ");
          const top = entry.summary?.bestWeight ?? "—";
          const vol = entry.summary?.totalVolume ?? "—";
          return `Sets: ${sets || "—"} | Top: ${top} | Vol: ${vol}`;
        }
        if(type === "cardio"){
          const d = entry.summary?.distance ?? "—";
          const t = formatTime(entry.summary?.timeSec ?? 0);
          const p = formatPace(entry.summary?.paceSecPerUnit);
          return `Dist: ${d} | Time: ${t} | Pace: ${p}`;
        }
        if(type === "core"){
          const sets = entry.summary?.sets ?? "—";
          const reps = entry.summary?.reps ?? "—";
          const t = entry.summary?.timeSec ? formatTime(entry.summary.timeSec) : "";
          return `Sets: ${sets} | Reps: ${reps}${t ? ` | Time: ${t}` : ""}`;
        }
      }catch(_){}
      return "";
    }

    const list = el("div", { class:"list" });
    if(!entries.length){
      list.appendChild(el("div", { class:"note", text:"No history yet for this exercise." }));
    }else{
      entries.slice(0, 12).forEach(e => {
        list.appendChild(el("div", { class:"item" }, [
          el("div", { class:"left" }, [
            el("div", { class:"name", text: e.dateISO }),
            el("div", { class:"meta", text: formatEntryDetail(type, e) })
          ]),
          el("div", { class:"actions" }, [
            el("div", { class:"meta", text: prBadges(e.pr) })
          ])
        ]));
      });
    }

    const hasBack = (typeof onBack === "function");
    const backBtn = el("button", {
      class:"btn",
      onClick: () => {
        try{
          if(hasBack) onBack();
          else Modal.close();
        }catch(_){
          Modal.close();
        }
      }
    }, [hasBack ? "Back" : "Close"]);

    Modal.open({
      title: "History",
      center: true,
      bodyNode: el("div", { class:"grid" }, [
        el("div", { class:"note", text: `${exName || "Exercise"} • ${type}` }),
        list,
        el("div", { style:"height:10px" }),
        backBtn
      ])
    });
  }catch(_){}
}

       function openFeedEventModal(ev, title, who, when){
  try{
    const p = ev.payload || {};
    const d = p.details || null;
    const h = p.highlights || {};

    const isWorkout = (ev.type === "workout_completed");
    const dayLabel = (d && d.dayLabel) ? String(d.dayLabel) : (title || (isWorkout ? "Workout" : "Event"));
    const dateISO = (d && d.dateISO) ? String(d.dateISO) : (p.dateISO ? String(p.dateISO) : "");

        const items = (isWorkout && d && Array.isArray(d.items)) ? d.items : [];
    const shareKind = isWorkout ? classifyShareCard(ev) : "weightlifting";

    // KPIs (best-effort; older events may not include highlights)
    const exCount = Number.isFinite(Number(h.exerciseCount)) ? Number(h.exerciseCount) : (items.length || 0);
    const prCount = Number.isFinite(Number(h.prCount)) ? Number(h.prCount) : 0;
    const vol = Number.isFinite(Number(h.totalVolume)) ? Number(h.totalVolume) : null;

    // Use the same priority stack as the share card so both surfaces match
    const highlight = isWorkout ? pickPrimaryWorkoutHighlightItem(items, shareKind) : null;

    // Lifetime display (best-effort) — shared formatter
    function lifetimeLine(it){
      try{
        const L = it?.lifetime || null;
        if(!L) return "";
        if(it.type === "weightlifting"){
          const bw = (L.bestWeight != null) ? `Best W: ${L.bestWeight}` : "";
          const b1 = (L.best1RM != null) ? `Best 1RM: ${L.best1RM}` : "";
          const bv = (L.bestVolume != null) ? `Best Vol: ${L.bestVolume}` : "";
          return [bw, b1, bv].filter(Boolean).join(" • ");
        }
        if(it.type === "cardio"){
          const bp = (L.bestPace != null) ? `Best Pace: ${formatPace(L.bestPace)}` : "";
          const bd = (L.bestDistance != null) ? `Best Dist: ${L.bestDistance}` : "";
          return [bp, bd].filter(Boolean).join(" • ");
        }
        if(it.type === "core"){
          const br = (L.bestReps != null) ? `Best Reps: ${L.bestReps}` : "";
          const bt = (L.bestTimeSec != null) ? `Best Time: ${formatTime(L.bestTimeSec)}` : "";
          return [br, bt].filter(Boolean).join(" • ");
        }
        return "";
      }catch(_){
        return "";
      }
    }

    const pills = el("div", { class:"feedWkPills" }, [
      (exCount ? el("div", { class:"feedWkPill accent" }, [
        el("span", { class:"k", text:"Exercises" }),
        el("span", { class:"v", text:String(exCount) })
      ]) : null),
      (prCount ? el("div", { class:"feedWkPill good" }, [
        el("span", { class:"k", text:"PRs" }),
        el("span", { class:"v", text:String(prCount) })
      ]) : null),
      (vol != null ? el("div", { class:"feedWkPill" }, [
        el("span", { class:"k", text:"Volume" }),
        el("span", { class:"v", text:String(vol) })
      ]) : null)
    ].filter(Boolean));

    const header = el("div", { class:"feedWkHead" }, [
      el("div", { class:"feedWkHeadTop" }, [
        el("div", { class:"feedWkTitleRow" }, [
          el("div", { class:"feedWkAvatar", text: (String(who || "U").trim()[0] || "U").toUpperCase() }),
          el("div", { class:"feedWkTitleBlock" }, [
            el("div", { class:"feedWkTitle", text: dayLabel }),
            el("div", { class:"feedWkSub", text: (when ? `${when} • ${who}` : (who || "")) })
          ])
        ])
      ]),
      pills,

      (isWorkout && highlight)
        ? el("div", { class:"feedWkHighlight" }, [
            el("div", { class:"l" }, [
              el("div", { class:"t" }, [ el("span", { class:"spark" }), "Workout highlight" ]),
              el("div", { class:"n", text: highlight.name || "Exercise" }),
              el("div", { class:"m", text: [highlight.topText || "", lifetimeLine(highlight) || ""].filter(Boolean).join(" • ") })
            ]),
            (Array.isArray(highlight.prBadges) && highlight.prBadges.length)
              ? el("div", { class:"b", text: highlight.prBadges[0] })
              : el("div", { class:"b", text:"Tap for history" })
          ])
        : null
    ].filter(Boolean));

    const list = el("div", { class:"feedWkList" }, []);
    if(isWorkout && items.length){
      items.forEach(it => {
        const rightBadges = [];
        try{
          if(it.topText) rightBadges.push(it.topText);
          if(Array.isArray(it.prBadges) && it.prBadges.length) rightBadges.push(it.prBadges.join(" • "));
        }catch(_){ }

        const life = lifetimeLine(it);

        list.appendChild(el("div", {
          class:"feedWkExCard",
onClick: () => openExerciseHistoryFromFeed(
  it.type,
  it.exerciseId,
  it.name,
  () => openFeedEventModal(ev, title, who, when)
)        }, [
          el("div", { class:"feedWkExTop" }, [
            el("div", { class:"feedWkExLeft" }, [
              el("div", { class:"feedWkExName", text: it.name || "Exercise" }),
              el("div", { class:"feedWkExSub", text: [rightBadges[0] || "", life || ""].filter(Boolean).join(" • ") })
            ]),
            el("div", { class:"feedWkMiniBadges" }, [
              (Array.isArray(it.prBadges) && it.prBadges.length)
                ? el("div", { class:"feedWkMiniBadge pr", text: "PR" })
                : null,
              el("div", { class:"feedWkMiniBadge", text: "History" })
            ].filter(Boolean))
          ]),
          el("div", { class:"feedWkChev", text:"Tap to view history →" })
        ]));
      });
    }else if(isWorkout){
      list.appendChild(el("div", { class:"note", text:"Details aren’t available for this event yet (older build). New events will include full workout details." }));
    }else{
      list.appendChild(el("div", { class:"note", text: when ? `${who} • ${when}` : (who || "") }));
    }

    const body = el("div", { class:"feedWkShell" }, [
      header,
      el("div", { class:"feedWkScroll" }, [
        isWorkout ? el("div", { class:"feedWkSection", text:"Exercises" }) : null,
        list,
        el("div", { style:"height:6px" })
      ].filter(Boolean)),
    ]);

    Modal.open({
      title: isWorkout ? "Workout" : "Event",
      bodyNode: body
    });
  }catch(_){ }
}


        function handleFeedShare(ev, title, who, when){
          try{
            openShareModal(ev, { title, who, when });
          }catch(_){
            showToast("Couldn't open share");
          }
        }
        
        function openCommentsModal({ eventId, title, who }){
  try{
    const me = Social.getUser ? Social.getUser() : null;

    let replyTo = null; // { id, name } or null
    const listHost = el("div", {}, [ el("div", { class:"note", text:"Loading comments…" }) ]);

    // Instagram-style layout (UI only)
    const countPill = el("div", { class:"igCmtCount", text:"" });

    const input = el("textarea", {
      class:"igCmtInput",
      placeholder: "Add a comment…"
    });

    const sendBtn = el("button", {
      class:"igCmtSend",
      onClick: async () => {
        const text = String(input.value || "").trim();
        if(!text) return;

        try{
          sendBtn.disabled = true;
          await Social.addFeedComment({
            eventId,
            body: text,
            parentId: replyTo?.id || null
          });
          input.value = "";
          replyTo = null;
          await repaint();
          renderView(); // update counts on cards
        }catch(e){
          showToast(e?.message || "Could not comment");
        }finally{
          sendBtn.disabled = false;
        }
      }
    }, ["📨"]);

    const replyPill = el("div", { class:"igCmtReply", style:"display:none;" });

    function setReplyTo(next){
      replyTo = next;
      if(replyTo){
        replyPill.style.display = "";
        replyPill.innerHTML = "";
        replyPill.appendChild(el("div", { class:"igCmtReplyInner" }, [
          el("div", { class:"igCmtReplyText", text:`Replying to ${replyTo.name || "User"}` }),
          el("button", { class:"igCmtReplyCancel", onClick: () => setReplyTo(null) }, ["Cancel"])
        ]));
      }else{
        replyPill.style.display = "none";
        replyPill.innerHTML = "";
      }
    }

    function timeAgo(iso){
      try{
        const d = new Date(iso);
        const s = Math.floor((Date.now() - d.getTime())/1000);
        if(s < 60) return `${s}s`;
        const m = Math.floor(s/60);
        if(m < 60) return `${m}m`;
        const h = Math.floor(m/60);
        if(h < 24) return `${h}h`;
        const day = Math.floor(h/24);
        return `${day}d`;
      }catch(_){
        return "";
      }
    }

    function buildThread(comments){
      const byParent = {};
      (comments || []).forEach(c => {
        const p = c.parentId || "__root__";
        (byParent[p] = byParent[p] || []).push(c);
      });

      // ensure stable order (already asc, but keep safe)
      Object.keys(byParent).forEach(k => {
        byParent[k].sort((a,b) => String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
      });

      function renderNode(c, depth){
        const name = Social.nameFor ? (Social.nameFor(c.userId) || "User") : "User";
        const mine = !!(me && c.userId === me.id);

        const initial = (String(name || "U").trim()[0] || "U").toUpperCase();
        const avatar = el("div", { class:"igCmtAvatar", text: initial });

        const actions = el("div", { class:"igCmtActions" }, [
          el("button", { class:"igCmtAct", onClick: () => setReplyTo({ id: c.id, name }) }, ["Reply"]),
          mine ? el("button", {
            class:"igCmtAct danger",
            onClick: async () => {
              try{
                await Social.deleteFeedComment(c.id, eventId);
                await repaint();
                renderView();
              }catch(e){
                showToast(e?.message || "Could not delete");
              }
            }
          }, ["Delete"]) : null
        ].filter(Boolean));

        const row = el("div", {
          class:"igCmtRow" + (depth ? " child" : ""),
          style: depth ? `margin-left:${Math.min(22, depth*12)}px;` : ""
        }, [
          avatar,
          el("div", { class:"igCmtBubble" }, [
            el("div", { class:"igCmtTop" }, [
              el("div", { class:"igCmtName", text: name }),
              el("div", { class:"igCmtTime", text: timeAgo(c.createdAt) })
            ]),
            el("div", { class:"igCmtBody", text: c.body || "" }),
            actions
          ])
        ]);

        const replies = (byParent[c.id] || []).map(r => renderNode(r, depth+1));
        return el("div", { class:"igCmtNode" }, [row, ...replies]);
      }

      const roots = (byParent["__root__"] || []);
      if(!roots.length){
        return el("div", { class:"note", text:"No comments yet. Be the first." });
      }

      return el("div", { class:"igCmtThread" }, roots.map(r => renderNode(r, 0)));
    }

    async function repaint(){
      listHost.innerHTML = "";
      listHost.appendChild(el("div", { class:"note", text:"Loading comments…" }));

      const comments = await Social.fetchFeedComments(eventId);
      try{
        const ids = Array.from(new Set((comments || []).map(c => c.userId).filter(Boolean)));
        if(ids.length && Social.fetchNames) await Social.fetchNames(ids);
      }catch(_){}

      // Keep the visible count current (view should already be refreshed by add/delete)
      try{
        const c = (Social.getCommentCount ? Social.getCommentCount(eventId) : (comments || []).length);
        countPill.textContent = `${c} comment${c === 1 ? "" : "s"}`;
      }catch(_){
        countPill.textContent = "";
      }

      listHost.innerHTML = "";
      listHost.appendChild(buildThread(comments));
    }

    // Quick reactions (optional, UI only)
    const reacts = ["❤️","🔥","💪","😂","👏","😮","😢"].map(ch => {
      return el("button", {
        class:"igCmtReact",
        onClick: () => {
          try{
            const cur = String(input.value || "");
            input.value = (cur && !cur.endsWith(" ")) ? (cur + " " + ch + " ") : (cur + ch + " ");
            input.focus();
          }catch(_){}
        }
      }, [ch]);
    });

    const meta = el("div", { class:"igCmtMeta" }, [
      el("div", { class:"igCmtMetaTitle", text: title || "Event" }),
      el("div", { class:"igCmtMetaWho", text: who || "" })
    ]);

    const body = el("div", { class:"igCmtShell" }, [
      el("div", { class:"igCmtHeader" }, [
        meta,
        countPill
      ]),

      el("div", { class:"igCmtListWrap" }, [
        el("div", { class:"igCmtList" }, [listHost])
      ]),

      el("div", { class:"igCmtComposer" }, [
        replyPill,
        el("div", { class:"igCmtReactRow" }, reacts),
        el("div", { class:"igCmtComposeRow" }, [
          input,
          sendBtn
        ])
      ])
    ]);

    Modal.open({
      title: "Comments",
      bodyNode: body
    });

    repaint();
  }catch(_){}
}

        function openLikesModal({ eventId, title, who }){
  try{
    const listHost = el("div", {}, [ el("div", { class:"note", text:"Loading likes…" }) ]);

    function timeAgo(iso){
      try{
        const d = new Date(iso);
        const s = Math.floor((Date.now() - d.getTime())/1000);
        if(s < 60) return `${s}s`;
        const m = Math.floor(s/60);
        if(m < 60) return `${m}m`;
        const h = Math.floor(m/60);
        if(h < 24) return `${h}h`;
        const day = Math.floor(h/24);
        return `${day}d`;
      }catch(_){
        return "";
      }
    }

    async function repaint(){
      listHost.innerHTML = "";
      listHost.appendChild(el("div", { class:"note", text:"Loading likes…" }));

      let rows = [];
      try{
        rows = (Social.fetchFeedLikers ? await Social.fetchFeedLikers(eventId) : []) || [];
      }catch(_){
        rows = [];
      }

      // Fetch display names for the user ids
      try{
        const ids = Array.from(new Set((rows || []).map(r => r.userId).filter(Boolean)));
        if(ids.length && Social.fetchNames) await Social.fetchNames(ids);
      }catch(_){}

      const likeCount = (Social.getLikeCount ? Social.getLikeCount(eventId) : (rows || []).length) || 0;

      if(!rows.length){
        listHost.innerHTML = "";
        listHost.appendChild(el("div", { class:"note", text:"No likes yet." }));
        return;
      }

      const list = el("div", { style:"display:grid; gap:10px;" });

      rows.forEach(r => {
        const name = Social.nameFor ? (Social.nameFor(r.userId) || "User") : "User";
        const initial = (String(name || "U").trim()[0] || "U").toUpperCase();

        list.appendChild(el("div", {
          style:"display:flex; align-items:center; gap:10px;"
        }, [
          el("div", {
            style:[
              "width:34px",
              "height:34px",
              "border-radius:999px",
              "border:1px solid rgba(255,255,255,.14)",
              "background: rgba(255,255,255,.06)",
              "display:flex",
              "align-items:center",
              "justify-content:center",
              "font-weight:900",
              "letter-spacing:.2px",
              "flex:0 0 auto"
            ].join(";"),
            text: initial
          }),
          el("div", { style:"display:flex; flex-direction:column; min-width:0; flex:1;" }, [
            el("div", { style:"font-weight:850; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;", text: name }),
            el("div", { class:"meta", text: r.createdAt ? timeAgo(r.createdAt) : "" })
          ])
        ]));
      });

      listHost.innerHTML = "";
      listHost.appendChild(list);

      // Keep counts fresh in the feed (optional but safe)
      try{
        if(Social.fetchFeedLikes) await Social.fetchFeedLikes([eventId]);
      }catch(_){}

      // Update modal title count (UI-only)
      try{
        Modal.setTitle ? Modal.setTitle(`Likes (${likeCount})`) : null;
      }catch(_){}
    }

    const header = el("div", { style:"display:flex; flex-direction:column; gap:4px;" }, [
      el("div", { style:"font-weight:900;", text: title || "Event" }),
      el("div", { class:"meta", text: who || "" })
    ]);

    Modal.open({
      title: "Likes",
      bodyNode: el("div", {}, [
        header,
        el("div", { style:"height:10px" }),
        listHost
      ])
    });

    repaint();
  }catch(_){}
}
        
        // Avatar (initial)
        const initial = (String(who || "U").trim()[0] || "U").toUpperCase();
        const avatar = el("div", {
          style:[
            "width:36px",
            "height:36px",
            "border-radius:999px",
            "border:1px solid rgba(255,255,255,.14)",
            "background: rgba(255,255,255,.06)",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "font-weight:900",
            "letter-spacing:.2px",
            "flex:0 0 auto"
          ].join(";"),
          text: initial
        });

  const interactionsNode = (() => {
  const eventId = ev.id;
  const liked = (Social.didILike ? Social.didILike(eventId) : false);
  const likeCount = (Social.getLikeCount ? Social.getLikeCount(eventId) : 0);
  const commentCount = (Social.getCommentCount ? Social.getCommentCount(eventId) : 0);

  // Instagram-style: icon buttons (no pill backgrounds)
  const iconBtnStyle = [
    "background:transparent",
    "border:0",
    "padding:6px 4px",
    "font-size:18px",
    "line-height:1",
    "cursor:pointer",
    "color: rgba(255,255,255,.92)"
  ].join(";");

  const likeBtn = el("button", {
    style: iconBtnStyle + (liked ? " filter:saturate(1.1);" : " opacity:.92;"),
    onClick: async (e) => {
      try{ e && e.stopPropagation && e.stopPropagation(); }catch(_){}
      try{
        await Social.toggleFeedLike(eventId);
      }catch(err){
        showToast(err?.message || "Could not like");
      }
    }
  }, [ liked ? "❤️" : "♡" ]);

  const commentBtn = el("button", {
    style: iconBtnStyle + " opacity:.92;",
    onClick: async (e) => {
      try{ e && e.stopPropagation && e.stopPropagation(); }catch(_){}
      try{
        // Ensure counts are fresh before opening
        if(Social.fetchFeedCommentCounts) await Social.fetchFeedCommentCounts([eventId]);
      }catch(_){}
      openCommentsModal({ eventId, title, who });
    }
  }, ["💬"]);

  const isOwnEvent = (Social?.getUser?.()?.id && String(ev.actorId) === String(Social.getUser().id));

const shareBtn = isOwnEvent ? el("button", {
  style: iconBtnStyle + " opacity:.92;",
  onClick: (e) => {
    try{ e && e.stopPropagation && e.stopPropagation(); }catch(_){}
    try{
      handleFeedShare(ev, title, who, when);
    }catch(_){
      showToast("Couldn't open share");
    }
  }
}, ["📨"]) : null;

  const iconsRow = el("div", {
    style:"display:flex; align-items:center; justify-content:space-between;"
  }, [
    el("div", { style:"display:flex; align-items:center; gap:14px;" }, [
  likeBtn,
  commentBtn,
  shareBtn
].filter(Boolean))
  ]);

  const countsRow = el("div", {
    style:"margin-top:6px; display:flex; gap:14px; font-size:12px; font-weight:850; opacity:.78;"
  }, [
    el("button", {
      style:"background:transparent; border:0; padding:0; font:inherit; color:inherit; cursor:pointer;",
      onClick: async (e) => {
        try{ e && e.stopPropagation && e.stopPropagation(); }catch(_){}
        try{
          // Ensure counts are fresh before opening
          if(Social.fetchFeedLikes) await Social.fetchFeedLikes([eventId]);
        }catch(_){}
        openLikesModal({ eventId, title, who });
      }
    }, [`${likeCount} like${likeCount === 1 ? "" : "s"}`]),

    el("button", {
      style:"background:transparent; border:0; padding:0; font:inherit; color:inherit; cursor:pointer;",
      onClick: async (e) => {
        try{ e && e.stopPropagation && e.stopPropagation(); }catch(_){}
        try{
          if(Social.fetchFeedCommentCounts) await Social.fetchFeedCommentCounts([eventId]);
        }catch(_){}
        openCommentsModal({ eventId, title, who });
      }
    }, [`${commentCount} comment${commentCount === 1 ? "" : "s"}`])
  ]);

  return el("div", {
    style:"margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,.10);"
  }, [iconsRow, countsRow]);
})();

const feedLinkRow = el("div", {
  class:"setLink",
  style:"width:100%;",
  onClick: () => openFeedEventModal(ev, title, who, when)
}, [
  el("div", { class:"l", style:"min-width:0; flex:1; width:100%;" }, [
   el("div", {
  style:"min-width:0; flex:1; display:flex; align-items:flex-start; justify-content:space-between; gap:10px;"
}, [
  el("div", { style:"min-width:0; flex:1;" }, [
    el("div", {
      style:"display:flex; align-items:center; gap:6px; min-width:0; flex-wrap:nowrap;"
    }, [
      el("div", {
        style:"font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:0 1 auto; min-width:0;"
      }, [who]),

      whoHandle ? el("div", {
        style:"opacity:.65; flex:0 0 auto;"
      }, ["|"]) : null,

      whoHandle ? el("div", {
        style:"font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:0 1 auto; min-width:0;"
      }, [whoHandle]) : null
    ].filter(Boolean)),

    el("div", { class:"note", style:"margin:4px 0 0 0;" }, [whenLine])
  ].filter(Boolean)),

  null
].filter(Boolean)),

    el("div", { class:"a", style:"margin-top:8px;", text: title }),


(ev.type === "workout_completed" && highlightPills.length
  ? el("div", {
      style:"margin-top:10px; padding:12px; border-radius:14px; background:linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.03)); border:1px solid rgba(255,255,255,.08); border-left:4px solid #3ddc84; display:flex; flex-direction:column; gap:10px; width:100%; box-sizing:border-box; align-self:stretch;"
    }, [

    el("div", {
  class:"note",
  style:"font-size:12px; font-weight:800; letter-spacing:.25px; opacity:.85;"
}, ["Workout Highlight"]),

      ...highlightPills.map(t => el("div", {
        style:"font-size:14px; font-weight:700; line-height:1.3;"
      }, [t]))

    ])
  : null),

(ev.type !== "workout_completed" && summaryLine)
  ? el("div", { class:"note", style:"margin-top:6px; opacity:.92;", text: summaryLine })
  : null,

(badges.length ? el("div", { class:"pillrow", style:"margin-top:8px; display:flex; flex-wrap:wrap; gap:8px;" },
  badges.map(t => el("div", { class:"pill", style:"padding:4px 8px; font-size:12px; background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.12);", text:t }))
) : null)
  ].filter(Boolean)),
  el("div", { class:"r", style:"opacity:.85;" }, ["→"])
]);

const row = el("div", {
  style:"display:flex; gap:10px; align-items:flex-start;"
}, [
  avatar,
  el("div", { style:"width:100%; display:flex; flex-direction:column;" }, [
    feedLinkRow,
    interactionsNode
  ])
]);
        timeline.appendChild(row);
      });

      return timeline;
    })() : null
  ].filter(Boolean)));
  // Auto-start polling when entering the view
  try{
    if(configured && user) Social.startFeed();
  }catch(_){}

  return root;
},

   
         Settings(){
        // Persist across renders (not saved to Storage)
const ui = UIState.settings || (UIState.settings = {});

// ✅ ensure accordion state exists so taps don’t crash
if(!ui.open || typeof ui.open !== "object") ui.open = {};

// ✅ default: open Profile the first time Settings is visited
if(Object.keys(ui.open).length === 0) ui.open.profile = true;

        const normalize = (s) => (s||"").toString().trim().toLowerCase();

        // Accordion builder
        const makeSection = ({ key, title, subtitle, keywords, bodyNode }) => {
          const q = normalize(ui.q);
          const hay = normalize([title, subtitle, ...(keywords||[])].join(" "));
          const match = !q || hay.includes(q);

          // Auto-open if searching and matched
          const isOpen = !!ui.open?.[key] || (q && match);

          const item = el("div", { class:"accItem", style: match ? "" : "display:none;" });

          const head = el("div", {
            class:"accHead",
          onClick: () => {
  ui.open = ui.open || {};
  ui.open[key] = !ui.open[key];
  renderView();
}
          }, [
            el("div", {}, [
              el("div", { class:"accTitle", text: title }),
              el("div", { class:"accSub", text: subtitle })
            ]),
            el("div", { class:"accCaret", text: isOpen ? "−" : "+" })
          ]);

          const body = el("div", { class:"accBody", style: isOpen ? "" : "display:none;" }, [ bodyNode ]);

          item.appendChild(head);
          item.appendChild(body);
          return item;
        };

        // --- Profile controls ---
        const nameInput = el("input", { type:"text", value: state.profile?.name || "" });
const usernameInput = el("input", {
  type:"text",
  value: state.profile?.username || "",
  autocapitalize:"off",
  autocorrect:"off",
  spellcheck:"false",
  placeholder:"jordand"
});

// ✅ auto-clean username while typing
usernameInput.addEventListener("input", () => {
  usernameInput.value = normalizeUsername(usernameInput.value);
});
const proteinInput = el("input", { type:"number", min:"0", step:"1", value: state.profile?.proteinGoal || 150 });

const weekSelect = el("select", {});
weekSelect.appendChild(el("option", { value:"sun", text:"Sunday" }));
weekSelect.appendChild(el("option", { value:"mon", text:"Monday" }));

const ws = state.profile?.weekStartsOn;
const normalized =
  (ws === 0 || ws === "0" || ws === "sun") ? "sun" :
  (ws === 1 || ws === "1" || ws === "mon") ? "mon" :
  "mon";
weekSelect.value = normalized;

let hideRestDays = !!state.profile?.hideRestDays;
let show3DPreview = (state.profile?.show3DPreview !== false);

let usernameCheckSeq = 0;
let usernameCheckTimer = null;
let lastUsernameChecked = "";
let usernameStatus = "idle"; // idle | checking | available | taken | invalid
let usernameOwnerId = null;

const usernameStatusNode = el("div", {
  class:"meta",
  style:"margin-top:6px; min-height:18px;"
});

function paintUsernameStatus(){
  const current = normalizeUsername(usernameInput.value);
  const mine = String(Social.getUser?.()?.id || "");

  if(!current){
    usernameStatusNode.textContent = "3–20 letters, numbers, or underscores.";
    usernameStatusNode.style.color = "";
    return;
  }

  if(usernameStatus === "invalid"){
    usernameStatusNode.textContent = "Use 3–20 lowercase letters, numbers, or underscores.";
    usernameStatusNode.style.color = "rgba(255,92,122,.95)";
    return;
  }

  if(usernameStatus === "checking"){
    usernameStatusNode.textContent = "Checking availability…";
    usernameStatusNode.style.color = "";
    return;
  }

  if(usernameStatus === "taken"){
    usernameStatusNode.textContent = "Username is already taken.";
    usernameStatusNode.style.color = "rgba(255,92,122,.95)";
    return;
  }

  if(usernameStatus === "available"){
    if(usernameOwnerId && mine && usernameOwnerId === mine){
      usernameStatusNode.textContent = "This is your current username.";
      usernameStatusNode.style.color = "";
      return;
    }
    usernameStatusNode.textContent = "Username is available.";
    usernameStatusNode.style.color = "rgba(46,204,113,.95)";
    return;
  }

  usernameStatusNode.textContent = "Shown in Friends as @username.";
  usernameStatusNode.style.color = "";
}

async function checkUsernameAvailabilityLive(){
  const mine = String(Social.getUser?.()?.id || "");
  const current = normalizeUsername(usernameInput.value);

  // ✅ skip duplicate checks
  if(current === lastUsernameChecked) return;
  lastUsernameChecked = current;
  const seq = ++usernameCheckSeq;

  if(!current){
    usernameStatus = "idle";
    usernameOwnerId = null;
    paintUsernameStatus();
    return;
  }

  if(!isValidUsername(current)){
    usernameStatus = "invalid";
    usernameOwnerId = null;
    paintUsernameStatus();
    return;
  }

  usernameStatus = "checking";
  usernameOwnerId = null;
  paintUsernameStatus();

  const ownerId = await getUsernameOwnerId(current);
  if(seq !== usernameCheckSeq) return;

  usernameOwnerId = ownerId;
  if(ownerId && (!mine || ownerId !== mine)){
    usernameStatus = "taken";
  }else{
    usernameStatus = "available";
  }

  paintUsernameStatus();
}

function queueUsernameAvailabilityCheck(){
  if(usernameCheckTimer) clearTimeout(usernameCheckTimer);
  usernameCheckTimer = setTimeout(() => {
    checkUsernameAvailabilityLive().catch(() => {});
  }, 250);
}

usernameInput.addEventListener("input", () => {
  queueUsernameAvailabilityCheck();
});

queueUsernameAvailabilityCheck();

let trackProtein = Number(state.profile?.proteinGoal || 0) > 0;

const proteinRow = el("div", { class:"setRow" }, [
  el("div", {}, [
    el("div", { style:"font-weight:820;", text:"Daily Protein" }),
    el("div", { class:"meta", text:"Used for Home + Protein tracking" })
  ]),
  proteinInput
]);

const proteinSwitchNode = el("div", {
  class: "switch" + (trackProtein ? " on" : ""),
  onClick: () => {
    trackProtein = !trackProtein;
    proteinSwitchNode.classList.toggle("on", trackProtein);
    proteinRow.style.display = trackProtein ? "" : "none";
  }
});

const trackProteinRow = el("div", { class:"setRow" }, [
  el("div", {}, [
    el("div", { style:"font-weight:820;", text:"Track Protein" }),
    el("div", { class:"meta", text:"Turn off if you don’t want protein goals right now" })
  ]),
  proteinSwitchNode
]);

proteinRow.style.display = trackProtein ? "" : "none";
           
  const hideRestSwitch = el("div", {
  class: "switch" + (hideRestDays ? " on" : ""),
  onClick: () => {
    hideRestDays = !hideRestDays;
    hideRestSwitch.classList.toggle("on", hideRestDays);
  }
});

const show3DSwitch = el("div", {
  class: "switch" + (show3DPreview ? " on" : ""),
  onClick: () => {
    show3DPreview = !show3DPreview;
    show3DSwitch.classList.toggle("on", show3DPreview);
  }
});

async function saveProfile(){
  const nextName = String(nameInput.value || "").trim();
  const nextUsername = normalizeUsername(usernameInput.value);

  if(usernameCheckTimer){
  clearTimeout(usernameCheckTimer);
  usernameCheckTimer = null;
}
await checkUsernameAvailabilityLive();

if(usernameStatus === "taken"){
  showToast("Username already taken");
  return;
}

if(!nextName) throw new Error("Enter your name.");
if(!isValidUsername(nextUsername))
  throw new Error("Username must be 3–20 letters, numbers, or underscores.");

// ✅ prevent duplicate usernames (safe check)
const ownerId = await getUsernameOwnerId(nextUsername);
if(ownerId && (!state.profile?.username || ownerId !== Social.getUser?.()?.id)){
  showToast("Username already taken");
  return;
}

  state.profile = state.profile || {};
  state.profile.name = nextName;
  state.profile.username = nextUsername;

  if(trackProtein){
    state.profile.proteinGoal = Math.max(0, Number(proteinInput.value || 0));
    if(state.profile.proteinGoal <= 0){
      showToast("Enter a protein goal");
      return;
    }
  }else{
    state.profile.proteinGoal = 0;
  }

  state.profile.weekStartsOn = (weekSelect.value === "sun") ? "sun" : "mon";
  state.profile.hideRestDays = !!hideRestDays;
  state.profile.show3DPreview = !!show3DPreview;
  Storage.save(state);

  try{ Social.refreshUser?.(); }catch(_){}
  showToast("Saved");
  renderView();
}

        function openImportFileModal(){
          const input = el("input", { type:"file", accept:"application/json,.json" });
          const err = el("div", { class:"note", style:"display:none; color: rgba(255,92,122,.95);" });

          Modal.open({
            title: "Import from file",
            bodyNode: el("div", {}, [
              el("div", { class:"note", text:"Choose a .json backup file. Import overwrites current data." }),
              el("div", { style:"height:10px" }),
              input,
              err,
              el("div", { style:"height:12px" }),
              el("div", { class:"btnrow" }, [
                el("button", {
                  class:"btn danger",
                  onClick: async () => {
                    err.style.display = "none";
                    try{
                      const f = input.files?.[0];
                      if(!f) throw new Error("Select a JSON file first.");
                      const txt = await f.text();
                      importBackupJSON(txt);
                      Modal.close();
                      navigate("home");
                    }catch(e){
                      err.textContent = e.message || "Import failed.";
                      err.style.display = "block";
                    }
                  }
                }, ["Import (overwrite)"]),
                el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
              ])
            ])
          });
        }

        // --- Section bodies ---
const profileBody = el("div", {}, [
  el("div", { class:"setRow" }, [
    el("div", {}, [
      el("div", { style:"font-weight:820;", text:"Name" }),
      el("div", { class:"meta", text:"Shown on Home" })
    ]),
    nameInput
  ]),

  el("div", { class:"setRow" }, [
  el("div", { style:"min-width:0; flex:1;" }, [
    el("div", { style:"font-weight:820;", text:"Username" }),
    el("div", { class:"meta", text:"Shown in Friends as @username" }),
    usernameStatusNode
  ]),
  usernameInput
]),

  el("div", { class:"setRow" }, [
    el("div", {}, [
      el("div", { style:"font-weight:820;", text:"Week starts on" }),
      el("div", { class:"meta", text:"Affects Home week view" })
    ]),
    weekSelect
  ]),

  proteinRow,
  trackProteinRow,

  el("div", { class:"setRow" }, [
    el("div", {}, [
      el("div", { style:"font-weight:820;", text:"Hide rest days" }),
      el("div", { class:"meta", text:"Keep Home focused on training days" })
    ]),
    hideRestSwitch
  ]),

  el("div", { class:"setRow" }, [
    el("div", {}, [
      el("div", { style:"font-weight:820;", text:"3D Preview" }),
      el("div", { class:"meta", text:"Show/hide the 3D routine card preview on the Routine page" })
    ]),
    show3DSwitch
  ]),

  el("div", { style:"height:12px" }),
  el("div", { class:"btnrow" }, [
    el("button", { class:"btn primary", onClick: async () => {
  try{
    await saveProfile();
  }catch(e){
    Modal.open({
      title:"Save failed",
      bodyNode: el("div", {}, [
        el("div", { class:"note", text: e?.message || "Could not save settings." }),
        el("div", { style:"height:12px" }),
        el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
      ])
    });
  }
}}, ["Save changes"])
  ])
]);

                // ────────────────────────────
        // Routines section (Recovery + Management)
        // ────────────────────────────
        function openCreateRoutineModal(afterCreateRoute=null){
          const body = el("div", {}, [
            el("div", { class:"note", text:"Pick a template to create a routine. This will set it as your active routine." }),
            el("div", { style:"height:12px" })
          ]);

          const list = el("div", { style:"display:grid; gap:10px;" });

          (RoutineTemplates || []).forEach(tpl => {
            list.appendChild(el("div", {
              class:"setLink",
              onClick: () => {
                try{
                  const r = Routines.addFromTemplate(tpl.key, tpl.name);
                  Modal.close();
                  showToast(`Created: ${r.name}`);
                  if(afterCreateRoute) navigate(afterCreateRoute);
                  else renderView();
                }catch(e){
                  Modal.open({
                    title:"Could not create routine",
                    bodyNode: el("div", {}, [
                      el("div", { class:"note", text: e?.message || "Something went wrong while creating a routine." }),
                      el("div", { style:"height:12px" }),
                      el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
                    ])
                  });
                }
              }
            }, [
              el("div", { class:"l" }, [
                el("div", { class:"a", text: tpl.name }),
                el("div", { class:"b", text: tpl.desc || "Template" })
              ]),
              el("div", { style:"opacity:.85", text:"+" })
            ]));
          });

          body.appendChild(list);

          body.appendChild(el("div", { style:"height:14px" }));
          body.appendChild(el("div", { class:"btnrow" }, [
            el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
          ]));

          Modal.open({
            title:"Create routine",
            center:true,
            bodyNode: body
          });
        }

        function openRenameRoutineModal(routine){
          const input = el("input", { type:"text", value: routine?.name || "" });

          Modal.open({
            title:"Rename routine",
            bodyNode: el("div", {}, [
              el("div", { class:"note", text:"Update the routine name." }),
              el("div", { style:"height:10px" }),
              input,
              el("div", { style:"height:12px" }),
              el("div", { class:"btnrow" }, [
                el("button", {
                  class:"btn primary",
                  onClick: () => {
                    try{
                      Routines.rename(routine.id, input.value || "");
                      Modal.close();
                      showToast("Renamed");
                      renderView();
                    }catch(e){
                      showToast(e?.message || "Rename failed");
                    }
                  }
                }, ["Save"]),
                el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
              ])
            ])
          });
        }

        const routinesBody = el("div", {}, [
          el("div", { class:"note", text:"Manage routines here. If you accidentally deleted everything, create a new routine below." }),
          el("div", { style:"height:10px" }),

          el("div", { class:"btnrow" }, [
            el("button", { class:"btn primary", onClick: () => openCreateRoutineModal("routine") }, ["+ Create routine"]),
            el("button", { class:"btn", onClick: () => navigate("routine") }, ["Open Routine"]),
            el("button", { class:"btn", onClick: () => navigate("routine_editor") }, ["Routine Editor"])
          ]),

          el("div", { style:"height:12px" }),

          (() => {
            const all = Routines.getAll() || [];
            const activeId = state.activeRoutineId || null;

            if(all.length === 0){
              return el("div", { class:"note", text:"No routines found. Tap “Create routine” to get started." });
            }

            const list = el("div", { style:"display:grid; gap:10px;" });

            all.forEach(r => {
              const isActive = (r.id === activeId);
              const meta = isActive ? "Active" : "Saved";

              list.appendChild(el("div", { class:"setRow" }, [
                el("div", {}, [
                  el("div", { style:"font-weight:850;", text: r.name || "Routine" }),
                  el("div", { class:"meta", text: meta })
                ]),
                el("div", { class:"btnrow", style:"justify-content:flex-end; flex-wrap:wrap;" }, [

                  el("button", {
                    class:"btn" + (isActive ? " primary" : ""),
                    onClick: async () => {
                      try{
                        await setActiveRoutineAndSync(r.id);
                        showToast("Active routine set");
                        renderView();
                      }catch(e){
                        showToast(e?.message || "Could not set active");
                      }
                    }
                  }, [isActive ? "Active" : "Set active"]),

                  el("button", {
                    class:"btn",
                    onClick: () => openRenameRoutineModal(r)
                  }, ["Rename"]),

                  el("button", {
                    class:"btn",
                    onClick: () => {
                      try{
                        Routines.duplicate(r.id);
                        showToast("Routine duplicated");
                        renderView();
                      }catch(e){
                        showToast(e?.message || "Duplicate failed");
                      }
                    }
                  }, ["Duplicate"]),

                  el("button", {
                    class:"btn danger",
                    onClick: () => {
                      confirmModal({
                        title:"Delete routine",
                        note:`Delete “${r.name || "Routine"}”? This cannot be undone.\n\nTip: Auto Backups can restore if needed.`,
                        confirmText:"Delete",
                        danger:true,
                        onConfirm: () => {
                          try{
                            Routines.remove(r.id);
                            showToast("Routine deleted");
                            renderView();
                          }catch(e){
                            showToast(e?.message || "Delete failed");
                          }
                        }
                      });
                    }
                  }, ["Delete"])
                ])
              ]));
            });

            return list;
          })()
        ]);
           
        const libraryBody = el("div", {}, [
          el("div", { class:"setLink", onClick: () => navigate("exercise_library") }, [
            el("div", { class:"l" }, [
              el("div", { class:"a", text:"Open Exercise Library Manager" }),
              el("div", { class:"b", text:"Add, edit, and delete exercises" })
            ]),
            el("div", { style:"opacity:.8", text:"→" })
          ]),
          el("div", { style:"height:10px" }),
          el("div", { class:"note", text:"Tip: Exercises removed from the library will still display in old logs using the saved name snapshot." })
        ]);

const socialUI = UIState.social || (UIState.social = {});
const socialCfg = Social.getConfig && Social.getConfig();

// local, non-state inputs
socialUI.supabaseUrl = (socialUI.supabaseUrl ?? socialCfg?.url ?? "");
socialUI.supabaseAnon = (socialUI.supabaseAnon ?? socialCfg?.anonKey ?? "");
socialUI.friendId = socialUI.friendId || "";
socialUI.publicRoutineEnabled = !!socialUI.publicRoutineEnabled;
socialUI._publicRoutineLoadedFor = socialUI._publicRoutineLoadedFor || "";
socialUI._publicRoutineLoading = !!socialUI._publicRoutineLoading;


  // ✅ Auto-populate signed-in state after OAuth redirect
// (Without requiring user to click "Save" in Settings)
const _socialConfigured = Social.isConfigured && Social.isConfigured();
const _socialUserNow = Social.getUser && Social.getUser();

// Only attempt once per app session render path
if(_socialConfigured && !_socialUserNow && !socialUI._autoUserRefreshDone){
  socialUI._autoUserRefreshDone = true;

  setTimeout(async () => {
    try{
      await Social.refreshUser();
      if(Social.getUser && Social.getUser()){
        try{ Social.startFeed && Social.startFeed(); }catch(_){}
      }
      renderView();
    }catch(_){}
  }, 0);
}

// If user is present, allow future auto-refresh attempts after sign-out
if(_socialUserNow){
  socialUI._autoUserRefreshDone = false;
}         

           if(_socialConfigured && _socialUserNow && !socialUI._publicRoutineLoading && socialUI._publicRoutineLoadedFor !== String(_socialUserNow.id || "")){
  socialUI._publicRoutineLoading = true;

  setTimeout(async () => {
    try{
      const enabled = await (Social.fetchMyProfileRoutineSetting ? Social.fetchMyProfileRoutineSetting() : Promise.resolve(false));
      socialUI.publicRoutineEnabled = !!enabled;
      socialUI._publicRoutineLoadedFor = String(_socialUserNow.id || "");
    }catch(_){
      socialUI.publicRoutineEnabled = false;
    }finally{
      socialUI._publicRoutineLoading = false;
      try{ renderView(); }catch(_){}
    }
  }, 0);
}

if(!_socialUserNow){
  socialUI._publicRoutineLoadedFor = "";
  socialUI._publicRoutineLoading = false;
  socialUI._pendingWorkoutReplayKey = "";
}

if(_socialConfigured && _socialUserNow){
  const pending = readPendingWorkoutShareIntent();
  const pendingKey = pending
    ? [
        String(pending?.dateISO || ""),
        String(pending?.routineId || ""),
        String(pending?.dayId || ""),
        String(_socialUserNow?.id || "")
      ].join("|")
    : "";

  if(
    pendingKey &&
    !__pendingWorkoutShareReplayBusy &&
    socialUI._pendingWorkoutReplayKey !== pendingKey
  ){
    socialUI._pendingWorkoutReplayKey = pendingKey;

    setTimeout(async () => {
      try{
        const posted = await consumePendingWorkoutShareAfterAuth();
        if(posted){
          try{ renderView(); }catch(_){}
        }else{
          socialUI._pendingWorkoutReplayKey = "";
        }
      }catch(_){
        socialUI._pendingWorkoutReplayKey = "";
      }
    }, 0);
  }
}
           
  const socialBody = el("div", {}, [
  el("div", { style:"height:8px" }),

  el("div", { class:"note", text:"Sign-in" }),
  el("div", { class:"btnrow" }, [
    el("button", {
      class:"btn primary",
      onClick: async () => {
        try{
          await Social.signInWithOAuth("google");
        }catch(e){
          showToast(e?.message || "Google sign-in failed");
        }
      }
    }, ["Continue with Google"]),

    el("button", {
      class:"btn",
      onClick: async () => {
        try{ await Social.signOut(); showToast("Signed out"); renderView(); }catch(_){}
      }
    }, ["Sign out"])
  ]),
      el("div", { style:"height:14px" }),

  el("div", { class:"note", text:"Public active routine" }),

  el("div", { class:"setRow" }, [
    el("div", {}, [
      el("div", { style:"font-weight:820;", text:"Show Workout Routine on profile" }),
      el("div", { class:"meta", text:"Shares your active routine name, days, exercise names, and targets/sets. Updates only when you set a routine active." })
    ]),
    (() => {
      const sw = el("div", {
        class:"switch" + (socialUI.publicRoutineEnabled ? " on" : ""),
        onClick: async () => {
          try{
            const next = !socialUI.publicRoutineEnabled;
            const active = (Routines && typeof Routines.getActive === "function")
              ? Routines.getActive()
              : null;

            await Social.setPublicRoutineEnabled?.(next, next ? active : null);
            socialUI.publicRoutineEnabled = next;
            showToast(next ? "Public routine enabled" : "Public routine hidden");
            renderView();
          }catch(e){
            showToast(e?.message || "Couldn't update routine privacy");
          }
        }
      });
      return sw;
    })()
  ]),
  // ─────────────────────────────
  // Friend code + follow controls (moved here)
  // ─────────────────────────────
  el("div", { style:"height:14px" }),

  el("div", { class:"note", text:"Your friend code" }),
  el("div", { class:"kpi" }, [
    el("div", { class:"big", text: (Social.getUser && Social.getUser()) ? Social.getUser().id : "—" }),
    el("div", { class:"small", text:"Share this code with friends so they can follow you." })
  ]),

  el("div", { style:"height:12px" }),

  el("div", { class:"note", text:"Follow a friend" }),
  el("div", { class:"btnrow" }, [
    el("input", {
      type:"text",
      placeholder:"Paste friend code (user id)",
      value: socialUI.friendId,
      onInput: (e) => { socialUI.friendId = e.target.value || ""; }
    }),
    el("button", {
      class:"btn primary",
      onClick: async () => {
        try{
          await Social.follow(socialUI.friendId);
          socialUI.friendId = "";
          showToast("Following");
          renderView();
        }catch(e){
          showToast(e?.message || "Couldn't follow");
        }
      }
    }, ["Follow"])
  ]),

 el("div", { style:"height:14px" })
]); // close socialBody

const backupBody = el("div", {}, [
  el("div", { class:"note", text:"Export your full app data as JSON. Import will overwrite your current data in this browser." }),

  // ───────────────
  // Export reminder
  // ───────────────
  el("div", { style:"height:10px" }),
  (() => {
    const last = (typeof getLastExportAt === "function") ? getLastExportAt() : 0;
    const never = !last || !Number.isFinite(last);

    const label = never
      ? "Last file backup: Never exported"
      : `Last file backup: ${new Date(last).toLocaleString()}`;

    // ✅ Always show recommendation directly under the label
    const rec = "Recommendation: export a file backup occasionally (helps if iOS clears storage / app is deleted).";

    return el("div", { class:"note", text: `${label}\n${rec}` });
  })(),

  el("div", { style:"height:10px" }),

  // ───────────────
  // Export + Import (same row)
  // ───────────────
  el("div", { class:"btnrow" }, [
    el("button", {
      class:"btn primary",
      onClick: () => {
        try{
          const txt = exportBackupJSON();
          const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
          downloadTextFile(`gym-dashboard-backup_${stamp}.json`, txt);

          // ✅ track export for reminder UI (best-effort)
          try{ if(typeof setLastExportAt === "function") setLastExportAt(Date.now()); }catch(_){}
          showToast("Backup exported");
        }catch(e){
          Modal.open({
            title:"Export failed",
            bodyNode: el("div", {}, [
              el("div", { class:"note", text: e.message || "Could not export backup." }),
              el("div", { style:"height:12px" }),
              el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
            ])
          });
        }
      }
    }, ["Export JSON backup"]),

    // ✅ Import button on the right of Export
    el("button", {
      class:"btn danger",
      onClick: openImportFileModal
    }, ["Import (upload file)"])
  ]),

  // ───────────────
  // Auto backups (rolling snapshots)
  // ───────────────
  el("div", { style:"height:14px" }),
  el("div", {
    class:"note",
    text:"Auto backups (recommended): the app keeps rolling snapshots so you can restore if something breaks."
  }),
  el("div", { style:"height:8px" }),

  el("div", { class:"btnrow" }, [

    // Restore from Auto Backup
    el("button", {
      class:"btn",
      onClick: async () => {
        try{
          if(typeof BackupVault === "undefined" || !BackupVault.list){
            Modal.open({
              title:"Auto backups unavailable",
              bodyNode: el("div", {}, [
                el("div", { class:"note", text:"Auto backups are not enabled in this build." }),
                el("div", { style:"height:12px" }),
                el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
              ])
            });
            return;
          }

          const snapsRaw = await BackupVault.list(BackupVault.KEEP || 20);

          // Safety-net: remove duplicates (same createdAt)
          const seen = new Set();
          const snaps = (snapsRaw || []).filter(s => {
            const key = String(s?.createdAt ?? "");
            if(seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          const container = el("div", {
            style:"max-height:70vh; overflow-y:auto; padding-right:6px;"
          });

          // Sticky Banner (always visible)
          container.appendChild(
            el("div", {
              style:[
                "position:sticky",
                "top:0",
                "z-index:5",
                "padding:10px 0",
                "background:rgba(20,20,30,.65)",
                "backdrop-filter:blur(8px)",
                "-webkit-backdrop-filter:blur(8px)",
                "border-bottom:1px solid rgba(255,255,255,.08)"
              ].join(";")
            }, [
              el("div", { style:"display:flex; align-items:center; gap:8px;" }, [
                el("div", { style:"width:8px;height:8px;border-radius:50%;background:#4CAF50;" }),
                el("div", { style:"font-weight:800;", text:"Auto Backups Active" })
              ]),
              el("div", { class:"note", text:`Keeping: ${BackupVault.KEEP || 20} snapshots` })
            ])
          );

          container.appendChild(el("div", { style:"height:12px" }));

          function normalizeReason(r){
            const rr = String(r || "").toLowerCase();
            if(rr.includes("pre-import")) return "Pre-Import";
            if(rr.includes("pre-reset")) return "Pre-Reset";
            if(rr.includes("manual")) return "Manual";
            return "Auto";
          }

          function badgeColor(label){
            const l = String(label || "").toLowerCase();
            if(l.includes("pre-import")) return "#FFC107";
            if(l.includes("pre-reset")) return "#F44336";
            if(l.includes("manual")) return "#2196F3";
            return "#4CAF50";
          }

          if(!snaps.length){
            container.appendChild(
              el("div", { class:"card" }, [
                el("div", { class:"note", text:"No auto backups found yet." })
              ])
            );
          }else{
            snaps.forEach(snap => {
              const dObj = new Date(Number(snap?.createdAt || Date.now()));
              const dt =
                dObj.toLocaleDateString(undefined, { month:"short", day:"numeric" }) +
                " • " +
                dObj.toLocaleTimeString(undefined, { hour:"2-digit", minute:"2-digit" });

              const c = snap?.counts || {};
              const reasonLabel = normalizeReason(snap?.reason);

              const card = el("div", {
                class:"card",
                style:"cursor:pointer;"
              }, [
                el("div", { style:"display:flex; justify-content:space-between; align-items:center;" }, [
                  el("div", { style:"font-weight:900;", text: dt }),
                  el("div", {
                    style:`
                      padding:4px 10px;
                      border-radius:999px;
                      font-size:11px;
                      font-weight:700;
                      background:${badgeColor(reasonLabel)}22;
                      color:${badgeColor(reasonLabel)};
                      border:1px solid ${badgeColor(reasonLabel)}55;
                    `
                  }, [reasonLabel])
                ]),
                el("div", { style:"height:8px" }),
                el("div", { class:"note", text:`${c.routines||0} Routines • ${c.workouts||0} Workouts` }),
                el("div", { class:"note", text:`${c.protein||0} Protein • ${c.attendance||0} Attendance` })
              ]);

              card.onclick = () => {
                confirmModal({
                  title:"Restore Snapshot?",
                  note:`Restore snapshot from:\n${dt}\n\nThis will overwrite your current data.`,
                  confirmText:"Restore",
                  danger:true,
                  onConfirm: () => {
                    try{
                      state = migrateState(snap.state);
                      Storage.save(state);
                      showToast("Snapshot restored");
                      Modal.close();
                      navigate("home");
                    }catch(err){
                      Modal.open({
                        title:"Restore failed",
                        bodyNode: el("div", {}, [
                          el("div", { class:"note", text: err?.message || "Could not restore snapshot." }),
                          el("div", { style:"height:12px" }),
                          el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
                        ])
                      });
                    }
                  }
                });
              };

              container.appendChild(card);
              container.appendChild(el("div", { style:"height:10px" }));
            });
          }

          Modal.open({
            title:"Restore from Auto Backup",
            bodyNode: container
          });

        }catch(e){
          Modal.open({
            title:"Could not load auto backups",
            bodyNode: el("div", {}, [
              el("div", { class:"note", text: e?.message || "Could not read auto backups." }),
              el("div", { style:"height:12px" }),
              el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
            ])
          });
        }
      }
    }, ["Restore from Auto Backup"]),

    // Clear Auto Backups
    el("button", {
      class:"btn danger",
      onClick: () => {
        confirmModal({
          title:"Clear auto backups",
          note:"Deletes ALL auto backup snapshots stored on this device. This cannot be undone.",
          confirmText:"Clear auto backups",
          danger:true,
          onConfirm: async () => {
            try{
              if(typeof BackupVault !== "undefined" && BackupVault.clear){
                await BackupVault.clear();
                showToast("Auto backups cleared");
              }else{
                showToast("Auto backups not available");
              }
            }catch(_){
              showToast("Could not clear auto backups");
            }
          }
        });
      }
    }, ["Clear Auto Backups"])

  ])
]);
           
        const dataBody = el("div", {}, [
          el("div", { class:"note", text:"Repair tools and targeted clears." }),
          el("div", { style:"height:10px" }),

          el("div", { class:"setLink", onClick: () => {
            confirmModal({
              title: "Repair workout logs",
              note: "Removes duplicate log entries (same date + routine exercise). Keeps the most recent.",
              confirmText: "Repair logs",
              danger: true,
              onConfirm: () => {
                const seen = new Map();
                const cleaned = [];
                (state.logs?.workouts || [])
                  .slice()
                  .sort((a,b)=> (b.createdAt||0) - (a.createdAt||0))
                  .forEach(e => {
                    const key = `${e.dateISO}_${e.routineExerciseId}`;
                    if(!seen.has(key)){
                      seen.set(key,true);
                      cleaned.push(e);
                    }
                  });
                state.logs.workouts = cleaned;
                Storage.save(state);
                showToast("Duplicates removed");
              }
            });
          }}, [
            el("div", { class:"l" }, [
              el("div", { class:"a", text:"Repair workout logs" }),
              el("div", { class:"b", text:"Remove duplicates (keeps most recent)" })
            ]),
            el("div", { style:"opacity:.8", text:"→" })
          ]),

          el("div", { style:"height:10px" }),
          el("div", { class:"note", text:"Clear specific data:" }),
          el("div", { style:"height:8px" }),

          el("div", { class:"btnrow" }, [
            el("button", {
              class:"btn danger",
              onClick: () => confirmModal({
                title: "Clear workout logs",
                note: "Deletes all workout logs. This cannot be undone.",
                confirmText: "Clear workouts",
                danger: true,
                onConfirm: () => { state.logs.workouts = []; Storage.save(state); showToast("Workout logs cleared"); }
              })
            }, ["Clear workouts"]),
            el("button", {
              class:"btn danger",
              onClick: () => confirmModal({
                title: "Clear weight logs",
                note: "Deletes all weigh-ins. This cannot be undone.",
                confirmText: "Clear weight",
                danger: true,
                onConfirm: () => { state.logs.weight = []; Storage.save(state); showToast("Weight logs cleared"); }
              })
            }, ["Clear weight"])
          ]),
          el("div", { style:"height:10px" }),
          el("div", { class:"btnrow" }, [
            el("button", {
              class:"btn danger",
              onClick: () => confirmModal({
                title: "Clear protein logs",
                note: "Deletes all protein entries. This cannot be undone.",
                confirmText: "Clear protein",
                danger: true,
                onConfirm: () => { state.logs.protein = []; Storage.save(state); showToast("Protein logs cleared"); }
              })
            }, ["Clear protein"]),
            el("button", {
              class:"btn danger",
              onClick: () => confirmModal({
                title: "Clear attendance",
                note: "Deletes attendance history. This cannot be undone.",
                confirmText: "Clear attendance",
                danger: true,
                onConfirm: () => { state.attendance = []; Storage.save(state); showToast("Attendance cleared"); }
              })
            }, ["Clear attendance"])
          ])
        ]);

        const debugBody = el("div", {}, [
          el("div", { class:"note", text:`Schema v${state.schemaVersion} • Approx storage: ${bytesToNice(appStorageBytes())}` }),
          el("div", { style:"height:10px" }),
          el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn danger",
            onClick: () => {
              Modal.open({
                title: "Reset local data",
                bodyNode: el("div", {}, [
                  el("div", { class:"note", text:"This clears everything saved in this browser for the app." }),
                  el("div", { style:"height:12px" }),
                  el("div", { class:"btnrow" }, [
                    el("button", {
                      class:"btn danger",
                      onClick: () => {
                        Storage.reset();
                        state = Storage.load();
                        Modal.close();
                        navigate("home");
                      }
                    }, ["Reset"]),
                    el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
                  ])
                ])
              });
            }
          }, ["Reset local data"])
        ])
        ]);
      // --- Support / Report an issue (Formspree) ---
const supportForm = el("form", {
  action: "https://formspree.io/f/xreakwzg",
  method: "POST"
}, [
  el("label", {}, [
    el("span", { text:"Type" }),
    el("select", { class:"glassSelect", name:"issue_type" }, [
      el("option", { value:"bug", text:"Bug" }),
      el("option", { value:"feature", text:"Feature request" }),
      el("option", { value:"data", text:"Data issue" }),
      el("option", { value:"other", text:"Other" })
    ])
  ]),

  el("div", { style:"height:10px" }),

  el("label", {}, [
    el("span", { text:"Your email (optional)" }),
    el("input", { name:"email", type:"email", placeholder:"name@email.com", autocomplete:"email" })
  ]),

  el("div", { style:"height:10px" }),

  el("label", {}, [
    el("span", { text:"Subject" }),
    el("input", { name:"subject", type:"text", placeholder:"Short summary" })
  ]),

  el("div", { style:"height:10px" }),

  el("label", {}, [
    el("span", { text:"Message" }),
    el("textarea", {
      name:"message",
      placeholder:"What happened? Steps to reproduce? What did you expect?",
      style:"width:100%; min-height:160px; border-radius:14px; padding:12px; border:1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: rgba(255,255,255,.92); font-size:12px; outline:none; resize:vertical;"
    })
  ]),

  el("div", { style:"height:12px" }),

  el("div", { class:"btnrow" }, [
    el("button", { class:"btn primary", type:"submit" }, ["Send report"]),
    el("button", {
      class:"btn",
      type:"button",
      onClick: (ev) => {
        const form = ev.target.closest("form");
        if(form) form.reset();
      }
    }, ["Clear"])
  ])
]);

// ✅ Attach submit handler using the real DOM API (reliable)
supportForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const form = e.currentTarget;
  const fd = new FormData(form);

  // Auto-attach diagnostics (safe + helpful)
  fd.set("app_version_latest", String(__latestVersion || ""));
  fd.set("app_version_applied", String(__appliedVersion || ""));
  fd.set("route", String(getCurrentRoute && getCurrentRoute() || ""));
  fd.set("user_agent", String(navigator.userAgent || ""));
  fd.set("ts", new Date().toISOString());

  try{
    const r = await fetch(form.action, {
      method: "POST",
      body: fd,
      headers: { "Accept": "application/json" }
    });

    if(r.ok){
      form.reset();
      showToast("Sent — thank you!");
    }else{
      let msg = "Could not send.";
      try{
        const j = await r.json();
        if(j?.errors?.[0]?.message) msg = j.errors[0].message;
      }catch(_){}
      showToast(msg);
    }
  }catch(_){
    showToast("Network error — try again.");
  }
});

const supportBody = el("div", {}, [
  el("div", { class:"note", text:"Report a bug or request a feature. This sends a message directly to the developer." }),
  el("div", { style:"height:10px" }),
  supportForm
]);
        // --- Search Bar ---
        const searchInput = el("input", {
          type:"text",
          placeholder:"Search settings…",
          value: ui.q || ""
        });
        searchInput.addEventListener("input", (e) => {
          ui.q = e.target.value || "";
          renderView();
        });

const root = el("div", { class:"settingsWrap" }, [
  el("div", { class:"settingsSearch" }, [
    el("div", { class:"ico", text:"🔎" }),
    searchInput
  ]),
  el("div", { class:"accList" }, [
    makeSection({
      key:"profile",
      title:"Profile & Preferences",
      subtitle:"Name, protein goal, week start, rest days",
      keywords:["name","protein","week","rest","goal"],
      bodyNode: profileBody
    }),
      makeSection({
      key:"routines",
      title:"Routines",
      subtitle:"Create, set active, rename, duplicate, delete",
      keywords:["routine","routines","template","active","edit","duplicate","delete","create"],
      bodyNode: routinesBody
    }),
    makeSection({
      key:"library",
      title:"Exercise Library",
      subtitle:"Manage exercises (add/edit/delete)",
      keywords:["exercise","library","weightlifting","cardio","core"],
      bodyNode: libraryBody
    }),
    makeSection({
    key:"social",
    title:"Friends (Beta)",
    subtitle:"Connect Supabase + follow friends + feed",
    keywords:["friends","social","supabase","feed","follow","events"],
    bodyNode: socialBody
    }),
    makeSection({
    key:"backup",
    title:"Backup / About",
    subtitle:"Backups, restore, storage info, reset",
    keywords:["backup","import","export","json","restore","about","reset","storage","schema"],
    bodyNode: el("div", {}, [
      backupBody,
      el("div", { style:"height:14px" }),
      debugBody
    ])
  }),
      makeSection({
        key:"support",
        title:"Support / Report an issue",
        subtitle:"Send feedback to the developer",
        keywords:["support","issue","bug","feedback","feature","help","report"],
        bodyNode: supportBody
      })
    ])
  ]);
        return root;
      }
    }; // ✅ end Views object
    Views.ExerciseLibraryManager = function(){
  ExerciseLibrary.ensureSeeded();

  const ui = UIState.libraryManage;
  const root = el("div", { class:"grid" });

  // Header
  root.appendChild(el("div", { class:"card" }, [
    el("div", { class:"kpi" }, [
      el("div", { class:"big", text:"Exercise Library" }),
      el("div", { class:"small", text:"Search, add, edit, or delete exercises." })
    ]),
    el("div", { style:"height:10px" }),
    el("div", { class:"btnrow" }, [
      el("button", { class:"btn", onClick: () => navigate("settings") }, ["← Settings"]),
      el("button", { class:"btn primary", onClick: () => openAddEditModal(null) }, ["+ Add Exercise"])
    ])
  ]));

  // Controls
  const controls = el("div", { class:"card" }, [ el("h2", { text:"Filters" }) ]);

  const typeChips = el("div", { class:"chips" });
  ExerciseLibrary.typeKeys.forEach(t => {
    typeChips.appendChild(el("div", {
      class:"chip" + (ui.type === t ? " on" : ""),
      onClick: () => { ui.type = t; ui.equipment = "all"; renderView(); }
    }, [ExerciseLibrary.typeLabel(t)]));
  });

  const search = el("input", { type:"text", placeholder:"Search exercises…", value: ui.q || "" });
  search.addEventListener("input", (e) => { ui.q = e.target.value || ""; renderList(); });

  const equipSelect = el("select", {});
  equipSelect.appendChild(el("option", { value:"all", text:"All equipment" }));
  const equipSet = new Set();
  ExerciseLibrary.list(ui.type).forEach(x => { if(x.equipment) equipSet.add(x.equipment); });
  Array.from(equipSet).sort().forEach(eq => equipSelect.appendChild(el("option", { value:eq, text:eq })));
  equipSelect.value = ui.equipment || "all";
  equipSelect.addEventListener("change", (e) => { ui.equipment = e.target.value || "all"; renderList(); });

  controls.appendChild(el("div", { class:"note", text:"Type" }));
  controls.appendChild(typeChips);
  controls.appendChild(el("div", { style:"height:10px" }));
  controls.appendChild(el("div", { class:"row2" }, [
    el("label", {}, [ el("span", { text:"Search" }), search ]),
    el("label", {}, [ el("span", { text:"Equipment" }), equipSelect ])
  ]));

  root.appendChild(controls);

  // List
  const listCard = el("div", { class:"card" }, [
    el("h2", { text:"Exercises" }),
    el("div", { class:"note", text:"Tip: Deleting an exercise will not erase old logs (they use the saved name snapshot)." })
  ]);
const listHost = el("div", { style:"display:flex; flex-direction:column; gap:10px; margin-top:10px;" });

function renderList(){
  listHost.innerHTML = "";

  const q = (ui.q || "").trim().toLowerCase();
  const eq = ui.equipment || "all";

  const items = ExerciseLibrary.list(ui.type)
    .filter(x => !q || (x.name || "").toLowerCase().includes(q))
    .filter(x => eq === "all" || (x.equipment || "") === eq)
    .sort((a,b) => (a.name || "").localeCompare(b.name || ""));

  if(items.length === 0){
    listHost.appendChild(el("div", { class:"note", text:"No exercises match your filters." }));
  } else {
    items.forEach(ex => {
      const sub = (() => {
        if(ui.type === "weightlifting"){
          const parts = [];
          if(ex.primaryMuscle) parts.push(ex.primaryMuscle);
          if(ex.equipment) parts.push(ex.equipment);
          if(typeof ex.isCompound === "boolean") parts.push(ex.isCompound ? "compound" : "isolation");
          return parts.join(" • ") || "—";
        }
        if(ui.type === "cardio"){
          const parts = [];
          if(ex.modality) parts.push(ex.modality);
          if(ex.supportsIncline) parts.push("incline");
          return parts.join(" • ") || "—";
        }
        const parts = [];
        if(ex.equipment) parts.push(ex.equipment);
        return parts.join(" • ") || "—";
      })();

      listHost.appendChild(el("div", { class:"item" }, [
        el("div", { style:"font-weight:860; letter-spacing:.1px;", text: ex.name }),
        el("div", { class:"meta", text: sub }),
        el("div", { style:"height:10px" }),
        el("div", { class:"btnrow" }, [
          el("button", { class:"btn", onClick: () => openAddEditModal(ex) }, ["Edit"]),
          el("button", { class:"btn danger", onClick: () => attemptDelete(ex) }, ["Delete"])
        ])
      ]));
    });
  }
}

// ✅ initial paint
renderList();

listCard.appendChild(listHost);
root.appendChild(listCard);

  function countRoutineRefs(type, exerciseId){
    let count = 0;
    (state.routines || []).forEach(r => {
      (r.days || []).forEach(d => {
        (d.exercises || []).forEach(rx => {
          if(rx.type === type && rx.exerciseId === exerciseId) count++;
        });
      });
    });
    return count;
  }

  function attemptDelete(ex){
    const refs = countRoutineRefs(ui.type, ex.id);
    const note = refs
      ? `This exercise is currently used in ${refs} routine slot(s). Deleting it will remove it from those routines.`
      : "Delete this exercise from your library?";

    confirmModal({
      title: "Delete exercise",
      note,
      confirmText: "Delete",
      danger: true,
      onConfirm: () => {
        ExerciseLibrary.remove(ui.type, ex.id);
        Storage.save(state);
        showToast("Deleted");
        renderView();
      }
    });
  }
function openAddEditModal(existing){
  const isEdit = !!existing;

  // Keep old type (important for migrations)
  const oldType = String(existing?.type || ui.type || "weightlifting");

  const name = el("input", {
    type:"text",
    value: existing?.name || "",
    placeholder:"Exercise name"
  });

  const equip = el("input", {
    type:"text",
    value: existing?.equipment || "",
    placeholder:"e.g., Dumbbell, Barbell, Machine"
  });

  // ────────────────────────────
  // Glass dropdown options
  // ────────────────────────────
  const TYPE_OPTS = [
    { v:"weightlifting", t:"Weightlifting" },
    { v:"cardio",        t:"Cardio" },
    { v:"core",          t:"Core" }
  ];

  const PRIMARY_OPTS = [
    "Chest","Shoulders","Arms","Back","Legs","Full Body","Cardio","Core"
  ];

  const SECONDARY_OPTS = [
    "Upper Chest",
    "Lower Chest",
    "Front Delts",
    "Side Delts",
    "Rear Delts",
    "Traps",
    "Biceps",
    "Triceps",
    "Brachialis",
    "Forearms",
    "Lats",
    "Rhomboids",
    "Erector Spinae",
    "Quads",
    "Hamstrings",
    "Glutes",
    "Calves",
    "Adductors",
    "Abductors",
    "Abs",
    "Obliques",
    "Transverse Abdominis",
    "Grip",
    "Hip Flexors"
  ];

  function makeSelect(options, value){
    const sel = el("select", {
      style: [
        "width:100%",
        "border-radius:14px",
        "padding:12px",
        "border:1px solid rgba(255,255,255,12)",
        "background: rgba(255,255,255,06)",
        "color: rgba(255,255,255,92)",
        "outline:none"
      ].join(";")
    });

    options.forEach(opt => {
      if(typeof opt === "string"){
        sel.appendChild(el("option", { value: opt, text: opt }));
      }else{
        sel.appendChild(el("option", { value: opt.v, text: opt.t }));
      }
    });

    if(value != null) sel.value = String(value);
    return sel;
  }

  function makeMultiSelect(options, selectedArr){
    const sel = el("select", {
      multiple: true,
      style: [
        "width:100%",
        "border-radius:14px",
        "padding:12px",
        "border:1px solid rgba(255,255,255,12)",
        "background: rgba(255,255,255,06)",
        "color: rgba(255,255,255,92)",
        "outline:none",
        // multi-select needs height to be usable on phone
        "min-height:140px"
      ].join(";")
    });

    const selected = new Set((selectedArr || []).map(String));
    options.forEach(v => {
      const opt = el("option", { value: v, text: v });
      if(selected.has(String(v))) opt.selected = true;
      sel.appendChild(opt);
    });

    return sel;
  }

  // Type dropdown (NEW)
  const typeSel = makeSelect(TYPE_OPTS, oldType);

  // Primary + Secondary dropdowns (NEW)
  const primarySel = makeSelect(PRIMARY_OPTS, existing?.primaryMuscle || "");
  const secondarySel = makeMultiSelect(SECONDARY_OPTS, existing?.secondaryMuscles || []);

  // If they change Type, auto-suggest Primary for cardio/core (non-destructive)
  typeSel.addEventListener("change", () => {
    const t = String(typeSel.value || "");
    if(t === "cardio" && (!primarySel.value || primarySel.value === "")) primarySel.value = "Cardio";
    if(t === "core" && (!primarySel.value || primarySel.value === "")) primarySel.value = "Core";
  });

  function migrateReferences(exId, fromType, toType){
    if(!exId || fromType === toType) return;

    // Update routine slots
    (state.routines || []).forEach(r => {
      (r.days || []).forEach(d => {
        (d.exercises || []).forEach(rx => {
          if(rx.exerciseId === exId && rx.type === fromType){
            rx.type = toType;
          }
        });
      });
    });

    // Update workout logs
    (state.logs?.workouts || []).forEach(e => {
      if(e.exerciseId === exId && e.type === fromType){
        e.type = toType;
      }
    });
  }

  Modal.open({
    title: isEdit ? "Edit exercise" : "Add exercise",
    bodyNode: el("div", {}, [
      el("label", {}, [ el("span", { text:"Name" }), name ]),
      el("div", { style:"height:10px" }),

      // NEW: Type selector
      el("label", {}, [ el("span", { text:"Type" }), typeSel ]),
      el("div", { style:"height:10px" }),

      el("label", {}, [ el("span", { text:"Equipment" }), equip ]),
      el("div", { style:"height:10px" }),

      // NEW: Primary/Secondary selectors
      el("label", {}, [ el("span", { text:"Primary muscle" }), primarySel ]),
      el("div", { style:"height:10px" }),

      el("label", {}, [
        el("span", { text:"Secondary muscles (multi-select)" }),
        secondarySel
      ]),
      el("div", { class:"note", text:"Tip: iPhone — you can tap multiple options. (This saves to secondaryMuscles[] and won’t break existing logic.)" }),

      el("div", { style:"height:12px" }),
      el("div", { class:"btnrow" }, [
        el("button", {
          class:"btn primary",
          onClick: () => {
            const nm = (name.value || "").trim();
            if(!nm) return showToast("Name is required");

            const newType = String(typeSel.value || ui.type || "weightlifting");
            const exId = existing?.id || uid("ex");

            const selectedSecondary = Array.from(secondarySel.selectedOptions || [])
              .map(o => String(o.value || "").trim())
              .filter(Boolean);

            // Preserve existing fields to avoid wiping cardio/core-specific properties
            const payload = {
              ...(existing || {}),
              id: exId,
              type: newType,
              name: nm,
              equipment: (equip.value || "").trim(),
              primaryMuscle: String(primarySel.value || "").trim(),
              secondaryMuscles: selectedSecondary
            };

            // If editing AND type changes: migrate library bucket + update routine/log refs
            if(isEdit){
              if(oldType !== newType){
                // Move exercise to new library type
                ExerciseLibrary.remove(oldType, exId);
                ExerciseLibrary.add(newType, payload);

                // Keep routines/logs consistent
                migrateReferences(exId, oldType, newType);

                // Keep UI on the new type so the user sees it immediately
                ui.type = newType;
              }else{
                ExerciseLibrary.update(newType, payload);
              }
            }else{
              ExerciseLibrary.add(newType, payload);
              ui.type = newType;
            }

            Storage.save(state);
            Modal.close();
            showToast(isEdit ? "Updated" : "Added");
            renderView();
          }
        }, [isEdit ? "Save" : "Add"]),
        el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
      ])
    ])
  });
}

  return root;
};
Views.RoutineEditor = function(){
  ExerciseLibrary.ensureSeeded();

  const root = el("div", { class:"grid" });
  const active = Routines.getActive();

  if(!active){

    function openRoutineRecovery(){
      const body = el("div", {}, [
        el("div", { class:"note", text:"Choose a template to recreate a routine. This will set it as active and reopen the editor." }),
        el("div", { style:"height:12px" })
      ]);

      const list = el("div", { class:"list" });

      (RoutineTemplates || []).forEach(tpl => {
        list.appendChild(el("div", {
          class:"item",
          onClick: () => {
            try{
              Routines.addFromTemplate(tpl.key, tpl.name);
              Modal.close();
              showToast(`Created: ${tpl.name}`);
              renderView(); // RoutineEditor will re-render with the new active routine
            }catch(e){
              Modal.open({
                title:"Could not create routine",
                bodyNode: el("div", {}, [
                  el("div", { class:"note", text: e?.message || "Something went wrong while creating a routine." }),
                  el("div", { style:"height:12px" }),
                  el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
                ])
              });
            }
          }
        }, [
          el("div", { class:"left" }, [
            el("div", { class:"name", text: tpl.name }),
            el("div", { class:"meta", text: tpl.desc || "Template" })
          ]),
          el("div", { class:"actions" }, [
            el("div", { class:"meta", text:"Create" })
          ])
        ]));
      });

      body.appendChild(list);

      body.appendChild(el("div", { style:"height:14px" }));
      body.appendChild(el("div", { class:"btnrow" }, [
        el("button", { class:"btn", onClick: () => { Modal.close(); navigate("routine"); } }, ["Back to Routine"]),
        el("button", { class:"btn", onClick: Modal.close }, ["Cancel"])
      ]));

      Modal.open({
        title:"Create a routine",
        center: true,
        bodyNode: body
      });
    }

    root.appendChild(el("div", { class:"card" }, [
      el("h2", { text:"Routine Editor" }),
      el("div", { class:"note", text:"No active routine found. Create one to continue." }),
      el("div", { style:"height:12px" }),
      el("div", { class:"btnrow" }, [
        el("button", { class:"btn primary", onClick: openRoutineRecovery }, ["Create routine"]),
        el("button", { class:"btn", onClick: () => navigate("routine") }, ["Back to Routine"])
      ])
    ]));

    return root;
  }

    function openShareRoutineModal(routine){
    if(!routine){
      showToast("Routine not found");
      return;
    }

    if(!(Social.isConfigured && Social.isConfigured())){
      showToast("Friends is not configured");
      return;
    }

    if(!(Social.getUser && Social.getUser())){
      showToast("Sign in to share routines");
      return;
    }

    const usernameInput = el("input", {
      class:"connCodeInput",
      type:"text",
      placeholder:"@username",
      autocapitalize:"off",
      autocorrect:"off",
      spellcheck:"false"
    });

    usernameInput.addEventListener("input", () => {
      usernameInput.value = normalizeUsername(usernameInput.value);
    });

    const meta = buildRoutineSnapshotMeta(routine);

    async function doSend(){
      const uname = normalizeUsername(usernameInput.value || "");
      if(!uname){
        showToast("Enter a username");
        return;
      }

      try{
        await Social.shareRoutineWithUsername(uname, routine);
        Modal.close();
        showToast("Routine sent");
      }catch(e){
        showToast(e?.message || "Couldn't share routine");
      }
    }

    Modal.open({
      title:"Share Routine",
      bodyNode: el("div", { class:"connAddFriendModal" }, [
        el("div", { class:"setRow" }, [
          el("div", {}, [
            el("div", { style:"font-weight:820;", text: routine?.name || "Routine" }),
            el("div", {
              class:"meta",
              text:`Send this routine directly to another user • ${meta.dayCount} days • ${meta.exerciseCount} exercises`
            })
          ]),
          el("div", { class:"connCodeRight" }, [
            usernameInput,
            el("button", {
              class:"btn primary sm",
              onClick: doSend
            }, ["Send"])
          ])
        ]),
        el("div", { class:"note", text:"The recipient can preview it and save a copy into Your Routines." })
      ])
    });
  }

  const header = el("div", { class:"card" }, [
    el("h2", { text:"Routine Editor" }),
    el("div", { class:"note", text:`Editing: ${active.name}` }),
    el("div", { style:"height:10px" }),
    el("div", { class:"btnrow" }, [
      el("button", {
        class:"btn",
        onClick: () => navigate("routine")
      }, ["Back to Routine"]),
      el("button", {
        class:"btn",
        onClick: () => openShareRoutineModal(active)
      }, ["Share"]),
      el("button", {
        class:"btn",
        onClick: (e) => renameRoutine(e.currentTarget, active.id)
      }, ["Rename"]),
      el("button", {
        class:"btn",
        onClick: () => { Routines.duplicate(active.id); renderView(); }
      }, ["Duplicate"]),
      el("button", {
        class:"btn danger",
        onClick: (e) => confirmDelete(e.currentTarget, active.id)
      }, ["Delete"])
    ])
  ]);

  
  // ────────────────────────────
  // Templates (same 5 as Onboarding)
  // ────────────────────────────
  const templatesCard = el("div", { class:"card" }, [
    el("h2", { text:"Templates" }),
    el("div", { class:"note", text:"Choose a template to switch your active routine. If it already exists, it will activate (no duplicates)." }),
    el("div", { style:"height:10px" })
  ]);

  const tplList = el("div", { class:"list" });

  function findExistingRoutineForTemplate(tpl){
    const all = Routines.getAll() || [];
    // Prefer templateKey match
    const byKey = all.find(r => String(r.templateKey || "") === String(tpl.key || ""));
    if(byKey) return byKey;
    // Fallback to name match (older saves)
    const byName = all.find(r => normName(r.name) === normName(tpl.name));
    return byName || null;
  }

  (RoutineTemplates || []).forEach(tpl => {
    const existing = findExistingRoutineForTemplate(tpl);

    tplList.appendChild(el("div", {
      class:"item",
      onClick: () => {
        // If it exists, activate it (no recreation)
        const existingNow = findExistingRoutineForTemplate(tpl);
        if(existingNow){
          Routines.setActive(existingNow.id);
          showToast(`Active: ${existingNow.name}`);
          renderView(); // re-render editor on the newly active routine
          return;
        }

        // Otherwise create ONE routine for that template (exact template name)
        Routines.addFromTemplate(tpl.key, tpl.name);
        showToast(`Created: ${tpl.name}`);
        renderView();
      }
    }, [
      el("div", { class:"left" }, [
        el("div", { class:"name", text: tpl.name }),
        el("div", { class:"meta", text: tpl.desc || "Template" })
      ]),
      el("div", { class:"actions" }, [
        el("div", { class:"meta", text: existing ? "Activate" : "Add" })
      ])
    ]));
  });

  templatesCard.appendChild(tplList);

  const daysCard = el("div", { class:"card" }, [
    el("h2", { text:"Days" }),
    el("div", { class:"note", text:"Tap a day to edit label, rest day, or exercises." })
  ]);

  const daysGrid = el("div", { class:"dayGrid" });
  daysCard.appendChild(el("div", { style:"height:10px" }));
  daysCard.appendChild(daysGrid);

  root.appendChild(header);
  root.appendChild(templatesCard);
  root.appendChild(daysCard);

  repaintDays();
  return root;

  function repaintDays(){
    const r = Routines.getActive();
    daysGrid.innerHTML = "";

    (r.days || []).forEach(day => {
      const exCount = (day.exercises || []).length;

      const card = el("div", { class:"dayCard" }, [
        el("div", { class:"dayTop" }, [
          el("div", { class:"dayTitle" }, [
            el("div", { class:"lbl", text: `${["SUN","MON","TUE","WED","THU","FRI","SAT"][day.order]} — ${day.label}` }),
            el("div", { class:"sub", text: day.isRest ? "Rest day" : `${exCount} exercises` })
          ]),
          el("button", {
            class:"mini",
            onClick: () => editDay(day)
          }, ["Edit"])
        ])
      ]);

      const list = el("div", { class:"exList" });

      if(day.isRest){
        list.appendChild(el("div", { class:"note", text:"No exercises on rest days." }));
      }else if(exCount === 0){
        list.appendChild(el("div", { class:"note", text:"No exercises yet. Tap Edit → Add exercise." }));
      }else{
        (day.exercises || []).forEach(rx => {
          const name = resolveExerciseName(rx.type, rx.exerciseId, rx.nameSnap);
          list.appendChild(el("div", { class:"exRow" }, [
            el("div", { class:"n", text:name }),
            el("button", {
              class:"mini danger",
              onClick: () => { Routines.removeExerciseFromDay(r.id, day.id, rx.id); repaintDays(); }
            }, ["Remove"])
          ]));
        });
      }

      card.appendChild(list);
      daysGrid.appendChild(card);
    });
  }

function renameRoutine(anchorEl, routineId){
  const current = Routines.getActive();
  const input = el("input", {
    type:"text",
    value: current?.name || "",
    style:"width:100%;"
  });

  const err = el("div", {
    class:"note",
    style:"display:none; color: rgba(255,92,122,.95); margin-top:8px;"
  });

  const body = el("div", {}, [
    el("div", { class:"popTitle", text:"Rename routine" }),
    el("div", { style:"display:grid; gap:10px;" }, [
      input,
      err,
      el("div", { class:"btnrow" }, [
        el("button", {
          class:"btn primary",
          onClick: () => {
            err.style.display = "none";
            const name = (input.value || "").trim();
            if(!name){
              err.textContent = "Enter a name.";
              err.style.display = "block";
              return;
            }
            Routines.rename(routineId, name);
            PopoverClose();
            renderView();
          }
        }, ["Save"]),
        el("button", { class:"btn", onClick: PopoverClose }, ["Cancel"])
      ])
    ])
  ]);

  PopoverOpen(anchorEl, body);
  setTimeout(() => input.focus(), 0);
}

function confirmDelete(anchorEl, routineId){
  const body = el("div", {}, [
    el("div", { class:"popTitle", text:"Delete routine?" }),
    el("div", { class:"note", text:"This deletes the routine. Logs stay, but the routine schedule will be removed." }),
    el("div", { style:"height:10px" }),
    el("div", { class:"btnrow" }, [
      el("button", {
        class:"btn danger",
        onClick: () => {
          Routines.remove(routineId);
          PopoverClose();
          navigate("routine");
        }
      }, ["Delete"]),
      el("button", { class:"btn", onClick: PopoverClose }, ["Cancel"])
    ])
  ]);

  PopoverOpen(anchorEl, body);
}

  function editDay(day){
    const r = Routines.getActive();

    const labelInput = el("input", { type:"text", value: day.label || "" });

    const restSwitch = el("div", { class:"switch" + (day.isRest ? " on" : "") });
    restSwitch.addEventListener("click", () => {
      const next = !restSwitch.classList.contains("on");
      restSwitch.classList.toggle("on", next);
    });

const addBtn = el("button", {
  class:"btn primary",
  onClick: () => openAddExercise(r.id, day.id, { keepOpen:false })
}, ["Add exercise"]);

const addMultiBtn = el("button", {
  class:"btn",
  onClick: () => openAddExercise(r.id, day.id, { keepOpen:true })
}, ["Add multiple"]);


    Modal.open({
      title: "Edit day",
      bodyNode: el("div", {}, [
        el("label", {}, [ el("span", { text:"Label" }), labelInput ]),
        el("div", { style:"height:10px" }),
        el("div", { class:"toggle" }, [
          el("div", { class:"ttext" }, [
            el("div", { class:"a", text:"Rest day" }),
            el("div", { class:"b", text:"If enabled, exercises are hidden on Routine." })
          ]),
          restSwitch
        ]),
        el("div", { style:"height:12px" }),
        el("div", { class:"btnrow" }, [ addBtn, addMultiBtn ]),
        el("div", { style:"height:12px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn",
            onClick: () => {
              const nextLabel = (labelInput.value || "").trim() || day.label;
              const isRest = restSwitch.classList.contains("on");
              Routines.setDayLabel(r.id, day.id, nextLabel);
              Routines.setRestDay(r.id, day.id, isRest);
              Modal.close();
              repaintDays();
            }
          }, ["Save"]),
          el("button", { class:"btn", onClick: Modal.close }, ["Close"])
        ])
      ])
    });
  }

  function openAddExercise(routineId, dayId, opts={}){
    // Compact, phone-first "Add Exercise" modal
    // - Active day context (top)
    // - Fixed search bar
    // - Scrollable exercise sections grouped by Primary Muscle (tap to expand)
    // - Fixed Add/Done bar (supports multi-add when opts.keepOpen === true)
    ExerciseLibrary.ensureSeeded();

    const routine = (state.routines || []).find(r => r.id === routineId) || Routines.getActive();
    const day = (routine?.days || []).find(d => d.id === dayId) || null;

    const dayIndex = day ? (routine.days || []).findIndex(d => d.id === dayId) : -1;
    const dow = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    const dayTag = (dayIndex >= 0 && dayIndex < 7) ? dow[dayIndex] : "Day";
    const dayLabel = (day?.label || "").trim();
    const dayTitle = dayLabel ? `${dayTag} • ${dayLabel}` : `${dayTag}`;

    // Tracks what the user adds during THIS open session (for live count)
    const addedThisSession = new Set();

    // Persisted exercises already on this day (to prevent duplicates)
    function getExistingSetForDay(){
      const s = new Set();
      (day?.exercises || []).forEach(rx => s.add(`${rx.type}:${rx.exerciseId}`));
      return s;
    }

    // Search state
    let query = "";

    // Collapsed/expanded groups (session only)
    const openGroups = new Set();

    // If day label hints a muscle, open that group by default
    (function seedOpenGroupFromDay(){
      const hint = normName(dayLabel || "");
      const mus = (state.exerciseLibrary?.weightlifting || [])
        .map(x => String(x.primaryMuscle || "").trim())
        .filter(Boolean);

      const match = mus.find(m => hint && hint.includes(normName(m)));
      if(match) openGroups.add(match);
    })();

    // UI nodes
    const ctx = el("div", { class:"addExCtx" }, [
      el("div", { class:"addExCtxA", text:"Add exercises to" }),
      el("div", { class:"addExCtxB", text: dayTitle })
    ]);

    const searchWrap = el("div", { class:"addExSearch" }, [
      el("div", { class:"ico", text:"🔎" }),
      el("input", {
        type:"text",
        value:"",
        placeholder:"Search exercises…",
        onInput: (e) => {
          query = String(e.target.value || "");
          repaint();
        }
      })
    ]);

    const scroller = el("div", { class:"addExScroller" });
    const bottomBar = el("div", { class:"addExBottom" });

    const countPill = el("div", { class:"addExCount", text:"0 added" });
    const doneBtn = el("button", {
      class:"btn primary",
      onClick: () => Modal.close()
    }, [opts.keepOpen ? "Done" : "Close"]);

    function updateCount(){
      countPill.textContent = `${addedThisSession.size} added`;
    }
    // Helper: find the routineExerciseId (rx.id) for a given library exercise on this day
    function findRxIdOnDay(type, exId){
      // Always re-fetch the latest day object (in case state changed while modal is open)
      const latestDay = Routines.getDay(routineId, dayId) || day;
      const rx = (latestDay?.exercises || []).find(e => e.type === type && e.exerciseId === exId);
      return rx?.id || null;
    }

    // Helper: set button/row UI state
    function setRowState({ row, btn, mode }){
      // mode: "add" | "remove"
      if(!row || !btn) return;

      row.classList.remove("selected", "disabledRow");
      btn.classList.remove("added", "disabledBtn", "danger");

      if(mode === "remove"){
        row.classList.add("selected");
        btn.classList.add("danger");
        btn.textContent = "Remove";
        btn.disabled = false;
      }else{
        btn.textContent = "Add";
        btn.disabled = false;
      }
    }

    function addExercise(type, exId, key, rowBtn, rowEl){
      // Toggle behavior:
      // - If already in day: remove
      // - If not: add
      const existingSet = getExistingSetForDay();
      const alreadyInDay = existingSet.has(key);

      if(alreadyInDay){
        const rxId = findRxIdOnDay(type, exId);
        if(rxId){
          Routines.removeExerciseFromDay(routineId, dayId, rxId);
        }

        // If it was added during THIS modal session, reduce the counter
        if(addedThisSession.has(key)) addedThisSession.delete(key);
        updateCount();

        // Refresh Routine + modal list states
        repaintDays();
        repaint();

        // For single-add modal, keep it open on remove (less annoying)
        return;
      }

      // Add path (original behavior preserved)
      Routines.addExerciseToDay(routineId, dayId, type, exId);
      repaintDays();

      if(opts.keepOpen){
        addedThisSession.add(key);
        updateCount();

        // Keep open and flip the row into "Remove" state
        setRowState({ row: rowEl, btn: rowBtn, mode: "remove" });
      }else{
        Modal.close();
      }
    }

    function renderRow(type, x, existingSet){
      const key = `${type}:${x.id}`;
      const alreadyInDay = existingSet.has(key);

      const row = el("div", { class:"item addExRow" });
      const btn = el("button", { class:"mini" }, ["Add"]);

      // Build meta as DOM nodes so we can highlight secondary muscles
      const metaNodes = [];

      // Helpers
      const pushSep = () => metaNodes.length ? metaNodes.push(document.createTextNode(" • ")) : null;
      const pushText = (t) => {
        const s = String(t || "").trim();
        if(!s) return;
        pushSep();
        metaNodes.push(document.createTextNode(s));
      };
      const pushSecondary = (t) => {
        const s = String(t || "").trim();
        if(!s) return;
        pushSep();
        metaNodes.push(el("span", { class:"secMuscle", text: s }));
      };

      if(type === "weightlifting"){
        // Primary muscle (support legacy "Chest / Triceps" formatting)
        const rawPrimary = String(x.primaryMuscle || "").trim();
        const primaryOnly = rawPrimary.includes("/") ? rawPrimary.split("/")[0].trim() : rawPrimary;
        if(primaryOnly) pushText(primaryOnly);

        // Secondary muscles (preferred: array)
        const secs = Array.isArray(x.secondaryMuscles) ? x.secondaryMuscles.filter(Boolean) : [];
        if(secs.length){
          secs.forEach(sm => pushSecondary(sm));
        }else{
          // Fallback: parse legacy "Primary / Secondary" format
          if(rawPrimary.includes("/")){
            const parsed = rawPrimary.split("/").slice(1).join("/").trim();
            if(parsed) pushSecondary(parsed);
          }
        }

        // Equipment
        if(x.equipment) pushText(x.equipment);
      }else{
        // Cardio/Core keep current meta style
        if(x.equipment) pushText(x.equipment);
      }

      // Type label always last
      pushText(ExerciseLibrary.typeLabel(type));

      row.appendChild(
        el("div", { class:"left" }, [
          el("div", { class:"name", text:x.name }),
          el("div", { class:"meta" }, metaNodes.length ? metaNodes : [document.createTextNode("")])
        ])
      );
      row.appendChild(el("div", { class:"actions" }, [ btn ]));

      // ✅ NEW: if it’s already in the day, show a removable state (not disabled)
      if(alreadyInDay){
        setRowState({ row, btn, mode: "remove" });
      }else{
        setRowState({ row, btn, mode: "add" });
      }

      btn.addEventListener("click", () => addExercise(type, x.id, key, btn, row));
      return row;
    }

    function toggleGroup(name){
      if(openGroups.has(name)) openGroups.delete(name);
      else openGroups.add(name);
      repaint();
    }

    function renderGroup(title, items, existingSet){
      const isOpen = openGroups.has(title);

      const head = el("div", {
        class:"addExGroupHead",
        onClick: () => toggleGroup(title)
      }, [
        el("div", { class:"addExGroupLeft" }, [
          el("div", { class:"addExGroupTitle", text:title }),
          el("div", { class:"addExGroupSub", text:`${items.length} exercise${items.length===1?"":"s"}` })
        ]),
        el("div", { class:"addExGroupCaret", text: isOpen ? "▾" : "▸" })
      ]);

      const body = el("div", {
        class:"addExGroupBody",
        style: isOpen ? "" : "display:none;"
      });

      items.forEach(x => body.appendChild(renderRow(x.type, x, existingSet)));

      return el("div", { class:"addExGroup" }, [ head, body ]);
    }

    function repaint(){
      scroller.innerHTML = "";
      const existingSet = getExistingSetForDay();

      // ✅ No segmented control: unify all categories
      const libs = {
        weightlifting: (state.exerciseLibrary?.weightlifting || []).slice(),
        cardio:        (state.exerciseLibrary?.cardio || []).slice(),
        core:          (state.exerciseLibrary?.core || []).slice()
      };

      const all = []
        .concat(libs.weightlifting.map(x => ({...x, type:"weightlifting"})))
        .concat(libs.cardio.map(x => ({...x, type:"cardio"})))
        .concat(libs.core.map(x => ({...x, type:"core"})));

      const q = normName(query || "");

      // Search: flat list (fast + compact)
      if(q){
        const hits = all
          .filter(x => normName(x.name).includes(q))
          .sort((a,b) => (a.name||"").localeCompare(b.name||""))
          .slice(0, 60);

        if(hits.length === 0){
          scroller.appendChild(el("div", { class:"note", text:"No matches. Try a different keyword." }));
          updateCount();
          return;
        }

        scroller.appendChild(el("div", { class:"addExSearchHint", text:`Results (${hits.length})` }));
        const wrap = el("div", { class:"list" });
        hits.forEach(x => wrap.appendChild(renderRow(x.type, x, existingSet)));
        scroller.appendChild(wrap);

        updateCount();
        return;
      }

      // Weightlifting grouped by primaryMuscle (tap to expand)
      const wl = libs.weightlifting
        .map(x => ({...x, type:"weightlifting"}))
        .sort((a,b) => (a.name||"").localeCompare(b.name||""));

      // ✅ Fixed display order (your requirement)
      const MUSCLE_ORDER = ["Chest", "Shoulders", "Arms", "Back", "Legs", "Full Body"];

      // ✅ Normalize messy primaryMuscle labels into our 6 buckets
      function normalizeBucket(primaryMuscle){
        const raw = String(primaryMuscle || "").trim();
        const m = raw.toLowerCase();

        if(!m) return "Other";

        // Full Body
        if(m.includes("full body")) return "Full Body";

        // Chest
        if(m.includes("chest") || m.includes("pec")) return "Chest";

        // Shoulders
        if(m.includes("shoulder") || m.includes("delt")) return "Shoulders";

        // Arms (also catches biceps/triceps/forearms)
        if(m.includes("arm") || m.includes("bicep") || m.includes("tricep") || m.includes("forearm")) return "Arms";

        // Back (also catches lats/traps)
        if(m.includes("back") || m.includes("lat") || m.includes("trap")) return "Back";

        // Legs (also catches quads/hamstrings/glutes/calves)
        if(
          m.includes("leg") || m.includes("quad") || m.includes("hamstring") ||
          m.includes("glute") || m.includes("calf")
        ) return "Legs";

        return "Other";
      }

      const byMuscle = new Map();
      wl.forEach(x => {
        const bucket = normalizeBucket(x.primaryMuscle);
        if(!byMuscle.has(bucket)) byMuscle.set(bucket, []);
        byMuscle.get(bucket).push(x);
      });

      // ✅ Only render buckets that actually have exercises
      const orderedBuckets = MUSCLE_ORDER.filter(k => (byMuscle.get(k) || []).length);

      // Safety bucket (only shows if needed)
      const otherItems = byMuscle.get("Other") || [];
      if(otherItems.length) orderedBuckets.push("Other");

      // Used later for the empty-state check (prevents "muscleNames" crashes)
      const hasWeightliftingGroups = orderedBuckets.length > 0;

      if(hasWeightliftingGroups){
        scroller.appendChild(el("div", { class:"addExSectionLabel", text:"Weightlifting (by muscle)" }));

        orderedBuckets.forEach(name => {
          const items = byMuscle.get(name) || [];
          // Keep alphabetical inside each muscle bucket (clean scanning)
          items.sort((a,b)=>(a.name||"").localeCompare(b.name||""));
          scroller.appendChild(renderGroup(name, items, existingSet));
        });
      }

        // Cardio collapsible group
  const cardioItems = libs.cardio.map(x => ({...x, type:"cardio"}))
    .sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  
  if(cardioItems.length){
    scroller.appendChild(el("div", { style:"height:10px" }));
    scroller.appendChild(el("div", { class:"addExSectionLabel", text:"Cardio" }));
    // Default state: collapsed (do NOT auto-open)
    scroller.appendChild(renderGroup("Cardio", cardioItems, existingSet));
  }



// Core collapsible group
const coreItems = libs.core.map(x => ({...x, type:"core"}))
  .sort((a,b)=>(a.name||"").localeCompare(b.name||""));

if(coreItems.length){
  scroller.appendChild(el("div", { style:"height:10px" }));
  scroller.appendChild(el("div", { class:"addExSectionLabel", text:"Core" }));
  // Default state: collapsed (do NOT auto-open)
  scroller.appendChild(renderGroup("Core", coreItems, existingSet));
}


       if(!hasWeightliftingGroups && !cardioItems.length && !coreItems.length){
        scroller.appendChild(el("div", { class:"note", text:"No exercises yet. Seed the library or add exercises in Settings." }));
      }

      updateCount();
    }

    // Bottom bar content
    bottomBar.appendChild(countPill);
    bottomBar.appendChild(el("div", { style:"flex:1" }));
    bottomBar.appendChild(doneBtn);

    // First paint
    repaint();
    updateCount();

    Modal.open({
      title: "Add exercise",
      size: "lg",
      bodyNode: el("div", { class:"addExModal" }, [
        ctx,
        searchWrap,
        scroller,
        bottomBar
      ])
    });

    // Focus search immediately (fast on phones)
    setTimeout(() => {
      try{
        const inp = searchWrap.querySelector("input");
        inp && inp.focus && inp.focus();
      }catch(e){}
    }, 0);
  }
};   // ✅ closes Views.RoutineEditor function


/********************
 * 7b) Router wiring (Phase 3.3)
 ********************/
const Router = initRouter({
  getState: () => state,
  $,
  el,
  Views,
  destroyProgressChart,
  destroyWeightChart,
  bindHeaderPills,
  setHeaderPills,
  checkForUpdates
});

// Pull router funcs, but DO NOT redeclare `navigate` (we already defined it above).
const { Routes, renderNav, renderView, getCurrentRoute } = Router;
navigate = Router.navigate;

// ✅ Friends/Social: auto-refresh UI after OAuth redirect (and during feed polling)
// Only re-render on Friends or Settings routes to avoid extra work elsewhere.
try{
  const sUI = UIState.social || (UIState.social = {});

  if(!sUI.__scheduleRender){
    sUI.__renderRaf = 0;
    sUI.__scheduleRender = () => {
      if(sUI.__renderRaf) return;
      sUI.__renderRaf = requestAnimationFrame(() => {
        sUI.__renderRaf = 0;
        try{ renderView(); }catch(_){}
      });
    };
  }

  if(!sUI.__routeSub && Social?.onChange){
    sUI.__routeSub = Social.onChange(() => {
      const r = (typeof getCurrentRoute === "function")
        ? getCurrentRoute()
        : (String(location.hash || "").replace(/^#/, "") || "home");

      // Do not re-render while OAuth launch is being handed off
      try{
        if(Social.__isAuthInFlight && Social.__isAuthInFlight()) return;
      }catch(_){}

      if(r === "friends" || r === "settings"){
        try{ sUI.__scheduleRender(); }catch(_){}
      }
    });
  }
}catch(_){}


/********************
 * 8) Boot (guarded) — extracted to bootstrap.js (Phase 3.6)
 ********************/
const Bootstrap = initBootstrap({
  getState: () => state,

   // Friends/Social: allow bootstrap to rehydrate OAuth session on app load
  Social,

  ExerciseLibrary,
  LogEngine,

  ensureFloatNext,

  renderNav,
  renderView,

  bindHeaderPills,
  setHeaderPills,

  checkForUpdates,
  registerServiceWorker,

  fatal: __fatal
});

Bootstrap.start();
