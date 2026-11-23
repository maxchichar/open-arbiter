// Open Arbiter service logic over a D1-compatible database.
// `db` needs prepare(sql).bind(...).first() / .all() / .run(), as Cloudflare D1 provides.
import { MECHANISM, LIMITS, checkListing, checkMandate, termsKey, resolve, canonicalJson } from "./mechanism.js";
import { newId, newToken, sha256Hex, generateSigningKey, publicFromPrivate, keyId, signPayload, verifyPayload } from "./crypto.js";

export class ArbiterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const DAY = 86_400;

export class Arbiter {
  /**
   * @param db D1Database (or the Node adapter in test/sqlite-d1.mjs)
   * @param opts.clock () => seconds since epoch
   * @param opts.signingJwk private ECDSA P-256 JWK
   * @param opts.allowGeneratedKey local development only: with no signingJwk, generate a key and
   *   keep it in the db. Otherwise a missing key fails closed ("misconfigured").
   */
  constructor(db, { clock = () => Math.floor(Date.now() / 1000), signingJwk, allowGeneratedKey = false } = {}) {
    this.db = db;
    this.clock = clock;
    this._signingJwk = signingJwk || null;
    this._allowGeneratedKey = allowGeneratedKey === true;
    this._key = null;
  }

  // ---------- helpers ----------
  q(sql, ...args) {
    return this.db.prepare(sql).bind(...args);
  }

  async key() {
    if (this._key) return this._key;
    let priv = this._signingJwk;
    if (!priv && !this._allowGeneratedKey) {
      console.error("Open Arbiter: ARBITER_SIGNING_JWK is not set and DEV is not \"1\"; refusing to sign.");
      throw new ArbiterError("misconfigured", "Signing key not configured.", 500);
    }
    if (!priv) {
      const row = await this.q("SELECT private_jwk FROM signing_keys ORDER BY created_at LIMIT 1").first();
      if (row) priv = JSON.parse(row.private_jwk);
      else {
        const k = await generateSigningKey();
        priv = k.privateJwk;
        const kid = await keyId(k.publicJwk);
        await this.q("INSERT OR IGNORE INTO signing_keys VALUES (?,?,?,?)", kid, JSON.stringify(priv), JSON.stringify(k.publicJwk), this.clock()).run();
        const winner = await this.q("SELECT private_jwk FROM signing_keys ORDER BY created_at LIMIT 1").first();
        priv = JSON.parse(winner.private_jwk);
      }
    }
    const pub = publicFromPrivate(priv);
    const kid = await keyId(pub);
    this._key = { privateJwk: priv, publicJwk: { ...pub, kid }, kid };
    return this._key;
  }

  async jwks() {
    const { publicJwk } = await this.key();
    return { keys: [publicJwk] };
  }

  async event(mandateId, kind, payload) {
    const last = await this.q("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").first();
    const prev = last ? last.hash : "genesis";
    const at = this.clock();
    const body = canonicalJson({ at, kind, mandate_id: mandateId, payload, prev });
    const hash = await sha256Hex(body);
    await this.q("INSERT INTO events (mandate_id, kind, payload, prev_hash, hash, created_at) VALUES (?,?,?,?,?,?)",
      mandateId, kind, canonicalJson(payload), prev, hash, at).run();
    return hash;
  }

  async mandateFor(mandateId, token) {
    const m = await this.q("SELECT * FROM mandates WHERE id = ?", mandateId).first();
    if (!m || typeof token !== "string" || m.token_hash !== (await sha256Hex(token))) {
      throw new ArbiterError("not_found", "Unknown mandate or wrong buyer token.", 404);
    }
    return m;
  }

  // ---------- vendors ----------
  async createVendor({ name, origin }) {
    if (typeof name !== "string" || !name.trim() || name.length > 80) throw new ArbiterError("invalid", "name must be 1-80 characters.");
    if (origin !== undefined && origin !== null) {
      let u;
      try { u = new URL(origin); } catch { throw new ArbiterError("invalid", "origin must be a URL."); }
      if (!/^https?:$/.test(u.protocol)) throw new ArbiterError("invalid", "origin must be http(s).");
      origin = u.origin;
    }
    const id = newId("ven");
    const apiKey = newToken("vk");
    await this.q("INSERT INTO vendors VALUES (?,?,?,?,?)", id, name.trim(), origin || null, await sha256Hex(apiKey), this.clock()).run();
    await this.event(null, "VENDOR_REGISTERED", { vendor_id: id, name: name.trim(), origin: origin || null });
    return { vendor_id: id, api_key: apiKey };
  }

