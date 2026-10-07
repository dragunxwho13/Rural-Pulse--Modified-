/* Doctor / pharmacy dashboard.
 * Doctors see patients sent by ASHAs or patients the moment they are sent
 * (server-sent events), with the patient's own words, red flags, vitals and
 * a preparation list, then write a medicine card (doctor decides medicines
 * and doses). Pharmacies see reservations and mark them ready. */
(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = window.RPSlip.esc;
  const LEVEL = { EMERGENCY: "Emergency", URGENT_SAME_DAY: "Same day", PROMPT_ROUTINE: "2-3 days", INFO_SELF_CARE: "Self-care", CANNOT_DETERMINE: "Undetermined" };
  const ds = { token: null, user: null, role: "doctor", cases: [], rx: [], sel: null, es: null, sound: false, facilities: [], pharmacies: [], langs: {} };
  let toastT;
  const toast = (m, ms = 5000) => { const el = $("#toast"); el.textContent = m; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), ms); };
  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(ds.token ? { Authorization: "Bearer " + ds.token } : {}) };
    const r = await fetch("api/" + path, { ...opts, headers });
    if (!r.ok) { let d = ""; try { d = (await r.json()).detail; } catch (_) {} const e = new Error(d || r.status); e.status = r.status; throw e; }
    return r.json();
  }
  const ago = (iso) => { const s = (Date.now() - new Date(iso).getTime()) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

  // ---------------------------------------------------------------- login
  $$(".login .seg button").forEach((b) => b.addEventListener("click", () => {
    $$(".login .seg button").forEach((x) => x.setAttribute("aria-checked", String(x === b))); ds.role = b.dataset.role; fillFacilities();
  }));
  function fillFacilities() {
    const list = ds.role === "pharmacy" ? [["all", "All pharmacies (demo)"], ...ds.pharmacies.map((p) => [p.id, p.name])]
      : [["all", "All incoming patients (district view)"], ...ds.facilities.map((f) => [f.id, `${f.name} (${f.type})`])];
    $("#lgFacility").innerHTML = list.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  }
  $("#lgOtpBtn").addEventListener("click", async () => {
    try {
      const r = await api("auth/otp", { method: "POST", body: JSON.stringify({ phone: $("#lgPhone").value }) });
      if (!r.ok) { $("#lgHint").textContent = r.error; return; }
      $("#lgHint").textContent = r.demo_otp ? `Demo mode: your code is ${r.demo_otp} (set an SMS gateway to send real codes).` : "Code sent by SMS.";
      if (r.demo_otp) $("#lgOtp").value = r.demo_otp;
    } catch (e) { $("#lgHint").textContent = "Could not send the code: " + e.message; }
  });
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const sel = $("#lgFacility"), name = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : "";
    try {
      const r = await api("auth/verify", { method: "POST", body: JSON.stringify({ phone: $("#lgPhone").value, code: $("#lgOtp").value, role: ds.role,
        name: $("#lgName").value, facility_key: sel.value, facility_name: name }) });
      ds.token = r.token; ds.user = r.user; try { localStorage.setItem("rp.staffToken", r.token); localStorage.setItem("rp.staffUser", JSON.stringify(r.user)); } catch (_) {}
      start();
    } catch (err) { $("#lgHint").textContent = err.message; }
  });
  $("#logoutBtn").addEventListener("click", () => { try { localStorage.removeItem("rp.staffToken"); localStorage.removeItem("rp.staffUser"); } catch (_) {} location.reload(); });

  // ---------------------------------------------------------------- alerts
  $("#alertsBtn").addEventListener("click", async () => {
    ds.sound = true; beep();
    if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
    $("#alertsBtn").textContent = "🔔 Alerts on";
  });
  let actx = null;
  function beep() {
    try {
      actx = actx || new AudioContext();
      [0, 0.22, 0.44].forEach((d, i) => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = i === 2 ? 1046 : 880;
        g.gain.setValueAtTime(0.0001, actx.currentTime + d); g.gain.exponentialRampToValueAtTime(0.3, actx.currentTime + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + d + 0.18); o.connect(g).connect(actx.destination); o.start(actx.currentTime + d); o.stop(actx.currentTime + d + 0.2); });
    } catch (_) {}
  }
  function alertNew(title, body) {
    if (ds.sound) beep();
    if ("Notification" in window && Notification.permission === "granted") { try { new Notification(title, { body, icon: "assets/img/icon.svg", tag: title }); } catch (_) {} }
    toast(`🔔 ${title}: ${body}`, 8000);
    document.title = `(new) RuralPulse dashboard`; setTimeout(() => (document.title = "RuralPulse for doctors and pharmacies"), 8000);
  }

  // ---------------------------------------------------------------- start + live events
  async function start() {
    $("#loginCard").hidden = true; $("#logoutBtn").hidden = false; $("#outboxCard").hidden = false; $("#demoBar").hidden = false;
    $("#simBtn").textContent = ds.user.role === "pharmacy" ? "▶ Simulate incoming prescription" : "▶ Simulate incoming patient";
    $("#whoami").textContent = `${ds.user.name || ds.user.phone} · ${ds.user.facility_name || "All"}`;
    const key = ds.user.facility_key || "all";
    if (ds.user.role === "pharmacy") { $("#pharmacyView").hidden = false; await loadRx(); }
    else { $("#doctorView").hidden = false; await loadCases(); }
    loadOutbox();
    connect(key);
    setInterval(() => { renderTimes(); }, 30000);
    setInterval(() => { if (!ds.live) refresh(); }, 15000);   // fallback when the live stream is down
  }
  async function refresh() {
    try { if (ds.user.role === "pharmacy") await loadRx(); else await loadCases(); loadOutbox(); } catch (_) {}
  }
  function renderTimes() { $$("[data-ago]").forEach((el) => (el.textContent = ago(el.dataset.ago))); }
  function setLive(on, text) {
    ds.live = on; $("#liveDot").classList.toggle("on", on); $("#liveText").textContent = text || (on ? "Live" : "Reconnecting…");
  }
  function connect(key) {
    if (ds.es) ds.es.close();
    ds.es = new EventSource(`api/events?facility=${encodeURIComponent(key)}&token=${encodeURIComponent(ds.token)}`);
    ds.es.onopen = () => { const was = ds.wasLive; setLive(true); ds.wasLive = true; if (was === false) refresh(); };
    ds.es.onerror = () => {   // EventSource retries by itself; if it gave up, reconnect with back-off
      setLive(false); ds.wasLive = false;
      if (ds.es.readyState === 2) { clearTimeout(ds.retryT); ds.retryT = setTimeout(() => connect(key), Math.min(30000, (ds.retry = (ds.retry || 1000) * 2))); }
    };
    ds.es.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (d.type === "case" && ds.user.role === "doctor") {
        ds.retry = 1000;
        if (ds.preview) { ds.preview = false; ds.cases = []; $("#previewNote").hidden = true; }
        if (!ds.cases.some((c) => c.id === d.case.id)) ds.cases.unshift(d.case);
        ds.sel = d.case.id; renderInbox(d.case.id); renderDetail(d.case);
        alertNew(`${LEVEL[d.case.level] || d.case.level} patient`, `${(d.case.symptoms || []).join(", ")}${d.case.age != null ? " · age " + d.case.age : ""}`);
      } else if (d.type === "case_update") {
        const i = ds.cases.findIndex((c) => c.id === d.case.id); if (i >= 0) ds.cases[i] = d.case; renderInbox();
        if (ds.sel === d.case.id) markStatus(d.case);
      } else if (d.type === "rx" && ds.user.role === "pharmacy") {
        if (ds.preview) { ds.preview = false; ds.rx = []; $("#previewNote").hidden = true; }
        if (!ds.rx.some((x) => x.id === d.rx.id)) ds.rx.unshift(d.rx); renderRx(d.rx.id); alertNew("New prescription", d.rx.items.map((i) => i.name).join(", "));
      } else if (d.type === "rx_update") { const i = ds.rx.findIndex((x) => x.id === d.rx.id); if (i >= 0) { ds.rx[i] = d.rx; renderRx(); } }
      else if (d.type === "sms") loadOutbox();
    };
  }

  // ---------------------------------------------------------------- doctor: inbox + detail
  async function loadCases() {
    const key = ds.user.facility_key || "all";
    ds.cases = (await api(`cases?facility=${encodeURIComponent(key)}`)).cases; ds.preview = false;
    if (!ds.cases.length && key !== "all") {   // nothing for this facility yet: show the district's recent reports so the screen is never empty
      ds.cases = (await api("cases?facility=all")).cases; ds.preview = ds.cases.length > 0;
    }
    $("#previewNote").hidden = !ds.preview;
    $("#previewNote").textContent = ds.preview ? `No patients for ${ds.user.facility_name || "your facility"} yet, so recent reports from the whole district are shown. Press ▶ Simulate to send one to your facility.` : "";
    renderInbox();
  }
  function renderStats() {
    const el = $("#stats");
    if (ds.user.role === "pharmacy") {
      const n = (s) => ds.rx.filter((r) => r.status === s).length;
      el.innerHTML = [["📥", "New", n("sent") + n("issued")], ["📦", "Reserved", n("reserved")], ["✅", "Ready", n("ready")], ["🤝", "Collected", n("collected")], ["⚠", "Out of stock", n("out_of_stock")]]
        .map(([i, l, v]) => `<div class="stat"><b>${v}</b><span>${i} ${l}</span></div>`).join("");
      return;
    }
    const lv = (l) => ds.cases.filter((c) => c.level === l).length, st = (s) => ds.cases.filter((c) => c.status === s).length;
    el.innerHTML = [["em", "🚨 Emergency", lv("EMERGENCY")], ["ur", "⏱ Same day", lv("URGENT_SAME_DAY")], ["", "🗓 2-3 days / self-care", lv("PROMPT_ROUTINE") + lv("INFO_SELF_CARE")],
      ["", "🆕 Waiting", st("new")], ["", "🧰 Preparing", st("preparing") + st("seen")], ["ok", "✅ Done / ready", st("done") + st("ready")]]
      .map(([k, l, v]) => `<div class="stat ${k}"><b>${v}</b><span>${l}</span></div>`).join("");
  }
  function renderInbox(freshId) {
    $("#caseCount").textContent = ds.cases.length; renderStats();
    if (!ds.cases.length) { $("#inbox").innerHTML = `<p class="hint">Waiting for patients. Press ▶ Simulate to see how a referral arrives.</p>`; return; }
    $("#inbox").innerHTML = ds.cases.map((c) => `<button type="button" class="case-item ${esc(c.level)} ${c.id === ds.sel ? "sel" : ""} ${c.id === freshId ? "fresh" : ""}" data-id="${esc(c.id)}">
      <span><span class="st-pill ${esc(c.status)}">${esc(c.status)}</span> <b>${esc(LEVEL[c.level] || c.level)}</b> · ${esc((c.symptoms || []).slice(0, 3).join(", ") || "symptoms not recognised")}</span>
      <small>${c.patient_name ? esc(c.patient_name) + " · " : ""}${c.age != null ? "age " + esc(c.age) + " · " : ""}${esc(ds.langs[c.patient_lang] || c.patient_lang)} · <span data-ago="${esc(c.created_at)}">${ago(c.created_at)}</span>${c.sent_by && c.sent_by.role === "asha" ? " · via ASHA ✓" : ""}${c.demo ? ' <i class="demo-tag">sample</i>' : ""}</small>
      <small>→ ${esc(c.facility_name || "unassigned")}${c.slot ? " · 🗓 " + esc(new Date(c.slot).toLocaleString()) : ""}</small></button>`).join("");
    $$(".case-item").forEach((b) => b.addEventListener("click", () => { ds.sel = b.dataset.id; renderInbox(); renderDetail(ds.cases.find((c) => c.id === ds.sel)); }));
    if (!ds.sel && ds.cases[0]) { ds.sel = ds.cases[0].id; renderDetail(ds.cases[0]); $(".case-item").classList.add("sel"); }
  }
  async function setStatus(c, status) {
    try { const u = await api(`cases/${c.id}`, { method: "PATCH", body: JSON.stringify({ status }) }); Object.assign(c, u); renderInbox(); markStatus(c); }
    catch (e) { toast("Could not update: " + e.message); }
  }
  function markStatus(c) {   // update the status buttons without rebuilding the prescription form
    $$("[data-st]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.st === c.status)));
  }
  function renderDetail(c) {
    if (!c) return;
    const v = c.vitals || {};
    const statuses = [["seen", "👀 Seen"], ["preparing", "🧰 Preparing"], ["ready", "✅ Ready for patient"]];
    $("#detail").innerHTML = `<div class="inbox-head"><h2>${esc(c.title || LEVEL[c.level])}</h2><span class="lvl-pill ${esc(c.level)}">${esc(LEVEL[c.level])}</span></div>
      <p class="hint">${esc(c.id)} · <span data-ago="${esc(c.created_at)}">${ago(c.created_at)}</span>${c.demo ? ' · <i class="demo-tag">sample report</i>' : ""} · sent by ${esc(c.sent_by.role)}${c.sent_by.name ? " " + esc(c.sent_by.name) : ""}${c.sent_by.verified ? " (phone verified)" : ""}</p>
      <div class="quote" lang="${esc(c.patient_lang)}">“${esc(c.message)}”</div>
      <p class="hint">Patient's language: ${esc(ds.langs[c.patient_lang] || c.patient_lang)}. The medicine card will be shown to them in this language.</p>
      <div class="kv"><div><span>Age</span><b>${c.age ?? "–"}</b></div><div><span>Since</span><b>${c.duration_days != null ? c.duration_days + " d" : "–"}</b></div>
        <div><span>Pregnant</span><b>${c.pregnant === true ? "yes" : c.pregnant === false ? "no" : "–"}</b></div>
        ${v.spo2 != null ? `<div><span>SpO₂</span><b>${esc(v.spo2)}%</b></div>` : ""}${v.temp_c != null ? `<div><span>Temp</span><b>${esc(v.temp_c)} °C</b></div>` : ""}
        <div><span>Patient phone</span><b>${c.patient_phone ? "••••" + esc(c.patient_phone.slice(-4)) : "–"}</b></div></div>
      <p><b>Symptoms:</b> ${esc((c.symptoms || []).join(", ") || "–")}</p>
      ${c.red_flags && c.red_flags.length ? `<p class="note-box"><b>Danger signs:</b> ${esc(c.red_flags.join(", "))}</p>` : ""}
      <div class="status-row">${statuses.map(([s, l]) => `<button type="button" class="btn btn-quiet btn-sm" data-st="${s}" aria-pressed="${c.status === s}">${l}</button>`).join("")}</div>
      <h3>🧰 Get ready (suggested, use your judgement)</h3>
      <div class="prep">${(c.prep || []).map((p, i) => `<label><input type="checkbox" id="pp${i}"> ${esc(p)}</label>`).join("") || "<p class='hint'>Routine OPD</p>"}</div>
      <details class="sub"><summary>RuralPulse referral note (English)</summary><pre class="note">${esc(c.doctor_note || "")}</pre></details>
      ${c.location ? `<p class="hint">📍 Patient location: <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${c.location.lat},${c.location.lon}">open map</a></p>` : ""}
      <h3>💊 Medicine card for the patient</h3>${rxForm(c)}`;
    $$("[data-st]").forEach((b) => b.addEventListener("click", () => setStatus(c, b.dataset.st)));
    wireRx(c);
  }
  const FRAC = [["0", "0"], ["0.5", "½"], ["1", "1"], ["2", "2"]];
  function rxRow() {
    const sel = (name) => `<select data-f="${name}">${FRAC.map(([v, l]) => `<option value="${v}" ${v === (name === "afternoon" ? "0" : "1") ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    return `<div class="rx-row"><label>Medicine<input data-f="name" placeholder="e.g. Paracetamol"></label><label>Strength<input data-f="strength" placeholder="500 mg"></label>
      <label>Form<select data-f="form"><option>tablet</option><option>capsule</option><option>syrup</option><option>drops</option><option>ointment</option><option>inhaler</option><option>injection</option></select></label>
      <label>☀ Morn${sel("morning")}</label><label>🌤 Noon${sel("afternoon")}</label><label>🌙 Night${sel("night")}</label>
      <label>Food<select data-f="food"><option value="after">after food</option><option value="before">before food</option><option value="any">any time</option></select></label>
      <label>Days<input data-f="days" type="number" min="0" max="365" value="3"></label><button type="button" class="del" aria-label="Remove">×</button>
      <label style="grid-column:1/-1">Note for this medicine (translated for the patient)<input data-f="note" placeholder="e.g. only if fever is above 100°F"></label></div>`;
  }
  function rxForm(c) {
    return `<form class="rx-form" id="rxForm"><div id="rxRows">${rxRow()}</div>
      <button type="button" class="btn btn-quiet btn-sm" id="addRow">+ Add medicine</button>
      <div class="grid2"><label>Advice for the patient<textarea id="rxNotes" placeholder="Rest, drink plenty of water. Come back if the fever rises."></textarea></label>
        <label>Follow-up date<input id="rxFollow" type="date"></label>
        <label>Send to pharmacy<select id="rxPharm"><option value="">None</option>${ds.pharmacies.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label></div>
      <label class="hint" style="display:block;margin-top:8px">Patient phone for SMS link <input id="rxPhone" type="tel" value="" placeholder="${c.patient_phone ? "uses the number from the case" : "98xxxxxxxx"}"></label>
      <p class="hint">You decide medicines and doses. RuralPulse only shows them to the patient with pictures and in their language.</p>
      <button class="btn btn-ink" type="submit">Send medicine card</button><div id="rxDone"></div></form>`;
  }
  function wireRx(c) {
    const rows = $("#rxRows");
    const wireDel = () => $$(".del", rows).forEach((b) => (b.onclick = () => { if ($$(".rx-row", rows).length > 1) b.closest(".rx-row").remove(); }));
    $("#addRow").addEventListener("click", () => { rows.insertAdjacentHTML("beforeend", rxRow()); wireDel(); }); wireDel();
    $("#rxForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const items = $$(".rx-row", rows).map((r) => Object.fromEntries($$("[data-f]", r).map((i) => [i.dataset.f, i.value]))).filter((i) => i.name.trim());
      if (!items.length) { toast("Add at least one medicine"); return; }
      const ph = ds.pharmacies.find((p) => p.id === $("#rxPharm").value);
      try {
        const rx = await api("rx", { method: "POST", body: JSON.stringify({ case_id: c.id, items, notes: $("#rxNotes").value, follow_up: $("#rxFollow").value || null,
          lang: c.patient_lang, doctor: ds.user.name, facility_name: c.facility_name || ds.user.facility_name, patient_phone: $("#rxPhone").value,
          pharmacy: ph ? { key: ph.id, name: ph.name, phone: ph.phone } : {}, origin: location.origin + location.pathname.replace(/[^/]*$/, "") }) });
        const link = new URL(`rx.html?id=${rx.id}`, location.href).href;
        $("#rxDone").innerHTML = `<div class="rx-done"><b>✅ Medicine card ${esc(rx.id)} sent${ph ? " and reserved at " + esc(ph.name) : ""}.</b>
          <code>${esc(link)}</code><div class="row"><a class="btn btn-quiet btn-sm" target="_blank" href="${esc(link)}">Open card</a>
          <a class="btn btn-quiet btn-sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent("Your medicine card: " + link)}">💬 WhatsApp</a></div></div>`;
        loadOutbox();
      } catch (err) { toast("Could not send: " + err.message); }
    });
  }

  // ---------------------------------------------------------------- pharmacy
  async function loadRx() { ds.rx = (await api(`rx?pharmacy=${encodeURIComponent(ds.user.facility_key || "all")}`)).rx; ds.preview = false; $("#previewNote").hidden = true; await loadRxPreview(); renderRx(); }
  async function loadRxPreview() {
    if (ds.rx.length || !ds.user.facility_key || ds.user.facility_key === "all") return;
    ds.rx = (await api("rx?pharmacy=all")).rx; ds.preview = ds.rx.length > 0;
    $("#previewNote").hidden = !ds.preview;
    $("#previewNote").textContent = `No prescriptions for ${ds.user.facility_name || "your pharmacy"} yet, so recent ones from nearby pharmacies are shown. Press ▶ Simulate to send one here.`;
  }
  function renderRx(freshId) {
    $("#rxCount").textContent = ds.rx.length; renderStats();
    if (!ds.rx.length) { $("#rxList").innerHTML = `<p class="hint">No prescriptions yet. Press ▶ Simulate to see one arrive.</p>`; return; }
    $("#rxList").innerHTML = ds.rx.map((r) => `<div class="rx-item ${r.id === freshId ? "fresh" : ""}"><div class="inbox-head"><b>${esc(r.id)} · ${esc(r.doctor || "Doctor")} · ${esc(r.facility || "")}</b><span class="st-pill ${r.status === "ready" ? "ready" : ""}">${esc(r.status)}</span></div>
      <ul>${r.items.map((i) => `<li><b>${esc(i.name)}</b> ${esc(i.strength)} · ${esc(i.form)} · ${i.morning}-${i.afternoon}-${i.night} · ${esc(i.food)} food · ${i.days} days</li>`).join("")}</ul>
      <p class="hint"><span data-ago="${esc(r.created_at)}">${ago(r.created_at)}</span> · ${esc(r.pharmacy && r.pharmacy.name || "")} · patient language: ${esc(ds.langs[r.lang] || r.lang)}${r.demo ? ' · <i class="demo-tag">sample</i>' : ""} · <a target="_blank" href="rx.html?id=${encodeURIComponent(r.id)}">patient view ↗</a></p>
      <div class="status-row">${[["reserved", "📦 Reserved"], ["ready", "✅ Ready for pickup"], ["out_of_stock", "⚠ Out of stock"], ["collected", "🤝 Collected"]]
        .map(([s, l]) => `<button type="button" class="btn btn-quiet btn-sm" data-rx="${esc(r.id)}" data-s="${s}" aria-pressed="${r.status === s}">${l}</button>`).join("")}</div></div>`).join("");
    $$("[data-rx]").forEach((b) => b.addEventListener("click", async () => {
      try { const u = await api(`rx/${b.dataset.rx}`, { method: "PATCH", body: JSON.stringify({ status: b.dataset.s }) }); const i = ds.rx.findIndex((x) => x.id === u.id); ds.rx[i] = u; renderRx(); loadOutbox(); }
      catch (e) { toast(e.message); }
    }));
  }
  async function loadOutbox() {
    try { const m = (await api("outbox")).messages;
      $("#outbox").innerHTML = m.length ? m.map((x) => `<div class="ob"><b>${esc(x.to_number)}</b> · ${esc(x.status)} · ${esc(x.body)}</div>`).join("") : "<p class='hint'>No messages yet.</p>"; } catch (_) {}
  }

  // ---------------------------------------------------------------- live demo controls
  async function simulate() {
    const b = $("#simBtn"); b.disabled = true;
    try {
      const r = await api("demo/simulate", { method: "POST" });
      // the live stream normally delivers it; if the stream is down, add it here
      if (r.case && !ds.cases.some((c) => c.id === r.case.id)) { ds.cases.unshift(r.case); ds.sel = r.case.id; renderInbox(r.case.id); renderDetail(r.case); }
      if (r.rx && !ds.rx.some((x) => x.id === r.rx.id)) { ds.rx.unshift(r.rx); renderRx(r.rx.id); }
    } catch (e) { toast("Could not simulate: " + e.message); }
    finally { setTimeout(() => (b.disabled = false), 800); }
  }
  $("#simBtn").addEventListener("click", simulate);
  let autoT = null;
  $("#autoSim").addEventListener("change", (e) => { clearInterval(autoT); if (e.target.checked) { simulate(); autoT = setInterval(simulate, 45000); } });
  $("#resetBtn").addEventListener("click", async () => {
    if (!confirm("Delete all cases and prescriptions and load the sample reports again?")) return;
    try { await api("demo/reset", { method: "POST" }); ds.sel = null; await refresh(); toast("Sample reports loaded."); } catch (e) { toast(e.message); }
  });

  // ---------------------------------------------------------------- boot
  (async () => {
    try {
      const [fac, meta] = await Promise.all([fetch("data/facilities.json").then((r) => r.json()), fetch("api/meta").then((r) => r.json())]);
      ds.facilities = fac.facilities; ds.pharmacies = fac.pharmacies || [];
      ds.langs = Object.fromEntries(Object.entries(meta.supported_languages).map(([k, v]) => [k, `${v.native} (${v.name})`]));
      fillFacilities();
      let tok = null, user = null; try { tok = localStorage.getItem("rp.staffToken"); user = JSON.parse(localStorage.getItem("rp.staffUser") || "null"); } catch (_) {}
      if (tok && user) { ds.token = tok; ds.user = user; const me = await api("auth/me"); if (me.user) { ds.user = me.user; start(); return; } }
    } catch (_) { $("#offlineNote").hidden = false; }
  })();
})();
