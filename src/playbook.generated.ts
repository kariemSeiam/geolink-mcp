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
the real number was three hundred and it had never been asked for more. A tool
advertised a cursor that led nowhere. A sweep reported 100 pharmacies in Zamalek
as a total when 218 was the number. Each gate below exists because one of those
shipped.

## Run the gates in order, and do not reorder them

The order matters. Most errors here come from choosing a method before
establishing what was asked, then defending the method instead of changing it.

| # | Gate | Output | Blocks on |
|---|---|---|---|
| 1 | **Shape** — one point or an area, and how wrong may it be? | the question classified + a stated tolerance | a regional question answered with one search |
| 2 | **Anchor** — resolve every place name to coordinates, and check them | verified centers | a geocode nobody tested |
| 3 | **Budget** — what will this cost in calls and seconds? | a quoted plan | an unquoted sweep |
| 4 | **Retrieve** — search, sweep, route, or matrix | raw results + what the answer says about itself | — |
| 5 | **Completeness** — is this everything, or everything you asked for? | a verdict on both kinds of short | a total reported as a total when it is a floor |
| 6 | **Tripwires** — run all eleven | pass/fix list | any tripwire |
| 7 | **Answer** — with its confidence and what it excludes | the deliverable | — |

Gates 5 and 6 are not formalities. They are where every error above was caught.

## Gate 1 — Shape

One distinction decides everything downstream:

> **Depth reads one center more deeply. A sweep reads new ground.**

