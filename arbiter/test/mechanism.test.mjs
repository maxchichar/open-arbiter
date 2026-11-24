// P0.5 (F1): Nash midpoint on a per-unit price grid (plan B2 + A1), nested since the Phase 0 gate
// (review finding R1, owner 2026-11-24):
//   unit_step = 10,000 kobo × 2^k, the largest not above round(2.5% of the unit list price)
//               (10,000 if 2.5% is below that); g = unit_step × quantity
//   L' = ceil(floor·q / g)·g ; U' = floor(min(max, ask·q) / g)·g ; L' > U' → no agreement
//   price = grid point nearest (L' + U') / 2, ties toward the buyer
// The point: an agreed price depends on a seller's floor only through which unit_step cell it
// falls in, at every quantity, so any number of deals narrows a floor to no less than one step.
// All steps are ₦100 × 2^k, so the grids of different asks nest: a cell of a larger step is a union of
// cells of a smaller one. A listing is valid only if its floor's cell lies wholly at or below the ask
// (floor ≤ floor(ask/u)·u), so every observation, including "no deal", is a union of whole cells, and
// deals across ask changes still leave at least the smallest step used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as mech from "../src/mechanism.js";
import { prng, replayable } from "./seeded.mjs";

const { resolve, MECHANISM } = mech;
/** The rule, written independently of mechanism.js: ₦100 × 2^k, largest not above round(2.5% × ask). */
const unitStep = (ask) => { const target = Math.floor((ask * 25 + 500) / 1000); let s = 10_000; while (s * 2 <= target) s *= 2; return s; };
/** The highest valid floor for an ask: the top of the last whole step at or below the ask. */
const topFloor = (ask) => Math.floor(ask / unitStep(ask)) * unitStep(ask);
const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

/** Outcome of one deal for a given floor: the total, or Infinity for no agreement (monotone in the floor). */
function key(floor, { ask, q, max }) {
  const out = resolve({ sku: "x", quantity: q, max_total_cents: max, deliver_within_hours: 48 },
    [{ vendor_id: "v", sku: "x", ask_cents: ask, floor_cents: floor, delivery_hours: 1, stock: 1e6 }]);
  return out.agreement ? out.offers[0].total_cents : Infinity;
}

/**
 * Floors f in [1, topFloor(ask)] with key(f) == observed, found by binary search (key is non-decreasing
 * in f). The buyer knows the listing is valid, so the search domain is the valid floors.
 */
function consistentFloors(deal, observed) {
  const first = (pred) => { let lo = 1, hi = topFloor(deal.ask) + 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (pred(mid)) hi = mid; else lo = mid + 1; } return lo; };
  const lo = first((f) => key(f, deal) >= observed);
  const hi = first((f) => key(f, deal) > observed) - 1;
  return [lo, hi];
}

const randomAsk = (r) => (r() < 0.2 ? between(r, 10_000, 60_000) : between(r, 60_000, 50_000_000)); // ₦100 … ₦500,000 per unit
const validFloor = (r, ask, fromShare = 0) => between(r, Math.max(1, Math.min(Math.floor(ask * fromShare), topFloor(ask))), topFloor(ask));

