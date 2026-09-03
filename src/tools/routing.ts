import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_SEARCH_DEPTH, UPSTREAM_PAGE_SIZE } from "../constants.js";
import { GeoLinkError } from "../services/client.js";
import { cellText, fitToLimit, guarded, ok, routeMarkdown } from "../services/format.js";
import { encodePolyline, formatLatLng, haversineKm, round, samplePoints } from "../services/geo.js";
import {
  countryParam,
  languageParam,
  LocationInputSchema,
  pickCountry,
  pickLang,
  resolveLocation,
  resolveMany,
  ResponseFormat,
  responseFormatParam,
  toLatLng,
  type ToolContext,
} from "../services/resolve.js";
import { BoundsSchema } from "../services/resolve.js";
import { MatrixCellSchema, PlaceSchema, ResolvedLocationSchema, RouteEndpointSchema } from "../services/schemas.js";
import type { MatrixCell, Place, ResolvedLocation, Route } from "../types.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerRoutingTools(server: McpServer, ctx: ToolContext): void {
  /* ---------------------------------------------------------------- */
  /* geolink_get_directions                                             */
  /* ---------------------------------------------------------------- */
  const RouteDetail = z.enum(["summary", "polyline", "waypoints"]);

  const DirectionsShape = {
    origin: LocationInputSchema,
    destination: LocationInputSchema,
    route_detail: RouteDetail.default("summary").describe(
      "How much geometry to return per route. 'summary' = distance/duration/endpoints/bounds only (cheapest, default). 'polyline' = summary + Google-encoded polyline string (compact, map-ready). 'waypoints' = summary + raw [lat,lng] path sampled to max_waypoints (most expensive).",
    ),
    max_alternatives: z.number().int().min(1).max(10).default(3).describe("Max route alternatives to return (default 3). Route 1 is GeoLink's primary."),
    max_waypoints: z
      .number()
      .int()
      .min(2)
      .max(2000)
      .default(200)
      .describe("Only for route_detail='waypoints': evenly sample the path to at most this many points (default 200)."),
    language: languageParam,
    country: countryParam,
    response_format: responseFormatParam,
  };
  const DirectionsInput = z.object(DirectionsShape);

  const RouteOut = z.object({
    index: z.number().int(),
    distance_meters: z.number(),
    distance_text: z.string(),
    duration_seconds: z.number(),
    duration_text: z.string(),
    bounds: BoundsSchema.nullable(),
    origin: RouteEndpointSchema,
    destination: RouteEndpointSchema,
    waypoint_count: z.number().int(),
    polyline: z.string().optional(),
    waypoints: z.array(z.tuple([z.number(), z.number()])).optional(),
    waypoints_sampled: z.boolean().optional(),
  });

  const DirectionsOutput = {
    origin: ResolvedLocationSchema,
    destination: ResolvedLocationSchema,
    straight_line_km: z.number(),
    route_detail: RouteDetail,
    route_count: z.number().int(),
    routes: z.array(RouteOut),
  };

  server.registerTool(
    "geolink_get_directions",
    {
      title: "Get directions",
      description: `Driving directions between two locations with multiple route alternatives. Origin and destination accept coordinates OR place names (names are geocoded automatically, one cached call each).

Geometry is opt-in to keep responses small — start with the default 'summary' and only ask for 'polyline' or 'waypoints' when you actually need the path (e.g. to draw a map).

Args:
  - origin, destination (string | {lat,lng}): "30.0444,31.2357", {lat,lng}, or "Cairo Tower".
  - route_detail ('summary' | 'polyline' | 'waypoints', default 'summary').
  - max_alternatives (1-10, default 3).
  - max_waypoints (2-2000, default 200): sampling cap for 'waypoints' mode.
  - language, country: Defaults "en" / none.
  - response_format ('markdown' | 'json').

Returns (structuredContent):
  {
    "origin": {lat, lng, input, label, source}, "destination": {...},
    "straight_line_km": number,                 // haversine, for sanity-checking detours
    "route_count": number,
    "routes": [ {
        "index": 1, "distance_meters", "distance_text", "duration_seconds", "duration_text",
        "bounds": {northeast, southwest} | null,
        "origin": {lat, lng, name, address}, "destination": {...},
        "waypoint_count": number,               // size of the full path on the server
        "polyline"?: string,                    // route_detail='polyline' — Google encoded, precision 5
        "waypoints"?: [[lat,lng], ...],         // route_detail='waypoints'
        "waypoints_sampled"?: boolean           // true if the path was thinned to max_waypoints
    } ]
  }

Examples:
  - "How long from Tahrir Square to Cairo Airport?" -> origin="Tahrir Square", destination="Cairo International Airport"
  - "Draw the route" -> same, route_detail="polyline"
  - For many origins/destinations at once use geolink_distance_matrix, not repeated calls here.`,
      inputSchema: DirectionsShape,
      outputSchema: DirectionsOutput,
      annotations: READ_ONLY,
    },
    guarded(async (raw: z.infer<typeof DirectionsInput>) => {
      const args = DirectionsInput.parse(raw);
      const lang = pickLang(ctx, args.language);
      const country = pickCountry(ctx, args.country);

      const origin = await resolveLocation(ctx, args.origin, lang, country);
      const destination = await resolveLocation(ctx, args.destination, lang, country);
      const routes = await ctx.client.directions(toLatLng(origin), toLatLng(destination), lang, country);

      if (!routes.length) {
        throw new GeoLinkError(
          `No route found between ${origin.label} and ${destination.label}`,
          "not_found",
          "Check both points are reachable by road and inside the routing country; try swapping to explicit coordinates.",
        );
      }

      const kept = routes.slice(0, args.max_alternatives);
      const shaped = kept.map((r: Route, i) => {
        const base = {
          index: i + 1,
          distance_meters: r.distance_meters,
          distance_text: r.distance_text,
          duration_seconds: r.duration_seconds,
          duration_text: r.duration_text,
          bounds: r.bounds,
          origin: r.origin,
          destination: r.destination,
          waypoint_count: r.waypoints.length,
        };
        if (args.route_detail === "polyline") return { ...base, polyline: encodePolyline(r.waypoints) };
        if (args.route_detail === "waypoints") {
          const sampled = samplePoints(r.waypoints, args.max_waypoints);
          return { ...base, waypoints: sampled, waypoints_sampled: sampled.length < r.waypoints.length };
        }
        return base;
      });

      const structured = {
        origin,
        destination,
        straight_line_km: round(haversineKm(origin, destination), 3),
        route_detail: args.route_detail,
        route_count: shaped.length,
        routes: shaped,
      };

      const render = (items: typeof shaped): string => {
        if (args.response_format === ResponseFormat.JSON) {
          return JSON.stringify({ ...structured, routes: items }, null, 2);
        }
        const head = [
          `# Directions: ${origin.label} → ${destination.label}`,
          `_Straight line: ${structured.straight_line_km} km · ${routes.length} route(s) available, showing ${items.length}_`,
          "",
        ];
        const bodies = items.map((r) => {
          let extra = `- **Path points**: ${r.waypoint_count}`;
          if ("polyline" in r && r.polyline) extra += `\n- **Polyline**: \`${r.polyline}\``;
          if ("waypoints" in r && r.waypoints) {
            extra += `\n- **Waypoints** (${r.waypoints.length}${r.waypoints_sampled ? ", sampled" : ""}): ${JSON.stringify(r.waypoints)}`;
          }
          return routeMarkdown(r, r.index, extra);
        });
        return [...head, ...bodies].join("\n\n");
      };

      const fitted = fitToLimit(shaped, render, "Lower max_alternatives / max_waypoints, or use route_detail='summary'.");
      return ok(
        { ...structured, routes: fitted.items, route_count: fitted.items.length, ...(fitted.truncated ? { truncated: true, truncation_message: fitted.truncation_message } : {}) },
        fitted.text,
      );
    }),
  );

  /* ---------------------------------------------------------------- */
  /* geolink_distance_matrix                                            */
  /* ---------------------------------------------------------------- */
  const MatrixShape = {
    origins: z.array(LocationInputSchema).min(1).max(50).describe("1-50 origins (coordinates or place names)."),
    destinations: z.array(LocationInputSchema).min(1).max(50).describe("1-50 destinations (coordinates or place names)."),
    nearest_only: z
      .boolean()
      .default(false)
      .describe("Return only each origin's nearest destination instead of the full grid. Cuts output from O(N×M) to O(N). Default false."),
    language: languageParam,
    country: countryParam,
    response_format: responseFormatParam,
  };
  const MatrixInput = z.object(MatrixShape);

  const MatrixOutput = {
    origins: z.array(ResolvedLocationSchema),
    destinations: z.array(ResolvedLocationSchema),
    cells: z.number().int(),
    nearest_only: z.boolean(),
    nearest: z.array(
      z.object({
        origin_index: z.number().int(),
        origin_label: z.string(),
        destination_index: z.number().int(),
        destination_label: z.string(),
        distance_meters: z.number(),
        distance_text: z.string(),
        duration_seconds: z.number(),
        duration_text: z.string(),
      }),
    ),
    matrix: z.array(z.array(MatrixCellSchema)).optional(),
  };

  server.registerTool(
    "geolink_distance_matrix",
    {
      title: "Distance matrix",
      description: `Travel distance and duration for every origin × destination pair in ONE API call, plus GeoLink's precomputed nearest destination per origin. Inputs accept coordinates or place names.

Guard rail: origins × destinations must be ≤ ${ctx.cfg.maxMatrixCells} cells (configurable via GEOLINK_MAX_MATRIX_CELLS). Larger jobs should be batched.

Args:
  - origins, destinations (array of string | {lat,lng}): 1-50 each.
  - nearest_only (bool, default false): Skip the full grid; return just the nearest destination per origin.
  - language, country: Defaults "en" / none.
  - response_format ('markdown' | 'json').

Returns (structuredContent):
  {
    "origins": [{lat,lng,input,label,source}], "destinations": [...],
    "cells": number,
    "nearest": [ { origin_index, origin_label, destination_index, destination_label,
                   distance_meters, distance_text, duration_seconds, duration_text } ],
    "matrix"?: [ [ {distance_meters, distance_text, duration_seconds, duration_text} ] ]   // [origin][destination], omitted when nearest_only
  }

Examples:
  - "Which warehouse is closest to each of these 5 customers?" -> origins=customers, destinations=warehouses, nearest_only=true
  - "Travel-time grid between our 4 branches" -> origins=destinations=branches
  - For one origin against candidates found by search, prefer geolink_find_nearest.`,
      inputSchema: MatrixShape,
      outputSchema: MatrixOutput,
      annotations: READ_ONLY,
    },
    guarded(async (raw: z.infer<typeof MatrixInput>) => {
      const args = MatrixInput.parse(raw);
      const cells = args.origins.length * args.destinations.length;
      if (cells > ctx.cfg.maxMatrixCells) {
        throw new GeoLinkError(
          `Matrix too large: ${args.origins.length} × ${args.destinations.length} = ${cells} cells (limit ${ctx.cfg.maxMatrixCells})`,
          "bad_request",
          `Split into batches with ≤ ${ctx.cfg.maxMatrixCells} cells each (e.g. ${Math.max(1, Math.floor(ctx.cfg.maxMatrixCells / args.destinations.length))} origins per call), or raise GEOLINK_MAX_MATRIX_CELLS.`,
        );
      }
      const lang = pickLang(ctx, args.language);
      const country = pickCountry(ctx, args.country);

      const origins = await resolveMany(ctx, args.origins, lang, country);
      const destinations = await resolveMany(ctx, args.destinations, lang, country);
      const result = await ctx.client.distanceMatrix(origins.map(toLatLng), destinations.map(toLatLng), lang, country);

      const nearest = buildNearest(result.matrix, result.nearest_destination_index, origins, destinations);

      const structured = {
        origins,
        destinations,
        cells,
        nearest_only: args.nearest_only,
        nearest,
        ...(args.nearest_only ? {} : { matrix: result.matrix }),
      };

      let text: string;
      if (args.response_format === ResponseFormat.JSON) {
        text = JSON.stringify(structured, null, 2);
      } else {
        const lines = [`# Distance matrix: ${origins.length} origin(s) × ${destinations.length} destination(s)`, ""];
        lines.push("## Nearest destination per origin");
        for (const n of nearest) {
          lines.push(`- **${n.origin_label}** → **${n.destination_label}**: ${n.distance_text || `${n.distance_meters} m`} / ${n.duration_text || `${n.duration_seconds} s`}`);
        }
        if (!args.nearest_only) {
          lines.push("", "## Full grid (distance / duration)", "");
          const header = ["origin \\ destination", ...destinations.map((d, j) => `D${j + 1}: ${d.label}`)];
          lines.push(`| ${header.join(" | ")} |`);
          lines.push(`| ${header.map(() => "---").join(" | ")} |`);
          result.matrix.forEach((row, i) => {
            const o = origins[i];
            lines.push(`| O${i + 1}: ${o?.label ?? formatLatLng(result.origins[i] ?? { lat: 0, lng: 0 })} | ${row.map(cellText).join(" | ")} |`);
          });
        }
        text = lines.join("\n");
      }

      if (text.length > 25_000 && !args.nearest_only) {
        text = `${text.slice(0, 24_000)}\n\n_Output truncated. Call again with nearest_only=true or response_format='json' with fewer destinations._`;
      }
      return ok(structured, text);
    }),
  );

  /* ---------------------------------------------------------------- */
  /* geolink_find_nearest                                               */
  /* ---------------------------------------------------------------- */
  const RankBy = z.enum(["duration", "distance"]);

  const NearestShape = {
    origin: LocationInputSchema.describe("The reference point (customer, driver, user)."),
    candidates: z
      .array(LocationInputSchema)
      .min(1)
      .max(50)
      .optional()
      .describe("Known candidate locations to rank (branches, warehouses, drivers). Coordinates or names. Provide this OR search_query."),
    search_query: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe('Discover candidates by searching near the origin, e.g. "pharmacy", "ATM", "مستشفى". Provide this OR candidates.'),
    candidate_limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("With search_query: how many search hits (closest by straight line) to route against. Default 10. The search itself goes deeper than this so the pre-filter has a real pool to choose from."),
    rank_by: RankBy.default("duration").describe("Rank by travel 'duration' (default) or road 'distance'."),
    limit: z.number().int().min(1).max(50).default(5).describe("How many ranked results to return (default 5)."),
    language: languageParam,
    country: countryParam,
    response_format: responseFormatParam,
  };
  const NearestInput = z.object(NearestShape);

  const RankedSchema = z.object({
    rank: z.number().int(),
    candidate_index: z.number().int(),
    label: z.string(),
    location: z.object({ lat: z.number(), lng: z.number() }),
    place: PlaceSchema.optional(),
    straight_line_km: z.number(),
    distance_meters: z.number(),
    distance_text: z.string(),
    duration_seconds: z.number(),
    duration_text: z.string(),
    is_geolink_nearest: z.boolean(),
  });

  const NearestOutput = {
    origin: ResolvedLocationSchema,
    source: z.enum(["candidates", "search"]),
    search_query: z.string().optional(),
    rank_by: RankBy,
    candidates_evaluated: z.number().int(),
    results: z.array(RankedSchema),
  };

  server.registerTool(
    "geolink_find_nearest",
    {
      title: "Find nearest by travel time",
      description: `Rank candidate locations by real road travel time (or distance) from one origin. Two modes:
  1. candidates: you already know the options (branches, warehouses, drivers) — they get routed in one matrix call.
  2. search_query: discover options near the origin via place search, keep the closest candidate_limit by straight line, then route them.

This is the "which branch should serve this customer / which pharmacy is really closest" tool. Straight-line nearest is often wrong in Cairo; this uses road time.

Args:
  - origin (string | {lat,lng}).
  - candidates (array, 1-50) OR search_query (string) — exactly one.
  - candidate_limit (1-25, default 10): search mode only.
  - rank_by ('duration' | 'distance', default 'duration').
  - limit (1-50, default 5).
  - language, country, response_format.

Returns (structuredContent):
  {
    "origin": {lat,lng,input,label,source}, "source": "candidates" | "search", "rank_by", "candidates_evaluated",
    "results": [ { rank, candidate_index, label, location: {lat,lng}, place?: Place,
                   straight_line_km, distance_meters, distance_text, duration_seconds, duration_text,
                   is_geolink_nearest } ]   // is_geolink_nearest = matches GeoLink's own nearest_destination_index
  }

Examples:
  - "Nearest of our 8 branches to this customer" -> origin=customer, candidates=[8 branches]
  - "Closest hospital by driving time to 30.05,31.23" -> origin="30.05,31.23", search_query="hospital"
  - API cost: 1 matrix call (+1 search call in search mode, + cached geocodes for any names).`,
      inputSchema: NearestShape,
      outputSchema: NearestOutput,
      annotations: READ_ONLY,
    },
    guarded(async (raw: z.infer<typeof NearestInput>) => {
      const args = NearestInput.parse(raw);
      const hasCandidates = args.candidates !== undefined && args.candidates.length > 0;
      const hasQuery = args.search_query !== undefined && args.search_query.trim().length > 0;
      if (hasCandidates === hasQuery) {
        throw new GeoLinkError(
          "Provide exactly one of candidates or search_query",
          "bad_request",
          "Pass candidates=[...] when you already know the options, or search_query=\"...\" to discover them near the origin.",
        );
      }
      const lang = pickLang(ctx, args.language);
      const country = pickCountry(ctx, args.country);
      const origin = await resolveLocation(ctx, args.origin, lang, country);

      // Guard before spending: geocoding candidates and searching both cost
      // upstream calls, so refuse an over-sized job before paying for it.
      const plannedCells = hasCandidates ? (args.candidates?.length ?? 0) : args.candidate_limit;
      if (plannedCells > ctx.cfg.maxMatrixCells) {
        throw new GeoLinkError(
          `Too many candidates (${plannedCells}); limit is ${ctx.cfg.maxMatrixCells}`,
          "bad_request",
          "Lower candidate_limit / pass fewer candidates, or raise GEOLINK_MAX_MATRIX_CELLS.",
        );
      }

      let candidates: ResolvedLocation[];
      let places: (Place | undefined)[];
      if (hasCandidates) {
        candidates = await resolveMany(ctx, args.candidates ?? [], lang, country);
        places = candidates.map(() => undefined);
      } else {
        // Search deeper than candidate_limit: the closest N by road time are
        // not always the closest N by straight line, so give the pre-filter a
        // wider pool to choose from.
        const searchDepth = Math.min(MAX_SEARCH_DEPTH, Math.max(UPSTREAM_PAGE_SIZE, args.candidate_limit * 2));
        const found = await ctx.client.textSearch(args.search_query ?? "", toLatLng(origin), lang, country, searchDepth);
        if (!found.length) {
          throw new GeoLinkError(
            `No places found for "${args.search_query}" near ${origin.label}`,
            "not_found",
            "Try a broader query or the other language (ar/en).",
          );
        }
        const closest = [...found]
          .sort((a, b) => haversineKm(origin, a.location) - haversineKm(origin, b.location))
          .slice(0, args.candidate_limit);
        candidates = closest.map((p) => ({
          ...p.location,
          input: p.name,
          label: p.name || p.address,
          source: "geocode" as const,
        }));
        places = closest;
      }

      const result = await ctx.client.distanceMatrix([toLatLng(origin)], candidates.map(toLatLng), lang, country);
      const row: MatrixCell[] = result.matrix[0] ?? [];
      const geolinkNearest = result.nearest_destination_index[0] ?? -1;

      const ranked = candidates
        .map((c, i) => {
          const cell = row[i] ?? { distance_meters: 0, distance_text: "", duration_seconds: 0, duration_text: "" };
          const place = places[i];
          return {
            candidate_index: i,
            label: c.label,
            location: toLatLng(c),
            ...(place ? { place } : {}),
            straight_line_km: round(haversineKm(origin, c), 3),
            ...cell,
            is_geolink_nearest: i === geolinkNearest,
          };
        })
        .filter((r) => r.duration_seconds > 0 || r.distance_meters > 0)
        .sort((a, b) =>
          args.rank_by === "duration"
            ? a.duration_seconds - b.duration_seconds
            : a.distance_meters - b.distance_meters,
        )
        .slice(0, args.limit)
        .map((r, i) => ({ rank: i + 1, ...r }));

      const structured = {
        origin,
        source: hasCandidates ? ("candidates" as const) : ("search" as const),
        ...(hasQuery ? { search_query: args.search_query ?? "" } : {}),
        rank_by: args.rank_by,
        candidates_evaluated: candidates.length,
        results: ranked,
      };

      const text =
        args.response_format === ResponseFormat.JSON
          ? JSON.stringify(structured, null, 2)
          : [
              `# Nearest to ${origin.label} (by ${args.rank_by})`,
              `_${candidates.length} candidate(s) evaluated${hasQuery ? ` from search "${args.search_query}"` : ""}_`,
              "",
              ...ranked.map(
                (r) =>
                  `${r.rank}. **${r.label}** — ${r.distance_text || `${r.distance_meters} m`} / ${r.duration_text || `${r.duration_seconds} s`} (straight line ${r.straight_line_km} km)${r.is_geolink_nearest ? " ⭐" : ""}\n   📍 ${formatLatLng(r.location)}${r.place?.address_parts.district ? ` · ${r.place.address_parts.district}, ${r.place.address_parts.governorate}` : ""}`,
              ),
              "",
              "_⭐ = GeoLink's own nearest_destination_index_",
            ].join("\n");

      return ok(structured, text);
    }),
  );
}

function buildNearest(
  matrix: MatrixCell[][],
  nearestIdx: number[],
  origins: ResolvedLocation[],
  destinations: ResolvedLocation[],
): {
  origin_index: number;
  origin_label: string;
  destination_index: number;
  destination_label: string;
  distance_meters: number;
  distance_text: string;
  duration_seconds: number;
  duration_text: string;
}[] {
  return matrix.map((row, i) => {
    const j = nearestIdx[i] ?? -1;
    const cell = (j >= 0 ? row[j] : undefined) ?? { distance_meters: 0, distance_text: "", duration_seconds: 0, duration_text: "" };
    return {
      origin_index: i,
      origin_label: origins[i]?.label ?? `origin ${i + 1}`,
      destination_index: j,
      destination_label: j >= 0 ? (destinations[j]?.label ?? `destination ${j + 1}`) : "(none)",
      ...cell,
    };
  });
}
