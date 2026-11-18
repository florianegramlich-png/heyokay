**PRODUCT REQUIREMENTS DOCUMENT**
**Hey-Okay**
**Real-Time AI Safety Notifications · iOS & Android**
*We warn people about risk before it finds them.*
| **Item** | **Detail** |
| :- | :- |
| **Status** | Draft — For Review |
| **Version** | 6.5 · November 2026 (updated from review comments, see change log at the end) |
| **Funding** | €2,000,000 seed round · 12-month plan, \~19 months runway with reserve · **€5M / 24-month scenario under discussion (Section 10.5, Decision 24)** |
| **Platform** | iOS + Android · React Native with Expo (built) · web app (Next.js) · native modules Phase 2 |
| **AI** | LLM-powered ingestion, classification and alert writing · learned personalisation · grounded in-app assistant (Phase 2) |
| **Launch markets** | **Germany, USA, India** → Austria, Switzerland, UK (Phase 2) |
| **Model** | B2C freemium + B2B2C API |
| **CEO & President** | Benjamin Perlzweig · €150K base |
| **CPTO** | Floriane Gramlich · €225K base |
| **Entities** | Hey-Okay UG (Germany) · US entity (Delaware) proposed — see Section 9.2 |

# **1. What We're Building**
*People search for risks. Risks don't find them. We fix that.*
Hey-Okay is a mobile safety app for iOS and Android. It monitors real-time data across seven risk categories — weather, crime, health, travel, political, technology (outages, cyber attacks, hacks) and infrastructure — and pushes personalised alerts to each user based on their exact location. Always on. No searching required.
AI does the heavy lifting. It reads hundreds of official and unstructured sources, works out what happened, where, and how serious it is, evaluates what risks follow from it in the next hours (Section 6.1 #14), decides who needs to know, and writes a clear two-line alert — in under a minute. Every alert is tied to a verified source. The more users rate alerts, the better the model gets at sending only what matters.
**Why it has to be a mobile app, not a website:**
  - Background location only works in native apps — not browsers
  - Lock-screen push delivery via APNs (iOS) and FCM (Android) requires native integration
  - OS-level geofencing — street-level precision — only works with CLLocationManager and Android's Geofencing API
  - Always-on reliability is a permission you earn from users, not a feature you bolt on
We're starting in **Germany, the US and India** with €2M and 12 months to prove the model. A €5M / 24-month scenario is modelled in Section 10.5.
# **2. The Problem****
| **What exists** | **Price** | **What's wrong with it** | **What's missing** |
| :- | :- | :- | :- |
| Government alerts (EU-Alert, NINA, US WEA, India NDMA SACHET) | Free | Same message to an entire city. No context, no personalisation, no relevance filtering. | Anything specific to you |
| Weather apps | Free; premium tiers a few € per year. DWD WarnWetter: full version €1.99 one-off (2017 figure) **\[Check\]** | One category. Reactive — they confirm what's already happening. | The other six risk categories |
| Enterprise platforms (Everbridge, AlertMedia, Rave) | Quote only. Third-party estimates: Everbridge \~$7K/yr (SMB) to \~$240K/yr (enterprise); AlertMedia \~$15–40K/yr mid-market | Built for organisations, not people. You need an employer to get access. | A consumer-facing product |
| News apps | Free to €10–20/month for paywalled news **\[Check\]** | Tells you what happened. By then it's too late. | A proactive warning system |
| US safety apps (Citizen, Life360) | Citizen: free + paid tiers $5.99–$19.99/month · Life360: free + $9.99–$24.99/month | Strong in the US, but built on crowdsourcing or tracking people. Not built for Germany or India. | A verified, privacy-first option |
| Multiple single-category apps | The sum of the above | Five apps, five permission grants, five notification streams, no integration. | One place that connects them |

**Our price:** free tier, paid tier €2.50/month (to be confirmed, Decision 17) — far below Citizen's and Life360's paid tiers. Prices as listed in app stores and price trackers in 2026 (Citizen: March 2026; Life360 US: November 2026; enterprise: SpendHound and Vendr estimates). Recheck before the deck.

The numbers behind it:
  - 20 million people displaced by weather events every year — UNHCR
  - 4 in 10 Americans fear becoming victims of violent crime daily — **\[Check\]**
  - 3 in 5 major cities face high natural disaster risk — UN DESA
  - 1,220 Americans killed by extreme heat every year — CDC
These aren't edge cases. They're the everyday conditions people navigate without the right information.
# **3. Competition & How We Win**
*We have real competitors. None of them combines verified sources, privacy and personal relevance, and none covers Germany, the US and India.*
Nobody delivers personalised, multi-source safety alerts to consumers in Germany or the EU. In the US, Citizen proves demand but is built on scanners, crowds and video. In India, official alerts exist (NDMA SACHET) with no personal layer on top.
## **3.1 Who we're up against**
| **Competitor** | **What they are** | **Price** | **Their strength** | **Their weakness** | **Threat to us** |
| :- | :- | :- | :- | :- | :- |
| **NINA (BBK)** + Katwarn, BIWAPP, WarnWetter, Cell Broadcast | Germany's official warning apps. NINA has \~14M users (May 2026). | Free (WarnWetter full version €1.99 one-off, 2017 figure **\[Check\]**) | Official authority, free, already on our target users' phones | Official warnings only — no crime, transit or local events. No personalisation. Same message to a whole district. | **High in Germany.** We complement it — we don't try to replace it. |
| **Citizen** (sp0n) | US real-time safety app: 911 and scanner monitoring, crowdsourced video, alerts. US, Canada, Mexico. Enterprise product. Axon law-enforcement partnership. | Free; in-app tiers (Citizen Plus, Premium, Protect) $5.99–$19.99/month (App Store, March 2026) | Closest product to ours. 500K+ iOS ratings. Expanding fast. | Criticised for privacy, profiling risk and unverified information. Not in Europe. Its scanner-based sourcing doesn't work in Germany. | Low in DACH and India; **very high in the US, now a launch market** |
| **Life360** | Family location-sharing platform. Crime reports, disaster response, crash detection, SOS on paid tiers. | Free; Silver $9.99, Gold $16.99, Platinum $24.99/month (US, November 2026) | Huge family install base. Bundled subscription. | Built on tracking people. Crime reports aren't real-time. Alerts aren't the core product. | Medium — competes for the family wallet |
| **AI-native newcomers** (VantageAI, ZoneCastAI, OZZI) | AI summaries of first-responder radio; AI-personalised emergency alerts; AI travel safety. | Varies **\[Check\]** | Same AI story as ours | US-only or travel-only. Claims largely unproven. | Medium — they dilute the "AI safety app" pitch |
| **Enterprise** (Everbridge, AlertMedia, Rave) | B2B mass notification and AI threat intelligence | Quote only; estimates \~$7K–$240K/year (Everbridge), \~$15–40K/year mid-market (AlertMedia) | Deep enterprise budgets | No consumer product | Low in B2C; competitor for B2B deals |
| **Neighbourhood networks** (Nextdoor, Ring Neighbors) | Community feeds | Free (ad-funded) | Daily habit | Unverified and noisy | Low |
| **India official** (NDMA SACHET, IMD, state disaster apps, 112 India) | Government alerts and emergency numbers | Free | Official authority; SACHET publishes standard CAP alerts | Official warnings only; same message to whole districts; no crime, transit or local events | High in India — we pass them through and add the personal layer, as with NINA |

## **3.2 Head to head**
|  | **NINA** | **Citizen** | **Life360** | **Hey-Okay** |
| :- | :- | :- | :- | :- |
| Official warnings | ✓ the source | Partial | Partial | **✓ Passes NINA / MoWaS warnings through unchanged, credited** |
| Crime & police operations | ✗ | ✓ (US) | Partial, delayed | **✓ Police press releases + verified local sources** |
| Transit & infrastructure disruption | ✗ | ✗ | ✗ | **✓** |
| Learns what's relevant to you | ✗ | Radius only | ✗ | **✓ Learns from every rating** |
| Family safety | Multiple locations | Partial | ✓ by tracking people | **✓ Protects places, not tracking people; check-ins** |
| Verified sources only | ✓ | ✗ crowdsourced | ✓ | **✓** |
| Built for Germany / GDPR | ✓ | ✗ | US-first | **✓** |
| Price | Free | Free + $5.99–$19.99/month | Free + $9.99–$24.99/month (US) | **Free + €2.50/month (tbc)** |

**Where we lose, and don't try to compete:** NINA's install base and government authority. Citizen's live video and community. Life360's live location tracking and crash detection.
## **3.3 What we must get right to be different**
These are the seven things that make Hey-Okay worth installing next to NINA. Each one has a number we track.
| **\#** | **Differentiator** | **What it means** | **How we prove it** | **Metric** |
| :- | :- | :- | :- | :- |
| 1 | **Beyond NINA** | Every user gets relevant alerts NINA never sends: police operations, transit failures, local incidents, heat at a parent's address. | Side-by-side comparison in the concierge pilot | ≥60% of alerts rated relevant were not available in NINA |
| 2 | **Quiet by default** | Fewer, better alerts. Citizen users get about two alerts a day; we aim for less and more relevant. | Daily budget + learned ranking | ≤1 alert per user per day on average; ≥85% rated relevant |
| 3 | **Verified, never rumour** | Official and verified sources only at launch. No crowdsourced video. We report events, never "dangerous neighbourhoods". | Source link on every alert | 100% source-grounded; false alert rate \<2% |
| 4 | **Family without surveillance** | Protect the places your family cares about without tracking where they are. "Hey, okay?" check-ins only when something happens. | Saved places + check-ins | ≥40% of paid users on the family plan |
| 5 | **Made for Germany** | German language, German sources, EU hosting, GDPR by design. | DPO from Day 1; EU-only AI inference | No user data leaves the EU |
| 6 | **Distribution through insurers** | Embedded in insurer apps. Germany's public insurers already commissioned Katwarn — the buyer exists. | Phase 1 pilot | 1 signed insurer pilot by Month 6 |
| 7 | **Partner of official warnings, not a rival** | Pass official warnings through untouched and credit the source. Offer aggregated relevance insights back to the authorities. | Data agreement / working relationship | Contact with BBK established by Month 6 |

## **3.4 Positioning**
For people in Germany who want to know what's happening around them and their family, **Hey-Okay is the safety app that adds everything official warning apps leave out** — police operations, transit disruptions, local incidents — filtered by AI to what actually matters to you. Unlike Citizen, it uses verified sources only and never maps "dangerous neighbourhoods". Unlike Life360, it protects your family's places without tracking your family.
**In one line:** NINA tells you about the flood. Hey-Okay tells you the S-Bahn is down, there's a police operation near your kid's school, and it's 38°C at your mother's address.
## **3.5 Moats — rated honestly**
| **Moat** | **Strength today** | **What makes it real** |
| :- | :- | :- |
| Insurer & B2B2C distribution | **Strongest — if we sign early** | Multi-year embedded contracts. Insurers already pay for warning apps in Germany. |
| Trust brand: verified and privacy-first | Strong in Germany | No false-alarm incidents, transparent sourcing, EU-only data |
| Personalisation flywheel | Weak at launch, strong at scale | Needs tens of thousands of active raters. Until then, rules do the work. |
| Source coverage & data agreements | Medium | Public sources (police press releases, open transit data) can be copied. Early or exclusive agreements with transit operators and insurers can't. |
| Background location trust | Medium | Real switching cost, but NINA already holds the permission on many phones |
| App Store authority | Weak vs NINA | NINA owns "Warn-App" searches. We target what it doesn't: Unwetter, Polizeieinsatz, S-Bahn Störung. |

## **3.6 What if…**
| **Scenario** | **Likelihood (12 mo)** | **Our response** |
| :- | :- | :- |
| Citizen launches in Germany | Low–medium | Its core sourcing — listening to police and fire radio — doesn't transfer: German emergency-service radio is encrypted digital. Crowdsourced video runs into German privacy expectations. We'd lead on verified sources and already be embedded with insurers. |
| NINA adds personalisation | Medium | NINA's mandate is official warnings. We integrate it, credit it, and own everything outside that mandate. |
| Life360 pushes safety alerts in Europe | Medium | Places-not-tracking family positioning, German-source depth, insurer channel |
| Apple / Google build smarter alerts into the OS | Medium | Depth of local German sources and B2B2C distribution; OS features stay generic |
| A funded AI safety startup enters DACH | Medium | Speed: German source coverage and an insurer pilot before Month 6 |
| Citizen fights back in the US (we launch there now) | High | Don't compete on live video or scanners. Lead on verified sources, privacy and family places, start in California (Floriane is there), and use the US weather service and FEMA's public alert feeds from day one. |
| A local player or the government app adds personal alerts in India | Medium | Speed and the shared pipeline: the same engine, a new country pack (sources, numbers, language) |

## **3.7 Why now**
  - LLMs can now read messy sources (police press releases, transit notices, local news) and turn them into structured events reliably and cheaply
  - iOS 16 + Android 12 brought stable, battery-efficient always-on location APIs
  - Germany has a strong official warning layer and no consumer app on top of it — the US equivalent (Citizen) has proven demand but isn't here
  - Open, standard alert feeds now exist in all three launch markets (NINA/MoWaS and DWD in Germany, the National Weather Service and FEMA IPAWS in the US, NDMA SACHET in India, all CAP-based), so one pipeline serves all three
  - Outages and cyber attacks on everyday services (payments, telecoms, hospitals, transit) are now a regular source of disruption — a risk category no consumer safety app covers
# **4. Who It's For**
| **Segment** | **Who they are** | **What they need** | **Phase** |
| :- | :- | :- | :- |
| Urban professionals | 25–45, city-based, commuting. High phone dependency. | Relevant real-time alerts without having to look for them | MVP · Primary |
| Families | 30–50, suburban. Safety of kids and elderly relatives. | Alerts for the places their family cares about — and a quick way to check everyone is okay — without tracking each other | MVP · Primary |
| Frequent travellers | 25–55, business and leisure. Unfamiliar with local risks. | Location-specific alerts and a briefing wherever they land | MVP · Secondary |
| Elderly individuals | 60+. Higher vulnerability, lower tech fluency. | Simple, clear alerts — read aloud if needed, no noise | Phase 2 — UX focus |
| Organisations (B2B2C) | Insurers, hospitals, municipalities, event venues. | API to deliver alerts to customers and employees, plus incident reporting | Phase 2 · API |

Out of scope for MVP: wearables, C2C crowdsourced reporting, markets outside Germany, the US and India. (A simple web app now exists next to the phone apps — same account, no background alerts.)
# **5. Product Requirements**
## **5.1 Platform decision — React Native**
|  | **React Native** | **Native Swift + Kotlin** | **Our call** |
| :- | :- | :- | :- |
| Cost & speed | Single codebase — \~30–40% cheaper, faster to ship | Two codebases, more coordination | React Native for MVP — **decided and built with Expo (SDK 58)** |
| Performance | Good enough for push, maps, alerts | Best possible | Native for Phase 2 edge cases |
| Background location | Works — needs careful real-device testing | Full OS-level control | Native edge here |
| Push notifications | Full APNs + FCM support | Full support | Equal |
| On-device ML | Core ML / TFLite via native modules | Direct access | Native module in Phase 2 |
| Talent pool | Wider, offshore-friendly, lower rates | Specialist roles, higher cost | React Native wins on budget |

## **5.2 iOS vs Android — what's different**
| **Feature** | **iOS** | **Android** |
| :- | :- | :- |
| Push notifications | APNs — user must grant permission explicitly | FCM — explicit permission from Android 13+ |
| Background location | Core Location, 'Always On' required. OS may throttle in battery-save mode. | Foreground Service required. Battery optimisation exemption recommended. |
| Geofencing | CLLocationManager — up to 20 simultaneous geofences per app | Geofencing API — up to 100 geofences |
| Critical alerts | Critical Alerts entitlement (bypasses silent mode) — requires Apple approval | High-priority notification channel |
| In-app subscriptions | StoreKit 2 | Google Play Billing Library 5+ |
| Store submission | TestFlight beta, 1–3 day review, DUNS required | Play Console, 1–7 day review |

## **5.3 Consumer app — what it does**
**Must have at launch**
  - NINA / MoWaS official warnings passed through unchanged and credited — users can keep NINA or rely on Hey-Okay alone
  - Onboarding: SSO (Apple ID / Google) or email → pre-permission explanation → location permission → category selection → GDPR consent (incl. consent to learn from feedback)
  - Background push: APNs + FCM, lock-screen delivery, rich notifications with action buttons
  - Geofencing: OS-level triggers. Only the right people get the alert.
  - Alert detail: risk type, severity 1–5 colour-coded, map overlay, recommended action, source link, "AI-written summary" label
  - Preferences: per-category on/off, quiet hours, daily alert limit
  - Freemium: free tier (weather + public safety) and paid tier (€2.50/month **— price to be confirmed**, with local price points for the US and India, Decision 17 — full coverage, saved locations, family sharing, AI briefings and assistant from Phase 2)
  - Feedback: relevant / not relevant on each alert. This trains the ranking model.
  - Offline: last 20 alerts cached. Works without connectivity.
  - Crash-free target: ≥99% from Day 1 — Firebase Crashlytics mandatory
**Phase 2 additions**
  - Saved locations — alerts for home, school, a relative's address even when not there
  - Family sharing + "Hey, okay?" check-ins — see Section 6
  - Ask Hey-Okay — grounded in-app assistant (paid tier). *Technical and cost implications:* retrieval over live events, the official guidance library and the user's saved places (the vector search is already in the database); every answer cites its sources, refuses out-of-scope questions and points to 112 / 911 / 112 India. Unlike the alert pipeline, its cost grows with each user and question: budget €500–1,500/month in Phase 2 (Section 6.6), a monthly question limit, and a safety evaluation set before release (Decision 14).
  - Daily and trip briefings (paid tier)
  - Home screen widget — current risk level without opening the app
  - Alert history — searchable log
  - Notification grouping — related alerts stacked, not flooding the shade
## **5.4 The alert engine**
The alert engine is the AI pipeline described in full in Section 6. Hard requirements:
  - Ingest — Germany: DWD, NINA / MoWaS, EU-Alert, police and fire press releases, transit operators. US: National Weather Service, FEMA IPAWS, city and police feeds. India: NDMA SACHET (CAP), IMD. All markets: OpenWeatherMap (heat at saved places), technology sources (BSI / CERT-Bund, CISA, CERT-In advisories, provider status pages for outages), vetted local news
  - Match: users within the impact zone identified in under 60 seconds
  - Compose: title ≤50 chars, body ≤100 chars — Apple and Google hard limits
  - Dispatch: batched FCM + APNs with delivery confirmation and retry
  - Deduplicate: same event from multiple sources = one alert, then updates — not three alerts
  - Never block an official severe warning: severity-5 alerts from official sources skip ranking and suppression
## **5.5 Monetisation**
**Subscription (launch)**
  - Free tier: core weather + government safety alerts. No card required.
  - Paid tier: €2.50/month via StoreKit 2 or Google Play Billing. AI briefings and the assistant are paid-tier features from Phase 2 — the main upgrade driver.
  - Pricing test: competitors' premium tiers are priced several times higher (Citizen's top tier lists at $14.99). Test a €4.99 family plan against €2.50 in Phase 1 (Decision 17).
  - Alternative: users pay via data permissions — no card, no platform commission
