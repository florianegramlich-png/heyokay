import type { Delivery, RiskEvent, SavedPlace, User } from '../types.js';
import { distanceM, distanceToAreasM, LOCATION_MAX_AGE_MS } from '../geo.js';

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
    if (inZone(event, user.lat, user.lon, d, bufferM)) hits.push({ place: null, distanceM: d });
  }
  for (const p of places) {
    const d = distanceM(p.lat, p.lon, event.lat, event.lon);
    if (inZone(event, p.lat, p.lon, d, p.radiusM)) hits.push({ place: p.label, distanceM: d });
  }
  return hits.sort((a, b) => (a.place === null ? -1 : 0) - (b.place === null ? -1 : 0) || a.distanceM - b.distanceM)[0] ?? null;
}

/** Exact outlines when the source gave them (NWS zones); otherwise the event circle. */
function inZone(event: RiskEvent, lat: number, lon: number, dCentre: number, marginM: number): boolean {
  if (event.areas?.length) return distanceToAreasM(lat, lon, event.areas) <= marginM;
  return dCentre <= event.radiusM + marginM;
}

/** Begins more than an hour from now. */
export const AHEAD_MS = 60 * 60_000;
export function isAhead(event: Pick<RiskEvent, 'onsetAt'>, now: Date): boolean {
  return !!event.onsetAt && Date.parse(event.onsetAt) - now.getTime() > AHEAD_MS;
}

export interface RankContext {
  now: Date;
  pushesLast24h: number;
  feedback: Record<string, { relevant: number; notRelevant: number }>;
  /** Pollen & UV: this person already had a pollen/UV push in the last 12 hours. */
  pollenUvPushedRecently?: boolean;
  /** The saved place this alert is for (null = the person's current location). */
  matchedPlace?: string | null;
}

/** Pollen & UV may push only in the morning (local time), so it never wakes anyone at night. */
export const POLLEN_UV_PUSH_HOURS = { from: '06:00', to: '11:00' };

/**
 * Send now / feed (digest) / suppress. Rules today; the Phase 2 ranking model replaces
 * `learnedRelevance` with a trained score but keeps the hard overrides below.
 */
export function decide(user: User, event: RiskEvent, ctx: RankContext): { delivery: Delivery; reason: string } {
  const { prefs } = user;

  // Hard override: official severity-5 warnings always break through.
  if (event.official && event.severity === 5) return { delivery: 'push', reason: 'official extreme warning' };

  if (!prefs.categories.includes(event.category)) return { delivery: 'suppressed', reason: 'category turned off' };
  // "Only the services I use": an outage of a service the person didn't pick isn't theirs.
  if (event.category === 'technology' && event.service && prefs.techServices && !prefs.techServices.includes(event.service)) {
    return { delivery: 'suppressed', reason: 'service not followed' };
  }
  // Risk outlook (PRD 6.1 #14): something that begins later goes to the feed under "Ahead";
  // a push comes with the actual warning, not the forecast.
  // Product recalls are never a push (Flori, 2026-11-21): the feed and the daily summary.
  if (event.category === 'recall') return { delivery: 'feed', reason: 'recall: feed only' };
  // Demonstrations and events: something to plan around, not a warning (Flori, 2026-11-21: feed by default).
  if (event.category === 'events') return { delivery: 'feed', reason: 'events: feed only' };
  // Pollen & UV (opt-in): only the types the person picked; "hoch" may push once, in the morning.
  if (event.category === 'pollen_uv') {
    if (event.pollenUv && prefs.pollenUv && !prefs.pollenUv.includes(event.pollenUv)) return { delivery: 'suppressed', reason: 'pollen type not followed' };
    if (event.severity <= 1) return { delivery: 'feed', reason: 'pollen/UV: moderate, feed only' };
    if (!inQuietHours(ctx.now, POLLEN_UV_PUSH_HOURS.from, POLLEN_UV_PUSH_HOURS.to, prefs.timezone)) return { delivery: 'feed', reason: 'pollen/UV: push only in the morning' };
    if (ctx.pollenUvPushedRecently) return { delivery: 'feed', reason: 'pollen/UV: one push a day' };
  }
  // Motorway closures: in the feed, a push only when one of the person's saved places is near it.
  if (event.hazard === 'road_closure' && !ctx.matchedPlace) return { delivery: 'feed', reason: 'road closure: push only near a saved place' };
  if (isAhead(event, ctx.now)) return { delivery: 'feed', reason: 'coming up' };
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
