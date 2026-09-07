import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "geolink_coverage_report",
    {
      title: "Coverage report for a category in an area",
      description: "Plan and run a full-area sweep for a category (e.g. pharmacies in Giza), then summarize counts by district and flag gaps.",
      argsSchema: {
        category: z.string().describe('What to find, e.g. "pharmacy", "school", "كافيه"'),
        area: z.string().describe('Where, e.g. "Giza", "Nasr City", or "5 km around Tahrir Square"'),
      },
    },
    ({ category, area }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Produce a coverage report for "${category}" across "${area}" using the GeoLink tools.

Steps:
1. geolink_sweep_area with query="${category}", area={center: "${area}", radius_km: N}, and view="summary". This costs one call and answers "how many" and "which districts" without listing anything.
   Pick N yourself and say so: GeoLink has no boundary geometry, so "${area}" is a point plus a radius you chose. 20 km reaches most of a governorate's populated ground, 5 km covers a district. If "${area}" already names a radius, use that.
2. Read the completeness fields before you quote the number:
   - results_complete: false means the count is a floor. Raise pages_per_point (up to 15) and ask again before reporting anything.
   - area_fully_swept: false means ground was never visited. Pass continue_from back and merge what comes.
3. Report the count with whichever caveat applies, and the district and category breakdowns.
4. Only if I ask for the places themselves: re-run with view="places", response_format="json", and fields=["name","address_parts","location"] to keep it small. Page with offset — it is served from the same sweep and costs nothing.
5. Offer to export as GeoJSON.

Do not report a bare number. Either it is complete and you say so, or it is a floor and you say "at least".`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "geolink_nearest_branch",
    {
      title: "Pick the best branch for a customer",
      description: "Rank a list of branches/warehouses by real road travel time from a customer location and recommend one.",
      argsSchema: {
        customer_location: z.string().describe('Customer address or "lat,lng"'),
        branches: z.string().describe('Semicolon-separated branch names or "lat,lng" pairs'),
      },
    },
    ({ customer_location, branches }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `A customer is at "${customer_location}". Our branches are: ${branches}.

Use geolink_find_nearest with origin=the customer and candidates=the branch list (split on ";"). Rank by duration. Then:
- Recommend the best branch with its travel time and distance.
- Mention the runner-up and how much slower it is.
- Compare each result's straight_line_km against its road distance. If the branch that looks nearest on a map is not the one that is nearest to drive to, say so plainly — that is the whole reason to run this rather than measure on a map, and it happens about a fifth of the time.
- If any result carries unreliable_pairing, do not rank it. Re-check that one pair with geolink_get_directions and say why.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "geolink_coverage_audit",
    {
      title: "Audit whether a sweep actually covered the area",
      description: "Count a category across an area and then establish whether the count is a total or a floor, rather than reporting it as if it were known.",
      argsSchema: {
        category: z.string().describe('What was counted, e.g. "pharmacy", "school"'),
        area: z.string().describe('The area that was covered, e.g. "Nasr City", "Giza"'),
      },
    },
    ({ category, area }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Count "${category}" across "${area}", then establish whether that count is a total or a floor. Do not report the number until you know which.

1. Read geolink://playbook/coverage first.
2. geolink_sweep_area, area={center:"${area}", radius_km: N}, view="summary". State the N — it is your choice, not the area's, and the claim you end up making is "within N km of ${area}".
3. Two things can be short, they fail independently, and they are fixed by different parameters:
   - results_complete: false — the vantage points were read too shallow. The source had more at the points that were visited. Re-run with pages_per_point=15.
   - area_fully_swept: false — the sweep ran out of time with ground unvisited. Re-run passing continue_from, and add what comes back.
   Keep going until both are satisfied, or until you can say exactly which one you could not satisfy and why.
4. Then check the edges, which neither field can see from inside a sweep: reverse-geocode the four corners and the centre of the area. Any district that turns up there but is absent from by_district is ground the sweep never reached — the area's own bounds may be tighter than the name suggests.
5. Report the count as one of exactly these:
   - "N" — both fields say complete and the edges check out.
   - "at least N" — anything else. Name which check failed and what you did about it.

A number without one of those two labels is not an answer to this question.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "geolink_service_gap",
    {
      title: "Find underserved ground",
      description: "Compare where a service already exists against where demand sits, and rank the districts that have demand without supply.",
      argsSchema: {
        service: z.string().describe('The service to place, e.g. "pharmacy", "branch", "clinic"'),
        demand_proxy: z.string().describe('What stands in for demand, e.g. "school", "mosque", "supermarket"'),
        area: z.string().describe('Where to look, e.g. "Giza", "Tanta"'),
      },
    },
    ({ service, demand_proxy, area }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Find where a new "${service}" would serve people who are currently far from one, across "${area}".

1. geolink_sweep_area for "${service}" over {center:"${area}", radius_km: N} with view="summary".
2. geolink_sweep_area for "${demand_proxy}" over the same area, with the same parameters, so the two counts are comparable. Two sweeps with different depth or different ground are not a ratio, they are two unrelated numbers.
3. Check results_complete and area_fully_swept on both. If one is a floor and the other is not, the ratio between them is meaningless — fix that before comparing.
4. Compare by_district between them. Rank districts by demand count divided by supply count; a district with demand and no supply ranks highest.
5. For the top two districts, take the centre and run geolink_find_nearest with search_query="${service}" to measure how far the nearest existing one actually is by road. Straight-line distance is the wrong measure for "far from a pharmacy"; a river or a ring road is what makes somewhere underserved.
6. Recommend one district. Give its demand count, its supply count, and the drive time to the nearest existing "${service}" — that drive time is the argument.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "geolink_route_brief",
    {
      title: "Route brief between two places",
      description: "Summarize the primary route and alternatives between two locations, with a map-ready polyline.",
      argsSchema: {
        origin: z.string().describe('Start: place name or "lat,lng"'),
        destination: z.string().describe('End: place name or "lat,lng"'),
      },
    },
    ({ origin, destination }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Give me a route brief from "${origin}" to "${destination}".

Call geolink_get_directions with route_detail="polyline" and max_alternatives=3. Report the primary route's distance and time, how the alternatives compare, the detour ratio (road distance ÷ straight_line_km), and include the primary route's polyline string for mapping.`,
          },
        },
      ],
    }),
  );
}
