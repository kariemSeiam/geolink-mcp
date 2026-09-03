/* eslint-disable */
/**
 * GENERATED FILE - do not edit.
 *
 * Source of truth: skills/geolink/. Regenerate with `npm run build`
 * (or `node scripts/build-playbook.mjs`). Editing here is lost on the next
 * build and, worse, silently diverges the protocol copy from the file copy.
 */

export const SKILL_OVERVIEW = `# GeoLink — from a map question to an answer you can defend

Seven tools return places, addresses, routes and travel times. Getting a result
from them is easy. Getting a result that is *complete*, and knowing whether it
is, is the part that needs a method — because on this data a wrong answer and a
right answer are the same JSON. Nothing fails loudly.

**This skill exists because the obvious path produced confident wrong answers.**
A search that stopped at six results was read for months as "six is what exists";
it had never been asked for more, and the real number was three hundred. A tool
advertised a limit it could not reach and a pagination cursor that led nowhere. A
determinism measurement taken on a dense query was generalised to all queries and
used to reject a correct hypothesis. Each gate below exists because one of those
shipped.

## Run the gates in order, and do not reorder them

The order matters. Most errors here come from choosing a method before
establishing what kind of question was asked, then defending the method instead
of changing it.

| # | Gate | Output | Blocks on |
|---|---|---|---|
| 1 | **Shape** — one point or an area, and how wrong may it be? | the question classified + a stated tolerance | a regional question answered with one search |
| 2 | **Anchor** — resolve every place name to coordinates, and check them | verified centers | a geocode nobody tested |
| 3 | **Budget** — what will this cost in calls and seconds? | a quoted plan | an unquoted sweep |
| 4 | **Retrieve** — search, sweep, route, or matrix | raw results + their stats | — |
| 5 | **Completeness** — is this everything, or everything you asked for? | a saturation and edge verdict | a total reported as a total when it is a floor |
| 6 | **Tripwires** — run all eleven | pass/fix list | any tripwire |
| 7 | **Answer** — with its confidence and what it excludes | the deliverable | — |

Gate 5 and Gate 6 are not formalities. They are where every error listed above
was eventually caught.

## Gate 1 — Shape

One distinction decides everything downstream:

> **Depth reads one center more deeply. A sweep reads new ground.**

\`geolink_search_places\` with \`limit=300\` from Tahrir Square will never find a
pharmacy in Giza, however large the number gets. The source ranks outward from
one point and runs out. Raising the limit buys more of the same neighbourhood.

- "near me", a landmark, a street, a single neighbourhood → **depth**.
- "in Giza", "across the city", "all of", "how many are there" → **sweep**.

Getting this backwards produces an answer that is complete-looking and wrong,
which is worse than an error, because nothing about the response looks off.

Then ask the question nothing downstream can infer: **how wrong is this allowed
to be?** A count for a slide that tolerates ±20% and a count for a filing that
tolerates almost nothing take different spacing, different depth and different
money. Without a stated tolerance, every later gate decides "is this enough" on
taste, and Gate 5's "at least N" is neither acceptable nor a failure because
there is nothing to compare it against.

## Gate 2 — Anchor

Every name costs a geocode, and every geocode returns exactly one answer with no
indication of how confident it is. A wrong anchor makes every later gate produce
a well-verified answer about the wrong place.

Pass coordinates instead of names wherever they are already known — cheapest
optimisation available, and it removes this doubt entirely. Where a name must be
resolved, [recipes.md](references/recipes.md) has the confidence check, and
[tripwires.md](references/tripwires.md) §7 covers using a geocoded area as a
sweep boundary. A viewport is not a border.

## Gate 3 — Budget

For anything regional, run \`geolink_sweep_area\` with \`dry_run: true\` first. It
returns the exact call count without spending any of it. Quote that number
before spending it — a governorate at tight spacing is minutes of wall-clock and
hundreds of calls, and nobody wants to learn that afterwards.

[cost.md](references/cost.md) carries every formula and the measured latency
behind it. The one worth holding in mind: latency follows rounds, not results,
so depth is close to free in time and only linear in calls.

## Gate 4 — Retrieve

Pick by shape, not by habit:

| Question | Tool |
|---|---|
| Where is this name? | \`geolink_geocode\` |
| What is at this point? | \`geolink_reverse_geocode\` |
| What is near this point? | \`geolink_search_places\` |
| What is in this whole area? | \`geolink_sweep_area\` |
| How do I get from A to B? | \`geolink_get_directions\` |
| Times between many and many? | \`geolink_distance_matrix\` |
| Which of these serves this customer? | \`geolink_find_nearest\` |

One \`geolink_distance_matrix\` call replaces N×M direction calls and costs a
single request. Looping directions to build a grid is the most expensive
mistake available here.

## Gate 5 — Completeness

This is the gate that separates a number from a defensible number, and most of
it is now computed for you.

A sweep returns a \`completeness\` block: \`saturated_points\` (counted per point,
never averaged — an average hides five saturated downtown cells behind 195 empty
rural ones), \`overlap_ratio\`, a \`verdict\` of \`bounded\`, \`floor\` or
\`gaps_likely\`, and \`notes\` naming the parameter change for each problem found.
A \`floor\` verdict means report "at least N", not "N".

One test it cannot run for you is the edges, because nothing inside a sweep can
see what the bounds left out: reverse-geocode the corners and centre of
\`area.bounds\` and look for a district missing from \`stats.by_district\`.
[coverage.md](references/coverage.md) has the arithmetic and what each number
means.

A search has a simpler test: \`source_exhausted\`. When \`true\`, the area has no
more. When \`false\`, you stopped asking first — say so rather than implying you
found everything.

## Gate 6 — Tripwires

Run every tripwire in [tripwires.md](references/tripwires.md). Eleven failure modes,
each with what happened, the check, and what passing looks like.

Do not summarise them from memory — open the file. Recalling "something about
duplicates" is what let §2 through the first time; the check is specific and the
specificity is the whole value.

## Gate 7 — Answer

This gate does not certify a count. It attests to a method over a stated scope:
here is what was covered, how, when, and where it falls short. That framing is
why an exception is a normal part of a passing answer rather than an admission —
what damages trust is a caveat that was found later by someone else.

State the number, then state what it excludes. Three sentences that make a map
answer trustworthy:

- What was covered: the area, the spacing, the depth.
- What it cost: calls and time, if anyone will run it again.
- What it misses: saturation, unswept edges, or a category the query wording
  would not have matched.

For a count that failed a completeness test, "at least 340 pharmacies, and the
downtown cells were saturated so the real number is higher" is a better answer
than 340. It is also the answer that survives someone checking.

## Keeping this skill honest

\`\`\`bash
node scripts/probe.mjs           # regenerates every measured number below
\`\`\`

Every figure in these references — page size, the partial-response rate, the
latency curve — is measured against the live API, not assumed. The upstream
changes. **Run the probe rather than trusting a number written in a file**; it
prints what it observed today alongside what was recorded, and flags anything
that has drifted.

When a gate catches something new, add a tripwire. When a coverage claim ships,
add a ledger row with the count and how it was verified. A static version of this
skill would be wrong within a quarter.

## Size budget

| File | Budget | When it is hit |
|---|---|---|
| \`SKILL.md\` | 220 lines | move the longest gate's detail into a reference file and leave the gate pointing at it |
| each reference | 250 lines | split by failure mode or by tool, never by adding a second topic to an existing file |
| \`ledger/\` rows | no limit | append-only; a row is never edited after its verdict is written |

This file is loaded whenever a map question is asked, so its length is a cost
paid on every one of them. Detail belongs in the references, which are loaded
only when a gate points at them by name.

The budget was 200 and was raised once, after gates 1, 5 and 7 gained content
that belonged in them. Gates 2 and 3 were emptied into the references first —
raising the number is the last move, not the first, and it is recorded here
rather than done quietly, because a budget that moves without a note is not a
budget.

## Files

| Path | What it holds |
|---|---|
| [references/tripwires.md](references/tripwires.md) | the 10 failure modes + the check for each |
| [references/coverage.md](references/coverage.md) | covering an area without leaving holes: spacing maths, the three tests |
| [references/cost.md](references/cost.md) | cost formulas, measured latency, planning rules |
| [references/recipes.md](references/recipes.md) | compositions: reachability, territory, service gaps, on-the-way |
| [scripts/probe.mjs](scripts/probe.mjs) | re-measures every number in these files against the live API |
| [ledger/](ledger/) | coverage claims made, and how each was verified |

The same content is served by the MCP server itself as resources —
\`geolink://playbook\`, \`geolink://playbook/coverage\`, \`geolink://playbook/recipes\`,
\`geolink://scale\` — generated from these files, so a client with no filesystem
reads exactly what is written here.
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
1. Halve \`grid_spacing_km\` — more cells, each with less to hold.
1. Sweep the dense districts separately at tighter spacing, and the rest coarsely.

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

### "Where can a driver get to in 20 minutes?"

1. Take bearings every 30° around the origin at a few trial radii
   (2, 5, 10 km) and turn each into a coordinate.
1. \`geolink_distance_matrix\` with the origin against all of them — one call,
   whatever the count, as long as it stays inside the cell limit.
1. Keep the points whose \`duration_seconds\` is at or under the budget. Their
   outline is the reachable shape, and it is rarely a circle: a river or a
   single bridge distorts it heavily, which is the entire point of computing it
   instead of drawing a radius.

## Territory assignment

### "Which branch should own which customer?"

\`geolink_distance_matrix\` with customers as origins and branches as
destinations, \`nearest_only: true\`. One call returns the assignment. Grouping
the result by \`address_parts.district\` turns it into a territory map without
another request.

Watch for customers whose nearest branch by road is not the nearest by straight
line — those are the accounts a human would have assigned wrong.

## Underserved ground — site selection

### "Where should the next branch go?"

1. Sweep the category you compete with across the region.
1. Sweep a demand proxy across the same region with identical bounds and
   spacing — schools, mosques, markets, whatever generates footfall for the
   business.
1. Compare \`stats.by_district\` between the two. A district high in demand and
   low in supply is a candidate.
1. Confirm with \`geolink_find_nearest\` from the candidate district's centre:
   if the closest existing competitor is a long drive, the gap is real.

## What is on the way

### "Is there a pharmacy on my route?"

1. \`geolink_get_directions\` with \`route_detail: "waypoints"\` and a modest
   \`max_waypoints\`.
1. Sample the path every few kilometres.
1. \`geolink_search_places\` at each sample with a small \`limit\`.
1. Confirm the candidates with \`geolink_distance_matrix\` from the origin —
   a place 200 m from the line can still be a ten-minute detour.

## Confidence in a single address

### "Did the geocoder understand me?"

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

### "Is this address deliverable?"

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

export const PLAYBOOK_TRIPWIRES = `# Tripwires — the eleven ways map work returns a confident wrong answer

