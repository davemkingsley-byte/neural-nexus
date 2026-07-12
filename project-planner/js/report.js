/*
 * report.js — one-page project status report, the data behind an executive
 * summary a PM would print or paste into a status email. Pure: takes a live
 * model and assembles what the tool already knows (schedule, cost, EVM, risks,
 * actuals, resource load) into one structured document. No new math — every
 * number here is the same one the grid/status-bar/EVM/usage views show.
 *
 * "As of" moment: the project status date when set (the PM's reporting date),
 * otherwise today. Tests can pin it via opts.asOfISO.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./calendar.js'), require('./usage.js'));
  } else { root.PM = root.PM || {}; root.PM.Report = factory(root.PM.Calendar, root.PM.Usage); }
}(typeof self !== 'undefined' ? self : this, function (Cal, Usage) {
  'use strict';

  var UPCOMING_WINDOW_DAYS = 14; // calendar days ahead counted as "upcoming"
  var RISK_CAP = 5;              // top active risks shown
  var LIST_CAP = 15;             // critical/behind/upcoming task list cap

  function severity(score) {
    if (score >= 15) return 'critical';
    if (score >= 10) return 'high';
    if (score >= 5) return 'medium';
    return 'low';
  }

  function build(model, opts) {
    opts = opts || {};
    var c = model.getComputed();
    var project = model.getProject();
    var asOfDay = opts.asOfISO ? Cal.parseISO(opts.asOfISO)
      : (c.statusDay != null ? c.statusDay : Cal.todayDayNum());

    var nameById = {};
    (project.resources || []).forEach(function (r) { nameById[r.id] = r.name || ''; });
    function resNames(t) {
      return (t.resourceIds || []).map(function (id) { return nameById[id]; }).filter(Boolean);
    }

    var leaves = c.rows.filter(function (r) { return !r.isSummary; });
    var milestones = c.rows.filter(function (r) { return r.isMilestone; });

    // Overall % complete: duration-weighted over leaves (matches how summary
    // rows roll up). Milestones weigh 1 day so an all-milestone plan still
    // reports progress.
    var wSum = 0, wDone = 0;
    leaves.forEach(function (r) {
      var w = Math.max(r.durationDays, 1);
      wSum += w; wDone += w * r.percentComplete;
    });
    var pctComplete = wSum ? Math.round(wDone / wSum) : 0;

    // Milestones, chronological; late = not done and its date has passed.
    var milestoneList = milestones.map(function (r) {
      var done = r.percentComplete >= 100;
      return {
        row: r.row, name: r.name, dateISO: Cal.toISO(r.finishDay),
        done: done,
        late: !done && r.finishDay < asOfDay,
        critical: !!r.critical
      };
    }).sort(function (a, b) { return a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : a.row - b.row; });

    function taskBrief(r) {
      return {
        row: r.row, name: r.name,
        startISO: Cal.toISO(r.startDay), finishISO: Cal.toISO(r.finishDay),
        durationDays: r.durationDays, percentComplete: r.percentComplete,
        resources: resNames(r.task)
      };
    }

    var criticalLeaves = leaves.filter(function (r) { return r.critical && r.durationDays > 0; });
    var behind = leaves.filter(function (r) { return r.behindSchedule; })
      .map(function (r) {
        var b = taskBrief(r); b.expectedPct = r.expectedPct; return b;
      })
      .sort(function (a, b) { return (b.expectedPct - b.percentComplete) - (a.expectedPct - a.percentComplete); });

    // Starting soon: not begun, first working day within the window after asOf.
    var horizon = asOfDay + UPCOMING_WINDOW_DAYS;
    var upcoming = leaves.filter(function (r) {
      return r.percentComplete === 0 && r.durationDays > 0 &&
        r.startDay > asOfDay && r.startDay <= horizon;
    }).map(taskBrief).sort(function (a, b) { return a.startISO < b.startISO ? -1 : 1; });

    var lateMilestones = milestoneList.filter(function (m) { return m.late; }).length;

    // Top active risks by exposure.
    var risks = (project.risks || [])
      .filter(function (rk) { return rk.status === 'open' || rk.status === 'mitigating'; })
      .map(function (rk) {
        var score = rk.probability * rk.impact;
        return {
          id: rk.id, title: rk.title, owner: rk.owner || '',
          probability: rk.probability, impact: rk.impact,
          score: score, severity: severity(score), status: rk.status
        };
      })
      .sort(function (a, b) { return b.score - a.score || a.id - b.id; });

    // Resource load summary (whole-project totals from the usage engine).
    var usage = Usage.build(model, { bucket: 'month' });
    var resources = usage.resources.map(function (r) {
      return {
        name: r.unassigned ? '(Unassigned)' : r.name,
        unassigned: !!r.unassigned,
        totalHours: r.totalHours, totalDays: r.totalDays, totalCost: r.totalCost,
        peakDaily: r.peakDaily, overallocated: r.overallocated
      };
    });

    var evm = c.evm && c.evm.available ? {
      available: true,
      statusISO: c.evm.statusISO, baselineISO: c.evm.baselineISO,
      bac: c.evm.bac, pv: c.evm.pv, ev: c.evm.ev, ac: c.evm.ac,
      sv: c.evm.sv, cv: c.evm.cv, spi: c.evm.spi, cpi: c.evm.cpi,
      eac: c.evm.eac, etc: c.evm.etc, vac: c.evm.vac
    } : { available: false, reason: (c.evm && c.evm.reason) || '' };

    // Baseline finish variance (schedule slip vs the plan of record).
    // Baseline tasks store finishDay as absolute day numbers (saveBaseline).
    var baselineFinishISO = null, finishVarianceDays = null;
    if (project.baseline && project.baseline.tasks && project.baseline.tasks.length) {
      var bf = project.baseline.tasks.reduce(function (m, b) {
        return typeof b.finishDay === 'number' && b.finishDay > m ? b.finishDay : m;
      }, -Infinity);
      if (isFinite(bf)) {
        baselineFinishISO = Cal.toISO(bf);
        finishVarianceDays = c.projectFinishDay - bf; // calendar days, + = late
      }
    }

    return {
      asOfISO: Cal.toISO(asOfDay),
      usingStatusDate: c.statusDay != null && !opts.asOfISO,
      project: {
        name: project.name || 'Project',
        startISO: Cal.toISO(c.projectStartDay),
        finishISO: Cal.toISO(c.projectFinishDay),
        baselineFinishISO: baselineFinishISO,
        finishVarianceDays: finishVarianceDays,
        cost: c.projectCost,
        pctComplete: pctComplete,
        taskCount: leaves.length,
        milestoneCount: milestones.length,
        statusISO: project.statusISO || null,
        baselineSavedISO: (project.baseline && project.baseline.savedISO) || null
      },
      health: {
        hasCycle: !!c.hasCycle,
        behindCount: c.behindCount,
        missedDeadlines: c.missedDeadlines,
        lateMilestones: lateMilestones,
        constraintConflicts: c.constraintConflicts,
        overallocatedCount: c.overallocatedCount,
        openRisks: (c.riskSummary.open || 0) + (c.riskSummary.mitigating || 0),
        criticalRisks: c.riskSummary.critical || 0,
        riskExposure: c.riskSummary.exposure || 0,
        spi: evm.available ? evm.spi : null,
        cpi: evm.available ? evm.cpi : null
      },
      milestones: milestoneList,
      critical: {
        count: criticalLeaves.length,
        tasks: criticalLeaves.slice(0, LIST_CAP).map(taskBrief)
      },
      behind: { count: behind.length, tasks: behind.slice(0, LIST_CAP) },
      upcoming: { count: upcoming.length, tasks: upcoming.slice(0, LIST_CAP) },
      risks: { activeCount: risks.length, top: risks.slice(0, RISK_CAP) },
      resources: resources,
      evm: evm
    };
  }

  return { build: build };
}));
