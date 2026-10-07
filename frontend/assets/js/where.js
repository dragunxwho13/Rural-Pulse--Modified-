/* "Nearest care" tab: asks for the patient's location (GPS or village / PIN),
 * finds real health centres and pharmacies around them on OpenStreetMap,
 * ranks them for this triage result (government first, hospitals only for
 * emergencies), draws the fastest and the main-road route, suggests listed
 * doctors in the area, and lets the patient or ASHA notify the chosen
 * facility's doctor (live, with symptoms and a prep list). */
(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const G = window.RPGeo, A = () => window.RPApp, esc = (s) => window.RPSlip.esc(s);
  const cfg = () => (window.RPApp && window.RPApp.state.mapCfg) || {};
  const OV = () => cfg().overpass_url || "https://overpass-api.de/api/interpreter";
  const NOM = () => (cfg().nominatim_url || "https://nominatim.openstreetmap.org").replace(/\/$/, "");
  const OSR = () => (cfg().osrm_url || "https://router.project-osrm.org").replace(/\/$/, "");
  const KIND_ICON = { hospital: "🏥", clinic: "✚", doctors: "🩺", pharmacy: "💊", dentist: "🦷" };
  const st = { loc: null, places: [], ranked: null, map: null, layers: null, routeLayer: null, caseES: null, lastResult: null,
    watchId: null, meMarker: null, accCircle: null, tiles: null, activeRoute: null, lastRouteAt: 0, fetchedAt: null, loading: false };
  const t = (k) => A().t(k);

  // ---------------------------------------------------------------- data access (server proxy first, then direct)
  async function nearby(lat, lon, radius, dental) {
    const app = A();
    if (app.state.server) {
      try { return await app.getJSON(`api/osm/nearby?lat=${lat}&lon=${lon}&radius=${radius}&dental=${dental}`, {}, 35000); } catch (e) { if (e.status !== 502) throw e; }
    }
    const a = `(around:${radius},${lat.toFixed(5)},${lon.toFixed(5)})`;
    const q = `[out:json][timeout:25];(nwr["amenity"~"^(hospital|clinic|doctors)$"]${a};nwr["healthcare"~"^(hospital|clinic|doctor|centre|primary_care|birthing_centre)$"]${a};nwr["amenity"="pharmacy"]${a};${dental ? `nwr["amenity"="dentist"]${a};` : ""});out center tags 300;`;
    const r = await fetch(OV(), { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    if (!r.ok) throw new Error("overpass " + r.status);
    return await r.json();
  }
  async function geocode(q) {
    const app = A();
    if (app.state.server) { try { return (await app.getJSON("api/osm/geocode?q=" + encodeURIComponent(q), {}, 15000)).results; } catch (_) {} }
    try {
      const p = /^\d{6}$/.test(q.trim()) ? `postalcode=${q.trim()}` : `q=${encodeURIComponent(q)}`;
      const r = await fetch(`${NOM()}/search?format=jsonv2&countrycodes=in&limit=5&${p}`);
      if (r.ok) return (await r.json()).map((x) => ({ name: x.display_name, lat: +x.lat, lon: +x.lon }));
    } catch (_) {}
    return G.offlineGeocode(q, app.state.doctors);
  }
  async function reverse(lat, lon) {
    const app = A();
    if (app.state.server) { try { return await app.getJSON(`api/osm/reverse?lat=${lat}&lon=${lon}`, {}, 10000); } catch (_) {} }
    try { const r = await fetch(`${NOM()}/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lon}`); if (r.ok) { const j = await r.json(); return { name: j.display_name, postcode: (j.address || {}).postcode }; } } catch (_) {}
    return null;
  }
  async function route(a, b) {
    const app = A();
    if (app.state.server) { try { return await app.getJSON(`api/osm/route?from_lat=${a.lat}&from_lon=${a.lon}&to_lat=${b.lat}&to_lon=${b.lon}`, {}, 25000); } catch (_) {} }
    const r = await fetch(`${OSR()}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&alternatives=3&steps=true`);
    if (!r.ok) throw new Error("osrm " + r.status);
    return await r.json();
  }

  // ---------------------------------------------------------------- location
  function status(msg) { $("#locStatus").textContent = msg || ""; }
  $("#gpsBtn").addEventListener("click", () => {
    if (!navigator.geolocation) { status(t("location_denied")); $("#placeInput").focus(); return; }
    status(t("searching"));
    navigator.geolocation.getCurrentPosition((p) => { setLocation({ lat: p.coords.latitude, lon: p.coords.longitude, label: "GPS", accuracy: p.coords.accuracy }); startLive(); },
      () => { status(t("location_denied")); $("#placeInput").focus(); }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
  $("#placeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#placeInput").value.trim(); if (!q) return;
    status(t("searching"));
    const res = await geocode(q);
    const box = $("#placeResults");
    if (!res.length) { box.innerHTML = ""; status(t("no_results")); return; }
    if (res.length === 1) { box.innerHTML = ""; setLocation({ ...res[0], label: res[0].name }); return; }
    box.innerHTML = res.map((r, i) => `<button type="button" data-i="${i}">📍 ${esc(r.name)}</button>`).join("");
    $$("button", box).forEach((b) => b.addEventListener("click", () => { box.innerHTML = ""; const r = res[+b.dataset.i]; setLocation({ ...r, label: r.name }); }));
    status("");
  });
  async function setLocation(loc) {
    st.loc = loc;
    try { sessionStorage.setItem("rp.loc", JSON.stringify(loc)); } catch (_) {}
    $("#locBox").classList.add("compact");
    status(`📍 ${loc.label === "GPS" ? "GPS" : loc.label}`.slice(0, 120));
    reverse(loc.lat, loc.lon).then((r) => { if (r) { st.loc.postcode = r.postcode; if (loc.label === "GPS") status(`📍 ${r.name}`.slice(0, 140)); } }).catch(() => {});
    await load();
  }

  // ---------------------------------------------------------------- load + rank + render
  async function load() {
    const r = A().state.result; if (!r || !st.loc || st.loading) return;
    st.loading = true; st.fetchedFrom = { lat: st.loc.lat, lon: st.loc.lon };
    $("#careList").innerHTML = `<p class="hint">${esc(t("searching"))}</p>`;
    const dental = r.category === "dental";
    let elements = null, err = null;
    for (const radius of [15000, 40000]) {
      try {
        const data = await nearby(st.loc.lat, st.loc.lon, radius, dental);
        elements = data.elements || [];
        const care = elements.filter((e) => (e.tags || {}).amenity !== "pharmacy").length;
        if (care >= 3 || radius === 40000) break;
      } catch (e) { err = e; break; }
    }
    st.loading = false; st.fetchedAt = new Date();
    st.elements = elements || [];
    st.places = elements ? G.normalizeOSM(elements, st.loc) : [];
    st.ranked = G.rank(st.places, { level: r.urgency.level, category: r.category });
    render(r, err);
  }
  function kindLabel(f) { return ({ hospital: "Hospital", clinic: "Clinic / health centre", doctors: "Doctor", pharmacy: "Pharmacy", dentist: "Dentist" })[f.kind] || f.kind; }
  function placeCard(f, primary) {
    const name = f.name || `${kindLabel(f)} (no name on map)`;
    const badges = [`<span class="badge">${KIND_ICON[f.kind] || ""} ${esc(kindLabel(f))}</span>`];
    if (f.gov) badges.push(`<span class="badge gov">Govt / free</span>`);
    if (f.emergency) badges.push(`<span class="badge bad">Emergency</span>`);
    if (f.open247) badges.push(`<span class="badge ok">24x7</span>`);
    else if (f.opening_hours) badges.push(`<span class="badge">🕘 ${esc(f.opening_hours.slice(0, 40))}</span>`);
    badges.push(`<span class="badge warn">${esc(t("not_verified"))}</span>`);
    const links = G.navLinks(st.loc, f);
    return `<div class="place ${primary ? "primary" : ""}" data-key="${esc(f.key)}">
      <div class="place-head"><div><h4>${esc(name)}</h4></div><div class="dist">${f.distance_km} ${esc(t("km"))}<small>~${f.est_minutes} ${esc(t("min"))}</small></div></div>
      <div class="meta">${badges.join("")}</div>
      <div class="acts">
        <button type="button" class="btn btn-ink btn-sm" data-route="fast">⚡ ${esc(t("route_fast"))}</button>
        <button type="button" class="btn btn-quiet btn-sm" data-route="main">🛣 ${esc(t("route_safe"))}</button>
        <a class="btn btn-quiet btn-sm" href="${links.google}" target="_blank" rel="noopener">↗ ${esc(t("open_maps"))}</a>
        ${f.phone ? `<a class="btn btn-quiet btn-sm" href="tel:${esc(f.phone.replace(/\s/g, ""))}">☎ ${esc(t("call"))}</a>` : ""}
        <button type="button" class="btn btn-quiet btn-sm" data-use>🧾 ${esc(t("slip"))}</button>
      </div>
      <div class="src">${f.address ? esc(f.address) + " · " : ""}<a href="${f.osm_url}" target="_blank" rel="noopener">OpenStreetMap</a></div></div>`;
  }
  function render(r, err) {
    const R = st.ranked, list = $("#careList");
    let html = `<p class="hint">${st.watchId != null ? '<span class="live-badge">LIVE</span> ' : ""}${esc(t("gov_first"))}. ${esc(t("osm_source"))}
      <span class="muted"> · ${st.fetchedAt ? st.fetchedAt.toLocaleTimeString() : ""}</span></p>`;
    if (err && !st.places.length) html = `<div class="note-box">The map service is not reachable right now. Use the verified directory below, call 104, or try again.</div>`;
    else if (!R.primary) html += `<div class="note-box">${esc(t("no_results"))}</div>`;
    if (R.warn === "no_hospital") html += `<div class="note-box">No hospital found nearby on the map. Call 108: the ambulance knows the nearest one.</div>`;
    if (r.urgency.level === "EMERGENCY") html += `<div class="note-box">☎ 108 first. An ambulance is safer than driving yourself.</div>`;
    html += R.options.slice(0, 5).map((f, i) => placeCard(f, i === 0)).join("");
    const docs = G.doctorsNear(A().state.doctors, st.loc, r.category, st.places, { maxKm: 60, pincode: st.loc.postcode || "" });
    if (docs.length) {
      html += `<h4 class="sec-title">👩‍⚕️ ${esc(t("doctors_near"))} <span class="badge warn">Listing, not NMC-verified</span></h4>`;
      html += docs.map((d) => `<div class="doc"><b>${esc(d.name)}</b><span>~${d.distance_km} ${esc(t("km"))}</span>
        <span>${esc(d.specialty)}${d.practice_or_hospital ? " · " + esc(d.practice_or_hospital) : ""}</span>
        <span>${d.phone ? `<a href="tel:${esc(d.phone)}">☎ ${esc(d.phone)}</a>` : ""}</span>
        <span class="meta">${esc([d.locality, d.city, d.pincode].filter(Boolean).join(", "))} · location approximate (city)
        ${d.linked_facility ? ` · <button type="button" class="listen" data-pan="${esc(d.linked_facility.key)}">📍 ${esc(d.linked_facility.name)} on map</button>` : ""}</span></div>`).join("");
    }
    if (R.pharmacies.length) {
      html += `<h4 class="sec-title">💊 Pharmacies</h4>` + R.pharmacies.map((f) => `<div class="doc"><b>${esc(f.name || "Pharmacy")}</b><span>${f.distance_km} ${esc(t("km"))}</span>
        <span class="meta">${f.gov ? "Jan Aushadhi / govt · " : ""}<a href="${G.navLinks(st.loc, f).google}" target="_blank" rel="noopener">${esc(t("open_maps"))}</a>${f.phone ? ` · <a href="tel:${esc(f.phone)}">☎</a>` : ""}</span></div>`).join("");
    }
    list.innerHTML = html;
    $$(".place", list).forEach((card) => {
      const f = st.places.find((x) => x.key === card.dataset.key);
      $$("[data-route]", card).forEach((b) => b.addEventListener("click", () => showRoute(f, b.dataset.route)));
      $("[data-use]", card).addEventListener("click", () => usePlace(f, true));
    });
    $$("[data-pan]", list).forEach((b) => b.addEventListener("click", () => { const f = st.places.find((x) => x.key === b.dataset.pan); if (f && st.map) st.map.setView([f.lat, f.lon], 15); }));
    if (R.primary) usePlace(R.primary, false);
    drawMap();
  }
  function usePlace(f, announce) {
    const app = A();
    app.state.place = { name: f.name || kindLabel(f), phone: f.phone, distance_km: f.distance_km, hours: f.open247 ? "24x7" : (f.opening_hours || ""),
      address: f.address, source: "OpenStreetMap (not verified)", map: G.navLinks(st.loc, f).google, key: f.key, lat: f.lat, lon: f.lon, kind: f.kind };
    app.renderSlip();
    renderNotify();
    if (announce) app.toast("🧾 " + app.state.place.name);
  }

  // ---------------------------------------------------------------- map + routes
  function drawMap() {
    if (!window.L || document.body.classList.contains("lowbw")) { $("#mapWrap").hidden = true; return; }
    $("#mapWrap").hidden = false;
    if (!st.map) {
      st.map = L.map("map", { zoomControl: true, attributionControl: true, tap: true });
      setTiles();
      st.layers = L.layerGroup().addTo(st.map);
      addTools();
      if (window.ResizeObserver) new ResizeObserver(() => st.map && st.map.invalidateSize()).observe($("#map"));
    }
    st.layers.clearLayers(); if (st.routeLayer) { st.routeLayer.remove(); st.routeLayer = null; } $("#routeInfo").hidden = true;
    const icon = (cls, txt) => L.divIcon({ className: "", html: `<div class="pin ${cls}"><i>${txt}</i></div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
    const me = L.marker([st.loc.lat, st.loc.lon], { icon: icon("me", "●"), title: t("your_location"), zIndexOffset: 1000 }).addTo(st.layers).bindPopup(t("your_location"));
    st.meMarker = me;
    st.accCircle = st.loc.accuracy ? L.circle([st.loc.lat, st.loc.lon], { radius: Math.min(st.loc.accuracy, 2000), color: "#F4B23E", weight: 1, fillOpacity: 0.08 }).addTo(st.layers) : null;
    const pts = [[st.loc.lat, st.loc.lon]];
    const show = st.ranked.options.slice(0, 5).concat(st.ranked.pharmacies.slice(0, 3));
    show.forEach((f, i) => {
      const cls = f.kind + (i === 0 && f.kind !== "pharmacy" ? " primary" : "");
      L.marker([f.lat, f.lon], { icon: icon(cls, KIND_ICON[f.kind] || "✚"), title: f.name || f.kind }).addTo(st.layers)
        .bindPopup(`<b>${esc(f.name || kindLabel(f))}</b><br>${f.distance_km} km${f.gov ? " · Govt" : ""}`);
      if (i < 5) pts.push([f.lat, f.lon]);
    });
    st.map.invalidateSize();
    if (pts.length > 1) st.map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 }); else st.map.setView(pts[0], 13);
    me.openPopup();
  }
  async function showRoute(f, which, silent) {
    if (!st.loc) return;
    st.activeRoute = { f, which }; st.lastRouteAt = Date.now();
    const info = $("#routeInfo"); info.hidden = false; info.textContent = "…";
    if (!silent) $("#mapWrap").scrollIntoView({ behavior: "smooth", block: "center" });
    let ch = null;
    try { ch = G.chooseRoutes(await route(st.loc, f)); } catch (_) { ch = null; }
    if (st.routeLayer) { st.routeLayer.remove(); st.routeLayer = null; }
    const night = new Date().getHours() >= 19 || new Date().getHours() < 6;
    const nav = G.navLinks(st.loc, f).google;
    if (!ch) {
      info.innerHTML = `<span>Routing service not reachable. Straight-line ${f.distance_km} km, about ${f.est_minutes} min by road.</span><a href="${nav}" target="_blank" rel="noopener" style="color:#F4B23E">↗ ${esc(t("open_maps"))}</a>`;
      if (window.L && st.map) st.routeLayer = L.polyline([[st.loc.lat, st.loc.lon], [f.lat, f.lon]], { color: "#F4B23E", weight: 4, dashArray: "6 8" }).addTo(st.map);
      return;
    }
    const chosen = which === "main" ? ch.main : ch.fastest, other = which === "main" ? ch.fastest : ch.main;
    if (window.L && st.map) {
      const toLL = (g) => g.coordinates.map(([x, y]) => [y, x]);
      st.routeLayer = L.layerGroup().addTo(st.map);
      if (!ch.same) L.polyline(toLL(other.geometry), { color: "#7C8F94", weight: 4, opacity: .6, dashArray: "4 8" }).addTo(st.routeLayer);
      const line = L.polyline(toLL(chosen.geometry), { color: which === "main" ? "#2C7FB8" : "#F4B23E", weight: 6 }).addTo(st.routeLayer);
      st.map.fitBounds(line.getBounds(), { padding: [30, 30] });
    }
    const tips = [];
    if (ch.same) tips.push("The fastest route already uses the main roads.");
    if (night) tips.push("At night, prefer the main-road route and travel with someone.");
    if (A().state.result && A().state.result.urgency.level === "EMERGENCY") tips.push("Call 108: an ambulance is safer than driving yourself.");
    info.innerHTML = `<span>⚡ ${esc(t("route_fast"))}: <b>${ch.fastest.duration_min} ${esc(t("min"))}</b> · ${ch.fastest.distance_km} ${esc(t("km"))}</span>
      <span>🛣 ${esc(t("route_safe"))}: <b>${ch.main.duration_min} ${esc(t("min"))}</b> · ${ch.main.distance_km} ${esc(t("km"))} · ${ch.main.main_road_pct}% highways</span>
      <a href="${nav}" target="_blank" rel="noopener" style="color:#F4B23E;font-weight:700">↗ ${esc(t("open_maps"))}</a>
      ${tips.length ? `<span style="flex-basis:100%;color:#C6D6D0">${esc(tips.join(" "))}</span>` : ""}`;
  }

  // ---------------------------------------------------------------- real-time: tiles, live GPS, tools
  function setTiles() {
    if (!st.map || !window.L) return;
    if (st.tiles) st.tiles.remove();
    const c = cfg(), url = c.tile_url || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    st.tiles = L.tileLayer(url, { maxZoom: 19, subdomains: "abc", attribution: c.tile_attribution || "© OpenStreetMap contributors" }).addTo(st.map);
  }
  function addTools() {
    const box = document.createElement("div"); box.className = "map-tools";
    box.innerHTML = `<button type="button" id="mtLive" aria-pressed="false" title="Follow my location live">📡 Live</button>
      <button type="button" id="mtCenter" title="Back to me">◎</button><button type="button" id="mtFull" title="Full screen">⛶</button>`;
    $("#mapWrap").appendChild(box);
    ["click", "dblclick", "mousedown", "touchstart", "wheel"].forEach((ev) => box.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }));
    $("#mtLive").addEventListener("click", () => (st.watchId == null ? startLive() : stopLive()));
    $("#mtCenter").addEventListener("click", () => st.loc && st.map.setView([st.loc.lat, st.loc.lon], Math.max(st.map.getZoom(), 14)));
    $("#mtFull").addEventListener("click", () => { $("#mapWrap").classList.toggle("full"); setTimeout(() => st.map.invalidateSize(), 60); });
    syncLiveBtn();
  }
  function syncLiveBtn() { const b = document.getElementById("mtLive"); if (b) b.setAttribute("aria-pressed", String(st.watchId != null)); }
  function startLive() {
    if (!navigator.geolocation || st.watchId != null) return;
    st.watchId = navigator.geolocation.watchPosition(onMove, () => stopLive(), { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    syncLiveBtn();
  }
  function stopLive() { if (st.watchId != null) navigator.geolocation.clearWatch(st.watchId); st.watchId = null; syncLiveBtn(); }
  function onMove(p) {
    const lat = p.coords.latitude, lon = p.coords.longitude;
    if (!st.loc) { setLocation({ lat, lon, label: "GPS", accuracy: p.coords.accuracy }); return; }
    const moved = G.haversine(st.loc.lat, st.loc.lon, lat, lon) * 1000;
    st.loc = { ...st.loc, lat, lon, accuracy: p.coords.accuracy, label: "GPS" };
    if (st.meMarker) st.meMarker.setLatLng([lat, lon]);
    if (st.accCircle) { st.accCircle.setLatLng([lat, lon]); st.accCircle.setRadius(Math.min(p.coords.accuracy || 50, 2000)); }
    if (moved < 25) return;
    const far = st.fetchedFrom ? G.haversine(st.fetchedFrom.lat, st.fetchedFrom.lon, lat, lon) : 99;
    if (far > 3) { load(); return; }                                  // moved >3 km: fetch places again
    const r = A().state.result;                                        // otherwise re-rank with new distances
    if (r && st.elements) {
      st.places = G.normalizeOSM(st.elements, st.loc);
      st.ranked = G.rank(st.places, { level: r.urgency.level, category: r.category });
      const keepRoute = st.activeRoute; render(r, null); st.activeRoute = keepRoute;
    }
    if (st.activeRoute && Date.now() - st.lastRouteAt > 30000 && moved > 150) showRoute(st.activeRoute.f, st.activeRoute.which, true);
  }
  async function autoLocate() {                                         // use GPS straight away if permission was given before
    if (st.loc || !navigator.permissions || !navigator.geolocation) return;
    try { const p = await navigator.permissions.query({ name: "geolocation" }); if (p.state === "granted") $("#gpsBtn").click(); } catch (_) {}
  }

  // ---------------------------------------------------------------- verified directory (offline)
  function renderDirectory(r) {
    const N = r.navigation, cards = [N.primary, ...N.alternatives].filter(Boolean);
    $("#dirList").innerHTML = (N.warnings.length ? `<div class="note-box">${N.warnings.map(esc).join("<br>")}</div>` : "") + cards.map((c, i) => `<div class="place ${i === 0 ? "primary" : ""}">
      <div class="place-head"><div><h4>${esc(c.name)}</h4><span class="hint">${esc(c.type)}</span></div><div class="dist">${c.distance_km} km<small>${c.travel_time_min} min</small></div></div>
      <div class="meta"><span class="badge ${c.open.open_now ? "ok" : "warn"}">${esc(c.open.text)}</span><span class="badge ${c.freshness.status === "VERIFIED" ? "ok" : "warn"}">${esc(c.freshness.status)} · ${esc(c.provenance.last_verified)}</span><span class="badge">☎ ${esc(c.phone)}</span></div>
      <div class="src">${esc(c.provenance.source)} · ${esc(c.provenance.authority)}</div>
      <div class="acts"><button type="button" class="btn btn-quiet btn-sm" data-dir="${esc(c.id)}">🧾 ${esc(t("slip"))}</button></div></div>`).join("")
      + (N.teleconsult ? `<div class="note-box">📞 ${esc(N.teleconsult.name)} · ${esc(N.teleconsult.open.text)} · ${esc(N.teleconsult.phone)}</div>` : "");
    $$("[data-dir]").forEach((b) => b.addEventListener("click", () => {
      const c = cards.find((x) => x.id === b.dataset.dir);
      A().state.place = { name: c.name, phone: c.phone, distance_km: c.distance_km, hours: c.open.hours, source: "Verified directory · " + c.provenance.last_verified, key: c.id, kind: c.type };
      A().renderSlip(); renderNotify(); A().toast("🧾 " + c.name);
    }));
    $("#dirDetails").open = !st.loc;
  }

  // ---------------------------------------------------------------- notify the doctor (cases)
  function target() {
    const app = A(), r = app.state.result;
    if (app.state.place) return app.state.place;
    const p = r && r.navigation.primary;
    return p ? { name: p.name, phone: p.phone, key: p.id, kind: p.type, source: "Verified directory" } : null;
  }
  function renderNotify() {
    const app = A(), box = $("#notifyBox"), tg = target();
    if (!tg) { box.innerHTML = ""; return; }
    if (!app.state.server) {
      const share = window.RPSlip.shareText(app.currentSlip(), app.slipExtra());
      box.innerHTML = `<div class="notify-cta"><b>📨 ${esc(t("send_doctor"))}</b><span class="hint">Offline: send the slip by SMS instead.</span>
        <a class="btn btn-quiet" href="sms:${tg.phone && /^\+?\d[\d\s-]{6,}$/.test(tg.phone) ? tg.phone.replace(/\s/g, "") : ""}?&body=${encodeURIComponent(share)}">✉ ${esc(t("sms"))}</a></div>`;
      return;
    }
    box.innerHTML = `<div class="notify-cta"><b>📨 ${esc(t("send_doctor"))}: ${esc(tg.name)}</b>
      <span class="hint">The doctor sees the symptoms now and can keep medicines and equipment ready before you arrive.</span>
      <button class="btn btn-green btn-lg" type="button" id="notifyBtn">📨 ${esc(t("send_doctor"))}</button><div id="caseStatus"></div></div>`;
    $("#notifyBtn").addEventListener("click", openNotify);
  }
  function slots() {
    const out = [["", "—"]], now = new Date();
    const fmt = (d) => d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
    const d = new Date(now); d.setMinutes(0, 0, 0);
    for (let i = 1; i <= 4; i++) { const x = new Date(d.getTime() + i * 3600e3); if (x.getHours() >= 8 && x.getHours() <= 19) out.push([x.toISOString(), fmt(x)]); }
    for (const h of [9, 10, 11, 12, 15]) { const x = new Date(now); x.setDate(x.getDate() + 1); x.setHours(h, 0, 0, 0); out.push([x.toISOString(), fmt(x)]); }
    return out;
  }
  function ashaToken() { try { return localStorage.getItem("rp.ashaToken") || ""; } catch (_) { return ""; } }
  function openNotify() {
    const app = A(), tg = target();
    $("#notifyTarget").innerHTML = `📍 <b>${esc(tg.name)}</b>${tg.phone ? " · ☎ " + esc(tg.phone) : ""}`;
    $("#nfSlot").innerHTML = slots().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
    $("#ashaAuth").hidden = !(app.state.mode === "asha" && !ashaToken());
    $("#notifySheet").showModal();
  }
  $("#nfCancel").addEventListener("click", () => $("#notifySheet").close());
  $("#nfOtpBtn").addEventListener("click", async () => {
    try {
      const r = await A().postJSON("api/auth/otp", { phone: $("#nfAshaPhone").value });
      if (!r.ok) { $("#nfOtpHint").textContent = r.error; return; }
      $("#nfOtpHint").textContent = r.demo_otp ? `Demo mode (no SMS gateway): your code is ${r.demo_otp}` : "Code sent by SMS.";
      if (r.demo_otp) $("#nfOtp").value = r.demo_otp;
    } catch (e) { $("#nfOtpHint").textContent = "Could not send the code."; }
  });
  $("#notifyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const app = A(), r = app.state.result, tg = target(), headers = {};
    if (app.state.mode === "asha") {
      let tok = ashaToken();
      if (!tok && $("#nfOtp").value) {
        try {
          const v = await app.postJSON("api/auth/verify", { phone: $("#nfAshaPhone").value, code: $("#nfOtp").value, role: "asha", name: $("#nfAshaName").value });
          tok = v.token; try { localStorage.setItem("rp.ashaToken", tok); } catch (_) {}
        } catch (err) { $("#nfOtpHint").textContent = (err.body && err.body.detail) || "Wrong code"; return; }
      }
      if (tok) headers.Authorization = "Bearer " + tok;
    }
    app.state.patientName = $("#nfName").value.trim();
    const I = r.interpretation;
    const body = { assessment_id: r.assessment_id, level: r.urgency.level, title: r.urgency.title, message: app.state.req ? app.state.req.message : "",
      symptoms: I.symptoms.map((s) => s.label), red_flags: I.red_flags.map((f) => f.label), lang: r.language_out, age: I.age_years, duration_days: I.duration_days,
      pregnant: I.pregnant, vitals: (app.state.req && app.state.req.vitals) || {}, doctor_note: r.summary.doctor_text, prep: r.clinician_prep, mode: app.state.mode,
      patient_name: app.state.patientName, patient_phone: $("#nfPhone").value, slot: $("#nfSlot").value || null, location: st.loc ? { lat: st.loc.lat, lon: st.loc.lon } : null,
      facility: { key: tg.key, name: tg.name, lat: tg.lat, lon: tg.lon, phone: tg.phone, kind: tg.kind, source: tg.source } };
    $("#nfSend").disabled = true;
    try {
      const c = await app.postJSON("api/cases", body, 15000, headers);
      $("#notifySheet").close(); app.toast("✅ " + t("sent"), 6000); app.renderSlip();
      watchCase(c);
    } catch (err) { app.toast("Could not notify the doctor. Use SMS or call the facility."); }
    finally { $("#nfSend").disabled = false; }
  });
  function watchCase(c) {
    const box = $("#caseStatus"); if (!box) return;
    const steps = [["new", "Sent"], ["seen", "Seen"], ["preparing", "Preparing"], ["ready", "Ready for you"], ["done", "Done"]];
    const draw = (stt) => { const i = steps.findIndex((s) => s[0] === stt);
      box.innerHTML = `<div class="case-status">${c.id}: ${steps.map((s, j) => `<span class="st ${j <= i ? "on" : ""}">${s[1]}</span>`).join("")}</div>`; };
    draw(c.status);
    if (st.caseES) st.caseES.close();
    st.caseES = new EventSource(`api/events?facility=case:${encodeURIComponent(c.id)}`);
    st.caseES.onmessage = (ev) => { try { const d = JSON.parse(ev.data); if (d.case) { draw(d.case.status); if (d.case.status === "ready") A().speak(t("sent"), A().L()); } } catch (_) {} };
  }

  // ---------------------------------------------------------------- wiring
  window.addEventListener("rp:result", (e) => {
    const r = e.detail; st.lastResult = r;
    $("#careList").innerHTML = ""; $("#locBox").classList.toggle("compact", !!st.loc);
    renderDirectory(r); renderNotify();
    if (!st.loc) { try { const s = sessionStorage.getItem("rp.loc"); if (s) st.loc = JSON.parse(s); } catch (_) {} }
    if (st.loc) load();
  });
  window.addEventListener("rp:tab", (e) => { if (e.detail === "care") { if (st.map) setTimeout(() => st.map.invalidateSize(), 50); autoLocate(); } });
  window.addEventListener("rp:settings", () => { setTiles(); if (st.loc && A().state.result) load(); });
  window.addEventListener("rp:online", () => { if (st.loc && A().state.result) load(); renderNotify(); });
  window.addEventListener("resize", () => st.map && st.map.invalidateSize());
  window.addEventListener("rp:reset", () => { if (st.caseES) st.caseES.close(); st.activeRoute = null; });
  window.addEventListener("rp:ready", () => { $("#placeInput").placeholder = t("type_place"); });
  window.RPWhere = { st, setLocation };
})();
