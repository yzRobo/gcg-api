// src/cli.js — scrape all packages, normalize, sanity-check, write artifacts.
const fs = require('fs');
const path = require('path');
const GundamScraper = require('./scraper');
const { normalizeCard } = require('./normalize');
const { assertScrapingAllowed } = require('./robots'); // rider 3: robots.txt precheck

const OUT = path.join(__dirname, '..', 'data');
const VERSION = process.env.DATASET_VERSION || new Date().toISOString().slice(0, 10); // set in CI

async function main() {
  const scraper = new GundamScraper();

  // rider 3 (M0 go/no-go): honor robots.txt if one ever appears. 404 today → proceeds.
  await assertScrapingAllowed(scraper.baseUrl, scraper.headers['User-Agent']);

  const packages = await scraper.getPackages();
  if (packages.length === 0) throw new Error('SANITY: no packages found — site markup likely changed');
  console.log(`Found ${packages.length} packages`);

  const byId = new Map();
  const rulingsByKey = new Map();
  const setIndex = [];
  for (const pkg of packages) {
    const raw = await scraper.scrapePackage(pkg, {
      onProgress: (d, t) => process.stdout.write(`\r  ${pkg.code || pkg.name}: ${d}/${t}   `)
    });
    process.stdout.write('\n');
    let count = 0;
    for (const rc of raw) {
      if (rc.product_id && !byId.has(rc.product_id)) { byId.set(rc.product_id, normalizeCard(rc, pkg)); count++; }
      for (const r of (rc.rulings || [])) {                       // link-only rulings, deduped per card_number
        const key = `${rc.card_number}|${r.num}`;
        if (!rulingsByKey.has(key)) rulingsByKey.set(key, { card_number: rc.card_number, num: r.num, date: r.date, question: r.question, source_url: rc.detail_url });
      }
    }
    setIndex.push({ set_code: pkg.code || null, set_name: pkg.name.replace(/\s*\[[^\]]*\]\s*$/, '').trim(), card_count: count });
  }

  const cards = [...byId.values()];
  const rulings = [...rulingsByKey.values()];

  // ---- SANITY GATE (abort before writing anything if these fail) ----
  if (cards.length < 1000) throw new Error(`SANITY: only ${cards.length} cards (<1000) — probable scrape failure`);
  const blankNames = cards.filter(c => !c.name).length;
  if (blankNames > cards.length * 0.02) throw new Error(`SANITY: ${blankNames} blank names — selector likely broke`);
  // Card-type-aware: UNITs must have AP/HP; only assert on the fields a type actually has.
  const unitsMissingStats = cards.filter(c => /UNIT/i.test(c.card_type) && !/TOKEN/i.test(c.card_type) && (c.ap == null || c.hp == null)).length;
  if (unitsMissingStats > cards.length * 0.05) throw new Error(`SANITY: ${unitsMissingStats} UNITs missing AP/HP — stat labels likely changed`);
  // M5: structured keyword/timing extraction must be producing data (guards a silent effect-selector break).
  const cardsWithKeywords = cards.filter(c => (c.keyword_effects && c.keyword_effects.length) || (c.timing_markers && c.timing_markers.length)).length;
  if (cardsWithKeywords < cards.length * 0.3) throw new Error(`SANITY: only ${cardsWithKeywords} cards have keyword/timing data (<30%) — effect parsing likely broke`);
  const badTypeSep = cards.filter(c => /[・･]/.test(c.card_type)).length;
  if (badTypeSep > 0) throw new Error(`SANITY: ${badTypeSep} cards still have a fullwidth-dot card_type separator — normalizeType broke`);
  console.log(`Sanity OK: ${cards.length} cards across ${setIndex.length} sets, ${rulings.length} rulings`);

  // ---- Write artifacts ----
  fs.mkdirSync(path.join(OUT, 'cards', 'en'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'sets', 'en'), { recursive: true });

  // Bulk NDJSON (one card per line)
  fs.writeFileSync(path.join(OUT, 'cards.ndjson'), cards.map(c => JSON.stringify(c)).join('\n') + '\n');
  // Bulk JSON
  fs.writeFileSync(path.join(OUT, 'cards.json'), JSON.stringify(cards, null, 0));
  // Per-set JSON (enables small reviewable community PRs)
  const bySet = {};
  for (const c of cards) { const k = (c.set_code || 'MISC').toLowerCase(); (bySet[k] ||= []).push(c); }
  for (const [k, list] of Object.entries(bySet)) fs.writeFileSync(path.join(OUT, 'cards', 'en', `${k}.json`), JSON.stringify(list, null, 0));
  // Sets index
  fs.writeFileSync(path.join(OUT, 'sets', 'en', 'index.json'), JSON.stringify(setIndex, null, 2));
  // Rulings (link-only: num/date/question + source_url; NOT the answer text)
  fs.writeFileSync(path.join(OUT, 'rulings.json'), JSON.stringify(rulings, null, 0));
  // Manifest (consumers read this FIRST — never hardcode file URLs)
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
    schema_version: 1,
    dataset_version: VERSION,
    built_at: new Date().toISOString(),
    card_count: cards.length,
    set_count: setIndex.length,
    ruling_count: rulings.length,
    files: { bulk_ndjson: 'data/cards.ndjson', bulk_json: 'data/cards.json', sets: 'data/sets/en/index.json', rulings: 'data/rulings.json' },
    disclaimer: 'Not affiliated with Bandai. Gundam and card images are copyright Bandai.'
  }, null, 2));

  console.log('Wrote data/ artifacts.');
}

main().catch(e => { console.error(e); process.exit(1); }); // non-zero exit fails the CI job loudly
