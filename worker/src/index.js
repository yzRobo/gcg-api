// worker/src/index.js
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
};
const DISCLAIMER = 'Not affiliated with Bandai. Gundam and card images are copyright Bandai.';

// --- Rate-limit tiers (counters live in the wrangler.toml [[ratelimits]] bindings).
// NOTE: the Workers Rate Limiting binding is per-Cloudflare-location (node-local, no
// network hop), so these are approximate per-location ceilings, not hard global caps -
// an accepted free-tier tradeoff (a global counter would need a Durable Object/KV hop). ---
const ANON_LIMIT = 60;        // ~requests / minute / IP   (RL_ANON)
const KEYED_LIMIT = 300;      // ~requests / minute / key  (RL_KEYED)
const MAX_KEYS_PER_IP = 3;    // active (non-revoked) self-serve keys per IP

// Cloudflare Turnstile test credentials (only valid in dev) - warn if seen in production.
const TEST_SITEKEYS = ['1x00000000000000000000AA', '2x00000000000000000000AB', '3x00000000000000000000FF'];

// Only these query params affect a response body; the cache key is built from them
// (sorted) so junk params like ?_=<rand> cannot mint unlimited cache misses.
// NOTE (cache-poisoning class): every param a route READS must be listed here, or two
// different queries can collide on one cache entry. 'category' is the /v1/products filter.
const CACHE_PARAMS = ['set_code', 'card_type', 'color', 'rarity', 'level', 'cost', 'ap', 'hp', 'name', 'effect', 'keyword', 'category', 'limit', 'offset', 'include'];

// JSON-in-TEXT columns are stored as strings in D1; parse them back to arrays before returning,
// since every card route does SELECT * and returns rows verbatim.
const JSON_COLS = ['traits', 'link_refs', 'keyword_effects', 'timing_markers'];
function hydrate(row) {
  if (!row) return row;
  for (const k of JSON_COLS) if (typeof row[k] === 'string') { try { row[k] = JSON.parse(row[k]); } catch (_) { /* leave as-is */ } }
  return row;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders }
  });
}

// hex SHA-256 of a string (used for key hashing and IP hashing).
async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// On Cloudflare, CF-Connecting-IP is always edge-set and un-spoofable. The 0.0.0.0
// fallback only applies to local `wrangler dev`, where there is no adversary.
function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || '0.0.0.0';
}

// Salted hash of the caller IP. The salt (pepper) makes stored hashes non-reversible
// even though the IPv4 space is small. For the STORED created_ip_hash a real secret is
// REQUIRED (createKey enforces env.IP_HASH_SALT); the constant fallback here exists only
// so the ephemeral, never-stored anonymous rate-limit bucket key still works in dev.
async function ipHash(request, env) {
  const salt = env.IP_HASH_SALT || 'gcg-api-default-ip-salt';
  return sha256Hex(`${salt}:${clientIp(request)}`);
}

// Identify the actor for rate limiting. A valid, non-revoked X-API-Key -> keyed tier
// (one indexed point read); anything else -> anonymous tier keyed by IP hash (no D1 read).
// Any DB error falls back to anonymous (fail-safe: never hand out keyed limits on error).
async function identify(request, env) {
  const presented = request.headers.get('X-API-Key');
  if (presented) {
    try {
      const keyHash = await sha256Hex(presented);
      const row = await env.DB.prepare('SELECT revoked FROM api_keys WHERE key_hash = ?1').bind(keyHash).first();
      if (row && !row.revoked) return { tier: 'keyed', rlKey: `k:${keyHash}`, keyHash };
    } catch (_) { /* fall through to anonymous */ }
  }
  return { tier: 'anon', rlKey: `ip:${await ipHash(request, env)}` };
}

// Enforce the tier's limit. Fails OPEN (with a warning) if the binding is absent/misconfigured
// or the limiter errors, so a limiter problem never takes the whole read API down.
async function enforceRateLimit(env, actor) {
  const binding = actor.tier === 'keyed' ? env.RL_KEYED : env.RL_ANON;
  if (!binding || typeof binding.limit !== 'function') {
    console.warn(`rate limiter binding for tier "${actor.tier}" is missing; failing open (no limit enforced)`);
    return true;
  }
  try {
    const { success } = await binding.limit({ key: actor.rlKey });
    return success;
  } catch (err) {
    console.warn(`rate limiter errored for tier "${actor.tier}"; failing open: ${err && err.message}`);
    return true;
  }
}

