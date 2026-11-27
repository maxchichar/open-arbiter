// P1.1 AC-1.3: no secret value is in the repository. Scans every tracked file (and every file staged
// for commit) for private keys, local secret files and secret assignments. Runs in `npm test`, so CI
// (P1.3) runs it on every push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = new URL("../../", import.meta.url).pathname;

/** Paths that must never be tracked. */
export const FORBIDDEN_PATHS = [/(^|\/)\.dev\.vars(\..+)?$/, /(^|\/)\.env(\..+)?$/, /(^|\/)\.seed-keys\.json$/, /\.jwk$/, /\.pem$/, /(^|\/)\.wrangler\//];

/** Values a secret assignment may carry in the repo: local dev values, and code interpolations. */
const DEV_VALUES = new Set(["dev-admin-token", "dev", "harness", "admin"]);

/** Secret-shaped content: returns a list of "reason" strings for one file's text. */
export function findSecrets(text) {
  const found = [];
  // A private EC/OKP/RSA JWK: a "d" member with a long base64url value.
  if (/"d"\s*:\s*"[A-Za-z0-9_-]{32,}"/.test(text)) found.push("private JWK (\"d\")");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) found.push("PEM private key");
  for (const m of text.matchAll(/\b(ADMIN_TOKEN|BUYER_SALT|ARBITER_SIGNING_JWK|CLOUDFLARE_API_TOKEN)\s*=\s*['"]?([^\s'"\\]+)/g)) {
    const value = m[2];
    if (DEV_VALUES.has(value) || value.startsWith("${") || value.startsWith("$")) continue;
    found.push(`${m[1]} assigned a value`);
  }
  // Cloudflare API tokens are 40 characters of [A-Za-z0-9_-]; only flag them next to a token name.
  if (/(api[_-]?token|CF_API_TOKEN)["'\s:=]+[A-Za-z0-9_-]{40}\b/i.test(text)) found.push("Cloudflare API token");
  return found;
}

test("the detector finds secret shapes and ignores dev values", () => {
  assert.deepEqual(findSecrets('{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"MkN0bG9uZ1ByaXZhdGVTY2FsYXJGb3JUZXN0aW5nWFla"}'), ["private JWK (\"d\")"]);
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

test("no tracked or staged file is a secret file or holds a secret value", () => {
  const files = new Set([
    ...execFileSync("git", ["ls-files", "-z"], { cwd: REPO }).toString().split("\0"),
    ...execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=AM", "-z"], { cwd: REPO }).toString().split("\0"),
  ].filter(Boolean));
  assert.ok(files.size > 50, "git listed the repository");
  const problems = [];
  for (const f of files) {
    if (FORBIDDEN_PATHS.some((r) => r.test(f))) { problems.push(`${f}: must not be committed`); continue; }
    if (/\.(png|jpe?g|gif|ico|woff2?)$/.test(f)) continue;
    if (f === "arbiter/test/secret-scan.test.mjs") continue; // its fixtures are fake secrets
    let text;
    try { text = readFileSync(REPO + f, "utf8"); } catch { continue; } // deleted in the work tree
    for (const why of findSecrets(text)) problems.push(`${f}: ${why}`);
  }
  assert.deepEqual(problems, []);
});
