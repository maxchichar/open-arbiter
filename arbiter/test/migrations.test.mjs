// P1.2: numbered D1 migrations (arbiter/migrations/) replace schema.sql.
//  - they apply to an empty database and to one created and filled by v0.0's own code
//  - 0000_baseline gives exactly v0.0's schema, and refuses a database older than its constraints
//  - applied migrations never change (migrations/lock.json)
//  - the Worker requires exactly the migrations in its tree (REQUIRED_MIGRATIONS)
// Tests named "[tree] …" check this tree's own files; m2-check.mjs skips them when it runs a
// release's tests against newer migrations.
//  - a table rebuild keeps child rows under PRAGMA defer_foreign_keys (the runbook pattern)
// applyMigrations (./migrate.mjs) does what `wrangler d1 migrations apply` does (wrangler 4.166.0
// source): the same d1_migrations table, file names in order, each file plus its INSERT as one
// unit, rolled back on failure. migrations-d1-check.mjs runs the same files through wrangler itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { applyMigrations, migrationNames, MIGRATIONS_DIR, schemaRows } from "./migrate.mjs";
import { d1Over } from "./sqlite-d1.mjs";
import { Arbiter, REQUIRED_MIGRATIONS } from "../src/core.js";
import { verifyPayload } from "../src/crypto.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const V0_SQL = readFileSync(new URL("v0.0-seeded.sql", FIXTURES), "utf8");
const V0 = JSON.parse(readFileSync(new URL("v0.0-seeded.json", FIXTURES), "utf8"));
const V0_SCHEMA = V0_SQL.slice(0, V0_SQL.indexOf("\nINSERT INTO")); // the v0.0 schema.sql part
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

test("[tree] migration files are numbered 0000…, in order, with no gaps", () => {
  const names = migrationNames();
  assert.ok(names.length >= 2);
  names.forEach((n, i) => assert.match(n, new RegExp(`^${String(i).padStart(4, "0")}_[a-z0-9_]+\\.sql$`), n));
});

test("[tree] the Worker requires exactly the migrations in its tree", () => {
  assert.deepEqual(REQUIRED_MIGRATIONS, migrationNames());
});

test("[tree] migrations/lock.json pins every migration's SHA-256: an applied migration is never edited", () => {
  const lock = JSON.parse(readFileSync(new URL("lock.json", MIGRATIONS_DIR), "utf8"));
  const actual = Object.fromEntries(migrationNames().map((n) => [n, createHash("sha256").update(readFileSync(new URL(n, MIGRATIONS_DIR))).digest("hex")]));
  assert.deepEqual(lock, actual, "edit a new migration instead; add its hash to lock.json when you add the file");
  assert.deepEqual(readdirSync(MIGRATIONS_DIR).filter((f) => !f.endsWith(".sql")).sort(), ["lock.json"], "nothing else in migrations/ (wrangler applies every *.sql)");
});

test("empty database: every migration applies and is recorded", () => {
  const db = new DatabaseSync(":memory:");
  assert.deepEqual(applyMigrations(db), migrationNames());
  assert.deepEqual(db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((r) => r.name), migrationNames());
  assert.deepEqual(applyMigrations(db), [], "re-applying is a no-op");
});

test("AC-2.1: 0000_baseline alone gives exactly v0.0's schema (sqlite_master name, type, sql)", () => {
  const fromBaseline = new DatabaseSync(":memory:");
  applyMigrations(fromBaseline, { upTo: "0000_baseline.sql" });
  const fromV0 = new DatabaseSync(":memory:");
  fromV0.exec(V0_SCHEMA);
  assert.deepEqual(schemaRows(fromBaseline), schemaRows(fromV0));
});

test("v0.0-seeded database: migrations apply; no row lost; chain, receipt and accept still work", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(V0_SQL);
  const before = Object.fromEntries(Object.keys(V0.counts).map((t) => [t, count(raw, t)]));
  assert.deepEqual(before, V0.counts, "the fixture loaded as made");
  assert.deepEqual(applyMigrations(raw), migrationNames(), "0000 baselines the existing database; the rest apply");
  for (const [t, n] of Object.entries(V0.counts)) assert.equal(count(raw, t), n, `${t} rows`);

  let now = V0.clock_end;
  const arb = new Arbiter(d1Over(raw), { clock: () => now++, allowGeneratedKey: true, random: () => 0.5 });
  const chain = await arb.verifyChain();
  assert.equal(chain.ok, true);
  assert.equal(chain.head, V0.chain_head);
  const old = await arb.getReceipt(V0.settled.receipt_id);
  assert.equal(await verifyPayload(V0.public_key, old.receipt, old.signature), true, "a v0.0 receipt still verifies against v0.0's key");

  // HEAD writes to the migrated database: accept the offer v0.0 left open.
  const acc = await arb.acceptOffer(V0.open.offer_ids[0], V0.open.buyer_token);
  assert.equal(acc.receipt.mandate_id, V0.open.mandate_id);
  assert.equal((await arb.verifyChain()).ok, true);
  assert.equal(raw.prepare("SELECT settle_attempt FROM mandates WHERE id = ?").get(V0.open.mandate_id).settle_attempt, acc.receipt.receipt_id);
});

