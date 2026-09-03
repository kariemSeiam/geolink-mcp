---
name: geolink
description: Use when answering any question about places, addresses, coverage, routes, travel time, catchment or territory with the GeoLink MCP server — "how many pharmacies in Giza", "which branch serves this customer", "where should we open next", "is this address deliverable", "what's near here", "how long from A to B". Also use when a map answer needs to be defensible: proving a count is complete, checking whether a geocode is trustworthy, or deciding between searching deeper and sweeping wider.
version: 1.0.0
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

`geolink_search_places` with `limit=300` from Tahrir Square will never find a
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

For anything regional, run `geolink_sweep_area` with `dry_run: true` first. It
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
| Where is this name? | `geolink_geocode` |
| What is at this point? | `geolink_reverse_geocode` |
| What is near this point? | `geolink_search_places` |
| What is in this whole area? | `geolink_sweep_area` |
| How do I get from A to B? | `geolink_get_directions` |
| Times between many and many? | `geolink_distance_matrix` |
| Which of these serves this customer? | `geolink_find_nearest` |

One `geolink_distance_matrix` call replaces N×M direction calls and costs a
single request. Looping directions to build a grid is the most expensive
mistake available here.

## Gate 5 — Completeness

This is the gate that separates a number from a defensible number, and most of
it is now computed for you.

A sweep returns a `completeness` block: `saturated_points` (counted per point,
never averaged — an average hides five saturated downtown cells behind 195 empty
rural ones), `overlap_ratio`, a `verdict` of `bounded`, `floor` or
`gaps_likely`, and `notes` naming the parameter change for each problem found.
A `floor` verdict means report "at least N", not "N".

One test it cannot run for you is the edges, because nothing inside a sweep can
see what the bounds left out: reverse-geocode the corners and centre of
`area.bounds` and look for a district missing from `stats.by_district`.
[coverage.md](references/coverage.md) has the arithmetic and what each number
means.

A search has a simpler test: `source_exhausted`. When `true`, the area has no
more. When `false`, you stopped asking first — say so rather than implying you
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

```bash
node scripts/probe.mjs           # regenerates every measured number below
```

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
| `SKILL.md` | 220 lines | move the longest gate's detail into a reference file and leave the gate pointing at it |
| each reference | 250 lines | split by failure mode or by tool, never by adding a second topic to an existing file |
| `ledger/` rows | no limit | append-only; a row is never edited after its verdict is written |

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
`geolink://playbook`, `geolink://playbook/coverage`, `geolink://playbook/recipes`,
`geolink://scale` — generated from these files, so a client with no filesystem
reads exactly what is written here.
