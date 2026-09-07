import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GeoLinkError } from "../services/client.js";
import { fitToLimit, guarded, ok, paginate, placesToGeoJson } from "../services/format.js";
import { formatLatLng } from "../services/geo.js";
import { normalizeXPlaces } from "../services/normalize.js";
import {
  BoundsSchema,
  countryParam,
  languageParam,
  LatLngSchema,
  LocationInputSchema,
  pickCountry,
  pickLang,
  type ToolContext,
} from "../services/resolve.js";
import { PaginationFields, XNearSchema, XPlaceSchema } from "../services/schemas.js";
import type { Bounds, LatLng, XPlace } from "../types.js";

/**
 * Covering ground used to be this file's job, and it was the wrong place for it.
 *
 * A single search sees roughly three hundred places whatever you ask for - the
 * ceiling belongs to the vantage point, not to the world - so covering an area
 * means standing in several places and merging what each one saw. This tool
 * used to build that grid itself: tile the bounds, search each point, clip,
 * de-duplicate by name and distance, and count how many points came back full.
 * Two hundred and twenty lines of it, with a 3 km spacing chosen because it
 * felt safe.
 *
 * It is measured now, and 3 km was not safe, it was wasteful: neighbouring
 * points 3 km apart returned 69% the same places and found 472 of them, while
 * 15 km apart returned 11% overlap and found 818. The knee is 15 km, the engine
 * knows it, and a number copied into this file would have drifted from it the
 * first time it moved.
 *
 * So the grid, the spacing, the merge and the de-duplication all live in the
 * engine now, and this file does what a tool should: turn a question into a
 * request, and an answer into something a model can read without being misled.
 */

const PlaceField = z.enum([
  "name",
  "address",
  "address_parts",
  "location",
  "category",
  "type",
  "rating",
  "phone",
  "website",
  "photo",
  "hours",
  "timezone",
  "distance_m",
  "place_id",
]);
type PlaceFieldT = z.infer<typeof PlaceField>;

