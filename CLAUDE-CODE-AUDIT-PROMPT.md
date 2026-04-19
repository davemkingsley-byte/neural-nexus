# Neural NeXus Website — Full Audit & Improvement Prompt

## Context

You are improving **neuralnexus.press** — the website for David Kingsley, PhD. David is a scientist at Colossal Biosciences working on de-extinction and artificial womb technology. He writes the **Neural NeXus** newsletter under the pseudonym "A Future Bull." The newsletter covers AI, biotech, robotics, semiconductors, health optimization, and the future.

**Primary goal of the site:** Convert visitors into Substack subscribers at `https://davidkingsley.substack.com`

---

## Technical Setup

- **Stack:** Node.js/Express, vanilla HTML/CSS/JS, EJS templates, SQLite
- **Hosting:** Mac Mini via Cloudflare Tunnel → `localhost:4000` (no Railway, no deployment pipeline)
- **Root directory:** `/Users/Open_claw/.openclaw/workspace/neural-nexus/`
- **Server file:** `server.js` (~3,200 lines)
- **Public assets:** `public/`
- **Restart server:** `pkill -f "node.*server.js"; sleep 1; node /Users/Open_claw/.openclaw/workspace/neural-nexus/server.js &`
- **Test locally:** `curl -s http://localhost:4000/ | head -20`
- **Live URL:** https://www.neuralnexus.press

---

## Brand Identity

- **Colors:** `--bg: #06060b`, `--accent: #60a5fa`, `--accent-2: #a78bfa`, `--gold: #f0c040`, `--green: #34d399`
- **Fonts:** DM Sans (body), JetBrains Mono (code/mono), Instrument Serif (headings)
- **Aesthetic:** Dark glassmorphism — intentional, premium, science-forward
- **Tone:** Direct, intelligent, no fluff. Not academic, not corporate.
- **DO NOT change the design system.** Refine and extend it, don't replace it.

---

## Author Info

- **Name:** David Kingsley, PhD
- **Role:** Scientist at Colossal Biosciences (de-extinction, artificial womb / ExoDev technology)
- **Newsletter pseudonym:** "A Future Bull"
- **Substack:** https://davidkingsley.substack.com (also at https://blog.neuralnexus.press)
- **Substack RSS:** https://davidkingsley.substack.com/feed
- **Instagram:** https://instagram.com/Davidkingsley.phd
- **Twitter/X:** ACCOUNT PERMANENTLY SUSPENDED — remove ALL Twitter/X references, icons, links, and meta tags from every file
- **Photo:** `/public/img/david.jpg`
- **Logo:** `/public/img/neuron-logo.jpg`

---

## Current Site Structure

### Public Pages
| Route | File | Description |
|-------|------|-------------|
| `/` | `public/index.html` | Landing page |
| `/archive` | `public/archive.html` | Game archive |
| `/topics` | EJS (server-rendered) | Topic index |
| `/topics/:slug` | EJS (server-rendered) | Individual topic pages |
| `/privacy` | `public/privacy.html` | Privacy policy |

### Games
| Route | Description |
|-------|-------------|
| `/play` | Spelling Bee |
| `/wordle` | Wordie (Wordle clone) |
| `/crossword` | Mini Crossword |
| `/connections` | Connections puzzle |
| `/brain-check` | Brain Check |

### Protected (password: `nexus2026`) — DO NOT TOUCH
| Route | Description |
|-------|-------------|
| `/cognitive/` | Cognitive test suite |
| `/dashboard` | PM dashboard |
| `/morpheus` | Digital embodiment |
| `/rca` | RCA tool |
| `/treat-docs/` | Treat Biosciences docs |
| `/treat-preview/` | Treat preview |
| `/app/` | Mobile PWA |

---

## Current Homepage (`public/index.html`) — Full Contents

The current homepage has these sections in order:
1. **Nav** — logo, links (Blog, Articles, About, games, Archive, Subscribe CTA)
2. **Hero** — "Where science meets the future", subscriber badge, two CTAs (Subscribe + Play Spelling Bee)
3. **Articles** — 4 hardcoded article cards with static dates, titles, descriptions, and S3 thumbnail URLs pointing to old Substack posts
4. **About** — David's photo, name, role, bio, Instagram + Substack links
5. **Topics** — 6 topic cards (Biotech, AI, Health, Robotics, Semiconductors, The Future)
6. **Games** — 4 game cards (Spelling Bee, Wordie, Mini Crossword, Brain Check)
7. **Subscribe** — email input that redirects to Substack subscribe page
8. **Footer** — logo, links (Blog, Podcast, Archive, Spelling Bee, Instagram), copyright