**Data monetisation (consent from launch; revenue once volumes allow — Decision 25)**
  - Consent is asked at onboarding from launch, so the data base grows from day one. Selling needs volume: aggregated insights are only meaningful (and only safely de-identified) with enough users per area. Realistic first revenue: Phase 2 with a first insurer or city partner; full programme Phase 3.
  - 25% of users opt in — €10/user/year average
  - Aggregated, de-identified insights to insurers, urban planners, logistics firms
  - Strictly GDPR-compliant — no PII, no individual-level data sold
**Insurer B2B2C (pilot Phase 1, live Phase 2) — lead channel**
  - Embedded alerts in the insurer's app, or a co-branded Hey-Okay offered to policyholders
  - Value to the insurer: fewer and smaller claims (storm, flood, heat, burglary) and a reason to open their app
  - Commercial model open: per-policyholder fee, annual licence or revenue share (Decision 18)
**B2B partnerships (Phase 2)** — structure to agree (Decision 26)
  - €20K per partner per year. 3 partners in Year 1, 5+ by end of Year 2.
  - API integration plus AI incident summaries for org admins
  - Give and take: what we give — alerts in their app or a co-branded app, an API, aggregated relevance insights, co-marketing. What we get — distribution to their customers or staff, a fee or revenue share, data feeds we can't get elsewhere (e.g. transit, venue or insurer claims patterns), and a reference customer.
