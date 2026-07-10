/* Tests for the HTTP API. Uses an ephemeral port + temp projects dir.
 * node tests/server.test.js */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');

// Isolate project storage BEFORE requiring the server.
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'projectdesk-test-'));
process.env.PROJECTDESK_PROJECTS_DIR = TMP;

var Server = require('../server.js');
var Model = require('../js/model.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

var server = Server.createServer();
var PORT;

function req(method, p, body, headers) {
  return new Promise(function (resolve, reject) {
    var payload = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    var h = Object.assign({}, headers || {});
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    var r = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method: method, headers: h }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        var json = null;
        try { json = JSON.parse(text); } catch (e) { /* non-json */ }
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function sampleDoc() {
  var m = Model.createModel();
  m.loadSample();
  return m.toJSON();
}

async function main() {
  await new Promise(function (res) { server.listen(0, '127.0.0.1', res); });
  PORT = server.address().port;

  // ping
  var r = await req('GET', '/api/ping');
  eq(r.status, 200, 'ping 200');
  eq(r.json.service, 'projectdesk', 'ping service name');

  // empty list
  r = await req('GET', '/api/projects');
  eq(r.json, [], 'empty project list');

  // invalid name rejected
  r = await req('GET', '/api/projects/..%2Fevil');
  ok(r.status === 400 || r.status === 404, 'traversal-ish name rejected: ' + r.status);

  // PUT invalid JSON
  r = await req('PUT', '/api/projects/alpha', '{nope');
  eq(r.status, 400, 'invalid JSON 400');

  // PUT non-project doc
  r = await req('PUT', '/api/projects/alpha', { hello: 1 });
  eq(r.status, 400, 'non-project doc 400');

  // PUT real doc -> rev 1
  r = await req('PUT', '/api/projects/alpha', sampleDoc());
  eq(r.status, 200, 'PUT 200');
  eq(r.json.rev, 1, 'first rev is 1');

  // GET doc + rev endpoint
  r = await req('GET', '/api/projects/alpha');
  eq(r.status, 200, 'GET doc 200');
  eq(r.json.rev, 1, 'doc carries rev');
  eq(r.json.tasks.length, 14, 'sample tasks stored');
  r = await req('GET', '/api/projects/alpha/rev');
  eq(r.json, { rev: 1 }, 'rev endpoint');

  // Conditional PUT: matching If-Match succeeds, stale 409s
  r = await req('PUT', '/api/projects/alpha', sampleDoc(), { 'If-Match': '1' });
  eq(r.status, 200, 'If-Match current rev accepted');
  eq(r.json.rev, 2, 'rev bumped to 2');
  r = await req('PUT', '/api/projects/alpha', sampleDoc(), { 'If-Match': '1' });
  eq(r.status, 409, 'stale If-Match 409');
  eq(r.json.rev, 2, '409 reports server rev');

  // Schedule report
  r = await req('GET', '/api/projects/alpha/schedule');
  eq(r.status, 200, 'schedule 200');
  ok(r.json.project && r.json.tasks.length === 14, 'schedule report shape');
  ok(r.json.tasks.some(function (t) { return t.critical; }), 'critical path present');

  // CSV
  r = await req('GET', '/api/projects/alpha/csv');
  ok(r.text.indexOf('WBS,Task Name') === 0, 'csv served');

  // Ops: atomic success
  r = await req('POST', '/api/projects/alpha/ops', {
    ops: [
      { op: 'add-task', name: 'From API', duration: '3d' },
      { op: 'link', rows: [14, '$0'] }
    ]
  });
  eq(r.status, 200, 'ops 200');
  eq(r.json.applied, 2, 'both ops applied');
  eq(r.json.rev, 3, 'ops bumped rev');
  ok(r.json.summary && r.json.summary.taskCount === 15, 'summary reflects new task');

  // Ops: atomic FAILURE — nothing persists, failedIndex reported
  var revBefore = (await req('GET', '/api/projects/alpha/rev')).json.rev;
  r = await req('POST', '/api/projects/alpha/ops', {
    ops: [
      { op: 'add-task', name: 'should not persist' },
      { op: 'set', row: 999, field: 'duration', value: '9' }
    ]
  });
  eq(r.status, 422, 'failed batch 422');
  eq(r.json.ok, false, 'ok false');
  eq(r.json.failedIndex, 1, 'failedIndex 1');
  eq(r.json.applied, 0, 'applied reported as 0 (atomic)');
  var after = await req('GET', '/api/projects/alpha');
  eq(after.json.rev, revBefore, 'rev unchanged after failed batch');
  ok(!after.json.tasks.some(function (t) { return t.name === 'should not persist'; }),
    'prefix task NOT persisted (atomic rollback)');

  // Ops on missing project: 404 without createIfMissing, creates with it
  r = await req('POST', '/api/projects/beta/ops', { ops: [{ op: 'add-task', name: 'First' }] });
  eq(r.status, 404, 'ops on missing project 404');
  r = await req('POST', '/api/projects/beta/ops', { createIfMissing: true, ops: [{ op: 'add-task', name: 'First' }] });
  eq(r.status, 200, 'createIfMissing 200');
  eq(r.json.rev, 1, 'beta rev 1');

  // List shows both
  r = await req('GET', '/api/projects');
  eq(r.json.length, 2, 'two projects listed');

  // Static: index served; traversal blocked
  r = await req('GET', '/');
  ok(/ProjectDesk/.test(r.text), 'index.html served');
  r = await req('GET', '/js/model.js');
  ok(/createModel/.test(r.text), 'static js served');
  r = await req('GET', '/../.claude/launch.json');
  ok(r.status === 403 || r.status === 404, 'path traversal blocked: ' + r.status);
  r = await req('GET', '/%2e%2e/%2e%2e/etc/hosts');
  ok(r.status === 403 || r.status === 404, 'encoded traversal blocked: ' + r.status);
  r = await req('GET', '/projects/alpha.json');
  eq(r.status, 403, 'project files not served statically');

  // REVIEW FIX: beacon-style POST to the document path saves unconditionally
  var beaconDoc = sampleDoc();
  beaconDoc.name = 'beacon-flushed';
  r = await req('POST', '/api/projects/alpha', beaconDoc);
  eq(r.status, 200, 'beacon POST accepted');
  r = await req('GET', '/api/projects/alpha');
  eq(r.json.name, 'beacon-flushed', 'beacon content persisted');

  // REVIEW FIX: concurrent same-file writes serialize on the lockfile —
  // N parallel CLI-style writers must produce N distinct revs (no lost update).
  var cp = require('child_process');
  var cliPath = path.join(__dirname, '..', 'cli.js');
  var projFile = path.join(TMP, 'race.json');
  cp.execFileSync('node', [cliPath, projFile, 'init'], { stdio: 'pipe' });
  var procs = [];
  for (var pi = 0; pi < 4; pi++) {
    procs.push(new Promise(function (resolve) {
      cp.execFile('node', [cliPath, projFile, 'add', '--name', 'race-task', '--local'],
        function (err) { resolve(!err); });
    }));
  }
  var oks = await Promise.all(procs);
  ok(oks.every(Boolean), 'all 4 parallel CLI writers succeeded');
  var raceDoc = JSON.parse(fs.readFileSync(projFile, 'utf8'));
  eq(raceDoc.tasks.length, 4, 'no lost update: all 4 tasks present');
  eq(raceDoc.rev, 5, 'rev advanced once per write (init + 4 adds)');

  // DELETE
  r = await req('DELETE', '/api/projects/beta');
  eq(r.status, 200, 'delete 200');
  r = await req('GET', '/api/projects/beta');
  eq(r.status, 404, 'deleted project gone');

  await new Promise(function (res) { server.close(res); });
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }

  console.log('\nServer tests: ' + passed + ' passed, ' + failed + ' failed.');
  if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
}

main().catch(function (e) {
  console.error('server test crashed:', e);
  process.exit(1);
});
