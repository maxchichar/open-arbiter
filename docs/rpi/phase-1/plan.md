# RPI / Plan: Phase 1 (deploy-ready arbiter and Oja, P1.0–P1.12)

**Tier:** critical · **Created:** 2026-11-24 · **State:** **approved by the owner 2026-11-24**, with the production-plan numbering below · **Branch:** `phase-1` (from `main` `f92f0aa`, `v0.0`)
**Research:** [`research.md`](research.md) (§1 upstream, §2 Cloudflare, §5 owner decisions) · **Upstream pin:** `d67755e` (spec unchanged since `c178171`)
**Task IDs:** `docs/production-plan.md` is the source of truth (the owner is adding it; it was not in the repo when this plan was written). The numbering below is the owner's, from the approval message of 2026-11-24.

## 0. Tasks

| ID | Task |
| --- | --- |
| P1.0 | Runtime upgrade to `d67755e` |
| P1.1 | Environments, including per-environment signing keys and secrets |
| P1.2 | Migrations (includes R6) |
| P1.3 | CI |
| P1.4 | Deploys: Oja on Workers static assets, first staging deploy, production deploy |
| P1.5 | Structured JSON logs with request id, stable error codes, and a redaction test |
| P1.6 | `GET /health`: db, key loaded, version, migration level; 503 with a code when misconfigured |
| P1.7 | Quota protection |
| P1.8 | Hosted-D1 checks |
| P1.9 | Rollback drill |
| P1.10 | Restore drill, including checkpoint-rewind detection |
| P1.11 | Runbook: deploy, rollback, restore, key rotation, incident checklist |
| P1.12 | Signed checkpoints |

## 0a. Plan change from the Devpost requirements review (owner, 2026-11-27)

`docs/production-plan.md` is still not in the repo, so this change is written down here. Mirror it there when that file is added.

1. **P5.1 moves into Phase 2, right after P2.5.** P5.1 adds a second Oja agent: the front agent delegates item and seller questions to it. The submission must be a conforming agent network, and spec §6 asks for a two-agent network, so this can't wait for Phase 5. Phase 2 order: … → P2.5 → **P5.1** → the rest of Phase 2.
2. **Target date ~2026-12-20, before the holidays:** one supplier site (P4.5) calling Oja, with a minimal P5.2. "Minimal" is the smallest P5.2 that lets that one site call Oja end to end. The rest of P5.2 stays in Phase 5.
3. **Otari feedback log:** [`docs/otari-feedback.md`](../../otari-feedback.md). Add an entry (date, what happened, what would help) whenever Otari causes friction, in any task.

What this means for Phase 1:
- Nothing in P1.0–P1.12 is removed. The 20 Dec target needs Phase 1 and Phase 2 through P5.1 done well before then, so Phase 1 should not grow beyond this plan. Any new Phase 1 scope goes to the owner first.
- §1 "Out of scope" still excludes the second agent and the second site from Phase 1. They are now scheduled (Phase 2 and the 20 Dec target) rather than open-ended.

## 1. Objective and boundaries

**Outcome:** the arbiter and Oja run on Cloudflare over HTTPS, in separate staging and production environments, each on its own origin. All Phase 0 guarantees and the 13 CLAUDE.md invariants hold on hosted infrastructure, verified by evidence. The service is observable (logs, health) without leaking sealed values or secrets. Deploy, rollback, restore and key rotation are written down and drilled. Public endpoints cannot exhaust the free-plan quotas cheaply. A rewound audit chain is detected.

**In scope:**
- `sites/oja/runtime/` (wholesale replacement only), `sites/oja/{_headers,site.js,js/*,tests/*}`, `sites/oja/wrangler.toml` (new)
- `arbiter/{wrangler.toml,src/*,migrations/*,scripts/*,test/*}`, `.github/workflows/*` (new)
- `docs/decisions/0004–0006`, `docs/runbooks/*` (new), README, CLAUDE.md

