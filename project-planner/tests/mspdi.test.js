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

// ==========================================================================
// Import: fromXml
// ==========================================================================

// ---- round-trip: export a real plan, re-import, compare the schedule ----
(function () {
  var m = Model.createModel();
  m.newProject();
  m.setProjectStart('2026-07-13'); // Monday
  m.setWorkingDays([1, 2, 3, 4, 5]);
  m.setHolidays(['2026-08-03']);
  Ops.applyOps(m, [
    { op: 'add-task', name: 'Design', duration: 5, resources: 'Alice' },
    { op: 'add-task', name: 'Phase', duration: 0 },       // becomes summary
    { op: 'add-task', name: 'Build', duration: 8, resources: 'Bob' },
    { op: 'add-task', name: 'Test', duration: 4 },
    { op: 'add-task', name: 'Launch', duration: 0 }        // milestone
  ]);
  var t = m.getProject().tasks;
  m.indent([t[2].id, t[3].id]);                            // Build, Test under Phase
  m.setField(t[2].id, 'predecessors', String(t[0].id));    // Build FS Design
  m.setField(t[3].id, 'predecessors', String(t[2].id) + 'SS+1'); // Test SS+1 Build
  m.setField(t[4].id, 'predecessors', String(t[3].id));    // Launch FS Test
  m.setField(t[0].id, 'deadline', '2026-07-24');
  m.updateResource(m.getProject().resources[0].id, { rate: 700 });

  var xml = Mspdi.toXml(m);
  var doc = Mspdi.fromXml(xml);

  // Load the imported doc through a fresh model and compare computed schedule.
  var m2 = Model.createModel();
  m2.loadProject(doc);

  var r1 = m.getComputed().rows, r2 = m2.getComputed().rows;
  eq(r2.length, r1.length, 'round-trip: same row count');

  var names1 = r1.map(function (r) { return r.task.name; });
  var names2 = r2.map(function (r) { return r.task.name; });
  eq(names2, names1, 'round-trip: task names + order preserved');

  var lvl1 = r1.map(function (r) { return r.outlineLevel; });
  var lvl2 = r2.map(function (r) { return r.outlineLevel; });
  eq(lvl2, lvl1, 'round-trip: hierarchy (outline levels) preserved');

  var starts1 = r1.map(function (r) { return r.startDay; });
  var starts2 = r2.map(function (r) { return r.startDay; });
  var finishes1 = r1.map(function (r) { return r.finishDay; });
  var finishes2 = r2.map(function (r) { return r.finishDay; });
  eq(starts2, starts1, 'round-trip: start days match (deps + calendar reproduced)');
  eq(finishes2, finishes1, 'round-trip: finish days match');

  ok(r2.some(function (r) { return r.isSummary; }), 'round-trip: summary row present');
  ok(r2.some(function (r) { return r.isMilestone; }), 'round-trip: milestone present');

  // resource + rate + assignment carried
  eq(m2.getProject().resources.length, 2, 'round-trip: both resources imported');
  var alice2 = m2.getProject().resources.filter(function (x) { return x.name === 'Alice'; })[0];
  eq(alice2.rate, 700, 'round-trip: rate carried');
  var build2 = m2.getProject().tasks.filter(function (x) { return x.name === 'Build'; })[0];
  eq(build2.resourceIds.length, 1, 'round-trip: assignment carried');

  // deadline + holiday carried
  var design2 = m2.getProject().tasks.filter(function (x) { return x.name === 'Design'; })[0];
  eq(design2.deadlineISO, '2026-07-24', 'round-trip: deadline carried');
  eq(m2.getProject().calendar.holidays, ['2026-08-03'], 'round-trip: holiday carried');
})();

// ---- import: dependency type + lag decoding ----
(function () {
  var xml = '<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project">' +
    '<Tasks>' +
    '<Task><UID>1</UID><Name>A</Name><OutlineLevel>1</OutlineLevel><Duration>PT40H0M0S</Duration></Task>' +
    '<Task><UID>2</UID><Name>B</Name><OutlineLevel>1</OutlineLevel><Duration>PT24H0M0S</Duration>' +
    '<PredecessorLink><PredecessorUID>1</PredecessorUID><Type>3</Type><LinkLag>9600</LinkLag></PredecessorLink></Task>' +
    '</Tasks></Project>';
  var doc = Mspdi.fromXml(xml);
  eq(doc.tasks.length, 2, 'two tasks imported');
  eq(doc.tasks[0].duration, 5, 'PT40H -> 5 days');
  eq(doc.tasks[1].duration, 3, 'PT24H -> 3 days');
  eq(doc.tasks[1].predecessors[0], { id: 1, type: 'SS', lag: 2 }, 'Type 3 + 9600 tenths -> SS+2');
})();

