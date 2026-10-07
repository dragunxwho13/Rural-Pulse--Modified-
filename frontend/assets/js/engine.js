/*
 * RuralPulse offline engine (browser).
 * A faithful port of backend/app (protocol.py, language.py, extract.py,
 * triage.py, navigation.py, summary.py, pipeline.py) driven by the SAME
 * data/protocol.json and data/facilities.json. It runs when the server is
 * unreachable or the site is deployed statically, so red-flag screening
 * and emergency instructions never depend on a network connection.
 * It never calls a language model.
 */
(function (root) {
  "use strict";
  let P = null, FDOC = null, F = [], I18N = { strings: {} }, FA = { items: {}, aliases: {} }, PREP = { items: { general: [] } };
  let DIGITS = null;
  const PUNCT = /[.,!?;:()\[\]{}"“”‘\/\\|।॥…*#_~<>؟،۔]+/g;
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const LEVELS = ["INFO_SELF_CARE", "PROMPT_ROUTINE", "URGENT_SAME_DAY", "EMERGENCY"];
  const FRESH_DAYS = 90, STALE_DAYS = 180;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);
  const fmt = (n) => (Math.round(n * 100) / 100).toString();

  function normalize(text) {
    let t = (text || "").normalize("NFC").toLowerCase().replace(/’/g, "'").replace(/`/g, "'");
    t = t.replace(/\p{Nd}/gu, (d) => { const cp = d.codePointAt(0); for (const z of DIGITS) if (cp >= z && cp <= z + 9) return String(cp - z); return d; });
    return t.replace(PUNCT, " ").replace(/\s+/g, " ").trim();
  }
  const cache = new Map();
  function compile(pattern) {
    if (cache.has(pattern)) return cache.get(pattern);
    const p = normalize(pattern);
    const rx = isAscii(p)
      ? new RegExp("(?<![a-z0-9])" + p.split(" ").map(esc).join("\\s+") + "(?![a-z0-9])")
      : new RegExp(esc(p));
    cache.set(pattern, rx);
    return rx;
  }
  const find = (p, t) => compile(p).exec(t);
  const byLenDesc = (arr) => [...arr].sort((a, b) => b.length - a.length);

  function matchConcepts(text) {
    const t = normalize(text), hits = {};
    if (!t) return hits;
    for (const [cid, c] of Object.entries(P.concepts)) {
      for (const [lang, pats] of Object.entries(c.patterns)) {
        for (const p of byLenDesc(pats)) {
          const m = find(p, t);
          if (m) { hits[cid] = { phrase: m[0], lang }; break; }
        }
        if (hits[cid]) break;
      }
    }
    return hits;
  }
  function anyPattern(patterns, text) {
    const t = normalize(text);
    for (const p of byLenDesc(patterns)) { const m = find(p, t); if (m) return [true, m[0]]; }
    return [false, ""];
  }
  function langChain(lang) {
    const sup = P.supported_languages, chain = []; let cur = lang;
    while (cur && !chain.includes(cur)) { chain.push(cur); cur = (sup[cur] || {}).fallback; }
    if (!chain.includes("en")) chain.push("en");
    return chain;
  }
  function pick(node, lang) { for (const c of langChain(lang)) if (node[c]) return node[c]; return Object.values(node)[0] || ""; }
  function pickLang(node, lang) { for (const c of langChain(lang)) if (node[c]) return c; return "en"; }
  function msg(path, lang) {
    let node = P.messages;
    for (const part of path.split(".")) node = node[part];
    return pick(node, lang);
  }
  function t(key, lang) { return pick(I18N.strings[key] || { en: key }, lang); }
  function label(cid, lang = "en") {
    const c = P.concepts[cid];
    return c ? pick(c.label, lang) : cid.replace(/_/g, " ");
  }
  function conceptLangs(text) {
    const tn = normalize(text), out = {};
    for (const c of Object.values(P.concepts)) for (const [lang, pats] of Object.entries(c.patterns)) if (pats.some((p) => find(p, tn))) out[lang] = (out[lang] || 0) + 1;
    return out;
  }

  // ------------------------------------------------------------ language
  function langResult(code, script, conf, name) {
    const info = P.supported_languages[code];
    if (!info) return { code, name: name || code, tier: "untested", supported: false, script, confidence: conf };
    let tier = info.tier;
    if (script === "latin" && !info.romanized && code !== "en") tier = "untested";
    return { code, name: name || info.name, native: info.native, tier, supported: tier === "validated" || tier === "core", script, confidence: conf };
  }
  function familyPick(base, text) {
    const family = P.script_families[base] || [base];
    for (const [code, chars] of Object.entries(P.unique_chars)) if (family.includes(code) && [...chars].some((c) => text.includes(c))) return code;
    const tokens = new Set(normalize(text).split(" "));
    const scores = {}; for (const c of family) scores[c] = (P.script_hints[c] || []).filter((w) => tokens.has(w)).length;
    for (const [c, n] of Object.entries(conceptLangs(text))) if (c in scores) scores[c] += 2 * n;
    let best = family[0];
    for (const c of family) if (scores[c] > scores[best] || (scores[c] === scores[best] && c === base)) best = c;
    return scores[best] > 0 ? best : base;
  }
  function detect(text) {
    const counts = {};
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      for (const r of P.script_ranges) {
        if (cp >= parseInt(r.from, 16) && cp <= parseInt(r.to, 16)) { counts[r.lang] = (counts[r.lang] || 0) + 1; break; }
      }
    }
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total && total >= Math.max(3, latin * 0.3)) {
      const base = Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a));
      const code = familyPick(base, text), tier = P.supported_languages[code].tier;
      return langResult(code, "native", { validated: 0.95, core: 0.85 }[tier] || 0.6);
    }
    const tokens = normalize(text).split(" ").filter(Boolean);
    const scores = {};
    for (const k of Object.keys(P.roman_hints)) scores[k] = 0;
    for (const tok of tokens) for (const [k, hints] of Object.entries(P.roman_hints)) if (hints.includes(tok)) scores[k]++;
    for (const h of Object.values(matchConcepts(text))) if (h.lang in scores) scores[h.lang] += 2;
    const max = Math.max(...Object.values(scores));
    if (!tokens.length || max === 0) return { code: "unknown", name: P.unsupported_language_names.unknown, tier: "untested", supported: false, script: "latin", confidence: 0.3 };
    let best = Object.keys(scores).reduce((a, b) => (scores[b] > scores[a] || (scores[b] === scores[a] && b === "en") ? b : a));
    if (best === "or" && scores.or >= 2 && scores.or > Math.max(scores.hi, scores.ta, scores.en))
      return { code: "or", name: P.unsupported_language_names["or-roman"], tier: "untested", supported: false, script: "latin", confidence: 0.6 };
    if (best === "or") best = ["en", "hi", "ta"].reduce((a, b) => (scores[b] > scores[a] ? b : a));
    if (best === "en") return langResult("en", "latin", 0.9);
    const r = langResult(best, "latin", 0.75); r.name += " (romanised)"; return r;
  }

  // ------------------------------------------------------------ extraction
  const alt = (words) => byLenDesc([...new Set(words)]).map((w) => normalize(w).split(" ").map(esc).join("\\s+")).join("|");
  const PREG_AFTER = /^\s*(?:pregnant|garbh|गर्भ|கர்ப்ப|karpp|karbin)/;
  function extractDuration(text) {
    const D = P.duration, t = normalize(text), nums = D.number_words;
    const unitNames = Object.keys(D.units);
    const units = unitNames.map((u) => "(" + alt(D.units[u]) + ")").join("|");
    const rx = new RegExp("(?<![a-z0-9])(\\d+(?:\\.\\d+)?|" + alt(Object.keys(nums)) + ")\\s*(?:-\\s*)?(?:" + units + ")", "g");
    let best = null, m;
    while ((m = rx.exec(t))) {
      const n = m[1];
      const val = /^\d/.test(n) ? parseFloat(n) : (nums[n] || 0);
      const unit = unitNames[[2, 3, 4].findIndex((i) => m[i] !== undefined)];
      const after = t.slice(rx.lastIndex, rx.lastIndex + 12);
      if (/^\s*(ki|ka|ke|की|का|के|old|pregnant|garbh|गर्भ|கர்ப்ப|karpp|karbin)/.test(after)) continue;
      const days = val * D.multipliers[unit];
      if (days > 0 && (best === null || days > best)) best = days;
    }
    if (best !== null) return best;
    for (const [phrase, val] of Object.entries(D.since_phrases).sort((a, b) => b[0].length - a[0].length))
      if (anyPattern([phrase], t)[0]) return val;
    return null;
  }
  function extractAge(text) {
    const A = P.age, t = normalize(text);
    let rx = new RegExp("(?:" + alt(A.prefix) + ")\\s*(?:is|:|-)?\\s*(\\d{1,3})(?!\\d)(?!\\s*(?:month|week|day|mahine|din|महीने|दिन))", "g"), m;
    while ((m = rx.exec(t))) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n <= 120 && !PREG_AFTER.test(t.slice(rx.lastIndex, rx.lastIndex + 12))) return n;
    }
    rx = new RegExp("(?<![0-9])(\\d{1,3})\\s*(?:-\\s*)?(?:" + alt(A.year_units) + ")", "g");
    while ((m = rx.exec(t))) {
      const before = t.slice(Math.max(0, m.index - 8), m.index), after = t.slice(rx.lastIndex, rx.lastIndex + 6);
      if (/(for|since|past|last)\s*$/.test(before) || /^\s*(se|से|aaga|ஆக)/.test(after)) continue;
      const n = parseInt(m[1], 10);
      if (n > 0 && n <= 120) return n;
    }
    rx = new RegExp("(?<![0-9])(\\d{1,2})\\s*(?:" + alt(A.month_units_with_marker) + ")", "g");
    while ((m = rx.exec(t))) {
      if (!PREG_AFTER.test(t.slice(rx.lastIndex, rx.lastIndex + 12))) return Math.round((parseInt(m[1], 10) / 12) * 100) / 100;
    }
    return null;
  }
  function extractSeverity(text) {
    const t = normalize(text);
    const m = /(?<![0-9])(10|[0-9])\s*(?:\/|out of|में से|il)\s*10/.exec(t);
    if (m) return parseInt(m[1], 10);
    const S = P.severity_words;
    if (anyPattern(S.high.patterns, t)[0]) return S.high.value;
    if (anyPattern(S.low.patterns, t)[0]) return S.low.value;
    return null;
  }
  function extract(text) {
    const concepts = matchConcepts(text);
    const symptoms = [], context = [], comorbid = [];
    for (const [cid, hit] of Object.entries(concepts)) {
      const c = P.concepts[cid];
      const e = { id: cid, label: label(cid), category: c.category, patient_words: hit.phrase, source: "rules" };
      (c.comorbidity ? comorbid : c.context ? context : symptoms).push(e);
    }
    const med = Object.values(P.medication_dose).some((p) => anyPattern(p, text)[0]);
    const [inj] = anyPattern(P.injection_patterns, text);
    let duration = extractDuration(text), age = extractAge(text), severity = extractSeverity(text);
    const pregnant = concepts.pregnancy || concepts.pregnancy_checkup || concepts.no_fetal_movement ? true : null;
    if (concepts.newborn && age === null) age = 0.08;
    const fs = {};
    for (const [k, v] of Object.entries({ duration_days: duration, age_years: age, severity, pregnant })) fs[k] = v !== null ? "rules" : null;
    return { concept_ids: Object.keys(concepts).sort(), symptoms, context, comorbidities: comorbid, duration_days: duration,
      age_years: age, severity, pregnant, med_dose: med, injection: inj, field_sources: fs };
  }

  // ------------------------------------------------------------ triage
  function ruleDesc(rid) {
    const r = P.rules.find((x) => x.id === rid);
    if (r) return r.desc;
    const f = P.red_flags.concat(P.numeric_red_flags).find((x) => x.id === rid);
    return f ? f.label : rid;
  }
  function redFlags(concepts, age, vitals, answers, sources) {
    const out = [];
    for (const rf of P.red_flags) {
      if (rf.requires.every((g) => g.some((c) => concepts.has(c)))) {
        const used = rf.requires.flat().filter((c) => concepts.has(c));
        const src = used.every((c) => sources[c] === "llm") ? "llm" : (sources[used[0]] || "rules");
        out.push({ id: rf.id, label: rf.label, action: rf.action, category: rf.category, service: rf.service, evidence: used, source: src });
      }
    }
    for (const rf of P.numeric_red_flags) {
      const w = rf.when; let hit = false;
      if (w.concept && concepts.has(w.concept) && age !== null && age < w.age_years_lt) hit = true;
      if (w.vital && vitals[w.vital] != null && Number(vitals[w.vital]) < w.lt) hit = true;
      if (w.answer && String(answers[w.answer] ?? "").toLowerCase() === w.eq) hit = true;
      if (hit) out.push({ id: rf.id, label: rf.label, action: rf.action, category: rf.category, service: rf.service, evidence: [], source: "rules" });
    }
    return out;
  }
  function result(level, key, fired, abstain, notes, risk, category, human) {
    const seen = new Set(), rules = [];
    for (const r of fired) if (!seen.has(r)) { seen.add(r); rules.push({ id: r, desc: ruleDesc(r) }); }
    return { level, message_key: key, rules_fired: rules, abstain_reasons: abstain, notes, risk_factors: risk, category,
      human_review: human || level === "CANNOT_DETERMINE" };
  }
  function bump(level) {
    const i = LEVELS.indexOf(level), u = LEVELS.indexOf("URGENT_SAME_DAY");
    return i < u ? LEVELS[Math.min(i + 1, u)] : level;
  }
  function decide(f) {
    const C = P.concepts; let fired = []; const notes = [], abstain = [];
    const age = f.age_years, dur = f.duration_days, sev = f.severity, sym = f.symptoms, vitals = f.vitals || {};
    const risk = [];
    if (age !== null && age < 5) risk.push("Child under 5");
    if (age !== null && age >= 65) risk.push("Age 65 or over");
    if (f.pregnant) risk.push("Pregnant");
    for (const c of f.comorbidities) risk.push(C[c] ? C[c].label.en.charAt(0).toUpperCase() + C[c].label.en.slice(1) : c);
    const flags = f.flags;
    if (flags.length) {
      const crisis = flags.some((x) => x.action === "MENTAL_HEALTH_CRISIS");
      fired = ["R-EM-RF", ...flags.map((x) => x.id)];
      if (!f.language.supported) { fired.push("R-LANG-ESC"); notes.push("Danger sign detected in a language RuralPulse has not validated. Escalating is the safe direction; a human should confirm."); }
      if (["core", "assisted"].includes(f.language.tier)) fired.push("R-LANG-DRAFT");
      const onlyCrisis = crisis && new Set(flags.map((x) => x.action)).size === 1;
      return result("EMERGENCY", onlyCrisis ? "MENTAL_HEALTH_CRISIS" : "EMERGENCY", fired, abstain, notes, risk, flags[0].category, true);
    }
    if (!f.language.supported) return result("CANNOT_DETERMINE", "CANNOT_DETERMINE", ["R-AB-LANG"], ["LANG_UNSUPPORTED"], notes, risk, "general", true);
    const real = sym.filter((s) => s !== "pregnancy_checkup");
    if (f.med_dose) {
      notes.push("Medication-dose question detected. RuralPulse does not give doses; ask a doctor, pharmacist or call 104.");
      if (!sym.length) return result("CANNOT_DETERMINE", "CANNOT_DETERMINE", ["R-AB-MED"], ["MED_DOSE"], notes, risk, "general", true);
    }
    if (!sym.length) return result("CANNOT_DETERMINE", "CANNOT_DETERMINE", ["R-AB-NOSYM"], ["NO_SYMPTOMS"], notes, risk, "general", true);
    if (age === null || dur === null) return result("CANNOT_DETERMINE", "CANNOT_DETERMINE", ["R-AB-MISSING"], ["MISSING_INFO"], notes, risk, "general", true);

    let level = null;
    if (sym.some((s) => C[s] && C[s].urgent)) { level = "URGENT_SAME_DAY"; fired.push("R-UR-FLAGGED"); }
    if (sev !== null && sev >= 7) { level = "URGENT_SAME_DAY"; fired.push("R-UR-SEV"); }
    if (sym.includes("fever") && dur >= 3) { level = "URGENT_SAME_DAY"; fired.push("R-UR-FEVER3"); }
    if (age < 5 && ["diarrhoea", "vomiting", "fever"].some((s) => sym.includes(s))) { level = "URGENT_SAME_DAY"; fired.push("R-UR-CHILD-GI"); }
    if (vitals.spo2 != null && vitals.spo2 >= 90 && vitals.spo2 <= 93) { level = "URGENT_SAME_DAY"; fired.push("R-UR-SPO2"); }
    if (vitals.temp_c != null && vitals.temp_c >= 39.5) { level = "URGENT_SAME_DAY"; fired.push("R-UR-TEMP"); }
    if (f.pregnant && real.length) { level = "URGENT_SAME_DAY"; fired.push("R-UR-PREG"); }

    let category = null;
    if (sym.length === 1 && sym[0] === "pregnancy_checkup" && level === null)
      return result("PROMPT_ROUTINE", "PROMPT_ROUTINE", ["R-RT-ANC"], abstain, notes, risk, "maternal", risk.length > 0);
    if (level === null) {
      if (sym.includes("cough") && dur >= 14) { level = "PROMPT_ROUTINE"; fired.push("R-RT-COUGH14"); category = "tb"; }
      else if (dur >= 7) { level = "PROMPT_ROUTINE"; fired.push("R-RT-LONG"); }
      else if (sym.some((s) => C[s].category === "mental")) { level = "PROMPT_ROUTINE"; fired.push("R-RT-MENTAL"); }
      else if (sym.every((s) => C[s].minor) && dur < 3 && (sev === null || sev <= 3)) { level = "INFO_SELF_CARE"; fired.push("R-IN-MINOR"); }
      else { level = "PROMPT_ROUTINE"; fired.push("R-RT-DEFAULT"); }
    } else if (sym.includes("cough") && dur >= 14) { category = "tb"; fired.push("R-RT-COUGH14"); }

    if (risk.length && (level === "INFO_SELF_CARE" || level === "PROMPT_ROUTINE")) { level = bump(level); fired.push("R-MOD-RISK"); }
    else if (risk.length) fired.push("R-MOD-RISK");

    if (category === null) {
      const ranked = [...sym].sort((a, b) => (Number(!C[a].urgent) - Number(!C[b].urgent)) || (Number(!!C[a].minor) - Number(!!C[b].minor)));
      const top = C[ranked[0]];
      if (top.urgent && ["bite", "injury"].includes(top.category)) category = top.category;
      else if (f.pregnant) category = "maternal";
      else if (age < 12) category = "pediatric";
      else category = top.category;
    }
    let human = risk.length > 0;
    if (f.language.tier === "core") { fired.push("R-LANG-DRAFT"); notes.push(`${f.language.name} uses a draft offline vocabulary. A health worker should check this result.`); human = true; }
    else if (f.language.tier === "assisted") { notes.push(`${f.language.name} was understood by the AI layer, not the offline rules. A health worker should check this result.`); human = true; }
    if (f.language.script === "latin" && (f.language.confidence ?? 1) < 0.8) notes.push("Romanised input: understanding confidence is moderate, so the patient confirmed the read-back.");
    return result(level, level, fired, abstain, notes, risk, category, human);
  }

  // ------------------------------------------------------------ navigation
  function parseAt(at) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at || "");
    if (m) return { y: +m[1], mo: +m[2], d: +m[3], hm: `${m[4]}:${m[5]}`, iso: m[0] };
    const n = new Date(), p = (x) => String(x).padStart(2, "0");
    const iso = `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}T${p(n.getHours())}:${p(n.getMinutes())}`;
    return parseAt(iso);
  }
  const dayNum = (y, mo, d) => Date.UTC(y, mo - 1, d) / 86400000;
  const weekday = (a) => (new Date(Date.UTC(a.y, a.mo - 1, a.d)).getUTCDay() + 6) % 7;
  function freshness(f, a) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.last_verified || "");
    if (!m) return { status: "UNVERIFIED", days: null, score: 0 };
    const age = dayNum(a.y, a.mo, a.d) - dayNum(+m[1], +m[2], +m[3]);
    if (age <= FRESH_DAYS) return { status: "VERIFIED", days: age, score: 1 };
    if (age <= STALE_DAYS) return { status: "STALE", days: age, score: 0.4 };
    return { status: "UNVERIFIED", days: age, score: 0 };
  }
  function openStatus(f, a) {
    const h = f.hours;
    if (h.open_24x7) return { open_now: true, text: "Open 24x7", hours: "24x7" };
    const ds = [...h.days].sort((x, y) => x - y);
    const contiguous = ds.length > 2 && ds.every((d, i) => d === ds[0] + i);
    const days = contiguous ? `${DAYS[ds[0]]}-${DAYS[ds[ds.length - 1]]}` : ds.map((d) => DAYS[d]).join(", ");
    const hours = `${days}, ${h.open}-${h.close}`, wd = weekday(a);
    if (h.days.includes(wd) && h.open <= a.hm && a.hm < h.close) return { open_now: true, text: `Open now, closes ${h.close}`, hours };
    for (let k = 0; k < 8; k++) {
      const d = (wd + k) % 7;
      if (h.days.includes(d) && (k > 0 || a.hm < h.open)) {
        const when = k === 0 ? "today" : k === 1 ? "tomorrow" : DAYS[d];
        return { open_now: false, text: `Closed now, opens ${when} ${h.open}`, hours };
      }
    }
    return { open_now: false, text: "Closed", hours };
  }
  let IDF = null, VECS = null;
  const tok = (t) => (normalize(t).match(/[a-z]+/g) || []).filter((w) => w.length > 2);
  const facText = (f) => `${f.name}. ${f.type}. Services: ${f.services.map((s) => s.replace(/_/g, " ")).join(", ")}. ${f.description}`;
  function tfidf(toks) {
    const tf = {}; for (const w of toks) tf[w] = (tf[w] || 0) + 1;
    const v = {}; let n = 0;
    for (const [w, c] of Object.entries(tf)) { v[w] = c * (IDF[w] ?? 0.5); n += v[w] * v[w]; }
    n = Math.sqrt(n) || 1; for (const w in v) v[w] /= n; return v;
  }
  function buildIndex() {
    const docs = F.map((f) => tok(facText(f))), df = {};
    for (const d of docs) for (const w of new Set(d)) df[w] = (df[w] || 0) + 1;
    IDF = {}; for (const [w, c] of Object.entries(df)) IDF[w] = Math.log((docs.length + 1) / (c + 0.5));
    VECS = docs.map(tfidf);
  }
  function relevance(query) {
    const q = tfidf(tok(query)), out = {};
    F.forEach((f, i) => { let s = 0; for (const [w, x] of Object.entries(VECS[i])) s += (q[w] || 0) * x; out[f.id] = s; });
    return out;
  }
  function card(f, fr, op, score, rel, why, langName) {
    const langOk = f.languages.some((l) => langName.toLowerCase().startsWith(l.toLowerCase()));
    return { id: f.id, name: f.name, type: f.type, level: f.level, services: f.services, distance_km: f.distance_km,
      travel_time_min: f.travel_time_min, map_xy_km: f.map_xy_km, phone: f.phone, languages: f.languages, language_match: langOk,
      referral_required: f.referral_required, wheelchair_access: f.wheelchair_access, telemedicine: f.telemedicine,
      description: f.description, open: op, freshness: fr,
      provenance: { record_id: f.id, source: f.source, authority: f.authority, last_verified: f.last_verified, verified_by: f.verified_by, conflicts: f.conflicts || [] },
      score: Math.round(score * 1000) / 1000, relevance: Math.round(rel * 1000) / 1000, why };
  }
  function navigate(level, category, flags, labels, a, langName) {
    let needs;
    if (level === "EMERGENCY") needs = { required: ["emergency"], preferred: flags.flatMap((x) => x.service).filter((s) => s !== "emergency") };
    else if (level === "CANNOT_DETERMINE") needs = { required: ["general_medicine"], preferred: ["teleconsultation"] };
    else needs = P.category_services[category] || P.category_services.general;
    const query = `${category} care for: ${labels.join(", ") || "general check-up"}. Needs ${needs.required.concat(needs.preferred).join(", ").replace(/_/g, " ")}`;
    const rel = relevance(query), maxrel = Math.max(...Object.values(rel)) || 1, maxT = Math.max(...F.map((f) => f.travel_time_min));
    const eligible = [], excluded = [];
    for (const f of F) {
      const fr = freshness(f, a), op = openStatus(f, a), svc = needs.required.filter((s) => f.services.includes(s));
      let whyNot = null;
      if (!svc.length) whyNot = `Does not list ${needs.required.join(" / ").replace(/_/g, " ")}`;
      else if (level === "EMERGENCY" && !f.hours.open_24x7) whyNot = "Not open 24x7 for emergencies";
      else if (level === "URGENT_SAME_DAY" && f.level < 2) whyNot = "Sub-centre or teleconsultation: a doctor should see this today";
      else if (level === "URGENT_SAME_DAY" && !op.open_now) whyNot = op.text;
      else if (f.type.startsWith("Teleconsultation")) whyNot = ["EMERGENCY", "URGENT_SAME_DAY"].includes(level) ? "Teleconsultation is not enough for this urgency" : "Teleconsultation is offered separately below";
      if (whyNot) { excluded.push({ id: f.id, name: f.name, reason: whyNot, freshness: fr.status }); continue; }
      const r = (rel[f.id] || 0) / maxrel;
      const pref = needs.preferred.some((s) => f.services.includes(s)) ? 1 : 0;
      const prox = 1 - f.travel_time_min / maxT;
      const langOk = f.languages.some((l) => langName.toLowerCase().startsWith(l.toLowerCase()));
      let score;
      if (level === "EMERGENCY") score = 0.55 * prox + 0.2 * pref + 0.1 * r + 0.15 * fr.score;
      else { const ideal = level === "URGENT_SAME_DAY" ? 3 : 2; score = 0.55 * prox + 0.15 * pref + 0.15 * fr.score + 0.1 * (langOk ? 1 : 0) + 0.05 * r - 0.15 * Math.max(0, f.level - ideal); }
      if (fr.status === "UNVERIFIED") score -= 0.5;
      const why = [`Offers ${svc.join(", ").replace(/_/g, " ")}`];
      if (pref) why.push(`Has preferred service: ${needs.preferred.filter((s) => f.services.includes(s)).join(", ").replace(/_/g, " ")}`);
      why.push(`${f.travel_time_min} min by road (${f.distance_km} km)`, op.text);
      if (langOk) why.push(`Staff speak ${langName.split(" ")[0]}`);
      eligible.push(card(f, fr, op, score, r, why, langName));
    }
    eligible.sort((x, y) => y.score - x.score);
    const primary = eligible.find((c) => c.freshness.status !== "UNVERIFIED") || null;
    const alternatives = eligible.filter((c) => !primary || c.id !== primary.id).slice(0, 3);
    let tele = null;
    if (["PROMPT_ROUTINE", "INFO_SELF_CARE", "CANNOT_DETERMINE"].includes(level)) {
      const t = F.find((f) => f.type.startsWith("Teleconsultation"));
      if (t) tele = card(t, freshness(t, a), openStatus(t, a), 0, 0, ["Assisted video consultation, no long travel"], langName);
    }
    const warnings = [];
    if (primary && primary.freshness.status === "STALE") warnings.push("Top match has not been verified in the last 90 days. Call before travelling.");
    if (primary && primary.provenance.conflicts.length) warnings.push("Sources disagree about this facility: " + primary.provenance.conflicts[0]);
    if (primary && primary.referral_required) warnings.push("This facility usually needs a referral letter.");
    if (!primary) warnings.push("No verified facility matches right now. Call 104 (health helpline) or ask your ASHA worker.");
    return { needs, query, retrieval: "tfidf (browser)", primary, alternatives, teleconsult: tele, excluded, warnings, assessed_at: a.iso };
  }

  // ------------------------------------------------------------ summary
  const LEVEL_EN = { EMERGENCY: "EMERGENCY - call 108", URGENT_SAME_DAY: "Same-day assessment", PROMPT_ROUTINE: "Routine visit within 2-3 days",
    INFO_SELF_CARE: "Self-care with safety-net advice", CANNOT_DETERMINE: "Not determined - routed to a human" };
  const fmtDays = (d) => d === null ? "not stated" : d === 0 ? "started today" : (d >= 14 && d % 7 === 0 ? `${d / 7} week(s)` : `${fmt(d)} day(s)`);
  function summary(message, facts, d, nav, lang, confirmed, mode) {
    const level = d.level, flags = facts.flags;
    const symLines = facts.symptom_entries.map((s) => `${label(s.id)}${s.patient_words ? ` (patient: "${s.patient_words}")` : ""}${s.source === "rules" ? "" : ` [${s.source}]`}`);
    const screen = String(facts.answers.redflag_screen ?? "").toLowerCase();
    const screenTxt = { yes: "YES - danger sign reported", no: "answered no" }[screen] || "not asked / not answered";
    const primary = nav.primary;
    const doc = {
      triage: LEVEL_EN[level], protocol: P.version, rules: d.rules_fired.map((r) => r.id), patient_words: message.trim(),
      language: facts.language.name, interpreted_symptoms: symLines.length ? symLines : ["none recognised"],
      duration: fmtDays(facts.duration_days),
      age: facts.age_years === null ? "not stated" : facts.age_years < 1 ? `${Math.round(facts.age_years * 12)} months` : `${fmt(facts.age_years)} years`,
      severity: facts.severity === null ? "not stated" : `${facts.severity}/10 (patient-rated)`,
      pregnancy: facts.pregnant === true ? "yes" : facts.pregnant === false ? "no" : "not stated",
      chronic_conditions: facts.comorbidities.length ? facts.comorbidities.map((c) => label(c)) : ["none stated"],
      vitals: facts.vitals, danger_signs: flags.length ? flags.map((x) => x.label) : ["none detected in text"],
      danger_screen_question: screenTxt, risk_factors: d.risk_factors.length ? d.risk_factors : ["none stated"],
      read_back_confirmed: !!confirmed, referred_to: primary ? `${primary.name} (${primary.id})` : "no verified match",
      intake_mode: mode === "asha" ? "ASHA / CHW assisted" : "patient self-report", notes: d.notes,
    };
    const lines = [
      `RURALPULSE REFERRAL NOTE  |  ${doc.triage}  |  ${P.version}`,
      `Patient's own words (${doc.language}): "${doc.patient_words}"`,
      "Interpreted: " + doc.interpreted_symptoms.join("; "),
      `Duration: ${doc.duration}  Age: ${doc.age}  Severity: ${doc.severity}  Pregnant: ${doc.pregnancy}`,
      "Chronic: " + doc.chronic_conditions.join(", ") + "   Risk factors: " + doc.risk_factors.join(", "),
      "Danger signs: " + doc.danger_signs.join(", ") + `   Screening question: ${screenTxt}`,
    ];
    if (Object.keys(doc.vitals).length) lines.push("Vitals (ASHA): " + Object.entries(doc.vitals).map(([k, v]) => `${k}=${v}`).join(", "));
    lines.push(`Read-back confirmed by patient: ${confirmed ? "yes" : "no"}   Intake: ${doc.intake_mode}`, "Rules fired: " + doc.rules.join(", "),
      "No diagnosis has been made. This note is navigation support only.");
    let sms = msg(`levels.${d.message_key}.title`, lang) + ". ";
    if (level === "EMERGENCY") {
      sms += `${msg("ui.call", lang)} ${d.message_key === "MENTAL_HEALTH_CRISIS" ? "14416" : "108"}.`;
      if (primary) sms += ` ${msg("ui.go_to", lang)}: ${primary.name} (${primary.phone}).`;
    } else {
      if (primary) sms += `${msg("ui.go_to", lang)}: ${primary.name}, ${primary.open.hours}, ${primary.phone}. `;
      if (nav.teleconsult) sms += `${msg("ui.teleconsult", lang)}: ${nav.teleconsult.phone}. `;
      sms += msg("ui.if_worse", lang);
    }
    let keys = ["medicines", "id", "companion", "phone"];
    if (facts.pregnant) keys.unshift("mcp_card");
    if (facts.age_years !== null && facts.age_years < 12) keys.unshift("vaccination_card");
    if (facts.symptoms.includes("dog_bite")) keys.unshift("wound_wash");
    if (["tb", "respiratory"].includes(d.category)) keys.push("old_reports");
    if (facts.comorbidities.some((c) => ["diabetes", "hypertension", "heart_disease"].includes(c))) keys.push("sugar_records");
    keys = [...new Set(keys)];
    const qk = level === "EMERGENCY" ? ["cause", "warning"] : ["cause", "warning", "medicines", "followup"];
    return { slip: buildSlip(message, facts, d, nav, lang), doctor: doc, doctor_text: lines.join("\n"),
      checklist: level === "EMERGENCY" ? [msg("checklist.companion", lang), msg("checklist.medicines", lang)] : keys.map((k) => msg(`checklist.${k}`, lang)),
      questions_for_doctor: qk.map((k) => msg(`doctor_questions.${k}`, lang)), sms: sms.trim() };
  }

  function checklistKeys(category, facts) {
    let keys = ["medicines", "id", "companion", "phone"];
    if (facts.pregnant) keys.unshift("mcp_card");
    if (facts.age_years !== null && facts.age_years < 12) keys.unshift("vaccination_card");
    if (facts.symptoms.includes("dog_bite")) keys.unshift("wound_wash");
    if (["tb", "respiratory"].includes(category)) keys.push("old_reports");
    if (facts.comorbidities.some((c) => ["diabetes", "hypertension", "heart_disease"].includes(c))) keys.push("sugar_records");
    return [...new Set(keys)];
  }
  function buildSlip(message, facts, d, nav, lang) {
    const level = d.level, key = d.message_key, primary = nav.primary;
    const labels = {};
    for (const k of ["slip_title", "patient", "age", "problem", "since", "urgency", "go_to", "bring", "ask_doctor", "danger", "none", "date", "slip_no", "not_diagnosis", "for_doctor", "years", "call"]) labels[k] = t(k, lang);
    const danger = facts.flags.map((f) => { const ev = (f.evidence || []).map((c) => label(c, lang)); return ev.length ? ev.join(", ") : f.label; });
    const age = facts.age_years;
    const qk = level === "EMERGENCY" ? ["cause", "warning"] : ["cause", "warning", "medicines", "followup"];
    return { lang, labels, urgency_level: level, urgency_title: msg(`levels.${key}.title`, lang), urgency_action: msg(`levels.${key}.action`, lang),
      problem: message.trim(), symptoms: facts.symptoms.map((s) => label(s, lang)),
      age: age === null ? null : (age < 1 ? `${Math.round(age * 12)} m` : fmt(age)),
      since: facts.duration_days === null ? "-" : msg("readback.for_days", lang).replace("{n}", fmt(facts.duration_days)),
      danger, go_to: primary ? { name: primary.name, phone: primary.phone, hours: primary.open.hours, distance_km: primary.distance_km, source: "verified directory" } : null,
      bring: level !== "EMERGENCY" ? checklistKeys(d.category, facts).map((k) => msg(`checklist.${k}`, lang)) : [msg("checklist.companion", lang)],
      ask_doctor: qk.map((k) => msg(`doctor_questions.${k}`, lang)),
      emergency_number: key === "MENTAL_HEALTH_CRISIS" ? "14416" : (["EMERGENCY", "URGENT_SAME_DAY"].includes(level) ? "108" : "104") };
  }
  function faKey(k) { return FA.items[k] ? k : (FA.aliases[k] || ""); }
  function firstAid(level, flags, symptoms, pregnant, lang) {
    let keys = [];
    if (level === "EMERGENCY") { keys = flags.map((f) => faKey(f.id)); keys.push("EMERGENCY"); }
    else {
      keys = symptoms.map(faKey);
      if (pregnant) keys.push("pregnancy");
      if (level === "CANNOT_DETERMINE" || !keys.some(Boolean)) keys.push("general");
    }
    const out = [];
    for (const k of keys) if (k && !out.includes(k)) out.push(k);
    return out.slice(0, 3).map((k) => { const it = FA.items[k];
      return { key: k, lang: pickLang(it.title, lang), title: pick(it.title, lang), do: it.do.map((x) => pick(x, lang)), dont: it.dont.map((x) => pick(x, lang)) }; });
  }
  function prepFor(flags, symptoms, pregnant) {
    const keys = flags.map((f) => f.id).concat(symptoms, pregnant ? ["pregnancy"] : []), out = [];
    for (const k of keys) for (const line of PREP.items[k] || []) if (!out.includes(line)) out.push(line);
    return out.length ? out.slice(0, 8) : PREP.items.general;
  }

  // ------------------------------------------------------------ pipeline
  const num = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
  const outLang = (pref, det) => (pref in P.supported_languages ? pref : det.code in P.supported_languages ? det.code : "en");
  const newId = (p) => p + Math.random().toString(16).slice(2, 12).toUpperCase().padEnd(10, "0");
  function fnv(s) { let h = 0x811c9dc5; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); }

  function understand(message) {
    const lang = detect(message), ex = extract(message), sources = {}, phrases = {};
    ex.concept_ids.forEach((c) => (sources[c] = "rules"));
    [...ex.symptoms, ...ex.context, ...ex.comorbidities].forEach((s) => (phrases[s.id] = s.patient_words));
    let pregnant = ex.pregnant;
    if (pregnant === null && ex.concept_ids.includes("pregnancy")) pregnant = true;
    return { language: lang, concepts: ex.concept_ids, sources, phrases, duration_days: ex.duration_days, age_years: ex.age_years,
      severity: ex.severity, pregnant, med_dose: ex.med_dose, injection: ex.injection, field_sources: ex.field_sources,
      llm: { used: false, status: "offline browser engine (no language model)", model: null } };
  }
  function facts(u, answers, vitals, symptomIds) {
    const C = P.concepts; let concepts = new Set(u.concepts); const sources = { ...u.sources };
    answers = answers || {};
    if (symptomIds) {
      const rfc = new Set(P.red_flags.flatMap((rf) => rf.requires.flat()));
      const keep = [...concepts].filter((c) => rfc.has(c) || (C[c] && (C[c].context || C[c].comorbidity)));
      symptomIds.forEach((s) => { if (C[s] && !concepts.has(s)) sources[s] = "patient-edit"; });
      concepts = new Set([...keep, ...symptomIds.filter((s) => C[s])]);
    }
    const age = num(answers.age) ?? u.age_years, dur = num(answers.duration_days) ?? u.duration_days, sev = num(answers.severity) ?? u.severity;
    let preg = u.pregnant; const pa = String(answers.pregnant ?? "").toLowerCase();
    if (pa === "yes") { preg = true; concepts.add("pregnancy"); sources.pregnancy = sources.pregnancy || "answer"; }
    else if ((pa === "no" || pa === "na") && !u.concepts.includes("pregnancy")) preg = false;
    const comorb = [...concepts].filter((c) => C[c] && C[c].comorbidity);
    if (String(answers.chronic ?? "").toLowerCase() === "yes" && !comorb.length) comorb.push("chronic illness (type not stated)");
    const symptoms = [...concepts].sort().filter((c) => C[c] && !C[c].context && !C[c].comorbidity);
    const v = {}; for (const [k, x] of Object.entries(vitals || {})) if (x !== null && x !== undefined && x !== "") v[k] = Number(x);
    const flags = redFlags(concepts, age, v, answers, sources);
    const entries = symptoms.map((s) => ({ id: s, label: label(s), patient_words: u.phrases[s] || null, source: sources[s] || "rules" }));
    return { concepts, symptoms, symptom_entries: entries, flags, language: u.language, age_years: age, duration_days: dur,
      severity: sev !== null ? Math.trunc(sev) : null, pregnant: preg, comorbidities: comorb, med_dose: u.med_dose, vitals: v, answers, injection: u.injection };
  }
  function questions(fx, lang, answers) {
    const q = [], add = (id, type, required, options) => {
      if (answers[id] !== undefined && answers[id] !== null && answers[id] !== "") return;
      q.push({ id, text: msg(`questions.${id}`, lang), type, required, options: options || null });
    };
    add("redflag_screen", "yesno", true, ["yes", "no"]);
    if (fx.age_years === null) add("age", "number", true);
    if (fx.duration_days === null) add("duration_days", "number", true);
    if (fx.severity === null) add("severity", "scale", false);
    if (fx.pregnant === null && (fx.age_years === null || (fx.age_years >= 12 && fx.age_years <= 50))) add("pregnant", "yesno", false, ["yes", "no", "na"]);
    if (!fx.comorbidities.length) add("chronic", "yesno", false, ["yes", "no"]);
    return q;
  }
  function readback(message, fx, lang) {
    const parts = fx.symptoms.map((s) => label(s, lang));
    if (fx.pregnant) parts.push(label("pregnancy", lang));
    if (fx.duration_days !== null) parts.push(msg("readback.for_days", lang).replace("{n}", fmt(fx.duration_days)));
    if (fx.age_years !== null) parts.push(msg("readback.age", lang).replace("{n}", fmt(fx.age_years)));
    const understood = fx.symptoms.length ? parts.join(", ") : msg("readback.nothing", lang);
    return `${msg("readback.you_said", lang)}: “${message.trim()}”. ${msg("readback.understood", lang)}: ${understood}. ${msg("readback.correct", lang)}`;
  }
  function publicInterp(u, fx) {
    return { language: fx.language, symptoms: fx.symptom_entries, red_flags: fx.flags.map((f) => ({ id: f.id, label: f.label, source: f.source })),
      age_years: fx.age_years, duration_days: fx.duration_days, severity: fx.severity, pregnant: fx.pregnant, comorbidities: fx.comorbidities,
      med_dose: fx.med_dose, injection_detected: fx.injection, field_sources: u.field_sources, llm: u.llm };
  }
  function fullResult(message, u, fx, lang, mode, a, confirmed, consent, stage) {
    const d = decide(fx);
    const langName = (P.supported_languages[lang] || {}).name || "English";
    const nav = navigate(d.level, d.category, fx.flags, fx.symptoms.map((s) => label(s)), a, langName);
    const summ = summary(message, fx, d, nav, lang, confirmed, mode);
    const fa = firstAid(d.level, fx.flags, fx.symptoms, !!fx.pregnant, lang);
    const prep = prepFor(fx.flags, fx.symptoms, !!fx.pregnant);
    if (fx.injection) { d.notes.push("Instruction-like text was found in the message and ignored. Rules ran on the raw text."); d.rules_fired.push({ id: "SEC-INJ", desc: "Prompt-injection pattern detected and ignored" }); }
    const used = [nav.primary, ...nav.alternatives, nav.teleconsult].filter(Boolean);
    const aid = newId("RP-");
    const audit = { assessment_id: aid, engine: "browser-offline", protocol_version: P.version, level: d.level,
      rules_fired: d.rules_fired.map((r) => r.id), llm: { used: false, status: u.llm.status, model: null }, retrieval: nav.retrieval,
      language: fx.language.code, mode, read_back_confirmed: !!confirmed,
      facility_records: used.map((c) => ({ id: c.id, last_verified: c.provenance.last_verified, status: c.freshness.status })),
      field_sources: u.field_sources, created_at: new Date().toISOString(), input_fnv32: fnv(message), raw_text_stored: false,
      logged: false, note: "Offline mode keeps nothing: this record exists only on this screen." };
    const key = d.message_key;
    return { stage, assessment_id: aid, urgency: { level: d.level, key, title: msg(`levels.${key}.title`, lang), action: msg(`levels.${key}.action`, lang) },
      decision: { ...d, abstain_text: d.abstain_reasons.map((r) => msg(`abstain_reasons.${r}`, lang)) },
      interpretation: publicInterp(u, fx), navigation: nav, summary: summ, language_out: lang, first_aid: fa, clinician_prep: prep,
      category: d.category, needs: nav.needs, emergency_numbers: P.emergency_numbers, audit };
  }
  const memo = new Map();
  function interpret(req) {
    const u = understand(req.message), fx = facts(u, req.answers || {}, req.vitals || {});
    const lang = outLang(req.language || "auto", u.language), a = parseAt(req.at_time);
    if (fx.flags.length) return fullResult(req.message, u, fx, lang, req.mode || "patient", a, false, false, "emergency");
    const iid = newId("IN-"); memo.set(iid, { message: req.message, u });
    return { stage: "confirm", interpretation_id: iid, language_out: lang, readback: readback(req.message, fx, lang),
      questions: questions(fx, lang, req.answers || {}), interpretation: publicInterp(u, fx),
      symptom_options: Object.entries(P.concepts).filter(([, c]) => !c.context && !c.comorbidity).map(([id]) => ({ id, label: label(id, lang) })) };
  }
  function assess(req) {
    const m = memo.get(req.interpretation_id || "");
    const u = m && m.message === req.message ? m.u : understand(req.message);
    const fx = facts(u, req.answers || {}, req.vitals || {}, req.symptom_ids || null);
    const lang = outLang(req.language || "auto", u.language);
    return fullResult(req.message, u, fx, lang, req.mode || "patient", parseAt(req.at_time), !!req.confirmed, false, fx.flags.length ? "emergency" : "result");
  }
  function runSuite(suite) {
    const ORDER = { INFO_SELF_CARE: 0, PROMPT_ROUTINE: 1, URGENT_SAME_DAY: 2, EMERGENCY: 3 };
    const rows = suite.cases.map((v) => {
      const base = { message: v.message, language: v.language || "auto", mode: v.mode || "patient", answers: v.answers || {}, vitals: v.vitals || {}, at_time: v.at_time || "2026-10-07T11:00" };
      let r = interpret(base);
      if (r.stage === "confirm") r = assess({ ...base, interpretation_id: r.interpretation_id, confirmed: true });
      return { id: v.id, group: v.group, lang: v.lang || "en", message: v.message, expected: v.expected, got: r.urgency.level,
        facility: (r.navigation.primary || {}).id || null, expected_facility: v.expected_facility || null, rules: r.decision.rules_fired.map((x) => x.id), note: v.note || "" };
    });
    const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
    const em = rows.filter((r) => r.expected === "EMERGENCY"), graded = rows.filter((r) => r.expected in ORDER);
    const under = [], over = []; let sevW = 0;
    for (const r of graded) {
      if (r.got === "CANNOT_DETERMINE") continue;
      const diff = ORDER[r.got] - ORDER[r.expected];
      if (diff < 0) { under.push(r); sevW += -diff * (1 + ORDER[r.expected]); } else if (diff > 0) over.push(r);
    }
    const abstE = rows.filter((r) => r.expected === "CANNOT_DETERMINE"), nav = rows.filter((r) => r.expected_facility);
    const group = (key) => { const o = {}; for (const r of rows) { o[r[key]] = o[r[key]] || [0, 0]; o[r[key]][0]++; o[r[key]][1] += r.got === r.expected; }
      return Object.fromEntries(Object.entries(o).sort().map(([k, [a, b]]) => [k, { n: a, exact_pct: pct(b, a) }])); };
    return { suite: suite.name, suite_status: suite.status, n_cases: rows.length, engine: "browser-offline",
      metrics: { exact_match_pct: pct(rows.filter((r) => r.got === r.expected).length, rows.length), red_flag_sensitivity_pct: pct(em.filter((r) => r.got === "EMERGENCY").length, em.length),
        under_triage_pct: pct(under.length, graded.length), severity_weighted_under_triage: sevW, over_triage_pct: pct(over.length, graded.length),
        abstention_rate_pct: pct(rows.filter((r) => r.got === "CANNOT_DETERMINE").length, rows.length),
        correct_abstention_pct: pct(abstE.filter((r) => r.got === "CANNOT_DETERMINE").length, abstE.length),
        facility_match_pct: pct(nav.filter((r) => r.facility === r.expected_facility).length, nav.length) },
      by_language: group("lang"), by_group: group("group"),
      under_triaged: under.map((r) => ({ id: r.id, expected: r.expected, got: r.got, note: r.note })),
      over_triaged: over.map((r) => ({ id: r.id, expected: r.expected, got: r.got, note: r.note })), cases: rows };
  }
  function facilitiesView(at) {
    const a = parseAt(at);
    return { dataset: FDOC.dataset, note: FDOC.note, facilities: F.map((f) => ({ ...f, freshness: freshness(f, a), open: openStatus(f, a) })) };
  }
  function init(protocol, facilitiesDoc, extra = {}) {
    P = protocol; FDOC = facilitiesDoc; F = facilitiesDoc.facilities;
    DIGITS = P.native_digit_zeros.map((z) => parseInt(z, 16));
    if (extra.i18n) I18N = extra.i18n;
    if (extra.firstAid) FA = extra.firstAid;
    if (extra.prep) PREP = extra.prep;
    buildIndex();
  }
  function screenEmergency(text) { // instant, keystroke-level red-flag check
    if (!P) return [];
    const c = new Set(Object.keys(matchConcepts(text)));
    return P.red_flags.filter((rf) => rf.requires.every((g) => g.some((x) => c.has(x)))).map((rf) => ({ id: rf.id, label: rf.label, action: rf.action }));
  }
  const api = { init, interpret, assess, runSuite, facilitiesView, screenEmergency, detect, extract, normalize, t, msg, label, pick, langChain,
    firstAid, get protocol() { return P; }, get i18n() { return I18N; } };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.RPEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
