// P1.0 (U5): the page's status line says "needs your AI provider key" exactly when the runtime's
// settings panel does. The runtime's rule (runtime/ui.js needsByok) gained publisher-funded routers
// in d67755e; site.js mirrors it in AssistantMount.needsKey.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AssistantMount } from "../site.js";

test("needsKey matches the runtime's needsByok rule", () => {
  const cases = [
    [{ mockLLM: false, publisherFundedLLM: false, byokKey: "" }, true],
    [{ mockLLM: false, publisherFundedLLM: false, byokKey: "demo" }, true],
    [{ mockLLM: false, publisherFundedLLM: false, byokKey: "sk-test" }, false],
    [{ mockLLM: true, publisherFundedLLM: false, byokKey: "" }, false],
    [{ mockLLM: false, publisherFundedLLM: true, byokKey: "" }, false, "a publisher-funded router needs no key"],
  ];
  for (const [engine, expected, why] of cases) assert.equal(AssistantMount.needsKey(engine), expected, why || JSON.stringify(engine));
});

test("the runtime's rule is still the one needsKey mirrors (tripwire for runtime upgrades)", () => {
  const ui = readFileSync(new URL("../runtime/ui.js", import.meta.url), "utf8");
  assert.ok(ui.includes('const needsByok = !engine.mockLLM && !engine.publisherFundedLLM && (!engine.byokKey || engine.byokKey === "demo");'),
    "runtime/ui.js needsByok changed: update AssistantMount.needsKey and this test");
});
