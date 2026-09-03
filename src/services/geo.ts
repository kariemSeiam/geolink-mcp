import { KM_PER_DEG_LAT } from "../constants.js";
import type { Bounds, LatLng, Place } from "../types.js";

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function round(n: number, decimals = 6): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/**
 * Implied average speed for a leg, in km/h, or null when it cannot be computed.
 *
 * The companion to the straight-line check. A distance can be self-consistent
 * and still be paired with the wrong duration, and the tell is a speed no
 * vehicle achieves on the ground being described. Cheap, physical, and it
 * catches a unit error as readily as a mismatch.
 */
export function impliedSpeedKmh(distanceMeters: number, durationSeconds: number): number | null {
  if (!(distanceMeters > 0) || !(durationSeconds > 0)) return null;
  return (distanceMeters / 1000) / (durationSeconds / 3600);
}

/**
 * Speeds outside this band are not journeys anyone takes by road. The ceiling
 * sits above motorway traffic and well below anything a data error produces;
 * the floor is slower than walking, which is what a duration attached to the
 * wrong distance tends to look like.
 */
export const PLAUSIBLE_SPEED_KMH = { min: 1, max: 180 } as const;

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Parse "lat,lng" (also tolerates "lat lng", "lat;lng", surrounding parens/spaces). */
export function parseLatLng(input: string): LatLng | null {
  const m = input
    .trim()
    .replace(/^[(\[]|[)\]]$/g, "")
    .match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number.parseFloat(m[1] ?? "");
  const lng = Number.parseFloat(m[2] ?? "");
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

export function formatLatLng(p: LatLng, decimals = 5): string {
  return `${p.lat.toFixed(decimals)}, ${p.lng.toFixed(decimals)}`;
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

export function boundsFromCenterRadius(center: LatLng, radiusKm: number): Bounds {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.max(0.05, Math.cos(toRad(center.lat))));
  return {
    northeast: { lat: round(center.lat + dLat), lng: round(center.lng + dLng) },
    southwest: { lat: round(center.lat - dLat), lng: round(center.lng - dLng) },
  };
}

export function expandBounds(b: Bounds, paddingKm: number): Bounds {
  if (paddingKm <= 0) return b;
  const midLat = (b.northeast.lat + b.southwest.lat) / 2;
  const dLat = paddingKm / KM_PER_DEG_LAT;
  const dLng = paddingKm / (KM_PER_DEG_LAT * Math.max(0.05, Math.cos(toRad(midLat))));
  return {
    northeast: { lat: round(b.northeast.lat + dLat), lng: round(b.northeast.lng + dLng) },
    southwest: { lat: round(b.southwest.lat - dLat), lng: round(b.southwest.lng - dLng) },
  };
}

export function boundsCenter(b: Bounds): LatLng {
  return {
    lat: (b.northeast.lat + b.southwest.lat) / 2,
    lng: (b.northeast.lng + b.southwest.lng) / 2,
  };
}

/** Width × height of a bounding box in kilometres. */
export function boundsSizeKm(b: Bounds): { width_km: number; height_km: number } {
  const midLat = (b.northeast.lat + b.southwest.lat) / 2;
  return {
    width_km: round(haversineKm({ lat: midLat, lng: b.southwest.lng }, { lat: midLat, lng: b.northeast.lng }), 2),
    height_km: round(haversineKm({ lat: b.southwest.lat, lng: b.southwest.lng }, { lat: b.northeast.lat, lng: b.southwest.lng }), 2),
  };
}

export function inBounds(p: LatLng, b: Bounds): boolean {
  return (
    p.lat >= b.southwest.lat &&
    p.lat <= b.northeast.lat &&
    p.lng >= b.southwest.lng &&
    p.lng <= b.northeast.lng
  );
}

/* ------------------------------------------------------------------ */
/* Grid tiling — the coverage-sweep engine                             */
/* ------------------------------------------------------------------ */

export interface GridOptions {
  /** Restrict points to a circle (used for center+radius areas). */
  circle?: { center: LatLng; radiusKm: number };
}

/**
 * Lay a square grid of query points over a bounding box, one point at the
 * centre of each `spacingKm × spacingKm` cell. Longitude spacing is corrected
 * for latitude so cells stay square on the ground. Guarantees ≥ 1 point.
 */
export function buildGrid(b: Bounds, spacingKm: number, opts: GridOptions = {}): LatLng[] {
  const { width_km, height_km } = boundsSizeKm(b);
  const cols = Math.max(1, Math.ceil(width_km / spacingKm));
  const rows = Math.max(1, Math.ceil(height_km / spacingKm));
  const latSpan = b.northeast.lat - b.southwest.lat;
  const lngSpan = b.northeast.lng - b.southwest.lng;

  const points: LatLng[] = [];
  for (let r = 0; r < rows; r++) {
    const lat = b.southwest.lat + ((r + 0.5) * latSpan) / rows;
    for (let c = 0; c < cols; c++) {
      const lng = b.southwest.lng + ((c + 0.5) * lngSpan) / cols;
      const p = { lat: round(lat), lng: round(lng) };
      if (opts.circle && haversineKm(opts.circle.center, p) > opts.circle.radiusKm) continue;
      points.push(p);
    }
  }
  if (points.length === 0) points.push(opts.circle?.center ?? boundsCenter(b));
  return points;
}

/** Smallest spacing (in km, 1 decimal) that keeps the grid at or under `maxPoints`. */
export function suggestSpacingKm(b: Bounds, maxPoints: number, opts: GridOptions = {}): number {
  const { width_km, height_km } = boundsSizeKm(b);
  // Start from the analytical estimate, then verify against the real generator.
  let spacing = Math.max(0.5, Math.sqrt((width_km * height_km) / Math.max(1, maxPoints)));
  for (let i = 0; i < 40; i++) {
    const s = Math.ceil(spacing * 10) / 10;
    if (buildGrid(b, s, opts).length <= maxPoints) return s;
    spacing *= 1.1;
  }
  // Fallback: increment by 0.1 until it fits (guarantees termination)
  let s = Math.ceil(spacing * 10) / 10;
  while (buildGrid(b, s, opts).length > maxPoints) {
    s = Math.round((s + 0.1) * 10) / 10;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Polyline (Google encoded polyline algorithm, precision 5)           */
/* ------------------------------------------------------------------ */

function encodeSigned(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

export function encodePolyline(points: [number, number][], precision = 5): string {
  const f = 10 ** precision;
  let prevLat = 0;
  let prevLng = 0;
  let out = "";
  for (const [lat, lng] of points) {
    const la = Math.round(lat * f);
    const lo = Math.round(lng * f);
    out += encodeSigned(la - prevLat) + encodeSigned(lo - prevLng);
    prevLat = la;
    prevLng = lo;
  }
  return out;
}

export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const f = 10 ** precision;
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const which of ["lat", "lng"] as const) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === "lat") lat += delta;
      else lng += delta;
    }
    out.push([lat / f, lng / f]);
  }
  return out;
}

