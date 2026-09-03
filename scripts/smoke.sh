#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
node scripts/mock-geolink.mjs 2>/dev/null & MOCK=$!
sleep 0.4
GEOLINK_API_KEY=test-key GEOLINK_BASE_URL=http://127.0.0.1:4545 TRANSPORT=http PORT=3111 node dist/index.js 2>/dev/null & SRV=$!
sleep 0.8
echo "--- healthz:"; curl -s localhost:3111/healthz; echo
echo "--- initialize over streamable HTTP:"
# Keep the response headers: the session id has to ride along on every later
# request, otherwise the transport correctly refuses with "not initialized".
HDRS=$(mktemp)
curl -s -D "$HDRS" -X POST localhost:3111/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['serverInfo'], '| instructions:', len(d['result'].get('instructions','')), 'chars')"
SESSION=$(grep -i '^mcp-session-id:' "$HDRS" | tr -d '\r' | awk '{print $2}')
echo "--- session id issued: ${SESSION:-(none)}"
curl -s -o /dev/null -X POST localhost:3111/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "MCP-Session-Id: $SESSION" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
echo "--- tools/call geocode over HTTP:"
curl -s -X POST localhost:3111/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "MCP-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"geolink_geocode","arguments":{"query":"Cairo Tower"}}}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['content'][0]['text'].split(chr(10))[0])"
echo "--- session is tracked, then released on DELETE:"
curl -s localhost:3111/healthz | python3 -c "import sys,json; print('  sessions before delete:', json.load(sys.stdin)['sessions'])"
curl -s -o /dev/null -X DELETE localhost:3111/mcp -H "MCP-Session-Id: $SESSION"
curl -s localhost:3111/healthz | python3 -c "import sys,json; print('  sessions after delete: ', json.load(sys.stdin)['sessions'])"
echo "--- no oauth metadata is advertised (must be 404):"
curl -s -o /dev/null -w "  /.well-known/oauth-authorization-server -> %{http_code}\n" localhost:3111/.well-known/oauth-authorization-server
kill $SRV 2>/dev/null
echo "--- wrong key:"
cat > /tmp/wrongkey.mjs << 'JS'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "t", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, GEOLINK_API_KEY: "wrong", GEOLINK_BASE_URL: "http://127.0.0.1:4545" }, stderr: "pipe" }));
const r = await c.callTool({ name: "geolink_geocode", arguments: { query: "x" } });
console.log(r.isError, "|", r.content[0].text.replace(/\n/g, " / "));
await c.close();
JS
cp /tmp/wrongkey.mjs scripts/_wrongkey.mjs && node scripts/_wrongkey.mjs; rm -f scripts/_wrongkey.mjs
echo "--- no key at startup (should fail fast with a clear message):"; node dist/index.js 2>&1 | head -1
echo "--- --help:"; node dist/index.js --help | head -2
echo "--- --version:"; node dist/index.js --version
kill $MOCK 2>/dev/null