// ---- import: constraints, actuals, %complete, notes, entities ----
(function () {
  var xml = '<Project xmlns="http://schemas.microsoft.com/project"><Title>Ac &amp; Me</Title>' +
    '<Tasks><Task><UID>5</UID><Name>Fix &lt;bug&gt;</Name><OutlineLevel>1</OutlineLevel>' +
    '<Duration>PT16H0M0S</Duration><PercentComplete>50</PercentComplete>' +
    '<ConstraintType>2</ConstraintType><ConstraintDate>2026-07-20T08:00:00</ConstraintDate>' +
    '<ActualStart>2026-07-20T08:00:00</ActualStart>' +
    '<Notes>ship it</Notes></Task></Tasks></Project>';
  var doc = Mspdi.fromXml(xml);
  eq(doc.name, 'Ac & Me', 'title entity-decoded');
  var t = doc.tasks[0];
  eq(t.name, 'Fix <bug>', 'name entity-decoded');
  eq(t.percentComplete, 50, 'percent complete imported');
  eq(t.constraintType, 'MSO', 'ConstraintType 2 -> MSO');
  eq(t.constraintISO, '2026-07-20', 'constraint date imported');
  eq(t.actualStartISO, '2026-07-20', 'actual start imported');
  eq(t.notes, 'ship it', 'notes imported');
})();

// ---- import: skips project-summary (UID 0 / OutlineLevel 0), drops dangling preds ----
(function () {
  var xml = '<Project xmlns="http://schemas.microsoft.com/project"><Tasks>' +
    '<Task><UID>0</UID><Name>Summary</Name><OutlineLevel>0</OutlineLevel></Task>' +
    '<Task><UID>1</UID><Name>Real</Name><OutlineLevel>1</OutlineLevel><Duration>PT8H0M0S</Duration>' +
    '<PredecessorLink><PredecessorUID>0</PredecessorUID><Type>1</Type></PredecessorLink>' +
    '<PredecessorLink><PredecessorUID>99</PredecessorUID><Type>1</Type></PredecessorLink></Task>' +
    '</Tasks></Project>';
  var doc = Mspdi.fromXml(xml);
  eq(doc.tasks.length, 1, 'project-summary task skipped');
  eq(doc.tasks[0].name, 'Real', 'real task kept');
  eq(doc.tasks[0].predecessors.length, 0, 'dangling preds (to summary + missing) dropped');
})();

// ---- import: self-closing tags + CDATA + missing duration falls back ----
(function () {
  var xml = '<Project xmlns="http://schemas.microsoft.com/project"><Tasks>' +
    '<Task><UID>1</UID><Name><![CDATA[R & D <plan>]]></Name><OutlineLevel>1</OutlineLevel>' +
    '<Milestone>1</Milestone><Active/></Task>' +
    '<Task><UID>2</UID><Name>No duration</Name><OutlineLevel>1</OutlineLevel></Task>' +
    '</Tasks></Project>';
  var doc = Mspdi.fromXml(xml);
  eq(doc.tasks[0].name, 'R & D <plan>', 'CDATA name decoded');
  eq(doc.tasks[0].duration, 0, 'milestone with no duration -> 0');
  eq(doc.tasks[1].duration, 1, 'non-milestone with no duration -> 1 day');
})();

// ---- import: rejects non-Project XML ----
(function () {
  var threw = false;
  try { Mspdi.fromXml('<html><body>nope</body></html>'); } catch (e) { threw = true; }
  ok(threw, 'non-Project XML rejected');
  var threw2 = false;
  try { Mspdi.fromXml('not xml at all'); } catch (e) { threw2 = true; }
  ok(threw2, 'garbage input rejected');
})();

// ---- import: empty Tasks yields a loadable empty project ----
(function () {
  var xml = '<Project xmlns="http://schemas.microsoft.com/project"><Title>Empty</Title><Tasks></Tasks></Project>';
  var doc = Mspdi.fromXml(xml);
  eq(doc.tasks.length, 0, 'no tasks imported');
  var m = Model.createModel();
  m.loadProject(doc); // must not throw
  eq(m.getProject().name, 'Empty', 'empty project name imported + loads');
})();

// ==========================================================================
// Import — adversarial-review regression locks
// ==========================================================================

