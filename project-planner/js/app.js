/*
 * app.js — controller. Owns selection + view state, wires the toolbar, grid,
 * gantt, keyboard, splitter, scroll-sync, file open/save, resources dialog,
 * and autosave to localStorage.
 */
(function () {
  'use strict';
  var PM = window.PM;
  var Cal = PM.Calendar;

  var model = PM.Model.createModel();
  var els = {};
  var selected = {};      // id -> true
  var anchorId = null;
  var scrollWired = false;
  var saveTimer = null;

  function $(id) { return document.getElementById(id); }
  function ids() { return Object.keys(selected).filter(function (k) { return selected[k]; }).map(Number); }

  function selectedInVisibleOrder() {
    var set = selected;
    return model.getVisibleRows().filter(function (r) { return set[r.id]; }).map(function (r) { return r.id; });
  }

  // ---- Selection ----
  function selectOnly(id) { selected = {}; if (id != null) selected[id] = true; anchorId = id; }
  function onSelect(id, mods) {
    if (mods && mods.shift && anchorId != null) {
      var rows = model.getVisibleRows();
      var ai = rows.findIndex(function (r) { return r.id === anchorId; });
      var bi = rows.findIndex(function (r) { return r.id === id; });
      if (ai >= 0 && bi >= 0) {
        selected = {};
        var lo = Math.min(ai, bi), hi = Math.max(ai, bi);
        for (var i = lo; i <= hi; i++) selected[rows[i].id] = true;
      }
    } else if (mods && mods.ctrl) {
      selected[id] = !selected[id];
      anchorId = id;
    } else {
      selectOnly(id);
    }
    refreshSelectionUI();
  }

  // Update selection highlight WITHOUT rebuilding the grid DOM — otherwise a
  // click (mousedown) would destroy the cell before a double-click can edit it.
  function refreshSelectionUI() {
    els.gridPane.querySelectorAll('tr.grid-row').forEach(function (tr) {
      tr.classList.toggle('selected', !!selected[+tr.getAttribute('data-id')]);
    });
    var gb = els.ganttBody, gh = els.ganttHeader;
    var gTop = gb.scrollTop, gLeft = gb.scrollLeft;
    PM.Gantt.render(gh, gb, model, { selected: selected, onSelect: onSelect, onMove: onGanttMove, onResize: onGanttResize });
    gb.scrollTop = gTop; gb.scrollLeft = gLeft; gh.scrollLeft = gLeft;
  }

  // ---- Editing ----
  function onEdit(id, field, value, moveTo) {
    model.setField(id, field, value);
    render();
    if (!moveTo) return;
    var rows = model.getVisibleRows();
    if (moveTo === 'down') {
      var idx = rows.findIndex(function (r) { return r.id === id; });
      var next = rows[idx + 1];
      if (next) { selectOnly(next.id); render(); els.gridPane._startEditCell(next.id, field); }
    } else if (moveTo === 'right' || moveTo === 'left') {
      var keys = ['name', 'duration', 'start', 'predecessors', 'resources', 'percentComplete', 'deadline'];
      var ci = keys.indexOf(field);
      var nci = ci + (moveTo === 'right' ? 1 : -1);
      if (nci >= 0 && nci < keys.length) els.gridPane._startEditCell(id, keys[nci]);
    }
  }

  function onToggleCollapse(id) { model.toggleCollapse(id); render(); }

  function rowById(id) { return model.getComputed().rows.filter(function (r) { return r.id === id; })[0]; }
  function onGanttMove(id, startDay) {
    model.setField(id, 'start', Cal.toISO(startDay));
    render();
  }
  function onGanttResize(id, newDur) {
    model.setField(id, 'duration', String(Math.max(1, Math.round(newDur))));
    render();
  }

  // ---- Render ----
  function render() {
    var gp = els.gridPane, gb = els.ganttBody, gh = els.ganttHeader;
    var sTop = gp.scrollTop, sLeft = gp.scrollLeft, gTop = gb.scrollTop, gLeft = gb.scrollLeft;

    PM.Grid.render(gp, model, { selected: selected, onSelect: onSelect, onEdit: onEdit, onToggleCollapse: onToggleCollapse });
    PM.Gantt.render(gh, gb, model, { selected: selected, onSelect: onSelect, onMove: onGanttMove, onResize: onGanttResize });

    gp.scrollTop = sTop; gp.scrollLeft = sLeft; gb.scrollTop = gTop; gb.scrollLeft = gLeft; gh.scrollLeft = gLeft;

    updateChrome();
    if (!scrollWired) wireScroll();
    scheduleSave();
  }

  function updateChrome() {
    var p = model.getProject();
    var c = model.getComputed();
    if (document.activeElement !== els.projName) els.projName.value = p.name;
    if (document.activeElement !== els.projStart) els.projStart.value = p.startISO;

    ['day', 'week', 'month'].forEach(function (z) {
      $('zoom' + z.charAt(0).toUpperCase() + z.slice(1)).classList.toggle('active', p.view.zoom === z);
    });
    els.btnUndo.disabled = !model.canUndo();
    els.btnRedo.disabled = !model.canRedo();

    var leaves = c.rows.filter(function (r) { return !r.isSummary; });
    var totalDur = leaves.reduce(function (a, r) { return a + (r.isMilestone ? 0 : r.durationDays); }, 0);
    var work = leaves.reduce(function (a, r) { return a + (r.isMilestone ? 0 : r.durationDays) * r.percentComplete; }, 0);
    var pct = totalDur > 0 ? Math.round(work / totalDur) : 0;
    var critCount = leaves.filter(function (r) { return r.critical; }).length;

    $('stTasks').textContent = c.rows.length + (c.rows.length === 1 ? ' task' : ' tasks');
    $('stFinish').textContent = c.rows.length ? ('Finish ' + Cal.fmtLong(c.projectEndDay)) : 'Finish —';
    $('stDuration').textContent = c.projectFinish + ' working days';
    $('stProgress').textContent = pct + '% complete';
    $('stCritical').textContent = critCount + ' critical';
    $('stCost').textContent = model.formatMoney(c.projectCost || 0);

    var warns = [];
    if (c.hasCycle) warns.push('⚠ Circular dependency — schedule may be incomplete');
    if (c.overallocatedCount) warns.push('⚠ ' + c.overallocatedCount + ' resource' + (c.overallocatedCount === 1 ? '' : 's') + ' overallocated');
    if (c.missedDeadlines) warns.push('⚠ ' + c.missedDeadlines + ' deadline' + (c.missedDeadlines === 1 ? '' : 's') + ' missed');
    els.stWarn.hidden = !warns.length;
    els.stWarn.textContent = warns.join('   ');
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      if (model.saveLocal()) {
        els.stSaved.textContent = 'Saved ✓';
        setTimeout(function () { els.stSaved.textContent = ''; }, 1200);
      }
    }, 400);
  }

  // ---- Scroll sync ----
  function wireScroll() {
    scrollWired = true;
    var gp = els.gridPane, gb = els.ganttBody, gh = els.ganttHeader;
    var lock = false;
    gp.addEventListener('scroll', function () {
      if (lock) return; lock = true;
      gb.scrollTop = gp.scrollTop;
      lock = false;
    });
    gb.addEventListener('scroll', function () {
      gh.scrollLeft = gb.scrollLeft;
      if (lock) return; lock = true;
      gp.scrollTop = gb.scrollTop;
      lock = false;
    });
  }

  // ---- Toolbar actions ----
  function doIndent() { var s = selectedInVisibleOrder(); if (s.length) { model.indent(s); render(); } }
  function doOutdent() { var s = selectedInVisibleOrder(); if (s.length) { model.outdent(s); render(); } }
  function doDelete() {
    var s = ids(); if (!s.length) return;
    model.deleteTasks(s);
    selected = {}; anchorId = null;
    render();
  }
  function doAdd() {
    var id = model.addTaskEnd();
    selectOnly(id); render();
    els.gridPane._startEditFirst(id);
  }
  function doInsert() {
    var s = selectedInVisibleOrder();
    var at = s.length ? model.findIndexById(s[0]) : model.getProject().tasks.length;
    var id = model.insertTask(at, null);
    selectOnly(id); render();
    els.gridPane._startEditFirst(id);
  }
  function doMove(dir) {
    var s = selectedInVisibleOrder(); if (!s.length) return;
    model.moveBlock(s[0], dir); render();
  }
  function doLink() { var s = selectedInVisibleOrder(); if (s.length >= 2) { model.linkTasks(s); render(); } }
  function doUnlink() { var s = selectedInVisibleOrder(); if (s.length) { model.unlinkTasks(s); render(); } }
  function setZoom(z) { model.setZoom(z); render(); }

  function scrollToToday() {
    var c = model.getComputed();
    var scale = PM.Gantt.render(els.ganttHeader, els.ganttBody, model,
      { selected: selected, onSelect: onSelect, onMove: onGanttMove, onResize: onGanttResize });
    var today = Cal.todayDayNum();
    var x = (today - scale.t0) * scale.dayWidth - els.ganttBody.clientWidth / 2;
    els.ganttBody.scrollLeft = Math.max(0, x);
    els.ganttHeader.scrollLeft = els.ganttBody.scrollLeft;
  }

  // ---- File open/save ----
  function saveFile() {
    var data = JSON.stringify(model.toJSON(), null, 2);
    var blob = new Blob([data], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var name = (model.getProject().name || 'project').replace(/[^\w.-]+/g, '_');
    a.href = url; a.download = name + '.json';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function exportCSV() {
    var blob = new Blob([model.toCSV()], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var name = (model.getProject().name || 'project').replace(/[^\w.-]+/g, '_');
    a.href = url; a.download = name + '.csv';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function openFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(reader.result);
        model.loadProject(obj);
        selected = {}; anchorId = null;
        render();
      } catch (e) { alert('Could not read that file: ' + e.message); }
    };
    reader.readAsText(file);
  }

  // ---- Resources dialog ----
  function openResources() {
    renderResTable();
    els.resModal.hidden = false;
    els.resNewName.value = '';
    els.resNewName.focus();
  }
  function renderResTable() {
    var p = model.getProject();
    var html = '<thead><tr><th></th><th>Name</th><th>Init.</th><th>Rate/day</th><th>Assigned</th><th></th></tr></thead><tbody>';
    var counts = {};
    p.tasks.forEach(function (t) { t.resourceIds.forEach(function (rid) { counts[rid] = (counts[rid] || 0) + 1; }); });
    p.resources.forEach(function (r) {
      html += '<tr data-rid="' + r.id + '">' +
        '<td><span class="res-swatch" style="background:' + PM.Grid.esc(r.color) + '"></span></td>' +
        '<td><input class="res-name-input" data-rid="' + r.id + '" value="' + PM.Grid.esc(r.name) + '"></td>' +
        '<td>' + PM.Grid.esc(r.initials) + '</td>' +
        '<td><input class="res-rate-input" data-rate="' + r.id + '" type="number" min="0" step="50" value="' + (isFinite(+r.rate) ? +r.rate : 0) + '"></td>' +
        '<td>' + (counts[r.id] || 0) + ' task' + ((counts[r.id] || 0) === 1 ? '' : 's') + '</td>' +
        '<td><button class="res-del" data-del="' + r.id + '" title="Delete">✕</button></td></tr>';
    });
    if (!p.resources.length) html += '<tr><td colspan="6" style="color:#888">No resources yet.</td></tr>';
    html += '</tbody>';
    els.resTable.innerHTML = html;

    els.resTable.querySelectorAll('.res-name-input').forEach(function (inp) {
      inp.addEventListener('change', function () {
        model.updateResource(parseInt(inp.getAttribute('data-rid'), 10), { name: inp.value, initials: initialsOf(inp.value) });
        render();
      });
    });
    els.resTable.querySelectorAll('.res-rate-input').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var v = parseFloat(inp.value);
        model.updateResource(parseInt(inp.getAttribute('data-rate'), 10), { rate: isFinite(v) ? Math.max(0, v) : 0 });
        render();
      });
    });
    els.resTable.querySelectorAll('.res-del').forEach(function (b) {
      b.addEventListener('click', function () {
        model.deleteResource(parseInt(b.getAttribute('data-del'), 10));
        renderResTable(); render();
      });
    });
  }
  function initialsOf(name) {
    var parts = String(name).split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  // ---- Splitter ----
  function wireSplitter() {
    var dragging = false, startX = 0, startW = 0;
    els.splitter.addEventListener('mousedown', function (e) {
      dragging = true; startX = e.clientX; startW = els.gridPane.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var w = Math.max(220, Math.min(startW + (e.clientX - startX), window.innerWidth - 260));
      els.gridPane.style.width = w + 'px';
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
    });
  }

  // ---- Keyboard ----
  function wireKeyboard() {
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      var ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); model.undo(); render(); return; }
      if (ctrl && ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) { e.preventDefault(); model.redo(); render(); return; }
      if (ctrl && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveFile(); return; }

      if (typing) return; // let fields handle their own keys

      if (ctrl && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); if (e.shiftKey) doUnlink(); else doLink(); return; }
      if (ctrl && e.key === 'Enter') { e.preventDefault(); doAdd(); return; }
      if (e.key === 'Insert') { e.preventDefault(); doInsert(); return; }
      if (e.key === 'Delete') { e.preventDefault(); doDelete(); return; }
      if (e.key === 'Tab') { e.preventDefault(); if (e.shiftKey) doOutdent(); else doIndent(); return; }
      if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); doMove(-1); return; }
      if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); doMove(1); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault(); moveSelection(e.key === 'ArrowDown' ? 1 : -1); return;
      }
      if (e.key === 'F2' || e.key === 'Enter') {
        var s = ids(); if (s.length) { e.preventDefault(); els.gridPane._startEditFirst(s[0]); }
      }
    });
  }
  function moveSelection(dir) {
    var rows = model.getVisibleRows(); if (!rows.length) return;
    var cur = ids()[0];
    var idx = cur != null ? rows.findIndex(function (r) { return r.id === cur; }) : -1;
    var ni = Math.max(0, Math.min(rows.length - 1, idx + dir));
    selectOnly(rows[ni].id); render();
    // keep selection in view
    var gp = els.gridPane;
    var tr = gp.querySelector('tr[data-id="' + rows[ni].id + '"]');
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }

  // ---- Wire toolbar ----
  function wireToolbar() {
    els.btnNew.onclick = function () { if (confirm('Start a new empty project? Unsaved local changes are kept in your browser until overwritten.')) { model.newProject(); selected = {}; render(); } };
    els.btnOpen.onclick = function () { els.fileInput.click(); };
    els.fileInput.onchange = function () { if (els.fileInput.files[0]) openFile(els.fileInput.files[0]); els.fileInput.value = ''; };
    els.btnSave.onclick = saveFile;
    els.btnExport.onclick = exportCSV;
    els.btnSample.onclick = function () { model.loadSample(); selected = {}; render(); };
    els.btnUndo.onclick = function () { model.undo(); render(); };
    els.btnRedo.onclick = function () { model.redo(); render(); };
    els.btnAdd.onclick = doAdd;
    els.btnInsert.onclick = doInsert;
    els.btnDelete.onclick = doDelete;
    els.btnIndent.onclick = doIndent;
    els.btnOutdent.onclick = doOutdent;
    els.btnUp.onclick = function () { doMove(-1); };
    els.btnDown.onclick = function () { doMove(1); };
    els.btnLink.onclick = doLink;
    els.btnUnlink.onclick = doUnlink;
    els.btnCollapse.onclick = function () { model.setAllCollapsed(true); render(); };
    els.btnExpand.onclick = function () { model.setAllCollapsed(false); render(); };
    els.btnToday.onclick = scrollToToday;
    document.querySelectorAll('.zoombtn').forEach(function (b) { b.onclick = function () { setZoom(b.getAttribute('data-zoom')); }; });
    els.btnBaseline.onclick = function () {
      if (model.getProject().baseline) { if (confirm('Replace the existing baseline?')) model.saveBaseline(); }
      else model.saveBaseline();
      render();
    };
    els.btnResources.onclick = openResources;
    els.resClose.onclick = function () { els.resModal.hidden = true; };
    els.resModal.onclick = function (e) { if (e.target === els.resModal) els.resModal.hidden = true; };
    els.resAddBtn.onclick = function () {
      var name = els.resNewName.value.trim(); if (!name) return;
      model.addResource(name); els.resNewName.value = ''; renderResTable(); render();
    };
    els.resNewName.onkeydown = function (e) { if (e.key === 'Enter') els.resAddBtn.click(); };

    els.projName.onchange = function () { model.setProjectName(els.projName.value); };
    els.projStart.onchange = function () { if (els.projStart.value) { model.setProjectStart(els.projStart.value); render(); } };

    $('hintClose').onclick = function () { $('hint').style.display = 'none'; };
  }

  // ---- Init ----
  function init() {
    ['gridPane', 'ganttPane', 'ganttHeader', 'ganttBody', 'splitter', 'projName', 'projStart',
      'btnNew', 'btnOpen', 'btnSave', 'btnExport', 'btnSample', 'fileInput', 'btnUndo', 'btnRedo',
      'btnAdd', 'btnInsert', 'btnDelete', 'btnIndent', 'btnOutdent', 'btnUp', 'btnDown',
      'btnLink', 'btnUnlink', 'btnCollapse', 'btnExpand', 'btnToday', 'btnBaseline', 'btnResources',
      'resModal', 'resClose', 'resTable', 'resNewName', 'resAddBtn', 'stWarn', 'stSaved'
    ].forEach(function (id) { els[id] = $(id); });

    model.init();
    wireToolbar();
    wireSplitter();
    wireKeyboard();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
