/*
 * store.js — the one place project documents touch disk. Node stdlib only.
 * Used by server.js and cli.js so locking, rev assignment, snapshots, and
 * pruning behave identically no matter which process writes.
 *
 * Guarantees:
 *  - Writes are serialized across processes via an exclusive <file>.lock
 *    (O_EXCL create; bounded retry). Read-modify-write sequences should run
 *    inside withFileLock and use writeDocUnlocked.
 *  - Every write bumps rev (disk-read-then-bump) and lands via tmp+rename.
 *  - Every write snapshots the full document to <dir>/.history/<base>/<rev>.json
 *    and appends a line to index.jsonl there, so any revision can be listed,
 *    inspected, and restored. History is pruned to HISTORY_CAP snapshots.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var HISTORY_CAP = parseInt(process.env.PROJECTDESK_HISTORY_CAP || '300', 10);

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
      if (++tries > 100) throw new Error('project file is locked (' + lock + ' — remove it if stale)');
      sleepSync(20);
    }
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch (e) { /* best effort */ }
    try { fs.unlinkSync(lock); } catch (e) { /* best effort */ }
  }
}

function readDoc(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
}

function historyDir(file) {
  var base = path.basename(file).replace(/\.json$/, '');
  return path.join(path.dirname(file), '.history', base);
}

function snapshot(file, doc) {
  try {
    var dir = historyDir(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, doc.rev + '.json'), JSON.stringify(doc, null, 2));
    fs.appendFileSync(path.join(dir, 'index.jsonl'), JSON.stringify({
      rev: doc.rev,
      ts: doc.lastEditISO || new Date().toISOString(),
      editor: doc.lastEditor || 'local',
      taskCount: (doc.tasks || []).length,
      name: doc.name || ''
    }) + '\n');
    prune(dir);
  } catch (e) { /* history is best-effort; never block the write */ }
}

function existingSnapshotRevs(dir) {
  try {
    return fs.readdirSync(dir)
      .map(function (f) { var m = /^(\d+)\.json$/.exec(f); return m ? parseInt(m[1], 10) : null; })
      .filter(function (n) { return n != null; })
      .sort(function (a, b) { return a - b; });
  } catch (e) { return []; }
}

function prune(dir) {
  var revs = existingSnapshotRevs(dir);
  while (revs.length > HISTORY_CAP) {
    var oldest = revs.shift();
    try { fs.unlinkSync(path.join(dir, oldest + '.json')); } catch (e) { /* raced */ }
  }
  // Compact index.jsonl to one line per still-existing snapshot, so it can't
  // grow without bound as revisions accumulate.
  var keep = {};
  revs.forEach(function (r) { keep[r] = true; });
  try {
    var idx = path.join(dir, 'index.jsonl');
    var byRev = {};
    fs.readFileSync(idx, 'utf8').split('\n').forEach(function (line) {
      if (!line.trim()) return;
      try { var e = JSON.parse(line); if (keep[e.rev]) byRev[e.rev] = line; } catch (err) { /* skip */ }
    });
    var compact = revs.map(function (r) { return byRev[r]; }).filter(Boolean).join('\n');
    fs.writeFileSync(idx, compact ? compact + '\n' : '');
  } catch (e) { /* index optional */ }
}

// Highest rev ever recorded for this project — across the LIVE doc and the
// retained history. Guarantees rev is monotonic even after the live file is
// deleted (snapshots are kept for recovery), so a later write/restore can
// never restart at 1 and overwrite an existing snapshot.
function highestKnownRev(file) {
  var existing = readDoc(file);
  var live = existing && typeof existing.rev === 'number' ? existing.rev : 0;
  var hist = existingSnapshotRevs(historyDir(file));
  var maxHist = hist.length ? hist[hist.length - 1] : 0;
  return Math.max(live, maxHist);
}

// Write inside an already-held lock: bump rev monotonically, rename atomically,
// snapshot. Returns the new rev.
function writeDocUnlocked(file, doc) {
  doc.rev = highestKnownRev(file) + 1;
  var tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
  snapshot(file, doc);
  return doc.rev;
}

// Read the current doc + apply a mutation + write, all under one lock so the
// read the edit is based on cannot be invalidated by a concurrent writer.
function readModifyWrite(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, function () {
    var doc = readDoc(file);
    var result = fn(doc); // returns the doc to persist, or null to skip the write
    if (result == null) return { rev: doc && doc.rev, doc: doc, wrote: false };
    var rev = writeDocUnlocked(file, result);
    return { rev: rev, doc: result, wrote: true };
  });
}

// Standalone locked write (whole-document replace).
function writeDoc(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, function () { return writeDocUnlocked(file, doc); });
}

// List snapshots, newest first: [{rev, ts, editor, taskCount, name}]
function listHistory(file) {
  var dir = historyDir(file);
  var byRev = {};
  try {
    fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n').forEach(function (line) {
      if (!line.trim()) return;
      try {
        var e = JSON.parse(line);
        if (typeof e.rev === 'number') byRev[e.rev] = e; // last entry per rev wins
      } catch (err) { /* skip corrupt line */ }
    });
  } catch (e) { return []; }
  // Only report revisions whose snapshot file still exists (prune-aware).
  var existing = {};
  try {
    fs.readdirSync(dir).forEach(function (f) {
      var m = /^(\d+)\.json$/.exec(f);
      if (m) existing[parseInt(m[1], 10)] = true;
    });
  } catch (e) { return []; }
  return Object.keys(byRev)
    .map(Number)
    .filter(function (rev) { return existing[rev]; })
    .sort(function (a, b) { return b - a; })
    .map(function (rev) { return byRev[rev]; });
}

function readSnapshot(file, rev) {
  if (!/^\d+$/.test(String(rev))) return null;
  return readDoc(path.join(historyDir(file), parseInt(rev, 10) + '.json'));
}

module.exports = {
  withFileLock: withFileLock,
  readDoc: readDoc,
  writeDoc: writeDoc,
  writeDocUnlocked: writeDocUnlocked,
  readModifyWrite: readModifyWrite,
  listHistory: listHistory,
  readSnapshot: readSnapshot,
  historyDir: historyDir,
  HISTORY_CAP: HISTORY_CAP
};
