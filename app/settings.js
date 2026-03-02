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
