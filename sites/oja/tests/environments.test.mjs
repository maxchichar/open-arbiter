// P1.1 AC-1.5: per-environment Oja builds. The source tree stays the local-dev site (loopback
// arbiter, no pinned keys). scripts/build-oja.mjs <env> writes dist/oja-<env>/ with that environment's
// arbiter URL and pinned keys in js/config.js, agent-manifest.json "open_arbiter" and the _headers
// connect-src, then runs the same tripwire on the output. Staging and production never share a kid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateSigningKey, keyId } from "../../../arbiter/src/crypto.js";
import { buildOja, validateEnvironments, verifyKids, checkBuiltSite, BUILD_EXCLUDES, parseHeaders, directives } from "../../../scripts/build-oja.mjs";
import * as sourceConfig from "../js/config.js";

const SITE = new URL("../", import.meta.url).pathname;
const ENV_FILE = join(SITE, "environments.json");

async function pub() {
  const { publicJwk } = await generateSigningKey();
  return { kid: await keyId(publicJwk), kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };
}
async function fixture() {
  return {
    staging: { arbiter_url: "https://open-arbiter-staging.example.workers.dev", keys: [await pub()] },
    production: { arbiter_url: "https://open-arbiter-production.example.workers.dev", keys: [await pub(), await pub()] },
  };
}
const tmp = () => mkdtempSync(join(tmpdir(), "oja-build-"));

test("environments.json names exactly staging and production and passes validation", async () => {
  const envs = JSON.parse(readFileSync(ENV_FILE, "utf8"));
  assert.deepEqual(Object.keys(envs).sort(), ["production", "staging"]);
  validateEnvironments(envs); // throws on a shared kid, a loopback or http URL, or private key fields
  await verifyKids(envs); // each kid is its key's thumbprint
});

test("validation: a kid in both environments is refused", async () => {
  const envs = await fixture();
  envs.production.keys.push(envs.staging.keys[0]);
  assert.throws(() => validateEnvironments(envs), /both staging and production/);
});

test("validation: a non-https, loopback or credentialed arbiter URL is refused", async () => {
  for (const url of ["http://open-arbiter.example.workers.dev", "https://localhost:8787", "https://127.0.0.1", "https://u:p@arbiter.example", "https://arbiter.example/path", "not a url"]) {
    const envs = await fixture();
    envs.staging.arbiter_url = url;
    assert.throws(() => validateEnvironments(envs), /arbiter_url/, url);
  }
});

test("validation: private fields, extra fields or a duplicate kid are refused", async () => {
  const cases = [
    (e) => { e.staging.keys[0].d = "secret"; },
    (e) => { e.staging.keys[0].use = "sig"; },
    (e) => { e.production.keys.push({ ...e.production.keys[0] }); },
  ];
  for (const [i, mutate] of cases.entries()) {
    const envs = await fixture();
    mutate(envs);
    assert.throws(() => validateEnvironments(envs), /key/, `case ${i}`);
  }
});

test("validation: each kid must be its key's thumbprint", async () => {
  const envs = await fixture();
  await verifyKids(envs);
  envs.staging.keys[0].kid = "not-the-thumbprint";
  await assert.rejects(() => verifyKids(envs), /kid/);
});

test("an environment with no arbiter URL or no keys does not build (fail closed)", async () => {
  for (const env of [{ arbiter_url: null, keys: [] }, { arbiter_url: "https://a.example", keys: [] }, { arbiter_url: null, keys: [await pub()] }]) {
    const out = join(tmp(), "out");
    await assert.rejects(() => buildOja("staging", { environments: { staging: env, production: { arbiter_url: null, keys: [] } }, outDir: out }), /not configured/);
    assert.equal(existsSync(out), false, "nothing written");
  }
});

for (const name of ["staging", "production"]) {
  test(`${name} build: config.js, manifest and every connect-src carry that environment's arbiter and keys only`, async () => {
    const envs = await fixture();
    const out = join(tmp(), name);
    await buildOja(name, { environments: envs, outDir: out });
    const env = envs[name], other = envs[name === "staging" ? "production" : "staging"];
    const origin = new URL(env.arbiter_url).origin;

    const config = await import(`${pathToFileURL(join(out, "js/config.js")).href}?${Date.now()}`);
    assert.equal(config.DEFAULT_ARBITER_URL, env.arbiter_url);
    assert.deepEqual(config.ARBITER_KEYS, env.keys);
    for (const k of other.keys) assert.ok(!config.ARBITER_KEYS.some((x) => x.kid === k.kid), "no key from the other environment");

    const manifest = JSON.parse(readFileSync(join(out, "agent-manifest.json"), "utf8"));
    assert.deepEqual(manifest.open_arbiter, { url: env.arbiter_url, keys: env.keys });

    // connect-src: exactly the source policy with the local arbiter swapped for this one.
    const src = parseHeaders(readFileSync(join(SITE, "_headers"), "utf8"));
    const built = parseHeaders(readFileSync(join(out, "_headers"), "utf8"));
    assert.deepEqual(Object.keys(built), Object.keys(src), "same rules");
    const localOrigin = new URL(sourceConfig.DEFAULT_ARBITER_URL).origin;
    for (const [path, headers] of Object.entries(src)) {
      for (const [h, v] of Object.entries(headers)) {
        if (h !== "content-security-policy") { assert.equal(built[path][h], v); continue; }
        const s = directives(v), b = directives(built[path][h]);
        assert.deepEqual(Object.keys(b), Object.keys(s), `${path}: same directives`);
        for (const d of Object.keys(s)) {
          const want = d === "connect-src" ? s[d].map((x) => (x === localOrigin ? origin : x)) : s[d];
          assert.deepEqual(b[d], want, `${path} ${d}`);
        }
        assert.ok(!(b["connect-src"] || []).some((x) => /localhost|127\.0\.0\.1|\[::1\]/.test(x)), `${path}: no loopback origin`);
      }
    }
    for (const p of ["/", "/index.html", "/vendor", "/vendor.html", "/bridge/*"]) assert.ok(directives(built[p]["content-security-policy"])["connect-src"].includes(origin), p);

    checkBuiltSite(out, env); // the tripwire the build itself runs
  });
}

test("the build leaves out tests, build-only files and local secrets", async () => {
  const out = join(tmp(), "staging");
  await buildOja("staging", { environments: await fixture(), outDir: out });
  for (const p of BUILD_EXCLUDES) assert.equal(existsSync(join(out, p)), false, p);
  for (const p of ["index.html", "vendor.html", "runtime/ui.js", "bridge/action-bridge.html", "oja_market.network.json", "_headers"]) assert.ok(existsSync(join(out, p)), p);
});

test("the build's own tripwire catches a tampered output", async () => {
  const envs = await fixture();
  const out = join(tmp(), "staging");
  await buildOja("staging", { environments: envs, outDir: out });
  const h = join(out, "_headers");
  const good = readFileSync(h, "utf8");
  writeFileSync(h, good.replace(new URL(envs.staging.arbiter_url).origin, "http://localhost:8787"));
  assert.throws(() => checkBuiltSite(out, envs.staging), /connect-src/);
  writeFileSync(h, good);
  const m = join(out, "agent-manifest.json");
  const manifest = JSON.parse(readFileSync(m, "utf8"));
  manifest.open_arbiter.keys = [];
  writeFileSync(m, JSON.stringify(manifest));
  assert.throws(() => checkBuiltSite(out, envs.staging), /manifest/);
  rmSync(out, { recursive: true });
});
