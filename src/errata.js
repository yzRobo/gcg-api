// src/errata.js - official card errata (added 2026-08-11).
//
// WHY THIS IS HAND-MAINTAINED AND NOT SCRAPED
// Bandai does NOT update card detail pages when it issues errata: the live page for
// GD04-067 still shows the printed text months after the correction. So a faithful
// scrape of the card database is WRONG for errata'd cards, and nothing about the data
// reveals that. Errata is published only as prose apology announcements in the news
// feed, with no index page, no FAQ category, and an inconsistent URL scheme spanning
// at least two series (01_* and 02_*). There is nothing reliable to scrape, so this
// list is curated by hand and reviewed on change.
//
// SCOPE: gameplay-affecting corrections only - card text, traits, stats. Cosmetic
// notices are deliberately excluded (e.g. 02_93, incorrect illustrator credits on GD01).
//
// DISCOVERY: found by sweeping every page of /en/news/?subcategory=news and filtering
// titles for errata/revision/correction/apology. Last swept 2026-08-11, which found
// exactly the two entries below. Re-run that sweep when adding entries.
//
// `before` and `after` are SUBSTRINGS of the field, not whole values, so a correction
// can touch part of a longer sentence. Matching is exact and case-sensitive.

const ERRATA = [
  {
    card_number: 'T-013',
    name: 'Hy-Gogg',
    field: 'trait',
    before: '(Zeon)',
    after: '(Cyclops Team)',
    date: '2026-01-30',
    source_url: 'https://www.gundam-gcg.com/en/news/01_204.html',
    note: 'Steel Requiem [GD03]. The trait printed as (Zeon) is treated as (Cyclops Team). Affects trait-based targeting, not effect text.'
  },
  {
    card_number: 'GD04-067',
    name: '∀ Gundam',
    field: 'effect',
    before: 'from your trash',
    after: "from any player's trash",
    date: '2026-04-10',
    source_url: 'https://www.gundam-gcg.com/en/news/02_157.html',
    note: 'Phantom Aria [GD04]. Widens the eligible trash from the controller to either player.'
  }
];

// Public field name -> where it lives on the RAW scraped record. Errata MUST be applied
// to the raw record before normalizeCard runs, because normalize derives other fields
// from these: `effect` feeds keyword_effects/timing_markers/keywords_text, and `trait`
// feeds traits[]. Patching after normalization leaves those derived fields stale, which
// is the exact class of silent bug errata handling exists to prevent.
const RAW_LOCATION = {
  effect: { kind: 'top', key: 'effect' },
  trait: { kind: 'field', key: 'Trait' },
  link: { kind: 'field', key: 'Link' },
  zone: { kind: 'field', key: 'Zone' },
  name: { kind: 'top', key: 'name' }
};

// Read the current value of an errata-able field off a raw record.
function readRaw(raw, field) {
  const loc = RAW_LOCATION[field];
  if (!loc) throw new Error(`errata: unsupported field "${field}" (add it to RAW_LOCATION)`);
  if (loc.kind === 'top') return raw[loc.key] == null ? '' : String(raw[loc.key]);
  const fields = raw.fields || {};
  const key = Object.keys(fields).find((k) => k.toLowerCase() === loc.key.toLowerCase());
  return key ? String(fields[key]) : '';
}

function writeRaw(raw, field, value) {
  const loc = RAW_LOCATION[field];
  if (loc.kind === 'top') { raw[loc.key] = value; return; }
  const fields = raw.fields || (raw.fields = {});
  const key = Object.keys(fields).find((k) => k.toLowerCase() === loc.key.toLowerCase()) || loc.key;
  fields[key] = value;
}

/**
 * Apply errata to ONE raw record, in place. Pure apart from the mutation, so it is unit
 * testable. Returns a per-entry outcome for the caller to tally:
 *   'applied'       - `before` was present and has been replaced with `after`
 *   'upstream_fixed'- the field already reads `after`, so Bandai corrected the page
 *   'miss'          - neither present; the text changed under us
 * Records whose card_number does not match any entry return an empty array.
 */
function applyErrataToRaw(raw, entries = ERRATA) {
  const outcomes = [];
  for (const e of entries) {
    if (raw.card_number !== e.card_number) continue;
    const current = readRaw(raw, e.field);
    if (current.includes(e.before)) {
      writeRaw(raw, e.field, current.split(e.before).join(e.after));
      outcomes.push({ entry: e, outcome: 'applied' });
    } else if (current.includes(e.after)) {
      outcomes.push({ entry: e, outcome: 'upstream_fixed' });
    } else {
      outcomes.push({ entry: e, outcome: 'miss', current });
    }
  }
  return outcomes;
}

/**
 * Validate the tallied outcomes across every printing. Throws on anything incoherent,
 * because applying a correction to text that has changed silently corrupts the dataset.
 * Returns the published ledger rows.
 */
function finalizeErrata(tally, entries = ERRATA) {
  const rows = [];
  for (const e of entries) {
    const t = tally.get(e) || { applied: 0, upstream_fixed: 0, miss: 0, samples: [] };
    const seen = t.applied + t.upstream_fixed + t.miss;
    if (seen === 0) {
      throw new Error(`ERRATA: no printing of ${e.card_number} found - the entry references a card that is not in the dataset (${e.source_url})`);
    }
    if (t.miss > 0) {
      throw new Error(
        `ERRATA: ${e.card_number} field "${e.field}" matched neither the before nor the after text on ${t.miss} printing(s). ` +
        `Expected to find ${JSON.stringify(e.before)} or ${JSON.stringify(e.after)}, saw ${JSON.stringify(t.samples[0] || '')}. ` +
        `The source text changed - re-check ${e.source_url} and update src/errata.js.`
      );
    }
    if (t.applied > 0 && t.upstream_fixed > 0) {
      throw new Error(`ERRATA: ${e.card_number} is inconsistent across printings - ${t.applied} needed the fix but ${t.upstream_fixed} already had it.`);
    }
    const status = t.applied > 0 ? 'applied' : 'upstream_fixed';
    if (status === 'upstream_fixed') {
      console.log(`  errata: ${e.card_number} already reads the corrected text upstream - Bandai fixed the page, entry can be retired once confirmed stable.`);
    }
    rows.push({
      card_number: e.card_number,
      name: e.name,
      field: e.field,
      before: e.before,
      after: e.after,
      date: e.date,
      source_url: e.source_url,
      note: e.note,
      status,
      printings_affected: t.applied || t.upstream_fixed
    });
  }
  return rows;
}

module.exports = { ERRATA, applyErrataToRaw, finalizeErrata, readRaw };
