#!/usr/bin/env node
/**
 * GeoLink MCP Server
 *
 * Exposes GeoLink (geolink-eg.com) — geocoding, reverse geocoding, place
 * search, directions, and distance matrix — to AI agents over the Model
 * Context Protocol, plus two composite tools that turn the raw endpoints
 * into agent-shaped answers: nearest-by-road-time ranking and grid-tiled
 * area coverage sweeps.
 *
 * Transport: stdio by default; set TRANSPORT=http for Streamable HTTP, which
 * keeps one MCP session per client and reaps sessions left idle.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type Config } from "./config.js";
import { AuthStore, bearerFrom, resolveIssuer } from "./http/auth.js";
import {
  authorizationServerMetadata,
  callbackUrl,
  challengeHeader,
  checkProtocolHeaders,
  errorRedirect,
  exchangeCode,
  MCP_PATH,
  parseAuthorizeQuery,
  protectedResourceMetadata,
  randomCode,
  readBody,
  redirectMatches,
  resolveClientIdDocument,
  SCOPE,
  sendHtml,
  sendJson,
  sendUnauthorized,
  SUPPORTED_PROTOCOL_VERSIONS,
  validateUpstreamKey,
  type ClientDescriptor,
  type OAuthContext,
} from "./http/oauth.js";
import { connectPage, type PageLang } from "./http/pages.js";
import { SERVER_NAME, SERVER_VERSION, SESSION_IDLE_TIMEOUT_MS, SESSION_REAP_INTERVAL_MS } from "./constants.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { GeoLinkClient } from "./services/client.js";
import type { ToolContext } from "./services/resolve.js";
import { registerGeocodingTools } from "./tools/geocoding.js";
import { registerRoutingTools } from "./tools/routing.js";
import { registerSearchTools } from "./tools/search.js";
import { registerSweepTool } from "./tools/sweep.js";

const HELP = `${SERVER_NAME} v${SERVER_VERSION}

Usage:
  geolink-mcp            run over stdio (default)
  TRANSPORT=http geolink-mcp   run Streamable HTTP on HOST:PORT (/mcp)

Environment:
  GEOLINK_API_KEY              required — https://geolink-eg.com/register
  GEOLINK_BASE_URL             default https://www.geolink-eg.com
  GEOLINK_DEFAULT_LANGUAGE     default en
  GEOLINK_DEFAULT_COUNTRY      default (none — no country bias)
  GEOLINK_TIMEOUT_MS           default 30000
  GEOLINK_MAX_MATRIX_CELLS     default 100
  GEOLINK_SWEEP_MAX_POINTS     default 200
  GEOLINK_SWEEP_CONCURRENCY    default 4
  TRANSPORT                    stdio | http
  HOST / PORT                  http only (default 127.0.0.1:3000)
`;

export function buildServer(cfg: Config): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: `GeoLink gives you location intelligence: geocoding, place search, directions, distance matrix, and grid-based area sweeps. Inputs accept coordinates ("lat,lng") or place names anywhere a location is needed; names are geocoded automatically and cached. Defaults: language=${cfg.defaultLanguage}${cfg.defaultCountry ? `, country=${cfg.defaultCountry}` : ""}.

Pick tools by task:
- One address ⇄ coordinates: geolink_geocode / geolink_reverse_geocode.
- Places near a point: geolink_search_places — one center, as deep as the limit you ask for; source_exhausted tells you when there are no more.
- Every place of a kind across a district/city/governorate: geolink_sweep_area — ALWAYS dry_run=true first to see the API-call count; raise results_per_point for dense categories.
- A → B: geolink_get_directions (default 'summary'; ask for 'polyline' only when drawing a map).
- Many-to-many travel times: geolink_distance_matrix (≤ ${cfg.maxMatrixCells} cells).
- "Which branch/pharmacy is really closest by road?": geolink_find_nearest.

All results include address_parts {district, governorate, country} — group and filter on those rather than parsing address strings.

Depth is not coverage: a large limit reads one center more deeply, a sweep reads new ground. A search from one point never finds what is in the next district, however large the limit.

Resources worth reading before a large job: geolink://playbook (which tool answers which question), geolink://scale (measured cost and latency), geolink://playbook/coverage (how to cover an area without leaving holes), geolink://playbook/recipes (compositions), geolink://capabilities (limits and cost formulas).`,
    },
  );

  const ctx: ToolContext = { client: new GeoLinkClient(cfg), cfg };

  registerGeocodingTools(server, ctx);
  registerSearchTools(server, ctx);
  registerRoutingTools(server, ctx);
  registerSweepTool(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);

  return server;
}

async function runStdio(cfg: Config): Promise<void> {
  const server = buildServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio (upstream ${cfg.baseUrl})`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : undefined;
}


/** Where a person is sent to get a key, and what the consent page links to. */
const SITE_URL = "https://geolink-eg.com";

