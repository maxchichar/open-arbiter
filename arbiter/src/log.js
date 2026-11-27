// Structured request logs (P1.5). One object per request, written with console.log so Workers Logs
// indexes its fields (Workers Logs docs, 2026-11-18). A line holds only what is built here: no
// body, header, raw path, query or error message, so sealed limits, tokens, keys and IPs cannot
// reach it (tests: arbiter/test/logging.test.mjs, redaction.test.mjs).
import { versionOf } from "./health.js";
import { sha256Hex } from "./crypto.js";

/** Route templates. The first match names the route; ids never reach the log. */
const ROUTES = [
  [/^\/$/, "/"],
  [/^\/health$/, "/health"],
  [/^\/\.well-known\/jwks\.json$/, "/.well-known/jwks.json"],
  [/^\/mcp$/, "/mcp"],
  [/^\/v1\/catalog$/, "/v1/catalog"],
  [/^\/v1\/receipts\/verify$/, "/v1/receipts/verify"],
  [/^\/v1\/receipts\/rct_[\w-]+$/, "/v1/receipts/:id"],
  [/^\/v1\/audit\/verify$/, "/v1/audit/verify"],
  [/^\/v1\/vendors$/, "/v1/vendors"],
  [/^\/v1\/listings$/, "/v1/listings"],
  [/^\/v1\/mandates$/, "/v1/mandates"],
  [/^\/v1\/mandates\/man_[\w-]+$/, "/v1/mandates/:id"],
  [/^\/v1\/mandates\/man_[\w-]+\/resolve$/, "/v1/mandates/:id/resolve"],
  [/^\/v1\/mandates\/man_[\w-]+\/audit$/, "/v1/mandates/:id/audit"],
  [/^\/v1\/offers\/off_[\w-]+\/accept$/, "/v1/offers/:id/accept"],
];

export function routeOf(req) {
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  for (const [re, name] of ROUTES) if (re.test(path)) return name;
  return "unmatched";
}

/** cf-ray when it looks like one (Cloudflare sets it; a client could send anything), else 16 random bytes in hex. */
export function requestIdFor(req) {
  const ray = req.headers.get("cf-ray");
  if (ray && /^[0-9A-Za-z-]{8,64}$/.test(ray)) return ray;
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A short, stable id for where an unexpected error came from: a hash of the function names in its
 * stack. Never the message (it may hold SQL or values) and never file positions.
 */
export async function errorFingerprint(e) {
  const frames = String(e?.stack || "").split("\n").slice(1)
    .map((l) => l.match(/^\s*at (?:async )?(?:new )?([\w$.<>]+) \(/)?.[1] || (/^\s*at /.test(l) ? "<anonymous>" : null))
    .filter(Boolean).slice(0, 12);
  return (await sha256Hex(`${e?.constructor?.name || typeof e}|${frames.join(">")}`)).slice(0, 12);
}

/** The request's log line. `extra` may hold only mcp, reason, error_class, error_fingerprint. */
export function logLine({ requestId, env, method, route, status, code, started, extra = {} }) {
  return {
    ts: new Date().toISOString(),
    level: status >= 500 ? "error" : "info",
    request_id: requestId,
    env: typeof env?.ENVIRONMENT === "string" ? env.ENVIRONMENT : "unknown",
    version: (({ worker, mechanism, git }) => ({ worker, mechanism, git }))(versionOf(env)),
    method: /^[A-Z]{3,7}$/.test(method) ? method : "OTHER",
    route,
    status,
    code,
    duration_ms: Math.max(0, Date.now() - started),
    ...extra,
  };
}
