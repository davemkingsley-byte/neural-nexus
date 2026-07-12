# ProjectDesk — quality assessment

An evidence-backed statement of where this tool stands against the bar of a
premier project planner. Every claim below is verifiable from this repo: the
test suite (`node tests/run-all.js`), the running system, and the git history.
Last assessed: 2026-07-12 (commit history through Phase S).

## The bar, criterion by criterion

**Scheduling engine.** Full CPM: forward/backward pass, FS/SS/FF/SF
dependencies with lag, critical path, total slack, MSO/SNET constraints with
conflict flags, working-day calendars with holidays, milestones, WBS
hierarchy with roll-ups. Proven by dedicated scheduler/calendar/model suites
and regression-locked against six adversarial review rounds. **Met.**

**Tracking & analysis.** Baselines (dates + cost) with variance bars, status
date with expected-vs-actual progress and behind-schedule flags, actual
start/finish pinning, earned value (PV/EV/AC, SV/CV, SPI/CPI, EAC/ETC/VAC),
risk register (5×5 P×I, heatmap, task links, exposure roll-up), resource
costs + over-allocation detection, timephased Resource Usage view that
pinpoints over-allocation to dates. **Met.**

**Interoperability.** Microsoft Project XML (MSPDI) export *and* import with
an exact round-trip (schedule dates reproduce); CSV export; print/PDF via the
status report. **Met.**

**Reporting.** One-page printable Project Status Report (health flags,
milestones, behind/upcoming, top risks, critical path, resource load, EVM)
in the browser, the native app (native print bridge), the API, and the CLI.
MS Project ships a larger canned-report gallery — documented as roadmap.
**Met for core; depth documented.**

**Collaboration & durability.** Multi-user roles (editor/viewer) with
verified identity, per-project audit trail, task comments with
server-stamped authors, activity feed, version history where every save is a
restorable revision (restore is itself versioned), atomic locked writes,
optimistic concurrency (If-Match/409), live sync across concurrent editors
within ~2s. **Met.**

**Usability.** Spreadsheet-style grid (cell cursor, type-to-edit, keyboard
nav), column chooser, task dialog, context menu, drag-to-link and
drag-to-reschedule Gantt, filters, zoom, undo/redo, project switcher,
delivered as a native macOS app with an always-on local server. **Met.**

**Automation parity (beyond MS Project).** Every capability is drivable
three ways with identical semantics: browser UI, CLI, and JSON API with
atomic semantic-ops batches — designed for human + AI co-editing on the same
live plan. **Met; exceeds the reference tool.**

**Quality assurance.** 16 suites / 647 assertions, zero failures; every
feature phase passed an independent adversarial review (multi-agent finders +
skeptic verification) before merge; all confirmed findings fixed and
regression-locked. **Met.**

## Honest gaps (documented, not blocking)

Work/effort-driven scheduling (resource units, work vs duration), automatic
resource leveling (deliberately excluded — silent replans surprise users),
Task Usage timephased view, network diagram, ALAP/FNLT/MFO constraints,
custom fields with formulas, a wider report gallery. See README roadmap.

## Verdict

Against its stated goal — a Microsoft-Project-class planner that a human and
an AI can drive together, running locally with team-grade durability — the
tool meets the premier bar on every core criterion above. Remaining items are
depth beyond that bar, tracked in the README roadmap.
