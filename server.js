require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let spellDB, generatePuzzle, validateWord;
let dbReady = false;

// Cognitive performance testing DB
let cogDB;
let cogDBReady = false;
try {
  cogDB = require('./src/cognitive-db');
  cogDB.initDB();
  cogDBReady = true;
  console.log('Cognitive DB loaded successfully');
} catch (err) {
  console.error('Failed to load cognitive DB:', err.message);
}

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

// Treat Biosciences research documents (password-protected)
app.use('/treat-docs', (req, res, next) => {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/dash_auth=([^;]+)/);
  if (match && match[1] === DASHBOARD_PASS) return next();
  if (req.query.key === DASHBOARD_PASS) {
    res.cookie('dash_auth', DASHBOARD_PASS, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
    return res.redirect(req.path);
  }
  res.redirect('/dashboard');
}, express.static(path.join(__dirname, 'public', 'treat-docs')));

// Cognitive performance dashboard (password-protected)
app.use('/cognitive', (req, res, next) => {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/dash_auth=([^;]+)/);
  if (match && match[1] === DASHBOARD_PASS) return next();
  if (req.query.key === DASHBOARD_PASS) {
    res.cookie('dash_auth', DASHBOARD_PASS, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
    return res.redirect(req.path);
  }
  res.redirect('/dashboard');
}, express.static(path.join(__dirname, 'public', 'cognitive')));

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

// ── Cognitive Performance API ─────────────────────────────────────────────────
function checkCogDB(res) {
  if (!cogDBReady) { res.status(503).json({ error: 'Cognitive database not available' }); return false; }
  return true;
}

// Save test results
app.post('/api/cognitive/results', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const { test_type, scores, scores_json, session, date, time } = req.body;
    const resolvedScores = scores || (scores_json ? (typeof scores_json === 'string' ? JSON.parse(scores_json) : scores_json) : null);
    if (!test_type || !resolvedScores) return res.status(400).json({ error: 'Missing test_type or scores' });
    if (!['nback', 'pvt', 'dsst', 'stroop', 'avlt', 'tmtb'].includes(test_type)) return res.status(400).json({ error: 'Invalid test_type' });
    const validSession = (session === 'morning' || session === 'evening') ? session : null;
    const now = new Date();
    const saveDate = date || now.toISOString().split('T')[0];
    const saveTime = time || now.toTimeString().split(' ')[0];
    cogDB.saveResult(test_type, saveDate, saveTime, JSON.stringify(resolvedScores), validSession);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving cognitive result:', err);
    res.status(500).json({ error: 'Failed to save result' });
  }
});

// Get test results
app.get('/api/cognitive/results', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const days = parseInt(req.query.days) || 30;
    const type = req.query.type;
    const results = type ? cogDB.getResultsByType(type, days) : cogDB.getResults(days);
    const bests = cogDB.getPersonalBests();
    res.json({ results, bests });
  } catch (err) {
    console.error('Error getting cognitive results:', err);
    res.status(500).json({ error: 'Failed to get results' });
  }
});

// Chess.com integration — fetch latest stats
app.get('/api/cognitive/chess', dashboardAuth, async (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.chess.com',
        path: '/pub/player/dmk101890/stats',
        headers: { 'User-Agent': 'NeuralNeXus/1.0' }
      };
      https.get(options, (r) => {
        let body = '';
        r.on('data', chunk => body += chunk);
        r.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON from chess.com')); }
        });
      }).on('error', reject);
    });
    const blitz = data.chess_blitz?.last?.rating || null;
    const rapid = data.chess_rapid?.last?.rating || null;
    const bullet = data.chess_bullet?.last?.rating || null;
    // Also return stored history
    const history = cogDB.getChessElo(90);

    // Auto-sync: save today's snapshot if last sync was >12h ago
    const lastSync = cogDB.getSetting('chess_last_sync');
    const now = new Date();
    if (!lastSync || (now - new Date(lastSync)) > 12 * 60 * 60 * 1000) {
      const date = now.toISOString().split('T')[0];
      cogDB.saveChessElo(date, blitz, rapid, bullet);
      cogDB.saveSetting('chess_last_sync', now.toISOString());
    }

    res.json({ current: { blitz, rapid, bullet }, history });
  } catch (err) {
    console.error('Error fetching chess.com data:', err);
    res.status(500).json({ error: 'Failed to fetch chess data' });
  }
});

