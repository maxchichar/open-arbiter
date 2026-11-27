// P1.2: the schema guard checks the migration level. The write guarantees rest on schema constraints
// (UNIQUE events.prev_hash, CHECK stock_nonneg, UNIQUE mandates.token_hash, the R6 settle marker),
// which the migrations create (migrations.test.mjs). So the Worker refuses writes (500 misconfigured)
// until every migration in REQUIRED_MIGRATIONS is recorded in d1_migrations. Newer migrations than
// this Worker knows are fine: they are applied before the Worker that needs them is deployed (M2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Arbiter, REQUIRED_MIGRATIONS } from "../src/core.js";
import { memoryD1 } from "./sqlite-d1.mjs";
import { migrationNames } from "./migrate.mjs";
import worker from "../src/index.js";

const refused = async (db) => {
  const arb = new Arbiter(db, { allowGeneratedKey: true });
  await assert.rejects(arb.createVendor({ name: "Iya Basira" }), { code: "misconfigured", status: 500 });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM vendors").first()).n, 0);
};

test("no d1_migrations table (a database made from the old schema.sql): writes refused", async () => {
  const db = memoryD1({ migrations: [] });
  db.raw.exec((await import("node:fs")).readFileSync(new URL("../migrations/0000_baseline.sql", import.meta.url), "utf8"));
  await refused(db);
});

test("a required migration missing (database at an older level): writes refused, nothing written", async () => {
  const db = memoryD1({ migrations: migrationNames().slice(0, -1) });
  await refused(db);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM events").first()).n, 0);
});

test("a level recorded out of order still needs every required name", async () => {
  const db = memoryD1();
  db.raw.exec("DELETE FROM d1_migrations WHERE name = '0000_baseline.sql'");
  await refused(db);
});

test("all required migrations applied: writes work; newer migrations than this Worker knows are fine", async () => {
  const db = memoryD1();
  db.raw.exec("INSERT INTO d1_migrations (name) VALUES ('9999_future.sql')");
  const arb = new Arbiter(db, { allowGeneratedKey: true });
  assert.ok((await arb.createVendor({ name: "Iya Basira" })).vendor_id);
});

test("the guard reads the migration level, not sqlite_master", async () => {
  const db = memoryD1();
  const seen = [];
  db.setFault((sql) => { seen.push(sql); return false; });
  await new Arbiter(db, { allowGeneratedKey: true }).createVendor({ name: "x" });
  assert.ok(seen.some((s) => /FROM d1_migrations/.test(s)));
  assert.ok(!seen.some((s) => /sqlite_master/.test(s)));
});

test("[tree] REQUIRED_MIGRATIONS is the tree's migrations", () => {
  assert.deepEqual(REQUIRED_MIGRATIONS, migrationNames());
});

// Cached per database binding for the life of the Worker instance.
const register = (env, name) => worker.fetch(new Request("https://arb.test/v1/vendors", {
  method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ name }),
}), env);

test("schema check: one d1_migrations query per Worker instance, not one per write", async () => {
  const env = { DB: memoryD1(), ADMIN_TOKEN: "admin", DEV: "1" };
  let checks = 0;
  env.DB.setFault((sql) => { if (/d1_migrations/.test(sql)) checks++; return false; });
  for (let i = 0; i < 4; i++) assert.equal((await register(env, `v${i}`)).status, 201);
  assert.equal(checks, 1, `d1_migrations queried ${checks} times for 4 writes`);
});

test("schema check cache is per database: an outdated binding is still refused", async () => {
  const good = { DB: memoryD1(), ADMIN_TOKEN: "admin", DEV: "1" };
  const old = { DB: memoryD1({ migrations: ["0000_baseline.sql"] }), ADMIN_TOKEN: "admin", DEV: "1" };
  for (let i = 0; i < 2; i++) {
    assert.equal((await register(good, `g${i}`)).status, 201);
    const r = await register(old, `o${i}`);
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error, "misconfigured");
  }
});

test("an unexpected database error in the check is not reported as an outdated schema", async () => {
  const db = memoryD1();
  db.setFault((sql) => (/d1_migrations/.test(sql) ? new Error("D1_ERROR: network connection lost") : false));
  await assert.rejects(new Arbiter(db, { allowGeneratedKey: true }).createVendor({ name: "x" }), /network connection lost/);
});
