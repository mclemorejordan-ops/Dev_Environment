/********************
 * settings.js — Phase 3.1
 * - Settings screen builder + handlers
 * - Uses injected dependencies (no globals)
 ********************/

export function initSettings({
  getState,
  Storage,
  Modal,
  el,
  $,
  showToast,
  appStorageBytes,
  bytesToNice,

  // backup functions (from backup.js)
  exportBackupJSON,
  importBackupJSON,
  downloadTextFile,

  // versioning UI (from versioning.js)
  openVersionModal
}){
  if(typeof getState !== "function") throw new Error("initSettings requires getState()");
  if(!Storage) throw new Error("initSettings requires Storage");
  if(!Modal) throw new Error("initSettings requires Modal");
  if(typeof el !== "function") throw new Error("initSettings requires el()");
  if(typeof $ !== "function") throw new Error("initSettings requires $()");

  // ✅ Hardening: fail-fast if any injected helper is missing/renamed
  if(typeof showToast !== "function") throw new Error("initSettings requires showToast()");
  if(typeof appStorageBytes !== "function") throw new Error("initSettings requires appStorageBytes()");
  if(typeof bytesToNice !== "function") throw new Error("initSettings requires bytesToNice()");

  if(typeof exportBackupJSON !== "function") throw new Error("initSettings requires exportBackupJSON()");
  if(typeof importBackupJSON !== "function") throw new Error("initSettings requires importBackupJSON()");
  if(typeof downloadTextFile !== "function") throw new Error("initSettings requires downloadTextFile()");

  if(typeof openVersionModal !== "function") throw new Error("initSettings requires openVersionModal()");

  function confirmDanger({ title, message, confirmText, onConfirm }){
    Modal.open({
      title: title || "Confirm",
      bodyNode: el("div", {}, [
        el("div", { class:"note", text: message || "Are you sure?" }),
        el("div", { style:"height:12px" }),
        el("div", { class:"btnrow" }, [
          el("button", { class:"btn", onClick: Modal.close }, ["Cancel"]),
          el("button", {
            class:"btn danger",
            onClick: () => { try{ onConfirm && onConfirm(); } finally { Modal.close(); } }
          }, [confirmText || "Confirm"])
        ])
      ])
    });
  }

  function renderSettingsView(){
    const state = getState();

    const storageNice = bytesToNice(appStorageBytes());

    const root = el("div", { class:"grid" }, [

      // About / Version
      el("div", { class:"card" }, [
        el("div", { class:"note", text:"About" }),
        el("div", { style:"height:10px" }),
        el("div", { class:"btnrow" }, [
          el("button", { class:"btn", onClick: () => openVersionModal() }, ["Version / Updates"]),
        ])
      ]),

      // Friends (Beta)
el("div", { class:"card" }, (() => {
  // lightweight local UI state (module-scoped via closure)
  renderSettingsView._socialUI = renderSettingsView._socialUI || {};
  const ui = renderSettingsView._socialUI;

  const configured = (typeof Social !== "undefined" && Social.isConfigured) ? Social.isConfigured() : false;
  const user = (typeof Social !== "undefined" && Social.getUser) ? Social.getUser() : null;

  ui.friendId = ui.friendId ?? "";
  ui.supabaseUrl = ui.supabaseUrl ?? "";
  ui.supabaseAnon = ui.supabaseAnon ?? "";

  // Try to read existing config if available
  try{
    if(Social && Social.getConfig){
      const cfg = Social.getConfig() || {};
      ui.supabaseUrl = ui.supabaseUrl || (cfg.url || "");
      ui.supabaseAnon = ui.supabaseAnon || (cfg.anonKey || "");
    }
  }catch(_){}

  const followList = (Social && Social.getFollows) ? (Social.getFollows() || []) : [];

  const copy = async (txt) => {
    try{
      await navigator.clipboard.writeText(String(txt || ""));
      showToast("Copied");
    }catch(_){
      showToast("Copy failed");
    }
  };

  const header = [
    el("div", { class:"note", text:"Friends (Beta)" }),
    el("div", { style:"height:10px" }),
    el("div", { class:"note", text:"Share your code, follow friends, and view highlights in Friends." }),
    el("div", { style:"height:12px" }),
  ];

  const configUI = [
    el("div", { class:"setRow" }, [
      el("div", {}, [
        el("div", { style:"font-weight:820;", text:"Supabase URL" }),
        el("div", { class:"meta", text:"https://xxxx.supabase.co" })
      ]),
      el("input", {
        type:"text",
        value: ui.supabaseUrl,
        onInput: (e) => { ui.supabaseUrl = e.target.value || ""; }
      })
    ]),
    el("div", { class:"setRow" }, [
      el("div", {}, [
        el("div", { style:"font-weight:820;", text:"Supabase anon key" }),
        el("div", { class:"meta", text:"Settings → API → anon public key" })
      ]),
      el("input", {
        type:"password",
        value: ui.supabaseAnon,
        onInput: (e) => { ui.supabaseAnon = e.target.value || ""; }
      })
    ]),
    el("div", { style:"height:10px" }),
    el("div", { class:"btnrow" }, [
      el("button", {
        class:"btn primary",
        onClick: async () => {
          try{
            if(!Social || !Social.configure) throw new Error("Social not available");
            await Social.configure({ url: ui.supabaseUrl, anonKey: ui.supabaseAnon });
            showToast("Saved");
          }catch(e){
            showToast(e?.message || "Save failed");
          }
        }
      }, ["Save"]),
      el("button", {
        class:"btn",
        onClick: async () => {
          try{
            if(!Social || !Social.configure) return;
            await Social.configure({ url:"", anonKey:"" });
            showToast("Disconnected");
          }catch(_){
            showToast("Disconnect failed");
          }
        }
      }, ["Disconnect"])
    ])
  ];

  const authUI = [
    el("div", { style:"height:14px" }),
    el("div", { class:"note", text: configured ? "Sign-in" : "Sign-in (configure first)" }),
    el("div", { style:"height:10px" }),
    configured ? el("div", { class:"btnrow" }, [
      !user ? el("button", {
        class:"btn primary",
        onClick: async () => {
          try{
            await Social.signInWithOAuth("google");
          }catch(e){
            showToast(e?.message || "Google sign-in failed");
          }
        }
      }, ["Continue with Google"]) : null,

      user ? el("button", {
        class:"btn",
        onClick: async () => {
          try{
            await Social.signOut();
            showToast("Signed out");
          }catch(_){}
        }
      }, ["Sign out"]) : null,

      el("button", {
        class:"btn",
        onClick: async () => {
          try{
            await Social.refreshUser();
            if(Social.getUser && Social.getUser()){
              Social.startFeed && Social.startFeed();
              Social.fetchFollows && await Social.fetchFollows();
            }
            showToast("Refreshed");
          }catch(_){
            showToast("Refresh failed");
          }
        }
      }, ["Refresh"])
    ].filter(Boolean)) : null
  ];

  const codeUI = [
    el("div", { style:"height:14px" }),
    el("div", { class:"note", text:"Your friend code" }),
    el("div", { style:"height:10px" }),
    el("div", { class:"kpi" }, [
      el("div", { class:"big", text: user ? user.id : "—" }),
      el("div", { class:"small", text: user ? "Share this code so friends can follow you." : "Sign in to get your code." })
    ]),
    user ? el("div", { class:"btnrow", style:"margin-top:10px;" }, [
      el("button", { class:"btn", onClick: () => copy(user.id) }, ["Copy code"])
    ]) : null
  ].filter(Boolean);

  const followUI = [
    el("div", { style:"height:14px" }),
    el("div", { class:"note", text:"Follow a friend" }),
    el("div", { style:"height:10px" }),
    el("div", { class:"btnrow" }, [
      el("input", {
        type:"text",
        placeholder:"Paste friend code",
        value: ui.friendId,
        onInput: (e) => { ui.friendId = e.target.value || ""; }
      }),
      el("button", {
        class:"btn primary",
        onClick: async () => {
          try{
            if(!user) throw new Error("Sign in first");
            const id = String(ui.friendId || "").trim();
            if(!id) throw new Error("Friend code required");
            await Social.follow(id);
            ui.friendId = "";
            Social.fetchFollows && await Social.fetchFollows();
            showToast("Following");
          }catch(e){
            showToast(e?.message || "Follow failed");
          }
        }
      }, ["Follow"])
    ])
  ];

  const followingUI = [
    el("div", { style:"height:14px" }),
    el("div", { class:"note", text:"Following" }),
    el("div", { style:"height:10px" }),
    !followList.length
      ? el("div", { class:"note", text:"Not following anyone yet." })
      : el("div", {}, followList.map(fid => (
          el("div", { class:"rowBetween", style:"margin:8px 0;" }, [
            el("div", { class:"note", text: fid }),
            el("button", {
              class:"btn",
              onClick: async () => {
                try{
                  await Social.unfollow(fid);
                  Social.fetchFollows && await Social.fetchFollows();
                  showToast("Unfollowed");
                }catch(_){
                  showToast("Unfollow failed");
                }
              }
            }, ["Unfollow"])
          ])
        )))
  ];

  return [
    ...header,
    ...configUI,
    ...authUI,
    ...codeUI,
    ...followUI,
    ...followingUI
  ];
})()),

      // Data tools
      el("div", { class:"card" }, [
        el("div", { class:"note", text:"Data" }),
        el("div", { style:"height:8px" }),
        el("div", { class:"note", text:`Local storage: ${storageNice}` }),
        el("div", { style:"height:12px" }),

        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn",
            onClick: () => {
              try{
                const json = exportBackupJSON();
                const fname = `gym-dashboard-backup-${new Date().toISOString().slice(0,10)}.json`;
                downloadTextFile(fname, json, "application/json");
                showToast("Exported backup");
              }catch(e){
                showToast("Export failed");
              }
            }
          }, ["Export backup"])
        ]),

        el("div", { style:"height:10px" }),

        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn",
            onClick: () => {
              const input = el("input", {
                type:"file",
                accept:"application/json"
              });

              input.addEventListener("change", async () => {
                const f = input.files && input.files[0];
                if(!f) return;

                try{
                  const text = await f.text();
                  confirmDanger({
                    title: "Import backup",
                    message: "This will overwrite your current data on this device. Continue?",
                    confirmText: "Import",
                    onConfirm: () => {
                      try{
                        importBackupJSON(text);
                        showToast("Imported backup");
                        location.reload();
                      }catch(e){
                        showToast("Import failed");
                      }
                    }
                  });
                }catch(e){
                  showToast("Could not read file");
                }
              });

              input.click();
            }
          }, ["Import backup"])
        ])
      ]),

      // Danger zone
      el("div", { class:"card" }, [
        el("div", { class:"note", text:"Danger zone" }),
        el("div", { style:"height:10px" }),
        el("div", { class:"btnrow" }, [
          el("button", {
            class:"btn danger",
            onClick: () => {
              confirmDanger({
                title:"Reset app",
                message:"This clears all data from this device (localStorage). This cannot be undone.",
                confirmText:"Reset",
                onConfirm: () => {
                  try{
                    // Hard reset local data
                    Storage.reset();
                    showToast("Reset complete");
                    location.reload();
                  }catch(_){
                    showToast("Reset failed");
                  }
                }
              });
            }
          }, ["Reset local data"])
        ])
      ])

    ]);

    return root;
  }

  return { renderSettingsView };
}
