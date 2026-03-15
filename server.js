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

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', dbReady, time: new Date().toISOString() });
});

// Serve the game page
app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

// --- Spelling Bee API ---
function checkDB(res) {
  if (!dbReady) { res.status(503).json({ error: 'Game database not available' }); return false; }
  return true;
}

function getTodayStr() {
  const now = new Date();
  return now.toISOString().split('T')[0];
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
