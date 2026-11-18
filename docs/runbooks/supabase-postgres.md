# Runbook: move production to Supabase Postgres

Scaling step 1 (`docs/ARCHITECTURE.md` §8). Flori chose Supabase on 2026-11-18, because Nurse Companion already uses it.

## What we use from Supabase

Only Postgres, with PostGIS and pgvector. The server talks to it directly. We don't use Supabase Auth, Storage, Edge Functions or the Data API.

**Our tables live in their own schema, `heyokay`** (`DATABASE_SCHEMA=heyokay`). Supabase publishes the `public` schema through its Data API using a publishable key that ships in apps. Tables in `public` without row-level security could be read with that key. The `heyokay` schema isn't exposed, so nothing is reachable except through our server. Extensions (PostGIS, pgvector) are created in `public`, which is normal.

## 1. Project (done 2026-11-18)

- Project **Hey-Okay**, ref `wlufgdikkszganhywzpg`, region **eu-central-1 (Frankfurt)**, Postgres 17, in Flori's organisation (free plan, next to Nurse Companion).
- Schema `heyokay` is created and migrations 1–7 are applied (Supabase migrations `heyokay_schema_v1_to_v7` and `lock_down_public_api`). Checked: PostGIS distance query and pgvector work, 12 tables, and the API roles `anon`/`authenticated` have no access to `heyokay`.
- Free plan: 500 MB and no automatic backups. Upgrade to Pro before the public launch.
- **Recommended (dashboard, 1 click):** Project Settings → Data API → turn it **off**. We never use it, and that removes the remaining advisor warnings. Those are about PostGIS's own reference table `spatial_ref_sys` and the function `st_estimatedextent` in `public`, which belong to Supabase's admin role, so we can't revoke them. Neither holds our data. "Extension in public" stays as a warning: PostGIS can't be moved, and the code refers to `public.geography`.

## 2. Connection string

1. Dashboard → Project Settings → Database → **Reset database password**. Choose one and keep it in your password manager. I never see it.
2. Dashboard → **Connect** → **Session pooler** (works over IPv4 and IPv6, port 5432). Session mode keeps the advisory locks we rely on. Don't use the transaction pooler (port 6543).
3. Append `?uselibpqcompat=true&sslmode=require` (encrypts the connection; without it, node-postgres rejects Supabase's certificate chain):

```
postgresql://postgres.wlufgdikkszganhywzpg:<password>@aws-…-eu-central-1.pooler.supabase.com:5432/postgres?uselibpqcompat=true&sslmode=require
```

## 3. Copy the data and switch (a few minutes; nobody loses their sign-in)

PR #16 must be merged and deployed first, so the copy tool is on the server.

```bash
# a) First copy, while production still runs on SQLite. Open a shell on the machine:
fly ssh console -a heyokay
#    …and inside it (paste your connection string):
DATABASE_URL='postgresql://…' DATABASE_SCHEMA=heyokay node dist/tools/sqlite-to-pg.js /data/heyokay.db
exit

# b) Switch: setting the secrets restarts the server on Postgres.
fly secrets set DATABASE_URL='postgresql://…' DATABASE_SCHEMA=heyokay -a heyokay

# c) Straight away, the catch-up copy (anything written between a and b; copied rows are skipped):
fly ssh console -a heyokay
DATABASE_URL="$DATABASE_URL" DATABASE_SCHEMA=heyokay node dist/tools/sqlite-to-pg.js /data/heyokay.db
exit
```

The tool prints row counts per table, never contents. `failed` should be 0.

Rollback: `fly secrets unset DATABASE_URL DATABASE_SCHEMA -a heyokay` (back to SQLite, which stays untouched).

## 4. Check

- `curl https://heyokay.fly.dev/health`: `ok: true`, `worker.leading: true`, and sources show `lastOkAt`.
- The app still shows your places and alerts (same token, no new sign-in).
- In Supabase: Table editor → schema `heyokay` → `users` row count matches.

## 5. Afterwards (makes scaling real)

- Keep the SQLite volume for a week as a fallback (roll back by removing `DATABASE_URL`). Then remove `[[mounts]]` and `DB_PATH` from `fly.toml`.
- Split into process groups (`api` with `ROLE=api`, `worker` with `ROLE=worker`), see the comment in `fly.toml`.
- Scale: `fly scale count api=2 worker=2`.
