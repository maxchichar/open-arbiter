# RPI / Plan: Arbiter hardening (F1–F8)

**Tier:** critical · **Created:** 2026-11-23 · **State:** **Approved 2026-11-23** (B2, ties toward buyer, triggers if slice 0 proves them else constraint-only fallback, manifest key `open_arbiter`), with the amendments in §0
**Research:** [`docs/rpi/baseline/research.md`](../baseline/research.md) · **Repo revision:** `7a81755` · **Spec pin:** `c178171d` (upstream `main` unchanged on 2026-11-23)

## 0. Owner amendments (2026-11-23)

- **A1. Per-unit grid.** `unit_step = max(10_000, round(0.025 × ask_cents))` kobo, which is ₦100 minimum per unit, and `step = unit_step × quantity`. The cells in floor space are then `((k−1)·unit_step, k·unit_step]` at every quantity, so the price depends on the floor only through `ceil(floor / unit_step)`. This **replaces D3** and closes risk R1 (cross-quantity narrowing).
- **A2. Multi-deal property.** For sequences of 3 deals at quantities 1, 2 and 3 from the same buyer (any maxima), the set of floors consistent with **all** observed prices spans ≥ `unit_step` values. This includes a low-price case, ask ₦610, where the ₦100 minimum applies (unit_step = 10,000 kobo instead of 1,525).
- **A3. Key set for F6.** Pin a key **set** with `kid` values (`ARBITER_KEYS = [{kid, kty, crv, x, y}, …]`). Verification selects the key by the receipt's `key_id`, so rotating keys keeps old receipts verifiable.
- **A4. Checkpoint.** Stop after slice 0 and report the trigger `RAISE(ABORT)` result before choosing the F4 approach.
- **A5. F4 decision (after the slice-0 checkpoint): constraint-only fallback D4(b), no triggers.** Reasons: it does not depend on undocumented trigger behaviour in hosted D1, and it ports to PostgreSQL unchanged.
  - `listings` gets `CONSTRAINT stock_nonneg CHECK (stock >= 0)`. The code maps `CHECK constraint failed: stock_nonneg` to `out_of_stock`, tested on node:sqlite and on wrangler dev.
  - The receipt is written with `INSERT … SELECT … WHERE` the mandate is SETTLED. A write of 0 rows is an error.
  - A D1 batch does **not** abort on a 0-row statement, so the accept batch is ordered and guarded so that nothing else can commit without the receipt:
    1. `UPDATE mandates SET state='SETTLED' WHERE id=? AND state='RESOLVED' AND EXISTS(offer ? of this mandate, OPEN, unexpired)`
    2. `INSERT INTO receipts … SELECT … WHERE mandate SETTLED AND offer OPEN AND NOT EXISTS(receipt for mandate)`
    3. stock decrement, offer states and both events, each `WHERE EXISTS (SELECT 1 FROM receipts WHERE id = ?new_receipt_id)`

    Statements 1 and 2 share their conditions, so they change together. With 0 rows from (2), every later statement is a no-op. `CHECK` and `UNIQUE(receipts.mandate_id)` failures roll back the whole batch.
  - Spike evidence: `evidence/slice0-spike/spike-result.json` item 7, and the D1 batch rollback in items 1 and 3.

Note on the domain edge under A1: the top cell `((k−1)u, ku]` can be cut short by `floor ≤ ask`. A floor in that partial cell can never reach agreement, because `ceil(f/u)·u > ask ≥ U′/q` means `L′ > U′`. So no observed price ever reveals it, and the property holds over agreements.

## 1. Objective and boundaries

**Outcome:** The arbiter's advertised guarantees become true, and are stated honestly:

- an agreed price narrows a sealed limit only to an interval at least one grid step wide (F1)
- the per-item daily cap holds under concurrent requests (F2)
- the audit chain stays linear under concurrent writes (F3)
- accepting an offer is all-or-nothing (F4)
- the arbiter URL cannot be swapped by a link in production (F5)
- receipts verify against a pinned key (F6)
- a missing signing key fails closed (F7)
- the page and README copy match the behaviour (F8)