function normalizedQuery(url) {
  const sp = url.searchParams;
  const parts = [];
  for (const k of CACHE_PARAMS) if (sp.has(k)) parts.push(`${k}=${encodeURIComponent(sp.get(k))}`); // encode so decoded values can't collide across different param splits (cache-key poisoning fix)
  parts.sort();
  return parts.join('&');
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const version = env.DATASET_VERSION || 'dev';

    // ---- Identify + rate-limit BEFORE the cache, so cache hits still count toward the limit ----
    const actor = await identify(request, env);
    if (!(await enforceRateLimit(env, actor))) {
      return json({
        error: 'Rate limit exceeded',
        tier: actor.tier,
        limit_per_minute: actor.tier === 'keyed' ? KEYED_LIMIT : ANON_LIMIT,
        note: 'Limits are enforced per Cloudflare location, so this is an approximate ceiling.',
        hint: actor.tier === 'anon'
          ? 'Register a free key at /register for a higher limit, or use the bulk Release files for large pulls.'
          : 'Slow down - the keyed limit is about 300 requests/minute.',
        disclaimer: DISCLAIMER
      }, 429, { 'Retry-After': '60', 'Cache-Control': 'no-store' }); // 429s carry Retry-After and are never cached
    }

    // Per-key daily usage counter - keyed requests only (anonymous traffic is never tracked).
    // Fire-and-forget: adds no latency, silently undercounts if the D1 write budget is ever hit.
    if (actor.tier === 'keyed' && actor.keyHash) {
      ctx.waitUntil(env.DB.prepare(
        "INSERT INTO usage_daily (key_hash, day, count) VALUES (?1, date('now'), 1) ON CONFLICT(key_hash, day) DO UPDATE SET count = count + 1"
      ).bind(actor.keyHash).run().catch(() => {}));
    }

    // ---- Per-key + registration endpoints handled BEFORE the cache (responses must never be cached) ----
    if (url.pathname === '/register' && request.method === 'GET') return registerPage(env);
    if (url.pathname === '/v1/keys' && request.method === 'POST') return createKey(request, env);
    if (url.pathname === '/v1/me' && request.method === 'GET') return meHandler(request, env, url);

    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    // ---- Edge cache: version-stamped, param-normalized key so a new dataset bypasses
    //      stale cache and junk query params cannot mint unlimited misses ----
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}${url.pathname}?${normalizedQuery(url)}&_v=${version}`, request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let response;
    try {
      response = await route(url, env, version);
    } catch (err) {
      console.error('route error:', err && err.stack || err);
      return json({ error: 'Internal error' }, 500); // errors NOT cached, no internal detail leaked
    }

    if (response.status === 200) {
      response = new Response(response.body, response);
      // Data changes at most weekly; 1-day TTL + version-stamped key = safe freshness.
      response.headers.set('Cache-Control', 'public, max-age=86400');
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  }
};

// ---- Self-serve key issuance: verify Turnstile, enforce per-IP cap atomically, store hash ----
async function createKey(request, env) {
  let token = '', label = '';
  const ctype = request.headers.get('Content-Type') || '';
  try {
    if (ctype.includes('application/json')) {
      const b = await request.json();
      token = String(b.token || b['cf-turnstile-response'] || '');
      label = String(b.label || '');
    } else {
      const form = await request.formData();
      token = String(form.get('cf-turnstile-response') || form.get('token') || '');
      label = String(form.get('label') || '');
    }
  } catch (_) {
    return json({ error: 'Invalid request body' }, 400);
  }
  if (!token) return json({ error: 'Missing Turnstile token' }, 400);

  const secret = env.TURNSTILE_SECRET;
  if (!secret) return json({ error: 'Registration is not configured on this deployment (missing TURNSTILE_SECRET).' }, 501);
  // The STORED IP hash must use a real secret pepper; refuse to persist a reversible hash.
  if (!env.IP_HASH_SALT) return json({ error: 'Registration is not configured on this deployment (missing IP_HASH_SALT).' }, 501);

  // Server-side Turnstile verification.
  let verify;
  try {
    const body = new URLSearchParams();
    body.append('secret', secret);
    body.append('response', token);
    body.append('remoteip', clientIp(request));
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    verify = await r.json();
  } catch (_) {
    return json({ error: 'Could not reach the Turnstile verification service. Try again.' }, 502);
  }
  if (!verify || verify.success !== true) {
    return json({ error: 'Turnstile verification failed. Complete the challenge and try again.', codes: (verify && verify['error-codes']) || [] }, 403);
  }

  // Mint the key: gcd_ + 32 hex chars. Store only its SHA-256 hash; return the raw key once.
  const ih = await ipHash(request, env);
  const rand = crypto.getRandomValues(new Uint8Array(16));
  const key = 'gcd_' + [...rand].map(b => b.toString(16).padStart(2, '0')).join('');
  const keyHash = await sha256Hex(key);
  const createdAt = new Date().toISOString();
  const safeLabel = label ? label.slice(0, 80) : null;

  // Atomic check-and-insert: the per-IP cap is enforced INSIDE the write statement so
  // concurrent registrations from one IP cannot race past MAX_KEYS_PER_IP (no TOCTOU).
  let res;
  try {
    res = await env.DB.prepare(
      `INSERT INTO api_keys (key_hash, label, created_at, created_ip_hash, revoked)
       SELECT ?1, ?2, ?3, ?4, 0
       WHERE (SELECT COUNT(*) FROM api_keys WHERE created_ip_hash = ?4 AND revoked = 0) < ${MAX_KEYS_PER_IP}`
    ).bind(keyHash, safeLabel, createdAt, ih).run();
  } catch (err) {
    console.error('createKey insert error:', err && err.stack || err);
    return json({ error: 'Internal error' }, 500);
  }
  if (!res || !res.meta || res.meta.changes === 0) {
    return json({ error: `Key limit reached: at most ${MAX_KEYS_PER_IP} active keys per IP. Reuse an existing key, or contact the maintainer to revoke one.` }, 403);
  }

  return json({
    _meta: { disclaimer: DISCLAIMER },
    api_key: key,
    label: safeLabel,
    created_at: createdAt,
    tier: 'keyed',
    rate_limit_per_minute: KEYED_LIMIT,
    usage: 'Send this key in the "X-API-Key" request header. Store it now - it is shown only once and cannot be recovered.',
    note: `Anonymous access (no key) is limited to about ${ANON_LIMIT} requests/minute per IP (enforced per Cloudflare location). For bulk data, download the Release files instead of paging the API.`
  }, 201);
}

// ---- /v1/me: per-key status + usage. Handled before the cache and sent no-store, because
// per-key data must never enter the shared edge cache (one caller's usage served to another). ----
async function meHandler(request, env, url) {
  const noStore = { 'Cache-Control': 'no-store' };
  const presented = request.headers.get('X-API-Key');
  let keyRow = null, keyHash = null;
  if (presented) {
    try {
      keyHash = await sha256Hex(presented);
      keyRow = await env.DB.prepare('SELECT label, created_at, revoked FROM api_keys WHERE key_hash = ?1').bind(keyHash).first();
    } catch (_) { keyRow = null; }
  }
  if (!keyRow) {
    return json({ tier: 'anon', limit_per_minute: ANON_LIMIT, register: `${url.origin}/register` }, 200, noStore);
  }
  let usage = { today: 0, last_7_days: 0, last_30_days: 0 };
  try {
    const u = await env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN day = date('now') THEN count END), 0) AS today,
         COALESCE(SUM(CASE WHEN day >= date('now','-6 day') THEN count END), 0) AS last_7_days,
         COALESCE(SUM(CASE WHEN day >= date('now','-29 day') THEN count END), 0) AS last_30_days
       FROM usage_daily WHERE key_hash = ?1`
    ).bind(keyHash).first();
    if (u) usage = { today: u.today, last_7_days: u.last_7_days, last_30_days: u.last_30_days };
  } catch (_) { /* usage is best-effort */ }
  const revoked = !!keyRow.revoked;
  return json({
    tier: 'keyed',
    limit_per_minute: revoked ? ANON_LIMIT : KEYED_LIMIT,   // a revoked key falls back to anonymous limits
    key: { label: keyRow.label, created_at: keyRow.created_at, revoked },
    usage,
    note: 'Per-minute remaining is not queryable; limits are approximate per Cloudflare location.'
  }, 200, noStore);
}

// ---- /register: self-contained HTML with a Turnstile widget (its script is the only external dep) ----
function registerPage(env) {
  const sitekey = env.TURNSTILE_SITEKEY || '1x00000000000000000000AA';
  if (TEST_SITEKEYS.includes(sitekey)) console.warn(`/register is serving a Cloudflare TEST sitekey (${sitekey}); replace TURNSTILE_SITEKEY before production.`);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get a free API key - gcg-api</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 2rem 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .sub { opacity: .75; margin-top: 0; }
  label { display: block; font-weight: 600; margin: 1rem 0 .35rem; }
  input[type=text] { width: 100%; padding: .55rem .6rem; font-size: 1rem; box-sizing: border-box; border: 1px solid #8888; border-radius: 6px; background: transparent; color: inherit; }
  button { margin-top: 1.25rem; padding: .6rem 1.1rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .tiers { font-size: .9rem; opacity: .85; border: 1px solid #8884; border-radius: 8px; padding: .75rem 1rem; margin-top: 1.5rem; }
  .tiers code { font-weight: 700; }
  #out { margin-top: 1.5rem; }
  .keybox { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.05rem; word-break: break-all; padding: .75rem; border: 2px solid #3a7; border-radius: 8px; background: #3a71; }
  .warn { color: #c60; font-weight: 600; margin-top: .5rem; }
  .err { color: #c33; font-weight: 600; }
  .disclaimer { font-size: .78rem; opacity: .6; margin-top: 2rem; }
  a { color: inherit; }
</style>
</head>
<body>
  <h1>Get a free gcg-api key</h1>
  <p class="sub">Keys are optional. They raise your rate limit from about ${ANON_LIMIT} to about ${KEYED_LIMIT} requests per minute.</p>

  <form id="form">
    <label for="label">Label (optional)</label>
    <input type="text" id="label" name="label" maxlength="80" placeholder="e.g. my-deckbuilder">
    <div class="cf-turnstile" data-sitekey="${sitekey}" style="margin-top:1rem"></div>
    <button type="submit" id="submit">Request key</button>
  </form>

  <div id="out"></div>

  <div class="tiers">
    <div><code>Keyless</code> - up to about ${ANON_LIMIT} requests/min per IP</div>
    <div><code>Free key</code> - up to about ${KEYED_LIMIT} requests/min (send it in the <code>X-API-Key</code> header)</div>
    <div>Limits are enforced per Cloudflare location, so they are approximate ceilings.</div>
    <div>Bulk consumers should download the <a href="/v1/bulk">Release files</a> instead of paging the API.</div>
    <div style="margin-top:.4rem">Full API docs: <a href="/docs">/docs</a></div>
  </div>

  <p class="disclaimer">${DISCLAIMER}</p>

<script>
  const form = document.getElementById('form');
  const out = document.getElementById('out');
  const submit = document.getElementById('submit');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    out.innerHTML = '';
    const token = (document.querySelector('[name="cf-turnstile-response"]') || {}).value || '';
    if (!token) { out.innerHTML = '<p class="err">Please complete the challenge first.</p>'; return; }
    submit.disabled = true;
    try {
      const res = await fetch('/v1/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, label: document.getElementById('label').value })
      });
      const data = await res.json();
      if (!res.ok) {
        out.innerHTML = '<p class="err">' + (data.error || 'Request failed.') + '</p>';
        if (window.turnstile) window.turnstile.reset();
        submit.disabled = false;
        return;
      }
      out.innerHTML = '<p>Your API key (shown once):</p><div class="keybox">' + data.api_key + '</div>' +
        '<p class="warn">Copy it now. It cannot be recovered - if you lose it, request a new one.</p>' +
        '<p>Use it as the <code>X-API-Key</code> header. Limit: about ' + data.rate_limit_per_minute + ' req/min.</p>';
      form.style.display = 'none';
    } catch (err) {
      out.innerHTML = '<p class="err">Network error. Please try again.</p>';
      if (window.turnstile) window.turnstile.reset();
      submit.disabled = false;
    }
  });
</script>
</body>
</html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } });
}

