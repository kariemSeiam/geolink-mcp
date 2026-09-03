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

---

## Run the gates in order. Do not reorder them.

The order matters. Most errors here come from choosing a method before
establishing what kind of question was asked, then defending the method instead
of changing it.

| # | Gate | Output | Blocks on |
|---|---|---|---|
| 1 | **Shape** — one point, or an area? | the question classified | a regional question answered with one search |
| 2 | **Anchor** — resolve every place name to coordinates, and check them | verified centers | a geocode nobody tested |
| 3 | **Budget** — what will this cost in calls and seconds? | a quoted plan | an unquoted sweep |
| 4 | **Retrieve** — search, sweep, route, or matrix | raw results + their stats | — |
| 5 | **Completeness** — is this everything, or everything you asked for? | a saturation and edge verdict | a total reported as a total when it is a floor |
| 6 | **Tripwires** — run all ten | pass/fix list | any tripwire |
| 7 | **Answer** — with its confidence and what it excludes | the deliverable | — |

Gate 5 and Gate 6 are not formalities. They are where every error listed above
was eventually caught.

---

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

## Gate 2 — Anchor

Every name costs a geocode and every geocode returns exactly one answer with no
indication of how confident it is. Before building on a coordinate:

- Reverse-geocode it. If the district disagrees with the district in the original
  result, the match is weak.
- If the name was ambiguous — a common brand, a street that exists in four
  governorates — run `geolink_search_places` with the same string and look at the
  spread. Scattered candidates mean the name needs disambiguating with the user,
  not picking.
- Pass coordinates rather than names wherever they are already known. It is the
  cheapest optimisation available and removes this whole class of doubt.

Read `references/tripwires.md` §7 before using a geocoded area as a sweep
boundary. A viewport is not a border.

## Gate 3 — Budget

Every tool's cost is a formula, and `references/cost.md` has all of them with
measured latency. The two that matter most:

```
search_places   ceil((limit + offset) / 20) requests
sweep_area      grid_points × ceil(results_per_point / 20) requests
```

For anything regional, run `geolink_sweep_area` with `dry_run: true` first. It
returns the exact call count without spending any of it. Quote that number to
whoever asked before spending it — a sweep of a governorate at tight spacing is
minutes of wall-clock and hundreds of calls, and nobody wants to discover that
afterwards.

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

This is the gate that separates a number from a defensible number. Open
`references/coverage.md` and run its three tests:

1. **Saturation** — did any cell return exactly what it was allowed to return?
   Then the total is a floor. Say "at least".
2. **Overlap** — `raw_results ÷ unique_results` near 1.0 means neighbouring
   tiles never saw the same place, which means there was ground between them
   that neither covered.
3. **Edges** — reverse-geocode the corners of the area bounds. A district that
   appears there but not in the results is ground the grid stopped short of.

A search rather than a sweep has a simpler test: `source_exhausted`. When it is
`true`, the area genuinely has no more. When it is `false`, you stopped asking
first — say so rather than implying you found everything.

## Gate 6 — Tripwires

Run every tripwire in `references/tripwires.md`. Ten failure modes, each with
what happened, the check, and what passing looks like. Do not summarise them
from memory — open the file.

The three that recur most:

- **Name-matching lies** (§2). Identity is coordinates. `الصيدلية` is dozens of
  different pharmacies.
- **A floor mistaken for the edge of the world** (§4). A small round number is
  usually a parameter, not scarcity.
- **Silence read as completion** (§10). Zero results deserves a second query
  before it becomes "there are none".

## Gate 7 — Answer

State the number, then state what it excludes. Three sentences that make a map
answer trustworthy:

- What was covered: the area, the spacing, the depth.
- What it cost: calls and time, if anyone will run it again.
- What it misses: saturation, unswept edges, or a category the query wording
  would not have matched.

For a count that failed a completeness test, "at least 340 pharmacies, and the
downtown cells were saturated so the real number is higher" is a better answer
than 340. It is also the answer that survives someone checking.

---

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

## Files

| Path | What it holds |
|---|---|
| `references/tripwires.md` | the 10 failure modes + the check for each |
| `references/coverage.md` | covering an area without leaving holes: spacing maths, the three tests |
| `references/cost.md` | cost formulas, measured latency, planning rules |
| `references/recipes.md` | compositions: reachability, territory, service gaps, on-the-way |
| `scripts/probe.mjs` | re-measures every number in these files against the live API |
| `ledger/` | coverage claims made, and how each was verified |

The same content is served by the MCP server itself as resources —
`geolink://playbook`, `geolink://playbook/coverage`, `geolink://playbook/recipes`,
`geolink://scale` — generated from these files, so a client with no filesystem
reads exactly what is written here.
