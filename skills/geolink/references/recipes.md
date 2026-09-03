# Compositions

Each of these answers a question no single tool answers, using only what is
already here.

## Reachable area — approximate isochrone

### "Where can a driver get to in 20 minutes?"

1. Take bearings every 30° around the origin at a few trial radii
   (2, 5, 10 km) and turn each into a coordinate.
1. `geolink_distance_matrix` with the origin against all of them — one call,
   whatever the count, as long as it stays inside the cell limit.
1. Keep the points whose `duration_seconds` is at or under the budget. Their
   outline is the reachable shape, and it is rarely a circle: a river or a
   single bridge distorts it heavily, which is the entire point of computing it
   instead of drawing a radius.

## Territory assignment

### "Which branch should own which customer?"

`geolink_distance_matrix` with customers as origins and branches as
destinations, `nearest_only: true`. One call returns the assignment. Grouping
the result by `address_parts.district` turns it into a territory map without
another request.

Watch for customers whose nearest branch by road is not the nearest by straight
line — those are the accounts a human would have assigned wrong.

## Underserved ground — site selection

### "Where should the next branch go?"

1. Sweep the category you compete with across the region.
1. Sweep a demand proxy across the same region with identical bounds and
   spacing — schools, mosques, markets, whatever generates footfall for the
   business.
1. Compare `stats.by_district` between the two. A district high in demand and
   low in supply is a candidate.
1. Confirm with `geolink_find_nearest` from the candidate district's centre:
   if the closest existing competitor is a long drive, the gap is real.

## What is on the way

### "Is there a pharmacy on my route?"

1. `geolink_get_directions` with `route_detail: "waypoints"` and a modest
   `max_waypoints`.
1. Sample the path every few kilometres.
1. `geolink_search_places` at each sample with a small `limit`.
1. Confirm the candidates with `geolink_distance_matrix` from the origin —
   a place 200 m from the line can still be a ten-minute detour.

## Confidence in a single address

### "Did the geocoder understand me?"

`geolink_geocode` always returns one answer, and one answer never looks
uncertain. To test it:

- Reverse-geocode the coordinates it returned. If the district that comes back
  disagrees with the district in the original result, the match is weak.
- Run `geolink_search_places` with the same string. If the top candidates are
  scattered across kilometres, the name is ambiguous and the right move is to
  ask which one was meant rather than to pick.
- Compare the geocoded point against the bounds it came with. A point sitting
  at the very edge of its own viewport is usually a fallback to something
  larger — a city centroid standing in for a street it did not find.

## Delivery reality check

### "Is this address deliverable?"

Reverse-geocode the coordinates the customer gave, then compare the returned
district with the one they typed. Mismatches are the addresses that fail on the
road. Ordering a day's stops by `geolink_distance_matrix` between them turns
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
