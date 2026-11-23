// F3: the audit chain stays linear under concurrent writes; every business write commits
// together with its event or not at all; chain-head contention is retried, then 503.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Arbiter } from "../src/core.js";
import { memoryD1 } from "./sqlite-d1.mjs";
import { prng, replayable } from "./seeded.mjs";

const LISTING = { sku: "rice-50kg", title: "Rice, 50 kg bag", unit: "bag", ask_cents: 9_000_000, floor_cents: 8_000_000, delivery_hours: 24, stock: 50 };
const isEventInsert = (sql) => /INSERT INTO events/i.test(sql);
const prevHashConflict = () => new Error("UNIQUE constraint failed: events.prev_hash");

async function setup(db = memoryD1()) {
  const arb = new Arbiter(db, { allowGeneratedKey: true, random: prng() });
  const v = await arb.createVendor({ name: "Iya Basira" });
  const vendor = await arb.vendorByKey(v.api_key);
  await arb.upsertListing(vendor, LISTING);
  return { arb, db, vendor };
}
const count = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()).n;
const forks = (db) => count(db, "SELECT COUNT(*) AS n FROM (SELECT prev_hash FROM events GROUP BY prev_hash HAVING COUNT(*) > 1)");

test("concurrent writes of every kind keep one linear chain", replayable(async () => {
  const { arb, db, vendor } = await setup();
  const jobs = [];
  for (let i = 0; i < 12; i++) {
    jobs.push(arb.createVendor({ name: `V${i}` }));
    jobs.push(arb.upsertListing(vendor, { ...LISTING, sku: `item-${i}` }));
    jobs.push(arb.createMandate({ sku: "rice-50kg", quantity: 1, max_total_cents: 9_000_000, deliver_within_hours: 100 + i }, { buyerKey: `b${i}` }));
  }
  const settled = await Promise.allSettled(jobs);
  assert.deepEqual(settled.filter((s) => s.status === "rejected").map((s) => s.reason?.message), []);
  assert.equal(await forks(db), 0, "no two events may share a prev_hash");
  assert.equal((await arb.verifyChain()).ok, true);
}));

test("concurrent resolves of one mandate: one set of offers, one event, same outcome", replayable(async () => {
  const { arb, db } = await setup();
  const m = await arb.createMandate({ sku: "rice-50kg", quantity: 1, max_total_cents: 9_000_000, deliver_within_hours: 48 }, { buyerKey: "b" });
  const outs = await Promise.all(Array.from({ length: 6 }, () => arb.resolveMandate(m.mandate_id, m.buyer_token)));
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM offers WHERE mandate_id = ?", m.mandate_id), 1);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM events WHERE mandate_id = ? AND kind = 'BARGAINING_RESOLVED'", m.mandate_id), 1);
  for (const o of outs) assert.deepEqual(o.offers.map((x) => x.offer_id), outs[0].offers.map((x) => x.offer_id));
  assert.equal((await arb.verifyChain()).ok, true);
}));

test("chain-head conflicts are retried with a fresh head", replayable(async () => {
  const { arb, db } = await setup();
  let conflicts = 0;
  db.setFault((sql) => (isEventInsert(sql) && conflicts < 3 ? (conflicts++, prevHashConflict()) : false));
  const v = await arb.createVendor({ name: "After three conflicts" });
  db.setFault(null);
  assert.equal(conflicts, 3);
  assert.ok(v.vendor_id);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM vendors WHERE id = ?", v.vendor_id), 1);
  assert.equal((await arb.verifyChain()).ok, true);
}));

test("when retries run out: 503 busy, and the business write is not committed", replayable(async () => {
  const { arb, db } = await setup();
  db.setFault((sql) => (isEventInsert(sql) ? prevHashConflict() : false));
  await assert.rejects(arb.createVendor({ name: "Never" }), { code: "busy", status: 503 });
  db.setFault(null);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM vendors WHERE name = 'Never'"), 0);
}));

// A failure on the event insert must take the business row with it, for every writer.
const writers = {
  createVendor: async ({ arb }) => arb.createVendor({ name: "Rolled back" }),
  upsertListing: async ({ arb, vendor }) => arb.upsertListing(vendor, { ...LISTING, sku: "rolled-back" }),
  createMandate: async ({ arb }) => arb.createMandate({ sku: "rice-50kg", quantity: 7, max_total_cents: 9_000_000, deliver_within_hours: 48 }, { buyerKey: "rb" }),
};
const rows = async (db) => ({
  vendors: await count(db, "SELECT COUNT(*) AS n FROM vendors"),
  listings: await count(db, "SELECT COUNT(*) AS n FROM listings"),
  mandates: await count(db, "SELECT COUNT(*) AS n FROM mandates"),
  offers: await count(db, "SELECT COUNT(*) AS n FROM offers"),
  states: (await db.prepare("SELECT state FROM mandates ORDER BY id").all()).results.map((r) => r.state).join(","),
  events: await count(db, "SELECT COUNT(*) AS n FROM events"),
});
for (const [name, write] of Object.entries(writers)) {
  test(`${name}: a failed event insert rolls back the business write`, replayable(async () => {
    const ctx = await setup();
    const before = await rows(ctx.db);
    ctx.db.setFault((sql) => isEventInsert(sql));
    await assert.rejects(write(ctx));
    ctx.db.setFault(null);
    assert.deepEqual(await rows(ctx.db), before);
  }));
}

test("resolveMandate: a failed event insert leaves the mandate OPEN with no offers", replayable(async () => {
  const ctx = await setup();
  const m = await ctx.arb.createMandate({ sku: "rice-50kg", quantity: 1, max_total_cents: 9_000_000, deliver_within_hours: 48 }, { buyerKey: "b" });
  const before = await rows(ctx.db);
  ctx.db.setFault((sql) => isEventInsert(sql));
  await assert.rejects(ctx.arb.resolveMandate(m.mandate_id, m.buyer_token));
  ctx.db.setFault(null);
  assert.deepEqual(await rows(ctx.db), before);
  const out = await ctx.arb.resolveMandate(m.mandate_id, m.buyer_token);
  assert.equal(out.state, "RESOLVED", "a later resolve still works");
}));
