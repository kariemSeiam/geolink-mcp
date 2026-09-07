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

/**
 * A place as the x surface describes it.
 *
 * Deliberately a separate type rather than optional fields bolted onto
 * `Place`. `Place` is what v1 and v2 return and what published clients already
 * read; adding ten optional keys to it would make every consumer's type say
 * "this might have a rating" about results that never can.
 *
 * Every key is always present here, `null` where the place genuinely has none.
 * That is the surface's own contract and it is worth keeping: a caller reads a
 * field without first checking whether it exists, and an absent rating means
 * the place is unrated rather than that we failed to read one. Measured, that
 * distinction is the common case - ratings sit on 100% of restaurants and 10%
 * of police stations.
 */
export interface XPlace {
  /** Stable identifier. The thing that makes deduplication across calls work. */
  place_id: string | null;
  short_address: string;
  address: string | null;
  address_parts: AddressParts;
  location: LatLng;
  category: string | null;
  /** Machine-readable kind, e.g. PHARMACY. */
  type: string | null;
  /** Never a bare average: the count it rests on travels with it, or neither does. */
  rating: { value: number; count: number } | null;
  phone: string | null;
  website: string | null;
  photo: string | null;
  hours: { today?: string; status?: string; open_now?: boolean } | null;
  timezone: string | null;
  /** Straight-line metres from wherever the search was centred. */
  distance_m: number | null;
  /** Road distance and duration. x/nearest only; absent everywhere else. */
  travel?: XTravel;
}

/** What a name resolved to, echoed back so the caller can check it. */
/**
 * What the road actually says, for a place x/nearest measured.
 *
 * It sits beside the place's own `distance_m`, which stays a straight line.
 * Two numbers with the same units meaning different things is exactly the
 * confusion this tool exists to resolve, so neither one overwrites the other.
 */
export interface XTravel {
  distance_m: number;
  distance_text: string;
  duration_s: number;
  duration_text: string;
}

export interface XNear {
  short_address: string | null;
  address: string | null;
  address_parts: AddressParts;
  location: LatLng;
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
  /**
   * How much of the matrix was actually measured.
   *
   * A matrix too large for the API's time budget returns normally with the
   * cells it reached and the rest as zeros. A cell is four numbers on the
   * wire, so one that was never measured looks exactly like two points zero
   * metres apart — present only when the API told us, which older deployments
   * do not.
   */
  coverage?: {
    requested: number;
    /** Cells the API had time to start. */
    attempted: number;
    /** Cells that came back with a route. */
    measured: number;
    /** True when every requested cell was attempted. */
    complete: boolean;
  };
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
