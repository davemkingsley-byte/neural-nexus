# Task 6 — Fitness Tracker: Lifts + Diet + Weight + Body Composition

## Objective
Build a private all-in-one fitness tracking app at `/fitness`. Tracks workouts (lift progressions), bodyweight, diet/macros, and progress photos with AI body composition estimates via vision API.

## Constraints
- Password protected — use existing `dashboardAuth` middleware
- Do NOT touch existing routes or middleware
- Store data in `/data/fitness.db` (new SQLite file, separate from cognitive.db)
- Uses Anthropic API for body composition analysis (vision model — `claude-opus-4-7` or `claude-3-5-sonnet`)
- Image uploads stored at `/data/fitness-photos/` (create directory)
- No new npm packages except: `multer` for image uploads (check package.json first — may already exist)

---

## Database Schema

```sql
-- Bodyweight log
CREATE TABLE IF NOT EXISTS weight_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,  -- YYYY-MM-DD
  weight_lbs REAL NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Workout sessions
CREATE TABLE IF NOT EXISTS workout_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  name TEXT,  -- e.g. "Push Day", "Pull Day", "Legs"
  notes TEXT,
  duration_min INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Individual sets within a session
CREATE TABLE IF NOT EXISTS workout_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES workout_sessions(id),
  exercise TEXT NOT NULL,  -- e.g. "Bench Press"
  set_number INTEGER,
  weight_lbs REAL,
  reps INTEGER,
  rpe REAL,  -- Rate of Perceived Exertion 1-10 (optional)
  notes TEXT
);

-- Diet log
CREATE TABLE IF NOT EXISTS diet_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  meal TEXT,  -- Breakfast, Lunch, Dinner, Snack
  food TEXT NOT NULL,
  calories INTEGER,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Progress photos + body composition estimates
CREATE TABLE IF NOT EXISTS progress_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  photo_path TEXT NOT NULL,  -- relative path under /data/fitness-photos/
  weight_lbs REAL,  -- bodyweight at time of photo (optional)
  bf_estimate_pct REAL,  -- body fat % estimated by AI
  lbm_estimate_lbs REAL,  -- lean body mass estimate
  ffmi_estimate REAL,  -- Fat-Free Mass Index
  ai_analysis TEXT,  -- full AI response text
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## Server Routes (add to server.js)

```
GET  /fitness                          → render UI (dashboardAuth)

-- Weight
GET  /api/fitness/weight               → all weight entries
POST /api/fitness/weight               → log weight { date, weight_lbs, notes }
DELETE /api/fitness/weight/:id         → delete entry

-- Workouts
GET  /api/fitness/workouts             → all sessions (summary, no sets)
GET  /api/fitness/workouts/:id         → single session with all sets
POST /api/fitness/workouts             → create session { date, name, notes, duration_min }
POST /api/fitness/workouts/:id/sets    → add set { exercise, set_number, weight_lbs, reps, rpe, notes }
DELETE /api/fitness/workouts/:id       → delete session + its sets
GET  /api/fitness/exercises            → distinct exercise names (for autocomplete)
GET  /api/fitness/exercises/:name      → all-time history for one exercise (for PR tracking)

-- Diet
GET  /api/fitness/diet                 → diet log, optional ?date=YYYY-MM-DD filter
POST /api/fitness/diet                 → log food item
DELETE /api/fitness/diet/:id           → delete entry

-- Progress Photos
GET  /api/fitness/photos               → all photos (metadata, no binary)
POST /api/fitness/photos               → upload photo + trigger AI analysis (multipart/form-data)
GET  /api/fitness/photos/:id/image     → serve the actual image file
DELETE /api/fitness/photos/:id         → delete photo + file
```

---

## AI Body Composition Analysis

When a photo is uploaded (POST /api/fitness/photos):

1. Save the image to `/data/fitness-photos/{timestamp}_{filename}`
2. Read the image as base64
3. Call Anthropic vision API with this prompt:

```
You are a fitness assessment tool. Analyze this physique photo and provide estimates.

