# Slice 2: F3, a linear audit chain under concurrency (evidence)

Date: 2026-11-23 · Branch: `arbiter-hardening` on top of `d6b516a` (uncommitted)

## Changes

| File | Change |
| --- | --- |
| `arbiter/schema.sql` | `CREATE UNIQUE INDEX IF NOT EXISTS events_prev_unique ON events (prev_hash)`: one child per event. |
| `arbiter/src/core.js` | `event()` is replaced by `commit({events, statements, guard})`: chains the events from the current head, runs the business statements and the event inserts in **one `db.batch()`**, retries on `UNIQUE constraint failed: events.prev_hash` (D1- and node-formatted messages both match) with **jittered exponential backoff** (4 ms × 2^attempt, 8 attempts, at most about 0.5 s), then `503 busy`. Every writer now goes through it: `createVendor`, `upsertListing`, `createMandate`, `resolveMandate`, `acceptOffer`. |
| | `resolveMandate`: offer inserts are `INSERT … SELECT … WHERE` the mandate is still OPEN, before the state update in the same batch. The event is guarded on no resolution event existing yet. **Behaviour change:** a resolve that loses a concurrent race now returns the stored outcome (idempotent) instead of `409 conflict`. |
| | `acceptOffer`: only the tail changed this slice. Both events and the receipt insert commit together, and the receipt is signed per attempt with that attempt's `OFFER_ACCEPTED` hash. Its state updates are still separate statements until slice F4. |
| `arbiter/test/sqlite-d1.mjs` | A fault hook may return an `Error` to throw (used to imitate a `prev_hash` conflict). |
| `arbiter/test/chain.test.mjs` | New. 8 tests (below). |

## Red: the new tests on the old code (`slice2-red.txt`)

`node --no-warnings --test arbiter/test/chain.test.mjs` exited 1 with **8 of 8 failing**:

| Test | Failure on old code |
| --- | --- |
| concurrent writes of every kind keep one linear chain | `no two events may share a prev_hash`: `1 !== 0`. The fork reproduces in node:sqlite too. |
| concurrent resolves of one mandate | `Error: Mandate was resolved concurrently; fetch it again.` (`conflict`) |
| chain-head conflicts are retried | `UNIQUE constraint failed: events.prev_hash` propagated; no retry |
| retries run out → 503 busy, nothing committed | got the raw UNIQUE error, not `{code: "busy", status: 503}` |
| createVendor / upsertListing / createMandate: failed event insert rolls back | business row stayed committed (for example `vendors: 2` vs `1`, `mandates: 1, states: 'OPEN'` vs `0`) |
| resolveMandate: failed event insert leaves the mandate OPEN with no offers | offers and state change committed without the event |

## First fix attempt: one test still red

With the unique index and immediate retries, 7/8 passed, but **"concurrent writes of every kind"** failed. All 36 concurrent writers retried in lockstep and exhausted 8 attempts (`503 busy`). The fix was the jittered exponential backoff above, not a weaker test. The test still runs 36 concurrent writers.

## Green

- `chain.test.mjs`: 8/8, then **30 more runs with 0 failures** (`slice2-flake.txt`). The backoff is random, so this was checked for flakiness.
- `npm test`: **38/38** (`slice2-green.txt`).
- `npm run test:worker` on wrangler dev (`slice2-test-worker.txt`), 3 runs:

  | Check | Before (slice 1) | Now |
  | --- | --- | --- |
  | F3 chain intact after 20 mixed concurrent writes | FAIL `broken_at: 23` | **PASS** ×3 (129–149 events, including the 200-request F2 burst) |
  | F4 chain intact after concurrent accepts | FAIL (inherited fork) | **PASS** ×3 |
  | F3 concurrent writes succeed (no 503 under this load) | n/a | **PASS** ×3 |
  | F2 daily cap | FAIL | **FAIL** (worst round 25 of a cap of 3; slice 3) |
  | seed, e2e | OK | OK |

## Notes

- **Existing local databases:** a DB whose chain already forked (like the one from the baseline probes) cannot take the new unique index. Re-running `schema.sql` on it fails. Reset with `rm -rf arbiter/.wrangler/state`, then schema and seed, as `CLAUDE.md` already describes. No deployed database exists.
- **Hosted D1** contention behaviour (retry rate, latency) is unmeasured until a staging deploy (plan risk R3/R4). `concurrency.mjs` is the check to run there.

## Added before commit (owner requests)

1. **Injectable jitter.** `new Arbiter(db, {random})`, default `Math.random`, is used only for retry backoff. `arbiter/test/seeded.mjs` provides a mulberry32 PRNG seeded from `TEST_SEED` (or a fresh seed) and `replayable()`. On failure, a test prints `ℹ replay with TEST_SEED=<seed>` and fails with `Error: replay with TEST_SEED=<seed>`, keeping the original assertion diff as `cause`. This was checked with a deliberately failing scratch test (`TEST_SEED=12345` printed both). Same seed → same sequence: checked. All chain tests use it. **Caveat:** the seed replays the jitter, not the event-loop scheduling, so a replay is likely but not guaranteed to reproduce a concurrency failure.
2. **Retry precondition** is documented on `commit()`: every statement of the write must be inside the batch, because retries rely on full rollback. `acceptOffer` carries a `KNOWN GAP until slice F4` comment where its state updates still run outside the batch.
3. **Scaling note** added to README "Limits" and the plan's open items: one global chain serializes writes; per-mandate chains or a Durable Object are the scaling path; nothing built.

After these: `npm test` 38/38; `chain.test.mjs` 30 more runs with fresh seeds, 0 failures.
