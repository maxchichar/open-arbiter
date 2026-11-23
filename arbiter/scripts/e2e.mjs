// End-to-end check against a running arbiter (local or deployed), over REST and MCP.
//   node scripts/e2e.mjs http://localhost:8787
import assert from "node:assert/strict";

const base = process.argv[2] || "http://localhost:8787";
const origin = "https://oja-demo.example";
const call = async (method, path, { body, token } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, cors: r.headers.get("access-control-allow-origin"), data: text ? JSON.parse(text) : null };
};
const rpc = async (method, params, id = 1) => (await call("POST", "/mcp", { body: { jsonrpc: "2.0", id, method, params } })).data;

const run = Date.now() % 1000; // vary terms so reruns are not refused as identical
const cat = await call("GET", "/v1/catalog?sku=rice-50kg");
assert.equal(cat.status, 200);
assert.equal(cat.cors, "*");
assert.ok(cat.data.items.length >= 2, "seeded rice listings");
assert.ok(!JSON.stringify(cat.data).includes("floor"));
console.log(`catalog: ${cat.data.items.length} rice listings, no floors exposed`);

// REST flow
const man = await call("POST", "/v1/mandates", { body: { sku: "rice-50kg", quantity: 2, max_total_cents: 17_600_000, deliver_within_hours: 30 + (run % 40) } });
assert.equal(man.status, 201, JSON.stringify(man.data));
const out = await call("POST", `/v1/mandates/${man.data.mandate_id}/resolve`, { token: man.data.buyer_token });
assert.equal(out.status, 200);
console.log("REST offers:", out.data.offers.map((o) => `${o.vendor_name} ₦${o.total.toLocaleString()} (list ₦${o.list_total.toLocaleString()}, ${o.delivery_hours}h)`).join("; "));
assert.ok(!JSON.stringify(out.data).includes("17600000"));
const acc = await call("POST", `/v1/offers/${out.data.offers[0].offer_id}/accept`, { token: man.data.buyer_token });
assert.equal(acc.status, 200, JSON.stringify(acc.data));
const ver = await call("POST", "/v1/receipts/verify", { body: acc.data });
assert.equal(ver.data.valid, true);
const tampered = await call("POST", "/v1/receipts/verify", { body: { ...acc.data, receipt: { ...acc.data.receipt, total_cents: 100 } } });
assert.equal(tampered.data.valid, false);
console.log(`receipt ${acc.data.receipt.receipt_id} signed by key ${acc.data.key_id}; verifies, tampered copy fails`);
const again = await call("POST", "/v1/mandates", { body: { sku: "rice-50kg", quantity: 2, max_total_cents: 18_000_000, deliver_within_hours: 30 + (run % 40) } });
assert.equal(again.status, 409);
console.log(`same terms, new budget -> ${again.status} ${again.data.error}`);

// MCP flow
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
assert.equal(init.result.serverInfo.name, "open-arbiter");
const tools = await rpc("tools/list", {});
assert.deepEqual(tools.result.tools.map((t) => t.name), ["list_catalog", "negotiate", "accept_offer", "get_receipt", "verify_receipt"]);
const neg = await rpc("tools/call", { name: "negotiate", arguments: { sku: "garri-ijebu-50kg", quantity: 3, max_total: 150000, deliver_within_hours: 48 + (run % 40) } });
assert.ok(!neg.result.isError, JSON.stringify(neg));
const n = neg.result.structuredContent;
console.log("MCP offers:", n.offers.map((o) => `${o.vendor_name} ₦${o.total.toLocaleString()}`).join("; "));
const none = await rpc("tools/call", { name: "negotiate", arguments: { sku: "palm-oil-25l", quantity: 1, max_total: 40000, deliver_within_hours: 24 + (run % 40) } });
assert.equal(none.result.structuredContent.agreement, false);
console.log(`MCP low bid -> agreement=false: "${none.result.structuredContent.message}"`);
const audit = await call("GET", "/v1/audit/verify");
assert.equal(audit.data.ok, true);
console.log(`audit chain intact: ${audit.data.events} events`);
console.log("E2E OK");
