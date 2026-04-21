# Task 3 — New Game: Daily Mini Crossword

## Objective
Build a 5×5 daily mini crossword at `/mini-crossword`. Science/tech themed puzzles, one per day cycling through a bank of 30.

## Constraints
- Do NOT modify existing crossword at `/crossword` or its files
- Use `views/partials/header.ejs` and `views/partials/footer.ejs`
- Match dark glassmorphism design
- No new npm packages

## Files to Create
- `views/games/mini-crossword.ejs` — the game page
- `src/mini-crossword-puzzles.js` — 30 puzzles

## Files to Modify
- `server.js` — add route `GET /mini-crossword`
- `views/partials/header.ejs` — add "Mini Crossword" to games dropdown
- `views/pages/home.ejs` — add Mini Crossword card to games grid

## Server Route
```js
app.get('/mini-crossword', (req, res) => {
  res.render('games/mini-crossword', { title: 'Mini Crossword — Neural NeXus' });
});
```

## Puzzle Format (src/mini-crossword-puzzles.js)
```js
module.exports = [
  {
    id: 1,
    title: "Gene Editing",
    grid: [
      ['C','R','I','S','P'],
      ['#','R','#','#','R'],
      ['A','N','A','#','O'],
      ['#','A','#','#','T'],
      ['D','#','D','N','A']
    ],
    // # = black square, letter = filled cell
    clues: {
      across: [
        { number: 1, row: 0, col: 0, len: 5, clue: "Gene editing tool (abbr.)" },
        { number: 3, row: 2, col: 0, len: 3, clue: "Genetic material type" },
        { number: 5, row: 4, col: 2, len: 3, clue: "Genetic blueprint" }
      ],
      down: [
        { number: 1, row: 0, col: 0, len: 3, clue: "Letter of DNA" },
        { number: 2, row: 0, col: 1, len: 4, clue: "Ribosome building block" },
        { number: 4, row: 0, col: 4, len: 5, clue: "Defensive protein" }
      ]
    }
  },
  // ... 29 more puzzles
];
```

Create all 30 puzzles. Themes should vary across:
- Gene editing / CRISPR
- Neuroscience
- AI / neural networks
- Space exploration
- Quantum physics
- Protein structure
- Evolutionary biology
- Drug development
- Computer science
- Mathematics

## Gameplay Logic (client-side JS)

### Puzzle Selection
```js
const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
const puzzle = puzzles[dayOfYear % puzzles.length];
```

### Grid Rendering
- Render as a CSS grid of `input` elements (1 per white cell) + black div elements
- Each input: single character, uppercase, max 1 char
- Number cells that start across/down clues (show number in small text top-left of cell)

### Interaction
- Click cell → focus it, highlight its word (across or down based on last direction)
- Type letter → fill cell, advance to next cell in word
- Backspace → clear cell, go back
- Arrow keys → navigate cells
- Tab → jump to next word

### Validation
- On each input: check if full word matches answer
- Correct word → all cells in word turn green, brief animation
- Full puzzle correct → show congratulations overlay with time

### Timer
- Count up from 0:00 when first letter typed
- Stop on completion
- Show in top-right of grid

### State (localStorage key: `nn_minicross`)
- `lastPlayed`: ISO date
- `lastTime`: seconds to complete
- `streak`: number
- `solved`: boolean for today

### Share Result
```
Neural NeXus Mini Crossword
🟩🟩🟩🟩🟩 Solved in 3:42
Streak: 5 🔥
neuralnexus.press/mini-crossword
```

## Design
- Grid: centered, cells ~52px square on desktop, ~44px on mobile
- White cells: `background: rgba(255,255,255,0.1)`, border `rgba(255,255,255,0.2)`
- Black cells: `background: rgba(0,0,0,0.5)`
- Active cell: bright blue border `#60a5fa`
- Active word highlight: `background: rgba(96,165,250,0.15)`
- Correct word: `background: rgba(34,197,94,0.3)`
- Input text: white, centered, font-size 1.2rem, font-weight bold
- Clues panel: scrollable list to the right of grid on desktop, below on mobile
- Active clue highlighted in clue list

## Add to Homepage Games Grid
```html
<a href="/mini-crossword" class="game-card">
  <div class="game-icon" style="background: rgba(16,185,129,0.2); color: #10b981;">⬛</div>
  <div class="game-info">
    <h3>Mini Crossword</h3>
    <p>Daily 5×5 science puzzle</p>
    <span class="game-btn" style="background: rgba(16,185,129,0.3);">Solve Today</span>
  </div>
</a>
```
