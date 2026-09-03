import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DEEP_SEARCH_ADVISORY,
  ENDPOINTS,
  SERVER_NAME,
  SERVER_VERSION,
  SWEEP_CLIENT_BATCH,
  SWEEP_OUTBOUND_BUDGET,
  UPSTREAM_PAGE_SIZE,
} from "./constants.js";
import { MEASUREMENTS, PLAYBOOK_COVERAGE, PLAYBOOK_INDEX, PLAYBOOK_RECIPES } from "./playbook.js";
import type { ToolContext } from "./services/resolve.js";

function json(uri: string, body: unknown): { contents: { uri: string; mimeType: string; text: string }[] } {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
}

function markdown(uri: string, text: string): { contents: { uri: string; mimeType: string; text: string }[] } {
  return { contents: [{ uri, mimeType: "text/markdown", text }] };
}

export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "capabilities",
    "geolink://capabilities",
    {
      title: "Capabilities and limits",
      description: "Endpoints wrapped by this server, active defaults, cost formulas, and the guard rails that can refuse a request.",
      mimeType: "application/json",
    },
    async (uri) =>
      json(uri.href, {
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        upstream: {
          base_url: ctx.cfg.baseUrl,
          endpoints: ENDPOINTS,
          auth: "query parameter `key` (set via GEOLINK_API_KEY)",
          page_size: UPSTREAM_PAGE_SIZE,
        },
        defaults: {
          language: ctx.cfg.defaultLanguage,
          country: ctx.cfg.defaultCountry,
          timeout_ms: ctx.cfg.timeoutMs,
          search_limit: UPSTREAM_PAGE_SIZE,
          sweep_results_per_point: UPSTREAM_PAGE_SIZE,
          sweep_grid_spacing_km: 3,
        },
        tools: {
          geolink_geocode: "address or name → one place with viewport bounds",
          geolink_reverse_geocode: "lat,lng → address with district and governorate",
          geolink_search_places: "text query around one center → places, as deep as `limit` asks",
          geolink_get_directions: "A → B routes; geometry opt-in (summary | polyline | waypoints)",
          geolink_distance_matrix: "N×M travel times plus the nearest destination per origin",
          geolink_find_nearest: "rank known or discovered candidates by road time from one origin",
          geolink_sweep_area: "grid-tile a region and merge the searches; dry_run first",
        },
        cost_model: {
          unit: "upstream HTTP requests",
          geocode: 1,
          reverse_geocode: 1,
          search_places: `ceil((limit + offset) / ${UPSTREAM_PAGE_SIZE}), fewer when the area runs out; +1 if \`near\` is a name`,
          get_directions: "1, +1 per endpoint passed as a name",
          distance_matrix: "1 regardless of grid size, +1 per location passed as a name",
          find_nearest: "1 matrix, plus the search cost in discovery mode",
          sweep_area: `grid_points × ceil(results_per_point / ${UPSTREAM_PAGE_SIZE}), +1 if the area is a name`,
          caching: "geocode and reverse-geocode results are cached in-process for 10 minutes, keyed by query, language, country and depth",
          cheapest_win: "pass coordinates instead of names wherever you already have them",
        },
        limits: {
          refuses_above: {
            matrix_cells: ctx.cfg.maxMatrixCells,
            sweep_api_calls: ctx.cfg.sweepMaxPoints,
            detail:
              "These two are the only requests the server refuses on size. Both are env-tunable (GEOLINK_MAX_MATRIX_CELLS, GEOLINK_SWEEP_MAX_POINTS) and both errors name the exact parameter change that would succeed.",
          },
          no_ceiling_on: {
            search_limit: "any positive integer; cost scales linearly and the search stops early when the area runs out",
            sweep_results_per_point: "any value at or above the page size; multiplies the sweep's call count",
            detail: `Depth is uncapped by design. Past roughly ${DEEP_SEARCH_ADVISORY} results from a single center, a sweep usually returns more for the same spend, because depth re-reads one center while a sweep reads new ground.`,
          },
          concurrency: {
            sweep_points_in_parallel: ctx.cfg.sweepConcurrency,
            requests_per_deep_point: SWEEP_CLIENT_BATCH,
            outbound_budget: SWEEP_OUTBOUND_BUDGET,
            detail:
              "Points in flight are divided down as results_per_point rises, so points × their own parallel requests stays within the budget. The upstream reaches its source from one address without proxy rotation; a wide simultaneous burst is the pattern most likely to be throttled.",
          },
          response_size: {
            character_limit: 25_000,
            detail: "Long lists are halved until they fit and the response says so, with the parameter change that avoids it.",
          },
        },
        error_kinds: {
          auth: "key rejected — check GEOLINK_API_KEY",
          quota: "per-key allowance reached — reduce volume or wait",
          not_found: "nothing matched — broaden the query, switch language, or add a center",
          bad_request: "parameters out of range — the message carries the fix",
          timeout: "upstream did not answer in time — retry or shrink the request",
          network: "upstream unreachable",
          upstream: "upstream error or malformed payload — retry shortly",
        },
        reading_order: [
          "geolink://playbook — which tool answers which question, and the depth-versus-coverage distinction",
          "geolink://scale — measured latency and the partial-response behaviour",
          "geolink://playbook/coverage — covering a region without leaving holes",
          "geolink://playbook/recipes — compositions across several tools",
        ],
      }),
  );

  server.registerResource(
    "scale",
    "geolink://scale",
    {
      title: "Measured cost, latency and reliability",
      description: "What requests actually cost in time and calls, measured against the live upstream, plus the response variance an agent should account for.",
      mimeType: "application/json",
    },
    async (uri) =>
      json(uri.href, {
        ...MEASUREMENTS,
        how_to_use: [
          "Latency is dominated by the number of sequential rounds, not the number of results: 80 results cost four requests but return in about the time of one, because the requests run together.",
          "A sweep's wall-clock is roughly (grid_points ÷ concurrency) × the per-point time. Widening the grid saves more time than lowering depth.",
          "When a sweep would take more than a minute, run dry_run first and give the caller the estimate before spending it.",
        ],
        planning_rules: {
          one_center_question: "search_places with the limit you need",
          regional_question: "sweep_area, dry_run first",
          when_depth_stops_paying: `around ${DEEP_SEARCH_ADVISORY} results from one center — beyond that, new ground beats deeper reading`,
          matrix_over_loops: "one distance_matrix call replaces N×M directions calls and costs one request",
        },
      }),
  );

  const playbooks: [string, string, string, string][] = [
    ["playbook", "geolink://playbook", "Playbook — choosing and combining the tools", PLAYBOOK_INDEX],
    ["playbook-coverage", "geolink://playbook/coverage", "Covering an area without leaving holes", PLAYBOOK_COVERAGE],
    ["playbook-recipes", "geolink://playbook/recipes", "Compositions across several tools", PLAYBOOK_RECIPES],
  ];

  for (const [name, uri, title, body] of playbooks) {
    server.registerResource(
      name,
      uri,
      {
        title,
        description: `${title}. Written for an agent deciding what to call next.`,
        mimeType: "text/markdown",
      },
      async (u) => markdown(u.href, body),
    );
  }
}
