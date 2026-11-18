# Hey-Okay roadmap

Source of truth: **PRD v6.4** (section numbers in brackets). Phase 1 = launch in Germany, Month 4. Phase 2 = Months 7–9. Phase 3 = Months 10–12.

The build agent takes the **first unchecked item** in "Up next", builds it, and ticks it off in the same commit. If an item is too big for one run, it splits it into smaller items here and does the first. Flori steers by reordering, adding or deleting items. Items under "Needs a human" are never picked by the agent.

Items that need accounts or keys (Firebase, RevenueCat or App Store products, Apple sign-in) are built against config placeholders, and the human step is added to "Needs a human".

## Up next

### Phase 1: launch blockers

- [ ] **Source: DWD direct + heat** [5.4]: DWD warnings via the DWD open data CAP feed as a NINA fallback (dedup on CAP id), plus heat thresholds from OpenWeatherMap at users' saved places (for example "38 °C at your mother's address"). Fixtures and tests.
- [ ] **Source: BVG/VBB disruptions** [5.4]: VBB/HAFAS disruption messages mapped to `transit` events, with stations geocoded. Fixtures and tests.
- [ ] **Source: EU-Alert + Feuerwehr Berlin** [5.4]: Cell Broadcast / EU-Alert messages as exposed via NINA (MoWaS), plus Feuerwehr Berlin press releases. Fixtures and tests.
- [ ] **Sign-in** [5.3, 7.1]: Sign in with Apple, Google sign-in and email (magic link) on top of the anonymous device token. Link the existing device user to the account, and restore it on a new phone. Server: account table, verification of identity tokens, session tokens. Tests.
- [ ] **Freemium + subscriptions** [5.3, 5.5]: free tier = weather + public safety; paid tier (€2.50/month) = all categories and saved places. App: StoreKit 2 / Play Billing via RevenueCat (`react-native-purchases`), a paywall screen, restore purchases. Server: entitlement from store webhooks, enforced in ranking and the places API. Leave room for the €4.99 family plan test (Decision 17). Tests.
- [ ] **OS geofencing** [5.3, 11]: register saved places and the current area as OS geofences (`Location.startGeofencingAsync`; iOS max 20 regions). Re-centre the home region on exit, so continuous updates become a fallback, not the main mechanism. Server hint endpoint for active-event regions.
- [ ] **Notification actions** [5.3]: rich notifications with "Relevant" / "Nicht relevant" buttons (notification categories) that post feedback without opening the app; group related alerts via thread id.
- [ ] **Digest bucket** [6.1 #7, 6.2 step 7]: ranking returns send / digest / suppress. Digest items are bundled into one push at a user-chosen time (default 18:00) or shown in the feed. Severity-5 official warnings always break through. Tests.
- [ ] **Push receipts + retry** [5.4, 6.2 step 9]: fetch Expo push receipts, clear tokens on `DeviceNotRegistered`, retry transient errors with backoff, and record delivery status per alert. Tests with a fake Expo endpoint.
- [ ] **Source registry + health** [11 "data source failure"]: a sources table (approved list, category, region, fallback source); the Alert Desk shows the last successful fetch per source and flags failures.
- [ ] **Second LLM provider** [6.3]: an OpenAI implementation of `StructuredLLM` behind a `LLM_PROVIDERS` order with automatic failover and an EU endpoint setting; the template fallback stays last. Tests with fakes.
- [ ] **AI evaluation harness** [6.4, 6.5]: an `eval/` folder with labelled events (start with the fixtures plus 50 synthetic German cases); `npm run eval` reports extraction accuracy, severity agreement, verifier pass rate and cost per event. Alert Desk approve/edit actions export as new labels.
- [ ] **Decision log + audit** [6.3 EU AI Act]: store every pipeline decision (extraction output, model, prompt version, verifier result, ranking reason) and every Alert Desk action. Admin view and CSV export.
- [ ] **Alert Desk accounts** [6.2 step 5]: individual reviewer logins (password hash, session cookie) instead of the shared token; review-time metric against the target of under 3 minutes.
- [ ] **Product analytics + KPIs** [13]: app events (onboarding steps, permission results, alert opened, rated, notifications disabled) to a provider abstraction (Mixpanel/Amplitude, Decision 9). Server-side KPIs: event-to-push p90, open rate, D7, beyond-NINA, alerts per user per day, false-alert rate (alerts retracted at the desk). Dashboard on the Alert Desk.
- [ ] **Crime bias report** [6.3]: quarterly report of crime alerts by district normalised by population, shown on the Alert Desk; no area-level crime scores anywhere.
- [ ] **Offline feed** [5.3]: cache the last 20 alerts and their details on the device; show a "Stand: …" note when offline.
- [ ] **API hardening** [11]: per-token and per-IP rate limits, body size limits, security headers and input fuzz tests.
- [ ] **Data retention** [11 GDPR]: hourly job expiring ended events, alerts older than 30 days and source items older than 7 days, and clearing locations not updated in 30 days. Tests.
- [ ] **App unit tests**: jest-expo with tests for `lib/api`, `lib/theme`, the onboarding steps and the paywall gating.
- [ ] **Deploy config** [10.4]: ~~server Dockerfile, a `fly.toml` (EU region, Frankfurt), a health check and a deploy section in the README~~ (done 2026-11-17, SQLite on a volume for now). Still open: managed Postgres (the server is ready for it via `DATABASE_URL`, with PostGIS), EAS Update (Decision 6). EAS build profiles exist in `app/eas.json`.

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
- [ ] **English** [6.1 #5, 8.1]: i18n for the app (de/en) and English alert composition; the guidance library in English.
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

Real devices and stores
- Run the app on a real iPhone and Android phone (development build); verify background location, geofences and push when the app is closed; battery test.
- EAS project (put the `projectId` in `app/app.json`), Apple Developer and Play Console accounts, DUNS number.
- Apply for Apple's Critical Alerts entitlement (Decision 16).
- App Store / Play listings, privacy labels, privacy policy URL; App Store specialist (Month 3).

Accounts and keys
- Firebase project (Crashlytics, FCM): put `GoogleService-Info.plist` and `google-services.json` in `app/firebase/` (see its README), then make a new development build and confirm a test crash shows up in the console.
- RevenueCat plus App Store / Play subscription products (€2.50; €4.99 family test).
- Sign in with Apple capability, Google OAuth client IDs, an email sender for magic links.
- Anthropic and OpenAI keys with EU residency and zero-retention terms and DPAs (Decision 12); Mistral data-retention settings for the embeddings key (key is set on Fly and the DPA applies automatically, 2026-11-18); OpenWeatherMap and VBB API access.
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