// REVIEW FIX 1 & 2: non-numeric or duplicate UIDs -> fresh sequential ids,
// never NaN/null, never a collision; preds remap through the id space.
(function () {
  var xml = '<Project xmlns="http://schemas.microsoft.com/project"><Tasks>' +
    '<Task><UID>abc</UID><Name>Alpha</Name><OutlineLevel>1</OutlineLevel></Task>' +
    '<Task><UID>def</UID><Name>Beta</Name><OutlineLevel>1</OutlineLevel></Task>' +
    '</Tasks></Project>';
  var doc = Mspdi.fromXml(xml);
  eq(doc.tasks.map(function (t) { return t.id; }), [1, 2], 'non-numeric UIDs -> sequential ids (no NaN)');
  eq(doc.nextTaskId, 3, 'nextTaskId past the imported tasks');
  // survives a JSON round-trip as real integers (NaN would serialize to null)
  var rt = JSON.parse(JSON.stringify(doc));
  ok(rt.tasks.every(function (t) { return typeof t.id === 'number' && isFinite(t.id); }), 'ids stay finite through JSON');

  var dup = '<Project xmlns="http://schemas.microsoft.com/project"><Tasks>' +
    '<Task><UID>5</UID><Name>First</Name><OutlineLevel>1</OutlineLevel></Task>' +
    '<Task><UID>5</UID><Name>Second</Name><OutlineLevel>1</OutlineLevel></Task>' +
    '<Task><UID>9</UID><Name>Third</Name><OutlineLevel>1</OutlineLevel>' +
    '<PredecessorLink><PredecessorUID>5</PredecessorUID><Type>1</Type></PredecessorLink></Task>' +
    '</Tasks></Project>';
  var d2 = Mspdi.fromXml(dup);
  eq(d2.tasks.map(function (t) { return t.id; }), [1, 2, 3], 'duplicate UID 5 -> distinct ids 1,2');
  eq(d2.tasks[2].predecessors[0].id, 1, 'dup-UID pred resolves first-wins (id 1 = First)');
  var m = Model.createModel(); m.loadProject(d2);
  eq(m.getProject().tasks.map(function (t) { return t.id; }), [1, 2, 3], 'model keeps distinct ids after load');
})();

// REVIEW FIX 3: a missing end tag must ERROR, not silently drop siblings.
(function () {
  var bad = '<Project xmlns="http://schemas.microsoft.com/project"><Tasks>' +
    '<Task><UID>1</UID><Name>One</Name>' +           // <-- no </Task>
    '<Task><UID>2</UID><Name>Two</Name></Task>' +
    '</Tasks></Project>';
  var threw = false, msg = '';
  try { Mspdi.fromXml(bad); } catch (e) { threw = true; msg = e.message; }
  ok(threw, 'missing end tag throws instead of truncating');
  ok(/malformed XML/.test(msg), 'error identifies malformed XML');
  // and an unclosed root throws too
  var t2 = false;
  try { Mspdi.parseXML('<Project><Tasks></Tasks>'); } catch (e) { t2 = true; }
  ok(t2, 'unclosed root throws');
})();

// REVIEW FIX 4: single-quoted attribute containing '>' doesn't corrupt content.
(function () {
  var xml = "<Project xmlns='http://schemas.microsoft.com/project'><Tasks>" +
    "<Task foo='a>b'><UID>1</UID><Name>Clean</Name><OutlineLevel>1</OutlineLevel></Task>" +
    '</Tasks></Project>';
  var doc = Mspdi.fromXml(xml);
  eq(doc.tasks.length, 1, 'single-quoted attr with > parsed');
  eq(doc.tasks[0].name, 'Clean', 'no attribute leakage into task text');
})();

// REVIEW FIX 5: self-predecessor dropped on import.
(function () {
  var xml = '<Project xmlns="http://schemas.microsoft.com/project"><Tasks>' +
    '<Task><UID>1</UID><Name>A</Name><OutlineLevel>1</OutlineLevel>' +
    '<PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type></PredecessorLink></Task>' +
    '</Tasks></Project>';
  var doc = Mspdi.fromXml(xml);
  eq(doc.tasks[0].predecessors.length, 0, 'self-predecessor removed');
})();

// REVIEW FIX 6: astral / emoji numeric entity decoded intact.
(function () {
  var xml = '<Project xmlns="http://schemas.microsoft.com/project"><Tasks>' +
    '<Task><UID>1</UID><Name>&#128512;X</Name><OutlineLevel>1</OutlineLevel></Task>' +
    '</Tasks></Project>';
  var doc = Mspdi.fromXml(xml);
  eq(doc.tasks[0].name, '😀X', 'astral codepoint decoded via fromCodePoint');
})();

// REVIEW FIX 7: P<n>D day-form duration; positive sub-day rounds up to 1.
(function () {
  var mk = function (d) {
    return '<Project xmlns="http://schemas.microsoft.com/project"><Tasks>' +
      '<Task><UID>1</UID><Name>T</Name><OutlineLevel>1</OutlineLevel><Duration>' + d + '</Duration></Task>' +
      '</Tasks></Project>';
  };
  eq(Mspdi.fromXml(mk('P5D')).tasks[0].duration, 5, 'P5D -> 5 days');
  eq(Mspdi.fromXml(mk('PT2H0M0S')).tasks[0].duration, 1, 'positive sub-day -> 1 day (not a milestone)');
  eq(Mspdi.fromXml(mk('PT0H0M0S')).tasks[0].duration, 0, 'zero duration stays 0');
})();

console.log('\nMSPDI tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
