// Shared domain types. app/src/lib/types.ts mirrors the client-facing parts — keep them in sync.

export const CATEGORIES = ['weather', 'crime', 'transit', 'public_safety', 'health', 'infrastructure'] as const;
export type Category = (typeof CATEGORIES)[number];

/** 1 = info, 2 = minor, 3 = moderate, 4 = severe, 5 = extreme. Same meaning across all sources. */
export type Severity = 1 | 2 | 3 | 4 | 5;

export type SourceKind = 'nina' | 'dwd' | 'nws' | 'rss' | 'presseportal' | 'owm' | 'manual';

export type Language = 'de' | 'en';

export type Hazard = 'heat';

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
  language: Language;
}

export const DEFAULT_PREFS: UserPrefs = {
  categories: ['weather', 'crime', 'transit', 'public_safety'],
  quietHours: { start: '22:00', end: '07:00' },
  dailyLimit: 3,
  timezone: 'Europe/Berlin',
  language: 'de',
};

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
  feedback: Feedback | null;
  createdAt: string;
}
