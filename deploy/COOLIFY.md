# Deploying on Coolify, alongside geolink-eg

`geolink-eg`'s own deploy has no committed proxy config — no `nginx.conf`, no
Traefik labels anywhere in that repo. That means Coolify's *built-in* proxy
(Traefik) is what terminates `dev.geolink-eg.com` and `geolink-eg.com` today,
not a custom nginx layer this repo could plug into. [`geolink-mcp.conf`](geolink-mcp.conf)
in this directory is the nginx form for anyone who *does* run one; what
follows is for the setup this project actually has.

## The shape

Two separate Coolify **Applications**, same as `geolink-eg` today — one
tracking `dev`, one tracking `main`, each its own build and its own domain.
`geolink-mcp` becomes a **second application per environment**, sharing the
same domain as the Flask app but answering only on the paths it owns:

```
dev.geolink-eg.com   → geolink-eg (dev)     — everything except the paths below
dev.geolink-eg.com   → geolink-mcp (dev)    — /mcp, /mcp/*, /.well-known/oauth-*

geolink-eg.com       → geolink-eg (main)    — everything except the paths below
geolink-eg.com       → geolink-mcp (main)   — /mcp, /mcp/*, /.well-known/oauth-*
```

Four applications total, deployed exactly the way `geolink-eg` already is:
push to the tracked branch, Coolify builds the Dockerfile, redeploys. Nothing
about that workflow changes — `geolink-mcp` just joins it.

## Steps, per environment (repeat once for dev, once for main)

**1. New Application → Public Repository (or Deploy Key) → this repo**
(`github.com/kariemSeiam/geolink-mcp`), branch `main` for now — this project
has one branch. Build Pack: **Dockerfile** (already in the repo root).

**2. Environment variables** on the application:

| Variable | dev | main |
|---|---|---|
| `TRANSPORT` | `http` | `http` |
| `PORT` | `3010` | `3010` |
| `HOST` | `0.0.0.0` | `0.0.0.0` |
| `GEOLINK_BASE_URL` | `https://dev.geolink-eg.com` | `https://geolink-eg.com` |
| `GEOLINK_PUBLIC_URL` | `https://dev.geolink-eg.com` | `https://geolink-eg.com` |
| `GEOLINK_MCP_PATH` | `/mcp` | `/mcp` |

`GEOLINK_API_KEY` is **deliberately absent**. Over HTTP every connection
brings its own key through the authorization flow — setting this env var
would give the whole deployment one shared upstream identity, which is
exactly what per-user auth exists to avoid.

**3. Domain.** This is the one step to verify rather than assume, because
Coolify's UI can change: the field usually accepts a full URL including a
path, e.g. `https://dev.geolink-eg.com/mcp`, and generates the matching
Traefik `PathPrefix` rule for you. Try comma-separating the four paths this
server owns in that field:

```
https://dev.geolink-eg.com/mcp,https://dev.geolink-eg.com/.well-known/oauth-protected-resource,https://dev.geolink-eg.com/.well-known/oauth-authorization-server
```

If the UI only accepts one path per app, or the well-known paths don't
route, fall back to step 4.

**4. Fallback: custom Traefik labels.** Every Coolify application has an
"Advanced" section for labels that layer on top of anything the domain field
generated. Paste (adjust the router name per environment so dev and main
don't collide, and swap the host per environment):

```yaml
traefik.enable=true
traefik.http.routers.geolink-mcp-dev.rule=Host(`dev.geolink-eg.com`) && (PathPrefix(`/mcp`) || PathPrefix(`/.well-known/oauth-protected-resource`) || Path(`/.well-known/oauth-authorization-server`))
traefik.http.routers.geolink-mcp-dev.entrypoints=https
traefik.http.routers.geolink-mcp-dev.tls=true
traefik.http.services.geolink-mcp-dev.loadbalancer.server.port=3010
```

This is the same routing `deploy/geolink-mcp.conf`'s nginx `location` blocks
express — same four paths, same reasoning (`/register` stays with the Flask
app; the well-known documents have to sit at the root because the RFCs put
them there). If both this and the domain field are active, the more specific
rule should win; remove whichever one didn't take effect once you've confirmed
routing with step 6.

**5. Health check** — `GET /healthz`, already wired into the Dockerfile's
`HEALTHCHECK` and matched by Coolify's own probe if you enable it.

**6. Verify**, against each host after deploy:

```bash
curl -s https://dev.geolink-eg.com/.well-known/oauth-protected-resource/mcp
curl -s https://dev.geolink-eg.com/register   # must still be the Flask sign-up page
curl -si -X POST https://dev.geolink-eg.com/mcp -d '{}' | grep -i www-authenticate
```

The first must report `"resource": "https://dev.geolink-eg.com/mcp"` — not
`127.0.0.1`, not the container's internal hostname. If it does, the forwarded
headers Traefik normally adds aren't reaching the container; set
`GEOLINK_PUBLIC_URL` (already in the table above) and it stops depending on
them. The second confirms the merge didn't swallow the site's own route. The
third proves the whole chain: proxy → container → challenge → back out.

## What I could not do from here

No Coolify CLI, API token, or SSH access exists in this environment — checked,
not assumed: no `coolify` binary, no `COOLIFY_*` environment variable, no host
in `~/.ssh/config` matching either domain. Everything above is exact steps for
the dashboard, not something run on your behalf. The repo side is done and
proven: the Dockerfile builds clean, and the resulting image was run as an
actual container against a mocked upstream — the metadata came back naming
`https://geolink-eg.com` throughout, from `GEOLINK_PUBLIC_URL` alone, with
nothing internal leaking into it.
