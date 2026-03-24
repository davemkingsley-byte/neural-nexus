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

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));

const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: 'Too many login attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Protect dashboard data from public access
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'nexus2026';
function dashboardAuth(req, res, next) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/dash_auth=([^;]+)/);
  if (match && match[1] === 'authenticated') return next();
  res.status(401).json({ error: 'unauthorized' });
}
app.use('/data', dashboardAuth);
// PM Dashboard (password-protected)
app.use('/pm', (req, res, next) => {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/dash_auth=([^;]+)/);
  if (match && match[1] === 'authenticated') return next();
  res.redirect('/dashboard');
}, express.static(path.join(__dirname, 'public', 'pm')));

app.use('/pm-charters', (req, res, next) => {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/dash_auth=([^;]+)/);
  if (match && match[1] === 'authenticated') return next();
  res.redirect('/dashboard');
}, express.static(path.join(__dirname, 'public', 'pm-charters')));

// Treat Biosciences research documents (password-protected)
app.use('/treat-docs', (req, res, next) => {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/dash_auth=([^;]+)/);
  if (match && match[1] === 'authenticated') return next();
  res.redirect('/dashboard');
}, express.static(path.join(__dirname, 'public', 'treat-docs')));

// Cognitive performance dashboard (password-protected)
app.use('/cognitive', (req, res, next) => {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/dash_auth=([^;]+)/);
  if (match && match[1] === 'authenticated') return next();
  res.redirect('/dashboard');
}, express.static(path.join(__dirname, 'public', 'cognitive')));

app.use(express.static(path.join(__dirname, 'public')));

// PM data API
app.get('/api/pm/data', dashboardAuth, (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'pm', 'pm-data.json'), 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load PM data' });
  }
});

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
  if (match && match[1] === 'authenticated') return next();
  const failed = req.query.failed === '1';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Dashboard Login</title>
