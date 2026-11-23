# Slice 0: harness and facts (evidence)

Date: 2026-11-23 · Branch: `arbiter-hardening` (from `7a81755`, uncommitted) · Node v24.21.0 · wrangler 4.166.0

## Changes in this slice

| File | Change |
| --- | --- |
| `arbiter/test/sqlite-d1.mjs` | `batch()` as one real transaction (`BEGIN` / `COMMIT` / `ROLLBACK`), as D1 documents. Fault injection via `memoryD1({fault})` / `setFault()`. |
| `arbiter/test/adapter.test.mjs` | New. 3 tests that the stand-in commits, rolls back and injects faults like D1. |
| `arbiter/scripts/worker-harness.mjs` | New. Isolated `wrangler dev`: temp `--persist-to`, free port, `--env-file` plus `--var` (ADMIN_TOKEN, BUYER_SALT, DEV=1). Runs seed, e2e and concurrency, then removes the server and state. `--serve` mode for manual use. |
| `arbiter/scripts/concurrency.mjs` | New. F2: 8 rounds × 25 concurrent mandates, plus identical-terms. F3: 20 mixed concurrent writes, then chain verification. F4: two concurrent accepts on one mandate, then chain verification. |
| `arbiter/scripts/seed.mjs` | Honours `SEED_KEYS_OUT`, so harness keys never overwrite `arbiter/.seed-keys.json`. |
| `package.json` | `npm run test:worker`. |
| `evidence/slice0-spike/` | Throwaway spike Worker (`worker.js`, `wrangler.toml`, `run-spike.sh`) and its output `spike-result.json`. |

## Results

### `npm test`
21/21 pass: the 18 existing tests plus 3 adapter tests.

### `npm run test:worker`: red, as required before the fixes
Full output is in `slice0-test-worker.txt`. Summary across 3 runs (2 standalone, 1 via the npm script):

| Check | Result today | Expected after |
| --- | --- | --- |
| F2 cap, 8 rounds × 25 | **FAIL**: worst round 17, 14 and 19 accepted (cap 3) | ≤ 3 per round |
| F2 identical terms × 5 | PASS: 1 × 201, 4 × 409 | same |
| F3 chain after 20 mixed writes | **FAIL**: `broken_at` 22, 15, 23 | `ok: true` |
| F4 concurrent accepts | PASS: 1 × 200, 1 × 409 (the state guard already serialises; this is a regression guard, not a reproduction) | same |
| F4 chain after accepts | FAIL (inherits the F3 fork) | `ok: true` |

The first single-burst version of the F2 check (10 concurrent) **passed** once (3/7). The race window is narrow, so the check now runs 8 rounds of 25. This is a test-strength change made before any fix, not a weakening.

After the runs, `pgrep` found no leftover wrangler process and no `/tmp/open-arbiter-harness-*` directories.

### D1 spike on local workerd (`bash evidence/slice0-spike/run-spike.sh`, output in `spike-result.json`)

| # | Question | Result |
| --- | --- | --- |
| 1 | **`RAISE(ABORT, 'out_of_stock')` in a BEFORE UPDATE trigger, inside `batch()`** | **Works.** It throws `D1_ERROR: out_of_stock: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`, and **the earlier statement in the batch was rolled back** (the mandate stayed `RESOLVED`, stock stayed 2). |
| 2 | `RAISE(ABORT)` in a BEFORE INSERT trigger (receipt needs a SETTLED mandate) | Works: `not_settled` error, 0 rows inserted. |
| 3 | UNIQUE violation as the 3rd statement of a batch | Throws `UNIQUE constraint failed: receipts.mandate_id`; statements 1–2 rolled back. |
| 4 | Successful batch | Commits; per-statement `meta.changes` = `[1, 1]`. |
| 5 | `UNIQUE INDEX` on `events(prev_hash)` | Violation text: `UNIQUE constraint failed: events.prev_hash` (the retry matcher keys on this). |
| 6 | Conditional `INSERT … SELECT … WHERE (SELECT COUNT(*) …) < 3` | `meta.changes` = `[1, 1, 1, 0, 0]`, 3 rows. |
| 7 | Fallback D4(b): NOT NULL fed by a guard subquery | Works: `NOT NULL constraint failed: receipts.mandate_id`. |

**node:sqlite parity:** the same trigger and index give `"out_of_stock"` and `"UNIQUE constraint failed: e.prev_hash"`. The D1 text wraps the same message, so substring matching on `out_of_stock` / `UNIQUE constraint failed: events.prev_hash` works in both.

**Limit of this evidence:** this is local workerd and its SQLite, not hosted D1 (plan risks R2, R3). Hosted behaviour must be re-checked with `concurrency.mjs` and the spike at deploy time.

### Manifest key (D5)
On a scratch copy of `sites/oja` with a top-level `"open_arbiter": {url, keys[]}`, `build_network.mjs oja_market.hocon --manifest agent-manifest.json` printed `OK` (exit 0) and kept the key. A grep of the runtime finds no unknown-key rejection; it reads only the keys it knows.

### A1/A2 pre-check (throwaway, scratchpad, not repo code)
Per-unit grid with 3 deals at q = 1, 2, 3 and random maxima: 3,000 sequences (500 with ask ₦610, unit_step 10,000 kobo), 2,559 with at least one agreement. **0 failures.** The narrowest consistent floor range was exactly 1.0 unit_step. The real test is written in slice 5.

## Checkpoint (amendment A4)
`RAISE(ABORT)` from a trigger works on local D1 and rolls back the whole batch. Plan option D4(a), triggers, is viable. **The F4 approach waits for owner confirmation.**
