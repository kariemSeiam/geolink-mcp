import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  ENDPOINTS,
  MAX_RETRIES,
  RETRY_BASE_MS,
  SERVER_NAME,
  SERVER_VERSION,
  SWEEP_CACHE_ENTRIES,
  SWEEP_CACHE_TTL_MS,
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
  XNear,
  XPlace,
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

export class TtlCache<V> {
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

/**
 * What the API says went wrong, in a token rather than a sentence.
 *
 * Every failure that reaches the engine now carries `X-GeoLink-Error-Code`,
 * and so does the guard around it — a missing key, a bad key, a missing
 * parameter. This used to match the error *text* with regular expressions that
 * never matched the API's actual wording, so a genuinely missing address fell
 * through to `status >= 500` and was reported as a temporary fault worth
 * retrying. It was retried twice, with backoff, for a place that does not
 * exist.
 */
const BY_CODE: Record<string, { kind: ErrorKind; hint: string }> = {
  missing_key: { kind: "auth", hint: "Set GEOLINK_API_KEY. Keys are issued at https://geolink-eg.com/register." },
  invalid_key: { kind: "auth", hint: "That key was rejected. Check GEOLINK_API_KEY, or issue a new one at https://geolink-eg.com." },
  access_denied: { kind: "auth", hint: "This key is not allowed to reach that endpoint." },
  quota_exceeded: { kind: "quota", hint: "The plan's allowance is spent. Wait, reduce call volume, or upgrade." },
  missing_param: { kind: "bad_request", hint: "The message names the parameter that is missing." },
  invalid_params: { kind: "bad_request", hint: "The message names what was wrong with it." },
  invalid_location: { kind: "bad_request", hint: "Check the coordinates: latitude -90..90, longitude -180..180." },
  location_not_found: { kind: "not_found", hint: "That query did not resolve to a place. Try a different spelling, or give coordinates." },
  no_results: { kind: "not_found", hint: "The search ran and found nothing there. Broaden the query or widen the area." },
  route_not_available: { kind: "not_found", hint: "No route between those points. Check they are both reachable by road." },
  service_temporary: { kind: "upstream", hint: "The source is busy or refused us. Wait before retrying — retrying at once is what causes it." },
  network_error: { kind: "upstream", hint: "A connection to the source failed. Retry shortly." },
  timeout: { kind: "timeout", hint: "It took too long. Ask for less, or split the request." },
  data_error: { kind: "upstream", hint: "The source answered something we could not read. Retry; report it if it persists." },
  processing_error: { kind: "upstream", hint: "Something failed on our side. Retry shortly." },
  unexpected_error: { kind: "upstream", hint: "Something failed on our side. Retry shortly." },
};

function classify(status: number, message: string, code?: string | null): GeoLinkError {
  const known = code ? BY_CODE[code] : undefined;
  if (known) {
    return new GeoLinkError(`GeoLink: ${message}`, known.kind, known.hint);
  }

  // No code: either an older deployment, or something outside the API's own
  // error path. The status still separates "you asked wrongly" from "we broke",
  // and only the second is worth retrying.
  if (status === 401 || status === 403) {
    return new GeoLinkError(
      `GeoLink rejected the request: ${message}`,
      "auth",
      "Check GEOLINK_API_KEY. Keys are issued at https://geolink-eg.com/register.",
    );
  }
  if (status === 429) {
    return new GeoLinkError(
      `GeoLink rate/quota limit hit: ${message}`,
      "quota",
      "Wait, reduce call volume, or upgrade the plan.",
    );
  }
  if (status === 404) {
    return new GeoLinkError(
      `GeoLink found nothing: ${message}`,
      "not_found",
      "Try a broader query, a different spelling, or a nearby centre point.",
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
    "Verify coordinates are valid decimal degrees, the query is non-empty, and language/country are 2-letter codes.",
  );
}

/**
 * Geocoding results are a property of the world, not of a session, so the cache
 * that holds them lives for the process and is shared by every client built
 * from it. In HTTP mode a server is constructed per session; with a cache per
 * client, ten sessions asking about the same city paid the upstream ten times
 * and the cache never did the job it exists for.
 *
 * The call counter stays per-client on purpose. It is what a sweep reports as
 * api_calls_made, and a process-wide counter would bill one caller for another
 * caller's traffic.
 */
const sharedCache = new TtlCache<unknown>(CACHE_MAX_ENTRIES, CACHE_TTL_MS);

/**
 * Sweeps get their own shelf, and a short one.
 *
 * A sweep of Cairo comes back as one envelope holding every place it found -
 * measured at 1.1 MB for 867 pharmacies. Paging that with offset has to serve
 * page two from somewhere, and re-running the sweep for it would spend the
 * whole cost again for results already in hand. But five hundred of those in
 * the shared cache is half a gigabyte of resident memory, so a count tuned for
 * geocodes is the wrong count here. Few entries, held only long enough for a
 * caller to page through what they just asked for.
 */
const sweepCache = new TtlCache<unknown>(SWEEP_CACHE_ENTRIES, SWEEP_CACHE_TTL_MS);

export class GeoLinkClient {
  private readonly cache: TtlCache<unknown>;
  private readonly sweeps: TtlCache<unknown>;
  private callCount = 0;

  constructor(
    private readonly cfg: Config,
    cache: TtlCache<unknown> = sharedCache,
    sweeps: TtlCache<unknown> = sweepCache,
  ) {
    this.cache = cache;
    this.sweeps = sweeps;
  }

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

  private async request<T>(
    path: string,
    params: Params,
    cacheKey?: string,
    seen?: { headers?: Headers },
    keepEnvelope = false,
  ): Promise<T> {
    const shelf = keepEnvelope ? this.sweeps : this.cache;
    if (cacheKey) {
      const hit = shelf.get(cacheKey);
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
        return await this.attempt<T>(path, params, cacheKey, seen, keepEnvelope, shelf);
      } catch (err) {
        if (!(err instanceof GeoLinkError) || !GeoLinkClient.RETRYABLE.has(err.kind)) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new GeoLinkError("Request failed", "upstream", "Retry shortly.");
  }

  /**
   * Like `request`, but hands back what the response said about itself.
   *
   * Some answers carry facts in headers rather than in the body — whether a
   * matrix was fully measured, for one. Those belong to the call that asked,
   * not to the client: a field on a shared client is wrong the moment two
   * requests overlap, which on a server handling several sessions is
   * immediately.
   */
  async requestWithHeaders<T>(
    path: string,
    params: Params,
  ): Promise<{ data: T; headers: Headers }> {
    const seen: { headers?: Headers } = {};
    const data = await this.request<T>(path, params, undefined, seen);
    return { data, headers: seen.headers ?? new Headers() };
  }

  private async attempt<T>(
    path: string,
    params: Params,
    cacheKey?: string,
    seen?: { headers?: Headers },
    keepEnvelope = false,
    shelf: TtlCache<unknown> = this.cache,
  ): Promise<T> {

    const url = new URL(path, `${this.cfg.baseUrl}/`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    // Which credential this path needs. v1 and v2 authenticate the caller and
    // bill them; x has no billing and no per-caller key, so it carries its own.
    // A caller never sees or supplies the second one - they prove who they are
    // with their own key on the billed tools, and that is what earns them the
    // newer surface.
    url.searchParams.set(
      "key",
      path.startsWith("/api/x/") ? this.cfg.xKey : this.cfg.apiKey,
    );

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
      throw classify(res.status, message, res.headers.get("x-geolink-error-code"));
    }
    if (body.data === undefined || body.data === null) {
      throw new GeoLinkError(
        "GeoLink returned success without a data payload",
        "upstream",
        "Retry; if it persists, report the request to hello@geolink-eg.com.",
      );
    }

    // What the response said about itself, for the caller that asked for it.
    // Dropping these is why a partly-measured matrix used to be
    // indistinguishable from a complete one.
    if (seen) seen.headers = res.headers;

    // Whether an x answer is all of them arrives in a header, and it is folded
    // into the body here rather than read at the call site. If it were read
    // separately, the first call would have it and every cache hit after would
    // not - page two of a truncated sweep would quietly claim to be complete.
    // Attaching it before the body is cached makes that impossible to get
    // wrong: the flag and the places are one object from here on.
    if (keepEnvelope && body && typeof body === "object") {
      const flag = res.headers.get("x-geolink-results-complete");
      if (flag !== null) (body as Record<string, unknown>).results_complete = flag === "true";
    }

    // v1 and v2 put everything in `data`, so unwrapping it is right for them.
    // x puts `total`, `near` and `next` beside it, and unwrapping first threw
    // those away - the sweep cursor and the resolved place among them.
    const value = (keepEnvelope ? body : body.data) as T;

    // Cache what is actually returned, not what a v1 answer happens to be.
    // Storing body.data under an envelope-keeping call put an array where the
    // next hit expected an envelope: the places survived and `total`, `near`
    // and `next` vanished, on the second call only, silently.
    if (cacheKey) shelf.set(cacheKey, value);

    return value;
  }

  /* ---------------- Endpoint wrappers ---------------- */

  async geocode(query: string, language: string, country: string): Promise<Place> {
    const key = `${this.cfg.baseUrl}|geocode|${language}|${country}|${query.trim().toLowerCase()}`;
    const raw = await this.request<RawPlace>(ENDPOINTS.geocode, { query, language, country }, key);
    return normalizePlace(raw);
  }

  async reverseGeocode(lat: number, lng: number, language: string, country: string): Promise<Place> {
    const key = `${this.cfg.baseUrl}|reverse|${language}|${country}|${lat.toFixed(5)},${lng.toFixed(5)}`;
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
    const cacheKey = `${this.cfg.baseUrl}|search|${language}|${country}|${maxResults}|${query.trim().toLowerCase()}|${center?.lat?.toFixed(5)},${center?.lng?.toFixed(5)}`;
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

  /* ---------------- The x surface ---------------- */

  /** An x call, envelope kept: total, near and next sit beside data, not in it. */
  private xRequest(path: string, params: Params, cacheKey?: string): Promise<any> {
    return this.request<any>(path, params, cacheKey, undefined, true);
  }

  private unwrapX(body: any, shape = false) {
    const data = body?.data ?? body;
    return {
      places: (shape ? [] : Array.isArray(data) ? data : []) as XPlace[],
      shape: shape ? data : undefined,
      total: typeof body?.total === "number" ? body.total : undefined,
      near: body?.near as XNear | undefined,
      next: body?.next as string | undefined,
      // Undefined where the API did not say - which is honest. Defaulting it
      // to true would be a claim nobody made, and true is the answer that
      // stops a caller looking.
      complete: typeof body?.results_complete === "boolean"
        ? (body.results_complete as boolean)
        : undefined,
    };
  }

  /**
   * Places near a point, or near a place named in words.
   *
   * `near` resolves server-side, which removes a round trip the older path
   * needed: geocode the name here, then search with the coordinates. It also
   * removes a failure that path could not see - putting the place in the query
   * and hoping the source infers it works for some names and silently does not
   * for others. Measured through the API, asking that way for pharmacies in
   * Aswan returned results in Giza.
   */
  async xSearch(opts: {
    query: string;
    near?: string;
    center?: LatLng;
    language: string;
    country: string;
    limit?: number;
    shape?: boolean;
  }) {
    const body = await this.xRequest(ENDPOINTS.xSearch, {
      query: opts.query,
      near: opts.near,
      // near and coordinates together are refused; send whichever was meant.
      latitude: opts.near ? undefined : opts.center?.lat,
      longitude: opts.near ? undefined : opts.center?.lng,
      language: opts.language,
      country: opts.country,
      limit: opts.limit,
      view: opts.shape ? "shape" : undefined,
    });
    return this.unwrapX(body, opts.shape);
  }

  /**
   * Places across an area, from several vantage points.
   *
   * One search sees about three hundred places whatever the query - the
   * ceiling belongs to the vantage point, not the world - so covering ground
   * means standing in several places. The API places them at a spacing it
   * measured: three kilometres apart gives 69% overlap, fifteen gives 11% and
   * finds nearly twice as many places for fewer calls. This client used to
   * build that grid itself, three kilometres apart.
   *
   * `next` comes back when there is more ground than one request can cover.
   * Pass it as `cursor` to carry on; it is opaque on purpose.
   */
  async xSweep(opts: {
    query: string;
    near?: string;
    center?: LatLng;
    radiusKm?: number;
    bounds?: string;
    language: string;
    country: string;
    pagesPerPoint?: number;
    spacingKm?: number;
    shape?: boolean;
    cursor?: string;
    dryRun?: boolean;
  }) {
    // A sweep is expensive and its whole result arrives at once, so paging it
    // must not ask for it twice. Everything that changes the answer is in the
    // key; `limit` and `offset` are not, because they only choose which part
    // of this same answer a caller is shown. A dry run is keyed apart from a
    // real one - it is a different question about the same area.
    const cacheKey = opts.dryRun
      ? undefined
      : [
          this.cfg.baseUrl, "xsweep", opts.language, opts.country,
          opts.query.trim().toLowerCase(),
          opts.near ?? "", opts.center ? `${opts.center.lat},${opts.center.lng}` : "",
          opts.radiusKm ?? "", opts.bounds ?? "",
          opts.pagesPerPoint ?? "", opts.spacingKm ?? "",
          opts.shape ? "shape" : "full", opts.cursor ?? "",
        ].join("|");

    const body = await this.xRequest(ENDPOINTS.xSweep, {
      query: opts.query,
      near: opts.near,
      latitude: opts.near ? undefined : opts.center?.lat,
      longitude: opts.near ? undefined : opts.center?.lng,
      radius_km: opts.radiusKm,
      bounds: opts.bounds,
      language: opts.language,
      country: opts.country,
      pages_per_point: opts.pagesPerPoint,
      spacing_km: opts.spacingKm,
      view: opts.shape ? "shape" : undefined,
      next: opts.cursor,
      dry_run: opts.dryRun ? "true" : undefined,
    }, cacheKey);
    if (opts.dryRun) {
      // A dry run searched nothing, so it is not complete or incomplete.
      return { places: [] as XPlace[], shape: undefined, total: undefined,
               near: body?.near as XNear | undefined, next: undefined,
               complete: undefined, plan: body?.data };
    }
    return { ...this.unwrapX(body, opts.shape), plan: undefined };
  }

  /**
   * Which of these is closest by road, rather than by straight line.
   *
   * Not a nicer number for the same answer: measured across eighteen origins,
   * the nearest place by road was a *different place* than the nearest by line
   * 22% of the time, and road distance ran 1.6x the line at the median.
   */
  async xNearest(opts: {
    query: string;
    near?: string;
    center?: LatLng;
    language: string;
    country: string;
    limit?: number;
    candidates?: number;
  }) {
    const body = await this.xRequest(ENDPOINTS.xNearest, {
      query: opts.query,
      near: opts.near,
      latitude: opts.near ? undefined : opts.center?.lat,
      longitude: opts.near ? undefined : opts.center?.lng,
      language: opts.language,
      country: opts.country,
      limit: opts.limit,
      candidates: opts.candidates,
    });
    return this.unwrapX(body);
  }

  async distanceMatrix(
    origins: LatLng[],
    destinations: LatLng[],
    language: string,
    country: string,
  ): Promise<MatrixResult> {
    const fmt = (pts: LatLng[]): string => pts.map((p) => `${p.lat},${p.lng}`).join(";");
    const { data, headers } = await this.requestWithHeaders<RawMatrix>(
      ENDPOINTS.distanceMatrix,
      { origins: fmt(origins), destinations: fmt(destinations), language, country },
    );

    // A matrix too large for the API's time budget comes back as a normal 200
    // with the cells it reached and the rest as zeros. On the wire a cell is
    // four numbers and nothing else, so an unreached one is indistinguishable
    // from two points that really are zero metres apart - and the only thing
    // that tells them apart arrives in these headers.
    const num = (name: string): number | undefined => {
      const raw = headers.get(name);
      if (raw === null) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const requested = num("x-geolink-matrix-requested");

    const result = normalizeMatrix(data, origins, destinations);
    if (requested !== undefined) {
      result.coverage = {
        requested,
        attempted: num("x-geolink-matrix-attempted") ?? requested,
        measured: num("x-geolink-matrix-measured") ?? requested,
        complete: headers.get("x-geolink-matrix-complete") !== "false",
      };
    }
    return result;
  }
}
