/**
 * Authorization for the remote transport.
 *
 * The shape is OAuth 2.1 with PKCE, because that is what a client expects when
 * a person pastes a URL and presses connect. What sits behind it is deliberately
 * simple: the authorization page collects the person's own GeoLink key, and the
 * token this server issues is an opaque handle bound to that key.
 *
 * That binding is the whole security model, and it is worth stating plainly
 * because the obvious shortcut is worse. A server that returns its own shared
 * upstream key as the access token turns the authorization flow into a public
 * dispenser for that key: anyone who can reach the page completes the dance in
 * a browser and walks away with the secret. Here there is no shared key to
 * leak. Each token maps to the credential its own holder supplied, a token is
 * useless to anyone who did not bring a key of their own, and revoking one
 * affects exactly one connection.
 *
 * Tokens live in memory. A restart disconnects clients, which for a read-only
 * geospatial service is a reconnect rather than a loss, and it keeps a file of
 * other people's API keys off this disk. Swap {@link TokenStore} for a durable
 * implementation if that trade stops being the right one.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Authorization codes are short-lived by design: seconds of use, not minutes. */
const CODE_TTL_MS = 5 * 60 * 1000;
/** How often expired codes and tokens are swept. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** Issued tokens outlive a working session but not a forgotten laptop. */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PendingCode {
  apiKey: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

export interface IssuedToken {
  apiKey: string;
  clientId: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Both sides are hashed to a fixed width first. Comparing raw strings would
 * need equal lengths for timingSafeEqual and would leak the length difference
 * anyway; hashing removes both problems and costs nothing at this volume.
 */
export function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** PKCE S256: the verifier must hash to the challenge presented at authorize. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const digest = createHash("sha256").update(verifier).digest("base64url");
  return safeCompare(digest, challenge);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * The public origin of this server as a client will see it.
 *
 * Every URL in the metadata documents has to match the host the client
 * actually reached, or the flow breaks at discovery. Behind a reverse proxy the
 * request's own host is the internal one, so the forwarded headers win, and an
 * explicit override wins over both for the case where neither is right.
 */
export function resolveIssuer(req: IncomingMessage, override?: string): string {
  if (override) return override.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0]?.trim();
  const scheme = proto || (host?.startsWith("localhost") || host?.startsWith("127.") ? "http" : "https");
  return `${scheme}://${host}`;
}

export class AuthStore {
  private readonly codes = new Map<string, PendingCode>();
  private readonly tokens = new Map<string, IssuedToken>();
  /** Clients that registered dynamically, so a redirect_uri can be checked. */
  private readonly clients = new Map<string, { redirectUris: string[]; name?: string }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Never hold the process open for the sake of housekeeping.
    this.sweeper.unref();
  }

  registerClient(redirectUris: string[], name?: string): string {
    const id = `geolink-${randomToken(9)}`;
    this.clients.set(id, { redirectUris, name });
    return id;
  }

  getClient(clientId: string): { redirectUris: string[]; name?: string } | undefined {
    return this.clients.get(clientId);
  }

  /**
   * A redirect target is acceptable if the client registered it, or — for a
   * client that never registered — if it is a loopback address or a custom
   * scheme, which is what desktop and editor clients use. An unregistered
   * https target is refused: that is the open-redirect shape.
   */
  isRedirectAllowed(clientId: string, redirectUri: string): boolean {
    const known = this.clients.get(clientId);
    if (known) return known.redirectUris.includes(redirectUri);
    try {
      const url = new URL(redirectUri);
      if (url.protocol !== "http:" && url.protocol !== "https:") return true;
      return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    } catch {
      return false;
    }
  }

  issueCode(code: string, pending: Omit<PendingCode, "expiresAt">): void {
    this.codes.set(code, { ...pending, expiresAt: Date.now() + CODE_TTL_MS });
  }

  /** Codes are single use: taking one removes it, expired or not. */
  takeCode(code: string): PendingCode | undefined {
    const found = this.codes.get(code);
    this.codes.delete(code);
    if (!found) return undefined;
    return found.expiresAt > Date.now() ? found : undefined;
  }

  issueToken(apiKey: string, clientId: string): { token: string; expiresIn: number } {
    const token = randomToken();
    const now = Date.now();
    this.tokens.set(token, { apiKey, clientId, issuedAt: now, expiresAt: now + TOKEN_TTL_MS });
    return { token, expiresIn: Math.floor(TOKEN_TTL_MS / 1000) };
  }

  /** The API key this token stands for, or undefined if it is unknown or stale. */
  resolveToken(token: string): string | undefined {
    const found = this.tokens.get(token);
    if (!found) return undefined;
    if (found.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return undefined;
    }
    return found.apiKey;
  }

  revoke(token: string): boolean {
    return this.tokens.delete(token);
  }

  get stats(): { codes: number; tokens: number; clients: number } {
    return { codes: this.codes.size, tokens: this.tokens.size, clients: this.clients.size };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [code, pending] of this.codes) if (pending.expiresAt <= now) this.codes.delete(code);
    for (const [token, issued] of this.tokens) if (issued.expiresAt <= now) this.tokens.delete(token);
  }
}

/** Bearer token from the Authorization header, or null. */
export function bearerFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}