**Out of scope:**
- Publisher-funded inference (P5.7).
- A second site (P4.5, target ~2026-12-20), a second agent (P5.1, now in Phase 2 after P2.5; §0a), a real-model run and prompt-injection tests.
- Paid-plan features.
- Any production action without the owner's explicit approval at that step.

**Approvals this plan needs beyond the plan gate.** Each one is asked for at its step, never assumed:

| Step | Approval needed |
| --- | --- |
| A1 | Cloudflare account access: the owner runs `! npx wrangler login` or provides a scoped token. Creating staging D1, KV and Workers. |
| A2 | The first deploy of anything (P1.4a/b) |
| A3 | Production resources, the production deploy, and every production migration (P1.4c; owner decision 4) |
| A4 | GitHub secrets and deploying Actions (P1.3) |
| A5 | Time Travel restore drills, staging only (P1.10) |

**Assumptions:** Workers Free plan; `wrangler` ≥ 4.166.0; Node 24; no production data yet.

## 2. Design decisions (written into ADRs 0004–0006 inside the tasks that make them)

| # | Decision | Detail | ADR |
| --- | --- | --- | --- |
| E1 | Two named environments; the top level is local dev only | `[env.staging]`, `[env.production]`, each with its own `d1_databases`, `kv_namespaces`, `triggers` and secrets. Bindings and triggers do not inherit (research §2.1; cron docs). `npm run deploy:arbiter -- <env>` refuses to run without an environment. | 0004 (P1.4) |
| E2 | Separate origins | Arbiter: `open-arbiter-staging` and `open-arbiter-production`. Oja assets: `oja-staging` and `oja-production`. | 0004 |
| K1 | One signing key per environment | Never shared. Production pins only production keys. Rotation keeps the old public key pinned (invariant 12). | 0004 |
| M1 | Production migrations are manual | Run with the owner's approval from the runbook: Time Travel bookmark, then pre-checks, then `migrations apply --env production --remote`. CI never applies production migrations. | 0005 (P1.2) |
| M2 | Every migration is compatible with the previous Worker version | Expand, then contract. A rollback does not roll back D1 (research §2.3). Tested (AC-2.3). | 0005 |
| M3 | Mechanism changes never use split-traffic deployments | A `MECHANISM.version` change ships only with `wrangler deploy` (100%). CI guard (AC-3.5). | 0005 |
| C1 | Audit checkpoints are signed and anchored outside D1 | A D1 restore rewinds every D1 table, so the rewind-detection copy lives in Workers KV (P1.12). | 0006 (P1.12) |

## 3. Tasks and acceptance criteria

Each AC is a test or a recorded check, and it fails first where possible. Red and green outputs go in `docs/rpi/phase-1/evidence/`. "Staging" ACs run against the deployed staging environment, after A2.

