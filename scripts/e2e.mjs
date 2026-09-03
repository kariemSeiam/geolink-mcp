// End-to-end: real MCP client ↔ our server over stdio ↔ mock GeoLink over HTTP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, GEOLINK_API_KEY: process.env.E2E_KEY ?? "test-key", GEOLINK_BASE_URL: "http://127.0.0.1:4545", GEOLINK_SWEEP_MAX_POINTS: "60", GEOLINK_MAX_MATRIX_CELLS: "20" },
  stderr: "pipe",
});
await client.connect(transport);

const results = [];
const check = (name, cond, detail = "") => { results.push([cond ? "PASS" : "FAIL", name, detail]); if (!cond) process.exitCode = 1; };
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { r, sc: r.structuredContent, text: r.content?.[0]?.text ?? "" }; };

// ---- discovery
const tools = (await client.listTools()).tools;
check("7 tools registered", tools.length === 7, tools.map(t => t.name).join(","));
check("all tools have annotations + outputSchema", tools.every(t => t.annotations?.readOnlyHint === true && t.outputSchema));
const resources = (await client.listResources()).resources;
check("1 resource", resources.length === 1, resources.map(r => r.uri).join(","));
const prompts = (await client.listPrompts()).prompts;
check("3 prompts", prompts.length === 3, prompts.map(p => p.name).join(","));
const cap = JSON.parse((await client.readResource({ uri: "geolink://capabilities" })).contents[0].text);
check("capabilities resource has limits", cap.limits.sweep_max_points === 60);
const govs = JSON.parse((await client.readResource({ uri: "geolink://capabilities" })).contents[0].text);
check("capabilities lists tools", Object.keys(govs.tools).length === 7);
const p = await client.getPrompt({ name: "geolink_nearest_branch", arguments: { customer_location: "Tahrir", branches: "A;B" } });
check("prompt renders", p.messages[0].content.text.includes("geolink_find_nearest"));

// ---- geocode / reverse
let x = await call("geolink_geocode", { query: "Cairo Tower", language: "en" });
check("geocode returns place with bounds", x.sc?.name === "Cairo Tower" && x.sc?.bounds?.northeast?.lat > x.sc?.bounds?.southwest?.lat, x.text.slice(0, 80));
x = await call("geolink_geocode", { query: "nowhere" });
check("geocode not_found → isError with hint", x.r.isError && /not_found/.test(x.text) && /Next step/.test(x.text), x.text);
x = await call("geolink_reverse_geocode", { latitude: 30.0459, longitude: 31.2243, response_format: "json" });
check("reverse geocode json", x.sc?.address_parts?.district === "Zamalek");

// ---- search with named center + distance sort
x = await call("geolink_search_places", { query: "pharmacy", near: "Cairo Tower", limit: 2 });
check("search resolves named center", x.sc?.center?.source === "geocode");
check("search paginates", x.sc?.count === 2 && x.sc?.has_more === true && x.sc?.next_offset === 2, JSON.stringify({c: x.sc?.count, t: x.sc?.total}));
check("search sorted by distance", x.sc?.places[0].distance_km <= x.sc?.places[1].distance_km);

// ---- directions: detail levels
x = await call("geolink_get_directions", { origin: "Tahrir Square", destination: "30.0490,31.2390" });
check("directions summary has no geometry", x.sc?.routes.length === 3 && !("polyline" in x.sc.routes[0]) && !("waypoints" in x.sc.routes[0]) && x.sc.routes[0].waypoint_count === 500);
check("directions repairs swapped bounds", x.sc?.routes[0].bounds.northeast.lat >= x.sc?.routes[0].bounds.southwest.lat);
check("directions mixed name+coords resolved", x.sc?.origin.source === "geocode" && x.sc?.destination.source === "coordinates");
x = await call("geolink_get_directions", { origin: "30.0444,31.2357", destination: "30.0490,31.2390", route_detail: "polyline", max_alternatives: 1 });
check("directions polyline present & compact", typeof x.sc?.routes[0].polyline === "string" && x.sc.routes[0].polyline.length < 3000 && x.sc.route_count === 1, `len=${x.sc?.routes[0].polyline?.length}`);
x = await call("geolink_get_directions", { origin: "30.0444,31.2357", destination: "30.0490,31.2390", route_detail: "waypoints", max_waypoints: 25, max_alternatives: 1 });
check("directions waypoints sampled to cap", x.sc?.routes[0].waypoints.length === 25 && x.sc.routes[0].waypoints_sampled === true);

