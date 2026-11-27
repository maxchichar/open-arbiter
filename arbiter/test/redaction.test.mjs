// P1.5 AC-5.5: drive every endpoint and MCP tool, success and failure paths, with sentinel values,
// and check that no log line holds any of them (raw, kobo, naira or hex). Also checks AC-5.3 at run
// time: every error response's status is its code's status in the registry.
// The cron handler does not exist yet (P1.12 writes it); this test drives worker.scheduled once it does.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { ERRORS } from "../src/errors.js";
import { generateSigningKey, newToken, sha256Hex } from "../src/crypto.js";
import { memoryD1 } from "./sqlite-d1.mjs";
import { captureLogs, renderCalls } from "./log-capture.mjs";

// ₦900,000 list (step ₦12,800, so a floor may be at most ₦896,000).
const ASK = 90_000_000;
const FLOOR = 73_149_683; // ₦731,496.83
const MAX = 187_654_321; // ₦1,876,543.21 for 2 units
const IP = "203.0.113.77";
const ADMIN = "adm_SENTINEL_9c1f4e2b7a";
const SALT = "salt_SENTINEL_5d8e3a1c";
const RAY = "redactionray-LOS"; // fixed, so no random id can collide with a numeric sentinel

const amountVariants = (kobo) => {
  const naira = kobo / 100;
  return [String(kobo), naira.toFixed(2), String(Math.floor(naira)), kobo.toString(16), Math.floor(naira).toString(16)];
};

