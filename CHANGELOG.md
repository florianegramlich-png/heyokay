# Changelog

## Open questions

- **Crash reports: opt-in or opt-out?** (2026-11-16) Crashlytics is built as opt-in: native collection is off (`app/firebase.json`) and only the Settings toggle "Absturzberichte senden" turns it on, defaulting to off. That's the conservative reading of the privacy rules (§25 TTDSG consent for device access that isn't strictly necessary). If you'd rather collect by default, or ask during onboarding's consent step, tell me and I'll change it; it should also go into the privacy policy and DPIA either way.

## 2026-11-17

- **Automatic server deploys.** Fly's GitHub connection doesn't deploy on merge (it only deploys from the dashboard), so `.github/workflows/deploy.yml` tests and deploys the server on every merge to `main` that touches it. It skips the deploy, without failing, until the `FLY_API_TOKEN` repository secret exists. For Flori: create a Fly deploy token and add it on GitHub (README → Deploy).
- **Event updates and all-clears** [5.4] (roadmap item). People who got an alert are told when it changes or ends:
  - Gets more severe: a fresh alert, pushed as before.
  - Gets less severe, or its official end time moves by an hour or more: an "Update"/"Aktualisiert" alert in the feed only (no push).
  - Ends early (a cancellation, an NWS alert that vanishes from the feed with 15+ minutes left, or "End now" at the Alert Desk): an all-clear ("All clear: …" / "Entwarnung: …", "The warning has been lifted." / "Die Warnung ist aufgehoben."). It's a push only for people who got a push for it, never during their quiet hours.
  - Runs out on schedule: no message; the feed greys it out as "Ended"/"Beendet".
  - Updates and all-clears never count toward the daily push limit.
  - Server: alerts carry a `kind` (`new`/`update`/`all_clear`); `/v1/me/alerts` adds `kind` and `ended`; new `POST /admin/api/events/:id/end`; an "Active events" list with "End now (all clear)" on the Alert Desk. CAP updates now find their event through the stored source ids at any age, not just within 24 h, so multi-day NWS warnings no longer split into duplicates. The NWS poller reports which alerts are still listed and the pipeline reconciles after each successful poll. Template copy now follows the newest official message.
  - App: all-clear (green), update and "Ended" labels on cards and the detail screen, in German and English.
  - Fix: severe pushes used Android channel `severe`, which the app doesn't define; now `urgent`.
  - Tests: `server/test/lifecycle.test.ts` (8 tests: cancellation all-clear push, daily limit + quiet hours, downgrade and end-time updates incl. the 1-hour threshold, escalation, updates to multi-day warnings, feed reconciliation, German wording, API flags and admin auth). Server 50/50, typecheck clean; app `tsc` clean, iOS bundle exports; Alert Desk script syntax-checked.
  - For Flori: the app labels need a new app build (`eas build --profile preview`). The server part goes live with the merge (Fly redeploys `main`).
