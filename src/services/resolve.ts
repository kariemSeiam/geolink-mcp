import { z } from "zod";
import type { Config } from "../config.js";
import type { LatLng, ResolvedLocation } from "../types.js";
import { GeoLinkClient, GeoLinkError } from "./client.js";
import { formatLatLng, parseLatLng } from "./geo.js";

/* ------------------------------------------------------------------ */
/* Reusable schema fragments                                           */
/* ------------------------------------------------------------------ */

export const LatLngSchema = z
  .object({
    lat: z.number().min(-90).max(90).describe("Latitude in decimal degrees"),
    lng: z.number().min(-180).max(180).describe("Longitude in decimal degrees"),
  })
  .strict();

export const LocationInputSchema = z
  .union([z.string().min(1).max(300), LatLngSchema])
  .describe(
    'A location as either coordinates ("30.0444,31.2357" or {lat, lng}) or a place name / address to geocode ("Cairo Tower", "مدينة نصر"). Coordinates are used directly; names cost one geocode call (cached).',
  );

export type LocationInput = z.infer<typeof LocationInputSchema>;

export const languageParam = z
  .string()
  .length(2)
  .optional()
  .describe('Two-letter language for results, e.g. "ar" or "en". Defaults to the server default (usually "ar").');

export const countryParam = z
  .string()
  .length(2)
  .optional()
  .describe('Two-letter country code to focus results / routing, e.g. "eg". Defaults to the server default (usually "eg").');

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export const responseFormatParam = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Text rendering: 'markdown' (readable) or 'json' (raw). Structured JSON is always attached as structuredContent regardless.");

export const BoundsSchema = z
  .object({ northeast: LatLngSchema, southwest: LatLngSchema })
  .strict();

/* ------------------------------------------------------------------ */
/* Location resolution                                                 */
/* ------------------------------------------------------------------ */

export interface ToolContext {
  client: GeoLinkClient;
  cfg: Config;
}

export function pickLang(ctx: ToolContext, language?: string): string {
  return (language ?? ctx.cfg.defaultLanguage).toLowerCase();
}

export function pickCountry(ctx: ToolContext, country?: string): string {
  return (country ?? ctx.cfg.defaultCountry).toLowerCase();
}

/**
 * Turn a LocationInput into coordinates. Strings that parse as "lat,lng" are
 * used as-is; anything else is geocoded (one cached API call).
 */
export async function resolveLocation(
  ctx: ToolContext,
  input: LocationInput,
  language: string,
  country: string,
): Promise<ResolvedLocation> {
  if (typeof input !== "string") {
    return { ...input, input: formatLatLng(input), label: formatLatLng(input), source: "coordinates" };
  }
  const coords = parseLatLng(input);
  if (coords) {
    return { ...coords, input, label: formatLatLng(coords), source: "coordinates" };
  }
  const place = await ctx.client.geocode(input, language, country);
  if (place.location.lat === 0 && place.location.lng === 0) {
    throw new GeoLinkError(
      `Could not geocode "${input}"`,
      "not_found",
      "Pass explicit coordinates, add a district/governorate to the name, or try the other language.",
    );
  }
  return {
    ...place.location,
    input,
    label: place.name || place.address || input,
    source: "geocode",
  };
}

export async function resolveMany(
  ctx: ToolContext,
  inputs: LocationInput[],
  language: string,
  country: string,
): Promise<ResolvedLocation[]> {
  // Sequential on purpose: geocode hits are cached, and this keeps burst
  // pressure on the API low for large candidate lists.
  const out: ResolvedLocation[] = [];
  for (const input of inputs) out.push(await resolveLocation(ctx, input, language, country));
  return out;
}

export function toLatLng(r: ResolvedLocation): LatLng {
  return { lat: r.lat, lng: r.lng };
}
