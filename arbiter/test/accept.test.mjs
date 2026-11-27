// F4: accepting an offer is all-or-nothing.
//  - a fault at any statement of the accept leaves no settled mandate without a receipt and
//    no stock change without settlement (everything rolls back)
//  - concurrent accepts on one mandate produce exactly one receipt and one stock decrement
//  - the stock CHECK constraint is what refuses overselling, mapped to out_of_stock
//  - the receipt names the committed OFFER_ACCEPTED event, even after a chain retry
import { test } from "node:test";
import assert from "node:assert/strict";
import { Arbiter } from "../src/core.js";
import { verifyPayload } from "../src/crypto.js";
import { memoryD1 } from "./sqlite-d1.mjs";
import { prng, replayable } from "./seeded.mjs";

const LISTING = { sku: "rice-50kg", title: "Rice, 50 kg bag", unit: "bag", ask_cents: 9_000_000, floor_cents: 8_000_000, delivery_hours: 24, stock: 5 };

async function market() {
  const db = memoryD1();
  const arb = new Arbiter(db, { allowGeneratedKey: true, random: prng() });
  const vendors = [];
  for (const name of ["Iya Basira", "Chika"]) {
    const v = await arb.createVendor({ name });
    const vendor = await arb.vendorByKey(v.api_key);
    await arb.upsertListing(vendor, LISTING);
    vendors.push(vendor);
  }
  const m = await arb.createMandate({ sku: "rice-50kg", quantity: 2, max_total_cents: 18_000_000, deliver_within_hours: 48 }, { buyerKey: "b" });
  const out = await arb.resolveMandate(m.mandate_id, m.buyer_token);
  assert.equal(out.offers.length, 2);
  return { db, arb, vendors, m, offers: out.offers };
}

const snapshot = async (db, mandateId) => ({
  mandate: (await db.prepare("SELECT state FROM mandates WHERE id = ?").bind(mandateId).first()).state,
  stock: (await db.prepare("SELECT vendor_id, stock FROM listings ORDER BY vendor_id").all()).results.map((r) => r.stock),
  offers: (await db.prepare("SELECT state FROM offers WHERE mandate_id = ? ORDER BY rank").bind(mandateId).all()).results.map((r) => r.state),
  receipts: (await db.prepare("SELECT COUNT(*) AS n FROM receipts").first()).n,
  events: (await db.prepare("SELECT COUNT(*) AS n FROM events").first()).n,
});

/**
 * Cross-table invariants that must hold after any accept attempt, successful or not.
 * baseStock: total stock before any accept (defaults to both listings' initial stock).
 */
async function assertConsistent(db, mandateId, baseStock = 2 * LISTING.stock) {
  const s = await snapshot(db, mandateId);
  const settled = s.mandate === "SETTLED";
  assert.equal(settled, s.receipts === 1, `settled mandate ⇔ receipt (state ${s.mandate}, receipts ${s.receipts})`);
  assert.equal(settled, s.offers.includes("ACCEPTED"), "settled mandate ⇔ an accepted offer");
  const sold = baseStock - s.stock.reduce((a, b) => a + b, 0);
  assert.equal(sold, settled ? 2 : 0, "stock moves only with settlement, by exactly the quantity");
}

// Each statement the accept writes, by the SQL that identifies it.
const POINTS = {
  "settle mandate": (sql) => /UPDATE mandates SET state = 'SETTLED'/.test(sql),
  "decrement stock": (sql) => /UPDATE listings SET stock = stock -/.test(sql),
  "accept/void offers": (sql) => /UPDATE offers SET state = CASE/.test(sql),
  "insert receipt": (sql) => /INSERT INTO receipts/.test(sql),
  "event OFFER_ACCEPTED": "event#1",
  "event RECEIPT_ISSUED": "event#2",
};

for (const [point, match] of Object.entries(POINTS)) {
  test(`fault at "${point}": nothing of the accept is committed, and a later accept works`, replayable(async () => {
    const { db, arb, m, offers } = await market();
    const before = await snapshot(db, m.mandate_id);
    let events = 0;
    db.setFault((sql) => {
      if (typeof match === "function") return match(sql);
      if (/INSERT INTO events/.test(sql)) return ++events === Number(match.split("#")[1]);
      return false;
    });
    await assert.rejects(arb.acceptOffer(offers[0].offer_id, m.buyer_token));
    db.setFault(null);
    assert.deepEqual(await snapshot(db, m.mandate_id), before, "no partial writes");
    await assertConsistent(db, m.mandate_id);
    const ok = await arb.acceptOffer(offers[0].offer_id, m.buyer_token);
    assert.equal(ok.receipt.offer_id, offers[0].offer_id);
    await assertConsistent(db, m.mandate_id);
    assert.equal((await arb.verifyChain()).ok, true);
  }));
}

test("concurrent accepts of the same offer: exactly one receipt", replayable(async () => {
  const { db, arb, m, offers } = await market();
  const settled = await Promise.allSettled(Array.from({ length: 5 }, () => arb.acceptOffer(offers[0].offer_id, m.buyer_token)));
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
  for (const s of settled.filter((x) => x.status === "rejected")) assert.equal(s.reason.code, "already_settled", s.reason.message);
  await assertConsistent(db, m.mandate_id);
  assert.equal((await arb.verifyChain()).ok, true);
}));

