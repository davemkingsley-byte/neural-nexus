const Database = require('better-sqlite3');
const path = require('path');

// Use persistent volume on Railway (/data), fallback to local
const fs = require('fs');
const dbDir = fs.existsSync('/data') ? '/data' : path.join(__dirname, '..');
const dbPath = path.join(dbDir, 'spelling-bee.db');
console.log('Database path:', dbPath);
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
`);

const stmts = {
  getPuzzle: db.prepare('SELECT * FROM puzzles WHERE date = ?'),
  insertPuzzle: db.prepare('INSERT OR REPLACE INTO puzzles (date, letters, center_letter, word_list, max_score) VALUES (?, ?, ?, ?, ?)'),
  insertScore: db.prepare('INSERT INTO scores (date, nickname, score, words_found, time_remaining) VALUES (?, ?, ?, ?, ?)'),
  getLeaderboard: db.prepare('SELECT nickname, score, words_found, time_remaining FROM scores WHERE date = ? ORDER BY score DESC, time_remaining DESC LIMIT 50'),
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

  close() {
    db.close();
  }
};
