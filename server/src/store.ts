import type { PushTicket } from './push.js';
import type {
  Alert, EventStatus, Feedback, RiskEvent, SavedPlace, SourceItem, User, UserPrefs,
} from './types.js';

/** How far back an event with a known, future end time still counts as active. */
export const SCHEDULED_LOOKBACK_H = 24 * 14;

export interface Area { lat: number; lon: number; radiusM: number }
export interface UserWithPlaces { user: User; places: SavedPlace[] }

/** A push ticket as stored: status of one push to one device. */
export interface StoredPushTicket {
  ticketId: string;
  alertId: string;
  userId: string;
  token: string;
  /** 0 for the first send, 1+ for resends after a transient error. */
  attempt: number;
  createdAt: string;
}

/** pending = accepted by Expo, receipt not checked yet; retried = resent after a transient error. */
export type PushStatus = 'pending' | 'delivered' | 'error' | 'retried' | 'unknown';

export interface Account { id: string; email: string; userId: string; createdAt: string }

export interface EmailCode { email: string; codeHash: string; expiresAt: string; attempts: number; sends: number; windowStart: string }

export interface Metrics {
  alerts: number;
  pushed: number;
  rated: number;
  relevantRate: number | null;
  /** Share of relevant alerts that did not come from official warning apps (target ≥ 60%). */
  beyondNinaRate: number | null;
  pushesPerUserPerDay: number;
  pendingReview: number;
  /** Push receipts in the period: delivered to Apple/Google, failed, or not checked yet. */
  pushDelivery?: { delivered: number; failed: number; pending: number };
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
  /**
   * Users who may be inside an area: their current location (if updated within
   * LOCATION_MAX_AGE_MS of `now`) is within radius + bufferM, or one of their saved places
   * overlaps it (radius + place radius). Each comes with all of their saved places.
   * A superset is allowed (the pipeline's `match` makes the final call); missing a user is not.
   */
  usersNear(area: Area, bufferM: number, now: Date): Promise<UserWithPlaces[]>;
  /**
   * Grid cells (centre of a `stepDeg` square) that contain a saved place or a current location
   * (updated since `freshSinceIso`). Used to ask weather services about areas, never about a person's
   * exact place: many people share one cell.
   */
  locationCells(stepDeg: number, freshSinceIso: string): Promise<Array<{ lat: number; lon: number }>>;

  // source items
  /** Returns true if the item is new (not seen before). */
  recordSourceItem(item: SourceItem): Promise<boolean>;
  hasSourceItem(source: string, externalId: string): Promise<boolean>;
  linkSourceItem(item: SourceItem, eventId: string): Promise<void>;
  /** The event an earlier source message belongs to (any age), for updates that reference it. */
  eventIdForSourceRefs(source: string, externalIds: string[]): Promise<string | null>;

  // events
  saveEvent(e: RiskEvent): Promise<void>;
  getEvent(id: string): Promise<RiskEvent | null>;
  /**
   * Events that are not over yet. Without an end time, "not over" means started within the
   * lookback (default 24 h). With an end time in the future, they count until that end, however
   * long ago they started (up to SCHEDULED_LOOKBACK_H): a multi-day storm or flood watch must
   * still reach someone who arrives on day two, and its updates must merge into it.
   */
  activeEvents(now: Date, lookbackHours?: number): Promise<RiskEvent[]>;
  eventsByStatus(status: EventStatus): Promise<RiskEvent[]>;
  /** Store (or replace) the dedup embedding of an event. Postgres: pgvector. */
  saveEventEmbedding(eventId: string, model: string, vector: number[]): Promise<void>;
  /**
   * Cosine similarity between `vector` and the stored embeddings of these events. Only events with
   * an embedding from the same model and of the same length are returned.
   */
  eventSimilarities(eventIds: string[], model: string, vector: number[]): Promise<Map<string, number>>;

  // alerts
  /** Returns null if this user already has an alert for this event revision. */
  insertAlert(a: Omit<Alert, 'id' | 'createdAt' | 'feedback'>): Promise<Alert | null>;
  hasAlertForEvent(userId: string, eventId: string): Promise<boolean>;
  /** Everyone who was told about this event (feed or push), and whether any of it reached them as a push. */
  recipients(eventId: string): Promise<Array<{ userId: string; pushed: boolean }>>;
  /** Pushes that count toward the daily limit: updates and all-clears (kind != 'new') don't (PRD 5.4). */
  pushCountSince(userId: string, sinceIso: string): Promise<number>;
  alertsForUser(userId: string, limit?: number): Promise<Alert[]>;
  getAlert(userId: string, alertId: string): Promise<Alert | null>;
  setFeedback(userId: string, alertId: string, feedback: Feedback): Promise<boolean>;
  /** Per-category relevance history for one user — input to ranking. */
  feedbackByCategory(userId: string): Promise<Record<string, { relevant: number; notRelevant: number }>>;
  /** KPIs from PRD Section 13: relevance, beyond-NINA, alerts per user per day. */
  metrics(sinceIso: string): Promise<Metrics>;

  // push delivery (receipts)
  /** Stores one row per push; `attempt` counts resends. */
  recordPushTickets(tickets: PushTicket[], attempt: number, atIso: string): Promise<void>;
  /** Pending tickets (with an Expo ticket id) sent before `sentBeforeIso`, oldest first. */
  pushTicketsToCheck(sentBeforeIso: string, limit: number): Promise<StoredPushTicket[]>;
  setPushStatus(ticketId: string, status: PushStatus, error?: string | null): Promise<void>;
  /** A device that uninstalled the app: forget its push token. Returns how many users had it. */
  clearPushToken(token: string): Promise<number>;

  // accounts (sign-in). A user is the person's data (prefs, places, alerts); devices are the
  // sign-ins (bearer tokens). An anonymous user has one device; an account can have several.
  accountForUser(userId: string): Promise<Account | null>;
  accountByEmail(email: string): Promise<Account | null>;
  createAccount(email: string, userId: string): Promise<Account>;
  /** Points this device token at another user (signing in on a phone that already has an account elsewhere). */
  moveDevice(token: string, toUserId: string): Promise<void>;
  /** Removes one device token (signing out); the user and other devices stay. */
  removeDevice(token: string): Promise<void>;
  deviceCount(userId: string): Promise<number>;
  /** Moves saved places (skipping duplicates) from one user to another, then deletes the first. */
  mergeUserInto(fromUserId: string, toUserId: string): Promise<void>;
  saveEmailCode(c: EmailCode): Promise<void>;
  emailCode(email: string): Promise<EmailCode | null>;
  deleteEmailCode(email: string): Promise<void>;

  // leases (one worker at a time across machines; see roles.ts)
  /**
   * Takes or renews the lease `name` for `holder` until now + ttlMs. True when `holder` holds it
   * afterwards: it was free, expired, or already this holder's. Atomic across processes.
   */
  acquireLease(name: string, holder: string, ttlMs: number, now?: Date): Promise<boolean>;
  /** Gives the lease up early (clean shutdown), so another worker can take over at once. */
  releaseLease(name: string, holder: string): Promise<void>;

  close(): Promise<void>;
}

/** Shared by both implementations so the numbers can't drift apart. */
/** Centre of the grid cell containing a point (also used to build the cell list in both stores). */
export function cellOf(lat: number, lon: number, stepDeg: number) {
  const c = (x: number) => Math.round((Math.floor(x / stepDeg) * stepDeg + stepDeg / 2) * 1e6) / 1e6;
  return { lat: c(lat), lon: c(lon) };
}

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
