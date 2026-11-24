// Oja market page: state and operations. The page's own buttons and the assistant's
// website_* tools call the same methods, so both follow one set of rules.
import { ArbiterClient } from "./arbiter-client.js";
import { arbiterUrl, ARBITER_KEYS } from "./config.js";

export const naira = (n) => `₦${Number(n).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
const KEY_SOURCES = { pinned: "pinned key", "dev-jwks": "dev JWKS (unpinned)", none: "no pinned key" };
const hours = (h) => (h < 24 ? `${h} h` : h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} h`);

export class Market {
  constructor(client) {
    this.client = client;
    this.catalog = [];
    this.catalogError = null;
    this.negotiations = []; // newest first
    this.receipts = [];
    this.listeners = new Set();
    this.unknownOffers = new Set(); // accepts sent with no answer: outcome unknown until a read
  }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  /** Items grouped by sku, with the lowest list price and fastest delivery. */
  items() {
    const by = new Map();
    for (const r of this.catalog) {
      const g = by.get(r.sku) || { sku: r.sku, unit: r.unit, sellers: [] };
      g.sellers.push(r);
      by.set(r.sku, g);
    }
    return [...by.values()].map((g) => ({
      sku: g.sku,
      name: g.sellers[0].item,
      unit: g.unit,
      sellers: g.sellers.length,
      lowest_list_price: Math.min(...g.sellers.map((s) => s.list_price)),
      fastest_delivery_hours: Math.min(...g.sellers.map((s) => s.delivery_hours)),
    }));
  }

  skus() { return [...new Set(this.catalog.map((r) => r.sku))]; }

  async refreshCatalog() {
    const r = await this.client.catalog();
    if (r.ok) { this.catalog = r.items; this.catalogError = null; } else { this.catalogError = r.reason; }
    await this.#settleUnknown();
    this.emit();
    return r.ok ? { ok: true, items: this.catalog.length } : r;
  }

