/* Tests for the risk management system. node tests/risks.test.js */
'use strict';
var Model = require('../js/model.js');
var Ops = require('../js/ops.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

function base() {
  var m = Model.createModel();
  m.newProject();
  Ops.applyOps(m, [
    { op: 'add-task', name: 'Build', duration: 10 },
    { op: 'add-task', name: 'Test', duration: 5, predecessors: '1' }
  ]);
  return m;
}

// ---- severity bands ----
eq(Model.riskSeverity(1), 'low', 'score 1 low');
eq(Model.riskSeverity(4), 'low', 'score 4 low');
eq(Model.riskSeverity(5), 'medium', 'score 5 medium');
eq(Model.riskSeverity(9), 'medium', 'score 9 medium');
eq(Model.riskSeverity(10), 'high', 'score 10 high');
eq(Model.riskSeverity(14), 'high', 'score 14 high');
eq(Model.riskSeverity(15), 'critical', 'score 15 critical');
eq(Model.riskSeverity(25), 'critical', 'score 25 critical');

// ---- model CRUD + clamping + roll-ups ----
(function () {
  var m = base();
  var id = m.addRisk({ title: 'Vendor slips', probability: 9, impact: -2, category: 'nonsense', taskIds: [1, 1, 99] });
  var r = m.riskById(id);
  eq(r.probability, 5, 'probability clamped to 5');
  eq(r.impact, 1, 'impact clamped to 1');
  eq(r.category, 'other', 'invalid category -> other');
  eq(r.taskIds, [1], 'task links deduped + nonexistent dropped');
  ok(r.createdISO, 'created date stamped');

  m.updateRisk(id, { probability: 4, impact: 4, status: 'mitigating' });
  var c = m.getComputed();
  eq(c.riskSummary.mitigating, 1, 'summary counts mitigating');
  eq(c.riskSummary.exposure, 16, 'exposure = P*I of active risks');
  eq(c.rows[0].riskScore, 16, 'linked task carries max risk score');
  eq(c.rows[1].riskScore, 0, 'unlinked task carries none');

  m.updateRisk(id, { status: 'closed' });
  var r2 = m.riskById(id);
  ok(r2.closedISO, 'closing stamps closedISO');
  var c2 = m.getComputed();
  eq(c2.riskSummary.exposure, 0, 'closed risks drop out of exposure');
  eq(c2.rows[0].riskScore, 0, 'closed risks drop off tasks');

  m.updateRisk(id, { status: 'open' });
  ok(m.riskById(id).closedISO === null, 'reopening clears closedISO');

  // undo restores
  m.deleteRisk(id);
  eq(m.getProject().risks.length, 0, 'risk deleted');
  m.undo();
  eq(m.getProject().risks.length, 1, 'undo restores the risk');
})();

// ---- deleting a linked task strips the link ----
(function () {
  var m = base();
  var id = m.addRisk({ title: 'R', probability: 5, impact: 5, taskIds: [1, 2] });
  m.deleteTasks([1]);
  eq(m.riskById(id).taskIds, [2], 'deleted task removed from risk links');
})();

// ---- risks survive save/load + normalization ----
(function () {
  var m = base();
  m.addRisk({ title: 'Persist me', probability: 4, impact: 5, owner: 'Alex', mitigation: 'Plan B' });
  var m2 = Model.createModel();
  m2.loadProject(m.toJSON());
  var r = m2.getProject().risks[0];
  eq(r.title, 'Persist me', 'risk round-trips');
  eq(r.owner, 'Alex', 'owner round-trips');
  eq(m2.getComputed().riskSummary.exposure, 20, 'exposure recomputed after load');
})();

// ---- ops layer ----
(function () {
  var m = base();
  var r = Ops.applyOps(m, [
    { op: 'add-risk', title: 'API breaks', category: 'technical', probability: 4, impact: 5, owner: 'Dev', tasks: [1], mitigation: 'contract tests' },
    { op: 'add-risk', title: 'Key hire leaves', category: 'resource', probability: 2, impact: 4 },
    { op: 'set-risk', risk: 'Key hire leaves', probability: 3 },
    { op: 'link-risk', risk: 2, tasks: [2] }
  ]);
  ok(r.ok, 'risk ops batch applied: ' + (r.error || ''));
  eq(r.results[0].riskId, 1, 'first risk id 1');

  var rep = Ops.buildScheduleReport(m);
  eq(rep.risks.length, 2, 'report lists risks');
  eq(rep.risks[0].score, 20, 'score in report');
  eq(rep.risks[0].taskRows, [1], 'taskRows resolved to display rows');
  eq(rep.project.risks.open, 2, 'project summary open count');
  eq(rep.project.risks.exposure, 32, 'project exposure 20+12');
  eq(rep.tasks[0].riskScore, 20, 'task riskScore in report');
  eq(rep.tasks[1].riskIds, [2], 'task riskIds in report');

  // unlink + delete
  var r2 = Ops.applyOps(m, [
    { op: 'unlink-risk', risk: 2, tasks: [2] },
    { op: 'delete-risk', risk: 'API breaks' }
  ]);
  ok(r2.ok, 'unlink+delete ok');
  eq(m.getProject().risks.length, 1, 'one risk left');
  eq(m.getProject().risks[0].taskIds, [], 'unlinked');

  // errors
  var r3 = Ops.applyOps(m, [{ op: 'set-risk', risk: 99, probability: 1 }]);
  ok(!r3.ok && /no risk/.test(r3.error), 'unknown risk ref rejected');
  var r4 = Ops.applyOps(m, [{ op: 'add-risk' }]);
  ok(!r4.ok && /title/.test(r4.error), 'add-risk without title rejected');
})();

// ---- REVIEW FIX: explicit 0 clamps to 1, not inflated to 3 ----
(function () {
  var m = base();
  var id = m.addRisk({ title: 'Zero test', probability: 0, impact: 0 });
  var r = m.riskById(id);
  eq(r.probability, 1, 'probability 0 -> clamped to 1 (not 3)');
  eq(r.impact, 1, 'impact 0 -> clamped to 1 (not 3)');
  // a genuinely absent value still defaults to 3
  var id2 = m.addRisk({ title: 'Default test' });
  eq(m.riskById(id2).probability, 3, 'absent probability defaults to 3');
})();

// ---- REVIEW FIX: numeric title is addressable and never shadowed by an id ----
(function () {
  var m = base();
  var r = Ops.applyOps(m, [
    { op: 'add-risk', title: 'First risk' },   // id 1
    { op: 'add-risk', title: '1' }             // id 2, title "1"
  ]);
  ok(r.ok, 'setup ok');
  // ref "1" resolves to id 1 (id wins when it exists)
  Ops.applyOps(m, [{ op: 'set-risk', risk: '1', owner: 'by-id' }]);
  eq(m.riskById(1).owner, 'by-id', 'numeric ref hits the matching id first');
  // delete id 1, then ref "1" falls through to the title match (risk id 2)
  Ops.applyOps(m, [{ op: 'delete-risk', risk: 1 }]);
  var r2 = Ops.applyOps(m, [{ op: 'set-risk', risk: '1', owner: 'by-title' }]);
  ok(r2.ok, 'numeric title addressable after the id is gone');
  eq(m.riskById(2).owner, 'by-title', 'ref "1" fell through to the title-"1" risk');
})();

// ---- ambiguous title refs error with candidate ids ----
(function () {
  var m = base();
  Ops.applyOps(m, [
    { op: 'add-risk', title: 'Slip' },
    { op: 'add-risk', title: 'Slip' }
  ]);
  var r = Ops.applyOps(m, [{ op: 'set-risk', risk: 'Slip', impact: 5 }]);
  ok(!r.ok && /ambiguous/.test(r.error), 'ambiguous risk title rejected: ' + r.error);
})();

console.log('\nRisk tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
