// Quota protection (P1.7 AC-7.3): a per-IP rate limit on every request but CORS preflight, checked
// before the Worker reads a body or the database. Two layers:
//   1. a fixed 60 s window per Worker instance (always on; costs no D1 or KV quota), and
//   2. where it is bound, the Workers rate-limiting binding IP_RATE_LIMIT (per Cloudflare location,
//      approximate and eventually consistent, per its docs, dateModified 2026-11-12).
// A limiter in D1 or KV is ruled out: it would spend the Free plan's 100,000 D1 rows written or
// 1,000 KV writes a day on every request it guards.
// The key is the salted hash of the caller's IP, never the IP. The docs advise against IP keys
// because addresses are shared (carrier-grade NAT is common on Nigerian mobile networks), so the
// limit is generous; it bounds a single client's burst, not a distributed one (README, Limits).
import { ArbiterError } from "./errors.js";
import { sha256Hex } from "./crypto.js";
import { DEPLOYED_ENVS } from "./health.js";

export const IP_LIMIT_DEFAULT = 100; // requests per IP per 60 s, unless IP_LIMIT_PER_60S says otherwise
export const IP_PERIOD_S = 60; // the binding allows 10 or 60
export const MCP_BATCH_MAX = 20; // messages in one JSON-RPC batch
export const INSTANCE_KEYS_MAX = 10_000; // keys one instance keeps (about 1 MB)

/**
 * The caller's address. Staging and production trust only cf-connecting-ip, which Cloudflare sets
 * and a client cannot; without it every request shares the "unknown" bucket. Local dev also takes
 * x-forwarded-for, for scripts that simulate several buyers.
 */
export function callerIp(req, env) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  if (DEPLOYED_ENVS.has(env?.ENVIRONMENT)) return "unknown";
  return req.headers.get("x-forwarded-for") || "local";
}

/** The salted IP hash: the anti-probing buyer key, and (prefixed) the rate-limit key. */
export async function ipHash(req, env) {
  return sha256Hex(`${env.BUYER_SALT || "open-arbiter"}:${callerIp(req, env)}`);
}

export function ipLimit(env) {
  const n = Number(env?.IP_LIMIT_PER_60S);
  return Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000 ? n : IP_LIMIT_DEFAULT;
}

/** A fixed window per key. Refuses when count + delta would pass the limit. */
class InstanceWindow {
  #map = new Map(); // key -> { w: window number, n: count }; insertion order = age
  get size() { return this.#map.size; }
  take(key, delta, limit, now) {
    const w = Math.floor(now / (IP_PERIOD_S * 1000));
    let e = this.#map.get(key);
    if (!e || e.w !== w) {
      e = { w, n: 0 };
      this.#map.delete(key);
      this.#map.set(key, e);
      if (this.#map.size > INSTANCE_KEYS_MAX) this.#prune(w);
    }
    if (e.n + delta > limit) return false;
    e.n += delta;
    return true;
  }
  #prune(w) {
    for (const [k, e] of this.#map) if (e.w !== w) this.#map.delete(k);
    // Still full in one window: drop the oldest keys. A flood of addresses can evict a counted key;
    // the binding (per location) is not affected.
    for (const k of this.#map.keys()) { if (this.#map.size <= INSTANCE_KEYS_MAX) break; this.#map.delete(k); }
  }
}
export const instanceLimiter = new InstanceWindow();

const refuse = (reason) => new ArbiterError("rate_limited_ip", `Too many requests from this address. Retry in ${IP_PERIOD_S} s.`, { reason, headers: { "retry-after": String(IP_PERIOD_S) } });

/**
 * Counts `delta` requests for this caller; throws 429 rate_limited_ip over the limit. A binding that
 * throws is noted in `rec` and skipped: the instance window still applies.
 */
export async function enforceIpLimit(req, env, rec, delta = 1) {
  const key = `ip:${await ipHash(req, env)}`;
  if (!instanceLimiter.take(key, delta, ipLimit(env), Date.now())) throw refuse("ip_limit_instance");
  if (env?.IP_RATE_LIMIT?.limit) {
    let ok = true;
    try { ok = (await env.IP_RATE_LIMIT.limit({ key, delta })).success !== false; } catch { if (rec) rec.rateLimit = "binding_error"; }
    if (!ok) throw refuse("ip_limit_binding");
  }
}
