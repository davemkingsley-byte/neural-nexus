#!/usr/bin/env node
/**
 * One-off generator for public/og-image.png (1200×630).
 * Run with: node scripts/generate-og-image.js
 *
 * Requires the `canvas` npm module, which is installed in this repo but is
 * intentionally NOT a runtime dep — it only runs to produce the static PNG.
 * Commit the resulting PNG; don't re-run this on every deploy.
 */
const path = require('path');
const fs = require('fs');
const { createCanvas } = require('canvas');

const W = 1200;
const H = 630;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// Background — site bg color.
ctx.fillStyle = '#06060b';
ctx.fillRect(0, 0, W, H);

// Soft radial glow behind the wordmark (blue→purple).
const glow = ctx.createRadialGradient(W / 2, H / 2 - 60, 40, W / 2, H / 2 - 60, 520);
glow.addColorStop(0, 'rgba(108,140,255,0.22)');
glow.addColorStop(0.55, 'rgba(167,139,250,0.08)');
glow.addColorStop(1, 'rgba(6,6,11,0)');
ctx.fillStyle = glow;
ctx.fillRect(0, 0, W, H);

// Subtle particle dots + connecting lines, bias toward the middle band.
function rand(a, b) { return a + Math.random() * (b - a); }
const rng = (() => { let s = 42; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
function r(a, b) { return a + rng() * (b - a); }
const particles = [];
for (let i = 0; i < 70; i++) {
  particles.push({ x: r(40, W - 40), y: r(40, H - 40), r: r(0.8, 2.2) });
}
// Lines
ctx.lineWidth = 0.9;
for (let i = 0; i < particles.length; i++) {
  for (let j = i + 1; j < particles.length; j++) {
    const a = particles[i], b = particles[j];
    const dx = a.x - b.x, dy = a.y - b.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 140) {
      const alpha = (1 - d / 140) * 0.2;
      const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, `rgba(108,140,255,${alpha})`);
      g.addColorStop(1, `rgba(167,139,250,${alpha})`);
      ctx.strokeStyle = g;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }
}
// Dots
for (const p of particles) {
  ctx.fillStyle = 'rgba(236,230,255,0.7)';
  ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
}

// Kicker — small eyebrow above the wordmark.
ctx.fillStyle = '#60a5fa';
ctx.font = 'bold 22px "DM Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.letterSpacing = '6px'; // canvas doesn't support directly; fall back by adding spaces
ctx.fillText('B Y   A   P H D   S C I E N T I S T', W / 2, H / 2 - 130);

// Wordmark — "NEURAL NEXUS" with a gradient fill.
const wordmark = 'NEURAL NEXUS';
ctx.font = 'bold 116px "DM Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
const grad = ctx.createLinearGradient(W / 2 - 360, 0, W / 2 + 360, 0);
grad.addColorStop(0, '#ffffff');
grad.addColorStop(1, '#ffffff');
ctx.fillStyle = grad;
ctx.fillText(wordmark, W / 2, H / 2 - 40);

// Gradient underline under wordmark.
const measure = ctx.measureText(wordmark);
const barW = measure.width * 0.45;
const barX = W / 2 - barW / 2;
const barY = H / 2 + 30;
const barGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
barGrad.addColorStop(0, '#60a5fa');
barGrad.addColorStop(1, '#a78bfa');
ctx.fillStyle = barGrad;
ctx.fillRect(barX, barY, barW, 5);

// Tagline — serif, muted.
ctx.fillStyle = 'rgba(240,240,245,0.72)';
ctx.font = '32px "Georgia", "Instrument Serif", serif';
ctx.fillText('The science rewriting biology, intelligence, and what comes next.', W / 2, H / 2 + 100);

// Byline
ctx.fillStyle = 'rgba(240,240,245,0.45)';
ctx.font = '20px "DM Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
ctx.fillText('By David Kingsley, PhD  ·  neuralnexus.press', W / 2, H / 2 + 180);

// Export.
const outPath = path.resolve(__dirname, '..', 'public', 'og-image.png');
fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
console.log(`wrote ${outPath} (${W}×${H})`);
