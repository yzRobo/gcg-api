// src/normalize.js - map a raw scraped card onto the clean public schema.

// --- M5 structured extraction helpers (derive machine-readable fields from text) ---

// Ability keywords appear inline in the effect text in ASCII angle brackets, optionally
// with a numeric value: <Repair 1>, <Support 3>, <Blocker>. The game never uses "<" as a
// less-than sign, so this is a clean closed vocabulary.
function extractKeywordEffects(effect) {
  const out = [];
  const seen = new Set();
  for (const m of (effect || '').matchAll(/<([A-Za-z][A-Za-z \-]*?)(?:\s+(\d+))?>/g)) {
    const keyword = m[1].trim();
    const value = m[2] != null ? parseInt(m[2], 10) : null;
    const key = keyword.toLowerCase() + '|' + (value == null ? '' : value); // dedupe repeated mentions on one card
    if (!seen.has(key)) { seen.add(key); out.push({ keyword, value }); }
  }
  return out;
}

// Effect timing/type markers appear in fullwidth lenticular brackets, sometimes compounded
// with a middle dot (either U+30FB or U+FF65): 【Burst】, 【Activate･Main】, 【When Paired】.
// The compounds also carry pilot/trait CONDITIONS (e.g. "(Coordinator) Pilot", "Development 2")
// which are not timings - so keep only tokens in the known timing vocabulary and leave the
// rest in the effect text.
const TIMING_KEYWORDS = ['Activate', 'Main', 'Action', 'Burst', 'Deploy', 'Attack', 'Destroyed', 'When Paired', 'During Pair', 'When Linked', 'During Link', 'Once per Turn'];
const TIMING_SET = new Set(TIMING_KEYWORDS.map((s) => s.toLowerCase()));
function extractTimingMarkers(effect) {
  const out = [];
  const seen = new Set();
  for (const m of (effect || '').matchAll(/【([^【】]+)】/g)) {
    for (let tok of m[1].split(/[・･]/)) {
      tok = tok.trim();
      const key = tok.toLowerCase();
      if (TIMING_SET.has(key) && !seen.has(key)) { seen.add(key); out.push(tok); }
    }
  }
  return out;
}

// "(Earth Federation) (White Base Team)" -> ["Earth Federation", "White Base Team"]; "-" -> []
function parenGroups(str) {
  const out = [];
  if (str && str !== '-') for (const m of str.matchAll(/\(([^)]+)\)/g)) out.push(m[1].trim());
  return out;
}

// Link references: "[Amuro Ray]" -> ["Amuro Ray"]; "(White Base Team) Trait" -> ["White Base Team"]; "-" -> []
function linkRefs(str) {
  if (!str || str === '-') return [];
  const out = [];
  for (const m of str.matchAll(/\[([^\]]+)\]/g)) out.push(m[1].trim());
  for (const m of str.matchAll(/\(([^)]+)\)/g)) out.push(m[1].trim());
  return out;
}

// Raw stat string: keep "+1"/"+2" pilot modifiers verbatim (toInt drops the sign); null for "-"/blank.
function rawStat(v) { return v && v.trim() && v.trim() !== '-' ? v.trim() : null; }

// Normalize the card_type separator: the source has both "UNIT TOKEN" and "UNIT・TOKEN".
function normalizeType(v) { return (v || '').replace(/[・･]/g, ' ').replace(/\s+/g, ' ').trim(); }

function normalizeCard(raw, pkg) {
  const toInt = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
  const fields = raw.fields || {};
  const keys = Object.keys(fields);
  const field = (label) => {
    const k = keys.find((x) => x.toLowerCase() === label.toLowerCase());
    const v = k ? fields[k] : '';
    return v && v.trim() ? v.trim() : null;
  };

  const setCode = (raw.set_code || (raw.card_number || '').split('-')[0] || '').toUpperCase();
  const setName = (pkg && pkg.name || raw.source_package || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  const rawColor = field('COLOR');
  const color = rawColor && rawColor !== '-' ? rawColor : null; // '-' = colorless → null

  const imageUrl = raw.image || '';
  const effect = raw.effect || '';

  // M5 derived fields
  const keywordEffects = extractKeywordEffects(effect);
  const timingMarkers = extractTimingMarkers(effect);
  const keywordsText = [...keywordEffects.map((k) => k.keyword), ...timingMarkers].join(' ').toLowerCase() || null;

  return {
    product_id: raw.product_id,                 // natural key; alt-arts get _p1 suffix
    card_number: raw.card_number || raw.product_id,
    name: raw.name,
    set_code: setCode,
    set_name: setName,
    rarity: raw.rarity || '',
    card_type: normalizeType(field('TYPE')),
    color,
    level: toInt(field('Lv.')),
    cost: toInt(field('COST')),
    ap: toInt(field('AP')),
    hp: toInt(field('HP')),
    ap_raw: rawStat(field('AP')),                 // preserves PILOT "+1"/"+2" modifiers
    hp_raw: rawStat(field('HP')),
    zone: field('Zone'),
    trait: field('Trait'),
    link: field('Link'),
    traits: parenGroups(field('Trait')),          // structured array of the (...) groups
    link_refs: linkRefs(field('Link')),           // structured array of [pilot]/(trait) references
    keyword_effects: keywordEffects,              // [{ keyword, value }] from <...>
    timing_markers: timingMarkers,                // ["Burst", "Main", ...] from 【...】
    keywords_text: keywordsText,                  // denormalized, space-joined lowercase (for LIKE filtering)
    source_title: field('Source Title'),
    block_icon: raw.blockIcon || null,
    sp: raw.sp || null,
    where_to_get: field('Where to get it'),       // product/event provenance (unique for promos)
    effect,
    image_url: imageUrl,                          // absolute gundam-gcg.com URL; NOT rehosted
    // Optional, off by default: a free CDN proxy of the same official image.
    // image_proxy_url: imageUrl ? `https://images.weserv.nl/?url=${encodeURIComponent(imageUrl.replace(/^https?:\/\//,''))}` : null,
    detail_url: raw.detail_url || null
  };
}

module.exports = { normalizeCard, extractKeywordEffects, extractTimingMarkers, parenGroups, linkRefs };
