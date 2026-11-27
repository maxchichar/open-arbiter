// Cloudflare Worker entry: REST API + MCP endpoint for Open Arbiter.
import { Arbiter, ArbiterError } from "./core.js";
import { handleRpc, presentOutcome, presentCatalog, TOOLS } from "./mcp.js";
import { MECHANISM } from "./mechanism.js";
import { sha256Hex } from "./crypto.js";
import { requestIdFor, routeOf, errorFingerprint, logLine } from "./log.js";
import { health, signingJwkOf } from "./health.js";
import { enforceIpLimit, ipHash, ipLimit, mandateCap, MCP_BATCH_MAX } from "./quota.js";
const WRITE_TOOLS = new Set(["negotiate", "accept_offer"]);
import { CATALOG_PAGE_MAX } from "./core.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers": "mcp-session-id, x-request-id, retry-after",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra } });

const bearer = (req) => {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
};

async function body(req) {
  if (Number(req.headers.get("content-length") || 0) > 64_000) throw new ArbiterError("too_large", "Body over 64 KB.");
  try { return await req.json(); } catch { throw new ArbiterError("invalid_json", "Body must be JSON."); }
}

/** Caller identity for anti-probing limits: a salted hash of the client IP, never stored raw. */
/** The anti-probing buyer key: the salted IP hash (quota.js; only cf-connecting-ip when deployed). */
const buyerKey = (req, env) => ipHash(req, env);

function callerOrigin(req) {
  const o = req.headers.get("origin");
  if (!o || o === "null") return null;
  try { return new URL(o).origin; } catch { return null; }
}

// Databases whose schema this Worker instance has checked (Arbiter.ensureSchema), so the check
// costs one query per database binding per instance, not one per write.
const schemaVerified = new WeakSet();

export default {
  /**
   * Every request: one log line (P1.5), an x-request-id header, and errors as {error, message,
   * request_id} with the registry's status. The log line never holds a body, a header, the raw
   * path or an error message: only the fields in log.js.
   */
  async fetch(req, env) {
    const started = Date.now();
    const requestId = requestIdFor(req);
    const rec = { mcp: [] };
    let res;
    let code = null;
    let extra = {};
    try {
      res = await route(req, env, rec);
    } catch (e) {
      if (e instanceof ArbiterError) {
        code = e.code;
        if (e.reason) extra.reason = e.reason;
        res = json({ error: e.code, message: e.message, request_id: requestId, ...(e.details || {}) }, e.status, e.headers);
      } else {
        code = "internal";
        extra = { error_class: e?.constructor?.name || typeof e, error_fingerprint: await errorFingerprint(e) };
        res = json({ error: "internal", message: "Unexpected error.", request_id: requestId }, 500);
      }
    }
    res.headers.set("x-request-id", requestId);
    if (rec.mcp.length) extra.mcp = rec.mcp.slice(0, 20);
    if (rec.rateLimit) extra.rate_limit = rec.rateLimit;
    console.log(logLine({ requestId, env, method: req.method, route: routeOf(req), status: res.status, code, started, extra }));
    return res;
  },
};

