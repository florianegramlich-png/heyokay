import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BERLIN_VERSAMMLUNGEN_URL, assemblyId, berlinTime, fetchAssemblies, marches, routeStops, toSourceItem, type Assembly } from '../src/sources/berlin-versammlungen.js';
import { BERLIN_PLZ } from '../src/data/berlin-plz.js';
import { describeSource } from '../src/sources/registry.js';
import { decide } from '../src/pipeline/rank.js';
import { recommendedAction } from '../src/pipeline/guidance.js';
import { CATEGORIES, DEFAULT_PREFS, normalizePrefs } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import { distanceM } from '../src/geo.js';
import type { Geocoder } from '../src/geocode.js';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';

// The real export from 22 November 2026 (22–24 Nov), with each assembly's topic removed: we never use it.
const EXPORT = readFileSync(join(import.meta.dirname, 'fixtures', 'berlin-versammlungen.json'), 'utf8');
const LIST: Assembly[] = JSON.parse(EXPORT).index;
const NOW = new Date('2026-11-22T09:00:00Z'); // Sunday 10:00 in Berlin
const SAVIGNYPLATZ = { lat: 52.5056, lon: 13.3196 };
/** A stand-in for Nominatim: knows a few squares, otherwise nothing. */
const geocoder = (): Geocoder & { asked: string[] } => {
  const asked: string[] = [];
  const known: Record<string, [number, number]> = {
    'Savignyplatz, Kantstr., Berlin': [SAVIGNYPLATZ.lat, SAVIGNYPLATZ.lon],
    'John-F.-Kennedy-Platz, Berlin': [52.4848, 13.3443],
    'Alt-Tegel 2, Berlin': [52.5885, 13.2848],
    'Dorotheenstr./ Ebertstr., Berlin': [52.5175, 13.3770],
  };
  return {
    asked,
    async geocode(q) {
      asked.push(q);
      if (q.startsWith('Wilmersdorfer')) return { lat: 52.52, lon: 13.405, radiusM: 20_000, name: 'Berlin' }; // too vague
      const k = known[q];
      return k ? { lat: k[0], lon: k[1], radiusM: 150, name: q } : null;
    },
  };
};

