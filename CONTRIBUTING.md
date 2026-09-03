# Contributing

## Setup

```bash
git clone https://github.com/kariemSeiam/geolink-mcp
cd geolink-mcp
npm install
cp .env.example .env   # fill in GEOLINK_API_KEY
npm run dev             # tsx watch, stdio
```

## Before opening a PR

```bash
npm run build      # tsc type-check, must be clean
npm test            # unit tests (grid math, polyline decode, dedup, normalizers)
npm run test:e2e    # real MCP client <-> server <-> mock GeoLink, no network needed
npm run smoke        # HTTP transport, auth-failure path, CLI flags
```

All four must pass locally — CI runs the same four on Node 18/20/22 plus a Docker build.

## Adding a field from upstream GeoLink

GeoLink occasionally adds fields (website, phone, category, rating) or raises
per-query result caps. There are exactly four places to touch — see
[`README.md#extending`](README.md#extending):

1. `src/types.ts` — raw field on `RawPlace`, clean field on `Place`.
2. `src/services/normalize.ts` — map it in `normalizePlace` with a safe default.
3. `src/services/schemas.ts` — add to `PlaceSchema`; add to the `fields` enum
   in `src/tools/sweep.ts` if it should be trimmable.
4. `src/services/format.ts` — render it in `placeMarkdown`.

Nothing else changes. Every tool flows through those four points.

## Adding a new tool

- Register it in the matching file under `src/tools/` (or a new file, wired
  in `src/index.ts`).
- Give it a Zod input schema and an explicit `outputSchema` — `structuredContent`
  must validate.
- Errors go through the shared envelope: `Error (<kind>): <what> — Next step: <fix>`.
  Kinds: `auth`, `quota`, `not_found`, `bad_request`, `timeout`, `network`, `upstream`.
- Token budget matters — cap list output, make heavy fields (geometry, raw
  waypoints) opt-in, respect the ~25,000-char list ceiling with an explicit
  truncation message.
- If the tool costs more than 1 upstream call, say so in the description and
  offer (or require) a `dry_run` for anything that can fan out.

## Code style

- TypeScript strict mode, ESM (`type: module`).
- No `any` without a comment explaining why.
- Prefer pure functions in `src/services/` — testable without a live server.

## Reporting bugs / requesting features

Use the issue templates. For anything security-related, see
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`), imperative
mood, under ~72 chars for the subject line. No emojis.
