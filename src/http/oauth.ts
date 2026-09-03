/**
 * OAuth 2.1 surface for the remote transport.
 *
 * This server plays both roles the protocol asks for: the resource being
 * protected, and the authorization server protecting it. That is what most
 * production MCP servers do, and it keeps `issuer` equal to the origin, which
 * removes a whole class of discovery mismatch.
 *
 * What sits behind the flow is a person's own GeoLink key, collected on the
 * consent page and exchanged for an opaque token bound to it. Two documents
 * are worth naming as the reason this is the right shape rather than a
 * shortcut: the spec's own third-party authorization flow describes exactly
 * this arrangement, and Cloudflare's guidance calls issuing a local
 * audience-bound token while keeping the upstream credential separate the
 * preferred design. The non-conformant thing — which looks similar and is not
 * — is accepting the upstream API key directly as a bearer token at /mcp.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomToken, safeCompare, verifyPkceS256, type AuthStore } from "./auth.js";

/**
 * Where this server is mounted on its host.
 *
 * It can live on its own subdomain, or share a domain with the main site. The
 * second case is why the authorization endpoints hang off this prefix rather
 * than the root: the site already owns /register, and an OAuth registration
 * endpoint there would either shadow the sign-up page or be shadowed by it.
 *
 * The two well-known documents stay at the root regardless, because RFC 9728
 * and RFC 8414 place them there and a client will not look anywhere else.
 * Neither path collides with anything the site serves.
 */
export const MCP_PATH = (process.env.GEOLINK_MCP_PATH ?? "/mcp").replace(/\/+$/, "") || "/mcp";
export const SCOPE = "geo:read";

/** Protocol revisions this server will accept on MCP-Protocol-Version. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] as const;
/** What a request without the header is assumed to be, per the 2025-06-18 rule. */
export const ASSUMED_PROTOCOL_VERSION = "2025-03-26";

export interface OAuthContext {
  issuer: string;
  store: AuthStore;
  /** GeoLink's base URL, used to check a key before accepting it. */
  upstreamBaseUrl: string;
  registerUrl: string;
  siteUrl: string;
}

/* ------------------------------------------------------------------ */
/* Metadata documents                                                  */
/* ------------------------------------------------------------------ */

/**
 * RFC 9728 protected resource metadata.
 *
 * `resource` is the concrete MCP endpoint rather than the origin, and must
 * equal the URL the client actually called — that identity is what a client
 * checks after following the `resource_metadata` pointer from the 401.
 *
 * `offline_access` deliberately does not appear here: the spec says a
 * protected resource should not advertise it, and a client picks it up from
 * the authorization server document instead.
 */
