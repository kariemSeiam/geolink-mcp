/**
 * The playbook: how to reason with these tools, served over the protocol so
 * it reaches any client — an IDE agent, a chat model, a harness with no
 * filesystem — without anyone having to install a file.
 *
 * Written for a reader who has the tool list and still has to decide what to
 * do with it. Every number here is either derived from the code or measured
 * against the live upstream; measurements carry their date.
 */

import { DEEP_SEARCH_ADVISORY, UPSTREAM_PAGE_SIZE } from "./constants.js";

/** Measured 2026-09-03 against geolink-eg.com from a single client. */
export const MEASUREMENTS = {
  measured_on: "2026-09-03",
  upstream: "geolink-eg.com",
  note: "Observed from one client on one network. Treat as the shape of the cost curve, not a service guarantee.",
  search: [
    { results: 20, upstream_requests: 1, seconds: 1.2, note: "one page, the default" },
    { results: 80, upstream_requests: 4, seconds: 1.2, note: "requests run in parallel, so latency barely moves" },
    { results: 300, upstream_requests: 16, seconds: 6.9, note: "dense category, ran to exhaustion" },
    { results: 16, upstream_requests: 2, seconds: 0.8, note: "sparse query — stopped early because the area ran out" },
  ],
  reliability: {
    partial_page_rate_sparse: 0.25,
    partial_page_rate_dense: 0.0,
    detail:
      "On sparse queries the source sometimes answers the identical request with a shorter list — 8 identical calls returned 14 results six times and 4 twice. Dense pages returned the full page 8/8. The server re-reads a page that looks like the end before believing it, so this is handled, but it is why a single sparse result set should not be treated as proof that nothing else exists.",
  },
} as const;

export const PLAYBOOK_INDEX = `# GeoLink playbook

Location tools answer three different kinds of question, and most wrong answers
come from using the tool for one kind to answer another.

| The question | The shape | Tool |
|---|---|---|
| "Where is this?" | one name → one point | \`geolink_geocode\` |
| "What is at this point?" | one point → one description | \`geolink_reverse_geocode\` |
| "What is near here?" | one center → a ranked list | \`geolink_search_places\` |
| "What is in this whole area?" | a region → every match | \`geolink_sweep_area\` |
| "How do I get from A to B?" | two points → routes | \`geolink_get_directions\` |
| "How far is everything from everything?" | N × M → a grid | \`geolink_distance_matrix\` |
| "Which of these actually serves this customer?" | one origin, many options → a ranking | \`geolink_find_nearest\` |

## The one distinction that matters most

**Depth is not coverage.**

\`geolink_search_places\` with a large \`limit\` reads *the same center* more
deeply. \`geolink_sweep_area\` reads *new ground*. A search from Tahrir Square
with \`limit=300\` will never find a pharmacy in Giza no matter how large the
number gets, because the source ranks outward from one point and runs out.

- Asking about a neighbourhood, a landmark, "near me" → depth.
- Asking about a district, a city, a governorate, "all of" → a sweep.

Get this backwards and the answer is confidently incomplete, which is worse
than an error, because nothing about the response looks wrong.

## Knowing when you are done

Two fields exist so that "there is nothing more" is something you are told
rather than something you assume:

- \`source_exhausted: true\` on a search — the source returned fewer places
  than were asked for. Nothing more exists for that query and that center.
- \`source_exhausted: false\` — the depth you asked for was filled. More may
  exist. Raise \`limit\`, or switch to a sweep if the question was regional.

A sweep reports \`stats.unique_results\` against \`stats.raw_results\`: the gap
between them is what de-duplication removed, and it is the fastest signal that
tiles are overlapping the way they should.

## Cost, in one line each

| Tool | Upstream requests |
|---|---|
| \`geolink_geocode\`, \`geolink_reverse_geocode\` | 1, cached 10 min |
| \`geolink_search_places\` | \`ceil((limit + offset) / ${UPSTREAM_PAGE_SIZE})\`, fewer if the area runs out |
| \`geolink_get_directions\` | 1 (+1 per endpoint given as a name) |
| \`geolink_distance_matrix\` | 1, whatever the grid size (+1 per named location) |
| \`geolink_find_nearest\` | 1 matrix + the search, in discovery mode |
| \`geolink_sweep_area\` | \`grid_points × ceil(results_per_point / ${UPSTREAM_PAGE_SIZE})\` |

Names cost a geocode; coordinates cost nothing. Passing coordinates you already
have is the cheapest optimisation available, and repeated names inside one
session are cached anyway.

Read \`geolink://scale\` for measured latency and the reliability model,
\`geolink://playbook/coverage\` for how to cover an area without leaving holes,
and \`geolink://playbook/recipes\` for compositions that answer questions no
single tool answers.
`;

