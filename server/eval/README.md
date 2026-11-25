# AI evaluation set

Labelled cases for `npm run eval` (in `server/`), PRD 6.4 / 6.5. The harness runs the pipeline's
extraction and alert-text steps on each case and reports:

- **extraction accuracy**: alert or not right, and for alerts the topic (plus precision/recall of "is an alert");
- **severity agreement**: exact and within one level, where both the label and the pipeline say "alert";
- **verifier pass rate**: share of AI-written alert texts the fact verifier accepts (and how often the template took over);
- **cost per event**: tokens × `LLM_PRICE_IN/OUT_EUR_PER_MTOK`, divided by the number of cases.

```
npm run eval                        # models from LLM_PROVIDERS (keyword rules when no key is set)
npm run eval -- --rules             # the rules baseline, no model calls
npm run eval -- --set synthetic-de  # one file
npm run eval -- --json report.json  # full report with every case
npm run eval -- --compare           # each LLM_PROVIDERS entry alone + the rules, side by side, suggested order
```

Model runs cost money (about 1–2 calls per case) and use the API keys in your environment. They
don't touch the database or the daily AI budget.

## Case files (`cases/*.json`)

`{ "name", "description", "cases": [ … ] }`. A case is either written out:

```json
{ "id": "s01",
  "item": { "sourceName": "BVG", "title": "…", "body": "…", "publishedAt": "2026-11-20T08:00:00Z" },
  "expect": { "isEvent": true, "category": "transit", "severity": 3 } }
```

or points at an item in a saved feed under `test/fixtures` (`"fixture": { "file", "format": "rss" | "presseportal", "index" }`,
with `sourceName`, `category` and `defaultArea` as the source adapter would add them).

- `expect.category` may be a list when more than one topic is right.
- Severity: 1 info, 2 minor disruption, 3 moderate, 4 serious danger, 5 danger to life for many (`src/pipeline/extract.ts`).
- Not an alert: past incidents, witness appeals, court reports, statistics, recruitment, openings, missing-person searches.
- No names or personal details of people in written cases.

Sets today: `synthetic-de` (50 written German cases, 35 alerts / 15 not) and `fixtures` (14 real press releases).

## Labels from the Alert Desk

Every event a reviewer approves (with the severity they chose) or rejects can become a case:
Alert Desk → "Download reviewed cases (eval set)", or `GET /admin/api/eval-export?since=<ISO time>`
with the admin token. The file is already in this format (`origin: "desk"`, id `desk-<event id>`);
save it here as `cases/desk-<date>.json`. Concierge alerts and official warnings are left out.

**Before committing**, read the texts and remove names, ages and other personal details: they are
press releases as published.
