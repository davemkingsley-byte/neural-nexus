#!/usr/bin/env node
// Idempotent seed import for the fitness tracker.
// - Reads pipe-delimited seed files under data/seed/
// - Reads body-comp photos from ~/Downloads/Bodybuilding Coaching (or --photos-dir)
// - Re-runnable: wipes only seed_origin=1 rows and preserves manual edits.
//   Specifically: seeded workout sessions that have picked up manual (seed_origin=0)
//   sets are NOT deleted (their CASCADE would destroy the manual sets), and seeded
//   photos that have been enriched with AI analysis are promoted to manual so the
//   wipe spares them (and the paid vision output). importPhotos is idempotent on
//   (date, angle), and custom foods UPSERT by external_id so their ids stay stable.
// - Usage: node scripts/import-fitness-seed.js [--photos-dir <path>] [--no-photos]

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

// Need to load .env for API key (optional)
try { require('dotenv').config(); } catch (_) {}

const { getDB, initDB, getPhotosDir } = require(path.join(__dirname, '..', 'src', 'fitness-db.js'));

// --- CLI args ---
const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PHOTOS_DIR = argValue('--photos-dir', path.join(os.homedir(), 'Downloads', 'Bodybuilding Coaching'));
const SKIP_PHOTOS = args.includes('--no-photos');

initDB();
const db = getDB();

// ---- Helpers ----

const MONTH_MAP = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' };

// Parse "05Jan25", "18FEB25", "01APR25" → "2025-01-05"
function parseCompactDate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2})([A-Za-z]{3})(\d{2,4})$/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const mon = MONTH_MAP[m[2].toUpperCase()];
  if (!mon) return null;
  let yr = m[3];
  if (yr.length === 2) yr = (parseInt(yr, 10) >= 70 ? '19' : '20') + yr;
  return `${yr}-${mon}-${day}`;
}

