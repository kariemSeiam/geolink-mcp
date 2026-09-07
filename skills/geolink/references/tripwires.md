# Tripwires — the eleven ways map work returns a confident wrong answer

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
`الصيدلية` — "the pharmacy" — which is what a small unnamed pharmacy is called
everywhere in the country.

**Why here.** Generic names are the norm in this data, not the exception. Any
category with unbranded operators — pharmacies, cafés, groceries, workshops —
produces dozens of genuinely distinct places sharing one string.

**The check.** Identity is coordinates. Compare, de-duplicate, and count on
`location`, rounded to about 4 decimal places (~11 m). Use names for display
only. When name-based de-duplication is wanted, it must be paired with a
distance threshold — which is exactly why the engine merges on both name and
distance rather than on either alone, and why doing it too high silently merges distinct places.

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
upward is easier to miss because a large number feels like success: a surprisingly
*high* unique count usually means duplicates stopped merging, not that the
district is rich.

**Point it at your own instrument too.** The knob that produces a wrong number is
as often ours as the source's. This client once refused areas above its own
200-call ceiling, and an agent hitting it reported "this area is too large to
sweep" — the same failure, with our parameter. The area was not too large; the
number was. That ceiling is gone, replaced by a resumable time budget.

**The check.** Any count that is round, suspiciously stable across different
queries, or larger than the ground plausibly holds, gets traced to the parameter
that produced it before it gets reported. Ask which knob could have manufactured
this number — upstream, in the server, or in the analysis — and rule it out.

**Passes when:** a surprising number in either direction has been re-run with the
relevant parameter deliberately changed, and it survived.

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

## 6. Two ways to be incomplete, and the wrong remedy for each

**What happened.** A vantage point that stops paging before the source runs dry
ran out of permission, not places, and the sweep still reports a total that looks
authoritative — a default sweep of Zamalek returns 100 pharmacies where drained
it returns 218. The answer says so now, but in **two fields that fail
independently and take different fixes**; reading one while assuming the other is
the same mistake wearing a new coat.

| Field | `false` means | Fix |
|---|---|---|
| `results_complete` | the points visited still had more to give; `total` is a floor | `pages_per_point` (≤15), or `limit: 0` on a search |
| `area_fully_swept` | the sweep ran out of time with ground unvisited | pass `continue_from` back and merge |

**Why here.** Density is never uniform, so both can be true at once: downtown
points saturate while the sweep also times out before reaching the rural ones.

**The check.** Read both. An *absent* field means "not told", never `true` —
undefined read as complete is the reading that stops you looking.

**Passes when:** both fields are stated, the applicable remedy was applied or
explicitly declined, and any total still short is reported as "at least N".

---

## 7. There is no boundary, and the field named like one is a constant

**What happened.** A sweep took a named area and covered "its geocoded
viewport". A geocode returns a `bounds` object, so this looked well-founded for
as long as nobody measured it. `bounds` is the point plus a fixed 0.001 degrees
in each direction: **Giza, Cairo and Nasr City all come back as the same
190 x 220 metre rectangle.** It is not a viewport, it is decoration with a
plausible name.

So `area: {place: "Giza"}` swept a box the size of a city block and reported it
as a governorate — the exact failure the whole method exists to prevent, in the
invocation the documentation led with. It survived because a 220 m box still
returns a lot of pharmacies: the search's own reach carries far beyond the
bounds, so the answer looked healthy and was about ground nobody had specified.

**Why here.** The field is not lying, it is answering a smaller question than
its name implies, and the earlier version of this tripwire repeated the
misreading — "often tighter than the administrative boundary" is what you write
when you assume the number is a real viewport that happens to be conservative.
A field that is the same for a governorate and a district is not conservative.
It is not a measurement at all.

**The check.** Geocode two places of wildly different size and compare the
extent of their bounds. If the boxes are the same, `bounds` is a constant, and
anything that treats it as an area is measuring nothing. More generally: before
building on a field, confirm it varies with the thing it claims to describe.

**Passes when:** no area is derived from a geocode. Ground is given as
`{center, radius_km}` or `{bounds}` you chose — GeoLink holds no boundary
geometry, so "all of Giza" is always a radius someone picked, and the radius is
stated in the answer rather than implied by a place name.

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

## 9. Concurrency that keeps the index and loses the order

**What happened.** The distance matrix collected its per-pair requests with
`as_completed`, which yields futures as they finish. The pair index was recovered
correctly and then discarded — each result was *appended* to its row, so every
travel time landed in whichever column its request happened to return in. The
echoed destination list was built from what was sent, so it stayed in order. The
two halves disagreed, `nearest_destination_index` pointed into the scrambled
half, and "which of these is closest" returned a real place chosen at random.

**Why here.** Nothing about the response looked wrong. It was well-formed, fully
populated, internally plausible, and every number in it was a genuine
measurement of something — just of the wrong pair. It only appears with more
than one destination, so every single-destination test passed.

**The check.** Assert a physical invariant: a road route cannot be shorter than
the straight line between its own endpoints. It costs nothing, it is not a
heuristic, and it is what surfaced this — one destination measured 5184 m alone
and 2759 m inside a four-destination call. Where a result can be obtained two
ways, obtain it both ways once and compare.

**Passes when:** every distance in a batched result is at least the straight-line
distance for its own pair, and a spot-checked entry matches the same query made
alone.

## 10. A cache keyed on less than the request

**What happened.** Three times now, in three codebases. Twice a search cache was
keyed on query, location and language but not on depth, so a shallow answer was
served to a request for far more — 20 results for a request for 100, with nothing
indicating a cache hit. The third was subtler: a cache stored the *unwrapped*
body for calls that needed the whole envelope, so the second identical call got
the places and silently lost the fields beside them.

**Why here.** Caching is always older than the parameter that breaks it. The key
was written before depth existed, and before anything travelled outside `data`.

**The check.** Every parameter that changes the response must appear in the cache
key. When adding a parameter to a cached call, the key is part of the change, not
a follow-up.

**Passes when:** the key contains every argument the response depends on, the
cache stores what the call actually returns, and a same-query-different-depth
pair has been tested.

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
re-reads a page that looks like the end, and a walk now reports whether it
drained the source or was cut off — the two used to be the same short list. Apply
the same principle to your own stopping rules: a district with zero results gets
a second look before it is reported empty.

**Passes when:** no conclusion rests on a single observation of absence, and
`results_complete` was read rather than inferred from the length of the list.
"Fewer came back than I asked for, so that is all there is" is the arithmetic
this tripwire is named after — a walk stopped by a throttle comes back short too.

---

## Quick audit

```bash
# is this a total or a floor? two fields, two remedies, read both
#   results_complete === false  -> raise pages_per_point (<=15), or limit: 0
#   area_fully_swept === false  -> pass continue_from back and merge
#   either one undefined        -> not told; do NOT read as complete

# is the matrix all there? unmeasured cells are four zeros, same as "no distance"
#   coverage.complete === false -> ask for a smaller grid

# regenerate every measured number in these files against the live API
node scripts/probe.mjs
```

The machine reports completeness now; it does not report tripwires 3, 5, 7 or 8,
which still need the comparison written out by hand.
