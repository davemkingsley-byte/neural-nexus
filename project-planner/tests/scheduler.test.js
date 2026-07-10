/* Node test harness for the scheduling engine. Run: node tests/scheduler.test.js */
'use strict';
var Scheduler = require('../js/scheduler.js');

var passed = 0, failed = 0, failures = [];
function eq(actual, expected, msg) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; failures.push(msg + '\n    expected ' + e + '\n    actual   ' + a); }
}
function ok(cond, msg) { if (cond) passed++; else { failed++; failures.push(msg); } }

function byId(res) {
  var m = {};
  res.results.forEach(function (r) { m[r.id] = r; });
  return m;
}

// Helper to make a task
function T(id, duration, opts) {
  opts = opts || {};
  return {
    id: id,
    duration: duration,
    outlineLevel: opts.level || 1,
    predecessors: opts.preds || [],
    percentComplete: opts.pct || 0,
    constraintIndex: opts.constraint != null ? opts.constraint : null
  };
}
function P(id, type, lag) { return { id: id, type: type || 'FS', lag: lag || 0 }; }

// ---------------------------------------------------------------------------
// 1. Classic CPM example
//    A(3) B(4)  C(2,FS A)  D(5,FS B,C)  E(1,FS D)
//    Critical path: A -> C -> D -> E  (len 11).  B has 1 slack.
// ---------------------------------------------------------------------------
(function () {
  var res = Scheduler.schedule([
    T('A', 3),
    T('B', 4),
    T('C', 2, { preds: [P('A')] }),
    T('D', 5, { preds: [P('B'), P('C')] }),
    T('E', 1, { preds: [P('D')] })
  ]);
  var m = byId(res);
  eq(res.projectFinish, 11, 'CPM: project finish');
  eq([m.A.es, m.A.ef], [0, 3], 'CPM: A window');
  eq([m.B.es, m.B.ef], [0, 4], 'CPM: B window');
  eq([m.C.es, m.C.ef], [3, 5], 'CPM: C window');
  eq([m.D.es, m.D.ef], [5, 10], 'CPM: D window');
  eq([m.E.es, m.E.ef], [10, 11], 'CPM: E window');
  eq(m.B.slack, 1, 'CPM: B slack == 1');
  ok(m.A.critical && m.C.critical && m.D.critical && m.E.critical, 'CPM: critical chain A,C,D,E');
  ok(!m.B.critical, 'CPM: B not critical');
})();

// ---------------------------------------------------------------------------
// 2. Dependency types SS / FF / SF with lag
// ---------------------------------------------------------------------------
(function () {
  // SS+2: B starts 2 after A starts
  var r1 = byId(Scheduler.schedule([T('A', 5), T('B', 3, { preds: [P('A', 'SS', 2)] })]));
  eq([r1.B.es, r1.B.ef], [2, 5], 'SS+2 window');

  // FF: B finishes when A finishes -> B.ef == A.ef -> B.es = A.ef - dur
  var r2 = byId(Scheduler.schedule([T('A', 6), T('B', 2, { preds: [P('A', 'FF', 0)] })]));
  eq([r2.B.es, r2.B.ef], [4, 6], 'FF window');

  // FS with lag 2: B starts 2 working days after A finishes
  var r3 = byId(Scheduler.schedule([T('A', 3), T('B', 1, { preds: [P('A', 'FS', 2)] })]));
  eq([r3.B.es, r3.B.ef], [5, 6], 'FS+2 window');

  // FS with negative lag (lead): B starts 1 day before A finishes
  var r4 = byId(Scheduler.schedule([T('A', 4), T('B', 2, { preds: [P('A', 'FS', -1)] })]));
  eq([r4.B.es, r4.B.ef], [3, 5], 'FS-1 (lead) window');

  // SF: successor finishes when predecessor starts
  var r5 = byId(Scheduler.schedule([T('A', 5, { preds: [] }), T('B', 2, { preds: [P('A', 'SF', 0)] })]));
  // A.es=0 -> B.ef = 0 -> B.es = -2 -> clamped to 0, ef=2
  eq([r5.B.es, r5.B.ef], [0, 2], 'SF window (clamped at project start)');
})();

