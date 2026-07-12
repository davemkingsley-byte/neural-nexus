/*
 * model.js — project state, editing operations, scheduling glue, persistence.
 *
 * Owns the single source of truth (a Project) and exposes mutation methods that
 * keep the schedule recomputed and notify subscribers. Task ids are stable;
 * the grid/dependencies address rows by 1-based row number for display only.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./scheduler.js'), require('./calendar.js'));
  } else {
    root.PM = root.PM || {};
    root.PM.Model = factory(root.PM.Scheduler, root.PM.Calendar);
  }
}(typeof self !== 'undefined' ? self : this, function (Scheduler, Cal) {
  'use strict';

  var STORAGE_KEY = 'projectdesk.current.v1';
  var UNDO_LIMIT = 60;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // ---- Duration parsing/formatting (working days) --------------------------
  var MAX_DURATION = 100000; // working days (~380 yrs) — guards against OOM

  // Accepts: "5", "5d", "2w" (=10d), "1mo" (=20d), "0" (milestone).
  function parseDuration(str) {
    if (typeof str === 'number') return clamp(Math.round(str), 0, MAX_DURATION);
    if (str == null) return 1;
    var s = String(str).trim().toLowerCase();
    if (s === '') return 0;
    var m = /^(-?\d+(?:\.\d+)?)\s*(mo|mons?|months?|w|wk|wks?|weeks?|d|days?)?$/.exec(s);
    if (!m) return null;
    var val = parseFloat(m[1]);
    var unit = m[2] || 'd';
    var mult = 1;
    if (/^mo|^mon|^month/.test(unit)) mult = 20;
    else if (/^w|^wk|^week/.test(unit)) mult = 5;
    return clamp(Math.round(val * mult), 0, MAX_DURATION);
  }
  function formatDuration(days) {
    days = Math.max(0, Math.round(days || 0));
    if (days === 0) return '0 days';
    return days + (days === 1 ? ' day' : ' days');
  }
  function formatMoney(n) {
    n = Math.round(Number(n) || 0);
    var neg = n < 0; if (neg) n = -n;
    return (neg ? '-$' : '$') + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // ---- Risk management ------------------------------------------------------
  var RISK_CATEGORIES = ['scope', 'schedule', 'cost', 'technical', 'resource', 'external', 'other'];
  var RISK_STATUSES = ['open', 'mitigating', 'closed', 'realized'];

  // 5×5 probability × impact — standard qualitative bands.
  function riskSeverity(score) {
    if (score >= 15) return 'critical';
    if (score >= 10) return 'high';
    if (score >= 5) return 'medium';
    return 'low';
  }

  function normalizeRisk(r, taskIdSet) {
    // Only fall back to 3 for genuinely absent/non-numeric input — an explicit
    // 0 must clamp to 1, not be treated as "missing" and inflated to 3.
    var np = Number(r.probability), ni = Number(r.impact);
    var p = clamp(Math.round(isFinite(np) ? np : 3), 1, 5);
    var i = clamp(Math.round(isFinite(ni) ? ni : 3), 1, 5);
    return {
      id: r.id,
      title: r.title != null ? String(r.title) : '',
      description: r.description != null ? String(r.description) : '',
      category: RISK_CATEGORIES.indexOf(r.category) >= 0 ? r.category : 'other',
      probability: p,
      impact: i,
      owner: r.owner != null ? String(r.owner) : '',
      status: RISK_STATUSES.indexOf(r.status) >= 0 ? r.status : 'open',
      mitigation: r.mitigation != null ? String(r.mitigation) : '',
      contingency: r.contingency != null ? String(r.contingency) : '',
      taskIds: (r.taskIds || []).filter(function (id, idx, a) {
        return taskIdSet[id] && a.indexOf(id) === idx;
      }),
      reviewISO: r.reviewISO || null,
      createdISO: r.createdISO || null,
      closedISO: r.closedISO || null
    };
  }

  // ---- Predecessor token parsing/formatting --------------------------------
  // token: "<row>[TYPE][±lag]" e.g. "3", "3FS", "2SS+1", "4FF-2"
  function parsePredecessors(str, tasks, ownerId) {
    if (!str || !String(str).trim()) return [];
    var out = [];
    String(str).split(/[,;]/).forEach(function (tok) {
      tok = tok.trim().toUpperCase().replace(/\s+/g, '');
      if (!tok) return;
      var m = /^(\d+)(FS|SS|FF|SF)?([+-]\d+)?$/.exec(tok);
      if (!m) return;
      var row = parseInt(m[1], 10);
      var idx = row - 1;
      if (idx < 0 || idx >= tasks.length) return;
      var id = tasks[idx].id;
      if (ownerId != null && id === ownerId) return; // no self-dependency
      var type = m[2] || 'FS';
      var lag = m[3] ? parseInt(m[3], 10) : 0;
      if (out.some(function (p) { return p.id === id; })) return; // dedupe
      out.push({ id: id, type: type, lag: lag });
    });
    return out;
  }
  function formatPredecessors(preds, tasks) {
    if (!preds || !preds.length) return '';
    var idToRow = {};
    tasks.forEach(function (t, i) { idToRow[t.id] = i + 1; });
    return preds.map(function (p) {
      var row = idToRow[p.id];
      if (row == null) return null;
      var s = '' + row;
      // Show the type whenever it is non-default OR a lag is present, so the
      // token is unambiguous (e.g. "3FS+1" rather than "3+1").
      if ((p.type && p.type !== 'FS') || p.lag) s += (p.type || 'FS');
      if (p.lag) s += (p.lag > 0 ? '+' : '') + p.lag;
      return s;
    }).filter(Boolean).join(', ');
  }

  // ---- Sample project ------------------------------------------------------
  function sampleProject(startISO) {
    var t = [];
    var id = 1;
    function task(name, dur, level, preds, pct, res) {
      return {
        id: id++, name: name, duration: dur, outlineLevel: level,
        predecessors: preds || [], percentComplete: pct || 0,
        resourceIds: res || [], collapsed: false, constraintISO: null, notes: ''
      };
    }
    // ids are assigned in order; predecessors reference ids (resolved below by row)
    var tasks = [
      task('Product Launch', 0, 1),                       // 1 summary
      task('Planning', 0, 2),                             // 2 summary
      task('Define requirements', 5, 3),                  // 3
      task('Market research', 8, 3),                      // 4
      task('Approve scope', 0, 3, [{ i: 3, type: 'FS', lag: 0 }, { i: 4, type: 'FS', lag: 0 }]), // 5 milestone
      task('Design & Build', 0, 2),                       // 6 summary
      task('UX design', 10, 3, [{ i: 5, type: 'FS', lag: 0 }]),  // 7
      task('Frontend development', 15, 3, [{ i: 7, type: 'FS', lag: 0 }]), // 8
      task('Backend development', 12, 3, [{ i: 5, type: 'FS', lag: 0 }]),  // 9
      task('Integration', 5, 3, [{ i: 8, type: 'FS', lag: 0 }, { i: 9, type: 'FS', lag: 0 }]), // 10
      task('Launch', 0, 2),                               // 11 summary
      task('QA & testing', 8, 3, [{ i: 10, type: 'FS', lag: 0 }]),  // 12
      task('Marketing prep', 6, 3, [{ i: 5, type: 'FS', lag: 0 }]), // 13
      task('Go live', 0, 3, [{ i: 12, type: 'FS', lag: 0 }, { i: 13, type: 'FS', lag: 0 }]) // 14 milestone
    ];
    // resolve predecessor row-refs -> ids
    tasks.forEach(function (tk) {
      tk.predecessors = (tk.predecessors || []).map(function (p) {
        return { id: tasks[p.i - 1].id, type: p.type, lag: p.lag };
      });
    });
    var resources = [
      { id: 1, name: 'Alex (PM)', initials: 'AX', color: '#2563eb', rate: 800 },
      { id: 2, name: 'Sam (Design)', initials: 'SM', color: '#7c3aed', rate: 700 },
      { id: 3, name: 'Dev Team', initials: 'DT', color: '#059669', rate: 2400 },
      { id: 4, name: 'QA Team', initials: 'QA', color: '#d97706', rate: 900 }
    ];
    tasks[2].resourceIds = [1];
    tasks[3].resourceIds = [1];
    tasks[6].resourceIds = [2];
    tasks[7].resourceIds = [3];
    tasks[8].resourceIds = [3];
    tasks[9].resourceIds = [3];
    tasks[11].resourceIds = [4];
    tasks[12].resourceIds = [1];
    // mark some progress
    tasks[2].percentComplete = 100;
    tasks[3].percentComplete = 60;
    // demo deadline on the final milestone (~10 weeks after start; currently met)
    tasks[13].deadlineISO = Cal.toISO(Cal.parseISO(startISO) + 70);
    return {
      id: 'sample',
      name: 'Product Launch (sample)',
      startISO: startISO,
      calendar: { workingDays: [1, 2, 3, 4, 5], holidays: [] },
      tasks: tasks,
      resources: resources,
      nextTaskId: 15,
      nextResourceId: 5,
      baseline: null,
      view: { zoom: 'week' }
    };
  }

  function emptyProject(startISO) {
    return {
      id: 'p' + startISO,
      name: 'Untitled Project',
      startISO: startISO,
      calendar: { workingDays: [1, 2, 3, 4, 5], holidays: [] },
      tasks: [],
      resources: [],
      nextTaskId: 1,
      nextResourceId: 1,
      baseline: null,
      view: { zoom: 'week' }
    };
  }

  // ---- Model ----------------------------------------------------------------
  function createModel() {
    var project = null;
    var listeners = [];
    var undoStack = [];
    var redoStack = [];
    var computed = null;  // last recompute result
    var storageKey = STORAGE_KEY; // per-project localStorage key (see setStorageKey)

    function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { /* isolate */ } }); }
    function subscribe(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }

    function pushUndo() {
      undoStack.push(clone(project));
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
    }

    function normalize(p) {
      p.calendar = p.calendar || { workingDays: [1, 2, 3, 4, 5], holidays: [] };
      p.view = p.view || { zoom: 'week' };
      p.statusISO = p.statusISO || null;
      p.resources = (p.resources || []).map(function (r) {
        return {
          id: r.id,
          name: r.name != null ? String(r.name) : '?',
          initials: r.initials || '?',
          color: r.color || '#2563eb',
          rate: isFinite(+r.rate) ? Math.max(0, +r.rate) : 0
        };
      });
      p.tasks = (p.tasks || []).map(function (t) {
        var out = {
          id: t.id,
          name: t.name != null ? t.name : '',
          duration: clamp(Math.round(t.duration || 0), 0, MAX_DURATION),
          outlineLevel: Math.max(1, t.outlineLevel || 1),
          predecessors: (t.predecessors || []).map(function (pr) {
            return { id: pr.id, type: (pr.type || 'FS'), lag: pr.lag || 0 };
          }),
          percentComplete: clamp(Math.round(t.percentComplete || 0), 0, 100),
          // de-dupe: a repeated id would double-count cost and self-flag overallocation
          resourceIds: (t.resourceIds || []).filter(function (v, i, a) { return a.indexOf(v) === i; }),
          collapsed: !!t.collapsed,
          constraintISO: t.constraintISO || null,
          constraintType: (t.constraintType === 'MSO' || t.constraintType === 'SNET') ? t.constraintType
            : (t.constraintISO ? 'SNET' : null),
          deadlineISO: t.deadlineISO || null,
          actualStartISO: t.actualStartISO || null,
          actualFinishISO: t.actualFinishISO || null,
          comments: (t.comments || []).map(function (c) {
            var n = Number(c.id);
            return {
              // id coerced to a positive integer (or null -> reassigned below).
              // A non-numeric id must never survive: it reaches HTML attributes.
              id: (isFinite(n) && n > 0) ? Math.floor(n) : null,
              author: c.author != null ? String(c.author) : 'unknown',
              ts: c.ts || null,
              text: c.text != null ? String(c.text) : ''
            };
          }),
          notes: t.notes || ''
        };
        // Preserve fields this build doesn't know about — an older server must
        // never strip data written by a newer client (forward compatibility).
        Object.keys(t).forEach(function (k) {
          if (!(k in out)) out[k] = t[k];
        });
        return out;
      });
      // Risks: normalize against the (already-normalized) task id space.
      var taskIdSet = {};
      p.tasks.forEach(function (t) { taskIdSet[t.id] = true; });
      p.risks = (p.risks || []).map(function (r) { return normalizeRisk(r, taskIdSet); });
      if (!p.nextRiskId) p.nextRiskId = 1 + p.risks.reduce(function (m, r) { return Math.max(m, r.id || 0); }, 0);
      // fix outline: first task must be level 1; no jumps > +1
      var prev = 0;
      p.tasks.forEach(function (t) {
        if (t.outlineLevel > prev + 1) t.outlineLevel = prev + 1;
        if (t.outlineLevel < 1) t.outlineLevel = 1;
        prev = t.outlineLevel;
      });
      if (!p.nextTaskId) p.nextTaskId = 1 + p.tasks.reduce(function (m, t) { return Math.max(m, t.id); }, 0);
      if (!p.nextResourceId) p.nextResourceId = 1 + p.resources.reduce(function (m, r) { return Math.max(m, r.id); }, 0);
      // Comment ids: seed the counter past all valid ids, then assign fresh
      // ids to any that are null (invalid) or duplicate, so every comment ends
      // up with a unique positive-integer id.
      var maxCid = p.tasks.reduce(function (m, t) {
        return t.comments.reduce(function (mm, c) { return c.id != null ? Math.max(mm, c.id) : mm; }, m);
      }, 0);
      if (!p.nextCommentId || p.nextCommentId <= maxCid) p.nextCommentId = maxCid + 1;
      var seenCid = {};
      p.tasks.forEach(function (t) {
        t.comments.forEach(function (c) {
          if (c.id == null || seenCid[c.id]) c.id = p.nextCommentId++;
          seenCid[c.id] = true;
        });
      });
      return p;
    }

    // ---- Recompute schedule + display fields -------------------------------
    function recompute() {
      var cal = Cal.makeCalendar(project.calendar);
      var anchor = cal.snapForward(Cal.parseISO(project.startISO));
      var tasks = project.tasks;

      // Build scheduler input, converting constraints to indices. Recorded
      // actuals OUTRANK constraints and dependencies: what actually happened
      // pins the schedule (an MSO pin at the actual start), and a recorded
      // finish fixes the effective duration to the real span.
      var schedInput = tasks.map(function (t) {
        var constraintIndex = null;
        var constraintType = t.constraintType || (t.constraintISO ? 'SNET' : null);
        var duration = t.duration;
        if (t.constraintISO) {
          var cd = Cal.parseISO(t.constraintISO);
          if (cd != null) constraintIndex = cal.dayToIndex(anchor, cal.snapForward(cd));
        }
        if (t.actualStartISO) {
          var asd = Cal.parseISO(t.actualStartISO);
          if (asd != null) {
            constraintIndex = cal.dayToIndex(anchor, cal.snapForward(asd));
            constraintType = 'MSO';
            if (t.actualFinishISO && t.duration > 0) {
              var afd = Cal.parseISO(t.actualFinishISO);
              if (afd != null) {
                var afIdx = cal.dayToIndex(anchor, cal.snapForward(afd));
                duration = Math.max(1, afIdx - constraintIndex + 1);
              }
            }
          }
        }
        return {
          id: t.id, duration: duration, outlineLevel: t.outlineLevel,
          predecessors: t.predecessors, percentComplete: t.percentComplete,
          constraintIndex: constraintIndex,
          constraintType: constraintType
        };
      });

      var sched = Scheduler.schedule(schedInput);
      var maxIdx = Math.min(Math.max(0, sched.projectFinish), 300000); // cap timeline table
      var table = cal.buildTable(anchor, maxIdx);
      function idxToDay(i) { return (i >= 0 && i < table.length) ? table[i] : cal.indexToDay(anchor, i); }

      // %complete roll-up (deepest-first)
      var order = sched.results.map(function (r, i) { return i; })
        .sort(function (a, b) { return sched.results[b].outlineLevel - sched.results[a].outlineLevel; });
      var pct = tasks.map(function (t) { return t.percentComplete; });
      // effWork[i] = total leaf-duration under i (0 for a summary's own row, filled
      // in as we roll up). Weighting summaries by this — not the raw own-duration,
      // which is 0 for a nested summary — keeps a nested summary's progress counted.
      var effWork = sched.results.map(function (r) { return r.isSummary ? 0 : Math.max(r.duration, 0); });
      order.forEach(function (i) {
        var r = sched.results[i];
        if (!r.isSummary) return;
        var sumDur = 0, sumWork = 0, kids = r.childIndices;
        kids.forEach(function (ci) {
          var w = effWork[ci];
          sumDur += w;
          sumWork += w * pct[ci];
        });
        effWork[i] = sumDur;
        pct[i] = sumDur > 0 ? Math.round(sumWork / sumDur) : Math.round(kids.reduce(function (a, ci) { return a + pct[ci]; }, 0) / (kids.length || 1));
      });

      var rows = sched.results.map(function (r, i) {
        var startDay = idxToDay(r.es);
        var finishDay;
        if (r.isMilestone || r.ef <= r.es) finishDay = startDay;
        else finishDay = idxToDay(r.ef - 1);
        return {
          id: r.id,
          index: i,
          row: i + 1,
          task: tasks[i],
          name: tasks[i].name,
          wbs: r.wbs,
          outlineLevel: r.outlineLevel,
          isSummary: r.isSummary,
          isMilestone: r.isMilestone,
          constraintViolated: !!r.constraintViolated,
          es: r.es, ef: r.ef, ls: r.ls, lf: r.lf,
          slack: r.slack,
          critical: r.critical,
          durationDays: r.isSummary ? (r.ef - r.es) : r.duration,
          startDay: startDay,
          finishDay: finishDay,
          percentComplete: pct[i],
          childIndices: r.childIndices,
          parentIndex: r.parentIndex,
          commentCount: tasks[i].comments ? tasks[i].comments.length : 0
        };
      });

      // Roll summary display days up from children (deepest-first). This makes a
      // summary whose last child is a milestone extend to the milestone's day,
      // rather than undershooting by one from the exclusive-finish index.
      order.forEach(function (i) {
        var r = sched.results[i];
        if (!r.isSummary || !r.childIndices.length) return;
        var lo = Infinity, hi = -Infinity;
        r.childIndices.forEach(function (ci) {
          if (rows[ci].startDay < lo) lo = rows[ci].startDay;
          if (rows[ci].finishDay > hi) hi = rows[ci].finishDay;
        });
        if (isFinite(lo)) rows[i].startDay = lo;
        if (isFinite(hi)) rows[i].finishDay = hi;
      });

      // ---- Cost: leaf = Σ(assigned day-rates) × working days; summaries roll up.
      var rateById = {};
      project.resources.forEach(function (r) { rateById[r.id] = isFinite(+r.rate) ? +r.rate : 0; });
      var cost = rows.map(function (r) {
        if (r.isSummary) return 0;
        var daily = r.task.resourceIds.reduce(function (a, rid) { return a + (rateById[rid] || 0); }, 0);
        return daily * r.durationDays;
      });
      order.forEach(function (i) {           // deepest-first: children before parents
        var r = sched.results[i];
        if (!r.isSummary) return;
        cost[i] = r.childIndices.reduce(function (a, ci) { return a + cost[ci]; }, 0);
      });
      var projectCost = 0;
      rows.forEach(function (r, i) {
        r.cost = cost[i];
        if (r.parentIndex < 0) projectCost += cost[i];
      });

      // ---- Deadlines (indicators only — never move the schedule).
      var missedDeadlines = 0;
      rows.forEach(function (r) {
        var dd = r.task.deadlineISO ? Cal.parseISO(r.task.deadlineISO) : null;
        r.deadlineDay = dd;
        r.deadlineMissed = dd != null && r.finishDay > dd;
        if (r.deadlineMissed) missedDeadlines++;
      });
      // A pin that records reality is not a planning conflict — suppress the
      // MSO-violation flag on tasks with actuals (it happened; nothing to fix).
      rows.forEach(function (r) { if (r.task.actualStartISO) r.constraintViolated = false; });
      var constraintConflicts = rows.filter(function (r) { return r.constraintViolated; }).length;

      // ---- Status date: expected progress vs recorded progress. A status date
      // before the project start means no work is expected yet — don't let
      // dayToIndex's clamp-to-0 fabricate progress/behind flags on day-0 tasks.
      var statusDay = project.statusISO ? Cal.parseISO(project.statusISO) : null;
      var statusIdx = (statusDay != null && statusDay >= anchor) ? cal.dayToIndex(anchor, statusDay) : null;
      var behindCount = 0;
      rows.forEach(function (r) {
        r.expectedPct = null;
        r.behindSchedule = false;
        if (statusIdx == null || r.isSummary) return;
        var dur = r.durationDays;
        if (dur <= 0) { // milestone: due strictly before the status day = late
          r.expectedPct = r.es < statusIdx ? 100 : 0;
        } else {
          var elapsed = clamp(statusIdx - r.es + 1, 0, dur);
          r.expectedPct = Math.round(elapsed / dur * 100);
        }
        r.behindSchedule = r.percentComplete < r.expectedPct;
        if (r.behindSchedule) behindCount++;
      });

      // ---- Resource over-allocation: a resource on two leaf tasks whose
      // working-day windows overlap is double-booked on those days.
      var byResource = {};
      rows.forEach(function (r, i) {
        if (r.isSummary || r.durationDays <= 0) return;
        r.task.resourceIds.forEach(function (rid) {
          (byResource[rid] = byResource[rid] || []).push({ es: r.es, ef: r.ef, index: i });
        });
      });
      var overallocatedIds = {};
      rows.forEach(function (r) { r.overallocatedResources = []; });
      Object.keys(byResource).forEach(function (ridKey) {
        var iv = byResource[ridKey].slice().sort(function (a, b) { return a.es - b.es; });
        for (var k = 1; k < iv.length; k++) {
          for (var j = 0; j < k; j++) {
            if (iv[j].ef > iv[k].es && iv[k].ef > iv[j].es) {
              overallocatedIds[ridKey] = true;
              var res = project.resources.filter(function (x) { return String(x.id) === ridKey; })[0];
              var nm = res ? res.name : '?';
              [iv[j].index, iv[k].index].forEach(function (ti) {
                if (rows[ti].overallocatedResources.indexOf(nm) < 0) rows[ti].overallocatedResources.push(nm);
              });
            }
          }
        }
      });

      // ---- Risks: attach open exposure to linked task rows + project summary.
      var riskSummary = { open: 0, mitigating: 0, closed: 0, realized: 0, exposure: 0, critical: 0 };
      var risksByTask = {};
      (project.risks || []).forEach(function (rk) {
        riskSummary[rk.status] = (riskSummary[rk.status] || 0) + 1;
        var score = rk.probability * rk.impact;
        var active = rk.status === 'open' || rk.status === 'mitigating';
        if (active) {
          riskSummary.exposure += score;
          if (riskSeverity(score) === 'critical') riskSummary.critical++;
          rk.taskIds.forEach(function (tid) {
            (risksByTask[tid] = risksByTask[tid] || []).push({
              id: rk.id, title: rk.title, score: score, severity: riskSeverity(score), status: rk.status
            });
          });
        }
      });
      rows.forEach(function (r) {
        r.risks = risksByTask[r.id] || [];
        r.riskScore = r.risks.reduce(function (m, k) { return Math.max(m, k.score); }, 0);
      });

      // Baseline overlay
      var baselineByDay = null;
      if (project.baseline && project.baseline.tasks) {
        baselineByDay = {};
        project.baseline.tasks.forEach(function (b) { baselineByDay[b.id] = b; });
      }

      // ---- Earned value (PV/EV/AC + indices) against the status date.
      // Needs a baseline (the plan of record → PV, BAC) and a status date (the
      // "as of" moment). AC uses recorded actual spans × day rates; a task with
      // no recorded actuals is costed at its earned value (neutral CPI) so the
      // metric reflects only what was actually measured.
      var evm;
      if (!baselineByDay && statusIdx == null) evm = { available: false, reason: 'Set a baseline and a status date to enable earned-value analysis.' };
      else if (!baselineByDay) evm = { available: false, reason: 'Set a baseline (the plan of record) to enable earned-value analysis.' };
      else if (statusIdx == null) evm = { available: false, reason: 'Set a status date (Calendar dialog) to enable earned-value analysis.' };
      else {
        var tot = { bac: 0, pv: 0, ev: 0, ac: 0 };
        var perTask = [];
        rows.forEach(function (r, i) {
          if (r.isSummary) return;
          var bl = baselineByDay[r.id]; // may be absent (task added after baseline)
          // Coerce baseline cost — an externally-authored/corrupted string cost
          // would otherwise string-concatenate into a garbage BAC.
          var bacRaw = bl && bl.cost != null ? Number(bl.cost) : cost[i];
          var bac = isFinite(bacRaw) ? bacRaw : 0;
          var bStartIdx = bl ? cal.dayToIndex(anchor, bl.startDay) : r.es;
          var bFinIdx = bl ? cal.dayToIndex(anchor, bl.finishDay) : (r.es + Math.max(r.durationDays - 1, 0));
          var bDur = Math.max(1, bFinIdx - bStartIdx + 1);
          // Milestone only when duration is genuinely 0 — a 1-day task also has
          // startDay===finishDay, so that heuristic is a legacy fallback only.
          var isMilestoneBl = bl
            ? (bl.durationDays != null ? bl.durationDays === 0 : bl.startDay === bl.finishDay)
            : r.isMilestone;
          var plannedFrac = isMilestoneBl
            ? (bStartIdx < statusIdx ? 1 : 0)
            : clamp(statusIdx - bStartIdx + 1, 0, bDur) / bDur;
          var pv = bac * plannedFrac;
          var ev = bac * (r.percentComplete / 100);
          var ac;
          if (r.task.actualStartISO) {
            var dailyRate = r.task.resourceIds.reduce(function (a, rid) { return a + (rateById[rid] || 0); }, 0);
            var asIdx = cal.dayToIndex(anchor, cal.snapForward(Cal.parseISO(r.task.actualStartISO)));
            var elapsed;
            if (r.task.actualFinishISO) {
              // Cap the actual finish at the status date — AC must only reflect
              // work performed as of "now", never cost from future days.
              var afIdx = cal.dayToIndex(anchor, cal.snapForward(Cal.parseISO(r.task.actualFinishISO)));
              elapsed = Math.max(Math.min(afIdx, statusIdx) - asIdx + 1, 1);
            } else {
              elapsed = clamp(statusIdx - asIdx + 1, 0, 100000);
            }
            ac = dailyRate * elapsed;
          } else {
            ac = ev; // nothing measured yet — neutral cost assumption
          }
          tot.bac += bac; tot.pv += pv; tot.ev += ev; tot.ac += ac;
          if (bac > 0) {
            perTask.push({
              row: i + 1, id: r.id, name: r.name,
              bac: Math.round(bac), pv: Math.round(pv), ev: Math.round(ev), ac: Math.round(ac),
              spi: pv > 0 ? ev / pv : null,
              cpi: ac > 0 ? ev / ac : null
            });
          }
        });
        var spi = tot.pv > 0 ? tot.ev / tot.pv : null;
        var cpi = tot.ac > 0 ? tot.ev / tot.ac : null;
        var eac = cpi ? tot.bac / cpi : null;
        evm = {
          available: true,
          statusISO: project.statusISO,
          baselineISO: project.baseline.savedISO || null,
          bac: Math.round(tot.bac), pv: Math.round(tot.pv),
          ev: Math.round(tot.ev), ac: Math.round(tot.ac),
          sv: Math.round(tot.ev - tot.pv), cv: Math.round(tot.ev - tot.ac),
          spi: spi, cpi: cpi,
          eac: eac != null ? Math.round(eac) : null,
          etc: eac != null ? Math.round(eac - tot.ac) : null,
          vac: eac != null ? Math.round(tot.bac - eac) : null,
          tasks: perTask
        };
      }

      computed = {
        rows: rows,
        anchor: anchor,
        table: table,
        cal: cal,
        projectFinish: sched.projectFinish,
        projectStartDay: rows.length ? rows.reduce(function (m, r) { return Math.min(m, r.startDay); }, rows[0].startDay) : anchor,
        projectEndDay: rows.length ? rows.reduce(function (m, r) { return Math.max(m, r.finishDay); }, rows[0].finishDay) : anchor,
        projectFinishDay: rows.length ? rows.reduce(function (m, r) { return Math.max(m, r.finishDay); }, rows[0].finishDay) : anchor,
        hasCycle: sched.hasCycle,
        cycleIds: sched.cycleIds,
        baseline: baselineByDay,
        projectCost: projectCost,
        missedDeadlines: missedDeadlines,
        constraintConflicts: constraintConflicts,
        overallocatedCount: Object.keys(overallocatedIds).length,
        riskSummary: riskSummary,
        statusDay: statusDay,
        behindCount: behindCount,
        evm: evm
      };
      return computed;
    }

    function getComputed() { if (!computed) recompute(); return computed; }

    // Visible rows respecting collapsed summaries, then the active view filter
    // (matching rows keep their ancestor summaries for context).
    var FILTERS = {
      critical: function (r) { return r.critical && !r.isSummary; },
      incomplete: function (r) { return !r.isSummary && r.percentComplete < 100; },
      milestones: function (r) { return r.isMilestone; },
      overallocated: function (r) { return r.overallocatedResources && r.overallocatedResources.length > 0; },
      late: function (r) { return r.deadlineMissed || r.constraintViolated; }
    };

    function getVisibleRows() {
      var c = getComputed();
      var rows = c.rows;
      var out = [];
      var hideUntilLevel = null; // hide rows whose outlineLevel > this until we drop back
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (hideUntilLevel != null) {
          if (r.outlineLevel > hideUntilLevel) { continue; }
          else hideUntilLevel = null;
        }
        out.push(r);
        if (r.isSummary && r.task.collapsed) hideUntilLevel = r.outlineLevel;
      }
      var mode = project.view && project.view.filter;
      var pred = mode && FILTERS[mode];
      if (!pred) return out;
      var keep = {};
      out.forEach(function (r) {
        if (!pred(r)) return;
        keep[r.index] = true;
        for (var pi = r.parentIndex; pi >= 0; pi = rows[pi].parentIndex) keep[pi] = true;
      });
      return out.filter(function (r) { return keep[r.index]; });
    }

    function setFilter(mode) {
      project.view = project.view || {};
      project.view.filter = FILTERS[mode] ? mode : null;
      notify();
    }
    function getFilter() { return (project.view && project.view.filter) || null; }

    // ---- Mutations ---------------------------------------------------------
    function findIndexById(id) {
      for (var i = 0; i < project.tasks.length; i++) if (project.tasks[i].id === id) return i;
      return -1;
    }

    function newTask(level) {
      return {
        id: project.nextTaskId++,
        name: '', duration: 1, outlineLevel: level || 1,
        predecessors: [], percentComplete: 0, resourceIds: [],
        collapsed: false, constraintISO: null, constraintType: null, deadlineISO: null,
        actualStartISO: null, actualFinishISO: null, comments: [], notes: ''
      };
    }

    function insertTask(atIndex, level) {
      pushUndo();
      atIndex = clamp(atIndex, 0, project.tasks.length);
      var lvl = level;
      if (lvl == null) lvl = atIndex > 0 ? project.tasks[atIndex - 1].outlineLevel : 1;
      var t = newTask(lvl);
      project.tasks.splice(atIndex, 0, t);
      recompute(); notify();
      return t.id;
    }

    function addTaskEnd() { return insertTask(project.tasks.length, null); }

    function deleteTasks(ids) {
      pushUndo();
      var idset = {};
      ids.forEach(function (id) { idset[id] = true; });
      // also drop predecessor refs and risk links to deleted tasks
      project.tasks = project.tasks.filter(function (t) { return !idset[t.id]; });
      project.tasks.forEach(function (t) {
        t.predecessors = t.predecessors.filter(function (p) { return !idset[p.id]; });
      });
      (project.risks || []).forEach(function (r) {
        r.taskIds = r.taskIds.filter(function (tid) { return !idset[tid]; });
      });
      fixOutline();
      recompute(); notify();
    }

    function fixOutline() {
      var prev = 0;
      project.tasks.forEach(function (t) {
        if (t.outlineLevel > prev + 1) t.outlineLevel = prev + 1;
        prev = t.outlineLevel;
      });
    }

    function indent(ids) {
      pushUndo();
      ids.forEach(function (id) {
        var i = findIndexById(id);
        if (i <= 0) return; // first row can't indent
        var maxLevel = project.tasks[i - 1].outlineLevel + 1;
        project.tasks[i].outlineLevel = Math.min(project.tasks[i].outlineLevel + 1, maxLevel);
      });
      fixOutline();
      recompute(); notify();
    }

    function outdent(ids) {
      pushUndo();
      ids.slice().forEach(function (id) {
        var i = findIndexById(id);
        if (i < 0) return;
        if (project.tasks[i].outlineLevel > 1) project.tasks[i].outlineLevel--;
      });
      fixOutline();
      recompute(); notify();
    }

    // Subtree block starting at index i: the task plus all deeper rows after it.
    function subtreeRange(i) {
      var tasks = project.tasks;
      var level = tasks[i].outlineLevel;
      var j = i + 1;
      while (j < tasks.length && tasks[j].outlineLevel > level) j++;
      return { start: i, count: j - i };
    }

    function insertAll(arr, at, items) {
      for (var k = 0; k < items.length; k++) arr.splice(at + k, 0, items[k]);
    }

    // Move a task (with its subtree) up/down, swapping with the adjacent sibling
    // block at the same outline level. Keeps subtrees intact.
    function moveBlock(id, dir) {
      var tasks = project.tasks;
      var i = findIndexById(id);
      if (i < 0) return;
      var level = tasks[i].outlineLevel;
      var range = subtreeRange(i);
      var block = tasks.slice(range.start, range.start + range.count);

      if (dir < 0) {
        // find previous sibling start: nearest earlier row at the same level,
        // stopping if we hit a shallower level (we're the first child).
        var sibStart = -1;
        for (var p = range.start - 1; p >= 0; p--) {
          if (tasks[p].outlineLevel < level) break;
          if (tasks[p].outlineLevel === level) { sibStart = p; break; }
        }
        if (sibStart < 0) return;
        pushUndo();
        tasks.splice(range.start, range.count);
        insertAll(tasks, sibStart, block);
      } else {
        var after = range.start + range.count;
        if (after >= tasks.length) return;
        if (tasks[after].outlineLevel < level) return; // no next sibling (we're last child)
        var nextRange = subtreeRange(after);
        pushUndo();
        tasks.splice(range.start, range.count);
        insertAll(tasks, range.start + nextRange.count, block);
      }
      fixOutline();
      recompute(); notify();
    }

    function setField(id, field, value) {
      var i = findIndexById(id);
      if (i < 0) return;
      var snapshot = clone(project);   // captured up front so undo can restore
      var before = JSON.stringify(project);
      var t = project.tasks[i];
      switch (field) {
        case 'name': t.name = String(value); break;
        case 'duration': {
          var d = parseDuration(value);
          if (d == null) return;         // invalid input: no change, no history
          t.duration = d; break;
        }
        case 'percentComplete': {
          var pc = parseInt(String(value).replace('%', ''), 10);
          if (isNaN(pc)) return;
          t.percentComplete = clamp(pc, 0, 100); break;
        }
        case 'predecessors': t.predecessors = parsePredecessors(value, project.tasks, t.id); break;
        case 'resources': t.resourceIds = parseResources(value); break;
        case 'start': {
          t.constraintISO = coerceDateISO(value);
          // Keep an existing MSO pin (just moving its date); default to SNET.
          t.constraintType = t.constraintISO ? (t.constraintType === 'MSO' ? 'MSO' : 'SNET') : null;
          break;
        }
        case 'actualStart': {
          var asISO = coerceDateISO(value);
          if (asISO && t.actualFinishISO && Cal.parseISO(asISO) > Cal.parseISO(t.actualFinishISO)) return;
          t.actualStartISO = asISO;
          if (!asISO) t.actualFinishISO = null; // a finish can't exist without a start
          break;
        }
        case 'actualFinish': {
          var afISO = coerceDateISO(value);
          if (afISO) {
            // Recording a finish without a start adopts the scheduled start —
            // but compute it into a LOCAL first and only commit both fields once
            // validation passes, so a rejected finish never leaves a phantom
            // actual start pinned on the task.
            var startISO = t.actualStartISO || Cal.toISO(getComputed().rows[i].startDay);
            if (Cal.parseISO(afISO) < Cal.parseISO(startISO)) return;
            t.actualStartISO = startISO;
            t.actualFinishISO = afISO;
            t.percentComplete = 100; // finished is finished
          } else {
            t.actualFinishISO = null;
          }
          break;
        }
        case 'deadline': t.deadlineISO = coerceDateISO(value); break;
        case 'notes': t.notes = String(value); break;
        default: return;
      }
      // No-op edits (e.g. an auto-advanced editor blurred unchanged) must not
      // pollute the undo history or trigger a re-render.
      if (JSON.stringify(project) === before) return;
      undoStack.push(snapshot);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
      recompute(); notify();
    }

    // ---- Risk mutations -----------------------------------------------------
    function riskById(id) {
      return (project.risks || []).filter(function (r) { return r.id === Number(id); })[0] || null;
    }

    function addRisk(fields) {
      pushUndo();
      project.risks = project.risks || [];
      var taskIdSet = {};
      project.tasks.forEach(function (t) { taskIdSet[t.id] = true; });
      var r = normalizeRisk(Object.assign({}, fields || {}, {
        id: project.nextRiskId++,
        createdISO: Cal.toISO(Cal.todayDayNum())
      }), taskIdSet);
      project.risks.push(r);
      recompute(); notify();
      return r.id;
    }

    function updateRisk(id, patch) {
      var r = riskById(id);
      if (!r) return false;
      var snapshot = clone(project);
      var before = JSON.stringify(project);
      var taskIdSet = {};
      project.tasks.forEach(function (t) { taskIdSet[t.id] = true; });
      var merged = normalizeRisk(Object.assign({}, r, patch || {}, { id: r.id }), taskIdSet);
      // Stamp/clear the closed date on status transitions.
      if ((merged.status === 'closed' || merged.status === 'realized') && r.status !== merged.status) {
        merged.closedISO = Cal.toISO(Cal.todayDayNum());
      } else if (merged.status === 'open' || merged.status === 'mitigating') {
        merged.closedISO = null;
      }
      project.risks[project.risks.indexOf(r)] = merged;
      if (JSON.stringify(project) === before) return true; // no-op: no undo entry
      undoStack.push(snapshot);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
      recompute(); notify();
      return true;
    }

    function deleteRisk(id) {
      var r = riskById(id);
      if (!r) return false;
      pushUndo();
      project.risks = project.risks.filter(function (x) { return x.id !== r.id; });
      recompute(); notify();
      return true;
    }

    // ---- Comments -----------------------------------------------------------
    function nowISO() { return new Date().toISOString(); }

    function addComment(taskId, text, author) {
      var i = findIndexById(taskId);
      if (i < 0) return null;
      text = String(text == null ? '' : text).trim();
      if (!text) return null;
      pushUndo();
      var c = { id: project.nextCommentId++, author: String(author || 'unknown'), ts: nowISO(), text: text };
      project.tasks[i].comments.push(c);
      recompute(); notify();
      return c.id;
    }

    function deleteComment(taskId, commentId) {
      var i = findIndexById(taskId);
      if (i < 0) return false;
      var t = project.tasks[i];
      if (!t.comments.some(function (c) { return c.id === Number(commentId); })) return false;
      pushUndo(); // snapshot the pre-delete state
      t.comments = t.comments.filter(function (c) { return c.id !== Number(commentId); });
      recompute(); notify();
      return true;
    }

    // Set/clear a scheduling constraint. type: null | 'SNET' | 'MSO'.
    function setConstraint(id, type, isoOrNull) {
      var i = findIndexById(id);
      if (i < 0) return;
      var snapshot = clone(project);
      var before = JSON.stringify(project);
      var t = project.tasks[i];
      if (type !== 'SNET' && type !== 'MSO') type = null;
      var iso = type ? coerceDateISO(isoOrNull) : null;
      if (type && !iso) return; // a typed constraint needs a valid date
      t.constraintType = type;
      t.constraintISO = iso;
      if (JSON.stringify(project) === before) return;
      undoStack.push(snapshot);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
      recompute(); notify();
    }

    function coerceDateISO(value) {
      if (!value || !String(value).trim()) return null;
      var s = String(value).trim();
      var iso = Cal.parseISO(s);
      if (iso != null) return Cal.toISO(iso);
      // try M/D/YY or M/D/YYYY
      var m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
      if (m) {
        var y = parseInt(m[3], 10); if (y < 100) y += 2000;
        var dn = Math.round(Date.UTC(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10)) / Cal.MS);
        return Cal.toISO(dn);
      }
      var parsed = new Date(s);
      if (!isNaN(parsed.getTime())) {
        var dn2 = Math.round(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()) / Cal.MS);
        return Cal.toISO(dn2);
      }
      return null;
    }

    function parseResources(str) {
      if (!str || !String(str).trim()) return [];
      var ids = [];
      String(str).split(/[,;]/).forEach(function (name) {
        name = name.trim();
        if (!name) return;
        // strip trailing [xx%] units if present
        name = name.replace(/\s*\[\d+%\]\s*$/, '').trim();
        var found = project.resources.filter(function (r) { return r.name.toLowerCase() === name.toLowerCase(); })[0];
        if (!found) {
          found = { id: project.nextResourceId++, name: name, initials: initialsOf(name), color: pickColor(project.resources.length) };
          project.resources.push(found);
        }
        if (ids.indexOf(found.id) < 0) ids.push(found.id);
      });
      return ids;
    }

    function initialsOf(name) {
      var parts = name.split(/\s+/).filter(Boolean);
      if (!parts.length) return '?';
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    var PALETTE = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#dc2626', '#0891b2', '#c026d3', '#65a30d'];
    function pickColor(i) { return PALETTE[i % PALETTE.length]; }

    // Link/unlink selected tasks in sequence with FS
    function linkTasks(ids) {
      if (ids.length < 2) return;
      pushUndo();
      // Order by current row order
      var ordered = ids.map(findIndexById).filter(function (i) { return i >= 0; }).sort(function (a, b) { return a - b; });
      for (var k = 1; k < ordered.length; k++) {
        var t = project.tasks[ordered[k]];
        var predId = project.tasks[ordered[k - 1]].id;
        if (!t.predecessors.some(function (p) { return p.id === predId; })) {
          t.predecessors.push({ id: predId, type: 'FS', lag: 0 });
        }
      }
      recompute(); notify();
    }
    function unlinkTasks(ids) {
      pushUndo();
      var ordered = ids.map(findIndexById).filter(function (i) { return i >= 0; }).sort(function (a, b) { return a - b; });
      var idset = {};
      ordered.forEach(function (i) { idset[project.tasks[i].id] = true; });
      // remove predecessor links among the selected set
      ordered.forEach(function (i) {
        project.tasks[i].predecessors = project.tasks[i].predecessors.filter(function (p) { return !idset[p.id]; });
      });
      recompute(); notify();
    }

    function toggleCollapse(id) {
      var i = findIndexById(id);
      if (i < 0) return;
      project.tasks[i].collapsed = !project.tasks[i].collapsed;
      notify(); // no schedule change
    }
    function setAllCollapsed(collapsed) {
      project.tasks.forEach(function (t) { t.collapsed = collapsed; });
      notify();
    }

    // ---- Resources ---------------------------------------------------------
    function addResource(name) {
      pushUndo();
      var r = { id: project.nextResourceId++, name: name || 'New Resource', initials: initialsOf(name || 'NR'), color: pickColor(project.resources.length) };
      project.resources.push(r);
      notify();
      return r.id;
    }
    function updateResource(id, patch) {
      pushUndo();
      var r = project.resources.filter(function (x) { return x.id === id; })[0];
      if (r) Object.assign(r, patch);
      recompute(); notify();
    }
    function deleteResource(id) {
      pushUndo();
      project.resources = project.resources.filter(function (r) { return r.id !== id; });
      project.tasks.forEach(function (t) { t.resourceIds = t.resourceIds.filter(function (rid) { return rid !== id; }); });
      recompute(); notify();
    }

    // ---- Project-level -----------------------------------------------------
    function setProjectStart(iso) {
      pushUndo();
      var norm = coerceDateISO(iso);
      if (norm) project.startISO = norm;
      recompute(); notify();
    }
    // Status date: "as of when" progress is measured. null clears it.
    function setStatusDate(iso) {
      pushUndo();
      project.statusISO = iso ? coerceDateISO(iso) : null;
      recompute(); notify();
    }
    function setProjectName(name) { project.name = String(name); notify(); }
    function setZoom(z) { project.view.zoom = z; notify(); }
    // Visible grid columns: an array of optional column keys, or null for the
    // defaults. Lives in view state — per-user, never synced to the server.
    function setColumns(keys) { project.view.columns = Array.isArray(keys) ? keys.slice() : null; notify(); }
    function setHolidays(list) { pushUndo(); project.calendar.holidays = list.slice(); recompute(); notify(); }
    function setWorkingDays(days) { pushUndo(); project.calendar.workingDays = days.slice(); recompute(); notify(); }

    function saveBaseline() {
      pushUndo();
      var c = getComputed();
      project.baseline = {
        savedISO: Cal.toISO(Cal.todayDayNum()),
        // duration + cost captured for earned-value analysis (BAC); older
        // baselines without these fields degrade gracefully (BAC = current cost)
        tasks: c.rows.map(function (r) {
          return {
            id: r.id, startDay: r.startDay, finishDay: r.finishDay,
            durationDays: r.durationDays, cost: Math.round(r.cost || 0)
          };
        })
      };
      recompute(); notify(); // recompute so computed.baseline overlays immediately
    }
    function clearBaseline() { pushUndo(); project.baseline = null; recompute(); notify(); }

    // ---- Undo/redo ---------------------------------------------------------
    function undo() { if (!undoStack.length) return; redoStack.push(clone(project)); project = undoStack.pop(); recompute(); notify(); }
    function redo() { if (!redoStack.length) return; undoStack.push(clone(project)); project = redoStack.pop(); recompute(); notify(); }
    function canUndo() { return undoStack.length > 0; }
    function canRedo() { return redoStack.length > 0; }

    // ---- Export --------------------------------------------------------------
    function toCSV() {
      var c = getComputed();
      function q(s) {
        s = s == null ? '' : String(s);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }
      var lines = [[
        'WBS', 'Task Name', 'Duration (working days)', 'Start', 'Finish',
        'Actual Start', 'Actual Finish', 'Predecessors', 'Resources',
        '% Complete', 'Cost', 'Deadline', 'Critical', 'Slack (days)'
      ].join(',')];
      c.rows.forEach(function (r) {
        lines.push([
          q(r.wbs), q(r.name), r.durationDays,
          Cal.toISO(r.startDay), Cal.toISO(r.finishDay),
          r.task.actualStartISO || '', r.task.actualFinishISO || '',
          q(formatPredecessors(r.task.predecessors, project.tasks)),
          q(r.task.resourceIds.map(function (rid) {
            var res = project.resources.filter(function (x) { return x.id === rid; })[0];
            return res ? res.name : null;
          }).filter(Boolean).join(', ')),
          r.percentComplete, Math.round(r.cost || 0),
          r.task.deadlineISO || '',
          r.critical && !r.isSummary ? 'yes' : '',
          (r.isSummary || r.slack == null) ? '' : r.slack
        ].join(','));
      });
      return lines.join('\r\n');
    }

    // ---- Persistence -------------------------------------------------------
    function toJSON() { return clone(project); }
    function loadProject(p) {
      project = normalize(clone(p));
      undoStack.length = 0; redoStack.length = 0;
      recompute(); notify();
    }
    function newProject() {
      var start = Cal.toISO(Cal.makeCalendar({}).snapForward(Cal.todayDayNum()));
      loadProject(emptyProject(start));
    }
    function loadSample() {
      var start = Cal.toISO(Cal.makeCalendar({}).snapForward(Cal.todayDayNum()));
      loadProject(sampleProject(start));
    }
    function saveLocal() {
      try { localStorage.setItem(storageKey, JSON.stringify(project)); return true; }
      catch (e) { return false; }
    }
    function loadLocal() {
      try {
        var raw = localStorage.getItem(storageKey);
        if (!raw) return false;
        loadProject(JSON.parse(raw));
        return true;
      } catch (e) { return false; }
    }

    // Initialize
    function init() {
      if (!loadLocal()) loadSample();
    }

    return {
      // state access
      getProject: function () { return project; },
      getComputed: getComputed,
      getVisibleRows: getVisibleRows,
      findIndexById: findIndexById,
      recompute: function () { recompute(); notify(); },
      subscribe: subscribe,
      // formatting helpers (used by grid)
      formatPredecessors: function (preds) { return formatPredecessors(preds, project.tasks); },
      formatResources: function (ids) {
        return ids.map(function (id) { var r = project.resources.filter(function (x) { return x.id === id; })[0]; return r ? r.name : null; }).filter(Boolean).join(', ');
      },
      formatDuration: formatDuration,
      formatMoney: formatMoney,
      toCSV: toCSV,
      // mutations
      insertTask: insertTask,
      addTaskEnd: addTaskEnd,
      deleteTasks: deleteTasks,
      indent: indent,
      outdent: outdent,
      moveBlock: moveBlock,
      setField: setField,
      setConstraint: setConstraint,
      addComment: addComment,
      deleteComment: deleteComment,
      linkTasks: linkTasks,
      unlinkTasks: unlinkTasks,
      toggleCollapse: toggleCollapse,
      setAllCollapsed: setAllCollapsed,
      // resources
      addResource: addResource,
      updateResource: updateResource,
      deleteResource: deleteResource,
      // risks
      addRisk: addRisk,
      updateRisk: updateRisk,
      deleteRisk: deleteRisk,
      riskById: riskById,
      riskSeverity: riskSeverity,
      // project
      setProjectStart: setProjectStart,
      setProjectName: setProjectName,
      setStatusDate: setStatusDate,
      setZoom: setZoom,
      setColumns: setColumns,
      setFilter: setFilter,
      getFilter: getFilter,
      setHolidays: setHolidays,
      setWorkingDays: setWorkingDays,
      saveBaseline: saveBaseline,
      clearBaseline: clearBaseline,
      // undo
      undo: undo, redo: redo, canUndo: canUndo, canRedo: canRedo,
      // persistence
      setStorageKey: function (name) {
        storageKey = 'projectdesk.' + String(name || 'current').replace(/[^A-Za-z0-9_-]/g, '') + '.v1';
      },
      toJSON: toJSON,
      loadProject: loadProject,
      newProject: newProject,
      loadSample: loadSample,
      saveLocal: saveLocal,
      loadLocal: loadLocal,
      init: init,
      // exposed for testing
      _parseDuration: parseDuration,
      _parsePredecessors: parsePredecessors,
      _formatPredecessors: formatPredecessors
    };
  }

  return {
    createModel: createModel,
    parseDuration: parseDuration,
    formatDuration: formatDuration,
    formatMoney: formatMoney,
    riskSeverity: riskSeverity,
    parsePredecessors: parsePredecessors,
    formatPredecessors: formatPredecessors,
    sampleProject: sampleProject,
    emptyProject: emptyProject
  };
}));
