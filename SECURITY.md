# Security Policy

## Supported versions

Only the latest published version on npm / `main` branch receives security fixes.

## Reporting a vulnerability

Do **not** open a public GitHub issue for security reports.

Instead, use [GitHub Security Advisories](https://github.com/kariemSeiam/geolink-mcp-server/security/advisories/new)
for this repository, or email the maintainer directly (see the GitHub profile
[@kariemSeiam](https://github.com/kariemSeiam)).

Include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal tool call / config is enough).
- The version / commit affected.

You should receive an acknowledgement within a few days. We'll coordinate a
fix and disclosure timeline with you before any public writeup.

## Scope notes

- This server is a **read-only** proxy over the GeoLink API — it has no
  write/delete tools and holds no user data beyond the in-process 10-minute
  geocode cache.
- The only secret involved is `GEOLINK_API_KEY`. The server never logs it,
  never echoes it in tool output, and it is not sent to any endpoint other
  than GeoLink itself.
- `TRANSPORT=http` binds to `127.0.0.1` by default. Setting `HOST=0.0.0.0`
  without a reverse proxy in front that handles auth and `Origin` header
  validation is a misconfiguration, not a server vulnerability — but please
  report it anyway if you find a way to bypass intended isolation.
- OAuth discovery endpoints (`/.well-known/oauth-authorization-server`) are
  metadata-only stubs required for Claude.ai remote MCP discovery; the server
  itself does not implement an OAuth flow.
