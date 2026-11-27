// P1.5 AC-5.1, 5.2, 5.4: one structured log line per request, a request id on every response and
// error body, and unexpected errors logged by class and fingerprint, never by message.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { memoryD1 } from "./sqlite-d1.mjs";
import { captureLogs, renderCalls } from "./log-capture.mjs";

const FIELDS = ["ts", "level", "request_id", "env", "version", "method", "route", "status", "code", "duration_ms"];
const OPTIONAL = ["mcp", "reason", "error_class", "error_fingerprint"];
const env = (extra = {}) => ({ DB: memoryD1(), ADMIN_TOKEN: "admin", DEV: "1", ENVIRONMENT: "test", ...extra });

async function call(e, path, { method = "GET", headers = {}, body } = {}) {
  const { result: res, calls } = await captureLogs(() => worker.fetch(new Request(`https://arb.test${path}`, {
    method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), e));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* empty or not JSON */ }
  return { res, data, calls };
}

/** The request's one log line, checked for shape. */
function line(calls) {
  assert.equal(calls.length, 1, `expected exactly one log call, got ${calls.length}: ${renderCalls(calls).join(" | ")}`);
  assert.equal(calls[0].args.length, 1, "one argument: the log object");
  const l = calls[0].args[0];
  assert.equal(typeof l, "object", "log an object, so Workers Logs indexes its fields");
  for (const f of FIELDS) assert.ok(f in l, `missing ${f}`);
  for (const k of Object.keys(l)) assert.ok(FIELDS.includes(k) || OPTIONAL.includes(k), `unexpected field ${k}`);
  assert.ok(!Number.isNaN(Date.parse(l.ts)), "ts is a date");
  assert.ok(Number.isInteger(l.duration_ms) && l.duration_ms >= 0);
  return l;
}

test("a request writes one JSON line: route template, never the raw path or query", async () => {
  const e = env();
  const { res, calls } = await call(e, "/v1/mandates/man_abcdefghijklmnop/resolve?secret=x", { method: "POST", headers: { authorization: "Bearer bt_nope" } });
  const l = line(calls);
  assert.equal(res.status, 404);
  assert.deepEqual({ method: l.method, route: l.route, status: l.status, code: l.code, env: l.env, level: l.level },
    { method: "POST", route: "/v1/mandates/:id/resolve", status: 404, code: "not_found", env: "test", level: "info" });
  assert.ok(!renderCalls(calls)[0].includes("man_abcdefghijklmnop") && !renderCalls(calls)[0].includes("secret=x"));
  // P1.6: the Worker version (version-metadata binding), the mechanism and the git commit.
  assert.deepEqual(Object.keys(l.version).sort(), ["git", "mechanism", "worker"]);
  assert.equal(l.version.worker, "local", "no version-metadata binding in this env");
});

test("route templates for every endpoint; anything else is 'unmatched'", async () => {
  const e = env();
  const cases = [
    ["GET", "/", "/"], ["GET", "/health", "/health"], ["GET", "/.well-known/jwks.json", "/.well-known/jwks.json"], ["POST", "/mcp", "/mcp"],
    ["GET", "/v1/catalog?sku=x", "/v1/catalog"], ["GET", "/v1/receipts/rct_abc", "/v1/receipts/:id"],
    ["POST", "/v1/receipts/verify", "/v1/receipts/verify"], ["GET", "/v1/audit/verify", "/v1/audit/verify"],
    ["POST", "/v1/vendors", "/v1/vendors"], ["GET", "/v1/listings", "/v1/listings"], ["POST", "/v1/mandates", "/v1/mandates"],
    ["GET", "/v1/mandates/man_abc", "/v1/mandates/:id"], ["GET", "/v1/mandates/man_abc/audit", "/v1/mandates/:id/audit"],
    ["POST", "/v1/offers/off_abc/accept", "/v1/offers/:id/accept"], ["GET", "/wp-login.php", "unmatched"], ["GET", "/v1/receipts/../etc", "unmatched"],
  ];
  for (const [method, path, route] of cases) {
    const { calls } = await call(e, path, { method, body: method === "POST" ? {} : undefined });
    assert.equal(line(calls).route, route, `${method} ${path}`);
  }
});

