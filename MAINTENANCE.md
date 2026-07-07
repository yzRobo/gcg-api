# MAINTENANCE

Operational notes for gcg-api. Read alongside the code; this file captures the fragilities and
the good-faith posture that are not obvious from the source.

## Good-faith / legal posture (do not undermine)

This project scrapes and redistributes **factual** card data from the official site. The posture
that keeps it defensible:

- **Metadata only. Never host card image bytes.** `image_url` points at Bandai's own server.
  Do not add image rehosting or an image proxy on by default.
- Card **names** and **effect text** are creative expression, not pure facts. The metadata-only,
  no-image-bytes stance is the real risk reducer.
- Data compilation is **ODbL 1.0** (attribution + share-alike for derivative databases), scoped
  to factual fields only (see `LICENSE-DATA`) - it does not purport to license Bandai's IP.
  Versions distributed before 2026-07-07 remain CC0 (irrevocable for those snapshots).
- The **non-affiliation disclaimer** appears in the README, every successful (`_meta`-bearing)
  API response, `/docs`, the OpenAPI spec, and this file. Keep it on all these surfaces.
- Stay a good-faith actor: polite rate limits, descriptive User-Agent, honor `robots.txt`,
  honor takedowns.

### Takedown handling

The contact channel is **[GitHub Issues](https://github.com/yzRobo/gcg-api/issues)**. Commitment:
respond promptly and comply if Bandai (or a rightsholder) objects. To take the dataset down fast:
make the repo private, delete the `data-latest` Release, and/or clear the D1 `cards` table
(`DELETE FROM cards;`) and stop the workflow. The metadata-only posture means there are no image
files to remove.

## Known fragilities (design around these)

1. **Silent selector breakage is the top risk.** The scraper is coupled to `gundam-gcg.com`
   markup; a redesign returns empty arrays/blank fields, not errors. The **sanity gate** in
   `src/cli.js` is the guard - it aborts the run (non-zero exit fails CI) rather than publish
   garbage. Keep it strict but card-type-aware: only UNITs have AP/HP; COMMAND/RESOURCE/PILOT
   don't; colorless cards legitimately have `color = null`.
2. **A stale dataset looks trustworthy** - worse than an obviously-broken one. `dataset_version`
   (live, in `/v1/manifest`) and `built_at` (in `data/manifest.json`) surface freshness. Consider
   an alert if the last successful build is older than N days.
3. **Rate / politeness.** Hardened to **3 concurrent / 400 ms between batches + retry/backoff**.
   Do **not** raise concurrency. Keep the descriptive User-Agent
   (`Mozilla/5.0 (gundam-card-data/1.0.0; +https://github.com/yzRobo/gcg-api)`).
4. **robots.txt precheck** (`src/robots.js`). There is no robots.txt today (404 -> allowed). If
   one ever appears and disallows the cards path for our UA, `cli.js` aborts loudly like a
   sanity-gate failure. This is a deliberate good-faith guard.
5. **Alt-arts** share a `card_number` but differ by `product_id` (`_p1`/`_p2` suffix). `product_id`
   is the real natural key. `/v1/cards/{card_number}` returns the base printing (sorts before `_p1`).
6. **Bulk freshness.** `BULK_URL` points at the rolling GitHub Release asset
   (`releases/download/data-latest/cards.ndjson`), replaced on every publish - always current.
   Do not use jsDelivr `@latest`; it only resolves semver tags and our tag is `data-latest`.
7. **CI reachability.** GitHub-hosted runners use shared cloud IPs some sites block. Verified
   working as of the first run; if a future run 403s from CI but works locally, the fallback is
   to scrape locally + commit, and let the Action do only the D1 sync + Worker deploy.
8. **M5 structured extraction is coupled to effect-text formatting.** `keyword_effects` comes
   from ASCII angle brackets `<...>`; `timing_markers` from fullwidth lenticular brackets `【...】`
   split on BOTH middle-dot code points (U+30FB `・` and U+FF65 `･`); `traits`/`link_refs` from
   `(...)`/`[...]` groups. The `cli.js` sanity gate asserts >=30% of cards carry keyword/timing
   data, so a formatting change fails loudly. Known source quirk: GD02-053 renders `[Suppression]`
   in square brackets (a typo) instead of `<Suppression>`, so that one mention is not captured as
   a keyword - leave it; do not loosen the regex to square brackets (square brackets are used for
   pilot-name links and would produce false keyword hits). JSON-array columns (`keyword_effects`,
   `timing_markers`, `traits`, `link_refs`) are stored as TEXT and MUST be `JSON.parse`d by the
   Worker's `hydrate()` before returning, since every card route does `SELECT *`.
9. **Rulings are LINK-ONLY by policy.** `scraper.js` parses the per-card FAQ block
   (`.cardQaCol .qaCol` -> `.qaColNum`/`.qaColDate`/`.qaColQuestion`) and stores only the
   number, date, question, and `source_url` (the detail page) in the separate `rulings` table
   (keyed by card_number, deduped across printings) -> exposed via `/v1/cards/:id?include=rulings`.
   The ANSWER prose (`.qaColAnswer`) is deliberately NOT stored (Bandai copyright); consumers
   follow source_url for the official answer. Do not start storing answers without a deliberate
   copyright-posture change. Rulings exist on only ~a quarter of cards, so a low count is normal
   (not a scrape failure).

## Operations

### Manual refresh
- GitHub: Actions tab -> "refresh-gundam-data" -> Run workflow.
- Local: `npm install` then `npm run build` (writes `data/`, runs the sanity gate). Then
  `npm run gen-sql` and `wrangler d1 execute gundam-cards --remote --file data/import.sql -y`,
  and `cd worker && wrangler deploy --var DATASET_VERSION:<new-value>` to sync + bust cache.

### Products data (supplementary)
- Products are SUPPLEMENTARY: a products scrape failure never aborts the card refresh (try/catch
  in `cli.js`), and two guards protect the committed `data/products.json` from a bad scrape:
  - **Zero-guard**: a 0-product scrape keeps the existing file (a selector break must not wipe it).
  - **Shrink-guard**: a scrape that is >25% smaller than the committed file (`new < existing*0.75`)
    keeps the existing file. This defends against a truncated/"pager-collapsed" sweep that looks
    complete (e.g. the pager markup breaks so only page 1's ~12 items are fetched, all unique).
- The official products list has UNSTABLE pagination (tied release dates shuffle at a page
  boundary), so the scraper sweeps up to 5x and takes the first duplicate-free sweep (or the union
  as a fallback). Any guard trigger / union fallback / skipped list item is promoted to a GitHub
  `::warning::` annotation on the run summary (the run still goes green - products never fail it).
- **Recovery after a LEGITIMATE mass-delisting.** If Bandai genuinely removes many products, the
  shrink-guard will hold the old file every week (warning each run) instead of shrinking. To accept
  the new smaller set: delete `data/products.json` on `main` (commit the deletion), then run the
  workflow. With no committed baseline the shrink-guard cannot fire, so the run writes the fresh
  (smaller) set and commits it. (A normal delisting of one or two products is under the 25%
  threshold and flows through automatically.)

### Config vs secrets
- Config lives in `worker/wrangler.toml` `[vars]`: `DATASET_VERSION`, `BULK_URL`,
  `TURNSTILE_SITEKEY` (public), plus the `[[ratelimits]]` bindings and the `api.gcgapi.com`
  `custom_domain` route. `database_id` is not a secret.
- Worker secrets (via `wrangler secret put`, never committed):
  - `TURNSTILE_SECRET` - Turnstile server-side siteverify secret.
  - `IP_HASH_SALT` - random >=32-byte pepper for hashing `CF-Connecting-IP` before storage.
    **Required**: registration returns 501 without it (refuses to store a reversible IP hash).
- GitHub Actions secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts + D1 + Workers Routes edit),
  `CLOUDFLARE_ACCOUNT_ID`.

### API keys (self-serve)
- Users register at `/register` (Turnstile-gated) -> `POST /v1/keys` mints `gcd_` + 32 hex,
  stores only its SHA-256 hash in the D1 `api_keys` table, returns the raw key once.
- Cap: **3 active keys per IP** (enforced atomically in the insert). IP stored only as a salted
  hash (`created_ip_hash`).
- Tiers: keyless ~60/min (`RL_ANON`, by IP), keyed ~300/min (`RL_KEYED`, by key hash). Invalid/
  revoked/unknown keys fall back to anonymous limits (never 401). Limits are per-Cloudflare-colo
  (node-local counters) by design - approximate global ceilings, an accepted free-tier tradeoff.
- The `api_keys` table is **never** rewritten by the weekly import, so keys persist across
  refreshes. (`import.sql` rewrites `cards`, `meta`, and `rulings`; it only PRUNES `usage_daily`.)
- **Usage / `/v1/me`.** `usage_daily` (key_hash, day, count) is incremented fire-and-forget on
  KEYED requests only - anonymous traffic is never tracked (privacy + keeps D1 writes tiny). It
  is undercount-tolerant (a dropped write is a courtesy-dashboard miss, not billing) and pruned
  to 35 days by gen-sql. `/v1/me` is handled BEFORE the edge cache and sent `Cache-Control:
  no-store` - per-key data must never enter the shared cache (one caller's usage served to
  another). Per-minute remaining is intentionally not exposed (the rate-limit binding has no
  readable counter, and a per-minute figure resets before it is actionable).

### Abuse response
Revoke a specific key without deleting the row:
```
wrangler d1 execute gundam-cards --remote --command "UPDATE api_keys SET revoked=1 WHERE key_hash='<sha256-of-key>'" -y
```
The rate limiter fails **open** if a binding is missing/errors (availability over cost); `/health`
reports `rate_limiter: active | fail-open` so a misconfiguration is visible.

### Edge cache
Cached per full URL **plus `DATASET_VERSION`**. The weekly deploy bumps `DATASET_VERSION`
(`<run>-<sha>`), changing all cache keys -> fresh data served immediately, old entries expire on
their own. To bust manually, deploy with a new `--var DATASET_VERSION:<value>` (do not reuse a
recent value, or a stale entry under that key can be served again). Cache is active on the
`api.gcgapi.com` custom domain (it is inert on `*.workers.dev`).

## Future work (M5, not built)

Richer, cleanly-licensed fields that competitors lack: ban/limit lists, errata, keyword/ability
taxonomies. These would move the project from matching existing datasets to beating them. Keep the
metadata-only posture - do not add image hosting.
