// Cloud vision analysis via the Anthropic Messages API.
// Mirrors the interface of src/fitness-ai-local.js so server routes can swap
// providers based on config.
//
// Env:
//   ANTHROPIC_API_KEY          (required for this provider)
//   FITNESS_ANTHROPIC_MODEL    (default: claude-sonnet-4-6)

const fs = require('fs');
const {
  HEIGHT_METERS, getMediaType, resizeForApi, cleanupTempFile, extractJson, buildPrompt, clampAnalysis
} = require('./fitness-ai-common');

// Vision-capable current model. claude-3-5-sonnet-20241022 was retired (404s), so
// it must not be used. Sonnet 4.6 is a strong, economical default for repeated
// personal-use photo analysis; override with FITNESS_ANTHROPIC_MODEL=claude-opus-4-8
// for the most capable vision.
const ANTHROPIC_MODEL = process.env.FITNESS_ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const REQUEST_TIMEOUT_MS = 120_000; // 2 min — cap so a hung API call can't pin a request

function isApiKeyConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

function getProviderInfo() {
  return { provider: 'anthropic', model: ANTHROPIC_MODEL };
}

// photos: array of { absPath, angle } — all for the same session
// opts: { weightLbs } (optional)
async function analyzePhysique(photos, opts = {}) {
  if (!isApiKeyConfigured()) {
    return { ok: false, error: 'ANTHROPIC_API_KEY not configured' };
  }
  if (!photos || photos.length === 0) {
    return { ok: false, error: 'no photos supplied' };
  }

  const content = [];
  const tempFiles = [];
  try {
    for (const p of photos) {
      const resized = resizeForApi(p.absPath);
      if (resized !== p.absPath) tempFiles.push(resized);
      const bytes = fs.readFileSync(resized);
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: getMediaType(resized),
          data: bytes.toString('base64')
        }
      });
      if (p.angle) content.push({ type: 'text', text: `Angle: ${p.angle}` });
    }
    content.push({ type: 'text', text: buildPrompt(photos, opts) });

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1024,
          messages: [{ role: 'user', content }]
        }),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(to);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { ok: false, error: `API ${response.status}: ${errText.slice(0, 300)}` };
    }
    const data = await response.json();
    const rawText = (data.content || []).map(b => b.text || '').join('\n');
    const parsed = extractJson(rawText);
    if (!parsed) {
      return { ok: false, error: 'Could not parse JSON from response', rawText };
    }
    clampAnalysis(parsed);
    return { ok: true, analysis: parsed, rawText, provider: 'anthropic', model: ANTHROPIC_MODEL };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? `Anthropic timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : (err.message || String(err)) };
  } finally {
    for (const f of tempFiles) cleanupTempFile(f);
  }
}

module.exports = { analyzePhysique, isApiKeyConfigured, getProviderInfo, HEIGHT_METERS, ANTHROPIC_MODEL };
