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
var Store = require('./store.js');
var Mspdi = require('./js/mspdi.js');
var Usage = require('./js/usage.js');
var Report = require('./js/report.js');

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

// Atomic locked write with rev bump + history snapshot — shared with the CLI
// via store.js so all writers behave identically.
function writeProject(name, doc) {
  ensureDir();
  return Store.writeDoc(projectPath(name), doc);
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

// Append a line to the per-project audit trail (JSONL, best effort). The file
// is bounded: when it grows past AUDIT_MAX_BYTES it is trimmed to the last
// AUDIT_KEEP lines, so it can't grow without limit on a long-lived project.
var AUDIT_MAX_BYTES = 512 * 1024;
var AUDIT_KEEP = 2000;
function audit(name, identity, action, extra) {
  try {
    var file = path.join(PROJECTS_DIR, name + '.audit.jsonl');
    var line = JSON.stringify(Object.assign({
      ts: new Date().toISOString(),
      email: identity.email,
      remote: !!identity.remote,
      action: action
    }, extra || {})) + '\n';
    fs.appendFileSync(file, line);
    var st = fs.statSync(file);
    if (st.size > AUDIT_MAX_BYTES) {
      var kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-AUDIT_KEEP);
      fs.writeFileSync(file, kept.join('\n') + '\n');
    }
  } catch (e) { /* never block a write on audit failure */ }
}

