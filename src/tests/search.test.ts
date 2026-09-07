import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GeoLinkClient, TtlCache } from "../services/client.js";
import { registerSearchTools } from "../tools/search.js";

/**
 * What a search tells a model, and what it refuses to tell it.
 *
 * The old version of this tool decided whether it had seen everything by
 * arithmetic: fewer places came back than were asked for, therefore the area
 * has no more. That is right most of the time and wrong in the case that
 * matters - a walk cut short by a throttle or an error also comes back short,
 * and was reported as "there are no more". These check that the guess is gone
 * and the engine's own answer is what travels.
 */

function stub(responder: (url: URL) => { body: unknown; headers?: Record<string, string> }) {
  const sent: { url: URL }[] = [];
  (globalThis as any).fetch = async (url: URL) => {
    sent.push({ url: new URL(url.toString()) });
    const { body, headers } = responder(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...(headers ?? {}) },
    });
  };
  return sent;
}

const PLACE = {
  place_id: "p",
  short_address: "صيدلية",
  address: "شارع، الزمالك",
  address_parts: { district: "الزمالك", governorate: "القاهرة", country: "EG" },
  location: { lat: 30.06, lng: 31.22 },
  category: "صيدلية",
  type: "PHARMACY",
  rating: { value: 4.4, count: 17 },
  phone: "+20 2 27350193",
  website: null,
  photo: null,
  hours: { open_now: true, today: "مفتوح ٢٤ ساعة" },
  timezone: "Africa/Cairo",
  distance_m: 500,
};

/** Deliberately out of distance order, so a sort has something to do. */
const places = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => ({
    ...PLACE,
    place_id: `p${i}`,
    short_address: `صيدلية ${i}`,
    distance_m: (n - i) * 100,
  }));

const NEAR = {
  short_address: "الزمالك",
  address: "محافظة القاهرة",
  address_parts: { district: "الزمالك", governorate: "القاهرة", country: "EG" },
  location: { lat: 30.0609, lng: 31.2197 },
};

