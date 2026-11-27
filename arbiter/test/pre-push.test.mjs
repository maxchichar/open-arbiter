// The versioned pre-push hook (.githooks/pre-push): a push goes through only when every pushed ref
// is HEAD, the working tree is clean, the history secret scan is clean and `npm test` passes on
// HEAD. OPEN_ARBITER_ALLOW_RED_PUSH=1 skips only npm test, and the hook says it was bypassed.
// Each case pushes for real, to a local bare repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../../", import.meta.url).pathname;

/** A repo whose `npm test` passes or fails on demand (state.txt), the real hook and scanner, and a bare remote. */
function pushRepo() {
  const base = mkdtempSync(join(tmpdir(), "prepush-"));
  const dir = join(base, "work");
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  mkdirSync(dir);
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.invalid");
  g("config", "user.name", "test");
  mkdirSync(join(dir, ".githooks"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(REPO, ".githooks/pre-push"), join(dir, ".githooks/pre-push"));
  chmodSync(join(dir, ".githooks/pre-push"), 0o755);
  copyFileSync(join(REPO, "scripts/secret-scan.mjs"), join(dir, "scripts/secret-scan.mjs"));
  g("config", "core.hooksPath", ".githooks");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", private: true, scripts: { test: "node check.mjs" } }));
  writeFileSync(join(dir, "check.mjs"), "import { readFileSync } from 'node:fs';\nconst ok = readFileSync('state.txt', 'utf8').trim() === 'green';\nconsole.log(ok ? 'tests pass' : 'tests FAIL');\nprocess.exit(ok ? 0 : 1);\n");
  writeFileSync(join(dir, "state.txt"), "green\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  g("remote", "add", "origin", remote);
  const commit = (state) => { writeFileSync(join(dir, "state.txt"), `${state}\n`); g("commit", "-q", "-am", state); };
  const push = (args = ["origin", "main"], env = {}) => {
    const e = { ...process.env, ...env };
    if (!("OPEN_ARBITER_ALLOW_RED_PUSH" in env)) delete e.OPEN_ARBITER_ALLOW_RED_PUSH;
    return spawnSync("git", ["push", "-q", ...args], { cwd: dir, encoding: "utf8", env: e });
  };
  const remoteHead = (ref = "main") => spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${ref}`], { cwd: remote, encoding: "utf8" }).stdout.trim() || null;
  return { dir, g, commit, push, remoteHead };
}

test("a clean tree whose npm test passes on HEAD is pushed", () => {
  const r = pushRepo();
  const p = r.push();
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /pre-push: npm test passed on [0-9a-f]{12}/);
  assert.equal(r.remoteHead(), r.g("rev-parse", "HEAD").trim());
});

test("a commit whose npm test fails is not pushed", () => {
  const r = pushRepo();
  r.commit("red");
  const p = r.push();
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /pre-push: npm test failed on [0-9a-f]{12}/);
  assert.match(p.stderr, /tests FAIL/, "the failing output is shown");
  assert.match(p.stderr, /OPEN_ARBITER_ALLOW_RED_PUSH=1/, "the opt-out is named");
  assert.equal(r.remoteHead(), null, "nothing reached the remote");
});

test("OPEN_ARBITER_ALLOW_RED_PUSH=1 pushes a red commit and says the hook was bypassed", () => {
  const r = pushRepo();
  r.commit("red");
  const p = r.push(["origin", "main"], { OPEN_ARBITER_ALLOW_RED_PUSH: "1" });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /pre-push: BYPASSED/);
  assert.ok(!/tests (pass|FAIL)/.test(p.stderr), "npm test did not run");
  assert.equal(r.remoteHead(), r.g("rev-parse", "HEAD").trim());
});

test("any other value of the opt-out does not bypass", () => {
  const r = pushRepo();
  r.commit("red");
  for (const v of ["true", "yes", "0", ""]) {
    const p = r.push(["origin", "main"], { OPEN_ARBITER_ALLOW_RED_PUSH: v });
    assert.notEqual(p.status, 0, `value ${JSON.stringify(v)}`);
  }
  assert.equal(r.remoteHead(), null);
});

test("a dirty working tree is refused, even with the opt-out", () => {
  const r = pushRepo();
  for (const dirty of [() => writeFileSync(join(r.dir, "state.txt"), "red\n"), () => writeFileSync(join(r.dir, "untracked.txt"), "x\n")]) {
    dirty();
    for (const env of [{}, { OPEN_ARBITER_ALLOW_RED_PUSH: "1" }]) {
      const p = r.push(["origin", "main"], env);
      assert.notEqual(p.status, 0);
      assert.match(p.stderr, /pre-push: the working tree is not clean/);
    }
    r.g("checkout", "-q", "--", "state.txt");
    r.g("clean", "-qfd");
  }
  assert.equal(r.remoteHead(), null);
});

test("a secret file in history is refused, even with the opt-out", () => {
  const r = pushRepo();
  writeFileSync(join(r.dir, "staging.jwk"), "{}");
  r.g("add", "staging.jwk");
  r.g("commit", "-q", "-m", "oops"); // no pre-commit hook in this repo, as for a contributor without npm install
  const p = r.push(["origin", "main"], { OPEN_ARBITER_ALLOW_RED_PUSH: "1" });
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /pre-push: the history secret scan found/);
  assert.equal(r.remoteHead(), null);
});

test("pushing a ref that is not HEAD is refused (npm test runs on HEAD only)", () => {
  const r = pushRepo();
  r.g("branch", "other"); // the green base
  r.commit("red"); // HEAD moves on; other stays behind
  const p = r.push(["origin", "other"]);
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /pre-push: refs\/heads\/other is not HEAD/);
  assert.equal(r.remoteHead("other"), null);
});

test("deleting a remote branch needs no test run", () => {
  const r = pushRepo();
  assert.equal(r.push().status, 0);
  r.g("push", "-q", "--no-verify", "origin", "main:gone"); // set up a branch to delete (setup only)
  const p = r.push(["origin", "--delete", "gone"]);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(r.remoteHead("gone"), null);
});

test("the pre-push hook is versioned and executable", () => {
  assert.ok(statSync(join(REPO, ".githooks/pre-push")).mode & 0o111);
});
