import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  ENDPOINTS,
  MAX_RETRIES,
  RETRY_BASE_MS,
  SERVER_NAME,
  SERVER_VERSION,
  UPSTREAM_PAGE_SIZE,
} from "../constants.js";
import type { Config } from "../config.js";
import type {
  ApiEnvelope,
  LatLng,
  MatrixResult,
  Place,
  RawMatrix,
  RawPlace,
  Route,
} from "../types.js";
import { normalizeMatrix, normalizePlace, normalizePlaces, normalizeRoutes } from "./normalize.js";

export type ErrorKind =
  | "auth"
  | "quota"
  | "not_found"
  | "bad_request"
  | "timeout"
  | "network"
  | "upstream";

/** Error with a machine-readable kind and an agent-actionable hint. */
export class GeoLinkError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly hint: string,
  ) {
    super(message);
    this.name = "GeoLinkError";
  }
}

class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

type Params = Record<string, string | number | undefined>;

function classify(status: number, message: string): GeoLinkError {
  const m = message.toLowerCase();
  if (status === 401 || status === 403 || /api key|unauthori|forbidden|invalid key/.test(m)) {
    return new GeoLinkError(
      `GeoLink rejected the request: ${message}`,
      "auth",
      "Check GEOLINK_API_KEY. Keys are issued at https://geolink-eg.com/register and passed as the `key` query parameter.",
    );
  }
  if (status === 429 || /rate limit|quota|exceed|too many|allowance/.test(m)) {
    return new GeoLinkError(
      `GeoLink rate/quota limit hit: ${message}`,
      "quota",
      "The per-key daily limit or monthly allowance was reached. Wait, reduce call volume (larger grid_spacing_km, smaller limits, nearest_only), or upgrade the plan.",
    );
  }
  if (status === 404 || /not found|no result|zero result|nothing found/.test(m)) {
    return new GeoLinkError(
      `GeoLink found nothing: ${message}`,
      "not_found",
      "Try a broader or differently-spelled query, set language to 'en' or 'ar' explicitly, or add a nearby center point (latitude/longitude).",
    );
  }
  if (status >= 500) {
    return new GeoLinkError(
      `GeoLink upstream error (HTTP ${status}): ${message}`,
      "upstream",
      "Temporary server-side issue. Retry after a short pause.",
    );
  }
  return new GeoLinkError(
    `GeoLink rejected the parameters: ${message}`,
    "bad_request",
    "Verify coordinates are valid decimal degrees (lat -90..90, lng -180..180), the query is non-empty, and language/country are 2-letter codes.",
  );
}

export class GeoLinkClient {
  private readonly cache = new TtlCache<unknown>(CACHE_MAX_ENTRIES, CACHE_TTL_MS);
  private callCount = 0;

  constructor(private readonly cfg: Config) {}

  /** Number of live HTTP calls made by this process (cache hits excluded). */
  get calls(): number {
    return this.callCount;
  }

  /**
   * Retry only what a retry can fix. A timeout, a dropped connection or a 5xx
   * is the upstream having a bad moment; a bad_request or a not_found is the
   * same answer however many times it is asked, and retrying it just spends
   * quota to receive the same refusal. Without this, one blip during a sweep
   * became a permanent hole in the coverage, logged as a failed point.
   */
  private static readonly RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>(["timeout", "network", "upstream"]);

