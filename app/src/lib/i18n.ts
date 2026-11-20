import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import type { Category, Severity } from './types';
import { TA, TA_CATEGORY, TA_SEVERITY } from './i18n-ta';

/**
 * UI language (PRD 6.1 #5, 8.1). German first; English for US testing and later markets.
 * The choice lives on the device and is mirrored to the server in prefs.language.
 * Alert texts themselves come from the server in the language of their source.
 */
export type Lang = 'de' | 'en' | 'ta';

/**
 * Languages offered in the picker, each named in its own language. Order = order in the dropdown.
 * Adding one (e.g. Hindi) = an entry here + its strings below + server support for alert texts.
 */
export const LANGUAGES: { code: Lang; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ta', name: 'தமிழ்' },
];

/** English unless the person picks another language (Flori, 2026-11-18: English default for now). */
export const DEFAULT_LANG: Lang = 'en';

const isLang = (v: unknown): v is Lang => LANGUAGES.some((l) => l.code === v);

const de = {
  // Navigation
  'nav.alert': 'Warnung',
  'nav.settings': 'Einstellungen',
  'nav.history': 'Verlauf',
  'feed.history': 'Frühere Hinweise durchsuchen',
  'history.search': 'Suchen, z. B. S-Bahn, Straße, Ort',
  'history.all': 'Alle',
  'history.today': 'Heute',
  'history.yesterday': 'Gestern',
  'history.none': 'Nichts gefunden.',
  'history.empty': 'Noch keine früheren Hinweise.',
  'history.offline': 'Der Verlauf braucht eine Verbindung. Später erneut versuchen.',

  // Onboarding
  'onb.value.title': 'Weniger Alarm. Mehr Bescheid wissen.',
  'onb.value.text': 'Hey-Okay sagt dir in einem Satz, was in deiner Nähe los ist – Unwetter, Polizeilagen, Sperrungen – und was du tun kannst. Nur wenn es dich betrifft.',
  'onb.value.cta': 'Los geht’s',
  'onb.location.title': 'Wo bist du?',
  'onb.location.text': 'Wir brauchen deinen Standort, um nur Lagen in deiner Nähe zu melden. Wir speichern ausschließlich deinen letzten Standort – keinen Bewegungsverlauf.',
  'onb.location.cta': 'Standort erlauben',
  'onb.later': 'Später',
  'onb.always.title': 'Auch wenn die App zu ist?',
  'onb.always.text': 'Mit „Immer erlauben“ warnen wir dich auch unterwegs, ohne dass du die App öffnest. Ohne bekommst du Warnungen nur für deine gespeicherten Orte.',
  'onb.always.cta': 'Immer erlauben',
  'onb.always.skip': 'Nur beim Öffnen',
  'onb.notif.title': 'Benachrichtigungen',
  'onb.notif.text': 'Höchstens 3 pro Tag, nachts still – außer bei amtlichen Extremwarnungen. Du kannst das jederzeit ändern.',
  'onb.notif.cta': 'Benachrichtigungen erlauben',
  'onb.notif.skip': 'Nur im Feed anzeigen',
  'onb.cat.title': 'Was ist dir wichtig?',
  'onb.cat.text': 'Wähle, worüber du informiert werden willst.',
  'onb.cat.always': 'Amtliche Extremwarnungen bekommst du immer.',
  'onb.next': 'Weiter',
  'onb.consent.title': 'Deine Daten',
  'onb.consent.text': 'Wir verarbeiten deinen letzten Standort und deine Einstellungen, nur um dich zu warnen. Kein Verlauf, kein Konto, keine Werbung. Die KI sieht nie deine Daten – nur öffentliche Meldungen. Du kannst alles jederzeit in den Einstellungen löschen.',
  'onb.consent.policy': 'Datenschutzerklärung lesen',
  'feed.offline': 'Keine Verbindung. Stand: {time}.',
  'feed.ahead': 'Demnächst',
  'feed.ahead.from': 'ab {time}',
  'acc.title': 'Konto',
  'acc.intro': 'Melde dich mit deiner E-Mail an, damit deine Orte und Einstellungen auch auf einem neuen Handy oder im Browser da sind. Ohne Anmeldung funktioniert alles wie bisher.',
  'acc.email': 'E-Mail-Adresse',
  'acc.send': 'Code senden',
  'acc.sent': 'Wir haben dir einen 6-stelligen Code an {email} geschickt. Er gilt 15 Minuten.',
  'acc.code': 'Code',
  'acc.verify': 'Anmelden',
  'acc.back': 'Andere E-Mail',
  'acc.signedIn': 'Angemeldet als {email}',
  'acc.signedInHint': 'Deine Orte und Einstellungen sind gesichert. Auf einem neuen Gerät meldest du dich einfach mit derselben E-Mail an.',
  'acc.signOut': 'Abmelden',
  'acc.signOut.confirm': 'Auf diesem Gerät abmelden? Dein Konto und deine Orte bleiben erhalten.',
  'acc.err.invalidEmail': 'Bitte eine gültige E-Mail-Adresse eingeben.',
  'acc.err.code': 'Der Code passt nicht oder ist abgelaufen. Bitte noch einmal versuchen.',
  'acc.err.rate': 'Zu viele Codes angefordert. Bitte in einer Stunde noch einmal versuchen.',
  'acc.err.unavailable': 'Anmelden per E-Mail ist noch nicht verfügbar.',
  'acc.err.generic': 'Das hat nicht geklappt. Bitte später noch einmal versuchen.',
  'consent.insights.label': 'Sicherheits-Einblicke unterstützen',
  'consent.insights.hint': 'Freiwillig: Deine Daten dürfen zusammengefasst und anonym helfen, Gefahren besser zu verstehen (z. B. für Städte oder Versicherer). Nie einzeln, nie mit Namen. Derzeit wird nichts weitergegeben. Jederzeit änderbar.',
  'onb.consent.busy': 'Einen Moment…',
  'onb.consent.cta': 'Zustimmen und starten',
  'onb.error': 'Verbindung zum Server fehlgeschlagen. Bitte später erneut versuchen.',

  // Feed
  'feed.header': 'Letzte 7 Tage in deiner Nähe',
  'feed.now': 'In deiner Nähe',
  'feed.now.subtitle': 'Was gerade dich und deine Orte betrifft.',
  'feed.count': '{n} aktuell',
  'feed.earlier': 'Vorher',
  'feed.empty.title': 'Alles okay.',
  'feed.empty.text': 'Gerade gibt es nichts, das dich betrifft. Wir melden uns, wenn sich das ändert.',
  'feed.error.title': 'Hm.',
  'feed.error.text': 'Keine Verbindung. Zieh nach unten, um es erneut zu versuchen.',
  'feed.noLocation': 'Standort ist aus – wir warnen nur für gespeicherte Orte.',
  'feed.noLocation.cta': 'Standort einschalten',

  // Alert card + detail
  'alert.official': 'Amtlich',
  'alert.aiWritten': 'KI-formuliert',
  'alert.gone': 'Diese Warnung ist nicht mehr verfügbar.',
  'alert.until': 'bis {time}',
  'alert.affects': 'betrifft „{place}“',
  'alert.whatToDo': 'Was du tun kannst',
  'alert.summary': 'Zusammenfassung',
  'alert.sources': 'Quellen',
  'alert.aiNote': 'Text von KI formuliert und gegen die Quellen geprüft. Maßgeblich sind die Originalmeldungen.',
  'alert.relevant': 'War das relevant für dich?',
  'alert.yes': '👍 Ja',
  'alert.no': '👎 Nein',
  'alert.thanks': 'Danke – wir passen künftige Warnungen an.',
  'alert.kind.update': 'Aktualisiert',
  'alert.kind.allClear': 'Entwarnung',
  'alert.ended': 'Beendet',
  'alert.endedNote': 'Diese Lage ist vorbei.',

  // Settings
  'set.loading': 'Lädt…',
  'set.language': 'Sprache',
  'set.topics': 'Worüber informieren',
  'set.notifications': 'Benachrichtigungen',
  'set.quiet': 'Nachtruhe 22–7 Uhr',
  'set.quiet.hint': 'Nur amtliche Extremwarnungen kommen durch',
  'set.limit': 'Höchstens pro Tag',
  'set.limit.hint': 'Hohe und extreme Warnungen zählen nicht zum Limit.',
  'set.services': 'Technik: welche Dienste',
  'set.services.hint': 'Störungen nur zu den Diensten, die du nutzt. Neue Dienste sind bei „Alle“ automatisch dabei.',
  'set.services.all': 'Alle',
  'set.digest': 'Tagesüberblick',
  'set.digest.hint': 'Eine Nachricht mit allem, was keine eigene bekommen hat. Wichtige Warnungen kommen immer sofort.',
  'set.digest.time': 'Uhrzeit',
  'set.location': 'Standort',
  'set.location.always': 'Immer erlaubt – Warnungen auch unterwegs.',
  'set.location.foreground': 'Nur beim Öffnen. Unterwegs warnen wir nur für gespeicherte Orte.',
  'set.location.denied': 'Nicht erlaubt. Wir warnen nur für gespeicherte Orte.',
  'set.location.change': 'In den Systemeinstellungen ändern',
  'set.places': 'Gespeicherte Orte',
  'set.places.remove': 'Entfernen',
  'set.places.name': 'Name, z. B. Kita',
  'set.places.address': 'Adresse',
  'set.places.add': 'Ort hinzufügen',
  'set.places.notFound': 'Adresse nicht gefunden.',
  'set.places.saveFailed': 'Konnte den Ort nicht speichern (max. 10 Orte).',
  'set.privacy': 'Datenschutz',
  'set.privacy.text': 'Wir speichern nur deinen letzten Standort, deine Orte und Einstellungen. Kein Verlauf.',
  'set.crash': 'Absturzberichte senden',
  'set.crash.hint': 'Hilft uns, Fehler zu finden. Ohne Standort, ohne Konto, ohne Inhalte deiner Warnungen.',
  'set.delete': 'Alle Daten löschen',
  'set.delete.title': 'Alle Daten löschen?',
  'set.delete.text': 'Dein Konto, Standort, Orte und Warnungen werden sofort und endgültig gelöscht.',
  'set.delete.cancel': 'Abbrechen',
  'set.delete.confirm': 'Löschen',

  // Error screen
  'err.title': 'Hier hat etwas nicht geklappt.',
  'err.text': 'Das liegt an der App, nicht an dir. Versuch es bitte gleich noch einmal.',
  'err.retry': 'Nochmal versuchen',

  // Time
  'time.now': 'gerade eben',
  'time.min': 'vor {n} Min.',
  'time.h': 'vor {n} Std.',

  // Notification buttons
  'notif.relevant': '👍 Relevant',
  'notif.notRelevant': '👎 Nicht relevant',

  // Android notification channels
  'channel.alerts': 'Warnungen',
  'channel.urgent': 'Dringende Warnungen',

  // Android background-location notification
  'fgs.title': 'Hey-Okay ist aktiv',
  'fgs.body': 'Warnungen für deine Umgebung',
  'dash.title': 'Überblick',
  'dash.status.calm': 'Alles okay',
  'dash.status.info': 'Gut zu wissen',
  'dash.status.watch': 'Behalte es im Blick',
  'dash.status.act': 'Pass auf dich auf',
  'dash.status.calmText': 'Gerade betrifft dich und deine Orte nichts.',
  'dash.status.text': '{n} aktuell in deiner Nähe · höchste Stufe: {level}',
  'dash.topics': 'Deine Themen',
  'dash.quiet': 'Ruhig',
  'dash.active': '{n} aktuell',
  'dash.next24': 'Nächste 24 Stunden',
  'dash.next24.none': 'Nichts angekündigt.',
  'dash.next24.count': '{n} angekündigt',
  'dash.nowMark': 'Jetzt',
  'dash.meter': 'Höchste Warnstufe',
};

