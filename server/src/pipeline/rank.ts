import type { Delivery, RiskEvent, SavedPlace, User } from '../types.js';
import { distanceM } from '../geo.js';

/** A user location older than this is not used for matching (saved places still are). */
const LOCATION_MAX_AGE_MS = 24 * 3600_000;

export interface Match {
  /** null = the user's current location; otherwise the saved place's label. */
  place: string | null;
  distanceM: number;
}

/** Is this user (where they are now, or one of their saved places) inside the event's impact zone? */
export function match(user: User, places: SavedPlace[], event: RiskEvent, bufferM: number, now = new Date()): Match | null {
  const hits: Match[] = [];
  if (user.lat != null && user.lon != null && user.locationUpdatedAt &&
      now.getTime() - Date.parse(user.locationUpdatedAt) < LOCATION_MAX_AGE_MS) {
    const d = distanceM(user.lat, user.lon, event.lat, event.lon);
    if (d <= event.radiusM + bufferM) hits.push({ place: null, distanceM: d });
  }
  for (const p of places) {
    const d = distanceM(p.lat, p.lon, event.lat, event.lon);
    if (d <= event.radiusM + p.radiusM) hits.push({ place: p.label, distanceM: d });
  }
  return hits.sort((a, b) => (a.place === null ? -1 : 0) - (b.place === null ? -1 : 0) || a.distanceM - b.distanceM)[0] ?? null;
}

export interface RankContext {
  now: Date;
  pushesLast24h: number;
  feedback: Record<string, { relevant: number; notRelevant: number }>;
}

/**
 * Send now / feed (digest) / suppress. Rules today; the Phase 2 ranking model replaces
 * `learnedRelevance` with a trained score but keeps the hard overrides below.
 */
export function decide(user: User, event: RiskEvent, ctx: RankContext): { delivery: Delivery; reason: string } {
  const { prefs } = user;

  // Hard override: official severity-5 warnings always break through.
  if (event.official && event.severity === 5) return { delivery: 'push', reason: 'official extreme warning' };

  if (!prefs.categories.includes(event.category)) return { delivery: 'suppressed', reason: 'category turned off' };
  if (event.severity <= 1) return { delivery: 'feed', reason: 'information only' };

  const relevance = learnedRelevance(ctx.feedback[event.category]);
  if (event.severity < 4 && relevance !== null && relevance < 0.3) {
    return { delivery: 'feed', reason: 'usually rated not relevant' };
  }

  if (event.severity >= 4) return { delivery: 'push', reason: 'severe' };
  if (prefs.quietHours && inQuietHours(ctx.now, prefs.quietHours.start, prefs.quietHours.end, prefs.timezone)) {
    return { delivery: 'feed', reason: 'quiet hours' };
  }
  if (ctx.pushesLast24h >= prefs.dailyLimit) return { delivery: 'feed', reason: 'daily limit reached' };
  return { delivery: 'push', reason: 'relevant' };
}

/** Smoothed share of "relevant" ratings for a category; null until there are 5 ratings. */
export function learnedRelevance(f?: { relevant: number; notRelevant: number }): number | null {
  if (!f) return null;
  const n = f.relevant + f.notRelevant;
  if (n < 5) return null;
  return (f.relevant + 1) / (n + 2);
}

export function inQuietHours(now: Date, start: string, end: string, timezone: string): boolean {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return (h % 24) * 60 + m; };
  const t = toMin(hm), s = toMin(start), e = toMin(end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}
