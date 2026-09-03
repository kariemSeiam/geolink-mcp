# Ledger — coverage claims, and how each was checked

A count is a claim. This is where claims are recorded with the evidence that
supported them, so that the next person to ask the same question starts from a
number with a method attached rather than a number.

Append a row **before** the answer is delivered, not after. Writing down how the
count was verified while the results are still in front of you is what makes the
verification real; reconstructed afterwards, it is a description of what you
would have done.

## Row format

```
## 2026-09-03 · pharmacies in Nasr City

claim:        at least 412
area:         {place: "Nasr City"} + padding_km 2
spacing:      2 km, 61 grid points
depth:        40 per point (2 requests each)
cost:         122 calls, 41 s

saturation:   raw 1,180 / (61 × 40) = 0.48       not saturated
overlap:      raw 1,180 / unique 412 = 2.86      healthy
edges:        4 corners + centre reverse-geocoded; all 5 districts
              present in by_district                          clean

verdict:      complete for this wording. "صيدلية" only — an English-language
              sweep would likely add branded chains indexed under "pharmacy".
              Not run.
```

The `verdict` line is the one that matters. It is where the honest limitation
goes: the wording that was used, the language that was not tried, the districts
that came back thin, the cells that saturated. A row without a limitation is
usually a row where nobody looked.

## What to record

| Field | Why |
|---|---|
| claim | the number as delivered, with "at least" if any cell saturated |
| area, spacing, depth | so the run can be reproduced or widened |
| cost | so the next person can budget before asking |
| saturation, overlap, edges | the three completeness tests, with their arithmetic |
| verdict | what the number excludes |

## Why this improves the answers rather than just recording them

Repeated rows for the same area teach the spacing that works for that density,
which removes the guessing from the next sweep. Rows for different categories in
the same place expose how much the wording matters — the gap between a `صيدلية`
sweep and a `pharmacy` sweep over identical bounds is a measurement of the
index, not of the world, and it is worth knowing before quoting either.

When a row's verdict turns out to have been wrong, that belongs in
`references/tripwires.md` as a new entry, with what happened and the check that
would have caught it. That is how this stops being a log and starts being a
method.
