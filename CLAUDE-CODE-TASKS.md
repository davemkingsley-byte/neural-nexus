# Claude Code Overnight Tasks

Pick any of these. Each is self-contained. Don't touch `/cognitive/`, `/app/`, `/dashboard`, `/morpheus`, `/rca`, `/treat-*` routes or their auth middleware unless explicitly stated in the task.

---

## Task 1 — Cognitive Dashboard v2

**File:** `public/cognitive/index.html` (replace/upgrade in place)
**Auth:** Already protected by `dashboardAuth` middleware (password: nexus2026)
**Existing APIs to use:**
- `GET /api/cognitive/results` — all test scores (PVT, DSST, N-Back, Stroop, AVLT, TMT-B)
- `GET /api/cognitive/chess` — chess ELO history (blitz, rapid, bullet)
- `GET /api/cognitive/supplements` — supplement log
- `GET /api/cognitive/phases` — experiment phases (baseline, intervention, washout)
- `GET /api/cognitive/phases/active` — current active phase
- `GET /api/cognitive/phases/compare` — phase comparison stats
- `GET /api/cognitive/phases/:id/stats` — stats for a specific phase

**What to build:**

Replace the current basic dashboard with a proper data visualization page:

1. **Header section**
   - Active phase banner (show current phase name + day # + start date)
   - Today's date, last test date, days since last test

2. **Summary cards row**
   - Latest scores for each test (PVT reaction time, DSST score, N-Back level, Stroop interference, AVLT recall, TMT-B time)
   - Color coded: green if improving vs 7-day average, red if declining

3. **Chess ELO chart**
   - Line chart, 30-day history, separate lines for blitz/rapid/bullet
   - Use Chart.js (load from CDN: https://cdn.jsdelivr.net/npm/chart.js)

4. **Per-test trend charts**
   - One sparkline per test type showing last 14 sessions
   - Click to expand to full chart

5. **Supplement log table**
   - What was taken, when, dosage
   - Sorted by most recent

6. **Phase comparison panel**
   - If 2+ phases exist: side-by-side score averages per phase
   - Highlight statistically meaningful differences (>1 SD)

**Design:** Match existing dark glassmorphism — `background: rgba(255,255,255,0.05)`, `backdrop-filter: blur(10px)`, blue/purple accent colors (`#60a5fa`, `#a78bfa`). No light mode needed.

**Do not touch:** `src/cognitive-db.js`, any API routes in `server.js`, other cognitive test pages (pvt.html, dsst.html, etc.)

---

## Task 2 — New Game: Science Trivia

**New route:** `GET /trivia` → `views/games/trivia.ejs`
**New API:** `GET /api/trivia/question` — returns a random question

**What to build:**

A daily science trivia game in the style of the existing games (dark glassmorphism, consistent nav via `partials/header.ejs`).

**Gameplay:**
- One question per day (seeded by date, same question for all players)
- 4 multiple choice answers
- Show correct/incorrect feedback with a brief explanation after answering
- Score tracked in localStorage (streak, all-time correct, total played)
- Share button generates a result emoji string (like Wordle) for Instagram

**Question categories:** AI/ML, Biotech, Physics, Space, Neuroscience, Chemistry — David's wheelhouse

**Question bank:** Hardcode 100+ questions in a JS array in `src/trivia-questions.js`. Make them genuinely hard — PhD level, not middle school. Examples:
- "Which amino acid is most commonly found at protein-protein interfaces?" (A: Leucine B: Tryptophan C: Tyrosine D: Arginine — Answer: C)
- "What is the approximate size of a typical exosome?" (A: 10-30nm B: 30-150nm C: 200-500nm D: 1-5μm — Answer: B)
- "CRISPR-Cas9 cuts DNA how many base pairs upstream of the PAM sequence?" (A: 1bp B: 3bp C: 5bp D: 10bp — Answer: B)

**Add to nav:** Add "Trivia" link to the games dropdown in `views/partials/header.ejs`
**Add to games grid** on homepage (`views/pages/home.ejs`) and games page

---

## Task 3 — New Game: Neural NeXus Crossword (Daily Mini)

**New route:** `GET /mini-crossword` → `views/games/mini-crossword.ejs`

**What to build:**

A 5×5 daily mini crossword. Different from the existing full crossword at `/crossword`.

**Gameplay:**
- 5×5 grid, ~6-8 clues across + down
- New puzzle every day (hardcode 30 puzzles, cycle by day-of-year mod 30)
- Click cell to type, arrow keys to navigate
- Auto-advance to next cell when letter entered
- Green highlight on correct word completion
- Timer (counts up)
- Share result: "Neural NeXus Mini — solved in 2:34 🟩🟩🟩🟩🟩"

**Theme:** Puzzles themed around science, tech, AI, biotech — matches the newsletter brand

**Puzzle format** (hardcode in `src/mini-crossword-puzzles.js`):
```js
{
  date: '2026-04-19',
  grid: [
    ['C','R','I','S','P'],
    ['#','#','N','#','R'],
    ['A','X','O','N','O'],
    ['#','#','M','#','T'],
    ['D','N','A','S','E']
  ],
  clues: {
    across: [
      { number: 1, row: 0, col: 0, answer: 'CRISPR', clue: 'Gene editing tool' },
      ...
    ],
    down: [...]
  }
}
```

**Add to nav and games grid** same as Task 2.

---

## Task 4 — Mobile Responsiveness + Open Graph Tags

**Scope:** All public-facing pages

**Part A — Mobile (375px breakpoint):**
- Audit every page at 375px width
- Fix nav overflow (hamburger menu if needed)
- Fix hero text sizing — headline shouldn't overflow
- Fix card grids — 1 column on mobile, 2 on tablet, 3+ on desktop
- Fix game grids
- Fix footer — stack columns vertically on mobile
- Test: homepage, /archive, /topics, /trivia (if built), /play, /wordle

**Part B — Open Graph / Social preview tags:**
Add to `views/partials/head.ejs` (or equivalent shared head partial):
```html
<meta property="og:type" content="website">
<meta property="og:site_name" content="Neural NeXus">
<meta property="og:title" content="<%= title || 'Neural NeXus' %>">
<meta property="og:description" content="<%= description || 'Weekly deep dives on AI, biotech, robotics, semiconductors, health, and the future.' %>">
<meta property="og:image" content="https://www.neuralnexus.press/og-image.jpg">
<meta property="og:url" content="https://www.neuralnexus.press<%= path || '' %>">
<meta name="twitter:card" content="summary_large_image">
```

Create a simple `public/og-image.jpg` — a 1200×630 dark background with "NEURAL NEXUS" in large white text and the tagline. Can be generated with a canvas-to-image script or just a placeholder for now.

---

## Constraints (apply to all tasks)
- Do NOT touch: `/cognitive/` auth middleware, `/dashboard`, `/morpheus`, `/rca`, `/treat-*`
- Do NOT modify `src/cognitive-db.js` or existing game logic
- Do NOT change `dashboardAuth` or any authentication middleware
- Preserve all existing API endpoints
- Use `views/partials/header.ejs` and `views/partials/footer.ejs` for all new pages
- Dark glassmorphism design — match existing style
- No new npm packages without flagging it first
