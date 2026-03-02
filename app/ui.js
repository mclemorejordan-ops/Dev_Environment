/********************
 * UI Helpers Module
 * File: /app/ui.js
 ********************/

/********************
 * 1) DOM Helpers
 ********************/
export const $ = (sel, root=document) => root.querySelector(sel);

export const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      n.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      n.setAttribute(k, v);
    }
  }
  children.forEach(c => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return n;
};

export const uid = (prefix = "id") =>
  `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;

export const pad2 = (n) => String(n).padStart(2, "0");

/********************
 * 2) Dates
 ********************/
export const Dates = {
  isISO(dateISO){
    return typeof dateISO === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateISO);
  },

  // ✅ Backwards-compat alias (some modules still call Dates.fromISO)
  fromISO(dateISO){
    return this.parseISO(dateISO);
  },

  parseISO(dateISO){
    if(!this.isISO(dateISO)) return null;
    const d = new Date(dateISO + "T00:00:00");
    return Number.isFinite(d.getTime()) ? d : null;
  },

  todayISO(){
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  },

  startOfWeekISO(dateISO, weekStartsOn){
    const baseISO = this.isISO(dateISO) ? dateISO : this.todayISO();
    const d = new Date(baseISO + "T00:00:00");

    const dow = d.getDay(); // 0=Sun..6=Sat
    const weekStart = (weekStartsOn === "sun") ? 0 : 1;

    let diff = dow - weekStart;
    if(diff < 0) diff += 7;

    d.setDate(d.getDate() - diff);
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  },

  addDaysISO(dateISO, days){
    const baseISO = this.isISO(dateISO) ? dateISO : this.todayISO();
    const d = new Date(baseISO + "T00:00:00");
    d.setDate(d.getDate() + (Number(days) || 0));
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  },

  sameISO(a,b){ return String(a) === String(b); },

  formatShort(dateISO){
    const d = this.parseISO(dateISO);
    if(!d) return "—";
    return d.toLocaleDateString("en-US", { month:"short", day:"numeric" });
  }
};

/********************
 * 3) Storage UI helpers
 ********************/
export function bytesToNice(bytes){
  const n = Number(bytes || 0);
  if(!isFinite(n) || n <= 0) return "0 B";
  const units = ["B","KB","MB","GB","TB"];
  let v = n;
  let i = 0;
  while(v >= 1024 && i < units.length-1){
    v /= 1024;
    i++;
  }
  const dp = (i === 0) ? 0 : (v >= 10 ? 1 : 2);
  return `${v.toFixed(dp)} ${units[i]}`;
}

export function appStorageBytes(){
  let total = 0;
  try{
    for(let i=0; i<localStorage.length; i++){
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) || "";
      total += (k ? k.length : 0) + v.length;
    }
  }catch(e){
    total = 0;
  }
  return total * 2; // UTF-16-ish
}

/********************
 * 4) Toast
 ********************/
export function showToast(message){
  try{
    const existing = document.getElementById("toastTemp");
    if(existing) existing.remove();

    const t = el("div", {
      id:"toastTemp",
      style:"position:fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 90; padding: 10px 12px; border-radius: 999px; background: rgba(16,20,30,.92); border: 1px solid rgba(255,255,255,.12); color: rgba(255,255,255,.92); font-size: 12.5px; box-shadow: 0 18px 44px rgba(0,0,0,.55);"
    }, [message]);

    document.body.appendChild(t);
    setTimeout(() => { try{ t.remove(); }catch(e){} }, 1100);
  }catch(e){}
}

/********************
 * 5) Scroll lock (Modal + Popover share)
 ********************/
let __modalScrollY = 0;

export function lockBodyScroll(){
  __modalScrollY = window.scrollY || 0;

  document.body.classList.add("modalOpen");
  document.body.style.position = "fixed";
  document.body.style.top = `-${__modalScrollY}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
  document.body.style.width = "100%";
}

export function unlockBodyScroll(){
  document.body.classList.remove("modalOpen");

  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  document.body.style.width = "";

  window.scrollTo(0, __modalScrollY);
}

/********************
 * 6) Modal (production hardening)
 ********************/
let __modalLastFocus = null;
let __modalKeydownHandler = null;

function __getModalFocusables(sheet){
  if(!sheet) return [];
  const nodes = sheet.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  return Array.from(nodes).filter(el => {
    const style = window.getComputedStyle(el);
    if(style.visibility === "hidden" || style.display === "none") return false;
    if(el.hasAttribute("disabled")) return false;
    return true;
  });
}

