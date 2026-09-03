# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [1.0.0] - 2026-09-03

### Added

- Initial public release.
- Core tools: `geolink_geocode`, `geolink_reverse_geocode`, `geolink_search_places`,
  `geolink_get_directions`, `geolink_distance_matrix`.
- Composite tools: `geolink_find_nearest` (rank by real road time, not straight
  line), `geolink_sweep_area` (grid-tiled exhaustive area coverage with
  dry-run cost preview, Arabic-aware dedup, district/governorate grouping).
- Resources: `geolink://capabilities`, `geolink://egypt/governorates`.
- Prompts: `geolink_coverage_report`, `geolink_nearest_branch`, `geolink_route_brief`.
- stdio and stateless Streamable HTTP transports; `/healthz` liveness endpoint.
- Unit tests (grid math, polyline decode against a Google reference vector,
  Arabic-aware dedup, normalizers), e2e suite against a mock GeoLink server,
  and an HTTP/CLI smoke test.
- Docker image and `docker-compose.yml` (binds `127.0.0.1:3010` by default).
- CI: build + test matrix (Node 18/20/22), Docker build, CodeQL analysis.