// ---------------------------------------------------------------------------
// 3. Summary roll-up + WBS
// ---------------------------------------------------------------------------
(function () {
  var res = Scheduler.schedule([
    T('S', 0, { level: 1 }),               // summary
    T('a', 3, { level: 2 }),               // child
    T('b', 2, { level: 2, preds: [P('a')] }) // child, after a
  ]);
  var m = byId(res);
  ok(m.S.isSummary, 'summary flagged');
  eq([m.S.es, m.S.ef], [0, 5], 'summary spans children 0..5');
  eq([m.a.es, m.a.ef], [0, 3], 'child a window');
  eq([m.b.es, m.b.ef], [3, 5], 'child b window');
  eq(m.S.wbs, '1', 'summary wbs');
  eq(m.a.wbs, '1.1', 'child a wbs');
  eq(m.b.wbs, '1.2', 'child b wbs');
})();

// ---------------------------------------------------------------------------
// 4. Nested summaries + WBS numbering across top-level tasks
// ---------------------------------------------------------------------------
(function () {
  var res = Scheduler.schedule([
    T('P1', 0, { level: 1 }),
    T('P1a', 2, { level: 2 }),
    T('P1sub', 0, { level: 2 }),
    T('P1sub-x', 1, { level: 3 }),
    T('P2', 4, { level: 1 })
  ]);
  var m = byId(res);
  eq(m.P1.wbs, '1', 'nested wbs P1');
  eq(m.P1a.wbs, '1.1', 'nested wbs P1a');
  eq(m.P1sub.wbs, '1.2', 'nested wbs P1sub');
  eq(m['P1sub-x'].wbs, '1.2.1', 'nested wbs P1sub-x');
  eq(m.P2.wbs, '2', 'nested wbs P2');
  ok(m.P1.isSummary && m.P1sub.isSummary && !m.P2.isSummary, 'nested summary flags');
})();

// ---------------------------------------------------------------------------
// 5. Milestone
// ---------------------------------------------------------------------------
(function () {
  var res = Scheduler.schedule([
    T('work', 5),
    T('done', 0, { preds: [P('work')] })
  ]);
  var m = byId(res);
  ok(m.done.isMilestone, 'milestone flagged');
  eq([m.done.es, m.done.ef], [5, 5], 'milestone at index 5, zero width');
})();

// ---------------------------------------------------------------------------
// 6. Cycle detection does not hang and is reported
// ---------------------------------------------------------------------------
(function () {
  var res = Scheduler.schedule([
    T('A', 2, { preds: [P('B')] }),
    T('B', 2, { preds: [P('A')] })
  ]);
  ok(res.hasCycle, 'cycle detected');
  ok(res.cycleIds && res.cycleIds.length >= 2, 'cycle ids reported');
})();

// ---------------------------------------------------------------------------
// 7. Constraint (Start-No-Earlier-Than) acts as a floor
// ---------------------------------------------------------------------------
(function () {
  var res = Scheduler.schedule([
    T('A', 2),
    T('B', 3, { preds: [P('A')], constraint: 10 })
  ]);
  var m = byId(res);
  eq([m.B.es, m.B.ef], [10, 13], 'constraint floor applied over predecessor');
})();

// ---------------------------------------------------------------------------
// 8. Parallel chains -> correct slack on the shorter one
// ---------------------------------------------------------------------------
(function () {
  // Start -> {A(2)->end, B(5)->end}; B path is critical, A has slack 3.
  var res = Scheduler.schedule([
    T('start', 0),
    T('A', 2, { preds: [P('start')] }),
    T('B', 5, { preds: [P('start')] }),
    T('end', 0, { preds: [P('A'), P('B')] })
  ]);
  var m = byId(res);
  eq(res.projectFinish, 5, 'parallel: finish 5');
  eq(m.A.slack, 3, 'parallel: A slack 3');
  eq(m.B.slack, 0, 'parallel: B slack 0');
  ok(m.B.critical && !m.A.critical, 'parallel: B critical, A not');
})();

// ---------------------------------------------------------------------------
// 9. Long chain converges (relaxation depth stress)
// ---------------------------------------------------------------------------
(function () {
  var tasks = [];
  for (var i = 0; i < 50; i++) {
    tasks.push(T('n' + i, 1, i === 0 ? {} : { preds: [P('n' + (i - 1))] }));
  }
  var res = Scheduler.schedule(tasks);
  eq(res.projectFinish, 50, 'chain of 50 unit tasks finishes at 50');
  ok(res.results.every(function (r) { return r.critical; }), 'entire chain critical');
})();

// ---------------------------------------------------------------------------
console.log('\nScheduler tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) {
  console.log('\nFAILURES:\n' + failures.map(function (f, i) { return (i + 1) + ') ' + f; }).join('\n'));
  process.exit(1);
}
