// Registers Oja's operations with the agent runtime (agent-manifest.json "actions.module").
// Only the names in "actions.agentTools" become model tools, called website_<name>.
// Each action wraps a method the page's own forms use, so both follow one set of rules.
import { App } from "./js/market.js";

class SiteActions {
  static registerActions(actions) {
    actions.register(SiteActions.readState());
    actions.register(SiteActions.negotiate());
    actions.register(SiteActions.acceptOffer());
    actions.register(SiteActions.verifyReceipt());
  }

  static readState() {
    return {
      name: "get_market_state",
      description: "Read the live market from the arbiter: every item (sku), seller, public list price per unit in naira, delivery time and stock, plus this visitor's negotiations, offers (with offer_id, total, saving, expiry) and receipts. Call it before answering about items, prices, sellers or offers, and again in each turn that needs it: the visitor can also use the page. Changes nothing.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        await App.page.refreshCatalog();
        return App.page.getState();
      },
    };
  }

  static negotiate() {
    return {
      name: "negotiate",
      description: "Seal the visitor's bid with the arbiter and get ranked offers. Needs: an sku from website_get_market_state, a quantity, the most the visitor will pay in TOTAL for that quantity in naira (ask if they gave a per-unit figure or none; never choose it for them), and a delivery deadline in hours. The browser asks the visitor to confirm before anything is sent. Each set of terms (sku, quantity, deadline, sellers) can be negotiated once; asking again with only a higher maximum is refused, and each item allows a limited number of negotiations per day (20 by default). Returns offers, or agreement false when no seller can meet the terms.",
      effect: "irreversible",
      inputSchema: {
        type: "object", additionalProperties: false,
        required: ["sku", "quantity", "max_total", "deliver_within_hours"],
        properties: {
          sku: { type: "string", minLength: 1, maxLength: 64, description: "Item sku from website_get_market_state, such as rice-50kg." },
          quantity: { type: "integer", minimum: 1, maximum: 10000, description: "How many units (bags, kegs) the visitor wants." },
          max_total: { type: "number", minimum: 1, maximum: 10000000, description: "The most the visitor will pay in total for all units, in naira, exactly as they said it." },
          deliver_within_hours: { type: "integer", minimum: 0, maximum: 2160, description: "Latest acceptable delivery, in hours from now (tomorrow ≈ 24, this week ≈ 168). Ask if unclear." },
          seller_ids: { type: "array", maxItems: 10, items: { type: "string" }, description: "Optional seller_id values from website_get_market_state, only when the visitor names sellers." },
        },
      },
      execute: (args) => App.page.negotiate(args),
    };
  }

  static acceptOffer() {
    return {
      name: "accept_offer",
      description: "Accept one open offer: binding, it reserves the seller's stock and returns a signed receipt (settlement is simulated in this demo). Call it only after the visitor chose this seller and price in this conversation. In the turn you call it, first call website_get_market_state to check the offer is still OPEN. The browser asks the visitor to confirm.",
      effect: "irreversible",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["offer_id"],
        properties: { offer_id: { type: "string", minLength: 5, maxLength: 64, description: "offer_id from website_get_market_state." } },
      },
      execute: (args, ctx) => App.page.acceptOffer(args, { signal: ctx?.signal }),
    };
  }

  static verifyReceipt() {
    return {
      name: "verify_receipt",
      description: "Check a receipt's signature in this browser against the arbiter's published key. Use it when the visitor gives a receipt id (rct_...) or asks whether a receipt is genuine. Changes nothing.",
      effect: "read",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["receipt_id"],
        properties: { receipt_id: { type: "string", minLength: 5, maxLength: 64 } },
      },
      execute: (args) => App.page.verifyReceipt(args),
    };
  }
}

export const registerActions = SiteActions.registerActions;
