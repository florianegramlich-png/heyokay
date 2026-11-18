import type { Category, Severity } from './types';

/**
 * UI strings, German first. The dictionaries are copied from the Expo app (app/src/lib/i18n.ts)
 * so both apps say the same things; web-only strings live in WEB below.
 */
export type Lang = 'de' | 'en';

const de = {
  // Navigation
  'nav.alert': 'Warnung',
  'nav.settings': 'Einstellungen',

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
  'onb.consent.busy': 'Einen Moment…',
  'onb.consent.cta': 'Zustimmen und starten',
  'onb.error': 'Verbindung zum Server fehlgeschlagen. Bitte später erneut versuchen.',

  // Feed
  'feed.header': 'Letzte 7 Tage in deiner Nähe',
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

  // Android notification channels
  'channel.alerts': 'Warnungen',
  'channel.urgent': 'Dringende Warnungen',

  // Android background-location notification
  'fgs.title': 'Hey-Okay ist aktiv',
  'fgs.body': 'Warnungen für deine Umgebung',
};

export type AppKey = keyof typeof de;

const en: Record<AppKey, string> = {
  'nav.alert': 'Alert',
  'nav.settings': 'Settings',

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
  'onb.consent.busy': 'One moment…',
  'onb.consent.cta': 'Agree and start',
  'onb.error': 'Couldn’t reach the server. Please try again later.',

  'feed.header': 'Last 7 days near you',
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

  'channel.alerts': 'Alerts',
  'channel.urgent': 'Urgent alerts',

  'fgs.title': 'Hey-Okay is on',
  'fgs.body': 'Alerts for where you are',
};

export const APP_STRINGS: Record<Lang, Record<AppKey, string>> = { de, en };

export const CATEGORY: Record<Lang, Record<Category, { label: string; hint: string }>> = {
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
};

export const SEVERITY: Record<Lang, Record<Severity, string>> = {
  de: { 1: 'Info', 2: 'Gering', 3: 'Mittel', 4: 'Hoch', 5: 'Extrem' },
  en: { 1: 'Info', 2: 'Minor', 3: 'Moderate', 4: 'Severe', 5: 'Extreme' },
};

export const LOCALE: Record<Lang, string> = { de: 'de-DE', en: 'en-US' };