**In scope:**
- `arbiter/src/{mechanism,core,index}.js`, `arbiter/schema.sql`, `arbiter/test/*`, and new `arbiter/scripts/{worker-harness,concurrency,pubkey}.mjs`
- `sites/oja/js/{config,arbiter-client,market,app}.js`, `sites/oja/site.js` (copy only), `sites/oja/bridge/bridge-actions.js`, `sites/oja/agent-manifest.json`, `sites/oja/oja_market.hocon` and its rebuilt `.network.json`, `sites/oja/index.html` (copy only), `sites/oja/tests/*`
- `README.md` and `CLAUDE.md` (invariant 1, commands, test count)

**Out of scope (owner decision):** second site, second agent, keyless default model, CSP. Also out of scope: deployment, commits to `main`, and any change to `sites/oja/runtime/`.

**Assumptions:**
- Nothing is deployed, so there is no production data to migrate. The schema change needs the local D1 state reset.
- Node 24 and wrangler 4.166.0 are available.
- No new npm dependencies. The property tests use a seeded PRNG written inside the test.

## 2. Decisions needed before implementation

| # | Decision | Options | Recommendation and evidence |
| --- | --- | --- | --- |
| **D1** | **Exact F1 rounding rule** | **B1 (as written):** Nash midpoint m = ⌊(L+U)/2⌋; round m to the nearest grid point; clamp into [⌈L/g⌉·g, ⌊U/g⌋·g]; no grid point inside → no agreement. **B2 (snap, then midpoint):** L′ = ⌈L/g⌉·g, U′ = ⌊U/g⌋·g; if L′ > U′ → no agreement; price = grid point nearest to (L′+U′)/2. It is still the Nash midpoint, taken on the grid-aligned zone. | **B2.** A throwaway check (`scratchpad/grid.mjs`, not in the repo; seeded, 3,000 random markets each) showed:<br>• **B1 fails the property you specified in 17 of 1,789 agreements.** All failures are next to the domain edge floor = 1 kobo. Example: ask ₦97,305, q = 6, max ₦177,933.39, floor ₦1,100.43. The consistent floors are 1…196,856 kobo, which is narrower than g/q = 243,262.<br>• **B2: 0 failures in 1,816 agreements.**<br>• B2 also depends on the floor only through ⌈L/g⌉, so at a fixed quantity, changing the budget across repeated deals cannot narrow the floor below one grid cell. B1 has no such guarantee.<br>• Both rules have the same no-agreement condition and never leave [L, U]. Prices differ by at most one step. Example (rice, q = 2, max ₦170,000, ask ₦90,000, floor ₦75,000): B2 = ₦157,500, B1 = ₦162,000. |
| D2 | Tie rule when the midpoint is exactly between two grid points | Toward the buyer (lower), toward the seller, or half-to-even | **Toward the buyer.** It is deterministic and easy to explain. |
| D3 | Grid step | **Superseded by A1:** `unit_step = max(10000, floor((ask_cents*25 + 500)/1000))`, `g = unit_step × q`, anchored at 0 | Integer-only. Worst case: 1e9 × 25 = 2.5e10, then × 1e4 = 2.5e14 < 2^53. |
| D4 | Atomic guard inside a D1 batch (F4) | (a) SQLite triggers with `RAISE(ABORT, 'out_of_stock')`. (b) No triggers: rely on `UNIQUE(receipts.mandate_id)` plus a NOT NULL column filled from a guard subquery. | **(a) if slice 0 proves it on wrangler dev; otherwise (b).** Cloudflare's docs say "Batched statements are SQL transactions" and a failure "aborts or rolls back the entire sequence" (developers.cloudflare.com/d1/worker-api/d1-database/, modified 2026-06-22). The docs do not mention `RAISE(ABORT)`, so this is **unverified** and gated by a test in slice 0. |
| D5 | Where the pinned key lives (F6) | `sites/oja/js/config.js` exports `ARBITER_KEYS`; the manifest gets a site-specific top-level `"open_arbiter": {"url", "keys"}` | Proceed if slice 0 shows that `build_network.mjs --manifest` and the runtime ignore an unknown top-level key. The runtime reads only `brand`, `coded_tools`, `linking`, `llm_router`, `networks`, … (grep). |
| D6 | Dev flag name (F7) | `DEV="1"` in `.dev.vars` / `--var DEV:1` | As stated, `DEV`. Only the exact string `"1"` enables it. |

**If you approve without comment, I will use B2, ties toward the buyer, triggers gated by a slice-0 test, and `open_arbiter` in the manifest.**

## 3. Acceptance criteria

