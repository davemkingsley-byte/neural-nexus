const words = require('./words');

// Deterministic seeded random number generator (mulberry32)
function seededRandom(seed) {
  let t = seed + 0x6D2B79F5;
  return function () {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dateToSeed(dateStr) {
  // Convert YYYY-MM-DD to a numeric seed
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = ((hash << 5) - hash) + dateStr.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getUniqueLetters(word) {
  return new Set(word.split(''));
}

function findPangrams() {
  const wordMap = words.getWordMap();
  const pangrams = [];
  for (const [word, tier] of Object.entries(wordMap)) {
    const unique = getUniqueLetters(word);
    if (unique.size === 7) {
      pangrams.push({ word, letters: [...unique], tier });
    }
  }
  return pangrams;
}

// Cache pangrams
let pangramCache = null;
function getPangrams() {
  if (!pangramCache) pangramCache = findPangrams();
  return pangramCache;
}

function findValidWords(letters, centerLetter) {
  const wordMap = words.getWordMap();
  const letterSet = new Set(letters);
  const validWords = [];

  for (const [word, tier] of Object.entries(wordMap)) {
    if (word.length < 4) continue;
    if (!word.includes(centerLetter)) continue;

    let valid = true;
    for (const ch of word) {
      if (!letterSet.has(ch)) {
        valid = false;
        break;
      }
    }
    if (valid) {
      const isPangram = getUniqueLetters(word).size === 7;
      validWords.push({ word, tier, isPangram });
    }
  }

  return validWords;
}

function scoreWord(word, tier, isPangram) {
  let base = word.length === 4 ? 1 : word.length;
  const multiplier = words.getMultiplier(word);
  let score = Math.round(base * multiplier);
  if (isPangram) score += 7;
  return score;
}

function generatePuzzle(dateStr) {
  const rand = seededRandom(dateToSeed(dateStr));
  const pangrams = getPangrams();

  if (pangrams.length === 0) {
    throw new Error('No pangrams found in word list');
  }

  // Pick a pangram deterministically based on date
  const pangramIdx = Math.floor(rand() * pangrams.length);
  const chosen = pangrams[pangramIdx];
  const letters = [...chosen.letters];

  // Shuffle letters
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }

  // Pick center letter (first after shuffle)
  const centerLetter = letters[0];

  // Find all valid words
  const validWords = findValidWords(letters, centerLetter);

  // Need at least some words to be a good puzzle
  if (validWords.length < 10) {
    // Try next pangram
    const nextIdx = (pangramIdx + 1) % pangrams.length;
    const next = pangrams[nextIdx];
    return generateFromPangram(next, rand);
  }

  // Calculate max score
  let maxScore = 0;
  const wordList = validWords.map(({ word, tier, isPangram }) => {
    const score = scoreWord(word, tier, isPangram);
    maxScore += score;
    return { word, tier, isPangram, score };
  });

  return {
    date: dateStr,
    letters: letters.join(''),
    centerLetter,
    wordList,
    maxScore,
  };
}

function generateFromPangram(pangram, rand) {
  const letters = [...pangram.letters];
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  const centerLetter = letters[0];
  const validWords = findValidWords(letters, centerLetter);
  let maxScore = 0;
  const wordList = validWords.map(({ word, tier, isPangram }) => {
    const score = scoreWord(word, tier, isPangram);
    maxScore += score;
    return { word, tier, isPangram, score };
  });

  return {
    letters: letters.join(''),
    centerLetter,
    wordList,
    maxScore,
  };
}

function validateWord(word, letters, centerLetter) {
  if (word.length < 4) return { valid: false, reason: 'Too short (min 4 letters)' };
  if (!word.includes(centerLetter)) return { valid: false, reason: 'Must include center letter' };

  const letterSet = new Set(letters.split(''));
  for (const ch of word) {
    if (!letterSet.has(ch)) return { valid: false, reason: 'Uses invalid letter' };
  }

  if (!words.isValid(word)) return { valid: false, reason: 'Not in word list' };

  const tier = words.getTier(word);
  const isPangram = getUniqueLetters(word).size === letters.length;
  const score = scoreWord(word, tier, isPangram);

  return { valid: true, tier, isPangram, score };
}

module.exports = { generatePuzzle, validateWord, scoreWord };
