#!/usr/bin/env node
/*
 * cli.js — ProjectDesk command line. Node stdlib only.
 *
 * Drives project plans through the same model + ops layer as the UI, so every
 * invariant holds no matter who edits. When the ProjectDesk server is running
 * (and the project is a bare name, not a file path), commands are sent through
 * its API — writes are then serialized in one process and the browser shows
 * them live within ~2s. Otherwise the project file is edited directly with a
 * disk-read-then-bump rev so change detection never misses an edit.
 *
 * Usage:
 *   node cli.js <project> <command> [args] [--json]
 *
 * <project> is a bare name (→ ./projects/<name>.json, server-managed) or a
 * path to any .json file (always edited directly).
 *
 * Read commands:
 *   show | schedule            task table (human) / full report (--json)
 *   summary                    one-line project status
 *   csv                        CSV to stdout
 *   export-xml                 Microsoft Project (MSPDI) XML to stdout
 *   import-xml <file.xml>      import a Microsoft Project XML file
 *
 * Write commands:
 *   init [--name N] [--start YYYY-MM-DD] [--sample]
 *   add --name "Task" [--duration 5d] [--after REF] [--child-of REF]
 *       [--preds "3FS+2,4"] [--res "Alice, Bob"] [--pct 50]
 *       [--deadline YYYY-MM-DD] [--start YYYY-MM-DD] [--notes "..."]
 *   set REF <field> <value>    field: name|duration|start|preds|res|pct|deadline|
 *                              actualstart|actualfinish|notes
 *                              (start sets a Start-No-Earlier-Than constraint)
 *   link REF REF...            [--type SS|FF|SF] [--lag N]
 *   unlink REF REF...
 *   indent REF...   / outdent REF...
 *   move REF up|down [--times N]
 *   delete REF...
 *   resource-add --name "Dev" [--rate 800]
 *   resource-rate <name> <rate>
 *   calendar [--working-days 1,2,3,4,5] [--holidays 2026-12-25,...]
 *   baseline set|clear
 *   status <YYYY-MM-DD|clear>  status date for behind-schedule tracking
 *   evm                        earned-value analysis (needs baseline + status)
 *   usage [--bucket day|week|month]  timephased resource work + over-allocation
 *   report                     one-page status report (health, milestones, risks)
 *   history / restore <rev>    version history (every save is a revision)
 *   comment REF "text"          add a comment to a task
 *   comments REF               list a task's comments
 *   activity                   recent change activity (server mode)
 *   ops-json '<json>'          apply a raw ops array (the API format, atomic)
 *
 * REF = row number (as displayed), "#id" (stable across edits — prefer in
 * scripts), "$N" (task created by result N of this batch), or exact task name.
 * Flags: --json machine output; --url http://host:port (default
 * PROJECTDESK_URL or http://127.0.0.1:4180); --local to force direct file mode.
 * Exit 0 on success, 1 on failure.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var Model = require('./js/model.js');
var Ops = require('./js/ops.js');

function die(msg) { process.stderr.write('error: ' + msg + '\n'); process.exit(1); }

// ---- argv ------------------------------------------------------------------
var argv = process.argv.slice(2);
var flags = {}, positional = [];
for (var i = 0; i < argv.length; i++) {
  var a = argv[i];
  if (a.slice(0, 2) === '--') {
    var key = a.slice(2);
    var next = argv[i + 1];
    if (next != null && next.slice(0, 2) !== '--') { flags[key] = next; i++; }
    else flags[key] = true;
  } else positional.push(a);
}
var JSON_OUT = !!flags.json;

if (positional.length < 1) {
  process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\s?/, '').replace(/^ \* ?/gm, '') + '\n');
  process.exit(0);
}

var projectArg = positional[0];
var command = positional[1] || 'show';
var rest = positional.slice(2);
var isFilePath = /\.json$/.test(projectArg) || projectArg.indexOf('/') >= 0;
var BASE_URL = String(flags.url || process.env.PROJECTDESK_URL || 'http://127.0.0.1:4180');

function out(objOrText) {
  if (typeof objOrText === 'string') process.stdout.write(objOrText + '\n');
  else process.stdout.write(JSON.stringify(objOrText, null, 2) + '\n');
}

// ---- local file mode -------------------------------------------------------
function projectFile() {
  if (isFilePath) return path.resolve(projectArg);
  return path.join(__dirname, 'projects', projectArg + '.json');
}

function loadModelLocal(requireExists) {
  var file = projectFile();
  var m = Model.createModel();
  if (fs.existsSync(file)) {
    var doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { die('could not parse ' + file + ': ' + e.message); }
    m.loadProject(doc);
  } else if (requireExists) {
    die('project not found: ' + file + ' (run "init" first)');
  } else {
    m.newProject();
  }
  return m;
}

// All disk writes go through store.js: locked, rev-bumped, atomic, snapshotted
// to history — identical behavior to the server's writes.
var Store = require('./store.js');

function withFileLock(file, fn) {
  try { return Store.withFileLock(file, fn); }
  catch (e) { die(e.message); }
}

function saveUnlocked(file, m) {
  var doc = m.toJSON();
  doc.lastEditor = 'local';
  doc.lastEditISO = new Date().toISOString();
  return Store.writeDocUnlocked(file, doc);
}

function saveModelLocal(m) {
  var file = projectFile();
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* exists */ }
  return withFileLock(file, function () { return saveUnlocked(file, m); });
}

