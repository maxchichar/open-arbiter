// scripts/save-output.mjs keeps the command's exit status and never writes a secret to evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const SCRIPT = new URL("../../scripts/save-output.mjs", import.meta.url).pathname;
const out = () => { const f = join(mkdtempSync(join(tmpdir(), "save-")), "evidence", "out.txt"); mkdirSync(dirname(f), { recursive: true }); return f; };
const save = (file, code) => spawnSync(process.execPath, [SCRIPT, file, "--", process.execPath, "-e", code], { encoding: "utf8" });

test("a failing command: non-zero exit, output saved with its exit code", () => {
  const f = out();
  const r = save(f, 'console.log("1 failing"); console.error("boom"); process.exit(3)');
  assert.equal(r.status, 3);
  assert.equal(readFileSync(f, "utf8"), "1 failing\nboom\nexit: 3\n");
  assert.match(r.stdout, /1 failing/, "still shown on the terminal");
});

test("a failing node --test run exits non-zero", () => {
  const f = out();
  const t = join(dirname(f), "..", "red.test.mjs");
  writeFileSync(t, 'import { test } from "node:test"; test("t", () => { throw new Error("red"); });\n');
  // Under `node --test`, NODE_TEST_CONTEXT makes a child test run report to this runner and exit 0.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(process.execPath, [SCRIPT, f, "--", process.execPath, "--test", "--test-reporter=tap", t], { encoding: "utf8", env });
  assert.notEqual(r.status, 0);
  assert.match(readFileSync(f, "utf8"), /not ok 1 - t[\s\S]*exit: 1\n$/);
});

test("a passing command exits 0", () => {
  const f = out();
  assert.equal(save(f, 'console.log("ok")').status, 0);
  assert.equal(readFileSync(f, "utf8"), "ok\nexit: 0\n");
});

test("a killed command is a failure", () => {
  const f = out();
  const r = save(f, 'process.kill(process.pid, "SIGTERM")');
  assert.equal(r.status, 1);
  assert.match(readFileSync(f, "utf8"), /exit: 1 \(signal SIGTERM\)\n$/);
});

test("a missing command is a failure", () => {
  const f = out();
  const r = spawnSync(process.execPath, [SCRIPT, f, "--", "/nonexistent/cmd"], { encoding: "utf8" });
  assert.equal(r.status, 127);
});

test("secret-shaped output is redacted in the file, exit code unchanged", () => {
  const f = out();
  const d = "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK";
  const r = save(f, `console.log(JSON.stringify({kty:"EC",d:${JSON.stringify(d)}})); process.exit(1)`);
  assert.equal(r.status, 1);
  const text = readFileSync(f, "utf8");
  assert.ok(!text.includes(d));
  assert.match(text, /REDACTED: private JWK/);
  assert.match(r.stderr, /redacted/);
});

test("usage errors exit 2", () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, "x.txt", "node"], { encoding: "utf8" }).status, 2);
});
