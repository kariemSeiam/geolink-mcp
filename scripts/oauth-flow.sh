#!/usr/bin/env bash
# Walk the whole authorization flow against a real server on a mock upstream.
set -u
cd "$(dirname "$0")/.."
node scripts/mock-geolink.mjs 2>/dev/null & MOCK=$!
sleep 0.5
GEOLINK_BASE_URL=http://127.0.0.1:4545 TRANSPORT=http PORT=3131 node dist/index.js 2>/dev/null & SRV=$!
sleep 1.5
node scripts/oauth-flow.mjs
EC=$?
kill $SRV $MOCK 2>/dev/null
exit $EC
