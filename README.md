# Open Arbiter + Oja

**Open Arbiter** is shared infrastructure for the [Open Agentic Web](https://worldwideagenticweb.org): a deterministic, sealed-bid negotiation service that any agentic website can use to strike a fair deal for its visitor and hand back a signed, verifiable receipt.

**Oja** ("market" in Yoruba) is its first agentic website: buyers tell an assistant what foodstuff they need from Lagos market sellers, and the arbiter settles the price.

It implements the pattern in Cognizant AI Lab's [How AI Agents Can Negotiate and Transact on the Open Agentic Web](https://www.cognizant.com/us/en/ai-lab/blog/ai-agent-negotiation-open-agentic-web): agents discover and coordinate, deterministic code decides.

## Why

Letting two LLMs haggle leaks private limits, accepts bad prices and exceeds authority. Here:

- The **seller** seals a lowest price per unit. It lives only in the arbiter's database.
- The **buyer** seals a highest total. The page sends it to the arbiter and keeps it out of page state and tool results; sellers never see it. If you type it in the chat, the AI provider you chose (on your own key) sees it.
- The **arbiter** (plain JavaScript, no model) offers the Nash bargaining midpoint of the overlap, capped at list price and placed on a **price step of ₦100 × 2^k per unit, the largest at most 2.5% of the unit list price** (so 1.25–2.5%; steps of different list prices nest), filtered by delivery deadline and stock, ranked by price then delivery. With no overlap on the step grid it says "no agreement".
- **Bounded leak:** neither limit is ever returned. An agreed price depends on a seller's floor only through which price step it falls in, at every quantity, so any number of deals narrows a floor to no less than one price step (and the buyer's maximum to one step of the total). Property tests in `arbiter/test/mechanism.test.mjs` check this.
- **Anti-probing:** the same terms (item, quantity, deadline, sellers) can be negotiated once per buyer, and each item at most 3 times a day, so nobody can map a seller's floor by re-bidding.
- **Accountability:** every step goes into a hash-chained audit log; receipts are signed with ECDSA P-256 and can be verified by anyone with the public JWKS. Oja verifies them in the browser against the arbiter key pinned in the site (`js/config.js`), not against a key the arbiter serves at the time.
- **Humans stay in charge:** sealing a bid and accepting an offer are `irreversible` site actions, so the runtime asks the visitor before either happens.

## Layout

```
arbiter/                Cloudflare Worker + D1
  src/mechanism.js      pure pricing rules (no I/O)
  src/core.js           mandates, sealed listings, offers, receipts, audit chain
  src/mcp.js            MCP server (tools: list_catalog, negotiate, accept_offer, get_receipt, verify_receipt)
  src/index.js          REST API + /mcp + /.well-known/jwks.json, CORS
  migrations/           numbered D1 migrations (ADR 0005); lock.json pins their hashes
  scripts/              seed.mjs (demo sellers), e2e.mjs, keygen.mjs
  test/                 unit tests on node:sqlite
sites/oja/              the agentic website (static)
  agent-manifest.json, oja_market.hocon -> oja_market.network.json, links.json
  site-actions.js       website_get_market_state / negotiate / accept_offer / verify_receipt
  bridge/               shares catalogue + receipt checks with any other agentic site
  js/arbiter-client.js  reusable browser SDK: copy it into any site to use the arbiter
  vendor.html           seller console to seal prices
  runtime/              browser runtime from the agentic-web repo's agentify skill (Apache 2.0)
  tests/                Node tests, scripted LLM, headless browser check
```

## Run locally

Needs Node 22+.

```shell
npm install
cd arbiter
printf 'ADMIN_TOKEN=dev-admin-token\nBUYER_SALT=dev\nDEV=1\n' > .dev.vars   # DEV=1: local only, lets the arbiter generate its signing key
npx wrangler d1 migrations apply open-arbiter --local
npx wrangler dev --local --port 8787 &
node scripts/seed.mjs http://127.0.0.1:8787 dev-admin-token http://127.0.0.1:8080
node scripts/e2e.mjs http://127.0.0.1:8787
cd ..
node <agentic-web>/skills/agentify-website/scripts/serve_site.mjs sites/oja --port 8080
```

Open `http://127.0.0.1:8080/?arbiter=http://127.0.0.1:8787` (the `?arbiter=` override works only on a page served from this machine), add an Otari or OpenRouter key under **AI model settings** (or use **Connect with Otari**, which signs you in at otari.ai and saves a key you approve, with nothing to paste), and try "I need 2 bags of rice within 48 hours and won't pay more than 170,000 naira in total." Sellers sign in at `/vendor.html` with a key from `arbiter/.seed-keys.json`.

