-- M2 negative fixture: looks additive, but v0.0 inserts vendors positionally
-- (INSERT INTO vendors VALUES (?,?,?,?,?)), so one more column breaks vendor registration on the
-- running v0.0 Worker. arbiter/scripts/m2-check.mjs must fail with this migration added.
ALTER TABLE vendors ADD COLUMN contact TEXT;
