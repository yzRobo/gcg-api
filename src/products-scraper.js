// src/products-scraper.js - scrape the official PRODUCTS list (boosters, starter decks,
// accessories, promo products) from gundam-gcg.com. SUPPLEMENTARY to cards: a failure here
// must never abort the card refresh (see cli.js try/catch + zero-guard). Does NOT touch
// src/scraper.js. Selectors + page contract verified against the live site 2026-07-07.
//
// List:   GET /en/products/list.php?subcategory=product&tag=all&page=N  (12 items/page, ~4 pages)
//   item = .productsDetail[data-tags] > .cardCategory + a.productsDetailInner[href]
//          + .cardTit + .cardThumb img[src] + .cardInfo dt/dd (Release Date, MSRP)
//   pager total pages from .pagerColInner text "1/4".
// Detail: from each product_url; dt/dd labels Release Date / MSRP / Contents (skip the rest -
//   marketing prose stays out of the dataset, same posture as ruling answers).
const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.gundam-gcg.com';
const listUrl = (page) => `${BASE}/en/products/list.php?subcategory=product&tag=all&page=${page}`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (gundam-card-data/1.0.0; +https://github.com/yzRobo/gcg-api)',
  'Accept': 'text/html,application/xhtml+xml'
};

// Same retry/backoff discipline as the card scraper: retries network + 429/5xx, not other 4xx.
async function fetchWithRetry(fn, { attempts = 3, baseDelay = 600 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = err.response && err.response.status;
      if (status && status >= 400 && status < 500 && status !== 429) throw err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
    }
  }
  throw lastErr;
}
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
// "June 26, 2026" / "October 30,2026" (missing space) / "May 29, 2026~" / "December 7, 2024
// Varies by region." -> ISO; matches the LEADING "Month D, YYYY" and ignores trailing modifiers
// (approximate/region notes). Non-dates ("Please check the ... Website") -> null.
function toISODate(raw) {
  if (!raw) return null;
  const m = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  const day = parseInt(m[2], 10), year = parseInt(m[3], 10);
  if (!mon || !day || !year) return null;
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
// "$15.99" -> { msrp: "$15.99", msrp_value: 15.99 }; "-"/blank -> { null, null }.
function parseMsrp(raw) {
  const t = (raw || '').trim();
  if (!t || t === '-') return { msrp: null, msrp_value: null };
  const m = t.match(/(\d+(?:\.\d{1,2})?)/);
  return { msrp: t, msrp_value: m ? parseFloat(m[1]) : null };
}
// Set code from "[GD06]"/"[ST11]" anywhere in the name -> uppercased; null if absent (accessories).
function setCodeFromName(name) {
  const m = (name || '').match(/\[([A-Za-z0-9]+)\]/);
  return m ? m[1].toUpperCase() : null;
}
// Natural key: the detail-page filename slug (gd06, st11, deck-case02) lowercased, .html stripped.
function slugFromUrl(url) {
  const m = (url || '').match(/\/([^/]+)\.html(?:[?#].*)?$/i);
  return m ? m[1].toLowerCase() : null;
}
// Path-absolute src (/gcg/...webp) -> absolute gundam-gcg.com URL. HOTLINK ONLY, never rehosted.
function absImg(src) {
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('/')) return BASE + src;
  return `${BASE}/${src}`;
}
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Parse total pages from the pager ("1/4"); default 1.
function parseTotalPages(html) {
  const $ = cheerio.load(html);
  const m = clean($('.pagerColInner').first().text()).match(/(\d+)\s*\/\s*(\d+)/);
  return m ? parseInt(m[2], 10) : 1;
}

// Parse one list page -> array of partial products (list-level data + fallback date/msrp).
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.productsDetail').each((i, el) => {
    const $el = $(el);
    const a = $el.find('a.productsDetailInner').first();
    const product_url = (a.attr('href') || '').trim();
    const product_id = slugFromUrl(product_url);
    if (!product_id) return;
    let listDate = null, listMsrp = null;
    $el.find('.cardInfo dt').each((j, dt) => {
      const label = clean($(dt).text()).toLowerCase();
      const dd = clean($(dt).next('dd').text());
      if (label === 'release date') listDate = dd;
      else if (label === 'msrp') listMsrp = dd;
    });
    items.push({
      product_id,
      name: clean($el.find('.cardTit').first().text()),
      category_tag: clean($el.attr('data-tags')) || null,
      category_label: clean($el.find('.cardCategory').first().text()) || null,
      product_url,
      image_url: absImg($el.find('.cardThumb img').first().attr('src')),
      _listDate: listDate,
      _listMsrp: listMsrp
    });
  });
  return items;
}

