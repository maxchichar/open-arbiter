# Slice 5: P0.5, P0.6, P0.7, P0.8, P0.10 + schema-check cache (evidence)

Date: 2026-11-23 · Branch: `arbiter-hardening` on top of `cdc4990` (uncommitted)

## Red (all recorded before the fix)

| Task | Test file | Red on the old code | Main failure |
| --- | --- | --- | --- |
| P0.5 F1 grid | `arbiter/test/mechanism.test.mjs` | **9 fail / 2 pass** (`slice5-red-mechanism.txt`) | One deal pins the floor exactly: `floors 3164..3164 (1) < unit_step 10000`. Three deals at ask ₦610: `floors 34925..34925 (1)`. Totals not on a grid. |
| P0.6 F5 + F6 | `sites/oja/tests/pinned-key.test.mjs` | **9 / 9 fail** (`slice5-red-pinned-key.txt`) | `?arbiter=https://evil.example` honoured on `https://oja.example`. A hostile arbiter's receipt **verified** using its own JWKS. No `ARBITER_KEYS`, no manifest pin. |
| P0.7 F8 | `sites/oja/tests/copy.test.mjs` | **3 / 3 fail** (`slice5-red-copy.txt`) | 15 banned claims, e.g. README "not to the seller, the page state or the AI", "reveals neither", "rather than trusting the server"; 3 midpoint mentions with no step. |
| P0.8 CSP | `sites/oja/tests/csp.test.mjs` | **5 fail / 1 pass** (`slice5-red-csp.txt`) | No page CSP in `_headers`; inline `<script>` in `vendor.html`. |
| P0.10 negotiate | `arbiter/test/idempotent-mandate.test.mjs` | **7 fail / 1 pass** (`slice5-red-idempotent-mandate.txt`) | No `buyer_token_hash`: the server always made the secret and returned it, and a repeat was a new mandate or a 409. |
| P0.10 client | `sites/oja/tests/negotiate-retry.test.mjs` | **5 / 5 fail** (`slice5-red-negotiate-retry.txt`) | A lost create was "could not be reached"; asking again gave `identical_terms`, which stranded that day's attempt. |
| Schema cache | `arbiter/test/schema-guard.test.mjs` | **1 fail / 5 pass** (`slice5-red-schema-guard.txt`) | `sqlite_master queried 4 times for 4 writes` |

The passes in the red runs are regression guards: purity scan, monotonicity, identical terms with a new secret, the coded-tool worker CSP, and the outdated-schema refusals.

**Test corrections made during red** (both are in the test, not the code):
- The copy lint first flagged "deterministic code, **not an AI**", which is true. I narrowed the pattern to "…not/never … **the** AI".
- In `negotiate-retry`, "a new budget … identical terms" fails on the old code for a setup reason: its second answer is lost too. It is a guard for the new behaviour, not evidence against the old code.

## Changes

