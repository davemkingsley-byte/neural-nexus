/* Tests for comments + activity feed. node tests/comments.test.js */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var crypto = require('crypto');

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'projectdesk-com-'));
process.env.PROJECTDESK_PROJECTS_DIR = TMP;

var Model = require('../js/model.js');
var Ops = require('../js/ops.js');
var Server = require('../server.js');
var Auth = require('../auth.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

function base() {
  var m = Model.createModel();
  m.newProject();
  Ops.applyOps(m, [{ op: 'add-task', name: 'A' }, { op: 'add-task', name: 'B' }]);
  return m;
}

// ---- model: add / list / count / delete / undo ----
(function () {
  var m = base();
  var tid = m.getProject().tasks[0].id;
  var cid = m.addComment(tid, '  first note  ', 'alice@x.com');
  ok(cid != null, 'comment added');
  var c = m.getProject().tasks[0].comments[0];
  eq(c.text, 'first note', 'text trimmed');
  eq(c.author, 'alice@x.com', 'author stored');
  ok(c.ts, 'timestamp set');
  eq(m.getComputed().rows[0].commentCount, 1, 'comment count on row');

  m.addComment(tid, 'second', 'bob@x.com');
  eq(m.getProject().tasks[0].comments.length, 2, 'two comments');

  // empty / whitespace rejected
  ok(m.addComment(tid, '   ', 'x') === null, 'empty comment rejected');
  eq(m.getProject().tasks[0].comments.length, 2, 'still two');

  // delete
  ok(m.deleteComment(tid, cid), 'delete returns true');
  eq(m.getProject().tasks[0].comments.length, 1, 'one left');
  eq(m.getProject().tasks[0].comments[0].text, 'second', 'right one remains');
  ok(!m.deleteComment(tid, 9999), 'deleting missing comment -> false');

  // undo restores the deleted comment
  m.undo();
  eq(m.getProject().tasks[0].comments.length, 2, 'undo restores deleted comment');
})();

// ---- ids are unique across tasks + survive round-trip ----
(function () {
  var m = base();
  var t0 = m.getProject().tasks[0].id, t1 = m.getProject().tasks[1].id;
  var c1 = m.addComment(t0, 'x', 'a');
  var c2 = m.addComment(t1, 'y', 'b');
  ok(c1 !== c2, 'comment ids unique across tasks');
  var m2 = Model.createModel();
  m2.loadProject(m.toJSON());
  eq(m2.getProject().tasks[1].comments[0].text, 'y', 'comments round-trip');
  // next id continues past loaded max
  var c3 = m2.addComment(t0, 'z', 'c');
  ok(c3 > Math.max(c1, c2), 'nextCommentId continues after load');
})();

// ---- ops: author stamped from ctx, not the op ----
(function () {
  var m = base();
  var r = Ops.applyOps(m, [
    { op: 'comment', row: 1, text: 'via ops' },
    { op: 'comment', row: 1, text: 'spoof attempt', author: 'evil@x.com' }
  ], { author: 'real@x.com' });
  ok(r.ok, 'comment ops applied');
  var cs = m.getProject().tasks[0].comments;
  eq(cs[0].author, 'real@x.com', 'ctx author used');
  eq(cs[1].author, 'real@x.com', 'op-supplied author IGNORED — no spoofing');
  // report exposes comments
  var rep = Ops.buildScheduleReport(m);
  eq(rep.tasks[0].comments.length, 2, 'comments in report');

  // delete-comment op
  var delId = cs[0].id;
  var r2 = Ops.applyOps(m, [{ op: 'delete-comment', row: 1, commentId: delId }]);
  ok(r2.ok, 'delete-comment op ok');
  eq(m.getProject().tasks[0].comments.length, 1, 'one comment left after op delete');
  var r3 = Ops.applyOps(m, [{ op: 'delete-comment', row: 1, commentId: 9999 }]);
  ok(!r3.ok && /no comment/.test(r3.error), 'delete missing comment errors');
  var r4 = Ops.applyOps(m, [{ op: 'comment', row: 1, text: '' }]);
  ok(!r4.ok && /text/.test(r4.error), 'empty comment op errors');
})();

// ---- HTTP: server stamps comment author from identity; activity feed ----
var KEYS = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
var TEAM = 'https://t.cloudflareaccess.com', AUD = 'aud-x';
function b64url(b) { return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function mint(email) {
  var now = Math.floor(Date.now() / 1000);
  var h = b64url(JSON.stringify({ alg: 'RS256', kid: 'k' }));
  var p = b64url(JSON.stringify({ iss: TEAM, aud: [AUD], exp: now + 300, email: email }));
  return h + '.' + p + '.' + b64url(crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), KEYS.privateKey));
}
var CFG = { cloudflareAccess: { teamDomain: TEAM, aud: AUD }, editors: ['boss@x.com'], viewers: 'any-authenticated', testPublicKeyPem: KEYS.publicKey.export({ type: 'spki', format: 'pem' }) };

