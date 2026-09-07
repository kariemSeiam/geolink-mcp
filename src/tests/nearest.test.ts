import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GeoLinkClient, TtlCache } from "../services/client.js";
import { registerRoutingTools } from "../tools/routing.js";

/**
 * Which of these is actually closest.
 *
 * The whole tool exists because the answer by road is a different answer, not
 * a rounder one: across eighteen measured origins the nearest place by road
 * was a different place than the nearest by line 22% of the time. The fixture
 * below is a real observation from that surface - three pharmacies at 503,
 * 1304 and 1983 metres by line, which by road rank 503, 1983, 1304. If this
 * tool ever ranks them 1, 2, 3 it has quietly gone back to using the map.
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

const base = {
  place_id: "p",
  address: "شارع",
  address_parts: { district: "الزمالك", governorate: "القاهرة", country: "EG" },
  category: "Pharmacy",
  type: "PHARMACY",
  rating: null,
  phone: "+20 2 000",
  website: null,
  photo: null,
  hours: null,
  timezone: "Africa/Cairo",
};

/** Real numbers: by line 503 < 1304 < 1983; by road 1601 < 2878 < 3572. */
const MEASURED = [
  { ...base, short_address: "Delmar & Attalla", location: { lat: 30.0654, lng: 31.2203 }, distance_m: 503,
    travel: { distance_m: 1601, distance_text: "1.6 km", duration_s: 396, duration_text: "7 min" } },
  { ...base, short_address: "El Esaaf", location: { lat: 30.0501, lng: 31.2301 }, distance_m: 1983,
    travel: { distance_m: 2878, distance_text: "2.9 km", duration_s: 518, duration_text: "9 min" } },
  { ...base, short_address: "El Dorry", location: { lat: 30.0496, lng: 31.2163 }, distance_m: 1304,
    travel: { distance_m: 3572, distance_text: "3.6 km", duration_s: 495, duration_text: "8 min" } },
];

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
      defaultLanguage: "en",
      defaultCountry: "eg",
      maxMatrixCells: 100,
    } as any,
    new TtlCache<unknown>(50, 60_000),
    new TtlCache<unknown>(50, 60_000),
  );
  registerRoutingTools(server, { client: geo, cfg: (geo as any).cfg });
  const client = new Client({ name: "test-client", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, calls: () => geo.calls };
}

const call = (client: Client, args: Record<string, unknown>): Promise<any> =>
  client.callTool({ name: "geolink_find_nearest", arguments: args });

const text = (res: any): string => res.content?.map((c: any) => c.text).join("\n") ?? "";

/* ------------------------------------------------------------------ */
/* The road, not the map                                               */
/* ------------------------------------------------------------------ */

test("the second nearest on the map is not the second nearest to drive to", async () => {
  stub(() => ({
    body: { success: true, data: MEASURED, total: 3, near: NEAR },
    headers: { "x-geolink-results-complete": "true" },
  }));
  const { client } = await harness();
  const res = await call(client, { origin: "الزمالك", search_query: "pharmacy", rank_by: "distance" });
  const order = res.structuredContent.results.map((r: any) => r.label);

  assert.deepEqual(order, ["Delmar & Attalla", "El Esaaf", "El Dorry"]);
  const byLine = [...MEASURED].sort((a, b) => a.distance_m - b.distance_m).map((p) => p.short_address);
  assert.deepEqual(byLine, ["Delmar & Attalla", "El Dorry", "El Esaaf"]);
  assert.notDeepEqual(order, byLine, "if these ever match, the road stopped mattering");
});

test("duration and distance are allowed to disagree", async () => {
  stub(() => ({ body: { success: true, data: MEASURED, total: 3, near: NEAR } }));
  const { client } = await harness();
  const byTime = await call(client, { origin: "الزمالك", search_query: "pharmacy", rank_by: "duration" });
  const byRoad = await call(client, { origin: "الزمالك", search_query: "pharmacy", rank_by: "distance" });

  // El Dorry is 3.6 km / 8 min; El Esaaf is 2.9 km / 9 min. Nearer by road,
  // slower to reach. Collapsing the two would have to pick one and be wrong.
  assert.equal(byTime.structuredContent.results[1].label, "El Dorry");
  assert.equal(byRoad.structuredContent.results[1].label, "El Esaaf");
});

test("the straight line is reported beside the road, never instead of it", async () => {
  stub(() => ({ body: { success: true, data: MEASURED, total: 3, near: NEAR } }));
  const { client } = await harness();
  const res = await call(client, { origin: "الزمالك", search_query: "pharmacy" });
  const first = res.structuredContent.results[0];

  assert.equal(first.straight_line_km, 0.503, "the line, in km");
  assert.equal(first.distance_meters, 1601, "the road, in metres");
  assert.match(text(res), /3\.2x the straight line/);
});

test("a place with no route is not ranked as if it were nearest", async () => {
  // Zero metres would sort to the top and win. It means "no route", not "here".
  stub(() => ({
    body: {
      success: true,
      data: [
        { ...base, short_address: "no route", location: { lat: 30.07, lng: 31.23 }, distance_m: 200 },
        ...MEASURED,
      ],
      total: 4,
      near: NEAR,
    },
  }));
  const { client } = await harness();
  const res = await call(client, { origin: "الزمالك", search_query: "pharmacy" });
  const labels = res.structuredContent.results.map((r: any) => r.label);

  assert.ok(!labels.includes("no route"));
  assert.equal(res.structuredContent.results[0].label, "Delmar & Attalla");
});

