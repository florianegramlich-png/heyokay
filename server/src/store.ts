import type { SourceStatus } from './ingest.js';
import type { AppEvent, AppEventCount, Platform } from './app-events.js';
import type { PushTicket } from './push.js';
import type { RetentionReport } from './retention.js';
import type {
  Alert, Category, Decision, DecisionKind, Reviewer, EventStatus, Feedback, RiskEvent, SavedPlace, SourceItem, User, UserPrefs,
} from './types.js';

/** How far back an event with a known, future end time still counts as active. */
export const SCHEDULED_LOOKBACK_H = 24 * 14;

export interface Area { lat: number; lon: number; radiusM: number }
export interface UserWithPlaces { user: User; places: SavedPlace[] }

/** One push waiting in the delivery queue: the message itself, so sending needs no lookups. */
export interface PushJob { id: string; token: string; alert: Alert; attempt: number; createdAt: string }

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

/** One person in a family (family.ts). `id` is what other members see; the user id never leaves the server. */
export interface FamilyMember { id: string; familyId: string; userId: string; name: string; joinedAt: string }
/** "Hey, okay?" check-in (checkins.ts): one per person and event. */
export type CheckinAnswer = 'ok' | 'call_me';
export interface Checkin {
  id: string;
  userId: string;
  eventId: string;
  /** The person's own alert for the event (its title is what the check-in is about). */
  alertId: string;
  askedAt: string;
  remindedAt: string | null;
  answer: CheckinAnswer | null;
  answeredAt: string | null;
}
/** A family's current invite code, stored as a hash. */
export interface FamilyInvite { codeHash: string; familyId: string; expiresAt: string }

/** A sign-in provider other than email codes (PRD 5.3, 7.1). */
export type IdentityProvider = 'apple' | 'google';
export interface AccountIdentity { provider: IdentityProvider; subject: string }

export interface EmailCode { email: string; codeHash: string; expiresAt: string; attempts: number; sends: number; windowStart: string }

