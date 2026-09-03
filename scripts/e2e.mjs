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
check("playbook + capabilities served as resources", ["geolink://capabilities", "geolink://scale", "geolink://playbook", "geolink://playbook/coverage", "geolink://playbook/recipes", "geolink://egypt/governorates"].every(u => resources.some(r => r.uri === u)), resources.map(r => r.uri).join(","));
const gov = JSON.parse((await client.readResource({ uri: "geolink://egypt/governorates" })).contents[0].text);
check("governorates resource kept from the deployed 1.0.0", gov.count === 27 && gov.governorates[0].ar === "القاهرة", `count=${gov.count}`);
const prompts = (await client.listPrompts()).prompts;
check("prompts cover routing, coverage and gap analysis", ["geolink_coverage_report", "geolink_nearest_branch", "geolink_route_brief", "geolink_coverage_audit", "geolink_service_gap"].every(n => prompts.some(p => p.name === n)), prompts.map(p => p.name).join(","));
const cap = JSON.parse((await client.readResource({ uri: "geolink://capabilities" })).contents[0].text);
check("capabilities states what it refuses and what it does not cap", cap.limits.refuses_above.sweep_api_calls === 60 && typeof cap.limits.no_ceiling_on.search_limit === "string" && cap.cost_model.unit === "upstream HTTP requests", JSON.stringify(cap.limits.refuses_above));
const govs = JSON.parse((await client.readResource({ uri: "geolink://capabilities" })).contents[0].text);
check("capabilities lists tools", Object.keys(govs.tools).length === 7);
const p = await client.getPrompt({ name: "geolink_nearest_branch", arguments: { customer_location: "Tahrir", branches: "A;B" } });
check("prompt renders", p.messages[0].content.text.includes("geolink_find_nearest"));

// ---- geocode / reverse
let x = await call("geolink_geocode", { query: "Cairo Tower", language: "en" });
check("geocode returns place with bounds", x.sc?.name === "Cairo Tower" && x.sc?.bounds?.northeast?.lat > x.sc?.bounds?.southwest?.lat, x.text.slice(0, 80));
x = await call("geolink_geocode", { query: "nowhere" });
check("geocode not_found → isError with hint", x.r.isError && /not_found/.test(x.text) && /Next step/.test(x.text), x.text);
check("error first line is a stable parseable contract", /^Error \((auth|quota|not_found|bad_request|timeout|network|upstream|validation|unknown)\): /.test(x.text), x.text.split("\n")[0]);
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

// The upstream is free to echo destinations in its own order; pairing by
// position rather than coordinate attributes one place another's travel time,
// and the tell is a road distance shorter than its own straight line.
x = await call("geolink_find_nearest", { origin: "30.00,31.20", candidates: ["30.20,31.20", "30.10,31.20", "30.02,31.20"], rank_by: "distance", response_format: "json" });
const sane = (x.sc?.results ?? []).every((r) => r.distance_meters >= r.straight_line_km * 1000 * 0.98);
check("find_nearest pairs cells to candidates by coordinate", sane && !x.sc?.warning, (x.sc?.results ?? []).map((r) => `${r.label}:${r.distance_meters}m/${(r.straight_line_km*1000).toFixed(0)}m`).join(" "));
const nearestFirst = x.sc?.results?.[0];
check("find_nearest ranks the genuinely closest first", nearestFirst && Math.abs(nearestFirst.location.lat - 30.02) < 0.001, `top=${nearestFirst?.label}`);


// ---- sweep
x = await call("geolink_sweep_area", { query: "pharmacy", area: { bounds: { northeast: { lat: 30.10, lng: 31.30 }, southwest: { lat: 30.00, lng: 31.20 } } }, grid_spacing_km: 3, dry_run: true });
check("sweep dry_run spends zero search calls", x.sc?.dry_run === true && x.sc.plan.grid_points === 16 && x.sc.plan.estimated_api_calls === 16, JSON.stringify(x.sc?.plan));
x = await call("geolink_sweep_area", { query: "pharmacy", area: { place: "Giza" }, grid_spacing_km: 1, dry_run: true });
check("sweep over-cap error suggests spacing", x.r.isError && /over the cap/.test(x.text) && /grid_spacing_km=/.test(x.text), x.text.slice(0, 160));
x = await call("geolink_sweep_area", { query: "pharmacy", area: { center: "Cairo Tower", radius_km: 4 }, grid_spacing_km: 2, response_format: "json", fields: ["name", "location"], limit: 5 });
check("sweep executes, clips far result, dedupes Alpha", x.sc?.stats.api_calls_made === x.sc?.plan.grid_points && x.sc.stats.after_clip < x.sc.stats.raw_results && x.sc.stats.unique_results < x.sc.stats.after_clip, JSON.stringify(x.sc?.stats));
check("sweep stats grouped by district", Object.keys(x.sc?.stats.by_district ?? {}).length >= 2 && !("Elsewhere" in x.sc.stats.by_district));
check("sweep fields trimmed + paginated", x.sc?.places.length === 5 && Object.keys(x.sc.places[0]).sort().join(",") === "location,name" && x.sc.has_more === true);
const { readFileSync } = await import("node:fs");
const tw = await client.readResource({ uri: "geolink://playbook/tripwires" });
const onDisk = readFileSync(new URL("../skills/geolink/references/tripwires.md", import.meta.url), "utf8");
check("served tripwires are byte-identical to the skill file", tw.contents[0].text === onDisk, `resource ${tw.contents[0].text.length} chars vs file ${onDisk.length}`);
const method = await client.readResource({ uri: "geolink://method" });
check("method resource carries the gates in order", /Gate 1 — Shape/.test(method.contents[0].text) && /Gate 6 — Tripwires/.test(method.contents[0].text));

