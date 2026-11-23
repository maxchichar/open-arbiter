// F4 (client): an accept whose response never arrives has an UNKNOWN outcome. It is reported
// as unknown (never as "refused, nothing changed"), it is never retried automatically, and the
// page refuses a second accept of that offer until a read shows the real state.
// Here the request reaches the real arbiter (which settles it); only the response is lost.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../../../arbiter/src/index.js";
import { memoryD1 } from "../../../arbiter/test/sqlite-d1.mjs";
import { ArbiterClient } from "../js/arbiter-client.js";
import { Market, App } from "../js/market.js";
import { registerActions } from "../site-actions.js";
import { ActionRegistry } from "../runtime/actions.js";

const LIMIT = { timeout: 4000 }; // the old client waits forever on a lost response

/** A fetch that lets the arbiter process every request, then loses accept responses. */
function lossyArbiter(mode) {
  const env = { DB: memoryD1(), ADMIN_TOKEN: "admin", DEV: "1" };
  const calls = { accept: 0 };
  const fetchImpl = async (url, init = {}) => {
    const res = await worker.fetch(new Request(url, init), env);
    if (!/\/v1\/offers\/[^/]+\/accept$/.test(new URL(url).pathname)) return res;
    calls.accept++;
    if (mode === "network-error") throw new TypeError("fetch failed");
    // "hang": the response never comes; like real fetch, abort rejects the promise.
    return new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });
  };
  return { env, calls, fetchImpl };
}

async function setup(mode) {
  const a = lossyArbiter(mode);
  const f = (path, init) => a.fetchImpl(`https://arb.test${path}`, init);
  const reg = await (await f("/v1/vendors", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ name: "Iya Basira" }) })).json();
  await f("/v1/listings", { method: "PUT", headers: { authorization: `Bearer ${reg.api_key}`, "content-type": "application/json" }, body: JSON.stringify({ sku: "rice-50kg", title: "Rice, 50 kg bag", unit: "bag", ask_cents: 9_200_000, floor_cents: 8_100_000, delivery_hours: 24, stock: 3 }) });
  const client = new ArbiterClient("https://arb.test", { fetchImpl: a.fetchImpl, timeoutMs: 150 });
  const market = new Market(client);
  await market.refreshCatalog();
  const neg = await market.negotiate({ sku: "rice-50kg", quantity: 1, max_total: 90_000, deliver_within_hours: 48 });
  assert.equal(neg.ok, true);
  return { ...a, client, market, offerId: neg.offers[0].offer_id, mandateId: neg.mandate_id };
}
const receiptsOnServer = async (env) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM receipts").first()).n;

for (const mode of ["hang", "network-error"]) {
  test(`ArbiterClient.accept, response lost (${mode}): unknown, sent once`, LIMIT, async () => {
    const { client, calls, env, offerId } = await setup(mode);
    const r = await client.accept(offerId);
    assert.equal(r.ok, false);
    assert.equal(r.unknown, true, `must be reported as unknown, got ${JSON.stringify(r)}`);
    assert.match(r.reason, /unknown/i);
    assert.equal(calls.accept, 1, "never retried");
    assert.equal(await receiptsOnServer(env), 1, "the arbiter did settle it");
  });

  test(`Market.acceptOffer, response lost (${mode}): throws unknown, blocks re-accept until a read`, LIMIT, async () => {
    const { market, calls, offerId } = await setup(mode);
    await assert.rejects(market.acceptOffer({ offer_id: offerId }), /unknown/i);
    assert.equal(calls.accept, 1, "never retried");
    const shown = market.getState().negotiations[0].offers[0];
    assert.equal(shown.state, "UNKNOWN");
    const again = market.checkAccept({ offer_id: offerId });
    assert.equal(again.ok, false, "a second accept must be refused while the outcome is unknown");
    assert.match(again.reason, /unknown/i);
    // A read is not a retry: it shows what really happened.
    await market.refreshCatalog();
    const state = market.getState();
    assert.equal(state.negotiations[0].state, "SETTLED");
    assert.equal(state.negotiations[0].offers[0].state, "ACCEPTED");
    assert.equal(state.receipts.length, 1, "the settled receipt is picked up");
    assert.equal(state.receipts[0].signature_verified_in_browser, true);
    assert.equal(market.checkAccept({ offer_id: offerId }).ok, false);
    assert.equal(calls.accept, 1);
  });
}

test("through the runtime: a lost accept response is a receipt with status unknown, run once", LIMIT, async () => {
  const { market, calls, offerId } = await setup("hang");
  const saved = App.page;
  App.page = market;
  try {
    const registry = new ActionRegistry();
    const scope = { base: "https://oja.test/", network: "oja_market" };
    registerActions({ register: (d) => registry.register(scope, d) });
    const ref = [...registry.entries.keys()].find((k) => k.endsWith("#accept_offer"));
    const plan = registry.prepare({ kind: "action", action: ref, arguments: { offer_id: offerId } });
    const receipts = await registry.execute(plan, async () => true, "inv-1");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, "unknown", JSON.stringify(receipts[0]));
    assert.equal(calls.accept, 1);
  } finally {
    App.page = saved;
  }
});
