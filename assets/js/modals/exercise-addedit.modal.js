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

