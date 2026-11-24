// Review finding R3 (Phase 0 gate, 2026-11-24): on a binding call (accept, mandate create), an
// error answer that is not a definite arbiter refusal can follow a committed write: a platform 5xx
// page (Cloudflare 52x, a Worker exception or CPU-limit kill) or the arbiter's own catch-all
// "internal" 500. Such an answer must be reported as UNKNOWN, never as "refused, nothing changed".
// The arbiter's own refusals ("busy", "out_of_stock", ...) stay definite: they are thrown before
// anything commits, or the batch rolled back.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../../../arbiter/src/index.js";
import { memoryD1 } from "../../../arbiter/test/sqlite-d1.mjs";
import { generateSigningKey, keyId } from "../../../arbiter/src/crypto.js";
import { ArbiterClient } from "../js/arbiter-client.js";
import { Market } from "../js/market.js";

const LIMIT = { timeout: 4000 };

/** What the browser gets instead of the arbiter's real answer, after the arbiter processed it. */
const REPLACE = {
  "platform 502 page": () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }),
  "platform 500 JSON without the arbiter's shape": () => Response.json({ error: "worker exceeded CPU" }, { status: 500 }),
  "arbiter catch-all internal 500": () => Response.json({ error: "internal", message: "Unexpected error." }, { status: 500 }),
};

async function setup(path, replace, times = Infinity) {
  const { privateJwk, publicJwk } = await generateSigningKey();
  const pub = { kid: await keyId(publicJwk), kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };
  const env = { DB: memoryD1(), ADMIN_TOKEN: "admin", ARBITER_SIGNING_JWK: JSON.stringify(privateJwk) };
  const calls = { n: 0 };
  const fetchImpl = async (url, init = {}) => {
    const res = await worker.fetch(new Request(url, init), env);
    if (!path.test(new URL(url).pathname) || init.method !== "POST") return res;
    calls.n++;
    return replace && calls.n <= times ? replace() : res;
  };
  const f = (p, init) => worker.fetch(new Request(`https://arb.test${p}`, init), env);
  const reg = await (await f("/v1/vendors", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ name: "Iya Basira" }) })).json();
  await f("/v1/listings", { method: "PUT", headers: { authorization: `Bearer ${reg.api_key}`, "content-type": "application/json" }, body: JSON.stringify({ sku: "rice-50kg", title: "Rice, 50 kg bag", unit: "bag", ask_cents: 9_200_000, floor_cents: 8_100_000, delivery_hours: 24, stock: 9 }) });
  const client = new ArbiterClient("https://arb.test", { fetchImpl, timeoutMs: 150, pinnedKeys: [pub] });
  const market = new Market(client);
  await market.refreshCatalog();
  return { env, calls, client, market };
}
const count = async (env, table) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const ACCEPT = /\/v1\/offers\/[^/]+\/accept$/;
const ARGS = { sku: "rice-50kg", quantity: 1, max_total: 90_000, deliver_within_hours: 48 };

for (const [name, replace] of Object.entries(REPLACE)) {
  test(`accept answered by a ${name} after the arbiter settled: unknown, sent once, re-accept blocked`, LIMIT, async () => {
    const { env, calls, market } = await setup(ACCEPT, replace);
    const neg = await market.negotiate(ARGS);
    assert.equal(neg.ok, true);
    const offerId = neg.offers[0].offer_id;
    await assert.rejects(market.acceptOffer({ offer_id: offerId }), /unknown/i, "must be reported as unknown");
    assert.equal(calls.n, 1, "never retried");
    assert.equal(await count(env, "receipts"), 1, "the arbiter did settle it");
    assert.equal(market.getState().negotiations[0].offers[0].state, "UNKNOWN");
    assert.equal(market.checkAccept({ offer_id: offerId }).ok, false, "re-accept blocked until a read");
  });

  test(`mandate create answered by a ${name} after the arbiter made it: unknown, secret kept, asking again recovers it`, LIMIT, async () => {
    // Both tries of the client's one automatic retry get the bad answer; the third request is real.
    const { env, market } = await setup(/^\/v1\/mandates$/, replace, 2);
    const first = await market.negotiate(ARGS);
    assert.equal(first.ok, false);
    assert.equal(first.unknown, true, `must be unknown, got ${JSON.stringify(first)}`);
    assert.equal(await count(env, "mandates"), 1, "the arbiter did make it");
    const again = await market.negotiate(ARGS);
    assert.equal(again.ok, true, `asking again must recover the same mandate, got ${JSON.stringify(again)}`);
    assert.equal(await count(env, "mandates"), 1, "no second mandate, no extra daily attempt used");
  });
}

test("a definite arbiter refusal on a binding call stays definite (busy 503)", LIMIT, async () => {
  const busy = () => Response.json({ error: "busy", message: "The arbiter's audit log is busy. Try again in a moment." }, { status: 503 });
  const { client, market } = await setup(ACCEPT, busy);
  const neg = await market.negotiate(ARGS);
  const r = await client.accept(neg.offers[0].offer_id);
  assert.equal(r.ok, false);
  assert.equal(r.unknown, undefined, JSON.stringify(r));
  assert.equal(r.code, "busy");
});
