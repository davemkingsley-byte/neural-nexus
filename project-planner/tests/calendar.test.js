/* Node tests for calendar working-day math. Run: node tests/calendar.test.js */
'use strict';
var Cal = require('../js/calendar.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) {
  if (JSON.stringify(a) === JSON.stringify(e)) passed++;
  else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); }
}

// 2026-07-13 is a Monday.
var mon = Cal.parseISO('2026-07-13');
eq(Cal.dow(mon), 1, 'Mon dow==1');
eq(Cal.parseISO('2026-07-18'), mon + 5, 'Sat is +5');
eq(Cal.dow(mon + 5), 6, 'Sat dow==6');

var cal = Cal.makeCalendar({ workingDays: [1, 2, 3, 4, 5] });
eq(cal.isWorking(mon), true, 'Mon is working');
eq(cal.isWorking(mon + 5), false, 'Sat not working');
eq(cal.isWorking(mon + 6), false, 'Sun not working');

// Anchor = Monday. index 0..4 = Mon..Fri, index 5 = next Monday (skip weekend).
eq(cal.indexToDay(mon, 0), mon, 'idx0 = Mon');
eq(cal.indexToDay(mon, 4), mon + 4, 'idx4 = Fri');
eq(cal.indexToDay(mon, 5), mon + 7, 'idx5 = next Mon (weekend skipped)');
eq(cal.indexToDay(mon, 9), mon + 11, 'idx9 = 2nd Fri');

// Round-trip
eq(cal.dayToIndex(mon, cal.indexToDay(mon, 5)), 5, 'roundtrip idx5');
eq(cal.dayToIndex(mon, mon), 0, 'dayToIndex anchor==0');
eq(cal.dayToIndex(mon, mon + 7), 5, 'next Monday is idx5');

// Anchor snapping: project starting on a Saturday snaps to Monday.
var sat = mon + 5;
eq(cal.snapForward(sat), mon + 7, 'Sat snaps forward to Mon');

// buildTable matches indexToDay
var table = cal.buildTable(mon, 9);
var okTable = true;
for (var i = 0; i <= 9; i++) if (table[i] !== cal.indexToDay(mon, i)) okTable = false;
eq(okTable, true, 'buildTable matches indexToDay');

// Holiday handling: mark Wednesday (mon+2) as a holiday -> it's skipped.
var cal2 = Cal.makeCalendar({ workingDays: [1, 2, 3, 4, 5], holidays: ['2026-07-15'] });
eq(cal2.isWorking(mon + 2), false, 'Wed holiday not working');
eq(cal2.indexToDay(mon, 2), mon + 3, 'idx2 skips the Wed holiday -> Thu');

console.log('\nCalendar tests: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
