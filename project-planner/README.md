# ProjectDesk — a Microsoft Project–style planner

A browser-based project planner — task grid + interactive Gantt over a real
critical-path scheduling engine — designed to be used **by humans and driven by
AIs through the same model layer** (see `HARNESS.md`). No build step, no
dependencies: plain JS + a node-stdlib server.

![status](https://img.shields.io/badge/tests-passing-brightgreen)

## Running it

**Server mode (recommended).** Plans live as git-committable JSON files in
`projects/`, multiple named projects (`?project=name`, top-bar switcher), and
external edits (CLI / AI) appear in the open browser within ~2 seconds:

```bash
cd project-planner
node server.js --port 4180        # then open http://localhost:4180/
```

Make it permanent (starts at login, restarts on crash):

```bash
./scripts/install-launch-agent.sh            # remove: --uninstall
# after a git pull, restart it:
launchctl kickstart -k gui/$(id -u)/com.projectdesk.server
```

**Offline mode.** Double-click `index.html` — works over `file://` with
`localStorage` persistence. **Save** / **Open** move plans to/from `.json`.

**Desktop app (macOS).** A native app — its own window, Dock icon, and menu,
no browser — that runs everything locally:

```bash
./desktop/build.sh          # builds ~/Applications/ProjectDesk.app
open "$HOME/Applications/ProjectDesk.app"
```

The app connects to the local server (starting one itself if none is running),
so your plans stay in local files on this machine. It needs `node` and the
Xcode command-line tools (`swiftc`) to build.

## Driving it from the command line / an AI

```bash
node cli.js current show                       # task table + health line
node cli.js current add --name "Write spec" --duration 5d --res "Alex"
node cli.js current link 3 4 --type SS --lag 2
node cli.js current summary --json
```

Full ops reference, REST API, and concurrency guarantees: **`HARNESS.md`**.

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
- **Constraints** — Start-No-Earlier-Than and **Must-Start-On** (pins the date;
  a pin that violates its dependencies is flagged as a schedule conflict).
- **Task Information dialog** (double-click a row number, or right-click):
  every field including a full predecessors editor and resource checkboxes.
- **Spreadsheet editing** — click a cell and type; arrows/Tab navigate;
  `Enter` on the last row appends the next task (rapid entry); right-click
  context menu for insert/indent/link/delete.
- **Drag to reschedule** a bar, drag its **right edge to resize**, and drag the
  **circle at a bar's end onto another bar to link them**.
- **Baselines** — snapshot the plan; gray/amber variance bars show slippage
  against it (tooltip gives exact days).
- **Filters** — critical path / incomplete / milestones / overallocated /
  late+conflicted, with ancestor summaries kept for context. Slack column shows
  total float per task.
- **Calendar dialog** — working days + holidays without touching JSON.
- **CSV export** — the CSV button downloads the full task table (WBS, dates,
  predecessors, resources, cost, slack, critical flags) for Excel/Sheets.
  Printing (`Ctrl+P`) produces a clean task-table report.
- **Execution tracking** — record **actual start/finish** (they pin the schedule
  to what really happened and pull successors with them); set a **status date**
  and the plan shows expected-vs-actual progress with a status line and
  **behind-schedule** flags.
- **Version history & restore** — every save is a revision; the 🕘 History dialog
  lists them (who/when/task count) and restores any one as a new revision, so a
  bad bulk edit — or an accidental project delete — is always recoverable.
- **Comments & activity** — comment threads per task (author + time), 💬 badges,
  and an 📋 Activity feed of who changed what.
- **Undo / redo**, multi-select, collapse/expand, three zoom levels (Day/Week/Month).
- **Live multi-writer sync** — the browser autosaves with optimistic
  concurrency (rev + If-Match; conflicting writes reload rather than clobber)
  and polls for external edits, so a human and an AI can work the same plan
  simultaneously.
- **Team hosting (optional)** — put it behind a Cloudflare Tunnel + Access with
  editor/viewer roles; comment authorship and every write are verified and
  audited server-side. See `HOSTING.md`.

## Keyboard shortcuts

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `Ctrl+Enter` | Add task | `Alt+Shift+→` / `←` | Indent / outdent |
| `Insert` | Insert task above | `Alt+↑` / `Alt+↓` | Move task up / down |
| `Delete` | Delete selected | `↑` `↓` `←` `→` `Tab` | Move cell cursor |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo | `Ctrl+L` / `Ctrl+Shift+L` | Link / unlink |
| `Ctrl+S` | Save to file | `F2` / `Enter` / typing | Edit the cursor cell |

Typing any character starts editing the focused cell (replacing its content).
Within an editor, `Enter` commits and drops to the next row (appending a new
task from the last row), `Tab` moves to the next column, `Esc` cancels.

## Architecture

Plain JavaScript, no framework. Each module is a UMD file that runs in the browser
and (for the pure ones) under Node for testing.

| File | Responsibility |
|------|----------------|
| `js/scheduler.js` | Pure critical-path engine — forward/backward relaxation, hierarchy, constraints (SNET/MSO), cycle detection. Integer "working-day index" space. |
| `js/calendar.js` | Pure date math — converts working-day indices ↔ calendar days, handles weekends/holidays. |
| `js/model.js` | Project state, editing operations, undo/redo, filters, persistence, and the glue that turns the schedule into display dates. |
| `js/ops.js` | Semantic operations layer — the programmatic (AI/CLI/API) interface; atomic batches through the same model methods the UI uses. |
| `js/grid.js` | The task table, cell cursor, and inline editing. |
| `js/gantt.js` | The SVG timeline: bars, baselines, deadline markers, arrows, drag interactions. |
| `js/app.js` | Controller — selection, keyboard, dialogs, context menu, and the live-sync storage engine. |
| `server.js` | Node-stdlib HTTP server: static app + JSON API over `projects/*.json` (atomic rev-bumped writes, If-Match concurrency, atomic ops endpoint). |
| `cli.js` | Command line over the same ops — uses the server when it's up, edits files safely when it isn't. |

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
node tests/regressions.test.js # fixes from the adversarial reviews, locked in
node tests/features.test.js    # cost, over-allocation, deadlines, MSO, CSV
node tests/ops.test.js         # the semantic ops layer (AI interface contracts)
node tests/server.test.js      # HTTP API: revs, 409s, atomic batches, traversal
node tests/evm.test.js         # earned value: PV/EV/AC, SPI/CPI, EAC/VAC
node tests/mspdi.test.js       # MS Project XML export + import (round-trip)
node tests/usage.test.js       # timephased resource usage + over-allocation
node tests/report.test.js      # one-page status report assembly
```

All suites should print `0 failed`.

## Microsoft Project interchange (MSPDI)

ProjectDesk reads and writes Microsoft Project's XML interchange format, so
plans move both directions (and to any tool that speaks MSPDI: LibreProject,
GanttProject, Smartsheet…).

- **Export:** `node cli.js <project> export-xml > plan.xml`, the browser's
  *Export → Microsoft Project XML* button, or `GET /api/projects/:name/mspdi`.
  Tasks are emitted auto-scheduled with a matching Standard calendar so MS
  Project's own CPM reproduces the same dates; dependencies, constraints,
  actuals, deadlines, %complete, resources, rates, and assignments carry across.
- **Import:** `node cli.js <project> import-xml plan.xml` (creates/overwrites
  the named project), open a `.xml` file from the browser, or
  `POST /api/projects/:name/import` with the XML as the body. Imported UIDs are
  renumbered onto a clean id space, the project-summary row is skipped, dangling
  and self predecessors are dropped, and malformed XML is rejected with a clear
  error rather than silently truncated. ProjectDesk recomputes the schedule from
  the imported dependencies + calendar.

## Honest gaps vs. real Microsoft Project (roadmap)

Largest first — what MS Project has that ProjectDesk currently does not:

1. **Work/effort-driven scheduling** — resource units (%), work vs. duration as
   separate quantities, effort-driven task types. ProjectDesk treats duration
   as primary and costs by day rate.
2. **Resource leveling** — over-allocation is detected and flagged, never
   auto-resolved (deliberate: silent replans surprise users).
3. **More views** — Task Usage timephased table, Network Diagram, Calendar
   view, Team Planner. ProjectDesk has grid + Gantt + a Resource Usage view.
4. **More constraint types** (ALAP, FNLT, MFO...), task calendars, recurring
   tasks, split tasks, manual-vs-auto scheduling mode. Import maps MSO/SNET and
   drops the rest (the model's supported set).
5. **Custom fields** (user-defined columns with formulas), richer report
   gallery (ProjectDesk has one printable status report; MS Project ships ~20
   canned reports). The grid does have a column chooser (⚙ Columns) over its
   built-in fields, incl. an opt-in WBS column.

Delivered since the first cut: MSPDI XML export **and** import, earned value
(PV/EV/AC, SPI/CPI, EAC/VAC), a timephased **Resource Usage** view (work + cost
spread across day/week/month buckets, over-allocation pinpointed to real dates),
a printable one-page **Project Status Report** (health flags, milestones,
behind/upcoming, top risks, critical path, resource load, EVM — 📄 Report →
Print), status date + actuals/progress tracking, version history & restore,
task comments & activity feed, multi-user roles + audit.
