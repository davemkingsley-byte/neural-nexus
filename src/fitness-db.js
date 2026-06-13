const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use persistent volume on Railway (/data), fallback to local
const dataVolumeMounted = fs.existsSync('/data');
const dbDir = dataVolumeMounted ? '/data' : path.join(__dirname, '..', 'data');
if (!dataVolumeMounted && !fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'fitness.db');

const photosDir = path.join(dbDir, 'fitness-photos');
if (!fs.existsSync(photosDir)) {
  fs.mkdirSync(photosDir, { recursive: true });
}

console.log(`Fitness DB path: ${dbPath}`);
console.log(`Fitness photos dir: ${photosDir}`);

let db;

try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (err) {
  console.error('Failed to open fitness database:', err);
}

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weight_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      weight_lbs REAL NOT NULL,
      notes TEXT,
      seed_origin INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_weight_log_date ON weight_log(date);

    CREATE TABLE IF NOT EXISTS workout_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      name TEXT,
      notes TEXT,
      duration_min INTEGER,
      seed_origin INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_workout_sessions_date ON workout_sessions(date);

    CREATE TABLE IF NOT EXISTS workout_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
      exercise TEXT NOT NULL,
      set_number INTEGER,
      weight_lbs REAL,
      reps INTEGER,
      rpe REAL,
      notes TEXT,
      seed_origin INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_workout_sets_session ON workout_sets(session_id);
    CREATE INDEX IF NOT EXISTS idx_workout_sets_exercise ON workout_sets(exercise);

    CREATE TABLE IF NOT EXISTS diet_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      meal TEXT,
      food TEXT NOT NULL,
      calories INTEGER,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      notes TEXT,
      food_id INTEGER,
      servings REAL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_diet_log_date ON diet_log(date);

    -- Food reference database (USDA + custom)
    CREATE TABLE IF NOT EXISTS foods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      source TEXT,                -- 'sr-legacy' | 'foundation' | 'custom' | 'barcode'
      external_id TEXT UNIQUE,    -- USDA FDC ID or UPC
      serving_description TEXT,
      serving_size_g REAL,
      calories_per_100g REAL,
      protein_per_100g REAL,
      carbs_per_100g REAL,
      fat_per_100g REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_foods_name ON foods(name COLLATE NOCASE);

    -- Full-text search virtual table over foods
    CREATE VIRTUAL TABLE IF NOT EXISTS foods_fts USING fts5(name, category, content='foods', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS foods_ai AFTER INSERT ON foods BEGIN
      INSERT INTO foods_fts(rowid, name, category) VALUES (new.id, new.name, new.category);
    END;
    CREATE TRIGGER IF NOT EXISTS foods_ad AFTER DELETE ON foods BEGIN
      INSERT INTO foods_fts(foods_fts, rowid, name, category) VALUES('delete', old.id, old.name, old.category);
    END;
    CREATE TRIGGER IF NOT EXISTS foods_au AFTER UPDATE ON foods BEGIN
      INSERT INTO foods_fts(foods_fts, rowid, name, category) VALUES('delete', old.id, old.name, old.category);
      INSERT INTO foods_fts(rowid, name, category) VALUES (new.id, new.name, new.category);
    END;

    -- Go-to meals — reusable meal templates
    CREATE TABLE IF NOT EXISTS go_to_meals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      meal TEXT,                  -- default meal slot (Breakfast/Lunch/etc.)
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS go_to_meal_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meal_id INTEGER NOT NULL REFERENCES go_to_meals(id) ON DELETE CASCADE,
      food_id INTEGER,
      food_name TEXT NOT NULL,
      servings REAL NOT NULL DEFAULT 1,
      calories REAL,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL
    );
    CREATE INDEX IF NOT EXISTS idx_go_to_meal_items_meal ON go_to_meal_items(meal_id);

    CREATE TABLE IF NOT EXISTS progress_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      photo_path TEXT NOT NULL,
      angle TEXT,
      weight_lbs REAL,
      bf_estimate_pct REAL,
      lbm_estimate_lbs REAL,
      ffmi_estimate REAL,
      ai_analysis TEXT,
      seed_origin INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_progress_photos_date ON progress_photos(date);
  `);

  // Migrations for older DBs that may be missing newly-added columns
  const dietCols = db.prepare("PRAGMA table_info(diet_log)").all().map(c => c.name);
  if (!dietCols.includes('food_id')) db.exec('ALTER TABLE diet_log ADD COLUMN food_id INTEGER');
  if (!dietCols.includes('servings')) db.exec('ALTER TABLE diet_log ADD COLUMN servings REAL DEFAULT 1');
}

function getDB() {
  return db;
}

function getPhotosDir() {
  return photosDir;
}

module.exports = { getDB, initDB, getPhotosDir, dbPath };
