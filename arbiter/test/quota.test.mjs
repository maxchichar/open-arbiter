// P1.7 AC-7.3: a per-IP rate limit on every public endpoint, checked before the Worker does any
// real work. Two layers: a per-instance fixed window (always on, no quota cost) and, where it is
// bound, the Workers rate-limiting binding (IP_RATE_LIMIT). Over the limit: 429 rate_limited_ip.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { ERRORS } from "../src/errors.js";
// Imported by namespace so the red run (before quota.js) fails on behaviour, not on the import.
const quota = await import("../src/quota.js").catch(() => ({}));
const IP_LIMIT_DEFAULT = quota.IP_LIMIT_DEFAULT ?? 100, IP_PERIOD_S = quota.IP_PERIOD_S ?? 60, MCP_BATCH_MAX = quota.MCP_BATCH_MAX ?? 20, INSTANCE_KEYS_MAX = quota.INSTANCE_KEYS_MAX ?? 10_000;
import { generateSigningKey } from "../src/crypto.js";
import { memoryD1 } from "./sqlite-d1.mjs";
import { captureLogs } from "./log-capture.mjs";

let ipSeq = 0;
/** A fresh documentation-range IP per test, so tests never share a window. */
const freshIp = () => `2001:db8:1::${(++ipSeq).toString(16)}`;

async function env(extra = {}) {
  const { privateJwk } = await generateSigningKey();
  const DB = memoryD1();
  const sql = [];
  DB.setFault((s) => { sql.push(s); return false; });
  return { DB, sql, ADMIN_TOKEN: "adm", BUYER_SALT: "salt_QUOTA", ENVIRONMENT: "staging", ARBITER_SIGNING_JWK: JSON.stringify(privateJwk), ...extra };
}
const get = (e, path, ip, init = {}) => worker.fetch(new Request(`https://arb.test${path}`, { ...init, headers: { "cf-connecting-ip": ip, ...(init.headers || {}) } }), e);
const rpc = (e, ip, msg) => get(e, "/mcp", ip, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });

test("the code is in the registry as 429, distinct from anti-probing's rate_limited", () => {
  assert.equal(ERRORS.rate_limited_ip?.status, 429);
  assert.notEqual(ERRORS.rate_limited_ip.meaning, ERRORS.rate_limited.meaning);
  assert.equal(quota.IP_LIMIT_DEFAULT, 100);
  assert.equal(quota.IP_PERIOD_S, 60);
});

test("the 101st request in 60 s from one IP is 429 rate_limited_ip, with retry-after and a request id", async () => {
  const e = await env(); const ip = freshIp();
  for (let i = 0; i < IP_LIMIT_DEFAULT; i++) assert.equal((await get(e, "/v1/catalog", ip)).status, 200, `request ${i + 1}`);
  const { result: res, calls } = await captureLogs(() => get(e, "/v1/catalog", ip));
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error, "rate_limited_ip");
  assert.equal(body.request_id, res.headers.get("x-request-id"));
  assert.equal(res.headers.get("retry-after"), String(IP_PERIOD_S));
  assert.equal(calls[0].args[0].code, "rate_limited_ip");
  assert.equal((await get(e, "/v1/catalog", freshIp())).status, 200, "another IP is unaffected");
});

test("a refused request does no real work: no statement, no body read", async () => {
  const e = await env({ IP_LIMIT_PER_60S: "2" }); const ip = freshIp();
  await get(e, "/v1/catalog", ip); await get(e, "/v1/catalog", ip);
  e.sql.length = 0;
  let bodyRead = false;
  const stream = new ReadableStream({ pull() { bodyRead = true; throw new Error("body must not be read"); } });
  const res = await get(e, "/v1/mandates", ip, { method: "POST", body: stream, duplex: "half", headers: { "content-type": "application/json" } });
  assert.equal(res.status, 429);
  assert.deepEqual(e.sql, []);
  assert.equal(bodyRead, false);
});