Each AC is written as a test before the fix, and that test must **fail on the current code** first. I will record the failing output in `docs/rpi/arbiter-hardening/evidence/`.

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| **AC-F1-1** | Given any listing and mandate, when resolved, then each offer total is a multiple of g, and floor·q ≤ total ≤ min(max, ask·q). | Property test, seeded PRNG, ≥ 20,000 cases, seed printed on failure (`mechanism.test.mjs`) |
| AC-F1-2 | Given the zone [L, U] contains no grid point, then that listing gives no offer. If no listing gives one, the outcome is `agreement: false`. | Unit test: L = 15,100,000, U = 15,200,000, g = 450,000 → no offer |
| **AC-F1-3** | Given a buyer who knows max, ask and q and observes total P, then the set of integer per-unit floors f ∈ [1, ask] that would produce P is an interval with (f_max − f_min + 1) ≥ ⌊g/q⌋. The same holds for the seller: integer maxima consistent with P cover at least ⌊g⌋ kobo, or every max ≥ list. | Property test with the exact scan from the scratchpad check, ≥ 2,000 seeded cases. **Fails today:** with no grid, the floor range is about 1 value. |
| AC-F1-4 | (B2 + A1) For every ask, q and max, the price depends on the floor only through ⌈floor/unit_step⌉, at every quantity. | Property test: two floors in the same cell → same result for q ∈ {1..12} |
| **AC-F1-7** | (A2) For random sellers and buyers making 3 deals at q = 1, 2, 3 with independent random maxima, the floors f ∈ [1, ask] consistent with every observed outcome (price or no agreement) form a set of ≥ unit_step values whenever at least one deal agreed. Fixed case: ask ₦610 (61,000 kobo) → unit_step 10,000. | Property test, ≥ 2,000 seeded sequences plus the ₦610 case. **Fails today** (exact floor recoverable). |
| AC-F1-5 | Determinism kept: `mechanism.js` has no imports, no `Date`, no `Math.random`. | Source-scan test (new); closes the gap noted in research §5 |
| AC-F1-6 | The mechanism is identified as `open-arbiter/nash-midpoint-grid` 2.0.0 with `grid_bps: 250` and `grid_min_cents: 10000`. Each offer and receipt carries `grid_step_cents`. Older receipts still verify, because the signature covers their own payload. | Unit and e2e tests |
| **AC-F2-1** | Given one buyer and sku, when 10 mandates with distinct terms arrive concurrently, then at most 3 are created (201) and the rest get 429. | (a) `core.test.mjs`, `Promise.all` on node:sqlite. (b) **`arbiter/scripts/concurrency.mjs` against wrangler dev**, using a fresh random sku per run. **Fails today** (observed: 10 × 201). |
| AC-F2-2 | Concurrent identical terms → exactly one 201 and the rest 409 `identical_terms`, never 500. | Same two harnesses |
| **AC-F3-1** | Given 20 concurrent writes of any kind (mandate, resolve, listing), then `GET /v1/audit/verify` → `ok: true`, and no two events share a `prev_hash`. | node:sqlite test plus `concurrency.mjs` on wrangler dev. **Fails today** (observed: `broken_at: 25`). |
| AC-F3-2 | Under contention, an append retries at most 8 times with fresh head reads. When retries run out, the request fails with 503 `busy`, and no business row stays committed without its event. | Unit test with a db shim that forces `prev_hash` conflicts |
| AC-F3-3 | Mandate, resolve, listing and vendor writes are each committed in **one batch together with their event**. A rolled-back batch leaves neither the row nor the event. | Unit test: fault injection on the event insert |
| **AC-F4-1** | Given a fault injected at any statement of the accept batch, then the mandate stays `RESOLVED`, stock is unchanged, the offers stay `OPEN`, and there is no receipt and no event. | `core.test.mjs`: a fault-injecting `memoryD1` with a real `BEGIN`/`ROLLBACK` batch, run once for each statement index. **Fails today** (partial writes). |
| AC-F4-2 | Two concurrent accepts of different offers on one mandate → exactly one receipt, and stock is decremented once. The other gets 409 `already_settled`. | node:sqlite and `concurrency.mjs` |
| AC-F4-3 | Out of stock at acceptance → 409 `out_of_stock`, the offer is `VOID`, the mandate is `RESOLVED`, and stock is unchanged. | Existing test, kept |
| AC-F4-4 | The receipt is signed **before** the batch. Its `audit_hash` equals the committed `OFFER_ACCEPTED` hash, even after a retry. | Unit test under forced conflict |
| **AC-F5-1** | `arbiterUrl(href)` honours `?arbiter=` only when the page host is `localhost`, `127.0.0.1` or `[::1]`. On any other host it returns `DEFAULT_ARBITER_URL`. The vendor page uses the same function. | Unit test (`config.test.mjs`). **Fails today** for `https://oja.example/?arbiter=https://evil.example`. |
| **AC-F6-1** | Given a receipt signed by a key that is not pinned, served from a hostile JWKS, then `ArbiterClient.verify` returns `valid: false` and the page shows "Signature NOT verified". | Page test with a second key pair. **Fails today.** |
| AC-F6-2 | A pinned arbiter URL that is not loopback never needs a network JWKS fetch to verify. A loopback dev arbiter may use the fetched JWKS; the result is labelled `key_source: "dev-jwks"` and the badge says so. | Page test |
| AC-F6-3 | `config.js` `ARBITER_KEYS` equals the manifest's `open_arbiter.keys`. If `DEFAULT_ARBITER_URL` is not loopback, the test fails unless at least one key is pinned. | Consistency test, which acts as a pre-deploy tripwire |
| **AC-F7-1** | Given no `ARBITER_SIGNING_JWK` and `DEV` ≠ `"1"`, then `GET /.well-known/jwks.json`, accept and verify return 500 `misconfigured`. No key row is written, and no mandate, offer or stock state changes. | Worker-level test. **Fails today** (a key is generated). |
| AC-F7-2 | With `DEV="1"`, the current dev behaviour is kept. | Existing tests run with `DEV: "1"` |
| **AC-F8-1** | No shipped copy says the maximum never reaches the AI, that the arbiter reveals neither limit, or that browser verification is independent of the arbiter. New copy states the bounded leak and the BYOK caveat. | Copy-lint test over `README.md`, `sites/oja/**/*.{html,js,hocon,json}` (excluding `runtime/`) with a banned-phrase list. **Fails today.** |
| AC-F8-2 | `CLAUDE.md` invariant 1 is reworded (text in §5). | Review |
| AC-REG | Every existing behaviour not listed above is unchanged. Updates to expected values in older tests are limited to prices (F1) and are listed one by one in the delivery report. | `npm test`, `e2e.mjs`, `browser_check.py` with the scripted LLM |

