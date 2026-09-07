import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodePolyline,
  encodePolyline,
  haversineKm,
  parseLatLng,
  samplePoints,
} from "../services/geo.js";
import { normalizeBounds, normalizeMatrix, normalizePlace } from "../services/normalize.js";
import type { Place } from "../types.js";

const TAHRIR = { lat: 30.0444, lng: 31.2357 };
const CAIRO_TOWER = { lat: 30.0459, lng: 31.2243 };

test("haversine: Tahrir → Cairo Tower is about 1.1 km", () => {
  const d = haversineKm(TAHRIR, CAIRO_TOWER);
  assert.ok(d > 1.0 && d < 1.3, `got ${d}`);
});

test("parseLatLng accepts common formats and rejects garbage", () => {
  assert.deepEqual(parseLatLng("30.0444,31.2357"), TAHRIR);
  assert.deepEqual(parseLatLng(" 30.0444 , 31.2357 "), TAHRIR);
  assert.deepEqual(parseLatLng("(30.0444, 31.2357)"), TAHRIR);
  assert.deepEqual(parseLatLng("30.0444;31.2357"), TAHRIR);
  assert.equal(parseLatLng("Cairo Tower"), null);
  assert.equal(parseLatLng("95,31"), null);
  assert.equal(parseLatLng("30"), null);
});

test("polyline encode/decode round-trips at 1e-5 precision", () => {
  const path: [number, number][] = [
    [30.0440343, 31.2356293],
    [30.0440281, 31.2357117],
    [30.0490461, 31.2390348],
    [-33.8688, 151.2093],
  ];
  const enc = encodePolyline(path);
  assert.ok(enc.length > 0 && enc.length < 60);
  const dec = decodePolyline(enc);
  assert.equal(dec.length, path.length);
  dec.forEach(([lat, lng], i) => {
    assert.ok(Math.abs(lat - (path[i]?.[0] ?? 0)) < 1e-5);
    assert.ok(Math.abs(lng - (path[i]?.[1] ?? 0)) < 1e-5);
  });
});

test("polyline matches Google's reference example", () => {
  // From the Google Encoded Polyline docs.
  const enc = encodePolyline([
    [38.5, -120.2],
    [40.7, -120.95],
    [43.252, -126.453],
  ]);
  assert.equal(enc, "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
});

test("samplePoints keeps endpoints and respects max", () => {
  const pts = Array.from({ length: 1000 }, (_, i) => i);
  const s = samplePoints(pts, 50);
  assert.equal(s.length, 50);
  assert.equal(s[0], 0);
  assert.equal(s[s.length - 1], 999);
  assert.deepEqual(samplePoints([1, 2, 3], 10), [1, 2, 3]);
});

function mk(name: string, lat: number, lng: number, district = "Zamalek"): Place {
  return {
    name,
    address: `${name}, ${district}, Cairo`,
    address_parts: { district, governorate: "Cairo", country: "EG" },
    location: { lat, lng },
  };
}

test("normalizeBounds repairs swapped corners", () => {
  const nb = normalizeBounds({
    northeast: { lat: 30.0440281, lng: 31.2355882 },
    southwest: { lat: 30.049344, lng: 31.2390348 },
  });
  assert.ok(nb);
  assert.ok(nb.northeast.lat >= nb.southwest.lat);
  assert.ok(nb.northeast.lng >= nb.southwest.lng);
});

test("normalizePlace fills defaults and upper-cases country", () => {
  const p = normalizePlace({ short_address: "X", location: { lat: "30.1", lng: "31.2" }, address_parts: { country: "eg" } });
  assert.equal(p.name, "X");
  assert.equal(p.address, "");
  assert.equal(p.address_parts.country, "EG");
  assert.deepEqual(p.location, { lat: 30.1, lng: 31.2 });
  assert.equal(p.bounds, undefined);
});

test("normalizeMatrix derives nearest index when upstream omits it", () => {
  const m = normalizeMatrix(
    {
      distance_matrix: [
        [
          { duration_seconds: 300, distance_meters: 1000 },
          { duration_seconds: 120, distance_meters: 2000 },
        ],
      ],
    },
    [TAHRIR],
    [CAIRO_TOWER, TAHRIR],
  );
  assert.deepEqual(m.nearest_destination_index, [1]);
  assert.equal(m.matrix[0]?.[1]?.duration_text, "");
});
