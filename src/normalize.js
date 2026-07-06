// src/normalize.js — map a raw scraped card onto the clean public schema.
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
  return {
    product_id: raw.product_id,                 // natural key; alt-arts get _p1 suffix
    card_number: raw.card_number || raw.product_id,
    name: raw.name,
    set_code: setCode,
    set_name: setName,
    rarity: raw.rarity || '',
    card_type: field('TYPE') || '',
    color,
    level: toInt(field('Lv.')),
    cost: toInt(field('COST')),
    ap: toInt(field('AP')),
    hp: toInt(field('HP')),
    zone: field('Zone'),
    trait: field('Trait'),
    link: field('Link'),
    source_title: field('Source Title'),
    block_icon: raw.blockIcon || null,
    sp: raw.sp || null,
    effect: raw.effect || '',
    image_url: imageUrl,                          // absolute gundam-gcg.com URL; NOT rehosted
    // Optional, off by default: a free CDN proxy of the same official image.
    // image_proxy_url: imageUrl ? `https://images.weserv.nl/?url=${encodeURIComponent(imageUrl.replace(/^https?:\/\//,''))}` : null,
    detail_url: raw.detail_url || null
  };
}

module.exports = { normalizeCard };
