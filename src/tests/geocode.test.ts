import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GeoLinkClient, TtlCache } from "../services/client.js";
import { registerGeocodingTools } from "../tools/geocoding.js";

/**
 * A geocode answers "where is this point", and nothing more.
 *
 * It used to answer with a viewport too, and this tool used to check that the
 * point fell inside it — a fallback to a larger place being the thing the check
 * was for. The check could not fail. The box was the point plus a fixed 0.001
 * degrees, so the point sat at its exact centre every time, and
 * `location_within_bounds: true` shipped on every response ever returned.
 *
 * The API marks that box `synthetic` now and the client drops it, so these
 * assert the absence rather than a caveat: a field that means nothing is not
 * improved by a warning printed next to it.
 */

function stub(body: unknown, headers: Record<string, string> = {}) {
  const sent: { url: URL }[] = [];
  (globalThis as any).fetch = async (url: URL) => {
    sent.push({ url: new URL(url.toString()) });
    return new Response(JSON.stringify({ success: true, data: body }), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  return sent;
}

const PLACE = {
  short_address: "الجيزة",
  address: "قسم العمرانية، محافظة الجيزة",
  address_parts: { district: "قسم الجيزة", governorate: "محافظة القاهرة", country: "eg" },
  location: { lat: 30.0130557, lng: 31.2088526 },
  bounds: {
    northeast: { lat: 30.0140557, lng: 31.2098526 },
    southwest: { lat: 30.0120557, lng: 31.2078526 },
  },
};

async function harness(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0" }, { capabilities: { tools: {} } });
  const geo = new GeoLinkClient(
    { baseUrl: "https://example.invalid", apiKey: "k", xKey: "x", timeoutMs: 2000,
      maxRetries: 0, defaultLanguage: "ar", defaultCountry: "eg" } as any,
    new TtlCache<unknown>(50, 60_000),
    new TtlCache<unknown>(50, 60_000),
  );
  registerGeocodingTools(server, { client: geo, cfg: (geo as any).cfg });
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

const call = (c: Client, args: Record<string, unknown>): Promise<any> =>
  c.callTool({ name: "geolink_geocode", arguments: args });

test("a box the API calls synthetic never reaches the model", async () => {
  stub(PLACE, { "x-geolink-bounds": "synthetic" });
  const res = await call(await harness(), { query: "الجيزة" });
  const s = res.structuredContent;

  assert.equal(s.bounds, undefined, "the 220-metre constant is dropped, not explained");
  assert.deepEqual(s.location, { lat: 30.0130557, lng: 31.2088526 }, "the point survives");
  assert.equal(s.name, "الجيزة");
});

test("the check that could not fail is gone with it", async () => {
  stub(PLACE, { "x-geolink-bounds": "synthetic" });
  const res = await call(await harness(), { query: "الجيزة" });

  assert.equal(res.structuredContent.location_within_bounds, undefined);
  assert.equal(res.structuredContent.warning, undefined);
});

test("a box that is NOT marked synthetic is passed through", async () => {
  // The header names a kind rather than being a boolean, so the day a measured
  // extent arrives it should travel. Nothing here assumes it never will.
  stub(PLACE);
  const res = await call(await harness(), { query: "الجيزة" });

  assert.ok(res.structuredContent.bounds, "an unmarked box is not ours to discard");
  assert.equal(res.structuredContent.bounds.northeast.lat, 30.0140557);
});

test("a cached geocode drops the box too, not just the first one", async () => {
  // The header is read where the body is cached. Read it at the call site and
  // the first response would lose the box while every later one kept it.
  const sent = stub(PLACE, { "x-geolink-bounds": "synthetic" });
  const c = await harness();
  await call(c, { query: "الجيزة" });
  const second = await call(c, { query: "الجيزة" });

  assert.equal(sent.length, 1, "served from cache");
  assert.equal(second.structuredContent.bounds, undefined);
});