App Store commission: 15–30% on in-app subscriptions — €0.38–€0.75 per user/month on €2.50. Web checkout avoids this but adds friction. Decision needed before launch.
# **6. AI Capabilities**
AI runs through the whole product: reading sources, scoring risk, choosing who gets told, writing the alert, and learning from every rating. One rule applies everywhere: the AI never invents a fact. Every alert and every assistant answer is built from a source record we can show the user.
## **6.1 What the AI does**
| **\#** | **Capability** | **What it does for the user** | **How it works** | **Phase** |
| :- | :- | :- | :- | :- |
| 1 | **Source reading & extraction** | Alerts from sources no other app reads — police press releases, transit disruption notices, local news, municipal bulletins | LLM structured extraction into one event schema: type, location, time, severity cues, source. Geocoding to coordinates. Sources include police press releases (e.g. Presseportal Blaulicht) and transit operator feeds. | MVP |
| 2 | **Classification & severity** | Every alert has a category and a 1–5 severity that means the same thing across sources | LLM + rules. Official warning levels (DWD, NINA) always override the model. Each score carries a confidence value. | MVP |
| 3 | **Event clustering & dedup** | One alert per event, then updates — not five copies from five sources | Text embeddings + geo/time proximity. Merges reports into a single evolving event. | MVP |
| 4 | **Impact zone** | Only people actually affected are told — a road segment, a storm path, a district | Rules for official polygons; LLM-assisted radius for unstructured events. Learned estimates in Phase 2. | MVP basic · P2 learned |
| 5 | **Alert writing** | Two clear lines on the lock screen: what, where, what to do | LLM writes within 50/100-char limits from the event record only. A verifier checks every fact against the source before dispatch. German and English at MVP (Germany, US, India); Hindi in Phase 2; more EU languages after seed. | MVP |
| 6 | **Personal relevance ranking** | Fewer, better alerts. Your route, your places, your history — not the whole city | Rules at launch (distance, category, time). From Month 6, a ranking model trained on ratings, opens and dismissals decides: send now / add to digest / suppress. | MVP rules · P2 model |
| 7 | **Alert fatigue control** | The app gets quieter and smarter over time | Daily alert budget, bundling into digests, quiet hours. Severity-5 official warnings always break through. | MVP rules · P2 learned |
| 8 | **"Hey, okay?" check-ins** | After a serious event near a family member, the app asks them "Are you okay?" — one tap tells the family | Triggered by severity ≥4 events in a linked member's zone. Gentle reminder if no response; never auto-contacts emergency services. | Phase 2 |
| 9 | **Ask Hey-Okay assistant** | Ask "Is it safe to drive to Munich tonight?" and get a sourced answer | Retrieval over live events, official guidance and the user's saved places. Cites sources. Refuses outside its scope. Always points to 112 / 911 in an emergency. | Phase 2 · paid |
| 10 | **Daily & trip briefings** | A 30-second morning or pre-trip summary of what to watch for | LLM summary of active events on the user's route and destinations. | Phase 2 · paid |
| 11 | **Accessibility** | Alerts read aloud; a simple-language mode for older users | On-device text-to-speech; plain-language rewrite at composition time. | Phase 2 |
| 12 | **On-device context** | Personalisation without sending location history to our servers | Core ML / TensorFlow Lite learn significant places and commute patterns on the phone. Only coarse context leaves the device. | Phase 2 |
| 13 | **B2B incident summaries** | Org admins get a plain-language incident report and delivery analysis | LLM summary over delivery logs and event records. | Phase 2–3 |
| 14 | **Risk outlook** | What is likely to happen next where you and your family are — e.g. 38 °C at your mother's address tomorrow, a storm front arriving tonight | MVP: forecasts and official pre-warnings (heat from weather forecasts, DWD / NWS / IMD forecasts) — heat at saved places is already built. Phase 3: 6 / 12 / 24-hour scores from time-series and historical incident models per category. | MVP basic · P3 learned |

