import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import type {
  Alert, EventStatus, Feedback, RiskEvent, SavedPlace, SourceItem, User, UserPrefs,
} from './types.js';
import { DEFAULT_PREFS } from './types.js';
import { SCHEDULED_LOOKBACK_H, cellOf, computeMetrics, type Area, type Metrics, type Account, type EmailCode, type PushStatus, type Store, type StoredPushTicket, type UserWithPlaces } from './store.js';
import type { PushTicket } from './push.js';
import { distanceM, LOCATION_MAX_AGE_MS } from './geo.js';
import { cosine } from './embeddings.js';

export type { Store } from './store.js';

/**
 * SQLite storage (built into Node 22) for tests, the demo and small single-node setups.
 * Location: only the latest point per user is stored — no location history.
 */
export class SqliteStore implements Store {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, push_token TEXT,
        prefs TEXT NOT NULL, lat REAL, lon REAL, location_updated_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS saved_places (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, radius_m REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_items (
        source TEXT NOT NULL, external_id TEXT NOT NULL, payload TEXT NOT NULL,
        event_id TEXT, first_seen_at TEXT NOT NULL,
        PRIMARY KEY (source, external_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL,
        category TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
        starts_at TEXT NOT NULL, ends_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_status ON events(status);
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL, event_revision INTEGER NOT NULL, data TEXT NOT NULL,
        delivery TEXT NOT NULL, feedback TEXT, created_at TEXT NOT NULL,
        UNIQUE (user_id, event_id, event_revision)
      );
      CREATE INDEX IF NOT EXISTS alerts_user ON alerts(user_id, created_at);
      CREATE TABLE IF NOT EXISTS event_embeddings (
        event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        model TEXT NOT NULL, vector TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_tickets (
        id TEXT PRIMARY KEY, ticket_id TEXT UNIQUE, alert_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, attempt INTEGER NOT NULL, created_at TEXT NOT NULL, checked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS push_tickets_pending ON push_tickets(status, created_at);
      CREATE TABLE IF NOT EXISTS devices (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_codes (
        email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL, sends INTEGER NOT NULL, window_start TEXT NOT NULL
      );
      -- Users from before devices existed sign in with their original token.
      INSERT OR IGNORE INTO devices (token_hash, user_id, created_at) SELECT token_hash, id, created_at FROM users;
      PRAGMA foreign_keys = ON;
    `);
  }

  // ── users ────────────────────────────────────────────────────────────────
  async createUser(pushToken: string | null, prefs?: Partial<UserPrefs>): Promise<{ user: User; token: string }> {
    const token = randomBytes(24).toString('base64url');
    const user: User = {
      id: randomUUID(), tokenHash: hashToken(token), pushToken,
      prefs: { ...DEFAULT_PREFS, ...prefs }, lat: null, lon: null,
      locationUpdatedAt: null, createdAt: new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO users (id, token_hash, push_token, prefs, created_at) VALUES (?,?,?,?,?)`)
      .run(user.id, user.tokenHash, pushToken, JSON.stringify(user.prefs), user.createdAt);
    this.db.prepare(`INSERT INTO devices (token_hash, user_id, created_at) VALUES (?,?,?)`).run(user.tokenHash, user.id, user.createdAt);
    return { user, token };
  }

  async userByToken(token: string): Promise<User | null> {
    const row = this.db.prepare(`SELECT u.* FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`).get(hashToken(token));
    return row ? rowToUser(row) : null;
  }

  async getUser(id: string): Promise<User | null> {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
    return row ? rowToUser(row) : null;
  }

  async allUsers(): Promise<User[]> {
    return this.db.prepare(`SELECT * FROM users`).all().map(rowToUser);
  }

  async updatePrefs(userId: string, prefs: UserPrefs): Promise<void> {
    this.db.prepare(`UPDATE users SET prefs = ? WHERE id = ?`).run(JSON.stringify(prefs), userId);
  }

  async updatePushToken(userId: string, pushToken: string | null): Promise<void> {
    this.db.prepare(`UPDATE users SET push_token = ? WHERE id = ?`).run(pushToken, userId);
  }

  async updateLocation(userId: string, lat: number, lon: number): Promise<void> {
    this.db.prepare(`UPDATE users SET lat = ?, lon = ?, location_updated_at = ? WHERE id = ?`)
      .run(lat, lon, new Date().toISOString(), userId);
  }

  /** GDPR erasure: user, places and alerts (cascade). */
  async deleteUser(userId: string): Promise<void> {
    this.db.prepare(`DELETE FROM push_tickets WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM accounts WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM devices WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM alerts WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM saved_places WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
  }

  // ── saved places ─────────────────────────────────────────────────────────
  async addPlace(userId: string, label: string, lat: number, lon: number, radiusM: number): Promise<SavedPlace> {
    const place: SavedPlace = { id: randomUUID(), userId, label, lat, lon, radiusM };
    this.db.prepare(`INSERT INTO saved_places VALUES (?,?,?,?,?,?)`).run(place.id, userId, label, lat, lon, radiusM);
    return place;
  }

  async places(userId: string): Promise<SavedPlace[]> {
    return this.db.prepare(`SELECT * FROM saved_places WHERE user_id = ?`).all(userId).map((r: any) => ({
      id: r.id, userId: r.user_id, label: r.label, lat: r.lat, lon: r.lon, radiusM: r.radius_m,
    }));
  }

  async deletePlace(userId: string, placeId: string): Promise<void> {
    this.db.prepare(`DELETE FROM saved_places WHERE id = ? AND user_id = ?`).run(placeId, userId);
  }

  /**
   * Same rule as PgStore.usersNear, evaluated in JS (SQLite has no spatial index here), with the
   * same 1 % + 10 m slack: `match` measures exact warning outlines with a flat approximation, so
   * the circle search stays a safe superset and `match` makes the final call.
   */
  async usersNear(area: Area, bufferM: number, now: Date): Promise<UserWithPlaces[]> {
    const placesByUser = new Map<string, SavedPlace[]>();
    for (const r of this.db.prepare(`SELECT * FROM saved_places ORDER BY label, id`).all() as any[]) {
      const p: SavedPlace = { id: r.id, userId: r.user_id, label: r.label, lat: r.lat, lon: r.lon, radiusM: r.radius_m };
      placesByUser.set(p.userId, [...(placesByUser.get(p.userId) ?? []), p]);
    }
    const out: UserWithPlaces[] = [];
    for (const user of this.db.prepare(`SELECT * FROM users`).all().map(rowToUser)) {
      const places = placesByUser.get(user.id) ?? [];
      const here = user.lat != null && user.lon != null && user.locationUpdatedAt != null &&
        now.getTime() - Date.parse(user.locationUpdatedAt) < LOCATION_MAX_AGE_MS &&
        distanceM(user.lat, user.lon, area.lat, area.lon) <= (area.radiusM + bufferM) * 1.01 + 10;
      const atPlace = places.some((p) => distanceM(p.lat, p.lon, area.lat, area.lon) <= (area.radiusM + p.radiusM) * 1.01 + 10);
      if (here || atPlace) out.push({ user, places });
    }
    return out;
  }

  async locationCells(stepDeg: number, freshSinceIso: string): Promise<Array<{ lat: number; lon: number }>> {
    const pts = [
      ...(this.db.prepare(`SELECT lat, lon FROM saved_places`).all() as any[]),
      ...(this.db.prepare(`SELECT lat, lon FROM users WHERE lat IS NOT NULL AND location_updated_at >= ?`).all(freshSinceIso) as any[]),
    ];
    const cells = new Map<string, { lat: number; lon: number }>();
    for (const p of pts) { const c = cellOf(p.lat, p.lon, stepDeg); cells.set(`${c.lat},${c.lon}`, c); }
    return [...cells.values()];
  }

  // ── source items ─────────────────────────────────────────────────────────
  /** Returns true if the item is new (not seen before). */
  async recordSourceItem(item: SourceItem): Promise<boolean> {
    const res = this.db.prepare(
      `INSERT OR IGNORE INTO source_items (source, external_id, payload, first_seen_at) VALUES (?,?,?,?)`,
    ).run(item.source, item.externalId, JSON.stringify(item), new Date().toISOString());
    return Number(res.changes) > 0;
  }

  async hasSourceItem(source: string, externalId: string): Promise<boolean> {
    return !!this.db.prepare(`SELECT 1 FROM source_items WHERE source = ? AND external_id = ?`).get(source, externalId);
  }

  async linkSourceItem(item: SourceItem, eventId: string): Promise<void> {
    this.db.prepare(`UPDATE source_items SET event_id = ? WHERE source = ? AND external_id = ?`)
      .run(eventId, item.source, item.externalId);
  }

  // ── events ───────────────────────────────────────────────────────────────
  async saveEvent(e: RiskEvent): Promise<void> {
    this.db.prepare(`
      INSERT INTO events (id, data, status, category, lat, lon, starts_at, ends_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, status=excluded.status, category=excluded.category,
        lat=excluded.lat, lon=excluded.lon, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
        updated_at=excluded.updated_at
    `).run(e.id, JSON.stringify(e), e.status, e.category, e.lat, e.lon, iso(e.startsAt), e.endsAt ? iso(e.endsAt) : null, iso(e.updatedAt));
  }

  async getEvent(id: string): Promise<RiskEvent | null> {
    const row: any = this.db.prepare(`SELECT data FROM events WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data) : null;
  }

  /** Events that are not over yet (no end, or end in the future) and started within the lookback. */
  async activeEvents(now: Date, lookbackHours = 24): Promise<RiskEvent[]> {
    const since = new Date(now.getTime() - lookbackHours * 3600_000).toISOString();
    const sinceWithEnd = new Date(now.getTime() - SCHEDULED_LOOKBACK_H * 3600_000).toISOString();
    return this.db.prepare(
      `SELECT data FROM events WHERE status != 'rejected' AND (
         (ends_at IS NULL AND starts_at >= ?) OR (ends_at > ? AND starts_at >= ?))`,
    ).all(since, now.toISOString(), sinceWithEnd).map((r: any) => JSON.parse(r.data));
  }

  async eventsByStatus(status: EventStatus): Promise<RiskEvent[]> {
    return this.db.prepare(`SELECT data FROM events WHERE status = ? ORDER BY updated_at DESC`)
      .all(status).map((r: any) => JSON.parse(r.data));
  }

  async saveEventEmbedding(eventId: string, model: string, vector: number[]): Promise<void> {
    this.db.prepare(`
      INSERT INTO event_embeddings (event_id, model, vector, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(event_id) DO UPDATE SET model=excluded.model, vector=excluded.vector, updated_at=excluded.updated_at
    `).run(eventId, model, JSON.stringify(vector), new Date().toISOString());
  }

  /** Cosine in JS; SQLite only holds the few active events of a test or demo. */
  async eventSimilarities(eventIds: string[], model: string, vector: number[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!eventIds.length) return out;
    const rows = this.db.prepare(
      `SELECT event_id, vector FROM event_embeddings WHERE model = ? AND event_id IN (${eventIds.map(() => '?').join(',')})`,
    ).all(model, ...eventIds) as any[];
    for (const r of rows) {
      const v = JSON.parse(r.vector) as number[];
      if (v.length === vector.length) out.set(r.event_id, cosine(v, vector));
    }
    return out;
  }

  // ── alerts ───────────────────────────────────────────────────────────────
  /** Returns null if this user already has an alert for this event revision. */
  async insertAlert(a: Omit<Alert, 'id' | 'createdAt' | 'feedback'>): Promise<Alert | null> {
    const alert: Alert = { ...a, id: randomUUID(), createdAt: new Date().toISOString(), feedback: null };
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO alerts (id, user_id, event_id, event_revision, data, delivery, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(alert.id, a.userId, a.eventId, a.eventRevision, JSON.stringify(alert), a.delivery, alert.createdAt);
    return Number(res.changes) > 0 ? alert : null;
  }

  /** Everyone who was told about this event (feed or push), and whether any of it reached them as a push. */
  async recipients(eventId: string): Promise<Array<{ userId: string; pushed: boolean }>> {
    return (this.db.prepare(
      `SELECT user_id, MAX(delivery = 'push') AS pushed FROM alerts
       WHERE event_id = ? AND delivery != 'suppressed' GROUP BY user_id`,
    ).all(eventId) as any[]).map((r) => ({ userId: r.user_id, pushed: !!r.pushed }));
  }

  /** The event an earlier source message belongs to (any age), for updates that reference it. */
  async eventIdForSourceRefs(source: string, externalIds: string[]): Promise<string | null> {
    if (!externalIds.length) return null;
    const row: any = this.db.prepare(
      `SELECT event_id FROM source_items WHERE source = ? AND event_id IS NOT NULL
         AND external_id IN (${externalIds.map(() => '?').join(',')}) ORDER BY first_seen_at DESC LIMIT 1`,
    ).get(source, ...externalIds);
    return row?.event_id ?? null;
  }

  async hasAlertForEvent(userId: string, eventId: string): Promise<boolean> {
    return !!this.db.prepare(`SELECT 1 FROM alerts WHERE user_id = ? AND event_id = ? LIMIT 1`).get(userId, eventId);
  }

  /** Pushes that count toward the daily limit: updates and all-clears don't (PRD 5.4). */
  async pushCountSince(userId: string, sinceIso: string): Promise<number> {
    const row: any = this.db.prepare(
      `SELECT COUNT(*) AS n FROM alerts WHERE user_id = ? AND delivery = 'push' AND created_at >= ?
         AND COALESCE(json_extract(data, '$.kind'), 'new') = 'new'`,
    ).get(userId, sinceIso);
    return Number(row.n);
  }

  async alertsForUser(userId: string, limit = 50): Promise<Alert[]> {
    return this.db.prepare(
      `SELECT data, feedback FROM alerts WHERE user_id = ? AND delivery != 'suppressed' ORDER BY created_at DESC LIMIT ?`,
    ).all(userId, limit).map((r: any) => ({ ...JSON.parse(r.data), feedback: r.feedback ?? null }));
  }

  async getAlert(userId: string, alertId: string): Promise<Alert | null> {
    const r: any = this.db.prepare(`SELECT data, feedback FROM alerts WHERE id = ? AND user_id = ?`).get(alertId, userId);
    return r ? { ...JSON.parse(r.data), feedback: r.feedback ?? null } : null;
  }

  async setFeedback(userId: string, alertId: string, feedback: Feedback): Promise<boolean> {
    const res = this.db.prepare(`UPDATE alerts SET feedback = ? WHERE id = ? AND user_id = ?`).run(feedback, alertId, userId);
    return Number(res.changes) > 0;
  }

  /** Per-category relevance history for one user — input to ranking. */
  async feedbackByCategory(userId: string): Promise<Record<string, { relevant: number; notRelevant: number }>> {
    const out: Record<string, { relevant: number; notRelevant: number }> = {};
    for (const r of this.db.prepare(`SELECT data, feedback FROM alerts WHERE user_id = ? AND feedback IS NOT NULL`).all(userId) as any[]) {
      const cat = JSON.parse(r.data).category as string;
      out[cat] ??= { relevant: 0, notRelevant: 0 };
      if (r.feedback === 'relevant') out[cat].relevant++; else out[cat].notRelevant++;
    }
    return out;
  }

  /** KPIs from PRD Section 13: relevance, beyond-NINA, alerts per user per day. */
  async metrics(sinceIso: string): Promise<Metrics> {
    const rows = (this.db.prepare(`SELECT data, delivery, feedback FROM alerts WHERE created_at >= ?`).all(sinceIso) as any[])
      .map((r) => ({ alert: JSON.parse(r.data) as Alert, delivery: r.delivery as string, feedback: (r.feedback ?? null) as string | null }));
    const m = computeMetrics(rows, sinceIso, (await this.eventsByStatus('pending_review')).length);
    const d = this.db.prepare(`
      SELECT SUM(status = 'delivered') AS delivered, SUM(status = 'error') AS failed, SUM(status = 'pending') AS pending
      FROM push_tickets WHERE created_at >= ?`).get(sinceIso) as any;
    return { ...m, pushDelivery: { delivered: Number(d?.delivered ?? 0), failed: Number(d?.failed ?? 0), pending: Number(d?.pending ?? 0) } };
  }

  // ── accounts ───────────────────────────────────────────────────────────────
  async accountForUser(userId: string): Promise<Account | null> {
    const r: any = this.db.prepare(`SELECT * FROM accounts WHERE user_id = ?`).get(userId);
    return r ? rowToAccount(r) : null;
  }

  async accountByEmail(email: string): Promise<Account | null> {
    const r: any = this.db.prepare(`SELECT * FROM accounts WHERE email = ?`).get(email);
    return r ? rowToAccount(r) : null;
  }

  async createAccount(email: string, userId: string): Promise<Account> {
    const a: Account = { id: randomUUID(), email, userId, createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO accounts (id, email, user_id, created_at) VALUES (?,?,?,?)`).run(a.id, email, userId, a.createdAt);
    return a;
  }

  async moveDevice(token: string, toUserId: string): Promise<void> {
    this.db.prepare(`UPDATE devices SET user_id = ? WHERE token_hash = ?`).run(toUserId, hashToken(token));
  }

  async removeDevice(token: string): Promise<void> {
    this.db.prepare(`DELETE FROM devices WHERE token_hash = ?`).run(hashToken(token));
  }

  async deviceCount(userId: string): Promise<number> {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE user_id = ?`).get(userId) as any).n);
  }

  async mergeUserInto(fromUserId: string, toUserId: string): Promise<void> {
    const existing = await this.places(toUserId);
    for (const p of await this.places(fromUserId)) {
      const dup = existing.some((e) => e.label === p.label && Math.abs(e.lat - p.lat) < 1e-4 && Math.abs(e.lon - p.lon) < 1e-4);
      if (!dup && existing.length < 10) { await this.addPlace(toUserId, p.label, p.lat, p.lon, p.radiusM); existing.push(p); }
    }
    this.db.prepare(`UPDATE devices SET user_id = ? WHERE user_id = ?`).run(toUserId, fromUserId);
    await this.deleteUser(fromUserId);
  }

  async saveEmailCode(c: EmailCode): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO email_codes (email, code_hash, expires_at, attempts, sends, window_start) VALUES (?,?,?,?,?,?)`)
      .run(c.email, c.codeHash, c.expiresAt, c.attempts, c.sends, c.windowStart);
  }

  async emailCode(email: string): Promise<EmailCode | null> {
    const r: any = this.db.prepare(`SELECT * FROM email_codes WHERE email = ?`).get(email);
    return r ? { email: r.email, codeHash: r.code_hash, expiresAt: r.expires_at, attempts: r.attempts, sends: r.sends, windowStart: r.window_start } : null;
  }

  async deleteEmailCode(email: string): Promise<void> {
    this.db.prepare(`DELETE FROM email_codes WHERE email = ?`).run(email);
  }

  // ── push delivery ────────────────────────────────────────────────────────
  async recordPushTickets(tickets: PushTicket[], attempt: number, atIso: string): Promise<void> {
    const now = atIso;
    const ins = this.db.prepare(`INSERT OR IGNORE INTO push_tickets (id, ticket_id, alert_id, user_id, token, status, error, attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const t of tickets) ins.run(randomUUID(), t.ticketId, t.alertId, t.userId, t.token, t.status, t.error, attempt, now);
  }

  async pushTicketsToCheck(sentBeforeIso: string, limit: number): Promise<StoredPushTicket[]> {
    return (this.db.prepare(
      `SELECT * FROM push_tickets WHERE status = 'pending' AND ticket_id IS NOT NULL AND created_at <= ? ORDER BY created_at LIMIT ?`,
    ).all(sentBeforeIso, limit) as any[]).map((r) => ({
      ticketId: r.ticket_id, alertId: r.alert_id, userId: r.user_id, token: r.token, attempt: r.attempt, createdAt: r.created_at,
    }));
  }

  async setPushStatus(ticketId: string, status: PushStatus, error: string | null = null): Promise<void> {
    this.db.prepare(`UPDATE push_tickets SET status = ?, error = ?, checked_at = ? WHERE ticket_id = ?`)
      .run(status, error, new Date().toISOString(), ticketId);
  }

  async clearPushToken(token: string): Promise<number> {
    return Number(this.db.prepare(`UPDATE users SET push_token = NULL WHERE push_token = ?`).run(token).changes);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Times are compared as text in SQLite, so they're stored as UTC ISO strings ("+01:00" offsets would sort wrongly). */
function iso(t: string): string {
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? t : new Date(ms).toISOString();
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function rowToAccount(r: any): Account {
  return { id: r.id, email: r.email, userId: r.user_id, createdAt: r.created_at };
}

function rowToUser(r: any): User {
  return {
    id: r.id, tokenHash: r.token_hash, pushToken: r.push_token ?? null,
    prefs: { ...DEFAULT_PREFS, ...JSON.parse(r.prefs) }, lat: r.lat ?? null, lon: r.lon ?? null,
    locationUpdatedAt: r.location_updated_at ?? null, createdAt: r.created_at,
  };
}

