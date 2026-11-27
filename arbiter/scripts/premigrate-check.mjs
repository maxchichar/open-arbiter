// Before migrating a database that holds data (P1.2 AC-2.4, R6; docs/runbooks/deploy.md):
//   node arbiter/scripts/premigrate-check.mjs --sqlite <file>
//   node arbiter/scripts/premigrate-check.mjs --d1 <database> --env <staging|production> (--remote|--local)
//   node arbiter/scripts/premigrate-check.mjs --d1-local-persist <dir>   (local dev D1 under --persist-to <dir>)
// Reports what the pre-Phase-0 non-atomic accept could leave behind, and constraints the write
// guarantees need that the database lacks:
//   - SETTLED mandates with no receipt
//   - ACCEPTED offers with no receipt for their mandate
//   - receipts whose audit_hash names no event
//   - missing CHECK stock_nonneg, UNIQUE events.prev_hash, UNIQUE mandates.token_hash
// Exits 1 on any finding (resolve them, or block the migration), 0 when clean, 2 on a usage error.
// Read-only: it only runs SELECTs. Prints ids, never floors, budgets or token hashes.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CHECKS = [
  ["SELECT m.id FROM mandates m WHERE m.state = 'SETTLED' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.mandate_id = m.id) ORDER BY m.id",
    (r) => `mandate ${r.id}: SETTLED with no receipt`],
  ["SELECT o.id, o.mandate_id FROM offers o WHERE o.state = 'ACCEPTED' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.mandate_id = o.mandate_id) ORDER BY o.id",
    (r) => `offer ${r.id}: ACCEPTED with no receipt for mandate ${r.mandate_id}`],
  ["SELECT r.id FROM receipts r WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.hash = json_extract(r.payload, '$.audit_hash')) ORDER BY r.id",
    (r) => `receipt ${r.id}: audit_hash names no event`],
];
const SCHEMA = [
  ["listings CHECK stock_nonneg", (rows) => /CONSTRAINT stock_nonneg CHECK \(stock >= 0\)/.test(rows.find((r) => r.name === "listings")?.sql ?? "")],
  ["UNIQUE events.prev_hash (events_prev_unique)", (rows) => rows.some((r) => r.name === "events_prev_unique")],
  ["UNIQUE mandates.token_hash (mandates_token_unique)", (rows) => rows.some((r) => r.name === "mandates_token_unique")],
];
const SCHEMA_SQL = "SELECT name, sql FROM sqlite_master WHERE (type = 'table' AND name = 'listings') OR (type = 'index' AND name IN ('events_prev_unique', 'mandates_token_unique'))";

/** @param query async (sql) => rows. Returns the findings, schema first. */
export async function premigrateFindings(query) {
  const rows = await query(SCHEMA_SQL);
  const findings = SCHEMA.filter(([, ok]) => !ok(rows)).map(([name]) => `schema: ${name} is missing`);
  for (const [sql, describe] of CHECKS) for (const r of await query(sql)) findings.push(describe(r));
  return findings;
}

/** query() over a node:sqlite DatabaseSync. */
export const sqliteQuery = (db) => async (sql) => db.prepare(sql).all();

/** query() through `wrangler d1 execute --json` (read-only SELECTs). */
export function wranglerQuery({ database, env, remote, persistTo }) {
  const arbiterDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const wrangler = join(arbiterDir, "..", "node_modules", ".bin", "wrangler");
  const target = persistTo ? ["--local", "--persist-to", persistTo] : ["--env", env, remote ? "--remote" : "--local"];
  return async (sql) => {
    const r = spawnSync(wrangler, ["d1", "execute", database, ...target, "--json", "--command", sql], { cwd: arbiterDir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`wrangler d1 execute failed (${r.status}): ${r.stderr.trim()}`);
    const out = JSON.parse(r.stdout);
    return out.flatMap((x) => x.results ?? []);
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = () => { process.stderr.write("usage: premigrate-check.mjs --sqlite <file> | --d1 <database> --env <staging|production> (--remote|--local) | --d1-local-persist <dir>\n"); process.exit(2); };
  let query;
  if (args[0] === "--sqlite" && args.length === 2) {
    const { DatabaseSync } = await import("node:sqlite");
    query = sqliteQuery(new DatabaseSync(args[1], { readOnly: true }));
  } else if (args[0] === "--d1" && args.length === 5 && args[2] === "--env" && ["staging", "production"].includes(args[3]) && ["--remote", "--local"].includes(args[4])) {
    query = wranglerQuery({ database: args[1], env: args[3], remote: args[4] === "--remote" });
  } else if (args[0] === "--d1-local-persist" && args.length === 2) {
    query = wranglerQuery({ database: "open-arbiter", persistTo: args[1] });
  } else usage();
  try {
    const findings = await premigrateFindings(query);
    if (findings.length) {
      process.stderr.write(`premigrate-check: ${findings.length} finding(s); resolve them or do not migrate:\n${findings.map((f) => `  ${f}`).join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write("premigrate-check: no findings\n");
  } catch (e) {
    process.stderr.write(`premigrate-check: ${e.message}\n`);
    process.exit(2);
  }
}
