/* Tests for identity, JWT verification, and role enforcement.
 * Uses a locally-generated RSA keypair via the documented test hook.
 * node tests/auth.test.js */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var crypto = require('crypto');

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'projectdesk-auth-'));
process.env.PROJECTDESK_PROJECTS_DIR = TMP;

var Server = require('../server.js');
var Auth = require('../auth.js');
var Model = require('../js/model.js');

var passed = 0, failed = 0, failures = [];
function eq(a, e, msg) { if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; failures.push(msg + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); } }
function ok(c, msg) { if (c) passed++; else { failed++; failures.push(msg); } }

// ---- keypair + token minting ------------------------------------------------
var KEYS = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
var TEAM = 'https://testteam.cloudflareaccess.com';
var AUD = 'aud-tag-1234';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function mint(claims, opts) {
  opts = opts || {};
  var header = { alg: opts.alg || 'RS256', kid: 'test-key' };
  var now = Math.floor(Date.now() / 1000);
  var payload = Object.assign({
    iss: TEAM, aud: [AUD], exp: now + 300, nbf: now - 60, email: 'member@team.com'
  }, claims || {});
  var signing = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  var sig = crypto.sign('RSA-SHA256', Buffer.from(signing), opts.key || KEYS.privateKey);
  return signing + '.' + b64url(sig);
}

var CFG = {
  cloudflareAccess: { teamDomain: TEAM, aud: AUD },
  editors: ['boss@team.com'],
  viewers: 'any-authenticated',
  testPublicKeyPem: KEYS.publicKey.export({ type: 'spki', format: 'pem' })
};

// ---- unit: verifyAccessJwt ---------------------------------------------------
function unitTests(done) {
  var pending = 8; // total expectations below; callbacks may fire synchronously
  var finished = false;
  function step() { if (--pending === 0 && !finished) { finished = true; done(); } }
  function expectErr(token, re, msg) {
    Auth.verifyAccessJwt(token, CFG, function (err) {
      ok(err && re.test(err.message), msg + ' (got: ' + (err ? err.message : 'no error') + ')');
      step();
    });
  }
  Auth.verifyAccessJwt(mint(), CFG, function (err, payload) {
    ok(!err, 'valid token verifies: ' + (err ? err.message : ''));
    eq(payload && payload.email, 'member@team.com', 'email claim extracted');
    step();
  });
  expectErr(mint({ exp: Math.floor(Date.now() / 1000) - 600 }), /expired/, 'expired token rejected');
  expectErr(mint({ iss: 'https://evil.example.com' }), /issuer/, 'wrong issuer rejected');
  expectErr(mint({ aud: ['other-app'] }), /audience/, 'wrong audience rejected');
  expectErr(mint({ email: undefined }), /email/, 'missing email rejected');
  expectErr('garbage.token', /malformed/, 'malformed token rejected');
  // Token signed by a DIFFERENT key (forged)
  var otherKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  expectErr(mint({}, { key: otherKeys.privateKey }), /signature/, 'forged signature rejected');
  // alg confusion attempt
  expectErr(mint({}, { alg: 'none' }), /alg/, 'alg=none rejected');
}

// ---- role mapping -------------------------------------------------------------
eq(Auth.roleFor('boss@team.com', CFG), 'editor', 'editor email -> editor');
eq(Auth.roleFor('BOSS@TEAM.COM', CFG), 'editor', 'editor match is case-insensitive');
eq(Auth.roleFor('member@team.com', CFG), 'viewer', 'other authenticated email -> viewer');
var listCfg = Object.assign({}, CFG, { viewers: ['a@team.com'] });
eq(Auth.roleFor('a@team.com', listCfg), 'viewer', 'explicit viewer list admits');
eq(Auth.roleFor('x@team.com', listCfg), null, 'not on any list -> rejected');

// ---- integration: HTTP stack -------------------------------------------------
var server = Server.createServer();
Server._setAuthConfig(CFG);
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
        try { json = JSON.parse(text); } catch (e) { /* static */ }
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function sampleDoc() { var m = Model.createModel(); m.loadSample(); return m.toJSON(); }

