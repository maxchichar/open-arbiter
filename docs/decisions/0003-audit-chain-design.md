# ADR 0003: Audit chain design and its scaling limit

- **Status:** accepted, 2026-11-23 (slice 2; the scaling limit is recorded as an owner open item in `docs/rpi/arbiter-hardening/plan.md` §10)
- **Task:** P0.1 (F3), commit `f762139`
- **Code:** `arbiter/src/core.js` `commit()`, `verifyChain()`; `arbiter/schema.sql` `events_prev_unique`
- **Tests:** `arbiter/test/chain.test.mjs` (node:sqlite), `arbiter/scripts/concurrency.mjs` (wrangler dev)

## Context

Every state change writes an event to `events`. Each event's `hash` is the SHA-256 of `canonicalJson({at, kind, mandate_id, payload, prev})`, and `prev` is the previous event's hash (`"genesis"` for the first). `GET /v1/audit/verify` walks the chain in `seq` order. Receipts carry the `OFFER_ACCEPTED` event hash (`audit_hash`), which ties each signed receipt to a position in the log.

Before slice 2, the head was read and the event appended in separate steps, outside the business write. Concurrent writers read the same head and forked the chain (`broken_at: 22, 15, 23` in slice 0 on wrangler dev). The business row could also commit without its event.

## Decision

1. **One global chain, linear by constraint.** `CREATE UNIQUE INDEX events_prev_unique ON events (prev_hash)`. Two events can never share a parent, so a fork is impossible, not just unlikely.
2. **Business write and events in one batch.** `commit({events, statements, guard})` reads the head, chains the events from it, and runs `db.batch([...business, ...eventInserts])`. A rolled-back batch leaves neither the row nor the event. Optional `guard` SQL makes the event inserts conditional on the business write having happened (for example, the mandate row exists, or the receipt exists), so a 0-row business statement writes no event.
3. **Optimistic retry.** On `UNIQUE constraint failed: events.prev_hash`, re-read the head and rebuild the whole batch. Wait `random() × min(4 ms × 2^attempt, 128 ms)` (jittered exponential backoff, capped; about 0.9 s in total at most), up to **12 attempts**, then fail with **503 `busy`** and nothing committed. (Slice 2 used 8 uncapped attempts, about 0.5 s. At the Phase 0 gate that let one of 36 concurrent writers run out in 6 of 15 full test runs under CPU load. After the change: 0 of 25, `evidence/gate-flake-after.txt`.) Any other error is not retried. The jitter uses an injectable `random`, and it is not pricing: `mechanism.js` stays free of clocks and randomness (invariant 2).
4. **Every writer uses `commit()`:** `createVendor`, `upsertListing`, `createMandate`, `resolveMandate`, `acceptOffer`. A retry is safe only because every statement of the write is inside the batch (documented on `commit()`).
5. **Signed receipts follow the committed hash.** The receipt is re-signed on each attempt with that attempt's `OFFER_ACCEPTED` hash, so `audit_hash` always names the event that committed (AC-F4-4).

## Evidence

- node:sqlite: 36 concurrent writers of every kind, chain `ok: true`, no shared `prev_hash`. Retry exhaustion → 503 with nothing committed (db shim forcing conflicts). Fault on the event insert → no business row.
- wrangler dev (`npm run test:worker`, 3 runs in slice 5): 20 concurrent mixed writes → `{"200":10,"201":10}`, chain `ok: true` (65 events). Accept races → chain `ok: true` (73 events).
- The first fix, immediate retries, failed: 36 writers retried in lockstep and all exhausted 8 attempts. Jitter fixed it, and the test was not weakened (`evidence/slice2.md`).

## Scaling limit

**One global head serializes every write in the system.** Each write costs at least one head read plus one batch, and writers that collide redo both. Throughput therefore tops out near one write per head-read-plus-batch round trip, whatever the number of Workers. Under sustained contention, writers use up the 12 attempts and see `503 busy`. Mandate creation is anonymous, so strangers can create that contention, within the anti-probing limits (review finding R4).

- D1 already runs one writer per database, so the chain does not create the serialization. It adds the read-then-write round trip and the wasted retries on top of it.
- **No throughput was measured.** The local tests show correctness at 20 to 36 concurrent writers, not capacity. Hosted D1 latency is unknown until a deploy (plan risk R3).
- The demo load (a handful of buyers) is far below the limit. A real market is not.

**Scaling path (none built):**

| Option | Shape | Cost |
| --- | --- | --- |
| Per-mandate chains + a global chain of heads | Each mandate's events chain locally. A periodic or per-settlement anchor commits the heads into a global chain | Contention only within one mandate. Verification has two levels. Ordering across mandates is only as fine as the anchors |
| A Durable Object owns the log | One single-threaded object appends events, with no retry | No wasted retries, but still one global writer. Adds a hop and a second storage system |
| Anchor externally (e.g. a transparency log) | Publish periodic head hashes | Makes operator rewrites detectable. Does not help throughput |

Pick one when load data exists. Until then, README "Limits" states the limit.

## What the chain does not guarantee

- **Integrity, not secrecy or completeness against the operator.** The operator controls the database and can rewrite the whole chain consistently. Detection needs heads published outside the operator's control (the third option above). Receipts held by buyers fix only the events they name.
- `at` is the Worker clock, not a trusted timestamp.
- Event payloads must never contain sealed values (invariant 1). Tests check the payloads.
