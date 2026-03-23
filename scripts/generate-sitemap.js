#!/usr/bin/env node
/**
 * generate-sitemap.js
 * 
 * Auto-generates public/sitemap.xml from the route table below,
 * using each route's backing file mtime for <lastmod>.
 * 
 * Run:  node scripts/generate-sitemap.js
 * Add to package.json scripts:  "sitemap": "node scripts/generate-sitemap.js"
 * 
 * Routes flagged with file: null get today's date as lastmod.
 * Routes flagged with inSitemap: false are skipped (auth-protected, API-only, etc.)
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.neuralnexus.press';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SITEMAP_OUT = path.join(PUBLIC_DIR, 'sitemap.xml');

// ISO date from a file's mtime (YYYY-MM-DD), or today if file missing/null
function fileDate(relPath) {
  if (!relPath) return todayDate();
  const abs = path.join(PUBLIC_DIR, relPath);
  try {
    const stat = fs.statSync(abs);
    return stat.mtime.toISOString().slice(0, 10);
  } catch {
    return todayDate();
  }
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Route table.  Each entry:
 *   url        – path relative to BASE_URL
 *   file       – path relative to PUBLIC_DIR for mtime lookup (null = use today)
 *   changefreq – sitemap changefreq value
 *   priority   – sitemap priority (0.0–1.0)
 *   inSitemap  – set false to exclude (auth-protected, private, etc.)
 */
const ROUTES = [
  // Core pages
  { url: '/',                       file: 'index.html',                    changefreq: 'weekly',  priority: 1.0 },
  { url: '/privacy',                file: 'privacy.html',                  changefreq: 'yearly',  priority: 0.4 },

  // Games
  { url: '/play',                   file: 'play.html',                     changefreq: 'daily',   priority: 0.8 },
  { url: '/wordle',                 file: 'wordle.html',                   changefreq: 'daily',   priority: 0.8 },
  { url: '/crossword',              file: 'crossword.html',                changefreq: 'daily',   priority: 0.8 },
  { url: '/archive',                file: 'archive.html',                  changefreq: 'daily',   priority: 0.7 },
  { url: '/play/archive',           file: 'spelling-bee-archive.html',     changefreq: 'daily',   priority: 0.6 },
  { url: '/wordle/archive',         file: 'wordle-archive.html',           changefreq: 'daily',   priority: 0.6 },
  { url: '/crossword/archive',      file: 'crossword-archive.html',        changefreq: 'daily',   priority: 0.6 },

  // Topic pages
  { url: '/topics/ai',              file: 'topics/ai.html',                changefreq: 'monthly', priority: 0.9 },
  { url: '/topics/biotech',         file: 'topics/biotech.html',           changefreq: 'monthly', priority: 0.9 },
  { url: '/topics/robotics',        file: 'topics/robotics.html',          changefreq: 'monthly', priority: 0.9 },
  { url: '/topics/semiconductors',  file: 'topics/semiconductors.html',    changefreq: 'monthly', priority: 0.9 },
  { url: '/topics/venture-capital', file: 'topics/venture-capital.html',   changefreq: 'monthly', priority: 0.9 },
  { url: '/topics/health',          file: 'topics/health.html',            changefreq: 'monthly', priority: 0.9 },
  { url: '/topics/longevity',       file: 'topics/longevity.html',         changefreq: 'monthly', priority: 0.9 },
  { url: '/topics/de-extinction',   file: 'topics/de-extinction.html',     changefreq: 'monthly', priority: 0.9 },
  { url: '/topics/artificial-womb', file: 'topics/artificial-womb.html',   changefreq: 'monthly', priority: 0.9 },
  { url: '/topics/ai-agents',       file: 'topics/ai-agents.html',         changefreq: 'monthly', priority: 0.9 },

  // Cognitive / app (public-facing only)
  { url: '/brain-check/',           file: 'brain-check/index.html',        changefreq: 'monthly', priority: 0.8 },
  { url: '/cognitive/',             file: 'cognitive/index.html',          changefreq: 'weekly',  priority: 0.8 },
  { url: '/cognitive/analytics.html', file: 'cognitive/analytics.html',   changefreq: 'weekly',  priority: 0.7 },
  { url: '/app/',                   file: 'app/index.html',                changefreq: 'weekly',  priority: 0.7 },

  // Auth-protected / private — excluded from sitemap
  { url: '/dashboard',              file: null, inSitemap: false },
  { url: '/health',                 file: null, inSitemap: false },
];

function buildSitemap(routes) {
  const includedRoutes = routes.filter(r => r.inSitemap !== false);

  const urlEntries = includedRoutes.map(r => {
    const lastmod = fileDate(r.file);
    return [
      '  <url>',
      `    <loc>${BASE_URL}${r.url}</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      `    <changefreq>${r.changefreq}</changefreq>`,
      `    <priority>${r.priority.toFixed(1)}</priority>`,
      '  </url>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urlEntries,
    '</urlset>',
    '', // trailing newline
  ].join('\n');
}

const xml = buildSitemap(ROUTES);
fs.writeFileSync(SITEMAP_OUT, xml, 'utf8');

const count = ROUTES.filter(r => r.inSitemap !== false).length;
console.log(`✅ Wrote ${SITEMAP_OUT} (${count} URLs)`);

// Print a quick summary
ROUTES.filter(r => r.inSitemap !== false).forEach(r => {
  console.log(`   ${r.priority.toFixed(1)}  ${fileDate(r.file)}  ${r.url}`);
});
