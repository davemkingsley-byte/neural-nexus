#!/usr/bin/env node
/*
 * server.js — ProjectDesk server. Node stdlib only, no dependencies.
 *
 * Serves the web app (static files from this directory) and a JSON API over
 * project files stored in ./projects/<name>.json — so plans live on disk,
 * are git-committable, and are editable by the browser UI, the CLI, and any
 * AI/script through the same semantic-ops layer (js/ops.js).
 *
 *   GET  /api/ping                      → {ok, service, version}
 *   GET  /api/projects                  → [{name, rev, taskCount, updatedISO}]
 *   GET  /api/projects/:name            → full project document
 *   GET  /api/projects/:name/rev        → {rev}   (cheap poll for live sync)
 *   GET  /api/projects/:name/schedule   → computed schedule report (AI read-back)
 *   PUT  /api/projects/:name            → replace document; server bumps rev
 *   POST /api/projects/:name/ops        → {ops:[...]} apply semantic ops; returns
 *                                         {ok, applied, results, rev, summary}
 *   DELETE /api/projects/:name          → remove the project file
 *
 * Concurrency: single-process, last-writer-wins; every write bumps `rev` and
 * writes are atomic (tmp + rename). The UI polls /rev and reloads when it
 * changes, so external edits (CLI/AI) appear in the browser within ~2s.
 *
 * Usage: node server.js [--port 4180] [--host 127.0.0.1]
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var Model = require('./js/model.js');
var Ops = require('./js/ops.js');
var Auth = require('./auth.js');

var ROOT = __dirname;
var PROJECTS_DIR = process.env.PROJECTDESK_PROJECTS_DIR || path.join(ROOT, 'projects');
var VERSION = '1.0.0';
var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var MAX_BODY = 10 * 1024 * 1024; // 10 MB

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function ensureDir() {
  try { fs.mkdirSync(PROJECTS_DIR, { recursive: true }); } catch (e) { /* exists */ }
}

function projectPath(name) { return path.join(PROJECTS_DIR, name + '.json'); }

function readProject(name) {
  try {
    return JSON.parse(fs.readFileSync(projectPath(name), 'utf8'));
  } catch (e) { return null; }
}

// Atomic write; assigns the next rev and returns it. The lockfile serializes
// against out-of-process writers (a --local CLI editing the same file) — the
// server's own writes are already serialized by the single-threaded loop.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { var end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

function writeProject(name, doc) {
  ensureDir();
  var file = projectPath(name);
  var lock = file + '.lock';
  var fd = null, tries = 0;
  while (fd === null) {
    try { fd = fs.openSync(lock, 'wx'); }
    catch (e) {
      if (++tries > 100) throw new Error('project file is locked (' + lock + ' — remove it if stale)');
      sleepSync(20);
    }
  }
  try {
    var existing = readProject(name);
    var prevRev = existing && typeof existing.rev === 'number' ? existing.rev : 0;
    doc.rev = prevRev + 1;
    var tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, file);
    return doc.rev;
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* best effort */ }
    try { fs.unlinkSync(lock); } catch (e) { /* best effort */ }
  }
}

function send(res, code, body, type) {
  var data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function readBody(req, cb) {
  var chunks = [], size = 0, aborted = false;
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) { aborted = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () { if (!aborted) cb(Buffer.concat(chunks).toString('utf8')); });
  req.on('error', function () { /* handled by close */ });
}

// Load a document through the model so it is normalized + validated, then hand
// back a live model for ops/reports.
function modelFor(doc) {
  var m = Model.createModel();
  m.loadProject(doc);
  return m;
}

// Append a line to the per-project audit trail (JSONL, best effort).
function audit(name, identity, action, extra) {
  try {
    var line = JSON.stringify(Object.assign({
      ts: new Date().toISOString(),
      email: identity.email,
      remote: !!identity.remote,
      action: action
    }, extra || {})) + '\n';
    fs.appendFileSync(path.join(PROJECTS_DIR, name + '.audit.jsonl'), line);
  } catch (e) { /* never block a write on audit failure */ }
}

