import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import type {
  Alert, Delivery, EventStatus, Feedback, RiskEvent, SavedPlace, SourceItem, User, UserPrefs,
} from './types.js';
import { DEFAULT_PREFS } from './types.js';

/**
 * SQLite storage for the MVP (built into Node 22). The query surface is small and
 * isolated here so it can move to Postgres + PostGIS without touching the pipeline.
 * Location: only the latest point per user is stored — no location history.
 */
export class Store {
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
      PRAGMA foreign_keys = ON;
    `);
  }

  // ── users ────────────────────────────────────────────────────────────────
  createUser(pushToken: string | null, prefs?: Partial<UserPrefs>): { user: User; token: string } {
    const token = randomBytes(24).toString('base64url');
    const user: User = {
      id: randomUUID(), tokenHash: hashToken(token), pushToken,
      prefs: { ...DEFAULT_PREFS, ...prefs }, lat: null, lon: null,
      locationUpdatedAt: null, createdAt: new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO users (id, token_hash, push_token, prefs, created_at) VALUES (?,?,?,?,?)`)
      .run(user.id, user.tokenHash, pushToken, JSON.stringify(user.prefs), user.createdAt);
    return { user, token };
  }

  userByToken(token: string): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE token_hash = ?`).get(hashToken(token));
    return row ? rowToUser(row) : null;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
    return row ? rowToUser(row) : null;
  }

  allUsers(): User[] {
    return this.db.prepare(`SELECT * FROM users`).all().map(rowToUser);
  }

  updatePrefs(userId: string, prefs: UserPrefs) {
    this.db.prepare(`UPDATE users SET prefs = ? WHERE id = ?`).run(JSON.stringify(prefs), userId);
  }

  updatePushToken(userId: string, pushToken: string | null) {
    this.db.prepare(`UPDATE users SET push_token = ? WHERE id = ?`).run(pushToken, userId);
  }

  updateLocation(userId: string, lat: number, lon: number) {
    this.db.prepare(`UPDATE users SET lat = ?, lon = ?, location_updated_at = ? WHERE id = ?`)
      .run(lat, lon, new Date().toISOString(), userId);
  }

  /** GDPR erasure: user, places and alerts (cascade). */
  deleteUser(userId: string) {
    this.db.prepare(`DELETE FROM alerts WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM saved_places WHERE user_id = ?`).run(userId);
    this.db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
  }

  // ── saved places ─────────────────────────────────────────────────────────
  addPlace(userId: string, label: string, lat: number, lon: number, radiusM: number): SavedPlace {
    const place: SavedPlace = { id: randomUUID(), userId, label, lat, lon, radiusM };
    this.db.prepare(`INSERT INTO saved_places VALUES (?,?,?,?,?,?)`).run(place.id, userId, label, lat, lon, radiusM);
    return place;
  }

  places(userId: string): SavedPlace[] {
    return this.db.prepare(`SELECT * FROM saved_places WHERE user_id = ?`).all(userId).map((r: any) => ({
      id: r.id, userId: r.user_id, label: r.label, lat: r.lat, lon: r.lon, radiusM: r.radius_m,
    }));
  }

  deletePlace(userId: string, placeId: string) {
    this.db.prepare(`DELETE FROM saved_places WHERE id = ? AND user_id = ?`).run(placeId, userId);
  }

  // ── source items ─────────────────────────────────────────────────────────
  /** Returns true if the item is new (not seen before). */
  recordSourceItem(item: SourceItem): boolean {
    const res = this.db.prepare(
      `INSERT OR IGNORE INTO source_items (source, external_id, payload, first_seen_at) VALUES (?,?,?,?)`,
    ).run(item.source, item.externalId, JSON.stringify(item), new Date().toISOString());
    return Number(res.changes) > 0;
  }

  linkSourceItem(item: SourceItem, eventId: string) {
    this.db.prepare(`UPDATE source_items SET event_id = ? WHERE source = ? AND external_id = ?`)
      .run(eventId, item.source, item.externalId);
  }

  // ── events ───────────────────────────────────────────────────────────────
  saveEvent(e: RiskEvent) {
    this.db.prepare(`
      INSERT INTO events (id, data, status, category, lat, lon, starts_at, ends_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, status=excluded.status, category=excluded.category,
        lat=excluded.lat, lon=excluded.lon, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
        updated_at=excluded.updated_at
    `).run(e.id, JSON.stringify(e), e.status, e.category, e.lat, e.lon, e.startsAt, e.endsAt, e.updatedAt);
  }

  getEvent(id: string): RiskEvent | null {
    const row: any = this.db.prepare(`SELECT data FROM events WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data) : null;
  }

  /** Events that are not over yet (no end, or end in the future) and started within the lookback. */
  activeEvents(now: Date, lookbackHours = 24): RiskEvent[] {
    const since = new Date(now.getTime() - lookbackHours * 3600_000).toISOString();
    return this.db.prepare(
      `SELECT data FROM events WHERE status != 'rejected' AND starts_at >= ? AND (ends_at IS NULL OR ends_at > ?)`,
    ).all(since, now.toISOString()).map((r: any) => JSON.parse(r.data));
  }

  eventsByStatus(status: EventStatus): RiskEvent[] {
    return this.db.prepare(`SELECT data FROM events WHERE status = ? ORDER BY updated_at DESC`)
      .all(status).map((r: any) => JSON.parse(r.data));
  }

  // ── alerts ───────────────────────────────────────────────────────────────
  /** Returns null if this user already has an alert for this event revision. */
  insertAlert(a: Omit<Alert, 'id' | 'createdAt' | 'feedback'>): Alert | null {
    const alert: Alert = { ...a, id: randomUUID(), createdAt: new Date().toISOString(), feedback: null };
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO alerts (id, user_id, event_id, event_revision, data, delivery, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(alert.id, a.userId, a.eventId, a.eventRevision, JSON.stringify(alert), a.delivery, alert.createdAt);
    return Number(res.changes) > 0 ? alert : null;
  }

  hasAlertForEvent(userId: string, eventId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM alerts WHERE user_id = ? AND event_id = ? LIMIT 1`).get(userId, eventId);
  }

  pushCountSince(userId: string, sinceIso: string): number {
    const row: any = this.db.prepare(
      `SELECT COUNT(*) AS n FROM alerts WHERE user_id = ? AND delivery = 'push' AND created_at >= ?`,
    ).get(userId, sinceIso);
    return Number(row.n);
  }

  alertsForUser(userId: string, limit = 50): Alert[] {
    return this.db.prepare(
      `SELECT data, feedback FROM alerts WHERE user_id = ? AND delivery != 'suppressed' ORDER BY created_at DESC LIMIT ?`,
    ).all(userId, limit).map((r: any) => ({ ...JSON.parse(r.data), feedback: r.feedback ?? null }));
  }

  getAlert(userId: string, alertId: string): Alert | null {
    const r: any = this.db.prepare(`SELECT data, feedback FROM alerts WHERE id = ? AND user_id = ?`).get(alertId, userId);
    return r ? { ...JSON.parse(r.data), feedback: r.feedback ?? null } : null;
  }

  setFeedback(userId: string, alertId: string, feedback: Feedback): boolean {
    const res = this.db.prepare(`UPDATE alerts SET feedback = ? WHERE id = ? AND user_id = ?`).run(feedback, alertId, userId);
    return Number(res.changes) > 0;
  }

  /** Per-category relevance history for one user — input to ranking. */
  feedbackByCategory(userId: string): Record<string, { relevant: number; notRelevant: number }> {
    const out: Record<string, { relevant: number; notRelevant: number }> = {};
    for (const r of this.db.prepare(`SELECT data, feedback FROM alerts WHERE user_id = ? AND feedback IS NOT NULL`).all(userId) as any[]) {
      const cat = JSON.parse(r.data).category as string;
      out[cat] ??= { relevant: 0, notRelevant: 0 };
      if (r.feedback === 'relevant') out[cat].relevant++; else out[cat].notRelevant++;
    }
    return out;
  }

  /** KPIs from PRD Section 13: relevance, beyond-NINA, alerts per user per day. */
  metrics(sinceIso: string) {
    const rows = this.db.prepare(`SELECT data, delivery, feedback FROM alerts WHERE created_at >= ?`).all(sinceIso) as any[];
    const users = new Set<string>();
    let pushed = 0, rated = 0, relevant = 0, relevantNonOfficial = 0;
    for (const r of rows) {
      const a = JSON.parse(r.data) as Alert;
      users.add(a.userId);
      if (r.delivery === 'push') pushed++;
      if (r.feedback) {
        rated++;
        if (r.feedback === 'relevant') { relevant++; if (!a.official) relevantNonOfficial++; }
      }
    }
    const days = Math.max(1, (Date.now() - Date.parse(sinceIso)) / 86_400_000);
    return {
      alerts: rows.length,
      pushed,
      rated,
      relevantRate: rated ? relevant / rated : null,
      /** Share of relevant alerts that did not come from official warning apps (target ≥ 60%). */
      beyondNinaRate: relevant ? relevantNonOfficial / relevant : null,
      pushesPerUserPerDay: users.size ? pushed / users.size / days : 0,
      pendingReview: this.eventsByStatus('pending_review').length,
    };
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function rowToUser(r: any): User {
  return {
    id: r.id, tokenHash: r.token_hash, pushToken: r.push_token ?? null,
    prefs: { ...DEFAULT_PREFS, ...JSON.parse(r.prefs) }, lat: r.lat ?? null, lon: r.lon ?? null,
    locationUpdatedAt: r.location_updated_at ?? null, createdAt: r.created_at,
  };
}

export type { Delivery };
