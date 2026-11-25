import type { KpiInputs } from './store.js';

/**
 * Product KPIs and their red lines (PRD 13), from the server's own data: no analytics provider,
 * nothing leaves the server, and only totals are shown.
 *
 * - push opt-in: people with a push token / all people;
 * - D7 retention: of people who installed 7–37 days ago, the share who used the app (feed, alert or
 *   history opened in the foreground) 7 days or more after installing;
 * - open rate: first alerts sent as a push whose detail was opened (push tap or feed tap);
 * - rated relevant and beyond-NINA, as on the desk;
 * - alerts per person per day: first alerts (push or feed) per person who got any, per day;
 * - false alert rate: first alerts of events retracted at the desk as a false alert;
 * - event to push: source published → push queued, median and 90th percentile.
 */
export interface Kpi {
  key: string;
  label: string;
  value: number | null;
  unit: 'rate' | 'per_day' | 'seconds';
  /** The PRD's red line and which side of it is bad. */
  redLine?: { value: number; bad: 'below' | 'above' };
  /** How many things the value is based on. */
  basedOn: number;
  red: boolean;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const quantile = (xs: number[], f: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)];
};

export function computeKpis(input: KpiInputs, opts: { sinceIso: string; now: Date; falseAlertEvents: Set<string> }): Kpi[] {
  const now = opts.now.getTime();
  const days = Math.max(1, (now - Date.parse(opts.sinceIso)) / 86_400_000);
  const first = input.alerts.filter((a) => a.kind === 'new' && a.delivery !== 'suppressed');
  const pushed = first.filter((a) => a.delivery === 'push');
  const rated = first.filter((a) => a.feedback);
  const relevant = rated.filter((a) => a.feedback === 'relevant');
  const DAY = 86_400_000;
  const cohort = input.users.filter((u) => { const age = now - Date.parse(u.createdAt); return age >= 7 * DAY && age <= 37 * DAY; });
  const retained = cohort.filter((u) => u.lastSeenAt && Date.parse(u.lastSeenAt) - Date.parse(u.createdAt) >= 7 * DAY);
  const latency = pushed
    .filter((a) => a.eventStartsAt)
    .map((a) => (Date.parse(a.createdAt) - Date.parse(a.eventStartsAt!)) / 1000)
    .filter((s) => s >= 0);
  const recipients = new Set(first.map((a) => a.userId)).size;

  const kpi = (k: Omit<Kpi, 'red'>): Kpi => ({
    ...k,
    red: !!k.redLine && k.value != null && (k.redLine.bad === 'below' ? k.value < k.redLine.value : k.value > k.redLine.value),
  });
  return [
    kpi({ key: 'pushOptIn', label: 'Push opt-in', unit: 'rate', value: ratio(input.users.filter((u) => u.hasPush).length, input.users.length), redLine: { value: 0.5, bad: 'below' }, basedOn: input.users.length }),
    kpi({ key: 'd7Retention', label: 'D7 retention', unit: 'rate', value: ratio(retained.length, cohort.length), redLine: { value: 0.35, bad: 'below' }, basedOn: cohort.length }),
    kpi({ key: 'openRate', label: 'Alert open rate', unit: 'rate', value: ratio(pushed.filter((a) => a.openedAt).length, pushed.length), redLine: { value: 0.25, bad: 'below' }, basedOn: pushed.length }),
    kpi({ key: 'relevantRate', label: 'Rated relevant', unit: 'rate', value: ratio(relevant.length, rated.length), redLine: { value: 0.85, bad: 'below' }, basedOn: rated.length }),
    kpi({ key: 'beyondNina', label: 'Beyond-NINA', unit: 'rate', value: ratio(relevant.filter((a) => !a.official).length, relevant.length), redLine: { value: 0.6, bad: 'below' }, basedOn: relevant.length }),
    kpi({ key: 'alertsPerUserPerDay', label: 'Alerts per person per day', unit: 'per_day', value: recipients ? first.length / recipients / days : null, redLine: { value: 1.5, bad: 'above' }, basedOn: first.length }),
    kpi({ key: 'falseAlertRate', label: 'False alert rate', unit: 'rate', value: ratio(first.filter((a) => opts.falseAlertEvents.has(a.eventId)).length, first.length), redLine: { value: 0.02, bad: 'above' }, basedOn: first.length }),
    kpi({ key: 'eventToPushP50', label: 'Event → push (median)', unit: 'seconds', value: quantile(latency, 0.5), basedOn: latency.length }),
    kpi({ key: 'eventToPushP90', label: 'Event → push (90th percentile)', unit: 'seconds', value: quantile(latency, 0.9), basedOn: latency.length }),
  ];
}
