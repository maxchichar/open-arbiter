// F2: the anti-probing limits hold under concurrency.
//  - at most the daily cap (MANDATE_CAP_DEFAULT, 20) of mandates per buyer per sku, however many
//    arrive at once
//  - identical terms (same buyer, sku, quantity, deadline, sellers) succeed once; every other
//    attempt is a clean 409 identical_terms, never a raw database error
import { test } from "node:test";
import assert from "node:assert/strict";
import { Arbiter, MANDATE_CAP_DEFAULT as CAP } from "../src/core.js";
import { memoryD1 } from "./sqlite-d1.mjs";
import { prng, replayable } from "./seeded.mjs";

const arbiter = () => {
  const db = memoryD1();
  return { db, arb: new Arbiter(db, { allowGeneratedKey: true, random: prng() }) };
};
const count = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).first()).n;
const codes = (settled) => settled.reduce((m, s) => {
  const k = s.status === "fulfilled" ? "ok" : (s.reason?.code ?? `raw: ${s.reason?.message}`);
  return { ...m, [k]: (m[k] || 0) + 1 };
}, {});

test(`${CAP + 5} concurrent mandates, distinct terms: at most the cap (${CAP}) succeed, the rest are rate limited`, replayable(async () => {
  for (let round = 0; round < 5; round++) {
    const { db, arb } = arbiter();
    const settled = await Promise.allSettled(Array.from({ length: CAP + 5 }, (_, i) => arb.createMandate(
      { sku: "rice-50kg", quantity: i + 1, max_total_cents: 9_000_000, deliver_within_hours: 48 }, { buyerKey: "prober" })));
    const c = codes(settled);
    assert.deepEqual(c, { ok: CAP, rate_limited: 5 }, `round ${round}: ${JSON.stringify(c)}`);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mandates"), CAP);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM events WHERE kind = 'MANDATE_CREATED'"), CAP, "one event per created mandate, none for refusals");
    assert.equal((await arb.verifyChain()).ok, true);
  }
}));

test("5 concurrent identical terms: one succeeds, four get identical_terms", replayable(async () => {
  for (let round = 0; round < 5; round++) {
    const { db, arb } = arbiter();
    const settled = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => arb.createMandate(
      { sku: "rice-50kg", quantity: 2, max_total_cents: 9_000_000 + i, deliver_within_hours: 48 }, { buyerKey: "prober" })));
    const c = codes(settled);
    assert.deepEqual(c, { ok: 1, identical_terms: 4 }, `round ${round}: ${JSON.stringify(c)}`);
    for (const s of settled.filter((x) => x.status === "rejected")) assert.equal(s.reason.status, 409);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mandates"), 1);
  }
}));

test("a refused mandate writes no row and no event", replayable(async () => {
  const { db, arb } = arbiter();
  const base = { sku: "rice-50kg", max_total_cents: 9_000_000, deliver_within_hours: 48 };
  for (let q = 1; q <= CAP; q++) await arb.createMandate({ ...base, quantity: q }, { buyerKey: "b" });
  const before = await count(db, "SELECT COUNT(*) AS n FROM events");
  await assert.rejects(arb.createMandate({ ...base, quantity: CAP + 1 }, { buyerKey: "b" }), { code: "rate_limited", status: 429 });
  await assert.rejects(arb.createMandate({ ...base, quantity: 1 }, { buyerKey: "b" }), { code: "rate_limited" }, "over the cap, the cap is reported first (as before)");
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM mandates"), CAP);
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM events"), before);
}));

test("identical terms under the cap give identical_terms; other buyers are unaffected", replayable(async () => {
  const { arb } = arbiter();
  const m = { sku: "rice-50kg", quantity: 1, max_total_cents: 9_000_000, deliver_within_hours: 48 };
  await arb.createMandate(m, { buyerKey: "b" });
  await assert.rejects(arb.createMandate({ ...m, max_total_cents: 9_500_000 }, { buyerKey: "b" }), { code: "identical_terms", status: 409 });
  await arb.createMandate(m, { buyerKey: "someone-else" });
}));