/**
 * RFC 7591 dynamic client registration.
 *
 * Open by design — a client that has never spoken to this server has no other
 * way to obtain a client_id. What that costs is a registry anyone can add to,
 * which is why nothing here grants authority: a registration only records the
 * redirect URIs that client may later use.
 */
async function handleRegister(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext): Promise<void> {
  let body: { redirect_uris?: unknown; client_name?: unknown; scope?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    sendJson(res, 400, { error: "invalid_client_metadata", error_description: "body must be JSON" });
    return;
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length) {
    sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris must contain at least one URI" });
    return;
  }
  for (const uri of uris) {
    try {
      const parsed = new URL(uri);
      const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
      if (parsed.protocol === "http:" && !loopback) {
        sendJson(res, 400, { error: "invalid_redirect_uri", error_description: `http is only allowed for loopback: ${uri}` });
        return;
      }
    } catch {
      sendJson(res, 400, { error: "invalid_redirect_uri", error_description: `not a valid URI: ${uri}` });
      return;
    }
  }
  const name = typeof body.client_name === "string" ? body.client_name : undefined;
  const clientId = ctx.store.registerClient(uris, name);
  // Registered metadata is echoed back, per RFC 7591.
  sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: uris,
    ...(name ? { client_name: name } : {}),
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: typeof body.scope === "string" ? body.scope : SCOPE,
  });
}

/** GET renders the consent page; POST turns an entered key into a code. */
async function handleAuthorize(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext, url: URL): Promise<void> {
  const params = req.method === "POST"
    ? new URLSearchParams(await readBody(req).catch(() => ""))
    : url.searchParams;

  const parsed = parseAuthorizeQuery(params);
  if (!parsed.ok) {
    // Only redirect an error when the redirect target is one we trust; an
    // unvalidated redirect_uri here is an open redirect wearing an error page.
    const target = params.get("redirect_uri");
    const client = target ? await describeClient(ctx, params.get("client_id") ?? "") : null;
    if (target && client && client.redirectUris.some((u) => redirectMatches(u, target))) {
      res.writeHead(302, { Location: errorRedirect(target, parsed.error, parsed.description, params.get("state") ?? undefined) }).end();
    } else {
      sendJson(res, 400, { error: parsed.error, error_description: parsed.description });
    }
    return;
  }

  const request = parsed.value;
  const client = await describeClient(ctx, request.clientId);
  if (!client || !client.redirectUris.some((u) => redirectMatches(u, request.redirectUri))) {
    sendJson(res, 400, {
      error: "invalid_request",
      error_description: "redirect_uri is not registered for this client",
    });
    return;
  }

  const lang: PageLang = /^ar\b/i.test(String(req.headers["accept-language"] ?? "")) ? "ar" : "en";
  const hidden: Record<string, string> = {
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    response_type: "code",
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    ...(request.state ? { state: request.state } : {}),
    ...(request.scope ? { scope: request.scope } : {}),
  };

  if (req.method !== "POST") {
    sendHtml(res, 200, connectPage({
      lang, action: `${MCP_PATH}/authorize`, hidden,
      // The document is self-asserted, so a person is shown the host it came
      // from rather than the name it chose for itself.
      clientName: client.displayHost || client.name,
      registerUrl: ctx.registerUrl, siteUrl: ctx.siteUrl,
    }));
    return;
  }

  const apiKey = (params.get("api_key") ?? "").trim();
  if (!apiKey) {
    sendHtml(res, 400, connectPage({
      lang, action: `${MCP_PATH}/authorize`, hidden, clientName: client.displayHost || client.name,
      registerUrl: ctx.registerUrl, siteUrl: ctx.siteUrl,
      error: lang === "ar" ? "لازم تدخل المفتاح." : "A key is required.",
    }));
    return;
  }
  // Checked here rather than at /token: the token endpoint runs inside a
  // user-facing budget, and a slow upstream there becomes a failed connection
  // instead of a message someone can act on.
  if (!(await validateUpstreamKey(ctx.upstreamBaseUrl, apiKey))) {
    sendHtml(res, 400, connectPage({
      lang, action: `${MCP_PATH}/authorize`, hidden, clientName: client.displayHost || client.name,
      registerUrl: ctx.registerUrl, siteUrl: ctx.siteUrl,
      error: lang === "ar" ? "المفتاح ده مرفوض من GeoLink." : "GeoLink rejected that key.",
    }));
    return;
  }

  const code = randomCode();
  ctx.store.issueCode(code, {
    apiKey,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
  });
  res.writeHead(302, { Location: callbackUrl(ctx, request.redirectUri, code, request.state) }).end();
}

