/**
 * Product analytics, part 2 (PRD 13): app events behind a provider abstraction.
 *
 * Same file in app/src/lib/analytics.ts and web/lib/analytics.ts; the names must match
 * server/src/app-events.ts (a server test checks all three).
 *
 * Today there is one provider, Hey-Okay's own server: it gets only the event name and the
 * platform and keeps a count per day. No user id, device id, location or time of day, nothing
 * stored on the device. A third-party provider (Decision 9: Mixpanel, Amplitude, Firebase,
 * Matomo, PostHog EU) would be another `AnalyticsProvider` here, and one that identifies people
 * may only be added behind a consent switch.
 */
export const APP_EVENTS = [
  'onb_value', 'onb_location', 'onb_always', 'onb_notifications', 'onb_categories', 'onb_consent', 'onb_done',
  'perm_location_granted', 'perm_location_denied', 'perm_location_later',
  'perm_background_granted', 'perm_background_denied', 'perm_background_later',
  'perm_push_granted', 'perm_push_denied', 'perm_push_later',
  'push_turned_off', 'push_turned_on',
] as const;
export type AppEvent = (typeof APP_EVENTS)[number];
export type Platform = 'ios' | 'android' | 'web';

export interface AnalyticsProvider {
  name: string;
  track(event: AppEvent): void;
  /** Sends what is waiting (e.g. before the screen changes). */
  flush(): Promise<void>;
}

export type SendEvents = (body: { platform: Platform; events: { name: AppEvent }[] }) => Promise<unknown>;

/** The server takes at most 20 events per request. */
export const BATCH = 20;
/** Events waiting while offline are dropped beyond this: the counts are best-effort. */
export const MAX_QUEUE = 100;

/**
 * Hey-Okay's own server (`POST /v1/events`): events are collected for `delayMs` and sent in
 * batches. A failed send is dropped, never retried, so analytics can't slow the app down.
 */
export function heyOkayProvider(platform: Platform, send: SendEvents, opts: { delayMs?: number } = {}): AnalyticsProvider {
  const delayMs = opts.delayMs ?? 3000;
  let queue: AppEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    while (queue.length) {
      const batch = queue.slice(0, BATCH);
      queue = queue.slice(BATCH);
      await send({ platform, events: batch.map((name) => ({ name })) }).catch(() => undefined);
    }
  };
  return {
    name: 'heyokay',
    track(event) {
      if (queue.length >= MAX_QUEUE) return;
      queue.push(event);
      if (!timer && delayMs > 0) timer = setTimeout(() => { timer = null; void flush(); }, delayMs);
    },
    flush,
  };
}

/** Fans each event out to every provider; a provider that throws never breaks the app. */
export function createAnalytics(providers: AnalyticsProvider[]) {
  const known = new Set<string>(APP_EVENTS);
  const analytics = {
    track(event: AppEvent) {
      if (!known.has(event)) return;
      for (const p of providers) { try { p.track(event); } catch { /* ignore */ } }
    },
    async flush() {
      await Promise.all(providers.map((p) => p.flush().catch(() => undefined)));
    },
    /** The answer to a permission question as an event name. */
    permission(kind: 'location' | 'background' | 'push', answer: boolean | 'later') {
      analytics.track(`perm_${kind}_${answer === 'later' ? 'later' : answer ? 'granted' : 'denied'}` as AppEvent);
    },
  };
  return analytics;
}
export type Analytics = ReturnType<typeof createAnalytics>;

/**
 * Notifications switched off (or on again) in the phone's settings since the last check.
 * `before` is what the app saw last time (null on the very first check: nothing to report).
 */
export function pushChange(before: boolean | null, now: boolean): AppEvent | null {
  if (before === null || before === now) return null;
  return now ? 'push_turned_on' : 'push_turned_off';
}
