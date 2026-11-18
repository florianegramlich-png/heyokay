import { CATEGORIES, type Alert, type Category } from './types';

/**
 * What's going on now: the newest alert per event, for events that are still running
 * (not ended, not lifted). The dashboard shows these grouped by category; no scores.
 */
export function currentAlerts(alerts: Alert[]): Alert[] {
  const latest = new Map<string, Alert>();
  for (const a of alerts) {
    const seen = latest.get(a.eventId);
    if (!seen || Date.parse(a.createdAt) > Date.parse(seen.createdAt)) latest.set(a.eventId, a);
  }
  return [...latest.values()]
    .filter((a) => !a.ended && a.kind !== 'all_clear')
    .sort((x, y) => y.severity - x.severity || Date.parse(y.createdAt) - Date.parse(x.createdAt));
}

export interface CategoryGroup { category: Category; alerts: Alert[] }

/** Current alerts by category, in the app's category order; categories without anything are left out. */
export function byCategory(alerts: Alert[]): CategoryGroup[] {
  const current = currentAlerts(alerts);
  return CATEGORIES
    .map((category) => ({ category, alerts: current.filter((a) => a.category === category) }))
    .filter((g) => g.alerts.length > 0);
}

/** Calm by default; only severe and extreme get warm colours (same scale as the phone app). */
export const SEVERITY_STYLE: Record<number, string> = {
  1: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  2: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  3: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  4: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  5: 'bg-red-500/15 text-red-300 border-red-500/30',
};