async function integration() {
  await new Promise(function (res) { server.listen(0, '127.0.0.1', res); });
  PORT = server.address().port;

  var editorTok = mint({ email: 'boss@team.com' });
  var viewerTok = mint({ email: 'member@team.com' });

  // Local (no cf headers): trusted editor
  var r = await req('GET', '/api/me');
  eq(r.json, { email: 'local', role: 'editor', remote: false }, 'local identity is editor');
  r = await req('PUT', '/api/projects/alpha', sampleDoc());
  eq(r.status, 200, 'local write allowed');

  // Tunnel marker but NO token: rejected — even for static files
  r = await req('GET', '/api/projects/alpha', null, { 'cf-ray': 'x' });
  eq(r.status, 401, 'tunnel request without token: API 401');
  r = await req('GET', '/', null, { 'cf-connecting-ip': '1.2.3.4' });
  eq(r.status, 401, 'tunnel request without token: static 401');

  // Forged/expired tokens rejected
  r = await req('GET', '/api/me', null, { 'cf-access-jwt-assertion': mint({ exp: 1 }) });
  eq(r.status, 401, 'expired token 401');

  // Valid viewer: can read everything, can write nothing
  r = await req('GET', '/api/me', null, { 'cf-access-jwt-assertion': viewerTok });
  eq(r.json, { email: 'member@team.com', role: 'viewer', remote: true }, 'viewer identity');
  r = await req('GET', '/api/projects/alpha/schedule', null, { 'cf-access-jwt-assertion': viewerTok });
  eq(r.status, 200, 'viewer can read schedule');
  r = await req('GET', '/', null, { 'cf-access-jwt-assertion': viewerTok });
  ok(/ProjectDesk/.test(r.text), 'viewer can load the app');
  r = await req('PUT', '/api/projects/alpha', sampleDoc(), { 'cf-access-jwt-assertion': viewerTok });
  eq(r.status, 403, 'viewer PUT 403');
  r = await req('POST', '/api/projects/alpha/ops', { ops: [{ op: 'add-task', name: 'x' }] }, { 'cf-access-jwt-assertion': viewerTok });
  eq(r.status, 403, 'viewer ops 403');
  r = await req('POST', '/api/projects/alpha', sampleDoc(), { 'cf-access-jwt-assertion': viewerTok });
  eq(r.status, 403, 'viewer beacon-save 403');
  r = await req('DELETE', '/api/projects/alpha', null, { 'cf-access-jwt-assertion': viewerTok });
  eq(r.status, 403, 'viewer delete 403');

  // Valid editor: full access; write is stamped + audited
  r = await req('POST', '/api/projects/alpha/ops', { ops: [{ op: 'add-task', name: 'remote task' }] }, { 'cf-access-jwt-assertion': editorTok });
  eq(r.status, 200, 'remote editor ops 200');
  r = await req('GET', '/api/projects/alpha', null, { 'cf-access-jwt-assertion': editorTok });
  eq(r.json.lastEditor, 'boss@team.com', 'write stamped with editor email');
  var auditLines = fs.readFileSync(path.join(TMP, 'alpha.audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  ok(auditLines.length >= 2, 'audit trail written');
  var last = auditLines[auditLines.length - 1];
  eq(last.email, 'boss@team.com', 'audit records the editor');
  eq(last.action, 'ops', 'audit records the action');
  ok(last.remote === true, 'audit records remote origin');

  // Unconfigured server fails closed for remote, stays open locally
  Server._setAuthConfig(null);
  r = await req('GET', '/api/me', null, { 'cf-access-jwt-assertion': editorTok });
  eq(r.status, 503, 'unconfigured remote: 503 fail-closed');
  r = await req('GET', '/api/me');
  eq(r.status, 200, 'unconfigured local: still works');
  Server._setAuthConfig(CFG);

  await new Promise(function (res) { server.close(res); });
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

unitTests(function () {
  integration().then(function () {
    console.log('\nAuth tests: ' + passed + ' passed, ' + failed + ' failed.');
    if (failed) { console.log('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
  }).catch(function (e) {
    console.error('auth integration crashed:', e);
    process.exit(1);
  });
});
