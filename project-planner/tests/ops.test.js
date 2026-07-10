/* Tests for the semantic ops layer (the AI interface). node tests/ops.test.js */
'use strict';
var Model = require('../js/model.js');
var Ops = require('../js/ops.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

function freshModel() {
  var m = Model.createModel();
  m.newProject();
  return m;
}

// ---- Build a small plan entirely through ops (the way an AI would) ----
(function () {
  var m = freshModel();
  var r = Ops.applyOps(m, [
    { op: 'add-task', name: 'Phase 1', duration: 0 },                          // $0 row1
    { op: 'add-task', name: 'Design', duration: '5d', childOf: '$0' },         // $1
    { op: 'add-task', name: 'Build', duration: '2w', after: '$1' },            // $2
    { op: 'link', rows: ['$1', '$2'] },
    { op: 'add-task', name: 'Ship', duration: 0, after: '$2', predecessors: '3' },
    { op: 'add-resource', name: 'Dev Team', rate: 1000 },
    { op: 'set', row: '$2', field: 'res', value: 'Dev Team' }
  ]);
  ok(r.ok, 'batch applied cleanly: ' + (r.error || ''));
  eq(r.applied, 7, 'all 7 ops applied');

  var rep = Ops.buildScheduleReport(m);
  eq(rep.tasks.length, 4, '4 tasks');
  eq(rep.tasks[0].type, 'summary', 'Phase 1 is a summary');
  eq(rep.tasks[1].name, 'Design', 'row2 Design');
  eq(rep.tasks[2].durationDays, 10, '2w == 10 days');
  eq(rep.tasks[2].predecessors, '2', 'Build after Design');
  eq(rep.tasks[2].cost, 10000, 'Build costs 10d x $1000');
  eq(rep.tasks[3].type, 'milestone', 'Ship is milestone');
  eq(rep.project.workingDays, 15, 'project = 5 + 10 working days');
  ok(rep.tasks[3].critical, 'Ship on critical path');
})();

// ---- childOf inserts as first child; after inserts directly after ----
(function () {
  var m = freshModel();
  Ops.applyOps(m, [
    { op: 'add-task', name: 'S', duration: 0 },
    { op: 'add-task', name: 'A', childOf: 'S' },
    { op: 'add-task', name: 'B', childOf: 'S' }   // becomes first child, before A
  ]);
  var names = m.getProject().tasks.map(function (t) { return t.name; });
  eq(names, ['S', 'B', 'A'], 'childOf inserts at first-child position');
  var rep = Ops.buildScheduleReport(m);
  eq(rep.tasks[1].level, 2, 'B is level 2');
  eq(rep.tasks[2].level, 2, 'A is level 2');
})();

// ---- Typed/lagged link ----
(function () {
  var m = freshModel();
  var r = Ops.applyOps(m, [
    { op: 'add-task', name: 'X', duration: 4 },
    { op: 'add-task', name: 'Y', duration: 3 },
    { op: 'link', rows: ['X', 'Y'], type: 'SS', lag: 2 }
  ]);
  ok(r.ok, 'typed link ok');
  var rep = Ops.buildScheduleReport(m);
  eq(rep.tasks[1].predecessors, '1SS+2', 'SS+2 token stored');
  // Y starts 2 working days after X starts
  ok(rep.tasks[1].startISO > rep.tasks[0].startISO, 'Y starts after X starts');
})();

// ---- Atomicity contract: failed batch reports failedIndex + failing op ----
(function () {
  var m = freshModel();
  var r = Ops.applyOps(m, [
    { op: 'add-task', name: 'OK task' },
    { op: 'set', row: 99, field: 'duration', value: '5' },  // row out of range
    { op: 'add-task', name: 'never reached' }
  ]);
  ok(!r.ok, 'batch failed');
  eq(r.failedIndex, 1, 'failedIndex is 1');
  eq(r.failedOp.op, 'set', 'failing op echoed');
  ok(/out of range/.test(r.error), 'error names the problem');
  // NOTE: applyOps mutates the model prefix; PERSISTENCE atomicity is the
  // caller's job (server/cli discard the model on !ok) — tested in server.test.js.
})();

// ---- Ambiguous name refs error with candidates ----
(function () {
  var m = freshModel();
  Ops.applyOps(m, [
    { op: 'add-task', name: 'Review' },
    { op: 'add-task', name: 'Review' }
  ]);
  var r = Ops.applyOps(m, [{ op: 'set', row: 'Review', field: 'duration', value: '3' }]);
  ok(!r.ok, 'ambiguous name rejected');
  ok(/ambiguous/.test(r.error) && /#1/.test(r.error) && /#2/.test(r.error), 'candidates listed: ' + r.error);
})();

// ---- #id refs stay stable across reorder ----
(function () {
  var m = freshModel();
  Ops.applyOps(m, [
    { op: 'add-task', name: 'First' },   // id 1
    { op: 'add-task', name: 'Second' }   // id 2
  ]);
  Ops.applyOps(m, [{ op: 'move', row: 2, dir: 'up' }]);
  var r = Ops.applyOps(m, [{ op: 'set', row: '#1', field: 'name', value: 'First-renamed' }]);
  ok(r.ok, '#id ref works after reorder');
  eq(m.getProject().tasks[1].name, 'First-renamed', 'renamed the right task (now row 2)');
})();

// ---- move/indent/outdent/delete through ops ----
(function () {
  var m = freshModel();
  Ops.applyOps(m, [
    { op: 'add-task', name: 'A' },
    { op: 'add-task', name: 'B' },
    { op: 'add-task', name: 'C' }
  ]);
  Ops.applyOps(m, [{ op: 'indent', rows: [2, 3] }]);
  ok(Ops.buildScheduleReport(m).tasks[0].type === 'summary', 'A became summary after indent');
  Ops.applyOps(m, [{ op: 'outdent', rows: [3] }]);
  eq(m.getProject().tasks[2].outlineLevel, 1, 'C outdented to level 1');
  var r = Ops.applyOps(m, [{ op: 'delete', rows: ['C'] }]);
  ok(r.ok, 'delete by name');
  eq(m.getProject().tasks.length, 2, 'two tasks left');
})();

// ---- set-calendar + set-project ----
(function () {
  var m = freshModel();
  Ops.applyOps(m, [
    { op: 'set-project', name: 'Renamed', start: '2026-08-03' },
    { op: 'set-calendar', workingDays: [1, 2, 3, 4], holidays: ['2026-08-05'] },
    { op: 'add-task', name: 'T', duration: 5 }
  ]);
  var rep = Ops.buildScheduleReport(m);
  eq(rep.project.name, 'Renamed', 'project renamed');
  eq(rep.project.startISO, '2026-08-03', 'start set');
  // Mon 8/3 start; Wed 8/5 holiday; Fri non-working -> 5 working days: 3,4,6(Thu),10(Mon),11(Tue)
  eq(rep.tasks[0].finishISO, '2026-08-11', '4-day week + holiday schedule respected');
})();

// ---- baseline ops ----
(function () {
  var m = freshModel();
  Ops.applyOps(m, [{ op: 'add-task', name: 'T', duration: 3 }, { op: 'set-baseline' }]);
  ok(m.getProject().baseline, 'baseline stored');
  Ops.applyOps(m, [{ op: 'clear-baseline' }]);
  ok(!m.getProject().baseline, 'baseline cleared');
})();

// ---- REVIEW FIX: $N must reference an add-task result, not a resource ----
(function () {
  var m = freshModel();
  var r = Ops.applyOps(m, [
    { op: 'add-task', name: 'A' },
    { op: 'add-resource', name: 'Dev' },
    { op: 'set', row: '$1', field: 'pct', value: 50 }  // $1 is the RESOURCE result
  ]);
  ok(!r.ok, '$N to a resource result rejected');
  eq(r.failedIndex, 2, 'failed at the $N op');
  ok(/add-task result/.test(r.error), 'error explains the constraint: ' + r.error);
  eq(m.getProject().tasks[0].percentComplete, 0, 'task A untouched');
})();

// ---- REVIEW FIX: move times is clamped (no event-loop DoS) ----
(function () {
  var m = freshModel();
  Ops.applyOps(m, [{ op: 'add-task', name: 'A' }, { op: 'add-task', name: 'B' }]);
  var t0 = Date.now();
  var r = Ops.applyOps(m, [{ op: 'move', row: 1, dir: 'down', times: 2000000000 }]);
  ok(r.ok, 'huge times applies (clamped)');
  ok(Date.now() - t0 < 2000, 'returns quickly, not billions of iterations');
  eq(m.getProject().tasks[1].name, 'A', 'A ended up at the bottom');
})();

// ---- REVIEW FIX: cyclic project reports null slack, never fake numbers ----
(function () {
  var m = freshModel();
  Ops.applyOps(m, [
    { op: 'add-task', name: 'A', duration: 2 },
    { op: 'add-task', name: 'B', duration: 3 }
  ]);
  m.setField(m.getProject().tasks[0].id, 'predecessors', '2');
  m.setField(m.getProject().tasks[1].id, 'predecessors', '1');
  var rep = Ops.buildScheduleReport(m);
  ok(rep.project.hasCycle, 'cycle detected');
  ok(rep.tasks.every(function (t) { return t.slackDays === null; }), 'all slackDays null under a cycle');
  ok(rep.tasks.every(function (t) { return !t.critical; }), 'no critical flags under a cycle');
  var csv = m.toCSV();
  ok(csv.indexOf('null') < 0, 'CSV has no "null" slack text');
})();

// ---- unknown op ----
(function () {
  var m = freshModel();
  var r = Ops.applyOps(m, [{ op: 'explode' }]);
  ok(!r.ok && /unknown op/.test(r.error), 'unknown op rejected');
})();

console.log('\nOps tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