describe('Berlin assemblies (Polizei Berlin)', () => {
  it('Berlin time, with summer and winter time', () => {
    expect(berlinTime('23.11.2026', '17:30')).toBe('2026-11-23T16:30:00.000Z');
    expect(berlinTime('01.07.2026', '17:30')).toBe('2026-07-01T15:30:00.000Z');
    expect(berlinTime('23.11.2026', '23:59')).toBe('2026-11-23T22:59:00.000Z');
    expect(berlinTime('2026-11-23', '17:30')).toBeNull();
  });

  it('routes become a short list of places, without the police notes or company names in brackets', () => {
    expect(routeStops('Savignyplatz, Kantstr. Nordseite (AK) - Kantstr. Richtung Westen - Kehre Kaiser-Friedrich-Str. - Kantstr.')).toEqual(['Savignyplatz, Kantstr.', 'Kantstr.', 'Kaiser-Friedrich-Str.']);
    expect(routeStops('NEU:    Oberlandstr. 75 - 84 (von Procter and Gamble Manufactoring GmbH (Gillette) - Komturstr.')).toEqual(['Oberlandstr. 75', 'Komturstr.']);
    expect(routeStops('An der Heide, Kehrwieder, Am Rosensteg, Am Brunnen    - > alle 2 Stunden im Wechsel')).toEqual(['An der Heide, Kehrwieder, Am Rosensteg, Am Brunnen']);
    expect(routeStops('Stephanplatz (AK) - Stendaler Str. - Stephanplatz (EK)')).toEqual(['Stephanplatz', 'Stendaler Str.']);
  });

  it('only marches with a route, today and tomorrow; a stable id even when the export renumbers its rows', () => {
    expect(LIST.length).toBe(59);
    const m = marches(LIST, ['2026-11-22', '2026-11-23']);
    expect(m).toHaveLength(9);
    expect(m.every((a) => a.aufzugsstrecke.trim())).toBe(true);
    expect(marches(LIST, ['2026-11-26'])).toEqual([]);
    expect(assemblyId({ ...m[0], id: 999 } as Assembly)).toBe(assemblyId(m[0]));
    expect(assemblyId({ ...m[0], von: '11:00' })).not.toBe(assemblyId(m[0]));
  });

  it('a calm, neutral feed item: when and where, never the topic', async () => {
    const savigny = LIST.find((a) => a.aufzugsstrecke.startsWith('Savignyplatz'))!;
    const item = (await toSourceItem(savigny, geocoder(), NOW))!;
    expect(item).toMatchObject({
      source: 'berlin-versammlungen', sourceName: 'Polizei Berlin · Versammlungen', official: true, structured: true,
      category: 'events', hazard: 'assembly', language: 'de', country: 'DE', officialSeverity: 1,
      title: 'Demo ab Savignyplatz, Kantstr., 17:30–19:00', areaName: 'Savignyplatz, Kantstr.',
      publishedAt: NOW.toISOString(), onsetAt: '2026-11-23T16:30:00.000Z', expiresAt: '2026-11-23T18:00:00.000Z',
      lat: SAVIGNYPLATZ.lat, lon: SAVIGNYPLATZ.lon, radiusM: 1000,
    });
    expect(item.title.length).toBeLessThanOrEqual(50);
    expect(item.body).toBe('Angemeldeter Aufzug am Mo., 23.11., 17:30–19:00 Uhr: Savignyplatz, Kantstr. – Kantstr. – Kaiser-Friedrich-Str. – Joachimsthaler Str. – Kantstr. bis Savignyplatz … Straßen können zeitweise gesperrt sein.');
    expect(JSON.stringify(item)).not.toContain('Thema');
    // With a postcode, no lookup is needed: the postcode area places it.
    const heide = LIST.find((a) => a.plz === '13509' && a.aufzugsstrecke)!;
    const g = geocoder();
    const h = (await toSourceItem(heide, g, NOW))!;
    expect(g.asked).toEqual([]);
    expect([h.lat, h.lon]).toEqual([BERLIN_PLZ['13509'][0], BERLIN_PLZ['13509'][1]]);
    // No postcode and the lookup is vague (all of Berlin) or fails: left out rather than guessed.
    expect(await toSourceItem(LIST.find((a) => a.aufzugsstrecke.startsWith('Wilmersdorfer'))!, geocoder(), NOW)).toBeNull();
    expect(await toSourceItem(LIST.find((a) => a.aufzugsstrecke.startsWith('Savignyplatz'))!, undefined, NOW)).toBeNull();
  });

  it('fetches the export once; known and finished marches are skipped before any lookup; a changed export fails', async () => {
    const urls: string[] = [];
    const g = geocoder();
    const savignyId = assemblyId(LIST.find((a) => a.aufzugsstrecke.startsWith('Savignyplatz'))!);
    const items = await fetchAssemblies((id) => id !== savignyId, async (u) => { urls.push(u); return EXPORT; }, { now: NOW, geocoder: g });
    expect(urls).toEqual([BERLIN_VERSAMMLUNGEN_URL]);
    expect(g.asked).not.toContain('Savignyplatz, Kantstr., Berlin');
    expect(items.map((i) => i.title)).toEqual([
      'Demo ab An der Heide 1, 10:00–18:00', 'Demo ab Dorotheenstr./ Ebertstr., 08:00–10:00', 'Demo ab Oberlandstr. 75, 09:30–10:15',
      'Demo ab Culemeyerstr. 1, 09:30–11:45', 'Demo ab Alt-Müggelheim 17, 18:00–19:00', 'Demo ab John-F.-Kennedy-Platz, 18:00–20:00', 'Demo ab Alt-Tegel 2, 18:00–20:30',
    ]);
    // Sunday evening: today's march (until 18:00) is over.
    const late = await fetchAssemblies(() => true, async () => EXPORT, { now: new Date('2026-11-22T18:00:00Z'), geocoder: geocoder() });
    expect(late.map((i) => i.title)).not.toContain('Demo ab An der Heide 1, 10:00–18:00');
    await expect(fetchAssemblies(() => true, async () => '<html>Wartung</html>', { now: NOW })).rejects.toThrow(/not JSON/);
    await expect(fetchAssemblies(() => true, async () => '{"messages":{}}', { now: NOW })).rejects.toThrow(/unexpected format/);
  });

  it('topic "events": on by default (also for people who saved settings before), feed only, own advice', () => {
    expect(CATEGORIES).toContain('events');
    expect(DEFAULT_PREFS.categories).toContain('events');
    expect(normalizePrefs({ categories: ['weather'], knownCategories: ['weather', 'crime', 'transit', 'public_safety', 'health', 'infrastructure', 'technology', 'recall', 'pollen_uv'] }).categories).toEqual(['weather', 'events']);
    const base = { id: 'u', tokenHash: '', pushToken: 'x', lat: null, lon: null, locationUpdatedAt: null, createdAt: '' };
    const user = { ...base, prefs: normalizePrefs({ quietHours: null }) };
    expect(decide(user, { category: 'events', severity: 3, official: true } as any, { now: NOW, pushesLast24h: 0, feedback: {} })).toEqual({ delivery: 'feed', reason: 'events: feed only' });
    expect(recommendedAction('events', 1, 'de', 'assembly')).toMatch(/^Umwege einplanen/);
    expect(recommendedAction('events', 1, 'en', 'assembly')).toMatch(/^Plan a detour/);
    expect(describeSource('berlin-versammlungen:DE')).toMatchObject({ name: 'Polizei Berlin · Versammlungen', country: 'DE' });
    expect(loadConfig({}).berlinVersammlungen).toBe(BERLIN_VERSAMMLUNGEN_URL);
    expect(loadConfig({ BERLIN_VERSAMMLUNGEN_URL: 'off' }).berlinVersammlungen).toBeNull();
  });

  it('postcodes: all 190-odd Berlin postcodes, each centre in Berlin', () => {
    expect(Object.keys(BERLIN_PLZ).length).toBeGreaterThan(185);
    for (const [plz, [lat, lon, r]] of Object.entries(BERLIN_PLZ)) {
      expect(distanceM(lat, lon, 52.52, 13.405), plz).toBeLessThan(30_000);
      expect(r, plz).toBeGreaterThanOrEqual(0); // a few are slivers of postcodes mostly outside Berlin (155xx); the 1 km minimum applies
    }
  });
});

