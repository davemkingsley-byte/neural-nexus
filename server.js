const express = require('express');
const path = require('path');
const fs = require('fs');

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

// Crossword puzzles module
let crosswordPuzzles;
try {
  crosswordPuzzles = require('./src/crossword-puzzles');
  console.log('Crossword puzzles module loaded successfully');
} catch (err) {
  console.error('Failed to load crossword puzzles module:', err.message);
}

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());

// Protect dashboard data from public access
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'nexus2026';
function dashboardAuth(req, res, next) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/dash_auth=([^;]+)/);
  if (match && match[1] === DASHBOARD_PASS) return next();
  if (req.query.key === DASHBOARD_PASS) {
    res.cookie('dash_auth', DASHBOARD_PASS, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
    return res.redirect(req.path);
  }
  res.status(401).json({ error: 'unauthorized' });
}
app.use('/data', dashboardAuth);
app.use('/pm-charters', (req, res, next) => {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/dash_auth=([^;]+)/);
  if (match && match[1] === DASHBOARD_PASS) return next();
  if (req.query.key === DASHBOARD_PASS) {
    res.cookie('dash_auth', DASHBOARD_PASS, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
    return res.redirect(req.path);
  }
  res.redirect('/dashboard');
}, express.static(path.join(__dirname, 'public', 'pm-charters')));

app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  const fs = require('fs');
  res.json({ 
    status: 'ok', 
    dbReady, 
    volumeMounted: fs.existsSync('/data'),
    time: new Date().toISOString() 
  });
});

// ── PM Dashboard API (reads from static data/charters.json) ──────────────────
const charterDataPath = path.join(__dirname, 'public', 'data', 'charters.json');
const activityPath = path.join(__dirname, 'data', 'activity.json');

function loadCharterData() {
  try {
    return JSON.parse(fs.readFileSync(charterDataPath, 'utf8'));
  } catch { return { programs: [], generated: null }; }
}

app.get('/api/charters', dashboardAuth, (req, res) => {
  const data = loadCharterData();
  const charters = data.programs ? data.programs.flatMap(p => p.charters) : [];
  res.json({ charters });
});

app.get('/api/charters/:id', dashboardAuth, (req, res) => {
  const data = loadCharterData();
  const charters = data.programs ? data.programs.flatMap(p => p.charters) : [];
  const charter = charters.find(c => c.id === req.params.id);
  if (!charter) return res.status(404).json({ error: 'Not found' });
  res.json(charter);
});

app.get('/api/health', dashboardAuth, async (req, res) => {
  const data = loadCharterData();
  const charters = data.programs ? data.programs.flatMap(p => p.charters) : [];
  const targets = charters.filter(c => c.liveUrl).map(c => ({ id: c.id, title: c.title, url: c.liveUrl }));
  const http = require('http');
  const https = require('https');
  const results = await Promise.all(targets.map(t => new Promise(resolve => {
    const mod = t.url.startsWith('https') ? https : http;
    const req = mod.get(t.url, { timeout: 5000 }, r => { resolve({ ...t, status: r.statusCode, up: r.statusCode < 500 }); r.resume(); });
    req.on('error', () => resolve({ ...t, status: 0, up: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ...t, status: 0, up: false }); });
  })));
  res.json({ results });
});

app.get('/api/activity', dashboardAuth, (req, res) => {
  try {
    if (fs.existsSync(activityPath)) {
      const log = JSON.parse(fs.readFileSync(activityPath, 'utf8'));
      return res.json({ activity: log.slice(0, 50) });
    }
  } catch {}
  res.json({ activity: [] });
});

// ── Weekly Report API ────────────────────────────────────────────────────────
const weeklyPath = path.join(__dirname, 'data', 'weekly-reports.json');

