import type { Category, Hazard, Language, Severity } from '../types.js';
import { packFor, type CountryPack } from '../countries.js';

/**
 * Recommended actions come from this fixed library (modelled on BBK / DWD public guidance),
 * never from free generation. Reviewed by a human before launch. Phone numbers come from the
 * country pack (countries.ts), so the same advice works in every country we cover.
 */
type Numbers = CountryPack['numbers'];
type Advice = { low: (n: Numbers) => string; high: (n: Numbers) => string };
const t = (s: string) => () => s;

const LIBRARY: Record<Category, Advice> = {
  weather: {
    low: t('Lose Gegenstände sichern, Aufenthalt im Freien begrenzen.'),
    high: t('Gebäude aufsuchen, Fenster schließen, Bäume und Gerüste meiden.'),
  },
  crime: {
    low: t('Bereich meiden und Hinweise der Polizei beachten.'),
    high: (n) => `Bereich meiden, Anweisungen der Polizei folgen. Notruf ${n.police}.`,
  },
  transit: {
    low: t('Mehr Zeit einplanen oder Alternative prüfen.'),
    high: t('Alternative Verbindung wählen, Bereich meiden.'),
  },
  public_safety: {
    low: t('Bereich meiden und Hinweise der Behörden beachten.'),
    high: t('Bereich meiden, Fenster und Türen schließen. Anweisungen der Einsatzkräfte folgen.'),
  },
  health: {
    low: t('Hinweise des Gesundheitsamts beachten.'),
    high: (n) => `Hinweise des Gesundheitsamts sofort befolgen. ${n.medical ? `Bei Beschwerden ${n.medical}, im Notfall ${n.emergency}.` : `Im Notfall ${n.emergency}.`}`,
  },
  technology: {
    low: t('Mit Störungen bei diesem Dienst rechnen. Später erneut versuchen.'),
    high: t('Eine Alternative bereithalten, z. B. Bargeld oder eine andere App. Statusseite des Anbieters beachten.'),
  },
  infrastructure: {
    low: t('Mit Einschränkungen rechnen.'),
    high: (n) => `Bereich meiden. Bei Gasgeruch Gebäude verlassen und ${n.emergency} anrufen.`,
  },
};

const LIBRARY_EN: Record<Category, Advice> = {
  weather: {
    low: t('Secure loose objects and limit time outdoors.'),
    high: t('Stay indoors, away from windows. Avoid trees and travel if you can.'),
  },
  crime: {
    low: t('Avoid the area and follow police instructions.'),
    high: (n) => `Avoid the area and follow police instructions. Emergency: ${n.police}.`,
  },
  transit: {
    low: t('Allow extra time or check another route.'),
    high: t('Choose another route and avoid the area.'),
  },
  public_safety: {
    low: t('Avoid the area and follow official guidance.'),
    high: t('Avoid the area, close windows and doors, and follow emergency crews.'),
  },
  health: {
    low: t('Follow guidance from your local health department.'),
    high: (n) => `Follow health department guidance now. ${n.medical ? `Advice: ${n.medical}. ` : ''}Emergency: ${n.emergency}.`,
  },
  technology: {
    low: t('Expect problems with this service. Try again later.'),
    high: t('Have a backup ready, such as cash or another app. Check the provider\'s status page.'),
  },
  infrastructure: {
    low: t('Expect disruptions.'),
    high: (n) => `Avoid the area. If you smell gas, leave the building and call ${n.emergency}.`,
  },
};

/** Hazard-specific actions, where the category's general advice would be wrong (storm advice for heat). */
const HAZARD: Record<Hazard, Record<Language, Advice>> = {
  earthquake: {
    de: {
      low: t('Mit Nachbeben rechnen. Auf Schäden achten.'),
      high: (n) => `Mit Nachbeben rechnen. Beschädigte Gebäude meiden. Im Notfall ${n.emergency}.`,
    },
    en: {
      low: t('Expect aftershocks. Check for damage.'),
      high: (n) => `Expect aftershocks. Stay out of damaged buildings. Emergency: ${n.emergency}.`,
    },
  },
  air: {
    de: {
      low: t('Anstrengung im Freien reduzieren, Fenster geschlossen halten.'),
      high: t('Möglichst drinnen bleiben und Fenster schließen. Menschen mit Asthma oder Herzerkrankung: eigenen Behandlungsplan beachten.'),
    },
    en: {
      low: t('Limit hard exercise outdoors and keep windows closed.'),
      high: t('Stay indoors where you can and keep windows closed. People with asthma or heart conditions: follow your care plan.'),
    },
  },
  outage: {
    de: {
      low: t('Mit Störungen bei diesem Dienst rechnen. Später erneut versuchen.'),
      high: t('Eine Alternative bereithalten, z. B. Bargeld oder eine andere App. Statusseite des Anbieters beachten.'),
    },
    en: {
      low: t('Expect problems with this service. Try again later.'),
      high: t('Have a backup ready, such as cash or another app. Check the provider\'s status page.'),
    },
  },
  flood: {
    de: {
      low: t('Ufer und Uferwege meiden. Fahrzeuge aus tief liegenden Bereichen holen.'),
      high: (n) => `Ufer meiden, Keller und Tiefgaragen nicht betreten, Hinweise der Behörden beachten. Im Notfall ${n.emergency}.`,
    },
    en: {
      low: t('Keep away from riverbanks and riverside paths. Move cars out of low-lying areas.'),
      high: (n) => `Keep away from riverbanks, stay out of basements and underground car parks, follow official advice. Emergency: ${n.emergency}.`,
    },
  },
  wildfire: {
    de: {
      low: t('Hinweise der örtlichen Feuerwehr beachten. Bei Rauch Fenster schließen.'),
      high: (n) => `Bereit sein, das Gebiet zu verlassen: Wichtiges griffbereit, Anordnungen der Behörden befolgen. Im Notfall ${n.emergency}.`,
    },
    en: {
      low: t('Follow local fire officials. Keep windows closed if there is smoke.'),
      high: (n) => `Be ready to leave: keep essentials at hand and follow evacuation orders from local officials. Emergency: ${n.emergency}.`,
    },
  },
  heat: {
    de: {
      low: t('Viel trinken, Mittagshitze meiden, Räume tagsüber abdunkeln.'),
      high: (n) => `Viel trinken, drinnen bleiben, nach Älteren und Kranken sehen. Bei Hitzschlag ${n.emergency}.`,
    },
    en: {
      low: t('Drink plenty, avoid the midday heat, keep rooms shaded.'),
      high: (n) => `Drink plenty, stay indoors, check on older or sick people. Heat stroke: call ${n.emergency}.`,
    },
  },
};

export function recommendedAction(
  category: Category, severity: Severity, language: Language = 'de', hazard?: Hazard, country: CountryPack = packFor({ language }),
): string {
  const lib = hazard ? HAZARD[hazard][language] : (language === 'en' ? LIBRARY_EN : LIBRARY)[category];
  const high = hazard === 'air' ? severity >= 2 : hazard ? severity >= 3 : severity >= 4;
  return (high ? lib.high : lib.low)(country.numbers);
}

export const CATEGORY_LABEL_DE: Record<Category, string> = {
  weather: 'Wetter', crime: 'Polizei', transit: 'Verkehr', public_safety: 'Sicherheit',
  health: 'Gesundheit', infrastructure: 'Infrastruktur', technology: 'Technik',
};

export const CATEGORY_LABEL_EN: Record<Category, string> = {
  weather: 'Weather', crime: 'Police', transit: 'Transit', public_safety: 'Safety',
  health: 'Health', infrastructure: 'Infrastructure', technology: 'Technology',
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
