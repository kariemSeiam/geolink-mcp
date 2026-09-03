# geolink-mcp-server

[![CI](https://github.com/kariemSeiam/geolink-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/kariemSeiam/geolink-mcp-server/actions/workflows/ci.yml)
[![CodeQL](https://github.com/kariemSeiam/geolink-mcp-server/actions/workflows/codeql.yml/badge.svg)](https://github.com/kariemSeiam/geolink-mcp-server/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/geolink-mcp-server)](https://www.npmjs.com/package/geolink-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server-blueviolet)](https://modelcontextprotocol.io)

**GeoLink for AI agents.** An MCP server that puts [GeoLink](https://geolink-eg.com) — Egypt-native geocoding, reverse geocoding, place search, directions, and distance matrix — into Claude, Cursor, Claude Code, and any other MCP client, then goes further with two composite tools that turn raw endpoints into answers agents actually need:

- **`geolink_find_nearest`** — *"which branch is really closest by road?"* — ranks known candidates or searched places by true travel time from one origin.
- **`geolink_sweep_area`** — *"every pharmacy in Giza"* — tiles an area (governorate, city, radius, or box) with a grid of query points, runs a search at each, merges, de-duplicates, clips, and groups the results by district. Dry-run first to see the exact API cost.

Every result carries GeoLink's structured `address_parts {district, governorate, country}`, so agents group and filter on real fields instead of parsing address strings.

---

## Install

You need Node.js ≥ 18 and a GeoLink API key ([free tier, no card](https://geolink-eg.com/register)).

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "geolink": {
      "command": "npx",
      "args": ["-y", "geolink-mcp-server"],
      "env": { "GEOLINK_API_KEY": "your_api_key_here" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add geolink -e GEOLINK_API_KEY=your_api_key_here -- npx -y geolink-mcp-server
```

### Cursor / Windsurf / other stdio clients

Same shape: command `npx`, args `["-y", "geolink-mcp-server"]`, env `GEOLINK_API_KEY`.

### From source

```bash
git clone <this repo> && cd geolink-mcp-server
npm install && npm run build
GEOLINK_API_KEY=... node dist/index.js
```

### Remote (Streamable HTTP)

```bash
GEOLINK_API_KEY=... TRANSPORT=http PORT=3000 node dist/index.js
# → POST http://127.0.0.1:3000/mcp   (stateless JSON; GET /healthz for liveness)
```

Binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` only behind a reverse proxy that handles auth and origin checks.

---

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `GEOLINK_API_KEY` | — | **Required.** Passed to GeoLink as the `key` query parameter. Never logged. |
| `GEOLINK_BASE_URL` | `https://www.geolink-eg.com` | Override for staging/mocks. |
| `GEOLINK_DEFAULT_LANGUAGE` | `ar` | Any tool call can override with `language`. |
| `GEOLINK_DEFAULT_COUNTRY` | `eg` | Any tool call can override with `country`. |
| `GEOLINK_TIMEOUT_MS` | `30000` | Per upstream request. |
| `GEOLINK_MAX_MATRIX_CELLS` | `100` | `origins × destinations` cap for the matrix tools. |
| `GEOLINK_SWEEP_MAX_POINTS` | `200` | Max grid points (= max API calls) per sweep. |
| `GEOLINK_SWEEP_CONCURRENCY` | `4` | Parallel requests during a sweep. |
| `TRANSPORT` | `stdio` | `stdio` or `http`. |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | HTTP only. |

---

## Tools

All tools are read-only, accept `language` / `country` / `response_format` (`markdown` or `json`), and always attach machine-readable `structuredContent` validated against an `outputSchema`. Any parameter called a *location* accepts **either** `"lat,lng"` / `{lat, lng}` **or** a place name — names are geocoded automatically (one call, cached 10 min in-process).

| Tool | Does | Upstream calls |
| --- | --- | --- |
| `geolink_geocode` | Address → one place with `address_parts` + viewport `bounds` | 1 |
| `geolink_reverse_geocode` | `lat,lng` → address with `address_parts` + `bounds` | 1 |
| `geolink_search_places` | Text query, optional `near` center; paged; sorted by distance with `distance_km` | 1 (+1 if `near` is a name) |
| `geolink_get_directions` | A → B with alternatives; geometry is opt-in via `route_detail` | 1 (+1 per named endpoint) |
| `geolink_distance_matrix` | N×M travel times + nearest per origin; `nearest_only` for O(N) output | 1 (+1 per named location) |
| `geolink_find_nearest` | Rank candidates or searched places by road time from one origin | 1 matrix (+1 search in search mode) |
| `geolink_sweep_area` | Grid-tile an area and merge searches; `dry_run` costs nothing | = grid points (+1 for a named area) |

### `geolink_get_directions` — geometry on demand

GeoLink's v2 directions return several alternatives, each with a full waypoint path (hundreds of coordinate pairs). Dumping that into a model's context is mostly wasted tokens, so:

| `route_detail` | Returns | Use for |
| --- | --- | --- |
| `summary` *(default)* | distance, duration, endpoints, bounds, `waypoint_count` | ETAs, comparisons, planning |
| `polyline` | summary + Google-encoded polyline (precision 5) | drawing on a map — ~10× smaller than raw points |
| `waypoints` | summary + `[lat,lng][]` evenly sampled to `max_waypoints` (default 200) | when you truly need coordinates |

Also returns `straight_line_km` so an agent can sanity-check detour ratios, and repairs bounding boxes whose NE/SW corners arrive swapped.

### `geolink_find_nearest` — road time, not straight line

```
origin = "customer address" or "30.05,31.23"
candidates = ["Branch A", "30.10,31.30", ...]      # mode 1: known options
search_query = "pharmacy", candidate_limit = 10    # mode 2: discover near origin
rank_by = "duration" | "distance"
```

Mode 2 searches near the origin, keeps the `candidate_limit` closest by straight line, then routes them in one matrix call and re-ranks by real travel time. Results flag `is_geolink_nearest` when the winner matches GeoLink's own `nearest_destination_index`.

### `geolink_sweep_area` — exhaustive coverage

A single search returns one page from one center. To find *everything* in an area:

1. Resolve the area → bounds (`{place}` via geocode viewport, `{center, radius_km}`, or `{bounds}`), optionally padded by `padding_km`.
2. Lay a square grid, one query point per `grid_spacing_km × grid_spacing_km` cell (longitude corrected for latitude; circle areas drop the corners).
3. Run one `text_search` per point with bounded concurrency; tolerate individual failures, abort on auth/quota errors.
4. Clip results to the area (`clip_to_area`), de-duplicate (same normalized name within `dedupe_meters`, Arabic-aware: tashkeel stripped, alef/ta-marbuta/alef-maqsura folded), and count by `governorate` and `district`.
5. Page with `limit`/`offset`; trim with `fields`; or emit a GeoJSON `FeatureCollection` with `response_format="geojson"`.

**Cost math:** points ≈ `ceil(width / spacing) × ceil(height / spacing)`. Giza's viewport at 3 km is a few dozen points; at 1 km it's hundreds. **Always `dry_run: true` first** — it returns the exact grid size and call count without touching the search endpoint. If the grid exceeds `GEOLINK_SWEEP_MAX_POINTS`, the error tells you the smallest spacing that fits.

Spacing guide: dense urban categories (pharmacies, cafés) 2–3 km; sparse categories or rural governorates 5–7 km. The search endpoint's own result cap determines how much each point "sees"; when GeoLink raises per-query results to 200–500, widen spacing accordingly.

Clients that pass a `progressToken` receive `notifications/progress` as grid points complete.

---

## Resources

| URI | Contents |
| --- | --- |
| `geolink://capabilities` | Endpoints wrapped, defaults, active limits, per-tool call cost, recommended workflows |
| `geolink://egypt/governorates` | The 27 governorates (English + Arabic) — pass a name as `area: {place: ...}` |

## Prompts

| Prompt | Args | Drives |
| --- | --- | --- |
| `geolink_coverage_report` | `category`, `area` | dry-run → tune → sweep → per-district summary |
| `geolink_nearest_branch` | `customer_location`, `branches` | `find_nearest` + recommendation, flags straight-line vs road disagreements |
| `geolink_route_brief` | `origin`, `destination` | directions with polyline + detour ratio |

---

## Errors

Every failure is returned in-band (`isError: true`) as `Error (<kind>): <what happened>` + `Next step: <what to do>`. Kinds: `auth`, `quota`, `not_found`, `bad_request`, `timeout`, `network`, `upstream`. Guard-rail errors (matrix too big, grid over cap) include the exact parameter change that would succeed.

## Design notes

- **One response envelope in, one out.** GeoLink's `{success, data}` / `{success, error}` is normalized once in the client; tools never see raw payloads. Every field is defaulted, so `outputSchema` validation can't fail on a sparse upstream response.
- **Token budget is a first-class constraint.** Geometry is opt-in, matrix grids can collapse to nearest-only, sweeps page and field-trim, and every list respects a 25 000-character ceiling with an explicit truncation message.
- **Egypt-first defaults, world-ready inputs.** `ar`/`eg` unless told otherwise; Arabic and English queries; Arabic-aware dedup.
- **No fabricated data.** The governorate resource is names only — bounds always come live from GeoLink's geocoder.
- **Stateless HTTP.** A fresh server + transport per request; no sessions to leak. stdio never writes to stdout except protocol frames.

## Development

```bash
npm install
npm run build          # tsc → dist/
npm test               # unit tests: grid, polyline (Google reference vector), dedup, normalizers
npm run test:e2e       # real MCP client ↔ server ↔ mock GeoLink (scripts/mock-geolink.mjs), 29 checks
npm run inspect        # MCP Inspector against dist/index.js
bash scripts/smoke.sh  # HTTP transport, auth-failure path, startup validation, CLI flags
```

`scripts/mock-geolink.mjs` mirrors the documented response shapes (including deliberately swapped bounds and a far-away result to exercise clipping) — point `GEOLINK_BASE_URL` at it for offline work.

## Extending

When GeoLink adds fields (website, phone, category, rating…) or raises per-query result counts:

1. Add the raw field to `RawPlace` in `src/types.ts` and the clean field to `Place`.
2. Map it in `normalizePlace` (`src/services/normalize.ts`) with a safe default.
3. Add it to `PlaceSchema` (`src/services/schemas.ts`) and, if trimmable, to the `fields` enum in `src/tools/sweep.ts`.
4. Render it in `placeMarkdown` (`src/services/format.ts`).

Nothing else changes — every tool flows through those four points.

## Contributing

Bug reports, feature requests, and PRs are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup and the four-point
checklist for adding upstream fields.

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
