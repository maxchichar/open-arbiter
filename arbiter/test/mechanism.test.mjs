// P0.5 (F1): Nash midpoint on a per-unit price grid (plan B2 + A1).
//   unit_step = max(10,000 kobo, round(2.5% of the unit list price)); g = unit_step × quantity
//   L' = ceil(floor·q / g)·g ; U' = floor(min(max, ask·q) / g)·g ; L' > U' → no agreement
//   price = grid point nearest (L' + U') / 2, ties toward the buyer
// The point: an agreed price depends on a seller's floor only through which unit_step cell it
// falls in, at every quantity, so any number of deals narrows a floor to no less than one step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as mech from "../src/mechanism.js";
import { prng, replayable } from "./seeded.mjs";

const { resolve, MECHANISM } = mech;
const unitStep = (ask) => Math.max(10_000, Math.floor((ask * 25 + 500) / 1000)); // the plan's integer rule
const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

/** Outcome of one deal for a given floor: the total, or Infinity for no agreement (monotone in the floor). */
function key(floor, { ask, q, max }) {
  const out = resolve({ sku: "x", quantity: q, max_total_cents: max, deliver_within_hours: 48 },
    [{ vendor_id: "v", sku: "x", ask_cents: ask, floor_cents: floor, delivery_hours: 1, stock: 1e6 }]);
  return out.agreement ? out.offers[0].total_cents : Infinity;
}

/** Floors f in [1, ask] with key(f) == observed, found by binary search (key is non-decreasing in f). */
function consistentFloors(deal, observed) {
  const first = (pred) => { let lo = 1, hi = deal.ask + 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (pred(mid)) hi = mid; else lo = mid + 1; } return lo; };
  const lo = first((f) => key(f, deal) >= observed);
  const hi = first((f) => key(f, deal) > observed) - 1;
  return [lo, hi];
}

const randomAsk = (r) => (r() < 0.2 ? between(r, 1_000, 60_000) : between(r, 60_000, 50_000_000)); // ₦10 … ₦500,000 per unit

