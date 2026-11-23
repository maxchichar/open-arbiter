# Slice 4: F4, atomic accept with constraint-only guards (evidence)

Date: 2026-11-23 · Branch: `arbiter-hardening` on top of `e63c362` (uncommitted)

## Changes

| File | Change |
| --- | --- |
| `arbiter/schema.sql` | `listings` gets `CONSTRAINT stock_nonneg CHECK (stock >= 0)`. No triggers (A5). |
| `arbiter/src/core.js` `acceptOffer` | **Signs the receipt first, then one batch through `commit()`**: (1) mandate RESOLVED→SETTLED, only if this offer is OPEN, unexpired and belongs to it; (2) stock decrement; (3) offers accepted/voided, both guarded on "mandate SETTLED and no receipt yet"; (4) receipt `INSERT … SELECT … WHERE` the mandate is SETTLED, has no receipt and this offer is ACCEPTED; `UNIQUE(receipts.mandate_id)` is the backstop; (5) both events, guarded on this receipt row existing. Statements 1–4 share their conditions, so all or none change. A 0-row receipt insert is an error (`already_settled` or `offer_closed`). `CHECK constraint failed: stock_nonneg` → `409 out_of_stock`, followed by a single `VOID` of that offer; the mandate stays RESOLVED. **The "KNOWN GAP until slice F4" comment is gone**, removed with the rewrite. Every test in this slice's red set passes. |
| `arbiter/src/core.js` `ensureSchema()` | **Added in this slice (not in the plan); see "Finding" below.** `commit()` first checks `sqlite_master` for `CONSTRAINT stock_nonneg` and index `events_prev_unique`. It refuses writes with `500 misconfigured` if either is missing. Checked once per Arbiter instance. |
| `sites/oja/js/arbiter-client.js` | `timeoutMs` (default 20 s, below the runtime's 180 s) plus `AbortController`. Accept is a **binding** call: a timeout, network error or unreadable 2xx returns `{ok:false, unknown:true}`, never "could not be reached". Sent once, never retried. Honours the runtime's abort `signal`. |
| `sites/oja/js/market.js` | `acceptOffer` **throws** on an unknown outcome. The runtime then records `status: "unknown"` and never retries (`runtime/actions.js:141-153`). The offer is marked: shown as `UNKNOWN`, and `checkAccept` refuses a second accept. `refreshCatalog()` re-reads those negotiations (a read, not a retry), picks up and verifies any receipt, and clears the mark. |
| `sites/oja/site-actions.js` | Passes the runtime's `signal` to `acceptOffer`. |
| `sites/oja/js/app.js` | The manual Accept button shows the unknown-outcome message and refreshes instead of crashing. |
| `arbiter/scripts/concurrency.mjs` | New wrangler-dev check: oversell → `409 out_of_stock`, mandate RESOLVED, offer VOID, stock unchanged, no receipt. |
| `arbiter/test/sqlite-d1.mjs` | `schemaSql` option, to build outdated databases in tests. |
| New tests | `arbiter/test/accept.test.mjs` (12), `sites/oja/tests/accept-unknown.test.mjs` (5), `arbiter/test/schema-guard.test.mjs` (4) |

## Red

### Server (`slice4-red-server.txt`): 6 fail, 6 pass on the slice-3 code

| Test | Old code |
| --- | --- |
| fault at "decrement stock" / "accept/void offers" / "insert receipt" / "event OFFER_ACCEPTED" / "event RECEIPT_ISSUED" | ✖ **partial writes**: `mandate: 'SETTLED'` with no receipt; stock `3` instead of `5`; offers `ACCEPTED`/`VOID` |
| schema refuses negative stock | ✖ no CHECK; `UPDATE listings SET stock = -1` succeeds |
| fault at "settle mandate" (first write), concurrent accepts (same offer ×5, different offers ×4), stale-offer on a NO_AGREEMENT mandate, receipt names the committed event after 2 chain retries, out-of-stock at acceptance | ✔ regression guards (the old state guard and slice 2's `commit()` already cover these) |

**Correction during red:** the out-of-stock test first failed on the old code for a reason in the **test**, not the code. Its consistency helper assumed both listings started at 5 after the test had set one to 1. The fix passes the baseline from a snapshot. The test then passed on the old code, as a regression guard should.

### Client (`slice4-red-client.txt`, run with `--test-force-exit`): 5 of 5 fail

| Test | Old code |
| --- | --- |
| `ArbiterClient.accept`, response hangs | ✖ `test timed out after 4000ms`: the client waits forever |
| `ArbiterClient.accept`, network error after the arbiter committed | ✖ `{"ok":false,"reason":"The arbiter at arb.test could not be reached."}`. The model would read this as "refused, nothing changed", yet a receipt exists on the server. |
| `Market.acceptOffer` ×2 modes | ✖ the same two failures |
| through the runtime's real `ActionRegistry` | ✖ timed out. The old client also leaves the runtime's own 180 s timer pending, hence `--test-force-exit` for the red run only. |

### Schema guard (`slice4-red-schema.txt`): 2 fail, 2 pass
Writes on a database without `stock_nonneg`, and on one without `events_prev_unique`, both succeeded.

## Green

- `accept.test.mjs` 12/12 (3 runs), `accept-unknown.test.mjs` 5/5, `schema-guard.test.mjs` 4/4.
- `npm test`: **63/63** in 0.7 s, no `--test-force-exit` needed (`slice4-green.txt`).
- Flake check: accept, antiprobing, chain and accept-unknown, **30 runs with fresh seeds, 0 failures** (`slice4-flake.txt`).
- `npm run test:worker`: **3 runs, 30 PASS, 0 FAIL** (`slice4-test-worker.txt`). This includes the new `F4 oversell refused as out_of_stock` (409) and `F4 after out_of_stock: state RESOLVED, offer VOID, stock 2, receipt null`. The CHECK → out_of_stock mapping therefore holds on both node:sqlite and workerd.

## Finding: the constraint-only design depends on the schema being current

`slice4-workerd-nocheck.txt`: the slice-4 code run on wrangler dev against the **slice-3 schema** (no CHECK) **oversold**. The response was `200`, then `state SETTLED, offer ACCEPTED, stock -1, receipt rct_…`. With constraint-only guards, a database created before this slice (any existing local one) would oversell silently, and one without the slice-2 index would fork the chain silently.

**Fix added: `ensureSchema()`** (red, then green above). Re-running the same setup (`slice4-workerd-nocheck-guarded.txt`): `POST /v1/vendors` → **500 misconfigured** ("schema is out of date … must be migrated or reset"), and `GET /v1/catalog` → 200, since reads are unaffected. D1 allows the `sqlite_master` query. The worker's `console.error` line was not captured in that run's log, so I do not claim it.

**Consequence for your machine:** your existing `arbiter/.wrangler/state` database predates slices 2 and 4. The arbiter will now refuse writes to it until you reset it: `rm -rf arbiter/.wrangler/state`, then the schema and seed steps.

## Not covered / follow-ups for the gate review

- **Negotiate has the same lost-response problem**, not fixed here because it is out of this slice's scope. If `POST /v1/mandates` succeeds but the answer is lost, the client reports "could not be reached". In fact one of the 3 daily attempts was used, and that mandate's token is lost.
- `browser_check.py` was not run in this slice (needs the site server, fake LLM and Playwright). `app.js` changed only on the manual-accept error path. Planned for the final verification slice.
- Hosted D1: unverified until staging (R2/R3).