Every one of these was hit for real against this API, most of them in a single
week of building on it. None are exotic. They are the normal failure modes of
scraped map data, which is why they need a checklist rather than care.

The common shape: **the response looks successful.** There is no error, no
warning, no empty field. A wrong coverage number and a right one are the same
JSON. That is what makes a checklist necessary — nothing here announces itself.

Run all eleven at the verification gate. Open this file; do not recall it from memory.

---

## 1. The partial page — the one that makes "nothing exists" wrong

**What happened.** The same request, sent eight times, returned 14 results six
times and 4 results twice. No error, no difference in the response envelope,
success both times. On a dense query the same test returned the full page 8/8.

**Why here.** The engine reads a source that occasionally answers with a shorter
list than it holds. It shows up on sparse queries — rare names, small towns —
and effectively never on dense ones.

**The check.** The server re-reads a page that looks like the end before
accepting it, so one tool call is protected. What is not protected is a
*conclusion*: "there are no pharmacies in this village" from a single narrow
query. Ask again with different phrasing or the other language before it becomes
an answer. Arabic and English indexes do not hold the same sets.

**Passes when:** any negative finding — zero results, or a suspiciously small
count — has been reproduced by a second query that differs in wording or language.

---

## 2. Name-matching lies about duplicates

**What happened.** Two result batches were compared by place name to check for
overlap: two names matched, suggesting the batches overlapped. Compared by
coordinates instead, the overlap was **zero**. The matching names were
\`الصيدلية\` — "the pharmacy" — which is what a small unnamed pharmacy is called
everywhere in the country.

**Why here.** Generic names are the norm in this data, not the exception. Any
category with unbranded operators — pharmacies, cafés, groceries, workshops —
produces dozens of genuinely distinct places sharing one string.

**The check.** Identity is coordinates. Compare, de-duplicate, and count on
\`location\`, rounded to about 4 decimal places (~11 m). Use names for display
only. When name-based de-duplication is wanted, it must be paired with a
distance threshold — which is exactly why \`dedupe_meters\` exists and why setting
it too high silently merges distinct places.

**Passes when:** every count, overlap or de-duplication in the analysis is
computed from coordinates, and any name-based grouping states its distance bound.

---

## 3. Generalising a measurement past its cohort

**What happened.** Determinism was measured on a dense query: three independent
sessions, fresh session keys, identical results every time. The conclusion
written down was "the source is deterministic; session keys and user agents have
no effect on content." That conclusion was then used to **reject a correct
hypothesis** from someone who suspected repeated requests could return different
data. On sparse queries, they can — see tripwire 1.

**Why here.** This dataset behaves differently at different densities. A finding
from a downtown category query does not transfer to a rural one, and vice versa.

**The check.** Every measured claim carries the cohort it came from: dense or
sparse, urban or rural, which language, how many samples. A claim without a
cohort is a claim about one query.

**Passes when:** each stated number names its sample and its conditions, and no
finding from one density is used to rule out behaviour at another.

---

## 4. Twyman's Law — a surprising number is a measurement, not a discovery

> Any figure that looks interesting or different is usually wrong.

**What happened.** The search engine stopped after collecting six results. Every
consumer built on top of it — the API, the MCP server, its tools — treated six
as what existed. It was a parameter: an internal "keep paging until you have at
least six" floor, never a limit on the data. Asking for more returned 300.

**Why here.** Scraped sources have internal pagination knobs that leak outward as
apparent scarcity, and the ask is usually invisible. The law cuts both ways, and
the upward direction is easier to miss because a large number feels like success:
a surprisingly *high* unique count usually means \`dedupe_meters\` was set too low
or coordinate rounding stopped merging genuine duplicates, not that the district
is unusually rich.

**Point it at your own instrument too.** The knob that produces a wrong number is
as often on this side as on the source's. \`GEOLINK_SWEEP_MAX_POINTS\` defaults to
200; an agent that hits it and reports "this area is too large to sweep" has just
reproduced this exact failure using our own parameter instead of the upstream's.
The area is not too large. The budget is 200 and it is tunable.

**The check.** Any count that is round, suspiciously stable across different
queries, or larger than the ground plausibly holds, gets traced to the parameter
that produced it before it gets reported. Ask which knob could have manufactured
this number — upstream, in the server, or in the analysis — and rule it out.

**Passes when:** a surprising number in either direction has been re-run with the
relevant parameter deliberately changed, and it survived.

---

## 5. A published limit nobody verified end to end

**What happened.** The search tool advertised \`limit: 1-100\` and returned an
\`offset\` to page with. The upstream returned one page. \`limit=100\` was
unreachable, and any \`offset\` past the first page returned nothing, forever —
while the response still reported \`has_more: true\` and pointed at a
\`next_offset\` that led nowhere.

**Why here.** A wrapper's schema is written from intent; the upstream enforces
reality. Nothing reconciles them unless somebody calls the boundary.

**The check.** Every advertised maximum must have been called at its maximum
against the real upstream at least once. A limit that has only been type-checked
has not been tested.

**Passes when:** the largest value each parameter accepts has a live call behind
it, and pagination has been followed to its end.

---

## 6. The saturated cell — coverage that reports a floor as a total

**What happened.** A sweep tiles an area and searches each cell. A cell that
returns exactly the number of results it was allowed to return did not run out
of places — it ran out of permission. Everything past that number in that cell is
invisible, and the sweep still reports a total that looks authoritative.

**Why here.** Density is never uniform. One downtown cell can hold more matches
than an entire rural quadrant of the same grid.

**The check.** Compare \`stats.raw_results\` against
\`plan.grid_points × plan.results_per_point\`. As that ratio approaches 1, the grid
is saturated and the number is a lower bound. Raise \`results_per_point\`, tighten
spacing, or sweep the dense districts separately.

**Passes when:** the saturation ratio is computed and stated, and any total near
saturation is reported as "at least N", never as "N".

---

## 7. The viewport is not the boundary

**What happened.** A named area's bounds come from the geocoder's viewport, which
is a display rectangle, not an administrative border. It is frequently tighter
than the real area — a district's viewport can exclude the streets along its own
edge — and occasionally far looser, when a small place falls back to its parent
city's box.

**Why here.** The source returns what a map would show, not what a boundary file
would define. There is no boundary geometry in this API at all.

**The check.** Reverse-geocode the four corners and the centre of the bounds you
were given. A corner returning a district that never appears in your results is
ground the grid stopped short of. A corner returning a *different city* means the
viewport is far too loose and the area needs \`{center, radius_km}\` instead.

**Passes when:** the corners have been probed, and any correction is applied with
\`padding_km\` before the real run, not after.

---

## 8. Straight-line thinking in a city with a river

**What happened.** The nearest branch by straight line and the nearest by road
are routinely different places here, and the gap is not small. A river with a
limited number of bridges makes a facility 800 m away a fifteen-minute drive.

**Why here.** Cairo, Giza and every delta city are cut by water and one-way
systems. Straight-line ranking is not an approximation of road ranking; on these
geographies it is a different answer.

**The check.** Rank with \`geolink_find_nearest\` or a distance matrix, never with
haversine. When both are available, compute the detour ratio —
\`distance_meters ÷ (straight_line_km × 1000)\`. Anything above about 2.5 deserves
a sentence in the answer, because it usually means a bridge, and a human reading
"800 m away" would otherwise assume walking distance.

**Passes when:** every "nearest" claim rests on travel time, and any large detour
ratio is surfaced rather than smoothed over.

---

## 9. Concurrency that keeps the index and loses the order

**What happened.** The distance matrix ran one request per origin-destination
pair in a thread pool and collected them with \`as_completed\`, which yields
futures as they finish rather than as they were submitted. The pair index was
recovered correctly from the future and then discarded: each result was appended
to its row, so every destination's travel time landed in whichever column its
request happened to return in. Meanwhile the destination list echoed back to the
caller was built by walking the destinations that were sent, so it was always in
the right order. The two halves of the response disagreed, and
\`nearest_destination_index\` pointed into the scrambled half — so "which of these
is closest" returned a real place chosen at random.

**Why here.** Nothing about the response looked wrong. It was well-formed, fully
populated, internally plausible, and every number in it was a genuine
measurement of something — just of the wrong pair. It only appears with more
than one destination, so every single-destination test passed.

**The check.** Assert a physical invariant on results that claim to be
distances: a road route cannot be shorter than the straight line between its own
endpoints. It costs nothing, it is not a heuristic, and it is what surfaced this
— one destination measured 5184 m alone and 2759 m inside a four-destination
call. Where a result can be obtained two ways, obtain it both ways once and
compare; agreement between an isolated call and a batched one is the cheapest
proof that a batch preserves identity.

**Passes when:** every distance in a batched result is at least the straight-line
distance for its own pair, and a spot-checked entry matches the same query made
alone.

## 10. A cache keyed on less than the request

**What happened.** Twice, in two different codebases, the same bug: a search
cache keyed on query, location and language — but not on how many results were
asked for. A shallow answer was then served to a request that asked for far
more, and the caller received 20 results for a request for 100 with nothing
indicating a cache hit.

**Why here.** Depth was added to an interface that already had caching. The key
was written before depth existed and nothing forces it to be revisited.

**The check.** Every parameter that changes the response must appear in the cache
key. When adding a parameter to a cached call, the key is part of the change, not
a follow-up.

**Passes when:** the key contains every argument the response depends on, and a
same-query-different-depth pair has been tested for correct behaviour.

---

## 11. Silence read as completion

**What happened.** A crawl stopped when a page contributed nothing new, treating
that as "the source is exhausted". Combined with tripwire 1, a transient short
page that happened to repeat earlier results ended the crawl early, and the
result set was truncated with no signal to the caller — it looked identical to a
complete one.

**Why here.** "Nothing new" and "nothing left" are the same observation from
inside a single request. They can only be distinguished by asking twice.

**The check.** A terminal signal is confirmed before it is believed. The engine
now re-reads a page that looks like the end; any analysis layered on top should
apply the same principle to its own stopping rules — a district with zero results
gets a second look before it is reported as empty.

**Passes when:** no conclusion rests on a single observation of absence.

---

## Quick audit

\`\`\`bash
# saturation: is the sweep's total a floor rather than a total?
#   ratio = stats.raw_results / (plan.grid_points * plan.results_per_point)
#   ratio -> 1.0 means saturated

# overlap health: are neighbouring tiles seeing each other's places?
#   ratio = stats.raw_results / stats.unique_results
#   ~1.0 = tiles never overlap -> ground between them was covered by neither
#   >3.0 = heavy overlap -> coverage safe, calls wasted

# regenerate every measured number in these files against the live API
node scripts/probe.mjs
\`\`\`

Machine checks catch saturation and overlap. They do not catch tripwires 3, 5, 7
or 8 — those need the comparison written out by hand.
`;

