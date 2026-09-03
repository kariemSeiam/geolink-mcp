import type {
  Bounds,
  LatLng,
  MatrixCell,
  MatrixResult,
  Place,
  RawBounds,
  RawLatLng,
  RawMatrix,
  RawMatrixCell,
  RawMatrixEndpoint,
  RawPlace,
  RawRoute,
  RawRouteEndpoint,
  Route,
} from "../types.js";

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function normalizeLatLng(raw: RawLatLng | undefined): LatLng {
  return { lat: num(raw?.lat), lng: num(raw?.lng) };
}

/**
 * GeoLink examples occasionally list NE/SW corners swapped. Rebuild the box
 * from min/max so downstream code can trust northeast ≥ southwest.
 */
export function normalizeBounds(raw: RawBounds | undefined): Bounds | null {
  if (!raw?.northeast || !raw?.southwest) return null;
  const a = normalizeLatLng(raw.northeast);
  const b = normalizeLatLng(raw.southwest);
  if (a.lat === 0 && a.lng === 0 && b.lat === 0 && b.lng === 0) return null;
  return {
    northeast: { lat: Math.max(a.lat, b.lat), lng: Math.max(a.lng, b.lng) },
    southwest: { lat: Math.min(a.lat, b.lat), lng: Math.min(a.lng, b.lng) },
  };
}

export function normalizePlace(raw: RawPlace): Place {
  const address = str(raw.address);
  const name = str(raw.short_address) || address;
  const bounds = normalizeBounds(raw.bounds);
  const place: Place = {
    name,
    address,
    address_parts: {
      district: str(raw.address_parts?.district),
      governorate: str(raw.address_parts?.governorate),
      country: str(raw.address_parts?.country).toUpperCase(),
    },
    location: normalizeLatLng(raw.location),
  };
  if (bounds) place.bounds = bounds;
  return place;
}

export function normalizePlaces(raw: unknown): Place[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is RawPlace => typeof p === "object" && p !== null)
    .map(normalizePlace)
    .filter((p) => !(p.location.lat === 0 && p.location.lng === 0));
}

function normalizeEndpoint(raw: RawRouteEndpoint | undefined): Route["origin"] {
  const address = str(raw?.address);
  return {
    ...normalizeLatLng(raw),
    name: str(raw?.short_address) || address,
    address,
  };
}

function normalizeWaypoints(raw: unknown[] | undefined): [number, number][] {
  if (!Array.isArray(raw)) return [];
  const out: [number, number][] = [];
  for (const wp of raw) {
    if (Array.isArray(wp) && wp.length >= 2) {
      out.push([num(wp[0]), num(wp[1])]);
    } else if (typeof wp === "object" && wp !== null) {
      const o = wp as RawLatLng;
      out.push([num(o.lat), num(o.lng)]);
    }
  }
  return out;
}

export function normalizeRoute(raw: RawRoute): Route {
  return {
    distance_meters: num(raw.distance?.meters),
    distance_text: str(raw.distance?.text),
    duration_seconds: num(raw.duration?.seconds),
    duration_text: str(raw.duration?.text),
    bounds: normalizeBounds(raw.bounds),
    origin: normalizeEndpoint(raw.origin),
    destination: normalizeEndpoint(raw.destination),
    waypoints: normalizeWaypoints(raw.waypoints),
  };
}

export function normalizeRoutes(raw: unknown): Route[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is RawRoute => typeof r === "object" && r !== null)
    .map(normalizeRoute);
}

function normalizeMatrixEndpoint(raw: RawMatrixEndpoint): LatLng {
  const c = raw.coordinates;
  if (Array.isArray(c) && c.length >= 2) return { lat: num(c[0]), lng: num(c[1]) };
  return { lat: 0, lng: 0 };
}

function normalizeCell(raw: RawMatrixCell | undefined): MatrixCell {
  return {
    distance_meters: num(raw?.distance_meters),
    distance_text: str(raw?.distance_text),
    duration_seconds: num(raw?.duration_seconds),
    duration_text: str(raw?.duration_text),
  };
}

export function normalizeMatrix(raw: RawMatrix, fallbackOrigins: LatLng[], fallbackDestinations: LatLng[]): MatrixResult {
  const origins = Array.isArray(raw.origins) && raw.origins.length
    ? raw.origins.map(normalizeMatrixEndpoint)
    : fallbackOrigins;
  const destinations = Array.isArray(raw.destinations) && raw.destinations.length
    ? raw.destinations.map(normalizeMatrixEndpoint)
    : fallbackDestinations;

  const matrix: MatrixCell[][] = (raw.distance_matrix ?? []).map((row) =>
    (Array.isArray(row) ? row : []).map(normalizeCell),
  );

  // Trust GeoLink's nearest index when present; otherwise derive it by duration.
  let nearest = Array.isArray(raw.nearest_destination_index)
    ? raw.nearest_destination_index.map((i) => num(i, -1))
    : [];
  if (nearest.length !== matrix.length) {
    nearest = matrix.map((row) => {
      let best = -1;
      let bestVal = Number.POSITIVE_INFINITY;
      row.forEach((cell, i) => {
        if (cell.duration_seconds > 0 && cell.duration_seconds < bestVal) {
          bestVal = cell.duration_seconds;
          best = i;
        }
      });
      return best;
    });
  }

  return { origins, destinations, matrix, nearest_destination_index: nearest };
}
