// Page-level rules, with the real ArbiterClient running against the real arbiter core
// (in-memory SQLite) through a fetch shim. No browser or network needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Market } from "../js/market.js";
import { ArbiterClient } from "../js/arbiter-client.js";
import worker from "../../../arbiter/src/index.js";
import { memoryD1 } from "../../../arbiter/test/sqlite-d1.mjs";
import { generateSigningKey, keyId } from "../../../arbiter/src/crypto.js";

async function signingKey() {
  const { privateJwk, publicJwk } = await generateSigningKey();
  return { privateJwk, pub: { kid: await keyId(publicJwk), kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y } };
}
import { registerActions } from "../site-actions.js";

async function setup() {
  // A deployed arbiter's receipts verify only against a key pinned in the page (F6), so this test
  // arbiter has a fixed signing key and the client pins its public half.
  const { privateJwk, pub } = await signingKey();
  const env = { DB: memoryD1(), ADMIN_TOKEN: "admin", ARBITER_SIGNING_JWK: JSON.stringify(privateJwk) };
  const fetchImpl = (url, init = {}) => worker.fetch(new Request(url, init), env);
  const reg = await (await fetchImpl("https://arb.test/v1/vendors", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ name: "Iya Basira Foodstuff", origin: "https://iya.test" }) })).json();
  await fetchImpl("https://arb.test/v1/listings", { method: "PUT", headers: { authorization: `Bearer ${reg.api_key}`, "content-type": "application/json" }, body: JSON.stringify({ sku: "rice-50kg", title: "Rice, 50 kg bag", unit: "bag", ask_cents: 9_200_000, floor_cents: 8_100_000, delivery_hours: 24, stock: 3 }) });
  const m = new Market(new ArbiterClient("https://arb.test", { fetchImpl, pinnedKeys: [pub] }));
  await m.refreshCatalog();
  return m;
}

test("negotiate, accept and verify through the page; budget and tokens never in state", async () => {
  const m = await setup();
  const neg = await m.negotiate({ sku: "rice-50kg", quantity: 2, max_total: 171_717, deliver_within_hours: 48 });
  assert.equal(neg.ok, true);
  // floor 162,000 and max 171,717 on a ₦4,600 step (2.5% of ₦92,000 × 2): 36 steps = ₦165,600
  // (mechanism 1.0.0 gave the raw midpoint, ₦166,858.50)
  assert.equal(neg.offers[0].total, 165_600);
  const acc = await m.acceptOffer({ offer_id: neg.offers[0].offer_id });
  assert.equal(acc.ok, true);
  assert.equal(acc.signature_verified_in_browser, true);
  const state = JSON.stringify(m.getState());
  assert.ok(!state.includes("171717") && !state.includes("171,717"), "budget leaked into state");
  assert.ok(!/bt_[A-Za-z0-9_-]{20,}/.test(state), "buyer token leaked into state");
  assert.ok(!state.includes("8100000") && !state.includes("81000"), "floor leaked into state");
  const v = await m.verifyReceipt({ receipt_id: acc.receipt_id });
  assert.equal(v.valid, true);
});

test("page checks refuse bad input before anything is sent", async () => {
  const m = await setup();
  assert.equal(m.checkNegotiation({ sku: "caviar", quantity: 1, max_total: 1, deliver_within_hours: 1 }).ok, false);
  assert.equal(m.checkNegotiation({ sku: "rice-50kg", quantity: 0, max_total: 1, deliver_within_hours: 1 }).field, "quantity");
  assert.equal(m.checkAccept({ offer_id: "off_nope" }).ok, false);
  assert.equal((await m.acceptOffer({ offer_id: "off_nope" })).ok, false);
});

test("repeat terms are refused with the arbiter's reason", async () => {
  const m = await setup();
  await m.negotiate({ sku: "rice-50kg", quantity: 1, max_total: 50_000, deliver_within_hours: 24 });
  const again = await m.negotiate({ sku: "rice-50kg", quantity: 1, max_total: 90_000, deliver_within_hours: 24 });
  assert.equal(again.ok, false);
  assert.match(again.reason, /already negotiated/);
});

test("actions use only schema keywords the runtime supports, and binding ones are irreversible", async () => {
  const { checkSchema } = await import("../runtime/actions.js");
  const defs = [];
  registerActions({ register: (d) => defs.push(d) });
  for (const d of defs) checkSchema(d.inputSchema);
  const effects = Object.fromEntries(defs.map((d) => [d.name, d.effect]));
  assert.deepEqual(effects, { get_market_state: "read", negotiate: "irreversible", accept_offer: "irreversible", verify_receipt: "read" });
});