async function drive({ withKey = true, faults = false } = {}) {
  const { privateJwk } = await generateSigningKey();
  const db = memoryD1();
  // A high per-IP limit, so the drive reaches every route; the last step drops it to reach the 429.
  const env = { DB: db, ADMIN_TOKEN: ADMIN, BUYER_SALT: SALT, ENVIRONMENT: "test", IP_LIMIT_PER_60S: "1000000", ...(withKey ? { ARBITER_SIGNING_JWK: JSON.stringify(privateJwk) } : {}) };
  const secrets = [ADMIN, SALT, IP, privateJwk.d, ...amountVariants(FLOOR), ...amountVariants(MAX)];
  const responses = [];
  const f = async (path, { method = "GET", token, body, raw } = {}) => {
    const res = await worker.fetch(new Request(`https://arb.test${path}`, {
      method,
      headers: { "content-type": "application/json", "cf-connecting-ip": IP, "cf-ray": RAY, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    }), env);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    responses.push({ path, method, status: res.status, data });
    return { status: res.status, data };
  };
  const rpc = (method, params, id = 1) => f("/mcp", { method: "POST", body: { jsonrpc: "2.0", id, method, params } });

  const { calls } = await captureLogs(async () => {
    // discovery
    await f("/"); await f("/health"); await f("/.well-known/jwks.json");
    // admin
    await f("/v1/vendors", { method: "POST", body: { name: "No token" } });
    await f("/v1/vendors", { method: "POST", token: "wrong", body: { name: "Wrong token" } });
    await f("/v1/vendors", { method: "POST", token: ADMIN, body: { name: "" } });
    await f("/v1/vendors", { method: "POST", token: ADMIN, raw: "{not json" });
    await f("/v1/vendors", { method: "POST", token: ADMIN, raw: JSON.stringify({ name: "x".repeat(70_000) }) });
    const v = (await f("/v1/vendors", { method: "POST", token: ADMIN, body: { name: "Iya Basira", origin: "https://iya.example" } })).data;
    secrets.push(v.api_key, await sha256Hex(v.api_key));
    // vendor
    const listing = { sku: "rice-50kg", title: "Rice", unit: "bag", ask_cents: ASK, floor_cents: FLOOR, delivery_hours: 24, stock: 9 };
    await f("/v1/listings", { method: "PUT", token: "vk_wrong", body: listing });
    await f("/v1/listings", { method: "PUT", token: v.api_key, body: { ...listing, floor_cents: ASK + 1 } });
    await f("/v1/listings", { method: "PUT", token: v.api_key, body: listing });
    await f("/v1/listings", { token: v.api_key });
    // public
    await f("/v1/catalog"); await f("/v1/catalog?units=minor"); await f("/v1/catalog?sku=rice-50kg");
    // buyer, client-made secret
    const secret = newToken("bt");
    const hash = await sha256Hex(secret);
    secrets.push(secret, hash);
    const terms = { sku: "rice-50kg", quantity: 2, max_total_cents: MAX, deliver_within_hours: 48 };
    await f("/v1/mandates", { method: "POST", body: { ...terms, quantity: 0 } });
    const m = (await f("/v1/mandates", { method: "POST", body: { ...terms, buyer_token_hash: hash } })).data;
    await f("/v1/mandates", { method: "POST", body: { ...terms, buyer_token_hash: hash } }); // replay
    await f("/v1/mandates", { method: "POST", body: { ...terms, max_total_cents: MAX + 100, buyer_token_hash: hash } }); // token_reused
    await f("/v1/mandates", { method: "POST", body: { ...terms, max_total_cents: MAX + 100 } }); // identical_terms
    await f(`/v1/mandates/${m.mandate_id}/resolve`, { method: "POST", token: "bt_wrong" });
    const out = (await f(`/v1/mandates/${m.mandate_id}/resolve`, { method: "POST", token: secret })).data;
    await f(`/v1/mandates/${m.mandate_id}/resolve`, { method: "POST", token: secret });
    await f(`/v1/mandates/${m.mandate_id}`, { token: secret });
    await f(`/v1/mandates/${m.mandate_id}/audit`, { token: secret });
    await f(`/v1/mandates/${m.mandate_id}/audit`, { token: "bt_wrong" });
    const offer = out.offers?.[0];
    await f(`/v1/offers/${offer?.offer_id ?? "off_none"}/accept`, { method: "POST", token: "bt_wrong" });
    await f("/v1/offers/off_unknown/accept", { method: "POST", token: secret });
    const receipt = (await f(`/v1/offers/${offer?.offer_id ?? "off_none"}/accept`, { method: "POST", token: secret })).data;
    await f(`/v1/offers/${offer?.offer_id ?? "off_none"}/accept`, { method: "POST", token: secret }); // already settled
    // server-made token, then the daily cap
    const s2 = (await f("/v1/mandates", { method: "POST", body: { ...terms, deliver_within_hours: 72 } })).data;
    if (s2?.buyer_token) secrets.push(s2.buyer_token);
    await f("/v1/mandates", { method: "POST", body: { ...terms, deliver_within_hours: 96 } });
    await f("/v1/mandates", { method: "POST", body: { ...terms, deliver_within_hours: 120 } });
    // receipts and audit
    await f(`/v1/receipts/${receipt?.receipt?.receipt_id ?? "rct_none"}`);
    await f("/v1/receipts/rct_unknown");
    await f("/v1/receipts/verify", { method: "POST", body: receipt });
    await f("/v1/receipts/verify", { method: "POST", body: { receipt: { receipt_id: "rct_x" }, signature: "AAAA" } });
    await f("/v1/audit/verify");
    await f("/v1/audit/verify", { token: ADMIN });
    await f("/v1/catalog?limit=1"); await f("/v1/catalog?after=bad"); await f("/v1/catalog?limit=0");
    // MCP
    await rpc("initialize", {}); await rpc("ping", {}); await rpc("tools/list", {});
    await rpc("tools/call", { name: "list_catalog", arguments: {} });
    const neg = (await rpc("tools/call", { name: "negotiate", arguments: { sku: "rice-50kg", quantity: 2, max_total: MAX / 100, deliver_within_hours: 24 } })).data;
    const mcpToken = neg?.result?.structuredContent?.buyer_token;
    if (mcpToken) secrets.push(mcpToken);
    await rpc("tools/call", { name: "negotiate", arguments: { sku: "rice-50kg", quantity: 2, max_total: MAX / 100, deliver_within_hours: 24 } });
    await rpc("tools/call", { name: "accept_offer", arguments: { offer_id: "off_unknown", buyer_token: mcpToken ?? "bt_x" } });
    await rpc("tools/call", { name: "get_receipt", arguments: { receipt_id: "rct_unknown" } });
    await rpc("tools/call", { name: "verify_receipt", arguments: { receipt: { receipt_id: "rct_x" }, signature: "AAAA" } });
    await rpc("tools/call", { name: "no_such_tool", arguments: {} });
    await rpc("no/such/method", {});
    await f("/mcp", { method: "POST", body: [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }] });
    await f("/mcp", { method: "POST", raw: "{oops" });
    await f("/mcp");
    await f("/mcp", { method: "POST", body: Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })) });
    await f("/mcp", { method: "DELETE" });
    await f("/nowhere"); await f("/v1/mandates", { method: "OPTIONS" });
    // unexpected errors whose messages hold sentinels
    if (faults) {
      db.setFault((sql) => (/INSERT INTO events|FROM listings/.test(sql) ? new Error(`D1_ERROR: near "${FLOOR}" admin=${ADMIN} jwk=${privateJwk.d} ip=${IP}`) : false));
      await f("/v1/catalog");
      await f("/v1/mandates", { method: "POST", body: { ...terms, deliver_within_hours: 200 } });
      await f("/v1/listings", { method: "PUT", token: v.api_key, body: listing });
      db.setFault(null);
    }
    // P1.7: over the per-IP limit (this IP has made many requests this window).
    env.IP_LIMIT_PER_60S = "1";
    await f("/v1/catalog");
    env.IP_LIMIT_PER_60S = "1000000";
    if (typeof worker.scheduled === "function") {
      await worker.scheduled({ cron: "0 2 * * *", scheduledTime: Date.now() }, env, { waitUntil() {} });
    }
  });
  return { calls, secrets, responses };
}

