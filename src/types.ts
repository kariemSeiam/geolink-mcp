/* ------------------------------------------------------------------ */
/* Normalized shapes (what this server returns to agents)              */
/* ------------------------------------------------------------------ */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Bounds {
  northeast: LatLng;
  southwest: LatLng;
}

export interface AddressParts {
  district: string;
  governorate: string;
  /** ISO 3166-1 alpha-2, upper-case (e.g. "EG"). */
  country: string;
}

export interface Place {
  /** Short, human-friendly name (GeoLink `short_address`). */
  name: string;
  /** Full formatted address. */
  address: string;
  address_parts: AddressParts;
  location: LatLng;
  /** Viewport bounds when the endpoint provides them (geocode / reverse). */
  bounds?: Bounds;
}

export interface RouteEndpoint extends LatLng {
  name: string;
  address: string;
}

export interface Route {
  distance_meters: number;
  distance_text: string;
  duration_seconds: number;
  duration_text: string;
  bounds: Bounds | null;
  origin: RouteEndpoint;
  destination: RouteEndpoint;
  /** Full path as [lat, lng] pairs. May be large. */
  waypoints: [number, number][];
}

export interface MatrixCell {
  distance_meters: number;
  distance_text: string;
  duration_seconds: number;
  duration_text: string;
}

export interface MatrixResult {
  origins: LatLng[];
  destinations: LatLng[];
  /** matrix[originIndex][destinationIndex] */
  matrix: MatrixCell[][];
  /** For each origin, the index of the fastest destination (computed by GeoLink). */
  nearest_destination_index: number[];
}

/** A location after resolving user input (coordinates or a geocoded name). */
export interface ResolvedLocation extends LatLng {
  /** What the caller passed in, for echoing back. */
  input: string;
  /** Human label: the geocoded name, or the coordinate string. */
  label: string;
  source: "coordinates" | "geocode";
}

/* ------------------------------------------------------------------ */
/* Raw GeoLink API shapes (defensive: everything optional)             */
/* ------------------------------------------------------------------ */

export interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

export interface RawLatLng {
  lat?: number | string;
  lng?: number | string;
}

export interface RawBounds {
  northeast?: RawLatLng;
  southwest?: RawLatLng;
}

export interface RawAddressParts {
  district?: string;
  governorate?: string;
  country?: string;
}

export interface RawPlace {
  address?: string;
  short_address?: string;
  address_parts?: RawAddressParts;
  location?: RawLatLng;
  bounds?: RawBounds;
}

export interface RawRouteEndpoint extends RawLatLng {
  address?: string;
  short_address?: string;
}

export interface RawRoute {
  distance?: { meters?: number; text?: string };
  duration?: { seconds?: number; text?: string };
  bounds?: RawBounds;
  origin?: RawRouteEndpoint;
  destination?: RawRouteEndpoint;
  waypoints?: unknown[];
}

export interface RawMatrixEndpoint {
  coordinates?: unknown;
  short_name?: string;
  full_address?: string;
}

export interface RawMatrixCell {
  distance_meters?: number;
  distance_text?: string;
  duration_seconds?: number;
  duration_text?: string;
}

export interface RawMatrix {
  origins?: RawMatrixEndpoint[];
  destinations?: RawMatrixEndpoint[];
  distance_matrix?: RawMatrixCell[][];
  nearest_destination_index?: number[];
}
