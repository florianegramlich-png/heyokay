import type { Category, Severity } from '../types.js';

/**
 * Recommended actions come from this fixed library (modelled on BBK / DWD public guidance),
 * never from free generation. Reviewed by a human before launch.
 */
const LIBRARY: Record<Category, { low: string; high: string }> = {
  weather: {
    low: 'Lose Gegenstände sichern, Aufenthalt im Freien begrenzen.',
    high: 'Gebäude aufsuchen, Fenster schließen, Bäume und Gerüste meiden.',
  },
  crime: {
    low: 'Bereich meiden und Hinweise der Polizei beachten.',
    high: 'Bereich meiden, Anweisungen der Polizei folgen. Notruf 110.',
  },
  transit: {
    low: 'Mehr Zeit einplanen oder Alternative prüfen.',
    high: 'Alternative Verbindung wählen, Bereich meiden.',
  },
  public_safety: {
    low: 'Bereich meiden und Hinweise der Behörden beachten.',
    high: 'Bereich meiden, Fenster und Türen schließen. Anweisungen der Einsatzkräfte folgen.',
  },
  health: {
    low: 'Hinweise des Gesundheitsamts beachten.',
    high: 'Hinweise des Gesundheitsamts sofort befolgen. Bei Beschwerden 116 117, im Notfall 112.',
  },
  infrastructure: {
    low: 'Mit Einschränkungen rechnen.',
    high: 'Bereich meiden. Bei Gasgeruch Gebäude verlassen und 112 anrufen.',
  },
};

export function recommendedAction(category: Category, severity: Severity): string {
  return severity >= 4 ? LIBRARY[category].high : LIBRARY[category].low;
}

export const CATEGORY_LABEL_DE: Record<Category, string> = {
  weather: 'Wetter', crime: 'Polizei', transit: 'Verkehr', public_safety: 'Sicherheit',
  health: 'Gesundheit', infrastructure: 'Infrastruktur',
};
