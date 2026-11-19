import { aheadAlerts, currentAlerts } from './feed';
import { CATEGORIES, type Alert, type Category, type Severity } from './types';

/**
 * The overview at the top of the main screen, in the layout of Flori's v0 prototype (2026-11-19),
 * built from real alerts only: no risk percentages or area scores (PRD: no area-level crime scores).
 *
 * calm  = nothing current      → "All okay"
 * info  = highest is info/minor → "Good to know"
 * watch = highest is moderate   → "Keep an eye out"
 * act   = severe or extreme     → "Take care"
 */
export type Status = 'calm' | 'info' | 'watch' | 'act';

export interface CategoryTile {
  category: Category;
  count: number;
  /** Highest severity among its current alerts; null for none and always for police activity. */
  highest: Severity | null;
  /** The most severe current alert, opened when the tile is tapped. */
  top: Alert | null;
}

export interface Dashboard {
  status: Status;
  current: number;
  highest: Severity | null;
  tiles: CategoryTile[];
  /** Starting within the next 24 hours, soonest first, with their position on the 24-hour line (0–1). */
  next24: { alert: Alert; at: number }[];
}

const DAY = 24 * 60 * 60_000;

export function statusFor(highest: Severity | null): Status {
  if (highest === null) return 'calm';
  if (highest <= 2) return 'info';
  if (highest === 3) return 'watch';
  return 'act';
}

/**
 * @param followed the topics the person follows; a topic with current alerts is shown even if not
 *   followed (very severe official warnings reach everyone).
 */
export function buildDashboard(alerts: Alert[], followed: readonly Category[] = CATEGORIES, now = Date.now()): Dashboard {
  const current = currentAlerts(alerts);
  const highest = current.length ? (Math.max(...current.map((a) => a.severity)) as Severity) : null;
  const tiles = CATEGORIES
    .map((category): CategoryTile => {
      const mine = current.filter((a) => a.category === category); // already most severe first
      return {
        category,
        count: mine.length,
        highest: category === 'crime' || !mine.length ? null : mine[0].severity,
        top: mine[0] ?? null,
      };
    })
    .filter((t) => t.count > 0 || followed.includes(t.category));
  const next24 = aheadAlerts(alerts, now)
    .map((alert) => ({ alert, at: (Date.parse(alert.startsAt!) - now) / DAY }))
    .filter((x) => x.at <= 1);
  return { status: statusFor(highest), current: current.length, highest, tiles, next24 };
}
