# Open Arbiter + Oja — guidance for Claude Code

## What this is

An entry in the Open Agentic Web Challenge (Devpost, deadline **11 Jan 2027, 16:00 UTC**).
- `arbiter/`: **Open Arbiter**, shared infrastructure. A Cloudflare Worker + D1 that runs deterministic sealed-bid negotiation (Nash midpoint), anti-probing limits, ECDSA P-256 signed receipts and a hash-chained audit log. REST + MCP (`/mcp`).
- `sites/oja/`: **Oja**, the first agentic website using it. A static site whose agent network runs in the visitor's browser on their own LLM key.

Target spec: Worldwide Agentic Web MVP spec, Profile 0.3 (18 Nov 2026), in `cognizant-ai-labs/agentic-web`, pinned at commit `90d561d6185d3b5625f9d8055da4d259074af745` (2026-11-26; the spec text is unchanged since `c178171`). `sites/oja/runtime/` is the `90d561d` copy (P1.3b); `sites/oja/tests/runtime-lock.json` (written by `scripts/runtime-lock.mjs`) holds each file's hash and `tests/runtime-pin.test.mjs` checks it and the CI pin. Before any change touching the runtime, the manifest or the network format, check upstream for spec or runtime changes since the pin.

## Workflow

Use the `rpi-production-engineering` skill (`.claude/skills/rpi-production-engineering/`) for every engineering task. Tiering for this repo:
- **critical:** anything in `arbiter/src/` (pricing, money amounts, tokens, signing, authorization), `site-actions.js` effects, `bridge/` sharing rules, CORS, CSP, deployment.
- **standard:** page UI, network instructions (HOCON), docs, tests.

Keep RPI records in `docs/rpi/<task>/`. Never mark a check `pass` without evidence you actually produced.

Save test output for evidence only through `node scripts/save-output.mjs <file> -- <cmd…>`: it keeps the command's exit status (so `&& next` stops on a red run), appends `exit: <code>`, and redacts secret-shaped values. Never pipe a test run through `grep`/`tail` into evidence, because that loses the exit status.

CI (`.github/workflows/ci.yml`, P1.3) runs `npm test`, the history secret scan, the workflow and M3 guards (`scripts/ci-guards.mjs`), `test:m2`, `test:worker`, `test:migrations-d1`, the network `--check`, the upstream linking tests and its Trusted Types, IME and form tests, a `diff -r` of `runtime/` against the pin and `browser_check.py`, with `agentic-web` cloned at the pin. It holds **no Cloudflare credential and no secret** until P1.4 (A2/A4); `ci-guards.mjs workflows` and `arbiter/test/ci-guards.test.mjs` refuse a workflow that deploys, migrates remotely, mentions production in a command, uses `secrets.*`, `pull_request_target`, an action not pinned by SHA, or a checkout that keeps credentials. Before any push: `node scripts/secret-scan.mjs --history`.

The versioned pre-commit hook (`.githooks/pre-commit`, enabled by `npm install` via `core.hooksPath`) runs `scripts/secret-scan.mjs --staged` and blocks a commit on any finding. Don't bypass it with `--no-verify`. The versioned pre-push hook (`.githooks/pre-push`) refuses a push unless every pushed ref is HEAD, the working tree is clean (untracked files included), the history secret scan is clean and `npm test` passes on HEAD. A deliberate red-test push uses `OPEN_ARBITER_ALLOW_RED_PUSH=1 git push …` (exactly `1`; it skips only `npm test` and prints BYPASSED); never `--no-verify`.

Whenever Otari causes friction (sign-in, keys, models, docs, CSP origins), add an entry to `docs/otari-feedback.md`: date, what happened, what would help.

## Commands

```shell
npm install
npm test                                   # unit, property and page tests (node:sqlite, no network)
npm run test:m2                            # M2: each release tag's tests on a database migrated to HEAD (needs the tags)
npm run test:migrations-d1                 # the migrations through wrangler's local D1 (empty, v0.0-seeded, rebuild)
cd arbiter && npx wrangler d1 migrations apply open-arbiter --local
cd arbiter && npx wrangler dev --local --port 8787 --ip 127.0.0.1
node arbiter/scripts/seed.mjs http://127.0.0.1:8787 dev-admin-token http://127.0.0.1:8080
node arbiter/scripts/e2e.mjs http://127.0.0.1:8787
# Serve the site with the skill's server (needs a clone of agentic-web):
node <agentic-web>/skills/agentify-website/scripts/serve_site.mjs sites/oja --port 8080
# Rebuild + validate the network after editing oja_market.hocon or agent-manifest.json:
(cd sites/oja && node <agentic-web>/skills/agentify-website/scripts/build_network.mjs oja_market.hocon --manifest agent-manifest.json)
# Browser check with a scripted LLM (no key): start tests/fake-llm.mjs on 8799, then
python3 sites/oja/tests/browser_check.py /tmp/shots   # needs Playwright; applies the _headers CSP and fails on any violation
```

