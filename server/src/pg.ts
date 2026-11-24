import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import type {
  Decision,
  Alert, EventStatus, Feedback, RiskEvent, SavedPlace, SourceItem, User, UserPrefs,
} from './types.js';
import { DEFAULT_PREFS, normalizePrefs, savedPrefs } from './types.js';
import { hashToken } from './db.js';
import { LOCATION_MAX_AGE_MS, MAX_PLACE_RADIUS_M } from './geo.js';
import { SCHEDULED_LOOKBACK_H, cellOf, computeMetrics, type Area, type Metrics, type Account, type AccountIdentity, type IdentityProvider, type EmailCode, type PushStatus, type Store, type StoredPushTicket, type UserWithPlaces, type PushJob, type LlmUsageDay, type DecisionQuery, decisionLimit } from './store.js';
import type { PushTicket } from './push.js';
import type { SourceStatus } from './ingest.js';

/**
 * Schema migrations, applied in order and recorded in `schema_migrations`. Append new entries;
 * never edit one that has shipped.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE, push_token text,
        prefs jsonb NOT NULL, lat double precision, lon double precision,
        location_updated_at timestamptz, created_at timestamptz NOT NULL
      );
      CREATE TABLE saved_places (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label text NOT NULL, lat double precision NOT NULL, lon double precision NOT NULL, radius_m double precision NOT NULL
      );
      CREATE INDEX saved_places_user ON saved_places(user_id);
      CREATE TABLE source_items (
        source text NOT NULL, external_id text NOT NULL, payload jsonb NOT NULL,
        event_id text, first_seen_at timestamptz NOT NULL,
        PRIMARY KEY (source, external_id)
      );
      CREATE TABLE events (
        id text PRIMARY KEY, data jsonb NOT NULL, status text NOT NULL,
        category text NOT NULL, lat double precision NOT NULL, lon double precision NOT NULL,
        starts_at timestamptz NOT NULL, ends_at timestamptz, updated_at timestamptz NOT NULL
      );
      CREATE INDEX events_status ON events(status, updated_at DESC);
      CREATE INDEX events_starts ON events(starts_at);
      CREATE TABLE alerts (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_id text NOT NULL, event_revision integer NOT NULL, data jsonb NOT NULL,
        delivery text NOT NULL, feedback text, created_at timestamptz NOT NULL,
        UNIQUE (user_id, event_id, event_revision)
      );
      CREATE INDEX alerts_user ON alerts(user_id, created_at DESC);
      CREATE INDEX alerts_created ON alerts(created_at);
    `,
  },
  {
    // PostGIS matching: generated geography points with GIST indexes, so finding affected users
    // is an index lookup instead of a loop over everyone.
    version: 2,
    sql: `
      CREATE EXTENSION IF NOT EXISTS postgis SCHEMA public;
      ALTER TABLE users ADD COLUMN geog public.geography(Point, 4326) GENERATED ALWAYS AS (
        CASE WHEN lat IS NULL OR lon IS NULL THEN NULL
             ELSE public.ST_SetSRID(public.ST_MakePoint(lon, lat), 4326)::public.geography END
      ) STORED;
      CREATE INDEX users_geog ON users USING GIST (geog);
      CREATE INDEX users_location_updated ON users(location_updated_at);
      ALTER TABLE saved_places ADD COLUMN geog public.geography(Point, 4326) GENERATED ALWAYS AS (
        public.ST_SetSRID(public.ST_MakePoint(lon, lat), 4326)::public.geography
      ) STORED;
      CREATE INDEX saved_places_geog ON saved_places USING GIST (geog);
      ALTER TABLE saved_places ADD CONSTRAINT saved_places_radius CHECK (radius_m > 0 AND radius_m <= ${MAX_PLACE_RADIUS_M});
    `,
  },
  {
    // Event updates and all-clears look up everyone who got an alert for an event.
    version: 3,
    sql: `CREATE INDEX alerts_event ON alerts(event_id);`,
  },
  {
    // Embedding-based dedup: one vector per event, compared with pgvector's cosine distance.
    // No fixed dimension (it depends on the provider), so no ANN index: candidates are already
    // narrowed to the few active events nearby before similarity is computed.
    version: 4,
    sql: `
      CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;
      CREATE TABLE event_embeddings (
        event_id text PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        model text NOT NULL, embedding public.vector NOT NULL, updated_at timestamptz NOT NULL
      );
    `,
  },
  {
    // Push delivery: one row per push with Expo's ticket, checked against the receipt later.
    version: 5,
    sql: `
      CREATE TABLE push_tickets (
        id uuid PRIMARY KEY, ticket_id text UNIQUE, alert_id uuid NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, token text NOT NULL,
        status text NOT NULL, error text, attempt integer NOT NULL, created_at timestamptz NOT NULL, checked_at timestamptz
      );
      CREATE INDEX push_tickets_pending ON push_tickets(status, created_at);
    `,
  },
  {
    // Sign-in: devices (bearer tokens) per user, accounts, email codes.
    version: 6,
    sql: `
      CREATE TABLE devices (
        token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL
      );
      CREATE INDEX devices_user ON devices(user_id);
      INSERT INTO devices (token_hash, user_id, created_at) SELECT token_hash, id, created_at FROM users;
      CREATE TABLE accounts (
        id uuid PRIMARY KEY, email text NOT NULL UNIQUE,
        user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL
      );
      CREATE TABLE email_codes (
        email text PRIMARY KEY, code_hash text NOT NULL, expires_at timestamptz NOT NULL,
        attempts integer NOT NULL, sends integer NOT NULL, window_start timestamptz NOT NULL
      );
    `,
  },
  {
    // Leases: exactly one worker runs ingest and push at a time, across machines (roles.ts).
    version: 7,
    sql: `CREATE TABLE leases (name text PRIMARY KEY, holder text NOT NULL, expires_at timestamptz NOT NULL);`,
  },
  {
    // Delivery queue: matching writes one job per push; senders claim batches with SKIP LOCKED.
    version: 8,
    sql: `
      CREATE TABLE push_jobs (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token text NOT NULL, alert jsonb NOT NULL, attempt integer NOT NULL, created_at timestamptz NOT NULL,
        locked_by text, locked_until timestamptz
      );
      CREATE INDEX push_jobs_order ON push_jobs(created_at);
    `,
  },
  {
    // Source health, so any API machine can show what the worker sees.
    version: 9,
    sql: `CREATE TABLE source_status (key text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL);`,
  },
  {
    // AI spend per day, for the daily budget and the Alert Desk.
    version: 10,
    sql: `CREATE TABLE llm_usage (day date PRIMARY KEY, calls integer NOT NULL, input_tokens bigint NOT NULL, output_tokens bigint NOT NULL, eur double precision NOT NULL, skipped integer NOT NULL);`,
  },
  {
    // Evening summary: at most one per person and local day, whichever worker gets there first.
    version: 11,
    sql: `CREATE TABLE digests (user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, day date NOT NULL, sent_at timestamptz NOT NULL, PRIMARY KEY (user_id, day));`,
  },
  {
    // Sign in with Apple / Google: the provider's stable user id, linked to an account.
    version: 12,
    sql: `
      CREATE TABLE account_identities (
        provider text NOT NULL, subject text NOT NULL,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created_at timestamptz NOT NULL,
        PRIMARY KEY (provider, subject)
      );
      CREATE INDEX account_identities_account ON account_identities(account_id);
    `,
  },
  {
    // Decision log (PRD 6.3): every pipeline and Alert Desk decision, no user data.
    version: 13,
    sql: `
      CREATE TABLE decisions (id uuid PRIMARY KEY, seq bigserial, at timestamptz NOT NULL, kind text NOT NULL, event_id text, data jsonb NOT NULL);
      CREATE INDEX decisions_at ON decisions(at);
      CREATE INDEX decisions_event ON decisions(event_id, at);
    `,
  },
];

/**
 * PostGIS measures on the WGS84 spheroid; the pipeline's `match` uses a sphere. The two differ by
 * well under 1 %, so the index search is widened by 1 % + 10 m to return a superset, and `match`
 * makes the final call. Both backends therefore pick exactly the same users.
 */