export type Key = keyof typeof de;

const en: Record<Key, string> = {
  'nav.alert': 'Alert',
  'nav.settings': 'Settings',
  'nav.history': 'History',
  'feed.history': 'Search past alerts',
  'history.search': 'Search, e.g. a train line, street or place',
  'history.all': 'All',
  'history.today': 'Today',
  'history.yesterday': 'Yesterday',
  'history.none': 'Nothing found.',
  'history.empty': 'No past alerts yet.',
  'history.offline': 'History needs a connection. Try again later.',

  'onb.value.title': 'Less alarm. More in the know.',
  'onb.value.text': 'Hey-Okay tells you in one sentence what’s happening near you – severe weather, police activity, closures – and what you can do. Only when it affects you.',
  'onb.value.cta': 'Get started',
  'onb.location.title': 'Where are you?',
  'onb.location.text': 'We need your location so we only tell you about things near you. We only keep your latest location – never a history of where you’ve been.',
  'onb.location.cta': 'Allow location',
  'onb.later': 'Later',
  'onb.always.title': 'Even when the app is closed?',
  'onb.always.text': 'With “Always allow” we can warn you on the go without opening the app. Without it, you only get alerts for your saved places.',
  'onb.always.cta': 'Always allow',
  'onb.always.skip': 'Only while using the app',
  'onb.notif.title': 'Notifications',
  'onb.notif.text': 'At most 3 a day, quiet at night – except for extreme official warnings. You can change this any time.',
  'onb.notif.cta': 'Allow notifications',
  'onb.notif.skip': 'Only show in the feed',
  'onb.cat.title': 'What matters to you?',
  'onb.cat.text': 'Choose what you want to hear about.',
  'onb.cat.always': 'You always get extreme official warnings.',
  'onb.next': 'Next',
  'onb.consent.title': 'Your data',
  'onb.consent.text': 'We process your latest location and your settings only to warn you. No history, no account, no ads. The AI never sees your data – only public reports. You can delete everything in Settings at any time.',
  'onb.consent.policy': 'Read the privacy policy',
  'feed.offline': 'No connection. As of {time}.',
  'feed.ahead': 'Coming up',
  'feed.ahead.from': 'from {time}',
  'acc.title': 'Account',
  'acc.intro': 'Sign in with your email to keep your places and settings on a new phone or in the browser. Everything works as before without signing in.',
  'acc.email': 'Email address',
  'acc.send': 'Send code',
  'acc.sent': 'We sent a 6-digit code to {email}. It is valid for 15 minutes.',
  'acc.code': 'Code',
  'acc.verify': 'Sign in',
  'acc.back': 'Use another email',
  'acc.signedIn': 'Signed in as {email}',
  'acc.signedInHint': 'Your places and settings are saved. On a new device, just sign in with the same email.',
  'acc.signOut': 'Sign out',
  'acc.signOut.confirm': 'Sign out on this device? Your account and places stay.',
  'acc.err.invalidEmail': 'Please enter a valid email address.',
  'acc.err.code': "That code didn't work or has expired. Please try again.",
  'acc.err.rate': 'Too many codes requested. Please try again in an hour.',
  'acc.err.unavailable': 'Signing in by email is not available yet.',
  'acc.err.generic': "That didn't work. Please try again later.",
  'consent.insights.label': 'Support safety insights',
  'consent.insights.hint': 'Optional: your data may help, combined and anonymous, to understand risks better (e.g. for cities or insurers). Never individually, never with your name. Nothing is shared yet. Change it any time.',
  'onb.consent.busy': 'One moment…',
  'onb.consent.cta': 'Agree and start',
  'onb.error': 'Couldn’t reach the server. Please try again later.',

  'feed.header': 'Last 7 days near you',
  'feed.now': 'Near you',
  'feed.now.subtitle': 'What affects you and your places right now.',
  'feed.count': '{n} current',
  'feed.earlier': 'Earlier',
  'feed.empty.title': 'All okay.',
  'feed.empty.text': 'Nothing affects you right now. We’ll let you know if that changes.',
  'feed.error.title': 'Hm.',
  'feed.error.text': 'No connection. Pull down to try again.',
  'feed.noLocation': 'Location is off – we only warn you about saved places.',
  'feed.noLocation.cta': 'Turn on location',

  'alert.official': 'Official',
  'alert.aiWritten': 'AI-written',
  'alert.gone': 'This alert is no longer available.',
  'alert.until': 'until {time}',
  'alert.affects': 'affects “{place}”',
  'alert.whatToDo': 'What you can do',
  'alert.summary': 'Summary',
  'alert.sources': 'Sources',
  'alert.aiNote': 'Written by AI and checked against the sources. The original reports are authoritative.',
  'alert.relevant': 'Was this relevant to you?',
  'alert.yes': '👍 Yes',
  'alert.no': '👎 No',
  'alert.thanks': 'Thanks – we’ll tune future alerts.',
  'alert.kind.update': 'Update',
  'alert.kind.allClear': 'All clear',
  'alert.ended': 'Ended',
  'alert.endedNote': 'This is over.',

  'set.loading': 'Loading…',
  'set.language': 'Language',
  'set.topics': 'What to tell you about',
  'set.notifications': 'Notifications',
  'set.quiet': 'Quiet hours 10 pm–7 am',
  'set.quiet.hint': 'Only extreme official warnings come through',
  'set.limit': 'At most per day',
  'set.limit.hint': 'Severe and extreme alerts don’t count toward the limit.',
  'set.services': 'Tech outages: which services',
  'set.services.hint': 'Outages only for the services you use. With “All”, new services are included automatically.',
  'set.services.all': 'All',
  'set.digest': 'Daily summary',
  'set.digest.hint': 'One message with everything that didn’t get its own. Important warnings always come right away.',
  'set.digest.time': 'Time',
  'set.location': 'Location',
  'set.location.always': 'Always allowed – alerts on the go too.',
  'set.location.foreground': 'Only while using the app. On the go we only warn you about saved places.',
  'set.location.denied': 'Not allowed. We only warn you about saved places.',
  'set.location.change': 'Change in Settings',
  'set.places': 'Saved places',
  'set.places.remove': 'Remove',
  'set.places.name': 'Name, e.g. School',
  'set.places.address': 'Address',
  'set.places.add': 'Add place',
  'set.places.notFound': 'Address not found.',
  'set.places.saveFailed': 'Couldn’t save the place (max. 10 places).',
  'set.privacy': 'Privacy',
  'set.privacy.text': 'We only keep your latest location, your places and settings. No history.',
  'set.crash': 'Send crash reports',
  'set.crash.hint': 'Helps us find bugs. No location, no account, no alert contents.',
  'set.delete': 'Delete all data',
  'set.delete.title': 'Delete all data?',
  'set.delete.text': 'Your account, location, places and alerts are deleted immediately and permanently.',
  'set.delete.cancel': 'Cancel',
  'set.delete.confirm': 'Delete',

  'err.title': 'Something went wrong here.',
  'err.text': 'It’s the app, not you. Please try again in a moment.',
  'err.retry': 'Try again',

  'time.now': 'just now',
  'time.min': '{n} min ago',
  'time.h': '{n} h ago',

  'notif.relevant': '👍 Relevant',
  'notif.notRelevant': '👎 Not relevant',
  'channel.alerts': 'Alerts',
  'channel.urgent': 'Urgent alerts',

  'fgs.title': 'Hey-Okay is on',
  'fgs.body': 'Alerts for where you are',
  'dash.title': 'Overview',
  'dash.status.calm': 'All okay',
  'dash.status.info': 'Good to know',
  'dash.status.watch': 'Keep an eye out',
  'dash.status.act': 'Take care',
  'dash.status.calmText': 'Nothing affects you or your places right now.',
  'dash.status.text': '{n} current near you · highest: {level}',
  'dash.topics': 'Your topics',
  'dash.quiet': 'Quiet',
  'dash.active': '{n} current',
  'dash.next24': 'Next 24 hours',
  'dash.next24.none': 'Nothing expected.',
  'dash.next24.count': '{n} expected',
  'dash.nowMark': 'Now',
  'dash.meter': 'Highest alert level',
};