async function route(url, env, version) {
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/' || p === '/health') {
    const limiterOk = !!(env.RL_ANON && typeof env.RL_ANON.limit === 'function' && env.RL_KEYED && typeof env.RL_KEYED.limit === 'function');
    return json({
      ok: true,
      service: 'gcg-api',
      description: 'Free, unofficial Gundam Card Game data API.',
      version,
      rate_limiter: limiterOk ? 'active' : 'fail-open (binding missing)',
      docs: `${url.origin}/docs`,
      openapi: `${url.origin}/openapi.json`,
      register: `${url.origin}/register`,
      repository: 'https://github.com/yzRobo/gcg-api',
      homepage: 'https://gcgapi.com',
      disclaimer: DISCLAIMER
    });
  }

  if (p === '/docs') return docsPage(url);
  if (p === '/openapi.json') return json(openapiSpec(url));

  if (p === '/v1/manifest') {
    return json({ dataset_version: version, card_count: await cardCount(env), ruling_count: await rulingCount(env), product_count: await productCount(env), bulk_url: `${url.origin}/v1/bulk`, disclaimer: DISCLAIMER });
  }

  // Redirect bulk downloads to the rolling Release asset - no Worker compute.
  // BULK_URL is config, not code: it lives in wrangler.toml [vars] (the Workers env).
  if (p === '/v1/bulk') {
    if (!env.BULK_URL) return json({ error: 'BULK_URL not configured' }, 501);
    return new Response(null, { status: 302, headers: { Location: env.BULK_URL, ...CORS } });
  }

  if (p === '/v1/sets') {
    // Prefer the precomputed summary (O(1)); fall back to a GROUP BY scan if absent.
    const meta = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'sets_summary'`).first();
    if (meta && meta.value) {
      try { return json({ _meta: { disclaimer: DISCLAIMER }, data: JSON.parse(meta.value) }); } catch (_) { /* fall through */ }
    }
    const { results } = await env.DB.prepare(
      `SELECT set_code, MAX(set_name) AS set_name, COUNT(*) AS card_count FROM cards GROUP BY set_code ORDER BY set_code`
    ).all();
    return json({ _meta: { disclaimer: DISCLAIMER }, data: results });
  }

  let m;
  if ((m = p.match(/^\/v1\/sets\/([^/]+)\/cards$/))) {
    const { results } = await env.DB.prepare(`SELECT * FROM cards WHERE set_code = ?1 ORDER BY card_number`).bind(m[1].toUpperCase()).all();
    return json({ _meta: { disclaimer: DISCLAIMER, count: results.length }, data: results.map(hydrate) });
  }

  if ((m = p.match(/^\/v1\/sets\/([^/]+)\/products$/))) {
    // Products sharing a set_code (e.g. GD01 -> its booster plus any related product). No JSON
    // columns on products, so rows are returned verbatim (unlike cards, which need hydrate()).
    // product_id is a stable tiebreak so same-date rows keep a deterministic (cache-stable) order.
    const { results } = await env.DB.prepare(`SELECT * FROM products WHERE set_code = ?1 ORDER BY release_date, product_id`).bind(m[1].toUpperCase()).all();
    return json({ _meta: { disclaimer: DISCLAIMER, count: results.length }, data: results });
  }

  if ((m = p.match(/^\/v1\/cards\/([^/]+)$/))) {
    let id;
    try { id = decodeURIComponent(m[1]); } catch (_) { return json({ error: 'Bad request: malformed id' }, 400); }
    // Point lookup on the PRIMARY KEY first; only fall back to the (now indexed) card_number.
    // A card_number match returns the base printing (GD01-001 sorts before GD01-001_p1).
    let row = await env.DB.prepare(`SELECT * FROM cards WHERE product_id = ?1 LIMIT 1`).bind(id).first();
    if (!row) row = await env.DB.prepare(`SELECT * FROM cards WHERE card_number = ?1 ORDER BY product_id LIMIT 1`).bind(id).first();
    if (!row) return json({ error: 'Not found' }, 404);
    const card = hydrate(row);
    if ((url.searchParams.get('include') || '').split(',').map((s) => s.trim()).includes('rulings')) {
      // Link-only official rulings for this card_number (num/date/question + source_url; no answer prose).
      const { results } = await env.DB.prepare(`SELECT num, date, question, source_url FROM rulings WHERE card_number = ?1 ORDER BY num`).bind(card.card_number).all();
      card.rulings = results;
    }
    return json({ _meta: { disclaimer: DISCLAIMER }, data: card });
  }

  if (p === '/v1/cards') {
    const q = url.searchParams;
    const where = [];
    const binds = [];
    // exact-ish filters
    if (q.get('set_code')) { binds.push(q.get('set_code').toUpperCase()); where.push(`set_code = ?${binds.length}`); }
    if (q.get('card_type')) { binds.push(q.get('card_type').toUpperCase()); where.push(`UPPER(card_type) = ?${binds.length}`); }
    if (q.get('color')) { binds.push(q.get('color')); where.push(`color = ?${binds.length}`); }
    if (q.get('rarity')) { binds.push(q.get('rarity')); where.push(`rarity = ?${binds.length}`); }
    for (const numf of ['level', 'cost', 'ap', 'hp']) { const n = parseInt(q.get(numf) || '', 10); if (!Number.isNaN(n)) { binds.push(n); where.push(`${numf} = ?${binds.length}`); } } // NaN guard: garbage input is ignored instead of becoming a 500
    // substring search
    if (q.get('name')) { binds.push(`%${q.get('name')}%`); where.push(`name LIKE ?${binds.length}`); }
    if (q.get('effect')) { binds.push(`%${q.get('effect')}%`); where.push(`effect LIKE ?${binds.length}`); }
    // keyword ability / timing marker (matches the denormalized keywords_text, case-insensitive)
    if (q.get('keyword')) { binds.push(`%${q.get('keyword').toLowerCase()}%`); where.push(`keywords_text LIKE ?${binds.length}`); }

    const limit = Math.min(Math.max(parseInt(q.get('limit') || '100', 10) || 100, 1), 250); // clamp to >=1: in SQLite a negative LIMIT means "no limit"
    const offset = Math.min(Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0), 1000000); // upper clamp: a huge offset would overflow i64 -> 500
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // Unfiltered total is a static count served O(1) from meta; filtered totals use the indexes.
    const total = where.length
      ? (await env.DB.prepare(`SELECT COUNT(*) AS n FROM cards ${clause}`).bind(...binds).first()).n
      : await cardCount(env);
    const { results } = await env.DB.prepare(`SELECT * FROM cards ${clause} ORDER BY card_number LIMIT ${limit} OFFSET ${offset}`).bind(...binds).all();
    return json({ _meta: { disclaimer: DISCLAIMER, total, limit, offset, count: results.length }, data: results.map(hydrate) });
  }

  // ---- Products (supplementary): metadata for boosters, starter decks, accessories, promos ----
  if ((m = p.match(/^\/v1\/products\/([^/]+)$/))) {
    let id;
    try { id = decodeURIComponent(m[1]); } catch (_) { return json({ error: 'Bad request: malformed id' }, 400); }
    // product_id slugs are always lowercase (built by slugFromUrl), so lowercase the lookup to
    // be forgiving of /v1/products/ST10; there is no case where a stored id has uppercase.
    const row = await env.DB.prepare(`SELECT * FROM products WHERE product_id = ?1 LIMIT 1`).bind(id.toLowerCase()).first();
    if (!row) return json({ error: 'Not found' }, 404);
    return json({ _meta: { disclaimer: DISCLAIMER }, data: row });
  }

  if (p === '/v1/products') {
    const q = url.searchParams;
    const where = [];
    const binds = [];
    // category = case-insensitive exact on category_tag (accepts boosterpack). Products with a
    // null category_tag (e.g. limitedbox-beta) simply never match a ?category= filter.
    if (q.get('category')) { binds.push(q.get('category').toUpperCase()); where.push(`UPPER(category_tag) = ?${binds.length}`); }
    if (q.get('set_code')) { binds.push(q.get('set_code').toUpperCase()); where.push(`set_code = ?${binds.length}`); }
    if (q.get('name')) { binds.push(`%${q.get('name')}%`); where.push(`name LIKE ?${binds.length}`); }

    const limit = Math.min(Math.max(parseInt(q.get('limit') || '100', 10) || 100, 1), 250); // same clamps as /v1/cards
    const offset = Math.min(Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0), 1000000);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = where.length
      ? (await env.DB.prepare(`SELECT COUNT(*) AS n FROM products ${clause}`).bind(...binds).first()).n
      : await productCount(env);
    // Newest first; nulls last (unreleased/undated sink to the bottom), product_id as a stable tiebreak.
    const { results } = await env.DB.prepare(`SELECT * FROM products ${clause} ORDER BY release_date IS NULL, release_date DESC, product_id LIMIT ${limit} OFFSET ${offset}`).bind(...binds).all();
    return json({ _meta: { disclaimer: DISCLAIMER, total, limit, offset, count: results.length }, data: results });
  }

  return json({ error: 'Not found', endpoints: ['/v1/cards', '/v1/cards/:id', '/v1/products', '/v1/products/:id', '/v1/sets', '/v1/sets/:code/cards', '/v1/sets/:code/products', '/v1/bulk', '/v1/manifest', '/v1/me', '/register', '/docs', '/openapi.json'], docs: `${url.origin}/docs` }, 404);
}

// ---- OpenAPI 3 spec (served at /openapi.json). Kept in sync with route() by hand. ----
const CARD_SCHEMA = {
  type: 'object',
  properties: {
    product_id: { type: 'string', description: 'Natural key; unique per printing. Alt-arts get a _p1/_p2 suffix (e.g. GD01-001_p1).' },
    card_number: { type: 'string', description: 'e.g. GD01-001. Shared across alt-art printings.' },
    name: { type: 'string' },
    set_code: { type: 'string', description: 'e.g. GD01, ST01, EB01.' },
    set_name: { type: 'string' },
    rarity: { type: 'string' },
    card_type: { type: 'string', description: 'UNIT, PILOT, COMMAND, BASE, RESOURCE, plus token/EX variants.' },
    color: { type: ['string', 'null'], description: 'Blue/Green/Red/White/Purple; null = colorless.' },
    level: { type: ['integer', 'null'] },
    cost: { type: ['integer', 'null'] },
    ap: { type: ['integer', 'null'], description: 'Attack. Present on UNITs.' },
    hp: { type: ['integer', 'null'] },
    zone: { type: ['string', 'null'] },
    trait: { type: ['string', 'null'] },
    link: { type: ['string', 'null'] },
    source_title: { type: ['string', 'null'] },
    block_icon: { type: ['string', 'null'] },
    sp: { type: ['string', 'null'] },
    effect: { type: 'string', description: 'Card text; newlines preserved.' },
    image_url: { type: 'string', description: 'Absolute gundam-gcg.com URL. NOT rehosted by this project.' },
    detail_url: { type: ['string', 'null'] },
    ap_raw: { type: ['string', 'null'], description: 'Raw AP string; preserves PILOT "+1"/"+2" modifiers.' },
    hp_raw: { type: ['string', 'null'], description: 'Raw HP string; preserves PILOT modifiers.' },
    where_to_get: { type: ['string', 'null'], description: 'Product/event this printing came from (unique for promos).' },
    traits: { type: 'array', items: { type: 'string' }, description: 'Trait tags, e.g. ["Earth Federation","White Base Team"].' },
    link_refs: { type: 'array', items: { type: 'string' }, description: 'Link references ([pilot] names / (trait) conditions).' },
    keyword_effects: { type: 'array', items: { type: 'object', properties: { keyword: { type: 'string' }, value: { type: ['integer', 'null'] } } }, description: 'Keyword abilities parsed from effect text, e.g. [{keyword:"Repair",value:1}].' },
    timing_markers: { type: 'array', items: { type: 'string' }, description: 'Effect timing tokens, e.g. ["Burst","Main"].' },
    keywords_text: { type: ['string', 'null'], description: 'Denormalized lowercase keyword+timing text used by the ?keyword= filter.' }
  }
};

const PRODUCT_SCHEMA = {
  type: 'object',
  properties: {
    product_id: { type: 'string', description: 'Natural key: the detail-page filename slug, e.g. gd06, st10, deck-case02. Always lowercase.' },
    name: { type: 'string', description: 'Product name as shown, e.g. "Generation Pulse [ST10]".' },
    category_tag: { type: ['string', 'null'], description: 'Machine tag backing the ?category= filter: BOOSTERPACK, STARTERDECK, ACCESSORIES, PREMIUMBANDAI, OTHER. Null for a few uncategorized products.' },
    category_label: { type: ['string', 'null'], description: 'Human label, e.g. "BOOSTER PACK".' },
    set_code: { type: ['string', 'null'], description: 'Set code parsed from the name bracket (e.g. GD06, ST11); null for accessories without a set.' },
    release_date: { type: ['string', 'null'], description: 'ISO YYYY-MM-DD, or null if unknown/unparseable.' },
    release_date_raw: { type: ['string', 'null'], description: 'Verbatim source text (may carry a trailing "~" or a region note).' },
    msrp: { type: ['string', 'null'], description: 'Verbatim MSRP string, e.g. "$15.99"; null for unreleased ("-").' },
    msrp_value: { type: ['number', 'null'], description: 'Numeric MSRP parsed from msrp.' },
    contents: { type: ['string', 'null'], description: 'Factual product-composition list from the detail page; marketing prose is excluded.' },
    image_url: { type: 'string', description: 'Absolute gundam-gcg.com URL. NOT rehosted by this project.' },
    product_url: { type: 'string', description: 'Official product detail page.' }
  }
};

function openapiSpec(url) {
  const cardFilters = [
    ['set_code', 'string', 'Exact set code, e.g. GD01 (case-insensitive).'],
    ['card_type', 'string', 'Exact card type, e.g. UNIT (case-insensitive).'],
    ['color', 'string', 'Exact color, e.g. Blue.'],
    ['rarity', 'string', 'Exact rarity code.'],
    ['level', 'integer', 'Exact level.'],
    ['cost', 'integer', 'Exact cost.'],
    ['ap', 'integer', 'Exact AP.'],
    ['hp', 'integer', 'Exact HP.'],
    ['name', 'string', 'Case-insensitive substring match on name.'],
    ['effect', 'string', 'Case-insensitive substring match on effect text.'],
    ['keyword', 'string', 'Cards with a given keyword ability or timing marker (e.g. Blocker, Repair, Burst). Case-insensitive.']
  ].map(([name, type, description]) => ({ name, in: 'query', required: false, schema: { type }, description }));
  cardFilters.push({ name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 100, minimum: 1, maximum: 250 }, description: 'Page size (clamped 1-250).' });
  cardFilters.push({ name: 'offset', in: 'query', required: false, schema: { type: 'integer', default: 0, minimum: 0, maximum: 1000000 }, description: 'Page offset.' });

  const productFilters = [
    ['category', 'string', 'Exact category tag, case-insensitive: BOOSTERPACK, STARTERDECK, ACCESSORIES, PREMIUMBANDAI, OTHER.'],
    ['set_code', 'string', 'Exact set code, e.g. GD06 (case-insensitive).'],
    ['name', 'string', 'Case-insensitive substring match on name.']
  ].map(([name, type, description]) => ({ name, in: 'query', required: false, schema: { type }, description }));
  productFilters.push({ name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 100, minimum: 1, maximum: 250 }, description: 'Page size (clamped 1-250).' });
  productFilters.push({ name: 'offset', in: 'query', required: false, schema: { type: 'integer', default: 0, minimum: 0, maximum: 1000000 }, description: 'Page offset.' });

  return {
    openapi: '3.0.3',
    info: {
      title: 'gcg-api',
      version: '1',
      description: 'Free, unofficial read-only REST API for Gundam Card Game data. Not affiliated with Bandai. ' + DISCLAIMER,
      license: { name: 'MIT (code) / ODbL-1.0 (data compilation; pre-2026-07-07 snapshots remain CC0)', url: 'https://github.com/yzRobo/gcg-api' }
    },
    servers: [{ url: url.origin }],
    tags: [{ name: 'cards' }, { name: 'products' }, { name: 'sets' }, { name: 'meta' }, { name: 'keys' }],
    paths: {
      '/v1/cards': {
        get: {
          tags: ['cards'], summary: 'List/filter cards', parameters: cardFilters,
          responses: { '200': { description: 'Matching cards with pagination metadata' } }
        }
      },
      '/v1/cards/{id}': {
        get: {
          tags: ['cards'], summary: 'Get one card by product_id or card_number',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'product_id (e.g. GD01-001_p1) or card_number (e.g. GD01-001; returns the base printing).' },
            { name: 'include', in: 'query', required: false, schema: { type: 'string', enum: ['rulings'] }, description: 'Comma-separated extras. "rulings" attaches the card\'s official FAQ rulings (link-only: number, date, question + source_url; the answer prose is not reproduced).' }
          ],
          responses: { '200': { description: 'The card' }, '404': { description: 'Not found' } }
        }
      },
      '/v1/products': {
        get: {
          tags: ['products'], summary: 'List/filter products (boosters, starter decks, accessories, promos)', parameters: productFilters,
          responses: { '200': { description: 'Matching products, newest first, with pagination metadata' } }
        }
      },
      '/v1/products/{id}': {
        get: {
          tags: ['products'], summary: 'Get one product by product_id',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'product_id slug, e.g. st10 or gd06 (case-insensitive).' }],
          responses: { '200': { description: 'The product' }, '404': { description: 'Not found' } }
        }
      },
      '/v1/sets': {
        get: { tags: ['sets'], summary: 'List sets with card counts', responses: { '200': { description: 'Sets' } } }
      },
      '/v1/sets/{code}/cards': {
        get: {
          tags: ['sets'], summary: 'All cards in a set',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' }, description: 'Set code, e.g. GD01.' }],
          responses: { '200': { description: 'Cards in the set' } }
        }
      },
      '/v1/sets/{code}/products': {
        get: {
          tags: ['sets'], summary: 'All products for a set code',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' }, description: 'Set code, e.g. GD06.' }],
          responses: { '200': { description: 'Products for the set' } }
        }
      },
      '/v1/manifest': {
        get: { tags: ['meta'], summary: 'Dataset version, card count, ruling count, product count, bulk URL', responses: { '200': { description: 'Manifest' } } }
      },
      '/v1/me': {
        get: { tags: ['keys'], summary: 'Your API key status, tier, limit, and usage (today / 7d / 30d). Send X-API-Key; response is never cached.', responses: { '200': { description: 'Key status + usage (keyed), or anon tier info' } } }
      },
      '/v1/bulk': {
        get: { tags: ['meta'], summary: 'Redirect (302) to the full NDJSON dataset on the GitHub Release', responses: { '302': { description: 'Redirect to the bulk file' } } }
      },
      '/register': {
        get: { tags: ['keys'], summary: 'HTML page to self-register a free API key (Cloudflare Turnstile challenge)', responses: { '200': { description: 'HTML registration page' } } }
      },
      '/v1/keys': {
        post: {
          tags: ['keys'],
          summary: 'Issue a free API key. Requires a valid Cloudflare Turnstile token (obtained via /register in a browser).',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string', description: 'Turnstile response token.' }, label: { type: 'string', description: 'Optional label.' } } } } } },
          responses: { '201': { description: 'Key issued (shown once)' }, '400': { description: 'Missing token / bad body' }, '403': { description: 'Turnstile failed or per-IP key cap reached' }, '429': { description: 'Rate limited' }, '501': { description: 'Registration not configured' } }
        }
      }
    },
    components: {
      schemas: { Card: CARD_SCHEMA, Product: PRODUCT_SCHEMA },
      securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Optional. Raises the rate limit from ~60 to ~300 requests/minute.' } }
    }
  };
}

function docsPage(url) {
  const base = url.origin;
  // The table of contents ("On this page") is rendered twice: a sticky scroll-spy sidebar
  // on wide screens and a collapsible <details> at the top of the content on narrow ones.
  const TOC = [
    ['limits', 'Rate limits &amp; keys'],
    ['endpoints', 'Endpoints'],
    ['cards-params', 'Query parameters', 'sub'],
    ['examples', 'Examples', 'sub'],
    ['responses', 'Response format'],
    ['schema', 'Card schema'],
    ['products', 'Products'],
    ['rulings', 'Rulings'],
    ['bulk', 'Bulk download'],
    ['caching', 'Caching &amp; CORS'],
    ['license', 'License &amp; attribution']
  ];
  const tocLinks = TOC.map(([id, label, sub]) => `<a href="#${id}"${sub ? ' class="sub"' : ''}>${label}</a>`).join('\n    ');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gcg-api - Gundam Card Game data API</title>
<meta name="description" content="Documentation for gcg-api: a free, unofficial read-only REST API and downloadable dataset for the Gundam Card Game.">
<style>
  :root { color-scheme: light dark; --border: #8883; --muted: #8889; --accent: #3a7; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 1120px; margin: 0 auto; padding: 2rem 1.25rem 4rem; line-height: 1.55; }
  .layout { display: grid; grid-template-columns: 215px minmax(0, 1fr); gap: 2.75rem; }
  main { min-width: 0; }
  nav.toc { position: sticky; top: 1.25rem; align-self: start; max-height: calc(100vh - 2.5rem); overflow-y: auto; font-size: .85rem; }
  nav.toc .toc-title { font-size: .7rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0 0 .5rem; }
  nav.toc a { display: block; color: var(--muted); text-decoration: none; padding: .22rem .65rem; border-left: 2px solid var(--border); }
  nav.toc a.sub { padding-left: 1.4rem; font-size: .8rem; }
  nav.toc a:hover { color: inherit; }
  nav.toc a.active { color: var(--accent); border-left-color: var(--accent); font-weight: 600; }
  details.toc-m { display: none; border: 1px solid var(--border); border-radius: 8px; padding: .6rem .9rem; margin: 1rem 0 1.5rem; font-size: .9rem; }
  details.toc-m summary { cursor: pointer; font-weight: 600; }
  details.toc-m a { display: block; padding: .25rem 0; }
  @media (max-width: 900px) {
    .layout { display: block; }
    nav.toc { display: none; }
    details.toc-m { display: block; }
  }
  section { scroll-margin-top: 1rem; }
  h1 { font-size: 1.7rem; margin-bottom: .2rem; }
  h2 { font-size: 1.25rem; margin-top: 2.2rem; border-bottom: 1px solid var(--border); padding-bottom: .3rem; }
  h3 { font-size: 1rem; margin-top: 1.4rem; }
  h2 .anchor, h3 .anchor { color: var(--muted); text-decoration: none; opacity: 0; margin-left: .35rem; font-weight: 400; }
  h2:hover .anchor, h3:hover .anchor, .anchor:focus-visible { opacity: 1; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { background: #8882; padding: .1rem .35rem; border-radius: 4px; font-size: .9em; }
  pre { background: #8881; border: 1px solid var(--border); border-radius: 8px; padding: .8rem 1rem; overflow-x: auto; font-size: .85rem; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; font-size: .88rem; margin: .5rem 0; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--border); padding: .35rem .55rem; text-align: left; vertical-align: top; }
  th { background: #8882; }
  .muted { color: var(--muted); }
  .pill { display: inline-block; font-size: .72rem; font-weight: 700; padding: .1rem .4rem; border-radius: 4px; background: var(--accent); color: #000; margin-right: .4rem; }
  .pill.post { background: #b80; }
  .note { border-left: 3px solid var(--accent); padding: .5rem .9rem; margin: 1rem 0; background: #3a71; border-radius: 0 6px 6px 0; }
  .disclaimer { font-size: .82rem; color: var(--muted); margin-top: 2.5rem; border-top: 1px solid var(--border); padding-top: 1rem; }
  main a, details.toc-m a { color: inherit; }
</style>
</head>
<body>
<div class="layout">
  <nav class="toc" aria-label="On this page">
    <p class="toc-title">On this page</p>
    ${tocLinks}
  </nav>
  <main>
  <h1>gcg-api</h1>
  <p class="muted">Free, unofficial read-only REST API and downloadable dataset for the Gundam Card Game.</p>
  <p>Base URL: <code>${base}</code> &nbsp;|&nbsp; <a href="${base}/openapi.json">OpenAPI spec</a> &nbsp;|&nbsp; <a href="https://github.com/yzRobo/gcg-api">GitHub</a> &nbsp;|&nbsp; <a href="https://gcgapi.com">Home</a></p>

  <details class="toc-m"><summary>On this page</summary>
    ${tocLinks}
  </details>

  <div class="note">The card data files are the source of truth; this API is a convenience layer over them. For the whole dataset, download the bulk file (see below) rather than paging the API.</div>

  <section id="limits">
  <h2>Rate limits &amp; keys <a class="anchor" href="#limits" aria-label="Link to this section">#</a></h2>
  <ul>
    <li><b>Keyless</b>: up to ~${ANON_LIMIT} requests/minute per IP. No signup.</li>
    <li><b>Free key</b>: up to ~${KEYED_LIMIT} requests/minute. Get one at <a href="${base}/register">/register</a> and send it as the <code>X-API-Key</code> header.</li>
  </ul>
  <p class="muted">Limits are enforced per Cloudflare location, so they are approximate ceilings. Over the limit returns <code>429</code> with a <code>Retry-After</code> header.</p>
  <p>Check a key's status and usage at <code>/v1/me</code> (send the key as <code>X-API-Key</code>): active/revoked, tier, limit, and request counts for today / last 7 days / last 30 days. Usage is counted per key per day; anonymous traffic is never tracked. Per-minute remaining is not queryable by design. A browser version lives at <a href="https://gcgapi.com/key">gcgapi.com/key</a>.</p>
  </section>

  <section id="endpoints">
  <h2>Endpoints <a class="anchor" href="#endpoints" aria-label="Link to this section">#</a></h2>
  <table>
    <tr><th>Method / Path</th><th>Description</th></tr>
    <tr><td><span class="pill">GET</span><code>/v1/cards</code></td><td>List/filter cards. Query params below.</td></tr>
    <tr><td><span class="pill">GET</span><code>/v1/cards/{id}</code></td><td>One card by <code>product_id</code> or <code>card_number</code> (a card_number returns the base printing). Add <code>?include=rulings</code> for official FAQ rulings (link-only).</td></tr>
    <tr><td><span class="pill">GET</span><code>/v1/products</code></td><td>List/filter products (boosters, starter decks, accessories, promos). Query params below.</td></tr>
    <tr><td><span class="pill">GET</span><code>/v1/products/{id}</code></td><td>One product by <code>product_id</code> slug, e.g. <code>st10</code>.</td></tr>
    <tr><td><span class="pill">GET</span><code>/v1/sets</code></td><td>All sets with card counts.</td></tr>
    <tr><td><span class="pill">GET</span><code>/v1/sets/{code}/cards</code></td><td>All cards in a set, e.g. <code>GD01</code>. Unpaginated; <code>_meta.count</code> has the size.</td></tr>
    <tr><td><span class="pill">GET</span><code>/v1/sets/{code}/products</code></td><td>All products for a set code, e.g. <code>GD06</code>. Unpaginated.</td></tr>
    <tr><td><span class="pill">GET</span><code>/v1/manifest</code></td><td>Dataset version, card count, ruling count, product count, bulk URL.</td></tr>
    <tr><td><span class="pill">GET</span><code>/v1/bulk</code></td><td>302 redirect to the full NDJSON dataset (GitHub Release).</td></tr>
    <tr><td><span class="pill">GET</span><code>/v1/me</code></td><td>Your key status, tier, limit, and usage today/7d/30d (send <code>X-API-Key</code>; never cached).</td></tr>
    <tr><td><span class="pill">GET</span><code>/register</code></td><td>Self-serve free API key (browser challenge).</td></tr>
    <tr><td><span class="pill post">POST</span><code>/v1/keys</code></td><td>Issues a key; used by /register. Requires a Cloudflare Turnstile token.</td></tr>
    <tr><td><span class="pill">GET</span><code>/openapi.json</code></td><td>OpenAPI 3.0 spec (machine-readable).</td></tr>
    <tr><td><span class="pill">GET</span><code>/docs</code></td><td>This page.</td></tr>
  </table>
  </section>

  <section id="cards-params">
  <h3>/v1/cards query parameters <a class="anchor" href="#cards-params" aria-label="Link to this section">#</a></h3>
  <table>
    <tr><th>Param</th><th>Type</th><th>Match</th></tr>
    <tr><td>set_code, card_type, color, rarity</td><td>string</td><td>exact (set_code/card_type case-insensitive)</td></tr>
    <tr><td>level, cost, ap, hp</td><td>integer</td><td>exact (non-numeric values are ignored)</td></tr>
    <tr><td>name, effect</td><td>string</td><td>substring (case-insensitive)</td></tr>
    <tr><td>keyword</td><td>string</td><td>has a keyword ability / timing marker (e.g. Blocker, Repair, Burst)</td></tr>
    <tr><td>limit</td><td>integer</td><td>page size, 1-250 (default 100)</td></tr>
    <tr><td>offset</td><td>integer</td><td>page offset (default 0)</td></tr>
  </table>
  <p class="muted">Filters combine with AND. Unknown parameters are ignored.</p>
  </section>

  <section id="examples">
  <h3>Examples <a class="anchor" href="#examples" aria-label="Link to this section">#</a></h3>
  <pre>curl "${base}/v1/cards?color=Blue&amp;card_type=UNIT&amp;limit=5"
curl "${base}/v1/cards?name=Gundam&amp;cost=3"
curl "${base}/v1/cards?keyword=blocker&amp;color=Green"
curl "${base}/v1/cards/GD01-001"
curl "${base}/v1/cards/GD01-001?include=rulings"
curl "${base}/v1/sets"
curl "${base}/v1/sets/GD01/cards"
curl "${base}/v1/manifest"

# with a free key (higher rate limit)
curl "${base}/v1/cards?limit=250" -H "X-API-Key: gcd_your_key_here"
# key status + usage
curl "${base}/v1/me" -H "X-API-Key: gcd_your_key_here"</pre>
  </section>

  <section id="responses">
  <h2>Response format <a class="anchor" href="#responses" aria-label="Link to this section">#</a></h2>
  <p>List endpoints wrap results in an envelope; single-card responses use the same shape with an object in <code>data</code>:</p>
  <pre>{
  "_meta": { "disclaimer": "...", "total": 355, "limit": 100, "offset": 0, "count": 100 },
  "data": [ ... ]
}</pre>
  <p><code>total</code> is the full match count; <code>count</code> is the number in this page. Errors are JSON with an <code>error</code> field:</p>
  <table>
    <tr><th>Status</th><th>When</th></tr>
    <tr><td><code>400</code></td><td>Malformed card id in <code>/v1/cards/{id}</code>.</td></tr>
    <tr><td><code>404</code></td><td>Unknown card or route. Unknown routes include an <code>endpoints</code> list.</td></tr>
    <tr><td><code>405</code></td><td>Any method other than GET (plus <code>POST /v1/keys</code> and OPTIONS).</td></tr>
    <tr><td><code>429</code></td><td>Rate limited. Includes <code>tier</code> and <code>limit_per_minute</code>; carries a <code>Retry-After: 60</code> header and is never cached.</td></tr>
    <tr><td><code>5xx</code></td><td>Internal error (no detail leaked) or, for <code>/v1/keys</code>, registration not configured (501).</td></tr>
  </table>
  </section>

  <section id="schema">
  <h2>Card schema <a class="anchor" href="#schema" aria-label="Link to this section">#</a></h2>
  <table>
    <tr><th>Field</th><th>Type</th><th>Notes</th></tr>
    <tr><td>product_id</td><td>string</td><td>Natural key; unique per printing (alt-arts get _p1/_p2)</td></tr>
    <tr><td>card_number</td><td>string</td><td>e.g. GD01-001 (shared by alt-arts)</td></tr>
    <tr><td>name</td><td>string</td><td></td></tr>
    <tr><td>set_code</td><td>string</td><td>e.g. GD01, ST01, EB01</td></tr>
    <tr><td>set_name</td><td>string</td><td></td></tr>
    <tr><td>rarity</td><td>string</td><td></td></tr>
    <tr><td>card_type</td><td>string</td><td>UNIT, PILOT, COMMAND, BASE, RESOURCE, + token/EX variants</td></tr>
    <tr><td>color</td><td>string | null</td><td>Blue/Green/Red/White/Purple; null = colorless</td></tr>
    <tr><td>level, cost, ap, hp</td><td>integer | null</td><td>numeric stats</td></tr>
    <tr><td>zone, trait, link, source_title, block_icon, sp</td><td>string | null</td><td>optional fields</td></tr>
    <tr><td>effect</td><td>string</td><td>Card text; newlines preserved</td></tr>
    <tr><td>image_url</td><td>string</td><td>Absolute gundam-gcg.com URL. Images are NOT rehosted here.</td></tr>
    <tr><td>detail_url</td><td>string | null</td><td>Source detail page</td></tr>
    <tr><td>keyword_effects</td><td>array</td><td>keyword abilities from effect text, e.g. [{keyword:"Repair",value:1}]</td></tr>
    <tr><td>timing_markers</td><td>array</td><td>effect timing tokens, e.g. ["Burst","Main"]</td></tr>
    <tr><td>traits</td><td>array</td><td>trait tags, e.g. ["Earth Federation"]</td></tr>
    <tr><td>link_refs</td><td>array</td><td>link references ([pilot] / (trait))</td></tr>
    <tr><td>keywords_text</td><td>string | null</td><td>denormalized text backing the <code>keyword</code> filter</td></tr>
    <tr><td>ap_raw, hp_raw</td><td>string | null</td><td>raw stat strings; preserve PILOT "+1" modifiers</td></tr>
    <tr><td>where_to_get</td><td>string | null</td><td>product/event provenance (unique for promos)</td></tr>
  </table>
  </section>

  <section id="products">
  <h2>Products <a class="anchor" href="#products" aria-label="Link to this section">#</a></h2>
  <p>Official product metadata: booster packs, starter decks, accessories, and promo products, scraped from the official products list. Metadata only - <b>images are hotlinked, never rehosted</b>, and marketing prose is excluded (same posture as ruling answers). <code>/v1/products</code> lists newest first (undated products sort last).</p>
  <h3>Query parameters <a class="anchor" href="#products" aria-label="Link to this section">#</a></h3>
  <table>
    <tr><th>Param</th><th>Type</th><th>Match</th></tr>
    <tr><td>category</td><td>string</td><td>exact on <code>category_tag</code>, case-insensitive (e.g. <code>boosterpack</code>, <code>starterdeck</code>, <code>accessories</code>)</td></tr>
    <tr><td>set_code</td><td>string</td><td>exact, case-insensitive (e.g. <code>GD06</code>)</td></tr>
    <tr><td>name</td><td>string</td><td>substring (case-insensitive)</td></tr>
    <tr><td>limit</td><td>integer</td><td>page size, 1-250 (default 100)</td></tr>
    <tr><td>offset</td><td>integer</td><td>page offset (default 0)</td></tr>
  </table>
  <h3>Product schema <a class="anchor" href="#products" aria-label="Link to this section">#</a></h3>
  <table>
    <tr><th>Field</th><th>Type</th><th>Notes</th></tr>
    <tr><td>product_id</td><td>string</td><td>slug from the product URL (e.g. <code>st10</code>, <code>gd06</code>); PRIMARY KEY, always lowercase</td></tr>
    <tr><td>name</td><td>string</td><td>e.g. "Generation Pulse [ST10]"</td></tr>
    <tr><td>category_tag</td><td>string | null</td><td>BOOSTERPACK, STARTERDECK, ACCESSORIES, PREMIUMBANDAI, OTHER; backs the <code>category</code> filter. Null for a few uncategorized products (they never match a <code>category</code> filter)</td></tr>
    <tr><td>category_label</td><td>string | null</td><td>human label, e.g. "BOOSTER PACK"</td></tr>
    <tr><td>set_code</td><td>string | null</td><td>parsed from the name bracket; null for accessories without a set</td></tr>
    <tr><td>release_date</td><td>string | null</td><td>ISO YYYY-MM-DD, or null if unknown/unparseable</td></tr>
    <tr><td>release_date_raw</td><td>string | null</td><td>verbatim source text (may carry a "~" or region note)</td></tr>
    <tr><td>msrp</td><td>string | null</td><td>verbatim, e.g. "$15.99"; null for unreleased ("-")</td></tr>
    <tr><td>msrp_value</td><td>number | null</td><td>numeric MSRP parsed from <code>msrp</code></td></tr>
    <tr><td>contents</td><td>string | null</td><td>factual product-composition list; marketing prose excluded</td></tr>
    <tr><td>image_url</td><td>string</td><td>Absolute gundam-gcg.com URL. Images are NOT rehosted here.</td></tr>
    <tr><td>product_url</td><td>string</td><td>official product detail page</td></tr>
  </table>
  <pre>curl "${base}/v1/products?category=boosterpack"
curl "${base}/v1/products?set_code=ST10"
curl "${base}/v1/products/st10"
curl "${base}/v1/sets/GD06/products"</pre>
  <p class="muted">Products are supplementary data on the same weekly refresh; a products scrape failure never affects card data. The product total is in <code>/v1/manifest</code>.</p>
  </section>

  <section id="rulings">
  <h2>Rulings <a class="anchor" href="#rulings" aria-label="Link to this section">#</a></h2>
  <p>Official per-card FAQ rulings from the source site, captured <b>link-only</b>: the ruling number, date, and question, plus a <code>source_url</code> back to the official card page. Answer text is not reproduced - follow <code>source_url</code> to read Bandai's answer.</p>
  <pre>curl "${base}/v1/cards/GD01-001?include=rulings"

"rulings": [
  {
    "num": "Q119",
    "date": "July 11, 2025",
    "question": "Does this Unit also gain &lt;Repair: 1&gt; from the first effect?",
    "source_url": "https://www.gundam-gcg.com/en/cards/detail.php?detailSearch=GD01-001"
  }
]</pre>
  <p class="muted">Cards without rulings return an empty array. Rulings attach only on <code>/v1/cards/{id}</code>; the ruling total is in <code>/v1/manifest</code>.</p>
  </section>

  <section id="bulk">
  <h2>Bulk download <a class="anchor" href="#bulk" aria-label="Link to this section">#</a></h2>
  <p>The full dataset is a single newline-delimited JSON file, always current, on the GitHub Release:</p>
  <pre>curl -L "${base}/v1/bulk" -o cards.ndjson</pre>
  <p class="muted">The Release also carries <code>cards.json</code>, <code>manifest.json</code>, <code>rulings.json</code>, and <code>products.json</code>. Bulk downloads are unmetered - they never touch the API's rate limits.</p>
  </section>

  <section id="caching">
  <h2>Caching &amp; CORS <a class="anchor" href="#caching" aria-label="Link to this section">#</a></h2>
  <ul>
    <li>Successful GET responses are cached at Cloudflare's edge for up to 24 hours (<code>Cache-Control: public, max-age=86400</code>). Cache keys include the dataset version, so each weekly refresh serves fresh data immediately.</li>
    <li><code>/v1/me</code>, <code>/register</code>, and error responses (including 429) are never cached.</li>
    <li>CORS is open: <code>Access-Control-Allow-Origin: *</code>, with <code>Content-Type</code> and <code>X-API-Key</code> request headers allowed - the API is callable straight from a browser.</li>
    <li>Methods: GET everywhere, plus <code>POST /v1/keys</code>. Anything else returns 405.</li>
  </ul>
  </section>

  <section id="license">
  <h2>License &amp; attribution <a class="anchor" href="#license" aria-label="Link to this section">#</a></h2>
  <p>Code: <b>MIT</b>. Data compilation (factual fields only): <b>ODbL 1.0</b> - use it freely, commercially included, with attribution; publicly used derivative databases must be shared alike. Apps and works built FROM the data are yours. Dataset versions distributed before 2026-07-07 remain CC0. Neither license grants any rights in Bandai's card names, effect text, artwork, or trademarks.</p>
  <p class="muted">Suggested attribution: "Contains data from gcg-api (https://gcgapi.com), made available under the Open Database License (ODbL) v1.0."</p>
  <p class="muted">Data scraped from the official site <a href="https://www.gundam-gcg.com/en/cards">gundam-gcg.com</a>. Community prior art: <a href="https://exburst.dev">ExBurst</a>, <a href="https://egmanevents.com">EGMAN Events</a>.</p>
  <p>Issues, corrections, or takedown requests: <a href="https://github.com/yzRobo/gcg-api/issues">GitHub Issues</a>.</p>
  <p class="disclaimer">${DISCLAIMER} This project is not produced by, endorsed by, supported by, or affiliated with Bandai.</p>
  </section>
  </main>
</div>

<script>
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('nav.toc a'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  var map = {};
  links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
  var sections = Array.prototype.slice.call(document.querySelectorAll('main section[id]'));
  var visible = {};
  var current = null;
  function activate(id) {
    if (current === id) return;
    current = id;
    links.forEach(function (a) { a.classList.remove('active'); });
    if (map[id]) map[id].classList.add('active');
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting; });
    for (var i = 0; i < sections.length; i++) {
      if (visible[sections[i].id]) { activate(sections[i].id); return; }
    }
  }, { rootMargin: '0px 0px -55% 0px', threshold: 0 });
  sections.forEach(function (s) { io.observe(s); });
})();
</script>
</body>
</html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } });
}

// Static card count served from the meta table (written by the weekly import); falls back
// to a one-time COUNT(*) if the meta row is missing so the endpoint never breaks.
async function cardCount(env) {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'card_count'`).first();
  const n = row ? parseInt(row.value, 10) : NaN;
  if (!Number.isNaN(n)) return n;
  const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).first();
  return c ? c.n : 0;
}

// Static ruling count from meta (written by the weekly import); falls back to COUNT(*).
async function rulingCount(env) {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'ruling_count'`).first();
  const n = row ? parseInt(row.value, 10) : NaN;
  if (!Number.isNaN(n)) return n;
  const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM rulings`).first();
  return c ? c.n : 0;
}

// Static product count from meta (written by the weekly import); falls back to COUNT(*).
// gen-sql only writes the product_count meta row when products exist, so on a products-less
// deployment this correctly falls through to COUNT(*) (which is 0 with an empty table).
async function productCount(env) {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'product_count'`).first();
  const n = row ? parseInt(row.value, 10) : NaN;
  if (!Number.isNaN(n)) return n;
  const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM products`).first();
  return c ? c.n : 0;
}