  /**
   * Find out what happened to accepts whose answer was lost: read each negotiation again (a read,
   * not a retry), pick up and verify any receipt, and clear the unknown mark once the arbiter has
   * answered.
   */
  async #settleUnknown() {
    for (const n of this.negotiations) {
      const marked = n.outcome.offers.filter((o) => this.unknownOffers.has(o.offer_id));
      if (!marked.length) continue;
      const fresh = await this.client.outcome(n.mandate_id);
      if (!fresh.ok) continue; // still unknown; keep the mark
      n.outcome = fresh.outcome;
      if (n.outcome.receipt_id && !this.receipts.some((x) => x.receipt.receipt_id === n.outcome.receipt_id)) {
        const r = await this.client.receipt(n.outcome.receipt_id);
        if (!r.ok) continue;
        const v = await this.client.verify(r);
        this.receipts.unshift({ receipt: r.receipt, signature: r.signature, key_id: r.key_id, verified: v.ok && v.valid, key_source: v.key_source });
      }
      for (const o of marked) this.unknownOffers.delete(o.offer_id);
    }
  }

  /** Everything the assistant may read. Buyer tokens and the visitor's budgets are not here. */
  getState() {
    return {
      arbiter: this.client.baseUrl,
      how_prices_work: "Each seller has sealed a lowest price; the buyer seals a highest total. The arbiter (deterministic code, not an AI) offers the midpoint of the overlap, capped at list price and placed on a price step of ₦100, ₦200, ₦400 … per unit (the largest at most 2.5% of the list price), or reports no agreement. Neither limit is shown; an agreed price narrows each to one price step. Offers last 15 minutes. Each set of terms (item, quantity, deadline, sellers) can be negotiated once, and at most 3 times per item per day.",
      catalog_error: this.catalogError,
      catalog: this.catalog.map((r) => ({
        sku: r.sku, item: r.item, unit: r.unit, seller_id: r.vendor_id, seller: r.vendor_name, seller_page: r.vendor_origin,
        list_price: r.list_price, currency: r.currency, delivery_hours: r.delivery_hours, in_stock: r.in_stock,
      })),
      negotiations: this.negotiations.map((n) => this.#publicNegotiation(n)),
      receipts: this.receipts.map((r) => this.#publicReceipt(r)),
    };
  }

  #publicNegotiation(n) {
    const now = Date.now();
    return {
      mandate_id: n.mandate_id,
      terms: { sku: n.terms.sku, quantity: n.terms.quantity, deliver_within_hours: n.terms.deliverWithinHours, sellers: n.terms.vendorIds || "all" },
      state: n.outcome.state,
      agreement: n.outcome.agreement,
      message: n.outcome.message,
      offers: n.outcome.offers.map((o) => ({
        offer_id: o.offer_id, seller: o.vendor_name, seller_page: o.vendor_origin, item: o.item, quantity: o.quantity,
        total: o.total, list_total: o.list_total, saving: o.saving, delivery_hours: o.delivery_hours,
        state: this.unknownOffers.has(o.offer_id) ? "UNKNOWN" : o.state === "OPEN" && Date.parse(o.expires_at) <= now ? "EXPIRED" : o.state, expires_at: o.expires_at,
      })),
      receipt_id: n.outcome.receipt_id,
    };
  }

  #publicReceipt(r) {
    return {
      receipt_id: r.receipt.receipt_id, seller: r.receipt.vendor.name, item: r.receipt.item.title, quantity: r.receipt.item.quantity,
      total: r.receipt.total_cents / 100, list_total: r.receipt.list_total_cents / 100, delivery_hours: r.receipt.delivery_hours,
      settlement: r.receipt.settlement, signature_verified_in_browser: r.verified, verified_with: KEY_SOURCES[r.key_source] ?? "not checked",
    };
  }

  // ---------- negotiate ----------
  checkNegotiation({ sku, quantity, max_total, deliver_within_hours, seller_ids }) {
    const rows = this.catalog.filter((r) => r.sku === sku);
    if (!rows.length) return { ok: false, reason: `No seller lists "${sku}". Pick an item from the catalogue.`, field: "sku" };
    if (!Number.isInteger(quantity) || quantity < 1) return { ok: false, reason: "Quantity must be a whole number of at least 1.", field: "quantity" };
    if (!(max_total > 0)) return { ok: false, reason: "Give the most you will pay in total, in naira.", field: "max_total" };
    if (!Number.isInteger(deliver_within_hours) || deliver_within_hours < 0) return { ok: false, reason: "Give a delivery deadline in whole hours.", field: "deliver_within_hours" };
    if (seller_ids && seller_ids.some((id) => !rows.some((r) => r.vendor_id === id))) return { ok: false, reason: "One of the chosen sellers does not list this item.", field: "seller_ids" };
    const pool = seller_ids && seller_ids.length ? rows.filter((r) => seller_ids.includes(r.vendor_id)) : rows;
    const cheapestList = Math.min(...pool.map((r) => r.list_price)) * quantity;
    return {
      ok: true,
      details: {
        Item: `${quantity} × ${rows[0].unit} of ${rows[0].item.split(",")[0].toLowerCase()} (${sku})`,
        "Your sealed maximum": `${naira(max_total)} in total (sellers never see it)`,
        "Deliver within": hours(deliver_within_hours),
        Sellers: pool.map((r) => r.vendor_name).join(", "),
        "Lowest list price": naira(cheapestList),
        Note: "These terms can be negotiated once. Asking again with only a different maximum is refused.",
      },
    };
  }

  async negotiate(args) {
    const check = this.checkNegotiation(args);
    if (!check.ok) return check;
    const terms = { sku: args.sku, quantity: args.quantity, maxTotal: args.max_total, deliverWithinHours: args.deliver_within_hours, vendorIds: args.seller_ids };
    const r = await this.client.negotiate(terms);
    if (!r.ok) return r;
    const { maxTotal, ...kept } = terms; // the budget is not kept on the page
    this.negotiations.unshift({ mandate_id: r.outcome.mandate_id, terms: kept, outcome: r.outcome });
    this.emit();
    return { ok: true, ...this.#publicNegotiation(this.negotiations[0]) };
  }

  // ---------- accept ----------
  #findOffer(offerId) {
    for (const n of this.negotiations) {
      const o = n.outcome.offers.find((x) => x.offer_id === offerId);
      if (o) return { n, o };
    }
    return null;
  }

  checkAccept({ offer_id }) {
    const hit = this.#findOffer(offer_id);
    if (!hit) return { ok: false, reason: "No offer with that id on this page. Read the market state again." };
    const { n, o } = hit;
    if (this.unknownOffers.has(offer_id)) return { ok: false, reason: "The last attempt to accept this offer got no answer, so its outcome is unknown. Read the market state to see what happened before trying again." };
    if (n.outcome.state === "SETTLED") return { ok: false, reason: "This negotiation already has an accepted offer." };
    if (o.state !== "OPEN") return { ok: false, reason: "This offer is no longer open." };
    if (Date.parse(o.expires_at) <= Date.now()) return { ok: false, reason: "This offer expired (offers last 15 minutes). Negotiate again with different terms." };
    return {
      ok: true,
      details: {
        Seller: o.vendor_name,
        Item: `${o.quantity} × ${o.item}`,
        Price: `${naira(o.total)} (list ${naira(o.list_total)}, you save ${naira(o.saving)})`,
        Delivery: `within ${hours(o.delivery_hours)}`,
        Settlement: "Simulated in this demo: no money moves.",
      },
    };
  }

  /**
   * Accept an offer. When the arbiter's answer is lost the outcome is unknown: this throws (the
   * runtime then records the action as "unknown" and never retries it) and marks the offer so no
   * second accept is sent until a read shows what happened.
   */
  async acceptOffer({ offer_id }, { signal } = {}) {
    const check = this.checkAccept({ offer_id });
    if (!check.ok) return check;
    const { n } = this.#findOffer(offer_id);
    const r = await this.client.accept(offer_id, { signal });
    if (r.unknown) {
      this.unknownOffers.add(offer_id);
      this.emit();
      throw new Error(r.reason);
    }
    if (!r.ok) {
      const fresh = await this.client.outcome(n.mandate_id);
      if (fresh.ok) n.outcome = fresh.outcome;
      this.emit();
      return r;
    }
    const v = await this.client.verify(r);
    const entry = { receipt: r.receipt, signature: r.signature, key_id: r.key_id, verified: v.ok && v.valid, key_source: v.key_source };
    this.receipts.unshift(entry);
    const fresh = await this.client.outcome(n.mandate_id);
    if (fresh.ok) n.outcome = fresh.outcome;
    this.emit();
    return { ok: true, ...this.#publicReceipt(entry) };
  }

  // ---------- verify ----------
  async verifyReceipt({ receipt_id }) {
    const r = await this.client.receipt(receipt_id);
    if (!r.ok) return r;
    const v = await this.client.verify(r);
    if (!v.ok) return v;
    return { ok: true, receipt_id, valid: v.valid, verified_with: KEY_SOURCES[v.key_source], seller: r.receipt.vendor.name, total: r.receipt.total_cents / 100, item: r.receipt.item.title, quantity: r.receipt.item.quantity, issued_at: new Date(r.receipt.issued_at * 1000).toISOString() };
  }
}

/** The one market object the page, the actions and site.js share. */
export const App = { page: new Market(new ArbiterClient(arbiterUrl(), { pinnedKeys: ARBITER_KEYS })) };
