#!/usr/bin/env node
// Downloads USDA FoodData Central bulk data (SR Legacy + Foundation),
// extracts per-100g macros + common serving portions, and writes a
// trimmed JSON to data/seed/foods-usda.json for the fitness importer.
//
// Run: node scripts/build-foods-db.js
//
// USDA datasets are public (no API key needed). URLs below are the latest
// public releases as of 2025. If USDA publishes newer ones, update these.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const OUTPUT = path.join(__dirname, '..', 'data', 'seed', 'foods-usda.json');
const TMP_DIR = path.join(__dirname, '..', 'data', 'seed', '.tmp-usda');

const DATASETS = [
  {
    name: 'sr-legacy',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
    topKey: 'SRLegacyFoods'
  },
  {
    name: 'foundation',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2025-04-24.zip',
    topKey: 'FoundationFoods'
  }
];

// USDA nutrient IDs
const NUTRIENT_ENERGY = 1008;  // kcal
const NUTRIENT_PROTEIN = 1003;
const NUTRIENT_FAT = 1004;
const NUTRIENT_CARBS = 1005;

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(download(res.headers.location, destPath));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

function processFood(f) {
  if (!f.fdcId || !f.description) return null;
  const nutrients = {};
  for (const n of (f.foodNutrients || [])) {
    const id = n.nutrient?.id;
    if (id === NUTRIENT_ENERGY && n.nutrient.unitName === 'kcal') nutrients.calories = n.amount;
    else if (id === NUTRIENT_PROTEIN) nutrients.protein_g = n.amount;
    else if (id === NUTRIENT_FAT) nutrients.fat_g = n.amount;
    else if (id === NUTRIENT_CARBS) nutrients.carbs_g = n.amount;
  }
  // Skip foods missing core macros
  if (nutrients.calories == null && nutrients.protein_g == null && nutrients.carbs_g == null && nutrients.fat_g == null) return null;

  // Pick a default serving — favor grams or common measures
  let serving_desc = '100 g';
  let serving_g = 100;
  if (Array.isArray(f.foodPortions) && f.foodPortions.length) {
    // Prefer portions with reasonable grams between 10 and 500
    const candidates = f.foodPortions
      .filter(p => p.gramWeight && p.gramWeight >= 10 && p.gramWeight <= 500)
      .sort((a, b) => (a.sequenceNumber || 99) - (b.sequenceNumber || 99));
    if (candidates.length) {
      const p = candidates[0];
      const parts = [];
      if (p.value || p.amount) parts.push(String(p.value || p.amount));
      if (p.modifier && p.modifier !== 'undetermined') parts.push(p.modifier);
      else if (p.measureUnit && p.measureUnit.name && p.measureUnit.name !== 'undetermined') parts.push(p.measureUnit.name);
      if (parts.length) {
        serving_desc = parts.join(' ');
        serving_g = p.gramWeight;
      }
    }
  }

  return {
    fdc_id: f.fdcId,
    name: f.description.trim(),
    category: f.foodCategory?.description || null,
    serving_description: serving_desc,
    serving_size_g: serving_g,
    // Macros stored per 100g (USDA reference); clients multiply by (serving_size_g / 100) for per-serving
    calories_per_100g: nutrients.calories != null ? Math.round(nutrients.calories * 10) / 10 : null,
    protein_per_100g: nutrients.protein_g != null ? Math.round(nutrients.protein_g * 10) / 10 : null,
    carbs_per_100g: nutrients.carbs_g != null ? Math.round(nutrients.carbs_g * 10) / 10 : null,
    fat_per_100g: nutrients.fat_g != null ? Math.round(nutrients.fat_g * 10) / 10 : null,
    source: null
  };
}

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });

  const all = new Map(); // fdc_id → food

  for (const ds of DATASETS) {
    const zipPath = path.join(TMP_DIR, `${ds.name}.zip`);
    if (!fs.existsSync(zipPath)) {
      console.log(`Downloading ${ds.name}...`);
      await download(ds.url, zipPath);
    } else {
      console.log(`${ds.name} zip cached`);
    }

    const listed = execFileSync('unzip', ['-Z', '-1', zipPath]).toString().trim().split('\n');
    const innerJson = listed.find(n => n.endsWith('.json'));
    if (!innerJson) throw new Error(`No JSON inside ${zipPath}`);

    const jsonPath = path.join(TMP_DIR, innerJson);
    if (!fs.existsSync(jsonPath)) {
      execFileSync('unzip', ['-o', '-q', zipPath, '-d', TMP_DIR]);
    }

    console.log(`Parsing ${ds.name}...`);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const foods = parsed[ds.topKey] || [];
    let kept = 0;
    for (const f of foods) {
      const p = processFood(f);
      if (!p) continue;
      p.source = ds.name;
      // Dedup by fdc_id (same food can appear in both datasets)
      if (!all.has(p.fdc_id)) {
        all.set(p.fdc_id, p);
        kept++;
      }
    }
    console.log(`  ${ds.name}: ${foods.length} total → ${kept} with macros (after dedup)`);
  }

  const output = Array.from(all.values()).sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 0));
  const sizeMB = (fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(2);
  console.log(`\nWrote ${output.length} foods → ${OUTPUT} (${sizeMB} MB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
