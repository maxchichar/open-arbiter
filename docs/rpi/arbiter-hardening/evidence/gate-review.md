# Phase 0 gate: independent review and triage

Date: 2026-11-24 · Branch `arbiter-hardening` at `ec5a46d` (diff from `main`)

## How the review was run

- A fresh general-purpose subagent with no access to this conversation. It was told to read **only** three files, copied to the session scratchpad:
  - `git diff main..HEAD` (7,696 lines)
  - `CLAUDE.md` (with the P0.9 invariants)
  - `docs/rpi/baseline/research.md`
- It was told not to open other files, run git or browse the repository. Its own report says it read only those three files. That cannot be verified independently.
- The brief: correctness, concurrency and security bugs in `arbiter/src` and `sites/oja/js`, with a severity, a failure scenario and a confidence label for each.
- Its 11 findings are below, triaged by me. The severities are mine, and they differ from the reviewer's where noted.

## Triage

| # | Finding (short) | Reviewer | Triage | Action |
| --- | --- | --- | --- | --- |
| R1 | The grid bound holds per ask. A re-list at a new ask with the same floor moves the grid, and deals on both grids narrow the floor below one step (example: 100,000 kobo left against a 450,000 step) | medium-high | **high**: breaks CLAUDE.md invariant 1 as written ("any number of deals") | **Red test written** (`mechanism.test.mjs`, `todo` until fixed; `gate-red-r1-ask-change.txt`: `floors 16100001..16200000 (100000) < one step 450000`). The fix changes approved pricing policy, so **it waits for the owner's decision**. Recorded as caveat 2 in ADR 0001 |
| R3 | On a binding call (accept, create), a 5xx that is not a definite arbiter refusal is treated as "refused", but it can follow a committed write. Accept then reports "nothing changed" after a purchase; create drops the pending secret, which strands a daily attempt | medium | **high**: misreports a binding purchase and breaks the P0.4 guarantee ("unknown, never 'nothing changed'") | **Fixed, red then green** (below) |
| R2 | A listing whose floor and ask share a grid cell, or whose ask is under ₦100, can never trade, and the vendor is not warned | medium | medium | Recorded. Fix candidate: `checkListing` rejects or warns when `ceil(floor/u) > floor(ask/u)`; show it in `vendor.js` |
| R4 | The one global chain head is a bottleneck that anonymous `POST /v1/mandates` can load, and writers that use up their retries get 503 `busy` | low-medium | medium. **Seen locally:** `chain.test.mjs` "concurrent writes of every kind" (36 writers) fails about 1 in 14 full `npm test` runs with a `busy` (see "Flake" below) | Recorded in ADR 0003. Flake handling **waits for the owner's decision** |
| R5 | Replay works as an oracle for the max for anyone holding a mandate's `buyer_token_hash` (same hash, other max → 409 `token_reused`) | low | low: the hash is never output; exploiting it needs a leak | Recorded. Fix candidates: a test that `token_hash` never appears in any output or log, or replay requiring the preimage |
| R6 | A legacy mandate left SETTLED with no receipt by the old non-atomic accept could be settled again | low | low: no deployed data exists, and old databases fail `ensureSchema` until reset | Recorded. Before any migration of real data, check for SETTLED mandates with no receipt |
| R7 | The out-of-stock VOID runs outside `commit()` with no audit event. A deleted listing gives a receipt with no stock reserved | low | low: there is no listing-delete path in the API today | Recorded |
| R8 | The client timeout does not cover reading the body (`res.json()`) | low | low: the runtime's abort signal still applies | Recorded. Fix candidate: clear the timer after the body is parsed |
| R9 | A negotiate with an unknown outcome returns `ok:false` (grounding says "refused"); `reason.split(":")` cuts the host at its port | low | low | **Message part fixed** with R3, since R3's new message goes through the same line: `unknown` results now carry `cause`. The `ok:false` shape is recorded: the text tells the visitor that asking again is safe |
| R10 | `#settleUnknown` clears the unknown mark after any successful read, even while the original accept may still be in flight | low | low: the atomic accept prevents a double settlement; UI confusion only | Recorded |
| R11 | CSP hygiene: `http://localhost:8787` stays in production `connect-src` until the deploy edit (the tests enforce it matches the arbiter URL); the bridge CSP allows LLM origins it never uses; `isBlockedProviderCall` compares to `DEFAULT_ARBITER_URL` | low | low | Recorded. Narrow the bridge `connect-src` at the deploy step |

The reviewer also listed what it checked and found correct. Highlights:
- no sealed values in any output it could trace;
- `lo = ceil(floor/unit)` at every quantity;
- the chain stays linear, including the genesis race;
- the cap is atomic;
- concurrent idempotent creates make one row;
- the accept guards settle at most once;
- pinned-key verification and the loopback-only `?arbiter=`.

## R3 fix: red, then green

- **Red** (`gate-red-binding-5xx.txt`): new `sites/oja/tests/binding-5xx.test.mjs` failed 6 of 7 tests. In each failing case the arbiter processed the request and the browser got one of three answers:
  - an HTML 502 page;
  - a JSON 500 without the arbiter's `{error, message}` shape;
  - the arbiter's own catch-all `internal` 500.

  The client reported `{"ok":false,"reason":"The arbiter answered 502."}`, `{…"code":"worker exceeded CPU"}` and `{…"code":"internal"}`: definite refusals. The receipt and the mandate existed on the server. The busy-503 guard passed, as expected.
