// P1.7 AC-7.4: the README's Limits section states the Free-plan quotas, what happens when they run
// out, and the per-IP limit, with the numbers the code uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IP_LIMIT_DEFAULT } from "../src/quota.js";
import { CATALOG_PAGE_MAX } from "../src/core.js";

const limits = readFileSync(new URL("../../README.md", import.meta.url), "utf8").split(/^## Limits/m)[1]?.split(/^## /m)[0] ?? "";

test("README Limits: Free-plan quotas and what happens when they run out", () => {
  for (const phrase of ["100,000 requests a day", "Error 1027", "5 million rows read", "100,000 rows written", "00:00 UTC", "10 ms of CPU", "503 db_unavailable"]) {
    assert.ok(limits.includes(phrase), phrase);
  }
});

test("README Limits: the per-IP limit and bounded reads, with the code's numbers", () => {
  assert.ok(limits.includes(`each IP gets ${IP_LIMIT_DEFAULT} requests a minute`));
  assert.ok(limits.includes("429 rate_limited_ip"));
  assert.ok(limits.includes(`at most ${CATALOG_PAGE_MAX} listings a page`));
  assert.match(limits, /\/v1\/audit\/verify.*admin token/);
  assert.match(limits, /approximate/);
});
