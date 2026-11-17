import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { cleanHeadline, fetchNwsArea, toSourceItem, type NwsFeature } from '../src/sources/nws.js';
import { verify } from '../src/pipeline/compose.js';

// Real api.weather.gov responses from 2026-11-17, trimmed (zone shapes thinned to ~40 points).
const fx = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf8'));
const ALERTS = fx('nws-alerts.json') as { features: NwsFeature[] };
const ZONES = fx('nws-zones.json') as Record<string, { geometry: any }>;
const zoneShapes = () => new Map(Object.entries(ZONES).map(([k, v]) => [k, v.geometry]));
const [WIND, FLOOD, TEST] = ALERTS.features;

const NOW = new Date('2026-11-17T09:00:00-08:00');
const PACIFICA = { lat: 37.61, lon: -122.49 };
// Outside every zone of the fixture alert. (Marina, CA is in CAZ530, which the live alert also covers.)
const SACRAMENTO = { lat: 38.58, lon: -121.49 };
const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };

describe('NWS source', () => {
  it('cleans NWS headlines to "<event> until <time>"', () => {
    expect(cleanHeadline(WIND.properties.headline, WIND.properties.event)).toBe('Wind Advisory until November 18 at 1:00PM PST');
    expect(cleanHeadline('Flood Watch issued November 17 at 3:01AM EST by NWS Miami FL', 'Flood Watch')).toBe('Flood Watch');
    expect(cleanHeadline(null, 'Special Weather Statement')).toBe('Special Weather Statement');
  });

  it('maps a zone-based advisory to an official, English, located item', () => {
    const item = toSourceItem(WIND, zoneShapes())!;
    expect(item.source).toBe('nws');
    expect(item.official).toBe(true);
    expect(item.language).toBe('en');
    expect(item.category).toBe('weather');
    expect(item.officialSeverity).toBe(3); // Moderate
    expect(item.sourceName).toBe('NWS San Francisco CA');
    expect(item.references!.length).toBeGreaterThan(0);
    // San Francisco + coast zones: centre around the Bay Area, radius covers Pacifica.
    expect(item.lat).toBeGreaterThan(37.3);
    expect(item.lat).toBeLessThan(38.3);
    expect(item.lon).toBeLessThan(-122);
    expect(item.body).toContain('WHAT');
    expect(item.expiresAt).toBe(WIND.properties.ends ?? WIND.properties.expires);
  });

  it('uses the alert polygon when there is one', () => {
    const item = toSourceItem(FLOOD, new Map())!;
    expect(item.officialSeverity).toBe(4); // Severe
    expect(item.lat).toBeGreaterThan(25);
    expect(item.lon).toBeLessThan(-93);
  });

  it('drops test messages and alerts it cannot place', () => {
    expect(TEST.properties.status).toBe('Test');
    expect(toSourceItem(TEST, zoneShapes())).toBeNull();
    expect(toSourceItem(WIND, new Map())).toBeNull();
  });

  it('a cancellation ends the event now', () => {
    const cancel = structuredClone(WIND);
    cancel.properties.messageType = 'Cancel';
    const item = toSourceItem(cancel, zoneShapes())!;
    expect(Date.parse(item.expiresAt!)).toBeLessThanOrEqual(Date.now());
  });

  it('fetchNwsArea skips seen and test alerts and fetches each zone shape once', async () => {
    const calls: string[] = [];
    const get = async (url: string) => {
      calls.push(url);
      if (url.includes('/alerts/active')) return ALERTS;
      const z = ZONES[url];
      if (!z) throw new Error('no zone');
      return z;
    };
    const cache = new Map();
    const { feedKey, items, listedIds } = await fetchNwsArea('ca', () => true, get, cache);
    expect(feedKey).toBe('nws:CA');
    expect(items.every((i) => i.feedKey === 'nws:CA')).toBe(true);
    expect([...listedIds]).toEqual([WIND.properties.id, FLOOD.properties.id]); // the test message is not listed
    expect(calls[0]).toBe('https://api.weather.gov/alerts/active?area=CA&status=actual');
    expect(items.map((i) => i.title)).toEqual(['Wind Advisory until November 18 at 1:00PM PST', expect.stringContaining('Flood Warning')]);
    const zoneCalls = calls.filter((c) => c.includes('/zones/')).length;
    expect(zoneCalls).toBe(WIND.properties.affectedZones!.length);

    calls.length = 0;
    expect((await fetchNwsArea('36.684,-121.801', (id) => id !== WIND.properties.id, get, cache)).items).toHaveLength(1);
    expect(calls[0]).toContain('point=36.684,-121.801');
    expect(calls.filter((c) => c.includes('/zones/'))).toHaveLength(0); // cached
  });
});

