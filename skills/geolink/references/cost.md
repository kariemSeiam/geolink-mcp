# Cost, latency and what to do about them

Every number here is measured against the live API, not estimated. Re-measure
with `node scripts/probe.mjs` rather than trusting the page — the upstream moves.

## The formulas

| Tool | Upstream requests |
|---|---|
| `geolink_geocode` | 1, cached 10 minutes |
| `geolink_reverse_geocode` | 1, cached 10 minutes |
| `geolink_search_places` | **1**, whatever the depth — a name in `near` costs nothing extra |
| `geolink_get_directions` | 1, +1 per endpoint given as a name |
| `geolink_distance_matrix` | **1, whatever the grid size**, +1 per named location |
| `geolink_find_nearest` | **1** in search mode; 1 matrix + geocodes when you pass a list |
| `geolink_sweep_area` | **1 per call**; `dry_run` says how many calls the whole area needs |

Three of those became 1 when the paging, the grid and the road-ranking moved
server-side. What used to cost this client sixteen requests for a deep search is
now one request that the API pages behind. The cost did not disappear — it moved
to where it can be measured against a time budget instead of a call count.

`dry_run` on a sweep is the only place a caller still needs to plan: it reports
`requests_needed` and `estimated_seconds`, and `fits_in_one_request: false`
means the answer will arrive in pieces joined by `continue_from`.

**Paging is free.** Whole search and sweep answers are cached, so `offset` is
served from the answer already in hand. A second page never costs a second
sweep.

## Measured, 2026-09-03, against `geolink-eg.com`

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

That is the only request this server refuses on size, and the error names the
parameter change that would succeed. `limit`, `pages_per_point` and the area of
a sweep have no client-side ceiling.

## What bounds a sweep now

Not a call count — a time budget, enforced by the API. That is a better bound
because it is the thing that actually runs out, and because a request that hits
it can hand back `continue_from` and be resumed, where a refused request could
only be re-planned.

It also means **a large area does not fail, it arrives in pieces**. Check
`area_fully_swept`; if it is `false`, you have part of the ground and a token for
the rest. A caller that ignores the field gets a plausible partial answer with
nothing marking it as partial.

The concurrency budget that used to live in this client is gone with the grid it
was protecting. The upstream reaches its source from one address without proxy
rotation, and pacing that burst is now the engine's problem, decided next to the
measurements it depends on rather than three layers away from them.
