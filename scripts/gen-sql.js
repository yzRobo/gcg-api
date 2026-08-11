// scripts/gen-sql.js - generate data/import.sql from data/cards.ndjson
const fs = require('fs');
const path = require('path');
const { buildSetIndex } = require('../src/sets');
const cards = fs.readFileSync(path.join(__dirname,'..','data','cards.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
const cols = ['product_id','card_number','name','set_code','set_name','rarity','card_type','color','level','cost','ap','hp','zone','trait','link','source_title','block_icon','sp','effect','image_url','detail_url','ap_raw','hp_raw','where_to_get','traits','link_refs','keyword_effects','timing_markers','keywords_text'];
const JSON_COLS = new Set(['traits','link_refs','keyword_effects','timing_markers']); // stored as JSON-in-TEXT
const cell = (c, k) => JSON_COLS.has(k) ? JSON.stringify(c[k] || []) : c[k];
const esc = (v) => v == null ? 'NULL' : (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g,"''")}'`);
let sql = 'DELETE FROM cards;\n';
for (let i = 0; i < cards.length; i += 40) {                     // 40 rows per INSERT - D1 caps a single SQL statement at ~100 KB; effect + new JSON columns add up
  const chunk = cards.slice(i, i + 40);
  sql += `INSERT INTO cards (${cols.join(',')}) VALUES\n` +
    chunk.map(c => `(${cols.map(k => esc(cell(c, k))).join(',')})`).join(',\n') + ';\n';
}
// Precomputed summaries so /v1/manifest and /v1/sets are O(1) meta reads instead of
// full-table COUNT/GROUP BY scans on every cache miss (D1 free-tier read-budget guard).
// Canonical set_name = the MOST COMMON name for that set_code. A set_code (e.g. GD01)
// contains its main-package cards (set_name "Newtype Rising") plus promo cards that share
// the GD01-### numbering but carry the generic promo package name ("Promotion card").
// The main package always dominates by count, so mode picks the real name - unlike SQL
// MAX(set_name), which wrongly picks "Promotion card" for sets whose name sorts before it.
// Shared with cli.js via src/sets.js so the published index and this summary CANNOT drift
// apart again - two separate implementations is what produced the null-set_code bug.
const setsSummary = buildSetIndex(cards);
const rulingsPath = path.join(__dirname,'..','data','rulings.json');
const rulings = fs.existsSync(rulingsPath) ? JSON.parse(fs.readFileSync(rulingsPath,'utf8')) : [];
// Products are SUPPLEMENTARY: an absent/empty products.json must NOT wipe the D1 products
// table wholesale (the cli.js zero-guard keeps the file populated; this is the same guard at
// the SQL layer). When present, they are replaced wholesale like cards + rulings.
const productsPath = path.join(__dirname,'..','data','products.json');
const products = fs.existsSync(productsPath) ? JSON.parse(fs.readFileSync(productsPath,'utf8')) : [];
// Rule-level FAQ is SUPPLEMENTARY too: same guard as products, an empty/missing file must
// leave the existing rules_faq table alone rather than emit a bare DELETE/DROP.
const rulesFaqPath = path.join(__dirname,'..','data','rules-faq.json');
const rulesFaq = fs.existsSync(rulesFaqPath) ? JSON.parse(fs.readFileSync(rulesFaqPath,'utf8')) : [];
// Errata is CRITICAL-path (cli.js throws rather than writing a partial file), so unlike
// products/rules-faq it needs no zero-guard: an empty file genuinely means zero errata.
const errataPath = path.join(__dirname,'..','data','errata.json');
const errata = fs.existsSync(errataPath) ? JSON.parse(fs.readFileSync(errataPath,'utf8')) : [];
const metaRows = [
  ['dataset_version', process.env.DATASET_VERSION || new Date().toISOString().slice(0,10)],
  ['card_count', String(cards.length)],
  ['ruling_count', String(rulings.length)],
  ['sets_summary', JSON.stringify(setsSummary)]
];
// rules_faq_count backs /v1/manifest. Written only when entries exist, consistent with the
// product_count guard below (the ruling_count lesson: a manifest claim must be backed by a row).
if (rulesFaq.length > 0) metaRows.push(['rules_faq_count', String(rulesFaq.length)]);
metaRows.push(['errata_count', String(errata.length)]);   // unconditional: critical-path, always accurate
// product_count meta backs /v1/manifest (the ruling_count lesson: the manifest claim must be
// backed by a meta row). Only written when products exist, to stay consistent with the guard
// below that leaves the products table untouched on an empty file.
if (products.length > 0) metaRows.push(['product_count', String(products.length)]);
for (const [k, v] of metaRows) {
  sql += `INSERT INTO meta (key,value) VALUES ('${k}',${esc(v)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;\n`;
}
// Rulings table (separate; replaced wholesale each run). rulings loaded above.
// DROP + CREATE rather than DELETE: rulings are replaced in full every run anyway, so
// recreating the table makes an added column (e.g. `answer`, 2026-08-10) reach an existing
// remote D1 without a hand-run ALTER. Keep this CREATE in sync with schema.sql.
const rcols = ['card_number','num','date','question','answer','source_url'];
sql += 'DROP TABLE IF EXISTS rulings;\n';
sql += `CREATE TABLE rulings (\n  card_number TEXT,\n  num         TEXT,\n  date        TEXT,\n  question    TEXT,\n  answer      TEXT,\n  source_url  TEXT\n);\n`;
sql += 'CREATE INDEX IF NOT EXISTS idx_rulings_card ON rulings(card_number);\n';
for (let i = 0; i < rulings.length; i += 100) {
  const chunk = rulings.slice(i, i + 100);
  sql += `INSERT INTO rulings (${rcols.join(',')}) VALUES\n` +
    chunk.map(r => `(${rcols.map(k => esc(r[k])).join(',')})`).join(',\n') + ';\n';
}
// Errata table (separate; audit trail - the corrections are already baked into `cards`).
// Unconditional DROP+CREATE like rulings: errata.json is produced by a CRITICAL gate that
// throws rather than emitting a partial file, so an empty file means genuinely zero errata.
// `before`/`after` are reserved-ish words in SQL, hence the _text column names.
{
  const ecols = ['card_number','name','field','before_text','after_text','date','source_url','note','status','printings_affected'];
  sql += 'DROP TABLE IF EXISTS errata;\n';
  sql += `CREATE TABLE errata (\n  card_number        TEXT,\n  name               TEXT,\n  field              TEXT,\n  before_text        TEXT,\n  after_text         TEXT,\n  date               TEXT,\n  source_url         TEXT,\n  note               TEXT,\n  status             TEXT,\n  printings_affected INTEGER\n);\n`;
  sql += 'CREATE INDEX IF NOT EXISTS idx_errata_card ON errata(card_number);\n';
  const rowOf = (e) => ({ ...e, before_text: e.before, after_text: e.after });
  for (let i = 0; i < errata.length; i += 100) {
    const chunk = errata.slice(i, i + 100).map(rowOf);
    if (!chunk.length) break;
    sql += `INSERT INTO errata (${ecols.join(',')}) VALUES\n` +
      chunk.map(r => `(${ecols.map(k => esc(r[k])).join(',')})`).join(',\n') + ';\n';
  }
}

// Rule-level FAQ table (separate; supplementary, replaced wholesale each run). Guarded on
// rulesFaq.length > 0 so an empty/missing rules-faq.json never wipes the table. DROP+CREATE
// keeps the shape in sync with schema.sql without a hand-run ALTER.
if (rulesFaq.length > 0) {
  const fcols = ['num','category','date','date_iso','question','answer','source_url'];
  sql += 'DROP TABLE IF EXISTS rules_faq;\n';
  sql += `CREATE TABLE rules_faq (\n  num        TEXT,\n  category   TEXT,\n  date       TEXT,\n  date_iso   TEXT,\n  question   TEXT,\n  answer     TEXT,\n  source_url TEXT\n);\n`;
  sql += 'CREATE INDEX IF NOT EXISTS idx_rules_faq_category ON rules_faq(category);\n';
  for (let i = 0; i < rulesFaq.length; i += 100) {
    const chunk = rulesFaq.slice(i, i + 100);
    sql += `INSERT INTO rules_faq (${fcols.join(',')}) VALUES\n` +
      chunk.map(r => `(${fcols.map(k => esc(r[k])).join(',')})`).join(',\n') + ';\n';
  }
}

// Products table (separate; supplementary metadata, replaced wholesale each run). Guarded on
// products.length > 0 so an empty/missing products.json never emits a bare DELETE that would
// wipe the table (SQL-layer half of the zero-guard; msrp_value is the only numeric column).
const pcols = ['product_id','name','category_tag','category_label','set_code','release_date','release_date_raw','msrp','msrp_value','contents','image_url','product_url'];
if (products.length > 0) {
  sql += 'DELETE FROM products;\n';
  for (let i = 0; i < products.length; i += 100) {
    const chunk = products.slice(i, i + 100);
    sql += `INSERT INTO products (${pcols.join(',')}) VALUES\n` +
      chunk.map(p => `(${pcols.map(k => esc(p[k])).join(',')})`).join(',\n') + ';\n';
  }
}
// Prune per-key usage counters older than 35 days (usage_daily is otherwise never touched by
// the import - like api_keys - so keys and their history persist across weekly refreshes).
sql += "DELETE FROM usage_daily WHERE day < date('now','-35 day');\n";
fs.writeFileSync(path.join(__dirname,'..','data','import.sql'), sql);
console.log(`Wrote import.sql (${cards.length} rows, ${setsSummary.length} sets, ${rulings.length} rulings, ${rulesFaq.length} rule FAQ, ${errata.length} errata, ${products.length} products)`);
