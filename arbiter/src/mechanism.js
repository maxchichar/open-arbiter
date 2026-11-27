// Deterministic negotiation mechanism for Open Arbiter.
// Pure functions only: no I/O, no clock, no randomness. Everything that
// decides a price lives here so it can be read, tested and audited on its own.

export const MECHANISM = Object.freeze({
  name: "open-arbiter/nash-midpoint-grid",
  version: "3.0.0",
  buyer_weight: "1/2",
  seller_weight: "1/2",
  grid_bps: 250, // price step per unit: at most 2.5% of the unit list price ...
  grid_min_unit_cents: 10_000, // ... at least 10,000 minor units (₦100) ...
  grid_rule: "pow2", // ... and always 10,000 × 2^k, so the grids of different list prices nest
  tie: "buyer", // a midpoint exactly between two steps goes to the lower price
});

/**
 * Price step per unit, in minor units: the largest 10,000 × 2^k (₦100, ₦200, ₦400, …) not above 2.5%
 * of the unit list price (rounded half up), and 10,000 when 2.5% is below that. So the step is
 * between 1.25% and 2.5% of the list price, and every step divides every larger one: when a seller
 * changes its list price, the old and new grids nest, and deals on both still leave at least the
 * smaller step of possible floors. Integer-only: ask ≤ 1e9, so ask × 250 ≤ 2.5e11, inside 2^53.
 */
export function unitStep(askCents) {
  const target = Math.floor((askCents * MECHANISM.grid_bps + 5_000) / 10_000);
  let step = MECHANISM.grid_min_unit_cents;
  while (step * 2 <= target) step *= 2;
  return step;
}

/**
 * The highest floor a listing may seal: the top of the last whole step at or below the ask. A floor
 * above it sits in a step cut off by the ask, so it could never trade, and "no deal even at list
 * price" would reveal it to less than one step. 0 when the ask is below one step.
 */
export function maxFloor(askCents) {
  const u = unitStep(askCents);
  return Math.floor(askCents / u) * u;
}

export const LIMITS = Object.freeze({
  maxQuantity: 10_000,
  maxCents: 1_000_000_000, // 10M in major units; guards integer overflow and typos
  maxDeliveryHours: 24 * 90,
  offerTtlSeconds: 15 * 60,
});

const isInt = (v) => Number.isSafeInteger(v);

/** Validate a vendor's sealed listing. Returns a list of problems (empty = valid). */
export function checkListing(l) {
  const p = [];
  if (typeof l.sku !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(l.sku)) p.push("sku must be 1-64 chars of a-z, 0-9, _ or -");
  if (!isInt(l.ask_cents) || l.ask_cents <= 0 || l.ask_cents > LIMITS.maxCents) p.push("ask_cents must be a positive integer");
  if (!isInt(l.floor_cents) || l.floor_cents <= 0 || l.floor_cents > LIMITS.maxCents) p.push("floor_cents must be a positive integer");
  if (isInt(l.ask_cents) && isInt(l.floor_cents) && l.floor_cents > l.ask_cents) p.push("floor_cents cannot exceed ask_cents");
  else if (isInt(l.ask_cents) && l.ask_cents > 0 && l.ask_cents <= LIMITS.maxCents) {
    const top = maxFloor(l.ask_cents);
    if (top === 0) p.push(`ask_cents must be at least ${MECHANISM.grid_min_unit_cents}: prices move in steps of at least ${MECHANISM.grid_min_unit_cents}`);
    else if (isInt(l.floor_cents) && l.floor_cents > top) p.push(`floor_cents must be at most ${top} for this ask_cents: prices move in steps of ${unitStep(l.ask_cents)}, and a floor in the last, cut-off step could never be met`);
  }
  if (!isInt(l.delivery_hours) || l.delivery_hours < 0 || l.delivery_hours > LIMITS.maxDeliveryHours) p.push("delivery_hours must be an integer between 0 and 2160");
  if (!isInt(l.stock) || l.stock < 0 || l.stock > LIMITS.maxQuantity * 100) p.push("stock must be a non-negative integer");
  return p;
}

