#!/usr/bin/env node
/**
 * Build per-date puzzle ranking files.
 *
 * Usage:
 *  node scripts/contexto-build-puzzle.js --all --start-date=YYYY-MM-DD
 *  node scripts/contexto-build-puzzle.js <target> <date>
 *
 * Reads:
 *  - data/contexto/_vocab.json  (word list)
 *  - data/contexto/_vocab-embeddings.bin  (Float32Array, vocab.length * 384)
 *  - scripts/contexto-targets.txt (for --all)
 *
 * Writes:
 *  - data/contexto/YYYY-MM-DD.json  { date, target, totalWords, rankings }
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data', 'contexto');
const VOCAB_FILE = path.join(DATA_DIR, '_vocab.json');
const EMBEDDINGS_FILE = path.join(DATA_DIR, '_vocab-embeddings.bin');
const TARGETS_FILE = path.join(__dirname, 'contexto-targets.txt');

const DIM = 384;

function loadData() {
  if (!fs.existsSync(VOCAB_FILE) || !fs.existsSync(EMBEDDINGS_FILE)) {
    console.error('Missing vocab or embeddings. Run: node scripts/contexto-build-vocab.js');
    process.exit(1);
  }
  const vocab = JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
  const buf = fs.readFileSync(EMBEDDINGS_FILE);
  const embeddings = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  if (embeddings.length !== vocab.length * DIM) {
    console.error(`Size mismatch: vocab=${vocab.length}, embeddings=${embeddings.length / DIM}`);
    process.exit(1);
  }
  return { vocab, embeddings };
}

function cosineSim(a, b, aOffset, bOffset) {
  let dot = 0;
  for (let i = 0; i < DIM; i++) {
    dot += a[aOffset + i] * b[bOffset + i];
  }
  return dot; // vectors are normalized, so dot = cosine
}

function buildPuzzle(target, date, { vocab, embeddings }) {
  const targetIdx = vocab.indexOf(target);
  if (targetIdx === -1) {
    throw new Error(`Target "${target}" not in vocab`);
  }
  const targetOffset = targetIdx * DIM;

  // Compute similarity for all words
  const sims = new Array(vocab.length);
  for (let i = 0; i < vocab.length; i++) {
    sims[i] = { word: vocab[i], sim: cosineSim(embeddings, embeddings, targetOffset, i * DIM) };
  }

  // Sort descending by similarity
  sims.sort((a, b) => b.sim - a.sim);

  // Build rankings: rank 1 = target (highest sim)
  const rankings = {};
  for (let i = 0; i < sims.length; i++) {
    rankings[sims[i].word] = i + 1;
  }

  return {
    date,
    target,
    totalWords: vocab.length,
    rankings,
  };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function main() {
  const args = process.argv.slice(2);
  const data = loadData();

  const allFlag = args.includes('--all');
  const startDateArg = args.find(a => a.startsWith('--start-date='));
  const startDate = startDateArg ? startDateArg.split('=')[1] : null;

  let tasks = [];
  if (allFlag) {
    if (!startDate) {
      console.error('--all requires --start-date=YYYY-MM-DD');
      process.exit(1);
    }
    const targets = fs.readFileSync(TARGETS_FILE, 'utf8')
      .split('\n').map(s => s.trim()).filter(Boolean);
    tasks = targets.map((t, i) => ({ target: t, date: addDays(startDate, i) }));
  } else if (args.length >= 2) {
    tasks = [{ target: args[0], date: args[1] }];
  } else {
    console.error('Usage: node scripts/contexto-build-puzzle.js <target> <date>');
    console.error('   or: node scripts/contexto-build-puzzle.js --all --start-date=YYYY-MM-DD');
    process.exit(1);
  }

  for (const { target, date } of tasks) {
    try {
      const puzzle = buildPuzzle(target, date, data);
      const outFile = path.join(DATA_DIR, `${date}.json`);
      fs.writeFileSync(outFile, JSON.stringify(puzzle));
      console.log(`[write] ${date}.json  target="${target}"  (${puzzle.totalWords} ranks)`);
    } catch (e) {
      console.error(`[error] ${date} "${target}": ${e.message}`);
    }
  }
}

main();
