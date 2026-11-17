// Client-facing mirror of server/src/types.ts — keep in sync.

export const CATEGORIES = ['weather', 'crime', 'transit', 'public_safety', 'health', 'infrastructure'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Severity = 1 | 2 | 3 | 4 | 5;
export type Delivery = 'push' | 'feed' | 'suppressed';
export type Feedback = 'relevant' | 'not_relevant';
/** new = first alert; update = the event changed; all_clear = it was lifted early. */
export type AlertKind = 'new' | 'update' | 'all_clear';

export interface QuietHours { start: string; end: string }

export interface UserPrefs {
  categories: Category[];
  quietHours: QuietHours | null;
  dailyLimit: number;
  timezone: string;
  language: 'de' | 'en';
}

export const DEFAULT_PREFS: UserPrefs = {
  categories: ['weather', 'crime', 'transit', 'public_safety'],
  quietHours: { start: '22:00', end: '07:00' },
  dailyLimit: 3,
  timezone: 'Europe/Berlin',
  language: 'de',
};

export interface SavedPlace { id: string; label: string; lat: number; lon: number; radiusM: number }

export interface Alert {
  id: string;
  eventId: string;
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
  feedback: Feedback | null;
  createdAt: string;
  kind: AlertKind;
  /** The event is over (ran out or was lifted). */
  ended: boolean;
}

export interface SourceRef { sourceName: string; url?: string; title: string; official: boolean }

export interface AlertDetail { alert: Alert; sources: SourceRef[]; summary: string; endsAt: string | null }

// Category labels and hints live in lib/i18n.ts (German + English).