const SPHEROID_SLACK = 1.01;
const SLACK_M = 10;

export interface PgStoreOptions {
  /** Use a separate schema (created if missing), e.g. one per test. Default: the connection's search_path. */
  schema?: string;
  /** Drop that schema on close() — for tests only. */
  dropSchemaOnClose?: boolean;
  max?: number;
}

/**
 * Postgres storage for production (selected by DATABASE_URL). Same behaviour as SqliteStore;
 * the shared store contract and end-to-end tests run against both.
 * Location: only the latest point per user is stored — no location history.
 */
export class PgStore implements Store {
  private constructor(readonly pool: pg.Pool, private opts: PgStoreOptions) {}

  /** Connects, creates the schema if asked, and applies pending migrations. */
  static async connect(url: string, opts: PgStoreOptions = {}): Promise<PgStore> {
    if (opts.schema && !/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error(`invalid schema name: ${opts.schema}`);
    const pool = new pg.Pool({
      connectionString: url,
      max: opts.max ?? 10,
      // Per connection, not as a startup option: poolers like Supabase's Supavisor don't pass startup
      // options through. The pool waits for onConnect before handing the connection out.
      ...(opts.schema ? { onConnect: async (client: pg.PoolClient) => { await client.query(`SET search_path = ${opts.schema}, public`); } } : {}),
    } as pg.PoolConfig);
    const store = new PgStore(pool, opts);
    try {
      await store.migrate();
    } catch (err) {
      await pool.end();
      throw err;
    }
    return store;
  }

  private async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One migrator at a time per database, even with several server instances starting together.
      // Database-wide (not per schema) because extensions (PostGIS, pgvector) are database-wide too.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('heyokay_migrations'))`);
      if (this.opts.schema) await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.opts.schema}`);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const { rows } = await client.query<{ version: number }>(`SELECT version FROM schema_migrations`);
      const done = new Set(rows.map((r) => r.version));
      for (const m of MIGRATIONS) {
        if (done.has(m.version)) continue;
        await client.query(m.sql);
        await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [m.version]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async q<R extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
    return this.pool.query<R>(sql, params);
  }

  // ── users ────────────────────────────────────────────────────────────────
  async createUser(pushToken: string | null, prefs?: Partial<UserPrefs>): Promise<{ user: User; token: string }> {
    const token = randomBytes(24).toString('base64url');
    const user: User = {
      id: randomUUID(), tokenHash: hashToken(token), pushToken,
      prefs: { ...DEFAULT_PREFS, ...prefs }, lat: null, lon: null,
      locationUpdatedAt: null, createdAt: new Date().toISOString(),
    };
    await this.tx(async (c) => {
      await c.query(`INSERT INTO users (id, token_hash, push_token, prefs, created_at) VALUES ($1,$2,$3,$4,$5)`,
        [user.id, user.tokenHash, pushToken, JSON.stringify(user.prefs), user.createdAt]);
      await c.query(`INSERT INTO devices (token_hash, user_id, created_at) VALUES ($1,$2,$3)`, [user.tokenHash, user.id, user.createdAt]);
    });
    return { user, token };
  }

  async userByToken(token: string): Promise<User | null> {
    const { rows } = await this.q(`SELECT u.* FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = $1`, [hashToken(token)]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async getUser(id: string): Promise<User | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.q(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async allUsers(): Promise<User[]> {
    return (await this.q(`SELECT * FROM users`)).rows.map(rowToUser);
  }

  async updatePrefs(userId: string, prefs: UserPrefs): Promise<void> {
    await this.q(`UPDATE users SET prefs = $1 WHERE id = $2`, [JSON.stringify(savedPrefs(prefs)), userId]);
  }

  async updatePushToken(userId: string, pushToken: string | null): Promise<void> {
    await this.q(`UPDATE users SET push_token = $1 WHERE id = $2`, [pushToken, userId]);
  }

  async updateLocation(userId: string, lat: number, lon: number): Promise<void> {
    await this.q(`UPDATE users SET lat = $1, lon = $2, location_updated_at = $3 WHERE id = $4`,
      [lat, lon, new Date().toISOString(), userId]);
  }

  /** GDPR erasure: user, places and alerts, in one transaction. */
  async deleteUser(userId: string): Promise<void> {
    if (!isUuid(userId)) return;
    await this.tx(async (c) => {
      await c.query(`DELETE FROM push_tickets WHERE user_id = $1`, [userId]);
      await c.query(`DELETE FROM account_identities WHERE account_id IN (SELECT id FROM accounts WHERE user_id = $1)`, [userId]);
      await c.query(`DELETE FROM accounts WHERE user_id = $1`, [userId]);
      await c.query(`DELETE FROM devices WHERE user_id = $1`, [userId]);
      await c.query(`DELETE FROM alerts WHERE user_id = $1`, [userId]);
      await c.query(`DELETE FROM saved_places WHERE user_id = $1`, [userId]);
      await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });
  }

  // ── saved places ─────────────────────────────────────────────────────────
  async addPlace(userId: string, label: string, lat: number, lon: number, radiusM: number): Promise<SavedPlace> {
    const place: SavedPlace = { id: randomUUID(), userId, label, lat, lon, radiusM };
    await this.q(`INSERT INTO saved_places (id, user_id, label, lat, lon, radius_m) VALUES ($1,$2,$3,$4,$5,$6)`,
      [place.id, userId, label, lat, lon, radiusM]);
    return place;
  }

  async places(userId: string): Promise<SavedPlace[]> {
    if (!isUuid(userId)) return [];
    const { rows } = await this.q(`SELECT * FROM saved_places WHERE user_id = $1 ORDER BY label, id`, [userId]);
    return rows.map((r) => ({ id: r.id, userId: r.user_id, label: r.label, lat: r.lat, lon: r.lon, radiusM: r.radius_m }));
  }

  async deletePlace(userId: string, placeId: string): Promise<void> {
    if (!isUuid(userId) || !isUuid(placeId)) return;
    await this.q(`DELETE FROM saved_places WHERE id = $1 AND user_id = $2`, [placeId, userId]);
  }

  async usersNear(area: Area, bufferM: number, now: Date): Promise<UserWithPlaces[]> {
    const freshSince = new Date(now.getTime() - LOCATION_MAX_AGE_MS).toISOString();
    const { rows } = await this.q(`
      WITH ev AS (SELECT public.ST_SetSRID(public.ST_MakePoint($2::float8, $1::float8), 4326)::public.geography AS g),
      hits AS (
        -- Two index lookups (current locations, saved places) instead of one OR that would scan every user.
        SELECT u.id FROM users u, ev
        WHERE u.location_updated_at > $3::timestamptz
          AND public.ST_DWithin(u.geog, ev.g, ($4::float8 + $5::float8) * ${SPHEROID_SLACK} + ${SLACK_M})
        UNION
        SELECT p.user_id FROM saved_places p, ev
        WHERE public.ST_DWithin(p.geog, ev.g, ($4::float8 + ${MAX_PLACE_RADIUS_M}) * ${SPHEROID_SLACK} + ${SLACK_M})
          AND public.ST_Distance(p.geog, ev.g) <= ($4::float8 + p.radius_m) * ${SPHEROID_SLACK} + ${SLACK_M}
      )
      SELECT u.* FROM users u WHERE u.id IN (SELECT id FROM hits)
    `, [area.lat, area.lon, freshSince, area.radiusM, bufferM]);
    if (!rows.length) return [];
    const users = rows.map(rowToUser);
    const placeRows = (await this.q(`SELECT * FROM saved_places WHERE user_id = ANY($1::uuid[]) ORDER BY label, id`, [users.map((u) => u.id)])).rows;
    const byUser = new Map<string, SavedPlace[]>();
    for (const r of placeRows) {
      byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), { id: r.id, userId: r.user_id, label: r.label, lat: r.lat, lon: r.lon, radiusM: r.radius_m }]);
    }
    return users.map((user) => ({ user, places: byUser.get(user.id) ?? [] }));
  }

  async locationCells(stepDeg: number, freshSinceIso: string): Promise<Array<{ lat: number; lon: number }>> {
    const { rows } = await this.q(`
      SELECT DISTINCT floor(lat / $1::float8) AS y, floor(lon / $1::float8) AS x FROM (
        SELECT lat, lon FROM saved_places
        UNION ALL SELECT lat, lon FROM users WHERE lat IS NOT NULL AND location_updated_at >= $2::timestamptz
      ) p`, [stepDeg, freshSinceIso]);
    return rows.map((r) => cellOf(Number(r.y) * stepDeg + stepDeg / 2, Number(r.x) * stepDeg + stepDeg / 2, stepDeg));
  }

  // ── source items ─────────────────────────────────────────────────────────
  async recordSourceItem(item: SourceItem): Promise<boolean> {
    const res = await this.q(
      `INSERT INTO source_items (source, external_id, payload, first_seen_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [item.source, item.externalId, JSON.stringify(item), new Date().toISOString()],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async hasSourceItem(source: string, externalId: string): Promise<boolean> {
    const { rows } = await this.q(`SELECT 1 FROM source_items WHERE source = $1 AND external_id = $2`, [source, externalId]);
    return rows.length > 0;
  }

  async linkSourceItem(item: SourceItem, eventId: string): Promise<void> {
    await this.q(`UPDATE source_items SET event_id = $1 WHERE source = $2 AND external_id = $3`, [eventId, item.source, item.externalId]);
  }

  async eventIdForSourceRefs(source: string, externalIds: string[]): Promise<string | null> {
    if (!externalIds.length) return null;
    const { rows } = await this.q(
      `SELECT event_id FROM source_items WHERE source = $1 AND event_id IS NOT NULL AND external_id = ANY($2::text[])
       ORDER BY first_seen_at DESC LIMIT 1`, [source, externalIds],
    );
    return rows[0]?.event_id ?? null;
  }

  // ── events ───────────────────────────────────────────────────────────────
  async saveEvent(e: RiskEvent): Promise<void> {
    await this.q(`
      INSERT INTO events (id, data, status, category, lat, lon, starts_at, ends_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET data=excluded.data, status=excluded.status, category=excluded.category,
        lat=excluded.lat, lon=excluded.lon, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
        updated_at=excluded.updated_at
    `, [e.id, JSON.stringify(e), e.status, e.category, e.lat, e.lon, e.startsAt, e.endsAt, e.updatedAt]);
  }

  async getEvent(id: string): Promise<RiskEvent | null> {
    const { rows } = await this.q(`SELECT data FROM events WHERE id = $1`, [id]);
    return rows[0]?.data ?? null;
  }

  async activeEvents(now: Date, lookbackHours = 24): Promise<RiskEvent[]> {
    const since = new Date(now.getTime() - lookbackHours * 3600_000).toISOString();
    const sinceWithEnd = new Date(now.getTime() - SCHEDULED_LOOKBACK_H * 3600_000).toISOString();
    const { rows } = await this.q(
      `SELECT data FROM events WHERE status != 'rejected' AND (
         (ends_at IS NULL AND starts_at >= $1) OR (ends_at > $2 AND starts_at >= $3))`,
      [since, now.toISOString(), sinceWithEnd],
    );
    return rows.map((r) => r.data);
  }

  async eventsByStatus(status: EventStatus): Promise<RiskEvent[]> {
    const { rows } = await this.q(`SELECT data FROM events WHERE status = $1 ORDER BY updated_at DESC`, [status]);
    return rows.map((r) => r.data);
  }

  async saveEventEmbedding(eventId: string, model: string, vector: number[]): Promise<void> {
    await this.q(`
      INSERT INTO event_embeddings (event_id, model, embedding, updated_at) VALUES ($1,$2,$3::public.vector,$4)
      ON CONFLICT (event_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding, updated_at = EXCLUDED.updated_at
    `, [eventId, model, toVector(vector), new Date().toISOString()]);
  }

  async eventSimilarities(eventIds: string[], model: string, vector: number[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!eventIds.length || !vector.length) return out;
    const { rows } = await this.q(`
      SELECT event_id, 1 - (embedding OPERATOR(public.<=>) $3::public.vector) AS sim
      FROM event_embeddings
      WHERE event_id = ANY($1::text[]) AND model = $2 AND public.vector_dims(embedding) = $4
    `, [eventIds, model, toVector(vector), vector.length]);
    // A zero vector has no direction: pgvector returns NaN; treat it as unrelated.
    for (const r of rows) out.set(r.event_id, Number.isFinite(Number(r.sim)) ? Number(r.sim) : 0);
    return out;
  }

  // ── alerts ───────────────────────────────────────────────────────────────
  async insertAlert(a: Omit<Alert, 'id' | 'createdAt' | 'feedback'> & { createdAt?: string }): Promise<Alert | null> {
    const alert: Alert = { ...a, id: randomUUID(), createdAt: a.createdAt ?? new Date().toISOString(), feedback: null };
    const res = await this.q(`
      INSERT INTO alerts (id, user_id, event_id, event_revision, data, delivery, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING
    `, [alert.id, a.userId, a.eventId, a.eventRevision, JSON.stringify(alert), a.delivery, alert.createdAt]);
    return (res.rowCount ?? 0) > 0 ? alert : null;
  }

  async hasAlertForEvent(userId: string, eventId: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const { rows } = await this.q(`SELECT 1 FROM alerts WHERE user_id = $1 AND event_id = $2 LIMIT 1`, [userId, eventId]);
    return rows.length > 0;
  }

  async recipients(eventId: string): Promise<Array<{ userId: string; pushed: boolean }>> {
    const { rows } = await this.q(
      `SELECT user_id, bool_or(delivery = 'push') AS pushed FROM alerts
       WHERE event_id = $1 AND delivery != 'suppressed' GROUP BY user_id`, [eventId],
    );
    return rows.map((r) => ({ userId: r.user_id, pushed: !!r.pushed }));
  }

  /** Updates and all-clears (kind != 'new') don't count toward the daily limit (PRD 5.4). */
  async pushCountSince(userId: string, sinceIso: string): Promise<number> {
    if (!isUuid(userId)) return 0;
    const { rows } = await this.q(
      `SELECT COUNT(*) AS n FROM alerts WHERE user_id = $1 AND delivery = 'push' AND created_at >= $2
         AND COALESCE(data->>'kind', 'new') = 'new'`, [userId, sinceIso],
    );
    return Number(rows[0].n);
  }

  async alertsForUser(userId: string, limit = 50): Promise<Alert[]> {
    if (!isUuid(userId)) return [];
    const { rows } = await this.q(
      `SELECT data, feedback FROM alerts WHERE user_id = $1 AND delivery != 'suppressed' ORDER BY created_at DESC, event_revision DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => ({ ...r.data, feedback: r.feedback ?? null }));
  }

  async getAlert(userId: string, alertId: string): Promise<Alert | null> {
    if (!isUuid(userId) || !isUuid(alertId)) return null;
    const { rows } = await this.q(`SELECT data, feedback FROM alerts WHERE id = $1 AND user_id = $2`, [alertId, userId]);
    return rows[0] ? { ...rows[0].data, feedback: rows[0].feedback ?? null } : null;
  }

  async setFeedback(userId: string, alertId: string, feedback: Feedback): Promise<boolean> {
    if (!isUuid(userId) || !isUuid(alertId)) return false;
    const res = await this.q(`UPDATE alerts SET feedback = $1 WHERE id = $2 AND user_id = $3`, [feedback, alertId, userId]);
    return (res.rowCount ?? 0) > 0;
  }

  async feedbackByCategory(userId: string): Promise<Record<string, { relevant: number; notRelevant: number }>> {
    const out: Record<string, { relevant: number; notRelevant: number }> = {};
    if (!isUuid(userId)) return out;
    const { rows } = await this.q(`
      SELECT data->>'category' AS category,
        COUNT(*) FILTER (WHERE feedback = 'relevant') AS relevant,
        COUNT(*) FILTER (WHERE feedback <> 'relevant') AS not_relevant
      FROM alerts WHERE user_id = $1 AND feedback IS NOT NULL GROUP BY 1
    `, [userId]);
    for (const r of rows) out[r.category] = { relevant: Number(r.relevant), notRelevant: Number(r.not_relevant) };
    return out;
  }

  async metrics(sinceIso: string): Promise<Metrics> {
    const { rows } = await this.q(`SELECT data, delivery, feedback FROM alerts WHERE created_at >= $1`, [sinceIso]);
    const pending = await this.q(`SELECT COUNT(*) AS n FROM events WHERE status = 'pending_review'`);
    const m = computeMetrics(
      rows.map((r) => ({ alert: r.data as Alert, delivery: r.delivery, feedback: r.feedback ?? null })),
      sinceIso,
      Number(pending.rows[0].n),
    );
    const d = (await this.q(`
      SELECT COUNT(*) FILTER (WHERE status = 'delivered') AS delivered, COUNT(*) FILTER (WHERE status = 'error') AS failed,
             COUNT(*) FILTER (WHERE status = 'pending') AS pending
      FROM push_tickets WHERE created_at >= $1`, [sinceIso])).rows[0];
    return { ...m, pushDelivery: { delivered: Number(d.delivered), failed: Number(d.failed), pending: Number(d.pending) } };
  }

  // ── accounts ───────────────────────────────────────────────────────────────
  async accountForUser(userId: string): Promise<Account | null> {
    if (!isUuid(userId)) return null;
    const { rows } = await this.q(`SELECT * FROM accounts WHERE user_id = $1`, [userId]);
    return rows[0] ? rowToAccount(rows[0]) : null;
  }

  async accountByEmail(email: string): Promise<Account | null> {
    const { rows } = await this.q(`SELECT * FROM accounts WHERE email = $1`, [email]);
    return rows[0] ? rowToAccount(rows[0]) : null;
  }

  async createAccount(email: string, userId: string): Promise<Account> {
    const a: Account = { id: randomUUID(), email, userId, createdAt: new Date().toISOString() };
    await this.q(`INSERT INTO accounts (id, email, user_id, created_at) VALUES ($1,$2,$3,$4)`, [a.id, email, userId, a.createdAt]);
    return a;
  }

  async accountByIdentity(provider: IdentityProvider, subject: string): Promise<Account | null> {
    const { rows } = await this.q(`SELECT a.* FROM account_identities i JOIN accounts a ON a.id = i.account_id WHERE i.provider = $1 AND i.subject = $2`, [provider, subject]);
    return rows[0] ? rowToAccount(rows[0]) : null;
  }

  async addIdentity(accountId: string, { provider, subject }: AccountIdentity): Promise<void> {
    await this.q(`INSERT INTO account_identities (provider, subject, account_id, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (provider, subject) DO NOTHING`,
      [provider, subject, accountId, new Date().toISOString()]);
  }

  async identities(accountId: string): Promise<AccountIdentity[]> {
    if (!isUuid(accountId)) return [];
    const { rows } = await this.q(`SELECT provider, subject FROM account_identities WHERE account_id = $1 ORDER BY provider, created_at`, [accountId]);
    return rows.map((r: any) => ({ provider: r.provider, subject: r.subject }));
  }

  async moveDevice(token: string, toUserId: string): Promise<void> {
    await this.q(`UPDATE devices SET user_id = $1 WHERE token_hash = $2`, [toUserId, hashToken(token)]);
  }

  async removeDevice(token: string): Promise<void> {
    await this.q(`DELETE FROM devices WHERE token_hash = $1`, [hashToken(token)]);
  }

  async deviceCount(userId: string): Promise<number> {
    if (!isUuid(userId)) return 0;
    return Number((await this.q(`SELECT COUNT(*) AS n FROM devices WHERE user_id = $1`, [userId])).rows[0].n);
  }

  async mergeUserInto(fromUserId: string, toUserId: string): Promise<void> {
    const existing = await this.places(toUserId);
    for (const p of await this.places(fromUserId)) {
      const dup = existing.some((e) => e.label === p.label && Math.abs(e.lat - p.lat) < 1e-4 && Math.abs(e.lon - p.lon) < 1e-4);
      if (!dup && existing.length < 10) { await this.addPlace(toUserId, p.label, p.lat, p.lon, p.radiusM); existing.push(p); }
    }
    await this.q(`UPDATE devices SET user_id = $1 WHERE user_id = $2`, [toUserId, fromUserId]);
    await this.deleteUser(fromUserId);
  }

  async saveEmailCode(c: EmailCode): Promise<void> {
    await this.q(`
      INSERT INTO email_codes (email, code_hash, expires_at, attempts, sends, window_start) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
        attempts = excluded.attempts, sends = excluded.sends, window_start = excluded.window_start`,
      [c.email, c.codeHash, c.expiresAt, c.attempts, c.sends, c.windowStart]);
  }

  async emailCode(email: string): Promise<EmailCode | null> {
    const r = (await this.q(`SELECT * FROM email_codes WHERE email = $1`, [email])).rows[0];
    return r ? { email: r.email, codeHash: r.code_hash, expiresAt: iso(r.expires_at)!, attempts: r.attempts, sends: r.sends, windowStart: iso(r.window_start)! } : null;
  }

  async deleteEmailCode(email: string): Promise<void> {
    await this.q(`DELETE FROM email_codes WHERE email = $1`, [email]);
  }

  // ── delivery queue ───────────────────────────────────────────────────────
  async enqueuePushJobs(jobs: Array<{ token: string; alert: Alert; attempt: number }>, atIso: string): Promise<void> {
    const ok = jobs.filter((j) => isUuid(j.alert.userId));
    // Batches of 1000 rows per statement: 100k jobs are 100 round trips, not 100k.
    for (let i = 0; i < ok.length; i += 1000) {
      const chunk = ok.slice(i, i + 1000);
      await this.q(`
        INSERT INTO push_jobs (id, user_id, token, alert, attempt, created_at)
        SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::jsonb[], $5::int[], $6::timestamptz[])`, [
        chunk.map(() => randomUUID()), chunk.map((j) => j.alert.userId), chunk.map((j) => j.token),
        chunk.map((j) => JSON.stringify(j.alert)), chunk.map((j) => j.attempt), chunk.map(() => atIso),
      ]);
    }
  }

  async claimPushJobs(holder: string, limit: number, nowIso: string, lockUntilIso: string): Promise<PushJob[]> {
    const { rows } = await this.q(`
      UPDATE push_jobs SET locked_by = $1, locked_until = $2::timestamptz
      WHERE id IN (
        SELECT id FROM push_jobs WHERE locked_until IS NULL OR locked_until < $3::timestamptz
        ORDER BY created_at, id LIMIT $4 FOR UPDATE SKIP LOCKED
      )
      RETURNING id, token, alert, attempt, created_at`, [holder, lockUntilIso, nowIso, limit]);
    return rows.map((r) => ({ id: r.id, token: r.token, alert: r.alert, attempt: r.attempt, createdAt: iso(r.created_at)! }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async completePushJobs(ids: string[]): Promise<void> {
    if (ids.length) await this.q(`DELETE FROM push_jobs WHERE id = ANY($1::uuid[])`, [ids]);
  }

  async pushQueueDepth(): Promise<number> {
    return Number((await this.q(`SELECT COUNT(*)::int AS n FROM push_jobs`)).rows[0].n);
  }

  // ── source health ────────────────────────────────────────────────────────
  async saveSourceStatuses(statuses: Record<string, SourceStatus>): Promise<void> {
    const entries = Object.entries(statuses);
    if (!entries.length) return;
    await this.q(`
      INSERT INTO source_status (key, data, updated_at)
      SELECT k, d, now() FROM unnest($1::text[], $2::jsonb[]) AS t(k, d)
      ON CONFLICT (key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      [entries.map(([k]) => k), entries.map(([, v]) => JSON.stringify({ ...v, running: false }))]);
  }

  async sourceStatuses(): Promise<Record<string, SourceStatus>> {
    const { rows } = await this.q(`SELECT key, data FROM source_status`);
    return Object.fromEntries(rows.map((r) => [r.key, r.data]));
  }

  // ── AI spend ─────────────────────────────────────────────────────────────
  async recordDecision(d: Decision): Promise<void> {
    await this.q(`INSERT INTO decisions (id, at, kind, event_id, data) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (id) DO NOTHING`,
      [d.id, d.at, d.kind, d.eventId, JSON.stringify(d)]);
  }

  async decisions(q: DecisionQuery): Promise<Decision[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.eventId) { args.push(q.eventId); where.push(`event_id = $${args.length}`); }
    if (q.kind) { args.push(q.kind); where.push(`kind = $${args.length}`); }
    if (q.since) { args.push(new Date(q.since).toISOString()); where.push(`at >= $${args.length}::timestamptz`); }
    const { rows } = await this.q(`SELECT data FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, seq DESC LIMIT ${decisionLimit(q)}`, args);
    return rows.map((r) => r.data);
  }

  async addLlmUsage(day: string, u: { calls: number; inputTokens: number; outputTokens: number; eur: number; skipped: number }): Promise<void> {
    await this.q(`
      INSERT INTO llm_usage (day, calls, input_tokens, output_tokens, eur, skipped) VALUES ($1::date,$2,$3,$4,$5,$6)
      ON CONFLICT (day) DO UPDATE SET calls = llm_usage.calls + excluded.calls, input_tokens = llm_usage.input_tokens + excluded.input_tokens,
        output_tokens = llm_usage.output_tokens + excluded.output_tokens, eur = llm_usage.eur + excluded.eur, skipped = llm_usage.skipped + excluded.skipped`,
      [day, u.calls, u.inputTokens, u.outputTokens, u.eur, u.skipped]);
  }

  async llmUsage(fromDay: string): Promise<LlmUsageDay[]> {
    const { rows } = await this.q(`SELECT to_char(day, 'YYYY-MM-DD') AS day, calls, input_tokens, output_tokens, eur, skipped FROM llm_usage WHERE day >= $1::date ORDER BY day`, [fromDay]);
    return rows.map((r) => ({ day: r.day, calls: r.calls, inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), eur: r.eur, skipped: r.skipped }));
  }

