import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_SEARCH_DEPTH, UPSTREAM_PAGE_SIZE } from "../constants.js";
import { fitToLimit, guarded, ok, paginate, placeMarkdown } from "../services/format.js";
import { haversineKm, round } from "../services/geo.js";
import {
  countryParam,
  languageParam,
  LocationInputSchema,
  pickCountry,
  pickLang,
  resolveLocation,
  ResponseFormat,
  responseFormatParam,
  type ToolContext,
} from "../services/resolve.js";
import { PaginationFields, PlaceSchema, ResolvedLocationSchema } from "../services/schemas.js";
import type { Place } from "../types.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

type PlaceWithDistance = Place & { distance_km?: number };

export function registerSearchTools(server: McpServer, ctx: ToolContext): void {
  const SearchShape = {
    query: z
      .string()
      .min(1)
      .max(300)
      .describe('What to look for: a category ("pharmacy", "coffee shop"), a brand, or a place name. Arabic or English.'),
    near: LocationInputSchema.optional().describe(
      "Optional search center. Coordinates or a place name (geocoded first). Strongly recommended for category searches — without it results are country-wide.",
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_DEPTH)
      .default(UPSTREAM_PAGE_SIZE)
      .describe(
        `Max places to return (default ${UPSTREAM_PAGE_SIZE}). The search goes as deep as limit+offset needs, one upstream request per ${UPSTREAM_PAGE_SIZE} results, stopping early when the area runs out. Ask for what you need: depth costs calls and latency.`,
      ),
    offset: z.number().int().min(0).default(0).describe("Skip this many results (pagination). Counted within one call's result set."),
    sort_by_distance: z
      .boolean()
      .default(true)
      .describe("When `near` is given, sort results by straight-line distance from it and include distance_km. For road-time ranking, use geolink_find_nearest instead. Default true."),
    language: languageParam,
    country: countryParam,
    response_format: responseFormatParam,
  };
  const SearchInput = z.object(SearchShape);

  const OutputShape = {
    query: z.string(),
    center: ResolvedLocationSchema.optional(),
    ...PaginationFields,
    fetched: z.number().int().describe("How many places this call actually retrieved from the source."),
    source_exhausted: z
      .boolean()
      .describe("True when the source returned fewer places than were asked for — there are no more to find for this query and center."),
    places: z.array(PlaceSchema.extend({ distance_km: z.number().optional() })),
  };

  server.registerTool(
    "geolink_search_places",
    {
      title: "Search places",
      description: `Find places and points of interest by free-text query, optionally around a center point. Every result carries structured address parts (district, governorate, country) so you can filter or group without parsing strings.

Depth is what you ask for: the search pages the source until it has \`limit\` results or the area runs out, one upstream request per ${UPSTREAM_PAGE_SIZE}. \`source_exhausted\` tells you which of the two happened, so you never have to guess whether more exist.

Args:
  - query (string): Category, brand, or place name. "pharmacy", "كافيه", "Carrefour".
  - near (string | {lat,lng}, optional): Search center as "lat,lng" or a place name (geocoded, cached). Use it for anything local.
  - limit (1-${MAX_SEARCH_DEPTH}, default ${UPSTREAM_PAGE_SIZE}), offset (default 0): How many to return, and how many to skip.
  - sort_by_distance (bool, default true): With near, order by straight-line distance and add distance_km.
  - language, country: Defaults "en" / none.
  - response_format ('markdown' | 'json').

Returns (structuredContent):
  {
    "query": string,
    "center": { lat, lng, label, source } | undefined,
    "total": number, "count": number, "offset": number, "has_more": boolean, "next_offset"?: number,
    "fetched": number,             // places actually retrieved this call
    "source_exhausted": boolean,   // true = nothing more exists for this query/center
    "places": [ { name, address, address_parts: {district, governorate, country}, location: {lat, lng}, distance_km? } ]
  }

Examples:
  - "Pharmacies near Tahrir Square" -> query="pharmacy", near="Tahrir Square"
  - "Give me 60 cafés around here" -> query="cafe", near="30.0444,31.2357", limit=60
  - "Find Cairo Tower" -> query="Cairo Tower" (or use geolink_geocode for a single best match)
  - One center only. For a whole district/governorate use geolink_sweep_area, which tiles the area with many centers.

Errors: not_found when nothing matches; try a broader query or a different language.`,
      inputSchema: SearchShape,
      outputSchema: OutputShape,
      annotations: READ_ONLY,
    },
    guarded(async (raw: z.infer<typeof SearchInput>) => {
      const args = SearchInput.parse(raw);
      const lang = pickLang(ctx, args.language);
      const country = pickCountry(ctx, args.country);

      const center = args.near !== undefined ? await resolveLocation(ctx, args.near, lang, country) : undefined;
      // Fetch exactly the depth this page of results needs — the upstream
      // stops early on its own when the area has fewer places than asked for.
      const depth = Math.min(MAX_SEARCH_DEPTH, args.offset + args.limit);
      const found = await ctx.client.textSearch(args.query, center, lang, country, depth);

      let places: PlaceWithDistance[] = found;
      if (center) {
        places = found.map((p) => ({ ...p, distance_km: round(haversineKm(center, p.location), 3) }));
        if (args.sort_by_distance) {
          places.sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));
        }
      }

      const sliced = paginate(places, args.limit, args.offset);
      // The upstream stops early when it runs out, so a short response proves
      // the area is exhausted. A full one only proves we stopped asking —
      // more may exist behind a larger limit.
      const sourceExhausted = found.length < depth;
      const has_more = sliced.has_more || !sourceExhausted;
      const page = {
        ...sliced,
        has_more,
        ...(has_more ? { next_offset: args.offset + sliced.count } : {}),
        fetched: found.length,
        source_exhausted: sourceExhausted,
      };
      const title = center ? `Places: "${args.query}" near ${center.label}` : `Places: "${args.query}"`;

      const renderMarkdown = (items: PlaceWithDistance[]): string => {
        if (!items.length) return `# ${title}\n\n_No results._`;
        const blocks = items.map((p, i) => {
          const block = placeMarkdown(p, args.offset + i + 1);
          return p.distance_km === undefined ? block : `${block}\n   ↔ ${p.distance_km.toFixed(2)} km from center`;
        });
        const footer = page.has_more
          ? `\n_Showing ${page.count} of ${page.total} fetched — raise limit (or call with offset=${page.next_offset}) for more._`
          : `\n_${page.total} total — the area has no more matches._`;
        return [`# ${title}`, "", ...blocks, footer].join("\n");
      };

      const render = (items: PlaceWithDistance[]): string =>
        args.response_format === ResponseFormat.JSON
          ? JSON.stringify({ ...page, items: undefined, places: items }, null, 2)
          : renderMarkdown(items);

      const fitted = fitToLimit(page.items, render, `Use offset=${args.offset + 1} with a smaller limit to page through.`);

      const structured = {
        query: args.query,
        ...(center ? { center } : {}),
        ...page,
        items: undefined,
        places: fitted.items,
        ...(fitted.truncated ? { truncated: true, truncation_message: fitted.truncation_message } : {}),
      };
      delete (structured as { items?: unknown }).items;

      return ok(structured, fitted.text);
    }),
  );
}
