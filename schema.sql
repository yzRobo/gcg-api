-- schema.sql — Cloudflare D1 schema. Run ONCE at setup:
--   npx wrangler d1 execute gundam-cards --remote --file schema.sql
-- (Vercel analogy: this is your one-time table setup, like an initial SQL migration.)

CREATE TABLE IF NOT EXISTS cards (
  product_id   TEXT PRIMARY KEY,
  card_number  TEXT,
  name         TEXT,
  set_code     TEXT,
  set_name     TEXT,
  rarity       TEXT,
  card_type    TEXT,
  color        TEXT,
  level        INTEGER,
  cost         INTEGER,
  ap           INTEGER,
  hp           INTEGER,
  zone         TEXT,
  trait        TEXT,
  link         TEXT,
  source_title TEXT,
  block_icon   TEXT,
  sp           TEXT,
  effect       TEXT,
  image_url    TEXT,
  detail_url   TEXT,
  -- M5 structured/provenance fields (see src/normalize.js). JSON-array columns are stored as
  -- TEXT and JSON.parse()d by the Worker before returning (hydrate()).
  ap_raw          TEXT,   -- preserves PILOT "+1"/"+2" modifiers (ap/hp coerce and drop the sign)
  hp_raw          TEXT,
  where_to_get    TEXT,   -- product/event provenance (unique for promo printings)
  traits          TEXT,   -- JSON array, e.g. ["Earth Federation","White Base Team"]
  link_refs       TEXT,   -- JSON array of [pilot]/(trait) link references
  keyword_effects TEXT,   -- JSON array of { keyword, value } from <...>
  timing_markers  TEXT,   -- JSON array of timing tokens from 【...】
  keywords_text   TEXT    -- denormalized lowercase keyword+timing text, for LIKE filtering
);
CREATE INDEX IF NOT EXISTS idx_cards_set    ON cards(set_code);
CREATE INDEX IF NOT EXISTS idx_cards_type   ON cards(card_type);
CREATE INDEX IF NOT EXISTS idx_cards_color  ON cards(color);
CREATE INDEX IF NOT EXISTS idx_cards_name   ON cards(name);
-- card_number is looked up by /v1/cards/:id (fallback) and sorted by /v1/cards and
-- /v1/sets/:code/cards. Without this index those queries full-scan/sort the table,
-- which can exhaust D1's free-tier read budget. (M2 security-review fix.)
CREATE INDEX IF NOT EXISTS idx_cards_number ON cards(card_number);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- Self-serve API keys (M2 addition). This table is NEVER touched by the weekly
-- data refresh (import.sql only DELETEs/reinserts `cards` + upserts `meta`), so
-- issued keys persist across refreshes.
--   key_hash        SHA-256 hex of the issued key (the raw key is never stored)
--   label           optional user-supplied label
--   created_at      ISO timestamp
--   created_ip_hash salted SHA-256 of CF-Connecting-IP (raw IP never stored)
--   revoked         0 = active, 1 = revoked (abuse response: UPDATE ... SET revoked=1)
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash        TEXT PRIMARY KEY,
  label           TEXT,
  created_at      TEXT,
  created_ip_hash TEXT,
  revoked         INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_keys_ip ON api_keys(created_ip_hash);
