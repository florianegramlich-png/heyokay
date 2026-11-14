# Instructions for the Hey-Okay build agent

You run once a day, unattended, and keep building Hey-Okay: calm, location-aware safety alerts for Germany. Read `README.md` for the architecture. The product spec is PRD v6.4; `ROADMAP.md` cites the PRD section for each item. When an item is ambiguous, follow the PRD intent as summarised there and note your interpretation in the changelog.

## Each run

1. **Work on the rolling branch.** Everything goes on the branch `agent/next`, with one open PR into `main`.
   - If `agent/next` exists, check it out and merge `origin/main` into it. Resolve conflicts in favour of `main`.
   - If it doesn't exist (Flori merged the last PR), create it from `main`.
2. **Check the baseline.** In `server`, run `npm ci && npm test && npm run typecheck`. In `app`, run `npm ci && npx tsc --noEmit`.
   - If anything is red, fixing it is today's task. Don't start a roadmap item.
3. **Pick the task.** Take the first unchecked item under "Up next" in `ROADMAP.md`.
   - Do only that item. If it's too big for one run, split it into smaller items in `ROADMAP.md`, then do the first one.
4. **Build it.**
   - Write tests next to the existing ones.
   - Keep the conventions: ESM + NodeNext, zod at the API boundary, no new runtime dependency unless the item needs one.
   - In `app/`, always add packages with `npx expo install`. Read `app/AGENTS.md` before touching Expo APIs.
5. **Verify.** Run everything from step 2 again. All green is required.
   - If you can't get it green, revert your changes for this item.
   - Then add a note under the item in `ROADMAP.md` saying what blocked you, and commit only that note.
6. **Record it.**
   - Tick the item off in `ROADMAP.md` and move it to "Done" with today's date.
   - Add a dated entry at the top of `CHANGELOG.md`: what changed, which tests were added, and anything Flori must do.
7. **Ship it.**
   - Commit with a clear message and push `agent/next`.
   - If no PR is open from `agent/next`, open one titled "Agent build: <date>" and keep it open across days.
   - Otherwise, add a PR comment summarising today's change.

## Rules

- Never push to `main`. Never force-push. Never merge your own PR.
- Never commit secrets, `.db` files or `node_modules`.
- The sandbox has no general internet access. Use fixtures for external feeds, and say in the changelog what to verify against the live source.
- Don't touch items under "Needs a human"; Flori owns those.
- UI copy is German first, calm, with no alarm words. The privacy rules in the README are product requirements, not suggestions.
- If something needs a decision from Flori, write it under "Open questions" at the top of `CHANGELOG.md` and continue with the next item that doesn't depend on it.
