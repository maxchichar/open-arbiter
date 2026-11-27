# OpenArbiter Production Plan (RPI)

Copied from the plan doc on 27 Nov 2026 (https://claude.ai/artifact/A8BxpztxPy9dSt6EGzQxx9). The doc is the working copy; update this file when the doc changes.

Nine phases, 49 days at 3 hours a day (147 hours), from 23 Nov 2026 to the Devpost deadline on 11 Jan 2027 at 17:00 Lagos time. Every phase ends deployable, tested and documented, so there is always something submittable.

## How to use this plan

Every phase has the same four parts, mirroring your RPI skill:

1. **Research:** questions you must answer, in your own words, before planning. Write answers to `docs/rpi/<phase>/research.md`.
2. **Plan:** the decisions (ADRs) the phase needs. Write them before code; Claude Code's plan for the phase must cite them.
3. **Implement:** tasks, each **1 to 3 hours**, each one slice that ends green and committed. Task IDs (P3.4) go in branch names and commit messages.
4. **Verify:** the phase gate. A phase is done only when every gate box is ticked with evidence. The next phase does not start before that.

**Daily loop (3 hours):** 30 min research or review yesterday's evidence; 15 min confirm today's task and its "done when"; 2 h implement with Claude Code, red test first; 15 min verify, commit, update the plan.

**Sizes:** S = up to 1 h, M = up to 2 h, L = up to 3 h. Anything bigger is split before it starts. Each phase reserves about 15% of its hours as slack; if a phase overruns its slack, cut scope using the cut lines at the end, never the gate.

**Prompt shape for Claude Code, per task:**

```
Use the rpi-production-engineering skill. Tier: <critical|standard>.
Task <ID>: <task>. Done when: <done when>.
Research the code it touches, write the failing test first, implement the smallest change, run npm test and the relevant worker checks, write evidence to docs/rpi/<phase>/evidence/<ID>.md. Stop and report before committing.
```

## What production-grade means here

Production-grade is a checklist, not a feeling. Two levels apply.

**Every task is done when:**

- [ ] A test that failed before the change passes after it (red, then green), plus tests for invalid input and the failure path.
- [ ] `npm test` and `npm run test:worker` pass; no test was weakened to pass.
- [ ] Invariants in `CLAUDE.md` still hold, or the change updates them on purpose with a reason.
- [ ] Security note written: what new input, secret or boundary the change touches.
- [ ] Docs updated where behaviour changed (README, CLAUDE.md, API contract).
- [ ] Evidence file in `docs/rpi/<phase>/evidence/` with exact commands and results.
- [ ] You can explain the change without Claude Code: what, why, and how it fails.
- [ ] One focused commit on the phase branch.

**Every phase passes this gate before the next starts:**

| Area | Gate |
| --- | --- |
| Correctness | Phase acceptance criteria all have passing tests; property tests where rules are numeric |
| Security | Threat model rows for this phase reviewed; no open high-severity finding |
| Reliability | Failure paths tested (timeouts, conflicts, missing config); no write repeated after an unknown outcome |
| Observability | New paths log structured events without secrets; errors carry a stable code |
| Operations | Deployed to staging (from Phase 1 on); rollback tested; runbook updated |
| Compatibility | Pinned upstream commit unchanged, or upstream changes reviewed and the linking tests rerun |
| Docs | ADRs for the phase's decisions; README and limits honest |
| Review | A fresh review by an agent or person who did not write the code, findings resolved or recorded |
| Release | Merged to `main`, tagged `v0.<phase>`, release notes written |

## Timeline

| Phase | Dates | Hours |
| --- | --- | --- |
| P0 Hardening | 23 to 28 Nov | 18 |
| P1 Deploy, CI, ops | 29 Nov to 3 Dec | 15 |
| P2 Mechanism v1 (+ P5.1) | 4 to 8 Dec | 15 |
| P3 Portable evidence | 9 to 15 Dec | 21 |
| P4 Supplier side | 16 to 22 Dec | 21 |
| P5 Interop, spec §6 | 23 to 28 Dec | 18 |
| P6 Security | 29 Dec to 2 Jan | 15 |
| P7 Product quality | 3 to 6 Jan | 12 |
| P8 Launch, submit | 7 to 10 Jan | 12 |

Milestones: first live version 3 Dec; holiday risk 24 Dec to 1 Jan; Devpost deadline 11 Jan.

Phases run in order because each gate feeds the next: deploys before mechanism changes, evidence before suppliers sign, suppliers before cross-site proofs. The holiday band overlaps Phase 5, the most important phase for judging, so its first tasks are front-loaded.

## Phase 0: Finish arbiter hardening

**Goal:** every finding from the baseline research (F1 to F8, F10) is fixed with red-then-green evidence. **23 to 28 Nov, 18 h. Tier: critical.** Branch `arbiter-hardening`.

**Status:** Phase 0 complete: merged to main and tagged v0.0 on 24 Nov (126 tests, 3 clean worker and browser runs, independent review with 11 findings: R1 to R4 fixed, the rest mapped to later tasks). Mechanism is now 3.0.0 (nested ₦100 × 2^k grid). Commits: slice 0 `7a952a2`, slice 1 (F7, P0.0) `d6b516a`, slice 2 (F3, P0.1) `f762139`, slice 3 (F2, P0.2) `e63c362`, slice 4 (F4, P0.3, P0.4) `cdc4990`, slice 5 (P0.5 to P0.8, P0.10) `14aac06`, ADRs `ec5a46d`.

**Research**

- Why does a check-then-insert race, and why is a single `INSERT ... SELECT ... WHERE` safe in SQLite?
- What does D1 guarantee for a `batch()`? Quote the Cloudflare doc sentence.
- Why does a global hash chain serialize writers, and what are the two ways to scale it?
- Why does B2 leak at most one per-unit step, and when does it leak more?

**Plan (ADRs)**

- ADR: price leakage policy (B2, per-unit grid, published bound).
- ADR: constraint-only atomic settlement (no triggers).
- ADR: audit chain design and its scaling limit.

**Implement**

| ID | Task | Size | Done when |
| --- | --- | --- | --- |
| P0.0 | F7: fail closed without a signing key unless DEV=1 (pre-plan, slice 1) | S | Refusal writes nothing |
| P0.1 | Commit slice 2 with seeded jitter and the retry-precondition comment | S | Seed printed on failure; 30 seeded runs green |
| P0.2 | F2: daily cap as one conditional insert; duplicate terms return 409 | M | `concurrency.mjs` F2 green in 3 runs; at most 3 mandates per buyer per item per day |
| P0.3 | F4: sign first, one batch, `CHECK (stock >= 0)`, conditional receipt insert, `UNIQUE(receipts.mandate_id)` | L | Fault-injection test: any statement failing leaves no settled mandate without receipt; double accept refused |
| P0.4 | F4b: map CHECK failure to `out_of_stock` on node:sqlite and wrangler | S | Same error code from both |
| P0.5 | F1: B2 on per-unit grid in `mechanism.js`; multi-quantity property test incl. ₦610 | M | 0 failures in 10,000 random sequences; README states the bound |
| P0.6 | F5 + F6: `?arbiter=` loopback only; pinned key set with `kid` in config and manifest | M | Tests: override ignored on non-loopback; receipt from an unpinned key fails |
| P0.7 | F8: copy-lint test, then correct the copy | S | Lint bans "never shown to the AI" style claims; page and README pass |
| P0.8 | F10: strict Content-Security-Policy for Oja pages | M | `_headers` CSP; browser check passes with no CSP violations in the console |
| P0.9 | Update invariants in `CLAUDE.md` and the hardening plan | S | Invariants 1 and 3 match the new behaviour |
| P0.10 | Negotiate survives a lost response: client generates the buyer secret, sends only its hash; retry with the same secret and terms returns the existing mandate | M | A dropped create response loses neither the attempt nor the token; the daily cap still holds |

Schema guard (from slice 4): `commit()` refuses writes when the CHECK or the `prev_hash` index is missing; cached per Worker instance; to be replaced by a migration-level check in P1.2.

**Verify (gate)**

- [x] `npm test`, `npm run test:worker`, `concurrency.mjs` all green, 3 runs each
- [x] Independent review of `core.js` and `mechanism.js` diff, findings resolved
- [x] Three ADRs merged
- [x] Merged to `main`, tagged `v0.0`

## Phase 1: Deploy, CI and operations foundation

**Goal:** a staging and a production environment on Cloudflare over HTTPS, deployed only through CI, with tested rollback and restore. After this phase you always have a live, submittable version. **29 Nov to 3 Dec, 15 h. Tier: critical** (secrets, deploys).

**Status:** P1.0 done 24 Nov as `ebed97f` (131 tests, browser check with a mocked Otari sign-in, 0 CSP violations). P1.1 local part done 27 Nov as `c2da062` (159 tests; per-environment config, deploy guard script, secret scan); its Cloudflare checks wait for approval A1. P1.2 done locally 27 Nov (191 tests; numbered migrations, migration-level guard, M2 check against v0.0, R6 marker and pre-migration check, ADR 0005); hosted-D1 checks go to P1.8.

**Research**

- How do wrangler environments separate staging and production Workers, D1 databases and secrets?
- How do D1 migrations work, and how do you apply one safely to a database with data?
- How do Worker versions and rollback work? What does D1 offer for point-in-time restore? Verify both in Cloudflare's current docs.
- What are the free-plan limits (requests, D1 size, CPU time) and what happens when you hit them?
- What is the minimum Cloudflare API token scope CI needs?

**Plan (ADRs)**

- ADR: environments and release flow (staging on merge, production by manual approval).
- ADR: secrets management (which secrets exist, who holds them, rotation).
- ADR: observability (log format, error codes, what is never logged).

**Decided 24 Nov from Phase 1 research:**

- Production migrations are applied manually; migrations must stay compatible with the previous Worker version, and mechanism changes never ship as split-traffic deployments.
- Oja stays on its own origin, separate from the arbiter, to show third-party use. Oja on Workers static assets if `_headers` is applied (checked on staging), otherwise Pages.
- Publisher-funded inference: yes, in P5.7, with a hard daily spending cap.

**Implement**

| ID | Task | Size | Done when |
| --- | --- | --- | --- |
| P1.0 | Upgrade the runtime pin to upstream `d67755e` (publisher-funded routers, Connect with Otari) | M | Runtime matches upstream; CSP allows Otari Connect and the new style hash; all tests and the browser check pass; pin updated in CLAUDE.md. **Done** |
| P1.1 | Staging and production environments, including per-environment signing keys and secrets | M | `wrangler deploy --env staging` serves `/` over HTTPS; no resource or secret shared between environments |
| P1.2 | Convert `schema.sql` to numbered D1 migrations (includes R6) | M | Migrations apply to an empty DB and to a seeded one; schema guard checks the migration level |
| P1.3 | GitHub Actions: `npm test`, worker tests, network build `--check`, upstream linking tests at the pinned commit | M | Required check on `main`; a failing test blocks merge |
| P1.4 | Deploys: Oja on Workers static assets, first staging deploy, production deploy | M | Tag `v0.1` deploys both; Oja's `config.js` points at the env's arbiter and pinned key set; Cloudflare actually sends the `_headers` policy |
| P1.5 | Structured JSON logs with request id and stable error codes; redaction test | M | Test fails if a token, key or budget appears in a log line |
| P1.6 | `GET /health`: db reachable, key loaded, version, migration level | S | Returns 200 on staging, 503 with code when misconfigured |
| P1.7 | Quota protection and rate limits for public endpoints | M | Burst test returns 429 before the Worker does real work |
| P1.8 | Rerun slice 0 spike and `concurrency.mjs` against staging D1 | S | Results recorded; any difference from local becomes a finding |
| P1.9 | Rollback drill: deploy a bad version, roll back | S | Time to roll back recorded in the runbook |
| P1.10 | Restore drill on staging D1, including checkpoint-rewind detection | S | Data restored to a timestamp; rewind detected; steps in the runbook |
| P1.11 | Runbook: deploy, rollback, restore, key rotation, incident checklist | M | Someone else could follow it |
| P1.12 | Audit verification without a public full scan: public signed checkpoint from one row, admin-only incremental verify, daily Cron job, checkpoint copy in Workers KV | M | Public endpoint costs O(1) reads; a tampered event is caught by the next scheduled run; a restore that rewinds the chain is detected |

**Verify (gate)**

- [ ] Staging and production live over HTTPS; production deploys only from CI
- [ ] Rollback and restore rehearsed and timed
- [ ] Hosted D1 concurrency results recorded
- [ ] No secret in the repo, CI logs or Worker logs (scan run)
- [ ] Tagged `v0.1`; **first submittable version exists**

## Phase 2: Mechanism v1 and state machine

**Goal:** a written, versioned mechanism spec with hard constraints (currency, quantity, delivery, return policy, expiry), JSON Schema contracts, and an explicit state machine where every illegal transition is tested. P5.1 (the second Oja agent) moved here on 27 Nov, after P2.5. **4 to 8 Dec, 15 h. Tier: critical.**

**Research**

- Myerson–Satterthwaite theorem: why no bargaining mechanism is efficient, truthful and budget-balanced at once. What does that mean for B2's honesty?
- Nash bargaining solution: why the midpoint, and what weights would change.
- Hard constraints versus scoring: why a pass/fail delivery check leaks less than a weighted score.
- Which checks may a decision record show without revealing a sealed limit? (Delivery fail: yes. Budget fail vs floor fail: no, they must look identical.)
- How do Cloudflare Cron Triggers work, for expiry?

**Plan (ADRs)**

- ADR: mechanism v1 (inputs, constraints, price rule, ranking, leakage bound, version string).
- ADR: server state machine (D11): `OPEN, RESOLVED, NO_AGREEMENT, APPROVED, COMMITTED, EXPIRED, FAILED, UNKNOWN`, actor per transition.
- ADR: contract versioning (schema `$id` per version, mechanism version in every record).

**Implement**

| ID | Task | Size | Done when |
| --- | --- | --- | --- |
| P2.1 | Mechanism spec `protocol/mechanism-v1.md` with 6 worked examples | M | Every example is also a unit test |
| P2.2 | JSON Schemas v1: mandate, listing or bid, offer, decision | L | Worker validates every input against them; invalid fixtures rejected with field paths |
| P2.3 | Hard constraints: currency, quantity, delivery, return policy | M | Property tests: an offer never violates a constraint |
| P2.4 | Decision record with per-check results; budget and floor failures indistinguishable | M | Test: two markets failing on budget vs floor return byte-identical public decisions |
| P2.5 | State machine module: transition table, actor, preconditions; all writers use it (includes R7) | L | Test enumerates every (state, action) pair; illegal ones refused with a code, nothing written |
| P5.1 | Second Oja agent (market specialist); front agent delegates item and seller questions (moved from Phase 5) | M | Network has 2 agents; build `--check` clean; one internal delegation per relevant query |
| P2.6 | Expiry: lazy on read plus a Cron Trigger sweep | M | Expired offer cannot be accepted; sweep is idempotent |
| P2.7 | Client handling of unknown outcomes after accept (includes R8, R9, R10) | M | Simulated timeout: client queries state, never resends the accept |
| P2.8 | Mechanism version in every decision and receipt | S | Old-version receipts still verify after a version bump |

**Verify (gate)**

- [ ] Spec, schemas and code agree (examples are tests)
- [ ] State machine fully enumerated in tests
- [ ] Leakage bound restated and re-tested with constraints added
- [ ] Deployed to staging; tagged `v0.2`

## Phase 3: Portable, offline-verifiable evidence

**Goal:** an agreement record that any party can verify with no network and no OpenArbiter server, using published key sets, standard canonicalization and conformance vectors. This is OpenArbiter's main contribution beyond upstream. **9 to 15 Dec, 21 h. Tier: critical.**

**Research**

- RFC 8785: I-JSON limits, number serialization, property sorting by UTF-16 code units. Where does our current `canonicalJson` differ?
- JWS (RFC 7515) with ES256 and detached payloads versus our raw ECDSA signature: interoperability gain versus complexity.
- RFC 7638 JWK thumbprints as key ids.
- Key rotation and revocation patterns: dated key sets, grace periods, what an offline verifier can and cannot know about revocation.
- What a buyer's browser key proves (same device) and does not prove (identity, understanding).

**Plan (ADRs)**

- ADR: agreement record v1 and signature format (D3).
- ADR: key discovery and rotation (D6, D7): `.well-known` key sets per party, `kid` thumbprints, validity windows.
- ADR: buyer device signatures, optional and labelled (D8, D12).

**Implement**

| ID | Task | Size | Done when |
| --- | --- | --- | --- |
| P3.1 | Strict RFC 8785 canonicalizer with the RFC's number samples as tests | M | All RFC sample vectors pass; non-I-JSON input rejected |
| P3.2 | Agreement record schema v1: parties, terms, mechanism, decision, hash, signatures | M | Schema published under `schemas/v1/`; examples validate |
| P3.3 | Agreement hash: SHA-256 over the canonical record without signatures | S | Hash stable across key reordering and whitespace |
| P3.4 | Arbiter key set at `/.well-known/open-arbiter/jwks.json` with thumbprint `kid` and validity dates | M | Verifier selects key by `kid` and date |
| P3.5 | Signatures: arbiter required; supplier slot (filled in P4); optional buyer device key | L | Record lists each signer and role; missing required signer fails verification |
| P3.6 | Offline verifier: zero-dependency JS library plus CLI | L | Verifies a record on a machine with networking off |
| P3.7 | Oja shows per-signer verification with the pinned key set | M | Tampered record shows which check failed |
| P3.8 | Key rotation drill on staging | M | Old receipts verify; new receipts use the new `kid`; expired key rejected for new dates |
| P3.9 | Buyer can download the agreement record | S | Downloaded file verifies with the CLI |
| P3.10 | Conformance vectors: valid, tampered, wrong key, expired key, reordered, Unicode | M | Published in `protocol/conformance/`; the CLI passes all |

**Verify (gate)**

- [ ] A record verifies offline with only the file and published keys
- [ ] Rotation rehearsed on staging
- [ ] Conformance vectors published and passing
- [ ] Tagged `v0.3`

## Phase 4: Supplier side

**Goal:** suppliers keep their own floors and keys. Each supplier runs a small adapter that commits sealed, signed bids per deal, and publishes an agentic storefront on its own origin. Two demo suppliers are live. **16 to 22 Dec, 21 h. Tier: critical.** Target: one supplier site (P4.5) calling Oja with a minimal P5.2 by ~20 Dec.

**Research**

- Read the reference seller adapter: `nsdeploy: nsdeploy/commerce/service.py` lines 244-260 and `arbiter.py` `provider_capability`, `submit_bid` (salted commitments).
- Capability tokens: scoping (one deal, one supplier, one round), single use, expiry.
- How a supplier proves that an origin and a key belong together without a central registry.
- The bridge write window (`skills/agentify-website/templates/bridge/write-window.js`) and what a supplier may share with which caller origins.

**Plan (ADRs)**

- ADR: floor custody (D1): adapter bids by default, standing listings as fallback.
- ADR: supplier identity binding: manifest `open_arbiter` block names the supplier's key URL on the same origin.
- ADR: supplier offering (D10): peer network for browsers, MCP for other agents.

**Implement**

| ID | Task | Size | Done when |
| --- | --- | --- | --- |
| P4.1 | Arbiter mints per-deal, per-supplier, single-use, expiring capabilities | M | Reused, expired or wrong-deal capability refused |
| P4.2 | Supplier adapter template (Worker): private floor policy, salted commitment, signed bid | L | Template deploys with one command; floor never leaves it |
| P4.3 | Arbiter accepts adapter bids, verifies supplier signature against its published key | L | Forged or unsigned bid refused; listings fallback still works |
| P4.4 | Supplier signs the settled agreement (fills the P3.5 slot) | M | Record verifies with two signatures offline |
| P4.5 | Supplier storefront 1 (Iya Basira) on its own origin: page, network, bridge reads | L | Builds with `build_network.mjs --check`; served on its own host |
| P4.6 | Supplier storefront 2 (Chika Provisions), same pattern | M | Same checks |
| P4.7 | Identity binding check in Oja: manifest origin, key URL and signature agree | M | A storefront pointing at a foreign key URL is flagged |
| P4.8 | Supplier MCP endpoint (read-only catalogue and signed quotes) | M | MCP client test lists and calls tools with CORS |
| P4.9 | Failure tests: supplier adapter offline, slow, or returning garbage | M | Buyer sees "no bid from X", never a crash or a hung chat |

**Verify (gate)**

- [ ] For adapter suppliers, the arbiter database holds no floor (checked by query)
- [ ] Two supplier storefronts live on separate host names over HTTPS
- [ ] Agreements carry arbiter and supplier signatures and verify offline
- [ ] Tagged `v0.4`

## Phase 5: Interoperability and spec §6 proofs

**Goal:** every spec §6 interoperability check passes between separately hosted sites over HTTPS, proven by automated tests built on upstream's linking harness. **23 to 28 Dec, 18 h. Tier: critical.** Holiday week: front-load P5.2 to P5.4.

**Research**

- Spec §6 line by line: which check maps to which `tests/linking` case (L1, L3, L7, L9, L10, C1, C3, C7)?
- How the harness serves custom sites (`LINKING_*` variables, `example_web.mjs`, `mock_router.mjs`).
- Default inference (D9): cost per conversation on `alibaba/qwen3.8-flash` via Otari, versus an in-browser model. Get real numbers.

**Plan (ADRs)**

- ADR: Oja network v2 (two agents; supplier networks as partners; what each request may contain).
- ADR: default inference path and its daily cost cap (D9).

**Implement**

| ID | Task | Size | Done when |
| --- | --- | --- | --- |
| P5.1 | Moved to Phase 2 | | |
| P5.2 | Oja calls supplier networks as partners: `tools` URLs, `allowed_peers`, `link_labels`, partner rules | M | `check_partner.mjs` passes for both suppliers |
| P5.3 | Supplier storefronts can call Oja (both directions) | M | Same check, reverse direction |
| P5.4 | Run upstream's linking harness on our three sites, on three host names | L | Node cases green; Chrome check exit code 0 |
| P5.5 | §6 proofs A: consent before contact, decline sends nothing, key never at peer, peer cannot change router, private context absent | L | One named test per check, linked in the evidence file |
| P5.6 | §6 proofs B: invalid network, composition cycle, over budget, denied origin all fail visibly | M | Each shows a visible error and makes no unintended request |
| P5.7 | Publisher-funded router proxy (D9) on a Worker, per upstream's "Paying for visitors' model calls": hard spending cap, per-visitor limit, network models only, proxy-set max_tokens, plain-text 429 | M | Works with no visitor key; cap reached returns a clear message |
| P5.8 | Run the §6 suite against the deployed HTTPS origins | M | Report from production URLs, not only localhost |

**Verify (gate)**

- [ ] All seven §6 checks pass on deployed origins, with recorded evidence
- [ ] No key, budget or private field in any partner request log
- [ ] Tagged `v0.5`

## Phase 6: Security and adversarial testing

**Goal:** attack the system the way a hostile buyer, supplier or peer site would, with a repeatable evaluation set, and close every high-severity finding. **29 Dec to 2 Jan, 15 h. Tier: critical.**

**Research**

- Prompt injection: direct, indirect (via tool results and peer instructions), and data exfiltration through tool arguments. Read the current OWASP guidance for LLM applications.
- STRIDE per trust boundary in the verified architecture diagram.
- What a CSP can and cannot stop for a BYOK key in origin storage (spec §4 threat boundary).
- Data protection basics for what you store (hashed IPs, mandates, receipts). Nigeria's data protection law applies to Lagos users; not legal advice, but know what you keep and why.

**Plan (ADRs)**

- ADR: data inventory and retention (what is stored, how long, how deleted).
- ADR: security policy and disclosure process (`SECURITY.md`).

**Implement**

| ID | Task | Size | Done when |
| --- | --- | --- | --- |
| P6.1 | Threat model `docs/security/threat-model.md`, STRIDE per boundary, linked to tests | M | Every high row names its test |
| P6.2 | Prompt-injection eval set: 20 cases (hostile listing titles, peer instructions, tool results) | L | Runs on 2 real models; pass = no acceptance without the dialog, no limit disclosed, no injected instruction followed |
| P6.3 | Hostile supplier test site: fishes for the budget, offers fake forms, calls back | M | Every attempt blocked or visible to the visitor; results recorded |
| P6.4 | Schema fuzzing of every API endpoint | M | 10,000 fuzzed requests: no 500, no partial write |
| P6.5 | Abuse tests: replayed accepts, token guessing, oversized bodies, burst traffic (includes R5). Evaluate Cloudflare Turnstile on the write endpoints (negotiate, accept) as the defence against distributed abuse (many addresses; the per-IP limits can't stop it), with a non-JavaScript fallback for agents that can't run the widget (owner, 2026-11-27) | M | Each refused with a stable code; rate limits hold; a Turnstile decision recorded (ADR), covering the agent fallback, its CSP origins and the Free-plan terms |
| P6.6 | Supply chain: `npm audit`, lockfile check, runtime folder hash pinned in CI | S | CI fails on a changed runtime file or a high advisory |
| P6.7 | Retention job: delete expired mandates and hashed IPs after the ADR's window | M | Test proves deletion and that receipts still verify |
| P6.8 | `SECURITY.md` with disclosure contact | S | Linked from README and site footer |
| P6.9 | Independent review with no prior context (agent or person) | M | Findings triaged; highs fixed and retested |

**Verify (gate)**

- [ ] No open high-severity finding
- [ ] Injection eval pass rate recorded per model, with failures analysed
- [ ] Tagged `v0.6`

## Phase 7: Product, accessibility and real-model quality

**Goal:** a complete product, not a proof of concept (a judging criterion): real buyer journeys succeed on real models, the interface is accessible and works on phones, and every error state is understandable. **3 to 6 Jan, 12 h. Tier: standard.**

**Research**

- WCAG 2.2 AA essentials for forms, dialogs and live regions; how the runtime's chat announces updates.
- How Lagos shoppers would phrase requests (naira amounts, "bag", "paint", Pidgin). Collect 20 real phrasings from people you know.
- Cost and latency per journey on the default model; where the budget goes.

**Plan (ADRs)**

- ADR: supported browsers and devices.
- ADR: model policy (tested models list in the manifest, warning for untested ones).

**Implement**

| ID | Task | Size | Done when |
| --- | --- | --- | --- |
| P7.1 | Journey eval: 10 buyer journeys × 2 models, scripted checks on outcomes | L | Success rate, cost and time per journey recorded; target ≥ 90% on the default model |
| P7.2 | Fix the top journey failures (instructions, tool descriptions, CRUSE forms) | M | Re-run shows improvement; no regression in P6.2 evals |
| P7.3 | Approval dialog shows terms, saving, signers and agreement hash | S | Visitor can see exactly what they sign |
| P7.4 | Accessibility audit: automated (axe) plus keyboard-only plus one screen reader pass | M | No serious or critical issue open |
| P7.5 | Mobile and cross-browser pass: Chrome, Firefox, Safari, Android Chrome (includes R11 and a style-src fallback for older browsers) | M | Browser check runs on each; screenshots saved |
| P7.6 | Error and empty states: arbiter down, supplier down, no key, cap reached | S | Each has plain-language copy and a next step |
| P7.7 | Performance: Lighthouse on Oja and storefronts | S | Scores recorded; obvious wins taken |

**Verify (gate)**

- [ ] Journey success ≥ 90% on the default model, with recorded runs
- [ ] No serious accessibility issue
- [ ] Production deployed; tagged `v0.7`

## Phase 8: Launch and Devpost submission

**Goal:** v1.0 in production, listed in the community directory, and a complete Devpost submission sent a day early. **7 to 10 Jan, 12 h. Tier: critical** (production release). Code freeze starts 7 Jan: only fixes from here.

**Research**

- Re-read the Devpost rules and submission form: video under 2 minutes, you on camera, not AI-generated, public on YouTube, no unlicensed music or trademarks; Otari email and feedback if used.
- Check upstream for changes since the pinned commit (D13). If the spec moved, rerun the linking suite before tagging.

**Plan**

- Release checklist for v1.0 (from your skill's `assets/templates/release.md`).
- Video script: problem (10 s), live demo of a buyer journey with the approval dialog (60 s), the infrastructure (another site using the arbiter, offline verification) (30 s), what's next (15 s).

**Implement**

| ID | Task | Size | Done when |
| --- | --- | --- | --- |
| P8.1 | Upstream drift check; rerun full suite | S | Report filed; suite green |
| P8.2 | v1.0 release: tag, production deploy through CI, smoke test, release notes | M | Production smoke passes; rollback ready |
| P8.3 | Developer quickstart: "use Open Arbiter from your agentic site in 15 minutes" | M | A fresh reader integrates a test site by following it |
| P8.4 | PR adding Oja and the supplier sites to `docs/agentic_websites.md`; NANDA Index registration | S | PR open; registration recorded |
| P8.5 | File the upstream issues found (duplicate agent names, peer fetch timeout, `tests/skills/agentify-website/runtime/panel.test.mjs` races its Chrome profile cleanup: "an unknown key saved in the panel never reaches the publisher-funded router" fails with `ENOTEMPTY … rmdir /tmp/panel-key-…/profile/Default` on an Ubuntu 24.04 GitHub runner at `90d561d`, https://github.com/maxchichar/open-arbiter/actions/runs/46067045280; passes locally) | S | Issues linked from the README |
| P8.6 | Screenshots: market, approval dialog, receipt verification, cross-site call | S | 4 to 6 images |
| P8.7 | Record the video (on camera, under 2 minutes), upload publicly | L | Plays logged out; under 2:00 |
| P8.8 | Devpost text: features, architecture, limits, extra tools shared, Otari feedback | M | Reviewed by someone else |
| P8.9 | Submit on 10 Jan; 11 Jan morning is buffer only | S | Confirmation email received |

**Verify (gate)**

- [ ] Production public URL works logged out on a phone
- [ ] Every submission field complete; video public and under 2 minutes
- [ ] Submitted before 10 Jan ends

## Submission requirements checklist

Every Devpost requirement mapped to the task that satisfies it. Checked 27 Nov.

| Requirement | Task | Status |
| --- | --- | --- |
| Public URL of the agentic site | P1.4 | Due ~3 Dec |
| Public conforming `.json` agent network | Exists; P5.1 makes it two agents | Moved P5.1 into Phase 2 |
| Browser `runtime` file | P1.0 | Done |
| Interface for users or agents | Oja page and chat | Done |
| Optional LLM and key settings | Runtime panel, Connect with Otari | Done |
| Network interacts with the site | Site actions | Done |
| Interacts with or is called by other agentic sites | Bridge (done); P4.5, P5.2 | One supplier site calling Oja by ~20 Dec |
| Text description | P8.8 | Later |
| Video under 2 min, you on camera, public on YouTube, no third-party trademarks or music | P8.7 | Later; keep demo brands fictional |
| Screenshots | P8.6 | Later |
| Otari account email and one problem with a suggested improvement | `docs/otari-feedback.md`, kept from 27 Nov | Started |
| Extra tools shared (Potential Impact) | Arbiter, client SDK, P3.6 verifier, P3.10 vectors, P4.2 adapter template, P8.5 upstream issues | Planned |

## Risks and cut lines

The plan uses all 147 hours with only per-phase slack, so expect to cut. Cut scope in this order; never cut a gate's security or testing items.

| Order | Cut | What you lose | What stays true |
| --- | --- | --- | --- |
| 1 | P7.7 performance, P4.8 supplier MCP, P3.9 download | Polish, a second agent interface | Core product and proofs intact |
| 2 | P5.7 default inference without a key | Keyless visitors; spec §6 asks for a default path, so document BYOK-only as a known gap | Everything works with a key |
| 3 | P4.6 second supplier storefront | Two-supplier comparison on separate sites | One supplier still proves cross-site and dual signatures |
| 4 | P3.5 buyer device signatures | Third signature | Arbiter + supplier signatures still verify offline |
| 5 | P2.6 cron sweep (keep lazy expiry) | Background cleanup | Expired offers still refused |

| Risk | Likelihood | Impact | Response |
| --- | --- | --- | --- |
| Holidays (24 Dec to 1 Jan) cost days | High | High | Front-load P5; Phase 1 gives a submittable version by 3 Dec |
| Hosted D1 behaves differently under concurrency | Medium | High | P1.8 measures it early; per-mandate chains as fallback |
| Upstream spec or runtime changes | Medium | Medium | Weekly drift check; pinned commit; linking suite in CI |
| Real models fail journeys or follow injections | Medium | High | Runtime-owned confirmation means a bad model can't buy; P6.2 and P7.1 measure it |
| Otari credits or model availability | Low | Medium | Second provider (OpenRouter) tested in P7.1 |
| Understanding lags code | Medium | High | The "explain without Claude Code" box on every task; Day 1 style self-checks each phase |
| Video takes longer than planned | Medium | Medium | Draft the script in Phase 5; rehearse once in Phase 7 |

**One rule above all:** at the end of every phase, production holds the last passing version. If 10 January arrives mid-phase, you submit the last tag.
