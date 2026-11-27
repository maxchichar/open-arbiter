-- AC-2.6 fixture: the table-rebuild pattern a later migration would use to change a parent table
-- (SQLite cannot alter a column in place). offers.mandate_id references mandates(id). Measured on
-- node:sqlite (arbiter/test/migrations.test.mjs):
--   - without deferring, DROP TABLE mandates fails at once (its implicit DELETE orphans the offers);
--   - with defer on and nothing else, COMMIT still fails: the drop's violations stay counted even
--     though the renamed table has every parent row again;
--   - turning defer off before COMMIT (the D1 docs' pattern) DISCARDS violations, real ones too.
-- So: defer on, rebuild, fail the migration if pragma_foreign_key_check finds any row (the CHECK
-- table below rolls everything back), and only then turn defer off.
PRAGMA defer_foreign_keys = true;
CREATE TABLE mandates_new (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  buyer_key TEXT NOT NULL,
  terms_key TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  max_total_cents INTEGER NOT NULL,
  deliver_within_hours INTEGER NOT NULL,
  vendor_ids TEXT,
  caller_origin TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settle_attempt TEXT,
  UNIQUE (buyer_key, terms_key)
);
INSERT INTO mandates_new (id, token_hash, buyer_key, terms_key, sku, quantity, max_total_cents, deliver_within_hours, vendor_ids, caller_origin, state, created_at, settle_attempt)
  SELECT id, token_hash, buyer_key, terms_key, sku, quantity, max_total_cents, deliver_within_hours, vendor_ids, caller_origin, state, created_at, settle_attempt FROM mandates;
DROP TABLE mandates;
ALTER TABLE mandates_new RENAME TO mandates;
CREATE INDEX IF NOT EXISTS mandates_by_buyer ON mandates (buyer_key, sku, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS mandates_token_unique ON mandates (token_hash);
CREATE TABLE _fk_check (orphans INTEGER NOT NULL CHECK (orphans = 0));
INSERT INTO _fk_check (orphans) SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE _fk_check;
PRAGMA defer_foreign_keys = false;
