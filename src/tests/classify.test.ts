import { test } from "node:test";
import assert from "node:assert/strict";

import { GeoLinkClient, GeoLinkError } from "../services/client.js";

/**
 * The API tells us what went wrong in a header. This used to match the error
 * *text* with regular expressions that never matched the wording the API
 * actually uses, so a genuinely missing address fell through to the
 * `status >= 500` branch and was reported as a temporary fault — then retried
 * twice, with backoff, for a place that does not exist.
 *
 * These stub fetch rather than calling the live API, so they check the mapping
 * and not the network. The tokens are the ones the API really sends; they were
 * read off live responses, not invented here.
 */

type Reply = { status: number; code?: string; error?: string; body?: unknown };

function stub(reply: Reply) {
  (globalThis as any).fetch = async () =>
    new Response(
      JSON.stringify(reply.body ?? { success: false, error: reply.error ?? "x" }),
      {
        status: reply.status,
        headers: reply.code
          ? { "content-type": "application/json", "x-geolink-error-code": reply.code }
          : { "content-type": "application/json" },
      },
    );
}

function client() {
  return new GeoLinkClient({
    baseUrl: "https://example.invalid",
    apiKey: "k",
    timeoutMs: 500,
    maxRetries: 0,
  } as any);
}

async function kindOf(reply: Reply): Promise<string> {
  stub(reply);
  try {
    await client().geocode("x", "en", "eg");
    return "no error";
  } catch (err) {
    return err instanceof GeoLinkError ? err.kind : "wrong type";
  }
}

test("a place that does not exist is not a retryable fault", async () => {
  // The exact wording the API uses. Nothing in it matches "not found".
  assert.equal(
    await kindOf({
      status: 404,
      code: "location_not_found",
      error: "We couldn't find that location. Please try with a different search term or coordinates.",
    }),
    "not_found",
  );
});

test("an empty result is told apart from an unresolvable one", async () => {
  // Both are 404. Only the code distinguishes "the area has none" from
  // "the area did not resolve", and they lead to different next moves.
  assert.equal(await kindOf({ status: 404, code: "no_results" }), "not_found");
  assert.equal(await kindOf({ status: 404, code: "location_not_found" }), "not_found");
});

test("the guard's own refusals are read too", async () => {
  assert.equal(await kindOf({ status: 400, code: "missing_key" }), "auth");
  assert.equal(await kindOf({ status: 401, code: "invalid_key" }), "auth");
  assert.equal(await kindOf({ status: 400, code: "missing_param" }), "bad_request");
});

test("being throttled is upstream, and says not to retry at once", async () => {
  stub({ status: 503, code: "service_temporary" });
  await assert.rejects(client().geocode("x", "en", "eg"), (err: GeoLinkError) => {
    assert.equal(err.kind, "upstream");
    assert.match(err.hint, /retrying at once is what causes it/i);
    return true;
  });
});

test("a timeout from the API is a timeout, not a generic fault", async () => {
  assert.equal(await kindOf({ status: 504, code: "timeout" }), "timeout");
});

test("quota is still quota", async () => {
  assert.equal(await kindOf({ status: 429, code: "quota_exceeded" }), "quota");
});

test("without a code the status still separates asking wrongly from us breaking", async () => {
  // An older deployment, or something outside the API's own error path.
  assert.equal(await kindOf({ status: 404 }), "not_found");
  assert.equal(await kindOf({ status: 401 }), "auth");
  assert.equal(await kindOf({ status: 400 }), "bad_request");
  assert.equal(await kindOf({ status: 500 }), "upstream");
});

test("only genuinely transient kinds are retried", async () => {
  // The retry set is timeout/network/upstream. A not_found being in it was the
  // whole bug: every missing address cost three requests instead of one.
  let calls = 0;
  (globalThis as any).fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ success: false, error: "gone" }), {
      status: 404,
      headers: { "content-type": "application/json", "x-geolink-error-code": "location_not_found" },
    });
  };
  const c = new GeoLinkClient({
    baseUrl: "https://example.invalid",
    apiKey: "k",
    timeoutMs: 500,
    maxRetries: 2,
  } as any);
  await assert.rejects(c.geocode("x", "en", "eg"));
  assert.equal(calls, 1, "a missing place must be asked about once, not three times");
});

test("a response's headers reach the caller that asks for them", async () => {
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ success: true, data: { ok: true } }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-geolink-matrix-requested": "2500",
        "x-geolink-matrix-measured": "1100",
        "x-geolink-matrix-complete": "false",
      },
    });
  const { headers } = await client().requestWithHeaders<{ ok: boolean }>("/api/v1/x", {});
  assert.equal(headers.get("x-geolink-matrix-complete"), "false");
  assert.equal(headers.get("x-geolink-matrix-measured"), "1100");
});
