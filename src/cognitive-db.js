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
        session TEXT,
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

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS whoop_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        sleep_duration_min REAL,
        deep_sleep_min REAL,
        rem_sleep_min REAL,
        light_sleep_min REAL,
        awake_min REAL,
        sleep_cycles INTEGER,
        disturbances INTEGER,
        respiratory_rate REAL,
        sleep_performance REAL,
        sleep_consistency REAL,
        sleep_efficiency REAL,
        recovery_score REAL,
        resting_hr REAL,
        hrv_rmssd REAL,
        spo2 REAL,
        skin_temp REAL,
        raw_sleep_json TEXT,
        raw_recovery_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS whoop_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT,
        refresh_token TEXT,
        expires_at TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS experiment_phases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phase_type TEXT NOT NULL CHECK(phase_type IN ('baseline', 'intervention', 'washout', 'custom')),
        compounds TEXT,
        start_date TEXT NOT NULL,
        end_date TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS public_brain_check (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        score INTEGER,
        pvt_ms REAL,
        dsst_score INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_test_results_date ON test_results(date);
      CREATE INDEX IF NOT EXISTS idx_test_results_type ON test_results(test_type);
      CREATE INDEX IF NOT EXISTS idx_chess_elo_date ON chess_elo(date);
      CREATE INDEX IF NOT EXISTS idx_daily_notes_date ON daily_notes(date);
      CREATE INDEX IF NOT EXISTS idx_whoop_data_date ON whoop_data(date);
    `);

    // Add session column to existing test_results if missing
    try {
      db.exec('ALTER TABLE test_results ADD COLUMN session TEXT');
    } catch (e) {
      // column already exists
    }

    // Add phase_id column to existing test_results if missing
    try {
      db.exec('ALTER TABLE test_results ADD COLUMN phase_id INTEGER REFERENCES experiment_phases(id)');
    } catch (e) {
      // column already exists
    }

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
    'INSERT INTO test_results (test_type, date, time, scores_json, session, phase_id) VALUES (?, ?, ?, ?, ?, ?)'
  );
  stmts.getActivePhase = db.prepare(
    'SELECT * FROM experiment_phases WHERE end_date IS NULL ORDER BY start_date DESC LIMIT 1'
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
  stmts.getAllResults = db.prepare(
    'SELECT * FROM test_results ORDER BY date ASC, time ASC'
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
  stmts.getAllChessElo = db.prepare(
    'SELECT * FROM chess_elo ORDER BY date ASC'
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
  stmts.getAllDailyNotes = db.prepare(
    'SELECT * FROM daily_notes ORDER BY date ASC'
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
  stmts.getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  stmts.upsertSetting = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  stmts.getAllSettings = db.prepare('SELECT * FROM settings');

  // WHOOP statements
  stmts.upsertWhoopData = db.prepare(
    `INSERT INTO whoop_data (date, sleep_duration_min, deep_sleep_min, rem_sleep_min, light_sleep_min, awake_min, sleep_cycles, disturbances, respiratory_rate, sleep_performance, sleep_consistency, sleep_efficiency, recovery_score, resting_hr, hrv_rmssd, spo2, skin_temp, raw_sleep_json, raw_recovery_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       sleep_duration_min = excluded.sleep_duration_min,
       deep_sleep_min = excluded.deep_sleep_min,
       rem_sleep_min = excluded.rem_sleep_min,
       light_sleep_min = excluded.light_sleep_min,
       awake_min = excluded.awake_min,
       sleep_cycles = excluded.sleep_cycles,
       disturbances = excluded.disturbances,
       respiratory_rate = excluded.respiratory_rate,
       sleep_performance = excluded.sleep_performance,
       sleep_consistency = excluded.sleep_consistency,
       sleep_efficiency = excluded.sleep_efficiency,
       recovery_score = excluded.recovery_score,
       resting_hr = excluded.resting_hr,
       hrv_rmssd = excluded.hrv_rmssd,
       spo2 = excluded.spo2,
       skin_temp = excluded.skin_temp,
       raw_sleep_json = excluded.raw_sleep_json,
       raw_recovery_json = excluded.raw_recovery_json`
  );
  stmts.getWhoopData = db.prepare(
    `SELECT * FROM whoop_data WHERE date >= date('now', '-' || ? || ' days') ORDER BY date DESC`
  );
  stmts.getAllWhoopData = db.prepare('SELECT * FROM whoop_data ORDER BY date ASC');
  stmts.upsertWhoopTokens = db.prepare(
    `INSERT INTO whoop_tokens (id, access_token, refresh_token, expires_at, updated_at)
     VALUES (1, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       updated_at = datetime('now')`
  );
  stmts.getWhoopTokens = db.prepare('SELECT * FROM whoop_tokens WHERE id = 1');

  // Brain Check leaderboard
  stmts.insertBrainCheck = db.prepare(
    'INSERT INTO public_brain_check (score, pvt_ms, dsst_score) VALUES (?, ?, ?)'
  );
  stmts.brainCheckCount = db.prepare('SELECT COUNT(*) as total FROM public_brain_check');
  stmts.brainCheckCountBelow = db.prepare('SELECT COUNT(*) as cnt FROM public_brain_check WHERE score < ?');
  stmts.brainCheckPercentile = db.prepare(
    'SELECT score FROM public_brain_check ORDER BY score ASC LIMIT 1 OFFSET ?'
  );
  stmts.brainCheckTop10 = db.prepare(
    'SELECT id, score, pvt_ms, dsst_score, created_at FROM public_brain_check ORDER BY score DESC LIMIT 10'
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

  saveResult(test_type, date, time, scores_json, session) {
    const active = stmts.getActivePhase.get() || null;
    const phaseId = active ? active.id : null;
    return stmts.insertResult.run(test_type, date, time, scores_json, session || null, phaseId);
  },

  getResults(days = 30) {
    return stmts.getResults.all(days);
  },

  getResultsByType(test_type, days = 30) {
    return stmts.getResultsByType.all(test_type, days);
  },

  getAllResults() {
    return stmts.getAllResults.all();
  },

  saveChessElo(date, blitz, rapid, bullet) {
    return stmts.upsertChessElo.run(date, blitz, rapid, bullet);
  },

  getChessElo(days = 90) {
    return stmts.getChessElo.all(days);
  },

  getAllChessElo() {
    return stmts.getAllChessElo.all();
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

  getAllDailyNotes() {
    return stmts.getAllDailyNotes.all();
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

  getSetting(key) {
    const row = stmts.getSetting.get(key);
    return row ? row.value : null;
  },

  saveSetting(key, value) {
    return stmts.upsertSetting.run(key, value);
  },

  getAllSettings() {
    const rows = stmts.getAllSettings.all();
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    return obj;
  },

  saveWhoopData(data) {
    return stmts.upsertWhoopData.run(
      data.date, data.sleep_duration_min, data.deep_sleep_min, data.rem_sleep_min,
      data.light_sleep_min, data.awake_min, data.sleep_cycles, data.disturbances,
      data.respiratory_rate, data.sleep_performance, data.sleep_consistency,
      data.sleep_efficiency, data.recovery_score, data.resting_hr, data.hrv_rmssd,
      data.spo2, data.skin_temp, data.raw_sleep_json, data.raw_recovery_json
    );
  },

  getWhoopData(days = 30) {
    return stmts.getWhoopData.all(days);
  },

  getAllWhoopData() {
    return stmts.getAllWhoopData.all();
  },

  saveWhoopTokens(access_token, refresh_token, expires_at) {
    return stmts.upsertWhoopTokens.run(access_token, refresh_token, expires_at);
  },

  getWhoopTokens() {
    return stmts.getWhoopTokens.get() || null;
  },

  // ── Experiment Phases ──
  createPhase(name, phase_type, compounds_arr, start_date, notes) {
    const compounds = compounds_arr ? JSON.stringify(compounds_arr) : null;
    return db.prepare(
      'INSERT INTO experiment_phases (name, phase_type, compounds, start_date, notes) VALUES (?, ?, ?, ?, ?)'
    ).run(name, phase_type, compounds, start_date, notes || null);
  },

  endPhase(id, end_date) {
    return db.prepare('UPDATE experiment_phases SET end_date = ? WHERE id = ?').run(end_date, id);
  },

  updatePhase(id, patch) {
    const fields = [];
    const values = [];
    if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
    if (patch.phase_type !== undefined) { fields.push('phase_type = ?'); values.push(patch.phase_type); }
    if (patch.compounds !== undefined) { fields.push('compounds = ?'); values.push(JSON.stringify(patch.compounds)); }
    if (patch.notes !== undefined) { fields.push('notes = ?'); values.push(patch.notes); }
    if (fields.length === 0) return;
    values.push(id);
    return db.prepare(`UPDATE experiment_phases SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },

  deletePhase(id) {
    return db.prepare('DELETE FROM experiment_phases WHERE id = ?').run(id);
  },

  getPhases() {
    return db.prepare('SELECT * FROM experiment_phases ORDER BY start_date DESC').all();
  },

  getActivePhase() {
    return stmts.getActivePhase.get() || null;
  },

  getPhaseById(id) {
    return db.prepare('SELECT * FROM experiment_phases WHERE id = ?').get(id) || null;
  },

  getPhaseStats(phase_id) {
    const phase = db.prepare('SELECT * FROM experiment_phases WHERE id = ?').get(phase_id);
    if (!phase) return null;

    const rows = db.prepare('SELECT test_type, scores_json FROM test_results WHERE phase_id = ?').all(phase_id);
    const grouped = { nback: [], pvt: [], dsst: [] };
    rows.forEach(r => {
      const s = JSON.parse(r.scores_json);
      if (r.test_type === 'nback') grouped.nback.push(s.max_n || 0);
      else if (r.test_type === 'pvt') grouped.pvt.push(s.median_rt || 0);
      else if (r.test_type === 'dsst') grouped.dsst.push(s.correct || 0);
    });

    function calcStats(arr) {
      if (arr.length === 0) return { mean: null, sd: null, n: 0 };
      const n = arr.length;
      const mean = arr.reduce((a, b) => a + b, 0) / n;
      const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n > 1 ? n - 1 : 1);
      return { mean: Math.round(mean * 100) / 100, sd: Math.round(Math.sqrt(variance) * 100) / 100, n };
    }

    return {
      phase,
      stats: {
        nback: calcStats(grouped.nback),
        pvt: calcStats(grouped.pvt),
        dsst: calcStats(grouped.dsst),
      }
    };
  },

  comparePhases(phase_id_a, phase_id_b) {
    const a = this.getPhaseStats(phase_id_a);
    const b = this.getPhaseStats(phase_id_b);
    if (!a || !b) return null;

    function cohensD(statsA, statsB, flipSign = false) {
      if (statsA.n < 2 || statsB.n < 2) return { mean_a: statsA.mean, mean_b: statsB.mean, sd_a: statsA.sd, sd_b: statsB.sd, n_a: statsA.n, n_b: statsB.n, cohens_d: null };
      const pooledSD = Math.sqrt(((statsA.n - 1) * statsA.sd ** 2 + (statsB.n - 1) * statsB.sd ** 2) / (statsA.n + statsB.n - 2));
      let d = pooledSD === 0 ? 0 : (statsB.mean - statsA.mean) / pooledSD;
      if (flipSign) d = -d;
      return { mean_a: statsA.mean, mean_b: statsB.mean, sd_a: statsA.sd, sd_b: statsB.sd, n_a: statsA.n, n_b: statsB.n, cohens_d: Math.round(d * 100) / 100 };
    }

    return {
      nback: cohensD(a.stats.nback, b.stats.nback),
      pvt: cohensD(a.stats.pvt, b.stats.pvt, true),
      dsst: cohensD(a.stats.dsst, b.stats.dsst),
    };
  },

  submitBrainCheck(score, pvt_ms, dsst_score) {
    stmts.insertBrainCheck.run(score, pvt_ms, dsst_score);
    const { total } = stmts.brainCheckCount.get();
    const { cnt } = stmts.brainCheckCountBelow.get(score);
    const percentile = total > 0 ? Math.round((cnt / total) * 100) : 0;
    return { percentile, total };
  },

  getBrainCheckLeaderboard() {
    const { total } = stmts.brainCheckCount.get();
    if (total === 0) return { total: 0, percentiles: { p25: null, p50: null, p75: null, p90: null }, top_scores: [] };

    function pVal(p) {
      const idx = Math.min(Math.floor(p * total), total - 1);
      const row = stmts.brainCheckPercentile.get(idx);
      return row ? row.score : null;
    }

    return {
      total,
      percentiles: { p25: pVal(0.25), p50: pVal(0.50), p75: pVal(0.75), p90: pVal(0.90) },
      top_scores: stmts.brainCheckTop10.all()
    };
  },

  close() {
    db.close();
  }
};
