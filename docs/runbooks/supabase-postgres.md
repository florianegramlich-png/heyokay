# Runbook: move production to Supabase Postgres

Scaling step 1 (`docs/ARCHITECTURE.md` §8). Flori chose Supabase on 2026-11-18, because Nurse Companion already uses it.

## What we use from Supabase

Only Postgres, with PostGIS and pgvector. The server talks to it directly. We don't use Supabase Auth, Storage, Edge Functions or the Data API.

**Our tables live in their own schema, `heyokay`** (`DATABASE_SCHEMA=heyokay`). Supabase publishes the `public` schema through its Data API using a publishable key that ships in apps. Tables in `public` without row-level security could be read with that key. The `heyokay` schema isn't exposed, so nothing is reachable except through our server. Extensions (PostGIS, pgvector) are created in `public`, which is normal.

## 1. Project

- Organisation: Flori's (free plan; Nurse Companion is in it too).
- Name `Hey-Okay`, region **eu-central-1 (Frankfurt)**, close to Fly `fra` and inside the EU for GDPR.
- Free plan: 500 MB database and no automatic backups. Upgrade to Pro before public launch (daily backups, point-in-time restore as an add-on, no pausing).

## 2. Connection string

In the Supabase dashboard: Project → Connect → **Session pooler** (IPv4 and IPv6, port 5432). Session mode keeps the advisory locks and prepared statements we rely on. Don't use the transaction pooler (port 6543). The direct connection also works from Fly (IPv6).

```
postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?uselibpqcompat=true&sslmode=require
```

`uselibpqcompat=true&sslmode=require` encrypts the connection. Without it, node-postgres rejects Supabase's certificate chain.

## 3. Copy the data and switch (about 5 minutes of no new alerts; the API stays up)

```bash
# a) Set the secrets without restarting (the app keeps using SQLite until DB_PATH stops mattering).
fly secrets set --stage DATABASE_URL='postgresql://…' DATABASE_SCHEMA=heyokay -a heyokay

# b) First copy while the app runs (creates the schema, runs migrations 1–7, copies every table):
fly ssh console -a heyokay -C "sh -c 'DATABASE_URL=… DATABASE_SCHEMA=heyokay node dist/tools/sqlite-to-pg.js /data/heyokay.db'"

# c) Switch: deploying applies the staged secrets; the server now starts on Postgres.
fly deploy -a heyokay   # or merge to main

# d) Catch-up copy of anything written in between (already-copied rows are skipped):
fly ssh console -a heyokay -C "sh -c 'DATABASE_URL=… DATABASE_SCHEMA=heyokay node dist/tools/sqlite-to-pg.js /data/heyokay.db'"
```

The tool prints row counts per table, never contents. `failed` should be 0.

## 4. Check

- `curl https://heyokay.fly.dev/health`: `ok: true`, `worker.leading: true`, and sources show `lastOkAt`.
- The app still shows your places and alerts (same token, no new sign-in).
- In Supabase: Table editor → schema `heyokay` → `users` row count matches.

## 5. Afterwards (makes scaling real)

- Keep the SQLite volume for a week as a fallback (roll back by removing `DATABASE_URL`). Then remove `[[mounts]]` and `DB_PATH` from `fly.toml`.
- Split into process groups (`api` with `ROLE=api`, `worker` with `ROLE=worker`), see the comment in `fly.toml`.
- Scale: `fly scale count api=2 worker=2`.
