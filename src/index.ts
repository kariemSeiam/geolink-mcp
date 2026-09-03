#!/usr/bin/env node
/**
 * GeoLink MCP Server
 *
 * Exposes GeoLink (geolink-eg.com) — Egypt-native geocoding, reverse
 * geocoding, place search, directions, and distance matrix — to AI agents
 * over the Model Context Protocol, plus two composite tools that turn the raw
 * endpoints into agent-shaped answers: nearest-by-road-time ranking and
 * grid-tiled area coverage sweeps.
 *
 * Transport: stdio by default; set TRANSPORT=http for stateless Streamable HTTP.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type Config } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
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
  geolink-mcp-server            run over stdio (default)
  TRANSPORT=http geolink-mcp-server   run Streamable HTTP on HOST:PORT (/mcp)

Environment:
  GEOLINK_API_KEY              required — https://geolink-eg.com/register
  GEOLINK_BASE_URL             default https://www.geolink-eg.com
  GEOLINK_DEFAULT_LANGUAGE     default ar
  GEOLINK_DEFAULT_COUNTRY      default eg
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
      instructions: `GeoLink gives you Egypt-first location intelligence. Inputs accept coordinates ("lat,lng") or place names anywhere a location is needed; names are geocoded automatically and cached. Defaults: language=${cfg.defaultLanguage}, country=${cfg.defaultCountry}.

Pick tools by task:
- One address ⇄ coordinates: geolink_geocode / geolink_reverse_geocode.
- Places near a point: geolink_search_places (one page from one center).
- Every place of a kind across a district/city/governorate: geolink_sweep_area — ALWAYS dry_run=true first to see the API-call count.
- A → B: geolink_get_directions (default 'summary'; ask for 'polyline' only when drawing a map).
- Many-to-many travel times: geolink_distance_matrix (≤ ${cfg.maxMatrixCells} cells).
- "Which branch/pharmacy is really closest by road?": geolink_find_nearest.

All results include address_parts {district, governorate, country} — group and filter on those rather than parsing address strings. Read resource geolink://capabilities for limits and per-tool API cost.`,
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

async function runHttp(cfg: Config): Promise<void> {
  // Stateful session map: sessionId -> { server, transport }
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    const startTime = Date.now();
    console.error(`[${requestId}] ${req.method} ${req.url}`);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // CORS preflight
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, MCP-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, sessions: sessions.size }));
      return;
    }

    // OAuth metadata — required by Claude.ai remote MCP discovery
    if (url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/openid-configuration") {
      const meta = {
        issuer: `https://${req.headers.host}`,
        authorization_endpoint: `https://${req.headers.host}/oauth/authorize`,
        token_endpoint: `https://${req.headers.host}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(meta));
      return;
    }

    if (url.pathname !== "/mcp") { res.writeHead(404).end(); return; }

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
          endpoint: `https://${req.headers.host}/mcp`,
          protocol: "2024-11-05",
        }));
        return;
      }
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
      if (sessionId && sessions.has(sessionId)) {
        const { server, transport } = sessions.get(sessionId)!;
        sessions.delete(sessionId);
        await transport.close();
        await server.close();
        console.error(`[${requestId}] Session ${sessionId} deleted`);
      }
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
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Reuse existing session or create new one
      let entry = sessionId ? sessions.get(sessionId) : undefined;

      if (!entry) {
        const server = buildServer(cfg);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            sessions.set(sid, { server, transport });
            console.error(`[${requestId}] Session created: ${sid} (total: ${sessions.size})`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.delete(sid);
            console.error(`Session ${sid} closed (total: ${sessions.size})`);
          }
        };
        await server.connect(transport);
        entry = { server, transport };
      }

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
