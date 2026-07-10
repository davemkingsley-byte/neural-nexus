# ProjectDesk — a Microsoft Project–style planner

A self-contained, browser-based project planner: a task grid + interactive Gantt
chart with a real critical-path scheduling engine. No build step, no server
required, no external dependencies — everything runs from static files.

![status](https://img.shields.io/badge/tests-passing-brightgreen)

## Running it

**Option A — just open it.** Double-click `index.html` (it works over `file://`
because it uses classic scripts, not ES modules).

**Option B — serve it** (nicer URL, avoids any browser file:// quirks):

```bash
cd project-planner
python3 -m http.server 4180
# then open http://localhost:4180/
```

Your work autosaves to the browser's `localStorage` and reloads automatically.
Use **Save** / **Open** to move a plan to/from a `.json` file for backup or sharing.

## What it does

- **Task grid** with a work-breakdown hierarchy (indent/outdent to create summary
  tasks and subtasks), WBS numbering, and inline editing of every field.
- **Gantt chart** with task bars, summary rollup bars, milestone diamonds,
  **% complete** progress fill, **dependency arrows**, weekend/holiday shading,
  and a "today" line.
- **Critical-path scheduling engine.** Enter durations and predecessors; the app
  computes start/finish dates, total float (slack), and highlights the **critical
  path in red**. Forward + backward pass with proper late-date/slack math.
- **Dependency types** FS / SS / FF / SF, each with positive or negative **lag**
  (lead), e.g. `3`, `3FS+2`, `2SS`, `4FF-1`.
- **Working calendar** — schedules skip weekends (and any holidays you add to the
  project JSON). Durations are in working days: `5d`, `2w` (=10d), `1mo` (=20d),
  `0` (milestone).
- **Resources & costs** — assign people/teams to tasks; set a **day rate** per
  resource in the Resources dialog and the grid's Cost column (and the status-bar
  total) computes leaf cost = rates × working days, rolled up through summaries.
- **Over-allocation detection** — a resource booked on two overlapping tasks is
  flagged with ⚠ on the affected rows and counted in the status bar. (Detection
  only — the schedule is never silently re-leveled.)
- **Deadlines** — set a deadline on any task; it draws a marker on the Gantt and
  turns red (plus a status-bar warning) when the computed finish slips past it.
  Deadlines are indicators, MS Project–style: they never move the schedule.
- **Drag to reschedule** a bar (sets a Start-No-Earlier-Than constraint) or drag
  its **right edge to resize** the duration.
- **Baselines** — snapshot the plan to compare against later.
- **CSV export** — the CSV button downloads the full task table (WBS, dates,
  predecessors, resources, cost, slack, critical flags) for Excel/Sheets.
  Printing (`Ctrl+P`) produces a clean task-table report.
- **Undo / redo**, multi-select, collapse/expand, three zoom levels (Day/Week/Month).

## Keyboard shortcuts

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `Ctrl+Enter` | Add task | `Tab` / `Shift+Tab` | Indent / outdent |
| `Insert` | Insert task above | `Alt+↑` / `Alt+↓` | Move task up / down |
| `Delete` | Delete selected | `↑` / `↓` | Move selection |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo | `Ctrl+L` / `Ctrl+Shift+L` | Link / unlink |
| `Ctrl+S` | Save to file | `F2` / `Enter` | Edit selected row |

Double-click any cell to edit it. Within an editor, `Enter` commits and drops to
the next row, `Tab` moves to the next column, `Esc` cancels.

## Architecture

Plain JavaScript, no framework. Each module is a UMD file that runs in the browser
and (for the pure ones) under Node for testing.

| File | Responsibility |
|------|----------------|
| `js/scheduler.js` | Pure critical-path engine — forward/backward relaxation, hierarchy, cycle detection. Works in integer "working-day index" space. |
| `js/calendar.js` | Pure date math — converts working-day indices ↔ calendar days, handles weekends/holidays. |
| `js/model.js` | Project state, editing operations, undo/redo, persistence, and the glue that turns the schedule into display dates. |
| `js/grid.js` | The task table and inline cell editing. |
| `js/gantt.js` | The SVG timeline: bars, milestones, arrows, drag interactions. |
| `js/app.js` | Controller — selection, keyboard, scroll-sync, file IO, dialogs. |

The **finish index is exclusive**: a duration-`d` task occupies working days
`[start, start+d)`. This keeps dependency math clean; the grid shows the inclusive
last working day. See the header comment in `scheduler.js`.

## Tests

The correctness-critical engine has real unit tests (run under Node):

```bash
node tests/run-all.js          # everything below, exits non-zero on failure
node tests/scheduler.test.js   # critical path, FS/SS/FF/SF+lag, summaries, cycles
node tests/calendar.test.js    # working-day index math, holidays, round-trips
node tests/model.test.js       # editing ops, predecessor round-trips, undo, recompute
node tests/regressions.test.js # fixes from the adversarial review, locked in
node tests/features.test.js    # cost roll-up, over-allocation, deadlines, CSV
```

All suites should print `0 failed`.
