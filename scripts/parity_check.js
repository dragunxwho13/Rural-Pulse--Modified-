// Verifies the offline browser engine gives the same results as the Python server:
// every vignette (urgency, facility, rules) plus full text outputs for a multilingual sample.
// Usage: node scripts/parity_check.js   (then: python scripts/parity_compare.py)
const fs = require("fs"), path = require("path");
const E = require(path.join(__dirname, "..", "frontend", "assets", "js", "engine.js"));
const root = path.join(__dirname, "..", "data");
const J = (f) => JSON.parse(fs.readFileSync(path.join(root, f)));
E.init(J("protocol.json"), J("facilities.json"), { i18n: J("i18n.json"), firstAid: J("first_aid.json"), prep: J("prep.json") });
const r = E.runSuite(J("eval/vignettes.json"));
console.log(JSON.stringify(r.metrics));
const samples = JSON.parse(fs.readFileSync(path.join(__dirname, "parity_samples.json")));
const deep = samples.map((m) => {
  const base = { message: m, at_time: "2026-10-07T11:00", answers: { redflag_screen: "no" } };
  const i = E.interpret(base);
  const a = i.stage === "confirm" ? E.assess({ ...base, interpretation_id: i.interpretation_id, confirmed: true }) : i;
  return { m, lang: a.interpretation.language, readback: i.readback || null, q: (i.questions || []).map((x) => x.id), level: a.urgency.level,
    title: a.urgency.title, rules: a.decision.rules_fired.map((x) => x.id), slip: a.summary.slip, first_aid: a.first_aid, prep: a.clinician_prep, sms: a.summary.sms };
});
fs.writeFileSync(path.join(__dirname, "..", ".parity_js.json"), JSON.stringify({ cases: r.cases.map((c) => [c.id, c.got, c.facility, c.rules]), deep }));
