import type { Alert, Category } from './types.js';

/**
 * Alert history search (PRD 5.3 "searchable alert history"). People look back for "that S-Bahn
 * thing last week" or "the storm warning": one entry per incident, its latest state (an
 * all-clear if it was lifted), filtered by words and topic. Only the person's own alerts.
 */

/** How far back the history reaches (alerts are kept 30 days, see the data-retention item). */
export const HISTORY_SCAN = 1000;

/** Lower case, no accents, ß → ss: "Straße" finds "strasse", "Köln" finds "koln". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');
}

export interface HistoryQuery { q?: string; category?: Category; limit?: number }

/** Newest first; every word of `q` must appear in the title, text, place or source. */
export function searchHistory(alerts: Alert[], query: HistoryQuery): Alert[] {
  const words = fold(query.q ?? '').split(/\s+/).filter(Boolean);
  const latest = new Map<string, Alert>();
  const byEvent = new Map<string, Alert[]>();
  for (const a of alerts) {
    if (a.delivery === 'suppressed') continue;
    byEvent.set(a.eventId, [...(byEvent.get(a.eventId) ?? []), a]);
    const cur = latest.get(a.eventId);
    if (!cur || a.createdAt > cur.createdAt || (a.createdAt === cur.createdAt && a.eventRevision > cur.eventRevision)) latest.set(a.eventId, a);
  }
  const out: Alert[] = [];
  for (const a of [...latest.values()].sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
    if (query.category && a.category !== query.category) continue;
    if (words.length) {
      // Match the first alert's words too: an all-clear's text says only "lifted".
      const hay = fold(byEvent.get(a.eventId)!.map((x) => `${x.title} ${x.body} ${x.matchedPlace ?? ''} ${x.sourceName}`).join(' '));
      if (!words.every((w) => hay.includes(w))) continue;
    }
    out.push(a);
    if (out.length >= (query.limit ?? 100)) break;
  }
  return out;
}
