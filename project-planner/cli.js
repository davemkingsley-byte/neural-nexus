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
 *
 * Write commands:
 *   init [--name N] [--start YYYY-MM-DD] [--sample]
 *   add --name "Task" [--duration 5d] [--after REF] [--child-of REF]
 *       [--preds "3FS+2,4"] [--res "Alice, Bob"] [--pct 50]
 *       [--deadline YYYY-MM-DD] [--start YYYY-MM-DD] [--notes "..."]
 *   set REF <field> <value>    field: name|duration|start|preds|res|pct|deadline|notes
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

// Disk-read-then-bump rev under an exclusive lockfile, so concurrent writers
// (parallel CLI invocations, or CLI alongside the server's own file writes)
// serialize instead of interleaving read-rev -> rename and losing updates.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { var end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

function withFileLock(file, fn) {
  var lock = file + '.lock';
  var fd = null, tries = 0;
  while (fd === null) {
    try { fd = fs.openSync(lock, 'wx'); }
    catch (e) {
      if (++tries > 100) die('project file is locked (' + lock + ' — remove it if stale)');
      sleepSync(20);
    }
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch (e) { /* best effort */ }
    try { fs.unlinkSync(lock); } catch (e) { /* best effort */ }
  }
}

function saveUnlocked(file, m) {
  var diskRev = 0;
  try { diskRev = JSON.parse(fs.readFileSync(file, 'utf8')).rev || 0; } catch (e) { /* new file */ }
  var doc = m.toJSON();
  doc.rev = diskRev + 1;
  var tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
  return doc.rev;
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
      var outcome = Ops.applyOps(m, ops);
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
