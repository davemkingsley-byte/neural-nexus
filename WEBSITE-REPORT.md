# Neural NeXus Website — State & Requirements

## Overview
**URL:** https://www.neuralnexus.press  
**Stack:** Node.js/Express, vanilla HTML/CSS/JS, EJS templates, SQLite  
**Hosting:** Cloudflare Tunnel → Mac Mini localhost:4000  
**Repo:** `/Users/Open_claw/.openclaw/workspace/neural-nexus/`

---

## Current Site Structure

### Public Pages
| Route | File | Description |
|-------|------|-------------|
| `/` | `public/index.html` | Landing page — hero, recent articles, about, topics, games, subscribe |
| `/archive` | `public/archive.html` | Article archive |
| `/topics` | server-rendered (EJS) | Topic pages (AI, biotech, etc.) |
| `/topics/:slug` | server-rendered | Individual topic pages |
| `/privacy` | `public/privacy.html` | Privacy policy |

### Games (Daily Brain Fuel)
| Route | Description |
|-------|-------------|
| `/play` | Spelling Bee (daily puzzle, leaderboard) |
| `/wordle` | Wordle clone (daily word, leaderboard) |
| `/crossword` | Mini crossword |
| `/connections` | Connections puzzle |
| `/brain-check` | Quick cognitive screening |
| `/play/archive`, `/wordle/archive`, `/crossword/archive`, `/connections/archive` | Game archives |

### Cognitive Testing Suite (password-protected: `nexus2026`)
| Route | Description |
|-------|-------------|
| `/cognitive/` | Cognitive dashboard — full test battery analytics |
| `/cognitive/pvt.html` | Psychomotor Vigilance Test |
| `/cognitive/dsst.html` | Digit Symbol Substitution Test |
| `/cognitive/stroop.html` | Stroop Test |
| `/cognitive/avlt.html` | Auditory Verbal Learning Test |
| `/cognitive/dual-n-back.html` | Dual N-Back |
| `/cognitive/tmtb.html` | Trail Making Test B |
| `/cognitive/analytics.html` | Analytics dashboard |
| `/app/` | Mobile PWA version of cognitive tests |
| `/app/test/` | Simplified test interface |

### Protected Dashboards (password: `nexus2026`)
| Route | Description |
|-------|-------------|
| `/dashboard` | Project management dashboard (charters, organization) |
| `/morpheus` | Morpheus digital embodiment (neural mesh visualization) |
| `/treat-docs/` | Treat Biosciences documentation |
| `/treat-preview/` | Treat preview site |

### APIs
- `/api/charters` — Charter data (JSON)
- `/api/wordle/*` — Wordle game API
- `/api/health`, `/api/activity`, `/api/weekly` — Health/cognitive data APIs
- `/feed.xml` — RSS feed
- `/sitemap.xml` — Dynamic sitemap
- `/health` — Server health check

---

## Current Design
- Dark glassmorphism theme (`--bg: #06060b`)
- Fonts: DM Sans, JetBrains Mono, Instrument Serif
- Responsive, mobile-friendly
- Hero section with subscriber count, CTA buttons (Read Latest, Subscribe)
- Topic cards with gradient backgrounds
- Game cards with emoji icons

---

## What Needs Work

### 1. Homepage Refresh
- **Articles section** — Currently has 3 hardcoded article cards. Should pull dynamically from Substack RSS or a local JSON feed.
- **Subscriber count** — Hardcoded "1,000+ subscribers". Should update automatically or be easy to change.
- **Social links** — Instagram (@Davidkingsley.phd) only. X account was suspended — remove any Twitter references if present.

### 2. Substack Integration
- The site serves as a landing page that drives to `davidkingsley.substack.com`
- Subscribe form should work (currently uses a Substack embed/redirect)
- Consider embedding recent Substack posts directly

### 3. Games Polish
- Spelling Bee, Wordle, Crossword, and Connections are all functional
- Leaderboards exist for Wordle and Spelling Bee
- **Connections** was added later — verify it's fully integrated
- Brain Check at `/brain-check/` needs testing

### 4. SEO (Already Deployed)
- GA4: `G-B0X6HBHKH3`
- Search Console verified
- IndexNow key deployed
- robots.txt and sitemap.xml in place
- JSON-LD structured data on homepage
- Open Graph and Twitter cards configured

### 5. Mobile PWA (`/app/`)
- Service worker at `/app/sw.js`
- Manifest at `/app/manifest.json`
- Offline page exists
- Contains cognitive test suite and settings
- Should work as installable PWA

### 6. Known Issues to Fix
- **404 page** (`public/404.html`) — exists but verify it's wired up in Express error handler
- **Treat docs** — password-protected, verify auth still works post-migration
- **Dashboard** — verify `charters.json` loads correctly
- **SSL** — now handled by Cloudflare, remove any old SSL/cert handling in Express if present
- **Port** — Express listens on `process.env.PORT || 4000`. Cloudflare Tunnel routes to localhost:4000. This is correct.

### 7. Performance
- Static assets served by Express — consider adding cache headers
- No CDN for images currently (Cloudflare will cache proxied assets automatically)
- Single `index.html` is 594 lines with inline CSS — could split stylesheet out

---

## File Structure
```
neural-nexus/
├── server.js              # Express server (3200+ lines)
├── public/
│   ├── index.html         # Landing page
│   ├── archive.html       # Article archive
│   ├── dashboard.html     # PM dashboard
│   ├── morpheus.html      # Digital embodiment
│   ├── crossword.html     # Crossword game
│   ├── privacy.html       # Privacy policy
│   ├── 404.html           # Error page
│   ├── robots.txt         # SEO
│   ├── app/               # Mobile PWA
│   ├── cognitive/         # Cognitive test suite
│   ├── brain-check/       # Quick brain check
│   ├── data/              # charters.json
│   ├── css/               # Stylesheets
│   ├── img/               # Images (david.jpg, neuron-logo.jpg)
│   ├── topics/            # Topic page assets
│   ├── treat-docs/        # Treat Biosciences docs
│   └── treat-preview/     # Treat preview site
├── src/
│   ├── database.js        # Spelling Bee SQLite
│   ├── cognitive-db.js    # Cognitive test SQLite
│   ├── puzzle-generator.js
│   ├── wordle-words.js
│   ├── crossword-puzzles.js
│   ├── connections-puzzles.js
│   ├── seo-engine.js
│   └── words.js / dict5.txt
└── views/                 # EJS templates
```

---

## Databases
- `/data/spelling-bee.db` — Spelling Bee puzzles and scores
- `/data/cognitive.db` — Cognitive test results and analytics

---

## Environment
- **Node.js** on Mac Mini (Apple Silicon)
- **Cloudflare Tunnel** handles SSL termination and proxying
- **No Railway dependencies remain** — fully self-hosted
- Password for protected routes: `nexus2026` (query param `?key=nexus2026` or POST login)
