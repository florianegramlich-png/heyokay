import type { Language } from './types.js';

/**
 * Country packs: everything that differs per country, in one place (docs/ARCHITECTURE.md §8,
 * step 4). Adding a country = a pack here + source adapters that tag their items with it.
 *
 * Emergency numbers are what the recommended actions name; they come only from here, never from
 * the model. Sources: official national emergency-number pages (DE: 110/112, 116 117; AT: 133,
 * 112, 1450; CH: 117, 112; US: 911).
 */
export type CountryCode = 'DE' | 'AT' | 'CH' | 'US';

export interface CountryPack {
  code: CountryCode;
  name: Record<Language, string>;
  /** Language official texts arrive in, and the default for alert copy. */
  language: Language;
  numbers: {
    /** General emergency (fire, ambulance). */
    emergency: string;
    police: string;
    /** Non-emergency medical advice line, if the country has one nationwide. */
    medical: string | null;
  };
  units: 'metric' | 'us';
}

export const COUNTRIES: Record<CountryCode, CountryPack> = {
  DE: { code: 'DE', name: { de: 'Deutschland', en: 'Germany' }, language: 'de', numbers: { emergency: '112', police: '110', medical: '116 117' }, units: 'metric' },
  AT: { code: 'AT', name: { de: 'Österreich', en: 'Austria' }, language: 'de', numbers: { emergency: '112', police: '133', medical: '1450' }, units: 'metric' },
  CH: { code: 'CH', name: { de: 'Schweiz', en: 'Switzerland' }, language: 'de', numbers: { emergency: '112', police: '117', medical: null }, units: 'metric' },
  US: { code: 'US', name: { de: 'USA', en: 'United States' }, language: 'en', numbers: { emergency: '911', police: '911', medical: null }, units: 'us' },
};

export function isCountry(code: unknown): code is CountryCode {
  return typeof code === 'string' && code in COUNTRIES;
}

/**
 * The pack for an item or event: its own country tag; otherwise inferred from the language, which
 * is how items and events from before country tags were made (German sources → DE, NWS → US).
 */
export function packFor(x: { country?: string | null; language?: Language | null }): CountryPack {
  if (isCountry(x.country)) return COUNTRIES[x.country];
  return x.language === 'en' ? COUNTRIES.US : COUNTRIES.DE;
}
