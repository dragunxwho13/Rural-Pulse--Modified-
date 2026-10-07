# Safety case (prototype)

## Intended use
Navigation and appointment preparation for adults, children's caregivers and ASHA workers in rural India. **Not** for diagnosis, treatment, dosing or replacing emergency services.

## Hazards and controls
| Hazard | Control | Verified by |
|---|---|---|
| Emergency missed (under-triage) | Red-flag rules on raw text before anything else; LLM can only add; screening question; vitals rules | `test_chest_pain_is_emergency_in_all_languages`, suite red-flag sensitivity |
| AI or attacker lowers urgency | Rules run on raw text; injection detection; LLM output limited to a fixed concept list | `test_prompt_injection_cannot_lower_urgency` |
| Misunderstood language | Named languages only; untested languages abstain; read-back confirmation; escalation-only for unvalidated input | `test_unsupported_language_abstains` |
| Guessing with missing info | `MISSING_INFO` abstention | `test_missing_age_and_duration_abstains` |
| Dose advice | `MED_DOSE` refusal | `test_medication_dose_is_never_answered` |
| Patient edit hides a danger sign | Red-flag concepts can't be removed | `test_patient_edit_cannot_remove_red_flag` |
| Sent to a closed or wrong facility | Open-now filter, 24x7 for emergencies, service filter, exclusion reasons | `test_closed_facility_excluded_for_same_day`, `test_emergency_needs_24x7` |
| Stale or false facility data | Freshness status, conflict warnings, unverified never primary, provenance on every card | `test_unverified_record_is_never_primary`, `test_conflicting_sources_are_warned` |
| Privacy breach | Raw text kept only with consent; salted hash; no PII fields | `audit.py` |
| Wrong place from community map data | OSM places labelled "not verified"; government first; emergencies → hospitals only; 108 advised over self-transport | `tests/geo.test.js` |
| Doctor listing mistaken for verified | Listings marked "not NMC-verified", approximate location; no invented hospital links | `tests/geo.test.js` |
| Voice assistant gives unsafe advice | System prompt forbids diagnosis/medicines; transcript checked by red-flag rules → 108 banner regardless of model | `live.py` |
| Wrong medicine taken | Only the doctor enters medicines and doses; card shows them verbatim with pictograms; RuralPulse never suggests drugs | `test_first_aid_cards_never_mention_doses` |
| Leak of patient data | Public status streams carry status only; phone masked; dashboards need OTP login | `test_case_notification_and_prescription_flow` |
| Network failure | Offline browser engine with parity; service worker; keystroke-level danger-sign check | `scripts/parity_check.js` |

## Known gaps
- **EM-15:** an atypical cardiac presentation (fatigue and sweating in an older woman) is under-triaged to same day. A candidate rule needs clinician review.
- Lexicon coverage of dialects and code-switching is limited. It needs a community corpus.
- The 11 offline-draft language packs (UI, messages, lexicon, first aid) were machine-drafted and need native-speaker review before any field use.
- The 9 AI-assisted languages depend on Gemini's understanding, which is untested for medical use in those languages.
- The demo OTP mode shows codes on screen; disable it (RP_DEMO_OTP=0) with a real SMS gateway.
- Voice input uses the browser's speech recognition and is not validated.
- The facility data is synthetic.
- The protocol has not been clinically reviewed.

## Validation plan before any real use
1. Offline red-team and clinician review of the protocol and vignettes.
2. Language validation with native speakers, ASHAs and interpreters.
3. A silent-mode prospective study.
4. A supervised pilot with human fallback.
5. Broader use only after that, with per-language, per-age and per-acuity results published.
