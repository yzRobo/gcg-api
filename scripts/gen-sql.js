// scripts/gen-sql.js — generate data/import.sql from data/cards.ndjson
const fs = require('fs');
const path = require('path');
const cards = fs.readFileSync(path.join(__dirname,'..','data','cards.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
const cols = ['product_id','card_number','name','set_code','set_name','rarity','card_type','color','level','cost','ap','hp','zone','trait','link','source_title','block_icon','sp','effect','image_url','detail_url','ap_raw','hp_raw','where_to_get','traits','link_refs','keyword_effects','timing_markers','keywords_text'];
const JSON_COLS = new Set(['traits','link_refs','keyword_effects','timing_markers']); // stored as JSON-in-TEXT
const cell = (c, k) => JSON_COLS.has(k) ? JSON.stringify(c[k] || []) : c[k];
const esc = (v) => v == null ? 'NULL' : (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g,"''")}'`);
let sql = 'DELETE FROM cards;\n';
for (let i = 0; i < cards.length; i += 40) {                     // 40 rows per INSERT — D1 caps a single SQL statement at ~100 KB; effect + new JSON columns add up
  const chunk = cards.slice(i, i + 40);
  sql += `INSERT INTO cards (${cols.join(',')}) VALUES\n` +
    chunk.map(c => `(${cols.map(k => esc(cell(c, k))).join(',')})`).join(',\n') + ';\n';
}
// Precomputed summaries so /v1/manifest and /v1/sets are O(1) meta reads instead of
// full-table COUNT/GROUP BY scans on every cache miss (D1 free-tier read-budget guard).
const setMap = new Map(); // set_code -> { set_code, names: Map<name,count>, card_count }
for (const c of cards) {
  const code = c.set_code == null ? '' : String(c.set_code);
  const cur = setMap.get(code) || { set_code: code, names: new Map(), card_count: 0 };
  cur.card_count++;
  const sn = c.set_name == null ? '' : String(c.set_name);
  cur.names.set(sn, (cur.names.get(sn) || 0) + 1);
  setMap.set(code, cur);
}
// Canonical set_name = the MOST COMMON name for that set_code. A set_code (e.g. GD01)
// contains its main-package cards (set_name "Newtype Rising") plus promo cards that share
// the GD01-### numbering but carry the generic promo package name ("Promotion card").
// The main package always dominates by count, so mode picks the real name — unlike SQL
// MAX(set_name), which wrongly picks "Promotion card" for sets whose name sorts before it.
// Tie-break: lexicographically smallest.
const setsSummary = [...setMap.values()].map(s => {
  let best = null, bestCount = -1;
  for (const [name, cnt] of s.names) {
    if (cnt > bestCount || (cnt === bestCount && (best === null || name < best))) { best = name; bestCount = cnt; }
  }
  return { set_code: s.set_code, set_name: best == null ? '' : best, card_count: s.card_count };
}).sort((a, b) => a.set_code < b.set_code ? -1 : a.set_code > b.set_code ? 1 : 0);
const metaRows = [
  ['dataset_version', process.env.DATASET_VERSION || new Date().toISOString().slice(0,10)],
  ['card_count', String(cards.length)],
  ['sets_summary', JSON.stringify(setsSummary)]
];
for (const [k, v] of metaRows) {
  sql += `INSERT INTO meta (key,value) VALUES ('${k}',${esc(v)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;\n`;
}
fs.writeFileSync(path.join(__dirname,'..','data','import.sql'), sql);
console.log(`Wrote import.sql (${cards.length} rows, ${setsSummary.length} sets)`);
