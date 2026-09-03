export const SERVER_NAME = "geolink-mcp";
export const SERVER_VERSION = "1.0.2";

export const DEFAULT_BASE_URL = "https://www.geolink-eg.com";
export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_COUNTRY = "";
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Max characters of text returned by a single tool call before truncation kicks in. */
export const CHARACTER_LIMIT = 25_000;

/** Kilometres per degree of latitude (constant); longitude scales with cos(lat). */
export const KM_PER_DEG_LAT = 111.32;

export const DEFAULT_MAX_MATRIX_CELLS = 100;
export const DEFAULT_SWEEP_MAX_POINTS = 200;
export const DEFAULT_SWEEP_CONCURRENCY = 4;
export const DEFAULT_DEDUPE_METERS = 60;
export const DEFAULT_GRID_SPACING_KM = 3;

/** In-process cache for geocode / reverse-geocode lookups. */
export const CACHE_MAX_ENTRIES = 500;
export const CACHE_TTL_MS = 10 * 60 * 1000;

export const ENDPOINTS = {
  geocode: "/api/v2/geocode",
  reverseGeocode: "/api/v2/reverse_geocode",
  textSearch: "/api/v2/text_search",
  directions: "/api/v2/directions",
  distanceMatrix: "/api/v1/distance_matrix",
} as const;