### P1.0: runtime upgrade to `d67755e` (research §1.2, U1–U7)

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-0.1 | `sites/oja/runtime/` is byte-identical to `../agentic-web/skills/agentify-website/runtime` at `d67755e` | `diff -rq`, empty, saved |
| AC-0.2 | **Red first:** new tests or assertions for each fix, run against the new runtime with the old `_headers` and guard, fail for the stated reason: the style hash, `connect-src` missing the sign-in origin, `provider-guard` calling a sign-in endpoint a blocked provider, the mocked Otari sign-in blocked by CSP | Saved red outputs |
| AC-0.3 | The 4 page policies carry `'sha256-cInCcVTzIwlAW/42yPHZKk4sbZHVNv7RM9LUQR14NT8='` and not the old hash | `csp.test.mjs` |
| AC-0.4 | `connect-src` = `'self'` ∪ arbiter ∪ provider routers ∪ sign-in endpoints (`OtariConnect.TOKEN_URL`, `OpenRouterConnect.KEYS_URL` origins) ∪ manifest routers, exactly, derived from runtime constants | `csp.test.mjs` |
| AC-0.5 | `provider-guard` treats sign-in endpoints as allowed and never calls them a blocked provider. Blocked custom model URLs are still reported, with the provider list. | `provider-guard.test.mjs` |
| AC-0.6 | `site.js` `needsKey` matches the runtime (`publisherFundedLLM`) | Unit test |
| AC-0.7 | The network rebuilds with the new `build_network.mjs` | Saved output |
| AC-0.8 | `browser_check.py`: the existing steps, 0 CSP violations; the negative control fails | Saved |
| AC-0.9 | New browser step: Connect with Otari with otari.ai mocked by Playwright routes. Checks the authorize parameters (`client_id` = page origin, S256, `state`), the return with `code`/`state`/`iss`, the token `POST` answered, a key saved, the in-use line names Otari, 0 CSP violations. `form-action 'self'` is unchanged. | Saved |
| AC-0.10 | CLAUDE.md invariant 13 names sign-in endpoints; README mentions Connect with Otari | Review, copy test |
| AC-0.11 | `npm test` ×3, `npm run test:worker` ×1, `browser_check.py` ×3 | Saved |

### P1.1: environments, per-environment signing keys and secrets

**State (2026-11-27):** local part done ([`evidence/p1.1-summary.md`](evidence/p1.1-summary.md)). AC-1.3's Cloudflare check and AC-1.7 wait for A1 and P1.4b. Design as built: the top-level `wrangler.toml` is local only; `secrets.required` per environment; `preview_urls = false`; Oja environments come from `sites/oja/environments.json` through `npm run build:oja -- <env>` (output `dist/oja-<env>/`, which P1.4a deploys).

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-1.1 | `arbiter/wrangler.toml` has `[env.staging]` and `[env.production]`, each with its own `d1_databases` (different ids), `kv_namespaces` (P1.12) and `triggers`, and **no `DEV`** | Config test (parses the TOML), red first |
| AC-1.2 | `npm run deploy:arbiter` refuses to run without an environment | Script test |
| AC-1.3 | Secrets per environment: `ARBITER_SIGNING_JWK`, `ADMIN_TOKEN`, `BUYER_SALT`, set with `wrangler secret put X --env <env>`. No value is in the repo. | `git grep` check in CI; `wrangler secret list --env staging` (names only) after A1 |
| AC-1.4 | `keygen.mjs` writes a private JWK to stdout or to a path outside the repo only. `pubkey.mjs` prints the public JWK with `kid`. | Script test |
| AC-1.5 | Per-environment Oja config: staging pins only staging keys, production only production keys. Fail if a `kid` appears in both. The existing tripwire (URL, keys, manifest, `connect-src` agree) runs per environment. | Config test |
| AC-1.6 | `wrangler deploy --dry-run --env staging` and `--env production` succeed. Local dev and `test:worker` are unchanged. | Saved; `test:worker` |
| AC-1.7 | Key rotation on staging (after P1.4b): add key B, deploy, sign with B; a receipt from A still verifies in the page. Feeds the runbook (P1.11). | Saved |

### P1.2: migrations (includes R6), ADR 0005