// Sync chess.com ratings to DB
app.post('/api/cognitive/chess/sync', dashboardAuth, async (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.chess.com',
        path: '/pub/player/dmk101890/stats',
        headers: { 'User-Agent': 'NeuralNeXus/1.0' }
      };
      https.get(options, (r) => {
        let body = '';
        r.on('data', chunk => body += chunk);
        r.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
        });
      }).on('error', reject);
    });
    const date = new Date().toISOString().split('T')[0];
    const blitz = data.chess_blitz?.last?.rating || null;
    const rapid = data.chess_rapid?.last?.rating || null;
    const bullet = data.chess_bullet?.last?.rating || null;
    cogDB.saveChessElo(date, blitz, rapid, bullet);
    res.json({ ok: true, date, blitz, rapid, bullet });
  } catch (err) {
    console.error('Error syncing chess.com data:', err);
    res.status(500).json({ error: 'Failed to sync chess data' });
  }
});

// Supplements
app.get('/api/cognitive/supplements', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    res.json({ supplements: cogDB.getSupplements() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get supplements' });
  }
});

app.post('/api/cognitive/supplements', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const { compound_name, start_date, notes } = req.body;
    if (!compound_name || !start_date) return res.status(400).json({ error: 'Missing compound_name or start_date' });
    cogDB.addSupplement(compound_name, start_date, notes);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add supplement' });
  }
});

// Daily subjective ratings
app.post('/api/cognitive/daily', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const { date, subjective_energy, subjective_focus, sleep_hours, notes } = req.body;
    const d = date || new Date().toISOString().split('T')[0];
    cogDB.saveDailyNote(d, subjective_energy, subjective_focus, sleep_hours, notes);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save daily note' });
  }
});

app.get('/api/cognitive/daily', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const days = parseInt(req.query.days) || 30;
    res.json({ notes: cogDB.getDailyNotes(days) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get daily notes' });
  }
});

