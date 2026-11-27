// P1.2 AC-2.3 (M2): every migration stays compatible with the previous Worker version. m2-check.mjs
// runs a previous release's own arbiter tests (from its git tag) against a database migrated to
// HEAD. Run with `npm run test:m2` (it needs the tags, so CI checks out with fetch-depth 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../../scripts/m2-check.mjs", import.meta.url).pathname;
const FIX = new URL("../fixtures/m2-incompatible/", import.meta.url).pathname;
// Under `node --test`, NODE_TEST_CONTEXT would make the old suite report to this runner and exit 0.
const { NODE_TEST_CONTEXT, ...env } = process.env;
const m2 = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env, timeout: 300_000 });

test("HEAD's migrations: v0.0's own tests pass against the migrated database", () => {
  const r = m2("--ref", "v0.0");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /v0\.0: PASS/);
});

test("negative: a migration that drops a column v0.0 reads is caught", () => {
  const r = m2("--ref", "v0.0", "--extra-migration", `${FIX}drop_listing_title.sql`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /v0\.0: FAIL/);
});

test("negative: an 'additive' column on a table v0.0 inserts positionally is caught", () => {
  const r = m2("--ref", "v0.0", "--extra-migration", `${FIX}add_vendor_column.sql`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /v0\.0: FAIL/);
});

test("default: every release tag is checked", () => {
  const r = m2();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /v0\.0: PASS/);
});

test("an unknown ref is a usage error, not a pass", () => {
  assert.equal(m2("--ref", "no-such-tag").status, 2);
});
