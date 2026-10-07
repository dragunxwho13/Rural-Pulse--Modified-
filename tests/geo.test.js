// node tests/geo.test.js  -- ranking, doctor matching and route choice on synthetic fixtures
const assert = require("assert"), path = require("path"), fs = require("fs");
const G = require(path.join(__dirname, "..", "frontend", "assets", "js", "geo.js"));
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "overpass_sample.json")));
const origin = { lat: 12.9716, lon: 79.1430 };   // Katpadi area (test point)
const F = G.normalizeOSM(raw.elements, origin);
assert.strictEqual(F.length, 10);
assert.ok(F.every((f) => f.verified === false && f.osm_url.startsWith("https://www.openstreetmap.org/")));
const gvmc = F.find((f) => f.name.startsWith("Government"));
assert.ok(gvmc.gov, "operator:type=government is government");
assert.ok(F.find((f) => f.name === "Katpadi Primary Health Centre").gov, "PHC name is government");

const em = G.rank(F, { level: "EMERGENCY", category: "cardiac" });
assert.strictEqual(em.primary.kind, "hospital", "emergency goes to a hospital");
assert.ok(em.options.every((f) => f.kind === "hospital"));
assert.notStrictEqual(em.primary.name, "Private Nursing Home", "emergency=no is pushed down");

const rt = G.rank(F, { level: "PROMPT_ROUTINE", category: "general" });
assert.ok(rt.primary.gov, "routine care: government first");
assert.strictEqual(rt.primary.name, "Katpadi Primary Health Centre");
assert.ok(rt.pharmacies.length >= 2 && rt.pharmacies[0].kind === "pharmacy");
assert.ok(!rt.options.some((f) => f.kind === "dentist"), "no dentist for general problems");

const dn = G.rank(F, { level: "PROMPT_ROUTINE", category: "dental" });
assert.strictEqual(dn.primary.kind, "dentist");
const mat = G.rank(F, { level: "URGENT_SAME_DAY", category: "maternal" });
assert.ok(["Ma Women and Child Clinic", "Government Vellore Medical College Hospital", "Katpadi Primary Health Centre"].includes(mat.primary.name));

const doctors = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "doctors.json"))).doctors;
const near = G.doctorsNear(doctors, origin, "general", F, { maxKm: 120 });
assert.ok(near.length >= 1 && near.every((d) => d.distance_km <= 120));
assert.ok(near.some((d) => d.city === "Vellore"), "Vellore listing is suggested near Katpadi");
assert.ok(near.every((d) => !d.linked_facility || d.practice_or_hospital), "never links a doctor without a named practice");
// a doctor whose listing names a hospital that exists on the map is linked
const fake = [{ id: "T1", name: "Dr Test", categories: ["cardiac"], lat: 12.93, lon: 79.14, practice_or_hospital: "Christian Medical College Hospital", pincode: "632004" }];
assert.strictEqual(G.doctorsNear(fake, origin, "cardiac", F)[0].linked_facility.name, "Christian Medical College Hospital");

const routes = G.chooseRoutes(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "osrm_sample.json"))));
assert.strictEqual(routes.fastest.duration_min, 15);
assert.strictEqual(routes.main.duration_min, 17);
assert.ok(routes.main.main_road_pct > 70 && !routes.same, "main-road route uses NH 48");
assert.ok(G.navLinks(origin, gvmc).google.includes("destination=12.934,79.17"));
assert.strictEqual(G.offlineGeocode("vell", doctors)[0].name, "Vellore, Tamil Nadu");
console.log("geo tests passed:", F.length, "places,", near.length, "doctors near test point");
