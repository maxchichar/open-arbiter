// F7: without ARBITER_SIGNING_JWK the arbiter fails closed, unless DEV is exactly "1".
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { Arbiter } from "../src/core.js";
import { memoryD1 } from "./sqlite-d1.mjs";

const ADMIN = "admin";

async function market(env) {
  const f = (path, { method = "GET", token, body } = {}) => worker.fetch(new Request(`https://arb.test${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env).then(async (r) => ({ status: r.status, data: await r.json() }));
  const v = await f("/v1/vendors", { method: "POST", token: ADMIN, body: { name: "Iya Basira" } });
  await f("/v1/listings", { method: "PUT", token: v.data.api_key, body: { sku: "rice-50kg", title: "Rice", unit: "bag", ask_cents: 9_000_000, floor_cents: 8_000_000, delivery_hours: 24, stock: 5 } });
  const m = await f("/v1/mandates", { method: "POST", body: { sku: "rice-50kg", quantity: 1, max_total_cents: 9_000_000, deliver_within_hours: 48 } });
  const out = await f(`/v1/mandates/${m.data.mandate_id}/resolve`, { method: "POST", token: m.data.buyer_token });
  return { f, m: m.data, offer: out.data.offers[0] };
}

const snapshot = async (db) => ({
  mandates: (await db.prepare("SELECT id, state FROM mandates").all()).results,
  stock: (await db.prepare("SELECT stock FROM listings").all()).results,
  offers: (await db.prepare("SELECT id, state FROM offers").all()).results,
  receipts: (await db.prepare("SELECT COUNT(*) AS n FROM receipts").first()).n,
  keys: (await db.prepare("SELECT COUNT(*) AS n FROM signing_keys").first()).n,
});

for (const dev of [undefined, "0", "true", "yes"]) {
  test(`no signing key and DEV=${dev}: key endpoints fail closed and nothing changes`, async () => {
    const env = { DB: memoryD1(), ADMIN_TOKEN: ADMIN, ...(dev === undefined ? {} : { DEV: dev }) };
    const { f, m, offer } = await market(env);
    const before = await snapshot(env.DB);

    const jwks = await f("/.well-known/jwks.json");
    assert.equal(jwks.status, 500);
    assert.equal(jwks.data.error, "misconfigured");

    const acc = await f(`/v1/offers/${offer.offer_id}/accept`, { method: "POST", token: m.buyer_token });
    assert.equal(acc.status, 500);
    assert.equal(acc.data.error, "misconfigured");

    const ver = await f("/v1/receipts/verify", { method: "POST", body: { receipt: { receipt_id: "rct_x" }, signature: "AAAA" } });
    assert.equal(ver.status, 500);
    assert.equal(ver.data.error, "misconfigured");

    assert.deepEqual(await snapshot(env.DB), before, "no mandate, stock, offer, receipt or key row may change");
    assert.equal(before.keys, 0, "no private key may be generated and stored");
  });
}

test("DEV=1 keeps the local behaviour: a key is generated, stored and used", async () => {
  const env = { DB: memoryD1(), ADMIN_TOKEN: ADMIN, DEV: "1" };
  const { f, m, offer } = await market(env);
  assert.equal((await f("/.well-known/jwks.json")).status, 200);
  const acc = await f(`/v1/offers/${offer.offer_id}/accept`, { method: "POST", token: m.buyer_token });
  assert.equal(acc.status, 200);
  assert.equal((await f("/v1/receipts/verify", { method: "POST", body: acc.data })).data.valid, true);
  assert.equal((await snapshot(env.DB)).keys, 1);
});

test("a configured signing key works without DEV and is never stored", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const env = { DB: memoryD1(), ADMIN_TOKEN: ADMIN, ARBITER_SIGNING_JWK: JSON.stringify(jwk) };
  const { f, m, offer } = await market(env);
  const acc = await f(`/v1/offers/${offer.offer_id}/accept`, { method: "POST", token: m.buyer_token });
  assert.equal(acc.status, 200);
  assert.equal((await f("/.well-known/jwks.json")).data.keys[0].x, jwk.x);
  assert.equal((await snapshot(env.DB)).keys, 0);
});

test("core: Arbiter without a key or allowGeneratedKey refuses to sign", async () => {
  const arb = new Arbiter(memoryD1());
  await assert.rejects(arb.key(), { code: "misconfigured", status: 500 });
  await assert.rejects(arb.jwks(), { code: "misconfigured" });
});
