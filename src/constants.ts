export const SERVER_NAME = "geolink-mcp";
export const SERVER_VERSION = "1.1.0";

export const DEFAULT_BASE_URL = "https://www.geolink-eg.com";
export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_COUNTRY = "";
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Max characters of text returned by a single tool call before truncation kicks in. */
export const CHARACTER_LIMIT = 25_000;

/**
 * Results the upstream place-search engine returns per page. It pages
 * internally to reach whatever `max_results` asks for, so this is the
 * granularity of depth, not a ceiling on what a search can return.
 */
export const UPSTREAM_PAGE_SIZE = 20;

/**
 * Depth ceiling this server will request from a single place search. Depth
 * costs upstream requests (`ceil(max_results / UPSTREAM_PAGE_SIZE)` of them),
 * so tools ask for what the caller actually needs rather than the maximum.
 */
export const MAX_SEARCH_DEPTH = 200;

/** Kilometres per degree of latitude (constant); longitude scales with cos(lat). */
export const KM_PER_DEG_LAT = 111.32;

export const DEFAULT_MAX_MATRIX_CELLS = 100;
export const DEFAULT_SWEEP_MAX_POINTS = 200;
export const DEFAULT_SWEEP_CONCURRENCY = 4;

/**
 * Ceiling on simultaneous upstream requests during a sweep.
 *
 * A sweep runs several grid points in parallel, and each point that asks for
 * depth makes its own parallel requests upstream, so the two multiply. The
 * upstream reaches its source from one address without proxy rotation, and a
 * wide burst of near-identical requests is the pattern most likely to get
 * throttled. Tile concurrency is therefore divided down as depth rises, so
 * this product never grows past this number. At default depth nothing
 * changes: one request per point, `sweepConcurrency` points at a time.
 */
export const SWEEP_OUTBOUND_BUDGET = 8;

/**
 * How many requests the upstream engine runs in parallel to satisfy one deep
 * search. Mirrors its server-side batch width; used only to predict how many
 * requests a single deep grid point puts in flight.
 */
export const SWEEP_CLIENT_BATCH = 5;
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

/** HTTP transport: drop a session after this long with no request on it. */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** How often idle sessions are swept. */
export const SESSION_REAP_INTERVAL_MS = 5 * 60 * 1000;
