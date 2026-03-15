const express = require('express');
const path = require('path');

// Import spelling bee modules
const spellDB = require('./src/database');
const { generatePuzzle, validateWord } = require('./src/puzzle-generator');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve the game page
app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

// --- Spelling Bee API ---
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