export const PLAYBOOK_COVERAGE = `# Covering an area without leaving holes

A sweep lays a grid over a bounding box and runs one search per cell. Whether
the result is *complete* depends on three things, and all three are inspectable
from what the tool returns.

## 1. Spacing has to be smaller than the reach of each search

Each grid point searches outward from itself. The worst-served location in a
grid is the corner of a cell, which sits \`spacing × 0.71\` away from the
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
\`results_per_point\` places, that point did not run out — it hit the number
you gave it. Everything past that number in that cell is invisible, and the
sweep will still look successful.

**The test:** compare \`stats.raw_results\` against
\`plan.grid_points × plan.results_per_point\`. As that ratio approaches 1, the
grid is saturated and the count is a floor, not a total.

**The fix,** in order of preference:
1. Raise \`results_per_point\` and re-run \`dry_run\` to see the new cost.
2. Halve \`grid_spacing_km\` — more cells, each with less to hold.
3. Sweep the dense districts separately at tighter spacing, and the rest coarsely.

Option 3 is usually right for a city: one sweep at uniform spacing spends most
of its calls on empty ground and still saturates downtown.

## 3. The edges have to actually be inside the box

A named area gets its bounds from the geocoder's viewport, which is often
tighter than the administrative boundary — a district's viewport can exclude
the streets on its far edge.

**The test:** reverse-geocode the four corners and the centre of
\`area.bounds\`. If a corner comes back with a district that never appears in
\`stats.by_district\`, the grid stopped short of ground that belongs to the area.

**The fix:** \`padding_km\` of 1–3 for a district, 3–5 for a city. Padding
costs cells, so pad and re-run \`dry_run\` before running for real.

## Reading the statistics like an inspector

- \`raw_results\` ÷ \`unique_results\` near 1.0 — tiles are not overlapping.
  Neighbouring cells should both see the places between them; when they never
  do, the spacing is wider than the reach and there is ground between the
  points that neither one covered.
- The same ratio above ~3 — heavy overlap. Coverage is safe but calls are being
  spent re-reading the same places. Widen the spacing.
- \`points_failed\` above zero — some cells returned nothing due to a transient
  error, and those cells are simply missing from the result. \`failed_details\`
  names them; re-run the sweep over just that sub-area rather than repeating
  the whole grid.
- A district in \`by_district\` with a count of 1–2 in a region where
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
`;

export const PLAYBOOK_RECIPES = `# Compositions

Each of these answers a question no single tool answers, using only what is
already here.

## Reachable area — approximate isochrone

*"Where can a driver get to in 20 minutes?"*

1. Take bearings every 30° around the origin at a few trial radii
   (2, 5, 10 km) and turn each into a coordinate.
2. \`geolink_distance_matrix\` with the origin against all of them — one call,
   whatever the count, as long as it stays inside the cell limit.
3. Keep the points whose \`duration_seconds\` is at or under the budget. Their
   outline is the reachable shape, and it is rarely a circle: a river or a
   single bridge distorts it heavily, which is the entire point of computing it
   instead of drawing a radius.

## Territory assignment

*"Which branch should own which customer?"*

\`geolink_distance_matrix\` with customers as origins and branches as
destinations, \`nearest_only: true\`. One call returns the assignment. Grouping
the result by \`address_parts.district\` turns it into a territory map without
another request.

Watch for customers whose nearest branch by road is not the nearest by straight
line — those are the accounts a human would have assigned wrong.

## Underserved ground — site selection

*"Where should the next branch go?"*

1. Sweep the category you compete with across the region.
2. Sweep a demand proxy across the same region with identical bounds and
   spacing — schools, mosques, markets, whatever generates footfall for the
   business.
3. Compare \`stats.by_district\` between the two. A district high in demand and
   low in supply is a candidate.
4. Confirm with \`geolink_find_nearest\` from the candidate district's centre:
   if the closest existing competitor is a long drive, the gap is real.

## What is on the way

*"Is there a pharmacy on my route?"*

1. \`geolink_get_directions\` with \`route_detail: "waypoints"\` and a modest
   \`max_waypoints\`.
2. Sample the path every few kilometres.
3. \`geolink_search_places\` at each sample with a small \`limit\`.
4. Confirm the candidates with \`geolink_distance_matrix\` from the origin —
   a place 200 m from the line can still be a ten-minute detour.

## Confidence in a single address

*"Did the geocoder understand me?"*

\`geolink_geocode\` always returns one answer, and one answer never looks
uncertain. To test it:

- Reverse-geocode the coordinates it returned. If the district that comes back
  disagrees with the district in the original result, the match is weak.
- Run \`geolink_search_places\` with the same string. If the top candidates are
  scattered across kilometres, the name is ambiguous and the right move is to
  ask which one was meant rather than to pick.
- Compare the geocoded point against the bounds it came with. A point sitting
  at the very edge of its own viewport is usually a fallback to something
  larger — a city centroid standing in for a street it did not find.

## Delivery reality check

*"Is this address deliverable?"*

Reverse-geocode the coordinates the customer gave, then compare the returned
district with the one they typed. Mismatches are the addresses that fail on the
road. Ordering a day's stops by \`geolink_distance_matrix\` between them turns
the same data into a route order.

---

## Not available here

These are outside what this server can do today. An agent should say so plainly
rather than approximate them:

- Building-level footprints or floor detail.
- Imagery, elevation, or anything visual.
- Opening hours, phone numbers, ratings, or category tags.
- Live traffic. Durations reflect the source's own model at request time.
- Anything historical. Every call is a fresh read; there are no snapshots.

Enriching a result with information from outside this server — a web search
for a place's phone number, for instance — is a reasonable thing for an agent
to do, but the boundary should stay visible in the answer: what came from the
map, and what came from elsewhere.
`;
