-- 0002_read_indexes (P1.7, AC-7.2): bound what public requests read. D1 bills rows read, so a
-- query that filters without an index pays for every row of the table.
--  - events_by_mandate: a mandate's audit trail (GET /v1/mandates/:id/audit) and the resolve guard
--    (NOT EXISTS an outcome event for this mandate) read that mandate's events, not the whole chain.
--  - listings_by_sku: negotiate (listings for one sku) and the paged catalog (keyset on sku, list
--    price, vendor) read one page or one sku, not every listing.
-- Indexes only: the previous Worker's statements are unchanged and keep working (M2).
CREATE INDEX IF NOT EXISTS events_by_mandate ON events (mandate_id, seq);
CREATE INDEX IF NOT EXISTS listings_by_sku ON listings (sku, ask_cents, vendor_id);
