# RPI / Research: Phase 1 (P1.0 upstream upgrade, deployment questions)

**Tier:** critical · **Date:** 2026-11-24 · **Branch:** `phase-1` (from `main` at `f92f0aa`, tag `v0.0`) · **State:** research only. No code was changed. Phase 1 planning waits for the owner.

**Upstream:** `cognizant-ai-labs/agentic-web`, pinned at `c178171`. Upstream `main` is now `d67755e762545de983e38a395ec45d89b77c9311` (2026-11-23 16:52 −0800), a fast-forward from `c178171`, 18 commits.

## 0. Problem, scope, method

- **P1.0:** move Oja's copy of the runtime from `c178171` to `d67755e` without breaking the strict page CSP, the pinned style hash, our tests or our invariants. Then decide whether to use any of the new features.
- **Phase 1 questions:** what we must know before deploying the arbiter and the site on Cloudflare:
  - environments
  - migrations on a database with data
  - versions and rollback
  - point-in-time restore
  - free-plan limits
  - the CI token
- **Out of scope:** code, deployment, and any change to the local `../agentic-web` checkout (I ran `git fetch` only; its working tree is still at `c178171`).

**How the evidence was gathered:**

| Source | How |
| --- | --- |
| Upstream | Read locally: `git fetch` in `../agentic-web`, then `git log`/`git diff c178171 d67755e`, `git show d67755e:…`. The runtime was extracted with `git archive` into the session scratchpad and diffed against our copy. |
| Style hash | Computed by the same method as `sites/oja/tests/csp.test.mjs`, using a scratch script on both runtimes. |
| Cloudflare docs | Fetched on 2026-11-24 by three fetch-only subagents. Each fact below carries its URL and the page's `dateModified`. Where a page did not answer a question, this file says so. Nothing here was checked against a live Cloudflare account. |
| Our repo | `arbiter/schema.sql`, `arbiter/src/{core,index}.js`, `arbiter/wrangler.toml`, `sites/oja/{_headers,site.js,js/provider-guard.js,tests/*}` |

## 1. P1.0: upstream `c178171` → `d67755e`

### 1.1 What changed upstream

| Area | Change | Evidence |
| --- | --- | --- |
| Spec | **Unchanged.** `docs/worldwide_agentic_web_mvp_spec.md` has an empty diff. `docs/agentic_websites.md` (the directory of sites) gained 3 rows. | `git diff --quiet c178171 d67755e -- docs/worldwide_agentic_web_mvp_spec.md` |
| `runtime/otari-connect.js` (new, 432 lines) | **Connect with Otari**: an OAuth + PKCE sign-in in which the site's origin is the client ID. The browser navigates to `https://otari.ai/api/v1/oauth/apps/authorize` with `location.assign`. When the visitor returns, the page `fetch`es a `POST` to `https://otari.ai/api/v1/oauth/apps/token` and saves the key like a pasted key. Available only in a secure context, in a top-level tab (`top === self`). The pending verifier is kept in `sessionStorage`. | `git show d67755e:skills/agentify-website/runtime/otari-connect.js` lines 35–45, 113–115, 174–187, 327 |
| `runtime/index.js` | `boot()` finishes an Otari sign-in after OpenRouter's. | diff |
| `runtime/ui.js` | Adds a Connect with Otari button and a "Manage this key on Otari" link. **`BASE_CSS` gained three `.ns-otari-key` rules.** The Otari provider entries now come from `OtariConnect` constants (same values). Adds publisher-funded handling in the panel. | diff |
| `runtime/engine.js`, `llm.js`, `in-use-line.js` | **Publisher-funded router** (`llm_router.publisher_funded: true`): the runtime calls `base_url` with no key. A visitor's key goes only to `byok_router`, never to `base_url` (chat, model check or panel). Partner networks also run on `base_url`, so the site pays for them too. A plain-text refusal from that router is shown to the visitor as written. | diff; `runtime/README.md` "Publisher-funded router" |
| `scripts/build_network.mjs` | Loads `engine.js`. Refuses `publisher_funded: true` when `byok_router` equals `base_url`. | diff |
| `references/bundle_and_hosting.md` | New section "Paying for visitors' model calls": the proxy contract (no `Authorization` from the browser; CORS on errors too) and the limits the proxy must enforce (spend cap, per-visitor limit, model allow-list, `max_tokens`, request size, 429 `text/plain`). The manifest row documents `publisher_funded`. | diff |

