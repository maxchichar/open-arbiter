// Make a new private ECDSA P-256 JWK for one environment's receipts (P1.1). Never inside the repo.
//   node arbiter/scripts/keygen.mjs | npx wrangler secret put ARBITER_SIGNING_JWK --env staging
//   node arbiter/scripts/keygen.mjs --out ~/keys/open-arbiter-staging.jwk     (new file, mode 0600)
// Then pin its public half: node arbiter/scripts/pubkey.mjs < ~/keys/open-arbiter-staging.jwk
// Refuses: a terminal as stdout (scrollback keeps it), a --out path or a stdout file inside the
// repository, and an existing --out file.
import { writeFileSync, realpathSync, fstatSync, readlinkSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSigningKey } from "../src/crypto.js";

const REPO = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const fail = (msg) => { process.stderr.write(`keygen: ${msg}\n`); process.exit(2); };

/** The real path of p, resolving symlinks in the deepest existing ancestor. */
function realish(p) {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { return resolve(realish(dirname(abs)), abs.slice(dirname(abs).length + 1)); }
}
const insideRepo = (p) => { const r = relative(REPO, realish(p)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

const args = process.argv.slice(2);
let out = null;
if (args.length === 2 && args[0] === "--out") out = args[1];
else if (args.length) fail("usage: keygen.mjs [--out <path outside the repository>]");

if (out) {
  if (insideRepo(out)) fail(`refusing to write a private key inside the repository (${out})`);
} else {
  if (process.stdout.isTTY) fail("refusing to print a private key to a terminal: pipe it to `wrangler secret put` or use --out");
  // Linux: a stdout redirected into a file in the repo (`> arbiter/key.jwk`) is refused too.
  try {
    if (fstatSync(1).isFile()) {
      const target = readlinkSync("/proc/self/fd/1");
      if (insideRepo(target)) fail(`refusing to write a private key inside the repository (${target})`);
    }
  } catch { /* not Linux, or not a file */ }
}

const { privateJwk } = await generateSigningKey();
const text = JSON.stringify(privateJwk);
if (out) {
  try { writeFileSync(out, text, { flag: "wx", mode: 0o600 }); } catch (e) { fail(e.code === "EEXIST" ? `${out} exists; never replacing a key` : e.message); }
} else {
  process.stdout.write(text);
}
