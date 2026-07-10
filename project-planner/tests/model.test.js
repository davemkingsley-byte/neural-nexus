/* Node tests for the model layer. Run: node tests/model.test.js */
'use strict';
var Model = require('../js/model.js');
var Cal = require('../js/calendar.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) {
  if (JSON.stringify(a) === JSON.stringify(e)) passed++;
  else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); }
}
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

// ---- Duration parsing ----
eq(Model.parseDuration('5'), 5, 'dur 5');
eq(Model.parseDuration('5d'), 5, 'dur 5d');
eq(Model.parseDuration('2w'), 10, 'dur 2w');
eq(Model.parseDuration('1mo'), 20, 'dur 1mo');
eq(Model.parseDuration('0'), 0, 'dur 0 milestone');
eq(Model.parseDuration('bad'), null, 'dur invalid -> null');

// ---- Sample project schedules without cycles ----
var m = Model.createModel();
m.loadSample();
var c = m.getComputed();
ok(!c.hasCycle, 'sample has no cycle');
ok(c.rows.length === 14, 'sample has 14 rows');

// The summary "Product Launch" (row 1) should span the whole project.
var root = c.rows[0];
ok(root.isSummary, 'row1 is summary');
eq(root.startDay, c.projectStartDay, 'root summary start == project start');
eq(root.finishDay, c.projectEndDay, 'root summary finish == project end');

// "Approve scope" (row 5) is a milestone.
ok(c.rows[4].isMilestone, 'row5 is milestone');

// Progress rolls up: Planning summary (row2) %complete between 0 and 100.
var planning = c.rows[1];
ok(planning.percentComplete >= 0 && planning.percentComplete <= 100, 'planning pct in range');

// There is a critical path (at least the final milestone is critical).
ok(c.rows.some(function (r) { return r.critical; }), 'some tasks critical');

// ---- Predecessor round-trip ----
var m2 = Model.createModel();
m2.newProject();
m2.addTaskEnd(); // row1
m2.addTaskEnd(); // row2
m2.addTaskEnd(); // row3
var p2 = m2.getProject();
m2.setField(p2.tasks[0].id, 'duration', '3');
m2.setField(p2.tasks[1].id, 'duration', '2');
m2.setField(p2.tasks[2].id, 'duration', '4');
m2.setField(p2.tasks[2].id, 'predecessors', '1FS+1, 2');
var preds = m2.getProject().tasks[2].predecessors;
eq(preds.length, 2, 'two predecessors parsed');
eq(preds[0].type, 'FS', 'pred1 type FS');
eq(preds[0].lag, 1, 'pred1 lag 1');
// format back to string using row numbers
eq(m2.formatPredecessors(preds), '1FS+1, 2', 'predecessors round-trip format');

// Task 3 should start after task 1 finishes + 1 lag OR after task 2, whichever later.
var c2 = m2.getComputed();
var r3 = c2.rows[2];
// task1 dur3 finishes idx3 (ef), +1 lag => es 4 ; task2 dur2 es0 ef2 => FS es2 ; max => 4
eq(r3.es, 4, 'row3 es respects FS+1 from row1');

// ---- Indent / outdent creates summary ----
var m3 = Model.createModel();
m3.newProject();
m3.addTaskEnd();
m3.addTaskEnd();
var p3 = m3.getProject();
m3.setField(p3.tasks[0].id, 'name', 'Parent');
m3.setField(p3.tasks[1].id, 'name', 'Child');
m3.indent([p3.tasks[1].id]);
var c3 = m3.getComputed();
ok(c3.rows[0].isSummary, 'after indent, row1 is summary');
eq(c3.rows[1].outlineLevel, 2, 'child outline level 2');
m3.outdent([m3.getProject().tasks[1].id]);
ok(!m3.getComputed().rows[0].isSummary, 'after outdent, row1 no longer summary');

// ---- Move block keeps subtree together ----
var m4 = Model.createModel();
m4.newProject();
for (var i = 0; i < 4; i++) m4.addTaskEnd();
var p4 = m4.getProject();
m4.setField(p4.tasks[0].id, 'name', 'A');
m4.setField(p4.tasks[1].id, 'name', 'B');
m4.setField(p4.tasks[2].id, 'name', 'B-child');
m4.setField(p4.tasks[3].id, 'name', 'C');
m4.indent([p4.tasks[2].id]); // B-child under B
// order: A, B, B-child, C. Move B down -> A, C, B, B-child
var bId = m4.getProject().tasks.filter(function (t) { return t.name === 'B'; })[0].id;
m4.moveBlock(bId, +1);
var names = m4.getProject().tasks.map(function (t) { return t.name; });
eq(names, ['A', 'C', 'B', 'B-child'], 'move down keeps B subtree intact');

// ---- Undo restores state ----
m4.undo();
var names2 = m4.getProject().tasks.map(function (t) { return t.name; });
eq(names2, ['A', 'B', 'B-child', 'C'], 'undo restores order');

// ---- Cycle is reported, not crashing ----
var m5 = Model.createModel();
m5.newProject();
m5.addTaskEnd(); m5.addTaskEnd();
var p5 = m5.getProject();
m5.setField(p5.tasks[0].id, 'predecessors', '2');
m5.setField(p5.tasks[1].id, 'predecessors', '1');
ok(m5.getComputed().hasCycle, 'model surfaces cycle');

console.log('\nModel tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