// Comment authorship is authoritative from the verified identity. On a full-doc
// PUT, a comment is trusted only if it already exists on disk with the same
// author; any new or author-changed comment is (re)stamped with the caller's
// identity, so authorship can't be forged through the document-save path.
function stampCommentAuthors(newDoc, oldDoc, email) {
  var known = {};
  ((oldDoc && oldDoc.tasks) || []).forEach(function (t) {
    (t.comments || []).forEach(function (c) { if (c && c.id != null) known[c.id] = c.author; });
  });
  (newDoc.tasks || []).forEach(function (t) {
    (t.comments || []).forEach(function (c) {
      if (!(c.id in known) || known[c.id] !== c.author) c.author = email;
    });
  });
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
    if (sub === 'mspdi') {
      try {
        return send(res, 200, Mspdi.toXml(modelFor(doc)), 'application/xml; charset=utf-8');
      } catch (e) { return send(res, 500, { error: 'mspdi failed: ' + e.message }); }
    }
    // One-page status report (health, milestones, critical path, EVM, risks).
    if (sub === 'report') {
      try {
        return send(res, 200, Report.build(modelFor(doc)));
      } catch (e) { return send(res, 500, { error: 'report failed: ' + e.message }); }
    }
    // Timephased resource usage (?bucket=day|week|month, default week).
    if (sub === 'usage') {
      try {
        var uq = ((req.url || '').split('?')[1] || '').match(/(?:^|&)bucket=([^&]+)/);
        var bucket = uq ? decodeURIComponent(uq[1]) : 'week';
        return send(res, 200, Usage.build(modelFor(doc), { bucket: bucket }));
      } catch (e) { return send(res, 500, { error: 'usage failed: ' + e.message }); }
    }
    // Activity feed: the audit trail, newest first (capped).
    if (sub === 'activity') {
      var lines = [];
      try {
        lines = fs.readFileSync(path.join(PROJECTS_DIR, name + '.audit.jsonl'), 'utf8')
          .split('\n').filter(Boolean);
      } catch (e) { /* no activity yet */ }
      var entries = [];
      for (var li = lines.length - 1; li >= 0 && entries.length < 200; li--) {
        try { entries.push(JSON.parse(lines[li])); } catch (e) { /* skip */ }
      }
      return send(res, 200, entries);
    }
    // Version history: list, or fetch one snapshot (optionally summarized).
    if (sub === 'history') {
      var revArg = parts[4];
      if (!revArg) return send(res, 200, Store.listHistory(projectPath(name)));
      var snap = Store.readSnapshot(projectPath(name), revArg);
      if (!snap) return send(res, 404, { error: 'no snapshot for rev ' + revArg });
      var q = (req.url || '').split('?')[1] || '';
      if (/(^|&)summary=1/.test(q)) {
        try { return send(res, 200, Ops.buildScheduleReport(modelFor(snap)).project); }
        catch (e) { return send(res, 500, { error: 'summary failed' }); }
      }
      return send(res, 200, snap);
    }
    return send(res, 404, { error: 'not found' });
  }

  // Restore a historical revision as a NEW revision (nothing is rewritten;
  // the restore itself is versioned and audited like any other write).
  if (req.method === 'POST' && sub === 'restore') {
    return readBody(req, function (body) {
      var payload;
      try { payload = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, { error: 'invalid JSON' }); }
      var fromRev = payload && payload.rev;
      var snap = Store.readSnapshot(projectPath(name), fromRev);
      if (!snap) return send(res, 404, { error: 'no snapshot for rev ' + fromRev });
      var m;
      try { m = modelFor(snap); } catch (e) { return send(res, 400, { error: 'snapshot rejected: ' + e.message }); }
      var outDoc = m.toJSON();
      outDoc.lastEditor = identity.email;
      outDoc.lastEditISO = new Date().toISOString();
      var rev = writeProject(name, outDoc);
      audit(name, identity, 'restore', { rev: rev, fromRev: parseInt(fromRev, 10) });
      return send(res, 200, { ok: true, rev: rev, restoredFrom: parseInt(fromRev, 10) });
    });
  }

  if (req.method === 'POST' && sub === 'import') {
    return readBody(req, function (body) {
      var doc;
      try { doc = Mspdi.fromXml(body); } catch (e) { return send(res, 400, { error: 'import failed: ' + e.message }); }
      var m;
      try { m = modelFor(doc); } catch (e) { return send(res, 400, { error: 'imported document rejected: ' + e.message }); }
      var outDoc = m.toJSON();
      outDoc.lastEditor = identity.email;
      outDoc.lastEditISO = new Date().toISOString();
      var rev = writeProject(name, outDoc);
      audit(name, identity, 'import-mspdi', { rev: rev, tasks: outDoc.tasks.length });
      return send(res, 200, { ok: true, rev: rev, tasks: outDoc.tasks.length });
    });
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
      var ifMatch = req.headers['if-match'];
      var conflictRev = null, badDoc = null, rmw;
      // The If-Match check and the write happen under ONE lock so a concurrent
      // writer can't slip a rev in between them.
      try {
        rmw = Store.readModifyWrite(projectPath(name), function (existing) {
          if (ifMatch != null) {
            var diskRev = existing && typeof existing.rev === 'number' ? existing.rev : 0;
            if (parseInt(ifMatch, 10) !== diskRev) { conflictRev = diskRev; return null; }
          }
          var m;
          try { m = modelFor(doc); } catch (e) { badDoc = e.message; return null; }
          var normalized = m.toJSON();
          stampCommentAuthors(normalized, existing, identity.email); // no author forgery
          normalized.lastEditor = identity.email;
          normalized.lastEditISO = new Date().toISOString();
          return normalized;
        });
      } catch (e) { return send(res, 500, { error: 'internal error' }); }
      if (conflictRev !== null) return send(res, 409, { error: 'rev mismatch', rev: conflictRev });
      if (badDoc) return send(res, 400, { error: 'document rejected: ' + badDoc });
      audit(name, identity, req.method === 'POST' ? 'save-beacon' : 'save', { rev: rmw.rev });
      return send(res, 200, { ok: true, rev: rmw.rev });
    });
  }

  if (req.method === 'POST' && sub === 'ops') {
    return readBody(req, function (body) {
      var payload;
      try { payload = JSON.parse(body); } catch (e) { return send(res, 400, { error: 'invalid JSON' }); }
      var ops = payload && (payload.ops || payload);
      var notFound = false, badDoc = null, outcome = null, report = null, rmw;
      // Read-apply-write under ONE lock so the base the ops applied to can't be
      // invalidated by a concurrent writer (which would silently drop an edit).
      try {
        rmw = Store.readModifyWrite(projectPath(name), function (doc) {
          if (!doc) {
            if (payload && payload.createIfMissing) {
              doc = Model.emptyProject(new Date().toISOString().slice(0, 10));
              doc.name = name;
            } else { notFound = true; return null; }
          }
          var m;
          try { m = modelFor(doc); } catch (e) { badDoc = e.message; return null; }
          outcome = Ops.applyOps(m, ops, { author: identity.email });
          if (!outcome.ok) { report = Ops.buildScheduleReport(modelFor(doc)); return null; } // atomic: no write
          var outDoc = m.toJSON();
          outDoc.lastEditor = identity.email;
          outDoc.lastEditISO = new Date().toISOString();
          report = Ops.buildScheduleReport(m);
          return outDoc;
        });
      } catch (e) { return send(res, 500, { error: 'internal error' }); }
      if (notFound) return send(res, 404, { error: 'project "' + name + '" not found (pass createIfMissing:true to create)' });
      if (badDoc) return send(res, 400, { error: 'document rejected: ' + badDoc });
      if (outcome.ok) {
        var opNames = (Array.isArray(ops) ? ops : [ops]).map(function (o) { return o && o.op; }).filter(Boolean);
        audit(name, identity, 'ops', { rev: rmw.rev, opCount: outcome.applied, ops: opNames });
      }
      return send(res, outcome.ok ? 200 : 422, {
        ok: outcome.ok,
        applied: outcome.ok ? outcome.applied : 0,
        failedIndex: outcome.ok ? null : outcome.failedIndex,
        failedOp: outcome.ok ? null : outcome.failedOp,
        error: outcome.error || null,
        results: outcome.ok ? outcome.results : [],
        rev: outcome.ok ? rmw.rev : null,
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
