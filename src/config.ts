import {
  DEFAULT_BASE_URL,
  DEFAULT_COUNTRY,
  DEFAULT_LANGUAGE,
  DEFAULT_MAX_MATRIX_CELLS,
  DEFAULT_SWEEP_CONCURRENCY,
  DEFAULT_SWEEP_MAX_POINTS,
  DEFAULT_TIMEOUT_MS,
} from "./constants.js";

export type Transport = "stdio" | "http";

export interface Config {
  apiKey: string;
  baseUrl: string;
  defaultLanguage: string;
  defaultCountry: string;
  timeoutMs: number;
  maxMatrixCells: number;
  sweepMaxPoints: number;
  sweepConcurrency: number;
  transport: Transport;
  host: string;
  port: number;
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
  if (!apiKey) {
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
    maxMatrixCells: intEnv("GEOLINK_MAX_MATRIX_CELLS", DEFAULT_MAX_MATRIX_CELLS, 1, 2_500),
    sweepMaxPoints: intEnv("GEOLINK_SWEEP_MAX_POINTS", DEFAULT_SWEEP_MAX_POINTS, 1, 5_000),
    sweepConcurrency: intEnv("GEOLINK_SWEEP_CONCURRENCY", DEFAULT_SWEEP_CONCURRENCY, 1, 32),
    transport: transportRaw,
    host: strEnv("HOST", "127.0.0.1"),
    port: intEnv("PORT", 3000, 1, 65_535),
  };
}
