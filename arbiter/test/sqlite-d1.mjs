// A tiny Cloudflare D1 look-alike over node:sqlite, so the same SQL runs in tests.
// batch() is one transaction, as D1 documents: if any statement fails, the whole
// sequence rolls back and the error is thrown.
// Fault injection: memoryD1({ fault: (sql, n) => boolean | Error }) throws before running the
// n-th statement executed (0-based, counted across run/first/all/batch) when it returns true
// (a generic error) or an Error (thrown as is, e.g. to imitate a constraint violation).
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, migrationNames } from "./migrate.mjs";

/**
 * An in-memory database migrated as `wrangler d1 migrations apply` would (./migrate.mjs).
 * @param opts.migrations the migration names to apply (default: all of them; [] for none)
 */
export function memoryD1({ fault, migrations } = {}) {
  const db = new DatabaseSync(":memory:");
  const names = migrations ?? migrationNames();
  if (names.length) applyMigrations(db, { upTo: names.at(-1) });
  const d1 = d1Over(db, { fault });
  // An explicit list may skip a name in the middle: drop the records of the ones not asked for.
  if (migrations && names.length) for (const n of migrationNames()) if (!names.includes(n)) db.prepare('DELETE FROM "d1_migrations" WHERE name = ?').run(n);
  return d1;
}

/** The D1 look-alike over an existing node:sqlite database. */
export function d1Over(db, { fault } = {}) {
  let executed = 0;
  const check = (sql) => {
    const n = executed++;
    const f = fault && fault(sql, n);
    if (f instanceof Error) throw f;
    if (f) throw new Error(`injected fault at statement ${n}: ${sql.trim().split(/\s+/).slice(0, 3).join(" ")}`);
  };
  const d1 = {
    raw: db,
    /** Replace the fault hook (null clears it) and reset the statement counter. */
    setFault(fn) { fault = fn; executed = 0; },
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a.map((v) => (typeof v === "boolean" ? Number(v) : v)); return api; },
        async first() { check(sql); return stmt.get(...args) ?? null; },
        async all() { check(sql); return { results: stmt.all(...args), meta: {} }; },
        async run() { check(sql); const r = stmt.run(...args); return { results: [], meta: { changes: Number(r.changes) } }; },
        // Synchronous step used by batch(); rows for statements that return columns.
        _step() {
          check(sql);
          if (stmt.columns().length) return { results: stmt.all(...args), meta: {} };
          const r = stmt.run(...args);
          return { results: [], meta: { changes: Number(r.changes) } };
        },
      };
      return api;
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => s._step());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return d1;
}
