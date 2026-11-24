// The actions Oja shares with other agent sites, through its action bridge.
// When another site's assistant calls the oja_market network, the bridge loads this
// file in a hidden frame on Oja's origin. Only reads of public facts are shared:
// negotiating and accepting need the visitor on Oja's own page (or the arbiter's MCP).
import { ArbiterClient } from "../js/arbiter-client.js";
import { DEFAULT_ARBITER_URL, ARBITER_KEYS } from "../js/config.js";

class BridgeActions {
  /** The catalogue is public (the page shows it), so any site may read it. */
  static CALLERS = ["*"];

  static registerActions(actions) {
    actions.register(BridgeActions.readStateAction());
    actions.register(BridgeActions.verifyAction());
  }

  static readStateAction() {
    return {
      name: "get_market_state",
      description: "Read the live market from the arbiter: every item (sku), seller, public list price per unit in naira, delivery time and stock. Shared with other sites, so it has no negotiations, offers or receipts. Changes nothing.",
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: BridgeActions.readState,
    };
  }

  static verifyAction() {
    return {
      name: "verify_receipt",
      description: "Check a receipt's signature against the arbiter key pinned in Oja's site. Changes nothing.",
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
      inputSchema: {
        type: "object", additionalProperties: false, required: ["receipt_id"],
        properties: { receipt_id: { type: "string", minLength: 5, maxLength: 64 } },
      },
      execute: BridgeActions.verify,
    };
  }

  static async readState() {
    const client = new ArbiterClient(DEFAULT_ARBITER_URL, { pinnedKeys: ARBITER_KEYS });
    const r = await client.catalog();
    if (!r.ok) return r;
    return {
      oja_page: new URL("../", import.meta.url).href,
      how_to_buy: "Negotiating and buying happen on Oja's own page, where the visitor seals their maximum and confirms. Give the visitor the oja_page link.",
      catalog: r.items.map((x) => ({
        sku: x.sku, item: x.item, unit: x.unit, seller: x.vendor_name, seller_page: x.vendor_origin,
        list_price: x.list_price, currency: x.currency, delivery_hours: x.delivery_hours, in_stock: x.in_stock,
      })),
    };
  }

  static async verify({ receipt_id }) {
    const client = new ArbiterClient(DEFAULT_ARBITER_URL, { pinnedKeys: ARBITER_KEYS });
    const r = await client.receipt(receipt_id);
    if (!r.ok) return r;
    const v = await client.verify(r);
    if (!v.ok) return v;
    return { ok: true, receipt_id, valid: v.valid, key_source: v.key_source, seller: r.receipt.vendor.name, total: r.receipt.total_cents / 100, item: r.receipt.item.title, quantity: r.receipt.item.quantity };
  }
}

export const registerActions = BridgeActions.registerActions;