## 4. Design

### F1: grid pricing (`mechanism.js` only)

```text
unitStep(ask) = max(floor((ask*25 + 500)/1000), 10000)        // A1: per unit, ₦100 minimum
L = floor*q ; U = min(max, ask*q) ; g = unitStep(ask)*q
L' = ceil(L/g)*g ; U' = floor(U/g)*g
if L' > U': no offer for this listing
price = nearestGridPoint((L'+U')/2, g, ties → lower)        // B2
offer += { grid_step_cents: g }
```

- `MECHANISM` becomes `{name: "open-arbiter/nash-midpoint-grid", version: "2.0.0", grid_bps: 250, grid_min_unit_cents: 10000, tie: "buyer"}`. Offers and receipts carry `unit_step_cents` and `grid_step_cents`.
- The ranking rule is unchanged.
- `saving_cents` keeps coming from SQL. A test asserts it equals the mechanism's value.

### F2: anti-probing in one statement (`core.createMandate`)

```sql
INSERT INTO mandates (...) SELECT ?,?,...,?
WHERE (SELECT COUNT(*) FROM mandates WHERE buyer_key=? AND sku=? AND created_at > ?) < 3
```

- Read `meta.changes` on the result. A value of 0 means the cap was reached: return 429.
- A `UNIQUE constraint failed: mandates.buyer_key, mandates.terms_key` error becomes 409 `identical_terms`. This fixes research finding F11 too.
- The separate duplicate pre-check is removed; the constraint is the authority.
- This statement and its `MANDATE_CREATED` event go into one batch (F3). The event insert is guarded with `WHERE EXISTS (SELECT 1 FROM mandates WHERE id=?)`, so a capped request writes nothing.

### F3: linear audit chain