describe.each(storeBackends())('Berlin assemblies end to end ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); });
  afterEach(async () => { await store.close(); });

  it('the Savignyplatz march: "coming up" in the feed for someone nearby, nothing in Köpenick, no push', async () => {
    const push = new MemoryPushSender();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: loadConfig({}), now: () => NOW });
    const near = (await store.createUser('ExponentPushToken[near]', { language: 'de' } as any)).user;
    await store.updateLocation(near.id, 52.5065, 13.3240); // Kantstraße, ~300 m away
    const far = (await store.createUser('ExponentPushToken[far]', { language: 'de' } as any)).user;
    await store.updateLocation(far.id, 52.4454, 13.5747);
    const items = (await fetchAssemblies(() => true, async () => EXPORT, { now: NOW, geocoder: geocoder() })).filter((i) => i.areaName?.startsWith('Savignyplatz'));
    expect(items).toHaveLength(1);
    expect(await pipeline.ingest(items)).toMatchObject({ eventsCreated: 1, sentToReview: 0, alertsCreated: 1 });
    const [alert] = await store.alertsForUser(near.id);
    expect(alert).toMatchObject({ category: 'events', delivery: 'feed', title: 'Demo ab Savignyplatz, Kantstr., 17:30–19:00' });
    expect(alert.action).toMatch(/^Umwege einplanen/);
    expect(await store.alertsForUser(far.id)).toEqual([]);
    expect(push.outbox).toEqual([]);
  });
});
