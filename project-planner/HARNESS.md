# ProjectDesk as an AI harness

ProjectDesk is designed to be driven programmatically — by an AI agent, a
script, or CI — through the **same model layer the human UI uses**, so every
invariant (outline consistency, dependency validation, schedule recompute,
cost roll-up) holds no matter who edits. A human watching the browser sees AI
edits appear live within ~2 seconds.

There are three equivalent interfaces, all built on `js/ops.js`:

| Interface | Best for | Entry point |
|---|---|---|
| CLI | shell-driven agents, quick edits | `node cli.js <project> <command>` |
| HTTP API | anything that speaks JSON | `POST /api/projects/:name/ops` |
| Direct module | Node programs, tests | `require('./js/ops.js')` |

## Quick start

```bash
node server.js --port 4180          # serves the UI + API; plans live in projects/*.json
open http://localhost:4180/         # human view (add ?project=NAME for others)

node cli.js current summary         # one-line status
node cli.js current show            # full task table
node cli.js current add --name "Write spec" --duration 5d --res "Alex"
node cli.js current link 3 4        # 4 starts after 3 finishes
node cli.js current set 4 pct 50
```

When the server is running, CLI writes go through the API (single writer, live
browser update). Without a server, the CLI edits `projects/<name>.json`
directly — same result, no live view. `--local` forces file mode; `--url` /
`PROJECTDESK_URL` point at a non-default server.

## The ops format (the AI's native interface)

A batch is a JSON array of op objects. **Batches are atomic**: if any op
fails, nothing is persisted and the response tells you `failedIndex`, the
echoed `failedOp`, and an `error` explaining exactly what was wrong — fix that
op and resubmit the whole batch.

```bash
curl -s -X POST localhost:4180/api/projects/current/ops \
  -H 'Content-Type: application/json' \
  -d '{"createIfMissing": true, "ops": [
    {"op":"add-task", "name":"Phase 1", "duration":0},
    {"op":"add-task", "name":"Design",  "duration":"5d", "childOf":"$0"},
    {"op":"add-task", "name":"Build",   "duration":"2w", "after":"$1"},
    {"op":"link", "rows":["$1","$2"]},
    {"op":"add-resource", "name":"Dev Team", "rate":1200},
    {"op":"set", "row":"$2", "field":"res", "value":"Dev Team"}
  ]}'
```

The response includes the applied results, the new `rev`, and a `summary`
(finish date, cost, critical count, warnings) so one round trip tells you what
your edit did to the schedule.

### Task references

| Form | Meaning | Stability |
|---|---|---|
| `7` | row number as displayed | shifts as rows are added/moved — fine interactively |
| `"#12"` | task id | **stable forever — use this in scripts/batches** |
| `"$2"` | task created by result 2 (0-based) of *this* batch — must be an `add-task` result (a `$N` pointing at any other op errors) | within-batch only |
| `"Design"` | exact name (case-insensitive) | errors if ambiguous, listing candidate ids |

Each op re-resolves refs against the *current* state (earlier ops in the batch
have already applied).

### Op reference

| Op | Fields | Notes |
|---|---|---|
| `add-task` | `name`, `duration?`, `after?`, `childOf?`, `predecessors?`, `resources?`, `percentComplete?`, `deadline?`, `start?`, `notes?` | `after` inserts directly after that row; `childOf` inserts as first child, one level deeper. Duration `"5d"`, `"2w"`, `"1mo"`, `0` = milestone. |
| `set` | `row`/`id`/`ref`, `field`, `value` | fields: `name`, `duration`, `start`, `predecessors`, `resources`, `percentComplete`(/`pct`), `deadline`, `notes`. **`start` sets a Start-No-Earlier-Than constraint**, not a literal start date — the scheduler still owns dates. |
| `link` | `rows` (≥2), `type?`, `lag?` | chains each pair; type FS/SS/FF/SF, lag in working days (negative = lead) |
| `unlink` | `rows` | removes links among the given tasks |
| `indent` / `outdent` | `rows` | builds/dissolves summary hierarchy |
| `move` | `row`, `dir` (`up`/`down`), `times?` | moves a task with its whole subtree |
| `delete` | `rows` | also strips dangling predecessor refs |
| `add-resource` | `name`, `rate?` | rate = cost per working day |
| `set-resource` | `name`/`id`, `rate?`, `rename?` | |
| `set-project` | `name?`, `start?` | |
| `set-calendar` | `workingDays?` (0=Sun..6=Sat), `holidays?` (ISO dates) | |
| `set-baseline` / `clear-baseline` | — | snapshot for variance tracking |
| `set-project` | `name?`, `start?`, `status?` | `status` = status date (`null`/`""` clears) |
| `comment` | `row`/`ref`, `text` | author is stamped from the caller's identity — an op-supplied `author` is ignored |
| `delete-comment` | `row`/`ref`, `commentId` | |
| `add-risk` / `set-risk` / `link-risk` / `unlink-risk` / `delete-risk` | see risk fields | 5×5 P×I risk register |
| `toggle-collapse` | `row` | view-only |