test("every public route counts, /health included; CORS preflight does not", async () => {
  const e = await env({ IP_LIMIT_PER_60S: "9" }); const ip = freshIp();
  for (let i = 0; i < 20; i++) assert.equal((await get(e, "/v1/catalog", ip, { method: "OPTIONS" })).status, 204);
  const paths = ["/", "/health", "/.well-known/jwks.json", "/v1/catalog", "/v1/receipts/rct_nope", "/v1/mandates/man_nope", "/nope"];
  for (const p of paths) assert.notEqual((await get(e, p, ip)).status, 429, p);
  assert.notEqual((await rpc(e, ip, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 429);
  assert.notEqual((await get(e, "/v1/receipts/verify", ip, { method: "POST", body: "{}" })).status, 429);
  for (const p of ["/health", "/v1/catalog", "/"]) assert.equal((await get(e, p, ip)).status, 429, p);
});

test("the window resets after 60 s", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T12:00:00.000Z") });
  const e = await env({ IP_LIMIT_PER_60S: "3" }); const ip = freshIp();
  for (let i = 0; i < 3; i++) await get(e, "/", ip);
  assert.equal((await get(e, "/", ip)).status, 429);
  t.mock.timers.tick(IP_PERIOD_S * 1000);
  assert.equal((await get(e, "/", ip)).status, 200);
});

test("an MCP batch counts once per message, and holds at most MCP_BATCH_MAX messages", async () => {
  assert.equal(quota.MCP_BATCH_MAX, 20);
  const e = await env({ IP_LIMIT_PER_60S: "10" }); const ip = freshIp();
  const batch = (n) => Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "tools/list" }));
  assert.equal((await rpc(e, ip, batch(MCP_BATCH_MAX + 1))).status, 400, "too many messages: refused as invalid");
  const e2 = await env({ IP_LIMIT_PER_60S: "10" }); const ip2 = freshIp();
  assert.equal((await rpc(e2, ip2, batch(6))).status, 200);
  assert.equal((await rpc(e2, ip2, batch(6))).status, 429, "6 + 6 > 10");
});

test("the binding is consulted with a salted, prefixed key (never the IP), and its refusal is final", async () => {
  const seen = [];
  let allow = true;
  const IP_RATE_LIMIT = { async limit({ key, delta }) { seen.push({ key, delta }); return { success: allow }; } };
  const e = await env({ IP_RATE_LIMIT }); const ip = "203.0.113.77";
  assert.equal((await get(e, "/v1/catalog", ip)).status, 200);
  assert.equal(seen.length, 1);
  assert.match(seen[0].key, /^ip:[0-9a-f]{64}$/);
  assert.ok(!seen[0].key.includes("203.0.113"), "the raw IP never reaches the binding");
  assert.equal(seen[0].delta, 1);
  allow = false;
  const res = await get(e, "/v1/catalog", ip);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, "rate_limited_ip");
});

test("a binding that throws does not take the arbiter down: the instance limit still applies", async () => {
  const IP_RATE_LIMIT = { async limit() { throw new Error("binding unavailable"); } };
  const e = await env({ IP_RATE_LIMIT, IP_LIMIT_PER_60S: "2" }); const ip = freshIp();
  assert.equal((await get(e, "/", ip)).status, 200);
  assert.equal((await get(e, "/", ip)).status, 200);
  assert.equal((await get(e, "/", ip)).status, 429);
});

test("in staging and production only cf-connecting-ip identifies the caller (a client can't rotate x-forwarded-for)", async () => {
  const e = await env({ IP_LIMIT_PER_60S: "3" });
  const noCf = (xff) => worker.fetch(new Request("https://arb.test/", { headers: { "x-forwarded-for": xff } }), e);
  for (let i = 0; i < 3; i++) assert.equal((await noCf(`192.0.2.${i}`)).status, 200);
  assert.equal((await noCf("192.0.2.99")).status, 429, "all share one bucket");
});

test("the instance window holds a bounded number of keys", async () => {
  const e = await env();
  for (let i = 0; i < INSTANCE_KEYS_MAX + 500; i++) await get(e, "/", `2001:db8:ffff::${i.toString(16)}`);
  assert.ok(quota.instanceLimiter?.size <= INSTANCE_KEYS_MAX, `${quota.instanceLimiter?.size} keys`);
});

test("/health says which layers are active", async () => {
  const plain = await env();
  assert.equal((await (await get(plain, "/health", freshIp())).json()).rate_limit, "instance");
  const bound = await env({ IP_RATE_LIMIT: { async limit() { return { success: true }; } } });
  assert.equal((await (await get(bound, "/health", freshIp())).json()).rate_limit, "binding+instance");
});
