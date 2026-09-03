import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";
import type { MatrixCell, Place, Route } from "../types.js";
import { GeoLinkError } from "./client.js";
import { formatLatLng } from "./geo.js";

/* ------------------------------------------------------------------ */
/* Result builders                                                     */
/* ------------------------------------------------------------------ */

export function ok<T extends object>(structured: T, text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured as Record<string, unknown>,
  };
}

export function fail(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof GeoLinkError) {
    text = `Error (${err.kind}): ${err.message}\nNext step: ${err.hint}`;
  } else if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    text = `Error (validation): ${issues}`;
  } else if (err instanceof Error) {
    text = `Error: ${err.message}`;
  } else {
    text = `Error: ${String(err)}`;
  }
  return { isError: true, content: [{ type: "text", text }] };
}

/** Wrap a tool handler so any thrown error becomes an in-band tool error. */
export function guarded<A, E = unknown>(
  fn: (args: A, extra: E) => Promise<CallToolResult>,
): (args: A, extra: E) => Promise<CallToolResult> {
  return async (args: A, extra: E) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return fail(err);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Character-limit fitting                                             */
/* ------------------------------------------------------------------ */

export interface Fitted<T> {
  items: T[];
  text: string;
  truncated: boolean;
  truncation_message?: string;
}

/**
 * Render `items` via `render`; if the text exceeds CHARACTER_LIMIT, halve the
 * item count until it fits (never below 1), and explain how to get the rest.
 */
export function fitToLimit<T>(
  items: T[],
  render: (items: T[]) => string,
  moreHint: string,
  limit = CHARACTER_LIMIT,
): Fitted<T> {
  let current = items;
  let text = render(current);
  let truncated = false;
  while (text.length > limit && current.length > 1) {
    current = current.slice(0, Math.max(1, Math.floor(current.length / 2)));
    text = render(current);
    truncated = true;
  }
  const out: Fitted<T> = { items: current, text, truncated };
  if (truncated) {
    out.truncation_message = `Output truncated from ${items.length} to ${current.length} items to stay under ${limit} characters. ${moreHint}`;
    out.text = `${text}\n\n_${out.truncation_message}_`;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Markdown renderers                                                  */
/* ------------------------------------------------------------------ */

function addressPartsLine(p: Place): string {
  const parts = [p.address_parts.district, p.address_parts.governorate, p.address_parts.country].filter(Boolean);
  return parts.length ? parts.join(" › ") : "";
}

export function placeMarkdown(p: Place, index?: number): string {
  const head = index === undefined ? `**${p.name || "(unnamed)"}**` : `${index}. **${p.name || "(unnamed)"}**`;
  const lines = [head];
  if (p.address && p.address !== p.name) lines.push(`   ${p.address}`);
  const parts = addressPartsLine(p);
  if (parts) lines.push(`   ${parts}`);
  lines.push(`   📍 ${formatLatLng(p.location)}`);
  if (p.bounds) {
    lines.push(
      `   bounds: NE ${formatLatLng(p.bounds.northeast)} · SW ${formatLatLng(p.bounds.southwest)}`,
    );
  }
  return lines.join("\n");
}

export function placesMarkdown(title: string, places: Place[], startIndex = 1): string {
  if (!places.length) return `# ${title}\n\n_No results._`;
  return [`# ${title}`, "", ...places.map((p, i) => placeMarkdown(p, startIndex + i)), ""].join("\n");
}

export type RouteSummary = Omit<Route, "waypoints">;

export function routeMarkdown(r: RouteSummary, index: number, extra?: string): string {
  const lines = [
    `## Route ${index}${index === 1 ? " (primary)" : ""}`,
    `- **Distance**: ${r.distance_text || `${r.distance_meters} m`} (${r.distance_meters} m)`,
    `- **Duration**: ${r.duration_text || `${r.duration_seconds} s`} (${r.duration_seconds} s)`,
    `- **From**: ${r.origin.name || r.origin.address || "origin"} — ${formatLatLng(r.origin)}`,
    `- **To**: ${r.destination.name || r.destination.address || "destination"} — ${formatLatLng(r.destination)}`,
  ];
  if (r.bounds) {
    lines.push(`- **Bounds**: NE ${formatLatLng(r.bounds.northeast)} · SW ${formatLatLng(r.bounds.southwest)}`);
  }
  if (extra) lines.push(extra);
  return lines.join("\n");
}

export function cellText(c: MatrixCell): string {
  return `${c.distance_text || `${c.distance_meters} m`} / ${c.duration_text || `${c.duration_seconds} s`}`;
}

/* ------------------------------------------------------------------ */
/* GeoJSON                                                             */
/* ------------------------------------------------------------------ */

export interface GeoJsonFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

export function placesToGeoJson(places: Place[]): GeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: places.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.location.lng, p.location.lat] },
      properties: {
        name: p.name,
        address: p.address,
        district: p.address_parts.district,
        governorate: p.address_parts.governorate,
        country: p.address_parts.country,
      },
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

export interface Page<T> {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  items: T[];
}

export function paginate<T>(all: T[], limit: number, offset: number): Page<T> {
  const items = all.slice(offset, offset + limit);
  const has_more = offset + items.length < all.length;
  const page: Page<T> = { total: all.length, count: items.length, offset, has_more, items };
  if (has_more) page.next_offset = offset + items.length;
  return page;
}