<style>body{background:#06060b;color:#f0f0f5;font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh}
.login{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:2.5rem;max-width:360px;width:90%}
h2{font-size:1.4rem;margin-bottom:1rem}
input{width:100%;padding:0.8rem 1rem;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#f0f0f5;font-size:1rem;margin-bottom:1rem}
button{width:100%;padding:0.8rem;background:#f0c040;color:#06060b;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#e0b030}.err{color:#f87171;font-size:0.85rem;margin-bottom:0.5rem}</style></head>
<body><div class="login"><h2>🔒 Dashboard</h2>${failed ? '<p class="err">Wrong password</p>' : ''}<form method="POST" action="/dashboard">
<input type="password" name="key" placeholder="Enter password" autofocus>
<button type="submit">Access</button></form></div></body></html>`);
}
app.get('/dashboard', dashboardLoginPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.post('/dashboard', loginLimiter, (req, res) => {
  const key = req.body.key;
  if (key === DASHBOARD_PASS) {
    res.cookie('dash_auth', 'authenticated', { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    return res.redirect('/dashboard');
  }
  res.redirect('/dashboard?failed=1');
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
app.get('/topics/ai', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'topics', 'ai.html'));
});
app.get('/topics/biotech', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'topics', 'biotech.html'));
});
app.get('/topics/robotics', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'topics', 'robotics.html'));
});
app.get('/topics/semiconductors', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'topics', 'semiconductors.html'));
});
app.get('/topics/venture-capital', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'topics', 'venture-capital.html'));
});
app.get('/topics/health', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'topics', 'health.html'));
});
app.get('/topics/longevity', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'topics', 'longevity.html'));
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
    if (!nickname || typeof nickname !== 'string') return res.status(400).json({ error: 'Missing nickname' });
    if (typeof score !== 'number' || typeof time_remaining !== 'number') return res.status(400).json({ error: 'Invalid score data' });
    if (!Array.isArray(words_found)) return res.status(400).json({ error: 'Invalid words_found' });
    const dateStr = getTodayStr();
    spellDB.submitScore(dateStr, nickname.trim().slice(0, 20), score, words_found, time_remaining);
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

// Backfill chess ratings from game archives (last 3 months)
app.post('/api/cognitive/chess/backfill', dashboardAuth, async (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const https = require('https');

    function httpsGet(urlPath) {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: 'api.chess.com',
          path: urlPath,
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
    }

    // Fetch list of monthly archive URLs
    const archivesData = await httpsGet('/pub/player/dmk101890/games/archives');
    const archives = archivesData.archives || [];
    if (archives.length === 0) return res.json({ ok: true, saved: 0, message: 'No archives found' });

    // Use last 3 months (or fewer if not available)
    const last3 = archives.slice(-3);

    // dailyRatings[date][timeClass] = last rating for that day
    const dailyRatings = {};
    const username = 'dmk101890';

    for (const archiveUrl of last3) {
      const url = new URL(archiveUrl);
      const monthData = await httpsGet(url.pathname);
      const games = monthData.games || [];

      for (const game of games) {
        if (!game.end_time) continue;
        const timeClass = game.time_class; // 'blitz', 'rapid', 'bullet'
        if (!['blitz', 'rapid', 'bullet'].includes(timeClass)) continue;

        const date = new Date(game.end_time * 1000).toISOString().split('T')[0];

        let rating = null;
        if (game.white && game.white.username && game.white.username.toLowerCase() === username) {
          rating = game.white.rating;
        } else if (game.black && game.black.username && game.black.username.toLowerCase() === username) {
          rating = game.black.rating;
        }

        if (!rating) continue;

        if (!dailyRatings[date]) dailyRatings[date] = {};
        // Overwrite to keep the latest game's rating per day
        dailyRatings[date][timeClass] = rating;
      }
    }

    // Persist to DB
    let saved = 0;
    for (const [date, ratings] of Object.entries(dailyRatings)) {
      cogDB.saveChessElo(
        date,
        ratings.blitz || null,
        ratings.rapid || null,
        ratings.bullet || null
      );
      saved++;
    }

    res.json({ ok: true, saved, totalDates: Object.keys(dailyRatings).length });
  } catch (err) {
    console.error('Chess backfill error:', err);
    res.status(500).json({ error: 'Failed to backfill chess data: ' + err.message });
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

// Experiment Phases
// IMPORTANT: /active and /compare must come before /:id to avoid Express treating them as IDs
app.get('/api/cognitive/phases', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    res.json({ phases: cogDB.getPhases() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get phases' });
  }
});

app.post('/api/cognitive/phases', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const { name, phase_type, compounds, start_date, notes } = req.body;
    if (!name || !phase_type || !start_date) return res.status(400).json({ error: 'Missing name, phase_type, or start_date' });
    const result = cogDB.createPhase(name, phase_type, compounds || [], start_date, notes);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create phase: ' + err.message });
  }
});

app.get('/api/cognitive/phases/active', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const phase = cogDB.getActivePhase();
    res.json({ phase });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get active phase' });
  }
});

app.get('/api/cognitive/phases/compare', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const { a, b } = req.query;
    if (!a || !b) return res.status(400).json({ error: 'Missing query params a and b' });
    const result = cogDB.comparePhases(parseInt(a), parseInt(b));
    if (!result) return res.status(404).json({ error: 'One or both phases not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to compare phases: ' + err.message });
  }
});

app.put('/api/cognitive/phases/:id', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    cogDB.updatePhase(parseInt(req.params.id), req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update phase' });
  }
});

app.post('/api/cognitive/phases/:id/end', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const end_date = (req.body && req.body.end_date) || new Date().toISOString().split('T')[0];
    cogDB.endPhase(parseInt(req.params.id), end_date);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to end phase' });
  }
});

app.delete('/api/cognitive/phases/:id', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    cogDB.deletePhase(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete phase' });
  }
});

app.get('/api/cognitive/phases/:id/stats', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const result = cogDB.getPhaseStats(parseInt(req.params.id));
    if (!result) return res.status(404).json({ error: 'Phase not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get phase stats' });
  }
});

// ── Public Brain Check Leaderboard (no auth) ──
app.post('/api/brain-check/submit', (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const { score, pvt_ms, dsst_score } = req.body;
    if (score == null || pvt_ms == null || dsst_score == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // Validate types and ranges to prevent abuse
    if (typeof score !== 'number' || typeof pvt_ms !== 'number' || typeof dsst_score !== 'number') {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    if (score < 0 || score > 100 || pvt_ms < 50 || pvt_ms > 5000 || dsst_score < 0 || dsst_score > 200) {
      return res.status(400).json({ error: 'Values out of range' });
    }
    const result = cogDB.submitBrainCheck(Math.round(score), Math.round(pvt_ms), Math.round(dsst_score));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit brain check' });
  }
});

app.post('/api/brain-check/subscribe', (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const { email, score } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    if (email.length > 254) {
      return res.status(400).json({ error: 'Email too long' });
    }
    const result = cogDB.saveBrainCheckEmail(email, score || null);
    res.json({ ok: result.ok });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save email' });
  }
});

app.get('/api/brain-check/leaderboard', (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    res.json(cogDB.getBrainCheckLeaderboard());
  } catch (err) {
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

// Weekly cognitive report
app.get('/api/cognitive/weekly-report', dashboardAuth, (req, res) => {
  if (!cogDBReady) return res.json({ error: 'db_unavailable' });
  try {
    const db = cogDB.db;

    // Compute week_start (Monday) and week_end (Sunday)
    let weekStart;
    if (req.query.week) {
      weekStart = new Date(req.query.week + 'T12:00:00');
    } else {
      weekStart = new Date();
    }
    // Roll back to Monday
    const dow = weekStart.getDay();
    const diffToMon = dow === 0 ? 6 : dow - 1;
    weekStart.setDate(weekStart.getDate() - diffToMon);
    const wsISO = weekStart.toISOString().split('T')[0];
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const weISO = weekEnd.toISOString().split('T')[0];

    // Prior week for trend comparison
    const priorStart = new Date(weekStart);
    priorStart.setDate(priorStart.getDate() - 7);
    const psISO = priorStart.toISOString().split('T')[0];
    const priorEnd = new Date(weekStart);
    priorEnd.setDate(priorEnd.getDate() - 1);
    const peISO = priorEnd.toISOString().split('T')[0];

    // Fetch results for this week and prior week
    const stmt = db.prepare('SELECT date, time, scores_json FROM test_results WHERE test_type=? AND date>=? AND date<=? ORDER BY date, time');

    function extractMetric(type, row) {
      const s = typeof row.scores_json === 'string' ? JSON.parse(row.scores_json) : row.scores_json;
      if (type === 'nback') return s.max_n;
      if (type === 'pvt') return s.median_rt;
      if (type === 'dsst') return s.correct;
      if (type === 'stroop') return s.interference_score;
      if (type === 'avlt') return s.total_learning_score;
      return null;
    }

    function calcStats(values, type) {
      if (!values.length) return null;
      const n = values.length;
      const mean = values.reduce((a, b) => a + b, 0) / n;
      const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
      const sd = Math.sqrt(variance);
      const lowerBetter = ['pvt', 'stroop'].includes(type);
      const best = lowerBetter ? Math.min(...values) : Math.max(...values);
      const worst = lowerBetter ? Math.max(...values) : Math.min(...values);
      return { sessions: n, mean: Math.round(mean * 100) / 100, sd: Math.round(sd * 100) / 100, best, worst };
    }

    const testTypes = ['nback', 'pvt', 'dsst', 'stroop', 'avlt'];
    const tests = {};
    let totalSessions = 0;
    const dailyScores = {}; // date -> { nback: [], pvt: [], dsst: [] }

    for (const type of testTypes) {
      const rows = stmt.all(type, wsISO, weISO);
      const values = [];
      for (const row of rows) {
        const v = extractMetric(type, row);
        if (v != null) {
          values.push(v);
          if (!dailyScores[row.date]) dailyScores[row.date] = {};
          if (!dailyScores[row.date][type]) dailyScores[row.date][type] = [];
          dailyScores[row.date][type].push(v);
        }
      }

      const stats = calcStats(values, type);
      if (!stats) {
        tests[type] = { sessions: 0, mean: null, sd: null, best: null, worst: null, trend: 'new', daily: [] };
        continue;
      }

      // Daily: best score per date
      const daily = [];
      for (const [date, byType] of Object.entries(dailyScores)) {
        if (byType[type] && byType[type].length > 0) {
          const lowerBetter = ['pvt', 'stroop'].includes(type);
          const best = lowerBetter ? Math.min(...byType[type]) : Math.max(...byType[type]);
          daily.push({ date, value: best });
        }
      }

      // Trend: compare vs prior week
      const priorRows = stmt.all(type, psISO, peISO);
      const priorValues = priorRows.map(r => extractMetric(type, r)).filter(v => v != null);
      let trend = 'new';
      if (priorValues.length > 0 && values.length > 0) {
        const priorMean = priorValues.reduce((a, b) => a + b, 0) / priorValues.length;
        const pctChange = ((stats.mean - priorMean) / priorMean) * 100;
        const lowerBetter = ['pvt', 'stroop'].includes(type);
        if (lowerBetter) {
          trend = pctChange <= -5 ? 'improving' : pctChange >= 5 ? 'declining' : 'stable';
        } else {
          trend = pctChange >= 5 ? 'improving' : pctChange <= -5 ? 'declining' : 'stable';
        }
      }

      tests[type] = { ...stats, trend, daily };
      totalSessions += stats.sessions;
    }

    // Check minimum sessions
    if (totalSessions < 3) {
      return res.json({ error: 'insufficient_data', sessions: totalSessions, week_start: wsISO, week_end: weISO });
    }

    // Best/worst day via normalized composite scoring
    const dates = Object.keys(dailyScores).sort();
    const dayComposites = [];
    for (const date of dates) {
      const d = dailyScores[date];
      const typesPresent = Object.keys(d).length;
      const scores = {};
      for (const type of testTypes) {
        if (d[type] && d[type].length > 0) {
          const lowerBetter = ['pvt', 'stroop'].includes(type);
          scores[type] = lowerBetter ? Math.min(...d[type]) : Math.max(...d[type]);
        }
      }
      dayComposites.push({ date, scores, typesPresent });
    }

    // Normalize each metric 0-1 across all days
    function normalize(dayComps) {
      const normed = dayComps.map(d => ({ date: d.date, norm: 0, count: 0, typesPresent: d.typesPresent, scores: d.scores }));
      for (const type of testTypes) {
        const vals = dayComps.filter(d => d.scores[type] != null).map(d => d.scores[type]);
        if (vals.length < 2) continue;
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        if (max === min) continue;
        for (const nd of normed) {
          if (nd.scores[type] != null) {
            let n = (nd.scores[type] - min) / (max - min);
            if (['pvt', 'stroop'].includes(type)) n = 1 - n; // invert: lower is better
            nd.norm += n;
            nd.count++;
          }
        }
      }
      return normed;
    }

    const normed = normalize(dayComposites);
    let bestDay = null, worstDay = null;

    if (normed.length > 0) {
      // Best day: highest composite among days with at least 1 test
      const candidates = normed.filter(d => d.count > 0);
      if (candidates.length > 0) {
        candidates.sort((a, b) => (b.norm / b.count) - (a.norm / a.count));
        const bd = candidates[0];
        const reasons = [];
        if (bd.scores.nback != null) reasons.push(`Best N-Back (${bd.scores.nback})`);
        if (bd.scores.pvt != null) reasons.push(`fastest PVT (${bd.scores.pvt}ms)`);
        if (bd.scores.dsst != null) reasons.push(`DSST (${bd.scores.dsst})`);
        if (bd.scores.stroop != null) reasons.push(`Stroop (${bd.scores.stroop}ms)`);
        if (bd.scores.avlt != null) reasons.push(`AVLT (${bd.scores.avlt})`);
        bestDay = { date: bd.date, reason: reasons.join(' + ') };
      }
      // Worst day: lowest composite among days with >= 2 test types
      const worstCandidates = normed.filter(d => d.typesPresent >= 2 && d.count > 0);
      if (worstCandidates.length > 0) {
        worstCandidates.sort((a, b) => (a.norm / a.count) - (b.norm / b.count));
        const wd = worstCandidates[0];
        const reasons = [];
        if (wd.scores.pvt != null) reasons.push(`Slowest PVT (${wd.scores.pvt}ms)`);
        if (wd.scores.nback != null) reasons.push(`N-Back (${wd.scores.nback})`);
        if (wd.scores.dsst != null) reasons.push(`DSST (${wd.scores.dsst})`);
        if (wd.scores.stroop != null) reasons.push(`Stroop (${wd.scores.stroop}ms)`);
        if (wd.scores.avlt != null) reasons.push(`AVLT (${wd.scores.avlt})`);
        worstDay = { date: wd.date, reason: reasons.join(' + ') };
      }
    }

    // Active phase
    let activePhase = null;
    try {
      const phase = cogDB.getActivePhase();
      if (phase) activePhase = { id: phase.id, name: phase.name };
    } catch (e) {}

    // Supplement context
    let supplementContext = [];
    try {
      const supps = cogDB.getSupplements();
      supplementContext = supps
        .filter(s => s.start_date <= weISO)
        .map(s => s.compound_name);
    } catch (e) {}

    // Insights
    const insights = [];
    insights.push(`You completed ${totalSessions} sessions this week.`);
    for (const type of testTypes) {
      const t = tests[type];
      if (t.trend === 'improving') {
        const label = type === 'nback' ? 'N-Back' : type === 'stroop' ? 'Stroop interference' : type === 'avlt' ? 'AVLT' : type.toUpperCase();
        insights.push(`${label} is trending upward vs last week.`);
      } else if (t.trend === 'declining') {
        const label = type === 'nback' ? 'N-Back' : type === 'stroop' ? 'Stroop interference' : type === 'avlt' ? 'AVLT' : type.toUpperCase();
        insights.push(`${label} declined vs last week — consider recovery.`);
      }
    }
    if (bestDay) insights.push(`Your best day was ${bestDay.date} (${bestDay.reason}).`);
    if (worstDay) insights.push(`Your toughest day was ${worstDay.date}.`);

    res.json({
      week_start: wsISO,
      week_end: weISO,
      generated_at: new Date().toISOString(),
      tests,
      best_day: bestDay,
      worst_day: worstDay,
      active_phase: activePhase,
      supplement_context: supplementContext,
      insights
    });
  } catch (err) {
    console.error('Error generating weekly report:', err);
    res.status(500).json({ error: 'Failed to generate weekly report' });
  }
});

// Auto-save weekly report
const cogWeeklyPath = path.join(__dirname, 'data', 'cognitive-weekly-reports.json');
app.post('/api/cognitive/weekly-report/auto-save', dashboardAuth, (req, res) => {
  // Internally call the weekly-report logic by forwarding to our own handler
  const fakeRes = {
    _status: 200,
    _data: null,
    status(code) { this._status = code; return this; },
    json(data) { this._data = data; }
  };
  // Re-use the GET handler
  app._router.handle(
    Object.assign({}, req, { method: 'GET', url: '/api/cognitive/weekly-report', query: {} }),
    fakeRes,
    () => {}
  );
  // Since the handler is synchronous, _data is available immediately
  const report = fakeRes._data;
  if (!report || report.error) {
    return res.status(fakeRes._status === 200 ? 400 : fakeRes._status).json(report || { error: 'Failed to generate report' });
  }

  try {
    let entries = [];
    if (fs.existsSync(cogWeeklyPath)) {
      entries = JSON.parse(fs.readFileSync(cogWeeklyPath, 'utf-8'));
    }
    const weekOf = report.week_start;
    const savedAt = new Date().toISOString();
    const entry = { weekOf, generatedAt: savedAt, report };

    // Overwrite if same weekOf exists
    const idx = entries.findIndex(e => e.weekOf === weekOf);
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }

    // Keep up to 52 entries (most recent)
    if (entries.length > 52) {
      entries = entries.slice(entries.length - 52);
    }

    fs.writeFileSync(cogWeeklyPath, JSON.stringify(entries, null, 2));
    res.json({ ok: true, weekOf, savedAt });
  } catch (err) {
    console.error('Error saving weekly report:', err);
    res.status(500).json({ error: 'Failed to save weekly report' });
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

    // Stroop: primary metric is interference_score (incongRT - congRT); lower = better
    const stroop = computeMetrics('stroop', r => r.scores.interference_score);
    // Also track congruent/incongruent RT separately for richer insight
    const stroopCongRT = computeMetrics('stroop', r => r.scores.congruent_rt);
    const stroopIncongRT = computeMetrics('stroop', r => r.scores.incongruent_rt);

    // AVLT: total learning score (words recalled across trials 1-5)
    const avlt = computeMetrics('avlt', r => r.scores.total_learning_score);

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
      stroop,
      stroop_congruent_rt: stroopCongRT,
      stroop_incongruent_rt: stroopIncongRT,
      avlt,
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

// ── WHOOP ↔ Cognitive Correlation Engine ──
app.get('/api/cognitive/correlations', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const whoopData = cogDB.getAllWhoopData();
    const results = cogDB.getResults(90).map(r => ({
      ...r,
      scores: JSON.parse(r.scores_json)
    }));

    // Group cognitive results by date, picking best score per test type per day
    const cogByDate = {};
    for (const r of results) {
      if (!cogByDate[r.date]) cogByDate[r.date] = {};
      const existing = cogByDate[r.date][r.test_type];
      if (r.test_type === 'pvt') {
        if (!existing || r.scores.median_rt < existing.median_rt)
          cogByDate[r.date].pvt = r.scores;
      } else if (r.test_type === 'dsst') {
        if (!existing || r.scores.correct > existing.correct)
          cogByDate[r.date].dsst = r.scores;
      } else if (r.test_type === 'nback') {
        if (!existing || r.scores.max_n > existing.max_n)
          cogByDate[r.date].nback = r.scores;
      }
    }

    // Join by date
    const matched = [];
    for (const w of whoopData) {
      const cog = cogByDate[w.date];
      if (cog) matched.push({ whoop: w, cog });
    }

    if (matched.length < 7) {
      return res.json({ insufficient_data: true, data_points: matched.length, minimum_required: 7 });
    }

    // Pearson correlation helper
    function pearson(xs, ys) {
      const n = xs.length;
      if (n < 7) return null;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0, dx2 = 0, dy2 = 0;
      for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = ys[i] - my;
        num += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
      }
      const denom = Math.sqrt(dx2 * dy2);
      return denom === 0 ? 0 : num / denom;
    }

    // Build paired arrays for each WHOOP metric × cognitive metric
    const whoopMetrics = {
      sleep_hours: { extract: w => w.sleep_duration_min != null ? w.sleep_duration_min / 60 : null, label: 'Sleep Duration (hrs)' },
      hrv: { extract: w => w.hrv_rmssd, label: 'HRV (RMSSD)' },
      recovery: { extract: w => w.recovery_score, label: 'Recovery Score' },
      deep_sleep_pct: { extract: w => (w.deep_sleep_min != null && w.sleep_duration_min) ? (w.deep_sleep_min / w.sleep_duration_min) * 100 : null, label: 'Deep Sleep %' }
    };
    const cogMetrics = {
      pvt_median_rt: { extract: c => c.pvt ? c.pvt.median_rt : null, label: 'PVT Median RT', lower_better: true },
      dsst_correct: { extract: c => c.dsst ? c.dsst.correct : null, label: 'DSST Correct', lower_better: false },
      nback_level: { extract: c => c.nback ? c.nback.max_n : null, label: 'N-Back Level', lower_better: false }
    };

    const correlations = {};
    const insights = [];

    for (const [wKey, wDef] of Object.entries(whoopMetrics)) {
      correlations[wKey] = {};
      for (const [cKey, cDef] of Object.entries(cogMetrics)) {
        const xs = [], ys = [];
        for (const m of matched) {
          const x = wDef.extract(m.whoop);
          const y = cDef.extract(m.cog);
          if (x != null && y != null) { xs.push(x); ys.push(y); }
        }
        const r = pearson(xs, ys);
        correlations[wKey][cKey] = { r: r != null ? Math.round(r * 1000) / 1000 : null, n: xs.length };

        // Generate insight for |r| >= 0.3
        if (r != null && Math.abs(r) >= 0.3) {
          const strength = Math.abs(r) >= 0.7 ? 'strong' : Math.abs(r) >= 0.5 ? 'moderate' : 'weak';
          const dir = r > 0 ? 'positive' : 'negative';
          // Interpret the practical meaning
          let meaning;
          if (r > 0 && !cDef.lower_better) {
            meaning = `Higher ${wDef.label.toLowerCase()} is associated with better ${cDef.label.toLowerCase()} performance.`;
          } else if (r < 0 && cDef.lower_better) {
            meaning = `Higher ${wDef.label.toLowerCase()} is associated with better ${cDef.label.toLowerCase()} (faster reaction time).`;
          } else if (r > 0 && cDef.lower_better) {
            meaning = `Higher ${wDef.label.toLowerCase()} is associated with slower ${cDef.label.toLowerCase()} (worse performance).`;
          } else {
            meaning = `Higher ${wDef.label.toLowerCase()} is associated with lower ${cDef.label.toLowerCase()}.`;
          }
          insights.push({
            whoop_metric: wDef.label,
            cognitive_metric: cDef.label,
            r: Math.round(r * 1000) / 1000,
            strength,
            direction: dir,
            n: xs.length,
            insight: `${strength.charAt(0).toUpperCase() + strength.slice(1)} ${dir} correlation (r=${r.toFixed(2)}, n=${xs.length}): ${meaning}`
          });
        }
      }
    }

    // Sort insights by absolute correlation strength
    insights.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

    res.json({ data_points: matched.length, correlations, insights });
  } catch (err) {
    console.error('Error computing correlations:', err);
    res.status(500).json({ error: 'Failed to compute correlations' });
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
    scope: 'offline read:sleep read:recovery read:cycles',
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
    console.log('WHOOP token response keys:', Object.keys(tokens));
    console.log('WHOOP has refresh_token:', !!tokens.refresh_token);
    console.log('WHOOP token fields:', JSON.stringify({ 
      has_access: !!tokens.access_token, 
      has_refresh: !!tokens.refresh_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      scope: tokens.scope 
    }));
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    cogDB.saveWhoopTokens(tokens.access_token, tokens.refresh_token || null, expiresAt);

    if (!tokens.refresh_token) {
      console.warn('WHOOP OAuth: NO refresh_token in response. Token will expire in', tokens.expires_in, 'seconds. Re-auth will be required after expiry.');
    } else {
      console.log('WHOOP OAuth: refresh_token received and stored. Auto-refresh enabled.');
    }

    res.redirect('/cognitive/index.html?whoop=connected');
  } catch (err) {
    console.error('WHOOP callback error:', err);
    res.redirect('/cognitive/index.html?whoop=error');
  }
});

// Diagnostics — verify token state and DB persistence after re-auth
app.get('/api/whoop/diagnostics', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  const dataVolumeMounted = fs.existsSync('/data');
  const dbPath = dataVolumeMounted
    ? '/data/cognitive.db'
    : path.join(__dirname, 'cognitive.db');
  const dbExists = fs.existsSync(dbPath);
  const tokens = cogDB.getWhoopTokens();
  const hasAccess = !!(tokens && tokens.access_token);
  const hasRefresh = !!(tokens && tokens.refresh_token);
  const expired = tokens ? new Date(tokens.expires_at) < new Date() : null;
  res.json({
    db: { path: dbPath, volumeMounted: dataVolumeMounted, fileExists: dbExists },
    tokens: {
      hasAccessToken: hasAccess,
      hasRefreshToken: hasRefresh,
      tokenExpired: expired,
      expiresAt: tokens ? tokens.expires_at : null,
      updatedAt: tokens ? tokens.updated_at : null,
    },
    verdict: !hasAccess
      ? 'NOT_CONNECTED — re-auth required'
      : !hasRefresh
        ? 'CONNECTED_NO_REFRESH — WHOOP did not return a refresh_token; re-auth will be needed after expiry'
        : expired
          ? 'REFRESH_TOKEN_AVAILABLE_BUT_EXPIRED — should auto-refresh on next sync'
          : 'HEALTHY — connected with refresh token',
  });
});

// Status — check if WHOOP is connected
app.get('/api/whoop/status', dashboardAuth, async (req, res) => {
  if (!checkCogDB(res)) return;
  const tokens = cogDB.getWhoopTokens();
  if (!tokens || !tokens.access_token) {
    return res.json({ connected: false });
  }
  const expired = new Date(tokens.expires_at) < new Date();

  // If token is expired, proactively attempt a refresh so the dashboard
  // shows an accurate connected/disconnected state.
  if (expired && tokens.refresh_token) {
    const freshToken = await getWhoopAccessToken();
    if (freshToken) {
      return res.json({ connected: true, hasRefreshToken: true, tokenExpired: false, refreshed: true });
    }
    // Refresh failed — tokens were cleared by getWhoopAccessToken()
    return res.json({ connected: false, refreshFailed: true });
  }

  res.json({ connected: !expired, hasRefreshToken: !!tokens.refresh_token, tokenExpired: expired });
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
  if (!tokens.refresh_token) {
    console.warn('WHOOP token expired and no refresh token available — marking disconnected');
    return null;
  }

  console.log('WHOOP access token expired, attempting refresh...');
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
      const errBody = await refreshRes.text().catch(() => 'unknown');
      console.error(`WHOOP token refresh failed (${refreshRes.status}): ${errBody}`);
      // Clear tokens — mark as disconnected
      cogDB.saveWhoopTokens('', '', '');
      return null;
    }

    const newTokens = await refreshRes.json();
    if (!newTokens.access_token) {
      console.error('WHOOP refresh response missing access_token');
      cogDB.saveWhoopTokens('', '', '');
      return null;
    }
    const expiresAt = new Date(Date.now() + (newTokens.expires_in || 3600) * 1000).toISOString();
    cogDB.saveWhoopTokens(newTokens.access_token, newTokens.refresh_token || tokens.refresh_token, expiresAt);
    console.log('WHOOP token refreshed successfully, expires at', expiresAt);
    return newTokens.access_token;
  } catch (err) {
    console.error('WHOOP token refresh error:', err);
    return null;
  }
}

// Helper: process WHOOP sleep + recovery data and save to DB
function processWhoopSyncData(sleepData, recoveryData, res) {
  const sleepRecords = sleepData.records || [];
  const recoveryRecords = recoveryData.records || [];

  const recoveryBySleepId = {};
  const recoveryByDate = {};
  recoveryRecords.forEach(r => {
    if (r.sleep_id != null) recoveryBySleepId[String(r.sleep_id)] = r;
    const fallbackDate = r.created_at ? r.created_at.split('T')[0] : null;
    if (fallbackDate) recoveryByDate[fallbackDate] = r;
  });

  let synced = 0;
  sleepRecords.forEach(sleep => {
    const date = sleep.start ? sleep.start.split('T')[0] : null;
    if (!date) return;

    const msToMin = ms => ms != null ? ms / 60000 : null;
    const stages = sleep.score?.stage_summary || {};
    const recovery = recoveryBySleepId[String(sleep.id)] || recoveryByDate[date] || {};
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

  return res.json({ ok: true, synced });
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
      fetch('https://api.prod.whoop.com/developer/v2/activity/sleep?limit=30', { headers }),
      fetch('https://api.prod.whoop.com/developer/v2/recovery?limit=30', { headers }),
    ]);

    // Handle 401 — force-refresh and retry once before giving up
    if (sleepRes.status === 401 || recoveryRes.status === 401) {
      console.log('WHOOP API returned 401 — attempting token refresh and retry...');
      // Invalidate the cached expiry so getWhoopAccessToken() forces a refresh
      const currentTokens = cogDB.getWhoopTokens();
      if (currentTokens && currentTokens.refresh_token) {
        cogDB.saveWhoopTokens(currentTokens.access_token, currentTokens.refresh_token, new Date(0).toISOString());
        const retryToken = await getWhoopAccessToken();
        if (retryToken) {
          const retryHeaders = { Authorization: `Bearer ${retryToken}` };
          const [retrySleep, retryRecovery] = await Promise.all([
            fetch('https://api.prod.whoop.com/developer/v2/activity/sleep?limit=30', { headers: retryHeaders }),
            fetch('https://api.prod.whoop.com/developer/v2/recovery?limit=30', { headers: retryHeaders }),
          ]);
          if (retrySleep.ok || retryRecovery.ok) {
            // Retry succeeded — continue with retried responses
            const retrySleepData = retrySleep.ok ? await retrySleep.json() : { records: [] };
            const retryRecoveryData = retryRecovery.ok ? await retryRecovery.json() : { records: [] };
            return processWhoopSyncData(retrySleepData, retryRecoveryData, res);
          }
        }
      }
      // Refresh+retry failed — clear tokens
      console.error('WHOOP token refresh+retry failed — clearing tokens');
      cogDB.saveWhoopTokens('', '', '');
      return res.status(401).json({ error: 'WHOOP token expired. Please reconnect.' });
    }

    const sleepData = sleepRes.ok ? await sleepRes.json() : { records: [] };
    const recoveryData = recoveryRes.ok ? await recoveryRes.json() : { records: [] };

    return processWhoopSyncData(sleepData, recoveryData, res);
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

// ── Insights Engine ──────────────────────────────────────────────────────────
function generateInsights() {
  const insights = [];
  const whoopData = cogDB.getWhoopData(14); // last 14 days, sorted DESC
  const cogResults = cogDB.getAllResults();  // all cognitive test results

  if (!whoopData || whoopData.length === 0) {
    return [{
      type: 'whoop_disconnected', severity: 'info',
      title: 'WHOOP Not Connected',
      message: 'Connect your WHOOP device to unlock personalized sleep and recovery insights.',
      icon: '⌚'
    }];
  }

  const latest = whoopData[0]; // most recent
  const last7 = whoopData.slice(0, 7);

  // 1. Sleep Debt
  const sleepRows = last7.filter(d => d.sleep_duration_min != null);
  if (sleepRows.length >= 3) {
    const avgSleep = sleepRows.reduce((s, d) => s + d.sleep_duration_min, 0) / sleepRows.length;
    let sleepNeeded = 480; // default 8 hours in minutes
    for (const row of sleepRows) {
      if (row.raw_sleep_json) {
        try {
          const json = JSON.parse(row.raw_sleep_json);
          // WHOOP structure: single record or records[]
          const rec = json.score || (json.records && json.records[0] && json.records[0].score);
          const baseline = rec && rec.sleep_needed && rec.sleep_needed.baseline_milli;
          if (baseline) { sleepNeeded = baseline / 60000; break; }
        } catch(e) {}
      }
    }
    const deficit = sleepNeeded - avgSleep;
    if (deficit > 30) {
      // Recommend bedtime assuming 6:30 AM wake
      const wakeMinutes = 6 * 60 + 30;
      const bedMinutes = ((wakeMinutes - sleepNeeded) % 1440 + 1440) % 1440;
      const bh = Math.floor(bedMinutes / 60);
      const bm = Math.floor(bedMinutes % 60);
      const bedStr = `${bh % 12 || 12}:${bm.toString().padStart(2,'0')} ${bh < 12 ? 'AM' : 'PM'}`;
      insights.push({
        type: 'sleep_debt', severity: 'warning',
        title: 'Sleep Debt Detected',
        message: `Averaging ${(avgSleep/60).toFixed(1)}h vs your ${(sleepNeeded/60).toFixed(1)}h baseline — a ${(deficit/60).toFixed(1)}h deficit. Target bedtime tonight: ${bedStr}.`,
        icon: '😴'
      });
    }
  }

  // 2. Recovery Readiness
  if (latest.recovery_score != null) {
    const score = Math.round(latest.recovery_score);
    if (score >= 67) {
      insights.push({
        type: 'recovery', severity: 'info',
        title: 'High Recovery — Green Zone',
        message: `Recovery at ${score}%. Good day for intense training or demanding cognitive work — push hard today.`,
        icon: '💪'
      });
    } else if (score >= 34) {
      insights.push({
        type: 'recovery', severity: 'info',
        title: 'Moderate Recovery — Yellow Zone',
        message: `Recovery at ${score}%. Steady work is fine but skip intense exercise. Prioritize focus over maximum output.`,
        icon: '⚡'
      });
    } else {
      insights.push({
        type: 'recovery', severity: 'warning',
        title: 'Low Recovery — Rest Day',
        message: `Recovery at ${score}% — red zone. Prioritize rest and light activity only. Intense cognitive or physical effort will compound the deficit.`,
        icon: '🔴'
      });
    }
  }

  // 3. HRV Trend
  const hrvRows = last7.filter(d => d.hrv_rmssd != null && d.hrv_rmssd > 0);
  if (hrvRows.length >= 3) {
    const sorted = [...hrvRows].sort((a, b) => a.date.localeCompare(b.date));
    let consecutiveDecline = 0, consecutiveRise = 0, maxDecline = 0, maxRise = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].hrv_rmssd < sorted[i-1].hrv_rmssd) {
        consecutiveDecline++; consecutiveRise = 0;
      } else {
        consecutiveRise++; consecutiveDecline = 0;
      }
      maxDecline = Math.max(maxDecline, consecutiveDecline);
      maxRise = Math.max(maxRise, consecutiveRise);
    }
    if (maxDecline >= 3) {
      insights.push({
        type: 'hrv_trend', severity: 'warning',
        title: 'HRV Declining — Possible Overtraining',
        message: `HRV has dropped for ${maxDecline}+ consecutive days. This signals accumulating stress or overtraining. Consider a deload day and prioritize sleep and recovery protocols.`,
        icon: '📉'
      });
    } else if (maxRise >= 3) {
      insights.push({
        type: 'hrv_trend', severity: 'info',
        title: 'HRV Rising — Keep It Up',
        message: `HRV has been trending upward for ${maxRise}+ days. Your current recovery habits are working — maintain your sleep schedule and stress management routine.`,
        icon: '📈'
      });
    }
  }

  // 4. Deep Sleep Quality
  const deepRows = last7.filter(d => d.deep_sleep_min != null);
  if (deepRows.length >= 3) {
    const avgDeep = deepRows.reduce((s, d) => s + d.deep_sleep_min, 0) / deepRows.length;
    if (avgDeep < 60) {
      insights.push({
        type: 'deep_sleep', severity: 'action',
        title: 'Deep Sleep Below Optimal',
        message: `Averaging only ${Math.round(avgDeep)}min of deep sleep (target: 60min+). Cut caffeine by 2pm, cool your bedroom to 65°F, and avoid screens 1hr before bed.`,
        icon: '🌙'
      });
    }
  }

  // 5. REM Sleep
  const remRows = last7.filter(d => d.rem_sleep_min != null && d.sleep_duration_min > 0);
  if (remRows.length >= 3) {
    const avgRemPct = remRows.reduce((s, d) => s + (d.rem_sleep_min / d.sleep_duration_min), 0) / remRows.length * 100;
    if (avgRemPct < 25) {
      insights.push({
        type: 'rem_sleep', severity: 'warning',
        title: 'Low REM Sleep',
        message: `REM averaging ${avgRemPct.toFixed(0)}% of total sleep (target: 25%+). REM is critical for memory consolidation — this directly impacts your cognitive test results.`,
        icon: '🧠'
      });
    }
  }

  // 6. Cognitive-Sleep Correlation
  const dsstResults = cogResults.filter(r => r.test_type === 'dsst');
  if (dsstResults.length >= 5) {
    const corr = [];
    for (const test of dsstResults) {
      // Check same-day and prior-day WHOOP data
      const d = new Date(test.date);
      d.setDate(d.getDate() - 1);
      const prevStr = d.toISOString().slice(0, 10);
      const whoop = whoopData.find(w => w.date === prevStr || w.date === test.date);
      if (whoop && whoop.sleep_duration_min) {
        try {
          const scores = JSON.parse(test.scores_json);
          if (scores.correct != null) corr.push({ correct: scores.correct, sleep: whoop.sleep_duration_min });
        } catch(e) {}
      }
    }
    if (corr.length >= 5) {
      const good = corr.filter(c => c.sleep >= 420); // 7+ hours
      const poor = corr.filter(c => c.sleep < 420);
      if (good.length >= 2 && poor.length >= 2) {
        const avgGood = good.reduce((s, c) => s + c.correct, 0) / good.length;
        const avgPoor = poor.reduce((s, c) => s + c.correct, 0) / poor.length;
        const pct = Math.round(Math.abs(avgGood - avgPoor) / (avgPoor || 1) * 100);
        if (pct > 5) {
          insights.push({
            type: 'cog_sleep_corr', severity: 'info',
            title: 'Sleep-Cognition Link Found',
            message: `DSST scores average ${pct}% higher after 7+ hours of sleep (${avgGood.toFixed(0)} vs ${avgPoor.toFixed(0)} correct). More sleep = measurably faster processing speed.`,
            icon: '🔗'
          });
        }
      }
    }
  }

  // 7. Pre-Test Prediction
  if (latest.recovery_score != null && latest.sleep_duration_min != null) {
    const score = latest.recovery_score;
    const sleep = latest.sleep_duration_min;
    let prediction, sev, sevIcon;
    if (score >= 67 && sleep >= 420) {
      prediction = 'above baseline'; sev = 'info'; sevIcon = '🎯';
    } else if (score <= 33 || sleep < 300) {
      prediction = 'below baseline'; sev = 'warning'; sevIcon = '⚠️';
    } else {
      prediction = 'near baseline'; sev = 'info'; sevIcon = '📊';
    }
    const advice = prediction === 'above baseline'
      ? 'Run your full battery today — conditions are optimal.'
      : prediction === 'below baseline'
      ? 'Consider a shorter session or reschedule non-critical tests.'
      : 'Standard session recommended.';
    insights.push({
      type: 'pre_test_prediction', severity: sev,
      title: "Today's Cognitive Forecast",
      message: `Based on last night's ${(sleep/60).toFixed(1)}h sleep and ${Math.round(score)}% recovery, expect performance ${prediction}. ${advice}`,
      icon: sevIcon
    });
  }

  // 8. Sleep Consistency
  const consistRows = last7.filter(d => d.sleep_consistency != null);
  if (consistRows.length >= 3) {
    const avgConsist = consistRows.reduce((s, d) => s + d.sleep_consistency, 0) / consistRows.length;
    if (avgConsist < 70) {
      insights.push({
        type: 'sleep_consistency', severity: 'action',
        title: 'Inconsistent Sleep Schedule',
        message: `Sleep consistency averaging ${avgConsist.toFixed(0)}% (target: 70%+). Irregular sleep times disrupt circadian rhythm and HRV. Pick a fixed bedtime and wake time — including weekends.`,
        icon: '🕐'
      });
    }
  }

  return insights;
}