export const PLAYBOOK_COST = `# Cost, latency and what to do about them

Every number here is measured against the live API, not estimated. Re-measure
with \`node scripts/probe.mjs\` rather than trusting the page — the upstream moves.

## The formulas

| Tool | Upstream requests |
|---|---|
| \`geolink_geocode\` | 1, cached 10 minutes |
| \`geolink_reverse_geocode\` | 1, cached 10 minutes |
| \`geolink_search_places\` | \`ceil((limit + offset) / 20)\`, fewer when the area runs out; +1 if \`near\` is a name |
| \`geolink_get_directions\` | 1, +1 per endpoint given as a name |
| \`geolink_distance_matrix\` | **1, whatever the grid size**, +1 per named location |
| \`geolink_find_nearest\` | 1 matrix + the search, in discovery mode |
| \`geolink_sweep_area\` | \`grid_points × ceil(results_per_point / 20)\`, +1 if the area is a name |

The page size is 20. Depth is bought in units of 20, and the engine stops early
the moment the area runs out, so asking for 100 in a place that holds 30 costs
two requests, not five.

## Measured, 2026-09-03, against \`geolink-eg.com\`

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
- **A matrix replaces a loop.** One \`geolink_distance_matrix\` call covers every
  origin × destination pair. Building the same grid from directions costs N×M
  requests and answers no better.
- **Sweep wall-clock ≈ (grid_points ÷ concurrency) × per-point time.** Widening
  the grid saves more time than lowering depth, because it removes whole rounds.
- **Quote before spending.** Any sweep over about a minute should be \`dry_run\`
  first and the estimate given to whoever asked.
- **Coordinates are free, names are not.** Passing a coordinate you already hold
  skips a geocode and removes a class of ambiguity at the same time.

## What the server refuses

Two guards, both env-tunable, both naming the exact fix in the error:

| Guard | Default | Variable |
|---|---|---|
| matrix cells (\`origins × destinations\`) | 100 | \`GEOLINK_MAX_MATRIX_CELLS\` |
| sweep API calls | 200 | \`GEOLINK_SWEEP_MAX_POINTS\` |

Nothing else has a ceiling. \`limit\` and \`results_per_point\` take any value; cost
scales linearly and the search stops early on its own.

## Concurrency, and why it is bounded

A sweep runs several grid points at once, and each point that asks for depth
makes its own parallel requests — the two multiply. The upstream reaches its
source from a single address with no proxy rotation, and a wide simultaneous
burst of near-identical requests is the pattern most likely to be throttled.

Points in flight are therefore divided down as \`results_per_point\` rises, holding
the product within a fixed budget. At default depth nothing changes: one request
per point, four points at a time. At \`results_per_point: 60\` the server runs two
points at a time instead of four, and says so in \`plan.concurrency\`.

The budget exists because of the single address, not because of the source's
published limits — it is a guess at what looks automated, deliberately
conservative. Where the upstream is configured with proxy rotation
(\`ENABLE_PROXY\`), the burst leaves from several addresses and the reason for the
budget weakens; raising \`GEOLINK_SWEEP_CONCURRENCY\` is defensible there and is
not defensible without it.
`;
