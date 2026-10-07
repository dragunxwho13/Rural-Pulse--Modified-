/* Voice assistant that understands and answers in the language the person speaks.
 *
 * Mode "live"  (Gemini key on the server): real-time natural voice via the Gemini Live API.
 *              The native-audio model hears any language and is told to answer in the same one.
 * Mode "turn"  (Gemini key, Live not available on that key): any-language turns. The mic is
 *              recorded until the person stops talking, Gemini detects the language, transcribes
 *              and replies in that language; the phone speaks it (or Gemini TTS when the phone has
 *              no voice for that language).
 * Mode "basic" (offline / no key): the browser's speech recogniser in the language picked in
 *              the sheet (the browser cannot auto-detect). A guided, rules-only conversation:
 *              understand -> read back -> ask the must-ask questions -> verdict + first aid, all
 *              in that language.
 * In every mode the red-flag rules check every word and show the 108 / 14416 banner at once. */
(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const A = () => window.RPApp, E = () => window.RPEngine, esc = (s) => window.RPSlip.esc(s);
  const sheet = $("#voiceSheet"), orb = $("#orb");
  const vs = { ws: null, ctxIn: null, ctxOut: null, stream: null, node: null, src: null, nextTime: 0, playing: [], mode: null, said: "",
    history: [], rec: null, busy: false, speaking: false, lastLang: null, flow: null, fired: new Set() };

  const WORKLET = `class Cap extends AudioWorkletProcessor{constructor(){super();this.buf=new Int16Array(1600);this.n=0;}
  process(i){const ch=i[0]&&i[0][0];if(!ch)return true;let peak=0;for(let k=0;k<ch.length;k++){const s=Math.max(-1,Math.min(1,ch[k]));peak=Math.max(peak,Math.abs(s));
  this.buf[this.n++]=s<0?s*0x8000:s*0x7FFF;if(this.n===this.buf.length){this.port.postMessage({pcm:this.buf.buffer.slice(0),peak});this.n=0;}}return true;}}
  registerProcessor('rp-cap',Cap);`;

  const sup = () => E().protocol.supported_languages;
  // Voice languages: English, Hindi, Tamil (browser speech, no API key). Gemini any-language voice only if the server enables it.
  const VOICE_LANGS = () => ((A().state.meta || {}).voice_langs || ["en", "hi", "ta"]).filter((c) => sup()[c]);
  const aiVoice = () => { const app = A(); return !!(app.state.server && app.state.llm && (app.state.meta || {}).voice_ai); };
  const langName = (code) => { const b = (code || "").split("-")[0]; const i = sup()[b]; return i ? `${i.native} · ${i.name}` : code; };
  function status(s) { $("#voiceStatus").textContent = s; }
  function setMode(m, label) { vs.mode = m; $("#voiceMode").textContent = label; $("#voiceLangRow").hidden = m !== "basic"; }
  function bubble(who, text, append, tag) {
    const tr = $("#transcript");
    let last = tr.lastElementChild;
    if (append && last && last.classList.contains(who) && !last.dataset.done) last.firstChild.textContent += text;
    else {
      last = document.createElement("div"); last.className = "bubble " + who;
      last.appendChild(document.createTextNode(text));
      tr.appendChild(last);
    }
    if (tag) { const s = document.createElement("small"); s.textContent = tag; last.appendChild(s); }
    tr.scrollTop = tr.scrollHeight;
    return last;
  }
  function closeBubbles() { [...$("#transcript").children].forEach((b) => (b.dataset.done = "1")); }
  function flag(ev) {
    const box = $("#voiceFlag");
    box.innerHTML = `<span>${esc(ev.title)}</span><a href="tel:${ev.number}">☎ ${ev.number}</a>`; box.hidden = false;
    if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
  }
  function localFlags(text, lang) {
    const hits = E().screenEmergency(text).filter((h) => !vs.fired.has(h.id));
    if (!hits.length) return null;
    hits.forEach((h) => vs.fired.add(h.id));
    const key = hits.every((h) => h.action === "MENTAL_HEALTH_CRISIS") ? "MENTAL_HEALTH_CRISIS" : "EMERGENCY";
    const ev = { key, title: E().msg(`levels.${key}.title`, lang), action: E().msg(`levels.${key}.action`, lang), number: key === "EMERGENCY" ? "108" : "14416" };
    flag(ev); return ev;
  }

  // ---------------------------------------------------------------- speaking in any language
  function hasVoice(code) {
    if (!("speechSynthesis" in window)) return false;
    const b = code.split("-")[0].toLowerCase();
    return speechSynthesis.getVoices().some((v) => v.lang && v.lang.toLowerCase().split(/[-_]/)[0] === b);
  }
  function speechCodeFor(code) { const b = (code || "en").split("-")[0]; return (sup()[b] || {}).speech || code || "en-IN"; }
  function sayBrowser(text, code) {
    return new Promise((res) => {
      if (!("speechSynthesis" in window)) return res();
      speechSynthesis.cancel();
      const c = speechCodeFor(code), b = c.split("-")[0].toLowerCase(), voices = speechSynthesis.getVoices();
      const u = new SpeechSynthesisUtterance(text.replace(/[“”"*]/g, ""));
      u.lang = c; u.rate = 0.95;
      const v = voices.find((x) => x.lang === c) || voices.find((x) => x.lang && x.lang.toLowerCase().split(/[-_]/)[0] === b);
      if (v) u.voice = v;
      let done = false; const fin = () => { if (!done) { done = true; res(); } };
      u.onend = fin; u.onerror = fin; setTimeout(fin, 1500 + text.length * 90);
      speechSynthesis.speak(u);
    });
  }
  async function sayGemini(text) {
    const r = await A().postJSON("api/voice/tts", { text }, 30000).catch(() => null);
    if (!r || !r.ok) return false;
    const bin = atob(r.pcm_b64), buf = new ArrayBuffer(bin.length), v = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) v[i] = bin.charCodeAt(i);
    await new Promise((res) => { const s = play(buf, r.rate || 24000); if (s) s.addEventListener("ended", res); else res(); setTimeout(res, 60000); });
    return true;
  }
  async function say(text, code) {
    vs.speaking = true; orb.className = "orb";
    try {
      const app = A();
      if (!hasVoice(speechCodeFor(code)) && aiVoice()) { if (await sayGemini(text)) return; }
      await sayBrowser(text, code);
    } finally { vs.speaking = false; if (sheet.open) orb.className = "orb listening"; }
  }

  // ---------------------------------------------------------------- open / mode choice
  async function open() {
    const app = A();
    $("#transcript").innerHTML = ""; $("#voiceFlag").hidden = true;
    Object.assign(vs, { said: "", history: [], flow: null, lastLang: null, fired: new Set() });
    fillLangSelect();
    sheet.showModal(); orb.className = "orb idle";
    if (aiVoice() && navigator.mediaDevices && window.AudioWorkletNode) {
      setMode("live", "Live · any language"); await startLive();
    } else startBasic();
  }
  function fillLangSelect() {
    const sel = $("#voiceLang"), ui = A().L(), langs = VOICE_LANGS();
    sel.innerHTML = langs.map((c) => `<option value="${c}">${esc(sup()[c].native)} · ${esc(sup()[c].name)}</option>`).join("");
    sel.value = langs.includes(ui) ? ui : (langs.includes("hi") && ["mai", "doi", "brx", "ne", "mr", "sa"].includes(ui) ? "hi" : "en");
  }

  // ---------------------------------------------------------------- live (Gemini Live)
  async function startLive() {
    const app = A();
    status("…");
    if (!(await getMic())) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const base = location.pathname.replace(/[^/]*$/, "");
    let ready = false;
    vs.ws = new WebSocket(`${proto}://${location.host}${base}api/live?lang=${encodeURIComponent(app.L())}`);
    vs.ws.binaryType = "arraybuffer";
    const fallback = (why) => { if (vs.mode !== "live") return; stopSocket(); console.info("live unavailable:", why); startTurn(); };
    const t = setTimeout(() => { if (!ready) fallback("timeout"); }, 15000);
    vs.ws.onmessage = async (ev) => {
      if (typeof ev.data !== "string") { play(ev.data, 24000); return; }
      const m = JSON.parse(ev.data);
      if (m.type === "ready") { ready = true; clearTimeout(t); status(app.t("talk_hint") + " · any language"); await startCapture(onLivePcm); greet(); }
      else if (m.type === "user_text") { bubble("me", m.text, true); vs.said += " " + m.text; }
      else if (m.type === "ai_text") bubble("ai", m.text, true);
      else if (m.type === "turn_complete") { orb.className = "orb listening"; closeBubbles(); }
      else if (m.type === "interrupted") stopPlayback();
      else if (m.type === "red_flag") flag(m);
      else if (m.type === "unavailable" || m.type === "error") { clearTimeout(t); fallback(m.message); }
    };
    vs.ws.onclose = () => { if (vs.mode === "live" && ready) status("Session ended. Tap the orb to start again."); };
    vs.ws.onerror = () => { clearTimeout(t); fallback("socket error"); };
  }
  function onLivePcm(e) {
    if (vs.ws && vs.ws.readyState === 1) vs.ws.send(e.data.pcm);
    if (!vs.playing.length) orb.style.transform = `scale(${1 + Math.min(e.data.peak * 1.6, 0.35)})`;
  }
  function greet() {
    send({ type: "text", text: `(The person opened the app in ${(sup()[A().L()] || {}).name}. Greet them warmly in one short sentence in that language and ask what is troubling them. If they then speak another language, switch to it.)` });
  }
  function send(obj) { if (vs.ws && vs.ws.readyState === 1) vs.ws.send(JSON.stringify(obj)); }
  function stopSocket() { try { if (vs.ws) { send({ type: "end" }); vs.ws.close(); } } catch (_) {} vs.ws = null; }

  // ---------------------------------------------------------------- shared audio plumbing
  async function getMic() {
    if (vs.stream) return true;
    try {
      vs.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      return true;
    } catch (_) { status("Microphone permission is needed. You can type below instead."); return false; }
  }
  async function startCapture(handler) {
    if (!vs.ctxIn) {
      vs.ctxIn = new AudioContext({ sampleRate: 16000 });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await vs.ctxIn.audioWorklet.addModule(url);
      vs.src = vs.ctxIn.createMediaStreamSource(vs.stream);
      vs.node = new AudioWorkletNode(vs.ctxIn, "rp-cap");
      vs.src.connect(vs.node);
    }
    vs.node.port.onmessage = handler;
    orb.className = "orb listening";
  }
  function play(buf, rate) {
    if (!vs.ctxOut) vs.ctxOut = new AudioContext({ sampleRate: rate || 24000 });
    const pcm = new Int16Array(buf), f = new Float32Array(pcm.length);
    let peak = 0; for (let i = 0; i < pcm.length; i++) { f[i] = pcm[i] / 32768; peak = Math.max(peak, Math.abs(f[i])); }
    if (!f.length) return null;
    const ab = vs.ctxOut.createBuffer(1, f.length, rate || 24000); ab.copyToChannel(f, 0);
    const s = vs.ctxOut.createBufferSource(); s.buffer = ab; s.connect(vs.ctxOut.destination);
    const now = vs.ctxOut.currentTime; vs.nextTime = Math.max(vs.nextTime, now + 0.03);
    s.start(vs.nextTime); vs.nextTime += ab.duration;
    vs.playing.push(s); s.onended = () => { vs.playing = vs.playing.filter((x) => x !== s); if (!vs.playing.length && sheet.open) orb.className = "orb listening"; };
    orb.className = "orb"; orb.style.transform = `scale(${1 + Math.min(peak, 0.3)})`;
    return s;
  }
  function stopPlayback() { vs.playing.forEach((s) => { try { s.stop(); } catch (_) {} }); vs.playing = []; vs.nextTime = 0; }
  function stopAudio() {
    stopSocket(); stopPlayback();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (vs.node) vs.node.disconnect(); if (vs.src) vs.src.disconnect();
    if (vs.stream) vs.stream.getTracks().forEach((t) => t.stop());
    if (vs.ctxIn) vs.ctxIn.close().catch(() => {}); if (vs.ctxOut) vs.ctxOut.close().catch(() => {});
    Object.assign(vs, { ctxIn: null, ctxOut: null, stream: null, node: null, src: null, rec: null });
  }

  // ---------------------------------------------------------------- turn mode (Gemini, any language)
  const VAD = { floor: 0.01, speaking: false, quietMs: 0, chunks: [], ms: 0 };
  async function startTurn() {
    setMode("turn", "Gemini · any language");
    if (!(await getMic())) return;
    status("Speak in any language. I will answer in the same one.");
    await startCapture(onTurnPcm);
    if (!vs.history.length) {
      const hi = E().t("describe", A().L());
      bubble("ai", hi); vs.history.push({ role: "assistant", text: hi }); await say(hi, A().L());
    }
  }
  function onTurnPcm(e) {
    if (vs.mode !== "turn" || vs.busy || vs.speaking) { VAD.speaking = false; VAD.chunks = []; return; }
    const peak = e.data.peak, ms = 100; // 1600 samples @16 kHz
    if (!VAD.speaking) VAD.floor = VAD.floor * 0.95 + peak * 0.05;
    const loud = peak > Math.max(0.045, VAD.floor * 3);
    orb.style.transform = `scale(${1 + Math.min(peak * 1.6, 0.35)})`;
    if (loud) {
      if (!VAD.speaking) { VAD.speaking = true; VAD.chunks = []; VAD.ms = 0; status(A().t("listening")); }
      VAD.quietMs = 0;
    } else if (VAD.speaking) VAD.quietMs += ms;
    if (VAD.speaking) {
      VAD.chunks.push(e.data.pcm); VAD.ms += ms;
      if (VAD.quietMs >= 1200 || VAD.ms >= 20000) {
        const chunks = VAD.chunks; VAD.speaking = false; VAD.chunks = [];
        if (VAD.ms - VAD.quietMs >= 400) sendTurn(chunks);
      }
    }
  }
  function wav(chunks) {
    const n = chunks.reduce((s, c) => s + c.byteLength, 0), b = new ArrayBuffer(44 + n), v = new DataView(b);
    const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, n, true);
    let o = 44; for (const c of chunks) { new Uint8Array(b, o, c.byteLength).set(new Uint8Array(c)); o += c.byteLength; }
    return b;
  }
  function b64(buf) { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
  async function sendTurn(chunks) {
    const app = A(); vs.busy = true; orb.className = "orb thinking"; status("…");
    const r = await app.postJSON("api/voice/turn", { audio_b64: b64(wav(chunks)), mime: "audio/wav", history: vs.history.slice(-8), ui_lang: app.L() }, 45000).catch(() => null);
    vs.busy = false;
    if (!sheet.open || vs.mode !== "turn") return;
    if (!r || !r.ok) { status((r && r.error) || "Could not reach the voice service. Switching to basic voice."); if (!r) startBasic(); return; }
    vs.lastLang = r.language_code;
    bubble("me", r.transcript, false, langName(r.language_code)); vs.said += " " + r.transcript;
    vs.history.push({ role: "user", text: r.transcript });
    const base = (r.language_code || "en").split("-")[0];
    if (r.red_flag) flag(r.red_flag); else localFlags(r.transcript, sup()[base] ? base : "en");
    bubble("ai", r.reply); vs.history.push({ role: "assistant", text: r.reply });
    status(`${langName(r.language_code)} · ${app.t("talk_hint")}`);
    await say(r.reply, r.language_code);
  }

  // ---------------------------------------------------------------- basic (browser speech + rules, guided)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const YES = /\b(yes|yeah|haan?|ha|ji|ho|hoy|aam|ama|aamaa|avunu|houdu|athe|hya|hyan|haa)\b|हाँ|हां|जी|हो|होय|ஆம்|ஆமா|ஆமாம்|হ্যাঁ|হাঁ|হয়|అవును|ఔను|હા|ಹೌದು|അതെ|ഉവ്വ്|ਹਾਂ|ହଁ|ହଁ|ہاں|جی|हजुर|हो\b/i;
  const NO = /\b(no|nahi|nahin|nai|na|illa|illai|ledu|kadu|nako|nathi)\b|नहीं|नही|ना|नाही|छैन|होइन|இல்லை|இல்ல|না|নাই|নহয়|లేదు|కాదు|ના|નથી|ಇಲ್ಲ|ഇല്ല|ਨਹੀਂ|ନା|ନାହିଁ|نہیں|نا/i;
  function yesNo(text) { const n = NO.test(text), y = YES.test(text); return n ? "no" : y ? "yes" : null; }
  function num(text) {
    const m = /(\d{1,3}(?:\.\d)?)/.exec(E().normalize(text));
    if (m) return parseFloat(m[1]);
    const d = E().extract(text + " days").duration_days;
    return d || null;
  }
  function startBasic() {
    const app = A();
    setMode("basic", "English · हिन्दी · தமிழ்");
    vs.flow = { step: "describe", lang: $("#voiceLang").value || app.L(), message: "", answers: {} };
    const q = E().t("describe", vs.flow.lang);
    bubble("ai", q);
    if (!SR) { status("This browser cannot listen. Type below (any language), or use Chrome on Android."); return; }
    status("Pick the language you will speak above, then talk.");
    say(q, vs.flow.lang).then(listen);
  }
  function listen() {
    if (!SR || !sheet.open || vs.mode !== "basic" || vs.rec) return;
    const lang = $("#voiceLang").value || A().L();
    const rec = new SR(); vs.rec = rec;
    rec.lang = speechCodeFor(lang); rec.interimResults = true; rec.maxAlternatives = 1;
    orb.className = "orb listening"; status(`${A().t("listening")} · ${langName(lang)}`);
    let live = null, final = "";
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) { const t = ev.results[i][0].transcript; if (ev.results[i].isFinal) final += t; else interim += t; }
      if (!live) live = bubble("me", ""); live.firstChild.textContent = final + interim;
      $("#transcript").scrollTop = 1e9;
    };
    let err = "";
    rec.onerror = (ev) => {
      err = ev.error;
      const m = {
        "not-allowed": "Microphone is blocked. Allow the microphone (🔒 icon in the address bar), then tap the orb. You can also type below.",
        "service-not-allowed": "Microphone is blocked. Allow the microphone (🔒 icon in the address bar), then tap the orb. You can also type below.",
        "audio-capture": "No microphone found. Plug one in or type below.",
        "network": "Speech recognition needs internet (Chrome sends the audio to Google). Type below instead; everything else works offline.",
        "language-not-supported": `This browser cannot listen in ${langName(lang)}. Use Chrome or Edge, pick another language, or type below.`,
      }[ev.error];
      if (m) status(m);
    };
    rec.onend = () => {
      vs.rec = null; orb.className = "orb idle";
      if (live) live.dataset.done = "1";
      if (final.trim()) { vs.silent = 0; onBasicText(final.trim(), lang); return; }
      if ((err === "no-speech" || !err) && sheet.open && vs.mode === "basic" && (vs.silent = (vs.silent || 0) + 1) < 3) { listen(); return; }
      if (!err || err === "no-speech" || err === "aborted") status("I did not hear anything. Tap the orb and speak, or type below.");
    };
    try { rec.start(); } catch (_) { vs.rec = null; }
  }
  async function onBasicText(text, micLang) {
    const f = vs.flow; if (!f) return;
    vs.said += " " + text;
    // the words decide the language (the mic language can be English while the person speaks Hinglish)
    const det = E().detect(text);
    if (f.step === "done") Object.assign(f, { step: "describe", message: "", answers: {} });   // a new problem starts a new check
    if (f.step === "describe") f.lang = det.supported && VOICE_LANGS().includes(det.code) ? det.code : micLang;
    const lang = f.lang;
    const fl = localFlags(vs.said, det.supported && det.script === "native" ? det.code : lang);
    if (fl) { bubble("ai", fl.action); await say(fl.action, lang); }
    let reply = "";
    if (f.step === "describe") {
      f.message = (f.message + " " + text).trim();
      const r = E().interpret({ message: f.message, language: lang });
      if (r.stage !== "confirm") return finish(r, lang);
      f.iid = r.interpretation_id; f.questions = r.questions.filter((q) => q.required || q.id === "pregnant" && /pregnan|गर्भ/.test(f.message)); f.qi = -1;
      f.step = "confirm"; reply = r.readback;
    } else if (f.step === "confirm") {
      const yn = yesNo(text);
      if (yn === "no") { f.message = ""; f.step = "describe"; reply = E().t("describe", lang); }
      else return ask(lang);
    } else if (f.step === "q") {
      const q = f.questions[f.qi];
      const v = q.type === "yesno" ? yesNo(text) : num(text);
      if (v === null) reply = q.text; // ask again
      else { f.answers[q.id] = v; return ask(lang); }
    }
    if (reply) { bubble("ai", reply); await say(reply, lang); }
    listen();
  }
  async function ask(lang) {
    const f = vs.flow; f.step = "q"; f.qi += 1;
    if (f.qi >= f.questions.length) {
      const r = E().assess({ message: f.message, interpretation_id: f.iid, answers: f.answers, language: lang, confirmed: true });
      return finish(r, lang);
    }
    const q = f.questions[f.qi]; bubble("ai", q.text); await say(q.text, lang); listen();
  }
  async function finish(r, lang) {
    vs.flow.step = "done"; vs.flow.result = r;
    const fa = (r.first_aid || [])[0];
    const lines = [r.urgency.title, r.urgency.action, fa && fa.do && fa.do[0]].filter(Boolean);
    const el = bubble("ai", lines.join(" "));
    el.classList.add("lvl-" + r.urgency.level);
    if (r.urgency.level === "EMERGENCY") flag({ title: r.urgency.title, number: r.urgency.key === "MENTAL_HEALTH_CRISIS" ? "14416" : "108" });
    status(A().t("check") + " → slip, map & first aid");
    await say(lines.join(". "), lang);
  }

  // ---------------------------------------------------------------- controls
  orb.addEventListener("click", () => {
    if (vs.mode === "basic") { if (vs.flow && vs.flow.step === "done") startBasic(); else listen(); }
    else if (vs.mode === "live" && !vs.ws) { setMode("live", "Live · any language"); startLive(); }
  });
  $("#voiceLang").addEventListener("change", () => { if (vs.rec) { try { vs.rec.abort(); } catch (_) {} } if (vs.flow && vs.flow.step === "describe") vs.flow.lang = $("#voiceLang").value; });
  $("#voiceType").addEventListener("submit", async (e) => {
    e.preventDefault(); const v = $("#voiceText").value.trim(); if (!v) return;
    $("#voiceText").value = "";
    if (vs.mode === "live") { bubble("me", v); vs.said += " " + v; send({ type: "text", text: v }); }
    else if (vs.mode === "basic") { bubble("me", v); onBasicText(v, E().detect(v).supported ? E().detect(v).code : $("#voiceLang").value); }
    else if (vs.mode === "turn") {
      const app = A(); bubble("me", v); vs.said += " " + v;
      const det = E().detect(v), lang = det.supported ? det.code : app.L();
      localFlags(vs.said, lang);
      vs.busy = true;
      const r = await app.postJSON("api/voice/turn_text", { text: v, history: vs.history.slice(-8), ui_lang: lang }, 30000).catch(() => null);
      vs.busy = false;
      vs.history.push({ role: "user", text: v });
      if (r && r.ok) { if (r.red_flag) flag(r.red_flag); bubble("ai", r.reply); vs.history.push({ role: "assistant", text: r.reply }); say(r.reply, r.language_code || lang); }
    }
  });
  function close() { stopAudio(); if (vs.rec) { try { vs.rec.abort(); } catch (_) {} } vs.mode = null; if (sheet.open) sheet.close(); }
  $("#voiceStop").addEventListener("click", close);
  sheet.addEventListener("close", () => { stopAudio(); if (vs.rec) { try { vs.rec.abort(); } catch (_) {} } vs.mode = null; });
  $("#voiceToCheck").addEventListener("click", () => {
    const text = (vs.flow && vs.flow.message) || vs.said.trim(); close();
    if (text) { $("#msg").value = text; $("#msg").dispatchEvent(new Event("input")); A().submitDescribe(); }
    else document.getElementById("app").scrollIntoView({ behavior: "smooth" });
  });
  $("#heroTalk").addEventListener("click", open);
  window.RPVoice = { open, close, _yesNo: yesNo, _num: num };
})();
