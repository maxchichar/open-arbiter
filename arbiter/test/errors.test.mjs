// P1.5 AC-5.3: one registry of stable error codes (arbiter/src/errors.js). Every code the arbiter
// throws is in it, each code has exactly one HTTP status, and the README lists them all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ERRORS, ArbiterError } from "../src/errors.js";

const SRC = new URL("../src/", import.meta.url);
const sources = () => readdirSync(SRC).filter((f) => f.endsWith(".js")).map((f) => [f, readFileSync(new URL(f, SRC), "utf8")]);

test("every code in the registry has one integer HTTP status and a meaning", () => {
  assert.ok(Object.keys(ERRORS).length >= 15, "registry looks empty");
  for (const [code, e] of Object.entries(ERRORS)) {
    assert.match(code, /^[a-z][a-z0-9_]*$/, code);
    assert.ok(Number.isInteger(e.status) && e.status >= 400 && e.status <= 599, `${code}: status`);
    assert.ok(typeof e.meaning === "string" && e.meaning.length > 10, `${code}: meaning`);
  }
});

test("every ArbiterError in src/ names a registry code as a literal, with no status of its own", () => {
  const bad = [];
  let seen = 0;
  for (const [file, code] of sources()) {
    if (file === "errors.js") continue;
    for (const m of code.matchAll(/new ArbiterError\(([^)]*)\)/g)) {
      seen++;
      const args = m[1];
      const lit = args.match(/^\s*"([a-z0-9_]+)"/);
      if (!lit) { bad.push(`${file}: non-literal code: ${args.slice(0, 40)}`); continue; }
      if (!(lit[1] in ERRORS)) bad.push(`${file}: unknown code ${lit[1]}`);
      // Code, then a message; a third argument would be a status, which only the registry sets.
      const rest = args.slice(lit[0].length);
      if (/,\s*\d{3}\s*(,|$)/.test(rest)) bad.push(`${file}: ${lit[1]} passes its own status`);
    }
  }
  assert.ok(seen >= 20, `only ${seen} ArbiterError call sites found`);
  assert.deepEqual(bad, []);
});

test("ArbiterError takes its status from the registry and refuses an unknown code", () => {
  for (const [code, e] of Object.entries(ERRORS)) assert.equal(new ArbiterError(code, "x").status, e.status);
  assert.throws(() => new ArbiterError("no_such_code", "x"), /unknown error code/);
});

test("the README lists every error code with its status", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.split(/^## Error codes$/m)[1]?.split(/^## /m)[0];
  assert.ok(section, "README has no '## Error codes' section");
  for (const [code, e] of Object.entries(ERRORS)) {
    assert.match(section, new RegExp(`\\| \`${code}\` \\| ${e.status} \\|`), `README: ${code}`);
  }
});