  async vendorByKey(apiKey) {
    if (typeof apiKey !== "string" || !apiKey.startsWith("vk_")) throw new ArbiterError("unauthorized", "Missing or malformed vendor key.", 401);
    const v = await this.q("SELECT id, name, origin FROM vendors WHERE key_hash = ?", await sha256Hex(apiKey)).first();
    if (!v) throw new ArbiterError("unauthorized", "Unknown vendor key.", 401);
    return v;
  }

  /** A vendor commits (or updates) a sealed listing. The floor never leaves the arbiter. */
  async upsertListing(vendor, input) {
    const l = {
      sku: input.sku,
      title: typeof input.title === "string" ? input.title.trim().slice(0, 120) : "",
      unit: typeof input.unit === "string" ? input.unit.trim().slice(0, 24) || "item" : "item",
      currency: typeof input.currency === "string" && /^[A-Z]{3}$/.test(input.currency) ? input.currency : "NGN",
      ask_cents: input.ask_cents,
      floor_cents: input.floor_cents,
      delivery_hours: input.delivery_hours,
      stock: input.stock,
    };
    const problems = checkListing(l);
    if (!l.title) problems.push("title is required");
    if (problems.length) throw new ArbiterError("invalid", problems.join("; "));
    await this.q(
      `INSERT INTO listings VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (vendor_id, sku) DO UPDATE SET title=excluded.title, unit=excluded.unit, currency=excluded.currency,
         ask_cents=excluded.ask_cents, floor_cents=excluded.floor_cents, delivery_hours=excluded.delivery_hours,
         stock=excluded.stock, updated_at=excluded.updated_at`,
      vendor.id, l.sku, l.title, l.unit, l.currency, l.ask_cents, l.floor_cents, l.delivery_hours, l.stock, this.clock()).run();
    await this.event(null, "LISTING_SEALED", { vendor_id: vendor.id, sku: l.sku });
    const { floor_cents, ...pub } = l;
    return { vendor_id: vendor.id, ...pub };
  }

  /** A vendor's own listings, including its own floors (shown only to that vendor). */
  async vendorListings(vendor) {
    return (await this.q("SELECT sku, title, unit, currency, ask_cents, floor_cents, delivery_hours, stock, updated_at FROM listings WHERE vendor_id = ? ORDER BY sku", vendor.id).all()).results;
  }

  /** Public catalogue: list prices and delivery only. */
  async catalog({ sku, vendor_id } = {}) {
    const rows = (await this.q(
      `SELECT l.vendor_id, v.name AS vendor_name, v.origin AS vendor_origin, l.sku, l.title, l.unit, l.currency,
              l.ask_cents, l.delivery_hours, l.stock > 0 AS in_stock
       FROM listings l JOIN vendors v ON v.id = l.vendor_id
       WHERE (?1 IS NULL OR l.sku = ?1) AND (?2 IS NULL OR l.vendor_id = ?2)
       ORDER BY l.sku, l.ask_cents, l.vendor_id`, sku ?? null, vendor_id ?? null).all()).results;
    return rows.map((r) => ({ ...r, in_stock: Boolean(r.in_stock) }));
  }

  // ---------- buyers ----------
  /**
   * Create a mandate. `buyerKey` identifies the caller for anti-probing (the Worker
   * derives it from the client IP); `callerOrigin` records which agentic site asked.
   */
  async createMandate(input, { buyerKey, callerOrigin = null }) {
    const m = {
      sku: input.sku,
      quantity: input.quantity,
      max_total_cents: input.max_total_cents,
      deliver_within_hours: input.deliver_within_hours,
      ...(input.vendor_ids ? { vendor_ids: input.vendor_ids } : {}),
    };
    const problems = checkMandate(m);
    if (problems.length) throw new ArbiterError("invalid", problems.join("; "));
    if (typeof buyerKey !== "string" || !buyerKey) throw new ArbiterError("invalid", "buyerKey required.", 500);

    const now = this.clock();
    const recent = await this.q("SELECT COUNT(*) AS n FROM mandates WHERE buyer_key = ? AND sku = ? AND created_at > ?",
      buyerKey, m.sku, now - DAY).first();
    if (recent.n >= LIMITS.mandatesPerBuyerPerSkuPerDay) {
      throw new ArbiterError("rate_limited", `At most ${LIMITS.mandatesPerBuyerPerSkuPerDay} negotiations per item per day. This stops repeated bids from mapping a seller's floor.`, 429);
    }
    const tk = termsKey(m);
    const dup = await this.q("SELECT id FROM mandates WHERE buyer_key = ? AND terms_key = ?", buyerKey, tk).first();
    if (dup) {
      throw new ArbiterError("identical_terms", "These exact terms were already negotiated. Change the quantity, deadline or vendors to negotiate again; changing only the budget is not allowed.", 409);
    }
    const id = newId("man");
    const token = newToken("bt");
    await this.q("INSERT INTO mandates VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      id, await sha256Hex(token), buyerKey, tk, m.sku, m.quantity, m.max_total_cents, m.deliver_within_hours,
      m.vendor_ids ? JSON.stringify(m.vendor_ids) : null, callerOrigin, "OPEN", now).run();
    await this.event(id, "MANDATE_CREATED", { sku: m.sku, quantity: m.quantity, deliver_within_hours: m.deliver_within_hours, caller_origin: callerOrigin });
    return { mandate_id: id, buyer_token: token, state: "OPEN" };
  }

