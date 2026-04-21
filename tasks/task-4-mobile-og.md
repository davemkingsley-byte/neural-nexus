# Task 4 — Mobile Responsiveness + Open Graph Tags

## Objective
Two-part task: (A) fix mobile layout across all public pages at 375px, (B) add Open Graph social preview tags so links shared on Instagram/iMessage show rich previews.

## Constraints
- Do NOT touch `/cognitive/`, `/dashboard`, `/morpheus`, `/rca`, `/treat-*`
- Do NOT change any authentication middleware
- Do NOT modify game logic — only layout/CSS

---

## Part A — Mobile Responsiveness

Test every page below at **375px viewport width** and fix all layout breaks.

### Pages to audit
- `/` (homepage)
- `/archive`
- `/topics`
- `/play` (Spelling Bee)
- `/wordle`
- `/crossword`
- `/connections`
- `/brain-check`
- `/trivia` (if Task 2 complete)
- `/mini-crossword` (if Task 3 complete)

### Known issues to fix

**Navigation:**
- If nav items overflow horizontally, implement a hamburger menu
- Hamburger: ☰ button top-right, toggles a full-width dropdown menu
- Nav should never require horizontal scrolling

**Homepage hero:**
- Headline font-size should scale down on mobile (clamp or media query)
- Topic tag pills should wrap naturally, not overflow
- Stats row (subscriber count etc.) should stack or shrink
- CTA buttons should be full-width on mobile

**Card grids:**
- Topic cards: 1 column on mobile (< 640px), 2 on tablet (640-1024px), 3 on desktop
- Game cards: same breakpoints
- Article cards: 1 column on mobile

**Footer:**
- Column layout should stack vertically on mobile
- Links should have enough tap target size (min 44px height)

**General:**
- No horizontal scroll on any page at 375px
- Font sizes readable without zooming (min 14px body, 16px+ inputs)
- All buttons/links min 44px tap target

### CSS approach
Add a `@media (max-width: 640px)` block to `public/css/home.css` (and any other relevant CSS files). If using inline styles in EJS templates, add media queries in a `<style>` block in the template.

---

## Part B — Open Graph Tags

### What to add
In the shared head partial (find where `<meta charset>` lives — likely `views/partials/head.ejs` or inline in each layout), add:

```html
<!-- Open Graph -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="Neural NeXus">
<meta property="og:title" content="<page title here>">
<meta property="og:description" content="<page description here>">
<meta property="og:image" content="https://www.neuralnexus.press/og-image.png">
<meta property="og:url" content="https://www.neuralnexus.press<%= locals.path || '' %>">

<!-- Twitter/X card (still used by other platforms) -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="<page title here>">
<meta name="twitter:description" content="<page description here>">
<meta name="twitter:image" content="https://www.neuralnexus.press/og-image.png">
```

Make title and description dynamic per page — pass them from each route in `server.js` as template locals, with fallback defaults:
- Default title: `Neural NeXus`
- Default description: `Weekly deep dives on AI, biotech, robotics, semiconductors, health, and the future — by David Kingsley, PhD.`

### OG Image
Create `public/og-image.png` at 1200×630px.

Generate it with an HTML canvas approach — create a script `scripts/generate-og-image.js` that uses the `canvas` npm package to draw:
- Dark background `#0a0a0f`
- "NEURAL NEXUS" in large white bold text, centered
- Gradient underline (blue → purple)
- Tagline in smaller grey text below
- Optional: subtle particle dots in background

Run it once to generate the PNG, then commit the PNG. Don't add canvas as a runtime dependency — it's only needed to generate the static image.

Alternatively, just create a simple 1200×630 PNG manually with dark background and white text — any method is fine as long as the file exists at `public/og-image.png`.

### Per-page descriptions
Update these routes in `server.js` to pass description locals:

| Route | Description |
|-------|-------------|
| `/` | Weekly deep dives on AI, biotech, robotics, semiconductors, health, and the future. |
| `/archive` | Browse all Neural NeXus issues — AI, biotech, robotics, and more. |
| `/topics` | Explore Neural NeXus by topic — AI, biotech, neuroscience, robotics, semiconductors, and the future. |
| `/play` | Play Neural NeXus Spelling Bee — today's daily word puzzle. |
| `/wordle` | Play Neural NeXus Wordle — guess the daily 5-letter science word. |
| `/trivia` | Test your science knowledge with today's PhD-level trivia question. |
| `/mini-crossword` | Solve today's 5×5 science-themed mini crossword. |

---

## Verification
After completing both parts:
1. Open Chrome DevTools → toggle device toolbar → set to iPhone SE (375×667)
2. Check each page for horizontal scroll, overflow, or unreadable text
3. Paste `https://www.neuralnexus.press` into https://www.opengraph.xyz to verify OG preview renders correctly
