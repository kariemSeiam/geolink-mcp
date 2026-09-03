# Covering an area without leaving holes

A sweep lays a grid over a bounding box and runs one search per cell. Whether
the result is *complete* depends on three things, and all three are inspectable
from what the tool returns.

## 1. Spacing has to be smaller than the reach of each search

Each grid point searches outward from itself. The worst-served location in a
grid is the corner of a cell, which sits `spacing × 0.71` away from the
nearest query point. If the source's useful reach around a point is shorter
than that, corners fall through the grid.

| Spacing | Worst-case distance to the nearest query point |
|---|---|
| 2 km | 1.4 km |
| 3 km | 2.1 km |
| 5 km | 3.5 km |
| 7 km | 5.0 km |

Dense categories in a city — pharmacies, cafés, ATMs — have short reach because
the nearest twenty results are all within a few hundred metres. Use 2–3 km.
Sparse categories — hospitals, universities, factories — reach much further,
so 5–7 km costs less and misses nothing.

## 2. A saturated cell is an under-reported cell

This is the failure that hides. If a grid point returns exactly
`results_per_point` places, that point did not run out — it hit the number
you gave it. Everything past that number in that cell is invisible, and the
sweep will still look successful.

**The test:** compare `stats.raw_results` against
`plan.grid_points × plan.results_per_point`. As that ratio approaches 1, the
grid is saturated and the count is a floor, not a total.

**The fix,** in order of preference:

1. Raise `results_per_point` and re-run `dry_run` to see the new cost.
1. Halve `grid_spacing_km` — more cells, each with less to hold.
1. Sweep the dense districts separately at tighter spacing, and the rest coarsely.

Option 3 is usually right for a city: one sweep at uniform spacing spends most
of its calls on empty ground and still saturates downtown.

## 3. The edges have to actually be inside the box

A named area gets its bounds from the geocoder's viewport, which is often
tighter than the administrative boundary — a district's viewport can exclude
the streets on its far edge.

**The test:** reverse-geocode the four corners and the centre of
`area.bounds`. If a corner comes back with a district that never appears in
`stats.by_district`, the grid stopped short of ground that belongs to the area.

**The fix:** `padding_km` of 1–3 for a district, 3–5 for a city. Padding
costs cells, so pad and re-run `dry_run` before running for real.

## Reading the statistics like an inspector

- `raw_results` ÷ `unique_results` near 1.0 — tiles are not overlapping.
  Neighbouring cells should both see the places between them; when they never
  do, the spacing is wider than the reach and there is ground between the
  points that neither one covered.
- The same ratio above ~3 — heavy overlap. Coverage is safe but calls are being
  spent re-reading the same places. Widen the spacing.
- `points_failed` above zero — some cells returned nothing due to a transient
  error, and those cells are simply missing from the result. `failed_details`
  names them; re-run the sweep over just that sub-area rather than repeating
  the whole grid.
- A district in `by_district` with a count of 1–2 in a region where
  neighbouring districts have dozens — either genuinely sparse, or one grid
  point landed in it and saturated. Check its area before believing the number.

## Sparse queries need a second look

The source occasionally answers a sparse query with a shorter list than it
holds — measured at about one call in four for rare names, never observed on
dense ones. The server already re-reads a page that looks like the end before
accepting it, so a single tool call is protected.

What is *not* protected is a conclusion drawn from one narrow query. "There are
no pharmacies in this village" deserves a second query with a different phrasing
or the other language before it becomes an answer. Arabic and English indexes
do not contain identical sets.
