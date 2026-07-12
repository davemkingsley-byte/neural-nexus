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
    p += el('Type', t.taskType === 'work' ? 2 : 1); // 2=Fixed Work, 1=Fixed Duration
    p += el('OutlineLevel', r.outlineLevel);
    p += el('OutlineNumber', r.wbs);
    p += el('WBS', r.wbs);
    p += el('Summary', r.isSummary ? 1 : 0);
    p += el('Milestone', r.isMilestone ? 1 : 0);
    p += el('Start', dt(r.startDay, false));
    p += el('Finish', dt(r.finishDay, true));
    p += el('Duration', isoDur(r.durationDays));
    p += el('DurationFormat', 7);                // days
    if (r.workHours != null) p += el('Work', 'PT' + Math.round(r.workHours) + 'H0M0S');
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

    // Assignments: one per (task, resource) pair; Units is the MSPDI decimal
    // (1 = 100%, 0.5 = half-time).
    xml += '<Assignments>';
    var auid = 1;
    project.tasks.forEach(function (t) {
      var asgs = (t.assignments && t.assignments.length)
        ? t.assignments
        : (t.resourceIds || []).map(function (rid) { return { resourceId: rid, units: 1 }; });
      asgs.forEach(function (a) {
        xml += '<Assignment>' +
          el('UID', auid++) + el('TaskUID', t.id) + el('ResourceUID', a.resourceId) +
          el('Units', a.units) +
          '</Assignment>';
      });
    });
    xml += '</Assignments>';

    xml += '</Project>';
    return xml;
  }

  // ==========================================================================
  // Import: MSPDI XML -> ProjectDesk project document
  // ==========================================================================

  function decodeEntities(s) {
    return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, function (m, e) {
      if (e === 'amp') return '&';
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      if (e.charAt(0) === '#') {
        var code = e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        // fromCodePoint (not fromCharCode) so astral chars/emoji survive intact.
        if (isFinite(code) && code >= 0 && code <= 0x10FFFF) {
          try { return String.fromCodePoint(code); } catch (x) { return m; }
        }
        return m;
      }
      return m;
    });
  }

  // Minimal, dependency-free XML parser for the MSPDI subset (elements, text,
  // attributes we ignore, entities, self-closing tags). Returns the root
  // element node: { tag, children:[node], text:string }.
  function parseXML(str) {
    str = String(str)
      .replace(/<\?[\s\S]*?\?>/g, '')     // prolog / PIs
      .replace(/<!--[\s\S]*?-->/g, '')     // comments
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, function (m, c) { // CDATA -> escaped text
        return c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      });
    var root = { tag: '#root', children: [], text: '' };
    var stack = [root];
    // Attribute values in either quote style may contain a literal '>'.
    var re = /<\s*(\/?)\s*([A-Za-z_][\w.:-]*)((?:[^"'>]|"[^"]*"|'[^']*')*?)\s*(\/?)>|([^<]+)/g;
    var m;
    while ((m = re.exec(str)) !== null) {
      if (m[5] != null) { // text
        var txt = m[5];
        if (txt.trim()) stack[stack.length - 1].text += decodeEntities(txt);
        continue;
      }
      var closing = m[1] === '/';
      var tag = m[2];
      var selfClose = m[4] === '/';
      if (closing) {
        // Strict well-formedness: a close tag must match the currently open
        // element. Silently popping on a mismatch would let one missing end
        // tag swallow every following sibling (silent data loss on import).
        var top = stack[stack.length - 1];
        if (stack.length < 2 || top.tag !== tag) {
          throw new Error('malformed XML: unexpected </' + tag + '>' +
            (stack.length >= 2 ? ' (expected </' + top.tag + '>)' : ''));
        }
        stack.pop();
      } else {
        var node = { tag: tag, children: [], text: '' };
        stack[stack.length - 1].children.push(node);
        if (!selfClose) stack.push(node);
      }
    }
    if (stack.length !== 1) throw new Error('malformed XML: unclosed <' + stack[stack.length - 1].tag + '>');
    return root.children[0] || root; // the top element (<Project>)
  }

  function kids(node, tag) {
    return (node && node.children || []).filter(function (c) { return c.tag === tag; });
  }
  function kid(node, tag) { return kids(node, tag)[0] || null; }
  function txt(node, tag) { var c = kid(node, tag); return c ? c.text.trim() : ''; }
  function num(node, tag, dflt) { var v = txt(node, tag); return v === '' ? (dflt == null ? null : dflt) : Number(v); }

  function isoDurToDays(s) {
    // ISO 8601 duration. MS Project emits PT<h>H<m>M<s>S; also accept a day
    // component (P<n>D) that some exporters use. Returns whole days (the model
    // is day-granular); a positive sub-day duration rounds to at least 1 day so
    // a real short task isn't silently turned into a milestone.
    var m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || '').trim());
    if (!m || (m[1] == null && m[2] == null && m[3] == null && m[4] == null)) return null;
    var hours = (parseFloat(m[1]) || 0) * HOURS_PER_DAY +
      (parseFloat(m[2]) || 0) + (parseFloat(m[3]) || 0) / 60 + (parseFloat(m[4]) || 0) / 3600;
    var days = hours / HOURS_PER_DAY;
    if (days > 0 && days < 1) return 1;
    return Math.round(days);
  }
  // ISO 8601 duration -> hours (for the Work element; a day component counts
  // as HOURS_PER_DAY). Returns null when nothing parses.
  function isoDurToHours(s) {
    var m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || '').trim());
    if (!m || (m[1] == null && m[2] == null && m[3] == null && m[4] == null)) return null;
    return (parseFloat(m[1]) || 0) * HOURS_PER_DAY +
      (parseFloat(m[2]) || 0) + (parseFloat(m[3]) || 0) / 60 + (parseFloat(m[4]) || 0) / 3600;
  }
  function dateOnly(s) { var d = String(s || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null; }

  var TYPE_TO_STR = { 0: 'FF', 1: 'FS', 2: 'SF', 3: 'SS' };

  function fromXml(str) {
    var proj = parseXML(str);
    if (!proj || !/Project$/.test(proj.tag)) throw new Error('not a Microsoft Project XML file (no <Project> root)');

    // Calendar (the base calendar) -> working days + holidays
    var workingDays = [], holidays = [];
    var calRoot = kid(proj, 'Calendars');
    var calendars = calRoot ? kids(calRoot, 'Calendar') : [];
    var base = calendars.filter(function (c) { return txt(c, 'IsBaseCalendar') === '1'; })[0] || calendars[0];
    if (base) {
      var wd = kid(base, 'WeekDays');
      kids(wd, 'WeekDay').forEach(function (day) {
        var dayType = txt(day, 'DayType');
        var working = txt(day, 'DayWorking') === '1';
        if (dayType !== '') {
          if (working) workingDays.push((parseInt(dayType, 10) - 1 + 7) % 7); // DayType 1=Sun -> dow 0
        } else if (!working) {
          var tp = kid(day, 'TimePeriod');
          var d = tp ? dateOnly(txt(tp, 'FromDate')) : null;
          if (d) holidays.push(d);
        }
      });
    }
    if (!workingDays.length) workingDays = [1, 2, 3, 4, 5];
    workingDays.sort(function (a, b) { return a - b; });

    // Resources
    var resById = {};
    var resources = [];
    var resRoot = kid(proj, 'Resources');
    var nextResourceId = 1;
    (resRoot ? kids(resRoot, 'Resource') : []).forEach(function (rn) {
      var uid = num(rn, 'UID');
      var name = txt(rn, 'Name');
      if (uid == null || uid === 0 || !name) return; // skip the "unassigned" UID 0
      var id = nextResourceId++;
      resById[uid] = id;
      resources.push({
        id: id, name: name,
        initials: name.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase() || '?',
        color: '#2563eb',
        rate: Math.max(0, num(rn, 'StandardRate', 0) || 0)
      });
    });

    // Assignments: taskUID -> [{resourceId, units}] (Units decimal, default 1)
    var assignByTask = {};
    var asgRoot = kid(proj, 'Assignments');
    (asgRoot ? kids(asgRoot, 'Assignment') : []).forEach(function (an) {
      var tuid = num(an, 'TaskUID'), ruid = num(an, 'ResourceUID');
      if (tuid == null || ruid == null || !resById[ruid]) return;
      var units = num(an, 'Units', 1);
      if (!isFinite(units) || units <= 0) units = 1;
      var list = (assignByTask[tuid] = assignByTask[tuid] || []);
      if (!list.some(function (a) { return a.resourceId === resById[ruid]; })) {
        list.push({ resourceId: resById[ruid], units: Math.min(3, Math.max(0.05, units)) });
      }
    });

    // Tasks. Skip the UID 0 / OutlineLevel 0 project-summary row MS Project emits.
    var tasksRoot = kid(proj, 'Tasks');
    var taskNodes = (tasksRoot ? kids(tasksRoot, 'Task') : []).filter(function (t) {
      return num(t, 'UID') !== 0 && num(t, 'OutlineLevel', 1) !== 0;
    });

    // Remap every task onto a fresh sequential id space (1..N). A file's UIDs
    // may be non-numeric, duplicated, or huge/sparse (hand-edited or corrupt);
    // the model does NOT validate task ids, so a raw NaN or duplicate id would
    // corrupt link targeting and nextTaskId. Predecessor + assignment refs are
    // translated through this map (first-wins on duplicate UIDs); refs that
    // don't resolve — dangling, to the dropped summary, or self — are removed.
    var uidToId = {};
    taskNodes.forEach(function (t, i) {
      var uid = num(t, 'UID');
      if (uid != null && isFinite(uid) && !(uid in uidToId)) uidToId[uid] = i + 1;
    });

    var tasks = taskNodes.map(function (t, i) {
      var newId = i + 1;
      var origUid = num(t, 'UID');
      var dur = isoDurToDays(txt(t, 'Duration'));
      if (dur == null) dur = txt(t, 'Milestone') === '1' ? 0 : 1;
      var seenPred = {};
      var task = {
        id: newId,
        name: txt(t, 'Name') || '',
        duration: Math.max(0, dur),
        outlineLevel: Math.max(1, num(t, 'OutlineLevel', 1) || 1),
        predecessors: kids(t, 'PredecessorLink').map(function (pl) {
          var puid = num(pl, 'PredecessorUID');
          var mapped = (puid != null && isFinite(puid)) ? uidToId[puid] : undefined;
          var type = TYPE_TO_STR[num(pl, 'Type', 1)] || 'FS';
          var lag = Math.round((num(pl, 'LinkLag', 0) || 0) / TENTHS_MIN_PER_DAY);
          return { id: mapped == null ? null : mapped, type: type, lag: lag };
        }).filter(function (p) {
          if (p.id == null || p.id === newId) return false;   // dangling / self
          if (seenPred[p.id]) return false;                    // duplicate link
          seenPred[p.id] = true; return true;
        }),
        percentComplete: Math.max(0, Math.min(100, num(t, 'PercentComplete', 0) || 0)),
        assignments: (origUid != null && assignByTask[origUid]) ? assignByTask[origUid] : [],
        resourceIds: (origUid != null && assignByTask[origUid])
          ? assignByTask[origUid].map(function (a) { return a.resourceId; }) : [],
        collapsed: false,
        constraintISO: null,
        constraintType: null,
        deadlineISO: dateOnly(txt(t, 'Deadline')),
        actualStartISO: dateOnly(txt(t, 'ActualStart')),
        actualFinishISO: dateOnly(txt(t, 'ActualFinish')),
        notes: txt(t, 'Notes') || '',
        taskType: 'fixed',
        workHours: null
      };
      // Type 2 = Fixed Work: preserve the Work quantity so duration re-derives.
      if (num(t, 'Type') === 2) {
        var wh = isoDurToHours(txt(t, 'Work'));
        if (wh != null && wh > 0) { task.taskType = 'work'; task.workHours = wh; }
      }
      var ct = num(t, 'ConstraintType');
      var cd = dateOnly(txt(t, 'ConstraintDate'));
      if (ct === 2 && cd) { task.constraintType = 'MSO'; task.constraintISO = cd; }
      else if (ct === 4 && cd) { task.constraintType = 'SNET'; task.constraintISO = cd; }
      return task;
    });

    var startISO = dateOnly(txt(proj, 'StartDate')) || dateOnly(txt(proj, 'CreationDate')) || Cal.toISO(Cal.todayDayNum());
    var name = txt(proj, 'Title') || txt(proj, 'Name').replace(/\.xml$/i, '') || 'Imported Project';

    return {
      id: 'import' + startISO,
      name: name,
      startISO: startISO,
      calendar: { workingDays: workingDays, holidays: holidays },
      tasks: tasks,
      resources: resources,
      nextTaskId: tasks.length + 1,
      nextResourceId: nextResourceId,
      baseline: null,
      view: { zoom: 'week' }
    };
  }

  return { toXml: toXml, fromXml: fromXml, parseXML: parseXML };
}));
