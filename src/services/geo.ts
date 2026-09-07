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

