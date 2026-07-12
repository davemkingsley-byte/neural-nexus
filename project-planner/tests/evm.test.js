/* Earned value tests with hand-computed expectations. node tests/evm.test.js */
'use strict';
var Model = require('../js/model.js');
var Ops = require('../js/ops.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function approx(a, e, msg) { if (a != null && Math.abs(a - e) < 0.005) passed++; else { failed++; failures.push(msg + ' expected ~' + e + ' got ' + a); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

// Two 5-day tasks, sequential; one resource @ $100/day => each BAC = 5*100 = $500.
// Project BAC = $1000. Start Mon 2026-07-13.
function build() {
  var m = Model.createModel();
  m.newProject();
  m.setProjectStart('2026-07-13');
  Ops.applyOps(m, [
    { op: 'add-resource', name: 'Dev', rate: 100 },
    { op: 'add-task', name: 'A', duration: 5, resources: 'Dev' },
    { op: 'add-task', name: 'B', duration: 5, predecessors: '1', resources: 'Dev' }
  ]);
  return m;
}

// ---- unavailable until baseline + status date ----
(function () {
  var m = build();
  ok(!m.getComputed().evm.available, 'no baseline/status -> unavailable');
  m.saveBaseline();
  ok(!m.getComputed().evm.available, 'baseline only -> still unavailable');
  ok(/status date/i.test(m.getComputed().evm.reason), 'reason points at the missing status date');
  m.setStatusDate('2026-07-15');
  ok(m.getComputed().evm.available, 'baseline + status -> available');
})();

// ---- core numbers, hand-computed ----
(function () {
  var m = build();
  m.saveBaseline(); // BAC A=500, B=500
  // Status date Wed 7/15 = working index 2 (Mon=0,Tue=1,Wed=2). A spans idx 0..4.
  // A planned fraction = (2-0+1)/5 = 3/5 = 0.6 -> PV_A = 300. B starts idx 5 -> PV_B = 0.
  m.setStatusDate('2026-07-15');
  // Progress: A 40% done, B 0%.
  m.setField(m.getProject().tasks[1].id, 'percentComplete', 40); // task A is row1=tasks[0]? verify below
  // tasks[0] = A. Set A to 40%.
  m.setField(m.getProject().tasks[1].id, 'percentComplete', 0);  // reset noise
  m.setField(m.getProject().tasks[1].id, 'percentComplete', 0);
  m.setField(m.getProject().tasks[0].id, 'percentComplete', 40);

  var e = m.getComputed().evm;
  eq(e.bac, 1000, 'BAC = 1000');
  eq(e.pv, 300, 'PV = 300 (A 60% planned, B 0)');
  eq(e.ev, 200, 'EV = 500*0.40 = 200');
  // No actuals recorded -> AC = EV = 200 (neutral)
  eq(e.ac, 200, 'AC = EV when no actuals recorded');
  eq(e.sv, -100, 'SV = EV-PV = -100 (behind)');
  eq(e.cv, 0, 'CV = EV-AC = 0');
  approx(e.spi, 200 / 300, 'SPI = EV/PV = 0.667');
  approx(e.cpi, 1, 'CPI = 1 (neutral)');
})();

// ---- actual cost drives CPI + EAC ----
(function () {
  var m = build();
  m.saveBaseline();
  m.setStatusDate('2026-07-15'); // idx 2
  // A: 40% done, started Mon 7/13, still running -> actual elapsed idx 0..2 = 3 days
  // AC_A = 3 days * $100 = 300. EV_A = 200. CPI = 200/300 = 0.667 (over budget).
  m.setField(m.getProject().tasks[0].id, 'actualStart', '2026-07-13');
  m.setField(m.getProject().tasks[0].id, 'percentComplete', 40);
  var e = m.getComputed().evm;
  eq(e.ev, 200, 'EV = 200');
  eq(e.ac, 300, 'AC = 3 elapsed working days * $100');
  eq(e.cv, -100, 'CV = 200-300 = -100 (over budget)');
  approx(e.cpi, 200 / 300, 'CPI = 0.667');
  // EAC = BAC / CPI = 1000 / 0.667 = 1500
  approx(e.eac, 1500, 'EAC = BAC/CPI = 1500');
  eq(e.vac, 1000 - e.eac, 'VAC = BAC - EAC');
  ok(e.vac < 0, 'VAC negative (projected overrun)');
})();

// ---- completed task: EV = BAC, AC = actual span cost ----
(function () {
  var m = build();
  m.saveBaseline();
  // A actually ran Mon 7/13 -> next Mon 7/20 (idx 0..5 = 6 working days), 100%.
  m.setField(m.getProject().tasks[0].id, 'actualStart', '2026-07-13');
  m.setField(m.getProject().tasks[0].id, 'actualFinish', '2026-07-20');
  m.setStatusDate('2026-07-20');
  var e = m.getComputed().evm;
  ok(e.available, 'available');
  // A: EV = 500 (100%), AC = 6 days * 100 = 600
  var ta = e.tasks.filter(function (t) { return t.name === 'A'; })[0];
  eq(ta.ev, 500, 'A EV = full BAC when complete');
  eq(ta.ac, 600, 'A AC = 6 actual working days * $100');
  approx(ta.cpi, 500 / 600, 'A CPI = 0.833');
})();

// ---- old baseline without cost/duration degrades gracefully ----
(function () {
  var m = build();
  // hand-craft a legacy baseline (dates only, no cost/durationDays)
  var c = m.getComputed();
  m.getProject().baseline = {
    savedISO: '2026-07-01',
    tasks: c.rows.filter(function (r) { return !r.isSummary; }).map(function (r) {
      return { id: r.id, startDay: r.startDay, finishDay: r.finishDay };
    })
  };
  m.recompute();
  m.setStatusDate('2026-07-15');
  var e = m.getComputed().evm;
  ok(e.available, 'legacy baseline still yields EVM');
  eq(e.bac, 1000, 'BAC falls back to current cost when baseline lacks it');
})();

// ---- report + round-trip of baseline cost/duration ----
(function () {
  var m = build();
  m.saveBaseline();
  m.setStatusDate('2026-07-15');
  m.setField(m.getProject().tasks[0].id, 'percentComplete', 40);
  var rep = Ops.buildScheduleReport(m);
  ok(rep.project.evm, 'evm in report');
  eq(rep.project.evm.bac, 1000, 'report BAC');
  eq(rep.project.evm.pv, 300, 'report PV');
  approx(rep.project.evm.spi, 0.67, 'report SPI rounded');
  // baseline captured cost + duration
  var bl = m.getProject().baseline.tasks[0];
  ok(bl.cost != null && bl.durationDays != null, 'baseline captures cost + duration');
  var m2 = Model.createModel();
  m2.loadProject(m.toJSON());
  eq(m2.getComputed().evm.bac, 1000, 'EVM survives round-trip');
})();

console.log('\nEVM tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
