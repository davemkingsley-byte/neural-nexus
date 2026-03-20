const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use persistent volume on Railway (/data), fallback to local
const dataExists = fs.existsSync('/data');
const dbDir = dataExists ? '/data' : path.join(__dirname, '..');
const dbPath = path.join(dbDir, 'cognitive.db');
console.log(`Cognitive DB path: ${dbPath}`);
console.log(`/data volume mounted: ${dataExists}`);
if (!dataExists) {
  console.warn('WARNING: /data volume not found! Cognitive DB will be EPHEMERAL and reset on deploy.');
}

let db;

try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.error('Failed to open cognitive database:', err);
}

function initDB() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_type TEXT NOT NULL CHECK(test_type IN ('nback', 'pvt', 'dsst')),
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        scores_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS chess_elo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        blitz_rating INTEGER,
        rapid_rating INTEGER,
        bullet_rating INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS supplements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        compound_name TEXT NOT NULL,
        start_date TEXT NOT NULL,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS daily_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        subjective_energy INTEGER,
        subjective_focus INTEGER,
        sleep_hours REAL,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_test_results_date ON test_results(date);
      CREATE INDEX IF NOT EXISTS idx_test_results_type ON test_results(test_type);
      CREATE INDEX IF NOT EXISTS idx_chess_elo_date ON chess_elo(date);
      CREATE INDEX IF NOT EXISTS idx_daily_notes_date ON daily_notes(date);
    `);

    // Pre-populate supplements if table is empty
    const count = db.prepare('SELECT COUNT(*) as cnt FROM supplements').get();
    if (count.cnt === 0) {
      const insert = db.prepare('INSERT INTO supplements (compound_name, start_date, notes) VALUES (?, ?, ?)');
      const seedSupplements = db.transaction(() => {
        insert.run("Lion's Mane", '2026-02-18', null);
        insert.run('KSM-66 (Ashwagandha)', '2026-02-18', null);
        insert.run('Primavie (Shilajit)', '2026-02-18', null);
        insert.run('Magtein (Mag L-Threonate)', '2026-03-18', null);
        insert.run('D3+K2', '2026-03-18', null);
        insert.run('L-Theanine (Suntheanine)', '2026-03-20', null);
        insert.run('Bacopa (BaCognize)', '2026-03-20', null);
        insert.run('Alpha-GPC', '2026-03-20', null);
      });
      seedSupplements();
      console.log('Cognitive DB: seeded default supplements');
    }

    console.log('Cognitive DB initialized successfully');
  } catch (err) {
    console.error('Failed to initialize cognitive database:', err);
  }
}

const stmts = {};

function prepareStatements() {
  stmts.insertResult = db.prepare(
    'INSERT INTO test_results (test_type, date, time, scores_json) VALUES (?, ?, ?, ?)'
  );
  stmts.getResults = db.prepare(
    `SELECT * FROM test_results
     WHERE date >= date('now', '-' || ? || ' days')
     ORDER BY date DESC, time DESC`
  );
  stmts.getResultsByType = db.prepare(
    `SELECT * FROM test_results
     WHERE test_type = ? AND date >= date('now', '-' || ? || ' days')
     ORDER BY date DESC, time DESC`
  );
  stmts.upsertChessElo = db.prepare(
    `INSERT INTO chess_elo (date, blitz_rating, rapid_rating, bullet_rating)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       blitz_rating = excluded.blitz_rating,
       rapid_rating = excluded.rapid_rating,
       bullet_rating = excluded.bullet_rating`
  );
  stmts.getChessElo = db.prepare(
    `SELECT * FROM chess_elo
     WHERE date >= date('now', '-' || ? || ' days')
     ORDER BY date DESC`
  );
  stmts.getSupplements = db.prepare(
    'SELECT * FROM supplements ORDER BY start_date'
  );
  stmts.addSupplement = db.prepare(
    'INSERT INTO supplements (compound_name, start_date, notes) VALUES (?, ?, ?)'
  );
  stmts.upsertDailyNote = db.prepare(
    `INSERT INTO daily_notes (date, subjective_energy, subjective_focus, sleep_hours, notes)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       subjective_energy = excluded.subjective_energy,
       subjective_focus = excluded.subjective_focus,
       sleep_hours = excluded.sleep_hours,
       notes = excluded.notes`
  );
  stmts.getDailyNotes = db.prepare(
    `SELECT * FROM daily_notes
     WHERE date >= date('now', '-' || ? || ' days')
     ORDER BY date DESC`
  );
  stmts.bestNback = db.prepare(
    `SELECT * FROM test_results
     WHERE test_type = 'nback'
     ORDER BY json_extract(scores_json, '$.max_n') DESC LIMIT 1`
  );
  stmts.bestPvt = db.prepare(
    `SELECT * FROM test_results
     WHERE test_type = 'pvt'
     ORDER BY json_extract(scores_json, '$.median_rt') ASC LIMIT 1`
  );
  stmts.bestDsst = db.prepare(
    `SELECT * FROM test_results
     WHERE test_type = 'dsst'
     ORDER BY json_extract(scores_json, '$.correct') DESC LIMIT 1`
  );
  stmts.getAverages = db.prepare(
    `SELECT scores_json FROM test_results
     WHERE test_type = ? AND date >= date('now', '-' || ? || ' days')`
  );
}

// chess_elo needs a unique constraint on date for upsert to work
function ensureChessUniqueDate() {
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chess_elo_date_unique ON chess_elo(date)');
  } catch (err) {
    // index may already exist
  }
}

module.exports = {
  db,

  initDB() {
    initDB();
    ensureChessUniqueDate();
    prepareStatements();
  },

  saveResult(test_type, date, time, scores_json) {
    return stmts.insertResult.run(test_type, date, time, scores_json);
  },

  getResults(days = 30) {
    return stmts.getResults.all(days);
  },

  getResultsByType(test_type, days = 30) {
    return stmts.getResultsByType.all(test_type, days);
  },

  saveChessElo(date, blitz, rapid, bullet) {
    return stmts.upsertChessElo.run(date, blitz, rapid, bullet);
  },

  getChessElo(days = 90) {
    return stmts.getChessElo.all(days);
  },

  getSupplements() {
    return stmts.getSupplements.all();
  },

  addSupplement(compound_name, start_date, notes) {
    return stmts.addSupplement.run(compound_name, start_date, notes || null);
  },

  saveDailyNote(date, energy, focus, sleep_hours, notes) {
    return stmts.upsertDailyNote.run(date, energy, focus, sleep_hours, notes || null);
  },

  getDailyNotes(days = 30) {
    return stmts.getDailyNotes.all(days);
  },

  getPersonalBests() {
    return {
      nback: stmts.bestNback.get() || null,
      pvt: stmts.bestPvt.get() || null,
      dsst: stmts.bestDsst.get() || null,
    };
  },

  getAverages(test_type, days = 30) {
    const rows = stmts.getAverages.all(test_type, days);
    if (rows.length === 0) return null;

    const parsed = rows.map(r => JSON.parse(r.scores_json));

    if (test_type === 'nback') {
      const avgLevel = parsed.reduce((sum, s) => sum + (s.max_n || 0), 0) / parsed.length;
      const avgAccuracy = parsed.reduce((sum, s) => sum + (s.combined_accuracy || 0), 0) / parsed.length;
      return { avg_max_n: Math.round(avgLevel * 100) / 100, avg_accuracy: Math.round(avgAccuracy * 100) / 100, count: parsed.length };
    }

    if (test_type === 'pvt') {
      const avgRt = parsed.reduce((sum, s) => sum + (s.median_rt || 0), 0) / parsed.length;
      return { avg_median_rt: Math.round(avgRt * 100) / 100, count: parsed.length };
    }

    if (test_type === 'dsst') {
      const avgCorrect = parsed.reduce((sum, s) => sum + (s.correct || 0), 0) / parsed.length;
      return { avg_correct: Math.round(avgCorrect * 100) / 100, count: parsed.length };
    }

    return null;
  },

  close() {
    db.close();
  }
};
