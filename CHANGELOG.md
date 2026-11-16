# Changelog

## Open questions

(none)

## 2026-11-16

- **CI** [9.3]: added `.github/workflows/ci.yml` with two jobs: `server` (`npm ci`, `npm test`, `npm run typecheck`) and `app` (`npm ci`, `npx tsc --noEmit`), on Node 22 with npm caching, triggered on every push and PR. Concurrent runs on the same ref are cancelled.
  - Tests: no new tests (workflow only). The workflow file was validated as YAML and its commands are the same ones run locally (server 28/28, both typechecks clean). It has not run on GitHub yet; the first run happens on this push.
  - For Flori: check the Actions tab on the PR. Optionally make both jobs required checks for `main` in branch protection.

## 2026-11-15

- **Baseline fix, no roadmap item today.** `npm ci` in `app/` failed with ERESOLVE: the lockfile had pulled in `react-dom` 19.3.1 as a peer (via expo-router's Radix tabs), which requires `react@^19.3.1`, while the app pins `react` 19.3.0. AGENT.md says a red baseline is the day's task, so I added `react-dom` 19.3.0 as a direct dependency with `npx expo install react-dom` (the version Expo SDK 58 bundles). `npx expo install --check` reports everything up to date.
- Tests: no new tests (dependency-only change). Server: 28/28 passing, typecheck clean. App: `npm ci` and `tsc --noEmit` clean.
- For Flori: nothing to do. The CI item (next run) would have caught this on the original push.
- AGENT.md: at Flori's request the agent now does up to 3 roadmap items per run, one commit each, and stops early on a red check or an open question.

## 2026-11-14

- Initial MVP: server (28 tests) and Expo app. See README.
