// P1.6: GET /health. 200 with versions, db, key, migrations and schema when healthy; 503 with a
// registry code when misconfigured. At most 3 statements, no event reads, no secret material,
// never cached.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { ERRORS } from "../src/errors.js";
import { REQUIRED_MIGRATIONS } from "../src/core.js";
import { MECHANISM } from "../src/mechanism.js";
import { generateSigningKey, keyId, publicFromPrivate } from "../src/crypto.js";
import { memoryD1 } from "./sqlite-d1.mjs";
import { captureLogs } from "./log-capture.mjs";

const VM = { id: "0b9e1f6c-1111-4222-8333-944455556666", tag: "6fe6ff5b07fe", timestamp: "2026-11-27T21:00:00.000Z" };
const GIT = "6fe6ff5b07fe2a7274e50782f0ea6cbdeeae29b1";
const LATEST = REQUIRED_MIGRATIONS.at(-1);

async function deployed(extra = {}) {
  const { privateJwk } = await generateSigningKey();
  return {
    env: { DB: memoryD1(), ADMIN_TOKEN: "adm_HEALTH_SENTINEL", BUYER_SALT: "salt_HEALTH_SENTINEL", ENVIRONMENT: "staging", ARBITER_SIGNING_JWK: JSON.stringify(privateJwk), CF_VERSION_METADATA: VM, GIT_SHA: GIT, ...extra },
    privateJwk,
  };
}

/** GET /health, counting every statement the database runs. */
async function health(env) {
  const sql = [];
  env.DB.setFault((s) => { sql.push(s.trim().replace(/\s+/g, " ")); return env.__fault?.(s) ?? false; });
  const { result: res, calls } = await captureLogs(() => worker.fetch(new Request("https://arb.test/health"), env));
  const text = await res.text();
  return { res, text, data: JSON.parse(text), sql, log: calls[0]?.args[0] };
}

test("healthy: 200 with versions, db, key (kid only), migrations and schema", async () => {
  const { env, privateJwk } = await deployed();
  const { res, data, sql, text } = await health(env);
  assert.equal(res.status, 200);
  const kid = await keyId(publicFromPrivate(privateJwk));
  assert.deepEqual(data, {
    ok: true,
    version: { worker: VM.id, tag: VM.tag, mechanism: MECHANISM.version, git: GIT },
    db: "ok",
    key: { loaded: true, kid, source: "secret" },
    migrations: { latest: LATEST, applied: LATEST },
    schema: "ok",
  });
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("x-request-id"), /^[0-9a-f]{32}$/);
  assert.ok(sql.length <= 3, `${sql.length} statements: ${sql.join(" | ")}`);
  assert.ok(sql.every((s) => !/\bevents\b|\breceipts\b|\bmandates\b|\blistings\b/.test(s)), `reads business tables: ${sql.join(" | ")}`);
  for (const s of [privateJwk.d, "adm_HEALTH_SENTINEL", "salt_HEALTH_SENTINEL"]) assert.ok(!text.includes(s), "no secret material");
});

test("the log line carries the Worker version, the mechanism and the git commit", async () => {
  const { env } = await deployed();
  const { log } = await health(env);
  assert.deepEqual(log.version, { worker: VM.id, mechanism: MECHANISM.version, git: GIT });
  assert.equal(log.route, "/health");
});

test("local dev (DEV=1, no secret): 200, the key is the dev key and nothing is written", async () => {
  const env = { DB: memoryD1(), DEV: "1", ENVIRONMENT: "local" };
  const { res, data, sql } = await health(env);
  assert.equal(res.status, 200);
  assert.deepEqual(data.key, { loaded: false, kid: null, source: "dev" }, "no key generated yet");
  assert.ok(sql.every((s) => !/^(INSERT|UPDATE|DELETE)/i.test(s)), "health never writes");
  assert.deepEqual(data.version, { worker: "local", tag: null, mechanism: MECHANISM.version, git: "unknown" });
});

const cases = [
  ["key_missing", async () => (await deployed({ ARBITER_SIGNING_JWK: undefined })).env],
  ["key_invalid", async () => (await deployed({ ARBITER_SIGNING_JWK: "{not json" })).env],
  ["key_dev_in_deployed_env", async () => (await deployed({ DEV: "1", ARBITER_SIGNING_JWK: undefined })).env],
  ["key_dev_in_deployed_env", async () => (await deployed({ DEV: "1", ENVIRONMENT: "production" })).env],
  ["schema_outdated", async () => (await deployed({ DB: memoryD1({ migrations: [] }) })).env],
  ["migrations_pending", async () => (await deployed({ DB: memoryD1({ migrations: REQUIRED_MIGRATIONS.slice(0, -1) }) })).env],
  ["db_unavailable", async () => { const { env } = await deployed(); env.__fault = (s) => /^\s*SELECT 1\b/.test(s); return env; }],
];

for (const [code, make] of cases) {
  test(`misconfigured: 503 ${code}, with the checks and a request id`, async () => {
    const env = await make();
    const { res, data, sql, log } = await health(env);
    assert.equal(res.status, 503);
    assert.equal(ERRORS[code]?.status, 503, `${code} is in the registry as 503`);
    assert.equal(data.ok, false);
    assert.equal(data.error, code);
    assert.equal(typeof data.message, "string");
    assert.equal(data.request_id, res.headers.get("x-request-id"));
    assert.ok(data.version && data.version.mechanism === MECHANISM.version);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(sql.length <= 3, `${sql.length} statements`);
    assert.equal(log.code, code);
    assert.equal(log.status, 503);
  });
}

test("an unparseable signing key makes other routes refuse as misconfigured, not crash as internal", async () => {
  const { env } = await deployed({ ARBITER_SIGNING_JWK: "{not json" });
  const res = await worker.fetch(new Request("https://arb.test/.well-known/jwks.json"), env);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "misconfigured");
});