  // ── leases ───────────────────────────────────────────────────────────────
  async acquireLease(name: string, holder: string, ttlMs: number, now = new Date()): Promise<boolean> {
    // One statement: the row lock makes concurrent takeovers safe; RETURNING tells us if we won.
    const { rows } = await this.q(`
      INSERT INTO leases (name, holder, expires_at) VALUES ($1, $2, $3::timestamptz)
      ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
      WHERE leases.holder = excluded.holder OR leases.expires_at < $4::timestamptz
      RETURNING holder`, [name, holder, new Date(now.getTime() + ttlMs).toISOString(), now.toISOString()]);
    return rows[0]?.holder === holder;
  }

  async releaseLease(name: string, holder: string): Promise<void> {
    await this.q(`DELETE FROM leases WHERE name = $1 AND holder = $2`, [name, holder]);
  }

  async claimDigest(userId: string, day: string, atIso: string): Promise<boolean> {
    const { rows } = await this.q(
      `INSERT INTO digests (user_id, day, sent_at) VALUES ($1, $2::date, $3::timestamptz) ON CONFLICT DO NOTHING RETURNING day`,
      [userId, day, atIso]);
    return rows.length === 1;
  }

  // ── push delivery ────────────────────────────────────────────────────────
  async recordPushTickets(tickets: PushTicket[], attempt: number, atIso: string): Promise<void> {
    const ok = tickets.filter((t) => isUuid(t.userId) && isUuid(t.alertId));
    for (let i = 0; i < ok.length; i += 1000) {
      const c = ok.slice(i, i + 1000);
      await this.q(
        `INSERT INTO push_tickets (id, ticket_id, alert_id, user_id, token, status, error, attempt, created_at)
         SELECT id, ticket_id, alert_id, user_id, token, status, error, $8, $9::timestamptz
         FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::text[])
           AS t(id, ticket_id, alert_id, user_id, token, status, error)
         ON CONFLICT DO NOTHING`,
        [c.map(() => randomUUID()), c.map((t) => t.ticketId), c.map((t) => t.alertId), c.map((t) => t.userId),
          c.map((t) => t.token), c.map((t) => t.status), c.map((t) => t.error), attempt, atIso],
      );
    }
  }

