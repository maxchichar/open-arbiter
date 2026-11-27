// P1.2: the migrations through wrangler's own local D1 (`wrangler d1 migrations apply --local`), in
// throwaway --persist-to directories, compared with what node:sqlite (test/migrate.mjs) gives:
//   1. empty database: every migration applies; sqlite_master matches node:sqlite exactly
//   2. v0.0-seeded database (test/fixtures/v0.0-seeded.sql): applies, row counts unchanged
//   3. a database made before CHECK stock_nonneg: 0000_baseline fails, nothing recorded
//   4. AC-2.6: the rebuild fixture keeps child rows; an orphaning rebuild is refused
//   5. premigrate-check reads a local D1 through wrangler
// Run: npm run test:migrations-d1. Prints PASS/FAIL per check; exits 1 on any failure.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, migrationNames, schemaRows } from "../test/migrate.mjs";

const ARBITER = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER = join(ARBITER, "..", "node_modules", ".bin", "wrangler");
const FIX = join(ARBITER, "test", "fixtures");
const V0_SQL = readFileSync(join(FIX, "v0.0-seeded.sql"), "utf8");
const V0 = JSON.parse(readFileSync(join(FIX, "v0.0-seeded.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "migrations-d1-"));
// Local commands use the top-level (local-only) binding; no account, no network.
const apply = (persist) => spawnSync(WRANGLER, ["d1", "migrations", "apply", "open-arbiter", "--local", "--persist-to", persist], { cwd: ARBITER, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
const execFile = (persist, sql) => {
  const f = join(work, `q${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(f, sql);
  return spawnSync(WRANGLER, ["d1", "execute", "open-arbiter", "--local", "--persist-to", persist, "--file", f, "--yes"], { cwd: ARBITER, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
};
const query = (persist, sql) => {
  const r = spawnSync(WRANGLER, ["d1", "execute", "open-arbiter", "--local", "--persist-to", persist, "--json", "--command", sql], { cwd: ARBITER, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
  if (r.status !== 0) throw new Error(`query failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout).flatMap((x) => x.results ?? []);
};
const fresh = (name) => join(work, name);
const D1_SCHEMA = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY type, name";
const applied = (p) => query(p, "SELECT name FROM d1_migrations ORDER BY id").map((r) => r.name);
const count = (p, t) => query(p, `SELECT COUNT(*) AS n FROM ${t}`)[0].n;

const results = [];
const check = (name, fn) => {
  try { const detail = fn(); results.push([name, true, detail]); } catch (e) { results.push([name, false, e.message]); }
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const same = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}\n  wrangler: ${JSON.stringify(a)}\n  node:    ${JSON.stringify(b)}`);

check("1. empty database: all migrations apply; sqlite_master equals node:sqlite's", () => {
  const p = fresh("empty");
  const r = apply(p);
  ok(r.status === 0, `apply exit ${r.status}: ${r.stderr}${r.stdout}`);
  same(applied(p), migrationNames(), "d1_migrations");
  const node = new DatabaseSync(":memory:");
  applyMigrations(node);
  same(query(p, D1_SCHEMA), schemaRows(node), "schema");
  const again = apply(p);
  ok(again.status === 0 && /No migrations to apply/.test(again.stdout), "re-apply is a no-op");
  return `${migrationNames().length} migrations, ${schemaRows(node).length} schema objects identical`;
});

check("2. v0.0-seeded database: migrations apply, no row lost", () => {
  const p = fresh("v0");
  const load = execFile(p, V0_SQL);
  ok(load.status === 0, `loading the fixture failed: ${load.stderr}${load.stdout}`);
  const before = Object.fromEntries(Object.keys(V0.counts).map((t) => [t, count(p, t)]));
  same(before, V0.counts, "fixture loaded");
  const r = apply(p);
  ok(r.status === 0, `apply exit ${r.status}: ${r.stderr}${r.stdout}`);
  same(applied(p), migrationNames(), "d1_migrations");
  same(Object.fromEntries(Object.keys(V0.counts).map((t) => [t, count(p, t)])), V0.counts, "row counts after");
  ok(query(p, "SELECT COUNT(*) AS n FROM pragma_table_info('mandates') WHERE name = 'settle_attempt'")[0].n === 1, "settle_attempt column");
  return `rows ${JSON.stringify(V0.counts)}`;
});

check("3. database made before CHECK stock_nonneg: 0000_baseline fails and is not recorded", () => {
  const p = fresh("pre");
  const pre = V0_SQL.slice(0, V0_SQL.indexOf("\nINSERT INTO")).replace(/,\s*(--[^\n]*\n\s*)*CONSTRAINT stock_nonneg CHECK \(stock >= 0\)/, "");
  ok(!pre.includes("stock_nonneg"), "fixture stripped");
  ok(execFile(p, pre).status === 0, "load pre-constraint schema");
  const r = apply(p);
  ok(r.status !== 0, "apply must fail");
  ok(/CHECK constraint failed/.test(r.stdout + r.stderr), `fails on the baseline check: ${r.stdout}${r.stderr}`);
  same(applied(p), [], "nothing recorded");
  same(query(p, "SELECT name FROM sqlite_master WHERE name = '_baseline_check'"), [], "check table rolled back");
  return "refused with CHECK constraint failed";
});

check("4. AC-2.6 rebuild on local D1: child rows kept; an orphaning rebuild refused", () => {
  const rebuild = readFileSync(join(FIX, "rebuild-mandates.sql"), "utf8");
  const p = fresh("rebuild");
  ok(execFile(p, V0_SQL).status === 0 && apply(p).status === 0, "setup");
  const before = { m: count(p, "mandates"), o: count(p, "offers") };
  const r = execFile(p, rebuild);
  ok(r.status === 0, `rebuild failed on D1: ${r.stderr}${r.stdout}`);
  same({ m: count(p, "mandates"), o: count(p, "offers") }, before, "counts");
  same(query(p, "SELECT COUNT(*) AS n FROM pragma_foreign_key_check")[0].n, 0, "foreign_key_check");
  const q = fresh("orphan");
  ok(execFile(q, V0_SQL).status === 0 && apply(q).status === 0, "setup 2");
  const bad = execFile(q, rebuild.replace("FROM mandates;", "FROM mandates WHERE state != 'RESOLVED';"));
  ok(bad.status !== 0 && /CHECK constraint failed/.test(bad.stdout + bad.stderr), `orphaning rebuild must fail on the guard: ${bad.stdout}${bad.stderr}`);
  same({ m: count(q, "mandates"), o: count(q, "offers") }, before, "rolled back");
  return `mandates ${before.m}, offers ${before.o} kept; orphaning rebuild refused`;
});

check("5. premigrate-check through wrangler on a local D1", () => {
  const p = fresh("v0");
  const r = spawnSync(process.execPath, [join(ARBITER, "scripts", "premigrate-check.mjs"), "--d1-local-persist", p], { encoding: "utf8" });
  ok(r.status === 0, `exit ${r.status}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
});

for (const [name, pass, detail] of results) process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `\n     ${detail.split("\n").join("\n     ")}` : ""}\n`);
const failed = results.filter((r) => !r[1]).length;
if (!failed) rmSync(work, { recursive: true, force: true });
else process.stdout.write(`work directory kept: ${work}\n`);
process.stdout.write(failed ? `MIGRATIONS-D1 FAILED (${failed})\n` : "MIGRATIONS-D1 OK\n");
process.exit(failed ? 1 : 0);
