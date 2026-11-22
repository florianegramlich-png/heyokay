import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  PRESSEPORTAL_AGENCIES, cleanTitle, externalId, feedUrl, fetchAgency, isNeverAnAlert, parseAgencyFeed, parseArticle, selectAgencies,
} from '../src/sources/presseportal.js';
import { loadConfig } from '../src/config.js';
import { SqliteStore } from '../src/db.js';
import type { StructuredLLM } from '../src/llm.js';
import type { Geocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';

const fx = (f: string) => readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf8');
const POLICE_HH = PRESSEPORTAL_AGENCIES.find((a) => a.key === 'polizei-hamburg')!;
const FIRE_HH = PRESSEPORTAL_AGENCIES.find((a) => a.key === 'feuerwehr-hamburg')!;
/** The fixtures span weeks; these tests look at all of them. */
const ALL = { now: new Date('2026-11-18T15:00:00+01:00'), maxAgeH: 24 * 60, maxArticles: 50 };

/** Serves the fixtures by URL; anything else is a 404. Records what was fetched. */
function fakeWeb(pages: Record<string, string>) {
  const fetched: string[] = [];
  const get = async (url: string) => {
    fetched.push(url);
    if (!(url in pages)) throw new Error(`${url} → HTTP 404`);
    return pages[url];
  };
  return { get, fetched };
}

describe('Presseportal Blaulicht: parsing', () => {
  it('cleans the agency code and release number from titles', () => {
    expect(cleanTitle('POL-HH: 261118-3. Zeugenaufruf nach Überfall in Hamburg-Sülldorf')).toBe('Zeugenaufruf nach Überfall in Hamburg-Sülldorf');
    expect(cleanTitle('POL-F: 261118 - 1342 Frankfurt - Nordend Zeugen gesucht')).toBe('Frankfurt - Nordend Zeugen gesucht');
    expect(cleanTitle('FW-HH: Kontrollierte Sprengung in Heimfeld')).toBe('Kontrollierte Sprengung in Heimfeld');
    expect(cleanTitle('FW-M: Brand in Schwabing')).toBe('Brand in Schwabing');
    expect(cleanTitle('POL-K: 261117-2-K Raubserie in Ehrenfeld und Neuehrenfeld - Kripo sucht Zeugen')).toBe('Raubserie in Ehrenfeld und Neuehrenfeld - Kripo sucht Zeugen');
    expect(cleanTitle('POL-K: 261118-3-K/LEV Polizei Köln zieht Bilanz')).toBe('Polizei Köln zieht Bilanz');
    expect(cleanTitle('FW Köln: Kellerbrand in einem Hochhaus')).toBe('Kellerbrand in einem Hochhaus');
    expect(cleanTitle('Bundespolizeidirektion München: Zwei Zwölfjährige surfen auf S-Bahn')).toBe('Zwei Zwölfjährige surfen auf S-Bahn');
    expect(cleanTitle('Ohne Kürzel')).toBe('Ohne Kürzel');
    expect(cleanTitle('Brand: Feuer in Altona')).toBe('Brand: Feuer in Altona'); // an ordinary word before a colon stays
  });

  it('cleans the numbering styles of the other city police (live titles, 2026-11-22)', () => {
    expect(cleanTitle('POL-HB: Nr.: 0734 --Schüsse in Gröpelingen--')).toBe('Schüsse in Gröpelingen');
    expect(cleanTitle('POL-MFR: (973) Pfefferspray in Turnhalle versprüht - Polizei ermittelt')).toBe('Pfefferspray in Turnhalle versprüht - Polizei ermittelt');
    expect(cleanTitle('POL-KA: (KA) Malsch - Brand in Lagerhalle')).toBe('Malsch - Brand in Lagerhalle');
    expect(cleanTitle('POL-KI: 261120.3 Kiel: Einsatzlage anlässlich einer Versammlung')).toBe('Kiel: Einsatzlage anlässlich einer Versammlung');
    expect(cleanTitle('POL-W: W Versammlung mit Aufzug in der Elberfelder Innenstadt')).toBe('Versammlung mit Aufzug in der Elberfelder Innenstadt');
    expect(cleanTitle('POL-W: SG Brand in Solingen-Ohligs')).toBe('Brand in Solingen-Ohligs');
    expect(cleanTitle('POL-MA: Eppelheim: Starke Rauchentwicklung im Hochhaus, PM 1')).toBe('Eppelheim: Starke Rauchentwicklung im Hochhaus, PM 1');
    expect(cleanTitle('POL-DO: Schülerin in Wambel von Auto erfasst')).toBe('Schülerin in Wambel von Auto erfasst');
    expect(cleanTitle('POL-BO: Wohnungsbrand in Herne')).toBe('Wohnungsbrand in Herne');
  });

  it('drops manhunts, found persons, press invitations and statistics before any model call', () => {
    for (const t of [
      'Öffentlichkeitsfahndung: Vermisste 13-Jährige',
      'Rücknahme der Öffentlichkeitsfahndung - 68-Jähriger angetroffen',
      'Nachtragsmeldung: 12-Jähriger aus Hannover-Misburg wohlbehalten zurück',
      'Gesuchter 13-Jähriger stellt sich auf Wache',
      'Führungswechsel im Polizeikommissariat Helmstedt',
      'Aktion "Siehst Du mich?" - Einladung für Medienvertreter',
      'Wohnungseinbruchsradar Oberhausen',
      'Mobile Wache der Polizei Münster öffnet zum Weihnachtsmarkt',
    ]) expect(isNeverAnAlert(t), t).toBe(true);
    for (const t of ['Schüsse in Gröpelingen', 'Schwerer Raub auf Raststätte', 'Polizei fahndet nach Räuber - Zeugen gesucht']) expect(isNeverAnAlert(t), t).toBe(false);
  });

  it('reads a real city police feed (Polizeipräsidium Frankfurt): new releases only, full article text', async () => {
    const pp = PRESSEPORTAL_AGENCIES.find((a) => a.key === 'polizei-frankfurt')!;
    expect(pp).toMatchObject({ id: 4970, categoryHint: 'crime', city: 'Frankfurt' });
    const web = fakeWeb({
      [feedUrl(pp)]: fx('presseportal-polizei-frankfurt.rss2'),
      'https://www.presseportal.de/blaulicht/pm/4970/6395201': fx('presseportal-article-4970_6395201.html'),
    });
    const items = await fetchAgency(pp, () => true, web.get, { now: new Date('2026-11-21T13:00:00Z') });
    // 5 in the feed: 2 from today; yesterday's (incl. a withdrawn missing-person search) are history.
    expect(items.map((i) => i.title)).toEqual(['Frankfurt- Bockenheim: Fahrzeug flüchtet vor Kontrollstelle - Fahrer festgenommen', 'Frankfurt- Bornheim: Trickdiebstahl']);
    expect(items[0]).toMatchObject({ source: 'presseportal', sourceName: 'Polizeipräsidium Frankfurt am Main', category: 'crime', country: 'DE', official: false });
    expect(items[0].body).toContain('Kontrollstelle');
    expect(items[1].body.length).toBeGreaterThan(20); // article not served: the teaser is used
    expect(parseAgencyFeed(fx('presseportal-polizei-frankfurt.rss2')).some((e) => isNeverAnAlert(e.title))).toBe(true);
  });

  it('covers the biggest cities, police first', () => {
    const cities = new Set(PRESSEPORTAL_AGENCIES.filter((a) => a.categoryHint === 'crime').map((a) => a.city));
    for (const c of ['Hamburg', 'Köln', 'Frankfurt', 'Stuttgart', 'Düsseldorf', 'Dortmund', 'Essen', 'Bremen', 'Hannover', 'Nürnberg', 'Duisburg', 'Bochum', 'Wuppertal', 'Bielefeld', 'Bonn', 'Münster', 'Mannheim', 'Karlsruhe', 'Wiesbaden'] as const) {
      expect(cities.has(c), c).toBe(true);
    }
    expect(cities.size).toBeGreaterThanOrEqual(25);
  });

  it('reads a real agency feed (Polizei Hamburg)', () => {
    const entries = parseAgencyFeed(fx('presseportal-polizei-hamburg.rss2'));
    expect(entries).toHaveLength(6);
    expect(entries[1]).toMatchObject({
      title: 'Zeugenaufruf nach Überfall in Hamburg-Sülldorf',
      pmId: '6337/6393268',
      url: 'https://www.presseportal.de/blaulicht/pm/6337/6393268',
      publishedAt: '2026-11-18T13:11:07.000Z',
    });
    expect(entries.every((e) => e.teaser.length > 20 && !e.teaser.includes('<'))).toBe(true);
  });

  it('extracts the full text of an article, without the contact block or channel promotion', () => {
    const body = parseArticle(fx('presseportal-article-82522_6378012.html'))!;
    expect(body).toContain('Kampfmittelfund');
    expect(body).toContain('Seehafenstraße');
    expect(body).toContain('Gegen 11:25 Uhr erfolgte die kontrollierte Sprengung.');
    const police = parseArticle(fx('presseportal-article-6337_6393268.html'))!;
    expect(police).toContain('Sülldorfer Kirchenweg');
    expect(police).not.toMatch(/Rückfragen|WhatsApp|Telefon: \+49|E-Mail/);
    expect(parseArticle('<html><body>no article</body></html>')).toBeNull();
  });
});

describe('Presseportal Blaulicht: polling', () => {
  it('fetches articles only for new releases and skips missing-person searches', async () => {
    const feed = fx('presseportal-polizei-hamburg.rss2');
    const web = fakeWeb({
      [feedUrl(POLICE_HH)]: feed,
      'https://www.presseportal.de/blaulicht/pm/6337/6393268': fx('presseportal-article-6337_6393268.html'),
    });
    const seen = new Set([externalId('6337/6393253')]);
    const items = await fetchAgency(POLICE_HH, (id) => !seen.has(id), web.get, ALL);

    const titles = items.map((i) => i.title);
    expect(titles.some((t) => /vermisst/i.test(t))).toBe(false); // "Vermisstenfahndung …", "Erledigung der Vermisstenfahndung …"
    expect(titles).not.toContain('Polizei vollstreckt Haftbefehl und Durchsuchungsbeschlüsse nach Schüssen auf ein Taxi in Hamburg-St. Pauli'); // already seen
    expect(web.fetched.filter((u) => u.includes('/pm/'))).not.toContain('https://www.presseportal.de/blaulicht/pm/6337/6393253');
    expect(web.fetched.some((u) => /\/pm\/6337\/6393336|\/pm\/6337\/6392935/.test(u))).toBe(false); // skipped releases cost no request

    const sulldorf = items.find((i) => i.externalId === 'presseportal:6337/6393268')!;
    expect(sulldorf).toMatchObject({ source: 'presseportal', sourceName: 'Polizei Hamburg', official: false, category: 'crime', language: 'de' });
    expect(sulldorf.body).toContain('Sülldorfer Kirchenweg'); // full text, not the teaser

    // Article page missing (404 here): the teaser is used instead.
    const winterhude = items.find((i) => i.externalId === 'presseportal:6337/6392480')!;
    expect(winterhude.body.length).toBeGreaterThan(20);
  });

  it('skips station openings and ceremonies from the fire brigade', async () => {
    const web = fakeWeb({ [feedUrl(FIRE_HH)]: fx('presseportal-feuerwehr-hamburg.rss2') });
    const items = await fetchAgency(FIRE_HH, () => true, web.get, ALL);
    expect(items.map((i) => i.title)).toEqual([
      'Eine Person bei Wohnungsbrand in Hamburg-Farmsen-Berne verstorben',
      'Pfefferspray in Schule: Feuerwehr betreut 60 Kinder',
      'Kontrollierte Sprengung in Heimfeld',
    ]);
  });

  it('fetches no articles for releases older than 12 hours, and at most a few per poll', async () => {
    const web = fakeWeb({ [feedUrl(POLICE_HH)]: fx('presseportal-polizei-hamburg.rss2') });
    // 15:00 on the 18th: only the four releases from the 18th are recent (two are missing-person searches).
    const recent = await fetchAgency(POLICE_HH, () => true, web.get, { now: new Date('2026-11-18T15:00:00+01:00') });
    expect(recent.map((i) => i.externalId)).toEqual(['presseportal:6337/6393268', 'presseportal:6337/6393253']);
    expect(web.fetched.filter((u) => u.includes('/pm/'))).toHaveLength(2);

    const capped = fakeWeb({ [feedUrl(POLICE_HH)]: fx('presseportal-polizei-hamburg.rss2') });
    const some = await fetchAgency(POLICE_HH, () => true, capped.get, { ...ALL, maxArticles: 1 });
    expect(some).toHaveLength(1);
    expect(capped.fetched.filter((u) => u.includes('/pm/'))).toHaveLength(1);
  });

  it('selects agencies from config', () => {
    expect(selectAgencies(undefined)).toHaveLength(PRESSEPORTAL_AGENCIES.length);
    expect(selectAgencies('off')).toEqual([]);
    expect(selectAgencies('polizei-hamburg, 115889').map((a) => a.name)).toEqual(['Polizei Hamburg', 'Feuerwehr Köln']);
    expect(() => selectAgencies('polizei-atlantis')).toThrow(/unknown agency polizei-atlantis/);
    expect(loadConfig({ PRESSEPORTAL_AGENCIES: 'feuerwehr-muenchen' }).presseportalAgencies.map((a) => a.key)).toEqual(['feuerwehr-muenchen']);
    // Every agency has a unique key and id, and an area inside Germany.
    expect(new Set(PRESSEPORTAL_AGENCIES.map((a) => a.key)).size).toBe(PRESSEPORTAL_AGENCIES.length);
    expect(new Set(PRESSEPORTAL_AGENCIES.map((a) => a.id)).size).toBe(PRESSEPORTAL_AGENCIES.length);
    expect(PRESSEPORTAL_AGENCIES.every((a) => a.area.lat > 47 && a.area.lat < 55 && a.area.lon > 5 && a.area.lon < 16)).toBe(true);
  });
});

class ScriptedLLM implements StructuredLLM {
  readonly enabled = true;
  constructor(private queue: unknown[]) {}
  async generate<T extends z.ZodType>(_s: string, _u: string, schema: T) {
    const next = this.queue.shift();
    return next === undefined ? null : (schema.parse(next) as z.infer<T>);
  }
}

const HEIMFELD = { name: 'Hamburg-Heimfeld, Seehafenstraße', lat: 53.4669, lon: 9.9654, radiusM: 300 };
const geocoder: Geocoder = { geocode: async (p) => (/seehafenstraße/i.test(p) ? HEIMFELD : null) };

describe('Presseportal Blaulicht: end to end', () => {
  async function setup(llmOut: unknown) {
    const web = fakeWeb({
      [feedUrl(FIRE_HH)]: fx('presseportal-feuerwehr-hamburg.rss2'),
      'https://www.presseportal.de/blaulicht/pm/82522/6378012': fx('presseportal-article-82522_6378012.html'),
    });
    const items = (await fetchAgency(FIRE_HH, () => true, web.get, ALL)).filter((i) => i.externalId === 'presseportal:82522/6378012');
    const store = new SqliteStore(':memory:');
    const push = new MemoryPushSender();
    const now = new Date('2026-10-26T09:00:00Z'); // shortly after the release
    const pipeline = new Pipeline({
      store, llm: new ScriptedLLM([llmOut]), geocoder, push, now: () => now,
      config: { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 },
    });
    const { user } = await store.createUser('ExponentPushToken[hh]');
    await store.updateLocation(user.id, 53.4675, 9.97); // a few hundred metres away
    return { store, push, pipeline, items, user };
  }

  const extraction = {
    isCurrentSafetyEvent: true, category: 'public_safety', severity: 3, confidence: 0.9,
    title: 'Kampfmittelfund in Heimfeld', summary: 'Die Feuerwehr sprengt eine Weltkriegsbombe; die Seehafenstraße ist gesperrt.',
    radiusM: 500, endsAt: null,
  };

  it('a located release becomes an alert for people nearby, credited to the agency', async () => {
    const { store, push, pipeline, items, user } = await setup({ ...extraction, place: 'Seehafenstraße, Hamburg-Heimfeld' });
    const r = await pipeline.ingest(items, FIRE_HH.area);
    expect(r).toMatchObject({ new: 1, eventsCreated: 1, sentToReview: 0, alertsCreated: 1 });
    const [alert] = await store.alertsForUser(user.id);
    expect(alert.sourceName).toBe('Feuerwehr Hamburg');
    expect(alert.sourceUrl).toBe('https://www.presseportal.de/blaulicht/pm/82522/6378012');
    expect(push.outbox).toHaveLength(1);
    await store.close();
  });

  it('a release that can only be placed at "somewhere in the city" waits at the Alert Desk', async () => {
    const { store, push, pipeline, items } = await setup({ ...extraction, place: 'Gelände im Hafen' });
    const r = await pipeline.ingest(items, FIRE_HH.area);
    expect(r).toMatchObject({ eventsCreated: 1, sentToReview: 1, alertsCreated: 0 });
    expect(push.outbox).toHaveLength(0);
    await store.close();
  });
});