**State (2026-11-27):** done locally ([`evidence/p1.2-summary.md`](evidence/p1.2-summary.md)). The hosted-D1 behaviour goes to P1.8; CI wiring (`fetch-depth: 0`, `test:m2`, `test:migrations-d1`) to P1.3.

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-2.1 | `arbiter/migrations/0000_baseline.sql` gives exactly today's schema (same `sqlite_master` name, type and sql as `schema.sql`). `schema.sql` is generated from, or replaced by, the migrations. | node:sqlite plus `migrations apply --local` |
| AC-2.2 | `ensureSchema` accepts a migrated database and refuses one without the required constraints | `schema-guard.test.mjs` |
| AC-2.3 | **M2:** the previous release's arbiter tests (tag `v0.0`, then each later tag) pass against a database migrated to HEAD. A deliberate negative fixture (drop a column the previous release reads) makes the check fail. | Script, in CI |
| AC-2.4 | **R6 check:** `scripts/premigrate-check.mjs` reports SETTLED mandates with no receipt, ACCEPTED offers with no receipt, and receipts whose `audit_hash` has no event. It exits non-zero on any of them. | Red on seeded bad rows, green on a clean database |
| AC-2.5 | **R6 fix:** `settledByUs` requires that this batch settled the mandate (a per-attempt marker), so a legacy SETTLED-without-receipt row cannot be settled | `accept.test.mjs` red, then green; the fault-injection tests stay green |
| AC-2.6 | A table-rebuild fixture under `PRAGMA defer_foreign_keys = true` keeps child row counts and passes `PRAGMA foreign_key_check` | node:sqlite plus local D1 |
| AC-2.7 | ADR 0005 written: M1, M2, M3, "rollback does not touch D1", the Time Travel window (7 days Free) and the cost of a restore | Review |

### P1.3: CI

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-3.1 | Every push and PR: `npm test`, `npm run test:worker` and the copy, CSP and config tests. No Cloudflare credentials needed. | Workflow run |
| AC-3.2 | On `main`: deploy **staging** only (arbiter + Oja), with `cloudflare/wrangler-action` and a token scoped to one account, with an expiry, as GitHub secrets (A4) | Workflow run |
| AC-3.3 | **Least privilege, measured:** start from Workers Scripts Edit + D1 Edit + Workers KV Storage Edit (+ Account Settings Read); remove one permission at a time while running deploy and `migrations list`; record the minimal set | Evidence table |
| AC-3.4 | CI never deploys production, never runs production `migrations apply --remote`, and has no production token | Workflow review plus a test that greps the workflows |
| AC-3.5 | **M3 guard:** a `MECHANISM.version` change ships only with `wrangler deploy` (100%), never `versions deploy` at a percentage | Workflow test with a fixture |
| AC-3.6 | M2 check (AC-2.3) and the secret-scan (AC-1.3) run in CI | Workflow run |

### P1.4: deploys, ADR 0004

**P1.4a: Oja on Workers static assets** (owner decision 1)

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-4.1 | `sites/oja/wrangler.toml`: an assets-only Worker (no `main`), default `html_handling`, and `.assetsignore` for `tests/`, `wrangler.toml` and build-only files. `_headers` is not served ("will not itself be served", static-assets headers doc, 2026-11-12). | Config test; `--dry-run` |
| AC-4.2 | **Deployed test (A2):** `scripts/check-headers.mjs <url>` requests `/`, `/index.html`, `/vendor`, `/vendor.html`, `/agent-manifest.json`, `/bridge/action-bridge.html` and `/runtime/sandbox-worker.js`, and compares every `_headers` rule with what is served, on 200s and on the documented 307s. The docs do not settle `/`, extensionless paths or 307s, so this test does. | Saved output |
| AC-4.3 | `browser_check.py` against deployed staging Oja (real headers, no injection): 0 violations | Saved |
| AC-4.4 | If any page response lacks its CSP, Oja moves to Pages and AC-4.2/4.3 are rerun there. ADR 0004 records the outcome. | ADR 0004 |

**P1.4b: first staging deploy** (A1, A2)

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-4.5 | Staging D1 and KV are created; migrations are applied; the arbiter is deployed with `--env staging`; secrets are set | `wrangler deployments list`, `migrations list --remote` saved |
| AC-4.6 | `/health` (P1.6) is 200 over HTTPS. It reports the `kid` pinned in staging Oja and the latest migration. | Saved |
| AC-4.7 | Seed (staging only) and `e2e.mjs` against staging pass | Saved |

