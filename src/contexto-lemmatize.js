// Server-side lemmatization for Contexto.
// Returns an ordered list of candidate forms to probe against the rankings map.
// First hit wins.

const lemmatizer = require('wink-lemmatizer');

function lemmatize(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w || !/^[a-z]+$/.test(w)) return [];

  const candidates = [w];
  try {
    const n = lemmatizer.noun(w);
    const v = lemmatizer.verb(w);
    const a = lemmatizer.adjective(w);
    if (n && n !== w) candidates.push(n);
    if (v && v !== w) candidates.push(v);
    if (a && a !== w) candidates.push(a);
  } catch (e) {
    // wink-lemmatizer throws for some edge cases; fall through with what we have
  }

  // Dedupe while preserving order
  return [...new Set(candidates)];
}

module.exports = { lemmatize };
