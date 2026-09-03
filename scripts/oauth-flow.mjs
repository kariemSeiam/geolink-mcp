import { createHash, randomBytes } from "node:crypto";
const BASE = "http://127.0.0.1:3131";
let failures = 0;
const ok = (n, p, d) => { if (!p) failures++; console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
process.on("beforeExit", () => {
  console.log(`\n${failures === 0 ? "all checks passed" : failures + " check(s) failed"}`);
  process.exit(failures === 0 ? 0 : 1);
});
const j = async (r) => { try { return await r.json(); } catch { return null; } };

// 1. Unauthenticated POST must 401 with a challenge that points at the metadata.
let r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
const chal = r.headers.get("www-authenticate") ?? "";
ok("unauthenticated POST /mcp -> 401", r.status === 401, `status=${r.status}`);
ok("challenge names the metadata document", /resource_metadata="http:\/\/127\.0\.0\.1:3131\/\.well-known\/oauth-protected-resource\/mcp"/.test(chal), chal.slice(0, 90));
ok("challenge quotes its values", !/resource_metadata=[^"]/.test(chal));

// 2. Discovery documents, unauthenticated.
const prm = await j(await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`));
ok("PRM resource is the concrete endpoint", prm?.resource === `${BASE}/mcp`, prm?.resource);
ok("PRM names its authorization server", prm?.authorization_servers?.[0] === BASE);
ok("PRM omits offline_access", !(prm?.scopes_supported ?? []).includes("offline_access"));
const prmRoot = await j(await fetch(`${BASE}/.well-known/oauth-protected-resource`));
ok("PRM served at both paths, identically", JSON.stringify(prmRoot) === JSON.stringify(prm));

const as = await j(await fetch(`${BASE}/.well-known/oauth-authorization-server`));
ok("AS issuer matches PRM authorization_servers[0]", as?.issuer === prm?.authorization_servers?.[0], as?.issuer);
ok("AS advertises S256 (absence = clients refuse)", as?.code_challenge_methods_supported?.includes("S256"));
ok("AS advertises public clients", as?.token_endpoint_auth_methods_supported?.includes("none"));
ok("AS advertises CIMD", as?.client_id_metadata_document_supported === true);

// 3. Dynamic client registration.
r = await fetch(`${BASE}/register`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9911/cb"], client_name: "Test Client" }) });
const reg = await j(r);
ok("register -> 201 with a client_id", r.status === 201 && typeof reg?.client_id === "string", reg?.client_id);
ok("register echoes the redirect_uris", reg?.redirect_uris?.[0] === "http://127.0.0.1:9911/cb");

r = await fetch(`${BASE}/register`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"], client_name: "x" }) });
const regHttps = await j(r);
ok("register accepts an https redirect for a real client", r.status === 201, `status=${r.status}`);

// 4. Authorize: the consent page.
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9911/cb",
  response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "st-123" });
r = await fetch(`${BASE}/authorize?${q}`, { redirect: "manual" });
const html = await r.text();
ok("authorize renders the consent page", r.status === 200 && /Connect GeoLink/.test(html), `status=${r.status}`);
ok("consent page cannot be framed", r.headers.get("x-frame-options") === "DENY" && /frame-ancestors 'none'/.test(r.headers.get("content-security-policy") ?? ""));

// 5. Missing PKCE must be refused.
const noPkce = new URLSearchParams({ client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9911/cb", response_type: "code" });
r = await fetch(`${BASE}/authorize?${noPkce}`, { redirect: "manual" });
ok("authorize without PKCE is refused", r.status === 302 || r.status === 400, `status=${r.status}`);

// 6. An unregistered redirect must be refused.
const badRedir = new URLSearchParams({ client_id: reg.client_id, redirect_uri: "https://evil.example/cb",
  response_type: "code", code_challenge: challenge, code_challenge_method: "S256" });
r = await fetch(`${BASE}/authorize?${badRedir}`, { redirect: "manual" });
ok("unregistered redirect_uri is refused", r.status === 400, `status=${r.status}`);

// 7. Consent POST -> code, carrying iss.
const form = new URLSearchParams({ client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9911/cb",
  response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "st-123", api_key: "test-key" });
r = await fetch(`${BASE}/authorize`, { method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
const loc = new URL(r.headers.get("location") ?? "http://x/");
ok("consent POST redirects with a code", r.status === 302 && loc.searchParams.has("code"), `status=${r.status}`);
ok("state survives the round trip", loc.searchParams.get("state") === "st-123");
ok("iss is appended (redirect leaves from the POST)", loc.searchParams.get("iss") === BASE, loc.searchParams.get("iss") ?? "(absent)");
const code = loc.searchParams.get("code");

// 8. Token exchange with PKCE.
r = await fetch(`${BASE}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier,
    redirect_uri: "http://127.0.0.1:9911/cb", client_id: reg.client_id }) });
const tok = await j(r);
ok("token endpoint accepts form-urlencoded", r.status === 200, `status=${r.status}`);
ok("token response is a Bearer token", tok?.token_type === "Bearer" && typeof tok?.access_token === "string");

// 9. The code is single use.
r = await fetch(`${BASE}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id }) });
ok("replayed code is refused", r.status === 400, `status=${r.status}`);

// 10. A wrong verifier must fail.
const f2 = new URLSearchParams({ client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9911/cb", response_type: "code",
  code_challenge: challenge, code_challenge_method: "S256", api_key: "test-key" });
r = await fetch(`${BASE}/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: f2 });
const code2 = new URL(r.headers.get("location")).searchParams.get("code");
r = await fetch(`${BASE}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: code2, code_verifier: "wrong-verifier", client_id: reg.client_id }) });
ok("wrong code_verifier is refused", r.status === 400, (await j(r))?.error);

// 11. The token actually works on /mcp.
r = await fetch(`${BASE}/mcp`, { method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tok.access_token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "flow-test", version: "1" } } }) });
const init = await j(r);
ok("authenticated initialize succeeds", r.status === 200 && init?.result?.serverInfo?.name === "geolink-mcp", `status=${r.status}`);

// 12. Header tolerance: absent is fine, matching is fine, disagreeing is not.
const sid = r.headers.get("mcp-session-id");
const call = (extra) => fetch(`${BASE}/mcp`, { method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${tok.access_token}`, ...(sid ? { "mcp-session-id": sid } : {}), ...extra },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
ok("no routing headers -> accepted", (await call({})).status === 200);
ok("matching Mcp-Method -> accepted", (await call({ "Mcp-Method": "tools/list" })).status === 200);
const mism = await call({ "Mcp-Method": "resources/read" });
const mismBody = await j(mism);
ok("disagreeing Mcp-Method -> -32020", mism.status === 400 && mismBody?.error?.code === -32020, `code=${mismBody?.error?.code}`);
const badVer = await call({ "MCP-Protocol-Version": "1999-01-01" });
ok("unknown protocol version -> -32022", badVer.status === 400 && (await j(badVer))?.error?.code === -32022);

// 13. Revocation.
await fetch(`${BASE}/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token: tok.access_token }) });
r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok.access_token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
ok("revoked token stops working", r.status === 401, `status=${r.status}`);