Context: Male, ~185 lbs (if weight provided at upload, use it).

Provide your best estimates for:
1. Body fat percentage (%)
2. Lean body mass (lbs)
3. FFMI (Fat-Free Mass Index) — calculated as LBM(kg) / height(m)^2
4. Visible muscle development: rate each major group (chest, shoulders, arms, back, legs, core) on a scale of 1-5
5. Brief 2-3 sentence assessment of physique stage and primary areas for improvement

Format your response as JSON:
{
  "bf_pct": <number>,
  "lbm_lbs": <number>,
  "ffmi": <number>,
  "muscle_ratings": {
    "chest": <1-5>,
    "shoulders": <1-5>,
    "arms": <1-5>,
    "back": <1-5>,
    "legs": <1-5>,
    "core": <1-5>
  },
  "assessment": "<string>"
}
```

4. Parse the JSON response, store estimates in `progress_photos` table
5. Return full analysis to client

Note: Use `claude-3-5-sonnet-20241022` for vision (cheaper than Opus, good enough for this). Pass image as base64 in the messages array per Anthropic docs.

---

## UI Layout (views/pages/fitness.ejs)

Single-page app with tab navigation:

### Tab 1 — Dashboard
- Today's summary: weight logged?, workout logged?, calories logged?
- Bodyweight chart — last 90 days, line chart (Chart.js CDN)
- Weekly volume chart — total sets per week, bar chart
- Weekly macros summary — calories/protein/carbs/fat averages
- Latest progress photo thumbnail + body fat trend line

### Tab 2 — Workouts
**Log workout:**
- Date picker (default today)
- Workout name (Push/Pull/Legs/Upper/Lower/Full Body or custom)
- Dynamic set logger: exercise name (autocomplete from history) + weight + reps + RPE
- Add set / Add exercise buttons
- Save session button

**History:**
- List of past sessions, most recent first
- Click to expand and see all sets
- PR badges — show 🏆 next to any set that's an all-time personal record for that exercise

**Exercise tracker:**
- Search by exercise name
- Shows all-time progression chart for that lift (weight × reps over time)
- Shows estimated 1-rep max trend (Epley formula: weight × (1 + reps/30))

### Tab 3 — Diet
**Log food:**
- Date (default today), meal selector, food name, calories, protein, carbs, fat
- Quick-add buttons for common foods (hardcode 10-15 David-relevant ones: chicken breast, eggs, rice, etc.)

**Daily view:**
- Macro ring charts for today (calories, protein, carbs, fat) — target vs actual
- Set daily targets: calories, protein, carbs, fat (stored in localStorage)
- Meal-by-meal breakdown table

**History:**
- Calendar view or date picker to review past days

### Tab 4 — Progress Photos
**Upload:**
- Photo upload (camera or file)
- Optional: log current weight with photo
- Upload button → shows loading spinner → displays AI analysis results

**Gallery:**
- Grid of photos sorted by date
- Click to expand, shows full AI analysis
- Body fat % trend line across all photos
- Side-by-side comparison: select any two photos

### Tab 5 — Bodyweight
- Simple weight log form: date + weight (lbs)
- Full weight history table
- Chart: all-time bodyweight trend

---

## Design
- Dark glassmorphism, match existing site
- Blue `#60a5fa` / purple `#a78bfa` / green `#34d399` accent colors
- Tab bar at top, sticky
- Mobile first — all forms usable at 375px (this will be used on phone in the gym)
- Large tap targets on buttons (min 48px)
- Numeric inputs use `inputmode="decimal"` for mobile keyboard

## Notes
- Height for FFMI: hardcode 5'11" (71 inches / 1.8034m) for David — or add a settings field
- The AI body comp analysis is an estimate, not medical measurement — add a disclaimer
- Photos are stored locally on Mac Mini, not committed to git (add `/data/fitness-photos/` to .gitignore)
- Future: export to CSV, Apple Health integration