const AreaSchema = z
  .union([
    z
      .object({
        place: z
          .string()
          .min(1)
          .max(300)
          .describe('A named area to cover: a governorate, city, or district — "Giza", "الإسكندرية", "Nasr City". Its geocoded viewport becomes the sweep bounds.'),
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
    'The ground to cover. One of: {place: "Giza"}, {center: "Tahrir Square" | {lat,lng}, radius_km: 5}, or {bounds: {northeast, southwest}}.',
  );

export function registerSweepTool(server: McpServer, ctx: ToolContext): void {
  const SweepShape = {
    query: z.string().min(1).max(300).describe('What to find everywhere in the area: "pharmacy", "school", "كافيه", "ATM".'),
    area: AreaSchema,
    view: z
      .enum(["places", "summary"])
      .default("places")
      .describe(
        "'places' lists them. 'summary' returns counts instead — how many, by district, by category, how many rated and open — in a fraction of the tokens. Use 'summary' for \"how many X are in Y\" and to find which districts are worth listing.",
      ),
    dry_run: z
      .boolean()
      .default(false)
      .describe("Plan only: how many requests this needs and roughly how long, without searching. Cheap; use it when an area's size is unfamiliar."),
    spacing_km: z
      .number()
      .min(2)
      .max(50)
      .optional()
      .describe(
        "Distance between vantage points. Leave unset — the default is a measured value, not a guess, and lowering it mostly buys overlap. Tighten it only for a category so dense that whole streets are being missed.",
      ),
    pages_per_point: z
      .number()
      .int()
      .min(1)
      .max(15)
      .optional()
      .describe("How deep to read at each vantage point (1-15). Leave unset unless a dense category is coming back thin."),
    continue_from: z
      .string()
      .optional()
      .describe(
        "Resume ground a previous call did not reach: pass back its `continue_from` verbatim. Opaque — it encodes where the sweep stopped, not a position you can construct.",
      ),
    limit: z.number().int().min(1).max(500).default(100).describe("How many places to return in this response (default 100). Page the rest with offset — it is served from the same sweep, not a new one."),
    offset: z.number().int().min(0).default(0).describe("Skip this many places."),
    fields: z
      .array(PlaceField)
      .min(1)
      .optional()
      .describe('Return only these fields per place, to save tokens: ["name","location"]. Default: all of them.'),
    response_format: z
      .enum(["markdown", "json", "geojson"])
      .default("markdown")
      .describe("'markdown' (readable), 'json' (raw), or 'geojson' (FeatureCollection, map-ready)."),
    language: languageParam,
    country: countryParam,
  };
  const SweepInput = z.object(SweepShape);

  const SweepOutput = {
    query: z.string(),
    dry_run: z.boolean(),
    view: z.enum(["places", "summary"]),
    area: z.object({
      source: z.enum(["place", "center_radius", "bounds"]),
      label: z.string(),
      center: LatLngSchema.optional(),
      radius_km: z.number().optional(),
      bounds: BoundsSchema.optional(),
    }),
    resolved_to: XNearSchema.nullable().describe(
      "What a named place resolved to. Null when coordinates or bounds were given. Worth reading: names collide, and a sweep of the wrong Nasr City looks exactly like a sweep of the right one.",
    ),
    plan: z
      .object({
        requests_needed: z.number().int(),
        estimated_seconds: z.number(),
        fits_in_one_request: z.boolean(),
      })
      .optional(),
    summary: z.record(z.unknown()).optional(),
    area_fully_swept: z
      .boolean()
      .describe("False when the sweep ran out of time before covering the whole area. Pass continue_from to reach the rest."),
    continue_from: z.string().optional(),
    results_complete: z
      .boolean()
      .optional()
      .describe(
        "False when the source still had more to give at the points that were visited — `total` is then a floor, not a count. Raise pages_per_point. Undefined means the API did not say.",
      ),
    distance_measured_from: LatLngSchema.optional().describe(
      "Each place's distance_m is a straight line from this point, not from any origin of yours.",
    ),
    ...PaginationFields,
    places: z.array(XPlaceSchema.partial()).optional(),
    geojson: z
      .object({ type: z.literal("FeatureCollection"), features: z.array(z.record(z.unknown())) })
      .optional(),
    note: z.string().optional(),
  };

  server.registerTool(
    "geolink_sweep_area",
    {
      title: "Sweep an area for places",
      description: `Find every place matching a query across a whole area — a governorate, city, district, radius, or bounding box — by searching it from several vantage points and merging what each one saw.

One search reads one point as deeply as you like and still sees only what is near it: a large limit reads deeper, it does not read wider. This is the tool that reads wider. Use geolink_search_places when one neighbourhood is the question; use this one for "all pharmacies in Giza" or "every school within 10 km of Tanta".

The spacing between vantage points, how far each one reaches, the merge and the de-duplication are all decided by the API from measured behaviour. You do not have to plan the grid, and mostly should not try.

Two different kinds of "there is more", and they are not interchangeable:
  - has_more / next_offset — more places in this same sweep. Page them with offset; it costs nothing, the sweep is not repeated.
  - area_fully_swept: false + continue_from — the sweep ran out of time with ground still unvisited. Pass continue_from back to cover it. This is the one that means results are incomplete.

Args:
  - query (string): what to find.
  - area: {place} | {center, radius_km} | {bounds}.
  - view ('places' | 'summary', default 'places'): 'summary' answers "how many" and "which districts" for a fraction of the tokens.
  - dry_run (bool, default false): the request count and rough duration, without searching.
  - spacing_km (2-50), pages_per_point (1-15): both optional, both better left alone.
  - continue_from: an earlier response's continue_from, verbatim.
  - limit (1-500, default 100), offset.
  - fields: trim each place.
  - response_format ('markdown' | 'json' | 'geojson').
  - language, country.

Each place carries name, address, address_parts, location, category, type, timezone, and — when the place has one — rating (with its count), phone, website, photo and hours. An absent field means the place has no such thing, not that it could not be read.

Examples:
  - "All pharmacies in Giza" → query="pharmacy", area={place:"Giza"}
  - "How many pharmacies in Giza, and where are they concentrated?" → the same, view="summary"
  - "Every ATM within 5 km of Smart Village" → query="ATM", area={center:"Smart Village", radius_km:5}
  - "Cafés in this box, on a map" → area={bounds:{...}}, response_format="geojson"`,
      inputSchema: SweepShape,
      outputSchema: SweepOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (raw: z.infer<typeof SweepInput>) => {
      const args = SweepInput.parse(raw);
      const lang = pickLang(ctx, args.language);
      const country = pickCountry(ctx, args.country);

      /* ---------- Say where, in the terms the API takes ---------- */
      // Three ways to name ground, and each maps to a different pair of
      // parameters. A name goes over as a name: the API resolves it and tells
      // us what it picked, which is both one round trip fewer and one more
      // fact than geocoding it here would have given us.
      let source: "place" | "center_radius" | "bounds";
      let label: string;
      let center: LatLng | undefined;
      let radiusKm: number | undefined;
      let bounds: Bounds | undefined;
      let near: string | undefined;
      let boundsParam: string | undefined;

      if ("place" in args.area) {
        // A governorate is an area, not a point, and its viewport is the only
        // thing that says how far it reaches. `near` would collapse it to its
        // centre and sweep a circle that is both too small and the wrong shape.
        source = "place";
        const geo = await ctx.client.geocode(args.area.place, lang, country);
        if (!geo.bounds) {
          throw new GeoLinkError(
            `"${args.area.place}" geocoded without viewport bounds, so it does not describe an area`,
            "bad_request",
            `Use area={center: "${args.area.place}", radius_km: N} instead.`,
          );
        }
        bounds = geo.bounds;
        label = geo.name || args.area.place;
      } else if ("center" in args.area) {
        source = "center_radius";
        radiusKm = args.area.radius_km;
        if (typeof args.area.center === "string") {
          near = args.area.center;
          label = `${radiusKm} km around ${near}`;
        } else {
          center = args.area.center;
          label = `${radiusKm} km around ${formatLatLng(center)}`;
        }
      } else {
        source = "bounds";
        bounds = {
          northeast: {
            lat: Math.max(args.area.bounds.northeast.lat, args.area.bounds.southwest.lat),
            lng: Math.max(args.area.bounds.northeast.lng, args.area.bounds.southwest.lng),
          },
          southwest: {
            lat: Math.min(args.area.bounds.northeast.lat, args.area.bounds.southwest.lat),
            lng: Math.min(args.area.bounds.northeast.lng, args.area.bounds.southwest.lng),
          },
        };
        label = `box ${formatLatLng(bounds.southwest, 3)} → ${formatLatLng(bounds.northeast, 3)}`;
      }

      if (bounds) {
        boundsParam = [bounds.southwest.lat, bounds.southwest.lng, bounds.northeast.lat, bounds.northeast.lng]
          .map((n) => n.toFixed(6))
          .join(",");
      }

      const areaOut = {
        source,
        label,
        ...(center ? { center } : {}),
        ...(radiusKm !== undefined ? { radius_km: radiusKm } : {}),
        ...(bounds ? { bounds } : {}),
      };

      const call = {
        query: args.query,
        near,
        center,
        radiusKm,
        bounds: boundsParam,
        language: lang,
        country,
        pagesPerPoint: args.pages_per_point,
        spacingKm: args.spacing_km,
        cursor: args.continue_from,
      };

      /* ---------- Price it, if that is all that was asked ---------- */
      if (args.dry_run) {
        const res = await ctx.client.xSweep({ ...call, dryRun: true });
        const plan = res.plan as { requests_needed?: number; estimated_seconds?: number; fits_in_one_request?: boolean } | undefined;
        const structured = {
          query: args.query,
          dry_run: true,
          view: args.view,
          area: areaOut,
          resolved_to: res.near ?? null,
          plan: {
            requests_needed: plan?.requests_needed ?? 1,
            estimated_seconds: plan?.estimated_seconds ?? 0,
            fits_in_one_request: plan?.fits_in_one_request ?? true,
          },
          area_fully_swept: plan?.fits_in_one_request ?? true,
          total: 0,
          count: 0,
          offset: 0,
          has_more: false,
          note: "Plan only — nothing was searched. Re-run with dry_run=false.",
        };
        const text = [
          `# Sweep plan: "${args.query}" over ${label}`,
          "",
          `- **Requests**: ${structured.plan.requests_needed}${structured.plan.fits_in_one_request ? " — fits in one call" : " — will need continue_from to finish"}`,
          `- **Estimated**: ~${structured.plan.estimated_seconds}s`,
          ...(res.near ? [`- **Resolved to**: ${res.near.short_address ?? res.near.address ?? "?"} (${formatLatLng(res.near.location)})`] : []),
          "",
          "_Nothing searched. Re-run with dry_run=false._",
        ].join("\n");
        return ok(structured, text);
      }

      /* ---------- Sweep ---------- */
      const res = await ctx.client.xSweep({ ...call, shape: args.view === "summary" });
      const resolvedTo = res.near ?? null;
      const fullySwept = res.next === undefined;

      const base = {
        query: args.query,
        dry_run: false,
        view: args.view,
        area: areaOut,
        resolved_to: resolvedTo,
        area_fully_swept: fullySwept,
        ...(res.next !== undefined ? { continue_from: res.next } : {}),
        ...(res.complete !== undefined ? { results_complete: res.complete } : {}),
      };

      // Two different ways an answer can be short of the whole truth, and they
      // are fixed by different parameters. Collapsing them into one "there is
      // more" would tell a caller to do the wrong thing half the time.
      //
      //   ground unvisited  -> the sweep stopped early     -> continue_from
      //   source not drained-> each point was read shallow -> pages_per_point
      //
      // Measured on Zamalek: the default depth returned 100 pharmacies where
      // draining the same ground returns 218. Neither number knows about the
      // other, and only this line says so.
      const caveats: string[] = [];
      if (!fullySwept) {
        caveats.push(
          "The sweep ran out of time with ground still unvisited. Call again with `continue_from` set to the value in this response to cover the rest.",
        );
      }
      if (res.complete === false) {
        caveats.push(
          'There were more places at the points it did visit, so **total is a floor** — read it as "at least this many". Raise `pages_per_point` (up to 15) and ask again.',
        );
      }
      const groundNote = caveats.length ? `\n> **Incomplete.** ${caveats.join(" ")}` : "";

      /* ---------- A summary is not a list ---------- */
      if (args.view === "summary") {
        const summary = (res.shape ?? {}) as Record<string, unknown>;
        const structured = {
          ...base,
          summary,
          total: typeof summary.places === "number" ? summary.places : 0,
          count: 0,
          offset: 0,
          has_more: false,
        };
        if (args.response_format === "json") return ok(structured, JSON.stringify(structured, null, 2));

        const byDistrict = (summary.by_district ?? {}) as Record<string, number>;
        const byCategory = (summary.by_category ?? {}) as Record<string, number>;
        const rating = summary.rating as { mean?: number; rated?: number; unrated?: number } | undefined;
        const top = (rec: Record<string, number>, n: number): string =>
          Object.entries(rec)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([k, v]) => `${k || "(unknown)"} ${v}`)
            .join(" · ") || "n/a";
        const text = [
          `# "${args.query}" across ${label}`,
          groundNote,
          "",
          `**${structured.total}** places${res.complete === false ? " — at least, this is a floor" : ""}.`,
          ...(rating?.mean !== undefined ? [`**Rating**: ${rating.mean} mean across ${rating.rated} rated (${rating.unrated} unrated)`] : []),
          ...(typeof summary.with_phone === "number" ? [`**With a phone**: ${summary.with_phone} · **with a website**: ${summary.with_website ?? 0} · **open now**: ${summary.open_now ?? 0}`] : []),
          "",
          `**Districts** (${Object.keys(byDistrict).length}): ${top(byDistrict, 15)}`,
          `**Categories**: ${top(byCategory, 10)}`,
          "",
          "_Counts only. Re-run with view=\"places\" — or with a district as the area — to list them._",
        ].join("\n");
        return ok(structured, text);
      }

      /* ---------- Places ---------- */
      const places = normalizeXPlaces(res.places);
      const page = paginate(places, args.limit, args.offset);
      const trimmed = args.fields ? page.items.map((p) => pickFields(p, args.fields ?? [])) : page.items;
      const centreOfMeasure = resolvedTo?.location ?? center;

      const paged = {
        ...base,
        ...(centreOfMeasure ? { distance_measured_from: centreOfMeasure } : {}),
        total: page.total,
        count: page.count,
        offset: page.offset,
        has_more: page.has_more,
        ...(page.next_offset !== undefined ? { next_offset: page.next_offset } : {}),
      };

      const hint = `Use a smaller limit, offset=${args.offset}, fields=["name","location"], or view="summary".`;

      if (args.response_format === "geojson") {
        // Fit by dropping whole features, never by cutting the string: a hard
        // character cut produces text that parses as nothing at all, which is
        // worse than fewer features and a sentence saying so.
        const fitted = fitToLimit(
          page.items,
          (items) => JSON.stringify({ ...paged, geojson: toGeoJson(items) }, null, 2),
          hint,
        );
        return ok(
          {
            ...paged,
            geojson: toGeoJson(fitted.items),
            ...withCut(paged, fitted.items.length, args.offset),
            ...(fitted.truncated ? { truncated: true, truncation_message: fitted.truncation_message } : {}),
          },
          fitted.text,
        );
      }

      const render = (items: Partial<XPlace & { name: string }>[]): string => {
        if (args.response_format === "json") return JSON.stringify({ ...paged, places: items }, null, 2);
        const head = [
          `# "${args.query}" across ${label}`,
          groundNote,
          `_${page.total} found${resolvedTo ? `, around ${resolvedTo.short_address ?? resolvedTo.address ?? label}` : ""}. Distances are straight lines from the sweep's centre, not from you._`,
          "",
        ];
        const body = items.map((p, i) => placeLine(p, args.offset + i + 1));
        const foot = page.has_more
          ? `\n_Showing ${page.count} of ${page.total}. Call again with offset=${page.next_offset} — same sweep, no extra cost._`
          : res.complete === false
            ? `\n_Showing all ${page.total} that were found — at least this many exist._`
            : `\n_Showing all ${page.total}._`;
        return [...head, ...body, foot].join("\n");
      };

      const fitted = fitToLimit(trimmed, render, hint);
      return ok(
        {
          ...paged,
          places: fitted.items,
          ...withCut(paged, fitted.items.length, args.offset),
          ...(fitted.truncated ? { truncated: true, truncation_message: fitted.truncation_message } : {}),
        },
        fitted.text,
      );
    }),
  );
}

type XPlaceOut = XPlace & { name: string };

/**
 * Pagination after the response had to be trimmed to fit.
 *
 * Dropping places to stay under the size limit is another way of not showing
 * all of them, so it has to move has_more with it. Without this a response cut
 * from 218 places to 109 still said has_more: false, which tells a caller they
 * are holding everything when they are holding half.
 */
function withCut(paged: { count: number; has_more: boolean }, shown: number, offset: number) {
  return shown < paged.count
    ? { count: shown, has_more: true, next_offset: offset + shown }
    : { count: shown };
}

function pickFields(p: XPlaceOut, fields: PlaceFieldT[]): Partial<XPlaceOut> {
  const out: Partial<XPlaceOut> = {};
  for (const f of fields) {
    const v = (p as unknown as Record<string, unknown>)[f];
    if (v !== undefined) (out as Record<string, unknown>)[f] = v;
  }
  return out;
}

function placeLine(p: Partial<XPlaceOut>, index: number): string {
  const bits: string[] = [];
  if (p.category) bits.push(p.category);
  if (p.rating) bits.push(`★ ${p.rating.value} (${p.rating.count})`);
  if (p.distance_m !== null && p.distance_m !== undefined) bits.push(`${(p.distance_m / 1000).toFixed(1)} km`);
  if (p.hours?.open_now === true) bits.push("open now");
  const lines = [`${index}. **${p.name ?? "(unnamed)"}**${bits.length ? ` — ${bits.join(" · ")}` : ""}`];
  if (p.address) lines.push(`   ${p.address}`);
  const contact = [p.phone, p.website].filter(Boolean).join(" · ");
  if (contact) lines.push(`   ${contact}`);
  if (p.location) lines.push(`   \`${formatLatLng(p.location)}\``);
  return lines.join("\n");
}

function toGeoJson(places: XPlaceOut[]) {
  return placesToGeoJson(
    places.map((p) => ({
      name: p.name,
      address: p.address ?? "",
      address_parts: p.address_parts,
      location: p.location,
    })),
  );
}
