#!/usr/bin/env node
/**
 * Build the Contexto vocabulary and embeddings.
 *
 * Steps:
 *  1. Source a common-words list (downloaded from GitHub if not cached).
 *  2. Filter / lowercase / dedupe / drop short words.
 *  3. Lemmatize via wink-lemmatizer; keep only base forms.
 *  4. Force-include all words from scripts/contexto-targets.txt.
 *  5. Cap to ~10k for v1 (faster embedding generation).
 *  6. Embed each word with @xenova/transformers (all-MiniLM-L6-v2, 384 dim).
 *  7. Write data/contexto/_vocab.json (committed) and _vocab-embeddings.bin (gitignored).
 *
 * Run once on dev machine: `node scripts/contexto-build-vocab.js`
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const lemmatizer = require('wink-lemmatizer');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data', 'contexto');
const TARGETS_FILE = path.join(__dirname, 'contexto-targets.txt');
const VOCAB_FILE = path.join(DATA_DIR, '_vocab.json');
const EMBEDDINGS_FILE = path.join(DATA_DIR, '_vocab-embeddings.bin');
const WORDLIST_CACHE = path.join(__dirname, '.cache-google-20k.txt');

// Sourced from first20hours/google-10000-english; full 10k variant for better coverage.
// Plus dolph/dictionary 20k for supplementary common words (mud, dirt, bush, etc.).
const WORDLIST_URL = 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-usa-no-swears.txt';
const EXTRA_WORDLIST_URL = 'https://raw.githubusercontent.com/dolph/dictionary/master/popular.txt';

const TARGET_VOCAB_SIZE = 20000;
const EMBED_BATCH = 32;
const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath)) {
      console.log(`[cached] ${destPath}`);
      return resolve(fs.readFileSync(destPath, 'utf8'));
    }
    console.log(`[fetch] ${url}`);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return download(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        fs.writeFileSync(destPath, body);
        resolve(body);
      });
    }).on('error', reject);
  });
}

function loadTargets() {
  const text = fs.readFileSync(TARGETS_FILE, 'utf8');
  return text.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function curateVocab(rawWords, targets) {
  const set = new Set();

  for (const raw of rawWords) {
    const w = raw.trim().toLowerCase();
    if (w.length < 3 || w.length > 16) continue;
    if (!/^[a-z]+$/.test(w)) continue;

    // Lemmatize: try noun → verb → adjective. Keep the SHORTEST canonical form.
    const candidates = [
      w,
      lemmatizer.noun(w),
      lemmatizer.verb(w),
      lemmatizer.adjective(w),
    ];
    let canonical = candidates.reduce((best, c) => c.length < best.length ? c : best, w);
    set.add(canonical);
  }

  // Force-include targets (using their raw form, no lemmatization)
  for (const t of targets) {
    if (/^[a-z]+$/.test(t) && t.length >= 3) set.add(t);
  }

  return [...set];
}

async function embedAll(words) {
  console.log(`[embed] loading model ${EMBED_MODEL} (first run downloads ~25MB)...`);
  // @xenova/transformers is ESM-only; use dynamic import.
  const { pipeline } = await import('@xenova/transformers');
  const embedder = await pipeline('feature-extraction', EMBED_MODEL, {
    quantized: true,
  });
  console.log('[embed] model loaded.');

  const dim = 384; // all-MiniLM-L6-v2 output dim
  const out = new Float32Array(words.length * dim);
  const startTime = Date.now();

  for (let i = 0; i < words.length; i += EMBED_BATCH) {
    const batch = words.slice(i, i + EMBED_BATCH);
    const result = await embedder(batch, { pooling: 'mean', normalize: true });
    // result.data is a Float32Array of shape [batch.length, dim]
    out.set(result.data, i * dim);

    if (i % (EMBED_BATCH * 10) === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (i + batch.length) / elapsed;
      const eta = Math.round((words.length - i - batch.length) / rate);
      process.stdout.write(`\r[embed] ${i + batch.length}/${words.length} (${rate.toFixed(1)}/s, ETA ${eta}s)   `);
    }
  }
  process.stdout.write('\n');
  return out;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 1. Load/download word lists
  const rawText = await download(WORDLIST_URL, WORDLIST_CACHE);
  const extraText = await download(EXTRA_WORDLIST_URL, path.join(__dirname, '.cache-popular-20k.txt'));
  const googleWords = rawText.split('\n').filter(Boolean);
  const extraWords = extraText.split('\n').filter(Boolean);
  // Merge, keeping Google words first (for frequency ordering) then extras
  const seen = new Set();
  const rawWords = [];
  for (const w of [...googleWords, ...extraWords]) {
    const lw = w.trim().toLowerCase();
    if (lw && !seen.has(lw)) { seen.add(lw); rawWords.push(lw); }
  }
  console.log(`[source] ${googleWords.length} google + ${extraWords.length} popular = ${rawWords.length} deduped`);

  // 2. Load targets
  const targets = loadTargets();
  console.log(`[targets] ${targets.length} target words`);

  // 3. Curate
  let vocab = curateVocab(rawWords, targets);
  console.log(`[curate] ${vocab.length} unique lemmatized words`);

  if (vocab.length > TARGET_VOCAB_SIZE) {
    // Keep targets first, then trim by original frequency order
    const targetSet = new Set(targets);
    const inTargets = vocab.filter(w => targetSet.has(w));
    const notInTargets = vocab.filter(w => !targetSet.has(w));
    vocab = [...inTargets, ...notInTargets].slice(0, TARGET_VOCAB_SIZE);
    console.log(`[cap] trimmed to ${vocab.length}`);
  }

  // Verify all targets present
  const vocabSet = new Set(vocab);
  for (const t of targets) {
    if (!vocabSet.has(t)) console.warn(`[warn] target "${t}" missing from vocab`);
  }

  // 4. Embed
  const embeddings = await embedAll(vocab);

  // 5. Write
  fs.writeFileSync(VOCAB_FILE, JSON.stringify(vocab));
  fs.writeFileSync(EMBEDDINGS_FILE, Buffer.from(embeddings.buffer));
  console.log(`[write] ${VOCAB_FILE} (${(fs.statSync(VOCAB_FILE).size / 1024).toFixed(0)}KB)`);
  console.log(`[write] ${EMBEDDINGS_FILE} (${(fs.statSync(EMBEDDINGS_FILE).size / 1024 / 1024).toFixed(1)}MB)`);
  console.log('[done]');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
