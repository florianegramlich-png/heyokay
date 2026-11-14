import type { Severity } from './types';

export const colors = {
  bg: '#F7F7F5',
  card: '#FFFFFF',
  text: '#1C1C1A',
  muted: '#6B6B66',
  line: '#E4E4DF',
  brand: '#0F766E',
  brandSoft: '#E6F2F0',
  danger: '#B42318',
};

/** Calm by default; only severe/extreme get warm colors. */
export const severityColor: Record<Severity, string> = {
  1: '#6B6B66',
  2: '#0F766E',
  3: '#B54708',
  4: '#C4320A',
  5: '#B42318',
};

export const severityLabel: Record<Severity, string> = {
  1: 'Info',
  2: 'Gering',
  3: 'Mittel',
  4: 'Hoch',
  5: 'Extrem',
};

export function timeAgo(iso: string, now = Date.now()) {
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  return new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
}
