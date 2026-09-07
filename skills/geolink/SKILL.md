---
name: geolink
description: Use when answering any question about places, addresses, coverage, routes, travel time, catchment or territory with the GeoLink MCP server — "how many pharmacies in Giza", "which branch serves this customer", "where should we open next", "is this address deliverable", "what's near here", "how long from A to B". Also use when a map answer needs to be defensible: proving a count is complete, checking whether a geocode is trustworthy, or deciding between searching deeper and sweeping wider.
version: 2.0.0
metadata:
  requires: GeoLink MCP server (geolink-mcp), any client
  keywords:
    - maps
    - geocoding
    - places
    - coverage
    - routing
    - travel-time
    - territory
    - egypt
    - mcp
---

# GeoLink — from a map question to an answer you can defend

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

`geolink_search_places` with `limit=300` from Tahrir Square will never find a
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

The place tools resolve names themselves and report the result as `resolved_to`.
**Read it back** — that field is the whole check, and skipping it is how a sweep
of the wrong Nasr City comes out looking perfect.
[recipes.md](references/recipes.md) has the confidence test;
[tripwires.md](references/tripwires.md) §7 covers using a geocoded area as a
sweep boundary. A viewport is not a border.

## Gate 3 — Budget

For an area whose size you do not know, run `geolink_sweep_area` with
`dry_run: true`: it reports how many requests the area needs and roughly how
long, without searching. `fits_in_one_request: false` means you will be
following `continue_from` — say so before starting, not halfway through.

The grid itself is no longer yours to plan: spacing, reach, merge and
de-duplication are the API's, chosen from measurement, and tightening
`spacing_km` mostly buys overlap — [coverage.md](references/coverage.md) has the
numbers. The knob that matters is `pages_per_point`, and it is a completeness
knob rather than a cost one; see Gate 5. [cost.md](references/cost.md) carries
the formulas and the measured latency.

## Gate 4 — Retrieve

Pick by shape, not by habit:

| Question | Tool |
|---|---|
| Where is this name? | `geolink_geocode` |
| What is at this point? | `geolink_reverse_geocode` |
| What is near this point? | `geolink_search_places` |
| How many are there, exactly? | `geolink_search_places` with `limit: 0` for one point; `geolink_sweep_area` with `view: "summary"` for an area |
| What is in this whole area? | `geolink_sweep_area` |
| How do I get from A to B? | `geolink_get_directions` |
| Times between many and many? | `geolink_distance_matrix` |
| Which of these serves this customer? | `geolink_find_nearest` |

One `geolink_distance_matrix` call replaces N×M direction calls for a single
request; looping directions to build a grid is the most expensive mistake
available here. Read its `coverage` block — a matrix too large for the time
budget returns unmeasured cells as four zeros, which is character for character
what two points in the same spot look like.

## Gate 5 — Completeness

This is the gate that separates a number from a defensible number, and the
answer now tells you most of it — but in **two independent fields that fail for
different reasons and are fixed by different parameters**. Reading one and
assuming the other is the current version of the old mistake.

| Field | What `false` means | The fix |
|---|---|---|
| `results_complete` | The points that *were* visited still had more to give; `total` is a floor | `pages_per_point` (≤15) on a sweep, `limit: 0` on a search, `candidate_limit` on find_nearest |
| `area_fully_swept` | The sweep ran out of time with ground never visited | pass `continue_from` back and merge |

They are unrelated, and a response can be short on either, both or neither. A
default sweep of Zamalek returns 100 pharmacies with `area_fully_swept: true` —
every vantage point *was* visited — while `results_complete` is `false` and the
real number, once each point is drained, is 218. Reading only the first field
gives you 100 and a clean conscience.

**An absent field means the API did not say, which is not `true`** — and
treating undefined as complete is the reading that stops you looking.

`has_more` is neither of these: it is places already found and not yet shown,
and paging them with `offset` is free.

One test nothing inside a sweep can run is the edges, because a sweep cannot see
what its own bounds left out: reverse-geocode the corners and centre of the area
and look for a district missing from the `by_district` breakdown.
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
  `resolved_to` is the only proof you swept the Nasr City you meant.
- What it cost: calls and time, if anyone will run it again.
- What it misses: whichever of the two completeness fields came back false,
  unswept edges, or a category the query wording would not have matched.

For a count that failed either completeness test, "at least 340 pharmacies —
the vantage points still had more to give, so the real number is higher" is a
better answer than 340. It is also the answer that survives someone checking.

## Keeping this skill honest

```bash
node scripts/probe.mjs           # regenerates every measured number below
```

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
| `SKILL.md` | 220 lines | move the longest gate's detail into a reference file and leave the gate pointing at it |
| each reference | 250 lines | split by failure mode or by tool, never by adding a second topic to an existing file |
| `ledger/` rows | no limit | append-only; a row is never edited after its verdict is written |

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

The MCP server serves the same content as resources — `geolink://playbook`,
`geolink://playbook/coverage`, `geolink://playbook/recipes`, `geolink://scale` —
generated from these files, so a client with no filesystem reads exactly this.
