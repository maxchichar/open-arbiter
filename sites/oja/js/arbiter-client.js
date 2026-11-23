// Open Arbiter browser client. A reusable component: any agentic website can copy this
// one file to negotiate through an Open Arbiter and verify its receipts.
//
// Buyer tokens stay inside this object (never in the page state, the agent's context
// or tool results), so a model or a peer network cannot accept an offer by itself.

const enc = new TextEncoder();

/** Canonical JSON (keys sorted at every level), exactly as the arbiter signs it. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export class ArbiterClient {
  #tokens = new Map(); // mandate_id -> buyer token
  #offerToMandate = new Map();
  #jwks = null;

  /**
   * @param baseUrl the arbiter's origin, such as https://arbiter.example
   * @param opts.timeoutMs how long to wait for an answer (default 20 s, under the runtime's own limit)
   */
  constructor(baseUrl, { fetchImpl, timeoutMs = 20_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.timeoutMs = timeoutMs;
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
   */
  async negotiate({ sku, quantity, maxTotal, deliverWithinHours, vendorIds }) {
    const created = await this.#call("POST", "/v1/mandates", {
      body: {
        sku, quantity, max_total_cents: Math.round(Number(maxTotal) * 100), deliver_within_hours: deliverWithinHours,
        ...(vendorIds && vendorIds.length ? { vendor_ids: vendorIds } : {}),
      },
    });
    if (!created.ok) return created;
    const { mandate_id, buyer_token } = created.data;
    this.#tokens.set(mandate_id, buyer_token);
    const resolved = await this.#call("POST", `/v1/mandates/${mandate_id}/resolve`, { token: buyer_token });
    if (!resolved.ok) return resolved;
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
   * Verify a receipt in the browser with the arbiter's published key (JWKS).
   * This does not trust the arbiter's own "verify" endpoint.
   */
  async verify({ receipt, signature, key_id }) {
    if (!this.#jwks) {
      const r = await this.#call("GET", "/.well-known/jwks.json");
      if (!r.ok) return { ok: false, reason: r.reason };
      this.#jwks = r.data.keys || [];
    }
    const jwk = this.#jwks.find((k) => !key_id || k.kid === key_id);
    if (!jwk) return { ok: true, valid: false, reason: "No published key matches this receipt." };
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, key_ops: ["verify"] },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    let valid = false;
    try {
      valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(signature), enc.encode(canonicalJson(receipt)));
    } catch { valid = false; }
    return { ok: true, valid, key_id: jwk.kid };
  }
}