\`geolink_search_places\` with \`limit=300\` from Tahrir Square will never find a
pharmacy in Giza. The source ranks outward from one point and runs out; raising
the limit buys more of the same neighbourhood.

- "near me", a landmark, a street, a single neighbourhood → **depth**.
- "in Giza", "across the city", "all of", "how many are there" → **sweep**.

Getting this backwards produces an answer that is complete-looking and wrong —
worse than an error, because nothing about the response looks off.

Then ask what nothing downstream can infer: **how wrong is this allowed to be?**
A count for a slide and a count for a filing take different depth and different
money. Without a stated tolerance, Gate 5's "at least N" is neither acceptable
nor a failure, because there is nothing to compare it against.

## Gate 2 — Anchor

A name resolves to exactly one place, with no indication of how confident that
was. A wrong anchor makes every later gate produce a well-verified answer about
the wrong place.

The place tools resolve names themselves and report the result as \`resolved_to\`.
**Read it back** — that field is the whole check, and skipping it is how a sweep
of the wrong Nasr City comes out looking perfect.
[recipes.md](references/recipes.md) has the confidence test;
[tripwires.md](references/tripwires.md) §7 covers using a geocoded area as a
sweep boundary. A viewport is not a border.

## Gate 3 — Budget

For an area whose size you do not know, run \`geolink_sweep_area\` with
\`dry_run: true\`: it reports how many requests the area needs and roughly how
long, without searching. \`fits_in_one_request: false\` means you will be
following \`continue_from\` — say so before starting, not halfway through.

The grid itself is no longer yours to plan: spacing, reach, merge and
de-duplication are the API's, chosen from measurement, and tightening
\`spacing_km\` mostly buys overlap — [coverage.md](references/coverage.md) has the
numbers. The knob that matters is \`pages_per_point\`, and it is a completeness
knob rather than a cost one; see Gate 5. [cost.md](references/cost.md) carries
the formulas and the measured latency.

## Gate 4 — Retrieve

Pick by shape, not by habit:

| Question | Tool |
|---|---|
| Where is this name? | \`geolink_geocode\` |
| What is at this point? | \`geolink_reverse_geocode\` |
| What is near this point? | \`geolink_search_places\` |
| How many are there, exactly? | \`geolink_search_places\` with \`limit: 0\` for one point; \`geolink_sweep_area\` with \`view: "summary"\` for an area |
| What is in this whole area? | \`geolink_sweep_area\` |
| How do I get from A to B? | \`geolink_get_directions\` |
| Times between many and many? | \`geolink_distance_matrix\` |
| Which of these serves this customer? | \`geolink_find_nearest\` |

One \`geolink_distance_matrix\` call replaces N×M direction calls for a single
request; looping directions to build a grid is the most expensive mistake
available here. Read its \`coverage\` block — a matrix too large for the time
budget returns unmeasured cells as four zeros, which is character for character
what two points in the same spot look like.

## Gate 5 — Completeness

This is the gate that separates a number from a defensible number, and the
answer now tells you most of it — but in **two independent fields that fail for
different reasons and are fixed by different parameters**. Reading one and
assuming the other is the current version of the old mistake.

| Field | What \`false\` means | The fix |
|---|---|---|
| \`results_complete\` | The points that *were* visited still had more to give; \`total\` is a floor | \`pages_per_point\` (≤15) on a sweep, \`limit: 0\` on a search, \`candidate_limit\` on find_nearest |
| \`area_fully_swept\` | The sweep ran out of time with ground never visited | pass \`continue_from\` back and merge |

They are unrelated, and a response can be short on either, both or neither. A
default sweep of Zamalek returns 100 pharmacies with \`area_fully_swept: true\` —
every vantage point *was* visited — while \`results_complete\` is \`false\` and the
real number, once each point is drained, is 218. Reading only the first field
gives you 100 and a clean conscience.

**An absent field means the API did not say, which is not \`true\`** — and
treating undefined as complete is the reading that stops you looking.

\`has_more\` is neither of these: it is places already found and not yet shown,
and paging them with \`offset\` is free.

One test nothing inside a sweep can run is the edges, because a sweep cannot see
what its own bounds left out: reverse-geocode the corners and centre of the area
and look for a district missing from the \`by_district\` breakdown.
[coverage.md](references/coverage.md) has the method.

## Gate 6 — Tripwires

Run every tripwire in [tripwires.md](references/tripwires.md) — eleven failure
modes, each with what happened, the check, and what passing looks like. Do not
summarise them from memory; open the file. Recalling "something about
duplicates" is what let §2 through the first time, and the specificity is the
whole value.

## Gate 7 — Answer

This gate does not certify a count. It attests to a method over a stated scope,
which is why a named exception is part of a passing answer rather than an
admission — what damages trust is a caveat someone else finds later.

State the number, then what it excludes. Three sentences:

- What was covered: the area, and what the name resolved to. Names collide;
  \`resolved_to\` is the only proof you swept the Nasr City you meant.
- What it cost: calls and time, if anyone will run it again.
- What it misses: whichever of the two completeness fields came back false,
  unswept edges, or a category the query wording would not have matched.

For a count that failed either completeness test, "at least 340 pharmacies —
the vantage points still had more to give, so the real number is higher" is a
better answer than 340. It is also the answer that survives someone checking.

## Keeping this skill honest

\`\`\`bash
node scripts/probe.mjs           # regenerates every measured number below
\`\`\`

Every figure in these references is measured against the live API, not assumed,
and the upstream changes. **Run the probe rather than trusting a number written
in a file** — it prints what it saw today beside what was recorded and flags the
drift.

When a gate catches something new, add a tripwire. When a coverage claim ships,
add a ledger row. A static version of this skill would be wrong within a
quarter.

## Size budget

| File | Budget | When it is hit |
|---|---|---|
| \`SKILL.md\` | 220 lines | move the longest gate's detail into a reference file and leave the gate pointing at it |
| each reference | 250 lines | split by failure mode or by tool, never by adding a second topic to an existing file |
| \`ledger/\` rows | no limit | append-only; a row is never edited after its verdict is written |

This file is loaded whenever a map question is asked, so its length is a cost
paid on every one of them. Detail belongs in the references, which load only
when a gate names them.

The budget was 200 and has been raised once. Both times it came under pressure —
first when gates 1, 5 and 7 gained content, then when the two completeness
fields replaced the single one — the lines were found by emptying gates 2 and 3
into the references, not by moving the number again. Raising it is the last
move, and it is written down rather than done quietly, because a budget that
moves without a note is not a budget.

## Files

| Path | What it holds |
|---|---|
| [references/tripwires.md](references/tripwires.md) | the 10 failure modes + the check for each |
| [references/coverage.md](references/coverage.md) | covering an area without leaving holes: spacing maths, the three tests |
| [references/cost.md](references/cost.md) | cost formulas, measured latency, planning rules |
| [references/recipes.md](references/recipes.md) | compositions: reachability, territory, service gaps, on-the-way |
| [scripts/probe.mjs](scripts/probe.mjs) | re-measures every number in these files against the live API |
| [ledger/](ledger/) | coverage claims made, and how each was verified |

The MCP server serves the same content as resources — \`geolink://playbook\`,
\`geolink://playbook/coverage\`, \`geolink://playbook/recipes\`, \`geolink://scale\` —
generated from these files, so a client with no filesystem reads exactly this.
`;

