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
1. Call geolink_sweep_area with dry_run=true, query="${category}", and the area (use {place: "${area}"} unless the area describes a radius, in which case use {center, radius_km}). Start with grid_spacing_km=3.
2. Read plan.estimated_api_calls. If it is over ~120, raise grid_spacing_km until it is reasonable; if under ~15 and the area is urban, consider 2 km. Tell me the final plan and call count before running.
3. Run the sweep for real with response_format="json" and fields=["name","address_parts","location"].
4. Summarize: total unique places, counts per district (stats.by_district), the densest and sparsest districts, and any districts with zero results that likely should have some.
5. Offer to export the full set as GeoJSON.`,
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
- If the straight-line nearest differs from the road-time nearest, point that out explicitly.`,
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