// ---- server mode -----------------------------------------------------------
function apiRequest(method, apiPath, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var u;
    try { u = new URL(apiPath, BASE_URL); } catch (e) { return reject(e); }
    var payload = body != null ? JSON.stringify(body) : null;
    var req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        var json = null;
        try { json = JSON.parse(text); } catch (e) { /* csv or plain */ }
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 5000, function () { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function serverAvailable() {
  if (flags.local || isFilePath) return Promise.resolve(false);
  return apiRequest('GET', '/api/ping', null, 500)
    .then(function (r) { return !!(r.json && r.json.ok); })
    .catch(function () { return false; });
}

// ---- unified execution -----------------------------------------------------
function executeOps(ops) {
  return serverAvailable().then(function (up) {
    if (up) {
      return apiRequest('POST', '/api/projects/' + encodeURIComponent(projectArg) + '/ops',
        { ops: ops, createIfMissing: command === 'init' }).then(function (r) {
          if (!r.json) die('server returned non-JSON (' + r.status + ')');
          if (!r.json.ok) {
            if (JSON_OUT) { out(r.json); process.exit(1); }
            die(r.json.error + ' (op ' + r.json.failedIndex + ': ' + JSON.stringify(r.json.failedOp) + ')');
          }
          return { via: 'server', rev: r.json.rev, results: r.json.results, summary: r.json.summary };
        });
    }
    // File mode: the WHOLE read-modify-write runs under the lock — otherwise
    // two parallel writers read the same base and the second silently drops
    // the first one's edit even though the write itself is serialized.
    var file = projectFile();
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* exists */ }
    return withFileLock(file, function () {
      var m = loadModelLocal(true);
      var outcome = Ops.applyOps(m, ops, { author: 'local' });
      if (!outcome.ok) {
        if (JSON_OUT) { out({ ok: false, error: outcome.error, failedIndex: outcome.failedIndex, failedOp: outcome.failedOp }); process.exit(1); }
        die(outcome.error + ' (op ' + outcome.failedIndex + ')');
      }
      var rev = saveUnlocked(file, m); // atomic: only reached when every op succeeded
      return { via: 'file', rev: rev, results: outcome.results, summary: Ops.buildScheduleReport(m).project };
    });
  });
}

function fetchReport() {
  return serverAvailable().then(function (up) {
    if (up) {
      return apiRequest('GET', '/api/projects/' + encodeURIComponent(projectArg) + '/schedule').then(function (r) {
        if (r.status === 404) die('project "' + projectArg + '" not found on server');
        if (!r.json) die('server returned non-JSON (' + r.status + ')');
        return r.json;
      });
    }
    return Ops.buildScheduleReport(loadModelLocal(true));
  });
}

// ---- table rendering -------------------------------------------------------
function pad(s, w, right) {
  s = String(s == null ? '' : s);
  if (s.length > w) return s.slice(0, w - 1) + '…';
  var fill = new Array(w - s.length + 1).join(' ');
  return right ? fill + s : s + fill;
}

function printTable(rep) {
  var lines = [];
  lines.push(pad('#', 3, true) + '  ' + pad('WBS', 7) + pad('Task', 34) + pad('Dur', 5, true) + '  ' +
    pad('Start', 11) + pad('Finish', 11) + pad('Pred', 10) + pad('Res', 16) + pad('%', 4, true) +
    pad('Slack', 6, true) + '  ' + 'Flags');
  lines.push(new Array(120).join('-'));
  rep.tasks.forEach(function (t) {
    var indent = new Array(t.level).join('  ');
    var marks = [];
    if (t.critical) marks.push('CRIT');
    if (t.type === 'milestone') marks.push('MILE');
    if (t.type === 'summary') marks.push('SUM');
    if (t.deadlineMissed) marks.push('LATE!');
    if (t.overallocated.length) marks.push('OVER:' + t.overallocated.join('/'));
    lines.push(
      pad(t.row, 3, true) + '  ' + pad(t.wbs, 7) + pad(indent + t.name, 34) +
      pad(t.durationDays + 'd', 5, true) + '  ' +
      pad(t.startISO.slice(5), 11) + pad(t.finishISO.slice(5), 11) +
      pad(t.predecessors, 10) + pad(t.resources, 16) +
      pad(t.percentComplete, 4, true) + pad(t.slackDays == null ? '' : t.slackDays, 6, true) + '  ' +
      marks.join(' ')
    );
  });
  var p = rep.project;
  lines.push(new Array(120).join('-'));
  lines.push('finish ' + p.finishISO + ' · ' + p.workingDays + ' working days · $' + p.cost +
    (p.hasCycle ? ' · CYCLE!' : '') +
    (p.overallocatedResources ? ' · ' + p.overallocatedResources + ' overallocated' : '') +
    (p.missedDeadlines ? ' · ' + p.missedDeadlines + ' deadline(s) missed' : ''));
  out(lines.join('\n'));
}

function summaryLine(p) {
  return p.name + ': ' + p.taskCount + ' tasks, finish ' + p.finishISO + ', $' + p.cost +
    (p.hasCycle ? ', CYCLE' : '') +
    (p.missedDeadlines ? ', ' + p.missedDeadlines + ' late' : '') +
    (p.overallocatedResources ? ', ' + p.overallocatedResources + ' overallocated' : '');
}

// ---- commands --------------------------------------------------------------
function requireFlag(name) {
  if (flags[name] == null || flags[name] === true) die('--' + name + ' is required');
  return flags[name];
}

function reportWrite(r, human) {
  out(JSON_OUT ? { ok: true, via: r.via, rev: r.rev, results: r.results, summary: r.summary } : human(r) + ' (rev ' + r.rev + ', via ' + r.via + ')');
}

function main() {
  switch (command) {
    case 'init': {
      // init always writes the file directly (the server createIfMissing path
      // covers ops-based creation; init defines the starting document).
      var m = Model.createModel();
      if (flags.sample) m.loadSample(); else m.newProject();
      if (flags.name) m.setProjectName(String(flags.name));
      if (flags.start) m.setProjectStart(String(flags.start));
      var rev = saveModelLocal(m);
      out(JSON_OUT ? { ok: true, rev: rev, file: projectFile() } : 'initialized ' + projectFile() + ' (rev ' + rev + ')');
      return Promise.resolve();
    }

    case 'show':
    case 'schedule':
      return fetchReport().then(function (rep) { JSON_OUT ? out(rep) : printTable(rep); });

    case 'summary':
      return fetchReport().then(function (rep) { out(JSON_OUT ? rep.project : summaryLine(rep.project)); });

    case 'csv':
      return serverAvailable().then(function (up) {
        if (up) return apiRequest('GET', '/api/projects/' + encodeURIComponent(projectArg) + '/csv')
          .then(function (r) { process.stdout.write(r.text + '\n'); });
        process.stdout.write(loadModelLocal(true).toCSV() + '\n');
      });

    case 'add': {
      var op = { op: 'add-task', name: requireFlag('name') };
      if (flags.duration != null) op.duration = flags.duration;
      if (flags.after != null) op.after = flags.after;
      if (flags['child-of'] != null) op.childOf = flags['child-of'];
      if (flags.preds != null) op.predecessors = flags.preds;
      if (flags.res != null) op.resources = flags.res;
      if (flags.pct != null) op.percentComplete = flags.pct;
      if (flags.deadline != null) op.deadline = flags.deadline;
      if (flags.start != null) op.start = flags.start;
      if (flags.notes != null) op.notes = flags.notes;
      return executeOps([op]).then(function (r) {
        reportWrite(r, function (r) { return 'added row ' + r.results[0].row + ' (id #' + r.results[0].id + ')'; });
      });
    }

    case 'set': {
      if (rest.length < 3) die('usage: set REF <field> <value>');
      return executeOps([{ op: 'set', row: rest[0], field: rest[1], value: rest.slice(2).join(' ') }])
        .then(function (r) { reportWrite(r, function () { return 'set ' + rest[1] + ' on ' + rest[0]; }); });
    }

    case 'link':
    case 'unlink': {
      if (rest.length < (command === 'link' ? 2 : 1)) die('usage: ' + command + ' REF REF...');
      var lop = { op: command, rows: rest };
      if (command === 'link' && flags.type) lop.type = flags.type;
      if (command === 'link' && flags.lag) lop.lag = flags.lag;
      return executeOps([lop]).then(function (r) {
        reportWrite(r, function () { return command + 'ed ' + rest.join(' → '); });
      });
    }

    case 'indent':
    case 'outdent': {
      if (!rest.length) die('usage: ' + command + ' REF...');
      return executeOps([{ op: command, rows: rest }])
        .then(function (r) { reportWrite(r, function () { return command + 'ed ' + rest.join(', '); }); });
    }

    case 'move': {
      if (rest.length < 2) die('usage: move REF up|down [--times N]');
      return executeOps([{ op: 'move', row: rest[0], dir: rest[1], times: flags.times }])
        .then(function (r) { reportWrite(r, function (r) { return 'moved to row ' + r.results[0].row; }); });
    }

    case 'delete': {
      if (!rest.length) die('usage: delete REF...');
      return executeOps([{ op: 'delete', rows: rest }])
        .then(function (r) { reportWrite(r, function () { return 'deleted ' + rest.join(', '); }); });
    }

    case 'resource-add':
      return executeOps([{ op: 'add-resource', name: requireFlag('name'), rate: flags.rate }])
        .then(function (r) { reportWrite(r, function () { return 'added resource'; }); });

    case 'resource-rate': {
      if (rest.length < 2) die('usage: resource-rate <name> <rate>');
      return executeOps([{ op: 'set-resource', name: rest[0], rate: rest[1] }])
        .then(function (r) { reportWrite(r, function () { return 'rate set'; }); });
    }

    case 'calendar': {
      var cop = { op: 'set-calendar' };
      if (flags['working-days']) cop.workingDays = String(flags['working-days']).split(',').map(Number);
      if (flags.holidays) cop.holidays = String(flags.holidays).split(',');
      return executeOps([cop]).then(function (r) { reportWrite(r, function () { return 'calendar updated'; }); });
    }

    case 'history': {
      return serverAvailable().then(function (up) {
        var listP = up
          ? apiRequest('GET', '/api/projects/' + encodeURIComponent(projectArg) + '/history')
              .then(function (r) { if (!r.json) die('server returned non-JSON'); return r.json; })
          : Promise.resolve(Store.listHistory(projectFile()));
        return listP.then(function (list) {
          if (JSON_OUT) return out(list);
          if (!list.length) return out('no history yet — every save creates a revision');
          var lines = [pad('Rev', 5, true) + '  ' + pad('When', 26) + pad('Editor', 24) + 'Tasks'];
          lines.push(new Array(70).join('-'));
          list.forEach(function (e) {
            lines.push(pad(e.rev, 5, true) + '  ' + pad(e.ts, 26) + pad(e.editor, 24) + e.taskCount);
          });
          lines.push(new Array(70).join('-'));
          lines.push('restore any revision: node cli.js ' + projectArg + ' restore <rev>');
          out(lines.join('\n'));
        });
      });
    }

    case 'restore': {
      if (!rest.length || !/^\d+$/.test(rest[0])) die('usage: restore <rev>   (see "history" for revisions)');
      var fromRev = parseInt(rest[0], 10);
      return serverAvailable().then(function (up) {
        if (up) {
          return apiRequest('POST', '/api/projects/' + encodeURIComponent(projectArg) + '/restore', { rev: fromRev })
            .then(function (r) {
              if (!r.json || !r.json.ok) die((r.json && r.json.error) || ('restore failed (' + r.status + ')'));
              out(JSON_OUT ? r.json : 'restored rev ' + fromRev + ' as new rev ' + r.json.rev);
            });
        }
        var file = projectFile();
        var snap = Store.readSnapshot(file, fromRev);
        if (!snap) die('no snapshot for rev ' + fromRev);
        var m = Model.createModel();
        m.loadProject(snap);
        var rev = saveModelLocal(m);
        out(JSON_OUT ? { ok: true, rev: rev, restoredFrom: fromRev } : 'restored rev ' + fromRev + ' as new rev ' + rev);
      });
    }

    case 'risks': {
      return fetchReport().then(function (rep) {
        if (JSON_OUT) return out({ summary: rep.project.risks, risks: rep.risks });
        var lines = [pad('ID', 4, true) + '  ' + pad('Title', 34) + pad('Cat', 10) + pad('P', 2, true) + pad('I', 3, true) +
          pad('Score', 6, true) + '  ' + pad('Sev', 9) + pad('Status', 11) + pad('Owner', 14) + pad('Tasks', 10) + 'Review'];
        lines.push(new Array(110).join('-'));
        rep.risks.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (r) {
          var sev = r.score >= 15 ? 'CRITICAL' : r.score >= 10 ? 'high' : r.score >= 5 ? 'medium' : 'low';
          lines.push(pad(r.id, 4, true) + '  ' + pad(r.title, 34) + pad(r.category, 10) +
            pad(r.probability, 2, true) + pad(r.impact, 3, true) + pad(r.score, 6, true) + '  ' +
            pad(sev, 9) + pad(r.status, 11) + pad(r.owner, 14) +
            pad(r.taskRows.join(','), 10) + (r.reviewISO || ''));
        });
        var s = rep.project.risks || {};
        lines.push(new Array(110).join('-'));
        lines.push((s.open || 0) + ' open · ' + (s.mitigating || 0) + ' mitigating · ' + (s.closed || 0) + ' closed · ' +
          (s.realized || 0) + ' realized · exposure ' + (s.exposure || 0) + (s.critical ? ' · ' + s.critical + ' CRITICAL' : ''));
        out(lines.join('\n'));
      });
    }

    case 'risk-add': {
      var rop = { op: 'add-risk', title: requireFlag('title') };
      if (flags.desc != null) rop.description = flags.desc;
      if (flags.category != null) rop.category = flags.category;
      if (flags.p != null) rop.probability = flags.p;
      if (flags.i != null) rop.impact = flags.i;
      if (flags.owner != null) rop.owner = flags.owner;
      if (flags.status != null) rop.status = flags.status;
      if (flags.mitigation != null) rop.mitigation = flags.mitigation;
      if (flags.contingency != null) rop.contingency = flags.contingency;
      if (flags.review != null) rop.review = flags.review;
      if (flags.tasks != null) rop.tasks = String(flags.tasks).split(',');
      return executeOps([rop]).then(function (r) {
        reportWrite(r, function (r) { return 'added risk #' + r.results[0].riskId; });
      });
    }

    case 'risk-set': {
      if (rest.length < 3) die('usage: risk-set <id|title> <field> <value>');
      var sop = { op: 'set-risk', risk: rest[0] };
      var rf = rest[1] === 'p' ? 'probability' : rest[1] === 'i' ? 'impact' : rest[1];
      sop[rf] = rest.slice(2).join(' ');
      return executeOps([sop]).then(function (r) { reportWrite(r, function () { return 'risk updated'; }); });
    }

    case 'risk-link':
    case 'risk-unlink': {
      if (rest.length < 2) die('usage: ' + command + ' <id|title> TASKREF...');
      return executeOps([{ op: command === 'risk-link' ? 'link-risk' : 'unlink-risk', risk: rest[0], tasks: rest.slice(1) }])
        .then(function (r) { reportWrite(r, function () { return command + 'ed'; }); });
    }

    case 'risk-delete': {
      if (!rest.length) die('usage: risk-delete <id|title>');
      return executeOps([{ op: 'delete-risk', risk: rest[0] }])
        .then(function (r) { reportWrite(r, function () { return 'risk deleted'; }); });
    }

    case 'comment': {
      if (rest.length < 2) die('usage: comment REF "text"');
      return executeOps([{ op: 'comment', row: rest[0], text: rest.slice(1).join(' ') }])
        .then(function (r) { reportWrite(r, function () { return 'comment added'; }); });
    }

    case 'comments': {
      if (!rest.length) die('usage: comments REF');
      return fetchReport().then(function (rep) {
        var ref = rest[0];
        var task = rep.tasks.filter(function (t) {
          return String(t.row) === ref || ('#' + t.id) === ref || t.name.toLowerCase() === ref.toLowerCase();
        })[0];
        if (!task) die('no task "' + ref + '"');
        if (JSON_OUT) return out(task.comments || []);
        if (!task.comments || !task.comments.length) return out('no comments on ' + task.name);
        out('Comments on ' + task.row + ' — ' + task.name + ':');
        task.comments.forEach(function (c) {
          out('  #' + c.id + '  ' + (c.ts ? c.ts.slice(0, 16).replace('T', ' ') : '') + '  ' + c.author);
          out('       ' + c.text);
        });
      });
    }

    case 'activity': {
      return serverAvailable().then(function (up) {
        if (!up) die('activity feed needs the server running');
        return apiRequest('GET', '/api/projects/' + encodeURIComponent(projectArg) + '/activity')
          .then(function (r) {
            var list = r.json || [];
            if (JSON_OUT) return out(list);
            if (!list.length) return out('no activity recorded yet');
            list.forEach(function (e) {
              var what = e.action + (e.ops ? ' [' + e.ops.join(',') + ']' : '') + (e.rev ? ' -> rev ' + e.rev : '');
              out((e.ts ? e.ts.slice(0, 16).replace('T', ' ') : '') + '  ' + pad(e.email || '', 22) + what);
            });
          });
      });
    }

    case 'import-xml': {
      if (!rest.length) die('usage: import-xml <file.xml>   (creates/overwrites the named project)');
      var Mspdi = require('./js/mspdi.js');
      var xmlText;
      try { xmlText = fs.readFileSync(path.resolve(rest[0]), 'utf8'); }
      catch (e) { die('cannot read ' + rest[0] + ': ' + e.message); }
      var doc;
      try { doc = Mspdi.fromXml(xmlText); } catch (e) { die('import failed: ' + e.message); }
      // Normalize through the model, then persist as the target project.
      var mi = Model.createModel(); mi.loadProject(doc);
      var normalized = mi.toJSON();
      return serverAvailable().then(function (up) {
        if (up) return apiRequest('PUT', '/api/projects/' + encodeURIComponent(projectArg), normalized)
          .then(function (r) {
            if (!r.json || !r.json.ok) die((r.json && r.json.error) || ('import failed (' + r.status + ')'));
            out(JSON_OUT ? r.json : 'imported ' + normalized.tasks.length + ' tasks into "' + projectArg + '" (rev ' + r.json.rev + ')');
          });
        var rev = saveModelLocal(mi);
        out(JSON_OUT ? { ok: true, rev: rev, tasks: normalized.tasks.length } : 'imported ' + normalized.tasks.length + ' tasks (rev ' + rev + ')');
      });
    }

    case 'export-xml': {
      return serverAvailable().then(function (up) {
        if (up) return apiRequest('GET', '/api/projects/' + encodeURIComponent(projectArg) + '/mspdi')
          .then(function (r) { process.stdout.write(r.text + '\n'); });
        var Mspdi = require('./js/mspdi.js');
        process.stdout.write(Mspdi.toXml(loadModelLocal(true)) + '\n');
      });
    }

    case 'evm': {
      return serverAvailable().then(function (up) {
        var evmP = up
          ? apiRequest('GET', '/api/projects/' + encodeURIComponent(projectArg) + '/schedule')
              .then(function (r) { if (!r.json) die('server returned non-JSON'); return r.json.project.evm; })
          // Local mode builds the SAME report evm shape (rounded indices +
          // per-task array) so output is identical whether the server is up.
          : Promise.resolve(Ops.buildScheduleReport(loadModelLocal(true)).project.evm);
        return evmP.then(function (e) {
          if (JSON_OUT) return out(e);
          if (!e) return out('Earned value needs both a baseline (Set Baseline) and a status date (status <date>).');
          function money(n) { return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
          function idx(v) { return v == null ? 'n/a' : (Math.round(v * 100) / 100).toFixed(2); }
          out('Earned value as of ' + (e.statusISO || '?') + ' (baseline ' + (e.baselineISO || '?') + ')');
          out('  SPI ' + idx(e.spi) + '   CPI ' + idx(e.cpi) + (e.spi != null && e.spi < 0.9 ? '   << schedule slipping' : ''));
          out('  BAC ' + money(e.bac) + '   PV ' + money(e.pv) + '   EV ' + money(e.ev) + '   AC ' + money(e.ac));
          out('  SV ' + money(e.sv) + '   CV ' + money(e.cv) +
              (e.eac != null ? '   EAC ' + money(e.eac) + '   VAC ' + money(e.vac) : ''));
          if (e.tasks && e.tasks.length) {
            var worst = e.tasks.filter(function (t) { return t.spi != null && t.spi < 1; })
              .sort(function (a, b) { return a.spi - b.spi; }).slice(0, 5);
            if (worst.length) {
              out('  Worst schedule performers:');
              worst.forEach(function (t) {
                out('    ' + pad(t.row, 3, true) + ' ' + pad(t.name, 30) + ' SPI ' + idx(t.spi) + '  CPI ' + idx(t.cpi));
              });
            }
          }
        });
      });
    }

    case 'usage': {
      var bucket = String(flags.bucket || 'week');
      if (['day', 'week', 'month'].indexOf(bucket) < 0) die('usage: usage [--bucket day|week|month]');
      return serverAvailable().then(function (up) {
        var uP = up
          ? apiRequest('GET', '/api/projects/' + encodeURIComponent(projectArg) + '/usage?bucket=' + bucket)
              .then(function (r) { if (!r.json || r.json.error) die((r.json && r.json.error) || 'server returned non-JSON'); return r.json; })
          : Promise.resolve(require('./js/usage.js').build(loadModelLocal(true), { bucket: bucket }));
        return uP.then(function (u) {
          if (JSON_OUT) return out(u);
          function money(n) { return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
          function hrs(n) { return n ? String(Math.round(n)) : '·'; }
          if (!u.resources.length) return out('No resources assigned yet — nothing to spread across the calendar.');
          // Show at most ~12 buckets so the terminal table stays readable.
          var cols = u.buckets, note = '';
          if (cols.length > 12) { cols = u.buckets.slice(0, 12); note = ' (+' + (u.buckets.length - 12) + ' more — use --bucket month or --json)'; }
          out('Resource usage by ' + u.bucket + ' — hours (! = over-allocated)' + note);
          out('  ' + pad('Resource', 18) + cols.map(function (b) { return pad(b.label, 10, true); }).join('') + pad('Total', 8, true) + '  Peak');
          u.resources.forEach(function (r) {
            var line = '  ' + pad((r.overallocated ? '⚠ ' : '') + r.name, 18);
            line += cols.map(function (b, i) {
              var c = r.cells[i];
              return pad(hrs(c.hours) + (c.over ? '!' : ''), 10, true);
            }).join('');
            line += pad(hrs(r.totalHours), 8, true) + '  ' + (r.peakDaily > 1 ? (r.peakDaily + '×') : '1×');
            out(line);
          });
          out('  ' + pad('TOTAL', 18) + cols.map(function (b, i) { return pad(hrs(u.totals.perBucket[i].hours), 10, true); }).join('') + pad(hrs(u.totals.hours), 8, true));
          out('  Labor cost ' + money(u.totals.cost) + (u.overallocatedCount ? ('   ·   ' + u.overallocatedCount + ' resource(s) over-allocated') : ''));
        });
      });
    }

    case 'report': {
      return serverAvailable().then(function (up) {
        var rP = up
          ? apiRequest('GET', '/api/projects/' + encodeURIComponent(projectArg) + '/report')
              .then(function (r) { if (!r.json || r.json.error) die((r.json && r.json.error) || 'server returned non-JSON'); return r.json; })
          : Promise.resolve(require('./js/report.js').build(loadModelLocal(true)));
        return rP.then(function (rp) {
          if (JSON_OUT) return out(rp);
          function money(n) { return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
          var p = rp.project, h = rp.health;
          out('PROJECT STATUS — ' + p.name + '  (as of ' + rp.asOfISO + (rp.usingStatusDate ? ', status date' : '') + ')');
          out('  ' + p.pctComplete + '% complete · finish ' + p.finishISO +
            (p.finishVarianceDays != null && p.finishVarianceDays !== 0
              ? ' (' + (p.finishVarianceDays > 0 ? '+' : '') + p.finishVarianceDays + 'd vs baseline ' + p.baselineFinishISO + ')' : '') +
            ' · cost ' + money(p.cost) + ' · ' + p.taskCount + ' tasks, ' + p.milestoneCount + ' milestone(s)');
          var flags = [];
          if (h.hasCycle) flags.push('DEPENDENCY CYCLE');
          if (h.behindCount) flags.push(h.behindCount + ' behind schedule');
          if (h.missedDeadlines) flags.push(h.missedDeadlines + ' missed deadline(s)');
          if (h.lateMilestones) flags.push(h.lateMilestones + ' late milestone(s)');
          if (h.constraintConflicts) flags.push(h.constraintConflicts + ' constraint conflict(s)');
          if (h.overallocatedCount) flags.push(h.overallocatedCount + ' over-allocated resource(s)');
          if (h.criticalRisks) flags.push(h.criticalRisks + ' critical risk(s)');
          out('  Health: ' + (flags.length ? '⚠ ' + flags.join(' · ') : '✓ no flags') +
            (h.spi != null ? '   SPI ' + h.spi.toFixed(2) + ' CPI ' + (h.cpi != null ? h.cpi.toFixed(2) : 'n/a') : ''));
          if (rp.milestones.length) {
            out('  Milestones:');
            rp.milestones.forEach(function (ms) {
              out('    ' + (ms.done ? '✓' : ms.late ? '✗' : '·') + ' ' + ms.dateISO + '  ' + ms.name + (ms.late ? '  LATE' : ''));
            });
          }
          if (rp.behind.count) {
            out('  Behind schedule (' + rp.behind.count + '):');
            rp.behind.tasks.forEach(function (t) {
              out('    ' + pad(t.row, 3, true) + ' ' + pad(t.name, 30) + ' ' + t.percentComplete + '% vs ' + t.expectedPct + '% expected');
            });
          }
          if (rp.upcoming.count) {
            out('  Starting soon (' + rp.upcoming.count + '):');
            rp.upcoming.tasks.forEach(function (t) {
              out('    ' + pad(t.row, 3, true) + ' ' + pad(t.name, 30) + ' starts ' + t.startISO +
                (t.resources.length ? '  (' + t.resources.join(', ') + ')' : ''));
            });
          }
          if (rp.risks.activeCount) {
            out('  Top risks (' + rp.risks.activeCount + ' active):');
            rp.risks.top.forEach(function (k) {
              out('    [' + k.severity.toUpperCase() + ' ' + k.score + '] ' + k.title + (k.owner ? ' — ' + k.owner : ''));
            });
          }
          out('  Critical path: ' + rp.critical.count + ' task(s); resources: ' +
            (rp.resources.length ? rp.resources.map(function (x) { return x.name + ' ' + Math.round(x.totalDays) + 'd' + (x.overallocated ? '(!)' : ''); }).join(', ') : 'none'));
        });
      });
    }

    case 'status': {
      if (!rest.length) die('usage: status <YYYY-MM-DD | clear>');
      var statusVal = rest[0] === 'clear' ? null : rest[0];
      return executeOps([{ op: 'set-project', status: statusVal }])
        .then(function (r) { reportWrite(r, function () { return statusVal ? 'status date set to ' + statusVal : 'status date cleared'; }); });
    }

    case 'baseline': {
      if (rest[0] !== 'set' && rest[0] !== 'clear') die('usage: baseline set|clear');
      return executeOps([{ op: rest[0] === 'set' ? 'set-baseline' : 'clear-baseline' }])
        .then(function (r) { reportWrite(r, function () { return 'baseline ' + rest[0]; }); });
    }

    case 'ops-json': {
      if (!rest.length) die('usage: ops-json \'[{"op":"add-task",...}]\'');
      var parsed;
      try { parsed = JSON.parse(rest.join(' ')); } catch (e) { die('invalid ops JSON: ' + e.message); }
      return executeOps(Array.isArray(parsed) ? parsed : [parsed]).then(function (r) {
        out({ ok: true, via: r.via, applied: r.results.length, results: r.results, rev: r.rev, summary: r.summary });
      });
    }

    default:
      die('unknown command "' + command + '" — run with no arguments for usage');
      return Promise.resolve();
  }
}

main().catch(function (e) { die((e && e.message) || String(e)); });
