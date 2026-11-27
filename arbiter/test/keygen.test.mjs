// P1.1 AC-1.4: keygen.mjs writes a private JWK to stdout (for a pipe) or to a new file outside the
// repository, never into it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, statSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/keygen.mjs", import.meta.url).pathname;
const REPO = new URL("../../", import.meta.url).pathname;
const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...opts });
const isPrivateJwk = (j) => j.kty === "EC" && j.crv === "P-256" && typeof j.d === "string" && j.x && j.y;

test("piped stdout gets a private P-256 JWK", () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(isPrivateJwk(JSON.parse(r.stdout)));
});

test("--out outside the repo writes a new file, mode 0600, and refuses to overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "keygen-"));
  const out = join(dir, "staging.jwk");
  const r = run(["--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "", "nothing printed when writing a file");
  assert.ok(isPrivateJwk(JSON.parse(readFileSync(out, "utf8"))));
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const before = readFileSync(out, "utf8");
  const again = run(["--out", out]);
  assert.notEqual(again.status, 0);
  assert.equal(readFileSync(out, "utf8"), before, "an existing key is never replaced");
  rmSync(dir, { recursive: true });
});

test("--out inside the repo is refused and nothing is written", () => {
  for (const rel of ["arbiter/new.jwk", "new.jwk", "docs/../arbiter/x.jwk"]) {
    const target = join(REPO, rel);
    const r = run(["--out", target]);
    assert.notEqual(r.status, 0, rel);
    assert.match(r.stderr, /inside the repository/);
    assert.equal(existsSync(target), false, rel);
  }
});

test("stdout redirected to a file inside the repo is refused (Linux)", { skip: process.platform !== "linux" }, () => {
  const target = join(REPO, "arbiter", ".keygen-test-out.jwk");
  const fd = openSync(target, "w");
  try {
    const r = run([], { stdio: ["ignore", fd, "pipe"] });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /inside the repository/);
    assert.equal(readFileSync(target, "utf8"), "", "no key bytes written");
  } finally { closeSync(fd); rmSync(target, { force: true }); }
});

test("unknown arguments are refused", () => {
  const r = run(["--print"]);
  assert.notEqual(r.status, 0);
});
