import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, checkListing, termsKey, canonicalJson } from "../src/mechanism.js";
import { Arbiter } from "../src/core.js";
import { memoryD1 } from "./sqlite-d1.mjs";

// ---------- pure mechanism ----------
const L = (vendor_id, o) => ({ vendor_id, sku: "rice-50kg", ask_cents: 9_000_000, floor_cents: 7_500_000, delivery_hours: 24, stock: 20, ...o });

test("midpoint of the zone of agreement", () => {
  const r = resolve({ sku: "rice-50kg", quantity: 2, max_total_cents: 17_000_000, deliver_within_hours: 48 }, [L("a")]);
  // lower 15,000,000, upper min(17,000,000, 18,000,000); step 160,000 (2.5% of 9,000,000 is 225,000
  // -> largest ₦100 × 2^k below it), g = 320,000: L' = 47g, U' = 53g, midpoint index 50 -> 16,000,000
  // (2.0.0 gave 15,750,000; 1.0.0 gave 16,000,000)
  assert.equal(r.offers[0].total_cents, 16_000_000);
  assert.equal(r.offers[0].saving_cents, 2_000_000);
});

test("budget above list price is capped at list price", () => {
  const r = resolve({ sku: "rice-50kg", quantity: 1, max_total_cents: 50_000_000, deliver_within_hours: 48 }, [L("a")]);
  // upper = list 9,000,000; g = 160,000: L' = 47g, U' = 56g -> index 51 = 8,160,000 (2.0.0: 8,325,000; 1.0.0: 8,250,000)
  assert.equal(r.offers[0].total_cents, 8_160_000);
});

test("no overlap, too slow or no stock gives no agreement and reveals nothing", () => {
  const m = { sku: "rice-50kg", quantity: 1, max_total_cents: 7_000_000, deliver_within_hours: 48 };
  const r = resolve(m, [L("a"), L("b", { floor_cents: 1, delivery_hours: 72 }), L("c", { floor_cents: 1, stock: 0 })]);
  assert.equal(r.agreement, false);
  assert.equal(r.considered, 3);
  assert.deepEqual(Object.keys(r).sort(), ["agreement", "considered", "mechanism", "offers"]);
  assert.ok(!JSON.stringify(r).includes("floor"));
});

test("offers ranked by price, then delivery, then vendor id", () => {
  const m = { sku: "rice-50kg", quantity: 1, max_total_cents: 9_000_000, deliver_within_hours: 48 };
  const r = resolve(m, [L("c"), L("b", { delivery_hours: 6 }), L("a", { floor_cents: 7_000_000 }), L("d")]);
  assert.deepEqual(r.offers.map((o) => o.vendor_id), ["a", "b", "c", "d"]);
});

test("vendor filter is respected", () => {
  const m = { sku: "rice-50kg", quantity: 1, max_total_cents: 9_000_000, deliver_within_hours: 48, vendor_ids: ["b"] };
  assert.deepEqual(resolve(m, [L("a"), L("b")]).offers.map((o) => o.vendor_id), ["b"]);
});

test("listing validation", () => {
  assert.deepEqual(checkListing(L("a")), []);
  assert.ok(checkListing(L("a", { floor_cents: 9_500_000 })).some((p) => p.includes("floor")));
  assert.ok(checkListing(L("a", { ask_cents: 1.5 })).length > 0);
});

test("terms key ignores budget and vendor order", () => {
  const a = termsKey({ sku: "x", quantity: 2, deliver_within_hours: 5, max_total_cents: 1, vendor_ids: ["b", "a"] });
  const b = termsKey({ sku: "x", quantity: 2, deliver_within_hours: 5, max_total_cents: 999, vendor_ids: ["a", "b"] });
  assert.equal(a, b);
});

test("canonical json sorts keys at every level", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } }), '{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}');
});

