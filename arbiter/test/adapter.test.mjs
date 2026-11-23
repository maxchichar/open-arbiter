// The node:sqlite D1 stand-in must behave like D1 where the hardening work relies on it:
// batch() is all-or-nothing, and fault injection fires where asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryD1 } from "./sqlite-d1.mjs";

const count = async (db) => (await db.prepare("SELECT COUNT(*) AS n FROM vendors").first()).n;
const insert = (db, id, keyHash) => db.prepare("INSERT INTO vendors VALUES (?,?,?,?,?)").bind(id, "n", null, keyHash, 1);

test("batch commits every statement together", async () => {
  const db = memoryD1();
  const out = await db.batch([insert(db, "a", "k1"), insert(db, "b", "k2")]);
  assert.equal(out.length, 2);
  assert.equal(out[0].meta.changes, 1);
  assert.equal(await count(db), 2);
});

test("batch rolls back everything when one statement fails", async () => {
  const db = memoryD1();
  // second insert violates UNIQUE(key_hash)
  await assert.rejects(db.batch([insert(db, "a", "k1"), insert(db, "b", "k1")]), /UNIQUE/);
  assert.equal(await count(db), 0);
});

test("injected fault aborts a batch at the chosen statement", async () => {
  const db = memoryD1();
  db.setFault((sql, n) => n === 1);
  await assert.rejects(db.batch([insert(db, "a", "k1"), insert(db, "b", "k2")]), /injected fault at statement 1/);
  db.setFault(null);
  assert.equal(await count(db), 0);
});
