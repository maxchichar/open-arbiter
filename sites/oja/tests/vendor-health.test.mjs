// P1.6 AC-6.4: the seller console and the runbook use the arbiter's /health as the first check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the seller console shows the arbiter's /health in a status line", () => {
  assert.match(read("../vendor.html"), /id="arbiter-health"[^>]*role="status"|role="status"[^>]*id="arbiter-health"/);
  const js = read("../js/vendor.js");
  assert.match(js, /\$\{base\}\/health/);
  assert.doesNotMatch(js, /innerHTML/, "status text only (Trusted Types)");
});

test("the runbook's first check after a deploy is /health", () => {
  const rb = read("../../../docs/runbooks/deploy.md");
  const section = rb.split(/^## After a deploy$/m)[1]?.split(/^## /m)[0];
  assert.ok(section, "docs/runbooks/deploy.md has no '## After a deploy' section");
  assert.match(section, /^1\. .*\/health/m, "step 1 is /health");
  for (const code of ["key_missing", "key_invalid", "key_dev_in_deployed_env", "schema_outdated", "migrations_pending", "db_unavailable"]) assert.ok(section.includes(code), code);
});
