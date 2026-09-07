export const SERVER_NAME = "geolink-mcp";
export const SERVER_VERSION = "1.6.1";

export const DEFAULT_BASE_URL = "https://www.geolink-eg.com";
export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_COUNTRY = "";
/**
 * The credential for the x surface.
 *
 * Not a per-user secret and not meant to be: x carries no billing and no usage
 * log, so there is nothing to attribute to a caller and no per-caller key to
 * hold. A caller is identified by their own GEOLINK_API_KEY on the v1/v2
 * tools; this is how those tools reach x on their behalf without asking them
 * for a second credential they would have no way to obtain.
 */
export const DEFAULT_X_KEY = "pigo1618";

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
 * Depth past which a single place search is worth a second thought — not a
 * limit. Nothing refuses a larger number; the search simply costs one upstream
 * request per {@link UPSTREAM_PAGE_SIZE} results and stops early when the area
 * runs out. Tools quote this in their docs so an agent can size a request
 * against its cost instead of guessing.
 */
export const DEEP_SEARCH_ADVISORY = 200;

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

  // The x surface. Same host, its own credential (see DEFAULT_X_KEY), and a
  // richer record: fourteen fields per place against v2's four, with a stable
  // place_id that makes deduplicating across calls possible for the first
  // time. Nothing here replaces geocode, reverse_geocode or directions - x has
  // no equivalent for those, and they stay on v2.
  xSearch: "/api/x/search",
  xSweep: "/api/x/sweep",
  xNearest: "/api/x/nearest",
} as const;

/** HTTP transport: drop a session after this long with no request on it. */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** How often idle sessions are swept. */
export const SESSION_REAP_INTERVAL_MS = 5 * 60 * 1000;

/** Retries for transient upstream failures (timeout, network, 5xx) only. */
export const MAX_RETRIES = 2;
/** First backoff step; doubles per attempt, with jitter added on top. */
export const RETRY_BASE_MS = 300;