`set` fields also include `actualstart` / `actualfinish` (record what really
happened — pins the schedule to reality and forces 100% on finish).

### Predecessor string syntax

`"3"` (FS), `"3FS+2"` (finish-to-start, 2-day lag), `"2SS"`, `"4FF-1"` —
comma-separated for multiple. Row numbers refer to display order.

## Reading the plan back

```bash
node cli.js current show --json          # or:
curl -s localhost:4180/api/projects/current/schedule
```

Returns `{project, resources, tasks[]}` where each task carries `row`, `id`,
`wbs`, `level`, `type` (task/summary/milestone), computed `startISO`/`finishISO`,
`predecessors`, `resources`, `percentComplete`, `cost`, `slackDays`,
`critical`, `constraintISO`, `deadlineISO`, `deadlineMissed`, `overallocated`,
`notes`. `project` carries finish, working-day count, total cost, cycle flag,
over-allocation and missed-deadline counts — everything needed to reason about
schedule health without re-deriving it.

## Full API

| Method + path | Purpose |
|---|---|
| `GET /api/ping` | server identity `{ok, service:"projectdesk", version}` |
| `GET /api/projects` | list projects `{name, displayName, rev, taskCount, updatedISO}` |
| `GET /api/projects/:name` | full document |
| `GET /api/projects/:name/rev` | `{rev}` — cheap change detection |
| `GET /api/projects/:name/schedule` | computed schedule report (above) |
| `GET /api/projects/:name/csv` | CSV export |
| `GET /api/projects/:name/mspdi` | Microsoft Project XML export |
| `GET /api/projects/:name/usage` | timephased resource usage (`?bucket=day\|week\|month`, default week) — per-resource work/cost per bucket + peak daily load + over-allocation flags |
| `POST /api/projects/:name/import` | body = MS Project XML → creates/replaces the project `{ok, rev, tasks}`; `400` on malformed XML |
| `PUT /api/projects/:name` | replace document; optional `If-Match: <rev>` header → `409 {rev}` on mismatch |
| `POST /api/projects/:name/ops` | `{ops:[...], createIfMissing?}` — atomic batch |
| `GET /api/projects/:name/history` | list revisions `{rev, ts, editor, taskCount}` (newest first) |
| `GET /api/projects/:name/history/:rev` | one snapshot document (`?summary=1` → schedule summary) |
| `POST /api/projects/:name/restore` | `{rev}` — re-save an old revision as a new rev (nothing overwritten) |
| `GET /api/projects/:name/activity` | audit trail, newest first `{ts, email, action, ops?, rev}` |
| `DELETE /api/projects/:name` | remove project (snapshots survive → restorable) |

## Concurrency model (what an AI must know)

- Every persisted write bumps `rev` (disk-read-then-bump under an exclusive
  `<file>.lock`, atomic tmp+rename). Two writers can never mint the same rev
  for different content — this holds across processes (server, parallel CLI
  invocations, `--local` CLI beside a running server). If a writer crashes
  mid-write, delete the stale `.lock` file it left behind.
- The browser autosaves with `If-Match`; on `409` it adopts the server version
  and tells the human their last edit was discarded. **Your write is never
  silently clobbered** — worst case the human retypes one cell edit.
- The browser polls `/rev` every 2s and reloads external changes live
  (selection preserved; the human's zoom/collapse view state never syncs, so
  your edits won't disturb how they're looking at the plan).
- Prefer the ops endpoint over PUT for edits: it's atomic, validated,
  row-addressable, and returns the schedule summary in the same round trip.
- A reloaded plan resets the human's undo history (by design — undoing across
  your edit would revert it). Batch your related ops so this happens once,
  not per-field.

## Guarantees & limits

- All mutations run through `js/model.js` — malformed input is rejected or
  normalized (bad durations, self-dependencies, duplicate resources, outline
  jumps), and dependency cycles are detected and reported, never crash.
- Project names: `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. Documents cap at 10 MB.
- The server is single-process and binds 127.0.0.1 by default — it is a local
  tool, not a multi-user web service.
- Tests: `node tests/run-all.js` (ops + API contracts covered in
  `tests/ops.test.js` and `tests/server.test.js`).
