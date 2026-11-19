# Hey-Okay roadmap

Source of truth: **PRD v6.5** (`docs/PRD.md`, section numbers in brackets; the Google Doc `HeyOkay_PRD_v6.5` is the editable original). Phase 1 = launch in **Germany, the US (California) and India (Bengaluru)**, Month 4. Phase 2 = Months 7–9. Phase 3 = Months 10–12.

The build agent takes the **first unchecked item** in "Up next", builds it, and ticks it off in the same commit. If an item is too big for one run, it splits it into smaller items here and does the first. Flori steers by reordering, adding or deleting items. Items under "Needs a human" are never picked by the agent.

Items that need accounts or keys (Firebase, RevenueCat or App Store products, Apple sign-in) are built against config placeholders, and the human step is added to "Needs a human".

## Up next

### Phase 1: launch blockers

#### Scale foundation (Flori, 2026-11-18; see docs/ARCHITECTURE.md §8)

- [ ] **Managed Postgres in production** [10.4]: a one-off SQLite → Postgres copy script (users, devices, accounts, places, events, alerts, tickets), a runbook, and `DATABASE_URL` on Fly. Provider: Supabase (Flori, 2026-11-18). Done: copy tool, `DATABASE_SCHEMA`, runbook. Supabase project created and migrated (2026-11-18). Left: Flori runs the switch (runbook).
- [x] **API and worker roles + leader** [10.4]: `ROLE=api|worker|all` (default `all`), a worker lease in the database (takeover when the holder dies, handover on clean stop), role and lease on `/health`. Tests with 8 racing workers: one wins. (2026-11-18; Fly process groups follow with managed Postgres, see ARCHITECTURE §8.)
- [x] **Delivery queue** [6.2 step 9]: `push_jobs` table between matching and push (Postgres migration 8, `FOR UPDATE SKIP LOCKED`); `PUSH_CONCURRENCY` senders claim 500 at a time; a dead sender's jobs return after 5 minutes; queue depth on `/health`. Load test: 20 000 pushes for one event drained in ~1 s on Postgres (without network). (2026-11-18)
- [x] **Country packs, part 1** [8.1]: `server/src/countries.ts` with DE, AT, CH, US (language, emergency/police/medical numbers, units); every source tags its items with a country, events keep it, and the recommended actions name that country's numbers. (2026-11-18)
- [x] **Country packs, part 2** [8.1]: `COUNTRIES=DE,AT` setting that switches each country's sources on, plus the source registry below. (2026-11-18)
#### Launch markets: Germany, US, India (PRD v6.5, 2026-11-18)

- [x] **More alerts: earthquakes** [5.4]: USGS worldwide feed, quakes M4+ in or near Germany, the US and India; felt radius and level from magnitude and USGS PAGER; aftershock advice; German text in Germany. (2026-11-19, Flori: "more alerts, that is the core")
- [x] **More alerts: air quality** [5.4]: OpenWeatherMap air-pollution forecast per grid cell (same key and privacy rule as heat); poor → feed, very poor → may push; later today → "Coming up". (2026-11-19)
- [x] **More alerts: floods (Germany)** [5.4]: PEGELONLINE river gauges (WSV, all ~700 gauges in one request, every 15 min). Above the highest navigable level → feed (sev. 1), above mean flood level → may push (sev. 2), 5 km around the gauge; back to normal → all-clear; out-of-date gauges never lift. Official flood warnings stay with NINA · Hochwasserportal. Live format checked. (2026-11-19; split from "More alerts: fires, floods, Meteoalarm")
- [x] **More alerts: wildfires (US)** [5.4]: NIFC WFIGS current incidents (public, every 5 min). 10+ acres → feed, 100+ → may push (2), 1,000+ → may push (3); half contained or burning > 2 weeks → feed only; 90% contained → no new alert; out / contained / no update for a week → all-clear. 10–40 km around the fire by size. Prescribed burns never. Smoke stays with the air-quality alert. Live format checked. (2026-11-19)
- [ ] **More alerts: Meteoalarm (Europe, CAP)** [5.4, 8.1]: official weather warnings for AT and CH (Germany has DWD), so the country packs have a weather source. Live format check.
  - *Paused 2026-11-19, needs Flori (see CHANGELOG → Open questions):* live check done. `feeds.meteoalarm.org/api/v1/warnings/feeds-<country>` is JSON CAP. Austria (GeoSphere) gives only region codes (`EMMA_ID`, e.g. AT309), no outlines, so it needs a code → outline table first. Switzerland (MeteoSwiss) has outlines, but the feed is 16 MB. Neither country is a launch market, so this may belong with "Sources: Austria, Switzerland, UK" in Phase 2.

