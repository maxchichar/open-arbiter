# Open Arbiter + Oja — guidance for Claude Code

## What this is

An entry in the Open Agentic Web Challenge (Devpost, deadline **11 Jan 2027, 16:00 UTC**).
- `arbiter/`: **Open Arbiter**, shared infrastructure. A Cloudflare Worker + D1 that runs deterministic sealed-bid negotiation (Nash midpoint), anti-probing limits, ECDSA P-256 signed receipts and a hash-chained audit log. REST + MCP (`/mcp`).
- `sites/oja/`: **Oja**, the first agentic website using it. A static site whose agent network runs in the visitor's browser on their own LLM key.

Target spec: Worldwide Agentic Web MVP spec, Profile 0.3 (18 Nov 2026), in `cognizant-ai-labs/agentic-web`, pinned at commit `c178171d7ef3d0cf5c28208da1263bf954435e70`. Before any change touching the runtime, the manifest or the network format, check upstream for spec or runtime changes since that commit.

## Workflow

Use the `rpi-production-engineering` skill (`.claude/skills/rpi-production-engineering/`) for every engineering task. Tiering for this repo:
- **critical:** anything in `arbiter/src/` (pricing, money amounts, tokens, signing, authorization), `site-actions.js` effects, `bridge/` sharing rules, CORS, CSP, deployment.
- **standard:** page UI, network instructions (HOCON), docs, tests.

Keep RPI records in `docs/rpi/<task>/`. Never mark a check `pass` without evidence you actually produced.

## Commands

```shell
npm install
npm test                                   # unit, property and page tests (node:sqlite, no network)
cd arbiter && npx wrangler d1 execute open-arbiter --local --file schema.sql
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

Publishing Oja needs `DEFAULT_ARBITER_URL` and `ARBITER_KEYS` in `sites/oja/js/config.js`, the same pair as `"open_arbiter"` in `agent-manifest.json`, and the arbiter's origin in the `_headers` CSP `connect-src`; tests fail until all three agree. `?arbiter=` works only on loopback pages. The page CSP allows the runtime's one `<style>` by hash; replacing `runtime/` changes it and `tests/csp.test.mjs` says so.

`.dev.vars` (gitignored) needs `ADMIN_TOKEN`, `BUYER_SALT` and `DEV=1` for local runs. Without `ARBITER_SIGNING_JWK`, the arbiter refuses to sign (500 `misconfigured`) unless `DEV` is exactly `1`; never set `DEV` in a deployment. `npm run test:worker` runs seed, e2e and the concurrency checks against an isolated wrangler dev, so it never touches your local state. Local anti-probing limits apply per IP: reset with `rm -rf arbiter/.wrangler/state` and re-run the schema and seed steps.

## Invariants: never break these

1. **Sealed limits never leave the arbiter as values, and leak only within the price grid.** No API response, event payload, page state, tool result or log contains `floor_cents` or a buyer's `max_total_cents` (a vendor may read its own floors via `GET /v1/listings`). An agreed price depends on a seller's floor only through which per-unit price step it falls in (step = 2.5% of the unit list price, min ₦100), at every quantity, so any number of deals narrows a floor to no less than one step (the buyer's maximum likewise); the property tests in `arbiter/test/mechanism.test.mjs` must keep passing. Tests check all of this; extend them when you add an output.
2. **Pricing is deterministic and lives only in `arbiter/src/mechanism.js`** (pure functions, no I/O, no clock, no randomness).
3. **Anti-probing limits are enforced by the database, not by a prior read.** Each buyer (salted IP hash) gets at most 3 mandates per item per rolling 24 h: the `INSERT … SELECT … WHERE (count) < 3` writes 0 rows at the cap (429 `rate_limited`). Identical terms (sku, quantity, deadline, vendors; the budget is not part of the terms) can't be renegotiated: `UNIQUE (buyer_key, terms_key)` gives 409 `identical_terms`. A create retried with the same `buyer_token_hash`, terms and budget returns the existing mandate (200, `replayed: true`, nothing written, even at the cap or from another IP); the same hash with anything else is 409 `token_reused`. Resolve is idempotent. All of this must hold under concurrent requests (`arbiter/scripts/concurrency.mjs`).
4. **Buyer tokens stay inside `ArbiterClient`.** Never put them in page state, tool results or agent context.
5. **`negotiate` and `accept_offer` stay `irreversible`** so the runtime confirms them with the visitor. The runtime, not the model, owns confirmation.
6. **Do not edit `sites/oja/runtime/`.** It is the agentify skill's copy of the nsdeploy runtime (Apache 2.0). Replace it wholesale from upstream when updating.
7. **Action schemas use only the runtime's keywords:** type, properties, required, additionalProperties (must be false), items, enum, minimum, maximum, minLength, maxLength, minItems, maxItems, format (date|email), title, description, default. No `pattern` or `exclusiveMinimum`; registration fails at runtime and the build script does not catch it.
8. **Amounts are integer minor units (kobo) inside the arbiter**; agent-facing surfaces use naira.
9. Never commit secrets: `.dev.vars`, `.seed-keys.json`, signing JWKs, admin tokens.
10. **Writes refuse an outdated schema.** The chain, accept and idempotent-create guarantees rest on schema constraints (`events_prev_unique`, `listings` `CHECK stock_nonneg`, `mandates_token_unique`), listed in `REQUIRED_SCHEMA` in `arbiter/src/core.js`. `ensureSchema` refuses writes with 500 `misconfigured` when any is missing, checked once per database per Worker instance. Add every new constraint a guarantee depends on to that list and to `arbiter/test/schema-guard.test.mjs`. Never enforce such a guarantee only in application code.
11. **The buyer secret is made in the browser; the arbiter stores only its SHA-256.** `ArbiterClient` makes a 32-byte secret, sends `buyer_token_hash`, and keeps the secret (in memory, per terms and budget) until the negotiation resolves, so a retry recovers the same mandate. The arbiter never receives that secret, only its hash; it must not appear in page state, tool results or agent context (invariant 4). The server-made token path (REST/MCP without a hash) returns its token once and stores only the hash.
12. **Receipts verify only against a pinned key set, selected by `kid`.** `ARBITER_KEYS` in `sites/oja/js/config.js` equals `open_arbiter.keys` in the manifest. Keep retired keys there so old receipts verify. The arbiter's own JWKS is used only when the arbiter is loopback and nothing is pinned, and the badge says "dev key, not pinned". `?arbiter=` is honoured only on loopback pages.
13. **The page CSP stays strict.** `script-src 'self'` (no inline script, no eval), `style-src-elem 'self'` plus the runtime `<style>` hash (never `'unsafe-inline'`), `style-src-attr 'unsafe-inline'` only, `frame-ancestors 'none'` on pages with Accept buttons, and `connect-src` exactly the site, the arbiter and the runtime's LLM providers. A custom Provider URL is blocked, and `js/provider-guard.js` tells the visitor. Don't widen a directive to make a feature work: change the feature, or bring the trade-off to the owner. `tests/csp.test.mjs` and `browser_check.py` (0 violations) enforce it.

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