Arbiter environments: `[env.staging]` and `[env.production]` in `arbiter/wrangler.toml`, each with its own D1, KV, secrets (`secrets.required`) and signing key; the top level is local dev only. Deploy with `npm run deploy:arbiter -- <staging|production>` (refuses without one). `keygen.mjs` never writes inside the repo.

Publishing Oja: `sites/oja/` is the local-dev site (loopback arbiter, no pins). Each environment's arbiter origin and pinned keys live in `sites/oja/environments.json`; `npm run build:oja -- <env>` writes `dist/oja-<env>/` with them in `js/config.js`, `"open_arbiter"` in `agent-manifest.json` and the `_headers` `connect-src`, and fails unless all three agree. A `kid` may never be pinned in both environments. `?arbiter=` works only on loopback pages. The page CSP allows the runtime's one `<style>` by hash; replacing `runtime/` changes it and `tests/csp.test.mjs` says so.

`.dev.vars` (gitignored) needs `ADMIN_TOKEN`, `BUYER_SALT` and `DEV=1` for local runs. Without `ARBITER_SIGNING_JWK`, the arbiter refuses to sign (500 `misconfigured`) unless `DEV` is exactly `1`; never set `DEV` in a deployment. `npm run test:worker` runs seed, e2e and the concurrency checks against an isolated wrangler dev, so it never touches your local state. Every request but CORS preflight counts against a per-IP limit (P1.7, `arbiter/src/quota.js`): 100 per 60 s in staging and production, 1000 locally (`IP_LIMIT_PER_60S` and the `IP_RATE_LIMIT` binding agree, per environment). Deployed, only `cf-connecting-ip` identifies the caller. Public reads stay O(page): new public queries need an index (`arbiter/test/bounded-reads.test.mjs` checks the plans). Local anti-probing limits apply per IP: reset with `rm -rf arbiter/.wrangler/state` and re-run the migrations and seed steps. A local database made from the old `schema.sql` is adopted by `migrations apply` (0000 is `IF NOT EXISTS`).

## Invariants: never break these

