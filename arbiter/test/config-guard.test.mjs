// F7 guard: DEV enables generating a signing key, so it must only ever come from the
// gitignored .dev.vars. A DEV defined anywhere in wrangler.toml ([vars], [env.*.vars],
// inline tables) would ship to the deployed Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Lines of a TOML file that assign a key named DEV (bare or quoted), ignoring comments. */
export function devAssignments(toml) {
  return toml.split("\n")
    .map((line, i) => ({ n: i + 1, code: line.replace(/#.*$/, "") }))
    .filter(({ code }) => /(^|[\s{,.])(DEV|"DEV"|'DEV')\s*=/.test(code))
    .map(({ n, code }) => `${n}: ${code.trim()}`);
}

test("the detector finds DEV however it is written, and ignores comments", () => {
  assert.equal(devAssignments('[vars]\nDEV = "1"').length, 1);
  assert.equal(devAssignments('[env.production.vars]\n  "DEV" = "1"').length, 1);
  assert.equal(devAssignments('vars = { ADMIN = "x", DEV = "1" }').length, 1);
  assert.equal(devAssignments("vars.DEV = '1'").length, 1);
  assert.equal(devAssignments('# DEV = "1" in .dev.vars only\nDEVICE = "x"\nNODEV = 1').length, 0);
});

test("arbiter/wrangler.toml never defines DEV", () => {
  // ARBITER_WRANGLER_TOML points the check at another file (used to record red evidence).
  const path = process.env.ARBITER_WRANGLER_TOML || new URL("../wrangler.toml", import.meta.url);
  const found = devAssignments(readFileSync(path, "utf8"));
  assert.deepEqual(found, [], `DEV must come only from .dev.vars, found in wrangler.toml: ${found.join("; ")}`);
});
