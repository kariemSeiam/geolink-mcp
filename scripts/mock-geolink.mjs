// Minimal GeoLink API mock mirroring the documented response shapes.
import { createServer } from "node:http";
const port = Number(process.env.MOCK_PORT || 4545);
const KEY = "test-key";
let calls = 0;

const place = (name, lat, lng, district = "Zamalek", gov = "Cairo Governorate") => ({
  address: `${name}, ${district}, ${gov}, Egypt`,
  short_address: name,
  address_parts: { district, governorate: gov, country: "EG" },
  location: { lat, lng },
});
const withBounds = (p) => ({ ...p, bounds: { northeast: { lat: p.location.lat + 0.02, lng: p.location.lng + 0.02 }, southwest: { lat: p.location.lat - 0.02, lng: p.location.lng - 0.02 } } });

createServer((req, res) => {
  calls++;
  const u = new URL(req.url, "http://x");
  const q = Object.fromEntries(u.searchParams);
  const send = (obj, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (q.key !== KEY) return send({ success: false, error: "Invalid API key or request parameters" }, 401);

  if (u.pathname === "/api/v2/geocode") {
    if (/nowhere/i.test(q.query)) return send({ success: false, error: "No results found" }, 404);
    if (/giza/i.test(q.query)) return send({ success: true, data: { address: "Giza Governorate, Egypt", short_address: "Giza", address_parts: { district: "", governorate: "Giza", country: "EG" }, location: { lat: 30.01, lng: 31.21 }, bounds: { northeast: { lat: 30.06, lng: 31.26 }, southwest: { lat: 29.96, lng: 31.16 } } } });
    return send({ success: true, data: withBounds(place("Cairo Tower", 30.0459, 31.2243)) });
  }
  if (u.pathname === "/api/v2/reverse_geocode") return send({ success: true, data: withBounds(place("Cairo Tower", +q.latitude, +q.longitude)) });
  if (u.pathname === "/api/v2/text_search") {
    const lat = +q.latitude || 30.04, lng = +q.longitude || 31.23;
    // Deterministic jitter so different grid points overlap partially (tests dedup).
    const j = (k) => ((Math.round(lat * 1000) + Math.round(lng * 1000) + k) % 7) * 0.0007;
    const fixed = [
      place(`${q.query} Alpha`, 30.0459, 31.2243),                 // identical everywhere → deduped to 1
      place(`${q.query} Beta`, lat + j(1), lng + j(2), "Dokki", "Giza"),
      place(`${q.query} Gamma`, lat - j(3), lng + j(4), "Mohandessin", "Giza"),
      place(`${q.query} Far`, 25.0, 33.0, "Elsewhere", "Red Sea"),  // outside area → clipped
    ];
    // Depth: the real engine pages until it has max_results or the source runs
    // dry. "deep" queries have plenty; everything else exhausts at `fixed`.
    const want = Math.max(1, +q.max_results || 20);
    if (!/deep/i.test(q.query ?? "")) return send({ success: true, data: fixed.slice(0, Math.max(fixed.length, 0)) });
    const filler = Array.from({ length: Math.max(0, want - fixed.length) }, (_, i) =>
      place(`${q.query} #${i + 1}`, lat + 0.001 * (i + 1), lng + 0.001 * (i + 1), "Dokki", "Giza"));
    return send({ success: true, data: [...fixed, ...filler].slice(0, want) });
  }
  if (u.pathname === "/api/v2/directions") {
    const o = { lat: +q.origin_latitude, lng: +q.origin_longitude }, d = { lat: +q.destination_latitude, lng: +q.destination_longitude };
    const wps = Array.from({ length: 500 }, (_, i) => [o.lat + (d.lat - o.lat) * i / 499, o.lng + (d.lng - o.lng) * i / 499]);
    const route = (m, s) => ({ distance: { meters: m, text: `${(m/1000).toFixed(1)} km` }, duration: { seconds: s, text: `${Math.round(s/60)} min` },
      bounds: { northeast: { lat: o.lat, lng: o.lng }, southwest: { lat: d.lat, lng: d.lng } },  // deliberately swapped
      origin: { ...o, address: "Cairo Governorate", short_address: "Tahrir Square" }, destination: { ...d, address: "Marouf, Qasr El Nil", short_address: "Haret Al Bosti" }, waypoints: wps });
    return send({ success: true, data: [route(969, 290), route(1200, 340), route(1500, 400)] });
  }
  if (u.pathname === "/api/v1/distance_matrix") {
    const P = (s) => s.split(";").map((x) => x.split(",").map(Number));
    const O = P(q.origins), D = P(q.destinations);
    const matrix = O.map((o) => D.map((d) => { const m = Math.round(Math.hypot(o[0]-d[0], o[1]-d[1]) * 111000 * 1.3) + 100; return { distance_meters: m, distance_text: `${(m/1000).toFixed(2)} km`, duration_seconds: Math.round(m/8), duration_text: `${Math.round(m/8/60)} mins` }; }));
    return send({ success: true, data: { origins: O.map((c) => ({ coordinates: c, short_name: "", full_address: "" })), destinations: D.map((c) => ({ coordinates: c, short_name: "", full_address: "" })), distance_matrix: matrix, nearest_destination_index: matrix.map((r) => r.reduce((bi, c, i, a) => c.duration_seconds < a[bi].duration_seconds ? i : bi, 0)) } });
  }
  send({ success: false, error: "Unknown endpoint" }, 404);
}).listen(port, "127.0.0.1", () => console.error(`mock geolink on ${port}`));
