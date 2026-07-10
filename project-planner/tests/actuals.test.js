/* Tests for actuals + status date + behind-schedule. node tests/actuals.test.js */
'use strict';
var Model = require('../js/model.js');
var Ops = require('../js/ops.js');
var Cal = require('../js/calendar.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

// Fixed-start project so date math is deterministic. 2026-07-13 = Monday.
function base() {
  var m = Model.createModel();
  m.newProject();
  m.setProjectStart('2026-07-13');
  Ops.applyOps(m, [
    { op: 'add-task', name: 'A', duration: 5 },
    { op: 'add-task', name: 'B', duration: 5, predecessors: '1' }
  ]);
  return m;
}

// ---- actual start pins the schedule over dependencies ----
(function () {
  var m = base();
  var c0 = m.getComputed();
  eq(c0.rows[1].es, 5, 'B scheduled after A');
  // B actually started early, on Wed 7/15 (idx 2), overlapping A
  m.setField(m.getProject().tasks[1].id, 'actualStart', '2026-07-15');
  var c = m.getComputed();
  eq(c.rows[1].es, 2, 'actual start pins B at idx 2 despite pred');
  ok(!c.rows[1].constraintViolated, 'reality is not flagged as a constraint conflict');
  eq(c.constraintConflicts, 0, 'no conflict counted');
})();

// ---- actual finish: fixes span + forces 100% ----
(function () {
  var m = base();
  var t = m.getProject().tasks[0];
  m.setField(t.id, 'actualStart', '2026-07-13');
  m.setField(t.id, 'actualFinish', '2026-07-21'); // Mon..next Tue = 7 working days (5 planned)
  var c = m.getComputed();
  eq(c.rows[0].durationDays, 7, 'effective duration = actual span (took longer than planned)');
  eq(Cal.toISO(c.rows[0].finishDay), '2026-07-21', 'finish shown at actual finish');
  eq(m.getProject().tasks[0].percentComplete, 100, 'actual finish forces 100%');
  // successor moves out too
  eq(c.rows[1].es, 7, 'successor starts after the ACTUAL finish');
})();

// ---- actual finish without a start adopts the scheduled start ----
(function () {
  var m = base();
  var t = m.getProject().tasks[0];
  m.setField(t.id, 'actualFinish', '2026-07-17');
  eq(m.getProject().tasks[0].actualStartISO, '2026-07-13', 'scheduled start adopted as actual start');
})();

// ---- invalid actuals rejected ----
(function () {
  var m = base();
  var t = m.getProject().tasks[0];
  m.setField(t.id, 'actualStart', '2026-07-15');
  m.setField(t.id, 'actualFinish', '2026-07-13'); // before start -> rejected
  eq(m.getProject().tasks[0].actualFinishISO, null, 'finish before start rejected');
  m.setField(t.id, 'actualFinish', '2026-07-20');
  m.setField(t.id, 'actualStart', '2026-07-22'); // start after finish -> rejected
  eq(m.getProject().tasks[0].actualStartISO, '2026-07-15', 'start after finish rejected');
  // clearing start clears finish too
  m.setField(t.id, 'actualStart', '');
  eq(m.getProject().tasks[0].actualStartISO, null, 'start cleared');
  eq(m.getProject().tasks[0].actualFinishISO, null, 'finish cleared with start');
})();

// ---- status date: expected progress + behind flags ----
(function () {
  var m = base();
  // A: 5d from Mon 7/13. Status date Wed 7/15 (idx 2) -> 3 of 5 days elapsed = 60%
  m.setStatusDate('2026-07-15');
  var c = m.getComputed();
  eq(c.rows[0].expectedPct, 60, 'A expected 60% by Wed');
  ok(c.rows[0].behindSchedule, 'A at 0% is behind');
  eq(c.rows[1].expectedPct, 0, 'B (not started yet) expected 0%');
  ok(!c.rows[1].behindSchedule, 'B not behind');
  eq(c.behindCount, 1, 'one task behind');
  ok(c.statusDay === Cal.parseISO('2026-07-15'), 'statusDay exposed for the gantt line');

  // catch A up to 60% -> no longer behind
  m.setField(m.getProject().tasks[0].id, 'percentComplete', 60);
  var c2 = m.getComputed();
  ok(!c2.rows[0].behindSchedule, 'A at 60% is on schedule');
  eq(c2.behindCount, 0, 'nothing behind');

  // clearing the status date clears all flags
  m.setStatusDate(null);
  var c3 = m.getComputed();
  eq(c3.rows[0].expectedPct, null, 'no status date -> no expected pct');
  eq(c3.behindCount, 0, 'no status date -> no behind count');
})();

// ---- milestones: late only when strictly past due ----
(function () {
  var m = Model.createModel();
  m.newProject();
  m.setProjectStart('2026-07-13');
  Ops.applyOps(m, [
    { op: 'add-task', name: 'Work', duration: 3 },
    { op: 'add-task', name: 'Gate', duration: 0, predecessors: '1' } // due at idx 3 (Thu)
  ]);
  m.setStatusDate('2026-07-16'); // Thu = idx 3: due today, not yet late
  var c = m.getComputed();
  eq(c.rows[1].expectedPct, 0, 'milestone due on the status date is not yet expected');
  m.setStatusDate('2026-07-17'); // Fri = idx 4: now overdue
  var c2 = m.getComputed();
  eq(c2.rows[1].expectedPct, 100, 'overdue milestone expected complete');
  ok(c2.rows[1].behindSchedule, 'unfinished overdue milestone is behind');
})();

// ---- ops + report + round-trip ----
(function () {
  var m = base();
  var r = Ops.applyOps(m, [
    { op: 'set', row: 1, field: 'actualstart', value: '2026-07-14' },
    { op: 'set-project', status: '2026-07-16' }
  ]);
  ok(r.ok, 'ops apply: ' + (r.error || ''));
  var rep = Ops.buildScheduleReport(m);
  eq(rep.tasks[0].actualStartISO, '2026-07-14', 'actual start in report');
  eq(rep.project.statusISO, '2026-07-16', 'status date in report');
  ok(rep.tasks[0].behindSchedule, 'behind flag in report');
  ok(rep.project.behindSchedule >= 1, 'project behind count in report');

  var m2 = Model.createModel();
  m2.loadProject(m.toJSON());
  eq(m2.getProject().tasks[0].actualStartISO, '2026-07-14', 'actuals round-trip');
  eq(m2.getProject().statusISO, '2026-07-16', 'status date round-trips');

  // clearing via ops
  Ops.applyOps(m, [{ op: 'set-project', status: null }]);
  eq(m.getProject().statusISO, null, 'ops clears status date');
})();

// ---- CSV carries actuals ----
(function () {
  var m = base();
  m.setField(m.getProject().tasks[0].id, 'actualStart', '2026-07-13');
  var csv = m.toCSV();
  ok(csv.indexOf('Actual Start') > 0, 'CSV header has actuals');
  ok(csv.indexOf('2026-07-13') > 0, 'CSV row has the actual date');
})();


// ---- REVIEW FIX: rejected actualFinish leaves NO phantom actual start ----
(function () {
  var m = base();
  var t = m.getProject().tasks[1].id; // B, scheduled after A
  var before = m.getComputed().rows[1].es;
  // actualFinish earlier than B's scheduled start -> rejected, must not pin B
  m.setField(t, 'actualFinish', '2026-07-13');
  eq(m.getProject().tasks[1].actualStartISO, null, 'rejected finish leaves no phantom actual start');
  eq(m.getProject().tasks[1].actualFinishISO, null, 'no actual finish recorded');
  eq(m.getComputed().rows[1].es, before, 'B still scheduled by its predecessor (not pinned)');
})();

// ---- REVIEW FIX: status date before project start -> no fabricated progress ----
(function () {
  var m = base();
  m.setStatusDate('2026-07-01'); // before the 2026-07-13 project start
  var c = m.getComputed();
  eq(c.rows[0].expectedPct, null, 'no expected progress before project start');
  eq(c.rows[0].behindSchedule, false, 'not behind before the project began');
  eq(c.behindCount, 0, 'no behind count for a pre-start status date');
})();

console.log('\nActuals tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
