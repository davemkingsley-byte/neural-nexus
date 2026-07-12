/*
 * mspdi.js — export a ProjectDesk plan to Microsoft Project's XML interchange
 * format (MSPDI / "Project 2003 XML"), so plans open in real Microsoft Project
 * (and other tools that read MSPDI: LibreProject, GanttProject, Smartsheet…).
 *
 * Pure: takes a live model (for computed dates) and returns an XML string.
 * Tasks are exported auto-scheduled with durations + dependency links + a
 * matching Standard calendar (working days + holidays), so MS Project's own
 * CPM reproduces the same schedule. Constraints, actuals, deadlines, %complete,
 * resources, rates, and assignments are all carried across.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./calendar.js'));
  else { root.PM = root.PM || {}; root.PM.Mspdi = factory(root.PM.Calendar); }
}(typeof self !== 'undefined' ? self : this, function (Cal) {
  'use strict';

  var HOURS_PER_DAY = 8;                 // MS Project default working day
  var TENTHS_MIN_PER_DAY = HOURS_PER_DAY * 60 * 10; // lag units (tenths of a minute)

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function el(tag, val) { return '<' + tag + '>' + esc(val) + '</' + tag + '>'; }
  // Local datetime MS Project expects (no timezone). start-of-day / end-of-day.
  function dt(dayNum, atEnd) {
    return Cal.toISO(dayNum) + (atEnd ? 'T17:00:00' : 'T08:00:00');
  }
  function isoDur(days) { return 'PT' + Math.round(Math.max(0, days) * HOURS_PER_DAY) + 'H0M0S'; }

  // model dependency type -> MSPDI link Type (0=FF,1=FS,2=SF,3=SS)
  var LINK_TYPE = { FF: 0, FS: 1, SF: 2, SS: 3 };

  function calendarXml(cal) {
    var working = {};
    (cal.workingDays || [1, 2, 3, 4, 5]).forEach(function (d) { working[d] = true; });
    var out = '<Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><WeekDays>';
    // DayType 1=Sunday .. 7=Saturday  (model dow 0=Sun..6=Sat -> +1)
    for (var dow = 0; dow < 7; dow++) {
      var isWork = !!working[dow];
      out += '<WeekDay><DayType>' + (dow + 1) + '</DayType><DayWorking>' + (isWork ? 1 : 0) + '</DayWorking>';
      if (isWork) {
        out += '<WorkingTimes>' +
          '<WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime>' +
          '<WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime>' +
          '</WorkingTimes>';
      }
      out += '</WeekDay>';
    }
    // Holidays as non-working exception days.
    (cal.holidays || []).forEach(function (h) {
      var n = Cal.parseISO(h);
      if (n == null) return;
      out += '<WeekDay><DayWorking>0</DayWorking><TimePeriod>' +
        '<FromDate>' + Cal.toISO(n) + 'T00:00:00</FromDate>' +
        '<ToDate>' + Cal.toISO(n) + 'T23:59:00</ToDate></TimePeriod></WeekDay>';
    });
    out += '</WeekDays></Calendar>';
    return out;
  }

  function taskXml(r, project) {
    var t = r.task;
    var p = '<Task>';
    p += el('UID', t.id);
    p += el('ID', r.row);
    p += el('Name', t.name || '');
    p += el('Active', 1);
    p += el('Manual', 0);                       // auto-scheduled
    p += el('Type', 1);                          // fixed duration
    p += el('OutlineLevel', r.outlineLevel);
    p += el('OutlineNumber', r.wbs);
    p += el('WBS', r.wbs);
    p += el('Summary', r.isSummary ? 1 : 0);
    p += el('Milestone', r.isMilestone ? 1 : 0);
    p += el('Start', dt(r.startDay, false));
    p += el('Finish', dt(r.finishDay, true));
    p += el('Duration', isoDur(r.durationDays));
    p += el('DurationFormat', 7);                // days
    p += el('PercentComplete', r.percentComplete);
    if (t.notes) p += el('Notes', t.notes);
    if (t.deadlineISO) p += el('Deadline', t.deadlineISO + 'T17:00:00');
    // Constraints
    if (t.constraintType === 'MSO' && t.constraintISO) {
      p += el('ConstraintType', 2) + el('ConstraintDate', t.constraintISO + 'T08:00:00');
    } else if (t.constraintType === 'SNET' && t.constraintISO) {
      p += el('ConstraintType', 4) + el('ConstraintDate', t.constraintISO + 'T08:00:00');
    } else {
      p += el('ConstraintType', 0);              // As Soon As Possible
    }
    // Actuals
    if (t.actualStartISO) p += el('ActualStart', t.actualStartISO + 'T08:00:00');
    if (t.actualFinishISO) p += el('ActualFinish', t.actualFinishISO + 'T17:00:00');
    // Dependency links
    (t.predecessors || []).forEach(function (pr) {
      p += '<PredecessorLink>' +
        el('PredecessorUID', pr.id) +
        el('Type', LINK_TYPE[pr.type] != null ? LINK_TYPE[pr.type] : 1) +
        el('LinkLag', Math.round((pr.lag || 0) * TENTHS_MIN_PER_DAY)) +
        el('LagFormat', 7) +
        '</PredecessorLink>';
    });
    p += '</Task>';
    return p;
  }

  function resourceXml(res, i) {
    return '<Resource>' +
      el('UID', res.id) + el('ID', i + 1) + el('Name', res.name || '') +
      el('Type', 1) +                            // work resource
      el('StandardRate', (res.rate || 0)) +
      el('StandardRateFormat', 3) +              // /day
      '</Resource>';
  }

  function toXml(model) {
    var project = model.getProject();
    var c = model.getComputed();
    var startDay = c.projectStartDay;

    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    xml += '<Project xmlns="http://schemas.microsoft.com/project">';
    xml += el('SaveVersion', 14);
    xml += el('Name', (project.name || 'Project') + '.xml');
    xml += el('Title', project.name || 'Project');
    xml += el('Author', 'ProjectDesk');
    xml += el('CreationDate', (project.startISO || Cal.toISO(startDay)) + 'T08:00:00');
    xml += el('StartDate', dt(startDay, false));
    xml += el('FinishDate', dt(c.projectEndDay, true));
    xml += el('CalendarUID', 1);
    xml += el('DefaultStartTime', '08:00:00');
    xml += el('DefaultFinishTime', '17:00:00');
    xml += el('MinutesPerDay', HOURS_PER_DAY * 60);
    xml += el('MinutesPerWeek', HOURS_PER_DAY * 60 * (project.calendar && project.calendar.workingDays ? project.calendar.workingDays.length : 5));
    xml += el('DaysPerMonth', 20);
    xml += el('DurationFormat', 7);

    xml += '<Calendars>' + calendarXml(project.calendar || {}) + '</Calendars>';

    xml += '<Tasks>';
    c.rows.forEach(function (r) { xml += taskXml(r, project); });
    xml += '</Tasks>';

    xml += '<Resources>';
    (project.resources || []).forEach(function (res, i) { xml += resourceXml(res, i); });
    xml += '</Resources>';

    // Assignments: one per (task, resource) pair.
    xml += '<Assignments>';
    var auid = 1;
    project.tasks.forEach(function (t) {
      (t.resourceIds || []).forEach(function (rid) {
        xml += '<Assignment>' +
          el('UID', auid++) + el('TaskUID', t.id) + el('ResourceUID', rid) +
          el('Units', 1) +
          '</Assignment>';
      });
    });
    xml += '</Assignments>';

    xml += '</Project>';
    return xml;
  }

  return { toXml: toXml };
}));