**Current issues with the homepage:**
- Article cards are hardcoded and stale — the newest is from March 2026, there are no newer posts showing
- Twitter meta tags exist (`twitter:card`, `twitter:title`, etc.) — must be removed
- `blog.neuralnexus.press` is referenced in nav and footer — verify this subdomain resolves correctly, if not replace with direct Substack URL
- Subscribe form redirects to Substack but there's no confirmation/feedback to the user
- The scroll animation (IntersectionObserver) causes cards to be invisible until scrolled into view — this may look broken on first load
- No "Read latest issue" featured section
- Connections game is NOT in the games grid on homepage

---

## What To Fix — Priority Order

### PRIORITY 1: Remove All Twitter/X References

Search every file in `public/` for:
- `twitter:` meta tags
- Twitter icons (SVG or img)
- Links to `twitter.com` or `x.com`
- Any `@` handles referencing Twitter

Replace `twitter:card` meta with nothing (OG tags are sufficient). This applies to: `index.html`, `archive.html`, `privacy.html`, all game pages, and any EJS template files.

---

### PRIORITY 2: Dynamic Articles via Substack RSS

The article section currently shows 4 hardcoded posts from March 2026. Replace with a **server-side RSS fetch** that pulls the latest posts automatically.

**Implementation:**

In `server.js`, add a server-side RSS fetch with 1-hour cache:

```javascript
const https = require('https');

let rssCache = null;
let rssCacheTime = 0;
const RSS_TTL = 3600000; // 1 hour

function fetchSubstackFeed() {
  return new Promise((resolve, reject) => {
    const url = 'https://davidkingsley.substack.com/feed';
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseRSSItems(xml, limit = 4) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const item = match[1];
    const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1] || '';
    const link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
    const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
    const description = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || [])[1] || '';
    const enclosure = (item.match(/<enclosure[^>]+url="([^"]+)"/) || [])[1] || '';
    const mediaUrl = (item.match(/<media:thumbnail[^>]+url="([^"]+)"/) || item.match(/<media:content[^>]+url="([^"]+)"/) || [])[1] || '';
    
    // Strip HTML from description, truncate to 120 chars
    const cleanDesc = description.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const imgUrl = enclosure || mediaUrl;
    const formattedDate = pubDate ? new Date(pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    
    items.push({ title, link, date: formattedDate, description: cleanDesc, image: imgUrl });
  }
  return items;
}

async function getSubstackPosts() {
  const now = Date.now();
  if (rssCache && (now - rssCacheTime) < RSS_TTL) return rssCache;
  try {
    const xml = await fetchSubstackFeed();
    rssCache = parseRSSItems(xml, 4);
    rssCacheTime = now;
    return rssCache;
  } catch (e) {
    console.error('RSS fetch failed:', e.message);
    return rssCache || []; // Return stale cache on failure
  }
}
```

Then update the homepage route (around line 305 in server.js) to pass posts to the template, OR generate the article HTML server-side and inject into the page.

The simplest approach since index.html is static: **add a new API endpoint** `/api/posts` that returns the RSS data as JSON, then fetch it client-side on page load. This avoids converting index.html to EJS.

Add to `server.js`:
```javascript
app.get('/api/posts', async (req, res) => {
  try {
    const posts = await getSubstackPosts();
    res.json({ posts });
  } catch (e) {
    res.json({ posts: [] });
  }
});
```

Then update the articles section in `index.html` to fetch from `/api/posts` on load:
- Show a loading skeleton while fetching
- Render posts dynamically
- Fall back to showing "Read on Substack →" link if fetch fails
- Each post card should match the existing `.article-card` design

---

### PRIORITY 3: Fix the Scroll Animation Bug

The current IntersectionObserver script sets cards to `opacity: 0; transform: translateY(16px)` immediately, making content invisible until scrolled. This causes the page to look empty on first load.

Fix: Only apply the animation if the element is NOT already in the viewport on load. Or better: use `animationDelay` with CSS `@keyframes` instead of JS opacity manipulation.

Simple fix — replace the observer script with:
```javascript
const observer = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('visible');
      observer.unobserve(e.target);
    }
  });
}, { threshold: 0.05, rootMargin: '0px 0px -20px 0px' });

document.querySelectorAll('.card, .about-card, .game-card, .article-card').forEach(el => {
  // Only animate if below the fold
  const rect = el.getBoundingClientRect();
  if (rect.top > window.innerHeight) {
    el.classList.add('animate-on-scroll');
    observer.observe(el);
  }
});
```

Add CSS:
```css
.animate-on-scroll { opacity: 0; transform: translateY(16px); transition: opacity 0.5s ease, transform 0.5s ease; }
.animate-on-scroll.visible { opacity: 1; transform: translateY(0); }
```

---

### PRIORITY 4: Add Connections Game to Homepage

The `/connections` game exists but is missing from the games grid. Add it as a 5th card (or replace Brain Check with it, keeping Brain Check as a separate link). Suggested style:
```css
background: linear-gradient(135deg, rgba(251,191,36,0.05) 0%, rgba(251,191,36,0.02) 100%);
border-color: rgba(251,191,36,0.15);
```
Button: amber/yellow gradient, "Play Connections →"

