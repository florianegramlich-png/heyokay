# Runbook: staging and release channels

Ship fast without breaking production (`docs/ARCHITECTURE.md` §8, step 7). The flow:

```
agent/next ──push──▶ staging server (heyokay-staging.fly.dev) ◀── web previews (Vercel) ◀── app "preview" channel
     │
     └─ PR merged ──▶ main ──▶ production server (heyokay.fly.dev) ◀── web (Vercel production) ◀── app "production" channel
```

## Server: staging on Fly (one-time setup, about 10 minutes)

The staging server uses the **same Supabase project** as production, but its own schema `heyokay_staging`. That keeps it free and fully separate: different tables, no real users. Migrations create the schema on first start.

1. Create the app: `fly apps create heyokay-staging` (the org is the same as `heyokay`).
2. Secrets (the same connection string as production; the schema comes from `fly.staging.toml`):
   ```
   fly secrets set -a heyokay-staging DATABASE_URL='postgresql://…supabase…' ADMIN_TOKEN='<a different token than production>'
   ```
   Leave out `ANTHROPIC_API_KEY`, `EXPO_ACCESS_TOKEN` and `RESEND_API_KEY` unless you want staging to use them. Without them it uses rules and templates, and sends no email.
3. Deploy token for GitHub: `fly tokens create deploy -a heyokay-staging`. Add it in GitHub → Settings → Secrets and variables → Actions as **`FLY_STAGING_API_TOKEN`**.
4. From then on, every push to `agent/next` that touches the server deploys staging (`.github/workflows/deploy-staging.yml`).

Staging sleeps when unused (`min_machines_running = 0`) and costs a few cents a day while it runs.

## Web: Vercel previews against staging

In Vercel, open project `heyokay-2zag` → Settings → Environment Variables. Add `NEXT_PUBLIC_API_URL` = `https://heyokay-staging.fly.dev` for **Preview** only (leave Production unset; it defaults to `https://heyokay.fly.dev`). Every PR preview then talks to staging.

## App: EAS Update channels

Already configured in the code: `expo-updates`, `runtimeVersion: { policy: "appVersion" }`, `updates.url`, and a channel per build profile in `app/eas.json` (`development`, `preview`, `production`).

- **One new build per profile** is needed once, because expo-updates is native code. Run `npx eas-cli build --profile preview --platform ios`, and later `--profile production`.
- **Then, JavaScript changes go out without a build:**
  ```
  cd ~/Documents/heyokay/app && npm run update:preview      # testers' phones (preview builds)
  cd ~/Documents/heyokay/app && npm run update:production   # store users, after checking preview
  ```
  The apps download the update on their next start and use it on the start after that.
- A change to native code (a new native module, permissions, `app.json` plugins) still needs a new build. Bump `version` in `app.json` for it. Because of the `appVersion` policy, updates then only go to builds with the same version.
- Development builds keep loading code from your Mac (`expo start --dev-client`) as before.

## Secrets: where each one lives

| Secret | Production (Fly `heyokay`) | Staging (Fly `heyokay-staging`) | GitHub Actions |
|---|---|---|---|
| `DATABASE_URL` (Supabase) | ✓ after the switch | ✓ | – |
| `ADMIN_TOKEN` | ✓ | ✓ (different) | – |
| `ANTHROPIC_API_KEY`, `EMBEDDINGS_API_KEY` (Mistral) | ✓ | optional | – |
| `OPENWEATHER_API_KEY`, `RESEND_API_KEY` + `MAIL_FROM`, `EXPO_ACCESS_TOKEN`, `SENTRY_DSN` | when set up | optional | – |
| `FLY_API_TOKEN` | – | – | ✓ (production deploys) |
| `FLY_STAGING_API_TOKEN` | – | – | ✓ (staging deploys) |

Never commit secrets. `fly secrets list -a <app>` shows names only.