async function route(req, env, rec) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // P1.7: before any body or database read. An MCP batch is counted per message below.
    await enforceIpLimit(req, env, rec);
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // Before the Arbiter is built: /health reports a bad key secret instead of failing on it.
    if (req.method === "GET" && path === "/health") return json(await health(env.DB, env), 200, { "cache-control": "no-store" });
    const arb = new Arbiter(env.DB, {
      signingJwk: signingJwkOf(env) ?? undefined,
      allowGeneratedKey: env.DEV === "1", // only local development may generate a key
      schemaVerified,
      mandateCap: mandateCap(env),
    });
      // ---- discovery ----
      if (req.method === "GET" && path === "/") {
        return json({
          name: "Open Arbiter",
          description: "Deterministic, sealed-bid negotiation and signed receipts for the open agentic web.",
          mechanism: MECHANISM,
          endpoints: {
            mcp: `${url.origin}/mcp`, catalog: `${url.origin}/v1/catalog`, jwks: `${url.origin}/.well-known/jwks.json`, health: `${url.origin}/health`,
          },
          tools: TOOLS.map((t) => t.name),
          limits: { negotiations_per_item_per_day: mandateCap(env), requests_per_ip_per_minute: ipLimit(env), catalog_page_max: CATALOG_PAGE_MAX },
        });
      }
      if (req.method === "GET" && path === "/.well-known/jwks.json") return json(await arb.jwks());

      // ---- MCP ----
      if (path === "/mcp") {
        if (req.method !== "POST") throw new ArbiterError("method_not_allowed", "This server answers POST only (no SSE stream).", { headers: { allow: "POST" } });
        const msg = await body(req);
        const ctx = { buyerKey: await buyerKey(req, env), callerOrigin: callerOrigin(req), trace: (t) => rec.mcp.push(t) };
        if (Array.isArray(msg)) {
          if (msg.length > MCP_BATCH_MAX) throw new ArbiterError("invalid", `A batch holds at most ${MCP_BATCH_MAX} messages.`);
          // D1 Free: 50 queries per invocation; one negotiate costs up to 15 (P1.7).
          if (msg.filter((m) => m?.method === "tools/call" && WRITE_TOOLS.has(m?.params?.name)).length > 1) {
            throw new ArbiterError("invalid", "A batch holds at most one negotiate or accept_offer call.");
          }
          if (msg.length > 1) await enforceIpLimit(req, env, rec, msg.length - 1);
          const out = (await Promise.all(msg.map((m) => handleRpc(arb, m, ctx)))).filter(Boolean);
          return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
        }
        const out = await handleRpc(arb, msg, ctx);
        return out ? json(out) : new Response(null, { status: 202, headers: CORS });
      }

      // ---- public ----
      if (req.method === "GET" && path === "/v1/catalog") {
        const q = url.searchParams;
        const limit = q.has("limit") ? (/^\d{1,4}$/.test(q.get("limit")) ? Number(q.get("limit")) : NaN) : CATALOG_PAGE_MAX;
        const { items, next } = await arb.catalogPage({ sku: q.get("sku") || undefined, vendor_id: q.get("vendor_id") || undefined, limit, after: q.get("after") ?? undefined });
        return json({ items: q.get("units") === "minor" ? items : presentCatalog(items), next });
      }
      let m;
      if (req.method === "GET" && (m = path.match(/^\/v1\/receipts\/(rct_[\w-]+)$/))) return json(await arb.getReceipt(m[1]));
      if (req.method === "POST" && path === "/v1/receipts/verify") return json(await arb.verifyReceipt(await body(req)));
      // Reads the whole chain, so admin only (P1.7 AC-7.2); P1.12 adds signed checkpoints.
      if (req.method === "GET" && path === "/v1/audit/verify") {
        if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN) throw new ArbiterError("unauthorized", "Admin token required.");
        return json(await arb.verifyChain());
      }

      // ---- admin ----
      if (req.method === "POST" && path === "/v1/vendors") {
        if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN) throw new ArbiterError("unauthorized", "Admin token required.");
        return json(await arb.createVendor(await body(req)), 201);
      }

      // ---- vendors (Bearer vk_...) ----
      if (path === "/v1/listings") {
        const vendor = await arb.vendorByKey(bearer(req));
        if (req.method === "GET") return json({ vendor, listings: await arb.vendorListings(vendor) });
        if (req.method === "PUT") return json(await arb.upsertListing(vendor, await body(req)));
      }

      // ---- buyers (Bearer bt_...) ----
      if (req.method === "POST" && path === "/v1/mandates") {
        const b = await body(req);
        const made = await arb.createMandate(b, { buyerKey: await buyerKey(req, env), callerOrigin: callerOrigin(req) });
        return json(made, made.replayed ? 200 : 201);
      }
      if ((m = path.match(/^\/v1\/mandates\/(man_[\w-]+)(\/resolve|\/audit)?$/))) {
        const token = bearer(req);
        if (req.method === "POST" && m[2] === "/resolve") return json(presentOutcome(await arb.resolveMandate(m[1], token)));
        if (req.method === "GET" && m[2] === "/audit") return json({ events: await arb.auditTrail(m[1], token) });
        if (req.method === "GET" && !m[2]) { await arb.mandateFor(m[1], token); return json(presentOutcome(await arb.outcome(m[1]))); }
      }
      if (req.method === "POST" && (m = path.match(/^\/v1\/offers\/(off_[\w-]+)\/accept$/))) {
        return json(await arb.acceptOffer(m[1], bearer(req)));
      }
      throw new ArbiterError("not_found", `No route for ${req.method} ${path}`);
}
