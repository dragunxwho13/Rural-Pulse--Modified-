/* RuralPulse visit slip: a one-page, prescription-style template in the
 * patient's language (plus a short English block for the doctor).
 * The same HTML is used for the on-screen preview (iframe) and for printing,
 * so what you see is exactly what prints: one A4/A5 page, no blank pages. */
(function (root) {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const FONTS = { hi: "Noto Sans Devanagari", mr: "Noto Sans Devanagari", ne: "Noto Sans Devanagari", mai: "Noto Sans Devanagari", kok: "Noto Sans Devanagari",
    doi: "Noto Sans Devanagari", brx: "Noto Sans Devanagari", sa: "Noto Sans Devanagari", ta: "Noto Sans Tamil", bn: "Noto Sans Bengali", as: "Noto Sans Bengali",
    te: "Noto Sans Telugu", kn: "Noto Sans Kannada", ml: "Noto Sans Malayalam", pa: "Noto Sans Gurmukhi", gu: "Noto Sans Gujarati", or: "Noto Sans Oriya",
    ur: "Noto Nastaliq Urdu", ks: "Noto Nastaliq Urdu", sd: "Noto Naskh Arabic", sat: "Noto Sans Ol Chiki", mni: "Noto Sans Meetei Mayek" };
  const RTL = new Set(["ur", "ks", "sd"]);
  function fontFamily(lang) { return FONTS[lang] || "Noto Sans"; }
  function fontHref(lang) {
    const fams = ["Noto Sans:wght@400;700"]; const f = FONTS[lang];
    if (f) fams.push(`${f}:wght@400;700`);
    return "https://fonts.googleapis.com/css2?" + fams.map((x) => "family=" + x.replace(/ /g, "+")).join("&") + "&display=swap";
  }
  function ensureFont(lang) {          // load the script font only when that language is chosen (saves data)
    if (!FONTS[lang] || typeof document === "undefined") return;
    const id = "font-" + lang;
    if (document.getElementById(id)) return;
    const l = document.createElement("link"); l.id = id; l.rel = "stylesheet"; l.href = fontHref(lang); document.head.appendChild(l);
  }
  const COLORS = { EMERGENCY: "#D93A3A", MENTAL_HEALTH_CRISIS: "#A13A6B", URGENT_SAME_DAY: "#E8771E", PROMPT_ROUTINE: "#2C7FB8", INFO_SELF_CARE: "#3E9B6E", CANNOT_DETERMINE: "#7C6FD0" };

  /* slip: from engine/server summary.slip, optionally with go_to overridden by the place chosen on the map.
     extra: { id, date, doctorText, levelKey, patientName } */
  function slipHTML(slip, extra = {}) {
    const L = slip.labels, lang = slip.lang, dir = RTL.has(lang) ? "rtl" : "ltr";
    const color = COLORS[extra.levelKey || slip.urgency_level] || "#17262B";
    const g = slip.go_to;
    const li = (arr) => arr.map((x) => `<li>${esc(x)}</li>`).join("");
    const doctorText = (extra.doctorText || "").split("\n").slice(0, 9).join("\n");
    return `<!doctype html><html lang="${esc(lang)}" dir="${dir}"><head><meta charset="utf-8"><title>${esc(L.slip_title)}</title>
<link rel="stylesheet" href="${fontHref(lang)}">
<style>
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "${fontFamily(lang)}", "Noto Sans", system-ui, sans-serif; color: #17262B; font-size: 12.5pt; line-height: 1.4; background: #fff; }
.page { max-width: 180mm; margin: 0 auto; padding: 6mm 4mm; }
.head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #0F2A2E; padding-bottom: 6px; }
.brand { font-family: "Noto Sans", sans-serif; font-weight: 700; font-size: 11pt; color: #0F2A2E; letter-spacing: .02em; }
.brand b { color: #C98612; }
h1 { font-size: 19pt; margin: 2px 0 0; }
.meta { text-align: end; font-size: 9.5pt; color: #4A5D62; }
.urg { margin: 10px 0; border-radius: 8px; border: 2px solid ${color}; overflow: hidden; }
.urg .t { background: ${color}; color: #fff; padding: 7px 12px; font-weight: 700; font-size: 14pt; display: flex; justify-content: space-between; gap: 10px; }
.urg .t span { font-size: 15pt; }
.urg .a { padding: 7px 12px; font-size: 11.5pt; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid #C9D6D0; border-radius: 8px; }
.grid div { padding: 6px 10px; border-inline-end: 1px solid #C9D6D0; } .grid div:last-child { border: 0; }
.lbl { font-size: 8.5pt; color: #4A5D62; text-transform: uppercase; letter-spacing: .04em; display: block; }
.val { font-weight: 700; font-size: 12.5pt; }
.box { margin-top: 9px; }
.quote { border-inline-start: 4px solid #F4B23E; background: #FBF7EC; padding: 6px 10px; border-radius: 0 6px 6px 0; font-size: 12.5pt; }
.chips { margin-top: 4px; } .chips span { display: inline-block; border: 1px solid #9FB3AB; border-radius: 99px; padding: 1px 9px; margin: 2px 4px 2px 0; font-size: 10.5pt; }
.danger { color: #A42828; font-weight: 700; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 9px; }
ul.ck { list-style: none; padding: 0; margin: 4px 0 0; } ul.ck li { padding-inline-start: 20px; position: relative; margin-bottom: 3px; font-size: 11pt; }
ul.ck li::before { content: "☐"; position: absolute; inset-inline-start: 0; }
ol { margin: 4px 0 0; padding-inline-start: 18px; font-size: 11pt; } ol li { margin-bottom: 3px; }
.goto { border: 1.5px solid #0F2A2E; border-radius: 8px; padding: 7px 12px; }
.goto b { font-size: 13.5pt; } .goto small { color: #4A5D62; display: block; font-size: 9.5pt; }
.doc { margin-top: 10px; border-top: 1.5px dashed #9FB3AB; padding-top: 6px; font-family: "Noto Sans", sans-serif; direction: ltr; text-align: left; }
.doc pre { white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 8.5pt; margin: 3px 0 0; color: #33454A; }
.foot { margin-top: 10px; border-top: 1px solid #C9D6D0; padding-top: 6px; font-size: 9.5pt; color: #4A5D62; display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.foot b { color: #17262B; }
.sign { margin-top: 12px; display: flex; justify-content: space-between; font-size: 9.5pt; color: #4A5D62; }
.sign span { border-top: 1px solid #9FB3AB; padding-top: 3px; min-width: 45mm; text-align: center; }
@media print { .page { padding: 0; } }
</style></head><body><div class="page">
<div class="head"><div><div class="brand">✚ Rural<b>Pulse</b></div><h1>${esc(L.slip_title)}</h1></div>
<div class="meta">${esc(L.slip_no)}: <b>${esc(extra.id || "-")}</b><br>${esc(L.date)}: ${esc(extra.date || new Date().toLocaleDateString("en-IN"))}</div></div>
<div class="urg"><div class="t"><div>${esc(L.urgency)}: ${esc(slip.urgency_title)}</div><span>☎ ${esc(slip.emergency_number)}</span></div><div class="a">${esc(slip.urgency_action)}</div></div>
<div class="grid"><div><span class="lbl">${esc(L.patient)}</span><span class="val">${esc(extra.patientName || "—")}</span></div>
<div><span class="lbl">${esc(L.age)}</span><span class="val">${esc(slip.age ?? "—")}</span></div>
<div><span class="lbl">${esc(L.since)}</span><span class="val">${esc(slip.since)}</span></div></div>
<div class="box"><span class="lbl">${esc(L.problem)}</span><div class="quote">“${esc(slip.problem)}”</div>
${slip.symptoms.length ? `<div class="chips">${slip.symptoms.map((s) => `<span>${esc(s)}</span>`).join("")}</div>` : ""}</div>
<div class="box"><span class="lbl">${esc(L.danger)}</span><div class="${slip.danger.length ? "danger" : ""}">${slip.danger.length ? esc(slip.danger.join(" · ")) : esc(L.none)}</div></div>
${g ? `<div class="box"><span class="lbl">${esc(L.go_to)}</span><div class="goto"><b>${esc(g.name)}</b>${g.phone ? ` · ☎ ${esc(g.phone)}` : ""}${g.distance_km != null ? ` · ${esc(g.distance_km)} km` : ""}
<small>${esc([g.hours, g.address, g.source].filter(Boolean).join(" · "))}</small></div></div>` : ""}
<div class="two"><div><span class="lbl">${esc(L.bring)}</span><ul class="ck">${li(slip.bring.slice(0, 6))}</ul></div>
<div><span class="lbl">${esc(L.ask_doctor)}</span><ol>${li(slip.ask_doctor.slice(0, 4))}</ol></div></div>
${doctorText ? `<div class="doc"><span class="lbl">${esc(L.for_doctor)} (English)</span><pre>${esc(doctorText)}</pre></div>` : ""}
<div class="sign"><span>ASHA / Health worker</span><span>Doctor</span></div>
<div class="foot"><div>${esc(L.not_diagnosis)}</div><div><b>108</b> Ambulance · <b>104</b> Helpline · <b>14416</b> Tele-MANAS</div></div>
</div></body></html>`;
  }

  function preview(container, html) {
    container.innerHTML = "";
    const f = document.createElement("iframe");
    f.title = "Visit slip preview"; f.setAttribute("loading", "lazy");
    f.srcdoc = html; container.appendChild(f);
    return f;
  }
  /* Print through a hidden iframe so only the slip prints (no blank pages from the rest of the site). */
  function print(html) {
    const f = document.createElement("iframe");
    Object.assign(f.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
    f.srcdoc = html; document.body.appendChild(f);
    f.onload = async () => {
      try { await f.contentDocument.fonts.ready; } catch (_) {}
      setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 2000); }, 250);
    };
  }
  function shareText(slip, extra = {}) {
    const L = slip.labels, g = slip.go_to;
    const lines = [`${L.slip_title} ${extra.id ? "(" + extra.id + ")" : ""}`.trim(), `${L.urgency}: ${slip.urgency_title}`, slip.urgency_action,
      `${L.problem}: "${slip.problem}"`];
    if (slip.age) lines.push(`${L.age}: ${slip.age} · ${L.since}: ${slip.since}`);
    if (slip.danger.length) lines.push(`${L.danger}: ${slip.danger.join(", ")}`);
    if (g) lines.push(`${L.go_to}: ${g.name}${g.phone ? " ☎ " + g.phone : ""}${g.map ? " " + g.map : ""}`);
    lines.push("108 · 104 · 14416");
    return lines.join("\n");
  }
  const api = { slipHTML, preview, print, shareText, fontFamily, fontHref, ensureFont, esc, RTL };
  root.RPSlip = api;
})(typeof window !== "undefined" ? window : globalThis);
