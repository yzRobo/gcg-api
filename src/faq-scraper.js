// src/faq-scraper.js - RULE-LEVEL official FAQ scraper (added 2026-08-10).
//
// Distinct from the per-card rulings in scraper.js. Those come off each card's
// detail page and answer "what does THIS card do". These come off the FAQ hub's
// category listings and answer "how does this MECHANIC work" - Blocker, Breach,
// First Strike, Repair, the phases, Fundamental Terminology, and so on. A rules
// engine needs the second kind constantly, and it was the one corpus the dataset
// did not carry.
//
// The two share ONE global question-number space and do not collide: every Q number
// is filed either against a card or under a rule category, never both. Verified
// 2026-08-10 - rule FAQ spans Q1-Q195 and per-card rulings Q113-Q426, interleaved
// ranges but zero shared numbers. So `num` is unique across both files and a
// consumer can join on it safely.
//
// SUPPLEMENTARY, exactly like products: a failure here must never abort or
// degrade the card refresh (see cli.js).
const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.gundam-gcg.com/en/rules/faqs/';
// Baseline is 33 categories (2026-08-10). Discovery is dynamic rather than a
// hardcoded list so a keyword introduced by a new set is picked up automatically;
// MIN_CATEGORIES is the loud-failure floor if the hub markup changes underneath us.
const MIN_CATEGORIES = 25;

const HEADERS = {
  'User-Agent': 'gcg-api/1.0 (+https://github.com/yzRobo/gcg-api)',
  'Accept-Language': 'en-US,en;q=0.9'
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull the sub_category values off the FAQ hub. These are the rule categories
// ("Blocker", "Main Phase: Playing Cards", ...); names are kept verbatim,
// colons and all, because they are the site's own taxonomy.
async function discoverCategories() {
  const { data } = await axios.get(BASE, { headers: HEADERS, timeout: 30000 });
  const $ = cheerio.load(data);
  const cats = new Set();
  $('a[href*="sub_category="]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/sub_category=([^&]+)/);
    if (m) {
      try { cats.add(decodeURIComponent(m[1].replace(/\+/g, ' '))); } catch (_) { /* skip unparseable */ }
    }
  });
  return [...cats].sort();
}

// One category listing -> its FAQ entries. The listing renders every entry for a
// category inline (the largest is 12 as of 2026-08-10, well under a page), and it
// reports its own count in .resultTxt .num, which we use as a per-page check.
async function scrapeCategory(category) {
  const url = BASE + 'list.php?sub_category=' + encodeURIComponent(category);
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 30000 });
  const $ = cheerio.load(data);

  const entries = [];
  $('.faqResult_listItem').each((i, el) => {
    const $el = $(el);
    const num = $el.find('.faqResult_number').first().text().trim();
    // .faqResult_date carries a trailing "Updated" label; the <time datetime> is
    // the machine-readable form, so prefer it and fall back to the visible text.
    const dateIso = $el.find('.faqResult_date time').attr('datetime') || '';
    const dateText = $el.find('.faqResult_date').first().text().replace(/\s+/g, ' ').replace(/\s*Updated\s*$/i, '').trim();
    // The question is the .faqResult_text inside the toggle button; the answer is
    // the one(s) inside .faqResult_answer. Scope each so they cannot cross-match.
    const question = $el.find('.faqResult_question .faqResult_text').first().text().replace(/\s+/g, ' ').trim();
    const $answer = $el.find('.faqResult_answer');
    let answer = $answer.find('p').map((j, p) => $(p).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean).join('\n');
    if (!answer) answer = $answer.text().replace(/\s+/g, ' ').trim();
    // .faqResult_title repeats the category on each row; trust our own loop value.
    if (num || question) {
      entries.push({ num, category, date: dateText, date_iso: dateIso, question, answer, source_url: url });
    }
  });

  // The page states its own result count. A mismatch means the markup shifted
  // (or a pager appeared) and we are silently truncating - surface it.
  const claimed = parseInt($('.resultTxt .num').first().text().trim(), 10);
  if (Number.isFinite(claimed) && claimed !== entries.length) {
    console.warn(`WARNING: FAQ category "${category}" reports ${claimed} results but ${entries.length} were parsed - markup may have changed (possible pagination).`);
  }
  return entries;
}

// Full sweep. Returns entries deduped on `num` (a question can be filed under
// more than one category; first category wins, and `category` records which).
async function scrapeRulesFaq() {
  const categories = await discoverCategories();
  if (categories.length < MIN_CATEGORIES) {
    throw new Error(`SANITY: only ${categories.length} FAQ categories discovered (expected >=${MIN_CATEGORIES}) - hub markup likely changed`);
  }
  console.log(`FAQ: ${categories.length} rule categories discovered`);

  const byNum = new Map();
  for (const c of categories) {
    const entries = await scrapeCategory(c);
    for (const e of entries) if (!byNum.has(e.num)) byNum.set(e.num, e);
    process.stdout.write(`\r  FAQ: ${byNum.size} entries across ${c}                    `);
    await delay(400);                    // same courtesy pacing as the card scraper
  }
  process.stdout.write('\n');

  // Sort by question number so the committed file has a stable, reviewable order
  // (Q7 before Q10 - numeric, not lexicographic).
  const out = [...byNum.values()].sort((a, b) => {
    const na = parseInt(String(a.num).replace(/\D/g, ''), 10) || 0;
    const nb = parseInt(String(b.num).replace(/\D/g, ''), 10) || 0;
    return na - nb;
  });
  return out;
}

module.exports = { scrapeRulesFaq, discoverCategories, scrapeCategory, MIN_CATEGORIES };