- Schema: `CREATE UNIQUE INDEX IF NOT EXISTS events_prev_unique ON events(prev_hash)`.
- A new `Arbiter.commit(build)` helper. It loops up to 8 times:
  1. Read the head.
  2. `build(head)` returns `{statements, events}`, where the events are chained from that head.
  3. Run `db.batch([...statements, ...eventInserts])`.
  4. If the error is the `events.prev_hash` UNIQUE violation, retry. Map any other error. After 8 attempts, return 503 `busy`.
- Every writer uses it: `createVendor`, `upsertListing`, `createMandate`, `resolveMandate`, `acceptOffer`.
- `resolveMandate` is included because it also writes an event. Its offer inserts are guarded by `EXISTS(... state='OPEN')` inside the same batch, which also closes the inferred orphan-offer race from research §5 (3a).
- `verifyChain` is unchanged.

### F4: sign first, then one batch (`core.acceptOffer`)

```text
read offer + mandate (auth, state, expiry checks as today)
commit(head => {
  build OFFER_ACCEPTED event (prev=head), RECEIPT_ISSUED event (prev=that)
  payload.audit_hash = OFFER_ACCEPTED.hash ; signature = sign(payload)   // before any write
  statements = [
    UPDATE mandates SET state='SETTLED' WHERE id=? AND state='RESOLVED',
    UPDATE listings SET stock=stock-? WHERE vendor_id=? AND sku=?,        // trigger aborts if stock<0
    UPDATE offers SET state=CASE WHEN id=? THEN 'ACCEPTED' ELSE 'VOID' END WHERE mandate_id=?,
    INSERT INTO receipts ...                                              // UNIQUE(mandate_id); trigger aborts unless mandate SETTLED
  ]
})
on out_of_stock abort → single UPDATE offers SET state='VOID' WHERE id=? ; 409
on receipts UNIQUE → 409 already_settled
```

- If slice 0 shows D1 rejects `RAISE(ABORT)`, use fallback D4(b) instead:
  - stock gets a `CHECK (stock >= 0)` via the trigger-free table definition (no production data exists to migrate)
  - the receipt insert takes `mandate_id` from `(SELECT id FROM mandates WHERE id=? AND state='SETTLED')` into a NOT NULL column

### F5: dev-only override (`config.js`)

- `arbiterUrl(href = globalThis.location?.href)` returns the query value only if `new URL(href).hostname` is one of `localhost`, `127.0.0.1`, `[::1]`, and the value is http(s).
- `vendor.html` already calls `arbiterUrl()`; no change is needed there.

### F6: pinned key

- `config.js` exports `ARBITER_KEYS`, a **key set**: an array of public JWKs, each with `kid` (A3). Retired keys stay in the set. It is empty while `DEFAULT_ARBITER_URL` is loopback.
- `ArbiterClient` takes the option `{pinnedKeys}`. When `pinnedKeys` is non-empty, `verify` selects the key whose `kid` equals the receipt's `key_id`; no match → `valid: false`. A test verifies a receipt signed by an older pinned key after rotation. When it is empty **and** the base URL is loopback, it fetches the JWKS and labels the result `dev-jwks`. Otherwise it returns `valid: false, reason: "no pinned arbiter key"`.
- `Market`, `bridge-actions.js` and the receipt badge pass the option through and show the key source.
- A new `arbiter/scripts/pubkey.mjs` reads a private JWK on stdin and prints the public JWK with its `kid`, for the deploy step.

### F7: fail closed (`core.key()`, `index.js`)

- `new Arbiter(db, {signingJwk, allowGeneratedKey: env.DEV === "1"})`.
- With no key and generation not allowed, it throws `ArbiterError("misconfigured", "Signing key not configured.", 500)` before any write. F4's sign-first order guarantees that.
- Tests pass `allowGeneratedKey: true` explicitly.

### F8 and F1 copy

| Where | Change |
| --- | --- |
| README "Why" bullets | The buyer's highest total goes to the arbiter. It never goes to sellers or page state, but the AI provider you choose sees it if you tell the assistant. "No agreement" reveals neither limit. **An agreed price narrows each side's per-unit limit to a range at least one price step wide (2.5% of the unit list price, minimum ₦100), however many deals are made.** "Verified in the browser against the arbiter key pinned in the site." |
| README "Limits" | Add the bounded leak (one price step per unit). |
| `app.js` empty-state text, `site.js` negotiate dialog sentence, `index.html` meta description, `market.js` `how_prices_work`, HOCON `negotiation_rules` | Same facts, shorter. The HOCON change needs `build_network.mjs` re-run and its validation output recorded. |
| `CLAUDE.md` | Invariant 1 text as in §5. Commands: `.dev.vars` needs `DEV=1`; `npm run test:worker`; new test count. |

