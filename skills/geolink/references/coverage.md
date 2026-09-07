# Covering an area without leaving holes

A sweep reads an area from several vantage points and merges what each one saw.
Whether the result is *complete* fails in three independent ways, and the answer
reports two of them itself.

## 1. Spacing is the API's job now, and the measurement says why

Each vantage point searches outward from itself, so the worst-served location is
the corner of a cell, `spacing × 0.71` from the nearest point. That much has not
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

`spacing_km` still exists, takes 2–50, and should almost always be left unset.
Tighten it only for a category so dense that the search's own reach collapses —
and check the result against `results_complete` rather than against intuition,
because the symptom of a too-dense category is depth, not spacing (§2).

## 2. `results_complete: false` — the count is a floor

The failure that hides. A vantage point that stops paging before the source runs
dry saw only part of what was there, and the sweep still looks successful. This
used to require arithmetic against the plan; the answer now says it outright.

**The test:** read `results_complete`. `false` means at least one point still had
more to give, and `total` is a lower bound. `true` means the source ran out.
**Absent means the API did not say** — not that it is complete.

**The fix:** raise `pages_per_point` (up to 15). Measured on a 10 km sweep of
Zamalek:

| `pages_per_point` | `total` | `results_complete` | wall clock |
|---|---|---|---|
| 5 (default) | 100 | false | 1.7 s |
| 10 | 200 | false | 2.0 s |
| 15 | 218 | **true** | 3.3 s |

The default returns 46% of the pharmacies in Zamalek. It is the right default —
depth costs upstream reads and most questions do not need all of them — but a
count quoted from it is "at least 100", never "100".

For a single point, `geolink_search_places` with `limit: 0` does the same thing
and is the cheapest way to learn the true number for one neighbourhood.

## 3. `area_fully_swept: false` — ground never visited

A different failure with a different fix, and the one most easily confused with
§2. The sweep ran out of time before reaching every vantage point. The points it
did reach may have been read perfectly.

**The test:** read `area_fully_swept`. `false` arrives with `continue_from`.

**The fix:** call again passing `continue_from` verbatim, and merge. It is
opaque on purpose — it encodes where the sweep stopped, not a position you can
construct or reason about.

§2 and §3 are unrelated. A response can be short on either, both, or neither,
and applying the wrong remedy leaves the other one silently in place.

## 4. The edges — the one test nothing inside a sweep can run

A named area gets its bounds from the geocoder's viewport, which is often tighter
than the administrative boundary. Nothing inside a sweep can see what its own
bounds left out.

**The test:** reverse-geocode the four corners and the centre of the area. If a
corner comes back with a district that never appears in the `by_district`
breakdown, the sweep stopped short of ground that belongs to the area.

**The fix:** sweep that district by name as its own area, and add the result.
There is no padding parameter any more — the area you name is the area you get,
which is one fewer knob and one fewer thing to get subtly wrong.

## Reading the answer like an inspector

- **`view: "summary"` first.** It answers "how many" and "which districts" for a
  fraction of the tokens, and its `by_district` is what §4 is checked against.
  Only ask for the places once you know the count is worth listing.
- **`resolved_to`, every time.** Names collide. A sweep of the wrong Nasr City
  is indistinguishable from a sweep of the right one, and this field is the only
  thing that tells them apart.
- **A district with 1–2 where its neighbours have dozens** — either genuinely
  sparse, or the sweep reached it shallowly. Check `results_complete` before
  believing it.
- **`has_more` is not a completeness signal.** It means places already found and
  not yet shown. Paging with `offset` is free — it is served from the answer
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
