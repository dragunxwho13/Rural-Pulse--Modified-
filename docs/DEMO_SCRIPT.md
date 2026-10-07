# Live demo script (about 5 minutes)

## Before you start (5 minutes)
1. Run `./run.sh` (or `run.bat`). Open http://localhost:8000, click **⚙**, paste the Gemini key and press **Apply** (it says "Gemini connected"). This enables the any-language voice assistant and translation.
2. **Laptop window A:** http://localhost:8000. **Phone or window B:** http://localhost:8000/doctor.html.
   To use a phone on the same Wi-Fi, start the server with `--host 0.0.0.0` and open `http://<laptop-ip>:8000/doctor.html`.
3. On the dashboard, log in as a doctor. Pick **"All incoming patients (district view)"**, enter any 10-digit number and tap *Send code*. The code fills itself in demo mode. Tap **🔔 Turn on alerts**.
4. Check that the map loads by searching your town once. The venue Wi-Fi must allow openstreetmap.org.
5. Have a backup tab with **Demo settings → Low bandwidth** in case the network is slow.

## 0. Hook (15 s)
"In rural India the hard part isn't a chatbot answer. It's the first decision: **where should I go, and how soon?** Most rural telemedicine use is through ASHA workers. So we built for the ASHA, the patient and the doctor together, in 22 languages."

## 1. Language picker and a Tamil emergency (40 s)
- The language picker is the first screen, with each name in its own script. Pick **தமிழ்**.
- Type or tap the mic and say: *அப்பாவுக்கு நெஞ்சு வலி, வியர்க்கிறது* ("father has chest pain and is sweating").
- **Before you press Check**, the red 108 banner appears while typing. "That's the offline rule engine. No internet, no AI."
- Press Check. You get **Emergency, decided by rules**, a huge ☎ 108 button and *Share my location* (sends a map link by SMS).
- Open the **Do this now** tab: chest-pain first aid in Tamil. Tap 🔊. "First aid only: no medicine names, no doses."

## 2. ASHA flow in Bengali, nearest care and routing (90 s)
- *New check*. Language **বাংলা**. Choose **ASHA / health worker**. Type `আমার ৩ দিন ধরে জ্বর, বয়স ৪৫`, and in the ASHA box set SpO₂ 95 and temperature 38.6.
- The read-back is in Bengali, with Bengali digits understood. Answer the danger-sign question **No**, then confirm. Result: **see a doctor today**.
- **Nearest care** tab, **Use my location** (or type your town): show the real OpenStreetMap health centres, with **government / free first** and every one labelled *not verified*.
- Tap **🛣 Main-road route**: the fastest route is drawn as a grey dashed line, the main-road route in blue, with minutes and % on highways. Tap **Navigate** to open turn-by-turn directions in Google Maps.
- Scroll to **Doctors near you**: entries from the doctors dataset by specialty, marked *not NMC-verified*.

## 3. The doctor gets ready before the patient arrives (60 s)
- (The dashboard already shows sample reports and a stats strip. If you are short of time, press **▶ Simulate incoming patient**, or tick *Auto every 45 s*, to show a live referral arriving.)
- Tap **📨 Notify the nearest doctor**. Add a patient name and phone, pick a time slot, enter the ASHA phone and OTP (filled automatically in demo mode). Send.
- **The doctor's dashboard rings**: the patient's own words, symptoms, vitals and the **"Get ready" list** (thermometer, malaria/dengue tests, ORS). Tap **🧰 Preparing**: the patient's phone shows *Preparing* live.

## 4. Prescription in the patient's language (60 s)
- On the dashboard, write: Paracetamol 500 mg, ☀ 1 · 🌙 1, after food, 3 days. Add a note. Choose **Send to pharmacy: Jan Aushadhi Kendra**, then send.
- Open the card link. The **medicine card** is in Bengali, with sun and moon pictures, *after food*, *3 days*, a 🔊 read-aloud and ⏰ reminders (adds daily phone alarms). "The patient can't read English? They don't need to."
- Optionally, log in as **Pharmacy** and mark the card **Ready for pickup**: the patient's card updates live and an SMS goes out (shown in the outbox in demo mode).

## 5. Talk to RuralPulse (40 s, needs the Gemini key)
- On the hero, tap **Talk to RuralPulse**. Speak in Hindi, then switch to Tamil or Bengali mid-conversation: it **answers in whatever language you speak** with a natural, warm voice and asks one question at a time.
- Without a key (offline), choose the language under *"I will speak in"*. RuralPulse runs a guided check by voice in that language.
- Say a danger sign ("सीने में दर्द है"). The **108 banner appears instantly**: the rules listen to the transcript, whatever the AI says.

## 6. The visit slip (20 s)
- **Visit slip** tab: one clean page in the patient's language (urgency, own words, where to go, what to bring, questions for the doctor) plus a short English block for the doctor. **Print** gives exactly one page. **WhatsApp** and **SMS** share the same content.

## Close (15 s)
"Rules decide urgency, AI only listens and translates, every piece of data says where it came from, and the doctor is ready before the patient arrives, in 22 languages."

---
### Likely judge questions
- **"Is the OSM data accurate?"** Not always. That's why every place is marked *not verified*, government centres are ranked first, and a verified-directory schema (source, verifier, date) is built in for state registry data.
- **"Do you prescribe?"** No. Only the doctor writes medicines and doses. RuralPulse shows them with pictures and in the patient's language.
- **"22 languages, really?"** There are 3 tested, 11 with an offline draft vocabulary and full screens, and 9 that need the AI layer or an ASHA. It's labelled honestly in the app (*How RuralPulse works → Languages*), and the offline engine abstains rather than guesses.
- **"How is the 'safe' route chosen?"** Among OSRM alternatives at most 30% slower, it picks the one with the most distance on numbered highways (NH/SH), then named roads, then fewest turns. Those roads are usually better lit, busier and easier for ambulances. For emergencies the app says an ambulance is safer than driving.
- **"Privacy?"** No patient sign-up, phone numbers masked on dashboards, public status links show status only, raw text kept only with consent, DPDP Act noted in `SAFETY_CASE.md`.
