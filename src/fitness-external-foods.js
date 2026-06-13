// External food data sources: Open Food Facts (free, groceries) and
// Nutritionix (API-key, restaurants + branded). Both return a normalized
// food object shape ready to be imported into the local `foods` table.

const TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds per query — OFF/Nutritionix have rate limits
const cache = new Map(); // key → { data, expires }

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.expires) { cache.delete(key); return null; }
  return v.data;
}
function cacheSet(key, data) {
  // Simple LRU-ish cap
  if (cache.size > 200) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

async function fetchJson(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return null;
    const text = await res.text();
    // OFF sometimes returns HTML when rate-limited
    if (text.trim().startsWith('<')) return null;
    return JSON.parse(text);
  } catch (err) {
    return null;
  } finally {
    clearTimeout(to);
  }
}

// Normalize numeric value — round floats to 1 decimal, null if not finite
function round1(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

// Normalize + expand query into variant forms. Works around OFF's/FTS's
// aggressive word-boundary matching that makes "dave's" vs "daves" vs "dave"
// behave inconsistently. Returns an array of distinct queries to try.
function queryVariants(query) {
  const base = query.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return [];
  const tokens = base.split(' ').filter(Boolean);
  const variants = new Set([base]);

  // For each token, toggle trailing 's' to catch plural/singular + brand-name variants
  for (let i = 0; i < tokens.length; i++) {
    const alt = tokens[i].length >= 3
      ? (tokens[i].endsWith('s') ? tokens[i].slice(0, -1) : tokens[i] + 's')
      : null;
    if (!alt) continue;
    const copy = [...tokens];
    copy[i] = alt;
    variants.add(copy.join(' '));
  }
  // Also: "all variants at once" — toggle 's' on every applicable token
  const allFlipped = tokens.map(t => {
    if (t.length < 3) return t;
    return t.endsWith('s') ? t.slice(0, -1) : t + 's';
  });
  variants.add(allFlipped.join(' '));

  return [...variants];
}

// ============ Open Food Facts ============
// Docs: https://openfoodfacts.github.io/openfoodfacts-server/api/
async function searchOpenFoodFacts(query, limit = 10) {
  if (!query || query.trim().length < 2) return [];
  const key = 'off:' + query.toLowerCase();
  const cached = cacheGet(key);
  if (cached) return cached.slice(0, limit);

  // Try multiple query variants in parallel, merge + dedupe
  const variants = queryVariants(query);
  const responses = await Promise.all(variants.map(v => fetchOFFOnce(v, Math.min(limit * 2, 15))));
  const merged = [];
  const seen = new Set();
  for (const list of responses) {
    for (const item of list) {
      if (!item.external_id || seen.has(item.external_id)) continue;
      seen.add(item.external_id);
      merged.push(item);
    }
  }
  cacheSet(key, merged);
  return merged.slice(0, limit);
}

async function fetchOFFOnce(query, pageSize) {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=${pageSize}&fields=code,product_name,product_name_en,brands,nutriments,serving_size,serving_quantity`;
  const data = await fetchJson(url, {
    headers: { 'User-Agent': 'neural-nexus-fitness/1.0 (self-hosted, personal)' }
  });
  if (!data || !Array.isArray(data.products)) return [];

  return data.products
    .map(p => {
      const name = (p.product_name || p.product_name_en || '').trim();
      if (!name) return null;
      const n = p.nutriments || {};
      // OFF provides per-100g values with the _100g suffix
      const cals100 = n['energy-kcal_100g'] ?? n['energy-kcal'];
      const prot100 = n['proteins_100g'];
      const carbs100 = n['carbohydrates_100g'];
      const fat100 = n['fat_100g'];
      if (cals100 == null && prot100 == null && carbs100 == null && fat100 == null) return null;

      // Default serving — use serving_quantity (grams) if sensible, else 100g.
      // Critical: serving_desc and serving_g must always agree. If they disagree
      // (e.g. desc "30 g" but basis 100 g) the row silently shows per-100g macros
      // under a 30 g label, and import persists those wrong macros forever.
      let serving_g = 100;
      let serving_desc = '100 g';
      const sq = Number(p.serving_quantity);
      if (Number.isFinite(sq) && sq >= 5 && sq <= 1000) {
        serving_g = sq;
        serving_desc = p.serving_size || `${Math.round(sq)} g`;
      } else if (p.serving_size) {
        // No usable serving_quantity, but there's a free-text serving size. Try to
        // parse a gram/ml weight out of it; only then can we trust the label.
        const gm = String(p.serving_size).match(/(\d+(?:\.\d+)?)\s*(g|ml)\b/i);
        const parsedG = gm ? Number(gm[1]) : NaN;
        if (Number.isFinite(parsedG) && parsedG >= 5 && parsedG <= 1000) {
          serving_g = parsedG;
          serving_desc = p.serving_size;
        }
        // else: keep the honest 100 g basis + '100 g' label rather than mislabel.
      }

      return {
        source: 'openfoodfacts',
        external_id: p.code ? `off:${p.code}` : null,
        name: p.brands ? `${name} (${p.brands.split(',')[0].trim()})` : name,
        category: 'branded',
        serving_description: serving_desc,
        serving_size_g: serving_g,
        calories_per_100g: round1(cals100),
        protein_per_100g: round1(prot100),
        carbs_per_100g: round1(carbs100),
        fat_per_100g: round1(fat100)
      };
    })
    .filter(Boolean);
}

// ============ Nutritionix ============
// Docs: https://docs.google.com/document/d/1_q-K-ObMTZvO0qUEAxROrN3bwMujwAN25sLHwJzliK0
// Free tier: 200 req/day. Env vars: NUTRITIONIX_APP_ID, NUTRITIONIX_APP_KEY
function isNutritionixConfigured() {
  return Boolean(process.env.NUTRITIONIX_APP_ID && process.env.NUTRITIONIX_APP_KEY);
}

async function searchNutritionix(query, limit = 10) {
  if (!isNutritionixConfigured()) return [];
  if (!query || query.trim().length < 2) return [];

  const key = 'nix:' + query.toLowerCase();
  const cached = cacheGet(key);
  if (cached) return cached.slice(0, limit);

  // /v2/search/instant returns branded + common foods; branded includes restaurants (brand_type=2)
  const url = `https://trackapi.nutritionix.com/v2/search/instant?query=${encodeURIComponent(query)}&branded=true&common=false&detailed=true`;
  const data = await fetchJson(url, {
    headers: {
      'x-app-id': process.env.NUTRITIONIX_APP_ID,
      'x-app-key': process.env.NUTRITIONIX_APP_KEY
    }
  });
  if (!data) return [];

  // Restaurants (brand_type=2) vs branded grocery (brand_type=1). Prefer restaurant-first ordering.
  const branded = (data.branded || []).slice(0, limit * 2);
  const results = branded
    .map(b => {
      if (!b.food_name || b.nf_calories == null) return null;
      const isRestaurant = b.brand_type === 2;
      // nf_* values are per the listed serving. If we know the serving's gram weight
      // we can express per-100g; if not, treat the serving itself as the basis
      // (scale=1) so the displayed per-serving macros stay correct, and guard
      // against a zero/negative weight producing a bad scale.
      const rawG = Number(b.serving_weight_grams);
      const hasGrams = Number.isFinite(rawG) && rawG > 0;
      const servingG = hasGrams ? rawG : 100;
      const scale = hasGrams ? 100 / servingG : 1;
      return {
        source: 'nutritionix',
        external_id: `nix:${b.nix_item_id || b.nix_brand_id || b.food_name}`,
        name: b.brand_name ? `${b.food_name} (${b.brand_name})` : b.food_name,
        category: isRestaurant ? 'restaurant' : 'branded',
        serving_description: b.serving_qty && b.serving_unit ? `${b.serving_qty} ${b.serving_unit}` : `${servingG} g`,
        serving_size_g: servingG,
        calories_per_100g: round1(b.nf_calories * scale),
        protein_per_100g: round1((b.nf_protein || 0) * scale),
        carbs_per_100g: round1((b.nf_total_carbohydrate || 0) * scale),
        fat_per_100g: round1((b.nf_total_fat || 0) * scale)
      };
    })
    .filter(Boolean);

  // Restaurant items first (they're what Nutritionix uniquely provides)
  results.sort((a, b) => {
    if (a.category === 'restaurant' && b.category !== 'restaurant') return -1;
    if (b.category === 'restaurant' && a.category !== 'restaurant') return 1;
    return 0;
  });

  cacheSet(key, results);
  return results.slice(0, limit);
}

module.exports = { searchOpenFoodFacts, searchNutritionix, isNutritionixConfigured, queryVariants };
