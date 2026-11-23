-- Open Arbiter schema (Cloudflare D1 / SQLite).
-- Floors and budgets are stored here and nowhere else; no API returns them.

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  origin TEXT,                 -- the vendor's agentic website, shown to buyers
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'item',
  currency TEXT NOT NULL DEFAULT 'NGN',
  ask_cents INTEGER NOT NULL,      -- public list price per unit
  floor_cents INTEGER NOT NULL,    -- SEALED: lowest acceptable price per unit
  delivery_hours INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (vendor_id, sku),
  -- Overselling fails the whole accept batch (core.js maps it to out_of_stock). A constraint, not a
  -- trigger: no dependence on trigger behaviour in hosted D1, and it ports to PostgreSQL unchanged.
  CONSTRAINT stock_nonneg CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  buyer_key TEXT NOT NULL,         -- hashed caller identity used for anti-probing limits
  terms_key TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  max_total_cents INTEGER NOT NULL, -- SEALED: buyer's maximum
  deliver_within_hours INTEGER NOT NULL,
  vendor_ids TEXT,                  -- JSON array or NULL for all vendors
  caller_origin TEXT,
  state TEXT NOT NULL,              -- OPEN | RESOLVED | NO_AGREEMENT | SETTLED
  created_at INTEGER NOT NULL,
  UNIQUE (buyer_key, terms_key)
);
CREATE INDEX IF NOT EXISTS mandates_by_buyer ON mandates (buyer_key, sku, created_at);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  rank INTEGER NOT NULL,
  vendor_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  list_total_cents INTEGER NOT NULL,
  delivery_hours INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL               -- OPEN | ACCEPTED | VOID
);
CREATE INDEX IF NOT EXISTS offers_by_mandate ON offers (mandate_id, rank);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Append-only, hash-chained audit log. Payloads never hold floors or budgets.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  mandate_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One child per event: two writers extending the same head conflict here, and the loser retries
-- with the new head (core.js commit()), so the chain stays linear under concurrent writes.
CREATE UNIQUE INDEX IF NOT EXISTS events_prev_unique ON events (prev_hash);

-- Used only when no ARBITER_SIGNING_JWK secret is configured (local dev).
CREATE TABLE IF NOT EXISTS signing_keys (
  id TEXT PRIMARY KEY,
  private_jwk TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
