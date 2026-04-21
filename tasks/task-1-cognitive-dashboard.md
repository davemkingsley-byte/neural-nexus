# Task 1 — Cognitive Dashboard v2

## Objective
Rebuild `public/cognitive/index.html` into a proper data visualization dashboard with charts, trends, and supplement tracking.

## Constraints
- Do NOT touch `src/cognitive-db.js`
- Do NOT modify any API routes in `server.js`
- Do NOT change `dashboardAuth` or any authentication middleware
- Do NOT touch other cognitive test pages (pvt.html, dsst.html, stroop.html, avlt.html, dsst.html, tmtb.html, dual-n-back.html)
- Auth is already handled — the page is served at `/cognitive/` which requires password `nexus2026`

## Existing APIs (all require auth cookie — already set when user is logged in)

- `GET /api/cognitive/results` — returns all test scores
- `GET /api/cognitive/chess` — chess ELO history (blitz, rapid, bullet)
- `GET /api/cognitive/supplements` — supplement log
- `GET /api/cognitive/phases` — all experiment phases
- `GET /api/cognitive/phases/active` — currently active phase
- `GET /api/cognitive/phases/compare` — phase comparison stats
- `GET /api/cognitive/phases/:id/stats` — stats for a specific phase

## What to Build

Replace the current `public/cognitive/index.html` with a full-page dashboard.

### Section 1 — Active Phase Banner
- Fetch `/api/cognitive/phases/active`
- Show: phase name, day number (days since start), start date
- If no active phase, show "No active phase — start one below"
- Style: full-width banner at top, blue/purple gradient background

### Section 2 — Summary Score Cards (row of 6)
- Fetch latest result for each test type from `/api/cognitive/results`
- One card per test: PVT (reaction time ms), DSST (score), N-Back (level reached), Stroop (interference score), AVLT (words recalled), TMT-B (completion time seconds)
- Each card shows: test name, latest score, trend arrow vs 7-day average
- Color: green if improving, red if declining, grey if no trend data

### Section 3 — Chess ELO Chart
- Fetch `/api/cognitive/chess`
- Line chart using Chart.js (CDN: `https://cdn.jsdelivr.net/npm/chart.js`)
- Three lines: blitz (blue), rapid (purple), bullet (pink)
- X-axis: dates, Y-axis: ELO rating
- Show last 30 data points
- Dark themed chart — background transparent, grid lines rgba(255,255,255,0.1), text white

### Section 4 — Per-Test Trend Charts
- One chart per test type (6 charts total)
- Show last 14 sessions as a line chart
- Use Chart.js, same dark styling
- Layout: 2-column grid on desktop, 1-column on mobile

### Section 5 — Supplement Log Table
- Fetch `/api/cognitive/supplements`
- Table columns: Date, Supplement, Dose, Notes
- Sorted by most recent first
- Show last 30 entries
- Scrollable if long

### Section 6 — Phase Comparison
- Fetch `/api/cognitive/phases/compare`
- If 2+ phases exist: side-by-side cards showing average score per test per phase
- Highlight differences >1 standard deviation with a colored badge
- If fewer than 2 phases: show placeholder "Complete at least 2 phases to compare"

## Design
- Match existing dark glassmorphism: `background: rgba(255,255,255,0.05)`, `backdrop-filter: blur(10px)`
- Accent colors: blue `#60a5fa`, purple `#a78bfa`
- Font: inherit from existing CSS (Inter or system sans-serif)
- Cards with rounded corners (`border-radius: 12px`), subtle border (`border: 1px solid rgba(255,255,255,0.1)`)
- No light mode needed
- Must look good at 375px mobile width

## File to Edit
- `public/cognitive/index.html` — replace contents entirely
- Do not create new server routes
- Do not create new CSS files — inline styles or a `<style>` block in the HTML is fine
