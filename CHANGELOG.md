# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

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