test("AC-F1-5: mechanism.js stays pure (no imports, clock or randomness)", () => {
  const src = readFileSync(new URL("../src/mechanism.js", import.meta.url), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  for (const banned of [/\bimport\b/, /\bDate\b/, /Math\.random/, /\bfetch\b/, /\bcrypto\b/, /performance\./]) assert.doesNotMatch(src, banned);
});

test("AC-F1-6: mechanism identity, and each offer names its step", () => {
  assert.equal(MECHANISM.name, "open-arbiter/nash-midpoint-grid");
  assert.equal(MECHANISM.version, "3.0.0");
  assert.equal(MECHANISM.grid_rule, "pow2");
  assert.equal(MECHANISM.grid_bps, 250);
  assert.equal(MECHANISM.grid_min_unit_cents, 10_000);
  assert.equal(MECHANISM.tie, "buyer");
  assert.equal(typeof mech.unitStep, "function");
  for (const ask of [1_000, 61_000, 400_000, 401_000, 800_000, 820_000, 9_000_000, 1_000_000_000]) assert.equal(mech.unitStep(ask), unitStep(ask), `ask ${ask}`);
  assert.deepEqual([61_000, 800_000, 820_000, 9_000_000, 18_400_000].map(mech.unitStep), [10_000, 20_000, 20_000, 160_000, 320_000]);
  const o = resolve({ sku: "x", quantity: 2, max_total_cents: 17_000_000, deliver_within_hours: 48 },
    [{ vendor_id: "v", sku: "x", ask_cents: 9_000_000, floor_cents: 7_500_000, delivery_hours: 1, stock: 9 }]).offers[0];
  assert.equal(o.unit_step_cents, 160_000); // 2.5% of ₦90,000 is ₦2,250 → ₦1,600 (₦100 × 16)
  assert.equal(o.grid_step_cents, 320_000);
});

// g = 320,000: L' = ceil(15,000,000 / g) = 47 steps, U' = floor(17,000,000 / g) = 53, midpoint 50 → ₦160,000
test("worked example (plan D1): rice, q 2, max ₦170,000, ask ₦90,000, floor ₦75,000 → ₦160,000", () => {
  const o = resolve({ sku: "x", quantity: 2, max_total_cents: 17_000_000, deliver_within_hours: 48 },
    [{ vendor_id: "v", sku: "x", ask_cents: 9_000_000, floor_cents: 7_500_000, delivery_hours: 1, stock: 9 }]).offers[0];
  assert.equal(o.total_cents, 16_000_000);
  assert.equal(o.saving_cents, 18_000_000 - 16_000_000);
});

test("AC-F1-2: a zone with no grid point gives no offer", () => {
  // g = 320,000 (ask ₦180,000, q 1); L = 15,100,000 → L' = 15,360,000 > U' = 15,040,000
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
    const ask = randomAsk(r), q = between(r, 1, 12), floor = validFloor(r, ask), max = between(r, 1, ask * q * 2);
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
    const deal = { ask: between(r, 10_000, 60_000), q: between(r, 1, 4) };
    deal.max = between(r, 1, deal.ask * deal.q * 2);
    let prev = -Infinity;
    for (let f = 1; f <= topFloor(deal.ask); f++) { const k = key(f, deal); assert.ok(k >= prev, `not monotone at floor ${f}`); prev = k; }
  }
}));

test("AC-F1-4: two floors in the same unit_step cell give the same result, at q = 1..12", replayable(() => {
  const r = prng();
  for (let i = 0; i < 3_000; i++) {
    const ask = randomAsk(r), u = unitStep(ask), q = between(r, 1, 12), max = between(r, 1, ask * q * 2);
    const cell = between(r, 1, Math.floor(ask / u)); // whole cells only: a valid floor is never in a cut-off top cell
    const a = between(r, (cell - 1) * u + 1, cell * u), b = between(r, (cell - 1) * u + 1, cell * u);
    assert.equal(key(a, { ask, q, max }), key(b, { ask, q, max }), `floors ${a}, ${b} (cell ${cell}, u ${u}, ask ${ask}, q ${q}, max ${max})`);
  }
}));

