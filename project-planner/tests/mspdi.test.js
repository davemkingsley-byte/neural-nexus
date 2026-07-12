/* Tests for MSPDI (Microsoft Project XML) export. node tests/mspdi.test.js */
'use strict';
var Model = require('../js/model.js');
var Ops = require('../js/ops.js');
var Mspdi = require('../js/mspdi.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }
function has(xml, s, msg) { ok(xml.indexOf(s) >= 0, msg + ' (missing: ' + s + ')'); }

// Minimal well-formedness: balanced tags for the elements we emit.
function balanced(xml, tag) {
  var open = (xml.match(new RegExp('<' + tag + '>', 'g')) || []).length;
  var close = (xml.match(new RegExp('</' + tag + '>', 'g')) || []).length;
  return open === close;
}

// ---- structure + header ----
(function () {
  var m = Model.createModel();
  m.loadSample();
  var xml = Mspdi.toXml(m);
  has(xml, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', 'xml prolog');
  has(xml, '<Project xmlns="http://schemas.microsoft.com/project">', 'Project namespace');
  has(xml, '</Project>', 'Project closed');
  ['Tasks', 'Task', 'Resources', 'Resource', 'Assignments', 'Calendars', 'Calendar', 'WeekDays', 'WeekDay']
    .forEach(function (t) { ok(balanced(xml, t), t + ' tags balanced'); });
  // Project has an xmlns attribute on the open tag — check it opens once + closes once.
  eq((xml.match(/<Project[ >]/g) || []).length, 1, 'one Project open tag');
  eq((xml.match(/<\/Project>/g) || []).length, 1, 'one Project close tag');
  has(xml, '<CalendarUID>1</CalendarUID>', 'references the standard calendar');
  // 14 sample tasks -> 14 <Task>
  eq((xml.match(/<Task>/g) || []).length, 14, '14 tasks emitted');
})();

// ---- task fields + dependency type mapping ----
(function () {
  var m = Model.createModel();
  m.newProject();
  m.setProjectStart('2026-07-13'); // Monday
  Ops.applyOps(m, [
    { op: 'add-task', name: 'Build & <ship>', duration: 5, resources: 'Dev' },
    { op: 'add-task', name: 'Test', duration: 3 },
    { op: 'add-task', name: 'Gate', duration: 0 }
  ]);
  // Test depends on Build via SS+2; Gate depends on Test via FS
  m.setField(m.getProject().tasks[1].id, 'predecessors', '1SS+2');
  m.setField(m.getProject().tasks[2].id, 'predecessors', '2');
  var res = m.getProject().resources[0];
  m.updateResource(res.id, { rate: 640 });
  var xml = Mspdi.toXml(m);

  has(xml, '<Name>Build &amp; &lt;ship&gt;</Name>', 'task name XML-escaped');
  has(xml, '<Duration>PT40H0M0S</Duration>', '5 days -> PT40H (8h/day)');
  has(xml, '<Milestone>1</Milestone>', 'milestone flagged');
  has(xml, '<DurationFormat>7</DurationFormat>', 'duration format = days');

  // SS link -> Type 3, lag 2 days -> 2*4800 = 9600 tenths-of-minute
  has(xml, '<PredecessorLink><PredecessorUID>' + m.getProject().tasks[0].id + '</PredecessorUID><Type>3</Type><LinkLag>9600</LinkLag><LagFormat>7</LagFormat></PredecessorLink>', 'SS+2 link encoded');
  // FS link -> Type 1, lag 0
  has(xml, '<Type>1</Type><LinkLag>0</LinkLag>', 'FS link encoded');

  // resource rate carried
  has(xml, '<StandardRate>640</StandardRate>', 'resource rate exported');
  // assignment present for the resourced task
  has(xml, '<Assignment><UID>1</UID><TaskUID>' + m.getProject().tasks[0].id + '</TaskUID><ResourceUID>' + res.id + '</ResourceUID><Units>1</Units></Assignment>', 'assignment exported');
})();

// ---- calendar: working days + holiday exception ----
(function () {
  var m = Model.createModel();
  m.newProject();
  m.setWorkingDays([1, 2, 3, 4]); // Mon-Thu only
  m.setHolidays(['2026-12-25']);
  var xml = Mspdi.toXml(m);
  // Sunday (DayType 1) non-working
  has(xml, '<WeekDay><DayType>1</DayType><DayWorking>0</DayWorking></WeekDay>', 'Sunday non-working');
  // Monday (DayType 2) working with working times
  has(xml, '<WeekDay><DayType>2</DayType><DayWorking>1</DayWorking><WorkingTimes>', 'Monday working');
  // Friday (DayType 6) non-working (we set Mon-Thu)
  has(xml, '<WeekDay><DayType>6</DayType><DayWorking>0</DayWorking></WeekDay>', 'Friday non-working per calendar');
  // holiday exception
  has(xml, '<TimePeriod><FromDate>2026-12-25T00:00:00</FromDate><ToDate>2026-12-25T23:59:00</ToDate></TimePeriod>', 'holiday exception day');
})();

// ---- constraints + actuals ----
(function () {
  var m = Model.createModel();
  m.newProject();
  m.setProjectStart('2026-07-13');
  Ops.applyOps(m, [{ op: 'add-task', name: 'A', duration: 5 }]);
  var id = m.getProject().tasks[0].id;
  m.setConstraint(id, 'MSO', '2026-07-20');
  m.setField(id, 'deadline', '2026-07-24');
  m.setField(id, 'actualStart', '2026-07-20');
  var xml = Mspdi.toXml(m);
  has(xml, '<ConstraintType>2</ConstraintType><ConstraintDate>2026-07-20T08:00:00</ConstraintDate>', 'MSO -> constraint type 2');
  has(xml, '<Deadline>2026-07-24T17:00:00</Deadline>', 'deadline exported');
  has(xml, '<ActualStart>2026-07-20T08:00:00</ActualStart>', 'actual start exported');
  // SNET maps to type 4
  m.setConstraint(id, 'SNET', '2026-07-15');
  ok(Mspdi.toXml(m).indexOf('<ConstraintType>4</ConstraintType>') >= 0, 'SNET -> constraint type 4');
})();

// ---- empty project doesn't crash ----
(function () {
  var m = Model.createModel();
  m.newProject();
  var xml = Mspdi.toXml(m);
  has(xml, '<Tasks></Tasks>', 'empty tasks element');
  eq((xml.match(/<\/Project>/g) || []).length, 1, 'empty project closes once');
})();

console.log('\nMSPDI tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
