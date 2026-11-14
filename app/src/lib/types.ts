// Client-facing mirror of server/src/types.ts — keep in sync.

export const CATEGORIES = ['weather', 'crime', 'transit', 'public_safety', 'health', 'infrastructure'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Severity = 1 | 2 | 3 | 4 | 5;
export type Delivery = 'push' | 'feed' | 'suppressed';
export type Feedback = 'relevant' | 'not_relevant';

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
}

export interface SourceRef { sourceName: string; url?: string; title: string; official: boolean }

export interface AlertDetail { alert: Alert; sources: SourceRef[]; summary: string; endsAt: string | null }

export const CATEGORY_LABEL: Record<Category, string> = {
  weather: 'Unwetter',
  crime: 'Polizeilage',
  transit: 'ÖPNV-Störung',
  public_safety: 'Gefahrenlage',
  health: 'Gesundheit',
  infrastructure: 'Infrastruktur',
};

export const CATEGORY_HINT: Record<Category, string> = {
  weather: 'Sturm, Gewitter, Hitze, Hochwasser',
  crime: 'Polizeieinsätze und Sperrungen in deiner Nähe',
  transit: 'Ausfälle und Sperrungen bei S-/U-Bahn',
  public_safety: 'Brände, Bombenfunde, Gefahrstoffe',
  health: 'Trinkwasser, Luftqualität',
  infrastructure: 'Strom-, Wasser- und Netzausfälle',
};