1. **Sealed limits never leave the arbiter as values, and leak only within the price grid.** No API response, event payload, page state, tool result or log contains `floor_cents` or a buyer's `max_total_cents` (a vendor may read its own floors via `GET /v1/listings`). An agreed price depends on a seller's floor only through which per-unit price step it falls in (step = ₦100 × 2^k per unit, the largest at most 2.5% of the unit list price), at every quantity; steps of different list prices nest and a floor must sit at or below `maxFloor(ask)`, so any number of deals, also across list-price changes, narrows a floor to no less than the smallest step used (the buyer's maximum likewise; ADR 0001); the property tests in `arbiter/test/mechanism.test.mjs` must keep passing. Tests check all of this; extend them when you add an output.
2. **Pricing is deterministic and lives only in `arbiter/src/mechanism.js`** (pure functions, no I/O, no clock, no randomness).
3. **Anti-probing limits are enforced by the database, not by a prior read.** Each buyer (salted IP hash) gets at most `MANDATES_PER_ITEM_PER_DAY` mandates per item per rolling 24 h (20 by default and in every environment; load protection, since the leakage bound holds for any number of deals, ADR 0001): the `INSERT … SELECT … WHERE (count) < cap` writes 0 rows at the cap (429 `rate_limited`). Identical terms (sku, quantity, deadline, vendors; the budget is not part of the terms) can't be renegotiated: `UNIQUE (buyer_key, terms_key)` gives 409 `identical_terms`. A create retried with the same `buyer_token_hash`, terms and budget returns the existing mandate (200, `replayed: true`, nothing written, even at the cap or from another IP); the same hash with anything else is 409 `token_reused`. Resolve is idempotent. All of this must hold under concurrent requests (`arbiter/scripts/concurrency.mjs`).
4. **Buyer tokens stay inside `ArbiterClient`.** Never put them in page state, tool results or agent context.
5. **`negotiate` and `accept_offer` stay `irreversible`** so the runtime confirms them with the visitor. The runtime, not the model, owns confirmation.
6. **Do not edit `sites/oja/runtime/`.** It is the agentify skill's copy of the nsdeploy runtime (Apache 2.0). Replace it wholesale from upstream when updating, then rerun `scripts/runtime-lock.mjs`. Upstream now says a site's copy is the owner's to change; we keep this rule anyway (owner, 2026-11-27), so the copy stays diffable against the pin.
7. **Action schemas use only the runtime's keywords:** type, properties, required, additionalProperties (must be false), items, enum, minimum, maximum, minLength, maxLength, minItems, maxItems, format (date|email), title, description, default. No `pattern` or `exclusiveMinimum`; registration fails at runtime and the build script does not catch it.
8. **Amounts are integer minor units (kobo) inside the arbiter**; agent-facing surfaces use naira.
9. Never commit secrets: `.dev.vars`, `.seed-keys.json`, signing JWKs, admin tokens. `arbiter/test/secret-scan.test.mjs` checks every tracked file.
10. **Writes refuse an outdated schema, by migration level.** The chain, accept and idempotent-create guarantees rest on constraints the migrations create (`events_prev_unique`, `listings` `CHECK stock_nonneg`, `mandates_token_unique`, the R6 `mandates.settle_attempt` marker). `ensureSchema` refuses writes with 500 `misconfigured` until every name in `REQUIRED_MIGRATIONS` (`arbiter/src/core.js`, always all of `arbiter/migrations/`) is in `d1_migrations`, checked once per database per Worker instance. Change the schema only with a new numbered migration, add its hash to `migrations/lock.json`, and test that it creates what the guarantee needs. Never edit an applied migration, and never enforce a guarantee only in application code.
14. **Every migration is compatible with the previous Worker (M2, ADR 0005).** Expand, then contract; migrate, then deploy; name columns in every `INSERT`. `npm run test:m2` runs each release tag's tests on a database migrated to HEAD and must pass. Table rebuilds: defer foreign keys, check `pragma_foreign_key_check` is empty, then turn defer off (turning it off discards violations). Run `premigrate-check.mjs` before migrating a database with data. Production migrations are manual and owner-approved.
11. **The buyer secret is made in the browser; the arbiter stores only its SHA-256.** `ArbiterClient` makes a 32-byte secret, sends `buyer_token_hash`, and keeps the secret (in memory, per terms and budget) until the negotiation resolves, so a retry recovers the same mandate. The arbiter never receives that secret, only its hash; it must not appear in page state, tool results or agent context (invariant 4). The server-made token path (REST/MCP without a hash) returns its token once and stores only the hash.
12. **Receipts verify only against a pinned key set, selected by `kid`.** `ARBITER_KEYS` in `sites/oja/js/config.js` equals `open_arbiter.keys` in the manifest; for staging and production both come from `sites/oja/environments.json` through `npm run build:oja`, and each environment pins only its own keys. Keep retired keys there so old receipts verify. The arbiter's own JWKS is used only when the arbiter is loopback and nothing is pinned, and the badge says "dev key, not pinned". `?arbiter=` is honoured only on loopback pages.
13. **The page CSP stays strict.** `script-src 'self'` (no inline script, no eval), `require-trusted-types-for 'script'` with only the runtime's policy (`trusted-types agentify-website`; `tests/trusted-types.test.mjs` scans for sinks that skip it; the bridge gets it with the storefronts), `style-src-elem 'self'` plus the runtime `<style>` hash (never `'unsafe-inline'`), `style-src-attr 'unsafe-inline'` only, `frame-ancestors 'none'` on pages with Accept buttons, and `connect-src` exactly the site, the arbiter, the runtime's LLM providers and its key sign-in endpoints (`https://otari.ai` for Connect with Otari; Connect with OpenRouter uses `openrouter.ai`, already a provider). A custom Provider URL is blocked, and `js/provider-guard.js` tells the visitor. Don't widen a directive to make a feature work: change the feature, or bring the trade-off to the owner. `tests/csp.test.mjs` and `browser_check.py` (0 violations) enforce it.

## Status against the release checklist

Done: manifest/network validated; runtime runs the network (scripted LLM only); grounded site actions; deterministic outcomes; human approval before binding; receipts + audit.

Not yet:
- [ ] Network has two agents (spec §6 asks for a two-agent network)
- [ ] Published over HTTPS (Cloudflare Workers + Pages)
- [ ] Second, separately hosted site calling `oja_market` after consent (seller storefronts)
- [ ] BYOK shown never reaching a peer
- [ ] Private context (sly_data) shown blocked at the peer
- [ ] Invalid network, composition cycle, over-budget request and denied origin fail visibly (spec §6)
- [ ] Tested with a real model (Otari `alibaba/qwen3.8-flash`), not only the scripted LLM
- [ ] Prompt-injection tests: a hostile peer network or listing title tries to make the agent accept or reveal limits
- [ ] Screenshots, under-2-minute video (on camera, not AI-generated), Devpost submission

## Known limits (keep them honest in docs)

Settlement is simulated. An agreed price narrows each limit to one price step (the designed, bounded leak). Anti-probing keys on a salted IP hash. The arbiter operator can see sealed limits. Seller identity is an admin-issued key. Demo prices are illustrative.
