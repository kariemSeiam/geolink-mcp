#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
node scripts/mock-geolink.mjs 2>/dev/null & MOCK=$!
sleep 0.4
GEOLINK_API_KEY=test-key GEOLINK_BASE_URL=http://127.0.0.1:4545 TRANSPORT=http PORT=3111 node dist/index.js 2>/dev/null & SRV=$!
sleep 0.8
echo "--- healthz:"; curl -s localhost:3111/healthz; echo
echo "--- initialize over streamable HTTP:"
curl -s -X POST localhost:3111/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['serverInfo'], '| instructions:', len(d['result'].get('instructions','')), 'chars')"
echo "--- tools/call geocode over HTTP:"
curl -s -X POST localhost:3111/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"geolink_geocode","arguments":{"query":"Cairo Tower"}}}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['content'][0]['text'])"
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
echo "--- no key at startup:"; node dist/index.js 2>&1 | head -1
echo "--- --help:"; node dist/index.js --help | head -2
echo "--- --version:"; node dist/index.js --version
kill $MOCK 2>/dev/null
