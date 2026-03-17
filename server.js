const express = require('express');
const path = require('path');

let spellDB, generatePuzzle, validateWord;
let dbReady = false;

try {
  spellDB = require('./src/database');
  const pg = require('./src/puzzle-generator');
  generatePuzzle = pg.generatePuzzle;
  validateWord = pg.validateWord;
  dbReady = true;
  console.log('Database and puzzle generator loaded successfully');
} catch (err) {
  console.error('Failed to load game modules:', err.message);
  console.error(err.stack);
}

// Wordle module
let wordleWords;
try {
  wordleWords = require('./src/wordle-words');
  console.log('Wordle module loaded successfully');
} catch (err) {
  console.error('Failed to load Wordle module:', err.message);
}

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', dbReady, time: new Date().toISOString() });
});

// Serve game pages
app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});
app.get('/wordle', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wordle.html'));
});

app.get('/crossword', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'crossword.html'));
});

// --- Wordle API ---
app.get('/api/wordle/today', (req, res) => {
  if (!wordleWords) return res.status(503).json({ error: 'Wordle not available' });
  const { word, date } = wordleWords.getTodayWord();
  // Don't send the word to the client — only the date and word length
  res.json({ date, length: word.length });
});

app.post('/api/wordle/guess', (req, res) => {
  if (!wordleWords) return res.status(503).json({ error: 'Wordle not available' });
  const { guess } = req.body;
  if (!guess || guess.length !== 5) return res.json({ valid: false });
  
  const g = guess.toLowerCase();
  if (!wordleWords.isValidGuess(g)) return res.json({ valid: false });
  
  const { word } = wordleWords.getTodayWord();
  const result = [];
  const wordArr = word.split('');
  const guessArr = g.split('');
  const used = Array(5).fill(false);
  
  // First pass: correct positions
  for (let i = 0; i < 5; i++) {
    if (guessArr[i] === wordArr[i]) {
      result[i] = 'correct';
      used[i] = true;
    }
  }
  // Second pass: wrong position
  for (let i = 0; i < 5; i++) {
    if (result[i]) continue;
    let found = false;
    for (let j = 0; j < 5; j++) {
      if (!used[j] && guessArr[i] === wordArr[j]) {
        result[i] = 'present';
        used[j] = true;
        found = true;
        break;
      }
    }
    if (!found) result[i] = 'absent';
  }
  
  res.json({ valid: true, result, correct: g === word });
});

// --- Spelling Bee API ---
function checkDB(res) {
  if (!dbReady) { res.status(503).json({ error: 'Game database not available' }); return false; }
  return true;
}

function getTodayStr() {
  return new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }).split(',')[0];
}

function ensurePuzzle(dateStr) {
  let puzzle = spellDB.getPuzzle(dateStr);
  if (!puzzle) {
    const generated = generatePuzzle(dateStr);
    spellDB.savePuzzle(dateStr, generated.letters, generated.centerLetter, generated.wordList, generated.maxScore);
    puzzle = spellDB.getPuzzle(dateStr);
  }
  return puzzle;
}

app.get('/api/puzzle', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const dateStr = getTodayStr();
    const puzzle = ensurePuzzle(dateStr);
    res.json({
      date: puzzle.date,
      letters: puzzle.letters.split(''),
      centerLetter: puzzle.center_letter,
      totalWords: puzzle.word_list.length,
      maxScore: puzzle.max_score,
    });
  } catch (err) {
    console.error('Error getting puzzle:', err);
    res.status(500).json({ error: 'Failed to generate puzzle' });
  }
});

app.post('/api/validate', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const { word } = req.body;
    const dateStr = getTodayStr();
    const puzzle = ensurePuzzle(dateStr);
    const result = validateWord(word.toLowerCase(), puzzle.letters, puzzle.center_letter);
    res.json(result);
  } catch (err) {
    console.error('Error validating:', err);
    res.status(500).json({ error: 'Validation failed' });
  }
});

app.post('/api/score', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const { nickname, score, words_found, time_remaining } = req.body;
    const dateStr = getTodayStr();
    spellDB.submitScore(dateStr, nickname, score, words_found, time_remaining);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving score:', err);
    res.status(500).json({ error: 'Failed to save score' });
  }
});

app.get('/api/leaderboard', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const dateStr = getTodayStr();
    const scores = spellDB.getLeaderboard(dateStr);
    res.json({ entries: scores });
  } catch (err) {
    console.error('Error getting leaderboard:', err);
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Neural NeXus running on http://localhost:${PORT}`);
});
