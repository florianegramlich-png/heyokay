import { CATEGORIES, type Alert, type Category } from './types';

/**
 * What's going on now: the newest alert per event, for events still running (not ended, not lifted),
 * most severe first. Same rule as the web app (web/lib/feed.ts).
 */
export function currentAlerts(alerts: Alert[]): Alert[] {
  const latest = new Map<string, Alert>();
  for (const a of alerts) {
    const seen = latest.get(a.eventId);
    if (!seen || Date.parse(a.createdAt) > Date.parse(seen.createdAt)) latest.set(a.eventId, a);
  }
  return [...latest.values()]
    .filter((a) => !a.ended && a.kind !== 'all_clear' && !isAhead(a))
    .sort((x, y) => y.severity - x.severity || Date.parse(y.createdAt) - Date.parse(x.createdAt));
}

export interface CategoryGroup { category: Category; alerts: Alert[] }

/** Current alerts by category, in the app's category order; empty categories are left out. */
export function byCategory(alerts: Alert[]): CategoryGroup[] {
  const current = currentAlerts(alerts);
  return CATEGORIES
    .map((category) => ({ category, alerts: current.filter((a) => a.category === category) }))
    .filter((g) => g.alerts.length > 0);
}

/** Everything else (ended events, all-clears, older messages of current events), newest first. */
export function earlierAlerts(alerts: Alert[]): Alert[] {
  const current = new Set([...currentAlerts(alerts), ...aheadAlerts(alerts)].map((a) => a.id));
  return alerts.filter((a) => !current.has(a.id)).sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
}

/** Begins later (more than an hour from now): shown under "Coming up", not "Now". */
export function isAhead(a: Alert, now = Date.now()): boolean {
  return !!a.startsAt && Date.parse(a.startsAt) - now > 60 * 60_000;
}

/** What's coming up for this person, soonest first (newest alert per event). */
export function aheadAlerts(alerts: Alert[], now = Date.now()): Alert[] {
  return latestPerEvent(alerts)
    .filter((a) => !a.ended && a.kind !== 'all_clear' && isAhead(a, now))
    .sort((x, y) => Date.parse(x.startsAt!) - Date.parse(y.startsAt!));
}

function latestPerEvent(alerts: Alert[]): Alert[] {
  const latest = new Map<string, Alert>();
  for (const a of alerts) {
    const seen = latest.get(a.eventId);
    if (!seen || Date.parse(a.createdAt) > Date.parse(seen.createdAt)) latest.set(a.eventId, a);
  }
  return [...latest.values()];
}
