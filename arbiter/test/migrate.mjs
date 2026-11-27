// Apply arbiter/migrations/ to a node:sqlite database the way `wrangler d1 migrations apply` does
// (wrangler 4.166.0, src/d1/migrations/helpers.ts and apply.ts): the same d1_migrations table,
// files `migrations/*.sql` in name order, skipping names already recorded, each file followed by
// `INSERT INTO d1_migrations (name) values ('<file>')` and run as one unit. D1 runs a query in an
// implicit transaction and wrangler documents that a failed migration "will be rolled back", so a
// failure here rolls back that file and its record and throws. Used by the tests and m2-check.mjs.
import { readFileSync, readdirSync } from "node:fs";

export const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

// Verbatim from wrangler's getCreateMigrationsTableQuery("d1_migrations").
export const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

/** Migration file names in the order wrangler applies them. */
export function migrationNames(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

/**
 * @param db node:sqlite DatabaseSync
 * @param opts.upTo apply only up to and including this name
 * @param opts.extra [{ name, sql }] more migrations after the tree's (m2-check negative fixtures)
 * @returns the names applied by this call
 */
export function applyMigrations(db, { dir = MIGRATIONS_DIR, upTo, extra = [] } = {}) {
  db.exec(CREATE_MIGRATIONS_TABLE);
  const applied = new Set(db.prepare('SELECT name FROM "d1_migrations"').all().map((r) => r.name));
  let files = migrationNames(dir).map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
  if (upTo) files = files.slice(0, files.findIndex((f) => f.name === upTo) + 1);
  const done = [];
  for (const { name, sql } of [...files, ...extra]) {
    if (applied.has(name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(`${sql}\nINSERT INTO "d1_migrations" (name)\nvalues ('${name.replace(/'/g, "''")}');`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${e.message}`, { cause: e });
    }
    done.push(name);
  }
  return done;
}

/** The schema as sqlite_master holds it, without SQLite's and the migration tracker's own tables. */
export function schemaRows(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' ORDER BY type, name").all().map((r) => ({ ...r }));
}

/**
 * A SQL script that recreates db's schema (and its d1_migrations rows) as sqlite_master holds it,
 * in creation order, written with IF NOT EXISTS like the old schema.sql. m2-check.mjs gives it to
 * a schema.sql-era release (v0.0) as its schema, so that release's tests run on HEAD's schema.
 */
export function schemaScriptOf(db) {
  const objects = db.prepare("SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  const ddl = objects.map(({ type, sql }) => `${sql.replace(type === "table" ? /^CREATE TABLE / : /^CREATE (UNIQUE )?INDEX /, (m) => `${m}IF NOT EXISTS `)};`);
  const rows = db.prepare('SELECT name FROM "d1_migrations" ORDER BY id').all().map((r) => `INSERT INTO "d1_migrations" (name) VALUES ('${r.name.replace(/'/g, "''")}');`);
  return `${ddl.join("\n")}\n${rows.join("\n")}\n`;
}
