// P1.2 AC-2.4 (R6 check): before migrating a database with data, scripts/premigrate-check.mjs reports
// rows the old non-atomic accept could leave behind, and any missing constraint, and exits non-zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { premigrateFindings, sqliteQuery } from "../scripts/premigrate-check.mjs";
import { applyMigrations } from "./migrate.mjs";

const V0_SQL = readFileSync(new URL("./fixtures/v0.0-seeded.sql", import.meta.url), "utf8");
const V0 = JSON.parse(readFileSync(new URL("./fixtures/v0.0-seeded.json", import.meta.url), "utf8"));
const SCRIPT = new URL("../scripts/premigrate-check.mjs", import.meta.url).pathname;
const v0db = (path = ":memory:") => { const db = new DatabaseSync(path); db.exec(V0_SQL); return db; };

test("a clean v0.0 database, before and after migrating: no findings", async () => {
  const db = v0db();
  assert.deepEqual(await premigrateFindings(sqliteQuery(db)), []);
  applyMigrations(db);
  assert.deepEqual(await premigrateFindings(sqliteQuery(db)), []);
});

test("SETTLED mandate without a receipt is reported", async () => {
  const db = v0db();
  db.exec(`UPDATE mandates SET state = 'SETTLED' WHERE id = '${V0.open.mandate_id}'`);
  assert.deepEqual(await premigrateFindings(sqliteQuery(db)), [`mandate ${V0.open.mandate_id}: SETTLED with no receipt`]);
});

test("ACCEPTED offer without a receipt is reported", async () => {
  const db = v0db();
  db.exec(`UPDATE offers SET state = 'ACCEPTED' WHERE id = '${V0.open.offer_ids[0]}'`);
  assert.deepEqual(await premigrateFindings(sqliteQuery(db)), [`offer ${V0.open.offer_ids[0]}: ACCEPTED with no receipt for mandate ${V0.open.mandate_id}`]);
});

test("receipt whose audit_hash names no event is reported", async () => {
  const db = v0db();
  db.exec("UPDATE events SET hash = 'tampered' WHERE kind = 'OFFER_ACCEPTED'");
  assert.deepEqual(await premigrateFindings(sqliteQuery(db)), [`receipt ${V0.settled.receipt_id}: audit_hash names no event`]);
});

test("missing unique indexes are reported", async () => {
  const db = v0db();
  db.exec("DROP INDEX events_prev_unique; DROP INDEX mandates_token_unique");
  assert.deepEqual(await premigrateFindings(sqliteQuery(db)), [
    "schema: UNIQUE events.prev_hash (events_prev_unique) is missing",
    "schema: UNIQUE mandates.token_hash (mandates_token_unique) is missing",
  ]);
});

test("a database without CHECK stock_nonneg is reported", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(V0_SQL.replace(/,\s*(--[^\n]*\n\s*)*CONSTRAINT stock_nonneg CHECK \(stock >= 0\)/, ""));
  assert.deepEqual(await premigrateFindings(sqliteQuery(db)), ["schema: listings CHECK stock_nonneg is missing"]);
});

test("CLI: exit 1 and the findings on a bad database, exit 0 on a clean one", () => {
  const dir = mkdtempSync(join(tmpdir(), "premig-"));
  const good = join(dir, "good.sqlite"), bad = join(dir, "bad.sqlite");
  v0db(good).close();
  const b = v0db(bad);
  b.exec(`UPDATE mandates SET state = 'SETTLED' WHERE id = '${V0.open.mandate_id}'`);
  b.close();
  const ok = spawnSync(process.execPath, [SCRIPT, "--sqlite", good], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const r = spawnSync(process.execPath, [SCRIPT, "--sqlite", bad], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SETTLED with no receipt/);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 2, "usage");
});
