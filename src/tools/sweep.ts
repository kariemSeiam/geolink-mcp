import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DEFAULT_DEDUPE_METERS, DEFAULT_GRID_SPACING_KM } from "../constants.js";
import { GeoLinkError } from "../services/client.js";
import { fitToLimit, guarded, ok, paginate, placeMarkdown, placesToGeoJson } from "../services/format.js";
import {
  boundsFromCenterRadius,
  boundsSizeKm,
  buildGrid,
  dedupePlaces,
  expandBounds,
  formatLatLng,
  haversineKm,
  inBounds,
  mapWithConcurrency,
  suggestSpacingKm,
  type GridOptions
} from "../services/geo.js";
import {
  BoundsSchema,
  countryParam,
  languageParam,
  LatLngSchema,
  LocationInputSchema,
  pickCountry,
  pickLang,
  resolveLocation,
  toLatLng,
  type ToolContext,
} from "../services/resolve.js";
import { PaginationFields, PlaceSchema } from "../services/schemas.js";
import type { Bounds, LatLng, Place } from "../types.js";

const PlaceField = z.enum(["name", "address", "address_parts", "location", "bounds"]);
type PlaceFieldT = z.infer<typeof PlaceField>;

const AreaSchema = z
  .union([
    z
      .object({
        place: z
          .string()
          .min(1)
          .max(300)
          .describe('A named area to cover: a governorate, city, or district, e.g. "Giza", "الإسكندرية", "Nasr City". Its geocoded viewport bounds define the sweep.'),
      })
      .strict(),
    z
      .object({
        center: LocationInputSchema,
        radius_km: z.number().min(0.5).max(100).describe("Radius around the center in km (0.5-100)."),
      })
      .strict(),
    z.object({ bounds: BoundsSchema }).strict(),
  ])
  .describe(
    'The area to cover. One of: {place: "Giza"} (geocoded bounds), {center: "30.04,31.23" | "Tahrir Square", radius_km: 5}, or {bounds: {northeast:{lat,lng}, southwest:{lat,lng}}}.',
  );

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function registerSweepTool(server: McpServer, ctx: ToolContext): void {
  const SweepShape = {
    query: z.string().min(1).max(300).describe('What to find everywhere in the area: "pharmacy", "school", "كافيه", "ATM".'),
    area: AreaSchema,
    grid_spacing_km: z
      .number()
      .min(0.5)
      .max(25)
      .default(DEFAULT_GRID_SPACING_KM)
      .describe(
        "Distance between query points in km (default 3). Dense urban categories: 2-3. Sparse categories or rural areas: 5-7. Smaller = more calls + more coverage.",
      ),
    padding_km: z
      .number()
      .min(0)
      .max(25)
      .default(0)
      .describe("Expand the area's bounds outward by this many km before tiling (default 0). Useful when a geocoded viewport is tight."),
    dry_run: z
      .boolean()
      .default(false)
      .describe("Plan only: return the grid size and exact API-call count without spending any quota. ALWAYS dry_run first for unfamiliar areas."),
    clip_to_area: z
      .boolean()
      .default(true)
      .describe("Drop results that fall outside the (padded) area bounds. Default true."),
    dedupe_meters: z
      .number()
      .min(0)
      .max(500)
      .default(DEFAULT_DEDUPE_METERS)
      .describe("Merge places with the same normalized name within this many metres (default 60). 0 disables name-based dedup."),
    limit: z.number().int().min(1).max(500).default(100).describe("Max places to return in this response (default 100). Sweep results are computed once per call; page with offset."),
    offset: z.number().int().min(0).default(0).describe("Skip this many unique places."),
    fields: z
      .array(PlaceField)
      .min(1)
      .optional()
      .describe("Restrict each place to these fields to save tokens, e.g. [\"name\",\"location\"]. Default: all."),
    response_format: z
      .enum(["markdown", "json", "geojson"])
      .default("markdown")
      .describe("'markdown' (readable), 'json' (raw), or 'geojson' (FeatureCollection of points, map-ready)."),
    language: languageParam,
    country: countryParam,
  };
  const SweepInput = z.object(SweepShape);

  const StatsSchema = z.object({
    api_calls_made: z.number().int(),
    points_queried: z.number().int(),
    points_succeeded: z.number().int(),
    points_failed: z.number().int(),
    raw_results: z.number().int(),
    after_clip: z.number().int(),
    unique_results: z.number().int(),
    by_governorate: z.record(z.number().int()),
    by_district: z.record(z.number().int()),
    failed_details: z.array(z.object({
      point_index: z.number().int(),
      error_kind: z.enum(["auth", "quota", "not_found", "bad_request", "timeout", "network", "upstream"]),
      message: z.string(),
    })).optional(),
  });

  const SweepOutput = {
    query: z.string(),
    dry_run: z.boolean(),
    area: z.object({
      source: z.enum(["place", "center_radius", "bounds"]),
      label: z.string(),
      bounds: BoundsSchema,
      width_km: z.number(),
      height_km: z.number(),
      center: LatLngSchema,
      radius_km: z.number().optional(),
    }),
    plan: z.object({
      grid_spacing_km: z.number(),
      grid_points: z.number().int(),
      estimated_api_calls: z.number().int(),
      max_points_allowed: z.number().int(),
      sample_points: z.array(LatLngSchema),
    }),
    stats: StatsSchema.optional(),
    ...PaginationFields,
    places: z.array(PlaceSchema.partial().extend({ location: LatLngSchema.optional() })).optional(),
    geojson: z
      .object({
        type: z.literal("FeatureCollection"),
        features: z.array(z.record(z.unknown())),
      })
      .optional(),
    note: z.string().optional(),
  };

  server.registerTool(
    "geolink_sweep_area",
    {
      title: "Sweep an area for places (grid coverage)",
      description: `Exhaustively find every place matching a query across a whole area — a governorate, city, district, radius, or bounding box — by tiling it with a grid of query points and running one place search per point, then merging and de-duplicating the hits.

A single geolink_search_places call returns one page from one center. This tool is how you get "all pharmacies in Giza" or "every school within 10 km of Tanta".

Cost model: api_calls = grid points (+1 geocode if area is a name). Points ≈ (width/spacing) × (height/spacing). Hard cap: ${ctx.cfg.sweepMaxPoints} points (GEOLINK_SWEEP_MAX_POINTS). Runs ${ctx.cfg.sweepConcurrency} requests in parallel.

WORKFLOW: call with dry_run=true first → read plan.estimated_api_calls → adjust grid_spacing_km → run for real.

Args:
  - query (string): Category or name to find everywhere.
  - area: {place} | {center, radius_km} | {bounds}.
  - grid_spacing_km (0.5-25, default 3).
  - padding_km (0-25, default 0).
  - dry_run (bool, default false).
  - clip_to_area (bool, default true).
  - dedupe_meters (0-500, default 60).
  - limit (1-500, default 100), offset (default 0).
  - fields (subset of name|address|address_parts|location): trim output.
  - response_format ('markdown' | 'json' | 'geojson').
  - language, country.

Returns (structuredContent):
  {
    "query", "dry_run",
    "area": { source, label, bounds, width_km, height_km, center, radius_km? },
    "plan": { grid_spacing_km, grid_points, estimated_api_calls, max_points_allowed, sample_points },
    "stats"?: { api_calls_made, points_queried, points_succeeded, points_failed, raw_results, after_clip, unique_results,
                by_governorate: {name: count}, by_district: {name: count} },      // not present on dry_run
    "total", "count", "offset", "has_more", "next_offset"?,
    "places"?: [ Place (possibly field-trimmed) ],
    "geojson"?: FeatureCollection                                                     // response_format='geojson'
  }

Examples:
  - "All pharmacies in Giza" -> query="pharmacy", area={place:"Giza"}, dry_run=true → then real run
  - "Every ATM within 5 km of Smart Village" -> query="ATM", area={center:"Smart Village", radius_km:5}, grid_spacing_km=2
  - "Cafés in this box" -> query="cafe", area={bounds:{northeast:{...}, southwest:{...}}}, response_format="geojson"

Errors: bad_request when the grid exceeds the cap — the hint tells you the smallest spacing that fits.`,
      inputSchema: SweepShape,
      outputSchema: SweepOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (raw: z.infer<typeof SweepInput>, extra: Extra) => {
      const args = SweepInput.parse(raw);
      const lang = pickLang(ctx, args.language);
      const country = pickCountry(ctx, args.country);

      /* ---------- Resolve the area ---------- */
      let bounds: Bounds;
      let source: "place" | "center_radius" | "bounds";
      let label: string;
      let grid: GridOptions = {};
      let radiusKm: number | undefined;

      if ("place" in args.area) {
        source = "place";
        const geo = await ctx.client.geocode(args.area.place, lang, country);
        if (!geo.bounds) {
          throw new GeoLinkError(
            `"${args.area.place}" geocoded without viewport bounds, so it cannot define an area`,
            "bad_request",
            "Use area={center: \"<place>\", radius_km: N} instead.",
          );
        }
        bounds = geo.bounds;
        label = geo.name || geo.address || args.area.place;
      } else if ("center" in args.area) {
        source = "center_radius";
        const c = await resolveLocation(ctx, args.area.center, lang, country);
        radiusKm = args.area.radius_km;
        bounds = boundsFromCenterRadius(toLatLng(c), radiusKm);
        grid = { circle: { center: toLatLng(c), radiusKm } };
        label = `${radiusKm} km around ${c.label}`;
      } else {
        source = "bounds";
        bounds = {
          northeast: { lat: Math.max(args.area.bounds.northeast.lat, args.area.bounds.southwest.lat), lng: Math.max(args.area.bounds.northeast.lng, args.area.bounds.southwest.lng) },
          southwest: { lat: Math.min(args.area.bounds.northeast.lat, args.area.bounds.southwest.lat), lng: Math.min(args.area.bounds.northeast.lng, args.area.bounds.southwest.lng) },
        };
        label = `box ${formatLatLng(bounds.southwest, 3)} → ${formatLatLng(bounds.northeast, 3)}`;
      }

      bounds = expandBounds(bounds, args.padding_km);
      if (grid.circle && args.padding_km > 0) grid = { circle: { ...grid.circle, radiusKm: grid.circle.radiusKm + args.padding_km } };
      const size = boundsSizeKm(bounds);
      const center: LatLng = {
        lat: (bounds.northeast.lat + bounds.southwest.lat) / 2,
        lng: (bounds.northeast.lng + bounds.southwest.lng) / 2,
      };

      /* ---------- Plan the grid ---------- */
      const points = buildGrid(bounds, args.grid_spacing_km, grid);
      const plan = {
        grid_spacing_km: args.grid_spacing_km,
        grid_points: points.length,
        estimated_api_calls: points.length,
        max_points_allowed: ctx.cfg.sweepMaxPoints,
        sample_points: points.slice(0, 5),
      };
      const areaOut = { source, label, bounds, width_km: size.width_km, height_km: size.height_km, center, ...(radiusKm !== undefined ? { radius_km: radiusKm } : {}) };

      if (points.length > ctx.cfg.sweepMaxPoints) {
        const suggested = suggestSpacingKm(bounds, ctx.cfg.sweepMaxPoints, grid);
        throw new GeoLinkError(
          `Grid of ${points.length} points exceeds the cap of ${ctx.cfg.sweepMaxPoints} (area ${size.width_km} × ${size.height_km} km at ${args.grid_spacing_km} km spacing)`,
          "bad_request",
          `Set grid_spacing_km=${suggested} (≈ ${buildGrid(bounds, suggested, grid).length} points), shrink the area, or raise GEOLINK_SWEEP_MAX_POINTS.`,
        );
      }

      if (args.dry_run) {
        const structured = {
          query: args.query,
          dry_run: true,
          area: areaOut,
          plan,
          total: 0,
          count: 0,
          offset: 0,
          has_more: false,
          note: "Dry run — no search calls were made. Re-run with dry_run=false to execute.",
        };
        const text = [
          `# Sweep plan: "${args.query}" over ${label}`,
          "",
          `- **Area**: ${size.width_km} km × ${size.height_km} km (${source})`,
          `- **Bounds**: NE ${formatLatLng(bounds.northeast)} · SW ${formatLatLng(bounds.southwest)}`,
          `- **Grid spacing**: ${args.grid_spacing_km} km`,
          `- **Grid points / API calls**: **${points.length}** (cap ${ctx.cfg.sweepMaxPoints})`,
          `- **Sample points**: ${points.slice(0, 5).map((p) => formatLatLng(p, 4)).join("; ")}`,
          "",
          "_No quota spent. Re-run with dry_run=false to execute._",
        ].join("\n");
        return ok(structured, text);
      }

      /* ---------- Execute ---------- */
      const progressToken = extra._meta?.progressToken;
      const notify = async (done: number, total: number): Promise<void> => {
        if (progressToken === undefined) return;
        try {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: done, total, message: `Searched ${done}/${total} grid points` },
          });
        } catch {
          /* progress is best-effort */
        }
      };

      const callsBefore = ctx.client.calls;
      let failed = 0;
      const failures: { point_index: number; error_kind: GeoLinkError["kind"]; message: string }[] = [];
      const perPoint = await mapWithConcurrency(
        points,
        ctx.cfg.sweepConcurrency,
        async (p, index): Promise<Place[]> => {
          try {
            return await ctx.client.textSearch(args.query, p, lang, country);
          } catch (err) {
            // Auth/quota errors should abort the whole sweep; anything else is a soft miss.
            if (err instanceof GeoLinkError && (err.kind === "auth" || err.kind === "quota")) throw err;
            failed++;
            const geoErr = err instanceof GeoLinkError ? err : null;
            failures.push({
              point_index: index,
              error_kind: geoErr?.kind ?? "network",
              message: geoErr?.message ?? String(err),
            });
            return [];
          }
        },
        (done, total) => void notify(done, total),
      );

      const rawPlaces = perPoint.flat();
      const clipped = args.clip_to_area
        ? rawPlaces.filter((p) => inBounds(p.location, bounds) && (!grid.circle || withinCircle(p.location, grid)))
        : rawPlaces;
      const unique = dedupePlaces(clipped, args.dedupe_meters);

      const byGov = countBy(unique, (p) => p.address_parts.governorate);
      const byDistrict = countBy(unique, (p) => p.address_parts.district, 25);

      const stats = {
        api_calls_made: ctx.client.calls - callsBefore,
        points_queried: points.length,
        points_succeeded: points.length - failed,
        points_failed: failed,
        raw_results: rawPlaces.length,
        after_clip: clipped.length,
        unique_results: unique.length,
        by_governorate: byGov,
        by_district: byDistrict,
        failed_details: failures.length > 0 ? failures : undefined,
      };

      const page = paginate(unique, args.limit, args.offset);
      const trimmed = args.fields ? page.items.map((p) => pickFields(p, args.fields ?? [])) : page.items;

      const base = {
        query: args.query,
        dry_run: false,
        area: areaOut,
        plan,
        stats,
        total: page.total,
        count: page.count,
        offset: page.offset,
        has_more: page.has_more,
        ...(page.next_offset !== undefined ? { next_offset: page.next_offset } : {}),
      };

      if (args.response_format === "geojson") {
        const fc = placesToGeoJson(page.items);
        const structured = { ...base, geojson: fc };
        const text = JSON.stringify(structured, null, 2);
        return ok(structured, text.length > 25_000 ? `${text.slice(0, 24_000)}\n…(truncated; lower limit or use fields)` : text);
      }

      const render = (items: Partial<Place>[]): string => {
        if (args.response_format === "json") return JSON.stringify({ ...base, places: items }, null, 2);
        const head = [
          `# Sweep: "${args.query}" over ${label}`,
          `_${stats.unique_results} unique places from ${stats.raw_results} raw hits across ${stats.points_queried} grid points (${stats.api_calls_made} API calls${failed ? `, ${failed} failed` : ""})_`,
          "",
          `**By governorate**: ${Object.entries(byGov).map(([k, v]) => `${k || "(unknown)"} ${v}`).join(" · ") || "n/a"}`,
          `**Top districts**: ${Object.entries(byDistrict).slice(0, 10).map(([k, v]) => `${k || "(unknown)"} ${v}`).join(" · ") || "n/a"}`,
          "",
        ];
        const body = items.map((p, i) => (isFullPlace(p) ? placeMarkdown(p, args.offset + i + 1) : `${args.offset + i + 1}. ${JSON.stringify(p)}`));
        const foot = page.has_more ? `\n_Showing ${page.count} of ${page.total}. Call again with offset=${page.next_offset}._` : `\n_Showing all ${page.total}._`;
        return [...head, ...body, foot].join("\n");
      };

      const fitted = fitToLimit(trimmed, render, `Use a smaller limit, offset=${args.offset}, or fields=["name","location"].`);
      return ok(
        { ...base, places: fitted.items, count: fitted.items.length, ...(fitted.truncated ? { truncated: true, truncation_message: fitted.truncation_message } : {}) },
        fitted.text,
      );
    }),
  );
}

function withinCircle(p: LatLng, grid: GridOptions): boolean {
  if (!grid.circle) return true;
  return haversineKm(grid.circle.center, p) <= grid.circle.radiusKm;
}

function countBy(places: Place[], key: (p: Place) => string, top?: number): Record<string, number> {
  const counts = new Map<string, number>();
  for (const p of places) {
    const k = key(p) || "";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(top ? sorted.slice(0, top) : sorted);
}

function pickFields(p: Place, fields: PlaceFieldT[]): Partial<Place> {
  const out: Partial<Place> = {};
  for (const f of fields) {
    if (f === "name") out.name = p.name;
    else if (f === "address") out.address = p.address;
    else if (f === "address_parts") out.address_parts = p.address_parts;
    else if (f === "location") out.location = p.location;
  }
  return out;
}

function isFullPlace(p: Partial<Place>): p is Place {
  return typeof p.name === "string" && typeof p.address === "string" && p.address_parts !== undefined && p.location !== undefined;
}
