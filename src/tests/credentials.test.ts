import { test } from "node:test";
import assert from "node:assert/strict";

import { GeoLinkClient } from "../services/client.js";

/**
 * Two surfaces, two credentials, and the caller only ever holds one.
 *
 * v1 and v2 authenticate the caller and bill them, so those carry the caller's
 * own GEOLINK_API_KEY. x has no billing and no usage log, so there is nothing
 * to attribute and no per-caller key to hold — it carries its own. A caller
 * proves who they are on the billed tools, and that is what earns them the
 * newer surface without being asked for a second credential they could not
 * obtain.
 *
 * Getting this backwards fails in two directions, and both look like something
 * else: the caller's key on x reads as "not found" because x refuses anything
 * but its own secret, and x's key on v2 reads as an invalid key. Neither says
 * "you sent the wrong credential".
 */

const CALLER_KEY = "caller-own-key";
const X_KEY = "the-x-secret";

function spy() {
  const seen: { url?: URL }[] = [];
  (globalThis as any).fetch = async (url: URL) => {
    seen.push({ url: new URL(url.toString()) });
    return new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return seen;
}

function client() {
  return new GeoLinkClient({
    baseUrl: "https://example.invalid",
    apiKey: CALLER_KEY,
    xKey: X_KEY,
    timeoutMs: 500,
    maxRetries: 0,
  } as any);
}

test("the billed surfaces carry the caller's own key", async () => {
  const seen = spy();
  const c = client();
  await c.textSearch("x", { lat: 30, lng: 31 }, "en", "eg").catch(() => {});
  await c.distanceMatrix([{ lat: 30, lng: 31 }], [{ lat: 30, lng: 31 }], "en", "eg").catch(() => {});
  for (const { url } of seen) {
    assert.equal(url!.searchParams.get("key"), CALLER_KEY, url!.pathname);
  }
  assert.ok(seen.length >= 2);
});

test("the x surface carries its own, never the caller's", async () => {
  const seen = spy();
  const c = client();
  await c.xSearch({ query: "x", near: "cairo", language: "en", country: "eg" });
  await c.xSweep({ query: "x", near: "cairo", radiusKm: 5, language: "en", country: "eg" });
  await c.xNearest({ query: "x", near: "cairo", language: "en", country: "eg" });

  assert.equal(seen.length, 3);
  for (const { url } of seen) {
    assert.ok(url!.pathname.startsWith("/api/x/"), url!.pathname);
    assert.equal(url!.searchParams.get("key"), X_KEY, url!.pathname);
    assert.notEqual(url!.searchParams.get("key"), CALLER_KEY);
  }
});

test("a caller never has to supply the second credential", async () => {
  // No xKey configured: the default in constants stands in, so a caller who
  // sets only GEOLINK_API_KEY still reaches x.
  const seen = spy();
  const { loadConfig } = await import("../config.js");
  process.env.GEOLINK_API_KEY = CALLER_KEY;
  delete process.env.GEOLINK_X_KEY;
  const cfg = loadConfig();
  assert.ok(cfg.xKey.length > 0, "x has a credential without one being set");
  assert.notEqual(cfg.xKey, cfg.apiKey, "and it is not the caller's");
});

test("naming a place sends the name, not stale coordinates beside it", async () => {
  // near and coordinates together are refused by the API, so the client must
  // send one or the other - not both because a default centre was lying around.
  const seen = spy();
  await client().xSearch({
    query: "x",
    near: "أسوان",
    center: { lat: 30.0444, lng: 31.2357 },
    language: "ar",
    country: "eg",
  });
  const url = seen[0]!.url!;
  assert.equal(url.searchParams.get("near"), "أسوان");
  assert.equal(url.searchParams.get("latitude"), null);
  assert.equal(url.searchParams.get("longitude"), null);
});

test("coordinates are sent when no name is given", async () => {
  const seen = spy();
  await client().xSearch({
    query: "x",
    center: { lat: 30.0444, lng: 31.2357 },
    language: "ar",
    country: "eg",
  });
  const url = seen[0]!.url!;
  assert.equal(url.searchParams.get("latitude"), "30.0444");
  assert.equal(url.searchParams.get("near"), null);
});