function handleApi(req, res, pathname, identity) {
  var parts = pathname.split('/').filter(Boolean); // ['api', 'projects', name, sub]

  if (parts[1] === 'ping') {
    return send(res, 200, { ok: true, service: 'projectdesk', version: VERSION });
  }

  // Who am I / what can I do — the UI adapts its chrome to this.
  if (parts[1] === 'me') {
    return send(res, 200, { email: identity.email, role: identity.role, remote: !!identity.remote });
  }

  if (parts[1] !== 'projects') return send(res, 404, { error: 'not found' });

  // Role enforcement: every mutating method needs the editor role. GETs are
  // open to any authenticated identity (viewer or editor).
  var mutating = req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE';
  if (mutating && identity.role !== 'editor') {
    return send(res, 403, { error: 'view-only account — ask the plan owner for edit access' });
  }

  // GET /api/projects
  if (parts.length === 2 && req.method === 'GET') {
    ensureDir();
    var list = [];
    fs.readdirSync(PROJECTS_DIR).forEach(function (f) {
      if (!/\.json$/.test(f)) return;
      var name = f.replace(/\.json$/, '');
      if (!NAME_RE.test(name)) return;
      var doc = readProject(name);
      if (!doc) return;
      var st = null;
      try { st = fs.statSync(projectPath(name)); } catch (e) { /* raced */ }
      list.push({
        name: name,
        displayName: doc.name || name,
        rev: doc.rev || 0,
        taskCount: (doc.tasks || []).length,
        updatedISO: st ? st.mtime.toISOString() : null
      });
    });
    return send(res, 200, list);
  }

  var name = parts[2];
  if (!name || !NAME_RE.test(name)) return send(res, 400, { error: 'invalid project name' });
  var sub = parts[3] || null;

  if (req.method === 'GET') {
    var doc = readProject(name);
    if (!doc) return send(res, 404, { error: 'project "' + name + '" not found' });
    if (!sub) return send(res, 200, doc);
    if (sub === 'rev') return send(res, 200, { rev: doc.rev || 0 });
    if (sub === 'schedule') {
      try {
        return send(res, 200, Ops.buildScheduleReport(modelFor(doc)));
      } catch (e) { return send(res, 500, { error: 'schedule failed: ' + e.message }); }
    }
    if (sub === 'csv') {
      try {
        return send(res, 200, modelFor(doc).toCSV(), 'text/csv; charset=utf-8');
      } catch (e) { return send(res, 500, { error: 'csv failed: ' + e.message }); }
    }
    return send(res, 404, { error: 'not found' });
  }

  // navigator.sendBeacon can only POST with no custom headers — treat a POST
  // to the document path (no /ops) as an unconditional save (navigation flush).
  if ((req.method === 'PUT' || req.method === 'POST') && !sub) {
    return readBody(req, function (body) {
      var doc;
      try { doc = JSON.parse(body); } catch (e) { return send(res, 400, { error: 'invalid JSON' }); }
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tasks)) {
        return send(res, 400, { error: 'not a project document (missing tasks array)' });
      }
      // Conditional write: an If-Match header carries the rev the client based
      // its edit on; a mismatch means someone else wrote in between → 409 so
      // no edit is silently clobbered. No header = unconditional (bootstrap).
      var ifMatch = req.headers['if-match'];
      if (ifMatch != null) {
        var existing = readProject(name);
        var diskRev = existing && typeof existing.rev === 'number' ? existing.rev : 0;
        if (parseInt(ifMatch, 10) !== diskRev) {
          return send(res, 409, { error: 'rev mismatch', rev: diskRev });
        }
      }
      // Normalize through the model so a malformed doc can't poison the store.
      var m;
      try { m = modelFor(doc); } catch (e) { return send(res, 400, { error: 'document rejected: ' + e.message }); }
      var normalized = m.toJSON();
      normalized.lastEditor = identity.email;
      normalized.lastEditISO = new Date().toISOString();
      var rev = writeProject(name, normalized);
      audit(name, identity, req.method === 'POST' ? 'save-beacon' : 'save', { rev: rev });
      return send(res, 200, { ok: true, rev: rev });
    });
  }

  if (req.method === 'POST' && sub === 'ops') {
    return readBody(req, function (body) {
      var payload;
      try { payload = JSON.parse(body); } catch (e) { return send(res, 400, { error: 'invalid JSON' }); }
      var ops = payload && (payload.ops || payload);
      var doc = readProject(name);
      if (!doc) {
        if (payload && payload.createIfMissing) {
          var startISO = new Date().toISOString().slice(0, 10);
          doc = Model.emptyProject(startISO);
          doc.name = name;
        } else {
          return send(res, 404, { error: 'project "' + name + '" not found (pass createIfMissing:true to create)' });
        }
      }
      var m;
      try { m = modelFor(doc); } catch (e) { return send(res, 400, { error: 'document rejected: ' + e.message }); }
      var outcome = Ops.applyOps(m, ops);
      // Batches are ATOMIC: nothing is persisted unless every op succeeded, so
      // a failed batch can be fixed and resubmitted whole without duplicating
      // its already-applied prefix.
      var rev = null;
      if (outcome.ok) {
        var outDoc = m.toJSON();
        outDoc.lastEditor = identity.email;
        outDoc.lastEditISO = new Date().toISOString();
        rev = writeProject(name, outDoc);
        audit(name, identity, 'ops', { rev: rev, opCount: outcome.applied });
      }
      var report = Ops.buildScheduleReport(outcome.ok ? m : modelFor(readProject(name) || doc));
      return send(res, outcome.ok ? 200 : 422, {
        ok: outcome.ok,
        applied: outcome.ok ? outcome.applied : 0,
        failedIndex: outcome.ok ? null : outcome.failedIndex,
        failedOp: outcome.ok ? null : outcome.failedOp,
        error: outcome.error || null,
        results: outcome.ok ? outcome.results : [],
        rev: rev,
        summary: report.project
      });
    });
  }

  if (req.method === 'DELETE' && !sub) {
    try { fs.unlinkSync(projectPath(name)); } catch (e) { return send(res, 404, { error: 'not found' }); }
    audit(name, identity, 'delete-project', {});
    return send(res, 200, { ok: true });
  }

  return send(res, 405, { error: 'method not allowed' });
}

function handleStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  var file = path.normalize(path.join(ROOT, pathname));
  if (file.indexOf(ROOT + path.sep) !== 0 && file !== ROOT) {
    return send(res, 403, { error: 'forbidden' });
  }
  // Never serve project data or sensitive config through the static handler.
  // The API is the only door to plan documents; auth.json / audit logs / lock
  // files / dotfiles must never be downloadable even by an authenticated user.
  var base = path.basename(file);
  if (/^\/projects(\/|$)/.test(pathname) || file.indexOf(PROJECTS_DIR) === 0 ||
      /^auth.*\.json$/i.test(base) || /\.audit\.jsonl$/i.test(base) ||
      /\.lock$/i.test(base) || base.charAt(0) === '.') {
    return send(res, 403, { error: 'forbidden' });
  }
  fs.readFile(file, function (err, data) {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    var ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function createServer() {
  return http.createServer(function (req, res) {
    var pathname;
    try {
      pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch (e) { return send(res, 400, { error: 'bad url' }); }
    // Identity first: local requests are trusted (editor); anything that came
    // through the Cloudflare tunnel must present a valid Access JWT, which we
    // verify ourselves — for the API AND for static files. Fail closed.
    Auth.identify(req, getAuthConfig(), function (identity) {
      if (!identity.ok) return send(res, identity.status, { error: identity.error });
      try {
        if (pathname.indexOf('/api/') === 0 || pathname === '/api') return handleApi(req, res, pathname, identity);
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
        return handleStatic(req, res, pathname);
      } catch (e) {
        console.error('[projectdesk] request error:', e && e.stack || e);
        return send(res, 500, { error: 'internal error' }); // no internals to the client
      }
    });
  });
}

// Re-read auth.json with a short TTL so grants — and especially revocations —
// take effect within seconds without restarting the server. A test override
// (_setAuthConfig) pins the config for deterministic tests.
var authOverride; // undefined = use file; null/obj = pinned by test hook
var authCache = { cfg: Auth.loadConfig(ROOT), at: Date.now() };
function getAuthConfig() {
  if (typeof authOverride !== 'undefined') return authOverride;
  var now = Date.now();
  if (now - authCache.at > 5000) authCache = { cfg: Auth.loadConfig(ROOT), at: now };
  return authCache.cfg;
}

if (require.main === module) {
  var port = parseInt(arg('port', '4180'), 10);
  var host = arg('host', '127.0.0.1');
  ensureDir();
  createServer().listen(port, host, function () {
    console.log('ProjectDesk serving http://' + host + ':' + port + '/  (projects in ' + PROJECTS_DIR + ')');
    var cfg0 = getAuthConfig();
    console.log(cfg0
      ? 'Remote access: Cloudflare Access auth configured (' + cfg0.editors.length + ' editor(s))'
      : 'Remote access: NOT configured — tunnel requests will be rejected (create auth.json)');
  });
}

module.exports = {
  createServer: createServer, writeProject: writeProject, readProject: readProject,
  PROJECTS_DIR: PROJECTS_DIR,
  _setAuthConfig: function (cfg) { authOverride = cfg; } // test hook (pins config)
};
