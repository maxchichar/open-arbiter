# ADR 0001: Price leakage policy (B2 snap-then-midpoint on a nested per-unit grid)

- **Status:** accepted, 2026-11-23 (owner decision B2, amendments A1 and A2 in `docs/rpi/arbiter-hardening/plan.md`). **Amended 2026-11-24** after review finding R1: nested ₦100 × 2^k steps and valid listings only (mechanism 3.0.0, owner decision). **Amended 2026-11-27** (owner): the daily negotiation cap is load protection, not price protection, and rises from 3 to 20 (see "The daily cap" below).
- **Task:** P0.5 (F1), slice 5, commit `14aac06`; amended at the Phase 0 gate, commit `175b4d1`
- **Code:** `arbiter/src/mechanism.js` (`unitStep`, `maxFloor`, `checkListing`, `resolve`, `MECHANISM` 3.0.0)
- **Tests:** `arbiter/test/mechanism.test.mjs` (AC-F1-1 to AC-F1-7, R1)

## Context

The arbiter offers the Nash bargaining midpoint of the zone `[lower, upper]`, where `lower = floor × q` and `upper = min(max, ask × q)`. Version 1.0.0 offered the exact midpoint. A buyer who knows `max`, `ask` and `q` and sees one agreed price could solve for the seller's floor exactly: the red run recovered `floors 3164..3164` from one deal (`evidence/slice5-red-mechanism.txt`). The page and README said that limits are never revealed, which was false.

An agreed price always reveals *something* about the zone. Hiding a limit completely would mean refusing to show the price. The aim is a **stated, bounded** leak.

## Decision

Prices are on a per-unit grid, and the zone is snapped to the grid before taking the midpoint (option B2):

```text
unit_step = 10,000 × 2^k, the largest ≤ round_half_up(2.5% × ask)   kobo per unit
            (10,000 = ₦100 when 2.5% is below that), so 1.25–2.5% of the list price
g         = unit_step × q
L' = ceil(lower / g) × g      U' = floor(upper / g) × g
L' > U'  → no offer from this listing
price    = the grid point nearest (L' + U') / 2; a tie goes to the buyer (lower price)
```

Only **valid listings** are accepted: `floor ≤ maxFloor(ask) = floor(ask / unit_step) × unit_step`, and `ask ≥ ₦100`. The floor's step then lies wholly at or below the ask (no cut-off top step).

In words: **the floor may not fall inside the partial step just below the ask.** It must be at most the last whole step at or below the ask. The gap between the highest allowed floor and the ask is between 0 and just under one step. When the ask is an exact multiple of the step, the floor may equal the ask.

### Worked example: ask ₦90,000 per unit

| Quantity | Value |
| --- | --- |
| 2.5% of the ask | ₦2,250 |
| `unit_step`: the largest of ₦100, ₦200, ₦400, ₦800, ₦1,600, ₦3,200, … not above ₦2,250 | **₦1,600** (1.78% of the ask) |
| Highest allowed floor, `maxFloor`: 56 × ₦1,600 (90,000 / 1,600 = 56.25) | ₦89,600 |
| What any number of deals can leave about this floor | **at least ₦1,600** of possible floors per unit: a floor of ₦79,000 can be narrowed to its step, (₦78,400, ₦80,000], and no further |
| What one deal at quantity q leaves about a buyer's maximum | at least `g = ₦1,600 × q` |

Under 2.0.0 the same listing had a ₦2,250 step. That held only while the ask stayed ₦90,000.

`MECHANISM = open-arbiter/nash-midpoint-grid 3.0.0` with `grid_bps 250`, `grid_min_unit_cents 10000`, `grid_rule "pow2"`, `tie: "buyer"`. Every offer and receipt carries `unit_step_cents` and `grid_step_cents`.

