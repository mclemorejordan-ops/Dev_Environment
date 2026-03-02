/********************
 * attendance-ui.js — Phase 3.5
 * Attendance calendar UI helpers + month engine
 * (keeps the existing behavior from app.js; state is mutated in-place)
 ********************/

export function initAttendanceUI({ getState, Storage, pad2 }){
  if(typeof getState !== "function") throw new Error("initAttendanceUI requires getState()");
  if(!Storage) throw new Error("initAttendanceUI requires Storage");
  if(typeof pad2 !== "function") throw new Error("initAttendanceUI requires pad2()");

  function isTrained(dateISO){
    const state = getState();
    return (state.attendance || []).includes(dateISO);
  }

  function toggleTrained(dateISO){
    const state = getState();
    state.attendance = state.attendance || [];
    const i = state.attendance.indexOf(dateISO);
    if(i >= 0) state.attendance.splice(i, 1);
    else state.attendance.push(dateISO);
    Storage.save(state);
  }

  /********************
   * Attendance Helpers (Step 9)
   ********************/
  function ymFromISO(dateISO){
    const [y,m] = String(dateISO).split("-").map(x => parseInt(x,10));
    return { y, m }; // m = 1..12
  }

  function monthTitle(y, m){
    const d = new Date(y, m-1, 1);
    return d.toLocaleString(undefined, { month:"long", year:"numeric" });
  }

  function daysInMonth(y, m){
    return new Date(y, m, 0).getDate(); // m is 1..12
  }

  function firstDayDow(y, m){
    return new Date(y, m-1, 1).getDay(); // 0=Sun..6=Sat
  }

  function isoForYMD(y, m, d){
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  const AttendanceEngine = {
    ensure(){
      const state = getState();
      state.attendance = state.attendance || [];
    },
    monthCount(y, m){
      const state = getState();
      this.ensure();
      const prefix = `${y}-${pad2(m)}-`;
      return state.attendance.filter(x => String(x).startsWith(prefix)).length;
    },
    clearMonth(y, m){
      const state = getState();
      this.ensure();
      const prefix = `${y}-${pad2(m)}-`;
      state.attendance = state.attendance.filter(x => !String(x).startsWith(prefix));
      Storage.save(state);
    }
  };

  return {
    isTrained,
    toggleTrained,
    ymFromISO,
    monthTitle,
    daysInMonth,
    firstDayDow,
    isoForYMD,
    AttendanceEngine
  };
}
