// Open Arbiter service logic over a D1-compatible database.
// `db` needs prepare(sql).bind(...).first() / .all() / .run(), as Cloudflare D1 provides.
import { MECHANISM, LIMITS, checkListing, checkMandate, termsKey, resolve, canonicalJson, unitStep } from "./mechanism.js";
import { newId, newToken, sha256Hex, generateSigningKey, publicFromPrivate, keyId, signPayload, verifyPayload } from "./crypto.js";

import { ArbiterError } from "./errors.js";

export { ArbiterError };

const DAY = 86_400;
// Chain-head contention: 12 attempts; the jittered wait before retry k is up to 4 ms × 2^k, capped at
// 128 ms, so at most ~0.9 s in total before 503 "busy". 8 attempts uncapped (~0.5 s) let one of 36
// concurrent writers run out under CPU load (Phase 0 gate review, R4: 6 of 15 full test runs).
const CHAIN_ATTEMPTS = 12;
const CHAIN_BACKOFF_MS = 4;
const CHAIN_BACKOFF_CAP_MS = 128;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EVENT_COLUMNS = "mandate_id, kind, payload, prev_hash, hash, created_at";

/** D1 wraps SQLite's message ("D1_ERROR: UNIQUE constraint failed: …"); node:sqlite does not. Match both. */
const sqliteMessage = (e) => `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
const isPrevHashConflict = (e) => sqliteMessage(e).includes("UNIQUE constraint failed: events.prev_hash");
const isTermsConflict = (e) => sqliteMessage(e).includes("UNIQUE constraint failed: mandates.buyer_key, mandates.terms_key");
const isStockCheck = (e) => sqliteMessage(e).includes("CHECK constraint failed: stock_nonneg");
const isTokenConflict = (e) => sqliteMessage(e).includes("UNIQUE constraint failed: mandates.token_hash");

/**
 * The migrations (arbiter/migrations/) this Worker needs recorded in d1_migrations before it writes.
 * The write guarantees rest on what they create: 0000_baseline CHECK stock_nonneg (accept cannot
 * oversell), UNIQUE events.prev_hash (linear chain), UNIQUE mandates.token_hash (idempotent create);
 * 0001_settle_attempt the R6 settle marker. Always every migration in this tree (a test checks it).
 */
export const REQUIRED_MIGRATIONS = ["0000_baseline.sql", "0001_settle_attempt.sql", "0002_read_indexes.sql"];
/**
 * Negotiations per item per caller (salted IP hash) per rolling 24 h, unless the environment sets
 * MANDATES_PER_ITEM_PER_DAY. Load protection only: the price leakage bound comes from the nested
 * grid and holds for any number of deals (ADR 0001; mechanism.test.mjs "cap: 20 deals"). It was 3
 * until 2026-11-27, when carrier-grade NAT (many shoppers behind one address) made 3 a lockout.
 */
export const MANDATE_CAP_DEFAULT = 20;
/** The most listings one catalog call returns (P1.7 AC-7.2). Pages continue with `after`. */
export const CATALOG_PAGE_MAX = 100;
const CURSOR_MAX = 512;

/** The opaque catalog cursor: the last row's (sku, list price, vendor), base64url JSON. */
function encodeCursor(r) {
  return btoa(JSON.stringify([r.sku, r.ask_cents, r.vendor_id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeCursor(c) {
  let v;
  try {
    if (typeof c !== "string" || c.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(c)) throw 0;
    v = JSON.parse(atob(c.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { v = null; }
  if (!Array.isArray(v) || v.length !== 3 || typeof v[0] !== "string" || !Number.isSafeInteger(v[1]) || typeof v[2] !== "string") {
    throw new ArbiterError("invalid", "after is not a cursor from a previous catalog page.");
  }
  return { sku: v[0], ask_cents: v[1], vendor_id: v[2] };
}
const isNoMigrationsTable = (e) => /no such table: d1_migrations/.test(sqliteMessage(e));
const HEX64 = /^[0-9a-f]{64}$/;
/** The price step an offer was made on, from the list total it stored (ask × quantity). */
const steps = (o) => {
  const unit = unitStep(o.list_total_cents / o.quantity);
  return { unit_step_cents: unit, grid_step_cents: unit * o.quantity };
};

export class Arbiter {
  /**
   * @param db D1Database (or the Node adapter in test/sqlite-d1.mjs)
   * @param opts.clock () => seconds since epoch
   * @param opts.signingJwk private ECDSA P-256 JWK
   * @param opts.allowGeneratedKey local development only: with no signingJwk, generate a key and
   *   keep it in the db. Otherwise a missing key fails closed ("misconfigured").
   * @param opts.random () => [0, 1), jitter for audit-chain retries; tests pass a seeded PRNG
   * @param opts.schemaVerified a WeakSet shared for the life of the Worker instance: databases whose
   *   schema was already checked. The Worker passes one module-level set, so the check runs once per
   *   database binding per instance instead of once per write. Defaults to a per-Arbiter set.
   */
  constructor(db, { clock = () => Math.floor(Date.now() / 1000), signingJwk, allowGeneratedKey = false, random = Math.random, schemaVerified = new WeakSet(), mandateCap = MANDATE_CAP_DEFAULT } = {}) {
    this.db = db;
    this.mandateCap = mandateCap;
    this.schemaVerified = schemaVerified;
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
      throw new ArbiterError("misconfigured", "Signing key not configured.", { reason: "signing_key_missing" });
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
        if (attempt < CHAIN_ATTEMPTS - 1) await sleep(this.random() * Math.min(CHAIN_BACKOFF_MS * 2 ** attempt, CHAIN_BACKOFF_CAP_MS));
      }
    }
    throw new ArbiterError("busy", "The arbiter's audit log is busy. Try again in a moment.");
  }

  /**
   * The chain, accept and idempotent-create guarantees are enforced by schema constraints that the
   * migrations create, so a database below this Worker's migration level would silently fork the
   * chain, oversell or duplicate mandates. Refuse to write until every REQUIRED_MIGRATIONS name is
   * recorded in d1_migrations (newer ones are fine: they are applied before the Worker that needs
   * them, ADR 0005). Checked once per database per Worker instance (see opts.schemaVerified); an
   * outdated database is checked again on every write until it is migrated.
   */
  async ensureSchema() {
    if (this.schemaVerified.has(this.db)) return;
    let applied;
    try {
      applied = new Set((await this.q("SELECT name FROM d1_migrations").all()).results.map((r) => r.name));
    } catch (e) {
      if (!isNoMigrationsTable(e)) throw e;
      applied = new Set();
    }
    const missing = REQUIRED_MIGRATIONS.filter((name) => !applied.has(name));
    if (missing.length) {
      throw new ArbiterError("misconfigured", "The arbiter's database schema is out of date. It must be migrated or reset before it can accept writes.", { reason: "migrations_missing" });
    }
    this.schemaVerified.add(this.db);
  }

  async mandateFor(mandateId, token) {
    const m = await this.q("SELECT * FROM mandates WHERE id = ?", mandateId).first();
    if (!m || typeof token !== "string" || m.token_hash !== (await sha256Hex(token))) {
      throw new ArbiterError("not_found", "Unknown mandate or wrong buyer token.");
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
      statements: () => [this.q("INSERT INTO vendors (id, name, origin, key_hash, created_at) VALUES (?,?,?,?,?)", id, name.trim(), origin || null, keyHash, this.clock())],
    });
    return { vendor_id: id, api_key: apiKey };
  }

  async vendorByKey(apiKey) {
    if (typeof apiKey !== "string" || !apiKey.startsWith("vk_")) throw new ArbiterError("unauthorized", "Missing or malformed vendor key.");
    const v = await this.q("SELECT id, name, origin FROM vendors WHERE key_hash = ?", await sha256Hex(apiKey)).first();
    if (!v) throw new ArbiterError("unauthorized", "Unknown vendor key.");
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
        `INSERT INTO listings (vendor_id, sku, title, unit, currency, ask_cents, floor_cents, delivery_hours, stock, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
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
  /** The first catalog page as an array (tests and callers that need no paging). */
  async catalog(opts = {}) {
    return (await this.catalogPage(opts)).items;
  }

  /**
   * One page of the public catalog, ordered by sku, list price, vendor, with `next` when more rows
   * follow. Keyset paging on indexes (listings_by_sku, or the vendor_id-first primary key), so a call
   * reads at most `limit` + 1 listings whatever the table's size.
   */
  async catalogPage({ sku, vendor_id, limit = CATALOG_PAGE_MAX, after } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATALOG_PAGE_MAX) throw new ArbiterError("invalid", `limit must be an integer between 1 and ${CATALOG_PAGE_MAX}.`);
    const cur = after === undefined || after === null ? null : decodeCursor(after);
    const where = [], args = [];
    let order;
    if (vendor_id !== undefined) {
      // The primary key (vendor_id, sku): one vendor's listings in sku order (sku is unique per vendor).
      where.push("l.vendor_id = ?"); args.push(vendor_id);
      if (sku !== undefined) { where.push("l.sku = ?"); args.push(sku); }
      if (cur) { where.push("l.sku > ?"); args.push(cur.sku); }
      order = "l.sku";
    } else if (sku !== undefined) {
      where.push("l.sku = ?"); args.push(sku);
      if (cur) { where.push("(l.ask_cents, l.vendor_id) > (?, ?)"); args.push(cur.ask_cents, cur.vendor_id); }
      order = "l.ask_cents, l.vendor_id";
    } else {
      if (cur) { where.push("(l.sku, l.ask_cents, l.vendor_id) > (?, ?, ?)"); args.push(cur.sku, cur.ask_cents, cur.vendor_id); }
      order = "l.sku, l.ask_cents, l.vendor_id";
    }
    const rows = (await this.q(
      `SELECT l.vendor_id, v.name AS vendor_name, v.origin AS vendor_origin, l.sku, l.title, l.unit, l.currency,
              l.ask_cents, l.delivery_hours, l.stock > 0 AS in_stock
       FROM listings l JOIN vendors v ON v.id = l.vendor_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ${order} LIMIT ?`, ...args, limit + 1).all()).results;
    const page = rows.slice(0, limit).map((r) => ({ ...r, in_stock: Boolean(r.in_stock) }));
    return { items: page, next: rows.length > limit ? encodeCursor(page.at(-1)) : null };
  }

  // ---------- buyers ----------
  /**
   * Create a mandate. `buyerKey` identifies the caller for anti-probing (the Worker
   * derives it from the client IP); `callerOrigin` records which agentic site asked.
   *
   * The buyer secret: either the caller makes it and sends only its SHA-256 (`buyer_token_hash`,
   * 64 lowercase hex), or the arbiter makes one and returns it once (`buyer_token`). With a
   * caller-made secret the create is idempotent: the same hash with the same terms and budget
   * returns the existing mandate (`replayed: true`, nothing written), so a client whose answer was
   * lost can safely send the same request again. The same hash with anything else is refused.
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
    const clientHash = input.buyer_token_hash;
    if (clientHash !== undefined && (typeof clientHash !== "string" || !HEX64.test(clientHash))) {
      problems.push("buyer_token_hash must be the SHA-256 of your buyer secret, as 64 lowercase hex characters");
    }
    if (problems.length) throw new ArbiterError("invalid", problems.join("; "));
    if (typeof buyerKey !== "string" || !buyerKey) throw new Error("createMandate: buyerKey required"); // a caller bug: internal
    const tk = termsKey(m);

    // A retry of a create whose answer was lost: same secret, same terms and budget.
    const replay = async () => {
      if (clientHash === undefined) return null;
      const row = await this.q("SELECT id, state, terms_key, max_total_cents FROM mandates WHERE token_hash = ?", clientHash).first();
      if (!row) return null;
      if (row.terms_key !== tk || row.max_total_cents !== m.max_total_cents) {
        throw new ArbiterError("token_reused", "This buyer secret already belongs to a negotiation with other terms. Use a new secret for new terms.");
      }
      return { mandate_id: row.id, state: row.state, replayed: true };
    };
    const earlier = await replay();
    if (earlier) return earlier;

    // Both anti-probing limits are enforced by the database in one statement, so concurrent requests
    // cannot slip past a check made earlier: the daily cap by the INSERT's WHERE (0 rows = capped),
    // identical terms by UNIQUE (buyer_key, terms_key). The cap is checked first, as before.
    const now = this.clock();
    const id = newId("man");
    const token = clientHash === undefined ? newToken("bt") : null;
    const tokenHash = clientHash ?? (await sha256Hex(token));
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
          buyerKey, m.sku, now - DAY, this.mandateCap)],
        guard: { sql: "EXISTS (SELECT 1 FROM mandates WHERE id = ?)", args: [id] },
      });
    } catch (e) {
      if (isTokenConflict(e) || isTermsConflict(e)) {
        const concurrent = await replay(); // a concurrent retry with this secret won the race
        if (concurrent) return concurrent;
      }
      if (isTermsConflict(e)) {
        throw new ArbiterError("identical_terms", "These exact terms were already negotiated. Change the quantity, deadline or vendors to negotiate again; changing only the budget is not allowed.");
      }
      if (isTokenConflict(e)) throw new ArbiterError("token_reused", "This buyer secret is already in use. Use a new secret.");
      throw e;
    }
    if (created.results[0].meta.changes !== 1) {
      const concurrent = await replay();
      if (concurrent) return concurrent;
      throw new ArbiterError("rate_limited", `At most ${this.mandateCap} negotiations per item per day from one address. This limits load; prices reveal at most one price step however many deals are made.`);
    }
    return { mandate_id: id, ...(token ? { buyer_token: token } : {}), state: "OPEN", replayed: false };
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
      offers: offers.map((o) => ({ ...o, ...steps(o), state: o.state === "OPEN" && o.expires_at <= now ? "EXPIRED" : o.state })),
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
    if (!o) throw new ArbiterError("not_found", "Unknown offer.");
    const m = await this.mandateFor(o.mandate_id, token);
    // Early, friendly answers. The batch below re-checks all of these itself.
    if (m.state === "SETTLED") throw new ArbiterError("already_settled", "This mandate already has an accepted offer.");
    if (o.state !== "OPEN") throw new ArbiterError("offer_closed", "This offer is no longer open.");
    const now = this.clock();
    if (o.expires_at <= now) throw new ArbiterError("offer_expired", "This offer expired; offers last 15 minutes.");

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
      ...steps(o),
      delivery_hours: o.delivery_hours,
      caller_origin: m.caller_origin,
      audit_hash: auditHash,
      settlement: "simulated",
    });
    // R6: only the attempt that settled the mandate (statement 1 writes its receipt id) may go on, so
    // a mandate left SETTLED without a receipt by an older accept can never take stock or a receipt.
    const settledByUs = "EXISTS (SELECT 1 FROM mandates WHERE id = ? AND state = 'SETTLED' AND settle_attempt = ?) AND NOT EXISTS (SELECT 1 FROM receipts WHERE mandate_id = ?)";

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
            this.q(`UPDATE mandates SET state = 'SETTLED', settle_attempt = ? WHERE id = ? AND state = 'RESOLVED'
                    AND EXISTS (SELECT 1 FROM offers WHERE id = ? AND mandate_id = ? AND state = 'OPEN' AND expires_at > ?)`,
              receiptId, m.id, o.id, m.id, now),
            this.q(`UPDATE listings SET stock = stock - ? WHERE vendor_id = ? AND sku = ? AND ${settledByUs}`,
              o.quantity, o.vendor_id, o.sku, m.id, receiptId, m.id),
            this.q(`UPDATE offers SET state = CASE WHEN id = ? THEN 'ACCEPTED' ELSE 'VOID' END WHERE mandate_id = ? AND ${settledByUs}`,
              o.id, m.id, m.id, receiptId, m.id),
            this.q(`INSERT INTO receipts (id, mandate_id, payload, signature, key_id, created_at)
                    SELECT ?,?,?,?,?,? WHERE ${settledByUs} AND EXISTS (SELECT 1 FROM offers WHERE id = ? AND state = 'ACCEPTED')`,
              receiptId, m.id, canonicalJson(payload), signature, kid, now, m.id, receiptId, m.id, o.id),
          ];
        },
        guard: { sql: "EXISTS (SELECT 1 FROM receipts WHERE id = ?)", args: [receiptId] },
      });
    } catch (e) {
      if (isStockCheck(e)) {
        // Nothing of the accept was committed. Close only this offer; the mandate stays RESOLVED.
        await this.q("UPDATE offers SET state = 'VOID' WHERE id = ? AND state = 'OPEN'", o.id).run();
        throw new ArbiterError("out_of_stock", "The seller no longer has enough stock; choose another offer.");
      }
      throw e;
    }
    if (done.results[3].meta.changes !== 1) {
      // Nothing was written. Say why, from the state that won.
      const cur = await this.q("SELECT state FROM mandates WHERE id = ?", m.id).first();
      if (cur.state === "SETTLED") throw new ArbiterError("already_settled", "This mandate already has an accepted offer.");
      throw new ArbiterError("offer_closed", "This offer can no longer be accepted; nothing changed.");
    }
    return { receipt: payload, signature, key_id: kid };
  }

  async getReceipt(receiptId) {
    const r = await this.q("SELECT payload, signature, key_id FROM receipts WHERE id = ?", receiptId).first();
    if (!r) throw new ArbiterError("not_found", "Unknown receipt.");
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