// Parse a detail page for Release Date / MSRP / Contents (skip SOCIAL and everything else).
function parseDetail(html) {
  const $ = cheerio.load(html);
  const out = { release_date_raw: null, msrp_raw: null, contents: null };
  $('dt').each((i, dt) => {
    const label = clean($(dt).text()).toLowerCase();
    const val = clean($(dt).next('dd').text());
    if (label === 'release date') out.release_date_raw = val || null;
    else if (label === 'msrp') out.msrp_raw = val || null;
    else if (label === 'contents') out.contents = val || null;
  });
  return out;
}

// Merge list + detail into the public product object. Prefer detail-page Release Date/MSRP;
// fall back to list values when the detail fetch failed.
function normalizeProduct(listItem, detail) {
  const dateRaw = detail.release_date_raw || listItem._listDate || null;
  const { msrp, msrp_value } = parseMsrp(detail.msrp_raw || listItem._listMsrp);
  const cleanDate = dateRaw && clean(dateRaw) !== '-' ? clean(dateRaw) : null;
  return {
    product_id: listItem.product_id,
    name: listItem.name,
    category_tag: listItem.category_tag,
    category_label: listItem.category_label,
    set_code: setCodeFromName(listItem.name),
    release_date: toISODate(cleanDate),
    release_date_raw: cleanDate,
    msrp,
    msrp_value,
    contents: detail.contents ? clean(detail.contents) : null,
    image_url: listItem.image_url,
    product_url: listItem.product_url
  };
}

// Scrape all products. Returns [] if nothing found (caller applies the zero-guard).
async function scrapeProducts(options = {}) {
  const batchSize = options.batchSize || 3;
  const batchDelay = options.batchDelay != null ? options.batchDelay : 400;
  const listDelay = options.listDelay != null ? options.listDelay : 400;

  const first = await fetchWithRetry(() => axios.get(listUrl(1), { headers: HEADERS, timeout: 30000 }));
  const totalPages = Math.min(parseTotalPages(first.data) || 1, 20); // defensive cap
  let listItems = parseListPage(first.data);
  for (let page = 2; page <= totalPages; page++) {
    await delay(listDelay);
    const resp = await fetchWithRetry(() => axios.get(listUrl(page), { headers: HEADERS, timeout: 30000 }));
    const pageItems = parseListPage(resp.data);
    if (pageItems.length === 0) break; // stop when a page yields nothing (defensive)
    listItems = listItems.concat(pageItems);
  }

  // Dedupe by product_id (keep first seen).
  const byId = new Map();
  for (const it of listItems) if (!byId.has(it.product_id)) byId.set(it.product_id, it);
  const items = [...byId.values()];
  console.log(`Products: ${items.length} items across ${totalPages} list page(s); fetching detail pages`);

  const products = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const detailed = await Promise.all(batch.map(async (it) => {
      let detail = { release_date_raw: null, msrp_raw: null, contents: null };
      try {
        const resp = await fetchWithRetry(() => axios.get(it.product_url, { headers: HEADERS, timeout: 30000 }));
        detail = parseDetail(resp.data);
      } catch (err) {
        console.error(`Products: detail fetch failed for ${it.product_url}: ${err.message}`);
      }
      return normalizeProduct(it, detail);
    }));
    for (const p of detailed) products.push(p);
    if (i + batchSize < items.length) await delay(batchDelay);
  }
  return products;
}

module.exports = { scrapeProducts, toISODate, parseMsrp, setCodeFromName, slugFromUrl, parseListPage, parseDetail, normalizeProduct };
