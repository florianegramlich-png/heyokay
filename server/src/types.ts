import type { CountryCode } from './countries.js';
// Shared domain types. app/src/lib/types.ts mirrors the client-facing parts — keep them in sync.

export const CATEGORIES = ['weather', 'crime', 'transit', 'public_safety', 'health', 'infrastructure', 'technology', 'recall', 'pollen_uv'] as const;
/** Categories added after launch that are on for everyone who hasn't seen them yet (see normalizePrefs).
 *  Pollen & UV (2026-11-22) is not among them: it is opt-in. */
export const NEW_DEFAULT_ON: Category[] = ['technology', 'recall'];
const ORIGINAL_CATEGORIES: Category[] = ['weather', 'crime', 'transit', 'public_safety', 'health', 'infrastructure'];
export type Category = (typeof CATEGORIES)[number];

/** 1 = info, 2 = minor, 3 = moderate, 4 = severe, 5 = extreme. Same meaning across all sources. */
export type Severity = 1 | 2 | 3 | 4 | 5;

export type SourceKind = 'nina' | 'dwd' | 'nws' | 'rss' | 'presseportal' | 'owm' | 'statuspage' | 'ipaws' | 'sachet' | 'usgs' | 'pegelonline' | 'wfigs' | 'lebensmittelwarnung' | 'fda' | 'cpsc' | 'dwd-health' | 'manual';

export type Language = 'de' | 'en';
/**
 * Languages the app UI can be set to (UserPrefs.language). Wider than Language, which is the
 * language alert copy and emails are written in: for a UI-only language (Tamil, 2026-11-19) the
 * server writes in English via contentLanguage().
 */
export type UiLanguage = Language | 'ta';
export const UI_LANGUAGES = ['de', 'en', 'ta'] as const satisfies readonly UiLanguage[];
export const contentLanguage = (l: UiLanguage | null | undefined): Language => (l === 'de' ? 'de' : 'en');

export type Hazard = 'heat' | 'outage' | 'earthquake' | 'air' | 'flood' | 'wildfire' | 'recall' | 'pollen' | 'uv';

/** A raw item as it arrives from a source, before the AI pipeline touches it. */
export interface SourceItem {
  source: SourceKind;
  /** Feed-level name shown to users, e.g. "NINA (BBK)", "Polizei Berlin". */
  sourceName: string;
  externalId: string;
  /** Earlier messages this one updates or cancels (NWS/CAP `references`). Used to keep one event per incident. */
  references?: string[];
  /** Language of the source text, and so of the alert copy. Default 'de'. */
  language?: Language;
  /** The polled feed this item came from (e.g. 'nws:CA'); see RiskEvent.feedKeys. */
  feedKey?: string;
  /** Machine-generated, already structured items (e.g. heat from a forecast): mapped directly, no model. */
  structured?: boolean;
  /** A specific hazard within the category, for the recommended action (e.g. heat within weather). */
  hazard?: Hazard;
  /** Technology outages: which service (status-page key, e.g. "zoom"), for per-service follow. */
  service?: string;
  /** Pollen & UV: which pollen type ("birke") or "uv". See UserPrefs.pollenUv. */
  pollenUv?: string;
  /** When the hazard begins, if the source says (CAP onset, forecast peak). Future = "coming up". */
  onsetAt?: string;
  /** ISO country (countries.ts) — decides emergency numbers and units. Missing = inferred from language. */
  country?: CountryCode;
  /** Official warning systems (NINA/MoWaS, DWD via NINA). Official levels override the model. */
  official: boolean;
  title: string;
  body: string;
  url?: string;
  publishedAt: string;
  // Structured hints, present for official feeds
  lat?: number;
  lon?: number;
  radiusM?: number;
  officialSeverity?: Severity;
  category?: Category;
  expiresAt?: string;
  areaName?: string;
  /** Exact warning area as polygon outlines ([lon, lat] rings). When present, matching uses these, not the circle. */
  areas?: [number, number][][];
}

/** What extraction produces from one source item. */
export interface ExtractedEvent {
  category: Category;
  severity: Severity;
  /** 0–1. Low confidence goes to the Alert Desk. */
  confidence: number;
  title: string;
  summary: string;
  areaName: string;
  lat: number | null;
  lon: number | null;
  radiusM: number;
  startsAt: string;
  endsAt: string | null;
}

export type EventStatus = 'pending_review' | 'approved' | 'rejected' | 'auto';

export interface EventSourceRef {
  sourceName: string;
  externalId: string;
  url?: string;
  title: string;
  official: boolean;
}

export interface RiskEvent {
  id: string;
  category: Category;
  severity: Severity;
  confidence: number;
  official: boolean;
  title: string;
  summary: string;
  areaName: string;
  lat: number;
  lon: number;
  radiusM: number;
  /** Exact warning area, when the source gives one. The circle above stays for the map and as the fallback. */
  areas?: [number, number][][];
  startsAt: string;
  endsAt: string | null;
  status: EventStatus;
  /** Concatenated source text. The verifier checks every alert fact against this. */
  facts: string;
  sources: EventSourceRef[];
  copyTitle: string | null;
  copyBody: string | null;
  copyAction: string | null;
  copyIsTemplate: boolean;
  createdAt: string;
  updatedAt: string;
  /** Language the alert copy is written in. Missing = 'de' (events created before this field existed). */
  language?: Language;
  /** Source feeds that list this event while it is active, e.g. 'nws:CA'. When an event drops out of
   *  its feed before its end time, it was lifted early (NWS removes cancelled alerts instead of announcing it). */
  feedKeys?: string[];
  /** Bumped when severity rises or a new source changes the event, so users get an update. */
  revision: number;
  /** Specific hazard (e.g. heat), for the recommended action. */
  hazard?: Hazard;
  /** Technology outages: the service it concerns (status-page key). See UserPrefs.techServices. */
  service?: string;
  /** Pollen & UV: the pollen type ("birke") or "uv". See UserPrefs.pollenUv. */
  pollenUv?: string;
  /** When the hazard begins, if the source says (CAP onset, forecast peak). Future = "coming up". */
  onsetAt?: string;
  /** ISO country (countries.ts) — decides emergency numbers and units. Missing = inferred from language. */
  country?: CountryCode;
}

