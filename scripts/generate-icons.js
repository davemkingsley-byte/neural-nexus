#!/usr/bin/env node
// Generate PWA icons for Neural NeXus
// Usage: node scripts/generate-icons.js
// Requires: npm install canvas

const path = require('path');
const fs = require('fs');

let createCanvas;
try {
  createCanvas = require('canvas').createCanvas;
} catch (e) {
  console.error('canvas package not available. Install with: npm install canvas');
  console.log('Falling back to SVG-only icons (already created at public/app/icons/icon.svg)');
  process.exit(0);
}

const SIZES = [192, 512];
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'app', 'icons');

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const scale = size / 512;

  // Background with rounded corners
  const r = 96 * scale;
  ctx.fillStyle = '#06060b';
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.fill();

  // Inner border
  const ir = 80 * scale;
  const m = 24 * scale;
  ctx.strokeStyle = 'rgba(212,168,83,0.2)';
  ctx.lineWidth = 3 * scale;
  ctx.beginPath();
  ctx.moveTo(m + ir, m);
  ctx.lineTo(size - m - ir, m);
  ctx.quadraticCurveTo(size - m, m, size - m, m + ir);
  ctx.lineTo(size - m, size - m - ir);
  ctx.quadraticCurveTo(size - m, size - m, size - m - ir, size - m);
  ctx.lineTo(m + ir, size - m);
  ctx.quadraticCurveTo(m, size - m, m, size - m - ir);
  ctx.lineTo(m, m + ir);
  ctx.quadraticCurveTo(m, m, m + ir, m);
  ctx.stroke();

  // "NN" text
  ctx.fillStyle = '#d4a853';
  ctx.font = `bold ${200 * scale}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('NN', size / 2, size * 0.52);

  // Underline
  ctx.strokeStyle = 'rgba(212,168,83,0.4)';
  ctx.lineWidth = 4 * scale;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(128 * scale, 340 * scale);
  ctx.lineTo(384 * scale, 340 * scale);
  ctx.stroke();

  return canvas;
}

for (const size of SIZES) {
  const canvas = drawIcon(size);
  const buffer = canvas.toBuffer('image/png');
  const outPath = path.join(OUTPUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(outPath, buffer);
  console.log(`Generated ${outPath} (${buffer.length} bytes)`);
}

console.log('Done!');
