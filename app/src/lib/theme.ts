import type { Category, Severity } from './types';

/**
 * Night-sky look, shared with the web app (Flori's v0 design): deep navy, cyan and purple accents.
 * Calm by default; only severe and extreme alerts get warm colours.
 */
export const colors = {
  bg: '#0F1430',
  card: 'rgba(12, 14, 32, 0.72)',
  text: '#F4F4F7',
  muted: '#A3A6BF',
  line: 'rgba(255, 255, 255, 0.10)',
  /** Primary accent (buttons, selected states, links). */
  brand: '#8B5CF6',
  brandSoft: 'rgba(139, 92, 246, 0.16)',
  /** Second accent: what-to-do box, the "Hey-" of the logo. */
  cyan: '#22D3EE',
  cyanSoft: 'rgba(34, 211, 238, 0.12)',
  good: '#34D399',
  danger: '#F87171',
  dangerSoft: 'rgba(248, 113, 113, 0.14)',
  star: ['#06B6D4', '#8B5CF6', '#D946EF'] as const,
};

export const severityColor: Record<Severity, string> = {
  1: '#94A3B8',
  2: '#22D3EE',
  3: '#FBBF24',
  4: '#FB923C',
  5: '#F87171',
};

export const categoryColor: Record<Category, string> = {
  weather: '#38BDF8',
  crime: '#A5B4FC',
  transit: '#22D3EE',
  public_safety: '#FDBA74',
  health: '#34D399',
  infrastructure: '#C4B5FD',
};

// Severity labels and timeAgo live in lib/i18n.ts (German + English).