function assertClean({ calls, secrets }) {
  const lines = renderCalls(calls);
  const leaks = [];
  for (const [i, l] of lines.entries()) for (const s of secrets) if (s && l.includes(s)) leaks.push(`line ${i} holds ${s.length > 12 ? `${s.slice(0, 6)}…` : s}`);
  assert.deepEqual(leaks, []);
}

test("no log line holds a floor, a maximum, a buyer secret or token, the admin token, a vendor key, the JWK d, the salt or the IP", async () => {
  const run = await drive();
  assert.ok(run.responses.length >= 50, `drove ${run.responses.length} requests`);
  assert.equal(run.calls.length, run.responses.length, "one log line per request");
  assertClean(run);
});

test("the same, when unexpected errors carry sentinels in their messages", async () => {
  const run = await drive({ faults: true });
  assert.ok(run.responses.some((r) => r.status === 500 && r.data?.error === "internal"), "an internal error was driven");
  assertClean(run);
});

test("the same, with no signing key (misconfigured paths)", async () => {
  const run = await drive({ withKey: false });
  assert.ok(run.responses.some((r) => r.data?.error === "misconfigured"));
  assertClean(run);
});

test("every error response uses its code's registry status and carries request_id", async () => {
  const run = await drive({ faults: true });
  const bad = [];
  for (const r of run.responses) {
    if (r.status < 400 || !r.data || Array.isArray(r.data)) continue;
    const code = r.data.error;
    if (!(code in ERRORS)) bad.push(`${r.method} ${r.path}: ${r.status} with unregistered code ${JSON.stringify(code)}`);
    else if (ERRORS[code].status !== r.status) bad.push(`${r.method} ${r.path}: ${code} is ${ERRORS[code].status} in the registry, sent ${r.status}`);
    if (r.data.request_id !== RAY) bad.push(`${r.method} ${r.path}: no request_id`);
  }
  assert.deepEqual(bad, []);
  assert.ok(run.responses.some((r) => r.data?.error === "rate_limited_ip"), "the drive reached the per-IP limit");
  assert.ok(run.responses.some((r) => r.path === "/v1/audit/verify" && r.status === 401), "chain verify without the admin token");
});
