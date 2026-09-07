import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GeoLinkClient, TtlCache } from "../services/client.js";
import { registerSweepTool } from "../tools/sweep.js";

/**
 * The sweep tool, driven the way a model drives it.
 *
 * These go through a real MCP server and a real client rather than calling the
 * handler directly, because half of what this tool promises lives in the parts
 * a direct call skips: the input schema that turns `{place: "Giza"}` into
 * something the API can be asked, and the output schema that has to accept
 * what comes back. A test that reaches past both proves the middle of the
 * function and nothing about the tool.
 *
 * Every upstream response here is a stub, so what is being checked is the
 * translation: what went out on the wire for a given question, and what a
 * model is told about the answer.
 */

type Sent = { url: URL };

function stubUpstream(responder: (url: URL) => { body: unknown; headers?: Record<string, string> }) {
  const sent: Sent[] = [];
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
  place_id: "p1",
  short_address: "صيدلية عصام",
  address: "19 شارع المنصور محمد، الزمالك",
  address_parts: { district: "الزمالك", governorate: "محافظة القاهرة", country: "EG" },
  location: { lat: 30.0631, lng: 31.2183 },
  category: "صيدلية",
  type: "PHARMACY",
  rating: { value: 4.4, count: 17 },
  phone: "+20 2 27350193",
  website: null,
  photo: null,
  hours: { open_now: true, status: "مفتوح على مدار الساعة" },
  timezone: "Africa/Cairo",
  distance_m: 279,
};

const places = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => ({ ...PLACE, place_id: `p${i}`, short_address: `صيدلية ${i}` }));

/** A server with the sweep tool on it, and a client already talking to it. */
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
    // Fresh caches per harness: a hit left over from another test would make
    // the assertion about what went on the wire depend on test order.
    new TtlCache<unknown>(50, 60_000),
    new TtlCache<unknown>(50, 60_000),
  );
  registerSweepTool(server, { client: geo, cfg: (geo as any).cfg });
  const client = new Client({ name: "test-client", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, calls: () => geo.calls };
}

const call = async (client: Client, args: Record<string, unknown>): Promise<any> => {
  const res = await client.callTool({ name: "geolink_sweep_area", arguments: args });
  return res;
};

const text = (res: any): string => res.content?.map((c: any) => c.text).join("\n") ?? "";

/* ------------------------------------------------------------------ */
/* Saying where                                                        */
/* ------------------------------------------------------------------ */

