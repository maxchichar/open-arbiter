// P1.3b: who may call the actions Oja shares through its bridge (agentic-web 08daf7d, e67e306).
// CALLERS lists exact origins and never "*". A read goes to every site only through
// EVERY_SITE, and only if the owner confirmed it returns nothing beyond what the public page
// shows (EVERY_SITE_READS below; owner, 2026-11-27). A shared write or irreversible action
// always lists exact callers. The runtime itself accepts "*" for any action, so this test
// is the guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerActions } from "../bridge/bridge-actions.js";

/** Reads the owner confirmed for every site (P1.3b decision D-3b.2: verify_receipt keeps exact origins). */
const EVERY_SITE_READS = ["get_market_state"];

const SOURCE = readFileSync(new URL("../bridge/bridge-actions.js", import.meta.url), "utf8");

function shared() {
  const defs = [];
  registerActions({ register: (d) => defs.push(d) });
  return defs;
}
const isExactOrigin = (o) => { try { return new URL(o).origin === o; } catch { return false; } };

test("CALLERS lists exact origins only, never \"*\"; EVERY_SITE is [\"*\"]", () => {
  const callers = SOURCE.match(/static CALLERS = (\[[^\]]*\]);/)?.[1];
  const everySite = SOURCE.match(/static EVERY_SITE = (\[[^\]]*\]);/)?.[1];
  assert.ok(callers, "BridgeActions.CALLERS not found");
  assert.ok(everySite, "BridgeActions.EVERY_SITE not found");
  const list = JSON.parse(callers);
  assert.ok(!list.includes("*"), "CALLERS must not hold \"*\": use EVERY_SITE on a confirmed read");
  for (const o of list) assert.ok(isExactOrigin(o), `CALLERS entry is not an exact origin: ${o}`);
  assert.deepEqual(JSON.parse(everySite), ["*"]);
});

test("only the owner-confirmed reads are shared with every site, through EVERY_SITE", () => {
  const defs = shared();
  const everySite = defs.filter((d) => (d.callerOrigins || []).includes("*")).map((d) => d.name).sort();
  assert.deepEqual(everySite, [...EVERY_SITE_READS].sort());
  for (const d of defs.filter((x) => EVERY_SITE_READS.includes(x.name))) {
    assert.equal(d.effect, "read", `${d.name} is shared with every site but is not a read`);
    assert.deepEqual(d.callerOrigins, ["*"]);
  }
  const viaEverySite = [...SOURCE.matchAll(/callerOrigins:\s*BridgeActions\.EVERY_SITE\b/g)].length;
  assert.equal(viaEverySite, EVERY_SITE_READS.length, "a read shared with every site uses BridgeActions.EVERY_SITE, not a literal");
});

test("every other shared action lists exact origins (verify_receipt included)", () => {
  for (const d of shared().filter((x) => !EVERY_SITE_READS.includes(x.name))) {
    for (const o of d.callerOrigins || []) assert.ok(isExactOrigin(o), `${d.name}: ${o} is not an exact origin`);
  }
  assert.ok(!shared().find((d) => d.name === "verify_receipt").callerOrigins.includes("*"));
});

test("a shared write or irreversible action lists exact callers, never \"*\" (agentic-web e67e306)", () => {
  for (const d of shared()) {
    const effect = d.effect || "write"; // the runtime's defaults
    const availability = d.availability || "local-only";
    if (effect === "read" || availability === "local-only") continue;
    const callers = d.callerOrigins || [];
    assert.ok(callers.length > 0, `${d.name} is shared through the bridge but lists no callers`);
    assert.ok(!callers.includes("*"), `${d.name} has effect "${effect}" but is shared with every site`);
  }
});