export interface LlmUsageDay { day: string; calls: number; inputTokens: number; outputTokens: number; eur: number; skipped: number }

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
  /** Shares one of this person's places with their family, or stops. Null when it isn't theirs. */
  setPlaceShared(userId: string, placeId: string, shared: boolean): Promise<SavedPlace | null>;
  /** Stops sharing all of this person's places (when they join, start or leave a family). */
  unshareAllPlaces(userId: string): Promise<void>;
  /** The places the other members of this person's family share, each with `sharedBy` (their family name). */
  familyPlaces(userId: string): Promise<SavedPlace[]>;
  /**
   * Users who may be inside an area: their current location (if updated within
   * LOCATION_MAX_AGE_MS of `now`) is within radius + bufferM, or one of their saved places
   * overlaps it (radius + place radius), or a place another member of their family shared
   * overlaps it. Each comes with all of their saved places plus their family's shared places
   * (those with `sharedBy`, as in `familyPlaces`).
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
  /** Events of one topic that began in [fromIso, toIso), any status, oldest first (bias review). */
  eventsStartedBetween(category: Category, fromIso: string, toIso: string): Promise<RiskEvent[]>;
  /** Store (or replace) the dedup embedding of an event. Postgres: pgvector. */
  saveEventEmbedding(eventId: string, model: string, vector: number[]): Promise<void>;
  /**
   * Cosine similarity between `vector` and the stored embeddings of these events. Only events with
   * an embedding from the same model and of the same length are returned.
   */
  eventSimilarities(eventIds: string[], model: string, vector: number[]): Promise<Map<string, number>>;

  // alerts
  /** Returns null if this user already has an alert for this event revision. */
  /** `createdAt` defaults to now; the pipeline passes its own clock. */
  insertAlert(a: Omit<Alert, 'id' | 'createdAt' | 'feedback'> & { createdAt?: string }): Promise<Alert | null>;
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
  /** The account a provider's stable user id (`sub`) is linked to. */
  accountByIdentity(provider: IdentityProvider, subject: string): Promise<Account | null>;
  /** Links a provider's user id to an account (no-op if already linked to it). */
  addIdentity(accountId: string, identity: AccountIdentity): Promise<void>;
  identities(accountId: string): Promise<AccountIdentity[]>;
  /** Points this device token at another user (signing in on a phone that already has an account elsewhere). */
  moveDevice(token: string, toUserId: string): Promise<void>;
  /** Removes one device token (signing out); the user and other devices stay. */
  removeDevice(token: string): Promise<void>;
  deviceCount(userId: string): Promise<number>;
  /** Moves saved places (skipping duplicates) and the family membership (if the second has none) from one user to another, then deletes the first. */
  mergeUserInto(fromUserId: string, toUserId: string): Promise<void>;
  saveEmailCode(c: EmailCode): Promise<void>;
  emailCode(email: string): Promise<EmailCode | null>;
  deleteEmailCode(email: string): Promise<void>;

  // delivery queue (pipeline/run.ts → drainPushQueue). Matching writes jobs; senders claim batches.
  enqueuePushJobs(jobs: Array<{ token: string; alert: Alert; attempt: number }>, atIso: string): Promise<void>;
  /**
   * Claims up to `limit` jobs, oldest first, for `holder` until `lockUntilIso`. Jobs claimed by a
   * sender that died become claimable again once their lock runs out. Two concurrent claims never
   * get the same job (Postgres: FOR UPDATE SKIP LOCKED).
   */
  claimPushJobs(holder: string, limit: number, nowIso: string, lockUntilIso: string): Promise<PushJob[]>;
  /** Sent (or refused for good): remove from the queue. */
  completePushJobs(ids: string[]): Promise<void>;
  pushQueueDepth(): Promise<number>;

  // source health, written by the worker after each poll, read by any API machine (Alert Desk)
  saveSourceStatuses(statuses: Record<string, SourceStatus>): Promise<void>;
  sourceStatuses(): Promise<Record<string, SourceStatus>>;

  // AI spend per UTC day (llm-budget.ts), shared by all machines
  addLlmUsage(day: string, u: { calls: number; inputTokens: number; outputTokens: number; eur: number; skipped: number }): Promise<void>;
  llmUsage(fromDay: string): Promise<LlmUsageDay[]>;

  // leases (one worker at a time across machines; see roles.ts)
  /**
   * Takes or renews the lease `name` for `holder` until now + ttlMs. True when `holder` holds it
   * afterwards: it was free, expired, or already this holder's. Atomic across processes.
   */
  acquireLease(name: string, holder: string, ttlMs: number, now?: Date): Promise<boolean>;
  /**
   * Marks today's evening summary (digest) for this person as sent. True only for the first
   * caller per person and local day, so two workers never send it twice.
   */
  claimDigest(userId: string, day: string, atIso: string): Promise<boolean>;
  /** Gives the lease up early (clean shutdown), so another worker can take over at once. */
  releaseLease(name: string, holder: string): Promise<void>;

  // ── Alert Desk reviewers (PRD 6.2 step 5) ──
  createReviewer(r: Reviewer): Promise<void>;
  reviewerByEmail(email: string): Promise<Reviewer | null>;
  reviewers(): Promise<Reviewer[]>;
  updateReviewer(id: string, patch: Partial<Pick<Reviewer, 'name' | 'passwordHash' | 'disabled'>>): Promise<boolean>;
  /** Sessions are stored as a hash of the cookie value. */
  createReviewerSession(tokenHash: string, reviewerId: string, expiresAt: string): Promise<void>;
  /** The reviewer behind a session that hasn't expired, unless they were disabled. */
  reviewerBySession(tokenHash: string, nowIso: string): Promise<Reviewer | null>;
  deleteReviewerSession(tokenHash: string): Promise<void>;
  deleteReviewerSessionsFor(reviewerId: string): Promise<void>;

  // ── family sharing (PRD 6.1 #8; rules in family.ts) ──
  familyMemberByUser(userId: string): Promise<FamilyMember | null>;
  familyMembers(familyId: string): Promise<FamilyMember[]>;
  /**
   * Adds the person unless they are already in a family or the family already has `max` people.
   * Atomic: two people joining at the same moment can't take a family over `max`.
   */
  addFamilyMember(m: FamilyMember, max: number): Promise<'added' | 'already_in_family' | 'family_full'>;
  removeFamilyMember(familyId: string, memberId: string): Promise<boolean>;
  /** Replaces the family's invite (one at a time). */
  setFamilyInvite(invite: FamilyInvite): Promise<void>;
  /** Uses up an invite that hasn't expired: deletes it and returns its family, else null. Atomic. */
  takeFamilyInvite(codeHash: string, nowIso: string): Promise<string | null>;
  deleteFamilyInvites(familyId: string): Promise<void>;

  // ── "Hey, okay?" check-ins (PRD 6.1 #8; rules in checkins.ts) ──
  /** False when this person already has a check-in for this event. */
  createCheckin(c: Checkin): Promise<boolean>;
  /** This person's check-ins asked since `sinceIso`, newest first. */
  checkinsForUser(userId: string, sinceIso: string): Promise<Checkin[]>;
  /** Sets the answer of one of this person's check-ins asked since `openSinceIso`; null when there is none. */
  answerCheckin(userId: string, id: string, answer: CheckinAnswer, atIso: string, openSinceIso: string): Promise<Checkin | null>;
  /** Unanswered check-ins without a reminder, asked in [askedAfterIso, askedBeforeIso], oldest first. */
  dueCheckinReminders(askedAfterIso: string, askedBeforeIso: string, limit: number): Promise<Checkin[]>;
  /** Marks the reminder as sent. True only for the first caller, so two workers never both send it. */
  markCheckinReminded(id: string, atIso: string): Promise<boolean>;
  /** Answered check-ins of these people, answered since `sinceIso`, newest answer first. */
  checkinAnswers(userIds: string[], sinceIso: string): Promise<Checkin[]>;

  // ── data retention (PRD 11) ──
  /** Deletes what is past its retention period (retention.ts); returns how many rows of each. */
  purgeExpired(nowIso: string): Promise<RetentionReport>;

  // ── product KPIs (PRD 13) ──
  /** The person used the app (foreground calls). Written at most once an hour. */
  markSeen(userId: string, nowIso: string): Promise<void>;
  /** First time the person opened this alert's detail (a push tap or a tap in the feed). */
  markAlertOpened(userId: string, alertId: string, nowIso: string): Promise<void>;
  /** Raw inputs for computeKpis: first alerts since `sinceIso` and every person's dates. */
  kpiInputs(sinceIso: string): Promise<KpiInputs>;

  // ── anonymous app events (PRD 13): counts per day, platform and name only ──
  addAppEvents(day: string, platform: Platform, counts: Map<AppEvent, number>): Promise<void>;
  /** Rows from `sinceDay` (YYYY-MM-DD, inclusive). */
  appEventCounts(sinceDay: string): Promise<AppEventCount[]>;

  // ── decision log (PRD 6.3) ──
  recordDecision(d: Decision): Promise<void>;
  /** Newest first. */
  decisions(q: DecisionQuery): Promise<Decision[]>;

  close(): Promise<void>;
}

export interface KpiInputs {
  alerts: Array<{ eventId: string; userId: string; kind: string; delivery: string; feedback: string | null; official: boolean; createdAt: string; openedAt: string | null; eventStartsAt: string | null }>;
  users: Array<{ createdAt: string; lastSeenAt: string | null; hasPush: boolean }>;
}

export interface DecisionQuery {
  eventId?: string;
  kind?: DecisionKind;
  /** ISO time, inclusive. */
  since?: string;
  /** Default 200, at most 10 000. */
  limit?: number;
}
export const decisionLimit = (q: DecisionQuery) => Math.min(Math.max(1, q.limit ?? 200), 10_000);

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