## **6.2 The pipeline**
| **Step** | **What happens** | **Target** |
| :- | :- | :- |
| 1\. Ingest | Structured feeds polled or streamed; unstructured sources scraped from an approved list | Continuous |
| 2\. Extract | LLM turns text into a structured event record | ≥95% field accuracy |
| 3\. Cluster | Merge with existing events or open a new one | \<1% duplicate alerts |
| 4\. Score | Category, severity 1–5, confidence. Official levels override. | ≥90% severity agreement with official levels |
| 5\. Review | Severity ≥4 or low confidence → Alert Desk (human) in MVP | \<3 min review |
| 6\. Match | Users in the impact zone and saved places | \<60 sec |
| 7\. Rank | Per-user send / digest / suppress decision | ≥85% rated relevant |
| 8\. Compose + verify | Write the alert; verifier blocks any fact not in the source | 100% source-grounded |
| 9\. Dispatch | FCM + APNs, retry, delivery receipts | p90 event-to-push \<60 sec structured, \<3 min unstructured |
| 10\. Learn | Ratings, opens, dismissals feed the ranking model and the eval set | Weekly retrain from Phase 2 |

## **6.3 Guardrails**
A safety app that sends a false alarm, or misses a real one, loses trust permanently. These are requirements, not nice-to-haves.
| **Risk** | **Guardrail** |
| :- | :- |
| AI invents a fact | Generation only from the event record. Automated verifier compares every number, place and time with the source. No source = no alert. |
| Wrong severity | Official warning levels override the model. MVP: human Alert Desk reviews every severity ≥4 and every low-confidence event. |
| Missing a critical alert | Severity-5 official warnings bypass ranking, digests and daily limits. |
| Bias in crime data | We report events, not "dangerous neighbourhoods". No area-level crime scores at MVP. Quarterly bias review of crime alerts by district. |
| Location privacy | No raw coordinates or user identifiers in LLM prompts — coarse geohash only. EU-region inference for EU users, zero-retention terms and DPAs with every AI vendor. India: the Digital Personal Data Protection Act applies to Indian users; where their data lives is part of Decision 27. |
| Unsafe advice | Recommended actions come from a library of official guidance (BBK, DWD, health authorities), not free generation. The assistant always defers to 112 / 911. |
| Vendor outage or lock-in | Model abstraction layer; two LLM providers; template fallback if both are down — alerts still go out. |
| Regulation (EU AI Act) | AI-written content labelled in-app. Legal classifies the system before launch. Model cards, eval results and decision logs kept from Day 1. |

## **6.4 Build vs buy — AI**
| **We buy** | **We build (our IP)** |
| :- | :- |
| Foundation LLMs via API (Anthropic Claude, OpenAI, Mistral) — EU data residency. Evaluate Mistral (EU company) and open-weight models self-hosted in the EU for data sovereignty and cost (in use today: Claude for extraction and writing, Mistral for embeddings) | Extraction schemas and prompts for each source type |
| Embeddings API + pgvector in PostgreSQL | The relevance ranking model and its features |
| Text-to-speech (on-device OS voices) | The fact verifier and guardrail layer |
| Experiment tracking and monitoring (e.g. Langfuse, Weights & Biases) | The labelled evaluation set — 500 real events at launch, growing weekly |
|  | The feedback loop: ratings → training data → better ranking |

## **6.5 AI KPIs**
| **Metric** | **Definition** | **MVP target** | **Phase 2 target** |
| :- | :- | :- | :- |
| Extraction accuracy | Fields correct vs labelled eval set | ≥95% | ≥97% |
| Severity agreement | Matches official warning level where one exists | ≥90% | ≥95% |
| False alert rate | Alerts later shown to be wrong or not happening | \<2% | \<1% |
| Source grounding | Alerts whose every fact traces to a source | 100% | 100% |
| Relevance | Alerts rated relevant by users | ≥85% | ≥92% |
| Event-to-push time (p90) | Structured / unstructured sources | \<60 sec / \<3 min | \<30 sec / \<2 min |
| Human review load | Share of alerts needing Alert Desk review | \<15% | \<5% |
| AI cost | LLM + embeddings cost per monthly active user | \<€0.05 | \<€0.08 incl. assistant |

## **6.6 AI cost**
| **Item** | **MVP / month** | **Phase 2 / month** | **Notes** |
| :- | :- | :- | :- |
| LLM extraction + alert writing | €300–800 | €1,000–2,500 | Mostly scales with sources and events. Grows with users where text is personal (per-person wording, more places, more markets) |
| Embeddings + vector search | €50–150 | €150–400 | pgvector inside the main database |
| Assistant + briefings | — | €500–1,500 | Paid tier only; rate-limited |
| Eval, monitoring, experiment tools | €100–300 | €200–500 |  |
| **Total AI run cost** | **€450–1,250** | **€1,850–4,900** | Budgeted at €36K for 12 months (Section 10) |

**Does AI cost grow with users?** Partly, yes. Reading a source and writing one alert costs the same whether 10 or 10,000 people get it, so the core pipeline grows with the number of events, sources and markets. Per-user features grow with users: the assistant, briefings, and personal wording. Countermeasures: a cost-per-MAU KPI (Section 6.5), a daily spending cap with the template fallback, smaller and cheaper models where quality allows, and a quarterly model review, since prices per token keep falling and new models (including Mistral and open-weight ones) change the best choice quickly.

