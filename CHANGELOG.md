# Changelog

## Open questions

(none)

## 2026-11-15

- **Baseline fix, no roadmap item today.** `npm ci` in `app/` failed with ERESOLVE: the lockfile had pulled in `react-dom` 19.3.1 as a peer (via expo-router's Radix tabs), which requires `react@^19.3.1`, while the app pins `react` 19.3.0. AGENT.md says a red baseline is the day's task, so I added `react-dom` 19.3.0 as a direct dependency with `npx expo install react-dom` (the version Expo SDK 58 bundles). `npx expo install --check` reports everything up to date.
- Tests: no new tests (dependency-only change). Server: 28/28 passing, typecheck clean. App: `npm ci` and `tsc --noEmit` clean.
- For Flori: nothing to do. The CI item (next run) would have caught this on the original push.

## 2026-11-14

- Initial MVP: server (28 tests) and Expo app. See README.
