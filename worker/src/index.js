// worker/src/index.js
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
};
const DISCLAIMER = 'Not affiliated with Bandai. Gundam and card images are copyright Bandai.';

// --- Rate-limit tiers (counters live in the wrangler.toml [[ratelimits]] bindings).
// NOTE: the Workers Rate Limiting binding is per-Cloudflare-location (node-local, no
// network hop), so these are approximate per-location ceilings, not hard global caps —
// an accepted free-tier tradeoff (a global counter would need a Durable Object/KV hop). ---
const ANON_LIMIT = 60;        // ~requests / minute / IP   (RL_ANON)
const KEYED_LIMIT = 300;      // ~requests / minute / key  (RL_KEYED)
const MAX_KEYS_PER_IP = 3;    // active (non-revoked) self-serve keys per IP

// Cloudflare Turnstile test credentials (only valid in dev) — warn if seen in production.
const TEST_SITEKEYS = ['1x00000000000000000000AA', '2x00000000000000000000AB', '3x00000000000000000000FF'];

// Only these query params affect a response body; the cache key is built from them
// (sorted) so junk params like ?_=<rand> cannot mint unlimited cache misses.
const CACHE_PARAMS = ['set_code', 'card_type', 'color', 'rarity', 'level', 'cost', 'ap', 'hp', 'name', 'effect', 'limit', 'offset'];

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
      if (row && !row.revoked) return { tier: 'keyed', rlKey: `k:${keyHash}` };
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
  for (const k of CACHE_PARAMS) if (sp.has(k)) parts.push(`${k}=${sp.get(k)}`);
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
          : 'Slow down — the keyed limit is about 300 requests/minute.',
        disclaimer: DISCLAIMER
      }, 429, { 'Retry-After': '60', 'Cache-Control': 'no-store' }); // 429s carry Retry-After and are never cached
    }

    // ---- Self-serve key registration (never cached) ----
    if (url.pathname === '/register' && request.method === 'GET') return registerPage(env);
    if (url.pathname === '/v1/keys' && request.method === 'POST') return createKey(request, env);

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
    usage: 'Send this key in the "X-API-Key" request header. Store it now — it is shown only once and cannot be recovered.',
    note: `Anonymous access (no key) is limited to about ${ANON_LIMIT} requests/minute per IP (enforced per Cloudflare location). For bulk data, download the Release files instead of paging the API.`
  }, 201);
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
    return json({ ok: true, service: 'gundam-card-data', version, rate_limiter: limiterOk ? 'active' : 'fail-open (binding missing)', disclaimer: DISCLAIMER });
  }

  if (p === '/v1/manifest') {
    return json({ dataset_version: version, card_count: await cardCount(env), bulk_url: `${url.origin}/v1/bulk`, disclaimer: DISCLAIMER });
  }

  // Redirect bulk downloads to the rolling Release asset — no Worker compute.
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
    return json({ _meta: { disclaimer: DISCLAIMER, count: results.length }, data: results });
  }

  if ((m = p.match(/^\/v1\/cards\/([^/]+)$/))) {
    let id;
    try { id = decodeURIComponent(m[1]); } catch (_) { return json({ error: 'Bad request: malformed id' }, 400); }
    // Point lookup on the PRIMARY KEY first; only fall back to the (now indexed) card_number.
    // A card_number match returns the base printing (GD01-001 sorts before GD01-001_p1).
    let row = await env.DB.prepare(`SELECT * FROM cards WHERE product_id = ?1 LIMIT 1`).bind(id).first();
    if (!row) row = await env.DB.prepare(`SELECT * FROM cards WHERE card_number = ?1 ORDER BY product_id LIMIT 1`).bind(id).first();
    return row ? json({ _meta: { disclaimer: DISCLAIMER }, data: row }) : json({ error: 'Not found' }, 404);
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

    const limit = Math.min(Math.max(parseInt(q.get('limit') || '100', 10) || 100, 1), 250); // clamp to >=1: in SQLite a negative LIMIT means "no limit"
    const offset = Math.min(Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0), 1000000); // upper clamp: a huge offset would overflow i64 -> 500
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // Unfiltered total is a static count served O(1) from meta; filtered totals use the indexes.
    const total = where.length
      ? (await env.DB.prepare(`SELECT COUNT(*) AS n FROM cards ${clause}`).bind(...binds).first()).n
      : await cardCount(env);
    const { results } = await env.DB.prepare(`SELECT * FROM cards ${clause} ORDER BY card_number LIMIT ${limit} OFFSET ${offset}`).bind(...binds).all();
    return json({ _meta: { disclaimer: DISCLAIMER, total, limit, offset, count: results.length }, data: results });
  }

  return json({ error: 'Not found', endpoints: ['/v1/cards', '/v1/cards/:id', '/v1/sets', '/v1/sets/:code/cards', '/v1/bulk', '/v1/manifest', '/register'] }, 404);
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
