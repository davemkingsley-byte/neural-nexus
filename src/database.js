const Database = require('better-sqlite3');
const path = require('path');

// Use persistent volume on Railway (/data), fallback to local
const fs = require('fs');
const dataExists = fs.existsSync('/data');
const dbDir = dataExists ? '/data' : path.join(__dirname, '..');
const dbPath = path.join(dbDir, 'spelling-bee.db');
console.log(`Database path: ${dbPath}`);
console.log(`/data volume mounted: ${dataExists}`);
if (!dataExists) {
  console.warn('WARNING: /data volume not found! Database will be EPHEMERAL and reset on deploy.');
}
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS puzzles (
    date TEXT PRIMARY KEY,
    letters TEXT NOT NULL,
    center_letter TEXT NOT NULL,
    word_list TEXT NOT NULL,
    max_score INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    nickname TEXT NOT NULL,
    score INTEGER NOT NULL,
    words_found TEXT NOT NULL,
    time_remaining INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_scores_date ON scores(date);
  CREATE INDEX IF NOT EXISTS idx_scores_date_score ON scores(date, score DESC);

  CREATE TABLE IF NOT EXISTS wordle_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    nickname TEXT NOT NULL,
    guesses INTEGER NOT NULL,
    won INTEGER NOT NULL,
    guess_details TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wordle_scores_date ON wordle_scores(date);

  CREATE TABLE IF NOT EXISTS crossword_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    nickname TEXT NOT NULL,
    time_seconds INTEGER NOT NULL,
    completed INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_crossword_scores_date ON crossword_scores(date);

  CREATE TABLE IF NOT EXISTS connections_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    nickname TEXT NOT NULL,
    mistakes INTEGER NOT NULL,
    completed INTEGER NOT NULL,
    solved_order TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_connections_scores_date ON connections_scores(date);
`);

const stmts = {
  getPuzzle: db.prepare('SELECT * FROM puzzles WHERE date = ?'),
  insertPuzzle: db.prepare('INSERT OR REPLACE INTO puzzles (date, letters, center_letter, word_list, max_score) VALUES (?, ?, ?, ?, ?)'),
  insertScore: db.prepare('INSERT INTO scores (date, nickname, score, words_found, time_remaining) VALUES (?, ?, ?, ?, ?)'),
  getLeaderboard: db.prepare('SELECT nickname, score, words_found, time_remaining FROM scores WHERE date = ? ORDER BY score DESC, time_remaining DESC LIMIT 50'),
  getPastPuzzles: db.prepare('SELECT date, letters, center_letter, max_score, (SELECT COUNT(*) FROM scores s WHERE s.date = p.date) as entry_count FROM puzzles p ORDER BY date DESC LIMIT 60'),
  getPuzzleByDate: db.prepare('SELECT * FROM puzzles WHERE date = ?'),
  getSpellingBeeScoresByDate: db.prepare('SELECT nickname, score, words_found, time_remaining FROM scores WHERE date = ? ORDER BY score DESC, time_remaining DESC LIMIT 50'),

  insertWordleScore: db.prepare('INSERT INTO wordle_scores (date, nickname, guesses, won, guess_details) VALUES (?, ?, ?, ?, ?)'),
  getWordleLeaderboard: db.prepare('SELECT nickname, guesses, won, guess_details FROM wordle_scores WHERE date = ? AND won = 1 ORDER BY guesses ASC, created_at ASC LIMIT 50'),
  getWordleAllByDate: db.prepare('SELECT nickname, guesses, won, guess_details FROM wordle_scores WHERE date = ? ORDER BY guesses ASC, created_at ASC LIMIT 50'),
  getPastWordleDates: db.prepare('SELECT DISTINCT date FROM wordle_scores ORDER BY date DESC LIMIT 60'),

  insertCrosswordScore: db.prepare('INSERT INTO crossword_scores (date, nickname, time_seconds, completed) VALUES (?, ?, ?, ?)'),
  getCrosswordLeaderboard: db.prepare('SELECT nickname, time_seconds, completed FROM crossword_scores WHERE date = ? AND completed = 1 ORDER BY time_seconds ASC, created_at ASC LIMIT 50'),
  getCrosswordAllByDate: db.prepare('SELECT nickname, time_seconds, completed FROM crossword_scores WHERE date = ? ORDER BY time_seconds ASC, created_at ASC LIMIT 50'),
  getPastCrosswordDates: db.prepare('SELECT DISTINCT date FROM crossword_scores ORDER BY date DESC LIMIT 60'),

  insertConnectionsScore: db.prepare('INSERT INTO connections_scores (date, nickname, mistakes, completed, solved_order) VALUES (?, ?, ?, ?, ?)'),
  getConnectionsLeaderboard: db.prepare('SELECT nickname, mistakes, completed, solved_order FROM connections_scores WHERE date = ? AND completed = 1 ORDER BY mistakes ASC, created_at ASC LIMIT 50'),
  getConnectionsAllByDate: db.prepare('SELECT nickname, mistakes, completed, solved_order FROM connections_scores WHERE date = ? ORDER BY mistakes ASC, created_at ASC LIMIT 50'),
  getPastConnectionsDates: db.prepare('SELECT DISTINCT date FROM connections_scores ORDER BY date DESC LIMIT 60'),
};

module.exports = {
  getPuzzle(date) {
    const row = stmts.getPuzzle.get(date);
    if (!row) return null;
    return {
      ...row,
      word_list: JSON.parse(row.word_list),
    };
  },

  savePuzzle(date, letters, centerLetter, wordList, maxScore) {
    stmts.insertPuzzle.run(date, letters, centerLetter, JSON.stringify(wordList), maxScore);
  },

  submitScore(date, nickname, score, wordsFound, timeRemaining) {
    stmts.insertScore.run(date, nickname, score, JSON.stringify(wordsFound), timeRemaining);
  },

  getLeaderboard(date) {
    return stmts.getLeaderboard.all(date).map(row => ({
      ...row,
      words_found: JSON.parse(row.words_found),
    }));
  },

  getPastPuzzles() {
    return stmts.getPastPuzzles.all();
  },

  getSpellingBeeByDate(date) {
    const puzzle = stmts.getPuzzleByDate.get(date);
    if (!puzzle) return null;
    const scores = stmts.getSpellingBeeScoresByDate.all(date).map(row => ({
      ...row,
      words_found: JSON.parse(row.words_found),
    }));
    return { puzzle, scores };
  },

  // Wordle
  submitWordleScore(date, nickname, guesses, won, guessDetails) {
    stmts.insertWordleScore.run(date, nickname, guesses, won ? 1 : 0, JSON.stringify(guessDetails));
  },

  getWordleLeaderboard(date) {
    return stmts.getWordleLeaderboard.all(date).map(row => ({
      ...row,
      guess_details: JSON.parse(row.guess_details),
    }));
  },

  getWordleAllByDate(date) {
    return stmts.getWordleAllByDate.all(date).map(row => ({
      ...row,
      guess_details: JSON.parse(row.guess_details),
    }));
  },

  getPastWordleDates() {
    return stmts.getPastWordleDates.all().map(r => r.date);
  },

  // Crossword
  submitCrosswordScore(date, nickname, timeSeconds, completed) {
    stmts.insertCrosswordScore.run(date, nickname, timeSeconds, completed ? 1 : 0);
  },

  getCrosswordLeaderboard(date) {
    return stmts.getCrosswordLeaderboard.all(date);
  },

  getCrosswordAllByDate(date) {
    return stmts.getCrosswordAllByDate.all(date);
  },

  getPastCrosswordDates() {
    return stmts.getPastCrosswordDates.all().map(r => r.date);
  },

  // Connections
  submitConnectionsScore(date, nickname, mistakes, completed, solvedOrder) {
    stmts.insertConnectionsScore.run(date, nickname, mistakes, completed ? 1 : 0, JSON.stringify(solvedOrder));
  },

  getConnectionsLeaderboard(date) {
    return stmts.getConnectionsLeaderboard.all(date).map(row => ({
      ...row,
      solved_order: JSON.parse(row.solved_order),
    }));
  },

  getConnectionsAllByDate(date) {
    return stmts.getConnectionsAllByDate.all(date).map(row => ({
      ...row,
      solved_order: JSON.parse(row.solved_order),
    }));
  },

  getPastConnectionsDates() {
    return stmts.getPastConnectionsDates.all().map(r => r.date);
  },

  close() {
    db.close();
  }
};