- [x] **Country pack India** [8.1, 5.4]: `IN` in `countries.ts` (English; 112, police 100), NDMA SACHET as the official source (RSS → CAP 1.2, English info preferred, exact areas, withdrawn → all-clear) via a shared CAP parser (`sources/cap.ts`). `COUNTRIES=DE,US,IN`. (2026-11-18; feed URL and numbers to confirm on the first live poll.) IMD has no separate adapter: its warnings come through SACHET.
- [x] **US sources beyond the weather service, part 1** [5.4, 8.1]: FEMA IPAWS public feed (CAP) next to NWS — state and local official alerts; NWS messages skipped there. (2026-11-18; URL to confirm on the first live poll.)
- [ ] **US sources, part 2** [5.4]: one California city police/fire feed with clear terms (e.g. a city open-data incident feed), category crime/public_safety. Fixtures and tests.
  - *Skipped 2026-11-18:* needs a feed whose terms allow this use and whose live format can be checked; the sandbox can't do either. Flori or a session with internet access picks the city.
- [x] **Category: technology, part 1 — US outages** [1, 5.4]: new category `technology` in server, app and web (label "Technik" / "Tech outages", colour, icon, settings toggle; switched on once for existing people). Outages from the status pages of Cloudflare, Square, Zoom, Discord, Reddit and Dropbox (Atlassian Statuspage public API; `STATUS_PAGES`). Major incidents in the feed, critical ones may push; whole-US outline; resolved → all-clear. (2026-11-18, Flori: "start with US")
- [ ] **Category: technology, part 2** [1, 5.4]: more US services people rely on (banks, carriers, payment apps — those without Statuspage need their own adapter or official outage reports, e.g. FCC), cyber-attack advisories that matter to consumers (CISA), then Germany (BSI / CERT-Bund, providers) and India (CERT-In). Per-service follow ("only the services I use") so outages stay relevant.
- [x] **Risk outlook (MVP basic)** [6.1 #14]: events that begin more than an hour from now (CAP `onset` from NWS, FEMA IPAWS, SACHET; heat from the first hot forecast hour) go to the feed only, with their start time, and the app and web list them under "Coming up" / "Demnächst" ("from Thu 14:00"), soonest first. When the actual warning follows (no future onset), it is a normal alert and may push. (2026-11-18)
- [x] **AI cost guard** [6.6]: `server/src/llm-budget.ts` prices every model call (`LLM_PRICE_IN/OUT_EUR_PER_MTOK`) and adds it to today's spend in the database (`llm_usage`, Postgres migration 10). Above `LLM_DAILY_BUDGET_EUR` (default €5) calls are skipped and templates take over. One warning at 80% (error log → Sentry). Alert Desk shows today's spend vs budget, calls, 30-day spend and spend per user; Prometheus `heyokay_llm_spend_eur_today`, `heyokay_llm_calls_total`. (2026-11-18)
- [x] **Data-insights consent at onboarding** [5.5, Decision 25]: an optional, separate switch (off by default) on the last onboarding screen and under Settings → Privacy, in app and web; the server stamps when it changed (`insightsConsent`, `insightsConsentAt` in prefs). The text says plainly that nothing is shared yet. (2026-11-18)
- [x] **Observability** [13]: Prometheus metrics on an internal port (`METRICS_PORT` 9091, scraped by Fly via `[metrics]`, never public). The metrics are push latency, pushes sent/failed, queue depth, per-source polls, duration, up and last-OK age, HTTP requests by route pattern, errors by context, and worker lease. Server errors also go to Sentry when `SENTRY_DSN` is set (envelope API, no SDK, 30/min cap, no user data). (2026-11-18; Sentry project and uptime monitor are under "Needs a human".)
- [x] **Staging and release channels** [10.4]: `fly.staging.toml` (app `heyokay-staging`, schema `heyokay_staging` in the same Supabase project), `.github/workflows/deploy-staging.yml` (deploys on push to `agent/next`, skipped until `FLY_STAGING_API_TOKEN` exists), EAS Update (`expo-updates`, `runtimeVersion: appVersion`, channels development/preview/production, `npm run update:preview|production`), and a secrets table in `docs/runbooks/staging.md`. (2026-11-18; one-time setup steps are under "Needs a human".)

- [ ] **Sign-in: Apple + Google** [5.3, 7.1]: verify Sign in with Apple and Google identity tokens on the server (JWKS, audience, expiry), link to the same accounts as email; `apple_sub` / `google_sub` on accounts. Needs the Apple capability and Google client IDs (see "Needs a human"). *(Split from "Sign-in", 2026-11-18.)*
- [x] **Sign-in: screens in the app and the web** [5.3]: an "Account" section at the top of Settings (app and web): email → 6-digit code → signed in (places and settings restored or merged), "Signed in as …" with sign out (fresh anonymous identity; the account keeps its data). Clear messages when email isn't set up yet (503), too many codes (429) or a wrong code. Apple/Google buttons follow with their item. (2026-11-18)
- [ ] **Source: BVG/VBB disruptions** [5.4]: VBB/HAFAS disruption messages mapped to `transit` events, with stations geocoded. Fixtures and tests.
  - *Blocked 2026-11-18, needs Flori:* VBB's official API (HAFAS with disruption messages) needs an access agreement, and BVG's website uses an internal disruptions endpoint with no published terms, which the agent won't build on without permission. See CHANGELOG → Open questions.
- [ ] **Freemium + subscriptions** [5.3, 5.5]: free tier = weather + public safety; paid tier (€2.50/month, price to be confirmed; local price points for the US and India via store price tiers, Decision 17) = all categories and saved places. App: StoreKit 2 / Play Billing via RevenueCat (`react-native-purchases`), a paywall screen, restore purchases. Server: entitlement from store webhooks, enforced in ranking and the places API. Leave room for the €4.99 family plan test (Decision 17). Tests.
- [ ] **OS geofencing** [5.3, 11]: register saved places and the current area as OS geofences (`Location.startGeofencingAsync`; iOS max 20 regions). Re-centre the home region on exit, so continuous updates become a fallback, not the main mechanism. Server hint endpoint for active-event regions.
- [ ] **Digest bucket** [6.1 #7, 6.2 step 7]: ranking returns send / digest / suppress. Digest items are bundled into one push at a user-chosen time (default 18:00) or shown in the feed. Severity-5 official warnings always break through. Tests.
- [x] **Source registry + health** [11 "data source failure"]: `server/src/sources/registry.ts` describes every source (publisher, country, official, category, fallback, docs). The worker saves each source's status to the database after every poll (`source_status`, Postgres migration 9), so any API machine can show it. The Alert Desk has a Sources table (ok / failing / stale / waiting, last OK, last error, fallback) with problems listed first. (2026-11-18)
- [ ] **Second LLM provider** [6.3, 6.4]: a Mistral (EU) implementation of `StructuredLLM` behind an `LLM_PROVIDERS` order with automatic failover; an OpenAI-compatible adapter so open-weight models hosted in the EU can be plugged in; the template fallback stays last. Compare quality and cost on the eval set (Decision 12). Tests with fakes.
- [ ] **AI evaluation harness** [6.4, 6.5]: an `eval/` folder with labelled events (start with the fixtures plus 50 synthetic German cases); `npm run eval` reports extraction accuracy, severity agreement, verifier pass rate and cost per event. Alert Desk approve/edit actions export as new labels.
- [ ] **Decision log + audit** [6.3 EU AI Act]: store every pipeline decision (extraction output, model, prompt version, verifier result, ranking reason) and every Alert Desk action. Admin view and CSV export.
- [ ] **Alert Desk accounts** [6.2 step 5]: individual reviewer logins (password hash, session cookie) instead of the shared token; review-time metric against the target of under 3 minutes.
- [ ] **Product analytics + KPIs** [13]: app events (onboarding steps, permission results, alert opened, rated, notifications disabled) to a provider abstraction (Mixpanel/Amplitude, Decision 9). Server-side KPIs: event-to-push p90, open rate, D7, beyond-NINA, alerts per user per day, false-alert rate (alerts retracted at the desk). Dashboard on the Alert Desk.
- [ ] **Crime bias report** [6.3]: quarterly report of crime alerts by district normalised by population, shown on the Alert Desk; no area-level crime scores anywhere.
- [x] **Offline feed** [5.3]: the phone app keeps the last 20 alerts (and the details of those opened) on the device; without a connection it shows them with "No connection. As of …". Cleared on sign-out and delete. (2026-11-18)
- [ ] **API hardening** [11]: per-token and per-IP rate limits, body size limits, security headers and input fuzz tests.
- [ ] **Data retention** [11 GDPR]: hourly job expiring ended events, alerts older than 30 days and source items older than 7 days, and clearing locations not updated in 30 days. Tests.
- [ ] **App unit tests**: jest-expo with tests for `lib/api`, `lib/theme`, the onboarding steps and the paywall gating.
- [ ] **Deploy config** [10.4]: ~~server Dockerfile, a `fly.toml` (EU region, Frankfurt), a health check and a deploy section in the README~~ (done 2026-11-17, SQLite on a volume for now). Still open: managed Postgres switch (Supabase runbook). EAS Update configured 2026-11-18 (Decision 6). EAS build profiles exist in `app/eas.json`.

### Phase 2: growth

- [ ] **Learned relevance ranking** [6.1 #6]: features from ratings, opens and dismissals; a send/digest/suppress model with a weekly retrain job and offline evaluation against rules; rules remain the fallback.
- [ ] **Learned fatigue control and impact zones** [6.1 #4, #7].
- [ ] **Family sharing** [6.1 #8, 3.3 #4]: family groups, invite links, shared places (protecting places, never tracking people), the family plan entitlement.
- [ ] **"Hey, okay?" check-ins** [6.1 #8]: a severity ≥ 4 event at a family member's place asks them "Alles okay?". One tap tells the family; a gentle reminder follows; it never contacts emergency services.
- [ ] **Ask Hey-Okay assistant** [6.1 #9]: retrieval over live events, the official guidance library and saved places; cites sources; refuses out-of-scope questions; always points to 112; paid tier, rate-limited.
- [ ] **Daily and trip briefings** [6.1 #10]: a 30-second morning or pre-trip summary; paid tier.
- [ ] **Searchable alert history** [5.3].
- [ ] **Home-screen widgets** [5.3]: current risk level (iOS WidgetKit and Android via an Expo config plugin).
- [ ] **Accessibility** [6.1 #11]: read alerts aloud (`expo-speech`) and a simple-language mode generated at composition time.
- [ ] **Hindi** [6.1 #5, 8.1]: Hindi app strings and alert composition for India (English is done for app, web and alert texts since 2026-11-17).
- [ ] **Sources: Austria, Switzerland, UK** [8.1]: AT/CH official warnings and police sources; UK Met Office and police.
- [ ] **B2B API + admin portal** [7.2]: org accounts, API keys, alert zones, employee groups and invite links, plus delivery analytics.
- [ ] **AI incident summaries for orgs** [6.1 #13].
- [ ] **Stripe invoicing for B2B** [7.2].
- [ ] **Insurer embedding** [5.5, 8.2]: a white-label alert feed API and a co-brand configuration (logo, colours, partner categories) for the insurer pilot.

### Phase 3: scale

- [ ] **Opt-in data insights** [5.5]: aggregated, de-identified risk insights with k-anonymity thresholds; consent flow; export for partners.
- [ ] **Predictive risk scoring** [6.1 #14]: 6/12/24-hour outlook per location from historical events.
- [ ] **On-device context** [6.1 #12]: learn significant places and commutes on the phone; only coarse context leaves the device.
- [ ] **Apple Watch + Wear OS** [8.3].

## Needs a human

PRD v6.5 decisions (see PRD Section 12)
- Decision 24: raise €2M (12 months) or €5M (24 months).
- Decision 27: data sovereignty — stay on Fly.io / Supabase EU regions or move to EU-owned providers; where US and Indian users' data lives.
- Concierge pilots: 30–50 users each in Berlin, the Bay Area and Bengaluru.
- India: local legal review (DPDP Act), entity or partner, price point.

Operations
- Staging (10 min, `docs/runbooks/staging.md`): `fly apps create heyokay-staging`, set its secrets, add `FLY_STAGING_API_TOKEN` to GitHub, and set `NEXT_PUBLIC_API_URL` for Vercel previews. Then one `preview` and one `production` EAS build, after which app updates go out with `npm run update:preview|production`.
- Sentry: create a project in the **EU region** (de.sentry.io), then `fly secrets set SENTRY_DSN=… -a heyokay`.
- Uptime monitor on `https://heyokay.fly.dev/health` (e.g. Better Stack or UptimeRobot, 1-minute checks, alert to your phone).
- Charts: Fly dashboard → Metrics (Grafana at fly-metrics.net) shows the `heyokay_*` metrics after the next deploy.

Real devices and stores
- Run the app on a real iPhone and Android phone (development build); verify background location, geofences and push when the app is closed; battery test.
- EAS project (put the `projectId` in `app/app.json`), Apple Developer and Play Console accounts, DUNS number.
- Apply for Apple's Critical Alerts entitlement (Decision 16).
- App Store / Play listings, privacy labels, privacy policy URL; App Store specialist (Month 3).

Accounts and keys
- Firebase project (Crashlytics, FCM): put `GoogleService-Info.plist` and `google-services.json` in `app/firebase/` (see its README), then make a new development build and confirm a test crash shows up in the console.
- RevenueCat plus App Store / Play subscription products (€2.50; €4.99 family test).
- Sign in with Apple capability, Google OAuth client IDs; a mail provider for sign-in codes (built for Resend: `RESEND_API_KEY`, `MAIL_FROM` with a verified sender domain).
- Anthropic and OpenAI keys with EU residency and zero-retention terms and DPAs (Decision 12); Mistral data-retention settings for the embeddings key (key is set on Fly and the DPA applies automatically, 2026-11-18); OpenWeatherMap key (free plan; `fly secrets set OPENWEATHER_API_KEY=…`) and VBB API access.
- Hosting account (Fly.io or AWS in Frankfurt), managed Postgres, admin token.

Decisions (PRD section 12) that the agent needs before the related item is final
- 5: In-app purchase or web checkout.
- 7: Minimum Android version.
- 9: Analytics provider.
- 10: Freemium model.
- 14: Assistant free tier.
- 17: Price test.
- 22: Review rules for AI-written code. Until decided: every agent PR is reviewed by Flori or the Lead Engineer before merge.

Legal and partners
- DPIA, EU AI Act classification, security review / penetration test before launch.
- BBK/NINA relationship, insurer pilot, transit operator data agreements.
- Concierge pilot with 50–100 Berlin users; label every curated alert for the eval set.

## Done

- [x] 2026-11-18 **Sign-in: accounts + email code (server)** [5.3, 7.1] (split from "Sign-in"): devices table (several sign-ins per person), accounts, 6-digit email codes (hashed, 15 min, 5 tries, 5 per hour), restore on a new phone (places merged, settings kept), switching accounts, sign-out with a fresh anonymous identity, GDPR delete of account and all devices; Resend as mail provider. Postgres migration 6. 7 tests per backend.
- [x] 2026-11-18 **Source: heat at saved places** [5.4]: OpenWeatherMap 5-day forecast per 0.1° grid cell holding a saved place or current location (never an exact place), every 3 h; felt ≥ 32 / 35 / 38 °C → severity 1 / 2 / 3, same-day escalation merges; heat-specific advice; titles name the place ("Mama: Hitze: bis 37 °C gefühlt"). Off until `OPENWEATHER_API_KEY` is set. 10 tests (end to end per backend).
- [x] 2026-11-18 **Notification actions** [5.3]: "👍 Relevant" / "👎 Nicht relevant" buttons on every alert push (category `alert`, not on all-clears), recorded without opening the app; Android background task, iOS response listener, offline queue; pushes grouped per incident (`threadId`). Needs a new development build to show the buttons.
- [x] 2026-11-18 **Push receipts + retry** [5.4, 6.2 step 9]: Expo tickets stored per push (`push_tickets`), receipts checked 15 min later; `DeviceNotRegistered` clears the token (at send time too); transient errors resent up to twice; sends retry 429/5xx/network with backoff; delivery counts in the Alert Desk metrics. 7 tests per backend.
- [x] 2026-11-18 **Web app** (Flori's request; not on the roadmap before): `web/`, a Next.js browser version in the look of Flori's v0 design, connected to the real API: Jetzt (current alerts by category, no risk scores), Verlauf, alert detail with feedback, settings (DE/EN, topics, quiet hours, limit, places, delete), onboarding. No push, payments or sign-in. Server CORS now allows PUT/DELETE. 10 web tests, CI job.
- [x] 2026-11-18 **Source: EU-Alert + Feuerwehr Berlin** [5.4]: EU-Alert / Cell Broadcast messages are MoWaS warnings, which NINA already delivers; they now keep their exact warned outlines for matching (up to 60 per warning) and the authority's extra instructions. New `server/src/sources/feuerwehr-berlin.ts` reads the Berliner Feuerwehr incident feed (`einsaetze.xml`) with street and district as the place hint (`FEUERWEHR_BERLIN`, on by default). 9 tests with real fixtures.
- [x] 2026-11-18 **Source: DWD direct** [5.4] (split from "DWD direct + heat"): `server/src/sources/dwd.ts` reads DWD's open-data snapshot of all current warnings (CAP 1.2 in a ZIP, with district polygons) while NINA's DWD channel fails (`DWD_DIRECT=fallback`, default; `always`/`off`); updates merge by CAP reference; warnings dropped from the snapshot early get an all-clear. Small ZIP reader, no dependency. 7 tests on real DWD messages.
- [x] 2026-11-18 **Source: Presseportal Blaulicht** [6.1 #1]: `server/src/sources/presseportal.ts` polls 8 approved agencies in Hamburg, Köln, München and Berlin (Bundespolizei), fetching the full article once per new release; missing-person searches and ceremonies are dropped before any model call; releases placed only at city level go to the Alert Desk. On by default (`PRESSEPORTAL_AGENCIES`). 8 tests with real fixtures. Polizei Berlin, Feuerwehr Berlin and Polizei München aren't on Presseportal.
- [x] 2026-11-18 **Embedding-based dedup** [6.1 #3]: `Embedder` interface with an OpenAI-style HTTP provider (Mistral EU / OpenAI / Voyage, set by env) and a deterministic fake; one vector per event in pgvector (migration 4) or SQLite; clustering compares embedding similarity among nearby, same-category, same-time candidates and falls back to word overlap. 12 tests (pipeline and store tests run per backend). Provider: Mistral `mistral-embed`, live on Fly since 2026-11-18.
- [x] 2026-11-17 **PostGIS matching** [6.4] (split from "Postgres + PostGIS + pgvector"): `Store.usersNear()` returns only users near an event; Postgres uses generated geography columns with GIST indexes (migration 2); SQLite applies the same rule in JS; delivery no longer loops over all users. 3 tests per backend, including a boundary test that both backends agree with `match`.
- [x] 2026-11-17 **Postgres store** [6.4, 10.4] (split from "Postgres + PostGIS + pgvector"): `PgStore` (`pg`) selected by `DATABASE_URL`, numbered migrations under an advisory lock, `server/docker-compose.yml` with PostGIS + pgvector, store contract and end-to-end suites run on Postgres when `TEST_DATABASE_URL` is set; CI has a Postgres service. 2 Postgres-only tests + 1 factory test.
- [x] 2026-11-17 **Async Store interface** [6.4] (split from "Postgres + PostGIS + pgvector"): `Store` is now an async interface in `server/src/store.ts`; SQLite is `SqliteStore`; pipeline, API, server and demo await it; shared store contract tests (7) run per backend via `test/backends.ts`.
- [x] 2026-11-17 **Event updates and all-clear** [5.4]: escalation → new alert; downgrade or end time moved ≥ 1 h → feed update; early end (cancel, vanished from feed, Alert Desk) → all-clear, pushed only to earlier push recipients outside quiet hours; none count toward the daily limit. Ended events greyed out in the app.
- [x] 2026-11-17 **US test mode** (Flori's request): NWS source with exact zone outlines for matching, English alert copy and guidance for English sources, English app UI with a language switch, location-off note in the feed. Part of the Phase 2 **English** item (the app i18n is done; German sources are still composed in German).
- [x] 2026-11-16 **Crash reporting** [5.3, 13]: Crashlytics (`@react-native-firebase/app` + `crashlytics`) wired via `app.config.ts`, enabled only when both Firebase config files are in `app/firebase/`; opt-in toggle in Settings; root `ErrorBoundary` with a calm retry screen that reports; server logs 5xx, ingest failures, unhandled rejections and uncaught exceptions as structured JSON. 4 server tests.
- [x] 2026-11-16 **CI** [9.3]: `.github/workflows/ci.yml` runs server `npm ci` + tests + typecheck and app `npm ci` + `tsc --noEmit` on every push and PR (Node 22, npm cache).
- [x] 2026-11-15 Baseline fix (not a roadmap item): app `npm ci` failed on a peer conflict (react-dom 19.3.1 wanted react ^19.3.1). Pinned `react-dom` 19.3.0 via `npx expo install`, matching Expo SDK 58. CI is still the next item.
- [x] 2026-11-14 Server MVP: NINA + RSS ingest, AI extraction, clustering, review gate, compose + verifier, ranking, Expo push, Alert Desk with manual alerts, GDPR delete. 28 tests.
- [x] 2026-11-14 App MVP: onboarding (pre-permission screens, location, notifications, categories, consent), feed, alert detail (map, severity colour, recommended action, sources, AI label, rating), settings (categories, quiet hours, daily limit), saved places (Phase 2 feature delivered early), background location, push deep links.