// Settings
app.get('/api/cognitive/settings', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    res.json({ settings: cogDB.getAllSettings() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

app.post('/api/cognitive/settings', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Missing key' });
    cogDB.saveSetting(key, value);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save setting' });
  }
});

// Analytics — computed stats
app.get('/api/cognitive/analytics', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const allResults = cogDB.getAllResults();
    const supplements = cogDB.getSupplements();
    const dailyNotes = cogDB.getAllDailyNotes();
    const chessElo = cogDB.getAllChessElo();
    const settings = cogDB.getAllSettings();
    const baselineEndDate = settings.baseline_end_date || null;

    // Parse all results with scores
    const parsed = allResults.map(r => ({
      ...r,
      scores: JSON.parse(r.scores_json)
    }));

    // Compute unique test days for streak
    const testDays = [...new Set(parsed.map(r => r.date))].sort();

    // Current streak: consecutive days ending today or yesterday
    let currentStreak = 0;
    if (testDays.length > 0) {
      const todayStr = new Date().toISOString().split('T')[0];
      const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      let checkDate = testDays[testDays.length - 1];
      if (checkDate === todayStr || checkDate === yesterdayStr) {
        for (let i = testDays.length - 1; i >= 0; i--) {
          const d = new Date(testDays[i] + 'T12:00:00');
          const expected = new Date(Date.now() - (testDays.length - 1 - i) * 86400000);
          // Allow checking from last test day backward
          if (i === testDays.length - 1) {
            currentStreak = 1;
          } else {
            const prev = new Date(testDays[i + 1] + 'T12:00:00');
            const diff = (prev - d) / 86400000;
            if (Math.round(diff) === 1) {
              currentStreak++;
            } else {
              break;
            }
          }
        }
      }
    }

    // Longest streak
    let longestStreak = 0;
    let tempStreak = 1;
    for (let i = 1; i < testDays.length; i++) {
      const prev = new Date(testDays[i - 1] + 'T12:00:00');
      const curr = new Date(testDays[i] + 'T12:00:00');
      if (Math.round((curr - prev) / 86400000) === 1) {
        tempStreak++;
      } else {
        tempStreak = 1;
      }
      longestStreak = Math.max(longestStreak, tempStreak);
    }
    if (testDays.length === 1) longestStreak = 1;
    longestStreak = Math.max(longestStreak, currentStreak);

    // Per-test metrics with AM/PM split
    function computeMetrics(type, extractor) {
      const items = parsed.filter(r => r.test_type === type);
      const allVals = items.map(extractor).filter(v => v != null);
      const amVals = items.filter(r => r.session === 'morning').map(extractor).filter(v => v != null);
      const pmVals = items.filter(r => r.session === 'evening').map(extractor).filter(v => v != null);

      const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
      const sd = arr => {
        if (arr.length < 2) return 0;
        const m = mean(arr);
        return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1));
      };

      // Baseline vs post-baseline
      let baselineVals = [];
      let postVals = [];
      if (baselineEndDate) {
        baselineVals = items.filter(r => r.date <= baselineEndDate).map(extractor).filter(v => v != null);
        postVals = items.filter(r => r.date > baselineEndDate).map(extractor).filter(v => v != null);
      } else if (testDays.length >= 7) {
        const cutoff = testDays[6];
        baselineVals = items.filter(r => r.date <= cutoff).map(extractor).filter(v => v != null);
        postVals = items.filter(r => r.date > cutoff).map(extractor).filter(v => v != null);
      }

      // Cohen's d
      let effectSize = null;
      let pctChange = null;
      if (baselineVals.length >= 2 && postVals.length >= 2) {
        const bMean = mean(baselineVals);
        const pMean = mean(postVals);
        const bSD = sd(baselineVals);
        const pSD = sd(postVals);
        const pooledSD = Math.sqrt(((baselineVals.length - 1) * bSD ** 2 + (postVals.length - 1) * pSD ** 2) / (baselineVals.length + postVals.length - 2));
        effectSize = pooledSD > 0 ? (pMean - bMean) / pooledSD : 0;
        pctChange = bMean !== 0 ? ((pMean - bMean) / Math.abs(bMean)) * 100 : null;
      }

      // Time series for charts (date, value, session)
      const timeSeries = items.map(r => ({
        date: r.date,
        value: extractor(r),
        session: r.session
      })).filter(d => d.value != null);

      return {
        overall_mean: mean(allVals),
        overall_sd: sd(allVals),
        am_mean: mean(amVals),
        pm_mean: mean(pmVals),
        count: allVals.length,
        am_count: amVals.length,
        pm_count: pmVals.length,
        baseline_mean: mean(baselineVals),
        baseline_sd: sd(baselineVals),
        post_mean: mean(postVals),
        post_sd: sd(postVals),
        effect_size: effectSize,
        pct_change: pctChange,
        baseline_n: baselineVals.length,
        post_n: postVals.length,
        time_series: timeSeries,
      };
    }

    const nback = computeMetrics('nback', r => r.scores.max_n);
    const nbackAcc = computeMetrics('nback', r => r.scores.combined_accuracy);
    const pvt = computeMetrics('pvt', r => r.scores.median_rt);
    const dsst = computeMetrics('dsst', r => r.scores.correct);

    // Composite score: z-score each, average, scale to 0-100
    const compositeTimeSeries = [];
    const allDates = [...new Set(parsed.map(r => r.date))].sort();
    allDates.forEach(date => {
      const dayResults = parsed.filter(r => r.date === date);
      const nbackR = dayResults.find(r => r.test_type === 'nback');
      const pvtR = dayResults.find(r => r.test_type === 'pvt');
      const dsstR = dayResults.find(r => r.test_type === 'dsst');
      if (!nbackR || !pvtR || !dsstR) return;

      const zScores = [];
      if (nback.overall_sd > 0) zScores.push((nbackR.scores.max_n - nback.overall_mean) / nback.overall_sd);
      if (pvt.overall_sd > 0) zScores.push(-((pvtR.scores.median_rt - pvt.overall_mean) / pvt.overall_sd)); // invert: lower RT = better
      if (dsst.overall_sd > 0) zScores.push((dsstR.scores.correct - dsst.overall_mean) / dsst.overall_sd);

      if (zScores.length > 0) {
        const avgZ = zScores.reduce((a, b) => a + b, 0) / zScores.length;
        const composite = 50 + avgZ * 15; // Scale so 50 = mean, ~15 per SD
        const session = nbackR.session || pvtR.session || dsstR.session || null;
        compositeTimeSeries.push({ date, value: Math.round(composite * 10) / 10, session });
      }
    });

    // Chess time series
    const chessTimeSeries = chessElo.map(r => ({
      date: r.date,
      blitz: r.blitz_rating,
      rapid: r.rapid_rating,
      bullet: r.bullet_rating,
    }));

    // Subjective time series
    const subjectiveTimeSeries = dailyNotes.map(r => ({
      date: r.date,
      energy: r.subjective_energy,
      focus: r.subjective_focus,
      sleep_hours: r.sleep_hours,
    }));

    // WHOOP time series
    const whoopData = cogDB.getAllWhoopData();

    res.json({
      total_sessions: parsed.length,
      current_streak: currentStreak,
      longest_streak: longestStreak,
      baseline_end_date: baselineEndDate,
      nback,
      nback_accuracy: nbackAcc,
      pvt,
      dsst,
      composite: compositeTimeSeries,
      chess: chessTimeSeries,
      subjective: subjectiveTimeSeries,
      supplements,
      whoop: whoopData,
    });
  } catch (err) {
    console.error('Error computing analytics:', err);
    res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

// Data export
app.get('/api/cognitive/export', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const format = req.query.format || 'json';
    const allResults = cogDB.getAllResults().map(r => ({
      ...r,
      scores: JSON.parse(r.scores_json)
    }));
    const supplements = cogDB.getSupplements();
    const dailyNotes = cogDB.getAllDailyNotes();
    const chessElo = cogDB.getAllChessElo();

    if (format === 'csv') {
      // Flatten test results to CSV
      const rows = allResults.map(r => {
        const s = r.scores;
        // Find active supplements at this date
        const activeSupps = supplements
          .filter(sup => sup.start_date <= r.date)
          .map(sup => sup.compound_name)
          .join('; ');
        return {
          date: r.date,
          time: r.time,
          session: r.session || '',
          test_type: r.test_type,
          nback_max_n: r.test_type === 'nback' ? (s.max_n || '') : '',
          nback_accuracy: r.test_type === 'nback' ? (s.combined_accuracy || '') : '',
          pvt_median_rt: r.test_type === 'pvt' ? (s.median_rt || '') : '',
          pvt_mean_rt: r.test_type === 'pvt' ? (s.mean_rt || '') : '',
          pvt_lapses: r.test_type === 'pvt' ? (s.lapses || '') : '',
          dsst_correct: r.test_type === 'dsst' ? (s.correct || '') : '',
          dsst_attempted: r.test_type === 'dsst' ? (s.attempted || '') : '',
          dsst_accuracy: r.test_type === 'dsst' ? (s.accuracy || '') : '',
          supplements_active: activeSupps,
        };
      });
      const headers = Object.keys(rows[0] || {});
      const csvLines = [headers.join(',')];
      rows.forEach(row => {
        csvLines.push(headers.map(h => {
          const v = String(row[h] || '');
          return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(','));
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="cognitive-data.csv"');
      res.send(csvLines.join('\n'));
    } else {
      const whoopData = cogDB.getAllWhoopData();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="cognitive-data.json"');
      res.json({
        exported_at: new Date().toISOString(),
        test_results: allResults,
        daily_notes: dailyNotes,
        chess_elo: chessElo,
        supplements,
        whoop_data: whoopData,
      });
    }
  } catch (err) {
    console.error('Error exporting data:', err);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// Delete a specific test result (admin)
app.delete('/api/cognitive/results/:id', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    cogDB.db.prepare('DELETE FROM test_results WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a daily note (admin)
app.delete('/api/cognitive/daily/:id', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    cogDB.db.prepare('DELETE FROM daily_notes WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WHOOP Integration ─────────────────────────────────────────────────────────
const WHOOP_CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const WHOOP_CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const WHOOP_REDIRECT_URI = process.env.WHOOP_REDIRECT_URI;

// Connect — redirect to WHOOP OAuth
app.get('/api/whoop/connect', dashboardAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: WHOOP_CLIENT_ID,
    redirect_uri: WHOOP_REDIRECT_URI,
    response_type: 'code',
    scope: 'read:sleep read:recovery read:cycles',
    state,
  });
  res.redirect(`https://api.prod.whoop.com/oauth/oauth2/auth?${params}`);
});

// Callback — NO dashboardAuth
app.get('/api/whoop/callback', async (req, res) => {
  if (!checkCogDB(res)) return;
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
      redirect_uri: WHOOP_REDIRECT_URI,
    });

    const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('WHOOP token exchange failed:', err);
      return res.redirect('/cognitive/index.html?whoop=error');
    }

    const tokens = await tokenRes.json();
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    cogDB.saveWhoopTokens(tokens.access_token, tokens.refresh_token, expiresAt);

    res.redirect('/cognitive/index.html?whoop=connected');
  } catch (err) {
    console.error('WHOOP callback error:', err);
    res.redirect('/cognitive/index.html?whoop=error');
  }
});

// Status — check if WHOOP is connected
app.get('/api/whoop/status', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  const tokens = cogDB.getWhoopTokens();
  if (!tokens || !tokens.access_token) {
    return res.json({ connected: false });
  }
  const expired = new Date(tokens.expires_at) < new Date();
  res.json({ connected: true, hasRefreshToken: !!tokens.refresh_token, tokenExpired: expired });
});

// Helper: get valid WHOOP access token (refresh if needed)
async function getWhoopAccessToken() {
  const tokens = cogDB.getWhoopTokens();
  if (!tokens || !tokens.access_token) return null;

  // If token is still valid, return it
  if (new Date(tokens.expires_at) > new Date()) {
    return tokens.access_token;
  }

  // Try to refresh
  if (!tokens.refresh_token) return null;

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
    });

    const refreshRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!refreshRes.ok) {
      console.error('WHOOP token refresh failed');
      // Clear tokens — mark as disconnected
      cogDB.saveWhoopTokens('', '', '');
      return null;
    }

    const newTokens = await refreshRes.json();
    const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();
    cogDB.saveWhoopTokens(newTokens.access_token, newTokens.refresh_token, expiresAt);
    return newTokens.access_token;
  } catch (err) {
    console.error('WHOOP token refresh error:', err);
    return null;
  }
}