**History.** 2.0.0 (2026-11-23) used `unit_step = max(₦100, 2.5% × ask)`. The independent review at the Phase 0 gate (R1) showed that this bound held only for a fixed ask. A seller who re-listed at a new ask kept its floor but moved the grid, and deals on both grids intersected to less than one step: 100,000 kobo of possible floors against a 450,000 step in the reviewer's example. Floors in the cut-off top step were a second hole (R2). Such a listing could never trade, and "no deal even at list price" pinned the floor to less than one step. 3.0.0 closes both.

## The bound

`lo = ceil(floor × q / (unit_step × q)) = ceil(floor / unit_step)`. **The outcome depends on the floor only through which `unit_step` cell it is in, `((k−1)·u, k·u]`, and the cells are the same at every quantity.**

**Across list-price changes:** every step is ₦100 × 2^k, so a cell of a larger step is a union of cells of any smaller step. Each observation is a set of possible floors: an agreed price gives one or two adjacent cells, and a no-deal gives every cell above a threshold. With the valid-listing rule, each such set is a union of whole cells of its own grid, and so of the finest grid used, `u_min`. The intersection of all observations contains the true floor's whole `u_min` cell. **So any sequence of deals and no-deals, at any quantities, budgets and list prices, leaves at least `u_min` possible floors**, where `u_min` is the smallest step the listing used while that floor was sealed.

This follows from the code, and the property tests check it:

| Property | Test |
| --- | --- |
| Totals are on the grid and inside `[floor·q, min(max, ask·q)]` | AC-F1-1, 20,000 seeded cases |
| Two floors in the same cell give the same result, q = 1..12 | AC-F1-4, 3,000 cases |
| One agreed price leaves ≥ `unit_step` possible floors, and ≥ `g` possible maxima (or every max ≥ list) | AC-F1-3, 2,000 cases |
| Three deals at q = 1, 2, 3 with independent maxima (prices and no-deals) still leave ≥ `unit_step` possible floors, **also when no deal agreed** | AC-F1-7, 2,000 sequences, plus ask ₦610 where the ₦100 minimum applies |
| Steps of any two asks nest (each is ₦100 × 2^k) | R1, 5,000 pairs |
| Deals across 2–4 list prices (same floor, q 1–3, any budgets) leave ≥ the smallest step used | R1, 2,000 sequences (> 300 with a step change), plus the reviewer's example |
| A floor in the cut-off top step, or an ask under ₦100, is refused by `checkListing` | R1/R2 |
| 20 deals (the deployed daily cap) by an adaptive prober, each budget bisecting the floors still possible, q 1–12, still leave ≥ `unit_step` possible floors; with the bound doubled to 2 steps the same test fails, so the prober is strong | "cap: 20 deals", 400 sellers (`evidence/p1.7b-negative-control.txt`) |

So **any number of deals narrows a floor to no less than one step** (1.25–2.5% of the unit list price, at least ₦100), and across list-price changes to no less than the smallest step used. The buyer's maximum is narrowed only to one `g` per mandate.

## Multi-deal caveat (what the bound does *not* say)

1. **One step is reachable.** The bound is a floor on what is left, not a promise that deals reveal less than that. Enough deals with chosen budgets can pin the floor to its exact cell, one step wide (1.25–2.5% of the list price). The daily cap and the identical-terms lock slow this down, but the bound does not depend on them: it holds for any number of deals, and a prober with many IPs gets no further than one step.
2. **List-price changes cost at most a coarser step.** In 2.0.0 the grid moved with the ask (finding R1). Since 3.0.0 the grids nest, so a change leaves the bound at the smallest step used, never below it. A seller who lowers its list price by enough to halve the step lowers its own bound to that smaller step.
3. **Floor changes are visible.** If a seller moves its floor into another cell, outcomes before and after differ. That reveals that a change happened and which cells were involved, not the exact values.
4. **No-agreement outcomes carry information too.** A no-deal says `ceil(floor/u) > hi`, which is a union of whole cells, so the bound includes it. AC-F1-7 counts no-deals and asserts the bound on every sequence.
5. **Out of scope of this policy:** the arbiter operator sees both limits. The visitor's AI provider sees whatever the visitor types, including a maximum.

