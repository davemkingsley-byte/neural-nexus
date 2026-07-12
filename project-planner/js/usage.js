/*
 * usage.js — timephased resource allocation, the data behind a Microsoft
 * Project "Resource Usage" view. Pure: takes a live model and returns each
 * resource's work + cost spread across the calendar in day/week/month buckets,
 * plus the per-day peak load so over-allocation is pinpointed to real dates.
 *
 * Conventions match the model's cost + over-allocation logic exactly:
 *   - a leaf task occupies working-day indices [es, ef) (ef EXCLUSIVE);
 *   - each assignment contributes its units per day (1 = full-time = 8h,
 *     0.5 = half-time = 4h);
 *   - a resource's capacity is 1.0 units/day, so a daily Σunits above 1 is
 *     over-allocation (two half-time bookings on the same day are fine);
 *   - cost accrues rate × units per resource per active working-day,
 *     consistent with the per-task Σ(rate×units)×duration roll-up.
 * Milestones (0-day tasks) carry no work, exactly like the cost roll-up.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./calendar.js'));
  else { root.PM = root.PM || {}; root.PM.Usage = factory(root.PM.Calendar); }
}(typeof self !== 'undefined' ? self : this, function (Cal) {
  'use strict';

  var HOURS_PER_DAY = 8;

  function mondayOf(dayNum) {
    // Cal.dow: 0=Sun..6=Sat. Monday is the week anchor.
    return dayNum - ((Cal.dow(dayNum) + 6) % 7);
  }

  function bucketKeyFor(dayNum, size) {
    if (size === 'day') return Cal.toISO(dayNum);
    if (size === 'month') return Cal.toISO(dayNum).slice(0, 7); // YYYY-MM
    return Cal.toISO(mondayOf(dayNum));                          // week -> Monday ISO
  }

  function labelFor(key, size) {
    if (size === 'month') {
      var ym = key.split('-');
      return Cal.MON_NAMES[(+ym[1]) - 1] + ' ' + ym[0];
    }
    var p = Cal.parts(Cal.parseISO(key));
    var d = Cal.MON_NAMES[p.m] + ' ' + p.d;
    return size === 'week' ? ('Wk ' + d) : d;
  }

  // Ordered, gap-free bucket list spanning [startDay, endDay].
  function buildBuckets(startDay, endDay, size) {
    var buckets = [], seen = {};
    if (endDay < startDay) return buckets;
    var d = startDay;
    while (d <= endDay) {
      var key = bucketKeyFor(d, size);
      if (!seen[key]) {
        seen[key] = true;
        buckets.push({ key: key, label: labelFor(key, size) });
      }
      d++;
    }
    return buckets;
  }

  function build(model, opts) {
    opts = opts || {};
    var size = (opts.bucket === 'day' || opts.bucket === 'month') ? opts.bucket : 'week';
    var c = model.getComputed();
    var project = model.getProject();

    var rateById = {}, nameById = {};
    (project.resources || []).forEach(function (r) {
      rateById[r.id] = isFinite(+r.rate) ? +r.rate : 0;
      nameById[r.id] = r.name || ('Resource ' + r.id);
    });

    // Per-resource daily load (Σ units), and per-resource per-task daily units.
    var dailyRes = {}, taskName = {}, taskDaysByRes = {};
    var UNASSIGNED = '__unassigned__';

    function addDay(rid, dayNum, taskId, tName, units) {
      (dailyRes[rid] = dailyRes[rid] || {});
      dailyRes[rid][dayNum] = (dailyRes[rid][dayNum] || 0) + units;
      (taskDaysByRes[rid] = taskDaysByRes[rid] || {});
      (taskDaysByRes[rid][taskId] = taskDaysByRes[rid][taskId] || {});
      taskDaysByRes[rid][taskId][dayNum] = units;
      taskName[taskId] = tName;
    }

    c.rows.forEach(function (r) {
      if (r.isSummary || r.durationDays <= 0) return;
      // Defense in depth: the model dedupes assignments on every write/load,
      // but a duplicate here would double-count load and break the
      // task-sum == resource-total invariant, so dedupe again locally.
      var seen = {};
      var asgs = (r.task.assignments && r.task.assignments.length)
        ? r.task.assignments.filter(function (a) {
            if (seen[a.resourceId]) return false; seen[a.resourceId] = true; return true;
          })
        : [{ resourceId: UNASSIGNED, units: 1 }];
      for (var i = r.es; i < r.ef; i++) {
        var dayNum = c.cal.indexToDay(c.anchor, i);
        asgs.forEach(function (a) { addDay(a.resourceId, dayNum, r.task.id, r.task.name || '', a.units); });
      }
    });

    var buckets = buildBuckets(c.projectStartDay, c.projectEndDay, size);
    var bucketIndex = {};
    buckets.forEach(function (b, i) { bucketIndex[b.key] = i; });

    // Assemble a resource entry (real resource or the unassigned bucket).
    function entryFor(rid) {
      var isUnassigned = rid === UNASSIGNED;
      var rate = isUnassigned ? 0 : (rateById[rid] || 0);
      var days = dailyRes[rid] || {};
      var cells = buckets.map(function () { return { hours: 0, cost: 0, peak: 0, over: false }; });
      var totalHours = 0, totalCost = 0, peakDaily = 0;

      Object.keys(days).forEach(function (dayNum) {
        var load = days[dayNum];
        var bk = bucketKeyFor(+dayNum, size);
        var bi = bucketIndex[bk];
        if (bi == null) return;
        var cell = cells[bi];
        cell.hours += load * HOURS_PER_DAY;
        cell.cost += load * rate;
        if (load > cell.peak) cell.peak = load;
        if (load > 1.0005) cell.over = true;
        totalHours += load * HOURS_PER_DAY;
        totalCost += load * rate;
        if (load > peakDaily) peakDaily = load;
      });

      // Per-task breakdown (for expandable rows). Task load is 1 unit/day.
      var tasks = Object.keys(taskDaysByRes[rid] || {}).map(function (taskId) {
        var tdays = taskDaysByRes[rid][taskId];
        var tcells = buckets.map(function () { return { hours: 0, cost: 0 }; });
        var tHours = 0, tCost = 0;
        Object.keys(tdays).forEach(function (dayNum) {
          var bi = bucketIndex[bucketKeyFor(+dayNum, size)];
          if (bi == null) return;
          var u = tdays[dayNum];
          tcells[bi].hours += u * HOURS_PER_DAY;
          tcells[bi].cost += rate * u;
          tHours += u * HOURS_PER_DAY; tCost += rate * u;
        });
        return {
          id: /^\d+$/.test(taskId) ? +taskId : taskId,
          name: taskName[taskId] || '',
          totalHours: tHours, totalCost: tCost, cells: tcells
        };
      }).sort(function (a, b) { return (a.id > b.id) ? 1 : (a.id < b.id ? -1 : 0); });

      return {
        id: isUnassigned ? null : rid,
        name: isUnassigned ? 'Unassigned' : nameById[rid],
        unassigned: isUnassigned,
        rate: rate,
        totalHours: totalHours, totalCost: totalCost,
        totalDays: totalHours / HOURS_PER_DAY,
        peakDaily: peakDaily,
        overallocated: peakDaily > 1.0005,
        cells: cells,
        tasks: tasks
      };
    }

    // Real resources in project order (only those with work), then unassigned.
    // Object keys coerce to strings, so dailyRes[r.id] finds numeric-id loads.
    var entries = (project.resources || []).filter(function (r) {
      return dailyRes[r.id];
    }).map(function (r) { return entryFor(r.id); });
    if (dailyRes[UNASSIGNED]) entries.push(entryFor(UNASSIGNED));

    // Column + grand totals.
    var perBucket = buckets.map(function () { return { hours: 0, cost: 0 }; });
    var grandHours = 0, grandCost = 0;
    entries.forEach(function (e) {
      e.cells.forEach(function (cell, bi) { perBucket[bi].hours += cell.hours; perBucket[bi].cost += cell.cost; });
      grandHours += e.totalHours; grandCost += e.totalCost;
    });

    return {
      bucket: size,
      buckets: buckets,
      resources: entries,
      totals: { perBucket: perBucket, hours: grandHours, cost: grandCost },
      overallocatedCount: entries.filter(function (e) { return e.overallocated; }).length
    };
  }

  return { build: build };
}));
