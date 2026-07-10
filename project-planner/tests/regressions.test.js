/* Regression tests for bugs found in adversarial review. node tests/regressions.test.js */
'use strict';
var Scheduler = require('../js/scheduler.js');
var Model = require('../js/model.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }
function byId(res) { var m = {}; res.results.forEach(function (r) { m[r.id] = r; }); return m; }
function T(id, d, o) { o = o || {}; return { id: id, duration: d, outlineLevel: o.level || 1, predecessors: o.preds || [], percentComplete: o.pct || 0, constraintIndex: o.constraint != null ? o.constraint : null }; }
function P(id, t, l) { return { id: id, type: t || 'FS', lag: l || 0 }; }

// --- Bug A/#1/#3: backward pass must cap late-finish at projectFinish ---
(function () {
  // A defines the finish (dur 10); B is an SS successor. A must stay critical.
  var m = byId(Scheduler.schedule([T('A', 10), T('B', 2, { preds: [P('A', 'SS', 0)] })]));
  eq(m.A.slack, 0, 'A slack 0 with SS successor');
  ok(m.A.critical, 'A critical with SS successor');

  // Milestone successor via FS with negative lag; predecessor drives the finish.
  var m2 = byId(Scheduler.schedule([T('A', 5), T('M', 0, { preds: [P('A', 'FS', -2)] })]));
  ok(m2.A.critical, 'A critical with FS-2 milestone successor');
  ok(m2.A.slack <= 0, 'A has no positive slack (finish driver)');
})();

// --- Bug B/#6/#10: a self-predecessor must not be treated as a cycle ---
(function () {
  var res = Scheduler.schedule([T('A', 3, { preds: [P('A')] }), T('B', 2, { preds: [P('A')] })]);
  ok(!res.hasCycle, 'self-predecessor is not a cycle');
  var m = byId(res);
  eq([m.B.es, m.B.ef], [3, 5], 'B still scheduled after A despite A self-ref');
})();

// --- Bug C/#2: a predecessor on a summary constrains its children ---
(function () {
  var res = Scheduler.schedule([
    T('S1', 0, { level: 1 }),
    T('a', 5, { level: 2 }),
    T('S2', 0, { level: 1, preds: [P('S1')] }),
    T('b', 3, { level: 2 })
  ]);
  var m = byId(res);
  eq(m.a.ef, 5, 'S1 child a finishes at 5');
  eq(m.b.es, 5, 'child of summary S2 (which depends on S1) starts no earlier than 5');
  eq(m.b.ef, 8, 'child b window respects inherited summary dependency');
})();

// --- Bug D/#5: %complete roll-up must weight nested summaries by their leaf work ---
(function () {
  var mm = Model.createModel();
  mm.newProject();
  for (var i = 0; i < 4; i++) mm.addTaskEnd();
  var t = mm.getProject().tasks;   // rows: P, A, B, c
  mm.setField(t[0].id, 'name', 'P');
  mm.setField(t[1].id, 'name', 'A');
  mm.setField(t[2].id, 'name', 'B');
  mm.setField(t[3].id, 'name', 'c');
  mm.setField(t[1].id, 'duration', '10');
  mm.setField(t[3].id, 'duration', '10');
  mm.setField(t[1].id, 'percentComplete', '0');
  mm.setField(t[3].id, 'percentComplete', '100');
  // build hierarchy: A,B under P ; c under B
  mm.indent([t[1].id]);           // A -> level2
  mm.indent([t[2].id]);           // B -> level2
  mm.indent([t[3].id]);           // c -> level2
  mm.indent([t[3].id]);           // c -> level3 (under B)
  var rows = mm.getComputed().rows;
  var byName = {}; rows.forEach(function (r) { byName[r.name] = r; });
  eq(byName.B.percentComplete, 100, 'summary B rolls up to 100%');
  eq(byName.P.percentComplete, 50, 'summary P weights nested summary B by its leaf work -> 50%');
})();

// --- Bug E/#11: absurd durations are clamped (no OOM) ---
(function () {
  ok(Model.parseDuration('9999999') <= 100000, 'huge duration clamped');
  ok(Model.parseDuration('500000w') <= 100000, 'huge week duration clamped');
})();

// --- Bug F/#6: a self-predecessor typed in the grid is not stored ---
(function () {
  var mm = Model.createModel();
  mm.newProject();
  mm.addTaskEnd(); mm.addTaskEnd(); mm.addTaskEnd();
  var t = mm.getProject().tasks;
  mm.setField(t[2].id, 'predecessors', '3, 1'); // row 3 is itself
  var preds = mm.getProject().tasks[2].predecessors;
  eq(preds.length, 1, 'self-reference dropped, only row 1 kept');
  eq(preds[0].id, t[0].id, 'kept predecessor is row 1');
  ok(!mm.getComputed().hasCycle, 'no phantom cycle from self-ref');
})();

console.log('\nRegression tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
