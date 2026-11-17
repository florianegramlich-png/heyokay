# Changelog

## Open questions

- **Crash reports: opt-in or opt-out?** (2026-11-16) Crashlytics is built as opt-in: native collection is off (`app/firebase.json`) and only the Settings toggle "Absturzberichte senden" turns it on, defaulting to off. That's the conservative reading of the privacy rules (§25 TTDSG consent for device access that isn't strictly necessary). If you'd rather collect by default, or ask during onboarding's consent step, tell me and I'll change it; it should also go into the privacy policy and DPIA either way.

## 2026-11-17

- **Fix: iOS build failed without Firebase** (found by Flori's first EAS development build). `pod install` stopped because React Native Firebase was still autolinked and requires dynamic frameworks, which `app.config.ts` only turns on when the Firebase files exist. New `app/react-native.config.js` unlinks `@react-native-firebase/app` and `crashlytics` on iOS and Android until both files are in `app/firebase/`, so the rule is the same everywhere.
  - Verified: `expo-modules-autolinking react-native-config` lists no Firebase modules without the files and both with them; `tsc --noEmit` clean; iOS JS bundle builds. Not verifiable here: `pod install` itself (needs macOS), so the next EAS build is the real check.

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
