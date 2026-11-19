import type { Alert, Language, UserPrefs } from '../types.js';

/**
 * Evening summary (PRD 6.1 #7, 6.2 step 7). Ranking already decides send now / feed / suppress;
 * what went to the feed only (information, "coming up", quiet hours, daily limit reached, usually
 * rated not relevant) is bundled into one calm push at the person's chosen time, default 18:00.
 * Severe and official extreme warnings never wait for this: they are pushed when they happen.
 */

/** Sent from the chosen time for this long; after that (worker was down) it waits for tomorrow. */
export const DIGEST_WINDOW_MIN = 180;
/** What a summary looks back on. */
export const DIGEST_LOOKBACK_MS = 24 * 3600_000;
const MAX_TITLE = 50;
const MAX_BODY = 100;

const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

/** The person's local day ("2026-11-19") and minute of the day. */
export function localClock(now: Date, timezone: string): { day: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/** The local day whose summary is due now, or null (off, or not its time). */
export function digestDue(prefs: Pick<UserPrefs, 'digestTime' | 'timezone'>, now: Date): string | null {
  if (!prefs.digestTime) return null;
  let clock;
  try { clock = localClock(now, prefs.timezone); } catch { clock = localClock(now, 'Europe/Berlin'); }
  const start = toMin(prefs.digestTime);
  return clock.minutes >= start && clock.minutes < start + DIGEST_WINDOW_MIN ? clock.day : null;
}

/** Alerts worth a line in the summary: first alerts that went to the feed, newest first, one per event. */
export function digestItems(alerts: Alert[], now: Date, isRunning: (eventId: string) => boolean): Alert[] {
  const since = now.getTime() - DIGEST_LOOKBACK_MS;
  const seen = new Set<string>();
  return alerts
    .filter((a) => a.delivery === 'feed' && (a.kind ?? 'new') === 'new' && Date.parse(a.createdAt) >= since)
    .sort((a, b) => b.severity - a.severity || b.createdAt.localeCompare(a.createdAt))
    .filter((a) => !seen.has(a.eventId) && seen.add(a.eventId) && isRunning(a.eventId));
}

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/**
 * One push for the summary. It carries the most important item's id, so tapping it opens that
 * alert; the feed shows the rest. Always gentle (severity 1): nothing in it is urgent.
 */
export function digestPush(items: Alert[], language: Language): Alert {
  const top = items[0];
  const n = items.length;
  const title = language === 'de'
    ? `Dein Tagesüberblick: ${n === 1 ? '1 Hinweis' : `${n} Hinweise`}`
    : `Your day: ${n === 1 ? '1 update' : `${n} updates`}`;
  return {
    ...top,
    title: cut(title, MAX_TITLE),
    body: cut(items.map((a) => a.title).join(' · '), MAX_BODY),
    severity: 1,
    official: false,
    delivery: 'push',
    reason: 'digest',
  };
}
