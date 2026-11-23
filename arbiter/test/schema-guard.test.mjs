// The F3 and F4 guarantees live in the schema (UNIQUE events.prev_hash, CHECK stock_nonneg). A
// database created before they existed would silently fork the chain or oversell, so the arbiter
// refuses to write to it (500 misconfigured) until it is migrated or reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Arbiter } from "../src/core.js";
import { memoryD1, SCHEMA_SQL } from "./sqlite-d1.mjs";

const withoutCheck = SCHEMA_SQL.replace(/,\s*(--[^\n]*\n\s*)*CONSTRAINT stock_nonneg CHECK \(stock >= 0\)/, "");
const withoutIndex = SCHEMA_SQL.replace(/CREATE UNIQUE INDEX IF NOT EXISTS events_prev_unique ON events \(prev_hash\);/, "");

test("the stripped schemas really lack the constraint", () => {
  assert.ok(SCHEMA_SQL.includes("stock_nonneg") && !withoutCheck.includes("stock_nonneg"));
  assert.ok(SCHEMA_SQL.includes("events_prev_unique") && !withoutIndex.includes("events_prev_unique"));
});

for (const [name, schemaSql] of [["no CHECK stock_nonneg", withoutCheck], ["no UNIQUE events.prev_hash", withoutIndex]]) {
  test(`outdated database (${name}): writes refused with 500 misconfigured, nothing written`, async () => {
    const db = memoryD1({ schemaSql });
    const arb = new Arbiter(db, { allowGeneratedKey: true });
    await assert.rejects(arb.createVendor({ name: "Iya Basira" }), { code: "misconfigured", status: 500 });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM vendors").first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM events").first()).n, 0);
  });
}

test("current schema: writes work", async () => {
  const arb = new Arbiter(memoryD1(), { allowGeneratedKey: true });
  assert.ok((await arb.createVendor({ name: "Iya Basira" })).vendor_id);
});
