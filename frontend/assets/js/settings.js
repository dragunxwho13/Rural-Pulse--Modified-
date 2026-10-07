/* ⚙ Settings: paste a Gemini API key (tested live, applied without restart) and choose
 * map services (tiles, Overpass, Nominatim, OSRM). On a static deployment (no server)
 * map settings are kept in this browser; the Gemini key needs the server. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const A = () => window.RPApp, sheet = $("#settingsSheet");
  const PRESETS = [...$("#setTilePreset").options].map((o) => o.value);
  async function open() {
    const app = A(), cfg = app.state.mapCfg || {};
    let srv = null;
    if (app.state.server) { try { srv = await app.getJSON("api/settings", {}, 4000); } catch (_) {} }
    const m = srv || cfg;
    $("#setOverpass").value = m.overpass_url || ""; $("#setNominatim").value = m.nominatim_url || ""; $("#setOsrm").value = m.osrm_url || "";
    const tile = m.tile_url || PRESETS[0];
    $("#setTilePreset").value = PRESETS.includes(tile) ? tile : "custom"; $("#setTileCustom").value = PRESETS.includes(tile) ? "" : tile;
    $("#setTileCustomWrap").hidden = $("#setTilePreset").value !== "custom";
    const st = $("#setKeyStatus"); st.className = "set-status";
    if (!srv) {
      $("#setWhere").textContent = "No RuralPulse server is reachable (static or offline mode). Map settings are saved in this browser. The Gemini key needs the server: run run.bat / run.sh.";
      $("#setKey").disabled = true; st.textContent = "";
    } else if (!srv.can_edit) {
      $("#setWhere").textContent = "For safety, the key and services can only be changed on the computer running RuralPulse (open http://localhost:8000 there).";
      $("#setKey").disabled = true; st.textContent = srv.gemini_key_set ? `AI is on (key ${srv.gemini_key_masked}).` : "AI is off.";
    } else {
      $("#setWhere").textContent = "Changes apply immediately for everyone using this server.";
      $("#setKey").disabled = false; $("#setKey").value = "";
      $("#setKey").placeholder = srv.gemini_key_set ? `Key in use: ${srv.gemini_key_masked} (paste a new one to replace)` : "Paste API key (starts with AIza…)";
      st.textContent = srv.ai_enabled ? `✅ AI is on (${srv.llm_model}).` : "AI is off: rules-only mode."; st.classList.add(srv.ai_enabled ? "ok" : "bad");
    }
    sheet.showModal();
  }
  $("#setTilePreset").addEventListener("change", () => ($("#setTileCustomWrap").hidden = $("#setTilePreset").value !== "custom"));
  $("#setKeyShow").addEventListener("click", () => { const k = $("#setKey"); k.type = k.type === "password" ? "text" : "password"; });
  $("#setClose").addEventListener("click", () => sheet.close());
  $("#gearBtn").addEventListener("click", open);
  $("#settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const app = A(), st = $("#setKeyStatus"), btn = $("#setApply");
    const tile = $("#setTilePreset").value === "custom" ? $("#setTileCustom").value.trim() : $("#setTilePreset").value;
    const body = { overpass_url: $("#setOverpass").value.trim(), nominatim_url: $("#setNominatim").value.trim(), osrm_url: $("#setOsrm").value.trim(),
      tile_url: tile, tile_attribution: /cartocdn/.test(tile) ? "© OpenStreetMap contributors © CARTO" : /openstreetmap\.fr\/hot/.test(tile) ? "© OpenStreetMap contributors, Humanitarian OSM Team" : "© OpenStreetMap contributors",
      save: $("#setSave").checked };
    const key = $("#setKey").value.trim();
    if (key && !$("#setKey").disabled) body.gemini_key = key;
    btn.disabled = true; st.className = "set-status"; st.textContent = key ? "Testing the key with Google…" : "Applying…";
    try {
      if (app.state.server && !$("#setKey").disabled) {
        const r = await app.postJSON("api/settings", body, 30000);
        st.textContent = (r.ok ? "✅ " : "❌ ") + r.messages.join("\n"); st.classList.add(r.ok ? "ok" : "bad");
        app.state.mapCfg = { ...app.state.mapCfg, ...r.settings };
      } else {
        app.state.mapCfg = { ...app.state.mapCfg, ...Object.fromEntries(Object.entries(body).filter(([k, v]) => v && k !== "save")) };
        st.textContent = "✅ Map settings saved in this browser."; st.classList.add("ok");
      }
      try { localStorage.setItem("rp.mapCfg", JSON.stringify({ tile_url: app.state.mapCfg.tile_url, tile_attribution: app.state.mapCfg.tile_attribution, overpass_url: app.state.mapCfg.overpass_url,
        nominatim_url: app.state.mapCfg.nominatim_url, osrm_url: app.state.mapCfg.osrm_url })); } catch (_) {}
      await app.refreshMeta();
      window.dispatchEvent(new CustomEvent("rp:settings"));
    } catch (err) { st.textContent = "❌ " + ((err.body && err.body.detail) || "Could not apply settings."); st.classList.add("bad"); }
    finally { btn.disabled = false; }
  });
  window.RPSettings = { open };
})();