/** Validate a buyer's mandate. Returns a list of problems (empty = valid). */
export function checkMandate(m) {
  const p = [];
  if (typeof m.sku !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.sku)) p.push("sku must be 1-64 chars of a-z, 0-9, _ or -");
  if (!isInt(m.quantity) || m.quantity < 1 || m.quantity > LIMITS.maxQuantity) p.push("quantity must be an integer between 1 and 10000");
  if (!isInt(m.max_total_cents) || m.max_total_cents <= 0 || m.max_total_cents > LIMITS.maxCents) p.push("max_total_cents must be a positive integer");
  if (!isInt(m.deliver_within_hours) || m.deliver_within_hours < 0 || m.deliver_within_hours > LIMITS.maxDeliveryHours) p.push("deliver_within_hours must be an integer between 0 and 2160");
  if (m.vendor_ids !== undefined && (!Array.isArray(m.vendor_ids) || m.vendor_ids.length > 50 || m.vendor_ids.some((v) => typeof v !== "string"))) p.push("vendor_ids must be a list of up to 50 vendor ids");
  return p;
}

/**
 * Terms that identify a negotiation for anti-probing. Two mandates from the same
 * buyer with the same terms are the same negotiation, whatever the budget, so a
 * buyer cannot rerun it with a different budget to discover a seller's floor.
 */
export function termsKey(m) {
  const vendors = m.vendor_ids ? [...m.vendor_ids].sort().join(",") : "*";
  return `${m.sku}|${m.quantity}|${m.deliver_within_hours}|${vendors}`;
}

/**
 * Resolve one mandate against sealed listings.
 *
 * For each eligible listing, with linear utilities and equal bargaining weight, the Nash
 * bargaining solution is the midpoint of the zone of possible agreement [lower, upper]:
 *   lower = floor_cents × quantity                     (seller's walk-away)
 *   upper = min(max_total_cents, ask_cents × quantity)  (buyer's walk-away, capped at list price)
 *
 * Prices are on a grid, so an agreed price reveals little about either limit:
 *   g  = unitStep(ask_cents) × quantity   (unitStep = ₦100 × 2^k, at most 2.5% of the unit list price)
 *   L' = ceil(lower / g) × g,  U' = floor(upper / g) × g   (the zone, snapped inwards to the grid)
 *   L' > U' → no agreement with this listing
 *   price = the grid point nearest (L' + U') / 2, ties toward the buyer
 * The price depends on the floor only through ceil(floor / unitStep), the same cells at every
 * quantity, so any number of deals narrows a floor to no less than one step (and the buyer's
 * maximum to no less than g). Steps of different list prices nest, and checkListing keeps a floor's
 * cell wholly at or below the ask, so this holds across list-price changes too, with the smallest
 * step used. The price stays within [lower, upper].
 *
 * A listing is eligible only if it has the stock and can deliver within the buyer's deadline.
 * Offers are ranked by price, then delivery time, then vendor id, so the order is fully
 * deterministic. The result never contains a floor, a budget, or which side's limit failed.
 */
export function resolve(mandate, listings) {
  const offers = [];
  let considered = 0;
  for (const l of listings) {
    if (l.sku !== mandate.sku) continue;
    if (mandate.vendor_ids && !mandate.vendor_ids.includes(l.vendor_id)) continue;
    considered++;
    if (l.stock < mandate.quantity) continue;
    if (l.delivery_hours > mandate.deliver_within_hours) continue;
    const q = mandate.quantity;
    const unit = unitStep(l.ask_cents);
    const g = unit * q;
    const lo = Math.ceil((l.floor_cents * q) / g); // grid indexes: L' = lo·g, U' = hi·g
    const hi = Math.floor(Math.min(mandate.max_total_cents, l.ask_cents * q) / g);
    if (lo > hi) continue;
    const total = Math.floor((lo + hi) / 2) * g; // nearest to (L' + U') / 2; a tie rounds down
    offers.push({
      vendor_id: l.vendor_id,
      sku: l.sku,
      quantity: q,
      total_cents: total,
      list_total_cents: l.ask_cents * q,
      saving_cents: l.ask_cents * q - total,
      unit_step_cents: unit,
      grid_step_cents: g,
      delivery_hours: l.delivery_hours,
    });
  }
  offers.sort((a, b) => a.total_cents - b.total_cents || a.delivery_hours - b.delivery_hours || (a.vendor_id < b.vendor_id ? -1 : a.vendor_id > b.vendor_id ? 1 : 0));
  return { mechanism: MECHANISM, considered, agreement: offers.length > 0, offers };
}

/** Canonical JSON: keys sorted at every level, so a signature covers one exact byte string. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
