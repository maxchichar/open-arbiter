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
  schema.sql            D1 schema
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
npx wrangler d1 execute open-arbiter --local --file schema.sql
npx wrangler dev --local --port 8787 &
node scripts/seed.mjs http://127.0.0.1:8787 dev-admin-token http://127.0.0.1:8080
node scripts/e2e.mjs http://127.0.0.1:8787
cd ..
node <agentic-web>/skills/agentify-website/scripts/serve_site.mjs sites/oja --port 8080
```

Open `http://127.0.0.1:8080/?arbiter=http://127.0.0.1:8787` (the `?arbiter=` override works only on a page served from this machine), add an Otari or OpenRouter key under **AI model settings**, and try "I need 2 bags of rice within 48 hours and won't pay more than 170,000 naira in total." Sellers sign in at `/vendor.html` with a key from `arbiter/.seed-keys.json`.

Tests: `npm test` (unit, property and page tests; no network). `npm run test:worker` runs seed, e2e and concurrency checks against an isolated `wrangler dev`. The browser check (`sites/oja/tests/browser_check.py`) drives the real page with a scripted LLM (`tests/fake-llm.mjs`), so it needs no key. It applies the page CSP from `_headers` and fails on any CSP violation.

## Deploy on Cloudflare

```shell
cd arbiter
npx wrangler d1 create open-arbiter          # paste the database_id into wrangler.toml
npx wrangler d1 execute open-arbiter --remote --file schema.sql
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put BUYER_SALT
node scripts/keygen.mjs | npx wrangler secret put ARBITER_SIGNING_JWK
npx wrangler deploy                          # note the workers.dev URL
node scripts/seed.mjs https://open-arbiter.<you>.workers.dev <ADMIN_TOKEN> https://<your-pages-site>
```

Then set `DEFAULT_ARBITER_URL` in `sites/oja/js/config.js` to the Worker URL and pin its key: put the output of `node arbiter/scripts/pubkey.mjs < private.jwk` in `ARBITER_KEYS` (keep retired keys there after a rotation). Copy both into `"open_arbiter"` in `sites/oja/agent-manifest.json`; `npm test` fails until they match, and fails if a public arbiter has no pinned key. Add the Worker's origin to `connect-src` in `sites/oja/_headers` (a test checks this too). Then rebuild the network if you changed the HOCON (`node <agentic-web>/skills/agentify-website/scripts/build_network.mjs oja_market.hocon --manifest agent-manifest.json` from `sites/oja`), and publish `sites/oja` with `npx wrangler pages deploy sites/oja --project-name oja`. `_headers` sets the CORS headers, the coded-tool worker's CSP and a strict page CSP: scripts only from the site, no inline script or eval, no framing, and network access only to the site, the arbiter and the AI providers listed in the assistant's settings. A custom "Provider URL" outside that list is blocked by the CSP.

## Use the arbiter from your own site

- **Browser:** copy `sites/oja/js/arbiter-client.js`; register `negotiate` and `accept_offer` as `irreversible` site actions so the runtime confirms them. The client keeps buyer tokens out of page state and agent context.
- **MCP:** list `{"url": "https://<arbiter>/mcp", "tools": ["list_catalog", "negotiate"]}` in an agent's `tools`. Note that over MCP the `buyer_token` is returned to the caller.
- **Peer network:** call `https://<oja-site>/oja_market` from your network; Oja's bridge shares `get_market_state` and `verify_receipt` with every origin.

## Limits (honest list)

- Settlement is simulated; no money moves. Payments, delivery and disputes are out of scope.
- An agreed price narrows each side's limit to one price step (₦100 × 2^k per unit, 1.25–2.5% of the unit list price). That is the designed, bounded leak, and it holds however many deals are made, also across list-price changes (then with the smallest step used); "no agreement" reveals only that the step-aligned zones did not overlap. One step is reachable: enough deals can pin a floor to its step. A seller's lowest price may not fall inside the partial step just under its list price: it must be at most the last whole step at or below the list price (for ₦90,000, step ₦1,600: at most ₦89,600), and the arbiter names that limit when it refuses one (`docs/decisions/0001-price-leakage-policy.md`).
- Whatever the visitor types in the chat, including a maximum, goes to the AI provider they chose.
- The page's Content-Security-Policy lets the assistant reach only the AI providers listed in its settings (Otari, Google AI Studio, Groq, OpenRouter, OpenAI, Anthropic). A custom Provider URL, including a local model server, is blocked by the browser; the settings panel says so and names the allowed providers. Supporting another provider means adding its origin to `connect-src` in `sites/oja/_headers`.
- Anti-probing keys on a salted hash of the caller's IP: a determined prober with many IPs gets more attempts.
- The arbiter is a trusted third party. Its code is open and deterministic, and its receipts are verifiable, but its operator can see sealed limits.
- Seller identity is a key issued by the arbiter's admin; there is no KYC or NANDA Index verification yet.
- Demo sellers and prices are illustrative, not market data.
- One global, hash-chained audit log orders every write, so writes are serialized: concurrent writers that collide retry with backoff, and under sustained load they see `503 busy`. Per-mandate chains (anchored to a global chain of heads) or a Durable Object that owns the log are the scaling path; neither is built.

Apache 2.0.
