// The F3 and F4 guarantees live in the schema (UNIQUE events.prev_hash, CHECK stock_nonneg). A
// database created before they existed would silently fork the chain or oversell, so the arbiter
// refuses to write to it (500 misconfigured) until it is migrated or reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Arbiter } from "../src/core.js";
import { memoryD1, SCHEMA_SQL } from "./sqlite-d1.mjs";

const withoutCheck = SCHEMA_SQL.replace(/,\s*(--[^\n]*\n\s*)*CONSTRAINT stock_nonneg CHECK \(stock >= 0\)/, "");
const withoutIndex = SCHEMA_SQL.replace(/CREATE UNIQUE INDEX IF NOT EXISTS events_prev_unique ON events \(prev_hash\);/, "");
const withoutTokenIndex = SCHEMA_SQL.replace(/CREATE UNIQUE INDEX IF NOT EXISTS mandates_token_unique ON mandates \(token_hash\);/, "");

test("the stripped schemas really lack the constraint", () => {
  assert.ok(SCHEMA_SQL.includes("stock_nonneg") && !withoutCheck.includes("stock_nonneg"));
  assert.ok(SCHEMA_SQL.includes("events_prev_unique") && !withoutIndex.includes("events_prev_unique"));
  assert.ok(SCHEMA_SQL.includes("mandates_token_unique") && !withoutTokenIndex.includes("mandates_token_unique"));
});

for (const [name, schemaSql] of [["no CHECK stock_nonneg", withoutCheck], ["no UNIQUE events.prev_hash", withoutIndex], ["no UNIQUE mandates.token_hash", withoutTokenIndex]]) {
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

// The check is cached per database binding for the life of the Worker instance (isolate), so it
// does not add a query to every write. Separate bindings are checked separately.
import worker from "../src/index.js";

const register = (env, name) => worker.fetch(new Request("https://arb.test/v1/vendors", {
  method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ name }),
}), env);

test("schema check: one sqlite_master query per Worker instance, not one per write", async () => {
  const env = { DB: memoryD1(), ADMIN_TOKEN: "admin", DEV: "1" };
  let checks = 0;
  env.DB.setFault((sql) => { if (/sqlite_master/.test(sql)) checks++; return false; });
  for (let i = 0; i < 4; i++) assert.equal((await register(env, `v${i}`)).status, 201);
  assert.equal(checks, 1, `sqlite_master queried ${checks} times for 4 writes`);
});

test("schema check cache is per database: an outdated binding is still refused", async () => {
  const good = { DB: memoryD1(), ADMIN_TOKEN: "admin", DEV: "1" };
  const old = { DB: memoryD1({ schemaSql: withoutCheck }), ADMIN_TOKEN: "admin", DEV: "1" };
  for (let i = 0; i < 2; i++) {
    assert.equal((await register(good, `g${i}`)).status, 201);
    const r = await register(old, `o${i}`);
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error, "misconfigured");
  }
});
