/*
 * ops.js — semantic operations layer: the programmatic interface to a project.
 *
 * Every mutation an AI (or script) can perform is expressed as a plain-JSON op
 * object, applied through the same Model methods the UI uses, so all invariants
 * (outline fixing, dedup, recompute, undo history) hold no matter who edits.
 *
 * Used by cli.js (command line), server.js (POST /api/projects/:name/ops), and
 * available to the browser as PM.Ops.
 *
 * Task references ("ref"): a positive integer = 1-based ROW number as shown in
 * the grid; "#42" = stable task id 42; "$2" = the task created by result index
 * 2 of the CURRENT ops batch (0-based); any other string = task name matched
 * case-insensitively (errors if ambiguous). Prefer "#id" in batches — row
 * numbers shift as ops execute (each op re-resolves against current state).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./calendar.js'));
  } else {
    root.PM = root.PM || {};
    root.PM.Ops = factory(root.PM.Calendar);
  }
}(typeof self !== 'undefined' ? self : this, function (Cal) {
  'use strict';

  function fail(msg) { var e = new Error(msg); e.opError = true; throw e; }

  function resolveRef(model, ref, batchResults) {
    var tasks = model.getProject().tasks;
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      var row = parseInt(ref, 10);
      if (row < 1 || row > tasks.length) fail('row ' + row + ' out of range (1..' + tasks.length + ')');
      return tasks[row - 1].id;
    }
    var s = String(ref);
    if (/^#\d+$/.test(s)) {
      var id = parseInt(s.slice(1), 10);
      if (model.findIndexById(id) < 0) fail('no task with id ' + id);
      return id;
    }
    if (/^\$\d+$/.test(s)) {
      var ri = parseInt(s.slice(1), 10);
      var res = batchResults && batchResults[ri];
      if (!res || res.id == null) fail('"$' + ri + '" does not reference an earlier result with a task id');
      if (model.findIndexById(res.id) < 0) fail('"$' + ri + '" resolves to id ' + res.id + ' which no longer exists');
      return res.id;
    }
    var matches = tasks.filter(function (t) { return t.name.toLowerCase() === s.toLowerCase(); });
    if (!matches.length) fail('no task named "' + s + '"');
    if (matches.length > 1) {
      fail('name "' + s + '" is ambiguous — candidates: ' +
        matches.map(function (t) { return '#' + t.id + ' (row ' + (model.findIndexById(t.id) + 1) + ')'; }).join(', ') +
        '. Use a #id ref.');
    }
    return matches[0].id;
  }

  function resolveRefs(model, refs, batchResults) {
    if (!Array.isArray(refs)) refs = [refs];
    return refs.map(function (r) { return resolveRef(model, r, batchResults); });
  }

  var SET_FIELDS = {
    name: 'name', duration: 'duration', dur: 'duration', start: 'start',
    predecessors: 'predecessors', preds: 'predecessors', pred: 'predecessors',
    resources: 'resources', res: 'resources',
    percentcomplete: 'percentComplete', pct: 'percentComplete', progress: 'percentComplete',
    deadline: 'deadline', notes: 'notes'
  };

  // Apply one op. Returns a small JSON-able result object.
  function applyOp(model, op, batchResults) {
    if (!op || typeof op !== 'object' || !op.op) fail('op must be an object with an "op" field');
    var p, id, ids, i;
    switch (String(op.op)) {

      case 'add-task': {
        p = model.getProject();
        var at = p.tasks.length, level = null;
        if (op.childOf != null) {
          id = resolveRef(model, op.childOf, batchResults);
          i = model.findIndexById(id);
          level = p.tasks[i].outlineLevel + 1;
          at = i + 1; // first child position
        } else if (op.after != null) {
          id = resolveRef(model, op.after, batchResults);
          at = model.findIndexById(id) + 1;
        }
        var newId = model.insertTask(at, level);
        var fields = ['name', 'duration', 'start', 'predecessors', 'resources', 'percentComplete', 'deadline', 'notes'];
        fields.forEach(function (f) {
          var v = op[f] != null ? op[f] : (f === 'percentComplete' && op.pct != null ? op.pct : null);
          if (v != null) model.setField(newId, f === 'percentComplete' ? 'percentComplete' : f, v);
        });
        return { op: 'add-task', id: newId, row: model.findIndexById(newId) + 1 };
      }

      case 'set': {
        id = resolveRef(model, op.row != null ? op.row : (op.id != null ? '#' + op.id : op.ref), batchResults);
        var field = SET_FIELDS[String(op.field || '').toLowerCase()];
        if (!field) fail('unknown field "' + op.field + '" (use: ' + Object.keys(SET_FIELDS).join(', ') + ')');
        model.setField(id, field, op.value);
        return { op: 'set', id: id, field: field };
      }

      case 'link': {
        ids = resolveRefs(model, op.rows != null ? op.rows : op.refs, batchResults);
        if (ids.length < 2) fail('link needs at least 2 tasks');
        if (op.type || op.lag) {
          // typed/lagged link: append a predecessor token to each successor
          var type = String(op.type || 'FS').toUpperCase();
          var lag = Math.round(Number(op.lag) || 0);
          for (i = 1; i < ids.length; i++) {
            var succId = ids[i], predId = ids[i - 1];
            var t = model.getProject().tasks[model.findIndexById(succId)];
            var predRow = model.findIndexById(predId) + 1;
            var existing = model.formatPredecessors(t.predecessors);
            var token = predRow + type + (lag ? (lag > 0 ? '+' + lag : String(lag)) : '');
            model.setField(succId, 'predecessors', existing ? existing + ', ' + token : token);
          }
        } else {
          model.linkTasks(ids);
        }
        return { op: 'link', ids: ids };
      }

      case 'unlink': {
        ids = resolveRefs(model, op.rows != null ? op.rows : op.refs, batchResults);
        model.unlinkTasks(ids);
        return { op: 'unlink', ids: ids };
      }

      case 'indent':
      case 'outdent': {
        ids = resolveRefs(model, op.rows != null ? op.rows : op.refs, batchResults);
        if (op.op === 'indent') model.indent(ids); else model.outdent(ids);
        return { op: op.op, ids: ids };
      }

      case 'move': {
        id = resolveRef(model, op.row != null ? op.row : op.ref, batchResults);
        var dir = op.dir === 'up' ? -1 : op.dir === 'down' ? 1 : Number(op.dir);
        if (dir !== -1 && dir !== 1) fail('move dir must be "up" or "down"');
        var times = Math.max(1, Math.round(Number(op.times) || 1));
        for (i = 0; i < times; i++) model.moveBlock(id, dir);
        return { op: 'move', id: id, row: model.findIndexById(id) + 1 };
      }

      case 'delete': {
        ids = resolveRefs(model, op.rows != null ? op.rows : op.refs, batchResults);
        model.deleteTasks(ids);
        return { op: 'delete', ids: ids };
      }

      case 'add-resource': {
        if (!op.name) fail('add-resource needs a name');
        var rid = model.addResource(String(op.name));
        if (op.rate != null) model.updateResource(rid, { rate: Math.max(0, Number(op.rate) || 0) });
        return { op: 'add-resource', id: rid };
      }

      case 'set-resource': {
        p = model.getProject();
        var res = null;
        if (op.id != null) res = p.resources.filter(function (r) { return r.id === Number(op.id); })[0];
        else if (op.name) res = p.resources.filter(function (r) { return r.name.toLowerCase() === String(op.name).toLowerCase(); })[0];
        if (!res) fail('resource not found');
        var patch = {};
        if (op.rate != null) patch.rate = Math.max(0, Number(op.rate) || 0);
        if (op.rename) patch.name = String(op.rename);
        model.updateResource(res.id, patch);
        return { op: 'set-resource', id: res.id };
      }

      case 'set-project': {
        if (op.name != null) model.setProjectName(String(op.name));
        if (op.start != null) model.setProjectStart(String(op.start));
        return { op: 'set-project' };
      }

      case 'set-calendar': {
        if (Array.isArray(op.workingDays)) model.setWorkingDays(op.workingDays.map(Number));
        if (Array.isArray(op.holidays)) model.setHolidays(op.holidays.map(String));
        return { op: 'set-calendar' };
      }

      case 'set-baseline': model.saveBaseline(); return { op: 'set-baseline' };
      case 'clear-baseline': model.clearBaseline(); return { op: 'clear-baseline' };

      case 'toggle-collapse': {
        id = resolveRef(model, op.row != null ? op.row : op.ref, batchResults);
        model.toggleCollapse(id);
        return { op: 'toggle-collapse', id: id };
      }

      default:
        fail('unknown op "' + op.op + '"');
    }
  }

  // Apply a list of ops; stops at the first failure. Callers treat a batch as
  // ATOMIC: on ok:false they must discard the model instead of persisting the
  // applied prefix (server.js and cli.js both do). failedIndex/failedOp let an
  // AI caller fix exactly the op that broke and resubmit the whole batch.
  function applyOps(model, ops) {
    if (!Array.isArray(ops)) ops = [ops];
    var results = [];
    for (var i = 0; i < ops.length; i++) {
      try {
        results.push(applyOp(model, ops[i], results));
      } catch (e) {
        return {
          ok: false, applied: i, failedIndex: i, failedOp: ops[i],
          error: (e && e.message) || String(e), results: results
        };
      }
    }
    return { ok: true, applied: ops.length, results: results };
  }

  // Machine-readable snapshot of the computed schedule (what an AI reads back).
  function buildScheduleReport(model) {
    var c = model.getComputed();
    var p = model.getProject();
    return {
      project: {
        name: p.name,
        startISO: p.startISO,
        rev: p.rev || 0,
        finishISO: Cal.toISO(c.projectEndDay),
        workingDays: c.projectFinish,
        cost: Math.round(c.projectCost || 0),
        hasCycle: c.hasCycle,
        cycleIds: c.cycleIds || null,
        overallocatedResources: c.overallocatedCount || 0,
        missedDeadlines: c.missedDeadlines || 0,
        taskCount: c.rows.length,
        baseline: p.baseline ? p.baseline.savedISO : null
      },
      resources: p.resources.map(function (r) {
        return { id: r.id, name: r.name, rate: r.rate || 0 };
      }),
      tasks: c.rows.map(function (r) {
        return {
          row: r.row,
          id: r.id,
          wbs: r.wbs,
          level: r.outlineLevel,
          name: r.name,
          type: r.isSummary ? 'summary' : (r.isMilestone ? 'milestone' : 'task'),
          durationDays: r.durationDays,
          startISO: Cal.toISO(r.startDay),
          finishISO: Cal.toISO(r.finishDay),
          predecessors: model.formatPredecessors(r.task.predecessors),
          resources: model.formatResources(r.task.resourceIds),
          percentComplete: r.percentComplete,
          cost: Math.round(r.cost || 0),
          slackDays: r.isSummary ? null : r.slack,
          critical: !!r.critical,
          constraintISO: r.task.constraintISO || null,
          deadlineISO: r.task.deadlineISO || null,
          deadlineMissed: !!r.deadlineMissed,
          overallocated: (r.overallocatedResources && r.overallocatedResources.length) ? r.overallocatedResources : [],
          notes: r.task.notes || ''
        };
      })
    };
  }

  return {
    applyOp: applyOp,
    applyOps: applyOps,
    buildScheduleReport: buildScheduleReport,
    resolveRef: resolveRef
  };
}));