test("a name on its own is not an area", async () => {
  // {place: "Giza"} used to geocode the name and sweep its "viewport". The
  // bounds a geocode returns are the point plus a fixed 0.001 degrees - Giza,
  // Cairo and Nasr City all come back as the same 190 x 220 metre box - so that
  // mode swept a city block while claiming to sweep a governorate. It is gone,
  // and the schema refuses it rather than quietly picking a radius.
  stubUpstream(() => ({ body: { success: true, data: places(1), total: 1 } }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", area: { place: "الجيزة" } });
  assert.equal(res.isError, true);
});

test("a named centre goes over as a name, not as coordinates we guessed", async () => {
  const sent = stubUpstream(() => ({ body: { success: true, data: places(2), total: 2 } }));
  const { client, calls } = await harness();
  await call(client, { query: "صيدلية", area: { center: "الزمالك", radius_km: 5 } });

  assert.equal(calls(), 1, "no separate geocode: the API resolves the name itself");
  const url = sent[0]!.url;
  assert.equal(url.searchParams.get("near"), "الزمالك");
  assert.equal(url.searchParams.get("radius_km"), "5");
  assert.equal(url.searchParams.get("latitude"), null);
});

test("coordinates go over as coordinates", async () => {
  const sent = stubUpstream(() => ({ body: { success: true, data: places(2), total: 2 } }));
  const { client } = await harness();
  await call(client, { query: "صيدلية", area: { center: { lat: 30.06, lng: 31.22 }, radius_km: 5 } });

  const url = sent[0]!.url;
  assert.equal(url.searchParams.get("latitude"), "30.06");
  assert.equal(url.searchParams.get("near"), null);
});

test("a box with its corners swapped is repaired, not refused", async () => {
  const sent = stubUpstream(() => ({ body: { success: true, data: places(1), total: 1 } }));
  const { client } = await harness();
  await call(client, {
    query: "صيدلية",
    area: { bounds: { northeast: { lat: 29.8, lng: 31.0 }, southwest: { lat: 30.2, lng: 31.4 } } },
  });
  // south,west,north,east — south below north, whatever the caller called them.
  assert.equal(sent[0]!.url.searchParams.get("bounds"), "29.800000,31.000000,30.200000,31.400000");
});

test("the engine's own defaults are left alone", async () => {
  // Spacing and depth are measured values that live in the engine. Restating
  // them here would mean this file drifts from them the first time they move.
  const sent = stubUpstream(() => ({ body: { success: true, data: places(1), total: 1 } }));
  const { client } = await harness();
  await call(client, { query: "صيدلية", area: { center: "الزمالك", radius_km: 5 } });

  const url = sent[0]!.url;
  assert.equal(url.searchParams.get("spacing_km"), null);
  assert.equal(url.searchParams.get("pages_per_point"), null);
});

/* ------------------------------------------------------------------ */
/* Two different ways to be short of the whole truth                   */
/* ------------------------------------------------------------------ */

test("a floor is not reported as a total", async () => {
  stubUpstream(() => ({
    body: { success: true, data: places(100), total: 100 },
    headers: { "x-geolink-results-complete": "false" },
  }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", area: { center: "الزمالك", radius_km: 10 } });

  assert.equal(res.structuredContent.results_complete, false);
  assert.match(text(res), /floor/i);
  assert.match(text(res), /pages_per_point/);
});

test("unvisited ground and unread depth are told apart", async () => {
  // They are fixed by different parameters, so one message for both would send
  // a caller to the wrong one half the time.
  stubUpstream(() => ({
    body: { success: true, data: places(20), total: 20, next: "Y3Vyc29y" },
    headers: { "x-geolink-results-complete": "true" },
  }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", area: { center: "الزمالك", radius_km: 40 } });
  const s = res.structuredContent;

  assert.equal(s.area_fully_swept, false, "ground is left");
  assert.equal(s.continue_from, "Y3Vyc29y");
  assert.equal(s.results_complete, true, "but what it did visit was read to the end");
  assert.match(text(res), /continue_from/);
  assert.doesNotMatch(text(res), /pages_per_point/, "no advice to deepen: depth was not the problem");
});

test("a complete answer claims nothing it was not told", async () => {
  stubUpstream(() => ({ body: { success: true, data: places(5), total: 5 } }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", area: { center: "الزمالك", radius_km: 5 } });

  // No header: the API did not say, so neither do we. `true` would be a claim
  // nobody made, and it is the claim that stops a caller looking.
  assert.equal(res.structuredContent.results_complete, undefined);
  assert.doesNotMatch(text(res), /floor/i);
});

test("paging is more places, never more ground", async () => {
  stubUpstream(() => ({ body: { success: true, data: places(250), total: 250 } }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", area: { center: "الزمالك", radius_km: 10 }, limit: 100 });
  const s = res.structuredContent;

  assert.equal(s.has_more, true, "more places to show");
  assert.equal(s.next_offset, 100);
  assert.equal(s.area_fully_swept, true, "and no ground left to sweep");
  assert.equal(s.continue_from, undefined);
});

/* ------------------------------------------------------------------ */
/* Cost                                                                */
/* ------------------------------------------------------------------ */

test("paging a sweep does not sweep again", async () => {
  const sent = stubUpstream(() => ({ body: { success: true, data: places(250), total: 250 } }));
  const { client } = await harness();
  const area = { center: "الزمالك", radius_km: 10 };
  const first = await call(client, { query: "صيدلية", area, limit: 100, offset: 0 });
  const second = await call(client, { query: "صيدلية", area, limit: 100, offset: 100 });

  assert.equal(sent.length, 1, "the second page came from the first sweep");
  assert.equal(first.structuredContent.count, 100);
  assert.equal(second.structuredContent.offset, 100);
  assert.notEqual(
    first.structuredContent.places[0].name,
    second.structuredContent.places[0].name,
    "and it is a different page, not the same one served twice",
  );
});

test("a cached page keeps what the headers said", async () => {
  // The completeness flag arrives in a header and the places arrive in a body.
  // If they were held apart, page one would know it was a floor and page two
  // would quietly claim to be whole.
  stubUpstream(() => ({
    body: { success: true, data: places(250), total: 250 },
    headers: { "x-geolink-results-complete": "false" },
  }));
  const { client } = await harness();
  const area = { center: "الزمالك", radius_km: 10 };
  await call(client, { query: "صيدلية", area, limit: 100, offset: 0 });
  const second = await call(client, { query: "صيدلية", area, limit: 100, offset: 100 });

  assert.equal(second.structuredContent.results_complete, false);
  assert.match(text(second), /floor/i);
});

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

test("a summary is counts, and never lands in places", async () => {
  const sent = stubUpstream(() => ({
    body: {
      success: true,
      data: {
        places: 100,
        by_district: { الزمالك: 3, العجوزة: 9 },
        by_category: { صيدلية: 99 },
        rating: { mean: 4.14, rated: 88, unrated: 12 },
        with_phone: 94,
        with_website: 43,
        open_now: 95,
      },
    },
  }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", area: { center: "الزمالك", radius_km: 5 }, view: "summary" });
  const s = res.structuredContent;

  assert.equal(sent[0]!.url.searchParams.get("view"), "shape");
  assert.equal(s.places, undefined, "an object is not a list of places");
  assert.equal(s.total, 100);
  assert.equal(s.summary.by_district["العجوزة"], 9);
  assert.match(text(res), /العجوزة/);
});

test("a dry run prices the work and searches nothing", async () => {
  const sent = stubUpstream(() => ({
    body: {
      success: true,
      data: { requests_needed: 3, estimated_seconds: 6.4, fits_in_one_request: false },
      near: {
        short_address: "الزمالك",
        address: "محافظة القاهرة",
        address_parts: { district: "الزمالك", governorate: "القاهرة", country: "EG" },
        location: { lat: 30.06, lng: 31.22 },
      },
    },
  }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", area: { center: "الزمالك", radius_km: 40 }, dry_run: true });

  assert.equal(sent[0]!.url.searchParams.get("dry_run"), "true");
  assert.equal(res.structuredContent.plan.requests_needed, 3);
  assert.equal(res.structuredContent.resolved_to.short_address, "الزمالك");
  assert.equal(res.structuredContent.total, 0);
});

test("what a name resolved to comes back, because names collide", async () => {
  stubUpstream(() => ({
    body: {
      success: true,
      data: places(2),
      total: 2,
      near: {
        short_address: "مدينة نصر",
        address: "محافظة القاهرة",
        address_parts: { district: "مدينة نصر", governorate: "القاهرة", country: "EG" },
        location: { lat: 30.05, lng: 31.34 },
      },
    },
  }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", area: { center: "مدينة نصر", radius_km: 5 } });

  assert.equal(res.structuredContent.resolved_to.location.lat, 30.05);
  assert.deepEqual(res.structuredContent.distance_measured_from, { lat: 30.05, lng: 31.34 });
});

test("a place is presented in this server's vocabulary", async () => {
  // v1, v2 and x all call a place's name `short_address` on the wire, and every
  // tool here has always called it `name`. One word per thing, whichever tool
  // the model reached for.
  stubUpstream(() => ({ body: { success: true, data: places(1), total: 1 } }));
  const { client } = await harness();
  const res = await call(client, { query: "صيدلية", area: { center: "الزمالك", radius_km: 5 } });
  const p = res.structuredContent.places[0];

  assert.equal(p.name, "صيدلية 0");
  assert.equal(p.rating.count, 17, "a rating never travels without its count");
  assert.equal(p.website, null, "absent is null, and null means the place has none");
});

test("fields trims the place without inventing one", async () => {
  stubUpstream(() => ({ body: { success: true, data: places(1), total: 1 } }));
  const { client } = await harness();
  const res = await call(client, {
    query: "صيدلية",
    area: { center: "الزمالك", radius_km: 5 },
    fields: ["name", "location"],
    response_format: "json",
  });
  const p = res.structuredContent.places[0];

  assert.deepEqual(Object.keys(p).sort(), ["location", "name"]);
});
