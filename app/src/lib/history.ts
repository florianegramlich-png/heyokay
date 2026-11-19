import type { Alert } from './types';

export interface DayGroup { key: string; label: 'today' | 'yesterday' | 'date'; date: Date; alerts: Alert[] }

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Past alerts by local day, newest day first, for the history list ("Today", "Yesterday", "Mon 17 Nov"). */
export function groupByDay(alerts: Alert[], now = new Date()): DayGroup[] {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: DayGroup[] = [];
  for (const a of alerts) {
    const d = new Date(a.createdAt);
    const key = dayKey(d);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, label: key === today ? 'today' : key === yesterday ? 'yesterday' : 'date', date: d, alerts: [] };
      groups.push(g);
    }
    g.alerts.push(a);
  }
  return groups.sort((a, b) => b.date.getTime() - a.date.getTime());
}
