# Hey-Okay — MVP

Calm, location-aware safety alerts for Germany. One sentence on what's happening near you and what to do — only when it concerns you. Built to PRD v6.4 (sections 5–6).

```
heyokay/
├── server/   Node 22 · Fastify · Postgres or SQLite (node:sqlite) · Claude API — ingest → AI pipeline → push
├── web/      Next.js · the browser version (v0 design), same server API — see web/README.md
└── app/      Expo SDK 58 · expo-router · background location · Expo push
```

## Quick start (no API keys, no network)

```bash
cd server && npm install
npm test            # sources, verifier, ranking, store contract, end-to-end pipeline
npm run demo        # API on :8787 with an in-memory DB fed from Berlin fixtures
```

Open `http://localhost:8787/admin` (token `change-me`) for the Alert Desk: approve or edit the two items waiting for review, and watch the alert reach the demo user.

```bash
cd app && npm install
EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:8787 npx expo start
```

Expo Go covers onboarding, the feed, alert detail, settings and foreground location. **Background location and push need a development build** (`npx expo run:ios` / `run:android`, or `eas build --profile development`). Push also needs an EAS project ID in `app.json → extra.eas.projectId`.

## Production server

```bash
cd server
ADMIN_TOKEN=… ANTHROPIC_API_KEY=… \
RSS_FEEDS='[{"url":"https://www.berlin.de/polizei/polizeimeldungen/index.php/rss","sourceName":"Polizei Berlin","categoryHint":"crime","defaultArea":"Berlin"}]' \
npm start
```