export const PLAYBOOK_COVERAGE = `# Covering an area without leaving holes

A sweep reads an area from several vantage points and merges what each one saw.
Whether the result is *complete* fails in three independent ways, and the answer
reports two of them itself.

## 1. Spacing is the API's job now, and the measurement says why

Each vantage point searches outward from itself, so the worst-served location is
the corner of a cell, \`spacing × 0.71\` from the nearest point. That much has not
changed. What changed is who picks the number, and the measurement that settled
it:

| Spacing | Overlap between neighbours | Places found | Verdict |
|---|---|---|---|
| 3 km | 69% | 472 | most calls spent re-reading the same places |
| 15 km | 11% | 818 | the knee |

Tightening the grid feels safer and is not. At 3 km the points mostly see each
other's places; the extra calls buy duplicates, not ground. Reach was measured at
p50 ≈ 4 km and p90 ≈ 10 km, and 15 km spacing is what covers that without paying
for the overlap.

\`spacing_km\` still exists, takes 2–50, and should almost always be left unset.
Tighten it only for a category so dense that the search's own reach collapses —
and check the result against \`results_complete\` rather than against intuition,
because the symptom of a too-dense category is depth, not spacing (§2).

## 2. \`results_complete: false\` — the count is a floor

The failure that hides. A vantage point that stops paging before the source runs
dry saw only part of what was there, and the sweep still looks successful. This
used to require arithmetic against the plan; the answer now says it outright.

**The test:** read \`results_complete\`. \`false\` means at least one point still had
more to give, and \`total\` is a lower bound. \`true\` means the source ran out.
**Absent means the API did not say** — not that it is complete.

**The fix:** raise \`pages_per_point\` (up to 15). Measured on a 10 km sweep of
Zamalek:

| \`pages_per_point\` | \`total\` | \`results_complete\` | wall clock |
|---|---|---|---|
| 5 (default) | 100 | false | 1.7 s |
| 10 | 200 | false | 2.0 s |
| 15 | 218 | **true** | 3.3 s |

The default returns 46% of the pharmacies in Zamalek. It is the right default —
depth costs upstream reads and most questions do not need all of them — but a
count quoted from it is "at least 100", never "100".

For a single point, \`geolink_search_places\` with \`limit: 0\` does the same thing
and is the cheapest way to learn the true number for one neighbourhood.

## 3. \`area_fully_swept: false\` — ground never visited

A different failure with a different fix, and the one most easily confused with
§2. The sweep ran out of time before reaching every vantage point. The points it
did reach may have been read perfectly.

**The test:** read \`area_fully_swept\`. \`false\` arrives with \`continue_from\`.

**The fix:** call again passing \`continue_from\` verbatim, and merge. It is
opaque on purpose — it encodes where the sweep stopped, not a position you can
construct or reason about.

§2 and §3 are unrelated. A response can be short on either, both, or neither,
and applying the wrong remedy leaves the other one silently in place.

## 4. The edges — the one test nothing inside a sweep can run

A named area gets its bounds from the geocoder's viewport, which is often tighter
than the administrative boundary. Nothing inside a sweep can see what its own
bounds left out.

**The test:** reverse-geocode the four corners and the centre of the area. If a
corner comes back with a district that never appears in the \`by_district\`
breakdown, the sweep stopped short of ground that belongs to the area.

**The fix:** sweep that district by name as its own area, and add the result.
There is no padding parameter any more — the area you name is the area you get,
which is one fewer knob and one fewer thing to get subtly wrong.

## Reading the answer like an inspector

- **\`view: "summary"\` first.** It answers "how many" and "which districts" for a
  fraction of the tokens, and its \`by_district\` is what §4 is checked against.
  Only ask for the places once you know the count is worth listing.
- **\`resolved_to\`, every time.** Names collide. A sweep of the wrong Nasr City
  is indistinguishable from a sweep of the right one, and this field is the only
  thing that tells them apart.
- **A district with 1–2 where its neighbours have dozens** — either genuinely
  sparse, or the sweep reached it shallowly. Check \`results_complete\` before
  believing it.
- **\`has_more\` is not a completeness signal.** It means places already found and
  not yet shown. Paging with \`offset\` is free — it is served from the answer
  already in hand, not a second sweep.

## Sparse queries need a second look

The source occasionally answers a sparse query with a shorter list than it holds
— measured at about one call in four for rare names, never observed on dense
ones. The server already re-reads a page that looks like the end before accepting
it, so a single tool call is protected.

What is *not* protected is a conclusion drawn from one narrow query. "There are
no pharmacies in this village" deserves a second query with a different phrasing
or the other language before it becomes an answer. Arabic and English indexes do
not contain identical sets.
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
1. Compare the \`by_district\` breakdowns between the two — \`view: "summary"\` gives them for a fraction of the tokens. Check \`results_complete\` on both first: a floor divided by a total is not a ratio.
1.  A district high in demand and
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

## 6. Two ways to be incomplete, and the wrong remedy for each

**What happened.** A vantage point that stops paging before the source runs dry
ran out of permission, not places, and the sweep still reports a total that looks
authoritative — a default sweep of Zamalek returns 100 pharmacies where drained
it returns 218. The answer says so now, but in **two fields that fail
independently and take different fixes**; reading one while assuming the other is
the same mistake wearing a new coat.

| Field | \`false\` means | Fix |
|---|---|---|
| \`results_complete\` | the points visited still had more to give; \`total\` is a floor | \`pages_per_point\` (≤15), or \`limit: 0\` on a search |
| \`area_fully_swept\` | the sweep ran out of time with ground unvisited | pass \`continue_from\` back and merge |

**Why here.** Density is never uniform, so both can be true at once: downtown
points saturate while the sweep also times out before reaching the rural ones.

**The check.** Read both. An *absent* field means "not told", never \`true\` —
undefined read as complete is the reading that stops you looking.

**Passes when:** both fields are stated, the applicable remedy was applied or
explicitly declined, and any total still short is reported as "at least N".

---

## 7. The viewport is not the boundary

**What happened.** A named area's bounds come from the geocoder's viewport, which
is a display rectangle, not an administrative border. It is frequently tighter
than the real area — a district's viewport can exclude the streets along its own
edge — and occasionally far looser, when a small place falls back to its parent
city's box.

**Why here.** The source returns what a map would show, not what a boundary file
would define. There is no boundary geometry in this API at all.

**The check.** Reverse-geocode the four corners and the centre of the bounds. A
corner returning a district absent from your results is ground the sweep stopped
short of; one returning a *different city* means the viewport is far too loose
and the area needs \`{center, radius_km}\` instead.

**Passes when:** the corners have been probed, and any district found there but
missing from the results has been swept by name as its own area and added. There
is no padding parameter — the area you name is the area you get.

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

**What happened.** The distance matrix collected its per-pair requests with
\`as_completed\`, which yields futures as they finish. The pair index was recovered
correctly and then discarded — each result was *appended* to its row, so every
travel time landed in whichever column its request happened to return in. The
echoed destination list was built from what was sent, so it stayed in order. The
two halves disagreed, \`nearest_destination_index\` pointed into the scrambled
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
was written before depth existed, and before anything travelled outside \`data\`.

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
\`results_complete\` was read rather than inferred from the length of the list.
"Fewer came back than I asked for, so that is all there is" is the arithmetic
this tripwire is named after — a walk stopped by a throttle comes back short too.

---

## Quick audit

\`\`\`bash
# is this a total or a floor? two fields, two remedies, read both
#   results_complete === false  -> raise pages_per_point (<=15), or limit: 0
#   area_fully_swept === false  -> pass continue_from back and merge
#   either one undefined        -> not told; do NOT read as complete

# is the matrix all there? unmeasured cells are four zeros, same as "no distance"
#   coverage.complete === false -> ask for a smaller grid

# regenerate every measured number in these files against the live API
node scripts/probe.mjs
\`\`\`

The machine reports completeness now; it does not report tripwires 3, 5, 7 or 8,
which still need the comparison written out by hand.
`;

