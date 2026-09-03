# Tripwires — the ten ways map work returns a confident wrong answer

Every one of these was hit for real against this API, most of them in a single
week of building on it. None are exotic. They are the normal failure modes of
scraped map data, which is why they need a checklist rather than care.

The common shape: **the response looks successful.** There is no error, no
warning, no empty field. A wrong coverage number and a right one are the same
JSON. That is what makes a checklist necessary — nothing here announces itself.

Run all ten at the verification gate. Open this file; do not recall it from memory.

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
`الصيدلية` — "the pharmacy" — which is what a small unnamed pharmacy is called
everywhere in the country.

**Why here.** Generic names are the norm in this data, not the exception. Any
category with unbranded operators — pharmacies, cafés, groceries, workshops —
produces dozens of genuinely distinct places sharing one string.

**The check.** Identity is coordinates. Compare, de-duplicate, and count on
`location`, rounded to about 4 decimal places (~11 m). Use names for display
only. When name-based de-duplication is wanted, it must be paired with a
distance threshold — which is exactly why `dedupe_meters` exists and why setting
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

## 4. A floor mistaken for the edge of the world

**What happened.** The search engine stopped after collecting six results. Every
consumer built on top of it — the API, the MCP server, its tools — treated six
as what existed. It was a parameter: an internal "keep paging until you have at
least six" floor, never a limit on the data. Asking for more returned 300.

**Why here.** Scraped sources have internal pagination knobs that leak outward as
apparent scarcity. The number that comes back is a function of what was asked
for, and the ask is usually invisible.

**The check.** When a result count looks round, small, or suspiciously stable
across very different queries, it is a parameter, not a property of the world.
Find the knob before reasoning about the data.

**Passes when:** a low count has been re-tested with an explicitly larger request
before it is reported as scarcity.

---

## 5. A published limit nobody verified end to end

**What happened.** The search tool advertised `limit: 1-100` and returned an
`offset` to page with. The upstream returned one page. `limit=100` was
unreachable, and any `offset` past the first page returned nothing, forever —
while the response still reported `has_more: true` and pointed at a
`next_offset` that led nowhere.

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

**The check.** Compare `stats.raw_results` against
`plan.grid_points × plan.results_per_point`. As that ratio approaches 1, the grid
is saturated and the number is a lower bound. Raise `results_per_point`, tighten
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
viewport is far too loose and the area needs `{center, radius_km}` instead.

**Passes when:** the corners have been probed, and any correction is applied with
`padding_km` before the real run, not after.

---

## 8. Straight-line thinking in a city with a river

**What happened.** The nearest branch by straight line and the nearest by road
are routinely different places here, and the gap is not small. A river with a
limited number of bridges makes a facility 800 m away a fifteen-minute drive.

**Why here.** Cairo, Giza and every delta city are cut by water and one-way
systems. Straight-line ranking is not an approximation of road ranking; on these
geographies it is a different answer.

**The check.** Rank with `geolink_find_nearest` or a distance matrix, never with
haversine. When both are available, compute the detour ratio —
`distance_meters ÷ (straight_line_km × 1000)`. Anything above about 2.5 deserves
a sentence in the answer, because it usually means a bridge, and a human reading
"800 m away" would otherwise assume walking distance.

**Passes when:** every "nearest" claim rests on travel time, and any large detour
ratio is surfaced rather than smoothed over.

---

## 9. A cache keyed on less than the request

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

## 10. Silence read as completion

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

```bash
# saturation: is the sweep's total a floor rather than a total?
#   ratio = stats.raw_results / (plan.grid_points * plan.results_per_point)
#   ratio -> 1.0 means saturated

# overlap health: are neighbouring tiles seeing each other's places?
#   ratio = stats.raw_results / stats.unique_results
#   ~1.0 = tiles never overlap -> ground between them was covered by neither
#   >3.0 = heavy overlap -> coverage safe, calls wasted

# regenerate every measured number in these files against the live API
node scripts/probe.mjs
```

Machine checks catch saturation and overlap. They do not catch tripwires 3, 5, 7
or 8 — those need the comparison written out by hand.
