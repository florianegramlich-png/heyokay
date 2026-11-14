# Hey-Okay roadmap

The build agent takes the **first unchecked item** in "Up next", builds it, and ticks it off here in the same commit.
Flori edits this file to steer: reorder, add or delete items. Items under "Needs a human" are never picked by the agent.

## Up next

- [ ] **CI**: GitHub Actions workflow running server tests and typecheck, plus app typecheck, on every push and PR.
- [ ] **Push receipts**: fetch Expo push receipts after sending; clear the push token on `DeviceNotRegistered`; retry transient errors with backoff. Tests with a fake Expo endpoint.
- [ ] **Data retention**: hourly job that expires ended events, deletes alerts older than 30 days and source items older than 7 days, and clears locations not updated in 30 days. Tests.
- [ ] **API hardening**: per-token and per-IP rate limits, request size limits and security headers. Tests.
- [ ] **Alert Desk login**: individual reviewer accounts (email + password hash, session cookie) instead of the shared token, plus an audit log of approve, edit and reject actions shown on the desk.
- [ ] **BVG/VBB disruptions source**: adapter for the VBB/HAFAS disruption feed (remarks/himMessages) mapped to `transit` items with affected stations geocoded. Fixture-based tests, because the agent sandbox has no network access to the feed.
- [ ] **Feuerwehr Berlin source**: press releases RSS adapter config plus extraction tuning for fire and hazardous-material incidents. Fixtures and tests.
- [ ] **App: English UI**: lightweight i18n (de/en) driven by `prefs.language` and the device locale; a language switch in settings.
- [ ] **App: offline feed**: cache the last feed and alert details in AsyncStorage; show the cached data with a "Stand: …" note when offline.
- [ ] **App: unit tests**: jest-expo set up, with tests for `lib/api`, `lib/theme.timeAgo` and the onboarding step logic.
- [ ] **Deploy config**: Dockerfile for the server, a `fly.toml` with a persistent volume for SQLite, a health check and a README section on deploying.
- [ ] **Event updates**: when an event escalates or is lifted, send an update or an all-clear alert ("Entwarnung") to users who got the original, without counting toward the daily limit.
- [ ] **Postgres adapter**: a Store interface with both SQLite and Postgres/PostGIS implementations behind it, selected by `DATABASE_URL`. Run the same test suite against both.

## Needs a human

- Run the app on a real iPhone and Android phone (development build); verify background location and push when the app is closed.
- Create the EAS project; put the `projectId` in `app/app.json → extra.eas.projectId`.
- Get an Anthropic API key and admin token; choose hosting.
- Privacy policy URL, DPIA, App Store and Play Store listings.

## Done

- [x] Server MVP: NINA + RSS ingest, AI extraction, clustering, review gate, compose + verifier, ranking, Expo push, Alert Desk, GDPR delete. 28 tests.
- [x] App MVP: onboarding, feed, alert detail with map and rating, settings, background location, push deep links.