### 1.2 What breaks for us, and what does not

| # | Impact | Severity | Evidence | Fix in the upgrade |
| --- | --- | --- | --- | --- |
| U1 | **The pinned style hash changes.** `'sha256-pmEykRvndzAgYQ9mpF6i+LOu0sxdv0dzT9kgfR42Ph4='` becomes **`'sha256-cInCcVTzIwlAW/42yPHZKk4sbZHVNv7RM9LUQR14NT8='`**. Without the update, every page's runtime `<style>` is blocked and the assistant renders unstyled. `csp.test.mjs` fails until `_headers` changes, as designed. | breaks | Both hashes computed by the `csp.test.mjs` method on our runtime and on `d67755e` | Replace the hash in the 4 page policies. Rerun `browser_check.py`, and the negative control. |
| U2 | **Connect with Otari is blocked by `connect-src`.** The token exchange `fetch`es `https://otari.ai`, which is not in our policy (we allow `api.otari.ai` and `eu.api.otari.ai`). The visitor approves on otari.ai, comes back, and the exchange fails with a `connect-src` violation: "could not reach otari.ai". | breaks a new feature | `otari-connect.js` L45 `TOKEN_URL`, L327 `fetch(OtariConnect.TOKEN_URL, …)`; `_headers` connect-src | Add `https://otari.ai` to the 4 page policies' `connect-src`. Derive the allowed set in `csp.test.mjs` from the runtime's sign-in constants (`OtariConnect.TOKEN_URL`, `OpenRouterConnect.KEYS_URL`) as well as `API_KEY_PROVIDERS`. Today `https://otari.ai` would fail the exact-set test. |
| U3 | **`js/provider-guard.js` would misreport a blocked sign-in** as a blocked AI provider ("blocks https://otari.ai … use one of these providers"). It also defines the allowed origins as the provider routers only, and `provider-guard.test.mjs` checks that set against the policy's `connect-src` with `deepEqual`, so adding `https://otari.ai` (U2) fails that test. | breaks tests; misleading copy | `provider-guard.js` `ALLOWED_PROVIDER_ORIGINS`, `isBlockedProviderCall`; test 1 | Split the guard's sets into "model routers" and "sign-in endpoints". The guard warns only about model-router URLs, and the test checks routers ∪ sign-in ∪ self ∪ arbiter = `connect-src`. |
| U4 | **`form-action`: no change needed.** Neither sign-in submits a form. Both leave the page with `location.assign` (a top-level navigation, which CSP does not govern in current browsers) and come back by redirect to the same origin and path. `form-action 'self'` stays. | none (to confirm in a browser) | `otari-connect.js` L187; `openrouter-connect.js` L172; no `<form action>` or `.submit()` in either | Confirm with a browser check that mocks otari.ai (route the authorize URL back to the page with `code`/`state`/`iss`, and answer the token `POST`). Upstream ships `tests/…/mock_otari.mjs`, which can serve as the model. |
| U5 | **`site.js` mirrors a runtime test** (`needsKey = !mockLLM && (!byokKey ‖ "demo")`). With a publisher-funded router, the runtime adds `!publisherFundedLLM`, so our status line would wrongly say "needs your AI provider key". | latent (only if we turn on `publisher_funded`) | `site.js` L59–61 vs `ui.js` `needsByok` | Add `&& !booted.engine.publisherFundedLLM`. |
| U6 | **`browser_check.py` and the screenshots:** the panel gains a Connect with Otari button on `127.0.0.1` (a secure context), and the "Otari" provider link is hidden there. No current assertion depends on them, but screenshots 1 and 8 will look different. | cosmetic | `ui.js` `canConnectOtari` | Rerun; update screenshots for the submission. |
| U7 | **The local upstream clone must move** for `diff -rq` (the runtime-copy check) and for `build_network.mjs` (it now loads `engine.js` from the site's runtime). The CLAUDE.md pin and plan text say `c178171`. | process | CLAUDE.md "Target spec" | The owner approves a `git checkout d67755e` in `../agentic-web` (a clone outside this repo), or I run `build_network.mjs` from a scratch export. Update the CLAUDE.md pin. |
| — | **Not affected:** `actions.js`, `action-bridge.js`, `sandbox*.js`, `byok.js`, `cruse*.js`, `kernel.js`, `hocon.js` (no diff). Our manifest (`base_url` = `byok_router`, no `publisher_funded`) passes the new build check. That check fires only with `publisher_funded: true`; to be confirmed by running it. Invariants 5 and 7 are unaffected. `isPublisherFundedRouter` is not reached with our manifest. | — | `git diff --stat` | — |

**Security notes on the new features:**
- **Connect with Otari** saves the key in the browser like a pasted key. Upstream says so ("any script on the site can read it"). Our `script-src 'self'` and our no-inline-script rule make that safer than on most sites.
- **The consent screen** names the site by its host. On `*.pages.dev`/`*.workers.dev` that is a shared parent domain, but the host is still unique to the project.
- **Invariant 4 is unaffected:** buyer tokens stay inside `ArbiterClient`, and the Otari key lives in the runtime's BYOK store, not in our page state.

### 1.3 New option: publisher-funded inference (decision for the owner, not planned yet)

A publisher-funded router would let a visitor (or a Devpost judge) use Oja's assistant with no key, which helps the "Tested with a real model" item and the video. The costs:
- a second service (a proxy Worker holding Oja's provider key);
- money;
- abuse handling. The proxy URL is public; the upstream doc lists hard spend cap, per-IP limit, model allow-list, proxy-set `max_tokens`, request-size limit, and a 429 `text/plain` reply.
- the CSP `connect-src` gains the proxy origin;
- partner networks Oja calls would run on Oja's budget.

The BYOK invariants still hold: a visitor key never goes to `base_url` (runtime-enforced, and build-checked when `byok_router` ≠ `base_url`). **Recommendation: decide after the first deploy.** Free-plan Workers limits (§2.5) would apply to the proxy too.

### 1.4 Upgrade plan (P1.0, for the Phase 1 plan; not started)

1. Take the runtime wholesale from `d67755e` (invariant 6: no edits). `diff -rq` against the upstream copy must be empty. Record `slice-runtime-diff.txt`.
2. **Red:** run `npm test` before any other change. Expect `csp.test.mjs` to fail on the hash (U1).
3. Update the hash (U1). Add `https://otari.ai` to page `connect-src` (U2). Update `csp.test.mjs` and `provider-guard.{js,test.mjs}` to tell model routers from sign-in endpoints (U3). Update `site.js` `needsKey` (U5).
4. Rebuild the network with the new `build_network.mjs` and record the output.
5. `browser_check.py`:
   - the existing flow with 0 violations;
   - the negative control (hash dropped, must fail);
   - **a new step: Connect with Otari with otari.ai mocked by Playwright routes.** Assert no CSP violation and a saved key (U2, U4).
6. Update CLAUDE.md (pin `d67755e`, invariant 13 wording "runtime's LLM providers and sign-in endpoints") and README (Connect with Otari; the CSP limit line).
7. Run `npm test` ×3, `test:worker` ×3 and `browser_check.py` ×3.

**Tier:** critical (CSP). **Blast radius:** the page and its tests; the arbiter is untouched. **Rollback:** revert the commit; the old runtime and hash come back together.

## 2. Phase 1 research questions (Cloudflare, docs fetched 2026-11-24)

### 2.1 Wrangler environments

| Fact | Source |
| --- | --- |
| Environments are `[env.<name>]` sections (or an `env` object in JSON/JSONC). Select one with `--env`/`-e` or `CLOUDFLARE_ENV`; `--env` wins. | https://developers.cloudflare.com/workers/wrangler/environments/ (2026-10-18) |
| Most keys inherit from the top level (`name`, `main`, `compatibility_date`, routes, `workers_dev`, triggers, limits, observability). **Bindings and vars do not:** "Bindings, such as `vars` or `kv_namespaces`, are not inheritable and need to be defined explicitly." Secrets are not inherited either. | https://developers.cloudflare.com/workers/wrangler/configuration/ (read verbatim only for its first ~40% by the fetcher) |
| `d1_databases` is not named in the non-inheritable list, but the environments page says bindings must be specified per environment, and the D1 page repeats them per environment. **Treat it as per-environment.** | same, and https://developers.cloudflare.com/d1/configuration/environments/ (2026-09-17) |
| Each environment is deployed as a separate Worker named `<name>-<env>`, e.g. `open-arbiter-staging`. | environments page |
| Secrets are per environment (`wrangler secret put <KEY> --env <name>`; the page prints `-env`, apparently a typo). Local files `.dev.vars.<env>` / `.env.<env>`. | environments page |
| No deprecation of environments was found. Per-branch URLs: "Previews". | environments page |

**For us:**
- **Two environments, `staging` and `production`.** Each needs its own `[[env.X.d1_databases]]` (its own database id), its own `ARBITER_SIGNING_JWK`, `ADMIN_TOKEN` and `BUYER_SALT` secrets, and **no `DEV` var**.
- **Separate signing keys per environment.** The staging key must never appear in production's pinned `ARBITER_KEYS`.
- **Fix the top-level config.** Today's `arbiter/wrangler.toml` is top-level only (`name = "open-arbiter"`, one D1 binding). A bare `wrangler deploy` without `--env` would deploy the unnamed top-level Worker, so the plan should make the top level unusable for deploys or treat it as dev only.

### 2.2 D1 migrations on a database with data

| Fact | Source |
| --- | --- |
| Migrations are `.sql` files in `migrations/` (configurable `migrations_dir`, `migrations_pattern`), applied in order. The applied ones are recorded in the `d1_migrations` table (`migrations_table`). | https://developers.cloudflare.com/d1/reference/migrations/ (2026-06-08) |
| Commands: `wrangler d1 migrations create <DB> <message>`, `list <DB>` (shows **unapplied**), `apply <DB>` with `--local` / `--remote` / `--preview` / `--persist-to`, and the global `--env`. | https://developers.cloudflare.com/workers/wrangler/commands/d1/ (2026-04-23) |
| `apply` asks for confirmation interactively. "After applying, a backup will be captured." In CI "the confirmation step will be skipped, but the backup will still be captured". The page does not say where the backup is stored. | commands page |
| "If applying a migration results in an error, this migration will be rolled back, and the previous successful migration will remain applied." **No down migrations.** "D1 runs every query inside an implicit transaction." | commands page; https://developers.cloudflare.com/d1/sql-api/foreign-keys/ (2026-11-20) |
| `PRAGMA foreign_keys`: "user queries cannot change this during a query or migration". Use `PRAGMA defer_foreign_keys = true` for changes that would violate foreign keys temporarily; they must be resolved by the end of the transaction. "Deferring checks does not disable ON DELETE CASCADE … Test table rebuilds on a copy of your data and check child row counts." | foreign-keys page |
| The D1 SQL page has **no ALTER TABLE guidance** and no procedure for rebuilding a table to change constraints. | https://developers.cloudflare.com/d1/sql-api/sql-statements/ (2026-04-21) |

**For us:**
- **Turn the schema into migrations.** `arbiter/schema.sql` is a `CREATE … IF NOT EXISTS` script, and there is no `migrations/` directory. The plan should freeze `0000_baseline.sql` as exactly today's schema.
- **What a migration on a database with data must handle:**
  - **Foreign keys:** `listings → vendors` and `offers → mandates` have FKs. D1 enforces them, and so does node:sqlite (`PRAGMA foreign_keys` = 1 locally).
  - **Table rebuilds:** adding or changing a CHECK or UNIQUE needs the SQLite "create new table, copy, drop, rename" rebuild (an SQLite procedure, not in Cloudflare's docs; not fetched here) under `defer_foreign_keys`.
  - **The schema guard:** `REQUIRED_SCHEMA` must accept the result, so its regex on `listings.sql` must match a rebuilt table's text.
  - **Chain history:** `events_prev_unique` must hold across any data rewrite.
- **P1.2 (R6):** before migrating real data, check for SETTLED mandates with no receipt.
- **Test on a copy first.** Apply every migration to a local copy, or `--preview`, before `--remote`. The plan should require a dry run on a restored copy.

### 2.3 Worker versions and rollback

| Fact | Source |
| --- | --- |
| A version captures "bundled code, static assets, bindings, and compatibility settings"; a deployment says which version(s) serve traffic. `wrangler deploy` makes a version and sends it 100%. | https://developers.cloudflare.com/workers/configuration/versions-and-deployments/ (2026-11-19) |
| "State changes for associated storage resources such as KV, R2, Durable Objects, and D1 are not tracked with versions." **A rollback does not undo a D1 migration.** "Resources connected to your Worker will not be changed during a rollback." | same; https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/ (2026-11-19) |
| Rollback (`wrangler rollback <version-id>`) makes a new 100% deployment. "You can only roll back to the 100 most recently published versions." Versions are kept 30 days unless they are among the 100 latest or deployed. The pages do not say whether secrets roll back. | rollbacks page |
| Gradual deployments: `wrangler versions upload`, then `wrangler versions deploy` (interactive percentages); at most two versions at once; each request is routed independently (version skew). | https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/ (2026-11-12) |

**For us:**
- **Migrations must be backward compatible (expand, then contract).** Version N−1 must run on schema N, because a rollback leaves schema N in place. Our `ensureSchema` checks only that required objects exist, so it tolerates additions, but a removed or renamed column would break N−1.
- **Mechanism changes must not be gradual.** With two versions serving, two requests from one buyer could be priced by different `MECHANISM` versions. Resolve stores its outcome, so a mandate keeps its first price, but different mandates would follow different rules for a while. A pricing change needs a 100% deploy (or a gate on `MECHANISM.version`).
- **Unverified:** whether secrets follow a rollback. Check in staging.

### 2.4 D1 point-in-time restore (Time Travel)

| Fact | Source |
| --- | --- |
| Always on, at no extra cost. You can restore to "any minute within the last **7 days on the Workers Free plan** or **30 days on the Workers Paid plan**". Only for databases with `version: production` (see `wrangler d1 info`). | https://developers.cloudflare.com/d1/reference/time-travel/ (2026-11-20) |
| `wrangler d1 time-travel info <DB> [--timestamp=…]` and `wrangler d1 time-travel restore <DB> --timestamp=… \| --bookmark=…` | same |
| "Restoring … is a *destructive* operation, and overwrites the database in place." In-flight queries are cancelled. The restore returns a bookmark that undoes it. You **cannot restore into a different or new database** ("does not yet allow you to clone or fork"). | same |
| For more than 30 days, export to R2 (a REST API + Workflows guide). The legacy snapshot backups (`wrangler d1 backup …`) are marked for removal on 2025-07-01. Not fetched: `wrangler d1 export` syntax and limits. | same; https://developers.cloudflare.com/d1/reference/backups/ (2026-04-21) |

**For us:**
- **A restore rewinds the audit chain.** Receipts signed after the restore point still carry valid signatures, but `audit_hash` names events that no longer exist, and accepts after that point are lost (stock, offers). The runbook must:
  - note the restore point;
  - list receipts issued after it;
  - restore those receipts, or tell their holders, then record the incident in the chain.
- **No restore into a copy.** We can't restore a copy to inspect it first, so a dry run means exporting, then importing into a scratch database.
- **Free-plan retention is 7 days**, which sets how quickly a bad migration must be noticed.

### 2.5 Free-plan limits

| Limit (Workers Free / D1 Free) | Value | Source |
| --- | --- | --- |
| Worker requests | 100,000/day, resets 00:00 UTC. Over the limit: error 1027, or the Worker is bypassed if the route is set to "fail open" | https://developers.cloudflare.com/workers/platform/limits/ (2026-11-19) |
| CPU per HTTP request | **10 ms**. Over the limit: error 1102 | same |
| Subrequests per invocation | 50 (D1 calls count). 6 simultaneous connections | same; D1 limits page |
| Memory / Worker size / Workers per account | 128 MB / 64 MiB / 100 | Workers limits |
| D1 rows read / written | **5,000,000/day / 100,000/day**, reset 00:00 UTC. Over the limit: "you will not be able to run queries against D1" | https://developers.cloudflare.com/d1/platform/pricing/ (2026-10-30) |
| D1 database size / account storage / databases | 500 MB / 5 GB / 10 | https://developers.cloudflare.com/d1/platform/limits/ (2026-11-20) |
| D1 queries per invocation | **50 on Free** (1,000 on Paid). A `batch()` counts as one | D1 limits |
| SQL statement / bound parameters / query time | 100 KB / 100 / 30 s | D1 limits |
| Pages (Free) | 500 builds/month, 20,000 files, 25 MiB per file, 100 custom domains per project | https://developers.cloudflare.com/pages/platform/limits/ (2026-11-19) |
| `_headers` (Pages and Workers static assets) | 100 rules, 2,000 characters per line. Not applied to responses made by Worker code | Pages limits; https://developers.cloudflare.com/workers/static-assets/headers/ (2026-11-12) |

**What these limits mean for our code** (read from the code, not measured):
- **L1: `GET /v1/audit/verify` is a quota and CPU hazard.** It is unauthenticated and reads every event (`verifyChain`: `SELECT * FROM events`) and hashes each one. With N events, each call costs N rows read and N SHA-256 hashes:
  - At N = 10,000, about 500 calls use up the **whole account's 5M daily reads**, which takes the arbiter down until 00:00 UTC.
  - CPU will pass 10 ms long before that.

  This needs a plan item: cache the verified head, verify incrementally from a checkpoint, rate-limit or authenticate the full walk, or make it admin-only and publish signed head checkpoints.
- **L2: Queries per invocation.** A worst-case accept makes about 5 reads, then up to 12 × (head read + batch) under contention (the R4 change), then 1 read: about 30 of the free plan's 50. That is fine today, but the retry budget and this limit should be planned together.
- **L3: Rows written.** About 100,000/day. A negotiation writes a mandate, an event, offers, more events and a receipt, plus index rows. The pages did not say whether index updates count as rows written. Fine for a demo; measure on staging.
- **L4: CPU.** P-256 signing and a few SHA-256 hashes per write should fit in 10 ms, but this is unmeasured. Check with `wrangler tail` or analytics on staging.
- **L5: `_headers`.** We use 11 rules, and the longest line is 527 characters. Adding `https://otari.ai` and the real arbiter origin stays well under 2,000.
- **Pages or Workers static assets?** Both serve `_headers` the same way. None of the fetched pages says Cloudflare prefers one for new projects. The decision is still open (§4).

### 2.6 Minimum API token scope for CI

| Fact | Source |
| --- | --- |
| Docs: create an account API token from the **"Edit Cloudflare Workers"** template, then "scope these down as much as possible", e.g. to one account. Secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. "Don't store the value … in your repository." Example: `cloudflare/wrangler-action@v4`. | https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/ (2026-10-18); https://github.com/cloudflare/wrangler-action |
| Optional **token expiry** and **client IP filtering**. New tokens use the prefix `cfut_`. | https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ (2026-11-06) |
| Permissions that exist: Account **Workers Scripts Edit**, **D1 Edit**, **Cloudflare Pages Edit**, Account Settings Read. User Memberships Read and User Details Read. Zone **Workers Routes Edit** (from a summarised part of the page; verify in the dashboard). | https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (2026-11-15) |
| **Not answered by the docs:** which of these `wrangler deploy` needs, whether `d1 migrations apply --remote` needs D1 Edit, and whether a custom domain needs Zone Workers Routes Edit. | — |

**Proposal (to verify empirically on staging):** one token per environment, scoped to the one account, with an expiry. Start from:
- Account: Workers Scripts Edit, D1 Edit, Cloudflare Pages Edit (only if Oja goes to Pages);
- Account Settings Read;
- Zone Workers Routes Edit, only if a custom domain is used.

Then remove one permission at a time while running `wrangler deploy`, `d1 migrations apply --remote` and the Pages deploy, and record which ones fail. **Production migrations stay a manual, approved step**, not CI.

## 3. Unknowns and what can only be checked by deploying

1. Hosted D1: batch rollback and concurrency (plan risks R2 and R3 from Phase 0). Rerun `concurrency.mjs` against staging.
2. Whether `_headers` is served exactly as written on Pages or Workers static assets. Check with `curl -sI` plus `browser_check.py` against the staging URL.
3. Whether the Otari sign-in works end to end on an https staging origin. That needs a real otari.ai account, and owner approval because it creates a key.
4. The minimum token permissions (§2.6) and whether secrets follow a rollback (§2.3).
5. CPU time per request and rows written per negotiation (L3, L4).
6. `wrangler d1 export` syntax and limits (not fetched).

## 4. Decisions the owner will need for the Phase 1 plan

| # | Decision | Options | Research leaning |
| --- | --- | --- | --- |
| D1 | Host Oja on Pages or on Workers static assets | Pages (the current docs and `_headers` comments assume it); Workers static assets (one platform with the arbiter, same `_headers`) | Either works. Pages has build limits (500 a month) but needs no Worker code. Decide by the CI setup. |
| D2 | Publisher-funded inference | none; a proxy Worker with hard caps | After the first deploy (§1.3) |
| D3 | `/v1/audit/verify` exposure (L1) | admin-only full walk plus public signed checkpoints; incremental verify; rate limit | Must be decided before a public deploy |
| D4 | Production migrations | manual, owner-approved; CI applies them | Manual, with an approved runbook (Time Travel bookmark first) |
| D5 | Moving the local `../agentic-web` checkout to `d67755e` | checkout; scratch export | Checkout, with approval (it is outside this repo) |

## 5. Owner decisions (2026-11-24)

1. **Oja hosting:** Workers static assets if they apply `_headers` (to be verified in the current docs and with a deployed test). Otherwise Pages. Oja stays on its own origin, separate from the arbiter.
2. **Publisher-funded inference:** yes, later, in P5.7. Hard daily cap in the proxy and on the provider key. Not in Phase 1.
3. **Audit verification:** new task **P1.12**.
   - Public `GET /v1/audit/verify` is replaced by a public **signed checkpoint** (head hash, event count, time, signature) read from one row.
   - Full verification becomes admin-only and incremental from the last checkpoint.
   - A daily Cron Trigger verifies and publishes a checkpoint.
   - A restore that rewinds the chain must be detectable against a published checkpoint.
4. **Production migrations:** manual. Migrations must stay compatible with the previous Worker version. Mechanism changes never use split-traffic deployments. To be written into the Phase 1 ADRs.
5. **Upstream clone:** `../agentic-web` checked out at `d67755e` (done 2026-11-24, clean working tree before and after). The CLAUDE.md pin is updated.