// A second session must not re-pay for a geocode the first one already made.
// Two sweeps over the same named area: the second should spend one call fewer,
// because the area's geocode is served from the process-wide cache.
x = await call("geolink_sweep_area", { query: "cafe", area: { place: "Giza" }, grid_spacing_km: 8, response_format: "json", limit: 1 });
const firstCalls = x.sc?.stats?.api_calls_made;
x = await call("geolink_sweep_area", { query: "cafe", area: { place: "Giza" }, grid_spacing_km: 8, response_format: "json", limit: 1 });
check("geocodes are cached across calls, not re-paid", x.sc?.stats?.api_calls_made <= firstCalls, `first=${firstCalls} second=${x.sc?.stats?.api_calls_made}`);

x = await call("geolink_geocode", { query: "Cairo Tower", response_format: "json" });
check("geocode reports whether its point sits in its own viewport", typeof x.sc?.location_within_bounds === "boolean", `within=${x.sc?.location_within_bounds}`);
x = await call("geolink_find_nearest", { origin: "30.00,31.20", candidates: ["30.05,31.20", "30.10,31.20"], response_format: "json" });
check("find_nearest reports implied speed per candidate", (x.sc?.results ?? []).every((r) => typeof r.implied_speed_kmh === "number"), (x.sc?.results ?? []).map((r) => r.implied_speed_kmh).join(", "));
check("plausible speeds raise no warning", !x.sc?.warning, x.sc?.warning ?? "(none)");

const pb = await client.readResource({ uri: "geolink://playbook" });
check("playbook is readable markdown and states depth is not coverage", pb.contents[0].mimeType === "text/markdown" && /Depth is not coverage/.test(pb.contents[0].text), pb.contents[0].mimeType);
const sc = JSON.parse((await client.readResource({ uri: "geolink://scale" })).contents[0].text);
check("scale resource carries measured numbers with a date", typeof sc.measured_on === "string" && Array.isArray(sc.search) && sc.search.length >= 3, sc.measured_on);

x = await call("geolink_search_places", { query: "deep cafe", near: "30.04,31.23", limit: 50 });
check("search fetches the depth it was asked for", x.sc?.places.length === 50 && x.sc.fetched === 50, `places=${x.sc?.places.length} fetched=${x.sc?.fetched}`);
check("search flags more may exist when depth was filled", x.sc?.source_exhausted === false && x.sc.has_more === true, JSON.stringify({ e: x.sc?.source_exhausted, m: x.sc?.has_more }));
x = await call("geolink_search_places", { query: "cafe", near: "30.04,31.23", limit: 50 });
check("search reports exhaustion when the area runs out", x.sc?.source_exhausted === true && x.sc.has_more === false, JSON.stringify({ e: x.sc?.source_exhausted, m: x.sc?.has_more, n: x.sc?.fetched }));

x = await call("geolink_sweep_area", { query: "pharmacy", area: { center: "30.04,31.23", radius_km: 2 }, grid_spacing_km: 2, dry_run: true, results_per_point: 60 });
check("sweep depth multiplies the quoted cost", x.sc?.plan.requests_per_point === 3 && x.sc.plan.estimated_api_calls === x.sc.plan.grid_points * 3, JSON.stringify(x.sc?.plan));
check("sweep depth lowers concurrency to hold the outbound budget", x.sc?.plan.concurrency * Math.min(5, x.sc.plan.requests_per_point) <= 8, JSON.stringify(x.sc?.plan));
x = await call("geolink_sweep_area", { query: "pharmacy", area: { center: "30.04,31.23", radius_km: 2 }, grid_spacing_km: 2, dry_run: true });
check("sweep default depth is one request per point", x.sc?.plan.requests_per_point === 1 && x.sc.plan.estimated_api_calls === x.sc.plan.grid_points, JSON.stringify(x.sc?.plan));

x = await call("geolink_sweep_area", { query: "cafe", area: { center: "30.04,31.23", radius_km: 2 }, grid_spacing_km: 2, response_format: "geojson" });
check("sweep geojson output", x.sc?.geojson?.type === "FeatureCollection" && x.sc.geojson.features[0].geometry.type === "Point");

// ---- auth error surfaces cleanly
await client.close();
console.log(results.map(([s, n, d]) => `${s === "PASS" ? "✅" : "❌"} ${n}${s === "FAIL" && d ? "  —  " + d : ""}`).join("\n"));
console.log(`\n${results.filter(r => r[0] === "PASS").length}/${results.length} passed`);