  /** Resolve once; later calls return the stored outcome so nothing can be re-run. */
  async resolveMandate(mandateId, token) {
    const m = await this.mandateFor(mandateId, token);
    if (m.state === "OPEN") {
      const listings = (await this.q("SELECT * FROM listings WHERE sku = ?", m.sku).all()).results;
      const mandate = {
        sku: m.sku, quantity: m.quantity, max_total_cents: m.max_total_cents,
        deliver_within_hours: m.deliver_within_hours,
        ...(m.vendor_ids ? { vendor_ids: JSON.parse(m.vendor_ids) } : {}),
      };
      const out = resolve(mandate, listings);
      const expires = this.clock() + LIMITS.offerTtlSeconds;
      let rank = 0;
      for (const o of out.offers) {
        await this.q("INSERT INTO offers VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          newId("off"), m.id, rank++, o.vendor_id, o.sku, o.quantity, o.total_cents, o.list_total_cents, o.delivery_hours, expires, "OPEN").run();
      }
      const next = out.agreement ? "RESOLVED" : "NO_AGREEMENT";
      const changed = await this.q("UPDATE mandates SET state = ? WHERE id = ? AND state = 'OPEN'", next, m.id).run();
      if (!changed.meta.changes) throw new ArbiterError("conflict", "Mandate was resolved concurrently; fetch it again.", 409);
      await this.event(m.id, next === "RESOLVED" ? "BARGAINING_RESOLVED" : "NO_AGREEMENT", {
        mechanism: MECHANISM, considered: out.considered, agreements: out.offers.map((o) => o.vendor_id),
      });
    }
    return this.outcome(m.id);
  }

  async outcome(mandateId) {
    const m = await this.q("SELECT id, sku, quantity, deliver_within_hours, state, created_at FROM mandates WHERE id = ?", mandateId).first();
    const offers = (await this.q(
      `SELECT o.id AS offer_id, o.vendor_id, v.name AS vendor_name, v.origin AS vendor_origin, o.sku, o.quantity,
              o.total_cents, o.list_total_cents, o.list_total_cents - o.total_cents AS saving_cents,
              o.delivery_hours, o.expires_at, o.state, l.currency, l.title, l.unit
       FROM offers o JOIN vendors v ON v.id = o.vendor_id
       LEFT JOIN listings l ON l.vendor_id = o.vendor_id AND l.sku = o.sku
       WHERE o.mandate_id = ? ORDER BY o.rank`, mandateId).all()).results;
    const now = this.clock();
    const receipt = await this.q("SELECT id FROM receipts WHERE mandate_id = ?", mandateId).first();
    return {
      mandate_id: m.id,
      state: m.state,
      mechanism: MECHANISM,
      terms: { sku: m.sku, quantity: m.quantity, deliver_within_hours: m.deliver_within_hours },
      agreement: offers.length > 0,
      message: m.state === "NO_AGREEMENT"
        ? "No seller could meet these terms. Neither side's limits are revealed."
        : undefined,
      offers: offers.map((o) => ({ ...o, state: o.state === "OPEN" && o.expires_at <= now ? "EXPIRED" : o.state })),
      receipt_id: receipt ? receipt.id : null,
    };
  }

  /** The buyer accepts one offer. Stock is reserved atomically and a signed receipt is issued. */
  async acceptOffer(offerId, token) {
    await this.key(); // fail closed on a missing signing key before anything is written
    const o = await this.q("SELECT * FROM offers WHERE id = ?", offerId).first();
    if (!o) throw new ArbiterError("not_found", "Unknown offer.", 404);
    const m = await this.mandateFor(o.mandate_id, token);
    if (m.state === "SETTLED") throw new ArbiterError("already_settled", "This mandate already has an accepted offer.", 409);
    if (o.state !== "OPEN") throw new ArbiterError("offer_closed", "This offer is no longer open.", 409);
    const now = this.clock();
    if (o.expires_at <= now) throw new ArbiterError("offer_expired", "This offer expired; offers last 15 minutes.", 410);

    const settled = await this.q("UPDATE mandates SET state = 'SETTLED' WHERE id = ? AND state = 'RESOLVED'", m.id).run();
    if (!settled.meta.changes) throw new ArbiterError("already_settled", "This mandate already has an accepted offer.", 409);
    const reserved = await this.q("UPDATE listings SET stock = stock - ? WHERE vendor_id = ? AND sku = ? AND stock >= ?",
      o.quantity, o.vendor_id, o.sku, o.quantity).run();
    if (!reserved.meta.changes) {
      await this.q("UPDATE mandates SET state = 'RESOLVED' WHERE id = ?", m.id).run();
      await this.q("UPDATE offers SET state = 'VOID' WHERE id = ?", o.id).run();
      throw new ArbiterError("out_of_stock", "The seller no longer has enough stock; choose another offer.", 409);
    }
    await this.q("UPDATE offers SET state = CASE WHEN id = ? THEN 'ACCEPTED' ELSE 'VOID' END WHERE mandate_id = ?", o.id, m.id).run();

    const vendor = await this.q("SELECT id, name, origin FROM vendors WHERE id = ?", o.vendor_id).first();
    const listing = await this.q("SELECT title, unit, currency FROM listings WHERE vendor_id = ? AND sku = ?", o.vendor_id, o.sku).first();
    const eventHash = await this.event(m.id, "OFFER_ACCEPTED", { offer_id: o.id, vendor_id: o.vendor_id, total_cents: o.total_cents });
    const { privateJwk, kid } = await this.key();
    const payload = {
      type: "open-arbiter/receipt",
      version: 1,
      receipt_id: newId("rct"),
      mandate_id: m.id,
      offer_id: o.id,
      issued_at: now,
      mechanism: MECHANISM,
      vendor: { id: vendor.id, name: vendor.name, origin: vendor.origin },
      item: { sku: o.sku, title: listing?.title ?? o.sku, unit: listing?.unit ?? "item", quantity: o.quantity },
      currency: listing?.currency ?? "NGN",
      total_cents: o.total_cents,
      list_total_cents: o.list_total_cents,
      delivery_hours: o.delivery_hours,
      caller_origin: m.caller_origin,
      audit_hash: eventHash,
      settlement: "simulated",
    };
    const signature = await signPayload(privateJwk, payload);
    await this.q("INSERT INTO receipts VALUES (?,?,?,?,?,?)", payload.receipt_id, m.id, canonicalJson(payload), signature, kid, now).run();
    await this.event(m.id, "RECEIPT_ISSUED", { receipt_id: payload.receipt_id });
    return { receipt: payload, signature, key_id: kid };
  }

  async getReceipt(receiptId) {
    const r = await this.q("SELECT payload, signature, key_id FROM receipts WHERE id = ?", receiptId).first();
    if (!r) throw new ArbiterError("not_found", "Unknown receipt.", 404);
    return { receipt: JSON.parse(r.payload), signature: r.signature, key_id: r.key_id };
  }

  /** Verify a receipt against this arbiter's public key. Anyone can do the same offline with the JWKS. */
  async verifyReceipt({ receipt, signature }) {
    if (!receipt || typeof signature !== "string") return { valid: false, reason: "receipt and signature are required" };
    const { publicJwk } = await this.key();
    let valid = false;
    try { valid = await verifyPayload(publicJwk, receipt, signature); } catch { valid = false; }
    if (!valid) return { valid: false, reason: "signature does not match this arbiter's key" };
    const stored = await this.q("SELECT 1 FROM receipts WHERE id = ?", receipt.receipt_id).first();
    return { valid: true, recorded: Boolean(stored), receipt_id: receipt.receipt_id };
  }

  /** The buyer's own audit trail: event kinds and hashes, never limits. */
  async auditTrail(mandateId, token) {
    await this.mandateFor(mandateId, token);
    return (await this.q("SELECT seq, kind, payload, prev_hash, hash, created_at FROM events WHERE mandate_id = ? ORDER BY seq", mandateId).all())
      .results.map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
  }

  /** Recompute the whole hash chain. Returns the first broken sequence number, or null. */
  async verifyChain() {
    const rows = (await this.q("SELECT * FROM events ORDER BY seq").all()).results;
    let prev = "genesis";
    for (const e of rows) {
      const body = canonicalJson({ at: e.created_at, kind: e.kind, mandate_id: e.mandate_id, payload: JSON.parse(e.payload), prev });
      if (e.prev_hash !== prev || e.hash !== (await sha256Hex(body))) return { ok: false, broken_at: e.seq };
      prev = e.hash;
    }
    return { ok: true, events: rows.length, head: prev };
  }
}
