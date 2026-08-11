// src/sets.js - the ONE definition of "what is a set" (fixed 2026-08-11).
//
// THE BUG THIS REPLACES
// There used to be two implementations. cli.js built data/sets/en/index.json from the
// scraped PACKAGES (one entry per package, set_code taken from the package), while
// gen-sql.js built the D1 sets summary from the CARDS (grouped on each card's own
// set_code, which is derived from its product_id prefix). Those are different taxonomies,
// so they disagreed: the published index had 21 entries, four of them with a NULL
// set_code ("Promotion card", "Other Product Card", "Edition Beta", "Basic Cards"), while
// seven set_codes that exist in the card data (RP, EXBP, EXRP, T, R, EXB, EXR - 115
// printings) had no index entry at all. The mapping was many-to-many: RP alone split
// across two package names. Card counts summed correctly to 1816, which is exactly why
// nobody noticed - neither set_code nor set_name was a usable primary key for a set.
//
// Deriving from the cards makes set_code a real key by construction: every card has one,
// so there are no nulls and nothing can be missing.
//
// SCOPE - read this before using the output. This is a PRINTING index. Its card_count
// counts PRINTINGS, not gameplay cards, and a gameplay card can legitimately appear in
// more than one set (75 card_numbers have printings in multiple sets). Do NOT use
// set_code to establish gameplay identity; that is always card_number. Grouping on
// set_code is correct for a gallery, a set picker, or a collection view, and wrong for
// deckbuilding.

/**
 * Build the canonical set index from normalized card records.
 * Returns [{ set_code, set_name, card_count }] sorted by set_code.
 *
 * set_name is the name most printings in that set agree on. A set_code can span several
 * package names (promos especially), so the dominant name wins, ties broken alphabetically
 * for determinism - the committed artifact must not reorder between runs on a tie.
 */
function buildSetIndex(cards) {
  const bySet = new Map(); // set_code -> { names: Map<name, count>, card_count }
  for (const c of cards) {
    const code = c.set_code == null ? '' : String(c.set_code);
    const entry = bySet.get(code) || { names: new Map(), card_count: 0 };
    entry.card_count++;
    const name = c.set_name == null ? '' : String(c.set_name);
    entry.names.set(name, (entry.names.get(name) || 0) + 1);
    bySet.set(code, entry);
  }

  return [...bySet.entries()]
    .map(([set_code, entry]) => {
      let best = null;
      let bestCount = -1;
      for (const [name, count] of entry.names) {
        if (count > bestCount || (count === bestCount && (best === null || name < best))) {
          best = name;
          bestCount = count;
        }
      }
      return { set_code, set_name: best == null ? '' : best, card_count: entry.card_count };
    })
    .sort((a, b) => (a.set_code < b.set_code ? -1 : a.set_code > b.set_code ? 1 : 0));
}

module.exports = { buildSetIndex };
