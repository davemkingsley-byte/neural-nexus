/*
 * grid.js — the left-hand task table (spreadsheet-style) with inline editing.
 * Renders visible rows and wires selection + cell editing, delegating all
 * mutations back through callbacks in opts.
 */
(function (root, factory) {
  root.PM = root.PM || {};
  root.PM.Grid = factory(root.PM);
}(typeof self !== 'undefined' ? self : this, function (PM) {
  'use strict';

  var ROW_H = 30; // must match --row-h in CSS and Gantt ROW_H

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var COLUMNS = [
    { key: 'row', label: '', cls: 'c-row', w: 40, editable: false },
    { key: 'name', label: 'Task Name', cls: 'c-name', w: 260, editable: true },
    { key: 'duration', label: 'Duration', cls: 'c-dur', w: 84, editable: true },
    { key: 'start', label: 'Start', cls: 'c-start', w: 104, editable: true },
    { key: 'finish', label: 'Finish', cls: 'c-finish', w: 104, editable: false },
    { key: 'predecessors', label: 'Pred.', cls: 'c-pred', w: 76, editable: true },
    { key: 'resources', label: 'Resources', cls: 'c-res', w: 150, editable: true },
    { key: 'percentComplete', label: '%', cls: 'c-pct', w: 48, editable: true },
    { key: 'deadline', label: 'Deadline', cls: 'c-deadline', w: 100, editable: true },
    { key: 'cost', label: 'Cost', cls: 'c-cost', w: 84, editable: false },
    { key: 'slack', label: 'Slack', cls: 'c-slack', w: 56, editable: false }
  ];

  // Raw (editable) value for a cell — the string the user edits.
  function rawValue(model, r, key) {
    switch (key) {
      case 'name': return r.name;
      case 'duration': return r.durationDays + (r.isSummary ? '' : '');
      case 'start': return PM.Calendar.toISO(r.startDay);
      case 'predecessors': return model.formatPredecessors(r.task.predecessors);
      case 'resources': return model.formatResources(r.task.resourceIds);
      case 'percentComplete': return String(r.percentComplete);
      case 'deadline': return r.task.deadlineISO || '';
      default: return '';
    }
  }

  // Display value for a cell.
  function displayValue(model, r, key) {
    switch (key) {
      case 'row': return r.row;
      case 'duration': return model.formatDuration(r.durationDays);
      case 'start': return PM.Calendar.fmt(r.startDay);
      case 'finish': return PM.Calendar.fmt(r.finishDay);
      case 'predecessors': return model.formatPredecessors(r.task.predecessors);
      case 'resources': return model.formatResources(r.task.resourceIds);
      case 'percentComplete': return r.percentComplete + '%';
      case 'deadline': return r.deadlineDay != null ? PM.Calendar.fmt(r.deadlineDay) : '';
      case 'cost': return r.cost > 0 ? model.formatMoney(r.cost) : '';
      case 'slack': return (r.isSummary || r.slack == null || !isFinite(r.slack)) ? '' : r.slack + 'd';
      default: return '';
    }
  }

  function render(container, model, opts) {
    var computed = model.getComputed();
    var rows = model.getVisibleRows();
    var selected = opts.selected || {};

    var html = '<table class="grid"><colgroup>';
    COLUMNS.forEach(function (c) { html += '<col style="width:' + c.w + 'px">'; });
    html += '</colgroup><thead><tr>';
    COLUMNS.forEach(function (c) { html += '<th class="' + c.cls + '">' + esc(c.label) + '</th>'; });
    html += '</tr></thead><tbody>';

    if (!rows.length) {
      html += '<tr class="empty-row"><td colspan="' + COLUMNS.length + '">' +
        'No tasks yet — click <code>＋ Task</code> (or press <code>Ctrl+Enter</code>), then just type. ' +
        'Scripts and AIs can drive this plan too: see HARNESS.md.</td></tr>';
    }

    rows.forEach(function (r) {
      var cls = ['grid-row'];
      if (selected[r.id]) cls.push('selected');
      if (r.isSummary) cls.push('summary');
      if (r.isMilestone) cls.push('milestone');
      if (r.critical && !r.isSummary) cls.push('critical');
      html += '<tr class="' + cls.join(' ') + '" data-id="' + r.id + '" style="height:' + ROW_H + 'px">';
      COLUMNS.forEach(function (c) {
        // Summary duration/start/% are rolled up from children — editing them
        // would be silently discarded, so those cells are read-only on summaries.
        var editable = c.editable && !(r.isSummary && (c.key === 'duration' || c.key === 'start' || c.key === 'percentComplete'));
        var cellCls = c.cls + (editable ? ' editable' : '');
        if (opts.cursor && opts.cursor.id === r.id && opts.cursor.key === c.key) cellCls += ' cell-cursor';
        if (c.key === 'name') {
          var indent = (r.outlineLevel - 1) * 16;
          var toggle = '';
          if (r.isSummary) {
            toggle = '<span class="toggle" data-toggle="' + r.id + '">' + (r.task.collapsed ? '▶' : '▼') + '</span>';
          } else {
            toggle = '<span class="toggle-spacer"></span>';
          }
          var riskChip = '';
          if (r.risks && r.risks.length) {
            var worst = r.risks.reduce(function (m, k) { return k.score > m.score ? k : m; }, r.risks[0]);
            riskChip = '<span class="risk-chip sev-' + worst.severity + '" title="' +
              esc(r.risks.map(function (k) { return '#' + k.id + ' ' + k.title + ' (' + k.score + ')'; }).join('\n')) +
              '">R' + r.risks.length + '</span>';
          }
          html += '<td class="' + cellCls + '" data-key="name">' +
            '<span class="name-wrap" style="padding-left:' + indent + 'px">' +
            toggle + '<span class="name-text">' + esc(r.name || '') + '</span>' + riskChip + '</span></td>';
        } else if (c.key === 'row') {
          html += '<td class="' + cellCls + '">' + r.row + '</td>';
        } else {
          var extra = '', titleAttr = '', prefix = '';
          if ((c.key === 'deadline' || c.key === 'finish') && r.deadlineMissed) extra = ' missed';
          if (c.key === 'start' && r.constraintViolated) {
            extra = ' missed';
            titleAttr = ' title="Must-Start-On pin conflicts with this task\'s dependencies"';
            prefix = '⚠ ';
          }
          if (c.key === 'resources' && r.overallocatedResources && r.overallocatedResources.length) {
            extra = ' overalloc';
            titleAttr = ' title="Overallocated: ' + esc(r.overallocatedResources.join(', ')) + '"';
            prefix = '⚠ ';
          }
          html += '<td class="' + cellCls + extra + '" data-key="' + c.key + '"' + titleAttr + '>' +
            prefix + esc(displayValue(model, r, c.key)) + '</td>';
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;

    wire(container, model, opts, rows);
  }

  function wire(container, model, opts, rows) {
    var rowById = {};
    rows.forEach(function (r) { rowById[r.id] = r; });
    var editing = null; // {id, key, input, td}

    function commitEdit(moveTo) {
      if (!editing) return;
      var val = editing.input.value;
      var id = editing.id, key = editing.key;
      editing = null;
      opts.onEdit(id, key, val, moveTo);
    }
    function cancelEdit() {
      if (!editing) return;
      var td = editing.td, id = editing.id, key = editing.key;
      editing = null;
      var r = rowById[id];
      td.classList.remove('is-editing');
      td.innerHTML = key === 'name'
        ? tdNameInner(r)
        : esc(displayValue(model, r, key));
    }
    function tdNameInner(r) {
      var indent = (r.outlineLevel - 1) * 16;
      var toggle = r.isSummary
        ? '<span class="toggle" data-toggle="' + r.id + '">' + (r.task.collapsed ? '▶' : '▼') + '</span>'
        : '<span class="toggle-spacer"></span>';
      return '<span class="name-wrap" style="padding-left:' + indent + 'px">' + toggle +
        '<span class="name-text">' + esc(r.name || '') + '</span></span>';
    }

    function startEdit(td, seed) {
      if (opts.readOnly) return; // view-only account
      if (editing) commitEdit(null);
      var tr = td.closest('tr');
      var id = parseInt(tr.getAttribute('data-id'), 10);
      var key = td.getAttribute('data-key');
      if (!key) return;
      var col = COLUMNS.filter(function (c) { return c.key === key; })[0];
      if (!col || !col.editable || !td.classList.contains('editable')) return;
      var r = rowById[id];
      var val = rawValue(model, r, key);
      td.classList.add('is-editing');
      td.innerHTML = '<input class="cell-input" type="text" value="' + esc(val) + '">';
      var input = td.querySelector('input');
      editing = { id: id, key: key, input: input, td: td };
      input.focus();
      if (seed != null) { input.value = seed; } // type-to-replace, cursor at end
      else input.select();
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitEdit('down'); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        else if (e.key === 'Tab') { e.preventDefault(); commitEdit(e.shiftKey ? 'left' : 'right'); }
      });
      input.addEventListener('blur', function () { commitEdit(null); });
    }

    container.querySelector('tbody').addEventListener('mousedown', function (e) {
      var toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        e.preventDefault();
        opts.onToggleCollapse(parseInt(toggle.getAttribute('data-toggle'), 10));
        return;
      }
      var tr = e.target.closest('tr');
      if (!tr) return;
      var id = parseInt(tr.getAttribute('data-id'), 10);
      if (isNaN(id)) return; // empty-state row
      if (editing && editing.id === id) return; // clicking within active edit
      var td = e.target.closest('td');
      var colKey = td ? td.getAttribute('data-key') : null;
      opts.onSelect(id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }, colKey);
    });

    container.querySelector('tbody').addEventListener('dblclick', function (e) {
      // Double-click on the row-number cell opens Task Information.
      var rowTd = e.target.closest('td.c-row');
      if (rowTd && opts.onOpenDetails) {
        var tr0 = rowTd.closest('tr');
        if (tr0 && tr0.getAttribute('data-id')) {
          opts.onOpenDetails(parseInt(tr0.getAttribute('data-id'), 10));
          return;
        }
      }
      var td = e.target.closest('td.editable');
      if (td) startEdit(td);
    });

    // expose edit-starters so the app can trigger editing from keyboard / Tab nav
    container._startEditFirst = function (id) {
      container._startEditCell(id, 'name');
    };
    container._startEditCell = function (id, key, seed) {
      var tr = container.querySelector('tr[data-id="' + id + '"]');
      if (!tr) return;
      var td = tr.querySelector('td[data-key="' + key + '"]');
      if (td && td.classList.contains('editable')) startEdit(td, seed);
    };
    container._isEditing = function () { return !!editing; };
  }

  return { render: render, ROW_H: ROW_H, COLUMNS: COLUMNS, esc: esc };
}));
