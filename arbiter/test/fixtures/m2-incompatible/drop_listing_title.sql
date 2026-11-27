-- M2 negative fixture: drops a column the previous release reads (v0.0 acceptOffer and catalog
-- select listings.title). arbiter/scripts/m2-check.mjs must fail with this migration added.
ALTER TABLE listings DROP COLUMN title;
