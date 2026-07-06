# gcg-api

Free, unofficial, always-current **data + REST API for the Gundam Card Game** (Bandai GCG).
Card data is scraped weekly from the official site and published as (a) downloadable
JSON/NDJSON files and (b) a free read-only REST API.

> **Not affiliated with Bandai.** This project is not produced by, endorsed by, supported by,
> or affiliated with Bandai. Gundam and all related card names, effect text, artwork, and
> trademarks are the property of Bandai and its licensors. This project stores only factual
> metadata and **never hosts card images** — `image_url` points at Bandai's own servers.

- **API base URL:** `https://api.gcgapi.com`
- **Interactive docs:** https://api.gcgapi.com/docs
- **OpenAPI spec:** https://api.gcgapi.com/openapi.json
- **Refreshed:** weekly (Mondays, 06:00 UTC). See `/v1/manifest` for the current version.

---

## Two ways to consume (both free)

**1. Download the files** (the source of truth). Zero compute, cannot hit a rate limit:

```bash
# whole dataset, always current (newline-delimited JSON, one card per line)
curl -L "https://api.gcgapi.com/v1/bulk" -o cards.ndjson
```

The files also live in this repo under [`data/`](data/): `cards.ndjson`, `cards.json`,
per-set files in `cards/en/*.json`, a set index in `sets/en/index.json`, and `manifest.json`.

**2. Query the API** (a convenience layer over the files):

```bash
curl "https://api.gcgapi.com/v1/cards?color=Blue&card_type=UNIT&limit=5"
curl "https://api.gcgapi.com/v1/cards/GD01-001"
curl "https://api.gcgapi.com/v1/sets"
```

**The files are the source of truth; the API is a convenience over them.** If the API is ever
retired, the dataset still lives in the repo and Releases — nobody is stranded.

---

## Rate limits & API keys

| Tier | Limit | How |
|---|---|---|
| Keyless | ~60 requests / minute / IP | no signup |
| Free key | ~300 requests / minute | get one at [`/register`](https://api.gcgapi.com/register), send it as the `X-API-Key` header |

Keys are optional and free. Register in a browser (a Cloudflare Turnstile challenge), copy the
`gcd_...` key (shown once), and send it as a header:

```bash
curl "https://api.gcgapi.com/v1/cards?limit=250" -H "X-API-Key: gcd_your_key_here"
```

Limits are enforced per Cloudflare location, so they are approximate ceilings. Over the limit
returns `429` with a `Retry-After` header. For bulk data, download the file instead of paging.

---

## API reference

| Method / Path | Description |
|---|---|
| `GET /v1/cards` | List/filter cards (query params below) |
| `GET /v1/cards/{id}` | One card by `product_id` or `card_number` (a `card_number` returns the base printing) |
| `GET /v1/sets` | All sets with card counts |
| `GET /v1/sets/{code}/cards` | All cards in a set, e.g. `GD01` |
| `GET /v1/manifest` | Dataset version, card count, bulk URL |
| `GET /v1/bulk` | 302 redirect to the full NDJSON dataset |
| `GET /register` | Self-serve free API key page |

`GET /v1/cards` query parameters (combine freely):

| Param | Type | Match |
|---|---|---|
| `set_code`, `card_type`, `color`, `rarity` | string | exact (`set_code`/`card_type` case-insensitive) |
| `level`, `cost`, `ap`, `hp` | integer | exact |
| `name`, `effect` | string | substring (case-insensitive) |
| `limit` | integer | page size, 1–250 (default 100) |
| `offset` | integer | page offset (default 0) |

List responses wrap results as `{ "_meta": { total, limit, offset, count, disclaimer }, "data": [ ... ] }`.

---

## Card schema

| Field | Type | Notes |
|---|---|---|
| `product_id` | string | **Natural key.** Unique per printing; alt-arts get a `_p1`/`_p2` suffix (e.g. `GD01-001_p1`) |
| `card_number` | string | e.g. `GD01-001` (shared across alt-art printings) |
| `name` | string | |
| `set_code` | string | e.g. `GD01`, `ST01`, `EB01` |
| `set_name` | string | |
| `rarity` | string | |
| `card_type` | string | `UNIT`, `PILOT`, `COMMAND`, `BASE`, `RESOURCE`, plus token/EX variants |
| `color` | string \| null | `Blue`/`Green`/`Red`/`White`/`Purple`; `null` = colorless |
| `level` | int \| null | site "Lv." |
| `cost` | int \| null | |
| `ap` | int \| null | attack (present on UNITs) |
| `hp` | int \| null | |
| `zone` | string \| null | |
| `trait` | string \| null | |
| `link` | string \| null | |
| `source_title` | string \| null | |
| `block_icon` | string \| null | |
| `sp` | string \| null | |
| `effect` | string | card text; newlines preserved |
| `image_url` | string | absolute `gundam-gcg.com` URL — **not** rehosted here |
| `detail_url` | string \| null | source detail page |

---

## How it works

```
gundam-gcg.com  --weekly scrape-->  GitHub Actions  --> GitHub Release (files) + Cloudflare D1
                                                              |
                                          Cloudflare Worker (/v1 API + edge cache)
```

A GitHub Actions job (`.github/workflows/refresh.yml`) scrapes the official site politely
(3 concurrent requests, 400 ms between batches, descriptive User-Agent), runs a card-type-aware
sanity gate, writes the data files, syncs them into Cloudflare D1, redeploys the Worker (which
busts its edge cache), commits the refreshed files, and updates the rolling `data-latest`
Release. The whole stack runs on free tiers.

---

## Freshness

`GET /v1/manifest` returns the live `dataset_version`; `data/manifest.json` also records
`built_at` and `card_count`. A stale dataset is worse than an obviously-broken one, so check
these if you depend on currency.

---

## License

- **Code** (scraper, normalizer, CLI, D1 schema, Worker): [MIT](LICENSE).
- **Data compilation** (the selection/arrangement of factual fields only): [CC0 1.0](LICENSE-DATA)
  — public domain, no attribution required (though a credit to `gcg-api` is appreciated).

Neither license grants any rights in Bandai's card names, effect text, artwork, or trademarks.
See [`LICENSE-DATA`](LICENSE-DATA) for the scope.

## Attribution

- Data source: the official [GUNDAM CARD GAME site](https://www.gundam-gcg.com/en/cards).
- Community prior art: [ExBurst](https://exburst.dev) and [EGMAN Events](https://egmanevents.com).

## Contributing & corrections

Data issues, corrections, or **takedown requests**: please open a
[GitHub Issue](https://github.com/yzRobo/gcg-api/issues). Per-set files under `data/cards/en/`
are small and reviewable if you want to propose a fix via PR. See [MAINTENANCE.md](MAINTENANCE.md)
for operational details and the project's good-faith posture.