// ---- matrix
x = await call("geolink_distance_matrix", { origins: ["30.04,31.23", "30.05,31.24"], destinations: ["30.06,31.25", "Cairo Tower"], nearest_only: true });
check("matrix nearest_only omits grid", x.sc?.nearest.length === 2 && !("matrix" in x.sc) && x.sc.cells === 4);
x = await call("geolink_distance_matrix", { origins: Array(5).fill("30.04,31.23"), destinations: Array(5).fill("30.06,31.25") });
check("matrix cell guard fires with batching hint", x.r.isError && /25 cells/.test(x.text) && /batches/.test(x.text), x.text.slice(0, 120));

// ---- find_nearest
x = await call("geolink_find_nearest", { origin: "30.0444,31.2357", candidates: ["30.10,31.30", "30.05,31.24", "30.20,31.40"], limit: 2 });
check("find_nearest ranks by duration", x.sc?.results[0].rank === 1 && x.sc.results[0].duration_seconds <= x.sc.results[1].duration_seconds && x.sc.results[0].is_geolink_nearest === true);
x = await call("geolink_find_nearest", { origin: "30.0444,31.2357", search_query: "hospital", candidate_limit: 3 });
check("find_nearest search mode attaches place", x.sc?.source === "search" && x.sc.results[0].place?.address_parts?.country === "EG");
x = await call("geolink_find_nearest", { origin: "30.0444,31.2357" });
check("find_nearest rejects neither mode", x.r.isError && /exactly one/.test(x.text));

// ---- sweep
x = await call("geolink_sweep_area", { query: "pharmacy", area: { bounds: { northeast: { lat: 30.10, lng: 31.30 }, southwest: { lat: 30.00, lng: 31.20 } } }, grid_spacing_km: 3, dry_run: true });
check("sweep dry_run spends zero search calls", x.sc?.dry_run === true && x.sc.plan.grid_points === 16 && x.sc.plan.estimated_api_calls === 16, JSON.stringify(x.sc?.plan));
x = await call("geolink_sweep_area", { query: "pharmacy", area: { place: "Giza" }, grid_spacing_km: 1, dry_run: true });
check("sweep over-cap error suggests spacing", x.r.isError && /exceeds the cap/.test(x.text) && /grid_spacing_km=/.test(x.text), x.text.slice(0, 160));
x = await call("geolink_sweep_area", { query: "pharmacy", area: { center: "Cairo Tower", radius_km: 4 }, grid_spacing_km: 2, response_format: "json", fields: ["name", "location"], limit: 5 });
check("sweep executes, clips far result, dedupes Alpha", x.sc?.stats.api_calls_made === x.sc?.plan.grid_points && x.sc.stats.after_clip < x.sc.stats.raw_results && x.sc.stats.unique_results < x.sc.stats.after_clip, JSON.stringify(x.sc?.stats));
check("sweep stats grouped by district", Object.keys(x.sc?.stats.by_district ?? {}).length >= 2 && !("Elsewhere" in x.sc.stats.by_district));
check("sweep fields trimmed + paginated", x.sc?.places.length === 5 && Object.keys(x.sc.places[0]).sort().join(",") === "location,name" && x.sc.has_more === true);
x = await call("geolink_sweep_area", { query: "cafe", area: { center: "30.04,31.23", radius_km: 2 }, grid_spacing_km: 2, response_format: "geojson" });
check("sweep geojson output", x.sc?.geojson?.type === "FeatureCollection" && x.sc.geojson.features[0].geometry.type === "Point");

// ---- auth error surfaces cleanly
await client.close();
console.log(results.map(([s, n, d]) => `${s === "PASS" ? "✅" : "❌"} ${n}${s === "FAIL" && d ? "  —  " + d : ""}`).join("\n"));
console.log(`\n${results.filter(r => r[0] === "PASS").length}/${results.length} passed`);
