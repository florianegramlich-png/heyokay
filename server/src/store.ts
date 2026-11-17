import type {
  Alert, EventStatus, Feedback, RiskEvent, SavedPlace, SourceItem, User, UserPrefs,
} from './types.js';

export interface Metrics {
  alerts: number;
  pushed: number;
  rated: number;
  relevantRate: number | null;
  /** Share of relevant alerts that did not come from official warning apps (target ≥ 60%). */
  beyondNinaRate: number | null;
  pushesPerUserPerDay: number;
  pendingReview: number;
}

/**
 * Storage used by the pipeline and the API. Every method is async so the same code runs on
 * SQLite (tests, demo) and Postgres (production). Location privacy: only the latest point per
 * user is stored, never a history.
 */
export interface Store {
  // users
  createUser(pushToken: string | null, prefs?: Partial<UserPrefs>): Promise<{ user: User; token: string }>;
  userByToken(token: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  allUsers(): Promise<User[]>;
  updatePrefs(userId: string, prefs: UserPrefs): Promise<void>;
  updatePushToken(userId: string, pushToken: string | null): Promise<void>;
  updateLocation(userId: string, lat: number, lon: number): Promise<void>;
  /** GDPR erasure: user, saved places and alerts. */
  deleteUser(userId: string): Promise<void>;

  // saved places
  addPlace(userId: string, label: string, lat: number, lon: number, radiusM: number): Promise<SavedPlace>;
  places(userId: string): Promise<SavedPlace[]>;
  deletePlace(userId: string, placeId: string): Promise<void>;

  // source items
  /** Returns true if the item is new (not seen before). */
  recordSourceItem(item: SourceItem): Promise<boolean>;
  hasSourceItem(source: string, externalId: string): Promise<boolean>;
  linkSourceItem(item: SourceItem, eventId: string): Promise<void>;

  // events
  saveEvent(e: RiskEvent): Promise<void>;
  getEvent(id: string): Promise<RiskEvent | null>;
  /** Events that are not over yet (no end, or end in the future) and started within the lookback. */
  activeEvents(now: Date, lookbackHours?: number): Promise<RiskEvent[]>;
  eventsByStatus(status: EventStatus): Promise<RiskEvent[]>;

  // alerts
  /** Returns null if this user already has an alert for this event revision. */
  insertAlert(a: Omit<Alert, 'id' | 'createdAt' | 'feedback'>): Promise<Alert | null>;
  hasAlertForEvent(userId: string, eventId: string): Promise<boolean>;
  pushCountSince(userId: string, sinceIso: string): Promise<number>;
  alertsForUser(userId: string, limit?: number): Promise<Alert[]>;
  getAlert(userId: string, alertId: string): Promise<Alert | null>;
  setFeedback(userId: string, alertId: string, feedback: Feedback): Promise<boolean>;
  /** Per-category relevance history for one user — input to ranking. */
  feedbackByCategory(userId: string): Promise<Record<string, { relevant: number; notRelevant: number }>>;
  /** KPIs from PRD Section 13: relevance, beyond-NINA, alerts per user per day. */
  metrics(sinceIso: string): Promise<Metrics>;

  close(): Promise<void>;
}

/** Shared by both implementations so the numbers can't drift apart. */
export function computeMetrics(
  rows: Array<{ alert: Alert; delivery: string; feedback: string | null }>,
  sinceIso: string,
  pendingReview: number,
  now = Date.now(),
): Metrics {
  const users = new Set<string>();
  let pushed = 0, rated = 0, relevant = 0, relevantNonOfficial = 0;
  for (const r of rows) {
    users.add(r.alert.userId);
    if (r.delivery === 'push') pushed++;
    if (r.feedback) {
      rated++;
      if (r.feedback === 'relevant') { relevant++; if (!r.alert.official) relevantNonOfficial++; }
    }
  }
  const days = Math.max(1, (now - Date.parse(sinceIso)) / 86_400_000);
  return {
    alerts: rows.length,
    pushed,
    rated,
    relevantRate: rated ? relevant / rated : null,
    beyondNinaRate: relevant ? relevantNonOfficial / relevant : null,
    pushesPerUserPerDay: users.size ? pushed / users.size / days : 0,
    pendingReview,
  };
}
