/********************
 * UI Helpers Module
 * File: /app/ui.js
 ********************/

/********************
 * 1) DOM Helpers
 ********************/
export const $  = (sel) => document.querySelector(sel);
export const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let __modalLastFocus = null;
let __modalKeydownHandler = null;

function lockBodyScroll(){
  document.body.classList.add("lock");
}
function unlockBodyScroll(){
  document.body.classList.remove("lock");
}

function __getModalFocusables(sheet){
  if(!sheet) return [];
  return Array.from(sheet.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter(el => !el.disabled && el.offsetParent !== null);
}

export const Modal = {
  // ✅ Backward compatible: adds closeText + onClose (optional)
  open({ title, bodyNode, center = true, size = "md", closeText = null, onClose = null }){
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

    // ✅ Configure the header close button (optional per modal)
    const closeBtn = $("#modalClose");
    if(closeBtn){
      // reset
      closeBtn.textContent = "Close";
      closeBtn.__modalOnClose = null;

      if(closeText != null) closeBtn.textContent = String(closeText);
      if(typeof onClose === "function") closeBtn.__modalOnClose = onClose;
    }

    body.innerHTML = "";
    if(bodyNode) body.appendChild(bodyNode);

    host.classList.add("show");
    host.setAttribute("aria-hidden", "false");

    lockBodyScroll();

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

    // ✅ reset header close button customizations
    const closeBtn = $("#modalClose");
    if(closeBtn){
      closeBtn.textContent = "Close";
      closeBtn.__modalOnClose = null;
    }

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

      // ✅ If a modal provided a custom header-close action, use it
      const fn = closeBtn.__modalOnClose;
      if(typeof fn === "function"){
        try{ fn(e); }catch(_){}
        return;
      }

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