| Task | Change |
| --- | --- |
| **P0.5** | `mechanism.js`: `unitStep(ask) = max(10,000, round(2.5% × ask))`, B2 snap-then-midpoint, ties to the buyer. `MECHANISM` is now `open-arbiter/nash-midpoint-grid` 2.0.0 with `grid_bps 250`, `grid_min_unit_cents 10000`, `tie: "buyer"`. Offers, outcomes and receipts carry `unit_step_cents` and `grid_step_cents`. The step is derived from the stored `list_total_cents / quantity`, so no schema change is needed. MCP shows `price_step` and the mechanism version. |
| **P0.6** | `config.js`: `arbiterUrl(href)` honours `?arbiter=` only on `localhost`, `127.0.0.1` or `[::1]`; adds `isLoopback`, and `ARBITER_KEYS = []`. `ArbiterClient({pinnedKeys})` verifies only against the pinned key whose `kid` equals the receipt's `key_id`, and never fetches JWKS when keys are pinned. Without pins it falls back to the JWKS only for a loopback arbiter (`key_source: "dev-jwks"`); otherwise it returns `valid: false`. The page, bridge and badge show the source ("Signature verified (dev key, not pinned)"). The manifest gets `"open_arbiter": {"url", "keys"}`; `build_network.mjs` accepts it (`slice5-build-network.txt`). New `arbiter/scripts/pubkey.mjs` prints public fields only (tested). |
| **P0.7** | Copy in README, `index.html`, `vendor.html`, `app.js`, `site.js`, `market.js` `how_prices_work`, the HOCON (network rebuilt) and the MCP instructions. It now states the step, the bounded leak and the AI-provider caveat. `CLAUDE.md` invariant 1 uses the plan's §5 text; the stale test counts are removed. |
| **P0.8** | `_headers`: page CSP on `/`, `/index.html`, `/vendor` and `/vendor.html`. `script-src 'self'`, `default-src`/`object-src`/`frame-src` are `'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `worker-src 'self'`, `style-src-elem 'self'` plus the runtime `<style>` hash, `style-src-attr 'unsafe-inline'`. `connect-src` allows exactly the site, the arbiter and the runtime's 7 LLM provider origins. `/bridge/*` has a script policy and stays frameable (skill rule). `vendor.html`'s inline script moved to `js/vendor.js`, and its style attributes became a class. |
| **P0.10** | `POST /v1/mandates` accepts `buyer_token_hash` (64 lowercase hex). The same hash with the same terms and budget returns the existing mandate (`replayed: true`, HTTP 200, nothing written), including at the daily cap and from a new IP. The same hash with anything else returns 409 `token_reused`. New `UNIQUE INDEX mandates_token_unique`, which `ensureSchema` now requires. The client makes a 32-byte secret, sends its hash, retries a lost create once, and keeps the secret per terms and budget, so asking again recovers the same mandate. A lost resolve is retried once (it is idempotent). The server-made token path (MCP, REST) is unchanged. |
| **Schema cache** | `ensureSchema` uses a `WeakSet` of checked databases. `index.js` passes one module-level set, so the check runs once per database binding per Worker instance. |

**Older test expectations updated (AC-REG, prices only, plus pinning):**

| Test | Before (mechanism 1.0.0) | After (2.0.0) |
| --- | --- | --- |
| `core.test.mjs` midpoint | ₦160,000 (saving ₦20,000) | ₦157,500 (saving ₦22,500) |
| `core.test.mjs` capped at list price | ₦82,500 | ₦83,250 |
| `core.test.mjs` full negotiation | Iya ₦82,000, Chika ₦84,000; receipt ₦82,000 | Iya ₦81,000, Chika ₦83,600; receipt ₦81,000 |
| `market.test.mjs` rice | ₦166,858.50 | ₦165,600 |

Every new value was computed by the code and checked by hand against the step arithmetic (see the test comments).

`market.test.mjs` and `accept-unknown.test.mjs` now give their non-loopback test arbiter a fixed signing key and pin it. Without a pin their receipts are, correctly, not verified.

## Green

- `npm test`: **109 / 109**, 1.0 s (`slice5-green.txt`).
- Flake: mechanism, idempotent-mandate, accept, antiprobing, chain, negotiate-retry and accept-unknown, **30 runs with fresh seeds, 0 failures** (`slice5-flake.txt`).
- `npm run test:worker`: **3 runs, 36 PASS, 0 FAIL** (`slice5-test-worker.txt`). New on workerd:
  - `P0.10 concurrent creates with one secret make one mandate`: `{"200":5,"201":1}`
  - repeat → 200, and the secret works as the token
- Schema cache on workerd (`slice5-workerd-schema-cache.txt`): a write on a fresh instance → 201. A required index dropped under the running Worker → the next write is still 201 (cached). After a restart (new instance) → **500**.
- **`browser_check.py`** (`slice5-browser-check.txt`): **BROWSER CHECK OK, 0 CSP violations** on the index (whole flow and phone width) and on the vendor page. The one live `<style>` is allowed by hash. Screenshots 1–7 are in the session scratchpad, not the repo.
  - Isolated arbiter with a temp state on :8787 (the site's default URL, no `?arbiter=`), the skill's `serve_site.mjs` on :8080, `fake-llm.mjs` on :8799.
  - The flow: manual haggle, accept, verify by id; the assistant's bid dialog, offers (₦165,600 / ₦169,100 on the grid), accept, receipt; phone layout; vendor page.
- **Negative control** (`slice5-browser-check-negative-control.txt`): with the style hash removed from the policy, the check **fails**. Chrome reports `Applying inline style violates … 'style-src-elem 'self'' … a hash ('sha256-pmEyk…')`, the same hash the policy carries. So the check really enforces and detects.
- `runtime/` is identical to the skill's copy (`slice5-runtime-diff.txt`).

## How the browser check applies the CSP (limits, stated plainly)

- `serve_site.mjs` does not send `_headers`. So `browser_check.py` adds the page CSP from `_headers` to each HTML response itself.
- It adds one test-only `connect-src` origin, the scripted LLM at `http://127.0.0.1:8799`, which stands in for the visitor's AI provider.
- Because Playwright fulfils those pages, Chrome's Local Network Access check no longer sees them as loopback and blocked the local arbiter. The script grants `local-network-access` for the test origin. That permission does not affect the CSP.
- **Not verified:** that Cloudflare Pages serves these exact headers. Check that at the first deploy, e.g. with `curl -sI`.

## Open points for the Phase 0 gate review

1. **P0.1, P0.2 and P0.9 have no mapping in `plan.md`.** The plan never had P0.x IDs, so I added §0b with the IDs you gave. P0.1/P0.2 probably mean F7/F3/F2 (slices 1–3) and P0.9 is unknown. Please confirm.
2. **CSP trade-off:** a custom "Provider URL" in the assistant settings that is not one of the runtime's 7 providers is blocked by `connect-src`. Inline style **attributes** are allowed because the runtime renders some and it must not be edited.
3. **Deploy tripwires:**
   - `DEFAULT_ARBITER_URL`, `ARBITER_KEYS`, the manifest `open_arbiter` and the CSP `connect-src` must agree, and a public URL needs a pinned key; `npm test` enforces this.
   - The page CSP hash must be recomputed whenever `runtime/` is replaced; `csp.test.mjs` fails until it is.
4. **Dev badge:** locally (no pinned key) receipts show "Signature verified (dev key, not pinned)". The scripted LLM's closing line still says "checked in your browser", which is true in both modes.
5. Still open from earlier: hosted D1 unverified (R2/R3); local DBs must be reset (the schema now also needs `mandates_token_unique`).

## Owner decisions on the open points (2026-11-24) and follow-up

1. **IDs:** P0.0 = F7 (slice 1), P0.1 = F3 (slice 2, `f762139`), P0.2 = F2 (slice 3, `e63c362`), P0.9 = CLAUDE.md invariants and plan update. Added to `plan.md` §0b.
2. **CSP trade-offs accepted, with two changes:**
   - **Custom provider blocked:** keep the strict `connect-src`; the settings panel must say so and name the allowed providers. Done without editing `runtime/`: new `sites/oja/js/provider-guard.js`, loaded by `site.js` after boot. It adds a warning under the runtime's Provider URL field while the field names an origin outside the policy, and when the browser actually blocks a model call (`securitypolicyviolation`, `connect-src`, not the arbiter or the page) it shows the same sentence in the assistant status line and opens the advanced settings. The allowed list is the runtime's `API_KEY_PROVIDERS`, the same source `csp.test.mjs` uses for `connect-src`. README "Limits" states the limit.
     - Red: `tests/provider-guard.test.mjs` fails without the module (`slice5b-red-provider-guard.txt`; module-not-found, a weak red stated as such). Green: 6 tests, `npm test` **115 / 115** (`slice5b-green.txt`).
     - Browser: `browser_check.py` step 8 runs a separate context whose saved setup uses `https://llm.blocked.example/v1`. The notice shows before sending, names all providers, and after sending the status line says the call is blocked; the three violations it causes are all `connect-src` to that origin and are checked there, not counted with the main flow. Main flow: **0 CSP violations** (`slice5b-browser-check.txt`). Screenshot `8-provider-blocked.png` in the session scratchpad.
   - **Inline styles split:** the policy was already split in slice 5: `style-src-elem 'self' 'sha256-…'` (no `'unsafe-inline'`; `'self'` stays for `styles.css` and `assistant.css`) and `style-src-attr 'unsafe-inline'`. `csp.test.mjs` asserts both. Rerun: 0 violations (above). Note: there is no `style-src` fallback, so a browser without `style-src-elem` support (Firefox < 108, Safari < 15.4) falls back to `default-src 'none'` and renders unstyled. Not changed; recorded.
3. `runtime/` still identical to the skill's copy (`diff -rq`, empty).
