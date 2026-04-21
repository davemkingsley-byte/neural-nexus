# Task 2 — New Game: Science Trivia

## Objective
Build a daily science trivia game at `/trivia`. One PhD-level question per day, multiple choice, streak tracking, shareable results.

## Constraints
- Do NOT modify `server.js` authentication middleware
- Do NOT touch existing game files
- Use `views/partials/header.ejs` and `views/partials/footer.ejs` for the page shell
- Match existing dark glassmorphism design
- No new npm packages

## Files to Create
- `views/games/trivia.ejs` — the game page
- `src/trivia-questions.js` — question bank (100+ questions)

## Files to Modify
- `server.js` — add route `GET /trivia`
- `views/partials/header.ejs` — add "Trivia" to games dropdown nav
- `views/pages/home.ejs` — add Trivia card to games grid

## Server Route (add to server.js)
```js
app.get('/trivia', (req, res) => {
  res.render('games/trivia', { title: 'Science Trivia — Neural NeXus' });
});
```

## Gameplay Logic (client-side JS in the EJS file)

1. Load question bank from an inline JS array (imported from trivia-questions.js or inlined)
2. Select today's question: `questions[dayOfYear % questions.length]`
3. `dayOfYear` = day number of current year (Jan 1 = 0) — same question for everyone on same day
4. Display question + 4 shuffled answer choices as buttons
5. On answer click:
   - Disable all buttons
   - Highlight selected answer (red if wrong, green if correct)
   - Highlight correct answer green regardless
   - Show explanation text below
   - Show "Next" or "Share" button
6. Track in localStorage key `nn_trivia`:
   - `lastPlayed`: ISO date string
   - `streak`: number
   - `totalCorrect`: number
   - `totalPlayed`: number
7. If already played today: show result screen with streak info instead of question

## Share Button
Generate and copy to clipboard:
```
Neural NeXus Trivia — April 19
🧬 ✅ Streak: 3
neuralnexus.press/trivia
```
Use ✅ for correct, ❌ for wrong.

## Question Bank (src/trivia-questions.js)
Create 100+ questions. Format:
```js
module.exports = [
  {
    question: "CRISPR-Cas9 cuts DNA how many base pairs upstream of the PAM sequence?",
    answers: ["1 bp", "3 bp", "5 bp", "10 bp"],
    correct: 1, // 0-indexed
    explanation: "Cas9 creates a double-strand break 3 bp upstream of the PAM sequence, which is critical for repair pathway selection."
  },
  ...
];
```

Categories to cover (aim for ~15 questions each):
- Molecular Biology / Genetics
- Neuroscience
- AI / Machine Learning
- Physics / Quantum
- Biotech / Pharma
- Space / Astronomy
- Chemistry
- Evolution / Ecology

All questions must be PhD-level difficulty. No softballs.

## Design
- Dark glassmorphism card centered on page
- Question text large and readable
- Answer buttons: `background: rgba(255,255,255,0.05)`, hover brightens, full width
- Correct: `background: rgba(34,197,94,0.3)`, border green
- Wrong: `background: rgba(239,68,68,0.3)`, border red
- Streak badge top-right of card
- Responsive — works at 375px

## Add to Homepage Games Grid (views/pages/home.ejs)
Add a card:
```html
<a href="/trivia" class="game-card">
  <div class="game-icon" style="background: rgba(168,85,247,0.2); color: #a855f7;">🧬</div>
  <div class="game-info">
    <h3>Science Trivia</h3>
    <p>Daily PhD-level question</p>
    <span class="game-btn" style="background: rgba(168,85,247,0.3);">Play Today</span>
  </div>
</a>
```
