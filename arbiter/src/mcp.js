// Minimal MCP server (Streamable HTTP, JSON responses) for Open Arbiter.
// Lets any MCP-capable agent, including an open-agentic-web network that lists
// this URL as a tool, negotiate through the arbiter.
import { ArbiterError } from "./core.js";

export const PROTOCOL_VERSION = "2025-06-18";

const money = {
  type: "number", exclusiveMinimum: 0,
  description: "Amount in major currency units (for NGN: naira, not kobo).",
};

export const TOOLS = [
  {
    name: "list_catalog",
    description: "List items sellers offer through the arbiter, with public list prices and delivery times. Never shows sellers' private minimum prices.",
    inputSchema: { type: "object", additionalProperties: false, properties: { sku: { type: "string", description: "Optional item id such as rice-50kg." } } },
  },
  {
    name: "negotiate",
    description: "Ask the arbiter to negotiate a purchase. The buyer's maximum is sealed: sellers never see it. Returns ranked offers (or no agreement) and a buyer_token needed to accept. Each set of terms can be negotiated once; re-trying with only a different budget is refused.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["sku", "quantity", "max_total", "deliver_within_hours"],
      properties: {
        sku: { type: "string" },
        quantity: { type: "integer", minimum: 1, maximum: 10000 },
        max_total: { ...money, description: "Most the buyer will pay for the whole quantity, in major units." },
        deliver_within_hours: { type: "integer", minimum: 0, maximum: 2160 },
        vendor_ids: { type: "array", items: { type: "string" }, maxItems: 50, description: "Optional: only negotiate with these sellers." },
      },
    },
  },
  {
    name: "accept_offer",
    description: "Accept one offer from a negotiation. This is binding: it reserves stock and issues a signed receipt. Only call after the human has explicitly agreed to this seller and price.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["offer_id", "buyer_token"],
      properties: { offer_id: { type: "string" }, buyer_token: { type: "string" } },
    },
  },
  {
    name: "get_receipt",
    description: "Fetch a signed receipt by id.",
    inputSchema: { type: "object", additionalProperties: false, required: ["receipt_id"], properties: { receipt_id: { type: "string" } } },
  },
  {
    name: "verify_receipt",
    description: "Check that a receipt was signed by this arbiter and has not been altered.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["receipt", "signature"],
      properties: { receipt: { type: "object" }, signature: { type: "string" } },
    },
  },
];

const toMinor = (major) => Math.round(Number(major) * 100);
const toMajor = (minor) => minor / 100;

/** Present amounts in major units for agents; minor units stay internal. */
export function presentOutcome(o) {
  return {
    mandate_id: o.mandate_id,
    state: o.state,
    agreement: o.agreement,
    message: o.message,
    mechanism: `${o.mechanism.name} ${o.mechanism.version}`,
    offers: o.offers.map((x) => ({
      offer_id: x.offer_id, vendor_id: x.vendor_id, vendor_name: x.vendor_name, vendor_origin: x.vendor_origin,
      item: x.title, unit: x.unit, quantity: x.quantity, currency: x.currency,
      total: toMajor(x.total_cents), list_total: toMajor(x.list_total_cents), saving: toMajor(x.saving_cents),
      price_step: toMajor(x.grid_step_cents),
      delivery_hours: x.delivery_hours, expires_at: new Date(x.expires_at * 1000).toISOString(), state: x.state,
    })),
    receipt_id: o.receipt_id,
  };
}

export function presentCatalog(rows) {
  return rows.map((r) => ({
    vendor_id: r.vendor_id, vendor_name: r.vendor_name, vendor_origin: r.vendor_origin,
    sku: r.sku, item: r.title, unit: r.unit, currency: r.currency,
    list_price: toMajor(r.ask_cents), delivery_hours: r.delivery_hours, in_stock: r.in_stock,
  }));
}

export async function callTool(arb, name, args, ctx) {
  args = args || {};
  switch (name) {
    case "list_catalog":
      return { items: presentCatalog(await arb.catalog({ sku: args.sku })) };
    case "negotiate": {
      const m = await arb.createMandate({
        sku: args.sku, quantity: args.quantity, max_total_cents: toMinor(args.max_total),
        deliver_within_hours: args.deliver_within_hours, vendor_ids: args.vendor_ids,
      }, ctx);
      const out = await arb.resolveMandate(m.mandate_id, m.buyer_token);
      return { buyer_token: m.buyer_token, ...presentOutcome(out) };
    }
    case "accept_offer":
      return arb.acceptOffer(args.offer_id, args.buyer_token);
    case "get_receipt":
      return arb.getReceipt(args.receipt_id);
    case "verify_receipt":
      return arb.verifyReceipt(args);
    default:
      throw new ArbiterError("unknown_tool", `Unknown tool ${name}.`, 404);
  }
}

/** Handle one JSON-RPC message. Returns the response object, or null for notifications. */
export async function handleRpc(arb, msg, ctx) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "open-arbiter", version: "1.0.0" },
        instructions: "Deterministic negotiation: sealed buyer maximums and seller minimums, Nash-midpoint prices on a price step of 2.5% of list (min 100 per unit), signed receipts. Get human approval before accept_offer.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args } = msg.params || {};
      try {
        const data = await callTool(arb, name, args, ctx);
        return reply({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
      } catch (e) {
        if (e instanceof ArbiterError) return reply({ content: [{ type: "text", text: `${e.code}: ${e.message}` }], isError: true });
        throw e;
      }
    }
    default:
      if (isNotification) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