# **7. How It Works**
## **7.1 Consumer (iOS + Android)**
| **Step** | **What the user does** | **What the app does** |
| :- | :- | :- |
| 1 | Downloads + opens app | Onboarding. Starts anonymous; optional sign-in (email code built; Apple / Google next) to restore on a new phone. GDPR consent captured. |
| 2 | Sees value explanation, grants location | Geofence engine starts. Preference profile created. |
| 3 | Picks alert categories | Saved to profile. Background monitoring begins. |
| 4 | Does nothing — that's the point | AI reads sources, detects an event in the user's zone, scores it, checks relevance, writes and verifies the alert. |
| 5 | Receives notification on lock screen | APNs or FCM delivery. Deep link to alert detail. |
| 6 | Taps through, reads the alert | Risk, severity, map, what to do, source link. |
| 7 | Marks it relevant or not | Feedback logged. Ranking model learns. |
| 8 | Upgrades or adjusts settings | StoreKit / Play Billing flow, or preferences saved. |

## **7.2 B2B (Organisation via API)**
| **Step** | **What the admin does** | **What the system does** |
| :- | :- | :- |
| 1 | Signs up via web admin portal | Account created. KYC done. API credentials issued. |
| 2 | Configures alert zones + employee groups | Geofence rules saved. Invite links generated. |
| 3 | Employees install via invite link | Accounts linked to org. Preferences inherit from admin config. |
| 4 | Risk event in a configured zone | Alert dispatched to affected employees. |
| 5 | Reviews the incident | AI incident summary + delivery rate, open rate, zone coverage. |
| 6 | Invoice generated | Stripe invoice sent monthly per agreed tier. |

# **8. Go-to-Market & Roadmap**
*Launch in Germany, the US and India together, one city each, on one shared engine. Expand market by market after Month 6.*
## **8.1 Market sequence**
| **When** | **Market** | **Why** | **How we enter** |
| :- | :- | :- | :- |
| Pre-launch | Berlin · San Francisco Bay Area · Bengaluru | One dense city per launch market; pilot users in each | Concierge MVP, 30–50 users per city |
| Months 1–6 | **Germany** — Berlin, then Munich, Hamburg, Cologne | No Citizen; official apps leave the gap open | App launch in Month 4 + first insurer pilot by Month 6 |
| Months 1–6 | **USA** — California first | Citizen and Life360 prove people pay for safety. Our wedge: verified, privacy-first, family places without tracking. Open official data (National Weather Service, FEMA IPAWS). Floriane is US-based. | App launch in Month 4 in California; insurer / B2B partner talks in parallel |
| Months 1–6 | **India** — Bengaluru, then Mumbai and Delhi | Huge smartphone base, frequent heat, monsoon floods and urban disruption; official CAP alerts (NDMA SACHET) with no personal layer | App launch in Month 4 in English; local price point; partnerships with employers and residents' associations |
| Months 7–9 | Austria + Switzerland, UK | DACH needs no new language; UK has no Citizen | Insurer partners with DACH reach |
| Months 10–12 | Deepen the three launch markets; Netherlands pilot (decision) | Prove retention and revenue per market | Partner-led |

**Three launch markets with one small team.** It works because the product is one engine with *country packs*: each market adds its sources, emergency numbers, language and prices, not a new app (already built for Germany and the US). Rule: one city per market at launch, the same release for all three, and a go / no-go per market at Month 6 based on the KPIs in Section 13.