CI: `.github/workflows/ci.yml` runs all of the checks below on every push and pull request, without any Cloudflare credential (P1.3). `node arbiter/scripts/worker-harness.mjs --port 8787 browser` runs the browser check the way CI does (needs `AGENTIC_WEB=<clone at the pin>` and `pip install --require-hashes -r sites/oja/tests/requirements.txt`).

Tests: `npm test` (unit, property and page tests; no network). `npm run test:worker` runs seed, e2e and concurrency checks against an isolated `wrangler dev`. The browser check (`sites/oja/tests/browser_check.py`) drives the real page with a scripted LLM (`tests/fake-llm.mjs`), so it needs no key. It applies the page CSP from `_headers` and fails on any CSP violation.

## Deploy on Cloudflare

There are two environments, `staging` and `production`, each its own Worker (`open-arbiter-staging`, `open-arbiter-production`) with its own D1 database, KV namespace, secrets and signing key. The top level of `arbiter/wrangler.toml` is for local development only. The full runbook (migrations, rollback, restore, key rotation) is being written in Phase 1. For one environment, here `staging`:

```shell
cd arbiter
npx wrangler d1 create open-arbiter-staging                      # paste the id into [[env.staging.d1_databases]]
npx wrangler kv namespace create AUDIT_ANCHOR --env staging      # paste the id into [[env.staging.kv_namespaces]]
npx wrangler d1 migrations apply open-arbiter-staging --env staging --remote   # after a Time Travel bookmark and premigrate-check (ADR 0005)
npx wrangler secret put ADMIN_TOKEN --env staging
npx wrangler secret put BUYER_SALT --env staging
node scripts/keygen.mjs --out ~/keys/open-arbiter-staging.jwk    # outside the repo; one key per environment
npx wrangler secret put ARBITER_SIGNING_JWK --env staging < ~/keys/open-arbiter-staging.jwk
cd .. && npm run deploy:arbiter -- staging                       # refuses without an environment
```

`wrangler deploy` fails while a required secret is unset (`secrets.required`). `npm run deploy:arbiter` refuses to run without `staging` or `production` and while that environment's ids are placeholders. Production also needs `--confirm-production`.

Then pin the environment in `sites/oja/environments.json`: its arbiter origin as `arbiter_url`, and the output of `node arbiter/scripts/pubkey.mjs < ~/keys/open-arbiter-staging.jwk` in `keys` (keep retired keys there after a rotation; a key may never be pinned in both environments). `npm run build:oja -- staging` writes `dist/oja-staging/`: the site with that URL and those keys in `js/config.js`, `"open_arbiter"` in `agent-manifest.json` and every `connect-src` in `_headers`. It refuses an environment without a URL or keys, and checks the three agree. `sites/oja/` itself stays the local-development site. Rebuild the network if you changed the HOCON (`node <agentic-web>/skills/agentify-website/scripts/build_network.mjs oja_market.hocon --manifest agent-manifest.json` from `sites/oja`) before building. Seed a staging arbiter with `node arbiter/scripts/seed.mjs <arbiter-url> <ADMIN_TOKEN> <oja-url>`. `_headers` sets the CORS headers, the coded-tool worker's CSP and a strict page CSP: scripts only from the site, no inline script or eval, no framing, and network access only to the site, the arbiter, the AI providers listed in the assistant's settings and `https://otari.ai` (where Connect with Otari exchanges its sign-in code for a key). A custom "Provider URL" outside that list is blocked by the CSP.

## Use the arbiter from your own site

- **Browser:** copy `sites/oja/js/arbiter-client.js`; register `negotiate` and `accept_offer` as `irreversible` site actions so the runtime confirms them. The client keeps buyer tokens out of page state and agent context.
- **MCP:** list `{"url": "https://<arbiter>/mcp", "tools": ["list_catalog", "negotiate"]}` in an agent's `tools`. Note that over MCP the `buyer_token` is returned to the caller.
- **Peer network:** call `https://<oja-site>/oja_market` from your network; Oja's bridge shares `get_market_state` and `verify_receipt` with every origin.

## Error codes

