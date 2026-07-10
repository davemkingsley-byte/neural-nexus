/*
 * app.js — controller. Owns selection + view state, wires the toolbar, grid,
 * gantt, keyboard, splitter, scroll-sync, file open/save, resources dialog,
 * and storage. Storage runs in one of two modes:
 *   server mode — when served by server.js: the project (named by ?project=,
 *     default "current") lives on the server; autosave PUTs with If-Match so
 *     concurrent edits 409 instead of clobbering; a 2s poll of /rev picks up
 *     external edits (CLI / AI) live. View state (zoom, collapse) never syncs.
 *   local mode — file:// or no server: localStorage, as before.
 */
(function () {
  'use strict';
  var PM = window.PM;
  var Cal = PM.Calendar;

  var model = PM.Model.createModel();
  var els = {};
  var selected = {};      // id -> true
  var anchorId = null;
  var cursorKey = 'name'; // spreadsheet cell-cursor column
  var NAV_COLS = ['name', 'duration', 'start', 'predecessors', 'resources', 'percentComplete', 'actualStart', 'actualFinish', 'deadline'];
  var scrollWired = false;
  var saveTimer = null;

  var PROJECT_NAME = (function () {
    try {
      var v = new URLSearchParams(window.location.search).get('project');
      return (v && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v)) ? v : 'current';
    } catch (e) { return 'current'; }
  })();

  // Sync engine state — lives here, never inside the project document, so a
  // poll reload can never desync the accounting (see HARNESS.md).
  var sync = {
    server: false,   // server detected via /api/ping
    ready: false,    // initial GET/migration finished; PUTs allowed
    rev: 0,          // last server rev whose content we hold
    lastPushed: null,// serialized content of that rev (echo suppression)
    dirty: false,
    inFlight: false,
    pending: false,  // a change landed while a PUT was in flight
    applyingRemote: false,
    pollTimer: null,
    identity: null   // {email, role} from /api/me (null in local mode)
  };

  function apiPath(sub) {
    return '/api/projects/' + encodeURIComponent(PROJECT_NAME) + (sub ? '/' + sub : '');
  }

  // Content that syncs: everything except per-user view state and the
  // server-owned rev. Compared as a string for echo suppression.
  function serverDocString() {
    var d = model.toJSON();
    delete d.view;
    delete d.rev;
    delete d.lastEditor;   // server-owned write metadata
    delete d.lastEditISO;
    (d.tasks || []).forEach(function (t) { delete t.collapsed; });
    return JSON.stringify(d);
  }

  function isViewer() { return sync.identity && sync.identity.role === 'viewer'; }

  function $(id) { return document.getElementById(id); }
  function ids() { return Object.keys(selected).filter(function (k) { return selected[k]; }).map(Number); }

  function selectedInVisibleOrder() {
    var set = selected;
    return model.getVisibleRows().filter(function (r) { return set[r.id]; }).map(function (r) { return r.id; });
  }

  // ---- Selection ----
  function selectOnly(id) { selected = {}; if (id != null) selected[id] = true; anchorId = id; }
  function onSelect(id, mods, colKey) {
    if (colKey && NAV_COLS.indexOf(colKey) >= 0) cursorKey = colKey;
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

  function gridOpts() {
    return {
      selected: selected,
      readOnly: isViewer(),
      cursor: anchorId != null ? { id: anchorId, key: cursorKey } : null,
      onSelect: onSelect, onEdit: onEdit, onToggleCollapse: onToggleCollapse,
      onOpenDetails: openTaskDialog
    };
  }
  function ganttOpts() {
    return {
      selected: selected, readOnly: isViewer(), onSelect: onSelect,
      onMove: onGanttMove, onResize: onGanttResize, onLink: onGanttLink
    };
  }

  // Update selection highlight WITHOUT rebuilding the grid DOM — otherwise a
  // click (mousedown) would destroy the cell before a double-click can edit it.
  function refreshSelectionUI() {
    els.gridPane.querySelectorAll('tr.grid-row').forEach(function (tr) {
      tr.classList.toggle('selected', !!selected[+tr.getAttribute('data-id')]);
    });
    refreshCursorUI();
    var gb = els.ganttBody, gh = els.ganttHeader;
    var gTop = gb.scrollTop, gLeft = gb.scrollLeft;
    PM.Gantt.render(gh, gb, model, ganttOpts());
    gb.scrollTop = gTop; gb.scrollLeft = gLeft; gh.scrollLeft = gLeft;
  }

  function refreshCursorUI() {
    els.gridPane.querySelectorAll('td.cell-cursor').forEach(function (td) { td.classList.remove('cell-cursor'); });
    if (anchorId == null) return;
    var td = els.gridPane.querySelector('tr[data-id="' + anchorId + '"] td[data-key="' + cursorKey + '"]');
    if (td) td.classList.add('cell-cursor');
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
      if (next) {
        selectOnly(next.id); cursorKey = field; render();
        els.gridPane._startEditCell(next.id, field);
      } else if (field === 'name' && String(value).trim()) {
        // Rapid entry: Enter on the last row's name appends the next task.
        ensureNewTaskVisible();
        var newId = model.addTaskEnd();
        selectOnly(newId); cursorKey = 'name'; render();
        els.gridPane._startEditCell(newId, 'name');
      }
    } else if (moveTo === 'right' || moveTo === 'left') {
      var ci = NAV_COLS.indexOf(field);
      var nci = ci + (moveTo === 'right' ? 1 : -1);
      if (nci >= 0 && nci < NAV_COLS.length) {
        cursorKey = NAV_COLS[nci];
        els.gridPane._startEditCell(id, NAV_COLS[nci]);
      }
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
  // Drag-to-link: append an FS dependency on the drop target.
  function onGanttLink(fromId, toId) {
    if (fromId === toId) return;
    var target = model.getProject().tasks[model.findIndexById(toId)];
    if (!target) return;
    var fromRow = model.findIndexById(fromId) + 1;
    if (fromRow < 1) return;
    if (target.predecessors.some(function (p) { return p.id === fromId; })) return; // already linked
    var hadCycle = model.getComputed().hasCycle; // pre-existing cycles are not this link's fault
    var existing = model.formatPredecessors(target.predecessors);
    model.setField(toId, 'predecessors', existing ? existing + ', ' + fromRow : String(fromRow));
    render();
    if (!hadCycle && model.getComputed().hasCycle) { // undo only a cycle THIS link introduced
      model.undo(); render();
      toast('That link would create a circular dependency — not added.');
    }
  }

  // ---- Render ----
  function render() {
    var gp = els.gridPane, gb = els.ganttBody, gh = els.ganttHeader;
    var sTop = gp.scrollTop, sLeft = gp.scrollLeft, gTop = gb.scrollTop, gLeft = gb.scrollLeft;

    PM.Grid.render(gp, model, gridOpts());
    PM.Gantt.render(gh, gb, model, ganttOpts());

    gp.scrollTop = sTop; gp.scrollLeft = sLeft; gb.scrollTop = gTop; gb.scrollLeft = gLeft; gh.scrollLeft = gLeft;

    updateChrome();
    if (!scrollWired) wireScroll();
    // NOTE: no save here — autosave is subscribe-driven (model.subscribe in
    // init), so re-renders (incl. remote reloads) never trigger writes.
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
    els.btnBaseline.textContent = p.baseline ? ('Baseline ✓ ' + (p.baseline.savedISO || '')) : 'Set Baseline';
    els.btnBaselineClear.hidden = !p.baseline;
    if (els.filterSel.value !== (model.getFilter() || '')) els.filterSel.value = model.getFilter() || '';

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

    var rs = c.riskSummary || {};
    var stRisksEl = $('stRisks');
    if (stRisksEl) stRisksEl.textContent = (rs.open || rs.mitigating) ? ((rs.open || 0) + (rs.mitigating || 0)) + ' active risks (exp ' + (rs.exposure || 0) + ')' : 'no active risks';

    var warns = [];
    if (c.hasCycle) warns.push('⚠ Circular dependency — schedule may be incomplete');
    if (c.constraintConflicts) warns.push('⚠ ' + c.constraintConflicts + ' Must-Start-On pin' + (c.constraintConflicts === 1 ? '' : 's') + ' violate' + (c.constraintConflicts === 1 ? 's' : '') + ' dependencies');
    if (c.overallocatedCount) warns.push('⚠ ' + c.overallocatedCount + ' resource' + (c.overallocatedCount === 1 ? '' : 's') + ' overallocated');
    if (c.missedDeadlines) warns.push('⚠ ' + c.missedDeadlines + ' deadline' + (c.missedDeadlines === 1 ? '' : 's') + ' missed');
    if (rs.critical) warns.push('⚠ ' + rs.critical + ' CRITICAL risk' + (rs.critical === 1 ? '' : 's') + ' open');
    if (c.behindCount) warns.push('⚠ ' + c.behindCount + ' task' + (c.behindCount === 1 ? '' : 's') + ' behind schedule');
    els.stWarn.hidden = !warns.length;
    els.stWarn.textContent = warns.join('   ');
  }

  // ---- Storage / sync engine ----
  function setSyncStatus(text, isError) {
    els.stSaved.textContent = text;
    els.stSaved.classList.toggle('st-error', !!isError);
  }

  function toast(msg) {
    if (window.console && console.info) console.info('[projectdesk] toast: ' + msg);
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 400);
    }, 4000);
  }

  // True while the user is mid-interaction: an open cell editor or any dialog.
  // Remote reloads must never yank the DOM out from under these.
  function uiBusy() {
    return !!document.querySelector('.cell-input') ||
      (els.resModal && !els.resModal.hidden) ||
      (els.taskModal && !els.taskModal.hidden) ||
      (els.calModal && !els.calModal.hidden) ||
      (els.riskModal && !els.riskModal.hidden) ||
      (els.histModal && !els.histModal.hidden);
  }

  // Every real model mutation lands here (model.subscribe). Remote applies are
  // masked by sync.applyingRemote so they never write back.
  function onModelChanged() {
    if (sync.applyingRemote) return;
    model.saveLocal(); // offline backup in both modes
    sync.dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(doSaveNow, 400);
  }

  function doSaveNow() {
    if (isViewer()) return; // view-only accounts never write (server 403s anyway)
    if (!sync.server || !sync.ready) {
      if (!sync.server) setSyncStatus('Saved locally ✓');
      return;
    }
    if (sync.inFlight) { sync.pending = true; return; }
    var content = serverDocString();
    if (content === sync.lastPushed) { sync.dirty = false; setSyncStatus('Synced ✓ (rev ' + sync.rev + ')'); return; }
    sync.inFlight = true;
    var headers = { 'Content-Type': 'application/json' };
    if (sync.rev > 0) headers['If-Match'] = String(sync.rev);
    fetch(apiPath(), { method: 'PUT', headers: headers, body: content })
      .then(function (r) {
        if (r.status === 409) return r.json().then(function (j) { throw { conflict: true, rev: j && j.rev }; });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        sync.inFlight = false;
        sync.rev = Math.max(sync.rev, (j && j.rev) || 0);
        sync.lastPushed = content;
        // Only clean if nothing changed mid-flight — otherwise the follow-up
        // PUT could fail and a dirty=false would strand that edit locally.
        sync.dirty = (serverDocString() !== content);
        setSyncStatus('Synced ✓ (rev ' + sync.rev + ')');
        if (sync.pending) { sync.pending = false; doSaveNow(); }
      })
      .catch(function (e) {
        sync.pending = false;
        if (e && e.conflict) {
          if (uiBusy()) {
            // Don't destroy an open editor/dialog: our content lost the
            // conflict, so stop re-PUTting and let the poll adopt the server
            // version as soon as the user finishes interacting.
            sync.inFlight = false;
            sync.dirty = false;
            setSyncStatus('Server version changed — will reload when you finish editing', true);
          } else {
            // Keep inFlight=true through the adopt so the poll's dirty-retry
            // can't fire a second stale PUT into the 409→adopt window.
            adoptServerDoc('Plan changed externally — reloaded the latest version (your last edit was not saved)');
          }
        } else {
          sync.inFlight = false;
          sync.dirty = true; // ensure the poll's offline retry re-sends
          setSyncStatus('Offline — saved locally', true); // poll retries when back
        }
      });
  }

  function adoptServerDoc(toastMsg) {
    sync.inFlight = true;
    fetch(apiPath())
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (doc) {
        sync.inFlight = false;
        applyRemote(doc);
        if (toastMsg) toast(toastMsg);
      })
      .catch(function () {
        sync.inFlight = false;
        setSyncStatus('Offline — saved locally', true);
      });
  }

  // Replace local content with a server document, preserving per-user view
  // state (zoom, collapse) and the selection where task ids survive.
  function applyRemote(doc) {
    var prev = model.getProject();
    var savedView = prev ? prev.view : null;
    var savedCollapsed = {};
    if (prev) prev.tasks.forEach(function (t) { savedCollapsed[t.id] = t.collapsed; });
    var savedSel = ids();

    sync.applyingRemote = true;
    try { model.loadProject(doc); } finally { sync.applyingRemote = false; }

    var p = model.getProject();
    if (savedView) p.view = savedView;
    p.tasks.forEach(function (t) { if (savedCollapsed[t.id] != null) t.collapsed = savedCollapsed[t.id]; });

    sync.rev = doc.rev || 0;
    sync.lastPushed = serverDocString();
    sync.dirty = false;
    model.saveLocal();

    selected = {};
    savedSel.forEach(function (id) { if (model.findIndexById(id) >= 0) selected[id] = true; });
    render();
    setSyncStatus('Synced ✓ (rev ' + sync.rev + ')');
  }

  function startPoll() {
    if (sync.pollTimer) clearInterval(sync.pollTimer);
    sync.pollTimer = setInterval(function () {
      if (!sync.server || !sync.ready) return;
      if (sync.dirty && !sync.inFlight) { doSaveNow(); return; } // offline retry
      if (sync.dirty || sync.inFlight) return;
      if (uiBusy()) return; // never reload under an editor or open dialog
      fetch(apiPath('rev'))
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          if (j && typeof j.rev === 'number' && j.rev > sync.rev) {
            return fetch(apiPath()).then(function (r) { return r.json(); }).then(function (doc) {
              // Re-check: an edit or interaction may have started during the
              // async GETs — adopting now would discard it / yank the DOM.
              if (sync.dirty || sync.inFlight || uiBusy()) return;
              applyRemote(doc);
              toast('Plan updated externally (rev ' + (doc.rev || '?') + ') — undo history reset');
            });
          }
        })
        .catch(function () { /* transient; next tick retries */ });
    }, 2000);
  }

  // Flush a pending debounced save before the page goes away (switcher
  // navigation, tab close). sendBeacon survives navigation; the server
  // accepts it as an unconditional save (a beacon can't carry If-Match).
  function flushBeforeNavigate() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (isViewer()) return;
    if (!sync.server || !sync.ready || !sync.dirty) return;
    var content = serverDocString();
    if (content === sync.lastPushed) return;
    try {
      navigator.sendBeacon(apiPath(), new Blob([content], { type: 'application/json' }));
    } catch (e) { /* best effort — localStorage still has it */ }
  }

  // ---- Viewer (read-only) mode ----
  function setWhoami(text) {
    var el = document.getElementById('stWhoami');
    if (el) el.textContent = text;
  }

  function applyViewerMode(me) {
    document.body.classList.add('viewer-mode');
    setWhoami('👁 ' + me.email + ' — view only');
    // Disable direct project-field editing; all other guards check isViewer().
    els.projName.disabled = true;
    els.projStart.disabled = true;
    els.projDelete.hidden = true;
    toast('Signed in as ' + me.email + ' (view-only) — you see live updates, editing is disabled');
  }

  // ---- Project switcher (server mode only) ----
  function populateProjectSwitcher() {
    if (!sync.server) return;
    fetch('/api/projects')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (list) {
        var sel = els.projSelect;
        sel.innerHTML = '';
        var names = list.map(function (p) { return p.name; });
        if (names.indexOf(PROJECT_NAME) < 0) names.unshift(PROJECT_NAME);
        names.forEach(function (n) {
          var opt = document.createElement('option');
          var meta = list.filter(function (p) { return p.name === n; })[0];
          opt.value = n;
          opt.textContent = n + (meta && meta.taskCount != null ? ' (' + meta.taskCount + ')' : '');
          sel.appendChild(opt);
        });
        var newOpt = document.createElement('option');
        newOpt.value = '__new__';
        newOpt.textContent = '＋ New project…';
        sel.appendChild(newOpt);
        sel.value = PROJECT_NAME;
        sel.hidden = false;
        els.projDelete.hidden = false;
      })
      .catch(function () { /* switcher is optional chrome */ });
  }

  function wireProjectSwitcher() {
    // Refresh the list every time the user opens the dropdown, so projects
    // created elsewhere (CLI/AI) show up without a page reload.
    els.projSelect.onmousedown = function () { populateProjectSwitcher(); };
    els.projSelect.onchange = function () {
      var v = els.projSelect.value;
      if (v === '__new__') {
        var name = prompt('New project name (letters, numbers, - and _):');
        els.projSelect.value = PROJECT_NAME;
        if (!name) return;
        name = name.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) { alert('Invalid name — use letters, numbers, dashes.'); return; }
        flushBeforeNavigate();
        window.location.search = '?project=' + encodeURIComponent(name);
        return;
      }
      if (v !== PROJECT_NAME) {
        flushBeforeNavigate();
        window.location.search = '?project=' + encodeURIComponent(v);
      }
    };
    els.projDelete.onclick = function () {
      if (!sync.server) return;
      if (!confirm('Delete project "' + PROJECT_NAME + '" from the server? The file is removed (git history is your backup).')) return;
      fetch(apiPath(), { method: 'DELETE' })
        .then(function () {
          try { localStorage.removeItem('projectdesk.' + PROJECT_NAME + '.v1'); } catch (e) { /* ignore */ }
          window.location.search = PROJECT_NAME === 'current' ? '' : '?project=current';
        })
        .catch(function () { alert('Delete failed — is the server running?'); });
    };
  }

  function bootstrapStorage() {
    // Instant local render first (works on file:// with no server at all).
    if (!model.loadLocal()) {
      if (PROJECT_NAME === 'current') model.loadSample(); else model.newProject();
    }
    render();

    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeout = ctl ? setTimeout(function () { ctl.abort(); }, 1500) : null;
    fetch('/api/ping', ctl ? { signal: ctl.signal } : {})
      .then(function (r) { if (timeout) clearTimeout(timeout); if (!r.ok) throw new Error('no server'); return r.json(); })
      .then(function (j) {
        if (!j || j.service !== 'projectdesk') throw new Error('not projectdesk');
        sync.server = true;
        els.btnHistory.hidden = false;
        populateProjectSwitcher();
        // Identity + role (viewer accounts get read-only chrome). Local mode
        // has no identity endpoint semantics beyond "editor".
        fetch('/api/me').then(function (r) { return r.ok ? r.json() : null; })
          .then(function (me) {
            if (me && me.role) {
              sync.identity = me;
              if (me.role === 'viewer') applyViewerMode(me);
              else if (me.remote) setWhoami('Signed in as ' + me.email);
            }
          }).catch(function () { /* identity is optional chrome */ });
        return fetch(apiPath()).then(function (r) {
          if (r.status === 404) {
            // First contact for this project: push the local state up.
            if (PROJECT_NAME !== 'current') model.setProjectName(PROJECT_NAME);
            sync.ready = true;
            sync.dirty = true;
            doSaveNow();
            startPoll();
            return;
          }
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json().then(function (doc) {
            applyRemote(doc);
            sync.ready = true;
            startPoll();
          });
        });
      })
      .catch(function () {
        sync.server = false;
        setSyncStatus('Local mode (no server) — saved in this browser');
      });
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
  // A task added while a view filter is active would be born invisible (and
  // its edit-start would silently no-op) — clear the filter first.
  function ensureNewTaskVisible() {
    if (model.getFilter()) {
      model.setFilter(null);
      toast('Filter cleared to show the new task');
    }
  }
  function doAdd() {
    ensureNewTaskVisible();
    var id = model.addTaskEnd();
    selectOnly(id); render();
    els.gridPane._startEditFirst(id);
  }
  function doInsert() {
    ensureNewTaskVisible();
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
    var scale = PM.Gantt.render(els.ganttHeader, els.ganttBody, model, ganttOpts());
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

      // While a dialog is open, grid shortcuts must not act on the background
      // selection (Delete/Insert/undo would corrupt what the dialog shows).
      var modalOpen = (els.taskModal && !els.taskModal.hidden) ||
        (els.calModal && !els.calModal.hidden) || (els.resModal && !els.resModal.hidden) ||
        (els.riskModal && !els.riskModal.hidden) ||
      (els.histModal && !els.histModal.hidden);
      if (modalOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeTaskDialog();
          els.calModal.hidden = true;
          els.resModal.hidden = true;
          els.riskModal.hidden = true;
          els.histModal.hidden = true;
        }
        return;
      }

      // View-only accounts: navigation and selection only.
      if (isViewer() && !typing) {
        var navOk = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Escape'].indexOf(e.key) >= 0;
        if (e.key === 'Tab' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault(); moveCursorCol(e.key === 'ArrowLeft' || e.shiftKey ? -1 : 1); return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault(); moveSelection(e.key === 'ArrowDown' ? 1 : -1); return;
        }
        if (!navOk && !ctrl) e.preventDefault();
        return;
      }

      if (ctrl && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); model.undo(); render(); return; }
      if (ctrl && ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) { e.preventDefault(); model.redo(); render(); return; }
      if (ctrl && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveFile(); return; }

      if (typing) return; // let fields handle their own keys

      if (ctrl && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); if (e.shiftKey) doUnlink(); else doLink(); return; }
      if (ctrl && e.key === 'Enter') { e.preventDefault(); doAdd(); return; }
      if (e.key === 'Insert') { e.preventDefault(); doInsert(); return; }
      if (e.key === 'Delete') { e.preventDefault(); doDelete(); return; }
      // MS Project bindings: Alt+Shift+arrows indent/outdent; Tab moves the cell cursor.
      if (e.altKey && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); doIndent(); return; }
      if (e.altKey && e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); doOutdent(); return; }
      if (e.key === 'Tab') { e.preventDefault(); moveCursorCol(e.shiftKey ? -1 : 1); return; }
      if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); doMove(-1); return; }
      if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); doMove(1); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault(); moveCursorCol(e.key === 'ArrowRight' ? 1 : -1); return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault(); moveSelection(e.key === 'ArrowDown' ? 1 : -1); return;
      }
      if (e.key === 'F2' || e.key === 'Enter') {
        var s = ids(); if (s.length) { e.preventDefault(); els.gridPane._startEditCell(s[0], cursorKey); }
        return;
      }
      if (e.key === 'Escape') { hideContextMenu(); return; }
      // Type-to-edit: any printable character starts editing the cursor cell,
      // replacing its content (spreadsheet behavior).
      if (e.key.length === 1 && !ctrl && !e.altKey && !e.metaKey) {
        var sel = ids();
        if (sel.length === 1) {
          e.preventDefault();
          els.gridPane._startEditCell(sel[0], cursorKey, e.key);
        }
      }
    });
  }

  function moveCursorCol(dir) {
    var ci = NAV_COLS.indexOf(cursorKey);
    if (ci < 0) ci = 0;
    var ni = Math.max(0, Math.min(NAV_COLS.length - 1, ci + dir));
    cursorKey = NAV_COLS[ni];
    if (anchorId == null) {
      var rows = model.getVisibleRows();
      if (rows.length) selectOnly(rows[0].id);
    }
    refreshCursorUI();
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

  // ---- Context menu ----
  function hideContextMenu() { if (els.ctxMenu) els.ctxMenu.hidden = true; }

  function showContextMenu(x, y, id) {
    // Right-clicking a row outside the current selection selects it first.
    if (!selected[id]) { selectOnly(id); refreshSelectionUI(); }
    var multi = ids().length > 1;
    var items = isViewer() ? [
      { label: 'Task Information…', key: 'dbl-click #', fn: function () { openTaskDialog(id); } }
    ] : [
      { label: 'Task Information…', key: 'dbl-click #', fn: function () { openTaskDialog(id); } },
      { sep: true },
      { label: 'Insert Task Above', fn: function () { insertRelative(id, 'above'); } },
      { label: 'Insert Task Below', fn: function () { insertRelative(id, 'below'); } },
      { label: 'Add Child Task', fn: function () { insertRelative(id, 'child'); } },
      { sep: true },
      { label: 'Indent', key: 'Alt+Shift+→', fn: doIndent },
      { label: 'Outdent', key: 'Alt+Shift+←', fn: doOutdent },
      { sep: true },
      { label: 'Link Selected', key: 'Ctrl+L', disabled: !multi, fn: doLink },
      { label: 'Unlink Selected', key: 'Ctrl+Shift+L', fn: doUnlink },
      { sep: true },
      { label: multi ? 'Delete Tasks' : 'Delete Task', key: 'Del', fn: doDelete }
    ];
    var html = '';
    items.forEach(function (it, i) {
      if (it.sep) { html += '<div class="cm-sep"></div>'; return; }
      html += '<div class="cm-item' + (it.disabled ? ' disabled' : '') + '" data-i="' + i + '">' +
        PM.Grid.esc(it.label) + (it.key ? '<span class="cm-key">' + PM.Grid.esc(it.key) + '</span>' : '') + '</div>';
    });
    els.ctxMenu.innerHTML = html;
    els.ctxMenu.hidden = false;
    // Clamp inside the viewport.
    var mw = els.ctxMenu.offsetWidth, mh = els.ctxMenu.offsetHeight;
    els.ctxMenu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
    els.ctxMenu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
    els.ctxMenu.querySelectorAll('.cm-item').forEach(function (el) {
      el.onmousedown = function (ev) {
        ev.preventDefault();
        var it = items[+el.getAttribute('data-i')];
        hideContextMenu();
        if (it && !it.disabled) it.fn();
      };
    });
  }

  function insertRelative(id, where) {
    var i = model.findIndexById(id);
    if (i < 0) return;
    ensureNewTaskVisible();
    var t = model.getProject().tasks[i];
    // Adding a child under a collapsed summary would create an invisible row —
    // expand the parent first so the new task can be seen and edited.
    if (where === 'child' && t.collapsed) model.toggleCollapse(id);
    var newId;
    if (where === 'above') newId = model.insertTask(i, t.outlineLevel);
    else if (where === 'below') newId = model.insertTask(i + 1, t.outlineLevel);
    else newId = model.insertTask(i + 1, t.outlineLevel + 1); // child
    selectOnly(newId); cursorKey = 'name'; render();
    els.gridPane._startEditFirst(newId);
  }

  function wireContextMenu() {
    els.gridPane.addEventListener('contextmenu', function (e) {
      var tr = e.target.closest('tr.grid-row');
      if (!tr) return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, parseInt(tr.getAttribute('data-id'), 10));
    });
    els.ganttBody.addEventListener('contextmenu', function (e) {
      var grp = e.target.closest && e.target.closest('.bar-group');
      if (!grp) return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, parseInt(grp.getAttribute('data-bar-id'), 10));
    });
    document.addEventListener('mousedown', function (e) {
      if (!els.ctxMenu.hidden && !e.target.closest('.context-menu')) hideContextMenu();
    });
    window.addEventListener('blur', hideContextMenu);
  }

  // ---- Task Information dialog ----
  var taskDialogId = null;

  function openTaskDialog(id) {
    var i = model.findIndexById(id);
    if (i < 0) return;
    var p = model.getProject();
    var t = p.tasks[i];
    var row = model.getComputed().rows[i];
    taskDialogId = id;

    els.tmTitle.textContent = 'Task Information — row ' + (i + 1) + (row.isSummary ? ' (summary)' : row.isMilestone ? ' (milestone)' : '');
    els.tmName.value = t.name;
    els.tmDuration.value = row.isSummary ? row.durationDays + ' days (from children)' : t.duration;
    els.tmDuration.disabled = row.isSummary;
    els.tmPct.value = row.isSummary ? row.percentComplete : t.percentComplete;
    els.tmPct.disabled = row.isSummary;
    els.tmConstraintType.value = t.constraintType || '';
    els.tmConstraintType.disabled = row.isSummary;
    els.tmConstraintDate.value = t.constraintISO || '';
    els.tmConstraintDate.disabled = row.isSummary || !t.constraintType;
    els.tmDeadline.value = t.deadlineISO || '';
    els.tmActualStart.value = t.actualStartISO || '';
    els.tmActualStart.disabled = row.isSummary;
    els.tmActualFinish.value = t.actualFinishISO || '';
    els.tmActualFinish.disabled = row.isSummary;
    els.tmNotes.value = t.notes || '';

    renderTmPreds(t);
    renderTmResources(t);
    // View-only: the dialog becomes a read-only inspector.
    var ro = isViewer();
    if (ro) {
      [els.tmName, els.tmDuration, els.tmPct, els.tmConstraintType, els.tmConstraintDate,
        els.tmDeadline, els.tmActualStart, els.tmActualFinish, els.tmNotes, els.tmNewRes].forEach(function (el) { el.disabled = true; });
    }
    els.tmOk.hidden = ro;
    els.tmAddPred.hidden = ro;
    els.tmAddRes.hidden = ro;
    els.tmPreds.querySelectorAll('select,input,button').forEach(function (el) { if (ro) el.disabled = true; });
    els.tmResources.querySelectorAll('input').forEach(function (el) { if (ro) el.disabled = true; });
    els.taskModal.hidden = false;
    if (!ro) els.tmName.focus();
  }

  function renderTmPreds(t) {
    var p = model.getProject();
    var html = '';
    (t.predecessors || []).forEach(function (pr, k) {
      var predIdx = model.findIndexById(pr.id);
      html += '<tr data-k="' + k + '">' +
        '<td><select class="tm-pred-task">' + tmTaskOptions(t.id, predIdx) + '</select></td>' +
        '<td><select class="tm-pred-type">' + ['FS', 'SS', 'FF', 'SF'].map(function (ty) {
          return '<option' + (pr.type === ty ? ' selected' : '') + '>' + ty + '</option>';
        }).join('') + '</select></td>' +
        '<td><input class="tm-pred-lag" type="number" step="1" value="' + (pr.lag || 0) + '" title="Lag (working days; negative = lead)"></td>' +
        '<td><button class="tm-pred-del" title="Remove">✕</button></td></tr>';
    });
    els.tmPreds.innerHTML = html || '<tr><td style="color:#888;font-size:12px">None — starts at the project start (or its constraint).</td></tr>';
    els.tmPreds.querySelectorAll('.tm-pred-del').forEach(function (b) {
      b.onclick = function () { b.closest('tr').remove(); };
    });
  }

  function tmTaskOptions(selfId, selectedIdx) {
    var rows = model.getComputed().rows;
    return rows.map(function (r, idx) {
      if (r.id === selfId) return '';
      return '<option value="' + (idx + 1) + '"' + (idx === selectedIdx ? ' selected' : '') + '>' +
        (idx + 1) + ' — ' + PM.Grid.esc(r.name || '(unnamed)') + '</option>';
    }).join('');
  }

  function renderTmResources(t) {
    var p = model.getProject();
    var html = '';
    p.resources.forEach(function (r) {
      var on = t.resourceIds.indexOf(r.id) >= 0;
      html += '<label><input type="checkbox" value="' + r.id + '"' + (on ? ' checked' : '') + '> ' +
        '<span class="res-swatch" style="background:' + PM.Grid.esc(r.color) + '"></span> ' + PM.Grid.esc(r.name) + '</label>';
    });
    els.tmResources.innerHTML = html || '<span style="color:#888;font-size:12px">No resources defined yet.</span>';
  }

  function applyTaskDialog() {
    var id = taskDialogId;
    if (id == null) return;
    var i = model.findIndexById(id);
    if (i < 0) { closeTaskDialog(); return; }
    var t = model.getProject().tasks[i];
    var row = model.getComputed().rows[i];

    if (els.tmName.value !== t.name) model.setField(id, 'name', els.tmName.value);
    if (!row.isSummary && String(els.tmDuration.value) !== String(t.duration)) model.setField(id, 'duration', els.tmDuration.value);
    if (!row.isSummary && parseInt(els.tmPct.value, 10) !== t.percentComplete) model.setField(id, 'percentComplete', els.tmPct.value);

    if (!row.isSummary) {
      var ctype = els.tmConstraintType.value || null;
      var cdate = els.tmConstraintDate.value || null;
      if (ctype !== (t.constraintType || null) || (cdate || null) !== (t.constraintISO || null)) {
        model.setConstraint(id, ctype, cdate);
      }
    }
    if ((els.tmDeadline.value || null) !== (t.deadlineISO || null)) model.setField(id, 'deadline', els.tmDeadline.value);
    if (!row.isSummary && (els.tmActualStart.value || null) !== (t.actualStartISO || null)) model.setField(id, 'actualStart', els.tmActualStart.value);
    if (!row.isSummary && (els.tmActualFinish.value || null) !== (t.actualFinishISO || null)) model.setField(id, 'actualFinish', els.tmActualFinish.value);
    if (els.tmNotes.value !== (t.notes || '')) model.setField(id, 'notes', els.tmNotes.value);

    // Predecessors from the editor table -> token string.
    if (!row.isSummary || t.predecessors.length) {
      var tokens = [];
      els.tmPreds.querySelectorAll('tr[data-k]').forEach(function (tr) {
        var taskSel = tr.querySelector('.tm-pred-task');
        var typeSel = tr.querySelector('.tm-pred-type');
        var lagInp = tr.querySelector('.tm-pred-lag');
        if (!taskSel || !taskSel.value) return;
        var tok = taskSel.value;
        var ty = typeSel.value, lag = parseInt(lagInp.value, 10) || 0;
        if (ty !== 'FS' || lag) tok += ty;
        if (lag) tok += (lag > 0 ? '+' : '') + lag;
        tokens.push(tok);
      });
      var newPreds = tokens.join(', ');
      if (newPreds !== model.formatPredecessors(t.predecessors)) model.setField(id, 'predecessors', newPreds);
    }

    // Resources from checkboxes -> names string.
    var p = model.getProject();
    var names = [];
    els.tmResources.querySelectorAll('input[type=checkbox]:checked').forEach(function (cb) {
      var r = p.resources.filter(function (x) { return x.id === +cb.value; })[0];
      if (r) names.push(r.name);
    });
    var newRes = names.join(', ');
    if (newRes !== model.formatResources(t.resourceIds)) model.setField(id, 'resources', newRes);

    closeTaskDialog();
    render();
  }

  function closeTaskDialog() { taskDialogId = null; els.taskModal.hidden = true; }

  function wireTaskDialog() {
    els.tmClose.onclick = closeTaskDialog;
    els.tmCancel.onclick = closeTaskDialog;
    els.tmOk.onclick = applyTaskDialog;
    els.taskModal.addEventListener('mousedown', function (e) { if (e.target === els.taskModal) closeTaskDialog(); });
    els.tmConstraintType.onchange = function () {
      els.tmConstraintDate.disabled = !els.tmConstraintType.value;
      if (els.tmConstraintType.value && !els.tmConstraintDate.value) {
        var i = model.findIndexById(taskDialogId);
        if (i >= 0) els.tmConstraintDate.value = Cal.toISO(model.getComputed().rows[i].startDay);
      }
    };
    els.tmAddPred.onclick = function () {
      var i = model.findIndexById(taskDialogId);
      if (i < 0) return;
      var tbody = els.tmPreds;
      // Drop the "None" placeholder row if present.
      if (!tbody.querySelector('tr[data-k]')) tbody.innerHTML = '';
      var k = tbody.querySelectorAll('tr[data-k]').length;
      var tr = document.createElement('tr');
      tr.setAttribute('data-k', String(k));
      tr.innerHTML = '<td><select class="tm-pred-task">' + tmTaskOptions(taskDialogId, -1) + '</select></td>' +
        '<td><select class="tm-pred-type"><option>FS</option><option>SS</option><option>FF</option><option>SF</option></select></td>' +
        '<td><input class="tm-pred-lag" type="number" step="1" value="0"></td>' +
        '<td><button class="tm-pred-del" title="Remove">✕</button></td>';
      tbody.appendChild(tr);
      tr.querySelector('.tm-pred-del').onclick = function () { tr.remove(); };
    };
    els.tmAddRes.onclick = function () {
      var name = els.tmNewRes.value.trim();
      if (!name) return;
      model.addResource(name);
      els.tmNewRes.value = '';
      var i = model.findIndexById(taskDialogId);
      if (i >= 0) renderTmResources(model.getProject().tasks[i]);
      // newly added resource starts unchecked; user ticks it to assign
    };
    els.tmNewRes.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); els.tmAddRes.click(); } };
  }

  // ---- Risk register ----
  var riskFormId = null;    // null = closed, 0 = new, >0 = editing that risk
  var riskCellFilter = null; // {p, i} heatmap cell filter

  var SEV_LABEL = { low: 'Low', medium: 'Medium', high: 'High', critical: 'CRITICAL' };

  function openRiskModal() {
    riskCellFilter = null;
    closeRiskForm();
    renderRiskRegister();
    els.riskModal.hidden = false;
  }

  function renderRiskRegister() {
    var p = model.getProject();
    var risks = (p.risks || []).slice().sort(function (a, b) {
      return (b.probability * b.impact) - (a.probability * a.impact);
    });
    if (riskCellFilter) {
      risks = risks.filter(function (r) {
        return r.probability === riskCellFilter.p && r.impact === riskCellFilter.i;
      });
    }

    // 5×5 heatmap: impact rows (5 at top), probability columns.
    var counts = {};
    (p.risks || []).forEach(function (r) {
      if (r.status === 'open' || r.status === 'mitigating') {
        var k = r.probability + ',' + r.impact;
        counts[k] = (counts[k] || 0) + 1;
      }
    });
    var hm = '<div class="hm-grid">';
    for (var imp = 5; imp >= 1; imp--) {
      for (var prob = 1; prob <= 5; prob++) {
        var sev = model.riskSeverity(prob * imp);
        var n = counts[prob + ',' + imp] || 0;
        var active = riskCellFilter && riskCellFilter.p === prob && riskCellFilter.i === imp;
        hm += '<div class="hm-cell sev-' + sev + (active ? ' hm-active' : '') + '" data-p="' + prob + '" data-i="' + imp +
          '" title="P' + prob + ' × I' + imp + ' = ' + (prob * imp) + '">' + (n || '') + '</div>';
      }
    }
    hm += '</div><div class="hm-axis">Probability →&nbsp;&nbsp;(Impact ↑)</div>';
    els.riskHeatmap.innerHTML = hm;
    els.riskHeatmap.querySelectorAll('.hm-cell').forEach(function (cell) {
      cell.onclick = function () {
        var pv = +cell.getAttribute('data-p'), iv = +cell.getAttribute('data-i');
        riskCellFilter = (riskCellFilter && riskCellFilter.p === pv && riskCellFilter.i === iv) ? null : { p: pv, i: iv };
        renderRiskRegister();
      };
    });

    var s = model.getComputed().riskSummary || {};
    els.riskSummaryBox.innerHTML =
      '<div><strong>' + (s.open || 0) + '</strong> open · <strong>' + (s.mitigating || 0) + '</strong> mitigating</div>' +
      '<div>' + (s.closed || 0) + ' closed · ' + (s.realized || 0) + ' realized</div>' +
      '<div>Exposure <strong>' + (s.exposure || 0) + '</strong>' +
      (s.critical ? ' · <span class="sev-critical-text">' + s.critical + ' CRITICAL</span>' : '') + '</div>' +
      (riskCellFilter ? '<div class="hm-filter-note">Filtered to P' + riskCellFilter.p + '×I' + riskCellFilter.i + ' — click the cell again to clear</div>' : '');

    var esc = PM.Grid.esc;
    var idToRow = {};
    model.getComputed().rows.forEach(function (r, idx) { idToRow[r.id] = idx + 1; });
    var html = '<thead><tr><th>ID</th><th>Title</th><th>Cat</th><th>P</th><th>I</th><th>Score</th><th>Owner</th><th>Status</th><th>Tasks</th><th>Review</th></tr></thead><tbody>';
    risks.forEach(function (r) {
      var score = r.probability * r.impact;
      var sev = model.riskSeverity(score);
      var taskRows = r.taskIds.map(function (tid) { return idToRow[tid]; }).filter(Boolean).join(', ');
      html += '<tr data-risk="' + r.id + '" class="risk-row st-' + r.status + '">' +
        '<td>' + r.id + '</td>' +
        '<td class="rk-title">' + esc(r.title) + '</td>' +
        '<td>' + esc(r.category) + '</td>' +
        '<td>' + r.probability + '</td><td>' + r.impact + '</td>' +
        '<td><span class="score-chip sev-' + sev + '">' + score + '</span></td>' +
        '<td>' + esc(r.owner) + '</td>' +
        '<td>' + esc(r.status) + '</td>' +
        '<td>' + esc(taskRows) + '</td>' +
        '<td>' + esc(r.reviewISO || '') + '</td></tr>';
    });
    if (!risks.length) html += '<tr><td colspan="10" style="color:#888;padding:14px">No risks ' + (riskCellFilter ? 'in this cell' : 'recorded yet') + '.</td></tr>';
    html += '</tbody>';
    els.riskTable.innerHTML = html;
    els.riskTable.querySelectorAll('tr[data-risk]').forEach(function (tr) {
      tr.onclick = function () { openRiskForm(+tr.getAttribute('data-risk')); };
    });
    els.riskAddBtn.hidden = isViewer();
  }

  function openRiskForm(id) {
    riskFormId = id || 0;
    var r = id ? model.riskById(id) : null;
    els.riskFormLegend.textContent = r ? ('Risk #' + r.id + ' — ' + r.title) : 'New risk';
    els.rkTitle.value = r ? r.title : '';
    els.rkCategory.value = r ? r.category : 'other';
    els.rkProb.value = r ? r.probability : 3;
    els.rkImpact.value = r ? r.impact : 3;
    els.rkOwner.value = r ? r.owner : '';
    els.rkStatus.value = r ? r.status : 'open';
    els.rkReview.value = r && r.reviewISO ? r.reviewISO : '';
    els.rkDesc.value = r ? r.description : '';
    els.rkMitigation.value = r ? r.mitigation : '';
    els.rkContingency.value = r ? r.contingency : '';
    // Linked-task checkboxes (leaf tasks only — risks attach to work, not rollups)
    var esc = PM.Grid.esc;
    var rows = model.getComputed().rows;
    els.rkTasks.innerHTML = rows.filter(function (row) { return !row.isSummary; }).map(function (row) {
      var on = r && r.taskIds.indexOf(row.id) >= 0;
      return '<label><input type="checkbox" value="' + row.id + '"' + (on ? ' checked' : '') + '> ' +
        row.row + ' — ' + esc(row.name || '(unnamed)') + '</label>';
    }).join('') || '<span style="color:#888">No tasks yet.</span>';
    var ro = isViewer();
    els.riskForm.querySelectorAll('input,select,textarea,button').forEach(function (el) {
      if (el.id !== 'rkCancel') el.disabled = ro;
    });
    els.rkDelete.hidden = !r || ro;
    els.riskForm.hidden = false;
  }

  function closeRiskForm() { riskFormId = null; els.riskForm.hidden = true; }

  function saveRiskForm() {
    if (isViewer()) return;
    var fields = {
      title: els.rkTitle.value.trim(),
      category: els.rkCategory.value,
      probability: parseInt(els.rkProb.value, 10),
      impact: parseInt(els.rkImpact.value, 10),
      owner: els.rkOwner.value.trim(),
      status: els.rkStatus.value,
      reviewISO: els.rkReview.value || null,
      description: els.rkDesc.value,
      mitigation: els.rkMitigation.value,
      contingency: els.rkContingency.value,
      taskIds: Array.from(els.rkTasks.querySelectorAll('input:checked')).map(function (cb) { return +cb.value; })
    };
    if (!fields.title) { alert('A risk needs a title.'); return; }
    if (riskFormId) model.updateRisk(riskFormId, fields);
    else model.addRisk(fields);
    closeRiskForm();
    renderRiskRegister();
    render(); // task chips + status bar
  }

  function wireRiskModal() {
    els.btnRisks.onclick = openRiskModal;
    els.riskClose.onclick = function () { els.riskModal.hidden = true; closeRiskForm(); };
    els.riskModal.addEventListener('mousedown', function (e) { if (e.target === els.riskModal) { els.riskModal.hidden = true; closeRiskForm(); } });
    els.riskAddBtn.onclick = function () { openRiskForm(null); };
    els.rkSave.onclick = saveRiskForm;
    els.rkCancel.onclick = closeRiskForm;
    els.rkDelete.onclick = function () {
      if (riskFormId && confirm('Delete this risk?')) {
        model.deleteRisk(riskFormId);
        closeRiskForm();
        renderRiskRegister();
        render();
      }
    };
  }

  // ---- Version history ----
  function openHistoryModal() {
    if (!sync.server) return;
    els.histTable.innerHTML = '<tbody><tr><td style="color:#888;padding:12px">Loading…</td></tr></tbody>';
    els.histModal.hidden = false;
    fetch(apiPath('history'))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(renderHistoryTable)
      .catch(function () {
        els.histTable.innerHTML = '<tbody><tr><td style="color:#888;padding:12px">Could not load history.</td></tr></tbody>';
      });
  }

  function renderHistoryTable(list) {
    var esc = PM.Grid.esc;
    var html = '<thead><tr><th>Rev</th><th>When</th><th>Saved by</th><th>Tasks</th><th></th></tr></thead><tbody>';
    if (!list.length) html += '<tr><td colspan="5" style="color:#888;padding:12px">No revisions yet — they appear as you work.</td></tr>';
    list.forEach(function (e) {
      var when = e.ts ? new Date(e.ts).toLocaleString() : '';
      var current = e.rev === sync.rev;
      html += '<tr>' +
        '<td>' + e.rev + (current ? ' <span class="hist-current">current</span>' : '') + '</td>' +
        '<td>' + esc(when) + '</td>' +
        '<td>' + esc(e.editor || '') + '</td>' +
        '<td>' + (e.taskCount != null ? e.taskCount : '') + '</td>' +
        '<td>' + (current || isViewer() ? '' : '<button class="tb hist-restore" data-rev="' + e.rev + '">Restore</button>') + '</td>' +
        '</tr>';
    });
    html += '</tbody>';
    els.histTable.innerHTML = html;
    els.histTable.querySelectorAll('.hist-restore').forEach(function (b) {
      b.onclick = function () {
        var rev = +b.getAttribute('data-rev');
        if (!confirm('Restore revision ' + rev + '? The current version stays in history and can be restored back.')) return;
        fetch(apiPath('restore'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rev: rev })
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (!res.ok || !res.j.ok) throw new Error((res.j && res.j.error) || 'restore failed');
            return fetch(apiPath()).then(function (r) { return r.json(); }).then(function (doc) {
              els.histModal.hidden = true;
              applyRemote(doc);
              toast('Restored revision ' + rev + ' (as new revision ' + res.j.rev + ')');
            });
          })
          .catch(function (e) { alert('Restore failed: ' + e.message); });
      };
    });
  }

  function wireHistoryModal() {
    els.btnHistory.onclick = openHistoryModal;
    els.histClose.onclick = function () { els.histModal.hidden = true; };
    els.histModal.addEventListener('mousedown', function (e) { if (e.target === els.histModal) els.histModal.hidden = true; });
  }

  // ---- Calendar dialog ----
  var DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function openCalendarDialog() {
    var cal = model.getProject().calendar || {};
    var wd = cal.workingDays || [1, 2, 3, 4, 5];
    els.calDays.innerHTML = DOW_LABELS.map(function (d, i) {
      return '<label><input type="checkbox" value="' + i + '"' + (wd.indexOf(i) >= 0 ? ' checked' : '') + '> ' + d + '</label>';
    }).join('');
    els.calHolidays.value = (cal.holidays || []).join('\n');
    els.calStatus.value = model.getProject().statusISO || '';
    els.calModal.hidden = false;
  }
  function applyCalendarDialog() {
    var days = Array.from(els.calDays.querySelectorAll('input:checked')).map(function (cb) { return +cb.value; });
    if (!days.length) { alert('At least one working day is required.'); return; }
    var holidays = els.calHolidays.value.split(/\n+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return /^\d{4}-\d{1,2}-\d{1,2}$/.test(s); });
    model.setWorkingDays(days);
    model.setHolidays(holidays);
    model.setStatusDate(els.calStatus.value || null);
    els.calModal.hidden = true;
    render();
  }
  function wireCalendarDialog() {
    els.btnCalendar.onclick = openCalendarDialog;
    els.calClose.onclick = function () { els.calModal.hidden = true; };
    els.calCancel.onclick = function () { els.calModal.hidden = true; };
    els.calOk.onclick = applyCalendarDialog;
    els.calModal.addEventListener('mousedown', function (e) { if (e.target === els.calModal) els.calModal.hidden = true; });
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
    els.btnBaselineClear.onclick = function () {
      if (confirm('Clear the saved baseline?')) { model.clearBaseline(); render(); }
    };
    els.filterSel.onchange = function () {
      model.setFilter(els.filterSel.value || null);
      selected = {}; anchorId = null; // filtered-out rows can't stay selected
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
    ['gridPane', 'ganttPane', 'ganttHeader', 'ganttBody', 'splitter', 'projName', 'projStart', 'projSelect', 'projDelete',
      'btnNew', 'btnOpen', 'btnSave', 'btnExport', 'btnSample', 'fileInput', 'btnUndo', 'btnRedo',
      'btnAdd', 'btnInsert', 'btnDelete', 'btnIndent', 'btnOutdent', 'btnUp', 'btnDown',
      'btnLink', 'btnUnlink', 'btnCollapse', 'btnExpand', 'btnToday', 'btnBaseline', 'btnResources',
      'resModal', 'resClose', 'resTable', 'resNewName', 'resAddBtn', 'stWarn', 'stSaved',
      'ctxMenu', 'taskModal', 'tmTitle', 'tmClose', 'tmName', 'tmDuration', 'tmPct',
      'tmConstraintType', 'tmConstraintDate', 'tmDeadline', 'tmActualStart', 'tmActualFinish', 'tmPreds', 'tmAddPred',
      'tmResources', 'tmNewRes', 'tmAddRes', 'tmNotes', 'tmOk', 'tmCancel',
      'filterSel', 'btnBaselineClear', 'btnCalendar', 'calModal', 'calClose', 'calCancel', 'calOk', 'calDays', 'calHolidays',
      'btnRisks', 'riskModal', 'riskClose', 'riskTable', 'riskHeatmap', 'riskSummaryBox', 'riskAddBtn',
      'riskForm', 'riskFormLegend', 'rkTitle', 'rkCategory', 'rkProb', 'rkImpact', 'rkOwner', 'rkStatus',
      'rkReview', 'rkDesc', 'rkMitigation', 'rkContingency', 'rkTasks', 'rkSave', 'rkDelete', 'rkCancel',
      'btnHistory', 'histModal', 'histClose', 'histTable', 'calStatus'
    ].forEach(function (id) { els[id] = $(id); });

    model.setStorageKey(PROJECT_NAME);
    model.subscribe(onModelChanged);
    wireToolbar();
    wireProjectSwitcher();
    wireSplitter();
    wireKeyboard();
    wireContextMenu();
    wireTaskDialog();
    wireCalendarDialog();
    wireRiskModal();
    wireHistoryModal();
    bootstrapStorage(); // loads local instantly, then upgrades to server mode
  }

  // Debug/automation handle (read-mostly): lets a driving AI or the console
  // inspect sync state and the live model without reaching into the closure.
  window.__projectdesk = { sync: sync, model: model, projectName: PROJECT_NAME };

  // Flush pending edits when the tab closes / navigates away.
  window.addEventListener('pagehide', flushBeforeNavigate);
  window.addEventListener('beforeunload', flushBeforeNavigate);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