/* ------------------------------------------------------------------ */
/* A winner from half the field                                        */
/* ------------------------------------------------------------------ */

test("a shortlist that was cut short says so", async () => {
  stub(() => ({
    body: { success: true, data: MEASURED, total: 3, near: NEAR },
    headers: { "x-geolink-results-complete": "false" },
  }));
  const { client } = await harness();
  const res = await call(client, { origin: "الزمالك", search_query: "pharmacy", candidate_limit: 3 });

  assert.equal(res.structuredContent.results_complete, false);
  assert.match(text(res), /cut short/i);
  assert.match(text(res), /candidate_limit/);
});

test("a full shortlist does not cry wolf", async () => {
  stub(() => ({
    body: { success: true, data: MEASURED, total: 3, near: NEAR },
    headers: { "x-geolink-results-complete": "true" },
  }));
  const { client } = await harness();
  const res = await call(client, { origin: "الزمالك", search_query: "pharmacy" });

  assert.equal(res.structuredContent.results_complete, true);
  assert.doesNotMatch(text(res), /cut short/i);
});

/* ------------------------------------------------------------------ */
/* Getting there                                                       */
/* ------------------------------------------------------------------ */

test("search mode is one call, and the name goes over as a name", async () => {
  const sent = stub(() => ({ body: { success: true, data: MEASURED, total: 3, near: NEAR } }));
  const { client, calls } = await harness();
  await call(client, { origin: "أسوان", search_query: "pharmacy", candidate_limit: 12 });

  assert.equal(calls(), 1, "no geocode, no separate matrix: the API does all of it");
  const url = sent[0]!.url;
  assert.ok(url.pathname.includes("/api/x/nearest"), url.pathname);
  assert.equal(url.searchParams.get("near"), "أسوان");
  assert.equal(url.searchParams.get("candidates"), "12");
});

test("what the origin name resolved to comes back", async () => {
  stub(() => ({ body: { success: true, data: MEASURED, total: 3, near: NEAR } }));
  const { client } = await harness();
  const res = await call(client, { origin: "الزمالك", search_query: "pharmacy" });

  assert.equal(res.structuredContent.resolved_to.short_address, "الزمالك");
  assert.deepEqual(res.structuredContent.origin, {
    lat: 30.0609,
    lng: 31.2197,
    input: "الزمالك",
    label: "الزمالك",
    source: "geocode",
  });
});

test("giving both a list and a query is refused, not guessed at", async () => {
  stub(() => ({ body: { success: true, data: MEASURED, total: 3, near: NEAR } }));
  const { client } = await harness();
  const res = await call(client, {
    origin: "الزمالك",
    search_query: "pharmacy",
    candidates: [{ lat: 30.05, lng: 31.23 }],
  });

  assert.equal(res.isError, true);
  assert.match(text(res), /exactly one/i);
});

test("a known list of options still goes through the matrix", async () => {
  // x/nearest takes a query, not a list, so this mode cannot move to it. The
  // pairing care in that path is why it stays as it is.
  const sent = stub((url) =>
    url.pathname.includes("distance_matrix")
      ? {
          body: {
            success: true,
            data: {
              origins: [{ coordinates: [30.06, 31.22] }],
              destinations: [{ coordinates: [30.05, 31.23] }, { coordinates: [30.04, 31.24] }],
              distance_matrix: [[
                { distance_meters: 3000, distance_text: "3 km", duration_seconds: 600, duration_text: "10 min" },
                { distance_meters: 2000, distance_text: "2 km", duration_seconds: 400, duration_text: "7 min" },
              ]],
              nearest_destination_index: [1],
            },
          },
        }
      : { body: { success: true, data: { short_address: "الزمالك", address: "القاهرة",
          address_parts: { district: "", governorate: "", country: "eg" },
          location: { lat: 30.06, lng: 31.22 } } } },
  );
  const { client } = await harness();
  const res = await call(client, {
    origin: "الزمالك",
    candidates: [{ lat: 30.05, lng: 31.23 }, { lat: 30.04, lng: 31.24 }],
  });

  assert.equal(res.structuredContent.source, "candidates");
  assert.equal(res.structuredContent.results[0].distance_meters, 2000, "the faster one ranks first");
  assert.equal(res.structuredContent.results[0].is_geolink_nearest, true);
  assert.ok(sent.some((s) => s.url.pathname.includes("distance_matrix")));
  assert.ok(!sent.some((s) => s.url.pathname.includes("/api/x/nearest")));
});

test("search mode carries the whole place, not just a label", async () => {
  stub(() => ({ body: { success: true, data: MEASURED, total: 3, near: NEAR } }));
  const { client } = await harness();
  const res = await call(client, { origin: "الزمالك", search_query: "pharmacy" });
  const first = res.structuredContent.results[0];

  assert.equal(first.x_place.category, "Pharmacy");
  assert.equal(first.x_place.phone, "+20 2 000");
  assert.equal(first.x_place.name, "Delmar & Attalla");
});