/** A registered client, or one identified by its metadata document. */
async function describeClient(ctx: OAuthContext, clientId: string): Promise<ClientDescriptor | null> {
  const registered = ctx.store.getClient(clientId);
  if (registered) {
    return { clientId, redirectUris: registered.redirectUris, name: registered.name, displayHost: registered.name ?? "" };
  }
  if (clientId.startsWith("https://")) return resolveClientIdDocument(clientId);
  return null;
}

async function handleToken(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext): Promise<void> {
  // The token endpoint speaks form-urlencoded; a JSON-only parser answers 415
  // here and the flow dies at the last step.
  const form = new URLSearchParams(await readBody(req).catch(() => ""));
  const result = exchangeCode(ctx, form);
  if (result.ok) sendJson(res, 200, result.body);
  else sendJson(res, result.status, result.body);
}

async function runHttp(cfg: Config): Promise<void> {
  // Stateful session map: sessionId -> { server, transport, lastSeen }.
  // Clients are supposed to DELETE when done, but a dropped connection or a
  // crashed client never sends that, so idle sessions are reaped on a timer —
  // without it the map grows for the lifetime of the process.
  type Session = { server: McpServer; transport: StreamableHTTPServerTransport; lastSeen: number };
  const sessions = new Map<string, Session>();
  // Tokens and authorization codes live for the life of the process. A restart
  // asks clients to reconnect, which for a read-only service is a reconnect
  // rather than a loss, and it keeps other people's API keys off this disk.
  const authStore = new AuthStore();

  const touch = (sid: string | undefined): void => {
    if (!sid) return;
    const s = sessions.get(sid);
    if (s) s.lastSeen = Date.now();
  };

  const closeSession = async (sid: string, reason: string): Promise<void> => {
    const entry = sessions.get(sid);
    if (!entry) return;
    sessions.delete(sid);
    try {
      await entry.transport.close();
      await entry.server.close();
    } catch (err) {
      console.error(`Session ${sid} cleanup error:`, err instanceof Error ? err.message : err);
    }
    console.error(`Session ${sid} closed (${reason}, total: ${sessions.size})`);
  };

  const reaper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
    for (const [sid, s] of sessions) {
      if (s.lastSeen < cutoff) void closeSession(sid, "idle");
    }
  }, SESSION_REAP_INTERVAL_MS);
  reaper.unref();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    const startTime = Date.now();
    console.error(`[${requestId}] ${req.method} ${req.url}`);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // CORS preflight
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, MCP-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name");
    // A client cannot follow the challenge it cannot read.
    res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id, WWW-Authenticate");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, sessions: sessions.size }));
      return;
    }

    // Everything below this line up to /mcp must stay reachable without a
    // token. A client discovers where to authenticate by reading these, so an
    // auth check in front of them makes the flow impossible to start.
    const oauth: OAuthContext = {
      issuer: resolveIssuer(req, cfg.publicUrl),
      store: authStore,
      upstreamBaseUrl: cfg.baseUrl,
      registerUrl: `${SITE_URL}/register`,
      siteUrl: SITE_URL,
    };

    if (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === `/.well-known/oauth-protected-resource${MCP_PATH}`) {
      sendJson(res, 200, protectedResourceMetadata(oauth));
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(res, 200, authorizationServerMetadata(oauth));
      return;
    }
    if (url.pathname === `${MCP_PATH}/register` && req.method === "POST") {
      await handleRegister(req, res, oauth);
      return;
    }
    if (url.pathname === `${MCP_PATH}/authorize`) {
      await handleAuthorize(req, res, oauth, url);
      return;
    }
    if (url.pathname === `${MCP_PATH}/token` && req.method === "POST") {
      await handleToken(req, res, oauth);
      return;
    }
    if (url.pathname === `${MCP_PATH}/revoke` && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req).catch(() => ""));
      authStore.revoke(form.get("token") ?? "");
      // RFC 7009: an unknown token is still a success.
      res.writeHead(200).end();
      return;
    }

    if (url.pathname !== MCP_PATH) { res.writeHead(404).end(); return; }

    // --- GET: open SSE stream for existing session, or return server info ---
    if (req.method === "GET") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        // Discovery / health — return server metadata
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          server: SERVER_NAME,
          version: SERVER_VERSION,
          transport: "streamable-http",
          endpoint: `${resolveIssuer(req, cfg.publicUrl)}${MCP_PATH}`,
          protocol: SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1],
        }));
        return;
      }
      touch(sessionId);
      const { transport } = sessions.get(sessionId)!;
      try {
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error(`[${requestId}] GET SSE error:`, err instanceof Error ? err.message : err);
      }
      return;
    }

    // --- DELETE: terminate session ---
    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId) await closeSession(sessionId, "client DELETE");
      res.writeHead(204).end();
      return;
    }

    // --- POST: initialize or call ---
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
      return;
    }

    try {
      const body = await readJsonBody(req);

      // The gate runs here, before the message reaches the MCP SDK. Once a
      // tool handler runs, its result is already destined for a 200, and a 200
      // carrying isError never prompts a client to authenticate — it just
      // hands the text to the model. Authentication has to fail as transport,
      // not as content.
      const bearer = bearerFrom(req);
      const requestKey = bearer ? authStore.resolveToken(bearer) : undefined;
      if (!requestKey) {
        console.error(`[${requestId}] 401 ${bearer ? "token not recognised" : "no bearer token"}`);
        sendUnauthorized(res, {
          issuer: resolveIssuer(req, cfg.publicUrl),
          store: authStore,
          upstreamBaseUrl: cfg.baseUrl,
          registerUrl: `${SITE_URL}/register`,
          siteUrl: SITE_URL,
        });
        return;
      }

      // Newer clients route on headers; older ones send none. Absence is fine
      // either way, disagreement with the body is not.
      const headerCheck = checkProtocolHeaders(req.headers, body);
      if (!headerCheck.ok && headerCheck.error) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          id: (body as { id?: unknown } | null)?.id ?? null,
          error: headerCheck.error,
        });
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Reuse existing session or create new one
      let entry: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;

      if (!entry) {
        // The connection's own key, not the process's. This single argument is
        // the whole data-plane change for multi-user: every upstream call
        // reads cfg.apiKey, so binding it here binds the entire session.
        const server = buildServer({ ...cfg, apiKey: requestKey });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            sessions.set(sid, { server, transport, lastSeen: Date.now() });
            console.error(`[${requestId}] Session created: ${sid} (total: ${sessions.size})`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.delete(sid);
            console.error(`Session ${sid} closed (transport, total: ${sessions.size})`);
          }
        };
        await server.connect(transport);
        entry = { server, transport, lastSeen: Date.now() };
      }

      touch(entry.transport.sessionId);
      await entry.transport.handleRequest(req, res, body);
      console.error(`[${requestId}] POST completed (${Date.now() - startTime}ms)`);
    } catch (err) {
      console.error(`[${requestId}] HTTP error:`, err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(cfg.port, cfg.host, resolve));
  console.error(`${SERVER_NAME} v${SERVER_VERSION} listening on http://${cfg.host}:${cfg.port}/mcp (upstream ${cfg.baseUrl})`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (cfg.transport === "http") await runHttp(cfg);
  else await runStdio(cfg);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