app.get('/api/cognitive/insights', dashboardAuth, (req, res) => {
  if (!checkCogDB(res)) return;
  try {
    const insights = generateInsights();
    res.json({ insights });
  } catch (err) {
    console.error('Error generating insights:', err);
    res.status(500).json({ error: 'Failed to generate insights' });
  }
});

// SEO Reports
const seoReportsPath = path.join(__dirname, "data", "seo-reports.json");
app.get("/api/seo/report", dashboardAuth, (req, res) => {
  try {
    if (!fs.existsSync(seoReportsPath)) return res.status(404).json({ error: "No report yet" });
    const reports = JSON.parse(fs.readFileSync(seoReportsPath, "utf8"));
    res.json(reports[0] || { error: "Empty" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/seo/report/generate", dashboardAuth, async (req, res) => {
  try {
    const { generateSEOReport } = require("./src/seo-engine");
    const report = await generateSEOReport();
    let reports = [];
    try { if (fs.existsSync(seoReportsPath)) reports = JSON.parse(fs.readFileSync(seoReportsPath, "utf8")); } catch {}
    reports = reports.filter(r => r.weekOf !== report.weekOf);
    reports.unshift(report); if (reports.length > 52) reports = reports.slice(0, 52);
    fs.writeFileSync(seoReportsPath, JSON.stringify(reports, null, 2));
    res.json({ ok: true, report });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Neural NeXus running on http://localhost:${PORT}`);
});


// DEBUG: Raw WHOOP API response (temporary)
app.get('/api/whoop/debug-sync', dashboardAuth, async (req, res) => {
  const accessToken = await getWhoopAccessToken();
  if (!accessToken) return res.status(401).json({ error: 'No token' });

  const headers = { Authorization: `Bearer ${accessToken}` };
  try {
    const [sleepRes, recoveryRes] = await Promise.all([
      fetch('https://api.prod.whoop.com/developer/v2/activity/sleep?limit=5', { headers }),
      fetch('https://api.prod.whoop.com/developer/v2/recovery?limit=5', { headers }),
    ]);
    const sleepData = sleepRes.ok ? await sleepRes.json() : { status: sleepRes.status, error: await sleepRes.text() };
    const recoveryData = recoveryRes.ok ? await recoveryRes.json() : { status: recoveryRes.status, error: await recoveryRes.text() };
    res.json({ 
      sleep: { status: sleepRes.status, data: sleepData },
      recovery: { status: recoveryRes.status, data: recoveryData }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