---

### PRIORITY 5: SEO Cleanup

**Remove from ALL public HTML files:**
- `<meta name="twitter:card" ...>`
- `<meta name="twitter:title" ...>`
- `<meta name="twitter:description" ...>`
- `<meta name="twitter:image" ...>`
- Any `twitter.com` or `x.com` links

**Verify on ALL public pages:**
- Unique `<title>` tag (format: `[Page Name] — Neural NeXus`)
- `<meta name="description">` present and unique
- `<link rel="canonical">` present and correct
- `og:title`, `og:description`, `og:image`, `og:url` all correct
- `og:image` should use `https://www.neuralnexus.press/img/neuron-logo.jpg`

**Add RSS autodiscovery to `<head>` of index.html:**
```html
<link rel="alternate" type="application/rss+xml" title="Neural NeXus" href="/feed.xml">
```

**Verify `robots.txt`** blocks protected routes:
```
User-agent: *
Allow: /
Disallow: /cognitive/
Disallow: /dashboard
Disallow: /morpheus
Disallow: /rca
Disallow: /treat-docs/
Disallow: /treat-preview/
Disallow: /app/
Sitemap: https://www.neuralnexus.press/sitemap.xml
```

---

### PRIORITY 6: Visual & UX Improvements

**Hero section:**
- The hero is good but the two CTAs ("Subscribe" + "Play Spelling Bee") are odd pairings. Change secondary CTA to "Read Latest Issue →" linking to `https://davidkingsley.substack.com` (opens in new tab)

**About section:**
- Bio is generic. Replace with: *"I'm a PhD scientist at Colossal Biosciences — the company bringing back the woolly mammoth and building artificial wombs. Neural NeXus is where I write about the science reshaping civilization: AI, biotech, longevity, and the technologies most people haven't heard of yet. Deep expertise, no fluff."*
- Make sure Instagram link renders correctly with the SVG icon

**Topics section:**
- Add a brief `<a href="/topics">Explore all topics →</a>` link below the grid

**Footer:**
- Add RSS feed link: `<a href="/feed.xml">RSS</a>`
- Add Privacy link: `<a href="/privacy">Privacy</a>`  
- Remove "Podcast" link if there's no active podcast
- Verify the "Blog" link points to `https://davidkingsley.substack.com` (not `blog.neuralnexus.press` unless confirmed working)

**Nav:**
- Verify "Blog" link is correct
- Consider consolidating game links — they crowd the nav on mobile. Could collapse into a "Games ▾" dropdown or just keep the top 2 games

**Subscribe section:**
- After clicking Subscribe, show a brief "Redirecting to Substack..." message before opening the new tab so users know something happened

---

### PRIORITY 7: Performance

**Add cache headers for static assets in `server.js`:**

Find where `express.static` is configured (around line 604) and add cache headers:
```javascript
app.use(express.static(path.join(__dirname, 'public'), { 
  redirect: false,
  setHeaders: (res, filePath) => {
    if (filePath.match(/\.(jpg|jpeg|png|gif|webp|svg|ico)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
    } else if (filePath.match(/\.(css|js)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
    }
  }
}));
```

**Verify 404 handler exists** at the bottom of `server.js`. It should look like:
```javascript
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});
```
If missing, add it before the final `app.listen()` call.

**Remove any Railway-specific code** — search for `railway.app` and `process.env.RAILWAY_*` and remove or replace with neutral equivalents.

---

## Constraints — Read Carefully

1. **DO NOT touch** `/cognitive/`, `/app/`, `/dashboard`, `/morpheus`, `/rca`, `/treat-*` — these are internal protected tools
2. **DO NOT change** any `dashboardAuth`, `dashboardLoginPage`, or authentication middleware
3. **DO NOT change** any game logic or API endpoints
4. **DO NOT change** the design system (colors, fonts, spacing scale) — refine only
5. **PRESERVE** all existing API endpoints (`/api/wordle/*`, `/api/charters`, `/api/cognitive/*`, etc.)
6. **TEST** every route after changes: `/`, `/archive`, `/topics`, `/play`, `/wordle`, `/crossword`, `/connections`, `/brain-check`, `/feed.xml`, `/sitemap.xml`
7. **Restart server** after any `server.js` changes

---

## Deliverables

1. Summary of all changes made (file by file)
2. Verification that all major routes still return 200
3. Any issues found but not fixed (with reasoning)
4. Anything that requires David's input (new photos, content decisions, etc.)

---

## Start Here

1. `cat /Users/Open_claw/.openclaw/workspace/neural-nexus/public/index.html` — read the full homepage
2. `grep -n "twitter\|Railway\|railway" /Users/Open_claw/.openclaw/workspace/neural-nexus/public/index.html` — audit for removals
3. `curl -s https://davidkingsley.substack.com/feed | head -100` — inspect RSS structure
4. Begin with Priority 1 (Twitter removal) across all files, then work down the list
