// P1.7 AC-7.2: no public endpoint reads more than O(page size) rows per call, on 10,000 listings
// and 10,000 events. Two checks, on the same SQLite engine D1 runs: every statement a public
// request runs is planned without an unbounded scan of a business table (EXPLAIN QUERY PLAN), and
// the rows it returns are at most a page. Full chain verification is admin-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import * as core from "../src/core.js";
import { generateSigningKey } from "../src/crypto.js";
import { memoryD1 } from "./sqlite-d1.mjs";

const N = 10_000;
const CATALOG_PAGE_MAX = core.CATALOG_PAGE_MAX ?? 100; // P1.7 exports it; the red run predates the export
const TABLES = /\b(listings|events|mandates|offers|receipts|vendors)\b/;

/** 10,000 listings over 100 skus and 100 vendors, and 10,000 chained-looking events over 2,000 mandates. */
async function bigEnv() {
  const { privateJwk } = await generateSigningKey();
  const DB = memoryD1();
  const raw = DB.raw;
  raw.exec("BEGIN");
  const v = raw.prepare("INSERT INTO vendors (id, name, origin, key_hash, created_at) VALUES (?,?,?,?,?)");
  for (let i = 0; i < 100; i++) v.run(`ven_${i}`, `Vendor ${i}`, null, `kh_${i}`, 1);
  const l = raw.prepare("INSERT INTO listings (vendor_id, sku, title, unit, currency, ask_cents, floor_cents, delivery_hours, stock, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < N; i++) l.run(`ven_${i % 100}`, `sku-${String(Math.floor(i / 100)).padStart(3, "0")}`, `Item ${i}`, "bag", "NGN", 1_000_000 + (i % 100) * 10_000, 900_000, 24, 5, 1);
  const ev = raw.prepare("INSERT INTO events (mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (?,?,?,?,?,?)");
  for (let i = 0; i < N; i++) ev.run(`man_${i % 2000}`, "X", "{}", `p${i}`, `h${i}`, 1);
  raw.exec("COMMIT");
  const sql = [];
  DB.setFault((s) => { sql.push(s); return false; });
  return { env: { DB, ADMIN_TOKEN: "adm_BOUNDED", BUYER_SALT: "s", ENVIRONMENT: "staging", ARBITER_SIGNING_JWK: JSON.stringify(privateJwk) }, sql, raw };
}

let ip = 0;
const call = (env, path, init = {}) => worker.fetch(new Request(`https://arb.test${path}`, { ...init, headers: { "cf-connecting-ip": `2001:db8:2::${(++ip).toString(16)}`, ...(init.headers || {}) } }), env);

/** Each statement's plan lines that read a business table without a bound. */
function unboundedScans(raw, sql) {
  const bad = [];
  for (const s of new Set(sql)) {
    if (!TABLES.test(s) || /^\s*(INSERT|UPDATE|DELETE)/i.test(s) && !/SELECT/i.test(s)) continue;
    const params = (s.match(/\?\d*/g) || []).length;
    let plan;
    try { plan = raw.prepare(`EXPLAIN QUERY PLAN ${s}`).all(...Array(params).fill(null)).map((r) => r.detail); } catch { continue; }
    const limited = /\bLIMIT\b/i.test(s);
    const sorts = plan.some((d) => /USE TEMP B-TREE/.test(d));
    // A LIMITed statement with no WHERE and no sort (e.g. the chain head: ORDER BY seq DESC LIMIT 1)
    // walks rowid or index order and stops at the limit.
    if (limited && !sorts && !/\bWHERE\b/i.test(s)) continue;
    for (const d of plan) {
      const scan = /^SCAN /.test(d) && !/^SCAN (d1_migrations|signing_keys|CONSTANT ROW)\b/.test(d);
      if (scan && !(limited && /USING (COVERING )?INDEX/.test(d))) bad.push(`${d}  <=  ${s.replace(/\s+/g, " ").slice(0, 120)}`);
      if (/USE TEMP B-TREE FOR ORDER BY/.test(d) && limited) bad.push(`${d} (sorts every row before LIMIT)  <=  ${s.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  return bad;
}

test("/v1/catalog returns at most a page, with a cursor that walks every listing once, in order", async () => {
  assert.equal(core.CATALOG_PAGE_MAX, 100);
  const { env, sql, raw } = await bigEnv();
  const seen = [];
  let next = null, pages = 0;
  do {
    const res = await call(env, `/v1/catalog?units=minor${next ? `&after=${encodeURIComponent(next)}` : ""}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.items.length <= CATALOG_PAGE_MAX);
    seen.push(...body.items.map((x) => `${x.sku}|${x.ask_cents}|${x.vendor_id}`));
    next = body.next;
    pages++;
  } while (next && pages < 200);
  assert.equal(seen.length, N, "every listing once");
  assert.equal(new Set(seen).size, N);
  const sorted = [...seen].sort((a, b) => { const [sa, aa, va] = a.split("|"), [sb, ab, vb] = b.split("|"); return sa.localeCompare(sb) || aa - ab || va.localeCompare(vb); });
  assert.deepEqual(seen, sorted, "ordered by sku, list price, vendor");
  assert.deepEqual(unboundedScans(raw, sql), []);
});

test("/v1/catalog: limit and sku filters are bounded too; a bad cursor or limit is 400 invalid", async () => {
  const { env, sql, raw } = await bigEnv();
  const small = await (await call(env, "/v1/catalog?limit=5")).json();
  assert.equal(small.items.length, 5);
  assert.equal(typeof small.next, "string");
  const sku = await (await call(env, "/v1/catalog?sku=sku-042")).json();
  assert.equal(sku.items.length, 100);
  assert.ok(sku.items.every((x) => x.sku === "sku-042"));
  assert.equal(sku.next ?? null, null, "a sku with exactly a page has no next page");
  const vendor = await (await call(env, "/v1/catalog?vendor_id=ven_7")).json();
  assert.equal(vendor.items.length, 100);
  for (const bad of ["limit=0", "limit=101", "limit=x", "after=not-a-cursor", "after=" + "A".repeat(600)]) {
    const res = await call(env, `/v1/catalog?${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal((await res.json()).error, "invalid");
  }
  assert.deepEqual(unboundedScans(raw, sql), []);
});

test("MCP list_catalog is bounded the same way and takes the cursor", async () => {
  const { env, sql, raw } = await bigEnv();
  const rpc = async (args) => (await (await call(env, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_catalog", arguments: args } }) })).json()).result.structuredContent;
  const first = await rpc({});
  assert.equal(first.items.length, CATALOG_PAGE_MAX);
  assert.equal(typeof first.next, "string");
  const second = await rpc({ after: first.next });
  assert.notEqual(second.items[0].sku + second.items[0].vendor_id, first.items[0].sku + first.items[0].vendor_id);
  assert.deepEqual(unboundedScans(raw, sql), []);
});

test("full chain verification is admin-only", async () => {
  const { env } = await bigEnv();
  assert.equal((await call(env, "/v1/audit/verify")).status, 401);
  assert.equal((await call(env, "/v1/audit/verify", { headers: { authorization: "Bearer wrong" } })).status, 401);
  const ok = await call(env, "/v1/audit/verify", { headers: { authorization: "Bearer adm_BOUNDED" } });
  assert.equal(ok.status, 200);
});

test("every other public route is planned without an unbounded scan", async () => {
  const { env, sql, raw } = await bigEnv();
  // A real mandate on a sku with 100 listings: create runs the anti-probing count and the
  // negotiation (listings by sku, the resolve guard on events); its token reaches the reads.
  const made = await call(env, "/v1/mandates", { method: "POST", body: JSON.stringify({ sku: "sku-042", quantity: 1, max_total_cents: 1_500_000, deliver_within_hours: 48 }) });
  assert.equal(made.status, 201, await made.clone().text());
  const { mandate_id: mid, buyer_token } = await made.json();
  const own = { authorization: `Bearer ${buyer_token}` };
  for (const [p, init] of [
    [`/v1/mandates/${mid}`, { headers: own }], [`/v1/mandates/${mid}/audit`, { headers: own }], [`/v1/mandates/${mid}/resolve`, { method: "POST", headers: own }],
  ]) assert.equal((await call(env, p, init)).status, 200, p);
  const tok = { authorization: "Bearer bt_nope" };
  for (const [p, init] of [
    ["/", {}], ["/health", {}], ["/.well-known/jwks.json", {}],
    ["/v1/receipts/rct_nope", {}], ["/v1/receipts/verify", { method: "POST", body: JSON.stringify({ receipt: { receipt_id: "rct_x" }, signature: "x" }) }],
    ["/v1/mandates/man_17", { headers: tok }], ["/v1/mandates/man_17/audit", { headers: tok }],
    ["/v1/mandates/man_17/resolve", { method: "POST", headers: tok }], ["/v1/offers/off_x/accept", { method: "POST", headers: tok }],
    ["/v1/listings", { headers: { authorization: "Bearer vk_nope" } }],
  ]) await call(env, p, init);
  assert.ok(sql.length > 5, "the routes ran statements");
  assert.deepEqual(unboundedScans(raw, sql), []);
});

test("the statements resolve and the audit trail use are indexed by mandate (events_by_mandate)", async () => {
  const { raw } = await bigEnv();
  const plan = (s) => raw.prepare(`EXPLAIN QUERY PLAN ${s}`).all("man_1").map((r) => r.detail).join(" | ");
  assert.match(plan("SELECT seq, kind, payload, prev_hash, hash, created_at FROM events WHERE mandate_id = ? ORDER BY seq"), /SEARCH events USING (COVERING )?INDEX events_by_mandate/);
  assert.match(plan("SELECT 1 FROM events WHERE mandate_id = ? AND kind IN ('BARGAINING_RESOLVED', 'NO_AGREEMENT')"), /USING (COVERING )?INDEX events_by_mandate/);
  assert.match(plan("SELECT * FROM listings WHERE sku = ?"), /SEARCH listings USING (COVERING )?INDEX listings_by_sku/);
});
