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

export {
  PLAYBOOK_COST,
  PLAYBOOK_COVERAGE,
  PLAYBOOK_RECIPES,
  PLAYBOOK_TRIPWIRES,
  SKILL_OVERVIEW,
} from "./playbook.generated.js";

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


