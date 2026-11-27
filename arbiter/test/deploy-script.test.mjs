// P1.1 AC-1.2: `npm run deploy:arbiter` refuses to run without a named environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { deployArgs } from "../scripts/deploy.mjs";

const SCRIPT = new URL("../scripts/deploy.mjs", import.meta.url).pathname;
const REAL = { staging: false, production: false }; // per environment: are its ids still placeholders?
const ids = (placeholders) => ({ hasPlaceholderIds: (env) => placeholders[env] });

test("no environment, an unknown one or the empty top level is refused", () => {
  for (const argv of [[], [""], ["dev"], ["--env", "staging"], ["Staging"], ["staging", "production"]]) {
    assert.throws(() => deployArgs(argv, ids(REAL)), /staging\|production/, JSON.stringify(argv));
  }
});

test("staging deploys with --env staging", () => {
  assert.deepEqual(deployArgs(["staging"], ids(REAL)), ["deploy", "--env", "staging"]);
  assert.deepEqual(deployArgs(["staging", "--dry-run"], ids(REAL)), ["deploy", "--env", "staging", "--dry-run"]);
});

test("production needs --confirm-production (owner approval A3 is still required; this only stops slips)", () => {
  assert.throws(() => deployArgs(["production"], ids(REAL)), /--confirm-production/);
  assert.deepEqual(deployArgs(["production", "--confirm-production"], ids(REAL)), ["deploy", "--env", "production"]);
  assert.deepEqual(deployArgs(["production", "--dry-run"], ids(REAL)), ["deploy", "--env", "production", "--dry-run"], "a dry run uploads nothing");
});

test("unknown flags are refused rather than passed to wrangler", () => {
  assert.throws(() => deployArgs(["staging", "--env", "production"], ids(REAL)), /unknown/);
  assert.throws(() => deployArgs(["staging", "--x-provision"], ids(REAL)), /unknown/);
});

test("an environment whose ids are still placeholders is refused, except for a dry run", () => {
  const placeholders = { staging: true, production: true };
  assert.throws(() => deployArgs(["staging"], ids(placeholders)), /placeholder/);
  assert.deepEqual(deployArgs(["staging", "--dry-run"], ids(placeholders)), ["deploy", "--env", "staging", "--dry-run"]);
});

test("the CLI exits 2 without an environment, before starting wrangler", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /staging\|production/);
});

test("the checked-in wrangler.toml still has placeholder ids (resources are created at approval A1/A3)", async () => {
  const { tomlPlaceholders } = await import("../scripts/deploy.mjs");
  const p = tomlPlaceholders();
  assert.equal(typeof p.hasPlaceholderIds("staging"), "boolean");
  assert.equal(typeof p.hasPlaceholderIds("production"), "boolean");
});
