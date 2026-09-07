import {
  DEFAULT_BASE_URL,
  DEFAULT_COUNTRY,
  DEFAULT_LANGUAGE,
  DEFAULT_MAX_MATRIX_CELLS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_X_KEY,
} from "./constants.js";

export type Transport = "stdio" | "http";

export interface Config {
  apiKey: string;
  /** Credential for the x surface — see DEFAULT_X_KEY. */
  xKey: string;
  baseUrl: string;
  defaultLanguage: string;
  defaultCountry: string;
  timeoutMs: number;
  maxMatrixCells: number;
  transport: Transport;
  host: string;
  port: number;
  /**
   * The origin clients reach this server on, when it cannot be inferred.
   * Every URL in the OAuth metadata has to match the host a client actually
   * used, and behind a proxy the request's own host is the internal one.
   */
  publicUrl: string;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be an integer (got "${raw}")`);
  }
  return Math.min(max, Math.max(min, n));
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

export function loadConfig(): Config {
  const apiKey = strEnv("GEOLINK_API_KEY", "");
  const transportEarly = strEnv("TRANSPORT", "stdio").toLowerCase();
  // Over stdio the key comes from the environment, as the spec intends for a
  // local process. Over HTTP each connection brings its own key through the
  // authorization flow, so requiring one here would block a correctly
  // configured multi-user deployment from starting.
  if (!apiKey && transportEarly !== "http" && transportEarly !== "streamable-http") {
    throw new Error(
      "GEOLINK_API_KEY is required. Get a free key at https://geolink-eg.com/register and set it as an environment variable.",
    );
  }

  const baseUrl = strEnv("GEOLINK_BASE_URL", DEFAULT_BASE_URL).replace(/\/+$/, "");
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`GEOLINK_BASE_URL is not a valid URL: "${baseUrl}"`);
  }

  const transportRaw = strEnv("TRANSPORT", "stdio").toLowerCase();
  if (transportRaw !== "stdio" && transportRaw !== "http") {
    throw new Error(`TRANSPORT must be "stdio" or "http" (got "${transportRaw}")`);
  }

  return {
    apiKey,
    baseUrl,
    defaultLanguage: strEnv("GEOLINK_DEFAULT_LANGUAGE", DEFAULT_LANGUAGE).toLowerCase(),
    defaultCountry: strEnv("GEOLINK_DEFAULT_COUNTRY", DEFAULT_COUNTRY).toLowerCase(),
    timeoutMs: intEnv("GEOLINK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000, 120_000),
    // The x surface has its own credential, separate from a caller's API key -
    // it is off the billing path entirely, so there is no per-user key to use.
    // A caller proves who they are with their own key on the v1/v2 tools; this
    // is what lets those same tools reach the newer surface on their behalf.
    xKey: strEnv("GEOLINK_X_KEY", DEFAULT_X_KEY),
    maxMatrixCells: intEnv("GEOLINK_MAX_MATRIX_CELLS", DEFAULT_MAX_MATRIX_CELLS, 1, 2_500),
    transport: transportRaw,
    host: strEnv("HOST", "127.0.0.1"),
    port: intEnv("PORT", 3000, 1, 65_535),
    publicUrl: strEnv("GEOLINK_PUBLIC_URL", "").replace(/\/+$/, ""),
  };
}
