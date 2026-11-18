# Hey-Okay web

The browser version of Hey-Okay, in the look of the v0 design ("Fork of Hey-Okay app"), connected to the real server.

- **Jetzt / Now**: what affects you and your saved places right now, grouped by category; "Alles okay." when nothing does. No risk scores or area ratings (product rule: no area-level scores).
- **Verlauf / History**: everything from the last few days, including updates, all-clears and ended events.
- **Alert detail**: what to do, summary, sources, AI note, and "Was this relevant?" (feeds ranking).
- **Settings**: language (Deutsch/English), topics, quiet hours, daily limit, saved places (address search via OpenStreetMap Nominatim), delete all data.
- **Onboarding**: same steps as the phone app, minus notifications. The browser registers anonymously (device token in localStorage); no account.

Not in the web app: push notifications and background location (use the phone app), payments (Decision 5 is open), sign-in (roadmap item "Sign-in").

```bash
cd web
npm ci
NEXT_PUBLIC_API_URL=http://localhost:8787 npm run dev   # against `cd server && npm run demo`
npm test && npm run typecheck && npm run build
```

`NEXT_PUBLIC_API_URL` defaults to `https://heyokay.fly.dev`.

**Deploy on Vercel:** import the repo, set **Root Directory** to `web`, framework Next.js. No environment variables are needed for the hosted server.

Strings: the phone app's dictionaries are copied into `lib/app-strings.ts` (so both apps say the same thing); web-only strings are in `lib/i18n.ts`.