// ---------- service ----------
async function market() {
  let now = 1_800_000_000;
  const arb = new Arbiter(memoryD1(), { clock: () => now, allowGeneratedKey: true });
  const iya = await arb.createVendor({ name: "Iya Basira Foodstuff", origin: "https://iya-basira.example" });
  const chika = await arb.createVendor({ name: "Chika Provisions", origin: "https://chika.example" });
  const vI = await arb.vendorByKey(iya.api_key);
  const vC = await arb.vendorByKey(chika.api_key);
  await arb.upsertListing(vI, { sku: "rice-50kg", title: "Local parboiled rice, 50 kg bag", unit: "bag", ask_cents: 9_000_000, floor_cents: 7_800_000, delivery_hours: 24, stock: 5 });
  await arb.upsertListing(vC, { sku: "rice-50kg", title: "Ofada rice, 50 kg bag", unit: "bag", ask_cents: 8_800_000, floor_cents: 8_200_000, delivery_hours: 6, stock: 1 });
  return { arb, iya, chika, vI, vC, tick: (s) => { now += s; } };
}

test("catalog never exposes floors", async () => {
  const { arb } = await market();
  const c = await arb.catalog({ sku: "rice-50kg" });
  assert.equal(c.length, 2);
  assert.ok(!JSON.stringify(c).includes("floor"));
  assert.ok(!JSON.stringify(c).includes("7800000"));
});

test("full negotiation: mandate, resolve, accept, signed receipt, audit chain", async () => {
  const { arb } = await market();
  const { mandate_id, buyer_token } = await arb.createMandate(
    { sku: "rice-50kg", quantity: 1, max_total_cents: 8_600_000, deliver_within_hours: 48 },
    { buyerKey: "buyer-1", callerOrigin: "https://oja.example" });
  const out = await arb.resolveMandate(mandate_id, buyer_token);
  assert.equal(out.state, "RESOLVED");
  // Both steps 160,000 (2.5% is 225,000 and 220,000 -> ₦1,600). Iya: L' = 49 steps, U' = 53 -> 51 = 8,160,000
  // Chika: L' = 52, U' = 53 -> 52 = 8,320,000 (2.0.0: 8,100,000 / 8,360,000; 1.0.0: 8,200,000 / 8,400,000)
  assert.deepEqual(out.offers.map((o) => [o.vendor_name, o.total_cents]), [["Iya Basira Foodstuff", 8_160_000], ["Chika Provisions", 8_320_000]]);
  assert.deepEqual(out.offers.map((o) => [o.unit_step_cents, o.grid_step_cents]), [[160_000, 160_000], [160_000, 160_000]]);
  assert.ok(!JSON.stringify(out).includes("8600000"), "budget must not appear in the outcome");

  const again = await arb.resolveMandate(mandate_id, buyer_token);
  assert.deepEqual(again.offers.map((o) => o.offer_id), out.offers.map((o) => o.offer_id), "resolve is idempotent");

  const signed = await arb.acceptOffer(out.offers[0].offer_id, buyer_token);
  assert.equal(signed.receipt.total_cents, 8_160_000);
  assert.equal(signed.receipt.mechanism.version, "3.0.0");
  assert.equal(signed.receipt.grid_step_cents, 160_000);
  assert.equal(signed.receipt.caller_origin, "https://oja.example");
  assert.deepEqual(await arb.verifyReceipt(signed), { valid: true, recorded: true, receipt_id: signed.receipt.receipt_id });

  const forged = { ...signed, receipt: { ...signed.receipt, total_cents: 1 } };
  assert.equal((await arb.verifyReceipt(forged)).valid, false);

  const after = await arb.outcome(mandate_id);
  assert.equal(after.state, "SETTLED");
  assert.deepEqual(after.offers.map((o) => o.state), ["ACCEPTED", "VOID"]);
  assert.equal((await arb.catalog({ sku: "rice-50kg" })).find((r) => r.vendor_name.startsWith("Iya")).in_stock, true);

  const trail = await arb.auditTrail(mandate_id, buyer_token);
  assert.deepEqual(trail.map((e) => e.kind), ["MANDATE_CREATED", "BARGAINING_RESOLVED", "OFFER_ACCEPTED", "RECEIPT_ISSUED"]);
  assert.deepEqual((await arb.verifyChain()).ok, true);
});

