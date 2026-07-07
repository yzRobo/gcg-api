// src/scraper.js - Scraper for the official Gundam Card Game site.
// No public JSON API exists, so card data is scraped from
// https://www.gundam-gcg.com/en/cards: discover "packages" (sets), then pull
// the cards for each. A package's card list comes from a POST to index.php;
// each row links to a detail page with the full field set.
const axios = require('axios');
const cheerio = require('cheerio');

// Retry with exponential backoff. Retries network errors + 429/5xx, not other 4xx.
async function fetchWithRetry(fn, { attempts = 3, baseDelay = 600 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = err.response && err.response.status;
      if (status && status >= 400 && status < 500 && status !== 429) throw err; // hard client error
      if (i < attempts - 1) await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

class GundamScraper {
  constructor(options = {}) {
    this.baseUrl = 'https://www.gundam-gcg.com/en/cards';
    // Descriptive, attributing User-Agent - swap the URL for THIS project's repo.
    this.headers = {
      'User-Agent': options.userAgent ||
        'Mozilla/5.0 (gundam-card-data/1.0.0; +https://github.com/yzRobo/gcg-api)',
      'Accept': 'text/html,application/xhtml+xml'
    };
  }

  async delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // Resolve a (possibly relative) detail-page image src to an absolute URL.
  resolveImageUrl(src) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith('../')) return 'https://www.gundam-gcg.com/en/' + src.replace(/^\.\.\//, '');
    if (src.startsWith('/')) return 'https://www.gundam-gcg.com' + src;
    return `${this.baseUrl}/${src}`;
  }

  // Discover card packages (sets). Boosters use [GDxx], starters [STxx], etc.
  // <a class="js-selectBtn-package" data-val="616101">Newtype Rising [GD01]</a>
  async getPackages() {
    const response = await fetchWithRetry(() =>
      axios.get(`${this.baseUrl}/index.php`, { headers: this.headers, timeout: 30000 }));
    const $ = cheerio.load(response.data);
    const packages = [];
    const seen = new Set();
    $('a.js-selectBtn-package').each((i, el) => {
      const id = ($(el).attr('data-val') || '').trim();
      const name = $(el).text().replace(/\s+/g, ' ').trim();
      if (!id || seen.has(id)) return; // skip empty "ALL" entry + dupes
      seen.add(id);
      const codeMatch = name.match(/\[([^\]]+)\]\s*$/);
      const code = codeMatch ? codeMatch[1].toUpperCase() : '';
      packages.push({ id, name, code });
    });
    return packages;
  }

  // Detail-page links for every card in a package.
  async getPackageCardLinks(pkg) {
    const listResponse = await fetchWithRetry(() =>
      axios.post(`${this.baseUrl}/index.php`,
        `package=${encodeURIComponent(pkg.id)}&freeword=`,
        { headers: { ...this.headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }));
    const $ = cheerio.load(listResponse.data);
    const links = [];
    const seen = new Set();
    $('.cardItem a.cardStr').each((i, el) => {
      const dataSrc = $(el).attr('data-src');
      if (!dataSrc) return;
      const url = `${this.baseUrl}/${dataSrc}`;
      if (seen.has(url)) return;
      seen.add(url);
      links.push(url);
    });
    return links;
  }

  // Parse one card detail page into a normalized RAW card object.
  parseDetail(html, link, pkg) {
    const $ = cheerio.load(html);
    // detailSearch query param = unique id per printing (alt-arts get a _p1 suffix).
    const idMatch = link.match(/detailSearch=([^&]+)/);
    const productId = idMatch ? decodeURIComponent(idMatch[1]) : '';

    let effectHtml = $('.cardDataRow.overview .dataTxt.isRegular').html() || '';
    effectHtml = effectHtml.replace(/<br\s*\/?>/gi, '\n');
    const effect = cheerio.load(effectHtml).text().replace(/\n{3,}/g, '\n\n').trim();

    const image = this.resolveImageUrl($('.cardImage img').attr('src'));

    // Every labelled stat row: { "Lv.": "4", "COST": "3", "COLOR": "Blue", ... }
    const fields = {};
    $('.dataBox').each((i, el) => {
      const label = $(el).find('.dataTit').text().replace(/\s+/g, ' ').trim();
      const value = $(el).find('.dataTxt').text().replace(/\s+/g, ' ').trim();
      if (label) fields[label] = value;
    });

    // FAQ / rulings block on the same page. Link-only per project posture: capture the
    // number, date, and question (short, identifying), but NOT the answer prose (Bandai
    // copyright) - consumers follow detail_url to the official answer.
    const rulings = [];
    $('.cardQaCol .qaCol').each((i, el) => {
      const num = $(el).find('.qaColNum').text().replace(/\s+/g, ' ').trim();
      const date = $(el).find('.qaColDate').text().replace(/\s+/g, ' ').replace(/\s*Updated\s*$/i, '').trim();
      const question = $(el).find('.qaColQuestion').text().replace(/\s+/g, ' ').trim();
      if (num || question) rulings.push({ num, date, question });
    });

    return {
      product_id: productId,
      card_number: $('.cardNoCol .cardNo').text().trim() || productId,
      name: $('.nameCol .cardName').text().trim(),
      rarity: $('.cardNoCol .rarity').text().replace(/\s+/g, ' ').trim(),
      sp: $('.cardNoCol .spCol').text().replace(/\s+/g, ' ').trim(),
      blockIcon: $('.cardNoCol .blockIcon').text().trim(),
      image,
      effect,
      fields,
      source_package: pkg.name,
      set_code: pkg.code || (productId.split('-')[0] || '').toUpperCase(),
      detail_url: link,
      rulings
    };
  }

  // Scrape every card in a package. Detail pages fetched in small concurrent
  // batches (hardened: 3 concurrent / 400ms between batches, with retry).
  async scrapePackage(pkg, options = {}) {
    const batchSize = options.batchSize || 3;
    const batchDelay = options.batchDelay != null ? options.batchDelay : 400;

    let links = await this.getPackageCardLinks(pkg);
    if (options.limit) links = links.slice(0, options.limit);
    console.log(`Gundam ${pkg.code || pkg.name}: ${links.length} cards`);

    const cards = [];
    for (let i = 0; i < links.length; i += batchSize) {
      const batch = links.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (link) => {
        try {
          const resp = await fetchWithRetry(() =>
            axios.get(link, { headers: this.headers, timeout: 30000 }));
          return this.parseDetail(resp.data, link, pkg);
        } catch (err) {
          console.error(`Failed to fetch Gundam detail ${link}:`, err.message);
          return null;
        }
      }));
      for (const card of results) if (card && card.product_id) cards.push(card);
      if (typeof options.onProgress === 'function') options.onProgress(Math.min(i + batchSize, links.length), links.length);
      if (i + batchSize < links.length) await this.delay(batchDelay);
    }
    return cards;
  }
}

module.exports = GundamScraper;