const ta: Record<Key, string> = TA;
const STRINGS: Record<Lang, Record<Key, string>> = { de, en, ta };

const CATEGORY: Record<Lang, Record<Category, { label: string; hint: string }>> = {
  de: {
    weather: { label: 'Unwetter', hint: 'Sturm, Gewitter, Hitze, Hochwasser' },
    crime: { label: 'Polizeilage', hint: 'Polizeieinsätze und Sperrungen in deiner Nähe' },
    transit: { label: 'ÖPNV-Störung', hint: 'Ausfälle und Sperrungen bei S-/U-Bahn' },
    public_safety: { label: 'Gefahrenlage', hint: 'Brände, Bombenfunde, Gefahrstoffe' },
    health: { label: 'Gesundheit', hint: 'Trinkwasser, Luftqualität' },
    infrastructure: { label: 'Infrastruktur', hint: 'Strom-, Wasser- und Netzausfälle' },
    technology: { label: 'Technik', hint: 'Ausfälle von Diensten wie Kartenzahlung, Apps und Internet' },
  },
  en: {
    weather: { label: 'Severe weather', hint: 'Storms, wind, heat, floods' },
    crime: { label: 'Police activity', hint: 'Police operations and closures near you' },
    transit: { label: 'Transit disruption', hint: 'Train, subway and bus disruptions' },
    public_safety: { label: 'Hazard', hint: 'Fires, evacuations, hazardous materials' },
    health: { label: 'Health', hint: 'Drinking water, air quality' },
    infrastructure: { label: 'Utilities', hint: 'Power, water and network outages' },
    technology: { label: 'Tech outages', hint: 'Outages of services like card payments, apps and the internet' },
  },
  ta: TA_CATEGORY,
};