test("request_id comes from cf-ray, is x-request-id on the response and request_id in error bodies", async () => {
  const e = env();
  const { res, data, calls } = await call(e, "/v1/receipts/rct_nothere", { headers: { "cf-ray": "8f2a1b3c4d5e6f70-LOS" } });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("x-request-id"), "8f2a1b3c4d5e6f70-LOS");
  assert.equal(data.request_id, "8f2a1b3c4d5e6f70-LOS");
  assert.equal(data.error, "not_found");
  assert.equal(typeof data.message, "string", "error bodies keep {error, message}: ArbiterClient relies on it");
  assert.equal(line(calls).request_id, "8f2a1b3c4d5e6f70-LOS");
});

test("without cf-ray a random 16-byte hex id is made; every response carries it, OPTIONS included", async () => {
  const e = env();
  const ids = new Set();
  for (const [method, path] of [["GET", "/v1/catalog"], ["OPTIONS", "/v1/mandates"], ["GET", "/nope"]]) {
    const { res, calls } = await call(e, path, { method });
    const id = res.headers.get("x-request-id");
    assert.match(id, /^[0-9a-f]{32}$/, `${method} ${path}`);
    assert.equal(line(calls).request_id, id);
    ids.add(id);
  }
  assert.equal(ids.size, 3);
});

test("a cf-ray header that is not a plain ray id is not trusted as the request id", async () => {
  const { res } = await call(env(), "/v1/catalog", { headers: { "cf-ray": "x\" injected {json}" } });
  assert.match(res.headers.get("x-request-id"), /^[0-9a-f]{32}$/);
});

test("an unexpected error: body {error: internal, request_id}; log has class and fingerprint, not the message", async () => {
  const e = env();
  e.DB.setFault((sql) => (/FROM listings/.test(sql) ? new Error("D1_ERROR: near \"SECRET_SQL_FRAGMENT\": syntax error") : false));
  const { res, data, calls } = await call(e, "/v1/catalog");
  assert.equal(res.status, 500);
  assert.equal(data.error, "internal");
  assert.equal(data.request_id, res.headers.get("x-request-id"));
  assert.ok(!JSON.stringify(data).includes("SECRET_SQL_FRAGMENT"));
  const l = line(calls);
  assert.deepEqual({ level: l.level, code: l.code, status: l.status, error_class: l.error_class }, { level: "error", code: "internal", status: 500, error_class: "Error" });
  assert.match(l.error_fingerprint, /^[0-9a-f]{12}$/);
  assert.ok(!renderCalls(calls)[0].includes("SECRET_SQL_FRAGMENT"), "never the message");
});

test("the same failure gives the same fingerprint", async () => {
  const fp = async () => {
    const e = env();
    e.DB.setFault((sql) => (/FROM listings/.test(sql) ? new Error(`random ${Math.random()}`) : false));
    return line((await call(e, "/v1/catalog")).calls).error_fingerprint;
  };
  assert.equal(await fp(), await fp());
});

test("a misconfiguration is logged with a fixed reason, and nothing else is written", async () => {
  const e = env({ DEV: undefined });
  const { res, calls } = await call(e, "/.well-known/jwks.json");
  assert.equal(res.status, 500);
  const l = line(calls);
  assert.deepEqual({ code: l.code, reason: l.reason, level: l.level }, { code: "misconfigured", reason: "signing_key_missing", level: "error" });
});

test("MCP calls log the JSON-RPC method and the tool, and a tool's error code", async () => {
  const e = env();
  const { calls } = await call(e, "/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_receipt", arguments: { receipt_id: "rct_nothere" } } } });
  const l = line(calls);
  assert.deepEqual(l.mcp, [{ method: "tools/call", tool: "get_receipt", code: "not_found" }]);
  const { calls: c2 } = await call(e, "/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x".repeat(500) } } });
  assert.deepEqual(line(c2).mcp, [{ method: "tools/call", tool: "unknown", code: "unknown_tool" }], "a tool name from the caller is logged only if it is ours");
});
