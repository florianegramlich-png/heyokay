import type { Category, Hazard, Language, Severity } from '../types.js';

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

/**
 * English library. Today the only English sources are US (NWS), so emergency numbers are US ones.
 * When English is offered in Germany (Phase 2 i18n), key this by country as well.
 */
const LIBRARY_EN: Record<Category, { low: string; high: string }> = {
  weather: {
    low: 'Secure loose objects and limit time outdoors.',
    high: 'Stay indoors, away from windows. Avoid trees and travel if you can.',
  },
  crime: {
    low: 'Avoid the area and follow police instructions.',
    high: 'Avoid the area and follow police instructions. Emergency: 911.',
  },
  transit: {
    low: 'Allow extra time or check another route.',
    high: 'Choose another route and avoid the area.',
  },
  public_safety: {
    low: 'Avoid the area and follow official guidance.',
    high: 'Avoid the area, close windows and doors, and follow emergency crews.',
  },
  health: {
    low: 'Follow guidance from your local health department.',
    high: 'Follow health department guidance now. Emergency: 911.',
  },
  infrastructure: {
    low: 'Expect disruptions.',
    high: 'Avoid the area. If you smell gas, leave the building and call 911.',
  },
};

/** Hazard-specific actions, where the category's general advice would be wrong (storm advice for heat). */
const HAZARD: Record<Hazard, Record<Language, { low: string; high: string }>> = {
  heat: {
    de: {
      low: 'Viel trinken, Mittagshitze meiden, Räume tagsüber abdunkeln.',
      high: 'Viel trinken, drinnen bleiben, nach Älteren und Kranken sehen. Bei Hitzschlag 112.',
    },
    en: {
      low: 'Drink plenty, avoid the midday heat, keep rooms shaded.',
      high: 'Drink plenty, stay indoors, check on older or sick people. Heat stroke: call 911.',
    },
  },
};

export function recommendedAction(category: Category, severity: Severity, language: Language = 'de', hazard?: Hazard): string {
  const lib = hazard ? HAZARD[hazard][language] : (language === 'en' ? LIBRARY_EN : LIBRARY)[category];
  return severity >= 3 && hazard ? lib.high : severity >= 4 ? lib.high : lib.low;
}

export const CATEGORY_LABEL_DE: Record<Category, string> = {
  weather: 'Wetter', crime: 'Polizei', transit: 'Verkehr', public_safety: 'Sicherheit',
  health: 'Gesundheit', infrastructure: 'Infrastruktur',
};

export const CATEGORY_LABEL_EN: Record<Category, string> = {
  weather: 'Weather', crime: 'Police', transit: 'Transit', public_safety: 'Safety',
  health: 'Health', infrastructure: 'Infrastructure',
};

/** Wording for update and all-clear alerts (PRD 5.4). Calm, no alarm words. */
export const LIFECYCLE: Record<'de' | 'en', { updatePrefix: string; allClearPrefix: string; allClearBody: string; allClearAction: string }> = {
  de: {
    updatePrefix: 'Aktualisiert',
    allClearPrefix: 'Entwarnung',
    allClearBody: 'Die Warnung ist aufgehoben.',
    allClearAction: 'Keine Maßnahmen mehr nötig.',
  },
  en: {
    updatePrefix: 'Update',
    allClearPrefix: 'All clear',
    allClearBody: 'The warning has been lifted.',
    allClearAction: 'No further action needed.',
  },
};
