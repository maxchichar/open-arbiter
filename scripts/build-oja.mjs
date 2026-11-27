// Build Oja for one environment (P1.1 AC-1.5):
//   npm run build:oja -- <staging|production> [--out <dir>]      (default dist/oja-<env>/)
//
// sites/oja/ stays the local-development site: a loopback arbiter and no pinned keys. Each deployed
// environment's arbiter URL and pinned public keys live in sites/oja/environments.json. The build
// copies the site, then sets that URL and those keys in js/config.js, agent-manifest.json
// "open_arbiter" and every _headers connect-src (replacing the local arbiter origin), and finally
// runs the same tripwire on the output. It refuses an environment without a URL or keys, a URL
// that is not public https, private key fields, a kid that is not its key's thumbprint, and a kid
// that appears in both environments (staging keys never verify production receipts, invariant 12).
import { readFileSync, writeFileSync, cpSync, existsSync, rmSync, mkdtempSync, renameSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { keyId } from "../arbiter/src/crypto.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(REPO, "sites", "oja");
const ENVS = ["staging", "production"];
const MARKER = ".oja-build";
const PAGE_RULES = ["/", "/index.html", "/vendor", "/vendor.html", "/bridge/*"];
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** Top-level entries of sites/oja/ that are not part of the published site. Dotfiles are left out too. */
export const BUILD_EXCLUDES = ["tests", "environments.json", "wrangler.toml", ".assetsignore", ".wrangler", ".dev.vars"];

const fail = (msg) => { throw new Error(msg); };

/** Structural checks on environments.json. Throws with the reason. */
export function validateEnvironments(envs) {
  if (!envs || typeof envs !== "object") fail("environments.json: not an object");
  if (!isDeepStrictEqual(Object.keys(envs).sort(), [...ENVS].sort())) fail(`environments.json: needs exactly ${ENVS.join(" and ")}`);
  const owner = new Map();
  for (const name of ENVS) {
    const env = envs[name];
    if (!isDeepStrictEqual(Object.keys(env ?? {}).sort(), ["arbiter_url", "keys"])) fail(`${name}: needs exactly arbiter_url and keys`);
    if (env.arbiter_url !== null) {
      let u;
      try { u = new URL(env.arbiter_url); } catch { fail(`${name}: arbiter_url is not a URL`); }
      if (u.protocol !== "https:") fail(`${name}: arbiter_url must be https`);
      if (LOOPBACK.test(u.hostname)) fail(`${name}: arbiter_url must not be loopback`);
      if (u.username || u.password || u.search || u.hash || u.pathname !== "/") fail(`${name}: arbiter_url must be a bare origin`);
      if (env.arbiter_url !== u.origin) fail(`${name}: arbiter_url must be written as its origin (${u.origin})`);
    }
    if (!Array.isArray(env.keys)) fail(`${name}: keys must be a list`);
    for (const k of env.keys) {
      if (!isDeepStrictEqual(Object.keys(k ?? {}).sort(), ["crv", "kid", "kty", "x", "y"])) fail(`${name}: a key must have exactly kid, kty, crv, x, y (public fields only)`);
      if (k.kty !== "EC" || k.crv !== "P-256") fail(`${name}: a key must be EC P-256`);
      for (const f of ["kid", "x", "y"]) if (typeof k[f] !== "string" || !k[f]) fail(`${name}: key field ${f} must be a string`);
      if (owner.get(k.kid) === name) fail(`${name}: duplicate key kid ${k.kid}`);
      if (owner.has(k.kid)) fail(`key kid ${k.kid} is pinned in both staging and production`);
      owner.set(k.kid, name);
    }
  }
}

/** Each kid must be the thumbprint of its key, as the arbiter computes it. */
export async function verifyKids(envs) {
  for (const name of ENVS) {
    for (const k of envs[name].keys) {
      const want = await keyId({ kty: k.kty, crv: k.crv, x: k.x, y: k.y });
      if (k.kid !== want) fail(`${name}: kid ${k.kid} is not this key's thumbprint (${want})`);
    }
  }
}

const sourceArbiterOrigin = () => {
  const m = readFileSync(join(SITE, "js", "config.js"), "utf8").match(/^export const DEFAULT_ARBITER_URL = "([^"]*)";$/m);
  if (!m) fail("sites/oja/js/config.js: DEFAULT_ARBITER_URL line not found");
  return new URL(m[1]).origin;
};

function replaceOnce(text, re, replacement, what) {
  const n = (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || []).length;
  if (n !== 1) fail(`${what}: expected exactly one match, found ${n}`);
  return text.replace(re, replacement);
}

/** Parse a _headers file into { rule: { header: value } } (same format as tests/csp.test.mjs). */
export function parseHeaders(text) {
  const rules = {};
  let current = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { current = rules[line.trim()] = {}; continue; }
    const i = line.indexOf(":");
    current[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return rules;
}
/** A CSP as { directive: [values] }. */
export const directives = (csp) => Object.fromEntries(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
  const [n, ...values] = d.split(/\s+/);
  return [n, values];
}));
const connectSrc = (csp) => (csp.split(";").map((d) => d.trim().split(/\s+/)).find(([n]) => n === "connect-src") || []).slice(1);