## 5. Proposed CLAUDE.md invariant 1

> 1. **Sealed limits never leave the arbiter as values, and leak only within the price grid.** No API response, event payload, page state, tool result or log contains `floor_cents` or a buyer's `max_total_cents` (a vendor may read its own floors via `GET /v1/listings`). An agreed price depends on a seller's floor only through which per-unit price step it falls in (step = 2.5% of the unit list price, min ₦100), at every quantity, so any number of deals narrows a floor to no less than one step (the buyer's maximum likewise); the property tests in `arbiter/test/mechanism.test.mjs` must keep passing. Tests check all of this; extend them when you add an output.

## 6. Risks and controls

| Risk | Impact | Control / negative test |
| --- | --- | --- |
| R1: cross-quantity narrowing | **Closed by A1.** Cells are identical at every quantity. | AC-F1-7 multi-deal property test |
| R2: the trigger or `RAISE` approach is unsupported on hosted D1 | The accept guard silently missing in production | Slice 0 tests on wrangler dev (local workerd + SQLite). **Hosted D1 cannot be checked without a deploy, which is out of scope.** Flagged for the deploy plan. Fallback D4(b) uses only constraints. |
| R3: local wrangler concurrency ≠ hosted D1 concurrency | Races pass locally but not remotely, or the reverse | The fixes rely on single-statement atomicity, batch transactions and UNIQUE constraints, which hold under any serialisation. Re-run `concurrency.mjs` against staging at deploy time. |
| R4: retry storm on the chain head under load | Latency, 503s | 8-attempt cap; the 503 is visible; contention measured in `concurrency.mjs` output |
| R5: price changes break demo numbers and screenshots | Doc drift | e2e prints the new prices; README examples are regenerated from e2e output, never hand-written |
| R6: schema change on an existing local DB with a forked chain | `CREATE UNIQUE INDEX` fails | Harness uses `--persist-to <tmp>`. CLAUDE.md documents the reset. No production DB exists. |
| R7: pinning without a real key yet | Production verification impossible until deploy | AC-F6-3 tripwire: a non-loopback URL without a pinned key fails `npm test` |

## 7. Implementation slices (failing test first in each)

| # | Slice | Changes | Proof | Stop if |
| --- | --- | --- | --- | --- |
| 0 | **Harness and facts** | `memoryD1.batch()` as a real transaction plus a fault-injection option. New `arbiter/scripts/worker-harness.mjs`: temp `--persist-to`, applies the schema, starts `wrangler dev --var DEV:1 --var ADMIN_TOKEN:… --var BUYER_SALT:…` on a free port, runs seed, e2e and `concurrency.mjs`, then tears down. Adds `npm run test:worker`. **Spike tests:** batch rollback, `RAISE(ABORT)` in a trigger, unique index; the manifest with an `open_arbiter` key passes `build_network.mjs`. | Spike results logged to `evidence/slice0.txt`. `concurrency.mjs` **fails** with today's code (F2, F3). | Batch rollback does not hold on wrangler dev → stop and re-plan F3/F4 |
| 1 | F7 | `core.key`, `index.js`, test constructors, `.dev.vars` docs | AC-F7-1 red, then green; AC-F7-2 | — |
| 2 | F3 | Schema index, `commit()` helper, convert all writers | AC-F3-1..3 red, then green, on node:sqlite and wrangler dev | Retry exhaustion seen in `concurrency.mjs` at 20 parallel requests |
| 3 | F2 | Conditional insert, UNIQUE→409 mapping | AC-F2-1..2 red, then green, on both harnesses | — |
| 4 | F4 | Sign-first accept batch, trigger or fallback | AC-F4-1..4 red, then green | — |
| 5 | F1 | `mechanism.js`, `MECHANISM` 2.0.0, `grid_step_cents` through outcome, receipt and `presentOutcome`. New `mechanism.test.mjs` property tests. Price expectations updated in older tests (listed). | AC-F1-1..6 red, then green; invariant-1 leak tests extended to MCP output, `/audit` and receipts | The property fails for the chosen variant → stop and report to the owner |
| 6 | F6 | `config.js`, `ArbiterClient`, `Market`, bridge, badge text, manifest, `pubkey.mjs` | AC-F6-1..3 | `build_network.mjs` rejects the manifest key → move the pin to `config.js` only and report |
| 7 | F5 | `config.js` | AC-F5-1 | — |
| 8 | F8 + F1 copy | README, page copy, HOCON (+ rebuild), CLAUDE.md | AC-F8-1..2; `build_network.mjs` output | — |
| 9 | Full verification | — | `npm test`, `npm run test:worker`, `browser_check.py` with `fake-llm.mjs`, all outputs saved in `evidence/`; `git diff --stat` reviewed; no files under `runtime/` changed (`diff -rq`) | Any red check |

## 8. Traceability matrix

| Requirement | Code | Tests | Docs |
| --- | --- | --- | --- |
| F1 grid, zone, no-agreement | `mechanism.js` `resolve`, `gridStep` | AC-F1-1, -2 (`mechanism.test.mjs`) | README, HOCON, `market.js` |
| F1 bounded leak ≥ 1 step, also across deals | `mechanism.js` (B2 + A1) | AC-F1-3, -4, -7 property tests | CLAUDE.md inv. 1, README Limits |
| F1 determinism kept | `mechanism.js` | AC-F1-5 source scan | CLAUDE.md inv. 2 |
| F1 versioning | `MECHANISM`, outcome/receipt fields | AC-F1-6, e2e | README |
| F2 cap atomic | `core.createMandate` | AC-F2-1, -2 (node:sqlite + `concurrency.mjs`) | CLAUDE.md inv. 3 |
| F3 linear chain | `schema.sql` index, `core.commit` | AC-F3-1..3 | — |
| F4 atomic accept | `core.acceptOffer`, schema trigger/constraint | AC-F4-1..4 | — |
| F5 override dev-only | `config.js` `arbiterUrl` | AC-F5-1 | README "Run locally" |
| F6 pinned key | `config.js`, `arbiter-client.js`, `market.js`, `app.js`, bridge, manifest, `pubkey.mjs` | AC-F6-1..3 | README deploy steps |
| F7 fail closed | `core.key`, `index.js` | AC-F7-1, -2 | README, CLAUDE.md commands |
| F8 copy | README, `app.js`, `site.js`, `index.html`, `market.js`, HOCON | AC-F8-1 copy lint | CLAUDE.md |
| Invariants 1–9 unchanged otherwise | all | AC-REG, existing 18 tests | — |

## 9. Verification and release

- **Commands** (all exist today or are added in slice 0):
  - `npm test`
  - `npm run test:worker` (isolated wrangler dev; seed + e2e + concurrency)
  - `(cd sites/oja && node ../../../agentic-web/skills/agentify-website/scripts/build_network.mjs oja_market.hocon --manifest agent-manifest.json)`
  - `node tests/fake-llm.mjs` on port 8799, plus `serve_site.mjs` on 8080, plus `python3 sites/oja/tests/browser_check.py <scratchpad>/shots`
  - `diff -rq ../agentic-web/skills/agentify-website/runtime sites/oja/runtime`
- **Release:** none. Work goes on a branch `arbiter-hardening`. Commits happen only when you ask. No deploy.
- **Rollback:** `git revert` of the branch. Then reset local D1 (`rm -rf arbiter/.wrangler/state` + schema + seed). Receipts issued under mechanism 1.0.0 stay verifiable, because the signature covers their own payload.
- **Records:**
  - `docs/rpi/arbiter-hardening/evidence/` holds the red/green outputs for each slice.
  - `docs/rpi/arbiter-hardening/delivery.md` is written at the end.

## 10. Decision record

- **Plan gate:** **approved** by the owner in chat, 2026-11-23: B2, ties toward the buyer, D4 gated on slice 0, manifest key `open_arbiter`, amendments A1–A4.
- **D4 decided:** constraint-only fallback (A5), owner, 2026-11-23.
- **Residual risks accepted:** R2/R3 (hosted D1 unverified until a deploy plan).
- **Open item (owner, 2026-11-23, no code now):** a single global audit chain serializes all writes; contention is handled by retry with jittered backoff, then `503 busy` (slice 2). The scaling path is per-mandate chains (with a global chain of heads) or a Durable Object owning the log. It is recorded in README "Limits".
- **Approval reference:** owner chat message, 2026-11-23.
