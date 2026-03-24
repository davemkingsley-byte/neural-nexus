const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function fetchPage(url, timeout = 10000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, html: body }));
      res.on('error', () => resolve({ status: 'error', html: '' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'error', html: '' }); });
    req.on('error', () => resolve({ status: 'error', html: '' }));
  });
}

function analyzePage(url, status, html) {
  const issues = [];

  // Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const titleLength = title.length;
  if (!title) issues.push('Missing title tag');
  else if (titleLength > 60) issues.push('Title too long (' + titleLength + ' chars)');

  // Meta description
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i)
    || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
  const description = descMatch ? descMatch[1] : '';
  const hasDescription = description.length > 0;
  const descriptionLength = description.length;
  if (!hasDescription) issues.push('Missing meta description');
  else if (descriptionLength > 160) issues.push('Meta description too long (' + descriptionLength + ' chars)');

  // Canonical
  const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*>/i);
  const hasCanonical = !!canonicalMatch;
  if (!hasCanonical) issues.push('Missing canonical link');

  // H1 count
  const h1Matches = html.match(/<h1[\s>]/gi);
  const h1Count = h1Matches ? h1Matches.length : 0;
  if (h1Count === 0) issues.push('Missing H1 tag');
  else if (h1Count > 1) issues.push('Multiple H1 tags (' + h1Count + ')');

  // Word count
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyText = bodyMatch ? bodyMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  // Links
  const linkRegex = /<a[^>]*href=["']([^"']*)["'][^>]*>/gi;
  let internalLinks = 0, externalLinks = 0, linkMatch;
  const urlObj = new URL(url);
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const href = linkMatch[1];
    if (href.startsWith('http') && !href.includes(urlObj.hostname)) externalLinks++;
    else internalLinks++;
  }

  // Images
  const imgRegex = /<img[^>]*>/gi;
  let imageCount = 0, imagesMissingAlt = 0, imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    imageCount++;
    if (!/alt=["'][^"']+["']/i.test(imgMatch[0])) imagesMissingAlt++;
  }

  // OG tags
  const hasOG = /<meta[^>]*property=["']og:/i.test(html);
  if (!hasOG) issues.push('Missing Open Graph tags');

  // Score
  let score = 100;
  if (status !== 200) { score -= 15; issues.unshift('HTTP status: ' + status); }
  if (!title) score -= 10;
  if (title && titleLength > 60) score -= 5;
  if (!hasDescription) score -= 10;
  if (hasDescription && descriptionLength > 160) score -= 5;
  if (!hasCanonical) score -= 5;
  if (h1Count !== 1) score -= 10;
  if (imagesMissingAlt > 0) { score -= 5; issues.push(imagesMissingAlt + ' images missing alt text'); }
  if (!hasOG) score -= 5;
  if (score < 0) score = 0;

  return {
    url, status, issues, title, titleLength,
    hasDescription, descriptionLength, hasCanonical,
    h1Count, wordCount, internalLinks, externalLinks,
    imageCount, imagesMissingAlt, hasOG, score
  };
}

async function generateSEOReport() {
  const sitemapPath = path.join(__dirname, '..', 'public', 'sitemap.xml');
  const sitemap = fs.readFileSync(sitemapPath, 'utf8');
  const urlRegex = /<loc>(.*?)<\/loc>/g;
  const urls = [];
  let m;
  while ((m = urlRegex.exec(sitemap)) !== null) urls.push(m[1]);

  const pages = [];
  for (const url of urls) {
    try {
      const { status, html } = await fetchPage(url);
      if (status === 'error') {
        pages.push({ url, status: 'error', issues: ['Fetch failed'], title: '', titleLength: 0, hasDescription: false, descriptionLength: 0, hasCanonical: false, h1Count: 0, wordCount: 0, internalLinks: 0, externalLinks: 0, imageCount: 0, imagesMissingAlt: 0, hasOG: false, score: 0 });
      } else {
        pages.push(analyzePage(url, status, html));
      }
    } catch (err) {
      pages.push({ url, status: 'error', issues: ['Fetch error: ' + err.message], title: '', titleLength: 0, hasDescription: false, descriptionLength: 0, hasCanonical: false, h1Count: 0, wordCount: 0, internalLinks: 0, externalLinks: 0, imageCount: 0, imagesMissingAlt: 0, hasOG: false, score: 0 });
    }
  }

  const now = new Date();
  const statusCounts = {};
  let pagesWithIssues = 0;
  const issueCounts = {};

  for (const p of pages) {
    const s = String(p.status);
    statusCounts[s] = (statusCounts[s] || 0) + 1;
    if (p.issues.length > 0) pagesWithIssues++;
    for (const issue of p.issues) {
      const key = issue.replace(/\(\d+ chars\)/, '').replace(/\(\d+\)/, '').trim();
      issueCounts[key] = (issueCounts[key] || 0) + 1;
    }
  }

  const topIssues = Object.entries(issueCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([issue, count]) => ({ issue, count }));

  const overallScore = pages.length > 0
    ? Math.round(pages.reduce((sum, p) => sum + p.score, 0) / pages.length)
    : 0;

  // ISO week calculation
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  const weekOf = d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');

  return {
    totalPages: pages.length,
    pagesWithIssues,
    statusCounts,
    topIssues,
    overallScore,
    generatedAt: now.toISOString(),
    weekOf,
    pages
  };
}

module.exports = { generateSEOReport };
