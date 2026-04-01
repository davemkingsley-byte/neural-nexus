#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');

const FEED_URL = 'https://blog.neuralnexus.press/feed';
const DATA_DIR = path.join(__dirname, '..', 'data');
const ARTICLES_PATH = path.join(DATA_DIR, 'articles.json');
const OVERRIDES_PATH = path.join(DATA_DIR, 'articles-overrides.json');

function decodeHtml(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8230;/g, '…')
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTagValue(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'));
  return match ? decodeHtml(match[1]) : '';
}

function getEnclosureUrl(xml) {
  const match = xml.match(/<enclosure\b[^>]*url="([^"]+)"[^>]*>/i);
  return match ? decodeHtml(match[1]) : '';
}

function getIdFromUrl(urlString) {
  try {
    const pathname = new URL(urlString).pathname.replace(/\/$/, '');
    const parts = pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; NeuralNexusSync/1.0; +https://www.neuralnexus.press)'
      }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(res.headers.location));
      }

      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`Feed request failed with status ${res.statusCode || 'unknown'}`));
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function main() {
  const overrides = fs.existsSync(OVERRIDES_PATH)
    ? JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'))
    : {};

  try {
    const xml = await fetchText(FEED_URL);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);

    const articles = items
      .map((item) => {
        const url = getTagValue(item, 'link');
        const id = getIdFromUrl(url);
        if (!id || !url) return null;

        const pubDate = getTagValue(item, 'pubDate');
        const parsedDate = pubDate ? new Date(pubDate) : null;
        const article = {
          id,
          title: getTagValue(item, 'title'),
          description: getTagValue(item, 'description'),
          url,
          date: parsedDate && !Number.isNaN(parsedDate.getTime())
            ? parsedDate.toISOString().slice(0, 10)
            : '',
          topics: [],
          type: 'deep-dive',
          thumbnail: getEnclosureUrl(item)
        };

        return {
          ...article,
          ...(overrides[id] || {})
        };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    fs.writeFileSync(ARTICLES_PATH, `${JSON.stringify(articles, null, 2)}\n`);
    console.log(`Synced ${articles.length} articles to ${ARTICLES_PATH}`);
  } catch (error) {
    console.error(`[sync-articles] ${error.message}`);
    if (fs.existsSync(ARTICLES_PATH)) {
      console.error('[sync-articles] Keeping existing data/articles.json');
      return;
    }
    process.exitCode = 1;
  }
}

main();
