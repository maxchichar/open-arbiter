# ADR 0001: Price leakage policy (B2 snap-then-midpoint on a per-unit grid)

- **Status:** accepted, 2026-11-23 (owner decision B2, amendments A1 and A2 in `docs/rpi/arbiter-hardening/plan.md`)
- **Task:** P0.5 (F1), slice 5, commit `14aac06`
- **Code:** `arbiter/src/mechanism.js` (`unitStep`, `resolve`, `MECHANISM` 2.0.0)
- **Tests:** `arbiter/test/mechanism.test.mjs` (AC-F1-1 to AC-F1-7)

## Context

The arbiter offers the Nash bargaining midpoint of the zone `[lower, upper]`, where `lower = floor × q` and `upper = min(max, ask × q)`. Version 1.0.0 offered the exact midpoint. A buyer who knows `max`, `ask` and `q` and sees one agreed price could solve for the seller's floor exactly: the red run recovered `floors 3164..3164` from one deal (`evidence/slice5-red-mechanism.txt`). The page and README said that limits are never revealed, which was false.

An agreed price always reveals *something* about the zone. Hiding a limit completely would mean refusing to show the price. The aim is a **stated, bounded** leak.

## Decision

Prices are on a per-unit grid, and the zone is snapped to the grid before taking the midpoint (option B2):

```text
unit_step = max(10,000, round_half_up(2.5% × ask))   kobo per unit (₦100 minimum)
g         = unit_step × q
L' = ceil(lower / g) × g      U' = floor(upper / g) × g
L' > U'  → no offer from this listing
price    = the grid point nearest (L' + U') / 2; a tie goes to the buyer (lower price)
```

`MECHANISM = open-arbiter/nash-midpoint-grid 2.0.0` with `grid_bps 250`, `grid_min_unit_cents 10000`, `tie: "buyer"`. Every offer and receipt carries `unit_step_cents` and `grid_step_cents`.

## The bound

`lo = ceil(floor × q / (unit_step × q)) = ceil(floor / unit_step)`. **The outcome depends on the floor only through which `unit_step` cell it is in, `((k−1)·u, k·u]`, and the cells are the same at every quantity.** This follows directly from the code, and the property tests check it:

| Property | Test |
| --- | --- |
| Totals are on the grid and inside `[floor·q, min(max, ask·q)]` | AC-F1-1, 20,000 seeded cases |
| Two floors in the same cell give the same result, q = 1..12 | AC-F1-4, 3,000 cases |
| One agreed price leaves ≥ `unit_step` possible floors, and ≥ `g` possible maxima (or every max ≥ list) | AC-F1-3, 2,000 cases |
| Three deals at q = 1, 2, 3 with independent maxima (prices and no-deals) still leave ≥ `unit_step` possible floors | AC-F1-7, 2,000 sequences, plus ask ₦610 where the ₦100 minimum applies |

So for a fixed listing (same `ask`, same `floor`), **any number of deals, at any quantities and budgets, narrows the floor to no less than one step**: 2.5% of the unit list price, or ₦100 if that is larger. The buyer's maximum is narrowed only to one `g` per mandate.

Over agreements, the domain edge is safe: a floor in the top cell, cut short by `floor ≤ ask`, can never reach agreement (`ceil(f/u)·u > ask ≥ U'/q`), so no price reveals it.

## Multi-deal caveat (what the bound does *not* say)

1. **One step is reachable.** The bound is a floor on what is left, not a promise that deals reveal less than that. Enough deals with chosen budgets can pin the floor to its exact cell, which is ±2.5% of the list price. The anti-probing limits (3 mandates per item per buyer per day, identical terms once) slow this down but do not prevent it. They key on a salted IP hash, so a prober with many IPs gets more attempts.
2. **The bound holds per (ask, floor) pair.** If a seller changes its **ask**, `unit_step` changes and the grid moves. Deals made before and after the change see two different cell grids, and their intersection can be narrower than one step. For example, u = 2,500 then u = 2,600: cells `(5,000, 7,500]` and `(5,200, 7,800]` intersect in `(5,200, 7,500]`, which is 2,300 kobo. The tests fix `ask`. The seller makes this change, not the buyer. It is recorded, not mitigated. A possible mitigation is to anchor `unit_step` to a value that changes rarely, such as a per-listing step stored at creation.
3. **Floor changes are visible.** If a seller moves its floor into another cell, outcomes before and after differ. That reveals that a change happened and which cells were involved, not the exact values.
4. **No-agreement outcomes carry information too.** A no-deal says `ceil(floor/u) > hi`, which is still a statement about the cell, so the bound includes it. AC-F1-7 counts no-deals.
5. **Out of scope of this policy:** the arbiter operator sees both limits. The visitor's AI provider sees whatever the visitor types, including a maximum.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Exact midpoint (1.0.0) | Reveals the floor exactly from one deal |
| B1: midpoint, then round to the grid and clamp | Failed the one-step property in 17 of 1,789 agreements near the domain edge (plan D1) |
| Grid step `g` fixed per total (not per unit) | Cells differ by quantity, so deals at q = 1, 2, 3 intersect to less than a step (risk R1). Replaced by A1 |
| Random noise | Breaks invariant 2 (deterministic pricing) and makes receipts non-reproducible |
| Hide the price | Defeats the product |

## Consequences

- Prices move by up to one step from the 1.0.0 values (listed in `evidence/slice5.md`). A deal whose zone holds no grid point gets no offer, even though the zone is non-empty.
- Each side gives up at most one step of surplus to rounding, and ties favour the buyer.
- Receipts issued under 1.0.0 still verify, because each signature covers its own payload, including the mechanism version.
- CLAUDE.md invariant 1 states this bound, and the property tests must keep passing.
