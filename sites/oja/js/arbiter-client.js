// Open Arbiter browser client. A reusable component: any agentic website can copy this
// one file to negotiate through an Open Arbiter and verify its receipts.
//
// Buyer tokens stay inside this object (never in the page state, the agent's context
// or tool results), so a model or a peer network cannot accept an offer by itself.
// The buyer secret is made here; the arbiter receives only its SHA-256 when a negotiation starts.

const enc = new TextEncoder();

/** Canonical JSON (keys sorted at every level), exactly as the arbiter signs it. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export class ArbiterClient {
  #tokens = new Map(); // mandate_id -> buyer token
  #offerToMandate = new Map();
  #pending = new Map(); // terms (budget included) -> secret of a create whose answer was lost
  #pinned;
  #jwks = null;

  /**
   * @param baseUrl the arbiter's origin, such as https://arbiter.example
   * @param opts.timeoutMs how long to wait for an answer (default 20 s, under the runtime's own limit)
   * @param opts.pinnedKeys public JWKs (with kid) receipts must be signed with. Required for an
   *   arbiter that is not on this machine; without them its receipts are reported as not verified.
   */
  constructor(baseUrl, { fetchImpl, timeoutMs = 20_000, pinnedKeys = [] } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.timeoutMs = timeoutMs;
    this.#pinned = pinnedKeys.map((k) => ({ ...k }));
  }

  /**
   * One request, never retried. With `binding: true` (accepting an offer), a request that may have
   * reached the arbiter but got no answer (timeout, network error, unreadable reply) has an UNKNOWN
   * outcome: it returns { ok: false, unknown: true }, never a "nothing changed" refusal.
   */
  async #call(method, path, { body, token, binding = false, signal } = {}) {
    const host = new URL(this.baseUrl).host;
    const unknown = { ok: false, unknown: true, reason: `No answer from the arbiter at ${host}, so the outcome is unknown: it may have gone through. Check the market state before trying again.` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      return binding ? unknown : { ok: false, reason: `The arbiter at ${host} could not be reached.` };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) return { ok: false, reason: data?.message || `The arbiter answered ${res.status}.`, code: data?.error };
    if (data === null) return binding ? unknown : { ok: false, reason: `The arbiter at ${host} sent an unreadable answer.` };
    return { ok: true, data };
  }

  /** Public catalogue in major units. */
  async catalog(sku) {
    const r = await this.#call("GET", `/v1/catalog${sku ? `?sku=${encodeURIComponent(sku)}` : ""}`);
    return r.ok ? { ok: true, items: r.data.items } : r;
  }

  /**
   * Seal a mandate and resolve it in one step. `maxTotal` is in major units.
   * Returns ranked offers or no agreement; the buyer token is kept here.
   *
   * The secret is made here and only its hash is sent, so creating the mandate can be retried
   * safely: the arbiter answers a repeat with the mandate it already made. A create whose answer
   * is lost is sent once more; if that is lost too, the secret is kept for these exact terms and
   * budget, so asking again later recovers the same negotiation instead of using another attempt.
   */
  async negotiate({ sku, quantity, maxTotal, deliverWithinHours, vendorIds }) {
    const body = {
      sku, quantity, max_total_cents: Math.round(Number(maxTotal) * 100), deliver_within_hours: deliverWithinHours,
      ...(vendorIds && vendorIds.length ? { vendor_ids: [...vendorIds].sort() } : {}),
    };
    const key = canonicalJson(body);
    let token = this.#pending.get(key);
    if (!token) {
      token = `bt_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
      this.#pending.set(key, token);
    }
    const request = { ...body, buyer_token_hash: await sha256Hex(token) };
    let created;
    for (let attempt = 0; attempt < 2; attempt++) {
      created = await this.#call("POST", "/v1/mandates", { body: request, binding: true });
      if (!created.unknown) break;
    }
    if (created.unknown) {
      return { ok: false, unknown: true, reason: `${created.reason.split(":")[0]}. Nothing is lost: asking again with the same terms and maximum picks up the same negotiation without using another attempt.` };
    }
    if (!created.ok) {
      this.#pending.delete(key); // refused: nothing was made with this secret
      return created;
    }
    const { mandate_id } = created.data;
    this.#tokens.set(mandate_id, token);
    let resolved;
    for (let attempt = 0; attempt < 2; attempt++) { // resolve is idempotent: a repeat returns the stored outcome
      resolved = await this.#call("POST", `/v1/mandates/${mandate_id}/resolve`, { token });
      if (resolved.ok || resolved.code) break;
    }
    if (!resolved.ok) return resolved; // the secret stays pending: asking again resumes this mandate
    this.#pending.delete(key);
    for (const o of resolved.data.offers) this.#offerToMandate.set(o.offer_id, mandate_id);
    return { ok: true, outcome: resolved.data };
  }

  /** Refresh a negotiation's state (offers expire after 15 minutes). */
  async outcome(mandateId) {
    const token = this.#tokens.get(mandateId);
    if (!token) return { ok: false, reason: "That negotiation was not started on this page." };
    const r = await this.#call("GET", `/v1/mandates/${mandateId}`, { token });
    return r.ok ? { ok: true, outcome: r.data } : r;
  }

  /**
   * Accept one offer. Binding: reserves stock and returns a signed receipt. Sent once, never retried;
   * a lost answer is { ok: false, unknown: true }.
   */
  async accept(offerId, { signal } = {}) {
    const mandateId = this.#offerToMandate.get(offerId);
    const token = mandateId && this.#tokens.get(mandateId);
    if (!token) return { ok: false, reason: "That offer did not come from a negotiation on this page." };
    const r = await this.#call("POST", `/v1/offers/${offerId}/accept`, { token, binding: true, signal });
    return r.ok ? { ok: true, ...r.data } : r;
  }

  async receipt(receiptId) {
    const r = await this.#call("GET", `/v1/receipts/${encodeURIComponent(receiptId)}`);
    return r.ok ? { ok: true, ...r.data } : r;
  }

  /**
   * Verify a receipt in the browser. With pinned keys (the normal case), the receipt must be signed
   * by the pinned key whose kid equals its key_id; nothing the arbiter serves is trusted. Without
   * pinned keys this works only for an arbiter on this machine (development), using its JWKS, and
   * says so in `key_source`. Any other arbiter's receipts are reported as not verified.
   */
  async verify({ receipt, signature, key_id }) {
    let jwk, source;
    if (this.#pinned.length) {
      jwk = this.#pinned.find((k) => k.kid === key_id);
      source = "pinned";
      if (!jwk) return { ok: true, valid: false, key_source: source, reason: "This receipt is not signed with the arbiter key pinned in this site." };
    } else if (LOOPBACK.has(new URL(this.baseUrl).hostname)) {
      if (!this.#jwks) {
        const r = await this.#call("GET", "/.well-known/jwks.json");
        if (!r.ok) return { ok: false, reason: r.reason };
        this.#jwks = r.data.keys || [];
      }
      jwk = this.#jwks.find((k) => k.kid === key_id);
      source = "dev-jwks";
      if (!jwk) return { ok: true, valid: false, key_source: source, reason: "No published key matches this receipt." };
    } else {
      return { ok: true, valid: false, key_source: "none", reason: "No arbiter key is pinned in this site, so receipts cannot be verified." };
    }
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, key_ops: ["verify"] },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    let valid = false;
    try {
      valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(signature), enc.encode(canonicalJson(receipt)));
    } catch { valid = false; }
    return { ok: true, valid, key_id: jwk.kid, key_source: source };
  }
}
