import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guarded, ok, placeMarkdown } from "../services/format.js";
import {
  countryParam,
  languageParam,
  pickCountry,
  pickLang,
  ResponseFormat,
  responseFormatParam,
  type ToolContext,
} from "../services/resolve.js";
import { PlaceSchema } from "../services/schemas.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerGeocodingTools(server: McpServer, ctx: ToolContext): void {
  /* ---------------------------------------------------------------- */
  /* geolink_geocode                                                    */
  /* ---------------------------------------------------------------- */
  const GeocodeShape = {
    query: z
      .string()
      .min(1)
      .max(300)
      .describe('Address or place name, e.g. "Cairo Tower, Zamalek" or "مدينة نصر"'),
    language: languageParam,
    country: countryParam,
    response_format: responseFormatParam,
  };
  const GeocodeInput = z.object(GeocodeShape);

  server.registerTool(
    "geolink_geocode",
    {
      title: "Geocode an address",
      description: `Convert an address or place name into coordinates, with structured Egyptian address parts (district, governorate, country) and a viewport bounding box.

Returns exactly one best match. For a ranked list of candidates use geolink_search_places instead.

Args:
  - query (string): Address or place name. Arabic and English both work.
  - language ('ar' | 'en' | ...): Result language. Default: server default ("ar").
  - country (2-letter): Country focus. Default: server default ("eg").
  - response_format ('markdown' | 'json'): Text rendering. Default: markdown.

Returns (structuredContent):
  {
    "name": string,            // short name, e.g. "Cairo Tower"
    "address": string,         // full formatted address
    "address_parts": { "district": string, "governorate": string, "country": "EG" },
    "location": { "lat": number, "lng": number },
    "bounds": { "northeast": {lat,lng}, "southwest": {lat,lng} }   // viewport, if available
  }

Examples:
  - "Where is Cairo Tower?" -> query="Cairo Tower"
  - "Coordinates of Smart Village, Giza" -> query="Smart Village, Giza", language="en"
  - Don't use for: turning coordinates into an address (use geolink_reverse_geocode).

Errors: not_found if nothing matches — try adding the district/governorate or switching language.`,
      inputSchema: GeocodeShape,
      outputSchema: PlaceSchema.shape,
      annotations: READ_ONLY,
    },
    guarded(async (raw: z.infer<typeof GeocodeInput>) => {
      const args = GeocodeInput.parse(raw);
      const place = await ctx.client.geocode(args.query, pickLang(ctx, args.language), pickCountry(ctx, args.country));
      const text =
        args.response_format === ResponseFormat.JSON
          ? JSON.stringify(place, null, 2)
          : `# Geocode: "${args.query}"\n\n${placeMarkdown(place)}`;
      return ok(place, text);
    }),
  );

  /* ---------------------------------------------------------------- */
  /* geolink_reverse_geocode                                            */
  /* ---------------------------------------------------------------- */
  const ReverseShape = {
    latitude: z.number().min(-90).max(90).describe("Latitude in decimal degrees, e.g. 30.0459"),
    longitude: z.number().min(-180).max(180).describe("Longitude in decimal degrees, e.g. 31.2243"),
    language: languageParam,
    country: countryParam,
    response_format: responseFormatParam,
  };
  const ReverseInput = z.object(ReverseShape);

  server.registerTool(
    "geolink_reverse_geocode",
    {
      title: "Reverse geocode coordinates",
      description: `Convert latitude/longitude into a human-readable address with structured Egyptian address parts (district, governorate, country) and a viewport bounding box.

Args:
  - latitude (number), longitude (number): The point to describe.
  - language ('ar' | 'en' | ...): Result language. Default: server default ("ar").
  - country (2-letter): Country focus. Default: server default ("eg").
  - response_format ('markdown' | 'json'): Text rendering. Default: markdown.

Returns (structuredContent): same Place shape as geolink_geocode:
  { name, address, address_parts: {district, governorate, country}, location: {lat, lng}, bounds? }

Examples:
  - "What's at 30.0459, 31.2243?" -> latitude=30.0459, longitude=31.2243
  - "Which district is this delivery point in?" -> reverse geocode, then read address_parts.district
  - Don't use for: finding places by name (use geolink_geocode or geolink_search_places).`,
      inputSchema: ReverseShape,
      outputSchema: PlaceSchema.shape,
      annotations: READ_ONLY,
    },
    guarded(async (raw: z.infer<typeof ReverseInput>) => {
      const args = ReverseInput.parse(raw);
      const place = await ctx.client.reverseGeocode(
        args.latitude,
        args.longitude,
        pickLang(ctx, args.language),
        pickCountry(ctx, args.country),
      );
      const text =
        args.response_format === ResponseFormat.JSON
          ? JSON.stringify(place, null, 2)
          : `# Reverse geocode: ${args.latitude}, ${args.longitude}\n\n${placeMarkdown(place)}`;
      return ok(place, text);
    }),
  );
}
