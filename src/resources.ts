import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { ToolContext } from "./services/resolve.js";

/**
 * Egypt's 27 governorates (English + Arabic). Names only — pass one to
 * geolink_sweep_area as area={place: "..."} and GeoLink returns live bounds.
 */
export const EGYPT_GOVERNORATES: { en: string; ar: string }[] = [
  { en: "Cairo", ar: "القاهرة" },
  { en: "Giza", ar: "الجيزة" },
  { en: "Alexandria", ar: "الإسكندرية" },
  { en: "Qalyubia", ar: "القليوبية" },
  { en: "Dakahlia", ar: "الدقهلية" },
  { en: "Sharqia", ar: "الشرقية" },
  { en: "Gharbia", ar: "الغربية" },
  { en: "Menofia", ar: "المنوفية" },
  { en: "Beheira", ar: "البحيرة" },
  { en: "Kafr El Sheikh", ar: "كفر الشيخ" },
  { en: "Damietta", ar: "دمياط" },
  { en: "Port Said", ar: "بورسعيد" },
  { en: "Ismailia", ar: "الإسماعيلية" },
  { en: "Suez", ar: "السويس" },
  { en: "North Sinai", ar: "شمال سيناء" },
  { en: "South Sinai", ar: "جنوب سيناء" },
  { en: "Red Sea", ar: "البحر الأحمر" },
  { en: "Matrouh", ar: "مطروح" },
  { en: "New Valley", ar: "الوادي الجديد" },
  { en: "Fayoum", ar: "الفيوم" },
  { en: "Beni Suef", ar: "بني سويف" },
  { en: "Minya", ar: "المنيا" },
  { en: "Assiut", ar: "أسيوط" },
  { en: "Sohag", ar: "سوهاج" },
  { en: "Qena", ar: "قنا" },
  { en: "Luxor", ar: "الأقصر" },
  { en: "Aswan", ar: "أسوان" },
];

export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "capabilities",
    "geolink://capabilities",
    {
      title: "GeoLink MCP capabilities",
      description: "Endpoints wrapped by this server, defaults, safety limits, and recommended tool workflows.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              server: { name: SERVER_NAME, version: SERVER_VERSION },
              upstream: { base_url: ctx.cfg.baseUrl, endpoints: ENDPOINTS, auth: "query parameter `key` (set via GEOLINK_API_KEY)" },
              defaults: { language: ctx.cfg.defaultLanguage, country: ctx.cfg.defaultCountry, timeout_ms: ctx.cfg.timeoutMs },
              limits: {
                max_matrix_cells: ctx.cfg.maxMatrixCells,
                sweep_max_points: ctx.cfg.sweepMaxPoints,
                sweep_concurrency: ctx.cfg.sweepConcurrency,
                character_limit_per_response: 25_000,
              },
              tools: {
                geolink_geocode: "address/name → one place with bounds",
                geolink_reverse_geocode: "lat,lng → address with district/governorate",
                geolink_search_places: "text query (+ optional center) → paged places",
                geolink_get_directions: "A → B routes; geometry opt-in (summary | polyline | waypoints)",
                geolink_distance_matrix: "N×M travel times + nearest per origin; guarded by max_matrix_cells",
                geolink_find_nearest: "rank known candidates or searched places by road time from one origin",
                geolink_sweep_area: "grid-tile an area and merge searches; dry_run first",
              },
              workflows: [
                "Coverage of a category in a region: geolink_sweep_area(dry_run=true) → adjust spacing → geolink_sweep_area → group by address_parts.district",
                "Best branch for a customer: geolink_find_nearest(origin=customer, candidates=[branches])",
                "Delivery ETA: geolink_get_directions(route_detail='summary')",
                "Map rendering: geolink_get_directions(route_detail='polyline') or geolink_sweep_area(response_format='geojson')",
              ],
              api_calls_per_tool: {
                geocode: 1,
                reverse_geocode: 1,
                search_places: "1 (+1 if `near` is a name, cached)",
                get_directions: "1 (+1 per named endpoint, cached)",
                distance_matrix: "1 (+1 per named location, cached)",
                find_nearest: "1 matrix (+1 search in search mode, + cached geocodes)",
                sweep_area: "grid_points (+1 geocode for named areas)",
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "egypt-governorates",
    "geolink://egypt/governorates",
    {
      title: "Egypt governorates",
      description: "The 27 governorates of Egypt in English and Arabic. Use a name as area={place: ...} in geolink_sweep_area, or match address_parts.governorate values.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ count: EGYPT_GOVERNORATES.length, governorates: EGYPT_GOVERNORATES }, null, 2),
        },
      ],
    }),
  );
}
