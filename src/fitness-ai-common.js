// Shared helpers for the fitness vision providers (Anthropic cloud + Ollama local).
// Both providers import these so the prompt, image preprocessing, JSON extraction,
// and output clamping stay identical across providers.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HEIGHT_METERS = 1.8034; // 5'11" — hardcoded per spec
const MAX_EDGE_PX = 1568;
const JPEG_QUALITY = 85;

function getMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

// Resize via macOS `sips`. Returns path to a temp resized JPEG, or the original
// path if sips is unavailable / fails.
function resizeForApi(absPath) {
  const tmpPath = path.join(path.dirname(absPath), `.resize_${Date.now()}_${path.basename(absPath, path.extname(absPath))}.jpg`);
  try {
    execFileSync('sips', ['-Z', String(MAX_EDGE_PX), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY), absPath, '--out', tmpPath], { stdio: 'pipe' });
    if (fs.existsSync(tmpPath)) return tmpPath;
  } catch (_) {
    // sips unavailable or failed — fall back to original (may exceed API limits)
  }
  return absPath;
}

// Remove a temp file produced by resizeForApi. Safe no-op for non-temp paths.
function cleanupTempFile(filePath) {
  if (filePath && filePath.includes('/.resize_') && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

// Extract the first JSON object from text (handles ```json fences or prose wrapping).
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (_) {}
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

// photos: array of { absPath, angle }; opts: { weightLbs }
function buildPrompt(photos, opts = {}) {
  const weightLine = opts.weightLbs ? `bodyweight ${opts.weightLbs} lbs` : '~185 lbs (estimate if no weight given)';
  const angles = (photos || []).map(p => p.angle).filter(Boolean).join(', ');
  const multi = (photos || []).length > 1;
  return `You are a fitness assessment tool analyzing physique photos to estimate body composition.

Subject: Male, ${weightLine}, height 5'11" (1.8034 m).
${multi ? `Photos provided (${photos.length}): ${angles || 'multiple angles'} — use all angles together to produce ONE estimate of the same subject.` : 'Single photo provided.'}

Provide your best estimates. Be direct and give numeric values — this is for personal fitness tracking, not medical diagnosis.

Return ONLY a single JSON object with this exact shape:
{
  "bf_pct": <number, 6-35>,
  "lbm_lbs": <number>,
  "ffmi": <number, calculated as LBM(kg) / height(m)^2>,
  "muscle_ratings": {
    "chest": <integer 1-5>,
    "shoulders": <integer 1-5>,
    "arms": <integer 1-5>,
    "back": <integer 1-5>,
    "legs": <integer 1-5>,
    "core": <integer 1-5>
  },
  "assessment": "<2-3 sentence string describing physique stage and primary areas for improvement>"
}

Do not wrap the JSON in prose. Do not include backticks. Do not include units in the numbers.`;
}

// Coerce numeric fields (models sometimes return strings) and clamp to sane ranges.
// Mutates and returns parsed. Note: server recomputes LBM/FFMI authoritatively from
// BF% + bodyweight (reconcileBodyComp); this is a defensive sanity pass.
function clampAnalysis(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  for (const k of ['bf_pct', 'lbm_lbs', 'ffmi']) {
    const n = Number(parsed[k]);
    parsed[k] = Number.isFinite(n) ? n : null;
  }
  if (parsed.bf_pct != null) parsed.bf_pct = Math.max(3, Math.min(50, Math.round(parsed.bf_pct * 10) / 10));
  if (parsed.lbm_lbs != null) parsed.lbm_lbs = Math.max(50, Math.min(300, Math.round(parsed.lbm_lbs * 10) / 10));
  if (parsed.ffmi != null) parsed.ffmi = Math.max(14, Math.min(35, Math.round(parsed.ffmi * 10) / 10));
  return parsed;
}

module.exports = {
  HEIGHT_METERS, MAX_EDGE_PX, JPEG_QUALITY,
  getMediaType, resizeForApi, cleanupTempFile, extractJson, buildPrompt, clampAnalysis
};