test("concurrent accepts of different offers on one mandate: exactly one receipt", replayable(async () => {
  const { db, arb, m, offers } = await market();
  const settled = await Promise.allSettled([0, 1, 0, 1].map((i) => arb.acceptOffer(offers[i].offer_id, m.buyer_token)));
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
  await assertConsistent(db, m.mandate_id);
  assert.equal((await arb.verifyChain()).ok, true);
}));

test("the schema refuses negative stock (CHECK stock_nonneg)", async () => {
  const { db } = await market();
  await assert.rejects(db.prepare("UPDATE listings SET stock = -1").run(), /CHECK constraint failed: stock_nonneg/);
});

test("out of stock at acceptance: 409 out_of_stock, offer VOID, mandate RESOLVED, nothing else changed", replayable(async () => {
  const { db, arb, vendors, m, offers } = await market();
  const target = offers.find((o) => o.vendor_id === vendors[0].id);
  await arb.upsertListing(vendors[0], { ...LISTING, stock: 1 }); // the offer is for 2
  const before = await snapshot(db, m.mandate_id);
  await assert.rejects(arb.acceptOffer(target.offer_id, m.buyer_token), { code: "out_of_stock", status: 409 });
  const after = await snapshot(db, m.mandate_id);
  assert.equal(after.mandate, "RESOLVED");
  assert.deepEqual(after.stock, before.stock);
  assert.equal(after.receipts, 0);
  assert.equal(after.events, before.events, "a refused accept writes no audit event");
  const states = Object.fromEntries((await db.prepare("SELECT id, state FROM offers").all()).results.map((r) => [r.id, r.state]));
  assert.equal(states[target.offer_id], "VOID");
  const other = offers.find((o) => o !== target);
  assert.equal(states[other.offer_id], "OPEN");
  await arb.acceptOffer(other.offer_id, m.buyer_token); // the buyer can still take the other offer
  await assertConsistent(db, m.mandate_id, before.stock.reduce((a, b) => a + b, 0));
}));

test("a mandate that is neither RESOLVED nor SETTLED cannot be settled through a stale offer", replayable(async () => {
  const { db, arb, m, offers } = await market();
  db.raw.exec(`UPDATE mandates SET state = 'NO_AGREEMENT' WHERE id = '${m.mandate_id}'`);
  const before = await snapshot(db, m.mandate_id);
  await assert.rejects(arb.acceptOffer(offers[0].offer_id, m.buyer_token), (e) => e.status === 409);
  assert.deepEqual(await snapshot(db, m.mandate_id), before);
}));

test("the receipt names the committed OFFER_ACCEPTED event, even after a chain retry", replayable(async () => {
  const { db, arb, m, offers } = await market();
  let conflicts = 0;
  db.setFault((sql) => (/INSERT INTO events/.test(sql) && conflicts < 2 ? (conflicts++, new Error("UNIQUE constraint failed: events.prev_hash")) : false));
  const r = await arb.acceptOffer(offers[0].offer_id, m.buyer_token);
  db.setFault(null);
  assert.equal(conflicts, 2);
  const ev = await db.prepare("SELECT hash FROM events WHERE mandate_id = ? AND kind = 'OFFER_ACCEPTED'").bind(m.mandate_id).first();
  assert.equal(r.receipt.audit_hash, ev.hash);
  assert.equal(await verifyPayload((await arb.jwks()).keys[0], r.receipt, r.signature), true);
  const stored = await arb.getReceipt(r.receipt.receipt_id);
  assert.deepEqual(stored.receipt, r.receipt);
}));

// R6 (P1.2 AC-2.5): a mandate SETTLED with no receipt, as the pre-Phase-0 non-atomic accept could
// leave one, must never be settled by a later accept. The batch's later statements require that
// this attempt settled the mandate (mandates.settle_attempt = this receipt id), not only that the
// mandate is SETTLED without a receipt. The legacy row is written in the instant between the
// accept's reads and its batch, so the early "already settled" check cannot catch it.
test("R6: a legacy SETTLED-without-receipt mandate is not settled by a later accept (batch-level)", replayable(async () => {
  const { db, arb, m, offers } = await market();
  let injected = false;
  db.setFault((sql) => {
    if (!injected && /UPDATE mandates SET state = 'SETTLED'/.test(sql)) {
      injected = true;
      db.raw.exec(`UPDATE mandates SET state = 'SETTLED' WHERE id = '${m.mandate_id}'`); // legacy: no receipt, no marker
    }
    return false;
  });
  const before = await snapshot(db, m.mandate_id);
  await assert.rejects(arb.acceptOffer(offers[0].offer_id, m.buyer_token), (e) => e.status === 409 && e.code === "already_settled");
  db.setFault(null);
  const after = await snapshot(db, m.mandate_id);
  assert.ok(injected);
  assert.deepEqual(after.stock, before.stock, "no stock taken");
  assert.equal(after.receipts, 0, "no receipt for a mandate this accept did not settle");
  assert.deepEqual(after.offers, before.offers, "offers unchanged");
  assert.equal(after.events, before.events, "no audit event");
}));

test("R6: the accept records which attempt settled the mandate", replayable(async () => {
  const { db, arb, m, offers } = await market();
  const r = await arb.acceptOffer(offers[0].offer_id, m.buyer_token);
  const row = await db.prepare("SELECT state, settle_attempt FROM mandates WHERE id = ?").bind(m.mandate_id).first();
  assert.deepEqual({ ...row }, { state: "SETTLED", settle_attempt: r.receipt.receipt_id });
}));