  private async request<T>(path: string, params: Params, cacheKey?: string): Promise<T> {
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit !== undefined) return hit as T;
    }

    let lastError: GeoLinkError | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter: without the random component,
        // every point of a failed sweep retries in the same instant and
        // recreates the burst that caused the failure.
        const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * backoff));
      }
      try {
        return await this.attempt<T>(path, params, cacheKey);
      } catch (err) {
        if (!(err instanceof GeoLinkError) || !GeoLinkClient.RETRYABLE.has(err.kind)) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new GeoLinkError("Request failed", "upstream", "Retry shortly.");
  }

  private async attempt<T>(path: string, params: Params, cacheKey?: string): Promise<T> {

    const url = new URL(path, `${this.cfg.baseUrl}/`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    url.searchParams.set("key", this.cfg.apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    let res: Response;
    try {
      this.callCount++;
      res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new GeoLinkError(
          `GeoLink request timed out after ${this.cfg.timeoutMs} ms`,
          "timeout",
          "Retry, or shrink the request (fewer origins/destinations, smaller area, larger grid spacing).",
        );
      }
      throw new GeoLinkError(
        `Could not reach GeoLink at ${this.cfg.baseUrl}`,
        "network",
        "Check connectivity and GEOLINK_BASE_URL.",
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: ApiEnvelope<T>;
    try {
      body = text ? (JSON.parse(text) as ApiEnvelope<T>) : {};
    } catch {
      throw new GeoLinkError(
        `GeoLink returned a non-JSON response (HTTP ${res.status})`,
        "upstream",
        "The API may be down or behind a maintenance page. Retry shortly.",
      );
    }

    if (!res.ok || body.success === false) {
      const message = typeof body.error === "string" && body.error ? body.error : `HTTP ${res.status}`;
      throw classify(res.status, message);
    }
    if (body.data === undefined || body.data === null) {
      throw new GeoLinkError(
        "GeoLink returned success without a data payload",
        "upstream",
        "Retry; if it persists, report the request to hello@geolink-eg.com.",
      );
    }

    if (cacheKey) this.cache.set(cacheKey, body.data);
    return body.data;
  }

  /* ---------------- Endpoint wrappers ---------------- */

  async geocode(query: string, language: string, country: string): Promise<Place> {
    const key = `geocode|${language}|${country}|${query.trim().toLowerCase()}`;
    const raw = await this.request<RawPlace>(ENDPOINTS.geocode, { query, language, country }, key);
    return normalizePlace(raw);
  }

  async reverseGeocode(lat: number, lng: number, language: string, country: string): Promise<Place> {
    const key = `reverse|${language}|${country}|${lat.toFixed(5)},${lng.toFixed(5)}`;
    const raw = await this.request<RawPlace>(
      ENDPOINTS.reverseGeocode,
      { latitude: lat, longitude: lng, language, country },
      key,
    );
    return normalizePlace(raw);
  }

  /**
   * Place search. `maxResults` is the depth the upstream engine pages to —
   * it returns one page of {@link UPSTREAM_PAGE_SIZE} per request and keeps
   * paging until the target is met or the source runs dry. It is part of the
   * cache key: a shallow response must never be served to a deeper request.
   */
  async textSearch(
    query: string,
    center: LatLng | undefined,
    language: string,
    country: string,
    maxResults: number = UPSTREAM_PAGE_SIZE,
  ): Promise<Place[]> {
    const cacheKey = `search|${language}|${country}|${maxResults}|${query.trim().toLowerCase()}|${center?.lat?.toFixed(5)},${center?.lng?.toFixed(5)}`;
    const raw = await this.request<unknown>(ENDPOINTS.textSearch, {
      query,
      latitude: center?.lat,
      longitude: center?.lng,
      language,
      country,
      max_results: maxResults,
    }, cacheKey);
    return normalizePlaces(raw);
  }

  async directions(origin: LatLng, destination: LatLng, language: string, country: string): Promise<Route[]> {
    const raw = await this.request<unknown>(ENDPOINTS.directions, {
      origin_latitude: origin.lat,
      origin_longitude: origin.lng,
      destination_latitude: destination.lat,
      destination_longitude: destination.lng,
      language,
      country,
    });
    return normalizeRoutes(raw);
  }

  async distanceMatrix(
    origins: LatLng[],
    destinations: LatLng[],
    language: string,
    country: string,
  ): Promise<MatrixResult> {
    const fmt = (pts: LatLng[]): string => pts.map((p) => `${p.lat},${p.lng}`).join(";");
    const raw = await this.request<RawMatrix>(ENDPOINTS.distanceMatrix, {
      origins: fmt(origins),
      destinations: fmt(destinations),
      language,
      country,
    });
    return normalizeMatrix(raw, origins, destinations);
  }
}
