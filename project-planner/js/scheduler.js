/*
 * scheduler.js — pure critical-path scheduling engine for ProjectDesk.
 *
 * Works in "working-day index" space (integers). Index 0 == the project's
 * first working day. All duration/dependency math is integer arithmetic here;
 * the model layer is responsible for converting calendar dates <-> indices.
 *
 * Task shape expected by schedule():
 *   { id, duration, outlineLevel, predecessors:[{id,type,lag}], percentComplete, constraintIndex }
 *     - duration        : whole working days, >= 0 (0 == milestone)
 *     - outlineLevel     : 1-based indent depth (1 == top level)
 *     - predecessors     : type is one of 'FS','SS','FF','SF'; lag in working days (may be negative)
 *     - constraintIndex  : optional Start-No-Earlier-Than lower bound (working-day index) or null
 *
 * A task is a *summary* when a later task in list order is indented under it.
 * Summary start/finish/%complete are rolled up from children (not scheduled
 * from their own duration or predecessors).
 *
 * Convention: es (early start) is inclusive; ef (early finish) is EXCLUSIVE.
 * A duration-d task occupies working days [es, es+d).  Milestone -> ef == es.
 * The grid shows the inclusive finish day as index (ef - 1) for d >= 1.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.PM = root.PM || {}; root.PM.Scheduler = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEP_TYPES = ['FS', 'SS', 'FF', 'SF'];

  // Build parent/child structure from ordered tasks + their outline levels.
  function computeHierarchy(tasks) {
    var n = tasks.length;
    var childIds = [];
    var parentIndex = new Array(n).fill(-1);
    var isSummary = new Array(n).fill(false);
    for (var i = 0; i < n; i++) childIds.push([]);
    var stack = []; // indices of currently-open ancestors
    for (var j = 0; j < n; j++) {
      var lvl = lvlOf(tasks[j]);
      while (stack.length && lvlOf(tasks[stack[stack.length - 1]]) >= lvl) stack.pop();
      if (stack.length) {
        var p = stack[stack.length - 1];
        parentIndex[j] = p;
        childIds[p].push(j);
        isSummary[p] = true;
      }
      stack.push(j);
    }
    return { childIds: childIds, parentIndex: parentIndex, isSummary: isSummary };
  }

  function lvlOf(t) { return Math.max(1, t.outlineLevel || 1); }

  // Detect a dependency cycle among tasks. Returns array of ids in a cycle, or null.
  function detectCycle(tasks, idToIndex) {
    var n = tasks.length;
    var WHITE = 0, GRAY = 1, BLACK = 2;
    var color = new Array(n).fill(WHITE);
    var stack = [];
    var found = null;

    function visit(i) {
      if (found) return;
      color[i] = GRAY;
      stack.push(i);
      var preds = tasks[i].predecessors || [];
      for (var k = 0; k < preds.length; k++) {
        var pi = idToIndex[preds[k].id];
        if (pi == null) continue;
        if (pi === i) continue; // a self-reference is a no-op, not a cycle
        if (color[pi] === GRAY) {
          // back edge -> cycle from pi..i
          var cyc = [];
          for (var s = stack.length - 1; s >= 0; s--) {
            cyc.push(tasks[stack[s]].id);
            if (stack[s] === pi) break;
          }
          found = cyc.reverse();
          return;
        }
        if (color[pi] === WHITE) { visit(pi); if (found) return; }
      }
      color[i] = BLACK;
      stack.pop();
    }

    for (var i = 0; i < n && !found; i++) if (color[i] === WHITE) visit(i);
    return found;
  }

  function normLag(l) { var v = Number(l); return isFinite(v) ? Math.round(v) : 0; }
  function normType(t) { t = String(t || 'FS').toUpperCase(); return DEP_TYPES.indexOf(t) >= 0 ? t : 'FS'; }

  // Forward pass: earliest start index required for a successor, given a
  // predecessor's early start/finish and the successor's own duration.
  function requiredStart(type, predEs, predEf, lag, succDur) {
    switch (type) {
      case 'SS': return predEs + lag;
      case 'FF': return predEf + lag - succDur;
      case 'SF': return predEs + lag - succDur;
      case 'FS':
      default: return predEf + lag;
    }
  }

  // Backward pass: latest finish index allowed for a predecessor, given a
  // successor's late start/finish and the predecessor's own duration.
  function latestFinish(type, succLs, succLf, lag, predDur) {
    switch (type) {
      case 'SS': return (succLs - lag) + predDur;   // pred.LS = succ.LS - lag
      case 'FF': return succLf - lag;
      case 'SF': return (succLf - lag) + predDur;   // pred.LS = succ.LF - lag
      case 'FS':
      default: return succLs - lag;
    }
  }

  function schedule(tasks) {
    var n = tasks.length;
    var hier = computeHierarchy(tasks);
    var childIds = hier.childIds, parentIndex = hier.parentIndex, isSummary = hier.isSummary;

    var idToIndex = {};
    for (var i = 0; i < n; i++) idToIndex[tasks[i].id] = i;

    var cycleIds = detectCycle(tasks, idToIndex);
    var hasCycle = !!cycleIds;

    var dur = tasks.map(function (t) { return Math.max(0, Math.round(Number(t.duration) || 0)); });

    // Order for rolling summaries up: deepest outline level first.
    var summaryOrder = [];
    for (var s = 0; s < n; s++) if (isSummary[s]) summaryOrder.push(s);
    summaryOrder.sort(function (a, b) { return lvlOf(tasks[b]) - lvlOf(tasks[a]); });

    var es = new Array(n).fill(0);
    var ef = new Array(n).fill(0);
    var predReq = new Array(n).fill(0); // dependency-demanded start (conflict detection)

    // --- Forward pass (longest-path relaxation; converges without cycles) ---
    var maxIter = n + 2;
    for (var iter = 0; iter <= maxIter; iter++) {
      var changed = false;

      for (var a = 0; a < n; a++) {
        if (isSummary[a]) continue; // summaries are rolled up, not scheduled
        var t = tasks[a];
        var isMSO = t.constraintType === 'MSO' && t.constraintIndex != null && isFinite(t.constraintIndex);
        var start = 0;
        if (t.constraintIndex != null && isFinite(t.constraintIndex)) {
          start = Math.max(start, Math.round(t.constraintIndex));
        }
        var predRequired = 0; // latest start demanded by dependencies
        var preds = t.predecessors || [];
        for (var p = 0; p < preds.length; p++) {
          var pi = idToIndex[preds[p].id];
          if (pi == null || pi === a) continue;
          if (hasCycle) continue; // avoid runaway when the graph is broken
          var req = requiredStart(normType(preds[p].type), es[pi], ef[pi], normLag(preds[p].lag), dur[a]);
          if (req > predRequired) predRequired = req;
        }
        // Inherit predecessor constraints from ancestor summaries: a dependency
        // placed on a summary must delay that summary's whole subtree.
        if (!hasCycle) {
          for (var anc = parentIndex[a]; anc >= 0; anc = parentIndex[anc]) {
            var aPreds = tasks[anc].predecessors || [];
            for (var q = 0; q < aPreds.length; q++) {
              var api = idToIndex[aPreds[q].id];
              if (api == null || api === a || api === anc) continue;
              var reqA = requiredStart(normType(aPreds[q].type), es[api], ef[api], normLag(aPreds[q].lag), dur[a]);
              if (reqA > predRequired) predRequired = reqA;
            }
          }
        }
        if (isMSO) {
          // Must-Start-On pins the start exactly; dependencies do not move it.
          // (A pred demanding a later start is a schedule conflict — flagged below.)
          start = Math.max(0, Math.round(t.constraintIndex));
        } else {
          start = Math.max(start, predRequired);
        }
        if (start < 0) start = 0; // never schedule before project start
        var newEf = start + dur[a];
        if (es[a] !== start || ef[a] !== newEf) { es[a] = start; ef[a] = newEf; changed = true; }
        predReq[a] = predRequired;
      }

      // Roll summaries up (children -> parent), deepest first.
      for (var so = 0; so < summaryOrder.length; so++) {
        var si = summaryOrder[so];
        var kids = childIds[si];
        if (!kids.length) continue;
        var lo = Infinity, hi = -Infinity;
        for (var c = 0; c < kids.length; c++) {
          if (es[kids[c]] < lo) lo = es[kids[c]];
          if (ef[kids[c]] > hi) hi = ef[kids[c]];
        }
        if (es[si] !== lo || ef[si] !== hi) { es[si] = lo; ef[si] = hi; changed = true; }
      }

      if (!changed) break;
    }

    var projectFinish = 0;
    for (var q = 0; q < n; q++) if (ef[q] > projectFinish) projectFinish = ef[q];

    // --- Backward pass (late dates) over leaf tasks via successor graph ---
    var successors = [];
    for (var z = 0; z < n; z++) successors.push([]);
    if (!hasCycle) {
      for (var b = 0; b < n; b++) {
        var bp = tasks[b].predecessors || [];
        for (var bpi = 0; bpi < bp.length; bpi++) {
          var predIdx = idToIndex[bp[bpi].id];
          if (predIdx == null || predIdx === b) continue;
          successors[predIdx].push({ index: b, type: normType(bp[bpi].type), lag: normLag(bp[bpi].lag) });
        }
      }
    }

    var lf = new Array(n).fill(projectFinish);
    if (!hasCycle) {
      for (var it2 = 0; it2 <= maxIter; it2++) {
        var changed2 = false;
        for (var d = 0; d < n; d++) {
          if (isSummary[d]) continue;
          var bound = projectFinish;
          var succ = successors[d];
          if (succ.length) {
            bound = Infinity;
            for (var sc = 0; sc < succ.length; sc++) {
              var so2 = succ[sc];
              if (isSummary[so2.index]) continue; // ignore summary successors
              var succLf = lf[so2.index];
              var succLs = succLf - dur[so2.index];
              var cand = latestFinish(so2.type, succLs, succLf, so2.lag, dur[d]);
              if (cand < bound) bound = cand;
            }
            if (!isFinite(bound)) bound = projectFinish;
          }
          // A late finish can never exceed the project finish; without this a
          // finish-driving task feeding an SS/SF/negative-lag successor gets
          // false positive slack and drops off the critical path.
          if (bound > projectFinish) bound = projectFinish;
          if (lf[d] !== bound) { lf[d] = bound; changed2 = true; }
        }
        // Roll summaries: parent LS/LF span children.
        for (var so3 = 0; so3 < summaryOrder.length; so3++) {
          var si2 = summaryOrder[so3];
          var kids2 = childIds[si2];
          if (!kids2.length) continue;
          var hiLf = -Infinity;
          for (var c2 = 0; c2 < kids2.length; c2++) if (lf[kids2[c2]] > hiLf) hiLf = lf[kids2[c2]];
          if (lf[si2] !== hiLf) { lf[si2] = hiLf; changed2 = true; }
        }
        if (!changed2) break;
      }
    }

    // --- Assemble results ---
    var wbs = computeWBS(tasks);
    var results = [];
    for (var r = 0; r < n; r++) {
      var lsR = lf[r] - dur[r];
      var slack;
      if (isSummary[r]) {
        // Summary slack = min child slack (drives whether it's on the critical path).
        slack = Infinity;
        var kk = childIds[r];
        for (var kc = 0; kc < kk.length; kc++) {
          var childSlack = (lf[kk[kc]] - dur[kk[kc]]) - es[kk[kc]];
          if (childSlack < slack) slack = childSlack;
        }
        if (!isFinite(slack)) slack = 0;
      } else {
        slack = lsR - es[r];
      }
      // A cyclic graph has no valid backward pass — slack would be meaningless
      // noise (lf is just projectFinish). Report null rather than a fake number.
      if (hasCycle) slack = null;
      results.push({
        id: tasks[r].id,
        index: r,
        es: es[r],
        ef: ef[r],
        ls: isSummary[r] ? es[r] : lsR,
        lf: lf[r],
        slack: slack,
        critical: !hasCycle && slack <= 0,
        isSummary: isSummary[r],
        isMilestone: !isSummary[r] && dur[r] === 0,
        constraintViolated: !isSummary[r] && tasks[r].constraintType === 'MSO' &&
          tasks[r].constraintIndex != null && predReq[r] > es[r],
        parentIndex: parentIndex[r],
        childIndices: childIds[r].slice(),
        outlineLevel: lvlOf(tasks[r]),
        wbs: wbs[r],
        duration: dur[r]
      });
    }

    return {
      results: results,
      projectFinish: projectFinish,
      hasCycle: hasCycle,
      cycleIds: cycleIds || null
    };
  }

  // Outline numbers: "1", "1.1", "1.2", "2", ...
  function computeWBS(tasks) {
    var n = tasks.length;
    var out = new Array(n).fill('');
    var counters = []; // counter per depth
    var prevLevel = 0;
    for (var i = 0; i < n; i++) {
      var lvl = lvlOf(tasks[i]);
      if (lvl > prevLevel) {
        while (counters.length < lvl) counters.push(0);
      } else if (lvl < prevLevel) {
        counters.length = lvl;
      }
      counters[lvl - 1] = (counters[lvl - 1] || 0) + 1;
      out[i] = counters.slice(0, lvl).join('.');
      prevLevel = lvl;
    }
    return out;
  }

  return {
    schedule: schedule,
    computeHierarchy: computeHierarchy,
    computeWBS: computeWBS,
    detectCycle: detectCycle,
    DEP_TYPES: DEP_TYPES
  };
}));
