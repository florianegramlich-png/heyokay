# Hey-Okay: architecture and integrations

Living document. The build agent updates it whenever a component, source, integration or setting changes (see `AGENT.md`). A copy lives in the Claude project "Hey Okey" (`claude/architecture.md`).

Last updated: 2026-11-25 (crime bias review: Frankfurt; data retention task `retention`; API hardening: rate limits, 64 KB bodies, security headers; crime bias review: Hamburg, several cities; crime bias review `/admin/api/crime-bias`, `bias-report.ts`, Berlin districts + population; anonymous app events `POST /v1/events`, `app_events`, onboarding funnel `/admin/api/funnel`, `lib/analytics.ts` in app and web; launch KPIs `/admin/api/kpis`, `last_seen_at`, `opened_at`, retract as false alert; Alert Desk accounts: `reviewers`, sessions, review time; decision log `decisions` + `/admin/api/decisions(.csv)`; AI evaluation harness, `npm run eval`, Alert Desk label export `/admin/api/eval-export`, provider comparison `--compare`; OS geofencing + `/v1/me/regions`; Sign in with Apple on iPhone, Apple + Google on the web, nonce, `/v1/auth/providers`; California UV from EPA; Autobahn full closures; events & demos: new topic, Polizei Berlin assemblies, Berlin postcodes; pollen & UV: opt-in topic, DWD forecasts, pollen areas and UV places; US recalls: FDA + CPSC, US state outlines; product recalls: new topic, lebensmittelwarnung.de, Länder outlines; Polizei Berlin press releases; city police for 26 cities on Presseportal; AI provider failover: Mistral / OpenAI-compatible; Sign in with Apple / Google on the server; web app catches up with the phone app; tech outages per service, more services + incident.io; alert history search; daily summary; US wildfires; river gauges/floods; earthquakes, air quality; AI cost guard, insights consent, language dropdown; India pack + SACHET, FEMA IPAWS; technology outages US; scaling plan; worker roles; country packs; Supabase; delivery queue; source registry; observability; staging + EAS Update).

## 1. System overview

```
             official + public sources                       people
  NINA · DWD · NWS · Presseportal · Polizei/Feuerwehr Berlin · RSS│
                       │ poll (each source on its own)         │
                       ▼                                       │
  ┌──────────────────── server/ (Fly.io, Frankfurt) ─────────────────────┐
  │ ingest → extract (Claude) → cluster (Mistral embeddings) → review   │
  │ gate (Alert Desk) → compose + verify (Claude) → match (PostGIS) →    │
  │ rank → deliver (Expo push / feed)                                   │
  │ store: SQLite on a Fly volume today; Postgres + PostGIS + pgvector  │
  └──────────────────────────────────┬───────────────────────────────────┘
                                      │ HTTPS JSON API (bearer device token)
             ┌────────────────────────┼─────────────────────────┐
             ▼                        ▼                         ▼
   app/ iPhone + Android      web/ browser app            /admin Alert Desk
   (Expo, push, background    (Next.js on Vercel,         (reviewers: approve,
    location, saved places)    no push)                    edit, curate)
```

| Part | Where | Tech | Deploys |
|---|---|---|---|
| Server / API | `server/` | Node 22, Fastify, TypeScript, zod | Fly.io app `heyokay` (region `fra`), on every merge to `main` touching `server/` (`.github/workflows/deploy.yml`) |
| Phone app | `app/` | Expo SDK 58, expo-router, React Native 0.88 | Development build via EAS; JS updates via Metro today, EAS Update later |
| Web app | `web/` | Next.js 15, React 19, Tailwind 3 | Vercel project `heyokay-2zag` (root directory `web`), every merge to `main`; previews per PR |
| Alert Desk | `server/src/desk.ts` | Single HTML page served by the server | With the server |
| CI | `.github/workflows/ci.yml` | GitHub Actions | Server tests on SQLite + Postgres (PostGIS, pgvector), app typecheck, web tests + build |

Live URLs: API `https://heyokay.fly.dev` (health: `/health`, Alert Desk: `/admin`), web `https://heyokay-2zag.vercel.app`.

## 2. Server

### Pipeline (PRD 6.2), `server/src/pipeline/`

