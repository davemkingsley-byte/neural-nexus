/* Tests for version history: snapshots, listing, restore, prune.
 * node tests/history.test.js */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'projectdesk-hist-'));
process.env.PROJECTDESK_PROJECTS_DIR = TMP;
process.env.PROJECTDESK_HISTORY_CAP = '5'; // small cap to exercise pruning

var Store = require('../store.js');
var Server = require('../server.js');
var Model = require('../js/model.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

function doc(name, taskNames) {
  var m = Model.createModel();
  m.newProject();
  m.setProjectName(name);
  taskNames.forEach(function (n) { var id = m.addTaskEnd(); m.setField(id, 'name', n); });
  return m.toJSON();
}

// ---- store-level: snapshot + list + read + prune ----
(function () {
  var file = path.join(TMP, 'alpha.json');
  var r1 = Store.writeDoc(file, doc('Alpha', ['one']));
  var r2 = Store.writeDoc(file, doc('Alpha', ['one', 'two']));
  var r3 = Store.writeDoc(file, doc('Alpha', ['one', 'two', 'three']));
  eq([r1, r2, r3], [1, 2, 3], 'revs increment');

  var list = Store.listHistory(file);
  eq(list.map(function (e) { return e.rev; }), [3, 2, 1], 'history newest first');
  eq(list[0].taskCount, 3, 'index records task count');

  var snap2 = Store.readSnapshot(file, 2);
  eq(snap2.tasks.length, 2, 'snapshot content preserved');
  eq(snap2.rev, 2, 'snapshot carries its rev');
  ok(Store.readSnapshot(file, 99) === null, 'missing snapshot -> null');
  ok(Store.readSnapshot(file, '../../etc/passwd') === null, 'non-numeric rev rejected');

  // prune: cap is 5; write up to rev 8 -> only 5 newest snapshots remain
  for (var i = 4; i <= 8; i++) Store.writeDoc(file, doc('Alpha', ['x']));
  var list2 = Store.listHistory(file);
  eq(list2.length, 5, 'prune keeps cap');
  eq(list2[0].rev, 8, 'newest kept');
  eq(list2[list2.length - 1].rev, 4, 'oldest kept is rev 4');
  ok(Store.readSnapshot(file, 1) === null, 'pruned snapshot gone');
})();

// ---- HTTP API: history list, snapshot fetch, restore (new rev), roles ----
var server = Server.createServer();
Server._setAuthConfig(null); // local-only in this test
var PORT;

function req(method, p, body, headers) {
  return new Promise(function (resolve, reject) {
    var payload = body != null ? JSON.stringify(body) : null;
    var h = Object.assign({}, headers || {});
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    var r = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method: method, headers: h }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        var json = null; try { json = JSON.parse(text); } catch (e) { /* */ }
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function main() {
  await new Promise(function (res) { server.listen(0, '127.0.0.1', res); });
  PORT = server.address().port;

  // three revisions of project beta
  await req('PUT', '/api/projects/beta', doc('Beta', ['a']));
  await req('PUT', '/api/projects/beta', doc('Beta', ['a', 'b']));
  await req('PUT', '/api/projects/beta', doc('Beta', ['a', 'b', 'c']));

  var r = await req('GET', '/api/projects/beta/history');
  eq(r.status, 200, 'history list 200');
  eq(r.json.map(function (e) { return e.rev; }), [3, 2, 1], 'API history newest first');
  eq(r.json[0].editor, 'local', 'editor stamped in history');

  r = await req('GET', '/api/projects/beta/history/2');
  eq(r.status, 200, 'snapshot fetch 200');
  eq(r.json.tasks.length, 2, 'snapshot doc returned');

  r = await req('GET', '/api/projects/beta/history/2?summary=1');
  eq(r.status, 200, 'snapshot summary 200');
  eq(r.json.taskCount, 2, 'summary reports snapshot task count');

  r = await req('GET', '/api/projects/beta/history/99');
  eq(r.status, 404, 'missing snapshot 404');

  // restore rev 1 -> becomes rev 4; current doc has 1 task; nothing deleted
  r = await req('POST', '/api/projects/beta/restore', { rev: 1 });
  eq(r.status, 200, 'restore 200');
  eq(r.json.rev, 4, 'restore creates a NEW rev');
  eq(r.json.restoredFrom, 1, 'restore reports source rev');
  r = await req('GET', '/api/projects/beta');
  eq(r.json.tasks.length, 1, 'current doc is the restored content');
  eq(r.json.rev, 4, 'current rev advanced');
  r = await req('GET', '/api/projects/beta/history');
  eq(r.json.length, 4, 'pre-restore versions still in history');

  // restore of missing rev
  r = await req('POST', '/api/projects/beta/restore', { rev: 999 });
  eq(r.status, 404, 'restore of unknown rev 404');

  // audit records the restore
  var audit = fs.readFileSync(path.join(TMP, 'beta.audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  var restoreEntry = audit.filter(function (e) { return e.action === 'restore'; })[0];
  ok(restoreEntry && restoreEntry.fromRev === 1 && restoreEntry.rev === 4, 'restore audited with from/to revs');

  // viewer cannot restore (mutating method) — configure remote auth and try tokenless
  r = await req('POST', '/api/projects/beta/restore', { rev: 2 }, { 'cf-ray': 'x' });
  eq(r.status, 503, 'remote restore without auth config fails closed');

  await new Promise(function (res) { server.close(res); });
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* */ }

  console.log('\nHistory tests: ' + passed + ' passed, ' + failed + ' failed.');
  if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
}

main().catch(function (e) { console.error('history test crashed:', e); process.exit(1); });