export const Modal = {
  open({ title, bodyNode, center = true, size = "md" }){
    const host  = $("#modalHost");
    const body  = $("#modalBody");
    const sheet = host.querySelector(".sheet");

    __modalLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    $("#modalTitle").textContent = title || "Modal";

    host.classList.toggle("center", !!center);

    if(sheet){
      sheet.classList.remove("sm", "md", "lg");
      sheet.classList.add(size);
    }

    body.innerHTML = "";
    if(bodyNode) body.appendChild(bodyNode);

    host.classList.add("show");
    host.setAttribute("aria-hidden", "false");

    lockBodyScroll();

    const closeBtn = $("#modalClose");
    const focusablesNow = __getModalFocusables(sheet);
    const first = closeBtn || focusablesNow[0] || sheet;

    if(sheet && !sheet.hasAttribute("tabindex")) sheet.setAttribute("tabindex", "-1");

    setTimeout(() => {
      try { first && first.focus && first.focus(); } catch(e){}
    }, 0);

    __modalKeydownHandler = (e) => {
      if(!host.classList.contains("show")) return;

      if(e.key === "Escape"){
        e.preventDefault();
        Modal.close();
        return;
      }

      if(e.key !== "Tab") return;

      const focusables = __getModalFocusables(sheet);
      if(focusables.length === 0){
        e.preventDefault();
        sheet && sheet.focus && sheet.focus();
        return;
      }

      const active = document.activeElement;
      const firstEl = focusables[0];
      const lastEl  = focusables[focusables.length - 1];

      if(e.shiftKey && active === firstEl){
        e.preventDefault();
        lastEl.focus();
        return;
      }

      if(!e.shiftKey && active === lastEl){
        e.preventDefault();
        firstEl.focus();
        return;
      }
    };

    document.addEventListener("keydown", __modalKeydownHandler, true);
  },

  close(){
    const host  = $("#modalHost");
    const sheet = host.querySelector(".sheet");

    host.classList.remove("show");
    host.classList.remove("center");
    host.setAttribute("aria-hidden", "true");

    $("#modalBody").innerHTML = "";

    if(sheet){
      sheet.classList.remove("sm", "md", "lg");
    }

    unlockBodyScroll();

    if(__modalKeydownHandler){
      document.removeEventListener("keydown", __modalKeydownHandler, true);
      __modalKeydownHandler = null;
    }

    if(__modalLastFocus && document.contains(__modalLastFocus)){
      try { __modalLastFocus.focus(); } catch(e){}
    }
    __modalLastFocus = null;
  }
};

export function bindModalControls(){
  const closeBtn = $("#modalClose");
  const backdrop = $("#modalBackdrop");

  if(closeBtn){
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      Modal.close();
    });
  }

  if(backdrop){
    backdrop.addEventListener("click", (e) => {
      e.preventDefault();
      Modal.close();
    });
  }

  document.addEventListener("keydown", (e) => {
    if(e.key === "Escape"){
      const host = $("#modalHost");
      if(host && host.classList.contains("show")){
        Modal.close();
      }
    }
  });
}

/********************
 * 7) Confirm Modal (uses Modal)
 ********************/
export function confirmModal({ title="Confirm", message="Are you sure?", confirmText="Confirm", danger=false, onConfirm }){
  const btnClass = danger ? "btn danger" : "btn primary";
  Modal.open({
    title,
    bodyNode: el("div", {}, [
      el("div", { class:"note", text: message }),
      el("div", { style:"height:12px" }),
      el("div", { class:"btnrow" }, [
        el("button", { class:"btn", onClick: Modal.close }, ["Cancel"]),
        el("button", {
          class: btnClass,
          onClick: () => {
            try{ if(typeof onConfirm === "function") onConfirm(); }
            finally{ Modal.close(); }
          }
        }, [confirmText])
      ])
    ])
  });
}

/********************
 * 8) Popover
 ********************/
let __pop = null;
let __popoverLockedScroll = false;

function PopoverEnsure(){
  if(__pop) return __pop;

  const host = el("div", { class:"popHost", id:"popHost" }, []);
  const backdrop = el("div", { class:"popBackdrop", id:"popBackdrop" }, []);
  const panel = el("div", { class:"popPanel", id:"popPanel" }, []);

  backdrop.addEventListener("click", PopoverClose);

  host.appendChild(backdrop);
  host.appendChild(panel);
  document.body.appendChild(host);

  __pop = { host, panel };
  return __pop;
}

export function PopoverOpen(anchorEl, bodyNode){
  const { host, panel } = PopoverEnsure();

  panel.innerHTML = "";
  if(bodyNode) panel.appendChild(bodyNode);

  host.classList.add("show");
  host.style.display = "block";

  if(!document.body.classList.contains("modalOpen")){
    lockBodyScroll();
    __popoverLockedScroll = true;
  }else{
    __popoverLockedScroll = false;
  }

  const r = anchorEl.getBoundingClientRect();
  const pad = 12;

  const pw = panel.offsetWidth || Math.min(420, window.innerWidth - 24);

  let left = r.left;
  left = Math.max(pad, Math.min(left, window.innerWidth - pw - pad));

  let top = r.bottom + 10;
  const ph = panel.offsetHeight || 320;

  if(top + ph > window.innerHeight - pad){
    top = Math.max(pad, r.top - ph - 10);
  }

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top  = `${Math.round(top)}px`;
}

export function PopoverClose(){
  const p = PopoverEnsure();
  p.host.classList.remove("show");
  p.host.style.display = "none";
  p.panel.innerHTML = "";

  if(__popoverLockedScroll){
    __popoverLockedScroll = false;

    const modalHost = document.getElementById("modalHost");
    const modalIsOpen = !!(modalHost && modalHost.classList.contains("show"));

    if(!modalIsOpen){
      unlockBodyScroll();
    }
  }
}
