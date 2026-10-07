/* Patient medicine card: the doctor's prescription shown with pictures
 * (sun / afternoon / moon, before or after food), in the patient's language,
 * read aloud, with phone reminders (.ics alarms that work on any calendar app)
 * and the pharmacy's live "ready for pickup" status. */
(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const S = window.RPSlip, esc = S.esc;
  const id = new URLSearchParams(location.search).get("id");
  let P = null, I18N = null, rx = null, lang = new URLSearchParams(location.search).get("lang") || "";
  const FORM_ICON = { tablet: "💊", capsule: "💊", syrup: "🧴", drops: "💧", ointment: "🧴", inhaler: "🌬️", injection: "💉" };
  const TIMES = [["morning", "☀️", "08:00"], ["afternoon", "🌤️", "13:00"], ["night", "🌙", "20:00"]];
  function chain(l) { const out = []; let c = l; while (c && !out.includes(c)) { out.push(c); c = (P.supported_languages[c] || {}).fallback; } if (!out.includes("en")) out.push("en"); return out; }
  const t = (k) => { const n = I18N.strings[k] || { en: k }; for (const c of chain(lang)) if (n[c]) return n[c]; return k; };
  const frac = (n) => (n === 0.5 ? "½" : n === 1.5 ? "1½" : String(n));
  let toastT; const toast = (m) => { const el = $("#toast"); el.textContent = m; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 4000); };

  async function load() {
    [P, I18N] = await Promise.all([fetch("data/protocol.json").then((r) => r.json()), fetch("data/i18n.json").then((r) => r.json())]);
    if (!id) {   // no card id: show sample cards so the page is never empty
      $("#rxPage").innerHTML = `<div class="card"><h1>💊 Medicine cards</h1><p class="hint">Patients open their own card from the SMS or WhatsApp link the doctor sends. Sample cards:</p>
        <div class="row">${[["RX-DEMO1", "தமிழ் · fever"], ["RX-DEMO2", "हिन्दी · dog bite vaccine"], ["RX-DEMO3", "اردو · child diarrhoea"]]
          .map(([r, l]) => `<a class="btn btn-quiet" href="rx.html?id=${r}">${esc(l)}</a>`).join("")}</div></div>`;
      return;
    }
    const first = await fetch(`api/rx/${encodeURIComponent(id)}`);
    if (!first.ok) { $("#rxPage").innerHTML = "<p>Medicine card not found. Ask your doctor or ASHA.</p>"; return; }
    rx = await first.json();
    lang = lang || rx.lang || "en";
    $("#rxLang").innerHTML = Object.entries(P.supported_languages).map(([k, v]) => `<option value="${k}" ${k === lang ? "selected" : ""}>${esc(v.native)}</option>`).join("");
    $("#rxLang").addEventListener("change", async (e) => { lang = e.target.value; const r = await fetch(`api/rx/${encodeURIComponent(id)}?lang=${lang}`); if (r.ok) rx = await r.json(); render(); });
    if (lang !== "en" && !(rx.translations || {})[lang]) { const r = await fetch(`api/rx/${encodeURIComponent(id)}?lang=${lang}`); if (r.ok) rx = await r.json(); }
    render(); watch();
  }
  function tr() { return (rx.translations || {})[lang] || null; }
  function sentence(i, k) {
    const parts = [`${i.name} ${i.strength || ""}`];
    for (const [key] of TIMES) if (i[key] > 0) parts.push(`${t(key)}: ${frac(i[key])}`);
    if (i.food !== "any") parts.push(t(i.food === "before" ? "before_food" : "after_food"));
    if (i.days) parts.push(t("for_days").replace("{n}", i.days));
    const note = tr() ? (tr().item_notes || [])[k] : i.note;
    if (note) parts.push(note);
    return parts.join(". ");
  }
  function render() {
    S.ensureFont(lang);
    document.documentElement.lang = lang; document.documentElement.dir = S.RTL.has(lang) ? "rtl" : "ltr";
    const notes = tr() ? tr().notes : rx.notes, translated = !!tr() || lang === "en";
    const ph = rx.pharmacy || {};
    $("#rxPage").innerHTML = `<div class="rx-head"><h1>💊 ${esc(t("rx_title"))}</h1><p>${esc(t("doctor"))}: <b>${esc(rx.doctor || "-")}</b> · ${esc(rx.facility || "")} · ${esc(new Date(rx.created_at).toLocaleDateString())}</p>
      <p>${esc(t("rx_only_doctor"))}</p></div>
      ${rx.items.map((i, k) => `<div class="med"><div class="pill">${FORM_ICON[i.form] || "💊"}</div><div>
        <h3>${esc(i.name)} <span class="strength">${esc(i.strength)}</span></h3>
        <div class="times">${TIMES.map(([key, ico]) => `<div class="${i[key] > 0 ? "on" : ""}"><span class="ico">${ico}</span><span class="n">${i[key] > 0 ? frac(i[key]) : "–"}</span><small>${esc(t(key))}</small></div>`).join("")}</div>
        ${i.food !== "any" ? `<span class="food">🍽 ${esc(t(i.food === "before" ? "before_food" : "after_food"))}</span>` : ""}${i.days ? `<span class="food">📅 ${esc(t("for_days").replace("{n}", i.days))}</span>` : ""}
        ${(tr() ? (tr().item_notes || [])[k] : i.note) ? `<p>${esc(tr() ? tr().item_notes[k] : i.note)}</p>` : ""}
        <button type="button" class="listen" data-say="${k}">🔊 ${esc(t("listen"))}</button></div></div>`).join("")}
      ${notes ? `<div class="card"><b>${esc(t("rx_note"))}</b><p>${esc(notes)}</p>${!translated ? `<p class="hint">(${esc(P.supported_languages[lang].name)} translation needs the online AI service; showing the doctor's words.)</p>` : ""}</div>` : ""}
      ${rx.follow_up ? `<p class="food" style="margin-top:12px">🗓 ${esc(t("follow_up"))}: ${esc(new Date(rx.follow_up).toLocaleDateString())}</p>` : ""}
      ${ph.name ? `<div class="card" style="margin-top:12px"><b>${esc(t("ready_at"))}:</b> ${esc(ph.name)}<p id="phStatus" class="hint">${esc(statusText(rx.status))}</p></div>` : ""}
      <div class="row"><button class="btn btn-ink" type="button" id="sayAll">🔊 ${esc(t("listen"))}</button><button class="btn btn-quiet" type="button" id="ics">⏰ ${esc(t("reminder"))}</button><button class="btn btn-quiet" type="button" id="printRx">🖨 ${esc(t("print"))}</button></div>
      <p class="hint" style="margin-top:16px">${esc(rx.id)} · 108 · 104</p>`;
    document.querySelectorAll("[data-say]").forEach((b) => b.addEventListener("click", () => speak(sentence(rx.items[+b.dataset.say], +b.dataset.say))));
    $("#sayAll").addEventListener("click", () => speak(rx.items.map(sentence).join(". ") + (notes ? ". " + notes : "")));
    $("#ics").addEventListener("click", downloadICS);
    $("#printRx").addEventListener("click", () => S.print(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><link rel="stylesheet" href="${new URL("assets/css/styles.css", location.href)}"><link rel="stylesheet" href="${new URL("assets/css/dashboard.css", location.href)}"><link rel="stylesheet" href="${S.fontHref(lang)}"><style>@page{size:A4;margin:12mm}body{background:#fff}.row,.listen,button{display:none!important}</style></head><body><main class="rx-page">${$("#rxPage").innerHTML}</main></body></html>`));
  }
  function statusText(s) { return ({ sent: "Sent to pharmacy", reserved: "📦 Reserved for you", ready: "✅ Ready for pickup", collected: "Collected", out_of_stock: "⚠ Out of stock: ask your doctor" })[s] || ""; }
  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const code = (P.supported_languages[lang] || {}).speech || "en-IN", v = speechSynthesis.getVoices().find((x) => x.lang === code || x.lang.startsWith(code.slice(0, 2)));
    if (!v && lang !== "en") toast("This phone has no voice for this language.");
    const u = new SpeechSynthesisUtterance(text); u.lang = code; if (v) u.voice = v; u.rate = 0.9; speechSynthesis.speak(u);
  }
  function downloadICS() {
    const pad = (n) => String(n).padStart(2, "0"), d0 = new Date(); d0.setDate(d0.getDate() + (new Date().getHours() >= 20 ? 1 : 0));
    const ymd = `${d0.getFullYear()}${pad(d0.getMonth() + 1)}${pad(d0.getDate())}`, stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const ev = [];
    rx.items.forEach((i, k) => TIMES.forEach(([key, ico, hm]) => {
      if (!(i[key] > 0)) return;
      const title = `${ico} ${i.name} ${i.strength || ""} · ${frac(i[key])} · ${t(i.food === "before" ? "before_food" : "after_food")}`.replace(/[,;]/g, " ");
      ev.push(["BEGIN:VEVENT", `UID:${rx.id}-${k}-${key}@ruralpulse`, `DTSTAMP:${stamp}`, `DTSTART:${ymd}T${hm.replace(":", "")}00`, "DURATION:PT10M",
        `RRULE:FREQ=DAILY;COUNT=${Math.max(1, i.days || 1)}`, `SUMMARY:${title}`, "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${title}`, "TRIGGER:PT0M", "END:VALARM", "END:VEVENT"].join("\r\n"));
    }));
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//RuralPulse//Medicine card//EN", ...ev, "END:VCALENDAR"].join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" })); a.download = `${rx.id}-reminders.ics`; a.click();
  }
  function watch() {
    if (!(rx.pharmacy || {}).name) return;
    const es = new EventSource(`api/events?facility=rx:${encodeURIComponent(id)}`);
    es.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d.rx) { rx.status = d.rx.status; const el = $("#phStatus"); if (el) el.textContent = statusText(rx.status); if (rx.status === "ready") toast(statusText("ready")); } } catch (_) {} };
  }
  load().catch(() => { $("#rxPage").innerHTML = "<p>Could not load the medicine card. Check your connection.</p>"; });
})();
