/* Tests for the timephased Resource Usage engine. node tests/usage.test.js */
'use strict';
var Model = require('../js/model.js');
var Ops = require('../js/ops.js');
var Usage = require('../js/usage.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

function res(u, name) { return u.resources.filter(function (r) { return r.name === name; })[0]; }

// A deterministic plan: Alice double-booked, Bob single, one unassigned task,
// one milestone (no work).
function plan() {
  var m = Model.createModel();
  m.newProject();
  m.setProjectStart('2026-07-13'); // Monday
  m.setWorkingDays([1, 2, 3, 4, 5]);
  Ops.applyOps(m, [
    { op: 'add-task', name: 'A', duration: 5, resources: 'Alice' }, // Mon-Fri
    { op: 'add-task', name: 'B', duration: 3, resources: 'Alice' }, // Mon-Wed (overlaps A)
    { op: 'add-task', name: 'C', duration: 2, resources: 'Bob' },
    { op: 'add-task', name: 'U', duration: 4 },                     // unassigned
    { op: 'add-task', name: 'M', duration: 0, resources: 'Bob' }    // milestone: no work
  ]);
  var t = m.getProject().tasks;
  m.setField(t[2].id, 'predecessors', String(t[0].id)); // C after A
  m.updateResource(m.getProject().resources.filter(function (r) { return r.name === 'Alice'; })[0].id, { rate: 800 });
  m.updateResource(m.getProject().resources.filter(function (r) { return r.name === 'Bob'; })[0].id, { rate: 500 });
  return m;
}

// ---- per-resource work + over-allocation ----
(function () {
  var m = plan();
  var u = Usage.build(m, { bucket: 'week' });

  var alice = res(u, 'Alice'), bob = res(u, 'Bob'), un = res(u, 'Unassigned');
  ok(alice && bob && un, 'Alice, Bob, Unassigned all present');

  // Alice: 5 task-days on A + 3 on B = 8 -> 64h; double-booked so peak 2, over.
  eq(alice.totalHours, 64, 'Alice total hours = (5+3)*8');
  eq(alice.totalDays, 8, 'Alice total task-days = 8');
  eq(alice.peakDaily, 2, 'Alice peak daily load = 2 (double-booked)');
  ok(alice.overallocated, 'Alice flagged over-allocated');
  eq(alice.totalCost, 8 * 800, 'Alice cost = 8 task-days * 800 (double-booked days billed twice)');

  // Bob: only C carries work (2 days). The milestone M contributes nothing.
  eq(bob.totalHours, 16, 'Bob total hours = 2*8 (milestone excluded)');
  eq(bob.peakDaily, 1, 'Bob peak daily load = 1');
  ok(!bob.overallocated, 'Bob not over-allocated');
  eq(bob.totalCost, 2 * 500, 'Bob cost = 2*500');

  // Unassigned: 4 days of work, zero cost.
  eq(un.totalHours, 32, 'Unassigned hours = 4*8');
  eq(un.totalCost, 0, 'Unassigned cost = 0');

  eq(u.overallocatedCount, 1, 'exactly one over-allocated resource');
})();

// ---- column + grand totals reconcile; bucket size is work-preserving ----
(function () {
  var m = plan();
  var week = Usage.build(m, { bucket: 'week' });
  var day = Usage.build(m, { bucket: 'day' });
  var month = Usage.build(m, { bucket: 'month' });

  // Grand total identical regardless of bucketing.
  eq(day.totals.hours, week.totals.hours, 'day vs week: same grand hours');
  eq(month.totals.hours, week.totals.hours, 'month vs week: same grand hours');
  eq(day.totals.cost, week.totals.cost, 'day vs week: same grand cost');

  // Sum of per-bucket column totals equals the grand total.
  var colHours = week.totals.perBucket.reduce(function (a, b) { return a + b.hours; }, 0);
  eq(colHours, week.totals.hours, 'week column totals sum to grand total');

  // Each resource's cells sum to its own total.
  week.resources.forEach(function (r) {
    var s = r.cells.reduce(function (a, c) { return a + c.hours; }, 0);
    eq(s, r.totalHours, r.name + ': cells sum to resource total');
  });

  // Grand total = sum over resources.
  var expect = 64 + 16 + 32;
  eq(week.totals.hours, expect, 'grand hours = Alice 64 + Bob 16 + Unassigned 32');
})();

// ---- over-allocation is pinpointed to specific buckets ----
(function () {
  var m = plan();
  var u = Usage.build(m, { bucket: 'week' });
  var alice = res(u, 'Alice');
  // Alice's over-allocation is in the first week (A+B overlap Mon-Wed).
  var overCells = alice.cells.filter(function (c) { return c.over; });
  ok(overCells.length >= 1, 'at least one Alice bucket flagged over-allocated');
  ok(overCells.every(function (c) { return c.peak >= 2; }), 'flagged buckets have peak >= 2');
})();

// ---- per-task breakdown (expandable rows) ----
(function () {
  var m = plan();
  var u = Usage.build(m, { bucket: 'week' });
  var alice = res(u, 'Alice');
  eq(alice.tasks.length, 2, 'Alice has two task rows (A, B)');
  var names = alice.tasks.map(function (t) { return t.name; }).sort();
  eq(names, ['A', 'B'], 'Alice task rows are A and B');
  var aTask = alice.tasks.filter(function (t) { return t.name === 'A'; })[0];
  eq(aTask.totalHours, 40, 'task A = 5*8 hours');
  // task cells sum to task total
  var s = aTask.cells.reduce(function (a, c) { return a + c.hours; }, 0);
  eq(s, aTask.totalHours, 'task A cells sum to its total');
})();

// ---- empty project doesn't crash ----
(function () {
  var m = Model.createModel();
  m.newProject();
  var u = Usage.build(m, { bucket: 'week' });
  eq(u.resources.length, 0, 'no resources');
  eq(u.totals.hours, 0, 'no work');
  eq(u.buckets.length >= 0, true, 'buckets array present');
})();

// ---- a project with no assignments at all -> everything is Unassigned ----
(function () {
  var m = Model.createModel();
  m.newProject();
  m.setProjectStart('2026-07-13');
  Ops.applyOps(m, [{ op: 'add-task', name: 'Solo', duration: 3 }]);
  var u = Usage.build(m, { bucket: 'week' });
  eq(u.resources.length, 1, 'only the Unassigned entry');
  eq(u.resources[0].unassigned, true, 'entry marked unassigned');
  eq(u.resources[0].totalHours, 24, '3*8 hours unassigned');
})();

console.log('\nUsage tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