test("AC-F1-5: mechanism.js stays pure (no imports, clock or randomness)", () => {
  const src = readFileSync(new URL("../src/mechanism.js", import.meta.url), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  for (const banned of [/\bimport\b/, /\bDate\b/, /Math\.random/, /\bfetch\b/, /\bcrypto\b/, /performance\./]) assert.doesNotMatch(src, banned);
});

test("AC-F1-6: mechanism identity, and each offer names its step", () => {
  assert.equal(MECHANISM.name, "open-arbiter/nash-midpoint-grid");
  assert.equal(MECHANISM.version, "2.0.0");
  assert.equal(MECHANISM.grid_bps, 250);
  assert.equal(MECHANISM.grid_min_unit_cents, 10_000);
  assert.equal(MECHANISM.tie, "buyer");
  assert.equal(typeof mech.unitStep, "function");
  for (const ask of [1_000, 61_000, 400_000, 401_000, 9_000_000, 1_000_000_000]) assert.equal(mech.unitStep(ask), unitStep(ask), `ask ${ask}`);
  const o = resolve({ sku: "x", quantity: 2, max_total_cents: 17_000_000, deliver_within_hours: 48 },
    [{ vendor_id: "v", sku: "x", ask_cents: 9_000_000, floor_cents: 7_500_000, delivery_hours: 1, stock: 9 }]).offers[0];
  assert.equal(o.unit_step_cents, 225_000);
  assert.equal(o.grid_step_cents, 450_000);
});

test("worked example (plan D1): rice, q 2, max ₦170,000, ask ₦90,000, floor ₦75,000 → ₦157,500", () => {
  const o = resolve({ sku: "x", quantity: 2, max_total_cents: 17_000_000, deliver_within_hours: 48 },
    [{ vendor_id: "v", sku: "x", ask_cents: 9_000_000, floor_cents: 7_500_000, delivery_hours: 1, stock: 9 }]).offers[0];
  assert.equal(o.total_cents, 15_750_000);
  assert.equal(o.saving_cents, 18_000_000 - 15_750_000);
});

test("AC-F1-2: a zone with no grid point gives no offer", () => {
  // g = 450,000 (ask ₦180,000, q 1); L = 15,100,000 → L' = 15,300,000 > U' = 14,850,000
  const out = resolve({ sku: "x", quantity: 1, max_total_cents: 15_200_000, deliver_within_hours: 48 },
    [{ vendor_id: "v", sku: "x", ask_cents: 18_000_000, floor_cents: 15_100_000, delivery_hours: 1, stock: 9 }]);
  assert.equal(out.agreement, false);
  assert.equal(out.offers.length, 0);
});

test("tie between two grid points goes to the buyer (lower)", () => {
  // u = 10,000 (ask 100,000 → 2,500 < min), q 1: L' = 50,000, U' = 80,000, midpoint 65,000 is a tie → 60,000
  const o = resolve({ sku: "x", quantity: 1, max_total_cents: 80_000, deliver_within_hours: 48 },
    [{ vendor_id: "v", sku: "x", ask_cents: 100_000, floor_cents: 50_000, delivery_hours: 1, stock: 9 }]).offers[0];
  assert.equal(o.total_cents, 60_000);
});

test("AC-F1-1: totals are on the grid and inside [floor·q, min(max, ask·q)] (20,000 cases)", replayable(() => {
  const r = prng();
  for (let i = 0; i < 20_000; i++) {
    const ask = randomAsk(r), q = between(r, 1, 12), floor = between(r, 1, ask), max = between(r, 1, ask * q * 2);
    const out = resolve({ sku: "x", quantity: q, max_total_cents: max, deliver_within_hours: 48 },
      [{ vendor_id: "v", sku: "x", ask_cents: ask, floor_cents: floor, delivery_hours: 1, stock: 1e6 }]);
    if (!out.agreement) continue;
    const t = out.offers[0].total_cents, g = unitStep(ask) * q;
    assert.equal(t % g, 0, `total ${t} not a multiple of ${g} (ask ${ask}, q ${q})`);
    assert.ok(t >= floor * q && t <= Math.min(max, ask * q), `total ${t} outside [${floor * q}, ${Math.min(max, ask * q)}]`);
  }
}));

test("the outcome is monotone in the floor (exhaustive on small asks), so binary search is exact", replayable(() => {
  const r = prng();
  for (let i = 0; i < 40; i++) {
    const deal = { ask: between(r, 1_000, 60_000), q: between(r, 1, 4) };
    deal.max = between(r, 1, deal.ask * deal.q * 2);
    let prev = -Infinity;
    for (let f = 1; f <= deal.ask; f++) { const k = key(f, deal); assert.ok(k >= prev, `not monotone at floor ${f}`); prev = k; }
  }
}));

test("AC-F1-4: two floors in the same unit_step cell give the same result, at q = 1..12", replayable(() => {
  const r = prng();
  for (let i = 0; i < 3_000; i++) {
    const ask = randomAsk(r), u = unitStep(ask), q = between(r, 1, 12), max = between(r, 1, ask * q * 2);
    const cell = between(r, 1, Math.ceil(ask / u));
    const a = Math.min(ask, between(r, (cell - 1) * u + 1, cell * u)), b = Math.min(ask, between(r, (cell - 1) * u + 1, cell * u));
    assert.equal(key(a, { ask, q, max }), key(b, { ask, q, max }), `floors ${a}, ${b} (cell ${cell}, u ${u}, ask ${ask}, q ${q}, max ${max})`);
  }
}));

test("AC-F1-3: one agreed price leaves at least one unit_step of possible floors, and g of possible maxima", replayable(() => {
  const r = prng();
  let agreed = 0;
  for (let i = 0; i < 2_000; i++) {
    const ask = randomAsk(r), q = between(r, 1, 12), max = between(r, 1, ask * q * 2), floor = between(r, 1, ask);
    const deal = { ask, q, max };
    const p = key(floor, deal);
    if (p === Infinity) continue;
    agreed++;
    const [lo, hi] = consistentFloors(deal, p);
    assert.ok(hi - lo + 1 >= unitStep(ask), `floors ${lo}..${hi} (${hi - lo + 1}) < unit_step ${unitStep(ask)} (ask ${ask}, q ${q}, max ${max}, price ${p})`);
    // Seller's view: maxima consistent with p. Price is non-decreasing in the max.
    const byMax = (m) => key(floor, { ask, q, max: m });
    const top = ask * q * 2;
    const first = (pred) => { let a = 1, b = top + 1; while (a < b) { const mid = Math.floor((a + b) / 2); if (pred(mid)) b = mid; else a = mid + 1; } return a; };
    const mlo = first((m) => byMax(m) !== Infinity && byMax(m) >= p), mhi = first((m) => byMax(m) !== Infinity && byMax(m) > p) - 1;
    assert.ok(mhi - mlo + 1 >= unitStep(ask) * q || mhi >= top, `maxima ${mlo}..${mhi} narrower than g ${unitStep(ask) * q}`);
  }
  assert.ok(agreed > 300, `only ${agreed} agreements sampled`);
}));

/** A2: three deals at q = 1, 2, 3 against one seller; floors consistent with all observed outcomes. */
function threeDeals(r, ask, floor) {
  let lo = 1, hi = ask, any = false;
  for (const q of [1, 2, 3]) {
    const deal = { ask, q, max: between(r, Math.floor(ask * q * 0.5), ask * q * 1.2) };
    const obs = key(floor, deal);
    if (obs !== Infinity) any = true;
    const [a, b] = consistentFloors(deal, obs);
    lo = Math.max(lo, a); hi = Math.min(hi, b);
  }
  return { any, lo, hi };
}

test("AC-F1-7: three deals at q = 1, 2, 3 still leave at least one unit_step of possible floors (2,000 sequences)", replayable(() => {
  const r = prng();
  for (let i = 0; i < 2_000; i++) {
    const ask = randomAsk(r), floor = between(r, Math.floor(ask * 0.5), ask);
    const { any, lo, hi } = threeDeals(r, ask, floor);
    assert.ok(lo <= floor && floor <= hi, "the true floor is consistent");
    if (any) assert.ok(hi - lo + 1 >= unitStep(ask), `floors ${lo}..${hi} (${hi - lo + 1}) < ${unitStep(ask)} (ask ${ask}, floor ${floor})`);
  }
}));

test("AC-F1-7, low price: ask ₦610 uses the ₦100 minimum step", replayable(() => {
  const ask = 61_000;
  assert.equal(unitStep(ask), 10_000);
  const r = prng();
  let agreed = 0;
  for (let i = 0; i < 500; i++) {
    const floor = between(r, 30_000, ask);
    const { any, lo, hi } = threeDeals(r, ask, floor);
    if (!any) continue;
    agreed++;
    assert.ok(hi - lo + 1 >= 10_000, `floors ${lo}..${hi} (${hi - lo + 1}) < 10,000 (floor ${floor})`);
  }
  assert.ok(agreed > 50, `only ${agreed} agreeing sequences`);
}));
