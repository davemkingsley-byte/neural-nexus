/*
 * gantt.js — the right-hand timeline: a two-tier date header plus an SVG chart
 * with task/summary/milestone bars, % complete, dependency arrows, the critical
 * path, weekend/holiday shading, a "today" line, and drag-to-reschedule.
 */
(function (root, factory) {
  root.PM = root.PM || {};
  root.PM.Gantt = factory(root.PM);
}(typeof self !== 'undefined' ? self : this, function (PM) {
  'use strict';

  var Cal = PM.Calendar;
  var ROW_H = 30;   // must match Grid.ROW_H
  var BAR_H = 16;
  var HEADER_H = 46;

  var ZOOM = {
    day: { dayWidth: 30, minor: 'day' },
    week: { dayWidth: 15, minor: 'week' },
    month: { dayWidth: 5, minor: 'month' }
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function mondayOnOrBefore(d) { return d - ((Cal.dow(d) + 6) % 7); }
  function firstOfMonth(y, m) { return Math.round(Date.UTC(y, m, 1) / Cal.MS); }

  function buildScale(computed, zoom) {
    var z = ZOOM[zoom] || ZOOM.week;
    // The timeline must span deadlines too — a deadline past the finish (or
    // before the start) would otherwise be clipped off-canvas and invisible.
    var minDay = computed.projectStartDay, maxDay = computed.projectEndDay;
    (computed.rows || []).forEach(function (r) {
      if (r.deadlineDay != null) {
        if (r.deadlineDay < minDay) minDay = r.deadlineDay;
        if (r.deadlineDay > maxDay) maxDay = r.deadlineDay;
      }
    });
    var t0 = mondayOnOrBefore(minDay) - 0;
    var end = maxDay + 10;
    // pad to at least ~4 weeks of width
    if (end - t0 < 28) end = t0 + 28;
    var totalDays = end - t0 + 1;
    return { t0: t0, end: end, totalDays: totalDays, dayWidth: z.dayWidth, minor: z.minor, width: totalDays * z.dayWidth };
  }
  function xOf(scale, dayNum) { return (dayNum - scale.t0) * scale.dayWidth; }

  // ---- Header ---------------------------------------------------------------
  function monthSegs(t0, t1) {
    var segs = [], d = t0;
    while (d <= t1) {
      var p = Cal.parts(d);
      var fs = firstOfMonth(p.y, p.m);
      var ls = firstOfMonth(p.m === 11 ? p.y + 1 : p.y, (p.m + 1) % 12) - 1;
      var s = Math.max(t0, fs), e = Math.min(t1, ls);
      segs.push({ start: s, end: e, label: Cal.MON_NAMES[p.m] + ' ' + String(p.y).slice(-2) });
      d = ls + 1;
    }
    return segs;
  }
  function yearSegs(t0, t1) {
    var segs = [], d = t0;
    while (d <= t1) {
      var p = Cal.parts(d);
      var fs = Math.round(Date.UTC(p.y, 0, 1) / Cal.MS);
      var ls = Math.round(Date.UTC(p.y + 1, 0, 1) / Cal.MS) - 1;
      var s = Math.max(t0, fs), e = Math.min(t1, ls);
      segs.push({ start: s, end: e, label: '' + p.y });
      d = ls + 1;
    }
    return segs;
  }
  function weekSegs(t0, t1) {
    var segs = [], d = mondayOnOrBefore(t0);
    while (d <= t1) {
      var s = Math.max(t0, d), e = Math.min(t1, d + 6);
      var p = Cal.parts(s);
      segs.push({ start: s, end: e, label: (p.m + 1) + '/' + p.d });
      d += 7;
    }
    return segs;
  }
  function daySegs(t0, t1, cal) {
    var segs = [];
    for (var d = t0; d <= t1; d++) {
      segs.push({ start: d, end: d, label: Cal.parts(d).d, weekend: !cal.isWorking(d) });
    }
    return segs;
  }
  function monthLabelSegs(t0, t1) {
    return monthSegs(t0, t1).map(function (s) {
      var p = Cal.parts(s.start);
      return { start: s.start, end: s.end, label: Cal.MON_NAMES[p.m] };
    });
  }

  function tierHTML(segs, scale, cls) {
    var h = '';
    segs.forEach(function (s) {
      var left = xOf(scale, s.start);
      var w = (s.end - s.start + 1) * scale.dayWidth;
      var extra = s.weekend ? ' weekend' : '';
      h += '<div class="tier-cell' + extra + ' ' + cls + '" style="left:' + left + 'px;width:' + w + 'px">' +
        '<span>' + esc(s.label) + '</span></div>';
    });
    return h;
  }

  function renderHeader(headerEl, computed, scale, zoom) {
    var top, bottom;
    if (zoom === 'month') {
      top = yearSegs(scale.t0, scale.end);
      bottom = monthLabelSegs(scale.t0, scale.end);
    } else if (zoom === 'week') {
      top = monthSegs(scale.t0, scale.end);
      bottom = weekSegs(scale.t0, scale.end);
    } else {
      top = monthSegs(scale.t0, scale.end);
      bottom = daySegs(scale.t0, scale.end, computed.cal);
    }
    headerEl.innerHTML =
      '<div class="gantt-header-inner" style="width:' + scale.width + 'px">' +
        '<div class="tier tier-top">' + tierHTML(top, scale, 'top') + '</div>' +
        '<div class="tier tier-bottom">' + tierHTML(bottom, scale, 'bottom') + '</div>' +
      '</div>';
  }

  // ---- SVG body -------------------------------------------------------------
  function renderBody(bodyEl, model, scale, opts) {
    var computed = model.getComputed();
    var rows = model.getVisibleRows();
    var selected = opts.selected || {};
    var height = Math.max(rows.length * ROW_H, 60);
    var W = scale.width, cal = computed.cal;

    var idToVisible = {};
    rows.forEach(function (r, i) { idToVisible[r.id] = i; });

    var svg = '<svg class="gantt-svg" width="' + W + '" height="' + height + '" viewBox="0 0 ' + W + ' ' + height + '">';
    svg += '<defs><marker id="arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">' +
      '<path d="M0,0 L6,3 L0,6 Z" fill="#7a7a7a"/></marker></defs>';

    // Non-working day shading (skip when columns too narrow to matter).
    if (scale.dayWidth >= 8) {
      for (var d = scale.t0; d <= scale.end; d++) {
        if (!cal.isWorking(d)) {
          svg += '<rect class="nonwork" x="' + xOf(scale, d) + '" y="0" width="' + scale.dayWidth + '" height="' + height + '"/>';
        }
      }
    }
    // Month gridlines
    monthSegs(scale.t0, scale.end).forEach(function (s) {
      var x = xOf(scale, s.start);
      svg += '<line class="gridline" x1="' + x + '" y1="0" x2="' + x + '" y2="' + height + '"/>';
    });
    // Row separators + selection highlight
    rows.forEach(function (r, i) {
      var y = i * ROW_H;
      if (selected[r.id]) svg += '<rect class="rowsel" x="0" y="' + y + '" width="' + W + '" height="' + ROW_H + '"/>';
      svg += '<line class="rowline" x1="0" y1="' + (y + ROW_H) + '" x2="' + W + '" y2="' + (y + ROW_H) + '"/>';
    });

    // Today line
    var today = Cal.todayDayNum();
    if (today >= scale.t0 && today <= scale.end) {
      var tx = xOf(scale, today) + scale.dayWidth / 2;
      svg += '<line class="today" x1="' + tx + '" y1="0" x2="' + tx + '" y2="' + height + '"/>';
    }
    // Status-date line ("as of" — progress is measured against this)
    if (computed.statusDay != null && computed.statusDay >= scale.t0 && computed.statusDay <= scale.end) {
      var sx = xOf(scale, computed.statusDay) + scale.dayWidth;
      svg += '<line class="status-line" x1="' + sx + '" y1="0" x2="' + sx + '" y2="' + height + '"><title>Status date: ' + esc(Cal.fmt(computed.statusDay)) + '</title></line>';
    }

    // Dependency arrows (only between visible endpoints)
    rows.forEach(function (r) {
      var si = idToVisible[r.id];
      (r.task.predecessors || []).forEach(function (p) {
        var pi = idToVisible[p.id];
        if (pi == null) return;
        var pr = rows[pi];
        var geomP = barGeom(pr, scale);
        var geomS = barGeom(r, scale);
        var type = p.type || 'FS';
        var sx = (type === 'SS' || type === 'SF') ? geomP.x : geomP.x2;
        var sdir = (type === 'SS' || type === 'SF') ? -1 : 1;
        var tx2 = (type === 'FF' || type === 'SF') ? geomS.x2 : geomS.x;
        var sy = pi * ROW_H + ROW_H / 2;
        var ty = si * ROW_H + ROW_H / 2;
        svg += '<path class="dep" d="' + arrowPath(sx, sy, sdir, tx2, ty) + '" marker-end="url(#arrowhead)"/>';
      });
    });

    // Baseline underbars (gray): where the plan stood when the baseline was set.
    if (computed.baseline) {
      rows.forEach(function (r, i) {
        var b = computed.baseline[r.id];
        if (!b || r.isSummary) return;
        var bx = xOf(scale, b.startDay);
        var bx2 = xOf(scale, b.finishDay) + scale.dayWidth;
        var by = i * ROW_H + ROW_H / 2 + BAR_H / 2 + 1;
        var slipDays = r.finishDay - b.finishDay;
        var slipTxt = slipDays > 0 ? slipDays + ' day(s) later than baseline'
          : slipDays < 0 ? (-slipDays) + ' day(s) earlier than baseline' : 'on baseline';
        svg += '<rect class="baseline-bar' + (slipDays > 0 ? ' slipped' : '') + '" x="' + bx + '" y="' + by +
          '" width="' + Math.max(bx2 - bx, 2) + '" height="4" rx="2">' +
          '<title>Baseline: ' + esc(Cal.fmt(b.startDay)) + ' → ' + esc(Cal.fmt(b.finishDay)) + ' (' + esc(slipTxt) + ')</title></rect>';
      });
    }

    // Bars
    rows.forEach(function (r, i) {
      svg += renderBar(r, i, scale, model);
    });

    // Deadline markers (indicator arrows; red when the finish has slipped past)
    rows.forEach(function (r, i) {
      if (r.deadlineDay == null) return;
      var dx = xOf(scale, r.deadlineDay) + scale.dayWidth; // end of the deadline day
      var yMid = i * ROW_H + ROW_H / 2;
      var cls = r.deadlineMissed ? 'deadline-marker missed' : 'deadline-marker';
      svg += '<path class="' + cls + '" d="M' + dx + ' ' + (yMid + 4) + ' l-6 -10 h12 Z">' +
        '<title>Deadline: ' + esc(Cal.fmt(r.deadlineDay)) + (r.deadlineMissed ? ' — MISSED' : '') + '</title></path>';
    });

    svg += '<g class="ghost-layer"></g></svg>';
    bodyEl.innerHTML = '<div class="gantt-canvas" style="width:' + W + 'px;height:' + height + 'px">' + svg + '</div>';

    var canvas = bodyEl.querySelector('.gantt-canvas');
    wireDrag(bodyEl, canvas, model, scale, rows, opts);
  }

  function barGeom(r, scale) {
    var x = xOf(scale, r.startDay);
    var x2 = xOf(scale, r.finishDay) + scale.dayWidth; // inclusive finish -> end of day
    return { x: x, x2: x2, w: Math.max(x2 - x, 1) };
  }

  function arrowPath(sx, sy, sdir, tx, ty) {
    var stub = 9;
    var ax = sx + sdir * stub;
    // Simple elbow when the target lies ahead of the exit stub; otherwise wrap.
    var ahead = sdir > 0 ? (tx >= ax) : (tx <= ax);
    if (ahead) {
      return 'M' + sx + ' ' + sy + ' H' + ax + ' V' + ty + ' H' + tx;
    }
    var my = (sy + ty) / 2;
    return 'M' + sx + ' ' + sy + ' H' + ax + ' V' + my + ' H' + (tx - stub) + ' V' + ty + ' H' + tx;
  }

  function renderBar(r, i, scale, model) {
    var g = barGeom(r, scale);
    var yMid = i * ROW_H + ROW_H / 2;
    var resNames = model.formatAssignments(r.task);
    var labelParts = [];
    if (resNames) labelParts.push(resNames);
    var label = labelParts.join(' ');
    var out = '';

    if (r.isSummary) {
      var top = yMid - 4;
      out += '<g class="bar-group summary-bar" data-bar-id="' + r.id + '" data-kind="summary">';
      out += '<rect class="hit" x="' + g.x + '" y="' + (yMid - BAR_H / 2) + '" width="' + g.w + '" height="' + BAR_H + '" fill="transparent"/>';
      out += '<rect class="summary" x="' + g.x + '" y="' + top + '" width="' + g.w + '" height="6"/>';
      out += '<path class="summary-cap" d="M' + g.x + ' ' + (top + 6) + ' l5 6 l-5 0 Z"/>';
      out += '<path class="summary-cap" d="M' + g.x2 + ' ' + (top + 6) + ' l-5 6 l5 0 Z"/>';
      out += '</g>';
      return out;
    }
    if (r.isMilestone) {
      var cx = xOf(scale, r.startDay) + scale.dayWidth / 2;
      var s = 7;
      var cls = r.critical ? 'milestone crit' : 'milestone';
      out += '<g class="bar-group" data-bar-id="' + r.id + '" data-kind="milestone">';
      out += '<rect class="hit" x="' + (cx - s - 2) + '" y="' + (yMid - s - 2) + '" width="' + (2 * s + 4) + '" height="' + (2 * s + 4) + '" fill="transparent"/>';
      out += '<path class="' + cls + '" d="M' + cx + ' ' + (yMid - s) + ' L' + (cx + s) + ' ' + yMid + ' L' + cx + ' ' + (yMid + s) + ' L' + (cx - s) + ' ' + yMid + ' Z"/>';
      out += '<circle class="link-handle" cx="' + (cx + s + 6) + '" cy="' + yMid + '" r="4.5" data-link-from="' + r.id + '"><title>Drag to another task to link</title></circle>';
      if (label) out += '<text class="bar-label" x="' + (cx + s + 14) + '" y="' + (yMid + 4) + '">' + esc(label) + '</text>';
      out += '</g>';
      return out;
    }
    // normal task
    var y = yMid - BAR_H / 2;
    var fill = r.critical ? 'crit' : 'normal';
    var progW = Math.max(0, Math.min(g.w, g.w * (r.percentComplete / 100)));
    out += '<g class="bar-group" data-bar-id="' + r.id + '" data-kind="task">';
    out += '<rect class="bar ' + fill + '" x="' + g.x + '" y="' + y + '" rx="3" ry="3" width="' + g.w + '" height="' + BAR_H + '"/>';
    if (progW > 0.5) out += '<rect class="bar-progress" x="' + g.x + '" y="' + (y + 4) + '" width="' + progW + '" height="' + (BAR_H - 8) + '"/>';
    out += '<rect class="resize-handle" x="' + (g.x + g.w - 5) + '" y="' + y + '" width="5" height="' + BAR_H + '" fill="transparent"/>';
    out += '<circle class="link-handle" cx="' + (g.x + g.w + 8) + '" cy="' + yMid + '" r="4.5" data-link-from="' + r.id + '"><title>Drag to another task to link</title></circle>';
    if (label) out += '<text class="bar-label" x="' + (g.x + g.w + 16) + '" y="' + (yMid + 4) + '">' + esc(label) + '</text>';
    out += '</g>';
    return out;
  }

  // ---- Drag to reschedule / resize -----------------------------------------
  function wireDrag(bodyEl, canvas, model, scale, rows, opts) {
    var svg = canvas.querySelector('svg');
    if (!svg) return;
    var rowById = {};
    rows.forEach(function (r) { rowById[r.id] = r; });
    var drag = null;

    // Use the SAME calendar the scheduler uses, so previews match the commit.
    var comp = model.getComputed();
    var cal = comp.cal, anchor = comp.anchor, table = comp.table;
    function idxToDay(idx) { return (idx >= 0 && idx < table.length) ? table[idx] : cal.indexToDay(anchor, idx); }
    function snapWorking(day, dir) {
      var d = day, g = 0;
      if (dir < 0) { while (!cal.isWorking(d) && g++ < 3660) d--; }
      else { while (!cal.isWorking(d) && g++ < 3660) d++; }
      return d;
    }

    function makeTip() {
      var t = document.createElement('div');
      t.className = 'gantt-tip';
      canvas.appendChild(t);
      return t;
    }

    function svgPoint(e) {
      var rect = svg.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    svg.addEventListener('mousedown', function (e) {
      // View-only: bars are selectable but never draggable/linkable.
      if (opts.readOnly) {
        var g0 = e.target.closest && e.target.closest('.bar-group');
        if (g0) opts.onSelect(parseInt(g0.getAttribute('data-bar-id'), 10), { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
        return;
      }
      // Link-handle drag: rubber-band a new FS dependency onto another bar.
      var handle = e.target.closest && e.target.closest('.link-handle');
      if (handle) {
        var fromId = parseInt(handle.getAttribute('data-link-from'), 10);
        var pt = svgPoint(e);
        drag = { mode: 'link', fromId: fromId, fromX: pt.x, fromY: pt.y, targetId: null, tip: makeTip() };
        drag.tip.textContent = 'Link to…';
        e.preventDefault();
        return;
      }
      var grp = e.target.closest('.bar-group');
      if (!grp) return;
      var id = parseInt(grp.getAttribute('data-bar-id'), 10);
      var kind = grp.getAttribute('data-kind');
      var r = rowById[id];
      if (!r) return;
      var mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      var isResize = e.target.classList.contains('resize-handle') && kind === 'task';
      // Selection is deferred to mouseup (as a click) so it doesn't re-render
      // and destroy an in-progress drag. Summaries are derived -> select only.
      drag = {
        id: id, kind: kind, mode: isResize ? 'resize' : 'move', mods: mods,
        selectOnly: (kind === 'summary'),
        startX: e.clientX, moved: false, deltaDays: 0,
        origStart: r.startDay, origDur: r.durationDays, tip: makeTip()
      };
      e.preventDefault();
    });

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Clean up global listeners when this body is re-rendered.
    bodyEl._ganttCleanup = function () {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    function onMove(e) {
      if (!drag || drag.selectOnly) return;
      if (drag.mode === 'link') {
        var pt = svgPoint(e);
        var ghostLayer = svg.querySelector('.ghost-layer');
        ghostLayer.innerHTML = '<line class="link-rubber" x1="' + drag.fromX + '" y1="' + drag.fromY +
          '" x2="' + pt.x + '" y2="' + pt.y + '"/>';
        // Highlight the bar under the cursor as the drop target.
        var grp = e.target && e.target.closest ? e.target.closest('.bar-group') : null;
        var tid = grp ? parseInt(grp.getAttribute('data-bar-id'), 10) : null;
        if (tid === drag.fromId) tid = null;
        if (tid !== drag.targetId) {
          svg.querySelectorAll('.bar-group.link-target').forEach(function (g) { g.classList.remove('link-target'); });
          if (tid != null && grp.getAttribute('data-kind') !== 'summary') grp.classList.add('link-target');
          else tid = null;
          drag.targetId = tid;
        }
        var rTo = drag.targetId != null ? rowById[drag.targetId] : null;
        drag.tip.textContent = rTo ? ('Link: → ' + (rTo.name || 'task ' + rTo.row)) : 'Link to…';
        drag.tip.style.left = (pt.x + 8) + 'px';
        drag.tip.style.top = (pt.y - 10) + 'px';
        drag.tip.style.display = 'block';
        return;
      }
      var dd = Math.round((e.clientX - drag.startX) / scale.dayWidth);
      if (dd !== drag.deltaDays) { drag.deltaDays = dd; if (dd !== 0) drag.moved = true; paint(); }
    }
    function paint() {
      var r = rowById[drag.id];
      var ghostLayer = svg.querySelector('.ghost-layer');
      var i = rows.indexOf(r);
      var yMid = i * ROW_H + ROW_H / 2;
      var newStartDay, newFinishDay, tipText;
      if (drag.mode === 'move') {
        // Snap the drop to a working day in the drag direction, and keep the bar's
        // visual span — this matches what the scheduler will produce on commit.
        newStartDay = snapWorking(drag.origStart + drag.deltaDays, drag.deltaDays < 0 ? -1 : 1);
        newFinishDay = newStartDay + (r.finishDay - r.startDay);
        tipText = 'Start: ' + Cal.fmt(newStartDay);
      } else {
        var newDur = Math.max(1, drag.origDur + drag.deltaDays);
        newStartDay = r.startDay;
        newFinishDay = idxToDay(r.es + newDur - 1); // exact working-day finish
        tipText = 'Duration: ' + newDur + (newDur === 1 ? ' day' : ' days');
      }
      var gx = xOf(scale, newStartDay);
      var gx2 = xOf(scale, newFinishDay) + scale.dayWidth;
      var gw = Math.max(gx2 - gx, 3);
      var ghost = drag.kind === 'milestone'
        ? '<rect class="ghost" x="' + (xOf(scale, newStartDay)) + '" y="' + (yMid - 8) + '" width="' + scale.dayWidth + '" height="16"/>'
        : '<rect class="ghost" x="' + gx + '" y="' + (yMid - BAR_H / 2) + '" width="' + gw + '" height="' + BAR_H + '"/>';
      ghostLayer.innerHTML = ghost;
      drag.tip.textContent = tipText;
      drag.tip.style.left = (gx + 4) + 'px';
      drag.tip.style.top = (i * ROW_H - 6) + 'px';
      drag.tip.style.display = 'block';
    }
    function onUp() {
      if (!drag) return;
      var d = drag; drag = null;
      if (d.tip && d.tip.parentNode) d.tip.parentNode.removeChild(d.tip);
      if (d.mode === 'link') {
        var gl = svg.querySelector('.ghost-layer');
        if (gl) gl.innerHTML = '';
        svg.querySelectorAll('.bar-group.link-target').forEach(function (g) { g.classList.remove('link-target'); });
        if (d.targetId != null && opts.onLink) opts.onLink(d.fromId, d.targetId);
        return;
      }
      if (!d.moved || d.deltaDays === 0) { opts.onSelect(d.id, d.mods); return; } // click = select
      if (d.mode === 'move') opts.onMove(d.id, snapWorking(d.origStart + d.deltaDays, d.deltaDays < 0 ? -1 : 1));
      else opts.onResize(d.id, Math.max(1, d.origDur + d.deltaDays));
    }
  }

  function render(headerEl, bodyEl, model, opts) {
    if (bodyEl._ganttCleanup) { try { bodyEl._ganttCleanup(); } catch (e) {} }
    var computed = model.getComputed();
    var zoom = (model.getProject().view && model.getProject().view.zoom) || 'week';
    var scale = buildScale(computed, zoom);
    renderHeader(headerEl, computed, scale, zoom);
    renderBody(bodyEl, model, scale, opts);
    return scale;
  }

  return { render: render, ROW_H: ROW_H, HEADER_H: HEADER_H, ZOOM: ZOOM };
}));
