import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DEEP_SEARCH_ADVISORY,
  ENDPOINTS,
  SERVER_NAME,
  SERVER_VERSION,
  UPSTREAM_PAGE_SIZE,
} from "./constants.js";
import { EGYPT_GOVERNORATES } from "./data/governorates.js";
import {
  MEASUREMENTS,
  PLAYBOOK_COST,
  PLAYBOOK_COVERAGE,
  PLAYBOOK_INDEX,
  PLAYBOOK_RECIPES,
  PLAYBOOK_TRIPWIRES,
  SKILL_OVERVIEW,
} from "./playbook.js";
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
          sweep_spacing_km: "chosen by the API from measured behaviour, not set here",
          sweep_pages_per_point: "the API's own default",
        },
        tools: {
          geolink_geocode: "address or name → one point. There is no viewport — GeoLink holds no boundary geometry, so an area is always a centre and a radius you chose",
          geolink_reverse_geocode: "lat,lng → address with district and governorate",
          geolink_search_places: "text query around one center → places with rating, phone, hours and category; limit=0 reads until the source runs dry",
          geolink_get_directions: "A → B routes; geometry opt-in (summary | polyline | waypoints)",
          geolink_distance_matrix: "N×M travel times plus the nearest destination per origin",
          geolink_find_nearest: "rank options by road time from one origin — a different answer from the straight line, not a rounder one",
          geolink_sweep_area: "read a whole region from several vantage points and merge them; view=summary for counts",
        },
        cost_model: {
          unit: "upstream HTTP requests",
          geocode: 1,
          reverse_geocode: 1,
          search_places: "1 request to GeoLink; it does its own paging behind that. A name in `near` costs nothing extra - the API resolves it",
          get_directions: "1, +1 per endpoint passed as a name",
          distance_matrix: "1 regardless of grid size, +1 per location passed as a name",
          find_nearest: "1 request in search mode; 1 matrix plus geocodes when you pass a list of candidates",
          sweep_area: "1 request per call; dry_run reports how many calls the whole area needs",
          caching: "geocodes are cached in-process for 10 minutes. Whole search and sweep answers are cached too, so paging with offset costs nothing - it is served from the answer already in hand",
          cheapest_win: "pass coordinates instead of names wherever you already have them",
        },
        limits: {
          refuses_above: {
            matrix_cells: ctx.cfg.maxMatrixCells,
            detail:
              "The only request this server refuses on size. Env-tunable (GEOLINK_MAX_MATRIX_CELLS), and the error names the exact parameter change that would succeed. A sweep is bounded by the API's own time budget instead, which is why it can hand back `continue_from` rather than refuse.",
          },
          no_ceiling_on: {
            search_limit: "any positive integer, and 0 means read the point until the source runs dry",
            sweep_area: "any area the API will take; a large one comes back in pieces, each with a `continue_from` for the next",
            detail: `Depth is uncapped by design. Past roughly ${DEEP_SEARCH_ADVISORY} results from a single center, a sweep usually returns more for the same spend, because depth re-reads one center while a sweep reads new ground.`,
          },
          completeness: {
            results_complete:
              "On search, sweep and find_nearest. False means the source still had more to give, so `total` is a floor - read it as 'at least this many'. Absent means the API did not say, which is not the same as true.",
            area_fully_swept:
              "Sweep only, and a different question: whether every vantage point was visited, not whether each one was read to the end. False comes with `continue_from`.",
            detail:
              "These two fail independently and are fixed by different parameters - pages_per_point for the first, continue_from for the second. A response can be short on either, both, or neither.",
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
          "geolink://method — the seven gates from question to defensible answer, in order",
          "geolink://playbook — which tool answers which question, and the depth-versus-coverage distinction",
          "geolink://playbook/tripwires — the ten ways an answer comes back confidently wrong, each with its check",
          "geolink://playbook/coverage — covering a region without leaving holes",
          "geolink://playbook/cost — cost formulas and measured latency",
          "geolink://playbook/recipes — compositions across several tools",
          "geolink://scale — the same measurements as structured data",
        ],
      }),
  );

  server.registerResource(
    "egypt-governorates",
    "geolink://egypt/governorates",
    {
      title: "Egypt governorates",
      description:
        "The 27 governorates of Egypt in English and Arabic. Use a name as area={center: ..., radius_km: N} in geolink_sweep_area — the radius is yours to choose, there is no boundary geometry here — or match against address_parts.governorate values.",
      mimeType: "application/json",
    },
    async (uri) =>
      json(uri.href, {
        count: EGYPT_GOVERNORATES.length,
        governorates: EGYPT_GOVERNORATES,
        note: "address_parts.governorate comes back in the language the request asked for, so match on whichever spelling the call used. A national sweep is 27 separate area sweeps, not one — quote the total with dry_run before running it.",
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
    ["playbook-tripwires", "geolink://playbook/tripwires", "The ten ways a map answer comes back confidently wrong", PLAYBOOK_TRIPWIRES],
    ["playbook-cost", "geolink://playbook/cost", "Cost formulas, measured latency, and the planning rules that follow", PLAYBOOK_COST],
    ["method", "geolink://method", "The seven gates, in the order they have to run", SKILL_OVERVIEW],
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
