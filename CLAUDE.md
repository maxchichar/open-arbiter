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
npm test                                   # 18 unit + page tests (node:sqlite, no network)
cd arbiter && npx wrangler d1 execute open-arbiter --local --file schema.sql
cd arbiter && npx wrangler dev --local --port 8787 --ip 127.0.0.1
node arbiter/scripts/seed.mjs http://127.0.0.1:8787 dev-admin-token http://127.0.0.1:8080
node arbiter/scripts/e2e.mjs http://127.0.0.1:8787
# Serve the site with the skill's server (needs a clone of agentic-web):
node <agentic-web>/skills/agentify-website/scripts/serve_site.mjs sites/oja --port 8080
# Rebuild + validate the network after editing oja_market.hocon or agent-manifest.json:
(cd sites/oja && node <agentic-web>/skills/agentify-website/scripts/build_network.mjs oja_market.hocon --manifest agent-manifest.json)
# Browser check with a scripted LLM (no key): start tests/fake-llm.mjs on 8799, then
python3 sites/oja/tests/browser_check.py /tmp/shots
```

`.dev.vars` (gitignored) needs `ADMIN_TOKEN` and `BUYER_SALT` for local runs. Local anti-probing limits apply per IP: reset with `rm -rf arbiter/.wrangler/state` and re-run the schema and seed steps.

## Invariants: never break these

1. **Sealed limits never leave the arbiter.** No API response, event payload, page state, tool result or log contains `floor_cents` or a buyer's `max_total_cents` (a vendor may read its own floors via `GET /v1/listings`). Tests check this; extend them when you add an output.
2. **Pricing is deterministic and lives only in `arbiter/src/mechanism.js`** (pure functions, no I/O, no clock, no randomness).
3. **Resolve is idempotent; the same terms can't be renegotiated** (`UNIQUE (buyer_key, terms_key)`), and each item allows at most 3 mandates per buyer per day.
4. **Buyer tokens stay inside `ArbiterClient`.** Never put them in page state, tool results or agent context.
5. **`negotiate` and `accept_offer` stay `irreversible`** so the runtime confirms them with the visitor. The runtime, not the model, owns confirmation.
6. **Do not edit `sites/oja/runtime/`.** It is the agentify skill's copy of the nsdeploy runtime (Apache 2.0). Replace it wholesale from upstream when updating.
7. **Action schemas use only the runtime's keywords:** type, properties, required, additionalProperties (must be false), items, enum, minimum, maximum, minLength, maxLength, minItems, maxItems, format (date|email), title, description, default. No `pattern` or `exclusiveMinimum`; registration fails at runtime and the build script does not catch it.
8. **Amounts are integer minor units (kobo) inside the arbiter**; agent-facing surfaces use naira.
9. Never commit secrets: `.dev.vars`, `.seed-keys.json`, signing JWKs, admin tokens.

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

Settlement is simulated. Anti-probing keys on a salted IP hash. The arbiter operator can see sealed limits. Seller identity is an admin-issued key. Demo prices are illustrative.
