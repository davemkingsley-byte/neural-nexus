/* Tests for the one-page status report engine. node tests/report.test.js */
'use strict';
var Model = require('../js/model.js');
var Ops = require('../js/ops.js');
var Report = require('../js/report.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

// Deterministic plan: Mon 2026-07-13 start, one summary, milestone, risks,
// actuals, baseline, status date — every report section has data.
function plan() {
  var m = Model.createModel();
  m.newProject();
  m.setProjectName('Report Fixture');
  m.setProjectStart('2026-07-13');
  Ops.applyOps(m, [
    { op: 'add-task', name: 'Phase', duration: 1 },
    { op: 'add-task', name: 'Design', duration: 5, resources: 'Alice' },
    { op: 'add-task', name: 'Build', duration: 10, resources: 'Bob' },
    { op: 'add-task', name: 'Ship', duration: 0 },
    { op: 'add-task', name: 'Later', duration: 3 }
  ]);
  var t = m.getProject().tasks;
  m.indent([t[1].id, t[2].id, t[3].id]);
  m.setField(t[2].id, 'predecessors', String(t[1].id));         // Build after Design
  m.setField(t[3].id, 'predecessors', String(t[2].id));         // Ship after Build
  m.setField(t[4].id, 'predecessors', String(t[3].id));         // Later after Ship
  m.updateResource(m.getProject().resources[0].id, { rate: 800 });
  m.setField(t[1].id, 'percentComplete', 40);                   // Design behind
  return m;
}

// ---- project block + overall progress ----
(function () {
  var m = plan();
  var r = Report.build(m, { asOfISO: '2026-07-17' });
  eq(r.project.name, 'Report Fixture', 'project name');
  eq(r.project.startISO, '2026-07-13', 'start');
  eq(r.asOfISO, '2026-07-17', 'asOf pinned by opts');
  // Design 5d@40% + Build 10d@0% + Ship 0d(→1w)@0% + Later 3d@0% = 200/19
  eq(r.project.pctComplete, Math.round(200 / 19), 'duration-weighted % complete');
  eq(r.project.taskCount, 4, 'leaf count (summary excluded)');
  eq(r.project.milestoneCount, 1, 'milestone count');
  ok(r.project.cost > 0, 'cost present');
})();

// ---- milestones: chronology, done/late flags ----
(function () {
  var m = plan();
  // Ship finishes after Design(5)+Build(10) = 15 working days → 2026-07-31.
  var r1 = Report.build(m, { asOfISO: '2026-07-20' });
  eq(r1.milestones.length, 1, 'one milestone');
  eq(r1.milestones[0].name, 'Ship', 'milestone name');
  eq(r1.milestones[0].late, false, 'future milestone not late');
  var r2 = Report.build(m, { asOfISO: '2026-09-01' });
  eq(r2.milestones[0].late, true, 'past unfinished milestone is late');
  eq(r2.health.lateMilestones, 1, 'late milestone counted in health');
  var t = m.getProject().tasks;
  m.setField(t[3].id, 'percentComplete', 100);
  var r3 = Report.build(m, { asOfISO: '2026-09-01' });
  eq(r3.milestones[0].done, true, 'completed milestone done');
  eq(r3.milestones[0].late, false, 'completed milestone never late');
})();

// ---- critical + upcoming windows ----
(function () {
  var m = plan();
  var r = Report.build(m, { asOfISO: '2026-07-13' });
  // Chain Design→Build→Ship→Later is the only path: all leaves critical.
  eq(r.critical.count, 3, 'critical leaves (milestone excluded by duration>0)');
  ok(r.critical.tasks.every(function (t) { return t.durationDays > 0; }), 'critical list excludes milestones');
  // Upcoming within 14 calendar days of Jul 13: Build starts Jul 20 → included;
  // Later starts Aug 3 (after Ship Jul 31) → outside window.
  var names = r.upcoming.tasks.map(function (t) { return t.name; });
  ok(names.indexOf('Build') >= 0, 'Build upcoming');
  ok(names.indexOf('Later') < 0, 'Later outside 14-day window');
  ok(names.indexOf('Design') < 0, 'started task (40%) not upcoming');
})();

// ---- behind-schedule needs the model status date ----
(function () {
  var m = plan();
  m.setStatusDate('2026-07-17'); // end of Design's week: expected 100%, actual 40%
  var r = Report.build(m);
  eq(r.usingStatusDate, true, 'reports as-of the status date');
  eq(r.asOfISO, '2026-07-17', 'asOf = status date');
  eq(r.behind.count, 1, 'Design behind');
  eq(r.behind.tasks[0].name, 'Design', 'behind task named');
  eq(r.behind.tasks[0].expectedPct, 100, 'expected pct carried');
})();

// ---- risks: active only, sorted, capped, severity mapped ----
(function () {
  var m = plan();
  m.addRisk({ title: 'Vendor slip', probability: 5, impact: 5, status: 'open' });
  m.addRisk({ title: 'Scope creep', probability: 2, impact: 2, status: 'mitigating' });
  m.addRisk({ title: 'Closed one', probability: 5, impact: 5, status: 'closed' });
  var r = Report.build(m, { asOfISO: '2026-07-13' });
  eq(r.risks.activeCount, 2, 'closed risk excluded');
  eq(r.risks.top[0].title, 'Vendor slip', 'sorted by exposure');
  eq(r.risks.top[0].severity, 'critical', '25 -> critical');
  eq(r.risks.top[1].severity, 'low', '4 -> low');
  eq(r.health.openRisks, 2, 'health open risks');
  ok(r.health.riskExposure >= 29, 'exposure summed');
})();

// ---- EVM passthrough + baseline finish variance ----
(function () {
  var m = plan();
  var r0 = Report.build(m, { asOfISO: '2026-07-17' });
  eq(r0.evm.available, false, 'EVM unavailable without baseline+status');
  ok(r0.evm.reason.length > 0, 'reason given');
  eq(r0.project.baselineFinishISO, null, 'no baseline finish');

  m.saveBaseline();
  m.setStatusDate('2026-07-17');
  var r1 = Report.build(m);
  eq(r1.evm.available, true, 'EVM available');
  ok(r1.evm.bac > 0, 'BAC present');
  ok(r1.health.spi != null, 'SPI surfaced in health');
  eq(r1.project.baselineFinishISO, r1.project.finishISO, 'baseline = current right after save');
  eq(r1.project.finishVarianceDays, 0, 'no slip yet');

  // Slip the schedule: Design 5 → 10 days pushes everything a week+.
  var t = m.getProject().tasks;
  m.setField(t[1].id, 'duration', 10);
  var r2 = Report.build(m);
  ok(r2.project.finishVarianceDays > 0, 'slip is positive after extending work');
})();

// ---- resource summary comes from the usage engine ----
(function () {
  var m = plan();
  var r = Report.build(m, { asOfISO: '2026-07-13' });
  var names = r.resources.map(function (x) { return x.name; });
  ok(names.indexOf('Alice') >= 0 && names.indexOf('Bob') >= 0, 'both resources listed');
  ok(names.indexOf('(Unassigned)') >= 0, 'unassigned work listed (Later)');
  var alice = r.resources.filter(function (x) { return x.name === 'Alice'; })[0];
  eq(alice.totalHours, 40, 'Alice 5d*8h');
  eq(alice.totalCost, 4000, 'Alice 5d*800');
})();

// ---- empty project doesn't crash ----
(function () {
  var m = Model.createModel();
  m.newProject();
  var r = Report.build(m, { asOfISO: '2026-07-13' });
  eq(r.project.taskCount, 0, 'no tasks');
  eq(r.project.pctComplete, 0, 'no progress');
  eq(r.milestones.length, 0, 'no milestones');
  eq(r.risks.activeCount, 0, 'no risks');
  eq(r.resources.length, 0, 'no resources');
})();

console.log('\nReport tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