- **App talks to the hosted server by default.** `extra.apiUrl` is now `https://heyokay.fly.dev` (was `localhost:8787`), so builds work without a tunnel; `EXPO_PUBLIC_API_URL` still overrides it for a local server. Also committed Flori's EAS setup from her Mac (`app/eas.json` with development/preview/production profiles, EAS project id and owner in `app.json`, `expo-dev-client`) and removed duplicated `UIBackgroundModes` entries. Verified: `npm ci`, `tsc --noEmit`, `expo config` resolves the hosted URL, `expo install --check` clean.
- **Fix: Fly's GitHub launcher couldn't find the server.** It only looks at the repo root, so `Dockerfile` and `fly.toml` moved from `server/` to the root (the Dockerfile builds only `server/`; a root `.dockerignore` keeps the app out of the image). README → Deploy now describes Fly's "Deploy from GitHub" as the easiest route. Verified: the image builds from the root, `/health` answers, admin routes need the token.
- **Hosted backend, step 1: server deploy config** [10.4] (part of the "Deploy config" roadmap item; Flori asked for it to stop using tunnels).
  - `server/Dockerfile` (multi-stage, Node 22, compiled with `tsc` to `dist/`, no dev dependencies in the image), `.dockerignore`, `server/fly.toml` (Frankfurt, one always-on machine because of the 2-minute polling, SQLite on volume `heyokay_data` at `/data`, `/health` check), and a README "Deploy" section.
  - New scripts: `npm run build` (`tsconfig.build.json`) and `npm run serve`.
  - Safety: with `NODE_ENV=production` the server exits if `ADMIN_TOKEN` is still `change-me`. Contact strings and tokens are Fly secrets, not in `fly.toml`.
  - Verified: image builds; in the container `/health` answers, admin routes return 401 without the token and 200 with it, a registered device survives a container restart (volume), and the production guard stops a start without a token. Server 42/42, typecheck clean. Not verified here: an actual `fly deploy` (needs Flori's Fly account).
  - Still open for this roadmap item: managed Postgres (after the Postgres item), EAS build profiles and EAS Update.
  - For Flori: create a Fly.io account and run the five commands in README → Deploy.
- **Fix: iOS build failed without Firebase** (found by Flori's first EAS development build). `pod install` stopped because React Native Firebase was still autolinked and requires dynamic frameworks, which `app.config.ts` only turns on when the Firebase files exist. New `app/react-native.config.js` unlinks `@react-native-firebase/app` and `crashlytics` on iOS and Android until both files are in `app/firebase/`, so the rule is the same everywhere.
  - Verified: `expo-modules-autolinking react-native-config` lists no Firebase modules without the files and both with them; `tsc --noEmit` clean; iOS JS bundle builds. Not verifiable here: `pod install` itself (needs macOS), so the next EAS build is the real check.

## 2026-11-17

- **US test mode** (not a roadmap item; asked for by Flori to test on a real iPhone in California). Builds on [6.1 #5, 8.1].
  - Server: new source `src/sources/nws.ts` for US National Weather Service alerts (api.weather.gov, official CAP). Turn it on with `NWS_AREAS=CA` (state codes, or `lat,lon` points separated by `;`) and set `NWS_USER_AGENT` to a contact, as NWS requires. Test and exercise messages are dropped; a cancellation ends the event; an update that names an earlier alert (CAP `references`) merges into the same event. Different NWS alerts are never merged by similar wording.
  - Server: **exact warning areas.** Most NWS alerts only list forecast zones. Zone outlines are fetched once and cached, and stored on the event (`areas`). Matching now checks whether the user or saved place is inside an outline (plus the usual buffer) instead of the rough circle. Without this, one San Francisco alert would have matched everyone within 140 km. Events without outlines (NINA, RSS, manual) still use the circle.
  - Server: **English alerts.** Events carry a `language` taken from their source (NWS → `en`). Copy is written in that language: LLM prompt, template labels, and an English guidance library (US emergency number 911, because the only English source today is US). The verifier now also checks English alarm words and area-stigma phrases. Multi-zone alerts are titled by the warning ("Weather: Wind Advisory"), not by the first zone name. The Alert Desk manual form has a language field.
  - App: **English UI.** All text moved to `src/lib/i18n.ts` (German + English). Language defaults to the device language, can be switched on the first onboarding screen and in Settings ("Sprache / Language"), and is saved to the server prefs. Dates and times follow the language.
  - App: the feed shows a short note with a link to the system settings when location is off. That was today's "nothing shows up" cause on the iPhone.
  - Tests: `server/test/nws.test.ts` (10 tests) with real api.weather.gov responses from today (trimmed): headline cleaning, mapping, zone outlines, skipping tests, cancellation, the fetcher's zone cache, English copy end to end, reference-based merging, no fuzzy merging of different NWS alerts, and the English verifier. Server 42/42, typecheck clean. App `tsc --noEmit` clean, `expo export --platform ios` bundles. Live check: 43 active California alerts ingested into 43 events. A device in Pacifica got the Wind Advisory and the Beach Hazards Statement. Marina also got both, which is correct, because those alerts include zone CAZ530 (Southern Monterey Bay).
  - Follow-up idea: give NINA warnings exact outlines too (their GeoJSON is already fetched).

## 2026-11-16

- **CI** [9.3]: added `.github/workflows/ci.yml` with two jobs: `server` (`npm ci`, `npm test`, `npm run typecheck`) and `app` (`npm ci`, `npx tsc --noEmit`), on Node 22 with npm caching, triggered on every push and PR. Concurrent runs on the same ref are cancelled.
  - Tests: no new tests (workflow only). The workflow file was validated as YAML and its commands are the same ones run locally (server 28/28, both typechecks clean). It has not run on GitHub yet; the first run happens on this push.
  - For Flori: check the Actions tab on the PR. Optionally make both jobs required checks for `main` in branch protection.
- **Crash reporting** [5.3, 13]:
  - App: added `@react-native-firebase/app`, `@react-native-firebase/crashlytics` and `expo-build-properties` with `npx expo install`. A new `app/app.config.ts` adds their config plugins (and iOS `useFrameworks: "dynamic"`, which RN Firebase now requires because the Firebase Apple SDK is SPM-only) **only when both** `app/firebase/GoogleService-Info.plist` and `app/firebase/google-services.json` exist. Interpretation: the roadmap said "placeholder config files", but fake Firebase files would let a build ship with a broken Firebase setup, so instead builds work without them and crash reporting is a no-op until the real files are added.
  - App: `src/lib/crash.ts` wraps Crashlytics. It is a no-op in Expo Go and in builds without Firebase, sends nothing until the user opts in, never sets a user id or logs location or alert content, and deletes unsent reports when the user opts out. "Alle Daten löschen" also turns it off.
  - App: the root layout exports an expo-router `ErrorBoundary` (`src/components/ErrorScreen.tsx`): "Hier hat etwas nicht geklappt." with a "Nochmal versuchen" button; it reports the error. Settings has a new toggle under Datenschutz, shown only in builds that include Firebase.
  - Server: `src/errors.ts` writes each unexpected error as one JSON line on stderr (`level`, `time`, `context`, `name`, `message`, `stack`, plus route or source). Covered: HTTP 5xx (route pattern only, no ids, query strings or tokens), ingest failures per source, unhandled rejections (logged, keep running) and uncaught exceptions (logged as `fatal`, then exit so the host restarts). Fix on the way: Fastify client errors such as malformed JSON used to come back as 500; they now return 400 and aren't logged as errors.
  - Tests: `server/test/errors.test.ts` (4 tests: 5xx logging without secrets, malformed JSON → 400, process handlers, non-Error values). Server 32/32, typecheck clean. App: `tsc --noEmit` clean; `expo export --platform android` bundles; `expo prebuild` in a scratch copy with dummy Firebase files applied the Gradle plugins, copied both config files and set dynamic frameworks. Not verified: a real native build and a crash arriving in the Firebase console (no Firebase project or device here).
  - Note: one test run right after `npm ci` reported 1 failing test that I couldn't reproduce in 30+ runs. The new process-handler test originally emitted real `process` events; it now uses a stand-in emitter so it can't interfere with the test runner. If CI ever shows an intermittent failure, that's the place to look first.
  - `npm audit` in `app/` now reports 6 high-severity advisories in transitive dependencies of the Firebase packages (build-time tooling); not addressed, since `npm audit fix --force` would break SDK pinning.
  - For Flori: create the Firebase project and drop the two files into `app/firebase/` (listed under "Needs a human"), and answer the opt-in question above.

## 2026-11-15

- **Baseline fix, no roadmap item today.** `npm ci` in `app/` failed with ERESOLVE: the lockfile had pulled in `react-dom` 19.3.1 as a peer (via expo-router's Radix tabs), which requires `react@^19.3.1`, while the app pins `react` 19.3.0. AGENT.md says a red baseline is the day's task, so I added `react-dom` 19.3.0 as a direct dependency with `npx expo install react-dom` (the version Expo SDK 58 bundles). `npx expo install --check` reports everything up to date.
- Tests: no new tests (dependency-only change). Server: 28/28 passing, typecheck clean. App: `npm ci` and `tsc --noEmit` clean.
- For Flori: nothing to do. The CI item (next run) would have caught this on the original push.
- AGENT.md: at Flori's request the agent now does up to 3 roadmap items per run, one commit each, and stops early on a red check or an open question.

## 2026-11-14

- Initial MVP: server (28 tests) and Expo app. See README.