## **8.2 Channels**
| **Channel** | **How** | **Owner** | **When** |
| :- | :- | :- | :- |
| **Insurer B2B2C** | Pitch claim prevention (storm, flood, heat, burglary) to public and private insurers. Embedded alerts in their app or a co-branded Hey-Okay. Lead channel. | CEO | Pilot Months 4–6 |
| Concierge → family referral | Pilot users invite family members; family plan built in | CPTO | Pre-launch |
| Moments of need | Campaigns around storm season, heat waves and big events (festivals, football, New Year's Eve) | CEO + agency | Month 4+ |
| ASO long-tail | Searches NINA doesn't own: Unwetter, Polizeieinsatz, S-Bahn Störung, Hitze | Agency | Month 4 |
| Transit & city partners | Data and distribution with transit operators and municipalities | CEO | Month 3+ |
| Trust-led PR | "The safety app that doesn't map dangerous neighbourhoods" | CEO | Launch |
| US: privacy-first launch | California wildfire and heat season; "the verified alternative to crowd-sourced crime apps" | CEO + CPTO | Month 4 |
| India: partners | Employers (commute and campus safety), residents' associations, monsoon-season campaigns | CEO | Month 4+ |

Budget: shift \~€25K of the €80K marketing line from paid acquisition to insurer co-marketing and event partnerships. Total budget unchanged.
## **8.3 Roadmap**
| **Phase** | **When** | **What ships** |
| :- | :- | :- |
| Pre-launch | Once ready | Concierge MVP: 30–50 pilot users each in Berlin, the Bay Area and Bengaluru. Manually curated alerts via a push broadcast tool. Measure open rates, D7 retention, and the share of relevant alerts NINA didn't send. **Every curated alert is labelled — this becomes the first AI evaluation set.** |
| Phase 1 — Launch | Months 1–6 · live in Month 4 | iOS + Android (React Native). APNs + FCM. OS-level geofencing. 5 categories: weather, crime/police, transit, public safety, technology (outages, cyber attacks). Official warnings passed through (NINA / MoWaS, NWS / IPAWS, NDMA SACHET). Germany, US (California) and India (Bengaluru). AI extraction, classification, dedup and alert writing with human Alert Desk review. German and English. Freemium live. First ranking model trained on real ratings by Month 6. First insurer pilot signed. Target: 10,000 MAU across the three markets by Month 6. |
| Phase 2 — Growth | Months 7–9 | Learned relevance ranking + fatigue control. Austria + Switzerland, then UK. Hindi. B2B API, admin dashboard, AI incident summaries — first 3 org clients, at least 1 insurer live. Saved locations, family plan, "Hey, okay?" check-ins, widgets. Ask Hey-Okay assistant and briefings (paid). Target: 50,000+ MAU. |
| Phase 3 — Scale | Months 10–12 | Deepen DACH; Netherlands pilot if approved. Data monetisation live. Predictive risk scoring. On-device context models. Apple Watch + Wear OS. Target: 100,000 MAU, \~€0.5M ARR run-rate, Series A-ready. |

**ARR check:** at 100K MAU (price €2.50 to be confirmed; lower local price in India) — 5,000 paid users × €2.50 × 12 ≈ €150K (≈€120K after store fees) + data monetisation 25K opted-in users × €10 ≈ €250K + 3 B2B partners × €20K = €60K → **\~€0.45–0.5M **A family plan at €4.99 or a larger insurer deal moves this number.
# **9. Team**
Two founders and a four-person AI-native engineering team from Day 1: a lead, two senior full-stack engineers and an AI engineer. Everyone builds with AI coding tools. Specialists phased in.
## **9.0 Why an AI-native team**
|  | **What changes** |
| :- | :- |
| Where AI coding tools help most | Hey-Okay is a new codebase. Studies find AI coding tools work best on new systems built from scratch, and worst on large existing codebases — so this is the favourable case. |
| What speeds up | App screens, backend features, parsers for dozens of German sources, automated tests, the AI evaluation set |
| What doesn't | Apple review and the Critical Alerts entitlement, real-device location testing, data and insurer contracts, the concierge pilot, collecting ratings to train the ranking model |
| Guardrails | Senior review of all AI-written code; security review before launch; App Store specialist kept |
| The payoff | Launch in Month 4 instead of Month 6 — two extra months of real user data before the Series A |

## **9.1 Who does what**
| **Role** | **Owns** | **Type** | **When** |
| :- | :- | :- | :- |
| **CEO & President — Benjamin Perlzweig** | Company strategy, fundraising, investor relations, data partnerships, B2B sales, finance, legal and entity setup, go-to-market, board | €150K base | Day 1 |
| **CPTO — Floriane Gramlich** | Product and technology: roadmap, PRD, architecture sign-off, AI strategy and AI quality, mobile UX, engineering leadership, data governance with the DPO | €225K base | Day 1 |
| Lead Engineer (reports to CPTO) | Architecture, React Native, code quality, CI/CD, DevOps, security. Must write code. | Full-time salaried · €150K gross | Month 1 — critical |
| **2 × Senior AI-native full-stack engineers** | React Native app (push, geofencing, maps, subscriptions) and backend (ingestion, matching, dispatch). Build with AI coding agents; replace three offshore engineers. | Full-time nearshore · \~€8K/month each | Month 1 — critical |
| UX/UI Designer | 6–8 week sprint: onboarding, alert UI, AI labelling, iOS HIG + Material You. Retainer after. | Sprint €12K + retainer | Month 1 |
| **AI/ML Engineer** | Extraction, classification, ranking model, verifier, evaluation set. Owns AI KPIs. Reports to CPTO. | part-time contract-to-hire · €9K/month | Month 1 — the AI pipeline is the product |
| **Alert Desk Analysts** | Human review of severity ≥4 and low-confidence alerts; label data for evals. German-speaking. | Part-time offshore · €2.5K/month total | Month 3 — internal beta |
| iOS/Android Specialist | App Store submission: APNs, Critical Alerts entitlement, privacy labels, Play compliance. | 4–6 week contract · €20K | Month 3 — pre-submission |
| QA (part-time) | Real-device testing via BrowserStack; AI-written tests cover the rest. | Part-time · €3K/month | Month 5 — after launch |
| Legal / DPO | Entities, GDPR, EU AI Act review, privacy labels, data contracts. | Contracted · €35K | Month 1 |

*On salary levels:* hiring is location-agnostic — we take the best person wherever we find them. Engineers with 10+ years' experience command these rates even in Europe; in the US a lead would be at about $250K base. Pay is base salary plus equity only: no bonus, no RSUs. Nearshore remains an option per role (Decision 23).
| Growth / ASO | ASO, Apple Search Ads, Google UAC. Launch agency. | Agency · in marketing budget | Month 4 |

## **9.2 Where founders are employed**
This answers the open v5 comment: the 20% employer-cost figure was a German assumption and didn't hold for either founder.
|  | **Benjamin Perlzweig** | **Floriane Gramlich** |
| :- | :- | :- |
| Role | CEO & President | CPTO |
| Based in | Germany | California, USA |
| Employing entity | Hey-Okay UG (German payroll) | US entity — Delaware corporation (proposed), US payroll |
| Base salary | €150,000 | €225,000 equivalent, paid in USD |
| Employer on-costs | \~€20K. German contributions are capped: pension and unemployment on €101,400; health and care on €69,750 (2026). May be lower — a 50% shareholder-managing director is often exempt from social insurance (status check needed). | \~€14K statutory: Social Security 6.2% capped at $184,500 (2026), Medicare 1.45% uncapped, small FUTA / CA unemployment. Plus \~€18K health benefits. |
| Annual employer cost | **\~€170,000** | **\~€257,000** |
| To confirm | Social-insurance status check (Statusfeststellung); managing director contract; how on-costs work for a part-time start, and whether part time is OK with WAD | US entity formation; intercompany agreement so the US entity's costs are funded from the seed round; cross-border tax advice |

All founder figures are **gross base salaries**, not net. With the €5M scenario (Section 10.5) both founders are full time from Day 1 at €300K base each. With €2M, a part-time start is possible (Decision 28).
## **9.3 Build vs buy**
| **We use what exists** | **This is our IP** |
| :- | :- |
| Push: Expo Push Service (relays to APNs + FCM; direct integration later if needed) | Geolocation matching engine |
| AI coding agents and assistants for the engineering team | Our review rules and test suites for AI-written code |
| Crash reporting: Sentry (server, EU region) + Firebase Crashlytics (app, opt-in) | AI extraction, classification and ranking models (Section 6) |
| Payments: StoreKit 2 + Google Play Billing | Alert writing + fact verifier |
| OTA updates: Expo EAS Update (chosen and set up) | Data ingestion pipeline — many feeds, one schema |
| CI/CD: GitHub Actions + EAS Build | The labelled evaluation set and feedback loop |

# **10. Budget — €2,000,000 over 12 Months**
Founders are salaried from Day 1. Engineering is a salaried lead, two senior AI-native engineers and an AI engineer, all from Month 1. 35% of the fund is held in reserve. At the Month-12 burn of \~€101K/month, the reserve adds roughly seven months — **\~19 months total runway**.
*Note: the v5 budget chart image needs re-rendering with these figures.*
## **10.1 People — 12 months**
| **Who / What** | **Annual cost (employer)** | **Notes** |
| :- | :- | :- |
| CEO & President — Benjamin Perlzweig | €170,000 | €150K base + \~€20K capped German contributions |
| CPTO — Floriane Gramlich | €257,000 | €225K base + \~€14K US payroll taxes + \~€18K health benefits |
| Lead Engineer | €170,000 | €150K gross + \~€20K capped employer contributions. Equity alongside salary. |
| 2 × Senior AI-native full-stack engineers (12 mo) | €192,000 | \~€8K/month each, nearshore. Replaces 3 offshore engineers (€147K in v6.1). |
| UX/UI Designer | €18,000 | €12K sprint + €6K retainer |
| AI/ML Engineer (M1–12) | €108,000 | €9K/month × 12. Starts Month  |
| Alert Desk Analysts (M3–12) | €25,000 | €2.5K/month part-time, offshore |
| iOS/Android Specialist (M3) | €20,000 | 4–6 week contract |
| QA part-time (M5–12) | €24,000 | €3K/month |
| **PEOPLE SUBTOTAL** | **€984,000** | **49% of fund** |

## **10.2 Operations — 12 months**
| **What** | **Cost** | **Notes** |
| :- | :- | :- |
| Legal + DPO + EU AI Act review | €35,000 | Entity work, GDPR, privacy labels, data contracts, AI Act classification |
| US entity, payroll & cross-border tax | €15,000 | Delaware formation, registered agent, payroll provider, accountant. New in v6. |
| Data API licences | €40,000 | DWD, OpenWeatherMap, crime and geopolitical feeds |
| AI inference, embeddings & eval tooling | €36,000 | See Section 6.6. Was \~€2K inside infra in v5. |
| Cloud + SaaS infrastructure (excl. AI) | €15,000 | Fly.io, Supabase, Vercel, Expo / EAS, Sentry, analytics, BrowserStack, CI/CD (Section 10.4) |
| AI coding tools | €15,000 | Coding agent and assistant seats for the engineering team. New in v6.2. |
| Security review / penetration test | €12,000 | Before launch — AI-written code gets an outside check. New in v6.2. |
| Marketing + UA | €80,000 | Launch agency for ASO; Apple Search Ads + Google UAC; \~€25K shifted to insurer and event co-marketing (Section 8.2) |
| US + India market entry | €35,000 | Local legal review (US privacy, India DPDP Act), source licences, localisation, India entity or partner. New in v6.5. |
| Travel + events + office | €30,000 | Up from €20K — founders on two continents |
| App developer accounts | €125 | Apple €99/yr + Google €25 |
| **OPS SUBTOTAL** | **€313,125** | **16% of fund** |

## **10.3 Summary**
|  | **Amount** | **% of €2M** | **v5** |
| :- | :- | :- | :- |
| People | €984,000 | 49% | €959,000 · 48% |
| Operations | €313,125 | 16% | €183,125 · 9% |
| **TOTAL DEPLOYED** | **€1,297,125** | **65%** | €1,142,125 · 57% |
| **Reserve / working capital** | **€702,875** | **35%** | €857,875 · 43% |
| **TOTAL** | **€2,000,000** | **100%** |  |

**Founder pay: \~€427K employer cost, 21% of the round.** Benjamin €150K and Floriane €225K base. Above seed medians; the CPTO figure reflects the higher-cost US market and full time.
## **10.5 Scenario: €5M over 24 months (for internal discussion)**
Requested in review: what a larger round buys. Same plan for the first 12 months, but founders full time at €300K base each from Day 1, then a second year that scales the team and marketing across the three launch markets plus DACH and the UK.

| **Line** | **Year 1** | **Year 2** | **24 months** | **Notes** |
| :- | :- | :- | :- | :- |
| CEO — Benjamin Perlzweig | €320,000 | €320,000 | €640,000 | €300K base + \~€20K capped German contributions |
| CPTO — Floriane Gramlich | €334,000 | €334,000 | €668,000 | €300K base + \~€16K US payroll taxes + \~€18K health benefits |
| Lead Engineer | €170,000 | €170,000 | €340,000 | As in 10.1 |
| Senior AI-native engineers | €192,000 | €384,000 | €576,000 | 2 in Year 1, 4 in Year 2 (\~€8K/month each) |
| AI/ML Engineer | €108,000 | €144,000 | €252,000 | Full time in Year 2 (€12K/month) |
| UX/UI Designer | €18,000 | €24,000 | €42,000 | Retainer in Year 2 |
| Alert Desk Analysts | €25,000 | €60,000 | €85,000 | Coverage across three time zones in Year 2 |
| iOS/Android Specialist | €20,000 | — | €20,000 | |
| QA | €24,000 | €36,000 | €60,000 | |
| Partnerships / insurer lead | — | €100,000 | €100,000 | New in Year 2 |
| **People** | **€1,211,000** | **€1,572,000** | **€2,783,000** | 56% of €5M |
| Operations | €313,125 | €637,125 | €950,250 | Year 2: marketing €300K, data licences €80K, AI €72K, cloud €40K, legal + entities €65K, other €80K |
| **Total deployed** | **€1,524,125** | **€2,209,125** | **€3,733,250** | 75% of €5M |
| **Reserve** | | | **€1,266,750** | 25% — at the Month-24 burn of \~€184K/month, about 7 more months: **\~31 months runway** |

Founder pay in this scenario: \~€1.31M employer cost over 24 months, 26% of the round. All figures are assumptions for discussion, to be validated before any investor material (Decision 24).

## **10.4 Infrastructure — monthly (excluding AI, see 6.6)**
What runs today, and the EU-sovereign alternatives we can move to.

| **Service** | **In use today** | **EU-sovereign alternatives** | **MVP / month** | **Phase 2 / month** | **Notes** |
| :- | :- | :- | :- | :- | :- |
| App servers | Fly.io, Frankfurt | Hetzner, OVHcloud, IONOS, Scaleway, STACKIT | €20–300 | €300–1.5K | Docker image; API and worker machines scale separately |
| Database | Supabase Postgres, Frankfurt | Managed Postgres at OVHcloud, Scaleway, STACKIT, IONOS; self-hosted on Hetzner | €0–100 | €100–600 | PostgreSQL + PostGIS + pgvector; standard Postgres, so it can move |
| Web app | Vercel | Self-host on the same EU servers; Bunny CDN | €0–20 | €20–100 | Static-friendly Next.js |
| Push notifications | Expo Push Service → APNs + FCM | Direct APNs + FCM | €0 | €0–100 | APNs and FCM are Apple's and Google's; no EU alternative exists for delivery to phones |
| Maps | OpenStreetMap | Self-hosted OSM tiles; Mapbox | €0–200 | €200–1K | |
| Event queue | Inside Postgres (built) | — | €0 | €0–500 | Kafka only if volumes require it |
| Analytics | — (not yet chosen) | Matomo, PostHog EU | €0–200 | €200–800 | Decision 9 |
| Error tracking | Sentry (EU region) + Firebase Crashlytics (app, opt-in) | GlitchTip (self-hosted) | €0–30 | €30–100 | |
| CI/CD + builds + device tests | GitHub Actions, EAS Build / Update, BrowserStack | GitLab (self-hosted) | €0–300 | €300–900 | |

**Data sovereignty.** All user data is stored in the EU today (Fly Frankfurt, Supabase Frankfurt). Fly.io, Supabase, Vercel and Expo are US companies, which means US legal access (CLOUD Act) remains a question even for EU-hosted data. The stack is portable: a Docker image and standard Postgres, so moving to an EU-owned provider takes days, not months. US users' data can stay in the US, and Indian users' data must follow India's DPDP Act. Decision 27 settles where each market's data lives and whether we move to EU-owned providers before launch.

# **11. Risks**
| **Risk** | **Why it matters** | **What we do about it** |
| :- | :- | :- |
| iOS Always On location denied | Without background location, the core product doesn't work. | Pre-permission value screen. Target 60%+ opt-in. Test messaging in concierge phase. |
| Push opt-in below target | Fewer reachable users. | Ask after the first value moment. A/B test pre-permission screens. |
| False or wrong AI alert | One viral false alarm can destroy trust in a safety app. | Source-grounded generation, fact verifier, official levels override, human Alert Desk for severity ≥4. False alert rate KPI \<2%. |
| Missed critical alert | Worse than a false alarm. | Severity-5 official warnings bypass all ranking and limits. Multi-source ingestion. |
| EU AI Act / AI regulation | Obligations depend on how the system is classified. | Legal review before launch; transparency labels; logs and model cards from Day 1. |
| LLM vendor dependency or cost spike | Pipeline stalls or margins shrink. | Two providers behind an abstraction layer; template fallback; cost per MAU tracked monthly. |
| Apple rejects the app | Two-week delay minimum. | Specialist contracted Month 3. 2-week review buffer before the Month 4 launch. |
| Alert fatigue kills retention | Notifications off → deletion. | Daily budget, digests, learned ranking. D30 retention ≥20%. |
| GDPR breach | Location data = high scrutiny. | Privacy-by-design. DPO from Month 1. No raw location in AI prompts. On-device context in Phase 2. |
| Data source failure | Alerts stop when a feed goes down. | Fallback source per category. |
| Battery drain complaints | Bad reviews, uninstalls. | Region monitoring, not continuous GPS. Battery tested in beta. |
| A competitor enters DACH (Citizen, Life360, funded AI startup) | Our window in Germany closes. | Insurer pilot and German source coverage before Month 6. Trust and privacy positioning they can't easily match. See Section 3.6. |
| NINA expands into our territory | A free official app with \~14M users gets better. | Integrate and credit NINA; own crime, transit, local events and family — outside its mandate. |
| Paid tier underpriced | €2.50 may leave revenue on the table and signal low value. | Price test in Phase 1; family plan (Decision 17). |
| AI-written code quality and security | AI coding tools can introduce errors and vulnerabilities; location data raises the stakes. | Senior review of all AI-written code; automated tests; outside security review before launch (€12K). |
| Launch slips back to Month 6 | Speed gain depends on hiring senior AI-native engineers fast. | Start hiring before the round closes; contract-to-hire; the plan still works at Month 6, with less data before Series A. |
| Two-country founding team | Payroll, tax and entity complexity; time zones. | Entity structure confirmed before first payroll (Decision 11). Fixed weekly overlap hours. |
| Three launch markets stretch a small team | Focus, support hours and source quality suffer in all three. | One city per market, one shared engine with country packs, one release for all; go / no-go per market at Month 6. |
| Citizen and Life360 in the US | Strong incumbents with large budgets. | Don't fight on video or tracking; verified, privacy-first, family places; California first. |
| India: different sources, prices and expectations | Lower willingness to pay; data-protection rules (DPDP Act). | Local price point, partner-led distribution, local legal review before launch. |
| Data sovereignty | EU users and partners may reject US-owned infrastructure. | Portable stack (Docker + Postgres); EU-owned providers evaluated (Section 10.4, Decision 27). |

# **12. Decisions We Need to Make**
| **\#** | **Question** | **Owner** | **Urgency** | **Status** |
| :- | :- | :- | :- | :- |
| 1 | React Native or native Swift + Kotlin? Sets the Lead Engineer profile. | CPTO | Critical | **Decided: React Native with Expo** (built) |
| 2 | Firebase FCM + APNs relay or direct integration? | Lead Engineer | Critical | **Decided for MVP: Expo Push Service** (relays to APNs + FCM); revisit at scale |
| 3 | How do we pitch Always On location? What value exchange gets 60%+ opt-in? | CPTO | Critical | Open |
| 4 | Which crime and geopolitical providers have GDPR-compliant EU coverage? | CEO / Legal | Critical | Open |
| 5 | In-App Purchase (15–30% fee) or web checkout at launch? | CEO | High | Open |
| 6 | OTA updates: Expo EAS Update, CodePush, or store releases only? | CPTO | High | **Decided: Expo EAS Update** (set up) |
| 7 | Minimum Android version: API 29 or API 31? | CPTO | High | Open |
| 8 | B2B web admin portal at MVP, or later? | CPTO / CEO | High | Open |
| 9 | Analytics: Mixpanel, Amplitude or Firebase Analytics? | CPTO | Medium | Open |
| 10 | Freemium + data permissions, or paid subscription from the start? | CEO | High | Open |
| 11 | Entity and payroll — UG employs Benjamin, US entity employs Floriane? Intercompany funding? | CEO | Critical — before first payroll | Open |
| 12 | Which LLM providers, and on what EU data residency / zero-retention terms? Include Mistral and open-weight models hosted in the EU. | CPTO / CEO | Critical | Open — in use: Claude (extraction, writing), Mistral (embeddings) |
| 13 | EU AI Act classification and transparency duties. | CEO / Legal | High | Open |
| 14 | Ask Hey-Okay — paid only, or free with a monthly limit? | CPTO / CEO | Medium | Open |
| 15 | Founder base set at €150K (CEO) and €225K (CPTO). Do we agree a step-up at Series A or a milestone? | CEO | Medium | Open |
| 16 | Apply for Apple's Critical Alerts entitlement at launch or Phase 2? | CPTO | Medium | Open |
| 17 | Paid tier at €2.50 (to be confirmed), or test a €4.99 family plan? Local price points for the US and India? | CPTO / CEO | High | Open |
| 18 | Insurer deal model — embedded SDK, co-branded app, or revenue share? Which 5 insurers do we approach first? | CEO | Critical — pilot by Month 6 | Open |
| 19 | How do we approach BBK / NINA — quiet integration, or a formal data partnership? | CEO | High | Open |
| 20 | Phase 3: Netherlands pilot, or stay DACH + UK? | CEO | Medium | Open |
| 21 | US entry: strictly after Series A, or an earlier B2B2C-only pilot with a US insurer? | CEO / CPTO | Medium | **Decided: the US is a launch market** (with Germany and India) |
| 22 | Which AI coding tools become the team standard, and what review rules apply to AI-written code? | CPTO | High — before Month 1 | Open |
| 23 | Senior engineers nearshore (\~€8K/month) or EU-based (higher cost, same time zone)? | CPTO | High | Open — hiring is location-agnostic |
| 24 | Raise €2M (12 months) or €5M (24 months, founders full time at €300K)? | CEO / CPTO | Critical — before investor talks | Open (Section 10.5) |
| 25 | Data monetisation: consent from launch and first revenue in Phase 2, or wait for Phase 3? | CEO | High | Open |
| 26 | Partnership structure with insurers and B2B partners: what we give, what we get | CEO | High | Open |
| 27 | Data sovereignty: stay on Fly.io / Supabase (EU regions) or move to EU-owned providers? Where do US and Indian users' data live? | CPTO / Legal | High — before launch | Open |
| 28 | Founders part time at the start (if €2M), and how that works with current employers (WAD) and German social insurance | CEO / CPTO | High | Open |

# **13. How to Start**
*We don't build the full app until we've proven people want alerts from us.*
Concierge MVP first: 30–50 pilot users each in Berlin, the Bay Area and Bengaluru, a push broadcast tool, 3–5 manually curated alerts per day for 4–6 weeks. Track open rates, D7 retention, which categories drive engagement, and how many relevant alerts NINA didn't send. Label every alert — that labelled set is how we measure the AI from day one.
**Build order:**
  - **Months 1–2:** CPTO + Lead Engineer + 2 senior AI-native engineers + AI engineer, all from Day 1. Concierge pilot runs in parallel. Design sprint. Entity and payroll set up. LLM vendor terms signed. AI-code review rules agreed.
  - **Month 3:** Internal beta. Alert Desk live. iOS/Android specialist for App Store submission. Security review.
  - **Month 4:** Submit to both stores with a 2-week Apple buffer. Go live in Germany, the US (California) and India (Bengaluru).
  - **Month 5:** Part-time QA joins. Insurer pilot integration starts.
  - **Month 6:** First ranking model trained on \~6 weeks of real ratings. Insurer pilot signed. 10,000 MAU.
  - **Month 7:** Phase 2 begins — Austria, Switzerland, UK. Go / no-go per launch market.
**After launch, these are the KPIs:**
| **KPI** | **Red line** | **What it tells us** |
| :- | :- | :- |
| Push opt-in rate | \<50% | The value exchange isn't landing |
| D7 retention | \<35% | Relevance problem |
| Alert open rate | \<25% | Too frequent or too generic |
| Alerts rated relevant | \<85% | Ranking or extraction problem |
| Beyond-NINA rate | \<60% | We're not adding enough over the free official app — no reason to keep us |
| Alerts per user per day | \>1.5 | We're getting noisy — the Citizen trap |
| False alert rate | \>2% | Guardrails or sources need work — fix before growth spend |
| Crash-free rate | \<99% | Code quality problem |

# **14. The Goal**
We're building the layer of safety intelligence that people carry with them — one that learns, adapts, and gets quieter and smarter over time. Not another app to check. Something that runs in the background and tells you when it matters.
Official apps cover official warnings. Citizen and Life360 are built for the US, on crowds and on tracking people. Nobody gives Europe a verified, private, personal safety layer on top of the official one. That's what we're building.
**We want to be the product that one million people trust to tell them when something is about to go wrong near them. We're starting in Germany, the US and India. The rest follows.**
Confidential — For Internal Use Only

# **Change log v6.4 → v6.5**
From the review comments (Benjamin, Floriane), November 2026:
- Launch markets: Germany, US and India (Sections 1, 3, 8, 11, 13; Decision 21 closed).
- Prices added for alternatives and competitors (Sections 2, 3.1, 3.2); our €2.50 marked "to be confirmed".
- Technology added as a risk category (outages, cyber attacks); risk outlook from forecasts is part of the MVP (6.1 #14).
- Ask Hey-Okay: technical and cost implications (5.3); AI cost and users explained (6.6).
- Data monetisation timing, B2B partnership give and take (5.5; Decisions 25, 26).
- LLMs: Mistral and open-weight models in the EU to evaluate (6.4, Decision 12).
- Infrastructure: what runs today, EU-sovereign alternatives, data sovereignty (10.4, Decision 27).
- Salary levels explained (9.1); founder figures are gross; part-time start and WAD check (9.2, Decision 28).
- €5M / 24-month scenario with founders at €300K (10.5, Decision 24); base plan adds €35K for US + India entry.
- Decisions 1, 2 and 6 recorded as decided (what is built).
