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

// Severity labels and timeAgo live in lib/i18n.ts (German + English).
