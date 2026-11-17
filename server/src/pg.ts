import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import type {
  Alert, EventStatus, Feedback, RiskEvent, SavedPlace, SourceItem, User, UserPrefs,
} from './types.js';
import { DEFAULT_PREFS } from './types.js';
import { hashToken } from './db.js';
import { computeMetrics, type Metrics, type Store } from './store.js';

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
];

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
      ...(opts.schema ? { options: `-c search_path=${opts.schema},public` } : {}),
    });
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
      // One migrator at a time, even with several server instances starting together.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`heyokay_migrations:${this.opts.schema ?? ''}`]);
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
    await this.q(`INSERT INTO users (id, token_hash, push_token, prefs, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [user.id, user.tokenHash, pushToken, JSON.stringify(user.prefs), user.createdAt]);
    return { user, token };
  }

  async userByToken(token: string): Promise<User | null> {
    const { rows } = await this.q(`SELECT * FROM users WHERE token_hash = $1`, [hashToken(token)]);
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
    await this.q(`UPDATE users SET prefs = $1 WHERE id = $2`, [JSON.stringify(prefs), userId]);
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
    const { rows } = await this.q(
      `SELECT data FROM events WHERE status != 'rejected' AND starts_at >= $1 AND (ends_at IS NULL OR ends_at > $2)`,
      [since, now.toISOString()],
    );
    return rows.map((r) => r.data);
  }

  async eventsByStatus(status: EventStatus): Promise<RiskEvent[]> {
    const { rows } = await this.q(`SELECT data FROM events WHERE status = $1 ORDER BY updated_at DESC`, [status]);
    return rows.map((r) => r.data);
  }

  // ── alerts ───────────────────────────────────────────────────────────────
  async insertAlert(a: Omit<Alert, 'id' | 'createdAt' | 'feedback'>): Promise<Alert | null> {
    const alert: Alert = { ...a, id: randomUUID(), createdAt: new Date().toISOString(), feedback: null };
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

  async pushCountSince(userId: string, sinceIso: string): Promise<number> {
    if (!isUuid(userId)) return 0;
    const { rows } = await this.q(
      `SELECT COUNT(*) AS n FROM alerts WHERE user_id = $1 AND delivery = 'push' AND created_at >= $2`, [userId, sinceIso],
    );
    return Number(rows[0].n);
  }

  async alertsForUser(userId: string, limit = 50): Promise<Alert[]> {
    if (!isUuid(userId)) return [];
    const { rows } = await this.q(
      `SELECT data, feedback FROM alerts WHERE user_id = $1 AND delivery != 'suppressed' ORDER BY created_at DESC LIMIT $2`,
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
    return computeMetrics(
      rows.map((r) => ({ alert: r.data as Alert, delivery: r.delivery, feedback: r.feedback ?? null })),
      sinceIso,
      Number(pending.rows[0].n),
    );
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

function rowToUser(r: any): User {
  return {
    id: r.id, tokenHash: r.token_hash, pushToken: r.push_token ?? null,
    prefs: { ...DEFAULT_PREFS, ...r.prefs }, lat: r.lat ?? null, lon: r.lon ?? null,
    locationUpdatedAt: iso(r.location_updated_at), createdAt: iso(r.created_at)!,
  };
}
