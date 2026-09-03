#!/usr/bin/env bash
# deploy/setup.sh — one-time server setup for geo-mcp.kariem.dev
# Run as root on the VPS after cloning the repo to /opt/geolink-mcp
set -euo pipefail

REPO_DIR="/opt/geolink-mcp"
DOMAIN="geo-mcp.kariem.dev"

echo "==> Checking Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Checking docker compose..."
docker compose version || (
  curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
    -o /usr/local/bin/docker-compose && chmod +x /usr/local/bin/docker-compose
)

echo "==> Setting up repo at $REPO_DIR ..."
mkdir -p "$REPO_DIR"
cd "$REPO_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠️  Edit $REPO_DIR/.env and set GEOLINK_API_KEY, then re-run this script."
  exit 1
fi

echo "==> Building Docker image..."
docker compose build --no-cache

echo "==> Starting container..."
docker compose up -d

echo "==> Waiting for healthcheck..."
sleep 5
curl -sf http://127.0.0.1:3010/healthz && echo " ✅ Container healthy"

echo ""
echo "==> Next steps:"
echo "    1. Add DNS A record: $DOMAIN → this server IP"
echo "    2. Issue SSL cert via CyberPanel or: certbot certonly --nginx -d $DOMAIN"
echo "    3. Copy deploy/nginx.conf to /etc/nginx/conf.d/$DOMAIN.conf"
echo "    4. nginx -t && systemctl reload nginx"
echo "    5. Test: curl https://$DOMAIN/healthz"
echo ""
echo "MCP endpoint for Claude / Hvar:"
echo "  URL: https://$DOMAIN/mcp"
echo "  Method: POST (Streamable HTTP)"