Every error is JSON `{"error": "<code>", "message": "...", "request_id": "..."}` with the status below. Branch on `error`; `message` is for people and may change. `request_id` is also the `x-request-id` header, and it finds the request's line in the arbiter's logs. The registry is `arbiter/src/errors.js`.

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid` | 400 | The request's fields are missing, malformed or out of range; the message says which. |
| `invalid_json` | 400 | The request body is not JSON. |
| `unauthorized` | 401 | The admin token or vendor key is missing or wrong. |
| `not_found` | 404 | No such route, mandate, offer or receipt, or the buyer token does not match. |
| `unknown_tool` | 404 | An MCP tools/call named a tool this server does not have. |
| `method_not_allowed` | 405 | The route exists but not for this HTTP method. |
| `already_settled` | 409 | The mandate already has an accepted offer. |
| `offer_closed` | 409 | The offer is no longer open; nothing changed. |
| `out_of_stock` | 409 | The seller no longer has the stock for this offer; nothing changed. |
| `identical_terms` | 409 | These exact terms were already negotiated by this caller; changing only the budget is not allowed. |
| `token_reused` | 409 | This buyer secret already belongs to a negotiation with other terms or budget. |
| `offer_expired` | 410 | The offer's 15 minutes have passed. |
| `too_large` | 413 | The request body is over 64 KB. |
| `rate_limited` | 429 | The caller reached 3 negotiations for this item in 24 hours (anti-probing). |
| `rate_limited_ip` | 429 | Too many requests from this address in the last minute (quota protection); retry after the retry-after header's seconds. |
| `internal` | 500 | An unexpected error. Whether a write happened is unknown; the request_id identifies it in the logs. |
| `misconfigured` | 500 | The deployment is missing its signing key or its database migrations; nothing was written. |
| `busy` | 503 | The audit log is busy with concurrent writes; nothing was written. Retry shortly. |
| `db_unavailable` | 503 | /health: the database did not answer SELECT 1. |
| `schema_outdated` | 503 | /health: the database has no migrations table; it was never migrated. |
| `migrations_pending` | 503 | /health: a migration this Worker needs is not applied; it refuses writes until it is. |
| `key_missing` | 503 | /health: no ARBITER_SIGNING_JWK secret, so the arbiter cannot sign receipts. |
| `key_invalid` | 503 | /health: ARBITER_SIGNING_JWK is not a private P-256 JWK. |
| `key_dev_in_deployed_env` | 503 | /health: DEV=1 is set in staging or production; it must never be deployed. |

## Limits (honest list)

- Settlement is simulated; no money moves. Payments, delivery and disputes are out of scope.
- An agreed price narrows each side's limit to one price step (₦100 × 2^k per unit, 1.25–2.5% of the unit list price). That is the designed, bounded leak, and it holds however many deals are made, also across list-price changes (then with the smallest step used); "no agreement" reveals only that the step-aligned zones did not overlap. One step is reachable: enough deals can pin a floor to its step. A seller's lowest price may not fall inside the partial step just under its list price: it must be at most the last whole step at or below the list price (for ₦90,000, step ₦1,600: at most ₦89,600), and the arbiter names that limit when it refuses one (`docs/decisions/0001-price-leakage-policy.md`).
- Whatever the visitor types in the chat, including a maximum, goes to the AI provider they chose.
- The page's Content-Security-Policy lets the assistant reach only the AI providers listed in its settings (Otari, Google AI Studio, Groq, OpenRouter, OpenAI, Anthropic), plus otari.ai for the Connect with Otari sign-in. Connect with Otari saves the new key in this browser like a pasted key, so any script on the site could read it; the CSP allows only the site's own scripts. A custom Provider URL, including a local model server, is blocked by the browser; the settings panel says so and names the allowed providers. Supporting another provider means adding its origin to `connect-src` in `sites/oja/_headers`.
- Anti-probing keys on a salted hash of the caller's IP: a determined prober with many IPs gets more attempts.
- Quota protection (Cloudflare Free plan). Workers: 100,000 requests a day and 10 ms of CPU per request; past the daily limit Cloudflare answers with **Error 1027** until 00:00 UTC, before the arbiter runs. D1: 5 million rows read and 100,000 rows written a day; past either, every query fails until 00:00 UTC, so the arbiter answers `500 internal` (and `/health` `503 db_unavailable`) for the rest of the UTC day. To keep one client from spending that: each IP gets 100 requests a minute (`429 rate_limited_ip`, with `retry-after`), counted per Worker instance and, where the Workers rate-limiting binding is available, per Cloudflare location (`/health` says which in `rate_limit`). Both counts are approximate, and many addresses together (a botnet, or IPv6 rotation) can still spend the daily quotas; shared addresses (carrier-grade NAT) share one allowance. Public reads are bounded: the catalog returns at most 100 listings a page (`next` continues it), and full chain verification (`/v1/audit/verify`) needs the admin token.
- The arbiter is a trusted third party. Its code is open and deterministic, and its receipts are verifiable, but its operator can see sealed limits.
- Seller identity is a key issued by the arbiter's admin; there is no KYC or NANDA Index verification yet.
- Demo sellers and prices are illustrative, not market data.
- One global, hash-chained audit log orders every write, so writes are serialized: concurrent writers that collide retry with backoff, and under sustained load they see `503 busy`. Per-mandate chains (anchored to a global chain of heads) or a Durable Object that owns the log are the scaling path; neither is built.

Apache 2.0.