const SEVERITY: Record<Lang, Record<Severity, string>> = {
  de: { 1: 'Info', 2: 'Gering', 3: 'Mittel', 4: 'Hoch', 5: 'Extrem' },
  en: { 1: 'Info', 2: 'Minor', 3: 'Moderate', 4: 'Severe', 5: 'Extreme' },
  ta: TA_SEVERITY,
};

export const LOCALE: Record<Lang, string> = { de: 'de-DE', en: 'en-US', ta: 'ta-IN' };

// ── Current language: a tiny store so every screen re-renders when it changes ──
const KEY = 'heyokay.language';
let current: Lang = deviceLanguage();
const listeners = new Set<() => void>();

/** The starting language before any choice: English for now, whatever the device language. */
export function deviceLanguage(): Lang {
  return DEFAULT_LANG;
}

export function getLanguage(): Lang {
  return current;
}

export async function setLanguage(lang: Lang) {
  if (lang === current) return;
  current = lang;
  listeners.forEach((l) => l());
  await AsyncStorage.setItem(KEY, lang).catch(() => null);
}

/** Call once at startup: restores the stored choice. */
export async function loadLanguage() {
  const stored = await AsyncStorage.getItem(KEY).catch(() => null);
  if (isLang(stored)) await setLanguage(stored);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  let s = STRINGS[lang][key] ?? STRINGS.en[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

/** `const { t, lang } = useI18n();` — re-renders on language change. */
export function useI18n() {
  const lang = useSyncExternalStore(subscribe, getLanguage, getLanguage);
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

export function timeAgo(lang: Lang, iso: string, now = Date.now()) {
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 1) return translate(lang, 'time.now');
  if (min < 60) return translate(lang, 'time.min', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return translate(lang, 'time.h', { n: h });
  return new Date(iso).toLocaleDateString(LOCALE[lang], { day: 'numeric', month: 'short' });
}
