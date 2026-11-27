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
  const { checked_at, ...body } = data;
  assert.match(checked_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, "when the checks ran (they are cached for 10 s)");
  assert.deepEqual(body, {
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

// Follow-up to P1.6 (owner, 2026-11-27): /health is cached per Worker instance (per database) for
// 10 s, so a burst costs at most 3 statements per instance per 10 s. Failures are cached too.
function counting(env) {
  const sql = [];
  env.DB.setFault((s) => { sql.push(s); return env.__fault?.(s) ?? false; });
  const get = () => worker.fetch(new Request("https://arb.test/health"), env);
  return { sql, get };
}

test("cache: a burst of 100 requests costs at most 3 statements", async () => {
  const { env } = await deployed();
  const { sql, get } = counting(env);
  const concurrent = await Promise.all(Array.from({ length: 50 }, get));
  const sequential = [];
  for (let i = 0; i < 50; i++) sequential.push(await get());
  const all = [...concurrent, ...sequential];
  assert.ok(all.every((r) => r.status === 200));
  assert.ok(sql.length <= 3, `${sql.length} statements for 100 requests`);
  const ids = new Set(all.map((r) => r.headers.get("x-request-id")));
  assert.equal(ids.size, 100, "each response still has its own request id");
  assert.ok(all.every((r) => r.headers.get("cache-control") === "no-store"));
});

test("cache: the checks run again after 10 s, not before", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T12:00:00.000Z") });
  const { env } = await deployed();
  const { sql, get } = counting(env);
  const first = await (await get()).json();
  const n = sql.length;
  t.mock.timers.tick(9_999);
  const second = await (await get()).json();
  assert.equal(sql.length, n, "within 10 s: no statement");
  assert.equal(second.checked_at, first.checked_at, "checked_at shows the cached check's time");
  t.mock.timers.tick(1);
  const third = await (await get()).json();
  assert.ok(sql.length > n && sql.length <= 2 * n, "at 10 s the checks ran once more");
  assert.equal(third.checked_at, "2026-11-27T12:00:10.000Z");
});

test("cache: a failure is cached too, and clears within 10 s of the fix", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T12:00:00.000Z") });
  const { env } = await deployed();
  env.__fault = (s) => /^\s*SELECT 1\b/.test(s);
  const { sql, get } = counting(env);
  let r = await get();
  assert.equal(r.status, 503);
  const a = await r.json();
  delete env.__fault; // fixed
  r = await get();
  const b = await r.json();
  assert.equal(r.status, 503, "still the cached failure");
  assert.equal(b.error, "db_unavailable");
  assert.notEqual(b.request_id, a.request_id);
  const n = sql.length;
  t.mock.timers.tick(10_000);
  r = await get();
  assert.equal(r.status, 200);
  assert.ok(sql.length - n <= 3);
});

test("cache: each database has its own entry", async () => {
  const one = await deployed();
  const two = await deployed({ DB: memoryD1({ migrations: [] }) });
  assert.equal((await worker.fetch(new Request("https://arb.test/health"), one.env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://arb.test/health"), two.env)).status, 503);
});
