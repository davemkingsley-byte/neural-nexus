// Contexto puzzle loader + ranking lookup.
// Precomputed rankings live in data/contexto/YYYY-MM-DD.json.

const fs = require('fs');
const path = require('path');
const { lemmatize } = require('./contexto-lemmatize');

const PUZZLE_DIR = path.join(__dirname, '..', 'data', 'contexto');
const MAX_CACHE = 10;
const cache = new Map(); // date → puzzle

function listAvailableDates() {
  try {
    return fs.readdirSync(PUZZLE_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function hashDateToIndex(dateStr, length) {
  const parts = dateStr.split('-');
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  const year = parseInt(parts[0], 10);
  const d = `${month}/${day}/${year}`;
  let hash = 0;
  for (let i = 0; i < d.length; i++) {
    hash = ((hash << 5) - hash) + d.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % length;
}

function loadPuzzleFile(date) {
  const file = path.join(PUZZLE_DIR, `${date}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Build inverse map for hint lookups (rank -> word)
    const rankToWord = new Array(raw.totalWords + 1);
    for (const [word, rank] of Object.entries(raw.rankings)) {
      rankToWord[rank] = word;
    }
    return {
      date: raw.date,
      target: raw.target,
      totalWords: raw.totalWords,
      rankings: raw.rankings,
      rankToWord,
    };
  } catch (e) {
    console.error(`[contexto] failed to load ${file}:`, e.message);
    return null;
  }
}

function getPuzzleForDate(dateStr) {
  if (cache.has(dateStr)) return cache.get(dateStr);

  // Try exact date match first
  let puzzle = loadPuzzleFile(dateStr);

  // Fall back to deterministic hash index over available dates
  if (!puzzle) {
    const dates = listAvailableDates();
    if (dates.length === 0) return null;
    const idx = hashDateToIndex(dateStr, dates.length);
    puzzle = loadPuzzleFile(dates[idx]);
    if (puzzle) {
      // Override the puzzle's own date field to match the requested date
      puzzle = { ...puzzle, date: dateStr };
    }
  }

  if (puzzle) {
    // LRU-trim
    if (cache.size >= MAX_CACHE) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(dateStr, puzzle);
  }
  return puzzle;
}

// Look up a guess. Returns { inVocab, lemma, rank, isTarget } or { inVocab: false }.
function lookupRank(puzzle, guess) {
  if (!puzzle) return { inVocab: false };
  const candidates = lemmatize(guess);
  for (const cand of candidates) {
    const rank = puzzle.rankings[cand];
    if (rank !== undefined) {
      return {
        inVocab: true,
        lemma: cand,
        rank,
        isTarget: rank === 1,
      };
    }
  }
  return { inVocab: false };
}

// Hint: reveal a word with rank approximately bestRank/2.
// Returns { word, rank } or null if bestRank <= 5 (too close to spoil).
function getHint(puzzle, bestRank) {
  if (!puzzle) return null;
  const best = Number(bestRank);
  if (!Number.isFinite(best) || best <= 5) return null;
  const targetRank = Math.max(5, Math.floor(best / 2));
  const word = puzzle.rankToWord[targetRank];
  if (!word) return null;
  return { word, rank: targetRank };
}

module.exports = {
  getPuzzleForDate,
  lookupRank,
  getHint,
  listAvailableDates,
};