test("AC-F1-3: one agreed price leaves at least one unit_step of possible floors, and g of possible maxima", replayable(() => {
  const r = prng();
  let agreed = 0;
  for (let i = 0; i < 2_000; i++) {
    const ask = randomAsk(r), q = between(r, 1, 12), max = between(r, 1, ask * q * 2), floor = validFloor(r, ask);
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
  let lo = 1, hi = topFloor(ask), any = false;
  for (const q of [1, 2, 3]) {
    const deal = { ask, q, max: between(r, Math.floor(ask * q * 0.5), ask * q * 1.2) };
    const obs = key(floor, deal);
    if (obs !== Infinity) any = true;
    const [a, b] = consistentFloors(deal, obs);
    lo = Math.max(lo, a); hi = Math.min(hi, b);
  }
  return { any, lo, hi };
}

test("AC-F1-7: three deals at q = 1, 2, 3 still leave at least one unit_step of possible floors (2,000 sequences, no-deals included)", replayable(() => {
  const r = prng();
  for (let i = 0; i < 2_000; i++) {
    const ask = randomAsk(r), floor = validFloor(r, ask, 0.5);
    const { lo, hi } = threeDeals(r, ask, floor);
    assert.ok(lo <= floor && floor <= hi, "the true floor is consistent");
    assert.ok(hi - lo + 1 >= unitStep(ask), `floors ${lo}..${hi} (${hi - lo + 1}) < ${unitStep(ask)} (ask ${ask}, floor ${floor})`);
  }
}));

test("AC-F1-7, low price: ask ₦610 uses the ₦100 minimum step", replayable(() => {
  const ask = 61_000;
  assert.equal(unitStep(ask), 10_000);
  const r = prng();
  let agreed = 0;
  for (let i = 0; i < 500; i++) {
    const floor = validFloor(r, ask, 0.5);
    const { any, lo, hi } = threeDeals(r, ask, floor);
    if (!any) continue;
    agreed++;
    assert.ok(hi - lo + 1 >= 10_000, `floors ${lo}..${hi} (${hi - lo + 1}) < 10,000 (floor ${floor})`);
  }
  assert.ok(agreed > 50, `only ${agreed} agreeing sequences`);
}));

// Review finding R1 (Phase 0 gate, 2026-11-24): with a 2.5% step that tracks the ask, a seller who
// re-listed at a new ask, keeping its floor, moved the grid; deals on both grids intersected to less
// than one step (reviewer's example: floor ₦162,000 at asks ₦184,000 then ₦180,000 left 100,000 kobo
// against a 450,000 step). Fix (owner): nested ₦100 × 2^k steps, and valid listings only.

test("R1: every step is ₦100 × 2^k, so the grids of any two asks nest", replayable(() => {
  const r = prng();
  for (let i = 0; i < 5_000; i++) {
    const a = mech.unitStep(randomAsk(r)), b = mech.unitStep(randomAsk(r));
    assert.equal(Math.max(a, b) % Math.min(a, b), 0, `steps ${a} and ${b} do not nest`);
    assert.ok(Number.isInteger(Math.log2(a / 10_000)), `step ${a} is not ₦100 × 2^k`);
  }
}));

test("R1/R2: a listing whose floor is in the cut-off top step is refused (it could never trade, and a no-deal would pin it)", () => {
  const listing = (ask, floor) => ({ sku: "x", ask_cents: ask, floor_cents: floor, delivery_hours: 1, stock: 1 });
  // ask ₦990: step ₦100, the highest valid floor is ₦900
  assert.deepEqual(mech.checkListing(listing(99_000, 90_000)), []);
  assert.match(mech.checkListing(listing(99_000, 95_000)).join(), /floor_cents must be at most 90000/);
  assert.match(mech.checkListing(listing(9_000, 5_000)).join(), /ask_cents must be at least 10000/);
  // Before the fix this listing was accepted and never traded, even with a buyer paying list price.
  const out = resolve({ sku: "x", quantity: 1, max_total_cents: 99_000, deliver_within_hours: 48 }, [{ vendor_id: "v", ...listing(99_000, 95_000) }]);
  assert.equal(out.agreement, false);
});

test("R1: the reviewer's example: floor ₦162,000, asks ₦184,000 then ₦180,000, still one step of possible floors", () => {
  const floor = 16_200_000;
  let lo = 1, hi = Infinity, minStep = Infinity;
  for (const ask of [18_400_000, 18_000_000]) {
    minStep = Math.min(minStep, unitStep(ask));
    for (const max of [floor + 100_000, floor + 500_000, ask]) {
      const deal = { ask, q: 1, max };
      const [a, b] = consistentFloors(deal, key(floor, deal));
      lo = Math.max(lo, a); hi = Math.min(hi, b);
    }
  }
  assert.ok(lo <= floor && floor <= hi, "the true floor is consistent");
  assert.ok(hi - lo + 1 >= minStep, `floors ${lo}..${hi} (${hi - lo + 1}) < one step ${minStep}`);
});

test("R1: deals across 2-4 ask changes (same floor, q 1-3, any budgets) leave at least the smallest step used (2,000 sequences)", replayable(() => {
  const r = prng();
  let changes = 0;
  for (let i = 0; i < 2_000; i++) {
    const floor = between(r, 10_000, 40_000_000);
    let lo = 1, hi = Infinity, minStep = Infinity;
    const asks = new Set();
    for (let n = between(r, 2, 4), tries = 0; asks.size < n && tries < 50; tries++) {
      const ask = between(r, floor, Math.floor(floor * 1.6));
      if (floor <= topFloor(ask)) asks.add(ask); // the arbiter accepts only valid listings
    }
    if (asks.size < 2) continue;
    if (new Set([...asks].map(unitStep)).size > 1) changes++;
    for (const ask of asks) {
      minStep = Math.min(minStep, unitStep(ask));
      for (let d = between(r, 1, 3); d > 0; d--) {
        const q = between(r, 1, 3), deal = { ask, q, max: between(r, Math.floor(floor * q * 0.9), ask * q * 1.1) };
        const [a, b] = consistentFloors(deal, key(floor, deal));
        lo = Math.max(lo, a); hi = Math.min(hi, b);
      }
    }
    assert.ok(lo <= floor && floor <= hi, `the true floor ${floor} is consistent`);
    assert.ok(hi - lo + 1 >= minStep, `floors ${lo}..${hi} (${hi - lo + 1}) < smallest step ${minStep} (asks ${[...asks]}, floor ${floor})`);
  }
  assert.ok(changes > 300, `only ${changes} sequences changed the step`);
}));
