// Slice-0 spike: which SQLite features behave as the F2/F3/F4 designs need on local D1 (workerd).
const SETUP = [
  "DROP TABLE IF EXISTS items", "DROP TABLE IF EXISTS m", "DROP TABLE IF EXISTS receipts", "DROP TABLE IF EXISTS events", "DROP TABLE IF EXISTS mandates",
  "CREATE TABLE items (id TEXT PRIMARY KEY, stock INTEGER NOT NULL)",
  "CREATE TABLE m (id TEXT PRIMARY KEY, state TEXT NOT NULL)",
  "CREATE TABLE receipts (id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL UNIQUE)",
  "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)",
  "CREATE UNIQUE INDEX events_prev_unique ON events(prev_hash)",
  "CREATE TABLE mandates (id TEXT PRIMARY KEY, buyer TEXT, sku TEXT)",
  "CREATE TRIGGER items_stock_nonneg BEFORE UPDATE OF stock ON items WHEN NEW.stock < 0 BEGIN SELECT RAISE(ABORT, 'out_of_stock'); END",
  "CREATE TRIGGER receipts_need_settled BEFORE INSERT ON receipts WHEN (SELECT state FROM m WHERE id = NEW.mandate_id) IS NOT 'SETTLED' BEGIN SELECT RAISE(ABORT, 'not_settled'); END",
];
const n = async (db, t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;
const errOf = (e) => ({ message: e?.message ?? String(e), cause: e?.cause?.message ?? null });

export default {
  async fetch(req, env) {
    const db = env.DB;
    const out = {};
    for (const s of SETUP) await db.prepare(s).run();
    await db.batch([db.prepare("INSERT INTO items VALUES ('rice', 2)"), db.prepare("INSERT INTO m VALUES ('m1','RESOLVED')"), db.prepare("INSERT INTO m VALUES ('m2','SETTLED')")]);

    // 1. RAISE(ABORT) from a trigger inside a batch: error text, and rollback of earlier statements.
    try {
      await db.batch([db.prepare("UPDATE m SET state='SETTLED' WHERE id='m1'"), db.prepare("UPDATE items SET stock = stock - 5 WHERE id='rice'")]);
      out.trigger_raise = { threw: false };
    } catch (e) {
      out.trigger_raise = { threw: true, ...errOf(e), m1_state_after: (await db.prepare("SELECT state FROM m WHERE id='m1'").first()).state, stock_after: (await db.prepare("SELECT stock FROM items").first()).stock };
    }
    // 2. Trigger guard on INSERT (receipt needs a SETTLED mandate).
    try { await db.prepare("INSERT INTO receipts VALUES ('r1','m1')").run(); out.trigger_insert_guard = { threw: false }; }
    catch (e) { out.trigger_insert_guard = { threw: true, ...errOf(e), receipts: await n(db, "receipts") }; }
    // 3. UNIQUE violation mid-batch rolls back earlier statements.
    try {
      await db.batch([db.prepare("UPDATE items SET stock = stock - 1 WHERE id='rice'"), db.prepare("INSERT INTO receipts VALUES ('r2','m2')"), db.prepare("INSERT INTO receipts VALUES ('r3','m2')")]);
      out.unique_rollback = { threw: false };
    } catch (e) {
      out.unique_rollback = { threw: true, ...errOf(e), stock_after: (await db.prepare("SELECT stock FROM items").first()).stock, receipts: await n(db, "receipts") };
    }
    // 4. Successful batch commits, and per-statement meta.changes is reported.
    const ok = await db.batch([db.prepare("UPDATE items SET stock = stock - 1 WHERE id='rice'"), db.prepare("INSERT INTO receipts VALUES ('r4','m2')")]);
    out.commit = { changes: ok.map((r) => r.meta.changes), stock_after: (await db.prepare("SELECT stock FROM items").first()).stock, receipts: await n(db, "receipts") };
    // 5. UNIQUE prev_hash: error text for the retry matcher.
    await db.prepare("INSERT INTO events (prev_hash, hash) VALUES ('genesis','h1')").run();
    try { await db.prepare("INSERT INTO events (prev_hash, hash) VALUES ('genesis','h2')").run(); out.prev_hash_unique = { threw: false }; }
    catch (e) { out.prev_hash_unique = { threw: true, ...errOf(e) }; }
    // 6. Conditional single-statement insert (F2): meta.changes 0 once the cap is reached.
    const cond = () => db.prepare("INSERT INTO mandates (id, buyer, sku) SELECT ?1, 'b', 's' WHERE (SELECT COUNT(*) FROM mandates WHERE buyer='b' AND sku='s') < 3");
    const changes = [];
    for (let i = 0; i < 5; i++) changes.push((await cond().bind(`x${i}`).run()).meta.changes);
    out.conditional_insert = { changes, rows: await n(db, "mandates") };
    // 7. Fallback (D4 b): NOT NULL column fed by a guard subquery.
    await db.prepare("DROP TRIGGER receipts_need_settled").run();
    try { await db.prepare("INSERT INTO receipts VALUES ('r5', (SELECT id FROM m WHERE id='m1' AND state='SETTLED'))").run(); out.notnull_guard = { threw: false }; }
    catch (e) { out.notnull_guard = { threw: true, ...errOf(e) }; }
    return Response.json(out);
  },
};
