'use client';

import { useSyncExternalStore } from 'react';
import { APP_STRINGS, CATEGORY, LOCALE, SEVERITY, type AppKey, type Lang } from './app-strings';
import type { Category, Severity } from './types';

export type { Lang } from './app-strings';

/** Strings only the web app needs. Same tone as the phone app: calm, German first. */
const WEB = {
  de: {
    'web.nav.now': 'Jetzt',
    'web.nav.history': 'Verlauf',
    'web.nav.settings': 'Einstellungen',
    'web.nav.about': 'Über Hey-Okay',
    'web.menu': 'Menü',
    'web.now.title': 'In deiner Nähe',
    'web.now.subtitle': 'Was gerade dich und deine Orte betrifft.',
    'web.now.count': '{n} aktuell',
    'web.now.refresh': 'Aktualisieren',
    'web.now.locate': 'Standort aktualisieren',
    'web.now.locating': 'Standort wird bestimmt…',
    'web.now.locationOff': 'Standort ist aus. Wir zeigen nur, was deine gespeicherten Orte betrifft.',
    'web.now.locationDenied': 'Standort nicht erlaubt. Du kannst ihn in den Browser-Einstellungen erlauben.',
    'web.now.webNote': 'Im Browser gibt es keine Push-Benachrichtigungen. Für Warnungen unterwegs nutze die App.',
    'web.history.title': 'Verlauf',
    'web.history.subtitle': 'Alle Meldungen der letzten Tage, auch beendete.',
    'web.history.empty': 'Noch keine Meldungen.',
    'web.detail.open': 'Details',
    'web.detail.close': 'Schließen',
    'web.detail.source': 'Zur Quelle',
    'web.lang.toggle': 'English',
    'web.about.title': 'Über Hey-Okay',
    'web.about.text': 'Hey-Okay sagt dir ruhig und in einem Satz, was in deiner Nähe los ist und was du tun kannst: Unwetter, Polizeilagen, Sperrungen, Brände. Die Meldungen kommen aus amtlichen Warnsystemen (NINA, DWD), von Polizei und Feuerwehr. Amtliche Warnungen werden nie umformuliert. Andere Meldungen fasst eine KI zusammen und prüft sie gegen die Quellen; Unsicheres sieht vorher ein Mensch.',
    'web.about.privacy': 'Kein Konto, kein Bewegungsverlauf, keine Werbung. Wir speichern nur deinen letzten Standort, deine Orte und Einstellungen. In einer Notlage: 112 (Feuerwehr, Rettung) oder 110 (Polizei).',
    'web.places.geocoding': 'Adresse wird gesucht…',
    'web.places.attribution': 'Adresssuche: © OpenStreetMap-Mitwirkende',
    'web.places.radius': 'Umkreis {m} m',
    'web.onb.locationWeb': 'Dein Browser fragt gleich nach dem Standort. Wir speichern nur den letzten, gerundet auf etwa 100 m.',
    'web.delete.done': 'Alles gelöscht.',
  },
  en: {
    'web.nav.now': 'Now',
    'web.nav.history': 'History',
    'web.nav.settings': 'Settings',
    'web.nav.about': 'About Hey-Okay',
    'web.menu': 'Menu',
    'web.now.title': 'Near you',
    'web.now.subtitle': 'What affects you and your places right now.',
    'web.now.count': '{n} current',
    'web.now.refresh': 'Refresh',
    'web.now.locate': 'Update location',
    'web.now.locating': 'Finding your location…',
    'web.now.locationOff': 'Location is off. We only show what affects your saved places.',
    'web.now.locationDenied': 'Location not allowed. You can allow it in your browser settings.',
    'web.now.webNote': 'The browser gets no push notifications. For alerts on the go, use the app.',
    'web.history.title': 'History',
    'web.history.subtitle': 'Everything from the last few days, including what has ended.',
    'web.history.empty': 'Nothing yet.',
    'web.detail.open': 'Details',
    'web.detail.close': 'Close',
    'web.detail.source': 'Open source',
    'web.lang.toggle': 'Deutsch',
    'web.about.title': 'About Hey-Okay',
    'web.about.text': 'Hey-Okay tells you calmly, in one sentence, what’s happening near you and what you can do: severe weather, police activity, closures, fires. Reports come from official warning systems (NINA, DWD), the police and fire brigades. Official warnings are never reworded. Other reports are summarised by AI and checked against their sources; anything uncertain is seen by a person first.',
    'web.about.privacy': 'No account, no location history, no ads. We only keep your latest location, your places and settings. In an emergency: 112 (fire, ambulance) or 110 (police).',
    'web.places.geocoding': 'Looking up the address…',
    'web.places.attribution': 'Address search: © OpenStreetMap contributors',
    'web.places.radius': '{m} m radius',
    'web.onb.locationWeb': 'Your browser will ask for your location next. We only keep the latest one, rounded to about 100 m.',
    'web.delete.done': 'Everything deleted.',
  },
} as const;

type WebKey = keyof (typeof WEB)['de'];
export type Key = AppKey | WebKey;

const LANG_KEY = 'heyokay.language';
const listeners = new Set<() => void>();
let current: Lang | null = null;

/** German unless the browser prefers English (or another non-German language). */
export function browserLanguage(languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages): Lang {
  const first = (languages[0] ?? 'de').toLowerCase();
  return first.startsWith('de') || languages.length === 0 ? 'de' : 'en';
}

export function getLanguage(): Lang {
  if (current) return current;
  try {
    const stored = typeof window === 'undefined' ? null : window.localStorage.getItem(LANG_KEY);
    current = stored === 'de' || stored === 'en' ? stored : browserLanguage();
  } catch {
    current = browserLanguage();
  }
  return current;
}

export function setLanguage(lang: Lang) {
  current = lang;
  try { window.localStorage.setItem(LANG_KEY, lang); } catch { /* not stored */ }
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  listeners.forEach((l) => l());
}

export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  const dict = (key in WEB.de ? WEB[lang] : APP_STRINGS[lang]) as Record<string, string>;
  const fallback = (key in WEB.de ? WEB.de : APP_STRINGS.de) as Record<string, string>;
  let s = dict[key] ?? fallback[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function timeAgo(lang: Lang, iso: string, now = Date.now()) {
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 1) return translate(lang, 'time.now');
  if (min < 60) return translate(lang, 'time.min', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return translate(lang, 'time.h', { n: h });
  return new Date(iso).toLocaleDateString(LOCALE[lang], { day: 'numeric', month: 'short' });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** `const { t, lang } = useI18n();` — re-renders on language change. German on the server render. */
export function useI18n() {
  const lang = useSyncExternalStore(subscribe, getLanguage, () => 'de' as Lang);
  return {
    lang,
    t: (key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars),
    categoryLabel: (c: Category) => CATEGORY[lang][c].label,
    categoryHint: (c: Category) => CATEGORY[lang][c].hint,
    severityLabel: (s: Severity) => SEVERITY[lang][s],
    timeAgo: (iso: string) => timeAgo(lang, iso),
    locale: LOCALE[lang],
  };
}