| Variable | Default | |
|---|---|---|
| `PORT` | 8787 | |
| `DATABASE_URL` | – | Postgres connection string. When set, Postgres is used and `DB_PATH` is ignored; tables are created/migrated on start |
| `DB_PATH` | ./heyokay.db | SQLite file (tests, demo, single-node setups) |
| `ADMIN_TOKEN` | change-me | Alert Desk + admin API — **set this** |
| `ANTHROPIC_API_KEY` | – | Without it: keyword rules + fixed templates (still works, less coverage) |
| `HEYOKAY_MODEL` | claude-haiku-5-5 | |
| `NINA_CHANNELS` | mowas,katwarn,biwapp,dwd,lhp,police | Official BBK warnings |
| `RSS_FEEDS` | [] | JSON list of police / transit feeds |
| `FEUERWEHR_BERLIN` | on | Berliner Feuerwehr incident reports (`off` to disable) |
| `DWD_DIRECT` | fallback | DWD warnings straight from DWD open data: `fallback` (only while NINA's DWD channel fails), `always`, or `off` |
| `PRESSEPORTAL_AGENCIES` | all | Presseportal Blaulicht press releases: `all`, `off`, or a comma list of agency keys (`polizei-hamburg`, `feuerwehr-hamburg`, `bundespolizei-hamburg`, `polizei-koeln`, `feuerwehr-koeln`, `feuerwehr-muenchen`, `bundespolizei-muenchen`, `bundespolizei-berlin`) |
| `NWS_AREAS` | – | US National Weather Service alerts for testing in the US: state codes (`CA`) or `lat,lon` points, separated by `;`. Off when empty |
| `NWS_USER_AGENT` | `GEOCODER_USER_AGENT` | Contact string NWS requires, e.g. `HeyOkay (you@example.com)` |
| `POLL_INTERVAL_SEC` | 120 | |
| `GEOCODER_URL` | Nominatim | Use your own instance for volume; the built-in gazetteer is the fallback |
| `MATCH_BUFFER_M` | 1500 | Extra distance around an event's area |
| `REVIEW_CONFIDENCE` / `REVIEW_SEVERITY` | 0.6 / 4 | Below/at these, non-official items go to the Alert Desk |
| `EMBEDDINGS_URL` / `EMBEDDINGS_API_KEY` / `EMBEDDINGS_MODEL` | – | Dedup embeddings from any OpenAI-style `/embeddings` endpoint, e.g. Mistral (EU) `https://api.mistral.ai/v1/embeddings` + `mistral-embed`, or OpenAI `https://api.openai.com/v1/embeddings` + `text-embedding-3-small`. Only public source text is sent. Off unless all three are set; then word overlap is used |
| `EMBEDDINGS_DIMENSIONS` | – | Ask for shorter vectors, for providers that support it (OpenAI `text-embedding-3-*`) |
| `EMBEDDINGS_MIN_SIMILARITY` | 0.8 | Cosine similarity at which two nearby reports count as the same incident. Depends on the model: calibrate with the eval set |

### Postgres

```bash
cd server
docker compose up -d   # Postgres 16 + PostGIS + pgvector on localhost:5432
DATABASE_URL=postgres://heyokay:heyokay@localhost:5432/heyokay npm run dev
TEST_DATABASE_URL=postgres://heyokay:heyokay@localhost:5432/heyokay_test npm test   # runs the store and pipeline suites on SQLite and Postgres
```

Schema changes are numbered migrations in `server/src/pg.ts` (`MIGRATIONS`), applied on start under an advisory lock, so several instances can start at once. Postgres needs the **PostGIS** and **pgvector** (`vector`, for dedup embeddings) extensions: the server runs `CREATE EXTENSION IF NOT EXISTS` for both, so on a managed database either enable them once as an admin or let the app's role create it. Finding the users affected by an event is a GIST index lookup on current locations and saved places.

## Deploy (Fly.io)

The server ships as a Docker image (`Dockerfile` at the repo root, building `server/`) with a Fly.io config (`fly.toml`, also at the root, where Fly's GitHub launcher looks): Frankfurt, one always-on machine, SQLite on a 1 GB persistent volume, health check on `/health`. In production the server refuses to start without `ADMIN_TOKEN`.

**Easiest: Fly's "Deploy from GitHub".** Connect the repo, branch `main`. Fly finds `fly.toml` and the Dockerfile at the root. Before deploying, add the secrets below (`ADMIN_TOKEN`, `NWS_USER_AGENT`, `GEOCODER_USER_AGENT`) and keep it to one machine. Fly then redeploys on every push to `main`.

**Automatic deploys on merge** (`.github/workflows/deploy.yml`): Fly's GitHub connection only deploys when you click Deploy in the dashboard, so a workflow deploys every merge to `main` that touches the server, after the tests pass. One-time setup:

1. Fly dashboard → app `heyokay` → **Tokens** → create a deploy token (no expiry) and copy it.
2. GitHub → the repo → Settings → Secrets and variables → Actions → **New repository secret**: name `FLY_API_TOKEN`, value the token.

Without that secret the workflow skips the deploy instead of failing. "Run workflow" in the Actions tab deploys by hand.

Or from the terminal, first time (from the repo root):

```bash
brew install flyctl && fly auth login
fly launch --no-deploy --copy-config      # accept the config; pick a unique app name if asked
fly volumes create heyokay_data --region fra --size 1 --yes
fly secrets set ADMIN_TOKEN="$(openssl rand -hex 24)" \
  NWS_USER_AGENT="HeyOkay (your contact email)" GEOCODER_USER_AGENT="HeyOkay (your contact email)"
fly deploy --ha=false                     # SQLite = exactly one machine
```

Afterwards: `fly deploy --ha=false` for each update, `fly logs` for logs, `fly secrets list` to check secrets. The API is at `https://<app>.fly.dev` and the Alert Desk at `https://<app>.fly.dev/admin`. To see the admin token later, set a new one with `fly secrets set ADMIN_TOKEN=…` (Fly never shows secrets again).

Point the app at it: `EXPO_PUBLIC_API_URL=https://<app>.fly.dev npx expo start --dev-client --tunnel`, or set `extra.apiUrl` in `app/app.json` for builds.

`fly.toml` sets `NWS_AREAS=CA` for US testing; remove it for a Germany-only server.

To move from SQLite to Postgres, set `DATABASE_URL` as a Fly secret (the database needs PostGIS and pgvector, see Postgres above); the server then ignores the volume. Managed Postgres in production is still open on the roadmap.

## How an alert is made (PRD 6.2)

1. **Ingest**: NINA (all official channels, with polygons) plus any RSS/Atom feed. Each item is stored once and versioned.
2. **Extract**: official items map directly from their structured data. Everything else goes to Claude for category, severity, place and confidence, with structured output. Without an API key, keyword rules handle it. Witness appeals and old news are dropped.
3. **Cluster**: the same incident from several sources becomes one event. A NINA update escalates the same event rather than creating a new one.
4. **Review gate**: unofficial items with low confidence or high severity wait at the Alert Desk.
5. **Compose and verify**: Claude writes a ≤50-character title and a ≤100-character body. A verifier rejects any number not found in the sources, alarm words ("Terror", "Panik"…) and stigmatising area labels. After two failures the alert falls back to a template. The recommended action always comes from a fixed library, never from the model.
6. **Match and rank**: the store finds users whose last location (from the past 24 hours) or saved places are near the event (a PostGIS index lookup on Postgres), and the event is checked against each of them. Then:
   - Official extreme warnings always push.
   - Categories the user turned off are suppressed.
   - Severity 1 goes to the feed only.
   - Learned "not relevant" ratings demote an event to the feed.
   - Severity 4 and above pushes.
   - Otherwise quiet hours and the daily limit decide.
7. **Push**: Expo push with an urgent channel for severity 4–5 and a tap that deep-links to the alert. The first sync after install backfills to the feed without a burst of notifications.

**Errors:** unexpected server errors (HTTP 5xx, ingest failures, unhandled rejections, uncaught exceptions) are written to stderr as one JSON line each with `"level":"error"` or `"fatal"`, with the route pattern but no query strings, headers or tokens.

**Privacy:** only the latest location per user is kept (rounded to about 100 m on the device), with no history. The model only ever sees public source text, never user data. Device tokens are stored hashed. `DELETE /v1/me` erases everything (GDPR Art. 17).

## App (PRD 5.3)

- **Onboarding**: value screen → location while in use → "always" with an explanation → notifications → categories → data consent. The device registers anonymously, with no account.
- **Feed**: alerts near you with pull to refresh and a calm empty state ("Alles okay.").
- **Alert detail**: map with the affected area, "Was du tun kannst", summary, linked sources, an "AI-written" note and a 👍/👎 rating that feeds ranking.
- **Settings**: categories, quiet hours, daily limit, location status, saved places (address → OS geocoder) and delete all data.
- **Background**: location task (about every 300 m or 15 min), push-token registration and notification tap → alert.
- **Crash reporting**: Firebase Crashlytics, opt-in via Settings ("Absturzberichte senden"), plus a calm error screen that reports render errors. Active only in development/store builds once `app/firebase/` holds the Firebase config files (see `app/firebase/README.md`); a no-op in Expo Go.

## Done vs. next

**Done:** everything above. Server: typechecked, 28 tests passing, and an end-to-end run over HTTP. App: typechecked and bundles for Android.

**Next, before a public beta:**
- Run the app on real devices; check background delivery on iOS (Low Power Mode) and on Android OEMs.
- Push receipts (handle `DeviceNotRegistered`), retries, and Sentry.
- More sources: BVG/VBB disruption API, Feuerwehr, and city press releases beyond Berlin.
- An English UI (prefs already carry `language`).
- A hosted deployment (Fly/Render) with managed Postgres + PostGIS and a managed Nominatim.
- Alert Desk login (currently one shared token), plus an audit log.
- App Store assets, privacy policy URL and the DPIA.
