// P0.10 (client): the page makes the buyer secret, sends only its hash, and retries a create whose
// answer was lost with the same secret, so the arbiter returns the mandate it already made.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../../../arbiter/src/index.js";
import { memoryD1 } from "../../../arbiter/test/sqlite-d1.mjs";
import { ArbiterClient } from "../js/arbiter-client.js";
import { Market } from "../js/market.js";

const LIMIT = { timeout: 4000 };

/** The arbiter processes every request; the first `lose` answers to POST /v1/mandates are lost. */
async function setup({ lose = 1, mode = "network-error" } = {}) {
  const env = { DB: memoryD1(), ADMIN_TOKEN: "admin", DEV: "1" };
  const seen = { creates: 0, bodies: [] };
  const fetchImpl = async (url, init = {}) => {
    const res = await worker.fetch(new Request(url, init), env);
    if (new URL(url).pathname !== "/v1/mandates" || init.method !== "POST") return res;
    seen.creates++;
    seen.bodies.push(String(init.body));
    if (seen.creates > lose) return res;
    if (mode === "network-error") throw new TypeError("fetch failed");
    return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  };
  const f = (path, init) => worker.fetch(new Request(`https://arb.test${path}`, init), env);
  const reg = await (await f("/v1/vendors", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ name: "Iya Basira" }) })).json();
  await f("/v1/listings", { method: "PUT", headers: { authorization: `Bearer ${reg.api_key}`, "content-type": "application/json" }, body: JSON.stringify({ sku: "rice-50kg", title: "Rice, 50 kg bag", unit: "bag", ask_cents: 9_200_000, floor_cents: 8_100_000, delivery_hours: 24, stock: 9 }) });
  const market = new Market(new ArbiterClient("https://arb.test", { fetchImpl, timeoutMs: 150 }));
  await market.refreshCatalog();
  return { env, seen, market };
}
const mandates = async (env) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM mandates").first()).n;
const ARGS = { sku: "rice-50kg", quantity: 2, max_total: 170_000, deliver_within_hours: 48 };

for (const mode of ["network-error", "hang"]) {
  test(`one lost answer (${mode}): the client retries with the same secret and gets the same mandate`, LIMIT, async () => {
    const { env, seen, market } = await setup({ lose: 1, mode });
    const r = await market.negotiate(ARGS);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.agreement, true);
    assert.equal(seen.creates, 2, "one retry");
    assert.equal(seen.bodies[0], seen.bodies[1], "the retry is the same request");
    assert.equal(await mandates(env), 1, "one mandate on the arbiter");
  });
}

test("only the hash of the secret is sent; the secret is not in the page state", LIMIT, async () => {
  const { seen, market } = await setup({ lose: 0 });
  await market.negotiate(ARGS);
  const body = JSON.parse(seen.bodies[0]);
  assert.match(body.buyer_token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!seen.bodies[0].includes("bt_"), "the secret itself is not in the create request");
  assert.ok(!/bt_[A-Za-z0-9_-]{20,}/.test(JSON.stringify(market.getState())));
});

test("every answer lost: reported as unknown; asking again with the same terms recovers the same mandate", LIMIT, async () => {
  const { env, seen, market } = await setup({ lose: 2 });
  const first = await market.negotiate(ARGS);
  assert.equal(first.ok, false);
  assert.equal(first.unknown, true, JSON.stringify(first));
  assert.match(first.reason, /same terms/i);
  const second = await market.negotiate(ARGS);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(seen.creates, 3);
  assert.equal(new Set(seen.bodies).size, 1, "every attempt carried the same secret hash");
  assert.equal(await mandates(env), 1, "no daily attempt was used twice");
});

test("a new budget for the same terms is a new secret, and is refused as identical terms", LIMIT, async () => {
  const { env, market } = await setup({ lose: 2 });
  await market.negotiate(ARGS);
  const r = await market.negotiate({ ...ARGS, max_total: 180_000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "identical_terms");
  assert.equal(await mandates(env), 1);
});
