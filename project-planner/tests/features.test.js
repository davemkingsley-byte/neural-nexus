/* Tests for v2 features: cost roll-up, over-allocation, deadlines, CSV. node tests/features.test.js */
'use strict';
var Model = require('../js/model.js');
var Cal = require('../js/calendar.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

function setupPAB() {
  // P (summary) > A(5d, Alice@100) + B(4d, Alice+Bob@100+50)
  var m = Model.createModel();
  m.newProject();
  m.addTaskEnd(); m.addTaskEnd(); m.addTaskEnd();
  var t = m.getProject().tasks;
  m.setField(t[0].id, 'name', 'P');
  m.setField(t[1].id, 'name', 'A');
  m.setField(t[2].id, 'name', 'B');
  m.setField(t[1].id, 'duration', '5');
  m.setField(t[2].id, 'duration', '4');
  m.indent([t[1].id]); m.indent([t[2].id]);
  m.setField(t[1].id, 'resources', 'Alice');
  m.setField(t[2].id, 'resources', 'Alice, Bob');
  var res = m.getProject().resources;
  var alice = res.filter(function (r) { return r.name === 'Alice'; })[0];
  var bob = res.filter(function (r) { return r.name === 'Bob'; })[0];
  m.updateResource(alice.id, { rate: 100 });
  m.updateResource(bob.id, { rate: 50 });
  return m;
}

// ---- Cost roll-up ----
(function () {
  var m = setupPAB();
  var rows = m.getComputed().rows;
  eq(rows[1].cost, 500, 'A cost = 5d x $100');
  eq(rows[2].cost, 600, 'B cost = 4d x ($100+$50)');
  eq(rows[0].cost, 1100, 'summary P cost = children sum');
  eq(m.getComputed().projectCost, 1100, 'project cost = top-level sum');
})();

// ---- Nested summary cost counted once ----
(function () {
  var m = setupPAB();
  var t = m.getProject().tasks;
  // add C(2d, Alice) nested under B? B is a leaf; instead add S2 summary under P with child C.
  m.addTaskEnd();
  var c = m.getProject().tasks[3];
  m.setField(c.id, 'name', 'C');
  m.setField(c.id, 'duration', '2');
  m.setField(c.id, 'resources', 'Alice');
  m.indent([c.id]); m.indent([c.id]); // level 3: child of B -> B becomes summary
  var rows = m.getComputed().rows;
  var byName = {}; rows.forEach(function (r) { byName[r.name] = r; });
  ok(byName.B.isSummary, 'B is now a summary');
  eq(byName.C.cost, 200, 'C cost = 2d x $100');
  eq(byName.B.cost, 200, 'summary B cost = C only (own resources ignored once summary)');
  eq(byName.P.cost, 700, 'P cost = A(500) + B-subtree(200)');
})();

// ---- Over-allocation detection ----
(function () {
  var m = setupPAB();
  var c = m.getComputed();
  // A[0,5) and B[0,4) both use Alice -> overlap
  eq(c.overallocatedCount, 1, 'one resource overallocated (Alice)');
  ok(c.rows[1].overallocatedResources.indexOf('Alice') >= 0, 'A flagged with Alice');
  ok(c.rows[2].overallocatedResources.indexOf('Alice') >= 0, 'B flagged with Alice');
  ok(c.rows[2].overallocatedResources.indexOf('Bob') < 0, 'Bob not flagged (single task)');
  // Link B after A -> sequential -> conflict clears
  var t = m.getProject().tasks;
  m.setField(t[2].id, 'predecessors', '2'); // row 2 = A
  var c2 = m.getComputed();
  eq(c2.overallocatedCount, 0, 'sequential tasks clear the overallocation');
  eq(c2.rows[1].overallocatedResources.length, 0, 'A unflagged after linking');
})();

// ---- Milestones never conflict ----
(function () {
  var m = Model.createModel();
  m.newProject();
  m.addTaskEnd(); m.addTaskEnd();
  var t = m.getProject().tasks;
  m.setField(t[0].id, 'duration', '5');
  m.setField(t[1].id, 'duration', '0'); // milestone
  m.setField(t[0].id, 'resources', 'Ann');
  m.setField(t[1].id, 'resources', 'Ann');
  eq(m.getComputed().overallocatedCount, 0, 'milestone assignment causes no conflict');
})();

// ---- Deadlines ----
(function () {
  var m = Model.createModel();
  m.newProject();
  m.addTaskEnd();
  var t = m.getProject().tasks[0];
  m.setField(t.id, 'duration', '5');
  var row = m.getComputed().rows[0];
  // deadline 2 calendar days after start -> before a 5-working-day finish -> missed
  m.setField(t.id, 'deadline', Cal.toISO(row.startDay + 2));
  var r1 = m.getComputed();
  ok(r1.rows[0].deadlineMissed, 'tight deadline flagged as missed');
  eq(r1.missedDeadlines, 1, 'missed count = 1');
  // deadline 30 days out -> met
  m.setField(t.id, 'deadline', Cal.toISO(row.startDay + 30));
  var r2 = m.getComputed();
  ok(!r2.rows[0].deadlineMissed, 'loose deadline not missed');
  eq(r2.missedDeadlines, 0, 'missed count = 0');
  // clearing the deadline removes the marker
  m.setField(t.id, 'deadline', '');
  eq(m.getComputed().rows[0].deadlineDay, null, 'cleared deadline -> no marker');
})();

// ---- Deadline never moves the schedule ----
(function () {
  var m = Model.createModel();
  m.newProject();
  m.addTaskEnd();
  var t = m.getProject().tasks[0];
  m.setField(t.id, 'duration', '5');
  var before = m.getComputed().rows[0].startDay;
  m.setField(t.id, 'deadline', Cal.toISO(before + 1));
  eq(m.getComputed().rows[0].startDay, before, 'deadline does not shift the start');
  eq(m.getComputed().projectFinish, 5, 'deadline does not shift the finish');
})();

// ---- CSV export ----
(function () {
  var m = Model.createModel();
  m.newProject();
  m.addTaskEnd(); m.addTaskEnd();
  var t = m.getProject().tasks;
  m.setField(t[0].id, 'name', 'He said "hi", ok');
  m.setField(t[0].id, 'duration', '3');
  m.setField(t[1].id, 'name', 'Simple');
  m.setField(t[1].id, 'predecessors', '1');
  var csv = m.toCSV();
  var lines = csv.split('\r\n');
  eq(lines.length, 3, 'header + 2 rows');
  ok(lines[0].indexOf('WBS,Task Name') === 0, 'header present');
  ok(lines[1].indexOf('"He said ""hi"", ok"') >= 0, 'quotes/commas escaped');
  ok(lines[2].indexOf('Simple') >= 0, 'second row present');
  ok(lines[2].indexOf(',1,') >= 0 || /,1,/.test(lines[2]), 'predecessor exported');
})();

// ---- Duplicate resourceIds in a loaded file: cost counted once, no self-conflict ----
(function () {
  var m = Model.createModel();
  m.loadProject({
    name: 'dup-test', startISO: '2026-07-13',
    calendar: { workingDays: [1, 2, 3, 4, 5], holidays: [] },
    resources: [{ id: 3, name: 'Dev', initials: 'DV', color: '#059669', rate: 800 }],
    tasks: [{ id: 1, name: 'Work', duration: 5, outlineLevel: 1, predecessors: [],
              percentComplete: 0, resourceIds: [3, 3], collapsed: false,
              constraintISO: null, deadlineISO: null, notes: '' }],
    nextTaskId: 2, nextResourceId: 4, baseline: null, view: { zoom: 'week' }
  });
  var c = m.getComputed();
  eq(m.getProject().tasks[0].resourceIds, [3], 'duplicate resource id de-duped on load');
  eq(c.rows[0].cost, 4000, 'cost counted once: 5d x $800');
  eq(c.overallocatedCount, 0, 'no false self-overallocation from duplicate id');
})();

// ---- Money formatting ----
(function () {
  eq(Model.formatMoney(0), '$0', 'money 0');
  eq(Model.formatMoney(1234567), '$1,234,567', 'money grouping');
  eq(Model.formatMoney(999), '$999', 'money no group under 1000');
})();

console.log('\nFeature tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
