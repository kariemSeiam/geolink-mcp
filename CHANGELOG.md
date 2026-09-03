# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [1.2.0] - 2026-09-03

### Added
- The playbook now travels over the protocol as resources, so the guidance reaches any client — an IDE agent, a chat model, a harness with no filesystem — with nothing to install: `geolink://playbook` (which tool answers which question, and why depth is not coverage), `geolink://playbook/coverage` (the three ways area coverage silently fails and the test for each), `geolink://playbook/recipes` (compositions across several tools), `geolink://scale` (measured call counts, latency and response variance, dated).
- `geolink_coverage_audit` prompt: runs a sweep, then tests the result for saturated cells, insufficient tile overlap, and edges outside the geocoded viewport before reporting a number.
- `geolink_service_gap` prompt: two comparable sweeps, a demand-versus-supply ranking by district, and the road time to the nearest existing service as the closing argument.
- `geolink://capabilities` now carries the full cost model, both guard rails with their env variables, every error kind, and a reading order.

### Changed
- Search depth has no ceiling. `limit` and `results_per_point` accept any value; cost scales linearly, the search stops early when the area runs out, and the docs carry the point past which a sweep returns more than depth for the same spend. The two size guards that remain — matrix cells and sweep API calls — are what make the cost quote meaningful, are env-tunable, and name the exact fix when they refuse.
- Server instructions now state the depth-versus-coverage distinction up front and point at the resources, so a client reads it before its first call.

## [1.1.0] - 2026-09-03

### Added
- `geolink_search_places` now pages to the depth `limit` asks for instead of returning a single upstream page, and reports `fetched` and `source_exhausted` so an agent is told when there is nothing more to find rather than having to guess.
- `geolink_sweep_area` gained `results_per_point`, which raises how many places each grid point pulls — the fix for dense categories where one point holds more matches than a single request returns.
- `geolink_find_nearest` searches deeper than `candidate_limit` in search mode, so the straight-line pre-filter chooses from a real pool; `candidate_limit` now goes to 50.

### Changed
- Sweep's cost cap and `dry_run` quote are now counted in API calls rather than grid points, so they stay accurate when `results_per_point` multiplies the work. `plan` reports `requests_per_point`, `estimated_api_calls`, and the `concurrency` actually used.
- Sweep automatically lowers how many grid points it runs in parallel as depth rises, holding total simultaneous upstream requests within a fixed budget.

### Fixed
- The place-search cache key ignored search depth, so a shallow response could be served to a request that asked for more.
- `geolink_find_nearest` checked its candidate-count guard after geocoding candidates and running the search; it now refuses before spending anything.
- HTTP sessions were never evicted — a client that vanished without a `DELETE` leaked a session for the lifetime of the process. Idle sessions are now reaped.
- Removed the OAuth discovery metadata: it advertised `/oauth/authorize` and `/oauth/token`, neither of which exists, so a client following it failed mid-handshake instead of connecting unauthenticated.
- Documentation claimed HTTP mode was stateless per request and omitted search depth from the extension guide; both now match the code.

## [1.0.2] - 2026-09-03

### Changed

- **Renamed the package and repository from `geolink-mcp-server` to `geolink-mcp`.**
  Install command, `bin` entry, Docker image/container names, `server.json`,
  and `smithery.yaml` all updated. GitHub redirects the old repo URL
  automatically.
- Rewrote README.md end to end: architecture diagram, tool-by-tool deep
  dives, FAQ, and a "why this server exists" section grounded in what
  actually differentiates the composite tools (`find_nearest`,
  `sweep_area`) from a thin 1:1 endpoint wrapper.
- Fixed stale tool-description defaults left over from the region
  clean-up in 1.0.1 (`geolink_geocode`, `geolink_reverse_geocode`,
  `geolink_search_places`, `geolink_get_directions`, `geolink_distance_matrix`
  still documented `"ar"`/`"eg"` as defaults after the code changed to
  `"en"`/unset — description text now matches actual behavior).

## [1.0.1] - 2026-09-03

### Security

- Removed a hardcoded default GeoLink API key from `src/config.ts`.
  `GEOLINK_API_KEY` is now required with no fallback — the server fails
  fast with a clear message if it's missing. The leaked key has been
  rotated upstream.

### Changed

- Removed the Egypt-only `geolink://egypt/governorates` resource. Default
  language/country are now `en`/unset instead of `ar`/`eg`. The server has
  no region lock-in; GeoLink's own data coverage is strongest in Egypt
  today, but every tool still works with coordinates or place names
  anywhere GeoLink resolves them.

## [1.0.0] - 2026-09-03

### Added

- Initial public release.
- Core tools: `geolink_geocode`, `geolink_reverse_geocode`, `geolink_search_places`,
  `geolink_get_directions`, `geolink_distance_matrix`.
- Composite tools: `geolink_find_nearest` (rank by real road time, not straight
  line), `geolink_sweep_area` (grid-tiled exhaustive area coverage with
  dry-run cost preview, Arabic-aware dedup, district/governorate grouping).
- Resources: `geolink://capabilities`.
- Prompts: `geolink_coverage_report`, `geolink_nearest_branch`, `geolink_route_brief`.
- stdio and stateless Streamable HTTP transports; `/healthz` liveness endpoint.
- Unit tests (grid math, polyline decode against a Google reference vector,
  Arabic-aware dedup, normalizers), e2e suite against a mock GeoLink server,
  and an HTTP/CLI smoke test.
- Docker image and `docker-compose.yml` (binds `127.0.0.1:3010` by default).
- CI: build + test matrix (Node 18/20/22), Docker build, CodeQL analysis.
