# Slice 3: F2, anti-probing limits hold under concurrency (evidence)

Date: 2026-11-23 · Branch: `arbiter-hardening` on top of `f762139` (uncommitted)

## Changes

| File | Change |
| --- | --- |
| `arbiter/src/core.js` `createMandate` | The read-then-insert checks (`COUNT(*)`, then the duplicate `SELECT`, then `INSERT`) are replaced by **one conditional statement** inside `commit()`'s batch: `INSERT INTO mandates (…) SELECT … WHERE (SELECT COUNT(*) FROM mandates WHERE buyer_key = ? AND sku = ? AND created_at > ?) < 3`. 0 rows written → `429 rate_limited`. `UNIQUE constraint failed: mandates.buyer_key, mandates.terms_key` → `409 identical_terms` (D1 and node message formats both match). The `MANDATE_CREATED` event is guarded on the row existing, so a refusal writes nothing and does not touch the chain head. Order is preserved: over the cap, the cap is reported even for identical terms. |
| `arbiter/test/antiprobing.test.mjs` | New. 4 tests, using the seeded PRNG and `replayable()`. |

This also fixes research finding F11: a concurrent identical-terms race used to surface as a raw database error (500).

## Red: the new tests on the old code (`slice3-red.txt`)

`node --no-warnings --test arbiter/test/antiprobing.test.mjs` exited 1: **2 failing, 2 passing**, with `replay with TEST_SEED=3979476733` printed.

| Test | Old code |
| --- | --- |
| 25 concurrent mandates, distinct terms → 3 ok, 22 rate_limited (5 rounds) | ✖ round 0: `{"ok":25}`. **Every one succeeded**, against a cap of 3. |
| 5 concurrent identical terms → 1 ok, 4 identical_terms (5 rounds) | ✖ round 0: `{"ok":1,"ERR_SQLITE_ERROR":4}`, raw UNIQUE errors (a 500 over HTTP) |
| a refused mandate writes no row and no event; over the cap reports the cap first | ✔ (sequential regression guard) |
| identical terms under the cap → 409; other buyers unaffected | ✔ (sequential regression guard) |

## Green

- `antiprobing.test.mjs`: 4/4 on 3 consecutive runs. Then `antiprobing` + `chain` together, **30 runs with fresh seeds: 0 failures** (`slice3-flake.txt`).
- `npm test`: **42/42** (`slice3-green.txt`).
- `npm run test:worker` on wrangler dev, **3 full runs, all green** (`slice3-test-worker.txt`). This is the first time the whole harness passes:

  | Check | Slice 2 | Now (each of 3 runs) |
  | --- | --- | --- |
  | F2 cap, 8 rounds × 25 concurrent | FAIL (worst 25/round) | **PASS**: every round exactly `{"201":3,"429":22}` |
  | F2 identical terms × 5 | PASS | PASS `{"201":1,"409":4}` |
  | F3 chain after mixed concurrent writes | PASS | PASS |
  | F4 concurrent accepts settle once, chain intact | PASS | PASS |
  | seed, e2e | OK | OK |

## Notes

- The chain now has 65 events after the F2 checks, down from 129–149 in slice 2. That is because the refused mandates no longer exist and write no events. This is expected.
- Hosted D1 is still unverified (plan R2/R3). The single-statement design does not depend on how hosted D1 orders writes, but `concurrency.mjs` should be run against staging.
