// P0.7 (F8): shipped copy must match the behaviour. These claims were false or overstated:
//  - the maximum never reaches the AI (it does, if the visitor tells the assistant)
//  - the arbiter reveals neither limit (an agreed price narrows each limit to one price step)
//  - the browser verifies "rather than trusting the server" (with no pinned key it fetched the
//    arbiter's own key; now it uses the key pinned in the site)
//  - "midpoint" with no mention of the price step (prices are on a grid since mechanism 2.0.0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;
const SITE = join(ROOT, "sites/oja");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return ["runtime", "tests", "node_modules"].includes(name) ? [] : walk(p);
    return /\.(html|js|mjs|hocon|json)$/.test(name) ? [p] : [];
  });
}
export const FILES = [join(ROOT, "README.md"), join(ROOT, "arbiter/src/mcp.js"), ...walk(SITE)];

const BANNED = [
  [/\b(not|never)\b[^.]{0,60}\bthe AI\b/i, "says a limit never reaches the AI"], // "not an AI" (the arbiter) is fine
  [/shown to the AI/i, "says limits are never shown to the AI"],
  [/reveal(s|ing)? neither/i, "says neither limit is revealed"],
  [/without revealing (either|any|neither)/i, "says neither limit is revealed"],
  [/goes only to the arbiter/i, "says the maximum goes only to the arbiter"],
  [/maximum never leaves/i, "says the maximum never leaves the arbiter"],
  [/rather than trusting the (server|arbiter)/i, "says browser verification is independent of the arbiter"],
  [/does not trust the arbiter/i, "says browser verification is independent of the arbiter"],
  // Mechanism 3.0.0 (Phase 0 gate, R1): the step is ₦100 × 2^k, at most 2.5% of the list price.
  [/step (is |of )?(=\s*)?2\.5%|\(2\.5% of (the|your)|at least (₦|100 naira)?100 per unit/i, "gives the 2.0.0 step (2.5%, at least ₦100)"],
];

test("no shipped copy makes a banned claim", () => {
  const hits = [];
  for (const f of FILES) {
    const text = readFileSync(f, "utf8");
    for (const [re, why] of BANNED) {
      const m = text.match(re);
      if (m) hits.push(`${relative(ROOT, f)}: "${m[0]}" (${why})`);
    }
  }
  assert.deepEqual(hits, []);
});

test("every mention of the midpoint also mentions the price step", () => {
  const hits = [];
  for (const f of FILES) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/midpoint/gi)) {
      const around = text.slice(Math.max(0, m.index - 250), m.index + 350);
      if (!/\bstep\b/i.test(around)) hits.push(`${relative(ROOT, f)} @${m.index}: "${text.slice(m.index - 40, m.index + 60).replace(/\s+/g, " ")}"`);
    }
  }
  assert.deepEqual(hits, []);
});

test("README and the page state the bounded leak and the AI-provider caveat", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const page = readFileSync(join(SITE, "index.html"), "utf8");
  for (const [name, text] of [["README.md", readme], ["index.html", page]]) {
    assert.match(text, /one price step/i, `${name} states that a price narrows a limit to one step`);
    assert.match(text, /AI provider/i, `${name} says the AI provider sees what the visitor tells the assistant`);
  }
  assert.match(readme, /2\.5%/, "README gives the step size");
});
