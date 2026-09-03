# Cost, latency and what to do about them

Every number here is measured against the live API, not estimated. Re-measure
with `node scripts/probe.mjs` rather than trusting the page — the upstream moves.

## The formulas

| Tool | Upstream requests |
|---|---|
| `geolink_geocode` | 1, cached 10 minutes |
| `geolink_reverse_geocode` | 1, cached 10 minutes |
| `geolink_search_places` | `ceil((limit + offset) / 20)`, fewer when the area runs out; +1 if `near` is a name |
| `geolink_get_directions` | 1, +1 per endpoint given as a name |
| `geolink_distance_matrix` | **1, whatever the grid size**, +1 per named location |
| `geolink_find_nearest` | 1 matrix + the search, in discovery mode |
| `geolink_sweep_area` | `grid_points × ceil(results_per_point / 20)`, +1 if the area is a name |

The page size is 20. Depth is bought in units of 20, and the engine stops early
the moment the area runs out, so asking for 100 in a place that holds 30 costs
two requests, not five.

## Measured, 2026-09-03, geolink-eg.com

| Request | Results | Upstream requests | Wall clock |
|---|---|---|---|
| default search | 20 | 1 | ~1.2 s |
| deep search | 80 | 4 | ~1.2 s |
| exhaustive search, dense category | 300 | 16 | ~6.9 s |
| the same, before request batching | 300 | 16 | 26.6 s |
| sparse query, ran out early | 16 | 2 | ~0.8 s |

**Latency follows rounds, not results.** Eighty results cost four requests and
return in about the time of one, because the requests run together. This is the
single most useful fact for planning: asking for more is usually close to free in
time, and only linear in calls.

## Response variance

Measured at the **raw page** level, before the engine's correction:

| Cohort | Full page returned | Short page returned |
|---|---|---|
| dense query | 8 / 8 | 0 / 8 |
| sparse query | 6 / 8 | 2 / 8 |

Roughly a quarter of sparse-query pages come back shorter than the source holds,
with a success response and no indication.

Measured **through the API**, where the engine re-reads a page that looks
terminal before accepting it, the same test returns a stable count every time.
That is the correction working, and it is what [probe.mjs](../scripts/probe.mjs) watches: a
non-zero sparse rate at the API surface means the correction regressed.

What the correction cannot protect is a *conclusion* drawn from one sparse call.
See [tripwires.md](tripwires.md) §1.

## Planning rules that follow

- **One center → depth. A region → a sweep.** Past roughly 200 results from a
  single point, a sweep returns more for the same spend, because depth re-reads
  one center while a sweep reads new ground.
- **A matrix replaces a loop.** One `geolink_distance_matrix` call covers every
  origin × destination pair. Building the same grid from directions costs N×M
  requests and answers no better.
- **Sweep wall-clock ≈ (grid_points ÷ concurrency) × per-point time.** Widening
  the grid saves more time than lowering depth, because it removes whole rounds.
- **Quote before spending.** Any sweep over about a minute should be `dry_run`
  first and the estimate given to whoever asked.
- **Coordinates are free, names are not.** Passing a coordinate you already hold
  skips a geocode and removes a class of ambiguity at the same time.

## What the server refuses

Two guards, both env-tunable, both naming the exact fix in the error:

| Guard | Default | Variable |
|---|---|---|
| matrix cells (`origins × destinations`) | 100 | `GEOLINK_MAX_MATRIX_CELLS` |
| sweep API calls | 200 | `GEOLINK_SWEEP_MAX_POINTS` |

Nothing else has a ceiling. `limit` and `results_per_point` take any value; cost
scales linearly and the search stops early on its own.

## Concurrency, and why it is bounded

A sweep runs several grid points at once, and each point that asks for depth
makes its own parallel requests — the two multiply. The upstream reaches its
source from a single address with no proxy rotation, and a wide simultaneous
burst of near-identical requests is the pattern most likely to be throttled.

Points in flight are therefore divided down as `results_per_point` rises, holding
the product within a fixed budget. At default depth nothing changes: one request
per point, four points at a time. At `results_per_point: 60` the server runs two
points at a time instead of four, and says so in `plan.concurrency`.
