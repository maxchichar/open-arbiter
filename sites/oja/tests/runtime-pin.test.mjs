// P1.3b: Oja's runtime/ is the agentify skill's copy at one agentic-web commit, unedited
// (invariant 6), and every place that names that commit agrees. runtime-lock.json holds the
// commit and each file's SHA-256 at that commit (scripts/runtime-lock.mjs writes it from a clone),
// so this runs offline. CI also compares runtime/ byte for byte with a clone at the pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RUNTIME = join(ROOT, "sites/oja/runtime");
const lock = JSON.parse(readFileSync(new URL("./runtime-lock.json", import.meta.url), "utf8"));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [relative(RUNTIME, p).split("\\").join("/")];
  });
}

test("runtime/ is exactly the locked upstream copy: same files, same bytes", () => {
  assert.match(lock.commit, /^[0-9a-f]{40}$/);
  const actual = Object.fromEntries(walk(RUNTIME).sort().map((f) => [f, createHash("sha256").update(readFileSync(join(RUNTIME, f))).digest("hex")]));
  const missing = Object.keys(lock.files).filter((f) => !(f in actual));
  const extra = Object.keys(actual).filter((f) => !(f in lock.files));
  const changed = Object.keys(lock.files).filter((f) => f in actual && actual[f] !== lock.files[f]);
  assert.deepEqual({ missing, extra, changed }, { missing: [], extra: [], changed: [] },
    `runtime/ differs from ${lock.path} at ${lock.commit}: replace it wholesale from upstream (invariant 6)`);
});

test("CI and CLAUDE.md pin the same agentic-web commit as the runtime lock", () => {
  const ci = read(".github/workflows/ci.yml");
  const envPin = ci.match(/^\s*AGENTIC_WEB_PIN:\s*([0-9a-f]{40})\s*$/m)?.[1];
  const checkout = [...ci.matchAll(/repository:\s*cognizant-ai-labs\/agentic-web\s*\n\s*ref:\s*([0-9a-f]{40})/g)].map((m) => m[1]);
  const claude = read("CLAUDE.md").match(/pinned at commit `([0-9a-f]{40})`/)?.[1];
  assert.deepEqual({ envPin, checkout, claude }, { envPin: lock.commit, checkout: [lock.commit], claude: lock.commit });
});

test("CI compares runtime/ with the clone at the pin and runs upstream's runtime tests there", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /diff -r \.agentic-web\/skills\/agentify-website\/runtime sites\/oja\/runtime/);
  assert.match(ci, /node --test "tests\/skills\/agentify-website\/runtime\/\*\.test\.mjs"/);
});
