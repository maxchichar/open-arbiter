// Cloudflare Worker entry: REST API + MCP endpoint for Open Arbiter.
import { Arbiter, ArbiterError } from "./core.js";
import { handleRpc, presentOutcome, presentCatalog, TOOLS } from "./mcp.js";
import { MECHANISM } from "./mechanism.js";
import { sha256Hex } from "./crypto.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra } });

const bearer = (req) => {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
};

async function body(req) {
  if (Number(req.headers.get("content-length") || 0) > 64_000) throw new ArbiterError("too_large", "Body over 64 KB.", 413);
  try { return await req.json(); } catch { throw new ArbiterError("invalid_json", "Body must be JSON."); }
}

/** Caller identity for anti-probing limits: a salted hash of the client IP, never stored raw. */
async function buyerKey(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "local";
  return sha256Hex(`${env.BUYER_SALT || "open-arbiter"}:${ip}`);
}

function callerOrigin(req) {
  const o = req.headers.get("origin");
  if (!o || o === "null") return null;
  try { return new URL(o).origin; } catch { return null; }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const arb = new Arbiter(env.DB, { signingJwk: env.ARBITER_SIGNING_JWK ? JSON.parse(env.ARBITER_SIGNING_JWK) : undefined });
    try {
      // ---- discovery ----
      if (req.method === "GET" && path === "/") {
        return json({
          name: "Open Arbiter",
          description: "Deterministic, sealed-bid negotiation and signed receipts for the open agentic web.",
          mechanism: MECHANISM,
          endpoints: {
            mcp: `${url.origin}/mcp`, catalog: `${url.origin}/v1/catalog`, jwks: `${url.origin}/.well-known/jwks.json`,
          },
          tools: TOOLS.map((t) => t.name),
        });
      }
      if (req.method === "GET" && path === "/.well-known/jwks.json") return json(await arb.jwks());

      // ---- MCP ----
      if (path === "/mcp") {
        if (req.method === "GET") return json({ error: "This server answers POST only (no SSE stream)." }, 405, { allow: "POST" });
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
        const msg = await body(req);
        const ctx = { buyerKey: await buyerKey(req, env), callerOrigin: callerOrigin(req) };
        if (Array.isArray(msg)) {
          const out = (await Promise.all(msg.map((m) => handleRpc(arb, m, ctx)))).filter(Boolean);
          return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
        }
        const out = await handleRpc(arb, msg, ctx);
        return out ? json(out) : new Response(null, { status: 202, headers: CORS });
      }

      // ---- public ----
      if (req.method === "GET" && path === "/v1/catalog") {
        const rows = await arb.catalog({ sku: url.searchParams.get("sku") || undefined, vendor_id: url.searchParams.get("vendor_id") || undefined });
        return json({ items: url.searchParams.get("units") === "minor" ? rows : presentCatalog(rows) });
      }
      let m;
      if (req.method === "GET" && (m = path.match(/^\/v1\/receipts\/(rct_[\w-]+)$/))) return json(await arb.getReceipt(m[1]));
      if (req.method === "POST" && path === "/v1/receipts/verify") return json(await arb.verifyReceipt(await body(req)));
      if (req.method === "GET" && path === "/v1/audit/verify") return json(await arb.verifyChain());

      // ---- admin ----
      if (req.method === "POST" && path === "/v1/vendors") {
        if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN) throw new ArbiterError("unauthorized", "Admin token required.", 401);
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
        return json(await arb.createMandate(b, { buyerKey: await buyerKey(req, env), callerOrigin: callerOrigin(req) }), 201);
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
      return json({ error: "not_found", message: `No route for ${req.method} ${path}` }, 404);
    } catch (e) {
      if (e instanceof ArbiterError) return json({ error: e.code, message: e.message }, e.status);
      console.error(e);
      return json({ error: "internal", message: "Unexpected error." }, 500);
    }
  },
};