describe('NWS through the pipeline', () => {
  let store: Store;
  let pipeline: Pipeline;
  beforeEach(() => {
    store = new Store();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg, now: () => NOW });
  });
  const userAt = (p: { lat: number; lon: number }) => {
    const { user } = store.createUser('ExponentPushToken[us]', { timezone: 'America/Los_Angeles', language: 'en' });
    store.updateLocation(user.id, p.lat, p.lon);
    return user;
  };

  it('alerts users inside the zones in English, and nobody outside', async () => {
    const pacifica = userAt(PACIFICA);
    const sacramento = userAt(SACRAMENTO);
    const r = await pipeline.ingest([toSourceItem(WIND, zoneShapes())!]);
    expect(r.eventsCreated).toBe(1);
    expect(r.sentToReview).toBe(0); // official → no Alert Desk

    const [alert] = store.alertsForUser(pacifica.id);
    expect(alert).toBeDefined();
    expect(alert.title).toBe('Weather: Wind Advisory');
    expect(alert.body).toBe('Wind Advisory until November 18 at 1:00PM PST');
    expect(alert.action).toBe('Secure loose objects and limit time outdoors.');
    expect(alert.official).toBe(true);
    expect(store.alertsForUser(sacramento.id)).toHaveLength(0);
  });

  it('an update that references the earlier alert merges into the same event', async () => {
    const first = structuredClone(WIND);
    first.properties.id = 'urn:test:first';
    const update = structuredClone(WIND);
    update.properties.id = 'urn:test:second';
    update.properties.references = [{ identifier: 'urn:test:first' }];
    // Move the update's zones slightly so only the reference can link them.
    update.properties.affectedZones = update.properties.affectedZones!.slice(0, 1);

    await pipeline.ingest([toSourceItem(first, zoneShapes())!]);
    const r = await pipeline.ingest([toSourceItem(update, zoneShapes())!]);
    expect(r.eventsCreated).toBe(0);
    expect(r.eventsUpdated).toBe(1);
  });

  it('the verifier rejects ungrounded English alarm words and area stigma', () => {
    const facts = 'Wind Advisory until November 18 at 1:00PM PST. Gusts up to 45 mph.';
    expect(verify({ title: 'Wind: San Francisco', body: 'Gusts up to 45 mph until 1:00PM' }, facts)).toEqual([]);
    expect(verify({ title: 'Wind: San Francisco', body: 'Evacuate now, gusts 45 mph' }, facts)).toContain('"evacuat…" is not in the source');
    expect(verify({ title: 'Wind in a dangerous neighborhood', body: 'Gusts 45 mph' }, facts)).toContain('describes an area as dangerous');
  });
});

describe('NWS clustering', () => {
  it('keeps two different NWS alerts with similar wording apart', async () => {
    const store = new Store();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg, now: () => NOW });
    const a = structuredClone(WIND);
    const b = structuredClone(WIND);
    b.properties.id = 'urn:test:other-alert';
    b.properties.references = [];
    b.properties.event = 'Beach Hazards Statement';
    b.properties.headline = 'Beach Hazards Statement issued November 17 at 7:45AM PST until November 18 at 1:00PM PST by NWS San Francisco CA';
    const r = await pipeline.ingest([toSourceItem(a, zoneShapes())!, toSourceItem(b, zoneShapes())!]);
    expect(r.eventsCreated).toBe(2);
    expect(r.eventsUpdated).toBe(0);
  });
});
