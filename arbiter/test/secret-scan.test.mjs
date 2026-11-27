// P1.1 AC-1.3: no secret value is in the repository. The scanner is scripts/secret-scan.mjs; the
// pre-commit hook (.githooks/pre-commit) runs it on the staged content, and this test runs it on
// every tracked file, so CI (P1.3) runs it on every push too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSecrets, redact, FORBIDDEN_PATHS, scanRepo } from "../../scripts/secret-scan.mjs";

const REPO = new URL("../../", import.meta.url).pathname;
// A fake private scalar: the right shape, not a key anyone uses.
const FAKE_D = "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK";
const FAKE_JWK = `{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"${FAKE_D}"}`;

test("the detector finds secret shapes and ignores dev values", () => {
  assert.deepEqual(findSecrets(FAKE_JWK), ["private JWK (\"d\")"]);
  assert.equal(findSecrets("-----BEGIN PRIVATE KEY-----\nabc").length, 1);
  assert.equal(findSecrets("ADMIN_TOKEN=4f1c0a9e8b7d").length, 1);
  assert.equal(findSecrets("export BUYER_SALT='s3cr3t-salt'").length, 1);
  assert.equal(findSecrets("CLOUDFLARE_API_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789ABCD").length, 2);
  assert.deepEqual(findSecrets("printf 'ADMIN_TOKEN=dev-admin-token\\nBUYER_SALT=dev\\nDEV=1\\n'"), []);
  assert.deepEqual(findSecrets("`ADMIN_TOKEN=${ADMIN}\\nBUYER_SALT=harness`"), []);
  assert.deepEqual(findSecrets('canonicalJson({ a: { d: [2] } }) // "d":[2'), []);
  assert.ok(FORBIDDEN_PATHS.some((r) => r.test("arbiter/.dev.vars")));
  assert.ok(FORBIDDEN_PATHS.some((r) => r.test("arbiter/.dev.vars.staging")));
  assert.ok(FORBIDDEN_PATHS.some((r) => r.test("keys/staging.jwk")));
  assert.ok(!FORBIDDEN_PATHS.some((r) => r.test("sites/oja/environments.json")));
});

test("redact removes every value and keeps the rest", () => {
  const text = `before ${FAKE_JWK} ADMIN_TOKEN=4f1c0a9e8b7d after`;
  const out = redact(text);
  assert.deepEqual(findSecrets(out), []);
  assert.ok(!out.includes(FAKE_D) && !out.includes("4f1c0a9e8b7d"));
  assert.match(out, /^before \{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"\[REDACTED: private JWK \("d"\)\]"\} ADMIN_TOKEN=\[REDACTED: ADMIN_TOKEN assigned a value\] after$/);
});

test("no tracked file is a secret file or holds a secret value", () => {
  const { files, problems } = scanRepo({ cwd: REPO });
  assert.ok(files > 50, "git listed the repository");
  assert.deepEqual(problems, []);
});

/** A throwaway git repo with the real hook and scanner, hooks enabled the way `npm install` does. */
function hookRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "test@example.invalid");
  g("config", "user.name", "test");
  mkdirSync(join(dir, ".githooks"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(REPO, ".githooks/pre-commit"), join(dir, ".githooks/pre-commit"));
  chmodSync(join(dir, ".githooks/pre-commit"), 0o755);
  copyFileSync(join(REPO, "scripts/secret-scan.mjs"), join(dir, "scripts/secret-scan.mjs"));
  g("config", "core.hooksPath", ".githooks");
  writeFileSync(join(dir, "README.md"), "ok\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  const commit = () => spawnSync("git", ["commit", "-q", "-m", "x"], { cwd: dir, encoding: "utf8" });
  return { dir, g, commit };
}

test("pre-commit hook: blocks a staged fake key, a forbidden file, and a staged secret fixed only in the work tree", () => {
  const { dir, g, commit } = hookRepo();
  writeFileSync(join(dir, "evidence.txt"), `output ${FAKE_JWK}\n`);
  g("add", "evidence.txt");
  let r = commit();
  assert.notEqual(r.status, 0, "commit must be blocked");
  assert.match(r.stderr, /evidence\.txt: private JWK/);
  assert.ok(!r.stderr.includes(FAKE_D), "the value is never printed");
  assert.equal(g("rev-list", "--count", "HEAD").trim(), "1", "nothing committed");

  writeFileSync(join(dir, "evidence.txt"), "clean now\n"); // fixed in the work tree, not re-staged
  r = commit();
  assert.notEqual(r.status, 0, "the staged content is what counts");

  g("rm", "-q", "-f", "--cached", "evidence.txt");
  writeFileSync(join(dir, "staging.jwk"), "{}");
  g("add", "staging.jwk");
  r = commit();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /staging\.jwk: must not be committed/);
});

test("pre-commit hook: a clean commit goes through", () => {
  const { dir, g, commit } = hookRepo();
  writeFileSync(join(dir, "notes.txt"), "ADMIN_TOKEN=dev-admin-token\n");
  g("add", "notes.txt");
  const r = commit();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(g("rev-list", "--count", "HEAD").trim(), "2");
});

test("the hook is versioned, executable, and npm install enables it", async () => {
  assert.ok(statSync(join(REPO, ".githooks/pre-commit")).mode & 0o111, "executable");
  const pkg = JSON.parse((await import("node:fs")).readFileSync(join(REPO, "package.json"), "utf8"));
  assert.match(pkg.scripts.prepare, /git config core\.hooksPath \.githooks/);
});