// Parse prescribed reps string → integer midpoint for storage.
// "10-12" → 11, "15" → 15, "AMRAP" → 10 (default), "max" → 10, "to failure" → null, "15 (5+5+5)" → 15
function parseRepsMidpoint(reps) {
  if (reps == null) return { reps: null, est: false };
  const s = String(reps).trim().toLowerCase();
  if (!s) return { reps: null, est: false };
  if (/^(failure|to failure|max|max reps|max hold)$/i.test(s)) return { reps: 10, est: true };
  if (/^amrap/i.test(s)) return { reps: 10, est: true };
  // "10-12" or "10 - 12" → midpoint. Must be checked BEFORE the single-number form,
  // otherwise the `simple` pattern swallows the leading number and mis-stores
  // "10 - 12" as an exact 10.
  const range = s.match(/^(\d+)\s*-\s*(\d+)/);
  if (range) {
    const lo = parseInt(range[1], 10);
    const hi = parseInt(range[2], 10);
    return { reps: Math.round((lo + hi) / 2), est: true };
  }
  // "15", "15 (5+5+5)", "15 reps"
  const simple = s.match(/^(\d+)(?:[\s(].*)?$/);
  if (simple) return { reps: parseInt(simple[1], 10), est: false };
  // Single number anywhere in string
  const any = s.match(/(\d+)/);
  if (any) return { reps: parseInt(any[1], 10), est: true };
  return { reps: null, est: false };
}

// Parse a weight cell → number or null.
// "BW"/"Done"/"Intuition"/"Red"/"Yellow" → null but kept as note via caller.
function parseWeight(w) {
  if (w == null) return null;
  const s = String(w).trim();
  if (!s) return null;
  // Strip trailing notes like "50 tough", "35 dumbbell"
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  // Reject absurd values (likely garbled like "152025")
  if (n > 1000) return null;
  return n;
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
}

// Split a seed file into sections separated by SECTION_BREAK.
// Each section starts with a HEADERS: line, followed by ROW: lines (or raw rows for weight file).
function splitSections(lines) {
  const sections = [];
  let current = [];
  for (const ln of lines) {
    if (ln.trim() === 'SECTION_BREAK') {
      if (current.length) sections.push(current);
      current = [];
    } else {
      current.push(ln);
    }
  }
  if (current.length) sections.push(current);
  return sections;
}

// ---- 0b. Import curated custom foods (size variants, supplements, etc.) ----
function importCustomFoods() {
  const file = path.join(__dirname, '..', 'data', 'seed', 'foods-custom.json');
  if (!fs.existsSync(file)) return;
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  // UPSERT by external_id rather than INSERT OR REPLACE: REPLACE deletes+reinserts,
  // assigning a NEW rowid each run, which orphans diet_log.food_id / go_to_meal_items.food_id
  // references. ON CONFLICT...DO UPDATE keeps the existing id stable.
  const insert = db.prepare(`
    INSERT INTO foods (name, category, source, external_id, serving_description, serving_size_g, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g)
    VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      name=excluded.name, category=excluded.category, source='custom',
      serving_description=excluded.serving_description, serving_size_g=excluded.serving_size_g,
      calories_per_100g=excluded.calories_per_100g, protein_per_100g=excluded.protein_per_100g,
      carbs_per_100g=excluded.carbs_per_100g, fat_per_100g=excluded.fat_per_100g
  `);
  const txn = db.transaction((rows) => {
    for (const f of rows) {
      insert.run(f.name, f.category || null, f.external_id, f.serving_description || null, f.serving_size_g || 100,
        f.calories_per_100g ?? null, f.protein_per_100g ?? null, f.carbs_per_100g ?? null, f.fat_per_100g ?? null);
    }
  });
  txn(items);
  console.log(`Imported ${items.length} curated custom foods`);
}

// ---- 0. Import USDA foods database ----
function importFoods() {
  const file = path.join(__dirname, '..', 'data', 'seed', 'foods-usda.json');
  if (!fs.existsSync(file)) {
    console.log('No foods-usda.json — skipping food DB import. Run: node scripts/build-foods-db.js');
    return;
  }
  // If already populated with the same or greater count, skip
  const existingCount = db.prepare("SELECT COUNT(*) as c FROM foods WHERE source IN ('sr-legacy', 'foundation')").get().c;
  const raw = fs.readFileSync(file, 'utf8');
  const foods = JSON.parse(raw);
  if (existingCount >= foods.length) {
    console.log(`Foods DB already has ${existingCount} USDA rows — skipping re-import`);
    return;
  }

  // Wipe USDA rows only (preserve custom foods) and re-insert
  db.prepare("DELETE FROM foods WHERE source IN ('sr-legacy', 'foundation')").run();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO foods (name, category, source, external_id, serving_description, serving_size_g, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const txn = db.transaction((items) => {
    for (const f of items) {
      insert.run(
        f.name,
        f.category,
        f.source,
        String(f.fdc_id),
        f.serving_description,
        f.serving_size_g,
        f.calories_per_100g,
        f.protein_per_100g,
        f.carbs_per_100g,
        f.fat_per_100g
      );
    }
  });
  txn(foods);
  console.log(`Imported ${foods.length} USDA foods into DB`);
}

// ---- 1. Wipe prior seed data ----
// Careful: this must NOT destroy manual edits the user layered on top of seed rows.
function wipeSeed() {
  // Drop seed-origin sets first.
  const r1 = db.prepare('DELETE FROM workout_sets WHERE seed_origin = 1').run();
  // Only drop a seeded SESSION if it has no surviving manual (seed_origin=0) sets.
  // workout_sets has ON DELETE CASCADE, so deleting a session here would also wipe
  // any manual sets the user attached to it — silent data loss. Spared sessions get
  // their seed sets refreshed by importLiftsJanMar (which reuses them by date).
  const r2 = db.prepare(`
    DELETE FROM workout_sessions
    WHERE seed_origin = 1
      AND id NOT IN (SELECT session_id FROM workout_sets WHERE seed_origin = 0)
  `).run();
  const r3 = db.prepare('DELETE FROM weight_log WHERE seed_origin = 1').run();
  // Promote any seeded photo that carries AI analysis to a manual row so the wipe
  // spares it — otherwise re-running would destroy the analysis (and the paid
  // vision-API output) and re-insert a bare row.
  const promoted = db.prepare('UPDATE progress_photos SET seed_origin = 0 WHERE seed_origin = 1 AND ai_analysis IS NOT NULL').run();
  const r4 = db.prepare('DELETE FROM progress_photos WHERE seed_origin = 1').run();
  console.log(`Wiped seed rows: workout_sets=${r1.changes} workout_sessions=${r2.changes} weight_log=${r3.changes} progress_photos=${r4.changes} (preserved ${promoted.changes} analyzed photos)`);
}

// ---- 2. Import weight log ----
function importWeightLog() {
  const file = path.join(__dirname, '..', 'data', 'seed', 'fitness-weight-sleep.txt');
  if (!fs.existsSync(file)) { console.log('No weight seed file, skipping'); return; }
  const lines = readLines(file).filter(l => l.trim());
  const headerIdx = lines.findIndex(l => l.startsWith('HEADERS:'));
  const rows = lines.slice(headerIdx + 1);
  const insert = db.prepare('INSERT INTO weight_log (date, weight_lbs, notes, seed_origin) VALUES (?, ?, ?, 1)');
  let count = 0;
  for (const row of rows) {
    const cells = row.split('|');
    const date = parseCompactDate(cells[0]);
    const weight = parseWeight(cells[1]);
    if (!date || weight == null) continue;
    const notes = cells[2] ? `weigh-in ${cells[2]}${cells[3] ? ', ' + cells[3] : ''}` : null;
    insert.run(date, weight, notes);
    count++;
  }
  console.log(`Imported ${count} weight entries`);
}

// ---- 3. Import Jan-Mar lifts (date-per-column format) ----
// Body|Exercise|Reps|Sets|<dateCol1>|<dateCol2>|...
function importLiftsJanMar() {
  const file = path.join(__dirname, '..', 'data', 'seed', 'fitness-lifts-jan-mar.txt');
  if (!fs.existsSync(file)) { console.log('No Jan-Mar lifts seed file, skipping'); return; }
  const sections = splitSections(readLines(file));
  const sessions = new Map(); // date → { id, name }
  const insertSession = db.prepare('INSERT INTO workout_sessions (date, name, notes, seed_origin) VALUES (?, ?, ?, 1)');
  const insertSet = db.prepare('INSERT INTO workout_sets (session_id, exercise, set_number, weight_lbs, reps, notes, seed_origin) VALUES (?, ?, ?, ?, ?, ?, 1)');

  let totalSets = 0;
  const exerciseSetCounter = new Map(); // "date|exercise" → running count

  for (const section of sections) {
    const headerLine = section.find(l => l.startsWith('HEADERS:'));
    if (!headerLine) continue;
    const headers = headerLine.replace(/^HEADERS:\s*/, '').split('|');
    // Data rows = everything that isn't HEADERS
    const dataLines = section.filter(l => l && !l.startsWith('HEADERS:'));

    // Determine date column indexes
    const dateCols = [];
    for (let i = 4; i < headers.length; i++) {
      const d = parseCompactDate(headers[i]);
      if (d) dateCols.push({ col: i, date: d });
    }

    for (const raw of dataLines) {
      const cells = raw.split('|');
      if (cells.length < 5) continue;
      const body = (cells[0] || '').trim();
      const exercise = (cells[1] || '').trim();
      const reps = (cells[2] || '').trim();
      const setType = (cells[3] || '').trim();
      if (!exercise) continue;

      const { reps: repsInt, est } = parseRepsMidpoint(reps);
      const setTypeNote = setType ? `${setType}${est ? ' | reps estimated from prescribed range' : ''}` : (est ? 'reps estimated from prescribed range' : null);

      for (const dc of dateCols) {
        const cell = cells[dc.col];
        const cellTrim = (cell == null ? '' : String(cell).trim());
        if (!cellTrim) continue; // truly empty cell — no set that day
        // A non-empty cell that isn't a number ("Red"/"Yellow"/"Idk"/band colors)
        // still records that the exercise was performed: keep the set with a NULL
        // weight and the raw token in notes rather than silently dropping it.
        const w = parseWeight(cell);

        // Get or create session. Reuse a surviving seed session for this date
        // (one wipeSeed spared because it has manual sets) so we don't duplicate it.
        let sess = sessions.get(dc.date);
        if (!sess) {
          const existing = db.prepare("SELECT id, name FROM workout_sessions WHERE date = ? AND seed_origin = 1 ORDER BY id LIMIT 1").get(dc.date);
          if (existing) {
            sess = { id: existing.id, name: existing.name, body };
          } else {
            const sessionName = deriveSessionName(body);
            const info = insertSession.run(dc.date, sessionName, null);
            sess = { id: info.lastInsertRowid, name: sessionName, body };
          }
          sessions.set(dc.date, sess);
        }

        const key = `${dc.date}|${exercise}`;
        const setNum = (exerciseSetCounter.get(key) || 0) + 1;
        exerciseSetCounter.set(key, setNum);

        const rawCellNote = (w == null || cellTrim !== String(w)) ? `raw: ${cellTrim}` : null;
        const combinedNote = [setTypeNote, rawCellNote].filter(Boolean).join(' | ') || null;

        insertSet.run(sess.id, exercise, setNum, w, repsInt, combinedNote);
        totalSets++;
      }
    }
  }
  console.log(`Jan-Mar imports: ${sessions.size} sessions, ${totalSets} sets`);
}

function deriveSessionName(body) {
  if (!body) return 'Workout';
  const b = body.toLowerCase();
  if (b.includes('back')) return 'Pull (Back & Calves)';
  if (b.includes('chest') || b.includes('shoulders')) return 'Push (Chest & Shoulders)';
  if (b.includes('legs') || b.includes('quads') || b.includes('glutes') || b.includes('hams')) return 'Legs';
  if (b.includes('arms')) return 'Arms';
  return body.charAt(0).toUpperCase() + body.slice(1);
}

// ---- 4. Import Apr-Jun lifts ----
// The raw file from the Apr-Jun tab has irregular cell alignment (programmatic
// parsing of interleaved Date|Weight pairs breaks because dates are sparse and
// not consistently aligned with weight columns). Fallback: scan for all date
// tokens anywhere in the file and create workout_sessions rows so those dates
// show up on the calendar. The exercise-level data from this tab can be
// entered manually via the UI.
function importLiftsAprJun() {
  const file = path.join(__dirname, '..', 'data', 'seed', 'fitness-workouts-raw.txt');
  if (!fs.existsSync(file)) { console.log('No Apr-Jun lifts seed file, skipping'); return; }
  const text = fs.readFileSync(file, 'utf8');
  // Find all DDMmmYY tokens
  const matches = text.match(/\b\d{1,2}[A-Za-z]{3}\d{2}\b/g) || [];
  const uniqueDates = new Set();
  for (const m of matches) {
    const d = parseCompactDate(m);
    if (d && d.startsWith('2025')) uniqueDates.add(d);
  }

  // Check which already exist as sessions
  const existing = new Set(db.prepare('SELECT date FROM workout_sessions WHERE seed_origin = 1').all().map(r => r.date));
  const insertSession = db.prepare('INSERT INTO workout_sessions (date, name, notes, seed_origin) VALUES (?, ?, ?, 1)');

  let newCount = 0;
  for (const date of uniqueDates) {
    if (existing.has(date)) continue;
    insertSession.run(date, 'Workout', 'Apr-Jun 2025 program — exercise details not auto-imported');
    newCount++;
  }
  console.log(`Apr-Jun date-only sessions added: ${newCount} (from ${uniqueDates.size} unique dates detected)`);
}

// ---- 5. Import progress photos ----
function parseAngleFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  const lower = base.toLowerCase();
  if (lower.includes('back')) return 'back';
  if (lower.includes('front')) return 'front';
  if (lower.includes('left')) return 'left';
  if (lower.includes('right')) return 'right';
  return null;
}

function parseDateFromFolderOrFilename(name) {
  // Try folder pattern like "01APR25" or "04Feb25" or "31DEC24"
  const folderMatch = name.match(/(\d{1,2})([A-Za-z]{3})(\d{2,4})/);
  if (folderMatch) return parseCompactDate(folderMatch[0]);
  return null;
}

function importPhotos() {
  if (SKIP_PHOTOS) { console.log('Skipping photo import (--no-photos)'); return; }
  if (!fs.existsSync(PHOTOS_DIR)) {
    console.log(`Photos dir not found: ${PHOTOS_DIR} — skipping`);
    return;
  }

  const destDir = getPhotosDir();
  const insertPhoto = db.prepare('INSERT INTO progress_photos (date, photo_path, angle, weight_lbs, seed_origin) VALUES (?, ?, ?, ?, 1)');
  // Idempotency guard: a row for this (date, angle) may already exist — either a
  // prior run's seed row that survived (analyzed → promoted to manual) or a manual
  // upload. Don't insert a duplicate.
  const photoExists = db.prepare('SELECT 1 FROM progress_photos WHERE date = ? AND angle = ?');

  // Map of date → { weight_lbs } from weight_log (for auto-population)
  const weightsByDate = new Map();
  const weightRows = db.prepare('SELECT date, weight_lbs FROM weight_log').all();
  for (const r of weightRows) weightsByDate.set(r.date, r.weight_lbs);

  let photoCount = 0;

  // 5a. Walk subdirectories
  const entries = fs.readdirSync(PHOTOS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const dirPath = path.join(PHOTOS_DIR, entry.name);
      const dirDate = parseDateFromFolderOrFilename(entry.name);
      if (!dirDate) continue;
      const files = fs.readdirSync(dirPath);
      for (const fname of files) {
        if (!/\.(jpe?g|png|webp)$/i.test(fname)) continue;
        const angle = parseAngleFromFilename(fname);
        if (!angle) continue; // skip stray IMG_8960.PNG etc.
        const srcPath = path.join(dirPath, fname);
        const ext = path.extname(fname).toLowerCase();
        const destName = `${dirDate}_${angle}${ext}`;
        const destPath = path.join(destDir, destName);
        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(srcPath, destPath);
        }
        if (photoExists.get(dirDate, angle)) continue;
        const weight = weightsByDate.get(dirDate) || null;
        insertPhoto.run(dirDate, destName, angle, weight);
        photoCount++;
      }
    } else if (entry.isFile() && /\.(jpe?g|png|webp)$/i.test(entry.name)) {
      // 5b. Loose files in parent (24JUL25_Front.PNG etc.)
      const fileDate = parseDateFromFolderOrFilename(entry.name);
      const angle = parseAngleFromFilename(entry.name);
      if (!fileDate || !angle) continue;
      const srcPath = path.join(PHOTOS_DIR, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      const destName = `${fileDate}_${angle}${ext}`;
      const destPath = path.join(destDir, destName);
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
      if (photoExists.get(fileDate, angle)) continue;
      const weight = weightsByDate.get(fileDate) || null;
      insertPhoto.run(fileDate, destName, angle, weight);
      photoCount++;
    }
  }
  console.log(`Imported ${photoCount} photos (copied to ${destDir})`);
}

// ---- Run ----
console.log('Starting fitness seed import...');
importFoods(); // outside workout wipe — foods aren't seed_origin'd
importCustomFoods();
db.transaction(() => {
  wipeSeed();
  importWeightLog();
  importLiftsJanMar();
  importLiftsAprJun();
})();
// Photos outside transaction because of file I/O
importPhotos();

const counts = {
  weight_log: db.prepare('SELECT COUNT(*) as c FROM weight_log').get().c,
  workout_sessions: db.prepare('SELECT COUNT(*) as c FROM workout_sessions').get().c,
  workout_sets: db.prepare('SELECT COUNT(*) as c FROM workout_sets').get().c,
  progress_photos: db.prepare('SELECT COUNT(*) as c FROM progress_photos').get().c,
};
console.log('Final counts:', counts);
console.log('Done.');
