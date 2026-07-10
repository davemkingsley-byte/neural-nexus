/*
 * calendar.js — pure date/working-day helpers.
 *
 * Dates are handled as integer "day numbers" (days since 1970-01-01 UTC) to
 * dodge timezone/DST drift. The Gantt x-axis is calendar days; the scheduler
 * works in working-day indices. This module converts between them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.PM = root.PM || {}; root.PM.Calendar = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MS = 86400000;
  var DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  // "YYYY-MM-DD" -> day number (or null)
  function parseISO(str) {
    if (typeof str === 'number') return str;
    if (!str) return null;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(str).trim());
    if (!m) return null;
    return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / MS);
  }

  function toISO(dayNum) {
    var d = new Date(dayNum * MS);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  // 0=Sun .. 6=Sat. 1970-01-01 (dayNum 0) was a Thursday (4).
  function dow(dayNum) { return ((dayNum + 4) % 7 + 7) % 7; }

  function parts(dayNum) {
    var d = new Date(dayNum * MS);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: dow(dayNum) };
  }

  // "Mon 7/13/26"
  function fmt(dayNum) {
    if (dayNum == null || !isFinite(dayNum)) return '';
    var p = parts(dayNum);
    return DOW_NAMES[p.dow] + ' ' + (p.m + 1) + '/' + p.d + '/' + String(p.y).slice(-2);
  }

  function fmtLong(dayNum) {
    if (dayNum == null || !isFinite(dayNum)) return '';
    var p = parts(dayNum);
    return DOW_NAMES[p.dow] + ', ' + MON_NAMES[p.m] + ' ' + p.d + ', ' + p.y;
  }

  function todayDayNum() {
    var now = new Date();
    return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS);
  }

  // cfg: { workingDays:[1..5], holidays:[ISO strings] }
  function makeCalendar(cfg) {
    cfg = cfg || {};
    var wd = (cfg.workingDays && cfg.workingDays.length) ? cfg.workingDays : [1, 2, 3, 4, 5];
    var workSet = {};
    wd.forEach(function (d) { workSet[d] = true; });
    var holSet = {};
    (cfg.holidays || []).forEach(function (h) {
      var n = parseISO(h);
      if (n != null) holSet[n] = true;
    });
    // Guard against an all-nonworking calendar (would loop forever).
    var anyWorking = [0, 1, 2, 3, 4, 5, 6].some(function (d) { return workSet[d]; });
    if (!anyWorking) { workSet = { 1: true, 2: true, 3: true, 4: true, 5: true }; }

    function isWorking(dayNum) { return !!workSet[dow(dayNum)] && !holSet[dayNum]; }

    function snapForward(dayNum) {
      var d = dayNum, guard = 0;
      while (!isWorking(d) && guard++ < 3660) d++;
      return d;
    }

    // idx (working-day index, 0 == anchor) -> calendar day number
    function indexToDay(anchor, idx) {
      var d = anchor, i = 0, guard = 0;
      idx = Math.max(0, Math.round(idx));
      while (i < idx && guard++ < 10000000) {
        d++;
        if (isWorking(d)) i++;
      }
      return d;
    }

    // calendar day number -> working-day index (day snapped forward if nonworking)
    function dayToIndex(anchor, dayNum) {
      if (dayNum <= anchor) return 0;
      var d = anchor, i = 0, guard = 0;
      while (d < dayNum && guard++ < 10000000) {
        d++;
        if (isWorking(d)) i++;
      }
      return i;
    }

    // Precompute index->day for [0..maxIdx] in one linear pass.
    function buildTable(anchor, maxIdx) {
      var table = [anchor];
      var d = anchor, i = 0, guard = 0;
      while (i < maxIdx && guard++ < 5000000) {
        d++;
        if (isWorking(d)) { i++; table.push(d); }
      }
      return table;
    }

    return {
      workingDays: wd,
      isWorking: isWorking,
      snapForward: snapForward,
      indexToDay: indexToDay,
      dayToIndex: dayToIndex,
      buildTable: buildTable
    };
  }

  return {
    MS: MS,
    DOW_NAMES: DOW_NAMES,
    MON_NAMES: MON_NAMES,
    parseISO: parseISO,
    toISO: toISO,
    dow: dow,
    parts: parts,
    fmt: fmt,
    fmtLong: fmtLong,
    todayDayNum: todayDayNum,
    makeCalendar: makeCalendar
  };
}));
