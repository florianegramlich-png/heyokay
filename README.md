# Hey-Okay — MVP

Calm, location-aware safety alerts for Germany. One sentence on what's happening near you and what to do — only when it concerns you. Built to PRD v6.4 (sections 5–6).

```
heyokay/
├── server/   Node 22 · Fastify · SQLite (node:sqlite) · Claude API — ingest → AI pipeline → push
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
| `DB_PATH` | ./heyokay.db | SQLite file |
| `ADMIN_TOKEN` | change-me | Alert Desk + admin API — **set this** |
| `ANTHROPIC_API_KEY` | – | Without it: keyword rules + fixed templates (still works, less coverage) |
| `HEYOKAY_MODEL` | claude-haiku-5-5 | |
| `NINA_CHANNELS` | mowas,katwarn,biwapp,dwd,lhp,police | Official BBK warnings |
| `RSS_FEEDS` | [] | JSON list of police / transit feeds |
| `POLL_INTERVAL_SEC` | 120 | |
| `GEOCODER_URL` | Nominatim | Use your own instance for volume; the built-in gazetteer is the fallback |
| `MATCH_BUFFER_M` | 1500 | Extra distance around an event's area |
| `REVIEW_CONFIDENCE` / `REVIEW_SEVERITY` | 0.6 / 4 | Below/at these, non-official items go to the Alert Desk |

## How an alert is made (PRD 6.2)

1. **Ingest**: NINA (all official channels, with polygons) plus any RSS/Atom feed. Each item is stored once and versioned.
2. **Extract**: official items map directly from their structured data. Everything else goes to Claude for category, severity, place and confidence, with structured output. Without an API key, keyword rules handle it. Witness appeals and old news are dropped.
3. **Cluster**: the same incident from several sources becomes one event. A NINA update escalates the same event rather than creating a new one.
4. **Review gate**: unofficial items with low confidence or high severity wait at the Alert Desk.
5. **Compose and verify**: Claude writes a ≤50-character title and a ≤100-character body. A verifier rejects any number not found in the sources, alarm words ("Terror", "Panik"…) and stigmatising area labels. After two failures the alert falls back to a template. The recommended action always comes from a fixed library, never from the model.
6. **Match and rank**: the event is checked against the user's last location and saved places. Then:
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
- Postgres + PostGIS once the user count passes about 50k (the schema maps 1:1), and a hosted deployment (Fly/Render) with a managed Nominatim.
- Alert Desk login (currently one shared token), plus an audit log.
- App Store assets, privacy policy URL and the DPIA.
