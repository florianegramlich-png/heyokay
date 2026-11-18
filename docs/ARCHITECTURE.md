# Hey-Okay: architecture and integrations

Living document. The build agent updates it whenever a component, source, integration or setting changes (see `AGENT.md`). A copy lives in the Claude project "Hey Okey" (`claude/architecture.md`).

Last updated: 2026-11-18 (scaling plan; worker roles; country packs; Supabase; delivery queue).

## 1. System overview

```
             official + public sources                       people
  NINA · DWD · NWS · Presseportal · Feuerwehr Berlin · RSS     │
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
7. **Rank** (`rank.ts`): push / feed / suppress (official extreme always pushes; categories off; quiet hours; daily limit; learned relevance).
8. **Deliver** (`push.ts`, delivery queue): matching writes one job per push into `push_jobs`; `PUSH_CONCURRENCY` senders claim 500 at a time (`SKIP LOCKED`; a dead sender's jobs return after 5 min). Expo push with retries (429/5xx/network); updates and all-clears ("Entwarnung") to people who got the original. Every push is stored as a ticket (`push_tickets`); 15 minutes later the receipt is checked (`checkPushReceipts`): delivered, token of an uninstalled app forgotten, transient errors resent up to twice.

### Storage (`store.ts`, `db.ts`, `pg.ts`)

- `Store` interface with two implementations: `SqliteStore` (tests, demo, production today on the Fly volume `/data/heyokay.db`) and `PgStore` (used when `DATABASE_URL` is set; numbered migrations under an advisory lock; PostGIS for matching, pgvector for embeddings).
- Tables: `users` (a person's data: prefs, last location only, push token), `devices` (hashed bearer tokens; several per signed-in person), `accounts` (email, one per user), `email_codes` (hashed sign-in codes), `saved_places`, `source_items`, `events` (+ `event_embeddings`), `alerts`, `push_tickets` (delivery status per push), `leases` (which worker runs ingest and push), `push_jobs` (delivery queue), `source_status` (per-source health written by the worker).
- Privacy by design: only the latest location (rounded ~100 m on the device), no history; device tokens hashed; `DELETE /v1/me` erases everything; the model never sees user data.

### Countries (`countries.ts`)

One pack per country (DE, AT, CH, US): language, emergency / police / medical-advice numbers, units. Source adapters tag items with `country`; events keep it; `guidance.ts` fills the numbers into the fixed advice texts. Items and events without a tag fall back by language (de → DE, en → US). New country = a pack + source adapters (+ app/web strings if a new language).

### Roles (`roles.ts`)

`ROLE=api` answers HTTP only (stateless, scale out freely); `ROLE=worker` polls sources, runs the pipeline, sends pushes and checks receipts, with only `/health` on HTTP; `ROLE=all` (default) does both on one machine. Workers coordinate through a lease row (`leases`, name `worker`): the holder renews it each poll, others wait; on a crash another worker takes over after the lease runs out (3 × `POLL_INTERVAL_SEC`, ≥ 1 min), on a clean stop at once. A worker that can't reach the database stands down. `/health` shows `role` and `worker.leading`.

### API (`api.ts`)

Sign-in: `POST /v1/auth/email/start`, `POST /v1/auth/email/verify`, `POST /v1/auth/signout`.
Device: `POST /v1/devices`, `GET /v1/me`, `PUT /v1/me/prefs`, `PUT /v1/me/push-token`, `POST /v1/me/location`, `GET|POST|DELETE /v1/me/places`, `DELETE /v1/me`.
Alerts: `GET /v1/me/alerts`, `GET /v1/alerts/:id`, `POST /v1/alerts/:id/feedback`.
Admin (token): `/admin`, `/admin/api/pending|active|metrics|sources|ingest|manual-alert|events/:id/approve|reject|end`.
Health: `GET /health` (per-source status, no error texts). CORS: any origin, bearer tokens only, no cookies.

## 3. Data sources

| Source | What | Module | Access | Default | Notes |
|---|---|---|---|---|---|
| NINA (BBK) | MoWaS (incl. Cell Broadcast / EU-Alert), KATWARN, BIWAPP, DWD, LHP flood, police | `sources/nina.ts` | Public API, no key | On (`NINA_CHANNELS`) | Official; exact outlines (point budget) |
| DWD open data | All current weather warnings (CAP ZIP) | `sources/dwd.ts`, `zip.ts` | Public, no key | Fallback while NINA's DWD channel fails (`DWD_DIRECT`) | Early all-clears from the snapshot |
| NWS (US) | Active alerts per state/point | `sources/nws.ts` | Public, User-Agent required | `NWS_AREAS=CA` (US test mode) | Zone shapes cached |
| Presseportal Blaulicht | Police/fire press releases, 8 agencies (HH, K, M, Berlin Bundespolizei) | `sources/presseportal.ts` | Public RSS + article pages | On (`PRESSEPORTAL_AGENCIES`) | Missing-person searches dropped |
| Berliner Feuerwehr | Incident reports (`einsaetze.xml`) | `sources/feuerwehr-berlin.ts` | Public RSS | On (`FEUERWEHR_BERLIN`) | Street + district as place |
| Generic RSS/Atom | e.g. Polizei Berlin (berlin.de) | `sources/rss.ts` | Public | `RSS_FEEDS` (JSON) | |
| Manual (Alert Desk) | Curated alerts | `pipeline/run.ts` | Admin token | — | Concierge pilot |
| BVG / VBB | Transit disruptions | — | Not built | — | Needs VBB API access or BVG permission |
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
| OpenWeatherMap | Heat forecast | `RESEND_API_KEY`, `MAIL_FROM` | – | Email sign-in codes (off without both) |
| `OPENWEATHER_API_KEY`, `HEAT_THRESHOLD_C` | Built, waits for key | Grid-cell centres only (no person's place) |
| Resend (email) | Sign-in codes | `RESEND_API_KEY`, `MAIL_FROM` | Built, waits for key and sender domain | Email address, code |
| Sign in with Apple, Google | Accounts | planned | Roadmap | — |
| RevenueCat / App Store / Play | Subscriptions | planned | Decision 5 open | — |
| OpenAI | Second LLM, failover | planned | Roadmap | — |
| Analytics (Mixpanel/Amplitude) | Product KPIs | planned | Decision 9 open | — |

## 5. Configuration (server environment)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 8787 | HTTP port |
| `DATABASE_URL` | – | Postgres; when unset, SQLite at `DB_PATH` |
| `DB_PATH` | ./heyokay.db | SQLite file (Fly: `/data/heyokay.db`) |
| `ADMIN_TOKEN` | change-me | Alert Desk; production refuses to start with the default |
| `ANTHROPIC_API_KEY`, `HEYOKAY_MODEL` | –, claude-haiku-5-5 | AI extraction and copy |
| `EMBEDDINGS_URL`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_DIMENSIONS`, `EMBEDDINGS_MIN_SIMILARITY` | –, –, –, –, 0.8 | Dedup embeddings |
| `NINA_CHANNELS` | mowas,katwarn,biwapp,dwd,lhp,police | NINA channels |
| `DWD_DIRECT` | fallback | `fallback` / `always` / `off` |
| `NWS_AREAS`, `NWS_USER_AGENT` | – | US alerts (state codes or `lat,lon`, `;`-separated) |
| `PRESSEPORTAL_AGENCIES` | all | `all` / `off` / agency keys |
| `FEUERWEHR_BERLIN` | on | `off` to disable |
| `RSS_FEEDS` | [] | JSON list of feeds |
| `RESEND_API_KEY`, `MAIL_FROM` | – | Email sign-in codes (off without both) |
| `OPENWEATHER_API_KEY`, `HEAT_THRESHOLD_C` | –, 32 | Heat at people's places (off without key) |
| `POLL_INTERVAL_SEC` | 120 | Ingest interval |
| `GEOCODER_URL`, `GEOCODER_USER_AGENT` | Nominatim | Geocoding |
| `EXPO_PUSH_URL` | Expo | Push endpoint |
| `EXPO_ACCESS_TOKEN` | – | Only if Expo "enhanced push security" is on |
| `DATABASE_SCHEMA` | – | Postgres schema for our tables; `heyokay` on Supabase (keeps them off Supabase's public Data API) |
| `COUNTRIES` | all | Countries whose sources run, e.g. `DE,AT` (registry in `sources/registry.ts`) |
| `PUSH_CONCURRENCY` | `4` | Push sends in flight from the delivery queue |
| `ROLE` | `all` | `api`, `worker` or `all` (see Roles). Separate roles need `DATABASE_URL` |
| `MATCH_BUFFER_M` | 1500 | Buffer around an event for current locations |
| `REVIEW_CONFIDENCE`, `REVIEW_SEVERITY` | 0.6, 4 | Alert Desk thresholds |

Phone app: `EXPO_PUBLIC_API_URL` (else `app.json → extra.apiUrl`). Web app: `NEXT_PUBLIC_API_URL` (default `https://heyokay.fly.dev`).

## 6. Clients

- **Phone app** (`app/`): notification buttons "Relevant / Nicht relevant" (category `alert`, Android background task, iOS listener, offline queue); pushes stacked per incident (`threadId`); onboarding (value → location → always → notifications → topics → consent), main screen "In deiner Nähe" (current alerts by topic, earlier below), alert detail (map, what to do, sources, AI note, feedback), settings (language, topics, quiet hours, daily limit, location, places, crash reports, delete). Background location task, push token registration, deep links. Night-sky design shared with the web.
- **Web app** (`web/`): same API and strings (copied from the phone app), "Jetzt", "Verlauf", detail dialog, settings, onboarding; no push or background location.
- Both register anonymously (device token). The server supports email sign-in (accounts shared across devices); the sign-in screens in the app and web are the next roadmap item.

## 7. Quality and operations

- Tests: server (vitest) on SQLite and Postgres; web (Node test runner); app typecheck. Real fixtures from live sources.
- Error logging: structured JSON lines on stderr (`errors.ts`); `fly logs -a heyokay`.
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
| 6 | **Observability**: metrics (event-to-push p90, queue depth, source lag), error tracking, uptime alerts, `/health` per role | Know before users notice | On-call |
| 7 | **Environments**: staging Fly app + Vercel preview against staging, EAS Update channels (preview/production), infrastructure as code (Fly config, secrets list) | Ship fast without breaking production | Daily releases |
| 8 | **Data retention** job and partitioning of alerts/source items by month | Tables grow with users × events | Stable performance and GDPR |

Rough capacity after steps 1–3: millions of users on a few small machines. Matching is one index lookup per event (PostGIS), pushes go out through the queue, and the API stays stateless.

Product side, already in place for fast expansion: a `Store` interface (swap storage), a pluggable source adapter per feed, an LLM and embeddings provider behind interfaces (`StructuredLLM`, `Embedder`), shared strings in German and English, and the web and phone apps on one API. Missing pieces, also on the roadmap: a second LLM provider for failover, the country packs above, the B2B API (Phase 2) and analytics.