var server = Server.createServer();
Server._setAuthConfig(CFG);
var PORT;
function req(method, p, body, headers) {
  return new Promise(function (resolve, reject) {
    var payload = body != null ? JSON.stringify(body) : null;
    var h = Object.assign({}, headers || {});
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    var r = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method: method, headers: h }, function (res) {
      var ch = []; res.on('data', function (c) { ch.push(c); });
      res.on('end', function () { var t = Buffer.concat(ch).toString('utf8'); var j = null; try { j = JSON.parse(t); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject); if (payload) r.write(payload); r.end();
  });
}

async function main() {
  await new Promise(function (res) { server.listen(0, '127.0.0.1', res); });
  PORT = server.address().port;
  var m = base();
  await req('PUT', '/api/projects/p', m.toJSON());

  // editor posts a comment claiming a different author -> server overrides with token email
  var r = await req('POST', '/api/projects/p/ops',
    { ops: [{ op: 'comment', row: 1, text: 'hi', author: 'someone-else@x.com' }] },
    { 'cf-access-jwt-assertion': mint('boss@x.com') });
  eq(r.status, 200, 'editor comment ops 200');
  r = await req('GET', '/api/projects/p/schedule', null, { 'cf-access-jwt-assertion': mint('boss@x.com') });
  eq(r.json.tasks[0].comments[0].author, 'boss@x.com', 'server stamps author from verified identity');

  // viewer cannot comment (mutating op)
  r = await req('POST', '/api/projects/p/ops', { ops: [{ op: 'comment', row: 1, text: 'no' }] },
    { 'cf-access-jwt-assertion': mint('viewer@x.com') });
  eq(r.status, 403, 'viewer comment 403');

  // activity feed records the ops with op names + author
  r = await req('GET', '/api/projects/p/activity', null, { 'cf-access-jwt-assertion': mint('boss@x.com') });
  eq(r.status, 200, 'activity 200');
  ok(Array.isArray(r.json) && r.json.length >= 1, 'activity has entries');
  var opsEntry = r.json.filter(function (e) { return e.action === 'ops'; })[0];
  ok(opsEntry && opsEntry.email === 'boss@x.com', 'activity records the author');
  ok(opsEntry && opsEntry.ops && opsEntry.ops.indexOf('comment') >= 0, 'activity lists op names');

  // REVIEW FIX: comment author cannot be forged via the full-document PUT path.
  // Editor 'boss@x.com' PUTs a doc with a comment authored as someone else.
  var forged = base().toJSON();
  forged.tasks[0].comments = [{ id: 1, author: 'ceo@x.com', ts: '2020-01-01T00:00:00Z', text: 'approved by me' }];
  r = await req('PUT', '/api/projects/p2', forged, { 'cf-access-jwt-assertion': mint('boss@x.com'), 'If-Match': '0' });
  eq(r.status, 200, 'PUT with a (forged-author) comment accepted');
  r = await req('GET', '/api/projects/p2/schedule', null, { 'cf-access-jwt-assertion': mint('boss@x.com') });
  eq(r.json.tasks[0].comments[0].author, 'boss@x.com', 'PUT restamps a new comment to the caller — no forgery');

  // REVIEW FIX: a non-numeric comment id (XSS payload) is coerced away on load.
  var xss = base().toJSON();
  xss.tasks[0].comments = [{ id: '1"><img src=x onerror=alert(1)>', author: 'a@x.com', ts: null, text: 'hi' }];
  r = await req('PUT', '/api/projects/p3', xss, { 'cf-access-jwt-assertion': mint('boss@x.com') });
  eq(r.status, 200, 'PUT with a malicious comment id accepted (sanitized)');
  r = await req('GET', '/api/projects/p3', null, { 'cf-access-jwt-assertion': mint('boss@x.com') });
  eq(typeof r.json.tasks[0].comments[0].id, 'number', 'comment id coerced to a number (no HTML payload survives)');

  await new Promise(function (res) { server.close(res); });
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\nComments tests: ' + passed + ' passed, ' + failed + ' failed.');
  if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
}
main().catch(function (e) { console.error('comments test crashed:', e); process.exit(1); });