- **Fix** (`sites/oja/js/arbiter-client.js` `#call`): on a binding call, a non-2xx counts as definite only if it is the arbiter's own refusal: a body with string `error` and `message`, and `error` ≠ `internal`. Anything else returns `unknown`, with `cause` "The arbiter at <host> answered <status> without saying whether it went through". Non-binding calls are unchanged.
- **Green:** `binding-5xx.test.mjs` 7 / 7.
  - Accept → `Market.acceptOffer` throws unknown, sent once, the offer is shown `UNKNOWN`, re-accept is blocked.
  - Create → unknown; asking again recovers the same mandate, and the server still has 1 mandate.
  - `busy` stays definite.
  - `npm test` 122 pass (on the runs not hit by the R4 flake).

## Flake (R4 seen locally)

- 1 failure in 14 full `npm test` runs before any R3 change was involved: `chain.test.mjs` "concurrent writes of every kind keep one linear chain", with seed `TEST_SEED=2874168682`.
- The failure was one rejected writer: "The arbiter's audit log is busy." The chain stayed linear, and the test failed on its "no rejections" assertion.
- Replaying the seed alone passed 3 / 3. The seed fixes the jitter, not the event-loop scheduling, and the failure needs the CPU load of the parallel suite.
- The slice 5 flake check (30 isolated runs of the file, 0 failures) did not catch it, because it ran the file alone.
- Rate measurement over 25 more full runs: see below.

### Flake rate (measured 2026-11-24, 12 cores, load average about 10 during the loops)

| Code | Full `npm test` runs | Failing (all on this one test) |
| --- | --- | --- |
| `14aac06` (slice 5, before any gate change), in a scratch worktree | 15 | **6** |
| this branch + the R3 fix | 25 + 15 | **8 + 5** |
| **Experiment only, not committed:** `CHAIN_ATTEMPTS` 12, each backoff capped at 128 ms (worst-case total wait about 0.9 s, was about 0.5 s) | 20 | **0** |

- The flake was there before the gate work, and it is load-dependent. The earlier batch of 12 runs had 1 failure.
- The 8-attempt budget is too small for 36 writers when the CPU is busy. Hosted D1 round trips are slower than node:sqlite, so the same exhaustion is likely in production under real concurrency, which is reviewer finding R4.
- Owner decision requested: raise the budget (code), let the test accept `busy` (test), or both.

## Owner decisions (2026-11-24) and fixes

### R1 (+ R2): nested grid, mechanism 3.0.0

- **Decision:** the nested grid. `unit_step` = ₦100 × 2^k, the largest not above 2.5% of the unit list price (₦100 if 2.5% is below that).
- **R2 folded in:** while designing the fix I found that the nested bound also needs R2's listing rule. A floor in the cut-off top step can never trade, and "no deal even at list price" pins it to less than one step, even with a single ask. `checkListing` now refuses `floor > maxFloor(ask)` and asks under ₦100. With that rule, every observation is a union of whole cells of the finest grid used, so the bound holds for every sequence, no-deals included. The proof is in ADR 0001.
- **Red** (`gate-red-r1-nested.txt`, new tests against the 2.0.0 code):
  - reviewer's example `floors 16100001..16200000 (100000) < one step 320000`;
  - random multi-ask sequences `floors 15664441..15819270 (154830) < smallest step 320000`;
  - `steps 408385 and 302100 do not nest`;
  - a dead listing (ask ₦990, floor ₦950) accepted.

  The AC-F1 tests also failed, because their oracle and domain now follow the 3.0.0 rule.
- **Green:**
  - `mechanism.test.mjs` 15 / 15;
  - AC-F1-7 now asserts the bound on **every** sequence, not only when a deal agreed;
  - the R1 multi-ask property: 2,000 sequences across 2–4 list prices, more than 300 of them with a step change.
- **Price expectations updated** (each computed by the code and checked by hand against the step arithmetic in the test comments):

| Test | 2.0.0 | 3.0.0 |
| --- | --- | --- |
| `mechanism` worked example (q 2, max ₦170,000, ask ₦90,000, floor ₦75,000) | ₦157,500 | ₦160,000 (step ₦1,600) |
| `core` midpoint | ₦157,500, saving ₦22,500 | ₦160,000, saving ₦20,000 |
| `core` capped at list price | ₦83,250 | ₦81,600 |
| `core` full negotiation (Iya / Chika; receipt) | ₦81,000 / ₦83,600; ₦81,000 | ₦81,600 / ₦83,200; ₦81,600 |
| `market` rice q 2 | ₦165,600 | ₦166,400 |

- **Copy** (README, `index.html`, `vendor.html`, `market.js`, MCP instructions, HOCON; network rebuilt, `gate-build-network.txt` exit 0) and CLAUDE.md invariant 1 now give the ₦100 × 2^k step. The vendor page says the floor must sit at least one step under the list price. A copy-lint pattern now bans the 2.0.0 step wording; it caught the stale built `oja_market.network.json` before the rebuild.
- **Trade-off:** the step, and with it the leak bound, is now 1.25–2.5% of the list price instead of 2.5%. For ₦90,000 it is ₦1,600 instead of ₦2,250.

### R4 flake: retry budget raised

- `CHAIN_ATTEMPTS` went from 8 to 12, and each jittered wait is capped at 128 ms (at most about 0.9 s in total before 503 `busy`).
- Before: 6 / 15 full runs failed at `14aac06`. After: **0 / 25** (`gate-flake-after.txt`, load average about 9).
- ADR 0003 updated.

### Still recorded, not fixed

R5, R6, R7, R8, R10, R11 and the `ok:false` shape of R9, as triaged above.
