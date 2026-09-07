import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_SEARCH_LIMIT } from "../constants.js";
import { fitToLimit, guarded, ok, paginate } from "../services/format.js";
import { formatLatLng } from "../services/geo.js";
import { normalizeXPlaces } from "../services/normalize.js";
import {
  countryParam,
  languageParam,
  LatLngSchema,
  LocationInputSchema,
  pickCountry,
  pickLang,
  ResponseFormat,
  responseFormatParam,
  type ToolContext,
} from "../services/resolve.js";
import { parseLatLng } from "../services/geo.js";
import { PaginationFields, XNearSchema, XPlaceSchema } from "../services/schemas.js";
import type { LatLng, XPlace } from "../types.js";

/**
 * Places near one point, read as deep as you ask.
 *
 * The interesting change here is not the eleven extra fields, it is that the
 * tool no longer has to guess whether it saw everything. It used to infer that
 * from arithmetic - fewer results came back than were asked for, so the area
 * must be out of them - and that inference is wrong in the one case it matters:
 * a walk that fails partway through also returns short, and was reported as
 * "there are no more". The engine has always known the difference, and now
 * says so in a header. A fact replaces a guess.
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

type XPlaceOut = XPlace & { name: string };

export function registerSearchTools(server: McpServer, ctx: ToolContext): void {
  const SearchShape = {
    query: z
      .string()
      .min(1)
      .max(300)
      .describe('What to look for: a category ("pharmacy", "coffee shop"), a brand, or a place name. Arabic or English.'),
    near: LocationInputSchema.optional().describe(
      'Where to look: a place name ("أسوان", "Zamalek", "Tahrir Square") or coordinates. Strongly recommended — putting the place in the query instead is unreliable: asked that way for pharmacies in Aswan, the source returned results in Giza. Without it there is no centre, and no distances.',
    ),
    limit: z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_SEARCH_LIMIT)
      .describe(
        `How many to return (default ${DEFAULT_SEARCH_LIMIT}). **0 reads the point until it runs dry** — that is how you find out how many there really are, and it is the only way to get results_complete: true. Depth reads one point harder; it never reads wider. For a whole district or city, use geolink_sweep_area.`,
      ),
    offset: z.number().int().min(0).default(0).describe("Skip this many. Paging is free — it is served from the same search."),
    sort_by_distance: z
      .boolean()
      .default(true)
      .describe(
        "Order by straight-line distance from the centre (default true). Set false to keep the source's own relevance order, which is what you want when the query is a name rather than a category — the best match for \"Cairo Tower\" is not the nearest thing called that. For road distance, use geolink_find_nearest.",
      ),
    language: languageParam,
    country: countryParam,
    response_format: responseFormatParam,
  };
  const SearchInput = z.object(SearchShape);

  const OutputShape = {
    query: z.string(),
    resolved_to: XNearSchema.nullable().describe(
      "What a named centre turned out to be. Null when coordinates were given or no centre was named. Names collide — an answer about the wrong Aswan looks exactly like an answer about the right one.",
    ),
    distance_measured_from: LatLngSchema.optional().describe(
      "The point every distance_m is measured from. Absent when no centre was given, in which case the places carry no distance at all rather than one measured from somewhere you did not choose.",
    ),
    results_complete: z
      .boolean()
      .optional()
      .describe(
        "True when the search reached the end of what exists for this query and centre. False means it stopped early — the source had more, or was throttled, or ran out of time — so `total` is a floor. Undefined means the API did not say. Only limit=0 can produce true.",
      ),
    ...PaginationFields,
    places: z.array(XPlaceSchema.partial()),
  };

  server.registerTool(
    "geolink_search_places",
    {
      title: "Find places near one point",
      description: `Find places around one point. Each result carries its name, address, structured address parts (district, governorate, country), coordinates, category, type and timezone, plus — when the place has one — a rating with the count it rests on, a phone number, a website, a photo and today's opening hours.

An absent field means the place genuinely has no such thing. Nothing is filled in with a zero or a placeholder to hide a gap, and a rating never travels without its count.

**Depth is not coverage.** This reads one centre as deep as you ask. A large limit reads that point harder; it never reads the next district. For "every pharmacy in Giza" use geolink_sweep_area.

**How many are there really?** Only limit=0 answers that. It walks the point until the source runs dry and sets results_complete: true. Any other limit stops when it has enough, and results_complete: false means \`total\` is a floor — read it as "at least this many".

Args:
  - query (string): category, brand, or place name.
  - near (string | {lat,lng}): where to look. Put the place here, not in the query.
  - limit (≥0, default ${DEFAULT_SEARCH_LIMIT}; 0 = until it runs dry), offset.
  - sort_by_distance (bool, default true).
  - language, country, response_format ('markdown' | 'json').

Examples:
  - "Pharmacies near Tahrir Square" → query="pharmacy", near="Tahrir Square"
  - "How many pharmacies are in Zamalek?" → query="pharmacy", near="Zamalek", limit=0 → read total, and check results_complete
  - "Find Cairo Tower" → query="Cairo Tower", sort_by_distance=false
  - Every one of them across a city → geolink_sweep_area

Errors: not_found when nothing matches — try a broader query, or the other language.`,
      inputSchema: SearchShape,
      outputSchema: OutputShape,
      annotations: READ_ONLY,
    },
    guarded(async (raw: z.infer<typeof SearchInput>) => {
      const args = SearchInput.parse(raw);
      const lang = pickLang(ctx, args.language);
      const country = pickCountry(ctx, args.country);

      // A name goes over as a name. The API resolves it and says what it
      // picked, which is one round trip fewer than geocoding here and one fact
      // more than that would have given us.
      let near: string | undefined;
      let center: LatLng | undefined;
      if (typeof args.near === "string") {
        const asCoords = parseLatLng(args.near);
        if (asCoords) center = asCoords;
        else near = args.near;
      } else if (args.near) {
        center = args.near;
      }

      const res = await ctx.client.xSearch({
        query: args.query,
        near,
        center,
        language: lang,
        country,
        limit: args.limit,
      });

      const resolvedTo = res.near ?? null;
      // Where the distances are from. With no centre named, the API measures
      // from a default the caller never chose, so those numbers describe
      // nothing they asked about and are dropped rather than shown.
      const measuredFrom: LatLng | undefined = resolvedTo?.location ?? center;
      const places = normalizeXPlaces(res.places).map((p) =>
        measuredFrom ? p : ({ ...p, distance_m: null } as XPlaceOut),
      );

      if (measuredFrom && args.sort_by_distance) {
        places.sort((a, b) => (a.distance_m ?? Number.POSITIVE_INFINITY) - (b.distance_m ?? Number.POSITIVE_INFINITY));
      }

      const page = paginate(places, args.limit === 0 ? places.length : args.limit, args.offset);

      const base = {
        query: args.query,
        resolved_to: resolvedTo,
        ...(measuredFrom ? { distance_measured_from: measuredFrom } : {}),
        ...(res.complete !== undefined ? { results_complete: res.complete } : {}),
        total: page.total,
        count: page.count,
        offset: page.offset,
        has_more: page.has_more,
        ...(page.next_offset !== undefined ? { next_offset: page.next_offset } : {}),
      };

      const where = resolvedTo?.short_address ?? resolvedTo?.address ?? (measuredFrom ? formatLatLng(measuredFrom) : undefined);
      const title = where ? `Places: "${args.query}" near ${where}` : `Places: "${args.query}"`;

      const render = (items: Partial<XPlaceOut>[]): string => {
        if (args.response_format === ResponseFormat.JSON) return JSON.stringify({ ...base, places: items }, null, 2);
        if (!items.length) return `# ${title}\n\n_No results._`;

        // Two different reasons there might be more, and only one of them is
        // about this response. `has_more` means places already found and not
        // shown; `results_complete: false` means the source itself was not
        // read to the end.
        const head = [`# ${title}`];
        if (res.complete === false) {
          head.push(
            "",
            `> **${page.total} found, and there are more.** The search stopped before the source ran out, so this count is a floor. Ask again with \`limit=0\` to read the point until it runs dry.`,
          );
        }
        head.push("");
        const blocks = items.map((p, i) => placeLine(p, args.offset + i + 1));
        const foot = page.has_more
          ? `\n_Showing ${page.count} of ${page.total}. Call again with offset=${page.next_offset} — same search, no extra cost._`
          : res.complete === true
            ? `\n_All ${page.total}. The source has no more for this query and centre._`
            : `\n_Showing all ${page.total} found._`;
        return [...head, ...blocks, foot].join("\n");
      };

      const fitted = fitToLimit(page.items, render, `Use a smaller limit, or offset=${args.offset}.`);
      // Dropping places to fit the response is another way of not showing all
      // of them, and it has to move the pagination with it. Reporting
      // has_more: false beside a list that was cut short tells a caller they
      // are holding everything when they are holding half.
      const shown = fitted.items.length;
      const cut = shown < page.count;
      return ok(
        {
          ...base,
          places: fitted.items,
          count: shown,
          ...(cut
            ? { has_more: true, next_offset: args.offset + shown }
            : {}),
          ...(fitted.truncated ? { truncated: true, truncation_message: fitted.truncation_message } : {}),
        },
        fitted.text,
      );
    }),
  );
}

function placeLine(p: Partial<XPlaceOut>, index: number): string {
  const bits: string[] = [];
  if (p.category) bits.push(p.category);
  if (p.rating) bits.push(`★ ${p.rating.value} (${p.rating.count})`);
  if (p.distance_m !== null && p.distance_m !== undefined) {
    bits.push(p.distance_m < 1000 ? `${p.distance_m} m` : `${(p.distance_m / 1000).toFixed(1)} km`);
  }
  if (p.hours?.open_now === true) bits.push("open now");
  else if (p.hours?.open_now === false) bits.push("closed");
  const lines = [`${index}. **${p.name ?? "(unnamed)"}**${bits.length ? ` — ${bits.join(" · ")}` : ""}`];
  if (p.address) lines.push(`   ${p.address}`);
  if (p.hours?.today) lines.push(`   ${p.hours.today}`);
  const contact = [p.phone, p.website].filter(Boolean).join(" · ");
  if (contact) lines.push(`   ${contact}`);
  if (p.location) lines.push(`   \`${formatLatLng(p.location)}\``);
  return lines.join("\n");
}
