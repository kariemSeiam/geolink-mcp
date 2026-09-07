import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UPSTREAM_PAGE_SIZE } from "../constants.js";
import { GeoLinkError } from "../services/client.js";
import { cellText, fitToLimit, guarded, ok, routeMarkdown } from "../services/format.js";
import { encodePolyline, formatLatLng, haversineKm, impliedSpeedKmh, parseLatLng, PLAUSIBLE_SPEED_KMH, round, samplePoints } from "../services/geo.js";
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
import { normalizeXPlaces } from "../services/normalize.js";
import { MatrixCellSchema, PlaceSchema, ResolvedLocationSchema, RouteEndpointSchema, XNearSchema, XPlaceSchema } from "../services/schemas.js";
import type { LatLng, MatrixCell, Place, ResolvedLocation, Route, XTravel } from "../types.js";

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
    coverage: z
      .object({
        requested: z.number().int(),
        attempted: z.number().int(),
        measured: z.number().int(),
        complete: z.boolean(),
      })
      .optional()
      .describe(
        "How much of the grid was actually measured. When complete is false, " +
        "cells that were never reached read as zero — the same four zeros as " +
        "two points with no distance between them. Ask for a smaller grid to " +
        "get all of it.",
      ),
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

      // A matrix too large for the API's time budget comes back as a normal
      // 200 with the cells it reached and the rest as zeros. Passing that on
      // without saying so would hand the model a grid where "no route" and
      // "we ran out of time" are the same four zeros.
      const partial = result.coverage && !result.coverage.complete;

      const structured = {
        origins,
        destinations,
        cells,
        nearest_only: args.nearest_only,
        nearest,
        ...(result.coverage ? { coverage: result.coverage } : {}),
        ...(args.nearest_only ? {} : { matrix: result.matrix }),
      };

      let text: string;
      if (args.response_format === ResponseFormat.JSON) {
        text = JSON.stringify(structured, null, 2);
      } else {
        const lines = [`# Distance matrix: ${origins.length} origin(s) × ${destinations.length} destination(s)`, ""];
        if (partial && result.coverage) {
          const { measured, requested } = result.coverage;
          lines.push(
            `> **Partial.** ${measured} of ${requested} cells were measured before the ` +
            `request ran out of time; the rest read as zero because they were never ` +
            `reached, not because the places are close. Ask for fewer origins or ` +
            `destinations to get a complete grid.`,
            "",
          );
        }
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
  /**
   * Which of these is actually closest.
   *
   * Not a nicer number for the same answer. Measured across eighteen origins,
   * the nearest place by road was a *different place* than the nearest by
   * straight line 22% of the time, and road distance ran 1.6x the line at the
   * median. A live call while this was being written: three pharmacies at 503,
   * 1304 and 1983 metres by line come back 503, 1983, 1304 by road - the
   * second-closest on the map is third to drive to.
   *
   * Two modes, because the question comes in two shapes and only one of them
   * fits a single endpoint. When the options are already known - eight
   * branches, four warehouses - they have to be routed as a matrix, and the
   * care in that path is about pairing a cell back to the place it belongs to.
   * When the options have to be found first, x/nearest does the whole thing in
   * one call and pairs them itself.
   */
  const RankBy = z.enum(["duration", "distance"]);

  const NearestShape = {
    origin: LocationInputSchema.describe("The reference point: a customer, a driver, a user."),
    candidates: z
      .array(LocationInputSchema)
      .min(1)
      .max(50)
      .optional()
      .describe("Options you already know — branches, warehouses, drivers. Coordinates or names. Give this OR search_query."),
    search_query: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe('Find the options near the origin instead: "pharmacy", "ATM", "مستشفى". Give this OR candidates.'),
    candidate_limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        "With search_query: how many nearby places to measure by road before ranking (default 10). A larger shortlist costs more and finds winners a smaller one would have missed — the nearest by road is often not among the three nearest by line.",
      ),
    rank_by: RankBy.default("duration").describe("Rank by travel 'duration' (default) or road 'distance'. They disagree more often than they agree in traffic."),
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
    x_place: XPlaceSchema.partial().optional(),
    straight_line_km: z.number(),
    implied_speed_kmh: z.number().optional(),
    unreliable_pairing: z.boolean().optional(),
    distance_meters: z.number(),
    distance_text: z.string(),
    duration_seconds: z.number(),
    duration_text: z.string(),
    is_geolink_nearest: z.boolean().optional(),
  });

  const NearestOutput = {
    origin: ResolvedLocationSchema,
    source: z.enum(["candidates", "search"]),
    search_query: z.string().optional(),
    resolved_to: XNearSchema.nullable().optional(),
    rank_by: RankBy,
    candidates_evaluated: z.number().int(),
    results_complete: z
      .boolean()
      .optional()
      .describe(
        "Search mode only. False means the shortlist itself was cut short, so the winner was picked from fewer candidates than were available — and a winner from half the field is a different winner. Raise candidate_limit.",
      ),
    results: z.array(RankedSchema),
    warning: z.string().optional(),
  };

  server.registerTool(
    "geolink_find_nearest",
    {
      title: "Find nearest by road",
      description: `Rank options by real road travel time or distance from one origin. This is the "which branch should serve this customer" and "which pharmacy is actually closest" tool.

Straight-line nearest is a different answer, not a rougher one. Measured across 18 origins, the nearest by road was a different place than the nearest by line 22% of the time, and the road ran 1.6x the line at the median. In a city with a river, a ring road and one-way streets, the map lies.

Two modes:
  - **candidates**: you already know the options. They are routed together in one matrix call, and each result's travel time is paired back to its place by coordinate rather than by position — because nothing guarantees the upstream echoes them in the order they were sent, and trusting position hands one branch's drive time to another.
  - **search_query**: the options have to be found first. One call finds the nearby places, measures each by road, and ranks them. Places with no route are left out rather than guessed at.

Ranking by duration and by distance disagree often; pick the one that matches the decision. candidate_limit is the real cost and quality knob in search mode: the nearest by road is frequently not among the three nearest by line, so a shortlist of 10 finds winners a shortlist of 3 would have missed.

Args:
  - origin (string | {lat,lng}).
  - candidates (array, 1-50) OR search_query (string) — exactly one.
  - candidate_limit (1-50, default 10): search mode only.
  - rank_by ('duration' | 'distance', default 'duration').
  - limit (1-50, default 5).
  - language, country, response_format.

Examples:
  - "Nearest of our 8 branches to this customer" → origin=customer, candidates=[8 branches]
  - "Closest hospital by driving time to 30.05,31.23" → origin="30.05,31.23", search_query="hospital"
  - "Is the closest pharmacy on the map really the closest to drive to?" → search_query="pharmacy", and compare straight_line_km against the ranking.`,
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
          'Pass candidates=[...] when you already know the options, or search_query="..." to find them near the origin.',
        );
      }
      const lang = pickLang(ctx, args.language);
      const country = pickCountry(ctx, args.country);

      /* ---------- Find them, then measure by road: one call ---------- */
      if (hasQuery) {
        // The origin goes over as a name when it is one. The API resolves it,
        // measures every candidate by road and ranks them, and reports what the
        // name turned out to be - so nothing here has to geocode first, and
        // nothing has to pair a travel time back to a place afterwards.
        let near: string | undefined;
        let center: LatLng | undefined;
        if (typeof args.origin === "string") {
          const asCoords = parseLatLng(args.origin);
          if (asCoords) center = asCoords;
          else near = args.origin;
        } else {
          center = args.origin;
        }

        const res = await ctx.client.xNearest({
          query: args.search_query ?? "",
          near,
          center,
          language: lang,
          country,
          limit: args.candidate_limit,
          candidates: args.candidate_limit,
        });

        if (!res.places.length) {
          throw new GeoLinkError(
            `No places with a route were found for "${args.search_query}" near ${near ?? formatLatLng(center ?? { lat: 0, lng: 0 })}`,
            "not_found",
            "Try a broader query, the other language (ar/en), or a larger candidate_limit.",
          );
        }

        const resolvedTo = res.near ?? null;
        const originPoint: LatLng = resolvedTo?.location ?? center ?? { lat: 0, lng: 0 };
        const originLabel = resolvedTo?.short_address ?? resolvedTo?.address ?? formatLatLng(originPoint);

        const measured = normalizeXPlaces(res.places)
          .map((p, i) => {
            const travel = (p as unknown as { travel?: XTravel }).travel;
            return {
              candidate_index: i,
              label: p.name,
              location: p.location,
              x_place: p,
              straight_line_km: round((p.distance_m ?? 0) / 1000, 3),
              distance_meters: travel?.distance_m ?? 0,
              distance_text: travel?.distance_text ?? "",
              duration_seconds: travel?.duration_s ?? 0,
              duration_text: travel?.duration_text ?? "",
            };
          })
          // A place with no route cannot be ranked by one. The API already
          // leaves those out; this catches anything that slipped through
          // rather than ranking it at zero, which would make it the winner.
          .filter((r) => r.distance_meters > 0 || r.duration_seconds > 0);

        const ranked = measured
          .sort((a, b) =>
            args.rank_by === "duration"
              ? a.duration_seconds - b.duration_seconds
              : a.distance_meters - b.distance_meters,
          )
          .slice(0, args.limit)
          .map((r, i) => ({ rank: i + 1, ...r }));

        const structured = {
          origin: {
            lat: originPoint.lat,
            lng: originPoint.lng,
            input: typeof args.origin === "string" ? args.origin : formatLatLng(args.origin),
            label: originLabel,
            source: (near ? "geocode" : "coordinates") as "geocode" | "coordinates",
          },
          source: "search" as const,
          search_query: args.search_query ?? "",
          resolved_to: resolvedTo,
          rank_by: args.rank_by,
          candidates_evaluated: measured.length,
          ...(res.complete !== undefined ? { results_complete: res.complete } : {}),
          results: ranked,
        };

        const text =
          args.response_format === ResponseFormat.JSON
            ? JSON.stringify(structured, null, 2)
            : [
                `# Nearest to ${originLabel} by ${args.rank_by === "duration" ? "driving time" : "road distance"}`,
                `_${measured.length} candidate(s) measured by road, from a search for "${args.search_query}"_`,
                ...(res.complete === false
                  ? [
                      "",
                      "> **The shortlist was cut short.** More candidates were available than were measured, and the nearest by road is often not among the nearest by line — so a better answer may not have been in the running. Raise `candidate_limit`.",
                    ]
                  : []),
                "",
                ...ranked.map((r) => {
                  const detour = r.straight_line_km > 0 ? ` — ${(r.distance_meters / 1000 / r.straight_line_km).toFixed(1)}x the straight line` : "";
                  const extra = [r.x_place?.category, r.x_place?.phone].filter(Boolean).join(" · ");
                  return [
                    `${r.rank}. **${r.label}** — ${r.distance_text || `${r.distance_meters} m`} / ${r.duration_text || `${r.duration_seconds} s`}`,
                    `   ${r.straight_line_km} km in a straight line${detour}`,
                    ...(extra ? [`   ${extra}`] : []),
                    `   \`${formatLatLng(r.location)}\``,
                  ].join("\n");
                }),
              ].join("\n");

        return ok(structured, text);
      }

      /* ---------- Options already known: route them together ---------- */
      const origin = await resolveLocation(ctx, args.origin, lang, country);

      // Guard before spending: geocoding candidates costs upstream calls, so
      // refuse an over-sized job before paying for it.
      const plannedCells = args.candidates?.length ?? 0;
      if (plannedCells > ctx.cfg.maxMatrixCells) {
        throw new GeoLinkError(
          `Too many candidates (${plannedCells}); limit is ${ctx.cfg.maxMatrixCells}`,
          "bad_request",
          "Pass fewer candidates, or raise GEOLINK_MAX_MATRIX_CELLS.",
        );
      }

      const candidates: ResolvedLocation[] = await resolveMany(ctx, args.candidates ?? [], lang, country);

      const result = await ctx.client.distanceMatrix([toLatLng(origin)], candidates.map(toLatLng), lang, country);
      const row: MatrixCell[] = result.matrix[0] ?? [];
      const geolinkNearest = result.nearest_destination_index[0] ?? -1;

      /**
       * Resolve a candidate to its cell by the coordinates the upstream echoed
       * back, falling back to position when it echoed nothing usable. Index
       * order is an assumption about someone else's response shape; the
       * coordinates are the identity.
       */
      const echoed = result.destinations;
      const cellFor = (index: number, want: LatLng): MatrixCell | undefined => {
        const byPosition = row[index];
        const at = echoed[index];
        if (at && Math.abs(at.lat - want.lat) < 1e-4 && Math.abs(at.lng - want.lng) < 1e-4) return byPosition;
        const found = echoed.findIndex((d) => d && Math.abs(d.lat - want.lat) < 1e-4 && Math.abs(d.lng - want.lng) < 1e-4);
        return found >= 0 ? row[found] : byPosition;
      };
      let mismatched = 0;

      const ranked = candidates
        .map((c, i) => {
          // Pair by coordinate, not by position. The upstream echoes the
          // destinations it routed; nothing guarantees it echoes them in the
          // order they were sent, and trusting position silently attributes
          // one place's travel time to another. When the order does match this
          // resolves to the same cell.
          const cell = cellFor(i, toLatLng(c)) ?? { distance_meters: 0, distance_text: "", duration_seconds: 0, duration_text: "" };
          const straightLineKm = round(haversineKm(origin, c), 3);
          // A road route cannot be shorter than the straight line between its
          // own endpoints. If it is, this cell belongs to a different place,
          // and reporting it would answer the question with the wrong branch.
          const shorterThanStraightLine = cell.distance_meters > 0 && straightLineKm > 0 && cell.distance_meters < straightLineKm * 1000 * 0.98;
          // A distance can be self-consistent and still carry the wrong
          // duration; the tell is a speed nobody drives.
          const speed = impliedSpeedKmh(cell.distance_meters, cell.duration_seconds);
          const impossibleSpeed = speed !== null && (speed > PLAUSIBLE_SPEED_KMH.max || speed < PLAUSIBLE_SPEED_KMH.min);
          const impossible = shorterThanStraightLine || impossibleSpeed;
          if (impossible) mismatched += 1;
          return {
            candidate_index: i,
            label: c.label,
            location: toLatLng(c),
            straight_line_km: straightLineKm,
            ...cell,
            ...(speed !== null ? { implied_speed_kmh: round(speed, 1) } : {}),
            ...(impossible ? { unreliable_pairing: true } : {}),
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
        source: "candidates" as const,
        rank_by: args.rank_by,
        candidates_evaluated: candidates.length,
        results: ranked,
        ...(mismatched > 0
          ? {
              warning: `${mismatched} candidate(s) failed a physical check — a road distance shorter than their own straight line, or an implied speed outside ${PLAUSIBLE_SPEED_KMH.min}-${PLAUSIBLE_SPEED_KMH.max} km/h. Either means the upstream's numbers could not be matched to these places reliably. Those entries carry unreliable_pairing; treat their ranking as unverified and re-check the specific pair with geolink_get_directions.`,
            }
          : {}),
      };

      const text =
        args.response_format === ResponseFormat.JSON
          ? JSON.stringify(structured, null, 2)
          : [
              `# Nearest to ${origin.label} (by ${args.rank_by})`,
              `_${candidates.length} candidate(s) evaluated_`,
              "",
              ...ranked.map(
                (r) =>
                  `${r.rank}. **${r.label}** — ${r.distance_text || `${r.distance_meters} m`} / ${r.duration_text || `${r.duration_seconds} s`} (straight line ${r.straight_line_km} km)${r.is_geolink_nearest ? " ⭐" : ""}\n   📍 ${formatLatLng(r.location)}`,
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