// Sync — pull latest data from WHOOP
app.post('/api/whoop/sync', dashboardAuth, async (req, res) => {
  if (!checkCogDB(res)) return;

  const accessToken = await getWhoopAccessToken();
  if (!accessToken) {
    return res.status(401).json({ error: 'WHOOP not connected or token expired. Please reconnect.' });
  }

  const headers = { Authorization: `Bearer ${accessToken}` };

  try {
    const [sleepRes, recoveryRes] = await Promise.all([
      fetch('https://api.prod.whoop.com/developer/v1/activity/sleep?limit=7', { headers }),
      fetch('https://api.prod.whoop.com/developer/v1/recovery?limit=7', { headers }),
    ]);

    // Handle 401 — try refresh once
    if (sleepRes.status === 401 || recoveryRes.status === 401) {
      cogDB.saveWhoopTokens('', '', '');
      return res.status(401).json({ error: 'WHOOP token expired. Please reconnect.' });
    }

    const sleepData = sleepRes.ok ? await sleepRes.json() : { records: [] };
    const recoveryData = recoveryRes.ok ? await recoveryRes.json() : { records: [] };

    const sleepRecords = sleepData.records || [];
    const recoveryRecords = recoveryData.records || [];

    // Index recovery by date
    const recoveryByDate = {};
    recoveryRecords.forEach(r => {
      const date = r.created_at ? r.created_at.split('T')[0] : (r.cycle?.days?.[0] || null);
      if (date) recoveryByDate[date] = r;
    });

    let synced = 0;
    sleepRecords.forEach(sleep => {
      const date = sleep.start ? sleep.start.split('T')[0] : null;
      if (!date) return;

      const msToMin = ms => ms != null ? ms / 60000 : null;
      const stages = sleep.score?.stage_summary || {};
      const recovery = recoveryByDate[date] || {};
      const recoveryScore = recovery.score?.recovery_score ?? null;

      cogDB.saveWhoopData({
        date,
        sleep_duration_min: msToMin(stages.total_in_bed_time_milli ?? sleep.score?.total_in_bed_time_milli),
        deep_sleep_min: msToMin(stages.total_slow_wave_sleep_time_milli),
        rem_sleep_min: msToMin(stages.total_rem_sleep_time_milli),
        light_sleep_min: msToMin(stages.total_light_sleep_time_milli),
        awake_min: msToMin(stages.total_awake_time_milli),
        sleep_cycles: stages.sleep_cycle_count ?? null,
        disturbances: stages.disturbance_count ?? null,
        respiratory_rate: sleep.score?.respiratory_rate ?? null,
        sleep_performance: sleep.score?.sleep_performance_percentage ?? null,
        sleep_consistency: sleep.score?.sleep_consistency_percentage ?? null,
        sleep_efficiency: sleep.score?.sleep_efficiency_percentage ?? null,
        recovery_score: recoveryScore,
        resting_hr: recovery.score?.resting_heart_rate ?? null,
        hrv_rmssd: recovery.score?.hrv_rmssd_milli ?? null,
        spo2: recovery.score?.spo2_percentage ?? null,
        skin_temp: recovery.score?.skin_temp_celsius ?? null,
        raw_sleep_json: JSON.stringify(sleep),
        raw_recovery_json: recovery.score ? JSON.stringify(recovery) : null,
      });
      synced++;
    });

    res.json({ ok: true, synced });
  } catch (err) {
    console.error('WHOOP sync error:', err);
    res.status(500).json({ error: 'Failed to sync WHOOP data' });
  }
});

// Get stored WHOOP data
app.get('/api/whoop/data', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const days = parseInt(req.query.days) || 30;
    res.json({ data: cogDB.getWhoopData(days) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get WHOOP data' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Neural NeXus running on http://localhost:${PORT}`);
});

// Debug: test WHOOP API directly
app.get('/api/whoop/debug', dashboardAuth, async (req, res) => {
  const accessToken = await getWhoopAccessToken();
  if (!accessToken) return res.json({ error: 'no token', suggestion: 'reconnect' });
  
  try {
    const sleepRes = await fetch('https://api.prod.whoop.com/developer/v1/activity/sleep?limit=3', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const status = sleepRes.status;
    const body = await sleepRes.text();
    res.json({ status, body: JSON.parse(body) });
  } catch (err) {
    res.json({ error: err.message });
  }
});
