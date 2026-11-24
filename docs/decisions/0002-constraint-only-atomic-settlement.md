# ADR 0002: Constraint-only atomic settlement

- **Status:** accepted, 2026-11-23 (owner amendment A5, after the slice 0 checkpoint; see `docs/rpi/arbiter-hardening/plan.md` §0)
- **Tasks:** P0.3 (atomic accept) and P0.4 (lost accept answer), slice 4, commit `cdc4990`
- **Code:** `arbiter/src/core.js` `acceptOffer`, `commit`, `REQUIRED_SCHEMA`; `arbiter/schema.sql`; `sites/oja/js/arbiter-client.js`, `market.js`
- **Tests:** `arbiter/test/accept.test.mjs`, `arbiter/test/schema-guard.test.mjs`, `sites/oja/tests/accept-unknown.test.mjs`, `arbiter/scripts/concurrency.mjs` (F4)

## Context

Accepting an offer changes four things: the mandate becomes `SETTLED`, stock goes down, the offers become `ACCEPTED` or `VOID`, and a signed receipt plus two audit events are written. Before slice 4 these were separate writes. A fault between them could settle a mandate with no receipt, or reduce stock for a deal that never completed (research F4).

D1 runs a `batch()` as one SQL transaction: a statement that **throws** rolls back the whole batch. But a statement that changes **0 rows does not throw**, so it does not abort anything. Slice 0 showed that `RAISE(ABORT)` in a trigger works on local workerd (spike items 1 and 2). Cloudflare does not document it, and hosted D1 was not tested.

## Decision

Use **no triggers**. Atomicity comes from schema constraints and from guards inside one batch:

1. **Sign first.** `acceptOffer` checks the signing key (fail closed, invariant from F7), reads the offer and mandate, then builds the receipt payload, including the `OFFER_ACCEPTED` event hash, and signs it **before any write**.
2. **One batch, in order, through `commit()`**:
   1. `UPDATE mandates SET state='SETTLED' WHERE id=? AND state='RESOLVED' AND EXISTS (offer OPEN, of this mandate, unexpired)`
   2. `UPDATE listings SET stock = stock − q WHERE … AND settledByUs`
   3. `UPDATE offers SET state = CASE … 'ACCEPTED' ELSE 'VOID' END WHERE mandate_id=? AND settledByUs`
   4. `INSERT INTO receipts … SELECT … WHERE settledByUs AND the offer is ACCEPTED`
   5. both events, each `INSERT … SELECT … WHERE EXISTS (receipt with this id)`

   Here `settledByUs` = the mandate is `SETTLED` **and no receipt exists for it yet**. Inside one transaction that is true only when statement 1 just settled it. If statement 1 changes 0 rows, every later statement changes 0 rows, and nothing is written.
3. **Constraints do the aborting:**
   - `listings` `CONSTRAINT stock_nonneg CHECK (stock >= 0)`: overselling throws, the batch rolls back, and the code maps it to 409 `out_of_stock` and then voids that one offer in a separate write.
   - `UNIQUE (receipts.mandate_id)`: a second receipt for a mandate throws.
   - `UNIQUE (events.prev_hash)`: a forked chain throws, and `commit()` retries (ADR 0003).
4. **0 rows from the receipt insert is a result, not success:** the code reads the state that won and answers 409 `already_settled`, or reports the offer as gone.
5. **The schema guard (CLAUDE.md invariant 10):** writes are refused with 500 `misconfigured` if `stock_nonneg`, `events_prev_unique` or `mandates_token_unique` is missing. Slice 4 found that an old local schema oversold without the CHECK.
6. **A lost answer is unknown, never retried (P0.4).** The client times out at 20 s, reports the accept as *unknown*, and never sends it again. The page blocks a second accept until a read (`refreshCatalog`) finds the receipt or the open offers.

## Why not triggers

- `RAISE(ABORT)` in triggers is not in Cloudflare's D1 documentation. It worked on local workerd, but a silent difference on hosted D1 would remove the guard exactly where it matters (plan risk R2).
- CHECK, UNIQUE and `INSERT … SELECT … WHERE` are plain SQL, and they port to PostgreSQL unchanged.
- Triggers hide logic from `core.js`. With guards, the whole accept can be read in one place.

## Consequences

- **Verified:** a fault injected at each statement index of the batch leaves the mandate `RESOLVED`, stock unchanged, offers `OPEN`, and no receipt or event (`accept.test.mjs` on node:sqlite, with a real `BEGIN`/`ROLLBACK` adapter). Two concurrent accepts on one mandate give one 200 and one 409 on wrangler dev (`concurrency.mjs`, `{"200":1,"409":1}` in 3 runs).
- **Not verified:** hosted D1. Its batch semantics are documented ("Batched statements are SQL transactions"), but its concurrency was not tested. Run `concurrency.mjs` against staging at the first deploy (plan risk R3).
- The guards are repeated in four statements. Any new accept-side write must carry `settledByUs`, or it would commit on a lost race. Only review and the per-statement fault-injection test in `accept.test.mjs` catch that, so extend that test with any new statement.
- A receipt is signed on every attempt, including attempts the chain retry then discards. Signing is cheap, and the signature covers the event hash of the attempt that committed.
- Settlement is still simulated: stock and receipts move, money does not.
