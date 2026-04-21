# Task 5 — Substack Auto-Commenter / Engagement Bot

## Objective
Build a private tool at `/substack-engage` that monitors newsletters David follows on Substack, drafts comments in his voice using the Anthropic API, and queues them for his approval before posting.

## Why This Matters
Thoughtful comments on peer newsletters drive reciprocal follows, Substack recommendations, and subscriber growth for Neural NeXus. This automates the research and drafting — David just approves or edits before anything goes live.

## Constraints
- Password protected — use existing `dashboardAuth` middleware
- Do NOT auto-post anything without explicit approval click
- Do NOT touch existing routes or middleware
- Uses Anthropic API (already configured server-side via `process.env.ANTHROPIC_API_KEY` or equivalent)
- No new npm packages except: `@anthropic-ai/sdk` (if not already installed — check package.json first)

## Architecture

### Data Storage
Add a new SQLite table to the existing cognitive DB or create a separate file at `/data/engage.db`:

```sql
CREATE TABLE IF NOT EXISTS newsletters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  substack_url TEXT NOT NULL,  -- e.g. https://foo.substack.com
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comment_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  newsletter_name TEXT,
  post_title TEXT,
  post_url TEXT,
  post_excerpt TEXT,
  draft_comment TEXT,
  status TEXT DEFAULT 'pending',  -- pending | approved | rejected | posted
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  acted_at DATETIME
);
```

### Server Routes (add to server.js)

```
GET  /substack-engage              → render the UI page (dashboardAuth)
GET  /api/engage/newsletters       → list tracked newsletters (dashboardAuth)
POST /api/engage/newsletters       → add a newsletter (dashboardAuth)
DELETE /api/engage/newsletters/:id → remove a newsletter (dashboardAuth)
GET  /api/engage/queue             → get comment queue (dashboardAuth)
POST /api/engage/scan              → trigger manual scan of all newsletters (dashboardAuth)
POST /api/engage/queue/:id/approve → mark approved (dashboardAuth)
POST /api/engage/queue/:id/reject  → mark rejected (dashboardAuth)
PUT  /api/engage/queue/:id         → edit draft comment text (dashboardAuth)
```

### Scan Logic (POST /api/engage/scan)

For each active newsletter:
1. Fetch the newsletter's RSS feed: `{substack_url}/feed`
2. Parse the 3 most recent posts
3. For each post not already in `comment_queue` (check by post_url):
   a. Extract title + first 800 chars of content (strip HTML tags)
   b. Call Anthropic API to draft a comment (see prompt below)
   c. Insert into `comment_queue` with status `pending`
4. Return count of new drafts created

### Anthropic Comment Draft Prompt

```
You are drafting a Substack comment on behalf of David Kingsley, PhD — a scientist at Colossal Biosciences who writes the Neural NeXus newsletter covering AI, biotech, robotics, semiconductors, and the future.

Newsletter: {newsletter_name}
Post title: {post_title}
Post excerpt: {post_excerpt}

Write a thoughtful comment (2-4 sentences) that:
- Demonstrates genuine engagement with the specific ideas in this post
- Adds a relevant insight, data point, or question that extends the conversation
- Sounds like a smart peer, not a fan or a marketer
- May briefly mention David's relevant work or perspective if it adds value — never forced
- Does NOT include "Great post!" or generic praise
- Does NOT mention Neural NeXus unless it's genuinely relevant

Return only the comment text, no preamble.
```

### RSS Parsing
Reuse the existing `fetchUrl()` and `parseRSSItems()` functions already in server.js. Or write a lightweight version inline. No new parser library needed.

## UI (views/pages/substack-engage.ejs)

### Layout — three panels

**Panel 1: Tracked Newsletters**
- List of newsletters with name, URL, active toggle
- "Add Newsletter" form: name + Substack URL input + Add button
- Delete button per newsletter
- "Scan Now" button — triggers POST /api/engage/scan, shows spinner, reports "X new drafts created"

**Panel 2: Comment Queue**
- Table/card list of pending comments
- Each item shows: newsletter name, post title (linked), draft comment text
- Three actions per item:
  - ✅ Approve — marks approved, copies comment to clipboard + opens post URL in new tab
  - ✏️ Edit — inline text edit of the draft
  - ❌ Reject — removes from queue
- Filter tabs: Pending | Approved | Rejected

**Panel 3: Stats**
- Total comments approved this month
- Newsletters tracked count
- Last scan timestamp

## Design
- Dark glassmorphism, match existing site style
- Blue/purple accents
- Mobile responsive

## Cron (optional — add if time permits)
Add a cron job that runs the scan automatically every 6 hours:
```js
// In server.js startup or a separate cron file
setInterval(scanAllNewsletters, 6 * 60 * 60 * 1000);
```

## Seed Data
Pre-populate the newsletters table with 5-10 newsletters in David's space. Good candidates:
- https://www.bioinformatics.blog
- https://aisnakeoil.substack.com
- https://www.exponentialview.co
- https://oneusefulthing.substack.com
- https://www.thegeneralist.co
- https://www.strangeloopcanon.com

## Notes
- The "post" action (actually submitting to Substack) is NOT part of this task — that requires browser automation and Substack login. The approve button just copies to clipboard and opens the post. David manually pastes and submits.
- Future enhancement: Playwright-based auto-post after approval
