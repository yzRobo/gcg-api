// src/cli.js - scrape all packages, normalize, sanity-check, write artifacts.
const fs = require('fs');
const path = require('path');
const GundamScraper = require('./scraper');
const { normalizeCard } = require('./normalize');
const { assertScrapingAllowed } = require('./robots'); // rider 3: robots.txt precheck
const { applyErrataToRaw, finalizeErrata } = require('./errata'); // official card corrections

const OUT = path.join(__dirname, '..', 'data');
const VERSION = process.env.DATASET_VERSION || new Date().toISOString().slice(0, 10); // set in CI

async function main() {
  const scraper = new GundamScraper();

  // rider 3 (M0 go/no-go): honor robots.txt if one ever appears. 404 today → proceeds.
  await assertScrapingAllowed(scraper.baseUrl, scraper.headers['User-Agent']);

  const packages = await scraper.getPackages();
  if (packages.length === 0) throw new Error('SANITY: no packages found - site markup likely changed');
  console.log(`Found ${packages.length} packages`);

  const byId = new Map();
  const rulingsByKey = new Map();
  const errataTally = new Map();   // errata entry -> { applied, upstream_fixed, miss, samples }
  const setIndex = [];
  for (const pkg of packages) {
    const raw = await scraper.scrapePackage(pkg, {
      onProgress: (d, t) => process.stdout.write(`\r  ${pkg.code || pkg.name}: ${d}/${t}   `)
    });
    process.stdout.write('\n');
    let count = 0;
    for (const rc of raw) {
      // Apply official errata to the RAW record BEFORE normalizeCard. Normalize derives
      // traits[] from trait and keyword_effects/timing_markers/keywords_text from effect,
      // so patching after normalization would leave those derived fields stale.
      for (const o of applyErrataToRaw(rc)) {
        const t = errataTally.get(o.entry) || { applied: 0, upstream_fixed: 0, miss: 0, samples: [] };
        t[o.outcome]++;
        if (o.outcome === 'miss') t.samples.push(o.current);
        errataTally.set(o.entry, t);
      }
      if (rc.product_id && !byId.has(rc.product_id)) { byId.set(rc.product_id, normalizeCard(rc, pkg)); count++; }
      for (const r of (rc.rulings || [])) {                       // rulings deduped per card_number (alt-art printings share a FAQ)
        const key = `${rc.card_number}|${r.num}`;
        if (!rulingsByKey.has(key)) rulingsByKey.set(key, { card_number: rc.card_number, num: r.num, date: r.date, question: r.question, answer: r.answer || '', source_url: rc.detail_url });
      }
    }
    setIndex.push({ set_code: pkg.code || null, set_name: pkg.name.replace(/\s*\[[^\]]*\]\s*$/, '').trim(), card_count: count });
  }

  const cards = [...byId.values()];
  const rulings = [...rulingsByKey.values()];

  // ---- SANITY GATE (abort before writing anything if these fail) ----
  if (cards.length < 1000) throw new Error(`SANITY: only ${cards.length} cards (<1000) - probable scrape failure`);
  const blankNames = cards.filter(c => !c.name).length;
  if (blankNames > cards.length * 0.02) throw new Error(`SANITY: ${blankNames} blank names - selector likely broke`);
  // Card-type-aware: UNITs must have AP/HP; only assert on the fields a type actually has.
  const unitsMissingStats = cards.filter(c => /UNIT/i.test(c.card_type) && !/TOKEN/i.test(c.card_type) && (c.ap == null || c.hp == null)).length;
  if (unitsMissingStats > cards.length * 0.05) throw new Error(`SANITY: ${unitsMissingStats} UNITs missing AP/HP - stat labels likely changed`);
  // M5: structured keyword/timing extraction must be producing data (guards a silent effect-selector break).
  const cardsWithKeywords = cards.filter(c => (c.keyword_effects && c.keyword_effects.length) || (c.timing_markers && c.timing_markers.length)).length;
  if (cardsWithKeywords < cards.length * 0.3) throw new Error(`SANITY: only ${cardsWithKeywords} cards have keyword/timing data (<30%) - effect parsing likely broke`);
  const badTypeSep = cards.filter(c => /[・･]/.test(c.card_type)).length;
  if (badTypeSep > 0) throw new Error(`SANITY: ${badTypeSep} cards still have a fullwidth-dot card_type separator - normalizeType broke`);
  // Answer prose must actually be landing. Without this, a .qaColAnswer selector break would
  // silently republish every ruling with an empty answer and the run would still go green.
  if (rulings.length > 0) {
    const rulingsWithAnswer = rulings.filter(r => r.answer && r.answer.length).length;
    if (rulingsWithAnswer < rulings.length * 0.9) {
      throw new Error(`SANITY: only ${rulingsWithAnswer}/${rulings.length} rulings have answer text (<90%) - .qaColAnswer selector likely broke`);
    }
  }
  // Errata gate. Deliberately CRITICAL, not supplementary: applying a correction to text
  // that has changed underneath us silently corrupts card data, which is the one thing
  // errata handling exists to prevent. Throws on a miss, on an unknown card, or on
  // printings of one card disagreeing about whether the fix is needed.
  const errata = finalizeErrata(errataTally);
  console.log(`Sanity OK: ${cards.length} cards across ${setIndex.length} sets, ${rulings.length} rulings, ${errata.length} errata`);

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
  // Rulings (num/date/question/answer + source_url back to the official page)
  fs.writeFileSync(path.join(OUT, 'rulings.json'), JSON.stringify(rulings, null, 0));
  // Errata ledger. The corrections are ALREADY baked into the card records above; this
  // file is the audit trail showing what was changed, from what, and on whose authority.
  fs.writeFileSync(path.join(OUT, 'errata.json'), JSON.stringify(errata, null, 1));

  // Rule-level FAQ (SUPPLEMENTARY: same posture as products - a failure here must NEVER
  // abort or degrade the card refresh. Cards + rulings are already written above).
  // This is the "how does this mechanic work" corpus off the FAQ hub's category listings,
  // as opposed to the per-card rulings written above. See src/faq-scraper.js.
  const rulesFaqPath = path.join(OUT, 'rules-faq.json');
  let rulesFaq = null;
  try {
    const { scrapeRulesFaq } = require('./faq-scraper');
    rulesFaq = await scrapeRulesFaq();
  } catch (err) {
    console.error('Rule FAQ scrape FAILED (supplementary; continuing):', err && err.message);
    rulesFaq = null;
  }
  {
    let existing = 0;
    try { if (fs.existsSync(rulesFaqPath)) existing = JSON.parse(fs.readFileSync(rulesFaqPath, 'utf8')).length; } catch (_) {}
    if (rulesFaq && rulesFaq.length > 0) {
      const withAnswer = rulesFaq.filter(f => f.answer && f.answer.length).length;
      // Shrink-guard: a partial sweep (some categories 500'd, or the hub listed fewer)
      // must not overwrite a much larger committed file. Same >25% rule as products.
      if (existing > 0 && rulesFaq.length < existing * 0.75) {
        console.warn(`WARNING: rule FAQ scrape yielded ${rulesFaq.length} but existing rules-faq.json has ${existing} rows (>25% drop) - KEEPING existing file (shrink-guard).`);
      } else if (withAnswer < rulesFaq.length * 0.9) {
        // Answer-coverage guard: mirrors the rulings gate. An empty-answer sweep is a
        // selector break, and republishing it would look successful.
        console.warn(`WARNING: only ${withAnswer}/${rulesFaq.length} rule FAQ entries have answer text (<90%) - KEEPING existing file (.faqResult_answer likely broke).`);
      } else {
        fs.writeFileSync(rulesFaqPath, JSON.stringify(rulesFaq, null, 0));
        console.log(`Wrote rules-faq.json (${rulesFaq.length} entries, ${withAnswer} with answers)`);
      }
    } else if (existing > 0) {
      // Zero-guard (mandatory): a 0-entry scrape must NOT wipe an existing dataset.
      console.warn(`WARNING: rule FAQ scrape yielded 0 but existing rules-faq.json has ${existing} rows - KEEPING existing file (zero-guard).`);
    } else {
      console.warn('WARNING: rule FAQ scrape yielded 0 and no existing rules-faq.json - writing empty array.');
      fs.writeFileSync(rulesFaqPath, JSON.stringify([], null, 0));
    }
  }
  let rulesFaqCount = 0;
  try { if (fs.existsSync(rulesFaqPath)) rulesFaqCount = JSON.parse(fs.readFileSync(rulesFaqPath, 'utf8')).length; } catch (_) {}

  // Products (SUPPLEMENTARY: a failure here must NEVER abort or degrade the card refresh).
  // Cards + rulings are already written above, so anything below is safe to fail.
  const productsPath = path.join(OUT, 'products.json');
  let products = null;
  try {
    const { scrapeProducts } = require('./products-scraper');
    products = await scrapeProducts();
  } catch (err) {
    console.error('Products scrape FAILED (supplementary; continuing):', err && err.message);
    products = null;
  }
  if (products && products.length > 0) {
    let existing = 0;
    try { if (fs.existsSync(productsPath)) existing = JSON.parse(fs.readFileSync(productsPath, 'utf8')).length; } catch (_) {}
    // Shrink-guard: a "clean" but TRUNCATED sweep (e.g. the pager markup breaks so only page 1's
    // 12 items are fetched - all unique, so the scraper's dup-free check reads it as complete)
    // must not overwrite a much larger committed file. A real delisting is small (40->39); a
    // pager collapse is large. Keep the existing file on a >25% drop (same posture as the zero-guard).
    if (existing > 0 && products.length < existing * 0.75) {
      console.warn(`WARNING: products scrape yielded ${products.length} but existing products.json has ${existing} rows (>25% drop) - KEEPING existing file (shrink-guard; likely a partial/pager-collapsed scrape).`);
    } else {
      if (products.length < 10) console.warn(`WARNING: only ${products.length} products (baseline ~44-48) - possible partial scrape`);
      fs.writeFileSync(productsPath, JSON.stringify(products, null, 0));
      console.log(`Wrote products.json (${products.length} products)`);
    }
  } else {
    // Zero-guard (mandatory): a 0-product scrape (likely a selector break) must NOT wipe an
    // existing dataset wholesale. Keep the committed file if it has rows.
    let existing = 0;
    try { if (fs.existsSync(productsPath)) existing = JSON.parse(fs.readFileSync(productsPath, 'utf8')).length; } catch (_) {}
    if (existing > 0) console.warn(`WARNING: products scrape yielded 0 but existing products.json has ${existing} rows - KEEPING existing file (zero-guard).`);
    else { console.warn('WARNING: products scrape yielded 0 and no existing products.json - writing empty array.'); fs.writeFileSync(productsPath, JSON.stringify([], null, 0)); }
  }
  let productCount = 0;
  try { if (fs.existsSync(productsPath)) productCount = JSON.parse(fs.readFileSync(productsPath, 'utf8')).length; } catch (_) {}

  // Manifest (consumers read this FIRST - never hardcode file URLs)
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
    schema_version: 1,
    dataset_version: VERSION,
    built_at: new Date().toISOString(),
    card_count: cards.length,
    set_count: setIndex.length,
    ruling_count: rulings.length,
    rules_faq_count: rulesFaqCount,
    errata_count: errata.length,
    product_count: productCount,
    files: { bulk_ndjson: 'data/cards.ndjson', bulk_json: 'data/cards.json', sets: 'data/sets/en/index.json', rulings: 'data/rulings.json', rules_faq: 'data/rules-faq.json', errata: 'data/errata.json', products: 'data/products.json' },
    disclaimer: 'Not affiliated with Bandai. Gundam and card images are copyright Bandai.'
  }, null, 2));

  console.log('Wrote data/ artifacts.');
}

main().catch(e => { console.error(e); process.exit(1); }); // non-zero exit fails the CI job loudly
