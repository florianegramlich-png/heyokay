import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import type {
  Decision, Reviewer,
  Alert, Category, EventStatus, Feedback, RiskEvent, SavedPlace, SourceItem, User, UserPrefs,
} from './types.js';
import { DEFAULT_PREFS, normalizePrefs, savedPrefs } from './types.js';
import { SCHEDULED_LOOKBACK_H, cellOf, computeMetrics, type Area, type Metrics, type Account, type AccountIdentity, type IdentityProvider, type EmailCode, type PushStatus, type Store, type StoredPushTicket, type UserWithPlaces, type PushJob, type LlmUsageDay, type DecisionQuery, type KpiInputs, type FamilyMember, type FamilyInvite, type Checkin, type CheckinAnswer, decisionLimit } from './store.js';
import type { PushTicket } from './push.js';
import type { AppEvent, AppEventCount, Platform } from './app-events.js';
import type { SourceStatus } from './ingest.js';
import { distanceM, LOCATION_MAX_AGE_MS } from './geo.js';
import { RETENTION, daysBefore, type RetentionReport } from './retention.js';
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
      CREATE TABLE IF NOT EXISTS account_identities (
        provider TEXT NOT NULL, subject TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
        PRIMARY KEY (provider, subject)
      );
      CREATE TABLE IF NOT EXISTS email_codes (
        email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL, sends INTEGER NOT NULL, window_start TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_jobs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL, alert TEXT NOT NULL, attempt INTEGER NOT NULL, created_at TEXT NOT NULL,
        locked_by TEXT, locked_until TEXT
      );
      CREATE INDEX IF NOT EXISTS push_jobs_order ON push_jobs(created_at);
      CREATE TABLE IF NOT EXISTS source_status (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS llm_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, eur REAL NOT NULL, skipped INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS digests (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, sent_at TEXT NOT NULL,
        PRIMARY KEY (user_id, day)
      );
      CREATE TABLE IF NOT EXISTS reviewers (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reviewer_sessions (token_hash TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_events (day TEXT NOT NULL, platform TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, platform, name));
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, event_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS decisions_at ON decisions(at);
      CREATE INDEX IF NOT EXISTS decisions_event ON decisions(event_id, at);
      CREATE TABLE IF NOT EXISTS family_members (
        id TEXT PRIMARY KEY, family_id TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, joined_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS family_members_family ON family_members(family_id);
      CREATE TABLE IF NOT EXISTS family_invites (code_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkins (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, event_id TEXT NOT NULL, alert_id TEXT NOT NULL,
        asked_at TEXT NOT NULL, reminded_at TEXT, answer TEXT, answered_at TEXT, UNIQUE (user_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS checkins_due ON checkins(asked_at) WHERE answer IS NULL AND reminded_at IS NULL;
      -- Users from before devices existed sign in with their original token.
      INSERT OR IGNORE INTO devices (token_hash, user_id, created_at) SELECT token_hash, id, created_at FROM users;
      PRAGMA foreign_keys = ON;
    `);
    // Columns added after launch (SQLite has no migrations here): add if missing.
    for (const sql of [`ALTER TABLE users ADD COLUMN last_seen_at TEXT`, `ALTER TABLE alerts ADD COLUMN opened_at TEXT`, `ALTER TABLE saved_places ADD COLUMN shared INTEGER NOT NULL DEFAULT 0`]) {
      try { this.db.exec(sql); } catch (e) { if (!/duplicate column/i.test((e as Error).message)) throw e; }
    }
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
    this.db.prepare(`UPDATE users SET prefs = ? WHERE id = ?`).run(JSON.stringify(savedPrefs(prefs)), userId);
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
    this.db.prepare(`DELETE FROM account_identities WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ?)`).run(userId);
    this.db.prepare(`DELETE FROM accounts WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM devices WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM alerts WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM saved_places WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM family_members WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM checkins WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
  }

  // ── saved places ─────────────────────────────────────────────────────────
  async addPlace(userId: string, label: string, lat: number, lon: number, radiusM: number): Promise<SavedPlace> {
    const place: SavedPlace = { id: randomUUID(), userId, label, lat, lon, radiusM, shared: false };
    this.db.prepare(`INSERT INTO saved_places (id, user_id, label, lat, lon, radius_m) VALUES (?,?,?,?,?,?)`).run(place.id, userId, label, lat, lon, radiusM);
    return place;
  }

  async places(userId: string): Promise<SavedPlace[]> {
    return this.db.prepare(`SELECT * FROM saved_places WHERE user_id = ?`).all(userId).map(rowToPlace);
  }

  async deletePlace(userId: string, placeId: string): Promise<void> {
    this.db.prepare(`DELETE FROM saved_places WHERE id = ? AND user_id = ?`).run(placeId, userId);
  }

  async setPlaceShared(userId: string, placeId: string, shared: boolean): Promise<SavedPlace | null> {
    const r: any = this.db.prepare(`UPDATE saved_places SET shared = ? WHERE id = ? AND user_id = ? RETURNING *`).get(shared ? 1 : 0, placeId, userId);
    return r ? rowToPlace(r) : null;
  }

  async unshareAllPlaces(userId: string): Promise<void> {
    this.db.prepare(`UPDATE saved_places SET shared = 0 WHERE user_id = ?`).run(userId);
  }

  async familyPlaces(userId: string): Promise<SavedPlace[]> {
    return (this.db.prepare(`
      SELECT p.*, owner.name AS shared_by FROM family_members me
      JOIN family_members owner ON owner.family_id = me.family_id AND owner.user_id <> me.user_id
      JOIN saved_places p ON p.user_id = owner.user_id AND p.shared = 1
      WHERE me.user_id = ? ORDER BY p.label, p.id`).all(userId) as any[]).map(rowToPlace);
  }

  /**
   * Same rule as PgStore.usersNear, evaluated in JS (SQLite has no spatial index here), with the
   * same 1 % + 10 m slack: `match` measures exact warning outlines with a flat approximation, so
   * the circle search stays a safe superset and `match` makes the final call.
   */
  async usersNear(area: Area, bufferM: number, now: Date): Promise<UserWithPlaces[]> {
    const placesByUser = new Map<string, SavedPlace[]>();
    const add = (userId: string, p: SavedPlace) => placesByUser.set(userId, [...(placesByUser.get(userId) ?? []), p]);
    for (const r of this.db.prepare(`SELECT * FROM saved_places ORDER BY label, id`).all() as any[]) add(r.user_id, rowToPlace(r));
    // Shared places reach the other members of the owner's family, labelled with the owner's family name.
    for (const r of this.db.prepare(`
      SELECT p.*, owner.name AS shared_by, me.user_id AS recipient FROM saved_places p
      JOIN family_members owner ON owner.user_id = p.user_id
      JOIN family_members me ON me.family_id = owner.family_id AND me.user_id <> owner.user_id
      WHERE p.shared = 1 ORDER BY p.label, p.id`).all() as any[]) add(r.recipient, rowToPlace(r));
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

  async eventsStartedBetween(category: Category, fromIso: string, toIso: string): Promise<RiskEvent[]> {
    return this.db.prepare(`SELECT data FROM events WHERE category = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at, id`)
      .all(category, new Date(fromIso).toISOString(), new Date(toIso).toISOString()).map((r: any) => JSON.parse(r.data));
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
  async insertAlert(a: Omit<Alert, 'id' | 'createdAt' | 'feedback'> & { createdAt?: string }): Promise<Alert | null> {
    const alert: Alert = { ...a, id: randomUUID(), createdAt: a.createdAt ?? new Date().toISOString(), feedback: null };
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
      `SELECT data, feedback FROM alerts WHERE user_id = ? AND delivery != 'suppressed' ORDER BY created_at DESC, event_revision DESC, rowid DESC LIMIT ?`,
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

  async accountByIdentity(provider: IdentityProvider, subject: string): Promise<Account | null> {
    const r: any = this.db.prepare(`SELECT a.* FROM account_identities i JOIN accounts a ON a.id = i.account_id WHERE i.provider = ? AND i.subject = ?`).get(provider, subject);
    return r ? rowToAccount(r) : null;
  }

  async addIdentity(accountId: string, { provider, subject }: AccountIdentity): Promise<void> {
    this.db.prepare(`INSERT INTO account_identities (provider, subject, account_id, created_at) VALUES (?,?,?,?) ON CONFLICT (provider, subject) DO NOTHING`)
      .run(provider, subject, accountId, new Date().toISOString());
  }

  async identities(accountId: string): Promise<AccountIdentity[]> {
    return (this.db.prepare(`SELECT provider, subject FROM account_identities WHERE account_id = ? ORDER BY provider, created_at`).all(accountId) as any[])
      .map((r) => ({ provider: r.provider, subject: r.subject }));
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
    this.db.prepare(`UPDATE family_members SET user_id = ? WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM family_members WHERE user_id = ?)`).run(toUserId, fromUserId, toUserId);
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

  // ── delivery queue ───────────────────────────────────────────────────────
  async enqueuePushJobs(jobs: Array<{ token: string; alert: Alert; attempt: number }>, atIso: string): Promise<void> {
    const ins = this.db.prepare(`INSERT INTO push_jobs (id, user_id, token, alert, attempt, created_at) VALUES (?,?,?,?,?,?)`);
    this.db.exec('BEGIN');
    try {
      for (const j of jobs) ins.run(randomUUID(), j.alert.userId, j.token, JSON.stringify(j.alert), j.attempt, atIso);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  async claimPushJobs(holder: string, limit: number, nowIso: string, lockUntilIso: string): Promise<PushJob[]> {
    // One process per SQLite file, and this runs synchronously: no other claim can interleave.
    const rows = this.db.prepare(`
      UPDATE push_jobs SET locked_by = ?, locked_until = ?
      WHERE id IN (SELECT id FROM push_jobs WHERE locked_until IS NULL OR locked_until < ? ORDER BY created_at, id LIMIT ?)
      RETURNING id, token, alert, attempt, created_at`).all(holder, lockUntilIso, nowIso, limit) as any[];
    return rows.map((r) => ({ id: r.id, token: r.token, alert: JSON.parse(r.alert), attempt: r.attempt, createdAt: r.created_at }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async completePushJobs(ids: string[]): Promise<void> {
    const del = this.db.prepare(`DELETE FROM push_jobs WHERE id = ?`);
    for (const id of ids) del.run(id);
  }

  async pushQueueDepth(): Promise<number> {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM push_jobs`).get() as any).n);
  }

  // ── source health ────────────────────────────────────────────────────────
  async saveSourceStatuses(statuses: Record<string, SourceStatus>): Promise<void> {
    const up = this.db.prepare(`INSERT INTO source_status (key, data, updated_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`);
    const now = new Date().toISOString();
    for (const [k, v] of Object.entries(statuses)) up.run(k, JSON.stringify({ ...v, running: false }), now);
  }

  async sourceStatuses(): Promise<Record<string, SourceStatus>> {
    return Object.fromEntries((this.db.prepare(`SELECT key, data FROM source_status`).all() as any[]).map((r) => [r.key, JSON.parse(r.data)]));
  }

  // ── AI spend ─────────────────────────────────────────────────────────────
  async addLlmUsage(day: string, u: { calls: number; inputTokens: number; outputTokens: number; eur: number; skipped: number }): Promise<void> {
    this.db.prepare(`
      INSERT INTO llm_usage (day, calls, input_tokens, output_tokens, eur, skipped) VALUES (?,?,?,?,?,?)
      ON CONFLICT (day) DO UPDATE SET calls = calls + excluded.calls, input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens, eur = eur + excluded.eur, skipped = skipped + excluded.skipped`)
      .run(day, u.calls, u.inputTokens, u.outputTokens, u.eur, u.skipped);
  }

  async llmUsage(fromDay: string): Promise<LlmUsageDay[]> {
    return (this.db.prepare(`SELECT * FROM llm_usage WHERE day >= ? ORDER BY day`).all(fromDay) as any[])
      .map((r) => ({ day: r.day, calls: r.calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens, eur: r.eur, skipped: r.skipped }));
  }

  // ── family sharing ───────────────────────────────────────────────────────
  async familyMemberByUser(userId: string): Promise<FamilyMember | null> {
    const r: any = this.db.prepare(`SELECT * FROM family_members WHERE user_id = ?`).get(userId);
    return r ? rowToFamilyMember(r) : null;
  }

  async familyMembers(familyId: string): Promise<FamilyMember[]> {
    return (this.db.prepare(`SELECT * FROM family_members WHERE family_id = ? ORDER BY joined_at, id`).all(familyId) as any[]).map(rowToFamilyMember);
  }

  async addFamilyMember(m: FamilyMember, max: number): Promise<'added' | 'already_in_family' | 'family_full'> {
    // node:sqlite is synchronous, so the check and the insert can't interleave with another join.
    if (this.db.prepare(`SELECT 1 FROM family_members WHERE user_id = ?`).get(m.userId)) return 'already_in_family';
    const n = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM family_members WHERE family_id = ?`).get(m.familyId) as any).n);
    if (n >= max) return 'family_full';
    this.db.prepare(`INSERT INTO family_members (id, family_id, user_id, name, joined_at) VALUES (?,?,?,?,?)`)
      .run(m.id, m.familyId, m.userId, m.name, m.joinedAt);
    return 'added';
  }

  async removeFamilyMember(familyId: string, memberId: string): Promise<boolean> {
    return Number(this.db.prepare(`DELETE FROM family_members WHERE family_id = ? AND id = ?`).run(familyId, memberId).changes) === 1;
  }

  async setFamilyInvite(invite: FamilyInvite): Promise<void> {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM family_invites WHERE family_id = ?`).run(invite.familyId);
      this.db.prepare(`INSERT OR REPLACE INTO family_invites (code_hash, family_id, expires_at) VALUES (?,?,?)`).run(invite.codeHash, invite.familyId, invite.expiresAt);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  async takeFamilyInvite(codeHash: string, nowIso: string): Promise<string | null> {
    const r: any = this.db.prepare(`DELETE FROM family_invites WHERE code_hash = ? AND expires_at > ? RETURNING family_id`).get(codeHash, nowIso);
    return r ? r.family_id : null;
  }

  async deleteFamilyInvites(familyId: string): Promise<void> {
    this.db.prepare(`DELETE FROM family_invites WHERE family_id = ?`).run(familyId);
  }

  // ── "Hey, okay?" check-ins ───────────────────────────────────────────────
  async createCheckin(c: Checkin): Promise<boolean> {
    return Number(this.db.prepare(`INSERT OR IGNORE INTO checkins (id, user_id, event_id, alert_id, asked_at, reminded_at, answer, answered_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(c.id, c.userId, c.eventId, c.alertId, c.askedAt, c.remindedAt, c.answer, c.answeredAt).changes) === 1;
  }

  async checkinsForUser(userId: string, sinceIso: string): Promise<Checkin[]> {
    return (this.db.prepare(`SELECT * FROM checkins WHERE user_id = ? AND asked_at >= ? ORDER BY asked_at DESC, id`).all(userId, sinceIso) as any[]).map(rowToCheckin);
  }

  async answerCheckin(userId: string, id: string, answer: CheckinAnswer, atIso: string, openSinceIso: string): Promise<Checkin | null> {
    const r: any = this.db.prepare(`UPDATE checkins SET answer = ?, answered_at = ? WHERE id = ? AND user_id = ? AND asked_at >= ? RETURNING *`)
      .get(answer, atIso, id, userId, openSinceIso);
    return r ? rowToCheckin(r) : null;
  }

  async dueCheckinReminders(askedAfterIso: string, askedBeforeIso: string, limit: number): Promise<Checkin[]> {
    return (this.db.prepare(`SELECT * FROM checkins WHERE answer IS NULL AND reminded_at IS NULL AND asked_at >= ? AND asked_at <= ? ORDER BY asked_at, id LIMIT ?`)
      .all(askedAfterIso, askedBeforeIso, limit) as any[]).map(rowToCheckin);
  }

  async markCheckinReminded(id: string, atIso: string): Promise<boolean> {
    return Number(this.db.prepare(`UPDATE checkins SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL`).run(atIso, id).changes) === 1;
  }

  async checkinAnswers(userIds: string[], sinceIso: string): Promise<Checkin[]> {
    if (!userIds.length) return [];
    return (this.db.prepare(`SELECT * FROM checkins WHERE answer IS NOT NULL AND answered_at >= ? AND user_id IN (${userIds.map(() => '?').join(',')}) ORDER BY answered_at DESC, id`)
      .all(sinceIso, ...userIds) as any[]).map(rowToCheckin);
  }

  // ── data retention ───────────────────────────────────────────────────────
  async purgeExpired(nowIso: string): Promise<RetentionReport> {
    const R = RETENTION;
    const before = (d: number) => daysBefore(nowIso, d);
    const run = (sql: string, ...args: (string | number)[]) => Number(this.db.prepare(sql).run(...args).changes);
    this.db.exec('BEGIN');
    try {
      const out: RetentionReport = {
        alerts: run(`DELETE FROM alerts WHERE created_at < ?`, before(R.alertsDays)),
        pushTickets: run(`DELETE FROM push_tickets WHERE created_at < ?`, before(R.pushTicketsDays)),
        locationsCleared: run(`UPDATE users SET lat = NULL, lon = NULL, location_updated_at = NULL WHERE location_updated_at IS NOT NULL AND location_updated_at < ?`, before(R.locationDays)),
        // Not while its event is running: updates and cancellations find the event through it.
        sourceItems: run(`DELETE FROM source_items WHERE first_seen_at < ? AND (event_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM events e WHERE e.id = source_items.event_id AND e.status != 'rejected' AND (e.ends_at IS NULL OR e.ends_at > ?)))`, before(R.sourceItemsDays), nowIso),
        events: run(`DELETE FROM events WHERE COALESCE(ends_at, starts_at) < ?`, before(R.eventsDays)),
        pushJobs: run(`DELETE FROM push_jobs WHERE created_at < ?`, before(R.pushJobsDays)),
        digests: run(`DELETE FROM digests WHERE day < ?`, before(R.digestsDays).slice(0, 10)),
        emailCodes: run(`DELETE FROM email_codes WHERE expires_at < ?`, before(R.emailCodesDays)),
        reviewerSessions: run(`DELETE FROM reviewer_sessions WHERE expires_at <= ?`, nowIso),
        familyInvites: run(`DELETE FROM family_invites WHERE expires_at <= ?`, nowIso),
        checkins: run(`DELETE FROM checkins WHERE asked_at < ?`, before(R.checkinsDays)),
      };
      // Source items of deleted events go too (their event is gone).
      out.sourceItems += run(`DELETE FROM source_items WHERE event_id IS NOT NULL AND first_seen_at < ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = source_items.event_id)`, before(R.sourceItemsDays));
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── product KPIs ─────────────────────────────────────────────────────────
  async markSeen(userId: string, nowIso: string): Promise<void> {
    const hourAgo = new Date(Date.parse(nowIso) - 3600_000).toISOString();
    this.db.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`).run(nowIso, userId, hourAgo);
  }

  async markAlertOpened(userId: string, alertId: string, nowIso: string): Promise<void> {
    this.db.prepare(`UPDATE alerts SET opened_at = ? WHERE id = ? AND user_id = ? AND opened_at IS NULL`).run(nowIso, alertId, userId);
  }

  async kpiInputs(sinceIso: string): Promise<KpiInputs> {
    const alerts = (this.db.prepare(`
      SELECT a.event_id, a.user_id, a.data, a.delivery, a.feedback, a.created_at, a.opened_at, e.starts_at
      FROM alerts a LEFT JOIN events e ON e.id = a.event_id WHERE a.created_at >= ?`).all(sinceIso) as any[]).map((r) => {
      const d = JSON.parse(r.data) as Alert;
      return { eventId: r.event_id, userId: r.user_id, kind: d.kind ?? 'new', delivery: r.delivery, feedback: r.feedback ?? null, official: !!d.official, createdAt: r.created_at, openedAt: r.opened_at ?? null, eventStartsAt: r.starts_at ?? null };
    });
    const users = (this.db.prepare(`SELECT created_at, last_seen_at, push_token IS NOT NULL AS has_push FROM users`).all() as any[])
      .map((r) => ({ createdAt: r.created_at, lastSeenAt: r.last_seen_at ?? null, hasPush: !!r.has_push }));
    return { alerts, users };
  }

  // ── reviewers ────────────────────────────────────────────────────────────
  async createReviewer(r: Reviewer): Promise<void> {
    this.db.prepare(`INSERT INTO reviewers (id, email, name, password_hash, created_at, disabled) VALUES (?,?,?,?,?,?)`)
      .run(r.id, r.email, r.name, r.passwordHash, r.createdAt, r.disabled ? 1 : 0);
  }

  async reviewerByEmail(email: string): Promise<Reviewer | null> {
    const r = this.db.prepare(`SELECT * FROM reviewers WHERE email = ?`).get(email);
    return r ? reviewerRow(r) : null;
  }

  async reviewers(): Promise<Reviewer[]> {
    return (this.db.prepare(`SELECT * FROM reviewers ORDER BY created_at, email`).all() as any[]).map(reviewerRow);
  }

  async updateReviewer(id: string, patch: Partial<Pick<Reviewer, 'name' | 'passwordHash' | 'disabled'>>): Promise<boolean> {
    const r: any = this.db.prepare(`SELECT * FROM reviewers WHERE id = ?`).get(id);
    if (!r) return false;
    this.db.prepare(`UPDATE reviewers SET name = ?, password_hash = ?, disabled = ? WHERE id = ?`)
      .run(patch.name ?? r.name, patch.passwordHash ?? r.password_hash, (patch.disabled ?? !!r.disabled) ? 1 : 0, id);
    return true;
  }

  async createReviewerSession(tokenHash: string, reviewerId: string, expiresAt: string): Promise<void> {
    this.db.prepare(`INSERT INTO reviewer_sessions (token_hash, reviewer_id, expires_at) VALUES (?,?,?)`).run(tokenHash, reviewerId, expiresAt);
  }

  async reviewerBySession(tokenHash: string, nowIso: string): Promise<Reviewer | null> {
    const r = this.db.prepare(`SELECT r.* FROM reviewer_sessions s JOIN reviewers r ON r.id = s.reviewer_id WHERE s.token_hash = ? AND s.expires_at > ? AND r.disabled = 0`).get(tokenHash, nowIso);
    return r ? reviewerRow(r) : null;
  }

  async deleteReviewerSession(tokenHash: string): Promise<void> {
    this.db.prepare(`DELETE FROM reviewer_sessions WHERE token_hash = ?`).run(tokenHash);
  }

  async deleteReviewerSessionsFor(reviewerId: string): Promise<void> {
    this.db.prepare(`DELETE FROM reviewer_sessions WHERE reviewer_id = ?`).run(reviewerId);
  }

  // ── anonymous app events ─────────────────────────────────────────────────
  async addAppEvents(day: string, platform: Platform, counts: Map<AppEvent, number>): Promise<void> {
    const st = this.db.prepare(`INSERT INTO app_events (day, platform, name, count) VALUES (?,?,?,?) ON CONFLICT (day, platform, name) DO UPDATE SET count = count + excluded.count`);
    for (const [name, n] of counts) st.run(day, platform, name, n);
  }

  async appEventCounts(sinceDay: string): Promise<AppEventCount[]> {
    return (this.db.prepare(`SELECT day, platform, name, count FROM app_events WHERE day >= ? ORDER BY day, platform, name`).all(sinceDay) as any[])
      .map((r) => ({ day: r.day, platform: r.platform, name: r.name, count: Number(r.count) }));
  }

  // ── decision log ─────────────────────────────────────────────────────────
  async recordDecision(d: Decision): Promise<void> {
    this.db.prepare(`INSERT INTO decisions (id, at, kind, event_id, data) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING`)
      .run(d.id, d.at, d.kind, d.eventId, JSON.stringify(d));
  }

  async decisions(q: DecisionQuery): Promise<Decision[]> {
    const where: string[] = [];
    const args: string[] = [];
    if (q.eventId) { where.push('event_id = ?'); args.push(q.eventId); }
    if (q.kind) { where.push('kind = ?'); args.push(q.kind); }
    if (q.since) { where.push('at >= ?'); args.push(new Date(q.since).toISOString()); }
    return (this.db.prepare(`SELECT data FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ${decisionLimit(q)}`)
      .all(...args) as any[]).map((r) => JSON.parse(r.data));
  }

  // ── leases ───────────────────────────────────────────────────────────────
  async acquireLease(name: string, holder: string, ttlMs: number, now = new Date()): Promise<boolean> {
    const until = new Date(now.getTime() + ttlMs).toISOString();
    this.db.prepare(`
      INSERT INTO leases (name, holder, expires_at) VALUES (?,?,?)
      ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
      WHERE leases.holder = excluded.holder OR leases.expires_at < ?`).run(name, holder, until, now.toISOString());
    const r: any = this.db.prepare(`SELECT holder FROM leases WHERE name = ?`).get(name);
    return r?.holder === holder;
  }

  async releaseLease(name: string, holder: string): Promise<void> {
    this.db.prepare(`DELETE FROM leases WHERE name = ? AND holder = ?`).run(name, holder);
  }

  async claimDigest(userId: string, day: string, atIso: string): Promise<boolean> {
    const r = this.db.prepare(`INSERT OR IGNORE INTO digests (user_id, day, sent_at) VALUES (?,?,?)`).run(userId, day, atIso);
    return Number(r.changes) === 1;
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

function reviewerRow(r: any): Reviewer {
  return { id: r.id, email: r.email, name: r.name, passwordHash: r.password_hash, createdAt: r.created_at, disabled: !!r.disabled };
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
    prefs: normalizePrefs(JSON.parse(r.prefs)), lat: r.lat ?? null, lon: r.lon ?? null,
    locationUpdatedAt: r.location_updated_at ?? null, createdAt: r.created_at,
  };
}

function rowToCheckin(r: any): Checkin {
  return {
    id: r.id, userId: r.user_id, eventId: r.event_id, alertId: r.alert_id, askedAt: r.asked_at,
    remindedAt: r.reminded_at ?? null, answer: r.answer ?? null, answeredAt: r.answered_at ?? null,
  };
}

function rowToFamilyMember(r: any): FamilyMember {
  return { id: r.id, familyId: r.family_id, userId: r.user_id, name: r.name, joinedAt: r.joined_at };
}

function rowToPlace(r: any): SavedPlace {
  return {
    id: r.id, userId: r.user_id, label: r.label, lat: r.lat, lon: r.lon, radiusM: r.radius_m, shared: !!r.shared,
    ...(r.shared_by != null ? { sharedBy: r.shared_by } : {}),
  };
}