app.get('/api/weekly', dashboardAuth, (req, res) => {
  try {
    const data = loadCharterData();
    const charters = data.programs ? data.programs.flatMap(p => p.charters) : [];
    let activity = [];
    try { if (fs.existsSync(activityPath)) activity = JSON.parse(fs.readFileSync(activityPath, 'utf8')); } catch {}

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekActivity = activity.filter(a => new Date(a.ts) >= weekStart);

    let reports = [];
    try { if (fs.existsSync(weeklyPath)) reports = JSON.parse(fs.readFileSync(weeklyPath, 'utf8')); } catch {}

    const live = charters.filter(c => /live/i.test(c.statusClean)).length;
    const inProgress = charters.filter(c => /progress/i.test(c.statusClean)).length;
    const overdue = charters.filter(c => c.overdue).length;
    const totalBlockers = charters.reduce((acc, c) => acc + (c.blockers?.length || 0), 0);
    const totalBudget = charters.reduce((acc, c) => acc + (c.budget ? parseFloat(c.budget.replace(/[^0-9.]/g, '')) || 0 : 0), 0);
    const totalSpend = charters.reduce((acc, c) => acc + (c.actualSpend ? parseFloat(c.actualSpend.replace(/[^0-9.]/g, '')) || 0 : 0), 0);

    res.json({
      currentWeek: {
        weekOf: weekStart.toISOString().split('T')[0],
        generated: now.toISOString(),
        stats: { total: charters.length, live, inProgress, overdue, totalBlockers, totalBudget, totalSpend },
        activity: {
          statusChanges: weekActivity.filter(a => a.type === 'status').length,
          phaseChanges: weekActivity.filter(a => a.type === 'phase').length,
          itemsCompleted: weekActivity.filter(a => a.type === 'checkbox' && a.done).length,
          chartersCreated: weekActivity.filter(a => a.type === 'create').length
        },
        details: weekActivity.slice(0, 50)
      },
      pastReports: reports.slice(0, 12)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/weekly/snapshot', dashboardAuth, (req, res) => {
  try {
    const data = loadCharterData();
    const charters = data.programs ? data.programs.flatMap(p => p.charters) : [];
    const { accomplishments, notes } = req.body || {};

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    let activity = [];
    try { if (fs.existsSync(activityPath)) activity = JSON.parse(fs.readFileSync(activityPath, 'utf8')); } catch {}
    const weekActivity = activity.filter(a => new Date(a.ts) >= weekStart);

    const report = {
      weekOf: weekStart.toISOString().split('T')[0],
      savedAt: now.toISOString(),
      stats: {
        total: charters.length,
        live: charters.filter(c => /live/i.test(c.statusClean)).length,
        inProgress: charters.filter(c => /progress/i.test(c.statusClean)).length,
        overdue: charters.filter(c => c.overdue).length,
        totalBlockers: charters.reduce((acc, c) => acc + (c.blockers?.length || 0), 0)
      },
      activityCount: weekActivity.length,
      accomplishments: accomplishments || '',
      notes: notes || '',
      charters: charters.map(c => ({ id: c.id, title: c.title, status: c.statusClean, priority: c.priority, progress: c.progress }))
    };

    let reports = [];
    try { if (fs.existsSync(weeklyPath)) reports = JSON.parse(fs.readFileSync(weeklyPath, 'utf8')); } catch {}
    reports = reports.filter(r => r.weekOf !== report.weekOf);
    reports.unshift(report);
    if (reports.length > 52) reports = reports.slice(0, 52);

    const dataDir = path.dirname(weeklyPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(weeklyPath, JSON.stringify(reports, null, 2));

    res.json({ ok: true, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT/POST stubs (read-only in production — changes made via git)
app.put('/api/charters/:id', dashboardAuth, (req, res) => {
  res.json({ ok: true, message: 'Changes are made via git push in production' });
});
app.post('/api/charters', dashboardAuth, (req, res) => {
  res.json({ ok: true, message: 'New charters are created via git push in production' });
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

// Dashboard (password-protected)
function dashboardLoginPage(req, res, next) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/dash_auth=([^;]+)/);
  if (match && match[1] === DASHBOARD_PASS) return next();
  if (req.query.key === DASHBOARD_PASS) {
    res.cookie('dash_auth', DASHBOARD_PASS, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
    return res.redirect('/dashboard');
  }
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Dashboard Login</title>
<style>body{background:#06060b;color:#f0f0f5;font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh}
.login{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:2.5rem;max-width:360px;width:90%}
h2{font-size:1.4rem;margin-bottom:1rem}
input{width:100%;padding:0.8rem 1rem;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#f0f0f5;font-size:1rem;margin-bottom:1rem}
button{width:100%;padding:0.8rem;background:#f0c040;color:#06060b;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#e0b030}.err{color:#f87171;font-size:0.85rem;margin-bottom:0.5rem}</style></head>
<body><div class="login"><h2>🔒 Dashboard</h2>${req.query.key ? '<p class="err">Wrong password</p>' : ''}<form method="GET">
<input type="password" name="key" placeholder="Enter password" autofocus>
<button type="submit">Access</button></form></div></body></html>`);
}
app.get('/dashboard', dashboardLoginPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Topic pages
app.get('/topics/de-extinction', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'topics', 'de-extinction.html'));
});
app.get('/topics/artificial-womb', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'topics', 'artificial-womb.html'));
});
app.get('/topics/ai-agents', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'topics', 'ai-agents.html'));
});

// Archive pages
app.get('/archive', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'archive.html'));
});
app.get('/play/archive', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'spelling-bee-archive.html'));
});
app.get('/wordle/archive', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wordle-archive.html'));
});
app.get('/crossword/archive', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'crossword-archive.html'));
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

// Wordle score submission
app.post('/api/wordle/score', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const { date, nickname, guesses, won, guessDetails } = req.body;
    if (!date || !nickname || guesses === undefined || won === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    spellDB.submitWordleScore(date, nickname.trim().slice(0, 20), guesses, won, guessDetails || []);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving wordle score:', err);
    res.status(500).json({ error: 'Failed to save score' });
  }
});

// Wordle leaderboard for a date
app.get('/api/wordle/leaderboard', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const date = req.query.date || getTodayStr();
    const entries = spellDB.getWordleLeaderboard(date);
    res.json({ entries });
  } catch (err) {
    console.error('Error getting wordle leaderboard:', err);
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

// Wordle archive list
app.get('/api/wordle/archive', (req, res) => {
  if (!checkDB(res)) return;
  try {
    // Get dates with scores plus last 30 days
    const datesWithScores = new Set(spellDB.getPastWordleDates());
    const today = getTodayStr();
    const dates = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const word = wordleWords ? wordleWords.getWordForDate(dateStr) : null;
      dates.push({
        date: dateStr,
        word: i === 0 ? null : word, // don't reveal today's word
        hasScores: datesWithScores.has(dateStr),
        isToday: i === 0
      });
    }
    res.json({ dates });
  } catch (err) {
    console.error('Error getting wordle archive:', err);
    res.status(500).json({ error: 'Failed to get archive' });
  }
});

// Wordle archive for specific date
app.get('/api/wordle/archive/:date', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
    const today = getTodayStr();
    const word = (wordleWords && date !== today) ? wordleWords.getWordForDate(date) : null;
    const entries = spellDB.getWordleLeaderboard(date);
    res.json({ date, word, entries });
  } catch (err) {
    console.error('Error getting wordle archive date:', err);
    res.status(500).json({ error: 'Failed to get data' });
  }
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

// Spelling Bee archive list
app.get('/api/spelling-bee/archive', (req, res) => {
  if (!checkDB(res)) return;
  try {
    // Ensure we have puzzles for last 30 days
    const today = getTodayStr();
    const dates = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      dates.push(dateStr);
    }
    // Ensure puzzles exist
    dates.forEach(dateStr => {
      try { ensurePuzzle(dateStr); } catch(e) {}
    });
    const puzzles = spellDB.getPastPuzzles();
    res.json({ puzzles });
  } catch (err) {
    console.error('Error getting spelling bee archive:', err);
    res.status(500).json({ error: 'Failed to get archive' });
  }
});

// Spelling Bee archive for specific date
app.get('/api/spelling-bee/archive/:date', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
    ensurePuzzle(date);
    const data = spellDB.getSpellingBeeByDate(date);
    if (!data) return res.status(404).json({ error: 'Puzzle not found' });
    res.json(data);
  } catch (err) {
    console.error('Error getting spelling bee archive date:', err);
    res.status(500).json({ error: 'Failed to get data' });
  }
});

// --- Crossword API ---
app.post('/api/crossword/score', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const { date, nickname, timeSeconds, completed } = req.body;
    if (!date || !nickname || timeSeconds === undefined || completed === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    spellDB.submitCrosswordScore(date, nickname.trim().slice(0, 20), timeSeconds, completed);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving crossword score:', err);
    res.status(500).json({ error: 'Failed to save score' });
  }
});

app.get('/api/crossword/leaderboard', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const date = req.query.date || getTodayStr();
    const entries = spellDB.getCrosswordLeaderboard(date);
    res.json({ entries });
  } catch (err) {
    console.error('Error getting crossword leaderboard:', err);
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

app.get('/api/crossword/archive', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const datesWithScores = new Set(spellDB.getPastCrosswordDates());
    const today = getTodayStr();
    const dates = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const puzzle = crosswordPuzzles ? crosswordPuzzles.getPuzzleForDate(dateStr) : null;
      const topWord = puzzle ? puzzle.grid[0].join('') : null;
      dates.push({
        date: dateStr,
        topWord,
        hasScores: datesWithScores.has(dateStr),
        isToday: i === 0
      });
    }
    res.json({ dates });
  } catch (err) {
    console.error('Error getting crossword archive:', err);
    res.status(500).json({ error: 'Failed to get archive' });
  }
});

app.get('/api/crossword/archive/:date', (req, res) => {
  if (!checkDB(res)) return;
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
    const puzzle = crosswordPuzzles ? crosswordPuzzles.getPuzzleForDate(date) : null;
    const entries = spellDB.getCrosswordLeaderboard(date);
    res.json({ date, puzzle, entries });
  } catch (err) {
    console.error('Error getting crossword archive date:', err);
    res.status(500).json({ error: 'Failed to get data' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Neural NeXus running on http://localhost:${PORT}`);
});
