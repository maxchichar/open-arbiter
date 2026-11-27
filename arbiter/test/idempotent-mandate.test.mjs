// P0.10: negotiate survives a lost response. The client makes the buyer secret and sends only its
// SHA-256; a retry with the same secret and the same terms (budget included) returns the existing
// mandate instead of a new one, a 409 or a 429. The daily cap and identical-terms rule still hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Arbiter } from "../src/core.js";
import { sha256Hex, newToken } from "../src/crypto.js";
import worker from "../src/index.js";
import { memoryD1 } from "./sqlite-d1.mjs";
import { prng, replayable } from "./seeded.mjs";

const TERMS = { sku: "rice-50kg", quantity: 2, max_total_cents: 17_000_000, deliver_within_hours: 48 };
const count = async (db, table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

async function setup() {
  const db = memoryD1();
  const arb = new Arbiter(db, { allowGeneratedKey: true, random: prng() });
  const v = await arb.createVendor({ name: "Iya Basira" });
  await arb.upsertListing(await arb.vendorByKey(v.api_key), { sku: "rice-50kg", title: "Rice", unit: "bag", ask_cents: 9_000_000, floor_cents: 7_500_000, delivery_hours: 24, stock: 9 });
  return { db, arb };
}
const secret = async () => { const token = newToken("bt"); return { token, hash: await sha256Hex(token) }; };

test("a client-made secret: only its hash is sent, and the secret then works as the buyer token", async () => {
  const { arb } = await setup();
  const s = await secret();
  const m = await arb.createMandate({ ...TERMS, buyer_token_hash: s.hash }, { buyerKey: "b" });
  assert.equal(m.buyer_token, undefined, "the arbiter cannot return a secret it never saw");
  assert.equal(m.replayed, false);
  const out = await arb.resolveMandate(m.mandate_id, s.token);
  assert.equal(out.agreement, true);
});

test("a retry with the same secret and terms returns the same mandate: no new row, no new event", async () => {
  const { db, arb } = await setup();
  const s = await secret();
  const a = await arb.createMandate({ ...TERMS, buyer_token_hash: s.hash }, { buyerKey: "b" });
  const events = await count(db, "events");
  const b = await arb.createMandate({ ...TERMS, buyer_token_hash: s.hash }, { buyerKey: "b" });
  assert.equal(b.mandate_id, a.mandate_id);
  assert.equal(b.replayed, true);
  assert.equal(await count(db, "mandates"), 1);
  assert.equal(await count(db, "events"), events);
  // Also after it was resolved, and from a new IP (the buyer key changes with the network).
  await arb.resolveMandate(a.mandate_id, s.token);
  const c = await arb.createMandate({ ...TERMS, buyer_token_hash: s.hash }, { buyerKey: "other-ip" });
  assert.equal(c.mandate_id, a.mandate_id);
  assert.equal(c.state, "RESOLVED");
  assert.equal(await count(db, "mandates"), 1);
});

test("the same secret with different terms or a different budget is refused, and writes nothing", async () => {
  const { db, arb } = await setup();
  const s = await secret();
  await arb.createMandate({ ...TERMS, buyer_token_hash: s.hash }, { buyerKey: "b" });
  const before = [await count(db, "mandates"), await count(db, "events")];
  for (const change of [{ max_total_cents: 17_500_000 }, { quantity: 3 }, { deliver_within_hours: 47 }, { vendor_ids: ["ven_x"] }]) {
    await assert.rejects(arb.createMandate({ ...TERMS, ...change, buyer_token_hash: s.hash }, { buyerKey: "b" }), { code: "token_reused", status: 409 }, JSON.stringify(change));
  }
  assert.deepEqual([await count(db, "mandates"), await count(db, "events")], before);
});

test("the daily cap still holds, and a retry of an existing mandate is not counted against it", async () => {
  const { db, arb } = await setup();
  const made = [];
  const { MANDATE_CAP_DEFAULT: CAP } = await import("../src/core.js");
  for (let h = 48; h > 48 - CAP; h--) {
    const s = await secret();
    made.push({ s, m: await arb.createMandate({ ...TERMS, deliver_within_hours: h, buyer_token_hash: s.hash }, { buyerKey: "b" }), h });
  }
  const last = made.at(-1);
  const again = await arb.createMandate({ ...TERMS, deliver_within_hours: last.h, buyer_token_hash: last.s.hash }, { buyerKey: "b" });
  assert.equal(again.mandate_id, last.m.mandate_id, "a retry at the cap returns the existing mandate, not 429");
  const fresh = await secret();
  await assert.rejects(arb.createMandate({ ...TERMS, deliver_within_hours: 48 - CAP, buyer_token_hash: fresh.hash }, { buyerKey: "b" }), { code: "rate_limited" });
  assert.equal(await count(db, "mandates"), CAP);
});

test("identical terms under a different secret are still refused (no re-bidding with a new budget)", async () => {
  const { arb } = await setup();
  const a = await secret(), b = await secret();
  await arb.createMandate({ ...TERMS, buyer_token_hash: a.hash }, { buyerKey: "b" });
  await assert.rejects(arb.createMandate({ ...TERMS, max_total_cents: 18_000_000, buyer_token_hash: b.hash }, { buyerKey: "b" }), { code: "identical_terms" });
});

test("concurrent retries with one secret create exactly one mandate", replayable(async () => {
  const { db, arb } = await setup();
  const s = await secret();
  const rs = await Promise.all(Array.from({ length: 6 }, () => arb.createMandate({ ...TERMS, buyer_token_hash: s.hash }, { buyerKey: "b" })));
  assert.equal(new Set(rs.map((r) => r.mandate_id)).size, 1);
  assert.equal(rs.filter((r) => !r.replayed).length, 1);
  assert.equal(await count(db, "mandates"), 1);
  assert.equal((await arb.verifyChain()).ok, true);
}));

test("a malformed hash is refused", async () => {
  const { arb } = await setup();
  for (const h of ["abc", "G".repeat(64), 42, "A".repeat(64)]) {
    await assert.rejects(arb.createMandate({ ...TERMS, buyer_token_hash: h }, { buyerKey: "b" }), { code: "invalid" }, String(h));
  }
});

test("over HTTP: 201 when created, 200 when replayed, never a token in the body", async () => {
  const env = { DB: memoryD1(), ADMIN_TOKEN: "admin", DEV: "1" };
  const s = await secret();
  const post = () => worker.fetch(new Request("https://arb.test/v1/mandates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...TERMS, buyer_token_hash: s.hash }) }), env);
  const a = await post(), b = await post();
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  const [ja, jb] = [await a.json(), await b.json()];
  assert.equal(ja.mandate_id, jb.mandate_id);
  assert.ok(!JSON.stringify([ja, jb]).includes("bt_"));
  assert.ok(!JSON.stringify([ja, jb]).includes(s.hash), "the hash is not echoed");
});