export const PLAYBOOK_COST = `# Cost, latency and what to do about them

Every number here is measured against the live API, not estimated. Re-measure
with \`node scripts/probe.mjs\` rather than trusting the page — the upstream moves.

## The formulas

| Tool | Upstream requests |
|---|---|
| \`geolink_geocode\` | 1, cached 10 minutes |
| \`geolink_reverse_geocode\` | 1, cached 10 minutes |
| \`geolink_search_places\` | **1**, whatever the depth — a name in \`near\` costs nothing extra |
| \`geolink_get_directions\` | 1, +1 per endpoint given as a name |
| \`geolink_distance_matrix\` | **1, whatever the grid size**, +1 per named location |
| \`geolink_find_nearest\` | **1** in search mode; 1 matrix + geocodes when you pass a list |
| \`geolink_sweep_area\` | **1 per call**; \`dry_run\` says how many calls the whole area needs. +1 geocode when the area is \`{place}\` |

Three of those became 1 when the paging, the grid and the road-ranking moved
server-side. What used to cost this client sixteen requests for a deep search is
now one request that the API pages behind. The cost did not disappear — it moved
to where it can be measured against a time budget instead of a call count.

\`dry_run\` on a sweep is the only place a caller still needs to plan: it reports
\`requests_needed\` and \`estimated_seconds\`, and \`fits_in_one_request: false\`
means the answer will arrive in pieces joined by \`continue_from\`.

**Paging is free.** Whole search and sweep answers are cached, so \`offset\` is
served from the answer already in hand. A second page never costs a second
sweep.

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

That is the only request this server refuses on size, and the error names the
parameter change that would succeed. \`limit\`, \`pages_per_point\` and the area of
a sweep have no client-side ceiling.

## What bounds a sweep now

Not a call count — a time budget, enforced by the API. That is a better bound
because it is the thing that actually runs out, and because a request that hits
it can hand back \`continue_from\` and be resumed, where a refused request could
only be re-planned.

It also means **a large area does not fail, it arrives in pieces**. Check
\`area_fully_swept\`; if it is \`false\`, you have part of the ground and a token for
the rest. A caller that ignores the field gets a plausible partial answer with
nothing marking it as partial.

The concurrency budget that used to live in this client is gone with the grid it
was protecting. The upstream reaches its source from one address without proxy
rotation, and pacing that burst is now the engine's problem, decided next to the
measurements it depends on rather than three layers away from them.
`;
