-- 0001_settle_attempt (P1.2, R6): the accept batch writes its own receipt id here when it settles a
-- mandate, and its later statements (stock, offers, receipt) require it. A mandate left SETTLED with
-- no receipt by the pre-Phase-0 non-atomic accept has NULL here, so no later accept can take stock
-- or issue a receipt for it. Additive and nullable: the previous Worker (v0.0) names the columns it
-- inserts into mandates and never reads this one, so it keeps working (M2).
ALTER TABLE mandates ADD COLUMN settle_attempt TEXT;
