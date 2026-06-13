// Vision analysis via the logged-in Claude Code CLI (`claude -p`).
// Reuses whatever auth the CLI already has (a Claude subscription or an API key),
// so no ANTHROPIC_API_KEY is required. Mirrors the interface of the other providers.
//
// Env:
//   FITNESS_CLAUDE_BIN  path to the `claude` binary (default: auto-detected)
//   FITNESS_CLI_MODEL   model alias/id (default: sonnet)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { buildPrompt, extractJson, clampAnalysis, HEIGHT_METERS } = require('./fitness-ai-common');

const MODEL = process.env.FITNESS_CLI_MODEL || 'sonnet';
const REQUEST_TIMEOUT_MS = 180_000; // 3 min — CLI spin-up + a vision turn

// Resolve the `claude` binary. A GUI-launched .app has a bare PATH, so probe the
// usual install locations (build_app.sh also bakes FITNESS_CLAUDE_BIN).
function resolveBin() {
  const candidates = [
    process.env.FITNESS_CLAUDE_BIN,
    path.join(os.homedir(), '.npm-global/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.local/bin/claude'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  try {
    const p = execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  return null;
}

const CLAUDE_BIN = resolveBin();

function isAvailable() { return Boolean(CLAUDE_BIN); }
// Interface parity with the other providers ("is this provider usable?").
function isApiKeyConfigured() { return isAvailable(); }
function getProviderInfo() { return { provider: 'claude-cli', model: MODEL, bin: CLAUDE_BIN || null }; }

// photos: array of { absPath, angle }; opts: { weightLbs }
function analyzePhysique(photos, opts = {}) {
  return new Promise((resolve) => {
    if (!photos || photos.length === 0) return resolve({ ok: false, error: 'no photos supplied' });
    if (!CLAUDE_BIN) return resolve({ ok: false, error: 'claude CLI not found (set FITNESS_CLAUDE_BIN, or `npm i -g @anthropic-ai/claude-code` and log in)' });

    const refs = photos.map((p, i) => `- ${p.angle || ('image ' + (i + 1))}: ${p.absPath}`).join('\n');
    const prompt =
      `Use the Read tool to open the physique photo file(s) below, then analyze them together as ONE subject (multiple angles of the same person):\n${refs}\n\n${buildPrompt(photos, opts)}`;

    const args = ['-p', prompt, '--allowedTools', 'Read', '--model', MODEL, '--output-format', 'json'];

    execFile(CLAUDE_BIN, args, { timeout: REQUEST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) return resolve({ ok: false, error: `claude CLI timed out after ${REQUEST_TIMEOUT_MS / 1000}s` });
        return resolve({ ok: false, error: `claude CLI error: ${String(stderr || err.message || '').slice(0, 300)}` });
      }
      // --output-format json wraps the answer: { result: "<assistant text>", is_error, ... }
      let envelope = null;
      try { envelope = JSON.parse(stdout); } catch (_) {}
      if (envelope && envelope.is_error) {
        return resolve({ ok: false, error: `claude CLI: ${String(envelope.result || 'error').slice(0, 300)}` });
      }
      const text = envelope && typeof envelope.result === 'string' ? envelope.result : stdout;
      const parsed = extractJson(text);
      if (!parsed) return resolve({ ok: false, error: 'Could not parse JSON from claude CLI', rawText: String(text).slice(0, 500) });
      clampAnalysis(parsed);
      resolve({ ok: true, analysis: parsed, rawText: text, provider: 'claude-cli', model: MODEL });
    });
  });
}

module.exports = { analyzePhysique, isApiKeyConfigured, isAvailable, getProviderInfo, HEIGHT_METERS };
