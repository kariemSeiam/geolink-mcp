#!/usr/bin/env node
/**
 * Re-measure every number the references claim, against the live API.
 *
 * The references are only trustworthy because this exists. Run it rather than
 * believing a figure written in a file: the upstream moves, and a skill whose
 * numbers rot is worse than one with no numbers, because the rot is invisible.
 *
 *   GEOLINK_API_KEY=... node scripts/probe.mjs
 *   GEOLINK_API_KEY=... node scripts/probe.mjs --samples 12
 *
 * Prints what it observed today next to what the references record, and flags
 * anything that drifted. Costs roughly 40 upstream requests at default samples.
 */

const KEY = process.env.GEOLINK_API_KEY;
const BASE = (process.env.GEOLINK_BASE_URL ?? "https://geolink-eg.com").replace(/\/+$/, "");
const SAMPLES = Number(process.argv[process.argv.indexOf("--samples") + 1]) || 8;

if (!KEY) {
  console.error("GEOLINK_API_KEY is required. Get one at https://geolink-eg.com/register");
  process.exit(1);
}

// What the reference files currently claim. Update when a drift is accepted.
//
// The partial-page rates here are measured at the API surface, where the
// engine already re-reads a page that looks terminal before accepting it. They
// should read ~0%. The raw upstream rate behind that correction was measured at
// about 25% on sparse pages (tripwires.md, section 1); a non-zero number here
// means the correction has stopped working, which is the thing worth catching.
const RECORDED = {
  page_size: 20,
  partial_rate_sparse: 0.0,
  partial_rate_dense: 0.0,
  seconds_20: 1.2,
  seconds_80: 1.2,
};

const DENSE = { query: "صيدلية", lat: 30.0444, lng: 31.2357, label: "dense " };
const SPARSE = { query: "مطعم كشري التحرير الاصلي", lat: 26.5, lng: 31.7, label: "sparse" };

async function search(target, maxResults) {
  const url = new URL("/api/v2/text_search", BASE + "/");
  url.searchParams.set("query", target.query);
  url.searchParams.set("latitude", String(target.lat));
  url.searchParams.set("longitude", String(target.lng));
  url.searchParams.set("language", "ar");
  url.searchParams.set("country", "eg");
  if (maxResults !== undefined) url.searchParams.set("max_results", String(maxResults));
  url.searchParams.set("key", KEY);

  const started = Date.now();
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  const rows = body && Array.isArray(body.data) ? body.data : [];
  return {
    ok: body && body.success === true,
    count: rows.length,
    seconds: (Date.now() - started) / 1000,
    error: body ? body.error : undefined,
  };
}

function pct(n) {
  return (n * 100).toFixed(0) + "%";
}

function drift(observed, recorded, tolerance) {
  return Math.abs(observed - recorded) <= tolerance ? "  ok" : " DRIFT";
}

function sleep(ms) {
  return new Promise(function (done) {
    setTimeout(done, ms);
  });
}

async function partialRate(target, recorded) {
  const counts = [];
  for (let i = 0; i < SAMPLES; i++) {
    const r = await search(target, 20);
    if (r.ok) counts.push(r.count);
    await sleep(700);
  }
  if (counts.length === 0) return;
  let best = 0;
  for (const c of counts) if (c > best) best = c;
  let short = 0;
  for (const c of counts) if (c < best) short += 1;
  const rate = short / counts.length;
  const seen = [];
  for (const c of counts) if (seen.indexOf(c) === -1) seen.push(c);
  seen.sort(function (a, b) {
    return a - b;
  });
  const line = "partial pages (" + target.label + ")   observed " + pct(rate).padStart(4) +
    "  recorded " + pct(recorded).padStart(4) + drift(rate, recorded, 0.2) +
    "   counts seen: " + seen.join(", ");
  console.log(line);
}

async function main() {
  console.log("probe . " + BASE + " . " + new Date().toISOString().slice(0, 10) + " . " + SAMPLES + " samples");
  console.log("");

  // 1. Page size: the unit depth is bought in.
  const one = await search(DENSE, 20);
  if (!one.ok) {
    console.error("upstream refused: " + (one.error || "unknown error"));
    process.exit(2);
  }
  console.log("page size                 observed " + one.count + "   recorded " + RECORDED.page_size + drift(one.count, RECORDED.page_size, 0));

  // 2. Latency: does depth cost time, or only calls?
  const deep = await search(DENSE, 80);
  console.log("20 results                observed " + one.seconds.toFixed(1) + "s  recorded " + RECORDED.seconds_20 + "s" + drift(one.seconds, RECORDED.seconds_20, 1.5));
  console.log("80 results                observed " + deep.seconds.toFixed(1) + "s  recorded " + RECORDED.seconds_80 + "s" + drift(deep.seconds, RECORDED.seconds_80, 1.5) + "   (" + deep.count + " results)");

  // 3. Partial-page rate per cohort, measured through the API. A non-zero
  //    sparse figure means the engine's confirm-before-exhaustion step regressed.
  await partialRate(DENSE, RECORDED.partial_rate_dense);
  await partialRate(SPARSE, RECORDED.partial_rate_sparse);

  // 4. Early stop: few matches must cost fewer calls, not more.
  const sparseDeep = await search(SPARSE, 200);
  console.log("sparse asked for 200      observed " + sparseDeep.count + " results in " + sparseDeep.seconds.toFixed(1) + "s   (stops when the area runs out)");

  console.log("");
  console.log("Any DRIFT above means a reference file states something the API no longer does.");
  console.log("Fix the file, then update RECORDED here so the next run stays honest.");
}

main().catch(function (err) {
  console.error("probe failed: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