## The daily cap (amendment, 2026-11-27)

Until 2026-11-27 each caller (a salted hash of the IP address) could negotiate an item at most 3 times a day, and the docs called this anti-probing. Since mechanism 3.0.0 the nested grid bounds the floor leak to one step **for any number of deals** (the table above), so the cap no longer protects prices: it can only slow a prober down to the same one-step result.

A cap of 3 also locked out real shoppers: on Nigerian mobile networks many people share one public address (carrier-grade NAT), and 3 negotiations a day per item per address would be spent by strangers. The owner's decision:

- **The cap is load protection.** It bounds how much negotiation work (D1 reads and writes, signing) one address can cause per item per day. It is an environment setting, `MANDATES_PER_ITEM_PER_DAY`, 20 by default and in staging and production (`arbiter/wrangler.toml`; `GET /` publishes it).
- **The leak bound is unchanged and does not depend on the cap.** The "cap: 20 deals" property test checks it at the deployed cap with the strongest strategy a buyer has.
- **The identical-terms lock is unchanged:** the same item, quantity, deadline and sellers can be negotiated once per address, so a buyer cannot raise only the budget and re-bid.
- **Distributed abuse** (many addresses) is a load problem, not a price problem. P6.5 evaluates Cloudflare Turnstile on the write endpoints for it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Exact midpoint (1.0.0) | Reveals the floor exactly from one deal |
| B1: midpoint, then round to the grid and clamp | Failed the one-step property in 17 of 1,789 agreements near the domain edge (plan D1) |
| Grid step `g` fixed per total (not per unit) | Cells differ by quantity, so deals at q = 1, 2, 3 intersect to less than a step (plan risk R1). Replaced by A1 |
| 2.0.0: step = 2.5% of the ask | Grids of different asks do not nest (review R1). Replaced by 3.0.0 |
| Lock the step per listing until the floor changes | Keeps 2.5%, but a seller who moves its floor and back gets two grids again; needs a schema change |
| Restate the bound as per-ask | Leaves a hole that a normal repricing opens |
| Random noise | Breaks invariant 2 (deterministic pricing) and makes receipts non-reproducible |
| Hide the price | Defeats the product |

## Future option: fixed-price listings (recorded, not built)

A listing type with **no sealed floor**: it sells at its list price, or at a fixed price the seller publishes, with no negotiation. It reveals nothing beyond the public price, so the leak bound does not apply to it. It would suit:
- sellers who accept no floor leakage at all;
- items under ₦100, which the grid cannot serve;
- sellers who want to sell at, or just under, the list price, where the valid-listing rule refuses a floor inside the partial top step.

Open questions before building it:
- whether the arbiter should still settle these sales, with a signed receipt and the audit chain, or the page should;
- how a fixed-price offer is ranked against negotiated offers in one outcome;
- how anti-probing applies, since there is nothing to probe;
- whether a mandate's maximum is still sealed. It is still compared with the price, so "no deal" says the maximum is below that price.

Needs an owner decision and its own ADR.

## Consequences

- Prices move by up to one step from earlier versions (listed in `evidence/slice5.md` for 2.0.0 and `evidence/gate-review.md` for 3.0.0). A deal whose zone holds no grid point gets no offer, even though the zone is non-empty.
- The step is smaller than 2.0.0's for most asks (1.25–2.5% instead of 2.5%): finer prices, but the leak bound shrinks with it. For example, ₦90,000 → ₦1,600 instead of ₦2,250.
- A floor inside the partial step just under the list price is refused, and so is an ask under ₦100. Such listings could never trade anyway. `upsertListing` refuses them with a message naming the highest allowed floor (`maxFloor`).
- Each side gives up at most one step of surplus to rounding, and ties favour the buyer.
- Receipts issued under 1.0.0 still verify, because each signature covers its own payload, including the mechanism version.
- CLAUDE.md invariant 1 states this bound, and the property tests must keep passing.
