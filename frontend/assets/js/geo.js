/*
 * RuralPulse geo logic (browser + node): turns raw OpenStreetMap data into a
 * ranked "where to go" list for a triage result, matches doctors from the
 * pan-India listing to the user's area, and picks a fastest and a main-road
 * route from OSRM alternatives.
 *
 * Honesty rules built in:
 *  - OSM data is community data: every place is labelled "not verified".
 *  - Government / free care is ranked first for non-emergencies.
 *  - Emergencies only go to hospitals (preferring ones tagged emergency=yes).
 *  - A doctor is linked to a hospital only when the listing names that
 *    hospital and the name matches an OSM place; nothing is invented.
 */
(function (root) {
  "use strict";
  const R = 6371;
  function haversine(lat1, lon1, lat2, lon2) {
    const toR = (d) => (d * Math.PI) / 180;
    const a = Math.sin(toR(lat2 - lat1) / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(toR(lon2 - lon1) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  // Rough rural driving estimate (road factor 1.35, 32 km/h average + 4 min to start)
  const estMinutes = (km) => Math.round(4 + (km * 1.35 * 60) / 32);

  const GOV = /\b(phc|chc|uphc|sub[\s-]?cent(re|er)|primary health|community health|government|govt\.?|district hospital|civil hospital|general hospital|taluk|tehsil|area hospital|esi|esic|ayushman|arogya mandir|health (and|&) wellness|hwc|aiims|medical college|railway hospital|cghs|jan aushadhi)\b|सरकारी|राजकीय|प्राथमिक स्वास्थ्य|सामुदायिक स्वास्थ्य|அரசு|ஆரம்ப சுகாதார|সরকারি|ప్రభుత్వ|ಸರ್ಕಾರಿ|സർക്കാർ|ਸਰਕਾਰੀ|સરકારી|ସରକାରୀ/i;
  const SPEC = {
    cardiac: /cardio|heart/i, maternal: /gyna|obstet|maternity|women|mother|birthing/i, pediatric: /p(a)?ediatric|child|children|shishu|neonat/i,
    skin: /dermat|skin/i, dental: /dent/i, musculoskeletal: /ortho|bone|spine|joint/i, mental: /psychiat|mental|mind/i, eye: /ophthal|eye|netra/i,
    ent: /otolaryn|\bent\b|ear/i, urinary: /urolog|nephro|kidney/i, digestive: /gastro|digest/i, neuro: /neuro/i,
    respiratory: /pulmo|chest|respir/i, tb: /tuberc|\btb\b|chest|pulmo/i, injury: /trauma|accident|ortho|emergency/i, bite: /emergency|general/i,
  };

  function kindOf(t) {
    const a = t.amenity || "", h = t.healthcare || "";
    if (a === "pharmacy" || h === "pharmacy") return "pharmacy";
    if (a === "dentist" || h === "dentist") return "dentist";
    if (a === "hospital" || h === "hospital") return "hospital";
    if (a === "clinic" || h === "clinic" || h === "centre" || h === "primary_care" || h === "birthing_centre") return "clinic";
    if (a === "doctors" || h === "doctor") return "doctors";
    return "clinic";
  }
  function normalizeOSM(elements, origin) {
    const seen = new Set(), out = [];
    for (const el of elements || []) {
      const t = el.tags || {};
      const lat = el.lat ?? (el.center && el.center.lat), lon = el.lon ?? (el.center && el.center.lon);
      if (lat == null || lon == null) continue;
      const name = t.name || t["name:en"] || t.operator || null;
      const key = `osm:${el.type}/${el.id}`;
      if (seen.has(key)) continue; seen.add(key);
      const kind = kindOf(t);
      const blob = [name, t.operator, t["operator:type"], t["healthcare:speciality"], t.description].filter(Boolean).join(" ");
      const gov = /^(government|public|community)$/i.test(t["operator:type"] || "") || GOV.test(blob);
      const km = haversine(origin.lat, origin.lon, lat, lon);
      out.push({
        key, source: "osm", name: name || null, unnamed: !name, kind, lat, lon,
        distance_km: Math.round(km * 10) / 10, est_minutes: estMinutes(km), gov,
        emergency: t.emergency === "yes" ? true : t.emergency === "no" ? false : null,
        open247: /24\/7/.test(t.opening_hours || ""), opening_hours: t.opening_hours || null,
        phone: t.phone || t["contact:phone"] || t["contact:mobile"] || null,
        specialities: (t["healthcare:speciality"] || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean),
        operator: t.operator || null, beds: t.beds || null,
        address: [t["addr:housenumber"], t["addr:street"], t["addr:village"] || t["addr:city"], t["addr:postcode"]].filter(Boolean).join(", ") || null,
        osm_url: `https://www.openstreetmap.org/${el.type}/${el.id}`, verified: false,
        _blob: blob,
      });
    }
    return out;
  }
  function specMatch(f, category) {
    const rx = SPEC[category];
    return !!(rx && (rx.test(f._blob || "") || f.specialities.some((s) => rx.test(s))));
  }
  /*
   * Rank OSM facilities for a triage result. Score is "effective km": lower is better.
   * ctx = { level, category }
   */
  function rank(facilities, ctx) {
    const level = ctx.level, cat = ctx.category || "general";
    const care = facilities.filter((f) => f.kind !== "pharmacy");
    const pharmacies = facilities.filter((f) => f.kind === "pharmacy").sort((a, b) => a.distance_km - b.distance_km).slice(0, 4);
    let pool, warn = null;
    if (level === "EMERGENCY") {
      pool = care.filter((f) => f.kind === "hospital");
      if (!pool.length) { pool = care.filter((f) => f.kind !== "dentist"); warn = "no_hospital"; }
    } else if (level === "URGENT_SAME_DAY") {
      pool = care.filter((f) => ["hospital", "clinic", "doctors"].includes(f.kind) || (cat === "dental" && f.kind === "dentist"));
    } else {
      pool = care.filter((f) => f.kind !== "dentist" || cat === "dental");
    }
    const scored = pool.map((f) => {
      let s = f.distance_km, why = [];
      if (level === "EMERGENCY") {
        if (f.emergency === true) { s -= 4; why.push("emergency"); }
        if (f.emergency === false) s += 15;
        if (f.open247) { s -= 1; why.push("24x7"); }
        if (f.gov) { s -= 1.5; why.push("gov"); }
      } else {
        if (f.gov) { s -= level === "URGENT_SAME_DAY" ? 3 : 5; why.push("gov"); }
        if (f.kind === "hospital" && level !== "URGENT_SAME_DAY") s += 1;   // lowest level of care that can handle it
        if (cat === "dental" && f.kind === "dentist") { s -= 4; why.push("speciality"); }
      }
      if (specMatch(f, cat)) { s -= 3; why.push("speciality"); }
      if (f.unnamed) s += 3;
      return { ...f, score: Math.round(s * 100) / 100, why };
    }).sort((a, b) => a.score - b.score);
    return { primary: scored[0] || null, options: scored.slice(0, 8), pharmacies, warn, counts: { care: care.length, pharmacies: pharmacies.length } };
  }

  // ---------------------------------------------------------------- doctors listing
  const tokens = (s) => new Set((s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !["hospital", "clinic", "centre", "center", "pvt", "ltd", "the", "and", "care", "name", "cut", "off", "source", "dr", "dr."].includes(w)));
  function nameMatch(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const w of A) if (B.has(w)) inter++;
    return inter / Math.min(A.size, B.size);
  }
  function doctorsNear(doctors, origin, category, osmFacilities, opts = {}) {
    const maxKm = opts.maxKm || 60, limit = opts.limit || 6, pin = (opts.pincode || "").slice(0, 3);
    const out = [];
    for (const d of doctors || []) {
      if (d.lat == null) continue;
      const km = haversine(origin.lat, origin.lon, d.lat, d.lon);
      const samePin = pin && (d.pincode || "").startsWith(pin);
      if (km > maxKm && !samePin) continue;
      const cats = d.categories || [];
      const relevant = cats.includes(category) || (category === "general" && cats.includes("general")) ||
        (["injury", "bite"].includes(category) && cats.includes("injury"));
      const generalist = cats.includes("general");
      if (!relevant && !generalist && !opts.all) continue;
      let linked = null;
      if (d.practice_or_hospital && osmFacilities && osmFacilities.length) {
        let best = null, bestScore = 0;
        for (const f of osmFacilities) {
          if (!f.name || haversine(d.lat, d.lon, f.lat, f.lon) > 40) continue;
          const sc = nameMatch(d.practice_or_hospital, f.name);
          if (sc > bestScore) { best = f; bestScore = sc; }
        }
        if (best && bestScore >= 0.6) linked = { key: best.key, name: best.name, lat: best.lat, lon: best.lon, match: Math.round(bestScore * 100) / 100 };
      }
      out.push({ ...d, distance_km: Math.round(km), relevance: relevant ? 2 : 1, linked_facility: linked });
    }
    out.sort((a, b) => b.relevance - a.relevance || a.distance_km - b.distance_km);
    return out.slice(0, limit);
  }

  // ---------------------------------------------------------------- routes
  function routeStats(r) {
    let total = 0, numbered = 0, named = 0;
    for (const leg of r.legs || []) for (const st of leg.steps || []) {
      total += st.distance || 0;
      if (st.ref && /\b(NH|SH|MDR|AH)\s?-?\d+/i.test(st.ref)) numbered += st.distance || 0;
      else if (st.ref) numbered += 0.6 * (st.distance || 0);
      if (st.name || st.ref) named += st.distance || 0;
    }
    const turns = (r.legs || []).reduce((n, l) => n + (l.steps || []).length, 0);
    return { duration_min: Math.round((r.duration || 0) / 60), distance_km: Math.round((r.distance || 0) / 100) / 10,
      main_road_pct: total ? Math.round((100 * numbered) / total) : 0, named_road_pct: total ? Math.round((100 * named) / total) : 0, turns,
      geometry: r.geometry };
  }
  /* Fastest = shortest duration. Main-road = among routes at most 30% slower, the one with the most distance on
     numbered highways (NH/SH/MDR), then named roads, then fewest turns: better lit, busier, easier for ambulances. */
  function chooseRoutes(osrm) {
    const routes = (osrm && osrm.routes) || [];
    if (!routes.length) return null;
    const stats = routes.map(routeStats);
    let fi = 0; stats.forEach((s, i) => { if (s.duration_min < stats[fi].duration_min) fi = i; });
    const cands = stats.map((s, i) => [s, i]).filter(([s]) => s.duration_min <= stats[fi].duration_min * 1.3 + 2);
    cands.sort((a, b) => b[0].main_road_pct - a[0].main_road_pct || b[0].named_road_pct - a[0].named_road_pct || a[0].turns - b[0].turns);
    const mi = cands[0][1];
    return { fastest: stats[fi], main: stats[mi], same: mi === fi, alternatives: routes.length };
  }
  function navLinks(origin, dest) {
    const o = origin ? `${origin.lat},${origin.lon}` : "", d = `${dest.lat},${dest.lon}`;
    return {
      google: `https://www.google.com/maps/dir/?api=1${o ? "&origin=" + o : ""}&destination=${d}&travelmode=driving`,
      osm: `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${o ? o.replace(",", "%2C") : ""}%3B${d.replace(",", "%2C")}`,
      geo: `geo:${d}?q=${d}`,
    };
  }
  /* Offline place lookup: cities from the doctors listing + the demo village. */
  function offlineGeocode(q, doctors) {
    const s = (q || "").trim().toLowerCase();
    if (!s) return [];
    const m = /^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/.exec(s);
    if (m) return [{ name: `${m[1]}, ${m[3]}`, lat: +m[1], lon: +m[3] }];
    const seen = new Set(), out = [];
    for (const d of doctors || []) {
      const hit = (d.city || "").toLowerCase().startsWith(s) || (d.locality || "").toLowerCase().startsWith(s) || (/^\d{3,6}$/.test(s) && (d.pincode || "").startsWith(s.slice(0, 3)));
      if (hit && d.lat != null && !seen.has(d.city)) { seen.add(d.city); out.push({ name: `${d.city}, ${d.state}`, lat: d.lat, lon: d.lon }); }
    }
    return out.slice(0, 5);
  }
  const api = { haversine, estMinutes, normalizeOSM, rank, doctorsNear, chooseRoutes, routeStats, navLinks, nameMatch, offlineGeocode, GOV };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.RPGeo = api;
})(typeof window !== "undefined" ? window : globalThis);