  async pushTicketsToCheck(sentBeforeIso: string, limit: number): Promise<StoredPushTicket[]> {
    const { rows } = await this.q(
      `SELECT * FROM push_tickets WHERE status = 'pending' AND ticket_id IS NOT NULL AND created_at <= $1 ORDER BY created_at LIMIT $2`,
      [sentBeforeIso, limit],
    );
    return rows.map((r) => ({ ticketId: r.ticket_id, alertId: r.alert_id, userId: r.user_id, token: r.token, attempt: r.attempt, createdAt: iso(r.created_at)! }));
  }

  async setPushStatus(ticketId: string, status: PushStatus, error: string | null = null): Promise<void> {
    await this.q(`UPDATE push_tickets SET status = $1, error = $2, checked_at = now() WHERE ticket_id = $3`, [status, error, ticketId]);
  }

  async clearPushToken(token: string): Promise<number> {
    return (await this.q(`UPDATE users SET push_token = NULL WHERE push_token = $1`, [token])).rowCount ?? 0;
  }

  async close(): Promise<void> {
    if (this.opts.schema && this.opts.dropSchemaOnClose) {
      await this.q(`DROP SCHEMA ${this.opts.schema} CASCADE`).catch(() => {});
    }
    await this.pool.end();
  }

  private async tx(fn: (c: pg.PoolClient) => Promise<void>) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await fn(c);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids from URLs aren't validated upstream; a non-uuid can't match a row, and Postgres would reject the cast. */
function isUuid(s: string) { return UUID.test(s); }

function iso(v: Date | string | null): string | null {
  return v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function rowToAccount(r: any): Account {
  return { id: r.id, email: r.email, userId: r.user_id, createdAt: iso(r.created_at)! };
}

function rowToUser(r: any): User {
  return {
    id: r.id, tokenHash: r.token_hash, pushToken: r.push_token ?? null,
    prefs: normalizePrefs(r.prefs), lat: r.lat ?? null, lon: r.lon ?? null,
    locationUpdatedAt: iso(r.location_updated_at), createdAt: iso(r.created_at)!,
  };
}

/** pgvector's text input format. */
function toVector(v: number[]): string {
  if (!v.every((x) => Number.isFinite(x))) throw new Error('embedding contains a non-finite value');
  return `[${v.join(',')}]`;
}
