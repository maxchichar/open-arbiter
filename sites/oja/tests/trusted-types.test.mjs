// P1.3b: Oja's pages turn on Trusted Types (require-trusted-types-for 'script'), so every HTML
// write, HTML parse and worker start must go through the runtime's one policy. This scans
// Oja's runtime copy and Oja's own code with upstream's sink patterns
// (agentic-web tests/skills/agentify-website/runtime/trusted-types.test.mjs). The browser half,
// 0 violations in a real page, is browser_check.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("../", import.meta.url));
const POLICY_FILE = join(SITE, "runtime/trusted-types.js");

/** Upstream's sink patterns; \s also spans line breaks, so a wrapped call is not flagged. */
const SINKS = [
  ["innerHTML or outerHTML", /\.(?:inner|outer)HTML\s*=(?!\s*trustedHtml\()/g],
  ["insertAdjacentHTML", /\.insertAdjacentHTML\([^,]+,(?!\s*trustedHtml\()/g],
  ["DOMParser.parseFromString", /\.parseFromString\((?!\s*trustedHtml\()/g],
  ["new Worker", /new Worker\((?!\s*trustedScriptUrl\()/g],
  // Not used anywhere today; listed so a first use is a deliberate decision.
  ["document.write", /document\.write(?:ln)?\(/g],
  ["srcdoc", /\.srcdoc\s*=/g],
  ["setHTMLUnsafe", /\.setHTMLUnsafe\(/g],
];

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "tests" ? [] : jsFiles(p);
    return /\.m?js$/.test(name) ? [p] : [];
  });
}

/** The runtime copy and Oja's own browser code (tests run in Node and are left out). */
const scanned = () => jsFiles(SITE).filter((f) => f !== POLICY_FILE);

test("every HTML write, HTML parse and worker start in Oja's pages uses the runtime's policy", () => {
  const found = [];
  for (const file of scanned()) {
    const code = readFileSync(file, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const [name, pattern] of SINKS) {
      for (const m of code.matchAll(pattern)) found.push(`${relative(SITE, file)}:${code.slice(0, m.index).split("\n").length} ${name}`);
    }
  }
  assert.ok(scanned().some((f) => f.includes("/runtime/")) && scanned().some((f) => f.includes("/js/")), "scan found no files");
  assert.deepEqual(found, [], `These skip the Trusted Types policy:\n${found.join("\n")}`);
});

test("the runtime has one Trusted Types policy, and nothing else creates one", () => {
  assert.ok(existsSync(POLICY_FILE), "runtime/trusted-types.js is missing: the runtime predates Trusted Types");
  const creators = jsFiles(SITE).filter((f) => /createPolicy\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(creators.map((f) => relative(SITE, f)), ["runtime/trusted-types.js"]);
});

test("Oja's own code imports the policy module only by its one URL (a ?v= copy cannot create the policy again)", () => {
  for (const file of scanned().filter((f) => !f.includes("/runtime/"))) {
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(/["']([^"']*trusted-types\.js[^"']*)["']/g)) {
      assert.match(m[1], /^\.\.?\/runtime\/trusted-types\.js$/, `${relative(SITE, file)}: ${m[1]}`);
    }
  }
});
