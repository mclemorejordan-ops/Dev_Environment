/********************
 * progress.js — extracted from app.js (Phase 2.8)
 * - Progress chart helpers
 * - Weight engine + weight chart
 * - formatTime/formatPace helpers
 ********************/

export function initProgress({ getState, Storage, uid, Dates, Modal, el }){
  function round2(n){
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function formatTime(sec){
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2,"0")}`;
  }

  function formatPace(paceSecPerUnit){
    if(paceSecPerUnit === null || !Number.isFinite(paceSecPerUnit)) return "—";
    return `${formatTime(paceSecPerUnit)} / unit`;
  }

  /********************
   * Progress chart
   ********************/
  let __progressChart = null;

  function destroyProgressChart(){
    try{
      if(__progressChart){
        __progressChart.destroy();
        __progressChart = null;
      }
    }catch(e){
      __progressChart = null;
    }
  }

  function downloadCanvasPNG(canvas, filename){
    try{
      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "progress.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }catch(e){
      Modal.open({
        title: "Download failed",
        bodyNode: el("div", {}, [
          el("div", { class:"note", text:"Could not export image. Try again or use a different browser." }),
          el("div", { style:"height:12px" }),
          el("button", { class:"btn primary", onClick: Modal.close }, ["OK"])
        ])
      });
    }
  }

  function buildSeries(type, entries){
    // entries expected ascending by date
    const labels = entries.map(e => e.dateISO);

    if(type === "weightlifting"){
      const topWeight = entries.map(e => Number(e.summary?.bestWeight) || 0);
      const est1RM = entries.map(e => Number(e.summary?.best1RM) || 0);
      const volume = entries.map(e => Number(e.summary?.totalVolume) || 0);
      return { labels, datasets: { topWeight, est1RM, volume } };
    }

    if(type === "cardio"){
      const pace = entries.map(e => (e.summary?.paceSecPerUnit == null ? null : Number(e.summary.paceSecPerUnit)));
      const distance = entries.map(e => Number(e.summary?.distance) || 0);
      const timeSec = entries.map(e => Number(e.summary?.timeSec) || 0);
      return { labels, datasets: { pace, distance, timeSec } };
    }

    // core
    const volume = entries.map(e => Number(e.summary?.totalVolume) || 0);
    return { labels, datasets: { volume } };
  }

  function renderProgressChart(canvas, type, metricKey, series){
    destroyProgressChart();

    let data = [];
    let label = "";

    if(type === "weightlifting"){
      if(metricKey === "topWeight"){ data = series.datasets.topWeight; label = "Top Weight"; }
      else if(metricKey === "est1RM"){ data = series.datasets.est1RM; label = "Estimated 1RM (Epley)"; }
      else { data = series.datasets.volume; label = "Volume"; }
    } else if(type === "cardio"){
      if(metricKey === "pace"){ data = series.datasets.pace; label = "Pace (sec/unit) (lower is better)"; }
      else if(metricKey === "distance"){ data = series.datasets.distance; label = "Distance"; }
      else { data = series.datasets.timeSec; label = "Time (sec)"; }
    } else {
      data = series.datasets.volume;
      label = "Core Volume";
    }

    const ctx = canvas.getContext("2d");
    __progressChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: series.labels,
        datasets: [{
          label,
          data,
          tension: 0.25,
          spanGaps: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true } },
        scales: { y: { beginAtZero: true } }
      }
    });

    return __progressChart;
  }

  /********************
   * Weight engine + chart
   ********************/
  const WeightEngine = {
    ensure(){
      const state = getState();
      state.logs = state.logs || { workouts: [], weight: [], protein: [] };
      state.logs.weight = state.logs.weight || [];
    },

    add(dateISO, weight){
      const state = getState();
      this.ensure();
      const d = String(dateISO || Dates.todayISO());
      const w = Number(weight);
      if(!Number.isFinite(w) || w <= 0) throw new Error("Enter a valid weight.");

      // Upsert by date (one entry per day)
      const idx = state.logs.weight.findIndex(x => x.dateISO === d);
      const entry = { id: uid("wt"), dateISO: d, weight: round2(w), createdAt: Date.now() };
      if(idx >= 0) state.logs.weight[idx] = { ...state.logs.weight[idx], ...entry };
      else state.logs.weight.push(entry);

      Storage.save(state);
      return entry;
    },

    remove(id){
      const state = getState();
      this.ensure();
      const idx = state.logs.weight.findIndex(x => x.id === id);
      if(idx >= 0){
        state.logs.weight.splice(idx, 1);
        Storage.save(state);
      }
    },

    listDesc(){
      const state = getState();
      this.ensure();
      const arr = [...state.logs.weight];
      arr.sort((a,b) => (b.dateISO || "").localeCompare(a.dateISO || "") || (b.createdAt||0)-(a.createdAt||0));
      return arr;
    },

    listAsc(){
      return this.listDesc().reverse();
    },

    latest(){
      const d = this.listDesc();
      return d[0] || null;
    },

    previous(){
      const d = this.listDesc();
      return d[1] || null;
    },

    delta(){
      const a = this.latest();
      const b = this.previous();
      if(!a || !b) return null;
      return round2((a.weight || 0) - (b.weight || 0));
    },

    avg7(dateISO){
      const state = getState();
      // 7-day window ending at dateISO (inclusive)
      this.ensure();
      const end = new Date(String(dateISO || Dates.todayISO()) + "T00:00:00");
      const start = new Date(end);
      start.setDate(start.getDate() - 6);

      const items = state.logs.weight.filter(x => {
        const d = new Date(x.dateISO + "T00:00:00");
        return d >= start && d <= end;
      });

      if(items.length === 0) return null;
      const avg = items.reduce((sum,x) => sum + (Number(x.weight)||0), 0) / items.length;
      return round2(avg);
    }
  };

  let __weightChart = null;

  function destroyWeightChart(){
    try{
      if(__weightChart){
        __weightChart.destroy();
        __weightChart = null;
      }
    }catch(e){
      __weightChart = null;
    }
  }

  function renderWeightChart(canvas, entriesAsc){
    destroyWeightChart();
    const labels = entriesAsc.map(e => e.dateISO);
    const data = entriesAsc.map(e => Number(e.weight) || 0);

    const ctx = canvas.getContext("2d");
    __weightChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Bodyweight",
          data,
          tension: 0.25
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true } },
        scales: { y: { beginAtZero: false } }
      }
    });

    return __weightChart;
  }

  const {
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
}