export function protectedResourceMetadata(ctx: OAuthContext): object {
  return {
    resource: `${ctx.issuer}${MCP_PATH}`,
    authorization_servers: [ctx.issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "GeoLink MCP",
    resource_documentation: `${ctx.siteUrl}/docs/mcp`,
  };
}

/**
 * RFC 8414 authorization server metadata.
 *
 * Two fields are optional on paper and mandatory in practice.
 * `code_challenge_methods_supported` absent means "no PKCE" to a reader, and
 * newer clients must refuse to proceed on that basis — omitting it is a silent
 * hard failure rather than a missing nicety. `token_endpoint_auth_methods_supported`
 * defaults to client_secret_basic if unstated, which is wrong for every MCP
 * client, all of which are public.
 */
export function authorizationServerMetadata(ctx: OAuthContext): object {
  return {
    issuer: ctx.issuer,
    authorization_endpoint: `${ctx.issuer}${MCP_PATH}/authorize`,
    token_endpoint: `${ctx.issuer}${MCP_PATH}/token`,
    registration_endpoint: `${ctx.issuer}${MCP_PATH}/register`,
    revocation_endpoint: `${ctx.issuer}${MCP_PATH}/revoke`,
    scopes_supported: [SCOPE, "offline_access"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    // Claimed only because the consent POST appends `iss` to the callback
    // itself. A server that sets this and then redirects from a different
    // response than /authorize drops the parameter and fails clients that
    // validate it.
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${ctx.siteUrl}/docs/mcp`,
  };
}

/**
 * The RFC 6750 challenge that tells a client where to authenticate.
 *
 * Values are quoted: an unquoted `resource_metadata` is a syntax violation
 * some well-known servers ship, and there is no reason to copy it.
 */
export function challengeHeader(ctx: OAuthContext, opts: { insufficientScope?: boolean } = {}): string {
  const metadataUrl = `${ctx.issuer}/.well-known/oauth-protected-resource${MCP_PATH}`;
  if (opts.insufficientScope) {
    return `Bearer error="insufficient_scope", scope="${SCOPE}", resource_metadata="${metadataUrl}"`;
  }
  return `Bearer error="invalid_token", error_description="Authentication required", resource_metadata="${metadataUrl}", scope="${SCOPE}"`;
}

/* ------------------------------------------------------------------ */
/* Small HTTP helpers                                                  */
/* ------------------------------------------------------------------ */

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // A consent page is a credential-entry page; it must never be framed.
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'; default-src 'self'; style-src 'unsafe-inline'; img-src data:",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(html);
}

export function sendUnauthorized(res: ServerResponse, ctx: OAuthContext): void {
  sendJson(
    res,
    401,
    { error: "invalid_token", error_description: "Authentication required" },
    { "WWW-Authenticate": challengeHeader(ctx) },
  );
}

export async function readBody(req: IncomingMessage, limitBytes = 128 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > limitBytes) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/* ------------------------------------------------------------------ */
/* Redirect validation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Exact-string match against what the client registered, with one exception.
 *
 * Loopback redirects are compared with the port ignored, because a native
 * client binds an ephemeral port at run time and cannot register it in
 * advance. That exception is in RFC 8252 and is the reason Claude Code's
 * registered URI is portless.
 */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    const loopback = (h: string): boolean => h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
    if (!loopback(a.hostname) || !loopback(b.hostname)) return false;
    return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Client identity by metadata document (CIMD)                         */
/* ------------------------------------------------------------------ */

const PRIVATE_HOST = /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cde])/i;

export interface ClientDescriptor {
  clientId: string;
  redirectUris: string[];
  name?: string;
  /** Host to show a person, which for CIMD is the document's own origin. */
  displayHost: string;
}

/**
 * Resolve a `client_id` that is an HTTPS URL by fetching the document it names.
 *
 * The document is self-asserted, so its `client_name` is not evidence of
 * anything. What a person is shown is the host the document was served from,
 * which is the part an attacker cannot forge without controlling that host.
 */
export async function resolveClientIdDocument(clientId: string, timeoutMs = 10_000): Promise<ClientDescriptor | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // Never let a supplied URL make this server reach into its own network.
  if (PRIVATE_HOST.test(url.hostname)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" }, redirect: "error" });
    if (!res.ok) return null;
    const text = (await res.text()).slice(0, 5 * 1024);
    const doc = JSON.parse(text) as { client_id?: string; client_name?: string; redirect_uris?: unknown };
    // The document must claim exactly the URL it was fetched from.
    if (typeof doc.client_id !== "string" || doc.client_id !== clientId) return null;
    if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) return null;
    const redirectUris = doc.redirect_uris.filter((u): u is string => typeof u === "string");
    if (!redirectUris.length) return null;
    return {
      clientId,
      redirectUris,
      name: typeof doc.client_name === "string" ? doc.client_name : undefined,
      displayHost: url.host,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Upstream key check                                                  */
/* ------------------------------------------------------------------ */

/**
 * Confirm a key works before a token is minted for it.
 *
 * This belongs on the consent POST, never inside /token: the token endpoint
 * runs inside a user-facing budget measured in seconds, and a slow upstream
 * there turns into a failed connection rather than a clear message.
 */
export async function validateUpstreamKey(baseUrl: string, apiKey: string, timeoutMs = 12_000): Promise<boolean> {
  const url = new URL("/api/v2/geocode", `${baseUrl}/`);
  url.searchParams.set("query", "Cairo");
  url.searchParams.set("language", "en");
  url.searchParams.set("key", apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (res.status === 401 || res.status === 403) return false;
    const body = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
    if (body?.success === false && /api key|unauthori|invalid key/i.test(body.error ?? "")) return false;
    return res.ok;
  } catch {
    // An upstream that cannot be reached is not proof the key is wrong, and
    // refusing here would strand a person with a valid key during an outage.
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Grant handling                                                      */
/* ------------------------------------------------------------------ */

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope?: string;
}

/** Parse and validate an /authorize query, returning either a request or the error to show. */
export function parseAuthorizeQuery(params: URLSearchParams): { ok: true; value: AuthorizeRequest } | { ok: false; error: string; description: string } {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const responseType = params.get("response_type") ?? "";
  const challenge = params.get("code_challenge") ?? "";
  const method = params.get("code_challenge_method") ?? "";

  if (!clientId) return { ok: false, error: "invalid_request", description: "client_id is required" };
  if (!redirectUri) return { ok: false, error: "invalid_request", description: "redirect_uri is required" };
  if (responseType !== "code") return { ok: false, error: "unsupported_response_type", description: "only response_type=code is supported" };
  if (!challenge) return { ok: false, error: "invalid_request", description: "code_challenge is required" };
  if (method !== "S256") return { ok: false, error: "invalid_request", description: "code_challenge_method must be S256" };

  return {
    ok: true,
    value: {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      state: params.get("state") ?? undefined,
      scope: params.get("scope") ?? undefined,
    },
  };
}

/** Build the callback URL, carrying `iss` because the redirect leaves from the consent POST. */
export function callbackUrl(ctx: OAuthContext, redirectUri: string, code: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", ctx.issuer);
  return url.toString();
}

export function errorRedirect(redirectUri: string, error: string, description: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/** Exchange an authorization code for a token, verifying PKCE. */
export function exchangeCode(
  ctx: OAuthContext,
  form: URLSearchParams,
): { ok: true; body: object } | { ok: false; status: number; body: object } {
  if ((form.get("grant_type") ?? "") !== "authorization_code") {
    return { ok: false, status: 400, body: { error: "unsupported_grant_type", error_description: "only authorization_code is supported" } };
  }
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const clientId = form.get("client_id") ?? "";

  const pending = ctx.store.takeCode(code);
  if (!pending) {
    return { ok: false, status: 400, body: { error: "invalid_grant", error_description: "authorization code is unknown or expired" } };
  }
  if (clientId && !safeCompare(clientId, pending.clientId)) {
    return { ok: false, status: 400, body: { error: "invalid_grant", error_description: "code was issued to a different client" } };
  }
  if (redirectUri && redirectUri !== pending.redirectUri) {
    return { ok: false, status: 400, body: { error: "invalid_grant", error_description: "redirect_uri does not match the authorization request" } };
  }
  if (!verifyPkceS256(verifier, pending.codeChallenge)) {
    return { ok: false, status: 400, body: { error: "invalid_grant", error_description: "code_verifier does not match the code_challenge" } };
  }

  const { token, expiresIn } = ctx.store.issueToken(pending.apiKey, pending.clientId);
  return {
    ok: true,
    body: { access_token: token, token_type: "Bearer", expires_in: expiresIn, scope: SCOPE },
  };
}

/* ------------------------------------------------------------------ */
/* 2026-07-28 tolerance                                                */
/* ------------------------------------------------------------------ */

export interface HeaderCheck {
  ok: boolean;
  protocolVersion: string;
  error?: { code: number; message: string };
}

/**
 * Read the newer routing headers without depending on them.
 *
 * A 2026 client must send `Mcp-Method`, and on some calls `Mcp-Name`; a 2025
 * client sends neither. So absence is never an error and presence is never an
 * error — but disagreement with the body is, because a proxy routing on the
 * header while this server dispatches on the body would be acting on two
 * different requests.
 */
export function checkProtocolHeaders(headers: NodeJS.Dict<string | string[]>, body: unknown): HeaderCheck {
  const one = (name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const declared = one("mcp-protocol-version");
  const protocolVersion = declared ?? ASSUMED_PROTOCOL_VERSION;
  if (declared && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(declared)) {
    return {
      ok: false,
      protocolVersion,
      error: { code: -32022, message: `Unsupported protocol version: ${declared}` },
    };
  }

  const message = body as { method?: unknown; params?: { name?: unknown } } | null;
  const method = one("mcp-method");
  if (method && typeof message?.method === "string" && method !== message.method) {
    return { ok: false, protocolVersion, error: { code: -32020, message: "Header mismatch" } };
  }

  const name = one("mcp-name");
  const named = new Set(["tools/call", "resources/read", "prompts/get"]);
  if (name && typeof message?.method === "string" && named.has(message.method)) {
    const bodyName = message.params?.name;
    if (typeof bodyName === "string" && name !== bodyName) {
      return { ok: false, protocolVersion, error: { code: -32020, message: "Header mismatch" } };
    }
  }

  return { ok: true, protocolVersion };
}

export function randomCode(): string {
  return randomToken(24);
}
