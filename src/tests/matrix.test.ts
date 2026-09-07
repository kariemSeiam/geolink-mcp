import { test } from "node:test";
import assert from "node:assert/strict";

import { GeoLinkClient } from "../services/client.js";

/**
 * A matrix too large for the API's time budget returns a normal 200 with the
 * cells it reached and the rest as zeros. On the wire a cell is four numbers
 * and nothing else, so one that was never measured is character for character
 * identical to two points with no distance between them.
 *
 * The only thing that tells them apart arrives in headers, which this client
 * used to discard on the way out of `attempt()`. These check that the
 * distinction survives the trip.
 */

function stub(body: unknown, headers: Record<string, string>) {
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ success: true, data: body }), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
}

function client() {
  return new GeoLinkClient({
    baseUrl: "https://example.invalid",
    apiKey: "k",
    timeoutMs: 500,
    maxRetries: 0,
  } as any);
}

const ORIGINS = [{ lat: 30.0, lng: 31.0 }];
const DESTS = [
  { lat: 30.1, lng: 31.1 },
  { lat: 30.2, lng: 31.2 },
];

/** One measured cell and one that was never reached — both zeros on the wire. */
const GRID = {
  origins: ORIGINS.map((p) => ({ coordinates: [p.lat, p.lng] })),
  destinations: DESTS.map((p) => ({ coordinates: [p.lat, p.lng] })),
  distance_matrix: [[
    { distance_meters: 4200, distance_text: "4.2 km", duration_seconds: 500, duration_text: "8 min" },
    { distance_meters: 0, distance_text: "", duration_seconds: 0, duration_text: "" },
  ]],
  nearest_destination_index: [0],
};

test("a partly measured grid says so", async () => {
  stub(GRID, {
    "x-geolink-matrix-requested": "2",
    "x-geolink-matrix-attempted": "1",
    "x-geolink-matrix-measured": "1",
    "x-geolink-matrix-complete": "false",
  });
  const result = await client().distanceMatrix(ORIGINS, DESTS, "en", "eg");
  assert.deepEqual(result.coverage, {
    requested: 2,
    attempted: 1,
    measured: 1,
    complete: false,
  });
});

test("a complete grid says that too, rather than staying silent", async () => {
  stub(GRID, {
    "x-geolink-matrix-requested": "2",
    "x-geolink-matrix-attempted": "2",
    "x-geolink-matrix-measured": "2",
    "x-geolink-matrix-complete": "true",
  });
  const result = await client().distanceMatrix(ORIGINS, DESTS, "en", "eg");
  assert.equal(result.coverage?.complete, true);
  assert.equal(result.coverage?.measured, 2);
});

test("an older API that sends no headers leaves coverage absent, not wrong", async () => {
  // Absent means "we were not told", which is honest. A default of
  // complete: true would be a claim nobody made.
  stub(GRID, {});
  const result = await client().distanceMatrix(ORIGINS, DESTS, "en", "eg");
  assert.equal(result.coverage, undefined);
});

test("the grid itself is unchanged either way", async () => {
  stub(GRID, { "x-geolink-matrix-requested": "2", "x-geolink-matrix-complete": "false" });
  const result = await client().distanceMatrix(ORIGINS, DESTS, "en", "eg");
  assert.equal(result.matrix[0]?.[0]?.distance_meters, 4200);
  assert.equal(result.matrix[0]?.[1]?.distance_meters, 0);
  assert.equal(result.origins.length, 1);
  assert.equal(result.destinations.length, 2);
});

test("a malformed header is ignored rather than believed", async () => {
  stub(GRID, {
    "x-geolink-matrix-requested": "not-a-number",
    "x-geolink-matrix-complete": "false",
  });
  const result = await client().distanceMatrix(ORIGINS, DESTS, "en", "eg");
  assert.equal(result.coverage, undefined);
});

test("missing sub-counts fall back to the requested count", async () => {
  stub(GRID, { "x-geolink-matrix-requested": "2", "x-geolink-matrix-complete": "true" });
  const result = await client().distanceMatrix(ORIGINS, DESTS, "en", "eg");
  assert.equal(result.coverage?.attempted, 2);
  assert.equal(result.coverage?.measured, 2);
});