1. **Ingest** (`ingest.ts`, `sources/`): each source polls on its own schedule slot with a 15 s request deadline; a slow source is skipped while the others run. Every item is stored once (`source_items`).
2. **Extract** (`extract.ts`): official feeds map directly (their severity is authoritative). Unstructured text goes to Claude with a strict schema (category, severity, place, confidence); without an API key, keyword rules. Past incidents, witness appeals and items older than 12 h are dropped. A place found only at city level lowers confidence, so a person reviews it.
3. **Cluster** (`cluster.ts`): one event per incident. Hard rules first (NINA id, CAP references, NWS ids), then same category, time window and distance, deciding by embedding similarity (Mistral) or word overlap.
4. **Review gate**: unofficial items with low confidence or severity ≥ 4 wait at the Alert Desk.
5. **Compose + verify** (`compose.ts`): Claude writes title (≤ 50) and body (≤ 100); a verifier rejects numbers not in the sources, alarm words and area stigma; two failures → template. The recommended action comes from a fixed library (`guidance.ts`).
6. **Match** (`rank.ts`, `Store.usersNear`): users whose last location (≤ 24 h old) or saved places are inside the event's exact outlines (or circle + buffer). PostGIS index in Postgres.
7. **Rank** (`rank.ts`): push / feed / suppress (official extreme always pushes; categories off; tech outages of services the person didn't pick (`techServices`); pollen/UV types not picked (`pollenUv`), motorway closures push only at a saved place, and pollen/UV pushes only for "hoch", 06:00–11:00 local, one per 12 h; quiet hours; daily limit; learned relevance).
7b. **Daily summary** (`digest.ts`, worker task `push:digest`): at each person's `digestTime` (local, default 18:00; 3-hour window) one push bundles the last 24 hours' feed-only first alerts of events still running, most serious first; tapping opens the top one. `digests` (user, local day) makes it at most one per day across workers. Not counted toward the daily limit.
8. **Deliver** (`push.ts`, delivery queue): matching writes one job per push into `push_jobs`; `PUSH_CONCURRENCY` senders claim 500 at a time (`SKIP LOCKED`; a dead sender's jobs return after 5 min). Expo push with retries (429/5xx/network); updates and all-clears ("Entwarnung") to people who got the original. Every push is stored as a ticket (`push_tickets`); 15 minutes later the receipt is checked (`checkPushReceipts`): delivered, token of an uninstalled app forgotten, transient errors resent up to twice.

### Storage (`store.ts`, `db.ts`, `pg.ts`)

- `Store` interface with two implementations: `SqliteStore` (tests, demo, production today on the Fly volume `/data/heyokay.db`) and `PgStore` (used when `DATABASE_URL` is set; numbered migrations under an advisory lock; PostGIS for matching, pgvector for embeddings).
- Tables: `users` (a person's data: prefs, last location only, push token, `last_seen_at` for D7 retention: set at most hourly by the feed, history or an alert's detail), `devices` (hashed bearer tokens; several per signed-in person), `accounts` (email, one per user), `account_identities` (Apple / Google user id → account), `email_codes` (hashed sign-in codes), `saved_places`, `source_items`, `events` (+ `event_embeddings`), `alerts` (with `opened_at`: first time the detail was opened, for the open rate), `push_tickets` (delivery status per push), `leases` (which worker runs ingest and push), `push_jobs` (delivery queue), `source_status` (per-source health written by the worker), `llm_usage` (AI spend per day), `digests` (daily summary sent, per person and local day), `reviewers` + `reviewer_sessions` (Alert Desk logins: scrypt password hash, session cookie stored as SHA-256, 12 h), `decisions` (decision log, PRD 6.3: one row per pipeline step and Alert Desk action, with model and prompt version; no user ids or locations, delivery as counts; written by `decisions.ts`, best effort).
- Retention (`retention.ts`, worker task `retention`, hourly): alerts and push tickets 30 days; last location cleared after 30 days without an update; source items 7 days (longer while their event runs); events 120 days after they end (one quarter for the crime bias review + a month); expired sessions, codes, stuck jobs, digest markers. Daily totals and the decision log are kept (the latter until a period is decided).
- Privacy by design: only the latest location (rounded ~100 m on the device), no history; device tokens hashed; `DELETE /v1/me` erases everything; the model never sees user data.

### Countries (`countries.ts`)

One pack per country (DE, AT, CH, US, IN): language, emergency / police / medical-advice numbers, units. Source adapters tag items with `country`; events keep it; `guidance.ts` fills the numbers into the fixed advice texts. Items and events without a tag fall back by language (de → DE, en → US). New country = a pack + source adapters (+ app/web strings if a new language).

### Roles (`roles.ts`)

`ROLE=api` answers HTTP only (stateless, scale out freely); `ROLE=worker` polls sources, runs the pipeline, sends pushes and checks receipts, with only `/health` on HTTP; `ROLE=all` (default) does both on one machine. Workers coordinate through a lease row (`leases`, name `worker`): the holder renews it each poll, others wait; on a crash another worker takes over after the lease runs out (3 × `POLL_INTERVAL_SEC`, ≥ 1 min), on a clean stop at once. A worker that can't reach the database stands down. `/health` shows `role` and `worker.leading`.

### API (`api.ts`)

Sign-in: `POST /v1/auth/email/start`, `POST /v1/auth/email/verify`, `POST /v1/auth/apple`, `POST /v1/auth/google` (body `{ idToken, nonce }`: the raw nonce whose SHA-256 the app gave the provider, checked in `identity.ts`: RS256 against the provider's JWKS, issuer, audience = our client ids, expiry; links by provider `sub`, or by an email the provider has verified), `POST /v1/auth/signout`, `GET /v1/auth/providers` (public: which of email / Apple / Google are switched on, so apps only show working buttons).
Device: `POST /v1/devices`, `GET /v1/me`, `GET /v1/me/regions` (geofence hint: active local events near the last location, in followed topics, ≤ 15), `PUT /v1/me/prefs`, `PUT /v1/me/push-token`, `POST /v1/me/location`, `GET|POST|DELETE /v1/me/places`, `DELETE /v1/me`.
Services: `GET /v1/services` (public; outage services people can follow, from `STATUS_PAGES`).
App events: `POST /v1/events` (public, no token: onboarding happens before the device registers; body `{ platform: ios|android|web, events: [{ name }] }`, ≤ 20, only the fixed names in `app-events.ts`, extra fields refused; 60 requests per address per 10 min). Stored as counts per day, platform and name in `app_events` (Postgres migration 16): no user, device, IP or time of day. The clients send through `lib/analytics.ts` (same file in `app/` and `web/`: a provider abstraction with Hey-Okay's server as the only provider until Decision 9).
Alerts: `GET /v1/me/alerts`, `GET /v1/me/history?q=&category=` (search, `history.ts`), `GET /v1/alerts/:id`, `POST /v1/alerts/:id/feedback`.
Admin (token): `/admin`, `/admin/api/pending|active|metrics|sources|ingest|manual-alert|events/:id/approve|reject|end`, `/admin/api/eval-export?since=` (reviewed events as eval cases), `/admin/api/decisions?eventId=&kind=&since=&limit=` and `/admin/api/decisions.csv` (decision log), `/admin/api/review-time?days=` (review time vs 3-minute target, per reviewer), `/admin/api/kpis?days=` (PRD 13 launch KPIs with red lines, `kpis.ts`), `/admin/api/funnel?days=` (onboarding funnel per platform, permission answers, notifications switched off; `app-events.ts`), `/admin/api/crime-bias?quarter=` (PRD 6.3 quarterly bias review: crime alerts per district per 100 000 residents vs the district's own city, for Berlin, Hamburg and Frankfurt (`BIAS_CITIES`), desk rejections, publishers; `bias-report.ts`, `data/berlin-bezirke.ts`, `data/hamburg-bezirke.ts`, `data/frankfurt-ortsbezirke.ts`; desk only); `POST /admin/api/events/:id/end` takes `{ reason: 'over' | 'false_alert' }`. Desk sign-in: `POST /admin/api/login|logout`, `GET /admin/api/me`; every `/admin/api/*` route accepts the admin token or a reviewer's session cookie (`hok_desk`, HttpOnly, Secure, SameSite=Strict, Path=/admin) together with the `x-desk: 1` header; `GET|POST /admin/api/reviewers`, `PUT /admin/api/reviewers/:id` need the admin token (`desk-auth.ts`).
Health: `GET /health` (per-source status, no error texts). CORS: any origin, bearer tokens only, no cookies (the desk's own session cookie is SameSite=Strict on /admin).
Hardening (`hardening.ts`, PRD 11): per-address and per-token limits per minute (in memory, per machine; 429 + Retry-After), request bodies up to 64 KB (413), security headers on every answer (nosniff, no-referrer, DENY framing, HSTS, a deny-all CSP for JSON and a tight one for `/admin`), `Cache-Control: no-store` on personal and desk answers. A fuzz test sends junk to every route in `api.ts`.

## 3. Data sources

| Source | What | Module | Access | Default | Notes |
|---|---|---|---|---|---|
| NINA (BBK) | MoWaS (incl. Cell Broadcast / EU-Alert), KATWARN, BIWAPP, DWD, LHP flood, police | `sources/nina.ts` | Public API, no key | On (`NINA_CHANNELS`) | Official; exact outlines (point budget) |
| DWD open data | All current weather warnings (CAP ZIP) | `sources/dwd.ts`, `zip.ts` | Public, no key | Fallback while NINA's DWD channel fails (`DWD_DIRECT`) | Early all-clears from the snapshot |
| NWS (US) | Active alerts per state/point | `sources/nws.ts` | Public, User-Agent required | `NWS_AREAS=CA` (US test mode) | Zone shapes cached |
| Presseportal Blaulicht | Police/fire press releases, 33 agencies: city police in 26 of the largest cities (HH, K, F, S, D, DO, E, HB, H, Nürnberg/Mittelfranken, DU, BO, W, BI, BN, MS, MA, KA, WI, GE, AC, MG, KI, BS, KR, OB), fire brigades HH/K/M, Bundespolizei B/M/HH | `sources/presseportal.ts` | Public RSS + article pages | On (`PRESSEPORTAL_AGENCIES`) | Missing-person searches and public manhunts dropped |
| Berliner Feuerwehr | Incident reports (`einsaetze.xml`) | `sources/feuerwehr-berlin.ts` | Public RSS | On (`FEUERWEHR_BERLIN`) | Street + district as place |
| lebensmittelwarnung.de (Länder + BVL) | Product and food recalls, topic `recall` (feed only) | `sources/lebensmittelwarnung.ts`, `data/de-states.ts` | Public RSS, every 30 min | On (`LEBENSMITTELWARNUNG_URL`, `off`) | Matched by the Länder named (coarse outlines; Berlin inside Brandenburg's) |
| FDA enforcement reports (openFDA) | US food (class I/II) and drug (class I, over-the-counter class II) recalls, topic `recall` (feed only) | `sources/us-recalls.ts`, `data/us-states.ts` | Public JSON API, no key, every 6 h, last 14 days of weekly reports | On (`FDA_RECALLS_URL`, `off`) | Matched by the states read from `distribution_pattern`, or nationwide; one alert per FDA event |
| Die Autobahn GmbH (`verkehr.autobahn.de/o/autobahn`) | Full motorway closures, topic `transit`: planned carriageway closures starting/started within 24 h, and "Vollsperrung" messages (never INRIX data, never lorry-only) | `sources/autobahn.ts` | Public JSON API, no published terms (Flori OK'd use 2026-11-22), every 15 min, ~230 requests (4 at a time) | On (`AUTOBAHN_URL`, `off`) | Point + closed section; feed, push only near a saved place (`matchedPlace` in ranking); lifted early → all-clear (`autobahn:DE` reconcile) |
| Polizei Berlin · Versammlungen (assemblies list, JSON export) | Registered marches with a route, today and tomorrow, topic `events` (feed only, on by default) | `sources/berlin-versammlungen.ts`, `data/berlin-plz.ts` | Public JSON export (open-data register, licence "other-closed"; Flori OK'd use 2026-11-22), hourly | On (`BERLIN_VERSAMMLUNGEN_URL`, `off`) | Postcode area (Geoportal Berlin, CC BY 3.0 DE) or the route's start via the geocoder; never the topic or organiser |
| US EPA UV Index (Envirofacts, per ZIP) | UV index 6+ for 18 California places, topic `pollen_uv` (opt-in) | `sources/us-uv.ts`, `data/ca-uv-places.ts` | Public JSON API, no key, once a day after 07:05 Los Angeles time, today only | On (`EPA_UV_URL`, `off`) | Voronoi cells of the 18 places over California |
| DWD health forecasts (pollen `s31fg.json`, UV `uvi.json`) | Pollen (8 types, "mittel" and up) and UV index (6 and up), topic `pollen_uv` (opt-in, off by default) | `sources/dwd-health.ts`, `data/dwd-health-areas.ts` | DWD open data, once a day after 07:05 Berlin time, today only | On (`DWD_HEALTH_URL`, `off`) | Pollen: 27 DWD pollen areas (from DWD's GeoServer); UV: Voronoi cells of the 34 low-lying forecast places |
| CPSC recalls (saferproducts.gov) | US consumer-product recalls, topic `recall` (feed only) | `sources/us-recalls.ts` | Public JSON API, no key, every 6 h, last 7 days | On (`CPSC_RECALLS_URL`, `off`) | Nationwide |
| Polizei Berlin | Press releases (berlin.de RSS, titles only; each new release page fetched once for district + text) | `sources/polizei-berlin.ts` | Public RSS + release pages | On (`POLIZEI_BERLIN`) | Missing persons, unidentified dead, verdicts, prevention dropped |
| Generic RSS/Atom | e.g. Polizei Berlin (berlin.de) | `sources/rss.ts` | Public | `RSS_FEEDS` (JSON) | |
| Manual (Alert Desk) | Curated alerts | `pipeline/run.ts` | Admin token | — | Concierge pilot |
| BVG / VBB | Transit disruptions | — | Not built | — | Needs VBB API access or BVG permission |
| FEMA IPAWS (US) | Public alerts from state and local authorities (evacuations, shelter-in-place, civil emergencies, AMBER) — CAP 1.2 | `sources/ipaws.ts`, `cap.ts` | Public, no key | On (`IPAWS_URL`, or `off`) | NWS messages skipped (own adapter); last 6 h polled; URL to confirm on first live poll |
| NDMA SACHET (India) | Official alerts from IMD, CWC, INCOIS and state disaster authorities — CAP 1.2 via RSS | `sources/sachet.ts`, `cap.ts` | Public, no key | On (`SACHET_RSS_URL`, or `off`) | English info block preferred; withdrawn → all-clear; URL to confirm on first live poll |
| USGS earthquakes | Worldwide real-time feed (GeoJSON, M2.5+ last hour); only quakes in or near DE, US, IN | `sources/usgs.ts` | Public, no key | On (`USGS_URL`, or `off`) | M4+ only; felt radius and level from magnitude, raised by USGS PAGER; aftershock advice; German text in Germany |
| PEGELONLINE (WSV) | River water levels at ~700 federal gauges, with the agency's own state vs. mean flood level (MHW) and highest navigable level (HSW) | `sources/pegelonline.ts` | Public, no key, DL-DE/Zero-2.0 | On (`PEGELONLINE_URL`, or `off`); fetched at most every 15 min | German gauges only; above HSW → feed (sev. 1), above MHW → may push (sev. 2); 5 km around the gauge; hazard `flood`; back to normal → all-clear; out-of-date gauges keep their alert; fallback NINA · Hochwasserportal |
| NIFC WFIGS (US) | Current wildfire incidents: size, containment, place (public ArcGIS layer, filtered to wildfires of 10+ acres that aren't out) | `sources/wildfire.ts` | Public domain, no key | On (`WFIGS_URL`, or `off`); fetched at most every 5 min | US outline only; 10+ acres → feed, 100+ → sev. 2, 1,000+ → sev. 3; half contained or older than 2 weeks → feed only; 90%+ → no new alert; out/contained/no update for 7 days → all-clear; radius 10/20/40 km by size; hazard `wildfire`, category public_safety; prescribed burns skipped; a cut-off answer fails rather than lifting alerts; fallback FEMA IPAWS (evacuation orders) |
| OpenWeatherMap air quality | Air pollution forecast per 0.1° cell (AQI 1–5) | `sources/air.ts` | Same key as heat | Off until `OPENWEATHER_API_KEY` | Poor → feed, very poor → severity 2; later today → "Coming up"; category health |
| Status pages (US) | Technology outages: Cloudflare, Zoom, Discord, Reddit, Dropbox, Chime, Cash App, Affirm, Klarna, Wise, Robinhood, Coinbase, Ring (Atlassian Statuspage public API, `/api/v2/incidents/unresolved.json`); Square (US sub-page) and ChatGPT (incident.io status-summary API, `/api/v1/summary`; `api: 'incidentio'`) | `sources/statuspage.ts` | Public, no key | On (`STATUS_PAGES`, JSON or `off`) | Category `technology`, hazard `outage`; major → feed (sev. 1), critical → may push (sev. 3); whole-country outline; resolved → all-clear; each event keeps its `service` key so people can follow only the services they use (`techServices` in prefs, null = all) |
| OpenWeatherMap | Heat at saved places and current locations (5-day forecast) | `sources/heat.ts` | Free key | Off until `OPENWEATHER_API_KEY` | Grid cells (0.1°) only; felt ≥ 32/35/38 °C → 1/2/3 |

## 4. External services and integrations

| Service | Used for | Where configured | Status | Data shared |
|---|---|---|---|---|
| Fly.io | Server hosting (Frankfurt), volume for SQLite | `fly.toml`, Fly secrets | Live | Everything server-side |
| Vercel | Web app hosting, PR previews | Vercel project `heyokay-2zag` (root `web`) | Live | Static files only |
| GitHub + Actions | Code, CI, deploy to Fly | `.github/workflows/` | Live | Code |
| Anthropic Claude | Extraction, alert copy | `ANTHROPIC_API_KEY`, `HEYOKAY_MODEL` | Optional (rules/templates without) | Public source text only |
| Mistral (AI Studio) | Embeddings for dedup (`mistral-embed`) | `EMBEDDINGS_URL/MODEL/API_KEY` | Live since 2026-11-18 | Public source text only; DPA via terms |
| Expo Push Service | Push to iOS (APNs) and Android (FCM), delivery receipts | `EXPO_PUSH_URL`, `EXPO_ACCESS_TOKEN`, `app.json` EAS project | Live (needs EAS projectId) | Push token, alert text |
| Firebase Crashlytics | Crash reports, opt-in | `app/firebase/*` files | Built, waits for Firebase files | Crash data only if opted in |
| OpenStreetMap Nominatim | Geocoding places in text (server) and addresses (web) | `GEOCODER_URL`, `GEOCODER_USER_AGENT` | Live (public instance) | Place names / addresses typed by the user (web) |
| OS geocoder | Addresses for saved places (phone) | expo-location | Live | Address, on the device's provider |
| Apple Maps / Google Maps | Map in alert detail | react-native-maps | Live | Map tiles |
| Postgres + PostGIS + pgvector | Production DB option | `DATABASE_URL`, `server/docker-compose.yml` | Ready, not switched on | — |
| OpenWeatherMap | Heat forecast | `OPENWEATHER_API_KEY`, `HEAT_THRESHOLD_C` | Built, waits for key | Grid-cell centres only (no person's place) |
| Resend (email) | Sign-in codes | `RESEND_API_KEY`, `MAIL_FROM` | Built, waits for key and sender domain | Email address, code |
| Sign in with Apple, Google | Accounts (identity tokens checked against `appleid.apple.com/auth/keys`, `googleapis.com/oauth2/v3/certs`) | `APPLE_CLIENT_IDS`, `GOOGLE_CLIENT_IDS` | Server 2026-11-21; buttons 2026-11-22: Apple on iPhone (`expo-apple-authentication`), Apple JS + Google Identity Services on the web; Google on the phone to follow; all hidden until the ids are set | Provider user id, email (Apple may give a relay address) |
| RevenueCat / App Store / Play | Subscriptions | planned | Decision 5 open | — |
| Mistral (La Plateforme, EU) / any OpenAI-style chat API | Second LLM, failover (`llm-providers.ts`, order `LLM_PROVIDERS`) | `MISTRAL_API_KEY`, `MISTRAL_MODEL`; `OPENAI_COMPAT_URL/API_KEY/MODEL/JSON_MODE` | Built 2026-11-21, off until a key is set and listed in `LLM_PROVIDERS` | Public source text only |
| Analytics (Mixpanel/Amplitude) | Product KPIs | planned | Decision 9 open | — |

## 5. Configuration (server environment)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 8787 | HTTP port |
| `DATABASE_URL` | – | Postgres; when unset, SQLite at `DB_PATH` |
| `DB_PATH` | ./heyokay.db | SQLite file (Fly: `/data/heyokay.db`) |
| `ADMIN_TOKEN` | change-me | Alert Desk; production refuses to start with the default |
| `ANTHROPIC_API_KEY`, `HEYOKAY_MODEL` | –, claude-haiku-5-5 | AI extraction and copy |
| `LLM_PROVIDERS` | anthropic | AI providers in failover order (`anthropic`, `mistral`, `openai_compat`); ones without a key are skipped; a provider failing 3 times in a row is skipped for 5 min; templates last |
| `MISTRAL_API_KEY`, `MISTRAL_MODEL`, `MISTRAL_URL` | –, mistral-small-latest, https://api.mistral.ai/v1 | Mistral as an AI provider (separate from `EMBEDDINGS_API_KEY`) |
| `OPENAI_COMPAT_URL`, `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_MODEL`, `OPENAI_COMPAT_JSON_MODE` | –, –, –, schema | Any OpenAI-style chat API (e.g. an open-weight model on EU hosting); `object` for servers without JSON-schema output |
| `EMBEDDINGS_URL`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_DIMENSIONS`, `EMBEDDINGS_MIN_SIMILARITY` | –, –, –, –, 0.8 | Dedup embeddings |
| `NINA_CHANNELS` | mowas,katwarn,biwapp,dwd,lhp,police | NINA channels |
| `DWD_DIRECT` | fallback | `fallback` / `always` / `off` |
| `NWS_AREAS`, `NWS_USER_AGENT` | – | US alerts (state codes or `lat,lon`, `;`-separated) |
| `PRESSEPORTAL_AGENCIES` | all | `all` / `off` / agency keys |
| `FEUERWEHR_BERLIN` | on | `off` to disable |
| `POLIZEI_BERLIN` | on | Polizei Berlin press releases; `off` to disable |
| `LEBENSMITTELWARNUNG_URL` | lebensmittelwarnung.de feed | Product and food recalls (Germany); `off` to disable |
| `FDA_RECALLS_URL` | `https://api.fda.gov` | FDA food and drug recalls (US); `off` to disable |
| `CPSC_RECALLS_URL` | saferproducts.gov recall API | CPSC product recalls (US); `off` to disable |
| `AUTOBAHN_URL` | `https://verkehr.autobahn.de/o/autobahn` | Autobahn GmbH full closures; `off` to disable |
| `BERLIN_VERSAMMLUNGEN_URL` | Polizei Berlin assemblies JSON export | Marches in Berlin for the `events` topic; `off` to disable |
| `EPA_UV_URL` | `https://data.epa.gov/efservice/getEnvirofactsUVDAILY/ZIP` | EPA UV index for California; `off` to disable |
| `DWD_HEALTH_URL` | `https://opendata.dwd.de/climate_environment/health/alerts` | DWD pollen and UV forecasts (Germany); `off` to disable |
| `RSS_FEEDS` | [] | JSON list of feeds |
| `RESEND_API_KEY`, `MAIL_FROM` | – | Email sign-in codes (off without both) |
| `APPLE_CLIENT_IDS` | – | Sign in with Apple: accepted audiences, comma-separated (iOS bundle id, web Services ID); off when unset |
| `GOOGLE_CLIENT_IDS` | – | Sign in with Google: accepted OAuth client ids (iOS, Android, web); off when unset |
| `OPENWEATHER_API_KEY`, `HEAT_THRESHOLD_C` | –, 32 | Heat at people's places (off without key) |
| `POLL_INTERVAL_SEC` | 120 | Ingest interval |
| `GEOCODER_URL`, `GEOCODER_USER_AGENT` | Nominatim | Geocoding |
| `EXPO_PUSH_URL` | Expo | Push endpoint |
| `EXPO_ACCESS_TOKEN` | – | Only if Expo "enhanced push security" is on |
| `DATABASE_SCHEMA` | – | Postgres schema for our tables; `heyokay` on Supabase (keeps them off Supabase's public Data API) |
| `IPAWS_URL` / `SACHET_RSS_URL` | built-in | Override or `off` for the US and India official feeds |
| `LLM_DAILY_BUDGET_EUR` | `5` | AI spend cap per UTC day (0 = off); above it templates are used |
| `RATE_LIMIT_IP_PER_MIN` | `300` | API requests per minute per client address (0 = off; `/health` never limited) |
| `RATE_LIMIT_TOKEN_PER_MIN` | `120` | API requests per minute per bearer token (0 = off) |
| `CLIENT_IP_HEADER` | `fly-client-ip` on Fly, else none | Header with the client's address from our own edge proxy; `off` = use the connection address |
| `LLM_PRICE_IN_EUR_PER_MTOK` / `LLM_PRICE_OUT_EUR_PER_MTOK` | `1` / `5` | Model prices for the cost guard; set to the contract price |
| `STATUS_PAGES` | US list | Status pages for technology outages (JSON array of `{key,name,url,country,kind}`) or `off` |
| `COUNTRIES` | all | Countries whose sources run, e.g. `DE,AT` (registry in `sources/registry.ts`) |
| `METRICS_PORT` | `9091` | Internal Prometheus port (0 = off) |
| `SENTRY_DSN` | – | Sentry (EU) for server errors |
| `PUSH_CONCURRENCY` | `4` | Push sends in flight from the delivery queue |
| `ROLE` | `all` | `api`, `worker` or `all` (see Roles). Separate roles need `DATABASE_URL` |
| `MATCH_BUFFER_M` | 1500 | Buffer around an event for current locations |
| `REVIEW_CONFIDENCE`, `REVIEW_SEVERITY` | 0.6, 4 | Alert Desk thresholds |

Phone app: `EXPO_PUBLIC_API_URL` (else `app.json → extra.apiUrl`). Web app: `NEXT_PUBLIC_API_URL` (default `https://heyokay.fly.dev`); sign-in buttons: `NEXT_PUBLIC_APPLE_SERVICE_ID`, `NEXT_PUBLIC_APPLE_REDIRECT_URI` (default `<site>/settings`), `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (each button hidden while unset).

## 6. Clients

- **Phone app** (`app/`): notification buttons "Relevant / Nicht relevant" (category `alert`, Android background task, iOS listener, offline queue); pushes stacked per incident (`threadId`); onboarding (value → location → always → notifications → topics → consent), main screen "In deiner Nähe" (current alerts by topic, earlier below), alert detail (map, what to do, sources, AI note, feedback), settings (language, topics, quiet hours, daily limit, location, places, crash reports, delete). Background location task, push token registration, deep links. Night-sky design shared with the web.
- **Web app** (`web/`): same API, strings and features as the phone app (rule since 2026-11-20): "Jetzt" with the overview (status, topic tiles, next 24 hours), searchable "Verlauf", detail dialog, settings incl. tech-outage services, onboarding; no push, daily summary or background location (browser limits).
- Environments: production `heyokay.fly.dev` (from `main`), staging `heyokay-staging.fly.dev` (from `agent/next`, schema `heyokay_staging`); web production → production API, Vercel previews → staging; app EAS Update channels `development` / `preview` / `production` (`runtimeVersion` policy `appVersion`). Runbook: `docs/runbooks/staging.md`.
- Both register anonymously (device token). Sign-in (accounts shared across devices) by email code, Sign in with Apple (iPhone and web) and Google (web; phone to follow). Shared logic in `lib/signin.ts` (same file in app and web, tested in `web/test/signin.test.ts`).

## 7. Quality and operations

- Tests: server (vitest) on SQLite and Postgres; web (Node test runner); app typecheck. Real fixtures from live sources.
- AI evaluation (`server/eval/`, `src/eval/`, `npm run eval`): labelled cases (written German cases + real press releases from the fixtures) run through extract and compose; reports extraction accuracy, severity agreement, verifier pass rate and cost per event for the `LLM_PROVIDERS` models, or the keyword-rules baseline with `--rules`. Runs outside the server: no database, no daily budget. `--compare` runs each `LLM_PROVIDERS` entry alone next to the rules and suggests an order (per-provider prices `LLM_PRICE_<NAME>_IN/OUT_EUR_PER_MTOK`, read only by the eval tool). Alert Desk decisions export as new cases (`GET /admin/api/eval-export?since=`, admin token; approved = alert with the reviewer's severity, rejected = no alert).
- Error logging: structured JSON lines on stderr (`errors.ts`); `fly logs -a heyokay`; also Sentry (EU) when `SENTRY_DSN` is set.
- Metrics: Prometheus text on the internal `METRICS_PORT` (9091), scraped by Fly (`[metrics]` in `fly.toml`). Main metrics: `heyokay_push_latency_seconds`, `heyokay_pushes_total`, `heyokay_push_queue_depth`, `heyokay_source_up`, `heyokay_source_last_ok_age_seconds`, `heyokay_http_requests_total`, `heyokay_errors_total`, `heyokay_worker_leading`.
- Health: `/health` per source (`ok`, `running`, `lastOkAt`) on the worker; the Alert Desk **Sources** table (from `source_status`, any machine) shows ok / failing / stale / waiting with the fallback.
- Build agent: runs daily on `agent/next`, rules in `AGENT.md`, work list in `ROADMAP.md`, history in `CHANGELOG.md`.

## 8. Scaling plan (Flori, 2026-11-18: "scalable infrastructure and a product that can expand fast")

Where we are: one Fly machine runs everything (API, all source polling, push), with SQLite on its disk. Good for the pilot. It can't add a second machine (two schedulers would both send pushes), can't fail over, and one busy poll slows the API.

Target, in this order (each is a roadmap item under "Scale foundation"):

| # | Step | Why | Unlocks |
|---|---|---|---|
| 1 | 🟡 **Managed Postgres: Supabase** (project `Hey-Okay`, Frankfurt, created and migrated 2026-11-18; copy tool and runbook ready: `docs/runbooks/supabase-postgres.md`; switch pending) (PostGIS + pgvector) in Frankfurt; switch `DATABASE_URL`, migrate the SQLite data once | The code already runs on Postgres; the disk-bound SQLite is the one thing that keeps us on a single machine | Backups, point-in-time restore, more machines |
| 2 | ✅ **API and worker roles** (built 2026-11-18) (`ROLE=api` / `worker`) plus a worker lease in the database, so exactly one worker polls and sends at a time, with automatic takeover | Several API machines behind Fly's load balancer; one worker never double-sends | Horizontal API scaling, zero-downtime deploys |
| 3 | ✅ **Delivery queue** (built 2026-11-18; 20k pushes ≈ 1 s on Postgres) in Postgres (`FOR UPDATE SKIP LOCKED`): matching writes jobs, workers send pushes in parallel with retries | A severe warning for a big city means hundreds of thousands of pushes in minutes | Several workers sharing the load |
| 4 | 🟡 **Country packs** (built 2026-11-18: packs, country tags, numbers in advice, `COUNTRIES`, source registry + health; next: a second country's sources): sources, emergency numbers, advice, language and units per country (`COUNTRIES=DE,AT,CH`), source registry with health | Today Germany and the US test are wired in code (112/110, 911) | New country = config + source adapters |
| 5 | **API hardening**: rate limits per token and IP, body limits, security headers; CDN caching for the web app | Public launch traffic and abuse | Safe public launch |
| 6 | ✅ **Observability** (built 2026-11-18: metrics, Sentry; uptime monitor = human step): metrics (event-to-push p90, queue depth, source lag), error tracking, uptime alerts, `/health` per role | Know before users notice | On-call |
| 7 | ✅ **Environments** (built 2026-11-18: staging config + workflow, EAS Update channels; setup steps in `docs/runbooks/staging.md`): staging Fly app + Vercel preview against staging, EAS Update channels (preview/production), infrastructure as code (Fly config, secrets list) | Ship fast without breaking production | Daily releases |
| 8 | **Data retention** job and partitioning of alerts/source items by month | Tables grow with users × events | Stable performance and GDPR |

Rough capacity after steps 1–3: millions of users on a few small machines. Matching is one index lookup per event (PostGIS), pushes go out through the queue, and the API stays stateless.

Product side, already in place for fast expansion: a `Store` interface (swap storage), a pluggable source adapter per feed, an LLM and embeddings provider behind interfaces (`StructuredLLM`, `Embedder`), shared strings in German and English, and the web and phone apps on one API. Missing pieces, also on the roadmap: a second LLM provider for failover, the country packs above, the B2B API (Phase 2) and analytics.
