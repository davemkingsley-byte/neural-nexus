// Local vision analysis via Ollama. Mirrors the interface of src/fitness-ai.js
// so server routes can swap providers based on config.
//
// Prereqs:
//   - `ollama serve` running at http://localhost:11434
//   - Target model already pulled and vision-capable: `ollama pull <model>`
//
// Env:
//   OLLAMA_HOST            (default: http://localhost:11434)
//   FITNESS_VISION_MODEL   (default: gemma4:e4b)

const fs = require('fs');
const {
  HEIGHT_METERS, resizeForApi, cleanupTempFile, extractJson, buildPrompt, clampAnalysis
} = require('./fitness-ai-common');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.FITNESS_VISION_MODEL || 'gemma4:e4b';
const REQUEST_TIMEOUT_MS = 180_000; // 3 min — local models can be slow on larger multimodal requests

function getProviderInfo() {
  return { provider: 'ollama', model: DEFAULT_MODEL, host: OLLAMA_HOST };
}

async function isOllamaAvailable() {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return false;
    const data = await r.json();
    return Array.isArray(data.models) && data.models.some(m => m.name === DEFAULT_MODEL || m.model === DEFAULT_MODEL);
  } catch (_) {
    return false;
  }
}

// photos: array of { absPath, angle }
// opts: { weightLbs }
async function analyzePhysique(photos, opts = {}) {
  if (!photos || photos.length === 0) {
    return { ok: false, error: 'no photos supplied' };
  }

  // Health check first so we return a clear error instead of hanging
  const available = await isOllamaAvailable();
  if (!available) {
    return { ok: false, error: `Ollama not reachable at ${OLLAMA_HOST} or model "${DEFAULT_MODEL}" not pulled (ollama pull ${DEFAULT_MODEL})` };
  }

  const tempFiles = [];
  try {
    const images = [];
    for (const p of photos) {
      const resized = resizeForApi(p.absPath);
      if (resized !== p.absPath) tempFiles.push(resized);
      const bytes = fs.readFileSync(resized);
      images.push(bytes.toString('base64'));
    }

    const prompt = buildPrompt(photos, opts);
    const body = {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: prompt, images }],
      stream: false,
      format: 'json', // ask Ollama to enforce JSON output
      options: {
        temperature: 0.2, // keep deterministic-ish for numeric estimates
        num_ctx: 8192
      }
    };

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(to);
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { ok: false, error: `Ollama ${response.status}: ${errText.slice(0, 300)}` };
    }
    const data = await response.json();
    const rawText = data?.message?.content || '';
    const parsed = extractJson(rawText);
    if (!parsed) return { ok: false, error: 'Could not parse JSON from Ollama response', rawText };

    clampAnalysis(parsed); // small models sometimes output impossible values
    return { ok: true, analysis: parsed, rawText, provider: 'ollama', model: DEFAULT_MODEL };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? `Ollama timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : (err.message || String(err)) };
  } finally {
    for (const f of tempFiles) cleanupTempFile(f);
  }
}

// Synchronous "configured" check — matches the Anthropic provider's interface.
// Returns true whenever we have *potential* access to Ollama. Actual reachability
// is checked at request time inside analyzePhysique so errors are returned cleanly.
function isApiKeyConfigured() {
  return Boolean(OLLAMA_HOST && DEFAULT_MODEL);
}

module.exports = { analyzePhysique, isApiKeyConfigured, getProviderInfo, HEIGHT_METERS };
