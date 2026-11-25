import { z } from 'zod';

/**
 * Product analytics, part 2 (PRD 13): anonymous app events from the phone app and the web.
 *
 * Only a fixed list of names is accepted, and only counts per day, platform and name are kept:
 * no user id, device id, IP address, location or time of day. So the numbers can show where
 * people stop in onboarding and how often a permission is refused, never who did it.
 *
 * The same names are in app/src/lib/analytics.ts and web/lib/analytics.ts (a server test checks).
 */
export const APP_EVENTS = [
  // Onboarding: counted when the screen is shown.
  'onb_value', 'onb_location', 'onb_always', 'onb_notifications', 'onb_categories', 'onb_consent', 'onb_done',
  // Permission answers ("later" = the person skipped the question).
  'perm_location_granted', 'perm_location_denied', 'perm_location_later',
  'perm_background_granted', 'perm_background_denied', 'perm_background_later',
  'perm_push_granted', 'perm_push_denied', 'perm_push_later',
  // Notifications switched off (or on again) in the phone's settings, noticed when the app opens.
  'push_turned_off', 'push_turned_on',
] as const;
export type AppEvent = (typeof APP_EVENTS)[number];

export const PLATFORMS = ['ios', 'android', 'web'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** At most 20 events per request; a client sends a batch every few seconds at most. */
export const AppEventsBody = z.object({
  platform: z.enum(PLATFORMS),
  events: z.array(z.object({ name: z.enum(APP_EVENTS) }).strict()).min(1).max(20),
}).strict();

export interface AppEventCount { day: string; platform: Platform; name: AppEvent; count: number }

/** Counts per name for one request. */
export function countEvents(events: { name: AppEvent }[]): Map<AppEvent, number> {
  const m = new Map<AppEvent, number>();
  for (const e of events) m.set(e.name, (m.get(e.name) ?? 0) + 1);
  return m;
}

/**
 * The onboarding funnel. "Always" is left out: it's only shown after location was allowed.
 * The browser has no notification step.
 */
const FUNNEL: { step: AppEvent; label: string; platforms: readonly Platform[] }[] = [
  { step: 'onb_value', label: 'Welcome', platforms: PLATFORMS },
  { step: 'onb_location', label: 'Location', platforms: PLATFORMS },
  { step: 'onb_notifications', label: 'Notifications', platforms: ['ios', 'android'] },
  { step: 'onb_categories', label: 'Topics', platforms: PLATFORMS },
  { step: 'onb_consent', label: 'Privacy', platforms: PLATFORMS },
  { step: 'onb_done', label: 'Done', platforms: PLATFORMS },
];

const PERMISSIONS: { key: 'location' | 'background' | 'push'; label: string }[] = [
  { key: 'location', label: 'Location' },
  { key: 'background', label: 'Location "always"' },
  { key: 'push', label: 'Notifications' },
];

export interface FunnelStep { step: AppEvent; label: string; count: number; ofPrevious: number | null; ofStart: number | null }
export interface Funnel {
  platform: Platform | 'app';
  steps: FunnelStep[];
}
export interface PermissionRow { key: string; label: string; granted: number; denied: number; later: number; grantedRate: number | null }
export interface FunnelReport {
  funnels: Funnel[];
  permissions: PermissionRow[];
  pushTurnedOff: number;
  pushTurnedOn: number;
  total: number;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** Funnels for the phone app (iOS + Android), each platform, and permission answers. */
export function funnelReport(rows: AppEventCount[]): FunnelReport {
  const sum = (name: AppEvent, platforms: readonly Platform[]) =>
    rows.filter((r) => r.name === name && platforms.includes(r.platform)).reduce((a, r) => a + r.count, 0);
  const funnel = (platform: Funnel['platform'], platforms: readonly Platform[]): Funnel => {
    const steps: FunnelStep[] = [];
    for (const f of FUNNEL) {
      if (!platforms.some((p) => f.platforms.includes(p))) continue;
      const count = sum(f.step, platforms);
      const prev = steps.at(-1);
      steps.push({ step: f.step, label: f.label, count, ofPrevious: prev ? ratio(count, prev.count) : null, ofStart: steps.length ? ratio(count, steps[0].count) : null });
    }
    return { platform, steps };
  };
  const app = ['ios', 'android'] as const;
  return {
    funnels: [funnel('app', app), funnel('ios', ['ios']), funnel('android', ['android']), funnel('web', ['web'])],
    permissions: PERMISSIONS.map(({ key, label }) => {
      const granted = sum(`perm_${key}_granted` as AppEvent, PLATFORMS);
      const denied = sum(`perm_${key}_denied` as AppEvent, PLATFORMS);
      const later = sum(`perm_${key}_later` as AppEvent, PLATFORMS);
      return { key, label, granted, denied, later, grantedRate: ratio(granted, granted + denied + later) };
    }),
    pushTurnedOff: sum('push_turned_off', PLATFORMS),
    pushTurnedOn: sum('push_turned_on', PLATFORMS),
    total: rows.reduce((a, r) => a + r.count, 0),
  };
}