async function harness(): Promise<{ client: Client; calls: () => number }> {
  const server = new McpServer({ name: "test", version: "0" }, { capabilities: { tools: {} } });
  const geo = new GeoLinkClient(
    {
      baseUrl: "https://example.invalid",
      apiKey: "caller-key",
      xKey: "x-secret",
      timeoutMs: 2000,
      maxRetries: 0,
      defaultLanguage: "ar",
      defaultCountry: "eg",
    } as any,
    new TtlCache<unknown>(50, 60_000),
    new TtlCache<unknown>(50, 60_000),
  );
  registerSearchTools(server, { client: geo, cfg: (geo as any).cfg });
  const client = new Client({ name: "test-client", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, calls: () => geo.calls };
}

const call = (client: Client, args: Record<string, unknown>): Promise<any> =>
  client.callTool({ name: "geolink_search_places", arguments: args });

const text = (res: any): string => res.content?.map((c: any) => c.text).join("\n") ?? "";

/* ------------------------------------------------------------------ */
/* Whether it saw everything                                           */
/* ------------------------------------------------------------------ */

test("a truncated search says the count is a floor", async () => {
  stub(() => ({
    body: { success: true, data: places(20), total: 20, near: NEAR },
    headers: { "x-geolink-results-complete": "false" },
  }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", near: "الزمالك", limit: 20 });

  assert.equal(res.structuredContent.results_complete, false);
  assert.match(text(res), /floor/i);
  assert.match(text(res), /limit=0/);
});

test("a drained search says so, and stops the model looking further", async () => {
  stub(() => ({
    body: { success: true, data: places(218), total: 218, near: NEAR },
    headers: { "x-geolink-results-complete": "true" },
  }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", near: "الزمالك", limit: 0 });

  assert.equal(res.structuredContent.results_complete, true);
  assert.equal(res.structuredContent.total, 218);
  assert.match(text(res), /no more/i);
  assert.doesNotMatch(text(res), /floor/i);
});

test("a short answer is not mistaken for a complete one", async () => {
  // The old rule was arithmetic: fewer came back than were asked for, so the
  // area must be out of them. A walk that was throttled halfway also comes
  // back short, and this is the case that rule got wrong.
  stub(() => ({
    body: { success: true, data: places(7), total: 7, near: NEAR },
    headers: { "x-geolink-results-complete": "false" },
  }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", near: "الزمالك", limit: 50 });

  assert.equal(res.structuredContent.total, 7, "seven came back where fifty were asked for");
  assert.equal(res.structuredContent.results_complete, false, "and that is not proof there are only seven");
  assert.match(text(res), /floor/i);
});

test("silence is not a claim of completeness", async () => {
  stub(() => ({ body: { success: true, data: places(5), total: 5, near: NEAR } }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", near: "الزمالك" });

  assert.equal(res.structuredContent.results_complete, undefined);
  assert.doesNotMatch(text(res), /no more/i);
});

/* ------------------------------------------------------------------ */
/* Where, and what a distance is from                                  */
/* ------------------------------------------------------------------ */

test("a place name is sent as a name, not geocoded here first", async () => {
  const sent = stub(() => ({ body: { success: true, data: places(2), total: 2, near: NEAR } }));
  const { client, calls } = await harness();
  await call(client, { query: "صيدلية", near: "أسوان" });

  assert.equal(calls(), 1, "one call: the API resolves the name itself");
  assert.equal(sent[0]!.url.searchParams.get("near"), "أسوان");
  assert.equal(sent[0]!.url.searchParams.get("latitude"), null);
});

test('coordinates written as a string are still coordinates', async () => {
  const sent = stub(() => ({ body: { success: true, data: places(2), total: 2 } }));
  const { client } = await harness();
  await call(client, { query: "صيدلية", near: "30.0444,31.2357" });

  assert.equal(sent[0]!.url.searchParams.get("latitude"), "30.0444");
  assert.equal(sent[0]!.url.searchParams.get("near"), null, "not sent as a place called \"30.0444,31.2357\"");
});

test("with no centre, no distances are reported at all", async () => {
  // The API measures from a default centre when none is given. Passing those
  // numbers on would be distances from a point the caller never chose, which
  // look exactly like distances from one they did.
  stub(() => ({ body: { success: true, data: places(3), total: 3 } }));
  const { client } = await harness();
  const res = await call(client, { query: "Carrefour" });

  assert.equal(res.structuredContent.distance_measured_from, undefined);
  for (const p of res.structuredContent.places) assert.equal(p.distance_m, null);
  assert.doesNotMatch(text(res), /km|\bm\b/);
});

test("with a centre, the point it was measured from is named", async () => {
  stub(() => ({ body: { success: true, data: places(3), total: 3, near: NEAR } }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", near: "الزمالك" });

  assert.deepEqual(res.structuredContent.distance_measured_from, { lat: 30.0609, lng: 31.2197 });
  assert.equal(res.structuredContent.resolved_to.short_address, "الزمالك");
});

/* ------------------------------------------------------------------ */
/* Order                                                               */
/* ------------------------------------------------------------------ */

test("distance order is the default, and it is the server's distance", async () => {
  stub(() => ({ body: { success: true, data: places(5), total: 5, near: NEAR } }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", near: "الزمالك" });
  const d = res.structuredContent.places.map((p: any) => p.distance_m);

  assert.deepEqual(d, [...d].sort((a, b) => a - b));
  assert.equal(d[0], 100);
});

test("relevance order survives when it is asked for", async () => {
  // The best match for a name is not the nearest thing of that kind, and the
  // source's own order is the only thing that knows which is which.
  stub(() => ({ body: { success: true, data: places(5), total: 5, near: NEAR } }));
  const { client } = await harness();
  const res = await call(client, { query: "برج القاهرة", near: "الزمالك", sort_by_distance: false });
  const d = res.structuredContent.places.map((p: any) => p.distance_m);

  assert.deepEqual(d, [500, 400, 300, 200, 100], "untouched, as it arrived");
});

/* ------------------------------------------------------------------ */
/* Cost and shape                                                      */
/* ------------------------------------------------------------------ */

test("paging a deep search does not search again", async () => {
  const sent = stub(() => ({
    body: { success: true, data: places(218), total: 218, near: NEAR },
    headers: { "x-geolink-results-complete": "true" },
  }));
  const { client } = await harness();
  const first = await call(client, { query: "صيدلية", near: "الزمالك", limit: 100, offset: 0 });
  const second = await call(client, { query: "صيدلية", near: "الزمالك", limit: 100, offset: 100 });

  assert.equal(sent.length, 1);
  assert.equal(first.structuredContent.has_more, true);
  assert.equal(second.structuredContent.offset, 100);
  assert.equal(second.structuredContent.results_complete, true, "and the header survived the cache");
});

test("limit=0 asks for all of them, not one page", async () => {
  stub(() => ({
    body: { success: true, data: places(40), total: 40, near: NEAR },
    headers: { "x-geolink-results-complete": "true" },
  }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", near: "الزمالك", limit: 0 });

  assert.equal(res.structuredContent.count, 40, "not trimmed to the default page");
  assert.equal(res.structuredContent.has_more, false);
});

test("a response trimmed to fit says there is more, because there is", async () => {
  // Two hundred and eighteen full places do not fit in one MCP response, so
  // some are dropped. Reporting has_more: false beside a list that was cut
  // short tells a caller they are holding everything when they hold half -
  // and unlike a truncated *string*, this one parses perfectly.
  stub(() => ({
    body: { success: true, data: places(218), total: 218, near: NEAR },
    headers: { "x-geolink-results-complete": "true" },
  }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", near: "الزمالك", limit: 0 });
  const s = res.structuredContent;

  assert.ok(s.count < 218, "it did not all fit");
  assert.equal(s.has_more, true);
  assert.equal(s.next_offset, s.count);
  assert.equal(s.total, 218, "and the true count is still reported");
});

test("a place arrives with everything the source had, and nulls where it had nothing", async () => {
  stub(() => ({ body: { success: true, data: places(1), total: 1, near: NEAR } }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", near: "الزمالك" });
  const p = res.structuredContent.places[0];

  assert.equal(p.name, "صيدلية 0", "short_address is presented as name, as in every other tool");
  assert.equal(p.rating.count, 17);
  assert.equal(p.phone, "+20 2 27350193");
  assert.equal(p.type, "PHARMACY");
  assert.equal(p.website, null);
  assert.equal(p.hours.open_now, true);
  assert.match(text(res), /open now|★/);
});
