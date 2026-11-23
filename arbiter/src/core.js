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
const CHAIN_ATTEMPTS = 8;
const CHAIN_BACKOFF_MS = 4; // first retry waits up to 4 ms, doubling: at most ~0.5 s in total
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EVENT_COLUMNS = "mandate_id, kind, payload, prev_hash, hash, created_at";

/** D1 wraps SQLite's message ("D1_ERROR: UNIQUE constraint failed: …"); node:sqlite does not. Match both. */
const sqliteMessage = (e) => `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
const isPrevHashConflict = (e) => sqliteMessage(e).includes("UNIQUE constraint failed: events.prev_hash");
const isTermsConflict = (e) => sqliteMessage(e).includes("UNIQUE constraint failed: mandates.buyer_key, mandates.terms_key");
const isStockCheck = (e) => sqliteMessage(e).includes("CHECK constraint failed: stock_nonneg");

export class Arbiter {
  /**
   * @param db D1Database (or the Node adapter in test/sqlite-d1.mjs)
   * @param opts.clock () => seconds since epoch
   * @param opts.signingJwk private ECDSA P-256 JWK
   * @param opts.allowGeneratedKey local development only: with no signingJwk, generate a key and
   *   keep it in the db. Otherwise a missing key fails closed ("misconfigured").
   * @param opts.random () => [0, 1), jitter for audit-chain retries; tests pass a seeded PRNG
   */
  constructor(db, { clock = () => Math.floor(Date.now() / 1000), signingJwk, allowGeneratedKey = false, random = Math.random } = {}) {
    this.db = db;
    this.clock = clock;
    this.random = random;
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

  /**
   * Commit business statements and their audit events in one D1 batch, which is one transaction.
   *
   * The events are chained from the current head of the log. `UNIQUE (prev_hash)` lets only one
   * writer extend a given head; a writer that lost the race retries with a fresh head after a
   * jittered exponential backoff (so concurrent losers do not collide again in lockstep), and after
   * CHAIN_ATTEMPTS it fails with 503 "busy". Either everything commits or nothing does.
   *
   * Precondition for retrying: every statement of the write must be inside this batch. A retry is
   * only safe because a failed batch rolls back completely; a write made outside the batch (before
   * or after commit()) would survive the failed attempt and then be repeated or orphaned.
   *
   * @param events [{ mandateId, kind, payload }], written in order after the business statements
   * @param statements (hashes) => D1 statements (may be async, e.g. to sign a receipt that
   *   names an event hash). Called again on every attempt.
   * @param guard optional { sql, args }: a boolean SQL expression; the events are written only if
   *   it holds when they are inserted. It is evaluated once per event, so it must not depend on the
   *   events this commit writes (then it holds for all of them or none).
   * @returns { results: the business statements' results, hashes, written: whether events were written }
   */
  async commit({ events, statements = () => [], guard = null }) {
    await this.ensureSchema();
    for (let attempt = 0; attempt < CHAIN_ATTEMPTS; attempt++) {
      const last = await this.q("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").first();
      let prev = last ? last.hash : "genesis";
      const at = this.clock();
      const rows = [];
      for (const e of events) {
        const hash = await sha256Hex(canonicalJson({ at, kind: e.kind, mandate_id: e.mandateId, payload: e.payload, prev }));
        rows.push({ ...e, prev, hash });
        prev = hash;
      }
      const hashes = rows.map((r) => r.hash);
      const business = await statements(hashes);
      const inserts = rows.map((r) => {
        const values = [r.mandateId, r.kind, canonicalJson(r.payload), r.prev, r.hash, at];
        return guard
          ? this.q(`INSERT INTO events (${EVENT_COLUMNS}) SELECT ?,?,?,?,?,? WHERE ${guard.sql}`, ...values, ...guard.args)
          : this.q(`INSERT INTO events (${EVENT_COLUMNS}) VALUES (?,?,?,?,?,?)`, ...values);
      });
      try {
        const results = await this.db.batch([...business, ...inserts]);
        const eventResults = results.slice(business.length);
        return { results: results.slice(0, business.length), hashes, written: eventResults.every((r) => r.meta.changes === 1) };
      } catch (e) {
        if (!isPrevHashConflict(e)) throw e;
        // Jitter is not pricing: mechanism.js stays free of randomness and clocks.
        if (attempt < CHAIN_ATTEMPTS - 1) await sleep(this.random() * CHAIN_BACKOFF_MS * 2 ** attempt);
      }
    }
    throw new ArbiterError("busy", "The arbiter's audit log is busy. Try again in a moment.", 503);
  }

  /**
   * The chain (F3) and accept (F4) guarantees are enforced by schema constraints, so a database
   * created before them would silently fork the chain or oversell. Refuse to write until it is
   * migrated or reset. Checked once per Arbiter instance (one request in the Worker).
   */
  async ensureSchema() {
    if (this._schemaOk) return;
    const rows = (await this.q(
      "SELECT name, sql FROM sqlite_master WHERE (type = 'table' AND name = 'listings') OR (type = 'index' AND name = 'events_prev_unique')",
    ).all()).results;
    const listings = rows.find((r) => r.name === "listings");
    const ok = Boolean(listings && /CONSTRAINT stock_nonneg CHECK/.test(listings.sql) && rows.some((r) => r.name === "events_prev_unique"));
    if (!ok) {
      console.error("Open Arbiter: database schema is out of date (needs CHECK stock_nonneg and UNIQUE events.prev_hash); refusing to write.");
      throw new ArbiterError("misconfigured", "The arbiter's database schema is out of date. It must be migrated or reset before it can accept writes.", 500);
    }
    this._schemaOk = true;
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
    const keyHash = await sha256Hex(apiKey);
    await this.commit({
      events: [{ mandateId: null, kind: "VENDOR_REGISTERED", payload: { vendor_id: id, name: name.trim(), origin: origin || null } }],
      statements: () => [this.q("INSERT INTO vendors VALUES (?,?,?,?,?)", id, name.trim(), origin || null, keyHash, this.clock())],
    });
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
    await this.commit({
      events: [{ mandateId: null, kind: "LISTING_SEALED", payload: { vendor_id: vendor.id, sku: l.sku } }],
      statements: () => [this.q(
        `INSERT INTO listings VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (vendor_id, sku) DO UPDATE SET title=excluded.title, unit=excluded.unit, currency=excluded.currency,
           ask_cents=excluded.ask_cents, floor_cents=excluded.floor_cents, delivery_hours=excluded.delivery_hours,
           stock=excluded.stock, updated_at=excluded.updated_at`,
        vendor.id, l.sku, l.title, l.unit, l.currency, l.ask_cents, l.floor_cents, l.delivery_hours, l.stock, this.clock())],
    });
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

    // Both anti-probing limits are enforced by the database in one statement, so concurrent requests
    // cannot slip past a check made earlier: the daily cap by the INSERT's WHERE (0 rows = capped),
    // identical terms by UNIQUE (buyer_key, terms_key). The cap is checked first, as before.
    const now = this.clock();
    const tk = termsKey(m);
    const id = newId("man");
    const token = newToken("bt");
    const tokenHash = await sha256Hex(token);
    let created;
    try {
      created = await this.commit({
        events: [{ mandateId: id, kind: "MANDATE_CREATED", payload: { sku: m.sku, quantity: m.quantity, deliver_within_hours: m.deliver_within_hours, caller_origin: callerOrigin } }],
        statements: () => [this.q(
          `INSERT INTO mandates (id, token_hash, buyer_key, terms_key, sku, quantity, max_total_cents, deliver_within_hours, vendor_ids, caller_origin, state, created_at)
           SELECT ?,?,?,?,?,?,?,?,?,?,'OPEN',?
           WHERE (SELECT COUNT(*) FROM mandates WHERE buyer_key = ? AND sku = ? AND created_at > ?) < ?`,
          id, tokenHash, buyerKey, tk, m.sku, m.quantity, m.max_total_cents, m.deliver_within_hours,
          m.vendor_ids ? JSON.stringify(m.vendor_ids) : null, callerOrigin, now,
          buyerKey, m.sku, now - DAY, LIMITS.mandatesPerBuyerPerSkuPerDay)],
        guard: { sql: "EXISTS (SELECT 1 FROM mandates WHERE id = ?)", args: [id] },
      });
    } catch (e) {
      if (isTermsConflict(e)) {
        throw new ArbiterError("identical_terms", "These exact terms were already negotiated. Change the quantity, deadline or vendors to negotiate again; changing only the budget is not allowed.", 409);
      }
      throw e;
    }
    if (created.results[0].meta.changes !== 1) {
      throw new ArbiterError("rate_limited", `At most ${LIMITS.mandatesPerBuyerPerSkuPerDay} negotiations per item per day. This stops repeated bids from mapping a seller's floor.`, 429);
    }
    return { mandate_id: id, buyer_token: token, state: "OPEN" };
  }

  /**
   * Resolve once; later calls return the stored outcome so nothing can be re-run.
   * Offers, the state change and the event commit in one batch. Every statement is guarded on
   * the mandate still being OPEN, so of several concurrent resolves exactly one writes anything;
   * the others return the stored outcome.
   */
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
      const next = out.agreement ? "RESOLVED" : "NO_AGREEMENT";
      const kind = next === "RESOLVED" ? "BARGAINING_RESOLVED" : "NO_AGREEMENT";
      const stillOpen = "EXISTS (SELECT 1 FROM mandates WHERE id = ? AND state = 'OPEN')";
      await this.commit({
        events: [{ mandateId: m.id, kind, payload: { mechanism: MECHANISM, considered: out.considered, agreements: out.offers.map((o) => o.vendor_id) } }],
        statements: () => [
          ...out.offers.map((o, rank) => this.q(
            `INSERT INTO offers (id, mandate_id, rank, vendor_id, sku, quantity, total_cents, list_total_cents, delivery_hours, expires_at, state)
             SELECT ?,?,?,?,?,?,?,?,?,?,'OPEN' WHERE ${stillOpen}`,
            newId("off"), m.id, rank, o.vendor_id, o.sku, o.quantity, o.total_cents, o.list_total_cents, o.delivery_hours, expires, m.id)),
          this.q("UPDATE mandates SET state = ? WHERE id = ? AND state = 'OPEN'", next, m.id),
        ],
        // Written only by the resolve that moved the mandate out of OPEN in this batch.
        guard: {
          sql: "NOT EXISTS (SELECT 1 FROM events WHERE mandate_id = ? AND kind IN ('BARGAINING_RESOLVED', 'NO_AGREEMENT'))",
          args: [m.id],
        },
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

  /**
   * The buyer accepts one offer: all or nothing.
   *
   * The receipt is signed first (it names the OFFER_ACCEPTED event's hash, so per commit attempt),
   * then one batch makes every change. A batch does not stop at a statement that changes 0 rows, so
   * each statement carries its own guard and the receipt insert decides:
   *   1. mandate RESOLVED -> SETTLED, only if this offer is OPEN, unexpired and belongs to it
   *   2. stock decrement, 3. offer states: only if the mandate is SETTLED and has no receipt yet
   *      (so a concurrent accept that already committed makes them no-ops)
   *   4. receipt INSERT ... SELECT ... WHERE the mandate is SETTLED, has no receipt, and this offer
   *      is the ACCEPTED one; UNIQUE (receipts.mandate_id) is the backstop
   *   5. both events, only if this receipt row exists
   * Statements 1-4 share their conditions, so they all change or none do. 0 rows from (4) is an
   * error. CHECK stock_nonneg (overselling) rolls the batch back and is reported as out_of_stock.
   */
  async acceptOffer(offerId, token) {
    await this.key(); // fail closed on a missing signing key before anything is written
    const o = await this.q("SELECT * FROM offers WHERE id = ?", offerId).first();
    if (!o) throw new ArbiterError("not_found", "Unknown offer.", 404);
    const m = await this.mandateFor(o.mandate_id, token);
    // Early, friendly answers. The batch below re-checks all of these itself.
    if (m.state === "SETTLED") throw new ArbiterError("already_settled", "This mandate already has an accepted offer.", 409);
    if (o.state !== "OPEN") throw new ArbiterError("offer_closed", "This offer is no longer open.", 409);
    const now = this.clock();
    if (o.expires_at <= now) throw new ArbiterError("offer_expired", "This offer expired; offers last 15 minutes.", 410);

    const vendor = await this.q("SELECT id, name, origin FROM vendors WHERE id = ?", o.vendor_id).first();
    const listing = await this.q("SELECT title, unit, currency FROM listings WHERE vendor_id = ? AND sku = ?", o.vendor_id, o.sku).first();
    const { privateJwk, kid } = await this.key();
    const receiptId = newId("rct");
    const receipt = (auditHash) => ({
      type: "open-arbiter/receipt",
      version: 1,
      receipt_id: receiptId,
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
      audit_hash: auditHash,
      settlement: "simulated",
    });
    const settledByUs = "EXISTS (SELECT 1 FROM mandates WHERE id = ? AND state = 'SETTLED') AND NOT EXISTS (SELECT 1 FROM receipts WHERE mandate_id = ?)";

    let payload, signature, done;
    try {
      done = await this.commit({
        events: [
          { mandateId: m.id, kind: "OFFER_ACCEPTED", payload: { offer_id: o.id, vendor_id: o.vendor_id, total_cents: o.total_cents } },
          { mandateId: m.id, kind: "RECEIPT_ISSUED", payload: { receipt_id: receiptId } },
        ],
        statements: async ([acceptedHash]) => {
          payload = receipt(acceptedHash);
          signature = await signPayload(privateJwk, payload); // signed before anything is written
          return [
            this.q(`UPDATE mandates SET state = 'SETTLED' WHERE id = ? AND state = 'RESOLVED'
                    AND EXISTS (SELECT 1 FROM offers WHERE id = ? AND mandate_id = ? AND state = 'OPEN' AND expires_at > ?)`,
              m.id, o.id, m.id, now),
            this.q(`UPDATE listings SET stock = stock - ? WHERE vendor_id = ? AND sku = ? AND ${settledByUs}`,
              o.quantity, o.vendor_id, o.sku, m.id, m.id),
            this.q(`UPDATE offers SET state = CASE WHEN id = ? THEN 'ACCEPTED' ELSE 'VOID' END WHERE mandate_id = ? AND ${settledByUs}`,
              o.id, m.id, m.id, m.id),
            this.q(`INSERT INTO receipts (id, mandate_id, payload, signature, key_id, created_at)
                    SELECT ?,?,?,?,?,? WHERE ${settledByUs} AND EXISTS (SELECT 1 FROM offers WHERE id = ? AND state = 'ACCEPTED')`,
              receiptId, m.id, canonicalJson(payload), signature, kid, now, m.id, m.id, o.id),
          ];
        },
        guard: { sql: "EXISTS (SELECT 1 FROM receipts WHERE id = ?)", args: [receiptId] },
      });
    } catch (e) {
      if (isStockCheck(e)) {
        // Nothing of the accept was committed. Close only this offer; the mandate stays RESOLVED.
        await this.q("UPDATE offers SET state = 'VOID' WHERE id = ? AND state = 'OPEN'", o.id).run();
        throw new ArbiterError("out_of_stock", "The seller no longer has enough stock; choose another offer.", 409);
      }
      throw e;
    }
    if (done.results[3].meta.changes !== 1) {
      // Nothing was written. Say why, from the state that won.
      const cur = await this.q("SELECT state FROM mandates WHERE id = ?", m.id).first();
      if (cur.state === "SETTLED") throw new ArbiterError("already_settled", "This mandate already has an accepted offer.", 409);
      throw new ArbiterError("offer_closed", "This offer can no longer be accepted; nothing changed.", 409);
    }
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