export interface AlertCopy {
  title: string; // ≤ 50 chars
  body: string; // ≤ 100 chars
  action: string; // recommended action, from the guidance library
}

export type Delivery = 'push' | 'feed' | 'suppressed';

/** new = first alert for an event; update = it changed (downgrade, new end time); all_clear = it ended early. */
export type AlertKind = 'new' | 'update' | 'all_clear';
export type Feedback = 'relevant' | 'not_relevant';

export interface QuietHours {
  start: string; // "22:00"
  end: string; // "07:00"
}

export interface UserPrefs {
  categories: Category[];
  quietHours: QuietHours | null;
  dailyLimit: number;
  timezone: string;
  language: UiLanguage;
  /**
   * Optional consent to use their data for aggregated, anonymous safety insights (PRD 5.5,
   * Decision 25). Off unless the person turns it on; nothing is shared until a partner programme exists.
   */
  insightsConsent?: boolean;
  /** When insightsConsent last changed (set by the server, ISO). */
  insightsConsentAt?: string | null;
  /** Categories this person has been offered; new ones not in here are switched on once (normalizePrefs). */
  knownCategories?: Category[];
  /**
   * Evening summary (PRD 6.1 #7, 6.2 step 7): local time ("18:00") for one push that bundles the
   * day's alerts that went to the feed only. null = off. Missing = the default.
   */
  digestTime?: string | null;
  /**
   * Technology outages, per service ("only the services I use"): status-page keys, e.g. ["zoom"].
   * null or missing = every service. Services added later are then included automatically.
   */
  techServices?: string[] | null;
  /**
   * Pollen & UV, per pollen type and UV ("birke", "graeser", …, "uv"; sources/dwd-health.ts).
   * null or missing = all of them.
   */
  pollenUv?: string[] | null;
}

export const DEFAULT_PREFS: UserPrefs = {
  categories: ['weather', 'crime', 'transit', 'public_safety', 'technology', 'recall'],
  quietHours: { start: '22:00', end: '07:00' },
  dailyLimit: 3,
  timezone: 'Europe/Berlin',
  // English default for now (Flori, 2026-11-18); clients send the person's choice.
  language: 'en',
  digestTime: '18:00',
};

/**
 * Stored prefs + defaults, with categories added since this person last saved their settings
 * switched on once (e.g. technology outages, 2026-11-18). After that their choice stands.
 */
export function normalizePrefs(raw: Partial<UserPrefs>): UserPrefs {
  const p: UserPrefs = { ...DEFAULT_PREFS, ...raw };
  const known = p.knownCategories ?? ORIGINAL_CATEGORIES;
  const added = NEW_DEFAULT_ON.filter((c) => !known.includes(c) && !p.categories.includes(c));
  return { ...p, categories: [...p.categories, ...added], knownCategories: [...CATEGORIES] };
}

/** A saved choice: the person has now seen every category, so nothing is switched on for them later. */
/** Records when the insights consent changed (GDPR: we must be able to show when it was given). */
export function stampConsent(prev: Partial<UserPrefs> | null, next: UserPrefs, now = new Date()): UserPrefs {
  const before = prev?.insightsConsent ?? false;
  const after = next.insightsConsent ?? false;
  if (prev && before === after) return { ...next, insightsConsentAt: prev.insightsConsentAt ?? null };
  return { ...next, insightsConsent: after, insightsConsentAt: !prev && !after ? null : now.toISOString() };
}

export function savedPrefs(p: UserPrefs): UserPrefs {
  return { ...p, knownCategories: [...CATEGORIES] };
}

export interface User {
  id: string;
  tokenHash: string;
  pushToken: string | null;
  prefs: UserPrefs;
  lat: number | null;
  lon: number | null;
  locationUpdatedAt: string | null;
  createdAt: string;
}

export interface SavedPlace {
  id: string;
  userId: string;
  label: string;
  lat: number;
  lon: number;
  radiusM: number;
}

export interface Alert {
  id: string;
  userId: string;
  eventId: string;
  eventRevision: number;
  title: string;
  body: string;
  action: string;
  category: Category;
  severity: Severity;
  official: boolean;
  aiWritten: boolean;
  sourceName: string;
  sourceUrl: string | null;
  lat: number;
  lon: number;
  radiusM: number;
  matchedPlace: string | null;
  delivery: Delivery;
  reason: string;
  /** Missing on alerts created before updates existed = 'new'. */
  kind?: AlertKind;
  /** Set when the event begins later ("coming up"): the apps list it under Ahead, not Now. */
  startsAt?: string;
  feedback: Feedback | null;
  createdAt: string;
}