test("0000_baseline refuses a database made before CHECK stock_nonneg; nothing is recorded", () => {
  const pre = V0_SCHEMA.replace(/,\s*(--[^\n]*\n\s*)*CONSTRAINT stock_nonneg CHECK \(stock >= 0\)/, "");
  assert.ok(!pre.includes("stock_nonneg"));
  const db = new DatabaseSync(":memory:");
  db.exec(pre);
  assert.throws(() => applyMigrations(db), /CHECK constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '_baseline_check'").get().n, 0, "the check table is rolled back");
  assert.deepEqual(db.prepare("SELECT name FROM d1_migrations").all(), [], "a failed migration is not recorded");
});

test("0000_baseline refuses a database whose audit chain forked (the unique index cannot be built)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(V0_SCHEMA.replace(/CREATE UNIQUE INDEX IF NOT EXISTS events_prev_unique ON events \(prev_hash\);/, ""));
  db.exec("INSERT INTO events (kind, payload, prev_hash, hash, created_at) VALUES ('X', '{}', 'genesis', 'a', 1), ('X', '{}', 'genesis', 'b', 1)");
  assert.throws(() => applyMigrations(db), /UNIQUE constraint failed/);
  assert.deepEqual(db.prepare("SELECT name FROM d1_migrations").all(), []);
});

test("[tree] HEAD inserts name their columns, so an added column never breaks a running Worker (M2)", () => {
  // The Worker, its scripts and its JS tests (a positional INSERT in a test hid a P1.3 red probe).
  const found = [];
  for (const dir of ["../src/", "../scripts/", "./"]) {
    const base = new URL(dir, import.meta.url);
    for (const f of readdirSync(base).filter((f) => /\.m?js$/.test(f))) {
      for (const m of readFileSync(new URL(f, base), "utf8").matchAll(/INSERT INTO \w+ (VALUES|SELECT)/g)) found.push(`${dir}${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(found, []);
});

test("AC-2.6: a parent-table rebuild under PRAGMA defer_foreign_keys keeps every child row", () => {
  const rebuild = readFileSync(new URL("rebuild-mandates.sql", FIXTURES), "utf8");
  const setup = () => {
    const db = new DatabaseSync(":memory:");
    db.exec(V0_SQL);
    applyMigrations(db);
    return db;
  };
  // Run as D1 runs a migration: one transaction.
  const inTx = (db, sql) => { db.exec("BEGIN"); try { db.exec(sql); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } };
  const shape = (d) => ({
    columns: d.prepare("PRAGMA table_info(mandates)").all().map((c) => ({ ...c })),
    indexes: d.prepare("PRAGMA index_list(mandates)").all().map((i) => ({ name: i.name, unique: i.unique, cols: d.prepare(`PRAGMA index_info("${i.name}")`).all().map((c) => c.name) })).sort((a, b) => a.cols.join().localeCompare(b.cols.join())),
  });

  const db = setup();
  const before = { mandates: count(db, "mandates"), offers: count(db, "offers") };
  inTx(db, rebuild);
  assert.deepEqual({ mandates: count(db, "mandates"), offers: count(db, "offers") }, before);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  // The stored CREATE text changes (comments go), so compare the structure.
  assert.deepEqual(shape(db), shape(setup()), "same columns, unique constraints and indexes afterwards");

  const noDefer = setup();
  assert.throws(() => inTx(noDefer, rebuild.replace("PRAGMA defer_foreign_keys = true;", "")), /FOREIGN KEY constraint failed/, "without deferring, dropping the parent fails");
  assert.equal(count(noDefer, "offers"), before.offers);

  const deferOnly = setup();
  assert.throws(() => inTx(deferOnly, rebuild.replace("PRAGMA defer_foreign_keys = false;", "")), /FOREIGN KEY constraint failed/, "defer alone: COMMIT fails on the drop's counted violations");

  const orphaning = setup();
  assert.throws(() => inTx(orphaning, rebuild.replace("FROM mandates;", "FROM mandates WHERE state != 'RESOLVED';")), /CHECK constraint failed/, "a rebuild that loses parent rows is refused");
  assert.equal(count(orphaning, "mandates"), before.mandates, "rolled back");

  const unguarded = setup();
  inTx(unguarded, rebuild.replace("FROM mandates;", "FROM mandates WHERE state != 'RESOLVED';").replace(/CREATE TABLE _fk_check[\s\S]*DROP TABLE _fk_check;/, ""));
  assert.ok(unguarded.prepare("PRAGMA foreign_key_check").all().length > 0, "without the guard, turning defer off commits orphans: why the guard exists");
});