/** The tripwire on a built site: the arbiter URL and keys agree in config.js, the manifest and the CSP. */
export function checkBuiltSite(dir, env) {
  const config = readFileSync(join(dir, "js", "config.js"), "utf8");
  const url = config.match(/^export const DEFAULT_ARBITER_URL = "([^"]*)";$/m)?.[1];
  const keysText = config.match(/^export const ARBITER_KEYS = (\[[\s\S]*?\]);$/m)?.[1];
  if (url !== env.arbiter_url) fail(`config.js: DEFAULT_ARBITER_URL is ${url}, expected ${env.arbiter_url}`);
  if (!keysText || !isDeepStrictEqual(JSON.parse(keysText), env.keys)) fail("config.js: ARBITER_KEYS differs from environments.json");
  if (!env.keys.length) fail("config.js: a public arbiter needs a pinned key");
  const manifest = JSON.parse(readFileSync(join(dir, "agent-manifest.json"), "utf8"));
  if (!isDeepStrictEqual(manifest.open_arbiter, { url: env.arbiter_url, keys: env.keys })) fail("agent-manifest.json: open_arbiter differs from config.js");
  const origin = new URL(env.arbiter_url).origin;
  const rules = parseHeaders(readFileSync(join(dir, "_headers"), "utf8"));
  for (const r of PAGE_RULES) {
    const csp = rules[r]?.["content-security-policy"];
    if (!csp || !connectSrc(csp).includes(origin)) fail(`_headers ${r}: connect-src lacks the arbiter ${origin}`);
  }
  for (const [r, h] of Object.entries(rules)) {
    const bad = connectSrc(h["content-security-policy"] || "").filter((t) => { try { return LOOPBACK.test(new URL(t).hostname); } catch { return false; } });
    if (bad.length) fail(`_headers ${r}: connect-src allows loopback ${bad.join(" ")}`);
  }
}

/** Build one environment into outDir. Writes nothing unless the environment is valid and configured. */
export async function buildOja(name, { environments, outDir } = {}) {
  if (!ENVS.includes(name)) fail(`name an environment: ${ENVS.join("|")}`);
  const envs = environments ?? JSON.parse(readFileSync(join(SITE, "environments.json"), "utf8"));
  validateEnvironments(envs);
  await verifyKids(envs);
  const env = envs[name];
  if (!env.arbiter_url || !env.keys.length) fail(`${name} is not configured: set arbiter_url and keys in sites/oja/environments.json`);
  const out = resolve(outDir ?? join(REPO, "dist", `oja-${name}`));
  if (out === SITE || !relative(SITE, out).startsWith("..")) fail("the output must be outside sites/oja");
  if (existsSync(out) && readdirSync(out).length && !existsSync(join(out, MARKER))) fail(`${out} exists and is not an Oja build; not replacing it`);

  mkdirSync(dirname(out), { recursive: true });
  const tmp = mkdtempSync(join(dirname(out), `.${basename(out)}-`));
  try {
    cpSync(SITE, tmp, {
      recursive: true,
      filter: (src) => {
        const rel = relative(SITE, src);
        if (rel === "") return true;
        const top = rel.split(/[\\/]/)[0];
        return !BUILD_EXCLUDES.includes(top) && !(top.startsWith(".") && top !== ".well-known");
      },
    });
    const from = sourceArbiterOrigin(), to = new URL(env.arbiter_url).origin;
    const configPath = join(tmp, "js", "config.js");
    let config = readFileSync(configPath, "utf8");
    config = replaceOnce(config, /^export const DEFAULT_ARBITER_URL = "[^"]*";$/m, `export const DEFAULT_ARBITER_URL = ${JSON.stringify(env.arbiter_url)};`, "config.js DEFAULT_ARBITER_URL");
    config = replaceOnce(config, /^export const ARBITER_KEYS = \[\];$/m, `export const ARBITER_KEYS = ${JSON.stringify(env.keys, null, 2)};`, "config.js ARBITER_KEYS");
    writeFileSync(configPath, config);

    const manifestPath = join(tmp, "agent-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.open_arbiter = { url: env.arbiter_url, keys: env.keys };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const headersPath = join(tmp, "_headers");
    let swapped = 0;
    const headers = readFileSync(headersPath, "utf8").split("\n").map((line) => {
      if (line.trim().startsWith("#")) return line;
      return line.replace(/connect-src([^;]*)/, (_, v) => `connect-src${v.split(" ").map((t) => (t === from ? (swapped++, to) : t)).join(" ")}`);
    }).join("\n");
    if (swapped < PAGE_RULES.length) fail(`_headers: the local arbiter ${from} was in ${swapped} connect-src directives, expected at least ${PAGE_RULES.length}`);
    writeFileSync(headersPath, headers);

    writeFileSync(join(tmp, MARKER), `${name}\n`);
    checkBuiltSite(tmp, env);
    rmSync(out, { recursive: true, force: true });
    renameSync(tmp, out);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, ...rest] = process.argv.slice(2);
  const outDir = rest[0] === "--out" && rest.length === 2 ? rest[1] : rest.length ? null : undefined;
  if (outDir === null) { process.stderr.write("usage: npm run build:oja -- <staging|production> [--out <dir>]\n"); process.exit(2); }
  try {
    process.stdout.write(`${await buildOja(name, { outDir })}\n`);
  } catch (e) {
    process.stderr.write(`build:oja: ${e.message}\n`);
    process.exit(2);
  }
}