**P1.4c: production deploy** (A3, last task of the phase)

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-4.8 | Production resources created per the runbook (P1.11). Migrations applied manually after a bookmark. | Saved commands and outputs, no secret values |
| AC-4.9 | Production `DEFAULT_ARBITER_URL`, `ARBITER_KEYS`, manifest and `connect-src` agree; the tripwires are green | `npm test` |
| AC-4.10 | Smoke test: `/health` 200; catalogue; one negotiation and accept with a test vendor; receipt verified against the **pinned** key (no "dev key" badge); a checkpoint published | Saved |
| AC-4.11 | The CLAUDE.md release checklist item "Published over HTTPS" is ticked, with links | Review |

### P1.5: structured JSON logs, request id, stable error codes, redaction

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-5.1 | Every request writes **one JSON log line**: `{ts, level, request_id, env, version, method, route, status, code, duration_ms}`. `route` is the route template (e.g. `/v1/mandates/:id/resolve`), never the raw path or query. No request or response bodies, no headers. | Unit test capturing `console` |
| AC-5.2 | `request_id`: taken from `cf-ray` when present, otherwise generated (random 16 bytes, hex). Returned as `x-request-id` on every response and as `request_id` in every error body. | Test |
| AC-5.3 | **Stable error codes:** one registry (`arbiter/src/errors.js`) lists every code with its HTTP status and meaning. A test fails when code throws a code that is not in the registry, or one code maps to two statuses. README or the API doc lists the codes. | Test (scans `ArbiterError(` call sites and runs the error paths) |
| AC-5.4 | Unexpected errors: the response is `{error: "internal", request_id}`; the log carries `error_class` and a short `error_fingerprint` (a hash of the stack frames' function names), **not** `e.message`, which may hold SQL or values | Test |
| AC-5.5 | **Redaction test:** drive every endpoint, the MCP tools and the cron handler with sentinel values (a floor, a max, a buyer secret and its token, the admin token, a vendor API key, a signing JWK `d`, a buyer IP), including failure paths. **No log line contains any sentinel** (raw, or in kobo, naira and hex variants). | Test, red first (today `console.error` paths print messages) |
| AC-5.6 | Logs are on for both environments (Workers Logs / observability settings, checked in the current docs at implementation), and the runbook says how to read them (`wrangler tail --env X --format json`) | Config test; runbook |

### P1.6: `GET /health`

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-6.1 | Healthy: 200 `{ok: true, version: {worker, mechanism, git}, db: "ok", key: {loaded: true, kid, source: "secret"}, migrations: {latest, applied}, schema: "ok"}`. `worker` comes from the version-metadata binding, if the current docs confirm it on Free; otherwise a build-time constant. | Unit plus Worker test |
| AC-6.2 | Misconfigured → **503** with a stable code (registry, P1.5): `key_missing` (no `ARBITER_SIGNING_JWK` and `DEV` ≠ "1"), `key_dev_in_deployed_env` (a generated dev key in staging or production), `schema_outdated` (`ensureSchema` fails), `migrations_pending` (the latest file migration is not applied), `db_unavailable` (`SELECT 1` fails) | One test per code, red first |
| AC-6.3 | Cheap and safe: at most 3 queries, no chain or event reads, no secret material (only `kid`), not cached by the client (`cache-control: no-store`), and subject to the P1.7 rate limit | Row and statement counting shim; redaction test covers it |
| AC-6.4 | Oja's vendor page and the runbook use `/health` for the first check after a deploy | Review |

### P1.7: quota protection

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-7.1 | An inventory of every unauthenticated endpoint, with its worst-case rows read, queries and CPU | Evidence table (estimates now, measured in P1.8) |
| AC-7.2 | No public endpoint reads more than O(page size) rows per call. Full chain verification is admin-only (P1.12), and `/v1/catalog` is bounded. | Test on 10,000 events or listings with a row-counting shim |
| AC-7.3 | A per-IP rate limit on public endpoints. The mechanism (Workers rate-limiting binding or another) is chosen after checking what the Free plan offers in the current docs. Over the limit: 429 `rate_limited_ip`. | Test plus docs citation |
| AC-7.4 | README "Limits" states the free-plan quotas and what happens when they run out (D1 errors until 00:00 UTC; Workers 1027) | Copy test |

### P1.8: hosted-D1 checks (staging)

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-8.1 | `concurrency.mjs` against staging, 3 runs: cap ≤ 3, identical terms one 201, linear chain, accept once, idempotent create (Phase 0 risks R2/R3) | Saved |
| AC-8.2 | Oversell on hosted D1 gives 409 `out_of_stock` and nothing written | Saved |
| AC-8.3 | Measured: CPU per endpoint; rows read and written per negotiation and accept; queries per accept under contention (≤ 50 Free); cron CPU (P1.12) | Evidence table; any value above 50% of a limit is a finding for the owner |
| AC-8.4 | The admin incremental verification is ok after all runs | Saved |

### P1.9: rollback drill (staging)

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-9.1 | Deploy N+1 (a harmless visible change in `/health` version), roll back to N with `wrangler rollback`, then `/health` shows N and `e2e.mjs` passes | Saved |
| AC-9.2 | Recorded: whether secrets and KV bindings changed across the rollback (open in the docs), and the D1 migration level before and after (unchanged, as expected) | Saved |
| AC-9.3 | With a migration applied between N and N+1, N still passes its tests against the migrated database (M2 in practice) | Saved |

### P1.10: restore drill, including checkpoint-rewind detection (staging, A5)

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-10.1 | Bookmark B0 → checkpoint K (cron or admin trigger) → more negotiations and accepts → checkpoint K+1 → `time-travel restore` to between K and K+1 | Saved commands |
| AC-10.2 | After the restore, the next cron run and the admin verify report **`rewound`** (KV anchor K+1 is ahead of D1). No new checkpoint is written. `/v1/audit/checkpoint` shows `status: "rewound"`. `/health` reports it. | Saved |
| AC-10.3 | The receipts issued after the restore point are listed (from the anchor and logs) per the runbook | Saved |
| AC-10.4 | Undo with the returned bookmark → D1 matches anchor K+1 → the admin acknowledges → status ok | Saved |

### P1.11: runbook

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-11.1 | `docs/runbooks/` has **deploy.md** (staging, production, migrations M1, the `/health` check), **rollback.md** (what it does not undo), **restore.md** (bookmark, restore, undo, rewind handling, receipts after the restore point), **key-rotation.md** (generate, pin public key in Oja and manifest, deploy Oja first, set secret, deploy arbiter, verify old and new receipts, retire) and **incident.md** (detect → contain → communicate → record → review) | Review |
| AC-11.2 | Every step is a command with its expected output, or a check with a pass condition. No secret values appear. Each step names who may run it (owner only for production). | Review; the secret-scan test covers `docs/runbooks/` |
| AC-11.3 | The incident checklist covers: a leaked signing key (rotate, mark the old `kid` revoked in Oja, re-verify receipts), a leaked admin token, a chain broken or rewound, quota exhaustion (1027, D1 limits), a bad deploy (rollback), a bad migration (restore, then the M2 limits) | Review |
| AC-11.4 | Deploy, rollback, restore and rotation were each **executed on staging by following the runbook as written** (P1.4b, P1.9, P1.10, AC-1.7). Deviations were fixed in the runbook. | Evidence links |
| AC-11.5 | A fresh subagent with only the runbook and the repo reviews it for missing steps or ambiguous commands. Findings are triaged. | Evidence |

### P1.12: signed checkpoints, ADR 0006 (owner decision 3)

**Anchor store: Workers KV.** Verified in the current docs, 2026-11-24:

| Workers KV (Free) | Value | Source |
| --- | --- | --- |
| Reads | 100,000 per day | https://developers.cloudflare.com/kv/platform/limits/ (2026-10-30); https://developers.cloudflare.com/kv/platform/pricing/ (2026-11-24) |
| Writes (different keys) | 1,000 per day; writes to the same key 1 per second | same |
| Deletes, lists | 1,000 per day each | pricing |
| Storage | 1 GB per account, 1 GB per namespace | limits |
| Value size, key size | 25 MiB, 512 bytes | limits |
| Namespaces | 1,000 | limits |
| Over a limit | "further operations of that type will fail with an error"; reset 00:00 UTC | pricing |
| Consistency | "Changes may take up to 60 seconds or more to be visible in other global network locations". Same-location read-after-write is "usually immediately visible. However, this is not guaranteed" | https://developers.cloudflare.com/kv/concepts/how-kv-works/ (2026-04-21) |

R2 alternative (https://developers.cloudflare.com/r2/pricing/, 2026-10-30): 10 GB-month, 1M Class A and 10M Class B operations per month, free egress. It needs "an R2 subscription" through a checkout (https://developers.cloudflare.com/r2/get-started/, 2026-11-12); whether a card is required is not stated. R2 consistency is not stated on the pages read.

**Why KV:**
- The load is 2 writes per checkpoint (`checkpoint:latest` and `checkpoint:<last_seq>`) per day per environment, about 0.2% of the write limit, plus about 1 read per cron run and admin verify.
- No subscription is needed.
- Eventual consistency is acceptable here. A stale anchor read can only look **older** than the real anchor. An older anchor is still consistent with an un-rewound D1, so a stale read never raises a false alarm. A rewind done within about 60 s of a checkpoint might be missed until the next run, which the ADR states.
- The anchor is never read by public endpoints.
- None of the pages read says whether a D1 restore touches KV. They are separate products. AC-10.2 confirms it on staging.

**Design:**
- **Payload:** `{"type": "open-arbiter/checkpoint", "v": 1, "env", "head_hash", "event_count", "last_seq", "at", "prev_checkpoint_hash"}`, canonical JSON, signed with the environment's receipt key. `type` separates it from receipts.
- **Storage and reads:**
  - A `checkpoints` table, added by an additive migration (M2), append-only, `UNIQUE(prev_checkpoint_hash)`.
  - Public `GET /v1/audit/checkpoint` reads one row.
  - `GET /v1/audit/verify` is admin-only and incremental from the last checkpoint, bounded by `?limit=` and returning a cursor. `?full=1` pages from genesis, admin only.
- **Cron** (`[env.X.triggers] crons = ["0 2 * * *"]`, UTC; 2 of the account's 5 Free triggers):
  1. Rewind check against the KV anchor.
  2. Incremental verification with a stored cursor, so a run that reaches its CPU budget continues next time.
  3. On reaching the head, write the checkpoint row (in `commit()`, guarded on the head being unchanged), then the KV anchor.
- **Rewound:** D1 has no event at the anchor's `last_seq`, or that event's hash ≠ the anchor's `head_hash`, or D1's latest checkpoint is older than the anchor's. Then:
  - nothing is written;
  - an `AUDIT_REWOUND` log line (P1.5) is written;
  - `/v1/audit/checkpoint` and `/health` say `rewound` until an authenticated admin acknowledgement records an incident event in the chain.

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-12.1 | Unauthenticated `GET /v1/audit/verify` → 401 with nothing read beyond the auth check. Admin → incremental result plus cursor. | Test, red first (public today) |
| AC-12.2 | `GET /v1/audit/checkpoint` reads exactly one row and returns `{payload, signature, key_id}`. `ArbiterClient.verifyCheckpoint` verifies it against the pinned key. | Unit and page tests |
| AC-12.3 | A checkpoint signature never verifies as a receipt, and the reverse | Test |
| AC-12.4 | `scheduled()` on a valid chain writes one checkpoint row and the anchor; on a tampered event it writes neither and logs `broken_at` | Unit test with a fake KV; `curl /cdn-cgi/local/scheduled` on `wrangler dev` (cron docs, 2026-11-18) |
| AC-12.5 | Local rewind simulation (anchor K+1, D1 reverted to K's state) → `rewound`, nothing written, public status `rewound` | Test, red then green |
| AC-12.6 | Incremental verification is bounded: 10,000 events, no checkpoint → one admin call reads ≤ `limit` rows and returns a cursor; repeated calls reach the head; the cron continues across runs | Row-counting shim |
| AC-12.7 | Concurrent writes during checkpointing never produce a checkpoint whose `head_hash` is not the event at `last_seq` | `concurrency.mjs` extension, local and staging |
| AC-12.8 | `e2e.mjs` and `concurrency.mjs` use the admin verify | `test:worker` |
| AC-12.9 | Oja's Trust section shows the latest checkpoint (count, time, verified against the pinned key). Copy says what it proves and what it does not. | Page and copy tests |
| AC-12.10 | Cron CPU measured on staging (P1.8). If one day does not fit in 10 ms, the cursor carries over, and the owner gets the numbers. | Evidence |
| AC-12.11 | ADR 0006 written. ADR 0003 updated (no public full verification). | Review |

## 4. Order of work

`P1.0 → P1.1 → P1.2 → P1.5 → P1.6 → P1.12 → P1.7 → P1.3 → P1.4a+b → P1.8 → P1.9 → P1.10 → P1.11 → P1.4c`

- Logs, health, checkpoints and quota protection come before any public deploy. The public verify endpoint can exhaust the D1 daily reads (research L1).
- The deploy tasks need A1/A2.
- The production deploy is last, after the drills and the runbook.
- Each slice: red → fix → green → evidence → commit. A stop and report comes after P1.0 and before each approval A1–A5.

## 5. Risks

| Risk | Control |
| --- | --- |
| Workers static assets miss `_headers` on some responses | AC-4.2 deployed test; Pages fallback (AC-4.4) |
| 10 ms Free CPU too small (signing, hashing, cron) | Measured in AC-8.3 and AC-12.10; cursor cron; numbers to the owner |
| A migration breaks the previous Worker | M2 plus AC-2.3 negative fixture |
| A restore silently rewinds receipts | P1.12 KV anchor; drill P1.10; restore runbook |
| Logs leak sealed values or secrets | AC-5.5 redaction test across all endpoints and error paths |
| CI token too broad or leaked | AC-3.3 minimal scope, expiry, staging-only token |
| Staging and production keys mixed up | K1, AC-1.5 |
| Hosted D1 differs from local | P1.8 before production |
| Upstream moves again | Recheck at P1.4c; a P1.0-style slice if it has |

## 6. Traceability

| Requirement | Tasks | Evidence |
| --- | --- | --- |
| Owner decision 1 (Workers static assets if `_headers` applies; own origin) | P1.4a | AC-4.2–4.4, ADR 0004 |
| Owner decision 3 (checkpoints, admin incremental verification, cron, rewind detection) | P1.12, P1.10 | AC-12.x, AC-10.x, ADR 0006 |
| Owner decision 4 (manual production migrations, M2, no split deploys for mechanism changes) | P1.2, P1.3 | AC-2.3, AC-2.7, AC-3.4, AC-3.5, ADR 0005 |
| Owner decision 5 (pin `d67755e`) | P1.0 | AC-0.1 |
| R6 | P1.2 | AC-2.4, AC-2.5 |
| Observability without leaks | P1.5, P1.6 | AC-5.x, AC-6.x |
| Release checklist: published over HTTPS | P1.4 | AC-4.5–4.11 |
| Research L1–L4 | P1.7, P1.8, P1.12 | AC-7.x, AC-8.3, AC-12.6 |
| Invariants 1–13 | all | `npm test`, `test:worker`, `browser_check.py` every slice; against staging from P1.4b |

## 7. Gate

**Plan gate: approved by the owner on 2026-11-24.** Work starts with P1.0 as its own slice, then stops with evidence.
