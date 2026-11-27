// Owner, 2026-11-27: the daily negotiation cap per item per IP is an environment setting
// (MANDATES_PER_ITEM_PER_DAY), 20 by default and in staging and production. It is load protection:
// the price leakage bound does not depend on it (mechanism.test.mjs, "cap: 20 deals"). The
// identical-terms lock is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import * as core from "../src/core.js";
import { generateSigningKey } from "../src/crypto.js";
import { memoryD1 } from "./sqlite-d1.mjs";

async function setup(extra = {}) {
  const { privateJwk } = await generateSigningKey();
  const DB = memoryD1();
  const arb = new core.Arbiter(DB, { signingJwk: privateJwk });
  const v = await arb.createVendor({ name: "V" });
  await arb.upsertListing(await arb.vendorByKey(v.api_key), { sku: "rice-50kg", title: "Rice", unit: "bag", ask_cents: 9_000_000, floor_cents: 7_800_000, delivery_hours: 24, stock: 500 });
  return { DB, ADMIN_TOKEN: "a", BUYER_SALT: "s", ENVIRONMENT: "staging", IP_LIMIT_PER_60S: "100000", ARBITER_SIGNING_JWK: JSON.stringify(privateJwk), ...extra };
}
const create = (env, q, ip = "192.0.2.10", extra = {}) => worker.fetch(new Request("https://arb.test/v1/mandates", {
  method: "POST", headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
  body: JSON.stringify({ sku: "rice-50kg", quantity: q, max_total_cents: 9_000_000 * q, deliver_within_hours: 48, ...extra }),
}), env);

test("the default cap is 20 per item per IP per day", async () => {
  assert.equal(core.MANDATE_CAP_DEFAULT, 20);
  const env = await setup();
  for (let q = 1; q <= 20; q++) assert.equal((await create(env, q)).status, 201, `negotiation ${q}`);
  const over = await create(env, 21);
  assert.equal(over.status, 429);
  const body = await over.json();
  assert.equal(body.error, "rate_limited");
  assert.match(body.message, /20 negotiations per item per day/);
  assert.doesNotMatch(body.message, /mapping a seller's floor/, "the cap is load protection, not price privacy");
  assert.equal((await create(env, 22, "192.0.2.11")).status, 201, "another address has its own allowance");
});

test("MANDATES_PER_ITEM_PER_DAY sets the cap; an unusable value falls back to 20", async () => {
  const env = await setup({ MANDATES_PER_ITEM_PER_DAY: "2" });
  assert.equal((await create(env, 1)).status, 201);
  assert.equal((await create(env, 2)).status, 201);
  assert.equal((await create(env, 3)).status, 429);
  for (const bad of ["0", "-1", "x", "1.5", "100000"]) {
    const e = await setup({ MANDATES_PER_ITEM_PER_DAY: bad });
    for (let q = 1; q <= 20; q++) assert.equal((await create(e, q)).status, 201, `${bad}: negotiation ${q}`);
    assert.equal((await create(e, 21)).status, 429, `${bad}: falls back to 20`);
  }
});

test("the identical-terms lock is unchanged, far below the cap", async () => {
  const env = await setup();
  assert.equal((await create(env, 1)).status, 201);
  const again = await create(env, 1, "192.0.2.10", { max_total_cents: 8_000_000 });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, "identical_terms", "changing only the budget is still refused");
});

test("GET / publishes the limits an agent needs", async () => {
  const env = await setup({ MANDATES_PER_ITEM_PER_DAY: "7" });
  const d = await (await worker.fetch(new Request("https://arb.test/", { headers: { "cf-connecting-ip": "192.0.2.12" } }), env)).json();
  assert.deepEqual(d.limits, { negotiations_per_item_per_day: 7, requests_per_ip_per_minute: 100000, catalog_page_max: 100 });
});