/** Evenly sample a path down to at most `max` points, always keeping first and last. */
export function samplePoints<T>(points: T[], max: number): T[] {
  if (max < 2 || points.length <= max) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    const p = points[Math.round(i * step)];
    if (p !== undefined) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Names & dedup (Arabic-aware)                                        */
/* ------------------------------------------------------------------ */

/**
 * Normalize a place name for comparison: lower-case, strip Arabic tashkeel,
 * fold alef/ta-marbuta/alef-maqsura variants, drop punctuation, collapse space.
 */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // tashkeel + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Remove duplicate places: same normalized name within `thresholdMeters`,
 * or identical coordinates at ~1 m precision regardless of name.
 */
export function dedupePlaces(places: Place[], thresholdMeters: number): Place[] {
  const byName = new Map<string, Place[]>();
  const exactCoords = new Set<string>();
  const out: Place[] = [];

  for (const p of places) {
    const coordKey = `${p.location.lat.toFixed(5)},${p.location.lng.toFixed(5)}|${normalizeName(p.address)}`;
    if (exactCoords.has(coordKey)) continue;

    const key = normalizeName(p.name || p.address);
    const bucket = byName.get(key) ?? [];
    const isDup =
      thresholdMeters > 0 &&
      key.length > 0 &&
      bucket.some((q) => haversineKm(q.location, p.location) * 1000 <= thresholdMeters);
    if (isDup) continue;

    bucket.push(p);
    byName.set(key, bucket);
    exactCoords.add(coordKey);
    out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Concurrency                                                         */
/* ------------------------------------------------------------------ */

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await fn(item, i);
      done++;
      onProgress?.(done, items.length);
    }
  });
  await Promise.all(workers);
  return results;
}