test("cannot accept twice, with a wrong token, or after expiry", async () => {
  const { arb, tick } = await market();
  const a = await arb.createMandate({ sku: "rice-50kg", quantity: 1, max_total_cents: 9_000_000, deliver_within_hours: 48 }, { buyerKey: "b" });
  const out = await arb.resolveMandate(a.mandate_id, a.buyer_token);
  await assert.rejects(arb.acceptOffer(out.offers[0].offer_id, "bt_wrong"), { code: "not_found" });
  tick(15 * 60);
  await assert.rejects(arb.acceptOffer(out.offers[0].offer_id, a.buyer_token), { code: "offer_expired" });

  const b = await arb.createMandate({ sku: "rice-50kg", quantity: 1, max_total_cents: 9_000_000, deliver_within_hours: 47 }, { buyerKey: "b" });
  const o2 = await arb.resolveMandate(b.mandate_id, b.buyer_token);
  await arb.acceptOffer(o2.offers[0].offer_id, b.buyer_token);
  await assert.rejects(arb.acceptOffer(o2.offers[1].offer_id, b.buyer_token), { code: "already_settled" });
});

test("anti-probing: same terms with a new budget are refused, and attempts are capped per day", async () => {
  const { arb, tick } = await market();
  const base = { sku: "rice-50kg", quantity: 1, deliver_within_hours: 48 };
  await arb.createMandate({ ...base, max_total_cents: 7_000_000 }, { buyerKey: "prober" });
  await assert.rejects(arb.createMandate({ ...base, max_total_cents: 7_500_000 }, { buyerKey: "prober" }), { code: "identical_terms" });
  // The daily cap (MANDATE_CAP_DEFAULT): new deadlines are new terms, until the cap.
  const { MANDATE_CAP_DEFAULT: CAP } = await import("../src/core.js");
  for (let i = 1; i < CAP; i++) await arb.createMandate({ ...base, deliver_within_hours: 48 - i, max_total_cents: 7_500_000 + i }, { buyerKey: "prober" });
  await assert.rejects(arb.createMandate({ ...base, deliver_within_hours: 48 - CAP, max_total_cents: 7_700_000 }, { buyerKey: "prober" }), { code: "rate_limited" });
  tick(86_401);
  await arb.createMandate({ ...base, deliver_within_hours: 48 - CAP, max_total_cents: 7_700_000 }, { buyerKey: "prober" });
  // another buyer is unaffected
  await arb.createMandate({ ...base, max_total_cents: 7_000_000 }, { buyerKey: "someone-else" });
});

test("out-of-stock at acceptance voids the offer and reopens the mandate", async () => {
  const { arb, vC } = await market();
  const a = await arb.createMandate({ sku: "rice-50kg", quantity: 1, max_total_cents: 9_000_000, deliver_within_hours: 12 }, { buyerKey: "x" });
  const out = await arb.resolveMandate(a.mandate_id, a.buyer_token);
  assert.deepEqual(out.offers.map((o) => o.vendor_name), ["Chika Provisions"]);
  await arb.upsertListing(vC, { sku: "rice-50kg", title: "Ofada rice, 50 kg bag", unit: "bag", ask_cents: 8_800_000, floor_cents: 8_200_000, delivery_hours: 6, stock: 0 });
  await assert.rejects(arb.acceptOffer(out.offers[0].offer_id, a.buyer_token), { code: "out_of_stock" });
  assert.equal((await arb.outcome(a.mandate_id)).state, "RESOLVED");
});

test("tampering with the audit log is detected", async () => {
  const { arb } = await market();
  arb.db.raw.exec("UPDATE events SET payload = '{\"vendor_id\":\"evil\"}' WHERE seq = 2");
  assert.deepEqual(await arb.verifyChain(), { ok: false, broken_at: 2 });
});
